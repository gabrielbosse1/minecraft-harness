'use strict'

/**
 * Perspective audit: what the renderer draws depends on where the camera is.
 *
 *  * first person  — never the bot's own body, armour, elytra or outer layers;
 *    the held item is drawn in the first-person slot instead.
 *  * third person  — the bot is drawn exactly like any other player (skin,
 *    armour + trims, elytra, both hands, outer layers) and no first-person
 *    overlay is added on top of it.
 *  * other players — always the real model/skin/equipment, in every view.
 *  * panorama      — world imagery only: no HUD, crosshair, compass labels or
 *    entity labels, because those are interface data, not scenery.
 *
 * Runs offline against the synthetic world + real native assets.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const vision = require('../zincai/vision')
const { decodePng } = require('../zincai/native/png')
const { createFakeWorld, registry } = require('./helpers/fake-world')
const Item = require('prismarine-item')('1.21.4')

const SKIN_RGB = [150, 40, 200] // unmistakable purple: only the player skin uses it
const isSkin = (r, g, b) => r > 110 && r < 190 && b > 150 && g < 90
const isArmor = (r, g, b) => r < 150 && g > 180 && b > 160 && b < 250 && g > r + 60 // diamond armour
const isHudPanel = (r, g, b) => r < 60 && g < 70 && b < 90 && b >= r

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]
}

function countColor (img, predicate, region) {
  const [x0, y0, x1, y1] = region || [0, 0, img.width, img.height]
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = px(img, x, y)
      if (predicate(r, g, b)) n++
    }
  }
  return n
}

/** A 64x64 uniform skin served through the server texture property. */
function makeSkinProperty (rgb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-perspective-'))
  const file = path.join(dir, 'skin.png')
  const buf = Buffer.alloc(64 * 64 * 3)
  for (let i = 0; i < 64 * 64; i++) {
    buf[i * 3] = rgb[0]
    buf[i * 3 + 1] = rgb[1]
    buf[i * 3 + 2] = rgb[2]
  }
  fs.writeFileSync(file, vision.encodePng(buf, 64, 64))
  return {
    dir,
    property: Buffer.from(JSON.stringify({
      textures: { SKIN: { url: `file://${file}`, metadata: { model: 'wide' } } }
    })).toString('base64')
  }
}

/** Register the bot's own player entity the way mineflayer does. */
function selfBot (world, { x = 8.5, y = 65, z = 10.5, name = 'ZincAI', property = null } = {}) {
  const bot = world.makeBot({ x, y, z, yaw: 0, pitch: 0 })
  bot.username = name
  Object.assign(bot.entity, {
    id: 99,
    username: name,
    type: 'player',
    height: 1.8,
    width: 0.6,
    velocity: new Vec3(0, 0, 0)
  })
  bot.entities[99] = bot.entity
  bot.players[name] = { username: name, properties: property ? [{ name: 'textures', value: property }] : [] }
  bot.inventory = { slots: [] }
  bot.quickBarSlot = 0
  return bot
}

const stackOf = (name) => new Item(registry.itemsByName[name].id, 1)

function dressSelf (bot, { main = 'diamond_sword', off = 'shield', helmet = 'diamond_helmet', chest = 'diamond_chestplate', legs = 'diamond_leggings', boots = 'diamond_boots' } = {}) {
  const put = (slot, name) => {
    bot.inventory.slots[slot] = name ? stackOf(name) : null
    return bot.inventory.slots[slot]
  }
  bot.heldItem = put(36, main)
  bot.offhandItem = put(45, off)
  put(5, helmet)
  put(6, chest)
  put(7, legs)
  put(8, boots)
}

