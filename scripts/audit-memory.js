'use strict'
// Offline store replay, not a Minecraft integration test. No model or fake bot.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { PlaceIndex } = require('../zincai/places')
const { HistoryLog } = require('../zincai/history')
const { MemorySystem } = require('../zincai/memory')
const { WorkJournal } = require('../zincai/journal')
const { ContextBudget } = require('../zincai/context_budget')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-audit-'))
let now = Date.UTC(2026, 0, 1)
const clock = () => now
const options = { dataDir: dir, file: path.join(dir, 'memories.json'), now: clock }
const journalFile = path.join(dir, 'journal.json')
try {
  const m = new MemorySystem(options)
  const j = new WorkJournal({ file: journalFile, now: clock })
  const expected = []
  const steps = []
  const uuids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  for (let i = 0; i < 7200; i++) {
    now += 3000
    const visit = i % 120 === 0
    const n = i / 120
    const location = { x: i + 101, y: 47 + i % 24, z: -i - 200, dim: 'overworld' }
    const msg = visit ? `CACHE${n} ${n + 1} x iron_ingot at ${location.x},${location.y},${location.z}; ${n % 2 ? 'cave' : 'house'} sector ${n}` : `mined cobblestone in sector ${Math.floor(n)}`
    const row = m.history.append('actions', msg, { kind: visit ? 'container_visit' : 'mined', where: location, dedupeKey: null })
    if (visit) {
      const meta = { location, evidence: [row.ref], confidence: 0.86, subjectKey: `cache${n}` }
      const e = m.longTerm.add(msg, [], 3, { kind: 'direct observation' }, meta)
      expected.push({ id: e.id, msg, location, ref: row.ref, key: `CACHE${n}` })
      j.record({ tool: 'look_in', args: { where: `CACHE${n}` }, ok: true, msg, goalId: `g${Math.floor(n / 10)}`, pos: location, evidence: row.ref })
      steps.push(msg)
      const who = n % uuids.length
      m.observePlayer(`${n < 30 ? 'Miner' : 'Builder'}${who}`, { uuid: uuids[who], at: now, interaction: true })
      m.history.append('chat', `Agreement${n} with mining team`, { uuid: uuids[who], kind: 'chat' })
      if (n % 10 === 0) {
        j.death({ where: `${location.x},${location.y},${location.z}`, cause: 'fall', goalId: `g${Math.floor(n / 10)}` })
        const fail = `STEPFAIL${n}: known tunnel blocked`
        steps.push(fail)
        j.record({ tool: 'move', args: { x: location.x, y: location.y, z: location.z }, ok: false, msg: fail, goalId: `g${Math.floor(n / 10)}` })
      }
    }
  }
  const old = expected[0]
  m.longTerm.add('CACHE0 now empty', [], 3, { kind: 'direct observation' }, { location: old.location, subjectKey: 'cache0' })
  const dup = { basis: 'inferred', category: 'procedural' }
  m.longTerm.add('Follow river then ascend to avoid the flooded passage', [], 2, { source: 'trial one' }, dup)
  m.longTerm.add('Follow river then ascend to avoid the flooded passage', [], 2, { source: 'trial two' }, dup)
  const report = m.maintainAll()
  j.compact({ keep: 0 })
  m.save()
  const recovered = new MemorySystem(options)
  const replay = new WorkJournal({ file: journalFile, now: clock })
  const journalText = JSON.stringify(replay.digest)
  const continuationText = replay.continuation({ goal: { id: 'g4', description: 'Inspect sector storage' } })
  const timings = []
  let top1 = 0; let coordinates = 0; let evidence = 0; let quantities = 0; let journalExact = 0; let confidence = 0
  for (const e of expected) {
    const t = performance.now()
    const hit = recovered.longTerm.search({ query: e.key, k: 1 }).entries[0]
    timings.push(performance.now() - t)
    if (hit?.id === e.id) {
      top1++
      if (JSON.stringify(hit.location) === JSON.stringify(e.location)) coordinates++
      if (hit.text === e.msg) quantities++
      if (hit.confidence === 0.86) confidence++
    }
    if (recovered.readHistory(e.ref, { context: 0 }).records?.[0]?.text === e.msg) evidence++
    if (journalText.includes(e.msg)) journalExact++
  }
  timings.sort((a, b) => a - b)
  const budget = new ContextBudget()
  const estimate = (content) => budget.estimateTokens([{ role: 'user', content }])
  const inspectionEvidence = Object.values(replay.digest).flatMap(b => b.observations || [])
  const reachableInspectionEvidence = inspectionEvidence.filter(x => recovered.readHistory(x.ref, { context: 0 }).ok).length
  const dedupe = recovered.history.append('world', 'repeat audit', { where: old.location })
  const repeat = recovered.history.append('world', 'repeat audit', { where: old.location })
  recovered.save()
  const latest = new MemorySystem(options)
  const tailProbe = latest.searchHistory({ query: 'CACHE0', category: 'actions' })
  const boundedHistory = new HistoryLog({ dir: path.join(dir, 'history'), maxFileBytes: 8192, now: clock })
  const bounded = boundedHistory.search({ query: 'CACHE0', category: 'actions' })
  const far = latest.longTerm.search({ query: 'CACHE59', near: old.location, k: 1 }).entries[0]
  const wrongEntity = latest.longTerm.search({ query: 'CACHE59', entity: 'NotTheOwner', k: 1 }).entries[0]
  const historyBrowse = latest.searchHistory({ category: 'chat', since: now - 6 * 3600_000 })
  // Simulate the disk state of an interrupted index flush, not a process kill.
  latest.history.append('chat', 'UniqueAfterIndexFlush', { kind: 'chat' })
  const interrupted = new HistoryLog({ dir: path.join(dir, 'history'), now: clock })
  const staleIndexHits = interrupted.search({ category: 'chat', query: 'UniqueAfterIndexFlush' }).hits.length
  const placesFile = path.join(dir, 'places.json')
  const p = old.location
  fs.writeFileSync(placesFile, JSON.stringify({ named: [], blocks: [{ ...p, id: 'chest1', kind: 'chest', block: 'chest', label: 'Old supply', contents: { iron_ingot: 15 } }] }))
  const places = new PlaceIndex({ file: placesFile, now: clock })
  places.onBlockChange({ name: 'chest', position: p }, { name: 'barrel', position: p }, { dim: p.dim })
  const replacement = places.near(p, { dim: p.dim })[0]
  places.onBlockChange({ name: 'barrel', position: p }, { name: 'air', position: p }, { dim: p.dim })
  const removedAfterReload = new PlaceIndex({ file: placesFile, now: clock }).near(p, { dim: p.dim }).length === 0
  const collisionText = 'Identical supply observation at the same local coordinate'
  const first = latest.longTerm.add(collisionText, [], 2, { kind: 'direct observation' }, { location: old.location })
  const second = latest.longTerm.add(collisionText, [], 2, { kind: 'direct observation' }, { location: { ...old.location, dim: 'the_nether' } })
  const damaged = path.join(dir, 'history', 'errors', '2026-01-01.jsonl')
  const beforeDamage = latest.history.append('errors', 'valid UTF-8: mineração', { at: Date.UTC(2026, 0, 1) })
  fs.appendFileSync(damaged, '{"partial":')
  const afterDamage = latest.history.append('errors', 'sentinel after interrupted append', { at: Date.UTC(2026, 0, 1) + 100 })
  assert.ok(afterDamage.ref.endsWith('#3'), 'the damaged physical line must not shift later refs')
  assert.equal(latest.readHistory(beforeDamage.ref, { context: 0 }).records[0].text, 'valid UTF-8: mineração')
  assert.equal(latest.readHistory(afterDamage.ref, { context: 0 }).records[0].text, 'sentinel after interrupted append')
  latest.history.rebuildIndex(damaged)
  assert.equal(latest.history.search({ query: 'sentinel', category: 'errors' }).hits[0].ref, afterDamage.ref)
  assert.equal(latest.longTerm.update(first.id, { text: 'Corrected', confidence: 0.33 }).ok, true)
  assert.equal(latest.longTerm.get(first.id).revisions.at(-1).value.text, collisionText)
  assert.equal(latest.longTerm.archive(first.id).ok, true)
  assert.equal(latest.longTerm.search({ query: 'Corrected' }).entries.length, 0)
  assert.equal(latest.longTerm.search({ query: 'Corrected', status: 'archived', k: 1 }).entries[0].id, first.id)
  assert.equal(latest.longTerm.restore(first.id).ok, true)
  assert.equal(latest.longTerm.search({ query: 'Corrected', minConfidence: 0.5 }).entries.length, 0)
  const house = places.rememberRegion({ name: 'Large house', dim: p.dim, min: { x: 0, y: 60, z: 0 }, max: { x: 30, y: 66, z: 30 } })
  assert.ok(places.contains(house, { x: 27, y: 62, z: 17 }))
  assert.ok(!places.contains(house, { x: 27, y: 70, z: 17 }))
  assert.equal(new PlaceIndex({ file: placesFile }).regions.get(house.id).name, house.name)
  const { LearnedRules } = require('../zincai/learned_rules')
  const rulesFile = path.join(dir, 'learned-rules.json')
  const rules = new LearnedRules({ file: rulesFile, history: latest.history, now: clock })
  const scope = { world: 'audit', dimension: p.dim, goal: 'g1' }
  const ruleInput = { ...scope, text: 'Verify the bridge first' }
  assert.equal(rules.edit({ ...ruleInput, evidence: [dedupe.ref] }).ok, false)
  const trial = latest.history.append('actions', 'go_to: bridge blocked', { kind: 'action_failed', where: { ...p, world: 'audit' }, data: { tool: 'go_to', goalId: 'g1' } })
  assert.equal(rules.edit({ ...ruleInput, evidence: [trial.ref] }).ok, true)
  const reloadedRules = new LearnedRules({ file: rulesFile, history: latest.history, now: clock })
  assert.equal(reloadedRules.applicable(scope).length, 1)
  assert.equal(reloadedRules.applicable({ ...scope, goal: 'g2' }).length, 0)
  assert.equal(reloadedRules.edit({ id: reloadedRules.rows[0].id, retire: true }).ok, true)
  assert.equal(reloadedRules.applicable(scope).length, 0)
  const identities = uuids.filter((uuid, i) => latest.profiles.get(uuid)?.names.includes(`Miner${i}`) && latest.profiles.get(uuid)?.displayName === `Builder${i}`).length
  const eventFile = path.join(dir, 'events-journal.json')
  const evtModule = path.join(__dirname, '../zincai/events.js')
  const child = spawnSync(process.execPath, ['-e', `
    const { EventPipeline } = require(${JSON.stringify(evtModule)})
    const pipe = new EventPipeline({ file: ${JSON.stringify(eventFile)} })
    for (let i = 0; i < 70; i++) pipe.record({ eventType: 'death', summary: 'important ' + i })
    process.kill(process.pid, 'SIGKILL')
  `])
  const { EventPipeline } = require('../zincai/events')
  const recoveredPendingEvents = new EventPipeline({ file: eventFile }).undelivered().length
  const pageRefs = []
  let cursor = null
  do {
    const page = boundedHistory.search({ category: 'chat', since: now - 6 * 3600_000, limit: 7, cursor })
    assert.ok(!page.error && !page.unreadable)
    pageRefs.push(...page.hits.map(h => h.ref))
    cursor = page.nextCursor
  } while (cursor)
  const repeatRecord = latest.readHistory(repeat.ref, { context: 0 }).records?.[0]
  const reportData = { visits: expected.length, simulatedHours: 6, actionRows: 7200,
    top1, coordinates, originalQuantityText: quantities, unchangedConfidence: confidence, identities, evidence, journalExact, reachableInspectionEvidence, historyPagesUnique: new Set(pageRefs).size, recoveredPendingEvents,
    curatedTotal: report.curated.total, curatedActive: report.curated.active, mergedGroups: report.curated.merged.length,
    journalCompactions: replay.compactions, detailedStepEstimate: estimate(steps.join('\n')), journalDigestEstimate: estimate(journalText), renderedGoalContinuationEstimate: estimate(continuationText),
    detailedSameGoalEstimate: estimate([...expected.slice(40, 50).map(e => e.msg), 'STEPFAIL40: known tunnel blocked'].join('\n')),
    curatedSearchP50Ms: timings[30], curatedSearchP95Ms: timings[56], oldTextAccessibleByRef: evidence === 60,
    currentCache0: latest.longTerm.get(old.id).text, repeatHasRef: Boolean(repeat.ref), repeatDurable: repeatRecord?.repeatOf === dedupe.ref && repeatRecord?.repeats === 2,
    radiusFilterLeaksFarHit: far?.id === expected[59].id, entityFilterLeaksNonMatch: wrongEntity?.id === expected[59].id,
    crossDimensionExactTextCollision: first.id === second.id, staleIndexHits, replacementInheritsId: replacement.id === 'chest1', replacementInheritsLabel: replacement.label === 'Old supply', removedAfterReload,
    timeOnlyBrowseHits: historyBrowse.hits.length, boundedTailHits: bounded.hits.length,
    boundedTailReportsTruncation: bounded.truncated,
    oldestFoundBySearch: tailProbe.hits.some(h => h.text === old.msg)
  }
  console.log(JSON.stringify(reportData, null, 2))
  assert.equal(child.signal, 'SIGKILL')
  assert.equal(recoveredPendingEvents, 70)
  assert.equal(top1, 60)
  assert.equal(coordinates, 60)
  assert.equal(quantities, 59)
  assert.equal(evidence, 60)
  assert.equal(identities, 6)
  assert.equal(reachableInspectionEvidence, 48)
  assert.equal(pageRefs.length, 61)
  assert.equal(new Set(pageRefs).size, pageRefs.length)
  assert.ok(reportData.repeatDurable && reportData.removedAfterReload && reportData.boundedTailReportsTruncation)
  assert.equal(reportData.staleIndexHits, 1)
  assert.equal(reportData.boundedTailHits, 1)
  assert.equal(reportData.crossDimensionExactTextCollision, false)
  assert.equal(reportData.radiusFilterLeaksFarHit, false)
  assert.equal(reportData.entityFilterLeaksNonMatch, false)
  assert.equal(reportData.replacementInheritsId, false)
  assert.equal(reportData.replacementInheritsLabel, false)
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
