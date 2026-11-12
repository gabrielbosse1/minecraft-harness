/** Unit tests for the ZincAI pure modules — no network, no bot. */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { MemorySystem, LongTermMemory, cosine, embed, scoreImportance } = require('../zincai/memory')
const { BlueprintParser, BLUEPRINT_DIR } = require('../zincai/builder')
const { chatAddressesBot, botNames, parseChatLine, blockEventTriggersSystem2 } = require('../zincai/filter')

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
test('chat filter: the bot answers to its name, whispers and its own conversation — no friend list', () => {
  const names = botNames('ZincAI', ['zinc'])
  assert.deepEqual(names.sort(), ['zinc', 'zincai'])
  assert.equal(chatAddressesBot('hey ZincAI come here', { names }), 'name')
  assert.equal(chatAddressesBot('zinc vem aqui', { names }), 'name', 'everyone calls it "zinc"')
  assert.equal(chatAddressesBot('ZINC!!', { names }), 'name')
  assert.equal(chatAddressesBot('o zinco é um metal', { names }), false, 'a word that merely contains the name')
  assert.equal(chatAddressesBot('oi', { names, whisper: true }), 'whisper')
  assert.equal(chatAddressesBot('ok valeu', { names, inConversation: true }), 'conversation')
  // A question is only "for the bot" when nobody else could be meant.
  assert.equal(chatAddressesBot('what is the time?', { names, othersOnline: 1 }), 'question')
  assert.equal(chatAddressesBot('what is the time?', { names, othersOnline: 3 }), false)
  assert.equal(chatAddressesBot('just a friendly hello there', { names, othersOnline: 3 }), false)
})

