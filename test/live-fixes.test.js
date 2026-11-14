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
const { EventEmitter, once } = require('node:events')
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

// --------------------------------------------------------------- armor ---

const { ArmorKeeper, armorScore, armorInfo } = require('../zincai/armor')

/** A bot with a real-shaped inventory: slots 5-8 armor, 9-44 carried, 45 off hand. */
function armorBot (carried = [], worn = {}) {
  const bot = new EventEmitter()
  const inv = new EventEmitter()
  inv.slots = new Array(46).fill(null)
  const DEST = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }
  const mk = (name, extra = {}) => ({ name, count: 1, type: name.length, ...extra })
  carried.forEach((it, i) => { inv.slots[9 + i] = typeof it === 'string' ? mk(it) : mk(it.name, it) })
  for (const [dest, name] of Object.entries(worn)) inv.slots[DEST[dest]] = mk(name)
  inv.items = () => inv.slots.slice(9, 45).filter(Boolean)
  bot.inventory = inv
  bot.username = 'ZincAI'
  bot.entity = { id: 1, username: 'ZincAI' }
  bot.health = 20
  bot.currentWindow = null
  bot.getEquipmentDestSlot = (dest) => DEST[dest]
  bot.equips = []
  bot.equip = async (item, dest) => {
    const from = inv.slots.indexOf(item)
    const to = DEST[dest]
    if (from < 0 || to === undefined) throw new Error('bad equip')
    bot.equips.push(`${item.name}@${dest}`)
    const old = inv.slots[to]
    inv.slots[to] = item
    inv.slots[from] = old
    inv.emit('updateSlot', to, old, item)
  }
  bot.unequip = async (dest) => {
    const from = DEST[dest]
    const free = inv.slots.findIndex((x, i) => i >= 9 && i < 45 && !x)
    inv.slots[free] = inv.slots[from]
    inv.slots[from] = null
    inv.emit('updateSlot', from, inv.slots[free], null)
  }
  bot.give = (name, extra) => {
    const free = inv.slots.findIndex((x, i) => i >= 9 && i < 45 && !x)
    inv.slots[free] = mk(name, extra)
    inv.emit('updateSlot', free, null, inv.slots[free])
    return inv.slots[free]
  }
  bot.wearing = () => Object.fromEntries(Object.entries(DEST).map(([d, i]) => [d, inv.slots[i]?.name || null]))
  return bot
}

test('picking up an item whose entity has no data does not crash, and the armor is still put on', async () => {
  // The exact failure of the old plugin: playerCollect for an item entity
  // without metadata — reading the dropped item threw inside the packet handler.
  const bot = armorBot(['dirt', 'iron_chestplate'])
  const logs = []
  const keeper = new ArmorKeeper(bot, { delayMs: 10, log: (level, msg) => logs.push(msg) }).attach()
  const noData = { name: 'item', metadata: [], getDroppedItem () { throw new TypeError("Cannot read properties of undefined (reading 'present')") } }
  assert.doesNotThrow(() => bot.emit('playerCollect', bot.entity, noData))
  await sleep(60)
  assert.equal(bot.wearing().torso, 'iron_chestplate', 'worn from the inventory, not from the entity')
  assert.match(logs.join('\n'), /armor: put on iron_chestplate \(torso\)/)
  // Someone else's pickup is not ours to react to.
  bot.equips.length = 0
  bot.give('diamond_boots')
  keeper.detach()
  bot.emit('playerCollect', { id: 9, username: 'Steve' }, noData)
  await sleep(40)
  assert.deepEqual(bot.equips, [], 'detached: no listeners left behind')
})

