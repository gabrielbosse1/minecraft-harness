/**
 * Regression tests for the audit findings.
 *
 * Each test pins one thing that used to go wrong, using the shipped modules
 * against a mock bot or — for pathfinding — the REAL mineflayer-pathfinder
 * A* on a synthetic world (test/helpers). No server, no network.
 *
 * Owner policy under test: the bot never starts a fight, never attacks a
 * player unless the model names one, and flees from every real threat until
 * the model decides.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn']) logger[level] = () => {}

const world = require('./helpers/world')
const { makeBot, ent, sleep, heldKeys, Vec3 } = require('./helpers/mockbot')
const { ControlArbiter, PRIORITY, directHands } = require('../zincai/control')
const { ThreatSense, isProtected, hasLineOfSight, bearing, whereIs } = require('../zincai/threats')
const { PredictiveThreatMap, PathfinderWrapper, WindChargeTraversal } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { AdvancedCombat, classifyThreat, MotionTracker } = require('../src/combat')
const { AntiStuckWatchdog } = require('../src/watchdog')
const { ElytraController } = require('../src/elytra')
const { System1, chooseFood, FOOD_RE } = require('../zincai/system1')
const { ReflexRegistry, runScript } = require('../zincai/reflex_registry')
const { MemorySystem, tokenize } = require('../zincai/memory')
const { PlaceIndex, kindOf } = require('../zincai/places')
const { Brain } = require('../zincai/brain')
const { installVanillaGuard } = require('../zincai/vanilla_guard')
const observe = require('../zincai/observe')

const quiet = { debug () {}, info () {}, warn () {}, error () {} }

/** Iron bars across z = 2 (y 64..66): a cage wall between the bot and +z. */
const barsAtZ2 = (p) => {
  const y = Math.floor(p.y); const z = Math.floor(p.z)
  if (y < 64) return { name: 'stone', boundingBox: 'block' }
  if (z === 2 && y <= 66) return { name: 'iron_bars', boundingBox: 'block' }
  return { name: 'air', boundingBox: 'empty' }
}

// ============================================================ control ====

test('arbiter: the highest lane drives; a released lane lets go of everything and the lower one resumes', () => {
  const bot = makeBot()
  let t = 0
  const arbiter = new ControlArbiter(bot, { now: () => t })
  const task = arbiter.lane('task', PRIORITY.task)
  const survival = arbiter.lane('survival', PRIORITY.survival)
  const seen = []
  arbiter.on('preempt', (e) => seen.push(`preempt:${e.lane}<-${e.by}`))
  arbiter.on('resume', (e) => seen.push(`resume:${e.lane}`))

  const move = { id: 'move' }
  const flee = { id: 'flee' }
  task.acquire()
  task.setGoal(move)
  assert.equal(bot.pathfinder.goal, move)

  survival.acquire({ ttlMs: 1000, reason: 'flee' })
  survival.setGoal(flee)
  survival.setControlState('sprint', true)
  assert.equal(bot.pathfinder.goal, flee)
  assert.equal(heldKeys(bot), 'sprint')

  // The preempted lane keeps recording what it wants, but nothing is applied.
  task.setControlState('back', true)
  assert.equal(heldKeys(bot), 'sprint', 'no forward+back tug of war')

  // TTL: a reflex that stops renewing cannot hold a key forever.
  t = 1500
  arbiter.tick()
  assert.equal(bot.pathfinder.goal, move, 'the interrupted goal resumes')
  assert.equal(heldKeys(bot), 'back', 'sprint was released with its lane')
  assert.deepEqual(seen, ['preempt:task<-survival', 'resume:task'])

  task.release()
  assert.equal(bot.pathfinder.goal, null)
  assert.equal(heldKeys(bot), '(none)')
})

test('arbiter.useHand puts the held item back and refuses a second borrower', async () => {
  const sword = { name: 'iron_sword' }
  const bread = { name: 'bread' }
  const bot = makeBot({ items: [sword, bread], held: 'iron_sword' })
  const arbiter = new ControlArbiter(bot)
  let inside = null
  const first = arbiter.useHand('eat', bread, async () => {
    inside = await arbiter.useHand('other', bread, async () => 1, { priority: PRIORITY.task })
    return 'ate'
  }, { priority: PRIORITY.survival })
  const r = await first
  assert.deepEqual(r, { ok: true, value: 'ate' })
  assert.deepEqual(inside, { ok: false, why: 'hand_busy' })
  assert.equal(bot.heldItem.name, 'iron_sword', 'the sword is back in hand')
})

// ============================================================ threats ====

test('threats: what is and is not a threat', () => {
  // Open ground: a zombie 5 blocks away is a threat.
  const open = makeBot()
  open.entities[5] = ent(5, 'zombie', 0.5, 5.5)
  assert.equal(new ThreatSense(open).assess().threats.length, 1)

  // Same zombie behind iron bars: not a threat (caged, exhibit, farm).
  const caged = makeBot({ blockAt: barsAtZ2 })
  caged.entities[5] = ent(5, 'zombie', 0.5, 5.5)
  assert.equal(hasLineOfSight(caged, caged.entities[5]), false)
  assert.equal(new ThreatSense(caged).assess().threats.length, 0)

  // …unless it CAN walk around the bars.
  const reachable = new ThreatSense(caged, { reachable: () => true })
  assert.equal(reachable.assess().threats.length, 1)

  // A skeleton behind bars cannot shoot through them either.
  caged.entities[6] = ent(6, 'skeleton', 0.5, 9.5)
  assert.equal(new ThreatSense(caged).assess().threats.length, 0)

  // A creeper with a lit fuse nearby is ALWAYS a threat, bars or not.
  caged.entities[7] = ent(7, 'creeper', 0.5, 4.5, { metadata: Object.assign([], { 16: 1 }) })
  const lit = new ThreatSense(caged).assess().threats
  assert.equal(lit.length, 1)
  assert.equal(lit[0].hard, true)
  assert.equal(lit[0].lit, true)

  // Decor and name-tagged mobs never are.
  const decor = makeBot()
  decor.entities[1] = ent(8, 'armor_stand', 0.5, 2.5)
  decor.entities[2] = ent(9, 'item_frame', 1.5, 2.5)
  decor.entities[3] = ent(10, 'zombie', 0.5, 3.5, { metadata: Object.assign([], { 2: 'Bob' }) })
  decor.entities[4] = ent(11, 'skeleton_horse', 2.5, 2.5)
  decor.entities[5] = ent(12, 'zombified_piglin', 2.5, 0.5)
  assert.equal(new ThreatSense(decor).assess().threats.length, 0)
})

test('threats: a player is never a threat until they actually hit the bot', () => {
  let t = 0
  const bot = makeBot()
  const friend = ent(2, 'player', 3.5, 0.5, { username: 'Gabriel' })
  friend.equipment[0] = { name: 'mace' }
  bot.entities[2] = friend
  const sense = new ThreatSense(bot, { now: () => t, attackerMemoryMs: 15_000 })
  assert.equal(sense.assess().threats.length, 0, 'holding a mace next to the bot means nothing')

  assert.equal(sense.noteAttacker(friend), 'Gabriel')
  const hit = sense.assess().threats
  assert.equal(hit.length, 1)
  assert.equal(hit[0].kind, 'player')
  assert.match(sense.describe(), /Gabriel \(3m E; player, hit you\)/)

  t = 16_000 // …and it wears off.
  assert.equal(sense.assess().threats.length, 0)
})

