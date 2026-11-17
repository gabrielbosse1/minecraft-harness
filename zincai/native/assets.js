/**
 * zincai/native/assets.js — real Minecraft client resource loading.
 *
 * The renderer no longer invents textures. It resolves the same files the
 * Minecraft client loads:
 *
 *   1. An official client install (`.minecraft/versions/<v>/<v>.jar` or
 *      `ZINC_MC_JAR`), read directly as a ZIP: `assets/minecraft/blockstates`,
 *      `assets/minecraft/models`, `assets/minecraft/textures`, `.mcmeta`.
 *   2. A `.minecraft/assets` object store (`ZINC_MC_ASSETS`/`MINECRAFT_HOME`),
 *      using the real asset index JSON.
 *   3. Extracted client resources shipped by prismarine-viewer
 *      (`public/textures/<version>/`): exactly the jar contents unpacked —
 *      real block textures, blockstates, models, entity textures, colormaps.
 *   4. An extracted resource pack directory in the same layout, plus optional
 *      extra packs (`ZINC_RESOURCE_PACKS`) applied on top with vanilla pack
 *      precedence (later packs win).
 *
 * The version is taken from the live bot (`bot.version`), never hardcoded.
 * Blocks, models and textures are looked up by their real resource names, so
 * cherry grove blocks resolve to cherry's own model + textures.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { decodePng, decodeMcmeta } = require('./png')

// ── Version handling ────────────────────────────────────────────────────────

function versionParts (v) {
  return String(v || '').replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
}

function compareVersions (a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

function listDirs (dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

function firstExisting (paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p } catch { /* keep looking */ }
  }
  return null
}

// ── Minimal ZIP reader for the official client jar ──────────────────────────

class ZipArchive {
  constructor (file) {
    this.file = file
    this.buf = null
    this.entries = new Map()
  }

  load () {
    if (this.buf) return true
    try {
      this.buf = fs.readFileSync(this.file)
    } catch {
      return false
    }
    const buf = this.buf
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 0xffff - 22); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) return false
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
      const method = buf.readUInt16LE(p + 10)
      const compSize = buf.readUInt32LE(p + 20)
      const size = buf.readUInt32LE(p + 24)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      const localOffset = buf.readUInt32LE(p + 42)
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
      this.entries.set(name, { method, compSize, size, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return this.entries.size > 0
  }

  read (name) {
    if (!this.load()) return null
    const entry = this.entries.get(name)
    if (!entry) return null
    const buf = this.buf
    const p = entry.localOffset
    if (buf.readUInt32LE(p) !== 0x04034b50) return null
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const start = p + 30 + nameLen + extraLen
    const data = buf.subarray(start, start + entry.compSize)
    try {
      if (entry.method === 0) return data
      if (entry.method === 8) return zlib.inflateRawSync(data)
    } catch {
      return null
    }
    return null
  }

  has (name) {
    if (!this.load()) return false
    return this.entries.has(name)
  }
}

// ── Resource packs ──────────────────────────────────────────────────────────

/** Directory laid out like the client resource tree (`assets/minecraft/...`). */
class DirectoryPack {
  constructor (root, name, opaque = false) {
    this.root = root
    this.name = name
    this.opaque = opaque // bundled prismarine extraction uses non-standard paths
  }

  _try (rel) {
    try {
      const p = path.join(this.root, rel)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p)
    } catch { /* unreadable file is just a miss */ }
    return null
  }

  readResource (rel) {
    // rel is namespace-relative: blockstates/x.json, textures/block/x.png
    if (!this.opaque) {
      const direct = this._try(path.join('assets', 'minecraft', rel))
      if (direct) return direct
      const bare = this._try(rel)
      if (bare) return bare
    }
    return null
  }

  readBundled (rel) {
    return this._try(rel)
  }

  read (rel) {
    return this.readResource(rel) || this.readBundled(rel)
  }
}

/** Official client jar as a resource pack. */
class JarPack {
  constructor (file) {
    this.name = `client-jar:${path.basename(file)}`
    this.zip = new ZipArchive(file)
  }

  readResource (rel) {
    return this.zip.read(path.posix.join('assets/minecraft', rel))
  }

  readBundled (rel) {
    return this.zip.read(path.posix.join('assets/minecraft', rel))
  }

  read (rel) {
    return this.readResource(rel)
  }
}

