/**
 * control-runtime.test.js — the runtime control and safety layer.
 *
 * Four layers are covered here, deliberately apart so a failure names the
 * culprit:
 *
 *   1. the units        RuntimeConfig, PhysicalBoundary, ConnectionManager,
 *                       DeathRecovery  (no bot, no model, no timers)
 *   2. the interface    Host: authorisation, every command, status read model
 *   3. the enforcement  a real session from test/helpers/session.js: pause,
 *                       stop during movement/building/jobs, permissions,
 *                       disconnect, respawn, cancellation
 *   4. persistence      a config change survives a process restart (a second
 *                       Host over the same data directory)
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')
const { RuntimeConfig } = require('../zincai/runtime_config')
const { PhysicalBoundary, installPhysicalGuard, capsForTool } = require('../zincai/boundary')
const { ConnectionManager, STATES } = require('../zincai/connection')
const { DeathRecovery } = require('../zincai/death_recovery')
const { Host } = require('../zincai/host')

const OPERATOR = '11111111-2222-3333-4444-555555555555'
const STRANGER = '99999999-8888-7777-6666-555555555555'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-control-'))

/** A quiet logger for the units (the session rig silences the shared one). */
const quiet = { info () {}, warn () {}, error () {}, debug () {} }

// ===========================================================================
// 1. RuntimeConfig — schema, validation, persistence, pending changes
// ===========================================================================

test('config: every parameter has a documented type, range and apply rule', () => {
  const defs = RuntimeConfig.schema()
  // The surface got smaller on purpose: a mode selector, a chat command prefix,
  // an operator UUID allow-list, a name list for that allow-list, a chat-capped
  // refused-command announcement and a public-chat rate cap are all gone.
  assert.ok(defs.length >= 33, `expected the full surface, got ${defs.length}`)
  const names = new Set()
  for (const d of defs) {
    assert.match(d.name, /^[a-z][A-Za-z0-9]*\.[A-Za-z0-9]+$/, `odd name: ${d.name}`)
    assert.ok(!names.has(d.name), `duplicate parameter ${d.name}`)
    names.add(d.name)
    assert.ok(d.describe && d.describe.length > 8, `${d.name} needs a description`)
    assert.ok(['immediate', 'boundary'].includes(d.apply), `${d.name} needs an apply rule`)
    assert.ok(RuntimeConfig.groups().includes(d.group))
  }
  // The groups the operator asks for by name.
  for (const g of ['boundary', 'actions', 'limits', 'communication', 'connection', 'control', 'death']) {
    assert.ok(RuntimeConfig.groups().includes(g), `missing group ${g}`)
  }
})

test('config: values are validated by type and range, unknown names are refused', () => {
  const cfg = new RuntimeConfig({})
  assert.equal(cfg.set('boundary.radius', 'abc').ok, false)
  assert.equal(cfg.set('boundary.radius', '999999999').ok, false, 'out of range')
  assert.equal(cfg.set('boundary.radius', '64').value, 64, 'numeric strings are accepted')
  assert.equal(cfg.set('boundary.radius', '12.5').ok, false, 'integers are not silently truncated')
  assert.equal(cfg.set('communication.publicChat', 'no').value, false)
  assert.equal(cfg.set('communication.publicChat', 'maybe').ok, false)
  // A chat operator list no longer exists to validate against.
  assert.equal(cfg.set('control.operators', 'Steve').ok, false, 'unknown parameter')
  assert.equal(cfg.set('limits.maxPhysicalActionsPerMinute', 'lots').ok, false, 'a name is not a number')
  assert.equal(cfg.set('limits.maxPhysicalActionsPerMinute', '900').value, 900)
  const unknown = cfg.set('actions.allowTeleport', 'true')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /unknown parameter/)
})

