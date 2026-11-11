/**
 * Regression tests for the pre-release audit (audit/REPORT.md).
 *
 * One test per defect, named by its id in the report. Pathfinding tests use the
 * REAL mineflayer-pathfinder A* on a synthetic world; session tests run the
 * shipped session against a simulated bot and a scripted model. No server, no
 * network.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { editableWorld, walkTo } = require('./helpers/walk')
const { PathfinderWrapper } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const doors = require('../zincai/custom_mineflayer/doors')
const { Vec3, goals, Movements } = world

// ---------------------------------------------------------------------------
// M1 / M2 — doors and gates
// ---------------------------------------------------------------------------

/** A walled room (interior x -3..3, z -3..2) whose only exit is the 1x2 opening at (0, 64, 3). */
const roomWalls = (x, y, z) => {
  if (y <= 63) return true
  if (y > 66) return false
  const wall = ((x === -4 || x === 4) && z >= -4 && z <= 3) || ((z === -4 || z === 3) && x >= -4 && x <= 4)
  return wall && !(x === 0 && z === 3 && y <= 65)
}
const OUTSIDE = new goals.GoalBlock(0, 64, 6)

function roomBot (opts) {
  const bot = editableWorld(roomWalls, opts)
  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
  const wrapper = new PathfinderWrapper(bot, { allowDigging: false, enableWindCharge: false })
  wrapper.apply()
  bot.replan = false
  return { bot, wrapper, movements }
}

test('M1: a closed cherry door is opened once, walked through, and closed again', async () => {
  const { bot, wrapper } = roomBot()
  bot.placeDoor(0, 64, 3, 'cherry_door', { open: false, facing: 'north' })
  const r = await walkTo(bot, wrapper, OUTSIDE)
  wrapper.stop()
  assert.equal(r.status, 'success')
  assert.equal(r.arrived, true, 'the bot got out of the room')
  assert.equal(bot.clicks.length, 2, `one click to open, one to close (got ${JSON.stringify(bot.clicks)})`)
  assert.equal(bot.isOpen(0, 64, 3), false, 'the door is closed again')
  assert.equal(wrapper.openedDoors().length, 0, 'nothing left in the ledger')
})

test('M1: an OPEN door and an OPEN gate are simply walked through — and left as they were', async () => {
  for (const place of [(b) => b.placeDoor(0, 64, 3, 'oak_door', { open: true }), (b) => b.placeGate(0, 64, 3, 'oak_fence_gate', { open: true })]) {
    const { bot, wrapper } = roomBot()
    place(bot)
    const r = await walkTo(bot, wrapper, OUTSIDE)
    wrapper.stop()
    assert.equal(r.arrived, true)
    assert.equal(bot.clicks.length, 0, 'somebody left it open; it is not ours to close')
    assert.equal(bot.isOpen(0, 64, 3), true)
  }
})

test('M1: a cherry fence gate (unknown to upstream) is opened, passed and shut behind the bot', async () => {
  const { bot, wrapper } = roomBot()
  bot.placeGate(0, 64, 3, 'cherry_fence_gate', { open: false })
  const r = await walkTo(bot, wrapper, OUTSIDE)
  wrapper.stop()
  assert.equal(r.arrived, true)
  assert.equal(bot.clicks.length, 2)
  assert.equal(bot.isOpen(0, 64, 3), false, 'the animals stay in')
  const shutAt = bot.clicks[1].tick - bot.clicks[0].tick
  assert.ok(shutAt < 40, `closed within two seconds of opening (took ${shutAt} ticks)`)
})

test('M1: a slow server never sees a second click that would shut the door again', async () => {
  const { bot, wrapper } = roomBot({ latencyTicks: 7 }) // 350 ms before the block changes
  bot.placeDoor(0, 64, 3, 'spruce_door', { open: false })
  const r = await walkTo(bot, wrapper, OUTSIDE)
  wrapper.stop()
  assert.equal(r.arrived, true)
  assert.equal(bot.clicks.length, 2)
  assert.equal(bot.isOpen(0, 64, 3), false)
})

test('M1: iron doors are never clicked — shut is a wall, open is a doorway', async () => {
  const shut = roomBot()
  shut.bot.placeDoor(0, 64, 3, 'iron_door', { open: false })
  assert.equal(world.plan(shut.bot, shut.movements, OUTSIDE, { timeout: 1500 }).status, 'noPath')
  shut.wrapper.stop()

  const open = roomBot()
  open.bot.placeDoor(0, 64, 3, 'iron_door', { open: true })
  const r = await walkTo(open.bot, open.wrapper, OUTSIDE)
  open.wrapper.stop()
  assert.equal(r.arrived, true)
  assert.equal(open.bot.clicks.length, 0)
})

test('M1: a door mounted sideways ("closed" leaves the doorway free) is read by its geometry', async () => {
  // facing east in a north–south passage: open=false does not block; open=true does.
  const free = roomBot()
  free.bot.placeDoor(0, 64, 3, 'oak_door', { open: false, facing: 'east' })
  let r = await walkTo(free.bot, free.wrapper, OUTSIDE)
  free.wrapper.stop()
  assert.equal(r.arrived, true)
  assert.equal(free.bot.clicks.length, 0, 'nothing in the way, nothing clicked')

  const across = roomBot()
  across.bot.placeDoor(0, 64, 3, 'oak_door', { open: true, facing: 'east' })
  r = await walkTo(across.bot, across.wrapper, OUTSIDE)
  across.wrapper.stop()
  assert.equal(r.arrived, true)
  assert.equal(across.bot.clicks.length, 2)
  assert.equal(across.bot.isOpen(0, 64, 3), true, 'put back the way it was found')
})

test('M1: a door that will not open (a claim) is given up after three clicks and reported', async () => {
  const { bot, wrapper, movements } = roomBot({ locked: ['0,64,3'] })
  bot.placeDoor(0, 64, 3, 'oak_door', { open: false })
  const r = await walkTo(bot, wrapper, OUTSIDE, { maxTicks: 400 })
  assert.equal(r.arrived, false)
  assert.equal(bot.clicks.length, 3, 'three tries, then stop hammering it')
  assert.deepEqual({ x: wrapper.lastJam.x, y: wrapper.lastJam.y, z: wrapper.lastJam.z, name: wrapper.lastJam.name }, { x: 0, y: 64, z: 3, name: 'oak_door' })
  assert.equal(world.plan(bot, movements, OUTSIDE, { timeout: 1500 }).status, 'noPath', 'the planner now knows it is a wall')
  wrapper.stop()
})

