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
 *   - Chat has its OWN in-flight slot and a reserved share of the budget. A
 *     chase used to spend all 18 calls a minute on the action lane, and a
 *     slow action call (20 s timeout × 3) held the single slot: a friend's
 *     line then waited 20 s or more. Now a reply never waits
 *     for the body's call, and `chatReserve` calls a minute are chat's alone.
 *   - An URGENT wake (the body just started running for its life, or is
 *     cornered) may run sooner than the normal spacing.
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
   *   chatReserve?: number, urgentMinIntervalMs?: number,
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
    chatReserve = 4,
    urgentMinIntervalMs = 1000,
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
    // Calls per minute only the chat lane may use: the action lane stops at
    // rpm - chatReserve. Never more than a third of the budget, so a small rpm
    // still leaves the body most of it.
    this.chatReserve = Math.max(0, Math.min(Math.trunc(chatReserve) || 0, Math.floor(rpm / 3)))
    this.urgentMinIntervalMs = Math.min(urgentMinIntervalMs, minIntervalMs)
    this.heartbeatMs = heartbeatMs
    this.maxSelfChain = maxSelfChain
    this.selfChainPauseMs = selfChainPauseMs
    this.now = now

    /** Pending ACTION-lane reasons: { text, external, urgent, at } — consumed all at once. */
    this.pending = []
    /** Pending CHAT-lane lines: { sender, text, whisper } in arrival order. */
    this.chatQueue = []
    this.busyAction = false
    this.busyChat = false
    this.paused = false
    this.lastActionAt = -Infinity
    this.lastChatAt = -Infinity
    this.idleStreak = 0
    this.failStreak = 0
    this.selfChain = 0
    this.selfChainUntil = 0
    this.calls = [] // { at, lane } of the last minute (shared rate limit)
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
  wake (text, { external = true, urgent = false } = {}) {
    const reason = String(text || 'event').replace(/\s+/g, ' ').trim().slice(0, 200)
    const same = this.pending.find((p) => p.text === reason)
    if (same) same.urgent = same.urgent || Boolean(urgent)
    else {
      this.pending.push({ text: reason, external: Boolean(external), urgent: Boolean(urgent), at: this.now() })
      if (this.pending.length > 8) this.pending.splice(0, this.pending.length - 8)
    }
    if (external) { this.selfChain = 0; this.selfChainUntil = 0 }
    this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.pending.length)
  }

  /** True while either lane has a model call in flight. */
  get busy () { return this.busyAction || this.busyChat }

  /** A turn made one more call than usual (a retry): count it against the budget. */
  spent (lane = 'chat') { this.calls.push({ at: this.now(), lane }) }

  /** Queue a line for the CHAT lane. */
  hear (sender, text, { whisper = false } = {}) {
    this.chatQueue.push({ sender, text: String(text).slice(0, 240), whisper: Boolean(whisper) })
    if (this.chatQueue.length > 12) this.chatQueue.splice(0, this.chatQueue.length - 12)
  }

  /** May `lane` make a call now? Chat may use the whole budget; the body leaves chat its reserve. */
  _rateOk (now, lane = 'action') {
    while (this.calls.length && now - this.calls[0].at > 60_000) this.calls.shift()
    if (this.calls.length >= this.rpm) return false
    if (lane === 'chat') return true
    let actions = 0
    for (const c of this.calls) if (c.lane === 'action') actions++
    return actions < this.rpm - this.chatReserve
  }

  _failWait () {
    return this.failStreak ? Math.min(60_000, 3000 * 2 ** (this.failStreak - 1)) : 0
  }

  /** Heartbeat spacing grows while the model keeps answering "idle". */
  _heartbeatEvery () {
    if (!(this.heartbeatMs > 0)) return Infinity
    return this.heartbeatMs * Math.min(4, 1 + this.idleStreak)
  }

  /** One scheduling step. Starts at most one call per lane; the lanes do not wait for each other. */
  async tick () {
    if (this.paused) return
    const jobs = []
    if (!this.busyChat) { const job = this._chatStep(); if (job) jobs.push(job) }
    if (!this.busyAction) { const job = this._actionStep(); if (job) jobs.push(job) }
    if (jobs.length) await Promise.all(jobs)
  }

  // 1. People first.
  _chatStep () {
    const now = this.now()
    if (!this.chatQueue.length || now - this.lastChatAt < this.chatMinIntervalMs) return null
    if (!this._rateOk(now, 'chat')) return null
    const sender = this.chatQueue[0].sender
    const lines = this.chatQueue.filter((l) => l.sender === sender)
    this.chatQueue = this.chatQueue.filter((l) => l.sender !== sender)
    this.busyChat = true
    this.lastChatAt = now
    this.calls.push({ at: now, lane: 'chat' })
    this.stats.chatTurns++
    return Promise.resolve()
      .then(() => this.talk(sender, lines))
      .catch((err) => this.log('error', `chat lane failed: ${err.message || err}`))
      .finally(() => { this.busyChat = false })
  }

  // 2. The body.
  _actionStep () {
    const now = this.now()
    const urgent = this.pending.some((p) => p.urgent)
    const spacing = Math.max(urgent ? this.urgentMinIntervalMs : this.minIntervalMs, this._failWait())
    if (now - this.lastActionAt < spacing) return null
    if (!this.pending.length) {
      if (now - this.lastActionAt < this._heartbeatEvery()) return null
      if (!this._rateOk(now, 'action')) return null
      this.pending.push({ text: 'heartbeat (nothing new — idle is fine)', external: true, urgent: false, at: now })
      this.stats.heartbeats++
    } else if (!this._rateOk(now, 'action')) return null
    const onlySelf = this.pending.every((p) => !p.external)
    if (onlySelf && now < this.selfChainUntil) return null
    // A reason that had to wait says for how long: "… (6s ago)".
    const reasons = this.pending.map((p) => {
      const waited = Math.round((now - (p.at ?? now)) / 1000)
      return waited >= 4 ? `${p.text} (${waited}s ago)` : p.text
    })
    const raw = this.pending.map((p) => p.text)
    this.pending = []
    this.busyAction = true
    this.lastActionAt = now
    this.calls.push({ at: now, lane: 'action' })
    this.stats.actionTurns++
    return Promise.resolve()
      .then(() => this.act(reasons))
      .then(({ idle }) => {
        this.failStreak = 0
        this.idleStreak = idle ? this.idleStreak + 1 : 0
        if (idle || !onlySelf) this.selfChain = 0
        else if (++this.selfChain >= this.maxSelfChain) {
          this.selfChain = 0
          this.selfChainUntil = this.now() + this.selfChainPauseMs
          this.log('warn', `self-chain cap (${this.maxSelfChain}) reached — pausing self-prompted turns for ${Math.round(this.selfChainPauseMs / 1000)}s`)
        }
      })
      .catch((err) => {
        this.failStreak++
        this.log('error', `action lane failed: ${err.message || err}`)
        // Do not lose what the turn was about.
        for (const text of raw) if (!/^heartbeat/.test(text)) this.wake(text, { external: true })
      })
      .finally(() => { this.busyAction = false })
  }
}

module.exports = { Brain }
