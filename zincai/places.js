/**
 * places.js — the bot's memory of WHERE things are.
 *
 * Two kinds of knowledge, both persisted to zincai-data/places.json:
 *
 *   1. Named places the model (or a player, through the model) asked to keep:
 *      "home", "mina", "casa do Gabriel" → coordinates.
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
 * Pure w.r.t. the network; `scan()` only reads the already-loaded world.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { whereIs } = require('./threats')

const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/** Block name → kind. Order matters: first match wins. */
const KIND_RULES = [
  [/^(trapped_)?chest$/, 'chest'],
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

function kindOf (blockName) {
  const n = String(blockName || '')
  for (const [re, kind] of KIND_RULES) if (re.test(n)) return kind
  return null
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

  remember (name, pos, { dim = 'overworld', note = '', by = '' } = {}) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!clean || !pos) return null
    const entry = { name: clean, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dim, note: String(note || '').slice(0, 80), by, ts: this.now() }
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
   * @returns {number} entries added or refreshed
   */
  scan (bot, { radius = 16, max = 128, force = false } = {}) {
    const pos = bot?.entity?.position
    if (!pos || typeof bot.findBlocks !== 'function') return 0
    const dim = PlaceIndex.dimensionOf(bot)
    const last = this._lastScan
    const moved = Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z)
    if (!force && dim === last.dim && moved < 4 && this.now() - last.at < 15_000) return 0
    this._lastScan = { at: this.now(), x: pos.x, y: pos.y, z: pos.z, dim }

    let found = []
    try { found = bot.findBlocks({ matching: this._searchIds(bot), maxDistance: radius, count: max }) } catch { return 0 }
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
      if (kind === 'sign') { signs.push({ x: p.x, y: p.y, z: p.z, text: signTextOf(block) }); }
      let entry = this.blocks.get(key)
      if (!entry) {
        // The second half of a double chest is the same inventory: keep one entry.
        if (kind === 'chest' && this._twinOf(dim, p, block.name)) continue
        entry = { id: this._nextId(kind), kind, block: block.name, x: p.x, y: p.y, z: p.z, dim, label: '', contents: null, seenAt: this.now(), lookedAt: 0 }
        this.blocks.set(key, entry)
        this._dirty = true
        touched++
      } else {
        entry.seenAt = this.now()
        if (entry.block !== block.name) { entry.block = block.name; this._dirty = true }
      }
      if (kind === 'sign') {
        const text = signs[signs.length - 1].text
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
    // People label storage with signs: attach the nearest sign's text.
    if (signs.length) {
      for (const e of this.blocks.values()) {
        if (e.dim !== dim || e.kind === 'sign') continue
        if (Math.hypot(e.x - pos.x, e.y - pos.y, e.z - pos.z) > radius) continue
        let best = null
        let bestD = 2.3
        for (const s of signs) {
          if (!s.text) continue
          const d = Math.hypot(s.x - e.x, s.y - e.y, s.z - e.z)
          if (d < bestD) { bestD = d; best = s }
        }
        const label = best ? best.text : ''
        if (label && e.label !== label) { e.label = label; this._dirty = true }
      }
    }
    if (this._dirty) this.save()
    return touched
  }

  _twinOf (dim, p, blockName) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const e = this.blocks.get(`${dim}:${p.x + dx},${p.y},${p.z + dz}`)
      if (e && e.block === blockName) { e.double = true; return e }
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
    e.contents = counts
    e.freeSlots = freeSlots
    e.lookedAt = this.now()
    this._dirty = true
    this.save()
    return e
  }

  _twinAt (dim, pos) {
    const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const e = this.blocks.get(`${dim}:${x + dx},${y},${z + dz}`)
      if (e && e.kind === 'chest') return e
    }
    return null
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
   *   "diamantes"         → the container labelled or containing that
   *   "chest" / "furnace" → nearest of that kind
   *   "" / "nearest"      → nearest container (or nearest of `fallbackKinds`)
   */
  resolve (where, pos, { dim = 'overworld', fallbackKinds = CONTAINER_KINDS, radius = 48 } = {}) {
    const q = fold(where)
    const all = this.near(pos, { dim, radius })
    if (!q || q === 'nearest' || q === 'closest' || q === 'here') return all.find((e) => fallbackKinds.has(e.kind)) || null
    const byId = all.find((e) => e.id === q) || [...this.blocks.values()].find((e) => e.id === q && e.dim === dim)
    if (byId) return byId
    const kind = all.find((e) => e.kind === q || e.block === q || (q === 'container' && CONTAINER_KINDS.has(e.kind)))
    if (kind) return kind
    const byLabel = all.find((e) => e.label && fold(e.label).includes(q))
    if (byLabel) return byLabel
    const token = q.replace(/s$/, '')
    return all.find((e) => e.contents && Object.keys(e.contents).some((item) => item.includes(token))) || null
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
    } else if (CONTAINER_KINDS.has(e.kind)) {
      s += ' [not opened yet]'
    }
    return s
  }

  /**
   * Prompt block: what is around, grouped by floor and room-sized cluster,
   * nearest first. Returns '' when nothing is indexed nearby.
   */
  describeNearby (pos, { dim = 'overworld', radius = 24, maxLines = 7, perLine = 9 } = {}) {
    const entries = this.near(pos, { dim, radius })
    if (!entries.length) return ''
    // Single-link clusters: same floor (|dy| <= 2) and within 7 blocks.
    const clusters = []
    for (const e of entries) {
      const home = clusters.find((c) => c.some((o) => Math.abs(o.y - e.y) <= 2 && Math.hypot(o.x - e.x, o.z - e.z) <= 7))
      if (home) home.push(e)
      else clusters.push([e])
    }
    const lines = []
    for (const c of clusters.slice(0, maxLines)) {
      const cx = c.reduce((s, e) => s + e.x, 0) / c.length
      const cy = c.reduce((s, e) => s + e.y, 0) / c.length
      const cz = c.reduce((s, e) => s + e.z, 0) / c.length
      // Stations are listed once each, containers individually.
      const seenStation = new Set()
      const parts = []
      for (const e of c) {
        if (e.kind === 'station' || e.kind === 'crafting_table' || e.kind === 'enchanting_table' || e.kind === 'brewing_stand' || e.kind === 'anvil') {
          const name = e.kind === 'station' ? e.block : e.kind
          if (seenStation.has(name)) continue
          seenStation.add(name)
          parts.push(name)
          continue
        }
        const r = this._render(e)
        if (r) parts.push(r)
      }
      if (!parts.length) continue
      const more = parts.length > perLine ? `, +${parts.length - perLine} more` : ''
      lines.push(`y${Math.round(cy)} ${whereIs(pos, { x: cx, y: cy, z: cz })}: ${parts.slice(0, perLine).join(', ')}${more}`)
    }
    if (clusters.length > maxLines) lines.push(`(+${clusters.length - maxLines} more groups further away)`)
    return lines.join('\n')
  }

  /** "home (12,64,-3 · 40m S), mina (…)" — named places, nearest first. */
  describeNamed (pos, { dim = 'overworld', max = 8 } = {}) {
    const list = [...this.named.values()].filter((p) => (p.dim || 'overworld') === dim)
    if (!list.length) return ''
    return list
      .map((p) => ({ p, d: Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map(({ p }) => `${p.name} (${p.x},${p.y},${p.z} · ${whereIs(pos, p)})`)
      .join(', ')
  }
}

module.exports = { PlaceIndex, kindOf, signTextOf, CONTAINER_KINDS }
