/**
 * zincai/native/blockModels.js — vanilla blockstate → model → textured quads.
 *
 * This is the resource-driven part of the renderer. For every block state it
 * evaluates the real `blockstates/*.json` (variants, multipart, weighted
 * variants, `x`/`y` rotation, `uvlock`) and the real model JSON (parent
 * inheritance, elements, per-face UVs, face rotation, cullface, tintindex,
 * element rotation), resolving `#texture` variables through the model's
 * texture map to actual files from the client assets.
 *
 * Nothing here is keyed on a guessed colour: a cherry log is cherry because
 * `cherry_log` resolves to `block/cherry_log`, whose parent chain eventually
 * references `block/cherry_log` + `block/cherry_log_top` textures.
 */
'use strict'

const { namespacePath } = require('./assets')

// ── Geometry tables (same vertex/UV corner convention as the client) ────────
// corner = [xFlag, yFlag, zFlag, uFlag, vFlag]; pos = from + flag*(to-from).
const FACES = {
  down: { dir: [0, -1, 0], corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]] },
  up: { dir: [0, 1, 0], corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]] },
  north: { dir: [0, 0, -1], corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]] },
  south: { dir: [0, 0, 1], corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]] },
  west: { dir: [-1, 0, 0], corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]] },
  east: { dir: [1, 0, 0], corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]] }
}

const FACE_NAMES = Object.keys(FACES)
const FACE_SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 }
const FACE_AXIS = { up: 1, down: 1, north: 2, south: 2, east: 0, west: 0 }

/** Vanilla default UVs when a face omits `uv` (from ModelElement/FaceBakery). */
function defaultUv (side, from, to) {
  switch (side) {
    case 'north': return [to[0], 16 - to[1], from[0], 16 - from[1]]
    case 'south': return [from[0], 16 - to[1], to[0], 16 - from[1]]
    case 'east': return [from[2], 16 - to[1], to[2], 16 - from[1]]
    case 'west': return [from[2], 16 - to[1], to[2], 16 - from[1]]
    case 'up': return [from[0], from[2], to[0], to[2]]
    case 'down': return [to[0], from[2], from[0], to[2]]
    default: return [0, 0, 16, 16]
  }
}

function rotate2d (u, v, angle) {
  // Rotate a UV rect's corner offsets by 0/90/180/270 degrees inside the rect.
  switch (((angle % 360) + 360) % 360) {
    case 90: return [v, 1 - u]
    case 180: return [1 - u, 1 - v]
    case 270: return [1 - v, u]
    default: return [u, v]
  }
}

function axisRotate (p, axis, angleDeg) {
  const a = (angleDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const [x, y, z] = p
  if (axis === 'x') return [x, y * c - z * s, y * s + z * c]
  if (axis === 'y') return [x * c + z * s, y, -x * s + z * c]
  return [x * c - y * s, x * s + y * c, z]
}

function rotateVec (v, axis, angleDeg) {
  const r = axisRotate(v, axis, angleDeg)
  const len = Math.hypot(r[0], r[1], r[2]) || 1
  return [r[0] / len, r[1] / len, r[2] / len]
}

function dirFromVec (v) {
  const ax = Math.abs(v[0])
  const ay = Math.abs(v[1])
  const az = Math.abs(v[2])
  if (ax >= ay && ax >= az) return v[0] >= 0 ? 'east' : 'west'
  if (ay >= az) return v[1] >= 0 ? 'up' : 'down'
  return v[2] >= 0 ? 'south' : 'north'
}

// Render layers are block properties in the client (RenderType), not colours.
// Textures are still inspected so packs/modded blocks get correct layers.
const CUTOUT_MIPPED = new Set([
  'glass', 'glass_pane', 'iron_bars', 'iron_door', 'iron_trapdoor', 'ladder',
  'tripwire', 'tripwire_hook', 'lily_pad', 'cobweb', 'chain', 'vine',
  'scaffolding', 'tinted_glass', 'hanging_roots', 'glow_lichen', 'sculk_vein',
  'cave_vines', 'cave_vines_plant', 'spore_blossom', 'amethyst_cluster',
  'small_amethyst_bud', 'medium_amethyst_bud', 'large_amethyst_bud',
  'pointed_dripstone', 'mangrove_roots', 'muddy_mangrove_roots', 'frogspawn',
  'resin_clump', 'leaf_litter', 'short_grass', 'tall_grass', 'fern',
  'large_fern', 'sugar_cane', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'
])
const TRANSLUCENT_BLOCKS = new Set([
  'water', 'bubble_column', 'ice', 'frosted_ice', 'slime_block', 'honey_block',
  'tinted_glass', 'nether_portal', 'end_portal', 'end_gateway'
])
const CUTOUT_NAME = /(leaves|sapling|flower|tulip|dandelion|poppy|orchid|allium|bluet|daisy|lily|sunflower|lilac|peony|rose|bush|wheat|carrot|potato|beetroot|berry|vine|crop|seeds|mushroom|torch|candle|campfire|lantern|rail|redstone_wire|repeater|comparator|sign|banner|door|trapdoor|pane|bars|chain|ladder|cobweb|cactus|kelp|seagrass|azalea|flower_pot|conduit|scaffolding|amethyst|bud|dripstone|chorus|spore_blossom|cave_vines|propagule|roots|frogspawn|lichen|sculk_vein|resin_clump|leaf_litter)/

const SKIP_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void', 'moving_piston'
])

