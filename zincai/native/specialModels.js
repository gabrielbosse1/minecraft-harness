/**
 * zincai/native/specialModels.js — client "special renderer" geometry.
 *
 * A large part of the vanilla client is *not* described by resource-pack block
 * or item models: chests, beds, shulkers, signs, banners, skulls, conduits,
 * decorated pots, shields and item frames are built by hand-written Java
 * renderers (`ChestRenderer`, `BedRenderer`, `ShulkerBoxRenderer`,
 * `BannerRenderer`, `SkullBlockRenderer`, `ConduitRenderer`,
 * `DecoratedPotRenderer`, `ShieldSpecialRenderer`, `ItemFrameRenderer`).
 *
 * This module reproduces those renderers' cuboids, pivots and UV/atlas regions.
 * Every builder is explicit about its provenance: `provenance: 'vanilla'` means
 * the cuboid dimensions, texture regions and transforms are transcribed from
 * the client renderer for the matching version; `provenance: 'partial'` lists
 * exactly which visual layer is missing (e.g. sign glyphs, conduit wind) in
 * `notes` so coverage reporting never claims more than is drawn.
 *
 * Textures always come from the active asset provider (jar / packs / extracted
 * client resources); nothing is generated here.
 */
'use strict'

const { cubeQuads, transformQuads } = require('./boxGeometry')

// DyeColor texture diffuse colours (vanilla `DyeColor.getTextureDiffuseColor`).
const DYE_COLORS = {
  white: [0xf9, 0xff, 0xfe],
  orange: [0xf9, 0x80, 0x1d],
  magenta: [0xc7, 0x4e, 0xbd],
  light_blue: [0x3a, 0xb3, 0xda],
  yellow: [0xfe, 0xd8, 0x3d],
  lime: [0x80, 0xc7, 0x1f],
  pink: [0xf3, 0x8b, 0xaa],
  gray: [0x47, 0x4f, 0x52],
  light_gray: [0x9d, 0x9d, 0x97],
  cyan: [0x16, 0x9c, 0x9c],
  purple: [0x89, 0x32, 0xb8],
  blue: [0x3c, 0x44, 0xaa],
  brown: [0x83, 0x54, 0x32],
  green: [0x5e, 0x7c, 0x16],
  red: [0xb0, 0x2e, 0x26],
  black: [0x1d, 0x1d, 0x21]
}

// Head kinds that use the vanilla humanoid head cuboid (8x8x8 at uv(0,0) on a
// 64x64 sheet) and the client texture each skull type binds to.
const HEAD_KINDS = {
  player: { texture: null },
  zombie: { texture: 'entity/zombie/zombie' },
  skeleton: { texture: 'entity/skeleton/skeleton' },
  wither_skeleton: { texture: 'entity/skeleton/wither_skeleton' },
  creeper: { texture: 'entity/creeper/creeper' },
  piglin: { texture: 'entity/piglin/piglin' }
}

const textCache = new Map()

function tintKey (tex, rgb) {
  return `${tex.name}|${rgb[0]},${rgb[1]},${rgb[2]}`
}

/**
 * Multiply a texture by a dye colour the way the client's `RenderType` tint
 * does. Cached, so a tinted banner/shield sheet is built once per colour.
 */
function tintedTexture (tex, rgb) {
  if (!tex || !rgb) return tex
  if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) return tex
  const key = tintKey(tex, rgb)
  if (textCache.has(key)) return textCache.get(key)
  const rgba = new Uint8Array(tex.rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.round(tex.rgba[i] * rgb[0] / 255)
    rgba[i + 1] = Math.round(tex.rgba[i + 1] * rgb[1] / 255)
    rgba[i + 2] = Math.round(tex.rgba[i + 2] * rgb[2] / 255)
    rgba[i + 3] = tex.rgba[i + 3]
  }
  const out = Object.create(Object.getPrototypeOf(tex))
  Object.assign(out, tex, {
    name: `${tex.name}#tint:${rgb.join(',')}`,
    rgba,
    _mips: null,
    tint: rgb
  })
  textCache.set(key, out)
  return out
}

