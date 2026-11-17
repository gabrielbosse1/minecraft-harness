/**
 * zincai/vision.js — native Minecraft client renderer for the perception layer.
 *
 * The camera, panorama, screenshot, map, navigation overlays and image
 * delivery are the same as before. What changed is *what* is rendered:
 *
 *   - Blocks are rendered from the real client resources: blockstate JSON →
 *     model JSON (parent inheritance, multipart, variants, element rotations,
 *     per-face UVs, cullfaces, tintindex) → actual texture PNGs.
 *   - Transparency comes from the real alpha channel and the client's render
 *     layers (solid / cutout_mipped / translucent); rays are alpha-tested at
 *     cutout texels and composited through translucent surfaces.
 *   - Lighting is permanently fullbright at the shading level: no block-light
 *     or sky-light darkening, no caves/night darkness. Vanilla directional
 *     face shading and gentle contact AO remain so blocks keep their form.
 *     World simulation is untouched (torches are still required by gameplay).
 *   - Entities use the real vanilla cuboid models with correct skin UVs.
 *     Players render their actual 64x64 skin, including slim arms and the
 *     hat/jacket/sleeve/pants overlay layers, read from the same player-info
 *     textures property the client uses (so SkinRestorer skins are honoured).
 *   - Block entities with special renderers (chests) and fluids (water/lava)
 *     use dedicated geometry; other `builtin/entity` blocks fall back to their
 *     real particle texture and are reported in the summary.
 */
'use strict'

const zlib = require('node:zlib')
const path = require('node:path')
const { environmentSnapshot } = require('./environment')
const { createAssetProvider } = require('./native/assets')
const { BlockModelStore, FACE_SHADE } = require('./native/blockModels')
const { buildEntityModel, poseEntityModel, buildArmorQuads, loadEntityDefinitions } = require('./native/entityModels')
const { SkinResolver } = require('./native/skins')
const { ItemModelStore, isEnchanted } = require('./native/items')
const { entityAppearance, metaValue } = require('./native/entityAppearance')
const { equipmentOf, resolveArmorLayers, elytraQuads } = require('./native/equipment')
const specialModels = require('./native/specialModels')

// Fullbright is a rendering invariant for perception. It never touches game
// state: no effects, no light updates, no world edits.
const FULLBRIGHT = true

// ── Minimal PNG encoder (RGB, colour type 2, bit depth 8) ─────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const out = Buffer.allocUnsafe(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng (rgb, width, height) {
  const stride = width * 3
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 1 // Sub filter
    const src = y * stride
    raw[row + 1] = rgb[src]
    raw[row + 2] = rgb[src + 1]
    raw[row + 3] = rgb[src + 2]
    for (let x = 3; x < stride; x++) {
      raw[row + 1 + x] = (rgb[src + x] - rgb[src + x - 3]) & 0xff
    }
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const idat = zlib.deflateSync(raw, { level: 3 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ── 5x7 bitmap font (compact uppercase + digits + punctuation) ────────────

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
}

class Canvas {
  constructor (w, h) {
    this.w = w
    this.h = h
    this.rgb = new Uint8Array(w * h * 3)
  }

  set (x, y, r, g, b) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.rgb[i] = r < 0 ? 0 : r > 255 ? 255 : r
    this.rgb[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g
    this.rgb[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
  }

  blend (x, y, r, g, b, a) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return
    const i = (y * this.w + x) * 3
    const ia = 1 - a
    this.rgb[i] = (this.rgb[i] * ia + r * a) | 0
    this.rgb[i + 1] = (this.rgb[i + 1] * ia + g * a) | 0
    this.rgb[i + 2] = (this.rgb[i + 2] * ia + b * a) | 0
  }

  /** Additive compositing — the enchantment glint shader's blend mode. */
  add (x, y, r, g, b, a) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.rgb[i] = Math.min(255, this.rgb[i] + r * a) | 0
    this.rgb[i + 1] = Math.min(255, this.rgb[i + 1] + g * a) | 0
    this.rgb[i + 2] = Math.min(255, this.rgb[i + 2] + b * a) | 0
  }

  rect (x, y, w, h, rgb, a = 1) {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w, Math.ceil(x + w))
    const y1 = Math.min(this.h, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (a >= 1) this.set(px, py, rgb[0], rgb[1], rgb[2])
        else this.blend(px, py, rgb[0], rgb[1], rgb[2], a)
      }
    }
  }

  outline (x, y, w, h, rgb) {
    const x0 = Math.floor(x); const y0 = Math.floor(y)
    const x1 = Math.ceil(x + w) - 1; const y1 = Math.ceil(y + h) - 1
    for (let px = x0; px <= x1; px++) {
      this.set(px, y0, rgb[0], rgb[1], rgb[2])
      this.set(px, y1, rgb[0], rgb[1], rgb[2])
    }
    for (let py = y0; py <= y1; py++) {
      this.set(x0, py, rgb[0], rgb[1], rgb[2])
      this.set(x1, py, rgb[0], rgb[1], rgb[2])
    }
  }

  line (x0, y0, x1, y1, rgb, a = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const px = Math.round(x0 + (x1 - x0) * t)
      const py = Math.round(y0 + (y1 - y0) * t)
      if (a >= 1) this.set(px, py, rgb[0], rgb[1], rgb[2])
      else this.blend(px, py, rgb[0], rgb[1], rgb[2], a)
    }
  }

  text (x, y, str, fg = [255, 255, 255], bg = null, scale = 1) {
    const s = String(str).toUpperCase()
    const gw = 6 * scale
    const gh = 7 * scale
    if (bg) this.rect(x - 2, y - 1, s.length * gw + 3, gh + 2, bg, bg[3] ?? 0.72)
    for (let c = 0; c < s.length; c++) {
      const glyph = FONT[s[c]] || FONT[' ']
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] !== '1') continue
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              this.set(x + c * gw + col * scale + sx, y + row * scale + sy, fg[0], fg[1], fg[2])
            }
          }
        }
      }
    }
  }
}

function h2 (x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return (h ^ (h >>> 16)) >>> 0
}

function clampByte (v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

// ── Native asset context ───────────────────────────────────────────────────

const nativeContexts = new Map()

function getNativeContext (bot, opts = {}) {
  const version = String(bot?.version || opts.version || '1.21.4')
  const packs = (opts.resourcePacks || []).join(',')
  const key = `${version}|${opts.assetsDir || ''}|${packs}`
  if (nativeContexts.has(key)) return nativeContexts.get(key)
  const assets = createAssetProvider({
    version,
    assetsDir: opts.assetsDir,
    resourcePacks: opts.resourcePacks
  })
  const store = new BlockModelStore(bot, assets, { debug: opts.debug })
  const items = new ItemModelStore({ version, assets, blockModels: store, registry: bot?.registry })
  const ctx = { assets, store, items }
  activeAssetSignature = `${key}|${assets.info.version}|${assets.info.sources.join(',')}`
  nativeContexts.set(key, ctx)
  return ctx
}

const skinResolvers = new WeakMap()
function getSkinResolver (bot, assets, opts = {}) {
  let resolver = skinResolvers.get(bot)
  if (!resolver) {
    resolver = new SkinResolver({ bot, assets, opts })
    skinResolvers.set(bot, resolver)
  }
  return resolver
}

// Model geometry comes from the bundled catalogue, but the *key* still carries
// the active resource signature so a pack/version change cannot serve a stale
// mesh (and so tests that switch packs see fresh models).
let activeAssetSignature = 'default'

const entityModelCache = new Map()
function getEntityModel (name, { slim = false, variant = null } = {}) {
  const key = `${activeAssetSignature}|${name}|${slim ? 'slim' : 'wide'}|${variant || 'default'}`
  if (!entityModelCache.has(key)) {
    const model = buildEntityModel(name, { slim, variant })
    entityModelCache.set(key, model)
  }
  return entityModelCache.get(key)
}

// ── World sampler (raw state ids, real biomes) ─────────────────────────────

function chunkKey (cx, cz) {
  return ((cx & 0xffff) << 16) | (cz & 0xffff)
}

class WorldSampler {
  constructor (bot, eyeX, eyeZ, maxDist) {
    this.bot = bot
    this.world = bot.world
    this.registry = bot.registry
    this.local = { x: 0, y: 0, z: 0 }
    this.chunks = new Map()
    this.chunksTouched = new Set()
    this.chunksLoaded = 0
    this.minY = -64
    this.maxY = 319
    this.globalMaxSolidY = -64
    this.globalMinSolidY = 319
    this.farthestLoadedDist = 0
    this.hasColumns = false
    this._biomeCache = new Map()
    this._occlusionCache = new Map()

    const rawCols = this.world?.async?.columns || this.world?.columns
    if (rawCols) {
      const entries = rawCols instanceof Map ? [...rawCols.entries()] : Object.entries(rawCols)
      this.chunksLoaded = entries.length
      this.hasColumns = entries.length > 0
      for (const [key, col] of entries) {
        if (!col) continue
        let cx
        let cz
        if (typeof key === 'string') {
          const comma = key.indexOf(',')
          if (comma < 0) continue
          cx = Number(key.slice(0, comma))
          cz = Number(key.slice(comma + 1))
        } else if (key && typeof key === 'object' && Number.isFinite(key.x)) {
          cx = key.x; cz = key.z
        } else {
          continue
        }
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue

        const minY = typeof col.minY === 'number' ? col.minY : -64
        const worldHeight = typeof col.worldHeight === 'number' ? col.worldHeight : 384
        if (minY < this.minY) this.minY = minY
        if (minY + worldHeight - 1 > this.maxY) this.maxY = minY + worldHeight - 1

        const sections = Array.isArray(col.sections) ? col.sections : null
        let secMask = 0
        let colMaxY = minY - 1
        let colMinY = minY + worldHeight
        if (sections) {
          for (let i = 0; i < sections.length; i++) {
            const s = sections[i]
            if (!s) continue
            const hasBlocks = (typeof s.solidBlockCount !== 'number') || s.solidBlockCount > 0 || (s.fluidCount > 0)
            if (hasBlocks) {
              secMask |= (1 << i)
              const sy0 = minY + i * 16
              if (sy0 < colMinY) colMinY = sy0
              if (sy0 + 15 > colMaxY) colMaxY = sy0 + 15
            }
          }
        } else {
          secMask = -1
          colMinY = minY
          colMaxY = minY + worldHeight - 1
        }
        if (colMaxY > this.globalMaxSolidY) this.globalMaxSolidY = colMaxY
        if (colMinY < this.globalMinSolidY) this.globalMinSolidY = colMinY

        const wx0 = cx * 16
        const wz0 = cz * 16
        const dx = Math.max(Math.abs(wx0 - eyeX), Math.abs(wx0 + 16 - eyeX))
        const dz = Math.max(Math.abs(wz0 - eyeZ), Math.abs(wz0 + 16 - eyeZ))
        const dist = Math.hypot(dx, dz)
        if (dist > this.farthestLoadedDist) this.farthestLoadedDist = dist

        this.chunks.set(chunkKey(cx, cz), { col, cx, cz, minY, maxY: minY + worldHeight - 1, secMask, colMinY, colMaxY })
      }
    }

    if (this.globalMaxSolidY < this.globalMinSolidY) {
      this.globalMinSolidY = this.minY
      this.globalMaxSolidY = this.maxY
    }

    this.maxDist = this.hasColumns && this.farthestLoadedDist > 0
      ? Math.min(maxDist, Math.max(24, Math.ceil(this.farthestLoadedDist) + 2))
      : maxDist
  }

  /** Raw registry state id (0 = air/unloaded). */
  stateIdAt (x, y, z) {
    if (y < this.minY || y > this.maxY) return 0
    if (this.hasColumns) {
      const wrap = this.chunks.get(chunkKey(x >> 4, z >> 4))
      if (!wrap || y < wrap.colMinY || y > wrap.colMaxY) return 0
      const si = (y - wrap.minY) >> 4
      if (si < 0 || si >= 31 || !(wrap.secMask & (1 << si))) return 0
      this.local.x = x & 15
      this.local.y = y
      this.local.z = z & 15
      try {
        const sid = wrap.col.getBlockStateId(this.local)
        if (sid === undefined || sid === null) return 0
        this.chunksTouched.add(chunkKey(wrap.cx, wrap.cz))
        return sid
      } catch { return 0 }
    }
    // Fallback for synthetic/mock worlds.
    this.local.x = x; this.local.y = y; this.local.z = z
    try {
      if (typeof this.world?.getBlockStateId === 'function') return this.world.getBlockStateId(this.local)
      const b = this.bot.blockAt?.(this.local)
      if (!b) return 0
      const def = this.registry?.blocksByName?.[b.name]
      return def ? def.defaultState : 0
    } catch { return 0 }
  }

  biomeNameAt (x, y, z) {
    if (!this.hasColumns) return this.bot.blockAt?.({ x, y, z })?.biome?.name || 'plains'
    const wrap = this.chunks.get(chunkKey(x >> 4, z >> 4))
    if (!wrap) return 'plains'
    const key = `${wrap.cx},${wrap.cz},${y >> 2}`
    if (this._biomeCache.has(key)) return this._biomeCache.get(key)
    let name = 'plains'
    try {
      if (typeof wrap.col.getBiome === 'function') {
        const id = wrap.col.getBiome({ x: x & 15, y, z: z & 15 })
        const b = this.registry?.biomesById?.[id] ||
          (this.registry?.biomes && (Array.isArray(this.registry.biomes) ? this.registry.biomes[id] : this.registry.biomes[id])) ||
          null
        if (b?.name) name = b.name
      }
    } catch { name = 'plains' }
    if (this._biomeCache.size > 4096) this._biomeCache.clear()
    this._biomeCache.set(key, name)
    return name
  }

  /** Minimal sampler API used by the model store for cullface checks. */
  at (x, y, z) {
    return this.stateIdAt(x, y, z)
  }
}

// ── Ray/quad intersection ──────────────────────────────────────────────────

function rayAabb (ox, oy, oz, dx, dy, dz, aabb, slack = 1e-4) {
  let tmin = -Infinity
  let tmax = Infinity
  const o = [ox, oy, oz]
  const d = [dx, dy, dz]
  for (let a = 0; a < 3; a++) {
    const lo = aabb[a] - slack
    const hi = aabb[a + 3] + slack
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo || o[a] > hi) return -1
    } else {
      let t0 = (lo - o[a]) / d[a]
      let t1 = (hi - o[a]) / d[a]
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp }
      if (t0 > tmin) tmin = t0
      if (t1 < tmax) tmax = t1
      if (tmin > tmax) return -1
    }
  }
  if (tmax < 0) return -1
  return Math.max(0, tmin)
}

