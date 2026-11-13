/**
 * custom_mineflayer/pathfinder_wrapper.js — upstream-compatible custom pathfinding.
 *
 * Hard rule: we NEVER touch node_modules/mineflayer(-pathfinder).
 * Everything here is either
 *   (a) prototype-level monkey-patching guarded by an idempotence marker, or
 *   (b) extension through official extension points (instance flags, sets,
 *       and exclusion-area hooks), or
 *   (c) behavior implemented in bot-level ticks (open → pass → close).
 *
 * So `npm update mineflayer` / `npm update mineflayer-pathfinder` can pull
 * upstream fixes without breaking this file — as long as the documented hooks
 * still exist. Every patch fails SOFT (logs a warning) instead of crashing
 * the process when upstream shifts underneath us.
 *
 * Implements:
 *   1. Doors and fence gates (see doors.js): judged by their state, opened by
 *      the bot when they are in its way, and put back afterwards — but only
 *      the ones this bot touched. Never broken; iron doors and all trapdoors
 *      are never operated.
 *   2. Digging on request: the route itself never breaks blocks — a walk is
 *      planned through what is there (doors are opened, see 1) and reports
 *      "no path" instead of tunnelling. Breaking is something the MODEL asks
 *      for, with the `dig` tool, which opens a bounded, one-shot corridor
 *      (see beginDigging). Doors stay unbreakable either way.
 *   3. Door cost override: a door that needs a click costs `doorCost`
 *      (default 4) extra — the bot prefers going around when reasonably short.
 *   4. Human movement mimicry: ±2° yaw/pitch micro-jitter, variable
 *      sprint/walk cycles (never 100% sprint), forced walk near hazards,
 *      and 200–800ms idle pauses when the heading changes abruptly.
 *   5. PredictiveThreatMap: every 200 ms each hostile's velocity is sampled
 *      and projected 30–40 ticks (1.5–2 s) forward. The projected endpoint
 *      (a "kill sphere") and the enemy→bot line (a "corridor") are injected
 *      into A* as node cost via the upstream `exclusionAreasStep` hook. Goal
 *      candidates are ranked by distance AND cumulative route threat.
 *   6. WindChargeTraversal: when A* reports noPath and the obstruction is a
 *      3–5 block gap or a ≤4 block wall, the bot equips `wind_charge`, aims
 *      along a computed ballistic angle, right-clicks, then jumps. Chaining
 *      is allowed while more charges remain.
 *   7. scoutSafeAnchor(): pure 30×30 safe-anchor search used by the startup
 *      "Scout & Relocate" routine. Client-side only — no commands, no /tp.
 */
'use strict'

const PATCH_MARK = Symbol.for('zincai.pathfinder.patched')
const DEG = Math.PI / 180
const TICK_MS = 50

const { Vec3 } = require('vec3')
const doors = require('./doors')
const { planEscape } = require('./escape')

const isDoorOrTrapdoorName = (name) => (/_door$/i.test(name) || /_trapdoor$/i.test(name)) && !/iron/i.test(name)

/**
 * Hostiles relevant to movement threat. EXACT names (shared with threats.js):
 * the old substring regex also matched skeleton_horse and zombie_horse.
 */
const { HOSTILE_NAMES } = require('../threats')
const HOSTILE_RE = new RegExp(`^(${[...HOSTILE_NAMES].join('|')})$`, 'i')

const isHostileName = (name) => HOSTILE_NAMES.has(String(name || '').toLowerCase())

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/** Positional projection helper (pure; used by tests and the live map). */
function projectFuture (position, velocity, ticks = 40) {
  if (!position) return null
  const v = velocity || { x: 0, y: 0, z: 0 }
  return {
    x: position.x + (Number(v.x) || 0) * ticks,
    y: position.y + (Number(v.y) || 0) * ticks,
    z: position.z + (Number(v.z) || 0) * ticks
  }
}

/** Squared distance from point p to segment ab (all plain {x,y,z}). */
function pointSegmentDistance (p, a, b) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const apx = p.x - a.x
  const apy = p.y - a.y
  const apz = p.z - a.z
  const denom = abx * abx + aby * aby + abz * abz
  const t = denom < 1e-9 ? 0 : clamp((apx * abx + apy * aby + apz * abz) / denom, 0, 1)
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t)
}

// ===========================================================================
// PredictiveThreatMap
// ===========================================================================
/**
 * Real-time threat field over the local world.
 *
 * For every hostile within `radius` we keep:
 *   - current position + velocity (measured, or estimated from position delta),
 *   - `future` = position + velocity * horizonTicks   (30–40 ticks ≈ 1.5–2 s),
 *   - a scalar weight derived from distance, speed, mob type and whether the
 *     enemy is actually closing on the bot.
 *
 * `costAt(node)` returns an A* node penalty (0..maxPenalty). Two shapes feed it:
 *   · KILL SPHERE  — a ball around the projected point (radius `futureRadius`);
 *   · CORRIDOR     — the capsule between the enemy and the bot's *sampled*
 *                    position, i.e. the path a projectile/charge would take.
 *
 * Sampling is throttled to `sampleMs` (200 ms default) so 20 Hz physics ticks
 * never pay for it, and entries expire so a despawned mob stops scaring A*.
 */
class PredictiveThreatMap {
  /**
   * @param {{
   *   horizonTicks?: number, sampleMs?: number, maxRadius?: number,
   *   futureRadius?: number, corridorRadius?: number, penaltyScale?: number,
   *   maxPenalty?: number, engageWeight?: number, logger?: Function,
   *   now?: () => number, ttlMs?: number, includePlayers?: boolean,
   *   maxSpeed?: number
   * }} [opts]
   */
  constructor (opts = {}) {
    this.horizonTicks = Number.isFinite(opts.horizonTicks) ? opts.horizonTicks : 40 // 2 s
    this.sampleMs = Number.isFinite(opts.sampleMs) ? opts.sampleMs : 200
    this.maxRadius = Number.isFinite(opts.maxRadius) ? opts.maxRadius : 24
    this.futureRadius = Number.isFinite(opts.futureRadius) ? opts.futureRadius : Math.max(1.5, this.horizonTicks / 20)
    this.corridorRadius = Number.isFinite(opts.corridorRadius) ? opts.corridorRadius : 1.6
    this.penaltyScale = Number.isFinite(opts.penaltyScale) ? opts.penaltyScale : 26
    // Upstream treats >=100 as "impossible" in some safeOrBreak paths — never
    // cross that line, threat should reroute A*, not brick it.
    this.maxPenalty = Number.isFinite(opts.maxPenalty) ? Math.min(95, opts.maxPenalty) : 60
    this.engageWeight = Number.isFinite(opts.engageWeight) ? opts.engageWeight : 0.35
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : this.sampleMs * 3
    // Players are never threats by default: on a friendly server they stand
    // next to you. Both harnesses pass an `entityFilter` (ThreatSense.isThreat)
    // instead, which only admits a player who actually hit the bot.
    this.includePlayers = opts.includePlayers === true
    // Sanity ceiling (blocks/tick). Enderman teleports and knockback arrive as
    // huge position deltas; without this clamp they project 40-block phantom
    // kill zones and A* refuses to move at all.
    this.maxSpeed = Number.isFinite(opts.maxSpeed) ? opts.maxSpeed : 1.0
    // How many threats the field keeps. The old cap of 12 made the map blind
    // to the back half of a horde; 48 costs microseconds per A* node.
    this.maxThreats = Number.isFinite(opts.maxThreats) ? opts.maxThreats : 48
    // The corridor (enemy → bot line) is cut this many blocks short of the bot.
    // Every corridor ends ON the bot, so without the cut the cells around the
    // bot were the most expensive on the map and A* refused to leave them.
    this.corridorClear = Number.isFinite(opts.corridorClear) ? opts.corridorClear : 3
    // Optional predicate: which entities are real threats (line of sight,
    // reachability, recent attackers). Default: hostile names (+ opt-in players).
    this.entityFilter = typeof opts.entityFilter === 'function' ? opts.entityFilter : null
    this.total = 0
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.logger = opts.logger || (() => {})

    /** @type {Array<object>} live threats (projected + weighted) */
    this.threats = []
    this.anchor = null // bot position at last sample (corridor target)
    this._prev = new Map() // id -> { position, at }
    this._lastSample = 0
    this._lastSummary = ''
    this._samples = 0
  }

  /** Hostiles within `radius` of the bot, nearest first. */
  scan (bot) {
    const out = []
    if (!bot?.entity?.position) return out
    const me = bot.entity.position
    for (const id of Object.keys(bot.entities || {})) {
      const e = bot.entities[id]
      if (!e || !e.position || e === bot.entity) continue
      const isPlayer = e.type === 'player' || e.name === 'player'
      if (this.entityFilter) {
        if (!this.entityFilter(e)) continue
      } else if (isPlayer) {
        if (!this.includePlayers) continue
      } else if (!isHostileName(e.name)) continue
      const d = dist3(e.position, me)
      if (d > this.maxRadius) continue
      out.push({ entity: e, distance: d, isPlayer })
    }
    out.sort((a, b) => a.distance - b.distance)
    return out
  }