test('M2: doors, gates and trapdoors the bot did not open are never touched', async () => {
  const bot = editableWorld(world.flat)
  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
  const wrapper = new PathfinderWrapper(bot, { enableWindCharge: false })
  wrapper.apply()
  bot.placeTrapdoor(1, 64, 1, 'cherry_trapdoor', { open: true }) // decoration beside the route
  bot.placeDoor(5, 64, 1, 'cherry_door', { open: true }) // left open by a friend
  bot.placeGate(3, 64, -1, 'oak_fence_gate', { open: true })
  const r = await walkTo(bot, wrapper, new goals.GoalBlock(8, 64, 0))
  wrapper.stop()
  assert.equal(r.arrived, true)
  assert.deepEqual(bot.clicks, [])
})

test('M1: trapdoors are geometry only — a shut hatch is floor, an open one is not, none is clicked', () => {
  const bot = editableWorld((x, y, z) => y <= 63 && !(x === 2 && z === 0 && y >= 60)) // a shaft at x=2
  const movements = new Movements(bot)
  doors.attachDoors(movements, { operate: true })
  bot.placeTrapdoor(2, 63, 0, 'oak_trapdoor', { open: false, half: 'top' })
  const over = movements.getBlock(new Vec3(1, 64, 0), 1, -1, 0)
  assert.equal(over.physical, true, 'a shut hatch can be walked over')
  bot.placeTrapdoor(2, 63, 0, 'oak_trapdoor', { open: true, half: 'top' })
  const hole = movements.getBlock(new Vec3(1, 64, 0), 1, -1, 0)
  assert.equal(hole.physical, false, 'an open hatch is a hole')
  assert.equal(hole.openable, false)
})

test('M1: the same door rules tell what a MOB can reach (it cannot open anything)', () => {
  const shut = editableWorld(roomWalls)
  shut.placeDoor(0, 64, 3, 'oak_door', { open: false })
  const m1 = new Movements(shut); m1.canDig = false
  doors.attachDoors(m1, { operate: false })
  assert.equal(world.plan(shut, m1, OUTSIDE, { timeout: 1500 }).status, 'noPath')

  const open = editableWorld(roomWalls)
  open.placeDoor(0, 64, 3, 'oak_door', { open: true })
  const m2 = new Movements(open); m2.canDig = false
  doors.attachDoors(m2, { operate: false })
  assert.equal(world.plan(open, m2, OUTSIDE, { timeout: 1500 }).status, 'success')
})

test('M1: with digging allowed, a jammed door is still never broken', () => {
  const bot = editableWorld(roomWalls)
  bot.placeDoor(0, 64, 3, 'iron_door', { open: false })
  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)
  const wrapper = new PathfinderWrapper(bot, { allowDigging: true, enableWindCharge: false })
  wrapper.configureMovements(movements)
  const r = world.plan(bot, movements, OUTSIDE, { timeout: 1500 })
  const broken = r.path.flatMap((n) => n.toBreak.map((p) => bot.blockAt(new Vec3(p.x, p.y, p.z)).name))
  assert.equal(broken.some((name) => /door/.test(name)), false, `broke: ${broken.join(',')}`)
})

// ---------------------------------------------------------------------------
// T1 — pets on 26.3 (entity metadata is read by key name, not by position)
// ---------------------------------------------------------------------------
const threats = require('../zincai/threats')
const { makeBot, ent, heldKeys } = require('./helpers/mockbot')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quiet = { info () {}, warn () {}, debug () {}, error () {} }

test('T1: a tamed wolf is a pet on 26.3 (tame flag at 18) and on 1.21.4 (17); a wild one is not', () => {
  try {
    const data263 = threats.useRegistry(require('minecraft-data')('26.3'))
    assert.deepEqual(data263.problems, [], 'the 26.3 game data names every key the harness reads')
    const wolf = (metadata) => ent(40, 'wolf', 2.5, 0.5, { metadata: Object.assign([], metadata) })
    assert.equal(threats.isTamed(wolf({ 18: 0x04 })), true, 'flags moved to index 18')
    assert.equal(threats.isProtected(wolf({ 18: 0x04 })), true)
    assert.equal(threats.isTamed(wolf({ 17: 0x04 })), false, 'index 17 is age_locked on 26.3 — the old read')
    assert.equal(threats.isTamed(wolf({ 18: 0, 19: '0b6f0c2e-1111-2222-3333-444455556666' })), true, 'an owner is enough')
    assert.equal(threats.isProtected(wolf({ 18: 0 })), false, 'a wild wolf can be fought')
    assert.equal(threats.isProtected(ent(41, 'horse', 2.5, 0.5, { metadata: Object.assign([], { 18: 0x02 }) })), true, 'a tamed horse')

    threats.useRegistry(require('minecraft-data')('1.21.4'))
    assert.equal(threats.isTamed(wolf({ 17: 0x04 })), true, 'the same bit, one position earlier')
    assert.equal(threats.isTamed(wolf({ 17: 0 })), false)
    assert.equal(threats.isTamed(wolf({ 17: 0, 18: '0b6f0c2e-1111-2222-3333-444455556666' })), true, 'on 1.21.4 the owner sits at 18')
  } finally { threats.useRegistry(null) }
  // No game data at all (unit tests, an unknown version): the classic positions.
  assert.equal(threats.isTamed(ent(42, 'wolf', 2.5, 0.5, { metadata: Object.assign([], { 17: 0x04 }) })), true)
})

test('T1: hostile lists follow the game data — a piglin is hostile unless the bot wears gold; endermen are left alone', () => {
  const bot = makeBot()
  bot.entities[2] = ent(2, 'piglin', 0.5, 4.5)
  bot.entities[3] = ent(3, 'enderman', 3.5, 0.5)
  bot.entities[4] = ent(4, 'zombified_piglin', -3.5, 0.5)
  const sense = new threats.ThreatSense(bot)
  assert.deepEqual(sense.assess().threats.map((t) => t.name), ['piglin'])
  bot.inventory.slots[6] = { name: 'golden_chestplate' }
  assert.deepEqual(sense.assess().threats.map((t) => t.name), [])
  // …until one of the neutral ones actually hits.
  sense.noteAttacker(bot.entities[3])
  assert.deepEqual(sense.assess().threats.map((t) => t.name), ['enderman'])
})

