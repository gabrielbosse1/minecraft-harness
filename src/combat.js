/**
 * AdvancedCombat — deterministic, tick-driven combat. The LLM decides WHO to
 * fight; everything from sprinting to critical-hit timing is handled here in
 * code, costing zero tokens.
 *
 * RULES OF ENGAGEMENT (owner policy — a friendly server):
 *   - This controller never starts a fight. It only acts on engage().
 *   - Players are targeted ONLY by exact username. "player" / "any" never
 *     match a player, so nobody is hit because they stood nearest.
 *   - Mob requests match the exact type name (no substrings: "pig" is not a
 *     piglin). Pets, name-tagged mobs, villagers, golems, armor stands and
 *     item frames are never matched.
 *   - A target needs line of sight: no swinging at a caged mob through bars.
 *
 * MECHANICS (vanilla 1.9+, no commands, no cheats):
 *   GOLDILOCKS  engagement band derived from the held item; inside it the bot
 *               strafes at walking speed, too far → pathfinder, too close →
 *               backpedal (never sprinting backwards: a real client cannot).
 *   COOLDOWN    a swing is only issued at a FULL attack indicator. Below 90 %
 *               vanilla refuses to crit and scales damage down.
 *   CRITS       micro-jump, sprint released, swing on the falling tick.
 *   EVASION     against the CURRENT TARGET only, from its measured motion
 *               (position deltas — mineflayer never updates onGround for
 *               other entities): airborne mace → run; elytra dive → sidestep.
 *   CREEPER     hit-and-run: one sprint hit, back out, never stand next to a
 *               lit fuse; shield up when it cannot be outrun.
 *   SHIELD      carried shields go to the off hand; raised between swings in
 *               a duel and against a fuse.
 *   DISENGAGE   below 30 % max health → let go, report, 10 s cooldown.
 *
 * CONTROLS go through injected "hands" (zincai/control.js lane). When the
 * fight ends for ANY reason the hands are released, so no key outlives it.
 *
 * Events are pushed via the injected onEvent({type:'combat', msg, result?}).
 */
'use strict'

const { GoalNear, GoalFollow } = require('mineflayer-pathfinder').goals
const logger = require('./logger')
const { directHands } = require('../zincai/control')
const {
  HOSTILE_NAMES: SENSE_HOSTILE,
  isPlayer,
  isProtected,
  isHostileMob,
  isGliding,
  isUsingItem,
  creeperFuseLit,
  hasLineOfSight
} = require('../zincai/threats')
const { runnableHeading, clearToRun } = require('../zincai/custom_mineflayer/escape')

const TAG = 'combat'

/** Hostile mob type names (exact). Shared with the threat sensor. */
const HOSTILE_NAMES = SENSE_HOSTILE

const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'copper', 'stone', 'golden', 'wooden']
/**
 * Fraction of the attack indicator required before a swing. Vanilla scales
 * damage by 0.2 + s²·0.8 and only allows a critical hit above 0.9, so the old
 * 0.85 gate threw away both. Kept under its historical export name.
 */
const CRIT_THRESHOLD = 1.0

// ---------------------------------------------------------------------------
// Weapon table. `aps` is vanilla attacks/second; the cooldown indicator fills
// in 20/aps ticks. Bands are metres (3D distance).
// ---------------------------------------------------------------------------
const WEAPON_PROFILES = {
  // `reach` is feet-to-feet distance. Vanilla survival reach is 3.0 from the
  // eye to the hitbox, which is about 3.0–3.2 feet-to-feet for a standing mob.
  sword: { key: 'sword', label: 'sword', kind: 'melee', min: 2.0, max: 2.9, aps: 1.6, reach: 3.0, crit: true },
  axe: { key: 'axe', label: 'axe', kind: 'melee', min: 2.0, max: 2.9, aps: 1.0, reach: 3.0, crit: true },
  mace: { key: 'mace', label: 'mace', kind: 'melee', min: 2.0, max: 2.9, aps: 0.6, reach: 3.0, crit: true, needsAir: true },
  trident: { key: 'trident', label: 'trident', kind: 'melee', min: 2.0, max: 2.9, aps: 1.1, reach: 3.0, crit: true },
  spear: { key: 'spear', label: 'spear', kind: 'melee', min: 2.8, max: 3.8, aps: 1.1, reach: 3.8, crit: true },
  bow: { key: 'bow', label: 'bow', kind: 'ranged', min: 10, max: 24, aps: 1.0, reach: 24, chargeMs: 1000 },
  crossbow: { key: 'crossbow', label: 'crossbow', kind: 'ranged', min: 10, max: 20, aps: 0.8, reach: 20, chargeMs: 1250 },
  fists: { key: 'fists', label: 'fists', kind: 'melee', min: 1.6, max: 2.6, aps: 4.0, reach: 3.0, crit: true }
}

/** Vanilla axe attack speed depends on the material. */
const AXE_APS = { wooden: 0.8, stone: 0.8, copper: 0.9, iron: 0.9, golden: 1.0, diamond: 1.0, netherite: 1.0 }

/** Weapon profile for an item id (null/unknown → fists). Never throws. */
function weaponProfile (itemName) {
  const n = String(itemName || '').toLowerCase()
  if (/_sword$/.test(n)) return WEAPON_PROFILES.sword
  const axe = /^([a-z]+)_axe$/.exec(n)
  if (axe) {
    const aps = AXE_APS[axe[1]]
    return aps && aps !== WEAPON_PROFILES.axe.aps ? { ...WEAPON_PROFILES.axe, aps } : WEAPON_PROFILES.axe
  }
  if (n === 'mace') return WEAPON_PROFILES.mace
  if (n === 'trident') return WEAPON_PROFILES.trident
  if (/_spear$/.test(n) || n === 'spear') return WEAPON_PROFILES.spear
  if (n === 'bow') return WEAPON_PROFILES.bow
  if (n === 'crossbow') return WEAPON_PROFILES.crossbow
  return WEAPON_PROFILES.fists
}

/** Cooldown fill fraction ∈ [0,1] for elapsed milliseconds at `aps` attacks/s. */
function cooldownProgress (elapsedMs, aps) {
  const speed = Number.isFinite(aps) && aps > 0 ? aps : 1.6
  const window = 1000 / speed
  if (elapsedMs === Infinity) return 1
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return Math.max(0, Math.min(1, elapsedMs / window))
}

/**
 * Tracks the 1.9+ attack cooldown without touching the server. `arm()` is
 * called exactly when bot.attack() is issued; every read is monotonic in time.
 */
class AttackCooldown {
  constructor ({ now = () => Date.now(), profile = WEAPON_PROFILES.fists } = {}) {
    this.now = now
    this.profile = profile
    this.lastAttackAt = -Infinity
    this.armedAt = -Infinity
  }

