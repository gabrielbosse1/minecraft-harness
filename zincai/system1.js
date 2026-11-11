/**
 * system1.js — the reflex layer. No LLM calls here, ever.
 *
 * POLICY (owner's rule):
 *   The bot never starts a fight and never attacks a player on its own.
 *   Its one reflex toward danger is to FLEE — from every real threat — and to
 *   tell the model, which then decides: attack, go somewhere, hold, or keep
 *   fleeing (idle). Once the model has decided about the threats it was shown,
 *   those threats stop triggering the reflex for that decision. New threats,
 *   a lit creeper, or low health trigger it again.
 *
 * Reflexes are still registry-driven (same `register()` call an operator
 * would use), but the built-ins are now:
 *
 *   threat_near → flee          run from real threats (threats.js decides
 *                               what is real: line of sight, reachability,
 *                               recent attackers — never a caged mob, never a
 *                               friend holding a bow)
 *   food_low    → eat           ranked whitelist, no waste, hand restored
 *   health_low  → eat           golden apple when it matters
 *   falling     → drink_water   water bucket on a fall that would HURT, aimed
 *                               down, picked back up afterwards
 *   falling     → elytra        bot.elytraFly() — a jump pulse does nothing
 *   in_water    → swim          hold jump while submerged and idle
 *
 * Every key press goes through a ControlArbiter lane (control.js), so nothing
 * here can leave a key held, and the pathfinder goal of an interrupted task
 * is resumed when the reflex lets go.
 */
'use strict'

const { ControlArbiter, PRIORITY } = require('./control')
const { ThreatSense } = require('./threats')

// ---------------------------------------------------------------------------
// Food. `points` = hunger restored, `sat` = saturation. Only items listed here
// are ever eaten: a regex over item names also matched poisonous potatoes,
// beetroot seeds, carrot-on-a-stick and buckets of cod.
// ---------------------------------------------------------------------------
const FOODS = {
  golden_carrot: { points: 6, sat: 14.4 },
  cooked_beef: { points: 8, sat: 12.8 },
  cooked_porkchop: { points: 8, sat: 12.8 },
  cooked_mutton: { points: 6, sat: 9.6 },
  cooked_salmon: { points: 6, sat: 9.6 },
  cooked_chicken: { points: 6, sat: 7.2 },
  cooked_rabbit: { points: 5, sat: 6 },
  cooked_cod: { points: 5, sat: 6 },
  rabbit_stew: { points: 10, sat: 12 },
  mushroom_stew: { points: 6, sat: 7.2 },
  beetroot_soup: { points: 6, sat: 7.2 },
  bread: { points: 5, sat: 6 },
  baked_potato: { points: 5, sat: 6 },
  pumpkin_pie: { points: 8, sat: 4.8 },
  apple: { points: 4, sat: 2.4 },
  carrot: { points: 3, sat: 3.6 },
  melon_slice: { points: 2, sat: 1.2 },
  sweet_berries: { points: 2, sat: 0.4 },
  glow_berries: { points: 2, sat: 0.4 },
  cookie: { points: 2, sat: 0.4 },
  beetroot: { points: 1, sat: 1.2 },
  dried_kelp: { points: 1, sat: 0.6 },
  honey_bottle: { points: 6, sat: 1.2 },
  // Raw meat: safe but poor. Eaten only when nothing cooked is carried.
  beef: { points: 3, sat: 1.8, raw: true },
  porkchop: { points: 3, sat: 1.8, raw: true },
  mutton: { points: 2, sat: 1.2, raw: true },
  rabbit: { points: 3, sat: 1.8, raw: true },
  cod: { points: 2, sat: 0.4, raw: true },
  salmon: { points: 2, sat: 0.4, raw: true },
  potato: { points: 1, sat: 0.6, raw: true },
  // Risky: only when starving and nothing else is carried.
  chicken: { points: 2, sat: 1.2, risky: true },
  rotten_flesh: { points: 4, sat: 0.8, risky: true }
}
/** Healing items: never a snack. Only the health_low reflex may eat them. */
const HEALING = { golden_apple: 8, enchanted_golden_apple: 6 } // name -> eat at or below this health