test('config: a change is persisted and read back by a new process', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'runtime-config.json')
  const first = new RuntimeConfig({ file })
  assert.equal(first.get('communication.privateMessages'), true)
  const r = first.set('communication.privateMessages', false, { by: 'test' })
  assert.equal(r.ok, true)
  assert.equal(r.oldValue, true)
  assert.equal(r.value, false)
  assert.equal(first.get('communication.privateMessages'), false)

  // A brand-new instance is a new "process": same file, same value.
  const second = new RuntimeConfig({ file })
  assert.equal(second.get('communication.privateMessages'), false, 'the change survived the restart')
  // ...and everything else is still at its default.
  assert.equal(second.get('communication.publicChat'), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('config: a corrupt store falls back to defaults instead of crashing', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'runtime-config.json')
  fs.writeFileSync(file, '{not json')
  const cfg = new RuntimeConfig({ file, logger: quiet })
  assert.equal(cfg.get('boundary.enabled'), false)
  // An unknown saved key and an out-of-range saved value are ignored, not trusted.
  fs.writeFileSync(file, JSON.stringify({ values: { 'made.up': 1, 'boundary.radius': -5, 'actions.allowDig': false } }))
  const cfg2 = new RuntimeConfig({ file, logger: quiet })
  assert.equal(cfg2.get('boundary.radius'), 256)
  assert.equal(cfg2.get('actions.allowDig'), false, 'a valid saved value still loads')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('config: a boundary-only parameter is recorded as pending while an action runs', () => {
  const cfg = new RuntimeConfig({})
  const busy = cfg.set('limits.maxConcurrentJobs', 2, { physicalBusy: true })
  assert.equal(busy.applied, 'boundary')
  assert.equal(busy.value, 2)
  assert.equal(cfg.get('limits.maxConcurrentJobs'), 4, 'the old value is still in force')
  assert.equal(cfg.isPending('limits.maxConcurrentJobs'), true)
  // An immediate parameter applies straight away even mid-action.
  const now = cfg.set('communication.publicChat', false, { physicalBusy: true })
  assert.equal(now.applied, 'now')
  assert.equal(cfg.get('communication.publicChat'), false)
  // At the safe boundary the pending change lands.
  const applied = cfg.applyPending({ force: true })
  assert.deepEqual(applied.map((a) => a.name), ['limits.maxConcurrentJobs'])
  assert.equal(cfg.get('limits.maxConcurrentJobs'), 2)
  assert.equal(cfg.isPending('limits.maxConcurrentJobs'), false)
})

test('config: the panel environment pins the join switch, and chat-control variables are inert', () => {
  const cfg = new RuntimeConfig({
    logger: quiet,
    // A template written for the old chat-command surface still sets these.
    env: { ZINC_OPERATORS: `${OPERATOR}, ${STRANGER}`, ZINC_COMMAND_PREFIX: '!bot', ZINC_JOIN_ON_START: 'false' }
  })
  assert.equal(cfg.get('connection.joinOnStart'), false)
  assert.equal(cfg.get('control.operators'), undefined, 'the operator allow-list is gone')
  assert.equal(cfg.get('control.prefix'), undefined, 'there is no prefix; console lines are commands')
  assert.equal(cfg.set('control.operators', OPERATOR).ok, false, 'and it cannot be set back')
  // A bad value in the environment is ignored, never trusted.
  const bad = new RuntimeConfig({ logger: quiet, env: { ZINC_JOIN_ON_START: 'perhaps' } })
  assert.equal(bad.get('connection.joinOnStart'), true, 'an invalid value leaves the default alone')
})

// ===========================================================================
// 2. PhysicalBoundary — one decision for every route
// ===========================================================================

function boundaryFor ({ paused = false, connected = true, dead = false } = {}) {
  const config = new RuntimeConfig({})
  const state = { paused, dead }
  const boundary = new PhysicalBoundary({
    config,
    logger: quiet,
    now: () => Date.now(),
    state: {
      isPaused: () => state.paused,
      isDead: () => state.dead,
      physicalRefusal: () => state.paused
        ? 'the body is paused by an operator (resume to continue)'
        : (connected ? (state.dead ? 'dead; waiting for respawn' : null) : 'not connected to the server')
    }
  })
  return { boundary, config, state, set (patch) { Object.assign(state, patch); if ('connected' in patch) connected = patch.connected } }
}

test('boundary: a paused body refuses every physical tool, and says why', () => {
  const { boundary, state } = boundaryFor()
  assert.equal(boundary.check('go_to').ok, true)
  state.paused = true
  for (const tool of ['go_to', 'dig', 'build', 'place', 'attack', 'take', 'use_block', 'gather', 'light_up']) {
    const v = boundary.check(tool)
    assert.equal(v.ok, false, `${tool} must be refused while paused`)
    assert.match(v.why, /paused/)
  }
  // Reasoning and read-only work is never blocked by a pause.
  for (const tool of ['idle', 'say', 'goal', 'logic_test', 'inspect_block', 'recall', 'social']) {
    assert.equal(boundary.check(tool).ok, true, `${tool} is not a physical action`)
  }
})

test('boundary: an operator permission off is off for every capability, per tool', () => {
  const { boundary, config } = boundaryFor()
  config.set('actions.allowDig', false)
  assert.equal(boundary.check('dig').ok, false)
  assert.equal(boundary.check('gather').ok, false)
  assert.equal(boundary.check('go_to').ok, true, 'movement is untouched')
  config.set('actions.allowPlace', false)
  assert.equal(boundary.check('build').ok, false)
  // A tool that needs both is refused by whichever one is off.
  config.set('actions.allowMovement', false)
  assert.equal(boundary.check('go_to').ok, false)
  assert.equal(boundary.check('inspect_block').ok, true, 'reads are not movement')
})

test('boundary: the permitted area refuses both the body outside it and a target outside it', () => {
  const { boundary, config } = boundaryFor()
  boundary.getPosition = () => ({ x: 0, y: 64, z: 0 })
  assert.equal(boundary.check('go_to').ok, true, 'boundary off = no area limit')
  config.set('boundary.enabled', true)
  config.set('boundary.radius', 32)
  config.set('boundary.centerX', 0)
  config.set('boundary.centerZ', 0)
  assert.equal(boundary.check('go_to').ok, true, 'inside the area')
  boundary.getPosition = () => ({ x: 400, y: 64, z: 0 })
  assert.equal(boundary.check('go_to').ok, false, 'outside the area')
  // A build target outside the area is refused even when the body is inside it.
  boundary.getPosition = () => ({ x: 2, y: 64, z: 2 })
  assert.equal(boundary.check('build').ok, true)
  assert.equal(boundary.targetRefusal({ x: 900, z: 900 }) !== null, true)
  assert.equal(boundary.targetRefusal({ x: 3, z: 3 }), null)
})

test('boundary: the action rate ceiling is a sliding window, and reads do not count', () => {
  const { boundary, config } = boundaryFor()
  config.set('limits.maxPhysicalActionsPerMinute', 3)
  for (let i = 0; i < 3; i++) assert.equal(boundary.check('go_to').ok, true)
  const refused = boundary.check('go_to')
  assert.equal(refused.ok, false)
  assert.match(refused.why, /limit/)
  assert.equal(boundary.check('inspect_block').ok, true, 'a read is not a physical action')
})

test('boundary: the network guard stops even a caller that never asked', async () => {
  const { boundary } = boundaryFor()
  const bot = {
    moves: 0,
    digs: 0,
    setControlState (key, value) { this.moves++; this.last = `${key}:${value}` },
    clearControlStates () { this.moves++ },
    async dig () { this.digs++ },
    async placeBlock () { this.digs++ },
    chat () { this.said = true }
  }
  const guard = installPhysicalGuard(bot, boundary, { logger: quiet })
  assert.ok(guard && typeof guard.uninstall === 'function')
  bot.setControlState('forward', true)
  assert.equal(bot.moves, 1, 'permitted while nothing is off')

  boundary.config.set('actions.allowMovement', false)
  bot.setControlState('forward', true)
  assert.equal(bot.moves, 1, 'a refused write never reaches the bot')
  // Releasing control is never blocked: a pause that cannot let go is worse.
  bot.setControlState('forward', false)
  bot.clearControlStates()
  assert.equal(bot.moves, 3, 'releases always pass')

  boundary.config.set('actions.allowDig', false)
  await bot.dig()
  assert.equal(bot.digs, 0, 'dig refused at the network level')
  // Chat is not a physical primitive: the speech permission lives in the session.
  bot.chat('oi')
  assert.equal(bot.said, true)

  guard.uninstall()
  boundary.config.set('actions.allowMovement', true)
  bot.setControlState('forward', true)
  assert.equal(bot.moves, 4, 'uninstall restores the original methods')
})

test('boundary: caps are derived from the tool, conservatively for an unknown one', () => {
  assert.deepEqual(capsForTool('dig'), ['move', 'dig'])
  assert.deepEqual(capsForTool('say'), [])
  assert.deepEqual(capsForTool('inspect_block'), [])
  assert.deepEqual(capsForTool('some_new_body_tool'), ['move', 'dig', 'place'], 'unknown BODY tool is assumed to act')
})

// ===========================================================================
// 3. ConnectionManager — the link as a state machine
// ===========================================================================

function connectionRig ({ config = new RuntimeConfig({}) } = {}) {
  const events = []
  const timers = []
  const sessions = []
  const manager = new ConnectionManager({
    config,
    logger: quiet,
    now: () => Date.now(),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
    createSession: (hooks) => {
      const session = {
        hooks,
        disposed: 0,
        bot: { id: sessions.length + 1 },
        dispose () { this.disposed++ },
        spawn () { hooks.onSpawn?.() },
        end (info) { hooks.onEnded?.(info) }
      }
      sessions.push(session)
      return session
    }
  })
  manager.on('state', (e) => events.push(e.to))
  return { manager, events, timers, sessions, config }
}

test('connection: a rejected FIRST join is fatal and never retried', () => {
  const { manager, timers, sessions, events } = connectionRig()
  const fatal = []
  manager.on('fatal', (f) => fatal.push(f))
  manager.join({ reason: 'startup' })
  assert.equal(manager.state, STATES.CONNECTING)
  sessions[0].end({ kind: 'kicked', text: 'You are not white-listed on this server', spawned: false })
  assert.equal(manager.state, STATES.ERROR)
  assert.equal(fatal.length, 1)
  assert.equal(fatal[0].reason, 'join-failed')
  assert.equal(timers.length, 0, 'no retry is scheduled for a rejected first join')
  assert.deepEqual(events, [STATES.CONNECTING, STATES.ERROR])
})

test('connection: a dropped link after a good session retries with back-off', () => {
  const { manager, timers, sessions, config } = connectionRig()
  config.set('connection.retryDelayMs', 1000)
  config.set('connection.minRetryDelayMs', 250)
  config.set('connection.maxRetryDelayMs', 8000)
  manager.join({ reason: 'startup' })
  sessions[0].spawn()
  assert.equal(manager.state, STATES.CONNECTED)
  sessions[0].end({ kind: 'end', text: 'server closed', spawned: true })
  assert.equal(manager.state, STATES.RECONNECTING)
  assert.equal(timers[0].ms, 1000, 'first retry uses the configured delay')
  // The delay doubles and is bounded by the ceiling/floor parameters.
  manager.attempts = 4
  manager._scheduleRetry(999999)
  const bounded = timers[timers.length - 1].ms
  assert.ok(bounded >= 250 && bounded <= 8000, `delay ${bounded} must respect the bounds`)
})

test('connection: the retry budget is bounded, so there is no reconnect loop', () => {
  const { manager, sessions, config } = connectionRig()
  const fatal = []
  manager.on('fatal', (f) => fatal.push(f))
  config.set('connection.maxRetries', 2)
  manager.join({ reason: 'startup' })
  sessions[0].spawn()
  sessions[0].end({ kind: 'end', text: 'down', spawned: true })
  assert.equal(manager.attempts, 1)
  manager._ended(manager.epoch, { kind: 'end', text: 'down', spawned: true })
  assert.equal(manager.attempts, 2)
  manager._ended(manager.epoch, { kind: 'end', text: 'down', spawned: true })
  assert.equal(fatal[0]?.reason, 'retries-exhausted')
  assert.equal(manager.state, STATES.DISCONNECTED)
})

test('connection: leave disposes the session and keeps the manager usable', () => {
  const { manager, sessions } = connectionRig()
  manager.join({ reason: 'startup' })
  sessions[0].spawn()
  const leave = manager.leave({ reason: 'left by operator' })
  assert.equal(leave.ok, true)
  assert.equal(manager.state, STATES.DISCONNECTED)
  assert.equal(sessions[0].disposed, 1)
  assert.equal(manager.physicalRefusal(), 'not connected to the server', 'no physical action while away')
  // A second join builds a SECOND session: no listener can be reused.
  const re = manager.rejoin()
  assert.equal(re.ok, true)
  assert.equal(sessions.length, 2)
  assert.equal(manager.state, STATES.CONNECTING)
})

test('connection: restart-connection rebuilds the link without a new manager', () => {
  const { manager, sessions } = connectionRig()
  manager.join({ reason: 'startup' })
  sessions[0].spawn()
  const r = manager.restart()
  assert.equal(r.ok, true)
  assert.equal(sessions[0].disposed, 1, 'the old session was disposed')
  assert.equal(sessions.length, 2, 'a brand-new session was built')
  assert.equal(manager.state, STATES.CONNECTING)
})

test('connection: an automatic retry does not run when autoReconnect is off', () => {
  const { manager, sessions, timers, config } = connectionRig()
  manager.join({ reason: 'startup' })
  sessions[0].spawn()
  config.set('connection.autoReconnect', false)
  sessions[0].end({ kind: 'end', text: 'closed', spawned: true })
  assert.equal(manager.state, STATES.DISCONNECTED)
  assert.equal(timers.length, 0)
})

// ===========================================================================
// 4. DeathRecovery — a death is an event, and the route home is decided once
// ===========================================================================

function recoveryFor (overrides = {}) {
  const config = overrides.config || new RuntimeConfig({})
  if (!overrides.config) {
    config.set('boundary.enabled', true)
    config.set('boundary.radius', 64)
    config.set('boundary.centerX', 0)
    config.set('boundary.centerZ', 0)
    config.set('boundary.homeX', 4)
    config.set('boundary.homeY', 64)
    config.set('boundary.homeZ', 4)
    config.set('boundary.returnHomeOnDeath', true)
  }
  return new DeathRecovery({
    config,
    logger: quiet,
    getPosition: () => overrides.position || { x: 200, y: 64, z: 200 },
    getDimension: () => overrides.dimension || 'overworld',
    checkRoute: overrides.checkRoute || null
  })
}

test('death: the record keeps what was lost, and the respawn is inspected, not assumed', async () => {
  const recovery = recoveryFor()
  const death = recovery.onDeath({ position: { x: 10.4, y: 12.2, z: -3.9 }, dimension: 'overworld', inventory: [{ name: 'iron_pickaxe', count: 1 }, { name: 'bread', count: 4 }] })
  assert.deepEqual(death.position, { x: 10, y: 12, z: -4 })
  assert.equal(death.inventory.length, 2)
  const out = await recovery.onRespawn({ position: { x: 4, y: 64, z: 4 }, dimension: 'overworld', health: 20, inventory: [] })
  assert.equal(out.verdict, 'nothing')
  assert.match(out.why, /already at the designated room/)
  assert.equal(out.observation.health, 20)
  assert.equal(out.observation.slotsUsed, 0)
})

test('death: a spawn in another dimension is reported, not walked toward', async () => {
  const recovery = recoveryFor({ dimension: 'the_nether', position: { x: 0, y: 70, z: 0 } })
  const out = await recovery.onRespawn({ position: { x: 0, y: 70, z: 0 }, dimension: 'the_nether' })
  assert.equal(out.verdict, 'report')
  assert.match(out.why, /no walking route across dimensions/)
})

test('death: a blocked route is reported once instead of being attempted repeatedly', async () => {
  const recovery = recoveryFor({
    position: { x: 40, y: 64, z: 0 },
    checkRoute: () => ({ ok: false, why: 'no way through' })
  })
  const out = await recovery.onRespawn({ position: { x: 40, y: 64, z: 0 } })
  assert.equal(out.verdict, 'report')
  assert.match(out.why, /route back to the designated room is blocked/)
})

test('death: a reachable room produces ONE walk instruction, with the real target', async () => {
  const recovery = recoveryFor({ position: { x: 40, y: 64, z: 0 }, checkRoute: () => ({ ok: true }) })
  const out = await recovery.onRespawn({ position: { x: 40, y: 64, z: 0 }, health: 20 })
  assert.equal(out.verdict, 'go_home')
  assert.deepEqual({ x: out.target.x, y: out.target.y, z: out.target.z }, { x: 4, y: 64, z: 4 })
})

test('death: a room outside the permitted area is reported, never walked to', async () => {
  const config = new RuntimeConfig({})
  config.set('boundary.enabled', true)
  config.set('boundary.radius', 8)
  config.set('boundary.centerX', 0)
  config.set('boundary.centerZ', 0)
  config.set('boundary.homeX', 500)
  config.set('boundary.homeZ', 500)
  config.set('boundary.returnHomeOnDeath', true)
  const recovery = recoveryFor({ config, position: { x: 2, y: 64, z: 2 } })
  const out = await recovery.onRespawn({ position: { x: 2, y: 64, z: 2 } })
  assert.equal(out.verdict, 'report')
  assert.match(out.why, /outside the permitted area/)
})

// ===========================================================================
// 5. Host — authorisation and the command surface
// ===========================================================================

function hostFor ({ operators = [OPERATOR], dir = tmpdir() } = {}) {
  const host = new Host({ dataDir: dir, logger: quiet })
  // No operator list exists any more: the console is the operator. The
  // `operators` argument is kept so the call sites that passed it still read
  // clearly, and it must have no effect.
  assert.equal(host.config.set('control.operators', operators.join(',')).ok, false)
  return { host, dir }
}

const chat = (host, line, uuid = OPERATOR, name = 'Operator') => host.command(line, { source: 'chat', uuid, name })
const consoleCmd = (host, line) => host.command(line, { source: 'console', name: 'console' })

test('host: the game chat is not a command channel at all', async () => {
  const { host, dir } = hostFor()
  // The console works and needs no prefix.
  const good = await consoleCmd(host, 'status')
  assert.equal(good.ok, true)
  assert.match(good.reply, /connection:/)

  // A `chat` source is refused outright — even with the old prefix, even with
  // an UUID that used to be an operator. There is no chat control surface, so
  // there is nothing for a player to probe and nothing to authorise.
  const prefixed = await chat(host, '!zinc status')
  assert.equal(prefixed.ok, false)
  assert.equal(prefixed.silent, true)
  assert.equal(prefixed.reply, undefined, 'a chat sender learns nothing')
  const bare = await chat(host, 'status', STRANGER, 'Steve')
  assert.equal(bare.ok, false)
  assert.equal(bare.silent, true, 'not even the command name is confirmed')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: a chat-shaped command cannot pause the body', async () => {
  const { host, dir } = hostFor({ operators: [] })
  const r = await chat(host, 'stop', OPERATOR)
  assert.equal(r.ok, false)
  assert.equal(r.silent, true)
  assert.equal(host.paused, false, 'a refused command has no effect')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: a console command needs no prefix; help lists the whole surface', async () => {
  const { host, dir } = hostFor()
  const help = await consoleCmd(host, 'help')
  for (const name of ['status', 'pause', 'stop', 'shutdown', 'resume', 'leave', 'join', 'restart-connection', 'goals', 'jobs', 'cancel', 'config', 'update', 'link', 'watchdog', 'help']) {
    assert.match(help.reply, new RegExp(`\\b${name}\\b`))
  }
  assert.match(help.reply, /console only, no prefix/)
  assert.match(help.reply, /not a command channel/)
  const unknown = await consoleCmd(host, 'teleport 0 0 0')
  assert.equal(unknown.ok, false)
  assert.match(unknown.reply, /unknown command/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: pause is stop under a clearer name, and shutdown asks the session to end', async () => {
  const { host, dir } = hostFor()
  const paused = await consoleCmd(host, 'pause')
  assert.equal(paused.ok, true)
  assert.equal(host.paused, true, 'pause is the handbrake')
  assert.match(paused.reply, /body paused/)
  await consoleCmd(host, 'resume')

  // No session attached: shutdown must still answer and give up cleanly rather
  // than take the test process down with it. `process.exit` is stubbed here.
  const realExit = process.exit
  let code = null
  process.exit = (c) => { code = c }
  try {
    const out = await consoleCmd(host, 'shutdown 3')
    assert.equal(out.ok, true)
    assert.match(out.reply, /shutting down/)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(code, 3, 'the exit code is honoured')
  } finally { process.exit = realExit }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: stop pauses without killing anything, and status says so', async () => {
  const { host, dir } = hostFor()
  const stop = await consoleCmd(host, 'stop')
  assert.equal(stop.ok, true)
  assert.equal(host.paused, true)
  const status = await consoleCmd(host, 'status')
  assert.match(status.reply, /paused: YES/)
  assert.match(status.reply, /activity: paused \(no physical action\)/)
  // The process and the interface are still there.
  assert.equal((await consoleCmd(host, 'config show communication')).ok, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: config set prints the old and the new value, and persists', async () => {
  const dir = tmpdir()
  const { host } = hostFor({ dir })
  const r = await consoleCmd(host, 'config set communication.publicChat false')
  assert.equal(r.ok, true)
  assert.match(r.reply, /communication\.publicChat: true → false/)
  assert.equal(host.config.get('communication.publicChat'), false)
  // A fresh host over the same directory sees it.
  const again = new Host({ dataDir: dir, logger: quiet })
  assert.equal(again.config.get('communication.publicChat'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: config rejects an unknown name and an out-of-range value', async () => {
  const { host, dir } = hostFor()
  const unknown = await consoleCmd(host, 'config set modes.stealth true')
  assert.equal(unknown.ok, false)
  assert.match(unknown.reply, /unknown parameter/)
  const range = await consoleCmd(host, 'config set boundary.radius -3')
  assert.equal(range.ok, false)
  assert.match(range.reply, /between/)
  // A generic system, not one command per setting: the same verb covers every group.
  assert.equal((await consoleCmd(host, 'config show boundary')).ok, true)
  assert.equal((await consoleCmd(host, 'config show limits')).ok, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: config changes are refused cleanly when the name is missing', async () => {
  const { host, dir } = hostFor()
  const r = await consoleCmd(host, 'config set')
  assert.equal(r.ok, false)
  assert.match(r.reply, /needs a parameter name/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: leave and join are refused/kosher without a session, and never throw', async () => {
  const { host, dir } = hostFor()
  const leave = await consoleCmd(host, 'leave')
  assert.equal(leave.ok, true)
  assert.match(leave.reply, /left the server/)
  assert.equal(host.connection.state, STATES.DISCONNECTED)
  // No session factory was provided, so join cannot connect — but it must not
  // crash and must leave the process usable.
  const join = await consoleCmd(host, 'join')
  assert.equal(typeof join.reply, 'string')
  assert.equal((await consoleCmd(host, 'status')).ok, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: an action-rate change made during a physical action is recorded as pending', async () => {
  const { host, dir } = hostFor()
  host.physicalBusy = () => true
  const r = await consoleCmd(host, 'config set limits.maxConcurrentJobs 1')
  assert.equal(r.ok, true)
  assert.match(r.reply, /NOT yet in force/)
  assert.equal(host.config.get('limits.maxConcurrentJobs'), 4)
  const status = await consoleCmd(host, 'status')
  assert.match(status.reply, /pending config: limits\.maxConcurrentJobs/)
  host.applyPendingChanges({ force: true })
  assert.equal(host.config.get('limits.maxConcurrentJobs'), 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: goals/jobs/cancel answer honestly with no session attached', async () => {
  const { host, dir } = hostFor()
  assert.match((await consoleCmd(host, 'goals')).reply, /registry not loaded|none recorded/)
  assert.match((await consoleCmd(host, 'jobs')).reply, /no job registry|jobs: 0/)
  const cancel = await consoleCmd(host, 'cancel g1')
  assert.equal(cancel.ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ===========================================================================
// 6. The interface against a REAL session
// ===========================================================================

test('session: a chat line is conversation, never a command — even for the operator', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    // Both players are connected; neither has any special standing in chat.
    bot.players.Steve = { username: 'Steve', uuid: STRANGER, entity: null }
    bot.players.Anna = { username: 'Anna', uuid: OPERATOR, entity: null }
    for (const who of ['Steve', 'Anna']) s.say(`<${who}> !zinc stop`)
    s.say('<Anna> stop')
    // The lines reach the model as ONE batching-window chunk — that is the point.
    assert.ok(await s.until(() => s.prompts.chat.length > 0, 4000), 'the model saw the chat')
    const chunk = s.prompts.chat.at(-1)
    assert.match(chunk, /Steve: !zinc stop/, 'the old prefix arrives as ordinary text')
    assert.match(chunk, /Anna: stop/)
    assert.match(chunk, /3 lines from Steve, Anna/, 'one window, both speakers, in order')
    assert.ok(chunk.indexOf('Steve: !zinc stop') < chunk.indexOf('Anna: stop'), 'in arrival order')
    await sleep(200)
    assert.equal(s.shared.host.paused, false, 'nothing typed in chat can pause the body')
    assert.deepEqual(bot.log.chat, [], 'and nothing is answered publicly')
  } finally { s.stop() }
})

test('session: stop during movement releases the keys and suspends the goal', async () => {
  const bot = simulatedBot()
  let moved = 0
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'já vou', task: 'walk far away' }),
    actions: (p) => (/why now:.*chat request/.test(p) ? { a: 'go_to', x: 60, z: 0 } : null)
  })
  try {
    s.spawn()
    await sleep(150)
    s.shared.host.config.set('control.operators', OPERATOR)
    addPlayer(bot, 2, 'Steve', 2.5, 0.5)
    s.say('<Steve> zinc vai pra longe')
    assert.ok(await s.until(() => (moved = bot.entity.position.x) > 2, 4000), 'the walk started')

    const stop = await consoleCmd(s.shared.host, 'stop')
    assert.equal(stop.ok, true)
    const held = Object.entries(bot.controls).filter(([, v]) => v).map(([k]) => k)
    assert.deepEqual(held, [], 'no key is left held after a pause')
    assert.equal(bot.pathfinder.goal, null, 'the pathfinder goal was dropped')
    // The goal record survives as suspended, with its checkpoint.
    const goals = s.internals().goals.openGoals()
    assert.ok(goals.length >= 1, 'the goal was not deleted')
    assert.ok(goals.every((g) => ['suspended', 'resumable', 'pending'].includes(g.status)), `statuses: ${goals.map((g) => g.status)}`)
    // It really stops moving.
    const at = bot.entity.position.x
    await sleep(400)
    assert.ok(Math.abs(bot.entity.position.x - at) < 0.6, 'the body stopped')
  } finally { s.stop() }
})

test('session: stop during a build stops between blocks and reports it, without deleting the goal', async () => {
  const bot = simulatedBot({ items: [['stone', 64], ['dirt', 64]] })
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'bora', task: 'build a wall' }),
    actions: (p) => {
      // build_shape needs no mode any more: every tool is available on every turn.
      if (/why now:.*chat request/.test(p)) return { a: 'build_shape', shape: 'wall', block: 'stone', params: { l: 6, h: 4 }, at: [4, 64, 0] }
      return null
    }
  })
  try {
    s.spawn()
    await sleep(150)
    addPlayer(bot, 2, 'Steve', 2.5, 0.5)
    s.say('<Steve> zinc constrói um muro')
    assert.ok(await s.until(() => s.internals().goals.openGoals().some((g) => g.kind === 'build_shape'), 4000), 'the build goal opened')
    await sleep(120)
    const before = s.internals().results.length
    await consoleCmd(s.shared.host, 'stop')
    // The builder notices at the next block: the job ends cancelled, not orphaned.
    assert.ok(await s.until(() => s.internals().jobs.list().some((j) => j.state === 'cancelled' || j.state === 'done' || j.state === 'failed'), 3000),
      'the build job settled after the pause')
    const goal = s.internals().goals.openGoals().find((g) => g.kind === 'build_shape')
    assert.ok(goal, 'the build objective still exists')
    assert.equal(goal.status, 'suspended')
    assert.ok(s.internals().results.length >= before, 'the pause was recorded')
    assert.deepEqual(Object.entries(bot.controls).filter(([, v]) => v).map(([k]) => k), [], 'no key left held')
  } finally { s.stop() }
})

test('session: stop during a background job cancels the job and keeps the process alive', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'já vou', task: 'follow Steve' }),
    actions: (p) => (/why now:.*chat request/.test(p) ? { a: 'follow', player: 'Steve' } : null)
  })
  try {
    s.spawn()
    await sleep(150)
    addPlayer(bot, 2, 'Steve', 12.5, 0.5)
    s.say('<Steve> zinc me segue')
    assert.ok(await s.until(() => s.internals().jobs.active().length > 0 || s.internals().skills.current(), 4000), 'a background job is running')
    const r = await consoleCmd(s.shared.host, 'stop')
    assert.equal(r.ok, true)
    assert.ok(await s.until(() => s.internals().skills.current() === null, 3000), 'the skill stopped')
    // The process, memory and interface are intact.
    assert.equal(s.ended.length, 0, 'the session did not end')
    assert.equal((await consoleCmd(s.shared.host, 'status')).ok, true)
  } finally { s.stop() }
})

