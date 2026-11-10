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

// ----------------------------------------------------- v2: shape primitives
const { generateShape, normalizeStage } = require('../zincai/builder')

test('wall primitive generates exact l×h footprint cells', () => {
  const wall = generateShape('wall', { l: 20, h: 5 }, 'stone')
  assert.equal(wall.length, 100)
  const ys = new Set(wall.map((b) => b.dy))
  assert.deepEqual([...ys].sort((a, b) => a - b), [0, 1, 2, 3, 4])
  const xs = new Set(wall.map((b) => b.dx))
  assert.equal(xs.size, 20)
})

test('arch primitive springs from the ground and apexes exactly at h', () => {
  for (const [w, h] of [[10, 8], [9, 8], [12, 10], [6, 5]]) {
    const a = generateShape('arch', { w, h }, 'stone')
    const ys = a.map((b) => b.dy)
    assert.equal(Math.max(...ys), h, `apex for w=${w},h=${h}`)
    assert.equal(Math.min(...ys), 0, `base for w=${w},h=${h}`)
    const keySet = new Set(a.map((b) => `${b.dx},${b.dy},${b.dz}`))
    assert.equal(keySet.size, a.length, 'no duplicate cells')
  }
})

test('cylinder, dome, box, floor, ring produce sane block counts', () => {
  assert.ok(generateShape('cylinder', { r: 3, h: 4 }, 'stone').length > 40)
  assert.ok(generateShape('cylinder', { r: 3, h: 4, filled: true }, 'stone').length > 80)
  const dome = generateShape('dome', { r: 5 }, 'stone')
  assert.ok(Math.max(...dome.map((b) => b.dy)) === 5)
  assert.equal(generateShape('floor', { w: 10, d: 10 }, 'dirt').length, 100)
  assert.equal(generateShape('ring', { r: 4 }, 'stone').length > 20, true)
  const box = generateShape('box', { w: 5, h: 4, d: 5 }, 'oak_planks')
  assert.equal(box.length, 5 * 4 * 5 - 3 * 2 * 3) // hollow interior removed
})

test('shape generator rejects unknown shapes and bad block ids', () => {
  assert.throws(() => generateShape('hypercube', {}, 'stone'))
  assert.throws(() => generateShape('wall', {}, 'Not A Block!'))
})

test('normalizeStage only accepts the four hierarchy stages', () => {
  assert.equal(normalizeStage('foundation'), 'foundation')
  assert.equal(normalizeStage('ROOF'), 'roof')
  assert.equal(normalizeStage('detailing'), 'detailing')
  assert.equal(normalizeStage('foundation2'), null)
  assert.equal(normalizeStage(undefined), null)
})

// --------------------------------------------------- v2: memory v2 systems
const { EphemeralMemory, PreferenceTracker } = require('../zincai/memory')

test('ephemeral buffer expires after its window', () => {
  const e = new EphemeralMemory(1000, 5)
  e.push({ type: 'move', text: 'moved north' })
  assert.equal(e.snapshot().length, 1)
  e.items[0].ts = Date.now() - 5000 // age it artificially
  assert.equal(e.snapshot().length, 0)
})

test('preference tracker learns likes and dislikes from casual chat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-prefs-'))
  const tracker = new PreferenceTracker(path.join(dir, 'preferences.json'))
  tracker.observe('I prefer gothic style for castles')
  tracker.observe("don't use dirt for towers")
  tracker.observe('i like gothic style a lot')
  const line = tracker.line()
  assert.match(line, /likes: .*gothic/i)
  assert.match(line, /dislikes: .*dirt/i)
  const persisted = new PreferenceTracker(path.join(dir, 'preferences.json'))
  assert.match(persisted.line(), /gothic/i)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('recall query finds castle memory via grep without repeating details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-recall-'))
  const mem = new MemorySystem({ file: path.join(dir, 'm.json'), workingMax: 5, shortTermMinutes: 10 })
  mem.addEvent({ type: 'build_complete', msg: 'build small_house complete at 100,64,200' }, { promote: true })
  mem.addEvent({ type: 'build_complete', msg: 'gothic castle finished near the lake' }, { promote: true })
  const block = mem.recallBlock('remember when we built the castle?')
  assert.match(block, /castle/i)
  assert.equal(MemorySystem.isRecallQuery('remember when we built the castle?'), true)
  assert.equal(MemorySystem.isRecallQuery('lol ok'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

// -------------------------------------------------- v2: reflex registry v2
const { ReflexRegistry } = require('../zincai/reflex_registry')

test('reflex registry fires matching reflex, respects cooldown, supports escalation', async () => {
  const registry = new ReflexRegistry()
  let eats = 0
  let escalations = 0
  registry.register({ name: 'eat_test', trigger: 'food_low', action: 'jump', cooldownMs: 10_000 })
  const ctx = { bot: null, logger: null, system1: { eat: () => { eats++ } }, escalate: () => escalations++ }
  // jump action with null bot must not throw
  await registry.evaluate({ type: 'food_low', distance: 0 }, ctx)
  // cooldown: second evaluate within window is a no-op but does not throw
  await registry.evaluate({ type: 'food_low', distance: 0 }, ctx)

  const registry2 = new ReflexRegistry()
  registry2.register({ name: 'gift_escalate', trigger: 'player_gave_item', action: 'call_system2', cooldownMs: 0 })
  const ctx2 = { bot: null, logger: null, system1: null, escalate: () => { escalations++; return 'asc' } }
  const out = await registry2.evaluate({ type: 'player_gave_item', item: 'diamond', distance: 0 }, ctx2)
  assert.equal(escalations, 1)
  assert.equal(out[0].outcome, 'asc')
})

test('reflex registry validates specs loudly', () => {
  const registry = new ReflexRegistry()
  assert.throws(() => registry.register({ name: 'bad', trigger: 'never_happens', action: 'jump' }))
  assert.throws(() => registry.register({ name: 'bad2', trigger: 'chat', action: 'explode' }))
  assert.throws(() => registry.register({ name: 'bad3', trigger: 'chat', action: 'run_script' }))
})
