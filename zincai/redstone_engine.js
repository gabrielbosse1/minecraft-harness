/**
 * redstone_engine.js — Redstone perception, circuit modelling, discrete-tick
 * simulation, fault diagnosis, design/compare, ownership-safe placement, live
 * functional verification, and procedural design learning for ZincAI.
 *
 * Honesty rules baked in:
 *  - Every state read comes from a real block state (`getProperties()`); when a
 *    property is missing it is reported as unknown, never as 0/false.
 *  - Predictions are labelled `model` (an approximation of Java mechanics), and
 *    `compareObserved()` lists exactly where model and world disagree instead
 *    of asserting the world is wrong.
 *  - A design is only marked `verified` after the bot observed real output
 *    changes in the world (`functionalTest`), never from placement alone.
 *
 * Java Edition 1.21.4 / 26.3 orientation notes (verified against
 * prismarine-registry + mineflayer 4.39.0):
 *  - repeater/comparator `facing` points toward the REAR (input) side;
 *    opposite(facing) is the FRONT (output).
 *  - observer `facing` points toward the OBSERVED block; opposite(facing) is
 *    where the pulse leaves.
 *  - piston/sticky_piston `facing` is the direction the head extends.
 *  - redstone_wall_torch `facing` points away from the wall it hangs on, so the
 *    support block is pos + opposite(facing).
 *  - hopper `enabled=false` means locked by redstone.
 *  - dropper/dispenser use `triggered`.
 *  - numeric properties (`power`, `delay`, `note`, `rotation`) arrive as
 *    strings from prismarine-block and as numbers in tests: both are parsed.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const MAX_RADIUS = 6
const MAX_NODES = 640
const MAX_TRACE = 64

const DIRS = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 }
}
const HORIZ = ['north', 'south', 'east', 'west']
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const AXIS_VEC = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 }
}

const key = (x, y, z) => `${x},${y},${z}`
const num = (v, fallback = null) => {
  if (v === undefined || v === null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const bool = (v, fallback = null) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fallback)

// ---------------------------------------------------------------------------
// 1. Component recognition (full 1.21.4 / 26.3 palette)
// ---------------------------------------------------------------------------

const CONTAINERS = new Set([
  'chest', 'trapped_chest', 'barrel', 'ender_chest', 'furnace', 'blast_furnace', 'smoker',
  'hopper', 'dropper', 'dispenser', 'brewing_stand', 'shulker_box', 'crafter'
])

/** @returns {{kind:string, role:string}|null} */
function classify (name) {
  const n = String(name || '')
  if (!n || n === 'air' || n === 'cave_air' || n === 'void_air') return null
  const R = (kind, role) => ({ kind, role })
  if (n === 'redstone_wire') return R('dust', 'wire')
  if (n === 'redstone_torch') return R('torch', 'source')
  if (n === 'redstone_wall_torch') return R('torch', 'source')
  if (n === 'repeater') return R('repeater', 'logic')
  if (n === 'comparator') return R('comparator', 'logic')
  if (n === 'observer') return R('observer', 'source')
  if (n === 'piston') return R('piston', 'mechanism')
  if (n === 'sticky_piston') return R('sticky_piston', 'mechanism')
  if (n === 'piston_head') return R('piston_head', 'mechanism')
  if (n === 'moving_piston') return R('moving_piston', 'mechanism')
  if (n === 'hopper') return R('hopper', 'mechanism')
  if (n === 'dropper') return R('dropper', 'mechanism')
  if (n === 'dispenser') return R('dispenser', 'mechanism')
  if (n === 'lever') return R('lever', 'source')
  if (/_button$/.test(n)) return R('button', 'source')
  if (/_pressure_plate$/.test(n)) return R('pressure_plate', 'source')
  if (n === 'tripwire') return R('tripwire', 'source')
  if (n === 'tripwire_hook') return R('tripwire_hook', 'source')
  if (n === 'target') return R('target', 'source')
  if (n === 'daylight_detector') return R('daylight_detector', 'source')
  if (n === 'redstone_block') return R('redstone_block', 'source')
  if (n === 'redstone_lamp') return R('redstone_lamp', 'output')
  if (n === 'note_block') return R('note_block', 'output')
  if (n === 'sculk_sensor' || n === 'calibrated_sculk_sensor') return R(n, 'source')
  if (n === 'lightning_rod') return R('lightning_rod', 'source')
  if (n === 'trapped_chest') return R('trapped_chest', 'source')
  if (/_door$/.test(n)) return R('door', 'output')
  if (/_trapdoor$/.test(n)) return R('trapdoor', 'output')
  if (/_fence_gate$/.test(n)) return R('fence_gate', 'output')
  if (n === 'powered_rail' || n === 'activator_rail' || n === 'detector_rail') return R(n, n === 'detector_rail' ? 'source' : 'output')
  if (CONTAINERS.has(n)) return R(n === 'hopper' || n === 'dropper' || n === 'dispenser' ? n : 'container', 'storage')
  if (n === 'crafter') return R('crafter', 'mechanism')
  return null
}

/** True for blocks that convey/hold a signal (not full solid blocks). */
const isSignalCarrier = (kind) => ['dust', 'torch', 'repeater', 'comparator', 'observer'].includes(kind)

const SIZE = 0.5

/** Normalize a hostile property bag into typed, honest state. */
function normalizeState (kind, raw) {
  const s = {}
  const has = (k) => raw && Object.hasOwn(raw, k)
  const putNum = (k, fallback) => {
    if (!has(k)) return
    const v = num(raw[k], null)
    if (v !== null) s[k] = v
  }
  const putBool = (k) => {
    if (!has(k)) return
    const v = bool(raw[k], null)
    if (v !== null) s[k] = v
  }
  const putStr = (k) => {
    if (!has(k)) return
    const v = String(raw[k])
    if (/^[a-z0-9_]{1,24}$/.test(v)) s[k] = v
  }
  for (const d of HORIZ) putStr(d)
  putNum('power')
  putNum('delay')
  putNum('note')
  putNum('rotation')
  for (const k of ['powered', 'lit', 'locked', 'extended', 'enabled', 'triggered', 'attached', 'disarmed', 'inverted', 'open', 'short', 'conditional', 'half', 'waterlogged']) putBool(k)
  for (const k of ['facing', 'face', 'mode', 'instrument', 'type', 'axis', 'half', 'shape']) putStr(k)
  if (kind === 'piston_head') { putStr('facing'); putStr('type') }
  return s
}

// ---------------------------------------------------------------------------
// 2. Perception
// ---------------------------------------------------------------------------

function dimensionOf (bot) {
  return String(bot?.game?.dimension || 'unknown').replace(/^minecraft:/, '').replace(/[^a-z0-9_:.-]/gi, '').slice(0, 48) || 'unknown'
}

/**
 * Read a bounded region and return a snapshot of every signal component plus
 * the solid blocks around them (needed to reason about torches, strong
 * powering candidates and placement feasibility).
 *
 * @returns {{ok:true, snapshot:object}|{ok:false, msg:string}}
 */
function perceive (bot, { x, y, z, radius = 3, maxNodes = MAX_NODES } = {}) {
  if (![x, y, z].every(Number.isSafeInteger)) return { ok: false, msg: 'center must be integer block coordinates' }
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_RADIUS) return { ok: false, msg: `radius must be 0–${MAX_RADIUS}` }
  const pos = bot?.entity?.position
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return { ok: false, msg: 'bot position unavailable' }

  const nodes = []
  const solids = new Set()
  const containers = []
  const unknown = []
  let unloaded = 0
  // +1 cell margin so a component on the boundary still has its neighbours.
  for (let dy = -radius - 1; dy <= radius + 1; dy++) {
    for (let dz = -radius - 1; dz <= radius + 1; dz++) {
      for (let dx = -radius - 1; dx <= radius + 1; dx++) {
        const bx = x + dx; const by = y + dy; const bz = z + dz
        let b = null
        try { b = bot.blockAt({ x: bx, y: by, z: bz }) } catch { unknown.push({ x: bx, y: by, z: bz, reason: 'unreadable' }); continue }
        if (!b) { unloaded++; unknown.push({ x: bx, y: by, z: bz, reason: 'unloaded' }); continue }
        const name = String(b.name || '')
        if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') continue
        const cls = classify(name)
        let raw = null
        try { raw = b.getProperties?.() } catch { raw = null }
        if (!cls) {
          solids.add(key(bx, by, bz))
          continue
        }
        const inBounds = Math.abs(dx) <= radius && Math.abs(dy) <= radius && Math.abs(dz) <= radius
        if (!inBounds) {
          // Outside the requested box: only its name matters for adjacency.
          solids.add(key(bx, by, bz))
          continue
        }
        const state = normalizeState(cls.kind, raw)
        const node = {
          id: key(bx, by, bz),
          x: bx, y: by, z: bz,
          name,
          kind: cls.kind,
          role: cls.role,
          state,
          propsKnown: Boolean(raw && typeof raw === 'object')
        }
        if (node.kind === 'container' || node.kind === 'hopper' || node.kind === 'dropper' || node.kind === 'dispenser') containers.push(node.id)
        nodes.push(node)
        if (nodes.length > maxNodes) return { ok: false, msg: `region holds more than ${maxNodes} components — inspect a smaller area` }
      }
    }
  }
  return {
    ok: true,
    snapshot: {
      center: { x, y, z },
      radius,
      dimension: dimensionOf(bot),
      version: String(bot?.version || 'unknown').replace(/[^a-z0-9_.-]/gi, '').slice(0, 24),
      observedAt: Date.now(),
      nodes,
      solids: [...solids],
      containers,
      unknown,
      unloaded,
      // What this snapshot cannot answer is stated once, centrally.
      limits: 'static client snapshot: no scheduled ticks, no strong/weak power distinction, no quasi-connectivity, no item counts inside containers'
    }
  }
}

function indexSnapshot (snapshot) {
  const byPos = new Map()
  for (const n of snapshot.nodes) byPos.set(n.id, n)
  const solid = new Set(snapshot.solids || [])
  return { byPos, solid }
}

// ---------------------------------------------------------------------------
// 3. Circuit model: directed edges, power solver, tick simulation
// ---------------------------------------------------------------------------

const SOURCE_KINDS = new Set(['lever', 'button', 'pressure_plate', 'tripwire', 'tripwire_hook', 'target', 'daylight_detector', 'redstone_block', 'sculk_sensor', 'calibrated_sculk_sensor', 'observer', 'detector_rail', 'lightning_rod', 'trapped_chest'])
const MECHANISM_KINDS = new Set(['piston', 'sticky_piston', 'redstone_lamp', 'door', 'trapdoor', 'fence_gate', 'note_block', 'hopper', 'dropper', 'dispenser', 'powered_rail', 'activator_rail', 'crafter', 'copper_bulb'])

const isMechanism = (n) => MECHANISM_KINDS.has(n.kind)

/** Is this source node emitting right now, from its own observed state? */
function sourceStrength (node, { inputs = null } = {}) {
  const s = node.state || {}
  if (inputs && Object.hasOwn(inputs, node.id)) return inputs[node.id] ? 15 : 0
  switch (node.kind) {
    case 'lever': return s.powered === true ? 15 : s.powered === false ? 0 : null
    case 'button': return s.powered === true ? 15 : s.powered === false ? 0 : null
    case 'pressure_plate': return s.powered === true ? (Number.isFinite(s.power) ? s.power : 15) : s.powered === false ? 0 : null
    case 'tripwire': return s.powered === true ? 15 : s.powered === false ? 0 : null
    case 'tripwire_hook': return s.powered === true ? 15 : s.powered === false ? 0 : null
    case 'target': return Number.isFinite(s.power) ? s.power : null
    case 'daylight_detector': {
      if (!Number.isFinite(s.power)) return null
      return s.inverted ? 15 - s.power : s.power
    }
    case 'redstone_block': return 15
    case 'sculk_sensor':
    case 'calibrated_sculk_sensor': return s.powered === true ? 15 : s.powered === false ? 0 : null
    case 'detector_rail': return s.powered === true ? 15 : s.powered === false ? 0 : null
    case 'lightning_rod': return s.powered === true ? 15 : null
    case 'trapped_chest': return null // needs container fullness; unknown statically
    default: return null
  }
}

class CircuitModel {
  /**
   * @param {object} snapshot from perceive()
   * @param {{ now?: () => number }} [opts]
   */
  constructor (snapshot, { now = Date.now } = {}) {
    this.snapshot = snapshot
    this.now = now
    const { byPos, solid } = indexSnapshot(snapshot)
    this.byPos = byPos
    this.solid = solid
    this.nodes = snapshot.nodes.slice()
    this.edges = this._buildEdges()
    this.warnings = []
  }

  nodeAt (x, y, z) { return this.byPos.get(key(x, y, z)) || null }
  isSolid (x, y, z) { return this.solid.has(key(x, y, z)) }
  isEmpty (x, y, z) { return !this.byPos.has(key(x, y, z)) && !this.solid.has(key(x, y, z)) }

  /**
   * Signal components next to `node` (6 faces). A face that holds an ordinary
   * solid block is reported as `{ dir, node: null, solidBlock: true }` so that
   * callers can reason about block powering — a lever, torch or repeater
   * powers the BLOCK beside/below it, not just the components it touches.
   */
  neighbours (node, { includeSolids = false } = {}) {
    const out = []
    const faces = [...HORIZ.map((d) => [d, { x: DIRS[d].x, y: 0, z: DIRS[d].z }]), ['up', AXIS_VEC.up], ['down', AXIS_VEC.down]]
    for (const [dir, v] of faces) {
      const x = node.x + v.x; const y = node.y + v.y; const z = node.z + v.z
      const n = this.nodeAt(x, y, z)
      if (n) { out.push({ dir, node: n }); continue }
      if (includeSolids && this.isSolid(x, y, z)) out.push({ dir, node: null, solidBlock: true, at: { x, y, z } })
    }
    return out
  }

  /** Every cell around `pos` that can carry or deliver power into it. */
  around (pos) {
    const at = { x: pos.x, y: pos.y, z: pos.z }
    return this.neighbours(at, { includeSolids: true })
  }

  sources () { return this.nodes.filter((n) => SOURCE_KINDS.has(n.kind)) }
  mechanisms () { return this.nodes.filter(isMechanism) }