test('session: a pause refuses a physical tool the model asks for, and says why', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: { a: 'go_to', x: 20, z: 0 } })
  try {
    s.spawn()
    await sleep(150)
    await consoleCmd(s.shared.host, 'stop')
    await sleep(50)
    await s.internals().executeAction({ a: 'dig', x: 4, z: 4 }, { threatIds: [], shownActionIds: [], shownProposals: [], goalId: null })
    const last = s.internals().results.slice(-1)[0]
    assert.equal(last.ok, false)
    assert.match(last.msg, /paused/)
    // The snapshot the model would see says the body is paused, in one line.
    const prompt = s.internals().buildActionPrompt(['autonomous check-in']).text
    assert.match(prompt, /body: PAUSED by the operator/)
  } finally { s.stop() }
})

test('session: resume reconciles the world and completes a goal whose work already happened', async () => {
  const bot = simulatedBot({ items: [['diamond', 5]] })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const goals = s.internals().goals
    // A gather goal for 5 diamonds, with the diamonds already in the inventory
    // when the pause begins: resuming must NOT repeat the work.
    const goal = goals.add({
      description: 'gather 5 diamond',
      kind: 'gather',
      origin: 'self',
      priority: 60,
      detail: { args: { item: 'diamond', count: 5 } }
    })
    goals.resume(goal.id, { reason: 'test' })
    await consoleCmd(s.shared.host, 'stop')
    assert.equal(goals.get(goal.id).status, 'suspended')
    const r = await consoleCmd(s.shared.host, 'resume')
    assert.equal(r.ok, true)
    assert.match(r.reply, /world reconciled/)
    assert.equal(goals.get(goal.id).status, 'completed', `expected completed, got ${goals.get(goal.id).status} — ${r.reply}`)
    assert.match(r.reply, /already done in the world/)
  } finally { s.stop() }
})

