/**
 * audit2.test.js — regression tests for the second-pass audit (audit/AUDIT2.md).
 * Every test names the finding it locks: B1 gate, B2 containment, B3/E craft
 * reach, B5 stale recall, B9/K ephemeral, B10/B15 invalidation, B11/D trust,
 * scenario 32 chat rate, I language/tooling, G per-mode schemas, C chores.
 */
'use strict'
const test = require('node:test')
const assert = require('node:assert')
process.env.DOTENV_CONFIG_QUIET = 'true'

const { FailGate } = require('../zincai/failgate')
const { ThreatSense } = require('../zincai/threats')
const { checkPortuguese } = require('../zincai/filter')
const { createZincTools } = require('../zincai/api_wrapper')
const { resolveGatherTargets } = require('../zincai/skills')
const { PlaceIndex } = require('../zincai/places')
const world = require('./helpers/world')
const { simulatedBot, startTestSession, sleep } = require('./helpers/session')
const { Vec3 } = require('vec3')

// ------------------------------------------------------------- B2 (threats)
function senseWith (reachable) {
  const bot = world.makeWorld()
  const sense = new ThreatSense(bot, { reachable })
  return { bot, sense }
}
test('B2: visible-but-unreachable mob is demoted to hidden/caged; reachable one is not', () => {
  const { bot, sense } = senseWith(() => false) // the A* probe saying "no walking route"
  world.addMob(bot, 7, 'zombie', 8.5, 0.5) // inside the 12 m trigger ring, LoS
  const s1 = sense.assess()
  assert.equal(s1.threats.length, 0)
  assert.equal(s1.hidden.length, 1)
  assert.equal(s1.hidden[0].caged, true)
  const { bot: bot2, sense: sense2 } = senseWith(() => true)
  world.addMob(bot2, 7, 'zombie', 8.5, 0.5)
  const s2 = sense2.assess()
  assert.equal(s2.threats.length, 1, 'reachable mob stays a live threat')
})
test('B2: demotion never applies to ranged mobs or recent attackers; and a reachable walker with LoS stays real', () => {
  const { bot, sense } = senseWith(() => false)
  world.addMob(bot, 8, 'skeleton', 10.5, 0.5) // ranged: shoots over the fence
  const s1 = sense.assess()
  assert.equal(s1.threats.length, 1, 'ranged stays real')
  const { bot: bot3, sense: sense3 } = senseWith(() => false)
  const z2 = world.addMob(bot3, 10, 'zombie', 8.5, 0.5)
  sense3.noteAttacker(z2)
  const s3 = sense3.assess()
  assert.equal(s3.threats.length, 1, 'a proven attacker stays real')
  // A mob moving toward the bot in the OPEN probes as reachable: stays real.
  const { bot: bot4, sense: sense4 } = senseWith(() => true)
  const z4 = world.addMob(bot4, 11, 'zombie', 9.5, 0.5)
  sense4.assess()
  z4.position.x -= 0.6 // visibly closing
  const s4 = sense4.assess()
  assert.equal(s4.threats.length, 1, 'an approaching loose mob is not accidentally demoted')
})

// ----------------------------------------------------------------- B1 gate
test('B1: FailGate blocks the third identical failure, clears on success; move clears only positional failures', () => {
  let now = 1_000
  const g = new FailGate({ now: () => now })
  const act = { a: 'attack', target: 'zombie' }
  const pos = { x: 0, z: 0 }
  assert.equal(g.check(act, pos), null)
  g.recordFailure(act, 'too hurt to fight', pos)
  g.recordFailure(act, 'too hurt to fight', pos)
  assert.match(g.check(act, pos), /skipped: the exact same attack failed 2x/)
  // a different target is a different call — never blocked
  assert.equal(g.check({ a: 'attack', target: 'skeleton' }, pos), null)
  // success of the tool clears it
  g.recordSuccess(act)
  assert.equal(g.check(act, pos), null)
  // a STATE failure ("too hurt") is NOT cured by the body dragging the bot
  // away — the flee reflex used to re-arm this very loop (repro 05)
  g.recordFailure(act, 'too hurt to fight', pos)
  g.recordFailure(act, 'too hurt to fight', pos)
  assert.match(g.check(act, { x: 10, z: 0 }), /skipped:/)
  assert.ok(g.advisoryLine({ x: 10, z: 0 }), 'still gated 10 m away — hp did not change')
  // a POSITIONAL failure ("could not reach") IS cured by arriving elsewhere
  const craft = { a: 'craft', item: 'planks' }
  g.recordFailure(craft, 'could not reach the crafting table', pos)
  g.recordFailure(craft, 'could not reach the crafting table', pos)
  assert.match(g.check(craft, pos), /skipped:/)
  assert.equal(g.check(craft, { x: 10, z: 0 }), null)
  // and time clears everything
  now += 121_000
  assert.equal(g.check(act, pos), null)
  assert.equal(g.check(craft, pos), null)
  // ungateable tools never blocked
  assert.equal(g.signature({ a: 'say', t: 'x' }), null)
})

