/**
 * test/08-context-compaction-and-degradation.test.js — verifies standard model
 * token limits, proactive pre-limit compaction with memory preservation,
 * reactive compaction on `finish_reason: "length"` and HTTP 400 context
 * overflow, and multi-stage graceful degradation on both action and chat lanes
 * against a real flying-squid Minecraft 1.21.4 server.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation, waitFor, sleep } = require('./helpers/sim-harness')
const {
  ContextBudget,
  resolveModelLimits,
  trimIncompleteSentence,
  parseLimitError
} = require('../zincai/context_budget')
const { buildToolsPayload, createZincTools, createRecoveryTools } = require('../zincai/api_wrapper')
const { loadConfig } = require('../zincai/index')

test('08a: Standard model limits resolved without artificial caps, /models + 400 error learning, and clean sentence trim', () => {
  const prevModel = process.env.AMD_MODEL
  const prevMax = process.env.AMD_MAX_TOKENS
  const prevChatMax = process.env.INFERENCE_CHAT_MAX_TOKENS
  const prevCtx = process.env.AMD_CONTEXT_WINDOW
  delete process.env.AMD_MODEL
  delete process.env.AMD_MAX_TOKENS
  delete process.env.INFERENCE_CHAT_MAX_TOKENS
  delete process.env.AMD_CONTEXT_WINDOW
  try {
    const cfg = loadConfig()
    assert.equal(cfg.amd.model, 'Qwen3.8-27B', 'default amd.model must be Qwen3.8-27B')
    assert.equal(cfg.amd.maxTokens, null, 'default amd.maxTokens must be null (standard model limit)')
    assert.equal(cfg.inference.chatMaxTokens, null, 'default inference.chatMaxTokens must be null (standard model limit)')
    assert.equal(cfg.amd.contextWindow, null, 'default amd.contextWindow must be null (auto-resolved)')
  } finally {
    if (prevModel !== undefined) process.env.AMD_MODEL = prevModel
    if (prevMax !== undefined) process.env.AMD_MAX_TOKENS = prevMax
    if (prevChatMax !== undefined) process.env.INFERENCE_CHAT_MAX_TOKENS = prevChatMax
    if (prevCtx !== undefined) process.env.AMD_CONTEXT_WINDOW = prevCtx
  }

  // Verified native specs for Qwen3.8-27B (default) and Qwen3.8-Flash-Next
  for (const id of ['Qwen3.8-27B', 'Qwen3.8-Flash-Next']) {
    const spec = resolveModelLimits(id)
    assert.equal(spec.contextWindow, 262_144, `${id} contextWindow`)
    assert.equal(spec.maxOutputTokens, 131_072, `${id} maxOutputTokens`)
    assert.equal(spec.reasoning, true, `${id} reasoning`)
  }

  // Payload omits max_tokens when null/unset, includes it when explicitly set
  const defaultBody = buildToolsPayload({
    model: 'Qwen3.8-Flash-Next',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.25,
    maxTokens: null,
    tools: createZincTools()
  })
  assert.equal('max_tokens' in defaultBody, false, 'max_tokens must be omitted when unset')
  assert.ok(defaultBody.tools.length >= 35)

  const plainBody = buildToolsPayload({
    model: 'Qwen3.8-Flash-Next',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    maxTokens: 2048,
    tools: null
  })
  assert.equal(plainBody.max_tokens, 2048)
  assert.equal('tools' in plainBody, false, 'tools must be omitted in plain-text degradation mode')
  assert.equal('tool_choice' in plainBody, false)

  // Recovery toolset cuts schema bloat drastically
  const fullChars = JSON.stringify(createZincTools()).length
  const recoveryChars = JSON.stringify(createRecoveryTools()).length
  assert.ok(recoveryChars < fullChars * 0.35, `recovery tool schema (${recoveryChars}) should be <35% of full (${fullChars})`)

  // ContextBudget headroom reservation + /models discovery + 400 error learning
  const budget = new ContextBudget({ model: 'Qwen3.8-Flash-Next' })
  const room = budget.room({ lane: 'action' })
  assert.ok(room.outputReserve >= 60_000, `262k model should reserve generous output headroom (got ${room.outputReserve})`)
  assert.ok(room.softCompactAt < room.hardPromptBudget && room.hardPromptBudget < room.contextWindow)

  assert.equal(budget.applyModelMetadata({
    data: [{ id: 'Qwen3.8-Flash-Next', max_model_len: 32_768, max_output_tokens: 16_384 }]
  }), true)
  assert.equal(budget.contextWindow, 32_768)
  assert.equal(budget.maxOutputTokens, 16_384)

  const parsed = parseLimitError("This model's maximum context length is 16384 tokens. However, you requested 18200 tokens.")
  assert.equal(parsed.isContextOverflow, true)
  assert.equal(parsed.learnedContext, 16_384)
  budget.learnFromError("This model's maximum context length is 16384 tokens.")
  assert.equal(budget.contextWindow, 16_384)

  // Clean incomplete sentence trimming (reproducing the live Portuguese cutoff)
  const rawCut = 'Oi! No ar, sim. Tô aqui com uma muda de carvalho na mão, pensando em montar uma '
  const cleaned = trimIncompleteSentence(rawCut)
  assert.equal(cleaned, 'Oi! No ar, sim. Tô aqui com uma muda de carvalho na mão.', 'should trim incomplete trailing clause cleanly at clause boundary')
  assert.equal(trimIncompleteSentence('Pensando em montar uma '), 'Pensando em montar...', 'should strip dangling article when no earlier sentence exists')
  assert.equal(trimIncompleteSentence('Tudo certo por aqui! E aí, vamos construir uma '), 'Tudo certo por aqui!', 'should trim back to full earlier sentence when substantial')
})

test('08b: Real-server proactive compaction BEFORE limit via /models discovery preserves memories & goals', { timeout: 60_000 }, async () => {
  const sim = await startSimulation({
    llmModels: [{ id: 'sim-model', context_length: 18_500, max_output_tokens: 4_096 }],
    cfgOverrides: {
      amd: { model: 'sim-model', maxTokens: null, contextWindow: null },
      inference: { loopMs: 0, heartbeatMs: 0, chatMaxTokens: null }
    }
  })

  try {
    const internals = sim.session.internals()

    // Verify /models discovery picked up the advertised limit on first boot call
    assert.equal(sim.shared.amd.budget.contextWindow, 18_500, 'should discover context_length via GET /models')

    // Seed high-priority long-term memories, player facts, an open goal, and building blocks (adds bulky 3D grid at L0)
    sim.shared.memory.longTerm.add('Found rare emerald ore vein under the mossy oak hill at x=42 z=-18', ['emerald', 'vein', 'ore'], 4)
    sim.shared.memory.rememberFact('Alice keeps spare diamonds in the north spruce chest', { about: 'Alice' })
    internals.goals.add({ description: 'Build the riverside watchtower with oak logs', origin: 'self', priority: 4 })
    sim.mc.giveItem('ZincAI', 'cobblestone', 32)
    await sleep(300)
    const cobble = sim.bot.inventory.items().find((i) => i.name === 'cobblestone')
    if (cobble) await sim.bot.equip(cobble, 'hand')

    // Confirm L0 prompt actually includes the bulky 3D grid and is larger than L1+
    const l0Snap = internals.buildActionPrompt(['check emerald vein and watchtower'], { compactionLevel: 0, markDelivered: false })
    const l1Snap = internals.buildActionPrompt(['check emerald vein and watchtower'], { compactionLevel: 1, markDelivered: false })
    assert.ok(l0Snap.text.includes('grid (legend:'), 'level 0 prompt should include 3D ASCII grid while holding cobblestone')
    assert.ok(!l1Snap.text.includes('grid (legend:'), 'level 1 compaction must drop 3D ASCII grid first')
    assert.ok(l1Snap.text.length < l0Snap.text.length, 'level 1 compacted prompt must be smaller than level 0')

    // Enqueue a valid action and wake the brain; proactive compaction MUST run before sending!
    const beforeReqs = sim.llm.actionRequests().length
    sim.llm.enqueueAction({
      toolCalls: [{ name: 'note', arguments: { text: 'watchtower plan verified' } }],
      usage: { prompt_tokens: 9200, completion_tokens: 45, total_tokens: 9245 }
    })
    internals.brain.wake('check emerald vein and watchtower', { external: true, fast: true })

    await waitFor(() => sim.llm.actionRequests().length > beforeReqs, { timeoutMs: 10_000, label: 'proactive compacted action request' })
    await sleep(400)

    const req = sim.llm.actionRequests().at(-1)
    const userPrompt = String(req.messages.find((m) => m.role === 'user')?.content || '')
    assert.equal('max_tokens' in req.body, false, 'initial request must omit max_tokens when user set no limit')
    assert.ok(!userPrompt.includes('grid (legend:'), 'proactive pre-flight compaction must strip 3D grid before hitting context limit')
    assert.ok(
      userPrompt.includes('emerald ore vein') || userPrompt.includes('watchtower'),
      'proactive compaction must preserve long-term memories and active goals'
    )
    assert.ok(sim.shared.amd.getStats().proactiveCompactions >= 1, 'proactiveCompactions counter must increment')
    assert.ok(sim.shared.memory.longTerm.entries.some((e) => /emerald ore vein/i.test(e.text)), 'long-term memory entries must NOT be wiped')

    // Verify telemetry logged the proactive compaction event
    const events = sim.readTelemetryEvents()
    const compEvt = events.find((e) => e.type === 'context_compaction' && e.data?.phase === 'proactive')
    assert.ok(compEvt, 'telemetry should record a proactive context_compaction event')
  } finally {
    await sim.stop()
  }
})

test('08c: Real-server Action-lane length truncation -> reactive compaction + 3-stage graceful degradation + HTTP 400 overflow recovery', { timeout: 60_000 }, async () => {
  const sim = await startSimulation({
    cfgOverrides: {
      amd: { model: 'Qwen3.8-Flash-Next', maxTokens: null, contextWindow: 262_144 },
      inference: { loopMs: 0, heartbeatMs: 0, chatMaxTokens: null }
    }
  })

  try {
    const internals = sim.session.internals()
    const alice = await sim.mc.connectPlayer('Alice')
    const aliceHeard = []
    alice.on('messagestr', (msg) => aliceHeard.push(msg))

    // Seed memories + building blocks so compaction has real work to shrink while keeping memories
    sim.shared.memory.longTerm.add('Secret iron stash is buried under the birch tree near spawn', ['birch', 'iron', 'stash'], 4)
    internals.goals.add({ description: 'Gather birch wood for bridge repairs', origin: 'self', priority: 3 })
    sim.mc.giveItem('ZincAI', 'cobblestone', 16)
    await sleep(250)
    const cobble = sim.bot.inventory.items().find((i) => i.name === 'cobblestone')
    if (cobble) await sim.bot.equip(cobble, 'hand')

    // --- Part 1: 3 consecutive `length` truncations -> Stage 1, Stage 2, Stage 3 graceful degradation! ---
    const startIdx = sim.llm.actionRequests().length
    // Call 1 (primary): truncated mid-reasoning
    sim.llm.enqueueAction({ finishReason: 'length', reasoning: 'Thinking deeply about birch wood...', content: null, usage: { prompt_tokens: 13400, completion_tokens: 1024 } })
    // Call 2 (Stage 1 reactive compaction + budget escalation): still truncated
    sim.llm.enqueueAction({ finishReason: 'length', reasoning: 'Still overthinking...', content: null, usage: { prompt_tokens: 11200, completion_tokens: 4096 } })
    // Call 3 (Stage 2 stronger compaction + reasoning_effort=low + bigger budget): still truncated
    sim.llm.enqueueAction({ finishReason: 'length', reasoning: 'Overthinking again...', content: null, usage: { prompt_tokens: 9800, completion_tokens: 8192 } })
    // Call 4 (Stage 3 graceful degradation: compact essential tools + tool_choice=auto): succeeds!
    sim.llm.enqueueAction({
      toolCalls: [{ name: 'say', arguments: { text: 'Recovered via stage 3!' } }],
      usage: { prompt_tokens: 5200, completion_tokens: 40 }
    })

    internals.brain.wake('check birch tree stash', { external: true, fast: true })

    await waitFor(
      () => aliceHeard.some((m) => m.includes('Recovered via stage 3!')),
      { timeoutMs: 15_000, label: 'Alice receives Stage 3 degraded recovery chat message' }
    )

    const burst = sim.llm.actionRequests().slice(startIdx)
    assert.equal(burst.length, 4, `expected 1 primary + 3 recovery attempts, got ${burst.length}`)

    // Primary call omitted max_tokens (model standard limit) and sent all 39 tools
    assert.equal('max_tokens' in burst[0].body, false, 'primary call must omit max_tokens')
    assert.ok(burst[0].toolNames.length >= 35, 'primary call uses full toolset')

    // Stage 1 actually compacted the user prompt AND escalated max_tokens!
    const p0 = String(burst[0].messages.find((m) => m.role === 'user')?.content || '')
    const p1 = String(burst[1].messages.find((m) => m.role === 'user')?.content || '')
    assert.ok(p1.length < p0.length, `Stage 1 retry must compact prompt (${p1.length} < ${p0.length})`)
    assert.ok(burst[1].body.max_tokens >= 4096, `Stage 1 must escalate max_tokens generously (got ${burst[1].body.max_tokens})`)

    // Stage 2 escalated further and requested low reasoning effort
    assert.ok(burst[2].body.max_tokens >= 8192, `Stage 2 must escalate max_tokens further (got ${burst[2].body.max_tokens})`)
    assert.equal(burst[2].body.reasoning_effort, 'low', 'Stage 2 should hint reasoning_effort=low')

    // Stage 3 degraded gracefully to compact essential tool subset + tool_choice=auto while keeping memory!
    assert.ok(burst[3].toolNames.length <= 12, `Stage 3 must degrade to compact toolset (got ${burst[3].toolNames.length})`)
    assert.equal(burst[3].body.tool_choice, 'auto', 'Stage 3 should relax tool_choice to auto')
    const p3 = String(burst[3].messages.find((m) => m.role === 'user')?.content || '')
    assert.ok(
      p3.includes('birch') || p3.includes('Secret iron stash'),
      'Stage 3 survival compaction must still preserve core memories / goals'
    )
    assert.ok(sim.shared.amd.getStats().degradedRecoveries >= 1, 'degradedRecoveries stat must increment')
    assert.ok(internals.compactionState().actionCompactionFloor >= 1, 'session should raise actionCompactionFloor after degraded recovery')

    // --- Part 2: HTTP 400 context-overflow -> dynamic limit learning + reactive compaction + success ---
    const beforeOverflow = sim.llm.actionRequests().length
    sim.llm.enqueueAction({
      httpStatus: 400,
      body: { error: { message: "This model's maximum context length is 15000 tokens. However, your messages resulted in 16400 tokens." } }
    })
    sim.llm.enqueueAction({
      toolCalls: [{ name: 'say', arguments: { text: 'Recovered from 400 overflow!' } }],
      usage: { prompt_tokens: 8400, completion_tokens: 30 }
    })

    internals.brain.wake('report status after overflow', { external: true, fast: true })

    await waitFor(
      () => aliceHeard.some((m) => m.includes('Recovered from 400 overflow!')),
      { timeoutMs: 15_000, label: 'Alice receives 400-overflow recovery chat message' }
    )

    assert.equal(sim.shared.amd.budget.contextWindow, 15_000, 'HTTP 400 error should teach ContextBudget the real contextWindow')
    assert.ok(sim.shared.amd.getStats().contextOverflows >= 1, 'contextOverflows counter must increment')
    assert.ok(sim.llm.actionRequests().length >= beforeOverflow + 2)
  } finally {
    await sim.stop()
  }
})

test('08d: Real-server Chat-lane mid-sentence cutoff & plain-text graceful degradation (preserving player memories)', { timeout: 60_000 }, async () => {
  const sim = await startSimulation({
    cfgOverrides: {
      amd: { model: 'Qwen3.8-Flash-Next', maxTokens: null },
      inference: { loopMs: 0, heartbeatMs: 0, chatMaxTokens: null, chatBatchMs: 200 }
    }
  })

  try {
    const alice = await sim.mc.connectPlayer('Alice')
    const aliceHeard = []
    alice.on('messagestr', (msg) => aliceHeard.push(msg))

    // Store durable player memory for Alice
    sim.shared.memory.rememberFact('Alice adora plantar mudas de carvalho perto do rio', { about: 'Alice' })

    // --- Sub-scenario A: Mid-sentence length cutoff ("...pensando em montar uma ") must NOT be sent unfinished! ---
    const chatStartA = sim.llm.chatRequests().length
    sim.llm.enqueueChat({
      finishReason: 'length',
      reply: { text: 'Oi! No ar, sim. Tô aqui com uma muda de carvalho na mão, pensando em montar uma ' },
      usage: { prompt_tokens: 1800, completion_tokens: 400 }
    })
    sim.llm.enqueueChat({
      finishReason: 'tool_calls',
      reply: { text: 'Oi Alice! No ar sim, pensando em montar uma cabana perto do rio!' },
      usage: { prompt_tokens: 1400, completion_tokens: 80 }
    })

    alice.chat('Oi ZincAI, tá no ar?')

    await waitFor(
      () => aliceHeard.some((m) => m.includes('cabana perto do rio!')),
      { timeoutMs: 15_000, label: 'Alice receives complete retried Portuguese reply' }
    )
    await sleep(300)

    assert.equal(
      aliceHeard.some((m) => m.includes('muda de carvalho na mão') || m.trim().endsWith('montar uma')),
      false,
      'ZincAI must NEVER broadcast the cut-off mid-sentence fragment to players'
    )
    const reqsA = sim.llm.chatRequests().slice(chatStartA)
    assert.equal(reqsA.length, 2, 'should perform primary chat call + Stage 1 compacted retry')
    assert.equal('max_tokens' in reqsA[0].body, false, 'primary chat call must omit max_tokens when unset')
    assert.ok(reqsA[1].body.max_tokens >= 2048, 'Stage 1 chat recovery must escalate max_tokens generously')
    const retryPromptA = String(reqsA[1].messages.find((m) => m.role === 'user')?.content || '')
    assert.ok(retryPromptA.includes('mudas de carvalho'), 'compacted chat retry must preserve player memories about Alice')

    // --- Sub-scenario B: Repeated `length` empty cutoffs -> Stage 2 plain-text graceful degradation ---
    const chatStartB = sim.llm.chatRequests().length
    // Call 1 (primary): reasoning ate output -> empty length cutoff
    sim.llm.enqueueChat({ finishReason: 'length', reasoning: 'Thinking in circles...', content: null, usage: { prompt_tokens: 1700, completion_tokens: 1024 } })
    // Call 2 (Stage 1 reply tool retry): still empty length cutoff
    sim.llm.enqueueChat({ finishReason: 'length', reasoning: 'Still stuck in tool JSON...', content: null, usage: { prompt_tokens: 1300, completion_tokens: 2048 } })
    // Call 3 (Stage 2 plain-text graceful degradation — tools omitted!): succeeds cleanly!
    sim.llm.enqueueChat({
      plain: true,
      finishReason: 'stop',
      content: 'Claro Alice! Vamos plantar os carvalhos juntos perto do rio.',
      usage: { prompt_tokens: 900, completion_tokens: 40 }
    })

    alice.chat('Bora plantar os carvalhos?')

    await waitFor(
      () => aliceHeard.some((m) => m.includes('plantar os carvalhos juntos')),
      { timeoutMs: 15_000, label: 'Alice receives Stage 2 plain-text degraded reply' }
    )

    const reqsB = sim.llm.chatRequests().slice(chatStartB)
    assert.equal(reqsB.length, 3, `expected primary + Stage 1 + Stage 2 plain-text, got ${reqsB.length}`)
    assert.equal('tools' in reqsB[2].body, false, 'Stage 2 chat degradation must omit tools for plain-text completion')
    const plainPromptB = String(reqsB[2].messages.find((m) => m.role === 'user')?.content || '')
    assert.ok(plainPromptB.includes('mudas de carvalho'), 'Stage 2 degraded chat prompt must still preserve Alice memories')
    assert.ok(sim.shared.amd.getStats().degradedRecoveries >= 1, 'degradedRecoveries stat must increment on Stage 2 chat fallback')
  } finally {
    await sim.stop()
  }
})

test('08e: A cancelled call is not retried and not logged as a timeout', { timeout: 30_000 }, async () => {
  const http = require('http')
  const { AmdToolsClient, createChatTools } = require('../zincai/api_wrapper')

  let served = 0
  // The endpoint never answers: it is holding the request, exactly like a slow
  // reasoning model. Every request that reaches it is counted.
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => { served += 1 })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const messages = [{ role: 'system', content: 'chat' }, { role: 'user', content: 'oi' }]

  try {
    const client = new AmdToolsClient({
      apiKey: 'rc-test', baseUrl, model: 'sim-model', timeoutMs: 12_000, maxRetries: 2, discoverModels: false
    })

    // The caller cancels the thought (chat preempting the body). Before the fix
    // this was indistinguishable from a timeout, so it was retried 3 times and
    // logged as "retryable timeout" three times.
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 80)
    const t0 = Date.now()
    let threw = null
    try {
      await client._complete({
        messages, tools: createChatTools(), lane: 'action',
        timeoutMs: 12_000, maxRetries: 2, signal: controller.signal
      })
    } catch (err) { threw = err }

    assert.ok(threw, 'a cancelled call must reject')
    assert.equal(threw.name, 'AbortError', `cancellation must surface as AbortError, got ${threw.name}: ${threw.message}`)
    assert.ok(Date.now() - t0 < 1_000, `cancellation must be immediate, took ${Date.now() - t0}ms`)
    assert.equal(served, 1, `a cancelled call must NOT be retried (the endpoint received ${served} requests)`)
    assert.equal(client.stats.timeouts, 0, 'a cancelled call must not be counted as a timeout')
    assert.equal(client.stats.retries, 0, 'a cancelled call must not consume retries')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('08f: A real timeout is remembered, so the lane deadline grows and stays out of the other lane', { timeout: 40_000 }, async () => {
  const http = require('http')
  const { AmdToolsClient, createChatTools } = require('../zincai/api_wrapper')

  // The endpoint holds the request forever: a reasoner that ran past the
  // deadline is exactly this case from the client's point of view.
  let served = 0
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => { served += 1 })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

  try {
    const client = new AmdToolsClient({
      apiKey: 'rc-test', baseUrl, model: 'sim-model',
      timeoutMs: 10_000, maxRetries: 0, chatTimeoutMs: 10_000, discoverModels: false
    })
    const before = client._effectiveTimeoutMs(client.timeoutMs, client.maxTimeoutMs, 'action')
    assert.equal(before, 10_000, 'no samples yet: the configured base is used')

    let threw = null
    try {
      await client._complete({
        messages: [{ role: 'user', content: 'hi' }], tools: createChatTools(),
        lane: 'action', maxRetries: 0
      })
    } catch (err) { threw = err }

    assert.ok(threw, 'a call that never answers must fail')
    assert.equal(client.stats.timeouts, 1, 'the expired deadline must be counted exactly once')
    assert.equal(served, 1)

    // The deadline that expired is remembered: the next call of this lane gets
    // a budget that already fits the endpoint's observed slowness. Before this
    // fix the next call used the same 10 s and timed out again.
    const after = client._effectiveTimeoutMs(client.timeoutMs, client.maxTimeoutMs, 'action')
    assert.ok(after > before, `action deadline must grow after a timeout (${before} -> ${after})`)
    assert.ok(after <= client.maxTimeoutMs, 'the deadline must respect its ceiling')

    // …and the other lane, which never timed out, keeps its own budget.
    assert.equal(
      client._effectiveTimeoutMs(client.chatTimeoutMs, client.chatMaxTimeoutMs, 'chat'),
      client.chatTimeoutMs,
      'a slow action call must not stretch the chat lane deadline'
    )

    // The published stats expose both, so an operator can read a burst at a glance.
    const stats = client.getStats()
    assert.equal(stats.timeouts, 1)
    assert.ok(stats.effectiveTimeouts.action >= before)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
