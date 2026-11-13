/**
 * model-freedom.test.js — the harness must not decide for the model.
 *
 * These are the behavioural pins for the "complete model freedom" contract:
 *
 *   1. No modes.     Every turn ships every tool; nothing unlocks by persona,
 *                    and no prompt tells the model to switch into one.
 *   2. No gating.    A chat line is never dropped for not addressing the bot by
 *                    name, for arriving too often, or for being in the wrong
 *                    language. The model reads the stream and judges.
 *   3. IRC chunks.   Chat arrives as a batched window (several speakers, in
 *                    order), not one model call per line, and only when there
 *                    is data.
 *   4. Preemption.   A waiting chunk can break an in-flight thought, and the
 *                    interrupted turn executes nothing it half-decided.
 *   5. Console only. Operator control is unprefixed console commands; nothing
 *                    typed in game chat can command the process.
 *
 * Every one of those was a real behaviour of the harness before this file
 * existed, so each test names the old behaviour it replaces.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Brain } = require('../zincai/brain')
const { createZincTools, ACTION_TOOLS, CHAT_TOOLS } = require('../zincai/api_wrapper')
const filter = require('../zincai/filter')
const { RuntimeConfig } = require('../zincai/runtime_config')
const { helpText, COMMANDS } = require('../zincai/control_commands')
const { simulatedBot, startTestSession, sleep } = require('./helpers/session')

const quiet = { debug () {}, info () {}, warn () {}, error () {} }

// ============================================================================
// 1. No modes
// ============================================================================

test('every turn ships every tool, and the mode option is inert', () => {
  const all = createZincTools().map((t) => t.function.name)
  assert.equal(all.length, ACTION_TOOLS.length, 'the whole surface, not a subset')
  for (const legacy of [{ mode: 'explorer' }, { mode: 'hunter' }, { mode: 'builder' }, {}]) {
    assert.deepEqual(createZincTools(legacy).map((t) => t.function.name), all, `no subset for ${JSON.stringify(legacy)}`)
  }
  // The build tools a mode used to hide are present on every call.
  for (const t of ['build', 'build_shape', 'logic_test', 'circuit_project', 'smelt', 'sleep']) {
    assert.ok(all.includes(t), `${t} is always offered`)
  }
  assert.ok(!all.includes('set_mode'), 'there is no mode to set')
})

test('a session prompt has no mode and no mode-switching instruction', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    assert.ok(await s.until(() => s.prompts.action.length > 0, 4000), 'the model was asked')
    const p = s.prompts.action[0]
    assert.doesNotMatch(p, /mode (explorer|hunter|builder)/i, 'no mode in the state line')
    assert.doesNotMatch(p, /set_mode/, 'no set_mode anywhere in the prompt')
    assert.doesNotMatch(p, /MODES & TOOLS/, 'the modes block is gone')
  } finally { s.stop() }
})

test('the 3D build grid is offered on situation, not on a persona', async () => {
  const bot = simulatedBot({ items: [['oak_planks', 32]] })
  bot.heldItem = { name: 'oak_planks' }
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    assert.ok(await s.until(() => s.prompts.action.length > 0, 4000), 'the model was asked')
    assert.match(s.prompts.action[0], /grid \(legend:/, 'holding blocks is enough to get the grid')
  } finally { s.stop() }
})

// ============================================================================
// 2. No gating: relevance, rate and language are the model's calls
// ============================================================================

test('an unattended chat line still reaches the model', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, chat: () => ({ text: '' }) })
  try {
    s.spawn()
    // Three players online and no name in the line: the old chatAddressesBot
    // heuristic answered `false` for exactly this and the brain never saw it.
    bot.players.Steve = { username: 'Steve', uuid: 'u1', entity: null }
    bot.players.Alex = { username: 'Alex', uuid: 'u2', entity: null }
    bot.players.Ely = { username: 'Ely', uuid: 'u3', entity: null }
    s.say('<Steve> alguém tem madeira pra trocar?')
    assert.ok(await s.until(() => s.prompts.chat.length > 0, 4000), 'the model saw a line that was not addressed to it')
    assert.match(s.prompts.chat[0], /alguém tem madeira pra trocar\?/)
  } finally { s.stop() }
})

test('many lines in one window do not each cost a model call, and none are dropped', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, chat: () => ({ text: '' }) })
  try {
    s.spawn()
    for (let i = 0; i < 8; i++) s.say(`<Steve> linha ${i}`)
    assert.ok(await s.until(() => s.prompts.chat.length > 0, 4000), 'the chunk was delivered')
    await sleep(120)
    const chunk = s.prompts.chat[0]
    for (let i = 0; i < 8; i++) assert.match(chunk, new RegExp(`linha ${i}`), `line ${i} survived the window`)
    assert.match(chunk, /8 lines from Steve/, 'all eight arrived in ONE chunk')
    assert.equal(s.prompts.chat.length, 1, 'one model call for the burst, not eight')
  } finally { s.stop() }
})

test('a player spamming does not get their lines dropped by the harness', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, chat: () => ({ text: '' }) })
  try {
    s.spawn()
    // The old per-player cap was 8 a minute and silently dropped the rest.
    for (let i = 0; i < 20; i++) s.say(`<Steve> spam ${i}`)
    assert.ok(await s.until(() => s.prompts.chat.length > 0, 4000), 'the model was handed the burst')
    const chunk = s.prompts.chat[0]
    assert.match(chunk, /spam 19/, 'the newest line is there — nothing was dropped for volume')
    assert.match(chunk, /20 lines from Steve/)
  } finally { s.stop() }
})

test('language is not policed: another language goes out as said', async () => {
  // The old guard: PT_WORDS/EN_WORDS scored the line, a non-PT line was held
  // back and retried once, then replaced with a canned Portuguese sentence.
  assert.equal(typeof filter.checkPortuguese, 'undefined', 'the language scorer is gone')
  const bot = simulatedBot()
  const reply = { text: 'sure, I can help with that' }
  const s = startTestSession({ bot, chat: () => reply })
  try {
    s.spawn()
    s.say('<Steve> hey zinc, can you help me?')
    assert.ok(await s.until(() => bot.log.chat.length > 0, 4000), 'the English reply was sent')
    assert.deepEqual(bot.log.chat, ['sure, I can help with that'], 'exactly what the model said, unedited')
  } finally { s.stop() }
})

test('the name matcher no longer decides who the model may answer', () => {
  // chatAddressesBot still exists as parsing help, but nothing in the runtime
  // consults it: the runtime path is checked here so a future edit cannot
  // quietly put relevance filtering back in front of the model.
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'index.js'), 'utf8')
  assert.doesNotMatch(runtime, /chatAddressesBot\(/, 'the runtime does not score relevance')
  assert.match(runtime, /brain\.hear\(/, 'every line goes to the brain')
})

// ============================================================================
// 3 + 4. IRC chunks and preemption (Brain, in isolation)
// ============================================================================

test('the batching window collects a burst into ONE chunk after the window', async () => {
  const chunks = []
  const brain = new Brain({
    chatBatchMs: 80,
    chatMinIntervalMs: 0,
    minIntervalMs: 0,
    rpm: 1000,
    heartbeatMs: 0,
    act: async () => ({ idle: true }),
    talk: async (sender, lines) => { chunks.push({ sender, lines }) }
  })
  try {
    brain.start(20)
    brain.hear('Steve', 'oi')
    brain.hear('Alex', 'cadê você')
    brain.hear('Steve', 'volta aqui')
    assert.equal(chunks.length, 0, 'nothing is delivered inside the window')
    await sleep(160)
    assert.equal(chunks.length, 1, 'the whole window is one chunk')
    assert.deepEqual(chunks[0].lines.map((l) => `${l.sender}: ${l.text}`), ['Steve: oi', 'Alex: cadê você', 'Steve: volta aqui'])
    assert.equal(chunks[0].sender, 'Steve', 'the newest speaker is the addressee')
  } finally { brain.stop?.() }
})

test('a quiet stretch with no data never calls the model', async () => {
  let calls = 0
  const brain = new Brain({
    chatBatchMs: 20,
    chatMinIntervalMs: 0,
    minIntervalMs: 0,
    rpm: 1000,
    heartbeatMs: 0,
    act: async () => ({ idle: true }),
    talk: async () => { calls++ }
  })
  try {
    brain.start(20)
    await sleep(120)
    assert.equal(calls, 0, 'no chat, no chat turn — chunks are sent when there is data')
  } finally { brain.stop?.() }
})

test('a waiting chunk breaks an in-flight action thought', async () => {
  let aborted = false
  let actionTurns = 0
  const brain = new Brain({
    chatBatchMs: 10,
    chatMinIntervalMs: 0,
    minIntervalMs: 0,
    rpm: 1000,
    heartbeatMs: 0,
    act: async () => {
      actionTurns++
      if (actionTurns > 1) return { idle: true }
      // Simulate a long thought that only ends when the harness aborts it.
      await new Promise((resolve) => {
        brain.inflightAbort = () => { aborted = true; resolve(); return true }
      })
      return { idle: false }
    },
    talk: async () => {}
  })
  try {
    brain.start(20)
    brain.wake('think about a staircase')
    await sleep(30)
    assert.ok(actionTurns >= 1, 'the action thought started')
    brain.hear('Steve', 'zinc, vem aqui')
    assert.ok(await sleep(120).then(() => aborted), 'the chunk preempted the thought')
  } finally { brain.stop?.() }
})

test('the first line of a chunk interrupts immediately, without waiting for a tick', async () => {
  let aborted = false
  const brain = new Brain({
    chatBatchMs: 5000, // a long window: the abort must not depend on it
    minIntervalMs: 0,
    rpm: 1000,
    heartbeatMs: 0,
    act: async () => {
      await new Promise((resolve) => {
        brain.inflightAbort = () => { aborted = true; resolve(); return true }
      })
      return { idle: false }
    },
    talk: async () => {}
  })
  try {
    brain.start(60_000) // a very slow ticker: no scheduler slot comes to help
    brain.wake('think hard', { external: true })
    await sleep(40)
    brain.hear('Steve', 'espera')
    assert.ok(await sleep(40).then(() => aborted), 'the in-flight thought was cancelled on arrival')
  } finally { brain.stop() }
})

test('an interrupted action turn executes nothing and asks again', async () => {
  const { AmdToolsClient } = require('../zincai/api_wrapper')
  // A client whose action call hangs until aborted — exactly what an in-flight
  // completion looks like from the harness's side.
  let signalSeen = false
  const controller = new AbortController()
  const client = new AmdToolsClient({ apiKey: 'rc-test', baseUrl: 'https://example.invalid/v1', model: 'm', timeoutMs: 30_000 })
  client._complete = ({ signal }) => new Promise((resolve, reject) => {
    if (signal) {
      signalSeen = true
      signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
    } else setTimeout(() => resolve({ message: { tool_calls: [{ function: { name: 'say', arguments: '{"text":"hi"}' } }] }, usage: null }), 5)
  })
  const pending = client.chatWithTools([{ role: 'user', content: 'x' }], createZincTools(), { signal: controller.signal })
  controller.abort()
  const out = await pending
  assert.ok(signalSeen, 'the abort signal reached the request')
  assert.equal(out.action.a, 'idle')
  assert.equal(out.action._interrupted, true, 'the harness can tell "interrupted" from "chose idle"')
  assert.equal(out.usage, null, 'an aborted call is not billed or logged as a turn')
})

// ============================================================================
// 5. Console only, no prefix
// ============================================================================

test('the console surface has pause and shutdown, and says it is console-only', () => {
  const names = COMMANDS.map((c) => c.name)
  for (const n of ['pause', 'stop', 'shutdown', 'status', 'help']) assert.ok(names.includes(n), `missing ${n}`)
  const text = helpText({ allowConsole: true })
  assert.match(text, /console only, no prefix/)
  assert.match(text, /not a command channel/)
  assert.doesNotMatch(text, /!zinc/, 'no prefix is advertised')
  assert.doesNotMatch(text, /operator UUID/, 'no UUID allow-list is advertised')
})

test('the config no longer carries a chat command surface', () => {
  const cfg = new RuntimeConfig({ logger: quiet })
  for (const gone of ['control.prefix', 'control.operators', 'control.operatorNames', 'control.announce', 'limits.maxPublicChatPerMinute']) {
    assert.equal(cfg.set(gone, 'x').ok, false, `${gone} is gone`)
    assert.equal(cfg.get(gone), undefined, `${gone} has no value`)
  }
  assert.equal(cfg.get('control.allowConsole'), true, 'the console is the operator')
})

test('the chat and reply tools invite any language', () => {
  const say = ACTION_TOOLS.find((t) => t.name === 'say')
  const reply = CHAT_TOOLS.find((t) => t.name === 'reply')
  assert.doesNotMatch(say.description + say.parameters.properties.text.description, /PT-BR|Portuguese/)
  assert.doesNotMatch(reply.description + reply.parameters.properties.text.description, /PT-BR|Portuguese/)
  assert.match(reply.description, /proposals/, 'requests are still proposals, not commands')
})

// ============================================================================
// The prompts
// ============================================================================

test('the system prompt teaches cheap reasoning and chained action', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  assert.match(p, /today|I have to/, 'the chain example is there')
  assert.match(p, /Judge relevance \*\*fast/, 'fast relevance judgement is instructed')
  assert.match(p, /Every tool is always available/, 'freedom is stated')
  assert.match(p, /no modes/i, 'and modes are explicitly denied')
  assert.doesNotMatch(p, /Reply ONLY in \*\*informal Brazilian Portuguese/, 'no forced language')
})

test('the chat prompt teaches reading the window, not obedience', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'chat_prompt.txt'), 'utf8')
  assert.match(p, /batched|last few seconds/i, 'the model is told it is reading a window')
  assert.match(p, /Read the room first/, 'relevance is its judgement')
  assert.match(p, /reply in the language/, 'language follows the conversation')
  assert.doesNotMatch(p, /Speak ONLY \*\*informal Brazilian Portuguese/, 'no forced language')
})