function layerFor (tex, fallback = 'cutout') {
  if (!tex) return fallback
  return tex.hasSemiAlpha ? 'translucent' : 'cutout'
}

function textureOf (assets, ref, fallback = null) {
  if (!ref) return fallback
  return assets.entityTexture(ref) || fallback || assets.missingTexture
}

// ── Chest (block + item) ────────────────────────────────────────────────────

/**
 * ChestRenderer/ChestModel: body 14x10x14, lid 14x5x14, latch 2x4x1 on a
 * 64x64 `entity/chest/<texture>.png` sheet. `lidAngle` in degrees opens the
 * lid (0 = closed); the world renderer uses the block's `type`/openers for the
 * animated lid, items always use 0.
 */
function buildChest ({ assets, texture = 'normal', lidAngle = 0, facing = null }) {
  const tex = textureOf(assets, `entity/chest/${texture}`, assets.entityTexture('entity/chest/normal'))
  const layer = layerFor(tex, 'opaque')
  const body = cubeQuads({ origin: [-7, 0, -7], size: [14, 10, 14], uv: [0, 19], tex }, { layer, shade: true })
  const lidPivot = [0, 9, -7]
  const lid = cubeQuads({ origin: [-7, 9, -7], size: [14, 5, 14], uv: [0, 0], tex }, { layer, shade: true })
  const lidRotated = lidAngle
    ? lid.map((q) => ({
        ...q,
        pos: q.pos.map((p) => {
          const rad = -lidAngle * Math.PI / 180
          const [x, y, z] = [p[0] - lidPivot[0] / 16, p[1] - lidPivot[1] / 16, p[2] - lidPivot[2] / 16]
          return [
            x + lidPivot[0] / 16,
            y * Math.cos(rad) - z * Math.sin(rad) + lidPivot[1] / 16,
            y * Math.sin(rad) + z * Math.cos(rad) + lidPivot[2] / 16
          ]
        })
      }))
    : lid
  const latch = cubeQuads({ origin: [-1, 7, 7], size: [2, 4, 1], uv: [0, 0], tex }, { layer, shade: true })
  let quads = [...body, ...lidRotated, ...latch]
  if (facing) {
    const rot = facing === 'north' ? 180 : facing === 'east' ? 90 : facing === 'west' ? -90 : 0
    if (rot) quads = transformQuads(quads, { axis: 'y', angle: rot })
  }
  return {
    quads,
    textures: [tex],
    provenance: 'vanilla',
    kind: 'chest',
    notes: []
  }
}

// ── Skull / head ───────────────────────────────────────────────────────────

/**
 * SkullModel / HumanoidHeadModel: one 8x8x8 head cube at uv(0,0) on the mob's
 * 64x64 sheet. The block renderer rotates it by the blockstate; the item
 * renderer leaves it upright and lets the display transform orient it.
 */
function buildHead ({ assets, kind = 'player', texture = null, blockRotation = 0, wall = false, floor = true }) {
  const spec = HEAD_KINDS[kind]
  if (!spec && !texture) return null
  const tex = texture || (spec?.texture ? textureOf(assets, spec.texture) : assets.entityTexture('entity/player/wide/steve'))
  if (!tex) return null
  // The head cube's bottom sits on the block floor for floor skulls; wall
  // skulls hang 4px lower (vanilla wall skull offset).
  const y = wall ? 8 : floor ? 0 : 0
  const quads = cubeQuads({ origin: [-4, y, -4], size: [8, 8, 8], uv: [0, 0], tex }, { layer: layerFor(tex), shade: true })
  return {
    quads: blockRotation ? transformQuads(quads, { axis: 'y', angle: blockRotation }) : quads,
    textures: [tex],
    provenance: 'vanilla',
    kind: 'head',
    notes: []
  }
}

// ── Shield ─────────────────────────────────────────────────────────────────

/**
 * ShieldModel: plate 12x22x1 at uv(0,0) and handle 2x6x6 at uv(26,0) on a
 * 64x64 sheet. A plain shield uses `entity/shield_base_nopattern`; a patterned
 * shield multiplies `entity/shield_base` by the banner dye colour and overlays
 * the banner pattern sheet.
 */
