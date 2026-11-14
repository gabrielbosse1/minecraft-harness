/**
 * watchdog.js — says what froze, when something freezes.
 *
 * The bot is one JavaScript thread. If that thread is held for seconds (a
 * runaway loop, a synchronous disk write on a card that stopped answering) it
 * reads nothing from the server, misses the keep-alive and the link drops with
 * "client timed out" — a message that is identical when the SERVER is the one
 * that stopped sending. The log could not tell the two apart, and could not
 * say which code was running.
 *
 * Two independent measurements, both cheap:
 *
 *   1. The loop. A timer ticks every `beatMs`; how late it fires is how long
 *      the thread was held. A small worker thread watches the same beat from
 *      outside, and when it stops for `stackAfterMs` it asks V8 (through the
 *      inspector, which interrupts running JavaScript) for the main thread's
 *      call stack. The stall is then logged with the function that caused it.
 *      If the thread never comes back, the worker writes the stack to stderr
 *      itself, so even a permanent hang leaves a line.
 *
 *   2. The link. `traffic()` is called for every packet from the server. When
 *      nothing arrives for `silentMs` while the loop itself is fine, that is
 *      logged as what it is: the server (or the network) went quiet.
 *
 * Nothing here changes behaviour; it only reports. ZINCAI_WATCHDOG=0 turns it
 * off, ZINCAI_WATCHDOG_STACK=0 keeps the timer but not the worker.
 */
'use strict'

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads')

const WORKER_FLAG = 'zincaiLoopWatchdog'
/** A clock that a time sync cannot move: a jump of the wall clock is not a stall. */
const monotonic = () => performance.now()

