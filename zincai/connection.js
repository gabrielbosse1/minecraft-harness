/**
 * connection.js — the Minecraft link as its own subsystem.
 *
 * WHY THIS EXISTS
 *   Before this module the link lived inside the session: a dropped socket
 *   destroyed the session, and `main()` scheduled a brand-new one from a
 *   `setTimeout`. That had three consequences the operator could not see or
 *   steer:
 *
 *     - "disconnected" was not a state anyone could query, so `status` could
 *       not distinguish "the server is down" from "the bot is wedged";
 *     - the only way to force a reconnect was to kill the Node.js process;
 *     - the retry policy (back-off, attempt ceiling) was buried in
 *       src/reconnect.js and could not be inspected or changed at runtime.
 *
 *   Here the link is an explicit state machine with six states:
 *
 *     DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTING → DISCONNECTED
 *                          ↑            │
 *                          └── RECONNECTING ←── ERROR
 *
 *   The Node.js process, its runtime configuration, its memory, its goals and
 *   the control interface all outlive every state. While the link is down no
 *   physical action can be issued (the boundary refuses: "not connected"), the
 *   world snapshot is marked stale, and no event is invented to fill the gap.
 *
 *   Joining goes through a factory (`createSession`) that returns a disposable
 *   session. Every join builds a fresh one, and the previous one is disposed
 *   first, so listeners can never be registered twice.
 *
 * Pure scheduling + a state machine: no mineflayer import, no I/O.
 */
'use strict'

const { EventEmitter } = require('events')
const { asLogger } = require('./runtime_config')

const STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR'
})

/** A link that lived this long is "stable": the attempt counter starts over. */
const STABLE_AFTER_MS = 60_000

/**
 * Errors a retry cannot fix. The first join already refuses to retry at all;
 * these also stop a loop *after* a successful session.
 */
const FATAL_RE = /white-?list|banned|not allowed|invalid session|verify username|outdated (client|server)|incompatible|logged in from another location|duplicate login|name .*taken|authentication|auth failed|invalid credentials/i