const _uvRes = [0, 0]

function intersectQuad (quad, ox, oy, oz, dx, dy, dz, bx, by, bz) {
  const n = quad.normal
  const denom = n[0] * dx + n[1] * dy + n[2] * dz
  if (denom > -1e-8) return null // backface (client models are single-sided)
  const p0 = quad.pos[0]
  const t = (n[0] * (p0[0] - (ox - bx)) + n[1] * (p0[1] - (oy - by)) + n[2] * (p0[2] - (oz - bz))) / denom
  if (!(t > 1e-4)) return null
  const hx = ox + dx * t - bx
  const hy = oy + dy * t - by
  const hz = oz + dz * t - bz
  const p1 = quad.pos[1]
  const p2 = quad.pos[2]
  const e1x = p1[0] - p0[0]; const e1y = p1[1] - p0[1]; const e1z = p1[2] - p0[2]
  const e2x = p2[0] - p0[0]; const e2y = p2[1] - p0[1]; const e2z = p2[2] - p0[2]
  const l1 = e1x * e1x + e1y * e1y + e1z * e1z
  const l2 = e2x * e2x + e2y * e2y + e2z * e2z
  if (l1 < 1e-10 || l2 < 1e-10) return null
  const u = ((hx - p0[0]) * e1x + (hy - p0[1]) * e1y + (hz - p0[2]) * e1z) / l1
  const v = ((hx - p0[0]) * e2x + (hy - p0[1]) * e2y + (hz - p0[2]) * e2z) / l2
  if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) return null
  const uv0 = quad.uv[0]
  const uv1 = quad.uv[1]
  const uv2 = quad.uv[2]
  const uv3 = quad.uv[3]
  const w0 = (1 - u) * (1 - v)
  const w1 = u * (1 - v)
  const w2 = (1 - u) * v
  const w3 = u * v
  _uvRes[0] = uv0[0] * w0 + uv1[0] * w1 + uv2[0] * w2 + uv3[0] * w3
  _uvRes[1] = uv0[1] * w0 + uv1[1] * w1 + uv2[1] * w2 + uv3[1] * w3
  return { t, u, v, uv: _uvRes, localX: hx, localY: hy, localZ: hz }
}

// ── Fullbright shading ─────────────────────────────────────────────────────

// Gentle contact AO only. No block light, no sky light, no day/night factor:
// caves at y=-59 and a midnight surface are equally visible.
function contactAO (sampler, store, x, y, z, quad, hit) {
  // Only axis-aligned faces get the cheap contact test.
  if (!quad.shade || Math.abs(quad.normal[0]) + Math.abs(quad.normal[1]) + Math.abs(quad.normal[2]) < 0.999) return 1
  const side = quad.shadeDir
  let ao = 1
  const opaque = (nx, ny, nz) => {
    const sid = sampler.stateIdAt(nx, ny, nz)
    if (!sid) return false
    return store.occludesState(sid, nx, ny, nz)
  }
  if (side === 'up' || side === 'down') {
    const fx = hit.localX
    const fz = hit.localZ
    if (fx < 0.35 && opaque(x - 1, y, z)) ao -= (0.35 - fx) * 0.55
    if (fx > 0.65 && opaque(x + 1, y, z)) ao -= (fx - 0.65) * 0.55
    if (fz < 0.35 && opaque(x, y, z - 1)) ao -= (0.35 - fz) * 0.55
    if (fz > 0.65 && opaque(x, y, z + 1)) ao -= (fz - 0.65) * 0.55
  } else {
    const fy = hit.localY
    if (fy < 0.35 && opaque(x, y - 1, z)) ao -= (0.35 - fy) * 0.5
    if (fy > 0.65 && opaque(x, y + 1, z)) ao -= (fy - 0.65) * 0.5
  }
  return Math.max(0.78, ao)
}

function applyTint (rgb, tint) {
  if (!tint) return rgb
  rgb[0] = (rgb[0] * tint[0]) / 255
  rgb[1] = (rgb[1] * tint[1]) / 255
  rgb[2] = (rgb[2] * tint[2]) / 255
  return rgb
}

const _texel = [0, 0, 0, 0]
const _shaded = [0, 0, 0, 0]

function shadeQuadHit (ctx, sampler, quad, hit, x, y, z, biome, props, mip, timeMs, blockName) {
  quad.tex.sample(hit.uv[0], hit.uv[1], timeMs, mip, _texel)
  const tint = quad.tintindex >= 0
    ? ctx.store.tintColor(blockName, quad.tintindex, biome, props)
    : null
  applyTint(_texel, tint)
  const ao = quad.layer === 'opaque' || quad.layer === 'cutout_mipped'
    ? contactAO(sampler, ctx.store, x, y, z, quad, hit)
    : 1
  const light = quad.shade ? FACE_SHADE[quad.shadeDir] * ao : 1
  _shaded[0] = _texel[0] * light
  _shaded[1] = _texel[1] * light
  _shaded[2] = _texel[2] * light
  _shaded[3] = _texel[3]
  return { color: _shaded, alpha: _texel[3] / 255, texelAlpha: _texel[3], tint }
}

/**
 * Trace a ray through the real block models. Cutout texels are tested with the
 * texture's alpha channel (leaves/plants/glass have genuine holes); translucent
 * texels are accumulated and composited over whatever is behind them.
 */
function traceRay (ctx, sampler, ox, oy, oz, dx, dy, dz, maxDist, timeMs, mipFootprint) {
  const store = ctx.store
  const translucent = []
  const maxLayers = 8

  let x = Math.floor(ox)
  let y = Math.floor(oy)
  let z = Math.floor(oz)
  const sx = dx >= 0 ? 1 : -1
  const sy = dy >= 0 ? 1 : -1
  const sz = dz >= 0 ? 1 : -1
  const txD = Math.abs(dx) > 1e-9 ? Math.abs(1 / dx) : 1e9
  const tyD = Math.abs(dy) > 1e-9 ? Math.abs(1 / dy) : 1e9
  const tzD = Math.abs(dz) > 1e-9 ? Math.abs(1 / dz) : 1e9
  let tx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? x + 1 - ox : ox - x) * txD) : 1e9
  let ty = Math.abs(dy) > 1e-9 ? ((dy > 0 ? y + 1 - oy : oy - y) * tyD) : 1e9
  let tz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? z + 1 - oz : oz - z) * tzD) : 1e9
  let t = 0
  let axis = 1

  const maxSolidY = sampler.globalMaxSolidY
  const minSolidY = sampler.globalMinSolidY
  let lastCx = 0x7fffffff
  let lastCz = 0x7fffffff
  let curChunk = null

  while (t < maxDist) {
    if (dy >= 0 && y > maxSolidY) break
    if (dy <= 0 && y < minSolidY) break

    let sid = 0
    const cx = x >> 4
    const cz = z >> 4
    if (cx !== lastCx || cz !== lastCz) {
      lastCx = cx
      lastCz = cz
      curChunk = sampler.chunks.get(chunkKey(cx, cz)) || null
      if (curChunk) sampler.chunksTouched.add(chunkKey(cx, cz))
    }
    if (curChunk && y >= curChunk.colMinY && y <= curChunk.colMaxY) {
      const si = (y - curChunk.minY) >> 4
      if (si >= 0 && si < 31 && (curChunk.secMask & (1 << si))) {
        sampler.local.x = x & 15
        sampler.local.y = y
        sampler.local.z = z & 15
        try { sid = curChunk.col.getBlockStateId(sampler.local) } catch { sid = 0 }
      }
    } else if (!sampler.hasColumns) {
      sid = sampler.stateIdAt(x, y, z)
    }

    if (sid) {
      const model = store.modelForState(sid, x, y, z)
      if (model.quads.length) {
        const ax = ox - x
        const ay = oy - y
        const az = oz - z
        if (rayAabb(ax, ay, az, dx, dy, dz, model.aabb) >= 0) {
          const biome = sampler.biomeNameAt(x, y, z)
          const props = store.stateProps(sid)
          const mip = mipFootprint(t)
          for (let qi = 0; qi < model.quads.length; qi++) {
            const quad = model.quads[qi]
            if (quad.cullface) {
              const cd = quad.cullface
              const ddx = cd === 'east' ? 1 : cd === 'west' ? -1 : 0
              const ddy = cd === 'up' ? 1 : cd === 'down' ? -1 : 0
              const ddz = cd === 'south' ? 1 : cd === 'north' ? -1 : 0
              const nsid = sampler.stateIdAt(x + ddx, y + ddy, z + ddz)
              if (nsid) {
                const nm = store.modelForState(nsid, x + ddx, y + ddy, z + ddz)
                if (store.occludesState(nsid, x + ddx, y + ddy, z + ddz)) continue
                if (model.fluid && nm.fluid && nm.name === model.name) continue
              }
            }
            const hit = intersectQuad(quad, ox, oy, oz, dx, dy, dz, x, y, z)
            if (!hit) continue
            const shaded = shadeQuadHit(ctx, sampler, quad, hit, x, y, z, biome, props, mip, timeMs, model.name)
            if (shaded.texelAlpha < 26) continue // cutout / transparent hole
            if (quad.layer === 'translucent') {
              translucent.push({ t: hit.t, name: model.name, x, y, z, rgb: [shaded.color[0], shaded.color[1], shaded.color[2]], a: shaded.alpha })
              if (translucent.length >= maxLayers) break
              continue
            }
            return {
              t: hit.t,
              x, y, z,
              name: model.name,
              color: [shaded.color[0], shaded.color[1], shaded.color[2]],
              alpha: shaded.alpha,
              layer: quad.layer,
              translucent,
              translucentName: translucent.length ? translucent[0].name : null,
              axis
            }
          }
        }
      }
    }

    // Fast skip across empty 16³ sections.
    if (curChunk && (!curChunk || y < curChunk.colMinY || y > curChunk.colMaxY || !(curChunk.secMask & (1 << ((y - curChunk.minY) >> 4))))) {
      const nx = dx > 0 ? ((x >> 4) + 1) * 16 : (dx < 0 ? (x >> 4) * 16 - 1 : x)
      const ny = dy > 0 ? ((y >> 4) + 1) * 16 : (dy < 0 ? (y >> 4) * 16 - 1 : y)
      const nz = dz > 0 ? ((z >> 4) + 1) * 16 : (dz < 0 ? (z >> 4) * 16 - 1 : z)
      const tJumpX = Math.abs(dx) > 1e-9 ? ((dx > 0 ? nx - ox : (nx + 1) - ox) / dx) : 1e9
      const tJumpY = Math.abs(dy) > 1e-9 ? ((dy > 0 ? ny - oy : (ny + 1) - oy) / dy) : 1e9
      const tJumpZ = Math.abs(dz) > 1e-9 ? ((dz > 0 ? nz - oz : (nz + 1) - oz) / dz) : 1e9
      let tNext = Math.min(tJumpX, tJumpY, tJumpZ)
      if (tNext > t + 1e-4) {
        if (tNext >= maxDist) break
        const eps = tNext + 1e-4
        x = Math.floor(ox + dx * eps)
        y = Math.floor(oy + dy * eps)
        z = Math.floor(oz + dz * eps)
        t = tNext
        axis = tJumpX <= tJumpY && tJumpX <= tJumpZ ? 0 : (tJumpY <= tJumpZ ? 1 : 2)
        tx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? x + 1 - ox : ox - x) * txD) : 1e9
        ty = Math.abs(dy) > 1e-9 ? ((dy > 0 ? y + 1 - oy : oy - y) * tyD) : 1e9
        tz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? z + 1 - oz : oz - z) * tzD) : 1e9
        continue
      }
    }

    if (tx < ty) {
      if (tx < tz) { t = tx; tx += txD; x += sx; axis = 0 } else { t = tz; tz += tzD; z += sz; axis = 2 }
    } else {
      if (ty < tz) { t = ty; ty += tyD; y += sy; axis = 1 } else { t = tz; tz += tzD; z += sz; axis = 2 }
    }
  }

  return { sky: true, translucent, translucentName: translucent.length ? translucent[0].name : null, t: maxDist }
}

// ── Sky, sun/moon, stars & blocky clouds ───────────────────────────────────

function skyProfile (bot) {
  const dim = String(bot.game?.dimension || 'overworld').toLowerCase()
  if (dim.includes('nether')) {
    return { zenith: [76, 22, 22], horizon: [118, 38, 28], ambient: 1, label: 'nether', dim: 'nether', sun: null, clouds: false }
  }
  if (dim.includes('end')) {
    return { zenith: [16, 12, 28], horizon: [34, 24, 52], ambient: 1, label: 'end', dim: 'end', sun: null, clouds: false }
  }
  const tod = Number.isFinite(bot.time?.timeOfDay) ? ((bot.time.timeOfDay % 24000) + 24000) % 24000 : 4000
  const sunAngle = (tod / 24000) * Math.PI * 2
  const sunX = Math.cos(sunAngle)
  const sunY = Math.sin(sunAngle)
  const sunZ = -0.32
  const sunLen = Math.hypot(sunX, sunY, sunZ) || 1
  const sunDir = [sunX / sunLen, sunY / sunLen, sunZ / sunLen]

  if (tod > 13000 && tod < 23000) {
    return {
      zenith: [10, 14, 34],
      horizon: [26, 36, 68],
      ambient: 1,
      label: 'night (fullbright terrain)',
      dim: 'overworld',
      night: true,
      sun: [-sunDir[0], -sunDir[1], -sunDir[2]],
      clouds: true
    }
  }
  if ((tod >= 11500 && tod <= 13000) || tod >= 23000 || tod < 500) {
    return {
      zenith: [86, 108, 178], horizon: [236, 152, 92], ambient: 1, label: 'twilight (fullbright terrain)', dim: 'overworld', night: false, sun: sunDir, clouds: true
    }
  }
  return {
    zenith: [106, 160, 248], horizon: [190, 218, 252], ambient: 1, label: 'day', dim: 'overworld', night: false, sun: sunDir, clouds: true
  }
}