  /**
   * One line per recognisable group of components, plus the limits of a static
   * snapshot. This is what the model says about itself — never a power claim.
   */
  describe () {
    const byKind = new Map()
    for (const n of this.nodes) {
      if (!byKind.has(n.kind)) byKind.set(n.kind, [])
      byKind.get(n.kind).push(n)
    }
    const out = []
    for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const parts = list.slice(0, 8).map((n) => {
        const st = n.state || {}
        const flag = st.powered === true || st.lit === true ? '(on)'
          : st.powered === false || st.lit === false ? '(off)' : ''
        return `${kind}@${n.id}${flag}`
      })
      out.push(`${list.length} × ${kind}: ${parts.join(', ')}${list.length > 8 ? ', …' : ''}`)
    }
    if (!out.length) out.push('no redstone components in this region')
    out.push(`${this.solid.size} solid blocks and ${this.snapshot.unknown?.length || 0} unreadable cells in view; ${this.snapshot.limits}`)
    return out
  }

  _powerOfNode (node, power) {
    if (!node) return 0
    if (node.kind === 'dust' || node.kind === 'repeater' || node.kind === 'comparator') {
      const p = power.get(node.id)
      return p ? (p.known ? p.model : null) : null
    }
    const s = sourceStrength(node)
    if (s !== null) return s
    if (node.kind === 'torch') return node.state?.lit ? 15 : 0
    if (node.kind === 'observer') return node.state?.powered ? 15 : 0
    return 0
  }

  /** Cycles through signal carriers (a clock, a latch's feedback, a short). */
  _findCycles () {
    const carrier = (n) => !!n && isSignalCarrier(n.kind)
    const adj = new Map()
    for (const n of this.nodes) {
      if (!carrier(n)) continue
      const list = []
      for (const o of this.outputsOf(n)) if (o.node && carrier(o.node)) list.push(o.node.id)
      for (const i of this.inputsOf(n)) if (i.node && carrier(i.node)) list.push(i.node.id)
      adj.set(n.id, [...new Set(list)])
    }
    const cycles = []
    const seen = new Set()
    const dfs = (start, node, trail, depth) => {
      if (depth > 12) return
      for (const next of adj.get(node) || []) {
        if (next === start && trail.length >= 2) {
          const sig = [...trail].sort().join('|')
          if (!seen.has(sig)) { seen.add(sig); cycles.push(trail.slice()) }
          continue
        }
        if (trail.includes(next)) continue
        dfs(start, next, [...trail, next], depth + 1)
      }
    }
    for (const id of adj.keys()) dfs(id, id, [id], 0)
    return cycles
  }

  /**
   * Solid-block connectivity: true when power delivered into `pos` by a
   * component other than dust can be pulled out of it (dust running over it,
   * a repeater reading it, a torch hanging on it). Transparent blocks are not
   * conductive in Java, with a short list of documented exceptions.
   */
  isConductive (x, y, z) {
    if (!this.isSolid(x, y, z)) return false
    const n = this.nodeAt(x, y, z)
    switch (n?.kind) {
      case 'redstone_lamp': case 'note_block': case 'piston': case 'sticky_piston':
      case 'observer': case 'hopper': case 'dropper': case 'dispenser':
      case 'container': case 'chest': case 'trapped_chest': case 'crafting_table':
      case 'furnace': case 'blast_furnace': case 'smoker': case 'barrel':
      case 'powered_rail': case 'activator_rail': case 'detector_rail':
        return true
      case 'door': case 'trapdoor': case 'fence_gate': case 'piston_head': case 'moving_piston':
        return false
      default:
        return true // ordinary opaque terrain (the snapshot only records non-signal solids here)
    }
  }

  /** Can a signal step from dust cell `from` into dust cell `to`? */
  dustStep (from, to) {
    const dx = to.x - from.x; const dy = to.y - from.y; const dz = to.z - from.z
    const dirOf = (vx, vy, vz) => vy > 0 ? 'up' : vy < 0 ? 'down'
      : vz < 0 ? 'north' : vz > 0 ? 'south' : vx > 0 ? 'east' : 'west'
    if (dx === 0 && dz === 0) return false // a straight vertical stack never conducts
    const horiz = Math.abs(dx) + Math.abs(dz)
    if (horiz !== 1) return false
    if (dy === 0) {
      const d = dirOf(dx, dy, dz)
      // Both cells must connect toward each other; a dot/cross, or an
      // unconnected face, does not conduct.
      const back = to.state?.[OPP[d]]
      return back === 'side' || back === 'up' || back === undefined
    }
    if (Math.abs(dy) === 1) {
      const d = dirOf(dx, 0, dz) // horizontal direction from `from` toward `to`
      if (dy > 0) {
        // `to` is the higher cell. The connection marker lives on the LOWER
        // cell and points up at its neighbour: from.state[d] === 'up'.
        return from.state?.[d] === 'up'
      }
      // `to` is the lower cell: its marker points up, i.e. toward `from`.
      return to.state?.[OPP[d]] === 'up'
    }
    return false
  }

  /** Where a component's OUTPUT leaves (list of neighbour descriptors). */
  outputsOf (node) {
    const s = node.state || {}
    switch (node.kind) {
      case 'dust': return this.neighbours(node)
      case 'repeater':
      case 'comparator': {
        if (!s.facing || !DIRS[s.facing]) return []
        const d = OPP[s.facing]
        const v = DIRS[d]
        const out = []
        const front = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        if (front) out.push({ dir: d, node: front })
        // A device's front face also STRONGLY powers the solid block in front of
        // it, so present that face as a solid output too (block power follows).
        else if (this.isSolid(node.x + v.x, node.y, node.z + v.z)) out.push({ dir: d, solid: true, at: { x: node.x + v.x, y: node.y, z: node.z + v.z } })
        // A repeater's front face also powers the block above its output when
        // that block is the one the dust sits on — modelled through block power.
        return out
      }
      case 'observer': {
        if (!s.facing) return []
        const d = OPP[s.facing]
        const v = AXIS_VEC[d] || DIRS[d]
        if (!v) return []
        const front = this.nodeAt(node.x + v.x, node.y + v.y, node.z + v.z)
        return front ? [{ dir: d, node: front }] : []
      }
      case 'torch': return this.neighbours(node).filter((nb) => nb.node.kind !== 'dust' || nb.dir !== 'up')
      case 'lever': case 'button': case 'pressure_plate': case 'tripwire':
      case 'tripwire_hook': case 'target': case 'daylight_detector':
      case 'redstone_block': case 'sculk_sensor': case 'calibrated_sculk_sensor':
      case 'detector_rail': case 'lightning_rod': case 'trapped_chest':
        return this.neighbours(node)
      default: return []
    }
  }

  /** True when `node` accepts a signal from the neighbour at `dir` as its REAR. */
  _readsRear (node, dir) {
    const s = node.state || {}
    return Boolean(s.facing) && s.facing === dir
  }

  /** Where a component's INPUT arrives from. */
  inputsOf (node) {
    const s = node.state || {}
    switch (node.kind) {
      case 'repeater':
      case 'comparator': {
        if (!s.facing || !DIRS[s.facing]) return []
        const v = DIRS[s.facing]
        const rear = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        const out = []
        if (rear) out.push({ dir: s.facing, node: rear, role: 'rear' })
        else if (this.isSolid(node.x + v.x, node.y, node.z + v.z)) out.push({ dir: s.facing, solid: true, role: 'rear' })
        if (node.kind === 'comparator') {
          for (const d of HORIZ) {
            if (d === s.facing || d === OPP[s.facing]) continue
            const sd = DIRS[d]
            const side = this.nodeAt(node.x + sd.x, node.y, node.z + sd.z)
            if (side) out.push({ dir: d, node: side, role: 'side' })
            else if (this.isSolid(node.x + sd.x, node.y, node.z + sd.z)) out.push({ dir: d, solid: true, role: 'side' })
          }
        }
        return out
      }
      case 'observer': {
        if (!s.facing) return []
        const v = AXIS_VEC[s.facing] || DIRS[s.facing]
        if (!v) return []
        const watched = this.nodeAt(node.x + v.x, node.y + v.y, node.z + v.z)
        if (watched) return [{ dir: s.facing, node: watched, role: 'watched' }]
        if (this.isSolid(node.x + v.x, node.y + v.y, node.z + v.z)) return [{ dir: s.facing, solid: true, role: 'watched' }]
        return []
      }
      case 'torch': {
        // A torch's attachment is what switches it off. A floor torch hangs on
        // the block below; a wall torch hangs on the block opposite `facing`.
        if (node.name === 'redstone_wall_torch' && s.facing && DIRS[s.facing]) {
          const d = OPP[s.facing]
          const v = DIRS[d]
          return [{ dir: d, node: this.nodeAt(node.x + v.x, node.y, node.z + v.z), solid: this.isSolid(node.x + v.x, node.y, node.z + v.z), role: 'support' }]
        }
        return [{ dir: 'down', node: this.nodeAt(node.x, node.y - 1, node.z), solid: this.isSolid(node.x, node.y - 1, node.z), role: 'support' }]
      }
      case 'dust': return this.neighbours(node)
      default: return this.neighbours(node)
    }
  }

  /**
   * Dust lines that visibly point at a torch cell. Advisory only: a wire the
   * torch itself feeds must not switch it off, so this is used for diagnosis
   * (`torch_fed_by_wire`) and for explaining why a NOT gate is wired wrong,
   * never for the torch's own lit/unlit decision.
   */
  torchFeeders (torch) {
    const out = []
    for (const nb of this.around(torch)) {
      const other = nb.node
      if (!other || other.kind !== 'dust') continue
      if (nb.dir === 'down') continue
      const own = nb.dir === 'up' ? 'up' : OPP[nb.dir]
      const conn = other.state?.[own]
      if (conn === 'side' || conn === 'up' || conn === undefined) out.push({ node: other, dir: nb.dir })
    }
    return out
  }

  _buildEdges () {
    const edges = []
    const seen = new Set()
    const push = (from, to, kind, evidence, confidence) => {
      const k = `${from}|${to}|${kind}`
      if (seen.has(k)) return
      seen.add(k)
      edges.push({ from, to, kind, evidence, confidence })
    }
    for (const node of this.nodes) {
      for (const o of this.outputsOf(node)) {
        if (!o.node) continue
        if (!isSignalCarrier(o.node.kind) && !isMechanism(o.node) && !SOURCE_KINDS.has(o.node.kind)) continue
        let kind = 'signal_path'
        let confidence = 'modelled'
        let evidence = `${node.kind} → ${o.node.kind} via ${o.dir}`
        if (node.kind === 'dust' && o.node.kind === 'dust') {
          const conducts = this.dustStep(node, o.node)
          const side = node.state?.[o.dir]
          kind = conducts ? 'dust_link' : 'dust_link_geometry'
          if (!conducts) confidence = 'blocked'
          evidence = `dust ${o.dir}=${side ?? 'unknown'}${conducts ? '' : ' (does not conduct)'}`
        }
        if (node.kind === 'repeater' || node.kind === 'comparator') { kind = 'logic_output'; evidence = `${node.kind} front ${o.dir}` }
        if (node.kind === 'observer') { kind = 'observer_pulse'; evidence = `observer output ${o.dir}` }
        if (isMechanism(o.node)) { kind = 'mechanism_input'; evidence = `${o.node.kind} powered from ${o.dir}` }
        push(node.id, o.node.id, kind, evidence, confidence)
      }
    }
    return edges
  }

  /** Adjacent nodes that deliver power into `node` (any face, any direction). */
  _powerSourcesAround (node, power) {
    const out = []
    for (const nb of this.around(node)) {
      if (!nb.node) {
        const bp = this.blockPower(nb.at.x, nb.at.y, nb.at.z, power)
        if (bp && bp.total > 0) out.push({ at: `${nb.at.x},${nb.at.y},${nb.at.z}`, dir: nb.dir, power: bp.total, strong: bp.strong })
        continue
      }
      const other = nb.node
      if (other.kind === 'dust') {
        const dc = power.get(other.id)
        if (dc && dc.known && this.dustStep(other, node)) out.push({ at: other.id, dir: nb.dir, power: dc.model })
      } else if (other.kind === 'repeater' || other.kind === 'comparator') {
        const lc = power.get(other.id)
        const s = other.state || {}
        if (lc && lc.known && s.facing && s.facing === nb.dir) out.push({ at: other.id, dir: nb.dir, power: lc.model })
      } else if (SOURCE_KINDS.has(other.kind)) {
        const s = sourceStrength(other)
        if (s !== null && s !== 0) out.push({ at: other.id, dir: nb.dir, power: s })
      }
    }
    return out
  }

  /**
   * Power delivered into the CONDUCTIVE block at (x,y,z).
   *
   * `strong` = full strength through the block (a repeater/comparator front, a
   * torch underneath, a lever/button on the block, a redstone block). `weak`
   * = only from dust on top of or pointing into the block. Only the strong
   * variant feeds fresh dust; both activate mechanisms and repeaters.
   */
  blockPower (x, y, z, power) {
    if (!this.isConductive(x, y, z)) return null
    const at = { x, y, z, id: key(x, y, z) }
    let strong = 0
    let weak = 0
    let known = false
    for (const nb of this.around(at)) {
      const other = nb.node
      if (other && (other.kind === 'dust' || other.kind === 'repeater' || other.kind === 'comparator')) continue
      if (!other) {
        // An adjacent solid that is itself powered does NOT power this block
        // (no block powers another block), so nothing to add here.
        continue
      }
      // A torch is a source in its own right (it has no `powered` property).
      const isTorch = other.kind === 'torch'
      if (!SOURCE_KINDS.has(other.kind) && !isTorch) continue
      const s = isTorch ? (other.state?.lit ? 15 : 0) : sourceStrength(other)
      if (s === null) continue
      // A torch never powers the block it hangs on; it powers the block above it.
      if (other.kind === 'torch') {
        if (nb.dir !== 'down') continue
        if (!other.state?.lit) continue
        strong = Math.max(strong, 15); known = true
        continue
      }
      if (s <= 0) continue
      known = true
      strong = Math.max(strong, s)
    }
    // A powered repeater/comparator powers the block in front of it.
    for (const nb of this.around(at)) {
      const other = nb.node
      if (!other || (other.kind !== 'repeater' && other.kind !== 'comparator')) continue
      const s = other.state || {}
      if (!s.facing || s.facing !== nb.dir) continue
      const lc = power.get(other.id)
      if (!lc || !lc.known) continue
      known = true
      if ((lc.model || 0) > 0) strong = Math.max(strong, lc.model)
    }
    // Dust on top, or dust pointing into this block, powers it weakly.
    for (const nb of this.around(at)) {
      const other = nb.node
      if (!other || other.kind !== 'dust') continue
      const dc = power.get(other.id)
      if (!dc || !dc.known) continue
      const pointsIn = nb.dir === 'up' || other.state?.[OPP[nb.dir]] === 'side' || other.state?.[OPP[nb.dir]] === 'up'
      if (!pointsIn) continue
      known = true
      weak = Math.max(weak, dc.model)
    }
    if (!known) return null
    const total = Math.max(strong, weak)
    return { strong, weak, total, known, rank: strong >= weak ? 'strong' : 'weak' }
  }

  /**
   * Fixed-point power solve from the *observed* source states.
   * Returns Map(nodeId → {power, model, known, observed, contributors[]}).
   * `power` is the signal strength (0–15); a repeater/comparator outputs at
   * least 15 when its modelled output is on (a real repeater re-strengthens).
   */
  solvePower ({ inputs = null, maxIterations = 48 } = {}) {
    const power = new Map()
    const contributors = new Map()
    const dust = this.nodes.filter((n) => n.kind === 'dust')
    for (const d of dust) {
      const observed = num(d.state?.power, null)
      power.set(d.id, { model: 0, observed, known: observed !== null, power: 0, contributors: [] })
      contributors.set(d.id, [])
    }
    // Devices are solved from their observed state first, so a snapshot with no
    // reachable source (the source sits outside the inspected box) still models.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const observed = node.state?.powered
      power.set(node.id, {
        model: 0,
        observed: observed === true ? 15 : observed === false ? 0 : null,
        known: observed === true || observed === false,
        power: 0,
        contributors: []
      })
    }
    const setDust = (id, value, via) => {
      const cur = power.get(id)
      if (!cur) return false
      if (value > cur.model) { cur.model = value; cur.power = value; cur.contributors = via; return true }
      return false
    }
    // Seed from observed dust (covers a wire whose source is outside the box).
    for (const d of dust) {
      const observed = num(d.state?.power, null)
      if (observed !== null && observed > 0) setDust(d.id, observed, [{ from: 'observed', via: 'client state', power: observed }])
    }
    // Seed from active devices: dust next to a lit torch/lever/redstone block.
    for (const src of this.nodes) {
      if (src.kind === 'torch') {
        if (src.state?.lit !== true) continue
        for (const nb of this.neighbours(src)) {
          if (nb.node.kind === 'dust') setDust(nb.node.id, 15, [{ from: src.id, via: 'lit torch', power: 15 }])
          if (this.isSolid(nb.node.x, nb.node.y, nb.node.z)) {
            // A torch strongly powers the block above it (handled by blockPower).
          }
        }
        continue
      }
      if (!SOURCE_KINDS.has(src.kind)) continue
      const strength = sourceStrength(src, { inputs })
      if (strength === null || strength <= 0) continue
      for (const nb of this.neighbours(src)) {
        if (nb.node.kind === 'dust') setDust(nb.node.id, strength, [{ from: src.id, via: `${src.kind} adjacent`, power: strength }])
      }
    }
    // Seed dust from repeater/comparator fronts and from strongly powered blocks.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const cur = power.get(node.id)
      if (!cur?.known || !cur.model) continue
      for (const o of this.outputsOf(node)) {
        if (o.node?.kind === 'dust') setDust(o.node.id, cur.model >= 15 ? 15 : cur.model, [{ from: node.id, via: `${node.kind} front`, power: cur.model }])
      }
    }
    let changed = true
    let iter = 0
    while (changed && iter++ < maxIterations) {
      changed = false
      // Dust-to-dust relaxation.
      for (const d of dust) {
        const cur = power.get(d.id)
        for (const other of dust) {
          if (other.id === d.id) continue
          const dx = other.x - d.x; const dy = other.y - d.y; const dz = other.z - d.z
          if (Math.abs(dx) + Math.abs(dz) > 1 || Math.abs(dy) > 1) continue
          const oc = power.get(other.id)
          if (!oc || !oc.known) continue
          if (!this.dustStep(other, d)) continue
          const candidate = Math.max(0, (oc.power ?? oc.model) - 1)
          if (setDust(d.id, candidate, [...oc.contributors, { from: other.id, via: 'dust decay', power: candidate }])) changed = true
        }
      }
      // Strongly powered blocks feed dust on top of them and dust beside them.
      for (const d of dust) {
        // Dust takes block power from the block it sits on, or from a block it
        // points into — never from a block that only carries weak power.
        for (const nb of this.around(d)) {
          const pos = nb.at || (nb.node ? { x: nb.node.x, y: nb.node.y, z: nb.node.z } : null)
          if (!pos) continue
          // Block power reaches dust only from a block it SITS ON, or from a
          // block it points into. A mechanism node that is itself powered is
          // not a power source for its neighbours' dust.
          // A missing direction property is UNKNOWN, not "disconnected": the same
                    // honesty rule dustStep uses.
                    const side = d.state?.[nb.dir]
                    const pointsAt = nb.dir === 'down' || (nb.node == null && (side === 'side' || side === 'up' || side === undefined))
          if (!pointsAt) continue
          const bp = this.blockPower(pos.x, pos.y, pos.z, power)
          if (global.__RSDEBUG) console.log('cand', d.id, nb.dir, JSON.stringify(bp))
          if (!bp || bp.strong <= 0) continue
          if (setDust(d.id, bp.strong, [{ from: `${pos.x},${pos.y},${pos.z}`, via: 'strongly powered block', power: bp.strong }])) changed = true
        }
      }
      // Devices follow their solved inputs.
      for (const node of this.nodes) {
        if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
        const cur = power.get(node.id)
        if (node.kind === 'repeater') {
          const inP = this.inputPower(node, power, { inputs })
          if (inP === null) continue
          const want = inP > 0 ? 15 : 0
          if (want !== cur.model) { cur.model = want; cur.power = want; cur.known = true; cur.contributors = [{ from: 'rear', via: `repeater input ${inP}`, power: inP }]; changed = true }
        } else {
          const r = this.comparatorPower(node, power, { inputs })
          if (r === null) continue
          if (r.output !== cur.model) { cur.model = r.output; cur.power = r.output; cur.known = true; cur.contributors = [{ from: 'rear', via: `comparator ${r.mode} rear=${r.rear} side=${r.side}`, power: r.output }]; changed = true }
        }
      }
    }
    return { power, contributors }
  }

  /** Power arriving at a repeater/comparator REAR from its neighbours or its rear block. */
  inputPower (node, power, { inputs = null } = {}) {
    const s = node.state || {}
    if (!s.facing || !DIRS[s.facing]) return null
    const v = DIRS[s.facing]
    const rx = node.x + v.x; const ry = node.y; const rz = node.z + v.z
    let best = 0
    let known = false
    const rear = this.nodeAt(rx, ry, rz)
    if (rear) {
      if (rear.kind === 'dust') {
        const dc = power.get(rear.id)
        if (dc && dc.known) { known = true; best = Math.max(best, dc.model) }
      } else if (rear.kind === 'torch') {
        known = true; best = Math.max(best, rear.state?.lit ? 15 : 0)
      } else if (rear.kind === 'repeater' || rear.kind === 'comparator') {
        const lc = power.get(rear.id)
        if (lc && lc.known) { known = true; best = Math.max(best, lc.model) }
      } else if (SOURCE_KINDS.has(rear.kind)) {
        const sSrc = sourceStrength(rear, { inputs })
        if (sSrc !== null) { known = true; best = Math.max(best, sSrc) }
      }
      // A mechanism or plain solid between the rear and the wire: pull its block power.
      const bp = this.blockPower(rx, ry, rz, power)
      if (bp) { known = true; best = Math.max(best, bp.total) }
    } else {
      const bp = this.blockPower(rx, ry, rz, power)
      if (bp) { known = true; best = Math.max(best, bp.total) }
    }
    return known ? best : null
  }

  /** Analog comparator solve: comparison or subtraction of rear against sides. */
  comparatorPower (node, power, { inputs = null } = {}) {
    const s = node.state || {}
    const rear = this.inputPower(node, power, { inputs })
    if (rear === null) return null
    let side = 0
    let sideKnown = true
    for (const d of HORIZ) {
      if (d === s.facing || d === OPP[s.facing]) continue
      const v = DIRS[d]
      const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (!n) {
        const bp = this.blockPower(node.x + v.x, node.y, node.z + v.z, power)
        side = Math.max(side, bp ? bp.total : 0)
        continue
      }
      if (n.kind === 'dust') { const dc = power.get(n.id); if (dc && dc.known) side = Math.max(side, dc.model) }
      else if (n.kind === 'torch') side = Math.max(side, n.state?.lit ? 15 : 0)
      else if (n.kind === 'repeater' || n.kind === 'comparator') { const lc = power.get(n.id); if (lc?.known) side = Math.max(side, lc.model) }
      else if (SOURCE_KINDS.has(n.kind)) { const x = sourceStrength(n, { inputs }); if (x !== null) side = Math.max(side, x) }
      else { const bp = this.blockPower(n.x, n.y, n.z, power); if (bp) side = Math.max(side, bp.total) }
    }
    const mode = s.mode === 'subtract' ? 'subtract' : 'compare'
    const output = mode === 'subtract' ? Math.max(0, rear - side) : (side > rear ? 0 : rear)
    return { rear, side, sideKnown, mode, output }
  }

  /** Kept for callers that only need the numeric block power. */
  blockPowerAt (node, inp) {
    const v = inp.dir && (DIRS[inp.dir] || AXIS_VEC[inp.dir])
    if (!v) return null
    const bp = this.blockPower(node.x + v.x, node.y + v.y, node.z + v.z, this._lastPower || new Map())
    return bp ? bp.total : null
  }

  /**
   * Predicted activation of one mechanism.
   *
   * Java: a mechanism is activated by an adjacent source, an adjacent powered
   * block (strong OR weak), a repeater/comparator facing it, or dust pointing
   * at it. A piston is additionally activated by a strongly powered block one
   * block above it (quasi-connectivity); that is modelled, and flagged.
   */
  predictMechanism (node, power, { inputs = null } = {}) {
    let inPower = 0
    let known = false
    const reasons = []
    for (const nb of this.around(node)) {
      const other = nb.node
      if (!other) {
        const bp = this.blockPower(nb.at.x, nb.at.y, nb.at.z, power)
        if (bp) { known = true; if (bp.total > inPower) { inPower = bp.total; reasons.push(`block ${nb.dir} ${bp.rank}`) } }
        continue
      }
      if (other.kind === 'dust') {
        const dc = power.get(other.id)
        if (dc && dc.known) {
          known = true
          const pointsIn = nb.dir === 'down' || other.state?.[OPP[nb.dir]] === 'side' || other.state?.[OPP[nb.dir]] === 'up'
          if (pointsIn && dc.model > inPower) { inPower = dc.model; reasons.push(`dust ${nb.dir}`) }
        }
        continue
      }
      if (other.kind === 'repeater' || other.kind === 'comparator') {
        const lc = power.get(other.id)
        const s = other.state || {}
        if (lc && lc.known) {
          known = true
          // The device sits at nb.dir from `node`, so its FRONT (OPP[facing]) points
          // back at `node` exactly when nb.dir === facing.
          if (s.facing && s.facing === nb.dir && lc.model > inPower) { inPower = lc.model; reasons.push(`${other.kind} facing it`) }
        }
        continue
      }
      if (other.kind === 'torch') {
        known = true
        if (other.state?.lit && nb.dir !== 'up') { inPower = Math.max(inPower, 15); reasons.push('lit torch beside it') }
        continue
      }
      if (SOURCE_KINDS.has(other.kind)) {
        const s = sourceStrength(other, { inputs })
        if (s !== null) { known = true; if (s > inPower) { inPower = s; reasons.push(`${other.kind} adjacent`) } }
        continue
      }
      // A solid block beside the mechanism may carry power into it.
      const bp = this.blockPower(other.x, other.y, other.z, power)
      if (bp) { known = true; if (bp.total > inPower) { inPower = bp.total; reasons.push(`block ${nb.dir} ${bp.rank}`) } }
    }
    let quasi = false
    if (node.kind === 'piston' || node.kind === 'sticky_piston') {
      const above = { x: node.x, y: node.y + 1, z: node.z }
      const bp = this.blockPower(above.x, above.y, above.z, power)
      if (bp && bp.strong > 0) { known = true; quasi = true; if (bp.strong > inPower) { inPower = bp.strong; reasons.push('quasi-connectivity (block above)') } }
    }
    const lit = inPower > 0
    const extra = quasi ? { quasiConnectivity: true } : {}
    switch (node.kind) {
      case 'redstone_lamp': return { activate: lit, expected: { lit }, known, inPower, reasons, ...extra }
      case 'piston':
      case 'sticky_piston': return { activate: lit, expected: { extended: lit }, known, inPower, reasons, ...extra }
      case 'door':
      case 'trapdoor':
      case 'fence_gate': return { activate: lit, expected: { open: lit }, known, inPower, reasons, ...extra }
      case 'note_block': return { activate: lit, expected: { powered: lit }, known, inPower, reasons, ...extra }
      case 'hopper': return { activate: !lit, expected: { enabled: !lit }, known, inPower, reasons, ...extra }
      case 'dropper':
      case 'dispenser': return { activate: lit, expected: { triggered: lit }, known, inPower, reasons, ...extra }
      case 'powered_rail':
      case 'activator_rail': return { activate: lit, expected: {}, known, inPower, reasons, ...extra }
      default: return { activate: lit, expected: {}, known, inPower, reasons, ...extra }
    }
  }

  /**
   * Compare model predictions with the observed world. Every discrepancy is a
   * diagnostic lead, not proof that the world is wrong.
   */
  compareObserved ({ inputs = null } = {}) {
    const { power } = this.solvePower({ inputs })
    const rows = []
    for (const node of this.nodes) {
      if (node.kind === 'dust' || node.kind === 'repeater' || node.kind === 'comparator') {
        const p = power.get(node.id)
        if (!p || p.observed === null) continue
        rows.push({ node, predicted: p.model, observed: p.observed, agree: p.model === p.observed, why: `model ${p.model} vs observed ${p.observed}` })
      } else if (isMechanism(node)) {
        const pred = this.predictMechanism(node, power, { inputs })
        const expected = pred.expected
        const observedState = node.state || {}
        const entries = Object.entries(expected).filter(([k]) => observedState[k] !== undefined)
        if (!entries.length) continue
        const agree = entries.every(([k, v]) => observedState[k] === v)
        rows.push({ node, predicted: expected, observed: Object.fromEntries(entries.map(([k]) => [k, observedState[k]])), agree, known: pred.known, why: pred.reasons.join(', ') || 'no modelled input' })
      }
    }
    return rows
  }

  // ------------------------------------------------------------- diagnosis

  /**
   * Fault diagnosis. Returns findings ordered by severity, each naming the
   * evidence it used and what it cannot know.
   */
  diagnose ({ inputs = null } = {}) {
    const findings = []
    const { power } = this.solvePower({ inputs })
    const add = (severity, code, node, msg, evidence) => findings.push({ severity, code, at: node ? `${node.x},${node.y},${node.z}` : null, kind: node?.kind || null, msg, evidence: evidence || null })
    const mechanisms = this.mechanisms()
    this._lastPower = power
    const sourcesOn = this.sources().filter((s) => (sourceStrength(s, { inputs }) || 0) > 0)

    // A circuit can legitimately have no interactive source: an observer clock,
    // a pressure plate outside the box, a redstone block. Only complain when
    // nothing at all can drive the model AND no component is already on.
    const anyDriven = [...power.values()].some((p) => p.known && p.model > 0)
    if (!sourcesOn.length && !anyDriven) {
      add('high', 'no_active_source', null, 'no redstone source is active in this region, so nothing can be powered', `${this.sources().length} passive source(s) observed`)
    }

    // Dust cells that read 0 while a visibly-linked neighbour carries power.
    for (const node of this.nodes) {
      if (node.kind !== 'dust') continue
      const observed = num(node.state?.power, null)
      if (observed === null || observed > 0) continue
      for (const nb of this.neighbours(node)) {
        if (nb.node.kind !== 'dust') continue
        const nObs = num(nb.node.state?.power, null)
        if (nObs === null || nObs <= 1) continue
        if (!this.dustStep(nb.node, node)) {
          add('medium', 'dust_visually_unlinked', node,
            `dust here reads power=${observed} while its ${nb.dir} neighbour reads ${nObs}, and the ${nb.dir} side does not connect — the run is deliberately broken or the dust was right-clicked into a dot`,
            `neighbour ${nb.node.id} power=${nObs}`)
          continue
        }
        add('high', 'dust_gap', node,
          `dust here reads power=0 while the ${nb.dir} neighbour reads ${nObs} and both sides visually connect — the link is probably cut (a block between them, a different Y level, or a stale client read). Re-inspect the ${nb.dir} side and the block on top`,
          `neighbour ${nb.node.id} power=${nObs}`)
        break
      }
    }

    // Mechanisms that should be active but are not (or vice versa).
    for (const node of mechanisms) {
      const pred = this.predictMechanism(node, power, { inputs })
      if (!pred.known) continue
      const observed = node.state || {}
      const mismatch = Object.entries(pred.expected).filter(([k, v]) => observed[k] !== undefined && observed[k] !== v)
      if (!mismatch.length) continue
      const [prop, expected] = mismatch[0]
      add('high', 'mechanism_mismatch', node,
        `${node.kind} ${prop}=${observed[prop]} but the modelled input power is ${pred.inPower} (${pred.reasons.join(', ') || 'no input'}), so it is expected to be ${prop}=${expected} — check the power actually reaching this block (a gap, a wrong-facing repeater, or a component the client cannot see)`,
        `expected ${JSON.stringify(pred.expected)} observed ${JSON.stringify(observed)}`)
    }

    // Repeater/comparator orientation: they read their REAR only.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const s = node.state || {}
      if (!s.facing) {
        add('medium', 'orientation_unknown', node, `${node.kind} orientation was not reported by the client, so its input/output direction is unknown`, 'missing facing property')
        continue
      }
      const backV = DIRS[s.facing]
      const frontV = DIRS[OPP[s.facing]]
      const rearNode = backV ? this.nodeAt(node.x + backV.x, node.y, node.z + backV.z) : null
      const frontNode = frontV ? this.nodeAt(node.x + frontV.x, node.y, node.z + frontV.z) : null
      const rearPower = this.inputPower(node, power, { inputs })
      const frontPower = frontNode ? this._powerOfNode(frontNode, power) : 0
      const sidePower = []
      for (const d of HORIZ) {
        if (d === s.facing || d === OPP[s.facing]) continue
        const v = DIRS[d]
        const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        const p = n ? this._powerOfNode(n, power) : 0
        if (p !== null && p > 0) sidePower.push(`${d}(${n.kind} ${p})`)
      }
      if ((rearPower || 0) === 0 && sidePower.length) {
        add('high', 'repeater_wrong_facing', node,
          `${node.kind} reads its rear at ${s.facing} (${node.x + backV.x},${node.y},${node.z + backV.z}) which is cold, but signal is arriving from the side (${sidePower.join(', ')}) — a ${node.kind} only accepts input from its rear, so it is very likely rotated 90°: set facing to the powered side`,
          `rear=${rearPower} sides=${sidePower.join(',')}`)
        continue
      }
      if (rearPower !== null && frontPower !== null && rearPower === 0 && frontPower > 0) {
        add('high', 'repeater_reversed', node,
          `${node.kind} faces ${s.facing} (input at ${node.x + backV.x},${node.y},${node.z + backV.z}), but power is arriving on its OUTPUT side — it is very likely placed backwards`,
          `rear=${rearPower} front=${frontPower}`)
      }
      if (node.kind === 'repeater' && s.locked === true) {
        add('medium', 'repeater_locked', node, 'repeater is locked by a powered side comparator/repeater and will not change state until the side lock is released', 'locked=true')
      }
      if (node.kind === 'repeater' && Number.isFinite(s.delay)) {
        add('info', 'repeater_delay', node, `repeater delay is ${s.delay} redstone tick(s) = ${s.delay * 2} game ticks (${(s.delay * 0.1).toFixed(1)} s) — timing-sensitive circuits depend on this`, `delay=${s.delay}`)
      }
      if (node.kind === 'comparator') {
        const mode = s.mode || 'compare'
        add('info', 'comparator_mode', node, `comparator is in ${mode} mode${mode === 'subtract' ? ' (outputs rear − max(side), floored at 0)' : ' (outputs rear only when rear ≥ sides)'}`, `mode=${mode}`)
      }
    }

    // Mechanisms with no reachable source at all.
    for (const node of mechanisms) {
      const pred = this.predictMechanism(node, power, { inputs })
      if (pred.known && !pred.activate) {
        add('info', 'mechanism_unpowered', node, `${node.kind} has no modelled input power`, 'all neighbour inputs read 0')
      }
    }

    // Loop / clock detection: a cycle through signal carriers.
    const cycles = this._findCycles()
    for (const c of cycles.slice(0, 4)) {
      const hasTorch = c.some((id) => this.byPos.get(id)?.kind === 'torch')
      const hasRepeater = c.some((id) => ['repeater', 'comparator'].includes(this.byPos.get(id)?.kind))
      add('info', 'feedback_loop', this.byPos.get(c[0]) || null,
        `feedback loop of ${c.length} components${hasRepeater ? ' with a delay element' : ''}${hasTorch ? ' and a torch inverter' : ''} — ${hasRepeater ? 'this is how a clock/oscillator is built; its period depends on the repeater delays' : (hasTorch ? 'a torch-only loop burns the torch out (it cannot flip faster than once per 2 game ticks)' : 'with no inverter and no delay element the loop settles instead of oscillating')}`,
        c.join(' → '))
    }
    if (cycles.some((c) => c.every((id) => this.byPos.get(id)?.kind !== 'torch' && !['repeater', 'comparator'].includes(this.byPos.get(id)?.kind)))) {
      add('low', 'torchless_loop', this.byPos.get(cycles[0][0]) || null,
        'a feedback loop with neither an inverter nor a delay cannot oscillate in Java: dust alone always resolves to a single stable value', 'dust-only cycle')
    }

    // Vertical dust stack: a column never conducts.
    for (const node of this.nodes) {
      if (node.kind !== 'dust') continue
      const below = this.nodeAt(node.x, node.y - 1, node.z)
      if (below && below.kind === 'dust') {
        add('info', 'vertical_dust_stack', node, 'dust stacked vertically: a straight column does NOT conduct; use a stair step (side=up) on a solid block', 'dust directly beneath')
      }
    }
    return findings
  }

  /**
   * Discrete game-tick simulation over the modelled components.
   *
   * Timing follows Java Edition: a repeater's `delay` property is in REDSTONE
   * ticks (2 game ticks each), a torch/observer/comparator flips in 1 redstone
   * tick, and every change is applied *after* the current tick is observed, so
   * frame 0 is the world as inspected.
   *
   * @param {{ticks?:number, inputs?:object, changes?:string[], pulseTicks?:object}} opts
   *        inputs: nodeId → boolean (interactive sources only)
   *        changes: ids/positions of blocks whose state changed this tick (observers pulse)
   *        pulseTicks: nodeId → number (drive an input for N ticks, then release)
   * @returns {{frames:Array, outputs:Array, oscillating:boolean, period:number|null, notes:string[]}}
   */
  run ({ ticks = 40, inputs = null, changes = [], pulseTicks = null } = {}) {
    const frames = []
    const notes = []
    /**
     * Block power inside `run()`. A block is STRONGLY powered by a device's front
     * face, a torch beneath it, an attached switch, or an adjacent redstone block;
     * it is WEAKLY powered by dust on top of it or dust pointing into it.
     */
    const blockPowerSim = (x, y, z, st) => {
      if (!this.isConductive(x, y, z)) return null
      const at = { x, y, z }
      let strong = 0; let weak = 0; let known = false
      for (const nb of this.around(at)) {
        const other = nb.node
        if (!other) continue
        if (other.kind === 'dust') {
          const v = st.dustLevel.get(other.id) || 0
          const own = nb.dir === 'up' ? 'up' : OPP[nb.dir]
          const conn = other.state?.[own]
          const pointsIn = nb.dir === 'up' || conn === 'side' || conn === 'up' || conn === undefined
          if (pointsIn) { known = true; weak = Math.max(weak, v) }
          continue
        }
        if (other.kind === 'repeater' || other.kind === 'comparator') {
          const s2 = other.state || {}
          if (s2.facing && s2.facing === nb.dir) {
            known = true
            strong = Math.max(strong, st.repeaterLevel.get(other.id) || st.comparatorLevel.get(other.id) || 0)
          }
          continue
        }
        if (other.kind === 'torch') {
          if (nb.dir === 'down' && st.torchLit.get(other.id)) { known = true; strong = Math.max(strong, 15) }
          continue
        }
        if (other.kind === 'observer') {
          const s2 = other.state || {}
          if (s2.facing && s2.facing === nb.dir && (observerPulse.get(other.id) || 0) > 0) { known = true; strong = Math.max(strong, 15) }
          continue
        }
        if (SOURCE_KINDS.has(other.kind)) {
          const on = other.kind === 'redstone_block' ? true : (st.driveState.get(other.id) === true)
          if (on) { known = true; strong = Math.max(strong, 15) }
        }
      }
      if (!known) return null
      return { strong, weak, total: Math.max(strong, weak) }
    }

    const dust = this.nodes.filter((n) => n.kind === 'dust')
    const repeaters = this.nodes.filter((n) => n.kind === 'repeater')
    const comparators = this.nodes.filter((n) => n.kind === 'comparator')
    const observers = this.nodes.filter((n) => n.kind === 'observer')
    const torches = this.nodes.filter((n) => n.kind === 'torch')

    const driveState = new Map()
    for (const s of this.sources()) {
      const v = sourceStrength(s, { inputs })
      driveState.set(s.id, v !== null && v > 0)
    }
    const pulseLeft = new Map()
    if (pulseTicks) for (const [id, n] of Object.entries(pulseTicks)) { driveState.set(id, true); pulseLeft.set(id, Math.max(1, Number(n) || 1)) }
    const changedSet = new Set((changes || []).map((c) => String(c)))

    const torchLit = new Map(torches.map((n) => [n.id, n.state?.lit === true]))
    const repeaterOut = new Map(repeaters.map((r) => [r.id, r.state?.powered === true]))
    const repeaterLevel = new Map(repeaters.map((r) => [r.id, r.state?.powered === true ? 15 : 0]))
    const comparatorOut = new Map(comparators.map((c) => [c.id, c.state?.powered === true]))
    const comparatorLevel = new Map(comparators.map((c) => [c.id, 0]))
    const dustLevel = new Map(dust.map((d) => [d.id, num(d.state?.power, 0) || 0]))
    const observerPulse = new Map(observers.map((o) => [o.id, o.state?.powered === true ? 2 : 0]))
    const observerArmed = new Map(observers.map((o) => [o.id, true]))

    const state = () => ({ dustLevel, repeaterLevel, comparatorLevel, torchLit, driveState })
    const powerOut = (node) => {
      if (!node) return 0
      switch (node.kind) {
        case 'dust': return dustLevel.get(node.id) || 0
        case 'repeater': return repeaterLevel.get(node.id) || 0
        case 'comparator': return comparatorLevel.get(node.id) || 0
        case 'torch': return torchLit.get(node.id) ? 15 : 0
        case 'observer': return (observerPulse.get(node.id) || 0) > 0 ? 15 : 0
        default: return driveState.get(node.id) ? 15 : 0
      }
    }

    // Dust solve for this tick, from the current device outputs and block power.
    const solveDustLevels = () => {
      const next = new Map(dust.map((d) => [d.id, 0]))
      const shadow = new Map()
      for (const d of dust) {
        shadow.set(d.id, { model: 0, known: true, power: 0, observed: num(d.state?.power, null) })
      }
      const seed = (id, v) => { if (!next.has(id)) return; if (v > (next.get(id) || 0)) next.set(id, v) }
      const injectFrom = (node) => {
        const v = powerOut(node)
        if (!v) return
        if (node.kind === 'observer') {
          for (const o of this.outputsOf(node)) if (o.node?.kind === 'dust') seed(o.node.id, 15)
          return
        }
        for (const nb of this.neighbours(node)) {
          if (nb.node.kind !== 'dust') continue
          if (node.kind === 'torch' && nb.dir === 'up') continue
          seed(nb.node.id, v)
        }
      }
      for (const n of this.nodes) {
        if (n.kind === 'dust') continue
        if (n.kind === 'repeater' || n.kind === 'comparator') {
          if (!powerOut(n)) continue
          for (const o of this.outputsOf(n)) if (o.node?.kind === 'dust') seed(o.node.id, powerOut(n))
          continue
        }
        if (n.kind === 'torch' || n.kind === 'observer' || SOURCE_KINDS.has(n.kind)) injectFrom(n)
      }
      // Strongly powered blocks feed dust on top of them and dust pointing out of them.
      for (const d of dust) {
        for (const nb of this.around(d)) {
          const pos = nb.at || (nb.node ? { x: nb.node.x, y: nb.node.y, z: nb.node.z } : null)
          if (!pos) continue
          const side2 = d.state?.[nb.dir]
          const pointsAt = nb.dir === 'down' || side2 === 'side' || side2 === 'up' || side2 === undefined
          if (!pointsAt) continue
          const bp = blockPowerSim(pos.x, pos.y, pos.z, state())
          if (bp && bp.strong > 0) seed(d.id, bp.strong)
        }
      }
      for (let iter = 0; iter < 24; iter++) {
        let changed = false
        for (const d of dust) {
          for (const nb of this.neighbours(d)) {
            if (nb.node.kind !== 'dust') continue
            if (!this.dustStep(nb.node, d)) continue
            const v = Math.max(0, (next.get(nb.node.id) || 0) - 1)
            if (v > (next.get(d.id) || 0)) { next.set(d.id, v); changed = true }
          }
        }
        if (!changed) break
      }
      for (const [k, v] of next) {
        dustLevel.set(k, v)
        if (shadow.has(k)) shadow.get(k).model = v
      }
      return shadow
    }

    const rearLevel = (node) => {
      const s = node.state || {}
      if (!s.facing || !DIRS[s.facing]) return 0
      const v = DIRS[s.facing]
      const rear = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (rear) return powerOut(rear)
      const bp = blockPowerSim(node.x + v.x, node.y, node.z + v.z, state())
      return bp ? bp.total : 0
    }
    const sideLevel = (node, d) => {
      const v = DIRS[d]
      const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (n) return powerOut(n)
      const bp = blockPowerSim(node.x + v.x, node.y, node.z + v.z, state())
      return bp ? bp.total : 0
    }
    const mechanismPower = (m) => {
      let best = 0
      for (const nb of this.around(m)) {
        const o = nb.node
        if (!o) {
          // A solid neighbour can carry weak OR strong power, and either one
          // activates a mechanism. Skipping solids here hid every
          // "lamp on top of a powered block" case.
          if (nb.at && this.isConductive(nb.at.x, nb.at.y, nb.at.z)) {
            const bp = blockPowerSim(nb.at.x, nb.at.y, nb.at.z, state())
            if (bp) best = Math.max(best, bp.total)
          }
          continue
        }
        if (o.kind === 'observer') {
          const s = o.state || {}
          // nb.dir points from the mechanism TOWARD the observer, so the
          // observer feeds this cell exactly when nb.dir === its facing.
          if (s.facing && s.facing === nb.dir && (observerPulse.get(o.id) || 0) > 0) best = Math.max(best, 15)
          continue
        }
        if (o.kind === 'dust') {
          const pointsIn = nb.dir === 'down' || o.state?.[OPP[nb.dir]] === 'side' || o.state?.[OPP[nb.dir]] === 'up'
          if (pointsIn) best = Math.max(best, dustLevel.get(o.id) || 0)
          continue
        }
        if (o.kind === 'repeater' || o.kind === 'comparator') {
          const s = o.state || {}
          if (s.facing && s.facing === nb.dir) best = Math.max(best, powerOut(o))
          continue
        }
        if (o.kind === 'torch') { if (nb.dir !== 'up' && torchLit.get(o.id)) best = Math.max(best, 15); continue }
        const bp = blockPowerSim(o.x, o.y, o.z, state())
        if (bp) best = Math.max(best, bp.total)
      }
      if (m.kind === 'piston' || m.kind === 'sticky_piston') {
        const bp = blockPowerSim(m.x, m.y + 1, m.z, state())
        if (bp && bp.strong > 0) best = Math.max(best, bp.strong)
      }
      return best
    }

    const pending = [] // { at, apply }
    const schedule = (at, apply) => pending.push({ at, apply })

    for (let t = 0; t < ticks; t++) {
      // 1. Observers: a state change in the watched block starts a 2-game-tick
      //    pulse; otherwise the pulse counts down.
      for (const o of observers) {
        const s = o.state || {}
        const v = AXIS_VEC[s.facing] || DIRS[s.facing]
        const watched = v ? key(o.x + v.x, o.y + v.y, o.z + v.z) : null
        const triggered = changedSet.has(o.id) || (watched != null && changedSet.has(watched)) || (observerArmed.get(o.id) === false && (observerPulse.get(o.id) || 0) === 0 && o.state?.powered === true)
        if (triggered) {
          observerPulse.set(o.id, 2)
          observerArmed.set(o.id, false)
        } else if ((observerPulse.get(o.id) || 0) > 0) {
          observerPulse.set(o.id, (observerPulse.get(o.id) || 0) - 1)
        } else {
          observerArmed.set(o.id, true)
        }
      }
      changedSet.clear() // an external change is delivered for exactly one tick
      // 2. Torches: lit when their attachment block is not powered. This runs
      //    BEFORE the dust solve so a device that switched on because of the
      //    *previous* tick's wire state takes its 2-tick delay, and a NOT gate
      //    cannot latch itself on.
      for (const n of torches) {
        let supportStrong = 0
        let supportKnown = false
        const ins = this.inputsOf(n)
        for (const inp of ins) {
          if (inp.node) {
            if (inp.node.id === n.id) continue
            const p = powerOut(inp.node)
            if (inp.node.kind === 'dust') {
              // A wire the torch itself FEEDS must not switch it off — that is
              // the loop that makes a NOT gate blink. Only the attachment block
              // counts, and that is handled by the `inp.solid` branch below.
              continue
            }
            supportKnown = true
            supportStrong = Math.max(supportStrong, p)
          }
          if (inp.solid) {
            // A torch is switched off by STRONG power in the block it hangs on,
            // and also by WEAK power: a dust line pointing into its support is
            // the canonical NOT gate, so `total` (not just `strong`) matters.
            const bp = blockPowerSim(n.x + (DIRS[inp.dir]?.x || 0), n.y + (AXIS_VEC[inp.dir]?.y || 0), n.z + (DIRS[inp.dir]?.z || 0), state())
            if (bp) { supportKnown = true; supportStrong = Math.max(supportStrong, bp.total) }
          }
        }
        // NB: dust that a torch FEEDS never switches that torch off (that would
        // make every NOT gate self-oscillate). Only its attachment block does.
        const want = supportStrong === 0
        const cur = torchLit.get(n.id)
        if (cur !== want) schedule(t + 2, () => torchLit.set(n.id, want))
      }
      // 3. Solve dust for this tick (from the device outputs decided above).
      solveDustLevels()
      // 4. Repeaters: state.delay is in redstone ticks.
      for (const r of repeaters) {
        const s = r.state || {}
        if (s.locked === true) continue
        const want = rearLevel(r) > 0
        if (want !== repeaterOut.get(r.id)) {
          const gameTicks = Math.max(2, Math.min(8, (num(s.delay, 1) || 1) * 2))
          schedule(t + gameTicks, () => { repeaterOut.set(r.id, want); repeaterLevel.set(r.id, want ? 15 : 0) })
        }
      }
      // 5. Comparators: analog compare/subtract, 2 game ticks.
      for (const c of comparators) {
        const s = c.state || {}
        const rear = rearLevel(c)
        let side = 0
        for (const d of HORIZ) {
          if (d === s.facing || d === OPP[s.facing]) continue
          side = Math.max(side, sideLevel(c, d))
        }
        const mode = s.mode === 'subtract' ? 'subtract' : 'compare'
        const out = mode === 'subtract' ? Math.max(0, rear - side) : (side > rear ? 0 : rear)
        if (out !== (comparatorLevel.get(c.id) || 0)) {
          schedule(t + 2, () => { comparatorLevel.set(c.id, out); comparatorOut.set(c.id, out > 0) })
        }
      }
      // 6. Apply everything due at or before this tick (after it was observed).
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].at <= t) { const q = pending[i]; pending.splice(i, 1); q.apply() }
      }
      // 7. Drive pulses.
      for (const [id, left] of [...pulseLeft]) {
        if (left <= 1) { pulseLeft.delete(id); driveState.set(id, false) } else pulseLeft.set(id, left - 1)
      }
      const outputs = this.mechanisms().map((m) => ({ at: m.id, kind: m.kind, active: mechanismPower(m) > 0 }))
      frames.push({
        tick: t,
        dust: Object.fromEntries(dustLevel),
        torches: Object.fromEntries(torchLit),
        repeaters: Object.fromEntries(repeaterOut),
        comparators: Object.fromEntries(comparatorLevel),
        observers: Object.fromEntries(observerPulse),
        outputs
      })
    }
    // Oscillation detection on mechanism outputs.
    let oscillating = false
    let period = null
    const outs = this.mechanisms()
    const seriesOf = (id) => frames.map((f) => { const o = f.outputs.find((x) => x.at === id); return o && o.active ? 1 : 0 })
    const watchList = outs.length ? outs.map((m) => m.id) : torches.map((n) => n.id)
    for (const id of watchList) {
      const series = outs.length ? seriesOf(id) : frames.map((f) => (f.torches[id] ? 1 : 0))
      for (let p = 2; p <= Math.min(24, Math.floor(series.length / 2)); p++) {
        let same = true
        for (let i = p; i < series.length; i++) if (series[i] !== series[i - p]) { same = false; break }
        if (same && series.some((v, i) => i > 0 && v !== series[i - 1])) { oscillating = true; period = p; break }
      }
      if (oscillating) break
    }
    if (oscillating) notes.push(`output changes periodically with a modelled period of ${period} game tick(s) — this is a clock/oscillator in the model, not a server measurement`)
    if (!this.sources().length && !observers.length) notes.push('no sources in this region: the circuit cannot be driven without adding one')
    if (observers.length) notes.push('observer pulses need `changes` (or an observed powered state) — a static snapshot cannot show what an observer will watch next')
    return { frames, outputs: frames[frames.length - 1]?.outputs || [], oscillating, period, notes }
  }

  _simPowerOf (node, st, fallback = undefined) {
    if (!node) return 0
    if (node.kind === 'dust') return st.dustLevel?.get(node.id) || 0
    if (node.kind === 'repeater') return st.repeaterLevel?.get(node.id) || 0
    if (node.kind === 'comparator') return st.comparatorLevel?.get(node.id) || 0
    if (node.kind === 'torch') return st.torchLit?.get(node.id) ? 15 : 0
    if (node.kind === 'observer') return (st.observerPulse?.get(node.id) || 0) > 0 ? 15 : 0
    if (SOURCE_KINDS.has(node.kind)) return st.driveState?.get(node.id) ? 15 : 0
    return 0
  }

  /** Signal trace from a source to every reachable component. */
  traceFrom (nodeId, { maxDepth = MAX_TRACE } = {}) {
    const start = this.byPos.get(nodeId)
    if (!start) return { ok: false, msg: `no component at ${nodeId}` }
    const adj = new Map()
    for (const e of this.edges) {
      if (!adj.has(e.from)) adj.set(e.from, [])
      adj.get(e.from).push(e)
    }
    const out = []
    const seen = new Set([nodeId])
    const queue = [{ id: nodeId, depth: 0, path: [nodeId] }]
    while (queue.length) {
      const cur = queue.shift()
      if (cur.depth >= maxDepth) continue
      for (const e of adj.get(cur.id) || []) {
        if (seen.has(e.to)) { out.push({ ...e, note: 'already reached (loop or reconvergence)' }); continue }
        seen.add(e.to)
        out.push({ ...e, depth: cur.depth + 1 })
        queue.push({ id: e.to, depth: cur.depth + 1, path: [...cur.path, e.to] })
      }
    }
    return { ok: true, start: nodeId, edges: out, reached: [...seen].length - 1 }
  }
}

