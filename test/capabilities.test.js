'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectBlock } = require('../zincai/block_inspect')
const { coerceAction, createZincTools } = require('../zincai/api_wrapper')
const { simulatedBot, startTestSession, sleep } = require('./helpers/session')

const invoke = (args) => coerceAction({ tool_calls: [{ function: { name: 'inspect_block', arguments: JSON.stringify(args) } }] })
test('read-only inspector preserves observed state and refuses unobservable coordinates', () => {
  const bot = simulatedBot()
  bot.blockAt = () => ({ name: 'repeater', getProperties: () => ({ powered: false, facing: 'east', delay: 3 }) })
  assert.match(inspectBlock(bot, { x: 1, y: 64, z: 0 }).msg, /delay=3, facing=east, powered=false/)
  assert.match(inspectBlock(bot, { x: 1, y: 64, z: 0 }).msg, /no connectivity or behavior inferred/)
  bot.blockAt = () => ({ name: 'wire', getProperties: () => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, i])) })
  assert.match(inspectBlock(bot, { x: 1, y: 64, z: 0 }).msg, /some properties omitted/)
  assert.equal(inspectBlock(bot, { x: 90, y: 64, z: 0 }).ok, false)
  assert.equal(inspectBlock(bot, { x: 1.5, y: 64, z: 0 }).ok, false)
  bot.blockAt = () => null
  assert.match(inspectBlock(bot, { x: 1, y: 64, z: 0 }).msg, /not loaded/)
  bot.stopSim()
})
test('inspector schema is exposed in each mode, validates arguments and reaches results', async () => {
  for (const mode of ['explorer', 'hunter', 'builder']) assert.ok(createZincTools({ mode }).some((t) => t.function.name === 'inspect_block'))
  assert.equal(invoke({ x: 1, y: 64 })._badArgs, 'inspect_block')
  const action = invoke({ x: 1, y: 64, z: 0 })
  const bot = simulatedBot(); bot.blockAt = () => ({ name: 'campfire', getProperties: () => ({ lit: true }) })
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    await s.internals().executeAction(action, { threatIds: [], askedBy: null })
    assert.match(s.internals().results.find((r) => r.label === 'inspect_block').msg, /campfire.*lit=true/)
  } finally { s.stop() }
})
test('gather reports resolved digs and inventory delta without claiming collected drops', async () => {
  const bot = simulatedBot({ blocks: { '2,64,0': 'oak_log' } })
  bot.dig = async () => {}
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(50)
    const r = await s.internals().skills.gather({ item: 'oak_log', count: 1 })
    assert.equal(r.ok, true)
    assert.match(r.msg, /dig calls completed: 1\/1/)
    assert.match(r.msg, /net change: 0 \(not attributable/)
    assert.doesNotMatch(r.msg, /gathered/)
  } finally { s.stop() }
})

test('paginated 3D region inspection labels missing cells and limits observations', async () => {
  const { inspectRegion } = require('../zincai/region_inspect')
  const bot = simulatedBot()
  const visited = []
  bot.blockAt = (p) => {
    visited.push([p.x, p.y, p.z])
    if (p.x === -1) return null
    return { name: 'redstone_wire', getProperties: () => ({ north: 'side', east: 'none', power: 3 }) }
  }
  const one = inspectRegion(bot, { x: 0, y: 64, z: 0, radius: 1, page: 1 })
  assert.match(one.msg, /page 1\/7/)
  assert.match(one.msg, /not loaded/)
  assert.match(one.msg, /power=3/)
  assert.match(one.msg, /Non-atomic client snapshots; no connectivity inferred/)
  assert.equal(visited.length, 4)
  assert.deepEqual(visited[0], [-1, 63, -1])
  assert.equal(inspectRegion(bot, { x: 0, y: 64, z: 0, radius: 3 }).ok, false)
  assert.match(inspectRegion(bot, { x: Number.MAX_SAFE_INTEGER, y: 64, z: 0, radius: 2 }).msg, /safe integer range/)
  assert.equal(inspectRegion(bot, { x: 7, y: 64, z: 0, radius: 2 }).ok, false)
  assert.equal(inspectRegion(bot, { x: 0, y: 64, z: 0, page: 8 }).ok, false)
  const action = coerceAction({ tool_calls: [{ function: { name: 'inspect_region', arguments: '{"x":0,"y":64,"z":0,"radius":1,"page":2}' } }] })
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await s.internals().executeAction(action, { threatIds: [], askedBy: null })
    assert.match(s.internals().results.find((r) => r.label === 'inspect_region').msg, /page 2\/7/)
  } finally { s.stop() }
})