  /** Clamp absurd deltas (teleport packets, knockback) to a sane speed. */
  _saneVelocity (v) {
    const speed = Math.hypot(v.x, v.y, v.z)
    if (!(speed > this.maxSpeed)) return v
    const k = this.maxSpeed / speed
    return { x: v.x * k, y: v.y * k, z: v.z * k }
  }

  /**
   * Velocity in blocks/tick. Position deltas between our own samples are the
   * ground truth: the velocity field mineflayer exposes for OTHER entities is
   * stale on most versions and mis-scaled (÷8000) on 26.x. The field is only
   * used for the very first sample, and only when it is a plausible speed.
   */
  velocityOf (entity, nowMs) {
    const prev = this._prev.get(entity.id)
    if (prev && nowMs > prev.at) {
      const ticks = Math.max(1, (nowMs - prev.at) / TICK_MS)
      const est = {
        x: (entity.position.x - prev.position.x) / ticks,
        y: (entity.position.y - prev.position.y) / ticks,
        z: (entity.position.z - prev.position.z) / ticks
      }
      // A stationary sample cluster is noise, not a velocity.
      if (Math.hypot(est.x, est.y, est.z) < 0.002) return { x: 0, y: 0, z: 0 }
      return this._saneVelocity(est)
    }
    const v = entity.velocity
    if (v) {
      // Horizontal and vertical are judged separately: the gravity constant
      // (-0.0784) every grounded mob reports must not vouch for a 2e-4 walk.
      const vx = Number(v.x) || 0
      const vy = Number(v.y) || 0
      const vz = Number(v.z) || 0
      const moving = Math.hypot(vx, vz) >= 0.01
      const out = { x: moving ? vx : 0, y: Math.abs(vy) >= 0.1 ? vy : 0, z: moving ? vz : 0 }
      if (out.x || out.y || out.z) return this._saneVelocity(out)
    }
    return { x: 0, y: 0, z: 0 }
  }

  /** Threat weight ∈ [0.4, ~4.5]: proximity, speed, type, closing rate. */
  _weight (entity, pos, velocity, botPos) {
    const d = clamp(dist3(pos, botPos) / this.maxRadius, 0, 1)
    let w = 0.4 + (1 - d) * 1.6
    const speed = Math.hypot(velocity.x, velocity.z)
    w += clamp(speed / 0.30, 0, 1) * 0.8
    const name = String(entity.name || '').toLowerCase()
    if (entity.type === 'player' || name === 'player') w *= 1.3 // armed players close fast
    if (/creeper|breeze/.test(name)) w *= 1.5 // explosion / wind burst
    if (/warden|ravager|wither/.test(name)) w *= 1.8
    if (/phantom|vex/.test(name)) w *= 1.2 // 3D approach
    // Closing rate: velocity projected onto the enemy→bot axis.
    const ax = botPos.x - pos.x
    const az = botPos.z - pos.z
    const alen = Math.hypot(ax, az) || 1
    const closing = (velocity.x * ax + velocity.z * az) / alen
    if (closing > 0.02) w *= 1 + clamp(closing / 0.3, 0, 1) * 0.35
    return w
  }

  /**
   * Refresh the threat field. Throttled to `sampleMs` unless `force`.
   * @returns {Array<object>} current threats
   */
  sample (bot, force = false) {
    const now = this.now()
    if (!force && now - this._lastSample < this.sampleMs) return this.threats
    this._lastSample = now
    this._samples++
    if (!bot?.entity?.position) { this.threats = []; this.anchor = null; return this.threats }

    const botPos = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
    this.anchor = botPos
    const threats = []
    for (const { entity, distance } of this.scan(bot)) {
      const pos = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
      const velocity = this.velocityOf(entity, now)
      const future = projectFuture(pos, velocity, this.horizonTicks)
      // Gravity makes naive vertical extrapolation dishonest: a jumping mace
      // user with vy=0.42 would project 16 blocks into the sky. Keep the kill
      // sphere near the ground plane (±3 blocks), which is where the hit lands.
      // A mob standing on the ground reports the gravity constant (-0.0784)
      // as vertical speed; projecting that sank its kill sphere 3 blocks into
      // the floor. Only real vertical motion moves the sphere.
      const vy = Math.abs(velocity.y || 0) < 0.1 ? 0 : velocity.y
      future.y = pos.y + clamp(vy * this.horizonTicks, -3, 3)
      // Corridor target: `corridorClear` blocks short of the bot (null = none).
      let corridorEnd = null
      const cdx = pos.x - botPos.x; const cdy = pos.y - botPos.y; const cdz = pos.z - botPos.z
      const clen = Math.hypot(cdx, cdy, cdz)
      if (clen > this.corridorClear + 0.5) {
        const k = this.corridorClear / clen
        corridorEnd = { x: botPos.x + cdx * k, y: botPos.y + cdy * k, z: botPos.z + cdz * k }
      }
      threats.push({
        id: entity.id,
        name: String(entity.name || 'hostile').toLowerCase(),
        position: pos,
        velocity,
        future,
        distance,
        speed: Math.hypot(velocity.x, velocity.z),
        weight: this._weight(entity, pos, velocity, botPos),
        radius: this.futureRadius,
        corridorRadius: this.corridorRadius,
        corridorEnd,
        sampledAt: now,
        expiresAt: now + this.ttlMs
      })
      this._prev.set(entity.id, { position: pos, at: now })
    }
    // Drop stale trackers (despawns) and expired threats.
    const liveIds = new Set(threats.map((t) => t.id))
    for (const id of this._prev.keys()) if (!liveIds.has(id)) this._prev.delete(id)
    this.total = threats.length
    this.threats = threats.filter((t) => t.expiresAt > now).slice(0, this.maxThreats)
    this._lastSummary = this._buildSummary()
    return this.threats
  }

  /** Keep the field warm even when no navigation is active. */
  tick (bot) { return this.sample(bot) }

  /**
   * Cumulative threat score at a world point. 0 = safe, ~1 = standing in a
   * projected kill sphere. Not clamped: overlapping mobs stack.
   */
  threatScoreAt (point, { yWeight = 0.45 } = {}) {
    if (!point) return 0
    let score = 0
    for (const t of this.threats) {
      if (!t || t.expiresAt <= this.now()) continue
      const df = Math.hypot(point.x - t.future.x, (point.y - t.future.y) * yWeight, point.z - t.future.z)
      if (df < t.radius) score += (1 - df / t.radius) * t.weight
      if (t.corridorEnd) {
        const dLine = pointSegmentDistance(point, t.position, t.corridorEnd)
        if (dLine < t.corridorRadius) score += (1 - dLine / t.corridorRadius) * t.weight * 0.75
      }
    }
    return score
  }

  /** Integer A* node penalty, bounded below upstream's hard "impossible" line. */
  costAt (point) {
    if (!point || this.threats.length === 0) return 0
    return Math.round(clamp(this.threatScoreAt(point) * this.penaltyScale, 0, this.maxPenalty))
  }

  /** Cumulative threat along a straight route, sampled every ~2 blocks. */
  pathThreat (from, to, samples = 12) {
    if (!from || !to) return 0
    let sum = 0
    const n = Math.max(2, Math.min(32, samples))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      sum += this.threatScoreAt({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t })
    }
    return sum / n
  }

  /**
   * Priority routing: rank candidate destinations by
   *   score = distance + threatLambda * routeThreat * (1 + distance / 8)
   * so a route twice as long but through open ground beats a short murder alley.
   * @param {Array<{x:number,y:number,z:number}>} candidates
   * @param {{x,y,z}} from
   * @param {{lambda?:number, samples?:number}} [opts]
   */
  rankGoals (candidates, from, { lambda = 14, samples = 12 } = {}) {
    if (!Array.isArray(candidates) || !from) return []
    return candidates
      .filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z))
      .map((c) => {
        const distance = dist2(from, c)
        const threat = this.pathThreat(from, c, samples)
        return { ...c, distance, threat, score: distance + lambda * threat * (1 + distance / 8) }
      })
      .sort((a, b) => a.score - b.score)
  }

  /** Weighted unit vector (XZ) pointing away from where the threats WILL be. */
  escapeVector (from) {
    if (!from) return { x: 1, z: 0 }
    let sx = 0
    let sz = 0
    for (const t of this.threats) {
      if (!t || t.expiresAt <= this.now()) continue
      const p = t.future || t.position
      const dx = from.x - p.x
      const dz = from.z - p.z
      const len = Math.hypot(dx, dz)
      if (len < 0.01) { sx += 1; continue }
      // Closer projected threats dominate the escape direction.
      const w = t.weight * (1 + clamp(1 - len / this.maxRadius, 0, 1))
      sx += (dx / len) * w
      sz += (dz / len) * w
    }
    const len = Math.hypot(sx, sz)
    if (len < 0.01) return { x: 1, z: 0 }
    return { x: sx / len, z: sz / len }
  }

  /** One compact line for logs/prompts — never a block dump. Always carries the total. */
  _buildSummary () {
    if (!this.threats.length) return 'threats: none'
    const byName = new Map()
    for (const t of this.threats) byName.set(t.name, (byName.get(t.name) || 0) + 1)
    const counts = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => (c > 1 ? `${n} x${c}` : n))
    const maxScore = Math.max(...this.threats.map((t) => t.weight))
    const near = this.threats[0]
    const closing = near.speed > 0.05 ? ', closing' : ''
    return `threats: ${this.total} (${counts.join(', ')}), nearest ${near.name} ${near.distance.toFixed(1)}m${closing}${maxScore > 3 ? ' — HIGH' : ''}`
  }

  summary () {
    if (!this.threats.length) return this._lastSummary || 'threats: none'
    return this._lastSummary || this._buildSummary()
  }

  /**
   * Inject the live field into A*: every candidate move pays the threat cost
   * of the cell it steps INTO, exactly once.
   *
   * The old version used upstream's `exclusionAreasStep` hook. Upstream calls
   * that hook three or four times per move (feet twice, head, diagonals) and
   * throws away any move whose running cost exceeds 100, so a 60-point
   * penalty turned into "impossible" and A* returned noPath whenever the bot
   * was surrounded — exactly when it had to move. Adding the cost after
   * upstream has finished its feasibility checks keeps threat a *preference*.
   * @returns {boolean} true when attached
   */
  attachToMovements (movements) {
    if (!movements || typeof movements.getNeighbors !== 'function') return false
    if (movements._zincaiThreatCost) return true
    const map = this
    const original = movements.getNeighbors
    movements.getNeighbors = function (node) {
      const neighbors = original.call(this, node)
      if (map.threats.length === 0) return neighbors
      for (const n of neighbors) n.cost += map.costAt({ x: n.x + 0.5, y: n.y, z: n.z + 0.5 })
      return neighbors
    }
    movements._zincaiThreatCost = true
    return true
  }

  /** Test/teardown helper. */
  clear () {
    this.threats = []
    this.anchor = null
    this._prev.clear()
    this._lastSummary = ''
  }

  get sampleCount () { return this._samples }
}