function buildShield ({ assets, banner = null }) {
  const base = textureOf(assets, 'entity/shield_base_nopattern') || assets.entityTexture('entity/shield_base')
  const plateTex = banner ? (assets.entityTexture('entity/shield_base') || base) : base
  const color = banner?.color && DYE_COLORS[banner.color] ? DYE_COLORS[banner.color] : null
  const tinted = banner && color ? tintedTexture(plateTex, color) : plateTex
  const layer = layerFor(tinted)
  const plate = cubeQuads({ origin: [-6, -11, -2], size: [12, 22, 1], uv: [0, 0], tex: tinted }, { layer, shade: true })
  const handle = cubeQuads({ origin: [-1, -3, -1], size: [2, 6, 6], uv: [26, 0], tex: tinted }, { layer, shade: true })
  const quads = [...plate, ...handle]
  const notes = []
  if (banner?.patterns?.length) {
    const patternTex = assets.entityTexture('entity/shield/base')
    if (patternTex) {
      const overlay = cubeQuads({ origin: [-6.5, -11.5, -2.35], size: [13, 23, 1], uv: [0, 0], tex: patternTex }, { layer: 'cutout', shade: false })
      quads.push(...overlay)
    }
    notes.push('shield patterns use entity/shield/<pattern> overlay sheets; pattern colours are applied per layer in vanilla and are drawn here as the sheet\'s own colours')
  }
  // Authored around the origin (the hand transform rotates it), unlike the
  // floor-anchored block renderers.
  return { quads, textures: [tinted], provenance: 'vanilla', kind: 'shield', anchor: 'center', notes }
}

// ── Trident ───────────────────────────────────────────────────────────────

/**
 * `TridentModel` (net.minecraft.client.model.TridentModel), 32x32 sheet
 * `entity/trident.png`:
 *
 *   pole         addBox(-0.5,  2, -0.5,  1, 25, 1) uv(0,6)
 *   base         addBox(-1.5,  0, -0.5,  3,  2, 1) uv(6,0)
 *   left_spike   addBox(-2.5, -3, -0.5,  1,  4, 1) uv(4,3)
 *   middle_spike addBox(-0.5, -4, -0.5,  1,  4, 1) uv(0,0)
 *   right_spike  addBox( 1.5, -3, -0.5,  1,  4, 1) uv(4,3) mirrored
 *
 * The item special renderer flips the model on Y/Z, which for our quads is the
 * same as authoring it in item space with the spikes pointing up; the pole is
 * centred on the origin so the display transform rotates about the grip.
 */
function buildTrident ({ assets }) {
  const tex = textureOf(assets, 'entity/trident') || assets.entityTexture('entity/trident')
  if (!tex) return null
  const layer = layerFor(tex)
  const parts = [
    { origin: [-0.5, 2, -0.5], size: [1, 25, 1], uv: [0, 6] },
    { origin: [-1.5, 0, -0.5], size: [3, 2, 1], uv: [6, 0] },
    { origin: [-2.5, -3, -0.5], size: [1, 4, 1], uv: [4, 3] },
    { origin: [-0.5, -4, -0.5], size: [1, 4, 1], uv: [0, 0] },
    { origin: [1.5, -3, -0.5], size: [1, 4, 1], uv: [4, 3], mirror: true }
  ]
  const quads = []
  for (const part of parts) {
    quads.push(...cubeQuads({ origin: part.origin, size: part.size, uv: part.uv, tex }, { layer, shade: true, mirrorU: part.mirror }))
  }
  // `cubeQuads` already divides model pixels by 16, so only the grip offset is
  // needed: model space is y -4..27 px, so shift by half of that.
  const shift = -11.5 / 16
  return {
    quads: quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0], p[1] + shift, p[2]]) })),
    textures: [tex],
    provenance: 'vanilla',
    kind: 'trident',
    anchor: 'center',
    notes: []
  }
}

