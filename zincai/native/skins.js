/**
 * zincai/native/skins.js — player skins exactly as the client receives them.
 *
 * The client does not ask Mojang for a skin after login: it renders the
 * `textures` property in the player-info packet. SkinRestorer works by
 * replacing that property server-side, so the effective URL in the packet is
 * the replacement skin. Mineflayer exposes precisely that parsed property as
 * `player.skinData` ({ url, model, capeUrl }) — it never re-resolves the
 * Mojang profile. We therefore read `skinData` (with fallbacks for other
 * mineflayer versions) and fetch *that* URL, cache it by its hash, and reuse
 * the cache until the URL/model changes. New players are picked up on the next
 * frame; a SkinRestorer change produces a new URL and a new cache entry, with
 * no renderer restart.
 *
 * Offline/dev fallbacks (in order): an explicit local override keyed by UUID or
 * username, a previously downloaded cache file, then the vanilla default skin
 * shipped in the client resources (wide/steve or slim/alex). We never call the
 * Mojang profile API.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { decodePng } = require('./png')
const { Texture } = require('./assets')

function safeName (s) {
  return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function parseTextureProperty (value) {
  if (!value) return null
  try {
    let json
    try {
      json = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'))
    } catch {
      // Some servers send a plain JSON object instead of base64.
      json = JSON.parse(String(value))
    }
    const skin = json?.textures?.SKIN
    if (!skin?.url) return null
    return {
      url: skin.url,
      model: skin.metadata?.model === 'slim' ? 'slim' : 'wide',
      capeUrl: json?.textures?.CAPE?.url || null
    }
  } catch {
    return null
  }
}

/**
 * Convert a legacy 64x32 skin (pre-1.8 layout, no left arm/leg) to the modern
 * 64x64 layout by mirroring the right limbs, exactly like the client's
 * LegacySkinAdapter. Server plugins still hand out these files.
 */
function upgradeLegacySkin (png) {
  if (!png || png.width !== 64 || png.height !== 32) return png
  const rgba = new Uint8Array(64 * 64 * 4)
  rgba.set(png.rgba, 0)
  const mirror = (sx, sy, w, h, dx, dy) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (((sy + y) * 64) + (sx + (w - 1 - x))) * 4
        const di = (((dy + y) * 64) + (dx + x)) * 4
        rgba[di] = rgba[si]; rgba[di + 1] = rgba[si + 1]
        rgba[di + 2] = rgba[si + 2]; rgba[di + 3] = rgba[si + 3]
      }
    }
  }
  mirror(0, 16, 16, 16, 16, 48)  // right leg → left leg
  mirror(40, 16, 16, 16, 32, 48) // right arm → left arm
  return { width: 64, height: 64, rgba }
}

function propertiesOf (player) {
  return player?.properties ||
    player?.profile?.properties ||
    player?.player?.properties ||
    player?._client?.profile?.properties ||
    null
}

/** Read the effective (SkinRestorer-aware) skin descriptor for a player. */
function readSkinProfile (bot, username) {
  const player = bot.players?.[username]
  if (!player) return null

  // Mineflayer's parsed player-info textures (this is what the client uses).
  if (player.skinData?.url) {
    return {
      url: player.skinData.url,
      model: player.skinData.model === 'slim' ? 'slim' : 'wide',
      capeUrl: player.skinData.capeUrl || null,
      source: 'player_info.textures'
    }
  }

  // Fallback for mineflayer builds / skins that only expose raw properties.
  const props = propertiesOf(player)
  const textures = Array.isArray(props) ? props.find((p) => p?.name === 'textures') : null
  const parsed = parseTextureProperty(textures?.value)
  if (parsed) return { ...parsed, source: 'profile.properties.textures' }

  return null
}

class SkinResolver {
  constructor ({ bot, assets, cacheDir = null, opts = {} } = {}) {
    this.bot = bot
    this.assets = assets
    this.opts = opts
    this.cacheDir = cacheDir || opts.skinCacheDir || process.env.ZINC_SKIN_DIR ||
      path.join(process.env.ZINC_DATA_DIR || 'data', 'skins')
    this.entries = new Map() // username -> { texture, model, source, revision, url }
    this.textureCache = new Map() // hash -> Texture
    this.downloads = new Map() // hash -> Promise<Buffer|null>
    this.stats = { fromNetwork: 0, fromCache: 0, defaults: 0, overrides: 0, failures: 0 }
    this._defaults = new Map()
    this._lastReport = []
  }

  _cacheFile (hash) {
    return path.join(this.cacheDir, `${hash}.png`)
  }

  _ensureCacheDir () {
    try { fs.mkdirSync(this.cacheDir, { recursive: true }) } catch { /* read-only is fine */ }
  }

  _localOverride (username, uuid) {
    const dirs = [this.cacheDir, process.env.ZINC_SKIN_OVERRIDES].filter(Boolean)
    const names = []
    if (uuid) names.push(`${safeName(uuid)}.png`)
    if (username) names.push(`${safeName(username)}.png`)
    for (const dir of dirs) {
      for (const name of names) {
        const file = path.join(dir, name)
        try {
          if (fs.existsSync(file)) return fs.readFileSync(file)
        } catch { /* ignore */ }
      }
    }
    return null
  }

