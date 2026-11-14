/**
 * protocol_keepalive.js — exact Minecraft keep-alive replies, sane liveness.
 *
 * minecraft-protocol's built-in client plugin does two coupled things:
 *
 *   1. echo every `keep_alive` challenge (required by the server), and
 *   2. disconnect unless ANOTHER keep_alive arrives before one fixed timer.
 *
 * The second rule is too narrow. A live 26.3 session delivered 46,029 valid
 * packets during that timer, including one in the same millisecond it expired,
 * yet the dependency disconnected it because none was named `keep_alive`.
 * TCP, parsing and the bot were demonstrably alive.
 *
 * Zinc disables that plugin and owns the two concerns separately:
 *
 *   - challenges are echoed immediately and byte-for-byte through Client.write;
 *   - a link is dead only when NO decoded server packet arrives for timeoutMs.
 *
 * The inactivity check does not reschedule a timer for every packet (a busy
 * server can deliver hundreds per second). It updates one monotonic timestamp
 * and checks it when the existing deadline fires. A setImmediate confirmation
 * gives the poll phase one chance to drain socket data after a long JavaScript stall,
 * avoiding a timer-vs-I/O race on recovery.
 */
'use strict'

class ProtocolKeepAlive {
  /**
   * @param {import('events').EventEmitter & {write:Function,end:Function}} client
   * @param {{timeoutMs?:number, now?:()=>number, setTimer?:(fn:Function,ms:number)=>any,
   *   clearTimer?:(handle:any)=>void, defer?:(fn:Function)=>any,
   *   clearDefer?:(handle:any)=>void, log?:(level:string,msg:string)=>void}} opts
   */
  constructor (client, {
    timeoutMs = 60_000,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    defer = (fn) => setImmediate(fn),
    clearDefer = (handle) => clearImmediate(handle),
    log = () => {}
  } = {}) {
    if (!client?.on || typeof client.write !== 'function') throw new TypeError('ProtocolKeepAlive needs a minecraft-protocol client')
    this.client = client
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 60_000)
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.defer = defer
    this.clearDefer = clearDefer
    this.log = log

    this.connected = false
    this.stopped = false
    this.lastPacketAt = 0
    this.timer = null
    this.deferred = null
    this.stats = { packets: 0, challenges: 0, replies: 0, inactivityTimeouts: 0 }

    this._onConnect = () => this._connected()
    this._onPacket = () => this._packet()
    this._onChallenge = (packet) => this._challenge(packet)
    this._onEnd = () => this.stop()
  }

  start () {
    if (this.stopped) return this
    this.client.on('connect', this._onConnect)
    this.client.on('packet', this._onPacket)
    this.client.on('keep_alive', this._onChallenge)
    this.client.on('end', this._onEnd)
    // Normally install happens while the socket is still opening. Handle an
    // injected/already-open client too, without arming during DNS/login waits.
    if (this.client.socket?.readyState === 'open') this._connected()
    return this
  }

  _connected () {
    if (this.stopped) return
    this.connected = true
    this.lastPacketAt = this.now()
    if (!this.timer && !this.deferred) this._schedule(this.timeoutMs)
  }

  _packet () {
    if (this.stopped) return
    if (!this.connected) this.connected = true
    this.lastPacketAt = this.now()
    this.stats.packets++
    if (!this.timer && !this.deferred) this._schedule(this.timeoutMs)
  }

  _challenge (packet) {
    if (this.stopped) return
    this.stats.challenges++
    // Do not coerce ProtoDef's i64 Array subclass to Number: IDs may be wider
    // than 53 bits. Passing it through preserves the exact signed 64-bit value.
    this.client.write('keep_alive', { keepAliveId: packet.keepAliveId })
    this.stats.replies++
  }

  _schedule (delayMs) {
    if (this.stopped) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this._check()
    }, Math.max(1, Math.ceil(delayMs)))
    if (typeof this.timer?.unref === 'function') this.timer.unref()
  }

  _check () {
    if (this.stopped || !this.connected) return
    const quietMs = this.now() - this.lastPacketAt
    if (quietMs < this.timeoutMs) {
      this._schedule(this.timeoutMs - quietMs)
      return
    }

    // Timers run before poll on some turns. If this callback is late because
    // Zinc's thread was blocked, let already-buffered socket packets run first.
    const handle = this.defer(() => {
      if (this.deferred !== handle || this.stopped) return
      this.deferred = null
      this._confirmTimeout()
    })
    this.deferred = handle
  }

  _confirmTimeout () {
    if (this.stopped || !this.connected) return
    const quietMs = this.now() - this.lastPacketAt
    if (quietMs < this.timeoutMs) {
      this._schedule(this.timeoutMs - quietMs)
      return
    }

    this.stats.inactivityTimeouts++
    const error = new Error(`server traffic timed out after ${this.timeoutMs} milliseconds`)
    error.code = 'ZINCAI_TRAFFIC_TIMEOUT'
    // Stop our timers/listeners before emitting: Mineflayer synchronously
    // relays the error, then Client.end produces the normal reconnect path.
    this.stop()
    this.client.emit('error', error)
    try { this.client.end('trafficTimeout') } catch (err) { this.log('debug', `traffic timeout close failed: ${err?.message || err}`) }
  }

  stop () {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) this.clearTimer(this.timer)
    if (this.deferred) this.clearDefer(this.deferred)
    this.timer = null
    this.deferred = null
    this.client.removeListener?.('connect', this._onConnect)
    this.client.removeListener?.('packet', this._onPacket)
    this.client.removeListener?.('keep_alive', this._onChallenge)
    this.client.removeListener?.('end', this._onEnd)
  }
}

function installProtocolKeepAlive (client, opts) {
  return new ProtocolKeepAlive(client, opts).start()
}

module.exports = { ProtocolKeepAlive, installProtocolKeepAlive }
