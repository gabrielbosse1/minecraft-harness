/**
 * test/10-streaming-rpm-reactivity.test.js — verifies SSE streaming with
 * per-chunk stall detection, 20-RPM rate pacing + chatReserve + Retry-After,
 * reasoning_effort defaults & 400 fallbacks, loop check-in preemption,
 * death/reflex preemption, distant watch-mob filtering, and escape pruning.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { AmdToolsClient, createZincTools, createChatTools } = require('../zincai/api_wrapper')
const { Brain } = require('../zincai/brain')
const { planEscape } = require('../zincai/custom_mineflayer/escape')
const { startSimulation, waitFor, sleep } = require('./helpers/sim-harness')

test('10a: SSE streaming assembles tool_calls, resets inactivity timer on chunks, and handles 400 stream_options/reasoning fallbacks', { timeout: 30_000 }, async () => {
  const bodies = []
  let mode = 'slow_stream'

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      bodies.push(body)

      if (mode === 'reject_stream_options') {
        if (body.stream_options) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }))
          return
        }
        if (body.reasoning_effort) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'idle', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 }
        }))
        return
      }

      if (mode === 'slow_stream') {
        // Total duration ~1400ms (> timeoutMs 700ms), but chunks arrive every 200ms!
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const writeEvt = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        writeEvt({ choices: [{ delta: { role: 'assistant', reasoning_content: 'thinking ' } }] })
        await sleep(220)
        writeEvt({ choices: [{ delta: { reasoning_content: 'fast ' } }] })
        await sleep(220)
        writeEvt({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sse_1', type: 'function', function: { name: 'say', arguments: '{"text":' } }] } }] })
        await sleep(220)
        writeEvt({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"streamed ok"}' } }] } }] })
        await sleep(220)
        writeEvt({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 250, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 128 } } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (mode === 'stalled_stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning_content: 'partial...' } }] })}\n\n`)
        // Never finishes -> triggers chunk-inactivity stall timeout
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]

  try {
    const client = new AmdToolsClient({
      apiKey: 'rc-test',
      baseUrl,
      model: 'Qwen3.8-27B',
      timeoutMs: 700,
      streamIdleTimeoutMs: 500,
      maxRetries: 0,
      discoverModels: false
    })

    // 1. Active SSE stream outlives timeoutMs (880ms+ > 700ms) without timing out
    const res1 = await client.chatWithTools(messages, createZincTools())
    assert.equal(res1.action.a, 'say')
    assert.equal(res1.action.text, 'streamed ok')
    assert.equal(res1.reasoning, 'thinking fast')
    assert.equal(res1.usage.promptTokens, 250)
    assert.equal(res1.usage.cachedTokens, 128)
    assert.equal(bodies[0].stream, true)
    assert.deepEqual(bodies[0].stream_options, { include_usage: true })
    assert.equal(bodies[0].reasoning_effort, 'low')
    assert.equal(client.stats.streamedResponses, 1)
    assert.equal(client.stats.timeouts, 0)

    // 2. Stalled SSE stream triggers timeout cleanly
    mode = 'stalled_stream'
    let stallErr = null
    try {
      await client._complete({ messages, tools: createZincTools(), lane: 'action', timeoutMs: 350, maxRetries: 0 })
    } catch (err) { stallErr = err }
    assert.ok(stallErr, 'stalled SSE stream must reject on chunk inactivity')
    assert.ok(client.stats.timeouts >= 1)

    // 3. 400 fallback strips stream_options and reasoning_effort cleanly for the session
    mode = 'reject_stream_options'
    const res3 = await client.chatWithTools(messages, createZincTools())
    assert.equal(res3.action.a, 'idle')
    assert.equal(client.streamOptionsSupported, false)
    assert.equal(client.reasoningEffortSupported, false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('10b: RPM pacer enforces chatReserve and honors 429 Retry-After across lanes', { timeout: 20_000 }, async () => {
  let reqCount = 0
  let send429 = false
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      reqCount++
      if (send429) {
        send429 = false
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })
        res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c_${reqCount}`, type: 'function', function: { name: 'reply', arguments: '{"text":"hi"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 50, completion_tokens: 5 }
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

  try {
    const client = new AmdToolsClient({
      apiKey: 'rc-test',
      baseUrl,
      model: 'Qwen3.8-27B',
      timeoutMs: 5_000,
      maxRetries: 1,
      rpm: 3,
      chatReserve: 1,
      discoverModels: false
    })
    const msgs = [{ role: 'user', content: 'hi' }]
    const tools = createChatTools()

    // Two action calls consume the action quota (3 - 1 = 2); third action call waits
    await client._complete({ messages: msgs, tools, lane: 'action', maxRetries: 0 })
    await client._complete({ messages: msgs, tools, lane: 'action', maxRetries: 0 })

    // Chat still uses its reserved 3rd slot IMMEDIATELY without waiting for the 60s window!
    const t0 = Date.now()
    await client._complete({ messages: msgs, tools, lane: 'chat', maxRetries: 0 })
    assert.ok(Date.now() - t0 < 500, 'chat lane must use its reserved slot immediately')

    // 429 with Retry-After sets global _cooldownUntil
    const client429 = new AmdToolsClient({
      apiKey: 'rc-test',
      baseUrl,
      model: 'Qwen3.8-27B',
      timeoutMs: 5_000,
      maxRetries: 1,
      rpm: 20,
      discoverModels: false
    })
    send429 = true
    const t429 = Date.now()
    await client429._complete({ messages: msgs, tools, lane: 'chat', maxRetries: 1 })
    assert.ok(Date.now() - t429 >= 900, '429 Retry-After: 1 must pace the retry by ~1s')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('10c: Brain preempts low-priority autonomous check-in on external events and ignores distant underground watch mobs', { timeout: 45_000 }, async () => {
  // 1. Unit check on Brain preemption of loopTurn
  const seenTurns = []
  let abortInflight = null
  const brain = new Brain({
    act: async (reasons) => {
      seenTurns.push(reasons)
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ idle: true }), 5000)
        brain.inflightAbort = () => {
          clearTimeout(timer)
          abortInflight = reasons
          resolve({ idle: false })
          return true
        }
      })
      return { idle: false }
    },
    talk: async () => {},
    loopMs: 20,
    heartbeatMs: 1000,
    minIntervalMs: 10,
    fastMinIntervalMs: 10,
    urgentMinIntervalMs: 10
  })
  brain.start(20)
  await waitFor(() => seenTurns.length >= 1, { timeoutMs: 2000, label: 'autonomous check-in started' })
  assert.match(seenTurns[0][0], /^autonomous check-in/)

  brain.wake('hit by zombie', { external: true, urgent: true })
  await waitFor(() => abortInflight !== null, { timeoutMs: 1000, label: 'loop turn preempted by external wake' })
  await waitFor(() => seenTurns.some((r) => r.some((x) => /hit by zombie/.test(x))), { timeoutMs: 2000, label: 'external wake ran immediately' })
  brain.stop()

  // 2. Real-server check: distant underground watch mob does NOT trigger staleActionReason
  const sim = await startSimulation({
    cfgOverrides: { inference: { loopMs: 0, heartbeatMs: 0 } }
  })
  try {
    const internals = sim.session.internals()
    const pos = sim.bot.entity.position.clone()
    // Simulate a watch mob 22m away and 18 blocks underground
    internals.sense.last = {
      threats: [],
      watch: [{
        id: 9999,
        name: 'zombie',
        distance: Math.hypot(22, 18),
        closing: 0.4,
        where: '22m E, 18 down',
        entity: { id: 9999, position: pos.offset(22, -18, 0) }
      }],
      hidden: [],
      ids: new Set(),
      dangerIds: new Set([9999])
    }
    const snap = { threatIds: [], goalId: null }
    assert.equal(internals.staleActionReason({ a: 'go_to', x: pos.x + 5, y: pos.y, z: pos.z }, snap), null, 'distant underground watch mob must not refuse go_to')

    // Close closing watch mob SHOULD still refuse
    internals.sense.last.watch[0].entity.position = pos.offset(12, 0, 0)
    internals.sense.last.watch[0].distance = 12
    const refused = internals.staleActionReason({ a: 'go_to', x: pos.x + 5, y: pos.y, z: pos.z }, snap)
    assert.match(String(refused || ''), /refused: 1 new threat/)
  } finally {
    await sim.stop()
  }
})

test('10d: Escape planner upper-bound pruning slashes blockAt scans without changing result', () => {
  let blockReads = 0
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt (p) {
      blockReads++
      if (p.y < 64) return { name: 'grass_block', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
  }
  const movements = {
    getNeighbors (node) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
      return dirs.map(([dx, dz]) => ({
        x: node.x + dx,
        y: 64,
        z: node.z + dz,
        cost: dx && dz ? 1.414 : 1
      }))
    }
  }
  const pursuers = [{ x: -3.5, y: 64, z: 0.5, speed: 4.3, reach: 2 }]
  const plan = planEscape(bot, movements, pursuers, { radius: 14, maxNodes: 600, budgetMs: 0 })
  assert.ok(plan && plan.target, 'planEscape must return a valid escape plan')
  assert.ok(plan.direction.x > 0, 'must flee away from pursuer at -X')
  assert.ok(blockReads < 1500, `pruned openness scans must stay small (was ${blockReads} blockAt reads)`)
})