// ---------------------------------------------------------------------------
// T2 / T3 — the threat picture and the escape: one count, one episode
// ---------------------------------------------------------------------------
const { System1, chooseFood } = require('../zincai/system1')
const { ReflexRegistry } = require('../zincai/reflex_registry')
const { ControlArbiter } = require('../zincai/control')
const tactics = require('../zincai/tactics')

test('T3: hostiles are counted once — near ones start the escape, far ones in the open are watched, caged ones are neither', () => {
  const bars = (p) => {
    const y = Math.floor(p.y); const z = Math.floor(p.z)
    if (y < 64) return { name: 'stone', boundingBox: 'block', position: p }
    return z === -10 && y <= 66 ? { name: 'iron_bars', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
  }
  const bot = makeBot({ blockAt: bars })
  for (let i = 0; i < 4; i++) bot.entities[10 + i] = ent(10 + i, 'zombie', i - 1.5, 6.5) // close, in the open
  for (let i = 0; i < 9; i++) bot.entities[20 + i] = ent(20 + i, 'zombie', i * 2 - 8, 20.5) // 20 blocks out, in the open
  for (let i = 0; i < 3; i++) bot.entities[40 + i] = ent(40 + i, 'zombie', i - 1, -14.5) // behind the bars
  const sense = new threats.ThreatSense(bot)
  const seen = sense.assess()
  assert.equal(seen.threats.length, 4, 'inside the trigger ring')
  assert.equal(seen.watch.length, 9, 'coming, not yet close')
  assert.equal(seen.hidden.length, 3, 'no line on the bot')
  assert.equal(sense.coming().length, 13, 'what the model is shown as one number')
  assert.equal(seen.dangerIds.size, 13)

  const picture = tactics.situation(bot, sense.coming())
  const [head, pressure, odds] = tactics.describeSituation(picture)
  assert.match(head, /^13 in sight — zombie x13 \(nearest \d+m \w+\)$/)
  assert.match(pressure, /^pressure: 4 within 8m.*\| ways out: open /)
  assert.match(odds, /you would take ≈ \d+ dmg → BAD$/, 'thirteen zombies with bare hands is not a fight')
  // The same bot in full diamond with a diamond sword against one zombie: fine.
  const tank = makeBot({ items: [{ name: 'diamond_sword' }], held: 'diamond_sword' })
  for (const [slot, name] of [[5, 'diamond_helmet'], [6, 'diamond_chestplate'], [7, 'diamond_leggings'], [8, 'diamond_boots']]) tank.inventory.slots[slot] = { name }
  tank.entities[9] = ent(9, 'zombie', 0.5, 5.5)
  const s2 = new threats.ThreatSense(tank)
  s2.assess()
  assert.match(tactics.describeSituation(tactics.situation(tank, s2.coming()))[2], /diamond_sword 7 dmg, armor 20\/20.*→ GOOD$/)
})

function reflexRig (bot, opts = {}) {
  let t = 1_000_000
  const clock = { now: () => t, advance: (ms) => { t += ms } }
  const arbiter = new ControlArbiter(bot, { now: clock.now })
  const events = []
  const sense = new threats.ThreatSense(bot, { now: clock.now })
  const s1 = new System1(bot, { registry: new ReflexRegistry(), logger: quiet, arbiter, sense, now: clock.now, onEvent: (e) => events.push(e), ...opts })
  s1.registerBuiltins()
  const step = async (ms = 200) => { clock.advance(ms); await s1.tick() }
  return { s1, sense, arbiter, events, clock, step }
}

test('T2: one escape is one episode — a mob hovering at the old 12-block line no longer flips "fleeing" and "safe"', async () => {
  const bot = makeBot()
  const zombie = ent(5, 'zombie', 0.5, 6.5)
  bot.entities[5] = zombie
  const { s1, events, step } = reflexRig(bot)
  await step()
  assert.equal(s1.fleeing, true)
  assert.equal(events.length, 1)
  assert.equal(events[0].urgent, true, 'the start of an escape may jump the queue')
  assert.match(events[0].text, /^reflex: started FLEEING — zombie came close \(6m S\)$/)

  // The zombie drops back to 13, 16, 13, 16 blocks: outside the trigger ring, inside the release ring.
  for (let i = 0; i < 20; i++) { zombie.position.z = 0.5 + (i % 2 ? 16 : 13); await step() }
  assert.equal(s1.fleeing, true, 'still the same escape')
  assert.equal(events.length, 1, 'and not one more wake-up in four seconds of hovering')

  // It gives up and wanders off for good.
  zombie.position.z = 40.5
  await step()
  assert.equal(heldKeys(bot), '(none)', 'nothing follows: stop and look back')
  for (let i = 0; i < 25 && s1.fleeing; i++) await step()
  assert.equal(s1.fleeing, false)
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'safe')
  assert.match(events[1].text, /^reflex: safe again — fled \d+s from zombie \(ran \d+m\); nothing hostile follows within 22m$/)
  assert.match(s1.reflexLine(), /^\d+s ago you FLED by reflex for \d+s from zombie \(ran \d+m from 0,64,0\); it ended because nothing followed any more\.$/)
})

