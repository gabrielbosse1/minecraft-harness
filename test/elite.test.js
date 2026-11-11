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
  forecastImpact,
  closestApproach,
  heldItemName,
  CRIT_THRESHOLD
} = require('../src/combat')
const { System1 } = require('../zincai/system1')
const { ReflexRegistry } = require('../zincai/reflex_registry')
const { makeBot, ent, sleep: wait, heldKeys } = require('./helpers/mockbot')
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

  // Teleport/knockback deltas are speed-clamped — no phantom 40-block threats.
  const warped = threatBot({ 2: hostile(2, 0, 64, 3, { velocity: { x: 0, y: 0, z: 5 } }) })
  const clamped = new PredictiveThreatMap()
  clamped.sample(warped, true)
  assert.ok(clamped.threats[0].speed <= 1.0001, `speed clamp failed: ${clamped.threats[0].speed}`)

  // Vertical projection is gravity-clamped to ±3 blocks.
  const jumper = threatBot({ 4: hostile(4, 0, 64, 3, { velocity: { x: 0, y: 5, z: 0 } }) })
  const jmap = new PredictiveThreatMap()
  jmap.sample(jumper, true)
  assert.ok(jmap.threats[0].future.y <= 67.0001, `vertical clamp failed: ${jmap.threats[0].future.y}`)

  // Hostile players are opt-in.
  const pvpBot = threatBot({
    3: { id: 3, name: 'player', type: 'player', position: pos(0, 64, 4), velocity: { x: 0, y: 0, z: 0 }, heldItem: { name: 'mace' } }
  })
  assert.equal(new PredictiveThreatMap().sample(pvpBot, true).length, 0)
  assert.equal(new PredictiveThreatMap({ includePlayers: true }).sample(pvpBot, true).length, 1)
})

test('costAt penalizes the projected kill sphere, not empty ground', () => {
  const map = new PredictiveThreatMap()
  const bot = threatBot({ 1: hostile(1, 0, 64, 6, { velocity: { x: 0, y: 0, z: 0.05 } }) })
  map.sample(bot, true)
  const future = map.threats[0].future
  assert.ok(map.costAt({ x: future.x, y: future.y, z: future.z }) > 10)
  assert.equal(map.costAt({ x: 30, y: 64, z: -30 }), 0)
})