  setProfile (profile) {
    if (profile && (profile.key !== this.profile.key || profile.aps !== this.profile.aps)) this.profile = profile
    return this.profile
  }

  /** Record a swing. Returns the ms until the indicator is full again. */
  arm (profile = this.profile) {
    this.profile = profile || this.profile
    this.lastAttackAt = this.now()
    return 1000 / this.profile.aps
  }

  progress () {
    // Never swung yet → the indicator is full, not empty.
    if (!Number.isFinite(this.lastAttackAt)) return 1
    return cooldownProgress(this.now() - this.lastAttackAt, this.profile.aps)
  }

  /** True when the swing would deal (nearly) full damage. */
  ready (threshold = CRIT_THRESHOLD) {
    return this.progress() >= threshold
  }

  remainingMs () {
    return Math.max(0, 1000 / this.profile.aps - (this.now() - this.lastAttackAt))
  }
}

// ---------------------------------------------------------------------------
// Entity capability sensing — what the OTHER guy is holding.
// ---------------------------------------------------------------------------

/** Best-effort held-item name for an entity (players expose equipment only). */
function heldItemName (entity) {
  if (!entity) return ''
  const direct = entity.heldItem?.name || entity.heldItem?.itemId
  if (typeof direct === 'string' && /^[a-z0-9_]+$/.test(direct)) return direct
  if (entity.heldItem?.name) return String(entity.heldItem.name)
  if (entity.itemInHand?.name) return String(entity.itemInHand.name)
  const eq = entity.equipment
  if (Array.isArray(eq)) {
    for (const item of eq) {
      if (!item) continue
      const name = typeof item === 'string' ? item : item.name
      if (name && /sword|axe|mace|trident|spear|bow|crossbow|shield|elytra/.test(String(name))) return String(name)
    }
    const first = eq[0]
    if (first?.name) return String(first.name)
  }
  if (entity.inventory?.slots) {
    for (const item of entity.inventory.slots) {
      if (item?.name) return String(item.name)
    }
  }
  return ''
}

/** Does this entity wear an elytra (or is it gliding)? */
function hasElytra (entity) {
  if (!entity) return false
  if (entity.gliding === true || entity.elytraFlying === true) return true
  const eq = entity.equipment
  if (Array.isArray(eq)) {
    return eq.some((it) => it && /elytra/.test(String(it.name || it)))
  }
  return false
}

/**
 * Measures how another entity is actually moving, from its position between
 * our own ticks. mineflayer leaves `onGround` at true for every remote entity
 * and its velocity field is stale, so "is that mace user in the air?" can
 * only be answered this way.
 */
class MotionTracker {
  constructor ({ now = () => Date.now() } = {}) {
    this.now = now
    this._last = new Map() // id -> { hist: [{x,y,z,at}…] newest last, motion, flat }
  }

  /**
   * Sample one entity. Returns { vx, vy, vz, airborne, rising, falling, fallen }
   * — speeds in blocks per tick; `fallen` is how far it has dropped in the
   * descent it is in (0 on the ground).
   *
   * A server does not deliver every entity's position on every client tick: a
   * tick with no update is followed by one with two. Speed is therefore taken
   * over the last three samples when there are that many, and a descent only
   * counts as over after two still samples (or when the entity rises) —
   * otherwise one late packet would reset a real fall, and one early packet
   * would turn a staircase into a dive.
   */
  update (entity) {
    const none = { vx: 0, vy: 0, vz: 0, airborne: false, rising: false, falling: false, fallen: 0 }
    if (!entity?.position) return none
    const t = this.now()
    const p = entity.position
    const prev = this._last.get(entity.id)
    let m = none
    let flat = 0
    const hist = prev ? prev.hist : []
    if (prev) {
      const last = hist[hist.length - 1]
      if (t - last.at < 5) return prev.motion // same tick: keep the last reading
      // The oldest sample of the last 175 ms (three ticks back at most).
      let ref = last
      for (let i = hist.length - 1; i >= 0 && t - hist[i].at <= 175; i--) ref = hist[i]
      const ticks = Math.max(1, (t - ref.at) / 50)
      const vx = (p.x - ref.x) / ticks
      const vy = (p.y - ref.y) / ticks
      const vz = (p.z - ref.z) / ticks
      const rising = vy > 0.08
      const falling = vy < -0.15
      let fallen = prev.motion.fallen || 0
      const step = last.y - p.y
      if (step > 0.02) { fallen += step; flat = 0 } else if (step < -0.02) { fallen = 0; flat = 0 } else {
        flat = (prev.flat || 0) + 1
        if (flat >= 2) fallen = 0
      }
      m = { vx, vy, vz, airborne: rising || falling, rising, falling, fallen }
    }
    hist.push({ x: p.x, y: p.y, z: p.z, at: t })
    if (hist.length > 4) hist.shift()
    this._last.set(entity.id, { hist, motion: m, flat, at: t })
    if (this._last.size > 64) for (const [id, v] of this._last) if (t - v.at > 5000) this._last.delete(id)
    return m
  }

  forget (entity) { if (entity) this._last.delete(entity.id) }
}

/**
 * Classify a threat from its equipment and motion. Pure and unit-tested.
 *
 * `motion` (from MotionTracker) is authoritative when given. Without it the
 * entity's own fields are used, which is only meaningful for hand-built test
 * entities and for the bot itself.
 *
 * Holding a weapon is NOT a threat: a mace only matters while its owner is in
 * the air, a trident only during an elytra dive.
 *
 * @param {object} entity
 * @param {{botPos?:{x,y,z}, distance?:number, motion?:{vy:number, airborne:boolean}}} [opts]
 * @returns {{name:string, heldItem:string, distance:number, airborne:boolean,
 *   elytra:boolean, tags:string[], explosive:boolean}}
 */
function classifyThreat (entity, { botPos = null, distance = null, motion = null } = {}) {
  const tags = []
  const heldItem = heldItemName(entity)
  const pos = entity?.position
  const dist = Number.isFinite(distance)
    ? distance
    : (pos && botPos ? Math.hypot(pos.x - botPos.x, pos.y - botPos.y, pos.z - botPos.z) : Infinity)
  const vy = motion ? (Number(motion.vy) || 0) : (Number(entity?.velocity?.y) || 0)
  const airborne = motion ? Boolean(motion.airborne) : (entity?.onGround === false || vy > 0.08)
  const elytra = hasElytra(entity)
  const explosive = /^creeper$/i.test(String(entity?.name || ''))
  const mace = heldItem === 'mace'
  const ranged = heldItem === 'bow' || heldItem === 'crossbow' // not "bowl"
  const thrust = /^(trident|spear)$|_spear$/.test(heldItem)

  if (mace && airborne) tags.push('mace_airborne')
  if (elytra) tags.push('elytra')
  if (thrust && elytra && airborne) tags.push('elytra_charge')
  if (ranged) tags.push('ranged')
  if (explosive) tags.push('explosive')
  if (!tags.length || tags.every((t) => t === 'elytra')) tags.push('melee')

  return {
    name: String(entity?.name || 'hostile').toLowerCase(),
    heldItem,
    distance: dist,
    airborne,
    elytra,
    explosive,
    tags
  }
}