test('T2: during an escape the model hears about material changes only, and "still fleeing" twice a minute', async () => {
  const bot = makeBot()
  for (let i = 0; i < 3; i++) bot.entities[10 + i] = ent(10 + i, 'zombie', i - 1, 7.5)
  const { s1, events, step } = reflexRig(bot)
  await step()
  assert.equal(events.length, 1)
  const follow = () => { for (const e of Object.values(bot.entities)) if (e !== bot.entity) e.position.z = bot.entity.position.z + 8 }
  // Ten seconds of the same three zombies: nothing to tell.
  for (let i = 0; i < 50; i++) { follow(); await step() }
  assert.equal(events.length, 1)
  // The horde triples, and a skeleton joins.
  for (let i = 0; i < 7; i++) bot.entities[20 + i] = ent(20 + i, 'zombie', i - 3, 9.5)
  bot.entities[30] = ent(30, 'skeleton', 4.5, 9.5)
  follow(); await step()
  assert.equal(events.length, 2)
  assert.match(events[1].text, /^reflex: still FLEEING after \d+s — now also skeleton; many more of them now$/)
  assert.equal(events[1].urgent, false)
  // A creeper lights up next to it: that one does not wait for the report gap.
  const creeper = ent(31, 'creeper', 0.5, 3.5, { metadata: Object.assign([], { 16: 1 }) })
  bot.entities[31] = creeper
  await step()
  assert.equal(events.length, 3)
  assert.match(events[2].text, /a creeper's FUSE IS LIT/)
  assert.equal(events[2].urgent, true)
  delete bot.entities[31]
  // Then nothing new for 31 seconds: one "still fleeing".
  const before = events.length
  for (let i = 0; i < 155; i++) { follow(); await step() }
  const dragging = events.slice(before)
  assert.equal(dragging.length, 1)
  assert.match(dragging[0].text, /^reflex: still FLEEING after \d+s — they keep coming$/)
  assert.match(s1.reflexLine(), /^FLEEING for \d+s from zombie x10, skeleton, creeper — ran \d+m from 0,64,0\. The body did this by itself; idle keeps it running\.$/)
  assert.match(s1.reflexLine({ brief: true }), /^FLEEING by reflex \d+s, ran \d+m$/)
  s1.stop()
})

test('T5: a decision ends for a reason, and the model is told when the body runs again', async () => {
  const bot = makeBot()
  const zombie = ent(5, 'zombie', 0.5, 6.5)
  bot.entities[5] = zombie
  const { s1, sense, events, clock, step } = reflexRig(bot)
  await step()
  s1.acknowledge(events[0].threatIds, { label: 'hold', ttlMs: 30 * 60_000 }) // as the hold tool does
  assert.equal(s1.fleeing, false, '"hold" stops the escape at once')
  assert.equal(events[1].type, 'fled', 'the escape it interrupted is still on record')
  assert.equal(events[1].wake, false)
  assert.match(s1.decisionLine(), /^you chose hold \d+s ago about 1 listed threat; the body will not run from them, whatever you do next, unless one of them hurts you$/)
  // A task that ends takes its own decision with it — not the hold (it used to: any finished task wiped it).
  s1.clearDecision()
  await step()
  assert.equal(s1.fleeing, false, 'still held after a task ended')
  // Ten minutes of the same zombie standing there: nothing (the old acknowledgement ran out after 60–120 s, silently).
  for (let i = 0; i < 60; i++) { clock.advance(10_000); await s1.tick() }
  assert.equal(s1.fleeing, false)
  assert.equal(events.length, 2)
  // It hits the bot after all: accepted no longer.
  sense.noteAttacker(zombie)
  await step()
  assert.equal(s1.fleeing, true)
  assert.match(events[2].text, /^reflex: started FLEEING — zombie came close/)

  // The model, shown "zombie (…; hit you)", decides again: that decision knows about the hit.
  s1.acknowledge([5], { label: 'go_to', ttlMs: 5000 })
  assert.equal(s1.fleeing, false)
  // A decision that simply runs out is named in the report that follows.
  clock.advance(6000)
  await s1.tick()
  assert.equal(s1.fleeing, true)
  assert.match(events[events.length - 1].text, /started FLEEING — zombie came close \(\d+m S\) \(your "go_to" decision from \d+s ago ran out\)/)
  s1.stop()
})

// ---------------------------------------------------------------------------
// The escape route: walls, drops and the clock
// ---------------------------------------------------------------------------
const { planEscape, clearToRun, runnableHeading } = require('../zincai/custom_mineflayer/escape')

function escapeRig (solid, mobs, at = [0.5, 0.5]) {
  const bot = world.makeWorld(solid)
  bot.entity.position = new Vec3(at[0], 64, at[1])
  bot.pathfinder = { movements: null, bestHarvestTool: () => null }
  const movements = new Movements(bot)
  bot.pathfinder.movements = movements
  const wrapper = new PathfinderWrapper(bot, { allowDigging: false, enableWindCharge: false })
  wrapper.configureMovements(movements)
  const pursuers = mobs.map(([x, z, speed = 2.3, reach = 1.6]) => ({ x, y: 64, z, speed, reach }))
  return { bot, wrapper, pursuers, plan: (opts) => wrapper.escapePlan(pursuers, { budgetMs: 500, ...opts }) }
}
const nearestTo = (pursuers, cell) => Math.min(...pursuers.map((m) => Math.hypot(m.x - (cell.x + 0.5), m.z - (cell.z + 0.5))))

test('escape: in a dead-end corridor the bot backs into the end and says CORNERED — it does not run through the horde', () => {
  const corridor = (x, y, z) => y <= 63 ||
    (y >= 64 && y <= 66 && (((x === -2 || x === 2) && z >= -1 && z <= 20) || (z === -1 && x >= -2 && x <= 2))) ||
    (y === 67 && x >= -2 && x <= 2 && z >= -1 && z <= 20)
  const zombies = [[0.5, 8.5], [-0.5, 9.5], [1.5, 10.5], [0.5, 11.5], [-0.5, 12.5], [1.5, 13.5]]
  const { plan, pursuers } = escapeRig(corridor, zombies, [0.5, 2.5])
  const p = plan()
  assert.equal(p.why, 'pocket')
  assert.equal(p.cornered, true)
  assert.ok(p.target.z <= 1, `backs toward the closed end (target z=${p.target.z})`)
  assert.ok(p.path.every((c) => nearestTo(pursuers, c) > 5), 'no step of the plan goes near a zombie')
  assert.match(tactics.cornerText(p.why), /^CORNERED/)

  // They arrive. Nothing is safe any more: the way out is THROUGH, by the least contact.
  const packed = [[0.5, 2.9], [-0.5, 3.2], [1.5, 3.4], [0.5, 4.3], [-0.5, 4.9], [1.5, 5.2]]
  const late = escapeRig(corridor, packed, [0.5, 0.5]).plan()
  assert.equal(late.why, 'chased', 'the ground goes on beyond them')
  assert.ok(late.target.z > 8, `breaks out past them (target z=${late.target.z})`)
})

test('escape: a cliff behind the bot is not "away" — the plan runs along the edge, never over it', () => {
  const cliff = (x, y, z) => (z <= -5 ? y <= 40 : y <= 63)
  const { plan, pursuers } = escapeRig(cliff, [[0.5, 8.5], [3.5, 9.5], [-3.5, 9.5], [0.5, 11.5]], [0.5, -0.5])
  const p = plan()
  assert.equal(p.why, 'open')
  assert.ok(p.path.every((c) => c.z > -5 && c.y === 64), 'every cell of the route is on the plateau')
  assert.ok(Math.abs(p.target.x) >= 8, `sideways along the edge (target ${p.target.x},${p.target.z})`)
  assert.ok(p.path.every((c) => nearestTo(pursuers, c) > 4))
})

test('escape: a ring of zombies with one gap — the plan goes through the gap', () => {
  const ring = []
  for (let i = 0; i < 16; i++) { const a = (i / 16) * 2 * Math.PI; if (Math.abs(a - Math.PI * 1.5) >= 0.6) ring.push([0.5 + Math.sin(a) * 8, 0.5 - Math.cos(a) * 8]) }
  const { plan, pursuers } = escapeRig(world.flat, ring)
  const p = plan()
  assert.equal(p.why, 'open')
  assert.equal(p.cornered, false)
  assert.ok(p.target.x < -8, `west, where the gap is (target ${p.target.x},${p.target.z})`)
  assert.ok(p.path.every((c) => nearestTo(pursuers, c) > 2.4), 'and it threads the gap, not a zombie')
})

test('escape: a player who keeps up on open ground is "chased", never "cornered" — only walls make a dead end', () => {
  // Found by the loopback run against a real server: one player on a flat world, 5-6
  // blocks away. A few cells beside the bot were safe by a hair and none further out
  // (he is as fast as the bot), so the plan was a "pocket": the model was told
  // "CORNERED — the only safe ground is a dead end" in the middle of a field.
  const verdicts = new Set()
  for (let gap = 3; gap <= 12; gap += 0.25) {
    for (const [ux, uz] of [[1, 0], [0, 1], [0.7071, 0.7071], [-0.8, 0.6], [0.3162, -0.9487]]) {
      const p = escapeRig(world.flat, [[0.5 + ux * gap, 0.5 + uz * gap, 5.6, 3]]).plan()
      verdicts.add(p.why)
      assert.equal(p.cornered, false, `player ${gap} blocks off (${ux},${uz}): ${p.why}`)
      // …and the run goes away from him, a real distance — not to a "safe" cell next door.
      const away = -((p.target.x + 0.5 - 0.5) * ux + (p.target.z + 0.5 - 0.5) * uz)
      assert.ok(away > 6, `player ${gap} blocks off (${ux},${uz}): runs ${away.toFixed(1)} blocks away (${p.why})`)
    }
  }
  assert.deepEqual([...verdicts].sort(), ['chased', 'open'])
  // The reflex's own budget (the flood stops early) must not change the answer.
  const hurried = escapeRig(world.flat, [[6.0, 0.5, 5.6, 3]]).plan({ budgetMs: 18 })
  assert.equal(hurried.cornered, false)
  assert.equal(hurried.why, 'chased')

  // Walls still do: the same player at the mouth of a dead-end corridor is a pocket.
  const corridor = (x, y, z) => y <= 63 ||
    (y >= 64 && y <= 66 && (((x === -2 || x === 2) && z >= -1 && z <= 20) || (z === -1 && x >= -2 && x <= 2))) ||
    (y === 67 && x >= -2 && x <= 2 && z >= -1 && z <= 20)
  const boxed = escapeRig(corridor, [[0.5, 16.5, 5.6, 3]], [0.5, 8.5]).plan()
  assert.equal(boxed.why, 'pocket')
  assert.equal(boxed.cornered, true)
  assert.ok(boxed.target.z < 8, 'backs toward the closed end')
})

test('escape: what kind of fix it is — chased by something as fast, surrounded on open ground, trapped in a closed room', () => {
  // A player with a sword 2.5 blocks away is as fast as the bot: nothing is "safe", but the field is open.
  const chased = escapeRig(world.flat, [[3.0, 0.5, 5.6, 3]]).plan()
  assert.equal(chased.why, 'chased')
  assert.equal(chased.cornered, false, 'not a trap: the ground goes on')
  assert.ok(chased.target.x < -4, 'directly away')
  // Eight zombies shoulder to shoulder around the bot.
  const tight = []
  for (let i = 0; i < 8; i++) { const a = (i / 8) * 2 * Math.PI; tight.push([0.5 + Math.sin(a) * 2.2, 0.5 - Math.cos(a) * 2.2]) }
  const surrounded = escapeRig(world.flat, tight).plan()
  assert.equal(surrounded.why, 'surrounded')
  assert.equal(surrounded.cornered, true)
  assert.ok(Math.hypot(surrounded.target.x, surrounded.target.z) > 6, 'it still goes for the outside rather than stand there')
  // A sealed 5x5 room with two zombies inside. While they are still across the room
  // the corner is a pocket (a few seconds in hand, nowhere to go)…
  const cell = (x, y, z) => y <= 63 || (y <= 66 && (Math.abs(x) === 3 || Math.abs(z) === 3) && Math.abs(x) <= 3 && Math.abs(z) <= 3) || (y === 67 && Math.abs(x) <= 3 && Math.abs(z) <= 3)
  const pocket = escapeRig(cell, [[2.5, 1.5], [1.5, 2.5]], [-1.5, -1.5]).plan()
  assert.equal(pocket.why, 'pocket')
  assert.equal(pocket.cornered, true)
  // …and in a sealed closet with a zombie already on the bot it is trapped: nothing is
  // safe and there is no outside to break out to.
  const closet = (x, y, z) => y <= 63 || (y <= 66 && !(x === 0 && z >= 0 && z <= 2)) || y === 67
  const trapped = escapeRig(closet, [[0.5, 1.3]], [0.5, 0.5]).plan()
  assert.equal(trapped.why, 'trapped')
  assert.equal(trapped.cornered, true)
  assert.match(tactics.cornerText(trapped.why), /^TRAPPED/)
  // A creeper four blocks behind is close, not fast: an ordinary escape, straight away.
  const creeper = escapeRig(world.flat, [[0.5, 4.5, 2.8, 4.5]]).plan()
  assert.equal(creeper.why, 'open')
  assert.ok(creeper.target.z < -4 && Math.abs(creeper.target.x) <= 1, `straight north (target ${creeper.target.x},${creeper.target.z})`)
})

test('escape: the straight sprint looks before it runs — no wall, no ledge, no lava', () => {
  const wallNorth = (x, y, z) => y <= 63 || (z === -2 && y <= 66)
  const a = world.makeWorld(wallNorth)
  assert.equal(clearToRun(a, { x: 0, z: -1 }), false, 'a wall two blocks ahead')
  assert.equal(clearToRun(a, { x: 0, z: 1 }), true)
  const heading = runnableHeading(a, { x: 0, z: -1 })
  assert.ok(heading && heading.z > -0.9, 'turns to the nearest heading that has ground')
  const ledge = world.makeWorld((x, y, z) => (z <= -2 ? y <= 50 : y <= 63))
  assert.equal(clearToRun(ledge, { x: 0, z: -1 }), false, 'a 13-block drop')
  const step = world.makeWorld((x, y, z) => y <= 63 || (z <= -2 && y === 64))
  assert.equal(clearToRun(step, { x: 0, z: -1 }), true, 'a one-block step up is a jump')
  const lava = world.makeWorld((x, y, z) => (y === 63 && z === -2 ? 'lava' : y <= 63))
  assert.equal(clearToRun(lava, { x: 0, z: -1 }), false)
  const boxed = world.makeWorld((x, y, z) => y <= 63 || (y <= 66 && (Math.abs(x) === 1 || Math.abs(z) === 1) && !(x === 0 && z === 0)))
  assert.equal(runnableHeading(boxed, { x: 0, z: -1 }), null, 'walled in: it stands rather than jump at a wall')
  assert.equal(planEscape(a, null, [{ x: 0, y: 64, z: 3, speed: 2.3, reach: 1.6 }]), null, 'no map to flood: the caller falls back')
})

// ---------------------------------------------------------------------------
// T4 — eating
// ---------------------------------------------------------------------------
test('T4: a hurt bot eats to get regeneration back, even if the food overshoots; a healthy one still wastes nothing', () => {
  const steak = [{ name: 'cooked_beef', count: 12 }]
  assert.equal(chooseFood(steak, { food: 17, health: 4 })?.name, 'cooked_beef', 'at 2 hearts and 17 hunger it used to wait until 12')
  assert.equal(chooseFood(steak, { food: 15, health: 10 })?.name, 'cooked_beef')
  assert.equal(chooseFood(steak, { food: 15, health: 20 }), null, 'full health: 8 points into a 5-point gap is waste')
  assert.equal(chooseFood(steak, { food: 18, health: 4 }), null, 'at 18 the bar already regenerates')
  assert.equal(chooseFood(steak, { food: 12, health: 20 })?.name, 'cooked_beef')
  assert.equal(chooseFood([{ name: 'rotten_flesh' }], { food: 10, health: 4 }), null, 'risky food only when starving')
})

// ---------------------------------------------------------------------------
// S1 / S2 / S4 — the storage room
// ---------------------------------------------------------------------------
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PlaceIndex, chestPartner } = require('../zincai/places')
const { matchItem } = require('../zincai/skills')