/** Legacy export: every edible item name this layer may ever consume. */
const FOOD_RE = new RegExp(`^(${[...Object.keys(FOODS), ...Object.keys(HEALING)].join('|')})$`)

/**
 * Choose what to eat.
 * @param {Array<{name:string}>} items inventory
 * @param {{ food:number, health:number, healing?:boolean }} state
 * @returns {object|null} the inventory item, or null when eating is pointless
 */
function chooseFood (items, { food = 20, health = 20, healing = false } = {}) {
  if (healing) {
    const heal = items
      .filter((i) => HEALING[i.name] !== undefined && health <= HEALING[i.name])
      .sort((a, b) => HEALING[b.name] - HEALING[a.name])[0]
    if (heal) return heal
  }
  const deficit = 20 - food
  if (deficit <= 0) return null
  const candidates = items.filter((i) => FOODS[i.name])
  if (!candidates.length) return null
  const safe = candidates.filter((i) => !FOODS[i.name].risky)
  const pool = safe.length ? safe : (food <= 3 ? candidates : [])
  if (!pool.length) return null
  const cooked = pool.filter((i) => !FOODS[i.name].raw)
  const ranked = (cooked.length ? cooked : pool).slice().sort((a, b) => FOODS[b.name].sat - FOODS[a.name].sat)
  // No waste: the best item that fits the deficit; when really hungry, anything.
  const fits = ranked.find((i) => FOODS[i.name].points <= deficit)
  if (fits) return fits
  return food <= 12 ? ranked[ranked.length - 1] : null
}