test('threats: damage is explained, not always "attacked"', () => {
  const bot = makeBot()
  const sense = new ThreatSense(bot)
  bot.food = 0
  assert.equal(sense.damageCause(null).cause, 'starving')
  bot.food = 20
  bot.entity.velocity.y = -1.1
  sense.trackMotion()
  assert.equal(sense.damageCause(null).cause, 'fall')
  const g = ent(2, 'player', 2.5, 0.5, { username: 'Gabriel' })
  assert.deepEqual(sense.damageCause(g), { cause: 'player', text: 'hit by player Gabriel', attacker: 'Gabriel' })
  assert.equal(sense.damageCause(ent(3, 'zombie', 1.5, 0.5)).text, 'hit by zombie')
})

test('threats: compass directions use the real axes (north = -z, east = +x)', () => {
  const me = { x: 0, y: 64, z: 0 }
  assert.equal(bearing(me, { x: 0, z: -5 }), 'N')
  assert.equal(bearing(me, { x: 5, z: 0 }), 'E')
  assert.equal(bearing(me, { x: 0, z: 5 }), 'S')
  assert.equal(bearing(me, { x: -5, z: -5 }), 'NW')
  assert.equal(whereIs(me, { x: 0, y: 70, z: 8 }), '10m S, 6 up')
})

// ===================================================== pathfinding (real A*) ==

function ringWorld (n, d) {
  const bot = world.makeWorld()
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    world.addApproaching(bot, 10 + i, 'zombie', 0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d)
  }
  const movements = new world.Movements(bot)
  const wrapper = new PathfinderWrapper(Object.assign(bot, { on () {}, pathfinder: { movements } }), { enableWindCharge: false })
  wrapper.configureMovements(movements)
  return { bot, movements, wrapper }
}

test('surrounded: A* still finds a way out (the old cost hook made every move "impossible")', () => {
  for (const [n, d] of [[6, 5], [8, 6], [8, 10], [12, 8], [20, 6], [40, 10]]) {
    const { bot, movements, wrapper } = ringWorld(n, d)
    const plan = wrapper.fleePlan()
    assert.ok(plan, `ring of ${n} at ${d}: a flee plan exists`)
    const r = world.plan(bot, movements, plan.goal)
    assert.equal(r.status, 'success', `ring of ${n} at ${d} blocks`)
    assert.ok(r.path.length > 0)
    assert.equal(wrapper.threat.threats.length, n, 'every mob is tracked (the cap used to be 12)')
  }
})

test('surrounded: with room between the mobs the route goes through the gap, not over a mob', () => {
  const { bot, movements, wrapper } = ringWorld(8, 6)
  const r = world.plan(bot, movements, wrapper.fleePlan().goal)
  assert.ok(world.closestApproach(bot, r.path) >= 1.8, `closest approach ${world.closestApproach(bot, r.path).toFixed(2)}`)
})

test('an ordinary walk is never refused because mobs are around', () => {
  let seed = 4242
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  for (let trial = 0; trial < 25; trial++) {
    const bot = world.makeWorld()
    for (let i = 0; i < 12; i++) {
      const a = rnd() * 2 * Math.PI
      const r = 8 + rnd() * 16
      world.addApproaching(bot, 10 + i, 'zombie', 0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r)
    }
    const movements = new world.Movements(bot)
    const wrapper = new PathfinderWrapper(Object.assign(bot, { on () {}, pathfinder: { movements } }), { enableWindCharge: false })
    wrapper.configureMovements(movements)
    wrapper.threat.sample(bot, true)
    const a = rnd() * 2 * Math.PI
    const goal = new world.goals.GoalNear(Math.round(Math.cos(a) * 20), 64, Math.round(Math.sin(a) * 20), 1)
    assert.notEqual(world.plan(bot, movements, goal, { timeout: 3000 }).status, 'noPath', `layout ${trial}`)
  }
})

test('threat map: a mob standing on the ground keeps its danger zone at ground level', () => {
  const bot = world.makeWorld()
  world.addMob(bot, 5, 'zombie', 6.5, 0.5) // vy = -0.0784 like every grounded mob
  const map = new PredictiveThreatMap()
  map.sample(bot, true)
  assert.equal(map.threats[0].future.y, 64, 'the gravity constant must not sink the sphere 3 blocks')
})

test('threat map: velocity comes from position deltas, not from the stale / mis-scaled field', () => {
  let t = 1000
  const bot = world.makeWorld()
  // 26.x: mineflayer divides entity velocity by 8000 — a sprinting mob reads as 2e-4.
  const z = world.addMob(bot, 5, 'zombie', 6.5, 0.5, { vx: 0.0002 })
  const map = new PredictiveThreatMap({ now: () => t })
  map.sample(bot, true)
  assert.equal(map.threats[0].speed, 0, 'a 2e-4 "velocity" is not believed')
  t += 200
  z.position.x -= 0.8 // moved 0.8 blocks in 4 ticks
  map.sample(bot, true)
  assert.ok(Math.abs(map.threats[0].speed - 0.2) < 1e-6, `speed ${map.threats[0].speed}`)
})

test('pathfinder never builds on its own: no pillars or bridges out of the inventory', () => {
  const house = (x, y, z) => {
    if (y <= 63) return true
    const inside = x >= 4 && x <= 10 && z >= -3 && z <= 3
    if (!inside) return false
    if (y === 68) return true
    if (y > 68) return false
    return x === 4 || x === 10 || z === -3 || z === 3
  }
  const roof = new world.goals.GoalNear(7, 69, 0, 1)

  // Upstream default: carrying dirt, it pillars up next to the house.
  const stock = world.makeWorld(house, { items: [['dirt', 20]] })
  const upstream = new world.Movements(stock)
  upstream.canDig = false
  assert.ok(world.plan(stock, upstream, roof, { timeout: 1500 }).placed > 0, 'upstream places blocks')

  // Our configuration: it does not.
  const bot = world.makeWorld(house, { items: [['dirt', 20]] })
  const movements = new world.Movements(bot)
  const wrapper = new PathfinderWrapper(Object.assign(bot, { on () {}, pathfinder: { movements } }), { enableWindCharge: false })
  wrapper.configureMovements(movements)
  const r = world.plan(bot, movements, roof, { timeout: 1500 })
  assert.equal(r.placed, 0)
  assert.equal(r.broken, 0)
  assert.equal(movements.allow1by1towers, false)
})

test('respawn: a fresh Movements object gets doors, mode, digging guard and threat costs again', () => {
  const bot = Object.assign(world.makeWorld(), { on () {}, pathfinder: { movements: null, setMovements (m) { this.movements = m } } })
  const wrapper = new PathfinderWrapper(bot, { enableWindCharge: false })
  const door = world.registry.blocksByName.oak_door.id
  const fresh = () => { const m = new world.Movements(bot); m.canDig = false; bot.pathfinder.setMovements(m); return m }

  fresh()
  wrapper.apply()
  wrapper.setMode('builder')
  const again = fresh() // what index.js does on every spawn
  wrapper.apply()
  wrapper.stop()

  // Doors are handled by the wrapper's own block-state logic (custom_mineflayer/
  // doors.js); upstream's type-based handling is switched off on purpose.
  assert.equal(again._zincaiDoors?.attached, true, 'door routing is attached again after dying once')
  assert.equal(again._zincaiDoors.operate, true, 'and it may still open them by hand')
  assert.equal(again.canOpenDoors, false, 'upstream door handling stays off')
  assert.equal(again.openable.has(door), false)
  assert.equal(again.blocksCantBreak.has(door), true, 'a door is opened or walked around, never broken')
  assert.equal(again.allowSprinting, false, 'builder mode is still applied, not just reported')
  assert.equal(again.maxDropDown, 1)
  assert.equal(again.canDig, false)
  assert.equal(again._zincaiThreatCost, true)
  assert.equal(wrapper.mode, 'builder')
})

