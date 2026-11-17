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
const { buildEntityModel, poseEntityModel, loadEntityDefinitions } = require('./native/entityModels')
const { SkinResolver } = require('./native/skins')

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
  const ctx = { assets, store }
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

const entityModelCache = new Map()
function getEntityModel (name, { slim = false, variant = null } = {}) {
  const key = `${name}|${slim ? 'slim' : 'wide'}|${variant || 'default'}`
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

// ── Entity list & real-model rasterization ─────────────────────────────────

const HOSTILE_NAME = /zombie|skeleton|creeper|spider|enderman|witch|pillager|vindicator|evoker|ravager|phantom|blaze|ghast|slime|magma|guardian|drowned|husk|stray|wither|piglin|hoglin|zoglin|silverfish|vex|shulker|breeze|bogged|creaking|warden|elder_guardian/

function hostileFor (name, e, isHostile) {
  if (isHostile) { try { return Boolean(isHostile(name)) } catch { /* fall through */ } }
  if (e?.type === 'hostile') return true
  return HOSTILE_NAME.test(String(name || ''))
}

function entityList (bot, eye, maxDist, isHostile) {
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue
    if (!['player', 'mob', 'hostile', 'animal', 'passive'].includes(e.type)) continue
    const name = e.type === 'player' ? (e.username || 'player') : (e.name || e.type || 'mob')
    const hostile = e.type !== 'player' && hostileFor(name, e, isHostile)
    const base = e.type === 'player' ? getEntityModel('player', { slim: false }) : getEntityModel(name, {})
    const h = Number.isFinite(e.height) && e.height > 0 ? e.height : (base?.height || 1.4)
    const w = Number(modelWidth(base, e))
    const dist = Math.hypot(e.position.x - eye.x, e.position.y + h * 0.5 - eye.y, e.position.z - eye.z)
    if (dist < 0.6 || dist > maxDist) continue
    out.push({
      id: e.id,
      name,
      type: e.name || e.type,
      isPlayer: e.type === 'player',
      hostile,
      entity: e,
      x: e.position.x,
      feetY: e.position.y,
      z: e.position.z,
      w,
      h,
      dist,
      tag: hostile ? [255, 96, 88] : e.type === 'player' ? [96, 224, 255] : [248, 228, 112]
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

function buildPose (entity, model, nowMs, isPlayer) {
  const pose = {}
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

  if (isPlayer || model.bones?.head) {
    const pitch = Number.isFinite(entity.pitch) ? entity.pitch : 0
    if (boneNames.has('head')) pose.head = [-pitch, 0, 0]
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

async function renderCamera (bot, opts) {
  const t0 = performance.now()
  const isPano = opts.view === 'panorama'
  const w = Math.max(160, Math.min(800, Math.trunc(opts.width || (isPano ? 720 : 512))))
  const h = Math.max(100, Math.min(480, Math.trunc(opts.height || (isPano ? 200 : 288))))
  const configuredMax = Math.max(24, Math.min(192, Math.trunc(opts.maxDist || 128)))
  const timeMs = Number.isFinite(opts.timeMs) ? opts.timeMs : Date.now()

  const ctx = getNativeContext(bot, opts)
  const { assets, store } = ctx
  const skinResolver = getSkinResolver(bot, assets, opts)
  await skinResolver.prepare()

  const eye = bot.entity.position.offset(0, 1.62, 0)
  const sampler = new WorldSampler(bot, eye.x, eye.z, configuredMax)
  const maxDist = sampler.maxDist
  const sky = skyProfile(bot)
  const canvas = new Canvas(w, h)
  const zbuf = new Float32Array(w * h).fill(maxDist + 1)

  const aim = isPano ? { bearing: 0, pitch: 0 } : resolveAim(bot, opts)
  const fwd = dirFor(aim.bearing, aim.pitch)
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

  for (const item of entityList(bot, eye, maxDist, opts.isHostile)) {
    const e = item.entity
    let texture = null
    let slim = false
    const capeTexture = null
    let skinSource = null
    let modelName = item.name

    if (item.isPlayer) {
      modelName = 'player'
      const skin = skinResolver.get(item.name)
      if (skin) {
        texture = skin.texture
        slim = skin.model === 'slim'
        skinSource = skin.source
        skinReport.push(`${item.name}=${skin.model}/${skin.source}`)
      } else {
        texture = assets.entityTexture('entity/player/wide/steve') || assets.missingTexture
        skinSource = 'vanilla-default'
      }
    } else {
      const defs = loadEntityDefinitions()
      const entry = defs[modelName] || defs[modelName.replace(/^minecraft:/, '')]
      if (entry?.textures) {
        const key = entry.textures.default ? 'default' : Object.keys(entry.textures)[0]
        const ref = entry.textures[key]
        texture = assets.entityTexture(ref)
      }
      if (!texture) {
        const fallbackRef = { zombie: 'entity/zombie/zombie', cow: 'entity/cow/cow' }[modelName]
        texture = fallbackRef ? assets.entityTexture(fallbackRef) : null
      }
    }

    const base = getEntityModel(modelName, { slim })
    if (!base || !texture) {
      unsupported.add(modelName)
      continue
    }
    const model = { ...base, texture, capeTexture }
    const pose = buildPose(e, model, timeMs, item.isPlayer)
    const posed = poseEntityModel(model, pose, {
      x: item.x,
      y: item.feetY,
      z: item.z,
      yaw: Number.isFinite(e.yaw) ? e.yaw : 0
    })
    const center = [item.x, item.feetY + item.h * 0.5, item.z]
    for (const q of posed) {
      if (!q.tex) continue
      q.center = center
      entityQuads.push(q)
    }
    item.skinSource = skinSource
    seenEnts.push(item)
  }

  // Opaque/cutout entity surfaces first (depth-writing), then translucent.
  const opaqueQuads = entityQuads.filter((q) => q.layer !== 'translucent')
  const translucentQuads = entityQuads.filter((q) => q.layer === 'translucent')
  rasterizeEntityQuads(canvas, zbuf, camera, opaqueQuads, timeMs)
  const distOf = (q) => Math.hypot(q.center[0] - eye.x, q.center[1] - eye.y, q.center[2] - eye.z)
  translucentQuads.sort((a, b) => distOf(b) - distOf(a))
  rasterizeEntityQuads(canvas, zbuf, camera, translucentQuads, timeMs)

  // Labels for visible creatures.
  for (const e of seenEnts) {
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
  const p = bot.entity.position.floored()
  if (isPano) {
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
  } else {
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
  hud.forEach((line, i) => canvas.text(4, 14 + i * 9, line.slice(0, Math.max(1, Math.floor((w - 8) / 6))), [240, 245, 250], [10, 14, 20, 0.8]))

  const totalPx = w * h
  const topBlocks = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, n]) => `${name} ${Math.max(1, Math.round(n * 100 / totalPx))}%`)
  const skyPct = Math.round(skyPx * 100 / totalPx)
  const chunksInView = sampler.chunksTouched.size

  const lines = []
  if (isPano) {
    lines.push(`panorama from ${p.x},${p.y},${p.z} — full circle, NORTH in the middle, W left of it, E right, S at both edges; ${sky.label}`)
  } else {
    lines.push(`view from ${p.x},${p.y},${p.z} looking ${bearingName(aim.bearing)} (bearing ${Math.round(aim.bearing)}°, pitch ${Math.round(aim.pitch)}°, ${opts.fov || 86}° wide); ${sky.label}${aim.note ? `, ${aim.note}` : ''}`)
  }
  lines.push(`in frame: ${topBlocks.join(', ') || 'nothing solid'}; open sky/air ${skyPct}%`)
  if (centerHit) lines.push(`crosshair: ${centerHit.name} at ${centerHit.x},${centerHit.y},${centerHit.z} (${Math.round(centerHit.dist)}m, ${centerHit.layer})`)
  if (seenEnts.length) {
    const list = seenEnts.slice(0, 10).map((e) =>
      `${e.name} [id=${e.id}] ${Math.round(e.dist)}m${e.hostile ? ' HOSTILE' : e.isPlayer ? ' player' : ''}${e.skinSource ? ` skin=${e.skinSource}` : ''}`
    )
    lines.push(`creatures in frame: ${list.join('; ')}`)
  }
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
    getNativeContext,
    BlockModelStore,
    buildEntityModel,
    poseEntityModel,
    SkinResolver
  }
}