function skyPixel (sky, dx, dy, dz, eyeX, eyeY, eyeZ) {
  let k = Math.max(0, Math.min(1, dy * 1.45 + 0.08))
  if (sky.dim === 'nether' || sky.dim === 'end') k = Math.max(0, Math.min(1, dy * 0.8 + 0.5))
  const r0 = sky.horizon[0] + (sky.zenith[0] - sky.horizon[0]) * k
  const g0 = sky.horizon[1] + (sky.zenith[1] - sky.horizon[1]) * k
  const b0 = sky.horizon[2] + (sky.zenith[2] - sky.horizon[2]) * k
  let r = r0
  let g = g0
  let b = b0

  if (sky.sun && dy > -0.05) {
    const sx = sky.sun[0]; const sy = sky.sun[1]; const sz = sky.sun[2]
    const dot = dx * sx + dy * sy + dz * sz
    if (dot > 0.94) {
      const rl = Math.hypot(-sz, sx) || 1
      const rx = -sz / rl; const rz = sx / rl
      const ux = -sy * rz; const uy = sx * rz - sz * rx; const uz = sy * rx
      const du = Math.abs(dx * rx + dz * rz)
      const dv = Math.abs(dx * ux + dy * uy + dz * uz)
      const box = Math.max(du, dv)
      if (box < 0.085) {
        if (sky.night) { r = 232; g = 236; b = 248 } else { r = 255; g = 252; b = 212 }
      } else if (box < 0.18 && !sky.night) {
        const glow = (0.18 - box) / 0.095
        r += (255 - r) * glow * 0.36
        g += (240 - g) * glow * 0.30
        b += (190 - b) * glow * 0.20
      }
    }
  }

  if (sky.night && dy > 0.14) {
    const sx = Math.floor(Math.atan2(dx, dz) * 90)
    const sy = Math.floor(Math.asin(Math.max(-1, Math.min(1, dy))) * 90)
    if ((h2(sx, sy) & 1023) === 0) { r = 228; g = 234; b = 252 }
  }

  if (sky.clouds && dy > 0.055) {
    const tCloud = 52 / dy
    if (tCloud < 520) {
      const cx = Math.floor((eyeX + dx * tCloud) / 14)
      const cz = Math.floor((eyeZ + dz * tCloud) / 14)
      const isCloud = ((h2(cx, cz) & 7) === 0) || (((h2(cx - 1, cz) & 7) === 0) && ((h2(cx, cz + 1) & 3) === 0))
      if (isCloud) {
        const fade = Math.max(0, Math.min(1, (dy - 0.055) * 4.5)) * (1 - tCloud / 560)
        const ca = fade * (sky.night ? 0.22 : 0.72)
        const cr = sky.night ? 140 : 246
        const cg = sky.night ? 152 : 250
        const cb = sky.night ? 178 : 255
        r = r * (1 - ca) + cr * ca
        g = g * (1 - ca) + cg * ca
        b = b * (1 - ca) + cb * ca
      }
    }
  }

  _shaded[0] = clampByte(r)
  _shaded[1] = clampByte(g)
  _shaded[2] = clampByte(b)
  _shaded[3] = 255
  return [_shaded[0], _shaded[1], _shaded[2]]
}

// ── Camera / coordinate conventions ────────────────────────────────────────

const COMPASS_DEG = {
  n: 0, north: 0, ne: 45, northeast: 45, e: 90, east: 90, se: 135, southeast: 135,
  s: 180, south: 180, sw: 225, southwest: 225, w: 270, west: 270, nw: 315, northwest: 315
}
const COMPASS_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function bearingName (deg) {
  const n = ((deg % 360) + 360) % 360
  return COMPASS_NAMES[Math.round(n / 45) % 8]
}

function yawToBearing (yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  return ((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360
}

function dirFor (bearingDeg, pitchDeg) {
  const b = bearingDeg * Math.PI / 180
  const p = pitchDeg * Math.PI / 180
  const cp = Math.cos(p)
  return [Math.sin(b) * cp, Math.sin(p), -Math.cos(b) * cp]
}

function resolveAim (bot, opts) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  if (opts.at && Number.isFinite(opts.at.x) && Number.isFinite(opts.at.y) && Number.isFinite(opts.at.z)) {
    const dx = opts.at.x + 0.5 - eye.x
    const dy = opts.at.y + 0.5 - eye.y
    const dz = opts.at.z + 0.5 - eye.z
    const horiz = Math.hypot(dx, dz) || 1e-6
    return {
      bearing: ((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360,
      pitch: Math.max(-75, Math.min(75, Math.atan2(dy, horiz) * 180 / Math.PI)),
      note: `aimed at ${Math.floor(opts.at.x)},${Math.floor(opts.at.y)},${Math.floor(opts.at.z)}`
    }
  }
  const d = typeof opts.direction === 'string' ? opts.direction.trim().toLowerCase() : ''
  const curBearing = yawToBearing(bot.entity.yaw || 0)
  const curPitch = Math.max(-75, Math.min(75, (bot.entity.pitch || 0) * 180 / Math.PI))
  if (!d || d === 'ahead' || d === 'forward') return { bearing: curBearing, pitch: curPitch }
  if (d === 'behind' || d === 'back') return { bearing: (curBearing + 180) % 360, pitch: 0 }
  if (d === 'left') return { bearing: (curBearing + 270) % 360, pitch: 0 }
  if (d === 'right') return { bearing: (curBearing + 90) % 360, pitch: 0 }
  if (d === 'up') return { bearing: curBearing, pitch: 65 }
  if (d === 'down') return { bearing: curBearing, pitch: -65 }
  if (d in COMPASS_DEG) return { bearing: COMPASS_DEG[d], pitch: 0 }
  return { bearing: curBearing, pitch: curPitch }
}

/**
 * Perspective handling.
 *
 * The renderer can look at the world from the bot's own eyes (first person) or
 * from a camera outside the bot (third person / explicit camera). What may be
 * drawn depends on that choice, exactly like the client:
 *
 *  * first person  — the bot's own body, armour, elytra and outer layers are
 *    not drawn (they would be camera-space geometry blocking the view); the
 *    held item is drawn with the real first-person display transform.
 *  * third person  — the bot is drawn like any other player: full model, current
 *    skin, armour + trims, elytra, both hands, outer layers, animations. The
 *    first-person hand overlay is *not* drawn, so nothing is duplicated.
 */
const EYE_HEIGHT = { standing: 1.62, sneaking: 1.27, swimming: 0.4, sleeping: 0.2 }

function eyeHeightFor (bot) {
  const pose = String(bot?.entity?.pose || '')
  if (bot?.entity?.crouching || pose === 'sneaking') return EYE_HEIGHT.sneaking
  if (pose === 'swimming' || pose === 'crawling' || pose === 'fall_flying') return EYE_HEIGHT.swimming
  if (pose === 'sleeping') return EYE_HEIGHT.sleeping
  return EYE_HEIGHT.standing
}

/** The bot's own equipment in the client's slot order. */
function selfEquipment (bot) {
  const slots = Array.isArray(bot?.inventory?.slots) ? bot.inventory.slots : []
  const quickBar = Number.isFinite(bot?.quickBarSlot) ? bot.quickBarSlot : 0
  return [
    bot?.heldItem || slots[36 + quickBar] || null,
    bot?.offhandItem || slots[45] || null,
    slots[8] || null, // boots
    slots[7] || null, // leggings
    slots[6] || null, // chestplate
    slots[5] || null // helmet
  ]
}

function isSolidAt (bot, x, y, z) {
  try {
    const block = bot.blockAt({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) })
    if (!block) return false
    if (block.boundingBox === 'block' || block.boundingBox === 'empty') return block.boundingBox === 'block'
    return Boolean(block.name && block.name !== 'air' && !/_lava|water|_water$|seagrass|kelp|bubble/.test(block.name))
  } catch {
    return false
  }
}

/**
 * Resolve the camera: bot's eyes, an explicit camera position, or a third-person
 * orbit behind the bot (with the vanilla-style pull-in when a wall is in the
 * way).
 */
function resolvePerspective (bot, opts, aim, fwd, isPano) {
  const baseEye = bot.entity.position.offset(0, eyeHeightFor(bot), 0)
  const wanted = String(opts.perspective || '').toLowerCase()
  const camera = opts.camera

  if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.z)) {
    return {
      eye: { x: camera.x, y: camera.y, z: camera.z },
      baseEye,
      perspective: 'third',
      source: 'camera',
      distance: Math.hypot(camera.x - baseEye.x, camera.y - baseEye.y, camera.z - baseEye.z)
    }
  }

  const third = wanted === 'third' || wanted === 'third-person' || wanted === 'thirdperson' || wanted === '3' || opts.thirdPerson === true
  if (!third) {
    const known = !wanted || ['first', 'first-person', 'firstperson', '1'].includes(wanted)
    return { eye: baseEye, baseEye, perspective: 'first', source: 'eye', distance: 0, unknown: known ? null : String(opts.perspective) }
  }

  const wantedDist = Math.max(1.5, Math.min(12, Number.isFinite(opts.cameraDistance) ? opts.cameraDistance : (isPano ? 5 : 4)))
  const lift = Number.isFinite(opts.cameraHeight) ? opts.cameraHeight : 0.35
  const hLen = Math.hypot(fwd[0], fwd[2]) || 1
  const backX = -fwd[0] / hLen
  const backZ = -fwd[2] / hLen
  // Walk backwards from the bot and stop before the first wall (vanilla pulls
  // the camera in the same way); the floor is 0.5m so a tight tunnel still
  // shows the bot instead of ending up inside stone.
  let dist = 0.5
  for (let d = 0.5; d <= wantedDist + 1e-6; d += 0.1) {
    const x = baseEye.x + backX * d
    const z = baseEye.z + backZ * d
    if (isSolidAt(bot, x, baseEye.y + lift, z) || isSolidAt(bot, x, baseEye.y + lift + 0.4, z)) {
      dist = Math.max(0.5, d - 0.1)
      break
    }
    dist = d
  }
  return {
    eye: { x: baseEye.x + backX * dist, y: baseEye.y + lift, z: baseEye.z + backZ * dist },
    baseEye,
    perspective: 'third',
    source: 'third-person',
    distance: dist
  }
}

// ── Entity list & real-model rasterization ─────────────────────────────────

const HOSTILE_NAME = /zombie|skeleton|creeper|spider|enderman|witch|pillager|vindicator|evoker|ravager|phantom|blaze|ghast|slime|magma|guardian|drowned|husk|stray|wither|piglin|hoglin|zoglin|silverfish|vex|shulker|breeze|bogged|creaking|warden|elder_guardian/

function hostileFor (name, e, isHostile) {
  if (isHostile) { try { return Boolean(isHostile(name)) } catch { /* fall through */ } }
  if (e?.type === 'hostile') return true
  return HOSTILE_NAME.test(String(name || ''))
}

// Entity types the client renders with a model. `item` entities are handled by
// the dropped-item path, item frames by the frame path below.
const MODEL_ENTITY_TYPES = new Set(['player', 'mob', 'hostile', 'animal', 'passive', 'object', 'other', 'projectile', 'vehicle'])

function entityList (bot, eye, maxDist, isHostile, opts = {}) {
  const out = []
  const definitions = opts.definitions || loadEntityDefinitions()
  const includeSelf = Boolean(opts.includeSelf)
  const selfEntity = bot.entity
  const selfEq = includeSelf ? selfEquipment(bot) : null
  const entities = Object.values(bot.entities || {})
  // The bot's own entity is always part of `bot.entities`; add it defensively
  // for test doubles that only expose `bot.entity`.
  if (includeSelf && selfEntity?.position && !entities.includes(selfEntity)) entities.push(selfEntity)
  for (const e of entities) {
    if (!e || !e.position) continue
    const isSelf = e === selfEntity
    if (isSelf && !includeSelf) continue
    if (droppedItemOf(e)) continue
    const selfName = bot.username || e.username || 'you'
    const name = isSelf ? selfName : e.type === 'player' ? (e.username || 'player') : (e.name || e.type || 'mob')
    if (e.type === 'item_frame' || name === 'item_frame' || name === 'glow_item_frame') continue
    // Thrown tridents are drawn by the TridentModel pass below.
    if (name === 'trident') continue
    const isPlayer = isSelf || e.type === 'player'
    if (!MODEL_ENTITY_TYPES.has(e.type) && !isPlayer) continue
    const appearance = isPlayer
      ? { modelKey: 'player', baby: false, scale: 1, notes: [], textureRef: null, textureCandidates: [], extraLayers: [] }
      : entityAppearance(e, { registry: bot.registry, definitions })
    const modelKey = appearance.modelKey || name
    const base = getEntityModel(modelKey, {})
    if (!isPlayer && !base) continue // the renderer reports the precise reason
    const hostile = !isPlayer && hostileFor(name, e, isHostile)
    const scale = appearance.scale || 1
    const rawH = Number.isFinite(e.height) && e.height > 0 ? e.height : (base?.height || 1.4)
    const h = rawH * scale
    const w = Number(modelWidth(base, e)) * scale
    const dist = Math.hypot(e.position.x - eye.x, e.position.y + h * 0.5 - eye.y, e.position.z - eye.z)
    if (dist < 0.4 || dist > maxDist) continue
    out.push({
      id: e.id,
      name,
      type: e.name || e.type,
      isPlayer,
      isSelf,
      hostile,
      entity: e,
      // Own equipment comes from the inventory (the server does not re-send
      // entity_equipment for the local player's own slots).
      equipment: isSelf ? selfEq : null,
      appearance,
      scale,
      modelKey,
      x: e.position.x,
      feetY: e.position.y,
      z: e.position.z,
      w,
      h,
      dist,
      tag: hostile ? [255, 96, 88] : isPlayer ? [96, 224, 255] : [248, 228, 112]
    })
  }
  out.sort((a, b) => b.dist - a.dist)
  return out
}

function modelWidth (base, e) {
  if (Number.isFinite(e?.width) && e.width > 0) return e.width
  return base?.width || 0.7
}

const animState = new WeakMap()

