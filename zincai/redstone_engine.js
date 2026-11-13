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
const MECHANISM_KINDS = new Set(['piston', 'sticky_piston', 'redstone_lamp', 'door', 'trapdoor', 'fence_gate', 'note_block', 'hopper', 'dropper', 'dispenser', 'powered_rail', 'activator_rail', 'crafter'])

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

  neighbours (node) {
    const out = []
    for (const d of HORIZ) {
      const v = DIRS[d]
      const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (n) out.push({ dir: d, node: n })
    }
    for (const [dir, v] of [['up', AXIS_VEC.up], ['down', AXIS_VEC.down]]) {
      const n = this.nodeAt(node.x + v.x, node.y + v.y, node.z + v.z)
      if (n) out.push({ dir, node: n })
    }
    return out
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
        const above = this.nodeAt(node.x + v.x, node.y + 1, node.z + v.z)
        if (above?.kind === 'dust') out.push({ dir: d, node: above, note: 'dust above front (diagonal cut)' })
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
      case 'torch': return this.neighbours(node).filter((nb) => !(node.kind === 'torch' && nb.node.kind === 'torch'))
      case 'lever': case 'button': case 'pressure_plate': case 'tripwire': case 'tripwire_hook': case 'target': case 'daylight_detector': case 'redstone_block': return this.neighbours(node)
      default: return []
    }
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
        // Comparators read side inputs too.
        if (node.kind === 'comparator') {
          for (const d of HORIZ) {
            if (d === s.facing || d === OPP[s.facing]) continue
            const sd = DIRS[d]
            const side = this.nodeAt(node.x + sd.x, node.y, node.z + sd.z)
            if (side) out.push({ dir: d, node: side, role: 'side' })
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
        if (node.name === 'redstone_wall_torch' && s.facing) {
          const v = DIRS[OPP[s.facing]]
          if (v) return [{ dir: OPP[s.facing], node: this.nodeAt(node.x + v.x, node.y, node.z + v.z), solid: this.isSolid(node.x + v.x, node.y, node.z + v.z), role: 'support' }]
        }
        return [{ dir: 'down', node: this.nodeAt(node.x, node.y - 1, node.z), solid: this.isSolid(node.x, node.y - 1, node.z), role: 'support' }]
      }
      case 'dust': return this.neighbours(node)
      default: return this.neighbours(node)
    }
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
          const side = node.state?.[o.dir]
          if (side === 'side' || side === 'up' || side === undefined) { kind = 'dust_link'; evidence = `dust ${o.dir}=${side ?? 'unknown'}` } else { kind = 'dust_link_geometry'; confidence = 'candidate'; evidence = `dust ${o.dir}=${side} (does not visually link)` }
        }
        if (node.kind === 'repeater' || node.kind === 'comparator') { kind = 'logic_output'; evidence = `${node.kind} front ${o.dir}` }
        if (node.kind === 'observer') { kind = 'observer_pulse'; evidence = `observer output ${o.dir}` }
        if (isMechanism(o.node)) { kind = 'mechanism_input'; evidence = `${o.node.kind} powered from ${o.dir}` }
        push(node.id, o.node.id, kind, evidence, confidence)
      }
    }
    return edges
  }

  sources () { return this.nodes.filter((n) => SOURCE_KINDS.has(n.kind)) }
  mechanisms () { return this.nodes.filter(isMechanism) }

  /**
   * Fixed-point dust power solve for the *current observed* source states.
   * Returns Map(nodeId → {power, known, contributors[]}).
   */
  solvePower ({ inputs = null, maxIterations = 24 } = {}) {
    const power = new Map()
    const contributors = new Map()
    const dust = this.nodes.filter((n) => n.kind === 'dust')
    for (const d of dust) {
      const observed = num(d.state?.power, null)
      power.set(d.id, { model: 0, observed, known: observed !== null, contributors: [] })
      contributors.set(d.id, [])
    }
    const dustAt = (x, y, z) => {
      const n = this.nodeAt(x, y, z)
      return n && n.kind === 'dust' ? n : null
    }
    // Direct injection into a dust cell from a neighbouring active source.
    const injections = []
    for (const src of this.nodes) {
      if (!SOURCE_KINDS.has(src.kind)) continue
      const strength = sourceStrength(src, { inputs })
      if (strength === null || strength <= 0) continue
      for (const nb of this.neighbours(src)) {
        if (nb.node.kind === 'dust') injections.push({ dust: nb.node.id, from: src.id, power: strength, how: `${src.kind} adjacent` })
      }
      if (src.kind === 'torch' && src.state?.lit) {
        // A wall torch also powers the dust cell it is attached to.
        for (const nb of this.neighbours(src)) if (nb.node.kind === 'dust') injections.push({ dust: nb.node.id, from: src.id, power: 15, how: 'lit torch' })
      }
    }
    // Repeater/comparator outputs inject at their front cell.
    for (const node of this.nodes) {
      if (node.kind === 'torch') {
        if (node.state?.lit !== true) continue
        for (const nb of this.neighbours(node)) {
          if (nb.node.kind === 'dust') injections.push({ dust: nb.node.id, from: node.id, power: 15, how: 'lit torch' })
        }
      }
    }
    let changed = true
    let iter = 0
    for (const inj of injections) {
      const cur = power.get(inj.dust)
      if (cur && inj.power > cur.model) { cur.model = inj.power; cur.contributors = [{ from: inj.from, via: inj.how, power: inj.power }] }
    }
    while (changed && iter++ < maxIterations) {
      changed = false
      for (const d of dust) {
        const cur = power.get(d.id)
        for (const nb of this.neighbours(d)) {
          const other = nb.node
          if (other.kind !== 'dust') continue
          const oc = power.get(other.id)
          if (!oc) continue
          const candidate = Math.max(0, oc.model - 1)
          if (candidate > cur.model) {
            cur.model = candidate
            cur.contributors = [...oc.contributors, { from: other.id, via: 'dust decay', power: candidate }]
            changed = true
          }
        }
      }
    }
    // Logic components: predict their output from solved inputs.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const inPower = this.inputPower(node, power, { inputs })
      const observed = node.state?.powered
      power.set(node.id, {
        model: inPower === null ? null : inPower > 0 ? 15 : 0,
        observed: observed === true ? 15 : observed === false ? 0 : null,
        known: observed !== undefined,
        contributors: inPower === null ? [] : [{ from: 'rear', via: `${node.kind} input ${inPower}`, power: inPower }]
      })
    }
    return { power, contributors }
  }

  /** Strongest input arriving at a node's rear/watched faces, or null when unknown. */
  inputPower (node, power, { inputs = null } = {}) {
    const ins = this.inputsOf(node)
    let best = 0
    let known = false
    for (const inp of ins) {
      if (inp.role === 'side' || inp.role === 'watched') continue
      if (inp.node) {
        const s = sourceStrength(inp.node, { inputs })
        const dc = power.get(inp.node.id)
        const dustPower = dc ? dc.model : node.kind === 'dust' ? 0 : null
        let v = null
        if (s !== null) v = s
        else if (inp.node.kind === 'dust' && dc) v = dc.model
        else if (inp.node.kind === 'repeater' || inp.node.kind === 'comparator') {
          const lc = power.get(inp.node.id)
          v = lc ? lc.model : null
        } else if (inp.node.kind === 'torch') v = inp.node.state?.lit ? 15 : 0
        else if (isMechanism(inp.node)) v = 0
        if (v !== null) { known = true; best = Math.max(best, v) }
      }
      // A solid block can be powered by dust on top / torch attached to it.
      if (!inp.node && (inp.solid || inp.role === 'support')) {
        const blockPower = this.blockPowerAt(node, inp)
        if (blockPower !== null) { known = true; best = Math.max(best, blockPower) }
      }
    }
    return known ? best : null
  }

  /** Power delivered into a solid block adjacent to `node` at direction `inp.dir`. */
  blockPowerAt (node, inp) {
    const v = inp.dir && (DIRS[inp.dir] || AXIS_VEC[inp.dir])
    if (!v) return null
    const bx = node.x + v.x; const by = node.y + v.y; const bz = node.z + v.z
    let best = 0
    let known = false
    for (const d of HORIZ) {
      const dv = DIRS[d]
      const n = this.nodeAt(bx + dv.x, by, bz + dv.z)
      if (!n) continue
      if (n.kind === 'dust' && Number.isFinite(num(n.state?.power, null))) { known = true; best = Math.max(best, num(n.state.power)) }
      if (n.kind === 'torch' && n.state?.lit === true) { known = true; best = Math.max(best, 15) }
      if (n.kind === 'lever' && n.state?.powered === true) { known = true; best = Math.max(best, 15) }
      if (n.kind === 'button' && n.state?.powered === true) { known = true; best = Math.max(best, 15) }
      if (n.kind === 'redstone_block') { known = true; best = Math.max(best, 15) }
    }
    // Dust directly above the block powers it.
    const above = this.nodeAt(bx, by + 1, bz)
    if (above?.kind === 'dust' && Number.isFinite(num(above.state?.power, null))) { known = true; best = Math.max(best, num(above.state.power)) }
    const headAbove = this.nodeAt(bx, by + 1, bz)
    if (headAbove?.kind === 'repeater' || headAbove?.kind === 'comparator') best = Math.max(best, 0)
    return known ? best : null
  }

  /** Predicted activation state of one mechanism from the solved power. */
  predictMechanism (node, power, { inputs = null } = {}) {
    let inPower = 0
    let known = false
    for (const nb of this.neighbours(node)) {
      const other = nb.node
      const s = sourceStrength(other, { inputs })
      if (s !== null) { known = true; inPower = Math.max(inPower, s) }
      if (other.kind === 'dust') {
        const dc = power.get(other.id)
        if (dc && dc.known) { known = true; inPower = Math.max(inPower, dc.model) }
      }
      if (other.kind === 'repeater' || other.kind === 'comparator') {
        const lc = power.get(other.id)
        if (lc && lc.known) { known = true; inPower = Math.max(inPower, lc.model ?? 0) }
      }
      if (other.kind === 'torch' && other.state?.lit === true) { known = true; inPower = Math.max(inPower, 15) }
    }
    const lit = inPower > 0
    switch (node.kind) {
      case 'redstone_lamp': return { activate: lit, expected: { lit }, known }
      case 'piston':
      case 'sticky_piston': return { activate: lit, expected: { extended: lit }, known }
      case 'door':
      case 'trapdoor':
      case 'fence_gate': return { activate: lit, expected: { open: lit }, known }
      case 'note_block': return { activate: lit, expected: { powered: lit }, known }
      case 'hopper': return { activate: !lit, expected: { enabled: !lit }, known }
      case 'dropper':
      case 'dispenser': return { activate: lit, expected: { triggered: lit }, known }
      case 'powered_rail':
      case 'activator_rail': return { activate: lit, expected: {}, known }
      default: return { activate: lit, expected: {}, known }
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
      if (node.kind === 'dust') {
        const p = power.get(node.id)
        if (!p || p.observed === null) continue
        rows.push({
          node,
          predicted: p.model,
          observed: p.observed,
          agree: p.model === p.observed,
          why: `model ${p.model} vs observed ${p.observed}`
        })
      } else if (node.kind === 'repeater' || node.kind === 'comparator') {
        const p = power.get(node.id)
        if (!p || p.observed === null) continue
        rows.push({ node, predicted: p.model, observed: p.observed, agree: p.model === p.observed, why: `model ${p.model} vs observed ${p.observed}` })
      } else if (isMechanism(node)) {
        const pred = this.predictMechanism(node, power, { inputs })
        const expected = pred.expected
        const observedState = node.state || {}
        const entries = Object.entries(expected).filter(([k, v]) => observedState[k] !== undefined)
        if (!entries.length) continue
        const agree = entries.every(([k, v]) => observedState[k] === v)
        rows.push({ node, predicted: expected, observed: Object.fromEntries(entries.map(([k]) => [k, observedState[k]])), agree, known: pred.known })
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
    const sourcesOn = this.sources().filter((s) => (sourceStrength(s, { inputs }) || 0) > 0)

    if (!sourcesOn.length) {
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
        const side = node.state?.[nb.dir]
        const backSide = nb.node.state?.[OPP[nb.dir]]
        // Two dust cells conduct when BOTH face each other with side/up. A
        // one-sided reading is a visually broken run, not a live link.
        // Two dust cells conduct when BOTH face each other with side/up.
        const connects = (v) => v === 'side' || v === 'up'
        const linked = connects(side) && connects(backSide)
        if (!linked) {
          add('medium', 'dust_visually_unlinked', node,
            `dust here reads power=${observed} while its ${nb.dir} neighbour reads ${nObs}, and the ${nb.dir} side does not connect (${side ?? 'unknown'}) — the run is deliberately broken or a block is in the way`,
            `neighbour ${nb.node.id} power=${nObs}`)
          continue
        }
        add('high', 'dust_gap', node,
          `dust here reads power=0 while the ${nb.dir} neighbour reads ${nObs} and both sides visually connect — the link is probably cut (a block between them, a different Y level, or a stale client read). Re-inspect the ${nb.dir} side and the block on top`,
          `neighbour ${nb.node.id} power=${nObs}, link ${nb.dir}${side ? `=${side}` : '=unknown'}`)
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
        `${node.kind} ${prop}=${observed[prop]} but the modelled input power is ${pred.activate ? 'above 0' : '0'}, so it is expected to be ${prop}=${expected} — check the power actually reaching this block (a gap, a wrong-facing repeater, or a component the client cannot see)`,
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
      const rearPower = rearNode ? this._powerOfNode(rearNode, power) : (backV && this.isSolid(node.x + backV.x, node.y, node.z + backV.z) ? null : 0)
      const frontPower = frontNode ? this._powerOfNode(frontNode, power) : 0
      // Power sitting on a side that only a rear input would accept.
      const sidePower = []
      for (const d of HORIZ) {
        if (d === s.facing || d === OPP[s.facing]) continue
        const v = DIRS[d]
        const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        const p = n ? this._powerOfNode(n, power) : 0
        if (p !== null && p > 0) sidePower.push(`${d}(${n.kind} ${p})`)
      }
      if (rearPower === 0 && sidePower.length) {
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
      if (node.kind === 'repeater' && Number.isFinite(s.delay) && s.delay !== 3 && rearPower > 0) {
        add('info', 'repeater_delay', node, `repeater delay is ${s.delay} tick(s) — timing-sensitive circuits depend on this`, `delay=${s.delay}`)
      }
      if (node.kind === 'comparator') {
        const mode = s.mode || 'compare'
        add('info', 'comparator_mode', node, `comparator is in ${mode} mode${mode === 'subtract' ? ' (outputs rear − max(side))' : ' (outputs rear only when rear ≥ sides)'}`, `mode=${mode}`)
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
        `feedback loop of ${c.length} components${hasRepeater ? ' with a delay element' : ''}${hasTorch ? ' and a torch inverter' : ''} — ${hasRepeater ? 'this is how a clock/oscillator is built; its period depends on the repeater delays' : 'with no delay element the loop settles instead of oscillating'}`,
        c.join(' → '))
    }

    // Strong-power edge: dust on top of a block; note the uncertainty honestly.
    for (const node of this.nodes) {
      if (node.kind !== 'dust') continue
      const below = this.nodeAt(node.x, node.y - 1, node.z)
      if (below && (below.kind === 'dust')) {
        add('info', 'vertical_dust_stack', node, 'dust stacked vertically: only a step up (dust with side=up) conducts; a straight vertical stack does not', 'dust directly beneath')
      }
    }
    return findings
  }

  _powerOfNode (node, power) {
    if (node.kind === 'dust' || node.kind === 'repeater' || node.kind === 'comparator') {
      const p = power.get(node.id)
      return p ? p.model : null
    }
    const s = sourceStrength(node)
    if (s !== null) return s
    if (node.kind === 'torch') return node.state?.lit ? 15 : 0
    return 0
  }

  _findCycles () {
    const carrier = (n) => !!n && (isSignalCarrier(n.kind) || n.kind === 'repeater' || n.kind === 'comparator')
    const adj = new Map()
    for (const n of this.nodes) {
      if (!carrier(n)) continue
      const list = []
      for (const o of this.outputsOf(n)) {
        if (o.node && carrier(o.node)) list.push(o.node.id)
      }
      for (const i of this.inputsOf(n)) if (i.node && carrier(i.node)) list.push(i.node.id)
      adj.set(n.id, [...new Set(list)])
    }
    const cycles = []
    const seen = new Set()
    const dfs = (start, node, trail, depth) => {
      if (depth > 12) return
      for (const next of adj.get(node) || []) {
        if (next === start && trail.length >= 3) {
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

  /** Human-readable circuit summary: components, paths, sources, outputs. */
  describe ({ maxLines = 12 } = {}) {
    const counts = {}
    for (const n of this.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1
    const types = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ') || 'no components'
    const srcs = this.sources().map((s) => `${s.kind}@${s.id}${s.state?.powered === true || s.state?.lit === true ? '(on)' : ''}`)
    const outs = this.mechanisms().map((m) => `${m.kind}@${m.id}`)
    const lines = [
      `${this.nodes.length} components in ${this.snapshot.dimension} at r=${this.snapshot.radius} around ${this.snapshot.center.x},${this.snapshot.center.y},${this.snapshot.center.z} (${types})`,
      `sources: ${srcs.slice(0, 8).join('; ') || 'none'}`,
      `outputs/mechanisms: ${outs.slice(0, 8).join('; ') || 'none'}`,
      `directed edges: ${this.edges.length} (${this.edges.filter((e) => e.kind === 'dust_link').length} dust links, ${this.edges.filter((e) => e.kind === 'mechanism_input').length} mechanism inputs)`
    ]
    return lines.slice(0, maxLines)
  }

  /**
   * Discrete tick simulation over the modelled components.
   * @param {{ticks?:number, inputs?:object, changes?:string[]}} opts
   *        inputs: nodeId → boolean (interactive sources only)
   *        changes: nodeIds whose block state changed this tick (observers pulse)
   * @returns {{frames:Array, outputs:Array, oscillating:boolean, period:number|null, notes:string[]}}
   */
  run ({ ticks = 40, inputs = null, changes = [] } = {}) {
    const frames = []
    const notes = []
    const dust = this.nodes.filter((n) => n.kind === 'dust')
    const repeaters = this.nodes.filter((n) => n.kind === 'repeater')
    const comparators = this.nodes.filter((n) => n.kind === 'comparator')
    const observers = this.nodes.filter((n) => n.kind === 'observer')
    const sourcesOn = new Map()
    for (const s of this.sources()) {
      const v = sourceStrength(s, { inputs })
      sourcesOn.set(s.id, v === null ? 0 : v > 0)
    }
    // Torch state is feedback-driven: start from observed, then settle.
    const torchLit = new Map()
    for (const n of this.nodes.filter((n) => n.kind === 'torch')) torchLit.set(n.id, n.state?.lit === true)
    const repeaterOut = new Map(repeaters.map((r) => [r.id, r.state?.powered === true]))
    const comparatorOut = new Map(comparators.map((c) => [c.id, c.state?.powered === true]))
    const queue = [] // {at, apply}
    const dustPower = new Map(dust.map((d) => [d.id, num(d.state?.power, 0) || 0]))
    const observerPulse = new Map()

    const applyObserverPulses = () => {
      for (const o of observers) {
        const pulsating = changes.includes(o.id) || (o.state?.powered === true && !observerPulse.get(o.id))
        if (pulsating) observerPulse.set(o.id, 2)
        else {
          const left = (observerPulse.get(o.id) || 0) - 1
          observerPulse.set(o.id, Math.max(0, left))
        }
      }
    }

    const computeDust = () => {
      // Iterative relaxation using current device outputs.
      const next = new Map(dust.map((d) => [d.id, 0]))
      const inject = (id, v) => { if (next.has(id)) next.set(id, Math.max(next.get(id) || 0, v)) }
      for (const src of this.nodes) {
        const on = src.kind === 'torch' ? torchLit.get(src.id) : (src.kind === 'repeater' ? repeaterOut.get(src.id) : (src.kind === 'comparator' ? comparatorOut.get(src.id) : (src.kind === 'observer' ? (observerPulse.get(src.id) || 0) > 0 : !!sourcesOn.get(src.id))))
        if (!on) continue
        const power = src.kind === 'target' ? (num(src.state?.power, 15) || 15) : 15
        if (src.kind === 'observer') { for (const o of this.outputsOf(src)) if (o.node?.kind === 'dust') inject(o.node.id, 15) ; continue }
        for (const nb of this.neighbours(src)) if (nb.node.kind === 'dust') inject(nb.node.id, power)
      }
      for (let iter = 0; iter < 12; iter++) {
        let changed = false
        for (const d of dust) {
          for (const nb of this.neighbours(d)) {
            if (nb.node.kind !== 'dust') continue
            const v = Math.max(0, (next.get(nb.node.id) || 0) - 1)
            if (v > (next.get(d.id) || 0)) { next.set(d.id, v); changed = true }
          }
        }
        if (!changed) break
      }
      for (const [k, v] of next) dustPower.set(k, v)
    }

    const powerAt = (node) => {
      let best = 0
      for (const nb of this.neighbours(node)) {
        const o = nb.node
        if (o.kind === 'dust') best = Math.max(best, dustPower.get(o.id) || 0)
        else if (o.kind === 'repeater') best = Math.max(best, repeaterOut.get(o.id) ? 15 : 0)
        else if (o.kind === 'comparator') best = Math.max(best, comparatorOut.get(o.id) ? 15 : 0)
        else if (o.kind === 'torch') best = Math.max(best, torchLit.get(o.id) ? 15 : 0)
        else if (SOURCE_KINDS.has(o.kind)) best = Math.max(best, sourcesOn.get(o.id) ? 15 : 0)
      }
      return best
    }

    const rearPower = (node) => {
      const s = node.state || {}
      if (!s.facing || !DIRS[s.facing]) return 0
      const v = DIRS[s.facing]
      const rear = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (rear) return this._simPowerOf(rear, { dustPower, repeaterOut, comparatorOut, torchLit, sourcesOn })
      return 0
    }

    for (let t = 0; t < ticks; t++) {
      applyObserverPulses()
      computeDust()
      // Torches: lit when their support block is unpowered.
      for (const n of this.nodes.filter((x) => x.kind === 'torch')) {
        const ins = this.inputsOf(n)
        let supportPower = 0
        for (const inp of ins) supportPower = Math.max(supportPower, this._simPowerOf(inp.node, { dustPower, repeaterOut, comparatorOut, torchLit, sourcesOn }, inp.solid ? null : inp.node))
        const want = (supportPower || 0) === 0
        if (n.state?.lit === true && !want) queue.push({ at: t + 1, apply: () => torchLit.set(n.id, false) })
        else if (n.state?.lit === false && want) queue.push({ at: t + 1, apply: () => torchLit.set(n.id, true) })
        else if (torchLit.get(n.id) !== want && torchLit.get(n.id) === undefined) torchLit.set(n.id, want)
      }
      // Repeaters: schedule a front change after their delay.
      for (const r of repeaters) {
        const want = rearPower(r) > 0
        if (want !== repeaterOut.get(r.id)) {
          const delay = Math.max(1, Math.min(4, num(r.state?.delay, 1) || 1))
          queue.push({ at: t + delay, apply: () => repeaterOut.set(r.id, want) })
        }
      }
      // Comparators: compare/subtract rear against sides.
      for (const c of comparators) {
        const rear = rearPower(c)
        let side = 0
        for (const inp of this.inputsOf(c)) {
          if (inp.role !== 'side') continue
          side = Math.max(side, this._simPowerOf(inp.node, { dustPower, repeaterOut, comparatorOut, torchLit, sourcesOn }))
        }
        const mode = c.state?.mode === 'subtract' ? 'subtract' : 'compare'
        const want = mode === 'subtract' ? rear >= side && rear - side > 0 : rear > 0 && rear >= side
        if (want !== comparatorOut.get(c.id)) queue.push({ at: t + 1, apply: () => comparatorOut.set(c.id, want) })
      }
      // Apply scheduled transitions due now.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].at <= t) { const q = queue[i]; queue.splice(i, 1); q.apply() }
      }
      const outputs = this.mechanisms().map((m) => ({
        at: m.id,
        kind: m.kind,
        active: powerAt(m) > 0
      }))
      frames.push({
        tick: t,
        dust: Object.fromEntries([...dustPower].map(([k, v]) => [k, v])),
        torches: Object.fromEntries([...torchLit]),
        repeaters: Object.fromEntries([...repeaterOut]),
        comparators: Object.fromEntries([...comparatorOut]),
        observers: Object.fromEntries([...observerPulse]),
        outputs
      })
    }
    // Oscillation detection on mechanism outputs.
    let oscillating = false
    let period = null
    const outs = this.mechanisms()
    for (const m of outs) {
      const series = frames.map((f) => { const o = f.outputs.find((x) => x.at === m.id); return o ? (o.active ? 1 : 0) : 0 })
      for (let p = 2; p <= Math.min(20, Math.floor(series.length / 2)); p++) {
        let same = true
        for (let i = p; i < series.length; i++) if (series[i] !== series[i - p]) { same = false; break }
        if (same && series.some((v, i) => i > 0 && v !== series[i - 1])) { oscillating = true; period = p; break }
      }
      if (oscillating) break
    }
    if (oscillating) notes.push(`output changes periodically with a modelled period of ${period} tick(s) — this is a clock/oscillator in the model, not a server measurement`)
    if (!this.sources().length) notes.push('no sources in this region: the circuit cannot be driven without adding one')
    return { frames, outputs: frames[frames.length - 1]?.outputs || [], oscillating, period, notes }
  }

  _simPowerOf (node, state, fallback = undefined) {
    if (!node) return 0
    const { dustPower, repeaterOut, comparatorOut, torchLit, sourcesOn } = state
    if (node.kind === 'dust') return dustPower.get(node.id) || 0
    if (node.kind === 'repeater') return repeaterOut.get(node.id) ? 15 : 0
    if (node.kind === 'comparator') return comparatorOut.get(node.id) ? 15 : 0
    if (node.kind === 'torch') return torchLit.get(node.id) ? 15 : 0
    if (SOURCE_KINDS.has(node.kind)) return sourcesOn.get(node.id) ? 15 : 0
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
const DESIGNS = {
  and_gate: {
    name: 'and_gate',
    title: 'AND gate (two levers, one output)',
    logic: 'out = A ∧ B',
    footprint: { w: 3, h: 2, d: 3 },
    delayTicks: 2,
    complexity: 2,
    reliability: 'high — pure dust and one repeater, no timing races',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', state: { face: 'floor', facing: 'north' }, note: 'input A' },
      { dx: 2, dy: 0, dz: 0, name: 'lever', state: { face: 'floor', facing: 'north' }, note: 'input B' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire', state: { north: 'side', east: 'side' } },
      { dx: 1, dy: 0, dz: 1, name: 'redstone_wire', state: { west: 'side', east: 'side' } },
      { dx: 2, dy: 0, dz: 1, name: 'redstone_wire', state: { west: 'side', north: 'side' } },
      { dx: 1, dy: 0, dz: 2, name: 'redstone_wire', state: { north: 'side', south: 'side' } },
      { dx: 1, dy: 0, dz: 3, name: 'redstone_lamp', state: {}, note: 'output' }
    ],
    // A and B must BOTH power the shared dust line: each lever feeds its own
    // dust run, and the runs only meet at the middle cell, so the lamp lights
    // only when both are on (this is the classic "two dust inputs, one line" AND
    // — that topology is actually an OR; the AND is built by inverting both.)
    schematic: null,
    caveat: 'This 3-wide dust merge is an OR topology. The catalogue exposes the corrected AND below as `and_gate_torch`.'
  },
  and_gate_torch: {
    name: 'and_gate_torch',
    title: 'AND gate (two torches, NOR-of-inversions)',
    logic: 'out = A ∧ B = ¬(¬A ∨ ¬B)',
    footprint: { w: 3, h: 2, d: 4 },
    delayTicks: 4,
    complexity: 3,
    reliability: 'high — torch inversion, no timing dependence',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'input A' },
      { dx: 2, dy: 0, dz: 0, name: 'lever', note: 'input B' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 2, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 0, dy: 0, dz: 2, name: 'redstone_torch', note: 'inverts A (lit when A is off)' },
      { dx: 2, dy: 0, dz: 2, name: 'redstone_torch', note: 'inverts B (lit when B is off)' },
      { dx: 1, dy: 0, dz: 2, name: 'redstone_wire', note: 'the OR of the two inversions' },
      { dx: 1, dy: 0, dz: 3, name: 'redstone_torch', note: 'inverts the OR → AND' },
      { dx: 1, dy: 1, dz: 3, name: 'redstone_lamp', note: 'output: lit only when A and B are both on' }
    ],
    schematic: null
  },
  or_gate: {
    name: 'or_gate',
    title: 'OR gate (either input powers the line)',
    logic: 'out = A ∨ B',
    footprint: { w: 3, h: 1, d: 3 },
    delayTicks: 0,
    complexity: 1,
    reliability: 'high — one dust run',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'input A' },
      { dx: 2, dy: 0, dz: 0, name: 'lever', note: 'input B' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire', state: { north: 'side', east: 'side' } },
      { dx: 1, dy: 0, dz: 1, name: 'redstone_wire', state: { west: 'side', east: 'side', south: 'side' } },
      { dx: 2, dy: 0, dz: 1, name: 'redstone_wire', state: { west: 'side', north: 'side' } },
      { dx: 1, dy: 0, dz: 2, name: 'redstone_lamp', note: 'output' }
    ]
  },
  not_gate: {
    name: 'not_gate',
    title: 'NOT gate (torch inverter)',
    logic: 'out = ¬A',
    footprint: { w: 1, h: 2, d: 3 },
    delayTicks: 1,
    complexity: 1,
    reliability: 'high — single torch',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'input' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 0, dy: 0, dz: 2, name: 'redstone_torch', note: 'lit when input is off' },
      { dx: 0, dy: 1, dz: 2, name: 'redstone_lamp', note: 'output' }
    ]
  },
  xor_gate: {
    name: 'xor_gate',
    title: 'XOR gate (two comparators in subtract mode)',
    logic: 'out = (A ∨ B) − (A ∧ B)',
    footprint: { w: 5, h: 2, d: 4 },
    delayTicks: 2,
    complexity: 4,
    reliability: 'medium — comparator subtract behaviour; verify sides both read the same strength',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'input A' },
      { dx: 4, dy: 0, dz: 0, name: 'lever', note: 'input B' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 2, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 4, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 1, dy: 0, dz: 2, name: 'comparator', state: { facing: 'south', mode: 'subtract' }, note: 'subtracts the middle line from the left line' },
      { dx: 3, dy: 0, dz: 2, name: 'comparator', state: { facing: 'south', mode: 'subtract' }, note: 'subtracts the middle line from the right line' },
      { dx: 2, dy: 0, dz: 3, name: 'redstone_wire' },
      { dx: 2, dy: 0, dz: 4, name: 'redstone_lamp', note: 'output' }
    ]
  },
  rs_latch: {
    name: 'rs_latch',
    title: 'RS latch (set/reset memory)',
    logic: 'out stays ON after Set pulses; OFF after Reset pulses',
    footprint: { w: 4, h: 2, d: 3 },
    delayTicks: 2,
    complexity: 4,
    reliability: 'high — the classic two-torch latch; both inputs must never be ON at once',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'Set' },
      { dx: 3, dy: 0, dz: 0, name: 'lever', note: 'Reset' },
      { dx: 1, dy: 0, dz: 1, name: 'redstone_torch', note: 'latch torch 1' },
      { dx: 2, dy: 0, dz: 1, name: 'redstone_torch', note: 'latch torch 2' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 3, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 1, dy: 0, dz: 2, name: 'redstone_lamp', note: 'output (follows latch torch 1)' }
    ]
  },
  clock_1hz: {
    name: 'clock_1hz',
    title: 'Clock / oscillator (repeater loop)',
    logic: 'period ≈ 2 × (delay+1) ticks per path',
    footprint: { w: 4, h: 1, d: 2 },
    delayTicks: 8,
    complexity: 3,
    reliability: 'high — but a fast loop anywhere near observers/pistons can cause lag; keep it slow',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'power switch (keep on)' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 1, dy: 0, dz: 1, name: 'redstone_torch', note: 'inverter that closes the loop' },
      { dx: 2, dy: 0, dz: 1, name: 'repeater', state: { facing: 'east', delay: 4 } },
      { dx: 3, dy: 0, dz: 1, name: 'repeater', state: { facing: 'north', delay: 4 } },
      { dx: 3, dy: 0, dz: 0, name: 'repeater', state: { facing: 'west', delay: 4 } },
      { dx: 2, dy: 0, dz: 0, name: 'redstone_wire' },
      { dx: 1, dy: 0, dz: 0, name: 'redstone_wire' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_lamp', note: 'output: blinks' }
    ]
  },
  pulse_extender: {
    name: 'pulse_extender',
    title: 'Pulse extender (lengthen a short pulse)',
    logic: 'a 1-tick pulse becomes a pulse of `delay` ticks',
    footprint: { w: 1, h: 1, d: 4 },
    delayTicks: 4,
    complexity: 2,
    reliability: 'high',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'lever', note: 'input (or a button)' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 0, dy: 0, dz: 2, name: 'repeater', state: { facing: 'north', delay: 4 } },
      { dx: 0, dy: 0, dz: 3, name: 'redstone_lamp', note: 'output (on for 4 ticks)' }
    ]
  },
  item_sorter: {
    name: 'item_sorter',
    title: 'Item sorter channel (hopper + comparator + repeater)',
    logic: 'one item type is pulled out of a hopper line into a target chest',
    footprint: { w: 3, h: 2, d: 3 },
    delayTicks: 2,
    complexity: 4,
    reliability: 'medium — depends on hopper slot layout and comparator fullness thresholds',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'hopper', state: { facing: 'down', enabled: true }, note: 'input line' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 1, dy: 0, dz: 0, name: 'comparator', state: { facing: 'west', mode: 'compare' }, note: 'reads the sorter hopper' },
      { dx: 2, dy: 0, dz: 0, name: 'repeater', state: { facing: 'west', delay: 1 } },
      { dx: 2, dy: 0, dz: 1, name: 'hopper', state: { facing: 'down', enabled: false }, note: 'sorter hopper, locked until its filter fills' },
      { dx: 2, dy: 0, dz: 2, name: 'chest', note: 'destination' }
    ],
    caveat: 'Filter contents (the 41-item layout) must be placed by hand or by a follow-up take/put step; the engine reports the requirement instead of pretending it filled it.'
  },
  state_detector: {
    name: 'state_detector',
    title: 'State detector (observer watching a block)',
    logic: 'pulses once whenever the watched block changes state',
    footprint: { w: 1, h: 1, d: 3 },
    delayTicks: 1,
    complexity: 1,
    reliability: 'high',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'chest', note: 'watched container' },
      { dx: 0, dy: 0, dz: 1, name: 'observer', state: { facing: 'north' }, note: 'faces the chest; output on its back (south)' },
      { dx: 0, dy: 0, dz: 2, name: 'redstone_lamp', note: 'output: 1-tick flash per change' }
    ]
  },
  auto_farm: {
    name: 'auto_farm',
    title: 'Observer-clock farm module (observer + dispenser)',
    logic: 'dispenser fires on the observer clock while the crop is ready',
    footprint: { w: 3, h: 2, d: 4 },
    delayTicks: 6,
    complexity: 5,
    reliability: 'medium — dispenser facing and the observer clock need live verification',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'observer', state: { facing: 'north' }, note: 'watches the crop block' },
      { dx: 0, dy: 0, dz: 1, name: 'redstone_wire' },
      { dx: 1, dy: 0, dz: 1, name: 'repeater', state: { facing: 'west', delay: 2 } },
      { dx: 2, dy: 0, dz: 1, name: 'dispenser', state: { facing: 'north', triggered: false }, note: 'fires bone meal / water bucket' },
      { dx: 2, dy: 0, dz: 2, name: 'chest', note: 'collection' }
    ],
    caveat: 'honey/slime mechanics for item transport are outside this module; the engine reports the module boundary rather than claiming a whole farm.'
  }
}