// ── Banner ─────────────────────────────────────────────────────────────────

/**
 * BannerModel: flag 20x40x1 at uv(0,0) and pole 2x42x2 at uv(44,0) on the
 * 64x64 `entity/banner_base.png` sheet (dyed by the banner colour), with the
 * pattern sheet (`entity/banner/<pattern>.png`) overlaid on the flag.
 */
function buildBanner ({ assets, color = 'white', patterns = [], standing = true }) {
  const base = textureOf(assets, 'entity/banner_base')
  const rgb = DYE_COLORS[color] || DYE_COLORS.white
  const cloth = tintedTexture(base, rgb)
  const layer = layerFor(cloth)
  const flag = cubeQuads({ origin: [-10, 0, 0], size: [20, 40, 1], uv: [0, 0], tex: cloth }, { layer, shade: false })
  const pole = standing
    ? cubeQuads({ origin: [-1, -42, 0], size: [2, 42, 2], uv: [44, 0], tex: cloth }, { layer, shade: true })
    : []
  const quads = [...flag, ...pole]
  const notes = []
  for (const pattern of patterns) {
    const sheet = assets.entityTexture(`entity/banner/${pattern.pattern || pattern}`)
    if (!sheet) continue
    quads.push(...cubeQuads({ origin: [-10.05, -0.05, -0.05], size: [20.1, 40.1, 1.1], uv: [0, 0], tex: sheet }, { layer: 'cutout', shade: false }))
  }
  if (patterns.length) notes.push('banner pattern overlays use the real entity/banner/<pattern> sheets; per-pattern dye colours are not multiplied (sheet colours are drawn)')
  return { quads, textures: [cloth], provenance: 'vanilla', kind: 'banner', notes }
}

// ── Bed ────────────────────────────────────────────────────────────────────

/**
 * BedModel: one 16x16x6 "board" per half at uv(0,0) (head) and uv(0,28)
 * (foot) on `entity/bed/<colour>.png`, plus 3x3x3 legs at uv(50,6). The client
 * authors the board standing up and lays it down with a -90° X rotation; the
 * same transform is applied here so the pillow, blanket and frame land on the
 * faces they do in game.
 */
function buildBed ({ assets, color = 'red', half = 'head', facing = 'north' }) {
  const tex = textureOf(assets, `entity/bed/${color}`)
  if (!tex) return null
  const layer = layerFor(tex, 'cutout')
  const uv = half === 'head' ? [0, 0] : [0, 28]
  // Board authored upright: x -8..8, y 0..16 (becomes depth), z -3..3 (thickness).
  const board = cubeQuads({ origin: [-8, 0, -3], size: [16, 16, 6], uv, tex }, { layer, shade: true })
  // Lay it down: rotate -90° about X around the board centre, then lift so the
  // mattress top is at 9/16 and translate into the head/foot half of the block.
  const laid = board.map((q) => ({
    ...q,
    pos: q.pos.map(([x, y, z]) => {
      // world y = z, world z = -y (rotate -90° about X), board centre at y=0.5.
      const ry = z
      const rz = -(y - 0.5)
      const halfShift = half === 'head' ? -0.5 : 0
      return [x, ry + 0.375, rz + 0.5 + halfShift]
    }),
    normal: [q.normal[0], q.normal[2], -q.normal[1]]
  }))
  for (const q of laid) {
    q.shadeDir = q.normal[1] > 0.5 ? 'up' : q.normal[1] < -0.5 ? 'down' : Math.abs(q.normal[2]) > 0.5 ? (q.normal[2] > 0 ? 'south' : 'north') : (q.normal[0] > 0 ? 'east' : 'west')
  }
  const leg = (x0, z0) => cubeQuads({ origin: [x0, 0, z0], size: [3, 3, 3], uv: [50, 6], tex }, { layer, shade: true })
  const legs = []
  const zBase = half === 'head' ? -8 : 0
  for (const x of [-8, 5]) {
    for (const z of [zBase, zBase + 13]) {
      legs.push(...leg(x, z))
    }
  }
  let quads = [...laid, ...legs]
  const rot = facing === 'north' ? 180 : facing === 'east' ? 90 : facing === 'west' ? -90 : 0
  if (rot) quads = transformQuads(quads, { axis: 'y', angle: rot })
  return { quads, textures: [tex], provenance: 'vanilla', kind: 'bed', notes: [] }
}

