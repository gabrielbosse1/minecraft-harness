/**
 * Harness unit tests — pure modules, no network, no Minecraft server.
 * Run with: npm test   (node:test, built into Node ≥ 18)
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { SYSTEM_PROMPT, wordCount } = require('../src/systemPrompt')
const { DeltaBuffer, toMemoryPhrase, MEMORY_WORDS, MAX_EVENTS } = require('../src/deltaState')
const { ChatGuard } = require('../src/chatGuard')
const { parseAction } = require('../src/actionParser')
const { parseUsage, buildChatPayload, redactSecrets } = require('../src/amdClient')
const { reasonToText } = require('../src/agent')
const { AdvancedCombat } = require('../src/combat')
const { AntiStuckWatchdog } = require('../src/watchdog')
const { canAfford } = require('../src/recipes')

// ------------------------------------------------------------ system prompt
test('system prompt is static and under 150 words', () => {
  assert.ok(wordCount(SYSTEM_PROMPT) < 150, `prompt is ${wordCount(SYSTEM_PROMPT)} words`)
  // All documented actions appear exactly in the schema the LLM is given.
  for (const action of ['"a":"say"', '"a":"craft"', '"a":"equip"', '"a":"attack"', '"a":"move"', '"a":"elytra"', '"a":"idle"']) {
    assert.ok(SYSTEM_PROMPT.includes(action), `prompt missing ${action}`)
  }
  assert.ok(!SYSTEM_PROMPT.includes('```'), 'prompt must not teach the model fences')
})

// -------------------------------------------------------------- delta buffer
test('delta buffer caps at 5 events and folds the rest into <=10-word memory', () => {
  const buf = new DeltaBuffer()
  buf.push({ type: 'chat', user: 'Steve', msg: 'hello' })
  buf.push({ type: 'hp', v: 18 })
  buf.push({ type: 'hp', v: 16 })
  buf.push({ type: 'inv_delta', d: '+3 oak_log,-1 stick' })
  buf.push({ type: 'craft', i: 'oak_planks', ok: true })
  buf.push({ type: 'combat', msg: 'engaged zombie' }) // 6th → evicts 'chat'
  buf.push({ type: 'hp', v: 5 })                      // evicts 'hp 18'

  assert.equal(buf.pending.length, MAX_EVENTS)
  assert.ok(buf.memory.startsWith('memory: '), 'memory line present')
  assert.ok(wordCount(buf.memory) <= 10, `memory is ${wordCount(buf.memory)} words: ${buf.memory}`)
  assert.ok(buf.memory.includes('chat Steve') || buf.memory.includes('hp change'), `memory keeps salient facts: ${buf.memory}`)
})

test('delta buffer body contains vitals + memory + events, commit() clears', () => {
  const buf = new DeltaBuffer()
  buf.push({ type: 'chat', user: 'Alex', msg: 'gg' })
  const body = buf.buildBody('vitals hp=20 food=20 pos=1,64,2 tod=day')
  const lines = body.split('\n')
  assert.equal(lines[0], 'vitals hp=20 food=20 pos=1,64,2 tod=day')
  assert.ok(lines.some((l) => l.includes('"type":"chat"')))
  buf.commit()
  assert.equal(buf.pending.length, 0)
})

test('events are whitelisted and truncated; garbage types dropped', () => {
  const buf = new DeltaBuffer()
  assert.equal(buf.push({ type: 'inventory_dump', items: 'iron_sword,iron_pickaxe,'.repeat(50) }), false)
  assert.equal(buf.push({ type: 'inv_delta', d: '+1 x'.repeat(40) }), true)
  const body = buf.buildBody('vitals')
  assert.ok(body.includes('inv_delta'))
  assert.ok(body.length < 500, 'body stays tiny')
})

test('self events never wake the inference loop', () => {
  const buf = new DeltaBuffer()
  buf.push({ type: 'self', d: 'idle' }, { trigger: false })
  assert.equal(buf.triggerCount(), 0)
  buf.push({ type: 'chat', user: 'a', msg: 'b' })
  assert.equal(buf.triggerCount(), 1)
})

test('memory phrase mapping is short and deterministic', () => {
  assert.equal(toMemoryPhrase({ type: 'death' }), 'died')
  assert.equal(toMemoryPhrase({ type: 'combat', msg: 'engaged creeper' }), 'fighting creeper')
  assert.equal(toMemoryPhrase({ type: 'combat', msg: 'disengaged low_hp' }), 'retreating')
})

// ---------------------------------------------------------------- chat guard
test('chat sanitizer enforces lowercase, 6 words, md/emoji/url stripping', () => {
  const bot = { chat () {} }
  const guard = new ChatGuard(bot, { cooldownMs: 3000 })
  assert.equal(guard.sanitize('HELLO THERE STEVE THIS IS WAY TOO MANY WORDS OK'), 'hello there steve this is way')
  assert.equal(guard.sanitize('**bold** _italic_ `code`'), 'bold italic code')
  assert.equal(guard.sanitize('gg 🎉🔥 wp'), 'gg wp')
  assert.equal(guard.sanitize('check https://example.com/x out'), 'check out')
  assert.equal(guard.sanitize('@someone hi there'), 'hi there')
  assert.equal(guard.sanitize('🎉🎉🎉'), null)
  assert.equal(guard.sanitize(''), null)
})

test('chat cooldown blocks rapid-fire messages', () => {
  const sent = []
  const bot = { chat (m) { sent.push(m) } }
  const guard = new ChatGuard(bot, { cooldownMs: 3000 })
  const first = guard.trySay('brb')
  assert.equal(first.ok, true)
  const second = guard.trySay('back')
  assert.equal(second.ok, false)
  assert.equal(second.why, 'cooldown')
  assert.deepEqual(sent, ['brb'])
})

test('unsalvageable chat sends nothing', () => {
  const bot = { chat () { assert.fail('must not send') } }
  const guard = new ChatGuard(bot, { cooldownMs: 0 })
  assert.equal(guard.trySay('$$$%%%').ok, false)
})

// ------------------------------------------------------------- action parser
test('parser accepts exactly the documented schema', () => {
  assert.deepEqual(parseAction('{"a":"say","t":"brb"}'), { ok: true, action: { a: 'say', t: 'brb' } })
  assert.deepEqual(parseAction('{"a":"craft","i":"chest"}'), { ok: true, action: { a: 'craft', i: 'chest' } })
  assert.deepEqual(parseAction('{"a":"equip","s":0}'), { ok: true, action: { a: 'equip', s: 0 } })
  assert.deepEqual(parseAction('{"a":"equip","s":"4"}'), { ok: true, action: { a: 'equip', s: 4 } })
  assert.deepEqual(parseAction('{"a":"attack","n":"Zombie"}'), { ok: true, action: { a: 'attack', n: 'zombie' } })
  assert.deepEqual(parseAction('{"a":"move","x":10,"y":64,"z":-3}'), { ok: true, action: { a: 'move', x: 10, y: 64, z: -3 } })
  assert.deepEqual(parseAction('{"a":"elytra"}'), { ok: true, action: { a: 'elytra' } })
  assert.deepEqual(parseAction('{"a":"idle"}'), { ok: true, action: { a: 'idle' } })
})

test('parser rejects fences, prose-garbage, and out-of-schema output', () => {
  assert.equal(parseAction('```json\n{"a":"idle"}\n```').ok, false)
  assert.equal(parseAction('I think we should idle now').ok, false)
  assert.equal(parseAction('{"a":"fly"}').ok, false)
  assert.equal(parseAction('{"a":"move","x":99999999,"y":64,"z":0}').ok, false)
  assert.equal(parseAction('{"a":"equip","s":9}').ok, false)
  assert.equal(parseAction('{"a":"craft","i":"Chest With Spaces"}').ok, false)
  assert.equal(parseAction('[{"a":"idle"}]').ok, false)
  assert.equal(parseAction('{"a":"say"}').ok, false)
})

// ---------------------------------------------------------------- amd client
test('parseUsage normalizes DeepSeek and OpenAI cache shapes', () => {
  const ds = parseUsage({ prompt_tokens: 100, completion_tokens: 12, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 })
  assert.equal(ds.cachedTokens, 90)
  assert.equal(ds.hitRate, 0.9)

  const oa = parseUsage({ prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 150 } })
  assert.equal(oa.cachedTokens, 150)

  const none = parseUsage(undefined)
  assert.equal(none.hitRate, null)
})

test('buildChatPayload never leaks keys and requests a deterministic action', () => {
  const body = buildChatPayload({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.25, maxTokens: 96 })
  assert.equal(body.stream, false)
  assert.equal(body.temperature, 0.25)
  assert.ok(!JSON.stringify(body).includes('rc-'))
})

test('redactSecrets strips rc- keys and bearer header material', () => {
  assert.equal(redactSecrets('boom rc-abc123XYZ failed', null), 'boom rc-[redacted] failed')
  assert.equal(redactSecrets('Bearer rc-secretvalue send', null), 'Bearer [redacted] send')
})

// ------------------------------------------------------------ kicked reasons
test('reasonToText unwraps buffer/object/json-string kick reasons', () => {
  assert.equal(reasonToText({ text: 'Not whitelisted' }), 'Not whitelisted')
  assert.equal(reasonToText('{"text":"You are not whitelisted"}'), 'You are not whitelisted')
  assert.equal(reasonToText(Buffer.from('Invalid name')), 'Invalid name')
  assert.equal(reasonToText(undefined), 'unknown')
})

test('reasonToText flattens NBT chat compounds (1.20.2+ kick packets)', () => {
  // Exact shape prismarine parses for a 1.21+ kick: { type, value } nodes.
  const nbt = { type: 'compound', value: { text: { type: 'string', value: 'You are not whitelisted on this server!' } } }
  assert.equal(reasonToText(nbt), 'You are not whitelisted on this server!')
})

test('reasonToText flattens nested extra lists and translate/with', () => {
  const nbt = {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: [
          { type: 'compound', value: { text: { type: 'string', value: 'Kicked: ' } } },
          { type: 'compound', value: { text: { type: 'string', value: 'server restarting' } } }
        ]
      }
    }
  }
  assert.equal(reasonToText(nbt), 'Kicked: server restarting')
  assert.equal(reasonToText(JSON.stringify(nbt)), 'Kicked: server restarting')

  const translated = { type: 'compound', value: { translate: { type: 'string', value: 'multiplayer.disconnect.kicked' } } }
  assert.equal(reasonToText(translated), 'multiplayer.disconnect.kicked')
})

test('reasonToText never throws on garbage input', () => {
  assert.equal(reasonToText({ weird: 42 }), '{"weird":42}')
  assert.equal(typeof reasonToText(Symbol.iterator ? 12345 : 'x'), 'string')
})

// --------------------------------------------------------------------- combat
test('combat disengage threshold is 30% and engage needs a target', async () => {
  const events = []
  const bot = { health: 20, food: 20, entities: {}, inventory: { items: () => [] } }
  const combat = new AdvancedCombat(bot, { maxHealth: 20, onEvent: (e) => events.push(e) })
  assert.equal(combat.disengageAt, 6) // 30% of 20
  const res = await combat.engage('zombie')
  assert.equal(res.ok, false)
  assert.equal(res.why, 'no_target')
})

test('combat engage cooldown after low-health disengage', async () => {
  const events = []
  const bot = {
    health: 4, // below the 6 hp disengage line
    food: 20,
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { setGoal () {} },
    clearControlStates () {},
    setControlState () {}
  }
  const combat = new AdvancedCombat(bot, { maxHealth: 20, onEvent: (e) => events.push(e) })
  const dis = combat.disengage('low_hp')
  assert.equal(dis.ok, true)
  assert.ok(events.some((e) => e.msg === 'disengaged low_hp'))
  const res = await combat.engage('zombie')
  assert.equal(res.why, 'disengage_cooldown')
})

// ------------------------------------------------------------------ watchdog
test('watchdog recovers when isMoving but not moving', async () => {
  const position = { x: 10, y: 64, z: 10, distanceTo () { return 0 } }
  const actions = { setGoal: 0, look: 0 }
  const bot = {
    entity: { position, onGround: true, yaw: 0, velocity: { y: 0 } },
    pathfinder: { isMoving: () => true, setGoal () { actions.setGoal += 1 } },
    setControlState () {},
    clearControlStates () {},
    look: async () => { actions.look += 1 }
  }
  let t = 0
  const wd = new AntiStuckWatchdog(bot, {
    now: () => { t += 500; return t },
    goalActiveProvider: () => true,
    goalProvider: () => ({ goal: { fake: true }, dynamic: false }),
    onUnstuck: () => { actions.unstuck = (actions.unstuck || 0) + 1 }
  })
  // 7 samples × 500ms window — displacement stays 0 → recovery fires.
  for (let i = 0; i < 7; i += 1) await wd._sample()
  assert.equal(actions.unstuck, 1)
  assert.ok(actions.setGoal >= 2) // clear + recalc
  assert.equal(actions.look, 1)   // 180° rotation
})

// ------------------------------------------------------------------- recipes
test('canAfford checks ingredient deltas against inventory counts', () => {
  const inventory = new Map([[1, 3]])
  const bot = { inventory: { count: (id) => inventory.get(id) || 0 } }
  const recipe = { delta: [{ id: 1, metadata: null, count: -2 }, { id: 2, metadata: null, count: 1 }], result: { count: 1 } }
  assert.equal(canAfford(bot, recipe, 1), true)
  assert.equal(canAfford(bot, { ...recipe, delta: [{ id: 1, metadata: null, count: -4 }] }, 1), false)
})
