/**
 * AntiStuckWatchdog — detects the classic "pathfinder insists we're moving,
 * physics disagrees" wedge and recovers from it autonomously.
 *
 * Detection (every SAMPLE_INTERVAL_MS):
 *   - Only while a path is supposedly active (provider returns true:
 *     pathfinder.isMoving(), an active move goal, or a combat approach).
 *   - Keeps a 3-second rolling window of position samples.
 *   - If the total displacement across the window is < 0.5 blocks → STUCK.
 *
 * Recovery routine (deterministic, in order):
 *   1. Clear the current path (bot.pathfinder.setGoal(null)).
 *   2. Jump pulse twice to pop off ledges / up out of 1-block dips.
 *   3. Rotate yaw 180° (bot.look(yaw + π)).
 *   4. Short forward hop in the new facing direction.
 *   5. RECALCULATE: ask the registered goalProvider for the current desired
 *      goal (combat follow / last move target) and re-set it.
 *
 * A 4s cooldown between recoveries prevents death-spiral spam. Emits
 * {type:'unstuck'} deltas so the LLM gets one nudge of context if it cares.
 */
'use strict'

const logger = require('./logger')

const TAG = 'watchdog'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class AntiStuckWatchdog {
  /**
   * @param {object} bot mineflayer bot
   * @param {object} opts sampleIntervalMs (500), windowMs (3000),
   *   minDisplacement (0.5), cooldownMs (4000),
   *   goalActiveProvider () => bool   — is some goal currently commanded?
   *   goalProvider () => {goal, dynamic} | null — recalculation source
   *   onUnstuck (err?) — delta sink hook
   */
  constructor (bot, {
    sampleIntervalMs = 500,
    windowMs = 3_000,
    minDisplacement = 0.5,
    cooldownMs = 4_000,
    goalActiveProvider = () => false,
    goalProvider = () => null,
    onUnstuck = () => {},
    now = () => Date.now()
  } = {}) {
    this.bot = bot
    this.sampleIntervalMs = sampleIntervalMs
    this.windowMs = windowMs
    this.minDisplacement = minDisplacement
    this.cooldownMs = cooldownMs
    this.goalActiveProvider = goalActiveProvider
    this.goalProvider = goalProvider
    this.onUnstuck = onUnstuck
    this.now = now

    /** @type {{t:number, x:number, y:number, z:number}[]} */
    this.samples = []
    // Prime the cooldown so the FIRST stuck detection after boot isn't blocked.
    this.lastUnstuckAt = -this.cooldownMs
    this.unstuckCount = 0
    this._timer = null
    this._recovering = false
  }

  start () {
    if (this._timer) return
    this._timer = setInterval(() => { this._sample().catch(() => {}) }, this.sampleIntervalMs)
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
  }

  async _sample () {
    const e = this.bot.entity
    if (!e || this._recovering) return
    const now = this.now()

    if (!this.goalActiveProvider()) {
      // Not trying to go anywhere — drop stale evidence.
      this.samples = []
      return
    }

    this.samples.push({ t: now, x: e.position.x, y: e.position.y, z: e.position.z })
    while (this.samples.length && now - this.samples[0].t > this.windowMs) {
      this.samples.shift()
    }
    // Need a full window of evidence before accusing the bot of being stuck.
    if (this.samples.length < Math.floor(this.windowMs / this.sampleIntervalMs)) return

    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const displacement = Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)
    if (displacement >= this.minDisplacement) return

    // ---- STUCK --------------------------------------------------------------
    if (now - this.lastUnstuckAt < this.cooldownMs) return
    await this._recover()
  }

  async _recover () {
    this._recovering = true
    this.lastUnstuckAt = this.now()
    this.samples = []
    try {
      const bot = this.bot
      logger.warn(TAG, 'stuck detected — running unstuck routine')

      // 1. Clear the current path.
      try { bot.pathfinder?.setGoal?.(null) } catch { /* pathfinder absent */ }
      bot.clearControlStates?.()

      // 2. Jump pulses (2x) — pops off ledges and out of 1-block dips.
      for (let i = 0; i < 2; i += 1) {
        bot.setControlState('jump', true)
        await sleep(120)
        bot.setControlState('jump', false)
        await sleep(80)
      }

      // 3. Rotate 180°.
      try {
        const yaw = (bot.entity?.yaw ?? 0) + Math.PI
        await bot.look(yaw, 0, true)
      } catch { /* look is best-effort */ }

      // 4. Short forward hop in the new facing.
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(350)
      bot.setControlState('jump', false)
      await sleep(120)
      bot.setControlState('forward', false)

      // 5. Recalculate: re-apply whatever goal we were working on.
      const recalc = this.goalProvider()
      if (recalc && recalc.goal && bot.pathfinder) {
        try {
          bot.pathfinder.setGoal(recalc.goal, Boolean(recalc.dynamic))
        } catch (err) {
          logger.debug(TAG, `goal re-set failed: ${err.message || err}`)
        }
      }

      this.unstuckCount += 1
      this.onUnstuck({ ok: true })
      logger.info(TAG, `unstuck routine complete (#${this.unstuckCount})`)
    } finally {
      this._recovering = false
    }
  }
}

module.exports = { AntiStuckWatchdog }