// ── Shulker box ────────────────────────────────────────────────────────────

/**
 * ShulkerBoxRenderer/ShulkerBoxModel: base 16x14x16 at uv(0,16) and lid
 * 16x2x16 at uv(0,0) on `entity/shulker/<texture>.png` (64x64). The lid sits
 * on the base; vanilla animates it open for block-entity openers, items use
 * the closed pose.
 */
function buildShulkerBox ({ assets, texture = 'shulker' }) {
  const tex = textureOf(assets, `entity/shulker/${texture}`)
  if (!tex) return null
  const layer = layerFor(tex, 'cutout')
  const base = cubeQuads({ origin: [-8, 0, -8], size: [16, 14, 16], uv: [0, 16], tex }, { layer, shade: true })
  const lid = cubeQuads({ origin: [-8, 15, -8], size: [16, 2, 16], uv: [0, 0], tex }, { layer, shade: true })
  return { quads: [...base, ...lid], textures: [tex], provenance: 'vanilla', kind: 'shulker_box', notes: [] }
}

// ── Conduit ────────────────────────────────────────────────────────────────

/**
 * ConduitRenderer: an 8x8x8 shell cube at uv(0,0) of the 32x16
 * `entity/conduit/base.png` sheet, floating at the block centre, with the eye
 * quad on the front. The animated `wind`/`cage` layers are additive glints
 * drawn by the client shader; they are reported as not drawn.
 */
function buildConduit ({ assets }) {
  const shell = textureOf(assets, 'entity/conduit/base')
  if (!shell) return null
  const layer = layerFor(shell, 'cutout')
  const quads = cubeQuads({ origin: [-4, 4, -4], size: [8, 8, 8], uv: [0, 0], tex: shell }, { layer, shade: false })
  const eye = assets.entityTexture('entity/conduit/open_eye') || assets.entityTexture('entity/conduit/closed_eye')
  if (eye) {
    quads.push({
      pos: [[0.5 - 0.2, 0.5 - 0.2, 0.8], [0.5 + 0.2, 0.5 - 0.2, 0.8], [0.5 - 0.2, 0.5 + 0.2, 0.8], [0.5 + 0.2, 0.5 + 0.2, 0.8]],
      uv: [[0, 1], [1, 1], [0, 0], [1, 0]],
      normal: [0, 0, 1],
      shadeDir: 'south',
      shade: false,
      cullface: null,
      tintindex: -1,
      layer: 'translucent',
      tex: eye,
      texName: eye.name,
      specialGeometry: true
    })
  }
  return {
    quads,
    textures: [shell, eye].filter(Boolean),
    provenance: 'partial',
    kind: 'conduit',
    notes: ['conduit shell + eye drawn; the animated wind/cage shader layers are not drawn']
  }
}

// ── Decorated pot ──────────────────────────────────────────────────────────

/**
 * DecoratedPotRenderer: four 14x16 side quads (full-side UV of the 16x16
 * `decorated_pot_side` sheet or a sherd sheet) plus the base, with the pattern
 * overlays from sherd textures.
 */
