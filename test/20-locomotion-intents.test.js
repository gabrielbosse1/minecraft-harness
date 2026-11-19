'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const { startSimulation } = require('./helpers/sim-harness')

test('real route keeps its destination through sprint, hunger downgrade and precision restoration', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const nav = internals.navigationIntents
  const wrapper = internals.wrapper
  const route = nav.register({ id: 'real-route' })
  const fast = nav.register({ id: 'real-style' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 14, from.y, from.z)
  route.publishGoal('destination', { goal })
  await waitFor(() => bot.pathfinder.isMoving() && wrapper.locomotionStats().mode === 'walk', { label: 'normal walking' })
  route.publishLocomotion('careful', { mode: 'precision', goal, expiresAt: Date.now() + 15_000 })
  await waitFor(() => wrapper.locomotionStats().mode === 'precision' && bot.controlState.sneak, { label: 'precision approach' })
  fast.publishLocomotion('urgent-travel', { mode: 'sprint', tier: 'urgent', goal, expiresAt: Date.now() + 15_000 })
  await waitFor(() => wrapper.locomotionStats().mode === 'sprint' && bot.controlState.sprint, { label: 'sprint on same route' })
  assert.equal(bot.pathfinder.goal, goal)
  mc.setHealth(bot.username, 20, 5)
  await waitFor(() => bot.food === 5 && wrapper.locomotionStats().mode === 'walk' && !bot.controlState.sprint, { label: 'low food blocks sprint' })
  assert.equal(bot.pathfinder.goal, goal)
  nav.unregister('real-style')
  await waitFor(() => wrapper.locomotionStats().mode === 'precision', { label: 'lower directive resumes' })
  route.withdrawLocomotion('careful')
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'original goal reached' })
  const stats = wrapper.locomotionStats()
  assert.ok(stats.transitions >= 4)
  assert.ok(stats.safetyDowngrades >= 1)
  t.diagnostic(JSON.stringify(stats))
})

test('real sprint-jump route launches an optional jump on loaded flat ground', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const nav = internals.navigationIntents
  const mode = nav.register({ id: 'jump-probe' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 18, from.y, from.z)
  mode.publishLocomotion('flat-travel', { mode: 'sprint_jump', goal, expiresAt: Date.now() + 15_000 })
  mode.publishGoal('flat-route', { goal })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'sprint-jump reaches intended route destination' })
  const stats = internals.wrapper.locomotionStats()
  assert.ok(stats.optionalJumps > 0, 'loaded flat sprint route should permit at least one simulated safe jump')
  t.diagnostic(JSON.stringify(stats))
})
