/**
 * watchdog.js — why does the bot keep getting kicked, and why is the link
 * "timing out" on a server running on localhost?
 *
 * WHY THIS EXISTS
 *   Nothing measured the link. When a server dropped the bot there was one log
 *   line — "kicked: ..." — and no way to tell the four causes apart:
 *
 *     1. the SERVER stopped hearing from us     (its keep_alive unanswered)
 *     2. WE stopped hearing from the server     (minecraft-protocol gives up)
 *     3. the event loop stalled long enough that
 *        a keepalive was answered too late      (GC, a sync fs write, a big
 *                                                JSON parse, a busy CPU)
 *     4. the TCP socket died                    (RST, ECONNRESET, half-open)
 *
 *   They look identical from the console ("it keeps getting kicked") and they
 *   have completely different fixes, so guessing is expensive. This module
 *   records the evidence that separates them.
 *
 * THE PROTOCOL FACT THAT MATTERS
 *   minecraft-protocol arms a WALL-CLOCK timer on every keep_alive
 *   (src/client/keepalive.js): whatever `checkTimeoutInterval` is set to, if the
 *   next keep_alive does not arrive within it, the client ends its own
 *   connection with `client timed out after N milliseconds`. The timer cannot
 *   fire while the event loop is blocked, and when the loop unblocks a late
 *   keepalive may arrive after the timer was already due. Loop latency and
 *   timeouts are therefore the same question, which is why the stall detector
 *   is here and not in its own module.
 *
 * Pure bookkeeping: no timers owned by this module unless start() is called, no
 * I/O, no mineflayer import. Every timestamp comes from an injected `now`.
 */
'use strict'

/** mineflayer/minecraft-protocol's own default for the keepalive deadline. */
const DEFAULT_CHECK_TIMEOUT_MS = 30_000

/** A loop stall shorter than this is noise: GC, a timer, a socket flush. */
const STALL_FLOOR_MS = 250

/**
 * Turn a raw disconnect into a cause we can act on.
 *
 * @param {{ kind?: string, text?: string, code?: string|number|null,
 *           checkTimeoutMs?: number, maxStallMs?: number,
 *           sentAt?: number|null, at?: number }} info
 * @returns {{ cause: string, certain: boolean, why: string, fix: string }}
 */
function classifyDisconnect ({
  kind = 'end',
  text = '',
  code = null,
  checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  maxStallMs = 0,
  sentAt = null,
  at = null
} = {}) {
  const t = String(text || '')
  const k = String(kind || 'end')

  // 1. Our own client gave up waiting for the server. This is a real timeout,
  //    and the only question left is whether OUR loop was the reason.
  if (/timed out after|client timed out/i.test(t) || code === 'keepAliveError') {
    const stalled = Number(maxStallMs) >= STALL_FLOOR_MS
    return {
      cause: stalled ? 'loop-stall' : 'server-silent',
      certain: false,
      why: stalled
        ? `our keepalive deadline (${Math.round(checkTimeoutMs / 1000)}s) expired and the event loop was blocked for ${Math.round(maxStallMs)}ms around it — the reply was queued, not missing`
        : `our keepalive deadline (${Math.round(checkTimeoutMs / 1000)}s) expired with the loop healthy, so the server stopped sending keep_alive (or the packets stopped arriving)`,
      fix: stalled
        ? 'the link is fine; the process is not. Find what blocked the loop (see the stall list) — usually a synchronous save/parse or a full GC — or raise connection.checkTimeoutMs if the node is simply slow.'
        : 'raise connection.checkTimeoutMs, or fix the server/network: a localhost server that goes silent for 30s is usually a stalled server tick (single-threaded, so a slow chunk or a /stop-adjacent hang stops keepalives too) or a paused VM.'
    }
  }

  // 2. The server answered with a kick. `KeepAliveTimeout` is the server saying
  //    IT stopped hearing from US — the mirror image of case 1.
  if (/keepalivetimeout|keep alive timeout/i.test(t)) {
    return {
      cause: 'server-keepalive-timeout',
      certain: true,
      why: 'the server did not receive our keep_alive replies in time (vanilla kicks after 30s by default)',
      fix: 'the socket is losing our replies, or the process was blocked long enough that the replies never went out. A localhost server makes a network cause implausible, so look at loop stalls first.'
    }
  }

  // 3. A plain reader timeout from mineflayer's own connect/read path.
  if (/timeout/i.test(t) && k !== 'kicked') {
    return {
      cause: 'read-timeout',
      certain: false,
      why: 'the client stopped receiving packets for longer than its read deadline',
      fix: 'same evidence path as server-silent: check the stall list and the server tick rate before changing anything.'
    }
  }

  // 4. The socket itself died.
  if (/ECONNRESET|EPIPE|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|read ECONN/i.test(t)) {
    return {
      cause: 'socket-error',
      certain: true,
      why: 'the TCP connection died rather than going quiet — the other end closed it or the kernel refused it',
      fix: 'on localhost this is almost always the server process exiting, restarting, or binding a different port; check its log at the moment of the drop.'
    }
  }

  if (/ended|disconnect|connection reset|server (closed|stopped)/i.test(t) && k !== 'kicked') {
    return {
      cause: 'server-closed',
      certain: false,
      why: 'the server closed the connection without a kick message',
      fix: 'check the server log around that time — a clean close is usually a restart, a /stop, or the server crashing.'
    }
  }

  if (k === 'kicked') {
    return {
      cause: 'kicked',
      certain: true,
      why: `the server kicked the bot: ${t.slice(0, 120) || '(no reason given)'}`,
      fix: 'this is a policy or state rejection, not a timeout. The reason string is the whole answer.'
    }
  }

  return {
    cause: 'unknown',
    certain: false,
    why: `the link ended (${k}${t ? `: ${t.slice(0, 100)}` : ', no reason given'})`,
    fix: 'not enough evidence. The stall list and the keepalive counters below are what the next failure needs.'
  }
}

