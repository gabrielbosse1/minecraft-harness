'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { coerceAction } = require('../zincai/api_wrapper')
const { MemorySystem } = require('../zincai/memory')
const { loadConfig } = require('../zincai/index')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')

const call = (name, args) => coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })

test('tool schema rejects undeclared action override, missing args, types and enums', () => {
  assert.equal(call('idle', { a: 'attack', player: 'Stranger' })._badArgs, 'idle')
  assert.equal(call('follow', {})._badArgs, 'follow')
  assert.equal(call('take', { item: 'diamond', count: '64' })._badArgs, 'take')
  assert.equal(call('set_mode', { mode: 'cheat' })._badArgs, 'set_mode')
  assert.equal(call('attack', { player: 'Stranger' }).a, 'attack')
})

test('real config loader keeps security and concurrency settings', () => {
  const raw = require('../zincai/config.json')
  const cfg = loadConfig()
  assert.deepEqual(cfg.trust, raw.trust)
  assert.deepEqual(cfg.identity, raw.identity)
  assert.equal(cfg.amd.maxConcurrent, raw.amd.maxConcurrent)
  assert.equal(cfg.amd.chatTimeoutMs, raw.amd.chatTimeoutMs)
  assert.equal(cfg.amd.chatMaxRetries, raw.amd.chatMaxRetries)
})

test('provenance and original facts survive repeated reopen and queries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-mem-'))
  const file = path.join(dir, 'memory.json')
  try {
    let mem = new MemorySystem({ file })
    mem.rememberFact('Gabriel keeps wheat at the cherry house', { about: 'Gabriel' })
    mem.rememberFact('Gabriel keeps wheat at the cherry house', { about: 'Maria' })
    for (let i = 0; i < 4; i++) {
      mem = new MemorySystem({ file })
      assert.equal(mem.longTerm.entries.length, 2)
      assert.match(mem.recallBlock('cherry house'), /model summary of player statement: Gabriel/)
      assert.equal(mem.factsAbout('Gabriel')[0], 'Gabriel keeps wheat at the cherry house')
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('both prompts contain configured identity; seen-player memories are bounded and uncertain', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 10, 'Gabriel', 3, 0)
  const s = startTestSession({ bot, cfg: (c) => { c.identity = { creator: { name: 'Gabriel', uuid: 'example-uuid' } } } })
  try {
    s.shared.memory.rememberFact('Gabriel likes building houses', { about: 'Gabriel' })
    s.spawn()
    const act = s.internals().buildActionPrompt(['look']).text
    const chat = s.internals().buildChatPrompt('Gabriel', [{ text: 'oi' }])
    for (const prompt of [act, chat]) {
      assert.match(prompt, /Creator\/operator configured: Gabriel, UUID example-uuid/)
      assert.match(prompt, /not independently authenticated/)
      assert.match(prompt, /Memory index:/)
    }
    assert.match(act, /visible player memories \(name-based, unverified\): Gabriel: Gabriel likes building houses/)
  } finally { s.stop() }
})

test('a model action arriving after death cannot start an old task', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  let resolve
  let entered = false
  s.shared.amd.chatWithTools = () => { entered = true; return new Promise((r) => { resolve = r }) }
  try {
    s.spawn()
    assert.ok(await s.until(() => entered))
    bot.emit('death')
    resolve({ action: { a: 'go_to', x: 50, z: 0 }, usage: null })
    await sleep(100)
    assert.equal(s.internals().agenda.main, null)
    assert.equal(bot.log.goals.some((g) => g && g !== 'null'), false)
  } finally { s.stop() }
})

test('a reply from a disposed connection does not speak or enqueue a task', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 10, 'Gabriel', 3, 0)
  const s = startTestSession({ bot })
  let resolve
  let entered = false
  s.shared.amd.chatReply = () => { entered = true; return new Promise((r) => { resolve = r }) }
  try {
    s.spawn(); s.say('<Gabriel> zinc vem aqui')
    assert.ok(await s.until(() => entered))
    s.session.dispose()
    resolve({ reply: { text: 'blz já vou', task: 'go to Gabriel' }, usage: null })
    await sleep(100)
    assert.equal(bot.log.chat.length, 0)
    assert.equal(s.internals().agenda.asked.length, 0)
  } finally { s.stop() }
})