// ===========================================================================
// WindChargeTraversal
// ===========================================================================
const WIND_CHARGE_ITEM = 'wind_charge'

/**
 * Vanilla wind-charge traversal. A wind charge pushes entities away from the
 * burst point; a player who jumps and detonates it at the ground below/behind
 * gets a large vertical + horizontal impulse. This class computes whether the
 * obstruction in front is a 3–5 wide gap or a ≤4 high wall, then performs:
 *
 *   equip wind_charge → look along computed angle → activateItem() → jump
 *
 * Chaining is supported and capped (`maxChain`) so a ravine too wide for one
 * burst can be crossed with two or three — each is a real item from the hotbar.
 */
class WindChargeTraversal {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ maxChain?:number, minGap?:number, maxGap?:number, maxWall?:number,
   *           logger?:Function, now?:() => number, enabled?:boolean }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.maxChain = Number.isFinite(opts.maxChain) ? opts.maxChain : 3
    this.minGap = Number.isFinite(opts.minGap) ? opts.minGap : 3
    this.maxGap = Number.isFinite(opts.maxGap) ? opts.maxGap : 5
    this.maxWall = Number.isFinite(opts.maxWall) ? opts.maxWall : 4
    this.enabled = opts.enabled !== false
    this.logger = opts.logger || (() => {})
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this._busy = false
    this.lastActionAt = 0
  }

  /** All wind charges carried (any slot). */
  charges () {
    try {
      return (this.bot.inventory?.items?.() || []).filter((i) => i && i.name === WIND_CHARGE_ITEM)
    } catch { return [] }
  }

  count () { return this.charges().reduce((s, i) => s + (i.count || 1), 0) }

  hasCharges () { return this.count() > 0 }

  _blockAt (x, y, z) {
    try {
      const { Vec3 } = require('vec3')
      return this.bot.blockAt(new Vec3(Math.round(x), Math.round(y), Math.round(z)))
    } catch { return null }
  }

  _solidAt (x, y, z) {
    const b = this._blockAt(x, y, z)
    if (!b) return true // unloaded chunk: assume solid, never gamble
    return b.boundingBox === 'block'
  }

  _airAt (x, y, z) {
    const b = this._blockAt(x, y, z)
    return Boolean(b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'))
  }

  /**
   * Inspect the corridor in `direction` for a wind-charge-able obstruction.
   * @param {{x:number,z:number}} direction unit XZ vector
   * @param {{reach?:number}} [opts]
   * @returns {null | {kind:'gap'|'wall', width?:number, height?:number,
   *   distance:number, landing?:{x,y,z}, pitchDeg:number, direction:{x,z}}}
   */
  analyze (direction, { reach = 8 } = {}) {
    const pos = this.bot.entity?.position
    if (!pos) return null
    const len = Math.hypot(direction?.x || 0, direction?.z || 0)
    if (len < 1e-6) return null
    const dx = direction.x / len
    const dz = direction.z / len
    const fx = Math.floor(pos.x)
    const fy = Math.floor(pos.y)
    const fz = Math.floor(pos.z)

    // --- gap: floor disappears, then reappears within 3..5 blocks ----------
    let gapStart = null
    for (let d = 1; d <= reach; d++) {
      const x = fx + Math.round(dx * d)
      const z = fz + Math.round(dz * d)
      const floorSolid = this._solidAt(x, fy - 1, z)
      const bodyClear = !this._solidAt(x, fy, z) && !this._solidAt(x, fy + 1, z)
      if (gapStart === null) {
        if (!floorSolid && bodyClear) gapStart = d
      } else if (floorSolid) {
        const width = d - gapStart
        if (width >= this.minGap && width <= this.maxGap) {
          return {
            kind: 'gap',
            width,
            distance: gapStart,
            landing: { x: fx + Math.round(dx * (d + 1)), y: fy, z: fz + Math.round(dz * (d + 1)) },
            // Aim down-forward: the burst under/behind the player converts
            // sprint momentum into height + carry.
            pitchDeg: -45,
            direction: { x: dx, z: dz }
          }
        }
        gapStart = null
      }
    }

    // --- wall: 3..4 solid blocks in front with clear air above --------------
    for (let d = 1; d <= 2; d++) {
      const x = fx + Math.round(dx * d)
      const z = fz + Math.round(dz * d)
      let height = 0
      for (let h = 0; h <= this.maxWall + 2; h++) {
        if (this._solidAt(x, fy + h, z)) height++
        else break
      }
      const topClear = this._airAt(x, fy + height, z) && this._airAt(x, fy + height + 1, z)
      if (height >= this.minGap && height <= this.maxWall && topClear) {
        return {
          kind: 'wall',
          height,
          distance: d,
          landing: { x: fx + Math.round(dx * (d + 1)), y: fy + height, z: fz + Math.round(dz * (d + 1)) },
          // Nearly straight down: maximum vertical impulse to clear the lip.
          pitchDeg: -68,
          direction: { x: dx, z: dz }
        }
      }
    }
    return null
  }

  _yawFor (direction) {
    // mineflayer yaw 0 faces north (-z); the look vector is (-sin yaw, -cos yaw).
    // Same formula upstream pathfinder uses: bot.look(atan2(-dx, -dz)).
    return Math.atan2(-direction.x, -direction.z)
  }

  /**
   * Execute ONE wind charge. Exact order is part of the contract:
   * equip → look → activateItem → jump.
   * @returns {Promise<{ok:boolean, why?:string}>}
   */
  async use ({ pitchDeg = -45, direction = { x: 0, z: 1 } } = {}) {
    if (!this.enabled) return { ok: false, why: 'disabled' }
    const item = this.charges()[0]
    if (!item) return { ok: false, why: 'no_charge' }
    const bot = this.bot
    try {
      await bot.equip(item, 'hand')
      await bot.look(this._yawFor(direction), pitchDeg * DEG, true)
      bot.activateItem()
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch { /* gone */ } }, 200)
      this.lastActionAt = this.now()
      this.logger('debug', `wind charge: ${pitchDeg}° toward ${direction.x.toFixed(2)},${direction.z.toFixed(2)} (${this.count()} left)`)
      return { ok: true }
    } catch (err) {
      this.logger('warn', `wind charge failed: ${err.message || err}`)
      return { ok: false, why: `equip_failed:${err.message || err}` }
    }
  }

  /**
   * Cross/scale the obstruction in `direction`, chaining charges when the first
   * burst lands short. Stops as soon as the obstruction is no longer detected.
   * @returns {Promise<{ok:boolean, used:number, why?:string, kind?:string}>}
   */
  async traverse (direction, { maxChain = this.maxChain } = {}) {
    if (!this.enabled) return { ok: false, used: 0, why: 'disabled' }
    if (!this.hasCharges()) return { ok: false, used: 0, why: 'no_charge' }
    if (this._busy) return { ok: false, used: 0, why: 'busy' }
    if (this.now() - this.lastActionAt < 300) return { ok: false, used: 0, why: 'cooldown' }
    this._busy = true
    let used = 0
    let kind = null
    try {
      for (let i = 0; i < Math.max(1, maxChain); i++) {
        if (!this.hasCharges()) break
        const plan = this.analyze(direction)
        if (i === 0 && !plan) return { ok: false, used, why: 'no_obstruction' }
        if (i > 0 && !plan) break // cleared — momentum carries the rest
        kind = plan.kind
        const r = await this.use({ pitchDeg: plan.pitchDeg, direction: plan.direction })
        if (!r.ok) return { ok: false, used, why: r.why, kind }
        used++
        await new Promise((res) => setTimeout(res, 420))
      }
      return { ok: used > 0, used, kind }
    } finally {
      this._busy = false
    }
  }

  /** Aim at an arbitrary world point and traverse toward it. */
  async traverseTo (goal) {
    const pos = this.bot.entity?.position
    if (!pos || !goal) return { ok: false, used: 0, why: 'no_position' }
    const direction = { x: goal.x - pos.x, z: goal.z - pos.z }
    if (Math.hypot(direction.x, direction.z) < 2) return { ok: false, used: 0, why: 'too_close' }
    return this.traverse(direction)
  }
}

