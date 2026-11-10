/**
 * AdvancedCombat — deterministic, tick-driven combat. The LLM only decides
 * WHO to fight ({"a":"attack","n":"zombie"}); everything from sprinting to
 * critical-hit timing is handled here in code, costing zero tokens.
 *
 * Behaviour:
 *   - TARGETING: nearest entity matching the requested name (or any hostile
 *     for n:"any") within ENGAGE_RADIUS blocks.
 *   - APPROACH (dist > 3.2): mineflayer-pathfinder GoalFollow (dynamic),
 *     sprint enabled in movements. The bot pathfinds around obstacles — it
 *     does not faceplant into walls.
 *   - MELEE (dist <= 3.2): pathfinder disengaged, manual control:
 *       · continuous smooth look-at (force=false, every tick)
 *       · sprint + slight forward press toward the target
 *       · sinusoid-like STRAFE: left/right flip every ~1.2-2.3s (anti-predictive)
 *       · CRITICAL HITS: jump tap, then attack on the tick the bot is falling
 *         (velocity.y < 0) — real crit mechanics, not random jumping
 *       · attack cadence limited to ATTACK_COOLDOWN_MS (default 600ms)
 *   - DISENGAGE: below 30% max health → clear goal & controls, pathfind
 *     directly AWAY from the threat for ~14 blocks, then a 10s cooldown
 *     during which re-engagement is refused. Not a panic-blink: the route is
 *     still computed by the pathfinder, so the bot won't swan-dive into a
 *     cave or off a ledge just to escape.
 *   - The bot never attacks while dead/respawning, and never fights passive
 *     animals unless explicitly named by the LLM (no pig Holocausts).
 *
 * Events are pushed via the injected onEvent({type:'combat', msg}) callback
 * so the Delta-State Builder can fold combat outcomes into the LLM context
 * (e.g. "disengaged low_hp", "target down").
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
  'hoglin', 'zoglin', 'guardian', 'elder_guardian', 'warden'
])

const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

class AdvancedCombat {
  /**
   * @param {object} bot mineflayer bot (pathfinder plugin loaded)
   * @param {object} opts
   *   maxHealth, disengageHealthFraction, attackCooldownMs, disengageCooldownMs,
   *   engageRadius, onEvent(fn) — delta sink, now() injectable for tests
   */
  constructor (bot, {
    maxHealth = 20,
    disengageHealthFraction = 0.3,
    attackCooldownMs = 600,
    disengageCooldownMs = 10_000,
    engageRadius = 24,
    onEvent = () => {},
    now = () => Date.now()
  } = {}) {
    this.bot = bot
    this.maxHealth = maxHealth
    this.disengageAt = Math.max(1, Math.floor(maxHealth * disengageHealthFraction))
    this.attackCooldownMs = attackCooldownMs
    this.disengageCooldownMs = disengageCooldownMs
    this.engageRadius = engageRadius
    this.onEvent = onEvent
    this.now = now

    this.state = 'idle' // idle | approach | melee | retreat | cooldown
    this.target = null
    this.wantedName = null
    this.strafeSign = 1
    this.strafeFlipAt = 0
    this.attackReadyAt = 0
    this.critArmed = false
    this.critDeadline = 0
    this.cooldownUntil = 0
    /** Goal object exposed to the anti-stuck watchdog for path recalculation. */
    this.activeGoal = null

    this._tick = this._tick.bind(this)
    this._housekeeping = this._housekeeping.bind(this)
    this._onEntityGone = this._onEntityGone.bind(this)
  }

  start () {
    this.bot.on('physicsTick', this._tick)
    this.bot.on('entityGone', this._onEntityGone)
    this._housekeepingTimer = setInterval(this._housekeeping, 250)
  }

  stop () {
    this.bot.removeListener('physicsTick', this._tick)
    this.bot.removeListener('entityGone', this._onEntityGone)
    clearInterval(this._housekeepingTimer)
    this._clearControls()
    this.state = 'idle'
    this.target = null
    this.activeGoal = null
  }

  get isEngaged () {
    return this.state === 'approach' || this.state === 'melee' || this.state === 'retreat'
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
    await this._equipBestWeapon()
    this._ensureFollowGoal()
    this.onEvent({ type: 'combat', msg: `engaged ${String(target.name).toLowerCase()}` })
    logger.info(TAG, `engaging ${target.name} (id ${target.id})`)
    return { ok: true, target: String(target.name).toLowerCase() }
  }

  /** Force-disengage (also used internally at low health). */
  disengage (reason = 'manual') {
    this.bot.pathfinder?.setGoal?.(null)
    this._clearControls()
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

  _awayGoal () {
    const botPos = this.bot.entity?.position
    if (!botPos) return null
    const danger = this.target?.position
    let dx = 1; let dz = 1
    if (danger) {
      dx = botPos.x - danger.x
      dz = botPos.z - danger.z
      const len = Math.hypot(dx, dz)
      if (len > 0.01) { dx /= len; dz /= len } else { dx = 1; dz = 0 }
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
      const goal = new GoalFollow(this.target, 2)
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
      this._clearControls()
      try { this.bot.pathfinder?.setGoal?.(null) } catch { /* noop */ }
    }
  }

  /** Housekeeping at 4 Hz: health gate, cooldown expiry, target sanity. */
  _housekeeping () {
    if (this.bot.health === undefined) return
    if (this.state === 'cooldown' && this.now() >= this.cooldownUntil) {
      this.state = 'idle'
      this.activeGoal = null
    }
    if (this.state === 'approach' || this.state === 'melee') {
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

  /** Physics-tick pursuit + melee mechanics (20 Hz). */
  _tick () {
    if (this.state !== 'approach' && this.state !== 'melee') return
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
    // Aim at upper-body height.
    try {
      const height = Number(this.target.height) || 1.8
      this.bot.lookAt(tPos.offset(0, height * 0.6, 0), false).catch(() => {})
    } catch { /* look failed; non-fatal */ }

    if (horiz > 3.2) {
      if (this.state !== 'approach') {
        this.state = 'approach'
        this._clearControls()
      }
      this._ensureFollowGoal() // re-arm dynamic follow if pathfinder lost it
      return
    }

    // ---- MELEE -------------------------------------------------------------
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

    this.bot.setControlState('forward', true)
    this.bot.setControlState('sprint', true)
    this.bot.setControlState('left', this.strafeSign < 0)
    this.bot.setControlState('right', this.strafeSign > 0)

    // Critical-hit sequencing: tap jump, then swing on the falling tick.
    if (this.critArmed) {
      const falling = !this.bot.entity.onGround && this.bot.entity.velocity.y < 0
      if (falling || now > this.critDeadline) {
        try { this.bot.setControlState('jump', false) } catch { /* noop */ }
        if (dist3 <= 4.5) this.bot.attack(this.target)
        this.critArmed = false
        this.attackReadyAt = now + this.attackCooldownMs
      }
      return
    }

    if (now >= this.attackReadyAt && this.bot.entity.onGround && dist3 <= 3.2) {
      this.bot.setControlState('jump', true)
      // Release jump shortly after leaving the ground; vanilla crit = falling.
      setTimeout(() => { try { this.bot.setControlState('jump', false) } catch { /* gone */ } }, 60)
      this.critArmed = true
      this.critDeadline = now + 800
    }
  }
}

module.exports = { AdvancedCombat, HOSTILE_NAMES }
