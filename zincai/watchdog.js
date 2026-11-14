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
 * Three independent measurements, all cheap:
 *
 *   1. The loop. A timer ticks every `beatMs`; how late it fires is how long
 *      the thread was held. A small worker thread watches the same beat from
 *      outside, and when it stops for `stackAfterMs` it asks V8 (through the
 *      inspector, which interrupts running JavaScript) for the main thread's
 *      call stack. The stall is then logged with the function that caused it.
 *      If the thread never comes back, the worker writes the stack to stderr
 *      itself, so even a permanent hang leaves a line.
 *
 *   2. The link. `packet()` is called for every packet from the server. When
 *      nothing arrives for `silentMs` while the loop itself is fine, that is
 *      logged as what it is: the server (or the network) went quiet.
 *
 *   3. The protocol. Each inbound keep-alive and the exact ID written back are
 *      recorded. At a timeout we can therefore distinguish four very different
 *      failures: our thread was blocked; the whole server/TCP stream stopped;
 *      ordinary packets continued but the server stopped its keep-alive stream;
 *      or the client failed to echo the challenge. "localhost" only removes a
 *      long network path — it does not prevent either process from stalling.
 *
 * Nothing here changes behaviour; it only reports. ZINCAI_WATCHDOG=0 turns it
 * off, ZINCAI_WATCHDOG_STACK=0 keeps the timer but not the worker.
 */
'use strict'

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads')

const WORKER_FLAG = 'zincaiLoopWatchdog'
/** A clock that a time sync cannot move: a jump of the wall clock is not a stall. */
const monotonic = () => performance.now()

/** ProtoDef represents an i64 as an Array subclass whose valueOf() is BigInt. */
function idText (value) {
  try {
    const primitive = value != null && typeof value.valueOf === 'function' ? value.valueOf() : value
    return String(primitive)
  } catch { return String(value) }
}