function dequantizeAngle (value) {
  // Armour stand pose metadata is a byte: (angle / 360) * 256.
  return (Number(value) || 0) * 360 / 256
}

function buildPose (entity, model, nowMs, isPlayer, opts = {}) {
  const pose = {}
  const registry = opts.registry || null
  const last = animState.get(entity) || { x: entity.position?.x, z: entity.position?.z, t: nowMs, phase: 0 }
  const dt = Math.max(0, Math.min(1, (nowMs - last.t) / 1000))
  let speed = 0
  if (entity.velocity && Number.isFinite(entity.velocity.x)) {
    speed = Math.hypot(entity.velocity.x, entity.velocity.z)
  } else if (entity.position) {
    const dx = entity.position.x - last.x
    const dz = entity.position.z - last.z
    if (dt > 0) speed = Math.hypot(dx, dz) / dt
  }
  const phase = (last.phase || 0) + speed * dt * 2.4
  animState.set(entity, { x: entity.position?.x, z: entity.position?.z, t: nowMs, phase })
  const amp = Math.min(0.85, speed * 0.16) * (speed > 0.05 ? 1 : 0)
  const swing = Math.sin(phase) * amp

  const boneNames = new Set(model.quads.map((q) => q.bone))
  for (const bone of boneNames) {
    if (/^leg\d+$/.test(bone)) {
      const idx = Number(bone.slice(3))
      pose[bone] = [Math.sin(phase + (idx % 2 ? Math.PI : 0)) * amp, 0, 0]
    } else if (bone === 'leftLeg' || bone === 'leftPants') {
      pose[bone] = [swing, 0, 0]
    } else if (bone === 'rightLeg' || bone === 'rightPants') {
      pose[bone] = [-swing, 0, 0]
    } else if (bone === 'leftArm' || bone === 'leftSleeve') {
      pose[bone] = [-swing, 0, 0]
    } else if (bone === 'rightArm' || bone === 'rightSleeve') {
      pose[bone] = [swing, 0, 0]
    } else if (bone === 'wing0') {
      pose[bone] = [0, 0, -Math.abs(swing) * 0.7]
    } else if (bone === 'wing1') {
      pose[bone] = [0, 0, Math.abs(swing) * 0.7]
    }
  }

  // Vanilla idle poses that are applied in the renderer (not the model file).
  const name = model.name
  if (['zombie', 'husk', 'drowned', 'zombie_villager', 'zombified_piglin'].includes(name)) {
    pose.leftArm = [Math.PI / 2 + swing * 0.15, 0, 0]
    pose.rightArm = [Math.PI / 2 + swing * 0.15, 0, 0]
  } else if (['skeleton', 'stray', 'wither_skeleton', 'bogged'].includes(name)) {
    pose.leftArm = [Math.PI / 2.2, 0, 0]
    pose.rightArm = [Math.PI / 2.2, 0, 0]
  }

  if (isPlayer || boneNames.has('head')) {
    const pitch = Number.isFinite(entity.pitch) ? entity.pitch : 0
    if (boneNames.has('head')) pose.head = [-pitch, 0, 0]
  }

  // Vanilla crouch: the body leans forward and the head tilts up a little.
  const sharedFlags = metaValue(entity, registry, 'shared_flags')
  if (Number.isFinite(sharedFlags) && (sharedFlags & 0x02)) {
    if (boneNames.has('body')) pose.body = [0.5, 0, 0]
    if (boneNames.has('head')) pose.head = [(pose.head?.[0] || 0) - 0.5, 0, 0]
    for (const leg of ['leftLeg', 'rightLeg']) if (boneNames.has(leg)) pose[leg] = [-0.4, 0, 0]
    for (const arm of ['leftArm', 'rightArm']) if (boneNames.has(arm)) pose[arm] = [0.4, 0, 0]
  }

  // Armour stands: every bone pose is synced metadata (vanilla quantised Euler).
  if (model.name === 'armor_stand') {
    const mapping = {
      head: 'head_pose',
      body: 'body_pose',
      leftarm: 'left_arm_pose',
      rightarm: 'right_arm_pose',
      leftleg: 'left_leg_pose',
      rightleg: 'right_leg_pose'
    }
    for (const [bone, key] of Object.entries(mapping)) {
      if (!boneNames.has(bone)) continue
      const raw = metaValue(entity, registry, key)
      if (raw == null) continue
      // Each axis is a quantised byte in a packed int (x << 16 | y << 8 | z).
      const packed = Number(raw) || 0
      const x = dequantizeAngle((packed >> 16) & 0xff) * Math.PI / 180
      const y = dequantizeAngle((packed >> 8) & 0xff) * Math.PI / 180
      const z = dequantizeAngle(packed & 0xff) * Math.PI / 180
      pose[bone] = [x, y, z]
    }
  }
  return pose
}

function makeProjector (eye, fwd, right, up, w, h, halfW, halfH, isPano, panoVert) {
  return function project (x, y, z, centerAz = null) {
    const rx = x - eye.x
    const ry = y - eye.y
    const rz = z - eye.z
    const depth = Math.hypot(rx, ry, rz)
    if (isPano) {
      let az = Math.atan2(rx, -rz)
      if (centerAz != null) {
        const base = centerAz
        while (az - base > Math.PI) az -= Math.PI * 2
        while (az - base < -Math.PI) az += Math.PI * 2
      }
      const horiz = Math.hypot(rx, rz)
      const el = Math.atan2(ry, horiz)
      const sx = (az / (Math.PI * 2) + 0.5) * w
      const sy = (0.5 - el / panoVert) * h
      return { sx, sy, depth, z: Math.hypot(rx, rz), X: rx, Y: ry, Z: -rz, az }
    }
    const Z = rx * fwd[0] + ry * fwd[1] + rz * fwd[2]
    if (Z <= 0.05) return null
    const X = rx * right[0] + ry * right[1] + rz * right[2]
    const Y = rx * up[0] + ry * up[1] + rz * up[2]
    const sx = (1 + X / (Z * halfW)) * w / 2
    const sy = (1 - Y / (Z * halfH)) * h / 2
    return { sx, sy, depth, z: Z, X, Y, Z }
  }
}


function clipNear (vertices, near = 0.05) {
  const out = []
  for (let i = 0; i < vertices.length; i++) {
    const cur = vertices[i]
    const prev = vertices[(i + vertices.length - 1) % vertices.length]
    const curIn = cur.z >= near
    const prevIn = prev.z >= near
    if (curIn !== prevIn) {
      const t = (near - prev.z) / (cur.z - prev.z)
      out.push({
        x: prev.x + (cur.x - prev.x) * t,
        y: prev.y + (cur.y - prev.y) * t,
        z: near,
        u: prev.u + (cur.u - prev.u) * t,
        v: prev.v + (cur.v - prev.v) * t,
        w: prev.w + (cur.w - prev.w) * t
      })
    }
    if (curIn) out.push(cur)
  }
  return out
}

// A compact, purpose-built entity rasterizer (perspective-correct for `look`,
// cylindrical for `panorama`) sharing the block pass z-buffer.
function rasterizeEntityQuads (canvas, zbuf, camera, quads, timeMs) {
  const { w, h, isPano, fwd, right, up, halfW, halfH, panoVert, eye } = camera
  let drawn = 0
  for (const quad of quads) {
    const tex = quad.tex
    if (!tex) continue
    const centerAz = isPano
      ? Math.atan2(quad.center[0] - eye.x, -(quad.center[2] - eye.z))
      : null
    const verts = []
    let ok = true
    for (let i = 0; i < 4; i++) {
      const p = quad.pos[i]
      const rx = p[0] - eye.x
      const ry = p[1] - eye.y
      const rz = p[2] - eye.z
      const X = rx * right[0] + ry * right[1] + rz * right[2]
      const Y = rx * up[0] + ry * up[1] + rz * up[2]
      const Z = rx * fwd[0] + ry * fwd[1] + rz * fwd[2]
      verts.push({ X, Y, Z, u: quad.uv[i][0], v: quad.uv[i][1] })
      if (Z < -0.5) ok = false
    }
    if (!ok) continue
    const clip = clipNear(verts.map((v) => ({ x: v.X, y: v.Y, z: v.Z, u: v.u, v: v.v })))
    if (clip.length < 3) continue

    const screen = clip.map((vIn) => {
      // Reconstruct world-space relative vector from camera coordinates.
      const X = vIn.x
      const Y = vIn.y
      const Z = vIn.z
      const relX = right[0] * X + up[0] * Y + fwd[0] * Z
      const relY = right[1] * X + up[1] * Y + fwd[1] * Z
      const relZ = right[2] * X + up[2] * Y + fwd[2] * Z
      const depth = Math.hypot(relX, relY, relZ)
      let sx, sy
      if (isPano) {
        let az = Math.atan2(relX, -relZ)
        if (centerAz != null) {
          while (az - centerAz > Math.PI) az -= Math.PI * 2
          while (az - centerAz < -Math.PI) az += Math.PI * 2
        }
        sx = (az / (Math.PI * 2) + 0.5) * w
        sy = (0.5 - Math.atan2(relY, Math.hypot(relX, relZ)) / panoVert) * h
        return { sx, sy, invZ: 1 / Math.max(1e-4, depth), u: vIn.u / Math.max(1e-4, depth), v: vIn.v / Math.max(1e-4, depth), depth }
      }
      sx = (1 + X / (Z * halfW)) * w / 2
      sy = (1 - Y / (Z * halfH)) * h / 2
      return { sx, sy, invZ: 1 / Z, u: vIn.u / Z, v: vIn.v / Z, depth }
    })

    for (let ti = 0; ti < screen.length - 2; ti++) {
      const tri = [screen[0], screen[ti + 1], screen[ti + 2]]
      const [a, b, c] = tri
      const area = (b.sx - a.sx) * (c.sy - a.sy) - (c.sx - a.sx) * (b.sy - a.sy)
      if (Math.abs(area) < 1e-6) continue
      const minX = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx)))
      const maxX = Math.min(w - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)))
      const minY = Math.max(0, Math.floor(Math.min(a.sy, b.sy, c.sy)))
      const maxY = Math.min(h - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)))
      if (maxX < minX || maxY < minY) continue
      const invArea = 1 / area
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5
          const cy = py + 0.5
          let w0 = ((b.sx - cx) * (c.sy - cy) - (c.sx - cx) * (b.sy - cy)) * invArea
          let w1 = ((c.sx - cx) * (a.sy - cy) - (a.sx - cx) * (c.sy - cy)) * invArea
          let w2 = 1 - w0 - w1
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
          w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2)
          const invZ = w0 * a.invZ + w1 * b.invZ + w2 * c.invZ
          if (invZ <= 1e-6) continue
          const depth = (w0 * a.depth * a.invZ + w1 * b.depth * b.invZ + w2 * c.depth * c.invZ) / invZ
          const idx = py * w + px
          if (depth > zbuf[idx] + 0.08) continue
          const uu = (w0 * a.u + w1 * b.u + w2 * c.u) / invZ
          const vv = (w0 * a.v + w1 * b.v + w2 * c.v) / invZ
          tex.sample(uu, vv, timeMs, 0, _texel)
          const alpha = _texel[3]
          if (alpha < 26) continue
          if (quad.layer === 'glint') {
            // Additive, depth-tested but non-writing, like the glint shader.
            const shimmer = 0.35 + 0.25 * Math.sin((timeMs / 900) + uu * 6.283)
            canvas.add(px, py, _texel[0], _texel[1], _texel[2], (alpha / 255) * shimmer)
            drawn++
            continue
          }
          if (quad.layer === 'translucent' || alpha < 250) {
            canvas.blend(px, py, _texel[0], _texel[1], _texel[2], alpha / 255)
          } else {
            canvas.set(px, py, _texel[0], _texel[1], _texel[2])
            zbuf[idx] = depth
          }
          drawn++
        }
      }
    }
  }
  return drawn
}

// ── Perspective (`look`) & 360° (`panorama`) renderer ─────────────────────

function formatPoint (p) { return p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?' }

function drawDepthRect (canvas, zbuf, x0, y0, x1, y1, dist, col, alpha = 1) {
  const ix0 = Math.max(0, Math.floor(x0))
  const iy0 = Math.max(0, Math.floor(y0))
  const ix1 = Math.min(canvas.w, Math.ceil(x1))
  const iy1 = Math.min(canvas.h, Math.ceil(y1))
  let drawn = 0
  for (let py = iy0; py < iy1; py++) {
    const row = py * canvas.w
    for (let px = ix0; px < ix1; px++) {
      if (dist <= zbuf[row + px] + 0.45) {
        if (alpha >= 1) canvas.set(px, py, col[0], col[1], col[2])
        else canvas.blend(px, py, col[0], col[1], col[2], alpha)
        drawn++
      }
    }
  }
  return drawn
}

// ── Item entities & held items ────────────────────────────────────────────

function hasRightArmBone (model) {
  return Boolean(model?.quads?.some((q) => q.bone === 'rightArm' || q.chain?.some((b) => b.name === 'rightArm')))
}

function droppedItemOf (entity) {
  if (!entity) return null
  try { if (typeof entity.getDroppedItem === 'function') return entity.getDroppedItem() } catch { /* partial metadata */ }
  return entity.droppedItem || entity.item || null
}

function rotateXRad (p, angle) {
  if (!angle) return p.slice()
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]
}

function itemQuadsInWorld (baked, place) {
  const out = []
  for (const q of baked.quads) {
    const pos = q.pos.map((p) => place(p))
    out.push({ ...q, pos })
  }
  return out
}

/** The point a compass needle points at (lodestone tracker, spawn, or none). */
function compassTargetFor (bot) {
  try {
    if (bot.lodestone) return { x: bot.lodestone.x, y: bot.lodestone.y, z: bot.lodestone.z, kind: 'lodestone' }
    const spawn = bot.spawnPoint
    if (spawn) return { x: spawn.x, y: spawn.y, z: spawn.z, kind: 'spawn' }
  } catch { /* optional */ }
  return null
}