/** Explicit render-layer overrides from the client's block render types. */
function blockLayerOverride (name) {
  if (TRANSLUCENT_BLOCKS.has(name)) return 'translucent'
  if (name.endsWith('_stained_glass') || name.endsWith('_stained_glass_pane')) return 'translucent'
  if (CUTOUT_MIPPED.has(name)) return 'cutout_mipped'
  if (CUTOUT_NAME.test(name)) return 'cutout_mipped'
  return null
}

function quadLayer (tex, override) {
  if (override) return override
  if (tex?.hasSemiAlpha) return 'translucent'
  if (tex?.hasAlpha) return 'cutout_mipped'
  return 'opaque'
}

function layerRank (layer) {
  return layer === 'translucent' ? 3 : layer === 'cutout_mipped' ? 2 : 1
}

// ── Biome tints ─────────────────────────────────────────────────────────────
// Vanilla registers colour providers per block (not "every block with a leaf
// in its name"). Cherry and azalea leaves deliberately have no provider: their
// own textures already carry the pink/green colours.
const GRASS_TINT_BLOCKS = new Set([
  'grass_block', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'potted_fern', 'sugar_cane', 'bush', 'firefly_bush', 'wildflowers', 'leaf_litter'
])
const FOLIAGE_TINT_BLOCKS = new Set([
  'oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves',
  'mangrove_leaves', 'vine'
])
const FIXED_TINT = {
  birch_leaves: [0x80, 0xa7, 0x55],
  spruce_leaves: [0x61, 0x99, 0x61],
  lily_pad: [0x20, 0x80, 0x30],
  attached_melon_stem: [0xe0, 0xc7, 0x1c],
  attached_pumpkin_stem: [0xe0, 0xc7, 0x1c],
  melon_stem: [0x00, 0xff, 0x00],
  pumpkin_stem: [0x00, 0xff, 0x00]
}

// Vanilla biome climate values (data/minecraft/worldgen/biome), used to index
// the real grass/foliage colormaps when a biome does not override its tint.
const BIOME_CLIMATE = {
  plains: [0.8, 0.4], sunflower_plains: [0.8, 0.4], forest: [0.7, 0.8],
  flower_forest: [0.7, 0.8], birch_forest: [0.6, 0.6], old_growth_birch_forest: [0.6, 0.6],
  dark_forest: [0.7, 0.8], taiga: [0.25, 0.8], old_growth_pine_taiga: [0.3, 0.8],
  old_growth_spruce_taiga: [0.25, 0.8], snowy_taiga: [-0.5, 0.4], snowy_plains: [0.0, 0.5],
  ice_spikes: [0.0, 0.5], snowy_beach: [0.05, 0.3], snowy_slopes: [-0.3, 0.9],
  grove: [-0.2, 0.8], jagged_peaks: [-0.7, 0.9], frozen_peaks: [-0.7, 0.9],
  stony_peaks: [1.0, 0.3], meadow: [0.5, 0.8], cherry_grove: [0.5, 0.8],
  jungle: [0.95, 0.9], sparse_jungle: [0.95, 0.8], bamboo_jungle: [0.95, 0.9],
  savanna: [1.2, 0.0], savanna_plateau: [1.0, 0.0], windswept_savanna: [1.1, 0.0],
  desert: [2.0, 0.0], badlands: [2.0, 0.0], eroded_badlands: [2.0, 0.0],
  wooded_badlands: [2.0, 0.0], beach: [0.8, 0.4], stony_shore: [0.2, 0.3],
  swamp: [0.8, 0.9], mangrove_swamp: [0.8, 0.9], lush_caves: [0.5, 0.5],
  dripstone_caves: [0.8, 0.4], river: [0.8, 0.4], ocean: [0.5, 0.5],
  warm_ocean: [0.5, 0.5], lukewarm_ocean: [0.5, 0.5], cold_ocean: [0.5, 0.5],
  frozen_ocean: [0.0, 0.5], mushroom_fields: [0.9, 1.0], the_void: [0.5, 0.5],
  pale_garden: [0.7, 0.8]
}