const TIMEOUT_RE = /client timed out|keepalive(?:error|timeout)|keep-alive|timed? out|disconnect\.timeout/i

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
  constructor ({ log = () => {}, beatMs = 250, warnMs = 1500, stackAfterMs = 1000, hangAfterMs = 12_000, silentMs = 25_000, stack = true, now = monotonic } = {}) {
    this.log = log
    this.beatMs = beatMs
    this.warnMs = warnMs
    this.stackAfterMs = Math.min(stackAfterMs, warnMs)
    this.hangAfterMs = hangAfterMs
    // A vanilla server normally emits a keep-alive every 15 seconds. The old
    // 10-second threshold therefore called an idle, healthy server "silent"
    // before its next expected keep-alive. 25 seconds means genuinely late.
    this.silentMs = silentMs
    this.wantStack = stack
    this.now = now
    this.stats = {
      stalls: 0,
      worstMs: 0,
      lastStallAt: 0,
      lastStack: '',
      silences: 0,
      worstSilenceMs: 0,
      keepAlives: 0,
      keepAliveReplies: 0,
      replyMismatches: 0,
      worstKeepAliveGapMs: 0,
      timeouts: 0,
      lastTimeoutCause: ''
    }
    this._timer = null
    this._worker = null
    this._beat = null
    this._lastBeatAt = 0
    this._lastStall = null
    this._pendingStack = null
    this._link = null // detailed per-session packet/keep-alive state
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
      this._lastStall = { startedAt: now - late, endedAt: now, durationMs: late }
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

  /** A session is connected: start judging packet and keep-alive gaps now. */
  linkUp ({ timeoutMs = 60_000 } = {}) {
    const now = this.now()
    this._link = {
      since: now,
      lastAt: now, // adjusted after our own stalls; used by the silence alarm
      lastPacketAt: now, // raw receipt time; never adjusted
      lastPacketName: 'connect',
      warnedAt: 0,
      timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 60_000,
      packets: 0,
      packetsSinceKeepAlive: 0,
      lastKeepAliveAt: 0,
      lastKeepAliveId: null,
      lastReplyAt: 0,
      lastReplyId: null,
      diagnosed: false
    }
  }

  linkDown (reason = '') {
    if (TIMEOUT_RE.test(String(reason || ''))) this.disconnect('end', reason)
    this._link = null
  }

  /**
   * Record one decoded packet. `traffic()` remains as the backwards-compatible
   * name used by simulations; `packet()` is the protocol-aware form.
   */
  traffic (name = '', packet = null) {
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
    link.lastPacketAt = now
    link.lastPacketName = String(name || 'packet')
    link.packets++

    if (name === 'keep_alive') {
      if (link.lastKeepAliveAt) {
        const gap = now - link.lastKeepAliveAt
        this.stats.worstKeepAliveGapMs = Math.max(this.stats.worstKeepAliveGapMs, gap)
      }
      link.lastKeepAliveAt = now
      link.lastKeepAliveId = idText(packet?.keepAliveId)
      link.packetsSinceKeepAlive = 0
      this.stats.keepAlives++
    } else if (link.lastKeepAliveAt) {
      link.packetsSinceKeepAlive++
    }
  }

  packet (name, packet) { this.traffic(name, packet) }

  /** Record a packet written by the client (the index wrapper calls this first). */
  outbound (name, packet = null) {
    const link = this._link
    if (!link || name !== 'keep_alive') return
    const id = idText(packet?.keepAliveId)
    link.lastReplyAt = this.now()
    link.lastReplyId = id
    this.stats.keepAliveReplies++
    if (link.lastKeepAliveId !== null && id !== link.lastKeepAliveId) {
      this.stats.replyMismatches++
      this.log('error', `keep-alive protocol error: the server challenged with id ${link.lastKeepAliveId}, but the client queued id ${id}`)
    }
  }

  _checkLink (now) {
    const link = this._link
    if (!link || link.warnedAt) return
    const quiet = now - link.lastAt
    if (quiet < this.silentMs) return
    link.warnedAt = now
    this.stats.silences++
    this.stats.worstSilenceMs = Math.max(this.stats.worstSilenceMs, quiet)
    this.log('warn', `nothing has arrived from the server for ${Math.round(quiet / 1000)}s while the bot itself is running normally — the server or the connection has stalled (not the bot). The link is dropped if no keep-alive comes in time.`)
  }

  /** The minecraft-protocol client emitted its own keep-alive timeout error. */
  connectionError (error) {
    const text = String(error?.message || error || '')
    if (!TIMEOUT_RE.test(text)) return null
    return this._diagnoseTimeout('client', text)
  }

  /** A kick/end reason may instead be the server's keep-alive watchdog. */
  disconnect (kind, reason) {
    const text = String(reason?.message || reason || '')
    if (!TIMEOUT_RE.test(text)) return null
    return this._diagnoseTimeout(String(kind || 'disconnect'), text)
  }

  _diagnoseTimeout (kind, text) {
    const link = this._link
    if (!link || link.diagnosed) return this.stats.lastTimeoutCause || null
    link.diagnosed = true
    const now = this.now()
    const timeoutMs = Math.max(1, link.timeoutMs)
    const sincePacket = Math.max(0, now - link.lastPacketAt)
    const sinceKeepAlive = Math.max(0, now - (link.lastKeepAliveAt || link.since))
    const exactReply = Boolean(link.lastKeepAliveAt && link.lastReplyAt >= link.lastKeepAliveAt && link.lastReplyId === link.lastKeepAliveId)
    const missingReply = Boolean(link.lastKeepAliveAt && !exactReply)
    // Usually the watchdog interval runs before minecraft-protocol's later
    // timeout. If timer ordering is reversed after a long block, measure the
    // overdue interval right here rather than missing the very stall at issue.
    const overdueNow = this._timer ? now - this._lastBeatAt - this.beatMs : 0
    const stall = overdueNow >= this.warnMs
      ? { startedAt: now - overdueNow, endedAt: now, durationMs: overdueNow }
      : this._lastStall
    const stallAtDeadline = Boolean(stall && now - stall.endedAt <= Math.max(2000, this.beatMs * 4))
    const seconds = (ms) => (ms / 1000).toFixed(1)
    let cause
    let detail

    if (missingReply) {
      cause = 'client-reply-path'
      detail = `the bot decoded a keep-alive ${seconds(sinceKeepAlive)}s ago but did not queue the same id back. That is in the client/protocol reply path, not the localhost network.`
    } else if (stallAtDeadline && stall.durationMs >= timeoutMs * 0.75) {
      cause = 'bot-main-thread'
      detail = `the bot's JavaScript thread was blocked for ${seconds(stall.durationMs)}s across the timeout. During that block it could neither decode the challenge nor write its reply.`
    } else if (stallAtDeadline) {
      cause = 'mixed-stall-at-deadline'
      detail = `the bot's thread was blocked for ${seconds(stall.durationMs)}s at the deadline, while the last keep-alive was already ${seconds(sinceKeepAlive)}s old. The stall contributed, but the server's keep-alive was late before it began.`
    } else if (kind === 'kicked' && exactReply) {
      cause = 'server-rejected-reply'
      detail = `the server kicked the bot even though Zinc decoded its last challenge and queued the exact id back ${seconds(now - link.lastReplyAt)}s ago. Check the server tick log and a serverbound packet trace; this is after Zinc's reply code.`
    } else if (link.packetsSinceKeepAlive > 0 && sincePacket < Math.min(this.silentMs, timeoutMs / 2)) {
      cause = 'keepalive-stream-only'
      detail = `${link.packetsSinceKeepAlive} ordinary server packet(s) arrived after the last keep-alive (last: ${link.lastPacketName}, ${seconds(sincePacket)}s ago), and Zinc echoed the previous challenge. The TCP link was alive: the server's keep-alive scheduler stopped, or minecraft-protocol's keep-alive-only timeout policy fired on an otherwise active link.`
    } else {
      cause = 'server-or-tcp-silence'
      detail = `no server packet has been decoded for ${seconds(sincePacket)}s while the bot's thread kept running; the last keep-alive was ${seconds(sinceKeepAlive)}s ago${exactReply ? ' and Zinc echoed it exactly' : ''}. On localhost this normally means the Minecraft server process/tick loop stalled, not network latency.`
    }

    this.stats.timeouts++
    this.stats.lastTimeoutCause = cause
    this.stats.worstSilenceMs = Math.max(this.stats.worstSilenceMs, sincePacket)
    this.log('error', `keep-alive diagnosis [${cause}] (${kind}: ${text}): ${detail}`)
    return cause
  }

  /** One line for `status`. */
  describe () {
    const s = this.stats
    if (!this._timer) return 'watchdog off'
    const parts = [s.stalls ? `${s.stalls} stall${s.stalls === 1 ? '' : 's'} of the bot's thread (worst ${(s.worstMs / 1000).toFixed(1)}s)` : 'no stalls of the bot\'s thread']
    parts.push(s.silences ? `${s.silences} server silence${s.silences === 1 ? '' : 's'}${s.worstSilenceMs ? ` (worst ${(s.worstSilenceMs / 1000).toFixed(1)}s)` : ''}` : 'no server silences')
    if (s.keepAlives) parts.push(`keep-alive ${s.keepAlives} received/${s.keepAliveReplies} answered${s.worstKeepAliveGapMs ? ` (widest gap ${(s.worstKeepAliveGapMs / 1000).toFixed(1)}s)` : ''}${s.replyMismatches ? `, ${s.replyMismatches} ID MISMATCH` : ''}`)
    if (s.timeouts) parts.push(`${s.timeouts} timeout${s.timeouts === 1 ? '' : 's'} (last: ${s.lastTimeoutCause})`)
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