test('yaw helpers face where they say (yaw 0 = north)', () => {
  const wind = new WindChargeTraversal({}, { enabled: true })
  assert.ok(Math.abs(wind._yawFor({ x: 0, z: -1 })) < 1e-9, 'north')
  assert.ok(Math.abs(wind._yawFor({ x: 1, z: 0 }) + Math.PI / 2) < 1e-9, 'east')
  assert.ok(Math.abs(Math.abs(wind._yawFor({ x: 0, z: 1 })) - Math.PI) < 1e-9, 'south, not north')
  assert.ok(Math.abs(PathfinderWrapper.yawFor({ x: -1, z: 0 }) - Math.PI / 2) < 1e-9, 'west')
})

// ============================================================== combat ====

test('combat targeting: exact names, no players by accident, no pets, no caged mobs', async () => {
  const bot = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  bot.entities[2] = ent(2, 'player', 2.5, 0.5, { username: 'Gabriel' })
  bot.entities[3] = ent(3, 'zombified_piglin', 3.5, 0.5) // neutral until provoked
  bot.entities[4] = ent(4, 'wolf', 0.5, 2.5, { metadata: Object.assign([], { 17: 0x04 }) }) // tamed
  bot.entities[5] = ent(5, 'villager', 0.5, 3.5)
  bot.entities[6] = ent(6, 'armor_stand', 1.5, 1.5)
  const combat = new AdvancedCombat(bot, {})

  assert.deepEqual(await combat.engage('player'), { ok: false, why: 'name_the_player' })
  assert.deepEqual(await combat.engage('any'), { ok: false, why: 'no_target' }, '"any" never means a player')
  assert.deepEqual(await combat.engage('pig'), { ok: false, why: 'no_target' }, '"pig" is not a zombified_piglin')
  // A piglin is hostile to anyone not wearing gold — and to nobody who is.
  const nether = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  nether.entities[9] = ent(9, 'piglin', 0.5, 3.5)
  assert.deepEqual(await new AdvancedCombat(nether, {}).engage('any'), { ok: true, target: 'piglin' })
  nether.inventory.slots[5] = { name: 'golden_helmet' }
  assert.deepEqual(await new AdvancedCombat(nether, {}).engage('any'), { ok: false, why: 'no_target' }, 'in gold, "any" leaves piglins alone')
  assert.deepEqual(await combat.engage('wolf'), { ok: false, why: 'protected' }, 'someone\'s dog')
  assert.deepEqual(await combat.engage('villager'), { ok: false, why: 'protected' })
  assert.deepEqual(await combat.engage('armor_stand'), { ok: false, why: 'protected' })
  assert.equal(isProtected(bot.entities[4]), true)

  // The one way to fight a player: their exact name.
  const duel = await combat.engage({ player: 'gabriel' })
  assert.deepEqual(duel, { ok: true, target: 'Gabriel' })
  assert.equal(combat.target, bot.entities[2])
  combat.stop()

  const caged = makeBot({ blockAt: barsAtZ2, items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  caged.entities[7] = ent(7, 'zombie', 0.5, 3.5)
  assert.deepEqual(await new AdvancedCombat(caged, {}).engage('zombie'), { ok: false, why: 'no_line_of_sight' })
})

test('combat: a despawn is "lost", only a death is "down"; nothing stays pressed either way', async () => {
  for (const died of [true, false]) {
    const bot = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
    const zombie = ent(5, 'zombie', 0.5, 2.6)
    bot.entities[5] = zombie
    const arbiter = new ControlArbiter(bot)
    const events = []
    const combat = new AdvancedCombat(bot, { hands: arbiter.lane('combat', PRIORITY.combat), onEvent: (e) => events.push(e) })
    combat.start()
    assert.equal((await combat.engage('zombie')).ok, true)
    for (let i = 0; i < 4; i++) bot.emit('physicsTick')
    assert.notEqual(heldKeys(bot), '(none)', 'fighting presses keys')

    if (died) bot.emit('entityDead', zombie)
    delete bot.entities[5]
    bot.emit('entityGone', zombie)
    const last = events[events.length - 1]
    assert.equal(last.result, died ? 'won' : 'lost')
    assert.match(last.msg, died ? /^target down$/ : /^target lost/)
    assert.equal(heldKeys(bot), '(none)', 'every key is released when the fight ends')
    assert.equal(bot.pathfinder.goal, null)
    assert.equal(arbiter.owner(), 'idle')
    combat.stop()
  }
})

test('combat kill-chain cannot reacquire a dead entity still in the entity table', async () => {
  const bot = makeBot()
  const zombie = ent(5, 'zombie', 0.5, 2.6)
  bot.entities[5] = zombie
  const combat = new AdvancedCombat(bot, {})
  combat.start()
  assert.equal((await combat.engage('zombie')).ok, true)

  // A death arrives before the server's entity-destroy packet. Some servers
  // leave the old entity visible for a few ticks; the chain must not attack it
  // again in that window.
  bot.emit('entityDead', zombie)
  delete bot.entities[5]
  bot.emit('entityGone', zombie)
  bot.entities[5] = zombie // recreate the stale view the real protocol can briefly expose
  assert.equal(combat._deadEntities.has(zombie), true)
  assert.deepEqual(await combat.engage('zombie'), { ok: false, why: 'no_target' })
  assert.equal(combat.target, null)
  combat.stop()
})

test('combat: public evasion hooks do nothing unless a fight is on (they used to hold keys forever)', () => {
  const bot = makeBot()
  const combat = new AdvancedCombat(bot, {})
  assert.equal(combat.panicRetreat('mace'), null)
  assert.equal(combat.evadeLateral('elytra'), null)
  combat.forceTick()
  assert.equal(heldKeys(bot), '(none)')
  assert.equal(bot.log.setGoal.length, 0)
})

test('combat: creeper is hit once and then run from — never stood next to', async () => {
  let t = 0
  const bot = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  const creeper = ent(6, 'creeper', 0.5, 3.0)
  bot.entities[6] = creeper
  const combat = new AdvancedCombat(bot, { now: () => t })
  assert.equal((await combat.engage('creeper')).ok, true)
  combat._tick()
  assert.deepEqual(bot.log.attack, [6], 'one hit the moment it is in reach')
  assert.equal(combat.state, 'retreat')
  assert.equal(heldKeys(bot), 'forward+jump+sprint', 'turns and runs')
  assert.ok(Math.abs(bot.entity.yaw) < 0.2, 'facing away from the creeper (it is to the south)')
  // Still next to it with the fuse lit: no second swing, keep running.
  creeper.metadata[16] = 1
  t += 700
  combat._housekeeping()
  combat._tick()
  assert.deepEqual(bot.log.attack, [6])
  assert.equal(combat.state, 'retreat')
  combat.stop()
})

test('combat: strafe "right" is really the right-hand side when facing east', () => {
  // Facing east (yaw -π/2), right is south (+z). The old math said north.
  const bot = makeBot({ yaw: -Math.PI / 2 })
  const asked = []
  const combat = new AdvancedCombat(bot, { threatMap: { threatScoreAt: (p) => { asked.push(p); return p.z > 0.5 ? 9 : 0 } }, now: () => 10_000 })
  combat._perpendicularStrafe(10_000)
  assert.ok(asked[0].z < 0.5 && asked[1].z > 0.5, 'left probe is north (-z), right probe is south (+z)')
  assert.equal(combat.strafeSign, -1, 'danger on the right → strafe left')
})

test('classifyThreat: weapons matter only with real motion', () => {
  const holder = { name: 'player', position: { x: 0, y: 64, z: 4 }, heldItem: { name: 'mace' }, onGround: true, velocity: { x: 0, y: 0, z: 0 } }
  const still = classifyThreat(holder, { botPos: { x: 0, y: 64, z: 0 }, motion: { vy: 0, airborne: false } })
  assert.ok(!still.tags.includes('mace_airborne'), 'a mace in hand 4 blocks away is not a threat')
  const jumping = classifyThreat(holder, { botPos: { x: 0, y: 64, z: 0 }, motion: { vy: 0.3, airborne: true } })
  assert.ok(jumping.tags.includes('mace_airborne'))
  assert.ok(!classifyThreat({ name: 'player', heldItem: { name: 'bowl' } }, {}).tags.includes('ranged'))

  let t = 0
  const tracker = new MotionTracker({ now: () => t })
  const e = { id: 1, position: { x: 0, y: 64, z: 0 } }
  tracker.update(e)
  t += 50
  e.position.y = 64.42
  assert.equal(tracker.update(e).rising, true)
})

// ============================================================ system 1 ====

function reflexRig (bot, opts = {}) {
  const arbiter = new ControlArbiter(bot)
  const events = []
  const s1 = new System1(bot, { registry: new ReflexRegistry(), logger: quiet, arbiter, onEvent: (e) => events.push(e), ...opts })
  s1.registerBuiltins()
  return { s1, arbiter, events }
}

test('creeper right behind the bot: it runs away from it (the old dodge reflex pushed it backwards into it)', async () => {
  for (const dist of [1.4, 1.8, 3]) {
    const bot = makeBot()
    bot.entities[6] = ent(6, 'creeper', 0.5, 0.5 + dist) // south of the bot
    const { s1 } = reflexRig(bot)
    const seen = new Set()
    for (let i = 0; i < 6; i++) { await s1.tick(); seen.add(heldKeys(bot)); await sleep(15) }
    assert.deepEqual([...seen], ['forward+jump+sprint'], `creeper at ${dist}: one clear escape, no "back" key`)
    assert.ok(Math.abs(bot.entity.yaw) < 0.2, 'facing north, away from it')
    s1.stop()
  }
})

test('the model decides: once it has, the listed threats stop the flee; new ones and low health restart it', async () => {
  const bot = makeBot()
  bot.entities[5] = ent(5, 'zombie', 0.5, 5.5)
  const { s1, arbiter, events } = reflexRig(bot)
  await s1.tick()
  assert.equal(s1.fleeing, true)
  assert.equal(arbiter.owner(), 'survival')
  const told = events.find((e) => e.type === 'threat')
  assert.deepEqual(told.threatIds, [5])

  // "hold" / "go_to" / "attack": the model has seen zombie #5 and decided.
  s1.acknowledge(told.threatIds, { label: 'hold' })
  assert.equal(s1.fleeing, false)
  assert.equal(heldKeys(bot), '(none)')
  await s1.tick()
  assert.equal(s1.fleeing, false, 'the decided threat no longer triggers the reflex')

  // A threat the model has not seen yet does.
  bot.entities[6] = ent(6, 'skeleton', 4.5, 0.5)
  await s1.tick()
  assert.equal(s1.fleeing, true)
  assert.deepEqual(s1.live.map((t) => t.name), ['skeleton'])

  // "attack zombie" covers zombies that arrive later.
  s1.acknowledge([6], { types: ['zombie'] })
  bot.entities[7] = ent(7, 'zombie', -3.5, 0.5)
  await s1.tick()
  assert.equal(s1.fleeing, false)

  // Too hurt to honour old decisions: flee from everything.
  bot.health = 5
  await s1.tick()
  assert.equal(s1.fleeing, true)
  assert.equal(s1.live.length, 3)

  // A lit creeper overrides any decision too.
  bot.health = 20
  s1.clearDecision()
  s1.acknowledge([5, 6, 7], { all: true })
  bot.entities[8] = ent(8, 'creeper', 0.5, -3.5, { metadata: Object.assign([], { 16: 1 }) })
  await s1.tick()
  assert.deepEqual(s1.live.map((t) => t.name), ['creeper'])
  s1.stop()
})

test('no route? the bot sprints straight away instead of standing still', async () => {
  const bot = makeBot()
  bot.entities[5] = ent(5, 'zombie', 4.5, 0.5) // east
  const { s1 } = reflexRig(bot, { pathfinder: { fleePlan: () => null } })
  await s1.tick()
  assert.equal(heldKeys(bot), 'forward+jump+sprint')
  assert.ok(Math.abs(bot.entity.yaw - Math.PI / 2) < 0.2, 'facing west')
  assert.equal(bot.pathfinder.goal, null)
  s1.stop()
})

test('water bucket: untouched on ordinary jumps, used on a fall that would hurt, and picked up again', async () => {
  const JUMP = [0.333, 0.248, 0.165, 0.083, 0.003, -0.075, -0.152, -0.228, -0.302, -0.374, -0.445]
  const sword = { name: 'iron_sword' }
  const bucket = { name: 'water_bucket' }
  const bot = makeBot({ items: [sword, bucket], held: 'iron_sword' })
  const { s1 } = reflexRig(bot)

  for (let jump = 0; jump < 3; jump++) {
    let y = 64
    bot.entity.onGround = false
    for (const vy of JUMP) { y += vy; bot.entity.position.y = y; bot.entity.velocity.y = vy; s1._physicsTick() }
    bot.entity.onGround = true; bot.entity.position.y = 64; bot.entity.velocity.y = -0.0784
    s1._physicsTick()
  }
  await sleep(10)
  assert.deepEqual(bot.log.equip, [], 'three jumps: the bucket never leaves the inventory')
  assert.equal(bot.log.activate, 0)

  // A 20-block fall.
  bot.entity.onGround = false
  let y = 84
  let vy = 0
  let placedAt = null
  bot.activateItem = () => { bot.log.activate++; if (placedAt === null) { placedAt = y - 64; bot.heldItem = { name: 'bucket' } } }
  while (y > 64.01) {
    vy = (vy - 0.08) * 0.98
    y = Math.max(64, y + vy)
    bot.entity.position.y = y
    bot.entity.velocity.y = vy
    s1._physicsTick()
    await sleep(1) // let the equip promise settle between ticks
  }
  assert.ok(bot.log.equip.includes('water_bucket@hand'), 'bucket equipped during the fall')
  assert.equal(bot.entity.pitch, -Math.PI / 2, 'looking straight down')
  assert.ok(placedAt !== null && placedAt <= 2.9, `water placed within reach of the ground (${placedAt})`)

  bot.entity.onGround = true
  bot.entity.velocity.y = -0.0784
  s1._physicsTick()
  await sleep(600)
  assert.equal(bot.log.activate, 2, 'second click scoops the water back up')
  assert.equal(bot.heldItem.name, 'iron_sword', 'the sword is back in hand')
  s1.stop()
})

test('elytra: opened with bot.elytraFly() on a long fall (a jump pulse does nothing in mineflayer)', async () => {
  const bot = makeBot({ items: [{ name: 'elytra' }], held: null })
  bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' }) // nothing below for 40 blocks
  const { s1 } = reflexRig(bot)
  bot.entity.onGround = false
  let y = 200
  let vy = 0
  for (let i = 0; i < 14; i++) {
    vy = (vy - 0.08) * 0.98; y += vy
    bot.entity.position.y = y; bot.entity.velocity.y = vy
    s1._physicsTick()
    await sleep(1)
  }
  assert.equal(bot.log.elytraFly, 1)
  assert.deepEqual(bot.log.equip, ['elytra@torso'], 'worn first when it was only carried')
  assert.ok(!bot.controls.jump, 'no jump pulse')
  s1.stop()
})

test('eating: whitelist only, no waste, healing items kept for when it matters', () => {
  const inv = (...names) => names.map((name) => ({ name }))
  // The old regex ate these (or tried to).
  for (const junk of ['poisonous_potato', 'beetroot_seeds', 'carrot_on_a_stick', 'cod_bucket', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple']) {
    assert.equal(chooseFood(inv(junk), { food: 10, health: 20 }), null, `${junk} is never a snack`)
  }
  assert.equal(FOOD_RE.test('poisonous_potato'), false)
  assert.equal(chooseFood(inv('bread', 'cooked_beef'), { food: 10, health: 20 }).name, 'cooked_beef', 'best saturation first')
  assert.equal(chooseFood(inv('cooked_beef'), { food: 17, health: 20 }), null, 'an 8-point steak is not burned on 3 missing points')
  assert.equal(chooseFood(inv('apple', 'cooked_beef'), { food: 16, health: 20 }).name, 'apple')
  assert.equal(chooseFood(inv('beef', 'bread'), { food: 10, health: 20 }).name, 'bread', 'cooked before raw')
  assert.equal(chooseFood(inv('rotten_flesh'), { food: 10, health: 20 }), null)
  assert.equal(chooseFood(inv('rotten_flesh'), { food: 2, health: 20 }).name, 'rotten_flesh', 'only when starving')
  assert.equal(chooseFood(inv('golden_apple', 'bread'), { food: 20, health: 6, healing: true }).name, 'golden_apple')
  assert.equal(chooseFood(inv('enchanted_golden_apple'), { food: 20, health: 8, healing: true }), null, 'the enchanted one waits for 6 hp')
})

test('eating puts the weapon back, and does not start in the middle of a fight', async () => {
  const sword = { name: 'iron_sword' }
  const bread = { name: 'bread' }
  const bot = makeBot({ items: [sword, bread], held: 'iron_sword', food: 10 })
  const { s1 } = reflexRig(bot)
  assert.equal(s1.eat({ type: 'food_low' }), 'eat_bread')
  await sleep(20)
  assert.equal(bot.log.consume, 1)
  assert.equal(bot.heldItem.name, 'iron_sword')

  const fighting = makeBot({ items: [sword, bread], held: 'iron_sword', food: 10 })
  const rig = reflexRig(fighting, { combat: { isEngaged: true, target: null } })
  assert.equal(rig.s1.eat({ type: 'food_low' }), 'eat_fighting')
  s1.stop(); rig.s1.stop()
})

test('run_script accepts the documented "name.js" form', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-script-'))
  const out = await runScript('flee.js', {}, { bot: null, logger: quiet })
  assert.equal(out, 'no_entity', 'zincai/scripts/flee.js ran (it used to be "fleejs not found")')
  await assert.rejects(() => runScript('../../etc/passwd', {}, {}), /not found/)
  fs.rmSync(dir, { recursive: true, force: true })
})

// =========================================================== memory (PT-BR) ==

test('memory understands Portuguese: accents, recall, per-player preferences, chat that survives a fight', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-pt-'))
  const mem = new MemorySystem({ file: path.join(dir, 'm.json') })
  assert.deepEqual(tokenize('Onde fica o baú de diamantes?'), ['bau', 'diamante'])

  assert.deepEqual(mem.observeChat('Gabriel', 'eu gosto de tijolos de pedra'), { text: 'tijolos de pedra', polarity: 'like', who: 'Gabriel' })
  assert.equal(mem.observeChat('Pedro', 'não gosto de terra nas torres').polarity, 'dislike')
  assert.match(mem.preferencesLine('Pedro'), /^Pedro preferences: dislikes: terra nas torres$/)
  assert.ok(!/tijolos/.test(mem.preferencesLine('Pedro')), 'Gabriel\'s taste is not Pedro\'s')
  assert.match(mem.preferencesLine(), /Gabriel — likes: tijolos de pedra/)

  mem.rememberChat('Gabriel', 'zinc, o baú de diamantes fica no segundo andar da casa', { addressed: true })
  assert.equal(mem.rememberChat('Gabriel', 'zinc vem aqui', { addressed: true }), null, 'a request is not a memory')
  assert.equal(MemorySystem.isRecallQuery('onde fica o bau de diamantes?'), true)
  assert.match(mem.recallBlock('onde fica o bau de diamantes?'), /segundo andar/)

  mem.addEvent({ type: 'chat', sender: 'Gabriel', text: 'Gabriel: zinc vem aqui' })
  for (let i = 0; i < 9; i++) mem.addEvent({ type: 'combat', msg: 'hit zombie (sword)' })
  const window = mem.working.last(5)
  assert.equal(window.length, 2, 'nine identical hits are one line')
  assert.equal(window[1].count, 9)
  assert.match(window[0].text, /vem aqui/, 'the chat line is still there')
  assert.equal(mem.recentChat().length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ============================================================== places ====

test('place memory: indexes containers with their sign labels and contents, grouped for the prompt', () => {
  const blocks = new Map([
    ['3,64,4', { name: 'chest' }], ['4,64,4', { name: 'chest' }], // a double chest
    ['3,65,4', { name: 'oak_wall_sign', getSignText: () => ['Diamantes\n', ''] }],
    ['6,64,4', { name: 'barrel' }],
    ['7,64,4', { name: 'furnace' }], ['8,64,4', { name: 'crafting_table' }],
    ['5,64,2', { name: 'red_bed' }],
    ['3,70,4', { name: 'chest' }] // upstairs
  ])
  const bot = {
    registry: { blocksArray: [{ id: 1, name: 'chest' }, { id: 2, name: 'stone' }] },
    game: { dimension: 'minecraft:overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    findBlocks: () => [...blocks.keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) }),
    blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) || { name: 'air' }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-places-'))
  const places = new PlaceIndex({ file: path.join(dir, 'places.json') })
  places.scan(bot, { force: true })

  const chests = places.near(bot.entity.position, { kinds: new Set(['chest']) })
  assert.equal(chests.length, 2, 'the double chest is one entry; upstairs is another')
  const labelled = chests.find((c) => c.label)
  assert.equal(labelled.label, 'Diamantes')
  assert.equal(kindOf('blast_furnace'), 'furnace')

  // Tools address things by id, label or contents — never by invented coordinates.
  assert.equal(places.resolve('diamantes', bot.entity.position).id, labelled.id)
  assert.equal(places.resolve(labelled.id, bot.entity.position).x, labelled.x)
  assert.equal(places.resolve('furnace', bot.entity.position).kind, 'furnace')
  assert.equal(places.resolve('', bot.entity.position).kind, 'chest', 'default: nearest container')
  places.noteContents(labelled, { diamond: 12, iron_ingot: 30 }, { freeSlots: 20 })
  assert.equal(places.findItem('diamonds', bot.entity.position)[0].id, labelled.id)
  assert.equal(places.resolve('iron', bot.entity.position).id, labelled.id)

  const text = places.describeNearby(bot.entity.position)
  assert.match(text, /chest1 "Diamantes" \[iron_ingot x30, diamond x12\]/)
  assert.match(text, /barrel1 \[not opened yet\]/)
  assert.match(text, /furnace1/)
  assert.match(text, /bed1 \(red\)/)
  assert.match(text, /crafting_table/)
  assert.match(text, /^y64 .*\n?y70 /s, 'one line per floor')

  places.remember('casa do Gabriel', { x: 100.7, y: 64, z: -20.2 }, { by: 'Gabriel' })
  assert.equal(places.getPlace('CASA DO GABRIEL').x, 100)
  assert.match(places.describeNamed(bot.entity.position), /casa do Gabriel \(100,64,-21 · 10\dm /)

  // Survives a restart.
  const reloaded = new PlaceIndex({ file: path.join(dir, 'places.json') })
  assert.equal(reloaded.getPlace('casa do gabriel').z, -21)
  assert.deepEqual(reloaded.resolve('chest1', bot.entity.position).contents, { diamond: 12, iron_ingot: 30 })
  fs.rmSync(dir, { recursive: true, force: true })
})

// ============================================================== prompt ====

test('the model is shown its inventory, and players with direction and coordinates', () => {
  const bot = makeBot({ items: [{ name: 'iron_sword', count: 1 }, { name: 'bread', count: 12 }, { name: 'bread', count: 3 }], held: 'iron_sword' })
  bot.time = { timeOfDay: 14000 }
  const g = ent(2, 'player', 0.5, -11.5, { username: 'Gabriel' })
  g.equipment[0] = { name: 'diamond_pickaxe' }
  bot.entities[2] = g
  bot.players = { ZincAI: { entity: bot.entity }, Gabriel: { entity: g }, Pedro: { entity: null } }
  for (let i = 0; i < 20; i++) bot.entities[10 + i] = ent(10 + i, 'sheep', 5.5 + i, 0.5)
  for (let i = 0; i < 20; i++) bot.entities[40 + i] = ent(40 + i, 'item_frame', -3.5, 0.5 + i)
  bot.entities[70] = ent(70, 'wolf', 2.5, 2.5, { metadata: Object.assign([], { 17: 0x04 }) })

  assert.equal(observe.inventoryLine(bot), 'inventory (3/36 slots): iron_sword, bread x15')
  assert.match(observe.selfLine(bot), /hp 20\/20 food 20\/20 \| pos 0,64,0 overworld \| night .* holding iron_sword/)
  const players = observe.playersLine(bot)
  assert.match(players, /Gabriel 12m N at 0,64,-12 \(holding diamond_pickaxe\)/)
  assert.match(players, /out of sight: Pedro/)
  const mobs = observe.mobsLine(bot)
  assert.match(mobs, /sheep x19|sheep x20/, 'all sheep counted — no 16-entity cap')
  assert.match(mobs, /wolf \(pet\)/)
  assert.ok(!/item_frame/.test(mobs), 'decor is not a mob')
  assert.ok(!/avoid this area/.test(mobs))
})

// =============================================================== brain ====

test('brain: wake-ups are queued, never dropped; chat is answered first', async () => {
  let t = 0
  const calls = []
  let release = null
  const brain = new Brain({
    now: () => t,
    minIntervalMs: 3000,
    chatMinIntervalMs: 1000,
    heartbeatMs: 0,
    act: async (reasons) => { calls.push(['act', reasons]); if (release) await release; return { idle: false } },
    talk: async (sender, lines) => { calls.push(['talk', sender, lines.map((l) => l.text)]) }
  })

  // Something happens while the model is busy and inside the 3 s spacing.
  brain.wake('fleeing from zombie')
  let unblock
  release = new Promise((resolve) => { unblock = resolve })
  const running = brain.tick()
  brain.wake('hurt: hit by zombie')
  brain.hear('Gabriel', 'zinc vem aqui')
  brain.hear('Gabriel', 'rapido')
  // The body's call is still in flight. The reply does not wait for it (it
  // used to: one slot for both lanes, so a slow action call held chat back).
  await brain.tick()
  assert.deepEqual(calls[1], ['talk', 'Gabriel', ['zinc vem aqui', 'rapido']])
  assert.equal(calls.length, 2, 'the second action turn is queued behind the first, not run beside it')
  assert.equal(brain.busyAction, true)
  unblock(); release = null
  await running
  assert.equal(brain.busy, false)

  t = 1000
  await brain.tick() // inside the 3 s spacing: queued, not dropped
  assert.equal(calls.length, 2)
  t = 3100
  await brain.tick()
  assert.deepEqual(calls[2], ['act', ['hurt: hit by zombie']])
})

test('brain: chat keeps a reserved share of the call budget; an urgent wake may run sooner', async () => {
  let t = 0
  const calls = []
  const brain = new Brain({
    now: () => t,
    minIntervalMs: 3000,
    urgentMinIntervalMs: 1000,
    chatMinIntervalMs: 1000,
    heartbeatMs: 0,
    rpm: 18,
    chatReserve: 4,
    act: async (r) => { calls.push(['act', r]); return { idle: true } },
    talk: async (sender, lines) => { calls.push(['talk', lines.map((l) => l.text)]) }
  })
  // A chase that wakes the body as often as the spacing allows.
  for (let i = 0; i < 20; i++) { brain.wake(`event ${i}`); await brain.tick(); t += 3000 }
  // 20 × 3 s = one minute: the body got 14 of the 18 calls and no more.
  const inWindow = () => brain.calls.filter((c) => t - c.at <= 60_000)
  assert.equal(inWindow().filter((c) => c.lane === 'action').length, 14, 'the action lane stops at rpm - chatReserve')
  brain.wake('one more event')
  await brain.tick()
  assert.equal(calls.filter((c) => c[0] === 'act').length, 14, 'still capped — the reasons wait in the queue')
  assert.ok(brain.pending.length > 0, 'and none of them was dropped')
  // A friend speaks now: the reserve is theirs. (This is the moment chat went silent.)
  const before = calls.filter((c) => c[0] === 'talk').length
  brain.hear('Gabriel', 'zinc ta tudo bem?')
  await brain.tick()
  assert.equal(calls.filter((c) => c[0] === 'talk').length, before + 1, 'answered although the body used up its share')

  // Urgency: a normal reason waits out the 3 s spacing, an urgent one only 1 s.
  const b2calls = []
  let t2 = 0
  const b2 = new Brain({ now: () => t2, minIntervalMs: 3000, urgentMinIntervalMs: 1000, heartbeatMs: 0, act: async (r) => { b2calls.push(r); return { idle: true } }, talk: async () => {} })
  b2.wake('first'); await b2.tick()
  t2 = 1200
  b2.wake('walk finished', { external: false }); await b2.tick()
  assert.equal(b2calls.length, 1, 'an ordinary reason waits')
  b2.wake('reflex: started FLEEING — creeper came close (4m S)', { urgent: true }); await b2.tick()
  assert.equal(b2calls.length, 2, 'the start of an escape does not wait 3 s')
  assert.deepEqual(b2calls[1], ['walk finished', 'reflex: started FLEEING — creeper came close (4m S)'])
  // A reason that had to wait says for how long.
  t2 = 2000
  b2.wake('safe again'); t2 = 9000; await b2.tick()
  assert.deepEqual(b2calls[2], ['safe again (7s ago)'])
})

test('brain: idle answers slow the heartbeat only — an event still runs at once', async () => {
  let t = 0
  const calls = []
  const brain = new Brain({ now: () => t, minIntervalMs: 3000, heartbeatMs: 10_000, act: async (r) => { calls.push(r); return { idle: true } }, talk: async () => {} })
  for (const at of [10_000, 30_000, 60_000]) { t = at; await brain.tick() }
  assert.equal(calls.length, 3)
  assert.match(calls[0][0], /^heartbeat/)
  t = 63_100 // 3 idle answers: next heartbeat is 40 s away…
  await brain.tick()
  assert.equal(calls.length, 3)
  brain.wake('fleeing from creeper') // …but an event is not a heartbeat
  await brain.tick()
  assert.deepEqual(calls[3], ['fleeing from creeper'])
})

test('brain: a failed call keeps its reasons and backs off; the shared rate limit holds', async () => {
  let t = 0
  let fail = true
  const seen = []
  const brain = new Brain({ now: () => t, minIntervalMs: 1000, heartbeatMs: 0, rpm: 3, chatReserve: 0, act: async (r) => { seen.push(r); if (fail) throw new Error('HTTP 500'); return { idle: false } }, talk: async () => {}, logger: () => {} })
  brain.wake('chat request from Gabriel: go to Gabriel')
  await brain.tick()
  assert.equal(brain.pending.length, 1, 'the reason survives the failure')
  t = 1500
  await brain.tick()
  assert.equal(seen.length, 1, 'backing off (3 s after one failure)')
  fail = false
  t = 3100
  await brain.tick()
  assert.equal(seen.length, 2)
  brain.wake('a'); t = 4200; await brain.tick()
  brain.wake('b'); t = 5300; await brain.tick()
  assert.equal(seen.length, 3, 'three calls in the last minute: the fourth waits')
  t = 62_000
  await brain.tick()
  assert.equal(seen.length, 4)
})

// ============================================================== whisper ====

test('vanilla guard: private messages go out through one fixed command; nothing else can', () => {
  const sent = []
  const bot = { chat (m) { sent.push(m) }, emit () {}, players: { Gabriel: {}, ZincAI: {} } }
  const guard = installVanillaGuard(bot, { logger: quiet })
  assert.equal(guard.whisper('Gabriel', 'tô indo'), true)
  assert.equal(guard.whisper('gabriel', 'ok'), true, 'case-insensitive match on who is online')
  assert.equal(guard.whisper('Nobody', 'oi'), false, 'only to someone online')
  assert.equal(guard.whisper('Gabriel /op me', 'oi'), false, 'the name cannot carry a command')
  assert.equal(guard.whisper('Gabriel', ''), false)
  assert.equal(bot.chat('/gamemode creative'), false)
  assert.deepEqual(sent, ['/msg Gabriel tô indo', '/msg gabriel ok'])
})

test('directHands (harness A, tests): same interface, straight to the bot', () => {
  const bot = makeBot()
  const hands = directHands(bot)
  hands.setGoal({ id: 'g' })
  hands.setControlState('forward', true)
  assert.equal(heldKeys(bot), 'forward')
  assert.equal(bot.pathfinder.goal.id, 'g')
  hands.release()
  assert.equal(heldKeys(bot), '(none)')
  assert.equal(bot.pathfinder.goal, null)
})

// ---------------------------------------------------------------------------
// Being hit: one report per hit on every kind of server
// ---------------------------------------------------------------------------
const { HurtTracker } = require('../zincai/threats')
const { fleePlan } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const perception = require('../zincai/perception')
const { decideReconnect } = require('../src/reconnect')

test('hurt: a health drop alone is enough to know the bot was hit (no hurt event needed)', async () => {
  const bot = makeBot()
  const sense = new ThreatSense(bot)
  const seen = []
  const tracker = new HurtTracker(bot, sense, { settleMs: 20, onHurt: (cause, info) => seen.push({ text: cause.text, hp: info.hp }) }).start()
  bot.health = 20; bot.emit('health') // baseline
  bot.food = 0
  bot.health = 19; bot.emit('health')
  await sleep(60)
  assert.deepEqual(seen, [{ text: 'starving (food is 0)', hp: 19 }])
  tracker.stop()
})

test('hurt: health packet + bare hurt event + named source = ONE report, with the name', async () => {
  const bot = makeBot()
  const sense = new ThreatSense(bot)
  const gabriel = ent(2, 'player', 2.5, 0.5, { type: 'player', username: 'Gabriel' })
  bot.entities[2] = gabriel
  const seen = []
  const tracker = new HurtTracker(bot, sense, { settleMs: 20, onHurt: (cause) => seen.push(cause.text) }).start()
  bot.health = 20; bot.emit('health')
  bot.health = 17; bot.emit('health')
  bot.emit('entityHurt', bot.entity)
  bot.emit('entityHurt', bot.entity, gabriel)
  await sleep(60)
  // A duplicate announcement of the same hit right afterwards changes nothing.
  bot.emit('entityHurt', bot.entity)
  await sleep(60)
  assert.deepEqual(seen, ['hit by player Gabriel'])
  assert.ok(sense.isRecentAttacker(gabriel), 'the attacker is remembered: the reflex will run from them')
  tracker.stop()
})

test('hurt: with no named source, whoever swung at arm\'s length is blamed — but only on servers that never name one', async () => {
  const bot = makeBot()
  const sense = new ThreatSense(bot)
  const pedro = ent(3, 'player', 2.0, 0.5, { type: 'player', username: 'Pedro' })
  const far = ent(4, 'player', 12.0, 0.5, { type: 'player', username: 'Longe' })
  bot.entities[3] = pedro
  bot.entities[4] = far
  sense.noteSwing(far) // someone mining 12 blocks away is not a suspect
  assert.equal(sense.damageCause(null).text, 'took damage (cause unknown)')
  sense.noteSwing(pedro)
  const guess = sense.damageCause(null)
  assert.equal(guess.text, 'probably hit by player Pedro')
  assert.equal(guess.entity, pedro)

  // A server that DOES name sources (it sent a damage_event): an unnamed hit is
  // environmental — a friend mining next to the bot must not be blamed for a cactus.
  sense.sourcesNamed = true
  assert.equal(sense.damageCause(null).text, 'took damage (cause unknown)')
})

// ---------------------------------------------------------------------------
// Perception fixes
// ---------------------------------------------------------------------------
test('perception: the view cone points where the bot looks (yaw 0 = north)', () => {
  const fov = Math.PI / 2
  assert.equal(perception.inHorizontalFov(0, 0, -6, fov), true, 'north of a north-facing bot is in view')
  assert.equal(perception.inHorizontalFov(0, 0, 6, fov), false, 'south is behind it')
  assert.equal(perception.inHorizontalFov(Math.PI, 0, 6, fov), true, 'facing south sees south')
  assert.equal(perception.inHorizontalFov(Math.PI / 2, -6, 0, fov), true, 'yaw +90° faces west')
  assert.equal(perception.inHorizontalFov(Math.PI / 2, 6, 0, fov), false)
})

test('perception: bedrock is not a bed; furniture is not a wall; decor is not a mob', () => {
  const ch = (name) => perception.categoryChar({ name })
  assert.equal(ch('bedrock'), '#')
  assert.equal(ch('red_bed'), 'B')
  assert.equal(ch('oak_stairs'), '=')
  assert.equal(ch('oak_fence'), '|')
  assert.equal(ch('furnace'), 'f')
  assert.equal(ch('oak_wall_sign'), 'i')
  assert.equal(ch('chest'), 'C')
  assert.equal(ch('oak_door'), 'D')
  for (const glyph of ['=', '|', 'f', 'i', 'B']) assert.ok(perception.VISION_LEGEND.includes(`${glyph} `), `legend explains ${glyph}`)
  for (const decor of ['armor_stand', 'item_frame', 'glow_item_frame', 'painting', 'oak_boat', 'minecart', 'chest_minecart']) {
    assert.equal(perception.classifyEntityName(decor), 'object', decor)
  }
  assert.equal(perception.classifyEntityName('zombie'), 'hostile')
  assert.equal(perception.classifyEntityName('cow'), 'mob')
})

// ---------------------------------------------------------------------------
// Scripts and shared helpers
// ---------------------------------------------------------------------------
test('scripts/flee.js runs through the reflex layer: real threats only, nothing left held', async () => {
  const bot = makeBot()
  const arbiter = new ControlArbiter(bot)
  const sense = new ThreatSense(bot)
  const system1 = new System1(bot, { registry: new ReflexRegistry(), logger: quiet, arbiter, sense })
  const flee = require('../zincai/scripts/flee.js')
  assert.equal(await flee({ bot, system1, log: quiet }), 'nothing_to_flee')
  assert.equal(heldKeys(bot), '(none)')
  assert.equal(bot.log.setGoal.length, 0, 'no goal set when nothing is dangerous')

  bot.entities[9] = ent(9, 'zombie', 0.5, 3.5)
  assert.equal(await flee({ bot, system1, log: quiet }), 'fleeing_zombie')
  assert.equal(arbiter.owner(), 'survival')
  assert.ok(bot.controls.forward && bot.controls.sprint, `running: ${heldKeys(bot)}`)
  system1.stop()
  assert.equal(heldKeys(bot), '(none)', 'stopping the reflex releases everything')
})

test('fleePlan() works without the full pathfinder wrapper (harness A uses it this way)', () => {
  const bot = world.makeWorld()
  world.addMob(bot, 5, 'zombie', 0.5, 4.5)
  const map = new PredictiveThreatMap()
  const plan = fleePlan(bot, map, { distance: 14 })
  assert.ok(plan && plan.goal, 'a destination')
  assert.ok(plan.z < bot.entity.position.z - 8, `away from the zombie (z=${plan.z})`)
  assert.equal(fleePlan(world.makeWorld(), new PredictiveThreatMap()), null, 'nothing to flee from → no plan')
})

test('reconnect policy is one function for both harnesses', () => {
  const base = { reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 3 }, botName: 'Zinc' }
  assert.deepEqual(decideReconnect({ ...base, kind: 'end', text: 'socketClosed', everSpawned: false }).reason, 'join-failed')
  const retry = decideReconnect({ ...base, kind: 'end', text: 'socketClosed', everSpawned: true, attempts: 0 })
  assert.deepEqual(retry, { action: 'retry', attempt: 1, maxAttempts: 3, delayMs: 1000 })
  assert.equal(decideReconnect({ ...base, kind: 'end', everSpawned: true, attempts: 2 }).delayMs, 4000, 'back-off doubles')
  assert.equal(decideReconnect({ ...base, kind: 'end', everSpawned: true, attempts: 3 }).reason, 'reconnect-exhausted')
  assert.equal(decideReconnect({ ...base, kind: 'kicked', text: 'You are banned from this server', everSpawned: true }).action, 'exit')
  assert.equal(decideReconnect({ ...base, kind: 'kicked', text: 'Server closed', everSpawned: true }).action, 'retry', 'a restart is worth a retry')
  assert.equal(require('../zincai/index.js').decideReconnect, decideReconnect)
})

test('arbiter.reassert restores its current goal and keys after an external pathfinder reset', () => {
  const bot = makeBot()
  const arbiter = new ControlArbiter(bot)
  const task = arbiter.lane('task', PRIORITY.task)
  const goal = { id: 'walk' }
  task.acquire()
  task.setGoal(goal)
  task.setControlState('forward', true)

  // Anti-stuck and other legacy code may still clear controls/goals directly.
  bot.pathfinder.setGoal(null)
  bot.setControlState('back', true)
  arbiter.reassert()
  assert.equal(bot.pathfinder.goal, goal)
  assert.equal(bot.controls.forward, true)
  assert.equal(bot.controls.back, false, 'keys no lane owns are released')
  task.release()
})

test('watchdog aborts its key pulses when survival takes over and reasserts the flee lane', async () => {
  const bot = makeBot()
  const arbiter = new ControlArbiter(bot)
  const task = arbiter.lane('task', PRIORITY.task)
  const survival = arbiter.lane('survival', PRIORITY.survival)
  const moveGoal = { id: 'move' }
  const fleeGoal = { id: 'flee' }
  task.acquire(); task.setGoal(moveGoal); task.setControlState('forward', true)
  survival.acquire(); survival.setGoal(fleeGoal); survival.setControlState('sprint', true)
  let reports = 0
  const watchdog = new AntiStuckWatchdog(bot, {
    goalActiveProvider: () => true,
    goalProvider: () => ({ goal: moveGoal, dynamic: false }),
    abortProvider: () => arbiter.owner() === 'survival',
    reapply: () => arbiter.reassert(),
    onUnstuck: () => { reports++ }
  })

  await watchdog._recover()
  assert.equal(bot.pathfinder.goal, fleeGoal, 'the urgent survival goal wins')
  assert.equal(bot.controls.sprint, true, 'the flee key is restored')
  assert.equal(bot.controls.forward, false, 'the task key stays preempted')
  assert.equal(bot.log.looks.length, 0, 'it did not turn around after the threat arrived')
  assert.equal(watchdog.unstuckCount, 0)
  assert.equal(reports, 0, 'an aborted recovery is not reported as successful')
  arbiter.stop()
})

test('elytra deploy without a carried or equipped elytra is a safe no-op', async () => {
  const bot = makeBot()
  const controller = new ElytraController(bot)
  assert.deepEqual(await controller.deploy('manual'), { ok: false, why: 'no_elytra' })
  assert.equal(bot.log.elytraFly, 0)
  assert.equal(bot.log.activate, 0)
  assert.equal(heldKeys(bot), '(none)')
})
