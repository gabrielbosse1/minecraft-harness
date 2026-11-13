/**
 * control.js — ControlArbiter: the single owner of the bot's "hands".
 *
 * Before this module every subsystem (reflexes, flee, combat, pathfinder
 * tasks, the LLM executor) pressed movement keys and set pathfinder goals on
 * its own. They cancelled each other (forward + back = 0 m/s), cleared each
 * other's goals, and left keys held forever when their owner went idle.
 *
 * Now each subsystem gets a *lane* with a fixed priority:
 *
 *     survival (3)  >  combat (2)  >  task (1)  >  idle (0)
 *
 * A lane records what it WANTS (keys, pathfinder goal). Only the highest
 * priority active lane is applied to the bot. When a lane is released — by its
 * owner or by its TTL — everything it pressed is released with it, and the
 * next lane down is re-applied (its goal resumes). Nothing sticks.
 *
 * The arbiter also owns the main hand: `useHand()` serialises "equip X, use
 * it, put the old item back" so a reflex can never leave a water bucket or a
 * carrot where the sword was.
 *
 * Pure w.r.t. time (inject `now`) and tolerant of partial mock bots.
 */
'use strict'

const { EventEmitter } = require('events')

const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const PRIORITY = Object.freeze({ idle: 0, task: 1, combat: 2, survival: 3 })

class Lane {
  constructor (arbiter, name, priority) {
    this.arbiter = arbiter
    this.name = name
    this.priority = priority
    /** Set by the arbiter when a physical boundary gates this lane's writes. */
    this.gate = null
    /** Physical writes refused by the boundary since the last acquire/release. */
    this.refused = 0
    this.active = false
    this.keys = {}
    this.goal = undefined // undefined = no opinion, null = "no goal", object = goal
    this.dynamic = false
    this.expiresAt = Infinity
    this.reason = ''
    this.preempted = false
    this._pulses = new Map()
  }

  /** True when this lane currently drives the bot. */
  get isTop () { return this.arbiter.top() === this }

  /**
   * Claim control. Returns true when this lane is now the one applied.
   * `ttlMs` makes the claim self-expiring: call touch()/acquire() again to
   * keep it. A lane that is never renewed can never hold a key forever.
   */
  acquire ({ ttlMs = Infinity, reason = '' } = {}) {
    const before = this.arbiter.top()
    this.active = true
    this.reason = reason || this.reason
    this.expiresAt = Number.isFinite(ttlMs) ? this.arbiter.now() + ttlMs : Infinity
    this.arbiter._reconcile(before)
    return this.isTop
  }

  /** Extend a TTL claim without changing anything else. */
  touch (ttlMs) {
    if (!this.active) return false
    this.expiresAt = Number.isFinite(ttlMs) ? this.arbiter.now() + ttlMs : Infinity
    return true
  }

  /** Give control back. Everything this lane pressed is released. */
  release (reason = 'released') {
    if (!this.active) return false
    const before = this.arbiter.top()
    this.active = false
    // Reconcile while this.keys still lists what we pressed, so it is let go.
    this.arbiter._reconcile(before)
    this.preempted = false
    this.keys = {}
    this.goal = undefined
    this.dynamic = false
    this.expiresAt = Infinity
    for (const t of this._pulses.values()) clearTimeout(t)
    this._pulses.clear()
    this.arbiter.emit('release', { lane: this.name, reason })
    return true
  }

  setControlState (key, value) {
    if (!KEYS.includes(key)) return false
    const v = Boolean(value)
    if (Boolean(this.keys[key]) === v) return this.isTop
    if (v) this.keys[key] = true
    else delete this.keys[key]
    if (this.active && this.isTop) this.arbiter._press(key, v)
    return this.isTop
  }

  /**
   * May this lane drive the body right now? The boundary is consulted HERE so
   * that a pause, a permission or an area limit stops the keys and the
   * pathfinder goal even for a lane that started before the change.
   */
  allowed (cap = 'move') {
    if (!this.gate) return true
    const verdict = this.gate(cap)
    if (!verdict.ok) { this.refused++; return false }
    return true
  }

  /** Mirror of bot.clearControlStates() for this lane only. */
  clearControlStates () {
    for (const key of Object.keys(this.keys)) this.setControlState(key, false)
  }

  /** Press a key for `ms`, then release it — even if the caller forgets. */
  pulse (key, ms = 150) {
    if (!KEYS.includes(key)) return false
    this.setControlState(key, true)
    clearTimeout(this._pulses.get(key))
    this._pulses.set(key, setTimeout(() => {
      this._pulses.delete(key)
      this.setControlState(key, false)
    }, ms))
    return true
  }