test('private message to a missing recipient never leaks to public chat', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await s.internals().executeAction({ a: 'say', text: 'oi meu amigo', to: 'OfflinePlayer' }, { threatIds: [], askedBy: null })
    await sleep(50)
    assert.deepEqual(bot.log.chat, [])
  } finally { s.stop() }
})

test('higher-priority hand use never overlaps or gets overwritten by a prior restore', async () => {
  const { ControlArbiter, PRIORITY } = require('../zincai/control')
  const bot = simulatedBot({ items: [['iron_sword'], ['bread'], ['golden_apple']], held: 'iron_sword' })
  const arbiter = new ControlArbiter(bot)
  let release
  try {
    const first = arbiter.useHand('task', { name: 'bread' }, () => new Promise((r) => { release = r }))
    await sleep(0)
    const urgent = await arbiter.useHand('survival', { name: 'golden_apple' }, async () => {}, { priority: PRIORITY.survival })
    assert.equal(urgent.why, 'hand_busy')
    assert.equal(bot.heldItem.name, 'bread')
    release(); await first
    assert.equal(bot.heldItem.name, 'iron_sword')
    assert.equal((await arbiter.useHand('survival', { name: 'golden_apple' }, async () => {}, { priority: PRIORITY.survival })).ok, true)
  } finally { bot.stopSim() }
})

test('close creeper preempts a running follow while model response is pending', async () => {
  const world = require('./helpers/world')
  const bot = simulatedBot()
  addPlayer(bot, 10, 'Gabriel', 30, 0)
  const s = startTestSession({ bot })
  let resolve
  let entered = false
  s.shared.amd.chatWithTools = () => { entered = true; return new Promise((r) => { resolve = r }) }
  try {
    s.spawn()
    await s.internals().executeAction({ a: 'follow', player: 'Gabriel' }, { threatIds: [], askedBy: null })
    assert.equal(s.internals().arbiter.owner(), 'task')
    assert.ok(await s.until(() => entered))
    world.addMob(bot, 30, 'creeper', -3.5, 0.5)
    assert.ok(await s.until(() => s.internals().system1.fleeing, 3000))
    assert.equal(s.internals().arbiter.owner(), 'survival')
    assert.equal(entered, true, 'no model response needed to flee')
    resolve({ action: { a: 'go_to', x: 100, z: 0 }, usage: null })
    await sleep(100)
    assert.match(s.internals().agenda.main?.label || '', /follow Gabriel/, 'stale decision did not replace the task')
  } finally { s.stop() }
})

test('ZincAI mob targeting cannot attack a player named like a mob, including chain selection', async () => {
  const { AdvancedCombat } = require('../src/combat')
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const player = addPlayer(bot, 10, 'zombie', 2, 0)
  const combat = new AdvancedCombat(bot, {})
  try {
    assert.notEqual(combat.resolveTarget('zombie', { explicitPlayersOnly: true }).target, player)
    const result = await combat.engage('zombie', { explicitPlayersOnly: true })
    assert.equal(result.ok, false)
    assert.equal(bot.log.attack.length, 0)
    assert.equal(combat.resolveTarget({ player: 'zombie' }, { explicitPlayersOnly: true }).target, player)
  } finally { combat.stop(); bot.stopSim() }
})

test('ZincAI attack.target name cannot select a same-named player in the executor', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  addPlayer(bot, 10, 'zombie', 2, 0)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await s.internals().executeAction({ a: 'attack', target: 'zombie' }, { threatIds: [], askedBy: null })
    assert.equal(s.internals().combat.isEngaged, false)
    assert.equal(bot.log.attack.length, 0)
    assert.equal(s.internals().results.at(-1).ok, false)
  } finally { s.stop() }
})