test('13a: first person never draws your own body, armour or outer layers, and still shows the held item', { timeout: 60_000 }, async () => {
  const world = createFakeWorld()
  const skin = makeSkinProperty(SKIN_RGB)
  const bot = selfBot(world, { property: skin.property })
  dressSelf(bot)

  const first = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir
  })
  const img = decodePng(first.png)

  assert.equal(first.perspective, 'first')
  assert.equal(first.selfRendered, false, 'the bot entity must not be in the entity pass')
  assert.equal(first.firstPersonHands, true)
  assert.equal(first.selfHeldItem, 'diamond_sword')
  assert.match(first.summary, /camera: first person from your eyes/)
  assert.deepEqual(first.armor, [], 'your own armour is not drawn as a camera-space overlay')
  assert.doesNotMatch(first.summary, /creatures in frame: ZincAI/)

  assert.equal(countColor(img, isSkin), 0, 'no pixels of your own skin in first person')
  // (the diamond sword in hand also uses the diamond sheet, so check above the hand)
  assert.equal(countColor(img, isArmor, [0, 0, img.width, Math.floor(img.height * 0.6)]), 0, 'no pixels of your own armour in first person')

  // The held item is still there, at the bottom-right where the hand is.
  const itemPx = countColor(img, (r, g, b) => g > 180 && b > 180 && r < 170, [img.width >> 1, img.height >> 1, img.width, img.height])
  assert.ok(itemPx > 40, `held diamond sword must be drawn in the first-person slot (${itemPx} px)`)
})

test('13b: third person draws you like any other player — skin, armour, elytra, both hands', { timeout: 90_000 }, async () => {
  const world = createFakeWorld()
  // A stone wall far behind so the camera has room (see 13f for the pull-in).
  const skin = makeSkinProperty(SKIN_RGB)
  const bot = selfBot(world, { property: skin.property })
  dressSelf(bot)

  const third = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir, perspective: 'third'
  })
  const img = decodePng(third.png)

  assert.equal(third.perspective, 'third')
  assert.equal(third.selfRendered, true)
  assert.equal(third.firstPersonHands, false, 'no first-person overlay on top of the visible body')
  assert.ok(third.camera.distance >= 3.5 && third.camera.distance <= 4.5, `vanilla 4m third-person camera (${third.camera.distance})`)
  assert.match(third.summary, /camera: third person 4\.0m from your eyes/)
  assert.match(third.summary, /ZincAI \[id=99\] 4m \(you\)/)
  assert.deepEqual(third.armor.sort(), [
    'ZincAI:diamond_boots', 'ZincAI:diamond_chestplate', 'ZincAI:diamond_helmet', 'ZincAI:diamond_leggings'
  ])
  assert.deepEqual(third.heldItems.sort(), ['ZincAI holds diamond_sword', 'ZincAI holds shield (off hand)'])

  assert.ok(countColor(img, isSkin) > 150, 'your own skin must be visible from outside')
  assert.ok(countColor(img, isArmor) > 300, 'your own armour must be visible from outside')

  // Elytra is drawn on the visible back instead of the chestplate.
  bot.inventory.slots[6] = stackOf('elytra')
  const wings = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir, perspective: 'third'
  })
  assert.ok(wings.armor.includes('ZincAI:elytra'), `elytra layer: ${wings.armor.join(', ')}`)

  // Armour trims are part of the visible model too.
  bot.inventory.slots[6] = stackOf('diamond_chestplate')
  bot.inventory.slots[6].components = [{ type: 'trim', data: { pattern: 'coast', material: 'diamond' } }]
  const trimmed = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir, perspective: 'third'
  })
  assert.ok(trimmed.armor.includes('ZincAI:diamond_chestplate/trim'), `trim layer: ${trimmed.armor.join(', ')}`)
})

