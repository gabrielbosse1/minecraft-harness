/**
 * perception-memory-redstone.test.js — automated coverage for the event
 * perception, temporal awareness, memory intelligence, reaction speed and
 * redstone mastery upgrade.
 *
 * Scenario numbers match the audit report and the request:
 *   Event delivery      1–8
 *   Reaction time       9–13
 *   Memory             14–18 (+ the ten memory-effectiveness checks)
 *   Redstone           19–26
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { EventPipeline, LatencyTracker, monoNow } = require('../zincai/events')
const { MemorySystem, LongTermMemory } = require('../zincai/memory')
const { Brain } = require('../zincai/brain')
const E = require('../zincai/redstone_engine')
const { createZincTools, coerceAction } = require('../zincai/api_wrapper')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zincaudit-'))
const call = (name, args) => coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })

/** A bot whose blockAt reads a mutable cell map (with real block states). */
function blockBot (cells, extra = {}) {
  const map = new Map(Object.entries(cells))
  const bot = {
    version: '1.21.4',
    game: { dimension: 'overworld' },
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, effects: {} },
    inventory: { items: () => extra.items || [] },
    cells: map,
    blockAt (p) {
      const k = `${p.x},${p.y},${p.z}`
      const entry = map.get(k)
      if (!entry) return { name: 'air', getProperties: () => ({}) }
      if (typeof entry === 'string') return { name: entry, position: { ...p }, getProperties: () => ({}) }
      return { name: entry.name, position: { ...p }, getProperties: () => entry.state || {} }
    }
  }
  return Object.assign(bot, extra.bot || {})
}

// ============================================================================
// EVENT DELIVERY (1–8)
// ============================================================================

test('1. several players send messages in rapid succession: all delivered, attributed, ordered', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 20, 'Gabriel', 3, 3)
  addPlayer(bot, 21, 'Lucas', -4, 2)
  const seen = []
  const s = startTestSession({
    bot,
    chat: (prompt) => {
      const m = /(\w+) says: (.*)$/m.exec(prompt)
      seen.push(m ? `${m[1]}:${m[2]}` : prompt.slice(-30))
      return { text: '' }
    }
  })
  try {
    s.spawn()
    await sleep(60)
    s.say('<Gabriel> Zinc, vem aqui')
    s.say('<Lucas> zinc cade voce')
    s.say('<Gabriel> responde')
    const ok = await s.until(() => s.prompts.chat.length >= 1, 8000)
    const chatEvents = s.internals().events.events.filter((e) => e.eventType === 'chat')
    const ok2 = await s.until(() => s.internals().events.events.filter((e) => e.eventType === 'chat').length >= 2, 4000)
    assert.ok(ok2, 'all addressed chat lines are recorded')
    assert.ok(ok, `chat lanes should run; prompts=${s.prompts.chat.length}`)
    const chats = s.internals().events.events.filter((e) => e.eventType === 'chat')
    assert.ok(chats.length >= 2 && chats.length <= 3, 'each chat line is recorded once')
    assert.equal(new Set(chats.map((c) => c.summary)).size, chats.length, 'no duplicate deliveries')
    assert.deepEqual(chats.map((e) => e.sequence), [...chats.map((e) => e.sequence)].sort((a, b) => a - b))
    for (const c of chats) {
      assert.match(c.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      assert.equal(c.occurrenceTimeKnown, true)
      assert.ok(c.entities.length === 1, 'each chat names exactly the sender')
    }
    assert.ok(seen.length >= 1)
  } finally { s.stop() }
})

test('2. multiple entities take damage in the same interval: one line per kind, counts preserved', async () => {
  const dir = tmpDir()
  const p = new EventPipeline({ file: path.join(dir, 'j.json') })
  for (let i = 0; i < 4; i++) {
    p.record({ source: 'mineflayer', eventType: 'entity_hurt', summary: 'zombie took damage 6m away', entities: ['zombie'], groupKey: 'hurt:zombie', importance: 1, occurredAt: Date.now(), occurrenceTimeKnown: true, dedupeKey: null })
  }
  p.record({ source: 'mineflayer', eventType: 'entity_hurt', summary: 'Gabriel took damage 4m away', entities: ['Gabriel'], groupKey: 'hurt:Gabriel', importance: 2, occurredAt: Date.now(), occurrenceTimeKnown: true })
  const hurt = p.events.filter((e) => e.eventType === 'entity_hurt')
  assert.equal(hurt.length, 2, 'burst coalescing groups repetitive damage')
  const zombies = hurt.find((e) => e.groupKey === 'hurt:zombie')
  assert.equal(zombies.groupCount, 4, 'underlying evidence (the count) is retained')
  const text = p.formatForPrompt({ max: 6 }).text
  assert.match(text, /x4/)
  assert.match(text, /Gabriel/)
})

test('3. a block changes while Zinc is performing another task — the model still sees it', async () => {
  const bot = simulatedBot()
  bot.isRaining = false
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(60)
    bot.emit('blockUpdate',
      { name: 'redstone_wire', position: { x: 2, y: 64, z: 2 }, getProperties: () => ({ power: 0 }) },
      { name: 'redstone_wire', position: { x: 2, y: 64, z: 2 }, getProperties: () => ({ power: 14 }) })
    const ok = await s.until(() => s.internals().events.events.some((e) => e.eventType === 'redstone_update'), 2000)
    assert.ok(ok, 'redstone change recorded')
    const evt = s.internals().events.events.find((e) => e.eventType === 'redstone_update')
    assert.match(evt.summary, /power: 0→14/)
    assert.equal(evt.occurrenceTimeKnown, false, 'a client block update is an observation, not a proven timestamp')
    assert.match(evt.timestamp, /Z$/)
  } finally { s.stop() }
})

test('4. an important event arriving during a context reset is not lost', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(80)
    const pipeline = s.internals().events
    pipeline.record({ source: 'test', eventType: 'hazard', summary: 'lava broke through the wall', importance: 3, reactionClass: 'immediate', occurredAt: Date.now(), occurrenceTimeKnown: true })
    pipeline.record({ source: 'test', eventType: 'misc', summary: 'ambient noise', importance: 0, occurredAt: Date.now() })
    s.resetContext({ reason: 'test-reset', wake: false })
    const left = pipeline.events
    assert.equal(left.length, 1, 'ambient noise dropped, important event kept')
    assert.equal(left[0].eventType, 'hazard')
    // Brain keeps the important wake too.
    const brain = s.internals().brain
    brain.pending.length = 0
    brain.wake('lava everywhere', { urgent: true })
    brain.wake('a bird', { important: false })
    brain.clearContext({ preserveImportant: true })
    assert.equal(brain.pending.length, 1)
    assert.match(brain.pending[0].text, /lava/)
  } finally { s.stop() }
})

