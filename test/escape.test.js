'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { System1 } = require('../zincai/system1')
const { makeWorld, Movements, goals } = require('./helpers/world')
const { planEscape } = require('../zincai/custom_mineflayer/escape')
const { makeEscapePlanner } = require('../zincai/custom_mineflayer/pathfinder_wrapper')

const quiet = { debug () {}, info () {}, warn () {}, error () {} }

function clockWithStep (step) {
  let t = 0
  return () => { const out = t; t += step; return out }
}

test('escape search is stable across wall-clock load and chooses a safe destination', () => {
  const bot = makeWorld((x, y) => y <= 63)
  const planner = makeEscapePlanner(bot, { Movements })
  const pursuers = [{ x: 6, y: 64, z: 2, speed: 2.3, reach: 1.6, name: 'zombie' }]

  const first = planner(pursuers, {
    radius: 18,
    maxNodes: 700,
    budgetMs: 0,
    now: clockWithStep(1)
  })
  const second = planner(pursuers, {
    radius: 18,
    maxNodes: 700,
    budgetMs: 0,
    now: clockWithStep(1000)
  })

  assert.ok(first)
  assert.deepEqual(second.target, first.target, 'server load cannot move the chosen destination')
  assert.deepEqual(second.path, first.path, 'the same world produces the same route')
  assert.equal(first.explored, 700, 'the fixed node cap, rather than elapsed time, bounds the flood')
  assert.equal(first.why, 'open')
  assert.equal(first.safe, true)
  assert.ok(first.margin > 0)

  const away = { x: bot.entity.position.x - pursuers[0].x, z: bot.entity.position.z - pursuers[0].z }
  const run = { x: first.target.x + 0.5 - bot.entity.position.x, z: first.target.z + 0.5 - bot.entity.position.z }
  assert.ok(run.x * away.x + run.z * away.z > 0, 'the destination makes real progress away from the zombie')
  assert.ok(Math.hypot(run.x, run.z) >= 15, 'the bot gets a destination, not a short random sidestep')
  assert.ok(first.path.length >= 15)
  assert.ok(first.goal instanceof goals.GoalBlock, 'the goal is the exact cell the safety clock evaluated')
})

test('flee commits to a safe cell, waits there, and replans only when that cell is no longer safe', () => {
  let now = 1000
  let plans = 0
  const seenOptions = []
  let currentGoal = null
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5, yaw: 0, onGround: true } },
    health: 20,
    setControlState () {},
    pathfinder: {
      get goal () { return currentGoal },
      setGoal (goal) { currentGoal = goal }
    }
  }
  const target = { x: -5, y: 64, z: 0 }
  const pathfinder = {
    escapePlan (_pursuers, opts) {
      plans++
      seenOptions.push(opts)
      return {
        target,
        goal: { name: 'safe-cell' },
        direction: { x: -1, z: 0 },
        margin: 4,
        safe: true,
        leadsOut: true,
        cornered: false,
        why: 'open'
      }
    }
  }
  const system1 = new System1(bot, {
    registry: {},
    logger: quiet,
    pathfinder,
    sense: {},
    now: () => now
  })
  const zombie = { id: 2, name: 'zombie', kind: 'mob', distance: 4, entity: { id: 2, position: { x: 4, y: 64, z: 0 } } }
  const flee = () => system1.flee({ threats: [zombie] })

  flee()
  assert.equal(plans, 1)
  assert.equal(seenOptions[0].budgetMs, 0, 'production fleeing does not use a load-sensitive deadline')
  assert.equal(bot.pathfinder.goal.name, 'safe-cell')

  // Moving toward the chosen destination does not cause a fresh goal to be
  // picked just because the old 700 ms refresh interval elapsed.
  bot.entity.position.x = -1.5
  now += 700
  flee()
  assert.equal(plans, 1)
  assert.equal(bot.pathfinder.goal.name, 'safe-cell')

  // Once the bot arrives with ample time in hand, it holds that safe cell
  // instead of immediately choosing another point farther away.
  bot.entity.position.x = target.x + 0.5
  bot.entity.position.z = target.z + 0.5
  now += 100
  flee()
  assert.equal(system1._flee.safeHold, true)
  assert.equal(system1._flee.safeSpot.x, target.x)
  assert.equal(bot.pathfinder.goal, null)
  now += 200
  flee()
  assert.equal(plans, 1, 'a safe hold does not keep issuing new escape plans')

  // A threat reaching the held cell erodes the margin and starts a new plan.
  zombie.entity.position.x = target.x + 0.5
  zombie.entity.position.z = target.z + 0.5
  now += 50
  flee()
  assert.equal(system1._flee.safeHold, false)
  assert.equal(plans, 2)
})

test('a chased best-effort route stays committed until its margin materially worsens', () => {
  let now = 2000
  let plans = 0
  let currentGoal = null
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5, yaw: 0, onGround: true } },
    health: 20,
    setControlState () {},
    pathfinder: {
      get goal () { return currentGoal },
      setGoal (goal) { currentGoal = goal }
    }
  }
  const target = { x: -5, y: 64, z: 0 }
  const pathfinder = {
    escapePlan () {
      plans++
      return {
        target,
        goal: { name: 'best-effort-route' },
        direction: { x: -1, z: 0 },
        margin: -1,
        safe: false,
        leadsOut: true,
        cornered: false,
        why: 'chased'
      }
    }
  }
  const system1 = new System1(bot, { registry: {}, logger: quiet, pathfinder, sense: {}, now: () => now })
  const player = { id: 7, name: 'player', kind: 'player', distance: 6, entity: { id: 7, position: { x: 6, y: 64, z: 0 } } }
  const flee = () => system1.flee({ threats: [player] })

  flee()
  assert.equal(plans, 1)
  bot.entity.position.x = -1.5
  now += 700
  flee()
  assert.equal(plans, 1, 'the timer alone does not replace an unsafe-but-best-available route')

  player.entity.position.x = target.x + 0.5
  player.entity.position.z = target.z + 0.5
  now += 100
  flee()
  assert.equal(plans, 2, 'a meaningful loss of time-to-impact causes a fresh escape plan')
})