// ---------------------------------------------------------------------------
// 4. Design catalogue: logic, timing, sequencing, item handling
// ---------------------------------------------------------------------------

const PALETTE_NOTE = 'layer rows are z-rows, columns are x; y grows upward ("." = air)'

/**
 * Designs are deliberately small and explicit: each block carries the exact
 * Java state needed, so placement can set orientation rather than guessing.
 * `verified:false` means "designed from known mechanics, not yet confirmed in
 * this world" — only functionalTest() may flip it.
 */
/**
 * Buildable catalogue.
 *
 * Every design is written the way it is built: `y = 0` is the ground course
 * (solid filler the builder must provide), the redstone sits ON it at y = 1.
 * `blocks` lists only cells the builder places; `support: true` marks filler
 * that must be solid. `checkDesign()` verifies support and physics.
 *
 * Java conventions used throughout:
 *  - repeater/comparator `facing` = REAR (input) side; output is opposite().
 *  - observer `facing` = the watched side; the pulse leaves the back.
 *  - redstone_wall_torch `facing` = away from the wall, so its attachment
 *    block is pos + opposite(facing).
 *  - dust weakly powers the block it sits on and the block it points into;
 *    that is enough to extinguish a torch attached to that block (the
 *    canonical NOT gate), but not enough to feed a fresh dust run.
 */
