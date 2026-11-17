'use strict'

/**
 * End-to-end renderer check against a real flying-squid 1.21.4 server: real
 * chunks, real block states, real entities, real player-info skins. The scene
 * exercises transparent blocks, a chest, vegetation, stairs and multiple mobs.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const vision = require('../zincai/vision')
const { decodePng } = require('../zincai/native/png')
const { startMcServer, waitFor, sleep } = require('./helpers/mc-server')

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

test('11: real server chunks, mobs, chest, glass, water and stairs render through native resources', { timeout: 60_000 }, async () => {
  const mc = await startMcServer({ viewDistance: 4 })
  const mobs = []
  try {
    const bot = await mc.connectPlayer('RenderBot')
    const alice = await mc.connectPlayer('Alice')
    await waitFor(() => bot.entity?.position && alice.entity?.position, { timeoutMs: 10_000 })
    await sleep(400)

    const o = bot.entity.position.floored()
    const y = o.y
    const z = o.z - 5
    // A solid viewing strip so the camera sees known geometry.
    await mc.fillBlocks(new Vec3(o.x - 4, y - 1, o.z - 9), new Vec3(o.x + 4, y - 1, o.z - 4), 'stone')
    await mc.setBlock(new Vec3(o.x - 4, y, z), 'cherry_leaves')
    await mc.setBlock(new Vec3(o.x - 3, y, z), 'glass')
    await mc.setBlock(new Vec3(o.x - 2, y, z), 'oak_stairs')
    await mc.setBlock(new Vec3(o.x + 1, y, z), 'chest')
    await mc.setBlock(new Vec3(o.x + 3, y, z), 'water')
    await mc.setBlock(new Vec3(o.x + 4, y, z), 'poppy')
    await sleep(300)

    mobs.push(mc.spawnMob('cow', new Vec3(o.x - 1.5, y, z - 1.5)))
    mobs.push(mc.spawnMob('zombie', new Vec3(o.x + 1.5, y, z - 1.5)))
    await sleep(500)

    const look = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 480, height: 300, maxDist: 48 })
    assert.deepEqual(look.png.subarray(0, 8), PNG_SIG)
    const img = decodePng(look.png)
    assert.ok(img && img.width === 480 && img.height === 300)
    assert.equal(look.renderer, 'native-vanilla-models')
    assert.equal(look.fullbright, true)
    assert.ok(look.texturesLoaded >= 8, `textures: ${look.texturesLoaded}`)
    assert.ok(look.entitiesSeen >= 2, `entities seen: ${look.entitiesSeen}`)
    assert.match(look.summary, /cow \[id=/i)
    assert.match(look.summary, /zombie \[id=/i)
    assert.match(look.summary, /(stone|cherry_leaves|glass|chest|oak_stairs)/i)
    assert.match(look.summary, /native Minecraft resources/)
    assert.ok(look.renderMs < 4000, `render too slow: ${look.renderMs}ms`)

    const pano = await vision.screenshot(bot, { view: 'panorama', width: 640, height: 200, maxDist: 48 })
    assert.equal(pano.view, 'panorama')
    assert.ok(pano.entitiesSeen >= 2)
    assert.ok(pano.renderMs < 4000, `panorama too slow: ${pano.renderMs}ms`)

    const map = await vision.screenshot(bot, { view: 'map', radius: 16 })
    assert.equal(map.view, 'map')
    assert.match(map.summary, /surface textures sampled from native block models/)
    assert.ok(map.renderMs < 3000, `map too slow: ${map.renderMs}ms`)
  } finally {
    for (const mob of mobs) { try { mc.destroyMob(mob) } catch { /* noop */ } }
    await mc.close()
  }
})