  async _download (url) {
    if (!url) return null
    if (url.startsWith('file://')) {
      try { return fs.readFileSync(new URL(url)) } catch { return null }
    }
    if (!/^https?:\/\//i.test(url)) {
      try {
        if (fs.existsSync(url)) return fs.readFileSync(url)
      } catch { /* ignore */ }
      return null
    }
    if (typeof fetch !== 'function') return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(this.opts.skinTimeoutMs) || 7000)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ZincAI/2 (Minecraft harness skin cache)' }
      })
      if (!res.ok) return null
      const length = Number(res.headers.get('content-length') || 0)
      if (length > 4 * 1024 * 1024) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 8 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) return null
      return buf
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  _makeTexture (hash, buf, label) {
    if (this.textureCache.has(hash)) return this.textureCache.get(hash)
    const decoded = decodePng(buf)
    if (!decoded) return null
    const png = upgradeLegacySkin(decoded)
    if (png.width !== 64 || png.height !== 64) return null
    const tex = new Texture(label || `skin:${hash.slice(0, 8)}`, { width: png.width, height: png.height, rgba: png.rgba }, null)
    this.textureCache.set(hash, tex)
    return tex
  }

  _defaultSkin (model) {
    const key = model === 'slim' ? 'slim' : 'wide'
    if (this._defaults.has(key)) return this._defaults.get(key)
    const ref = key === 'slim' ? 'entity/player/slim/alex' : 'entity/player/wide/steve'
    const tex = this.assets.entityTexture(ref) || this.assets.missingTexture
    this._defaults.set(key, tex)
    return tex
  }

  /** Resolve/download every player's current skin. Safe to call per frame. */
  async prepare () {
    this._ensureCacheDir()
    const players = Object.values(this.bot.players || {})
    const jobs = []
    const seen = new Set()
    for (const player of players) {
      const username = player?.username
      if (!username) continue
      const profile = readSkinProfile(this.bot, username)
      const uuid = player.uuid
      if (!profile?.url) {
        // No texture property yet (offline server / plugin delay) but the
        // player-info model metadata still tells us classic vs slim.
        const model = player.skinData?.model === 'slim' ? 'slim' : 'wide'
        this.entries.set(username, {
          texture: this._defaultSkin(model),
          model,
          source: 'vanilla-default',
          profileSource: 'vanilla-default',
          revision: `default:${model}`,
          url: null,
          username
        })
        this.stats.defaults++
        continue
      }
      const revision = crypto.createHash('sha1').update(`${profile.url}|${profile.model}`).digest('hex')
      const cached = this.textureCache.get(revision)
      if (cached) {
        this.entries.set(username, { ...profile, texture: cached, revision, username, uuid })
        continue
      }
      if (seen.has(revision)) {
        // Another player already queued this exact skin.
        jobs.push((async () => {
          const tex = await this.downloads.get(revision)
          this.entries.set(username, { ...profile, texture: tex || this._defaultSkin(profile.model), revision, username, uuid })
        })())
        continue
      }
      seen.add(revision)
      const p = this._resolveSkin(profile, revision, uuid, username)
      this.downloads.set(revision, p.then((r) => r.texture))
      jobs.push(p.then((r) => this.entries.set(username, { ...profile, ...r, profileSource: profile.source, revision, username, uuid })))
    }
    await Promise.all(jobs)
    this._lastReport = [...this.entries.values()].map((e) => ({
      username: e.username,
      model: e.model,
      source: e.source,
      profileSource: e.profileSource || 'vanilla-default',
      revision: e.revision
    }))
    return this.entries
  }

  async _resolveSkin (profile, revision, uuid, username) {
    const file = this._cacheFile(revision)
    // 1. Explicit local override (also lets an admin pin a SkinRestorer skin).
    const override = this._localOverride(username, uuid)
    if (override) {
      const tex = this._makeTexture(revision, override, `skin:${username}`)
      if (tex) {
        this.stats.overrides++
        return { texture: tex, source: 'local-override' }
      }
    }
    // 2. Disk cache from a previous fetch.
    try {
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file)
        const tex = this._makeTexture(revision, buf, `skin:${username}`)
        if (tex) {
          this.stats.fromCache++
          return { texture: tex, source: 'cache' }
        }
      }
    } catch { /* fall through */ }
    // 3. Fetch exactly the URL the server sent (SkinRestorer replacement).
    const buf = await this._download(profile.url)
    if (buf) {
      try { fs.writeFileSync(file, buf) } catch { /* non-fatal */ }
      const tex = this._makeTexture(revision, buf, `skin:${username}`)
      if (tex) {
        this.stats.fromNetwork++
        return { texture: tex, source: 'network' }
      }
    }
    this.stats.failures++
    return { texture: this._defaultSkin(profile.model), source: 'vanilla-default' }
  }

  get (username) {
    return this.entries.get(username) || null
  }

  report () {
    return this._lastReport.slice()
  }
}

module.exports = {
  SkinResolver,
  upgradeLegacySkin,
  readSkinProfile,
  parseTextureProperty
}