// ===========================================================================
// Scout & Relocate — pure safe-anchor search
// ===========================================================================
/** First standable ground Y at (x,z), scanning a small vertical window. */
function findGroundY (bot, x, z, { up = 3, down = 6 } = {}) {
  const pos = bot?.entity?.position
  if (!pos) return null
  const base = Math.floor(pos.y)
  for (let y = base + up; y >= base - down; y--) {
    try {
      const { Vec3 } = require('vec3')
      const ground = bot.blockAt(new Vec3(x, y - 1, z))
      const feet = bot.blockAt(new Vec3(x, y, z))
      const head = bot.blockAt(new Vec3(x, y + 1, z))
      if (!ground || !feet || !head) continue
      if (ground.boundingBox !== 'block') continue
      const feetClear = feet.boundingBox !== 'block'
      const headClear = head.boundingBox !== 'block'
      if (feetClear && headClear) return y
    } catch { return null }
  }
  return null
}

const HAZARD_NAMES = /lava|fire|magma|cactus|sweet_berry|powder_snow|wither_rose|campfire/
/** Blocks that burn whoever stands on them. */
const FLOOR_HAZARD = /^(magma_block|campfire|soul_campfire)$/
/** Blocks a player must not walk INTO (upstream already avoids fire, lava and cobwebs). */
const WALK_IN_HAZARDS = ['sweet_berry_bush', 'powder_snow', 'wither_rose', 'cactus']

/**
 * Where to run from the threats in `threatMap`. Pure planning — it never
 * touches the controls; whoever calls it owns those (the survival reflex,
 * through its arbiter lane).
 *
 * Picks the lowest-threat destination among three fan-out candidates along
 * the predictive escape vector (away from where the threats WILL be).
 * Standalone so a harness without the full wrapper can use it too.
 *
 * @param {object} bot
 * @param {PredictiveThreatMap} threatMap
 * @param {{ distance?: number }} [opts]
 * @returns {{ goal: object, direction: {x:number,z:number}, x:number, y:number, z:number, threat:number } | null}
 */
function fleePlan (bot, threatMap, { distance = 14 } = {}) {
  const pos = bot.entity?.position
  if (!pos || !threatMap) return null
  threatMap.sample(bot, true)
  if (!threatMap.threats.length) return null
  const base = threatMap.escapeVector(pos)
  const perp = { x: -base.z, z: base.x }
  const candidates = [0, 0.55, -0.55].map((bend) => {
    const dx = base.x + perp.x * bend
    const dz = base.z + perp.z * bend
    const len = Math.hypot(dx, dz) || 1
    return { x: pos.x + (dx / len) * distance, y: Math.floor(pos.y), z: pos.z + (dz / len) * distance, dir: { x: dx / len, z: dz / len } }
  })
  const best = threatMap.rankGoals(candidates, pos)[0]
  if (!best) return null
  const { goals } = require('mineflayer-pathfinder')
  // XZ goal: any height will do, so a hill or a pit never makes "away" unreachable.
  const goal = new goals.GoalNearXZ(Math.floor(best.x), Math.floor(best.z), 2)
  return { goal, direction: best.dir || base, x: Math.floor(best.x), y: Math.floor(best.y), z: Math.floor(best.z), threat: best.threat }
}

/**
 * Upstream avoids fire, cobwebs and lava. These also hurt or trap a player who
 * walks into them, and one of them (farmland) is somebody's work.
 */
function configureHazards (bot, movements) {
  const registry = bot.registry
  if (!registry?.blocksByName || !movements.blocksToAvoid) return
  for (const name of WALK_IN_HAZARDS) {
    const block = registry.blocksByName[name]
    if (block) movements.blocksToAvoid.add(block.id)
  }
  // Standing ON these: magma and campfires burn; farmland is trampled by a jump or a drop.
  if (Array.isArray(movements.exclusionAreasStep) && !movements.exclusionAreasStep.some((f) => f && f._zincaiFloorHazard)) {
    const fee = (block) => {
      if (!block?.position) return 0
      let below = null
      try { below = bot.blockAt(block.position.offset(0, -1, 0), false) } catch { below = null }
      if (!below) return 0
      if (FLOOR_HAZARD.test(below.name)) return 20
      if (below.name === 'farmland') return 6
      return 0
    }
    fee._zincaiFloorHazard = true
    movements.exclusionAreasStep.push(fee)
  }
}

/** A Movements used only to flood the ground for an escape: geometry, no building, no parkour, no drop that hurts. */
function escapeMovementsFor (bot, Movements, configureDoors) {
  const m = new Movements(bot)
  m.canDig = false
  m.digCost = 1000
  m.allow1by1towers = false
  m.scafoldingBlocks = []
  m.allowParkour = false
  m.allowSprinting = true
  m.allowEntityDetection = false
  m.maxDropDown = 3
  configureDoors(m)
  configureHazards(bot, m)
  return m
}

/** Run the escape planner over `movements` and attach a pathfinder goal to the result. */
function escapePlanWith (bot, movements, pursuers, opts = {}) {
  const floorHazard = (x, y, z) => {
    let below = null
    try { below = bot.blockAt(new Vec3(x, y - 1, z), false) } catch { below = null }
    return below && FLOOR_HAZARD.test(below.name) ? 12 : 0
  }
  const plan = planEscape(bot, movements, pursuers, { avoid: floorHazard, ...opts })
  if (!plan) return null
  const { goals } = require('mineflayer-pathfinder')
  plan.goal = new goals.GoalNear(plan.target.x, plan.target.y, plan.target.z, 1)
  return plan
}

/**
 * The wall-aware escape planner for a harness that does not run the whole
 * wrapper (harness A). Nothing there clicks doors, so only doors that already
 * stand open count as a way through.
 * @returns {(pursuers: object[], opts?: object) => object|null}
 */
function makeEscapePlanner (bot, { Movements } = {}) {
  let movements = null
  let builtFor = null
  return function escapePlan (pursuers, opts = {}) {
    if (!Movements || !bot?.entity) return null
    const live = bot.pathfinder?.movements || null
    if (!movements || builtFor !== live) {
      try { movements = escapeMovementsFor(bot, Movements, (m) => doors.attachDoors(m, { operate: false })) } catch { return null }
      builtFor = live
    }
    return escapePlanWith(bot, movements, pursuers, opts)
  }
}

/**
 * Evaluate a 30×30 (radius 15) neighbourhood and pick the best organic anchor:
 *   - as far as possible from hostile *projected* positions (vector away),
 *   - no lava/fire/cactus/cliff within 2 blocks,
 *   - open sky + standable ground preferred,
 *   - not welded to the spawn point (prefer 8–20 blocks out).
 * Pure: only `bot.blockAt`, `bot.entity`, `bot.entities` are touched.
 *
 * @param {{radius?:number, step?:number, maxThreatDistance?:number,
 *   horizonTicks?:number, minRadius?:number, preferRadius?:number,
 *   avoid?:Array<{x:number,z:number,radius?:number}>}} [opts]
 *   `avoid` excludes cells near recent death points / known bad spots.
 * @returns {null | {x:number,y:number,z:number,score:number,reasons:string[],
 *   threats:number, away:{x:number,z:number}, hostiles:Array}}
 */
