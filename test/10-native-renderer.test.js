'use strict'

/**
 * Offline renderer regression suite: native resource resolution, real
 * blockstate/model geometry, render layers and alpha cutouts, fullbright,
 * player-skin resolution (server texture property + refresh), and the
 * look/panorama/map perception API. Runs without a Minecraft server.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const vision = require('../zincai/vision')
const { decodePng } = require('../zincai/native/png')
const { upgradeLegacySkin } = require('../zincai/native/skins')
const { createFakeWorld } = require('./helpers/fake-world')
const Item = require('prismarine-item')('1.21.4')

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function pngOf (result, label) {
  assert.ok(Buffer.isBuffer(result.png), `${label}: png buffer`)
  assert.deepEqual(result.png.subarray(0, 8), PNG_SIG, `${label}: PNG signature`)
  const decoded = decodePng(result.png)
  assert.ok(decoded, `${label}: png must decode`)
  assert.equal(decoded.width, result.width)
  assert.equal(decoded.height, result.height)
  return decoded
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]]
}

function makeSkin (file, rgb) {
  const w = 64
  const h = 64
  const rgbBuf = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    rgbBuf[i * 3] = rgb[0]
    rgbBuf[i * 3 + 1] = rgb[1]
    rgbBuf[i * 3 + 2] = rgb[2]
  }
  fs.writeFileSync(file, vision.encodePng(rgbBuf, w, h))
}

test('10a: cherry grove look/panorama/map render real models, and keep the perception API stable', { timeout: 30_000 }, async () => {
  const world = createFakeWorld()
  // Cherry grove: trunk, canopy, flowers, chest and glass.
  world.fill(8, 65, 4, 8, 67, 4, 'cherry_log')
  world.fill(6, 67, 2, 10, 69, 6, 'cherry_leaves')
  world.set(8, 70, 4, 'cherry_leaves')
  world.set(6, 65, 6, 'poppy')
  world.set(9, 65, 6, 'dandelion')
  world.set(10, 65, 6, 'chest')
  world.set(5, 65, 6, 'glass')
  const bot = world.makeBot({ x: 10.5, y: 65, z: 12.5 })

  const look = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 480, height: 300, maxDist: 48 })
  pngOf(look, 'look')
  assert.equal(look.view, 'look')
  assert.equal(look.renderer, 'native-vanilla-models')
  assert.equal(look.fullbright, true)
  assert.equal(look.assetsVersion, '1.21.4')
  assert.ok(look.texturesLoaded > 5, `textures loaded: ${look.texturesLoaded}`)
  assert.ok(look.chunksLoaded > 0)
  assert.match(look.summary, /cherry_leaves/)
  assert.match(look.summary, /cherry_log/)
  assert.match(look.summary, /chest/)
  assert.match(look.summary, /native Minecraft resources/)
  assert.match(look.summary, /fullbright/)
  assert.doesNotMatch(look.summary, /fallback:/i)
  assert.ok(look.renderMs < 4000, `look render too slow: ${look.renderMs}ms`)

  const pano = await vision.screenshot(bot, { view: 'panorama', width: 640, height: 200, maxDist: 48 })
  pngOf(pano, 'panorama')
  assert.equal(pano.view, 'panorama')
  assert.match(pano.summary, /panorama from/i)
  assert.ok(pano.renderMs < 4000, `panorama render too slow: ${pano.renderMs}ms`)

  const map = await vision.screenshot(bot, { view: 'map', radius: 16 })
  pngOf(map, 'map')
  assert.equal(map.view, 'map')
  assert.match(map.summary, /map centred on you/i)
  assert.match(map.summary, /surface textures sampled from native block models/)
  assert.ok(map.renderMs < 3000, `map render too slow: ${map.renderMs}ms`)
})

test('10b: cherry leaf cutouts are true holes that reveal the scene behind', { timeout: 20_000 }, async () => {
  const world = createFakeWorld()
  // Stone wall directly behind a two-block leaf curtain.
  world.fill(6, 65, 4, 10, 67, 4, 'stone')
  world.fill(7, 65, 6, 9, 66, 6, 'cherry_leaves')
  const bot = world.makeBot({ x: 8.5, y: 65, z: 9.5 })
  const result = await vision.screenshot(bot, {
    view: 'look', width: 360, height: 260, maxDist: 24, at: { x: 8, y: 65.5, z: 6 }
  })
  const img = pngOf(result, 'leaves')

  let stone = 0
  let leaf = 0
  for (let y = 90; y < 190; y++) {
    for (let x = 120; x < 240; x++) {
      const [r, g, b] = px(img, x, y)
      const grey = Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 70 && r < 190
      if (grey) stone++
      if (r > g + 18 || (g > r + 8 && g > b + 10)) leaf++
    }
  }
  assert.ok(stone > 40, `leaf holes must show the stone wall behind (${stone} grey pixels)`)
  assert.ok(leaf > 200, `cherry leaves must keep their pink/green texels (${leaf} leaf pixels)`)
  assert.match(result.summary, /cherry_leaves/)
})

test('10c: fullbright keeps terrain identical at noon and midnight without touching sky', { timeout: 20_000 }, async () => {
  const world = createFakeWorld()
  world.fill(4, 65, 4, 12, 71, 4, 'stone_bricks')
  const bot = world.makeBot({ x: 8.5, y: 65, z: 10.5 })
  const opts = { view: 'look', direction: 'north', width: 320, height: 220, maxDist: 32 }

  bot.time.timeOfDay = 6000
  const day = await vision.screenshot(bot, opts)
  const dayImg = pngOf(day, 'day')
  bot.time.timeOfDay = 18000
  const night = await vision.screenshot(bot, opts)
  const nightImg = pngOf(night, 'night')
  assert.equal(night.fullbright, true)
  assert.match(night.summary, /night \(fullbright terrain\)/)

  // Compare opaque wall pixels below the horizon; both frames must be equal.
  let compared = 0
  let maxDelta = 0
  for (let y = 120; y < 210; y++) {
    for (let x = 60; x < 260; x++) {
      const a = px(dayImg, x, y)
      const b = px(nightImg, x, y)
      const grey = Math.abs(a[0] - a[1]) < 30 && Math.abs(a[1] - a[2]) < 30
      if (!grey) continue
      compared++
      maxDelta = Math.max(maxDelta, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
    }
  }
  assert.ok(compared > 3000, `must compare a real wall area (${compared}px)`)
  assert.ok(maxDelta <= 1, `fullbright terrain must not change with time of day (max delta ${maxDelta})`)

  // The sky itself must still be dark at night.
  const daySky = px(dayImg, 300, 70)
  const nightSky = px(nightImg, 300, 70)
  assert.ok(daySky[2] > nightSky[2] + 30, `sky must darken at night (day ${daySky}, night ${nightSky})`)
})

test('10d: player skins come from the server texture URL, switch models, and refresh when it changes', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-skin-test-'))
  const red = path.join(dir, 'red.png')
  const blue = path.join(dir, 'blue.png')
  makeSkin(red, [220, 30, 30])
  makeSkin(blue, [30, 80, 220])

  const world = createFakeWorld()
  const bot = world.makeBot({ x: 8.5, y: 65, z: 10.5 })
  bot.entities[2] = {
    id: 2,
    type: 'player',
    username: 'Alice',
    position: new Vec3(8.5, 65, 6.5),
    yaw: Math.PI,
    height: 1.8,
    width: 0.6,
    velocity: new Vec3(0, 0, 0)
  }
  bot.players.Alice = { username: 'Alice', skinData: { url: `file://${red}`, model: 'wide' } }
  const opts = { view: 'look', direction: 'north', width: 300, height: 240, maxDist: 24, skinCacheDir: dir }

  const first = await vision.screenshot(bot, opts)
  const firstImg = pngOf(first, 'red-skin')
  assert.equal(first.entitiesSeen, 1)
  assert.equal(first.skins.length, 1)
  assert.equal(first.skins[0].model, 'wide')
  assert.match(first.skins[0].source, /network|cache/)
  const redPixels = countColor(firstImg, (r, g, b) => r > 170 && g < 90 && b < 90)
  assert.ok(redPixels > 200, `custom red skin must be visible (${redPixels} px)`)

  // Change the server-provided texture: a new revision must be fetched and the
  // cached texture invalidated without restarting the renderer.
  bot.players.Alice.skinData = { url: `file://${blue}`, model: 'slim' }
  const second = await vision.screenshot(bot, { ...opts, skinCacheDir: dir })
  const secondImg = pngOf(second, 'blue-skin')
  assert.equal(second.skins[0].model, 'slim')
  assert.notEqual(second.skins[0].revision, first.skins[0].revision)
  const bluePixels = countColor(secondImg, (r, g, b) => b > 140 && r < 90)
  assert.ok(bluePixels > 200, `refreshed blue skin must be visible (${bluePixels} px)`)
  const staleRed = countColor(secondImg, (r, g, b) => r > 170 && g < 50 && b < 50)
  assert.equal(staleRed, 0, 'the previous skin must not linger after the URL changes')
})

test('10e: SkinRestorer-style raw texture properties resolve without skinData', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-skin-prop-'))
  const skin = path.join(dir, 'server-skin.png')
  makeSkin(skin, [40, 170, 90])
  const property = Buffer.from(JSON.stringify({
    textures: { SKIN: { url: `file://${skin}`, metadata: { model: 'slim' } } }
  })).toString('base64')

  const world = createFakeWorld()
  const bot = world.makeBot({ x: 8.5, y: 65, z: 10.5 })
  bot.entities[3] = {
    id: 3,
    type: 'player',
    username: 'Bob',
    position: new Vec3(8.5, 65, 6.5),
    yaw: Math.PI,
    height: 1.8,
    width: 0.6,
    velocity: new Vec3(0, 0, 0)
  }
  bot.players.Bob = {
    username: 'Bob',
    properties: [{ name: 'textures', value: property }]
  }
  const result = await vision.screenshot(bot, {
    view: 'look', direction: 'north', width: 300, height: 240, maxDist: 24, skinCacheDir: dir
  })
  const img = pngOf(result, 'property-skin')
  assert.equal(result.skins[0].username, 'Bob')
  assert.equal(result.skins[0].model, 'slim')
  assert.match(result.skins[0].source, /network|cache/)
  assert.equal(result.skins[0].profileSource, 'profile.properties.textures')
  const green = countColor(img, (r, g, b) => g > 130 && r < 110 && b < 130)
  assert.ok(green > 200, `server-provided skin must be rendered (${green} px)`)
})

test('10f: legacy 64x32 skins are upgraded by mirroring right limbs', () => {
  const w = 64
  const h = 32
  const source = new Uint8Array(w * h * 4)
  for (let i = 0; i < source.length; i += 4) {
    source[i] = (i / 4) % 255
    source[i + 1] = 40
    source[i + 2] = 80
    source[i + 3] = 255
  }
  const upgraded = upgradeLegacySkin({ width: w, height: h, rgba: source })
  assert.equal(upgraded.width, 64)
  assert.equal(upgraded.height, 64)
  // right leg (0,16,16x16) mirrored into left leg (16,48)
  const at = (img, x, y) => {
    const i = (y * img.width + x) * 4
    return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]
  }
  assert.deepEqual(at(upgraded, 16, 48), at({ width: 64, rgba: source }, 15, 16))
  assert.deepEqual(at(upgraded, 31, 63), at({ width: 64, rgba: source }, 0, 31))
})

function countColor (img, predicate) {
  let n = 0
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (predicate(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2])) n++
  }
  return n
}

test('10g: translucent water and stained glass composite over the scene instead of turning opaque', { timeout: 20_000 }, async () => {
  const world = createFakeWorld()
  // Stone floor so the tint is easy to reason about.
  world.fill(4, 64, 2, 14, 64, 8, 'stone')
  world.fill(6, 65, 4, 8, 65, 6, 'water')
  world.set(11, 65, 5, 'red_stained_glass')
  const bot = world.makeBot({ x: 8.5, y: 65, z: 11.5 })
  const result = await vision.screenshot(bot, { view: 'look', width: 400, height: 280, maxDist: 24, at: { x: 8, y: 65, z: 5 } })
  const img = pngOf(result, 'translucent')
  assert.match(result.summary, /water|red_stained_glass/i)

  let blue = 0
  let red = 0
  for (let y = 60; y < 240; y++) {
    for (let x = 20; x < 380; x++) {
      const [r, g, b] = px(img, x, y)
      if (b > r + 25 && b > g + 10) blue++
      if (r > b + 25 && r > g + 20) red++
    }
  }
  assert.ok(blue > 300, `water must tint the stone blue (${blue} px)`)
  assert.ok(red > 100, `red stained glass must be visible (${red} px)`)
})

test('10h: real entity models are rasterized into the frame and reported', { timeout: 20_000 }, async () => {
  const world = createFakeWorld()
  const bot = world.makeBot({ x: 8.5, y: 65, z: 12.5 })
  const clean = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 320, height: 240, maxDist: 32 })

  bot.entities[1] = { id: 1, type: 'mob', name: 'cow', position: new Vec3(6.5, 65, 6.5), yaw: Math.PI, height: 1.4, width: 0.9, velocity: new Vec3(0, 0, 0) }
  bot.entities[2] = { id: 2, type: 'mob', name: 'zombie', position: new Vec3(8.5, 65, 6.5), yaw: Math.PI, height: 1.95, width: 0.6, velocity: new Vec3(0, 0, 0) }
  bot.entities[3] = { id: 3, type: 'player', username: 'Alice', position: new Vec3(10.5, 65, 6.5), yaw: Math.PI, height: 1.8, width: 0.6, velocity: new Vec3(0, 0, 0) }
  bot.players.Alice = { username: 'Alice', skinData: { url: '', model: 'wide' } }
  const populated = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 320, height: 240, maxDist: 32 })

  assert.equal(populated.entitiesSeen, 3)
  assert.deepEqual(populated.unsupportedEntities, [])
  assert.match(populated.summary, /cow \[id=1\]/)
  assert.match(populated.summary, /zombie \[id=2\]/)
  assert.match(populated.summary, /Alice \[id=3\] 6m player/)
  const a = pngOf(clean, 'entities-empty')
  const b = pngOf(populated, 'entities')
  let changed = 0
  for (let i = 0; i < a.rgba.length; i += 4) {
    if (Math.abs(a.rgba[i] - b.rgba[i]) > 8 || Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) > 8 || Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > 8) changed++
  }
  assert.ok(changed > 800, `entity models must paint pixels (${changed} changed)`)
})

test('10i: animated client textures advance frames and resource packs override real assets', { timeout: 20_000 }, async () => {
  const { createAssetProvider, BlockModelStore } = vision._internal
  const mc = require('minecraft-data')('1.21.4')
  const base = createAssetProvider({ version: '1.21.4' })

  const water = base.blockTexture('water_still')
  assert.equal(water.animated, true)
  assert.ok(water.frameCount > 1, 'water_still must carry its .mcmeta frame list')
  const lava = base.blockTexture('lava_still')
  const a = lava.sample(0.5, 0.25, 0, 0).slice()
  const b = lava.sample(0.5, 0.25, 1000, 0).slice()
  assert.notDeepEqual(a, b, 'animated lava must advance frame with wall-clock time')

  // A real resource-pack layout: assets/minecraft/{blockstates,models,textures}.
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-pack-'))
  const dir = (p) => {
    const full = path.join(pack, 'assets', 'minecraft', p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    return full
  }
  const texture = Buffer.alloc(16 * 16 * 3, 0)
  for (let i = 0; i < 16 * 16; i++) {
    texture[i * 3] = 240
    texture[i * 3 + 1] = 30
    texture[i * 3 + 2] = 200
  }
  fs.writeFileSync(dir('textures/block/oak_planks.png'), vision.encodePng(texture, 16, 16))
  fs.writeFileSync(dir('blockstates/stone.json'), JSON.stringify({
    variants: { '': { model: 'minecraft:block/oak_planks' } }
  }))

  const packed = createAssetProvider({ version: '1.21.4', resourcePacks: [pack] })
  assert.ok(packed.info.sources.some((s) => /resource pack/.test(s)), 'pack must be discovered')
  const tex = packed.blockTexture('oak_planks')
  const avg = [0, 1, 2].map((c) => {
    let sum = 0
    for (let i = c; i < tex.rgba.length; i += 4) sum += tex.rgba[i]
    return Math.round(sum / (tex.width * tex.height))
  })
  assert.ok(avg[0] > 220 && avg[1] < 60 && avg[2] > 180, `pack texture must win over vanilla (${avg})`)

  const store = new BlockModelStore({ version: '1.21.4', registry: mc }, packed)
  const stone = store.modelForState(mc.blocksByName.stone.defaultState, 0, 0, 0)
  assert.ok(stone.texturesUsed.some((t) => t.name === 'oak_planks'), 'pack blockstate must redirect the stone model')
})

test('10j: real item models — generated sprites, block items, dropped entities and held equipment', { timeout: 30_000 }, async () => {
  const world = createFakeWorld({ minX: 0, maxX: 20, minZ: 0, maxZ: 24, groundY: 64 })
  const bot = world.makeBot({ x: 10.5, y: 65, z: 16.5 })
  const ctx = vision._internal.getNativeContext(bot, {})

  // Generated item: the real models/item/diamond_sword.json chain
  // (item/handheld → item/generated) and the real 16x16 sprite, extruded by
  // the client's ItemModelGenerator rule.
  const sword = ctx.items.bake('diamond_sword')
  assert.ok(sword, 'diamond_sword model')
  assert.equal(sword.kind, 'generated')
  assert.ok(sword.quads.length > 20, `extruded quads: ${sword.quads.length}`)
  assert.match(sword.textures[0].name, /item\/diamond_sword/)
  assert.ok(sword.display.thirdperson_righthand, 'real display transform')

  // Block item without an item model falls back to the block's default state.
  const planks = ctx.items.bake('oak_planks')
  assert.ok(planks)
  assert.equal(planks.kind, 'block')
  assert.equal(planks.quads.length, 6)
  assert.ok(ctx.items.bake('oak_stairs').quads.length >= 6)
  assert.ok(ctx.items.bake('stone').quads.length >= 6)

  // Compass/clock are property-selected models with no base JSON; their real
  // north/noon frame is used and labelled.
  const compass = ctx.items.bake('compass')
  assert.equal(compass.fallbackFrame, 'compass_16')
  assert.match(compass.source, /static-frame:compass_16/)

  // Builtin entity items have no JSON geometry; they must be reported.
  assert.equal(ctx.items.bake('shield'), null)
  assert.ok(ctx.items.stats.unsupported.has('shield'))

  // Dropped item entity (ground display) and held equipment on a zombie.
  const held = new Item(bot.registry.itemsByName.iron_pickaxe.id, 1)
  bot.entities = {
    201: { id: 201, type: 'animal', name: 'item', position: new Vec3(10.5, 65, 12.5), getDroppedItem: () => new Item(bot.registry.itemsByName.diamond_sword.id, 1), height: 0.25, width: 0.25 },
    202: { id: 202, type: 'hostile', name: 'zombie', position: new Vec3(8.5, 65, 12.5), yaw: Math.PI / 2, height: 1.95, width: 0.6, equipment: [held] }
  }
  bot.heldItem = new Item(bot.registry.itemsByName.golden_apple.id, 1)

  const look = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 640, height: 420, maxDist: 32, timeMs: 0 })
  const img = pngOf(look, 'items')
  assert.equal(look.itemsSeen, 1)
  assert.deepEqual(look.itemNames, ['diamond_sword'])
  assert.equal(look.selfHeldItem, 'golden_apple')
  assert.ok(look.heldItems.some((h) => /zombie holds iron_pickaxe/.test(h)))
  assert.ok(look.heldItems.some((h) => /you hold golden_apple/.test(h)))
  assert.match(look.summary, /items in frame: diamond_sword/)
  assert.doesNotMatch(look.summary, /entities without a client model.*item/)
  assert.deepEqual(look.unsupportedItems, [])

  // The dropped sword sprite is visibly cyan in the region where it projects
  // (centre-bottom, 4 m ahead), not a missing-texture magenta checkerboard.
  let cyan = 0
  let magenta = 0
  for (let y = 230; y < 330; y++) {
    for (let x = 280; x < 365; x++) {
      const i = (y * img.width + x) * 4
      const r = img.rgba[i]; const g = img.rgba[i + 1]; const b = img.rgba[i + 2]
      if (g > 130 && b > 130 && r < 130) cyan++
      if (r > 180 && b > 180 && g < 100) magenta++
    }
  }
  assert.ok(cyan > 20, `diamond-sword pixels: ${cyan}`)
  assert.ok(magenta < 20, `missing-texture pixels: ${magenta}`)
})
