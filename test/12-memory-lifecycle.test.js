'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LifecycleStore } = require('../zincai/lifecycle')
const { MemorySystem, scoreImportance } = require('../zincai/memory')

test('lifecycle records clean shutdown and detects unexpected termination without guessing time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-life-'))
  const file = path.join(dir, 'life.json')
  let now = 1000
  const first = new LifecycleStore({ file, now: () => now++, id: () => 'one' })
  first.shutdown('SIGTERM', { continuity: { goal: 'house' } })
  const second = new LifecycleStore({ file, now: () => now++, id: () => 'two' })
  assert.equal(second.previous.shutdownReason, 'SIGTERM')
  assert.match(second.startupMessage(), /Previous session one/)
  const third = new LifecycleStore({ file, now: () => now++, id: () => 'three' })
  assert.equal(third.previous.outcome, 'unexpected')
  assert.equal(third.previous.shutdownAt, null)
  assert.match(third.startupMessage(), /exact time unknown/)
})

test('ordinary combat telemetry stays temporary; player claims remain reported', () => {
  assert.equal(scoreImportance({ type: 'damage', text: 'hurt by Steve' }), 0)
  assert.equal(scoreImportance({ type: 'chat', text: 'hello' }), 1)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-mem-'))
  const mem = new MemorySystem({ file: path.join(dir, 'memories.json'), preferencesFile: path.join(dir, 'prefs.json') })
  mem.addEvent({ type: 'damage', text: 'hurt by Steve' })
  assert.equal(mem.longTerm.entries.length, 0)
  const claim = mem.rememberFact('Steve says the base is at 10,64,20', { about: 'Steve' })
  assert.ok(claim)
  assert.equal(claim.basis, 'reported')
  assert.equal(claim.provenance.source, 'Steve')
})

test('maintenance archives expired episodes and keeps their records and IDs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-retention-'))
  const file = path.join(dir, 'memories.json')
  const source = [{ id: 'episodic-1', ts: 10, updatedAt: 10, text: 'minor transient observation', category: 'episodic', importance: 1, basis: 'observed' }]
  fs.writeFileSync(file, JSON.stringify(source))
  const mem = new MemorySystem({ file })
  const result = mem.longTerm.maintain({ now: 100, episodicTtlMs: 50 })
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(result.archived, 1)
  assert.equal(persisted[0].id, 'episodic-1')
  assert.equal(persisted[0].status, 'archived')
  assert.equal(mem.longTerm.query('minor transient', 5).length, 0)
})

test('existing memory IDs and source data survive load/save unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-migrate-'))
  const file = path.join(dir, 'memories.json')
  const legacy = [{ id: 'keep-this-id', ts: 12, text: 'Steve repeatedly helped Zinc', tags: ['relationship'], importance: 2, custom: 'preserve me' }]
  fs.writeFileSync(file, JSON.stringify(legacy))
  const mem = new MemorySystem({ file })
  mem.longTerm.save()
  const result = JSON.parse(fs.readFileSync(file, 'utf8'))[0]
  assert.equal(result.id, legacy[0].id)
  assert.equal(result.text, legacy[0].text)
  assert.equal(result.custom, legacy[0].custom)
  assert.equal(result.basis, 'observed')
})
