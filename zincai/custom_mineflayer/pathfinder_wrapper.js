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
 */
'use strict'

const PATCH_MARK = Symbol.for('zincai.pathfinder.patched')
const DEG = Math.PI / 180
const TICK_MS = 50

const { Vec3 } = require('vec3')
const doors = require('./doors')
const { planEscape, planSafeDetour } = require('./escape')

/** Blocks that cannot be broken in vanilla survival or hold protected world structures. */
const UNBREAKABLE_BLOCKS = Object.freeze([
  'bedrock', 'barrier', 'structure_void', 'light',
  'command_block', 'chain_command_block', 'repeating_command_block',
  'structure_block', 'jigsaw', 'end_portal', 'end_portal_frame', 'end_gateway',
  'nether_portal', 'reinforced_deepslate', 'spawner', 'trial_spawner', 'vault',
  'water', 'lava', 'bubble_column'
])

/** Soft natural terrain that ordinary walking may clear when no short detour exists. */
const PASSIVE_WALK_SOFT_BLOCKS = Object.freeze([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block', 'powder_snow',
  'vine', 'tall_grass', 'short_grass', 'fern', 'large_fern', 'dead_bush',
  'bush', 'leaf_litter', 'seagrass', 'tall_seagrass'
])

const isSoftWalkBlock = (name) => {
  const n = String(name || '')
  return PASSIVE_WALK_SOFT_BLOCKS.includes(n) || n.endsWith('_leaves')
}

const isDoorOrTrapdoorName = (name) => (/_door$/i.test(name) || /_trapdoor$/i.test(name)) && !/iron/i.test(name)

/**
 * Hostiles relevant to movement threat. EXACT names (shared with threats.js):
 * the old substring regex also matched skeleton_horse and zombie_horse.
 */
const { HOSTILE_NAMES, RANGED_NAMES, creeperFuseLit, creeperCharged } = require('../threats')
const HOSTILE_RE = new RegExp(`^(${[...HOSTILE_NAMES].join('|')})$`, 'i')
const HEAVY_MELEE_NAMES = new Set(['warden', 'ravager', 'wither', 'ender_dragon', 'elder_guardian', 'piglin_brute', 'vindicator', 'evoker'])

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
const isPlayerEntity = (e) => Boolean(e) && (e.type === 'player' || e.name === 'player')

/**
 * STANDOFF: how far a route should stay from each kind of mob, in blocks.
 *
 * The field used to be one 2-block sphere at the spot a mob would reach in two
 * seconds. A creeper standing still was therefore "safe" from 2.1 blocks —
 * inside its 3-block fuse range — and a route happily brushed past a zombie at
 * arm's length, which is what triggered the escape reflex in the middle of
 * every walk. The standoff ring is what a player keeps by instinct: wide for
 * what explodes or shoots, a few blocks for what has to reach you.
 */
const STANDOFF = Object.freeze({
  creeper: 7,
  warden: 14,
  ravager: 8,
  wither: 12,
  ender_dragon: 12,
  ghast: 10,
  blaze: 9,
  breeze: 8,
  witch: 8,
  skeleton: 8,
  stray: 8,
  bogged: 8,
  parched: 8,
  pillager: 8,
  illusioner: 8,
  evoker: 9,
  shulker: 8,
  guardian: 8,
  elder_guardian: 10,
  piglin_brute: 7,
  vindicator: 7,
  wither_skeleton: 6,
  hoglin: 6,
  zoglin: 6,
  enderman: 5,
  spider: 6,
  cave_spider: 6,
  phantom: 6,
  vex: 6,
  slime: 5,
  magma_cube: 5,
  player: 5
})
const DEFAULT_STANDOFF = 5

