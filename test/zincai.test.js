/** Unit tests for the ZincAI pure modules — no network, no bot. */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { MemorySystem, LongTermMemory, cosine, embed, scoreImportance } = require('../zincai/memory')
const { BlueprintParser, BLUEPRINT_DIR } = require('../zincai/builder')
const { chatTriggersSystem2, parseChatLine, blockEventTriggersSystem2 } = require('../zincai/filter')

// ------------------------------------------------------------- memory ---
test('cosine similarity ranks related text above unrelated', () => {
  const a = embed('built a base at 100 64 200')
  const b = embed('base built at 100 64 200 near the cave')
  const c = embed('the quick brown fox jumps')
  assert.ok(cosine(a, b) > cosine(a, c), `expected ${cosine(a, b)} > ${cosine(a, c)}`)
})

test('long-term memory stores, retrieves top-k and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-mem-'))
  const file = path.join(dir, 'memories.json')
  const ltm = new LongTermMemory(file)
  ltm.add('built a base at 100 64 200', ['build'], 3)
  ltm.add('Steve gave me diamonds at spawn', ['gift'], 3)
  ltm.add('watered the farm', ['chore'], 1)
  const hits = ltm.query('where is my base', 2)
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].text.includes('base'), `expected base memory first, got: ${hits[0].text}`)
  // Persistence round-trip
  const ltm2 = new LongTermMemory(file)
  assert.equal(ltm2.entries.length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('memory addEvent promotes important events to long-term only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-mem2-'))
  const mem = new MemorySystem({ file: path.join(dir, 'm.json'), workingMax: 5, shortTermMinutes: 10 })
  mem.addEvent({ type: 'chat', text: 'lol ok sure' })
  mem.addEvent({ type: 'build_complete', msg: 'build small_house done' })
  assert.equal(mem.working.last(10).length, 2)
  assert.ok(mem.longTerm.entries.some((e) => /small_house/.test(e.text)))
  assert.ok(!mem.longTerm.entries.some((e) => /lol ok/.test(e.text)))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scoreImportance flags gifts/builds, ignores chatter', () => {
  assert.equal(scoreImportance({ type: 'gift', msg: 'Steve gave me diamonds' }), 3)
  assert.equal(scoreImportance({ type: 'chat', msg: 'nice' }), 1)
  assert.equal(scoreImportance({ type: 'move', msg: 'moving' }), 1)
})

// ------------------------------------------------------------ builder ---
test('blueprint files parse bottom-to-top with correct footprint', () => {
  const parser = new BlueprintParser()
  const house = parser.load('small_house')
  assert.ok(house.blockCount > 20, `expected >20 blocks, got ${house.blockCount}`)
  const ys = house.blocks.map((b) => b.dy)
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], 'blocks must be sorted bottom -> top')
  const inv = house.blocks.map((b) => b.name)
  assert.ok(inv.every((n) => /^[a-z0-9_]+$/.test(n)), 'block names must look like real ids')
})

test('checkInventory detects missing materials', () => {
  const parser = new BlueprintParser()
  const house = parser.load('small_house')
  const missing = parser.checkInventory(house.blocks, [])
  assert.equal(missing.ok, false)
  assert.ok(missing.missing.length >= 2)
  const full = parser.checkInventory(house.blocks, house.blocks.map((b) => ({ name: b.name, count: 1 })))
  assert.equal(full.ok, true)
})

test('inline grid parse matches file parse semantics', () => {
  const parser = new BlueprintParser()
  const doc = { grid: [['###', '#.#']], palette: { '#': 'oak_planks' } }
  const parsed = parser.parseInline(doc)
  assert.equal(parsed.blocks.length, 5)
  assert.equal(parsed.blocks[0].dy, 0)
})

// ------------------------------------------------------------- filter ---
test('chat filter: mentions/questions/friends trigger, chatter does not', () => {
  assert.equal(chatTriggersSystem2('hey ZincAI come here', 'Steve', []), true)
  assert.equal(chatTriggersSystem2('what is the time?', 'Steve', []), true)
  assert.equal(chatTriggersSystem2('just a friendly hello there', 'Steve', []), false)
  assert.equal(chatTriggersSystem2('lol nice one', 'BuilderBob', ['BuilderBob']), true)
})

test('chat line parser handles <name> and whisper formats', () => {
  assert.deepEqual(parseChatLine('<Steve> hi zincAI'), { sender: 'Steve', text: 'hi zincAI' })
  assert.deepEqual(parseChatLine('alex whispers to you: where are you?'), { sender: 'alex', text: 'where are you?' })
  assert.equal(parseChatLine('A zombie escapes the darkness'), null)
})

test('block events beyond 20 blocks never trigger System 2', () => {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } } }
  assert.equal(blockEventTriggersSystem2({ position: { x: 30, y: 64, z: 0 }, name: 'chest' }, bot, 20), false)
  assert.equal(blockEventTriggersSystem2({ position: { x: 2, y: 64, z: 0 }, name: 'chest' }, bot, 20), true)
  assert.equal(blockEventTriggersSystem2({ position: { x: 15, y: 64, z: 0 }, name: 'stone' }, bot, 20), false)
})
