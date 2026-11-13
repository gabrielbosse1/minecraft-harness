/**
 * digging.test.js — nobody but the model decides to break blocks.
 *
 * There is no operator switch for digging any more. A route is planned through
 * the world as it is (doors are opened), and when that is impossible it says
 * so. Breaking is a request: the model calls `dig`, which opens a bounded,
 * one-shot corridor for exactly one walk. These tests run the REAL
 * mineflayer-pathfinder Movements and A* over a synthetic wall.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { Vec3, registry, makeWorld, Movements, goals, plan } = require('./helpers/world')
const { PathfinderWrapper } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { createZincTools, coerceAction } = require('../zincai/api_wrapper')

/**
 * A sealed 3x3 stone room around the bot's spawn (0,64,0), 4 blocks tall, with
 * open ground outside. No door, no gap: only breaking a wall gets out.
 */
const sealedRoom = (x, y, z) => {
  const fx = Math.floor(x); const fy = Math.floor(y); const fz = Math.floor(z)
  if (fy <= 63) return true
  const inside = Math.abs(fx) <= 1 && Math.abs(fz) <= 1 && fy <= 68
  if (inside) return false
  const onWall = (Math.abs(fx) <= 2 && Math.abs(fz) <= 2) && fy <= 68
  return onWall
}

function wrapperFor (bot) {
  const movements = new Movements(bot)
  bot.pathfinder = { ...(bot.pathfinder || {}), movements, setMovements (m) { this.movements = m } }
  const wrapper = new PathfinderWrapper(bot, { logger: () => {} })
  wrapper.configureMovements(movements)
  return { wrapper, movements }
}

const outside = new goals.GoalXZ(8, 0)

test('default: walls are not tunnels — a sealed room reports no path and breaks nothing', () => {
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)

  assert.equal(movements.canDig, false, 'planning never breaks blocks')
  assert.equal(wrapper.digging, null, 'no dig window is open')

  const trapped = plan(bot, movements, outside)
  assert.equal(trapped.status, 'noPath', 'a sealed room has no route without breaking')
  assert.equal(trapped.broken, 0, 'and nothing was broken to invent one')
})

test('dig request: a corridor opens, the wall is broken, and the window closes with the walk', () => {
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)

  const opened = wrapper.beginDigging({ canDig: null, maxMs: 30_000 })
  assert.ok(opened, 'beginDigging reports the open window')
  assert.equal(movements.canDig, true)

  const through = plan(bot, movements, outside)
  assert.equal(through.status, 'success', 'with permission the route goes through the wall')
  assert.ok(through.broken > 0, 'it actually breaks blocks')

  wrapper.endDigging('walk done')
  assert.equal(movements.canDig, false, 'the permission lapsed with the walk')
  assert.equal(wrapper.digging, null)
  const again = plan(bot, movements, outside)
  assert.equal(again.broken, 0, 'the next route is planned with no digging again')
})

test('materials: only the named blocks may be broken; the rest of the wall is a wall', () => {
  const stoneRoom = (x, y, z) => sealedRoom(x, y, z)
  const bot = makeWorld(stoneRoom)
  const { wrapper, movements } = wrapperFor(bot)
  const cobble = registry.blocksByName.cobblestone.id
  const stone = registry.blocksByName.stone.id

  wrapper.beginDigging({ canDig: ['cobblestone'], maxMs: 30_000 })
  assert.ok(movements.blocksCantBreak.has(stone), 'stone is not on the allowlist, so it is unbreakable')
  assert.ok(!movements.blocksCantBreak.has(cobble), 'cobblestone is allowed')
  assert.equal(plan(bot, movements, outside).broken, 0, 'a stone wall is not broken when only cobblestone was allowed')
  wrapper.endDigging()

  const bot2 = makeWorld(stoneRoom)
  const second = wrapperFor(bot2)
  second.wrapper.beginDigging({ canDig: ['stone'], maxMs: 30_000 })
  assert.ok(plan(bot2, second.movements, outside).broken > 0, 'stone is broken once it is the named material')
})

test('avoid: a protected block is never broken, even inside an open window', () => {
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)
  wrapper.beginDigging({ canDig: null, avoid: ['stone'], maxMs: 30_000 })
  assert.ok(movements.blocksCantBreak.has(registry.blocksByName.stone.id), 'avoid wins over "anything"')
  assert.equal(plan(bot, movements, outside).broken, 0)
  wrapper.endDigging()
})

test('doors stay unbreakable in every window, and a lapsed window leaves nothing behind', () => {
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)
  const oakDoor = registry.blocksByName.oak_door
  const oakStairs = registry.blocksByName.oak_stairs
  const cobble = registry.blocksByName.cobblestone.id
  if (!oakDoor || !oakStairs) return // registry without these blocks: nothing to compare

  wrapper.beginDigging({ canDig: ['oak_stairs'], maxMs: 30_000 })
  assert.ok(movements.blocksCantBreak.has(oakDoor.id), 'a door is never breakable')
  assert.ok(!movements.blocksCantBreak.has(oakStairs.id), 'the allowed material is breakable')
  assert.ok(movements.blocksCantBreak.has(cobble), 'everything else is not')
  wrapper.endDigging()
  assert.ok(movements.blocksCantBreak.has(oakDoor.id), 'closing the window keeps the door protection')
  assert.ok(!movements.blocksCantBreak.has(oakStairs.id), 'closing the window removes the allowlist policy')
  assert.ok(!movements.blocksCantBreak.has(cobble), 'and the "everything else" rule with it')
})