// ------------------------------------------------------------ worker side --
function runWorker () {
  const inspector = require('node:inspector')
  const fs = require('node:fs')
  const beat = new Int32Array(workerData.sab)
  const { stackAfterMs, hangAfterMs, pollMs } = workerData
  let last = Atomics.load(beat, 0)
  let lastAt = monotonic()
  let captured = null // frames of the stall in progress
  let capturing = false
  let hangReported = false

  const short = (url) => String(url || '').replace(/^file:\/\//, '').split('/').slice(-2).join('/')

  const capture = () => {
    capturing = true
    const scripts = new Map()
    let session
    const done = (frames) => {
      capturing = false
      captured = frames || []
      try { parentPort.postMessage({ type: 'stack', frames: captured, afterMs: monotonic() - lastAt }) } catch { /* main is gone */ }
    }
    try {
      session = new inspector.Session()
      session.connectToMainThread()
    } catch { return done(null) }
    // If the pause never lands (the thread is inside native code that does not
    // return), give up on the stack rather than hold the session open.
    const giveUp = setTimeout(() => { try { session.disconnect() } catch { /* noop */ } done(null) }, 8000)
    session.on('Debugger.scriptParsed', (m) => { if (m.params?.url) scripts.set(m.params.scriptId, m.params.url) })
    session.on('Debugger.paused', (m) => {
      clearTimeout(giveUp)
      const frames = (m.params?.callFrames || []).slice(0, 10).map((f) => {
        const url = f.url || scripts.get(f.location?.scriptId) || ''
        return `${f.functionName || '(anonymous)'} (${short(url)}:${(f.location?.lineNumber ?? -1) + 1})`
      })
      // Resume FIRST: nothing below may leave the main thread paused. Closing
      // the session detaches the debugger, which resumes too — the fallback
      // if the resume itself cannot be posted.
      const close = () => { try { session.disconnect() } catch { /* noop */ } }
      try {
        session.post('Debugger.resume', () => { try { session.post('Debugger.disable', close) } catch { close() } })
      } catch { close() }
      done(frames)
    })
    session.post('Debugger.enable', (err) => {
      if (err) { clearTimeout(giveUp); try { session.disconnect() } catch { /* noop */ } return done(null) }
      session.post('Debugger.pause')
    })
  }

  setInterval(() => {
    const v = Atomics.load(beat, 0)
    if (v !== last) {
      last = v
      lastAt = monotonic()
      captured = null
      hangReported = false
      return
    }
    const held = monotonic() - lastAt
    if (held >= stackAfterMs && !captured && !capturing) capture()
    if (held >= hangAfterMs && !hangReported && !capturing) {
      hangReported = true
      // The main thread cannot log: write straight to the descriptor.
      const where = captured && captured.length ? captured.join(' < ') : 'stack not available'
      try { fs.writeSync(2, `${new Date().toISOString()} [error] zincai watchdog: the bot's main thread has not run for ${Math.round(held / 1000)}s and is STILL blocked — in: ${where}\n`) } catch { /* nothing to write to */ }
    }
  }, pollMs)
}
if (!isMainThread && workerData && workerData[WORKER_FLAG]) runWorker()

// -------------------------------------------------------------- main side --
class LoopWatchdog {
  /**
   * @param {{ log?: (level:string, msg:string)=>void, beatMs?: number, warnMs?: number,
   *           stackAfterMs?: number, hangAfterMs?: number, silentMs?: number,
   *           stack?: boolean, now?: ()=>number }} [opts]
   */
  constructor ({ log = () => {}, beatMs = 250, warnMs = 1500, stackAfterMs = 1000, hangAfterMs = 12_000, silentMs = 10_000, stack = true, now = monotonic } = {}) {
    this.log = log
    this.beatMs = beatMs
    this.warnMs = warnMs
    this.stackAfterMs = Math.min(stackAfterMs, warnMs)
    this.hangAfterMs = hangAfterMs
    this.silentMs = silentMs
    this.wantStack = stack
    this.now = now
    this.stats = { stalls: 0, worstMs: 0, lastStallAt: 0, lastStack: '', silences: 0, worstSilenceMs: 0 }
    this._timer = null
    this._worker = null
    this._beat = null
    this._lastBeatAt = 0
    this._pendingStack = null
    this._link = null // { lastAt, warnedAt } while a session is connected
  }

  start () {
    if (this._timer) return this
    this._lastBeatAt = this.now()
    if (this.wantStack) this._startWorker()
    this._timer = setInterval(() => this._tick(), this.beatMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
    return this
  }

  _startWorker () {
    try {
      const sab = new SharedArrayBuffer(4)
      this._beat = new Int32Array(sab)
      this._worker = new Worker(__filename, {
        workerData: { [WORKER_FLAG]: true, sab, stackAfterMs: this.stackAfterMs, hangAfterMs: this.hangAfterMs, pollMs: Math.max(50, Math.min(250, Math.round(this.stackAfterMs / 4))) }
      })
      this._worker.unref()
      this._worker.on('message', (m) => { if (m?.type === 'stack') this._pendingStack = { frames: m.frames || [], at: this.now() } })
      // A watchdog that cannot run is not worth a crash, or a second log line.
      this._worker.on('error', () => { this._worker = null; this._beat = null })
    } catch { this._worker = null; this._beat = null }
  }

  _tick () {
    const now = this.now()
    const late = now - this._lastBeatAt - this.beatMs
    this._lastBeatAt = now
    if (this._beat) Atomics.add(this._beat, 0, 1)
    if (late >= this.warnMs) {
      this.stats.stalls++
      this.stats.worstMs = Math.max(this.stats.worstMs, late)
      this.stats.lastStallAt = now
      // The stack message was posted while this thread was held; it is
      // delivered on the turn of the loop that follows this timer.
      setTimeout(() => this._report(late), 20)
      // Whatever the server sent during the stall is only being read now:
      // that gap is ours, not the server's.
      if (this._link) this._link.lastAt = now
      return
    }
    this._checkLink(now)
  }

  _report (late) {
    const stack = this._pendingStack
    this._pendingStack = null
    const where = stack && stack.frames.length ? stack.frames.join(' < ') : ''
    this.stats.lastStack = where
    this.log('warn', `the bot's own thread was blocked for ${(late / 1000).toFixed(1)}s — nothing was read from the server or sent to it meanwhile${where ? `. It was in: ${where}` : ' (no stack captured)'}`)
  }

  // ---- the link ----

  /** A session is connected: start judging silence from now. */
  linkUp () { this._link = { lastAt: this.now(), warnedAt: 0 } }
  linkDown () { this._link = null }

  /** Call for every packet received from the server. */
  traffic () {
    const link = this._link
    if (!link) return
    const now = this.now()
    if (link.warnedAt) {
      const gap = now - link.lastAt
      this.stats.worstSilenceMs = Math.max(this.stats.worstSilenceMs, gap)
      this.log('info', `the server is sending again after ${(gap / 1000).toFixed(1)}s of silence`)
      link.warnedAt = 0
    }
    link.lastAt = now
  }

  _checkLink (now) {
    const link = this._link
    if (!link || link.warnedAt) return
    const quiet = now - link.lastAt
    if (quiet < this.silentMs) return
    link.warnedAt = now
    this.stats.silences++
    this.log('warn', `nothing has arrived from the server for ${Math.round(quiet / 1000)}s while the bot itself is running normally — the server or the connection has stalled (not the bot). The link is dropped if no keep-alive comes in time.`)
  }

  /** One line for `status`. */
  describe () {
    const s = this.stats
    if (!this._timer) return 'watchdog off'
    const parts = [s.stalls ? `${s.stalls} stall${s.stalls === 1 ? '' : 's'} of the bot's thread (worst ${(s.worstMs / 1000).toFixed(1)}s)` : 'no stalls of the bot\'s thread']
    parts.push(s.silences ? `${s.silences} server silence${s.silences === 1 ? '' : 's'}${s.worstSilenceMs ? ` (worst ${(s.worstSilenceMs / 1000).toFixed(1)}s)` : ''}` : 'no server silences')
    return parts.join('; ')
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
    const w = this._worker
    this._worker = null
    this._beat = null
    this._link = null
    if (w) { try { w.terminate() } catch { /* already gone */ } }
  }
}

/** Is the watchdog wanted at all? (`ZINCAI_WATCHDOG=0` turns it off.) */
function watchdogEnabled (env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.ZINCAI_WATCHDOG ?? '').trim())
}
function stackEnabled (env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.ZINCAI_WATCHDOG_STACK ?? '').trim())
}

module.exports = { LoopWatchdog, watchdogEnabled, stackEnabled }
