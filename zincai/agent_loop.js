/**
 * agent_loop.js — the loop that keeps the agent alive, so a drop is a pause in
 * its work rather than the end of it.
 *
 * WHY THIS EXISTS
 *   Everything needed to survive a kick already existed, in separate pieces:
 *   ConnectionManager retries with back-off, DeathRecovery respawns, goals
 *   suspend and resume, the watchdog now explains the cause. What was missing
 *   was the thing that WATCHES those pieces and acts — something has to notice
 *   "the link has been down for two minutes and the retry budget is untouched",
 *   "the process is up but the heartbeat stopped", "the loop is stalling every
 *   few seconds", and do the one safe thing.
 *
 *   This is that loop. It is a supervisor, not a planner: it never decides what
 *   the agent wants, only that the agent is still ABLE to want it. Every action
 *   it takes is one the operator could have typed (restart-connection, join,
 *   pause, shutdown) — it automates the reflex, it does not add policy.
 *
 * WHAT IT DOES, IN ORDER OF ESCALATION
 *   1. link down and nothing scheduled  → re-arm the retry (a stuck RECONNECTING
 *      state, an exhausted budget that a stable link had already reset)
 *   2. link down too long               → `restart-connection` (drops the stale
 *      socket, rebuilds the session) rather than waiting out the back-off
 *   3. connected but the body is silent  → not a kick: report it, do not thrash
 *   4. loop stalling repeatedly          → one warning, with the count, so the
 *      operator sees "this is a CPU/GC problem" instead of a kick
 *   5. repeated drops in a short window  → a crash loop. Stop retrying, say so.
 *      Reconnecting forever into a server that rejects you is worse than down:
 *      it hides the cause and hammers the server.
 *
 * Pure scheduling: timers are injected, every timestamp comes from `now`, and
 * the module never imports mineflayer or touches the socket. That is what makes
 * a 10-minute failure sequence testable in milliseconds.
 */
'use strict'

/**
 * @typedef {{
 *   state?: string, paused?: boolean, dead?: boolean, alive?: boolean,
 *   lastError?: string|null, nextRetryAt?: number|null, attempts?: number
 * }} LinkSnapshot
 */

class AgentLoop {
  /**
   * @param {{
   *   config: import('./runtime_config').RuntimeConfig,
   *   connection: { snapshot: () => LinkSnapshot, join?: Function, restart?: Function, rejoin?: Function },
   *   watchdog?: import('./watchdog').LinkWatchdog|null,
   *   logger?: (level:string,msg:string)=>void,
   *   now?: () => number,
   *   setInterval?: Function, clearInterval?: Function,
   *   isProcessHealthy?: () => boolean,
   *   onStallStorm?: (info:{count:number,maxMs:number})=>void,
   *   onCrashLoop?: (info:{drops:number,windowMs:number,lastError:string|null})=>void
   * }} opts
   */
  constructor ({
    config,
    connection,
    watchdog = null,
    logger = () => {},
    now = () => Date.now(),
    setInterval: setIv = setInterval,
    clearInterval: clearIv = clearInterval,
    isProcessHealthy = () => true,
    onStallStorm = null,
    onCrashLoop = null
  }) {
    this.config = config
    this.connection = connection
    this.watchdog = watchdog
    this.log = logger
    this.now = now
    this.setInterval = setIv
    this.clearInterval = clearIv
    this.isProcessHealthy = isProcessHealthy
    this.onStallStorm = onStallStorm
    this.onCrashLoop = onCrashLoop

    this.timer = null
    this.running = false
    this.ticks = 0
    /** Times the loop re-armed a link that was down with nothing scheduled. */
    this.revives = 0
    /** Times the loop forced a restart instead of waiting out the back-off. */
    this.restarts = 0
    /** null = never warned. 0 would look like "warned at time zero". */
    this.stallWarnedAt = null
    /** Drop timestamps inside the crash-loop window. */
    this.drops = []
    this.crashLoop = false
    this.stopped = false
    /** Actions taken, newest last — the honest audit trail of a self-healing run. */
    this.actions = []
  }

