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

/** `1.21.4` → `1.21` (model/definition formats are stable within a minor line). */
function versionLine (v) {
  if (!v) return ''
  return String(v).replace(/^v/i, '').split('.').slice(0, 2).join('.')
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

/**
 * Directory laid out like the client resource tree
 * (`assets/<namespace>/<path>`, e.g. `assets/minecraft/blockstates/oak_sign.json`
 * or `assets/mymod/models/block/reactor.json`).
 */
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

  readNamespace (namespace, rel) {
    const ns = namespace || 'minecraft'
    if (!this.opaque) {
      const direct = this._try(path.join('assets', ns, rel))
      if (direct) return direct
      // Bundled/flat layouts (prismarine-viewer extraction) only carry vanilla.
      if (ns === 'minecraft') {
        const bare = this._try(rel)
        if (bare) return bare
        return this._try(path.join('assets', 'minecraft', rel))
      }
      return null
    }
    if (ns !== 'minecraft') return null
    return this._try(rel)
  }

  readResource (rel) { return this.readNamespace('minecraft', rel) }
  readBundled (rel) { return this._try(rel) }
  read (rel) { return this.readResource(rel) || this.readBundled(rel) }

  namespaces () {
    const out = listDirs(path.join(this.root, 'assets'))
    if (!this.opaque && !out.includes('minecraft')) {
      // A loose pack dir (assets/minecraft/... is created lazily) still serves
      // vanilla names by convention.
      out.push('minecraft')
    }
    return out
  }
}

/** Official client jar (or a packed resource pack) as a resource pack. */
class JarPack {
  constructor (file) {
    this.name = `client-jar:${path.basename(file)}`
    this.zip = new ZipArchive(file)
  }

  readNamespace (namespace, rel) {
    return this.zip.read(path.posix.join('assets', namespace || 'minecraft', rel))
  }

  readResource (rel) { return this.readNamespace('minecraft', rel) }
  readBundled (rel) { return this.readNamespace('minecraft', rel) }
  read (rel) { return this.readResource(rel) }