/** Two facing rows of labelled double chests, with real block states. */
function storageBot (labels) {
  const { registry, Block } = world
  const placed = new Map()
  const signs = new Map()
  labels.forEach((label, i) => {
    const row = i % 2
    const x = -Math.floor(labels.length / 2) + (i - row)
    const z = row ? 8 : 0
    const facing = row ? 'north' : 'south'
    const even = ((x % 2) + 2) % 2 === 0
    const typeOf = (isEven) => (facing === 'south' ? (isEven ? 'right' : 'left') : (isEven ? 'left' : 'right'))
    placed.set(`${x},70,${z}`, Block.fromProperties(registry.blocksByName.chest.id, { facing, type: typeOf(even), waterlogged: false }, 0))
    placed.set(`${x + 1},70,${z}`, Block.fromProperties(registry.blocksByName.chest.id, { facing, type: typeOf(!even), waterlogged: false }, 0))
    const sz = row ? 7 : 1
    placed.set(`${x},70,${sz}`, Block.fromProperties(registry.blocksByName.cherry_wall_sign.id, { facing, waterlogged: false }, 0))
    signs.set(`${x},70,${sz}`, label)
  })
  placed.set('20,70,4', Block.fromStateId(registry.blocksByName.brewing_stand.defaultState, 0))
  const air = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
  const bot = {
    registry,
    game: { dimension: 'overworld' },
    entities: {},
    entity: { position: new Vec3(0.5, 70, 4.5) },
    blockAt (p) {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const b = placed.get(key) || air
      if (signs.has(key)) b.getSignText = () => [signs.get(key), '']
      return b
    },
    findBlocks ({ matching, maxDistance = 16, count = 64 }) {
      const ids = new Set(matching)
      const out = []
      for (const [key, b] of placed) {
        const [x, y, z] = key.split(',').map(Number)
        const v = new Vec3(x, y, z)
        if (v.distanceTo(bot.entity.position) <= maxDistance && ids.has(b.type)) out.push(v)
      }
      return out.sort((p, q) => p.distanceTo(bot.entity.position) - q.distanceTo(bot.entity.position)).slice(0, count)
    }
  }
  return bot
}