/** Standoff ring (blocks) for an entity name. */
function standoffFor (name, table = STANDOFF, fallback = DEFAULT_STANDOFF) {
  const key = String(name || '').toLowerCase().replace(/^minecraft:/, '')
  return Number.isFinite(table[key]) ? table[key] : fallback
}

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
    // The standoff ring (see STANDOFF). `standoff: false` restores the old
    // field (one small sphere at the projected position); a number scales the
    // table; an object overrides entries by mob name.
    this.standoff = opts.standoff !== false
    this.standoffScale = Number.isFinite(opts.standoffScale) && opts.standoffScale > 0 ? opts.standoffScale : 1
    this.standoffTable = opts.standoff && typeof opts.standoff === 'object' ? { ...STANDOFF, ...opts.standoff } : STANDOFF
    // How strongly the ring counts next to the kill sphere (0..1 at its centre).
    this.standoffWeight = Number.isFinite(opts.standoffWeight) ? opts.standoffWeight : 0.6
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
      const name = String(entity.name || 'hostile').toLowerCase()
      const speed = Math.hypot(velocity.x, velocity.z)
      const weight = this._weight(entity, pos, velocity, botPos)
      const ellipse = this._buildEllipse(entity, name, pos, velocity, botPos, speed)
      threats.push({
        id: entity.id,
        name,
        position: pos,
        velocity,
        future,
        distance,
        speed,
        weight,
        radius: this.futureRadius,
        // Weighted directional elliptical safety region aligned with entity
        // motion (or pursuit axis toward the bot when stationary between ticks).
        ellipse,
        // How far a route keeps away from this mob, from where it is to where
        // it will be (0 = no ring).
        standoff: this.standoff ? standoffFor(isPlayerEntity(entity) ? 'player' : entity.name, this.standoffTable) * this.standoffScale : 0,
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

  /**
   * Build a weighted directional elliptical safety region for a hostile entity.
   *
   * Semi-major forward axis stretches along the threat's velocity vector (or
   * approach vector toward the bot when speed is low), lateral axis guards side
   * clearance, and rear axis is shorter so routes prefer slipping behind a
   * moving threat rather than crossing its nose. Creepers expand sharply when
   * lit or charged.
   */
  _buildEllipse (entity, name, pos, velocity, botPos, speedPerTick) {
    const speedBps = speedPerTick * 20
    let ux = 1
    let uz = 0
    if (speedPerTick >= 0.025) {
      ux = velocity.x / speedPerTick
      uz = velocity.z / speedPerTick
    } else if (botPos) {
      const bx = botPos.x - pos.x
      const bz = botPos.z - pos.z
      const blen = Math.hypot(bx, bz)
      if (blen > 0.01) { ux = bx / blen; uz = bz / blen }
    }
    const isCreeper = name === 'creeper'
    const lit = isCreeper && creeperFuseLit(entity)
    const charged = isCreeper && creeperCharged(entity)
    const isHeavy = HEAVY_MELEE_NAMES.has(name)
    const isRanged = RANGED_NAMES.has(name)
    const isPlayer = isPlayerEntity(entity)

    let baseForward = 4.8
    let baseLateral = 3.3
    let baseRear = 2.3
    let criticalRadius = 3.0
    let classWeight = 1.0

    if (isCreeper) {
      baseForward = lit ? 8.6 : 6.8
      baseLateral = lit ? 7.4 : 5.0
      baseRear = lit ? 6.8 : 4.2
      criticalRadius = lit ? 8.0 : 6.0
      classWeight = lit ? 2.8 : 1.75
      if (charged) {
        baseForward *= 1.3
        baseLateral *= 1.3
        baseRear *= 1.3
        criticalRadius *= 1.3
        classWeight *= 1.35
      }
    } else if (isHeavy) {
      baseForward = 7.6
      baseLateral = 5.4
      baseRear = 3.8
      criticalRadius = 5.5
      classWeight = 2.0
    } else if (isRanged) {
      baseForward = 7.0
      baseLateral = 4.6
      baseRear = 3.2
      criticalRadius = 3.8
      classWeight = 1.3
    } else if (isPlayer) {
      baseForward = 6.2
      baseLateral = 4.0
      baseRear = 2.8
      criticalRadius = 3.6
      classWeight = 1.35
    }

    const scale = this.standoff ? this.standoffScale : 0.7
    const aForward = (baseForward + clamp(speedBps * 0.6, 0, 4.5)) * scale
    const bLateral = (baseLateral + clamp(speedBps * 0.18, 0, 1.5)) * scale
    const aRear = baseRear * scale
    return {
      ux,
      uz,
      aForward,
      bLateral,
      aRear,
      criticalRadius: criticalRadius * scale,
      classWeight,
      isCreeper,
      lit,
      charged,
      speedBps
    }
  }

  /** Current directional elliptical safety regions (for escape/detour planners & diagnostics). */
  ellipses () {
    const now = this.now()
    return this.threats
      .filter((t) => t && t.expiresAt > now && t.ellipse)
      .map((t) => ({ id: t.id, name: t.name, position: t.position, future: t.future, weight: t.weight, ...t.ellipse }))
  }

  /** True when a world point lies inside any threat's critical danger core (e.g. creeper blast radius). */
  isCriticalAt (point, { yTolerance = 4.0 } = {}) {
    if (!point) return false
    const now = this.now()
    for (const t of this.threats) {
      if (!t || t.expiresAt <= now || !t.ellipse) continue
      if (Math.abs((point.y ?? t.position.y) - t.position.y) > yTolerance) continue
      const flat = Math.hypot(point.x - t.position.x, point.z - t.position.z)
      if (flat <= t.ellipse.criticalRadius) return true
    }
    return false
  }

  /** Keep the field warm even when no navigation is active. */
  tick (bot) { return this.sample(bot) }

  /**
   * Cumulative threat score at a world point. 0 = safe, ~1+ = inside a
   * weighted elliptical safety region or projected kill sphere. Overlapping
   * threat ellipses stack with an extra pinch-zone penalty so paths detour
   * cleanly around multi-enemy clusters rather than threading between them.
   */
  threatScoreAt (point, { yWeight = 0.45 } = {}) {
    if (!point) return 0
    const now = this.now()
    let score = 0
    let ellipseHits = 0
    for (const t of this.threats) {
      if (!t || t.expiresAt <= now) continue
      const py = point.y ?? t.position.y
      const df = Math.hypot(point.x - t.future.x, (py - t.future.y) * yWeight, point.z - t.future.z)
      if (df < t.radius) score += (1 - df / t.radius) * t.weight

      const el = t.ellipse
      if (el && this.standoff) {
        const dy = Math.abs(py - t.position.y)
        if (dy <= 4.5) {
          const dx = point.x - t.position.x
          const dz = point.z - t.position.z
          const along = dx * el.ux + dz * el.uz
          const cross = -dx * el.uz + dz * el.ux
          const semiA = along >= 0 ? el.aForward : el.aRear
          const q = (along / Math.max(0.5, semiA)) ** 2 + (cross / Math.max(0.5, el.bLateral)) ** 2 + ((dy * yWeight) / 3.8) ** 2
          if (q < 1.0) {
            ellipseHits++
            const k = 1 - Math.sqrt(q)
            score += Math.pow(k, 1.45) * t.weight * el.classWeight * this.standoffWeight
          }
          const flat = Math.hypot(dx, dz)
          if (flat < el.criticalRadius) {
            const ck = 1 - flat / Math.max(0.5, el.criticalRadius)
            score += Math.pow(ck, 1.6) * (el.isCreeper ? 2.2 : 0.85) * t.weight
          }
        }
      } else if (t.standoff > 0) {
        const flat = pointSegmentDistance({ x: point.x, y: 0, z: point.z }, { x: t.position.x, y: 0, z: t.position.z }, { x: t.future.x, y: 0, z: t.future.z })
        const ds = Math.hypot(flat, (py - t.position.y) * yWeight)
        if (ds < t.standoff) {
          const k = 1 - ds / t.standoff
          score += k * k * t.weight * this.standoffWeight
        }
      }
      if (t.corridorEnd) {
        const dLine = pointSegmentDistance({ x: point.x, y: py, z: point.z }, t.position, t.corridorEnd)
        if (dLine < t.corridorRadius) score += (1 - dLine / t.corridorRadius) * t.weight * 0.75
      }
    }
    // Multi-enemy pinch-zone penalty: strongly discourage squeezing between
    // two or more overlapping hostile ellipses when an outer detour exists.
    if (ellipseHits >= 2) score += (ellipseHits - 1) * 0.65
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
  attachToMovements (movements, intents = null) {
    if (!movements || typeof movements.getNeighbors !== 'function') return false
    if (movements._zincaiThreatCost) return true
    const map = this
    const original = movements.getNeighbors
    movements.getNeighbors = function (node) {
      const neighbors = original.call(this, node)
      const field = intents?.field()
      if (!map.threats.length && !field) return neighbors
      return neighbors.filter((n) => {
        const point = { x: n.x + 0.5, y: n.y, z: n.z + 0.5 }
        const extra = field ? field(point, { x: node.x + 0.5, y: node.y, z: node.z + 0.5 }) : 0
        if (!Number.isFinite(extra)) return false
        n.cost += extra + map.costAt(point)
        return true
      })
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
  // The clock proves this exact cell is safe. GoalNear(range=1) could legally
  // stop on an adjacent cell that was never evaluated by the escape planner.
  plan.goal = new goals.GoalBlock(plan.target.x, plan.target.y, plan.target.z)
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

// ===========================================================================
// PathfinderWrapper
// ===========================================================================
class PathfinderWrapper {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ doorCost?: number, jitterDegrees?: number,
   *           logger?: (level:string,msg:string)=>void,
   *           threat?: object, windCharge?: object,
   *           isProtected?: (pos:object) => boolean,
   *           isUrgent?: () => boolean }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.intents = opts.intents || null
    // Explicit `dig` corridor grants pathfinder permission to break any breakable block along the route.
    this._digWindow = null
    this._digTimer = null
    this.isProtected = typeof opts.isProtected === 'function' ? opts.isProtected : null
    this.policyDigCost = Number.isFinite(opts.policyDigCost) ? Math.max(1, opts.policyDigCost) : 2
    this._softIdsCache = null
    this.doorCost = Number.isFinite(opts.doorCost) ? opts.doorCost : 4
    this.jitterRad = ((opts.jitterDegrees ?? 2) * DEG)
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {}
    this.isUrgent = typeof opts.isUrgent === 'function' ? opts.isUrgent : () => false
    this._opened = new Map()
    this._doorClicks = new Map()
    this._jammed = new Map()
    this.lastJam = null
    this._path = null
    this._onPathSeen = null
    this._jitterTimer = null
    this._sprintTimer = null
    this._sprintWalkPhase = 'sprint'
    this._gait = 'auto'
    this._locomotionScopes = 0
    this._locomotionStats = { transitions: 0, safetyDowngrades: 0, optionalJumps: 0, compatibilityTicks: 0 }
    this._effectiveGait = 'walk'
    this._gaitPort = this.intents?.register({ id: 'pathfinder-style-adapter' })
    this._speedMs = 0
    this._speedSamples = []
    this._jumpPulseUntil = 0
    this._lastSprintJumpAt = 0
    this._lastHeading = null
    this._pauseUntil = 0
    this._applied = []
    this._tickHandlers = []

    this.fleeRadius = Number.isFinite(opts.fleeRadius) ? opts.fleeRadius : 8
    this._jumpSprintTimer = null
    try { if (this.bot) this.bot._zincaiMotion = () => this.getMotionState() } catch { /* frozen */ }

    this.threat = opts.threat instanceof PredictiveThreatMap
      ? opts.threat
      : new PredictiveThreatMap({ ...(opts.threat || {}), logger: this.log })
    this.windCharge = opts.windCharge instanceof WindChargeTraversal
      ? opts.windCharge
      : new WindChargeTraversal(bot, { enabled: true, logger: this.log, ...(opts.windCharge || {}) })
    this._threatTimer = null
    const tcfg = (opts.threat && !(opts.threat instanceof PredictiveThreatMap)) ? opts.threat : {}
    this.routeReplanMs = Number.isFinite(tcfg.routeReplanMs) ? tcfg.routeReplanMs : 700
    this.routeReplanCost = Number.isFinite(tcfg.routeReplanCost) ? tcfg.routeReplanCost : 10
    this.routeReplanRise = Number.isFinite(tcfg.routeReplanRise) ? tcfg.routeReplanRise : 6
    this._routeBaseline = 0
    this._routeBaselineAt = 0
    this._lastRouteReplanAt = 0
    this.threatReplans = 0
    this._windBusy = false
    this._windAttempts = 0
    this._onPathUpdate = null
    this._appliedOnce = false
  }

  /** Register one physicsTick handler owned by this wrapper (removed on stop()). */
  _onTick (fn) {
    this._tickHandlers.push(fn)
    this.bot.on('physicsTick', fn)
  }

  /** Idempotent prototype patch helper. */
  _patch (target, name, factory) {
    const key = `${name}`
    if (target[PATCH_MARK] && target[PATCH_MARK].has(key)) return
    const original = target[name]
    if (typeof original !== 'function') {
      this.log('warn', `pathfinder hook ${name} missing — skipping patch`)
      return
    }
    target[name] = factory(original)
    ;(target[PATCH_MARK] || (target[PATCH_MARK] = new Set())).add(key)
    this._applied.push(key)
  }

  /** Configure one Movements instance with digging, door routing, hazards, and threat costs. */
  configureMovements (movements = this._movements()) {
    if (!movements) return false
    movements._zincaiAfterCollisionIndex = () => this._applyBreakPolicy(movements)
    this._applyBreakPolicy(movements)
    this._configureBreakGuard(movements)
    this._configureScaffolding(movements)
    this._configureDoors(movements)
    this._configureWalkableSurfaces(movements)
    this._configureHazards(movements)
    movements.allowSprinting = !this.intents
    movements.maxDropDown = 4
    this.threat.attachToMovements(movements, this.intents)
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
    this._onPathSeen = (result) => {
      if (!result || !Array.isArray(result.path)) return
      this._path = result.path
      // What this route cost in threat when it was planned: the baseline the
      // route watcher compares against (see _watchRoute).
      this._routeBaseline = this.routeThreat().worst
      this._routeBaselineAt = Date.now()
    }
    this.bot.on('path_update', this._onPathSeen)
    this._onTick(this._doorTick.bind(this))
    this._startHumanizer()
    this._startThreatMap()
    return this._applied
  }

  /**
   * Threat cost of the route still ahead: the next `nodes` steps of the path
   * the pathfinder is walking, from the node nearest the bot onward.
   * @returns {{ worst:number, sum:number, critical:boolean, at:{x:number,y:number,z:number}|null, nodes:number }}
   */
  routeThreat ({ nodes = 14 } = {}) {
    const out = { worst: 0, sum: 0, critical: false, at: null, nodes: 0 }
    const path = this._path
    const me = this.bot?.entity?.position
    const field = this.intents?.field()
    if (!Array.isArray(path) || !path.length || !me || (!this.threat.threats.length && !field)) return out
    let start = 0
    let best = Infinity
    for (let i = 0; i < path.length; i++) {
      const n = path[i]
      const d = (n.x + 0.5 - me.x) ** 2 + (n.y - me.y) ** 2 + (n.z + 0.5 - me.z) ** 2
      if (d < best) { best = d; start = i }
    }
    // The cells right around the bot are what they are — the bot is already
    // standing there. What matters is what the route walks INTO.
    for (let i = start + 1; i < path.length && out.nodes < nodes; i++) {
      const n = path[i]
      const pt = { x: n.x + 0.5, y: n.y, z: n.z + 0.5 }
      const extra = field ? field(pt) : 0
      const cost = this.threat.costAt(pt) + (Number.isFinite(extra) ? extra : 60)
      const crit = !Number.isFinite(extra) || this.threat.isCriticalAt(pt)
      out.nodes++
      out.sum += cost
      if (crit) out.critical = true
      if (cost > out.worst) { out.worst = cost; out.at = { x: n.x, y: n.y, z: n.z } }
    }
    return out
  }

  /**
   * THE ROUTE WATCHER. A path is planned once, against the mobs as they stood
   * at that moment; upstream only plans again when a block changes or the bot
   * gets stuck. So a zombie that walked onto the route after it was planned
   * was simply walked into — and the escape reflex then tore the walk down.
   *
   * Every threat sample this looks at the next steps of the route. When they
   * have become clearly more dangerous than when the route was planned — or
   * entered a critical danger ellipse (e.g. a creeper blast zone) — the route
   * is planned again with the updated elliptical threat field.
   * @returns {boolean} true when a re-plan was requested
   */
  _watchRoute (now = Date.now()) {
    if (this.routeReplanMs <= 0) return false
    const pf = this.bot?.pathfinder
    if (!pf || !pf.goal || (typeof pf.isMoving === 'function' && !pf.isMoving())) return false
    const ahead = this.routeThreat()
    const urgent = ahead.critical
    const minInterval = urgent ? Math.min(400, this.routeReplanMs) : this.routeReplanMs
    if (now - (this._lastRouteReplanAt || 0) < minInterval) return false
    // A fresh plan gets a moment before it is second-guessed unless critical.
    if (!urgent && now - (this._routeBaselineAt || 0) < 350) return false
    if (!urgent) {
      if (ahead.worst < this.routeReplanCost) return false
      if (ahead.worst < (this._routeBaseline || 0) + this.routeReplanRise) return false
    }
    this._lastRouteReplanAt = now
    this.threatReplans++
    this.log('debug', `route re-planned (${urgent ? 'critical zone' : 'threat rose'}): ahead=${ahead.worst} (was ${this._routeBaseline || 0}) near ${ahead.at ? `${ahead.at.x},${ahead.at.y},${ahead.at.z}` : '?'}`)
    try { pf.setMovements(pf.movements) } catch { return false }
    return true
  }

  /** 200 ms threat sampling + route watcher + wind-charge recovery after noPath. */
  _startThreatMap () {
    clearInterval(this._threatTimer)
    this._threatTimer = setInterval(() => {
      try {
        this.threat.sample(this.bot)
        const pos = this.bot.entity?.position
        if (this.intents && pos) {
          this.intents.observe(Object.freeze({ at: this.intents.now(), dim: this.intents.dimension(),
            position: Object.freeze({ x: pos.x, y: pos.y, z: pos.z }), health: this.bot.health, food: this.bot.food }))
          this.intents.tick(pos.floored())
        }
      } catch (err) { this.log('debug', `threat sample failed: ${err.message || err}`) }
      try { this._watchRoute() } catch (err) { this.log('debug', `route watch failed: ${err.message || err}`) }
    }, this.threat.sampleMs)
    // Sample immediately so the first path is already threat-aware.
    try { this.threat.sample(this.bot, true) } catch { /* no entity yet */ }

    if (!this._onPathUpdate) {
      this._onPathUpdate = (result) => {
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
   * Where to run, walls and time included (escape.js), incorporating active
   * weighted elliptical threat regions so escape avoids creeper blasts and
   * multi-enemy pinch zones. Pure planning.
   * @param {Array<{x:number,y:number,z:number,speed:number,reach:number}>} pursuers
   * @param {object} [opts] passed to planEscape (radius, botSpeed, …)
   * @returns {null | (ReturnType<typeof planEscape> & { goal: object })}
   */
  escapePlan (pursuers, opts = {}) {
    const m = this._escapeMovements()
    if (!m) return null
    try { this.threat.sample(this.bot) } catch { /* best-effort */ }
    return escapePlanWith(this.bot, m, pursuers, { threatMap: this.threat, ...opts })
  }

  /**
   * Safe detour waypoint planner around active elliptical threat regions while
   * preserving progress toward `destination`. Pure planning.
   * @param {{ x:number, y?:number, z:number }} destination
   * @param {object} [opts]
   * @returns {null | (ReturnType<typeof planSafeDetour> & { goal: object })}
   */
  safeDetourPlan (destination, opts = {}) {
    const m = this._escapeMovements()
    if (!m || !destination) return null
    try { this.threat.sample(this.bot, true) } catch { /* best-effort */ }
    const plan = planSafeDetour(this.bot, m, destination, this.threat, opts)
    if (!plan) return null
    const { goals } = require('mineflayer-pathfinder')
    plan.goal = new goals.GoalBlock(plan.waypoint.x, plan.waypoint.y, plan.waypoint.z)
    return plan
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

  /** Soft natural block ids that ordinary walking may break when no detour exists. */
  _softTerrainIds () {
    const registry = this.bot?.registry
    if (!registry?.blocksArray) return null
    if (this._softIdsCache && this._softIdsCache.registry === registry) return this._softIdsCache.ids
    const ids = new Set()
    for (const b of registry.blocksArray) {
      if (isSoftWalkBlock(b.name)) ids.add(b.id)
    }
    this._softIdsCache = { registry, ids }
    return ids
  }

  /** Protect other players' claimed regions from pathfinder breaking. */
  _configureBreakGuard (movements) {
    if (!Array.isArray(movements.exclusionAreasBreak) || movements.exclusionAreasBreak.some((f) => f && f._zincaiBreakGuard)) return
    const guard = (block) => {
      if (!block?.position) return 0
      try {
        if (this.isProtected && this.isProtected(block.position)) return 100
      } catch { return 100 }
      return 0
    }
    guard._zincaiBreakGuard = true
    movements.exclusionAreasBreak.push(guard)
  }

  /** Block ids that are never breakable, whatever the window says. */
  _doorBlockIds () {
    const registry = this.bot?.registry
    const ids = []
    if (registry?.blocksArray) for (const block of registry.blocksArray) if (doors.kindOf(block.name)) ids.push(block.id)
    return ids
  }

  /**
   * Recompute break policy for one Movements instance:
   *  - Explicit `dig` corridor: any breakable block except unbreakables and doors.
   *  - Ordinary walking (`go_to`): soft natural terrain only (higher cost so detours win).
   */
  _applyBreakPolicy (movements) {
    const open = Boolean(this._digWindow) && Date.now() <= this._digWindow.expiresAt
    const w = open ? this._digWindow : null
    movements.canDig = true
    movements.digCost = w ? 1 : this.policyDigCost
    movements.dontCreateFlow = true
    movements.dontMineUnderFallingBlock = true

    const set = movements.blocksCantBreak
    if (!set) return
    if (!movements._zincaiBaseCantBreak) movements._zincaiBaseCantBreak = new Set(set)
    set.clear()
    for (const id of movements._zincaiBaseCantBreak) set.add(id)
    for (const id of this._doorBlockIds()) set.add(id)
    const cant = (id) => { if (id !== undefined && id !== null) set.add(id) }

    const registry = this.bot?.registry
    for (const name of UNBREAKABLE_BLOCKS) cant(registry?.blocksByName?.[name]?.id)

    if (w) {
      // Explicit dig corridor: unlock containers/workstations too if the model intentionally digs through them;
      // only unbreakable blocks, doors, and explicit cantDig exclusions stay blocked.
      if (w.canDig && registry?.blocksArray) {
        for (const b of registry.blocksArray) if (!w.canDig.has(b.id)) cant(b.id)
      }
      for (const id of w.cantDig) cant(id)
    } else {
      const softIds = this._softTerrainIds()
      if (softIds && registry?.blocksArray) {
        for (const b of registry.blocksArray) if (!softIds.has(b.id)) cant(b.id)
      }
    }
  }

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

  // Ordinary walking never places scaffolding blocks; explicit build tools handle placement.
  _configureScaffolding (movements) {
    movements.allow1by1towers = false
    movements.scafoldingBlocks = []
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
    if (this.pillarExecutor) return this.pillarExecutor(targetY)
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

  /** Normalize & set active movement gait: 'auto' | 'crouch' | 'walk' | 'sprint' | 'sprint_jump'. */
  setGait (gait = 'auto') {
    const raw = String(gait || 'auto').trim().toLowerCase()
    const map = {
      auto: 'auto',
      default: 'auto',
      crouch: 'crouch',
      sneak: 'crouch',
      crouching: 'crouch',
      walk: 'walk',
      walking: 'walk',
      sprint: 'sprint',
      sprinting: 'sprint',
      run: 'sprint',
      sprint_jump: 'sprint_jump',
      'sprint-jump': 'sprint_jump',
      jump_sprint: 'sprint_jump',
      jump_walk: 'sprint_jump',
      fast: 'sprint_jump'
    }
    const next = map[raw] || 'auto'
    if (next !== this._gait) this._releaseOptionalJump()
    this._gait = next
    if (this.intents) {
      this._manualStyleGoal = this.bot.pathfinder?.goal
      this._manualStyleAt = Date.now()
      return next // production styles are applied in one physics callback
    }
    const movements = this._movements()
    const bot = this.bot
    try {
      if (next === 'crouch') {
        if (movements) movements.allowSprinting = false
        bot.setControlState?.('sprint', false)
        bot.setControlState?.('sneak', true)
      } else if (next === 'walk') {
        if (movements) movements.allowSprinting = false
        bot.setControlState?.('sprint', false)
        bot.setControlState?.('sneak', false)
      } else if (next === 'sprint' || next === 'sprint_jump') {
        if (movements) movements.allowSprinting = true
        bot.setControlState?.('sneak', false)
      } else {
        bot.setControlState?.('sneak', false)
      }
    } catch { /* partial mock */ }
    return next
  }

  /** Compatibility adapter for lease-bound procedures, scoped to a Goal object. */
  requestRouteStyle (goal, mode, { near = null, leaseMs = 240_000 } = {}) {
    if (!this._gaitPort || !mode || mode === 'auto') return null
    const key = `route-${++this._locomotionScopes}`
    this._gaitPort.publishLocomotion(key, { goal, mode, reason: 'procedure route style', expiresAt: Date.now() + leaseMs,
      activeWhen: near == null ? null : () => this._goalDistance() <= near })
    return () => this._gaitPort.withdrawLocomotion(key)
  }

  locomotionStats () { return { ...this._locomotionStats, mode: this._effectiveGait } }

  _releaseOptionalJump () {
    if (!this._optionalJumpGoal) return
    this._optionalJumpGoal = null
    this._jumpPulseUntil = 0
    clearTimeout(this._optionalJumpTimer)
    this.bot.setControlState('jump', false)
    // Mineflayer queues jump edges independently of the held key.
    this.bot.jumpQueued = false
  }

  _safeOptionalJump () {
    const { entity } = this.bot
    if (!entity?.onGround || !this.bot.controlState?.forward || this._nearHazard() || this._lowCeiling() || !this._path?.length || this._goalDistance() < 5) return false
    const { Vec3 } = require('vec3')
    const pos = entity.position
    if (Object.values(this.bot.entities || {}).some((e) => e?.name === 'creeper' && e.position?.distanceTo(pos) < 8)) return false
    const dx = -Math.sin(entity.yaw); const dz = -Math.cos(entity.yaw)
    // Conservative flat corridor check. Native pathfinder still handles
    // necessary obstacle jumps with its own physics simulation.
    // Pathfinder consumes this array as it advances. Reject turns or elevation
    // changes within the projected flight, not just obstacles along the yaw ray.
    for (const node of this._path) {
      const x = node.x - pos.x; const z = node.z - pos.z
      const forward = x * dx + z * dz
      if (forward > 4.5) break
      if (forward < -0.5 || Math.abs(x * dz - z * dx) > 0.85 || Math.abs(node.y - pos.y) > 0.2) return false
    }
    const field = this.intents.field()
    for (let d = 0; d <= 4.5; d += 0.5) {
      const p = new Vec3(pos.x + dx * d, pos.y, pos.z + dz * d).floored()
      const floor = this.bot.blockAt(p.offset(0, -1, 0))
      if (floor?.boundingBox !== 'block' || /magma|cactus|campfire|honey|ice|slime/.test(floor.name)) return false
      for (let y = 0; y <= 2; y++) {
        const cell = this.bot.blockAt(p.offset(0, y, 0))
        if (!cell || !/^(air|cave_air|void_air)$/.test(cell.name)) return false
      }
      if (field && field(p) >= 8) return false
      if (this.threat.costAt(p) >= 8) return false
      if (Object.values(this.bot.entities || {}).some((e) => e !== entity && e?.position?.distanceTo(p.offset(0.5, 0, 0.5)) < 1.1)) return false
    }
    // Verify the projected landing as well as the loaded corridor, using the
    // same physics simulator bundled with pathfinder. Never force a jump if
    // the simulator cannot establish a return to the original ground level.
    try {
      const Physics = require('mineflayer-pathfinder/lib/physics')
      const physics = new Physics(this.bot)
      let tick = 0
      const landing = physics.simulateUntil((state) => tick > 1 && state.onGround, (state, i) => {
        tick = i
        Object.assign(state.control, { forward: true, back: false, left: false, right: false, sneak: false, sprint: true, jump: i === 0 })
      }, 18)
      return tick > 1 && landing.onGround && !landing.isInLava && !landing.isInWater &&
        Math.abs(landing.pos.y - pos.y) <= 0.2 && Math.hypot(landing.pos.x - pos.x, landing.pos.z - pos.z) <= 4.5
    } catch { return false }
  }

  _applyLocomotion (now) {
    const bot = this.bot
    const goal = bot.pathfinder?.goal
    const movement = this._movements()
    if (!movement) return
    if (this.isUrgent() && !goal) {
      // Direct stance/emergency adapter owns its keys, never overlay styles.
      this._locomotionStats.compatibilityTicks++
      return
    }
    const request = this.intents.resolveLocomotion({ goal, distance: this._goalDistance(), owner: this.intents.arbiter.owner() })
    const manualForRoute = goal && goal === this._manualStyleGoal && request?.priority <= 1 && request.createdAt <= this._manualStyleAt
    let mode = manualForRoute ? this._gait : (request?.mode || this._gait)
    if (mode === 'auto') mode = this.isUrgent() ? 'sprint' : this._goalDistance() >= 24 && bot.pathfinder.isMoving?.() ? 'sprint_jump' : this._sprintWalkPhase
    const fast = mode === 'sprint' || mode === 'sprint_jump'
    const airborne = !bot.entity.onGround && !bot.entity.isInWater && !bot.entity.isInLava
    const maintainMomentum = airborne && (this._effectiveGait === 'sprint' || this._effectiveGait === 'sprint_jump')
    const unsafe = (Number.isFinite(bot.food) && bot.food <= 6) || (!maintainMomentum && this._nearHazard())
    if (fast && (unsafe || request?.allowSprint === false)) {
      if (this._effectiveGait !== 'walk') this._locomotionStats.safetyDowngrades++
      mode = 'walk'
    }
    if (mode !== this._effectiveGait) this._locomotionStats.transitions++
    this._effectiveGait = mode
    movement.allowSprinting = mode === 'sprint' || mode === 'sprint_jump'
    if (!goal || !this.intents.available()) {
      if (this._styleSneak) bot.setControlState('sneak', false)
      this._styleSneak = false
      return
    }
    const sneak = mode === 'precision' || mode === 'crouch'
    if (sneak || this._styleSneak) bot.setControlState('sneak', sneak)
    this._styleSneak = sneak
    if (!movement.allowSprinting && bot.controlState?.sprint) bot.setControlState('sprint', false)
    if (mode === 'sprint_jump' && request?.allowOptionalJump !== false && bot.pathfinder.isMoving?.() && !this._optionalJumpGoal && !bot.controlState.jump && this._speedMs >= 2 && now - this._lastSprintJumpAt >= 480 && this._safeOptionalJump()) {
      this._lastSprintJumpAt = now
      this._locomotionStats.optionalJumps++
      this._optionalJumpGoal = goal
      this._jumpPulseUntil = now + 90
      this._optionalJumpTimer = setTimeout(() => this._releaseOptionalJump(), 90)
      bot.setControlState('jump', true)
    }
  }

  getGait () { return this._gait }

  /** Current horizontal speed in blocks/sec (m/s). */
  getSpeed () {
    if (this._speedMs > 0) return this._speedMs
    const v = this.bot?.entity?.velocity
    if (!v) return 0
    return Math.round(Math.hypot(Number(v.x) || 0, Number(v.z) || 0) * 200) / 10
  }

  /** Live speed, configured gait, and active posture label for prompt/observation. */
  getMotionState () {
    const bot = this.bot
    const speedMs = this.getSpeed()
    const moving = Boolean(bot?.pathfinder?.isMoving?.()) || speedMs > 0.4
    const observedGait = this.intents && bot?.pathfinder?.goal ? this._effectiveGait : this._gait
    let posture = 'idle'
    if (observedGait === 'precision' || observedGait === 'crouch' || bot?.entity?.isSneaking) posture = 'crouching'
    else if (!moving) posture = `gait: ${this._gait}`
    else if ((!this.intents && (this._gait === 'sprint_jump' || (this._gait === 'auto' && this._goalDistance() >= 24 && speedMs > 4.8))) || (observedGait === 'sprint_jump' && Date.now() - this._lastSprintJumpAt < 500)) posture = 'sprint_jumping'
    else if (bot?.controlState?.sprint || speedMs > 4.7) posture = 'sprinting'
    else if (bot?.entity && bot.entity.onGround === false) posture = 'airborne'
    else posture = 'walking'
    return { speedMs, gait: this._gait, posture }
  }

  /** Perform a single clean normal jump. */
  jumpOnce () {
    const bot = this.bot
    if (!bot?.entity) return false
    if (this.intents && (this.isUrgent() || !this.intents.available() || !bot.entity.onGround || this._nearHazard() || this._lowCeiling())) return false
    try {
      bot.setControlState('jump', true)
      this._jumpPulseUntil = Date.now() + 120
      if (!this.intents) setTimeout(() => {
        try { if (!this.isUrgent()) bot.setControlState('jump', false) } catch { /* gone */ }
      }, 120)
      return true
    } catch { return false }
  }

  _goalDistance () {
    const bot = this.bot
    const goal = bot?.pathfinder?.goal
    const pos = bot?.entity?.position
    if (!goal || !pos) return 0
    const gx = Number(goal.x ?? goal.entity?.position?.x)
    const gz = Number(goal.z ?? goal.entity?.position?.z)
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return 0
    return Math.hypot(gx - pos.x, gz - pos.z)
  }

  _lowCeiling () {
    const bot = this.bot
    try {
      const headAbove = bot.entity.position.floored().offset(0, 2, 0)
      const b = bot.blockAt(headAbove)
      return Boolean(b && b.boundingBox === 'block')
    } catch { return false }
  }

  // ------------------------------------------------- human movement mimic--
  _startHumanizer () {
    const bot = this.bot

    // ±2° micro-jitter on a randomized cadence — never on a fixed metronome.
    const jitter = () => {
      this._jitterTimer = setTimeout(jitter, 400 + Math.random() * 700)
      if (Date.now() < this._pauseUntil) return
      if (!bot.entity || !bot.pathfinder) return
      if (this.intents || this.isUrgent()) return // centralized navigation or fleeing/fighting: do not nudge the aim
      if (!bot.pathfinder.isMoving?.() && !bot.pathfinder.goal) return
      const jYaw = (Math.random() * 2 - 1) * this.jitterRad
      const jPitch = (Math.random() * 2 - 1) * this.jitterRad
      bot.look(bot.entity.yaw + jYaw, bot.entity.pitch + jPitch, true).catch(() => {})
    }
    if (!this.intents) jitter()

    // Variable sprint/walk cycles — sprint is a gait, not a default (unless an explicit gait is set).
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
      if (this.intents) return
      const hazard = this._nearHazard()
      // Running for its life (or fighting) the bot sprints — careful posture included.
      if (this.isUrgent()) { movements.allowSprinting = true; return }
      if (this._careful || this._gait === 'crouch' || this._gait === 'walk') { movements.allowSprinting = false; return }
      if (this._gait === 'sprint' || this._gait === 'sprint_jump') { movements.allowSprinting = !hazard || this._gait === 'sprint_jump'; return }
      movements.allowSprinting = this._sprintWalkPhase === 'sprint' && !hazard
    }
    cycle()

    // 20 Hz speed measurement + gait/sprint-jump/crouch enforcement.
    const motionTick = () => {
      if (!bot.entity?.position) return
      const now = Date.now()
      const p = bot.entity.position
      this._speedSamples.push({ x: p.x, z: p.z, t: now })
      while (this._speedSamples.length > 2 && now - this._speedSamples[0].t > 300) this._speedSamples.shift()
      if (this._speedSamples.length >= 2) {
        const first = this._speedSamples[0]
        const last = this._speedSamples[this._speedSamples.length - 1]
        const dt = (last.t - first.t) / 1000
        if (dt >= 0.04) {
          this._speedMs = Math.round((Math.hypot(last.x - first.x, last.z - first.z) / dt) * 10) / 10
        }
      }

      if (this._jumpPulseUntil && now >= this._jumpPulseUntil) {
        this._jumpPulseUntil = 0
        if (!this.isUrgent() && !bot.entity.isInWater) {
          try { bot.setControlState('jump', false) } catch { /* mock */ }
        }
      }

      if (this.intents) { this._applyLocomotion(now); return }
      const movements = this._movements()
      if (this.isUrgent()) {
        if (movements) movements.allowSprinting = true
        try { if (bot.controlState?.sneak) bot.setControlState('sneak', false) } catch { /* mock */ }
        return
      }

      if (this._gait === 'crouch') {
        if (movements) movements.allowSprinting = false
        try { bot.setControlState('sneak', true); bot.setControlState('sprint', false) } catch { /* mock */ }
        return
      }
      if (this._gait === 'walk') {
        if (movements) movements.allowSprinting = false
        try { bot.setControlState('sneak', false); bot.setControlState('sprint', false) } catch { /* mock */ }
        return
      }
      if (this._gait === 'sprint') {
        if (movements) movements.allowSprinting = true
        try { bot.setControlState('sneak', false) } catch { /* mock */ }
        return
      }

      const wantJumpWalk = this._gait === 'sprint_jump' || (this._gait === 'auto' && this._goalDistance() >= 24)
      if (wantJumpWalk && bot.pathfinder?.isMoving?.()) {
        if (movements) movements.allowSprinting = true
        try { bot.setControlState('sneak', false) } catch { /* mock */ }
        if (
          bot.entity.onGround &&
          !bot.entity.isInWater &&
          !bot.entity.isInLava &&
          !this._nearHazard() &&
          !this._lowCeiling() &&
          this._speedMs >= 2.0 &&
          now - this._lastSprintJumpAt >= 480 &&
          now >= this._pauseUntil
        ) {
          this._lastSprintJumpAt = now
          this._jumpPulseUntil = now + 90
          try {
            bot.setControlState('sprint', true)
            bot.setControlState('jump', true)
          } catch { /* mock */ }
        }
      }
    }
    if (this.intents) {
      // Physics already sampled the previous pulse. Clear it before the native
      // driver writes this tick's obstacle controls, never after those writes.
      this._beforeNativeTick = () => this._releaseOptionalJump()
      this._onOptionalGoalChange = () => this._releaseOptionalJump()
      bot.prependListener('physicsTick', this._beforeNativeTick)
      bot.on('goal_updated', this._onOptionalGoalChange)
    }
    this._onTick(motionTick)

    // Idle pause on abrupt heading change while navigating (200–800ms).
    const headingPause = () => {
      if (this.intents) return
      if (!bot.entity || !bot.pathfinder) return
      if (!bot.pathfinder.isMoving?.()) { this._lastHeading = null; return }
      if (this.isUrgent() || this._gait === 'sprint_jump' || this._gait === 'sprint') { this._lastHeading = bot.entity.yaw; return } // never pause mid-escape or explicit fast gait
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
    if (!this.intents) this._onTick(headingPause)
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
    } catch { return Boolean(this.intents) }
    return false
  }

  /** Remove OUR timers and physicsTick listeners (called on shutdown). */
  stop () {
    this._releaseOptionalJump()
    if (this._beforeNativeTick) this.bot.removeListener('physicsTick', this._beforeNativeTick)
    if (this._onOptionalGoalChange) this.bot.removeListener('goal_updated', this._onOptionalGoalChange)
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
  findGroundY,
  projectFuture,
  pointSegmentDistance,
  isHostileName,
  STANDOFF,
  standoffFor,
  isDoorOrTrapdoorName,
  HOSTILE_RE,
  WIND_CHARGE_ITEM,
  UNBREAKABLE_BLOCKS,
  PASSIVE_WALK_SOFT_BLOCKS
}
