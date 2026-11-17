#!/usr/bin/env node
'use strict'

/**
 * scripts/render-samples.js — render a small offline scene through the real
 * client resources and write look / panorama / map PNGs for visual review.
 *
 * The scene is synthetic (test/helpers/fake-world.js) so this runs without a
 * Minecraft server. Output defaults to .zinc-test-run/renders/ (git-ignored).
 *
 *   node scripts/render-samples.js [outputDir]
 */

const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const vision = require('../zincai/vision')
const { createFakeWorld } = require('../test/helpers/fake-world')

async function main () {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.zinc-test-run', 'renders'))
  fs.mkdirSync(outDir, { recursive: true })

  const ground = 64
  const world = createFakeWorld({ minX: -12, maxX: 40, minZ: -12, maxZ: 40, groundY: ground })

  // Cherry tree: trunk plus a rounded canopy (corners cut so it reads as a tree).
  const tx = 8
  const tz = 7
  world.fill(tx, ground + 1, tz, tx, ground + 4, tz, 'cherry_log')
  for (let dy = 0; dy <= 4; dy++) {
    const r = dy === 4 ? 1 : dy === 0 ? 2 : 3
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r) continue
        if (dy === 4 && Math.abs(dx) + Math.abs(dz) > 1) continue
        world.set(tx + dx, ground + 5 + dy, tz + dz, 'cherry_leaves')
      }
    }
  }

  // Pond sunk one block into the ground, with a stone rim.
  world.fill(2, ground - 1, 13, 6, ground - 1, 17, 'stone')
  world.fill(2, ground, 13, 6, ground, 17, 'water')
  world.set(2, ground, 12, 'stone_bricks')
  world.set(3, ground, 12, 'stone_bricks')
  world.set(4, ground, 12, 'stone_bricks')
  world.set(5, ground, 12, 'stone_bricks')
  world.set(6, ground, 12, 'stone_bricks')
  world.set(1, ground, 14, 'poppy')
  world.set(1, ground, 15, 'poppy')
  world.set(7, ground, 16, 'dandelion')
  world.set(2, ground, 18, 'azure_bluet')

  // Glass greenhouse: plank frame, glass panes, a real doorway and stairs.
  world.fill(12, ground + 1, 12, 16, ground + 3, 12, 'glass')
  world.fill(12, ground + 1, 12, 12, ground + 3, 16, 'glass')
  world.fill(16, ground + 1, 12, 16, ground + 3, 16, 'glass')
  world.fill(12, ground + 4, 12, 16, ground + 4, 16, 'cherry_planks')
  world.fill(14, ground + 1, 12, 14, ground + 2, 12, 'air')
  world.set(14, ground + 3, 12, 'cherry_planks')
  world.set(13, ground, 12, 'oak_stairs', { facing: 'south' })
  world.set(15, ground, 12, 'oak_stairs', { facing: 'south' })
  world.set(14, ground, 14, 'chest', { facing: 'south' })
  world.set(14, ground + 1, 15, 'lantern')
  world.set(11, ground + 1, 17, 'oak_fence')
  world.set(16, ground + 1, 17, 'oak_fence')

  // Background so the 360° panorama is not an empty plain behind the camera:
  // a grass hill with a stone face, and a second cherry tree.
  for (let x = 16; x <= 24; x++) {
    for (let z = 28; z <= 36; z++) {
      const d = Math.max(Math.abs(x - 20) / 4, Math.abs(z - 32) / 4)
      const top = ground + Math.max(0, Math.round(3 * (1 - d)))
      for (let y = ground + 1; y <= top; y++) world.set(x, y, z, y === top ? 'grass_block' : 'stone')
    }
  }
  world.fill(26, ground + 1, 28, 26, ground + 4, 28, 'cherry_log')
  for (let dy = 0; dy <= 3; dy++) {
    const r = dy === 3 ? 1 : 2
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r) continue
        world.set(26 + dx, ground + 5 + dy, 28 + dz, 'cherry_leaves')
      }
    }
  }
  world.set(14, ground, 27, 'poppy')
  world.set(15, ground, 27, 'dandelion')

  const bot = world.makeBot({ x: 10.5, y: ground, z: 24.5 })
  bot.entities = {
    101: { id: 101, type: 'animal', name: 'cow', position: new Vec3(10.5, ground, 15.5), yaw: Math.PI, height: 1.4, width: 0.9 },
    102: { id: 102, type: 'hostile', name: 'zombie', position: new Vec3(4.5, ground, 9.5), yaw: Math.PI / 2, height: 1.95, width: 0.6 }
  }

  const views = [
    ['look', { view: 'look', direction: 'north', width: 800, height: 500, maxDist: 48 }],
    ['panorama', { view: 'panorama', width: 1200, height: 320, maxDist: 48 }],
    ['map', { view: 'map', radius: 20 }]
  ]
  for (const [name, opts] of views) {
    const result = await vision.screenshot(bot, opts)
    const file = path.join(outDir, `${name}.png`)
    fs.writeFileSync(file, result.png)
    console.log(`${path.relative(process.cwd(), file)}  ${result.width}x${result.height}  ${result.renderMs}ms  ${result.texturesLoaded} textures  ${result.entitiesSeen} entities`)
  }
  const result = await vision.screenshot(bot, views[0][1])
  console.log('\n' + result.summary)
  console.log(`\n${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
