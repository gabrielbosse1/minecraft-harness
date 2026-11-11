/**
 * ElytraController — automatic glide deployment + firework boost.
 *
 * Auto behaviour (no LLM involved, fires from physicsTick):
 *   1. Tracks accumulated fall distance while airborne and descending.
 *   2. When fall distance exceeds ELYTRA_MIN_FALL (default 4 blocks) AND the
 *      bot carries an elytra AND at least one firework rocket → equip elytra,
 *      deploy (bot.elytraFly()), equip a rocket and use it.
 *   3. CHASE MODE: if combat reports a live target further than
 *      ELYTRA_GAP_BLOCKS (default 24) horizontally and we have elytra + a
 *      rocket, deploy once per cooldown to cross the gap.
 *   4. 15s auto-deploy cooldown + only while NOT already gliding, not in
 *      water, alive. After landing, fall tracking resets.
 *
 * Manual behaviour: {"a":"elytra"} → agent calls deploy('manual'). Works with
 * an elytra alone (no rocket) and even from the ground via a hop-jump
 * deployment; returns a compact {ok, why?} result.
 *
 * API notes (mineflayer ≥ 4):
 *   - bot.elytraFly() → resolves when flight starts, rejects otherwise.
 *   - bot.entity.elytraFlying → true while gliding (from metadata flags).
 *   - bot.fireworkRocketDuration → ticks of boost remaining.
 *   - bot.activateItem() uses the held item — for rockets this fires one and
 *     triggers the usedFirework event.
 */
'use strict'

const logger = require('./logger')

