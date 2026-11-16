'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { clearLine } = require('../zincai/threats')
const { environmentSnapshot } = require('../zincai/environment')
const { buildSiteError } = require('../zincai/build_site')
const { situation, describeSituation } = require('../zincai/tactics')
const { isAutoFightCandidate } = require('../zincai/threats')
const { FailGate } = require('../zincai/failgate')
const { createZincTools, coerceAction, coerceActions } = require('../zincai/api_wrapper')
const { TOOL_LANES, LANES, laneOfAction, resourcesFor } = require('../zincai/lanes')
const { resolveModelLimits } = require('../zincai/context_budget')
const { ContinuityStore } = require('../zincai/continuity')
const { PlaceIndex } = require('../zincai/places')
const { GoalRegistry } = require('../zincai/goals')
const { WorkJournal } = require('../zincai/journal')

function blockBot (pos = new Vec3(0, 64, 0), blockAt) {
  return { entity: { position: pos, height: 1.8 }, game: { dimension: 'overworld', maxY: 100 }, health: 20, food: 20,
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }] }, heldItem: { name: 'iron_sword' },
    blockAt: (p, extra) => { assert.ok(p instanceof Vec3, 'Mineflayer blockAt requires Vec3'); return blockAt(p, extra) } }
}

test('14a: LOS probes Mineflayer with Vec3 and solid walls actually block threats', () => {
  const bot = blockBot(undefined, (p) => ({ name: 'stone', boundingBox: p.x === 2 ? 'block' : 'empty' }))
  assert.equal(clearLine(bot, { x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }), false)
  const open = blockBot(undefined, () => ({ name: 'air', boundingBox: 'empty' }))
  assert.equal(clearLine(open, { x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }), true)
})