'use strict'

const DIRS4 = HORIZ
const OPPOSITE = OPP

/** A dust cell that connects only in the listed directions. */
const dust = (connections, power = 0) => {
  const s = {}
  for (const d of DIRS4) s[d] = connections.includes(d) ? 'side' : 'none'
  s.power = String(power)
  return s
}

/** Solid floor cells for a w×d footprint (every design needs a floor). */
const floorOf = (w, d, dz0 = 0) => {
  const out = []
  for (let x = 0; x < w; x++) for (let z = dz0; z < d; z++) out.push({ dx: x, dy: 0, dz: z, name: 'stone', support: true })
  return out
}

const DESIGNS = {
  // ------------------------------------------------------------------ logic
  not_gate: {
    name: 'not_gate',
    title: 'NOT gate (torch inverter)',
    logic: 'out = ¬A',
    footprint: { w: 2, h: 3, d: 3 },
    delayTicks: 2,
    complexity: 1,
    reliability: 'high — one torch, no timing race',
    why: 'The lever powers the dust line; that line points INTO the inverting block and weakly powers it; the torch standing on that block goes out. The lamp beside the torch is therefore lit exactly while A is off. The 2-game-tick torch delay is the only timing involved.',
    blocks: [
      ...floorOf(2, 4),
      { dx: 0, dy: 1, dz: 0, name: 'stone', support: true, note: 'lever support (the lever on top strongly powers it)' },
      { dx: 0, dy: 2, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input A' },
      { dx: 0, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south'], 0), note: 'runs south, into the inverting block' },
      { dx: 0, dy: 1, dz: 2, name: 'stone', support: true, note: 'inverting block (weakly powered by the wire)' },
      { dx: 0, dy: 2, dz: 2, name: 'redstone_torch', state: { lit: true }, note: 'lit = ¬A' },
      { dx: 1, dy: 2, dz: 2, name: 'redstone_lamp', note: 'output: lit when A is OFF' }
    ],
    inputs: [{ dx: 0, dy: 2, dz: 0 }],
    outputs: [{ dx: 1, dy: 2, dz: 2 }]
  },

  or_gate: {
    name: 'or_gate',
    title: 'OR gate (either input powers one dust line)',
    logic: 'out = A ∨ B',
    footprint: { w: 5, h: 2, d: 2 },
    delayTicks: 0,
    complexity: 1,
    reliability: 'high — plain dust, no devices',
    why: 'Two levers feed one continuous dust line; either lever raises the line to 15.',
    blocks: [
      ...floorOf(5, 1),
      ...[[0, -1], [1, -1], [2, -1]].map(([x, z]) => ({ dx: x, dy: 0, dz: z, name: 'stone', support: true })),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east', 'north'], 0), note: 'shared line' },
      { dx: 3, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 4, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input B' },
      { dx: 2, dy: 1, dz: -1, name: 'redstone_lamp', note: 'output' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }, { dx: 4, dy: 1, dz: 0 }],
    outputs: [{ dx: 2, dy: 1, dz: -1 }]
  },

  /**
   * The canonical torch AND: each input extinguishes its own torch, the two
   * torch outputs share one dust line (OR of the inversions), and a third
   * torch on that line's support block inverts the result.
   *
   *   z=0 : L D B T B D L     inputs → their support blocks (torches on top)
   *   z=1 : . D D D D D .     the OR line, one block in front
   *   z=2 : . . B T L . .     support + final inverter + lamp beside it
   */
  and_gate: {
    name: 'and_gate',
    title: 'AND gate (¬(¬A ∨ ¬B)) — two input inverters, one output inverter',
    logic: 'out = A ∧ B',
    footprint: { w: 4, h: 2, d: 6 },
    delayTicks: 4,
    complexity: 3,
    reliability: 'high — torch inversion only, no timing dependence',
    why: 'Each lever stands on its own block beside an inverter torch, so it strongly powers that inverter block and puts the torch out: T_A = ¬A, T_B = ¬B. Both torches light one straight dust line (¬A ∨ ¬B). That line points EAST into the final inverter block, so the final torch is lit exactly while the line is cold: ¬(¬A ∨ ¬B) = A ∧ B. The lamp beside the final torch is the output.',
    blocks: [
      ...floorOf(4, 6),
      // input A + inverter A
      { dx: 0, dy: 1, dz: 0, name: 'stone', support: true, note: 'lever support' },
      { dx: 0, dy: 2, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wall_torch', state: { facing: 'east', lit: true }, note: 'T_A = ¬A, hung on the lever block' },
      // the OR line
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 1, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'south', 'east'], 0), note: 'points east into the final inverter block' },
      { dx: 1, dy: 1, dz: 3, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      // input B + inverter B
      { dx: 0, dy: 1, dz: 4, name: 'stone', support: true, note: 'lever support' },
      { dx: 0, dy: 2, dz: 4, name: 'lever', state: { face: 'floor', facing: 'north', powered: false }, note: 'input B' },
      { dx: 1, dy: 1, dz: 4, name: 'redstone_wall_torch', state: { facing: 'east', lit: true }, note: 'T_B = ¬B' },
      // final inverter + output
      { dx: 2, dy: 1, dz: 2, name: 'stone', support: true, note: 'final inverter block' },
      { dx: 2, dy: 2, dz: 2, name: 'redstone_torch', state: { lit: true }, note: '¬(¬A ∨ ¬B) = A ∧ B' },
      { dx: 3, dy: 2, dz: 2, name: 'redstone_lamp', note: 'output: lit only when both inputs are on' }
    ],
    inputs: [{ dx: 0, dy: 2, dz: 0 }, { dx: 0, dy: 2, dz: 4 }],
    outputs: [{ dx: 3, dy: 2, dz: 2 }]
  },

  nand_gate: {
    name: 'nand_gate',
    title: 'NAND gate (lamp on the ¬A ∨ ¬B line)',
    logic: 'out = ¬(A ∧ B)',
    footprint: { w: 3, h: 2, d: 6 },
    delayTicks: 2,
    complexity: 2,
    reliability: 'high',
    why: 'By De Morgan ¬A ∨ ¬B is exactly ¬(A ∧ B), so the intermediate line of the AND gate IS the NAND output. T_A = ¬A and T_B = ¬B each light the shared line while their own input is off; the lamp beside the line is therefore on unless both inputs are on. No final inverter is needed.',
    blocks: [
      ...floorOf(4, 6),
      { dx: 0, dy: 1, dz: 0, name: 'stone', support: true },
      { dx: 0, dy: 2, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wall_torch', state: { facing: 'east', lit: true }, note: 'T_A = ¬A' },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 1, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'south', 'east'], 0), note: 'points east into the final inverter block' },
      { dx: 1, dy: 1, dz: 3, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 1, dz: 4, name: 'stone', support: true },
      { dx: 0, dy: 2, dz: 4, name: 'lever', state: { face: 'floor', facing: 'north', powered: false }, note: 'input B' },
      { dx: 1, dy: 1, dz: 4, name: 'redstone_wall_torch', state: { facing: 'east', lit: true }, note: 'T_B = ¬B' },
      { dx: 2, dy: 1, dz: 2, name: 'redstone_lamp', note: 'output: the line itself is ¬(A ∧ B), so the lamp reads NAND' }
    ],
    inputs: [{ dx: 0, dy: 2, dz: 0 }, { dx: 0, dy: 2, dz: 4 }],
    outputs: [{ dx: 2, dy: 1, dz: 2 }]
  },

  xor_gate: {
    name: 'xor_gate',
    title: 'XOR gate (from OR, AND and NOT)',
    logic: 'out = (A ∨ B) ∧ ¬(A ∧ B)',
    footprint: { w: 9, h: 3, d: 6 },
    delayTicks: 6,
    complexity: 8,
    reliability: 'medium — three sub-gates wired together; verify before trusting it',
    why: 'Built compositionally, not from a picture: an OR line, an AND line, and then an AND of the OR with the inverse of the AND. That is exactly XOR for two inputs.',
    blocks: [
      ...floorOf(9, 6),
      // ---- inputs fan out to OR (z=1) and to AND (z=0)
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east', 'south'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'stone', support: true, note: 'A support' },
      { dx: 2, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬A' },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south', 'east'], 0), note: 'A toward the OR line' },
      { dx: 8, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'west', powered: false }, note: 'B' },
      { dx: 7, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east', 'south'], 0) },
      { dx: 6, dy: 1, dz: 0, name: 'stone', support: true, note: 'B support' },
      { dx: 6, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬B' },
      { dx: 7, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south', 'west'], 0), note: 'B toward the OR line' },
      // ---- OR line (z=1)
      { dx: 3, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 4, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 5, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      // ---- AND of the two inversions (z=2), then invert it
      { dx: 2, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 4, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 5, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 6, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['west', 'north'], 0) },
      { dx: 4, dy: 1, dz: 3, name: 'stone', support: true, note: 'AND output support' },
      { dx: 4, dy: 2, dz: 3, name: 'redstone_torch', state: { lit: false }, note: 'A ∧ B' },
      { dx: 5, dy: 1, dz: 3, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 6, dy: 1, dz: 3, name: 'stone', support: true },
      { dx: 6, dy: 2, dz: 3, name: 'redstone_torch', state: { lit: true }, note: '¬(A ∧ B)' },
      // ---- final AND: (A ∨ B) ∧ ¬(A ∧ B)
      { dx: 4, dy: 1, dz: 4, name: 'stone', support: true, note: 'final support' },
      { dx: 4, dy: 2, dz: 4, name: 'redstone_torch', state: { lit: false }, note: 'XOR' },
      { dx: 5, dy: 1, dz: 4, name: 'redstone_lamp', note: 'output: exactly one input on' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }, { dx: 8, dy: 1, dz: 0 }],
    outputs: [{ dx: 5, dy: 1, dz: 4 }]
  },

  // ---------------------------------------------------------------- memory
  /**
   * RS-NOR latch, derived rather than copied.
   *
   * Two torch inverters face each other's support block:
   *   B1 at (0,1,1) — T1 is a wall torch on B1's east face at (1,1,1).
   *   B2 at (2,1,1) — T2 is a wall torch on B2's west face at (1,1,1)??  no:
   * the two torches may not share a cell, so B2 sits one row back and the
   * feedback dust runs around: T1 -> dust (2,1,0) pointing north into B2 at
   * (2,1,-1); T2 (1,1,-1) -> dust (0,1,-1) pointing south into B1.
   * Setting powers B2 (extinguishes T2), which releases B1 and lets T1 light.
   */
  rs_latch: {
    name: 'rs_latch',
    title: 'RS-NOR latch (two cross-coupled torch inverters)',
    logic: 'Q holds its state: S sets it, R resets it, both at once is forbidden',
    footprint: { w: 5, h: 2, d: 4 },
    delayTicks: 2,
    complexity: 5,
    reliability: 'high — the classic two-torch latch; never drive S and R together',
    why: 'Each torch hangs on a block that the OTHER torch\'s output dust points into, so whichever torch is lit keeps the other dark. A set pulse powers B2, T2 goes out, B1 is released, T1 lights and stays lit after the pulse ends — memory without any repeater.',
    blocks: [
      ...floorOf(5, 4, -1),
      { dx: 0, dy: 1, dz: 1, name: 'stone', support: true, note: 'B1: the Q-side support block' },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wall_torch', state: { facing: 'east', lit: true }, note: 'T1, hanging on B1 — its light is Q' },
      { dx: 2, dy: 1, dz: -1, name: 'stone', support: true, note: 'B2: the latch\'s other support block' },
      { dx: 1, dy: 1, dz: -1, name: 'redstone_wall_torch', state: { facing: 'west', lit: false }, note: 'T2, hanging on B2' },
      // feedback: T1 -> B2, T2 -> B1
      { dx: 2, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0), note: 'T1 output; points north into B2' },
      { dx: 0, dy: 1, dz: -1, name: 'redstone_wire', state: dust(['east', 'south'], 0), note: 'T2 output; points south into B1' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['east', 'west'], 0), note: 'joins the two feedback cells visually only' },
      // Q read-out: the block directly above T1 is strongly powered by it
      { dx: 1, dy: 2, dz: 1, name: 'redstone_lamp', note: 'Q: lit while T1 is lit' },
      // S (set) powers B2 from the east, R (reset) powers B1 from the south
      { dx: 3, dy: 1, dz: -1, name: 'redstone_wire', state: dust(['west', 'east'], 0), note: 'S points west into B2' },
      { dx: 4, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'west', powered: false }, note: 'S (set)' },
      { dx: 0, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'south'], 0), note: 'R points north into B1' },
      { dx: 0, dy: 1, dz: 3, name: 'lever', state: { face: 'floor', facing: 'north', powered: false }, note: 'R (reset)' }
    ],
    inputs: [{ dx: 4, dy: 1, dz: -1 }, { dx: 0, dy: 1, dz: 3 }],
    outputs: [{ dx: 1, dy: 2, dz: 1 }]
  },

  // ---------------------------------------------------------------- timing
  clock_1hz: {
    name: 'clock_1hz',
    title: 'Clock (three repeaters in a loop)',
    logic: 'the output blinks for as long as the switch is on',
    footprint: { w: 4, h: 2, d: 4 },
    delayTicks: 12,
    complexity: 3,
    reliability: 'high — repeaters cannot burn out; keep it slow to avoid lag',
    why: 'A repeater loop with an odd number of inverters never settles. Each repeater adds delay×2 game ticks to the period; with three delay-2 repeaters the period is 12 game ticks.',
    blocks: [
      ...floorOf(4, 2),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'switch (on = running)' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'repeater', state: { facing: 'west', delay: '2', powered: false }, note: 'west→east' },
      { dx: 3, dy: 1, dz: 0, name: 'repeater', state: { facing: 'north', delay: '2', powered: false }, note: 'north→south' },
      { dx: 3, dy: 1, dz: 1, name: 'repeater', state: { facing: 'east', delay: '2', powered: false }, note: 'east→west' },
      { dx: 2, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wall_torch', state: { facing: 'south', lit: true }, note: 'the single inverter that makes the loop oscillate' },
      { dx: 1, dy: 2, dz: 1, name: 'redstone_lamp', note: 'output: blinks' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }],
    outputs: [{ dx: 1, dy: 2, dz: 1 }]
  },

  delay_line: {
    name: 'delay_line',
    title: 'Delay line (lever → delay-4 repeater → output)',
    logic: 'out follows the lever 8 game ticks later',
    footprint: { w: 1, h: 2, d: 4 },
    delayTicks: 8,
    complexity: 1,
    reliability: 'high',
    why: 'A repeater\'s delay property is in redstone ticks (2 game ticks each), so delay=4 is 8 game ticks.',
    blocks: [
      ...floorOf(1, 4),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input' },
      { dx: 0, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 1, dz: 2, name: 'repeater', state: { facing: 'north', delay: '4', powered: false } },
      { dx: 0, dy: 1, dz: 3, name: 'redstone_lamp', note: 'output' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }],
    outputs: [{ dx: 0, dy: 1, dz: 3 }]
  },

  // --------------------------------------------------------------- pistons
  piston_door_2x2: {
    name: 'piston_door_2x2',
    title: '2×2 piston door (four sticky pistons, two per side)',
    logic: 'all four pistons extend on one signal; the door closes when it is released',
    footprint: { w: 7, h: 3, d: 3 },
    delayTicks: 2,
    complexity: 7,
    reliability: 'medium — both pairs must fire on the same tick or the door jams half-open',
    why: 'The four door blocks are pushed apart by two pairs of sticky pistons facing each other. Both pairs share one dust line, so a single lever moves all four on the same tick; releasing it retracts them together and the sticky heads pull the door blocks back.',
    blocks: [
      ...floorOf(7, 3),
      // door frame the pistons push into
      { dx: 0, dy: 1, dz: 1, name: 'stone', support: true }, { dx: 0, dy: 2, dz: 1, name: 'stone', support: true },
      { dx: 6, dy: 1, dz: 1, name: 'stone', support: true }, { dx: 6, dy: 2, dz: 1, name: 'stone', support: true },
      // the four moving door blocks
      { dx: 2, dy: 1, dz: 1, name: 'stone', support: true }, { dx: 3, dy: 1, dz: 1, name: 'stone', support: true },
      { dx: 2, dy: 2, dz: 1, name: 'stone', support: true }, { dx: 3, dy: 2, dz: 1, name: 'stone', support: true },
      // the pistons
      { dx: 1, dy: 1, dz: 1, name: 'sticky_piston', state: { facing: 'east', extended: false } },
      { dx: 4, dy: 1, dz: 1, name: 'sticky_piston', state: { facing: 'west', extended: false } },
      { dx: 1, dy: 2, dz: 1, name: 'sticky_piston', state: { facing: 'east', extended: false } },
      { dx: 4, dy: 2, dz: 1, name: 'sticky_piston', state: { facing: 'west', extended: false } },
      // one shared line behind the door, both piston columns on it
      { dx: 1, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 2, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 4, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 0, dy: 1, dz: 2, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'door switch' }
    ],
    caveat: 'The four door blocks are only movable while nothing is attached to them; place the frame, the pistons and the dust before sealing the door blocks in.',
    inputs: [{ dx: 0, dy: 1, dz: 2 }],
    outputs: [{ dx: 1, dy: 1, dz: 1 }, { dx: 4, dy: 1, dz: 1 }],
    unverified: 'the model can predict the wiring, but moving blocks needs a live server to confirm'
  },

  hidden_door: {
    name: 'hidden_door',
    title: 'Hidden flush door (one sticky piston behind a wall block)',
    logic: 'the front block is pulled aside to reveal a passage',
    footprint: { w: 3, h: 3, d: 5 },
    delayTicks: 2,
    complexity: 5,
    reliability: 'medium — the front block must be movable',
    why: 'A sticky piston retracts and drags the flush wall block with it, leaving the passage open; no dust is visible from the front.',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'stone', support: true }, { dx: 1, dy: 0, dz: 0, name: 'stone', support: true }, { dx: 2, dy: 0, dz: 0, name: 'stone', support: true },
      { dx: 0, dy: 0, dz: 1, name: 'stone', support: true }, { dx: 1, dy: 0, dz: 1, name: 'stone', support: true }, { dx: 2, dy: 0, dz: 1, name: 'stone', support: true },
      { dx: 0, dy: 0, dz: -1, name: 'stone', support: true }, { dx: 1, dy: 0, dz: -1, name: 'stone', support: true }, { dx: 2, dy: 0, dz: -1, name: 'stone', support: true },
      { dx: 0, dy: 0, dz: -2, name: 'stone', support: true }, { dx: 1, dy: 0, dz: -2, name: 'stone', support: true }, { dx: 2, dy: 0, dz: -2, name: 'stone', support: true },
      { dx: 1, dy: 1, dz: 0, name: 'stone', support: true, note: 'the flush front panel (movable)' },
      { dx: 0, dy: 1, dz: 0, name: 'stone', support: true }, { dx: 2, dy: 1, dz: 0, name: 'stone', support: true },
      { dx: 1, dy: 1, dz: -1, name: 'sticky_piston', state: { facing: 'north', extended: false }, note: 'pulls the panel north' },
      { dx: 1, dy: 1, dz: -2, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 0, dz: -3, name: 'stone', support: true }, { dx: 1, dy: 0, dz: -3, name: 'stone', support: true }, { dx: 2, dy: 0, dz: -3, name: 'stone', support: true },
      { dx: 1, dy: 1, dz: -3, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'hidden switch' }
    ],
    inputs: [{ dx: 1, dy: 1, dz: -3 }],
    outputs: [{ dx: 1, dy: 1, dz: -1 }],
    unverified: 'needs a live server to confirm the block actually moves'
  },

  // ------------------------------------------------------------- automation
  state_detector: {
    name: 'state_detector',
    title: 'State detector (observer watching a block)',
    logic: 'pulses 2 game ticks whenever the watched block changes',
    footprint: { w: 1, h: 2, d: 3 },
    delayTicks: 1,
    complexity: 1,
    reliability: 'high',
    why: 'The observer watches the block at its `facing` side and emits its pulse at the back; the pulse is exactly 2 game ticks wide.',
    blocks: [
      ...floorOf(1, 3),
      { dx: 0, dy: 1, dz: 0, name: 'chest', note: 'the watched block' },
      { dx: 0, dy: 1, dz: 1, name: 'observer', state: { facing: 'north', powered: false }, note: 'faces the chest; the pulse leaves at the back (south)' },
      { dx: 0, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 2, dz: 2, name: 'redstone_lamp', note: 'output' }
    ],
    inputs: [],
    outputs: [{ dx: 0, dy: 2, dz: 2 }],
    unverified: 'the pulse itself is a model prediction; a static snapshot cannot show what changes next'
  },

  item_sorter: {
    name: 'item_sorter',
    title: 'Item sorter channel (hopper + comparator + lock repeater)',
    logic: 'the comparator reads the sorter hopper; its signal locks the outgoing hopper',
    footprint: { w: 5, h: 2, d: 2 },
    delayTicks: 2,
    complexity: 5,
    reliability: 'medium — filter layout and comparator thresholds must be built by hand',
    why: 'A comparator reads the hopper behind it and outputs a strength proportional to the filter contents; a repeater carries that signal to the outgoing hopper so it stays locked until the filter is exceeded. Only the redstone part is claimed here.',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'stone', support: true },
      { dx: 2, dy: 0, dz: 0, name: 'stone', support: true }, { dx: 3, dy: 0, dz: 0, name: 'stone', support: true },
      { dx: 0, dy: 1, dz: 0, name: 'hopper', state: { facing: 'east', enabled: true }, note: 'input line' },
      { dx: 1, dy: 1, dz: 0, name: 'hopper', state: { facing: 'down', enabled: true }, note: 'sorter hopper (41-item filter goes here)' },
      { dx: 2, dy: 1, dz: 0, name: 'comparator', state: { facing: 'west', mode: 'compare', powered: false }, note: 'reads the sorter hopper at its rear' },
      { dx: 3, dy: 1, dz: 0, name: 'repeater', state: { facing: 'west', delay: '1', powered: false }, note: 'carries the signal back' },
      { dx: 4, dy: 1, dz: 0, name: 'redstone_lamp', note: 'indicator that the filter threshold was crossed' },
      { dx: 1, dy: 0, dz: 0, name: 'chest', support: true }
    ],
    caveat: 'The 41-item filter must be loaded by hand and the outgoing hopper sits below the sorter hopper; the engine reports both requirements instead of pretending it filled the hopper. Item flow is NOT verified by this module.',
    inputs: [],
    outputs: [{ dx: 4, dy: 1, dz: 0 }],
    unverified: 'item flow needs a live server'
  },

  combination_lock: {
    name: 'combination_lock',
    title: '4-lever combination lock (k-input AND of torch inversions)',
    logic: 'out = A ∧ B ∧ C ∧ D — the lamp is lit only while all four levers are on',
    footprint: { w: 11, h: 3, d: 4 },
    delayTicks: 2,
    complexity: 7,
    reliability: 'high — the same rule as the AND gate, generalised to four inputs',
    why: 'Generalisation, not a new template: an AND of k inputs is ¬(¬A ∨ ¬B ∨ …). Each lever powers its own support block and extinguishes that block\'s torch; all four torch outputs share one dust line; the last torch inverts the shared line and lights the lamp. Any single lever left off keeps one torch lit and the line powered, so the lamp stays dark.',
    blocks: [
      ...floorOf(11, 4, -1),
      // four input columns, each with its own dust cell at z=-1 pointing south into its support
      { dx: 0, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'A' },
      { dx: 2, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'B' },
      { dx: 4, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'C' },
      { dx: 6, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'D' },
      { dx: 0, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0), note: 'A into its support' },
      { dx: 2, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 4, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 6, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 1, dy: 1, dz: 0, name: 'stone', support: true, note: 'support A' },
      { dx: 3, dy: 1, dz: 0, name: 'stone', support: true, note: 'support B' },
      { dx: 5, dy: 1, dz: 0, name: 'stone', support: true, note: 'support C' },
      { dx: 7, dy: 1, dz: 0, name: 'redstone_lamp', note: 'placeholder removed below' },
      { dx: 1, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬A' },
      { dx: 3, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬B' },
      { dx: 5, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬C' },
      // the shared OR line reads every torch
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 2, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 4, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 5, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 6, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 7, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['west', 'south'], 0) },
      // final inverter
      { dx: 7, dy: 1, dz: 2, name: 'stone', support: true, note: 'final support' },
      { dx: 7, dy: 2, dz: 2, name: 'redstone_torch', state: { lit: false }, note: '¬(¬A ∨ ¬B ∨ ¬C ∨ ¬D)' },
      { dx: 8, dy: 1, dz: 2, name: 'redstone_lamp', note: 'output: lit only with all four levers on' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: -1 }, { dx: 2, dy: 1, dz: -1 }, { dx: 4, dy: 1, dz: -1 }, { dx: 6, dy: 1, dz: -1 }],
    outputs: [{ dx: 8, dy: 1, dz: 2 }]
  }
}