test('B1 session: a model that keeps repeating a refused attack is locally cut off', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const s = startTestSession({
    bot,
    actions: (p) => (/reflex: started FLEEING/.test(p) || /attack failed/.test(p) ? { a: 'attack', target: 'zombie' } : null)
  })
  try {
    s.spawn(); await sleep(200)
    bot.health = 5 // engage refuses at/under the 30% line (6 hp) — "too hurt to fight"
    world.addApproaching(bot, 50, 'zombie', 6.5, 0.5, 0.16)
    assert.ok(await s.until(() => s.internals().results.some((r) => /skipped: the exact same attack/.test(r.msg)), 15_000), 'the gate fired')
    const attackReports = s.internals().results.filter((r) => r.label === 'attack' && !r.ok).length
    assert.ok(attackReports <= 5, `refusals recorded (${attackReports}), then stopped`)
    assert.ok(s.internals().buildActionPrompt(['test']).text.includes('blocked repeats:'), 'the prompt carries the advisory')
  } finally { s.stop() }
})

// ------------------------------------------------------------- B3/E craft
test('E: craft walks to an out-of-reach table, then crafts', async () => {
  const bot = simulatedBot({ items: [['cobblestone', 8]], blocks: { '7,64,0': 'crafting_table' } })
  bot.craft = async () => {} // the window click is out of scope here
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(200)
    const before = bot.entity.position.distanceTo(new Vec3(7, 64, 0))
    assert.ok(before > 4.5, 'table starts out of reach')
    const snap = s.internals().buildActionPrompt(['test'])
    await s.internals().executeAction({ a: 'craft', item: 'furnace' }, snap)
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'craft'), 8000))
    const r = s.internals().results.find((x) => x.label === 'craft')
    assert.equal(r.ok, true, r.msg)
    assert.ok(bot.entity.position.distanceTo(new Vec3(7, 64, 0)) <= 4, 'it walked next to the table first')
  } finally { s.stop() }
})

// ------------------------------------------------------------ B11/D trust
test('D: a guest cannot take/give valuables; an owner can', async () => {
  const { addPlayer } = require('./helpers/session')
  const bot = simulatedBot({ items: [['diamond', 5], ['bread', 4]] })
  addPlayer(bot, 3, 'Maria', 3.5, 0.5)
  addPlayer(bot, 4, 'Gabriel', -3.5, 0.5)
  let tossed = []
  bot.toss = async (type, meta, n) => { tossed.push(n) }
  const s = startTestSession({
    bot,
    chat: (p) => (/Gabriel/.test(p) ? { text: 'aqui tem', task: 'give Gabriel bread' } : { text: 'ta bom', task: 'give Maria 2 diamonds' }),
    actions: (p) => {
      if (/chat request from Maria/.test(p)) return { a: 'give', player: 'Maria', item: 'diamond', count: 2 }
      if (/chat request from Gabriel/.test(p)) return { a: 'give', player: 'Gabriel', item: 'bread', count: 1 }
      return null
    },
    cfg: (cfg) => { cfg.trust = { owners: ['Gabriel'], trusted: [] } }
  })
  try {
    s.spawn(); await sleep(200)
    s.say('<Maria> zinc, me da os diamantes')
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'give' && !r.ok), 6000))
    const r = s.internals().results.find((x) => x.label === 'give' && !x.ok)
    assert.match(r.msg, /not in the trust list/)
    assert.equal(tossed.length, 0, 'nothing was tossed to a guest')
    s.say('<Gabriel> zinc, me da um pao')
    assert.ok(await s.until(() => s.internals().results.some((x) => x.label === 'give' && x.ok), 6000), 'the owner got the bread')
    assert.equal(tossed.length, 1)
  } finally { s.stop() }
})

