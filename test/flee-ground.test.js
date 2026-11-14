'use strict'
/**
 * Where the flee reflex runs TO (2026-11-14 live log: four deaths, each after
 * an escape that ended on a ledge, in a corner or next to more mobs).
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeWorld, Movements } = require('./helpers/world')
const { surveyGround, sectorScore, openness, standableCache } = require('../zincai/custom_mineflayer/escape')
const { makeEscapePlanner } = require('../zincai/custom_mineflayer/pathfinder_wrapper')

const zombie = (x, z, y = 64) => ({ x, y, z, speed: 2.3, reach: 1.6, name: 'zombie' })

/** Level ground for x >= 0; for x < 0 a field of 2-high pillars with one-wide lanes between them. */
const halfBroken = (x, y, z) => {
  if (y <= 63) return true
  if (x < -1 && y <= 65) return (x & 1) === 0 || (z & 1) === 0
  return false
}

test('survey: level empty ground scores above broken ground and above ground with mobs on it', () => {
  // West of x = -1: hillside, every column a different height (0..3 above the plain).
  const bot = makeWorld((x, y, z) => y <= 63 + (x < -1 ? ((x * 7 + z * 13) & 3) : 0))
  const s = surveyGround(bot, { mobs: [] })
  assert.equal(s.length, 16)
  const east = sectorScore(s, 1, 0)
  const west = sectorScore(s, -1, 0)
  assert.ok(east > 0.8, `east is a plain (${east})`)
  assert.ok(west < east - 0.5, `west is broken ground (${west} vs ${east})`)

  const flat = makeWorld()
  const withMobs = surveyGround(flat, { mobs: [{ x: 14, y: 64, z: 0 }, { x: 20, y: 64, z: 2 }, { x: 9, y: 64, z: -1 }] })
  assert.ok(sectorScore(withMobs, 1, 0) < sectorScore(withMobs, -1, 0) - 0.3, 'the side with mobs on it is the worse side')
})

test('openness: a plain is open, a one-wide lane is not', () => {
  const bot = makeWorld(halfBroken)
  const st = standableCache(bot)
  assert.ok(openness(st, 8, 64, 0) > 0.95)
  assert.ok(openness(st, -7, 64, -7) < 0.5, String(openness(st, -7, 64, -7)))
})

test('with a zombie coming from the south it runs for the open side, not into the lanes', () => {
  const bot = makeWorld(halfBroken)
  const planner = makeEscapePlanner(bot, { Movements })
  const pursuers = [zombie(0.5, 7.5)]
  const sectors = surveyGround(bot, { mobs: pursuers })
  const plan = planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0, sectors })
  assert.equal(plan.safe, true)
  assert.ok(plan.target.x >= 2, `target ${JSON.stringify(plan.target)} is on the plain`)
  assert.ok(plan.open > 0.9, `target is open ground (${plan.open})`)
  assert.ok(plan.target.z < 0, 'and away from the zombie')
  for (const c of plan.path) assert.ok(c.x >= -1, 'the way there does not go through the lanes')
})

test('it does not run into, or stop beside, mobs that are not chasing yet', () => {
  const bot = makeWorld()
  const planner = makeEscapePlanner(bot, { Movements })
  const pursuers = [zombie(0.5, 7.5)]
  // Straight "away" (north) stands a group that has not noticed anything.
  const crowd = [{ x: 0, y: 64, z: -16, notice: 12 }, { x: 4, y: 64, z: -18, notice: 12 }, { x: -4, y: 64, z: -15, notice: 12 }]
  const blind = planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0 })
  const dBlind = Math.min(...crowd.map((m) => Math.hypot(m.x - blind.target.x, m.z - blind.target.z)))
  assert.ok(dBlind < 12, `without the crowd it would have ended ${dBlind.toFixed(1)}m from them`)

  const sectors = surveyGround(bot, { mobs: [...pursuers, ...crowd] })
  const plan = planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0, crowd, sectors })
  assert.equal(plan.safe, true)
  const dEnd = Math.min(...crowd.map((m) => Math.hypot(m.x - plan.target.x, m.z - plan.target.z)))
  assert.ok(dEnd >= 12, `ends ${dEnd.toFixed(1)}m from the nearest bystander`)
  assert.ok(plan.crowd < 0.05)
  for (const c of plan.path) {
    const d = Math.min(...crowd.map((m) => Math.hypot(m.x - c.x, m.z - c.z)))
    assert.ok(d > 8, `path cell ${c.x},${c.z} passes ${d.toFixed(1)}m from a bystander`)
  }
  // Still away from the one that IS chasing.
  assert.ok(Math.hypot(plan.target.x - 0.5, plan.target.z - 7.5) > 12)
})

test('it never plans a drop of more than three blocks', () => {
  // A plateau 12 wide; everything north of z = -4 is 5 blocks lower. Zombie from the south.
  const bot = makeWorld((x, y, z) => (z < -4 ? y <= 58 : y <= 63))
  const planner = makeEscapePlanner(bot, { Movements })
  const plan = planner([zombie(0.5, 6.5)], { radius: 24, maxNodes: 1400, budgetMs: 0 })
  assert.ok(plan)
  for (let i = 1; i < plan.path.length; i++) assert.ok(plan.path[i - 1].y - plan.path[i].y <= 3, 'no long fall on the way')
  assert.equal(plan.target.y, 64, 'it stays on the plateau')
})

test('it keeps its heading instead of doubling back when two ways are equally good', () => {
  const bot = makeWorld()
  const planner = makeEscapePlanner(bot, { Movements })
  const pursuers = [zombie(0.5, 7.5)]
  const east = planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0, heading: { x: 1, z: 0 } })
  const west = planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0, heading: { x: -1, z: 0 } })
  assert.ok(east.target.x > west.target.x, `${east.target.x} vs ${west.target.x}`)
})

test('planning with ground sense stays cheap enough to redo while running', () => {
  const bot = makeWorld(halfBroken)
  const planner = makeEscapePlanner(bot, { Movements })
  const pursuers = [zombie(0.5, 7.5), zombie(5.5, 9.5)]
  planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0 }) // warm the block cache
  const t0 = performance.now()
  const sectors = surveyGround(bot, { mobs: pursuers })
  const plan = planner(pursuers, { radius: 24, maxNodes: 1400, budgetMs: 0, sectors, crowd: [{ x: 20, y: 64, z: -20, notice: 12 }] })
  const ms = performance.now() - t0
  assert.ok(plan)
  assert.ok(ms < 400, `survey + plan took ${ms.toFixed(0)} ms`)
  console.log(`# survey + plan: ${ms.toFixed(0)} ms, explored ${plan.explored}`)
})