function scoutSafeAnchor (bot, {
  radius = 15,
  step = 3,
  maxThreatDistance = 24,
  horizonTicks = 40,
  minRadius = 5,
  preferRadius = 12,
  avoid = []
} = {}) {
  const pos = bot?.entity?.position
  if (!pos) return null

  // --- hostile field: current + projected positions -----------------------
  const hostiles = []
  for (const id of Object.keys(bot.entities || {})) {
    const e = bot.entities[id]
    if (!e || !e.position || e === bot.entity) continue
    if (e.type === 'player' || !isHostileName(e.name)) continue
    const velocity = e.velocity || { x: 0, y: 0, z: 0 }
    const future = projectFuture(e.position, velocity, horizonTicks)
    hostiles.push({
      name: String(e.name || 'hostile').toLowerCase(),
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
      future,
      speed: Math.hypot(velocity.x || 0, velocity.z || 0)
    })
  }

  // Vector away from the mob centroid (mandate: "a vector away from the mobs").
  let away = { x: 1, z: 0 }
  if (hostiles.length) {
    let cx = 0
    let cz = 0
    for (const h of hostiles) { cx += h.future.x; cz += h.future.z }
    cx /= hostiles.length
    cz /= hostiles.length
    const ax = pos.x - cx
    const az = pos.z - cz
    const len = Math.hypot(ax, az)
    away = len > 0.01 ? { x: ax / len, z: az / len } : { x: 1, z: 0 }
  }

  let best = null
  const bx = Math.floor(pos.x)
  const bz = Math.floor(pos.z)
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const x = bx + dx
      const z = bz + dz
      const distFromBot = Math.hypot(dx, dz)
      if (distFromBot < minRadius) continue // don't "relocate" onto our own feet
      // Never re-anchor in the kill zone that just killed us.
      let blacklisted = false
      for (const a of avoid) {
        if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) continue
        if (Math.hypot(x - a.x, z - a.z) < (a.radius ?? 10)) { blacklisted = true; break }
      }
      if (blacklisted) continue
      const y = findGroundY(bot, x, z)
      if (y === null) continue
      const candidate = { x, y, z }
      const reasons = []

      // Threat integral over projected hostile positions.
      let threat = 0
      for (const h of hostiles) {
        const d = Math.hypot(x - h.future.x, z - h.future.z)
        if (d < maxThreatDistance) threat += (1 - d / maxThreatDistance) * (1 + h.speed * 2)
      }
      if (threat === 0) reasons.push('no nearby threats')

      // Local hazards — feet level AND the block we would stand on/step into.
      let hazard = 0
      let sky = 0
      let water = 0
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          for (let oz = -2; oz <= 2; oz++) {
            const b = (() => {
              try {
                const { Vec3 } = require('vec3')
                return bot.blockAt(new Vec3(x + ox, y + oy, z + oz))
              } catch { return null }
            })()
            if (!b) continue
            if (HAZARD_NAMES.test(b.name || '')) hazard += oy === 0 ? 2 : 1
            if (oy === 0 && (ox !== 0 || oz !== 0) && /water/.test(b.name || '')) water += 1
          }
        }
      }
      for (let oy = 1; oy <= 4; oy++) {
        const b = (() => {
          try {
            const { Vec3 } = require('vec3')
            return bot.blockAt(new Vec3(x, y + oy, z))
          } catch { return null }
        })()
        if (b && b.boundingBox === 'block') sky += 1 // ceiling
      }
      // Ledge probe: a 2-block walk in each cardinal direction must still have
      // floor within 3 blocks of our feet, otherwise the "safe" cell is a cliff.
      let ledges = 0
      for (const [ldx, ldz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        let hasFloor = false
        for (let drop = 1; drop <= 3; drop++) {
          const b = (() => {
            try {
              const { Vec3 } = require('vec3')
              return bot.blockAt(new Vec3(x + ldx, y - drop, z + ldz))
            } catch { return null }
          })()
          if (b && b.boundingBox === 'block') { hasFloor = true; break }
        }
        if (!hasFloor) ledges += 1
      }
      if (hazard > 0) reasons.push('hazard nearby')
      if (ledges > 0) reasons.push('ledge nearby')
      if (sky >= 4) reasons.push('enclosed')
      if (water > 0) reasons.push('water access')

      // Heads-away alignment with the hostile centroid.
      const heading = distFromBot > 0.01 ? (dx * away.x + dz * away.z) / distFromBot : 0
      if (heading > 0.5) reasons.push('away from mobs')

      const score =
        -threat * 10 -
        hazard * 6 -
        ledges * 2.5 -
        sky * 1.5 +
        water * 0.8 +
        heading * 4 -
        Math.abs(distFromBot - preferRadius) * 0.25

      if (!best || score > best.score) {
        best = {
          x,
          y,
          z,
          score: Math.round(score * 100) / 100,
          reasons: reasons.length ? reasons : ['open ground'],
          threats: hostiles.length,
          away,
          hostiles: hostiles.slice(0, 6)
        }
      }
    }
  }
  return best
}

