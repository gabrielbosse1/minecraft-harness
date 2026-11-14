'use strict'
/** Per-call reasoning effort: quick calls skip the reasoning phase, hard ones get it (zincai/effort.js). */
const test = require('node:test')
const assert = require('node:assert/strict')
const { decideEffort } = require('../zincai/effort')
const { AmdToolsClient, createZincTools } = require('../zincai/api_wrapper')

const base = { mode: 'adaptive', step: 1, reasons: ['go_to finished'], hasGoal: true, hasNext: true }

test('continuing a written plan after a success needs no reasoning', () => {
  const e = decideEffort(base)
  assert.equal(e.think, false)
  assert.match(e.line, /QUICK/)
})

test('what does need reasoning: a request, a failure, a death, a loop, no plan, no goal', () => {
  assert.equal(decideEffort({ ...base, reasons: ['chat request from Faylan25: build me a farm'] }).think, true)
  assert.equal(decideEffort({ ...base, lastFailed: true }).think, true)
  assert.equal(decideEffort({ ...base, reasons: ['respawned after you died at 1,2,3'] }).think, true)
  assert.equal(decideEffort({ ...base, loop: true }).think, true)
  assert.equal(decideEffort({ ...base, hasNext: false }).think, true)
  assert.equal(decideEffort({ ...base, hasGoal: false, hasNext: false }).think, true)
  const e = decideEffort({ ...base, lastFailed: true })
  assert.match(e.line, /THINK BRIEFLY/)
  assert.match(e.line, /Two or three short sentences/)
})

test('danger is always quick, even with a request or a failure pending', () => {
  const e = decideEffort({ ...base, danger: true, lastFailed: true, reasons: ['chat request from A: hi'] })
  assert.equal(e.think, false)
  assert.match(e.line, /danger/)
})

test('inside a turn: a successful step continues quick, a failed one or an answer to weigh thinks', () => {
  assert.equal(decideEffort({ ...base, step: 2, reasons: ['chat request from A: x'] }).think, false)
  assert.equal(decideEffort({ ...base, step: 2, stepFailed: true }).think, true)
  assert.equal(decideEffort({ ...base, step: 3, stepAsked: true }).think, true)
})

test('after eight quick calls in a row one call reviews the plan', () => {
  assert.equal(decideEffort({ ...base, quickStreak: 7 }).think, false)
  assert.equal(decideEffort({ ...base, quickStreak: 8 }).think, true)
})

test('modes on / auto / off override the per-call decision', () => {
  assert.equal(decideEffort({ ...base, mode: 'on' }).think, true)
  assert.equal(decideEffort({ ...base, mode: 'auto' }).think, true)
  assert.equal(decideEffort({ ...base, mode: 'off', lastFailed: true }).think, false)
})

test('client: a quick call switches reasoning off; a thinking call gets thinkMaxTokens', async () => {
  const sent = []
  const realFetch = global.fetch
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'idle', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const amd = new AmdToolsClient({ apiKey: 'rc-x', baseUrl: 'http://x/v1', model: 'm', maxTokens: 512, thinkMaxTokens: 1536, thinking: 'adaptive' })
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    await amd.chatWithTools(msgs, createZincTools(), { think: false })
    await amd.chatWithTools(msgs, createZincTools(), { think: true })
    assert.equal(sent[0].max_tokens, 512)
    assert.equal(sent[0].enable_thinking, false)
    assert.deepEqual(sent[0].chat_template_kwargs, { enable_thinking: false })
    assert.match(JSON.stringify(sent[0].messages), /\/no_think/)
    assert.equal(sent[1].max_tokens, 1536)
    assert.equal('enable_thinking' in sent[1], false)
    assert.doesNotMatch(JSON.stringify(sent[1].messages), /\/no_think/)
    assert.equal(amd.stats.quickCalls, 1)
    assert.equal(amd.stats.thinkingCalls, 1)
  } finally { global.fetch = realFetch }
})

test('session: no plan → the call reasons; with a plan and a success → the next call is quick', async () => {
  const { simulatedBot, startTestSession, sleep } = require('./helpers/session')
  let stage = 0
  const s = startTestSession({
    bot: simulatedBot(),
    actions: (p) => {
      if (/start the base/.test(p) && stage === 0) { stage = 1; return { a: 'goal', operation: 'add', description: 'small base', steps: ['get 20 oak_log', 'craft 40 planks'] } }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    it.brain.wake('start the base')
    assert.ok(await s.until(() => it.goals.openGoals().length === 1, 3000))
    const userText = (r) => { const m = r.messages.filter((x) => x.role === 'user')[0]; return typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
    const first = s.prompts.requests.find((r) => r.tools?.length > 5 && /start the base/.test(userText(r)))
    assert.ok(first, 'the planning request was captured')
    assert.match(userText(first), /this turn: THINK BRIEFLY/)
    assert.equal('enable_thinking' in first, false)
    assert.equal(first.max_tokens, 1536)

    const before = s.prompts.requests.length
    await sleep(100)
    it.brain.wake('carry on')
    assert.ok(await s.until(() => s.prompts.requests.slice(before).some((r) => r.tools?.length > 5 && /carry on/.test(userText(r))), 4000))
    const next = s.prompts.requests.slice(before).find((r) => r.tools?.length > 5 && /carry on/.test(userText(r)))
    assert.match(userText(next), /this turn: QUICK/)
    assert.equal(next.enable_thinking, false)
    assert.equal(next.max_tokens, 512)
  } finally { await s.stop() }
})
