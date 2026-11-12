/**
 * Combat arena spawner — Area C (x -140..-60, z -30..30, floor y=79, stand y=80).
 * Scenarios (each returns the summoned list so the runner can measure kills):
 *   1    single zombie at (-100,80,0)
 *   2    zombie + skeleton at (-95,80,±4)
 *   3    3 zombies cluster
 *   4    2 skeletons (ranged focus)
 *   5    1 creeper (fuse/flight test)
 *   1 mixed 5 mobs spread
 *   2 hord
 *   6    mixed horde (8) around the arena
 *   witch  2 witches in the corridor mouth
 *   elite  a zombie villager + 2 zombies
 *   clean  kill everything in Area C
 * Usage: node spawn_combat.js <scenario>
 * Mobs are named "Arena <n>" so kills are attributable.
 */
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const Y = Number(process.env.STAND_Y || 80)
const sc = process.argv[2] || '1'

function S (type, x, z, extra = '') {
  return `summon minecraft:${type} ${x} ${Y} ${z} {CustomName:'"Arena ${type}"',NoAI:false}${extra ? ',' + extra : ''}`
}
const ARENA = {
  '1': [S('zombie', -100, 0)],
  '2': [S('zombie', -95, 0), S('skeleton', -95, 5)],
  '3': [S('zombie', -100, -3), S('zombie', -98, 2), S('zombie', -102, 4)],
  '4': [S('skeleton', -95, -4), S('skeleton', -90, 4)],
  '5': [S('creeper', -98, 0)],
  '6': [S('zombie', -105, -6), S('zombie', -100, -10), S('zombie', -95, -6), S('skeleton', -105, 6), S('skeleton', -95, 8), S('creeper', -100, 2), S('spider', -108, 0), S('zombie', -90, -12)],
  witch: [S('witch', -130, -2), S('witch', -128, 2)],
  elite: [S('zombie_villager', -100, 0), S('zombie', -98, -4), S('zombie', -102, 4)]
}
const CLEAN = [`kill @e[type=monster,x=-142,y=74,z=-32,dx=84,dy=14,dz=64]`]

let cmds = CLEAN.concat(ARENA[sc] || [])
const name = 'combat_' + sc
const file = path.join(__dirname, '..', 'scenarios', name + '.txt')
fs.writeFileSync(file, ['forceload add -142 -32 -60 32', ...cmds, 'forceload remove -142 -32 -60 32'].join('\n') + '\n')
const r = spawnSync('node', [path.join(__dirname, 'rcon-batch.js'), file], { encoding: 'utf8', timeout: 120000 })
console.log((r.stdout || '').trim())
console.log('spawned:', (ARENA[sc] || []).length, 'mobs, scenario', sc)