test('13c: the bot in third person is pixel-equivalent to another player in the same spot', { timeout: 90_000 }, async () => {
  const world = createFakeWorld()
  const skin = makeSkinProperty(SKIN_RGB)
  const bot = selfBot(world, { property: skin.property })
  dressSelf(bot)

  const third = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir, perspective: 'third'
  })
  const thirdImg = decodePng(third.png)

  // Same camera, the bot itself far away, an ordinary player standing where it stood.
  const watcher = selfBot(world, { x: 8.5, y: 200, z: 10.5, name: 'Watcher', property: skin.property })
  watcher.entities[42] = {
    id: 42,
    type: 'player',
    username: 'Alice',
    position: new Vec3(8.5, 65, 10.5),
    yaw: 0,
    height: 1.8,
    width: 0.6,
    velocity: new Vec3(0, 0, 0),
    equipment: [
      stackOf('diamond_sword'),
      stackOf('shield'),
      stackOf('diamond_boots'),
      stackOf('diamond_leggings'),
      stackOf('diamond_chestplate'),
      stackOf('diamond_helmet')
    ]
  }
  watcher.players.Alice = { username: 'Alice', properties: [{ name: 'textures', value: skin.property }] }

  const solo = await vision.screenshot(watcher, {
    view: 'look', direction: 'north', camera: third.camera, width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir
  })
  const soloImg = decodePng(solo.png)

  assert.equal(solo.perspective, 'third')
  assert.equal(solo.selfRendered, false)
  assert.match(solo.summary, /Alice \[id=42\] .* player/)
  assert.deepEqual(solo.armor.sort(), [
    'Alice:diamond_boots', 'Alice:diamond_chestplate', 'Alice:diamond_helmet', 'Alice:diamond_leggings'
  ])

  // Ignore the annotation labels: compare the body band of the frame.
  const band = [100, 150, 260, 259]
  const botBody = countColor(thirdImg, (r, g, b) => isSkin(r, g, b) || isArmor(r, g, b), band)
  const playerBody = countColor(soloImg, (r, g, b) => isSkin(r, g, b) || isArmor(r, g, b), band)
  assert.ok(playerBody > 400, `a plain player must render fully (${playerBody} px)`)
  assert.ok(
    Math.abs(botBody - playerBody) <= Math.round(playerBody * 0.1),
    `the bot must be drawn like any player (bot ${botBody} px vs player ${playerBody} px)`
  )
})

test('13d: other players keep their real models, skins and equipment in first person too', { timeout: 60_000 }, async () => {
  const world = createFakeWorld()
  const skin = makeSkinProperty(SKIN_RGB)
  const bot = selfBot(world, { property: null })
  dressSelf(bot, { main: 'diamond_pickaxe', off: null, helmet: null, chest: null, legs: null, boots: null })
  bot.entities[42] = {
    id: 42,
    type: 'player',
    username: 'Alice',
    position: new Vec3(8.5, 65, 6.5),
    yaw: Math.PI,
    height: 1.8,
    width: 0.6,
    velocity: new Vec3(0, 0, 0),
    equipment: [null, null, stackOf('diamond_boots'), stackOf('diamond_leggings'), stackOf('iron_chestplate'), stackOf('golden_helmet')]
  }
  bot.players.Alice = { username: 'Alice', properties: [{ name: 'textures', value: skin.property }] }

  const first = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 360, height: 260, maxDist: 32, skinCacheDir: skin.dir
  })
  const img = decodePng(first.png)

  assert.equal(first.perspective, 'first')
  assert.equal(first.selfRendered, false)
  assert.ok(first.entitiesSeen >= 1)
  assert.match(first.summary, /Alice \[id=42\] .* player skin=(profile\.properties\.textures|network)/)
  assert.deepEqual(first.armor.sort(), [
    'Alice:diamond_boots', 'Alice:diamond_leggings', 'Alice:golden_helmet', 'Alice:iron_chestplate'
  ])
  assert.ok(countColor(img, isSkin) > 150, 'another player skin must be rendered in first person')
})

