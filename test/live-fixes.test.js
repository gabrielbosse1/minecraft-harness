'use strict'
/**
 * What the first live run of the agent loop showed (PufferPanel, 2026-11-14)
 * and the suite had not caught:
 *
 *   - "physical boundary installed — 0 primitives gated" on every real bot
 *   - gather: radius 48 and 64 both answered "none within 32 blocks"
 *   - the chat lane logged "(silent)" for lines said straight to the bot
 *   - craft failures that did not say what was missing
 *   - a keep-alive timeout nobody could attribute (the bot? the server?)
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { simulatedBot, startTestSession, addPlayer, sleep } = require('./helpers/session')
const { installPhysicalGuard } = require('../zincai/boundary')
const { LoopWatchdog, watchdogEnabled } = require('../zincai/watchdog')
const { coerceReply } = require('../zincai/api_wrapper')
const { resolveRecipe } = require('../src/recipes')

const root = path.join(__dirname, '..')

// ------------------------------------------------------ physical guard ---

test('the physical guard waits for mineflayer to add the primitives before gating them', () => {
  // A real bot right after createBot(): an emitter with no dig/placeBlock yet.
  const bot = new EventEmitter()
  const logs = []
  const guard = installPhysicalGuard(bot, { net: () => ({ ok: false, why: 'paused' }) }, { logger: (level, msg) => logs.push(`${level}: ${msg}`) })
  assert.equal(guard.gated, 0, 'nothing to gate yet')
  assert.equal(logs.length, 0, 'and it does not claim to be installed')

  // mineflayer injects its plugins, then emits inject_allowed to later listeners.
  const calls = []
  bot.dig = async () => { calls.push('dig') }
  bot.placeBlock = async () => { calls.push('placeBlock') }
  bot.setControlState = (k, v) => { calls.push(`key:${k}:${v}`) }
  bot.pathfinder = { setGoal: (g) => { calls.push(`goal:${g}`) }, goto: async () => {}, stop: () => {} }
  bot.emit('inject_allowed')

  assert.ok(guard.gated >= 6, `primitives are gated after injection (${guard.gated})`)
  assert.match(logs.join('\n'), /physical boundary installed — \d+ primitives gated/)
  assert.doesNotMatch(logs.join('\n'), / 0 primitives gated/)
  // The boundary says "paused": nothing physical goes through, releases do.
  bot.dig({})
  bot.setControlState('forward', true)
  bot.pathfinder.setGoal('somewhere')
  assert.deepEqual(calls, [], 'refused while paused')
  bot.setControlState('forward', false)
  bot.pathfinder.setGoal(null)
  assert.deepEqual(calls, ['key:forward:false', 'goal:null'], 'letting go always works')
  assert.equal(guard.refused, 3)
})

test('a real mineflayer bot ends up with its primitives gated', async () => {
  const mineflayer = require('mineflayer')
  const { pathfinder } = require('mineflayer-pathfinder')
  const client = new EventEmitter()
  Object.assign(client, { write () {}, end () {}, version: '1.21.4', registerChannel () {}, unregisterChannel () {}, writeChannel () {} })
  const bot = mineflayer.createBot({ client, username: 'ZincAI', version: '1.21.4' })
  bot.on('error', () => {})
  bot.loadPlugin(pathfinder)
  const logs = []
  const guard = installPhysicalGuard(bot, { net: () => ({ ok: true }) }, { logger: (level, msg) => logs.push(msg) })
  assert.equal(typeof bot.dig, 'undefined', 'mineflayer has not added dig yet — this is why the old install gated nothing')
  await sleep(120)
  assert.equal(typeof bot.dig, 'function')
  assert.ok(guard.gated >= 15, `gated ${guard.gated}`)
  assert.ok(bot.pathfinder, 'the pathfinder is covered too')
  guard.uninstall()
})

test('uninstalling before injection cancels the deferred install', () => {
  const bot = new EventEmitter()
  const guard = installPhysicalGuard(bot, { net: () => ({ ok: false, why: 'paused' }) })
  guard.uninstall()
  let dug = 0
  bot.dig = () => { dug++ }
  bot.emit('inject_allowed')
  bot.dig()
  assert.equal(dug, 1, 'a disposed session does not gate the next one')
})

// -------------------------------------------------------------- gather ---

async function gatherIn (blocks, args) {
  const bot = simulatedBot({ blocks })
  bot.dig = async () => {}
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(50)
    return await s.internals().skills.gather(args)
  } finally { s.stop() }
}

test('gather searches the radius it was asked for, not a silent 32', async () => {
  const r = await gatherIn({ '48,64,0': 'oak_log' }, { item: 'oak_log', count: 1, radius: 60 })
  assert.equal(r.ok, true, r.msg)
  assert.match(r.msg, /dig calls completed: 1\/1/)
})

test('gather out of range says where the resource is', async () => {
  const r = await gatherIn({ '70,64,0': 'oak_log' }, { item: 'oak_log', count: 8 })
  assert.equal(r.ok, false)
  assert.match(r.msg, /no oak_log within 32 blocks/)
  assert.match(r.msg, /oak_log at 70,64,0/, 'the nearest one, with coordinates')
  assert.match(r.msg, /go_to \{x:70, y:64, z:0\}/)
  assert.doesNotMatch(r.msg, /go_to a place first/, 'not the old dead end')
})

test('gather names the other wood when the one asked for is not around', async () => {
  const r = await gatherIn({ '10,64,3': 'birch_log' }, { item: 'oak_log', count: 8, radius: 48 })
  assert.equal(r.ok, false)
  assert.match(r.msg, /no oak_log within 48 blocks/)
  assert.match(r.msg, /birch_log at 10,64,3/)
  assert.match(r.msg, /gather \{item:"birch_log"\}/)
})

test('gather says so when a bigger radius cannot help', async () => {
  const r = await gatherIn({}, { item: 'oak_log', count: 8, radius: 200 })
  assert.equal(r.ok, false)
  assert.match(r.msg, /no oak_log within 64 blocks/, 'the radius actually searched')
  assert.match(r.msg, /none anywhere in the loaded world/)
  assert.match(r.msg, /64 is the most one gather covers/, 'and the cut is said out loud')
})

test('the gather and craft tools describe their limits to the model', () => {
  const { ACTION_TOOLS } = require('../zincai/api_wrapper')
  const gather = ACTION_TOOLS.find((t) => t.name === 'gather')
  assert.match(gather.parameters.properties.radius.description, /1–64/)
  assert.match(ACTION_TOOLS.find((t) => t.name === 'craft').description, /puts down one you carry/)
})

// -------------------------------------------------------- block search ---

test('the fast block search finds what mineflayer finds, without scanning empty sky', () => {
  const { findBlocksFast } = require('../zincai/block_search')
  const registry = require('prismarine-registry')('1.21.4')
  const Chunk = require('prismarine-chunk')(registry)
  const B = registry.blocksByName
  const columns = new Map()
  const colAt = (cx, cz) => {
    const k = `${cx},${cz}`
    if (!columns.has(k)) columns.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
    return columns.get(k)
  }
  const set = (x, y, z, block) => colAt(Math.floor(x / 16), Math.floor(z / 16)).setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), block.defaultState)
  // A stone floor under a 5x5 chunk area, and a few logs at known places.
  for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) colAt(cx, cz)
  for (let x = -40; x < 40; x++) for (let z = -40; z < 40; z++) set(x, 63, z, B.stone)
  const logs = [[5, 64, 3], [-20, 70, 11], [30, 64, -31], [-39, 64, -39], [0, 100, 0]]
  for (const [x, y, z] of logs) set(x, y, z, B.oak_log)
  set(8, 64, 8, B.birch_log)
  let stateReads = 0
  const bot = {
    registry,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    game: { minY: -64, height: 384 },
    world: {
      getColumn: (cx, cz) => {
        const c = columns.get(`${cx},${cz}`)
        if (!c || c.__counted) return c
        const real = c.getBlockStateId.bind(c)
        c.getBlockStateId = (p) => { stateReads++; return real(p) }
        c.__counted = true
        return c
      }
    },
    findBlocks: () => { throw new Error('the fallback must not be used when real columns are there') }
  }
  const dist = (p) => Math.hypot(p.x - 0, p.y - 64, p.z - 0)
  const expected = (r) => logs.map(([x, y, z]) => new Vec3(x, y, z)).filter((p) => dist(p) <= r).sort((a, b) => dist(a) - dist(b)).map(String)

  assert.deepEqual(findBlocksFast(bot, [B.oak_log.id], { maxDistance: 16, count: 8 }).map(String), expected(16))
  assert.deepEqual(findBlocksFast(bot, [B.oak_log.id], { maxDistance: 48, count: 8 }).map(String), expected(48))
  assert.deepEqual(findBlocksFast(bot, [B.oak_log.id], { maxDistance: 128, count: 8 }).map(String), expected(128))
  assert.equal(expected(128).length, 5)
  assert.deepEqual(findBlocksFast(bot, [B.oak_log.id], { maxDistance: 128, count: 2 }).map(String), expected(128).slice(0, 2), 'nearest first')
  assert.deepEqual(findBlocksFast(bot, [B.oak_log.id, B.birch_log.id], { maxDistance: 12, count: 8 }).map(String), ['(5, 64, 3)', '(8, 64, 8)'])

  // A block that is nowhere: the answer must not cost a read of every block.
  stateReads = 0
  assert.deepEqual(findBlocksFast(bot, [B.diamond_ore.id], { maxDistance: 128, count: 1 }), [])
  assert.equal(stateReads, 0, 'palettes alone say there is none — no section is scanned')

  // A bot without real chunk columns (the simulated one) uses findBlocks.
  const sim = { registry, entity: bot.entity, findBlocks: (q) => [`asked ${q.maxDistance}/${q.count}`] }
  assert.deepEqual(findBlocksFast(sim, [B.oak_log.id], { maxDistance: 20, count: 3 }), ['asked 20/3'])
})

test('a plugin handler that throws is contained instead of killing the process', () => {
  const src = fs.readFileSync(path.join(root, 'zincai', 'index.js'), 'utf8')
  assert.match(src, /bot\.loadPlugin\(containedPlugin\(armorManager, 'armor manager'\)\)/)
  // The wrapper itself, exercised the way mineflayer calls a plugin.
  const fnSrc = /function containedPlugin \(plugin, name\) \{[\s\S]*?\n\}\n/.exec(src)[0]
  const warnings = []
  // eslint-disable-next-line no-new-func
  const containedPlugin = new Function('logger', 'TAG', `${fnSrc}; return containedPlugin`)({ warn: (tag, msg) => warnings.push(msg) }, 'zincai')
  const bot = new EventEmitter()
  const plugin = (b) => { b.on('playerCollect', () => { throw new TypeError("Cannot read properties of undefined (reading 'present')") }) }
  containedPlugin(plugin, 'armor manager')(bot, {})
  assert.ok(!Object.prototype.hasOwnProperty.call(bot, 'on'), 'bot.on is the real one again')
  assert.doesNotThrow(() => bot.emit('playerCollect', {}, {}))
  bot.emit('playerCollect', {}, {})
  assert.equal(warnings.length, 1, 'said once, not per event')
  assert.match(warnings[0], /armor manager: a "playerCollect" handler failed/)
  // Listeners added outside the plugin are untouched.
  bot.on('other', () => { throw new Error('mine') })
  assert.throws(() => bot.emit('other'), /mine/)
})

// --------------------------------------------------------------- craft ---

test('a craft that cannot happen says what it takes and what is carried', () => {
  const bot = simulatedBot({ items: [['oak_planks', 1]] })
  try {
    const sticks = resolveRecipe(bot, 'stick')
    assert.equal(sticks.ok, false)
    assert.equal(sticks.why, 'missing_materials')
    assert.match(sticks.needs, /2 planks of one kind, any wood \(have 1 planks in all\)/, sticks.needs)
    const pick = resolveRecipe(bot, 'wooden_pickaxe')
    assert.equal(pick.why, 'need_crafting_table')
    assert.match(pick.needs, /3 planks of one kind, any wood/, 'not "pale_oak_planks" just because that recipe came first')
    assert.match(pick.needs, /2 stick \(have 0\)/, pick.needs)
    assert.match(resolveRecipe(bot, 'furnace').needs, /8 \w*(cobblestone|stone|blackstone|deepslate)\w* \(have 0\)/)
  } finally { bot.stopSim() }
})

test('craft puts down a carried crafting table instead of failing for want of one', async () => {
  const bot = simulatedBot({ items: [['crafting_table', 1], ['oak_planks', 3], ['stick', 2]] })
  // The table "exists" once placeBlock has run.
  let tableAt = null
  const realBlockAt = bot.blockAt
  const tableId = bot.registry.blocksByName.crafting_table.id
  bot.blockAt = (p) => (tableAt && p.x === tableAt.x && p.y === tableAt.y && p.z === tableAt.z
    ? { name: 'crafting_table', type: tableId, position: tableAt, boundingBox: 'block' }
    : realBlockAt(p))
  const realFind = bot.findBlocks
  bot.findBlocks = (q) => {
    const ids = new Set(Array.isArray(q.matching) ? q.matching : [q.matching])
    return tableAt && ids.has(tableId) ? [tableAt] : realFind(q)
  }
  bot.placeBlock = async (ref, face) => { tableAt = new Vec3(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z) }
  const crafted = []
  bot.craft = async (recipe, n, table) => { crafted.push(table?.name || 'hand') }
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(50)
    const r = await s.internals().skills.craft({ item: 'wooden_pickaxe' })
    assert.equal(r.ok, true, r.msg)
    assert.match(r.msg, /crafted wooden_pickaxe/)
    assert.match(r.msg, /put the crafting table down at/)
    assert.deepEqual(crafted, ['crafting_table'])
    assert.ok(tableAt && Math.abs(tableAt.x - bot.entity.position.x) <= 3, 'next to the body')
  } finally { s.stop() }
})

test('craft without a table or the materials tells the model the whole of it', async () => {
  const s = startTestSession({ bot: simulatedBot(), actions: () => null })
  try {
    s.spawn(); await sleep(50)
    const r = await s.internals().skills.craft({ item: 'wooden_pickaxe' })
    assert.equal(r.ok, false)
    assert.match(r.msg, /needs a crafting table/)
    assert.match(r.msg, /craft a crafting_table first/)
    assert.match(r.msg, /one recipe needs .*\(have 0\)/)
  } finally { s.stop() }
})

test('the action log shows a call as the model made it', async () => {
  const lines = []
  const logger = require('../src/logger')
  const realInfo = logger.info
  logger.info = (tag, msg) => { lines.push(String(msg)); return realInfo.call(logger, tag, msg) }
  const s = startTestSession({ bot: simulatedBot(), actions: [{ a: 'craft', item: 'oak_planks' }, { a: 'idle' }] })
  try {
    s.spawn()
    await s.until(() => lines.some((l) => l.startsWith('action: craft')), 3000)
    const line = lines.find((l) => l.startsWith('action: craft'))
    assert.equal(line, 'action: craft {"item":"oak_planks"}')
  } finally { logger.info = realInfo; s.stop() }
})

// ---------------------------------------------------------------- chat ---

test('an answer cut off before the reply call is asked for again with room to finish', async () => {
  const cutOff = { __raw: { message: { content: '<think>Faylan asks whether I am online. I should' }, finish_reason: 'length' } }
  let n = 0
  const bot = simulatedBot()
  addPlayer(bot, 301, 'Faylan25', 3, 0)
  const s = startTestSession({ bot, chat: () => (++n === 1 ? cutOff : { text: 'yes, I am here' }), actions: () => ({ a: 'idle' }) })
  try {
    s.spawn(); await sleep(60)
    s.say('<Faylan25> zinc, are you online?')
    await s.until(() => bot.log.chat.length > 0, 4000)
    assert.deepEqual(bot.log.chat, ['yes, I am here'], 'the line is answered, not dropped')
    const chatCalls = s.prompts.requests.filter((b) => b.tools?.[0]?.function?.name === 'reply')
    assert.equal(chatCalls.length, 2)
    assert.ok(chatCalls[1].max_tokens >= chatCalls[0].max_tokens * 2, `the retry has more room (${chatCalls[0].max_tokens} → ${chatCalls[1].max_tokens})`)
    assert.ok(chatCalls[0].max_tokens >= 400, 'and the first try is no longer 160 tokens')
  } finally { s.stop() }
})

test('silence the model did not choose is not logged as "(silent)"', async () => {
  const lines = []
  const logger = require('../src/logger')
  const realInfo = logger.info
  logger.info = (tag, msg) => { lines.push(String(msg)); return realInfo.call(logger, tag, msg) }
  const cutOff = { __raw: { message: { content: '<think>still thinking' }, finish_reason: 'length' } }
  let n = 0
  const bot = simulatedBot()
  addPlayer(bot, 301, 'Faylan25', 3, 0)
  // Window 1: cut off twice. Window 2: a real, chosen silence.
  const s = startTestSession({ bot, chat: () => (++n <= 2 ? cutOff : { text: '', decision: 'ignore' }), actions: () => ({ a: 'idle' }) })
  try {
    s.spawn(); await sleep(60)
    s.say('<Faylan25> dei tp')
    await s.until(() => lines.some((l) => l.startsWith('chat Faylan25')), 4000)
    assert.match(lines.find((l) => l.startsWith('chat Faylan25')), /no answer: the model's output was cut off/)
    lines.length = 0
    s.say('<Faylan25> gg')
    await s.until(() => lines.some((l) => l.startsWith('chat Faylan25')), 4000)
    assert.match(lines.find((l) => l.startsWith('chat Faylan25')), /\(chose not to answer: ignore\)/)
    assert.equal(bot.log.chat.length, 0)
    assert.ok(!lines.some((l) => /\(silent\)/.test(l)))
  } finally { logger.info = realInfo; s.stop() }
})

test('reasoning is never sent as the reply', () => {
  assert.equal(coerceReply({ content: '<think>they asked if I am online</think>to aqui' }).text, 'to aqui')
  assert.equal(coerceReply({ content: '<think>they asked if I am online and I' }).text, '', 'an unfinished thought is not a chat line')
})

test('with one other player online the chat lane is told the line is for it', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 301, 'Faylan25', 3, 0)
  const s = startTestSession({ bot, chat: () => ({ text: 'ok' }), actions: () => ({ a: 'idle' }) })
  try {
    s.spawn(); await sleep(60)
    s.say('<Faylan25> oq vc tava fazendo')
    await s.until(() => s.prompts.chat.length > 0, 3000)
    assert.match(s.prompts.chat[0], /^room: only you and Faylan25 are online — whatever Faylan25 says in public chat is said to you$/m)
    addPlayer(bot, 302, 'Steve', 6, 0)
    s.say('<Steve> anyone selling iron?')
    await s.until(() => s.prompts.chat.length > 1, 3000)
    assert.match(s.prompts.chat[1], /^room: 2 other players online \(Faylan25, Steve\) — public chat may be for any of you$/m)
  } finally { s.stop() }
})

test('the chat prompt asks for an answer to people who talk to the bot', () => {
  const p = fs.readFileSync(path.join(root, 'zincai', 'chat_prompt.txt'), 'utf8')
  assert.match(p, /someone who talks \*\*to you\*\* gets an answer/)
  assert.match(p, /language of the NEW line/, 'the language of the line being answered, not of an older one')
  assert.match(p, /it is not how you say no/)
  assert.doesNotMatch(p, /you are not obliged to answer anything/)
})

// ------------------------------------------------------------ watchdog ---

test('a stall of the bot\'s thread is reported with the function that caused it', async () => {
  const logs = []
  const wd = new LoopWatchdog({ log: (level, msg) => logs.push({ level, msg }), beatMs: 50, warnMs: 600, stackAfterMs: 250 }).start()
  try {
    await sleep(400) // let the worker come up
    ;(function theCulprit () { const end = Date.now() + 1300; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); return x })()
    await sleep(300)
    const stall = logs.find((l) => /own thread was blocked/.test(l.msg))
    assert.ok(stall, `a stall is logged (${JSON.stringify(logs)})`)
    assert.equal(stall.level, 'warn')
    assert.match(stall.msg, /blocked for 1\.\ds/)
    assert.match(stall.msg, /theCulprit/, 'with the stack of what was running')
    assert.equal(wd.stats.stalls, 1)
    assert.match(wd.describe(), /1 stall of the bot's thread \(worst 1\.\ds\)/)
  } finally { wd.stop() }
})

test('a silent server is reported as the server, not as the bot', async () => {
  const logs = []
  let now = 1_000_000
  const wd = new LoopWatchdog({ log: (level, msg) => logs.push(msg), now: () => now, stack: false, beatMs: 250, silentMs: 10_000 })
  wd._lastBeatAt = now
  const beat = (ms) => { now += ms; wd._tick() }
  wd.linkUp()
  for (let i = 0; i < 20; i++) { beat(250); wd.traffic() } // 5 s of normal traffic
  assert.deepEqual(logs, [])
  for (let i = 0; i < 44; i++) beat(250) // 11 s with the loop fine and nothing arriving
  assert.equal(logs.length, 1)
  assert.match(logs[0], /nothing has arrived from the server for 1\ds while the bot itself is running normally/)
  wd.traffic()
  assert.match(logs[1], /the server is sending again after 1\d\.\ds of silence/)
  // Our own stall is not blamed on the server.
  beat(15_000)
  await sleep(40)
  assert.match(logs.at(-1), /own thread was blocked for 14\.\ds/)
  beat(250)
  assert.ok(!logs.slice(2).some((l) => /nothing has arrived/.test(l)), 'a stall of ours is not a server silence')
  wd.linkDown()
  for (let i = 0; i < 60; i++) beat(250)
  assert.equal(wd.stats.silences, 1, 'no link, no silence to report')
  wd.stop()
})

test('the watchdog can be switched off, and the keep-alive tolerance is configurable', () => {
  assert.equal(watchdogEnabled({}), true)
  assert.equal(watchdogEnabled({ ZINCAI_WATCHDOG: '0' }), false)
  const defaults = JSON.parse(fs.readFileSync(path.join(root, 'zincai', 'config', 'defaults.json'), 'utf8'))
  assert.equal(defaults.reconnect.keepAliveTimeoutMs, 60000)
  const src = fs.readFileSync(path.join(root, 'zincai', 'index.js'), 'utf8')
  assert.match(src, /checkTimeoutInterval: Math\.max\(20_000, Number\(cfg\.reconnect\?\.keepAliveTimeoutMs\) \|\| 60_000\)/)
  assert.doesNotMatch(src, /checkTimeoutInterval: 30_000/)
})