test('S1: a storage room is a summary with every label as an address — not nine sign texts and "+77 more"', () => {
  const labels = ['Minerios', 'Diamantes', 'Ferro', 'Ouro', 'Redstone', 'Carvao', 'Madeira', 'Pedra', 'Comida', 'Sementes', 'Mob drops', 'Ferramentas',
    'Armaduras', 'Pocoes', 'Livros', 'Encantados', 'Vidro', 'La', 'Terra', 'Areia', 'Nether', 'End', 'Decoracao', 'Diversos', 'Flores', 'Corantes', 'Concreto', 'Terracota']
  const bot = storageBot(labels)
  const places = new PlaceIndex({})
  places.scan(bot, { radius: 24, force: true })
  const chests = [...places.blocks.values()].filter((e) => e.kind === 'chest')
  assert.equal(chests.length, 28, 'every double chest once (a scan used to stop at 128 blocks)')
  assert.equal(chests.filter((c) => c.double).length, 28)
  assert.deepEqual(chests.map((c) => c.label).sort(), [...labels].sort(), 'each chest carries the sign that hangs on it')
  assert.equal(places.resolve('brewing_stand', bot.entity.position).kind, 'brewing_stand', 'stations are no longer crowded out')

  const text = places.describeNearby(bot.entity.position, { radius: 32 })
  assert.match(text, /STORAGE ROOM — 28 containers \(28 labelled, 0 opened\)\. Nearest: chest\d+ "/)
  for (const label of labels) assert.ok(text.includes(label), `label ${label} is in the prompt`)
  assert.ok(!/sign "/.test(text), 'a sign that labels a chest is not listed again as a sign')
  assert.ok(text.length < 900, `compact (${text.length} characters)`)

  // A label is an address.
  const diamonds = places.resolve('Diamantes', bot.entity.position)
  assert.equal(diamonds.label, 'Diamantes')
  assert.equal(places.resolve('diamante', bot.entity.position).id, diamonds.id, 'singular or plural')
  assert.equal(places.resolve('ferramenta', bot.entity.position).label, 'Ferramentas')
  assert.equal(places.findLabel('mob drops', bot.entity.position)[0].label, 'Mob drops')
  // …and the whole list is one call away.
  const page = places.listStorage(bot.entity.position, { perPage: 10 })
  assert.deepEqual([page.total, page.page, page.pages, page.lines.length], [28, 1, 3, 10])
  assert.match(page.lines[0], /^chest\d+ "[^"]+" \d+m \w+$/)
  places.noteContents(diamonds, { diamond: 12, emerald: 3 }, { freeSlots: 40 })
  assert.match(places.listStorage(bot.entity.position, { perPage: 40 }).lines.find((l) => l.includes('Diamantes')), /\[diamond x12, emerald x3\]$/)
})

test('S1: two single chests side by side stay two; a left/right pair is one; an item frame is a label', () => {
  const { registry, Block } = world
  const chest = (type, facing = 'south') => Block.fromProperties(registry.blocksByName.chest.id, { facing, type, waterlogged: false }, 0)
  assert.equal(chestPartner(chest('single')), null)
  assert.deepEqual(chestPartner(chest('left', 'north')), [1, 0], 'left half facing north: the other half is to the east')
  assert.deepEqual(chestPartner(chest('right', 'north')), [-1, 0])
  assert.equal(chestPartner({ name: 'chest' }), undefined, 'a block that cannot tell its state')
  const blocks = new Map([['2,64,2', chest('single')], ['3,64,2', chest('single')], ['6,64,2', chest('left', 'north')], ['7,64,2', chest('right', 'north')]])
  const air = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
  const bot = {
    registry,
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 9: { name: 'item_frame', position: new Vec3(2.5, 64.5, 3.03), metadata: Object.assign([], { 8: { itemId: registry.itemsByName.diamond.id, itemCount: 1 } }) } },
    blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) || air,
    findBlocks: () => [...blocks.keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) })
  }
  const places = new PlaceIndex({})
  places.scan(bot, { force: true })
  const chests = [...places.blocks.values()].filter((e) => e.kind === 'chest')
  assert.equal(chests.length, 3)
  assert.equal(chests.filter((c) => c.double).length, 1)
  assert.equal(chests.find((c) => c.x === 2).label, '[diamond]', 'the frame on the first chest labels it')
  assert.equal(places.resolve('diamond', bot.entity.position).x, 2)
})