const DESIGN_ALIASES = {
  and: 'and_gate',
  or: 'or_gate',
  not: 'not_gate',
  nand: 'nand_gate',
  xor: 'xor_gate',
  latch: 'rs_latch',
  memory: 'rs_latch',
  rs: 'rs_latch',
  sr: 'rs_latch',
  clock: 'clock_1hz',
  oscillator: 'clock_1hz',
  pulse: 'delay_line',
  delay: 'delay_line',
  pulse_extender: 'delay_line',
  sorter: 'item_sorter',
  sorting: 'item_sorter',
  storage: 'item_sorter',
  detector: 'state_detector',
  observer: 'state_detector',
  door: 'piston_door_2x2',
  piston_door: 'piston_door_2x2',
  hidden: 'hidden_door',
  flush: 'hidden_door',
  lock: 'combination_lock',
  combination: 'combination_lock',
  code: 'combination_lock'
}

module.exports = { DESIGNS, DESIGN_ALIASES, dust, floorOf }

function resolveDesign (name) {
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, '_')
  if (DESIGNS[n]) return DESIGNS[n]
  const alias = DESIGN_ALIASES[n]
  if (alias && DESIGNS[alias]) return DESIGNS[alias]
  return null
}

/**
 * Compare candidate designs on the axes that matter.
 * @param {string[]} names
 */