test('threat cost is charged once per A* move and never around the bot itself', () => {
  const map = new PredictiveThreatMap()
  const bot = threatBot({ 1: hostile(1, 0, 64, 8) })
  map.sample(bot, true)
  // A node on the straight line between the zombie and the bot costs…
  assert.ok(map.costAt({ x: 0, y: 64, z: 5 }) > 0, 'corridor node must cost')
  // …but every corridor ends on the bot, so the last 3 blocks are left free:
  // otherwise the cells around the bot are the most expensive on the map.
  assert.equal(map.costAt({ x: 0, y: 64, z: 1 }), 0)

  // The cost is added to each candidate move AFTER upstream built it — once,
  // not per touched block (upstream discards any move that reaches 100).
  const neighbors = () => [{ x: 0, y: 64, z: 5, cost: 1 }, { x: 40, y: 64, z: 40, cost: 1 }]
  const movements = { getNeighbors: neighbors }
  assert.equal(map.attachToMovements(movements), true)
  const out = movements.getNeighbors({ x: 0, y: 64, z: 4 })
  assert.ok(out[0].cost > 1, 'threatened cell costs more')
  assert.ok(out[0].cost <= 1 + map.maxPenalty, 'and never more than one capped penalty')
  assert.equal(out[1].cost, 1, 'safe cell is untouched')
  // Idempotent attach — never stack the wrapper.
  map.attachToMovements(movements)
  assert.equal(movements.getNeighbors({ x: 0, y: 64, z: 4 })[0].cost, out[0].cost)
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
test('weaponProfile maps held items to vanilla reach, bands and attack speeds', () => {
  const sword = weaponProfile('diamond_sword')
  assert.equal(sword.min, 2.0)
  assert.equal(sword.max, 2.9)
  assert.equal(sword.reach, 3.0, 'survival reach is 3 blocks')
  assert.equal(weaponProfile('netherite_axe').key, 'axe')
  // Axe speed depends on the material in vanilla.
  assert.equal(weaponProfile('stone_axe').aps, 0.8)
  assert.equal(weaponProfile('iron_axe').aps, 0.9)
  assert.equal(weaponProfile('netherite_axe').aps, 1.0)
  const bow = weaponProfile('bow')
  assert.ok(bow.min >= 10 && bow.kind === 'ranged')
  assert.ok(weaponProfile('mace').reach <= 3.0, 'a mace has no extra reach')
  assert.ok(weaponProfile('crossbow').min >= 10)
  assert.equal(weaponProfile(null).key, 'fists')
  assert.equal(weaponProfile('trident').key, 'trident')
  assert.equal(weaponProfile('bowl').key, 'fists', '"bowl" is not a bow')
})

test('attack cooldown fills from vanilla attack speed and gates at a FULL indicator', () => {
  assert.equal(cooldownProgress(0, 1.6), 0)
  assert.equal(cooldownProgress(625, 1.6), 1)
  // Vanilla cannot crit below 90 % and scales damage down: wait for 100 %.
  assert.equal(CRIT_THRESHOLD, 1)

  let t = 0
  const cd = new AttackCooldown({ now: () => t, profile: WEAPON_PROFILES.sword })
  cd.arm(WEAPON_PROFILES.sword)
  t = 100
  assert.equal(cd.ready(), false)
  t = 531.25
  assert.equal(cd.ready(), false, '85 % is not enough')
  t = 625
  assert.equal(cd.progress(), 1)
  assert.equal(cd.ready(), true)
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

test('goldilocks melee backpedals when too close — without sprinting backwards', () => {
  const { bot, target, controls } = combatFixture({ targetDist: 1.4 })
  const combat = new AdvancedCombat(bot, { now: () => 1000 })
  combat.state = 'melee'
  combat.target = target
  combat._tick()
  assert.equal(controls.back, true, 'inside the minimum band → backpedal')
  assert.equal(controls.forward, false)
  assert.equal(controls.left || controls.right, true, 'must still strafe')
  assert.ok(!controls.sprint, 'a real client cannot sprint backwards or sideways')
})

test('combat refuses to swing before the cooldown indicator is full', () => {
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
  assert.equal(combat.critArmed, false, '88 % of a sword swing is still too early')

  t = 700
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

test('mace: a hop is ignored, a real dive is dodged before it lands — and no water is dumped', () => {
  let t = 10_000
  const { bot, target, controls, calls } = combatFixture({
    targetDist: 3.4,
    inventoryItems: [{ name: 'water_bucket', count: 1 }]
  })
  Object.assign(target, { type: 'player', name: 'player', username: 'Gabriel', heldItem: { name: 'mace' } })
  const events = []
  const combat = new AdvancedCombat(bot, { now: () => t, onEvent: (e) => events.push(e) })
  combat.state = 'melee'
  combat.target = target
  const step = (y) => { t += 50; target.position = pos(0, y, 3.4); combat._tick() }
  const dodges = () => events.filter((e) => /dodged|braced|broke away/.test(e.msg))

  // Standing there with a mace is not a threat (mineflayer reports onGround
  // true for everyone else, forever).
  combat._tick()
  step(64)
  assert.equal(combat.state, 'melee', 'a held mace alone must not trigger anything')

  // A hop on the spot: up 1.25 blocks and down again. The old trigger was
  // "mace in hand and any vertical motion", so every hop sent the bot running.
  let y = 64
  let v = 0.42
  for (let i = 0; i < 14; i++) { y = Math.max(64, y + v); v = (v - 0.08) * 0.98; step(y); if (y === 64) break }
  assert.equal(combat.state, 'melee', 'a jump is not a mace smash')
  assert.equal(dodges().length, 0)

  // A real dive from 8 blocks up, coming down next to the bot.
  y = 72
  v = 0
  step(y)
  let dodgedAt = null
  for (let i = 0; i < 40 && y > 64; i++) {
    v = (v - 0.08) * 0.98
    y = Math.max(64, y + v)
    step(y)
    if (dodgedAt === null && combat.state === 'retreat') dodgedAt = y
  }
  assert.ok(dodgedAt !== null, 'the dive is dodged')
  assert.ok(dodgedAt - 64 >= 2, `…while the attacker is still well above the ground (y ${dodgedAt})`)
  assert.equal(controls.forward, true, 'turns away and runs forward')
  assert.equal(controls.sprint, true)
  assert.ok(!controls.back, 'no sprinting backwards')
  assert.equal(calls.activate, 0, 'no water bucket is emptied on the floor')
  assert.ok(dodges().some((e) => /dodged Gabriel's mace smash/.test(e.msg)), JSON.stringify(events))
})

test('forecastImpact: stairs and hops are nothing; a glide on a hitting line is a charge', () => {
  const me = { position: pos(0, 64, 0), velocity: { x: 0, y: 0, z: 0 } }
  const mace = { position: pos(0, 66, 2), heldItem: { name: 'mace' } }
  // Walking down a staircase: steady slow descent, each step resets the fall.
  assert.equal(forecastImpact(mace, me, { vx: 0, vy: -0.2, vz: -0.2, falling: true, fallen: 0.5 }), null)
  // The end of an ordinary jump: fast, but only 1.25 blocks of fall.
  assert.equal(forecastImpact(mace, me, { vx: 0, vy: -0.44, vz: 0, falling: true, fallen: 1.25 }), null)
  // A real fall onto the bot.
  const smash = forecastImpact(mace, me, { vx: 0, vy: -0.6, vz: -0.1, falling: true, fallen: 2.4 })
  assert.equal(smash.kind, 'smash')
  assert.ok(smash.inSec > 0 && smash.inSec < 0.5, `lands in ${smash.inSec}s`)
  // The same fall, but coming down 8 blocks away: not our problem.
  assert.equal(forecastImpact({ position: pos(0, 66, 8), heldItem: { name: 'mace' } }, me, { vx: 0, vy: -0.6, vz: 0, falling: true, fallen: 2.4 }), null)

  // A level glide at head height with a spear, 20 m/s straight at the bot, 12 blocks out.
  const glider = { position: pos(0, 65, 12), heldItem: { name: 'iron_spear' } }
  const level = { vx: 0, vy: 0, vz: -1.0, falling: false, fallen: 0 }
  const charge = forecastImpact(glider, me, level, { gliding: true })
  assert.equal(charge.kind, 'charge', 'no vertical speed needed (the old trigger wanted some)')
  assert.ok(charge.inSec > 0.5 && charge.inSec <= 0.9, `impact in ${charge.inSec}s — acted on with time to move`)
  // The same glide passing 6 blocks to the side is left alone.
  assert.equal(forecastImpact({ position: pos(6, 65, 12), heldItem: { name: 'iron_spear' } }, me, level, { gliding: true }), null)
  // A spear driven in on foot (item in use), walking speed.
  const lunge = forecastImpact({ position: pos(0, 64, 3), heldItem: { name: 'iron_spear' } }, me, { vx: 0, vy: 0, vz: -0.22, falling: false, fallen: 0 }, { usingItem: true })
  assert.equal(lunge.kind, 'charge')
  // Somebody merely running at the bot with a sword is ordinary melee.
  assert.equal(forecastImpact({ position: pos(0, 64, 4), heldItem: { name: 'diamond_sword' } }, me, { vx: 0, vy: 0, vz: -0.28, falling: false, fallen: 0 }), null)
  const ca = closestApproach({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -20 })
  assert.ok(Math.abs(ca.t - 0.5) < 1e-9 && ca.miss < 1e-9)
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
test('System1 built-ins are survival only: flee, eat, fall protection, swim', () => {
  const registry = new ReflexRegistry()
  const s1 = new System1({ entity: null }, { registry, logger: { info () {}, warn () {}, debug () {} } })
  s1.registerBuiltins()
  const list = registry.list()
  const names = list.map((r) => r.name)
  for (const expected of ['flee_from_threats', 'eat_when_hungry', 'heal_when_hurt', 'water_bucket_on_long_fall', 'glide_on_long_fall', 'swim_up']) {
    assert.ok(names.includes(expected), `missing ${expected}: ${names.join(', ')}`)
  }
  // Nothing a reflex can do starts a fight.
  for (const r of list) assert.ok(!/attack|pvp|combat|engage/.test(r.action), `${r.name} must not attack`)
  for (const action of ['engage_pvp', 'combat_tick', 'panic_retreat', 'strafe_ranged']) {
    assert.throws(() => registry.register({ name: 'x', trigger: 'threat_near', action }), /action must be one of/)
  }
})

test('a player holding a bow, a mace or a bowl is not a threat; neither is an armor stand', async () => {
  for (const item of ['bow', 'crossbow', 'mace', 'bowl', 'trident']) {
    const bot = makeBot({ items: [{ name: 'iron_sword' }, { name: 'water_bucket' }], held: 'iron_sword' })
    const friend = ent(2, 'player', 4.5, 0.5, { username: 'Gabriel' })
    friend.equipment[0] = { name: item }
    friend.equipment[4] = { name: 'elytra' }
    bot.entities[2] = friend
    const stand = ent(3, 'armor_stand', 0.5, 3.5)
    stand.equipment[0] = { name: 'bow' }
    bot.entities[3] = stand
    const s1 = new System1(bot, { registry: new ReflexRegistry(), logger: { info () {}, warn () {}, debug () {} } })
    s1.registerBuiltins()
    for (let i = 0; i < 4; i++) await s1.tick()
    assert.equal(heldKeys(bot), '(none)', `no key may be pressed for a friend holding ${item}`)
    assert.equal(bot.log.setGoal.length, 0)
    assert.equal(bot.log.activate, 0)
    assert.equal(bot.log.attack.length, 0)
    s1.stop()
  }
})

test('reflexes never fight: a zombie in reach makes the bot run, and the keys are released after', async () => {
  const bot = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  bot.entities[5] = ent(5, 'zombie', 0.5, 3.0)
  const events = []
  const s1 = new System1(bot, {
    registry: new ReflexRegistry(),
    logger: { info () {}, warn () {}, debug () {} },
    calmMs: 600,
    onEvent: (e) => events.push(e)
  })
  s1.registerBuiltins()
  for (let i = 0; i < 5; i++) { await s1.tick(); await wait(20) }
  assert.equal(bot.log.attack.length, 0, 'no swing without the model')
  assert.equal(s1.fleeing, true)
  assert.equal(heldKeys(bot), 'forward+jump+sprint', 'runs away (no forward+back tug of war)')
  // The zombie is to the south (+z): the bot must face north (yaw 0).
  assert.ok(Math.abs(bot.entity.yaw) < 0.2, `faces away from the zombie, yaw=${bot.entity.yaw}`)
  assert.ok(events.some((e) => e.type === 'threat' && e.wake && /started FLEEING/.test(e.text) && /zombie/.test(e.text)), 'the model is told')
  assert.match(s1.reflexLine(), /^FLEEING for \d+s from zombie/, 'and every prompt can say what the body is doing')

  delete bot.entities[5]
  await s1.tick()
  // Nothing follows: the keys are let go at once, but the escape is only
  // declared over after the calm period (no "safe" / "fleeing" flip-flop).
  assert.equal(heldKeys(bot), '(none)', 'stops and looks back as soon as nothing follows')
  assert.equal(s1.fleeing, true, 'still inside the calm period')
  await wait(650)
  await s1.tick()
  assert.equal(s1.fleeing, false)
  assert.equal(heldKeys(bot), '(none)', 'nothing stays held')
  const safe = events.find((e) => e.type === 'safe')
  assert.ok(safe && /safe again — fled \d+s from zombie/.test(safe.text), 'the end is reported with what happened')
  assert.match(s1.reflexLine(), /ago you FLED by reflex for \d+s from zombie/, 'the escape stays known afterwards')
  s1.stop()
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

  // Cliff half: no floor at z <= -6, mob behind it → anchor must stay inland.
  const cliffBot = {
    entity: { position: pos(0, 64, 0) },
    entities: { 1: hostile(1, 0, 64, -12) },
    blockAt: (v) => {
      const y = Math.round(v.y)
      const z = Math.round(v.z)
      if (y === 63 && z >= -6) return solid('grass_block')
      return air()
    }
  }
  const inland = scoutSafeAnchor(cliffBot, { radius: 12, step: 3, minRadius: 4, preferRadius: 8 })
  assert.ok(inland && inland.z > 0, `cliff half must be rejected, got ${JSON.stringify(inland)}`)
  assert.ok(!inland.reasons.includes('ledge nearby'))

  // Death-point blacklist: the next-best cell must be >= radius away.
  const avoided = [{ x: inland.x, y: inland.y, z: inland.z, radius: 6 }]
  const next = scoutSafeAnchor(cliffBot, { radius: 12, step: 3, minRadius: 4, preferRadius: 8, avoid: avoided })
  assert.ok(next, 'avoid list must not empty the search')
  assert.ok(Math.hypot(next.x - inland.x, next.z - inland.z) >= 6, 'must not re-anchor on the death point')
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
test('prompts: flee-first policy, phased building, vanilla-only, PT-BR voice', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  assert.ok(prompt.includes('The harness automatically equips the optimal tool and manages attack cooldowns.'))
  for (const phase of ['foundation', 'walls_with_windows', 'roof', 'interior_details']) {
    assert.ok(prompt.includes(phase), `prompt missing phase ${phase}`)
  }
  assert.ok(/no commands/i.test(prompt))
  assert.ok(/native tools/i.test(prompt))
  assert.ok(/reflex is to FLEE/.test(prompt), 'the model must know fleeing is the default')
  assert.ok(/Only you can start a fight/.test(prompt))
  assert.ok(/never attack a player unless/i.test(prompt))
  assert.ok(!/auto-engages players/i.test(prompt), 'the old false claim is gone')
  assert.ok(/you are a bot/i.test(prompt), 'one honest answer to "are you a bot?"')
  assert.ok(prompt.length < 4500, 'prompt must stay lean for KV-cache economy')

  // The body's own doing is something the model is told about, in both prompts.
  assert.ok(/reflex: what your body did BY ITSELF/.test(prompt), 'the model is told what the reflex line is')
  assert.ok(/only PAUSE/.test(prompt), 'short jobs no longer cancel the long task')
  assert.ok(/ALWAYS write in informal Brazilian Portuguese/.test(prompt))

  const chat = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'chat_prompt.txt'), 'utf8')
  assert.ok(/ALWAYS answer in informal Brazilian Portuguese/.test(chat))
  assert.ok(!/language of the message/.test(chat), 'the server speaks PT-BR whatever the message is written in')
  assert.ok(/Keep the accents/.test(chat))
  assert.ok(/You are a bot/.test(chat))
  assert.ok(/reflex line is what your body did by itself/.test(chat), 'the voice knows when the body is fleeing')
  assert.ok(/`remember`/.test(chat), 'the voice can write a memory')
})