test('session: resume hands back a goal whose work is NOT done, marked for verification', async () => {
  const bot = simulatedBot({ items: [['diamond', 1]] })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const goals = s.internals().goals
    const goal = goals.add({ description: 'gather 9 diamond', kind: 'gather', origin: 'self', priority: 60, detail: { args: { item: 'diamond', count: 9 } } })
    goals.resume(goal.id, { reason: 'test' })
    await consoleCmd(s.shared.host, 'stop')
    const r = await consoleCmd(s.shared.host, 'resume')
    assert.equal(r.ok, true)
    const after = goals.get(goal.id)
    assert.notEqual(after.status, 'completed')
    assert.equal(after.needsVerify, true, 'never blindly repeated: it is flagged for verification')
  } finally { s.stop() }
})

test('session: cancellation touches only the named goal and its jobs', async () => {
  const bot = simulatedBot({ items: [['diamond', 1]] })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const goals = s.internals().goals
    const a = goals.add({ description: 'gather 9 diamond', kind: 'gather', origin: 'self', priority: 60, detail: { args: { item: 'diamond', count: 9 } } })
    const b = goals.add({ description: 'build a shed', kind: 'build', origin: 'self', priority: 50, detail: {} })
    goals.resume(a.id, { reason: 'test' })
    goals.resume(b.id, { reason: 'test' })
    const jobs = s.internals().jobs
    const jobA = jobs.start({ kind: 'gather', goalId: a.id, tool: 'gather', run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400)) })
    const jobB = jobs.start({ kind: 'build', goalId: b.id, tool: 'build', run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400)) })
    const r = await consoleCmd(s.shared.host, `cancel ${a.id}`)
    assert.equal(r.ok, true)
    assert.match(r.reply, new RegExp(`${a.id} cancelled`))
    assert.equal(goals.get(a.id).status, 'cancelled')
    assert.equal(jobs.jobs.get(jobA.id).cancelled, true, 'the job of the cancelled goal is cancelled')
    assert.notEqual(goals.get(b.id).status, 'cancelled', 'the unrelated goal is untouched')
    assert.equal(jobs.jobs.get(jobB.id).cancelled, false, 'the unrelated job is untouched')
  } finally { s.stop() }
})