test('14b: environment labels distinguish exposed surface from a natural cave using loaded blocks', () => {
  const cave = blockBot(new Vec3(0, 64, 0), (p) => {
    if (p.y === 63 || p.y === 70) return { name: 'stone', boundingBox: 'block', light: 0, skyLight: 0 }
    return { name: 'air', boundingBox: 'empty', light: 0, skyLight: 0 }
  })
  const c = environmentSnapshot(cave)
  assert.equal(c.skyVisible, false)
  assert.match(c.line, /cave\/underground/)
  assert.match(c.line, /overhead stone/)
  const surface = blockBot(new Vec3(0, 64, 0), (p) => p.y === 63
    ? { name: 'grass_block', boundingBox: 'block', light: 0, skyLight: 15 }
    : { name: 'air', boundingBox: 'empty', light: 0, skyLight: 15 })
  assert.equal(environmentSnapshot(surface).skyVisible, true)
  assert.match(environmentSnapshot(surface).line, /surface, sky visible/)
  const underground = blockBot(new Vec3(0, 20, 0), (p) => {
    if (p.x === 0 && p.z === 0 && (p.y === 19 || p.y === 22)) return { name: 'stone', boundingBox: 'block' }
    if ((p.x !== 0 || p.z !== 0) && p.y === 63) return { name: 'grass_block', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  })
  const exitLine = environmentSnapshot(underground).line
  assert.match(exitLine, /open-sky walkable candidates/)
  assert.match(exitLine, /route not verified; use go_to/)
})

test('14c: large house site guard rejects caves, liquids and unsupported floating footprints, permits a dry surface', () => {
  const origin = new Vec3(0, 64, 0)
  const steps = Array.from({ length: 16 }, (_, i) => ({ x: i % 4, y: 64, z: Math.floor(i / 4), name: 'oak_planks' }))
  const botFor = (fn) => ({ blockAt: (p) => fn(p) })
  assert.match(buildSiteError(botFor((p) => p.y === 63 ? { name: 'stone', boundingBox: 'block' } : p.y === 70 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }), { label: 'small_house', origin, steps }), /cave\/underground/)
  assert.match(buildSiteError(botFor((p) => p.y === 63 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' }), { label: 'small_house', origin, steps }), /dry, solid ground/)
  assert.match(buildSiteError(botFor(() => ({ name: 'air', boundingBox: 'empty' })), { label: 'watchtower', origin, steps }), /solid support/)
  assert.equal(buildSiteError(botFor((p) => p.y === 63 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }), { label: 'small_house', origin, steps }), null)
  assert.equal(buildSiteError(botFor(() => ({ name: 'air', boundingBox: 'empty' })), { label: 'wall', origin, steps: steps.slice(0, 6) }), null)
})

test('14d: favorable melee zombie remains auto-engage eligible; creepers and passive mobs never receive blind melee auto-engage', () => {
  const bot = { health: 20, inventory: { items: () => [{ name: 'iron_sword', count: 1 }] }, heldItem: { name: 'iron_sword' }, entity: { position: new Vec3(0, 64, 0) } }
  const threat = (name, id) => ({ id, name, kind: 'mob', distance: 5, where: '5m E', entity: { id, name, position: new Vec3(5, 64, 0), metadata: [] }, closing: 1 })
  assert.equal(situation(bot, [threat('zombie', 1)]).fight.autoEngage, true)
  const creeper = situation(bot, [threat('creeper', 2)])
  assert.equal(creeper.fight.autoEngage, false)
  assert.equal(isAutoFightCandidate({ id: 3, name: 'cow', position: new Vec3(3, 64, 0), metadata: [] }, bot), false)
  assert.match(describeSituation(situation(bot, [threat('zombie', 1)])).join('\n'), /\[id=1\]/)
})

test('14e: repeated failed navigation/dig calls are blocked instead of looping', () => {
  let now = 10_000
  const gate = new FailGate({ maxFails: 2, now: () => now })
  const call = { a: 'dig', x: 20, y: 64, z: -3 }
  gate.recordFailure(call, 'no path to destination', { x: 0, z: 0 })
  assert.equal(gate.check(call, { x: 0, z: 0 }), null)
  gate.recordFailure(call, 'no path to destination', { x: 0, z: 0 })
  assert.match(gate.check(call, { x: 0, z: 0 }), /Do NOT call it again unchanged/)
  assert.equal(gate.check(call, { x: 8, z: 0 }), null, 'moving beyond the threshold permits a fresh attempt')
  now += 130_000
  assert.equal(gate.check(call, { x: 0, z: 0 }), null, 'expired failures do not block forever')
})

test('14f: exact action tool catalog and execution lanes include every registered schema; model limits recognize MiniCPM-V', () => {
  const tools = createZincTools()
  assert.equal(tools.length, 41)
  assert.equal(new Set(tools.map((t) => t.function.name)).size, tools.length)
  assert.equal(TOOL_LANES.memory, LANES.COMPUTATION)
  assert.equal(TOOL_LANES.redstone_engineer, LANES.WORLD_INFO)
  assert.equal(laneOfAction({ a: 'redstone_engineer', operation: 'analyze' }), LANES.WORLD_INFO)
  assert.equal(laneOfAction({ a: 'redstone_engineer', operation: 'place' }), LANES.BODY)
  assert.ok(resourcesFor('redstone_engineer', { operation: 'place' }).includes('world'), 'placement takes a world write lock')
  assert.equal(resolveModelLimits('MiniCPM-V-4.7-35B-A3B').family, 'minicpm-v-4.7')
  const invalid = coerceAction({ tool_calls: [{ function: { name: 'go_to', arguments: '{"x":"east"}' } }] })
  assert.match(invalid._badArgsDetail, /'x' must be an integer/)
  const multiple = coerceActions({ tool_calls: [
    { id: 'bad', function: { name: 'go_to', arguments: '{"x":"east"}' } },
    { id: 'good', function: { name: 'idle', arguments: '{}' } }
  ] })
  assert.equal(multiple.length, 2, 'a bad sibling call does not discard valid calls in the same model response')
  assert.match(multiple[0]._badArgsDetail, /integer/)
  assert.equal(multiple[1].a, 'idle')
})

test('14g: a verified home has one usable named destination; simply visiting a place does not claim it', () => {
  const store = new ContinuityStore({ botName: 'ZincAI' })
  const steps = Array.from({ length: 16 }, (_, i) => ({ x: i % 4, y: 64, z: Math.floor(i / 4), name: 'oak_planks' }))
  const rec = store.recordConstruction({ label: 'small_house', steps, origin: 'self' })
  assert.ok(store.identity.home, 'a self-built house establishes verified home evidence')
  const places = new PlaceIndex()
  places.remember('home', store.identity.home, { dim: 'overworld', ownership: 'own' })
  assert.equal(places.getPlace('home').x, store.identity.home.x)
  const unverified = new ContinuityStore({ botName: 'ZincAI' })
  assert.equal(unverified.setHome({ place: 'home', pos: { x: 1, y: 64, z: 1 }, basis: 'self_built' }).ok, false)
  assert.equal(rec.label, 'small_house')
})

test('14h: underground frontier sensing emits only probed walkable coordinates, never solid-rock coordinate guesses', () => {
  const store = new ContinuityStore()
  const bot = { blockAt: () => null }
  const suggestions = store._computeUnexplored(bot, { x: 0, y: 20, z: 0 }, 'overworld', 0, 0)
  assert.deepEqual(suggestions, [])
  assert.equal(suggestions.some((x) => /~/.test(x)), false)
})

test('14i: low health, a threatening crowd and passive animals alter tactics without mislabelling the animals', () => {
  const bot = { health: 5, inventory: { items: () => [] }, entity: { position: new Vec3(0, 64, 0) } }
  const horde = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: 'zombie', kind: 'mob', distance: 4, where: '4m E', entity: { id: i + 1, name: 'zombie', position: new Vec3(4, 64, i / 10), metadata: [] }, closing: 2 }))
  const odds = situation(bot, horde)
  assert.equal(odds.fight.autoEngage, false)
  assert.ok(odds.fight.winChance < 40)
  const cow = { id: 40, name: 'cow', position: new Vec3(2, 64, 0), metadata: [] }
  assert.equal(isAutoFightCandidate(cow, bot), false)
})

test('14j: parent objective and plan survive a child step; completion leaves the next open goal selectable', () => {
  const goals = new GoalRegistry()
  const parent = goals.add({ description: 'return home safely', priority: 80 })
  goals.resume(parent.id)
  const child = goals.add({ description: 'find a walkable exit', parentId: parent.id, priority: 80 })
  goals.resume(child.id)
  const journal = new WorkJournal()
  journal.setPlan(parent.id, ['locate open-sky exit', 'walk home'])
  journal.setPlan(child.id, ['inspect terrain', 'go to opening'])
  journal.setFocus(child.id)
  assert.match(journal.continuation({ goal: parent }), /return home safely/)
  assert.match(journal.continuation({ goal: child }), /find a walkable exit/)
  goals.complete(child.id)
  assert.equal(goals.openGoals().find((g) => g.id === parent.id).id, parent.id)
  assert.match(journal.continuation({ goal: parent }), /locate open-sky exit/)
})
