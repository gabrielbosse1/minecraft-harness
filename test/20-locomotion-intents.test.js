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
  const goal = new goals.GoalBlock(from.x + 36, from.y, from.z)
  mode.publishGoal('flat-route', { goal })
  const wrapper = internals.wrapper
  const samples = []
  const sample = () => samples.push({ pulse: wrapper._jumpPulseUntil, jump: bot.controlState.jump, grounded: bot.entity.onGround })
  bot.on('physicsTick', sample)
  t.after(() => bot.removeListener('physicsTick', sample))
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'automatic sprint-jump reaches destination' })
  const pulses = samples.flatMap((s, i) => s.pulse ? [i] : [])
  assert.ok(pulses.length >= 2, 'consecutive optional jumps on a long route')
  for (const i of pulses) {
    assert.equal(samples[i].jump, true)
    assert.equal(samples[i].grounded, true)
    assert.equal(samples[i + 1]?.grounded, false, 'pulse launches a physical jump')
    assert.equal(samples[i + 1]?.pulse, 0, 'pulse clears by the next physics tick')
    assert.equal(samples[i + 1]?.jump, false, 'jump key is not held in flight')
  }
  const stats = internals.wrapper.locomotionStats()
  assert.ok(stats.optionalJumps > 0, 'loaded flat sprint route should permit at least one simulated safe jump')
  t.diagnostic(JSON.stringify(stats))
})

test('real route cancellation clears a pending optional jump before physics can consume it', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const { wrapper, navigationIntents } = internals
  const route = navigationIntents.register({ id: 'cancel-jump' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 32, from.y, from.z)
  let cancelled
  const inspect = () => {
    if (!wrapper._optionalJumpGoal || cancelled) return
    route.withdrawGoal('destination')
    cancelled = { pulse: wrapper._jumpPulseUntil, key: bot.controlState.jump, queued: bot.jumpQueued }
  }
  bot.on('physicsTick', inspect)
  t.after(() => bot.removeListener('physicsTick', inspect))
  route.publishGoal('destination', { goal })
  await waitFor(() => cancelled, { label: 'cancel during the optional pulse' })
  assert.deepEqual(cancelled, { pulse: 0, key: false, queued: false })
  assert.equal(bot.pathfinder.goal, null)
})

test('real native pathfinder steps up onto a raised destination without an optional pulse', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const route = internals.navigationIntents.register({ id: 'native-step' })
  const from = bot.entity.position.floored()
  const block = from.offset(5, 0, 0)
  await mc.setBlock(block, 'stone')
  const goal = new goals.GoalBlock(block.x, block.y + 1, block.z)
  route.publishLocomotion('walk', { mode: 'walk', goal, expiresAt: Date.now() + 10_000 })
  route.publishGoal('destination', { goal })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'native jump onto stone' })
  assert.equal(internals.wrapper.locomotionStats().optionalJumps, 0)
})

test('changing gait during a real optional pulse clears the held and queued jump', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const { wrapper, navigationIntents } = internals
  const route = navigationIntents.register({ id: 'interrupt-style' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 32, from.y, from.z)
  let switched
  const inspect = () => {
    if (!wrapper._optionalJumpGoal || switched) return
    wrapper.setGait('walk')
    switched = { pulse: wrapper._jumpPulseUntil, key: bot.controlState.jump, queued: bot.jumpQueued }
  }
  bot.on('physicsTick', inspect)
  t.after(() => bot.removeListener('physicsTick', inspect))
  route.publishGoal('destination', { goal })
  await waitFor(() => switched && wrapper.locomotionStats().mode === 'walk', { label: 'switch to walk during pulse' })
  assert.deepEqual(switched, { pulse: 0, key: false, queued: false })
  assert.equal(bot.pathfinder.goal, goal)
})

test('real low-clearance tunnel permits travel but vetoes optional jumps', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const route = internals.navigationIntents.register({ id: 'low-clearance' })
  const from = bot.entity.position.floored()
  await mc.fillBlocks(from.offset(-1, 2, -1), from.offset(19, 2, 1), 'stone')
  const goal = new goals.GoalBlock(from.x + 18, from.y, from.z)
  route.publishLocomotion('fast', { mode: 'sprint_jump', goal, expiresAt: Date.now() + 15_000 })
  route.publishGoal('destination', { goal })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'travel under low ceiling' })
  assert.equal(internals.wrapper.locomotionStats().optionalJumps, 0)
})