// ---------------------------------------------------------------------------
// Evasion by time-to-impact.
//
// The old triggers were "mace in hand and any vertical motion" and "spear,
// elytra and vertical motion". A hop or a staircase set off the first (the
// bot ran for 1.4 s every time a friend jumped), a level glide never set off
// the second, and both fired a quarter of a second before the hit. What is
// about to hit is a question of geometry: where will that body be, and when.
// ---------------------------------------------------------------------------
const GRAVITY = 0.08 // blocks per tick², with 2 % drag per tick

/** Closest approach of something at `rel` (from the bot) moving at `vel` (blocks/s). */
function closestApproach (rel, vel) {
  const speed2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z
  if (speed2 < 1e-6) return { t: Infinity, miss: Math.hypot(rel.x, rel.y, rel.z), speed: 0 }
  const t = -(rel.x * vel.x + rel.y * vel.y + rel.z * vel.z) / speed2
  return { t, miss: Math.hypot(rel.x + vel.x * t, rel.y + vel.y * t, rel.z + vel.z * t), speed: Math.sqrt(speed2) }
}

/**
 * What is about to hit the bot, from measured motion — never from what is
 * merely held. Pure and unit-tested.
 *
 *   smash   a mace coming down: a real fall (1.5 blocks or more, at falling
 *           speed — not a hop, not a staircase) that lands within reach.
 *   charge  a body arriving faster than a sprint (elytra, riptide, mount), or
 *           a spear or trident being driven in, on a line that passes within
 *           2.5 blocks in under 0.9 s.
 *
 * @param {object} attacker { position, heldItem | equipment }
 * @param {object} me the bot's entity { position, velocity (blocks/tick) }
 * @param {{vx:number,vy:number,vz:number,falling:boolean,fallen:number}} motion the attacker's measured motion
 * @param {{ gliding?: boolean, usingItem?: boolean, held?: string }} [seen]
 * @returns {null | { kind:'smash'|'charge', inSec:number, miss:number, line:{x:number,z:number}|null, at:{x:number,z:number}|null }}
 */
function forecastImpact (attacker, me, motion, seen = {}) {
  const a = attacker?.position
  const b = me?.position
  if (!a || !b || !motion) return null
  const held = seen.held ?? heldItemName(attacker)

  if (held === 'mace') {
    if (!(motion.falling && motion.fallen >= 1.5 && motion.vy <= -0.42)) return null
    let v = motion.vy
    let dropped = 0
    let ticks = 0
    const height = a.y - b.y
    while (dropped < height && ticks < 40) { v = (v - GRAVITY) * 0.98; dropped -= v; ticks++ }
    const at = { x: a.x + motion.vx * ticks, z: a.z + motion.vz * ticks }
    const miss = Math.hypot(at.x - b.x, at.z - b.z)
    return miss <= 3.5 ? { kind: 'smash', inSec: ticks / 20, miss, line: null, at } : null
  }

  const mine = me.velocity || {}
  const rel = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
  const vel = { x: (motion.vx - (Number(mine.x) || 0)) * 20, y: motion.vy * 20, z: (motion.vz - (Number(mine.z) || 0)) * 20 }
  const ca = closestApproach(rel, vel)
  const thrust = /^(trident|spear)$|_spear$/.test(held)
  const fast = ca.speed >= 8 // faster than a sprint-jump
  const lunge = thrust && (seen.usingItem || seen.gliding) && ca.speed >= 3
  const glide = Boolean(seen.gliding) && ca.speed >= 6
  if (!(fast || lunge || glide)) return null
  if (!(ca.t > 0 && ca.t <= 0.9) || ca.miss > 2.5) return null
  const flat = Math.hypot(vel.x, vel.z)
  return { kind: 'charge', inSec: ca.t, miss: ca.miss, line: flat > 0.5 ? { x: vel.x / flat, z: vel.z / flat } : null, at: null }
}

// ---------------------------------------------------------------------------

class AdvancedCombat {
  /**
   * @param {object} bot mineflayer bot (pathfinder plugin loaded)
   * @param {object} opts
   *   maxHealth, disengageHealthFraction, attackCooldownMs, disengageCooldownMs,
   *   engageRadius, onEvent(fn) — delta sink, now() injectable for tests,
   *   threatMap — PredictiveThreatMap for escape routing,
   *   critThreshold, recoveryMs, bowChargeThreshold,
   *   hands — control lane (zincai/control.js); default presses the bot directly,
   *   fleeOnDisengage — set false when a survival layer handles running away,
   *   lineOfSight(entity) — override for the caged-mob check,
   *   watch() — other entities to dodge during a fight (players who hit the
   *             bot recently): a third player diving in used to go unseen
   */
  constructor (bot, {
    maxHealth = 20,
    disengageHealthFraction = 0.3,
    attackCooldownMs = 600, // legacy floor; the real gate is the cooldown indicator
    disengageCooldownMs = 10_000,
    engageRadius = 24,
    onEvent = () => {},
    now = () => Date.now(),
    threatMap = null,
    critThreshold = CRIT_THRESHOLD,
    recoveryMs = 220,
    bowChargeThreshold = 1.0,
    hands = null,
    fleeOnDisengage = true,
    lineOfSight = null,
    watch = null
  } = {}) {
    this.bot = bot
    this.maxHealth = maxHealth
    this.disengageAt = Math.max(1, Math.floor(maxHealth * disengageHealthFraction))
    this.attackCooldownMs = attackCooldownMs
    this.disengageCooldownMs = disengageCooldownMs
    this.engageRadius = engageRadius
    this.onEvent = onEvent
    this.now = now
    this.threatMap = threatMap
    // Below 0.9 vanilla never crits; never let config drag the gate under it.
    this.critThreshold = Math.max(0.9, Number(critThreshold) || CRIT_THRESHOLD)
    this.recoveryMs = recoveryMs
    this.bowChargeThreshold = bowChargeThreshold
    this.hands = hands || directHands(bot)
    this.fleeOnDisengage = fleeOnDisengage !== false
    this.lineOfSight = typeof lineOfSight === 'function' ? lineOfSight : (e) => hasLineOfSight(this.bot, e)
    this.motion = new MotionTracker({ now: this.now })
    this.watch = typeof watch === 'function' ? watch : () => []
    this._evadeDir = null

    this.state = 'idle' // idle | approach | melee | retreat | cooldown
    this.target = null
    this.wantedName = null
    this.strafeSign = 1
    this.strafeFlipAt = 0
    this.attackReadyAt = 0
    this.critArmed = false
    this.critDeadline = 0
    this.cooldownUntil = 0
    this.cooldown = new AttackCooldown({ now: this.now })
    this.profile = WEAPON_PROFILES.fists
    this.recoveryUntil = 0
    this.evadeUntil = 0
    this.evadeReason = null
    this.lastThreat = null
    this.bow = { charging: false, startedAt: 0, shots: 0 }
    this._panicAt = 0
    this._shieldUp = false
    this._backoffUntil = 0
    this._targetDead = false
    // A kill can precede the destroy packet by a few ticks. Tombstone the
    // entity object (not its numeric id, which a server may later reuse) so
    // kill-chaining cannot reacquire that same dead mob in the gap.
    this._deadEntities = new WeakSet()
    this._hits = 0
    /** Goal object exposed to the anti-stuck watchdog for path recalculation. */
    this.activeGoal = null

    this._tick = this._tick.bind(this)
    this._housekeeping = this._housekeeping.bind(this)
    this._onEntityGone = this._onEntityGone.bind(this)
    this._onEntityDead = this._onEntityDead.bind(this)
  }

