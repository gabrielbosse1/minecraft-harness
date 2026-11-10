/**
 * Elite systems tests — predictive threat map, goldilocks combat, wind-charge
 * traversal, Scout & Relocate, semantic clustering, phased building, and the
 * vanilla-only guard. Pure / mocked, no network, no server.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const {
  PredictiveThreatMap,
  WindChargeTraversal,
  scoutSafeAnchor,
  findGroundY,
  projectFuture,
  isHostileName
} = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const {
  AdvancedCombat,
  AttackCooldown,
  WEAPON_PROFILES,
  weaponProfile,
  cooldownProgress,
  classifyThreat,
  heldItemName,
  CRIT_THRESHOLD
} = require('../src/combat')
const { System1 } = require('../zincai/system1')
const { ReflexRegistry } = require('../zincai/reflex_registry')
const {
  clusterBlocks,
  detectStructures,
  categorizeBlock
} = require('../zincai/perception')
const {
  decomposePhases,
  normalizeStage,
  BuilderExecutor,
  PHASE_ORDER
} = require('../zincai/builder')
const { installVanillaGuard, assertVanillaAction, isCommandLine } = require('../zincai/vanilla_guard')

// --------------------------------------------------------------- helpers ---
const pos = (x, y, z) => ({
  x,
  y,
  z,
  offset (dx, dy, dz) { return pos(x + dx, y + dy, z + dz) },
  floored () { return pos(Math.floor(x), Math.floor(y), Math.floor(z)) },
  distanceTo (o) { return Math.hypot(x - o.x, y - o.y, z - o.z) },
  clone () { return pos(x, y, z) },
  plus (o) { return pos(x + o.x, y + o.y, z + o.z) },
  minus (o) { return pos(x - o.x, y - o.y, z - o.z) }
})

const solid = (name = 'stone', bb = 'block') => ({ name, boundingBox: bb })
const air = () => ({ name: 'air', boundingBox: 'empty' })

function threatBot (entities = {}, at = { x: 0, y: 64, z: 0 }) {
  return {
    entity: { position: at, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true },
    entities
  }
}

function hostile (id, x, y, z, { name = 'zombie', velocity = { x: 0, y: 0, z: 0 }, ...rest } = {}) {
  return { id, name, position: pos(x, y, z), velocity, ...rest }
}

function combatFixture ({ held = 'iron_sword', targetDist = 3.0, inventoryItems = [] } = {}) {
  const controls = {}
  const calls = { attack: 0, activate: 0, deactivate: 0, equip: 0, jump: 0 }
  const bot = {
    health: 20,
    food: 20,
    heldItem: { name: held },
    entity: { position: pos(0, 64, 0), velocity: { x: 0, y: 0, z: 0 }, onGround: true, yaw: 0, pitch: 0 },
    entities: {},
    inventory: { items: () => inventoryItems, slots: [] },
    pathfinder: { setGoal () {}, isMoving: () => false, goal: null },
    lookAt: async () => {},
    look: async () => {},
    setControlState (c, v) { controls[c] = v; if (c === 'jump' && v) calls.jump++ },
    attack () { calls.attack++ },
    activateItem () { calls.activate++ },
    deactivateItem () { calls.deactivate++ },
    equip: async () => { calls.equip++ }
  }
  const target = {
    id: 7,
    name: 'zombie',
    position: pos(0, 64, targetDist),
    height: 1.8,
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true
  }
  bot.entities[7] = target
  return { bot, target, controls, calls }
}

// ===================================================== PredictiveThreatMap ==
test('projectFuture extrapolates position by velocity × ticks', () => {
  const f = projectFuture({ x: 1, y: 2, z: 3 }, { x: 0.1, y: 0, z: -0.2 }, 40)
  assert.equal(Math.round(f.x * 100) / 100, 5)
  assert.equal(f.y, 2)
  assert.equal(Math.round(f.z * 100) / 100, -5)
  assert.deepEqual(projectFuture({ x: 0, y: 0, z: 0 }, null, 40), { x: 0, y: 0, z: 0 })
})

test('threat map samples hostile velocity, projects 40 ticks ahead and throttles to 200ms', () => {
  let t = 1000
  const map = new PredictiveThreatMap({ now: () => t, sampleMs: 200 })
  const bot = threatBot({ 1: hostile(1, 0, 64, 5, { velocity: { x: 0, y: 0, z: 0.2 } }) })
  const threats = map.sample(bot, true)
  assert.equal(threats.length, 1)
  assert.ok(Math.abs(threats[0].future.z - 13) < 1e-6, `expected z≈13, got ${threats[0].future.z}`)
  assert.equal(map.sampleCount, 1)
  t += 50
  map.sample(bot) // throttled
  assert.equal(map.sampleCount, 1)
  t += 250
  map.sample(bot)
  assert.equal(map.sampleCount, 2)
})

test('costAt penalizes the projected kill sphere, not empty ground', () => {
  const map = new PredictiveThreatMap()
  const bot = threatBot({ 1: hostile(1, 0, 64, 6, { velocity: { x: 0, y: 0, z: 0.05 } }) })
  map.sample(bot, true)
  const future = map.threats[0].future
  assert.ok(map.costAt({ x: future.x, y: future.y, z: future.z }) > 10)
  assert.equal(map.costAt({ x: 30, y: 64, z: -30 }), 0)
})

test('threat map penalizes the enemy→bot corridor through the A* exclusion hook', () => {
  const map = new PredictiveThreatMap()
  const bot = threatBot({ 1: hostile(1, 0, 64, 8) })
  map.sample(bot, true)
  // A node on the straight line between the zombie and the bot.
  assert.ok(map.costAt({ x: 0, y: 64, z: 4 }) > 0, 'corridor node must cost')

  const movements = { exclusionAreasStep: [] }
  assert.equal(map.attachToMovements(movements), true)
  assert.equal(movements.exclusionAreasStep.length, 1)
  const hook = movements.exclusionAreasStep[0]
  assert.ok(hook({ position: { x: 0, y: 64, z: 4 } }) > 0)
  assert.equal(hook({ position: { x: 40, y: 64, z: 40 } }), 0)
  // Idempotent attach — never stack duplicate cost functions.
  map.attachToMovements(movements)
  assert.equal(movements.exclusionAreasStep.length, 1)
})

test('priority routing prefers a longer route with lower cumulative threat', () => {
  const map = new PredictiveThreatMap()
  const bot = threatBot({ 1: hostile(1, 0, 64, 5, { velocity: { x: 0, y: 0, z: 0.1 } }) })
  map.sample(bot, true)
  const danger = { x: 0, y: 64, z: 10 } // straight through the projected path
  const safe = { x: 8, y: 64, z: 6 }    // longer, but around the kill zone
  const ranked = map.rankGoals([danger, safe], bot.entity.position)
  assert.equal(ranked[0].x, 8, `safe route must win, got ${JSON.stringify(ranked)}`)
  assert.ok(ranked[1].threat > ranked[0].threat)
})

test('escapeVector flees the projected position, not the stale one', () => {
  const map = new PredictiveThreatMap()
  // Charging from +z toward the bot: its projected point is BEHIND the bot.
  const bot = threatBot({ 1: hostile(1, 0, 64, 5, { velocity: { x: 0, y: 0, z: -0.2 } }) })
  map.sample(bot, true)
  const v = map.escapeVector(bot.entity.position)
  assert.ok(v.z > 0.9, `expected escape +z (away from projection), got ${JSON.stringify(v)}`)
  assert.ok(Math.abs(v.x) < 0.2)
})

// ==================================================== wind charge traversal ==
test('wind charge analyze detects a 3-wide gap and a 3-high wall', () => {
  // Gap: floor missing for z=3..5, otherwise solid at y=63.
  const gapBot = {
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt: (v) => {
      const z = Math.round(v.z)
      const y = Math.round(v.y)
      if (y <= 63) return (z >= 3 && z <= 5) ? air() : solid()
      return air()
    }
  }
  const gap = new WindChargeTraversal(gapBot).analyze({ x: 0, z: 1 })
  assert.ok(gap && gap.kind === 'gap', `expected gap, got ${JSON.stringify(gap)}`)
  assert.equal(gap.width, 3)

  // Wall: z=1..2 solid up to y=66, clear above.
  const wallBot = {
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt: (v) => {
      const z = Math.round(v.z)
      const y = Math.round(v.y)
      if (z >= 1 && z <= 2 && y >= 64 && y <= 66) return solid('cobblestone')
      if (y <= 63) return solid()
      return air()
    }
  }
  const wall = new WindChargeTraversal(wallBot).analyze({ x: 0, z: 1 })
  assert.ok(wall && wall.kind === 'wall', `expected wall, got ${JSON.stringify(wall)}`)
  assert.equal(wall.height, 3)
})

test('wind charge use() executes equip → look → activateItem → jump in order', async () => {
  const order = []
  const bot = {
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'wind_charge', count: 2 }] },
    equip: async () => { order.push('equip') },
    look: async () => { order.push('look') },
    activateItem: () => { order.push('activateItem') },
    setControlState: (c, v) => { if (c === 'jump' && v) order.push('jump') }
  }
  const wind = new WindChargeTraversal(bot)
  const r = await wind.use({ pitchDeg: -45, direction: { x: 0, z: 1 } })
  assert.equal(r.ok, true)
  assert.deepEqual(order, ['equip', 'look', 'activateItem', 'jump'])
  assert.equal(wind.count(), 2)
  await new Promise((resolve) => setTimeout(resolve, 240)) // let the jump release
})

test('wind charge traverse chains charges while blocked and refuses with none', async () => {
  const bot = {
    entity: { position: pos(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'wind_charge', count: 3 }] }
  }
  const wind = new WindChargeTraversal(bot)
  wind.analyze = () => ({ kind: 'gap', pitchDeg: -45, direction: { x: 0, z: 1 } })
  let uses = 0
  wind.use = async () => { uses++; return { ok: true } }
  const r = await wind.traverse({ x: 0, z: 1 }, { maxChain: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.used, 2)
  assert.equal(uses, 2)

  const empty = new WindChargeTraversal({ entity: { position: pos(0, 64, 0) }, inventory: { items: () => [] } })
  const none = await empty.traverse({ x: 0, z: 1 })
  assert.equal(none.ok, false)
  assert.equal(none.why, 'no_charge')
})

// ======================================================== combat mechanics ==
test('weaponProfile maps held items to exact Goldilocks bands', () => {
  const sword = weaponProfile('diamond_sword')
  assert.equal(sword.min, 2.5)
  assert.equal(sword.max, 3.2)
  assert.equal(weaponProfile('netherite_axe').key, 'axe')
  const bow = weaponProfile('bow')
  assert.ok(bow.min >= 10 && bow.kind === 'ranged')
  const mace = weaponProfile('mace')
  assert.ok(mace.min >= 4, 'mace needs >4m jump setup')
  assert.ok(weaponProfile('crossbow').min >= 10)
  assert.equal(weaponProfile(null).key, 'fists')
  assert.equal(weaponProfile('trident').key, 'trident')
})

test('attack cooldown fills from vanilla attack speed and gates at 85%', () => {
  assert.equal(cooldownProgress(0, 1.6), 0)
  assert.equal(cooldownProgress(625, 1.6), 1)
  assert.ok(Math.abs(cooldownProgress(531.25, 1.6) - CRIT_THRESHOLD) < 1e-9)

  let t = 0
  const cd = new AttackCooldown({ now: () => t, profile: WEAPON_PROFILES.sword })
  cd.arm(WEAPON_PROFILES.sword)
  t = 100
  assert.equal(cd.ready(), false)
  t = 531.25
  assert.equal(cd.ready(), true)
  t = 625
  assert.equal(cd.progress(), 1)
})

test('classifyThreat tags airborne mace users and elytra spear/trident lunges', () => {
  const mace = classifyThreat({
    name: 'player',
    position: pos(0, 64, 3),
    onGround: false,
    velocity: { x: 0, y: 0.3, z: 0 },
    heldItem: { name: 'mace' }
  }, { botPos: pos(0, 64, 0) })
  assert.ok(mace.tags.includes('mace_airborne'))
  assert.equal(mace.airborne, true)

  const bow = classifyThreat({ name: 'skeleton', position: pos(0, 64, 12), heldItem: { name: 'bow' } }, { botPos: pos(0, 64, 0) })
  assert.ok(bow.tags.includes('ranged'))

  const lunge = classifyThreat({
    name: 'player',
    position: pos(0, 66, 5),
    onGround: false,
    velocity: { x: 0, y: -0.1, z: 0 },
    heldItem: { name: 'trident' },
    equipment: [{ name: 'trident' }, null, null, { name: 'elytra' }]
  }, { botPos: pos(0, 64, 0) })
  assert.ok(lunge.tags.includes('elytra_charge'), JSON.stringify(lunge.tags))

  const creeper = classifyThreat({ name: 'creeper', position: pos(1, 64, 0) }, { botPos: pos(0, 64, 0) })
  assert.ok(creeper.tags.includes('explosive'))
})

test('heldItemName reads equipment arrays from player entities', () => {
  assert.equal(heldItemName({ equipment: [{ name: 'iron_sword' }, null] }), 'iron_sword')
  assert.equal(heldItemName({ heldItem: { name: 'diamond_axe' } }), 'diamond_axe')
  assert.equal(heldItemName({}), '')
  assert.equal(heldItemName(null), '')
})

test('goldilocks melee backpedals when too close instead of pressing forward', () => {
  const { bot, target, controls } = combatFixture({ targetDist: 2.0 })
  const combat = new AdvancedCombat(bot, { now: () => 1000 })
  combat.state = 'melee'
  combat.target = target
  combat._tick()
  assert.equal(controls.back, true, 'inside the minimum band → backpedal')
  assert.equal(controls.forward, false)
  assert.equal(controls.left || controls.right, true, 'must still strafe')
})

test('combat refuses to swing before the cooldown indicator reaches 85%', () => {
  let t = 0
  const { bot, target, calls } = combatFixture({ targetDist: 3.0 })
  const combat = new AdvancedCombat(bot, { now: () => t })
  combat.state = 'melee'
  combat.target = target
  combat.cooldown.arm(WEAPON_PROFILES.fists) // just swung
  t = 120
  combat._tick()
  assert.equal(calls.attack, 0, 'spam-clicking is forbidden')
  assert.equal(combat.critArmed, false)

  t = 550
  combat._tick()
  assert.equal(combat.critArmed, true, 'ready swing arms the micro-jump crit')
  assert.ok(calls.jump >= 1)
})

test('melee crit jumps first and only attacks on the falling tick', () => {
  let t = 0
  const { bot, target, calls } = combatFixture({ targetDist: 3.0 })
  const combat = new AdvancedCombat(bot, { now: () => t })
  combat.state = 'melee'
  combat.target = target
  t = 600
  combat._tick() // arms the crit
  assert.equal(combat.critArmed, true)
  assert.equal(calls.attack, 0)

  // Mid-air, still rising: no crit yet.
  bot.entity.onGround = false
  bot.entity.velocity.y = 0.2
  t += 50
  combat._tick()
  assert.equal(calls.attack, 0, 'rising ticks are not crits')

  // Falling tick: swing exactly once.
  bot.entity.velocity.y = -0.18
  t += 50
  combat._tick()
  assert.equal(calls.attack, 1)
  assert.equal(combat.critArmed, false)
})

test('mace panic retreat sprints backwards and deploys a water bucket', () => {
  const { bot, target, controls } = combatFixture({
    targetDist: 4.0,
    inventoryItems: [{ name: 'water_bucket', count: 1 }]
  })
  target.heldItem = { name: 'mace' }
  target.onGround = false
  target.velocity = { x: 0, y: 0.35, z: 0 }
  const events = []
  const combat = new AdvancedCombat(bot, { now: () => 10_000, onEvent: (e) => events.push(e) })
  combat.state = 'melee'
  combat.target = target
  combat._tick()
  assert.equal(combat.state, 'retreat')
  assert.equal(controls.back, true)
  assert.equal(controls.sprint, true)
  assert.ok(events.some((e) => /panic retreat \(mace\)/.test(e.msg)), JSON.stringify(events))
})

test('ranged engagement backs off inside 10m and never fires an uncharged bow', () => {
  const { bot, target, controls, calls } = combatFixture({ held: 'bow', targetDist: 6 })
  const combat = new AdvancedCombat(bot, { now: () => 5000 })
  combat.state = 'approach'
  combat.target = target
  combat._tick()
  assert.equal(controls.back, true, 'bow band starts at 10m')
  assert.equal(controls.forward, false)
  assert.equal(calls.activate, 0, 'no drawing while retreating')
  assert.equal(calls.attack, 0)
})

// ============================================================ System 1 ring ==
test('System1 registers the elite tactical reflexes with the registry', () => {
  const registry = new ReflexRegistry()
  const s1 = new System1({ entity: null }, { registry, logger: { info () {}, warn () {}, debug () {} } })
  s1.registerBuiltins()
  const names = registry.list().map((r) => r.name)
  for (const expected of ['mace_panic_retreat', 'elytra_lunge_dodge', 'ranged_aim_strafe', 'melee_cooldown_pressure']) {
    assert.ok(names.includes(expected), `missing ${expected}: ${names.join(', ')}`)
  }
  const triggers = registry.list().map((r) => r.trigger)
  for (const t of ['mace_threat', 'elytra_lunge', 'ranged_threat', 'melee_window']) {
    assert.ok(triggers.includes(t), `missing trigger ${t}`)
  }
})

test('tacticalScan fires mace, elytra and ranged reflexes in lethality order', async () => {
  const maceUser = hostile(1, 0, 64, 4, {
    name: 'player',
    onGround: false,
    velocity: { x: 0, y: 0.3, z: 0 },
    heldItem: { name: 'mace' }
  })
  const lungeUser = hostile(2, 2, 66, 5, {
    name: 'player',
    onGround: false,
    velocity: { x: 0, y: -0.1, z: 0 },
    heldItem: { name: 'trident' },
    equipment: [{ name: 'trident' }, null, null, { name: 'elytra' }]
  })
  const archer = hostile(3, 0, 64, 12, { name: 'skeleton', heldItem: { name: 'bow' } })
  const bot = { entity: { position: pos(0, 64, 0) }, entities: { 1: maceUser, 2: lungeUser, 3: archer }, health: 20 }
  const registry = new ReflexRegistry()
  const logger = { info () {}, warn () {}, debug () {} }
  const s1 = new System1(bot, { registry, logger })
  const fired = []
  s1.panicRetreat = () => { fired.push('mace'); return 'panic' }
  s1.evadeLateral = () => { fired.push('elytra'); return 'lateral' }
  s1.strafeRanged = () => { fired.push('ranged'); return 'strafe' }
  s1.registerBuiltins()
  const results = await s1.tacticalScan(s1._ctx())
  assert.deepEqual(fired, ['mace', 'elytra', 'ranged'])
  assert.ok(results.length >= 3)
})

test('combatTick auto-engages safe melee mobs but never a creeper', async () => {
  const registry = new ReflexRegistry()
  const bot = { entity: { position: pos(0, 64, 0) }, entities: {}, health: 20 }
  const engaged = []
  const s1 = new System1(bot, {
    registry,
    logger: { info () {}, warn () {}, debug () {} },
    combat: {
      disengageAt: 6,
      isEngaged: false,
      engage: async (name) => { engaged.push(name); return { ok: true } },
      forceTick: () => { engaged.push('tick') }
    }
  })
  assert.equal(s1.combatTick({ entity: { name: 'zombie' } }), 'combat_engage')
  assert.deepEqual(engaged, ['zombie'])
  assert.equal(s1.combatTick({ entity: { name: 'creeper' } }), 'combat_tick')
  assert.deepEqual(engaged, ['zombie', 'tick'], 'explosive mobs are never auto-engaged')
})

// ===================================================== Scout & Relocate ====
test('scoutSafeAnchor picks ground away from mobs and findGroundY lands on the floor', () => {
  const bot = {
    entity: { position: pos(0, 64, 0) },
    entities: { 1: hostile(1, 0, 64, 4) },
    blockAt: (v) => {
      const y = Math.round(v.y)
      if (y === 63) return solid('grass_block')
      return air()
    }
  }
  const anchor = scoutSafeAnchor(bot, { radius: 12, step: 3, minRadius: 4, preferRadius: 9 })
  assert.ok(anchor, 'expected a candidate')
  assert.equal(anchor.threats, 1)
  assert.ok(anchor.z < 0, `anchor must move away from the mob at +z, got ${anchor.z}`)
  assert.equal(anchor.y, 64)
  assert.equal(findGroundY(bot, 6, -6), 64)
})

test('scoutSafeAnchor refuses hazard cells and needs a live entity', () => {
  assert.equal(scoutSafeAnchor({}), null)
  const bot = {
    entity: { position: pos(0, 64, 0) },
    entities: {},
    blockAt: (v) => {
      const y = Math.round(v.y)
      const x = Math.round(v.x)
      // A lava sheet at standing height on the +x half: unstandable + hazardous.
      if (y === 63) return solid('netherrack')
      // Lava is a hazard with an EMPTY bounding box (you sink, you don't stand).
      if (y === 64 && x > 0) return solid('lava', 'empty')
      return air()
    }
  }
  const anchor = scoutSafeAnchor(bot, { radius: 12, step: 3, minRadius: 4, preferRadius: 8 })
  assert.ok(anchor)
  assert.ok(!anchor.reasons.includes('hazard nearby'), `chose a hazard: ${JSON.stringify(anchor)}`)
  assert.ok(anchor.x <= 0, `must stay off the lava half, got x=${anchor.x}`)
})

// ================================================== semantic perception ====
test('clusterBlocks compresses block vomit into ranked material shares', () => {
  const blocks = [
    ...Array(6).fill({ name: 'stone_bricks' }),
    ...Array(3).fill({ name: 'oak_planks' }),
    { name: 'glass' },
    { name: 'air' }
  ]
  const out = clusterBlocks(blocks, { top: 3 })
  assert.equal(out.total, 10, 'air is never material')
  assert.equal(out.materials[0].category, 'stone')
  assert.equal(out.materials[0].count, 6)
  assert.ok(out.text.includes('%'))
  assert.equal(categorizeBlock('oak_log'), 'wood')
  assert.equal(categorizeBlock('barrel'), 'storage')
})

test('detectStructures recognizes houses, storage, farms, towers and portals', () => {
  const house = []
  for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
    if (dx === 0 || dz === 0 || dx === 4 || dz === 4) house.push({ dx, dy: 1, dz, name: 'stone_bricks' })
  }
  house.push({ dx: 2, dy: 1, dz: 0, name: 'oak_door' })
  for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) house.push({ dx, dy: 3, dz, name: 'oak_stairs' })
  for (let i = 0; i < 5; i++) house.push({ dx: 6 + i, dy: 0, dz: 6, name: 'barrel' })
  const kinds = detectStructures(house).map((s) => s.kind)
  assert.ok(kinds.includes('house'), JSON.stringify(kinds))
  assert.ok(kinds.includes('storage'), JSON.stringify(kinds))

  const tower = []
  for (let dy = 0; dy <= 8; dy++) tower.push({ dx: 0, dy, dz: 0, name: 'deepslate_bricks' })
  for (let dx = 1; dx <= 2; dx++) for (let dy = 0; dy <= 2; dy++) tower.push({ dx, dy, dz: 0, name: 'deepslate_bricks' })
  assert.ok(detectStructures(tower).some((s) => s.kind === 'tower'))

  const farm = [
    ...Array(6).fill({ dx: 0, dy: 0, dz: 0, name: 'wheat' }),
    { dx: 1, dy: 0, dz: 0, name: 'farmland' },
    { dx: 2, dy: 0, dz: 0, name: 'water' }
  ]
  assert.ok(detectStructures(farm).some((s) => s.kind === 'farm'))

  const portal = Array.from({ length: 10 }, (_, i) => ({ dx: i, dy: 0, dz: 0, name: i === 0 ? 'nether_portal' : 'obsidian' }))
  assert.ok(detectStructures(portal).some((s) => s.kind === 'portal'))
})

// ============================================================ phased build ==
test('decomposePhases is lossless and normalizeStage accepts the phase vocabulary', () => {
  const blocks = [
    { dx: 0, dy: 0, dz: 0, name: 'stone' },
    { dx: 1, dy: 0, dz: 0, name: 'stone' },
    { dx: 0, dy: 1, dz: 0, name: 'stone' },
    { dx: 1, dy: 1, dz: 0, name: 'glass' }, // detailing even at wall height
    { dx: 0, dy: 2, dz: 0, name: 'stone' },
    { dx: 0, dy: 5, dz: 0, name: 'stone' },
    { dx: 0, dy: 6, dz: 0, name: 'oak_stairs' } // roof band
  ]
  const phases = decomposePhases(blocks)
  const total = PHASE_ORDER.reduce((n, p) => n + phases[p].length, 0)
  assert.equal(total, blocks.length)
  assert.ok(phases.foundation.every((b) => b.dy === 0))
  assert.ok(phases.detailing.some((b) => b.name === 'glass'))
  assert.ok(phases.roof.length >= 1)

  assert.equal(normalizeStage('foundation'), 'foundation')
  assert.equal(normalizeStage('walls_with_windows'), 'walls')
  assert.equal(normalizeStage('interior_details'), 'detailing')
  assert.equal(normalizeStage('detailing'), 'detailing')
  assert.equal(normalizeStage('foundation2'), null)
})

test('builder is idempotent and stage-filtered: existing blocks are never re-placed', async () => {
  const { Vec3 } = require('vec3')
  const placed = []
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    blockAt: (v) => ({ name: 'stone', position: v }),
    dig: async () => {},
    placeBlock: async (ref) => { placed.push(ref) },
    pathfinder: { setGoal () {} }
  }
  const executor = new BuilderExecutor(bot, { scaffoldBlocks: ['dirt'], logger: () => {} })
  const plan = {
    steps: [
      { x: 0, y: 64, z: 1, name: 'stone', phase: 'foundation' },
      { x: 1, y: 64, z: 1, name: 'stone', phase: 'foundation' },
      { x: 0, y: 66, z: 1, name: 'stone', phase: 'roof' }
    ]
  }
  const res = await executor.build(plan, { stage: 'foundation' })
  assert.equal(res.stage, 'foundation')
  assert.equal(res.placed, 2)
  assert.equal(res.alreadyPresent, 2, 'world already matched → idempotent skip')
  assert.equal(res.skipped.length, 0)
  assert.equal(placed.length, 0, 'no packets for blocks that already exist')

  const roof = await executor.build(plan, { stage: 'roof' })
  assert.equal(roof.placed, 1, 'stage filter only visits roof cells')
  assert.equal(roof.alreadyPresent, 1)
})

// ========================================================== vanilla guard ==
test('vanilla guard blocks slash-commands in chat and command-shaped actions', () => {
  assert.equal(isCommandLine('/tp 0 0 0'), true)
  assert.equal(isCommandLine('  /setworldspawn'), true)
  assert.equal(isCommandLine('hello there'), false)

  const sent = []
  const bot = { chat (m) { sent.push(m) }, emit () {} }
  const guard = installVanillaGuard(bot, { logger: { info () {}, warn () {} } })
  bot.chat('gg')
  assert.equal(bot.chat('/tp ZincAI 0 100 0'), false)
  assert.equal(guard.blocked, 1)
  assert.deepEqual(sent, ['gg'], 'only the legitimate line reaches the wire')

  assert.equal(assertVanillaAction({ a: 'say', t: '/give @p diamond' }).ok, false)
  assert.equal(assertVanillaAction({ a: 'move', command: 'tp' }).ok, false)
  assert.equal(assertVanillaAction({ a: 'move', x: 1, y: 64, z: 2 }).ok, true)
})

// ============================================================== system prompt
test('system prompt enforces phased building, auto-tool offloading and vanilla-only play', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  assert.ok(prompt.includes('The harness automatically equips the optimal tool, manages attack cooldowns, and handles mitigation. You only decide WHAT to build, mine, or fight, never HOW to equip or swing.'))
  for (const phase of ['foundation', 'walls_with_windows', 'roof', 'interior_details']) {
    assert.ok(prompt.includes(phase), `prompt missing phase ${phase}`)
  }
  assert.ok(/no commands/i.test(prompt))
  assert.ok(/native tools/i.test(prompt))
  assert.ok(prompt.length < 4500, 'prompt must stay lean for KV-cache economy')
})