class ConnectionManager extends EventEmitter {
  /**
   * @param {{
   *   createSession: (hooks: object) => { dispose: (quit?: boolean) => void, bot?: object, isSpawned?: () => boolean },
   *   config: import('./runtime_config').RuntimeConfig,
   *   logger?: (level:string,msg:string)=>void,
   *   now?: () => number,
   *   setTimer?: (fn:Function, ms:number)=>any,
   *   clearTimer?: (handle:any)=>void,
   *   wasEverConnected?: boolean
   * }} opts
   */
  constructor ({
    createSession,
    config,
    logger = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t },
    clearTimer = (h) => clearTimeout(h),
    wasEverConnected = false
  }) {
    super()
    this.createSession = createSession
    this.config = config
    this.log = asLogger(logger)
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer

    this.state = STATES.DISCONNECTED
    this.stateSince = now()
    this.session = null
    this.bot = null
    /** Was there EVER a successful spawn? A failure before that is fatal. */
    this.everConnected = Boolean(wasEverConnected)
    this.connectingSince = 0
    this.connectedAt = 0
    this.attempts = 0
    this.lastError = null
    this.lastEnd = null
    this.retryTimer = null
    this.nextRetryAt = null
    /** True when the operator asked to be away (leave) or the link is shutting down. */
    this.detached = false
    this.destroyed = false
    /** Monotonic counter: one per session, so a late hook cannot act on a new one. */
    this.epoch = 0
    this.history = []
  }

  // --------------------------------------------------------------- states --

  isConnected () { return this.state === STATES.CONNECTED }
  isTransitioning () { return this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING || this.state === STATES.DISCONNECTING }

  /** Why a physical action may not be issued because of the link, or null. */
  physicalRefusal () {
    if (this.state === STATES.CONNECTED) return null
    return 'not connected to the server'
  }

  _transition (to, detail = '') {
    const from = this.state
    if (from === to) return
    this.state = to
    this.stateSince = this.now()
    const entry = { at: this.stateSince, from, to, detail: String(detail || '').slice(0, 160) }
    this.history.push(entry)
    if (this.history.length > 40) this.history.shift()
    this.emit('state', entry)
    this.log('info', `link ${from} → ${to}${detail ? ` (${detail})` : ''}`)
  }

  // ----------------------------------------------------------------- join --

  /**
   * Join (or re-join) the configured server.
   * @param {{ reason?: string, manual?: boolean }} [opts]
   * @returns {{ ok: boolean, state: string, why?: string }}
   */
  join ({ reason = 'join', manual = false } = {}) {
    if (this.destroyed) return { ok: false, state: this.state, why: 'the link manager is shut down' }
    if (this.state === STATES.CONNECTED) return { ok: true, state: this.state, why: 'already connected' }
    if (this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) {
      return { ok: false, state: this.state, why: 'a connection attempt is already in flight' }
    }
    this._cancelRetry()
    this.detached = false
    // A fresh attempt gets a fresh epoch: hooks from an older session are ignored.
    this.epoch++
    const epoch = this.epoch
    this._transition(STATES.CONNECTING, reason)
    this.connectingSince = this.now()
    try {
      const session = this.createSession({
        epoch,
        onSpawn: () => this._spawned(epoch),
        onEnded: (info) => this._ended(epoch, info)
      })
      this.session = session || null
      this.bot = session?.bot || null
      if (session && typeof session.isSpawned === 'function' && session.isSpawned()) this._spawned(epoch)
      return { ok: true, state: this.state }
    } catch (err) {
      const text = String(err?.message || err).slice(0, 200)
      this.session = null
      this.bot = null
      this._fail(text, { manual })
      return { ok: false, state: this.state, why: text }
    }
  }

  /** Called by the session when the bot spawned (first join or a respawn). */
  _spawned (epoch) {
    if (epoch !== this.epoch || this.destroyed) return
    const wasAttempt = this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING
    this.everConnected = true
    this.connectedAt = this.now()
    if (this.state !== STATES.CONNECTED) this._transition(STATES.CONNECTED, wasAttempt ? 'spawned' : 'respawned')
    this.emit('spawn', { epoch, at: this.connectedAt })
  }

  /** Operator `leave`: drop the link but keep the process and the interface. */
  leave ({ reason = 'left by operator', manual = true } = {}) {
    this.detached = true
    this._cancelRetry()
    if (!this.session) {
      if (this.state !== STATES.DISCONNECTED) this._transition(STATES.DISCONNECTED, reason)
      return { ok: true, state: this.state, already: true }
    }
    this._transition(STATES.DISCONNECTING, reason)
    const session = this.session
    this.session = null
    this.bot = null
    this.epoch++
    this.connectedAt = 0
    try { session.dispose(true) } catch (err) { this.log('debug', `leave: dispose failed: ${err?.message || err}`) }
    this._transition(STATES.DISCONNECTED, reason)
    this.attempts = 0
    this.emit('leave', { reason, manual })
    return { ok: true, state: this.state }
  }

  /** Operator `join` after a `leave`: the operator's request re-arms the link. */
  rejoin ({ reason = 'joined by operator' } = {}) {
    this.detached = false
    this.attempts = 0
    return this.join({ reason, manual: true })
  }

  /**
   * Drop and rebuild the link without touching the Node.js process.
   *
   * Also the recovery path for a manager parked in RECONNECTING with no timer:
   * that state used to refuse every join with "an attempt is already in flight"
   * even though nothing was in flight, so nothing could ever retry it. A restart
   * clears the state first — that is what "restart" means.
   */
  restart ({ reason = 'restart-connection' } = {}) {
    this.detached = false
    this._cancelRetry()
    // A pending retry that was cancelled leaves the state machine parked in
    // RECONNECTING. There is no attempt in flight, so do not claim there is one.
    if (this.state === STATES.RECONNECTING && this.retryTimer === null) {
      this._transition(STATES.DISCONNECTED, `${reason}: clearing a parked retry`)
    }
    if (this.session) {
      this._transition(STATES.DISCONNECTING, reason)
      const session = this.session
      this.session = null
      this.bot = null
      this.epoch++
      try { session.dispose(true) } catch (err) { this.log('debug', `restart: dispose failed: ${err?.message || err}`) }
      this._transition(STATES.DISCONNECTED, reason)
    }
    this.attempts = 0
    return this.join({ reason, manual: true })
  }

  // ------------------------------------------------------------- failures --

  /**
   * The session announced that its link is over.
   * @param {{ kind?: string, text?: string, spawned?: boolean, fatal?: boolean }} info
   */
  _ended (epoch, info = {}) {
    if (epoch !== this.epoch || this.destroyed) return false
    const kind = String(info.kind || 'end')
    const text = String(info.text || '').slice(0, 200)
    // The session that ended is not reusable, whatever its state says.
    this.session = null
    this.bot = null
    this.epoch++
    this.lastEnd = { at: this.now(), kind, text }
    this.emit('ended', { kind, text, spawned: Boolean(info.spawned || this.everConnected) })

    if (this.detached) {
      this._transition(STATES.DISCONNECTED, `link closed (${kind})`)
      return true
    }
    // A stable link that drops starts its retry budget over, so a server that
    // restarts once a day does not exhaust the attempt ceiling.
    if (this.connectedAt && this.now() - this.connectedAt > STABLE_AFTER_MS) this.attempts = 0
    this.connectedAt = 0
    return this._fail(`${kind}${text ? `: ${text}` : ''}`, { manual: false })
  }

  /**
   * Record a failure and decide whether to retry.
   * @returns {boolean} true when a retry was scheduled
   */
  _fail (text, { manual = false } = {}) {
    this.lastError = String(text || 'connection failed').slice(0, 200)
    this._transition(STATES.ERROR, this.lastError)
    // 1. Never joined at all → fatal. A whitelist rejection, a wrong host or bad
    //    credentials must not become a reconnect loop, and no retry can fix it.
    if (!this.everConnected) {
      this.log('error', `fatal: join rejected before the first spawn (${this.lastError}) — not retrying`)
      this.emit('fatal', { reason: 'join-failed', text: this.lastError })
      return false
    }
    // 2. An error a retry cannot fix.
    if (FATAL_RE.test(this.lastError)) {
      this.log('error', `fatal: ${this.lastError} — retrying cannot fix this`)
      this.emit('fatal', { reason: 'fatal-error', text: this.lastError })
      return false
    }
    // 3. Automatic reconnection turned off.
    if (!this.config.get('connection.autoReconnect')) {
      this.log('warn', `link down (${this.lastError}); automatic reconnection is off (connection.autoReconnect)`)
      this._transition(STATES.DISCONNECTED, 'auto reconnect off')
      this.emit('sleep', { reason: 'auto-reconnect-off' })
      return false
    }
    // 4. Attempt ceiling.
    const maxRetries = Number(this.config.get('connection.maxRetries'))
    this.attempts += 1
    if (this.attempts > maxRetries) {
      this.log('error', `giving up after ${maxRetries} reconnection attempts (${this.lastError})`)
      this.emit('fatal', { reason: 'retries-exhausted', text: this.lastError })
      this._transition(STATES.DISCONNECTED, 'retries exhausted')
      return false
    }
    // 5. Exponential back-off bounded by the configured floor/ceiling, so the
    //    maximum retry frequency is a parameter and never a tight loop.
    const base = Number(this.config.get('connection.retryDelayMs'))
    const floor = Number(this.config.get('connection.minRetryDelayMs'))
    const ceiling = Number(this.config.get('connection.maxRetryDelayMs'))
    const delayMs = Math.max(floor, Math.min(ceiling, base * 2 ** Math.min(8, this.attempts - 1)))
    this._scheduleRetry(delayMs)
    return true
  }

  _scheduleRetry (delayMs) {
    this._cancelRetry()
    // Clamp at the single place that schedules, so no caller (including the
    // public policyChanged) can turn the back-off into a tight loop.
    const floor = Number(this.config.get('connection.minRetryDelayMs'))
    const ceiling = Number(this.config.get('connection.maxRetryDelayMs'))
    delayMs = Math.max(floor, Math.min(ceiling, Number(delayMs) || floor))
    this.nextRetryAt = this.now() + delayMs
    this._transition(STATES.RECONNECTING, `retry ${this.attempts} in ${Math.round(delayMs / 1000)}s`)
    this.log('warn', `reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${this.attempts}/${this.config.get('connection.maxRetries')})`)
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null
      this.nextRetryAt = null
      if (this.destroyed || this.detached) return
      if (!this.config.get('connection.autoReconnect')) return
      this.join({ reason: `auto retry ${this.attempts}` })
    }, delayMs)
  }

  _cancelRetry () {
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
    this.nextRetryAt = null
  }

  /**
   * Reconnection settings changed: restart the pending timer with the new
   * policy instead of waiting out the old delay.
   */
  policyChanged () {
    if (this.state !== STATES.RECONNECTING || this.retryTimer === null) return false
    if (!this.config.get('connection.autoReconnect')) {
      this._cancelRetry()
      this._transition(STATES.DISCONNECTED, 'auto reconnect turned off')
      return true
    }
    const base = Number(this.config.get('connection.retryDelayMs'))
    const floor = Number(this.config.get('connection.minRetryDelayMs'))
    const ceiling = Number(this.config.get('connection.maxRetryDelayMs'))
    const delayMs = Math.max(floor, Math.min(ceiling, base * 2 ** Math.min(8, Math.max(0, this.attempts - 1))))
    this._scheduleRetry(delayMs)
    return true
  }

  /** Status for the `status`/`help` output and the prompts. */
  snapshot () {
    return {
      state: this.state,
      since: this.stateSince,
      everConnected: this.everConnected,
      attempts: this.attempts,
      maxRetries: Number(this.config.get('connection.maxRetries')),
      autoReconnect: this.config.get('connection.autoReconnect') === true,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      connectedForMs: this.connectedAt ? this.now() - this.connectedAt : 0,
      detached: this.detached,
      history: this.history.slice(-6)
    }
  }

  /** Shut the link down for good (process shutdown). */
  destroy ({ quit = true } = {}) {
    this.destroyed = true
    this.detached = true
    this._cancelRetry()
    const session = this.session
    this.session = null
    this.bot = null
    this.epoch++
    if (session) { try { session.dispose(quit) } catch { /* already gone */ } }
    if (this.state !== STATES.DISCONNECTED) this._transition(STATES.DISCONNECTED, 'shutdown')
  }
}

module.exports = { ConnectionManager, STATES, FATAL_RE, STABLE_AFTER_MS }