  start () {
    if (this._started) return
    this._started = true
    this.bot.on('physicsTick', this._tick)
    this.bot.on('entityGone', this._onEntityGone)
    this.bot.on('entityDead', this._onEntityDead)
    this._housekeepingTimer = setInterval(this._housekeeping, 250)
  }

  stop () {
    this.bot.removeListener('physicsTick', this._tick)
    this.bot.removeListener('entityGone', this._onEntityGone)
    this.bot.removeListener('entityDead', this._onEntityDead)
    clearInterval(this._housekeepingTimer)
    this._started = false
    this._letGo()
    this.state = 'idle'
    this.target = null
  }

  get isEngaged () {
    return this.state === 'approach' || this.state === 'melee' || this.state === 'retreat'
  }

  /** Held item name of the bot (works with partial mocks). */
  heldWeapon () {
    const bot = this.bot
    const direct = bot.heldItem?.name
    if (direct) return direct
    try {
      const slot = bot.getEquipmentDestSlot?.('hand')
      if (Number.isFinite(slot)) {
        const item = bot.inventory?.slots?.[slot]
        if (item?.name) return item.name
      }
      const qs = bot.quickBarSlot
      const inBar = bot.inventory?.slots?.[36 + (Number.isFinite(qs) ? qs : 0)]
      if (inBar?.name) return inBar.name
    } catch { /* mock inventory */ }
    return ''
  }

  /** Recompute the Goldilocks band from the held item. */
  refreshProfile () {
    const item = this.heldWeapon()
    const next = weaponProfile(item)
    if (next.key !== this.profile.key || next.aps !== this.profile.aps) {
      logger.debug(TAG, `weapon profile → ${next.label} (${next.min}–${next.max}m, ${next.aps}/s)`)
      this.profile = next
      this.cooldown.setProfile(next)
      this.critArmed = false
      if (this.bow.charging) this._releaseBow()
    }
    return next
  }

  // ------------------------------------------------------------targeting--

  /**
   * Resolve an attack request to one entity, or explain why not.
   *
   * @param {string|{name?:string, player?:string}} request
   *   "zombie"            → nearest zombie in line of sight (exact type name)
   *   "any" / "hostile"   → nearest hostile mob in line of sight
   *   {player:"Gabriel"}  → that player, and nobody else
   *   "Gabriel"           → same, when an online player has exactly that name
   * @returns {{ target: object|null, why?: string }}
   */
  resolveTarget (request) {
    const botPos = this.bot.entity?.position
    if (!botPos) return { target: null, why: 'no_target' }
    const asPlayer = request && typeof request === 'object' ? String(request.player || '').trim() : ''
    const raw = asPlayer || String((request && typeof request === 'object' ? request.name : request) || 'any').trim()
    const wanted = raw.toLowerCase()
    if (!asPlayer && (wanted === 'player' || wanted === 'players')) return { target: null, why: 'name_the_player' }

    let best = null
    let bestDist = Infinity
    let sawProtected = false
    let sawHidden = false
    const anyHostile = wanted === 'any' || wanted === 'hostile' || wanted === 'hostiles' || wanted === 'mob'
    for (const id of Object.keys(this.bot.entities)) {
      const e = this.bot.entities[id]
      if (!e || !e.position || e === this.bot.entity || this._deadEntities.has(e)) continue
      if (e.name === undefined || e.name === null) continue
      const dist = e.position.distanceTo(botPos)
      if (isPlayer(e)) {
        // A player is only ever matched by exact username — and then at any
        // distance they are visible from: the model named them on purpose
        // (a duel is often called from across the field).
        if (String(e.username || '').toLowerCase() !== wanted) continue
      } else {
        if (dist > this.engageRadius) continue
        if (asPlayer) continue
        const nameL = String(e.name).toLowerCase()
        if (anyHostile ? !isHostileMob(nameL, this.bot) : nameL !== wanted) continue
        if (isProtected(e)) { sawProtected = true; continue }
        if (!this.lineOfSight(e)) { sawHidden = true; continue }
      }
      if (dist < bestDist) { best = e; bestDist = dist }
    }
    if (best) return { target: best }
    if (sawProtected) return { target: null, why: 'protected' }
    if (sawHidden) return { target: null, why: 'no_line_of_sight' }
    // A player who is named but not visible: say so, so the model can walk
    // there (or give up) instead of concluding nothing can be attacked.
    const online = Object.keys(this.bot.players || {}).some((n) => n.toLowerCase() === wanted && n !== this.bot.username)
    if (asPlayer || online) return { target: null, why: 'player_not_in_sight' }
    return { target: null, why: 'no_target' }
  }

  /** Back-compat: the entity for a request, or null. */
  findTarget (request) {
    return this.resolveTarget(request).target
  }

  /** Entry point for {"a":"attack","n":"zombie"}. Never throws. */
  async engage (request) {
    if (this.bot.health !== undefined && this.bot.health <= 0) {
      return { ok: false, why: 'dead' }
    }
    // A fight the very next tick would break off is not started. It used to
    // engage, call the flee off for a moment, break off at once and lock
    // fighting out for 10 s — one model call per round for nothing.
    if (Number(this.bot.health) <= this.disengageAt) {
      return { ok: false, why: 'low_hp' }
    }
    if (this.now() < this.cooldownUntil) {
      return { ok: false, why: 'disengage_cooldown' }
    }
    const { target, why } = this.resolveTarget(request)
    if (!target) return { ok: false, why: why || 'no_target' }

    const label = isPlayer(target) ? String(target.username || 'player') : String(target.name).toLowerCase()
    // Asked again for the fight already in progress: carry on, do not restart it.
    if (this.isEngaged && this.target === target) return { ok: true, target: label, already: true }
    this.wantedName = label
    this.target = target
    this.state = 'approach'
    this.strafeFlipAt = this.now() + 1200 + Math.floor(Math.random() * 1100)
    this.critArmed = false
    this._targetDead = false
    this._backoffUntil = 0
    this._hits = 0
    this.hands.acquire({ reason: `fight ${label}` })
    await this._equipBestWeapon()
    await this._equipShield()
    this.refreshProfile()
    this._ensureFollowGoal()
    this.onEvent({ type: 'combat', msg: `engaged ${label}` })
    logger.info(TAG, `engaging ${label} (id ${target.id}) with ${this.profile.label} band ${this.profile.min}–${this.profile.max}m`)
    return { ok: true, target: label }
  }