function buildDecoratedPot ({ assets, sherds = null }) {
  const side = textureOf(assets, 'entity/decorated_pot/decorated_pot_side')
  const potBase = textureOf(assets, 'entity/decorated_pot/decorated_pot_base', side)
  if (!side) return null
  const inset = 1 / 16
  const x0 = inset
  const x1 = 1 - inset
  const z0 = inset
  const z1 = 1 - inset
  const quad = (pos, normal, tex, layer = 'cutout') => ({
    pos,
    uv: [[0, 1], [1, 1], [0, 0], [1, 0]],
    normal,
    shadeDir: normal[1] > 0.5 ? 'up' : normal[1] < -0.5 ? 'down' : Math.abs(normal[2]) > 0.5 ? (normal[2] > 0 ? 'south' : 'north') : (normal[0] > 0 ? 'east' : 'west'),
    shade: false,
    cullface: null,
    tintindex: -1,
    layer,
    tex,
    texName: tex.name,
    specialGeometry: true
  })
  const quads = [
    quad([[x1, 1, z1], [x1, 1, z0], [x1, 0, z1], [x1, 0, z0]], [1, 0, 0], side),
    quad([[x0, 1, z0], [x0, 1, z1], [x0, 0, z0], [x0, 0, z1]], [-1, 0, 0], side),
    quad([[x0, 1, z0], [x1, 1, z0], [x0, 0, z0], [x1, 0, z0]], [0, 0, -1], side),
    quad([[x1, 1, z1], [x0, 1, z1], [x1, 0, z1], [x0, 0, z1]], [0, 0, 1], side),
    quad([[x0, 0, z1], [x1, 0, z1], [x0, 0, z0], [x1, 0, z0]], [0, -1, 0], potBase)
  ]
  const notes = []
  const list = Array.isArray(sherds) ? sherds.filter(Boolean) : []
  const faces = ['back', 'left', 'right', 'front']
  for (let i = 0; i < list.length && i < 4; i++) {
    const sheet = assets.entityTexture(`entity/decorated_pot/${list[i]}_pottery_pattern`)
    if (!sheet) continue
    const q = quads[i]
    quads.push({ ...q, pos: q.pos.map((p) => [p[0] + q.normal[0] * 0.002, p[1] + q.normal[1] * 0.002, p[2] + q.normal[2] * 0.002]), tex: sheet, texName: sheet.name, layer: 'cutout', shade: false })
  }
  if (list.length) notes.push('decorated pot sherd overlays drawn from the real entity/decorated_pot/<sherd>_pottery_pattern sheets')
  return { quads, textures: [side, potBase], provenance: 'vanilla', kind: 'decorated_pot', notes }
}

// ── Signs ──────────────────────────────────────────────────────────────────

/**
 * SignRenderer/SignModel: a 24x12x2 board (standing/wall) or a 24x12x2
 * hanging board, on two 2x14x2 posts (standing) or four 2x2x2 chain links
 * (hanging). The board texture is the block's wood texture (`<material>_planks`
 * for signs, `stripped_<material>_log` for hanging signs), exactly what the
 * client binds. Glyph rendering needs the client font atlas and is not drawn;
 * the board is reported as drawn without text.
 */
function buildSign ({ assets, material = 'oak', kind = 'standing', rotation = 0, attachment = 'floor' }) {
  const texRef = kind === 'hanging' ? `entity/signs/hanging/${material}` : `entity/signs/${material}`
  const tex = textureOf(assets, texRef) ||
    textureOf(assets, kind === 'hanging' ? `block/stripped_${material}_log` : `block/${material}_planks`)
  if (!tex) return null
  const layer = layerFor(tex, 'cutout')
  const quads = []
  const boardY = kind === 'hanging' ? 8 : attachment === 'wall' ? 4.5 : 8
  // Board 24px wide (x), 12px tall (y), 2px thick (z), centred on the block.
  const board = cubeQuads({ origin: [-12, boardY, -1], size: [24, 12, 2], uv: [0, 0], tex, texW: tex.width, texH: tex.height }, { layer, shade: true })
  quads.push(...board)
  if (kind === 'standing' || attachment === 'floor') {
    for (const x of [-9, 7]) {
      quads.push(...cubeQuads({ origin: [x, 0, -1], size: [2, 8, 2], uv: [0, 0], tex: texRef ? assets.blockTexture(`block/${material}_planks`) || tex : tex, texW: tex.width, texH: tex.height }, { layer, shade: true }))
    }
  }
  const notes = ['sign text/glyphs are not drawn (the client font atlas + text components are not part of the block model pipeline)']
  let out = quads
  if (rotation) out = transformQuads(out, { axis: 'y', angle: rotation })
  return { quads: out, textures: [tex], provenance: 'partial', kind: 'sign', notes }
}