function rgbFromInt (n) {
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// ── Model resolution ────────────────────────────────────────────────────────

class BlockModelStore {
  constructor (bot, assets, opts = {}) {
    this.bot = bot
    this.assets = assets
    this.registry = bot.registry
    this.version = String(bot.version || assets.version || '')
    this.debug = Boolean(opts.debug)

    let Block = null
    try { Block = require('prismarine-block')(this.version) } catch { Block = null }
    this.Block = Block

    this._sourceCache = new Map()
    this._bakedCache = new Map()
    this._stateCache = new Map()
    this._statePropsCache = new Map()
    this._tints = bot.registry?.tints || null
    this._tintIndex = null
    this._colormapCache = new Map()
    this.stats = {
      states: 0,
      models: 0,
      variants: 0,
      multipart: 0,
      missingModels: 0,
      fallbacks: new Map(),
      missingTextures: new Set(),
      specialRenderers: new Set()
    }
  }

  stateName (stateId) {
    return this.registry?.blocksByStateId?.[stateId]?.name || 'air'
  }

  stateProps (stateId) {
    if (this._statePropsCache.has(stateId)) return this._statePropsCache.get(stateId)
    let props = {}
    try {
      if (this.Block) {
        const b = this.Block.fromStateId(stateId, 0)
        if (b && typeof b.getProperties === 'function') props = b.getProperties()
      }
    } catch { props = {} }
    this._statePropsCache.set(stateId, props)
    return props
  }

  /** Resolve the model parent chain, merging textures/elements like vanilla. */
  resolveSource (ref, depth = 0) {
    if (!ref || depth > 32) return null
    const key = namespacePath(ref)
    if (this._sourceCache.has(key)) return this._sourceCache.get(key)
    const raw = this.assets.model(ref)
    if (!raw) {
      this._sourceCache.set(key, null)
      return null
    }
    const out = {
      ref: key,
      textures: {},
      elements: null,
      ambientocclusion: true,
      shade: true,
      parent: raw.parent || null
    }
    if (raw.parent) {
      const parent = this.resolveSource(raw.parent, depth + 1)
      if (parent) {
        Object.assign(out.textures, parent.textures)
        out.elements = parent.elements
        out.ambientocclusion = parent.ambientocclusion
        out.shade = parent.shade
      }
    }
    if (raw.textures) Object.assign(out.textures, raw.textures)
    if (raw.elements) out.elements = raw.elements
    if (raw.ambientocclusion !== undefined) out.ambientocclusion = raw.ambientocclusion !== false
    if (raw.shade === false) out.shade = false
    this._sourceCache.set(key, out)
    return out
  }

  resolveTextureName (ref, textures, depth = 0) {
    if (ref == null) return null
    let s = String(ref)
    while (s.startsWith('#') && depth < 16) {
      const next = textures[s.slice(1)]
      if (next == null) return null
      s = String(next)
      depth++
    }
    return namespacePath(s)
  }

  textureFor (name) {
    if (!name) return null
    let clean = name
    if (clean.startsWith('block/')) clean = clean.slice(6)
    const tex = this.assets.blockTexture(clean)
    if (!tex) {
      this.stats.missingTextures.add(clean)
      return this.assets.missingTexture
    }
    return tex
  }

  /**
   * Bake one model reference with optional variant rotation.
   * Returns { quads, aabb, texturesUsed, modelName }.
   */
  bake (ref, rotation = {}, special = null) {
    const rotKey = `${namespacePath(ref)}|x${rotation.x || 0}|y${rotation.y || 0}|u${rotation.uvlock ? 1 : 0}|${special || ''}`
    if (this._bakedCache.has(rotKey)) return this._bakedCache.get(rotKey)

    const source = this.resolveSource(ref)
    if (!source) {
      this.stats.missingModels++
      const out = { quads: [], aabb: [0, 0, 0, 1, 1, 1], texturesUsed: [], modelName: namespacePath(ref), missing: true }
      this._bakedCache.set(rotKey, out)
      return out
    }

    const quads = []
    const texturesUsed = new Set()
    const rx = ((rotation.x || 0) % 360 + 360) % 360
    const ry = ((rotation.y || 0) % 360 + 360) % 360
    const uvlock = Boolean(rotation.uvlock)
    const layerOverride = rotation.layerOverride || null

    const pushQuad = (positions, uv, faceName, dir, texRef, face, extra = {}) => {
      const tex = this.textureFor(texRef)
      if (!tex) return
      texturesUsed.add(tex)
      let pts = positions
      let uvOut = uv
      let cull = face.cullface || null
      let normal = dir
      if (extra.rotation) {
        const r = extra.rotation
        const origin = [r.origin[0] / 16, r.origin[1] / 16, r.origin[2] / 16]
        const angle = r.angle || 0
        const rescale = r.rescale !== false
        pts = pts.map((p) => {
          let q = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]
          if (rescale && angle % 90 !== 0) {
            const c = 1 / Math.cos((angle * Math.PI) / 180)
            if (r.axis === 'x') { q[1] *= c; q[2] *= c }
            else if (r.axis === 'y') { q[0] *= c; q[2] *= c }
            else { q[0] *= c; q[1] *= c }
          }
          q = axisRotate(q, r.axis, angle)
          return [q[0] + origin[0], q[1] + origin[1], q[2] + origin[2]]
        })
        normal = rotateVec(dir, r.axis, angle)
        if (cull) cull = dirFromVec(rotateVec(FACES[cull].dir, r.axis, angle))
      }
      // Model-level x/y rotation around the block centre. Vanilla composes
      // X first, then Y (BlockModelRotation), both clockwise-looking.
      if (rx) {
        pts = pts.map((p) => {
          const r = axisRotate([p[0], p[1] - 0.5, p[2] - 0.5], 'x', -rx)
          return [r[0], r[1] + 0.5, r[2] + 0.5]
        })
        normal = rotateVec(normal, 'x', -rx)
        if (cull) cull = dirFromVec(rotateVec(FACES[cull].dir, 'x', -rx))
      }
      if (ry) {
        pts = pts.map((p) => {
          const r = axisRotate([p[0] - 0.5, p[1], p[2] - 0.5], 'y', -ry)
          return [r[0] + 0.5, r[1], r[2] + 0.5]
        })
        normal = rotateVec(normal, 'y', -ry)
        if (cull) cull = dirFromVec(rotateVec(FACES[cull].dir, 'y', -ry))
      }
      if (uvlock && (rx || ry)) {
        // `uvlock` keeps the texture world-aligned: rotate each corner UV by
        // the inverse model rotation around the face centre.
        const steps = Math.round((ry - rx) / 90)
        const n = ((steps % 4) + 4) % 4
        if (n) {
          uvOut = uvOut.map(([u, v]) => {
            let ru = u
            let rv = v
            for (let i = 0; i < n; i++) { const t = ru; ru = rv; rv = 1 - t }
            return [ru, rv]
          })
        }
      }
      const shadeDir = dirFromVec(normal)
      quads.push({
        pos: pts,
        uv: uvOut,
        normal,
        shadeDir,
        shade: (face.shade === false ? false : source.shade) !== false,
        cullface: cull,
        tintindex: Number.isInteger(face.tintindex) ? face.tintindex : -1,
        layer: quadLayer(tex, layerOverride),
        tex,
        texName: texRef,
        extra
      })
    }

    let hasFullElement = false
    if (Array.isArray(source.elements)) {
      for (const el of source.elements) {
        const from = el.from
        const to = el.to
        if (from[0] === 0 && from[1] === 0 && from[2] === 0 &&
            to[0] === 16 && to[1] === 16 && to[2] === 16 &&
            !el.rotation && FACE_NAMES.every((f) => el.faces?.[f])) {
          hasFullElement = true
        }
        for (const side of FACE_NAMES) {
          const face = el.faces?.[side]
          if (!face) continue
          const texRef = this.resolveTextureName(face.texture, source.textures)
          if (!texRef) continue
          let uv = face.uv
          if (!uv) uv = defaultUv(side, from, to)
          else if (!Array.isArray(uv)) uv = uv[side] || defaultUv(side, from, to)
          const uvRect = [uv[0] / 16, uv[1] / 16, uv[2] / 16, uv[3] / 16]
          // Face-level UV rotation (0/90/180/270).
          const faceRotation = face.rotation || 0
          const corners = FACES[side].corners
          const positions = []
          const uvs = []
          for (const c of corners) {
            positions.push([
              (from[0] + c[0] * (to[0] - from[0])) / 16,
              (from[1] + c[1] * (to[1] - from[1])) / 16,
              (from[2] + c[2] * (to[2] - from[2])) / 16
            ])
            let fu = c[3] ? uvRect[2] : uvRect[0]
            let fv = c[4] ? uvRect[3] : uvRect[1]
            if (faceRotation) {
              const [ru, rv] = rotate2d(
                (fu - uvRect[0]) / Math.max(1e-6, uvRect[2] - uvRect[0]),
                (fv - uvRect[1]) / Math.max(1e-6, uvRect[3] - uvRect[1]),
                faceRotation
              )
              fu = uvRect[0] + ru * (uvRect[2] - uvRect[0])
              fv = uvRect[1] + rv * (uvRect[3] - uvRect[1])
            }
            uvs.push([fu, fv])
          }
          pushQuad(positions, uvs, side, FACES[side].dir, texRef, {
            ...face,
            shade: el.shade === false ? false : face.shade !== false
          }, { rotation: el.rotation || null })
        }
      }
    }

    // Models with no elements (or `builtin/entity`) need the client's special
    // renderer. We implement the vanilla geometry for the common cases.
    if (!quads.length && special) {
      for (const q of special) {
        quads.push(q)
        texturesUsed.add(q.tex)
      }
    }

    const aabb = [1, 1, 1, 0, 0, 0]
    for (const q of quads) {
      for (const p of q.pos) {
        aabb[0] = Math.min(aabb[0], p[0]); aabb[1] = Math.min(aabb[1], p[1]); aabb[2] = Math.min(aabb[2], p[2])
        aabb[3] = Math.max(aabb[3], p[0]); aabb[4] = Math.max(aabb[4], p[1]); aabb[5] = Math.max(aabb[5], p[2])
      }
    }
    if (!quads.length) { aabb[0] = aabb[1] = aabb[2] = 0; aabb[3] = aabb[4] = aabb[5] = 1 }

    // A full opaque cube: six directions, full bounds. Grass_block's tinted
    // overlay still counts — it is a full cube for occlusion and culling.
    const dirs = new Set(quads.map((q) => q.shadeDir))
    const fullCube = hasFullElement && quads.length > 0 &&
      aabb[0] <= 1e-6 && aabb[1] <= 1e-6 && aabb[2] <= 1e-6 &&
      aabb[3] >= 1 - 1e-6 && aabb[4] >= 1 - 1e-6 && aabb[5] >= 1 - 1e-6 &&
      dirs.has('up') && dirs.has('down') && dirs.has('north') && dirs.has('south') && dirs.has('east') && dirs.has('west')

    const out = {
      quads,
      aabb,
      texturesUsed: [...texturesUsed],
      modelName: namespacePath(ref),
      fullCube
    }
    this._bakedCache.set(rotKey, out)
    return out
  }

  // ── Vanilla special-renderer geometry (no block model in the resources) ──

  _entityCubeQuads (cube) {
    // cube: {origin (model units, block-centred X/Z), size, uv, tex, texW, texH, inflate}
    const [ox, oy, oz] = cube.origin
    const [sx, sy, sz] = cube.size
    const inflate = cube.inflate || 0
    const texW = cube.texW || 64
    const texH = cube.texH || 64
    const out = []
    for (const side of FACE_NAMES) {
      const { corners } = FACES[side]
      const positions = []
      const uvs = []
      for (const c of corners) {
        let x = ox + c[0] * sx + (c[0] ? inflate : -inflate)
        let y = oy + c[1] * sy + (c[1] ? inflate : -inflate)
        let z = oz + c[2] * sz + (c[2] ? inflate : -inflate)
        if (cube.rotation) {
          const origin = cube.rotation.origin || [0, 0, 0]
          const local = [x - origin[0], y - origin[1], z - origin[2]]
          const r = axisRotate(local, cube.rotation.axis || 'y', cube.rotation.angle || 0)
          x = r[0] + origin[0]; y = r[1] + origin[1]; z = r[2] + origin[2]
        }
        // Model units → block-local, block centre at (0.5, 0, 0.5).
        positions.push([x / 16 + 0.5, y / 16, z / 16 + 0.5])
        // Client entity-cube UV layout (corner/dot scheme).
        const u = (cube.uv[0] + (c[3] ? this._uvDot(side, 'u1', cube.size) : this._uvDot(side, 'u0', cube.size))) / texW
        const v = (cube.uv[1] + (c[4] ? this._uvDot(side, 'v1', cube.size) : this._uvDot(side, 'v0', cube.size))) / texH
        uvs.push([u, v])
      }
      out.push({
        pos: positions,
        uv: uvs,
        normal: FACES[side].dir,
        shadeDir: side,
        shade: true,
        cullface: null,
        tintindex: -1,
        layer: quadLayer(cube.tex, cube.layerOverride || null),
        tex: cube.tex,
        texName: cube.tex.name,
        entityCube: true
      })
    }
    return out
  }

  _uvDot (side, which, size) {
    // Unit vectors from prismarine-viewer's client model UV mapping.
    const table = {
      up: { u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1] },
      down: { u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1] },
      east: { u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1] },
      west: { u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1] },
      north: { u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 1] },
      south: { u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1] }
    }
    const vec = table[side][which]
    return vec[0] * size[0] + vec[1] * size[1] + vec[2] * size[2]
  }

  _specialQuads (name, props) {
    // Fluids: the client uses a fluid renderer, not a block model.
    if (name === 'water' || name === 'lava') {
      const tex = this.textureFor(name === 'water' ? 'water_still' : 'lava_still')
      const level = Number(props.level || 0)
      const top = level > 0 ? Math.max(0.1, 1 - (level + 1) / 9) : 0.875
      const box = { origin: [-8, 0, -8], size: [16, top * 16, 16], uv: [0, 0], tex, texW: 16, texH: 16, layerOverride: name === 'water' ? 'translucent' : 'opaque' }
      const quads = this._entityCubeQuads(box)
      for (const q of quads) {
        q.tintindex = name === 'water' ? 0 : -1
        q.shade = true
        q.cullface = q.shadeDir
        // Vanilla fluid faces use the still texture across the whole face.
        q.uv = [[0, 1], [1, 1], [0, 0], [1, 0]]
      }
      return quads
    }
    if (name === 'chest' || name === 'trapped_chest' || name === 'ender_chest') {
      this.stats.specialRenderers.add('chest')
      const texRef = name === 'ender_chest' ? 'entity/chest/ender' : 'entity/chest/normal'
      const tex = this.assets.entityTexture(texRef) || this.assets.missingTexture
      // Vanilla ChestModel: body 14x10x14, lid 14x5x14, latch 2x4x1 (64x64).
      const body = { origin: [-7, 0, -7], size: [14, 10, 14], uv: [0, 19], tex, texW: 64, texH: 64 }
      const lid = { origin: [-7, 9, -7], size: [14, 5, 14], uv: [0, 0], tex, texW: 64, texH: 64 }
      const latch = { origin: [-1, 7, 7], size: [2, 4, 1], uv: [0, 0], tex, texW: 64, texH: 64 }
      const quads = [...this._entityCubeQuads(body), ...this._entityCubeQuads(lid), ...this._entityCubeQuads(latch)]
      const facing = String(props.facing || 'north')
      // Chest front (latch) is +Z; rotate so +Z points along `facing`.
      const rot = facing === 'north' ? 180 : facing === 'east' ? 90 : facing === 'west' ? -90 : 0
      for (const q of quads) {
        q.pos = q.pos.map((p) => {
          const r = axisRotate([p[0] - 0.5, p[1], p[2] - 0.5], 'y', rot)
          return [r[0] + 0.5, r[1], r[2] + 0.5]
        })
        q.normal = rotateVec(q.normal, 'y', rot)
        q.shadeDir = dirFromVec(q.normal)
        q.layer = 'opaque'
      }
      return quads
    }
    return null
  }

  _fallbackQuads (name) {
    let tex = null
    const state = this.assets.blockstate(name)
    const refs = []
    if (state?.variants) {
      for (const v of Object.values(state.variants)) {
        for (const e of (Array.isArray(v) ? v : [v])) if (e?.model) refs.push(e.model)
      }
    }
    if (state?.multipart) {
      for (const p of state.multipart) {
        for (const e of (Array.isArray(p.apply) ? p.apply : [p.apply])) if (e?.model) refs.push(e.model)
      }
    }
    for (const ref of refs) {
      const src = this.resolveSource(ref)
      const particle = src && this.resolveTextureName(src.textures.particle, src.textures)
      if (particle) { tex = this.textureFor(particle); break }
    }
    if (!tex) tex = this.assets.blockTexture(name)
    if (!tex) tex = this.assets.missingTexture
    this.stats.fallbacks.set(name, (this.stats.fallbacks.get(name) || 0) + 1)
    const box = { origin: [-8, 0, -8], size: [16, 16, 16], uv: [0, 0], tex, texW: tex.width, texH: tex.height }
    return this._entityCubeQuads(box)
  }

  // ── Blockstate dispatch ────────────────────────────────────────────────

  _matchVariantKey (key, props) {
    if (key === '' || key == null) return { match: true, score: 0 }
    const parts = String(key).split(',')
    let score = 0
    for (const part of parts) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      const name = part.slice(0, eq).trim()
      const want = part.slice(eq + 1).trim()
      const have = props[name]
      if (have === undefined) return { match: false, score: 0 }
      const haveStr = typeof have === 'boolean' ? String(have) : String(have)
      if (haveStr !== want) return { match: false, score: 0 }
      score++
    }
    return { match: true, score }
  }

  _whenMatches (when, props) {
    if (!when) return true
    for (const [name, raw] of Object.entries(when)) {
      if (name === 'OR' || name === 'AND') {
        const list = Array.isArray(raw) ? raw : []
        const results = list.map((w) => this._whenMatches(w, props))
        if (name === 'OR' ? !results.some(Boolean) : !results.every(Boolean)) return false
        continue
      }
      if (name === 'state' && raw && typeof raw === 'object') {
        if (!this._whenMatches(raw, props)) return false
        continue
      }
      const have = props[name]
      if (have === undefined) return false
      const haveStr = typeof have === 'boolean' ? String(have) : String(have)
      const wants = Array.isArray(raw) ? raw : String(raw).split('|')
      if (!wants.map((x) => String(x).trim()).includes(haveStr)) return false
    }
    return true
  }

  _hash (x, y, z, salt = 0) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ salt
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return (h ^ (h >>> 16)) >>> 0
  }

  _pickWeighted (variant, x, y, z) {
    if (!Array.isArray(variant)) return variant
    if (variant.length === 1) return variant[0]
    let total = 0
    for (const v of variant) total += Number.isFinite(v.weight) ? v.weight : 1
    let pick = (this._hash(x, y, z, 7) / 0xffffffff) * total
    for (const v of variant) {
      pick -= Number.isFinite(v.weight) ? v.weight : 1
      if (pick <= 0) return v
    }
    return variant[variant.length - 1]
  }

  /** Build the render model for one state at one position (variant weights). */
  modelForState (stateId, x = 0, y = 0, z = 0) {
    const name = this.stateName(stateId)
    if (SKIP_BLOCKS.has(name)) return EMPTY_MODEL
    const props = this.stateProps(stateId)
    const cacheKey = `${stateId}:${x}:${y}:${z}`
    // Position only matters for weighted variants; most states hit a small cache.
    const allowPosition = this._hasWeightedVariants(name)
    const key = allowPosition ? cacheKey : String(stateId)
    if (this._stateCache.has(key)) return this._stateCache.get(key)

    const state = this.assets.blockstate(name)
    const parts = []
    let fullCubeCandidate = false

    const special = this._specialQuads(name, props)
    if (special) parts.push(...special)

    if (state && !special) {
      if (state.variants) {
        let best = null
        let bestScore = -1
        for (const [k, v] of Object.entries(state.variants)) {
          const m = this._matchVariantKey(k, props)
          if (m.match && m.score > bestScore) { best = v; bestScore = m.score }
        }
        if (best) {
          const chosen = this._pickWeighted(best, x, y, z)
          const list = Array.isArray(chosen) ? chosen : [chosen]
          for (const v of list) {
            const baked = this.bake(v.model, { x: v.x, y: v.y, uvlock: v.uvlock, layerOverride: blockLayerOverride(name) }, this._specialQuads(name, props))
            parts.push(...baked.quads)
            if (list.length === 1 && baked.fullCube) fullCubeCandidate = true
            this.stats.variants++
          }
        }
      } else if (state.multipart) {
        for (const part of state.multipart) {
          if (!this._whenMatches(part.when, props)) continue
          const applies = Array.isArray(part.apply) ? part.apply : [part.apply]
          for (const v of applies) {
            parts.push(...this.bake(v.model, { x: v.x, y: v.y, uvlock: v.uvlock, layerOverride: blockLayerOverride(name) }).quads)
            this.stats.multipart++
          }
        }
      }
    } else if (state && special) {
      // Special renderer replaces the model entirely.
    }

    if (!parts.length) {
      // `builtin/entity` blocks without a dedicated implementation, or blocks
      // with no model file: render the real particle/block texture cube rather
      // than inventing a texture. Recorded for the report.
      const particleRef = state?.variants ? null : null
      const fallback = this._fallbackQuads(name)
      parts.push(...fallback)
      this.stats.specialRenderers.add(`fallback:${name}`)
      void particleRef
    }

    let layer = 'opaque'
    for (const q of parts) {
      if (!q.layer) q.layer = quadLayer(q.tex, blockLayerOverride(name))
      if (layerRank(q.layer) > layerRank(layer)) layer = q.layer
    }
    const texSet = new Set(parts.map((q) => q.tex))
    const aabb = [1, 1, 1, 0, 0, 0]
    for (const q of parts) {
      for (const p of q.pos) {
        aabb[0] = Math.min(aabb[0], p[0]); aabb[1] = Math.min(aabb[1], p[1]); aabb[2] = Math.min(aabb[2], p[2])
        aabb[3] = Math.max(aabb[3], p[0]); aabb[4] = Math.max(aabb[4], p[1]); aabb[5] = Math.max(aabb[5], p[2])
      }
    }
    const model = {
      name,
      stateId,
      quads: parts,
      aabb,
      layer,
      opaqueFull: fullCubeCandidate && parts.length > 0 && parts.every((q) => q.layer === 'opaque') &&
        aabb[0] <= 1e-6 && aabb[1] <= 1e-6 && aabb[2] <= 1e-6 &&
        aabb[3] >= 1 - 1e-6 && aabb[4] >= 1 - 1e-6 && aabb[5] >= 1 - 1e-6,
      fullCube: fullCubeCandidate &&
        aabb[0] <= 1e-6 && aabb[1] <= 1e-6 && aabb[2] <= 1e-6 &&
        aabb[3] >= 1 - 1e-6 && aabb[4] >= 1 - 1e-6 && aabb[5] >= 1 - 1e-6,
      fluid: name === 'water' || name === 'lava',
      texturesUsed: [...texSet],
      special: special ? name : null
    }
    this.stats.states++
    this._stateCache.set(key, model)
    return model
  }

  _hasWeightedVariants (name) {
    if (this._weightedNames) return this._weightedNames.has(name)
    this._weightedNames = new Set()
    for (const n of ['grass_block', 'podzol', 'mycelium', 'dirt_path', 'farmland', 'snowy_grass_block']) {
      this._weightedNames.add(n)
    }
    return this._weightedNames.has(name)
  }

  // ── Tints ─────────────────────────────────────────────────────────────

  _tintTable (kind) {
    const tints = this._tints
    if (!tints || !tints[kind]) return null
    if (this._tintIndex?.get(kind)) return this._tintIndex.get(kind)
    if (!this._tintIndex) this._tintIndex = new Map()
    const map = new Map()
    for (const entry of tints[kind].data || []) {
      for (const key of entry.keys || []) map.set(key, entry.color)
    }
    this._tintIndex.set(kind, map)
    return map
  }

  _colormapTint (kind, climate) {
    let cm = this._colormapCache.get(kind)
    if (cm === undefined) {
      cm = this.assets.colormap(kind === 'grass' ? 'grass' : 'foliage')
      this._colormapCache.set(kind, cm)
    }
    if (!cm) return null
    const [temp, downfall] = climate
    const t = Math.max(0, Math.min(1, temp))
    const d = Math.max(0, Math.min(1, downfall))
    const x = Math.floor((1 - t) * 255)
    const y = Math.floor((1 - d * t) * 255)
    const i = (y * cm.width + x) * 4
    const r = cm.rgba[i]
    const g = cm.rgba[i + 1]
    const b = cm.rgba[i + 2]
    if (r === 255 && g === 255 && b === 255) return null
    return [r, g, b]
  }

  /**
   * Colour for a tintindex. Returns null when the block has no colour provider
   * (for example cherry leaves, which must keep their own pink texture).
   */
  tintColor (name, tintindex, biomeName, props = {}) {
    if (tintindex < 0 || tintindex == null) return null
    const biome = biomeName || 'plains'

    if (name === 'water' || name === 'bubble_column' || (name === 'water' && tintindex === 0)) {
      const water = this._tintTable('water')?.get(biome)
      return water ? rgbFromInt(water) : [0x3f, 0x76, 0xe4]
    }

    if (name === 'redstone_wire') {
      const power = Number(props.power ?? 0)
      const table = this._tintTable('redstone')
      const entry = table ? (table.get(power) ?? table.get(String(power))) : null
      return entry != null ? rgbFromInt(entry) : [214, 34, 34]
    }

    const fixed = FIXED_TINT[name]
    if (fixed && (name.endsWith('_stem') || name.endsWith('_leaves') || name === 'lily_pad')) return fixed
    if (name === 'melon_stem' || name === 'pumpkin_stem' || name === 'attached_melon_stem' || name === 'attached_pumpkin_stem') {
      const table = this._tintTable('constant')
      const age = Number(props.age ?? 0)
      const entry = table?.get(name)
      if (entry != null) return rgbFromInt(entry)
      return fixed || null
    }

    if (GRASS_TINT_BLOCKS.has(name)) {
      const override = this._tintTable('grass')?.get(biome)
      if (override) return rgbFromInt(override)
      const climate = BIOME_CLIMATE[biome]
      if (climate) {
        const c = this._colormapTint('grass', climate)
        if (c) return c
      }
      return [0x91, 0xbd, 0x59] // vanilla default grass colour
    }
    if (FOLIAGE_TINT_BLOCKS.has(name)) {
      const override = this._tintTable('foliage')?.get(biome)
      if (override) return rgbFromInt(override)
      const climate = BIOME_CLIMATE[biome]
      if (climate) {
        const c = this._colormapTint('foliage', climate)
        if (c) return c
      }
      return [0x79, 0xa6, 0x27]
    }
    return null
  }

  /** Highest upward-facing quad, for the top-down map view. */
  topQuad (model) {
    let best = null
    let bestY = -Infinity
    for (const q of model.quads) {
      if (q.normal[1] > 0.5) {
        const y = Math.max(...q.pos.map((p) => p[1]))
        if (y > bestY) { bestY = y; best = q }
      }
    }
    if (best) return best
    for (const q of model.quads) {
      const y = Math.max(...q.pos.map((p) => p[1]))
      if (y > bestY) { bestY = y; best = q }
    }
    return best
  }

  /** True when a state is a full opaque cube (culls a neighbouring face). */
  occludesState (stateId, x = 0, y = 0, z = 0) {
    let cache = this._occlusionCache
    if (!cache) { cache = this._occlusionCache = new Map() }
    if (cache.has(stateId)) return cache.get(stateId)
    const m = this.modelForState(stateId, x, y, z)
    const occludes = m.layer === 'opaque' && m.fullCube
    cache.set(stateId, occludes)
    return occludes
  }

  /** Neighbour face occlusion for cullface (full opaque cubes only). */
  neighborCulls (sampler, x, y, z, fromName, fromLayer) {
    const sid = typeof sampler.stateIdAt === 'function' ? sampler.stateIdAt(x, y, z) : 0
    if (!sid) return false
    const m = this.modelForState(sid, x, y, z)
    if (m.fluid) return m.name === fromName
    if (fromLayer === 'translucent') return false
    return m.layer === 'opaque' && m.fullCube
  }
}

const EMPTY_MODEL = Object.freeze({
  name: 'air', stateId: 0, quads: [], aabb: [0, 0, 0, 0, 0, 0], layer: 'opaque',
  opaqueFull: false, fullCube: false, fluid: false, texturesUsed: [], special: null, skip: true
})

module.exports = {
  BlockModelStore,
  FACES,
  FACE_SHADE,
  FACE_AXIS,
  FIXED_TINT,
  BIOME_CLIMATE
}