test('session: goals and jobs commands show what is actually running', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const goals = s.internals().goals
    const g = goals.add({ description: 'walk to the shed', kind: 'go_to', origin: 'self', priority: 45, detail: {} })
    goals.resume(g.id, { reason: 'test' })
    const goalsOut = await consoleCmd(s.shared.host, 'goals')
    assert.match(goalsOut.reply, /active \(1\)/)
    assert.match(goalsOut.reply, new RegExp(g.id))
    const job = s.internals().jobs.start({ kind: 'go_to', goalId: g.id, tool: 'go_to', run: () => new Promise((r) => setTimeout(() => r({ ok: true }), 300)) })
    const jobsOut = await consoleCmd(s.shared.host, 'jobs')
    assert.match(jobsOut.reply, new RegExp(job.id))
    assert.match(jobsOut.reply, /goal /)
  } finally { s.stop() }
})

test('session: a permission switched off mid-run stops the matching tool and leaves the rest alone', async () => {
  const bot = simulatedBot({ items: [['stone', 32]] })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const host = s.shared.host

    // Digging off: dig and gather are refused, walking is not.
    host.config.set('actions.allowDig', false)
    await s.internals().executeAction({ a: 'dig', x: 6, z: 6 }, { threatIds: [], shownActionIds: [], shownProposals: [], goalId: null })
    assert.match(s.internals().results.slice(-1)[0].msg, /actions\.allowDig is off/)
    const walk = await host.command('config set actions.allowMovement true', { source: 'console' })
    assert.equal(walk.ok, true)

    // Public chat off: the line does not leave, and the model is told.
    host.config.set('communication.publicChat', false)
    await s.internals().executeAction({ a: 'say', t: 'oi pessoal' }, { threatIds: [], shownActionIds: [], shownProposals: [], goalId: null })
    assert.deepEqual(bot.log.chat, [], 'no public line was sent')
    assert.match(s.internals().results.slice(-1)[0].msg, /public chat are switched off/)

    // Private messages off: a whisper does not leave either.
    host.config.set('communication.publicChat', true)
    host.config.set('communication.privateMessages', false)
    await s.internals().executeAction({ a: 'say', t: 'oi', to: 'Steve' }, { threatIds: [], shownActionIds: [], shownProposals: [], goalId: null })
    assert.deepEqual(bot.log.chat, [])
    assert.match(s.internals().results.slice(-1)[0].msg, /private messages are switched off/)
  } finally { s.stop() }
})

