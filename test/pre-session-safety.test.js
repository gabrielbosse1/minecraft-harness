'use strict'

// Regression checks for the bounded pre-session safety fixes. These use the
// real session/dispatcher with synthetic worlds and a scripted model; they do
// not connect to a Minecraft server or a model endpoint.
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeReachabilityCheck, ThreatSense } = require('../zincai/threats')
const { generateShape } = require('../zincai/builder')
const { coerceAction, createZincTools } = require('../zincai/api_wrapper')
const world = require('./helpers/world')
const { simulatedBot, startTestSession, sleep } = require('./helpers/session')
const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const call = (name, args = {}) => coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })
const snapshot = { threatIds: [], askedBy: null, reasons: [] }

test('containment treats only finished success/noPath as answers, not partial, timeout or malformed results', () => {
  for (const [status, expected] of [['success', true], ['noPath', false], ['partial', null], ['timeout', null], ['unexpected', null], [undefined, null]]) {
    const bot = simulatedBot()
    try {
      const zombie = world.addMob(bot, 10, 'zombie', 4.5, 0.5)
      bot.pathfinder.getPathFromTo = function * () { if (status !== undefined) yield { result: { status } } }
      const reachable = makeReachabilityCheck(bot, { Movements: world.Movements, goals: world.goals, cacheMs: 0 })
      assert.equal(reachable(zombie), expected, String(status))
      const picture = new ThreatSense(bot, { reachable }).assess()
      assert.equal(picture.threats.length, expected === false ? 0 : 1, String(status))
      if (expected === false) assert.equal(picture.hidden[0].caged, true)
    } finally { bot.stopSim() }
  }
})

test('a visible melee hostile that is closing cannot be demoted by a cached noPath', () => {
  const bot = simulatedBot()
  try {
    let now = 1000
    const zombie = world.addMob(bot, 10, 'zombie', 5.5, 0.5)
    const sense = new ThreatSense(bot, { reachable: () => false, now: () => now })
    assert.equal(sense.assess().hidden.length, 1)
    now += 500
    zombie.position.x -= 1
    const picture = sense.assess()
    assert.equal(picture.threats.length, 1)
    assert.ok(picture.threats[0].closing > 0)
    assert.equal(picture.hidden.length, 0)
  } finally { bot.stopSim() }
})

test('a timed-out containment probe does not suppress local flee or mislabel the prompt', async () => {
  const bot = simulatedBot()
  bot.pathfinder.getPathFromTo = function * () { yield { result: { status: 'timeout', path: [] } } }
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    world.addMob(bot, 10, 'zombie', 4.5, 0.5)
    assert.ok(await s.until(() => s.internals().system1.fleeing, 2000), 'the local reflex starts without a model decision')
    const prompt = s.internals().buildActionPrompt(['test']).text
    assert.match(prompt, /threats: 1 in sight — zombie/)
    assert.doesNotMatch(prompt, /zombie \(hostile, shut in/)
    assert.equal(s.internals().arbiter.owner(), 'survival')
  } finally { s.stop() }
})

function gatherRig () {
  const bot = simulatedBot({ blocks: { '2,64,0': 'oak_log' }, items: [['wooden_axe']] })
  const equip = bot.equip
  let waiting = false
  let release = null
  let gated = false
  bot.equip = async (item, dest) => {
    if (!gated && item?.name === 'wooden_axe') {
      gated = true
      waiting = true
      await new Promise((resolve) => { release = resolve })
    }
    await equip(item, dest)
  }
  const s = startTestSession({ bot, actions: [{ a: 'gather', item: 'oak_log', count: 1 }] })
  const digs = []
  bot.dig = async (block) => { digs.push({ name: block.name, owner: s.internals().arbiter.owner() }) }
  return {
    bot, s, digs,
    waiting: () => waiting,
    release: () => { if (release) { const r = release; release = null; r() } }
  }
}

test('a stop during gather equip prevents a new dig from starting', async () => {
  const r = gatherRig()
  try {
    r.s.spawn()
    assert.ok(await r.s.until(r.waiting, 4000), 'scripted gather reaches its awaited equip')
    await r.s.internals().executeAction(call('stop'), snapshot)
    r.release()
    assert.ok(await r.s.until(() => !r.s.internals().skills.current(), 2000), 'cancelled gather settled')
    assert.deepEqual(r.digs, [])
    const result = r.s.internals().results.find((x) => x.label === 'stop')
    assert.equal(result?.ok, true)
    assert.match(result.msg, /stop requested.*may continue/)
  } finally { r.release(); r.s.stop() }
})

test('a gather target changed during equip is re-read instead of dug', async () => {
  const r = gatherRig()
  const blockAt = r.bot.blockAt.bind(r.bot)
  let replaced = false
  r.bot.blockAt = (p) => {
    if (replaced && Math.floor(p.x) === 2 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0) {
      return { name: 'dirt', type: world.registry.blocksByName.dirt.id, position: p, boundingBox: 'block' }
    }
    return blockAt(p)
  }
  try {
    r.s.spawn()
    assert.ok(await r.s.until(r.waiting, 4000), 'gather reaches the awaited equip')
    replaced = true
    r.release()
    assert.ok(await r.s.until(() => r.s.internals().results.some((x) => x.label === 'gather'), 3000))
    assert.deepEqual(r.digs, [], 'neither the stale target nor its replacement was dug')
    assert.equal(r.s.internals().results.find((x) => x.label === 'gather').ok, false)
  } finally { r.release(); r.s.stop() }
})