  /**
   * Force-disengage (also used internally at low health).
   * @param {string} reason
   * @param {{ cooldown?: boolean }} opts cooldown=false when the MODEL ended
   *   the fight (stop, or a new task): it may start another one right away.
   *   The lockout is for break-offs the body forced (low health).
   */
  disengage (reason = 'manual', { cooldown = true } = {}) {
    const danger = this.target?.position
    this._letGo()
    this.state = cooldown ? 'cooldown' : 'idle'
    this.cooldownUntil = cooldown ? this.now() + this.disengageCooldownMs : 0
    // Without a survival layer (harness A) the controller walks away itself.
    const away = this.fleeOnDisengage ? this._awayGoal(danger) : null
    if (away) {
      this.activeGoal = { goal: away, dynamic: false }
      this.hands.acquire({ reason: 'disengage', ttlMs: this.disengageCooldownMs })
      this.hands.setGoal(away, false)
    }
    const label = reason === 'low_hp' ? 'disengaged low_hp' : `disengaged ${reason}`
    this.target = null
    this.onEvent({ type: 'combat', msg: label, result: 'disengaged' })
    logger.warn(TAG, label)
    return { ok: true }
  }

  // ------------------------------------------------------------- internals--

  /** Drop everything the fight was holding: keys, goal, bow, shield. */
  _letGo () {
    this._releaseBow()
    this._shield(false)
    this.critArmed = false
    this.activeGoal = null
    try { this.hands.release('fight over') } catch { /* bot gone */ }
  }

  _end (msg, result) {
    logger.info(TAG, msg)
    if (result === 'won' && this.target && typeof this.target === 'object') this._deadEntities.add(this.target)
    this.motion.forget(this.target)
    this.target = null
    this.state = 'idle'
    this._letGo()
    this.onEvent({ type: 'combat', msg, result })
  }

  /** Escape destination: predictive threat vector when available. */
  _awayGoal (danger = this.target?.position) {
    const botPos = this.bot.entity?.position
    if (!botPos) return null
    let dx = 1; let dz = 1
    if (this.threatMap?.escapeVector) {
      try {
        this.threatMap.sample?.(this.bot, true)
        const v = this.threatMap.escapeVector(botPos)
        if (v && Number.isFinite(v.x) && Number.isFinite(v.z) && Math.hypot(v.x, v.z) > 0.01) {
          dx = v.x; dz = v.z
        }
      } catch { /* fall through to geometry */ }
    }
    if (dx === 1 && dz === 1) {
      if (danger) {
        dx = botPos.x - danger.x
        dz = botPos.z - danger.z
        const len = Math.hypot(dx, dz)
        if (len > 0.01) { dx /= len; dz /= len } else { dx = 1; dz = 0 }
      }
    }
    // Same height as the bot — vertical refuge selection is the pathfinder's job.
    return new GoalNear(botPos.x + dx * 14, Math.floor(botPos.y), botPos.z + dz * 14, 2)
  }

  async _equipBestWeapon () {
    try {
      const items = this.bot.inventory.items()
      let best = null
      let bestScore = -1
      for (const item of items) {
        const m = /^(netherite|diamond|iron|copper|stone|golden|wooden)_(sword|axe)$/.exec(item.name)
        if (!m) continue
        const tier = WEAPON_TIERS.indexOf(m[1])
        const kindBonus = m[2] === 'sword' ? 2 : 1
        const score = (WEAPON_TIERS.length - tier) * 10 + kindBonus
        if (score > bestScore) { bestScore = score; best = item }
      }
      if (best && this.bot.heldItem?.name !== best.name) await this.bot.equip(best, 'hand')
    } catch (err) {
      logger.debug(TAG, `weapon equip skipped: ${err.message || err}`)
    }
  }

  /** Item in the off hand, if any (slot 45 on every 1.9+ inventory). */
  _offHandItem () {
    try {
      const slot = this.bot.getEquipmentDestSlot?.('off-hand')
      return this.bot.inventory?.slots?.[Number.isFinite(slot) ? slot : 45] || null
    } catch { return null }
  }

  hasShield () {
    return this._offHandItem()?.name === 'shield'
  }

  /** Move a carried shield to the off hand (only into an empty off hand). */
  async _equipShield () {
    try {
      if (this.profile.kind === 'ranged') return false
      if (this._offHandItem()) return this.hasShield()
      const shield = this.bot.inventory.items().find((i) => i.name === 'shield')
      if (!shield) return false
      await this.bot.equip(shield, 'off-hand')
      return true
    } catch (err) {
      logger.debug(TAG, `shield equip skipped: ${err.message || err}`)
      return false
    }
  }

  /** Raise / lower the off-hand shield. Idempotent. */
  _shield (up) {
    if (Boolean(up) === this._shieldUp) return
    try {
      if (up) {
        if (!this.hasShield()) return
        this.bot.activateItem(true)
      } else {
        this.bot.deactivateItem()
      }
      this._shieldUp = Boolean(up)
    } catch { /* gone */ }
  }

  _ensureFollowGoal () {
    if (!this.target) return
    try {
      // Hold the existing dynamic follow goal while the pathfinder still has a
      // live path to the target; only re-create/re-set it when the path ran out
      // (e.g. target moved out of reach, goal cleared, pathfinder stalled).
      if (this.activeGoal?.dynamic && this.bot.pathfinder?.isMoving?.()) return
      const followRange = Math.max(1, Math.round(this.profile.min))
      const goal = new GoalFollow(this.target, followRange)
      this.activeGoal = { goal, dynamic: true }
      this.hands.setGoal(goal, true)
    } catch (err) {
      logger.debug(TAG, `follow goal failed: ${err.message || err}`)
    }
  }

  _clearControls () {
    try { this.hands.clearControlStates() } catch { /* bot gone */ }
  }

  _entityAlive (e) {
    return Boolean(e && this.bot.entities[e.id])
  }

  _onEntityDead (e) {
    if (this.target && e && e.id === this.target.id) this._targetDead = true
  }

  _onEntityGone (e) {
    if (!this.target || !e || e.id !== this.target.id) return
    // Only a death is a kill. A despawn, a logout or walking out of view is not.
    if (this._targetDead || (this._hits > 0 && Number(this.target.health) <= 0)) this._end('target down', 'won')
    else this._end('target lost (left view)', 'lost')
  }

