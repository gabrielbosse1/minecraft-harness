'use strict'
const { Vec3 } = require('vec3')

// Observation-only physical graph. Edges are NOT evidence of power transfer.
const DIRS = [
  { name: 'north', opposite: 'south', x: 0, z: -1 },
  { name: 'south', opposite: 'north', x: 0, z: 1 },
  { name: 'east', opposite: 'west', x: 1, z: 0 },
  { name: 'west', opposite: 'east', x: -1, z: 0 }
]
const keys = (x, y, z) => `${x},${y},${z}`
function componentKind (name) {
  if (name === 'redstone_wire') return 'dust'
  if (name === 'repeater' || name === 'comparator' || name === 'observer') return name
  if (name === 'piston' || name === 'sticky_piston') return 'piston'
  if (name === 'redstone_torch' || name === 'redstone_wall_torch') return 'torch'
  if (name === 'lever') return 'lever'
  if (/_button$/.test(name)) return 'button'
  if (/_pressure_plate$/.test(name)) return 'pressure_plate'
  if (['redstone_block', 'redstone_lamp', 'target', 'daylight_detector', 'hopper', 'dropper', 'dispenser', 'tripwire_hook', 'sculk_sensor', 'calibrated_sculk_sensor', 'note_block'].includes(name)) return name
  return null
}
const wanted = {
  dust: ['north', 'south', 'east', 'west', 'power'],
  repeater: ['facing', 'delay', 'locked', 'powered'],
  comparator: ['facing', 'mode', 'powered'],
  observer: ['facing', 'powered'], piston: ['facing', 'extended'],
  torch: ['facing', 'lit'], lever: ['face', 'facing', 'powered'],
  button: ['face', 'facing', 'powered'], pressure_plate: ['powered', 'power']
}
const safeValue = (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 999999) || (typeof v === 'string' && /^[a-z0-9_]{1,24}$/.test(v))
function component (block, x, y, z) {
  const name = typeof block?.name === 'string' && /^[a-z0-9_]{1,80}$/.test(block.name) ? block.name : ''
  const kind = componentKind(name)
  if (!kind) return null
  let raw = null
  try { const p = block.getProperties?.(); if (p && typeof p === 'object' && !Array.isArray(p)) raw = p } catch { /* unknown, not an empty state */ }
  const fields = wanted[kind] || ['facing', 'powered', 'power', 'lit']
  const properties = {}
  for (const k of fields) if (raw && Object.hasOwn(raw, k) && safeValue(raw[k])) properties[k] = raw[k]
  return { x, y, z, id: keys(x, y, z), name, kind, properties, missing: fields.filter((k) => !Object.hasOwn(properties, k)) }
}
function graph (nodes) {
  const map = new Map(nodes.map((n) => [n.id, n]))
  const edges = []
  // Enumerate each undirected pair once. Vertical/diagonal behavior is only a
  // candidate; the client has no scheduled ticks or authoritative power data.
  for (const a of nodes) {
    for (const d of DIRS) {
      const b = map.get(keys(a.x + d.x, a.y, a.z + d.z))
      if (b && a.id < b.id) {
        const mutual = a.kind === 'dust' && b.kind === 'dust' && a.properties[d.name] === 'side' && b.properties[d.opposite] === 'side'
        edges.push({ a: a.id, b: b.id, label: mutual ? 'observed_dust_side_geometry' : 'adjacent_unresolved', evidence: mutual ? `${d.name}=side and ${d.opposite}=side` : 'adjacent; electrical relationship unknown' })
      }
      if (a.kind === 'dust' && a.properties[d.name] === 'up') {
        const up = map.get(keys(a.x + d.x, a.y + 1, a.z + d.z))
        if (up?.kind === 'dust') edges.push({ a: a.id, b: up.id, label: 'possible_dust_step', evidence: `${d.name}=up; support and power not validated` })
      }
    }
    const above = map.get(keys(a.x, a.y + 1, a.z))
    if (above) edges.push({ a: a.id, b: above.id, label: 'adjacent_unresolved', evidence: 'vertical adjacency; electrical relationship unknown' })
  }
  return edges
}
const err = (msg) => ({ ok: false, msg })
const bounded = (msg) => msg.length <= 850 ? msg : msg.slice(0, 820) + ' [details omitted; use a narrower scan]'
function currentDimension (bot) { return String(bot.game?.dimension || 'unknown').replace(/[^a-z0-9_:.-]/gi, '').slice(0, 48) || 'unknown' }
class RedstoneInspector {
  constructor (bot, { now = Date.now } = {}) { this.bot = bot; this.now = now; this.snapshots = new Map(); this.sequence = 0 }
  scan ({ x, y, z, radius = 1, page = 1, snapshot } = {}) {
    if (!Number.isSafeInteger(page) || page < 1) return err('page must be a positive integer')
    let s
    if (snapshot !== undefined) {
      if (typeof snapshot !== 'string' || !/^rs[1-9][0-9]{0,9}$/.test(snapshot)) return err('invalid snapshot id')
      if (x !== undefined || y !== undefined || z !== undefined || radius !== 1) return err('use either snapshot and page, or center and radius')
      s = this.snapshots.get(snapshot)
      if (!s) return err('snapshot not found; scan a region first (session cache holds four)')
    } else {
      if (![x, y, z, radius].every(Number.isSafeInteger) || radius < 0 || radius > 2 || ![x - radius, x + radius, y - radius, y + radius, z - radius, z + radius].every(Number.isSafeInteger)) return err('center must be safe integer coordinates and radius 0–2')
      const p = this.bot.entity?.position
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return err('position unavailable')
      if (Math.hypot(Math.abs(x + 0.5 - p.x) + radius, Math.abs(y + 0.5 - p.y) + radius, Math.abs(z + 0.5 - p.z) + radius) > 8) return err('region extends beyond the 8 block inspection radius')
      const nodes = []; const unknown = []; let unloaded = 0; let unreadable = 0
      for (let dz = -radius; dz <= radius; dz++) for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const bx = x + dx; const by = y + dy; const bz = z + dz
        let b
        try { b = this.bot.blockAt(new Vec3(bx, by, bz)) } catch { unreadable++; unknown.push({ x: bx, y: by, z: bz, reason: 'unreadable' }); continue }
        if (!b) { unloaded++; unknown.push({ x: bx, y: by, z: bz, reason: 'unloaded' }); continue }
        // Unknown block identity is missing observation, not empty space.
        if (typeof b.name !== 'string' || !/^[a-z0-9_]{1,80}$/.test(b.name)) { unreadable++; unknown.push({ x: bx, y: by, z: bz, reason: 'unreadable' }); continue }
        const c = component(b, bx, by, bz); if (c) nodes.push(c)
      }
      const id = `rs${++this.sequence}`
      s = { id, x, y, z, radius, ts: this.now(), dimension: currentDimension(this.bot), version: String(this.bot.version || 'unknown').replace(/[^a-z0-9_.-]/gi, '').slice(0, 24), nodes, edges: graph(nodes), unknown, unloaded, unreadable }
    }
    const pages = Math.max(1, Math.ceil(s.nodes.length / 4))
    if (page > pages) return err(`page out of range; ${s.id} has ${pages} pages`)
    if (snapshot === undefined) {
      this.snapshots.set(s.id, s)
      if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value)
    }
    const counts = {}
    for (const n of s.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1
    const types = Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(', ') || 'none'
    const geometry = s.edges.filter((e) => e.label === 'observed_dust_side_geometry').length
    const list = s.nodes.slice((page - 1) * 4, page * 4).map((n) => `${n.name}@${n.id}`).join('; ') || 'none'
    const age = Math.max(0, Math.floor((this.now() - s.ts) / 1000))
    return { ok: true, msg: bounded(`${s.id} snapshot ${age}s old in ${s.dimension} (${s.version}), center ${s.x},${s.y},${s.z} radius ${s.radius}; ${s.nodes.length} recognized components (${types}); ${s.unloaded} unloaded, ${s.unreadable} unreadable cells. Graph: ${geometry} observed dust-side geometries, ${s.edges.length - geometry} possible/unresolved relationships; no power proven. Page ${page}/${pages}: ${list}. Use redstone_component with snapshot and coordinates; non-atomic capture; boundary, noncomponents and mechanics unmodeled.`) }
  }
  metadata (snapshot) {
    const s = typeof snapshot === 'string' ? this.snapshots.get(snapshot) : null
    if (!s) return null
    return { x: s.x, y: s.y, z: s.z, radius: s.radius, dimension: s.dimension, version: s.version, ts: s.ts, components: s.nodes.length, unloaded: s.unloaded, unreadable: s.unreadable }
  }
  inspect ({ snapshot, x, y, z, page = 1 } = {}) {
    if (typeof snapshot !== 'string' || !/^rs[1-9][0-9]{0,9}$/.test(snapshot) || ![x, y, z, page].every(Number.isSafeInteger) || page < 1) return err('provide snapshot id, integer coordinates and page >= 1')
    const s = this.snapshots.get(snapshot)
    if (!s) return err('snapshot not found; scan a region first')
    const node = s.nodes.find((n) => n.x === x && n.y === y && n.z === z)
    if (!node) return err('no recognized component at those coordinates in this snapshot; cell may be unloaded, outside the region, or unsupported')
    const edges = s.edges.filter((e) => e.a === node.id || e.b === node.id)
    const pages = Math.max(1, Math.ceil(edges.length / 3))
    if (page > pages) return err(`page out of range; this component has ${pages} pages`)
    const props = Object.entries(node.properties).map(([k, v]) => `${k}=${v}`).join(', ') || 'none observed'
    const missing = node.missing.length ? node.missing.join(',') : 'none of listed fields'
    const list = edges.slice((page - 1) * 3, page * 3).map((e) => `${e.a === node.id ? e.b : e.a} ${e.label} (${e.evidence})`).join('; ') || 'no recognized neighboring relationships in captured volume'
    const boundary = Math.abs(x - s.x) === s.radius || Math.abs(y - s.y) === s.radius || Math.abs(z - s.z) === s.radius
    const nearbyUnknown = s.unknown.filter((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y), Math.abs(p.z - z)) <= 1)
    const unknownNote = nearbyUnknown.length ? `Nearby unknown: ${nearbyUnknown.slice(0, 3).map((p) => `${p.x},${p.y},${p.z} ${p.reason}`).join('; ')}${nearbyUnknown.length > 3 ? ` (+${nearbyUnknown.length - 3} more)` : ''}. ` : ''
    const age = Math.max(0, Math.floor((this.now() - s.ts) / 1000))
    return { ok: true, msg: bounded(`${snapshot} ${age}s old ${s.dimension}: No direction or actual power inferred; ${node.name}@${node.id}; state ${props}; missing ${missing}${node.kind === 'comparator' ? '; comparator output strength/container data unknown' : ''}. Relationships page ${page}/${pages}: ${list}. ${boundary ? 'At capture boundary; outside unknown. ' : ''}${s.unloaded || s.unreadable ? `Snapshot has ${s.unloaded} unloaded and ${s.unreadable} unreadable cells. ` : ''}${unknownNote}Noncomponent paths, timing and quasi-connectivity unknown.`) }
  }
}
module.exports = { RedstoneInspector, componentKind, graph }
