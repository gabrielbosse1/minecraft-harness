'use strict'

/**
 * 12 — unified asset layer: entity variants, equipment, item frames and the
 * state-selected item models. These tests use the real client resources that
 * `zincai/native/assets.js` resolves, so a failure means the renderer would
 * draw something the client would not.
 */

const test = require('node:test')
const assert = require('node:assert')
const minecraftData = require('minecraft-data')
const { Vec3 } = require('vec3')
const Item = require('prismarine-item')('1.21.4')
const vision = require('../zincai/vision')
const { createFakeWorld } = require('./helpers/fake-world')
const { entityAppearance, modelKeyFor, metaValue } = require('../zincai/native/entityAppearance')
const { equipmentOf, resolveArmorLayers } = require('../zincai/native/equipment')
const { decodePng } = require('../zincai/native/png')
const { loadEntityDefinitions } = require('../zincai/native/entityModels')

const mc = minecraftData('1.21.4')
const definitions = loadEntityDefinitions()

/** Build mineflayer's index-keyed metadata object from named keys. */
function meta (entityName, values) {
  const keys = mc.entitiesByName[entityName]?.metadataKeys || []
  const out = {}
  for (const [name, value] of Object.entries(values)) {
    const index = keys.indexOf(name)
    if (index >= 0) out[index] = value
  }
  return out
}

function pngOf (shot, label) {
  const img = decodePng(shot.png)
  assert.ok(img, `${label}: decodable png`)
  return img
}

test('12a: entity appearance follows synced metadata, not the entity type', () => {
  // Sheep wool byte: colour in the low nibble, sheared in bit 4.
  const redSheep = entityAppearance({ name: 'sheep', metadata: meta('sheep', { wool: 14 }) }, { registry: mc, definitions })
  assert.equal(redSheep.variant, 'red')
  assert.deepEqual(redSheep.tint, [176, 46, 38])
  assert.equal(redSheep.textureCandidates[0], 'entity/sheep/sheep')
  assert.equal(redSheep.extraLayers[0].textureRef, 'entity/sheep/sheep_fur')
  assert.deepEqual(redSheep.extraLayers[0].bones, ['head', 'body'])

  const sheared = entityAppearance({ name: 'sheep', metadata: meta('sheep', { wool: 0x10 | 13 }) }, { registry: mc, definitions })
  assert.equal(sheared.variant, 'sheared')
  assert.equal(sheared.tint, null)

  // Cat variants and collars.
  const cat = entityAppearance({ name: 'cat', metadata: meta('cat', { variant: 1, flags: 0x04, collar_color: 2 }) }, { registry: mc, definitions })
  assert.equal(cat.variant, 'black/tame')
  assert.equal(cat.textureCandidates[0], 'entity/cat/black')
  assert.ok(cat.extraLayers.some((l) => /cat_collar/.test(l.textureRef)))

  // Wolf coats (1.20.5+ variant registry).
  const wolf = entityAppearance({ name: 'wolf', metadata: meta('wolf', { variant: 1, flags: 0x04 }) }, { registry: mc, definitions })
  assert.equal(wolf.textureCandidates[0], 'entity/wolf/wolf_snowy_tame')

  // Villager profession + biome type overlay.
  const villager = entityAppearance({ name: 'villager', metadata: meta('villager', { villager_data: { type: 3, profession: 9, level: 2 } }) }, { registry: mc, definitions })
  assert.equal(villager.textureCandidates[0], 'entity/villager/profession/librarian')
  assert.equal(villager.variant, 'librarian/savanna')
  assert.ok(villager.notes.some((n) => /villager\/type\/savanna/.test(n)), `notes: ${villager.notes}`)

  // Shulker colours use the vanilla `light_gray` file name.
  assert.equal(entityAppearance({ name: 'shulker', metadata: meta('shulker', { color: 8 }) }, { registry: mc, definitions }).textureCandidates[0], 'entity/shulker/shulker_light_gray')

  // Horse coat + markings packed into `type_variant`.
  const horse = entityAppearance({ name: 'horse', metadata: meta('horse', { type_variant: 2 | (1 << 8) }) }, { registry: mc, definitions })
  assert.equal(horse.textureCandidates[0], 'entity/horse/horse_chestnut')
  assert.ok(horse.extraLayers.some((l) => /horse_markings_white$/.test(l.textureRef)))

  // Babies use the same model at half scale.
  const calf = entityAppearance({ name: 'cow', metadata: meta('cow', { baby: true }) }, { registry: mc, definitions })
  assert.equal(calf.baby, true)
  assert.equal(calf.scale, 0.5)

  // Boats/minecarts/giant/illusioner are real catalogue models under another key.
  assert.equal(modelKeyFor('oak_chest_boat'), 'boat')
  assert.equal(modelKeyFor('furnace_minecart'), 'minecart')
  assert.equal(modelKeyFor('giant'), 'zombie')
  assert.equal(modelKeyFor('illusioner'), 'evoker')
})

