'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation } = require('./helpers/sim-harness')

test('hold preserves a real walk; targeted stop confirms that walk drained', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const origin = bot.entity.position.clone()
  const snap = () => internals.buildActionPrompt(['body control integration'])
  await internals.executeAction({ a: 'go_to', x: Math.floor(origin.x) + 22, z: Math.floor(origin.z) }, snap())
  await waitFor(() => internals.skills.current() && bot.entity.position.distanceTo(origin) > 0.5, { label: 'walk in progress' })
  const id = /BODY action (job-\d+)/.exec(snap().text)?.[1]
  assert.ok(id)
  await internals.executeAction({ a: 'hold' }, snap())
  assert.ok(internals.skills.current(), 'hold must not replace the active skill')
  await internals.executeAction({ a: 'stop', action_id: 'job-invalid' }, snap())
  assert.ok(internals.skills.current(), 'a different action ID must not cancel the walk')
  await internals.executeAction({ a: 'stop', action_id: id }, snap())
  assert.equal(internals.skills.current(), null)
  assert.equal(bot.pathfinder.goal, null)
  assert.ok(sim.readTelemetryEvents().some((e) => e.type === 'action_outcome' && e.data.tool === 'stop' && e.data.bodyActionId === id && e.data.execution === 'cleanup_confirmed'))
})

test('script JavaScript completion is not domain success without a threat', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { internals, waitFor } = sim
  await internals.executeAction({ a: 'run_script', name: 'flee' }, internals.buildActionPrompt(['verify script domain result']))
  await waitFor(() => internals.results.some((r) => r.label === 'run_script flee' && !r.ok && /no live threat/.test(r.msg)), { label: 'reported script domain failure' })
})

test('a scripted response runs stop before a new walk even if the model listed it last', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, llm, internals, waitFor } = sim
  const from = bot.entity.position.floored()
  await internals.executeAction({ a: 'go_to', x: from.x + 24, z: from.z }, internals.buildActionPrompt(['initial walk']))
  const id = /BODY action (job-\d+)/.exec(internals.buildActionPrompt(['find active body action']).text)?.[1]
  assert.ok(id)
  llm.enqueueAction({ toolCalls: [
    { name: 'go_to', arguments: { x: from.x, z: from.z + 12 } },
    { name: 'stop', arguments: { action_id: id } }
  ] })
  internals.brain.wake('replace current walk safely', { external: true, urgent: true })
  await waitFor(() => sim.readTelemetryEvents().some((e) => e.type === 'tool_admission' && e.data.tool === 'go_to' && e.data.callId), { label: 'new walk admitted from model response' })
  const events = sim.readTelemetryEvents()
  const stop = events.findIndex((e) => e.type === 'action_outcome' && e.data.bodyActionId === id && e.data.execution === 'cleanup_confirmed')
  const walk = events.findIndex((e) => e.type === 'tool_admission' && e.data.tool === 'go_to' && e.data.callId)
  assert.ok(stop >= 0 && walk > stop, 'old walk must drain before new walk admission')
})

test('a replacement block is not activated after walking toward the guarded target', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const from = bot.entity.position.floored()
  const destination = from.offset(10, 0, 0)
  await mc.setBlock(destination, 'crafting_table')
  await waitFor(() => bot.blockAt(destination)?.name === 'crafting_table', { label: 'interaction target loaded' })
  await internals.executeAction({ a: 'use_block', what: 'crafting_table' }, internals.buildActionPrompt(['approach guarded block']))
  await waitFor(() => internals.skills.current(), { label: 'interaction approach started' })
  await mc.setBlock(destination, 'stone')
  await waitFor(() => internals.results.some((r) => r.label === 'use_block'), { label: 'interaction result' })
  const result = internals.results.find((r) => r.label === 'use_block')
  assert.equal(result.ok, false)
  assert.match(result.msg, /stale target/)
  assert.equal(bot.blockAt(destination)?.name, 'stone')
})
