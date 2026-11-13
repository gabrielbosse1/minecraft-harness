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

const { performance } = require('node:perf_hooks')

class Brain {
  /**
   * @param {{
   *   act: (reasons: string[], meta?: object) => Promise<{ idle: boolean }>,   one ACTION-lane turn
   *   talk: (sender: string, lines: Array<{text:string, whisper:boolean}>, meta?: object) => Promise<void>,  one CHAT-lane turn
   *   logger?: (level:string, msg:string) => void,
   *   minIntervalMs?: number, fastMinIntervalMs?: number, chatMinIntervalMs?: number, rpm?: number,
   *   chatReserve?: number, urgentMinIntervalMs?: number,
   *   heartbeatMs?: number, maxSelfChain?: number, selfChainPauseMs?: number,
   *   now?: () => number }} opts
   */
  constructor ({
    act,
    talk,
    isBodyBusy = () => false,
    logger = () => {},
    minIntervalMs = 3000,
    fastMinIntervalMs = 800,
    chatMinIntervalMs = 1200,
    rpm = 18,
    chatReserve = 4,
    urgentMinIntervalMs = 1000,
    heartbeatMs = 90_000,
    maxSelfChain = 12,
    selfChainPauseMs = 30_000,
    chatBatchMs = 5000,
    now = () => Date.now()
  }) {
    this.act = act
    this.talk = talk
    this.isBodyBusy = isBodyBusy
    this.log = logger
    this.minIntervalMs = minIntervalMs
    this.fastMinIntervalMs = Math.min(fastMinIntervalMs, minIntervalMs)
    this.chatMinIntervalMs = chatMinIntervalMs
    this.rpm = rpm
    // Calls per minute only the chat lane may use: the action lane stops at
    // rpm - chatReserve. Never more than a third of the budget, so a small rpm
    // still leaves the body most of it.
    this.chatReserve = Math.max(0, Math.min(Math.trunc(chatReserve) || 0, Math.floor(rpm / 3)))
    this.urgentMinIntervalMs = Math.min(urgentMinIntervalMs, this.fastMinIntervalMs)
    this.heartbeatMs = heartbeatMs
    this.maxSelfChain = maxSelfChain
    this.selfChainPauseMs = selfChainPauseMs
    this.now = now

    /** Pending ACTION-lane reasons: { text, external, urgent, fast, important, at, mono } — consumed all at once. */
    this.pending = []
    /** Pending CHAT-lane lines: { sender, text, whisper, at, mono } in arrival order. */
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
    this.stats = { actionTurns: 0, chatTurns: 0, heartbeats: 0, queuedPeak: 0, fastTurns: 0, urgentTurns: 0 }
    this._timer = null
    this._kickScheduled = false
  }

  _kick () {
    if (!this._timer || this.paused || this._kickScheduled) return
    this._kickScheduled = true
    queueMicrotask(() => {
      this._kickScheduled = false
      if (!this._timer || this.paused) return
      this.tick().catch((err) => this.log('error', `brain kick: ${err.message || err}`))
    })
  }

  start (intervalMs = 250) {
    if (this._timer) return
    this._timer = setInterval(() => { this.tick().catch((err) => this.log('error', `brain tick: ${err.message || err}`)) }, intervalMs)
    if (this.pending.length || this.chatQueue.length) this._kick()
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
    this._kickScheduled = false
  }

  /**
   * Clear transient pending triggers on context reset without dropping rate limits.
   * Important undelivered external wakes (`important: true` or `urgent: true`) can
   * be preserved when `preserveImportant` is set so mid-reset hazards/events survive.
   */
  clearContext ({ preserveImportant = false } = {}) {
    this.pending = preserveImportant ? this.pending.filter((p) => p.urgent || p.important) : []
    this.chatQueue = []
    this.idleStreak = 0
    this.failStreak = 0
    this.selfChain = 0
    this.selfChainUntil = 0
  }

