'use strict'
/** Small, independent checks behind individual findings of the report. */
const fs = require('fs'); const os = require('os'); const path = require('path')
const { req, world, simulatedBot, startTestSession, sleep } = require('./_common')
const { MemorySystem } = req('zincai/memory')
const filter = req('zincai/filter')
const { BlueprintParser } = req('zincai/builder')
const { chooseFood } = req('zincai/system1')
const api = req('zincai/api_wrapper')
const { AdvancedCombat, forecastImpact, weaponProfile } = req('src/combat')
const { isTamed, isProtected, useRegistry } = req('zincai/threats')
const { makeBot } = req('test/helpers/mockbot')
const head = (t) => console.log(`\n== ${t}`)

async function takeFallsBackToFurnace () {
  head('take {item:"diamond"} when no opened container holds diamonds, and a furnace is nearby')
  const bot = simulatedBot({ items: [['bread', 3]], blocks: { '3,64,0': 'chest', '0,64,3': 'furnace' }, containers: { '3,64,0': { cobblestone: 64 } } })
  let taken = false
  bot.openFurnace = async () => ({ inputItem: () => null, fuelItem: () => null, outputItem: () => (taken ? null : { name: 'iron_ingot', count: 9 }), takeOutput: async () => { taken = true; return { name: 'iron_ingot', count: 9 } }, close () {} })
  const s = startTestSession({ bot, actions: (p) => (/test: take diamond/.test(p) ? { a: 'take', item: 'diamond' } : null) })
  s.spawn(); await sleep(300)
  s.internals().brain.wake('test: take diamond')
  await s.until(() => s.internals().results.length > 0, 6000)
  for (const r of s.internals().results) console.log(`   result shown to the model → ${r.label}: ${r.ok ? 'ok' : 'FAILED'} — ${r.msg}`)
  s.stop()
}

