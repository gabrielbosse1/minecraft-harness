'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const { EventPipeline } = require('../zincai/events')
const { startSimulation } = require('./helpers/sim-harness')

const add = (pipe, eventType, immediate = false) => pipe.record({
  eventType, summary: eventType, importance: immediate ? 3 : 2,
  reactionClass: immediate ? 'immediate' : 'deliberate'
}).event.sequence

test('decision batches include older events before expedited events; omitted IDs stay pending', () => {
  const pipe = new EventPipeline()
  const old = ['objective progress', 'new discovery', 'hostile sighted'].map((type) => add(pipe, type))
  const urgent = add(pipe, 'expedited decision', true)
  assert.deepEqual(pipe.formatDecisionBatch().sequences, [...old, urgent])
  const compact = pipe.formatDecisionBatch({ maxEvents: 2 })
  assert.deepEqual(compact.sequences, [old[0], urgent])
  assert.equal(compact.moreRemaining, 2)
  assert.deepEqual(pipe.formatDecisionBatch().sequences, [...old, urgent], 'drafting must not acknowledge')
  pipe.markProcessed(compact.sequences)
  assert.deepEqual(pipe.formatDecisionBatch().sequences, old.slice(1))
})

test('real navigation: independent override, expiry, danger detour and resumed primary goal', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const nav = internals.navigationIntents
  const from = bot.entity.position.floored()
  const home = new goals.GoalBlock(from.x + 12, from.y, from.z)
  const detour = new goals.GoalBlock(from.x, from.y, from.z + 4)
  const primary = nav.register({ id: 'test-primary' })
  assert.throws(() => nav.register({ id: 'missing', dependencies: ['not-registered'] }), /unresolved/)
  const safety = nav.register({ id: 'test-safety', dependencies: ['test-primary'] })
  const start = Date.now()
  safety.publishDanger('test-region', { x: from.x + 6.5, y: from.y, z: from.z + 0.5, radius: 2, hard: true, expiresAt: start + 20_000 })
  primary.publishGoal('home', { goal: home, parentObjective: 'return-home' })
  assert.equal(bot.pathfinder.goal, home)
  safety.publishOverride('brief', { goal: detour, reason: 'test interruption', expiresAt: start + 300, tier: 'urgent' })
  assert.equal(bot.pathfinder.goal, detour)
  await waitFor(() => bot.pathfinder.goal === home, { label: 'primary resumes after override expiration' })
  const trail = []
  const sample = () => trail.push(bot.entity.position.clone())
  bot.on('physicsTick', sample)
  t.after(() => bot.removeListener('physicsTick', sample))
  await waitFor(() => home.isEnd(bot.entity.position.floored()), { label: 'real travel to primary destination', timeoutMs: 15_000 })
  assert.ok(trail.length > 0)
  assert.ok(trail.every((p) => Math.hypot(p.x - (from.x + 6.5), p.z - (from.z + 0.5)) >= 1.4), 'the route must not cut through the restricted region')
  assert.ok(nav.unregister('test-primary'))
  assert.equal(nav.snapshot().zones.length, 0, 'dependent contribution withdrawn')
  assert.equal(safety.publishOverride('late', { goal: detour, reason: 'disabled', expiresAt: Date.now() + 1000 }), false)
})

test('model-assisted module sends accumulated events with the expedited record last', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { llm, internals, waitFor } = sim
  const mod = internals.navigationIntents.register({ id: 'objective-observer', modelAssisted: true })
  const first = mod.requestDecision({ summary: 'nav-order-canary older discovery' })
  const second = mod.requestDecision({ summary: 'nav-order-canary newest expedited request', expedited: true })
  assert.ok(first < second)
  llm.enqueueAction({ toolCalls: [{ name: 'idle', arguments: {} }] })
  const matching = () => llm.actionRequests().find((req) => JSON.stringify(req.body.messages).includes('nav-order-canary newest expedited request'))
  await waitFor(matching, { label: 'expedited action request' })
  const text = JSON.stringify(matching().body.messages)
  assert.ok(text.includes(`#${first} `))
  assert.ok(text.indexOf('nav-order-canary older discovery') < text.indexOf('nav-order-canary newest expedited request'))
})