/** Modern `.minecraft/assets` object store addressed through its index. */
class ObjectStorePack {
  constructor (assetsDir, indexFile) {
    this.name = `asset-index:${path.basename(indexFile)}`
    this.root = assetsDir
    this.index = null
    try {
      const json = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      this.index = json.objects || {}
    } catch { this.index = {} }
  }

  read (rel) {
    const key = `minecraft/${rel}`
    const obj = this.index[key]
    if (!obj || !obj.hash) return null
    try {
      const p = path.join(this.root, 'objects', obj.hash.slice(0, 2), obj.hash)
      return fs.readFileSync(p)
    } catch { return null }
  }

  readResource (rel) { return this.read(rel) }
}

// ── Texture objects (with real alpha, frames and mip levels) ────────────────

const MISSING_TEXTURE = (() => {
  // The client's missing-texture checkerboard (magenta / black).
  const size = 16
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dark = ((x >> 3) ^ (y >> 3)) & 1
      rgba[i] = dark ? 40 : 248
      rgba[i + 1] = 20
      rgba[i + 2] = dark ? 40 : 248
      rgba[i + 3] = 255
    }
  }
  return { width: size, height: size, rgba }
})()

class Texture {
  constructor (name, png, mcmeta) {
    this.name = name
    this.width = png.width
    this.height = png.height
    this.rgba = png.rgba
    this.hasAlpha = false
    this.hasSemiAlpha = false
    for (let i = 3; i < this.rgba.length; i += 4) {
      const a = this.rgba[i]
      if (a < 255) {
        this.hasAlpha = true
        if (a > 0) { this.hasSemiAlpha = true; break }
      }
    }

    const square = this.width > 0 && this.height % this.width === 0
    const framesInStrip = square ? this.height / this.width : 1
    const anim = mcmeta && framesInStrip > 1 ? mcmeta : null
    this.animated = Boolean(anim)
    this.frames = anim
      ? (anim.frames || Array.from({ length: framesInStrip }, (_, i) => i))
      : [0]
    this.frameCount = this.frames.length
    this.frameTime = Math.max(1, (anim?.frametime || 1))
    this.interpolate = Boolean(anim?.interpolate)
    this._mips = null
  }

  /** Frame index the client would show at wall-clock `timeMs`. */
  frameAt (timeMs = 0) {
    if (!this.animated || this.frameCount <= 1) return 0
    const ticks = Math.floor((timeMs / 1000) * 20)
    const step = Math.floor(ticks / this.frameTime)
    return this.frames[((step % this.frameCount) + this.frameCount) % this.frameCount] || 0
  }

  mipLevels (frameIndex = 0) {
    if (!this._mips) this._mips = new Map()
    if (this._mips.has(frameIndex)) return this._mips.get(frameIndex)
    const fh = this.animated ? this.width : this.height
    const fy = this.animated ? frameIndex * this.width : 0
    const levels = []
    let w = this.width
    let h = fh
    let src = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      const from = ((fy + y) * this.width) * 4
      src.set(this.rgba.subarray(from, from + w * 4), y * w * 4)
    }
    levels.push({ w, h, rgba: src })
    while (w > 1 || h > 1) {
      const nw = Math.max(1, w >> 1)
      const nh = Math.max(1, h >> 1)
      const out = new Uint8Array(nw * nh * 4)
      for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
          let r = 0; let g = 0; let b = 0; let a = 0
          let n = 0
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(w - 1, x * 2 + dx)
              const sy = Math.min(h - 1, y * 2 + dy)
              const i = (sy * w + sx) * 4
              const al = src[i + 3]
              // Weight colour by alpha so transparent texels do not bleed
              // dark fringes into cutout edges.
              r += src[i] * al
              g += src[i + 1] * al
              b += src[i + 2] * al
              a += al
              n++
            }
          }
          const di = (y * nw + x) * 4
          if (a > 0) {
            out[di] = Math.round(r / a)
            out[di + 1] = Math.round(g / a)
            out[di + 2] = Math.round(b / a)
            out[di + 3] = Math.round(a / n)
          }
        }
      }
      src = out
      w = nw
      h = nh
      levels.push({ w, h, rgba: src })
    }
    this._mips.set(frameIndex, levels)
    return levels
  }

  /**
   * Sample at UV (0..1, v down), keeping texture edges clamped. `mip` selects
   * the mipmap level (clamped to the real chain). Returns [r,g,b,a].
   */
  sample (u, v, timeMs = 0, mip = 0, out = null) {
    const frame = this.frameAt(timeMs)
    const levels = this.mipLevels(frame)
    const level = levels[Math.max(0, Math.min(levels.length - 1, mip | 0))]
    const w = level.w
    const h = level.h
    let x = Math.floor(u * w)
    let y = Math.floor(v * h)
    if (x < 0) x = 0
    else if (x >= w) x = w - 1
    if (y < 0) y = 0
    else if (y >= h) y = h - 1
    const i = (y * w + x) * 4
    const rgba = level.rgba
    const res = out || [0, 0, 0, 0]
    res[0] = rgba[i]
    res[1] = rgba[i + 1]
    res[2] = rgba[i + 2]
    res[3] = rgba[i + 3]
    return res
  }
}