const TAG = 'elytra'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class ElytraController {
  /**
   * @param {object} bot mineflayer bot
   * @param {object} opts minFallBlocks, gapBlocks, autoCooldownMs,
   *   combatProvider (() => targetEntity|null), onEvent (delta sink)
   */
  constructor (bot, {
    minFallBlocks = 4,
    gapBlocks = 24,
    autoCooldownMs = 15_000,
    combatProvider = () => null,
    onEvent = () => {},
    now = () => Date.now()
  } = {}) {
    this.bot = bot
    this.minFallBlocks = minFallBlocks
    this.gapBlocks = gapBlocks
    this.autoCooldownMs = autoCooldownMs
    this.combatProvider = combatProvider
    this.onEvent = onEvent
    this.now = now

    this._lastY = null
    this._fallDistance = 0
    this._lastAutoAt = 0
    this._deployLock = false

    this._tick = this._tick.bind(this)
  }

  start () {
    this.bot.on('physicsTick', this._tick)
  }

  stop () {
    this.bot.removeListener('physicsTick', this._tick)
  }

  // ------------------------------------------------------------- helpers--

  /** Elytra as an inventory item (chest-equipped elytras are not listed). */
  findElytra () {
    return this.bot.inventory.items().find((i) => i.name === 'elytra') || null
  }

  /** Any firework rocket variant across versions (firework_rocket / fireworks_rocket / bamboo_rocket). */
  findFirework () {
    return this.bot.inventory.items().find((i) => /firework.*rocket/i.test(i.name) || /^fireworks?_rocket/i.test(i.name)) || null
  }

  get isGliding () {
    return Boolean(this.bot.entity?.elytraFlying)
  }

  /** Is an elytra in the chest slot right now? */
  _wearingElytra () {
    try {
      const slot = this.bot.getEquipmentDestSlot?.('torso')
      const worn = this.bot.inventory?.slots?.[Number.isFinite(slot) ? slot : 6]
      return worn?.name === 'elytra'
    } catch { return false }
  }

  async _equipElytraIfCarried () {
    const elytra = this.findElytra()
    if (!elytra) return false
    try {
      await this.bot.equip(elytra, 'torso')
      return true
    } catch (err) {
      logger.debug(TAG, `elytra equip failed: ${err.message || err}`)
      return false
    }
  }

  async _useFireworkRocket () {
    const rocket = this.findFirework()
    if (!rocket) return false
    if (this.bot.fireworkRocketDuration > 0) return true // already boosted
    try {
      await this.bot.equip(rocket, 'hand')
      // One activation = one rocket. mineflayer emits "usedFirework" and
      // updates bot.fireworkRocketDuration for us.
      this.bot.activateItem()
      return true
    } catch (err) {
      logger.debug(TAG, `firework use failed: ${err.message || err}`)
      return false
    }
  }

  /**
   * Deploy the elytra (and a rocket if available). Safe to call from the
   * ground: does a hop-jump first. Never throws.
   * @param {string} reason 'manual' | 'fall' | 'chase'
   */
  async deploy (reason = 'manual') {
    if (this._deployLock) return { ok: false, why: 'deploy_in_progress' }
    this._deployLock = true
    try {
      // Alive?
      if (this.bot.health !== undefined && this.bot.health <= 0) return { ok: false, why: 'dead' }
      // In water an elytra won't help.
      if (this.bot.entity?.isInWater) return { ok: false, why: 'in_water' }
      // Wear it if we carry one; otherwise hope it's already equipped (chest slot).
      const carried = await this._equipElytraIfCarried()
      // (The old check `!carried && !(!carried)` could never be true, so the
      // bot hop-jumped with no elytra at all.)
      if (!carried && !this._wearingElytra()) return { ok: false, why: 'no_elytra' }

      // Need downward velocity before elytraFly() will deploy.
      if (this.bot.entity.onGround) {
        this.bot.setControlState('forward', true)
        this.bot.setControlState('jump', true)
        await sleep(420)
        this.bot.setControlState('jump', false)
        // give it a beat to leave the ground
        await sleep(120)
      }
      const deadline = this.now() + 2500
      while (this.bot.entity.velocity.y > -0.08 && this.now() < deadline) {
        await sleep(50)
      }
      if (this.bot.entity.velocity.y > -0.08) {
        this.bot.clearControlStates?.()
        return { ok: false, why: 'not_falling' }
      }

      try {
        await this.bot.elytraFly()
      } catch (err) {
        this.bot.clearControlStates?.()
        return { ok: false, why: `fly_failed:${String(err && err.message || err).slice(0, 40)}` }
      }

      const boosted = await this._useFireworkRocket()
      this.bot.setControlState('forward', true) // keep airspeed after boost
      this.onEvent({ type: 'elytra', ok: true })
      logger.info(TAG, `deployed (${reason})${boosted ? ' + rocket' : ''}`)
      return { ok: true, boosted }
    } finally {
      this._deployLock = false
      this._fallDistance = 0
    }
  }

  // -------------------------------------------------------------- auto--

  _tick () {
    const e = this.bot.entity
    if (!e) return
    const y = e.position.y

    if (this._lastY === null) {
      this._lastY = y
      return
    }

    const vy = e.velocity?.y ?? 0
    const grounded = Boolean(e.onGround)
    const gliding = this.isGliding

    // Fall bookkeeping: accumulate while descending; reset on land/glide.
    if (grounded || gliding) {
      this._fallDistance = 0
    } else if (vy < 0) {
      this._fallDistance += Math.max(0, this._lastY - y)
    }
    this._lastY = y

    if (gliding || this._deployLock) return
    if (this.now() - this._lastAutoAt < this.autoCooldownMs) return
    if (this.bot.health !== undefined && this.bot.health <= 0) return

    const carriedElytra = this.findElytra()
    const hasRocket = Boolean(this.findFirework())
    // Auto-deploy is explicitly gated on elytra + at least one firework
    // (directive §4). Without rockets we don't randomly fling ourselves.
    if (!carriedElytra || !hasRocket) return

    // 1) Fall-from-height guard.
    if (this._fallDistance >= this.minFallBlocks) {
      this._triggerAuto('fall')
      return
    }

    // 2) Chasing a combat target across a large gap.
    const target = this.combatProvider()
    if (target?.position && e.position) {
      const gap = Math.hypot(target.position.x - e.position.x, target.position.z - e.position.z)
      if (gap >= this.gapBlocks) {
        this._triggerAuto('chase')
      }
    }
  }

  _triggerAuto (reason) {
    this._lastAutoAt = this.now()
    // Fire-and-forget; deploy() has its own lock + never throws.
    this.deploy(reason).catch((err) => logger.warn(TAG, `auto-deploy failed: ${err.message || err}`))
  }
}

module.exports = { ElytraController }