test('S3: item names mean the item — "diamond" is never the diamond pickaxe', () => {
  const inv = [{ name: 'diamond_pickaxe' }, { name: 'iron_sword' }, { name: 'oak_planks' }, { name: 'bread' }]
  assert.equal(matchItem(inv, 'diamond'), null)
  assert.equal(matchItem(inv, 'sword').name, 'iron_sword', 'the head noun is fine')
  assert.equal(matchItem(inv, 'planks').name, 'oak_planks')
  assert.equal(matchItem(inv, 'breads').name, 'bread')
  assert.equal(matchItem([...inv, { name: 'diamond' }], 'diamonds').name, 'diamond')
})

// ---------------------------------------------------------------------------
// B2 — language, B5 — memory, B4 — the client's lanes
// ---------------------------------------------------------------------------
const filter = require('../zincai/filter')
const { MemorySystem } = require('../zincai/memory')
const { AmdToolsClient } = require('../zincai/api_wrapper')

test('B2: the language check tells Brazilian Portuguese from English by its function words', () => {
  const ok = (text) => filter.checkPortuguese(text, { names: ['Gabriel', 'Pedro'] }).ok
  for (const line of ['já vou!', 'cheguei, e aí?', 'opa', 'blz', 'gg', 'ok', 'to fugindo de 12 zumbis kkk', 'peguei 3 diamond pra vc', 'foi mal, nao consigo', 'tem um creeper aqui', 'Gabriel', 'diamond x3']) {
    assert.equal(ok(line), true, `PT-BR or neutral: ${line}`)
  }
  for (const line of ['on my way!', 'ok coming', 'hello', 'I am being chased by zombies', 'sorry, I cannot do that', 'Gabriel is at 10,64,0', 'nothing here', 'done']) {
    assert.equal(ok(line), false, `not PT-BR: ${line}`)
  }
})