test('armor that arrives any way is worn when it protects more — by the game\'s numbers', async () => {
  const bot = armorBot([], { head: 'leather_helmet', torso: 'chainmail_chestplate' })
  const worn = []
  const keeper = new ArmorKeeper(bot, { delayMs: 5, onWorn: (list) => worn.push(...list) }).attach()
  // From a chest, a craft, a gift: only an inventory slot changes.
  bot.give('iron_chestplate') // 6 points beats chainmail's 5 (the old plugin ranked chainmail higher)
  bot.give('golden_helmet') // 2 beats leather's 1
  bot.give('leather_boots')
  bot.give('golden_leggings')
  await sleep(80)
  assert.deepEqual(bot.wearing(), { head: 'golden_helmet', torso: 'iron_chestplate', legs: 'golden_leggings', feet: 'leather_boots', 'off-hand': null })
  assert.deepEqual(worn.find((w) => w.slot === 'torso'), { slot: 'torso', on: 'iron_chestplate', off: 'chainmail_chestplate' })
  // Worse or equal is left in the bag.
  bot.equips.length = 0
  bot.give('leather_chestplate')
  bot.give('iron_chestplate')
  await sleep(60)
  assert.deepEqual(bot.equips, [])
  // Better again: diamond over iron, netherite over diamond (same points, tougher).
  bot.give('diamond_chestplate')
  await sleep(60)
  bot.give('netherite_chestplate')
  await sleep(60)
  assert.equal(bot.wearing().torso, 'netherite_chestplate')
  assert.ok(armorScore({ name: 'iron_helmet', enchants: [{ name: 'protection', lvl: 4 }] }) > armorScore({ name: 'diamond_helmet' }), 'Protection IV iron protects more than plain diamond')
  assert.equal(armorInfo('elytra'), null)
  assert.equal(armorScore({ name: 'iron_sword' }), 0)
  keeper.detach()
})

test('what is worn on purpose is not replaced, and a cursed piece is never put on', async () => {
  const bot = armorBot(['diamond_chestplate', 'iron_helmet', { name: 'netherite_boots', enchants: [{ name: 'binding_curse', lvl: 1 }] }, 'torch'], { torso: 'elytra', head: 'carved_pumpkin', 'off-hand': 'torch' })
  const keeper = new ArmorKeeper(bot, { delayMs: 5 })
  bot.give('shield')
  bot.give('totem_of_undying')
  assert.deepEqual(await keeper.wearBest(), [])
  assert.deepEqual(bot.wearing(), { head: 'carved_pumpkin', torso: 'elytra', legs: null, feet: null, 'off-hand': 'torch' })
  // An empty off hand takes the totem; a shield gives way to a totem.
  const two = armorBot(['shield'])
  const k2 = new ArmorKeeper(two)
  await k2.wearBest()
  assert.equal(two.wearing()['off-hand'], 'shield')
  two.give('totem_of_undying')
  await k2.wearBest()
  assert.equal(two.wearing()['off-hand'], 'totem_of_undying')
})

test('the keeper waits for an open container, busy hands and a refused equip', async () => {
  const bot = armorBot(['iron_helmet'])
  const keeper = new ArmorKeeper(bot, { delayMs: 5, retryMs: 15 }).attach()
  bot.currentWindow = { type: 'minecraft:chest' }
  bot.inventory.emit('updateSlot', 9, null, bot.inventory.slots[9])
  await sleep(40)
  assert.equal(bot.wearing().head, null, 'no clicks into an open chest')
  bot.currentWindow = null
  bot.emit('windowClose')
  await sleep(40)
  assert.equal(bot.wearing().head, 'iron_helmet')
  keeper.detach()

  // Hands busy twice (hand_busy), then free: it comes back by itself.
  const busy = armorBot(['iron_boots'])
  let n = 0
  const k2 = new ArmorKeeper(busy, { delayMs: 5, retryMs: 15, equip: async (item, dest) => (++n <= 2 ? { ok: false, why: 'hand_busy' } : (await busy.equip(item, dest), { ok: true })) })
  await k2.wearBest()
  assert.equal(busy.wearing().feet, null)
  await sleep(120)
  assert.equal(busy.wearing().feet, 'iron_boots')

  // An equip that "succeeds" without moving anything (a paused body) is not reported as worn.
  const paused = armorBot(['iron_boots'])
  const logs = []
  const k3 = new ArmorKeeper(paused, { delayMs: 5, retryMs: 5, equip: async () => ({ ok: true }), log: (level, msg) => logs.push(`${level}: ${msg}`) })
  assert.deepEqual(await k3.wearBest(), [])
  await sleep(80)
  assert.ok(!logs.some((l) => /armor: put on/.test(l)), 'nothing is claimed that the inventory does not show')
  assert.equal(k3.stats.worn, 0)
  assert.equal(k3._retries, 4, 'and it stops retrying instead of spinning')
  await sleep(40)
  assert.equal(k3.stats.checks, 5, 'one look and four retries, then it waits for the next real change')
  k3.detach()
})