const DESIGN_ALIASES = {
  and: 'and_gate_torch',
  or: 'or_gate',
  not: 'not_gate',
  xor: 'xor_gate',
  latch: 'rs_latch',
  memory: 'rs_latch',
  clock: 'clock_1hz',
  oscillator: 'clock_1hz',
  pulse: 'pulse_extender',
  pulse_extender: 'pulse_extender',
  sorter: 'item_sorter',
  sorting: 'item_sorter',
  farm: 'auto_farm',
  storage: 'item_sorter',
  detector: 'state_detector',
  observer: 'state_detector'
}

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
function planPlacement (design, origin, { rotate = 'north' } = {}) {
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
  for (const b of d.blocks || []) {
    let dx = b.dx || 0
    let dz = b.dz || 0
    for (let s = 0; s < steps; s++) { const t = dx; dx = -dz; dz = t }
    const state = { ...(b.state || {}) }
    if (state.facing) state.facing = turnDir(state.facing, steps)
    placements.push({
      x: origin.x + dx,
      y: origin.y + (b.dy || 0),
      z: origin.z + dz,
      name: b.name,
      state,
      note: b.note || null
    })
  }
  const materials = {}
  for (const p of placements) materials[p.name] = (materials[p.name] || 0) + 1
  return {
    ok: true,
    design: d.name,
    title: d.title,
    logic: d.logic || null,
    origin,
    rotate,
    placements,
    materials,
    footprint: d.footprint,
    delayTicks: d.delayTicks ?? null,
    caveat: d.caveat || null,
    note: 'orientation is set explicitly per block; placement order below is dependency-safe (supports first)'
  }
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
  { re: /\band\b|ambos|both inputs|duas (alavancas|entradas)|dois (botões|botoes|interruptores)|s[óo] quando (as )?(duas|os dois)|somente quando|only when both|all inputs/i, design: 'and_gate_torch', why: 'AND: two inverted inputs OR-ed then inverted' },
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
  preflight,
  placePlan,
  functionalTest,
  outputActive,
  readState,
  RedstoneLibrary,
  formatFindings,
  formatSimulation,
  DESIGNS,
  HORIZ,
  OPP,
  DIRS,
  MAX_RADIUS,
  PALETTE_NOTE
}