function whatChatIsRemembered () {
  head('rememberChat(): which things a friend tells the bot reach long-term memory')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mem-'))
  const mem = new MemorySystem({ file: path.join(dir, 'm.json'), preferencesFile: path.join(dir, 'p.json') })
  for (const l of ['guardei os diamantes no bau do segundo andar', 'coloquei a picareta na fornalha', 'deixei tua espada em cima da mesa', 'meus pais chegam amanha',
    'eu sou alergico a creeper kkkk', 'amanha a gente vai matar o dragao', 'o pedro eh meu irmao', 'meu aniversario eh dia 12']) {
    console.log(`   ${mem.rememberChat('Gabriel', l, { addressed: true }) ? 'kept   ' : 'DROPPED'}  "${l}"`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

function whoIsAddressed () {
  head('chatAddressesBot(): is the line for the bot? (3 other players online unless noted)')
  const names = filter.botNames('ZincAI', ['zinc'])
  for (const [t, ctx] of [['zinc vem aqui', {}], ['Zinco, cade vc?', {}], ['zincão bora minerar', {}], ['o bot ta travado kkk', {}], ['vem aqui', {}], ['alguem tem ferro?', {}],
    ['pedro me passa a picareta', { inConversation: true }]]) {
    console.log(`   ${String(filter.chatAddressesBot(t, { names, othersOnline: 3, ...ctx })).padEnd(13)} "${t}"${ctx.inConversation ? '   (30 s after talking to the bot)' : ''}`)
  }
}

function phasedBuild () {
  head('phased build: inventory pre-flight (zincai/index.js buildBlocks) for stage "foundation" of small_house')
  const parser = new BlueprintParser({})
  const bp = parser.load('small_house')
  const foundation = parser.decompose(bp.blocks).phases.foundation
  const carried = Object.entries(parser.checkInventory(foundation, []).counts).map(([name, count]) => ({ name, count }))
  const pre = parser.checkInventory(bp.blocks, carried) // what index.js does: ALL blocks, whatever the stage
  console.log(`   carrying exactly what the foundation needs (${carried.map((i) => `${i.name} x${i.count}`).join(', ')}) → ${pre.ok ? 'ok' : 'refused: missing ' + pre.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')}`)
  head('build tool: an inline grid that conforms to the declared schema')
  console.log('   declared arguments:', Object.keys(api.ACTION_TOOLS.find((t) => t.name === 'build').parameters.properties).join(', '))
  try { parser.parseInline({ grid: [[['#', '#'], ['#', '#']]] }); console.log('   parsed') } catch (e) { console.log('   →', e.message) }
}

function eating () {
  head('chooseFood(): hurt bot carrying only cooked_beef (natural regeneration needs food ≥ 18)')
  for (const [food, health] of [[17, 4], [15, 4], [13, 6], [12, 6]]) console.log(`   hp ${health}/20, food ${food}/20 → eats ${chooseFood([{ name: 'cooked_beef', count: 20 }], { food, health, healing: true })?.name ?? 'nothing'}`)
}

async function combat () {
  head('_equipBestWeapon(): which carried weapons are auto-equipped when a fight starts (src/combat.js)')
  for (const n of ['iron_sword', 'copper_sword', 'copper_axe', 'mace', 'trident', 'diamond_spear']) {
    const bot = makeBot({ items: [{ name: n }] })
    await new AdvancedCombat(bot, {})._equipBestWeapon()
    console.log(`   ${n.padEnd(14)} ${bot.log.equip.length ? 'yes' : 'NO '}  (profile when held: ${weaponProfile(n).label})`)
  }
  head('forecastImpact(): what the fight controller dodges, from measured motion (speeds in blocks per tick)')
  const me = { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }
  const P = (held, x, y, z) => ({ id: 2, name: 'player', type: 'player', username: 'Gabriel', position: { x, y, z }, heldItem: { name: held } })
  const show = (label, f) => console.log(`   ${label.padEnd(52)} → ${f ? `${f.kind}, impact in ${(f.inSec * 1000).toFixed(0)} ms` : 'nothing'}`)
  show('mace, ordinary jump coming down (fell 1.25)', forecastImpact(P('mace', 0, 64.3, 2), me, { vx: 0, vy: -0.44, vz: 0, falling: true, fallen: 1.25 }))
  show('mace, walking down stairs', forecastImpact(P('mace', 0, 66, 2), me, { vx: 0, vy: -0.2, vz: -0.2, falling: true, fallen: 0.5 }))
  show('mace, real dive from 8 up, 3 blocks above now', forecastImpact(P('mace', 0, 67, 2), me, { vx: 0, vy: -0.75, vz: -0.1, falling: true, fallen: 5 }))
  show('mace, same dive but landing 8 blocks away', forecastImpact(P('mace', 0, 67, 8), me, { vx: 0, vy: -0.75, vz: 0, falling: true, fallen: 5 }))
  show('spear + elytra, level glide at 20 m/s, 14 blocks out', forecastImpact(P('diamond_spear', 0, 65, 14), me, { vx: 0, vy: 0, vz: -1.0, falling: false, fallen: 0 }, { gliding: true }))
  show('spear + elytra, level glide at 30 m/s, 26 blocks out', forecastImpact(P('diamond_spear', 0, 65, 26), me, { vx: 0, vy: 0, vz: -1.5, falling: false, fallen: 0 }, { gliding: true }))
  show('the same glide passing 6 blocks to the side', forecastImpact(P('diamond_spear', 6, 65, 14), me, { vx: 0, vy: 0, vz: -1.0, falling: false, fallen: 0 }, { gliding: true }))
  show('spear driven in on foot (item in use), 3 blocks', forecastImpact(P('diamond_spear', 0, 64, 3), me, { vx: 0, vy: 0, vz: -0.22, falling: false, fallen: 0 }, { usingItem: true }))
  show('sword, sprinting at the bot (ordinary melee)', forecastImpact(P('diamond_sword', 0, 64, 4), me, { vx: 0, vy: 0, vz: -0.28, falling: false, fallen: 0 }))
}

async function oneSteak () {
  head('attack {target:"cow"} next to a pen of 5 cows (the request was for one steak)')
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const s = startTestSession({ bot, actions: (p) => (/test: one steak/.test(p) ? { a: 'attack', target: 'cow' } : null) })
  s.spawn(); await sleep(300)
  const cows = []
  for (let i = 0; i < 5; i++) { const c = world.addMob(bot, 70 + i, 'cow', 4.5 + i, 2.5, { type: 'animal' }); c.hp = 10; cows.push(c) }
  let dead = 0
  bot.on('test_attack', (e) => { const c = cows.find((x) => x.id === e?.id); if (c && bot.entities[c.id] && (c.hp -= 8) <= 0) { dead++; delete bot.entities[c.id]; bot.emit('entityDead', c); bot.emit('entityGone', c) } })
  s.internals().brain.wake('test: one steak')
  await s.until(() => dead === 5 || s.internals().results.some((r) => r.label === 'fight'), 30000)
  await sleep(300)
  console.log(`   model calls that said "attack": 1 → cows killed: ${dead} of 5`)
  for (const r of s.internals().results.filter((x) => x.label === 'fight')) console.log(`   result shown to the model → fight: ${r.msg}`)
  s.stop()
}

function pets () {
  head('isTamed(): a tamed wolf, with entity metadata laid out as each version sends it')
  for (const v of ['1.21.4', '26.3']) {
    const data = require('minecraft-data')(v)
    const keys = data.entitiesByName.wolf.metadataKeys
    const check = useRegistry(data) // what the harness does at spawn with the server's own data
    const tamed = { name: 'wolf', metadata: [] }
    tamed.metadata[keys.indexOf('flags')] = 0x04
    const stale = { name: 'wolf', metadata: [] }
    stale.metadata[17] = 0x04 // where the flag used to be read, whatever the version
    console.log(`   ${v.padEnd(6)} flags at ${keys.indexOf('flags')}, owner at ${keys.indexOf('owneruuid')}${check.problems.length ? ` (${check.problems.join('; ')})` : ''}`)
    console.log(`          tamed wolf → isTamed ${isTamed(tamed)}, protected from "attack wolf": ${isProtected(tamed)};  wild wolf → protected: ${isProtected({ name: 'wolf', metadata: [] })};  bit 4 at index 17 → isTamed ${isTamed(stale)}`)
  }
  useRegistry(null)
}

;(async () => { await takeFallsBackToFurnace(); whatChatIsRemembered(); whoIsAddressed(); phasedBuild(); eating(); await combat(); pets(); await oneSteak(); process.exit(0) })().catch((e) => { console.error(e); process.exit(1) })