  /**
   * Set (or clear with null) this lane's pathfinder goal. Returns true when
   * the goal was applied now; false when it is only recorded because a higher
   * lane is driving (it will be applied when that lane lets go).
   */
  setGoal (goal, dynamic = false) {
    this.goal = goal === undefined ? null : goal
    this.dynamic = Boolean(dynamic)
    // Releasing a goal is always allowed; only DRIVING the body is gated.
    if (this.goal !== null && !this.allowed('move')) return false
    if (this.active && this.isTop) {
      this.arbiter._applyGoal(this.goal, this.dynamic)
      this.arbiter._pressAll(this)
      return true
    }
    return false
  }
}

class ControlArbiter extends EventEmitter {
  /**
   * @param {object} bot mineflayer bot (or a partial mock)
   * @param {{ logger?: (level:string,msg:string)=>void, now?: () => number }} [opts]
   */
  constructor (bot, { logger = () => {}, now = () => Date.now() } = {}) {
    super()
    this.bot = bot
    this.log = logger
    this.now = now
    this.lanes = new Map()
    this._appliedGoal = undefined
    this._timer = null
    this._handBusy = null // { owner, priority }
  }

  /** Get (or create) a lane. Priority may be a number or a PRIORITY key. */
  lane (name, priority = PRIORITY.task) {
    const existing = this.lanes.get(name)
    if (existing) return existing
    const p = typeof priority === 'string' ? (PRIORITY[priority] ?? PRIORITY.task) : priority
    const lane = new Lane(this, name, p)
    lane.gate = this.gate ? (cap) => this.gate(cap) : null
    this.lanes.set(name, lane)
    return lane
  }

  /** Highest-priority active lane, or null when nobody claims control. */
  top () {
    let best = null
    for (const lane of this.lanes.values()) {
      if (!lane.active) continue
      if (!best || lane.priority > best.priority) best = lane
    }
    return best
  }

  owner () { return this.top()?.name || 'idle' }