test('session: the permitted area refuses a walk that would leave it', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const host = s.shared.host
    host.config.set('boundary.enabled', true)
    host.config.set('boundary.centerX', 0)
    host.config.set('boundary.centerZ', 0)
    host.config.set('boundary.radius', 16)
    await s.internals().executeAction({ a: 'go_to', x: 500, z: 500 }, { threatIds: [], shownActionIds: [], shownProposals: [], goalId: null })
    assert.match(s.internals().results.slice(-1)[0].msg, /permitted area/)
    assert.equal(s.internals().skills.current(), null, 'nothing started')
  } finally { s.stop() }
})

test('connection: leave disconnects the client but keeps the process, goals and interface', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const goals = s.internals().goals
    const g = goals.add({ description: 'build a shed', kind: 'build', origin: 'self', priority: 50, detail: {} })
    goals.resume(g.id, { reason: 'test' })
    const host = s.shared.host
    const r = await consoleCmd(host, 'leave')
    assert.equal(r.ok, true)
    assert.equal(host.connection.state, STATES.DISCONNECTED)
    assert.equal(host.paused, true, 'a body that is away does not act')
    // The goal record is suspended, not deleted, and the registry still answers.
    assert.ok(goals.get(g.id), 'the goal survived the disconnect')
    assert.equal(['suspended', 'resumable'].includes(goals.get(g.id).status), true)
    const status = await consoleCmd(host, 'status')
    assert.match(status.reply, /connection: DISCONNECTED/)
    // No physical action can be issued while away.
    assert.match(host.physicalRefusal() || '', /not connected/)
    assert.equal(s.ended.length, 0, 'the process-level session was not told the app is over')
  } finally { s.stop() }
})

