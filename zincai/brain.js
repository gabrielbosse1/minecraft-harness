/**
 * brain.js — when the model is called, and which model call it is.
 *
 * Two lanes share one endpoint and one rate limit:
 *
 *   CHAT lane    someone spoke to the bot → one short reply, quickly, with
 *                that player's conversation history. It can hand a task to…
 *   ACTION lane  …the body: one tool call per turn with the world snapshot.
 *
 * What changed from the old "maybeInfer":
 *   - Wake-ups are QUEUED, never dropped. The old gate discarded a trigger
 *     that arrived while the model was busy, inside the 3 s spacing or during
 *     idle back-off (up to 60 s) — which is why chat often went unanswered.
 *   - A ticker retries the gate, so a queued reason always runs.
 *   - Finished/failed/interrupted actions wake the model with their result.
 *   - Idle back-off only slows the heartbeat (self-prompts), never events.
 *   - Chat is answered before anything else.
 *
 * No Minecraft code here: everything world-specific is injected.
 */
'use strict'

class Brain {
  /**
   * @param {{
   *   act: (reasons: string[]) => Promise<{ idle: boolean }>,   one ACTION-lane turn
   *   talk: (sender: string, lines: Array<{text:string, whisper:boolean}>) => Promise<void>,  one CHAT-lane turn
   *   logger?: (level:string, msg:string) => void,
   *   minIntervalMs?: number, chatMinIntervalMs?: number, rpm?: number,
   *   heartbeatMs?: number, maxSelfChain?: number, selfChainPauseMs?: number,
   *   now?: () => number }} opts
   */
  constructor ({
    act,
    talk,
    logger = () => {},
    minIntervalMs = 3000,
    chatMinIntervalMs = 1200,
    rpm = 18,
    heartbeatMs = 90_000,
    maxSelfChain = 12,
    selfChainPauseMs = 30_000,
    now = () => Date.now()
  }) {
    this.act = act
    this.talk = talk
    this.log = logger
    this.minIntervalMs = minIntervalMs
    this.chatMinIntervalMs = chatMinIntervalMs
    this.rpm = rpm
    this.heartbeatMs = heartbeatMs
    this.maxSelfChain = maxSelfChain
    this.selfChainPauseMs = selfChainPauseMs
    this.now = now

    /** Pending ACTION-lane reasons: { text, external } — consumed all at once. */
    this.pending = []
    /** Pending CHAT-lane lines: { sender, text, whisper } in arrival order. */
    this.chatQueue = []
    this.busy = false
    this.paused = false
    this.lastActionAt = -Infinity
    this.lastChatAt = -Infinity
    this.idleStreak = 0
    this.failStreak = 0
    this.selfChain = 0
    this.selfChainUntil = 0
    this.calls = [] // timestamps of the last minute (shared rate limit)
    this.stats = { actionTurns: 0, chatTurns: 0, heartbeats: 0, queuedPeak: 0 }
    this._timer = null
  }

  start (intervalMs = 250) {
    if (this._timer) return
    this._timer = setInterval(() => { this.tick().catch((err) => this.log('error', `brain tick: ${err.message || err}`)) }, intervalMs)
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
  }

  /**
   * Ask for an ACTION-lane turn. `external` = something happened in the world
   * (chat task, threat, damage, death). `false` = the bot's own action
   * reported back; a long run of only those is rate-capped (self-chain).
   */
  wake (text, { external = true } = {}) {
    const reason = String(text || 'event').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!this.pending.some((p) => p.text === reason)) {
      this.pending.push({ text: reason, external: Boolean(external) })
      if (this.pending.length > 8) this.pending.splice(0, this.pending.length - 8)
    }
    if (external) { this.selfChain = 0; this.selfChainUntil = 0 }
    this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.pending.length)
  }

  /** Queue a line for the CHAT lane. */
  hear (sender, text, { whisper = false } = {}) {
    this.chatQueue.push({ sender, text: String(text).slice(0, 240), whisper: Boolean(whisper) })
    if (this.chatQueue.length > 12) this.chatQueue.splice(0, this.chatQueue.length - 12)
  }

  _rateOk (now) {
    while (this.calls.length && now - this.calls[0] > 60_000) this.calls.shift()
    return this.calls.length < this.rpm
  }

  _failWait () {
    return this.failStreak ? Math.min(60_000, 3000 * 2 ** (this.failStreak - 1)) : 0
  }

  /** Heartbeat spacing grows while the model keeps answering "idle". */
  _heartbeatEvery () {
    if (!(this.heartbeatMs > 0)) return Infinity
    return this.heartbeatMs * Math.min(4, 1 + this.idleStreak)
  }

  /** One scheduling step. Runs at most one model call. */
  async tick () {
    if (this.busy || this.paused) return
    const now = this.now()
    if (!this._rateOk(now)) return

    // 1. People first.
    if (this.chatQueue.length && now - this.lastChatAt >= this.chatMinIntervalMs) {
      const sender = this.chatQueue[0].sender
      const lines = this.chatQueue.filter((l) => l.sender === sender)
      this.chatQueue = this.chatQueue.filter((l) => l.sender !== sender)
      this.busy = true
      this.lastChatAt = now
      this.calls.push(now)
      this.stats.chatTurns++
      try {
        await this.talk(sender, lines)
      } catch (err) {
        this.log('error', `chat lane failed: ${err.message || err}`)
      } finally {
        this.busy = false
      }
      return
    }

    // 2. The body.
    if (now - this.lastActionAt < Math.max(this.minIntervalMs, this._failWait())) return
    if (!this.pending.length) {
      if (now - this.lastActionAt < this._heartbeatEvery()) return
      this.pending.push({ text: 'heartbeat (nothing new — idle is fine)', external: true })
      this.stats.heartbeats++
    }
    const onlySelf = this.pending.every((p) => !p.external)
    if (onlySelf && now < this.selfChainUntil) return
    const reasons = this.pending.map((p) => p.text)
    this.pending = []
    this.busy = true
    this.lastActionAt = now
    this.calls.push(now)
    this.stats.actionTurns++
    try {
      const { idle } = await this.act(reasons)
      this.failStreak = 0
      this.idleStreak = idle ? this.idleStreak + 1 : 0
      if (idle || !onlySelf) this.selfChain = 0
      else if (++this.selfChain >= this.maxSelfChain) {
        this.selfChain = 0
        this.selfChainUntil = this.now() + this.selfChainPauseMs
        this.log('warn', `self-chain cap (${this.maxSelfChain}) reached — pausing self-prompted turns for ${Math.round(this.selfChainPauseMs / 1000)}s`)
      }
    } catch (err) {
      this.failStreak++
      this.log('error', `action lane failed: ${err.message || err}`)
      // Do not lose what the turn was about.
      for (const text of reasons) if (!/^heartbeat/.test(text)) this.wake(text, { external: true })
    } finally {
      this.busy = false
    }
  }
}

module.exports = { Brain }
