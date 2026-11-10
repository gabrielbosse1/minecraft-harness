/**
 * AdvancedCombat — deterministic, tick-driven combat. The LLM only decides
 * WHO to fight ({"a":"attack","n":"zombie"}); everything from sprinting to
 * critical-hit timing is handled here in code, costing zero tokens.
 *
 * v3 "elite" behaviour (vanilla 1.9+ mechanics, no commands, no cheats):
 *
 *   TARGETING   nearest entity matching the requested name (or any hostile for
 *               n:"any") within ENGAGE_RADIUS blocks. Passive animals are never
 *               attacked unless explicitly named.
 *
 *   GOLDILOCKS  the engagement band is derived from the held item:
 *                 sword / axe / trident / spear : 2.5 – 3.2 m
 *                 mace                          : 4.0 – 6.0 m (jump setup)
 *                 bow                           : 10 – 24 m
 *                 crossbow                      : 10 – 20 m
 *                 fists                         : 1.8 – 2.6 m
 *               Inside the band the bot strafes (A/D) instead of walking;
 *               too far → approach through the pathfinder; too close →
 *               backpedal. Never a static punching bag.
 *
 *   COOLDOWN    every weapon has a vanilla attack speed. A swing is only
 *               issued when the cooldown indicator is >= 85 % (CRIT_THRESHOLD).
 *               No click spam: strafing and tracking continue while waiting.
 *
 *   CRITS       melee swings are preceded by a micro-jump; the attack lands on
 *               the falling tick (velocity.y < 0) for a vanilla critical hit,
 *               then the bot backpedals to reset threat distance.
 *
 *   EVASION     weapon-aware, zero LLM latency:
 *                 · enemy mace + airborne/close  → panic retreat: sprint back,
 *                   break line of sight with a placed block, or water bucket.
 *                 · elytra + spear/trident lunge → instant lateral strafe.
 *                 · bow/crossbow                  → keep >10 m, strafe
 *                   perpendicular to the shooter's aim vector, and only fire
 *                   when our own bow is 100 % charged.
 *
 *   DISENGAGE   below 30 % max health → pathfind ~14 blocks away (threat-aware
 *               when a PredictiveThreatMap is injected), then a 10 s cooldown.
 *
 * Events are pushed via the injected onEvent({type:'combat', msg}) callback
 * so the Delta-State Builder can fold combat outcomes into the LLM context.
 */
'use strict'

const { GoalNear, GoalFollow } = require('mineflayer-pathfinder').goals
const logger = require('./logger')

const TAG = 'combat'

const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager',
  'skeleton', 'stray', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'enderman', 'witch',
  'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'piglin_brute',
  'phantom', 'silverfish', 'slime', 'magma_cube', 'blaze', 'ghast',
  'hoglin', 'zoglin', 'guardian', 'elder_guardian', 'warden',
  'breeze', 'bogged', 'creaking'
])

const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const CRIT_THRESHOLD = 0.85

// ---------------------------------------------------------------------------
// Weapon table. `aps` is vanilla attacks/second; the cooldown indicator fills
// in 20/aps ticks. Bands are metres (3D distance).
// ---------------------------------------------------------------------------
const WEAPON_PROFILES = {
  sword: { key: 'sword', label: 'sword', kind: 'melee', min: 2.5, max: 3.2, aps: 1.6, reach: 3.2, crit: true },
  axe: { key: 'axe', label: 'axe', kind: 'melee', min: 2.5, max: 3.2, aps: 1.0, reach: 3.0, crit: true },
  mace: { key: 'mace', label: 'mace', kind: 'melee', min: 4.0, max: 6.0, aps: 0.6, reach: 4.5, crit: true, needsAir: true },
  trident: { key: 'trident', label: 'trident', kind: 'melee', min: 2.5, max: 3.6, aps: 1.1, reach: 3.6, crit: true },
  spear: { key: 'spear', label: 'spear', kind: 'melee', min: 2.8, max: 3.8, aps: 1.1, reach: 3.8, crit: true },
  bow: { key: 'bow', label: 'bow', kind: 'ranged', min: 10, max: 24, aps: 1.0, reach: 24, chargeMs: 1000 },
  crossbow: { key: 'crossbow', label: 'crossbow', kind: 'ranged', min: 10, max: 20, aps: 0.8, reach: 20, chargeMs: 1250 },
  fists: { key: 'fists', label: 'fists', kind: 'melee', min: 1.8, max: 2.6, aps: 4.0, reach: 2.8, crit: true }
}