function compareDesigns (names) {
  const rows = []
  for (const n of names) {
    const d = resolveDesign(n)
    if (!d) continue
    const blocks = d.blocks || []
    const counts = {}
    for (const b of blocks) counts[b.name] = (counts[b.name] || 0) + 1
    rows.push({
      name: d.name,
      title: d.title,
      logic: d.logic || null,
      footprint: d.footprint,
      volume: d.footprint ? d.footprint.w * d.footprint.h * d.footprint.d : null,
      blocks: blocks.length,
      materials: counts,
      delayTicks: d.delayTicks ?? null,
      complexity: d.complexity ?? null,
      reliability: d.reliability || null,
      caveat: d.caveat || null
    })
  }
  const byFootprint = rows.slice().sort((a, b) => (a.volume || 0) - (b.volume || 0))
  return {
    rows,
    smallest: byFootprint[0]?.name || null,
    lowestDelay: rows.slice().sort((a, b) => (a.delayTicks || 0) - (b.delayTicks || 0))[0]?.name || null,
    simplest: rows.slice().sort((a, b) => (a.complexity || 0) - (b.complexity || 0))[0]?.name || null,
    note: 'ratings are design-time estimates from known Java mechanics; reliability is only confirmed by a live functional test'
  }
}

// ---------------------------------------------------------------------------
// 5. Placement planning: orientation, resources, ownership
// ---------------------------------------------------------------------------

const FACING_TO_STATE = {
  north: { facing: 'north' },
  south: { facing: 'south' },
  east: { facing: 'east' },
  west: { facing: 'west' }
}

/**
 * Turn a design into concrete placements.
 * @param {string|object} design
 * @param {{x:number,y:number,z:number}} origin
 * @param {{rotate?:'north'|'south'|'east'|'west'}} [opts]
 */
function planPlacement (design, origin, { rotate = 'north', includeSupports = true } = {}) {
  const d = typeof design === 'string' ? resolveDesign(design) : design
  if (!d) return { ok: false, msg: 'unknown design' }
  if (!origin || ![origin.x, origin.y, origin.z].every(Number.isSafeInteger)) return { ok: false, msg: 'origin must be integer block coordinates' }
  const rotateCW = { north: 0, east: 1, south: 2, west: 3 }
  const turnDir = (dir, steps) => {
    const order = ['north', 'east', 'south', 'west']
    const i = order.indexOf(dir)
    if (i < 0) return dir
    return order[(i + steps + 4) % 4]
  }
  const steps = rotateCW[rotate] ?? 0
  const placements = []
  const seen = new Set()
  const push = (b) => {
    let dx = b.dx || 0
    let dz = b.dz || 0
    for (let s = 0; s < steps; s++) { const t = dx; dx = -dz; dz = t }
    const state = { ...(b.state || {}) }
    // Direction properties: simple facings rotate; dust connection maps rotate
    // as a whole (north→east etc.), which keeps every connection pointing at
    // its new neighbour instead of at a stale one.
    if (state.facing) state.facing = turnDir(state.facing, steps)
    if (state.mode === undefined && b.name === 'comparator') state.mode = 'compare'
    for (const d4 of HORIZ) {
      if (state[d4] !== undefined && steps) {
        const rotated = {}
        for (const k of HORIZ) rotated[turnDir(k, steps)] = state[k]
        for (const k of HORIZ) state[k] = rotated[k]
        break
      }
    }
    const x = origin.x + dx; const y = origin.y + (b.dy || 0); const z = origin.z + dz
    const id = `${x},${y},${z}`
    if (seen.has(id)) return
    seen.add(id)
    placements.push({
      x, y, z,
      name: b.name,
      state,
      note: b.note || null,
      support: Boolean(b.support),
      order: (b.dy || 0) === 0 ? 0 : 1
    })
  }
  const blocks = (d.blocks || []).slice()
  // Supports first (a lever needs the block under it to exist), then by height.
  blocks.sort((a, b) => {
    const sa = a.support ? 0 : 1; const sb = b.support ? 0 : 1
    if (sa !== sb) return sa - sb
    return (a.dy || 0) - (b.dy || 0)
  })
  if (blocks.filter((b) => b.support).length > 0) {
    // supports are part of the layout, not a side note
  }
  for (const b of blocks) push(b)
  const structural = placements.filter((p) => p.support)
  const parts = placements.filter((p) => !p.support)
  const materials = {}
  for (const p of (includeSupports ? placements : parts)) materials[p.name] = (materials[p.name] || 0) + 1
  return {
    ok: true,
    design: d.name,
    title: d.title,
    logic: d.logic || null,
    why: d.why || null,
    origin,
    rotate,
    placements,
    parts: parts.map((p) => `${p.x},${p.y},${p.z}`),
    supports: structural.map((p) => `${p.x},${p.y},${p.z}`),
    materials,
    footprint: d.footprint,
    delayTicks: d.delayTicks ?? null,
    caveat: d.caveat || null,
    unverified: d.unverified || null,
    note: 'support blocks first, then low to high; direction properties and dust connection maps are rotated together'
  }
}