/**
 * Watches the event loop and the keepalive cadence.
 *
 * The loop monitor is a `setInterval` compared against a monotonic clock: if it
 * was due every 100ms and 4000ms passed, the loop was blocked for ~3900ms. That
 * is the only reliable way to see a stall from inside the process, because
 * anything that runs *during* the stall is by definition late.
 */
class LinkWatchdog {
  /**
   * @param {{
   *   config?: import('./runtime_config').RuntimeConfig,
   *   logger?: (level:string,msg:string)=>void,
   *   now?: () => number,
   *   setInterval?: Function, clearInterval?: Function,
   *   sampleMs?: number
   * }} [opts]
   */
  constructor ({ config = null, logger = () => {}, now = () => Date.now(), setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval, sampleMs = 100 } = {}) {
    this.config = config
    this.log = logger
    this.now = now
    this.setInterval = setIv
    this.clearInterval = clearIv
    this.sampleMs = Math.max(20, Number(sampleMs) || 100)

    this.timer = null
    this.running = false
    this.lastTickAt = 0
    this.lastSentAt = null
    this.lastRecvAt = null
    /** The longest stall seen since the last reset (or since this link began). */
    this.maxStallMs = 0
    this.stallAt = null
    /** Every stall worth reporting, newest last. Bounded — this runs forever. */
    this.stalls = []
    this.sent = 0
    this.recv = 0
    /** Disconnects with their diagnosis, newest last. */
    this.ends = []
    this.startedAt = null
    this.reset()
  }

  /** Forget everything: called when a new link starts, never across links. */
  reset (at = this.now()) {
    this.lastTickAt = at
    this.lastSentAt = null
    this.lastRecvAt = null
    this.maxStallMs = 0
    this.stallAt = null
    this.stalls = []
    this.sent = 0
    this.recv = 0
  }

  /** The deadline minecraft-protocol is actually using for this link. */
  checkTimeoutMs () {
    const configured = this.config ? Number(this.config.get('connection.checkTimeoutMs')) : (this.config === null ? DEFAULT_CHECK_TIMEOUT_MS : NaN)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CHECK_TIMEOUT_MS
  }

  /** Begin sampling the loop. Safe to call twice. */
  start () {
    if (this.running) return false
    this.running = true
    this.startedAt = this.now()
    this.lastTickAt = this.startedAt
    this.timer = this.setInterval(() => this._sample(), this.sampleMs)
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
    return true
  }