// ===========================================================================
// PathfinderWrapper
// ===========================================================================
class PathfinderWrapper {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ allowScaffolding?: boolean, doorCost?: number,
   *           jitterDegrees?: number, logger?: (level:string,msg:string)=>void,
   *           threat?: object, windCharge?: object, enableWindCharge?: boolean,
   *           isUrgent?: () => boolean }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    // Digging is not an operator switch any more: planning never breaks blocks,
    // and a `dig` request grants the pathfinder a corridor for exactly one walk.
    // { canDig: Set<blockId|null>, cantDig: Set<blockId|null>, expiresAt } | null
    this._digWindow = null
    this._digTimer = null
    // Pillaring up and bridging with dirt/cobblestone is upstream's default.
    // Around other people's builds that is griefing, so it is OFF unless the
    // operator opts in (behavior.allowScaffolding) for wilderness travel.
    this.allowScaffolding = opts.allowScaffolding === true
    this.doorCost = Number.isFinite(opts.doorCost) ? opts.doorCost : 4
    this.jitterRad = ((opts.jitterDegrees ?? 2) * DEG)
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {}
    // "Urgent" = someone is fleeing or fighting. The humanizer (pauses, walk
    // phases, look jitter) must never slow that down.
    this.isUrgent = typeof opts.isUrgent === 'function' ? opts.isUrgent : () => false
    // Doors and gates THIS bot opened: key → { position, kind, name, restoreOpen, at, lastClick }.
    // Only these are ever closed again.
    this._opened = new Map()
    this._doorClicks = new Map() // key → { at, open, tries }
    this._jammed = new Map() // key → until (ms): would not open, routed around
    this.lastJam = null // { x, y, z, name, at } — for "why is there no path"
    this._path = null // the pathfinder's live path (same array it consumes)
    this._onPathSeen = null
    this._jitterTimer = null
    this._sprintTimer = null
    this._sprintWalkPhase = 'sprint'
    this._lastHeading = null
    this._pauseUntil = 0
    this._applied = []
    this._tickHandlers = [] // physicsTick listeners we own — removed in stop()

    // Movement posture, chosen by the WRAPPER from what the body is doing, not
    // by the model picking a persona:
    //
    //   'balanced' (default)  normal sprint-walk rhythm, drops up to 4
    //   'careful'             steady, no sprint, drops of 1 — while placing blocks
    //                         or carrying something it must not lose
    //   'urgent'              sprint-jump parkour — while fleeing or fighting
    //
    // There is no `set_mode` tool any more. Prefer `setCareful(bool)` and let
    // isUrgent() win, which is what the body already knows how to do.
    this.mode = 'balanced'
    this._careful = false
    this.fleeRadius = Number.isFinite(opts.fleeRadius) ? opts.fleeRadius : 8
    this._jumpSprintTimer = null

    // --- predictive threat + wind charge ----------------------------------
    this.threat = opts.threat instanceof PredictiveThreatMap
      ? opts.threat
      : new PredictiveThreatMap({ ...(opts.threat || {}), logger: this.log })
    this.windCharge = opts.windCharge instanceof WindChargeTraversal
      ? opts.windCharge
      : new WindChargeTraversal(bot, { enabled: opts.enableWindCharge !== false, logger: this.log, ...(opts.windCharge || {}) })
    this.enableWindCharge = opts.enableWindCharge !== false
    this._threatTimer = null
    this._windBusy = false
    this._windAttempts = 0
    this._onPathUpdate = null
    this._appliedOnce = false
  }

  /**
   * Ask for the careful posture (steady, no sprint, shallow drops). Builders and
   * item-carriers want this; nothing needs to be unlocked to get it. An urgent
   * situation overrides it — see isUrgent().
   */
  setCareful (on = true) {
    this._careful = Boolean(on)
    this._refreshPosture()
    return this._careful
  }

  /** Recompute the posture from `_careful`; 'urgent' still wins at apply time. */
  _refreshPosture () {
    this.mode = this._careful ? 'careful' : 'balanced'
    const m = this._movements()
    if (m) {
      this._applyMode(m)
      this.threat.attachToMovements(m)
    }
    return this.mode
  }

  /** Back-compat: old persona names map onto a posture. Kept for tests/scripts. */
  setMode (mode) {
    return this.setCareful(mode === 'builder')
  }

  _applyMode (m) {
    if (this._careful && !this.isUrgent()) { m.allowSprinting = false; m.maxDropDown = 1 } else { m.allowSprinting = true; m.maxDropDown = 4 }
  }

  /** Register one of OUR physicsTick handlers (named so stop() can remove it). */
  _onTick (fn) {
    this._tickHandlers.push(fn)
    this.bot.on('physicsTick', fn)
  }

  /** Idempotent prototype patch helper. */
  _patch (target, name, factory) {
    const key = `${name}`
    if (target[PATCH_MARK] && target[PATCH_MARK].has(key)) return // already patched
    const original = target[name]
    if (typeof original !== 'function') {
      this.log('warn', `pathfinder hook ${name} missing — skipping patch`)
      return
    }
    target[name] = factory(original)
    ;(target[PATCH_MARK] || (target[PATCH_MARK] = new Set())).add(key)
    this._applied.push(key)
  }

  /**
   * Configure ONE Movements object completely: digging guard, scaffolding
   * policy, door routing, movement mode and threat costs.
   *
   * index.js creates a fresh Movements on every spawn. The old apply() only
   * re-attached the threat hook to it, so after the first death the bot lost
   * door routing and its mode settings while still reporting the old mode.
   */
  configureMovements (movements = this._movements()) {
    if (!movements) return false
    // The prototype patch calls this after every collision-index rebuild.
    movements._zincaiAfterCollisionIndex = () => this._applyBreakPolicy(movements)
    this._applyBreakPolicy(movements)
    this._configureScaffolding(movements)
    this._configureDoors(movements)
    this._configureWalkableSurfaces(movements)
    this._configureHazards(movements)
    this._applyMode(movements)
    this.threat.attachToMovements(movements)
    // Build the escape planner's own Movements now, not in the first tick of
    // the first escape (it costs a few tens of milliseconds once).
    if (movements === this._movements()) { try { this._escapeMovements() } catch { /* built on demand instead */ } }
    return true
  }

  /**
   * Apply all patches against THIS bot's loaded pathfinder package.
   * Call AFTER bot.loadPlugin(pathfinder) and setMovements() — on every spawn.
   * Per-Movements settings are re-applied each call; timers, listeners and
   * prototype patches are installed once.
   */
  apply () {
    if (!this.configureMovements()) {
      this.log('warn', 'no Movements instance yet — call setMovements() before apply()')
    }
    if (this._appliedOnce) return this._applied
    this._appliedOnce = true
    this._patchCollisionIndex()
    this._patchStairClearance()
    this._onPathSeen = (result) => { if (result && Array.isArray(result.path)) this._path = result.path }
    this.bot.on('path_update', this._onPathSeen)
    this._onTick(this._doorTick.bind(this))
    this._startHumanizer()
    this._startThreatMap()
    return this._applied
  }

  /** 200 ms threat sampling + wind-charge recovery after noPath. */
  _startThreatMap () {
    clearInterval(this._threatTimer)
    this._threatTimer = setInterval(() => {
      try { this.threat.sample(this.bot) } catch (err) { this.log('debug', `threat sample failed: ${err.message || err}`) }
    }, this.threat.sampleMs)
    // Sample immediately so the first path is already threat-aware.
    try { this.threat.sample(this.bot, true) } catch { /* no entity yet */ }

    if (this.enableWindCharge && !this._onPathUpdate) {
      this._onPathUpdate = (result) => {
        // A* admitted defeat: is the blocker a gap/wall a wind charge can beat?
        if (!result || result.status !== 'noPath') return
        this._windChargeRecovery().catch((err) => this.log('debug', `wind recovery failed: ${err.message || err}`))
      }
      this.bot.on('path_update', this._onPathUpdate)
    }
    this.log('info', `predictive threat map on (horizon ${this.threat.horizonTicks}t, sample ${this.threat.sampleMs}ms, maxPenalty ${this.threat.maxPenalty}, up to ${this.threat.maxThreats} threats)`)
  }

  /** Attempt wind-charge traversal toward the active goal after A* noPath. */
  async _windChargeRecovery () {
    if (this._windBusy || !this.windCharge.hasCharges()) return { ok: false, why: 'unavailable' }
    const target = this._goalPosition()
    if (!target) return { ok: false, why: 'no_goal' }
    const pos = this.bot.entity?.position
    if (!pos) return { ok: false, why: 'no_position' }
    const direction = { x: target.x - pos.x, z: target.z - pos.z }
    if (Math.hypot(direction.x, direction.z) < 2) return { ok: false, why: 'too_close' }
    this._windBusy = true
    try {
      const plan = this.windCharge.analyze(direction)
      if (!plan) return { ok: false, why: 'not_traversable' }
      const result = await this.windCharge.traverse(direction, { maxChain: this.windCharge.charges().length > 1 ? 3 : 1 })
      if (result.used > 0) {
        this._windAttempts++
        this.log('info', `wind charge: ${plan.kind} ${plan.kind === 'gap' ? `${plan.width}w` : `${plan.height}h`} — ${result.used} charge(s)`)
      }
      return result
    } finally {
      this._windBusy = false
    }
  }

  /** Best-effort world position of the active pathfinder goal (Vec3-like). */
  _goalPosition () {
    const goal = this.bot.pathfinder?.goal
    if (!goal) return null
    if (Number.isFinite(goal.x) && Number.isFinite(goal.z)) return { x: goal.x, y: goal.y, z: goal.z }
    const e = goal.entity?.position
    if (e) return { x: e.x, y: e.y, z: e.z }
    return null
  }

  /**
   * Legacy helper: set a GoalNear directly on the pathfinder. New code goes
   * through a ControlArbiter lane (see skills.js); this stays for scripts.
   */
  pathTo (x, y, z, { range = 1 } = {}) {
    const pos = this.bot.entity?.position
    if (!pos) return null
    const { goals } = require('mineflayer-pathfinder')
    this.threat.sample(this.bot, true)
    try { this.bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range), true) } catch (err) {
      this.log('debug', `pathTo failed: ${err.message || err}`)
      return null
    }
    return { x, y, z }
  }

  // ---------------------------------------------------------------- flee --
  /**
   * A second Movements used only to flood the ground for an escape: geometry
   * and doors, no threat costs (the escape planner has its own clock), no
   * building, no parkour, no drop that hurts.
   */
  _escapeMovements () {
    const live = this._movements()
    if (!live) return null
    if (this._escapeMov && this._escapeMovFor === live) return this._escapeMov
    let m = null
    try { m = escapeMovementsFor(this.bot, live.constructor, (mov) => this._configureDoors(mov)) } catch (err) { this.log('debug', `escape movements: ${err.message || err}`); return null }
    this._escapeMov = m
    this._escapeMovFor = live
    return m
  }

  /**
   * Where to run, walls and time included (escape.js). Pure planning.
   * @param {Array<{x:number,y:number,z:number,speed:number,reach:number}>} pursuers
   * @param {object} [opts] passed to planEscape (radius, botSpeed, …)
   * @returns {null | (ReturnType<typeof planEscape> & { goal: object })}
   */
  escapePlan (pursuers, opts = {}) {
    const m = this._escapeMovements()
    if (!m) return null
    return escapePlanWith(this.bot, m, pursuers, opts)
  }

  /**
   * The old vector plan: a point "away". Kept as the fallback for when the
   * ground cannot be flooded (no Movements yet).
   *
   * Where to run. Pure planning — it never touches the controls; the survival
   * reflex (system1.js) owns those through its arbiter lane.
   *
   * Picks the lowest-threat destination among three fan-out candidates along
   * the predictive escape vector (away from where the threats WILL be).
   * @param {{ distance?: number }} [opts]
   * @returns {{ goal: object, direction: {x:number,z:number}, x:number, y:number, z:number, threat:number } | null}
   */
  fleePlan (opts = {}) {
    return fleePlan(this.bot, this.threat, opts)
  }

  /** Yaw that faces a horizontal direction (mineflayer: yaw 0 = north, -z). */
  static yawFor (direction) {
    return Math.atan2(-direction.x, -direction.z)
  }

  // ------------------------------------------------------------- digging--
  /**
   * Digging by request. Planning never breaks blocks: a walk routes around,
   * opens doors, or reports "no path". When the MODEL asks to dig, this opens a
   * tight one-shot window and the route through it is planned around it:
   *
   *   options.canDig   block ids the walk MAY break (a material filter: only
   *                    logs, or only dirt and stone). null = anything except
   *                    the blocks that are never broken.
   *   options.cantDig  block ids the walk must NOT break, whatever canDig says
   *                    (a friend's build, anything precious).
   *
   * The window lapses as soon as the walk ends (endDigging) and in any case
   * after maxMs. While it is open, only the current walk can use it: escapes,
   * follow and every other path keep the stricter no-dig geometry.
   */
  beginDigging ({ canDig = null, cantDig = [], avoid = [], maxMs = 60_000 } = {}) {
    const toIds = (names) => {
      const registry = this.bot?.registry
      const ids = new Set()
      for (const name of [].concat(names || [])) {
        const id = registry?.blocksByName?.[String(name).toLowerCase()]?.id
        if (id !== undefined) ids.add(id)
      }
      return ids
    }
    this._digWindow = {
      canDig: canDig === null ? null : toIds(canDig),
      cantDig: toIds([].concat(cantDig || [], avoid || [])),
      expiresAt: Date.now() + Math.max(1_000, Number(maxMs) || 60_000)
    }
    clearTimeout(this._digTimer)
    this._digTimer = setTimeout(() => this.endDigging('expired'), Math.max(1_000, Number(maxMs) || 60_000))
    try { this._digTimer.unref?.() } catch { /* older node */ }
    // Movements objects recreate their per-move caches; reconfigure the live one.
    const movements = this._movements()
    if (movements) this._applyBreakPolicy(movements)
    return this.digging
  }

  /** Close the dig window: the next route is planned with no digging at all. */
  endDigging (reason = 'done') {
    if (!this._digWindow) return false
    this._digWindow = null
    clearTimeout(this._digTimer)
    this._digTimer = null
    const movements = this._movements()
    if (movements) this._applyBreakPolicy(movements)
    this.log('debug', `dig window closed (${reason})`)
    return true
  }

  /** Is a dig window open right now? For prompts and logs. */
  get digging () {
    const w = this._digWindow
    if (!w) return null
    if (Date.now() > w.expiresAt) { this.endDigging('expired'); return null }
    return { canDig: w.canDig ? [...w.canDig] : null, cantDig: [...w.cantDig], expiresAt: w.expiresAt }
  }

  /** Block ids that are never breakable, whatever the window says. */
  _doorBlockIds () {
    const registry = this.bot?.registry
    const ids = []
    if (registry?.blocksArray) for (const block of registry.blocksArray) if (doors.kindOf(block.name)) ids.push(block.id)
    return ids
  }

  /**
   * The whole break policy for one Movements, recomputed from scratch.
   *
   * It is recomputed, not patched: upstream's updateCollisionIndex() rebuilds
   * blocksCantBreak on every plan, so anything added once disappears at the
   * next replan. updateCollisionIndex is patched (once) to call back here, and
   * beginDigging/endDigging call it directly.
   */
  _applyBreakPolicy (movements) {
    const w = this._digWindow
    const allowed = Boolean(w) && Date.now() <= w.expiresAt
    // Upstream's own digCost (1) prices a break by its dig time, and its
    // per-move cost cap (100) is what stops a very hard block from being an
    // option at all. Raising digCost here would make a two-block-high tunnel
    // through stone unaffordable, so the window keeps the default and the
    // closed window is what makes breaking impossible.
    movements.canDig = allowed
    movements.digCost = allowed ? 1 : 1000
    // Never carve into a liquid wall, never mine what holds gravel or a mob up.
    movements.dontCreateFlow = true
    movements.dontMineUnderFallingBlock = true

    const set = movements.blocksCantBreak
    if (!set) return
    // Upstream's own defaults (chests and friends) are captured once, so a
    // lapsed window cannot leave an allowlist behind or erase that list.
    if (!movements._zincaiBaseCantBreak) movements._zincaiBaseCantBreak = new Set(set)
    set.clear()
    for (const id of movements._zincaiBaseCantBreak) set.add(id)
    // Doors and gates are opened, never broken — in every window.
    for (const id of this._doorBlockIds()) set.add(id)
    const cant = (id) => { if (id !== undefined && id !== null) set.add(id) }
    if (allowed) {
      const registry = this.bot?.registry
      if (w.canDig) {
        // An allowlist: everything not named is unbreakable.
        if (registry?.blocksArray) for (const b of registry.blocksArray) if (!w.canDig.has(b.id)) cant(b.id)
      } else if (registry?.blocksByName) {
        // No allowlist: anything goes except the world itself.
        for (const name of ['bedrock', 'barrier', 'command_block', 'end_portal_frame', 'spawner']) cant(registry.blocksByName[name]?.id)
      }
      for (const id of w.cantDig) cant(id)
    }
  }

  /**
   * Upstream rebuilds blocksCantBreak inside updateCollisionIndex(), which runs
   * on every plan — so the break policy has to be re-asserted after it, not
   * before it. One prototype patch per loaded package, per instance hook.
   */
  _patchCollisionIndex () {
    try {
      const { Movements } = require('mineflayer-pathfinder')
      this._patch(Movements.prototype, 'updateCollisionIndex', (orig) => function () {
        const out = orig.apply(this, arguments)
        try { this._zincaiAfterCollisionIndex?.() } catch { /* fail soft */ }
        return out
      })
    } catch (err) {
      this.log('warn', `break policy hook not patched: ${err.message || err}`)
    }
  }

  // --------------------------------------------------------- scaffolding--
  _configureScaffolding (movements) {
    if (this.allowScaffolding) return
    movements.allow1by1towers = false
    movements.scafoldingBlocks = [] // (sic) upstream's spelling
  }

  /**
   * Upstream only treats shapes < 0.1 tall as walkable carpets; 1/8-block
   * redstone components (repeater, comparator, 0.125 tall) are well under
   * Minecraft's 0.6 auto-step height and should be walkable instead of walls.
   */
  _configureWalkableSurfaces (movements) {
    const registry = this.bot?.registry
    if (!registry?.blocksByName || !movements?.carpets) return
    for (const name of ['repeater', 'comparator']) {
      const b = registry.blocksByName[name]
      if (b) movements.carpets.add(b.id)
    }
  }

  // ------------------------------------------------------------ hazards--
  /**
   * Upstream avoids fire, cobwebs and lava. These also hurt or trap a player
   * who walks into them, and one of them (farmland) is somebody's work.
   */
  _configureHazards (movements) {
    configureHazards(this.bot, movements)
  }

  /**
   * Allow stepping onto a stair or bottom slab when the overhead clearance
   * block at (0, 2, 0) is a top-half block (e.g. upper slab/trapdoor with minY >= 0.5).
   * Walking up a half-step raises the head to at most y + 2.3 (< y + 2.5).
   */
  _patchStairClearance () {
    try {
      const { Movements } = require('mineflayer-pathfinder')
      this._patch(Movements.prototype, 'getMoveJumpUp', (orig) => function (node, dir, neighbors) {
        const blockA = this.getBlock(node, 0, 2, 0)
        const blockC = this.getBlock(node, dir.x, 0, dir.z)
        const topHalfOverhead = blockA && !blockA.safe && !this.blocksToAvoid?.has(blockA.type) &&
          Array.isArray(blockA.shapes) && blockA.shapes.length > 0 && blockA.shapes.every((s) => s[1] >= 0.5)
        const stepUp = blockC && /_(stairs|slab)$/.test(String(blockC.name || ''))
        if (!topHalfOverhead || !stepUp) return orig.call(this, node, dir, neighbors)
        const origGetBlock = this.getBlock
        this.getBlock = function (pos, dx, dy, dz) {
          if (pos === node && dx === 0 && dy === 2 && dz === 0) return { ...blockA, safe: true, physical: false }
          return origGetBlock.call(this, pos, dx, dy, dz)
        }
        try {
          return orig.call(this, node, dir, neighbors)
        } finally {
          this.getBlock = origGetBlock
        }
      })
    } catch (err) {
      this.log('warn', `stair clearance patch skipped: ${err.message || err}`)
    }
  }

  // -------------------------------------------------------------- doors--
  _configureDoors (movements) {
    // Even with digging allowed, a door is opened or routed around, never
    // broken — _applyBreakPolicy() enforces that on every replan.
    const attached = doors.attachDoors(movements, { operate: true, isJammed: (key) => this._doorJammed(key), stepCost: this.doorCost })
    if (!attached) this.log('warn', 'door routing not attached — Movements.getBlock missing')
    return attached
  }

  _doorJammed (key) {
    const until = this._jammed.get(key)
    if (!until) return false
    if (Date.now() > until) { this._jammed.delete(key); return false }
    return true
  }

  /** Doors this bot opened and has not put back yet. */
  openedDoors () {
    return [...this._opened.values()].map((e) => ({ x: e.position.x, y: e.position.y, z: e.position.z, name: e.name }))
  }

  /**
   * Open what is in the way; put back exactly what this bot opened.
   * Runs on every physics tick, works every 100 ms.
   */
  _doorTick () {
    const bot = this.bot
    if (!bot.entity) return
    const now = Date.now()
    if (now - (this._lastDoorScan || 0) < 100) return
    this._lastDoorScan = now
    try { this._openAhead(now) } catch (err) { this.log('debug', `door tick (open): ${err.message || err}`) }
    try { this._closeBehind(now) } catch (err) { this.log('debug', `door tick (close): ${err.message || err}`) }
  }

  /** The cells the bot is about to walk through, nearest first (its own cell included). */
  _cellsAhead (count = 3) {
    const bot = this.bot
    const me = bot.entity.position
    const cells = [{ x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }]
    const moving = Boolean(bot.pathfinder?.isMoving?.())
    if (moving && Array.isArray(this._path)) for (const node of this._path.slice(0, count)) cells.push({ x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) })
    return { cells, moving }
  }

  _openAhead (now) {
    const bot = this.bot
    const { cells, moving } = this._cellsAhead(3)
    if (!moving || cells.length < 2) return // only a walk along a planned route opens anything
    const me = bot.entity.position
    for (const cell of cells) {
      const pos = new Vec3(cell.x, cell.y, cell.z)
      const block = bot.blockAt(pos, false)
      const d = doors.describe(block)
      if (!d || d.kind === 'trapdoor' || !d.byHand) continue
      if (!doors.blocksWalk(d, doors.passageAxis(bot, pos, d))) continue
      const reach = Math.hypot(pos.x + 0.5 - me.x, pos.y + 0.5 - (me.y + 1.62), pos.z + 0.5 - me.z)
      if (reach > 3.6) return // not there yet
      this._click(block, d, now)
      return // one at a time
    }
  }

  /**
   * One right-click on a door or gate, spaced so the server's answer is seen
   * before the next one (a second click would shut it again). A door that
   * stays as it was after three clicks is somebody's locked door: remember it,
   * and let the planner find another way.
   */
  _click (block, d, now) {
    const bot = this.bot
    const key = doors.keyOf(block.position, d)
    if (this._doorJammed(key)) return false
    const last = this._doorClicks.get(key)
    const sameState = Boolean(last) && last.open === d.open
    if (sameState && now - last.at < 500 + 300 * last.tries) return false
    if (sameState && last.tries >= 3) {
      this._doorClicks.delete(key)
      this._opened.delete(key)
      this._jammed.set(key, now + 60_000)
      this.lastJam = { x: block.position.x, y: block.position.y, z: block.position.z, name: d.name, at: now }
      this.log('info', `${d.name} at ${block.position.x},${block.position.y},${block.position.z} will not open — routing around it for a minute`)
      try { bot.pathfinder.setMovements(bot.pathfinder.movements) } catch { /* replan on the next goal instead */ }
      return false
    }
    this._doorClicks.set(key, { at: now, open: d.open, tries: sameState ? last.tries + 1 : 1 })
    const entry = this._opened.get(key)
    if (entry) entry.lastClick = now
    else {
      const y = d.kind === 'door' && d.half === 'upper' ? block.position.y - 1 : block.position.y
      this._opened.set(key, { position: new Vec3(block.position.x, y, block.position.z), kind: d.kind, name: d.name, restoreOpen: d.open, at: now, lastClick: now })
    }
    Promise.resolve()
      .then(() => bot.activateBlock(block))
      .catch((err) => this.log('debug', `door click failed: ${err.message || err}`))
    return true
  }

  _closeBehind (now) {
    if (!this._opened.size) return
    const bot = this.bot
    const me = bot.entity.position
    const { cells } = this._cellsAhead(6)
    for (const [key, entry] of this._opened) {
      const p = entry.position
      const block = bot.blockAt(p, false)
      const d = doors.describe(block)
      if (!d || d.kind !== entry.kind) { this._opened.delete(key); this._doorClicks.delete(key); continue } // gone or replaced
      const age = now - entry.lastClick
      if (d.open === entry.restoreOpen) {
        // As the bot found it: either the click has not been answered yet, or the job is done.
        if (age > 1500) { this._opened.delete(key); this._doorClicks.delete(key) }
        continue
      }
      const dx = me.x - (p.x + 0.5)
      const dz = me.z - (p.z + 0.5)
      const flat = Math.hypot(dx, dz)
      const level = Math.abs(me.y - p.y) < 1.6
      if (level && flat < 1.25) continue // still in the doorway
      if (cells.some((c) => c.x === p.x && c.z === p.z && Math.abs(c.y - p.y) <= 1)) continue // still on the way to it
      const reach = Math.hypot(dx, me.y + 1.62 - (p.y + 0.5), dz)
      if (reach > 4.2) {
        // Out of reach (a sprinting escape, a teleport). Nothing more to do from here.
        if (now - entry.at > 4000) { this._opened.delete(key); this._doorClicks.delete(key); this.log('debug', `left ${entry.name} at ${p.x},${p.y},${p.z} open — out of reach`) }
        continue
      }
      if (this._someoneInDoorway(p) && now - entry.at < 10_000) continue // do not shut it on a friend
      this._click(block, d, now)
    }
  }

  _someoneInDoorway (p) {
    const bot = this.bot
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue
      if (Math.abs(e.position.x - (p.x + 0.5)) < 0.9 && Math.abs(e.position.z - (p.z + 0.5)) < 0.9 && Math.abs(e.position.y - p.y) < 1.6) return true
    }
    return false
  }

  /**
   * Jump-place pillar to at least targetY (integer feet height).
   * Consumes scaffold blocks from inventory. Returns true on success.
   * @param {number} targetY
   * @param {string[]} scaffoldBlocks
   */
  async pillarToHeight (targetY, scaffoldBlocks = ['dirt', 'cobblestone', 'netherrack']) {
    const bot = this.bot
    const { Vec3 } = require('vec3')
    let guard = 0
    while (guard++ < 40) {
      const feetY = Math.floor(bot.entity?.position?.y ?? 0)
      if (feetY >= targetY) return true
      const scaffold = bot.inventory.items().find((i) => scaffoldBlocks.includes(i.name))
      if (!scaffold) { this.log('warn', 'pillar: out of scaffold blocks'); return false }
      await bot.equip(scaffold, 'hand').catch(() => {})
      bot.setControlState('jump', true)
      await new Promise((r) => setTimeout(r, 120))
      try {
        const refBlock = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
        if (refBlock) await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
      } catch (err) {
        this.log('debug', `pillar place failed: ${err.message || err}`)
      }
      bot.setControlState('jump', false)
      await new Promise((r) => setTimeout(r, 180))
    }
    return false
  }

  _movements () {
    return this.bot.pathfinder?.movements || null
  }

  // ------------------------------------------------- human movement mimic--
  _startHumanizer () {
    const bot = this.bot

    // ±2° micro-jitter on a randomized cadence — never on a fixed metronome.
    const jitter = () => {
      this._jitterTimer = setTimeout(jitter, 400 + Math.random() * 700)
      if (Date.now() < this._pauseUntil) return
      if (!bot.entity || !bot.pathfinder) return
      if (this.isUrgent()) return // fleeing/fighting: do not nudge the aim
      if (!bot.pathfinder.isMoving?.() && !bot.pathfinder.goal) return
      const jYaw = (Math.random() * 2 - 1) * this.jitterRad
      const jPitch = (Math.random() * 2 - 1) * this.jitterRad
      bot.look(bot.entity.yaw + jYaw, bot.entity.pitch + jPitch, true).catch(() => {})
    }
    jitter()

    // Variable sprint/walk cycles — sprint is a gait, not a default.
    // Danger override: never sprint airborne, in liquid, or next to a drop-off.
    const cycle = () => {
      this._sprintTimer = setTimeout(cycle, this._sprintWalkPhase === 'sprint' ? 900 + Math.random() * 1600 : 400 + Math.random() * 800)
      const movements = this._movements()
      if (!movements) return
      if (this._sprintWalkPhase === 'sprint') {
        this._sprintWalkPhase = 'walk'
      } else {
        this._sprintWalkPhase = 'sprint'
      }
      const hazard = this._nearHazard()
      // Running for its life (or fighting) the bot sprints — careful posture included.
      if (this.isUrgent()) { movements.allowSprinting = true; return }
      if (this._careful) { movements.allowSprinting = false; return }
      movements.allowSprinting = this._sprintWalkPhase === 'sprint' && !hazard
    }
    cycle()

    // Idle pause on abrupt heading change while navigating (200–800ms).
    const headingPause = () => {
      if (!bot.entity || !bot.pathfinder) return
      if (!bot.pathfinder.isMoving?.()) { this._lastHeading = null; return }
      if (this.isUrgent()) { this._lastHeading = bot.entity.yaw; return } // never pause mid-escape
      const yaw = bot.entity.yaw
      if (this._lastHeading !== null) {
        let d = Math.abs(yaw - this._lastHeading) % (2 * Math.PI)
        if (d > Math.PI) d = 2 * Math.PI - d
        if (d > 1.0 && Date.now() >= this._pauseUntil) {
          this._pauseUntil = Date.now() + 200 + Math.random() * 600
          for (const c of ['forward', 'sprint', 'jump']) bot.setControlState(c, false)
        }
      }
      this._lastHeading = yaw
    }
    this._onTick(headingPause)
  }

  _nearHazard () {
    const bot = this.bot
    try {
      if (!bot.entity.onGround) return true // airborne — do not sprint
      if (bot.entity.isInWater || bot.entity.isInLava) return true
      const pos = bot.entity.position.floored()
      // Drop-off probe: the block directly below the next step is air/lava?
      const ahead = bot.entity.position.floored().offset(
        Math.round(-Math.sin(bot.entity.yaw)),
        0,
        Math.round(-Math.cos(bot.entity.yaw)) // yaw 0 faces north (-z)
      )
      const below = bot.blockAt(ahead.offset(0, -1, 0))
      if (!below) return true // edge of loaded world — cautious, not suicidal
      if (below.name === 'air' || below.name === 'cave_air') return true
      if (/lava|fire/.test(below.name)) return true
    } catch { /* transient — assume safe */ }
    return false
  }

  /** Remove OUR timers and physicsTick listeners (called on shutdown). */
  stop () {
    clearTimeout(this._digTimer)
    this._digTimer = null
    this._digWindow = null
    clearTimeout(this._jitterTimer)
    clearTimeout(this._sprintTimer)
    clearInterval(this._jumpSprintTimer)
    clearInterval(this._threatTimer)
    this._threatTimer = null
    this._jumpSprintTimer = null
    if (this._onPathUpdate) {
      try { this.bot.removeListener('path_update', this._onPathUpdate) } catch { /* bot gone */ }
      this._onPathUpdate = null
    }
    if (this._onPathSeen) {
      try { this.bot.removeListener('path_update', this._onPathSeen) } catch { /* bot gone */ }
      this._onPathSeen = null
    }
    this._path = null
    this._opened.clear()
    this._doorClicks.clear()
    for (const fn of this._tickHandlers) {
      try { this.bot.removeListener('physicsTick', fn) } catch { /* bot gone */ }
    }
    this._tickHandlers = []
    this.threat.clear()
  }
}

module.exports = {
  PathfinderWrapper,
  PredictiveThreatMap,
  fleePlan,
  makeEscapePlanner,
  configureHazards,
  WindChargeTraversal,
  scoutSafeAnchor,
  findGroundY,
  projectFuture,
  pointSegmentDistance,
  isHostileName,
  isDoorOrTrapdoorName,
  HOSTILE_RE,
  WIND_CHARGE_ITEM
}