function droppedItemWorldQuads (store, entity, timeMs, eye, unsupportedItems, state = {}) {
  const item = droppedItemOf(entity)
  if (!item) return null
  const name = store.itemNameOf(item)
  if (!name) return null
  const baked = store.quadsForStack(item, 'ground', {
    ...state,
    count: item.count,
    enchanted: isEnchanted(item)
  }) || store.quadsFor(name, 'ground')
  if (!baked) { unsupportedItems.add(name); return null }
  const spin = ((timeMs / 1000) * 1.8 + (Number(entity.id) || 0)) % (Math.PI * 2)
  const bob = Math.sin((timeMs / 480) + (Number(entity.id) || 0)) * 0.04
  const scale = 0.9
  const cy = Math.cos(spin)
  const sy = Math.sin(spin)
  const base = { x: entity.position.x, y: entity.position.y + 0.25 + bob, z: entity.position.z }
  const quads = itemQuadsInWorld(baked, (p) => [
    (p[0] * cy + p[2] * sy) * scale + base.x,
    p[1] * scale + base.y,
    (-p[0] * sy + p[2] * cy) * scale + base.z
  ])
  return {
    name,
    kind: baked.kind,
    count: item.count,
    quads,
    center: [base.x, base.y, base.z],
    dist: Math.hypot(base.x - eye.x, base.y - eye.y, base.z - eye.z)
  }
}

function selfHeldItemQuads (store, stack, eye, fwd, right, up, unsupportedItems, { hand = 'right', state = {} } = {}) {
  const name = store.itemNameOf(stack) || String(stack)
  const context = hand === 'left' ? 'firstperson_lefthand' : 'firstperson_righthand'
  const baked = store.quadsForStack(stack, context, { ...state, enchanted: isEnchanted(stack) }) ||
    store.quadsFor(name, context)
  if (!baked) { unsupportedItems.add(name); return null }
  // First-person hand placement is renderer-owned in vanilla too; the model
  // and its display transform are the real resources.
  const side = hand === 'left' ? -1 : 1
  const quads = itemQuadsInWorld(baked, (p) => {
    const s = 0.3
    const cx = p[0] * s + 0.5 * side
    const cy = p[1] * s - 0.5
    const cz = p[2] * s + 1.15
    return [
      eye.x + right[0] * cx + up[0] * cy + fwd[0] * cz,
      eye.y + right[1] * cx + up[1] * cy + fwd[1] * cz,
      eye.z + right[2] * cx + up[2] * cy + fwd[2] * cz
    ]
  })
  return { quads, name, kind: baked.kind, center: [eye.x, eye.y, eye.z], display: baked.displayTransform || null }
}

function heldItemWorldQuads (store, stackOrName, pose, xform, unsupportedItems, { hand = 'right', state = {} } = {}) {
  const name = store.itemNameOf(stackOrName) || String(stackOrName)
  const context = hand === 'left' ? 'thirdperson_lefthand' : 'thirdperson_righthand'
  const baked = store.quadsForStack(stackOrName, context, { ...state, enchanted: isEnchanted(stackOrName) }) ||
    store.quadsFor(name, context)
  if (!baked) { unsupportedItems.add(name); return null }
  const swing = pose?.rightArm?.[0] || 0
  const pivot = hand === 'left' ? [5 / 16, 22 / 16, 0] : [-5 / 16, 22 / 16, 0]
  const handPos = [
    pivot[0],
    pivot[1] + rotateXRad([0, -10 / 16, 0], swing)[1],
    rotateXRad([0, -10 / 16, 0], swing)[2]
  ]
  const cy = Math.cos(xform.yaw)
  const sy = Math.sin(xform.yaw)
  const scale = Number.isFinite(xform.scale) ? xform.scale : 1
  const quads = itemQuadsInWorld(baked, (p) => {
    const r = rotateXRad(p, swing)
    const x = (r[0] + handPos[0] * (hand === 'left' ? -1 : 1)) * scale
    const y = (r[1] + handPos[1]) * scale
    const z = (r[2] + handPos[2]) * scale
    return [x * cy + z * sy + xform.x, y + xform.y, -x * sy + z * cy + xform.z]
  })
  return { quads, kind: baked.kind, name }
}

/**
 * Item frames: the frame model (real `block/template_item_frame` when the
 * resources have it, the vanilla ring otherwise) plus the displayed stack in
 * the `fixed` display context, rotated by the synced `rotation` metadata
 * (45° steps) and facing the synced yaw.
 */
function itemFramesWorldQuads (store, assets, entity, stack, rotation, bot, notes) {
  const pos = entity.position
  if (!pos) return null
  const yaw = Number.isFinite(entity.yaw) ? entity.yaw : 0
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const center = [pos.x + 0.5, pos.y + 0.5, pos.z + 0.5]
  const built = specialModels.buildItemFrame({ assets })
  if (!built) return null
  const frameQuads = built.quads.map((q) => ({
    ...q,
    pos: q.pos.map((p) => {
      const x = p[0]
      const y = p[1]
      // Ring authored around the block centre; push it to the support face.
      const z = p[2] - 0.4375
      return [x * cy + z * sy + center[0], y + center[1], -x * sy + z * cy + center[2]]
    })
  }))
  const quads = frameQuads.slice()
  if (stack) {
    const itemName = store.itemNameOf(stack)
    const state = {
      displayContext: 'fixed',
      dayTime: Number.isFinite(bot?.time?.timeOfDay) ? bot.time.timeOfDay : 0,
      compassAngle: state0CompassAngle(bot, pos),
      enchanted: isEnchanted(stack)
    }
    const baked = store.quadsForStack(stack, 'fixed', state)
    if (baked) {
      const spin = -(rotation || 0) * Math.PI / 4
      const cs = Math.cos(spin)
      const sn = Math.sin(spin)
      for (const q of baked.quads) {
        quads.push({
          ...q,
          pos: q.pos.map((p) => {
            // rotation about the frame's normal (local z), 45° per metadata step
            const x = (p[0] * cs - p[1] * sn) * 0.5
            const y = (p[0] * sn + p[1] * cs) * 0.5
            const z = (p[2] * 0.5) - 0.40625
            return [x * cy + z * sy + center[0], y + center[1], -x * sy + z * cy + center[2]]
          })
        })
      }
    } else if (itemName) {
      notes.add(`item frame holds ${itemName} with no drawable model`)
    }
  }
  return { quads, center, kind: 'item_frame' }
}

/**
 * Entities that the client draws with a *block* model (primed TNT, falling
 * blocks) or with a painting sheet. The renderer reports precisely when the
 * data it needs is not synced to this client.
 */
function blockModelEntityQuads (store, assets, entity, bot, notes) {
  const name = String(entity?.name || '')
  const pos = entity.position
  if (!pos) return null
  if (name === 'tnt') {
    const stateId = Number(metaValue(entity, bot.registry, 'block_state')) || bot.registry.blocksByName.tnt?.defaultState
    if (!stateId) return null
    const model = store.modelForState(stateId, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    if (!model?.quads.length) return null
    const ox = pos.x - 0.5
    const oy = pos.y
    const oz = pos.z - 0.5
    return {
      quads: model.quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0] + ox, p[1] + oy, p[2] + oz]) })),
      center: [pos.x, pos.y + 0.5, pos.z],
      label: 'tnt'
    }
  }
  if (name === 'falling_block') {
    const stateId = Number(entity.blockStateId || metaValue(entity, bot.registry, 'block_state'))
    if (!stateId) {
      notes.add('falling_block: the client receives the block state in the spawn packet objectData, which mineflayer does not expose')
      return null
    }
    const model = store.modelForState(stateId, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    if (!model?.quads.length) return null
    const ox = pos.x - 0.5
    const oy = pos.y
    const oz = pos.z - 0.5
    return {
      quads: model.quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0] + ox, p[1] + oy, p[2] + oz]) })),
      center: [pos.x, pos.y + 0.5, pos.z],
      label: `falling ${model.name}`
    }
  }
  if (name === 'trident') {
    // Thrown tridents use the same TridentModel, spinning around their axis.
    const built = specialModels.buildTrident({ assets })
    if (!built) { notes.add('trident: TridentModel texture missing'); return null }
    const yaw = Number.isFinite(entity.yaw) ? entity.yaw : 0
    const pitch = Number.isFinite(entity.pitch) ? entity.pitch : 0
    const center = [pos.x, pos.y + 0.5, pos.z]
    const spin = (Date.now() / 6) % 360
    const quads = []
    for (const q of built.quads) {
      quads.push({
        ...q,
        pos: q.pos.map((p) => {
          // local: spin about the pole axis (y), then point the tip along the
          // entity's pitch, then turn to its yaw.
          const a = spin * Math.PI / 180
          const x1 = p[0] * Math.cos(a) - p[2] * Math.sin(a)
          const z1 = p[0] * Math.sin(a) + p[2] * Math.cos(a)
          const y1 = p[1] * Math.cos(pitch) - z1 * Math.sin(pitch)
          const z2 = p[1] * Math.sin(pitch) + z1 * Math.cos(pitch)
          return [x1 * Math.cos(yaw) + z2 * Math.sin(yaw) + center[0], y1 + center[1], -x1 * Math.sin(yaw) + z2 * Math.cos(yaw) + center[2]]
        })
      })
    }
    return { quads, center, label: 'trident' }
  }
  if (name === 'painting') {
    const raw = metaValue(entity, bot.registry, 'painting_variant')
    const variant = typeof raw === 'string' ? raw.replace(/^minecraft:/, '') : null
    if (!variant) {
      notes.add('painting: the variant is a registry id from the spawn packet, which mineflayer does not expose by name')
      return null
    }
    const texture = assets.entityTexture(`painting/${variant}`)
    if (!texture) return null
    // Painting sheets are 16 px per block, so the sheet size is the size in
    // blocks (vanilla `PaintingVariant` asset rule).
    const bw = texture.width / 16
    const bh = texture.height / 16
    const yaw = Number.isFinite(entity.yaw) ? entity.yaw : 0
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const center = [pos.x + 0.5, pos.y + bh / 2, pos.z + 0.5]
    const zOff = -0.46875
    const corners = [[-bw / 2, -bh / 2], [bw / 2, -bh / 2], [bw / 2, bh / 2], [-bw / 2, bh / 2]]
    const posOf = ([lx, ly]) => {
      const x = lx
      const z = zOff
      return [x * cy + z * sy + center[0], ly + center[1], -x * sy + z * cy + center[2]]
    }
    const uv = [[0, 1], [1, 1], [1, 0], [0, 0]]
    return {
      quads: [{
        pos: corners.map(posOf),
        uv,
        tex: texture,
        layer: 'cutout',
        normal: [-sy, 0, -cy],
        shadeDir: 1
      }],
      center,
      label: `painting/${variant}`
    }
  }
  return null
}

/** First texture reference that the loaded resources actually contain. */
function firstEntityTexture (assets, refs) {
  for (const ref of refs || []) {
    if (!ref) continue
    const texture = assets.entityTexture(ref)
    if (texture) return texture
  }
  return null
}

function state0CompassAngle (bot, pos) {
  const target = compassTargetFor(bot)
  if (!target || !pos) return 0
  return Math.atan2(target.z - pos.z, target.x - pos.x) * 180 / Math.PI
}