// ------------------------------------------------------------- B5 recall
test('B5: hours-old chat no longer steers recall on an unrelated wake; fresh chat still does', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, chat: () => ({ text: 'oi' }), actions: () => null })
  try {
    s.spawn(); await sleep(200)
    s.shared.memory.addEvent({ type: 'place', msg: 'o portal fica em 120, 64, -40', tags: ['portal'] }, { promote: true })
    s.say('<Gabriel> zinc, onde fica o portal?')
    await sleep(400)
    const pFresh = s.internals().buildActionPrompt(['test wake']).text
    assert.match(pFresh, /(recalled|memories):[^]*portal fica em 120/, 'fresh chat still drives the recall query')
    // age the player's line itself (not the bot's own reply, which also lives in the log)
    const last = [...s.shared.chatLog].reverse().find((l) => l.who !== 'me')
    last.ts = Date.now() - 3_600_000 // pretend it was said an hour ago
    const pStale = s.internals().buildActionPrompt(['test wake']).text
    // the query-driven recall section must be gone (the raw chat/working-memory
    // sections are fresh by design and may still quote the words)
    assert.ok(!/(recalled|memories):/.test(pStale), 'old chat is out of the recall query')
  } finally { s.stop() }
})

// ------------------------------------------------------------- B9 ephemeral
test('K: the ephemeral 30s window shows in the action prompt and is PT-section aware', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(150)
    s.shared.memory.addEvent({ type: 'resumed', msg: 'task resumed after the interruption' }, { promote: false })
    s.shared.memory.addEvent({ type: 'chat', sender: 'Gabriel', msg: 'Gabriel: oi' }, { promote: false }) // own section: excluded
    const text = s.internals().buildActionPrompt(['test']).text
    assert.match(text, /just now: .*task resumed after the interruption/)
    assert.ok(!/just now:.*Gabriel: oi/.test(text), 'chat is shown in its own section, not duplicated')
  } finally { s.stop() }
})

// --------------------------------------------------------------- B13 health
test('B13: absorption hearts re-base combat odds — maxHealth is observed, not pinned to 20', () => {
  const { AdvancedCombat } = require('../src/combat')
  const bot = world.makeWorld()
  const c = new AdvancedCombat(bot, { maxHealth: 20, disengageHealthFraction: 0.3 })
  assert.equal(c.maxHealth, 20)
  assert.equal(c.disengageAt, 6)
  c.noteHealth(19) // a vanilla health swing changes nothing
  assert.equal(c.maxHealth, 20)
  assert.equal(c.disengageAt, 6)
  c.noteHealth(24.4) // Absorption I reports hp above 20
  assert.equal(c.maxHealth, 25)
  assert.equal(c.disengageAt, 7, 'the low-hp refusal follows the new base')
})

// ------------------------------------------------- B10/B15 place invalidation
test('B15: blockUpdate invalidates an indexed container at once', () => {
  const places = new PlaceIndex()
  const entry = { id: 'chest1', kind: 'chest', block: 'chest', x: 3, y: 64, z: 0, dim: 'overworld', label: '', contents: { iron: 5 }, seenAt: Date.now(), lookedAt: Date.now() }
  places.blocks.set(places._key(entry), entry)
  places.onBlockChange(null, { name: 'air', position: new Vec3(3, 64, 0) })
  assert.equal(places.blocks.size, 0, 'a broken chest leaves the index instantly')
  const places2 = new PlaceIndex()
  places2.blocks.set(places2._key(entry), { ...entry, contents: { iron: 5 }, lookedAt: Date.now() })
  places2.onBlockChange(null, { name: 'barrel', position: new Vec3(3, 64, 0) })
  const e2 = [...places2.blocks.values()][0]
  assert.ok(e2, 're-kinded container stays indexed')
  assert.equal(e2.contents, null, 'contents wiped on identity change')
  assert.equal(e2.lookedAt, 0)
})

test('B15b: a container placed inside the scanned box is indexed at once; far away or another dimension is not', () => {
  const places = new PlaceIndex()
  // Pretend a scan just happened around 0,64,0 with radius 16.
  places._lastScan = { at: Date.now(), x: 0, y: 64, z: 0, dim: 'overworld', radius: 16 }
  places.onBlockChange(null, { name: 'chest', position: new Vec3(5, 64, 2) }, { dim: 'overworld' })
  const adopted = [...places.blocks.values()]
  assert.equal(adopted.length, 1, 'the new chest next to the bot is usable immediately')
  assert.equal(adopted[0].kind, 'chest')
  assert.equal(adopted[0].contents, null, 'contents unknown until someone looks inside')
  places.onBlockChange(null, { name: 'barrel', position: new Vec3(120, 64, 0) }, { dim: 'overworld' })
  assert.equal(places.blocks.size, 1, 'an edit 120 m away is none of our business')
  places.onBlockChange(null, { name: 'barrel', position: new Vec3(6, 64, 2) }, { dim: 'the_nether' })
  assert.equal(places.blocks.size, 1, 'an update from another dimension is not adopted as ours')
  // No scan yet → no adoption window at all.
  const cold = new PlaceIndex()
  cold.onBlockChange(null, { name: 'chest', position: new Vec3(1, 64, 1) }, { dim: 'overworld' })
  assert.equal(cold.blocks.size, 0)
})