// ── Asset provider ──────────────────────────────────────────────────────────

function namespacePath (ref) {
  let s = String(ref || '').replace(/^minecraft:/, '')
  s = s.replace(/^minecraft\//, '')
  return s
}

class AssetProvider {
  constructor ({ version, roots = [], packs = [], bundledRoot = null, info = {} } = {}) {
    this.version = version
    this.roots = roots
    this.packs = packs
    this.bundledRoot = bundledRoot
    this.info = info
    this._textures = new Map()
    this._textureMisses = new Set()
    this._blockstates = null
    this._models = null
    this._blockstateFileCache = new Map()
    this._modelFileCache = new Map()
    this._itemModelCache = new Map()
    this._colormaps = new Map()
    this._atlas = null
    this.stats = { texturesLoaded: 0, textureMisses: 0 }
  }

  get label () {
    return this.info.label || `minecraft ${this.version}`
  }

  _read (rel) {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      try {
        const buf = this.packs[i].read(rel)
        if (buf && buf.length) return buf
      } catch { /* pack failure is a miss, try the next pack */ }
    }
    return null
  }

  _readJson (rel) {
    const buf = this._read(rel)
    if (!buf) return null
    try { return JSON.parse(buf.toString('utf8')) } catch { return null }
  }

  getBundledJson (name) {
    if (!this.bundledRoot) return null
    return this._readJson(name)
  }

  blockstatesAll () {
    if (!this._blockstates) {
      this._blockstates = this.getBundledJson('blocks_states.json') || {}
    }
    return this._blockstates
  }

  modelsAll () {
    if (!this._models) {
      this._models = this.getBundledJson('blocks_models.json') || {}
    }
    return this._models
  }

  /** Real `assets/minecraft/blockstates/<block>.json` with bundled fallback. */
  blockstate (blockName) {
    if (this._blockstateFileCache.has(blockName)) return this._blockstateFileCache.get(blockName)
    let def = this._readJson(`blockstates/${blockName}.json`)
    if (!def) {
      const all = this.blockstatesAll()
      def = all[blockName] || all[`minecraft:${blockName}`] || null
    }
    this._blockstateFileCache.set(blockName, def)
    return def
  }

  /**
   * Real model JSON by resource reference (`minecraft:block/cherry_leaves`,
   * `block/cube_all`, ...). Official per-file lookup first, bundled second.
   */
  model (ref) {
    let clean = namespacePath(ref)
    if (clean.startsWith('block/')) clean = clean.slice(6)
    if (this._modelFileCache.has(clean)) return this._modelFileCache.get(clean)
    let def = this._readJson(`models/block/${clean}.json`)
    if (!def) def = this._readJson(`models/${clean}.json`)
    if (!def) {
      const all = this.modelsAll()
      def = all[clean] || all[`block/${clean}`] || all[`minecraft:block/${clean}`] || null
    }
    this._modelFileCache.set(clean, def)
    return def
  }

  /**
   * Load a block texture by its resource reference. Returns a Texture
   * carrying the real pixels and alpha channel, or the client's
   * missing-texture checkerboard.
   */
  blockTexture (ref) {
    let clean = namespacePath(ref)
    if (clean.startsWith('block/')) clean = clean.slice(6)
    const key = `block:${clean}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    let buf = this._read(`textures/block/${clean}.png`)
    if (!buf && this.bundledRoot) buf = this._read(`blocks/${clean}.png`)
    let meta = null
    if (buf) {
      const mc = this._read(`textures/block/${clean}.png.mcmeta`) ||
        (this.bundledRoot ? this._read(`blocks/${clean}.png.mcmeta`) : null)
      meta = decodeMcmeta(mc)
    }
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(clean, png, meta)
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /** Real `assets/minecraft/models/item/<item>.json` (resource packs first). */
  itemModel (itemName) {
    let clean = namespacePath(itemName)
    clean = clean.replace(/^item\//, '').replace(/^models\/item\//, '')
    if (clean.endsWith('.json')) clean = clean.slice(0, -5)
    if (this._itemModelCache.has(clean)) return this._itemModelCache.get(clean)
    let def = this._readJson(`models/item/${clean}.json`)
    if (def) def = { ...def, _source: 'resource' }
    this._itemModelCache.set(clean, def)
    return def
  }

  /**
   * Real item texture (`textures/item/...`, or a block texture for block
   * items). The prismarine extraction stores the same files under `items/`.
   * Returns a Texture with alpha, or null.
   */
  itemTexture (ref) {
    let clean = namespacePath(ref).replace(/^textures\//, '').replace(/\.png$/, '')
    if (clean.startsWith('block/')) return this.blockTexture(clean)
    const name = clean.replace(/^items?\//, '')
    const key = `item:${name}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    let buf = this._read(`textures/item/${name}.png`)
    if (!buf && this.bundledRoot) {
      buf = this._read(`items/${name}.png`) || this._read(`textures/items/${name}.png`)
    }
    let meta = null
    if (buf) {
      const mc = this._read(`textures/item/${name}.png.mcmeta`) ||
        (this.bundledRoot ? this._read(`items/${name}.png.mcmeta`) : null)
      meta = decodeMcmeta(mc)
    }
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(`item/${name}`, png, meta)
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /** Entity texture (`textures/entity/...` from the real client assets). */
  entityTexture (ref) {
    let clean = namespacePath(ref)
    clean = clean.replace(/^textures\//, '')
    if (clean.endsWith('.png')) clean = clean.slice(0, -4)
    const key = `entity:${clean}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    let buf = this._read(`textures/${clean}.png`)
    if (!buf && this.bundledRoot) buf = this._read(`${clean}.png`)
    if (!buf && this.bundledRoot) {
      // Some packs flatten `textures/entity/player/wide/steve` differently.
      buf = this._read(`entity/${clean.replace(/^entity\//, '')}.png`)
    }
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(clean, png, null)
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /** Vanilla colormaps (grass.png / foliage.png) used for biome tinting. */
  colormap (name) {
    if (this._colormaps.has(name)) return this._colormaps.get(name)
    let buf = this._read(`textures/colormap/${name}.png`)
    if (!buf && this.bundledRoot) buf = this._read(`colormap/${name}.png`)
    const png = buf ? decodePng(buf) : null
    const tex = png ? new Texture(name, png, null) : null
    this._colormaps.set(name, tex)
    return tex
  }

  get missingTexture () {
    if (!this._missing) this._missing = new Texture('missingno', MISSING_TEXTURE, null)
    return this._missing
  }

  /**
   * Pack all loaded block textures into one padded atlas. The renderer samples
   * per-texture tiles (equivalent to a client atlas with clamped UVs), and
   * this atlas is available for diagnostics/regression checks.
   */
  buildAtlas () {
    if (this._atlas) return this._atlas
    const textures = []
    for (const [key, tex] of this._textures) {
      if (key.startsWith('block:')) textures.push(tex)
    }
    textures.sort((a, b) => a.name.localeCompare(b.name))
    const padding = 2
    let total = 0
    for (const t of textures) total += (t.width + padding * 2) * (t.width + padding * 2)
    const side = Math.max(16, Math.ceil(Math.sqrt(total * 1.15)))
    // Simple shelf packer; grow if it does not fit.
    let atlasW = side
    let atlasH = side
    let x = padding
    let y = padding
    let rowH = 0
    const placement = new Map()
    for (const t of textures) {
      const w = t.width + padding * 2
      const h = (t.animated ? t.width : t.height) + padding * 2
      if (x + w > atlasW) {
        x = padding
        y += rowH
        rowH = 0
      }
      placement.set(t.name, { x: x + padding, y: y + padding, w: t.width, h: t.animated ? t.width : t.height })
      x += w
      rowH = Math.max(rowH, h)
    }
    atlasH = Math.max(atlasH, y + rowH + padding)
    const rgba = new Uint8Array(atlasW * atlasH * 4)
    for (const t of textures) {
      const tile = placement.get(t.name)
      const h = t.animated ? t.width : t.height
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < t.width; tx++) {
          const si = (ty * t.width + tx) * 4
          const di = ((tile.y + ty) * atlasW + tile.x + tx) * 4
          rgba[di] = t.rgba[si]
          rgba[di + 1] = t.rgba[si + 1]
          rgba[di + 2] = t.rgba[si + 2]
          rgba[di + 3] = t.rgba[si + 3]
        }
      }
    }
    this._atlas = { width: atlasW, height: atlasH, rgba, placement, textures: textures.length }
    return this._atlas
  }
}

// ── Discovery ───────────────────────────────────────────────────────────────

function prismarineAssetsRoot () {
  try {
    const pkg = require.resolve('prismarine-viewer/package.json')
    return path.join(path.dirname(pkg), 'public', 'textures')
  } catch {
    return null
  }
}

function minecraftAssetsPackageRoot () {
  try {
    const pkg = require.resolve('minecraft-assets/package.json')
    return path.join(path.dirname(pkg), 'data')
  } catch {
    return null
  }
}

function discoverOfficialRoots (version) {
  const homes = [
    process.env.MINECRAFT_HOME,
    process.env.APPDATA ? path.join(process.env.APPDATA, '.minecraft') : null,
    path.join(require('node:os').homedir(), '.minecraft')
  ].filter(Boolean)
  const jars = []
  const indexes = []
  for (const home of homes) {
    jars.push(path.join(home, 'versions', version, `${version}.jar`))
    // A few launchers keep the client under a version id prefix.
    for (const dir of listDirs(path.join(home, 'versions'))) {
      if (dir === version || dir.startsWith(`${version}-`)) {
        jars.push(path.join(home, 'versions', dir, `${dir}.jar`))
      }
    }
    const indexDir = path.join(home, 'assets', 'indexes')
    for (const file of (() => { try { return fs.readdirSync(indexDir) } catch { return [] } })()) {
      if (file === `${version}.json` || file.startsWith(`${version}.json`)) {
        indexes.push({ assets: path.join(home, 'assets'), index: path.join(indexDir, file) })
      }
    }
  }
  if (process.env.ZINC_MC_JAR) jars.unshift(process.env.ZINC_MC_JAR)
  if (process.env.ZINC_MC_ASSETS) {
    const assets = process.env.ZINC_MC_ASSETS
    for (const file of (() => { try { return fs.readdirSync(path.join(assets, 'indexes')) } catch { return [] } })()) {
      if (file === `${version}.json` || file.startsWith(`${version}.json`)) {
        indexes.push({ assets, index: path.join(assets, 'indexes', file) })
      }
    }
  }
  return { jars: jars.filter((j) => { try { return fs.existsSync(j) } catch { return false } }), indexes }
}

function discoverResourcePackRoots () {
  const roots = []
  const add = (p) => { if (p) roots.push(p) }
  for (const p of String(process.env.ZINC_RESOURCE_PACKS || '').split(path.delimiter)) {
    if (p.trim()) add(p.trim())
  }
  const home = process.env.MINECRAFT_HOME || (process.env.APPDATA ? path.join(process.env.APPDATA, '.minecraft') : path.join(require('node:os').homedir(), '.minecraft'))
  const rpDir = path.join(home, 'resourcepackater')
  const legacy = path.join(home, 'resourcepacks')
  for (const dir of [rpDir, legacy]) {
    for (const name of listDirs(dir)) {
      // Enabled packs are unknown without options.txt; load all as overlays is
      // wrong, so only explicit packs are honoured. This list is informational.
      add(null)
    }
    add(dir) // kept for diagnostics only
  }
  return roots.filter((r, i, a) => a.indexOf(r) === i)
}

function chooseBundledVersion (baseDir, version) {
  const versions = listDirs(baseDir)
  if (!versions.length) return null
  if (versions.includes(version)) return { version, dir: path.join(baseDir, version) }
  const sorted = versions.slice().sort(compareVersions)
  let bestLower = null
  let bestHigher = null
  for (const v of sorted) {
    const cmp = compareVersions(v, version)
    if (cmp <= 0) bestLower = v
    if (cmp >= 0 && !bestHigher) bestHigher = v
  }
  const chosen = bestLower || bestHigher
  return chosen ? { version: chosen, dir: path.join(baseDir, chosen) } : null
}

/**
 * Build the asset provider for a live session.
 *
 * @param {object} opts
 * @param {string} opts.version        Minecraft version (bot.version)
 * @param {string[]} [opts.resourcePacks] extra pack directories
 * @param {string} [opts.assetsDir]     explicit extracted/bundled asset root
 */
function createAssetProvider (opts = {}) {
  const requested = String(opts.version || '').trim()
  const bundledBase = opts.bundledBase || prismarineAssetsRoot()
  const sources = []
  const packs = []

  // Explicit extracted directory wins (useful for tests and local packs).
  const explicit = opts.assetsDir || process.env.ZINC_ASSETS_DIR
  if (explicit) {
    const dirPack = new DirectoryPack(explicit, `assets-dir:${path.basename(explicit)}`, false)
    // Detect the prismarine flat layout.
    dirPack.opaque = fs.existsSync(path.join(explicit, 'blocks_states.json')) ||
      fs.existsSync(path.join(explicit, 'blocks'))
    packs.push(dirPack)
    sources.push(dirPack.name)
  }

  let resolvedVersion = requested
  let bundledDir = null
  let bundledResolved = null
  if (bundledBase) {
    bundledResolved = chooseBundledVersion(bundledBase, requested || '1.21.4')
    if (bundledResolved) {
      bundledDir = bundledResolved.dir
      if (!resolvedVersion) resolvedVersion = bundledResolved.version
      packs.push(new DirectoryPack(bundledDir, `client-resources:${bundledResolved.version}`, true))
      sources.push(`prismarine-viewer extracted client resources ${bundledResolved.version}`)
    }
  }

  // Optional minecraft-assets npm package layout.
  const maRoot = minecraftAssetsPackageRoot()
  if (maRoot) {
    const resolved = chooseBundledVersion(maRoot, resolvedVersion || '1.21.4')
    if (resolved) {
      packs.push(new DirectoryPack(resolved.dir, `minecraft-assets:${resolved.version}`, true))
      sources.push(`minecraft-assets ${resolved.version}`)
    }
  }

  // Official client jar / asset index for the exact live version.
  const official = discoverOfficialRoots(resolvedVersion || requested)
  for (const jar of official.jars) {
    packs.push(new JarPack(jar))
    sources.push(`official client jar ${path.basename(jar)}`)
  }
  for (const { assets, index } of official.indexes) {
    packs.push(new ObjectStorePack(assets, index))
    sources.push(`official asset index ${path.basename(index)}`)
  }

  // Explicit resource packs (applied last: overlay order like the client).
  const extraPacks = (opts.resourcePacks || []).concat(
    String(process.env.ZINC_RESOURCE_PACKS || '').split(path.delimiter).filter(Boolean)
  )
  for (const rp of extraPacks) {
    try {
      if (!fs.existsSync(rp)) continue
      if (fs.statSync(rp).isDirectory()) {
        packs.push(new DirectoryPack(rp, `resource-pack:${path.basename(rp)}`, false))
        sources.push(`resource pack ${path.basename(rp)}`)
      } else if (rp.endsWith('.zip') || rp.endsWith('.jar')) {
        packs.push(new JarPack(rp))
        sources.push(`resource pack ${path.basename(rp)}`)
      }
    } catch { /* ignore unreadable pack */ }
  }

  const version = resolvedVersion || '1.21.4'
  const info = {
    version,
    requestedVersion: requested || null,
    versionExact: !requested || version === requested,
    sources,
    bundledDir,
    label: `Minecraft ${version} client resources`
  }
  if (bundledResolved && requested && bundledResolved.version !== requested) {
    info.versionNote = `requested ${requested}; nearest extracted client resources are ${bundledResolved.version}`
  }

  const provider = new AssetProvider({ version, roots: sources, packs, bundledRoot: bundledDir, info })
  return provider
}

module.exports = {
  AssetProvider,
  Texture,
  createAssetProvider,
  compareVersions,
  namespacePath,
  ZipArchive,
  DirectoryPack,
  JarPack,
  discoverOfficialRoots
}
