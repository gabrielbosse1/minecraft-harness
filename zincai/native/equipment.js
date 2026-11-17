/**
 * zincai/native/equipment.js — equipped armour, elytra and trims.
 *
 * Equipped items are not inventory sprites: the client renders them on the
 * humanoid model using the *equipment* assets introduced in 1.21.2. Each armour
 * item carries a `minecraft:equippable` component whose `asset_id` names a
 * definition in `assets/<ns>/equipment/<id>.json`:
 *
 *   { "layers": { "humanoid": [ { "texture": "minecraft:iron" } ],
 *                 "humanoid_leggings": [ ... ] } }
 *
 * The textures live at `textures/entity/equipment/humanoid/<name>.png`
 * (64x32, the classic armour UV layout: head (0,0), body (16,16), arm (40,16),
 * leg (0,16)). Trims are palette permutations of
 * `textures/trims/entity/humanoid/<pattern>.png` in the trim material's
 * palette, exactly like the atlas does.
 *
 * Nothing here guesses colours or invents textures: if the equipment definition
 * or texture is missing, the slot is reported instead of drawn.
 */
'use strict'

const { tintedTexture } = require('./specialModels')

// Slots used by the client's equipment renderer.
const SLOTS = ['head', 'chest', 'legs', 'feet', 'body']

// Fallback map for stacks whose components are not exposed by the protocol
// layer. 1.21.4 armour ids and their equipment asset ids are stable.
const ARMOR_ITEMS = {
  leather_helmet: { asset: 'leather', slot: 'head', dyeable: true },
  leather_chestplate: { asset: 'leather', slot: 'chest', dyeable: true },
  leather_leggings: { asset: 'leather', slot: 'legs', dyeable: true },
  leather_boots: { asset: 'leather', slot: 'feet', dyeable: true },
  chainmail_helmet: { asset: 'chainmail', slot: 'head' },
  chainmail_chestplate: { asset: 'chainmail', slot: 'chest' },
  chainmail_leggings: { asset: 'chainmail', slot: 'legs' },
  chainmail_boots: { asset: 'chainmail', slot: 'feet' },
  iron_helmet: { asset: 'iron', slot: 'head' },
  iron_chestplate: { asset: 'iron', slot: 'chest' },
  iron_leggings: { asset: 'iron', slot: 'legs' },
  iron_boots: { asset: 'iron', slot: 'feet' },
  golden_helmet: { asset: 'gold', slot: 'head' },
  golden_chestplate: { asset: 'gold', slot: 'chest' },
  golden_leggings: { asset: 'gold', slot: 'legs' },
  golden_boots: { asset: 'gold', slot: 'feet' },
  diamond_helmet: { asset: 'diamond', slot: 'head' },
  diamond_chestplate: { asset: 'diamond', slot: 'chest' },
  diamond_leggings: { asset: 'diamond', slot: 'legs' },
  diamond_boots: { asset: 'diamond', slot: 'feet' },
  netherite_helmet: { asset: 'netherite', slot: 'head' },
  netherite_chestplate: { asset: 'netherite', slot: 'chest' },
  netherite_leggings: { asset: 'netherite', slot: 'legs' },
  netherite_boots: { asset: 'netherite', slot: 'feet' },
  turtle_helmet: { asset: 'turtle_scute', slot: 'head' },
  wolf_armor: { asset: 'wolf_body', slot: 'body' },
  elytra: { asset: 'elytra', slot: 'chest', wings: true }
}

// Armour texture UV layout (64x32). Bone name → texture offset.
const ARMOR_UV = {
  head: [0, 0],
  body: [16, 16],
  rightArm: [40, 16],
  leftArm: [40, 16],
  rightLeg: [0, 16],
  leftLeg: [0, 16]
}