test('a slot the model set is left alone until the model hands it back', async () => {
  const bot = armorBot(['diamond_helmet', 'iron_chestplate'], { head: 'leather_helmet' })
  const keeper = new ArmorKeeper(bot, { delayMs: 5 })
  keeper.hold('head')
  await keeper.wearBest()
  assert.deepEqual([bot.wearing().head, bot.wearing().torso], ['leather_helmet', 'iron_chestplate'], 'held slot kept, the others still looked after')
  assert.match(keeper.describe(), /auto, except head/)
  assert.equal(keeper.brief(), 'armor: auto except head')

  keeper.setAuto(false)
  bot.give('diamond_leggings')
  keeper.poke()
  await sleep(40)
  assert.equal(bot.wearing().legs, null, 'switched off: nothing is put on')
  assert.equal(keeper.brief(), 'armor: manual')

  assert.match(keeper.setAuto(true), /^auto — /)
  await sleep(40)
  assert.deepEqual(bot.wearing(), { head: 'diamond_helmet', torso: 'iron_chestplate', legs: 'diamond_leggings', feet: null, 'off-hand': null }, 'back on: held slots released and everything worn')
  assert.equal(keeper.brief(), '', 'and the prompt line goes away again')
})

test('the model controls its armor through equip: wear, take off, switch the autopilot', async () => {
  // A session over the simulated bot, with an inventory that has armor slots.
  const sim = simulatedBot()
  const a = armorBot(['iron_helmet', 'leather_helmet', 'diamond_sword'])
  sim.inventory = a.inventory
  sim.getEquipmentDestSlot = a.getEquipmentDestSlot
  sim.equip = async (item, dest) => { if (!dest || dest === 'hand') { sim.heldItem = item; return } return a.equip(item, dest) }
  sim.unequip = a.unequip
  const wearing = a.wearing
  const s = startTestSession({ bot: sim, actions: () => null, cfg: (cfg) => { cfg.behavior.useArmorManager = true } })
  try {
    s.spawn()
    await s.until(() => wearing().head === 'iron_helmet', 3000) // the autopilot, on spawn
    const run = async (action) => {
      await s.internals().executeAction({ a: 'equip', ...action }, { threatIds: [], askedBy: null })
      return s.internals().results.filter((r) => r.label === 'equip').at(-1)
    }
    const prompt = () => { const built = s.internals().buildActionPrompt(['test']); return typeof built === 'string' ? built : built.text }

    // Take it off: it stays off, and the result says how to hand the slot back.
    let r = await run({ item: 'none', where: 'head' })
    assert.equal(r.ok, true, r.msg)
    assert.match(r.msg, /took off iron_helmet \(head\)/)
    assert.match(r.msg, /head stays as you set it/)
    await sleep(700)
    assert.equal(wearing().head, null, 'the autopilot does not put it straight back on')

    // Wear the worse one on purpose, without naming a slot: it goes on the head.
    r = await run({ item: 'leather_helmet' })
    assert.match(r.msg, /equipped leather_helmet \(head\)/)
    await sleep(500)
    assert.equal(wearing().head, 'leather_helmet')

    // Hand it back.
    r = await run({ auto: true })
    assert.match(r.msg, /armor is now auto — the best armor you carry is put on by itself/)
    await s.until(() => wearing().head === 'iron_helmet', 3000)

    // Wearing what the autopilot would pick anyway holds nothing.
    r = await run({ item: 'iron_helmet', where: 'head' })
    assert.doesNotMatch(r.msg, /stays as you set it/)

    // Off entirely: said in the result, and on the prompt's state.
    r = await run({ auto: false })
    assert.match(r.msg, /armor is now manual/)
    r = await run({ item: 'none', where: 'head' })
    await sleep(500)
    assert.equal(wearing().head, null)
    assert.match(prompt(), /^armor: manual$/m)

    // The hand still works as before; an empty slot and a missing slot are plain answers.
    r = await run({ item: 'diamond_sword' })
    assert.match(r.msg, /equipped diamond_sword \(hand\)/)
    r = await run({ item: 'none', where: 'legs' })
    assert.match(r.msg, /nothing on legs to take off/)
    r = await run({ item: 'none' })
    assert.equal(r.ok, false)
    assert.match(r.msg, /say which slot to empty/)
  } finally { s.stop() }
})