class System1 {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ registry: import('./reflex_registry').ReflexRegistry,
   *           logger?: object,
   *           escalate?: (event: object) => any,
   *           onEvent?: (event: {type:string, text:string, wake?:boolean}) => void,
   *           pathfinder?: object,       PathfinderWrapper (fleePlan)
   *           memory?: object,
   *           combat?: object,           AdvancedCombat (to know an explicit fight is on)
   *           arbiter?: ControlArbiter,  shared with combat and the task executor
   *           sense?: ThreatSense,
   *           eatBelowFood?: number, lowHealth?: number, fleeBelowHealth?: number,
   *           mlgFallBlocks?: number, fleeDistance?: number,
   *           tickMs?: number, autoElytra?: boolean, now?: () => number }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.registry = opts.registry
    this.logger = opts.logger || console
    this.escalate = opts.escalate || null
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {}
    this.pathfinder = opts.pathfinder || null
    this.memory = opts.memory || null
    this.combat = opts.combat || null
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.arbiter = opts.arbiter || new ControlArbiter(bot, { now: this.now })
    this.hands = this.arbiter.lane('survival', PRIORITY.survival)
    this.buoyancy = this.arbiter.lane('buoyancy', PRIORITY.idle)
    this.sense = opts.sense || new ThreatSense(bot, { now: this.now })
    this.eatBelowFood = opts.eatBelowFood ?? 18
    this.lowHealth = opts.lowHealth ?? 10
    this.fleeBelowHealth = opts.fleeBelowHealth ?? 6
    this.mlgFallBlocks = opts.mlgFallBlocks ?? 5
    this.fleeDistance = opts.fleeDistance ?? 14
    this.tickMs = opts.tickMs ?? 200
    this.autoElytra = opts.autoElytra !== false
    this._timer = null
    this._lastEat = 0
    this._lastElytra = 0
    this._eating = false

    /** threat id -> expiry. The model has decided about these. */
    this._acked = new Map()
    /** threat type names the model chose to fight (extends to newcomers). */
    this._ackedTypes = new Set()
    this._ackAll = 0 // until when every non-hard threat is acknowledged
    /** Threats that currently drive the flee reflex. */
    this.live = []
    this._flee = null
    this._episode = null
    this._calmSince = 0
    this._fall = { startY: null, fallen: 0 }
    this._mlg = null
    this._onPhysics = this._physicsTick.bind(this)
    this._onPathUpdate = (result) => {
      if (!this._flee || !this.hands.isTop) return
      if (result?.status === 'noPath' || result?.status === 'timeout') this._flee.direct = true
    }
    if (!this.registry) throw new Error('System1 requires a ReflexRegistry')
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
    this.arbiter.start()
    this._timer = setInterval(() => { this.tick().catch(() => {}) }, this.tickMs)
    try {
      this.bot.on('physicsTick', this._onPhysics)
      this.bot.on('path_update', this._onPathUpdate)
    } catch { /* partial mock */ }
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
    try {
      this.bot.removeListener?.('physicsTick', this._onPhysics)
      this.bot.removeListener?.('path_update', this._onPathUpdate)
    } catch { /* gone */ }
    this._flee = null
    this._mlg = null
    this.hands.release('stop')
    this.buoyancy.release('stop')
  }

  /** Death / respawn: forget every decision and every claim. */
  reset () {
    this._acked.clear()
    this._ackedTypes.clear()
    this._ackAll = 0
    this._flee = null
    this._episode = null
    this._mlg = null
    this.live = []
    this._fall = { startY: null, fallen: 0 }
    this.hands.release('reset')
    this.buoyancy.release('reset')
  }

  /** Register the built-in survival reflexes (same API users get). */
  registerBuiltins () {
    const R = this.registry
    if (this._registered) return
    this._registered = true
    R.register({ name: 'flee_from_threats', trigger: 'threat_near', action: 'flee', cooldownMs: 0 })
    R.register({ name: 'eat_when_hungry', trigger: 'food_low', action: 'eat', cooldownMs: 4000 })
    R.register({ name: 'heal_when_hurt', trigger: 'health_low', action: 'eat', cooldownMs: 3000 })
    R.register({ name: 'water_bucket_on_long_fall', trigger: 'falling', action: 'drink_water', cooldownMs: 1500 })
    if (this.autoElytra) R.register({ name: 'glide_on_long_fall', trigger: 'falling', action: 'elytra', cooldownMs: 3000 })
    R.register({ name: 'swim_up', trigger: 'in_water', action: 'swim', cooldownMs: 0 })
  }

  // ------------------------------------------------ the model's decisions

  /**
   * The model has seen these threats and chosen what to do about them. They
   * stop triggering the flee reflex until `ttlMs` passes or clearDecision().
   *
   * @param {Iterable<number>} ids threat ids from the prompt the model answered
   * @param {{ types?: string[], all?: boolean, ttlMs?: number, label?: string }} [opts]
   *   types — "fight zombies" also covers zombies that show up later
   *   all   — "fight anything hostile"
   */
  acknowledge (ids = [], { types = [], all = false, ttlMs = 60_000, label = 'decision' } = {}) {
    const until = this.now() + ttlMs
    for (const id of ids) this._acked.set(id, until)
    for (const t of types) this._ackedTypes.add(String(t).toLowerCase())
    if (all) this._ackAll = until
    this._decision = label
    // Stop running at once if nothing live is left.
    this._refreshLive()
    if (!this.live.length) this._endFlee('model decided')
    return this.live.length === 0
  }

  /** Back to the default: flee from everything. */
  clearDecision () {
    this._acked.clear()
    this._ackedTypes.clear()
    this._ackAll = 0
    this._decision = null
  }

  get fleeing () { return Boolean(this._flee) }

  /** Is this threat still up to the reflex (true) or already decided (false)? */
  _isLive (t, now) {
    const targetId = this.combat?.isEngaged ? this.combat.target?.id : null
    if (targetId !== null && t.id === targetId) return false // the chosen fight handles its own target
    if (t.hard) return true
    const hp = Number(this.bot.health)
    if (Number.isFinite(hp) && hp <= this.fleeBelowHealth) return true // too hurt to honour old decisions
    if (now < this._ackAll) return false
    if (this._ackedTypes.has(t.name)) return false
    const until = this._acked.get(t.id)
    return !(until && now < until)
  }

  _refreshLive () {
    const now = this.now()
    for (const [id, until] of this._acked) if (now >= until) this._acked.delete(id)
    this.live = this.sense.last.threats.filter((t) => this._isLive(t, now))
    return this.live
  }

  // ------------------------------------------------------------- the tick

  /** One reflex scan — cheap; no LLM. */
  async tick () {
    const bot = this.bot
    if (!bot?.entity) return
    const ctx = this._ctx()
    const now = this.now()

    // 1. Real threats → flee (unless the model already decided about them).
    this.sense.assess()
    const live = this._refreshLive()
    if (live.length) {
      this._calmSince = 0
      this._noteEpisode(live, now)
      await this.registry.evaluate({ type: 'threat_near', distance: live[0].distance, entity: live[0].entity, item: live[0].name, threats: live }, ctx)
    } else if (this._flee) {
      if (!this._calmSince) this._calmSince = now
      if (now - this._calmSince >= 800) this._endFlee('safe')
      else this.hands.touch(1500)
    } else if (this._episode && this.sense.last.threats.length === 0) {
      this._episode = null
    }

    // 2. Health and hunger.
    const hp = Number(bot.health)
    if (Number.isFinite(hp) && hp <= this.lowHealth) {
      await this.registry.evaluate({ type: 'health_low', distance: 0, item: String(hp) }, ctx)
    }
    if (bot.food !== undefined && bot.food < this.eatBelowFood) {
      await this.registry.evaluate({ type: 'food_low', distance: 0 }, ctx)
    }

    // 3. Submerged and idle → swim up.
    if (this._headInWater()) await this.registry.evaluate({ type: 'in_water', distance: 0 }, ctx)
    else if (this.buoyancy.active) this.buoyancy.release('surfaced')
  }

  /** Tell the model once per episode, and again when the picture changes. */
  _noteEpisode (live, now) {
    const ids = new Set(live.map((t) => t.id))
    const ep = this._episode
    let reason = null
    if (!ep) reason = 'new'
    else {
      const fresh = live.filter((t) => !ep.ids.has(t.id))
      const urgent = fresh.some((t) => t.hard || t.attacker)
      if (urgent || (fresh.length && now - ep.notifiedAt >= 5000)) reason = 'changed'
    }
    if (!reason) { if (ep) for (const id of ids) ep.ids.add(id); return }
    this._episode = { ids, startedAt: ep?.startedAt || now, notifiedAt: now }
    const text = `fleeing from ${this.sense.describe(live)}`
    this.logger?.info?.('reflex', text)
    this.onEvent({ type: 'threat', text, wake: true, threatIds: [...ids] })
  }

  // ------------------------------------------------------------- flee ----

  /**
   * Reflex action: run from the live threats. Plans with the threat-aware
   * pathfinder; if A* has no route (or the bot is not making ground) it turns
   * away and sprints — standing still is never the answer.
   */
  flee (event) {
    const bot = this.bot
    const threats = event?.threats?.length ? event.threats : this.live
    const pos = bot.entity?.position
    if (!pos || !threats?.length) return 'no_threat'
    const now = this.now()
    const lane = this.hands
    const names = [...new Set(threats.map((t) => t.name))].slice(0, 3).join(', ')
    const started = !this._flee
    lane.acquire({ ttlMs: 1500, reason: `fleeing ${names}` })
    const f = this._flee || (this._flee = { startedAt: now, planAt: -Infinity, direct: false, directUntil: 0, lastPos: { x: pos.x, z: pos.z }, lastMoveAt: now, dir: null })
    if (started) this.logger?.warn?.('reflex', `flee: ${names} (${threats.length})`)

    // Progress check: 600 ms without moving 0.4 blocks → stop trusting the path.
    if (Math.hypot(pos.x - f.lastPos.x, pos.z - f.lastPos.z) >= 0.4) {
      f.lastPos = { x: pos.x, z: pos.z }
      f.lastMoveAt = now
    } else if (now - f.lastMoveAt > 600 && !f.direct) {
      f.direct = true
    }

    // Direct mode lasts one second at a time; then the planner gets another go.
    if (f.direct && !f.directUntil) {
      f.directUntil = now + 1000
      f.dir = this._escapeDirection(threats)
      lane.setGoal(null)
    } else if (f.direct && now >= f.directUntil) {
      f.direct = false
      f.directUntil = 0
      f.planAt = -Infinity
      f.lastMoveAt = now
    }
    if (!f.direct && now - f.planAt >= 2000) {
      f.planAt = now
      const lit = threats.some((t) => t.lit)
      let plan = null
      try { plan = this.pathfinder?.fleePlan?.({ distance: lit ? this.fleeDistance + 4 : this.fleeDistance }) } catch { plan = null }
      if (plan?.goal) {
        f.dir = plan.direction
        lane.clearControlStates()
        lane.setGoal(plan.goal, true)
      } else {
        f.direct = true
        f.directUntil = now + 1000
        f.dir = this._escapeDirection(threats)
        lane.setGoal(null)
      }
    }
    if (f.direct) this._sprintAlong(f.dir || this._escapeDirection(threats))
    return 'flee'
  }

  /** Unit vector away from the weighted centre of the threats. */
  _escapeDirection (threats) {
    const pos = this.bot.entity.position
    let sx = 0; let sz = 0
    for (const t of threats) {
      const p = t.entity?.position
      if (!p) continue
      const dx = pos.x - p.x; const dz = pos.z - p.z
      const len = Math.hypot(dx, dz) || 0.01
      const w = 1 / Math.max(1, len)
      sx += (dx / len) * w; sz += (dz / len) * w
    }
    const len = Math.hypot(sx, sz)
    if (len < 0.01) {
      // Evenly surrounded: any way out beats none. Keep the current heading.
      const yaw = Number(this.bot.entity.yaw) || 0
      return { x: -Math.sin(yaw), z: -Math.cos(yaw) }
    }
    return { x: sx / len, z: sz / len }
  }

  /** Face a direction and sprint-jump along it (no pathfinder involved). */
  _sprintAlong (dir) {
    const bot = this.bot
    const lane = this.hands
    try { Promise.resolve(bot.look(Math.atan2(-dir.x, -dir.z), 0, true)).catch(() => {}) } catch { /* mock */ }
    lane.setControlState('back', false)
    lane.setControlState('left', false)
    lane.setControlState('right', false)
    lane.setControlState('forward', true)
    lane.setControlState('sprint', true)
    lane.setControlState('jump', Boolean(bot.entity.onGround))
  }

  _endFlee (why) {
    if (!this._flee) return
    const secs = Math.max(1, Math.round((this.now() - this._flee.startedAt) / 1000))
    this._flee = null
    this._calmSince = 0
    this.hands.release(why)
    if (why === 'safe') {
      this._episode = null
      this.onEvent({ type: 'safe', text: `safe again after fleeing ${secs}s`, wake: true })
    }
  }

  // ------------------------------------------------------------- eating --

  /**
   * Reflex action for food_low / health_low. Picks from the whitelist, never
   * wastes food, never eats with a threat on top of it, and puts the held
   * item back afterwards.
   */
  eat (event) {
    const bot = this.bot
    const now = this.now()
    if (this._eating || now - this._lastEat < 2500) return 'eat_cooldown'
    const healing = event?.type === 'health_low'
    let items = []
    try { items = bot.inventory.items() } catch { return 'no_inventory' }
    const food = chooseFood(items, { food: Number(bot.food ?? 20), health: Number(bot.health ?? 20), healing })
    if (!food) return 'nothing_to_eat'
    // Eating roots the bot for 1.6 s and takes the sword out of its hand: not
    // with something within arm's reach, and not in the middle of a fight.
    const isHealing = HEALING[food.name] !== undefined
    const nearest = this.live[0]
    if (!isHealing && nearest && nearest.distance < 6) return 'eat_unsafe'
    if (!isHealing && this.combat?.isEngaged) return 'eat_fighting'
    this._lastEat = now
    this._eating = true
    this.arbiter.useHand('eat', food, () => bot.consume(), { priority: PRIORITY.survival, restore: true })
      .then((r) => { if (!r.ok) this.logger?.debug?.('reflex', `eat ${food.name}: ${r.why}`) })
      .finally(() => { this._eating = false })
    return `eat_${food.name}`
  }

  // --------------------------------------------------------- falling -----

  /** Solid block under the feet within `max` blocks, or Infinity. */
  _dropBelow (max = 40) {
    const bot = this.bot
    const feet = bot.entity?.position
    if (!feet || !bot.blockAt) return { drop: Infinity, block: null }
    const x = Math.floor(feet.x); const z = Math.floor(feet.z)
    const top = Math.floor(feet.y)
    for (let i = 0; i <= max; i++) {
      let b = null
      try { b = bot.blockAt({ x, y: top - i, z }, false) } catch { b = null }
      if (!b) continue
      if (b.name === 'water') return { drop: Math.max(0, feet.y - (top - i + 1)), block: b, water: true }
      if (b.boundingBox === 'block') return { drop: Math.max(0, feet.y - (top - i + 1)), block: b, water: false }
    }
    return { drop: Infinity, block: null, water: false }
  }

  /**
   * 20 Hz: measure the fall actually in progress. A reflex keyed on vertical
   * speed alone fires on every jump (a standing jump reaches -0.45 b/t); this
   * one needs a fall that will really hurt: distance already fallen plus the
   * drop still ahead.
   */
  _physicsTick () {
    const bot = this.bot
    const e = bot.entity
    if (!e?.position) return
    this.sense.trackMotion()
    const vy = Number(e.velocity?.y) || 0
    if (e.onGround || e.isInWater || e.elytraFlying) {
      this._fall = { startY: null, fallen: 0 }
      if (this._mlg) this._mlgLanded()
      return
    }
    if (vy >= 0) { this._fall.startY = e.position.y; this._fall.fallen = 0; return }
    if (this._fall.startY === null) this._fall.startY = e.position.y
    this._fall.fallen = Math.max(0, this._fall.startY - e.position.y)
    if (this._mlg) { this._mlgTick(); return }
    if (this._fall.fallen < 2 || vy > -0.5) return
    const ahead = this._dropBelow(40)
    if (ahead.water) return // already landing in water
    const total = this._fall.fallen + ahead.drop
    if (total < this.mlgFallBlocks) return
    this.registry.evaluate({ type: 'falling', distance: ahead.drop, item: String(Math.round(total)), drop: ahead.drop, total }, this._ctx()).catch(() => {})
  }

  /**
   * Reflex action: water-bucket clutch. Equip early, look straight down,
   * place when the ground is in reach, pick the water back up after landing.
   */
  useWaterBucket (event) {
    const bot = this.bot
    if (this._mlg) return 'mlg_running'
    let bucket = null
    try { bucket = bot.inventory.items().find((i) => i.name === 'water_bucket') } catch { return 'no_inventory' }
    if (!bucket) return 'no_bucket'
    if (!(event?.total >= this.mlgFallBlocks)) return 'fall_too_short'
    const before = bot.heldItem || null
    this._mlg = { phase: 'equip', before, placedAt: 0, startedAt: this.now() }
    Promise.resolve(bot.equip(bucket, 'hand'))
      .then(() => { if (this._mlg) this._mlg.phase = 'aim' })
      .catch(() => { this._mlg = null })
    try { Promise.resolve(bot.look(bot.entity.yaw || 0, -Math.PI / 2, true)).catch(() => {}) } catch { /* mock */ }
    this.logger?.warn?.('reflex', `water clutch: ${Math.round(event.total)} block fall`)
    return 'mlg_armed'
  }

  _mlgTick () {
    const m = this._mlg
    const bot = this.bot
    if (!m || m.phase !== 'aim') return
    try { Promise.resolve(bot.look(bot.entity.yaw || 0, -Math.PI / 2, true)).catch(() => {}) } catch { /* mock */ }
    const { drop } = this._dropBelow(8)
    // Eye is 1.62 above the feet; survival block reach is 4.5.
    if (drop <= 2.6) {
      try { bot.activateItem() } catch { /* gone */ }
      m.phase = 'placed'
      m.placedAt = this.now()
    }
  }

  _mlgLanded () {
    const m = this._mlg
    const bot = this.bot
    if (!m) return
    if (m.phase !== 'placed') { this._mlgFinish(); return }
    if (m.pickup) return
    m.pickup = true
    // Scoop the source back up (still looking straight down), then re-arm the hand.
    setTimeout(() => {
      try {
        const holdingEmpty = bot.heldItem?.name === 'bucket'
        if (holdingEmpty) bot.activateItem()
      } catch { /* gone */ }
      setTimeout(() => this._mlgFinish(), 250)
    }, 250)
  }

  _mlgFinish () {
    const m = this._mlg
    const bot = this.bot
    this._mlg = null
    if (!m?.before) return
    try {
      const again = bot.inventory.items().find((i) => i.name === m.before.name)
      if (again && bot.heldItem?.name !== again.name) Promise.resolve(bot.equip(again, 'hand')).catch(() => {})
    } catch { /* gone */ }
  }

  /**
   * Reflex action: open the elytra. mineflayer only starts a glide through
   * bot.elytraFly(); pulsing the jump key in mid-air does nothing.
   */
  deployElytra (event) {
    const bot = this.bot
    const now = this.now()
    if (now - this._lastElytra < 3000) return 'elytra_cooldown'
    if (bot.entity?.elytraFlying) return 'already_gliding'
    if (this._mlg) return 'mlg_running' // the bucket has it
    if (!(event?.drop >= 6) || !(event?.total >= 8)) return 'fall_too_short'
    let worn = null
    try {
      const slot = bot.getEquipmentDestSlot?.('torso')
      worn = bot.inventory?.slots?.[Number.isFinite(slot) ? slot : 6] || null
    } catch { worn = null }
    let carried = null
    try { carried = bot.inventory.items().find((i) => i.name === 'elytra') } catch { carried = null }
    if (worn?.name !== 'elytra' && !carried) return 'no_elytra'
    this._lastElytra = now
    const open = async () => {
      if (worn?.name !== 'elytra') await bot.equip(carried, 'torso')
      await bot.elytraFly()
      // Shallow glide; the pathfinder is not in charge up here.
      try { await bot.look(bot.entity.yaw || 0, -0.15, true) } catch { /* mock */ }
    }
    open().catch((err) => this.logger?.debug?.('reflex', `elytra: ${err.message || err}`))
    this.logger?.warn?.('reflex', `elytra: ${Math.round(event.total)} block fall`)
    return 'elytra_open'
  }

  // ------------------------------------------------------------ swimming --

  _headInWater () {
    const bot = this.bot
    const e = bot.entity
    if (!e?.position || !bot.blockAt) return false
    if (e.isInWater === false) return false
    try {
      const eye = bot.blockAt({ x: Math.floor(e.position.x), y: Math.floor(e.position.y + 1.5), z: Math.floor(e.position.z) }, false)
      return eye?.name === 'water'
    } catch { return false }
  }

  /** Reflex action: hold jump while under water and nobody else is driving. */
  swim () {
    this.buoyancy.acquire({ ttlMs: 600, reason: 'swimming up' })
    this.buoyancy.setControlState('jump', true)
    return 'swim'
  }

  // ----------------------------------------------- operator reflex helpers

  /** Legacy operator action: short back+jump hop. Keys are auto-released. */
  backJump () {
    const lane = this.hands
    lane.acquire({ ttlMs: 500, reason: 'hop back' })
    lane.pulse('back', 400)
    lane.pulse('jump', 200)
    return 'back_jump'
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

module.exports = { System1, FOOD_RE, FOODS, HEALING, chooseFood }
