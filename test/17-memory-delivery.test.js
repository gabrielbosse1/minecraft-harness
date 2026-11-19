'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { startSimulation } = require('./helpers/sim-harness')
const { EventPipeline } = require('../zincai/events')

const idle = { toolCalls: [{ name: 'idle', arguments: {} }] }

test('real-server action delivery survives draft, HTTP error, cancellation, compaction and credit failure', { timeout: 60_000 }, async () => {
  const sim = await startSimulation({ cfgOverrides: { amd: { maxRetries: 0 }, inference: { loopMs: 60_000 } } })
  try {
    const { brain, buildActionPrompt } = sim.session.internals()
    brain.paused = true
    const pipe = sim.shared.events
    const emit = (summary, importance = 3) => pipe.record({ eventType: 'discovery', summary, importance, dedupeKey: null }).event
    const critical = emit('durable delivery canary critical')
    const batch = emit('durable delivery canary batch', 2)
    const draft = buildActionPrompt(['audit delivery'])
    assert.ok(draft.shownSequences.includes(critical.sequence))
    assert.ok(draft.shownSequences.includes(batch.sequence))
    assert.equal(critical.processedAt, null)

    sim.llm.enqueueAction({ httpStatus: 401 })
    await assert.rejects(brain.act(['audit HTTP failure']), /HTTP 401/)
    assert.equal(critical.processedAt, null)

    sim.llm.enqueueAction(() => { brain.inflightAbort('audit cancellation'); return idle })
    await brain.act(['audit cancellation'])
    assert.equal(critical.processedAt, null)

    sim.llm.enqueueAction({ httpStatus: 400, error: 'maximum context length exceeded' })
    sim.llm.enqueueAction({ httpStatus: 400, error: 'maximum context length exceeded' })
    sim.llm.enqueueAction(idle)
    await brain.act(['audit compacted success'])
    assert.ok(critical.processedAt, 'critical record was in the accepted compacted request')
    const used = sim.llm.actionRequests().at(-1).messages[1].content
    assert.match(used, /durable delivery canary critical/)
    assert.equal(Boolean(batch.processedAt), used.includes('durable delivery canary batch'), 'ack only the records that were really sent')
    const at = critical.processedAt
    pipe.markProcessed([critical.sequence])
    assert.equal(critical.processedAt, at)

    const billing = emit('durable delivery canary billing')
    sim.llm.enqueueAction({ httpStatus: 429, body: { error: { code: 'insufficient_quota' } } })
    await assert.rejects(brain.act(['audit credit failure']), { code: 'ZINCAI_CREDITS' })
    const count = sim.llm.actionRequests().length
    await brain.act(['should not request again'])
    assert.equal(sim.llm.actionRequests().length, count)
    const checkpoint = JSON.parse(fs.readFileSync(path.join(sim.dataDir, 'memory-checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.reason, 'credits_exhausted')
    assert.ok(checkpoint.pendingEventIds.includes(billing.sequence))
    const reopened = new EventPipeline({ file: pipe.file })
    assert.ok(reopened.undelivered().some((e) => e.sequence === billing.sequence && e.recoveredFromRestart))
    assert.ok(!reopened.undelivered().some((e) => e.sequence === critical.sequence))
  } finally { await sim.stop() }
})

test('real-server chat can be retried without advancing its durable receipt on provider error', { timeout: 45_000 }, async () => {
  const sim = await startSimulation({ cfgOverrides: { inference: { loopMs: 60_000 } } })
  try {
    const { brain } = sim.session.internals()
    brain.paused = true
    const pipe = sim.shared.events
    const event = pipe.record({ eventType: 'chat', importance: 2, summary: 'pending reply', dedupeKey: null,
      chat: { sender: 'Alice', text: 'pending reply', whisper: true } }).event
    const input = [{ ...event.chat, eventId: event.sequence, at: event.observedAt }]
    sim.llm.enqueueChat({ httpStatus: 401 })
    await assert.rejects(brain.talk('Alice', input), /HTTP 401/)
    assert.equal(event.processedAt, null)
    const reopened = new EventPipeline({ file: pipe.file })
    assert.deepEqual(reopened.undelivered().find((e) => e.sequence === event.sequence)?.chat, event.chat)
    sim.llm.enqueueChat({ toolCalls: [{ name: 'reply', arguments: { text: '', decision: 'ignore' } }] })
    await brain.talk('Alice', input)
    assert.ok(event.processedAt)
    assert.equal(event.processedVia, 'chat')
  } finally { await sim.stop() }
})