  /** Housekeeping at 4 Hz: health gate, cooldown expiry, target sanity. */
  _housekeeping () {
    if (this.bot.health === undefined) return
    const now = this.now()
    if (this.state === 'cooldown' && now >= this.cooldownUntil) {
      this.state = 'idle'
      this.activeGoal = null
      try { this.hands.release('cooldown over') } catch { /* gone */ }
    }
    if (this.state === 'retreat' && now >= this.evadeUntil && now >= this._backoffUntil) {
      this.state = this.target ? 'approach' : 'idle'
      this.evadeReason = null
      this._evadeDir = null
      this._shield(false)
      this._clearControls()
    }
    if (this.state === 'approach' || this.state === 'melee' || this.state === 'retreat') {
      if (this.bot.health <= this.disengageAt) {
        this.disengage('low_hp')
        return
      }
      if (!this._entityAlive(this.target)) {
        if (this._targetDead) this._end('target down', 'won')
        else this._end('target lost (left view)', 'lost')
      }
    }
  }

  /** Public hook: one combat mechanics tick (no-op unless a fight is on). */
  forceTick () {
    try { this._tick() } catch (err) { logger.debug(TAG, `forceTick: ${err.message || err}`) }
  }

  /** Public hook: break away from the current target. No-op when idle. */
  panicRetreat (reason = 'mace') {
    if (!this.isEngaged) return null
    this._panicRetreat(reason, this.now())
    return reason
  }

  /** Public hook: sidestep the current target's line. No-op when idle. */
  evadeLateral (reason = 'elytra') {
    if (!this.isEngaged) return null
    this._lateralEvade(reason, this.now())
    return reason
  }

  /** Physics-tick pursuit + melee mechanics (20 Hz). */
  _tick () {
    if (this.state !== 'approach' && this.state !== 'melee' && this.state !== 'retreat') return
    if (!this.target || !this.bot.entity) return
    // A higher-priority lane (survival) is driving: do not swing or steer —
    // and do not keep the shield up while running (it slows the escape to a walk).
    if (this.hands.active === false || this.hands.isTop === false) { this._shield(false); return }
    const now = this.now()

    const botPos = this.bot.entity.position
    const tPos = this.target.position
    const dx = tPos.x - botPos.x
    const dz = tPos.z - botPos.z
    const dy = tPos.y - botPos.y
    const horiz = Math.hypot(dx, dz)
    const dist3 = Math.sqrt(horiz * horiz + dy * dy)

    const profile = this.refreshProfile()
    const motion = this.motion.update(this.target)
    const threat = classifyThreat(this.target, { botPos, distance: dist3, motion })
    this.lastThreat = threat

    // ---- RETREAT state (dodge / creeper back-off) --------------------------
    if (this.state === 'retreat') {
      if (this._evadeDir) this._runAlong(this._evadeDir)
      else this._runFrom(tPos)
      return
    }

    // Face the target smoothly — force=false avoids violent snap-turns.
    try {
      const height = Number(this.target.height) || 1.8
      this.bot.lookAt(tPos.offset(0, height * 0.6, 0), false).catch(() => {})
    } catch { /* look failed; non-fatal */ }

    // ---- EVASION by time-to-impact (highest priority) ----------------------
    const incoming = this._incoming(motion)
    if (incoming && this._evade(incoming, now)) return

    // ---- CREEPER: hit and run ---------------------------------------------
    if (threat.explosive && this._creeperTick({ dist3, now })) return

    // ---- RANGED DUEL -------------------------------------------------------
    // Only when WE hold the bow. An enemy archer facing a swordsman should be
    // closed down (Goldilocks below), not stared at from 20 m.
    if (profile.kind === 'ranged') {
      this._rangedTick({ profile, threat, dist3, now })
      return
    }

    // ---- GOLDILOCKS ZONE ---------------------------------------------------
    const bandMin = profile.min
    const bandMax = profile.max
    if (horiz > bandMax + 0.8) {
      if (this.state !== 'approach') {
        this.state = 'approach'
        this.critArmed = false
        this._shield(false)
        this._clearControls()
      }
      this._ensureFollowGoal() // re-arm dynamic follow if pathfinder lost it
      return
    }

    if (this.state !== 'melee') {
      this.state = 'melee'
      this.activeGoal = null
      this.hands.setGoal(null)
      this._clearControls()
      this.strafeFlipAt = now + 900 + Math.floor(Math.random() * 900)
    }

    // Strafe flip — keeps the bot orbiting, not moonwalking backwards into lava.
    if (now >= this.strafeFlipAt) {
      this.strafeSign = -this.strafeSign
      this.strafeFlipAt = now + 1200 + Math.floor(Math.random() * 1100)
    }

    // Shield between swings in a duel: up while the indicator recharges.
    if (isPlayer(this.target) && this.hasShield() && !this.critArmed) {
      this._shield(this.cooldown.progress() < 0.7 && dist3 <= 4.5)
    }

    // Post-swing recovery: backpedal to reset the threat distance.
    if (now < this.recoveryUntil) {
      this._applyStance({ forward: false, back: true, strafe: true })
      return
    }

    // Band-keeping: too close → backpedal, inside → orbit, too far was handled.
    // Never sprint here: a real client cannot sprint sideways or backwards,
    // and a sprinting attacker cannot land a critical hit.
    if (horiz < bandMin) {
      this._applyStance({ forward: false, back: true, strafe: true })
    } else {
      this._applyStance({ forward: false, back: false, strafe: true })
    }

    // Out of reach but inside the band (mace jump setup): step in.
    if (dist3 > profile.reach + 0.2) {
      this._applyStance({ forward: true, back: false, strafe: true })
      if (profile.needsAir && this.bot.entity.onGround && this.cooldown.ready(this.critThreshold)) {
        this._jumpPulse()
      }
      return
    }

    // ---- CRITICAL-HIT EXECUTION -------------------------------------------
    if (this.critArmed) {
      const falling = !this.bot.entity.onGround && this.bot.entity.velocity.y < 0
      const expired = now > this.critDeadline
      if ((falling || expired) && this.cooldown.ready(this.critThreshold)) {
        if (dist3 <= profile.reach + 0.3) this._swing()
        this.critArmed = false
        this.recoveryUntil = now + this.recoveryMs
      } else if (expired) {
        this.critArmed = false
      }
      return
    }

    // Vanilla cooldown gate: never spam-click. Full indicator only.
    if (!this.cooldown.ready(this.critThreshold)) return

    if (profile.needsAir && !this.bot.entity.onGround) {
      // Mace: already airborne — swing on the falling tick for a smash.
      if (this.bot.entity.velocity.y <= 0) this._swing()
      return
    }

    if (this.bot.entity.onGround) {
      // Micro-jump into the swing → critical hit. Lower the shield first.
      this._shield(false)
      this._jumpPulse()
      this.critArmed = true
      this.critDeadline = now + 900
    } else if (this.bot.entity.velocity.y < 0) {
      // Already falling (knockback, terrain): take the crit now.
      this._swing()
    }
  }