// Which humanoid bones each armour piece covers (vanilla HumanoidArmorModel).
const PART_BONES = {
  head: ['head'],
  chest: ['body', 'rightArm', 'leftArm'],
  legs: ['body', 'rightLeg', 'leftLeg'],
  feet: ['rightLeg', 'leftLeg'],
  body: ['body']
}

function componentOf (item, name) {
  if (!item) return null
  const key = String(name).replace(/^minecraft:/, '')
  try {
    if (item.componentMap?.has?.(key)) return item.componentMap.get(key).data ?? true
    if (Array.isArray(item.components)) {
      const found = item.components.find((c) => c?.type === key || c?.type === `minecraft:${key}`)
      if (found) return found.data ?? true
    }
    const comps = item.components?.value
    if (comps && typeof comps === 'object') {
      const v = comps[key] || comps[`minecraft:${key}`]
      if (v !== undefined) return v?.value ?? v
    }
  } catch { /* unknown component shape */ }
  return null
}

/** Resolve the equipment (armour) view of a stack. */
function equipmentOf (item, name = null) {
  if (!item && !name) return null
  const id = String(name || item?.name || '')
  const equippable = componentOf(item, 'equippable')
  let asset = null
  let slot = null
  if (equippable && typeof equippable === 'object') {
    asset = equippable.asset_id ? String(equippable.asset_id).replace(/^minecraft:/, '') : null
    slot = equippable.slot ? String(equippable.slot).replace(/^minecraft:/, '') : null
  }
  const fallback = ARMOR_ITEMS[id]
  if (!asset && fallback) asset = fallback.asset
  if (!slot && fallback) slot = fallback.slot
  if (!asset || !SLOTS.includes(slot)) return null
  let dyeColor = componentOf(item, 'dyed_color')
  if (dyeColor && typeof dyeColor === 'object') dyeColor = dyeColor.rgb ?? dyeColor.value ?? null
  return {
    itemId: id,
    assetId: asset,
    slot,
    // Leather without the `dyed_color` component keeps the definition's
    // `color_when_undyed`; only the component (present, even if black) counts.
    dyeColor: dyeColor != null && Number.isFinite(Number(dyeColor)) ? Number(dyeColor) : null,
    trim: trimOf(item),
    wings: Boolean(fallback?.wings)
  }
}