test('12b: equipment resolves real armour layers, trims and elytra wings', () => {
  const world = createFakeWorld({ minX: 0, maxX: 20, minZ: 0, maxZ: 24, groundY: 64 })
  const bot = world.makeBot({ x: 10.5, y: 65, z: 16.5 })
  const ctx = vision._internal.getNativeContext(bot, {})

  const leather = equipmentOf(new Item(mc.itemsByName.leather_helmet.id, 1), 'leather_helmet')
  const leatherLayers = resolveArmorLayers(leather, { assets: ctx.assets })
  // Undyed leather keeps the definition's 0xA06540, never black.
  assert.match(leatherLayers.layers[0].texture.name, /leather#tint:160,101,64/)
  assert.equal(leatherLayers.layers.length, 2)

  const elytra = equipmentOf(new Item(mc.itemsByName.elytra.id, 1), 'elytra')
  const wings = resolveArmorLayers(elytra, { assets: ctx.assets })
  assert.equal(wings.layers[0].wings, true)
  assert.match(wings.layers[0].texture.name, /entity\/equipment\/wings\/elytra/)

  const chest = new Item(mc.itemsByName.iron_chestplate.id, 1)
  chest.components = [{ type: 'trim', data: { pattern: 'coast', material: 'diamond' } }]
  const trimmed = resolveArmorLayers(equipmentOf(chest, 'iron_chestplate'), { assets: ctx.assets })
  assert.equal(trimmed.layers.length, 2, `trim layer: ${JSON.stringify(trimmed.notes)}`)
  assert.equal(trimmed.layers[1].trim, true)
  assert.equal(trimmed.layers[1].texture.width, 64)
})

test('12c: armour, both hands, item frames and block entities are drawn and reported', async () => {
  const world = createFakeWorld({ minX: 0, maxX: 30, minZ: 0, maxZ: 30, groundY: 64 })
  const bot = world.makeBot({ x: 15.5, y: 65, z: 24.5, yaw: Math.PI })
  const stack = (name) => new Item(mc.itemsByName[name].id, 1)
  bot.entities = {
    1: {
      id: 1,
      type: 'player',
      name: 'SkinUser',
      username: 'SkinUser',
      position: new Vec3(15.5, 65, 19.5),
      yaw: 0,
      height: 1.8,
      width: 0.6,
      metadata: {},
      equipment: [stack('diamond_sword'), stack('shield'), stack('golden_boots'), stack('iron_leggings'), stack('diamond_chestplate'), stack('golden_helmet')]
    },
    2: {
      id: 2,
      type: 'object',
      name: 'item_frame',
      position: new Vec3(17.5, 65, 19.5),
      yaw: 0,
      metadata: meta('item_frame', { item: stack('diamond_sword'), rotation: 2 })
    },
    3: {
      id: 3,
      type: 'object',
      name: 'tnt',
      position: new Vec3(12.5, 65, 19.5),
      yaw: 0,
      metadata: meta('tnt', { block_state: mc.blocksByName.tnt.defaultState })
    }
  }
  bot.players = { SkinUser: { username: 'SkinUser', uuid: '00000000000000000000000000000001' } }

  const look = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 480, height: 420, maxDist: 24, timeMs: 0 })
  assert.equal(look.entitiesSeen, 2, look.summary) // player + tnt; frames are reported separately
  assert.ok(look.armor.some((a) => /golden_boots/.test(a)), `armour: ${look.armor}`)
  assert.ok(look.armor.some((a) => /diamond_chestplate/.test(a)))
  assert.ok(look.armor.some((a) => /golden_helmet/.test(a)))
  assert.ok(look.heldItems.some((h) => /diamond_sword/.test(h)), `held: ${look.heldItems}`)
  assert.ok(look.heldItems.some((h) => /shield \(off hand\)/.test(h)), `off hand: ${look.heldItems}`)
  assert.equal(look.itemFrames.length, 1)
  assert.ok(look.summary.includes('tnt'), 'primed TNT drawn from the block model')

  // The frame and TNT must be visible pixels, not just reported.
  const img = pngOf(look, 'entities')
  let nonSky = 0
  for (let y = 120; y < 330; y++) {
    for (let x = 150; x < 400; x++) {
      const i = (y * img.width + x) * 4
      const [r, g, b] = [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]
      if (!(b > 200 && r < 190 && g < 230)) nonSky++
    }
  }
  assert.ok(nonSky > 3000, `drawn entity pixels: ${nonSky}`)
})

