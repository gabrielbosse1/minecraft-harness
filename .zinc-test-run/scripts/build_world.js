/**
 * World builder for the isolated test server. Emits RCON batch files per area,
 * runs them, and writes an authoritative record of what was built (structure +
 * inventories) to reports/WORLD_GROUND_TRUTH.json.
 *
 * Floor convention: top solid floor block at y=79 => entities stand at y=80.
 * All coordinates are absolute. Origin/base is the 3-floor house near (0,*,0).
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const BATCH = path.join(__dirname, 'rcon-batch.js')
const OUT = path.join(ROOT, 'scenarios')
fs.mkdirSync(OUT, { recursive: true })

const FLOOR = Number(process.env.WORLD_FLOOR || 79) // top solid floor block
const STOOD = FLOOR + 1   // entity feet y

const groundTruth = {
  generated_at: new Date().toISOString(),
  version: '26.3', seed: 20261112,
  floor_y: FLOOR, stand_y: STOOD,
  spawn: { x: 0, y: STOOD, z: 11 },
  areas: {}
}

// ------------------------------------------------------------------ helpers
function box (x0, y0, z0, x1, y1, z1) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1),
    Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)]
}
const MAX_FILL = 25000 // stay well under the 32768 command limit
function fillCmd (b, block) {
  // split large fills into sub-boxes along the longest axis
  const [x0, y0, z0, x1, y1, z1] = b
  const n = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1)
  if (n <= MAX_FILL) return [`fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} ${block} replace`]
  const cmds = []
  const dims = [[x1 - x0 + 1, 0], [y1 - y0 + 1, 1], [z1 - z0 + 1, 2]].sort((a, b) => b[0] - a[0])
  const [size, axis] = dims[0]
  const part = Math.max(1, Math.floor(size / Math.ceil(Math.cbrt(n / MAX_FILL))))
  let a = axis === 0 ? x0 : axis === 1 ? y0 : z0
  let bEnd = axis === 0 ? x1 : axis === 1 ? y1 : z1
  while (a <= bEnd) {
    const aEnd = Math.min(a + part - 1, bEnd)
    const nb = box(
      axis === 0 ? a : x0, axis === 1 ? a : y0, axis === 2 ? a : z0,
      axis === 0 ? aEnd : x1, axis === 1 ? aEnd : y1, axis === 2 ? aEnd : z1)
    cmds.push(fillCmd(nb, block))
    a = aEnd + 1
  }
  return cmds
}
function slab (b, block, half = 'bottom') { return `fill ${b[0]} ${b[1]} ${b[2]} ${b[3]} ${b[4]} ${b[5]} ${block}[half=${half}] replace` }
function air (b) { return fillCmd(b, 'air') }
function setBlock (x, y, z, block) { return `setblock ${x} ${y} ${z} ${block}` }
function chestWith (x, y, z, items) {
  // items: array of [item, count, slot]
  const slotList = items.map(([it, c, s]) => `{Slot:${s}b,id:"minecraft:${it}",count:${c}}`).join(',')
  return [
    setBlock(x, y, z, 'chest'),
    `data merge block ${x} ${y} ${z} {Items:[${slotList}]}`
  ]
}
function esc (t) { return String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 24) }
function sign (x, y, z, text) {
  // 26.3 sign text: front_text.messages[0..3]
  return `setblock ${x} ${y} ${z} cherry_sign{front_text:{messages:["${esc(text)}","","",""],color:"black"}}`
}
function hangingSign (x, y, z, text) {
  return `setblock ${x} ${y} ${z} cherry_hanging_sign{front_text:{messages:["${esc(text)}","","",""],color:"black"}}`
}
// y = the SURFACE (solid top) block. The feature is placed in the air above it.
function tree (x, surfaceY, z, feature = 'cherry') {
  return [
    `setblock ${x} ${surfaceY} ${z} grass_block`,
    `setblock ${x} ${surfaceY + 1} ${z} air`,
    `place feature minecraft:${feature} ${x} ${surfaceY + 1} ${z}`
  ]
}
function slabFloor (x0, x1, z0, z1, y, block) { return fillCmd(box(x0, y, z0, x1, y, z1), block) }
function slabWalls (x0, x1, z0, z1, y0, y1, block) {
  // hollow box walls: 4 walls, keep interior air
  const c = []
  c.push(fillCmd(box(x0, y0, z0, x1, y1, z0), block)) // north wall
  c.push(fillCmd(box(x0, y0, z1, x1, y1, z1), block)) // south wall
  c.push(fillCmd(box(x0, y0, z0, x0, y1, z1), block)) // west wall
  c.push(fillCmd(box(x1, y0, z0, x1, y1, z1), block)) // east wall
  return c
}
function roof (x0, x1, z0, z1, y, block) { return fillCmd(box(x0, y, z0, x1, y, z1), block) }

// ------------------------------------------------------------------ runner
function runBatch (name, commands, { forceload = null, note = '' } = {}) {
  const file = path.join(OUT, name + '.txt')
  const flat = commands.flat(Infinity)
  let lines = []
  if (forceload) {
    lines.push(`forceload add ${forceload[0]} ${forceload[1]} ${forceload[2]} ${forceload[3]}`)
    lines.push('# sleep 12000') // let the forced chunks generate before mutating them (rcon-batch also retries not-loaded)
  }
  lines.push(...flat)
  if (forceload && name.endsWith('_keep')) lines.push(`# keep forceload: ${forceload.join(' ')}`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  console.log(`\n=== ${name}: ${commands.length} cmds (forceload ${forceload ? forceload.join(' ') : 'none'}) ===`)
  const r = spawnSync('node', [BATCH, file], { encoding: 'utf8', timeout: 1500000 })
  process.stdout.write(r.stdout || '')
  if (r.status !== 0) {
    console.log(`!! ${name} had failures — see ${file}.out`)
  }
  return r.status
}

function releaseForceload (f) { runBatch('release_' + f.join('_').replace(/[^0-9]/g, ''), [`forceload remove ${f[0]} ${f[1]} ${f[2]} ${f[3]}`]) }

// ================================================================== AREA A
function buildAreaA () {
  const cmds = []
  const gt = { name: 'Main base (3-floor cherry house)', center: [0, 0], floor_y: FLOOR }
  const x0 = -10, x1 = 10, z0 = -8, z1 = 8
  // level the ground under the house: fill from y=60 to FLOOR with cherry_planks, top at FLOOR
  cmds.push(fillCmd(box(x0 - 2, 60, z0 - 2, x1 + 2, FLOOR, z1 + 2), 'cherry_planks'))
  // ---- 3 floors (floors at 79, 83, 87; roof at 91) ----
  const f1y = FLOOR            // 79 -> stand 80
  const f2y = FLOOR + 4        // 83 -> stand 84
  const f3y = FLOOR + 8        // 87 -> stand 88
  const roofY = FLOOR + 12     // 91
  // floor 2 (slab solid) and floor 3
  cmds.push(fillCmd(box(x0, f2y, z0, x1, f2y, z1), 'cherry_slab[half=bottom]'))
  cmds.push(fillCmd(box(x0, f3y, z0, x1, f3y, z1), 'cherry_slab[half=bottom]'))
  // walls per floor (2 blocks tall each): interior air
  for (const [baseY, topY] of [[f1y + 1, f2y - 1], [f2y + 1, f3y - 1], [f3y + 1, roofY - 1]]) {
    cmds.push(...slabWalls(x0, x1, z0, z1, baseY, topY, 'cherry_planks'))
  }
  // roof
  cmds.push(roof(x0, x1, z0, z1, roofY, 'cherry_slab[half=bottom]'))
  // ---- interior rooms (carve air, add walls to separate) ----
  // 1F (stand y=80): divide into rooms with a wall at z=0 and x=0
  cmds.push(air(box(x0 + 1, f1y + 1, z0 + 1, x1 - 1, f2y - 1, z1 - 1)))
  // interior partition walls (1F): x=0 wall (z -7..-1), z=0 wall (x 1..9)
  cmds.push(fillCmd(box(0, f1y + 1, z0 + 1, 0, f2y - 1, -1), 'cherry_planks'))
  cmds.push(fillCmd(box(1, f1y + 1, 0, x1 - 1, f2y - 1, 0), 'cherry_planks'))
  // 2F rooms
  cmds.push(air(box(x0 + 1, f2y + 1, z0 + 1, x1 - 1, f3y - 1, z1 - 1)))
  cmds.push(fillCmd(box(0, f2y + 1, z0 + 1, 0, f3y - 1, z1 - 1), 'cherry_planks'))
  // 3F rooms
  cmds.push(air(box(x0 + 1, f3y + 1, z0 + 1, x1 - 1, roofY - 1, z1 - 1)))
  // doors (1F south wall entrance at x=0,z=8; stair up at x=2)
  cmds.push(setBlock(0, f1y + 1, z1, 'cherry_door'))
  cmds.push(setBlock(0, f1y + 2, z1, 'cherry_door[facing=south,hinge=left,open=false]'))
  // stairs up to 2F at x=9,z=7 ; 2F->3F at x=9,z=7
  for (let i = 0; i < 4; i++) cmds.push(setBlock(9, f1y + 1 + i, 7, `cherry_stairs[facing=east,shape=straight,half=${i < 2 ? 'bottom' : 'top'}]`))
  for (let i = 0; i < 4; i++) cmds.push(setBlock(-9, f2y + 1 + i, -7, `cherry_stairs[facing=west,shape=straight,half=${i < 2 ? 'bottom' : 'top'}]`))
  // torches for light
  for (const [tx, ty, tz] of [[-9, f1y + 2, -7], [9, f1y + 2, -7], [-9, f2y + 2, 7], [9, f2y + 2, 7], [-9, f3y + 2, 7], [9, f3y + 2, -7]]) cmds.push(setBlock(tx, ty, tz, 'torch'))

  // ---- 1F storage (east room, x 1..9, z 1..7): chest grid with signs ----
  const chests1F = [
    { x: 3, z: 3, label: 'Ferramentas', items: [['wooden_pickaxe', 1, 0], ['stone_pickaxe', 1, 1], ['iron_pickaxe', 1, 2], ['iron_axe', 1, 3], ['iron_sword', 1, 4], ['shield', 1, 5], ['bow', 1, 6], ['arrow', 32, 7]] },
    { x: 5, z: 3, label: 'Minerios', items: [['coal', 64, 0], ['iron_ingot', 32, 1], ['gold_ingot', 16, 2], ['diamond', 8, 3], ['redstone', 64, 4]] },
    { x: 7, z: 3, label: 'Comida', items: [['bread', 16, 0], ['apple', 16, 1], ['cooked_beef', 16, 2], ['cooked_porkchop', 16, 3], ['golden_apple', 2, 4], ['wheat', 32, 5]] },
    { x: 3, z: 5, label: 'Construcao', items: [['cherry_planks', 64, 0], ['cherry_log', 32, 1], ['stone_bricks', 64, 2], ['glass', 32, 3], ['torch', 64, 4], ['stick', 64, 5]] },
    { x: 5, z: 5, label: 'Valioso', items: [['diamond', 32, 0], ['emerald', 16, 1], ['netherite_ingot', 2, 2], ['obsidian', 8, 3]] },
    { x: 7, z: 5, label: 'Cultura', items: [['wheat_seeds', 64, 0], ['carrot', 32, 1], ['potato', 32, 2], ['beetroot_seeds', 16, 3], ['oak_sapling', 8, 4]] }
  ]
  for (const c of chests1F) {
    cmds.push(...chestWith(c.x, f1y, c.z, c.items))
    cmds.push(sign(c.x, f1y + 1, c.z - 1, c.label))
  }
  // 1F kitchen (west room x -9..-1, z 1..7): furnaces + crafting table
  for (const fx of [-7, -5, -3]) cmds.push(setBlock(fx, f1y, 1, 'furnace'))
  cmds.push(setBlock(-3, f1y, 5, 'crafting_table'))
  cmds.push(sign(-5, f1y + 1, 0, 'Cozinha'))
  // ---- 2F (stand y=84): bedroom west, study east, brewing ----
  cmds.push(setBlock(-7, f2y, -5, 'red_bed[facing=west]'))
  cmds.push(setBlock(-7, f2y, 4, 'enchanting_table'))
  cmds.push(setBlock(-5, f2y, 4, 'grindstone'))
  cmds.push(setBlock(5, f2y, -5, 'brewing_stand'))
  cmds.push(sign(-5, f2y + 1, 0, 'Quarto'))
  cmds.push(sign(5, f2y + 1, 0, 'Estudo'))
  // 2F storage chest
  cmds.push(...chestWith(8, f2y, 7, [['emerald', 8, 0], ['gold_ingot', 16, 1]]))
  cmds.push(sign(8, f2y + 1, 6, 'Reserva'))
  // ---- 3F (stand y=88): observation + hostile mob cage ----
  // hostile mob cage: iron bars room x 1..5, z 4..7 at 3F
  const cageX0 = 1, cageX1 = 5, cageZ0 = 4, cageZ1 = 7, cageY0 = f3y + 1, cageY1 = f3y + 3
  cmds.push(fillCmd(box(cageX0, cageY0, cageZ0, cageX1, cageY0, cageZ1), 'iron_bars')) // floor bars
  cmds.push(fillCmd(box(cageX0, cageY1, cageZ0, cageX1, cageY1, cageZ1), 'iron_bars')) // top
  cmds.push(fillCmd(box(cageX0, cageY0, cageZ0, cageX1, cageY1, cageZ0), 'iron_bars'))
  cmds.push(fillCmd(box(cageX0, cageY0, cageZ1, cageX1, cageY1, cageZ1), 'iron_bars'))
  cmds.push(fillCmd(box(cageX0, cageY0, cageZ0, cageX0, cageY1, cageZ1), 'iron_bars'))
  cmds.push(fillCmd(box(cageX1, cageY0, cageZ0, cageX1, cageY1, cageZ1), 'iron_bars'))
  cmds.push(air(box(cageX0 + 1, cageY0, cageZ0 + 1, cageX1 - 1, cageY1, cageZ1 - 1)))
  cmds.push(sign(3, f3y + 1, cageZ0 - 1, 'Mobs (caixa)'))
  // 3F chest
  cmds.push(...chestWith(-8, f3y, -7, [['diamond', 16, 0], ['obsidian', 16, 1]]))
  cmds.push(sign(-8, f3y + 1, -6, 'Cofre'))

  // ---- animal pen (east of house, x 12..20, z -8..0) ----
  const penX0 = 12, penX1 = 20, penZ0 = -8, penZ1 = 0
  cmds.push(fillCmd(box(penX0 - 1, 60, penZ0 - 1, penX1 + 1, FLOOR, penZ1 + 1), 'grass_block'))
  cmds.push(...slabWalls(penX0, penX1, penZ0, penZ1, FLOOR + 1, FLOOR + 2, 'oak_fence'))
  cmds.push(air(box(penX0, FLOOR + 1, penZ0, penX1, FLOOR + 3, penZ1)))
  cmds.push(sign(penX0 + 1, FLOOR + 1, penZ1 + 1, 'Curral'))

  // ---- hostile mob cage at ground level (behind iron bars) near pen ----
  const gCageX0 = 22, gCageX1 = 25, gCageZ0 = -8, gCageZ1 = -5, gCageY0 = FLOOR + 1, gCageY1 = FLOOR + 2
  cmds.push(fillCmd(box(gCageX0 - 1, 60, gCageZ0 - 1, gCageX1 + 1, FLOOR, gCageZ1 + 1), 'stone_bricks'))
  cmds.push(fillCmd(box(gCageX0, gCageY1, gCageZ0, gCageX1, gCageY1, gCageZ1), 'iron_bars'))
  cmds.push(fillCmd(box(gCageX0, gCageY0, gCageZ0, gCageX1, gCageY1, gCageZ0), 'iron_bars'))
  cmds.push(fillCmd(box(gCageX0, gCageY0, gCageZ1, gCageX1, gCageY1, gCageZ1), 'iron_bars'))
  cmds.push(fillCmd(box(gCageX0, gCageY0, gCageZ0, gCageX0, gCageY1, gCageZ1), 'iron_bars'))
  cmds.push(fillCmd(box(gCageX1, gCageY0, gCageZ0, gCageX1, gCageY1, gCageZ1), 'iron_bars'))
  cmds.push(air(box(gCageX0, gCageY0, gCageZ0, gCageX1, gCageY1, gCageZ1)))
  cmds.push(sign(gCageX0 + 1, FLOOR + 1, gCageZ1 + 1, 'Mobs (chao)'))

  // trees on the platform ring (x ±11..12, z inside the platform but outside the house walls)
  for (const [tx, tz] of [[12, 6], [12, -4], [11, 2], [-12, 5], [-12, -5], [-11, 3]]) cmds.push(...tree(tx, FLOOR, tz, 'cherry'))

  const areaGt = {
    house: { x0, x1, z0, z1, floors: [{ stand: f1y + 1 }, { stand: f2y + 1 }, { stand: f3y + 1 }], roof: roofY, material: 'cherry_planks' },
    chests: chests1F.map((c) => ({ pos: [c.x, f1y, c.z], label: c.label, items: c.items.map(([it, cnt]) => ({ item: it, count: cnt })) })),
    kitchen: { furnaces: [[-7, f1y, 1], [-5, f1y, 1], [-3, f1y, 1]], crafting_table: [-3, f1y, 5] },
    study: { enchanting_table: [-7, f2y, 4], grindstone: [-5, f2y, 4], brewing_stand: [5, f2y, -5] },
    bed: [-7, f2y, -5],
    animal_pen: { x0: penX0, x1: penX1, z0: penZ0, z1: penZ1, fence: 'oak_fence' },
    mob_cages: {
      upper: { x0: cageX0, x1: cageX1, z0: cageZ0, z1: cageZ1, y: [cageY0, cageY1], bars: 'iron_bars' },
      ground: { x0: gCageX0, x1: gCageX1, z0: gCageZ0, z1: gCageZ1, y: [gCageY0, gCageY1], bars: 'iron_bars' }
    },
    signs: ['Ferramentas', 'Minerios', 'Comida', 'Construcao', 'Valioso', 'Cultura', 'Cozinha', 'Quarto', 'Estudo', 'Reserva', 'Mobs (caixa)', 'Mobs (chao)', 'Curral', 'Cofre']
  }
  groundTruth.areas.A = areaGt
  // forceload takes CHUNK coords: house blocks x -16..16, z -12..14 -> chunks -1..0, -1..0
  return { cmds, areaGt, forceload: [-1, -1, 0, 0], keep: true, label: 'AreaA_base' }
}

// ================================================================== AREA B
function buildAreaB () {
  const cmds = []
  // east: x 40..140, z -20..60
  // level a plateau for forest/plains at FLOOR
  cmds.push(fillCmd(box(40, 60, -20, 140, FLOOR, 60), 'grass_block'))
  // pond (water) x 100..120 z 40..60: dig 1 deep and fill water
  cmds.push(fillCmd(box(100, FLOOR - 1, 40, 120, FLOOR - 1, 60), 'water'))
  cmds.push(fillCmd(box(100, FLOOR, 40, 120, FLOOR, 60), 'air'))
  // hills: raised plateau x 40..70 z -20..10 up to FLOOR+3
  cmds.push(fillCmd(box(40, FLOOR + 1, -20, 70, FLOOR + 3, 10), 'grass_block'))
  // forest: cherry + oak trees
  for (const [tx, tz] of [[44, 20], [50, 25], [56, 18], [62, 30], [70, 22], [48, 40], [60, 45], [75, 35], [80, 20], [85, 40]]) cmds.push(...tree(tx, FLOOR, tz, 'cherry'))
  for (const [tx, tz] of [[45, 30], [55, 35], [65, 40], [72, 15], [82, 28]]) cmds.push(...tree(tx, FLOOR, tz, 'oak'))
  // small cave: dig a pocket at x 90..96 z 10..16 under FLOOR
  cmds.push(air(box(90, FLOOR - 3, 10, 96, FLOOR - 1, 16)))
  cmds.push(fillCmd(box(90, FLOOR - 4, 10, 96, FLOOR - 4, 16), 'dirt'))
  // exposed surface ores
  const oreSpots = [
    [90, FLOOR, 30, 'coal_ore'], [92, FLOOR, 32, 'iron_ore'], [94, FLOOR, 34, 'coal_ore'],
    [96, FLOOR, 36, 'gold_ore'], [98, FLOOR, 38, 'iron_ore'], [104, FLOOR, 10, 'diamond_ore'],
    [106, FLOOR, 12, 'diamond_ore'], [108, FLOOR, 14, 'coal_ore']
  ]
  for (const [x, y, z, ore] of oreSpots) cmds.push(setBlock(x, y, z, ore))
  // controlled lava exposure: a small lava pool at x 130..134 z 10..14 (bordered by obsidian)
  cmds.push(fillCmd(box(129, FLOOR - 1, 9, 135, FLOOR - 1, 15), 'obsidian'))
  cmds.push(fillCmd(box(130, FLOOR - 1, 10, 134, FLOOR - 1, 14), 'lava'))
  cmds.push(fillCmd(box(130, FLOOR, 10, 134, FLOOR, 14), 'air'))
  // return route: a straight clear path from base (x=11) to the forest area
  cmds.push(fillCmd(box(11, FLOOR, 2, 140, FLOOR, 2), 'dirt_path'))

  const areaGt = {
    plateau: [40, 140, -20, 60], floor_y: FLOOR,
    pond: { x0: 100, x1: 120, z0: 40, z1: 60 },
    hills: { x0: 40, x1: 70, z0: -20, z1: 10, top: FLOOR + 3 },
    forest_trees: { cherry: [[44, 20], [50, 25], [56, 18], [62, 30], [70, 22], [48, 40], [60, 45], [75, 35], [80, 20], [85, 40]], oak: [[45, 30], [55, 35], [65, 40], [72, 15], [82, 28]] },
    cave: { x0: 90, x1: 96, z0: 10, z1: 16, y: [FLOOR - 3, FLOOR - 1] },
    surface_ores: oreSpots.map(([x, y, z, ore]) => ({ pos: [x, y, z], ore })),
    lava_pool: { x0: 130, x1: 134, z0: 10, z1: 14, bordered: 'obsidian' },
    return_path: { from: [11, FLOOR, 2], to: [140, FLOOR, 2] }
  }
  groundTruth.areas.B = areaGt
  // blocks x 40..140 z -20..60 -> chunks x 2..8, z -2..3
  return { cmds, forceload: [2, -2, 8, 3], keep: false, label: 'AreaB_gathering' }
}

// ================================================================== AREA C
function buildAreaC () {
  const cmds = []
  // west: x -140..-60, z -30..30. Flat arena.
  cmds.push(fillCmd(box(-140, 60, -30, -60, FLOOR, 30), 'stone_bricks'))
  // open central arena x -110..-80 z -10..10
  // obstacles: pillars
  for (const [px, pz] of [[-100, -5], [-90, 5], [-95, 0], [-105, 8], [-85, -8]]) {
    cmds.push(fillCmd(box(px, FLOOR + 1, pz, px, FLOOR + 3, pz), 'stone_bricks'))
  }
  // narrow corridor: a 1-wide tunnel x -135..-125 at z=0, walls on both sides
  cmds.push(fillCmd(box(-135, FLOOR + 1, -1, -125, FLOOR + 3, -1), 'stone_bricks'))
  cmds.push(fillCmd(box(-135, FLOOR + 1, 1, -125, FLOOR + 3, 1), 'stone_bricks'))
  cmds.push(air(box(-135, FLOOR + 1, 0, -125, FLOOR + 3, 0)))
  // elevated platform x -130..-120 z 15..25 at FLOOR+2 (2 blocks up)
  cmds.push(fillCmd(box(-130, FLOOR + 1, 15, -120, FLOOR + 1, 25), 'stone_bricks'))
  cmds.push(fillCmd(box(-130, FLOOR + 2, 15, -120, FLOOR + 2, 25), 'stone_bricks'))
  cmds.push(air(box(-130, FLOOR + 3, 15, -120, FLOOR + 5, 25)))
  // staircase to platform at x -121, z 18..22
  for (let i = 0; i < 2; i++) cmds.push(setBlock(-121 + i, FLOOR + 1 + i, 20, 'stone_bricks'))
  // walls for escape-route testing (L-shaped wall)
  cmds.push(fillCmd(box(-70, FLOOR + 1, -20, -70, FLOOR + 3, 0), 'stone_bricks'))
  cmds.push(fillCmd(box(-90, FLOOR + 1, 20, -70, FLOOR + 3, 20), 'stone_bricks'))
  // a safe spawn/return point
  cmds.push(fillCmd(box(-115, FLOOR + 1, -25, -111, FLOOR + 1, -25), 'lime_concrete'))

  const areaGt = {
    arena: { x0: -140, x1: -60, z0: -30, z1: 30, floor_y: FLOOR },
    obstacles: [[-100, -5], [-90, 5], [-95, 0], [-105, 8], [-85, -8]].map(([x, z]) => [x, z, FLOOR + 1, FLOOR + 3]),
    corridor: { x0: -135, x1: -125, z: 0, width: 1 },
    platform: { x0: -130, x1: -120, z0: 15, z1: 25, y: FLOOR + 2 },
    safe_point: [-113, FLOOR + 2, -25]
  }
  groundTruth.areas.C = areaGt
  // 26.1 forceload takes BLOCK coords (floored to chunks): blocks x -140..-60 z -30..30
  return { cmds, forceload: [-140, -30, -60, 30], keep: false, label: 'AreaC_combat' }
}

// ================================================================== AREA D
function buildAreaD () {
  const cmds = []
  // south: x -30..30, z 60..120. Flat build pad.
  cmds.push(fillCmd(box(-30, 60, 60, 30, FLOOR, 120), 'dirt'))
  cmds.push(fillCmd(box(-30, FLOOR, 60, 30, FLOOR, 120), 'grass_block'))
  // resource depot: a fenced store with building blocks at x -28..-20, z 62..68
  const depX0 = -28, depX1 = -20, depZ0 = 62, depZ1 = 68
  cmds.push(fillCmd(box(depX0, FLOOR + 1, depZ0, depX1, FLOOR + 1, depZ1), 'stone_bricks'))
  cmds.push(...slabWalls(depX0, depX1, depZ0, depZ1, FLOOR + 2, FLOOR + 4, 'oak_planks'))
  cmds.push(air(box(depX0 + 1, FLOOR + 2, depZ0 + 1, depX1 - 1, FLOOR + 4, depZ1 - 1)))
  // depot chests with building materials
  const depot = [
    { x: -26, z: 64, items: [['oak_planks', 64, 0], ['oak_log', 64, 1], ['spruce_planks', 64, 2], ['birch_planks', 64, 3]] },
    { x: -24, z: 64, items: [['stone_bricks', 64, 0], ['cobblestone', 64, 1], ['smooth_stone', 64, 2], ['sandstone', 64, 3]] },
    { x: -22, z: 64, items: [['glass', 64, 0], ['iron_bars', 32, 1], ['oak_fence', 64, 2], ['oak_slab', 64, 3], ['oak_stairs', 64, 4]] },
    { x: -26, z: 66, items: [['torch', 64, 0], ['lantern', 32, 1], ['cherry_planks', 64, 2], ['oak_trapdoor', 16, 3]] },
    { x: -24, z: 66, items: [['bricks', 64, 0], ['stone', 64, 1], ['dirt', 64, 2], ['gravel', 64, 3]] }
  ]
  for (const c of depot) cmds.push(...chestWith(c.x, FLOOR + 1, c.z, c.items))
  cmds.push(sign(-24, FLOOR + 1, depZ0 - 1, 'Materiais'))
  // redstone supply for building a redstone door (Area D objective)
  cmds.push(...chestWith(-22, FLOOR + 1, 66, [['redstone', 64, 0], ['repeater', 16, 1], ['piston', 8, 2], ['lever', 8, 3], ['sticky_piston', 4, 4], ['redstone_torch', 16, 5]]))

  const areaGt = {
    build_pad: { x0: -30, x1: 30, z0: 60, z1: 120, floor_y: FLOOR },
    depot: { x0: depX0, x1: depX1, z0: depZ0, z1: depZ1, chests: depot.map((c) => ({ pos: [c.x, FLOOR + 1, c.z], items: c.items.map(([it, n]) => ({ item: it, count: n })) })) },
    redstone_door_supplies: { pos: [-22, FLOOR + 1, 66] }
  }
  groundTruth.areas.D = areaGt
  // blocks x -30..30 z 60..120 -> chunks x -2..1, z 3..7
  return { cmds, forceload: [-2, 3, 1, 7], keep: false, label: 'AreaD_building' }
}

// ================================================================== AREA E
function buildAreaE () {
  const cmds = []
  // north: x -30..30, z -80..-40. Redstone lab floor.
  cmds.push(fillCmd(box(-30, 60, -80, 30, FLOOR, -40), 'smooth_quartz'))
  // lab bench (a table with redstone components)
  cmds.push(fillCmd(box(0, FLOOR + 1, -60, 8, FLOOR + 1, -55), 'crafting_table'))
  // --- a simple powered line: torch -> dust -> lamp ---
  cmds.push(setBlock(-10, FLOOR, -70, 'redstone_torch'))
  cmds.push(setBlock(-9, FLOOR, -70, 'redstone_wire'))
  cmds.push(setBlock(-8, FLOOR, -70, 'redstone_wire'))
  cmds.push(setBlock(-7, FLOOR, -70, 'redstone_lamp'))
  // --- repeater + comparator demo ---
  cmds.push(setBlock(0, FLOOR, -70, 'lever'))
  cmds.push(setBlock(1, FLOOR, -70, 'redstone_wire'))
  cmds.push(setBlock(2, FLOOR, -70, 'repeater'))
  cmds.push(setBlock(3, FLOOR, -70, 'redstone_wire'))
  cmds.push(setBlock(4, FLOOR, -70, 'comparator'))
  cmds.push(setBlock(5, FLOOR, -70, 'redstone_lamp'))
  // --- observer + piston (a small auto-door) ---
  cmds.push(setBlock(10, FLOOR, -70, 'stone_button'))
  cmds.push(setBlock(11, FLOOR, -70, 'observer'))
  cmds.push(setBlock(12, FLOOR, -70, 'piston'))
  // --- sticky piston pusher ---
  cmds.push(setBlock(14, FLOOR, -70, 'lever'))
  cmds.push(setBlock(15, FLOOR, -70, 'redstone_wire'))
  cmds.push(setBlock(16, FLOOR, -70, 'sticky_piston'))
  // --- AND gate (two inputs -> one output lamp) ---
  cmds.push(setBlock(0, FLOOR, -60, 'lever'))
  cmds.push(setBlock(1, FLOOR, -60, 'redstone_wire'))
  cmds.push(setBlock(2, FLOOR, -60, 'redstone_torch')) // inverter for AND
  cmds.push(setBlock(0, FLOOR, -58, 'lever'))
  cmds.push(setBlock(1, FLOOR, -58, 'redstone_wire'))
  cmds.push(setBlock(2, FLOOR, -58, 'redstone_torch'))
  cmds.push(setBlock(3, FLOOR, -59, 'redstone_wire'))
  cmds.push(setBlock(4, FLOOR, -59, 'redstone_wire'))
  cmds.push(setBlock(5, FLOOR, -59, 'redstone_lamp'))
  // --- binary circuit: a simple 1-bit counter-style toggle (torch gate) ---
  cmds.push(setBlock(10, FLOOR, -60, 'lever'))
  cmds.push(setBlock(11, FLOOR, -60, 'redstone_wire'))
  cmds.push(setBlock(12, FLOOR, -60, 'repeater'))
  cmds.push(setBlock(13, FLOOR, -60, 'redstone_wire'))
  cmds.push(setBlock(14, FLOOR, -60, 'redstone_lamp'))
  // --- 4-bit adder FIXTURE (representative physical layout; abstract test via logic_test) ---
  // A row of 4 full-adder "columns" built from repeaters + lamps as a physical marker.
  for (let i = 0; i < 4; i++) {
    const bx = 0 + i * 3
    cmds.push(setBlock(bx, FLOOR, -50, 'redstone_wire'))
    cmds.push(setBlock(bx + 1, FLOOR, -50, 'repeater'))
    cmds.push(setBlock(bx + 2, FLOOR, -50, 'redstone_lamp'))
  }
  cmds.push(sign(4, FLOOR + 1, -49, 'Adder 4-bit (fixture)'))
  // levers/buttons spread for the model to toggle
  for (const [lx, lz] of [[-14, -70], [-14, -68], [20, -60], [20, -58]]) cmds.push(setBlock(lx, FLOOR, lz, lx % 2 === 0 ? 'lever' : 'stone_button'))

  const areaGt = {
    lab: { x0: -30, x1: 30, z0: -80, z1: -40, floor_y: FLOOR },
    circuits: {
      simple_line: { x: [-10, -7], z: -70, nodes: ['redstone_torch', 'redstone_wire', 'redstone_wire', 'redstone_lamp'] },
      repeater_comparator: { x: [0, 5], z: -70, nodes: ['lever', 'redstone_wire', 'repeater', 'redstone_wire', 'comparator', 'redstone_lamp'] },
      observer_piston: { x: [10, 12], z: -70, nodes: ['stone_button', 'observer', 'piston'] },
      sticky_piston: { x: [14, 16], z: -70, nodes: ['lever', 'redstone_wire', 'sticky_piston'] },
      and_gate: { region: [0, 5, -60, -58], note: 'two levers through inverters into a lamp' },
      binary_circuit: { x: [10, 14], z: -60, nodes: ['lever', 'redstone_wire', 'repeater', 'redstone_wire', 'redstone_lamp'] },
      adder4_fixture: { x: [0, 11], z: -50, note: 'representative physical layout; abstract 4-bit adder tested via logic_test tool' }
    },
    levers_buttons: [[0, -70], [10, -70], [14, -70], [0, -60], [0, -58], [10, -60], [-14, -70], [-14, -68], [20, -60], [20, -58]]
  }
  groundTruth.areas.E = areaGt
  // blocks x -30..30 z -80..-40 -> chunks x -2..1, z -5..-3
  return { cmds, forceload: [-2, -5, 1, -3], keep: false, label: 'AreaE_redstone' }
}

// ================================================================== AREA F
function buildAreaF () {
  const cmds = []
  // far east: x 150..220, z -20..40. Hazard course.
  cmds.push(fillCmd(box(150, 60, -20, 220, FLOOR, 40), 'grass_block'))
  // lava lake with safe stepping stones: x 160..175 z 0..15
  cmds.push(fillCmd(box(160, FLOOR - 1, 0, 175, FLOOR - 1, 15), 'lava'))
  cmds.push(fillCmd(box(160, FLOOR, 0, 175, FLOOR, 15), 'air'))
  // stepping stones across lava
  for (let i = 0; i < 5; i++) cmds.push(setBlock(161 + i * 3, FLOOR, 7, 'smooth_stone'))
  // water channel x 180..185 z 0..15
  cmds.push(fillCmd(box(180, FLOOR - 1, 0, 185, FLOOR - 1, 15), 'water'))
  cmds.push(fillCmd(box(180, FLOOR, 0, 185, FLOOR, 15), 'air'))
  // cliff: a 4-block drop with a safe side x 190..195 z 0..15
  cmds.push(fillCmd(box(190, FLOOR - 3, 0, 195, FLOOR - 1, 15), 'grass_block'))
  cmds.push(fillCmd(box(190, FLOOR, 0, 195, FLOOR, 15), 'air'))
  cmds.push(fillCmd(box(190, FLOOR, 16, 195, FLOOR, 16), 'grass_block')) // safe edge ledge
  // narrow passage: 1-wide gap between walls x 200..210 z 5
  cmds.push(fillCmd(box(200, FLOOR + 1, 4, 210, FLOOR + 3, 4), 'stone_bricks'))
  cmds.push(fillCmd(box(200, FLOOR + 1, 6, 210, FLOOR + 3, 6), 'stone_bricks'))
  cmds.push(air(box(200, FLOOR + 1, 5, 210, FLOOR + 3, 5)))
  // fire patch (controlled): a few fire on a small wood platform x 205 z 20..24
  cmds.push(fillCmd(box(204, FLOOR + 1, 20, 208, FLOOR + 1, 24), 'oak_planks'))
  cmds.push(setBlock(206, FLOOR + 2, 22, 'fire'))
  // dangerous drop: a 6-block ledge with no bottom visible x 215 z 30..34
  cmds.push(fillCmd(box(215, FLOOR + 4, 30, 218, FLOOR + 4, 34), 'stone_bricks'))
  cmds.push(fillCmd(box(215, FLOOR, 30, 218, FLOOR, 34), 'air'))
  cmds.push(fillCmd(box(215, FLOOR + 4, 30, 218, FLOOR + 4, 34), 'stone_bricks'))

  const areaGt = {
    course: { x0: 150, x1: 220, z0: -20, z1: 40, floor_y: FLOOR },
    lava_lake: { x0: 160, x1: 175, z0: 0, z1: 15, stepping_stones: [161, 164, 167, 170, 173].map((x) => [x, FLOOR, 7]) },
    water_channel: { x0: 180, x1: 185, z0: 0, z1: 15 },
    cliff: { x0: 190, x1: 195, z0: 0, z1: 15, drop: 4 },
    narrow_passage: { x0: 200, x1: 210, z: 5, width: 1 },
    fire_patch: { x: 206, y: FLOOR + 2, z: 22 },
    dangerous_drop: { x0: 215, x1: 218, z0: 30, z1: 34, height: 6 }
  }
  groundTruth.areas.F = areaGt
  // blocks x 150..220 z -20..40 -> chunks x 9..13, z -2..2
  return { cmds, forceload: [9, -2, 13, 2], keep: false, label: 'AreaF_hazards' }
}

// ------------------------------------------------------------------ main
function main () {
  const only = (process.argv[2] || '').split('') // e.g. 'A', 'AB', or 'A B F' letters
  const builders = { A: buildAreaA, B: buildAreaB, C: buildAreaC, D: buildAreaD, E: buildAreaE, F: buildAreaF }
  const valid = only.filter((k) => builders[k])
  const order = valid.length ? valid : ['A', 'B', 'C', 'D', 'E', 'F']
  const results = {}
  for (const k of order) {
    const { cmds, forceload, keep, label } = builders[k]()
    const status = runBatch(label, cmds, { forceload })
    results[k] = status === 0 ? 'ok' : 'had_failures'
    if (!keep && forceload) releaseForceload(forceload)
  }
  // set world spawn to a safe interior spot on the 1F floor (east storage room)
  runBatch('spawn', [`tp @a 5 ${STOOD} 5`, `setworldspawn 5 ${STOOD} 5`])
  fs.writeFileSync(path.join(ROOT, 'reports', 'WORLD_GROUND_TRUTH.json'), JSON.stringify(groundTruth, null, 2))
  console.log('\nWORLD BUILD RESULTS:', JSON.stringify(results))
}
main()