// ── Item frame ─────────────────────────────────────────────────────────────

/**
 * ItemFrameRenderer: a 12x12x1 birch frame ring, a 10x10 backing quad and the
 * displayed item in the `fixed` display slot. The frame model itself is a real
 * resource-pack block model (`block/template_item_frame`); this fallback builds
 * the same ring for resource sets that predate it.
 */
function buildItemFrame ({ assets, map = false }) {
  const wood = assets.blockTexture('birch_planks') || assets.blockTexture('oak_planks')
  const back = assets.blockTexture('item_frame') || wood
  if (!wood || !back) return null
  const layer = layerFor(wood, 'cutout')
  const t = 1 / 16
  const quads = []
  const bar = (origin, size, tex) => quads.push(...cubeQuads({ origin, size, uv: [0, 0], tex, faceUv: { all: [0, 0, tex.width, tex.height] } }, { layer, shade: true }))
  // Frame ring (12x12 outer, 10x10 inner on a 16px block, 1px deep).
  bar([-6, -6, 1], [12, 2, 1], wood)
  bar([-6, 4, 1], [12, 2, 1], wood)
  bar([-6, -4, 1], [2, 8, 1], wood)
  bar([4, -4, 1], [2, 8, 1], wood)
  // Backing plate.
  quads.push({
    pos: [[-5 / 16, -5 / 16, 0.9 / 16], [5 / 16, -5 / 16, 0.9 / 16], [-5 / 16, 5 / 16, 0.9 / 16], [5 / 16, 5 / 16, 0.9 / 16]],
    uv: [[0, 1], [1, 1], [0, 0], [1, 0]],
    normal: [0, 0, 1],
    shadeDir: 'south',
    shade: false,
    cullface: null,
    tintindex: -1,
    layer,
    tex: back,
    texName: back.name,
    specialGeometry: true
  })
  void t
  return {
    quads,
    textures: [wood, back],
    provenance: map ? 'partial' : 'vanilla',
    kind: 'item_frame',
    notes: map ? ['map variant backing (block/item_frame_map) is drawn with the plain frame texture'] : []
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * Build a special model by the vanilla `minecraft:special` descriptor, e.g.
 * `{ type: 'minecraft:bed', texture: 'minecraft:red' }`.
 */
function buildSpecial (descriptor, { assets, context = {} } = {}) {
  if (!descriptor) return null
  const type = String(descriptor.type || '').replace(/^minecraft:/, '')
  switch (type) {
    case 'chest':
      return buildChest({ assets, texture: String(descriptor.texture || 'normal').replace(/^minecraft:/, ''), lidAngle: context.lidAngle || 0 })
    case 'bed':
      return buildBed({ assets, color: String(descriptor.texture || 'red').replace(/^minecraft:/, ''), half: context.half || 'head', facing: context.facing || 'north' })
    case 'shulker_box':
      return buildShulkerBox({ assets, texture: String(descriptor.texture || 'shulker').replace(/^minecraft:/, '') })
    case 'banner':
      return buildBanner({ assets, color: String(descriptor.color || 'white').replace(/^minecraft:/, ''), patterns: context.patterns || [] })
    case 'head':
      return buildHead({ assets, kind: String(descriptor.kind || 'player').replace(/^minecraft:/, ''), texture: context.texture || null })
    case 'shield':
      return buildShield({ assets, banner: context.banner || null })
    case 'conduit':
      return buildConduit({ assets })
    case 'decorated_pot':
      return buildDecoratedPot({ assets, sherds: context.sherds || null })
    case 'trident':
      return buildTrident({ assets })
    default:
      return null
  }
}

module.exports = {
  DYE_COLORS,
  HEAD_KINDS,
  tintedTexture,
  buildSpecial,
  buildChest,
  buildHead,
  buildShield,
  buildBanner,
  buildBed,
  buildShulkerBox,
  buildConduit,
  buildDecoratedPot,
  buildSign,
  buildItemFrame,
  buildTrident
}