test('a survival preemption during gather equip prevents digging until task control resumes', async () => {
  const r = gatherRig()
  try {
    r.s.spawn()
    assert.ok(await r.s.until(r.waiting, 4000))
    r.bot.pathfinder.getPathFromTo = function * () { yield { result: { status: 'success', path: [] } } }
    const zombie = world.addMob(r.bot, 70, 'zombie', r.bot.entity.position.x + 2, r.bot.entity.position.z)
    assert.ok(await r.s.until(() => r.s.internals().system1.fleeing && r.s.internals().arbiter.owner() === 'survival', 2500))
    r.release()
    await sleep(300)
    assert.deepEqual(r.digs, [], 'no dig is started while survival owns the controls')
    delete r.bot.entities[zombie.id]
    r.s.internals().system1.reset()
    assert.ok(await r.s.until(() => r.digs.length > 0, 4000), 'the task can resume')
    assert.equal(r.digs[0].owner, 'task')
  } finally { r.release(); r.s.stop() }
})

test('shape generation is bounded before loops and uses the dimensions advertised to the model', () => {
  assert.equal(generateShape('floor', { w: 2, d: 4 }, 'stone').length, 8)
  assert.equal(generateShape('box', { w: 2, d: 4, h: 3, filled: true }, 'stone').length, 24)
  assert.ok(generateShape('ring', { r: 10 }, 'stone').length > 0)
  for (const [shape, params] of [
    ['ring', { r: 1e400 }],
    ['floor', { w: 1000000, d: 1 }],
    ['cylinder', { r: 64, h: 64 }],
    ['ring', { r: 1 }],
    ['dome', { r: 1 }],
    ['arch', { w: 2, h: 3 }],
    ['floor', { l: 4, w: 2 }],
    ['box', { w: 2, d: 2, h: 2, filled: 'false' }]
  ]) assert.throws(() => generateShape(shape, params, 'stone'), /build_shape/, `${shape} ${JSON.stringify(params)}`)
  const params = createZincTools({ mode: 'builder' }).find((t) => t.function.name === 'build_shape').function.parameters.properties.params.description
  assert.match(params, /box \{w,d,h\}/)
  assert.match(params, /floor \{w,d\}/)
})

test('oversized shape call reaches model feedback without blocking the simulated session', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: [{ a: 'build_shape', shape: 'floor', params: { w: 1000000, d: 1 }, block: 'stone' }], cfg: (cfg) => { cfg.behavior.mode = 'builder' } })
  try {
    s.spawn()
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'build_shape'), 3000))
    const result = s.internals().results.find((r) => r.label === 'build_shape')
    assert.equal(result.ok, false)
    assert.match(result.msg, /build_shape/)
    assert.equal(s.internals().arbiter.owner(), 'idle')
  } finally { s.stop() }
})

test('corpse_run uses the recorded death place through the session dispatcher', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(100)
    bot.entity.position.set(5.5, 64, 0.5)
    bot.emit('death')
    bot.entity.position.set(0.5, 64, 0.5)
    s.spawn()
    assert.equal(s.shared.places.getPlace('last death')?.x, 5)
    await s.internals().executeAction(call('corpse_run'), snapshot)
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'corpse_run'), 4000))
    const result = s.internals().results.find((r) => r.label === 'corpse_run')
    assert.equal(result.ok, true, result.msg)
    assert.match(result.msg, /near the death spot.*pickup and despawn are not verified/)
    assert.ok(bot.entity.position.x > 1, 'simulated bot actually moved towards the death location')
  } finally { s.stop() }
})

test('a named place or death in another dimension cannot start a same-coordinate walk', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(100)
    s.shared.places.remember('netherhome', new world.Vec3(7, 64, 0), { dim: 'minecraft:the_nether' })
    s.shared.places.remember('last death', new world.Vec3(6, 64, 0), { dim: 'the_nether' })
    await s.internals().executeAction(call('find', { what: 'netherhome' }), snapshot)
    const found = s.internals().results.find((r) => r.label === 'find')
    assert.match(found.msg, /in the_nether.*different dimension/)
    await s.internals().executeAction(call('go_to', { place: 'netherhome' }), snapshot)
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'go_to'), 2000))
    const go = s.internals().results.find((r) => r.label === 'go_to')
    assert.equal(go.ok, false)
    assert.match(go.msg, /in the_nether.*no portal route/)
    await s.internals().executeAction(call('corpse_run'), snapshot)
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'corpse_run'), 2000))
    const recovery = s.internals().results.find((r) => r.label === 'corpse_run')
    assert.equal(recovery.ok, false)
    assert.match(recovery.msg, /in the_nether.*no portal route/)
    assert.equal(bot.log.goals.some((g) => g && g !== 'null'), false)
  } finally { s.stop() }
})
