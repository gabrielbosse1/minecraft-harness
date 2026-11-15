'use strict'
/**
 * 13 — Memory architecture: separation of raw history, curated memories and
 * entity dossiers; stable UUID identity; management tools; automatic
 * recognition; bounded retrieval; maintenance that never destroys evidence.
 *
 * The first block is pure store-level testing (no bot needed, like suite 12).
 * The second block runs against a REAL flying-squid server with a real second
 * player, so player recognition is exercised through the actual chat lane and
 * the actual `memory` tool switch.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MemorySystem, HistoryLog, ProfileStore } = require('../zincai/memory')
const { startSimulation } = require('./helpers/sim-harness')
const { waitFor } = require('./helpers/mc-server')

const UUID_A = '069a79f4-44e9-4726-a6b4-7a5b2f5d3a11'
const UUID_B = '8d4a2b1c-9e6f-4a3d-8b2c-1f0e9d8c7b6a'

function tmpMemory (opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-mem-arch-'))
  let now = 1_800_000_000_000
  const mem = new MemorySystem({
    file: path.join(dir, 'memories.json'),
    preferencesFile: path.join(dir, 'preferences.json'),
    dataDir: dir,
    now: () => now,
    ...opts
  })
  return { dir, mem, at: () => now, advance: (ms) => { now += ms; return now } }
}

test('13a: a detailed player dossier is created by UUID and survives a rename', () => {
  const { mem, advance } = tmpMemory()
  const profile = mem.profiles.ensure({ uuid: UUID_A, name: 'Faylan25', at: 1_800_000_000_000 })
  assert.equal(profile.kind, 'player')
  assert.equal(profile.identityBasis, 'uuid')
  assert.equal(profile.id, `player:${UUID_A}`)

  // Zinc writes a real dossier, not a one-line memory.
  mem.profiles.appendNote(profile.id, 'description', 'Builds large oak structures and hosts the SMP.', { source: 'observation' })
  mem.profiles.appendNote(profile.id, 'preferences', 'Prefers deepslate and dark oak; dislikes dirt huts.', { source: 'player statement' })
  mem.profiles.appendNote(profile.id, 'facts', 'Claims to have created Zinc on 2026-11-01.', { source: 'player statement' })
  mem.profiles.appendNote(profile.id, 'uncertainties', 'Creator claim is not yet verified by server evidence.', { source: 'self' })
  mem.profiles.update(profile.id, {
    relationship: { stance: 'creator-claim, friendly', trust: 55, confidence: 45, willingness: 'cooperate', assessment: 'Helpful and consistent; the creator claim is plausible but unverified.' }
  }, { reason: 'first considered assessment' })

  advance(86_400_000)
  // Same account, new username: UUID wins.
  const renamed = mem.profiles.ensure({ uuid: UUID_A, name: 'Faylan26', at: 1_800_086_400_000 })
  assert.equal(renamed.id, profile.id, 'a rename must not create a second dossier')
  assert.deepEqual(renamed.names, ['Faylan25', 'Faylan26'])
  assert.equal(renamed.displayName, 'Faylan26')

  const rendered = mem.profiles.render(profile.id)
  assert.match(rendered, /# Player profile: Faylan26/)
  assert.match(rendered, /Minecraft UUID 069a79f4/)
  assert.match(rendered, /Preferences/)
  assert.match(rendered, /deepslate/)
  assert.match(rendered, /Uncertainties/)
  assert.match(rendered, /creator claim is plausible/i)
  assert.match(rendered, /Name-only|identity|UUID/)

  // Two different accounts sharing a username never share a dossier.
  const other = mem.profiles.ensure({ uuid: UUID_B, name: 'Faylan26', at: 1_800_086_500_000 })
  assert.notEqual(other.id, profile.id)
  assert.equal(other.uuid, UUID_B)
})

test('13b: a dossier is updated (not duplicated) after a new interaction, keeping the old assessment as history', () => {
  const { mem, advance } = tmpMemory()
  const p = mem.profiles.ensure({ uuid: UUID_A, name: 'Faylan25' })
  mem.profiles.update(p.id, { relationship: { stance: 'friendly', trust: 50, confidence: 40, assessment: 'Friendly so far.' } })
  const first = mem.profiles.render(p.id)
  advance(3_600_000)
  mem.profiles.appendNote(p.id, 'interactions', 'We finished the riverside bridge together.', { source: 'observation', at: advance(1000) })
  mem.profiles.update(p.id, { relationship: { stance: 'friend', trust: 70, confidence: 60, assessment: 'Reliable collaborator after the bridge project.' } })

  assert.equal(mem.profiles.list({ kind: 'player' }).length, 1, 'updates must not create a second dossier')
  const second = mem.profiles.render(p.id)
  assert.match(second, /riverside bridge/)
  assert.match(second, /Reliable collaborator/)
  assert.match(second, /relationship changed from/, 'the previous assessment must remain auditable in the timeline')
  // The raw evidence of the previous version is still in the document.
  assert.match(first, /Friendly so far/)
  assert.match(second, /Friendly so far/)
})

test('13c: removing an incorrect curated memory never destroys its raw history', () => {
  const { mem, advance } = tmpMemory()
  const claimHistory = mem.appendHistory('chat', 'claim', 'Faylan25 said: the diamond stash is under the spawn oak', { entities: ['Faylan25'], at: advance(1000) })
  const entry = mem.recordKnowledge({
    text: 'Faylan25 said the diamond stash is under the spawn oak',
    category: 'semantic',
    basis: 'reported',
    importance: 2,
    entities: ['Faylan25'],
    evidence: [claimHistory.ref]
  })
  assert.ok(entry)
  assert.equal(entry.basis, 'reported')
  assert.match(mem.formatEntry(entry), /UNVERIFIED CLAIM/)

  const removed = mem.longTerm.remove(entry.id, { reason: 'the chest under the spawn oak was empty' })
  assert.equal(removed.ok, true)
  assert.equal(mem.longTerm.get(entry.id).status, 'deleted')
  const active = mem.longTerm.search({ query: 'diamond stash spawn oak' })
  assert.equal(active.entries.length, 0, 'a deleted curated record must not be returned by normal recall')

  // The evidence is untouched and still readable by reference.
  const raw = mem.readHistory(claimHistory.ref)
  assert.equal(raw.ok, true)
  assert.match(raw.records[0].text, /diamond stash is under the spawn oak/)

  // Restore works, and the record is exactly what it was.
  assert.equal(mem.longTerm.restore(entry.id).ok, true)
  assert.match(mem.longTerm.get(entry.id).text, /diamond stash/)

  // Hard delete still cannot touch raw history.
  assert.equal(mem.longTerm.remove(entry.id, { hard: true }).ok, true)
  assert.equal(mem.longTerm.get(entry.id), null)
  assert.equal(mem.readHistory(claimHistory.ref).ok, true)
})

test('13d: recognition by UUID retrieves the right dossier even after a username change', () => {
  const { mem, advance } = tmpMemory()
  const p = mem.profiles.ensure({ uuid: UUID_A, name: 'Faylan25' })
  mem.profiles.update(p.id, { relationship: { stance: 'friend', trust: 80, confidence: 75, assessment: 'My creator, verified by repeated consistent help.' } })
  mem.profiles.appendNote(p.id, 'facts', 'Gave me my first diamond pickaxe.', { source: 'observation' })
  advance(60_000)

  const byUuid = mem.recognitionBlock(['Faylan25'], { uuidOf: () => UUID_A })
  assert.match(byUuid, /known players/)
  assert.match(byUuid, /uuid 069a79f4/)
  assert.match(byUuid, /friend/)
  assert.match(byUuid, /first diamond pickaxe/)

  // A different account with the same name must NOT inherit that dossier.
  const stranger = mem.recognitionBlock(['Faylan25'], { uuidOf: () => UUID_B })
  assert.doesNotMatch(stranger, /first diamond pickaxe/)
  assert.match(stranger, /first time I have seen Faylan25/)
})

test('13e: automatic context retrieval surfaces a hostile relationship before a decision', () => {
  const { mem, advance } = tmpMemory()
  const p = mem.profiles.ensure({ uuid: UUID_A, name: 'Sombra77' })
  mem.profiles.update(p.id, { relationship: { stance: 'hostile', trust: -60, confidence: 70, willingness: 'avoid', assessment: 'Attacked me repeatedly without provocation; stay alert.' } })
  mem.profiles.appendNote(p.id, 'interactions', 'Attacked me at the iron farm while I was unarmed.', { source: 'observation', at: advance(1000) })
  mem.profiles.appendNote(p.id, 'interactions', 'Attacked me again near spawn and took my wheat.', { source: 'observation', at: advance(1000) })

  const block = mem.contextBlock({
    query: 'should I open the door',
    goal: { id: 'g1', description: 'Build the east wall' },
    near: { x: 0, y: 64, z: 0, dim: 'overworld' },
    players: ['Sombra77'],
    budgetChars: 700
  })
  assert.match(block, /Sombra77/)
  assert.match(block, /hostile/)
  assert.match(block, /Attacked me repeatedly/)
  assert.ok(block.length <= 700, `context block must stay inside its budget (was ${block.length})`)
})

test('13f: observed facts, reported claims and inferences are labelled differently and never silently merged', () => {
  const { mem, advance } = tmpMemory()
  const observed = mem.recordKnowledge({ text: 'Chest at 10,64,20 holds 12 iron ingots', category: 'semantic', basis: 'observed', confidence: 0.95, importance: 3, location: { x: 10, y: 64, z: 20, dim: 'overworld' } })
  const reported = mem.recordKnowledge({ text: 'Steve says the chest at 10,64,20 holds 64 diamonds', category: 'semantic', basis: 'reported', importance: 2, entities: ['Steve'] })
  const inferred = mem.recordKnowledge({ text: 'Probably a second base east of the river', category: 'semantic', basis: 'inferred', importance: 2 })

  const fmt = (e) => mem.formatEntry(mem.longTerm.get(e.id))
  assert.match(fmt(observed), /verified observation/)
  assert.match(fmt(reported), /UNVERIFIED CLAIM by/)
  assert.match(fmt(inferred), /inferred/)
  assert.notEqual(observed.basis, reported.basis)
  assert.ok(observed.confidence > reported.confidence, 'a claim must not outrank an observation')

  // A claim can be contradicted by the world without losing its record.
  const reconciled = mem.longTerm.reconcileObservation({
    subjectKey: 'container:10,64,20',
    text: 'Chest at 10,64,20 holds 12 iron ingots and no diamonds',
    observedItems: ['iron_ingot', 'iron', 'ingot'],
    location: { x: 10, y: 64, z: 20, dim: 'overworld' },
    entities: ['Steve']
  })
  assert.ok(reconciled.entry)
  const contradicted = reconciled.contradicted.map((e) => mem.longTerm.get(e.id))
  assert.ok(contradicted.some((e) => e.basis === 'reported'), 'the unverified claim should be marked contradicted by the observation')
})

test('13g: an old experience is found in raw history without loading every log', () => {
  const { mem, at } = tmpMemory()
  const base = at()
  // A year of noisy logs, one file per day.
  const history = mem.history
  for (let day = 0; day < 200; day++) {
    const ts = base + day * 86_400_000
    for (let i = 0; i < 5; i++) history.append('world', `walked near the oak forest step ${i}`, { at: ts + i * 1000, kind: 'move', importance: 1 })
  }
  const needle = history.append('world', 'found a hidden ravine with an abandoned mineshaft full of gold', { at: base + 120 * 86_400_000, kind: 'discovery', importance: 2 })
  const totalFiles = history.stats().byCategory.world.files
  assert.ok(totalFiles >= 200, `expected many daily files, got ${totalFiles}`)

  const res = history.search({ query: 'ravine mineshaft gold', limit: 3, maxScanFiles: 40 })
  assert.equal(res.hits.length, 1)
  assert.equal(res.hits[0].ref, needle.ref)
  assert.equal(res.hits[0].kind, 'discovery')
  assert.ok(res.scannedFiles <= 40, 'search must be bounded, not scan the whole year')
  assert.ok(res.scannedFiles < totalFiles, 'the keyword sidecars must narrow the scan to the few relevant days')
  // A broad query that appears everywhere still respects the file cap and says so.
  const broad = history.search({ query: 'walked oak forest', limit: 3, maxScanFiles: 10 })
  assert.ok(broad.scannedFiles <= 10)
  assert.ok(broad.truncated, 'a capped search over many matching files must admit it did not read them all')
  assert.ok(broad.candidateFiles > broad.scannedFiles)

  const read = history.read(needle.ref)
  assert.equal(read.ok, true)
  assert.match(read.records.find((r) => r.current).text, /abandoned mineshaft/)

  // Entity + category filters work without a query.
  history.append('relationships', 'Faylan25 helped me carry cobblestone', { kind: 'interaction', at: base + 130 * 86_400_000, entities: ['Faylan25'], uuid: UUID_A })
  const byEntity = history.search({ entity: 'Faylan25', limit: 5 })
  assert.ok(byEntity.hits.some((h) => /carry cobblestone/.test(h.text)))
})

test('13h: duplicate curated memories are detected and merged without losing evidence', () => {
  const { mem, advance } = tmpMemory()
  const h = mem.appendHistory('decisions', 'agreement', 'Faylan25 and I agreed the bridge goes north', { at: advance(1000) })
  const a = mem.recordKnowledge({ text: 'Agreed with Faylan25 to build the bridge north of spawn', category: 'continuity', basis: 'observed', importance: 3, evidence: [h.ref] })
  const b = mem.recordKnowledge({ text: 'Agreed with Faylan25 to build a bridge north of spawn', category: 'continuity', basis: 'observed', importance: 3 })
  b.tags.push('bridge')
  mem.longTerm.save()

  const groups = mem.longTerm.duplicates({ threshold: 0.85 })
  assert.equal(groups.length, 1, 'the two near-identical agreements must be offered as one cluster')
  assert.equal(groups[0].ids.length, 2)

  const merged = mem.longTerm.merge({ ids: groups[0].ids, into: a.id, reason: 'same agreement' })
  assert.equal(merged.ok, true)
  assert.deepEqual(merged.archived, [b.id])
  assert.equal(mem.longTerm.get(b.id).status, 'archived', 'the source record is archived, never erased')
  assert.equal(mem.longTerm.get(b.id).supersededBy, a.id)
  assert.deepEqual(merged.entry.evidence, [h.ref], 'evidence survives the merge')
  assert.equal(mem.longTerm.search({ query: 'bridge north spawn' }).entries.length, 1)
})

test('13i: maintenance organises without destroying useful information or evidence', () => {
  const { mem, advance } = tmpMemory()
  const now = advance(1000)
  const historyRef = mem.appendHistory('world', 'discovery', 'The mine under the hill has a lava lake', { at: now })
  const foundational = mem.recordKnowledge({ text: 'My home is the small house at -27,94,-55', category: 'semantic', basis: 'observed', importance: 4, foundational: true, evidence: [historyRef.ref] })
  const lesson = mem.recordKnowledge({ text: 'Lesson: carry water when mining near lava', category: 'procedural', basis: 'observed', importance: 3, evidence: [historyRef.ref] })
  // Old, low-value episodic noise that maintenance may archive.
  const stale = mem.longTerm.add('saw a chicken near the pen', ['event', 'spawn'], 1, { kind: 'world_observation', source: 'world' }, { category: 'episodic', basis: 'observed', ts: now - 90 * 86_400_000 })
  // A duplicate pair.
  mem.recordKnowledge({ text: 'Chest 2 holds 20 oak planks', category: 'semantic', basis: 'observed', importance: 2 })
  mem.recordKnowledge({ text: 'Chest 2 holds 20 oak planks', category: 'semantic', basis: 'observed', importance: 2 })
  // Legacy noise from an older build: ordinary telemetry promoted to curated memory.
  const legacyNoise = mem.longTerm.add('Faylan25 took damage 16m away', ['event', 'entity_hurt'], 2, { kind: 'world_observation', source: 'world' }, { category: 'episodic', basis: 'observed' })

  const report = mem.maintainAll({ now: now + 400 * 86_400_000 })
  assert.ok(report.curated.total >= 4)
  assert.ok(report.curated.archived >= 1, 'expired low-value episodes are archived')
  assert.equal(mem.longTerm.get(stale.id).status, 'archived')
  assert.equal(mem.longTerm.get(foundational.id).status, 'active', 'foundational memories are never evicted')
  assert.deepEqual(mem.longTerm.get(foundational.id).evidence, [historyRef.ref])
  assert.equal(mem.longTerm.get(lesson.id).status, 'active', 'lessons survive maintenance')
  assert.equal(mem.longTerm.get(legacyNoise.id).status, 'archived', 'legacy telemetry rows are archived, not left to drown real memories')
  assert.ok(report.curated.legacyArchived >= 1)
  assert.equal(mem.readHistory(historyRef.ref).ok, true, 'raw history survives maintenance')
  // The maintenance pass leaves a raw record of what it did.
  const log = mem.searchHistory({ category: 'maintenance', query: 'maintenance' })
  assert.ok(log.hits.length >= 1)
})

test('13j: working memory stays small while raw history grows without bound', () => {
  const { mem } = tmpMemory()
  for (let i = 0; i < 500; i++) {
    mem.addEvent({ type: 'damage', text: `hurt by zombie ${i}`, at: Date.now() })
    mem.history.append('world', `zombie ${i} shambled past`, { kind: 'entity_spawn', importance: 1 })
  }
  assert.ok(mem.history.stats().records >= 500)
  assert.ok(mem.working.items.length <= mem.working.max, 'working memory keeps only the newest observations')
  assert.ok(mem.ephemeral.items.length <= mem.ephemeral.max, 'ephemeral scratch memory stays bounded')
  assert.equal(mem.longTerm.entries.length, 0, 'ordinary damage telemetry must never become curated memory')
  // The 10-minute short-term window is time-bounded, not count-bounded.
  mem.shortTerm.windowMs = 0
  mem.shortTerm.prune()
  assert.ok(mem.shortTerm.items.length < 500)
})

test('13k: missing, corrupted, duplicated and partially written files degrade safely', () => {
  const { dir, mem, advance } = tmpMemory()
  const p = mem.profiles.ensure({ uuid: UUID_A, name: 'Faylan25' })
  mem.profiles.appendNote(p.id, 'facts', 'Keeps a base in the savanna', { source: 'observation' })

  // Corrupt dossier on disk: quarantined, never silently accepted.
  const dossierFile = fs.readdirSync(path.join(dir, 'entities')).find((n) => n.startsWith('player-') && n.endsWith('.json'))
  assert.ok(dossierFile)
  fs.writeFileSync(path.join(dir, 'entities', dossierFile), '{ this is not json')
  const reopened = new ProfileStore({ dir: path.join(dir, 'entities') })
  assert.equal(reopened.get('Faylan25'), null)
  assert.equal(reopened.corruptions.length, 1)
  assert.ok(fs.readdirSync(path.join(dir, 'entities')).some((n) => n.includes('.corrupt-')), 'the damaged file must be preserved for inspection')
  // A fresh dossier can still be created and used.
  const again = reopened.ensure({ uuid: UUID_A, name: 'Faylan25', at: advance(1000) })
  assert.ok(again)
  assert.equal(reopened.get('Faylan25').id, again.id)

  // Corrupt curated store: starts empty instead of crashing.
  const memoryFile = path.join(dir, 'memories.json')
  fs.writeFileSync(memoryFile, '[{"id":"a","text":"half writ')
  const recovered = new MemorySystem({ file: memoryFile, dataDir: dir })
  assert.equal(recovered.longTerm.entries.length, 0)
  assert.ok(recovered.longTerm.add('recovered after corrupt store', ['note'], 2))

  // Partially written history line: skipped, neighbours still readable.
  const day = path.join(dir, 'history', 'world', '2026-01-02.jsonl')
  fs.mkdirSync(path.dirname(day), { recursive: true })
  fs.writeFileSync(day, [
    JSON.stringify({ id: 'h1', at: 1_767_000_000_000, iso: '2026-01-02T00:00:00.000Z', cat: 'world', kind: 'note', text: 'complete line one' }),
    '{"id":"h2","text":"truncated line',
    JSON.stringify({ id: 'h3', at: 1_767_000_100_000, iso: '2026-01-02T00:01:40.000Z', cat: 'world', kind: 'note', text: 'complete line two' })
  ].join('\n'))
  const hits = mem.history.search({ query: 'complete line', limit: 10 })
  assert.ok(hits.hits.some((h) => /line one/.test(h.text)))
  assert.ok(hits.hits.some((h) => /line two/.test(h.text)))
  assert.ok(hits.corruptLines >= 1)

  // Duplicate memory ids (a hand-edited or double-written file) resolve deterministically.
  fs.writeFileSync(memoryFile, JSON.stringify([
    { id: 'dup-1', ts: 10, text: 'first copy of a memory', category: 'semantic', basis: 'observed', importance: 2 },
    { id: 'dup-1', ts: 20, text: 'second copy with the same id', category: 'semantic', basis: 'observed', importance: 2 }
  ]))
  const dupStore = new MemorySystem({ file: memoryFile, dataDir: dir })
  const found = dupStore.longTerm.get('dup-1')
  assert.ok(found && /first copy|second copy/.test(found.text))
  assert.equal(dupStore.longTerm.entries.length, 2)
  assert.ok(dupStore.longTerm.remove('dup-1').ok)
  assert.equal(dupStore.longTerm.entries.filter((e) => e.id === 'dup-1' && e.status === 'deleted').length, 1)
})

// ---------------------------------------------------------------------------
// Real-server integration: a real second player, real chat, real tool switch.
// ---------------------------------------------------------------------------
test('13l: real server — a joining player gets a UUID dossier, recognition reaches the prompt, and the memory tools edit it', { timeout: 120_000 }, async () => {
  const sim = await startSimulation()
  try {
    const alice = await sim.mc.connectPlayer('Alice')
    await waitFor(() => sim.bot.players?.Alice?.uuid || sim.bot.players?.Alice?.entity, {
      timeoutMs: 15_000,
      label: 'ZincAI observing Alice join'
    })
    const aliceUuid = sim.bot.players?.Alice?.uuid || null

    // A real chat line: recognition + dossier evidence.
    sim.llm.enqueueChat({ reasoning: 'Alice introduced herself.', reply: { text: 'Oi Alice, bom te ver!', to: 'Alice' } })
    alice.chat('Oi Zinc, eu sou a Alice e construí a torre perto do spawn')
    await waitFor(() => sim.llm.chatRequests().length >= 1, { timeoutMs: 20_000, label: 'chat lane answering Alice' })
    await waitFor(() => {
      const profile = sim.shared.memory.profiles.get('Alice')
      return profile && (profile.interactions > 0 || profile.evidence.length > 0)
    }, { timeoutMs: 15_000, label: 'Alice dossier created from real chat' })

    const profile = sim.shared.memory.profiles.get('Alice')
    assert.ok(profile, 'a dossier must exist for the player that spoke')
    if (aliceUuid) {
      assert.equal(profile.uuid, aliceUuid, 'the dossier is keyed by the real Minecraft UUID')
      assert.equal(profile.identityBasis, 'uuid')
    }

    // The chat prompt the model actually received carries the recognition line.
    const chatReq = sim.llm.chatRequests().at(-1)
    const chatPrompt = String(chatReq?.messages?.find((m) => m.role === 'user')?.content || '')
    assert.match(chatPrompt, /Alice/)
    assert.ok(/known players|first time I have seen Alice/.test(chatPrompt), 'the prompt must show the player dossier/recognition block')

    // The action prompt also includes automatic context.
    const snap = sim.internals.buildActionPrompt(['talk to Alice'], { compactionLevel: 0, markDelivered: false })
    assert.match(snap.text, /Alice/)

    // Exercise the real tool switch: remember (reported), profile, update, history.
    sim.llm.enqueueAction({
      reasoning: 'Record what Alice told me and inspect her dossier.',
      toolCalls: [
        { name: 'memory', arguments: { operation: 'remember', entity: 'Alice', text: 'Alice says she built the tower near spawn', basis: 'reported', category: 'semantic', importance: 2 } },
        { name: 'memory', arguments: { operation: 'profile', entity: 'Alice' } },
        { name: 'memory', arguments: { operation: 'history', query: 'Alice' } }
      ]
    })
    sim.internals.brain.wake('record recent player facts', { external: true, urgent: true })
    await waitFor(() => sim.shared.memory.profiles.get('Alice').sections.facts.length > 0, {
      timeoutMs: 15_000,
      label: 'dossier fact written through the memory tool'
    })

    const updated = sim.shared.memory.profiles.get('Alice')
    assert.ok(updated.sections.facts.some((f) => /\[reported by Alice, unverified\]/.test(f.text)), 'a player claim is stored as unverified in the dossier')
    assert.equal(updated.sections.facts.find((f) => /tower near spawn/.test(f.text)).source, 'player statement')
    const claim = sim.shared.memory.longTerm.entries.find((e) => /tower near spawn/.test(e.text))
    assert.ok(claim, 'the tool created a curated memory')
    assert.equal(claim.basis, 'reported')
    assert.equal(claim.profileId, updated.id)
    assert.ok((claim.evidence || []).length >= 1, 'the curated memory points at its raw-history evidence')

    // The raw history search returns the conversation without dumping the log.
    const raw = sim.shared.memory.searchHistory({ entity: 'Alice', limit: 5 })
    assert.ok(raw.hits.length >= 1, 'the raw history contains the interaction')
    assert.ok(raw.hits.every((h) => h.ref.includes('#')), 'every history hit carries a resolvable reference')

    // Dossier remains a single document after all of that.
    assert.equal(sim.shared.memory.profiles.list({ kind: 'player' }).length, 1)
  } finally {
    await sim.stop()
  }
})

test('13m: every documented memory operation is wired to a handler and nothing is documented twice', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const wrapper = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'api_wrapper.js'), 'utf8')
  const index = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'index.js'), 'utf8')

  const schemaMatch = wrapper.match(/tool\('memory',[\s\S]*?operation: \{ type: 'string', enum: \[([^\]]+)\]/)
  assert.ok(schemaMatch, 'memory tool schema found')
  const documented = schemaMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.ok(documented.length >= 12, `expected a rich operation list, got ${documented.length}`)
  assert.equal(new Set(documented).size, documented.length, 'no duplicated operations in the schema')

  const blockStart = index.indexOf("case 'memory': {")
  assert.ok(blockStart > 0, 'memory tool handler found')
  const block = index.slice(blockStart, blockStart + 20_000)
  const wired = new Set([...block.matchAll(/operation === '([a-z]+)'/g)].map((m) => m[1]))

  for (const op of documented) assert.ok(wired.has(op), `operation "${op}" is documented but has no handler`)
  for (const op of wired) assert.ok(documented.includes(op) || op === 'search', `handler "${op}" is not documented in the schema`)
})

test('13n: retrieval stays fast enough for gameplay even with a full store and history', () => {
  const { mem } = tmpMemory()
  for (let i = 0; i < 400; i++) {
    mem.recordKnowledge({
      text: `lesson ${i}: do not dig straight down without checking for lava at y ${i % 60}`,
      category: 'semantic',
      basis: 'observed',
      importance: 2,
      tags: ['lesson'],
      entities: i % 10 === 0 ? [`Player${i % 8}`] : []
    })
  }
  for (let i = 0; i < 60; i++) mem.history.append('world', `walked past ${i},64,${-i}`, { kind: 'move' })

  let started = Date.now()
  for (let i = 0; i < 100; i++) {
    mem.contextBlock({
      query: `lava digging ${i}`,
      near: { x: i, y: 64, z: -20, dim: 'overworld' },
      players: [`Player${i % 8}`],
      budgetChars: 820,
      topK: 3,
      level: 1
    })
  }
  const retrievalMs = (Date.now() - started) / 100
  assert.ok(retrievalMs < 25, `context retrieval averaged ${retrievalMs.toFixed(2)}ms per prompt (budget 25ms)`)

  started = Date.now()
  for (let i = 0; i < 20; i++) mem.history.search({ query: `lava ${i}`, limit: 5 })
  const searchMs = (Date.now() - started) / 20
  assert.ok(searchMs < 100, `history search averaged ${searchMs.toFixed(2)}ms (budget 100ms)`)

  started = Date.now()
  for (let i = 0; i < 100; i++) mem.history.append('world', `event ${i}`, { kind: 'observation' })
  const appendMs = (Date.now() - started) / 100
  assert.ok(appendMs < 10, `history append averaged ${appendMs.toFixed(2)}ms (budget 10ms)`)
})

test('13o: ordinary conversation stays in raw history; only durable claims become curated memories', () => {
  const { mem } = tmpMemory()
  const chatRef = mem.history.append('chat', 'Faylan25: oi Zinc, tudo bem?', { kind: 'chat', entities: ['Faylan25'] })
  mem.history.append('chat', 'Faylan25: vou minerar ali depois', { kind: 'chat', entities: ['Faylan25'] })
  mem.history.append('chat', 'Faylan25: meu baú fica em 120,64,-300', { kind: 'chat', entities: ['Faylan25'] })

  assert.equal(mem.rememberChat('Faylan25', 'oi Zinc, tudo bem?', { evidence: chatRef.ref }), null)
  assert.equal(mem.rememberChat('Faylan25', 'vou minerar ali depois'), null)
  const kept = mem.rememberChat('Faylan25', 'meu baú fica em 120,64,-300')
  assert.ok(kept, 'a durable coordinate/ownership claim is curated')
  assert.equal(kept.basis, 'reported')
  assert.match(kept.text, /unverified|claimed|said/i)

  // A reported claim with no explicit evidence is anchored to the conversation.
  const anchored = mem.recordKnowledge({ text: 'Faylan25 claims the nether portal is at 40,70,-12', category: 'semantic', basis: 'reported', entities: ['Faylan25'] })
  assert.ok(anchored.evidence.length >= 1, 'reported claim links back to the chat that produced it')
  assert.match(anchored.evidence[0], /^chat\/\d{4}-\d{2}-\d{2}\.jsonl#\d+$/)

  // The same claim from an inference is not presented as verified.
  const guess = mem.recordKnowledge({ text: 'Faylan25 probably built the tower north of spawn', category: 'semantic', basis: 'inferred' })
  assert.match(mem.formatEntry(guess), /inferred/i)
})

test('13p: the prompt block warns about previous failed attempts at the same task', () => {
  const { mem } = tmpMemory()
  mem.history.append('errors', 'gather cobblestone failed: no pickaxe in inventory (3 attempts)', { kind: 'tool_failure', importance: 3 })
  mem.history.append('decisions', 'goal set: build a cobblestone shelter before night', { kind: 'goal', importance: 2 })
  mem.recordKnowledge({ text: 'cobblestone shelter lesson: craft a wooden pickaxe before gathering stone', category: 'procedural', basis: 'observed', importance: 3 })

  const block = mem.contextBlock({ query: 'cobblestone shelter', budgetChars: 900, topK: 3, level: 0 })
  assert.match(block, /past attempts \(raw log\)/, 'raw history is consulted for earlier attempts')
  assert.match(block, /no pickaxe in inventory/, 'the actual failure is surfaced')
  assert.match(block, /craft a wooden pickaxe before gathering stone/, 'the curated lesson is surfaced too')

  // Higher compaction tiers stay lean and skip the raw-log search.
  const tight = mem.contextBlock({ query: 'cobblestone shelter', budgetChars: 240, topK: 1, level: 3 })
  assert.doesNotMatch(tight, /past attempts/)
})
