/**
 * Independent world verifier (our oracle — NOT the bot under test).
 * Teleports itself (via RCON, allowed for the verifier) to each area,
 * samples real blocks + entities and reports PASS/FAIL per check.
 * Usage: node verify_world.js [all|A|B|C|D|E|F]
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')
const { Vec3 } = require('/home/anonymous/minecraft-harness/node_modules/vec3')

const GT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reports', 'WORLD_GROUND_TRUTH.json'), 'utf8'))
const what = process.argv[2] || 'all'
const results = []
const check = (id, ok, detail = '') => {
  results.push({ id, ok: !!ok, detail: String(detail).slice(0, 160) })
  console.log((ok ? 'PASS' : 'FAIL'), id, detail ? `— ${detail}` : '')
}
const rcon = (cmd) => spawnSync('node', [path.join(__dirname, 'rcon.js'), cmd], { encoding: 'utf8', timeout: 15000 }).stdout.trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'VerifyBot', auth: 'offline', version: false })
bot.once('error', (e) => { console.log('VERIFY_ERROR', e.message); process.exit(1) })
bot.once('kicked', (r) => { console.log('VERIFY_KICKED', JSON.stringify(r)); process.exit(1) })

function blockAt (x, y, z) { try { return bot.blockAt(new Vec3(x, y, z)) } catch { return null } }
function isBlock (x, y, z, name) { const b = blockAt(x, y, z); return b && b.name === name }
function isAnyOf (x, y, z, names) { const b = blockAt(x, y, z); return b && names.includes(b.name) }

// move the verifier (server-side; this is a measurement instrument, not Zinc)
async function moveVerifier (x, y, z) {
  rcon(`tp VerifyBot ${x} ${y} ${z}`)
  await sleep(5000)
  // wait until the block under us is known (chunk loaded)
  for (let i = 0; i < 10; i++) {
    const b = blockAt(Math.floor(x), y - 1, Math.floor(z))
    if (b && b.name) return
    await sleep(1500)
  }
}

const A = GT.areas.A
const checksA = async () => {
  await moveVerifier(0, 81, 0)
  check('A.floor1_solid', isAnyOf(0, 79, 0, ['cherry_planks', 'cherry_slab']), String(blockAt(0, 79, 0)?.name))
  check('A.floor2_slab', isBlock(0, 83, 0, 'cherry_slab'), String(blockAt(0, 83, 0)?.name))
  check('A.floor3_slab', isBlock(0, 87, 0, 'cherry_slab'), String(blockAt(0, 87, 0)?.name))
  check('A.roof', isBlock(0, 91, 0, 'cherry_slab'), String(blockAt(0, 91, 0)?.name))
  check('A.walls1F', isAnyOf(-10, 81, -8, ['cherry_planks']), String(blockAt(-10, 81, -8)?.name))
  check('A.chest_tools', isBlock(3, 79, 3, 'chest'), 'chest at (3,79,3)')
  check('A.chest_valioso', isBlock(5, 79, 5, 'chest'), 'chest Valioso at (5,79,5)')
  check('A.sign_tools', isAnyOf(3, 80, 2, ['cherry_sign', 'cherry_wall_sign']), 'sign above tools chest')
  check('A.furnace', isBlock(-7, 79, 1, 'furnace'), String(blockAt(-7, 79, 1)?.name))
  check('A.crafting', isBlock(-3, 79, 5, 'crafting_table'), String(blockAt(-3, 79, 5)?.name))
  check('A.enchanting', isBlock(-7, 83, 4, 'enchanting_table'), String(blockAt(-7, 83, 4)?.name))
  check('A.grindstone', isBlock(-5, 83, 4, 'grindstone'), String(blockAt(-5, 83, 4)?.name))
  check('A.brewing', isBlock(5, 83, -5, 'brewing_stand'), String(blockAt(5, 83, -5)?.name))
  check('A.bed', isBlock(-7, 83, -5, 'red_bed'), String(blockAt(-7, 83, -5)?.name))
  check('A.upper_cage_bars', isBlock(1, 88, 4, 'iron_bars') || isBlock(5, 88, 7, 'iron_bars'), 'upper cage iron bars')
  check('A.ground_cage_bars', isBlock(22, 80, -8, 'iron_bars') || isBlock(25, 80, -5, 'iron_bars'), 'ground cage iron bars')
  check('A.pen_fence', isAnyOf(12, 80, -8, ['oak_fence']), String(blockAt(12, 80, -8)?.name))
  check('A.door', isBlock(0, 80, 8, 'cherry_door'), String(blockAt(0, 80, 8)?.name))
}
const checksB = async () => {
  await moveVerifier(60, 81, 0)
  check('B.plateau', isBlock(60, 79, 0, 'grass_block'), String(blockAt(60, 79, 0)?.name))
  check('B.hills', isBlock(55, 82, 0, 'grass_block'), String(blockAt(55, 82, 0)?.name))
  await moveVerifier(110, 81, 50)
  check('B.pond', isBlock(110, 79, 50, 'water'), String(blockAt(110, 79, 50)?.name))
  await moveVerifier(95, 81, 25)
  check('B.ore_coal', isBlock(90, 79, 30, 'coal_ore'), String(blockAt(90, 79, 30)?.name))
  check('B.ore_iron', isBlock(92, 79, 32, 'iron_ore'), String(blockAt(92, 79, 32)?.name))
  check('B.ore_diamond', isBlock(104, 79, 10, 'diamond_ore'), String(blockAt(104, 79, 10)?.name))
  check('B.cave_air', isBlock(93, 77, 13, 'air'), String(blockAt(93, 77, 13)?.name))
  await moveVerifier(132, 81, 12)
  check('B.lava', isBlock(132, 78, 12, 'lava'), String(blockAt(132, 78, 12)?.name))
  check('B.lava_border', isBlock(132, 78, 9, 'obsidian'), String(blockAt(132, 78, 9)?.name))
  await moveVerifier(50, 81, 2)
  check('B.path', isBlock(50, 79, 2, 'dirt_path'), String(blockAt(50, 79, 2)?.name))
}
const checksC = async () => {
  await moveVerifier(-100, 81, 0)
  check('C.arena_floor', isBlock(-100, 79, 0, 'stone_bricks'), String(blockAt(-100, 79, 0)?.name))
  check('C.pillar', isBlock(-100, 82, -5, 'stone_bricks'), String(blockAt(-100, 82, -5)?.name))
  check('C.corridor_air', isBlock(-130, 81, 0, 'air'), String(blockAt(-130, 81, 0)?.name))
  check('C.corridor_wall', isBlock(-130, 81, -1, 'stone_bricks'), String(blockAt(-130, 81, -1)?.name))
  check('C.platform', isBlock(-125, 81, 20, 'stone_bricks'), String(blockAt(-125, 81, 20)?.name))
  check('C.safe_point', isBlock(-113, 80, -25, 'lime_concrete'), String(blockAt(-113, 80, -25)?.name))
}
const checksD = async () => {
  await moveVerifier(0, 81, 90)
  check('D.pad', isBlock(0, 79, 90, 'grass_block'), String(blockAt(0, 79, 90)?.name))
  check('D.depot_chest', isBlock(-26, 80, 64, 'chest'), String(blockAt(-26, 80, 64)?.name))
  check('D.depot_wall', isBlock(-28, 82, 64, 'oak_planks'), String(blockAt(-28, 82, 64)?.name))
  check('D.redstone_chest', isBlock(-22, 80, 66, 'chest'), String(blockAt(-22, 80, 66)?.name))
}
const checksE = async () => {
  await moveVerifier(0, 81, -65)
  check('E.lab_floor', isBlock(0, 79, -65, 'smooth_quartz'), String(blockAt(0, 79, -65)?.name))
  check('E.torch', isBlock(-10, 79, -70, 'redstone_torch'), String(blockAt(-10, 79, -70)?.name))
  check('E.dust', isBlock(-9, 79, -70, 'redstone_wire'), String(blockAt(-9, 79, -70)?.name))
  check('E.lamp', isBlock(-7, 79, -70, 'redstone_lamp'), String(blockAt(-7, 79, -70)?.name))
  check('E.lever', isBlock(0, 79, -70, 'lever'), String(blockAt(0, 79, -70)?.name))
  check('E.repeater', isBlock(2, 79, -70, 'repeater'), String(blockAt(2, 79, -70)?.name))
  check('E.comparator', isBlock(4, 79, -70, 'comparator'), String(blockAt(4, 79, -70)?.name))
  check('E.observer', isBlock(11, 79, -70, 'observer'), String(blockAt(11, 79, -70)?.name))
  check('E.piston', isBlock(12, 79, -70, 'piston'), String(blockAt(12, 79, -70)?.name))
  check('E.sticky', isBlock(16, 79, -70, 'sticky_piston'), String(blockAt(16, 79, -70)?.name))
  check('E.button', isBlock(10, 79, -70, 'stone_button'), String(blockAt(10, 79, -70)?.name))
  await moveVerifier(5, 81, -55)
  check('E.adder_fixture_lamp', isBlock(2, 79, -50, 'redstone_lamp'), String(blockAt(2, 79, -50)?.name))
}
const checksF = async () => {
  await moveVerifier(167, 81, 7)
  check('F.lava_lake', isBlock(167, 78, 7, 'lava'), String(blockAt(167, 78, 7)?.name))
  check('F.stepping_stone', isBlock(167, 79, 7, 'smooth_stone'), String(blockAt(167, 79, 7)?.name))
  await moveVerifier(182, 81, 7)
  check('F.water', isBlock(182, 79, 7, 'water'), String(blockAt(182, 79, 7)?.name))
  await moveVerifier(206, 81, 22)
  check('F.fire', isBlock(206, 81, 22, 'fire'), String(blockAt(206, 81, 22)?.name))
  check('F.passage', isBlock(205, 81, 5, 'air') && isBlock(205, 81, 4, 'stone_bricks'), String(blockAt(205, 81, 4)?.name))
}
const checksMobs = async () => {
  await moveVerifier(3, 90, 5) // stand at upper cage (3F)
  const hostiles = Object.values(bot.entities).filter((e) => e.type === 'hostile')
  check('mobs.caged_visible', hostiles.length >= 2, 'hostiles: ' + hostiles.map((e) => e.name).join(','))
  await moveVerifier(16, 81, -4) // animal pen
  const animals = Object.values(bot.entities).filter((e) => ['cow', 'sheep', 'pig', 'chicken'].includes(e.name))
  check('mobs.animals_visible', animals.length >= 2, 'animals: ' + animals.map((e) => e.name).join(','))
}

bot.once('spawn', async () => {
  console.log('VERIFY_SPAWNED v=' + bot.version, bot.entity.position.floored())
  const map = { A: checksA, B: checksB, C: checksC, D: checksD, E: checksE, F: checksF, mobs: checksMobs }
  const list = what === 'all' ? ['A', 'B', 'C', 'D', 'E', 'F', 'mobs'] : [what]
  for (const k of list) {
    console.log(`\n--- Area ${k} ---`)
    try { await map[k]() } catch (e) { check(k + '.error', false, e.message) }
  }
  const pass = results.filter((r) => r.ok).length
  console.log(`\nVERIFY TOTAL: ${pass}/${results.length} passed`)
  fs.appendFileSync(path.join(__dirname, '..', 'reports', 'verify-world.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), what, results }) + '\n')
  bot.quit()
  setTimeout(() => process.exit(0), 500)
})