async function renderCamera (bot, opts) {
  const t0 = performance.now()
  const isPano = opts.view === 'panorama'
  // Interface overlays are annotations, never world geometry. They default to
  // "on for look, off for panorama" so the 360° capture is pure scenery.
  const overlayMode = String(opts.overlays || 'auto').toLowerCase()
  const wantOverlays = overlayMode === 'all' || (overlayMode !== 'none' && !isPano)
  const drawHud = opts.hud === undefined ? wantOverlays : Boolean(opts.hud)
  const drawLabels = opts.labels === undefined ? wantOverlays : Boolean(opts.labels)
  const w = Math.max(160, Math.min(800, Math.trunc(opts.width || (isPano ? 720 : 512))))
  const h = Math.max(100, Math.min(480, Math.trunc(opts.height || (isPano ? 200 : 288))))
  const configuredMax = Math.max(24, Math.min(192, Math.trunc(opts.maxDist || 128)))
  const timeMs = Number.isFinite(opts.timeMs) ? opts.timeMs : Date.now()

  const ctx = getNativeContext(bot, opts)
  const { assets, store, items } = ctx
  const skinResolver = getSkinResolver(bot, assets, opts)
  await skinResolver.prepare()

  const aim = isPano ? { bearing: 0, pitch: 0 } : resolveAim(bot, opts)
  const fwd = dirFor(aim.bearing, aim.pitch)
  const view = resolvePerspective(bot, opts, aim, fwd, isPano)
  const eye = view.eye
  const firstPerson = view.perspective === 'first'
  const sampler = new WorldSampler(bot, eye.x, eye.z, configuredMax)
  const maxDist = sampler.maxDist
  const sky = skyProfile(bot)
  const canvas = new Canvas(w, h)
  const zbuf = new Float32Array(w * h).fill(maxDist + 1)
  const rLen = Math.hypot(-fwd[2], fwd[0]) || 1
  const right = [-fwd[2] / rLen, 0, fwd[0] / rLen]
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0]
  ]
  const fovRad = (opts.fov || 86) * Math.PI / 180
  const halfW = Math.tan(fovRad / 2)
  const halfH = halfW * (h / w)
  const panoVert = 92 * Math.PI / 180
  const pixelAngle = isPano ? (Math.PI * 2) / w : (2 * halfW) / w
  const mipFootprint = (dist) => {
    const texels = dist * pixelAngle * 16
    return Math.max(0, Math.min(4, Math.floor(Math.log2(Math.max(1, texels)))))
  }

  const counts = new Map()
  let skyPx = 0
  let centerHit = null

  const eyeSid = sampler.stateIdAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z))
  const eyeModel = eyeSid ? store.modelForState(eyeSid, Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) : null
  const underwater = Boolean(eyeModel?.fluid && eyeModel.name === 'water')
  const waterTint = underwater
    ? (store.tintColor('water', 0, sampler.biomeNameAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)), {}) || [63, 118, 228])
    : null

  for (let py = 0; py < h; py++) {
    if (py > 0 && (py & 23) === 0) await new Promise((r) => setImmediate(r))
    const ny = 1 - 2 * (py + 0.5) / h
    for (let px = 0; px < w; px++) {
      let dx, dy, dz
      if (isPano) {
        const az = ((px + 0.5) / w - 0.5) * Math.PI * 2
        const el = ny * (panoVert / 2)
        const ce = Math.cos(el)
        dx = Math.sin(az) * ce
        dy = Math.sin(el)
        dz = -Math.cos(az) * ce
      } else {
        const nx = 2 * (px + 0.5) / w - 1
        dx = fwd[0] + right[0] * nx * halfW + up[0] * ny * halfH
        dy = fwd[1] + right[1] * nx * halfW + up[1] * ny * halfH
        dz = fwd[2] + right[2] * nx * halfW + up[2] * ny * halfH
        const inv = 1 / Math.hypot(dx, dy, dz)
        dx *= inv; dy *= inv; dz *= inv
      }

      const hit = traceRay(ctx, sampler, eye.x, eye.y, eye.z, dx, dy, dz, maxDist, timeMs, mipFootprint)
      let r, g, b, tHit = maxDist
      if (hit && !hit.sky) {
        r = hit.color[0]; g = hit.color[1]; b = hit.color[2]
        tHit = hit.t
        counts.set(hit.name, (counts.get(hit.name) || 0) + 1)
        for (const layer of hit.translucent || []) counts.set(layer.name, (counts.get(layer.name) || 0) + 1)
        if (!isPano && px === (w >> 1) && py === (h >> 1)) {
          const near = hit.translucent?.[0]
          centerHit = near
            ? { name: near.name, x: near.x, y: near.y, z: near.z, dist: near.t, layer: 'translucent' }
            : { name: hit.name, x: hit.x, y: hit.y, z: hit.z, dist: hit.t, layer: hit.layer }
        }
      } else {
        const skyCol = skyPixel(sky, dx, dy, dz, eye.x, eye.y, eye.z)
        r = skyCol[0]; g = skyCol[1]; b = skyCol[2]
        for (const layer of hit?.translucent || []) counts.set(layer.name, (counts.get(layer.name) || 0) + 1)
        if (!isPano && px === (w >> 1) && py === (h >> 1) && hit?.translucent?.length) {
          const near = hit.translucent[0]
          centerHit = { name: near.name, x: near.x, y: near.y, z: near.z, dist: near.t, layer: 'translucent' }
        }
      }

      // Composite translucent surfaces front-to-back over the opaque/sky base.
      const layers = hit?.translucent || []
      for (let li = layers.length - 1; li >= 0; li--) {
        const layer = layers[li]
        const a = layer.a
        r = r * (1 - a) + layer.rgb[0] * a
        g = g * (1 - a) + layer.rgb[1] * a
        b = b * (1 - a) + layer.rgb[2] * a
        tHit = Math.min(tHit, layer.t)
      }

      // Underwater fog (vanilla water colour), still fullbright.
      if (underwater) {
        const df = Math.min(1, tHit / Math.max(8, maxDist))
        const a = 0.35 + df * 0.5
        r = r * (1 - a) + waterTint[0] * a
        g = g * (1 - a) + waterTint[1] * a
        b = b * (1 - a) + waterTint[2] * a
      } else {
        const fogStart = maxDist * 0.72
        if (tHit > fogStart) {
          const f = Math.min(1, (tHit - fogStart) / Math.max(8, maxDist - fogStart))
          const fog = f * f * 0.32
          r = r * (1 - fog) + sky.horizon[0] * fog
          g = g * (1 - fog) + sky.horizon[1] * fog
          b = b * (1 - fog) + sky.horizon[2] * fog
        }
      }

      canvas.set(px, py, clampByte(r), clampByte(g), clampByte(b))
      if (hit && !hit.sky) zbuf[py * w + px] = hit.t
      else if (layers.length) {
        // Translucent ocean/glass with no opaque hit still occludes overlays.
        zbuf[py * w + px] = Math.min(...layers.map((l) => l.t))
      }
      if (!hit || hit.sky) skyPx++
    }
  }

  // ── Real entity models ────────────────────────────────────────────────
  const camera = { w, h, isPano, fwd, right, up, halfW, halfH, panoVert, eye }
  const project = makeProjector(eye, fwd, right, up, w, h, halfW, halfH, isPano, panoVert)
  const seenEnts = []
  const unsupported = new Set()
  const skinReport = []
  const entityQuads = []
  const seenItems = []
  const heldItems = []
  const unsupportedItems = new Set()
  const renderNotes = new Set()
  if (view.unknown && !isPano) {
    // Never silently pretend a requested perspective was honoured.
    renderNotes.add(`unknown perspective '${view.unknown}' (use 'first' or 'third'); rendered first person`)
  }
  const armorReport = []
  const variantReport = []
  const framesRendered = []
  const definitions = loadEntityDefinitions()

  // Shared item render state: real world/player values, never static frames.
  const worldItemState = (entity) => {
    const state = {
      dayTime: Number.isFinite(bot.time?.timeOfDay) ? bot.time.timeOfDay : 0,
      dimension: String(bot.game?.dimension || 'minecraft:overworld').includes(':')
        ? String(bot.game.dimension)
        : `minecraft:${String(bot.game?.dimension || 'overworld')}`,
      localDays: [],
      count: 1
    }
    try {
      const time = bot.time || {}
      if (Number.isFinite(time.day)) {
        const month = new Date(Date.UTC(2000, 0, 1) + (time.day * 86400000)).getUTCMonth() + 1
        const day = new Date(Date.UTC(2000, 0, 1) + (time.day * 86400000)).getUTCDate()
        state.localDays = [`${month}-${day}`]
      }
    } catch { /* optional */ }
    const pos = entity?.position || bot.entity?.position
    const compassTarget = compassTargetFor(bot)
    if (pos && compassTarget) {
      const dx = compassTarget.x - pos.x
      const dz = compassTarget.z - pos.z
      state.compassAngle = Math.atan2(dz, dx) * 180 / Math.PI
      state.compassTarget = compassTarget.kind
    } else if (Number.isFinite(bot.entity?.yaw)) {
      // No compass target (normal compass in the overworld points to world
      // spawn, which the client knows but the protocol does not send): use the
      // known spawn angle when available, otherwise the player facing.
      const spawn = bot.spawnPoint
      if (spawn && pos) {
        state.compassAngle = Math.atan2(spawn.z - pos.z, spawn.x - pos.x) * 180 / Math.PI
        state.compassTarget = 'spawn'
      }
    }
    return state
  }

  for (const item of entityList(bot, eye, maxDist, opts.isHostile, { definitions, includeSelf: !firstPerson })) {
    const e = item.entity
    let texture = null
    let slim = false
    let capeTexture = null
    let skinSource = null
    const modelName = item.modelKey

    if (item.isPlayer) {
      const skin = skinResolver.get(item.name)
      if (skin) {
        texture = skin.texture
        slim = skin.model === 'slim'
        capeTexture = skin.capeTexture || null
        skinSource = skin.source
        skinReport.push(`${item.name}=${skin.model}/${skin.source}${capeTexture ? '+cape' : ''}`)
      } else {
        texture = assets.entityTexture('entity/player/wide/steve') || assets.missingTexture
        skinSource = 'vanilla-default'
      }
    } else {
      const appearance = item.appearance
      texture = firstEntityTexture(assets, appearance?.textureCandidates || [appearance?.textureRef])
      if (!texture) {
        const entry = definitions[modelName] || definitions[modelName.replace(/^minecraft:/, '')]
        const key = entry?.textures?.default ? 'default' : entry?.textures ? Object.keys(entry.textures)[0] : null
        if (key) texture = assets.entityTexture(entry.textures[key])
      }
      if (!texture) {
        const fallbackRef = { zombie: 'entity/zombie/zombie', cow: 'entity/cow/cow' }[modelName]
        texture = fallbackRef ? assets.entityTexture(fallbackRef) : null
      }
      if (texture && appearance?.tint) texture = specialModels.tintedTexture(texture, appearance.tint)
      if (appearance?.baby) variantReport.push(`${modelName}:baby`)
      else if (appearance?.variant) variantReport.push(`${modelName}:${appearance.variant}`)
      for (const note of appearance?.notes || []) renderNotes.add(`${modelName}: ${note}`)
      if (appearance?.textureCandidates?.length && appearance.textureRef !== appearance.textureCandidates[0]) {
        renderNotes.add(`${modelName}: ${appearance.textureCandidates[0]} missing, using ${appearance.textureRef}`)
      }
    }

    const base = getEntityModel(modelName, { slim, variant: item.appearance?.geometryVariant || null })
    if (!base) {
      unsupported.add(`${modelName} (no client geometry in these resources)`)
      continue
    }
    if (!texture) {
      unsupported.add(`${modelName} (no texture in these resources)`)
      continue
    }
    const model = { ...base, texture, capeTexture }
    const pose = buildPose(e, model, timeMs, item.isPlayer, { registry: bot.registry })
    const yaw = Number.isFinite(e.yaw) ? e.yaw : 0
    const xform = { x: item.x, y: item.feetY, z: item.z, yaw, scale: item.scale }
    const posed = poseEntityModel(model, pose, xform)
    const center = [item.x, item.feetY + item.h * 0.5, item.z]
    for (const q of posed) {
      if (!q.tex) continue
      q.center = center
      entityQuads.push(q)
    }

    // Extra appearance layers (dyed wool, collars, horse markings, villager
    // biome overlay) drawn from their own sheets over the same model.
    for (const extra of item.appearance?.extraLayers || []) {
      const layerTexture = firstEntityTexture(assets, extra.textureCandidates || [extra.textureRef])
      if (!layerTexture) {
        unsupported.add(`${modelName} layer ${extra.textureRef} (texture)`)
        continue
      }
      const tinted = extra.tint ? specialModels.tintedTexture(layerTexture, extra.tint) : layerTexture
      const bones = extra.bones ? new Set(extra.bones) : null
      const layerQuads = posed.length
        ? base.quads.filter((q) => !bones || bones.has(q.bone)).map((q) => ({ ...q, tex: tinted }))
        : []
      if (!layerQuads.length) continue
      const posedLayer = poseEntityModel({ ...base, quads: layerQuads, texture: tinted }, pose, xform)
      for (const q of posedLayer) {
        if (!q.tex) continue
        q.center = center
        // The wool/collar/markings sheets are alpha cutouts over the skin.
        q.layer = tinted.hasSemiAlpha ? 'translucent' : 'cutout'
        entityQuads.push(q)
      }
      if (extra.note) renderNotes.add(`${modelName}: ${extra.note}`)
    }
    item.skinSource = skinSource
    seenEnts.push(item)

    // ── Equipped armour (real equipment assets + trims) ────────────────
    let equipment = item.equipment || []
    if (!equipment.length) {
      try { equipment = Array.isArray(e.equipment) ? e.equipment : [] } catch { equipment = [] }
    }
    const armorSlots = item.isPlayer || modelName === 'armor_stand'
      ? [[2, 'feet'], [3, 'legs'], [4, 'chest'], [5, 'head']]
      : []
    for (const [slot, part] of armorSlots) {
      const worn = equipment[slot]
      if (!worn) continue
      const wornName = items.itemNameOf(worn)
      const equip = equipmentOf(worn, wornName)
      if (!equip || equip.slot !== part) continue
      const resolved = resolveArmorLayers(equip, { assets })
      if (!resolved.layers.length) {
        if (resolved.missing) renderNotes.add(`${wornName}: ${resolved.missing}`)
        for (const note of resolved.notes) renderNotes.add(`${wornName}: ${note}`)
        continue
      }
      for (const layer of resolved.layers) {
        let armorQuads = []
        if (layer.wings) {
          const wings = elytraQuads(assets)
          armorQuads = wings.quads || []
          if (!armorQuads.length) renderNotes.add('elytra: wing geometry unavailable')
        } else {
          // Armour is authored against humanoid bone names; armour-stand and
          // other models use their own (lower-case) names for the same parts.
          const boneSet = model.boneNames || (model.boneNames = new Set(base.quads.map((q) => q.bone)))
          const bones = layer.bones.map((b) => {
            if (boneSet.has(b)) return b
            const alias = { rightArm: 'rightarm', leftArm: 'leftarm', rightLeg: 'rightleg', leftLeg: 'leftleg' }[b]
            return alias && boneSet.has(alias) ? alias : b
          })
          armorQuads = buildArmorQuads(model, {
            texture: layer.texture,
            bones,
            deformation: layer.deformation,
            trim: layer.trim
          })
        }
        if (!armorQuads.length) continue
        const posedArmor = poseEntityModel({ quads: armorQuads, texture: layer.texture }, pose, xform)
        for (const q of posedArmor) {
          if (!q.tex) continue
          q.center = center
          entityQuads.push(q)
        }
        armorReport.push(`${item.name}:${wornName}${layer.trim ? '/trim' : ''}`)
      }
    }

    // ── Both hands (vanilla slots 0 and 1) ─────────────────────────────
    if (hasRightArmBone(model)) {
      const handSlots = [[0, 'right'], [1, 'left']]
      for (const [slot, hand] of handSlots) {
        let stack = null
        try { stack = equipment[slot] || (slot === 0 ? e.heldItem : null) } catch { stack = null }
        if (!stack) continue
        const heldName = items.itemNameOf(stack)
        if (!heldName) continue
        const state = { ...worldItemState(e), count: stack.count, enchanted: isEnchanted(stack) }
        const held = heldItemWorldQuads(items, stack, pose, xform, unsupportedItems, { hand, state })
        if (!held) continue
        for (const q of held.quads) {
          if (!q.tex) continue
          q.center = center
          entityQuads.push(q)
        }
        heldItems.push(`${item.name} holds ${heldName}${hand === 'left' ? ' (off hand)' : ''}`)
      }
    }
  }

  // ── Item-model projectiles (thrown potions, firework rockets, …) ─────
  // The client draws these with the *item* model of the stack they carry.
  const ITEM_PROJECTILES = new Set(['potion', 'splash_potion', 'lingering_potion', 'firework_rocket', 'experience_bottle'])
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position) continue
    const name = String(e.name || '')
    if (!ITEM_PROJECTILES.has(name)) continue
    let stack = null
    try { stack = metaValue(e, bot.registry, 'item') || null } catch { stack = null }
    if (!stack && name === 'firework_rocket') stack = { name: 'firework_rocket', count: 1 }
    if (!stack) { renderNotes.add(`${name}: no carried item stack in metadata`); continue }
    const baked = items.quadsForStack(stack, 'ground', { ...itemState, enchanted: isEnchanted(stack) })
    if (!baked) { unsupportedItems.add(items.itemNameOf(stack) || name); continue }
    const center = [e.position.x, e.position.y + 0.2, e.position.z]
    const spin = ((timeMs / 1000) * 2.4 + (Number(e.id) || 0)) % (Math.PI * 2)
    const cy = Math.cos(spin)
    const sy = Math.sin(spin)
    for (const q of baked.quads) {
      if (!q.tex) continue
      entityQuads.push({
        ...q,
        pos: q.pos.map((p) => [p[0] * cy + p[2] * sy + center[0], p[1] + center[1], -p[0] * sy + p[2] * cy + center[2]]),
        center
      })
    }
    seenItems.push({ name: items.itemNameOf(stack) || name, kind: baked.kind, dist: Math.hypot(center[0] - eye.x, center[1] - eye.y, center[2] - eye.z) })
  }

  // ── Block-model entities (primed TNT, falling blocks, paintings) ─────
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position) continue
    if (!['tnt', 'falling_block', 'painting', 'trident'].includes(String(e.name || ''))) continue
    const built = blockModelEntityQuads(store, assets, e, bot, renderNotes)
    if (!built) continue
    for (const q of built.quads) {
      if (!q.tex) continue
      q.center = built.center
      entityQuads.push(q)
    }
    seenEnts.push({ name: built.label, id: e.id, hostile: false, dist: Math.hypot(built.center[0] - eye.x, built.center[1] - eye.y, built.center[2] - eye.z), tag: [200, 200, 200], entity: e })
  }

  // ── Item frames (entities with a synced item + rotation) ─────────────
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position) continue
    const name = String(e.name || '')
    if (name !== 'item_frame' && name !== 'glow_item_frame' && e.type !== 'item_frame') continue
    const stack = metaValue(e, bot.registry, 'item')
    const rotation = Number(metaValue(e, bot.registry, 'rotation') || 0)
    const frame = itemFramesWorldQuads(items, assets, e, stack, rotation, bot, renderNotes)
    if (!frame) continue
    for (const q of frame.quads) {
      if (!q.tex) continue
      q.center = frame.center
      entityQuads.push(q)
    }
    framesRendered.push(`${name}${stack ? ` ${items.itemNameOf(stack) || 'item'}` : ''}${name === 'glow_item_frame' ? ' (glowing)' : ''}`)
    if (name === 'glow_item_frame') renderNotes.add('glowing item frames use the normal frame texture; the client glow outline is a shader pass')
  }

  // Dropped item entities use the same real item models (ground display slot).
  const itemState = worldItemState(bot.entity)
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || !droppedItemOf(e)) continue
    const dropped = droppedItemWorldQuads(items, e, timeMs, eye, unsupportedItems, itemState)
    if (!dropped) continue
    if (dropped.dist < 0.4 || dropped.dist > maxDist) continue
    for (const q of dropped.quads) {
      if (!q.tex) continue
      q.center = dropped.center
      entityQuads.push(q)
    }
    seenItems.push({ name: dropped.name, kind: dropped.kind, dist: dropped.dist })
  }

  // The bot's own hands (main hand + off hand) in the first-person display slot.
  // Third person draws them on the visible body instead — never both.
  let firstPersonHands = false
  if (firstPerson && (opts.firstPersonHands === undefined ? !isPano : Boolean(opts.firstPersonHands))) try {
    const ownEquipment = Array.isArray(bot.entity?.equipment) ? bot.entity.equipment : []
    const hands = [
      [bot.heldItem || ownEquipment[0] || null, 'right'],
      [bot.offhandItem || ownEquipment[1] || null, 'left']
    ]
    for (const [own, hand] of hands) {
      const ownName = own ? items.itemNameOf(own) : null
      if (!ownName) continue
      const self = selfHeldItemQuads(items, own, eye, fwd, right, up, unsupportedItems, {
        hand,
        state: { ...itemState, count: own.count, enchanted: isEnchanted(own) }
      })
      if (!self) continue
      for (const q of self.quads) {
        if (!q.tex) continue
        q.center = self.center
        entityQuads.push(q)
      }
      heldItems.push(`you hold ${ownName}${hand === 'left' ? ' (off hand)' : ''}`)
      firstPersonHands = true
    }
  } catch { /* inventory not ready yet */ }

  // Opaque/cutout entity surfaces first (depth-writing), then translucent.
  const opaqueQuads = entityQuads.filter((q) => q.layer !== 'translucent')
  const translucentQuads = entityQuads.filter((q) => q.layer === 'translucent')
  rasterizeEntityQuads(canvas, zbuf, camera, opaqueQuads, timeMs)
  const distOf = (q) => Math.hypot(q.center[0] - eye.x, q.center[1] - eye.y, q.center[2] - eye.z)
  translucentQuads.sort((a, b) => distOf(b) - distOf(a))
  rasterizeEntityQuads(canvas, zbuf, camera, translucentQuads, timeMs)

  // Labels for visible creatures (annotation overlay, not world geometry).
  for (const e of seenEnts) {
    if (!drawLabels) break
    const head = project(e.x, e.feetY + e.h + 0.25, e.z)
    if (!head || head.sx < -20 || head.sx > w + 20 || head.sy < -10 || head.sy > h + 10) continue
    const label = `${e.name.slice(0, 12)} ${e.hostile ? 'HOSTILE ' : ''}${Math.round(e.dist)}m${e.isPlayer && e.skinSource ? ` ${e.skinSource}` : ''}`
    const lx = Math.max(2, Math.min(w - label.length * 6 - 3, Math.round(head.sx - label.length * 3)))
    const ly = Math.max(12, Math.round(head.sy) - 10)
    canvas.text(lx, ly, label, e.tag, [12, 14, 18, 0.78])
  }

  // ── Navigation overlay (unchanged semantics) ─────────────────────────
  const nav = opts.navigation
  const route = (nav?.path || []).slice(0, 256)
  const projectMarker = (point, color, size = 2) => {
    const vx = point.x - eye.x
    const vy = point.y - eye.y
    const vz = point.z - eye.z
    const dist = Math.hypot(vx, vy, vz)
    if (dist < 0.5 || dist > maxDist) return
    let sx, sy
    if (isPano) {
      sx = (Math.atan2(vx, -vz) / (2 * Math.PI) + 0.5) * w
      sy = (0.5 - Math.atan2(vy, Math.hypot(vx, vz)) / panoVert) * h
    } else {
      const tz = vx * fwd[0] + vy * fwd[1] + vz * fwd[2]
      if (tz <= 0) return
      sx = (1 + (vx * right[0] + vy * right[1] + vz * right[2]) / (tz * halfW)) * w / 2
      sy = (1 - (vx * up[0] + vy * up[1] + vz * up[2]) / (tz * halfH)) * h / 2
    }
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return
    drawDepthRect(canvas, zbuf, sx - size, sy - size, sx + size + 1, sy + size + 1, dist, color)
  }
  const asWorld = (p) => ({ x: p.x + 0.5, y: p.y + 0.15, z: p.z + 0.5 })
  const linePoints = [{ x: bot.entity.position.x, y: bot.entity.position.y + 0.15, z: bot.entity.position.z }, ...route.map(asWorld)]
  for (let i = 1; i < linePoints.length; i++) {
    const a = linePoints[i - 1]
    const b = linePoints[i]
    const steps = Math.min(512, Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 10)))
    for (let j = 0; j <= steps; j++) {
      const t = j / steps
      projectMarker({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, [80, 220, 255], 1)
    }
  }
  if (route[0]) projectMarker(asWorld(route[0]), [255, 220, 70], 2)
  if (nav?.destination) projectMarker(asWorld(nav.destination), [255, 90, 80], 3)

  // ── HUD ───────────────────────────────────────────────────────────────
  // Drawn as a screen-space annotation only when asked for; the panorama is
  // world imagery and never contains Minecraft UI.
  const p = bot.entity.position.floored()
  if (drawHud && isPano) {
    const marks = [
      [0.0, 'S', true], [0.125, 'SW', false], [0.25, 'W', true], [0.375, 'NW', false],
      [0.5, 'N', true], [0.625, 'NE', false], [0.75, 'E', true], [0.875, 'SE', false], [1.0, 'S', true]
    ]
    for (const [f, lab, major] of marks) {
      const mx = Math.min(w - 1, Math.round(f * (w - 1)))
      if (major && f > 0 && f < 1) {
        for (let py = 12; py < h; py++) canvas.blend(mx, py, 255, 255, 255, 0.22)
      }
      const lx = Math.max(2, Math.min(w - lab.length * 6 - 2, mx - Math.floor(lab.length * 3)))
      canvas.text(lx, 3, lab, major ? [255, 232, 118] : [210, 224, 240], [12, 18, 28, 0.78])
    }
    canvas.text(4, h - 10, `360 PANORAMA  X ${p.x} Y ${p.y} Z ${p.z}`, [242, 246, 250], [10, 14, 20, 0.72])
  } else if (drawHud) {
    const cx = w >> 1
    const cy = h >> 1
    for (let d = -5; d <= 5; d++) {
      if (Math.abs(d) > 1) {
        canvas.set(cx + d, cy, 245, 245, 245)
        canvas.set(cx, cy + d, 245, 245, 245)
      }
    }
    const dirLabel = aim.note ? aim.note.toUpperCase() : `LOOKING ${bearingName(aim.bearing)}`
    canvas.text(4, 3, `${dirLabel}  X ${p.x} Y ${p.y} Z ${p.z}`, [245, 248, 252], [10, 14, 20, 0.72])
  }

  const biome = (() => { try { return bot.blockAt(bot.entity.position)?.biome?.name || sampler.biomeNameAt(p.x, p.y, p.z) } catch { return 'unknown' } })()
  const dimension = bot.game?.dimension || 'unknown'
  const hud = [
    `BOT ${p.x} ${p.y} ${p.z} ${bearingName(yawToBearing(bot.entity.yaw || 0))} ${dimension} ${biome}`,
    `HP ${bot.health ?? '?'} FOOD ${bot.food ?? '?'} GOAL ${opts.goal || 'none'}`,
    `ACTION ${opts.action || 'none'} NAV ${nav?.status || 'unknown'} ${nav?.progress || ''}`,
    `NEXT ${formatPoint(nav?.waypoint)} DEST ${formatPoint(nav?.destination)} ${nav?.resetReason || ''}`
  ]
  if (drawHud) {
    hud.forEach((line, i) => canvas.text(4, 14 + i * 9, line.slice(0, Math.max(1, Math.floor((w - 8) / 6))), [240, 245, 250], [10, 14, 20, 0.8]))
  }

  const totalPx = w * h
  const topBlocks = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, n]) => `${name} ${Math.max(1, Math.round(n * 100 / totalPx))}%`)
  const skyPct = Math.round(skyPx * 100 / totalPx)
  const chunksInView = sampler.chunksTouched.size

  const lines = []
  if (isPano) {
    lines.push(`panorama from ${p.x},${p.y},${p.z} — full circle, NORTH in the middle${drawHud ? ', W left of it, E right, S at both edges' : ' (no compass/HUD overlay, world imagery only)'}; ${sky.label}`)
  } else {
    lines.push(`view from ${p.x},${p.y},${p.z} looking ${bearingName(aim.bearing)} (bearing ${Math.round(aim.bearing)}°, pitch ${Math.round(aim.pitch)}°, ${opts.fov || 86}° wide); ${sky.label}${aim.note ? `, ${aim.note}` : ''}`)
  }
  if (firstPerson) {
    lines.push(`camera: first person from your eyes (your own body, armour and outer layers are not drawn; ${firstPersonHands ? 'held item drawn in the first-person slot' : 'no first-person item overlay'})`)
  } else {
    lines.push(`camera: ${view.source === 'camera' ? 'fixed camera' : 'third person'} ${view.distance.toFixed(1)}m from your eyes; you are rendered like any player (skin, armour, elytra, both hands, outer layers) and no first-person overlay is drawn`)
  }
  if (!drawHud) lines.push('overlays: none (no HUD, crosshair, compass labels or entity labels; interface elements are never drawn as world geometry)')
  lines.push(`in frame: ${topBlocks.join(', ') || 'nothing solid'}; open sky/air ${skyPct}%`)
  if (centerHit) lines.push(`crosshair: ${centerHit.name} at ${centerHit.x},${centerHit.y},${centerHit.z} (${Math.round(centerHit.dist)}m, ${centerHit.layer})`)
  if (seenEnts.length) {
    const list = seenEnts.slice(0, 10).map((e) =>
      `${e.name} [id=${e.id}] ${Math.round(e.dist)}m${e.isSelf ? ' (you)' : e.hostile ? ' HOSTILE' : e.isPlayer ? ' player' : ''}${e.skinSource ? ` skin=${e.skinSource}` : ''}`
    )
    lines.push(`creatures in frame: ${list.join('; ')}`)
  }
  if (seenItems.length) {
    const counts = new Map()
    for (const it of seenItems) counts.set(it.name, (counts.get(it.name) || 0) + 1)
    lines.push(`items in frame: ${[...counts].slice(0, 10).map(([n, c]) => `${n}${c > 1 ? ` x${c}` : ''}`).join('; ')}`)
  }
  if (heldItems.length) lines.push(`held items: ${heldItems.slice(0, 8).join('; ')}`)
  if (armorReport.length) lines.push(`armour: ${[...new Set(armorReport)].slice(0, 8).join('; ')}`)
  if (variantReport.length) lines.push(`variants: ${[...new Set(variantReport)].slice(0, 8).join('; ')}`)
  if (framesRendered.length) lines.push(`item frames: ${framesRendered.slice(0, 6).join('; ')}`)
  if (renderNotes.size) lines.push(`render notes: ${[...renderNotes].slice(0, 6).join('; ')}`)
  if (unsupportedItems.size) lines.push(`items without item-model geometry in these resources: ${[...unsupportedItems].slice(0, 8).join(', ')}`)
  if (unsupported.size) lines.push(`entities without a client model in these resources: ${[...unsupported].slice(0, 8).join(', ')}`)
  const chunkNote = sampler.chunksLoaded > 0
    ? `${chunksInView}/${sampler.chunksLoaded} loaded chunks in view, out to ${maxDist}m`
    : `out to ${maxDist}m`
  lines.push(`bot: ${hud.join('; ')}`)
  try { const env = environmentSnapshot(bot); if (env?.line) lines.push(env.line) } catch { /* partial data */ }
  lines.push(`rendered from native Minecraft resources (${chunkNote}); blockstate/model/texture pipeline, vanilla render layers, fullbright`)
  lines.push(`assets: ${assets.label} [${assets.info.sources.join('; ')}] — ${assets.stats.texturesLoaded} textures, ${store.stats.states} states, ${store.stats.missingTextures.size} missing${assets.info.versionNote ? `; ${assets.info.versionNote}` : ''}`)
  if (skinResolver.report().length) {
    lines.push(`skins: ${skinResolver.report().map((s) => `${s.username}=${s.model}/${s.source}`).join(', ')}`)
  }
  if (store.stats.specialRenderers.size) {
    lines.push(`special renderers: ${[...store.stats.specialRenderers].slice(0, 10).join(', ')}`)
  }

  const png = encodePng(canvas.rgb, w, h)
  const renderMs = Math.round(performance.now() - t0)
  return {
    png,
    width: w,
    height: h,
    bytes: png.length,
    renderMs,
    chunksLoaded: sampler.chunksLoaded,
    chunksInView,
    maxDist,
    bearing: Math.round(aim.bearing),
    pitch: Math.round(aim.pitch),
    pos: { x: p.x, y: p.y, z: p.z },
    entitiesSeen: seenEnts.length,
    summary: lines.join('\n'),
    view: isPano ? 'panorama' : 'look',
    renderer: 'native-vanilla-models',
    fullbright: FULLBRIGHT,
    assetsVersion: assets.info.version,
    assetSources: assets.info.sources,
    texturesLoaded: assets.stats.texturesLoaded,
    skins: skinResolver.report(),
    itemsSeen: seenItems.length,
    itemNames: [...new Set(seenItems.map((i) => i.name))],
    selfHeldItem: heldItems.find((h) => h.startsWith('you hold '))?.slice(9) || null,
    heldItems,
    armor: [...new Set(armorReport)],
    variants: [...new Set(variantReport)],
    itemFrames: framesRendered,
    perspective: view.perspective,
    camera: { x: Number(eye.x.toFixed(2)), y: Number(eye.y.toFixed(2)), z: Number(eye.z.toFixed(2)), distance: Number(view.distance.toFixed(2)) },
    selfRendered: seenEnts.some((e) => e.isSelf),
    firstPersonHands,
    overlays: drawHud || drawLabels ? { hud: drawHud, labels: drawLabels } : null,
    renderNotes: [...renderNotes],
    unsupportedItems: [...unsupportedItems],
    unsupportedEntities: [...unsupported]
  }
}