  stop () {
    this.running = false
    if (this.timer !== null) {
      try { this.clearInterval(this.timer) } catch { /* already gone */ }
      this.timer = null
    }
  }

  /**
   * One loop sample. Public because a test drives it with a fake clock instead
   * of waiting for a real stall.
   * @param {number} [at] the tick time, in `now()` units
   */
  _sample (at = this.now()) {
    const late = at - this.lastTickAt - this.sampleMs
    this.lastTickAt = at
    if (late < STALL_FLOOR_MS) return null
    const stall = { at, ms: Math.round(late) }
    this.stalls.push(stall)
    if (this.stalls.length > 20) this.stalls.shift()
    if (late > this.maxStallMs) { this.maxStallMs = late; this.stallAt = at }
    // Logged, not thrown: a stall is evidence, and the link survives most of them.
    this.log('warn', `event loop blocked for ${Math.round(late)}ms — keepalives cannot be sent or answered while this happens`)
    return stall
  }

  /** A keep_alive left the client. */
  noteSent (at = this.now()) {
    this.sent += 1
    this.lastSentAt = at
  }

  /** A keep_alive arrived from the server. */
  noteRecv (at = this.now()) {
    this.recv += 1
    this.lastRecvAt = at
  }

  /**
   * Record a disconnect with its diagnosis.
   * @param {{ kind?:string, text?:string, code?:string|number|null }} info
   */
  noteEnd (info = {}) {
    const at = this.now()
    const verdict = classifyDisconnect({
      ...info,
      checkTimeoutMs: this.checkTimeoutMs(),
      maxStallMs: this.maxStallMs,
      sentAt: this.lastSentAt,
      at
    })
    const record = {
      at,
      kind: String(info.kind || 'end'),
      text: String(info.text || '').slice(0, 200),
      code: info.code ?? null,
      cause: verdict.cause,
      certain: verdict.certain,
      why: verdict.why,
      fix: verdict.fix,
      maxStallMs: Math.round(this.maxStallMs),
      sent: this.sent,
      recv: this.recv,
      silentForMs: this.lastRecvAt ? at - this.lastRecvAt : null
    }
    this.ends.push(record)
    if (this.ends.length > 20) this.ends.shift()
    return record
  }

  /** The text the operator sees when a link drops — the actual investigation. */
  explain (record = null) {
    const r = record || this.ends[this.ends.length - 1]
    if (!r) return 'no disconnect has been recorded since this link started'
    const secs = r.silentForMs === null ? null : Math.round(r.silentForMs / 1000)
    const lines = [
      `cause: ${r.cause}${r.certain ? '' : ' (best inference)'}`,
      `  ${r.why}`,
      `  last packet from the server: ${secs === null ? 'never (this link never received one)' : `${secs}s before the drop`}`,
      `  keepalives this link: ${r.sent} sent, ${r.recv} received`,
      `  worst loop stall: ${r.maxStallMs}ms${r.maxStallMs >= STALL_FLOOR_MS ? ' ← this is enough to miss a keepalive' : ' (healthy)'}`,
      `  deadline in force: ${Math.round(this.checkTimeoutMs() / 1000)}s (connection.checkTimeoutMs)`,
      `what to do: ${r.fix}`
    ]
    if (this.stalls.length) {
      lines.push('recent stalls:')
      for (const s of this.stalls.slice(-5)) lines.push(`  ${new Date(s.at).toISOString()}  ${s.ms}ms`)
    }
    return lines.join('\n')
  }

  snapshot () {
    return {
      running: this.running,
      startedAt: this.startedAt,
      checkTimeoutMs: this.checkTimeoutMs(),
      sent: this.sent,
      recv: this.recv,
      lastSentAt: this.lastSentAt,
      lastRecvAt: this.lastRecvAt,
      silentForMs: this.lastRecvAt ? this.now() - this.lastRecvAt : null,
      maxStallMs: Math.round(this.maxStallMs),
      stallAt: this.stallAt,
      stalls: this.stalls.slice(-8),
      ends: this.ends.slice(-5)
    }
  }
}

module.exports = {
  LinkWatchdog,
  classifyDisconnect,
  DEFAULT_CHECK_TIMEOUT_MS,
  STALL_FLOOR_MS
}
