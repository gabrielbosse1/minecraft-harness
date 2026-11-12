'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { RedstoneInspector, componentKind } = require('../zincai/redstone_inspect')
const { coerceAction, createZincTools } = require('../zincai/api_wrapper')
const { simulatedBot, startTestSession } = require('./helpers/session')
const block = (name, props) => ({ name, getProperties: () => props })
function fixture () {
  const bot = simulatedBot()
  const cells = new Map([
    ['0,64,0', block('redstone_wire', { east: 'side', west: 'none', north: 'none', south: 'none', power: 7 })],
    ['1,64,0', block('redstone_wire', { west: 'side', east: 'up', north: 'none', south: 'none', power: 6 })],
    ['2,65,0', block('redstone_wire', { west: 'side', east: 'none', north: 'none', south: 'none', power: 5 })],
    ['0,65,0', block('repeater', { facing: 'north', delay: 3, locked: false, powered: true })],
    ['0,64,1', block('comparator', { facing: 'east', mode: 'subtract', powered: false })],
    ['-1,64,0', block('observer', { facing: 'west', powered: false })],
    ['0,63,0', block('sticky_piston', { facing: 'up', extended: false })],
    ['1,64,1', block('lever', { facing: 'north', face: 'wall', powered: false })],
    ['2,64,1', block('stone_button', { facing: 'east', face: 'wall', powered: true })]
  ])
  bot.blockAt = (p) => p.x === -2 && p.y === 64 && p.z === 0 ? null : cells.get(`${p.x},${p.y},${p.z}`) || block('air', {})
  return { bot, cells }
}
const call = (name, args) => coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })

test('recognizes redstone component names without classifying ordinary stone', () => {
  for (const name of ['redstone_wire', 'repeater', 'comparator', 'observer', 'piston', 'sticky_piston', 'redstone_torch', 'lever', 'stone_button']) assert.ok(componentKind(name), name)
  assert.equal(componentKind('stone'), null)
})
test('3D scan summarizes observed data, unknown cells, stable pagination and dust geometry', () => {
  const { bot, cells } = fixture(); let now = 1000
  try {
    const inspector = new RedstoneInspector(bot, { now: () => now })
    const first = inspector.scan({ x: 0, y: 64, z: 0, radius: 2 })
    assert.equal(first.ok, true); assert.match(first.msg, /rs1 snapshot 0s old/)
    assert.match(first.msg, /9 recognized components/); assert.match(first.msg, /1 unloaded/)
    assert.match(first.msg, /1 observed dust-side geometries/); assert.match(first.msg, /no power proven/)
    assert.match(first.msg, /Page 1\/3/)
    cells.clear(); now += 5000
    const second = inspector.scan({ snapshot: 'rs1', page: 2 })
    assert.match(second.msg, /5s old/); assert.match(second.msg, /Page 2\/3/); assert.match(second.msg, /9 recognized components/)
    assert.match(inspector.scan({ snapshot: 'rs1', page: 4 }).msg, /out of range/)
    for (let k = 0; k < 5; k++) assert.equal(inspector.scan({ x: 0, y: 64, z: 0, radius: 0, page: 2 }).ok, false)
    assert.equal(inspector.scan({ snapshot: 'rs1' }).ok, true, 'invalid pages must not evict an existing snapshot')
    assert.equal(inspector.scan({ x: 8, y: 64, z: 0, radius: 2 }).ok, false)
    assert.equal(inspector.scan({ x: 0, y: 64, z: 0, radius: 3 }).ok, false)
  } finally { bot.stopSim() }
})
test('component state and relationships are evidence-labeled without power or false causal claims', () => {
  const { bot } = fixture()
  try {
    const inspector = new RedstoneInspector(bot); inspector.scan({ x: 0, y: 64, z: 0, radius: 2 })
    const wire = inspector.inspect({ snapshot: 'rs1', x: 1, y: 64, z: 0 })
    assert.match(wire.msg, /east=up/); assert.match(wire.msg, /power=6/)
    assert.match(wire.msg, /observed_dust_side_geometry/); assert.match(wire.msg, /possible_dust_step/)
    assert.match(wire.msg, /No direction or actual power inferred/)
    const repeater = inspector.inspect({ snapshot: 'rs1', x: 0, y: 65, z: 0 })
    assert.match(repeater.msg, /facing=north/); assert.match(repeater.msg, /delay=3/); assert.match(repeater.msg, /locked=false/)
    assert.match(repeater.msg, /adjacent_unresolved/)
    const comparator = inspector.inspect({ snapshot: 'rs1', x: 0, y: 64, z: 1 })
    assert.match(comparator.msg, /mode=subtract/); assert.match(comparator.msg, /output strength\/container data unknown/)
    assert.equal(inspector.inspect({ snapshot: 'rs1', x: 99, y: 64, z: 0 }).ok, false)
    assert.match(inspector.inspect({ snapshot: 'rs1', x: -1, y: 64, z: 0 }).msg, /-2,64,0 unloaded/)
  } finally { bot.stopSim() }
})
test('unknown properties and snapshots are never presented as empty or current', () => {
  const { bot, cells } = fixture()
  try {
    cells.set('0,64,0', { name: 'redstone_wire', getProperties () { throw new Error('missing') } })
    const i = new RedstoneInspector(bot); i.scan({ x: 0, y: 64, z: 0 })
    const r = i.inspect({ snapshot: 'rs1', x: 0, y: 64, z: 0 })
    assert.match(r.msg, /none observed; missing north,south,east,west,power/)
    assert.doesNotMatch(r.msg, /observed_dust_side_geometry/)
    assert.equal(i.scan({ snapshot: 'rs2' }).ok, false)
  } finally { bot.stopSim() }
})
test('model tools expose scan and component, route through executor with no world mutation', async () => {
  for (const mode of ['builder', 'explorer', 'hunter']) for (const name of ['redstone_scan', 'redstone_component']) assert.ok(createZincTools({ mode }).some((t) => t.function.name === name))
  assert.equal(call('redstone_component', { snapshot: 'rs1' })._badArgs, 'redstone_component')
  const { bot } = fixture(); const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    await s.internals().executeAction(call('redstone_scan', { x: 0, y: 64, z: 0, radius: 2 }), { threatIds: [], askedBy: null })
    assert.match(s.internals().results.find((r) => r.label === 'redstone_scan').msg, /rs1 snapshot/)
    await s.internals().executeAction(call('redstone_component', { snapshot: 'rs1', x: 0, y: 65, z: 0 }), { threatIds: [], askedBy: null })
    assert.match(s.internals().results.find((r) => r.label === 'redstone_component').msg, /repeater@0,65,0.*delay=3/)
    assert.deepEqual(bot.log.attack, []); assert.deepEqual(bot.log.goals, [])
  } finally { s.stop() }
})

test('real prismarine block states expose direction, delay and signal as client values', () => {
  const w = require('./helpers/world')
  const { bot } = fixture()
  try {
    bot.blockAt = (p) => {
      const name = p.x === 0 && p.y === 64 && p.z === 0 ? 'redstone_wire' : p.x === 1 && p.y === 64 && p.z === 0 ? 'repeater' : 'air'
      return w.Block.fromStateId(w.registry.blocksByName[name].defaultState, 0)
    }
    const i = new RedstoneInspector(bot); i.scan({ x: 0, y: 64, z: 0 })
    assert.match(i.inspect({ snapshot: 'rs1', x: 0, y: 64, z: 0 }).msg, /power=0/)
    assert.match(i.inspect({ snapshot: 'rs1', x: 1, y: 64, z: 0 }).msg, /facing=north, delay=1, locked=false, powered=false/)
  } finally { bot.stopSim() }
})