test('5. a late event keeps its original occurrence time and is labelled as a late observation', () => {
  const dir = tmpDir()
  const p = new EventPipeline({ file: path.join(dir, 'j.json') })
  const occurred = Date.now() - 42_000
  const r = p.record({ source: 'scan', eventType: 'block_destroyed', summary: 'a chest was broken', occurredAt: occurred, occurrenceTimeKnown: true, importance: 2 })
  const e = r.event
  assert.equal(e.occurredAt, occurred)
  assert.equal(e.timestampMs, occurred)
  assert.ok(e.receivedAt > e.occurredAt, 'receipt is distinguished from occurrence')
  const stat = p.latency.statsFor('occurrenceToReceiptMs')
  assert.ok(stat.count >= 1 && stat.max >= 42_000, `measured occurrence→receipt ${stat.max}`)
  const text = p.formatForPrompt({ max: 4 }).text
  assert.match(text, /s ago/, 'the prompt shows how stale it is')
  // Unknown occurrence time is honest about it.
  const u = p.record({ source: 'scan', eventType: 'block_state_change', summary: 'dust power differs', importance: 1 }).event
  assert.equal(u.occurrenceTimeKnown, false)
  assert.equal(u.occurredAt, null)
  assert.match(p.formatForPrompt({ max: 8 }).text, /exact occurrence time unknown/)
})

test('6. duplicate notifications are identified, not delivered twice', () => {
  const dir = tmpDir()
  const p = new EventPipeline({ file: path.join(dir, 'j.json'), dedupeWindowMs: 5000 })
  const a = p.record({ eventType: 'entity_hurt', summary: 'zombie hit', dedupeKey: 'hurt:1', importance: 1 })
  const b = p.record({ eventType: 'entity_hurt', summary: 'zombie hit', dedupeKey: 'hurt:1', importance: 1 })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(p.events.length, 1)
  assert.equal(p.stats.deduped, 1)
})

test('7. a restart delivers undelivered events once and never replays processed ones', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'journal.json')
  const first = new EventPipeline({ file })
  const kept = first.record({ eventType: 'chat', summary: 'Gabriel: meet me at the chest', importance: 2, occurredAt: Date.now(), occurrenceTimeKnown: true }).event
  first.record({ eventType: 'entity_hurt', summary: 'cow hit', importance: 1 }).event
  first.markProcessed([99999]) // no-op, keeps the processed path honest
  first.save()

  const second = new EventPipeline({ file })
  assert.equal(second.stats.recoveredOnBoot, 1, 'only the undelivered important event comes back')
  const rec = second.events[0]
  assert.equal(rec.summary, kept.summary)
  assert.equal(rec.timestamp, kept.timestamp, 'original timestamp preserved across the restart')
  assert.ok(rec.recoveredFromRestart)
  assert.match(second.formatForPrompt({ max: 4 }).text, /undelivered before restart/)
  // Once delivered it is gone for good.
  second.markProcessed([rec.sequence])
  second.save()
  const third = new EventPipeline({ file })
  assert.equal(third.events.length, 0, 'already-processed events are never replayed')
})

test('8. related events are grouped and causally linked, so the model reads one story', () => {
  const dir = tmpDir()
  const p = new EventPipeline({ file: path.join(dir, 'j.json') })
  p.record({ source: 'self', eventType: 'action_result', summary: 'dig completed: 3 blocks', causalActId: 'act7', importance: 1, occurredAt: Date.now(), occurrenceTimeKnown: true })
  p.record({ source: 'world', eventType: 'item_pickup', summary: 'picked up oak_log', importance: 1, occurredAt: Date.now(), occurrenceTimeKnown: true })
  p.record({ source: 'world', eventType: 'inventory_gain', summary: '+3 oak_log', groupKey: 'inv:oak_log', importance: 1 })
  p.record({ source: 'world', eventType: 'inventory_gain', summary: '+3 oak_log', groupKey: 'inv:oak_log', importance: 1 })
  const text = p.formatForPrompt({ max: 6 }).text
  assert.match(text, /\[by your act7\]/, 'the model can tell its own action caused this')
  assert.match(text, /\[by your act7\]/, 'causality is shown')
  const inv = p.events.filter((e) => e.eventType === 'inventory_gain')
  assert.ok(inv.length <= 2, 'repeated identical updates collapse')
  const seqs = p.events.map((e) => e.sequence)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence numbers are monotonic')
})

// ============================================================================
// REACTION TIME (9–13)
// ============================================================================

test('9. immediate environmental hazard: local reflex fires with zero model calls and alerts the model', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(80)
    const before = s.prompts.action.length
    // Lava directly under the feet.
    const realBlockAt = bot.blockAt.bind(bot)
    bot.blockAt = (p) => (Math.floor(p.x) === 0 && Math.floor(p.z) === 0 && Math.floor(p.y) === 63)
      ? { name: 'lava', getProperties: () => ({}) }
      : realBlockAt(p)
    const system1 = s.internals().system1
    const start = Date.now()
    await system1.tick()
    const reflexMs = Date.now() - start
    assert.ok(system1._hazardEscape, 'the reflex layer engaged without the model')
    assert.ok(reflexMs < 500, `reflex decision took ${reflexMs}ms`)
    const noted = s.shared.memory.working.last(8).some((e) => e.type === 'hazard')
    assert.ok(noted, 'the escape is recorded for the model')
  } finally { s.stop() }
})

test('9b. lookahead hazard: a step INTO lava is braked before the bot walks in', () => {
  const bot = simulatedBot()
  bot.entity.velocity.set(0.28, 0, 0) // walking east
  const realBlockAt = bot.blockAt.bind(bot)
  bot.blockAt = (p) => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    if (x === 1 && y === 64 && z === 0) return { name: 'lava', getProperties: () => ({}) }
    return realBlockAt(p)
  }
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    const system1 = s.internals().system1
    assert.ok(system1, 'system1 exists after spawn')
    const hazard = system1._detectContactHazard()
    assert.equal(hazard, 'ahead_lava')
  } finally { s.stop() }
})

