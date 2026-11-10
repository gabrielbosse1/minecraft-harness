/**
 * system1.js — the reflex layer. No LLM calls here, ever.
 *
 * System 1 is driven by the ReflexRegistry: built-in reflexes (eat, dodge,
 * fall mitigation) are registered at boot with the exact same `register()`
 * call a user would use, and users push more via config or the LLM
 * (`{"a":"register_reflex"}` is NOT exposed to the LLM on purpose — reflexes
 * are an operator tool, not an autonomous escalation path; LLM escalation
 * happens via `call_system2` inside an operator-registered reflex).
 *
 * System 1 can escalate to System 2 only through reflexes whose action is
 * `call_system2` — the LLM decides, the event text rides along, zero chat
 * spam, zero ambiguity about why tokens were spent.
 */
'use strict'

const FOOD_RE = /(bread|apple|potato|carrot|beef|porkchop|chicken|mutton|salmon|cod|berries|cookie|melon_slice|cooked_|golden_carrot|steak|stew|mushroom_stew|beetroot)/

class System1 {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ registry: import('./reflex_registry').ReflexRegistry,
   *           logger: object,
   *           escalate?: (event: object) => any,
   *           pathfinder?: object,
   *           memory?: object,
   *           combat?: object,
   *           eatBelowFood?: number,
   *           fallVelocityThreshold?: number,
   *           tickMs?: number,
   *           pvpEnabled?: boolean,
   *           pvpRange?: number,
   *           autoElytra?: boolean }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.registry = opts.registry
    this.logger = opts.logger || console
    this.escalate = opts.escalate || null
    this.pathfinder = opts.pathfinder || null
    this.memory = opts.memory || null
    this.combat = opts.combat || null
    this.eatBelowFood = opts.eatBelowFood ?? 18
    this.fallVelocityThreshold = opts.fallVelocityThreshold ?? -0.35
    this.tickMs = opts.tickMs ?? 200
    // Instant PvP: DISABLED by default — this harness runs on a private
    // whitelist with friends. Operators opt in via behavior.pvpEnabled.
    this.pvpEnabled = opts.pvpEnabled === true
    this.pvpRange = Number.isFinite(opts.pvpRange) ? opts.pvpRange : 15
    this.autoElytra = opts.autoElytra !== false
    this._timer = null
    this._lastEat = 0
    this._lastElytra = 0
    this._pvp = null // { target, startedAt, targetName, ending? } while a fight is live
    this._pvpEndedAt = 0
    if (!this.registry) throw new Error('System1 requires a ReflexRegistry')
  }

  /** Register the built-in survival reflexes (same API users get). */
  registerBuiltins () {
    const R = this.registry
    R.register({ name: 'eat_when_hungry', trigger: 'food_low', action: 'eat', cooldownMs: 8000 })
    R.register({ name: 'dodge_close_hostile', trigger: 'hostile_near', action: 'back_jump', cooldownMs: 600 })
    R.register({ name: 'water_bucket_when_falling', trigger: 'falling', action: 'drink_water', cooldownMs: 2000 })
    // Instant PvP — opt-in. The reflex hands the fight to bot.pvp (mineflayer-pvp)
    // with zero LLM involvement; the LLM is notified when the fight ends or if we are losing.
    if (this.pvpEnabled) {
      R.register({ name: 'pvp_players', trigger: 'player_near', action: 'engage_pvp', cooldownMs: 4000, radius: this.pvpRange })
    }
    // Example of an LLM-escalation reflex — shipped DISABLED; operators opt in:
    // R.register({ name: 'friend_gift', trigger: 'player_gave_item', action: 'call_system2', cooldownMs: 15000 })
  }

  /** Context handed to every reflex (actions and scripts). */
  _ctx () {
    const { goals } = require('mineflayer-pathfinder')
    return {
      bot: this.bot,
      goals,
      memory: this.memory,
      combat: this.combat,
      pathfinder: this.pathfinder,
      executor: null, // wired by the caller after build-time setup
      escalate: this.escalate,
      system1: this,
      logger: this.logger
    }
  }

  start () {
    if (this._timer) return
    this.registerBuiltins()
    this._timer = setInterval(() => { this.tick().catch(() => {}) }, this.tickMs)
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
  }

  /** One reflex scan — cheap; no LLM; sub-millisecond in practice. */
  async tick () {
    const bot = this.bot
    if (!bot?.entity) return
    const ctx = this._ctx()

    // hunger
    if (bot.food !== undefined && bot.food < this.eatBelowFood) {
      await this.registry.evaluate({ type: 'food_low', distance: 0 }, ctx)
    }
    // hostiles within 2m (near-field dodge — far-field flee is the wrapper's job)
    for (const e of Object.values(bot.entities || {})) {
      if (!e?.position || e === bot.entity) continue
      if (!/zombie|skeleton|creeper|spider|drowned|husk|witch|blaze|phantom/i.test(e.name || '')) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < 2.0) {
        await this.registry.evaluate({ type: 'hostile_near', distance: d, entity: e, item: e.name }, ctx)
        break
      }
    }
    // falling fast
    const vy = bot.entity?.velocity?.y ?? 0
    if (vy < this.fallVelocityThreshold) {
      await this.registry.evaluate({ type: 'falling', distance: 0 }, ctx)
    }
    // players within PvP range (reflex-gated; engage_pvp only exists if pvpEnabled)
    for (const e of Object.values(bot.entities || {})) {
      if (!e?.position || e === bot.entity || e.type !== 'player') continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d <= this.pvpRange) {
        await this.registry.evaluate({ type: 'player_near', distance: d, entity: e, item: e.username || 'player' }, ctx)
        break
      }
    }
    // losing watchdog — disengage and hand back to System 2 for the decision
    if (this._pvp && bot.health !== undefined && bot.health < 6) {
      this._pvp.ending = 'losing'
      try { bot.pvp?.stop() } catch { /* noop */ }
    }
    // auto-elytra on big falls
    if (this.autoElytra) this._maybeElytra(vy)
  }

  // ------------------------------------------------------- built-in actions
  eat () {
    const bot = this.bot
    if (Date.now() - this._lastEat < 7000) return
    const food = bot.inventory.items().find((i) => FOOD_RE.test(i.name))
    if (!food) return
    this._lastEat = Date.now()
    bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {})
  }

  useWaterBucket () {
    const bot = this.bot
    const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket')
    if (!bucket) return
    bot.equip(bucket, 'hand').then(() => bot.activateItem()).catch(() => {})
  }

  backJump () {
    const bot = this.bot
    bot.setControlState('back', true)
    bot.setControlState('jump', true)
    setTimeout(() => {
      try { bot.setControlState('back', false); bot.setControlState('jump', false) } catch { /* gone */ }
    }, 500)
  }

  /**
   * Engage the nearest player within pvpRange with mineflayer-pvp.
   * Called by the engage_pvp reflex — never by the LLM, never with a decision.
   * @returns {Promise<string>} outcome tag for reflex logging
   */
  async engageNearestPlayer (event) {
    const bot = this.bot
    if (!this.pvpEnabled) return 'pvp_disabled'
    if (!bot?.pvp) return 'pvp_unavailable' // plugin not loaded
    if (this._pvp) return 'already_fighting'
    if (Date.now() - this._pvpEndedAt < 10_000) return 'cooldown'
    const target = event?.entity
    if (!target?.position) return 'no_target'
    const d = target.position.distanceTo(bot.entity.position)
    if (d > this.pvpRange) return 'out_of_range'
    // Equip the best sword we carry (netherite > diamond > iron > stone > wood > golden).
    const SWORD_RANK = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword']
    const swords = bot.inventory.items().filter((i) => /sword$/.test(i.name))
    swords.sort((a, b) => SWORD_RANK.indexOf(a.name) - SWORD_RANK.indexOf(b.name))
    if (swords[0]) await bot.equip(swords[0], 'hand').catch(() => {})
    const targetName = target.username || target.name || 'player'
    try {
      bot.pvp.attack(target)
    } catch (err) {
      return `pvp_failed:${err.message || err}`
    }
    this._pvp = { target, startedAt: Date.now(), targetName, ending: null }
    this.memory?.addEvent({ type: 'combat', msg: `pvp engaged ${targetName}` })
    // One notification per fight — System 2 hears about it when it ends.
    bot.once('stoppedAttacking', () => this._endPvp(this._pvp?.ending || 'disengaged'))
    bot.once('entityGone', (e) => { if (e === this._pvp?.target) this._endPvp('won') })
    return 'pvp_engaged'
  }

  _endPvp (result) {
    const s = this._pvp
    if (!s) return
    this._pvp = null
    this._pvpEndedAt = Date.now()
    const secs = Math.max(1, Math.round((Date.now() - s.startedAt) / 1000))
    this.memory?.addEvent({ type: 'combat', msg: `pvp ${result} vs ${s.targetName} after ${secs}s` }, { promote: result === 'won' })
    try {
      this.escalate?.({ type: 'combat_ended', text: `${result} pvp vs ${s.targetName} after ${secs}s`, msg: 'pvp ended' })
    } catch { /* no escalation channel wired */ }
  }

  /** Deploy elytra on big falls when one is carried. Fires at most every 5 s. */
  _maybeElytra (vy) {
    const bot = this.bot
    if (!(vy < -1.5)) return
    if (Date.now() - this._lastElytra < 5000) return
    const elytra = bot.inventory?.items?.().find((i) => i.name === 'elytra')
    if (!elytra) return
    const feet = bot.entity?.position?.floored?.()
    if (!feet) return
    let floorDist = Infinity
    for (let i = 1; i <= 12; i++) {
      const b = bot.blockAt(feet.offset(0, -i, 0))
      if (b && b.boundingBox === 'block') { floorDist = i; break }
    }
    if (floorDist <= 4) return // survivable fall — do not flap
    this._lastElytra = Date.now()
    this.logger?.info?.('reflex', 'auto-elytra: big fall, deploying elytra')
    bot.equip(elytra, 'torso').then(() => {
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch { /* gone */ } }, 250)
    }).catch(() => {})
  }

  /** External entry points for bot-event driven reflexes. */
  onEntityHurt (entity) {
    const d = entity?.position && this.bot.entity ? entity.position.distanceTo(this.bot.entity.position) : 0
    this.registry.evaluate({ type: 'entity_hurt', distance: d, entity }, this._ctx()).catch(() => {})
  }

  onItemGained (itemName, fromPlayer = null) {
    const type = fromPlayer ? 'player_gave_item' : 'item_gained'
    this.registry.evaluate({ type, item: itemName, distance: 0 }, this._ctx()).catch(() => {})
  }

  onChatLine (sender, text) {
    this.registry.evaluate({ type: 'chat', text, distance: 0 }, this._ctx()).catch(() => {})
  }
}

module.exports = { System1, FOOD_RE }