  start (intervalMs = 100) {
    if (this._timer) return
    this._timer = setInterval(() => this.tick(), intervalMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
    for (const lane of this.lanes.values()) lane.release('stop')
    this._releaseEverything()
  }

  /** Expire TTL claims. Called by the timer; tests call it with a fake clock. */
  tick () {
    const now = this.now()
    for (const lane of this.lanes.values()) {
      if (lane.active && now >= lane.expiresAt) lane.release('ttl')
    }
  }

  /**
   * Something outside the lanes touched the bot (the anti-stuck routine
   * clears the path and taps keys): put the current driver's goal and keys
   * back, and let go of every key nobody is holding.
   */
  reassert () {
    const top = this.top()
    // Goal first: upstream setGoal() clears every control state.
    this._applyGoal(top && top.goal !== undefined ? top.goal : null, top?.dynamic)
    for (const key of KEYS) this._press(key, Boolean(top && top.keys[key]))
  }

  /**
   * Release everything a lane is pressing and hold it inactive — used by
   * `stop` (the operator's pause) so no key and no pathfinder goal survives it.
   * @returns {string[]} the names of the lanes that were released
   */
  halt (reason = 'paused') {
    const released = []
    for (const lane of this.lanes.values()) {
      if (lane.active) { lane.release(reason); released.push(`${lane.name} lane released`) }
      else { lane.keys = {}; lane.goal = undefined }
    }
    this._releaseEverything()
    this._appliedGoal = undefined
    this._handBusy = null
    this.emit('halt', { reason, lanes: released })
    return released
  }

  /** Called on death/respawn: nobody owns anything any more. */
  reset (reason = 'reset') {
    for (const lane of this.lanes.values()) if (lane.active) lane.release(reason)
    this._appliedGoal = undefined
    this._releaseEverything()
  }

  // ------------------------------------------------------------ internals

  _press (key, value) {
    try { this.bot.setControlState(key, Boolean(value)) } catch { /* bot gone / mock */ }
  }

  /**
   * Install the shared physical gate. Every lane created afterwards inherits
   * it, and existing lanes are updated too, so installing it late still covers
   * the survival/combat/task lanes the session built earlier.
   * @param {(cap:string) => { ok:boolean, why?:string }} gate
   */
  setGate (gate) {
    this.gate = typeof gate === 'function' ? gate : null
    for (const lane of this.lanes.values()) lane.gate = this.gate ? (cap) => this.gate(cap) : null
    return this
  }

  _pressAll (lane) {
    for (const key of KEYS) if (lane.keys[key]) this._press(key, true)
  }

  _releaseEverything () {
    for (const key of KEYS) this._press(key, false)
  }

  _applyGoal (goal, dynamic) {
    const next = goal === undefined ? null : goal
    const pf = this.bot.pathfinder
    // Trust the pathfinder's own view when it exposes one: it drops a reached
    // goal by itself, and legacy callers may still set goals directly.
    const current = pf && 'goal' in pf ? (pf.goal ?? null) : (this._appliedGoal ?? null)
    this._appliedGoal = next
    if (next === current) return false
    try { pf?.setGoal?.(next, Boolean(dynamic)) } catch (err) {
      this.log('debug', `arbiter: setGoal failed: ${err.message || err}`)
    }
    return true
  }

  /** Bring the bot in line with whichever lane is on top now. */
  _reconcile (before) {
    const after = this.top()
    if (after === before) {
      // Same driver (e.g. a lower lane released). Nothing to re-apply.
      return
    }
    // 1. Let go of what the previous driver pressed.
    if (before) for (const key of Object.keys(before.keys)) if (!after?.keys[key]) this._press(key, false)
    // 2. Pathfinder goal of the new driver (null when it has no opinion).
    //    Upstream setGoal() clears every control state, so keys come after.
    this._applyGoal(after && after.goal !== undefined ? after.goal : null, after?.dynamic)
    // 3. Keys of the new driver.
    if (after) this._pressAll(after)
    // 4. Tell whoever cares (the executor reports this to the model).
    if (before && before.active && after && after.priority > before.priority) {
      before.preempted = true
      this.emit('preempt', { lane: before.name, by: after.name, reason: after.reason })
    }
    if (after && after.preempted) {
      after.preempted = false
      this.emit('resume', { lane: after.name })
    }
  }

  // ------------------------------------------------------------ main hand

  /**
   * Borrow the main hand: equip `item`, run `fn`, then put back whatever was
   * held before. A second borrower is refused while any operation is in
   * flight (including higher priority); it can retry after release.
   *
   * @param {string} owner label for logs
   * @param {object} item inventory item to equip (null = keep current)
   * @param {() => Promise<any>} fn what to do while it is held
   * @param {{ priority?: number, dest?: string, restore?: boolean }} [opts]
   */
  async useHand (owner, item, fn, { priority = PRIORITY.task, dest = 'hand', restore = true } = {}) {
    // An async equip/use cannot be safely preempted: allowing a higher
    // priority borrower here overlaps both operations and the first restore
    // can overwrite the second item. The caller may retry after release.
    if (this._handBusy) return { ok: false, why: 'hand_busy' }
    const token = { owner, priority }
    this._handBusy = token
    const bot = this.bot
    const before = dest === 'hand' ? (bot.heldItem || null) : null
    try {
      if (item) await bot.equip(item, dest)
      const value = await fn()
      return { ok: true, value }
    } catch (err) {
      return { ok: false, why: String(err?.message || err).slice(0, 80) }
    } finally {
      if (restore && dest === 'hand' && item && before && before.name !== item.name) {
        try {
          const still = bot.inventory?.items?.().find((i) => i.name === before.name)
          if (still) await bot.equip(still, 'hand')
        } catch { /* best effort */ }
      }
      if (this._handBusy === token) this._handBusy = null
    }
  }
}

/**
 * Pass-through "hands" for callers that run without an arbiter (harness A,
 * unit tests): same interface as a Lane, applied straight to the bot.
 */
function directHands (bot, gate = null) {
  const allow = (cap) => (typeof gate === 'function' ? Boolean(gate(cap)?.ok) : true)
  return {
    name: 'direct',
    active: true,
    isTop: true,
    acquire () { return true },
    touch () { return true },
    release () {
      try { bot.pathfinder?.setGoal?.(null) } catch { /* pathfinder absent */ }
      try { for (const key of KEYS) bot.setControlState(key, false) } catch { /* gone */ }
      return true
    },
    setControlState (key, value) {
      if (value && !allow('move')) return false
      try { bot.setControlState(key, Boolean(value)) } catch { /* gone */ }
      return true
    },
    clearControlStates () { try { for (const key of KEYS) bot.setControlState(key, false) } catch { /* gone */ } },
    pulse (key, ms = 150) {
      try {
        bot.setControlState(key, true)
        setTimeout(() => { try { bot.setControlState(key, false) } catch { /* gone */ } }, ms)
      } catch { /* gone */ }
      return true
    },
    setGoal (goal, dynamic = false) {
      const next = goal === undefined ? null : goal
      if (next !== null && !allow('move')) return false
      try { bot.pathfinder?.setGoal?.(next, Boolean(dynamic)) } catch { /* pathfinder absent */ }
      return true
    }
  }
}

module.exports = { ControlArbiter, Lane, directHands, PRIORITY, KEYS }
