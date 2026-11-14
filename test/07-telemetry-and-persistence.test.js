/**
 * 07 — Real-server session telemetry (`events.jsonl`, `continuation.json`,
 * `latest.json`) and `/data` persistence durability.
 *
 * Runs a full real-server gameplay session (spawn, multiplayer chat, action
 * reasoning & tool calls, movement, death/respawn, shutdown) and verifies
 * every file written inside `dataDir`.
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { startSimulation } = require('./helpers/sim-harness')

describe('07 — real-server telemetry & /data continuation persistence', () => {
  let sim = null
  let keepDir = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
    if (keepDir) {
      try { fs.rmSync(keepDir, { recursive: true, force: true }) } catch { /* noop */ }
      keepDir = null
    }
  })

  it('captures complete NDJSON events, model thoughts, chat, tools, world events, and continuation snapshots in dataDir', async () => {
    sim = await startSimulation({ keepDataDir: true })
    keepDir = sim.dataDir
    const { mc, llm, bot, internals, dataDir, waitFor } = sim

    // Connect Alice for real multiplayer chat_in + chat_out telemetry
    const alice = await mc.connectPlayer('Alice')
    const aliceHeard = []
    alice.on('messagestr', (m) => aliceHeard.push(m))

    llm.enqueueChat({
      reasoning: 'Alice asked how I am doing; reply briefly.',
      reply: { text: 'Doing great Alice!' }
    })
    alice.chat('How are you doing ZincAI?')
    await waitFor(() => aliceHeard.some((m) => /Doing great Alice!/i.test(m)), {
      timeoutMs: 12_000,
      label: 'Alice receiving chat reply'
    })

    // Run a multi-tool action turn with explicit reasoning trace
    const origin = bot.entity.position.floored()
    const target = origin.offset(4, 0, 0)
    llm.enqueueAction({
      reasoning: 'THOUGHT_TRACE_ALPHA: record a goal, jot a note, speak, and walk 4 blocks east.',
      toolCalls: [
        { name: 'goal', arguments: { operation: 'add', description: 'Explore eastern plain', origin: 'self_generated' } },
        { name: 'note', arguments: { text: 'Telemetry test note recorded cleanly' } },
        { name: 'say', arguments: { text: 'Heading east to explore.' } },
        { name: 'go_to', arguments: { x: target.x, y: target.y, z: target.z } }
      ]
    })
    internals.brain.wake('explore east and record telemetry', { external: true, urgent: true })

    await waitFor(() => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) <= 2.5, {
      timeoutMs: 15_000,
      label: 'bot reaching eastern exploration target'
    })

    // Trigger real death & respawn to confirm lifecycle events + flush
    let respawned = false
    bot.once('spawn', () => { respawned = true })
    mc.killPlayer('ZincAI')
    await waitFor(() => respawned && bot.health > 0, { timeoutMs: 15_000, label: 'respawn after death' })

    // Verify mid-session files ALREADY exist on disk before stop() (crash durability)
    const { sessionId, eventsFile, continuationFile, latestFile } = sim.shared.telemetry
    sim.shared.telemetry.flush({ reason: 'mid_session_check' })
    assert.ok(fs.existsSync(eventsFile), 'events.jsonl exists mid-session')
    assert.ok(fs.existsSync(continuationFile), 'continuation.json exists mid-session')
    assert.ok(fs.existsSync(latestFile), 'latest.json exists mid-session')

    // Cleanly stop simulation (runs final synchronous flush + session_end)
    await sim.stop()
    sim = null

    // 1. Validate latest.json pointer
    const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'))
    assert.equal(latest.sessionId, sessionId)
    assert.equal(latest.status, 'stopped')
    assert.ok(latest.eventsFile.includes(sessionId))
    assert.ok(latest.continuationFile.includes(sessionId))

    // 2. Validate events.jsonl NDJSON integrity and chronological completeness
    const rawLines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n')
    assert.ok(rawLines.length >= 10, `expected rich event log, got ${rawLines.length} lines`)
    const events = rawLines.map((line) => JSON.parse(line))

    // Monotonic sequence numbers and valid timestamps
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].sessionId, sessionId)
      assert.ok(Number.isFinite(events[i].ms))
      assert.ok(typeof events[i].ts === 'string')
      if (i > 0) assert.ok(events[i].seq > events[i - 1].seq, 'event seq must be strictly increasing')
    }

    const types = new Set(events.map((e) => e.type))
    assert.ok(types.has('session_start'), 'contains session_start')
    assert.ok(types.has('lifecycle'), 'contains lifecycle events')
    assert.ok(types.has('chat_in'), 'contains chat_in from Alice')
    assert.ok(types.has('chat_out'), 'contains chat_out from ZincAI')
    assert.ok(types.has('model_request'), 'contains model_request')
    assert.ok(types.has('model_response'), 'contains model_response')
    assert.ok(types.has('tool_exec'), 'contains tool_exec')
    assert.ok(types.has('world_event'), 'contains world_event')
    assert.ok(types.has('session_end'), 'contains session_end')

    // Confirm verbatim model reasoning thoughts captured on both action and chat lanes
    const actionResp = events.find((e) => e.type === 'model_response' && e.data.lane === 'action' && /THOUGHT_TRACE_ALPHA/.test(e.data.reasoning))
    assert.ok(actionResp, 'action lane reasoning_content captured verbatim in events.jsonl')
    assert.ok(actionResp.data.usage?.in > 0 && actionResp.data.usage?.out > 0, 'token usage recorded')

    const chatResp = events.find((e) => e.type === 'model_response' && e.data.lane === 'chat' && /Alice asked/.test(e.data.reasoning))
    assert.ok(chatResp, 'chat lane reasoning_content captured verbatim in events.jsonl')

    // Confirm lifecycle events captured spawn, death, respawn
    const phases = new Set(events.filter((e) => e.type === 'lifecycle').map((e) => e.data.phase))
    assert.ok(phases.has('spawn'), 'lifecycle recorded spawn')
    assert.ok(phases.has('death'), 'lifecycle recorded death')
    assert.ok(phases.has('respawn'), 'lifecycle recorded respawn')

    // 3. Validate continuation.json schema & live state fields
    const cont = JSON.parse(fs.readFileSync(continuationFile, 'utf8'))
    assert.equal(cont.schemaVersion, 1)
    assert.equal(cont.sessionId, sessionId)
    assert.equal(cont.status, 'stopped')
    assert.ok(cont.botState && cont.botState.position, 'continuation includes live botState.position')
    assert.ok(Array.isArray(cont.openGoals) && cont.openGoals.some((g) => /Explore eastern plain/i.test(g.label || '')), 'continuation includes open goals')
    assert.ok(cont.lastModelThought, 'continuation includes lastModelThought')
    assert.ok(Array.isArray(cont.recentTools) && cont.recentTools.length > 0, 'continuation includes recentTools')
    assert.ok(cont.stats.modelRequests >= 2 && cont.stats.modelResponses >= 2, 'stats tracked model calls')
    assert.ok(cont.stats.chatIn >= 1 && cont.stats.chatOut >= 1, 'stats tracked chat traffic')

    // 4. Confirm data stores persisted under dataDir (not legacy zincai/data)
    assert.ok(fs.existsSync(path.join(dataDir, 'goals.json')), 'goals.json in dataDir')
    assert.ok(fs.existsSync(path.join(dataDir, 'sessions', sessionId, 'events.jsonl')), 'events.jsonl under dataDir/sessions/<id>/')
  })
})