/** `minecraft:trim` component → { material, pattern }. */
function trimOf (item) {
  const trim = componentOf(item, 'trim')
  if (!trim) return null
  const pattern = trim.pattern ? String(trim.pattern).replace(/^minecraft:/, '').replace(/^.*\//, '') : null
  const material = trim.material ? String(trim.material).replace(/^minecraft:/, '').replace(/^.*\//, '') : null
  if (!pattern || !material) return null
  return { pattern, material }
}

/**
 * Resolve the texture layers for an equipped armour piece, in draw order.
 * Returns `{ layers: [{ texture, layer, dyeable, trim }], notes, missing }`.
 */
function resolveArmorLayers (equipment, { assets, playerSkinColor = null } = {}) {
  const out = { layers: [], notes: [], missing: null }
  if (!equipment || !assets) return out
  const def = assets.equipmentDefinition?.(equipment.assetId)
  if (!def) {
    out.missing = `no equipment definition for ${equipment.assetId}`
    return out
  }
  const groups = []
  // Humanoid armour: helmet/chest/boots use `humanoid`, leggings use
  // `humanoid_leggings`. Horse/wolf/llama bodies use their own layer group.
  if (equipment.slot === 'legs') groups.push(['humanoid_leggings', PART_BONES.legs])
  else if (equipment.slot === 'head') groups.push(['humanoid', PART_BONES.head])
  else if (equipment.slot === 'chest') groups.push(['humanoid', PART_BONES.chest])
  else if (equipment.slot === 'feet') groups.push(['humanoid', PART_BONES.feet])
  else if (equipment.slot === 'body') groups.push(['humanoid', PART_BONES.body])

  // Elytra (and other wing gear) are not humanoid plates: they are their own
  // `wings` layer group with the ElytraModel geometry.
  if (def.layers?.wings?.length) {
    const texName = String(def.layers.wings[0].texture || '').replace(/^minecraft:/, '') || 'elytra'
    const texture = assets.entityTexture(`entity/equipment/wings/${texName}`) ||
      assets.entityTexture(`entity/${texName}`)
    if (texture) out.layers.push({ texture, layerGroup: 'wings', bones: ['body'], wings: true, deformation: 1 })
    else out.notes.push(`missing elytra texture entity/equipment/wings/${texName}`)
  }

  for (const [layerGroup, bones] of groups) {
    const layers = def.layers?.[layerGroup] || def.layers?.humanoid || []
    for (const layer of layers) {
      const texName = String(layer.texture || '').replace(/^minecraft:/, '')
      if (!texName) continue
      let texture = assets.entityTexture(`entity/equipment/${layerGroup}/${texName}`) ||
        assets.entityTexture(`entity/equipment/humanoid/${texName}`)
      if (!texture) {
        out.notes.push(`missing armour texture entity/equipment/${layerGroup}/${texName}`)
        continue
      }
      let dyed = false
      if (layer.dyeable) {
        const color = Number.isFinite(equipment.dyeColor)
          ? equipment.dyeColor
          : (Number.isFinite(layer.dyeable?.color_when_undyed) ? layer.dyeable.color_when_undyed : null)
        if (Number.isFinite(color)) {
          const rgb = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
          texture = tintedTexture(texture, rgb)
          dyed = true
        }
      }
      out.layers.push({
        texture,
        layerGroup,
        bones,
        dyeable: Boolean(layer.dyeable),
        dyed,
        deformation: equipment.slot === 'legs' ? 0.5 : 1.0
      })
    }
  }

  if (equipment.trim) {
    const trimTex = assets.trimTexture?.('humanoid', equipment.trim.pattern, equipment.trim.material) ||
      assets.trimTexture?.('humanoid_leggings', equipment.trim.pattern, equipment.trim.material)
    if (trimTex) {
      out.layers.push({
        texture: trimTex,
        layerGroup: 'trim',
        bones: equipment.slot === 'legs' ? PART_BONES.legs : PART_BONES[equipment.slot] || PART_BONES.chest,
        trim: true,
        deformation: (equipment.slot === 'legs' ? 0.5 : 1.0) + 0.5
      })
    } else {
      out.notes.push(`trim ${equipment.trim.pattern}/${equipment.trim.material} texture unavailable`)
    }
  }
  return out
}

/** Elytra wings (ElytraModel): two 10x20x2 sheets on the back. */
function elytraQuads (assets, bones) {
  const tex = assets.entityTexture('entity/equipment/wings/elytra') || assets.entityTexture('entity/elytra')
  if (!tex) return { quads: [], notes: ['elytra texture missing'] }
  const { cubeQuads } = require('./boxGeometry')
  const quads = []
  const layer = tex.hasSemiAlpha ? 'translucent' : 'cutout'
  for (const [name, mirror] of [['rightWing', false], ['leftWing', true]]) {
    const w = cubeQuads({
      origin: [-10, 0, 0],
      size: [10, 20, 2],
      uv: [22, 0],
      tex
    }, { layer, shade: true, mirrorU: mirror })
    for (const q of w) {
      quads.push({
        ...q,
        bone: name,
        chain: [{ name, pivot: [0, 24, 2], rotation: [0, 0, 0], staticRotation: [0, 0, 0] }],
        armorLayer: true,
        tex
      })
    }
  }
  return { quads, notes: [], bones }
}

module.exports = {
  SLOTS,
  ARMOR_ITEMS,
  ARMOR_UV,
  PART_BONES,
  equipmentOf,
  trimOf,
  componentOf,
  resolveArmorLayers,
  elytraQuads
}
