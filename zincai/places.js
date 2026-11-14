/**
 * places.js — the bot's memory of WHERE things are.
 *
 * Two kinds of knowledge, both persisted to zincai-data/places.json:
 *
 *   1. Named places the model (or a player, through the model) asked to keep:
 *      "home", "mina", "casa do Steve" → coordinates.
 *   2. An index of useful blocks seen while walking around: chests, barrels,
 *      shulker boxes, furnaces, beds, work stations and signs — each with its
 *      coordinates, the text of the sign next to it (people label chests),
 *      and the contents last seen when the bot looked inside.
 *
 * The prompt gets a compact summary grouped by floor and by room-sized
 * cluster ("y64 6m NE: chest1 'diamantes' [diamond x12], furnace1, bed1"),
 * and tools address things by the short ids shown there — never by raw
 * coordinates the model would have to invent.
 *
 * A STORAGE ROOM (more containers in one cluster than fit on a line) is shown
 * as a summary instead: how many, the nearest few with their ids, and every
 * label — because a label is an address (`where: "Diamantes"`). The full list
 * is one `find {what:"storage"}` away. It used to collapse into nine sign
 * texts and "+77 more", with no chest id in sight.
 *
 * Pure w.r.t. the network; `scan()` only reads the already-loaded world.
 */
'use strict'

const { findBlocksFast } = require('./block_search')
const fs = require('fs')
const path = require('path')
const { whereIs } = require('./threats')

const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/** Block name → kind. Order matters: first match wins. */
const KIND_RULES = [
  [/^(trapped_)?chest$/, 'chest'],
  [/^(waxed_)?((exposed|weathered|oxidized)_)?copper_chest$/, 'chest'], // 1.21.9+
  [/^barrel$/, 'barrel'],
  [/shulker_box$/, 'shulker'],
  [/^ender_chest$/, 'ender_chest'],
  [/^(furnace|blast_furnace|smoker)$/, 'furnace'],
  [/_bed$/, 'bed'],
  [/^crafting_table$/, 'crafting_table'],
  [/^enchanting_table$/, 'enchanting_table'],
  [/^brewing_stand$/, 'brewing_stand'],
  [/anvil$/, 'anvil'],
  [/^(grindstone|smithing_table|stonecutter|loom|cartography_table|fletching_table|lectern)$/, 'station'],
  [/_sign$/, 'sign']
]
const CONTAINER_KINDS = new Set(['chest', 'barrel', 'shulker', 'ender_chest'])
const STATION_KINDS = new Set(['station', 'crafting_table', 'enchanting_table', 'brewing_stand', 'anvil'])

const FACING = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const CLOCKWISE = { north: 'east', east: 'south', south: 'west', west: 'north' }
const COUNTER = { north: 'west', west: 'south', south: 'east', east: 'north' }

/** Block state of a block as a plain object ({} when the block cannot say). */
function propsOf (block) {
  try { return (typeof block?.getProperties === 'function' && block.getProperties()) || {} } catch { return {} }
}

/**
 * Where the other half of a chest is, from its block state:
 *   [dx, dz]  it is a double chest and the other half is there
 *   null      it is a single chest
 *   undefined the block exposes no state (partial mock): decide by adjacency
 */
function chestPartner (block) {
  const { type, facing } = propsOf(block)
  if (type === undefined) return undefined
  if (type !== 'left' && type !== 'right') return null
  const dir = type === 'left' ? CLOCKWISE[facing] : COUNTER[facing]
  return FACING[dir] || null
}

function kindOf (blockName) {
  const n = String(blockName || '')
  for (const [re, kind] of KIND_RULES) if (re.test(n)) return kind
  return null
}

/** The block a wall sign hangs on, or null for a standing sign. */
function signSupport (block, p) {
  if (!/wall_(hanging_)?sign$/.test(String(block?.name || ''))) return null
  const dir = FACING[propsOf(block).facing]
  return dir ? { x: p.x - dir[0], y: p.y, z: p.z - dir[1] } : null
}

/** Flatten whatever a sign block exposes into one short line. */
function signTextOf (block) {
  try {
    let raw = null
    if (typeof block.getSignText === 'function') raw = block.getSignText()
    else if (block.signText !== undefined) raw = block.signText
    if (raw === null || raw === undefined) return ''
    const parts = Array.isArray(raw) ? raw : [raw]
    return parts
      .map((p) => String(p ?? ''))
      .join('\n')
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' / ')
      .slice(0, 80)
  } catch { return '' }
}