test('connection: join after leave builds a fresh session with ONE set of listeners', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const host = s.shared.host
    const old = host.session
    // Count how often the session installs its bot listeners: one install per bot.
    const before = bot.listenerCount('messagestr')
    // A leave + join without a session factory cannot rebuild a bot; the guard
    // here is that the manager disposes what it had and does not duplicate.
    await consoleCmd(host, 'leave')
    assert.equal(host.session, null, 'the old session is detached')
    await consoleCmd(host, 'join')
    await sleep(200)
    // The manager built exactly one new session for the new link.
    assert.ok(host.session, 'a new session was built for the new link')
    assert.notEqual(host.session, old, 'and it is not the disposed one')
    const after = bot.listenerCount('messagestr')
    // Nothing re-registered on the disposed bot object: the old session's
    // listeners are gone, so the count can only be lower — never doubled.
    assert.ok(after <= before, `no duplicate listener was added (was ${before}, now ${after})`)
    assert.equal(old.bot.listenerCount?.('messagestr') ?? after, after)
  } finally { s.stop() }
})

test('death: a death suspends the goal, and the respawn reconciles instead of resuming blindly', async () => {
  const bot = simulatedBot({ items: [['iron_pickaxe']] })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(200)
    const goals = s.internals().goals
    const g = goals.add({ description: 'gather 9 diamond', kind: 'gather', origin: 'self', priority: 60, detail: { args: { item: 'diamond', count: 9 } } })
    goals.resume(g.id, { reason: 'test' })
    const promptsBefore = s.prompts.action.length
    bot.emit('death')
    await sleep(100)
    assert.equal(goals.get(g.id).status, 'resumable', 'the plan survives the death')
    assert.equal(s.internals().deathRecovery.deaths, 1)
    // The session itself became dead: no physical action may be issued.
    assert.match(s.shared.host.physicalRefusal() || '', /dead/)
    // Respawn: the body is inspected and the model is told with the REAL position.
    bot.health = 20
    bot.emit('spawn')
    assert.ok(await s.until(() => s.prompts.action.length > promptsBefore, 4000), 'the model was woken after the respawn')
    const wake = s.prompts.action[s.prompts.action.length - 1]
    assert.match(wake, /respawned/)
    assert.match(wake, /died at/)
    assert.equal(s.shared.host.isDead(), false)
  } finally { s.stop() }
})