  /**
   * Ask for an ACTION-lane turn. `external` = something happened in the world
   * (chat task, threat, damage, death). `false` = the bot's own action
   * reported back; a long run of only those is rate-capped (self-chain).
   * `fast: true` uses `fastMinIntervalMs` for time-sensitive non-emergency events.
   */
  wake (text, { external = true, urgent = false, fast = false, important = false } = {}) {
    const reason = String(text || 'event').replace(/\s+/g, ' ').trim().slice(0, 200)
    const same = this.pending.find((p) => p.text === reason)
    if (same) {
      same.urgent = same.urgent || Boolean(urgent)
      same.fast = same.fast || Boolean(fast) || Boolean(urgent)
      same.important = same.important || Boolean(important) || Boolean(urgent)
    } else {
      this.pending.push({
        text: reason,
        external: Boolean(external),
        urgent: Boolean(urgent),
        fast: Boolean(fast) || Boolean(urgent),
        important: Boolean(important) || Boolean(urgent),
        at: this.now(),
        mono: performance.now()
      })
      if (this.pending.length > 24) {
        // Drop oldest non-urgent, non-important item first so bursts never evict critical wakes.
        const dropIdx = this.pending.findIndex((p) => !p.urgent && !p.important)
        if (dropIdx >= 0) this.pending.splice(dropIdx, 1)
        else this.pending.shift()
      }
    }
    if (external) { this.selfChain = 0; this.selfChainUntil = 0 }
    this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.pending.length)
    this._kick()
  }

  /** True while either lane has a model call in flight. */
  get busy () { return this.busyAction || this.busyChat }

  /** A turn made one more call than usual (a retry): count it against the budget. */
  spent (lane = 'chat') { this.calls.push({ at: this.now(), lane }) }

  /**
   * Queue one line of the IRC stream for the CHAT lane.
   *
   * Lines do NOT become a wake of their own. They accumulate for `chatBatchMs`
   * (5 s by default) and are then handed to the model as ONE chunk, the way a
   * person reads a chat window: several people talking, a burst of replies,
   * someone answering ten seconds later — all of it in context, in order, with
   * who said what. A wake per line used to cost one model call per message and
   * give the model a single line with no idea what had just been said around it.
   *
   * The batch is not a filter: nothing is dropped, nothing is scored for
   * relevance, and the model decides what (if anything) concerns it.
   */
  hear (sender, text, { whisper = false } = {}) {
    this.chatQueue.push({
      sender,
      text: String(text).slice(0, 240),
      whisper: Boolean(whisper),
      at: this.now(),
      mono: performance.now()
    })
    if (this.chatQueue.length > 64) this.chatQueue.splice(0, this.chatQueue.length - 64)
    // A thought in flight is interruptible the moment the first line lands, not
    // at the next tick: a player typing should not wait for a 250 ms scheduler
    // slot to be noticed.
    if (this.busyAction && this.inflightAbort) this.inflightAbort('chat arrived')
    this._scheduleChat()
  }

  /**
   * Start (or keep) the batching window. The first line of a quiet stretch
   * opens the window; later lines inside it join the same chunk. That is what
   * makes a 5 s rhythm out of a burst instead of one turn per message.
   */
  _scheduleChat () {
    if (this._chatTimer) return
    if (!(this.chatBatchMs > 0)) { this._kick(); return }
    this._chatTimer = setTimeout(() => {
      this._chatTimer = null
      this._kick()
    }, this.chatBatchMs)
    if (typeof this._chatTimer.unref === 'function') this._chatTimer.unref()
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
    // People break thoughts. This check belongs HERE, not in _actionStep: that
    // step is skipped while an action call is in flight, which is exactly the
    // moment there is something worth interrupting. A chat chunk that is
    // waiting — and past its window — cancels the in-flight completion, and the
    // action lane re-plans once the players have been answered.
    if (this.busyAction && this.chatQueue.length && this.inflightAbort) this.inflightAbort('chat chunk waiting')
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
    // The whole window goes to the model as one chunk — every speaker, in order,
    // with replies to each other intact. `sender` is the most recent speaker
    // (the model gets all of them in the prompt, and picks its own addressee).
    const lines = this.chatQueue.splice(0, this.chatQueue.length)
    const sender = lines[lines.length - 1].sender
    const earliestMono = lines.reduce((m, l) => Number.isFinite(l.mono) ? Math.min(m, l.mono) : m, Infinity)
    const invokeMono = performance.now()
    this.busyChat = true
    this.lastChatAt = now
    this.calls.push({ at: now, lane: 'chat' })
    this.stats.chatTurns++
    return Promise.resolve()
      .then(() => this.talk(sender, lines, {
        queuedMono: Number.isFinite(earliestMono) ? earliestMono : invokeMono,
        invokeMono
      }))
      .catch((err) => this.log('error', `chat lane failed: ${err.message || err}`))
      .finally(() => {
        this.busyChat = false
        if (this.chatQueue.length) this._kick()
      })
  }

  // 2. The body.
  _actionStep () {
    const now = this.now()
    const urgent = this.pending.some((p) => p.urgent)
    const fast = !urgent && this.pending.some((p) => p.fast)
    const baseSpacing = urgent ? this.urgentMinIntervalMs : (fast ? this.fastMinIntervalMs : this.minIntervalMs)
    const spacing = Math.max(baseSpacing, this._failWait())
    if (now - this.lastActionAt < spacing) return null
    if (!this.pending.length) {
      if (this.isBodyBusy()) return null
      if (now - this.lastActionAt < this._heartbeatEvery()) return null
      if (!this._rateOk(now, 'action')) return null
      this.pending.push({ text: 'autonomous check-in (pursue an open/new goal, explore, or idle if content)', external: true, urgent: false, fast: false, important: false, at: now, mono: performance.now() })
      this.stats.heartbeats++
    } else if (!this._rateOk(now, 'action')) return null
    const onlySelf = this.pending.every((p) => !p.external)
    if (onlySelf && now < this.selfChainUntil) return null
    // A reason that had to wait says for how long: "… (6s ago)".
    const reasons = this.pending.map((p) => {
      const waited = Math.round((now - (p.at ?? now)) / 1000)
      return waited >= 4 ? `${p.text} (${waited}s ago)` : p.text
    })
    const raw = this.pending.slice()
    const earliestMono = raw.reduce((m, p) => Number.isFinite(p.mono) ? Math.min(m, p.mono) : m, Infinity)
    const invokeMono = performance.now()
    const reactionClass = urgent ? 'immediate' : (fast ? 'fast' : 'deliberate')
    this.pending = []
    this.busyAction = true
    this.lastActionAt = now
    this.calls.push({ at: now, lane: 'action' })
    this.stats.actionTurns++
    if (urgent) this.stats.urgentTurns++
    else if (fast) this.stats.fastTurns++
    return Promise.resolve()
      .then(() => this.act(reasons, {
        queuedMono: Number.isFinite(earliestMono) ? earliestMono : invokeMono,
        invokeMono,
        reactionClass
      }))
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
        for (const item of raw) {
          if (!/^autonomous check-in|^heartbeat/.test(item.text)) {
            this.wake(item.text, { external: true, urgent: item.urgent, fast: item.fast, important: item.important })
          }
        }
      })
      .finally(() => {
        this.busyAction = false
        if (this.pending.length) this._kick()
      })
  }
}

module.exports = { Brain }