/**
 * Static sanity check of a catalogue design, before anything is built.
 * Returns the reasons a design cannot work as written (empty = structurally ok).
 */
function checkDesign (design) {
  const d = typeof design === 'string' ? resolveDesign(design) : design
  if (!d) return { ok: false, problems: ['unknown design'] }
  const problems = []
  const at = new Map()
  for (const b of d.blocks || []) {
    const k = `${b.dx || 0},${b.dy || 0},${b.dz || 0}`
    if (at.has(k)) problems.push(`two blocks share the cell ${k}: ${at.get(k).name} and ${b.name}`)
    at.set(k, b)
  }
  const has = (x, y, z) => at.get(`${x},${y},${z}`) || null
  for (const b of d.blocks || []) {
    const x = b.dx || 0; const y = b.dy || 0; const z = b.dz || 0
    if (/button|pressure_plate/.test(b.name)) {
      const below = has(x, y - 1, z)
      if (!below || !below.support) problems.push(`${b.name} at ${x},${y},${z} needs a solid block beneath it`)
    }
    if (b.name === 'redstone_torch') {
      const below = has(x, y - 1, z)
      if (!below) problems.push(`redstone_torch at ${x},${y},${z} stands on air`)
      else if (!below.support) problems.push(`redstone_torch at ${x},${y},${z} stands on ${below.name}, which cannot support it`)
    }
    if (b.name === 'redstone_wall_torch') {
      const f = b.state?.facing
      const v = f && (DIRS[OPP[f]])
      const support = v ? has(x + v.x, y, z + v.z) : null
      if (!support) problems.push(`redstone_wall_torch at ${x},${y},${z} faces ${f} but has no block behind it`)
    }
    if (b.name === 'repeater' || b.name === 'comparator' || b.name === 'redstone_wire' || b.name === 'lever') {
      const below = has(x, y - 1, z)
      if (!below || !below.support) problems.push(`${b.name} at ${x},${y},${z} has no solid block beneath it`)
    }
    if (b.name === 'redstone_lamp') {
      const below = has(x, y - 1, z)
      if (below && below.name === 'redstone_torch') problems.push(`redstone_lamp at ${x},${y},${z} sits on a torch it would displace`)
    }
  }
  return { ok: problems.length === 0, problems, design: d.name }
}

/**
 * Check inventory/materials and ownership before writing anything.
 * @param {object} plan from planPlacement
 * @param {{ inventory?: Record<string,number>, canWrite?: (p:{x,y,z}) => boolean, existing?: (p) => string|null }} env
 */
function preflight (plan, { inventory = {}, canWrite = null, existing = null } = {}) {
  if (!plan || !plan.ok) return { ok: false, msg: 'invalid plan' }
  const missing = []
  const missingMaterials = {}
  for (const [name, need] of Object.entries(plan.materials)) {
    const have = Number(inventory[name] || 0)
    if (have < need) { missingMaterials[name] = need - have }
  }
  for (const [name, short] of Object.entries(missingMaterials)) missing.push(`${name} ×${short}`)
  const blocked = []
  const present = []
  for (const p of plan.placements) {
    if (existing) {
      const cur = existing(p)
      if (cur && cur !== 'air') {
        if (cur === p.name) present.push(`${p.x},${p.y},${p.z}`)
        else blocked.push(`${p.x},${p.y},${p.z} holds ${cur}`)
      }
    }
    if (canWrite && !canWrite(p)) blocked.push(`${p.x},${p.y},${p.z} is not yours to modify`)
  }
  const ok = blocked.length === 0 && missing.length === 0
  return {
    ok,
    missing,
    missingMaterials,
    blocked,
    alreadyPresent: present,
    msg: ok
      ? `ready: ${plan.placements.length} placements, ${Object.keys(plan.materials).length} materials, nothing in the way`
      : `not ready:${missing.length ? ` missing ${missing.join(', ')}` : ''}${blocked.length ? ` blocked at ${blocked.slice(0, 4).join('; ')}` : ''}`
  }
}

/**
 * Execute a plan through the existing BuilderExecutor-shaped interface:
 * anything with `_placeAt(pos, name)` and `_approach(pos, distance)`.
 */
async function placePlan (executor, plan, { canWrite = null, onStep = null } = {}) {
  if (!plan || !plan.ok) return { ok: false, msg: 'invalid plan', placed: 0 }
  let placed = 0
  const failed = []
  const skipped = []
  const { Vec3 } = require('vec3')
  for (const p of plan.placements) {
    if (canWrite && !canWrite(p)) { skipped.push(`${p.x},${p.y},${p.z} (not yours)`); continue }
    const target = new Vec3(p.x, p.y, p.z)
    try {
      const cur = executor.bot?.blockAt?.(target)
      if (cur && cur.name === p.name) { skipped.push(`${p.x},${p.y},${p.z} (already present)`); placed++; continue }
      if (cur && cur.name !== 'air') { skipped.push(`${p.x},${p.y},${p.z} (occupied by ${cur.name})`); continue }
    } catch { /* unloaded: try anyway */ }
    try {
      if (typeof executor._approach === 'function') await executor._approach(target, 3)
      const ok = await executor._placeAt(target, p.name)
      if (ok) { placed++; if (onStep) onStep({ ...p, placed }) } else failed.push(`${p.name}@${p.x},${p.y},${p.z}`)
    } catch (err) {
      failed.push(`${p.name}@${p.x},${p.y},${p.z} (${err.message || err})`)
    }
  }
  return { ok: failed.length === 0, placed, failed, skipped, total: plan.placements.length }
}

// ---------------------------------------------------------------------------
// 6. Live functional verification (the only path to `verified`)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readState (bot, pos) {
  const { Vec3 } = require('vec3')
  let b = null
  try { b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z)) } catch { return null }
  if (!b) return null
  const cls = classify(b.name)
  let raw = null
  try { raw = b.getProperties?.() } catch { raw = null }
  return { name: b.name, kind: cls?.kind || null, state: cls ? normalizeState(cls.kind, raw) : {} }
}

/** An output is "on" when its device state says so, per kind. */
function outputActive (state) {
  if (!state) return null
  const s = state.state || {}
  switch (state.kind) {
    case 'redstone_lamp': return s.lit ?? null
    case 'piston':
    case 'sticky_piston': return s.extended ?? null
    case 'door':
    case 'trapdoor':
    case 'fence_gate': return s.open ?? null
    case 'note_block': return s.powered ?? null
    case 'hopper': return s.enabled === undefined ? null : !s.enabled
    case 'dropper':
    case 'dispenser': return s.triggered ?? null
    default: {
      if (s.powered !== undefined) return s.powered
      if (s.lit !== undefined) return s.lit
      if (s.power !== undefined) return s.power > 0
      return null
    }
  }
}

/**
 * Drive the inputs of a built circuit and observe the outputs.
 *
 * @param {object} bot
 * @param {{
 *   inputs: Array<{x,y,z}>,
 *   outputs: Array<{x,y,z}>,
 *   cycles?: Array<{set: object, expect: Record<string, boolean|number>}>,
 *   settleMs?: number,
 *   clockWatchMs?: number
 * }} spec
 */
async function functionalTest (bot, {
  inputs = [],
  outputs = [],
  cycles = null,
  settleMs = 900,
  clockWatchMs = 0
} = {}) {
  if (!inputs.length) return { ok: false, verified: false, msg: 'no input to drive: functional verification needs at least one lever/button to toggle' }
  if (!outputs.length) return { ok: false, verified: false, msg: 'no output to observe: verification needs a lamp, piston, door or hopper' }
  const { Vec3 } = require('vec3')
  const positions = [...inputs, ...outputs]
  for (const p of positions) {
    if (![p.x, p.y, p.z].every(Number.isSafeInteger)) return { ok: false, verified: false, msg: 'positions must be integer block coordinates' }
  }
  const before = outputs.map((p) => ({ at: `${p.x},${p.y},${p.z}`, state: readState(bot, p) }))
  const rows = []
  const plan = cycles || [
    { action: 'toggleAllOn', expect: true },
    { action: 'toggleAllOff', expect: false }
  ]
  const describe = (list) => list.map((o) => {
    const now = readState(bot, o)
    return { at: `${o.x},${o.y},${o.z}`, name: now?.name || 'unknown', kind: now?.kind || null, on: outputActive(now) }
  })
  const toggle = async (pos) => {
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (!block) throw new Error(`input at ${pos.x},${pos.y},${pos.z} is not loaded`)
    await bot.activateBlock(block)
    await sleep(settleMs)
  }
  const watch = async (ms) => {
    const seen = []
    const end = Date.now() + ms
    while (Date.now() < end) {
      seen.push(describe(outputs))
      await sleep(120)
    }
    return seen
  }
  try {
    for (const step of plan) {
      if (step.action === 'toggleAllOn' || step.action === 'toggleAllOff' || step.action === 'toggle') {
        const list = step.inputs && step.inputs.length ? step.inputs : inputs
        for (const p of list) await toggle(p)
      } else if (step.action === 'toggleInput' && step.input) {
        const target = inputs[step.input - 1]
        if (!target) return { ok: false, verified: false, msg: `cycle refers to input ${step.input} but only ${inputs.length} input(s) exist` }
        await toggle(target)
      } else if (step.action === 'wait' && step.ms) {
        await sleep(step.ms)
      }
      const observed = describe(outputs)
      rows.push({ action: step.action, input: step.input || null, expect: step.expect ?? null, observed })
    }
    let clock = null
    if (clockWatchMs > 0) {
      const frames = await watch(clockWatchMs)
      const series = outputs.map((o) => frames.map((f) => f.find((x) => x.at === o.id)?.on))
      const changes = series.map((s) => s.filter((v, i) => i > 0 && v !== s[i - 1]).length)
      clock = { observedChanges: changes, oscillating: changes.some((c) => c >= 2) }
    }
    // Compare with expectations.
    const mismatches = []
    for (const row of rows) {
      if (row.expect === null || row.expect === undefined) continue
      for (const o of row.observed) {
        if (o.on === null) continue
        if (o.on !== row.expect) mismatches.push(`${o.at} (${o.name}) was ${o.on ? 'on' : 'off'} after ${row.action}; expected ${row.expect ? 'on' : 'off'}`)
      }
    }
    // An output that never changed at all means the circuit did nothing.
    const beforeOn = before.map((b) => outputActive(b.state))
    const changedFromStart = rows.some((row) => row.observed.some((o, i) => o.on !== beforeOn[i]))
    const moreThanOneValue = new Set(rows.flatMap((r) => r.observed.map((o) => `${o.at}:${o.on}`))).size > 1
    const moved = changedFromStart || moreThanOneValue
    const unknownOutputs = rows.some((row) => row.observed.every((o) => o.on === null))
    if (unknownOutputs) {
      return { ok: false, verified: false, rows, before, msg: `verification inconclusive: the output block(s) ${outputs.map((o) => `${o.x},${o.y},${o.z}`).join(', ')} do not report a readable state (not loaded, wrong block, or no property to observe)` }
    }
    const verified = mismatches.length === 0 && moved
    if (!verified && !moved) {
      return {
        ok: false,
        verified: false,
        rows,
        mismatches,
        before,
        clock,
        msg: `verification inconclusive: no output changed when the inputs were toggled — either no power reaches the outputs or the outputs are not wired to these inputs. ${mismatches.slice(0, 2).join('; ')}`.trim()
      }
    }
    return {
      ok: verified,
      verified,
      rows,
      mismatches,
      before,
      clock,
      msg: verified
        ? `functionally verified: ${outputs.length} output(s) responded to ${inputs.length} input toggle(s) as expected`
        : `verification FAILED: ${mismatches.slice(0, 3).join('; ')}`
    }
  } catch (err) {
    return { ok: false, verified: false, rows, before, msg: `verification error: ${err.message || err}` }
  }
}

// ---------------------------------------------------------------------------
// 7. Design library: persistence + learning
// ---------------------------------------------------------------------------

class RedstoneLibrary {
  /**
   * @param {string} file `<dataDir>/redstone-library.json`
   */
  constructor (file, { now = Date.now } = {}) {
    this.file = file
    this.now = now
    this.designs = new Map()
    this.lessons = []
    this.loadError = null
    this._load()
  }

