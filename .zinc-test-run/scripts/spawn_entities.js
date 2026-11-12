/**
 * Spawns the controlled entities for the test campaign:
 *  - Area A: animals in the pen, hostile mobs in the cages (3F + ground)
 *  - Area C: combat arena mobs are spawned ON DEMAND by the test runner
 *  - item drops near the base for pickup testing
 * Usage: node spawn_entities.js [clean|animals|mobs|items|all]
 *   'clean' kills every named test mob + test items first.
 */
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const FLOOR = Number(process.env.WORLD_FLOOR || 79)
const y = FLOOR + 1
const args = process.argv.slice(2)
const what = args[0] || 'all'

function batch (name, cmds) {
  const file = path.join(__dirname, '..', 'scenarios', name + '.txt')
  fs.writeFileSync(file, cmds.map((c) => c.trim()).filter(Boolean).join('\n') + '\n')
  const r = spawnSync('node', [path.join(__dirname, 'rcon-batch.js'), file], { encoding: 'utf8', timeout: 120000 })
  console.log(name + ':', (r.stdout || '').trim())
  return r
}

const ANIMALS = [
  `summon minecraft:cow 15 ${y} -4 {CustomName:'"Vaca Teste"'}`,
  `summon minecraft:cow 17 ${y} -6 {CustomName:'"Vaca Teste"'}`,
  `summon minecraft:sheep 14 ${y} -2 {CustomName:'"Ovelha Teste"'}`,
  `summon minecraft:sheep 19 ${y} -3 {CustomName:'"Ovelha Teste"'}`,
  `summon minecraft:chicken 16 ${y} -1 {CustomName:'"Galinha Teste"'}`,
  `summon minecraft:pig 18 ${y} -7 {CustomName:'"Porco Teste"'}`
]
// hostile mobs inside the IRON BAR cages (upper 3F cage x1..5 z4..7 @ y88..90; ground cage x22..25 z-8..-5 @ y80..81)
const CAGED_MOBS = [
  `summon minecraft:zombie 3 89 5 {CustomName:'"Zumbi Exposto"'}`,
  `summon minecraft:skeleton 4 89 6 {CustomName:'"Esqueleto Exposto"'}`,
  `summon minecraft:spider 2 89 6 {CustomName:'"Aranha Exposta"'}`,
  `summon minecraft:zombie 23 81 -6 {CustomName:'"Zumbi Exposto"'}`,
  `summon minecraft:creeper 24 81 -7 {CustomName:'"Creeper Exposto"'}`,
  `summon minecraft:spider 25 81 -8 {CustomName:'"Aranha Exposta"'}`
]
const ITEMS = [
  `summon minecraft:item 1 ${y} 12 {Item:{id:"minecraft:iron_ingot",count:16}}`,
  `summon minecraft:item 2 ${y} 13 {Item:{id:"minecraft:golden_apple",count:3}}`,
  `summon minecraft:item -1 ${y} 12 {Item:{id:"minecraft:diamond",count:4}}`,
  `summon minecraft:item 3 ${y} 13 {Item:{id:"minecraft:bread",count:8}}`,
  `summon minecraft:item 0 ${y} 14 {Item:{id:"minecraft:cherry_log",count:12}}`
]
const CLEAN = [
  // animals in the pen (x 12..20, z -8..0, y 80..84)
  `kill @e[type=cow,x=11,y=79,z=-9,dx=10,dy=6,dz=10]`,
  `kill @e[type=sheep,x=11,y=79,z=-9,dx=10,dy=6,dz=10]`,
  `kill @e[type=chicken,x=11,y=79,z=-9,dx=10,dy=6,dz=10]`,
  `kill @e[type=pig,x=11,y=79,z=-9,dx=10,dy=6,dz=10]`,
  // caged hostiles: upper cage (x1..5 z4..7 y87..91) and ground cage (x22..25 z-8..-5 y79..83)
  `kill @e[type=monster,x=0,y=86,z=3,dx=6,dy=6,dz=6]`,
  `kill @e[type=monster,x=21,y=78,z=-9,dx=5,dy=6,dz=5]`,
  // test item drops near base
  `kill @e[type=item,x=-2,y=79,z=11,dx=6,dy=3,dz=4]`,
  // combat arena reset (Area C bounds x -142..-58, z -32..32)
  `kill @e[type=monster,x=-142,y=75,z=-32,dx=84,dy=12,dz=64]`
]

if (what === 'clean' || what === 'all') batch('spawn_clean', CLEAN)
if (what === 'animals' || what === 'all') batch('spawn_animals', ANIMALS)
if (what === 'mobs' || what === 'all') batch('spawn_caged', CAGED_MOBS)
if (what === 'items' || what === 'all') batch('spawn_items', ITEMS)
console.log('done:', what)