test('the armor plugin is gone, and equip tells the model what it can do', () => {
  const src = fs.readFileSync(path.join(root, 'zincai', 'index.js'), 'utf8')
  assert.doesNotMatch(src, /mineflayer-armor-manager|containedPlugin/, 'no third-party handler to contain: the handler is ours and cannot throw')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['mineflayer-armor-manager'], undefined)
  const { ACTION_TOOLS } = require('../zincai/api_wrapper')
  const equip = ACTION_TOOLS.find((t) => t.name === 'equip')
  assert.equal(equip.parameters.properties.auto.type, 'boolean')
  assert.match(equip.parameters.properties.item.description, /"none" \+ where takes off/)
  assert.ok(!equip.parameters.required, 'auto may be sent alone')
  assert.match(fs.readFileSync(path.join(root, 'zincai', 'system_prompt.txt'), 'utf8'), /equip \{auto:false\}/)
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

test('timeout diagnosis separates an active protocol link, server silence and a blocked bot', () => {
  const run = (kind) => {
    const logs = []
    let now = 1_000_000
    const wd = new LoopWatchdog({ log: (level, msg) => logs.push({ level, msg }), now: () => now, stack: false })
    wd.linkUp({ timeoutMs: 60_000 })
    wd.packet('keep_alive', { keepAliveId: 123n })
    wd.outbound('keep_alive', { keepAliveId: 123n })
    if (kind === 'active') {
      for (let i = 0; i < 11; i++) { now += 5_000; wd.packet('time_update', {}) }
      now += 5_000
    } else if (kind === 'silent') {
      now += 60_001
    } else {
      now += 60_001
      wd._lastStall = { startedAt: now - 59_000, endedAt: now, durationMs: 59_000 }
    }
    const cause = wd.connectionError(new Error('client timed out after 60000 milliseconds'))
    return { cause, logs, wd }
  }

  const active = run('active')
  assert.equal(active.cause, 'keepalive-stream-only')
  assert.match(active.logs.at(-1).msg, /ordinary server packet\(s\).*TCP link was alive/)
  assert.equal(active.wd.stats.keepAlives, 1)
  assert.equal(active.wd.stats.keepAliveReplies, 1)

  const silent = run('silent')
  assert.equal(silent.cause, 'server-or-tcp-silence')
  assert.match(silent.logs.at(-1).msg, /Minecraft server process\/tick loop stalled/)

  const blocked = run('blocked')
  assert.equal(blocked.cause, 'bot-main-thread')
  assert.match(blocked.logs.at(-1).msg, /JavaScript thread was blocked/)
})

test('a wrong keep-alive echo is identified as a client protocol failure', () => {
  const logs = []
  let now = 50_000
  const wd = new LoopWatchdog({ log: (level, msg) => logs.push(msg), now: () => now, stack: false })
  wd.linkUp({ timeoutMs: 60_000 })
  wd.packet('keep_alive', { keepAliveId: 987654321n })
  wd.outbound('keep_alive', { keepAliveId: 987654320n })
  now += 60_001
  assert.equal(wd.connectionError(new Error('client timed out after 60000 milliseconds')), 'client-reply-path')
  assert.equal(wd.stats.replyMismatches, 1)
  assert.match(logs.join('\n'), /client\/protocol reply path/)
})

test('the real 26.3 protocol echoes a non-zero 64-bit keep-alive id exactly on localhost', { timeout: 5000 }, async (t) => {
  const mc = require('minecraft-protocol')
  const server = mc.createServer({
    'online-mode': false,
    host: '127.0.0.1',
    port: 0,
    version: '26.3',
    keepAlive: false
  })
  let client = null
  const close = async () => {
    // Destroy the test sockets directly. Client.end() deliberately keeps a
    // 30-second hard-close safety timer, which would make this fast test keep
    // the whole test process alive for another 30 seconds.
    try { clearTimeout(client?.closeTimer); client?.socket?.destroy() } catch { /* already closed */ }
    for (const peer of Object.values(server.clients || {})) {
      try { clearTimeout(peer.closeTimer); peer.socket?.destroy() } catch { /* already closed */ }
    }
    if (server.socketServer?.listening) {
      const closed = once(server, 'close')
      server.socketServer.close()
      await closed.catch(() => {})
    }
  }
  t.after(close)
  const within = (promise, label) => Promise.race([
    promise,
    sleep(2000).then(() => { throw new Error(`timed out waiting for ${label}`) })
  ])

  await within(once(server, 'listening'), 'loopback server')
  const port = server.socketServer.address().port
  const login = once(server, 'login')
  client = mc.createClient({
    username: 'ZincKeepAliveProbe',
    auth: 'offline',
    host: '127.0.0.1',
    port,
    version: '26.3',
    checkTimeoutInterval: 2000
  })
  client.on('error', () => {})
  const [peer] = await within(login, 'protocol login')
  while (peer.state !== 'play') await within(once(peer, 'state'), 'play state')

  const wanted = 0x123456789abcdefn
  const decoded = once(client, 'keep_alive')
  const echoed = once(peer, 'keep_alive')
  peer.write('keep_alive', { keepAliveId: wanted })
  const [[challenge], [reply]] = await within(Promise.all([decoded, echoed]), 'keep-alive round trip')
  assert.equal(challenge.keepAliveId.valueOf(), wanted, 'client decoded all 64 bits')
  assert.equal(reply.keepAliveId.valueOf(), wanted, 'minecraft-protocol echoed the exact challenge')
  await close()
})

test('the watchdog can be switched off, and the keep-alive tolerance is configurable', () => {
  assert.equal(watchdogEnabled({}), true)
  assert.equal(watchdogEnabled({ ZINCAI_WATCHDOG: '0' }), false)
  const defaults = JSON.parse(fs.readFileSync(path.join(root, 'zincai', 'config', 'defaults.json'), 'utf8'))
  assert.equal(defaults.reconnect.keepAliveTimeoutMs, 60000)
  const src = fs.readFileSync(path.join(root, 'zincai', 'index.js'), 'utf8')
  assert.match(src, /const keepAliveTimeoutMs = Math\.max\(20_000, Number\(cfg\.reconnect\?\.keepAliveTimeoutMs\) \|\| 60_000\)/)
  assert.match(src, /checkTimeoutInterval: keepAliveTimeoutMs/)
  assert.match(src, /wd\.outbound\(name, packet\)/, 'the exact keep-alive echo is observed')
  assert.doesNotMatch(src, /checkTimeoutInterval: 30_000/)
})