/** Weapon profile for an item id (null/unknown → fists). Never throws. */
function weaponProfile (itemName) {
  const n = String(itemName || '').toLowerCase()
  if (/_sword$/.test(n)) return WEAPON_PROFILES.sword
  if (/_axe$/.test(n)) return WEAPON_PROFILES.axe
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
    if (profile && profile.key !== this.profile.key) this.profile = profile
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
 * Classify a threat from its equipment/pose. This is the pure heart of the
 * evasion reflexes and is unit-tested without a bot.
 *
 * @param {object} entity
 * @param {{botPos?:{x,y,z}, distance?:number, now?:number}} [opts]
 * @returns {{name:string, heldItem:string, distance:number, airborne:boolean,
 *   elytra:boolean, tags:string[], explosive:boolean}}
 */
function classifyThreat (entity, { botPos = null, distance = null } = {}) {
  const tags = []
  const heldItem = heldItemName(entity)
  const pos = entity?.position
  const dist = Number.isFinite(distance)
    ? distance
    : (pos && botPos ? Math.hypot(pos.x - botPos.x, pos.y - botPos.y, pos.z - botPos.z) : Infinity)
  const vy = Number(entity?.velocity?.y) || 0
  const airborne = entity?.onGround === false || vy > 0.08
  const elytra = hasElytra(entity)
  const explosive = /creeper/i.test(String(entity?.name || ''))
  const mace = /mace/.test(heldItem)
  const ranged = /bow|crossbow/.test(heldItem)
  const thrust = /trident|spear/.test(heldItem)

  if (mace && (airborne || vy > 0.05 || dist <= 5)) tags.push('mace_airborne')
  if (elytra) tags.push('elytra')
  if (thrust && (elytra || airborne)) tags.push('elytra_charge')
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

class AdvancedCombat {
  /**
   * @param {object} bot mineflayer bot (pathfinder plugin loaded)
   * @param {object} opts
   *   maxHealth, disengageHealthFraction, attackCooldownMs, disengageCooldownMs,
   *   engageRadius, onEvent(fn) — delta sink, now() injectable for tests,
   *   threatMap — PredictiveThreatMap for escape routing,
   *   critThreshold, recoveryMs, bowChargeThreshold
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
    bowChargeThreshold = 1.0
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
    this.critThreshold = critThreshold
    this.recoveryMs = recoveryMs
    this.bowChargeThreshold = bowChargeThreshold

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
    this._shieldAt = 0
    /** Goal object exposed to the anti-stuck watchdog for path recalculation. */
    this.activeGoal = null

    this._tick = this._tick.bind(this)
    this._housekeeping = this._housekeeping.bind(this)
    this._onEntityGone = this._onEntityGone.bind(this)
  }

  start () {
    if (this._started) return
    this._started = true
    this.bot.on('physicsTick', this._tick)
    this.bot.on('entityGone', this._onEntityGone)
    this._housekeepingTimer = setInterval(this._housekeeping, 250)
  }

  stop () {
    this.bot.removeListener('physicsTick', this._tick)
    this.bot.removeListener('entityGone', this._onEntityGone)
    clearInterval(this._housekeepingTimer)
    this._started = false
    this._clearControls()
    this.state = 'idle'
    this.target = null
    this.activeGoal = null
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
    if (next.key !== this.profile.key) {
      logger.debug(TAG, `weapon profile → ${next.label} (${next.min}–${next.max}m)`)
      this.profile = next
      this.cooldown.setProfile(next)
      this.critArmed = false
      if (this.bow.charging) this._releaseBow()
    }
    return next
  }

  // ------------------------------------------------------------targeting--

  /** Find best target: name substring match, or nearest hostile for 'any'. */
  findTarget (name) {
    const botPos = this.bot.entity?.position
    if (!botPos) return null
    const wanted = (name || 'any').toLowerCase()
    let best = null
    let bestDist = Infinity
    for (const id of Object.keys(this.bot.entities)) {
      const e = this.bot.entities[id]
      if (!e || !e.position || e === this.bot.entity) continue
      if (e.name === undefined || e.name === null) continue
      const nameL = String(e.name).toLowerCase()
      const hostile = HOSTILE_NAMES.has(nameL)
      if (wanted === 'any') {
        if (!hostile) continue
      } else if (!nameL.includes(wanted)) {
        continue
      }
      const dist = e.position.distanceTo(botPos)
      if (dist <= this.engageRadius && dist < bestDist) {
        best = e
        bestDist = dist
      }
    }
    return best
  }

  /** Entry point for {"a":"attack","n":"zombie"}. Never throws. */
  async engage (name) {
    if (this.bot.health !== undefined && this.bot.health <= 0) {
      return { ok: false, why: 'dead' }
    }
    if (this.now() < this.cooldownUntil) {
      return { ok: false, why: 'disengage_cooldown' }
    }
    const target = this.findTarget(name)
    if (!target) return { ok: false, why: 'no_target' }

    this.wantedName = name || 'any'
    this.target = target
    this.state = 'approach'
    this.strafeFlipAt = this.now() + 1200 + Math.floor(Math.random() * 1100)
    this.critArmed = false
    await this._equipBestWeapon()
    this.refreshProfile()
    this._ensureFollowGoal()
    this.onEvent({ type: 'combat', msg: `engaged ${String(target.name).toLowerCase()}` })
    logger.info(TAG, `engaging ${target.name} (id ${target.id}) with ${this.profile.label} band ${this.profile.min}–${this.profile.max}m`)
    return { ok: true, target: String(target.name).toLowerCase() }
  }

  /** Force-disengage (also used internally at low health). */
  disengage (reason = 'manual') {
    this.bot.pathfinder?.setGoal?.(null)
    this._clearControls()
    this._releaseBow()
    this.state = 'cooldown'
    this.cooldownUntil = this.now() + this.disengageCooldownMs
    const away = this._awayGoal()
    if (away) {
      this.activeGoal = { goal: away, dynamic: false }
      try { this.bot.pathfinder.setGoal(away, false) } catch { /* pathfinder absent */ }
    } else {
      this.activeGoal = null
    }
    const label = reason === 'low_hp' ? 'disengaged low_hp' : `disengaged ${reason}`
    this.target = null
    this.onEvent({ type: 'combat', msg: label })
    logger.warn(TAG, label)
    return { ok: true }
  }

  // ------------------------------------------------------------- internals--

  /** Escape destination: predictive threat vector when available. */
  _awayGoal () {
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
      const danger = this.target?.position
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
        const m = /^(netherite|diamond|iron|stone|golden|wooden)_(sword|axe)$/.exec(item.name)
        if (!m) continue
        const tier = WEAPON_TIERS.indexOf(m[1])
        const kindBonus = m[2] === 'sword' ? 2 : 1
        const score = (WEAPON_TIERS.length - tier) * 10 + kindBonus
        if (score > bestScore) { bestScore = score; best = item }
      }
      if (best) await this.bot.equip(best, 'hand')
    } catch (err) {
      logger.debug(TAG, `weapon equip skipped: ${err.message || err}`)
    }
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
      this.bot.pathfinder.setGoal(goal, true)
    } catch (err) {
      logger.debug(TAG, `follow goal failed: ${err.message || err}`)
    }
  }

  _clearControls () {
    try {
      for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
        this.bot.setControlState(c, false)
      }
    } catch { /* bot gone */ }
  }

  _entityAlive (e) {
    return Boolean(e && this.bot.entities[e.id])
  }

  _onEntityGone (e) {
    if (this.target && e && e.id === this.target.id) {
      logger.info(TAG, 'target down')
      this.onEvent({ type: 'combat', msg: 'target down' })
      this.target = null
      this.state = 'idle'
      this.activeGoal = null
      this.critArmed = false
      this._releaseBow()
      this._clearControls()
      try { this.bot.pathfinder?.setGoal?.(null) } catch { /* noop */ }
    }
  }

  /** Housekeeping at 4 Hz: health gate, cooldown expiry, target sanity. */
  _housekeeping () {
    if (this.bot.health === undefined) return
    const now = this.now()
    if (this.state === 'cooldown' && now >= this.cooldownUntil) {
      this.state = 'idle'
      this.activeGoal = null
    }
    if (this.state === 'retreat' && now >= this.evadeUntil) {
      this.state = this.target ? 'approach' : 'idle'
      this.evadeReason = null
    }
    if (this.state === 'approach' || this.state === 'melee' || this.state === 'retreat') {
      if (this.bot.health <= this.disengageAt) {
        this.disengage('low_hp')
        return
      }
      if (!this._entityAlive(this.target)) {
        this.target = null
        this.state = 'idle'
        this.activeGoal = null
        this._clearControls()
        this.onEvent({ type: 'combat', msg: 'target down' })
      }
    }
  }

  /** Public hook for the System-1 `combat_tick` reflex (no LLM latency). */
  forceTick () {
    try { this._tick() } catch (err) { logger.debug(TAG, `forceTick: ${err.message || err}`) }
  }

  /** Public hook for the System-1 `panic_retreat` reflex. */
  panicRetreat (reason = 'mace') {
    this._panicRetreat(reason, this.now())
    return reason
  }

  /** Public hook for the System-1 `evade_lateral` reflex. */
  evadeLateral (reason = 'elytra') {
    this._lateralEvade(reason, this.now())
    return reason
  }

  /** Public hook for the System-1 `strafe_ranged` reflex. */
  strafeRanged () {
    this._perpendicularStrafe(this.now())
    this._applyStance({ forward: false, back: false, sprint: true, strafe: true })
    return 'strafe'
  }

  /** Physics-tick pursuit + melee mechanics (20 Hz). */
  _tick () {
    if (this.state !== 'approach' && this.state !== 'melee' && this.state !== 'retreat') return
    if (!this.target || !this.bot.entity) return
    const now = this.now()

    const botPos = this.bot.entity.position
    const tPos = this.target.position
    const dx = tPos.x - botPos.x
    const dz = tPos.z - botPos.z
    const dy = tPos.y - botPos.y
    const horiz = Math.hypot(dx, dz)
    const dist3 = Math.sqrt(horiz * horiz + dy * dy)

    // Face the target smoothly — force=false avoids violent snap-turns.
    try {
      const height = Number(this.target.height) || 1.8
      this.bot.lookAt(tPos.offset(0, height * 0.6, 0), false).catch(() => {})
    } catch { /* look failed; non-fatal */ }

    const profile = this.refreshProfile()
    const threat = classifyThreat(this.target, { botPos, distance: dist3 })
    this.lastThreat = threat

    // ---- WEAPON-SPECIFIC EVASION (highest priority) ------------------------
    if (threat.tags.includes('mace_airborne') && dist3 <= 5.5) {
      if (this.evadeReason !== 'mace' || now > this.evadeUntil - 800) this._panicRetreat('mace', now)
      return
    }
    if (threat.tags.includes('elytra_charge') || threat.tags.includes('elytra')) {
      if (threat.elytra && threat.airborne && dist3 <= 8) {
        this._lateralEvade('elytra', now)
        return
      }
    }

    // ---- RETREAT state (mace panic / manual) -------------------------------
    if (this.state === 'retreat') {
      this._retreatControls(now)
      return
    }

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
        try { this.bot.setControlState('jump', false) } catch { /* noop */ }
        this._clearControls()
      }
      this._ensureFollowGoal() // re-arm dynamic follow if pathfinder lost it
      return
    }

    if (this.state !== 'melee') {
      this.state = 'melee'
      this.activeGoal = null
      try { this.bot.pathfinder.setGoal(null) } catch { /* noop */ }
      this._clearControls()
      this.strafeFlipAt = now + 900 + Math.floor(Math.random() * 900)
    }

    // Strafe flip — keeps the bot orbiting, not moonwalking backwards into lava.
    if (now >= this.strafeFlipAt) {
      this.strafeSign = -this.strafeSign
      this.strafeFlipAt = now + 1200 + Math.floor(Math.random() * 1100)
    }

    // Post-swing recovery: backpedal to reset the threat distance.
    if (now < this.recoveryUntil) {
      this._applyStance({ forward: false, back: true, sprint: false, strafe: true })
      return
    }

    // Band-keeping: too close → backpedal, inside → orbit, too far was handled.
    if (horiz < bandMin) {
      this._applyStance({ forward: false, back: true, sprint: false, strafe: true })
    } else {
      this._applyStance({ forward: false, back: false, sprint: true, strafe: true })
    }

    // Weapon reach is shorter than the band for the mace: step in, don't idle.
    if (dist3 > profile.reach + 0.2) {
      this._applyCollisionStance()
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
        try { this.bot.setControlState('jump', false) } catch { /* noop */ }
        if (dist3 <= profile.reach + 0.3) this._swing()
        this.critArmed = false
        this.recoveryUntil = now + this.recoveryMs
      } else if (expired) {
        try { this.bot.setControlState('jump', false) } catch { /* noop */ }
        this.critArmed = false
      }
      return
    }

    // Vanilla cooldown gate: never spam-click. 85%+ only.
    if (!this.cooldown.ready(this.critThreshold)) return
    if (dist3 > profile.reach + 0.2) return

    if (profile.needsAir && !this.bot.entity.onGround) {
      // Mace: already airborne — swing on the falling tick for a smash.
      if (this.bot.entity.velocity.y <= 0) this._swing()
      return
    }

    if (this.bot.entity.onGround) {
      // Micro-jump into the swing → critical hit.
      this._jumpPulse()
      this.critArmed = true
      this.critDeadline = now + 900
    } else if (this.bot.entity.velocity.y < 0) {
      // Already falling (knockback, terrain): take the crit now.
      this._swing()
    }
  }

  /** One confirmed swing; arms the cooldown and starts the backpedal window. */
  _swing () {
    try {
      this.bot.attack(this.target)
      const now = this.now()
      this.cooldown.arm(this.profile)
      this.attackReadyAt = now + this.attackCooldownMs
      this.recoveryUntil = now + this.recoveryMs
      this.onEvent({ type: 'combat', msg: `hit ${this.lastThreat?.name || 'target'} (${this.profile.label})` })
    } catch (err) {
      logger.debug(TAG, `attack failed: ${err.message || err}`)
    }
  }

  /** Close the final metre toward the target while still orbiting it. */
  _applyCollisionStance () {
    this._applyStance({ forward: true, back: false, sprint: false, strafe: true })
  }

  _jumpPulse () {
    try {
      this.bot.setControlState('jump', true)
      setTimeout(() => { try { this.bot.setControlState('jump', false) } catch { /* gone */ } }, 60)
    } catch { /* gone */ }
  }

  /** Press exactly the movement keys a stance needs. */
  _applyStance ({ forward, back, sprint, strafe }) {
    const bot = this.bot
    bot.setControlState('forward', Boolean(forward))
    bot.setControlState('back', Boolean(back))
    bot.setControlState('sprint', Boolean(sprint))
    bot.setControlState('left', Boolean(strafe) && this.strafeSign < 0)
    bot.setControlState('right', Boolean(strafe) && this.strafeSign > 0)
  }

  /**
   * Mace panic: sprint backwards, break LOS with a placed block, or deploy a
   * water bucket to negate smash landing damage. Purely client-side.
   */
  _panicRetreat (reason, now) {
    if (now - this._panicAt < 900) return
    this._panicAt = now
    this.state = 'retreat'
    this.evadeReason = reason
    this.evadeUntil = now + 1400
    this.critArmed = false
    this.activeGoal = null
    try { this.bot.pathfinder?.setGoal?.(null) } catch { /* noop */ }
    this._retreatControls(now)
    const mitigation = this._mitigation()
    if (mitigation) {
      // Mitigation swapped our hand item; recover the weapon once we're clear.
      setTimeout(() => {
        this._equipBestWeapon().then(() => this.refreshProfile()).catch(() => {})
      }, 700)
    }
    this.onEvent({ type: 'combat', msg: `panic retreat (${reason})${mitigation ? ' + ' + mitigation : ''}` })
    logger.warn(TAG, `panic retreat — ${reason}${mitigation ? ` (${mitigation})` : ''}`)
  }

  /** Best available client-side mitigation for an incoming smash. */
  _mitigation () {
    try {
      if (this._deployWaterBucket()) return 'water'
      if (this._placeShieldBlock()) return 'block'
    } catch { /* inventory mock */ }
    return ''
  }

  _deployWaterBucket () {
    const bot = this.bot
    try {
      const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket')
      if (!bucket) return false
      bot.equip(bucket, 'hand').then(() => {
        bot.activateItem()
        setTimeout(() => { try { bot.deactivateItem() } catch { /* gone */ } }, 120)
      }).catch(() => {})
      return true
    } catch { return false }
  }

  _placeShieldBlock () {
    const bot = this.bot
    if (!bot.entity?.position || !bot.blockAt || !bot.placeBlock) return false
    try {
      const block = bot.inventory.items().find((i) => /^(cobblestone|dirt|netherrack|oak_planks|stone)$/.test(i.name))
      if (!block) return false
      const t = this.target?.position
      if (!t) return false
      const pos = bot.entity.position
      const dx = t.x - pos.x
      const dz = t.z - pos.z
      const len = Math.hypot(dx, dz) || 1
      const { Vec3 } = require('vec3')
      const head = pos.floored().offset(Math.round(dx / len), 0, Math.round(dz / len))
      const below = bot.blockAt(head.offset(0, -1, 0))
      if (!below || below.name === 'air') return false
      bot.equip(block, 'hand')
        .then(() => bot.placeBlock(below, new Vec3(0, 1, 0)))
        .catch(() => {})
      return true
    } catch { return false }
  }

  _retreatControls (now) {
    if (now > this.evadeUntil) return
    this._applyStance({ forward: false, back: true, sprint: true, strafe: true })
  }

  /**
   * Elytra / spear or trident lunge: instantly break the linear collision
   * trajectory with a lateral sprint strafe and a jump.
   */
  _lateralEvade (reason, now) {
    if (now - this._panicAt < 650) return
    this._panicAt = now
    this.evadeReason = reason
    this.evadeUntil = now + 900
    this.strafeSign = Math.random() < 0.5 ? 1 : -1
    this.strafeFlipAt = now + 320
    this.critArmed = false
    this.activeGoal = null
    try { this.bot.pathfinder?.setGoal?.(null) } catch { /* noop */ }
    this._applyStance({ forward: true, back: false, sprint: true, strafe: true })
    this._jumpPulse()
    this.onEvent({ type: 'combat', msg: `lateral evade (${reason})` })
  }

  // ---- ranged -------------------------------------------------------------

  _rangedTick ({ profile, threat, dist3, now }) {
    const bot = this.bot
    this.critArmed = false
    const rangedProfile = profile.kind === 'ranged' ? profile : WEAPON_PROFILES.bow

    // Keep the enemy archer's line of fire broken: strafe perpendicular to
    // the shooter's aim vector (their position → ours).
    this._perpendicularStrafe(now)

    if (dist3 < rangedProfile.min) {
      // Too close for a bow: back off while keeping the crosshair on target.
      this.state = 'approach'
      this._applyStance({ forward: false, back: true, sprint: true, strafe: true })
      this.activeGoal = null
      try { bot.pathfinder?.setGoal?.(null) } catch { /* noop */ }
      return
    }
    if (dist3 > rangedProfile.max) {
      this._applyStance({ forward: true, back: false, sprint: true, strafe: true })
      this._ensureFollowGoal()
      return
    }

    // In the firing band: hold still-ish and only loose a FULLY charged shot.
    this.state = 'melee'
    this._applyStance({ forward: false, back: false, sprint: false, strafe: true })
    if (profile.kind !== 'ranged') return // no bow in hand — nothing to fire
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
      // Right of look direction = (cos yaw, sin yaw) in XZ; left is mirrored.
      const rx = Math.cos(yaw)
      const rz = Math.sin(yaw)
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
  HOSTILE_NAMES,
  WEAPON_PROFILES,
  CRIT_THRESHOLD,
  weaponProfile,
  cooldownProgress,
  heldItemName,
  hasElytra,
  classifyThreat
}