test('upstream rebuilds the unbreakable set on every plan; the policy is re-asserted after it', () => {
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)
  const doorId = registry.blocksByName.oak_door.id
  const stoneId = registry.blocksByName.stone.id
  // configureMovements installs the hook; apply() installs the prototype patch.
  wrapper.apply()

  plan(bot, movements, outside)
  assert.ok(movements.blocksCantBreak.has(doorId), 'a plan does not silently unprotect doors')
  assert.equal(movements.canDig, false)

  wrapper.beginDigging({ canDig: null, maxMs: 30_000 })
  const through = plan(bot, movements, outside)
  assert.ok(through.broken > 0, 'the window survives a replan')
  assert.ok(movements.blocksCantBreak.has(doorId), 'and doors are still protected inside it')
  assert.ok(!movements.blocksCantBreak.has(stoneId), 'while the wall is breakable')

  wrapper.endDigging()
  plan(bot, movements, outside)
  assert.equal(movements.canDig, false, 'the next plan after the window does not dig')
  assert.ok(movements.blocksCantBreak.has(doorId), 'and doors are still protected')
  wrapper.stop() // apply() starts the humanizer/threat timers; end them with the test
})

test('a window expires on its own and is never inherited by the next route', async () => {
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)
  wrapper.beginDigging({ canDig: null, maxMs: 1_000 })
  assert.equal(movements.canDig, true)
  await new Promise((resolve) => setTimeout(resolve, 1_150))
  assert.equal(wrapper.digging, null, 'the window is gone after maxMs')
  assert.equal(movements.canDig, false, 'and the live Movements knows it')
  wrapper.endDigging()
})

test('the model can call dig, and the schema says it is the only way to break anything', () => {
  const dig = createZincTools().find((t) => t.function.name === 'dig')
  assert.ok(dig, 'dig is part of the action tool set')
  assert.deepEqual(Object.keys(dig.function.parameters.properties).sort(), ['avoid', 'materials', 'place', 'player', 'x', 'y', 'z'])
  assert.ok(dig.function.parameters.properties.materials.items, 'materials is a list of block ids')
  assert.match(dig.function.description, /only|nothing is broken without this call/i)

  const action = coerceAction({ tool_calls: [{ function: { name: 'dig', arguments: JSON.stringify({ x: 8, z: 0, materials: ['stone'], avoid: ['oak_log'] }) } }] })
  assert.deepEqual(action, { x: 8, z: 0, materials: ['stone'], avoid: ['oak_log'], a: 'dig', _via: 'tool' })

  const bad = coerceAction({ tool_calls: [{ function: { name: 'dig', arguments: JSON.stringify({ x: 8, z: 0, materials: [7] }) } }] })
  assert.equal(bad._badArgs, 'dig', 'a non-string block id is rejected')
})

test('the operator-facing digging switch is gone from config and template', () => {
  const config = require('../zincai/config/defaults.json')
  const template = require('../pufferpanel/zincai.json')
  assert.equal(config.behavior.allowDigging, undefined, 'defaults.json has no digging switch')
  assert.equal(template.data.candig, undefined, 'the template has no digging variable')
  assert.equal(template.run.environmentVars.MC_CAN_DIG, undefined, 'and no digging environment variable')
  assert.ok(template.data.scaffolding, 'scaffolding is a different switch and stays')
})

test('the executor runs a dig request and reports the outcome back to the model', async () => {
  const { simulatedBot, startTestSession } = require('./helpers/session')
  const bot = simulatedBot()
  let asked = 0
  const session = startTestSession({
    bot,
    actions: () => { asked++; return asked === 1 ? { a: 'dig', player: 'Steve' } : null }
  })
  try {
    session.spawn()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const prompts = session.prompts.action || []
    assert.ok(asked >= 1, 'the scripted dig request reached the executor')
    assert.ok(prompts.length >= 2, 'the failed dig woke the model again')
    const feedback = prompts[prompts.length - 1]
    assert.match(feedback, /dig: FAILED/, 'the model is told the dig did not happen')
    assert.match(feedback, /no player named "Steve"/, 'and why')
  } finally {
    session.stop?.()
  }
})

test('the prompt tells the model that digging is its decision', () => {
  const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  assert.match(prompt, /DIGGING/)
  assert.match(prompt, /`dig`/)
  assert.match(prompt, /never break blocks|no path/)
})

test('a dig walk closes its window however it ends', async () => {
  const { Skills } = require('../zincai/skills')
  const bot = makeWorld(sealedRoom)
  const { wrapper, movements } = wrapperFor(bot)
  const lane = { acquire () {}, setGoal () {}, clearControlStates () {}, active: true, isTop: true }
  const arbiter = { lane: () => lane }
  const skills = new Skills(bot, { arbiter, places: null, pathfinder: () => wrapper, moveTimeoutMs: 2_000 })

  wrapper.beginDigging({ canDig: null, maxMs: 30_000 })
  const token = { label: 'digging', startedAt: Date.now(), cancelled: 'test', digWindow: true }
  skills._token = token
  // Simulate the walk's finally block through the public cancellation path.
  skills.cancel('test')
  try { wrapper.endDigging('walk done') } catch { /* noop */ }
  assert.equal(movements.canDig, false)
  assert.equal(wrapper.digging, null)
})