  namespaces () {
    if (this._namespaces) return this._namespaces
    const out = new Set()
    if (this.zip.load()) {
      for (const name of this.zip.entries.keys()) {
        const m = /^assets\/([^/]+)\//.exec(name)
        if (m) out.add(m[1])
      }
    }
    this._namespaces = [...out]
    return this._namespaces
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

  readNamespace (namespace, rel) {
    const key = `${namespace || 'minecraft'}/${rel}`
    const obj = this.index[key]
    if (!obj || !obj.hash) return null
    try {
      const p = path.join(this.root, 'objects', obj.hash.slice(0, 2), obj.hash)
      return fs.readFileSync(p)
    } catch { return null }
  }

  read (rel) { return this.readNamespace('minecraft', rel) }
  readResource (rel) { return this.read(rel) }

  namespaces () {
    if (this._namespaces) return this._namespaces
    const out = new Set()
    for (const key of Object.keys(this.index || {})) {
      const slash = key.indexOf('/')
      if (slash > 0) out.add(key.slice(0, slash))
    }
    this._namespaces = [...out]
    return this._namespaces
  }
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
  constructor (name, png, mcmeta, opts = {}) {
    this.name = name
    this.namespace = opts.namespace || 'minecraft'
    this.logicalPath = opts.logicalPath || name
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

/**
 * Split a resource identifier into `{ namespace, path }`.
 * `minecraft:block/stone`, `block/stone` and `stone` are the same vanilla
 * resource; `mymod:block/reactor` keeps its namespace so mod assets never
 * collide with vanilla names.
 */
function splitRef (ref) {
  let s = String(ref == null ? '' : ref)
  let namespace = 'minecraft'
  const colon = s.indexOf(':')
  if (colon >= 0) {
    namespace = s.slice(0, colon).trim() || 'minecraft'
    s = s.slice(colon + 1)
  }
  s = s.replace(/^minecraft\//, '')
  return { namespace: namespace.toLowerCase(), path: s }
}

/**
 * Cache/display key for a resource reference. Vanilla paths stay bare
 * (`block/stone`) so existing caches/statistics keep working; other
 * namespaces are prefixed (`mymod:block/stone`).
 */
function namespacePath (ref) {
  const { namespace, path: p } = splitRef(ref)
  return namespace === 'minecraft' ? p : `${namespace}:${p}`
}

/** `textures/block/x.png` → `{ namespace, path: 'block/x' }` (extension dropped). */
function textureRef (ref) {
  const split = splitRef(ref)
  let p = split.path.replace(/^textures\//, '')
  if (p.endsWith('.png')) p = p.slice(0, -4)
  if (p.endsWith('.png.mcmeta')) p = p.slice(0, -10)
  return { namespace: split.namespace, path: p }
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
    this._itemDefinitions = new Map()
    this._equipmentDefinitions = new Map()
    this._modelJsonCache = new Map()
    this._namespaces = null
    this.stats = { texturesLoaded: 0, textureMisses: 0, packMisses: 0 }
  }

  get label () {
    return this.info.label || `minecraft ${this.version}`
  }

  /** Read a resource from the pack stack (later packs win, like the client). */
  _readNamespace (namespace, rel) {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      try {
        const pack = this.packs[i]
        const buf = typeof pack.readNamespace === 'function'
          ? pack.readNamespace(namespace, rel)
          : (namespace === 'minecraft' ? pack.read(rel) : null)
        if (buf && buf.length) return buf
      } catch { /* pack failure is a miss, try the next pack */ }
    }
    return null
  }

  _read (rel) {
    return this._readNamespace('minecraft', rel)
  }

  _readJsonNamespace (namespace, rel) {
    const buf = this._readNamespace(namespace, rel)
    if (!buf) return null
    try { return JSON.parse(buf.toString('utf8')) } catch { return null }
  }

  _readJson (rel) {
    return this._readJsonNamespace('minecraft', rel)
  }

  /**
   * Namespaces that actually contain assets in the active pack stack
   * (`minecraft` plus any mod/resource-pack namespaces).
   */
  namespaces () {
    if (this._namespaces) return this._namespaces
    const out = new Set(['minecraft'])
    for (const pack of this.packs) {
      if (typeof pack.namespaces !== 'function') continue
      try {
        for (const ns of pack.namespaces()) out.add(ns)
      } catch { /* a broken pack must not break resolution */ }
    }
    this._namespaces = [...out].sort()
    return this._namespaces
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

  /**
   * Real `assets/<namespace>/blockstates/<block>.json` with the bundled
   * vanilla extraction as a fallback.
   */
  blockstate (blockName) {
    const { namespace, path: name } = splitRef(blockName)
    const key = namespace === 'minecraft' ? name : `${namespace}:${name}`
    if (this._blockstateFileCache.has(key)) return this._blockstateFileCache.get(key)
    let def = this._readJsonNamespace(namespace, `blockstates/${name}.json`)
    if (!def && namespace === 'minecraft') {
      const all = this.blockstatesAll()
      def = all[name] || all[`minecraft:${name}`] || null
    }
    if (!def) this.stats.packMisses++
    this._blockstateFileCache.set(key, def)
    return def
  }

  /**
   * Real model JSON by resource reference (`minecraft:block/cherry_leaves`,
   * `block/cube_all`, `mymod:block/reactor`, ...). Official per-file lookup
   * first, bundled vanilla extraction second.
   */
  model (ref) {
    const { namespace, path: original } = splitRef(ref)
    let clean = original
    let bare = clean
    if (bare.startsWith('block/')) bare = bare.slice(6)
    const key = namespace === 'minecraft' ? bare : `${namespace}:${clean}`
    if (this._modelFileCache.has(key)) return this._modelFileCache.get(key)
    let def = null
    if (bare !== clean) def = this._readJsonNamespace(namespace, `models/block/${bare}.json`)
    if (!def) def = this._readJsonNamespace(namespace, `models/${clean}.json`)
    if (!def) def = this._readJsonNamespace(namespace, `models/block/${bare}.json`)
    if (!def && namespace === 'minecraft') {
      const all = this.modelsAll()
      def = all[bare] || all[clean] || all[`block/${bare}`] || all[`minecraft:block/${bare}`] || null
    }
    if (!def) this.stats.packMisses++
    this._modelFileCache.set(key, def)
    return def
  }

  /** Any model JSON: `item/template_banner`, `block/oak_sign`, `entity/x`. */
  modelJson (ref) {
    const { namespace, path: clean } = splitRef(ref)
    const key = namespace === 'minecraft' ? clean : `${namespace}:${clean}`
    if (this._modelJsonCache.has(key)) return this._modelJsonCache.get(key)
    let def = this._readJsonNamespace(namespace, `models/${clean}.json`)
    if (!def) def = this.model(ref)
    this._modelJsonCache.set(key, def)
    return def
  }

  /**
   * 1.21.4+ item model definition (`assets/<ns>/items/<id>.json`): the file
   * that says which model/tints/special renderer an item uses. Resource pack
   * and jar files win; the vendored 1.21.4 set is a fallback for the matching
   * version line only, so an older/newer runtime never silently gets 1.21.4
   * semantics.
   */
  itemDefinition (itemName) {
    const { namespace, path: raw } = splitRef(itemName)
    const name = raw.replace(/^item\//, '').replace(/\.json$/, '')
    const key = namespace === 'minecraft' ? name : `${namespace}:${name}`
    if (this._itemDefinitions.has(key)) return this._itemDefinitions.get(key)
    let def = this._readJsonNamespace(namespace, `items/${name}.json`)
    let source = 'resource'
    if (!def && namespace === 'minecraft' && this.itemDefinitionBundle()) {
      const bundle = this.itemDefinitionBundle()
      def = bundle.definitions[name] || null
      source = def ? `bundled:${bundle._meta.version}` : source
    }
    if (def) def = { ...def, _source: source }
    this._itemDefinitions.set(key, def)
    return def
  }

  itemDefinitionBundle () {
    if (this._itemDefBundle !== undefined) return this._itemDefBundle
    this._itemDefBundle = null
    try {
      const bundle = require('./item-definitions-1.21.4.json')
      if (versionLine(bundle._meta?.version) === versionLine(this.version)) this._itemDefBundle = bundle
    } catch { /* no vendored definitions */ }
    return this._itemDefBundle
  }

  /**
   * Equipment (armour) layer definition: `assets/<ns>/equipment/<id>.json`,
   * e.g. `minecraft:iron` → humanoid + humanoid_leggings texture layers.
   */
  equipmentDefinition (id) {
    const { namespace, path: name } = splitRef(id)
    const key = namespace === 'minecraft' ? name : `${namespace}:${name}`
    if (this._equipmentDefinitions.has(key)) return this._equipmentDefinitions.get(key)
    let def = this._readJsonNamespace(namespace, `equipment/${name}.json`)
    let source = 'resource'
    if (!def && namespace === 'minecraft') {
      try {
        const bundle = require('./equipment-1.21.4.json')
        if (versionLine(bundle._meta?.version) === versionLine(this.version)) {
          def = bundle.equipment[name] || null
          if (def) source = `bundled:${bundle._meta.version}`
        }
      } catch { /* none */ }
    }
    if (def) def = { ...def, _source: source }
    this._equipmentDefinitions.set(key, def)
    return def
  }

  /**
   * Load a block texture by its resource reference. Returns a Texture
   * carrying the real pixels and alpha channel, or the client's
   * missing-texture checkerboard.
   */
  blockTexture (ref) {
    const { namespace, path: raw } = textureRef(ref)
    let clean = raw
    if (clean.startsWith('block/')) clean = clean.slice(6)
    const vanilla = namespace === 'minecraft'
    const key = vanilla ? `block:${clean}` : `block:${namespace}:${clean}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    // Explicit directories (`entity/...`, `models/...`) are honoured as-is.
    const rels = clean.includes('/')
      ? [`textures/${clean}.png`]
      : [`textures/block/${clean}.png`]
    let buf = null
    let usedRel = rels[0]
    for (const rel of rels) {
      buf = this._readNamespace(namespace, rel)
      if (buf) { usedRel = rel; break }
    }
    if (!buf && vanilla && this.bundledRoot) {
      buf = this._read(`blocks/${clean}.png`)
      usedRel = `blocks/${clean}.png`
    }
    let meta = null
    if (buf) {
      const mc = this._readNamespace(namespace, `${usedRel}.mcmeta`) ||
        (vanilla && this.bundledRoot ? this._read(`blocks/${clean}.png.mcmeta`) : null)
      meta = decodeMcmeta(mc)
    }
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(key.replace(/^block:/, ''), png, meta, {
      namespace,
      logicalPath: rels[0].replace(/^textures\//, '').replace(/\.png$/, '')
    })
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
    const { namespace, path: raw } = textureRef(ref)
    // Armour trim item layers: `trims/items/chestplate_trim_diamond` is a
    // palette permutation of the shared `.../chestplate_trim` sheet.
    const trim = /^trims\/items\/(.+)_trim_([a-z_]+)$/.exec(raw)
    if (trim) {
      const paletted = this.palettedTexture(`trims/items/${trim[1]}_trim`, trim[2], { label: `item/${raw}` })
      if (paletted) return paletted
    }
    if (raw.startsWith('block/')) return this.blockTexture(ref)
    if (raw.includes('/') && !raw.startsWith('item/') && !raw.startsWith('items/')) {
      // e.g. `minecraft:entity/decorated_pot/...` used by an item tint
      return this.blockTexture(ref) || this.entityTexture(ref)
    }
    const name = raw.replace(/^items?\//, '')
    const vanilla = namespace === 'minecraft'
    const key = vanilla ? `item:${name}` : `item:${namespace}:${name}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    const rels = [`textures/item/${name}.png`]
    let buf = null
    let usedRel = rels[0]
    for (const rel of rels) {
      buf = this._readNamespace(namespace, rel)
      if (buf) { usedRel = rel; break }
    }
    if (!buf) {
      // Armour trim item layers are palette permutations of a shared greyscale
      // sheet: `trims/items/chestplate_trim_diamond` → source + palette.
      const trim = /^trims\/items\/(.+)_trim_([a-z_]+)$/.exec(name)
      if (trim) {
        const paletted = this.palettedTexture(`trims/items/${trim[1]}_trim`, trim[2], {
          label: `item/${name}`
        })
        if (paletted) return paletted
      }
    }
    if (!buf && vanilla && this.bundledRoot) {
      buf = this._read(`items/${name}.png`) || this._read(`textures/items/${name}.png`)
      usedRel = `items/${name}.png`
    }
    let meta = null
    if (buf) {
      const mc = this._readNamespace(namespace, `${usedRel}.mcmeta`) ||
        (vanilla && this.bundledRoot ? this._read(`items/${name}.png.mcmeta`) : null)
      meta = decodeMcmeta(mc)
    }
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(`item/${name}`, png, meta, {
      namespace,
      logicalPath: `item/${name}`
    })
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /** Entity texture (`textures/entity/...` from the real client assets). */
  entityTexture (ref) {
    const { namespace, path: raw } = textureRef(ref)
    let clean = raw.replace(/^textures\//, '')
    if (clean.endsWith('.png')) clean = clean.slice(0, -4)
    const vanilla = namespace === 'minecraft'
    const key = vanilla ? `entity:${clean}` : `entity:${namespace}:${clean}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    let buf = this._readNamespace(namespace, `textures/${clean}.png`)
    let usedRel = `textures/${clean}.png`
    if (!buf && vanilla && this.bundledRoot) {
      buf = this._read(`${clean}.png`)
      usedRel = `${clean}.png`
    }
    if (!buf && vanilla && this.bundledRoot) {
      // Some packs flatten `textures/entity/player/wide/steve` differently.
      buf = this._read(`entity/${clean.replace(/^entity\//, '')}.png`)
      usedRel = `entity/${clean.replace(/^entity\//, '')}.png`
    }
    let meta = null
    if (buf) {
      const mc = this._readNamespace(namespace, `${usedRel}.mcmeta`) ||
        (vanilla && this.bundledRoot ? this._read(`${clean}.png.mcmeta`) : null)
      meta = decodeMcmeta(mc)
    }
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(clean, png, meta, { namespace, logicalPath: clean })
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /** Any other client texture (`gui/...`, `misc/enchanted_glint_item`, ...). */
  miscTexture (ref) {
    const { namespace, path: raw } = textureRef(ref)
    const clean = raw.replace(/^textures\//, '')
    const vanilla = namespace === 'minecraft'
    const key = vanilla ? `misc:${clean}` : `misc:${namespace}:${clean}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    const rel = `textures/${clean}.png`
    let buf = this._readNamespace(namespace, rel)
    if (!buf && vanilla && this.bundledRoot) buf = this._read(`${clean}.png`)
    const png = buf ? decodePng(buf) : null
    if (!png) {
      this._textureMisses.add(key)
      this.stats.textureMisses++
      return null
    }
    const tex = new Texture(clean, png, decodeMcmeta(this._readNamespace(namespace, `${rel}.mcmeta`)), {
      namespace,
      logicalPath: clean
    })
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /**
   * Palette permutations — the client's `paletted_permutations` sprite source.
   * Armour trim textures are shipped as one greyscale sheet
   * (`trims/items/chestplate_trim.png`, `trims/entity/humanoid/coast.png`) plus
   * a palette per material (`trims/color_palettes/diamond.png`). The client
   * builds `<source>_<palette>` at atlas bake time; this does the same, cached.
   */
  palettedTexture (sourceRef, paletteName, { keyRef = 'trims/color_palettes/trim_palette', label = null } = {}) {
    const { namespace, path: src } = textureRef(sourceRef)
    const palette = String(paletteName || '').replace(/^minecraft:/, '')
    const key = `paletted:${namespace}:${src}:${palette}`
    if (this._textures.has(key)) return this._textures.get(key)
    if (this._textureMisses.has(key)) return null
    const source = this.miscTexture(sourceRef)
    const keyImg = this.miscTexture(keyRef)
    const paletteImg = this.miscTexture(`trims/color_palettes/${palette}`)
    if (!source || !keyImg || !paletteImg) {
      this._textureMisses.add(key)
      return null
    }
    // palette_key pixel i ↔ palette pixel i
    const pairs = []
    const n = Math.min(keyImg.width * keyImg.height, paletteImg.width * paletteImg.height)
    for (let i = 0; i < n; i++) {
      const ki = i * 4
      const pi = i * 4
      pairs.push({
        from: [keyImg.rgba[ki], keyImg.rgba[ki + 1], keyImg.rgba[ki + 2]],
        to: [paletteImg.rgba[pi], paletteImg.rgba[pi + 1], paletteImg.rgba[pi + 2]]
      })
    }
    const rgba = new Uint8Array(source.rgba)
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) continue
      for (const pair of pairs) {
        if (rgba[i] === pair.from[0] && rgba[i + 1] === pair.from[1] && rgba[i + 2] === pair.from[2]) {
          rgba[i] = pair.to[0]
          rgba[i + 1] = pair.to[1]
          rgba[i + 2] = pair.to[2]
          break
        }
      }
    }
    const tex = new Texture(label || `${src}_${palette}`, {
      width: source.width,
      height: source.height,
      rgba
    }, null, { namespace, logicalPath: `${src}_${palette}` })
    this.stats.texturesLoaded++
    this._textures.set(key, tex)
    return tex
  }

  /**
   * Armour trim sheet for a material, e.g.
   * `trimTexture('humanoid', 'coast', 'minecraft:diamond')`.
   */
  trimTexture (layer, pattern, material) {
    const mat = String(material || '').replace(/^minecraft:/, '').replace(/^trims\//, '')
    if (!mat) return null
    const ref = `trims/entity/${layer}/${String(pattern || '').replace(/^minecraft:/, '')}`
    return this.palettedTexture(ref, mat, { label: `${ref}_${mat}` })
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

function minecraftHome () {
  return process.env.MINECRAFT_HOME ||
    (process.env.APPDATA ? path.join(process.env.APPDATA, '.minecraft') : null) ||
    path.join(require('node:os').homedir(), '.minecraft')
}

/**
 * The resource packs the client actually has enabled, read from
 * `.minecraft/options.txt` (`resourcePacks:["vanilla","file/MyPack.zip"]`).
 * Built-in entries that are not files (`vanilla`, `fabric`, `mod_resources`,
 * `programmer_art`) are skipped; `file/<name>` entries resolve against
 * `.minecraft/resourcepacks/`. Order is the client's, so later packs win.
 */
function enabledResourcePacks (home = minecraftHome()) {
  const out = []
  let text = ''
  try { text = fs.readFileSync(path.join(home, 'options.txt'), 'utf8') } catch { return out }
  const line = text.split(/\r?\n/).find((l) => l.startsWith('resourcePacks:'))
  if (!line) return out
  let list = null
  try { list = JSON.parse(line.slice('resourcePacks:'.length)) } catch { return out }
  if (!Array.isArray(list)) return out
  const builtin = new Set(['vanilla', 'fabric', 'mod_resources', 'programmer_art', 'high_contrast'])
  for (const entry of list) {
    if (typeof entry !== 'string' || builtin.has(entry)) continue
    const rel = entry.startsWith('file/') ? entry.slice(5) : entry
    const direct = path.join(home, 'resourcepacks', rel)
    if (fs.existsSync(direct)) out.push(direct)
  }
  return out
}

function discoverResourcePackRoots () {
  const roots = []
  for (const p of String(process.env.ZINC_RESOURCE_PACKS || '').split(path.delimiter)) {
    if (p.trim()) roots.push(p.trim())
  }
  for (const p of enabledResourcePacks()) roots.push(p)
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

  // Mod-provided assets (lower precedence than resource packs: mods add new
  // namespaces, packs are allowed to override them).
  const modAssets = (opts.modAssets || []).concat(
    String(process.env.ZINC_MOD_ASSETS || '').split(path.delimiter).filter(Boolean)
  )
  for (const dir of modAssets) {
    try {
      if (!dir || !fs.existsSync(dir)) continue
      if (fs.statSync(dir).isDirectory()) {
        packs.push(new DirectoryPack(dir, `mod-assets:${path.basename(dir)}`, false))
        sources.push(`mod assets ${path.basename(dir)}`)
      } else if (dir.endsWith('.zip') || dir.endsWith('.jar')) {
        packs.push(new JarPack(dir))
        sources.push(`mod assets ${path.basename(dir)}`)
      }
    } catch { /* ignore unreadable mod */ }
  }

  // Explicit resource packs (applied last: overlay order like the client).
  const extraPacks = (opts.resourcePacks || [])
    .concat(opts.useClientPacks === false ? [] : enabledResourcePacks())
    .concat(String(process.env.ZINC_RESOURCE_PACKS || '').split(path.delimiter).filter(Boolean))
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
  versionLine,
  splitRef,
  textureRef,
  enabledResourcePacks,
  discoverResourcePackRoots,
  minecraftHome,
  namespacePath,
  ZipArchive,
  DirectoryPack,
  JarPack,
  discoverOfficialRoots
}