  intervalMs () {
    const v = this.config ? Number(this.config.get('agent.intervalMs')) : NaN
    return Number.isFinite(v) && v >= 1_000 ? v : 15_000
  }

  /** Is the loop allowed to force a reconnect? Off by default is wrong here: the point is survival. */
  enabled () {
    if (!this.config) return true
    return this.config.get('agent.surviveKicks') !== false
  }

  start () {
    if (this.running) return false
    this.running = true
    this.timer = this.setInterval(() => this.tick(), this.intervalMs())
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
    this.log('info', `agent loop: every ${Math.round(this.intervalMs() / 1000)}s, survives kicks=${this.enabled() ? 'yes' : 'no'}`)
    return true
  }

  stop () {
    this.running = false
    if (this.timer !== null) {
      try { this.clearInterval(this.timer) } catch { /* already gone */ }
      this.timer = null
    }
  }

  _act (what, detail = '') {
    const entry = { at: this.now(), what, detail }
    this.actions.push(entry)
    if (this.actions.length > 40) this.actions.shift()
    this.log('warn', `agent loop: ${what}${detail ? ` (${detail})` : ''}`)
    return entry
  }

  /**
   * One pass. Public and side-effect-explicit so a test can drive it without
   * timers.
   * @returns {{ acted: boolean, actions: string[], cause: string|null }}
   */
  tick () {
    this.ticks += 1
    const out = { acted: false, actions: [], cause: null }
    if (this.stopped) return out
    const snap = this.connection.snapshot() || {}
    const now = this.now()

    // ---- 1. the process itself: a stuck tick is not a connection problem ----
    let healthy = true
    try { healthy = this.isProcessHealthy() !== false } catch { healthy = true }
    if (!healthy) {
      out.cause = 'process-stalled'
      if (this.stallWarnedAt === null || now - this.stallWarnedAt > 60_000) {
        this.stallWarnedAt = now
        this._act('process looks wedged', 'the heartbeat has not advanced; not touching the link while the loop may be blocked')
      }
      out.acted = true
      out.actions.push('process-stalled')
      return out
    }

    // ---- 2. a crash loop is the one case where stopping is the right move ----
    const lastEnd = this.watchdog ? this.watchdog.ends[this.watchdog.ends.length - 1] : null
    if (lastEnd && (!this._lastSeenEnd || this._lastSeenEnd.at !== lastEnd.at)) {
      this._lastSeenEnd = lastEnd
      this.drops.push(lastEnd.at)
      const windowMs = Number(this.config?.get('agent.crashLoopWindowMs')) || 300_000
      this.drops = this.drops.filter((t) => now - t <= windowMs)
      const limit = Number(this.config?.get('agent.crashLoopDrops')) || 6
      if (this.drops.length >= limit && !this.crashLoop) {
        this.crashLoop = true
        out.cause = 'crash-loop'
        this._act(`crash loop: ${this.drops.length} drops in ${Math.round(windowMs / 60000)} min`, lastEnd.cause || 'unknown')
        try { this.onCrashLoop?.({ drops: this.drops.length, windowMs, lastError: snap.lastError || null }) } catch { /* best effort */ }
        out.acted = true
        out.actions.push('crash-loop')
        return out
      }
    }
    if (this.crashLoop) {
      // Recovery is explicit: the operator's `update`, `join` or a successful
      // connection clears it. Until then, do not reconnect on their behalf.
      if (snap.state === 'CONNECTED') {
        this.crashLoop = false
        this.drops = []
      } else {
        out.cause = 'crash-loop'
        return out
      }
    }

    if (!this.enabled()) {
      out.cause = 'survival-off'
      return out
    }

    // ---- 3. the link is down: re-arm it, and force it if it has been too long --
    const down = snap.state === 'ERROR' || snap.state === 'DISCONNECTED' || snap.state === 'RECONNECTING'
    if (down) {
      if (snap.paused === true) { out.cause = 'paused'; return out }
      const pendingRetry = Number.isFinite(Number(snap.nextRetryAt)) && Number(snap.nextRetryAt) > 0
      // 3a. Nothing scheduled: the retry budget was exhausted, auto-reconnect was
      //     toggled while a timer was pending, or policyChanged() dropped the
      //     timer. Any of those leaves the manager parked in ERROR/RECONNECTING
      //     with no nextRetryAt — alive, idle, and never trying again. That is a
      //     terminal state the operator would otherwise only find by reading the
      //     log, so the loop re-arms it.
      const parked = (snap.state === 'ERROR' || snap.state === 'RECONNECTING') && !pendingRetry
      if (parked) {
        this.revives += 1
        this._act('link is down with no retry scheduled — re-arming it', String(snap.lastError || '').slice(0, 100))
        try { this.connection.restart ? this.connection.restart({ reason: 'agent loop: revive' }) : this.connection.join?.({ reason: 'agent loop: revive' }) } catch (err) { this.log('debug', `agent loop: revive failed: ${err?.message || err}`) }
        out.acted = true
        out.actions.push('revive')
        out.cause = 'link-down'
        return out
      }
      // 3b. Down for too long and the back-off keeps growing: a stale socket is
      //     the usual reason, and rebuilding it is cheap and safe.
      // `since` is a timestamp and 0 is a legal one (a clock that starts at
      // zero, a link opened at process start). Test for absence, not falsiness.
      const downFor = Number.isFinite(Number(snap.since)) ? now - Number(snap.since) : 0
      const forceAfter = Number(this.config?.get('agent.forceRestartAfterMs')) || 180_000
      if (downFor >= forceAfter && snap.state !== 'RECONNECTING') {
        this.restarts += 1
        this._act(`link down ${Math.round(downFor / 1000)}s — forcing a fresh connection`, `attempts=${snap.attempts ?? 0}`)
        try { this.connection.restart?.({ reason: 'agent loop: force restart' }) } catch (err) { this.log('debug', `agent loop: restart failed: ${err?.message || err}`) }
        out.acted = true
        out.actions.push('restart')
        out.cause = 'link-down'
        return out
      }
      out.cause = 'link-down'
      return out
    }

    // ---- 4. connected, but the loop is the problem -------------------------
    if (this.watchdog) {
      const w = this.watchdog.snapshot()
      const stormMs = Number(this.config?.get('agent.stallStormMs')) || 1_000
      const sinceLast = this.stallWarnedAt === null ? Infinity : now - this.stallWarnedAt
      if (w.maxStallMs >= stormMs && sinceLast > 120_000) {
        this.stallWarnedAt = now
        out.cause = 'loop-stall'
        this._act(`event loop stalled ${Math.round(w.maxStallMs)}ms — this WILL be reported as a keepalive timeout if it keeps happening`)
        try { this.onStallStorm?.({ count: this.watchdog.stalls.length, maxMs: w.maxStallMs }) } catch { /* best effort */ }
        out.acted = true
        out.actions.push('stall-warning')
        return out
      }
    }

    out.cause = snap.state === 'CONNECTED' ? null : 'idle'
    return out
  }

  /** One line for `status`: is the supervisor happy? */
  summary () {
    if (this.crashLoop) return `crash loop — NOT reconnecting (${this.drops.length} drops); fix the cause, then join`
    const bits = [`${this.ticks} ticks`, `${this.revives} revived`, `${this.restarts} forced`]
    return bits.join(', ')
  }

  snapshot () {
    return {
      running: this.running,
      intervalMs: this.intervalMs(),
      enabled: this.enabled(),
      ticks: this.ticks,
      revives: this.revives,
      restarts: this.restarts,
      crashLoop: this.crashLoop,
      drops: this.drops.length,
      actions: this.actions.slice(-8)
    }
  }
}

module.exports = { AgentLoop }