class PlaceIndex {
  /**
   * @param {{ file?: string, now?: () => number, logger?: (level:string,msg:string)=>void }} [opts]
   */
  constructor ({ file = null, now = () => Date.now(), logger = () => {} } = {}) {
    this.file = file
    this.now = now
    this.log = logger
    /** name(folded) -> { name, x, y, z, dim, note, by, ts } */
    this.named = new Map()
    /** "dim:x,y,z" -> entry { id, kind, block, x, y, z, dim, label, text, contents, seenAt, lookedAt } */
    this.blocks = new Map()
    this.counters = {}
    this._ids = null // block ids to search for, built lazily per registry
    this._lastScan = { at: 0, x: Infinity, y: 0, z: 0, dim: '' }
    this._dirty = false
    this._load()
  }

  // ------------------------------------------------------------ storage --

  _load () {
    if (!this.file) return
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const p of data.named || []) if (p?.name) this.named.set(fold(p.name), p)
      for (const b of data.blocks || []) if (b?.id) this.blocks.set(this._key(b), b)
      this.counters = data.counters || {}
    } catch { /* first run or corrupt file: start empty */ }
  }

  save (force = false) {
    if (!this.file || (!this._dirty && !force)) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ named: [...this.named.values()], blocks: [...this.blocks.values()], counters: this.counters }), 'utf8')
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (err) { this.log('debug', `places save failed: ${err.message || err}`) }
  }

  _key (b) { return `${b.dim || 'overworld'}:${b.x},${b.y},${b.z}` }

  static dimensionOf (bot) {
    return String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '')
  }

  // -------------------------------------------------------- named places --

  remember (name, pos, { dim = 'overworld', note = '', by = '', ownership = '', owner = '' } = {}) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!clean || !pos) return null
    const entry = { name: clean, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dim, note: String(note || '').slice(0, 100), by, ts: this.now() }
    if (ownership && ['own', 'shared', 'player', 'unknown'].includes(ownership)) entry.ownership = ownership
    if (owner) entry.owner = String(owner).slice(0, 32)
    this.named.set(fold(clean), entry)
    this._dirty = true
    this.save()
    return entry
  }

  forget (name) {
    const ok = this.named.delete(fold(name))
    if (ok) { this._dirty = true; this.save() }
    return ok
  }

  /** Exact (accent-insensitive) match first, then a unique partial match. */
  getPlace (name) {
    const q = fold(name)
    if (!q) return null
    if (this.named.has(q)) return this.named.get(q)
    const partial = [...this.named.entries()].filter(([k]) => k.includes(q) || q.includes(k))
    return partial.length === 1 ? partial[0][1] : null
  }

  // ---------------------------------------------------------- block index --

  _searchIds (bot) {
    const registry = bot.registry
    if (this._ids && this._idsFor === registry) return this._ids
    const ids = []
    for (const block of registry?.blocksArray || []) if (kindOf(block.name)) ids.push(block.id)
    this._ids = ids
    this._idsFor = registry
    return ids
  }

  /**
   * Index the useful blocks in the loaded world around the bot. Cheap enough
   * to call every few seconds; it skips when the bot has not moved.
   *
   * `max` is a safety limit, not a budget: one scan used to stop at 128
   * blocks, and a storage room has more than that (48 double chests with a
   * sign each are 144), so the far chests and every work station were never
   * indexed.
   * @returns {number} entries added or refreshed
   */
  scan (bot, { radius = 16, max = 4096, force = false } = {}) {
    const pos = bot?.entity?.position
    if (!pos || typeof bot.findBlocks !== 'function') return 0
    const dim = PlaceIndex.dimensionOf(bot)
    const last = this._lastScan
    const moved = Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z)
    if (!force && dim === last.dim && moved < 4 && this.now() - last.at < 15_000) return 0
    this._lastScan = { at: this.now(), x: pos.x, y: pos.y, z: pos.z, dim, radius }

    let found = []
    // The fast search (block_search.js): this runs while every prompt is
    // built, and the stock findBlocks took tens of milliseconds of the bot's
    // only thread each time just to learn there is no chest in the sky.
    try { found = findBlocksFast(bot, this._searchIds(bot), { maxDistance: radius, count: max, budgetMs: 400 }) } catch { return 0 }
    const seen = new Set()
    const signs = []
    let touched = 0
    for (const p of found) {
      let block = null
      try { block = bot.blockAt(p) } catch { block = null }
      const kind = block && kindOf(block.name)
      if (!kind) continue
      const key = `${dim}:${p.x},${p.y},${p.z}`
      seen.add(key)
      let entry = this.blocks.get(key)
      if (!entry) {
        // The second half of a double chest is the same inventory: keep one entry.
        if (kind === 'chest' && this._twinOf(dim, p, block)) continue
        entry = { id: this._nextId(kind), kind, block: block.name, x: p.x, y: p.y, z: p.z, dim, label: '', contents: null, seenAt: this.now(), lookedAt: 0 }
        this.blocks.set(key, entry)
        this._dirty = true
        touched++
      } else {
        entry.seenAt = this.now()
        if (entry.block !== block.name) { entry.block = block.name; this._dirty = true }
      }
      if (kind === 'sign') {
        const text = signTextOf(block)
        signs.push({ x: p.x, y: p.y, z: p.z, text, entry, support: signSupport(block, p) })
        if (entry.text !== text) { entry.text = text; this._dirty = true; touched++ }
      }
    }
    // Forget entries inside the scanned sphere that are no longer there.
    for (const [key, e] of this.blocks) {
      if (e.dim !== dim || seen.has(key)) continue
      if (Math.hypot(e.x - pos.x, e.y - pos.y, e.z - pos.z) > radius - 2) continue
      let block = null
      try { block = bot.blockAt({ x: e.x, y: e.y, z: e.z }) } catch { block = null }
      if (block && kindOf(block.name) === e.kind) continue
      if (!block) continue // chunk not loaded: keep the memory
      this.blocks.delete(key)
      this._dirty = true
    }
    this._attachLabels(bot, dim, pos, radius, signs)
    if (this._dirty) this.save()
    return touched
  }

  /** The indexed container occupying a block position (either half of a double chest). */
  _containerAt (dim, x, y, z) {
    const e = this.blocks.get(`${dim}:${x},${y},${z}`)
    if (e) return e.kind === 'sign' ? null : e
    for (const o of this.blocks.values()) {
      if (o.dim === dim && o.double && o.tx === x && o.tz === z && o.y === y) return o
    }
    return null
  }

  /** Distance from a point to a container, counting both halves of a double chest. */
  _distanceTo (e, x, y, z) {
    const d = Math.hypot(e.x - x, e.y - y, e.z - z)
    return e.double && Number.isFinite(e.tx) ? Math.min(d, Math.hypot(e.tx - x, e.y - y, e.tz - z)) : d
  }

  /**
   * People label storage with signs and item frames. A wall sign labels the
   * block it hangs on; any other sign labels the nearest container within
   * 2.3 blocks; an item frame on a container labels it with the item shown.
   * A sign that ended up as a label is marked, so the prompt does not list it
   * a second time as a sign.
   */
  _attachLabels (bot, dim, pos, radius, signs) {
    const containers = []
    for (const e of this.blocks.values()) {
      if (e.dim !== dim || e.kind === 'sign') continue
      if (Math.hypot(e.x - pos.x, e.y - pos.y, e.z - pos.z) > radius + 2) continue
      containers.push(e)
    }
    const claimed = new Map() // container -> { text, d }
    const claim = (e, text, d, sign) => {
      const cur = claimed.get(e)
      if (cur && cur.d <= d) return false
      if (cur?.sign) cur.sign.entry.labels = false
      claimed.set(e, { text, d, sign })
      return true
    }
    for (const s of signs) {
      s.entry.labels = false
      if (!s.text) continue
      // 1. A wall sign on the container itself.
      const direct = s.support ? this._containerAt(dim, s.support.x, s.support.y, s.support.z) : null
      if (direct) { if (claim(direct, s.text, 0, s)) s.entry.labels = true; continue }
      // 2. Otherwise the nearest container within 2.3 blocks.
      let best = null
      let bestD = 2.3
      for (const e of containers) {
        const d = this._distanceTo(e, s.x, s.y, s.z)
        if (d < bestD) { bestD = d; best = e }
      }
      if (best && claim(best, s.text, bestD, s)) s.entry.labels = true
    }
    // 3. Item frames: the item shown is the label ("[diamond]").
    for (const frame of this._itemFrames(bot, pos, radius)) {
      let best = null
      let bestD = 1.3
      for (const e of containers) {
        if (!CONTAINER_KINDS.has(e.kind)) continue
        const d = this._distanceTo(e, frame.x - 0.5, frame.y - 0.5, frame.z - 0.5)
        if (d < bestD) { bestD = d; best = e }
      }
      if (best && !claimed.has(best)) claimed.set(best, { text: `[${frame.item}]`, d: bestD, sign: null })
    }
    for (const [e, { text }] of claimed) {
      if (e.label !== text) { e.label = text; this._dirty = true }
    }
  }

  /** Item frames in view that show an item: [{ x, y, z, item }]. */
  _itemFrames (bot, pos, radius) {
    const out = []
    let meta = null
    try { meta = require('./threats').meta } catch { return out }
    for (const e of Object.values(bot.entities || {})) {
      const name = String(e?.name || '')
      if (name !== 'item_frame' && name !== 'glow_item_frame') continue
      const p = e.position
      if (!p || Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) > radius) continue
      const stack = meta(e, 'item', 8)
      const id = stack && typeof stack === 'object' ? (stack.itemId ?? stack.blockId ?? stack.type) : null
      const item = stack?.name || (Number.isFinite(id) ? bot.registry?.items?.[id]?.name : null)
      if (item) out.push({ x: p.x, y: p.y, z: p.z, item })
    }
    return out
  }

  /**
   * The already-indexed other half of a double chest, if `block` at `p` is one.
   * Decided by the chest's own state (two single chests side by side are two
   * chests); only a block that cannot tell its state falls back to adjacency.
   */
  _twinOf (dim, p, block) {
    const partner = chestPartner(block)
    if (partner === null) return null
    const candidates = partner === undefined ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [partner]
    for (const [dx, dz] of candidates) {
      const e = this.blocks.get(`${dim}:${p.x + dx},${p.y},${p.z + dz}`)
      if (e && e.kind === 'chest' && e.block === block.name) { e.double = true; e.tx = p.x; e.tz = p.z; return e }
    }
    return null
  }

  _nextId (kind) {
    this.counters[kind] = (this.counters[kind] || 0) + 1
    return `${kind}${this.counters[kind]}`
  }

  /** Record what was inside a container when the bot looked. */
  noteContents (pos, counts, { dim = 'overworld', freeSlots = null } = {}) {
    const e = this.blocks.get(`${dim}:${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || this._twinAt(dim, pos)
    if (!e) return null
    let diff = null
    if (e.contents && typeof e.contents === 'object') {
      const deltas = []
      const keys = new Set([...Object.keys(e.contents), ...Object.keys(counts || {})])
      for (const k of keys) {
        const delta = (Number(counts?.[k]) || 0) - (Number(e.contents[k]) || 0)
        if (delta > 0) deltas.push(`+${k} x${delta}`)
        else if (delta < 0) deltas.push(`-${k} x${Math.abs(delta)}`)
      }
      if (deltas.length) diff = deltas.slice(0, 4).join(', ')
    }
    e.contents = counts
    e.freeSlots = freeSlots
    e.lastDiff = diff
    e.lookedAt = this.now()
    this._dirty = true
    this.save()
    return e
  }

  _twinAt (dim, pos) {
    const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
    return this._containerAt(dim, x, y, z)
  }

  /** All indexed entries of the current dimension, nearest first. */
  near (pos, { dim = 'overworld', radius = 32, kinds = null } = {}) {
    const out = []
    for (const e of this.blocks.values()) {
      if (e.dim !== dim) continue
      if (kinds && !kinds.has(e.kind)) continue
      const d = Math.hypot(e.x + 0.5 - pos.x, e.y - pos.y, e.z + 0.5 - pos.z)
      if (d <= radius) out.push({ ...e, distance: d })
    }
    return out.sort((a, b) => a.distance - b.distance)
  }

  /**
   * Turn what the model wrote into one indexed block.
   *   "chest3"            → that id
   *   "Diamantes"         → the container with that label (exact, then partial)
   *   "chest" / "furnace" → nearest of that kind
   *   "iron"              → the container whose remembered contents include it
   *   "" / "nearest"      → nearest container (or nearest of `fallbackKinds`)
   */
  resolve (where, pos, { dim = 'overworld', fallbackKinds = CONTAINER_KINDS, radius = 48 } = {}) {
    const q = fold(where)
    const all = this.near(pos, { dim, radius })
    if (!q || q === 'nearest' || q === 'closest' || q === 'here') return all.find((e) => fallbackKinds.has(e.kind)) || null
    const byId = all.find((e) => e.id === q) || [...this.blocks.values()].find((e) => e.id === q && e.dim === dim)
    if (byId) return byId
    const kind = all.find((e) => e.kind !== 'sign' && (e.kind === q || e.block === q || (q === 'container' && CONTAINER_KINDS.has(e.kind))))
    if (kind) return kind
    const byLabel = this.findLabel(where, pos, { dim, radius })[0]
    if (byLabel) return byLabel
    const token = q.replace(/s$/, '')
    return all.find((e) => e.contents && Object.keys(e.contents).some((item) => item.includes(token))) || null
  }

  /**
   * Containers and stations whose label matches, best match first: the exact
   * text, then a whole word of it, then any part (singular or plural).
   */
  findLabel (text, pos, { dim = 'overworld', radius = 64 } = {}) {
    const q = fold(text).replace(/^\[|\]$/g, '')
    if (!q) return []
    const stem = q.length > 3 ? q.replace(/(es|s)$/, '') : q
    const out = []
    for (const e of this.near(pos, { dim, radius })) {
      if (e.kind === 'sign' || !e.label) continue
      const label = fold(e.label).replace(/^\[|\]$/g, '')
      let rank = 0
      if (label === q) rank = 3
      else if (label.split(/[^a-z0-9_]+/).some((w) => w === q || w === stem || (w.length > 3 && w.replace(/(es|s)$/, '') === stem))) rank = 2
      else if (label.includes(stem) || (label.length > 3 && q.includes(label))) rank = 1
      if (rank) out.push({ ...e, rank })
    }
    return out.sort((a, b) => b.rank - a.rank || a.distance - b.distance)
  }

  /** Containers whose remembered contents include an item (substring match). */
  findItem (item, pos, { dim = 'overworld' } = {}) {
    const token = fold(item).replace(/\s+/g, '_').replace(/s$/, '')
    if (!token) return []
    const out = []
    for (const e of this.blocks.values()) {
      if (e.dim !== dim || !e.contents) continue
      const hits = Object.entries(e.contents).filter(([name]) => name.includes(token))
      if (!hits.length) continue
      out.push({ ...e, hits, distance: Math.hypot(e.x - pos.x, e.y - pos.y, e.z - pos.z) })
    }
    return out.sort((a, b) => a.distance - b.distance)
  }

  // ------------------------------------------------------------ rendering --

  /**
   * contents are a MEMORY ("as of last look"), not a live view —
   * another player can move stock between scans. Older than a minute, say so.
   */
  _ageSuffix (e) {
    const age = e?.lookedAt ? this.now() - e.lookedAt : 0
    if (!age || age < 60_000) return ''
    const m = Math.floor(age / 60_000)
    return m >= 1 ? ` (as of ${m}m ago)` : ` (as of ${Math.round(age / 1000)}s ago)`
  }

  _render (e) {
    let s = e.id
    if (e.kind === 'sign') return e.text ? `sign "${e.text}"` : null
    if (e.kind === 'bed') s += ` (${String(e.block).replace(/_bed$/, '')})`
    else if (e.kind === 'furnace' && e.block !== 'furnace') s += ` (${e.block})`
    else if (e.kind === 'station') s = e.block
    if (e.label) s += ` "${e.label}"`
    if (e.contents) {
      const top = Object.entries(e.contents).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} x${c}`)
      s += top.length ? ` [${top.join(', ')}${Object.keys(e.contents).length > 5 ? ', …' : ''}]` : ' [empty]'
      s += this._ageSuffix(e)
    } else if (CONTAINER_KINDS.has(e.kind)) {
      s += ' [not opened yet]'
    }
    return s
  }

  /** Single-link clusters of indexed entries: same floor (|dy| <= 2) and within 7 blocks. */
  _clusters (entries) {
    const clusters = []
    for (const e of entries) {
      const home = clusters.find((c) => c.some((o) => Math.abs(o.y - e.y) <= 2 && Math.hypot(o.x - e.x, o.z - e.z) <= 7))
      if (home) home.push(e)
      else clusters.push([e])
    }
    return clusters
  }

  /**
   * Prompt block: what is around, grouped by floor and room-sized cluster,
   * nearest first. Returns '' when nothing is indexed nearby.
   *
   * A cluster with more containers than fit on a line is a storage room and
   * is summarised (count, nearest few with ids, every label).
   */
  describeNearby (pos, { dim = 'overworld', radius = 24, maxLines = 7, perLine = 9, maxLabels = 60 } = {}) {
    const entries = this.near(pos, { dim, radius })
    if (!entries.length) return ''
    const clusters = this._clusters(entries)
    const lines = []
    for (const c of clusters.slice(0, maxLines)) {
      const cx = c.reduce((s, e) => s + e.x, 0) / c.length
      const cy = c.reduce((s, e) => s + e.y, 0) / c.length
      const cz = c.reduce((s, e) => s + e.z, 0) / c.length
      const head = `y${Math.round(cy)} ${whereIs(pos, { x: cx, y: cy, z: cz })}`
      const containers = c.filter((e) => CONTAINER_KINDS.has(e.kind))
      // Stations are listed once each.
      const stations = []
      for (const e of c) {
        if (!STATION_KINDS.has(e.kind)) continue
        const name = e.kind === 'station' ? e.block : e.kind
        if (!stations.includes(name)) stations.push(name)
      }
      const others = c.filter((e) => !CONTAINER_KINDS.has(e.kind) && !STATION_KINDS.has(e.kind) && !(e.kind === 'sign' && (e.labels || !e.text)))
      const loose = others.filter((e) => e.kind === 'sign')
      const rest = others.filter((e) => e.kind !== 'sign').map((e) => this._render(e)).filter(Boolean)
      const signNote = loose.slice(0, 3).map((e) => this._render(e)).concat(loose.length > 3 ? [`+${loose.length - 3} more signs`] : [])

      if (containers.length > perLine) {
        const labelled = containers.filter((e) => e.label)
        const opened = containers.filter((e) => e.contents)
        const nearest = containers.slice(0, 4).map((e) => `${e.id}${e.label ? ` "${e.label}"` : ''} ${whereIs(pos, e)}`)
        const labels = [...new Set(labelled.map((e) => e.label))].sort((x, y) => fold(x).localeCompare(fold(y)))
        const shown = labels.slice(0, maxLabels)
        let line = `${head}: STORAGE ROOM — ${containers.length} containers (${labelled.length} labelled, ${opened.length} opened). Nearest: ${nearest.join(', ')}.`
        if (shown.length) line += ` Labels: ${shown.join(', ')}${labels.length > shown.length ? `, +${labels.length - shown.length} more` : ''}.`
        line += ' A label or an id works as `where`; find {what:"<label or item>"} looks one up, find {what:"storage"} lists them all.'
        const extra = [...rest, ...stations, ...signNote]
        if (extra.length) line += ` Also here: ${extra.slice(0, perLine).join(', ')}.`
        lines.push(line)
        continue
      }
      const parts = [...containers.map((e) => this._render(e)).filter(Boolean), ...rest, ...stations, ...signNote]
      if (!parts.length) continue
      const more = parts.length > perLine ? `, +${parts.length - perLine} more` : ''
      lines.push(`${head}: ${parts.slice(0, perLine).join(', ')}${more}`)
    }
    if (clusters.length > maxLines) lines.push(`(+${clusters.length - maxLines} more groups further away)`)
    return lines.join('\n')
  }

  /**
   * The storage around, one container per entry, nearest first, in pages:
   * "chest12 "Ferro" 3m W [iron_ingot x64, …]". For find {what:"storage"}.
   * @returns {{ total:number, page:number, pages:number, lines:string[] }}
   */
  listStorage (pos, { dim = 'overworld', radius = 32, page = 1, perPage = 20 } = {}) {
    const all = this.near(pos, { dim, radius, kinds: CONTAINER_KINDS })
    const pages = Math.max(1, Math.ceil(all.length / perPage))
    const n = Math.min(pages, Math.max(1, Math.trunc(Number(page)) || 1))
    const lines = all.slice((n - 1) * perPage, n * perPage).map((e) => {
      let s = `${e.id}${e.label ? ` "${e.label}"` : ''} ${whereIs(pos, e)}`
      if (e.contents) {
        const top = Object.entries(e.contents).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, c]) => `${name} x${c}`)
        s += top.length ? ` [${top.join(', ')}${Object.keys(e.contents).length > 3 ? ', …' : ''}]` : ' [empty]'
        s += this._ageSuffix(e)
      }
      return s
    })
    return { total: all.length, page: n, pages, lines }
  }

  /** "home (12,64,-3 · 40m S), mina (…)" — named places, nearest first. */
  describeNamed (pos, { dim = 'overworld', max = 8 } = {}) {
    const list = [...this.named.values()].filter((p) => (p.dim || 'overworld') === dim)
    if (!list.length) return ''
    return list
      .map((p) => ({ p, d: Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map(({ p }) => {
        const ownTag = p.ownership === 'own' ? ' [yours]' : p.ownership === 'player' ? ` [${p.owner || 'player'}'s]` : p.ownership === 'shared' ? ' [shared]' : ''
        const noteTag = p.note ? ` · "${p.note}"` : ''
        return `${p.name}${ownTag} (${p.x},${p.y},${p.z} · ${whereIs(pos, p)}${noteTag})`
      })
      .join(', ')
  }
}

module.exports = { PlaceIndex, kindOf, signTextOf, chestPartner, signSupport, CONTAINER_KINDS, STATION_KINDS }

// ---------------------------------------------------------------------------
// instant invalidation/adoption (method lives on
// PlaceIndex.prototype so the class body above stays untouched):

/**
 * A blockUpdate at an indexed position: container broken or changed kind?
 * The 3 s scan would catch it on the next pass; this makes it zero-cost and
 * immediate, so a chest that vanished never keeps phantom contents.
 * The other half: a blockUpdate for a NOT-yet-indexed container inside the
 * last scanned box adopts it straight away, so a chest placed right next to
 * the bot (by anyone, including the bot itself) does not sit invisible until
 * the next scan wave. The bbox check against the last scan keeps this O(1)-ish
 * and prevents phantom adoptions from other dimensions or far-away edits.
 */
PlaceIndex.prototype.onBlockChange = function (oldBlock, newBlock, { dim = null } = {}) {
  const p = newBlock?.position || oldBlock?.position
  if (!p || !Number.isFinite(p.x)) return
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const kind = newBlock ? kindOf(newBlock.name || '') : null
  let matched = false
  for (const [key, e] of this.blocks) {
    if (e.x !== x || e.y !== y || e.z !== z) continue
    if (dim && e.dim !== dim) continue
    matched = true
    if (kind === e.kind && String(newBlock?.name) === e.block) continue // nothing structural changed
    if (!kind) {
      this.blocks.delete(key) // broken or replaced by air — gone from the index
      this._dirty = true
    } else {
      // Same spot, changed identity (e.g. chest → trapped chest): re-index clean.
      e.kind = kind
      e.block = newBlock.name
      e.contents = null
      e.lookedAt = 0
      this._dirty = true
    }
  }
  if (matched || !kind || kind === 'sign') { if (this._dirty) this.save(); return }
  // Not indexed yet: adopt only if it sits inside the last scanned box.
  const last = this._lastScan
  const r = (last.radius ?? 16) + 2
  if (!last.at || this.now() - last.at > 30_000) return // no recent scan: nothing to extend
  if (dim && last.dim && dim !== last.dim) return
  if (Math.abs(x - last.x) > r || Math.abs(y - last.y) > r || Math.abs(z - last.z) > r) return
  const useDim = dim || last.dim || 'overworld'
  const pos = { x, y, z }
  if (kind === 'chest' && this._twinOf(useDim, pos, newBlock)) return // other half indexed
  const entry = { id: this._nextId(kind), kind, block: String(newBlock.name), x, y, z, dim: useDim, label: '', contents: null, seenAt: this.now(), lookedAt: 0 }
  this.blocks.set(`${useDim}:${x},${y},${z}`, entry)
  this._dirty = true
  this.save()
}