  /**
   * Creeper handling. Returns true when it took over this tick.
   *
   * A creeper starts its 1.5 s fuse within 3 blocks and only stops it once
   * its target is more than 7 blocks away (or out of sight). So: walk in,
   * land ONE sprint hit the moment it is in reach (knockback buys distance),
   * then run until the fuse is out, and repeat. No crit jump — it costs the
   * half second the escape needs. No shield either: blocking saves the bot
   * but still leaves a crater in whatever is nearby.
   */
  _creeperTick ({ dist3, now }) {
    const lit = creeperFuseLit(this.target)
    // Hit-and-run needs somewhere to run. With a wall or a drop behind, the
    // "run" ends inside the blast: do not go in at all.
    if (!lit && now >= this._backoffUntil && dist3 <= 6 && !this._roomToBackOff(this.target.position, 6)) {
      this._end('no room to back off from the creeper here (wall or drop behind you) — not going in', 'aborted')
      return true
    }
    if (now >= this._backoffUntil && dist3 <= this.profile.reach + 0.2 && this.cooldown.ready(this.critThreshold)) {
      this._swing({ keepSprint: true })
      this._backoffUntil = now + 1500
    }
    if (lit || now < this._backoffUntil) {
      if (dist3 < 7.5) {
        if (this.state !== 'retreat') {
          this.state = 'retreat'
          this.evadeReason = 'creeper'
          this._evadeDir = null
          this.evadeUntil = now + 500
          this.activeGoal = null
          this.hands.setGoal(null)
        }
        this._runFrom(this.target.position)
        return true
      }
      this._clearControls()
      return true // far enough: wait for the fuse to go out
    }
    return false // fuse out, not in reach yet: approach like any other mob
  }

  /** One confirmed swing; arms the cooldown and starts the backpedal window. */
  _swing ({ keepSprint = false } = {}) {
    try {
      this._shield(false)
      // Sprinting blocks critical hits; the pathfinder may have left it on.
      // (Kept on purpose for the creeper hit: sprint knockback buys distance.)
      if (!keepSprint) this.hands.setControlState('sprint', false)
      this.bot.attack(this.target)
      const now = this.now()
      this._hits++
      this.cooldown.arm(this.profile)
      this.attackReadyAt = now + this.attackCooldownMs
      this.recoveryUntil = now + this.recoveryMs
      this.onEvent({ type: 'combat', msg: `hit ${this.lastThreat?.name || 'target'} (${this.profile.label})` })
    } catch (err) {
      logger.debug(TAG, `attack failed: ${err.message || err}`)
    }
  }

  _jumpPulse () {
    try { this.hands.pulse('jump', 60) } catch { /* gone */ }
  }

  /** Press exactly the movement keys a stance needs. */
  _applyStance ({ forward, back, sprint, strafe }) {
    const h = this.hands
    h.setControlState('forward', Boolean(forward))
    h.setControlState('back', Boolean(back))
    // Sprint only ever accompanies forward movement, as in the real client.
    h.setControlState('sprint', Boolean(sprint) && Boolean(forward) && !back)
    h.setControlState('left', Boolean(strafe) && this.strafeSign < 0)
    h.setControlState('right', Boolean(strafe) && this.strafeSign > 0)
  }

  /** Unit vector from `danger` to the bot (horizontal). */
  _awayFrom (danger) {
    const pos = this.bot.entity?.position
    if (!pos || !danger) return null
    const dx = pos.x - danger.x
    const dz = pos.z - danger.z
    const len = Math.hypot(dx, dz)
    return len < 0.01 ? { x: 1, z: 0 } : { x: dx / len, z: dz / len }
  }

  /** Is there ground to retreat on, roughly away from `danger`, for `blocks` blocks? */
  _roomToBackOff (danger, blocks = 6) {
    const away = this._awayFrom(danger)
    if (!away) return true
    return Boolean(runnableHeading(this.bot, away, { blocks, maxTurn: 1.2 }))
  }

  /**
   * Turn away from a point and sprint: the only honest way to retreat fast —
   * along the nearest heading that has ground. It used to sprint-jump straight
   * back with no look at walls or ledges.
   */
  _runFrom (danger) {
    const away = this._awayFrom(danger)
    if (!away) return false
    return this._runAlong(runnableHeading(this.bot, away, { blocks: 3, maxTurn: 1.6 }))
  }

  /** Face a horizontal direction and sprint-jump along it; with no direction, stand and cover. */
  _runAlong (dir) {
    const h = this.hands
    h.setControlState('back', false)
    h.setControlState('left', false)
    h.setControlState('right', false)
    if (!dir) {
      // Nowhere to run: stop pushing into the wall and take it on the shield.
      h.setControlState('forward', false)
      h.setControlState('sprint', false)
      h.setControlState('jump', false)
      this._shield(true)
      return false
    }
    try { Promise.resolve(this.bot.look(Math.atan2(-dir.x, -dir.z), 0, true)).catch(() => {}) } catch { /* mock */ }
    h.setControlState('forward', true)
    h.setControlState('sprint', true)
    h.setControlState('jump', Boolean(this.bot.entity.onGround))
    return true
  }

  /**
   * The nearest impact on its way: from the target (its motion was just
   * measured) or from any other player being watched.
   */
  _incoming (targetMotion) {
    const me = this.bot.entity
    let best = null
    const consider = (entity, motion) => {
      if (!entity?.position || !isPlayer(entity)) return
      const f = forecastImpact(entity, me, motion, { gliding: isGliding(entity), usingItem: isUsingItem(entity) })
      if (f && (!best || f.inSec < best.inSec)) best = { ...f, entity }
    }
    consider(this.target, targetMotion)
    let others = []
    try { others = this.watch() || [] } catch { others = [] }
    for (const e of others) {
      if (!e || e === this.target || e === me) continue
      consider(e, this.motion.update(e))
    }
    return best
  }