test('chat line parser handles vanilla, whisper and common plugin formats', () => {
  assert.deepEqual(parseChatLine('<Steve> hi zincAI'), { sender: 'Steve', text: 'hi zincAI', whisper: false })
  assert.deepEqual(parseChatLine('alex whispers to you: where are you?'), { sender: 'alex', text: 'where are you?', whisper: true })
  assert.equal(parseChatLine('A zombie escapes the darkness'), null)
  const players = ['Gabriel', 'Pedro']
  assert.deepEqual(parseChatLine('[VIP] Gabriel: oi', { players }), { sender: 'Gabriel', text: 'oi', whisper: false })
  assert.deepEqual(parseChatLine('Gabriel » oi', { players }), { sender: 'Gabriel', text: 'oi', whisper: false })
  assert.deepEqual(parseChatLine('<[Admin] Gabriel> oi', { players }), { sender: 'Gabriel', text: 'oi', whisper: false })
  assert.equal(parseChatLine('[Gabriel -> me] segredo', { players }).whisper, true)
  // Loose formats only count for players who are actually online.
  assert.equal(parseChatLine('Server: restarting in 5', { players }), null)
  assert.equal(parseChatLine('Gabriel was slain by Zombie', { players }), null)
  assert.equal(parseChatLine('Gabriel: oi'), null, 'without the player list the loose formats are off')
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

// ------------------------------------------------------------- api_wrapper ---
const { createZincTools, coerceAction, buildToolsPayload } = require('../zincai/api_wrapper')

test('createZincTools emits OpenAI-format schemas with the full action set', () => {
  const tools = createZincTools()
  const names = tools.map((t) => t.function?.name)
  for (const required of ['say', 'go_to', 'follow', 'stop', 'attack', 'hold', 'look_in', 'take', 'put', 'smelt', 'sleep', 'give', 'eat', 'equip', 'use_block', 'find', 'remember_here', 'craft', 'build', 'build_shape', 'run_script', 'set_mode', 'idle']) {
    assert.ok(names.includes(required), `missing tool ${required}`)
  }
  for (const t of tools) {
    assert.equal(t.type, 'function')
    assert.ok(t.function.description.length > 10, `${t.function.name} needs a description`)
    assert.equal(t.function.parameters.type, 'object')
    assert.ok(!Array.isArray(t.function.parameters.required) || t.function.parameters.required.length <= 4)
  }
  const shape = tools.find((t) => t.function.name === 'build_shape')
  assert.deepEqual(shape.function.parameters.properties.shape.enum, ['cylinder', 'dome', 'arch', 'wall', 'box', 'floor', 'ring'])
  // Tools take names, never slot numbers; players are fought only by name.
  const equip = tools.find((t) => t.function.name === 'equip')
  assert.ok(equip.function.parameters.properties.item && !equip.function.parameters.properties.slot)
  const attack = tools.find((t) => t.function.name === 'attack')
  assert.ok(attack.function.parameters.properties.player, 'PvP needs an explicit player name')
  assert.ok(/ONLY way a fight ever starts/.test(attack.function.description))
})

test('buildToolsPayload enforces a single REQUIRED tool call (prose used to vanish)', () => {
  const tools = createZincTools()
  const payload = buildToolsPayload({ model: 'Qwen3.8-Flash-Next', messages: [{ role: 'user', content: 'hi' }], temperature: 0.25, maxTokens: 256, tools })
  assert.equal(payload.tool_choice, 'required')
  assert.equal(payload.parallel_tool_calls, false)
  assert.equal(payload.stream, false)
  assert.equal(payload.tools.length, tools.length)
  assert.equal(buildToolsPayload({ model: 'm', messages: [], temperature: 0, maxTokens: 1, tools, toolChoice: 'auto' }).tool_choice, 'auto')
})

test('coerceAction maps tool_calls onto the internal action shape', () => {
  const say = coerceAction({ tool_calls: [{ id: '1', type: 'function', function: { name: 'say', arguments: '{"text":"hello there"}' } }] })
  assert.deepEqual(say, { a: 'say', text: 'hello there', t: 'hello there', _via: 'tool' })
  const shape = coerceAction({ tool_calls: [{ id: '2', type: 'function', function: { name: 'build_shape', arguments: '{"shape":"wall","block":"stone","params":{"l":4,"h":2}}' } }] })
  assert.equal(shape.a, 'build_shape')
  assert.equal(shape.shape, 'wall')
  assert.deepEqual(shape.params, { l: 4, h: 2 })
  const craft = coerceAction({ tool_calls: [{ id: '3', type: 'function', function: { name: 'craft', arguments: '{"item":"crafting_table"}' } }] })
  assert.deepEqual(craft, { a: 'craft', item: 'crafting_table', i: 'crafting_table', _via: 'tool' })
  const duel = coerceAction({ tool_calls: [{ id: '4', type: 'function', function: { name: 'attack', arguments: '{"player":"Gabriel"}' } }] })
  assert.equal(duel.player, 'Gabriel')
  assert.equal(duel.n, undefined, 'a player is never passed as a loose type name')
  // Prose without a tool call is kept so the executor can tell the model.
  const prose = coerceAction({ content: 'Sure, I will go there now.' })
  assert.equal(prose.a, 'idle')
  assert.equal(prose._prose, 'Sure, I will go there now.')
})

test('coerceAction falls back to legacy JSON content when tools are ignored', () => {
  const legacy = coerceAction({ content: '{"a":"say","t":"old school"}' })
  assert.equal(legacy.a, 'say')
  assert.equal(legacy.t, 'old school')
  assert.equal(legacy._via, 'json-fallback')
  const fenced = coerceAction({ content: 'sure!\n```json\n{"a":"idle"}\n```' })
  assert.equal(fenced.a, 'idle')
  const garbage = coerceAction({ content: 'definitely not an action' })
  assert.equal(garbage.a, 'idle')
  const badCall = coerceAction({ tool_calls: [{ id: '4', type: 'function', function: { name: 'teleport', arguments: '{}' } }] })
  assert.equal(badCall.a, 'idle')
  const badArgs = coerceAction({ tool_calls: [{ id: '5', type: 'function', function: { name: 'say', arguments: 'not-json' } }] })
  assert.equal(badArgs.a, 'idle')
})

// ------------------------------------------------------------- perception semantics ---
const { classifyEntityName, clusterEntities, detectStructure } = require('../zincai/perception')

test('classifyEntityName tags players, hostiles, mobs and items', () => {
  assert.equal(classifyEntityName('player'), 'player')
  assert.equal(classifyEntityName('Zombie'), 'hostile')
  assert.equal(classifyEntityName('warden'), 'hostile')
  assert.equal(classifyEntityName('cow'), 'mob')
  assert.equal(classifyEntityName('item'), 'item')
})

test('clusterEntities summarizes mob clutter instead of enumerating', () => {
  const ents = []
  for (let i = 0; i < 12; i++) ents.push({ name: 'zombie', dist: 5 + i, position: { x: i, y: 64, z: 0 } })
  for (let i = 0; i < 5; i++) ents.push({ name: 'skeleton', dist: 6 + i, position: { x: i, y: 64, z: 2 } })
  ents.push({ name: 'player', username: 'Steve', dist: 3 })
  const { lines, zones } = clusterEntities(ents)
  assert.ok(lines.some((l) => l.includes('player Steve')))
  assert.ok(lines.some((l) => /clutter: 17 mobs/.test(l)), lines.join('\n'))
  assert.ok(!lines.some((l) => /hostile zombie/.test(l)), 'mobs must be summarized, not enumerated')
  assert.equal(zones.length, 1)
  assert.equal(zones[0].kind, 'mob_cluster')
  assert.equal(zones[0].count, 17)
})

test('clusterEntities stays enumerated when sparse and groups items', () => {
  const sparse = clusterEntities([{ name: 'zombie', dist: 3 }, { name: 'cow', dist: 4 }])
  assert.ok(sparse.lines.join(' ').includes('mobs:'))
  assert.ok(!sparse.lines.join(' ').includes('clutter'))
  const items = clusterEntities(Array.from({ length: 12 }, () => ({ name: 'item', dist: 2 })))
  assert.ok(items.lines.join(' ').includes('items:'))
})

test('detectStructure tags house only with walls + roof/door', () => {
  const walls = Array(8).fill('stone_bricks')
  const house = detectStructure([...walls, 'oak_door', 'oak_stairs'])
  assert.equal(house.kind, 'house')
  const roofOnly = detectStructure([...walls, ...Array(3).fill('cobblestone_stairs')])
  assert.equal(roofOnly.kind, 'house')
  const bare = detectStructure(walls)
  assert.equal(bare, null)
  const ruin = detectStructure(Array(14).fill('deepslate_bricks'))
  assert.equal(ruin.kind, 'incomplete_structure')
})

// ------------------------------------------------------------- builder scaffolds ---
test('removeScaffolds digs only self-placed blocks, top-down', async () => {
  const { BuilderExecutor } = require('../zincai/builder')
  const { Vec3 } = require('vec3')
  const dug = []
  const tower = [new Vec3(5, 62, 5), new Vec3(5, 63, 5), new Vec3(5, 64, 5)]
  const bot = {
    entity: { position: new Vec3(5, 65, 5) },
    inventory: { items: () => [{ name: 'dirt', count: 10 }] },
    blockAt: (p) => tower.some((t) => t.equals(p)) ? { name: 'dirt', position: p } : { name: 'air', position: p },
    dig: async (b) => { dug.push(b.position.y) },
    pathfinder: { setGoal () {} }
  }
  const executor = new BuilderExecutor(bot, { scaffoldBlocks: ['dirt'], logger: () => {} })
  executor.placedScaffolds = tower.map((pos) => ({ pos, name: 'dirt' }))
  executor._trackedKeys = new Set(tower.map((t) => `${t.x},${t.y},${t.z}`))
  const { removed } = await executor.removeScaffolds()
  assert.equal(removed, 3)
  assert.deepEqual(dug, [64, 63, 62], 'must dig top-down')
  assert.equal(executor.placedScaffolds.length, 0)
  assert.equal(executor._trackedKeys.size, 0)
})

test('removeScaffolds leaves non-scaffold replacements alone', async () => {
  const { BuilderExecutor } = require('../zincai/builder')
  const { Vec3 } = require('vec3')
  const dug = []
  const pos = new Vec3(5, 62, 5)
  const bot = {
    entity: { position: new Vec3(5, 63, 5) },
    inventory: { items: () => [{ name: 'dirt', count: 10 }] },
    blockAt: () => ({ name: 'stone', position: pos }), // something replaced our dirt
    dig: async (b) => { dug.push(b.name) },
    pathfinder: { setGoal () {} }
  }
  const executor = new BuilderExecutor(bot, { scaffoldBlocks: ['dirt'], logger: () => {} })
  executor.placedScaffolds = [{ pos, name: 'dirt' }]
  executor._trackedKeys = new Set(['5,62,5'])
  const { removed } = await executor.removeScaffolds()
  assert.equal(removed, 0)
  assert.equal(dug.length, 0)
})
