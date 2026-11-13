/**
 * Whole-harness test rig: the real zincai/index.js session with only two
 * things replaced — mineflayer.createBot (a simulated bot in a synthetic
 * world) and global fetch (a scripted model). Everything in between is the
 * shipped code: scheduler, chat lane, action lane, executor, skills, reflexes,
 * arbiter, combat.
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const world = require('./world')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Real A* from an ARBITRARY start over the synthetic world — backs the
 * threat-reachability probe and the escape planner, which call
 * bot.pathfinder.getPathFromTo(start, goal) and previously got nothing in
 * session rig (the stub lacked it, so reachability always read "unknown").
 */
const AStarSim = require('mineflayer-pathfinder/lib/astar')
const MoveSim = require('mineflayer-pathfinder/lib/move')

/** A bot whose pathfinder stub actually walks it toward the goal. */
function simulatedBot ({ items = [], held = null, solid = world.flat, blocks = {}, containers = {} } = {}) {
  // `blocks`: { 'x,y,z': 'chest' } — placed in the world and found by findBlocks.
  const placed = new Map(Object.entries(blocks))
  const base = world.makeWorld((x, y, z) => placed.get(`${x},${y},${z}`) || solid(x, y, z))
  const bot = Object.assign(new EventEmitter(), base)
  bot.setMaxListeners(100)
  const controls = {}
  const log = { chat: [], goals: [], attack: [], equip: [], consume: 0, activate: 0 }
  bot.log = log
  bot.controls = controls
  bot.username = 'ZincAI'
  bot.health = 20
  bot.food = 20
  bot.time = { timeOfDay: 1000, isDay: true }
  bot.game = { minY: -64, height: 384, dimension: 'overworld' }
  bot.players = { ZincAI: { entity: bot.entity } }
  bot.heldItem = held ? { name: held } : null
  const inv = items.map(([name, count = 1]) => ({ name, count, type: world.registry.itemsByName[name]?.id ?? 1 }))
  bot.inventory = { items: () => inv, slots: [], on: () => {}, count: (type) => inv.filter((i) => i.type === type).reduce((n, i) => n + i.count, 0) }
  bot.setQuickBarSlot = (slot) => { log.equip.push(`slot${slot}`) }
  bot.loadPlugin = () => {}
  bot.chat = (t) => { log.chat.push(t) }
  bot.setControlState = (k, v) => { controls[k] = Boolean(v) }
  bot.clearControlStates = () => { for (const k of Object.keys(controls)) controls[k] = false }
  bot.lookAt = async (point) => {
    const p = bot.entity.position
    if (point && (point.x !== p.x || point.z !== p.z)) bot.entity.yaw = Math.atan2(-(point.x - p.x), -(point.z - p.z))
  }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.equip = async (item, dest) => { log.equip.push(`${item?.name}@${dest || 'hand'}`); if (!dest || dest === 'hand') bot.heldItem = item }
  bot.consume = async () => { log.consume++ }
  bot.attack = (e) => { log.attack.push(e?.id); bot.emit('test_attack', e) }
  bot.activateItem = () => { log.activate++ }
  bot.deactivateItem = () => {}
  bot.respawn = () => {}
  bot.quit = () => {}
  bot.end = () => {}
  bot.findBlock = ({ matching, maxDistance = 16 }) => {
    const ps = bot.findBlocks({ matching, maxDistance, count: 1 })
    return ps.length ? bot.blockAt(ps[0]) : null // mineflayer: Block or null
  }
  bot.findBlocks = ({ matching, maxDistance = 16, count = 64 }) => {
    const ids = new Set(Array.isArray(matching) ? matching : [matching])
    const out = []
    for (const key of placed.keys()) {
      const [x, y, z] = key.split(',').map(Number)
      const v = new Vec3(x, y, z)
      if (v.distanceTo(bot.entity.position) > maxDistance) continue
      if (ids.has(bot.blockAt(v).type)) out.push(v)
    }
    return out.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, count)
  }
  // `containers`: { 'x,y,z': { diamond: 12 } } — what a chest holds.
  bot.openContainer = async (block) => {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    const store = containers[key]
    if (!store) throw new Error('not a container')
    log.opened = (log.opened || 0) + 1
    const typeOf = (name) => world.registry.itemsByName[name]?.id ?? 1
    const nameOf = (type) => world.registry.items[type]?.name
    return {
      inventoryStart: 27,
      containerItems: () => Object.entries(store).filter(([, c]) => c > 0).map(([name, c]) => ({ name, count: c, type: typeOf(name) })),
      async withdraw (type, _meta, n) {
        const name = nameOf(type)
        if (!store[name] || store[name] < n) throw new Error('not enough items')
        store[name] -= n
        const mine = inv.find((i) => i.name === name)
        if (mine) mine.count += n
        else inv.push({ name, count: n, type })
      },
      async deposit (type, _meta, n) {
        const name = nameOf(type)
        const mine = inv.find((i) => i.name === name)
        if (!mine || mine.count < n) throw new Error('not enough items')
        mine.count -= n
        if (mine.count === 0) inv.splice(inv.indexOf(mine), 1)
        store[name] = (store[name] || 0) + n
      },
      close () { log.closed = (log.closed || 0) + 1 }
    }
  }
  let goal = null
  let pending = null // the goto() in flight: { goal, resolve, reject }
  bot.pathfinder = {
    get goal () { return goal },
    movements: null,
    setMovements (m) { this.movements = m },
    setGoal (g) {
      // Like upstream: replacing the goal rejects a goto() that was waiting on the old one.
      if (pending && pending.goal !== g) {
        const p = pending
        pending = null
        const err = new Error('The goal was changed before it could be completed!')
        err.name = 'GoalChanged'
        p.reject(err)
      }
      goal = g; log.goals.push(g ? g.constructor.name : 'null'); bot.clearControlStates()
    },
    goto (g) {
      return new Promise((resolve, reject) => {
        this.setGoal(g)
        pending = { goal: g, resolve, reject }
      })
    },
    isMoving: () => goal !== null,
    // Mirrors upstream: a sync-iterated generator of progress events,
    // final one carrying { result: { status, path } }.
    getPathFromTo (movements, startPos, g, opts = {}) {
      return (function* () {
        const timeout = opts.timeout ?? 5000
        const tickTimeout = opts.tickTimeout ?? 40
        const p = startPos.floored()
        const start = new MoveSim(p.x, p.y, p.z, movements.countScaffoldingItems(), 0)
        movements.clearCollisionIndex()
        movements.updateCollisionIndex()
        const ctx = new AStarSim(start, movements, g, timeout, tickTimeout, -1)
        let result = ctx.compute()
        while (result.status === 'partial') result = ctx.compute()
        yield { result: { status: result.status, path: result.path, cost: result.cost } }
      })()
    }
  }
  // 20 Hz: walk toward the goal (0.28 b/t ≈ sprint) or along held keys.
  const tick = setInterval(() => {
    const p = bot.entity.position
    let target = null
    if (goal) {
      if (goal.entity?.position) target = goal.entity.position
      else if (Number.isFinite(goal.x) && Number.isFinite(goal.z)) target = { x: goal.x + 0.5, z: goal.z + 0.5 }
    }
    if (target && !goal.isEnd(p.floored())) {
      const dx = target.x - p.x; const dz = target.z - p.z; const len = Math.hypot(dx, dz) || 1
      p.x += dx / len * Math.min(0.28, len); p.z += dz / len * Math.min(0.28, len)
    } else if (pending && pending.goal === goal && goal.isEnd(p.floored())) {
      // goto() arrived: upstream drops the goal and resolves.
      const done = pending
      pending = null
      goal = null
      done.resolve()
    } else if (controls.forward) {
      const yaw = bot.entity.yaw || 0
      p.x += -Math.sin(yaw) * 0.28; p.z += -Math.cos(yaw) * 0.28
    }
    bot.emit('physicsTick')
  }, 50)
  bot.stopSim = () => clearInterval(tick)
  return bot
}