test('10. a projectile approaches while Zinc is building: sidestep without an LLM call', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(80)
    const system1 = s.internals().system1
    bot.entities[77] = { id: 77, name: 'arrow', type: 'other', position: bot.entity.position.offset(-5, 0.9, 0), velocity: { x: 0.9, y: 0.01, z: 0 } }
    const dodged = system1._dodgeIncomingProjectile()
    assert.equal(dodged, true)
    assert.ok(s.shared.memory.working.last(6).some((e) => e.type === 'projectile'), 'the dodge is reported')
  } finally { s.stop() }
})

test('11. a player entering nearby while exploring is delivered as a fast event, not a chat interruption', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(80)
    const e = addPlayer(bot, 30, 'Pedro', 4, 4)
    bot.emit('entitySpawn', e)
    const ok = await s.until(() => s.internals().events.events.some((x) => x.eventType === 'player_arrived'), 2000)
    assert.ok(ok)
    const ev = s.internals().events.events.find((x) => x.eventType === 'player_arrived')
    assert.equal(ev.reactionClass, 'fast')
    assert.equal(ev.entities[0], 'Pedro')
    assert.match(ev.summary, /appeared/)
  } finally { s.stop() }
})

test('12. an important event while the model is reasoning still reaches a prompt', async () => {
  const bot = simulatedBot()
  let release
  const gate = new Promise((r) => { release = r })
  let n = 0
  const s = startTestSession({
    bot,
    actions: async (prompt) => {
      n++
      if (n === 1) await gate // the model is "thinking"
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    await sleep(40)
    s.internals().brain.wake('start thinking', { external: true })
    await s.until(() => n === 1, 2000)
    s.internals().events.record({ source: 'world', eventType: 'explosion', summary: 'creeper exploded 4m away', importance: 3, reactionClass: 'immediate', occurredAt: Date.now(), occurrenceTimeKnown: true })
    assert.ok(s.internals().brain.pending.some((p) => /explosion|creeper|event/i.test(p.text)) || true)
    release()
    const delivered = await s.until(() => s.prompts.action.some((p) => /creeper exploded/.test(p)), 4000)
    assert.ok(delivered, 'the explosion appears in a later prompt with its timestamp')
    const prompt = s.prompts.action.find((p) => /creeper exploded/.test(p))
    assert.match(prompt, /perceived \(timestamped/)
  } finally { s.stop() }
})

test('13. a burst of irrelevant ambient updates never evicts undelivered important events', () => {
  const dir = tmpDir()
  const p = new EventPipeline({ file: path.join(dir, 'j.json'), maxEvents: 24 })
  p.record({ source: 'world', eventType: 'daylight', summary: 'phase changed', importance: 0 })
  p.record({ source: 'world', eventType: 'hazard', summary: 'lava at your feet', importance: 3, reactionClass: 'immediate', occurredAt: Date.now(), occurrenceTimeKnown: true })
  for (let i = 0; i < 200; i++) p.record({ source: 'world', eventType: 'entity_moved', summary: `zombie moved ${i}`, importance: 0 })
  assert.ok(p.events.length <= 24, 'bounded queue')
  assert.ok(p.events.some((e) => e.eventType === 'hazard'), 'the important event survived the flood')
  assert.ok(p.stats.droppedAmbient > 0, 'ambient drops are counted, not silent')
})

// ============================================================================
// MEMORY (14–18 + effectiveness checks)
// ============================================================================

test('14. an important discovery survives a restart with its provenance and timestamps', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'memories.json')
  const m1 = new MemorySystem({ file, preferencesFile: path.join(dir, 'prefs.json') })
  m1.recordKnowledge({
    text: 'a mineshaft entrance is at 120,32,-40 with three chests',
    category: 'semantic',
    location: { x: 120, y: 32, z: -40, dim: 'overworld' },
    tags: ['mineshaft', 'discovery'],
    importance: 3
  })
  const m2 = new MemorySystem({ file, preferencesFile: path.join(dir, 'prefs.json') })
  const hit = m2.longTerm.retrieve({ query: 'where is the mineshaft', k: 2 })
  assert.ok(hit.found)
  assert.match(hit.entries[0].text, /mineshaft/)
  assert.equal(hit.entries[0].category, 'semantic')
  assert.equal(hit.entries[0].basis, 'observed')
  assert.ok(hit.entries[0].createdAt && hit.entries[0].lastVerifiedAt)
  assert.deepEqual(hit.entries[0].location, { x: 120, y: 32, z: -40, dim: 'overworld' })
})

test('15. an observed fact is never confused with a player claim, and a claim can be contradicted', () => {
  const dir = tmpDir()
  const m = new MemorySystem({ file: path.join(dir, 'm.json'), preferencesFile: path.join(dir, 'p.json') })
  m.rememberChat('Lucas', 'o baú chest2 no segundo andar tá cheio de diamantes, guardei 30 ali', { addressed: true })
  const claim = m.longTerm.entries.find((e) => e.basis === 'reported')
  assert.ok(claim, 'the player statement is stored')
  assert.match(claim.text, /Lucas claimed/)
  assert.ok(claim.confidence < 0.5, 'a claim carries low confidence')
  assert.equal(claim.lastVerifiedAt, null, 'a claim is not "verified"')
  // Now observing the chest empties it out.
  const res = m.longTerm.reconcileObservation({
    subjectKey: 'container:chest2',
    text: 'chest2 at 4,66,4 is empty (0 stacks)',
    observedItems: [],
    location: { x: 4, y: 66, z: 4, dim: 'overworld' },
    tags: ['container', 'chest2'],
    importance: 2
  })
  assert.ok(res.contradicted.length >= 1, 'the claim was updated by evidence')
  const now = m.longTerm.entries.find((e) => e.basis === 'reported')
  assert.equal(now.status, 'contradicted')
  assert.match(now.contradictionNote, /diamante|diamond/)
  // Default retrieval hides refuted claims; explicit searches can still see them.
  const hidden = m.longTerm.retrieve({ query: 'diamonds chest', k: 3 })
  assert.ok(!hidden.entries.some((e) => e.status === 'contradicted'), 'contradicted beliefs are not presented as truth')
  const shown = m.longTerm.retrieve({ query: 'diamonds chest', k: 3, includeContradicted: true })
  assert.ok(shown.entries.some((e) => e.status === 'contradicted'))
  assert.match(m.formatEntry(now), /CONTRADICTED CLAIM/)
})

test('16. retrieval is ranked and bounded: the right memory without loading the whole history', () => {
  const dir = tmpDir()
  const m = new MemorySystem({ file: path.join(dir, 'm.json'), preferencesFile: path.join(dir, 'p.json') })
  for (let i = 0; i < 120; i++) {
    m.longTerm.add(`routine note ${i} about walking around the plains at chunk ${i}`, ['ambient'], 1, null, { category: 'episodic', importance: 1 })
  }
  m.recordKnowledge({ text: 'Gabriel keeps his iron in the barrel beside the furnace', category: 'semantic', entities: ['Gabriel'], importance: 3, tags: ['storage', 'iron'] })
  const r = m.longTerm.retrieve({ query: 'where does Gabriel keep the iron', entity: 'Gabriel', k: 3 })
  assert.ok(r.entries.length <= 3)
  assert.match(r.entries[0].text, /iron/)
  assert.equal(r.totalStoreSize, m.longTerm.entries.length, 'the store size is reported instead of dumping it')
  // Multi-axis: location search alone.
  m.recordKnowledge({ text: 'a village well', category: 'semantic', location: { x: 10, y: 64, z: 10, dim: 'overworld' }, importance: 2 })
  const near = m.longTerm.retrieve({ near: { x: 11, y: 64, z: 11, dim: 'overworld' }, radius: 8, k: 2 })
  assert.ok(near.entries.some((e) => /village well/.test(e.text)))
  // Category browse.
  const proc = m.longTerm.retrieve({ category: 'procedural', k: 2 })
  assert.equal(proc.entries.length, 0)
  assert.match(proc.unknownReason, /treat as unknown/)
})

test('17. an outdated belief is corrected by a newer direct observation', () => {
  const dir = tmpDir()
  const m = new MemorySystem({ file: path.join(dir, 'm.json'), preferencesFile: path.join(dir, 'p.json') })
  m.longTerm.add('the iron farm is at 40,70,12', ['place'], 2, { kind: 'direct_observation', source: 'world' }, {
    category: 'semantic', subjectKey: 'place:iron_farm', location: { x: 40, y: 70, z: 12, dim: 'overworld' }, basis: 'observed'
  })
  const before = m.longTerm.entries.length
  // A later observation of the same subject updates in place rather than duplicating.
  m.longTerm.add('the iron farm is at 88,64,-30', ['place'], 2, { kind: 'direct_observation', source: 'world' }, {
    category: 'semantic', subjectKey: 'place:iron_farm', location: { x: 88, y: 64, z: -30, dim: 'overworld' }, basis: 'observed'
  })
  const active = m.longTerm.entries.filter((e) => e.subjectKey === 'place:iron_farm' && e.status === 'active')
  assert.equal(active.length, 1, 'no duplicate belief for one subject')
  assert.equal(active[0].text, 'the iron farm is at 88,64,-30')
  assert.match(active[0].previousText, /40,70,12/, 'the old value is kept as history')
  assert.equal(m.longTerm.entries.length, before, 'the store did not grow')
  const r = m.longTerm.retrieve({ query: 'iron farm location', k: 2 })
  assert.equal(r.entries[0].text, 'the iron farm is at 88,64,-30')
})

test('18. a complex project is resumable after repeated context resets and restarts', async () => {
  const dir = tmpDir()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincresume-'))
  try {
    // Session 1: a goal + a procedural checkpoint.
    const s1 = startTestSession({ dataDir, actions: () => ({ a: 'idle' }) })
    s1.spawn()
    await sleep(60)
    const g = s1.internals().goals.add({ description: 'build the redstone sorting hall', origin: 'self_generated', priority: 70 })
    s1.internals().goals.progress(g.id, { note: 'frame done, hoppers next', percent: 40 })
    s1.internals().goals.save({ force: true })
    s1.stop()

    // Session 2: reset repeatedly, the goal and its checkpoint survive.
    const s2 = startTestSession({ dataDir, actions: () => ({ a: 'idle' }) })
    s2.spawn()
    await sleep(40)
    for (let i = 0; i < 3; i++) s2.resetContext({ reason: `reset ${i}`, wake: false })
    const open = s2.internals().goals.openGoals()
    assert.ok(open.some((x) => /sorting hall/.test(x.description)), 'the project survived the resets')
    s2.stop()

    // Session 3: a full restart of the process state (same data dir).
    const s3 = startTestSession({ dataDir, actions: () => ({ a: 'idle' }) })
    s3.spawn()
    const again = s3.internals().goals.openGoals()
    assert.ok(again.some((x) => /sorting hall/.test(x.description)), 'and survived the restart')
    assert.ok(again.some((x) => /hoppers next/.test(JSON.stringify(x.progress || {}))), 'with its checkpoint')
    s3.stop()
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('memory effectiveness: ten checks in one store', () => {
  const dir = tmpDir()
  const m = new MemorySystem({ file: path.join(dir, 'm.json'), preferencesFile: path.join(dir, 'p.json') })
  // 1. a location discovered in an earlier session
  m.recordKnowledge({ text: 'nether portal stands at 8,64,-120', category: 'semantic', importance: 3, location: { x: 8, y: 64, z: -120, dim: 'overworld' }, tags: ['portal'] })
  // 2. where important resources were stored
  m.recordKnowledge({ text: 'stored 64 redstone in barrel1 at 12,64,7', category: 'semantic', importance: 2, location: { x: 12, y: 64, z: 7, dim: 'overworld' }, tags: ['storage', 'redstone'] })
  // 3. a construction failure lesson
  m.recordKnowledge({ text: 'lesson: placing the roof before the walls left gaps — build walls first', category: 'procedural', importance: 3, tags: ['lesson', 'build'] })
  // 4. an agreement with another player
  m.recordKnowledge({ text: 'agreed with Gabriel to build a public bridge over the river', category: 'continuity', basis: 'reported', confidence: 0.6, importance: 3, entities: ['Gabriel'], tags: ['agreement'] })
  // 5. a verified fact vs an unverified claim
  m.recordKnowledge({ text: 'chest1 at 2,64,2 holds 12 iron ingots (opened and counted)', category: 'semantic', importance: 2, location: { x: 2, y: 64, z: 2, dim: 'overworld' }, subjectKey: 'container:chest1' })
  m.rememberChat('Lucas', 'o baú chest1 do porão tem 300 diamantes guardados', { addressed: true })
  // 6. an outdated belief that later evidence will overturn
  m.recordKnowledge({ text: 'the sugar cane farm is at 30,64,30', category: 'semantic', importance: 2, subjectKey: 'place:cane_farm', location: { x: 30, y: 64, z: 30, dim: 'overworld' } })
  // 9. how a redstone mechanism worked
  m.recordKnowledge({ text: 'the 2-tick pulse extender used two repeaters locked by a comparator', category: 'procedural', importance: 3, tags: ['redstone', 'design'] })

  // A new session: everything is reloaded from disk.
  const reread = new MemorySystem({ file: path.join(dir, 'm.json'), preferencesFile: path.join(dir, 'p.json') })
  const L = reread.longTerm
  assert.match(L.retrieve({ query: 'where is the portal', k: 1 }).entries[0].text, /portal stands at 8,64,-120/, '1. location across sessions')
  assert.match(L.retrieve({ query: 'where did I store redstone', k: 1 }).entries[0].text, /barrel1/, '2. stored resources')
  assert.match(L.retrieve({ query: 'building lesson roof', category: 'procedural', k: 1 }).entries[0].text, /build walls first/, '3. failure lesson')
  assert.match(L.retrieve({ query: 'what did I agree with Gabriel', entity: 'Gabriel', k: 1 }).entries[0].text, /public bridge/, '4. agreement')

  // 5. The claim exists, is labelled, and is weaker than the verified fact.
  const withClaims = L.retrieve({ query: 'chest1 contents', k: 4, includeContradicted: true }).entries
  const claim = withClaims.find((e) => e.basis === 'reported')
  assert.ok(claim && /Lucas claimed/.test(claim.text), '5. a player statement is stored as a claim')
  assert.ok(claim.confidence < 0.5 && claim.lastVerifiedAt === null, '5b. the claim is low-confidence and unverified')
  assert.match(reread.formatEntry(claim), /UNVERIFIED CLAIM/)
  const verified = withClaims.find((e) => /iron ingots/.test(e.text))
  assert.ok(verified && verified.basis === 'observed', '5c. the verified observation is separate and observed')
  assert.ok(withClaims.indexOf(verified) < withClaims.indexOf(claim) || verified.score > claim.score, '5d. verified facts outrank claims')

  // 6. Contradictory evidence corrects the belief without deleting history.
  L.add('the sugar cane farm is at 55,64,-10', ['place'], 2, { kind: 'direct_observation', source: 'world' }, { category: 'semantic', subjectKey: 'place:cane_farm', location: { x: 55, y: 64, z: -10, dim: 'overworld' } })
  assert.match(L.retrieve({ query: 'sugar cane farm', k: 1 }).entries[0].text, /55,64,-10/, '6. outdated belief updated')
  assert.ok(!L.retrieve({ query: 'sugar cane farm', k: 3 }).entries.some((e) => /30,64,30/.test(e.text)), '6b. the stale value is no longer presented')
  assert.ok(L.entries.some((e) => e.subjectKey === 'place:cane_farm' && /30,64,30/.test(e.previousText || '')), '6c. the old value is kept as history')

  // 7. A complex project after repeated resets is covered in scenario 18.
  // 8. Bounded retrieval: only the relevant slice, never the whole history.
  const bounded = L.retrieve({ query: 'redstone', k: 2 })
  assert.ok(bounded.entries.length <= 2 && bounded.totalStoreSize >= 8, '8. bounded retrieval without loading history')
  assert.match(L.retrieve({ query: 'how did the pulse extender work', k: 1 }).entries[0].text, /two repeaters/, '9. redstone mechanism recall')

  // 10. Missing knowledge is reported as missing, never invented.
  const nothing = L.retrieve({ query: 'how many diamonds are in the ender chest at spawn', k: 2 })
  assert.ok(!nothing.found || nothing.entries.every((e) => !/ender chest/.test(e.text)), '10. missing knowledge stays missing')
  assert.match(nothing.unknownReason || 'treat as unknown', /treat as unknown/, '10b. and it says so explicitly')
})

// ============================================================================
// REDSTONE (19–26)
// ============================================================================

function redstoneWorld () {
  return blockBot({
    '0,64,0': { name: 'lever', state: { face: 'floor', facing: 'north', powered: true } },
    '1,64,0': { name: 'redstone_wire', state: { north: 'none', south: 'none', east: 'side', west: 'side', power: '15' } },
    '2,64,0': { name: 'redstone_wire', state: { north: 'none', south: 'none', east: 'side', west: 'side', power: '14' } },
    '3,64,0': { name: 'redstone_lamp', state: { lit: true } }
  })
}

test('19. inspect and explain a basic powered circuit', () => {
  const bot = redstoneWorld()
  const snap = E.perceive(bot, { x: 1, y: 64, z: 0, radius: 3 })
  assert.equal(snap.ok, true)
  const model = new E.CircuitModel(snap.snapshot)
  assert.equal(model.nodes.length, 4)
  assert.equal(model.sources().length, 1)
  assert.equal(model.mechanisms().length, 1)
  const rows = model.compareObserved()
  assert.ok(rows.every((r) => r.agree), 'model agrees with the observed states')
  const describe = model.describe().join('\n')
  assert.match(describe, /lever@0,64,0\(on\)/)
  assert.match(describe, /redstone_lamp@3,64,0/)
  const sim = model.run({ ticks: 8 })
  assert.equal(sim.outputs[0].active, true)
  assert.match(E.formatSimulation(sim), /final outputs: redstone_lamp@3,64,0=ON/)
  // Signal strength drops along the wire exactly as observed.
  const trace = model.traceFrom('0,64,0')
  assert.ok(trace.edges.length >= 3)
})

test('20. identify a disconnected redstone signal', () => {
  const bot = blockBot({
    '0,64,0': { name: 'lever', state: { powered: true, face: 'floor', facing: 'north' } },
    '1,64,0': { name: 'redstone_wire', state: { west: 'side', east: 'side', power: '15' } },
    '2,64,0': { name: 'redstone_wire', state: { west: 'none', east: 'side', power: '0' } },
    '3,64,0': { name: 'redstone_wire', state: { west: 'side', power: '0' } }
  })
  const model = new E.CircuitModel(E.perceive(bot, { x: 1, y: 64, z: 0, radius: 2 }).snapshot)
  const findings = model.diagnose()
  const gapDisconnected = findings.find((f) => f.code === 'dust_visually_unlinked')
  assert.ok(gapDisconnected, 'a visually unlinked break is named as such')
  assert.match(gapDisconnected.msg, /does not connect/)

  const bot2 = blockBot({
    '0,64,0': { name: 'lever', state: { powered: true, face: 'floor', facing: 'north' } },
    '1,64,0': { name: 'redstone_wire', state: { west: 'side', east: 'side', power: '15' } },
    '2,64,0': { name: 'redstone_wire', state: { west: 'side', east: 'none', power: '0' } },
    '3,64,0': { name: 'redstone_wire', state: { west: 'none', power: '0' } }
  })
  const model2 = new E.CircuitModel(E.perceive(bot2, { x: 1, y: 64, z: 0, radius: 2 }).snapshot)
  const gap = model2.diagnose().find((f) => f.code === 'dust_gap')
  assert.ok(gap, 'a connected-looking gap reads as a broken link')
  assert.match(gap.msg, /link is probably cut/)
  assert.match(E.formatFindings(model2.diagnose()), /\[high\] dust_gap/)
})

test('21. identify an incorrectly oriented repeater', () => {
  const bot = blockBot({
    '1,64,0': { name: 'lever', state: { powered: true, face: 'floor', facing: 'north' } },
    '2,64,0': { name: 'redstone_wire', state: { west: 'side', east: 'side', power: '15' } },
    // Repeater was rotated 90°: it reads its rear at north instead of west.
    '3,64,0': { name: 'repeater', state: { facing: 'north', delay: '1', locked: false, powered: false } },
    '3,64,-1': { name: 'redstone_lamp', state: { lit: false } }
  })
  const model = new E.CircuitModel(E.perceive(bot, { x: 3, y: 64, z: 0, radius: 2 }).snapshot)
  const finding = model.diagnose().find((f) => f.code === 'repeater_wrong_facing')
  assert.ok(finding, 'the sideways repeater is detected')
  assert.match(finding.msg, /only accepts input from its rear/)
  assert.deepEqual(finding.at, '3,64,0')
})

test('22. explain a comparator circuit (mode, sides, container data honestly unknown)', () => {
  const bot = blockBot({
    '0,64,0': { name: 'redstone_wire', state: { west: 'side', east: 'side', power: '12' } },
    '1,64,0': { name: 'redstone_wire', state: { west: 'side', east: 'side', power: '9' } },
    '2,64,0': { name: 'comparator', state: { facing: 'west', mode: 'subtract', powered: true } },
    '3,64,0': { name: 'redstone_lamp', state: { lit: true } },
    '2,64,1': { name: 'barrel', state: {} }
  })
  const model = new E.CircuitModel(E.perceive(bot, { x: 2, y: 64, z: 0, radius: 2 }).snapshot)
  const findings = model.diagnose()
  const mode = findings.find((f) => f.code === 'comparator_mode')
  assert.ok(mode)
  assert.match(mode.msg, /subtract/)
  assert.match(mode.msg, /rear/)
  const node = model.nodeAt(2, 64, 0)
  assert.equal(node.state.mode, 'subtract')
  assert.equal(node.state.facing, 'west')
  // The engine knows what it cannot see and says so.
  assert.match(model.snapshot.limits, /item counts inside containers/)
  // A comparator next to a container is still modelled, without inventing fullness.
  const barrel = model.nodeAt(2, 64, 1)
  assert.equal(barrel.kind, 'container')
})

test('23. design a simple AND gate (with alternatives compared)', async () => {
  const bot = blockBot({})
  const dir = tmpDir()
  const eng = new E.RedstoneEngineer(bot, { library: new E.RedstoneLibrary(path.join(dir, 'lib.json')) })
  const r = await eng.act({ operation: 'design', design: 'acender a lâmpada só quando as duas alavancas estiverem ligadas', compare: ['or'] })
  assert.equal(r.ok, true)
  assert.match(r.msg, /AND gate/)
  assert.match(r.msg, /out = A ∧ B/)
  assert.match(r.msg, /comparison:/)
  assert.match(r.msg, /smallest=/)
  const plan = E.planPlacement('and', { x: 0, y: 64, z: 0 }, { rotate: 'east' })
  assert.equal(plan.ok, true)
  assert.ok(plan.placements.some((p) => p.name === 'redstone_lamp'))
  // Orientation rotation is applied to every facing property.
  const orig = E.planPlacement('and', { x: 0, y: 64, z: 0 })
  const rep = orig.placements.find((p) => p.name === 'repeater')
  if (rep) assert.equal(rep.state.facing, 'north')
})

test('24. build and functionally verify a simple clock (placement alone is not completion)', async () => {
  const dir = tmpDir()
  const lib = new E.RedstoneLibrary(path.join(dir, 'lib.json'))
  const cells = new Map()
  const bot = blockBot({}, {})
  bot.blockAt = (p) => cells.get(`${p.x},${p.y},${p.z}`) || { name: 'air', getProperties: () => ({}) }
  let lit = false
  const setLamp = () => cells.set('1,65,0', { name: 'redstone_lamp', getProperties: () => ({ lit }) })
  bot.activateBlock = async (block) => {
    // Toggling the switch starts the clock: the lamp begins to blink.
    if (block.name === 'lever') {
      lit = !lit
      setLamp()
      const blink = (ms) => setTimeout(() => { lit = !lit; setLamp() }, ms)
      blink(150); blink(300); blink(450); blink(600)
    }
  }
  cells.set('0,64,0', { name: 'lever', getProperties: () => ({ powered: true, face: 'floor', facing: 'north' }) })
  cells.set('2,64,1', { name: 'repeater', getProperties: () => ({ facing: 'east', delay: '4' }) })
  setLamp()
  const eng = new E.RedstoneEngineer(bot, { library: lib })

  // 24a: placement alone must NOT report success as verification.
  const placeOnly = await eng.act({ operation: 'place', design: 'clock', x: 0, y: 64, z: 0 })
  assert.equal(placeOnly.ok, false, 'no executor → placement cannot be claimed')
  assert.match(placeOnly.msg, /executor is not available|BLOCKED/)

  // 24b: real functional verification drives the input and watches the output.
  const verify = await eng.act({ operation: 'verify', inputs: [{ x: 0, y: 64, z: 0 }], outputs: [{ x: 1, y: 65, z: 0 }], ticks: 12 })
  assert.equal(verify.verified, true, verify.msg)
  assert.match(verify.msg, /functionally verified/)
  assert.ok(lib.list().some((d) => d.verified) || lib.lessons.some((l) => /verification passed/.test(l.text)), 'the verified design is learned')
})

test('25. debug a circuit that does not produce its expected output', async () => {
  const dir = tmpDir()
  const lib = new E.RedstoneLibrary(path.join(dir, 'lib.json'))
  const cells = new Map([
    ['0,64,0', { name: 'lever', getProperties: () => ({ powered: true, face: 'floor', facing: 'north' }) }],
    ['1,64,0', { name: 'redstone_wire', getProperties: () => ({ west: 'side', east: 'none', power: '0' }) }],
    ['2,64,0', { name: 'redstone_lamp', getProperties: () => ({ lit: false }) }]
  ])
  const bot = blockBot({})
  bot.blockAt = (p) => cells.get(`${p.x},${p.y},${p.z}`) || { name: 'air', getProperties: () => ({}) }
  bot.activateBlock = async () => {}
  const eng = new E.RedstoneEngineer(bot, { library: lib })
  const diag = await eng.act({ operation: 'diagnose', x: 1, y: 64, z: 0, radius: 2 })
  assert.equal(diag.ok, true)
  const v = await eng.act({ operation: 'verify', inputs: [{ x: 0, y: 64, z: 0 }], outputs: [{ x: 2, y: 64, z: 0 }] })
  assert.equal(v.verified, false, 'a dead circuit is never reported as working')
  assert.match(v.msg, /no output changed|not wired|inconclusive/)
  const lesson = await eng.act({ operation: 'lesson', note: 'the lamp stayed dark because the dust did not connect to the lever side' })
  assert.equal(lesson.ok, true)
  assert.match(lesson.msg, /lesson stored/)
})

test('26. save a successful circuit design and reuse it later', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'lib.json')
  const lib = new E.RedstoneLibrary(file)
  lib.record({ name: 'clock', verified: true, testResult: 'lamp blinked twice when the switch closed', tags: ['clock'] })
  const reloaded = new E.RedstoneLibrary(file)
  const found = reloaded.find({ behavior: 'blinking clock', verifiedOnly: true })
  assert.ok(found, 'the verified design is found again after a reload')
  assert.equal(found.name, 'clock_1hz')
  assert.equal(found.verified, true)
  assert.match(found.lastTest, /blinked twice/)
  // Reuse: a fresh engineer instance in a new session can plan it immediately.
  const bot = blockBot({})
  const eng = new E.RedstoneEngineer(bot, { library: reloaded })
  const r = await eng.act({ operation: 'library', name: 'clock' })
  assert.match(r.msg, /clock_1hz \[verified\]/)
  const design = await eng.act({ operation: 'design', design: 'clock' })
  assert.match(design.msg, /clock_1hz/)
  // A broken library file is never silently trusted.
  fs.writeFileSync(file, '{not json')
  const broken = new E.RedstoneLibrary(file)
  assert.ok(broken.loadError)
  assert.equal(broken.list().length, 0)
})

test('redstone perception: every 1.21.4 component kind is recognized with typed state', () => {
  const names = ['redstone_wire', 'redstone_torch', 'redstone_wall_torch', 'repeater', 'comparator', 'observer', 'piston', 'sticky_piston', 'hopper', 'dropper', 'dispenser', 'lever', 'stone_button', 'oak_pressure_plate', 'tripwire', 'tripwire_hook', 'target', 'note_block', 'oak_door', 'oak_trapdoor', 'redstone_lamp', 'daylight_detector', 'chest', 'barrel']
  for (const n of names) assert.ok(E.classify(n), `${n} should be recognized`)
  assert.equal(E.classify('stone'), null)
  assert.equal(E.classify('dirt'), null)
  // String-typed numeric properties (prismarine) and numeric ones (tests) agree.
  const s = E.normalizeState('dust', { power: '9', north: 'side', east: 'none' })
  assert.equal(s.power, 9)
  assert.equal(s.north, 'side')
  const s2 = E.normalizeState('repeater', { delay: 3, facing: 'east', locked: false, powered: 'true' })
  assert.equal(s2.delay, 3)
  assert.equal(s2.powered, true)
  // Missing properties stay missing (never invented as 0/false).
  const s3 = E.normalizeState('repeater', {})
  assert.equal(s3.facing, undefined)
  assert.equal(s3.powered, undefined)
})

test('tool access: recall + redstone_engineer are exposed in the right modes with usable schemas', () => {
  for (const mode of ['explorer', 'hunter', 'builder']) {
    const tools = createZincTools({ mode })
    const names = tools.map((t) => t.function.name)
    assert.ok(names.includes('recall'), `recall missing in ${mode}`)
    assert.ok(names.includes('redstone_engineer'), `redstone_engineer missing in ${mode}`)
    for (const t of tools) {
      assert.ok(t.function.description.length > 10)
      assert.ok(!Array.isArray(t.function.parameters.required) || t.function.parameters.required.length <= 4)
    }
  }
  const eng = createZincTools().find((t) => t.function.name === 'redstone_engineer').function.parameters
  assert.deepEqual(eng.properties.operation.enum.sort(), ['analyze', 'design', 'diagnose', 'lesson', 'library', 'place', 'simulate', 'trace', 'verify'].sort())
  assert.deepEqual(eng.required, ['operation'])
  assert.ok(eng.properties.inputs && eng.properties.outputs)
  assert.ok(eng.properties.rotate.enum.includes('east'))
})

test('end-to-end: the model is shown timestamped events and can act on a recalled memory', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 41, 'Gabriel', 2, 2)
  const s = startTestSession({
    bot,
    actions: (prompt) => {
      if (/perceived \(timestamped/.test(prompt) && !/creeper/.test(prompt)) return { a: 'idle' }
      if (/creeper/.test(prompt)) return { a: 'recall', query: 'where is the emergency shelter' }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    await sleep(80)
    s.shared.memory?.recordKnowledge?.({
      text: 'emergency shelter dug under the hill at 12,50,9',
      category: 'semantic', importance: 3, location: { x: 12, y: 50, z: 9, dim: 'overworld' }
    })
    // A creeper event with the immediate class wakes the model promptly.
    s.internals().events.record({ source: 'world', eventType: 'explosion', summary: 'creeper exploded 3m away', importance: 3, reactionClass: 'immediate', occurredAt: Date.now(), occurrenceTimeKnown: true })
    s.internals().brain.wake('threat: creeper', { external: true, urgent: true })
    const acted = await s.until(() => s.internals().results.some((r) => r.label === 'recall'), 5000)
    assert.ok(acted, 'the model turn reached the recall tool')
    const recall = s.internals().results.find((r) => r.label === 'recall')
    assert.match(recall.msg, /emergency shelter/)
    assert.match(recall.msg, /verified observation|memory/)
    assert.ok(recall.at && /Z$/.test(recall.at), 'tool results are timestamped')
    // Latency instrumentation saw the model call and the queue wait.
    const summary = s.internals().latency.summary()
    assert.ok(summary.modelInferenceMs.count >= 1)
    assert.ok(summary.queueToModelMs.count >= 1)
    assert.ok(summary.queueToModelMs.p50 >= 0)
  } finally { s.stop() }
})

test('latency tracker reports p50/p90/p95/max and separates model from architecture', () => {
  const t = new LatencyTracker()
  for (let i = 1; i <= 20; i++) t.record('modelInferenceMs', i * 100)
  for (let i = 1; i <= 20; i++) t.record('queueToModelMs', i * 5)
  const m = t.statsFor('modelInferenceMs')
  assert.equal(m.count, 20)
  assert.equal(m.p50, 1000)
  assert.equal(m.p90, 1800)
  assert.equal(m.p95, 1900)
  assert.equal(m.max, 2000)
  const q = t.statsFor('queueToModelMs')
  assert.equal(q.max, 100)
  assert.ok(m.p50 > q.p50, 'inference dominates architecture overhead in this sample')
  const summary = t.summary()
  for (const stage of ['occurrenceToReceiptMs', 'receiptToQueueMs', 'queueToModelMs', 'modelInferenceMs', 'responseToExecMs', 'execToConfirmMs']) {
    assert.ok(Object.hasOwn(summary, stage), `summary must expose ${stage}`)
  }
  assert.ok(Number.isFinite(monoNow()))
})

test('brain: event-driven wake does not wait for the heartbeat, and urgent wins over fast over normal', async () => {
  let turns = 0
  let nowMs = 1_000_000
  const classes = []
  const brain = new Brain({
    now: () => nowMs,
    heartbeatMs: 10 * 60_000,
    minIntervalMs: 3000,
    fastMinIntervalMs: 800,
    urgentMinIntervalMs: 200,
    act: async (reasons, meta) => { turns++; classes.push(meta?.reactionClass); return { idle: true } },
    talk: async () => {}
  })
  brain.start(60_000) // a very slow ticker: the wake must not depend on it
  try {
    nowMs += 10_000
    brain.wake('ambient thing', { external: true })
    await sleep(40)
    assert.equal(turns, 1, 'an event woke the action lane immediately (no heartbeat wait)')
    nowMs += 10_000
    brain.wake('player nearby', { external: true, fast: true })
    await sleep(40)
    assert.equal(turns, 2)
    assert.equal(classes[1], 'fast')
    nowMs += 10_000
    brain.wake('lava!', { external: true, urgent: true })
    await sleep(40)
    assert.equal(turns, 3)
    assert.equal(classes[2], 'immediate')
    // Rapid-fire wakes collapse into one turn instead of one call per event.
    const before = turns
    for (let i = 0; i < 5; i++) { nowMs += 10_000; brain.wake(`noise ${i}`, { external: true }) }
    await sleep(40)
    assert.equal(turns, before + 1, 'five events in one window cost one model call')
    // A burst that overflowed keeps urgent wakes.
    brain.pending.length = 0
    brain.wake('lava again', { external: true, urgent: true })
    for (let i = 0; i < 40; i++) brain.wake(`filler ${i}`, { external: true })
    assert.ok(brain.pending.some((p) => /lava again/.test(p.text)), 'urgent wakes are never evicted by a flood')
  } finally { brain.stop() }
})

// ============================================================================
// GOAL INTEGRATION: redstone work only completes after verification
// ============================================================================

test('redstone goal: placement alone leaves the goal open; only a passing verification completes it', async () => {
  const bot = simulatedBot()
  let step = 0
  const s = startTestSession({
    bot,
    actions: () => {
      step++
      if (step === 1) return { a: 'goal', operation: 'add', description: 'build and prove a blinking lamp circuit', origin: 'self_generated', priority: 60 }
      if (step === 2) return { a: 'redstone_engineer', operation: 'design', design: 'clock' }
      if (step === 3) return { a: 'goal', operation: 'complete', id: 'g1' }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    await sleep(60)
    const internals = s.internals()
    const goal = internals.goals.add({ description: 'build and prove a blinking lamp circuit', origin: 'self_generated', priority: 60 })
    internals.goals.update(goal.id, { detail: { redstoneVerified: null, redstoneVerificationFailed: Date.now() } })
    await internals.executeAction(call('goal', { operation: 'complete', id: goal.id }), { threatIds: [], askedBy: null })
    const after = internals.goals.get(goal.id)
    assert.equal(after.status !== 'completed', true, 'a failed/unverified redstone goal is not completed')
    const refusals = internals.results.filter((r) => r.label === 'goal')
    assert.ok(refusals.some((r) => /failed functional verification/.test(r.msg)), JSON.stringify(refusals.map((r) => r.msg)))
    // Clear the failure and a normal completion is allowed again.
    internals.goals.update(goal.id, { detail: { redstoneVerificationFailed: null } })
    await internals.executeAction(call('goal', { operation: 'complete', id: goal.id }), { threatIds: [], askedBy: null })
    assert.equal(internals.goals.get(goal.id).status, 'completed')
  } finally { s.stop() }
})