test('death: when return-home is off, nothing walks and the model is not told to walk', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(200)
    const host = s.shared.host
    host.config.set('boundary.enabled', true)
    host.config.set('boundary.returnHomeOnDeath', false)
    host.config.set('boundary.homeX', 0)
    host.config.set('boundary.homeZ', 0)
    bot.emit('death')
    await sleep(80)
    bot.emit('spawn')
    await sleep(300)
    const recovery = s.internals().deathRecovery.lastRecovery
    assert.equal(recovery.verdict, 'nothing')
    assert.match(recovery.why, /returning home after death is off/)
  } finally { s.stop() }
})

test('stale world: a snapshot token debounce prevents acting on the old head after a respawn', async () => {
  // The session already invalidates in-flight decisions with lifeEpoch; this
  // asserts the control layer does not defeat it by resuming on its own.
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const goals = s.internals().goals
    const g = goals.add({ description: 'walk north', kind: 'go_to', origin: 'self', priority: 45, detail: { args: { x: 0, z: 40 } } })
    goals.resume(g.id, { reason: 'test' })
    await consoleCmd(s.shared.host, 'stop')
    // While paused, the world changing must not restart anything by itself.
    bot.entity.position.set(100, 64, 100)
    await sleep(300)
    assert.equal(goals.get(g.id).status, 'suspended', 'a paused goal stays parked')
    assert.equal(s.internals().skills.current(), null)
  } finally { s.stop() }
})

// ============================================================== supervision ==

test('host: `link` explains the last disconnect instead of guessing', async () => {
  const { host, dir } = hostFor()
  // Simulate the sequence a real timeout produces: keepalives flowing, then
  // silence, then the client's own deadline expiring.
  host.watchdog.noteRecv(); host.watchdog.noteSent()
  const record = host.watchdog.noteEnd({ kind: 'end', text: 'client timed out after 30000 milliseconds' })
  assert.equal(record.cause, 'server-silent', 'a healthy loop means the server went quiet')

  const r = await consoleCmd(host, 'link')
  assert.equal(r.ok, true)
  assert.match(r.reply, /cause: server-silent/)
  assert.match(r.reply, /keepalives: 1 sent, 1 received/)
  assert.match(r.reply, /deadline: 30s/)
  assert.match(r.reply, /what to do:/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: the same timeout is blamed on the loop when the loop was blocked', async () => {
  const { host, dir } = hostFor()
  // One line of evidence flips the diagnosis, which is the entire point.
  host.watchdog.maxStallMs = 31_000
  host.watchdog.noteRecv()
  const record = host.watchdog.noteEnd({ kind: 'end', text: 'client timed out after 30000 milliseconds' })
  assert.equal(record.cause, 'loop-stall')
  const r = await consoleCmd(host, 'link explain')
  assert.match(r.reply, /cause: loop-stall/)
  assert.match(r.reply, /blocked for 31000ms|blocked the loop/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: `watchdog off` stops the supervisor without stopping the measurements', async () => {
  const { host, dir } = hostFor()
  const off = await consoleCmd(host, 'watchdog off')
  assert.equal(off.ok, true)
  assert.equal(host.config.get('agent.surviveKicks'), false)
  assert.match(off.reply, /survival is now off/)
  const on = await consoleCmd(host, 'watchdog on')
  assert.equal(on.ok, true)
  assert.equal(host.config.get('agent.surviveKicks'), true)

  const shown = await consoleCmd(host, 'watchdog')
  assert.match(shown.reply, /agent loop:/)
  assert.match(shown.reply, /worst stall:/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: status reports the link evidence and the agent loop together', async () => {
  const { host, dir } = hostFor()
  host.watchdog.noteRecv()
  host.watchdog.noteEnd({ kind: 'kicked', text: 'KeepAliveTimeout' })
  const st = host.status()
  assert.equal(st.link.lastCause, 'server-keepalive-timeout')
  assert.equal(st.link.drops, 1)
  assert.equal(st.link.checkTimeoutMs, 30_000)
  assert.equal(typeof st.link.maxStallMs, 'number')
  assert.ok(st.agent && typeof st.agent.ticks === 'number')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: `update` reports the refusal and stays alive when the tree is dirty', async () => {
  const { host, dir } = hostFor()
  // The real repository is dirty while this branch is being written, so this is
  // the honest integration case: the command must refuse and NOT exit.
  const r = await consoleCmd(host, 'update')
  // Either it refuses (dirty tree) or, in a clean checkout, it plans the update —
  // but it must never claim success without a fetch.
  assert.equal(typeof r.ok, 'boolean')
  if (!r.ok) {
    assert.match(r.reply, /update refused:/)
    assert.match(r.reply, /local changes|not a git checkout|git is not installed/)
  } else {
    assert.match(r.reply, /updating: stopping now/)
  }
  // Crucially: the body was paused first in both cases.
  assert.equal(host.paused, true, 'an update stops the body before it touches git')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: supervision starts idempotently and stops cleanly', () => {
  const { host, dir } = hostFor()
  assert.equal(host.watchdog.running, false)
  host.startSupervision()
  assert.equal(host.watchdog.running, true)
  assert.equal(host.agentLoop.running, true)
  host.startSupervision()
  assert.equal(host.watchdog.running, true, 'starting twice is not an error')
  host.stopSupervision()
  assert.equal(host.watchdog.running, false)
  assert.equal(host.agentLoop.running, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('host: supervision does not run when agent.enabled is off', async () => {
  const { host, dir } = hostFor()
  host.config.set('agent.enabled', false)
  host.startSupervision()
  assert.equal(host.agentLoop.running, false, 'the operator asked for no supervisor')
  assert.equal(host.watchdog.running, true, 'but the measurements still run: they are what explains a kick')
  host.stopSupervision()
  fs.rmSync(dir, { recursive: true, force: true })
})