/** Add another player the bot can see. */
function addPlayer (bot, id, username, x, z, held = null) {
  const e = { id, name: 'player', type: 'player', username, position: new Vec3(x, 64, z), velocity: new Vec3(0, 0, 0), height: 1.8, onGround: true, equipment: [held ? { name: held } : null], metadata: [] }
  Object.defineProperty(e, 'heldItem', { get () { return this.equipment[0] } })
  bot.entities[id] = e
  bot.players[username] = { entity: e, username }
  return e
}

/**
 * Start a real session against a simulated bot and a scripted model.
 * @param {{ chat?: Function|Array, actions?: Function|Array, bot?: object, cfg?: (cfg:object)=>void }} script
 *   actions: a policy `(prompt) => ({ a:'go_to', player:'x' })` — it reads the
 *   prompt like a model would (falsy = idle; `{ prose:'…' }` = text without a
 *   tool call). chat: `(prompt) => ({ text, task })`. Arrays are also accepted
 *   and consumed in order.
 */
function startTestSession ({ chat = [], actions = [], bot = simulatedBot(), cfg: tweak = null, dataDir: sharedDir = null } = {}) {
  // A test that simulates a restart passes the same dataDir in for both
  // sessions (and keeps it); otherwise each session gets its own temp dir.
  const ownDir = !sharedDir
  const dataDir = sharedDir || fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-session-'))
  process.env.API_KEY = process.env.API_KEY || 'rc-test-key'

  // 1. mineflayer.createBot → our simulated bot.
  const mfPath = require.resolve('mineflayer')
  const realMineflayer = require.cache[mfPath]
  require.cache[mfPath] = { id: mfPath, filename: mfPath, loaded: true, exports: { createBot: () => bot } }

  // 2. fetch → scripted model.
  const prompts = { chat: [], action: [] }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const user = body.messages[body.messages.length - 1].content
    const isChat = body.tools?.[0]?.function?.name === 'reply'
    let message
    if (isChat) {
      prompts.chat.push(user)
      const next = typeof chat === 'function' ? chat : (chat.length ? chat.shift() : { text: '' })
      const args = (typeof next === 'function' ? next(user) : next) || { text: '' }
      message = { content: null, tool_calls: [{ function: { name: 'reply', arguments: JSON.stringify(args) } }] }
    } else {
      prompts.action.push(user)
      const next = typeof actions === 'function' ? actions : (actions.length ? actions.shift() : { a: 'idle' })
      const act = (typeof next === 'function' ? next(user) : next) || { a: 'idle' }
      if (act.prose) message = { content: act.prose }
      else {
        const { a, ...args } = act
        message = { content: null, tool_calls: [{ function: { name: a, arguments: JSON.stringify(args) } }] }
      }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }), text: async () => '' }
  }

  const index = require('../../zincai/index.js')
  const cfg = index.loadConfig()
  // Test pace: no 3 s spacing, no heartbeat, no reconnect.
  cfg.inference = { ...cfg.inference, minIntervalMs: 40, chatMinIntervalMs: 20, rpm: 1000, heartbeatMs: 0 }
  cfg.behavior = { ...cfg.behavior, chatCooldownMs: 10, useArmorManager: false }
  cfg.system1 = { ...cfg.system1, tickMs: 50 }
  cfg.reconnect = { enabled: false }
  if (tweak) tweak(cfg)
  const shared = index.makeShared(cfg, { dataDir })
  const ended = []
  const session = index.startSession(shared, (info) => ended.push(info))

  return {
    bot,
    shared,
    session,
    prompts,
    ended,
    dataDir,
    ownDir,
    internals: () => session.internals(),
    resetContext: (opts) => session.resetContext(opts),
    spawn () { bot.emit('spawn') },
    say (line) { bot.emit('messagestr', line) },
    async until (fn, ms = 4000) {
      const end = Date.now() + ms
      while (Date.now() < end) { if (fn()) return true; await sleep(25) }
      return false
    },
    stop () {
      try { session.dispose(true) } catch { /* noop */ }
      bot.stopSim?.()
      globalThis.fetch = realFetch
      if (realMineflayer) require.cache[mfPath] = realMineflayer
      else delete require.cache[mfPath]
      if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

module.exports = { simulatedBot, addPlayer, startTestSession, sleep }