  _load () {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      if (Array.isArray(raw.designs)) {
        for (const d of raw.designs) {
          if (!d || typeof d.name !== 'string') continue
          this.designs.set(d.name, d)
        }
      }
      if (Array.isArray(raw.lessons)) this.lessons = raw.lessons.filter((l) => l && typeof l.text === 'string').slice(-200)
    } catch (err) {
      this.loadError = String(err.message || err)
      this.designs.clear()
    }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = { version: 1, designs: [...this.designs.values()].slice(-64), lessons: this.lessons.slice(-200) }
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.file)
      return true
    } catch { return false }
  }

  /** Record a design (from the catalogue or invented) with its verification status. */
  record ({ name, design = null, source = 'catalogue', verified = false, testResult = null, note = null, tags = [] } = {}) {
    const d = design || resolveDesign(name)
    if (!d) return { ok: false, msg: `unknown design "${name}"` }
    const prev = this.designs.get(d.name) || {}
    const entry = {
      name: d.name,
      title: d.title || prev.title || d.name,
      logic: d.logic || prev.logic || null,
      blocks: d.blocks || prev.blocks || [],
      footprint: d.footprint || prev.footprint || null,
      delayTicks: d.delayTicks ?? prev.delayTicks ?? null,
      complexity: d.complexity ?? prev.complexity ?? null,
      reliability: d.reliability || prev.reliability || null,
      caveat: d.caveat || prev.caveat || null,
      source,
      tags: [...new Set([...(prev.tags || []), ...tags])],
      verified: Boolean(verified || prev.verified),
      lastTestedAt: verified ? this.now() : (prev.lastTestedAt || null),
      lastTest: testResult ? String(testResult).slice(0, 400) : (prev.lastTest || null),
      uses: (prev.uses || 0) + 1,
      note: note || prev.note || null,
      createdAt: prev.createdAt || this.now(),
      updatedAt: this.now()
    }
    this.designs.set(d.name, entry)
    this.save()
    return { ok: true, entry }
  }

  /** A verified design that matches a requested behaviour, or the closest unverified one. */
  find ({ behavior = '', tag = null, verifiedOnly = false } = {}) {
    const q = String(behavior || '').toLowerCase()
    const scored = []
    for (const d of this.designs.values()) {
      if (tag && !(d.tags || []).includes(tag)) continue
      if (verifiedOnly && !d.verified) continue
      const hay = `${d.name} ${d.title} ${d.logic || ''} ${(d.tags || []).join(' ')}`.toLowerCase()
      let score = 0
      for (const w of q.split(/[^a-z0-9_]+/).filter((x) => x.length > 2)) if (hay.includes(w)) score += 1
      if (verifiedOnly) score += 2
      scored.push({ design: d, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.length ? scored[0].design : null
  }

  /** A short lesson (not one per failed block). */
  addLesson (text, { category = 'debugging', tags = [] } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    if (t.length < 8) return null
    const dup = this.lessons.find((l) => l.text === t)
    if (dup) { dup.count = (dup.count || 1) + 1; dup.lastAt = this.now(); this.save(); return dup }
    const lesson = { text: t, category, tags, count: 1, firstAt: this.now(), lastAt: this.now() }
    this.lessons.push(lesson)
    if (this.lessons.length > 200) this.lessons.shift()
    this.save()
    return lesson
  }

  list ({ verifiedOnly = false } = {}) {
    return [...this.designs.values()].filter((d) => !verifiedOnly || d.verified)
  }

  lessonsFor (text) {
    const q = String(text || '').toLowerCase()
    return this.lessons.filter((l) => q.split(/[^a-z0-9_]+/).filter((w) => w.length > 2).some((w) => l.text.toLowerCase().includes(w))).slice(-6)
  }
}

// ---------------------------------------------------------------------------
// 8. Design reasoning: pick a design for a stated behaviour
// ---------------------------------------------------------------------------

const BEHAVIOUR_INDEX = [
  { re: /\band\b|ambos|both inputs|duas (alavancas|entradas)|dois (botões|botoes|interruptores)|s[óo] quando|somente quando|only when (both|all)|all inputs|as duas (alavancas|entradas|estiverem)|os dois (estiverem|ligados)/i, design: 'and_gate', why: 'AND: two inverted inputs OR-ed then inverted' },
  { re: /\bxor\b|exclusive|ou exclusivo/i, design: 'xor_gate', why: 'XOR: subtract the overlap from the union' },
  { re: /\bor\b|either|qualquer um/i, design: 'or_gate', why: 'OR: one dust line shared by both inputs' },
  { re: /\bnot\b|invert|invers/i, design: 'not_gate', why: 'NOT: single torch inverter' },
  { re: /latch|memory|memória|memoria|toggle|hold state/i, design: 'rs_latch', why: 'RS latch holds a state until reset' },
  { re: /clock|oscillat|blink|pisca|periodic/i, design: 'clock_1hz', why: 'repeater loop with a torch inverter' },
  { re: /pulse|extend|estende|length/i, design: 'pulse_extender', why: 'repeater chain widens a short pulse' },
  { re: /sort|sorter|filter|separar/i, design: 'item_sorter', why: 'hopper + comparator + repeater channel' },
  { re: /farm|plant|bone ?meal|colheita/i, design: 'auto_farm', why: 'observer-clock dispenser module' },
  { re: /detect|observe|observ|change|mudou/i, design: 'state_detector', why: 'observer pulses on block change' }
]

/**
 * Reason about a requested behaviour and propose a design.
 * @param {string} behavior free text ("acender uma lâmpada só quando as duas alavancas…")
 */
function designFor (behavior) {
  const q = String(behavior || '')
  for (const entry of BEHAVIOUR_INDEX) {
    if (entry.re.test(q)) {
      const d = resolveDesign(entry.design)
      if (d) return { matched: true, design: d, why: entry.why, alternatives: Object.values(DESIGNS).filter((x) => x.name !== d.name && (x.logic || '').length).slice(0, 3).map((x) => x.name) }
    }
  }
  return { matched: false, design: null, why: 'no catalogue design matches this behaviour; inspect a working example in the world or design it explicitly', alternatives: Object.keys(DESIGNS).slice(0, 6) }
}

// ---------------------------------------------------------------------------
// 9. Model-facing helpers
// ---------------------------------------------------------------------------

function formatFindings (findings, limit = 6) {
  if (!findings.length) return 'diagnosis: no contradiction between the modelled circuit and the observed states (this is not proof the circuit works — drive its inputs to test it)'
  return 'diagnosis:\n' + findings.slice(0, limit).map((f) => `  - [${f.severity}] ${f.code}${f.at ? ` @${f.at}` : ''}: ${f.msg}`).join('\n')
}

function formatSimulation (sim, limit = 4) {
  if (!sim) return ''
  const lines = [`simulation (model, ${sim.frames.length} ticks): ${sim.oscillating ? `oscillates with period ${sim.period}` : 'settles'}`]
  const outs = sim.outputs.slice(0, limit).map((o) => `${o.kind}@${o.at}=${o.active ? 'ON' : 'off'}`)
  if (outs.length) lines.push(`  final outputs: ${outs.join('; ')}`)
  for (const n of sim.notes) lines.push(`  note: ${n}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 10. Session-facing engineer: one `act(args)` the executor calls
// ---------------------------------------------------------------------------

const bounded = (msg) => (msg.length <= 900 ? msg : `${msg.slice(0, 860)} …[truncated]`)

class RedstoneEngineer {
  /**
   * @param {object} bot
   * @param {{
   *   library?: RedstoneLibrary|null,
   *   memory?: object|null,
   *   now?: () => number,
   *   executor?: () => object|null,
   *   canWrite?: (pos:{x:number,y:number,z:number}) => boolean,
   *   logger?: object
   * }} opts
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.library = opts.library || null
    this.memory = opts.memory || null
    this.now = opts.now || Date.now
    this.executor = opts.executor || (() => null)
    this.canWrite = opts.canWrite || (() => true)
    this.logger = opts.logger || null
    this.lastSnapshot = null
  }

  _inventoryCounts () {
    const out = {}
    try {
      for (const item of this.bot.inventory?.items?.() || []) out[item.name] = (out[item.name] || 0) + (item.count || 1)
    } catch { /* no inventory */ }
    return out
  }

  /** `operation` dispatcher used by the `redstone_engineer` tool. */
  async act (args = {}) {
    const op = String(args.operation || '').toLowerCase()
    if (!['analyze', 'diagnose', 'simulate', 'design', 'place', 'verify', 'trace', 'library', 'lesson'].includes(op)) {
      return { ok: false, msg: 'operation must be one of analyze|diagnose|simulate|design|place|verify|trace|library|lesson' }
    }
    if (op === 'analyze' || op === 'diagnose' || op === 'simulate' || op === 'trace') {
      const p = this.bot.entity?.position
      const cx = Number.isSafeInteger(args.x) ? args.x : Math.floor(p?.x ?? 0)
      const cy = Number.isSafeInteger(args.y) ? args.y : Math.floor(p?.y ?? 0)
      const cz = Number.isSafeInteger(args.z) ? args.z : Math.floor(p?.z ?? 0)
      const radius = Number.isSafeInteger(args.radius) ? args.radius : 3
      const per = perceive(this.bot, { x: cx, y: cy, z: cz, radius })
      if (!per.ok) return per
      const model = new CircuitModel(per.snapshot, { now: this.now })
      this.lastSnapshot = per.snapshot
      const before = new Date().toISOString()
      if (op === 'analyze') {
        const rows = model.compareObserved()
        const disagreements = rows.filter((r) => !r.agree)
        const lines = [
          ...model.describe(),
          `observed at ${before}`,
          disagreements.length
            ? `model/world differences: ${disagreements.slice(0, 4).map((r) => `${r.node.kind}@${r.node.id} model=${JSON.stringify(r.predicted)} observed=${JSON.stringify(r.observed)}`).join('; ')}`
            : 'model and observed states agree on every cell with enough data',
          formatFindings(model.diagnose(), 4),
          `limits: ${per.snapshot.limits}`
        ]
        return { ok: true, msg: bounded(lines.join('\n')), snapshot: per.snapshot }
      }
      if (op === 'diagnose') {
        const findings = model.diagnose()
        return { ok: true, msg: bounded(`${model.describe().slice(0, 2).join('; ')}\n${formatFindings(findings, 8)}\nEvidence is a static snapshot taken ${before}; mechanics outside the listed limits are not claimed.`) }
      }
      if (op === 'simulate') {
        const ticks = Number.isSafeInteger(args.ticks) ? Math.max(1, Math.min(200, args.ticks)) : 40
        const sim = model.run({ ticks })
        return { ok: true, msg: bounded(`${model.describe().slice(0, 1).join('')}\n${formatSimulation(sim, 6)}\nThis is the engine's discrete-tick MODEL (approximate Java mechanics), not a server measurement.`) }
      }
      // trace
      const nodeId = args.node || (model.sources()[0]?.id || model.nodes[0]?.id)
      if (!nodeId) return { ok: false, msg: 'no components to trace in this region' }
      const tr = model.traceFrom(String(nodeId))
      if (!tr.ok) return tr
      const lines = tr.edges.slice(0, 12).map((e) => `  ${e.from} → ${e.to} (${e.kind}${e.depth ? `, depth ${e.depth}` : ''}${e.note ? `, ${e.note}` : ''})`)
      return { ok: true, msg: bounded(`trace from ${nodeId}: ${tr.reached} component(s) reachable\n${lines.join('\n') || '  no outgoing signal path (this component may be an output or isolated)'}`) }
    }

    if (op === 'design') {
      const req = String(args.design || args.name || '').trim()
      if (!req) return { ok: false, msg: 'design needs `design` (e.g. "and", "clock", or a behaviour sentence like "acender só quando as duas alavancas estiverem ligadas")' }
      const match = designFor(req)
      const named = resolveDesign(req)
      const chosen = named || match.design
      if (!chosen) {
        return { ok: false, msg: `no design matches "${req}". Known designs: ${Object.keys(DESIGNS).join(', ')}. ${match.why}` }
      }
      const compareList = Array.isArray(args.compare) ? args.compare.filter((c) => typeof c === 'string').slice(0, 4) : []
      const cmp = compareDesigns([chosen.name, ...compareList])
      const lines = [
        `${chosen.name} — ${chosen.title}`,
        `logic: ${chosen.logic || 'n/a'}`,
        `blocks: ${(chosen.blocks || []).length}, footprint ${chosen.footprint ? `${chosen.footprint.w}×${chosen.footprint.h}×${chosen.footprint.d}` : 'n/a'}, delay ≈ ${chosen.delayTicks ?? '?'} tick(s)`,
        `materials: ${Object.entries(cmp.rows[0]?.materials || {}).map(([k, v]) => `${k}×${v}`).join(', ')}`,
        `reliability: ${chosen.reliability || 'unknown'}`
      ]
      if (chosen.caveat) lines.push(`caveat: ${chosen.caveat}`)
      if (cmp.rows.length > 1) lines.push(`comparison: ${cmp.rows.map((r) => `${r.name}(vol ${r.volume}, ${r.blocks} blocks, ${r.delayTicks} ticks, complexity ${r.complexity})`).join(' | ')}; smallest=${cmp.smallest}, lowest delay=${cmp.lowestDelay}, simplest=${cmp.simplest}`)
      lines.push(`note: ${cmp.note}. Use operation=place to build it, then operation=verify to prove it works.`)
      return { ok: true, msg: bounded(lines.join('\n')), design: chosen.name }
    }

    if (op === 'place') {
      const req = String(args.design || args.name || '').trim()
      if (!req) return { ok: false, msg: 'place needs `design` and an origin (x,y,z default: your feet)' }
      const match = designFor(req)
      const chosen = resolveDesign(req) || match.design
      if (!chosen) return { ok: false, msg: `no design matches "${req}"; known: ${Object.keys(DESIGNS).join(', ')}` }
      const p = this.bot.entity?.position
      const origin = {
        x: Number.isSafeInteger(args.x) ? args.x : Math.floor(p?.x ?? 0),
        y: Number.isSafeInteger(args.y) ? args.y : Math.floor(p?.y ?? 0),
        z: Number.isSafeInteger(args.z) ? args.z : Math.floor(p?.z ?? 0)
      }
      const plan = planPlacement(chosen, origin, { rotate: ['north', 'south', 'east', 'west'].includes(args.rotate) ? args.rotate : 'north' })
      if (!plan.ok) return plan
      const existing = (pos) => {
        try { const b = this.bot.blockAt({ x: pos.x, y: pos.y, z: pos.z }); return b ? b.name : null } catch { return null }
      }
      const pre = preflight(plan, { inventory: this._inventoryCounts(), canWrite: this.canWrite, existing })
      if (!pre.ok) {
        return { ok: false, msg: bounded(`place BLOCKED — nothing was placed. ${pre.msg}. Plan was ${plan.placements.length} blocks at ${origin.x},${origin.y},${origin.z} rotated ${plan.rotate}. Fix materials/space first (gather, or pick another origin), then place again.`) }
      }
      const exec = this.executor()
      if (!exec || typeof exec._placeAt !== 'function') return { ok: false, msg: 'place failed: the builder executor is not available right now' }
      const res = await placePlan(exec, plan)
      let msg = `${res.ok ? 'placed' : 'placement incomplete'}: ${res.placed}/${res.total} blocks for ${chosen.name} at ${origin.x},${origin.y},${origin.z}`
      if (res.failed.length) msg += `; failed: ${res.failed.slice(0, 4).join(', ')}`
      if (res.skipped.length) msg += `; skipped: ${res.skipped.slice(0, 3).join(', ')}`
      msg += `. This does NOT mean the circuit works — call redstone_engineer verify with its inputs and outputs to prove it.`
      if (this.memory?.recordKnowledge && res.placed > 0) {
        try {
          this.memory.recordKnowledge({
            text: `built ${chosen.name} (${chosen.logic || chosen.title}) at ${origin.x},${origin.y},${origin.z} in ${this.bot.game?.dimension || 'overworld'}`,
            category: 'procedural',
            basis: 'observed',
            confidence: 0.9,
            importance: 2,
            tags: ['redstone', 'build', chosen.name],
            location: { ...origin, dim: String(this.bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') },
            subjectKey: `redstone_build:${chosen.name}`
          })
        } catch { /* memory is best-effort */ }
      }
      return { ok: res.ok, msg: bounded(msg), plan: { design: chosen.name, origin, placements: plan.placements } }
    }

    if (op === 'verify') {
      const inputs = Array.isArray(args.inputs) ? args.inputs.slice(0, 4) : []
      const outputs = Array.isArray(args.outputs) ? args.outputs.slice(0, 4) : []
      if (!inputs.length || !outputs.length) return { ok: false, msg: 'verify needs `inputs` (levers/buttons to toggle) and `outputs` (lamps/pistons/doors to watch)' }
      const res = await functionalTest(this.bot, { inputs, outputs, clockWatchMs: Number.isSafeInteger(args.ticks) ? Math.min(4000, args.ticks * 100) : 0 })
      let msg = res.msg
      if (res.rows?.length) {
        msg += `\nobserved: ${res.rows.map((r) => `${r.action}${r.input ? `#${r.input}` : ''} → ${r.observed.map((o) => `${o.name}@${o.at}=${o.on === null ? 'unknown' : o.on ? 'ON' : 'off'}`).join(', ')}`).join(' | ')}`
      }
      if (res.clock) msg += `\nclock watch: observed ${res.clock.observedChanges.join('/')} output change(s); ${res.clock.oscillating ? 'oscillating' : 'no periodic change seen'}`
      if (res.verified) {
        try {
          this.library?.addLesson(`functional verification passed for a circuit with ${inputs.length} input(s) and ${outputs.length} output(s) at ${inputs[0].x},${inputs[0].y},${inputs[0].z}`, { category: 'verification', tags: ['redstone'] })
          this.memory?.recordKnowledge?.({
            text: `verified working redstone at ${inputs[0].x},${inputs[0].y},${inputs[0].z}: ${inputs.length} input(s) drive ${outputs.length} output(s) as expected (${this.bot.game?.dimension || 'overworld'})`,
            category: 'procedural',
            basis: 'observed',
            confidence: 0.95,
            importance: 3,
            tags: ['redstone', 'verified'],
            location: { ...inputs[0], dim: String(this.bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') }
          })
        } catch { /* best effort */ }
      }
      return { ok: res.ok, verified: Boolean(res.verified), msg: bounded(msg) }
    }

    if (op === 'library') {
      const list = this.library?.list?.({ verifiedOnly: false }) || []
      if (!list.length) return { ok: true, msg: 'design library is empty: nothing has been built or verified yet in this world' }
      const found = args.name ? this.library.find({ behavior: String(args.name) }) : null
      const rows = (found ? [found, ...list.filter((d) => d.name !== found.name)] : list).slice(0, 8)
      return {
        ok: true,
        msg: bounded(rows.map((d) => `- ${d.name}${d.verified ? ' [verified]' : ' [unverified]'} ×${d.uses || 0} uses: ${d.logic || d.title}${d.lastTest ? ` (${d.lastTest.slice(0, 90)})` : ''}`).join('\n'))
      }
    }

    // lesson
    const note = String(args.note || args.name || '').replace(/\s+/g, ' ').trim()
    if (note.length < 8) return { ok: false, msg: 'lesson needs `note` with the debugging insight (at least 8 characters)' }
    const kept = this.library?.addLesson(note, { category: 'debugging', tags: ['redstone'] })
    let remembered = false
    try {
      if (this.memory?.recordKnowledge) {
        this.memory.recordKnowledge({
          text: note.slice(0, 220),
          category: 'procedural',
          basis: 'inferred',
          confidence: 0.7,
          importance: 2,
          tags: ['redstone', 'lesson'],
          subjectKey: `redstone_lesson:${note.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
        })
        remembered = true
      }
    } catch { /* memory best effort */ }
    return { ok: true, msg: `lesson stored${kept ? '' : ' (library unavailable)'}${remembered ? ' in procedural memory' : ''}: ${note.slice(0, 160)}` }
  }
}

module.exports = {
  classify,
  normalizeState,
  perceive,
  CircuitModel,
  RedstoneEngineer,
  sourceStrength,
  resolveDesign,
  designFor,
  compareDesigns,
  planPlacement,
  checkDesign,
  preflight,
  placePlan,
  functionalTest,
  outputActive,
  readState,
  RedstoneLibrary,
  formatFindings,
  formatSimulation,
  DESIGNS,
  DESIGN_ALIASES,
  HORIZ,
  OPP,
  DIRS,
  MAX_RADIUS,
  PALETTE_NOTE
}