test('12d: state-selected item models use real world state; unknown state is reported', () => {
  const world = createFakeWorld({ minX: 0, maxX: 20, minZ: 0, maxZ: 24, groundY: 64 })
  const bot = world.makeBot({ x: 10.5, y: 65, z: 16.5 })
  const ctx = vision._internal.getNativeContext(bot, {})
  const compass = new Item(mc.itemsByName.compass.id, 1)

  assert.equal(ctx.items.bake('compass'), null)
  assert.ok(ctx.items.coverage().needsState.includes('compass'))

  const east = ctx.items.quadsForStack(compass, 'gui', { compassAngle: 0, dimension: 'minecraft:overworld' })
  assert.match(east.modelName, /compass_16$/)
  const south = ctx.items.quadsForStack(compass, 'gui', { compassAngle: 90, dimension: 'minecraft:overworld' })
  assert.match(south.modelName, /compass_24$/)

  const clock = new Item(mc.itemsByName.clock.id, 1)
  assert.match(ctx.items.quadsForStack(clock, 'gui', { dayTime: 18000, dimension: 'minecraft:overworld' }).modelName, /clock_00$/)

  // Trident: the GUI/ground slot is the real `item/trident` sprite; the in-hand
  // and throwing forms use the real TridentModel geometry + `entity/trident`.
  const trident = new Item(mc.itemsByName.trident.id, 1)
  const guiTrident = ctx.items.quadsForStack(trident, 'gui', {})
  assert.equal(guiTrident.kind, 'generated')
  assert.match(guiTrident.modelName, /item\/trident$/)
  for (const context of ['thirdperson_righthand', 'firstperson_righthand']) {
    const held = ctx.items.quadsForStack(trident, context, { usingItem: false })
    assert.equal(held.specialKind, 'trident')
    assert.equal(held.quads.length, 30)
    assert.ok(held.textures.some((t) => /entity\/trident/.test(t.name)))
    const ys = held.quads.flatMap((q) => q.pos.map((p) => p[1]))
    assert.ok(Math.max(...ys) - Math.min(...ys) > 1.5, 'the trident keeps its real ~1.9 block length')
  }
  assert.equal(ctx.items.quadsForStack(trident, 'thirdperson_righthand', { usingItem: true }).specialKind, 'trident')

  // Spawn eggs use the template + two constant tints from the client data.
  const egg = ctx.items.bake('cow_spawn_egg')
  assert.ok(egg, 'spawn egg bakes')
  assert.ok(egg.quads.length > 20)
  assert.equal(egg.textures.length, 2)
})

test('12e: metadata helper reads every shape mineflayer and captures produce', () => {
  const wolf = {
    name: 'wolf',
    metadata: { 17: 0x04, 22: 1 } // index-keyed object (mineflayer)
  }
  assert.equal(metaValue(wolf, mc, 'variant'), 1)
  assert.equal(metaValue({ name: 'wolf', metadata: [{ key: 22, value: 3 }] }, mc, 'variant'), 3)
  assert.equal(metaValue({ name: 'wolf', metadata: [] }, mc, 'variant', 'fallback'), 'fallback')
})