// ── Top-down coordinate map renderer ──────────────────────────────────────

async function renderMap (bot, opts) {
  const t0 = performance.now()
  const radius = Math.max(12, Math.min(48, Math.trunc(opts.radius || 32)))
  const side = radius * 2 + 1
  const cell = Math.max(4, Math.min(8, Math.floor(384 / side)))
  const mapPx = side * cell
  const padL = 32; const padT = 24; const padR = 8; const padB = 14
  const w = padL + mapPx + padR
  const h = padT + mapPx + padB
  const timeMs = Number.isFinite(opts.timeMs) ? opts.timeMs : Date.now()

  const ctx = getNativeContext(bot, opts)
  const { store } = ctx
  const pos = bot.entity.position.floored()
  const sampler = new WorldSampler(bot, pos.x, pos.z, radius + 16)
  const canvas = new Canvas(w, h)
  canvas.rect(0, 0, w, h, [16, 20, 26])

  const yTopSearch = Math.min(sampler.globalMaxSolidY + 2, pos.y + 44)
  const yBotSearch = Math.max(sampler.globalMinSolidY - 1, pos.y - 32)
  const heights = new Int16Array(side * side).fill(-9999)
  const models = new Array(side * side).fill(null)
  const counts = new Map()
  let minY = Infinity
  let maxY = -Infinity

  for (let gz = 0; gz < side; gz++) {
    if (gz > 0 && (gz & 7) === 0) await new Promise((r) => setImmediate(r))
    const wz = pos.z - radius + gz
    for (let gx = 0; gx < side; gx++) {
      const wx = pos.x - radius + gx
      if (sampler.hasColumns) sampler.chunksTouched.add(chunkKey(wx >> 4, wz >> 4))
      for (let wy = yTopSearch; wy >= yBotSearch; wy--) {
        const sid = sampler.stateIdAt(wx, wy, wz)
        if (sid) {
          const m = store.modelForState(sid, wx, wy, wz)
          if (m.quads.length) {
            heights[gz * side + gx] = wy
            models[gz * side + gx] = { m, sid, wx, wy, wz }
            counts.set(m.name, (counts.get(m.name) || 0) + 1)
            if (wy < minY) minY = wy
            if (wy > maxY) maxY = wy
            break
          }
        }
      }
    }
  }

  const texel = [0, 0, 0, 0]
  for (let gz = 0; gz < side; gz++) {
    for (let gx = 0; gx < side; gx++) {
      const i = gz * side + gx
      const entry = models[i]
      let r = 24; let g = 28; let b = 34
      if (entry) {
        const hy = heights[i]
        const northY = gz > 0 ? heights[i - side] : hy
        const westY = gx > 0 ? heights[i - 1] : hy
        const slope = (hy - northY) * 0.085 + (hy - westY) * 0.05
        const rel = Math.max(-0.22, Math.min(0.24, (hy - pos.y) * 0.02))
        const shade = Math.max(0.55, Math.min(1.25, 1 + rel + Math.max(-0.22, Math.min(0.22, slope))))
        const quad = store.topQuad(entry.m)
        if (quad) {
          const biome = sampler.biomeNameAt(entry.wx, entry.wy, entry.wz)
          const tint = quad.tintindex >= 0
            ? store.tintColor(entry.m.name, quad.tintindex, biome, store.stateProps(entry.sid))
            : null
          // Sample the centre of the model's top face (real UV mapping).
          const uv0 = quad.uv[0]
          const uv1 = quad.uv[1]
          const uv2 = quad.uv[2]
          const uv3 = quad.uv[3]
          const cu = (uv0[0] + uv1[0] + uv2[0] + uv3[0]) / 4
          const cv = (uv0[1] + uv1[1] + uv2[1] + uv3[1]) / 4
          quad.tex.sample(cu, cv, timeMs, 2, texel)
          let tr = texel[0]
          let tg = texel[1]
          let tb = texel[2]
          if (texel[3] < 26) {
            // Transparent top face (glass/plants): use the model's dominant
            // visible texture instead of painting an invented colour.
            const alt = entry.m.texturesUsed.find((t) => t.hasAlpha) || entry.m.texturesUsed[0]
            if (alt) {
              alt.sample(0.5, 0.5, timeMs, 2, texel)
              tr = texel[0]; tg = texel[1]; tb = texel[2]
            }
          }
          if (tint) {
            tr = (tr * tint[0]) / 255
            tg = (tg * tint[1]) / 255
            tb = (tb * tint[2]) / 255
          }
          r = clampByte(tr * shade)
          g = clampByte(tg * shade)
          b = clampByte(tb * shade)
        }
      }
      const x0 = padL + gx * cell
      const y0 = padT + gz * cell
      canvas.rect(x0, y0, cell, cell, [r, g, b])
    }
  }

  const step = 8
  for (let wx = Math.ceil((pos.x - radius) / step) * step; wx <= pos.x + radius; wx += step) {
    const px = padL + Math.round((wx - (pos.x - radius) + 0.5) * cell)
    canvas.line(px, padT, px, padT + mapPx - 1, [255, 255, 255], 0.24)
    const lab = String(wx)
    canvas.text(Math.max(padL, Math.min(w - lab.length * 6 - 1, px - Math.floor(lab.length * 3))), 13, lab, [250, 224, 118])
  }
  for (let wz = Math.ceil((pos.z - radius) / step) * step; wz <= pos.z + radius; wz += step) {
    const py = padT + Math.round((wz - (pos.z - radius) + 0.5) * cell)
    canvas.line(padL, py, padL + mapPx - 1, py, [255, 255, 255], 0.24)
    canvas.text(2, Math.max(padT, Math.min(padT + mapPx - 8, py - 3)), String(wz), [132, 212, 252])
  }
  canvas.text(padL, 2, 'X (YELLOW) ACROSS   Z (BLUE) DOWN   NORTH IS UP', [224, 232, 240])
  canvas.text(padL, h - 10, `1 CELL = 1 BLOCK  GRID EVERY ${step}  SURFACE`, [186, 196, 208])

  const navPoints = [bot.entity.position, ...(opts.navigation?.path || [])]
  const mapPoint = (p) => {
    if (!p || Math.abs(p.x - pos.x) > radius || Math.abs(p.z - pos.z) > radius) return null
    return [padL + Math.round((p.x - pos.x + radius + 0.5) * cell), padT + Math.round((p.z - pos.z + radius + 0.5) * cell)]
  }
  for (let i = 1; i < navPoints.length; i++) {
    const a = mapPoint(navPoints[i - 1])
    const b = mapPoint(navPoints[i])
    if (a && b) canvas.line(a[0], a[1], b[0], b[1], [80, 220, 255])
    if (b) canvas.rect(b[0] - 1, b[1] - 1, 3, 3, i === 1 ? [255, 220, 70] : [80, 220, 255])
  }
  const dest = mapPoint(opts.navigation?.destination)
  if (dest) canvas.rect(dest[0] - 3, dest[1] - 3, 7, 7, [255, 90, 80])

  const entsOnMap = []
  for (const e of entityList(bot, bot.entity.position, radius * 1.45, opts.isHostile)) {
    const dx = e.x - pos.x
    const dz = e.z - pos.z
    if (Math.abs(dx) > radius || Math.abs(dz) > radius) continue
    const px = padL + Math.round((dx + radius + 0.5) * cell)
    const py = padT + Math.round((dz + radius + 0.5) * cell)
    canvas.rect(px - 2, py - 2, 5, 5, e.tag)
    canvas.outline(px - 3, py - 3, 7, 7, [0, 0, 0])
    const lab = e.name.slice(0, 10)
    canvas.text(Math.max(padL, Math.min(padL + mapPx - lab.length * 6, px + 4)), Math.max(padT, py - 3), lab, e.tag, [10, 14, 20, 0.80])
    entsOnMap.push(e)
  }

  const bx = padL + Math.round((radius + 0.5) * cell)
  const bz = padT + Math.round((radius + 0.5) * cell)
  const fwd = dirFor(yawToBearing(bot.entity.yaw || 0), 0)
  canvas.line(bx, bz, Math.round(bx + fwd[0] * cell * 2.5), Math.round(bz + fwd[2] * cell * 2.5), [255, 255, 255])
  canvas.rect(bx - 3, bz - 3, 7, 7, [255, 255, 255])
  canvas.outline(bx - 4, bz - 4, 9, 9, [0, 0, 0])
  canvas.text(bx + 6, bz + 3, 'YOU', [255, 255, 255], [10, 14, 20, 0.82])

  const total = side * side
  const topGround = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, n]) => `${name} ${Math.max(1, Math.round(n * 100 / total))}%`)
  const chunksInView = sampler.chunksTouched.size

  const lines = [
    `map centred on you at ${pos.x},${pos.y},${pos.z}: ${side}x${side} blocks (x ${pos.x - radius}..${pos.x + radius}, z ${pos.z - radius}..${pos.z + radius}), north up, grid line every ${step} blocks labelled with world x (top, yellow) and z (left, blue)`
  ]
  try { const env = environmentSnapshot(bot); if (env?.line) lines.push(env.line) } catch { /* partial */ }
  if (Number.isFinite(minY)) lines.push(`surface heights y ${minY}..${maxY} (lighter = higher than you, darker = lower)`)
  lines.push(`ground: ${topGround.join(', ') || 'unloaded'}`)
  if (entsOnMap.length) {
    lines.push(`creatures: ${entsOnMap.slice(0, 10).map((e) =>
      `${e.name} [id=${e.id}] at ${Math.floor(e.x)},${Math.floor(e.feetY)},${Math.floor(e.z)}${e.hostile ? ' HOSTILE' : e.isPlayer ? ' player' : ''}`
    ).join('; ')}`)
  }
  if (opts.perspective) lines.push(`map is a top-down diagram, so the requested perspective '${opts.perspective}' does not apply (no first/third person here)`)
  lines.push(`you = white square, the white line shows your facing (${chunksInView}/${sampler.chunksLoaded} loaded chunks sampled)`)
  lines.push(`surface textures sampled from native block models (fullbright)`)

  const png = encodePng(canvas.rgb, w, h)
  const renderMs = Math.round(performance.now() - t0)
  return {
    png,
    width: w,
    height: h,
    bytes: png.length,
    renderMs,
    chunksLoaded: sampler.chunksLoaded,
    chunksInView,
    maxDist: radius,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    entitiesSeen: entsOnMap.length,
    summary: lines.join('\n'),
    view: 'map',
    renderer: 'native-vanilla-models',
    fullbright: FULLBRIGHT,
    assetsVersion: ctx.assets.info.version,
    assetSources: ctx.assets.info.sources,
    texturesLoaded: ctx.assets.stats.texturesLoaded
  }
}

// ── Public entry point ────────────────────────────────────────────────────

async function screenshot (bot, opts = {}) {
  if (!bot?.entity?.position) throw new Error('bot is not spawned yet')
  const view = String(opts.view || 'look').trim().toLowerCase()
  if (view === 'map' || view === 'top' || view === 'overhead') return renderMap(bot, opts)
  if (view === 'panorama' || view === 'pano' || view === '360' || view === 'around') return renderCamera(bot, { ...opts, view: 'panorama' })
  return renderCamera(bot, { ...opts, view: 'look' })
}

module.exports = {
  screenshot,
  encodePng,
  FULLBRIGHT,
  _internal: {
    skyProfile,
    createAssetProvider,
    ItemModelStore,
    getNativeContext,
    BlockModelStore,
    buildEntityModel,
    poseEntityModel,
    SkinResolver
  }
}