  /** Get out of the way of a forecast impact. Returns true when it took over this tick. */
  _evade (f, now) {
    if (now - this._panicAt < 500) return this.state === 'retreat'
    const me = this.bot.entity.position
    let dir = null
    if (f.kind === 'smash') {
      // Out of the landing circle, directly away from where it comes down.
      const dx = me.x - f.at.x
      const dz = me.z - f.at.z
      const len = Math.hypot(dx, dz)
      const away = len > 0.05 ? { x: dx / len, z: dz / len } : this._awayFrom(f.entity.position)
      // 3.5 blocks at a sprint take about 0.6 s. With less time than it takes
      // to clear the circle, the shield is the better answer.
      if (f.inSec >= 0.3 || !this.hasShield()) dir = runnableHeading(this.bot, away, { blocks: 3, maxTurn: 1.6 })
    } else {
      // Step off the line, to the side the bot is already on, if there is ground there.
      const line = f.line || this._awayFrom(f.entity.position)
      const side = { x: -line.z, z: line.x }
      const rel = { x: me.x - f.entity.position.x, z: me.z - f.entity.position.z }
      const sign = side.x * rel.x + side.z * rel.z >= 0 ? 1 : -1
      for (const k of [sign, -sign]) {
        const cand = { x: side.x * k, z: side.z * k }
        if (clearToRun(this.bot, cand, { blocks: 3 })) { dir = cand; break }
      }
    }
    this._panicAt = now
    this.state = 'retreat'
    this.evadeReason = f.kind
    this.evadeUntil = now + Math.round((f.inSec + 0.35) * 1000)
    this._evadeDir = dir
    this.critArmed = false
    this.activeGoal = null
    this.hands.setGoal(null)
    if (dir) this._shield(false)
    this._runAlong(dir)
    const who = f.entity.username || f.entity.name || 'attacker'
    this.onEvent({ type: 'combat', msg: `${dir ? 'dodged' : 'braced for'} ${who}'s ${f.kind === 'smash' ? 'mace smash' : 'charge'}` })
    return true
  }

  /** Break away from the target for a moment (public hook; kept for scripts). */
  _panicRetreat (reason, now) {
    if (now - this._panicAt < 900) return
    this._panicAt = now
    this.state = 'retreat'
    this.evadeReason = reason
    this.evadeUntil = now + 1400
    this._evadeDir = null
    this.critArmed = false
    this.activeGoal = null
    this._shield(false)
    this.hands.setGoal(null)
    this._runFrom(this.target?.position)
    this.onEvent({ type: 'combat', msg: `broke away (${reason})` })
    logger.warn(TAG, `panic retreat — ${reason}`)
  }

  /** Sidestep the target's line (public hook; kept for scripts). */
  _lateralEvade (reason, now) {
    if (now - this._panicAt < 650) return
    this._panicAt = now
    this.evadeReason = reason
    this.evadeUntil = now + 900
    this.strafeSign = Math.random() < 0.5 ? 1 : -1
    this.strafeFlipAt = now + 320
    this.critArmed = false
    this.activeGoal = null
    this.hands.setGoal(null)
    this._applyStance({ forward: true, back: false, sprint: true, strafe: true })
    this._jumpPulse()
    this.onEvent({ type: 'combat', msg: `sidestepped (${reason})` })
  }

  // ---- ranged -------------------------------------------------------------

  _rangedTick ({ profile, threat, dist3, now }) {
    this.critArmed = false
    const rangedProfile = profile.kind === 'ranged' ? profile : WEAPON_PROFILES.bow

    // Keep the enemy archer's line of fire broken: strafe perpendicular to
    // the shooter's aim vector (their position → ours).
    this._perpendicularStrafe(now)

    if (dist3 < rangedProfile.min) {
      // Too close for a bow: back off while keeping the crosshair on target.
      this.state = 'approach'
      this._applyStance({ forward: false, back: true, strafe: true })
      this.activeGoal = null
      this.hands.setGoal(null)
      return
    }
    if (dist3 > rangedProfile.max) {
      this._ensureFollowGoal()
      return
    }

    // In the firing band: hold still-ish and only loose a FULLY charged shot.
    if (this.state !== 'melee') {
      this.state = 'melee'
      this.activeGoal = null
      this.hands.setGoal(null)
    }
    this._applyStance({ forward: false, back: false, strafe: true })
    if (profile.kind !== 'ranged') return // no bow in hand — nothing to fire
    if (!this._hasAmmo()) {
      // An empty quiver would just stand there drawing nothing.
      this._end('out of arrows', 'lost')
      return
    }
    const chargeMs = (profile.chargeMs || 1000) * this.bowChargeThreshold
    if (!this.bow.charging) {
      if (!this.cooldown.ready(this.critThreshold)) return
      this._drawBow(now)
      return
    }
    const charged = now - this.bow.startedAt >= chargeMs
    if (charged) {
      this._releaseBow()
      this.bow.shots++
      this.cooldown.arm(profile)
      this.onEvent({ type: 'combat', msg: `arrow loosed (${Math.round(dist3)}m)` })
    }
  }

  _hasAmmo () {
    try {
      const items = this.bot.inventory.items()
      if (!items.length) return true // partial mock: assume the caller knows
      return items.some((i) => /(^|_)arrow$/.test(i.name)) || /arrow/.test(this._offHandItem()?.name || '')
    } catch { return true }
  }

  _drawBow (now) {
    try {
      this.bot.activateItem()
      this.bow.charging = true
      this.bow.startedAt = now
    } catch { /* no bow */ }
  }

  _releaseBow () {
    if (!this.bow.charging) return false
    try { this.bot.deactivateItem() } catch { /* gone */ }
    this.bow.charging = false
    this.bow.startedAt = 0
    return true
  }

  /**
   * Choose the lateral direction that minimises threat and hold it briefly.
   * Falls back to aim-perpendicular strafing when no threat map is injected.
   */
  _perpendicularStrafe (now) {
    const pos = this.bot.entity?.position
    if (!pos) return
    let leftThreat = 0
    let rightThreat = 0
    if (this.threatMap?.threatScoreAt) {
      const yaw = this.bot.entity.yaw || 0
      // mineflayer yaw 0 faces north (-z): forward = (-sin yaw, -cos yaw), so
      // the right-hand vector is (cos yaw, -sin yaw). (The old +sin swapped
      // left and right whenever the bot faced east or west.)
      const rx = Math.cos(yaw)
      const rz = -Math.sin(yaw)
      leftThreat = this.threatMap.threatScoreAt({ x: pos.x - rx * 2, y: pos.y, z: pos.z - rz * 2 })
      rightThreat = this.threatMap.threatScoreAt({ x: pos.x + rx * 2, y: pos.y, z: pos.z + rz * 2 })
    } else if (this.target?.position) {
      // Perpendicular to the shooter's aim vector, pick the side we already orbit.
      leftThreat = this.strafeSign < 0 ? 0 : 1
      rightThreat = this.strafeSign > 0 ? 0 : 1
    }
    if (now >= this.strafeFlipAt) {
      this.strafeSign = leftThreat <= rightThreat ? -1 : 1
      this.strafeFlipAt = now + 450 + Math.floor(Math.random() * 300)
    }
  }
}

module.exports = {
  AdvancedCombat,
  AttackCooldown,
  MotionTracker,
  HOSTILE_NAMES,
  WEAPON_PROFILES,
  CRIT_THRESHOLD,
  weaponProfile,
  cooldownProgress,
  heldItemName,
  hasElytra,
  classifyThreat,
  closestApproach,
  forecastImpact
}