// ------------------------------------------------------- scenario 32 / rate
test('scenario 32: a spamming player cannot monopolize the chat lane', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, chat: () => ({ text: 'oi' }), actions: () => null, cfg: (cfg) => { cfg.behavior = { ...cfg.behavior, chatPerPlayerPerMinute: 3 } } })
  try {
    s.spawn(); await sleep(200)
    for (let i = 0; i < 10; i++) s.say(`<Maria> zinc, oi ${i}`)
    await sleep(1500)
    // Count only the "says:" input lines, never the quoted conversation history
    const totalLines = s.prompts.chat.reduce((n, p) => {
      const says = p.split('\n').filter((l) => /^Maria says:/.test(l)).join('\n')
      return n + (says.match(/zinc, oi \d/g) || []).length
    }, 0)
    assert.ok(totalLines <= 4, `at most the configured rate reached the lane (got ${totalLines})`)
    assert.ok(totalLines >= 1, 'the first lines still arrive')
  } finally { s.stop() }
})

// ---------------------------------------------------- I: language coverage
test('I: the PT-BR guard now also rejects Spanish/French/German drift', () => {
  assert.equal(checkPortuguese('hola como estas amigo').ok, false)
  assert.equal(checkPortuguese('bonjour, comment ça va?').ok === false, true)
  assert.equal(checkPortuguese('hola').ok, false, 'single strong foreign word rejected')
  assert.equal(checkPortuguese('valeu, cheguei já').ok, true, 'PT-BR untouched')
  assert.equal(checkPortuguese('ok').ok, true, 'shared words stay neutral')
})

// ------------------------------------------------- G: per-mode tool subsets
test('G: action tool schemas follow the mode (builder keeps build; explorer drops it)', () => {
  const names = (tools) => tools.map((t) => t.function.name)
  const builder = names(createZincTools({ mode: 'builder' }))
  const explorer = names(createZincTools({ mode: 'explorer' }))
  const hunter = names(createZincTools({ mode: 'hunter' }))
  assert.ok(builder.includes('build') && builder.includes('build_shape'))
  assert.ok(!explorer.includes('build_shape') && explorer.includes('gather'), 'explorer: no build, yes gather')
  assert.ok(!hunter.includes('smelt') && hunter.includes('attack'))
  for (const keep of ['say', 'idle', 'stop', 'find', 'set_mode', 'hold']) {
    for (const mode of [builder, explorer, hunter]) assert.ok(mode.includes(keep), `${keep} survives every mode`)
  }
  assert.equal(names(createZincTools()).length, 27, 'the full set is 27 tools after the chores')
})

// --------------------------------------------------------------- C: gather
test('C: gather digs ONLY the allowlisted resource and reports honestly', async () => {
  const bot = simulatedBot({
    items: [['wooden_pickaxe']],
    blocks: { '6,64,0': 'oak_log', '6,65,0': 'oak_log', '9,64,0': 'cobblestone' }
  })
  let dug = []
  bot.dig = async (block) => { dug.push(block.name) }
  bot.lookAt = async () => {}
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); await sleep(200)
    const snap = s.internals().buildActionPrompt(['test'])
    await s.internals().executeAction({ a: 'gather', item: 'oak_log', count: 2 }, snap)
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'gather'), 15_000))
    const r = s.internals().results.find((x) => x.label === 'gather')
    assert.equal(r.ok, true, r.msg)
    assert.deepEqual(dug, ['oak_log', 'oak_log'], 'only oak_log was dug; the cobblestone was never touched')
    // refuse out-of-allowlist targets before walking anywhere
    const r2 = await s.internals().skills.gather({ item: 'oak_planks', count: 1 })
    assert.equal(r2.ok, false)
    assert.match(r2.msg, /not gatherable/)
    // pickaxe honesty: diamond ore needs iron+
    const r3 = await s.internals().skills.gather({ item: 'diamond_ore', count: 1 })
    assert.equal(r3.ok, false)
    assert.match(r3.msg, /need at least a iron pickaxe/)
  } finally { s.stop() }
})

test('C: resolveGatherTargets is a closed allowlist (no free-form digging)', () => {
  const registry = world.registry
  assert.equal(resolveGatherTargets(registry, 'grass'), null)
  assert.equal(resolveGatherTargets(registry, 'chest'), null)
  assert.equal(resolveGatherTargets(registry, 'glass'), null)
  assert.ok(resolveGatherTargets(registry, 'oak_log').names.includes('oak_log'))
  assert.ok(resolveGatherTargets(registry, 'coal').names.includes('coal_ore'))
})