test('13e: panoramas are world imagery — no HUD, compass labels, crosshair or first-person hand', { timeout: 90_000 }, async () => {
  const world = createFakeWorld()
  world.fill(4, 66, 4, 4, 69, 4, 'oak_log')
  world.fill(2, 69, 2, 6, 71, 6, 'oak_leaves')
  const skin = makeSkinProperty(SKIN_RGB)
  const bot = selfBot(world, { property: skin.property })
  dressSelf(bot, { main: 'diamond_pickaxe' })

  const pano = await vision.screenshot(bot, { view: 'panorama', width: 600, height: 180, maxDist: 48, skinCacheDir: skin.dir })
  const img = decodePng(pano.png)

  assert.equal(pano.overlays, null)
  assert.equal(pano.firstPersonHands, false, 'a hand overlay would be an obstruction in a 360° capture')
  assert.equal(pano.selfRendered, false)
  assert.match(pano.summary, /no compass\/HUD overlay, world imagery only/)
  assert.match(pano.summary, /overlays: none \(no HUD, crosshair, compass labels or entity labels/)

  const top = [0, 0, 180, 30]
  assert.equal(countColor(img, isHudPanel, top), 0, 'the panorama must not contain HUD panels')
  assert.equal(countColor(img, (r, g, b) => g > 180 && b > 180 && r < 170, [0, 120, 600, 180]), 0, 'no held item in the panorama')

  // Opting in restores the annotations (and nothing else).
  const annotated = await vision.screenshot(bot, { view: 'panorama', width: 600, height: 180, maxDist: 48, overlays: 'all' })
  assert.deepEqual(annotated.overlays, { hud: true, labels: true })
  assert.ok(countColor(decodePng(annotated.png), isHudPanel, top) > 200, 'HUD is still available on request')

  // Third-person panorama keeps the clean imagery but shows you in the world.
  const third = await vision.screenshot(bot, { view: 'panorama', width: 600, height: 180, maxDist: 48, perspective: 'third' })
  assert.equal(third.selfRendered, true)
  assert.equal(third.overlays, null)
  assert.equal(third.firstPersonHands, false)
})

test('13f: third-person camera sits behind you, pulls in against walls and honours an explicit camera', { timeout: 60_000 }, async () => {
  const world = createFakeWorld()
  const bot = selfBot(world, { property: null })
  dressSelf(bot, { helmet: null, chest: null, legs: null, boots: null, off: null })

  const behind = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 320, height: 240, maxDist: 32, perspective: 'third' })
  assert.ok(Math.abs(behind.camera.x - 8.5) < 0.01)
  assert.ok(behind.camera.z > 13.5 && behind.camera.z < 14.6, `camera is south of you (z=${behind.camera.z})`)
  assert.ok(behind.camera.y > 66.9 && behind.camera.y < 67.1, `camera is above your eyes (y=${behind.camera.y})`)

  const near = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 320, height: 240, maxDist: 32, perspective: 'third', cameraDistance: 2 })
  assert.ok(Math.abs(near.camera.distance - 2) < 0.05, `cameraDistance is honoured (${near.camera.distance})`)

  // A wall immediately behind the bot: the camera comes in instead of ending up
  // inside the stone.
  for (let x = 6; x <= 11; x++) {
    world.set(x, 65, 12, 'stone')
    world.set(x, 66, 12, 'stone')
  }
  const tight = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 320, height: 240, maxDist: 32, perspective: 'third' })
  assert.ok(tight.camera.distance < 2, `camera must pull in against the wall (${tight.camera.distance})`)
  assert.equal(tight.selfRendered, true, 'you stay visible even in a tight spot')

  const fixed = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 320, height: 240, maxDist: 32, camera: { x: 8.5, y: 68, z: 18 } })
  assert.equal(fixed.perspective, 'third')
  assert.deepEqual(fixed.camera, { x: 8.5, y: 68, z: 18, distance: 7.63 })
  assert.match(fixed.summary, /camera: fixed camera/)
  assert.equal(fixed.selfRendered, true)

  // An unsupported perspective is reported, never silently pretended.
  const bogus = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 200, height: 150, maxDist: 24, perspective: 'birdseye' })
  assert.equal(bogus.perspective, 'first')
  assert.ok(bogus.renderNotes.some((n) => /unknown perspective 'birdseye'/.test(n)), bogus.renderNotes.join('; '))

  // The top-down map says it ignores a perspective request.
  const map = await vision.screenshot(bot, { view: 'map', radius: 12, perspective: 'third' })
  assert.equal(map.view, 'map')
  assert.match(map.summary, /top-down diagram, so the requested perspective 'third' does not apply/)
})