test('B5: what a player tells the bot is kept — by the model\'s own note, and by a filter whose stems now match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-mem-'))
  const mem = new MemorySystem({ file: path.join(dir, 'memories.json') })
  for (const line of ['guardei os diamantes no bau do segundo andar', 'coloquei a picareta na fornalha', 'deixei tua espada em cima da mesa', 'meus pais chegam amanha', 'amanha a gente vai matar o dragao']) {
    assert.ok(mem.rememberChat('Gabriel', line, { addressed: true }), `kept: ${line}`)
  }
  assert.equal(mem.rememberChat('Gabriel', 'zinc vem aqui', { addressed: true }), null, 'a request is still not a memory')
  // The model's own words rank first and are found by player.
  const fact = mem.rememberFact('Pedro é irmão do Gabriel e odeia creeper', { about: 'Gabriel' })
  assert.equal(fact.importance, 3)
  assert.equal(mem.factsAbout('Gabriel', 3)[0], 'Pedro é irmão do Gabriel e odeia creeper')
  assert.equal(mem.factsAbout('Gabriel', 10).length, 6)
  assert.deepEqual(mem.factsAbout('Ninguem'), [])
  // Events with a prompt section of their own stay out of the five-line window.
  for (let i = 0; i < 9; i++) mem.addEvent({ type: 'result', msg: `go_to: step ${i}` }, { window: false })
  mem.addEvent({ type: 'hurt', msg: 'hit by player Gabriel' })
  for (let i = 0; i < 9; i++) mem.addEvent({ type: 'threat', msg: `reflex ${i}` }, { window: false })
  assert.deepEqual(mem.working.last(6).map((e) => e.msg), ['hit by player Gabriel'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('B4: the client runs one call per lane — a reply does not queue behind a slow action call', async () => {
  const realFetch = globalThis.fetch
  const order = []
  let releaseAction
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const chat = body.tools?.[0]?.function?.name === 'reply'
    order.push(chat ? 'chat:start' : 'action:start')
    if (!chat) await new Promise((resolve) => { releaseAction = resolve })
    order.push(chat ? 'chat:end' : 'action:end')
    const call = chat ? { name: 'reply', arguments: '{"text":"oi"}' } : { name: 'idle', arguments: '{}' }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ function: call }] } }], usage: {} }), text: async () => '' }
  }
  try {
    const msgs = [{ role: 'user', content: 'x' }]
    const client = new AmdToolsClient({ apiKey: 'rc-test', baseUrl: 'http://localhost', model: 'm' })
    const action = client.chatWithTools(msgs)
    const second = client.chatWithTools(msgs) // same lane: waits its turn
    const reply = await client.chatReply(msgs)
    assert.equal(reply.reply.text, 'oi')
    assert.deepEqual(order, ['action:start', 'chat:start', 'chat:end'], 'answered while the action call was still out')
    releaseAction()
    await action
    await sleep(5)
    assert.equal(order.filter((o) => o === 'action:start').length, 2, 'the second action call started only after the first')
    releaseAction()
    await second

    // An endpoint that allows one request at a time: chat still goes to the front of the queue.
    order.length = 0
    const single = new AmdToolsClient({ apiKey: 'rc-test', baseUrl: 'http://localhost', model: 'm', maxConcurrent: 1 })
    const a1 = single.chatWithTools(msgs)
    const a2 = single.chatWithTools(msgs)
    const c1 = single.chatReply(msgs)
    await sleep(5)
    assert.deepEqual(order, ['action:start'])
    releaseAction()
    await a1
    await c1
    assert.deepEqual(order.slice(0, 4), ['action:start', 'action:end', 'chat:start', 'chat:end'], 'the reply jumped ahead of the queued action call')
    await sleep(5)
    releaseAction()
    await a2
  } finally { globalThis.fetch = realFetch }
})

// ---------------------------------------------------------------------------
// PvP — the motion a dodge is judged from
// ---------------------------------------------------------------------------
const { MotionTracker, forecastImpact, AdvancedCombat } = require('../src/combat')

test('T3: an attack the next tick would break off is refused up front — nothing engages, no lockout starts', async () => {
  const events = []
  const goals = []
  const bot = {
    health: 5, // the break-off line is 6 of 20
    food: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, height: 1.8, onGround: true },
    entities: { 9: { id: 9, type: 'hostile', name: 'zombie', position: new Vec3(2.5, 64, 0.5), velocity: new Vec3(0, 0, 0), height: 1.95, isValid: true } },
    inventory: { items: () => [], slots: [] },
    pathfinder: { setGoal (g) { goals.push(g) } },
    blockAt: () => null,
    clearControlStates () {},
    setControlState () {}
  }
  const combat = new AdvancedCombat(bot, { maxHealth: 20, onEvent: (e) => events.push(e) })
  assert.equal(combat.disengageAt, 6)
  // It used to engage here, call the flee off, break off on the next tick and lock fighting out for 10 s.
  assert.deepEqual(await combat.engage('zombie'), { ok: false, why: 'low_hp' })
  assert.equal(combat.isEngaged, false)
  assert.equal(combat.cooldownUntil, 0, 'no lockout: nothing was broken off')
  assert.deepEqual(events, [])
  assert.deepEqual(goals, [])
  // Healed: the same request goes through.
  bot.health = 20
  const r = await combat.engage('zombie')
  assert.equal(r.ok, true)
  assert.equal(r.target, 'zombie')
  combat.disengage('test over', { cooldown: false })
})

test('PvP: packet jitter neither hides a mace dive nor turns a staircase into one', () => {
  const me = { position: new Vec3(0, 64, 0), velocity: { x: 0, y: 0, z: 0 } }
  let t = 0
  // A dive from 10 blocks up; every third position update arrives a tick late.
  const tracker = new MotionTracker({ now: () => t })
  const diver = { id: 9, position: { x: 0, y: 74, z: 2 }, heldItem: { name: 'mace' } }
  tracker.update(diver)
  let v = 0
  let y = 74
  let warnedAt = null
  for (let i = 1; i <= 40 && y > 64; i++) {
    t += 50
    v = (v - 0.08) * 0.98
    y = Math.max(64, y + v)
    if (i % 3 !== 0) diver.position = { x: 0, y, z: 2 } // the late packet: no change this tick
    const f = forecastImpact(diver, me, tracker.update(diver))
    if (f && warnedAt === null) warnedAt = y
  }
  assert.ok(warnedAt !== null, 'the dive is still seen')
  assert.ok(warnedAt - 64 > 3, `with the diver still ${warnedAt === null ? '?' : (warnedAt - 64).toFixed(1)} blocks up`)

  // Walking down a long staircase toward the bot, mace in hand, same jitter: never a smash.
  const stairs = new MotionTracker({ now: () => t })
  const walker = { id: 10, position: { x: 0, y: 76, z: 14 }, heldItem: { name: 'mace' } }
  stairs.update(walker)
  let wz = 14
  let alarms = 0
  for (let i = 1; i <= 60; i++) {
    t += 50
    wz -= 0.216 // walking speed; one half-block step down per half block forward
    const wy = 64 + Math.ceil(Math.max(0, wz - 2) / 0.5) * 0.5
    if (i % 3 !== 0) walker.position = { x: 0, y: wy, z: wz }
    if (forecastImpact(walker, me, stairs.update(walker))) alarms++
  }
  assert.equal(alarms, 0, 'a friend walking downstairs with a mace is not an attack')

  // An ordinary jump on the spot, with the same jitter: nothing either.
  const hop = new MotionTracker({ now: () => t })
  const hopper = { id: 11, position: { x: 0, y: 64, z: 2 }, heldItem: { name: 'mace' } }
  hop.update(hopper)
  let hv = 0.42
  let hy = 64
  for (let i = 1; i <= 16; i++) {
    t += 50
    hy = Math.max(64, hy + hv)
    hv = (hv - 0.08) * 0.98
    if (i % 3 !== 0) hopper.position = { x: 0, y: hy, z: 2 }
    if (forecastImpact(hopper, me, hop.update(hopper))) alarms++
  }
  assert.equal(alarms, 0, 'nor is a hop')
})
