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
 * THE AGENT LOOP
 *   Events are no longer the only thing that starts a turn. When a turn ends
 *   and nothing is queued, the next one starts by itself `loopMs` later: look
 *   at the world, continue the goal, check on the running task. While the model
 *   keeps answering "idle" the gap doubles, up to `heartbeatMs` (the slowest the
 *   loop ever gets); anything that happens brings it back to `loopMs`. While
 *   the body is busy with a task the loop still runs, at `loopBusyMs`, so a
 *   long walk is supervised instead of forgotten. `heartbeatMs: 0` (or
 *   `loopMs: 0`) turns the loop off: events only.
 *
 * CHAT AND THE BODY DO NOT INTERRUPT EACH OTHER
 *   A chat line used to abort the action lane's thought the moment it arrived,
 *   so every "lol" cost the body a minute of thinking. Chat is now answered by
 *   its own lane while the body's thought carries on. Only a wake that says
 *   `preempt: true` (the chat lane handing the body a new job) cancels a
 *   thought in flight — the one case where what it is deciding is already
 *   out of date.
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
    chatBatchMs = 6000,
    loopMs = null,
    loopBusyMs = null,
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
    // The IRC window. (This assignment was missing: the option was accepted and
    // never stored, so every line of a quiet stretch became its own model call.)
    this.chatBatchMs = Number.isFinite(chatBatchMs) ? Math.max(0, chatBatchMs) : 6000
    // The agent loop: gap between self-started turns. Without `loopMs` the loop
    // runs at the heartbeat, i.e. exactly the old check-in.
    this.loopMs = Number.isFinite(loopMs) ? Math.max(0, loopMs) : heartbeatMs
    this._legacyLoop = !Number.isFinite(loopMs)
    // While the body is busy: how often the loop looks in. null = never (the
    // task's own result wakes the model), which is the old behaviour.
    this.loopBusyMs = Number.isFinite(loopBusyMs) && loopBusyMs > 0 ? loopBusyMs : null
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
    this.lastActionEndAt = -Infinity
    this.lastChatAt = -Infinity
    this.chatWindowAt = 0 // when the open batching window closes (0 = none open)
    this.idleStreak = 0
    this.failStreak = 0
    this.selfChain = 0
    this.selfChainUntil = 0
    this.calls = [] // { at, lane } of the last minute (shared rate limit)
    this.stats = { actionTurns: 0, chatTurns: 0, heartbeats: 0, loopTurns: 0, queuedPeak: 0, fastTurns: 0, urgentTurns: 0, preempts: 0, extraCalls: 0 }
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
    clearTimeout(this._chatTimer)
    this._chatTimer = null
    this.chatWindowAt = 0
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
   * `preempt: true` also cancels the action thought that is in flight right
   * now: what it is deciding was overtaken by this (a player just handed the
   * body a job). Ordinary chat never does that.
   */
  wake (text, { external = true, urgent = false, fast = false, important = false, preempt = false } = {}) {
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
    if (external) { this.selfChain = 0; this.selfChainUntil = 0; this.idleStreak = 0 }
    this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.pending.length)
    if (preempt) this.preempt(reason)
    this._kick()
  }

  /**
   * Drop queued wake-ups by their text: the turn that is running has already
   * been handed those results (as tool output), so waking for them again would
   * be a second model call about the same thing.
   */
  unwake (texts = []) {
    const norm = (t) => String(t || 'event').replace(/\s+/g, ' ').trim().slice(0, 200)
    const drop = new Set([].concat(texts).map(norm))
    if (!drop.size) return 0
    const before = this.pending.length
    this.pending = this.pending.filter((p) => !drop.has(p.text))
    return before - this.pending.length
  }

  /** Cancel the action thought in flight (if any). @returns true when one was cancelled */
  preempt (why = 'preempted') {
    this.preempted = true // a multi-step turn checks this between steps
    if (!this.busyAction || typeof this.inflightAbort !== 'function') return false
    let done = false
    try { done = Boolean(this.inflightAbort(why)) } catch { done = false }
    if (done) this.stats.preempts++
    return done
  }

  /**
   * May the turn that is running make ONE MORE model call (a further step of
   * the same turn)? Counts it against the shared budget when it may.
   */
  takeCall (lane = 'action') {
    const now = this.now()
    if (!this._rateOk(now, lane)) return false
    this.calls.push({ at: now, lane })
    this.stats.extraCalls++
    return true
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
    // No abort here any more: the chat lane answers on its own while the body's
    // thought carries on. If the reply hands the body a job, THAT preempts.
    this._scheduleChat()
  }

  /**
   * Start (or keep) the batching window. The first line of a quiet stretch
   * opens the window; later lines inside it join the same chunk. That is what
   * makes a 5 s rhythm out of a burst instead of one turn per message.
   */
  _scheduleChat () {
    if (this._chatTimer) return
    if (!(this.chatBatchMs > 0)) { this.chatWindowAt = 0; this._kick(); return }
    // The window is measured on the real clock (a timer), and remembered as a
    // deadline so a scheduler tick inside it cannot hand the chunk over early.
    this.chatWindowAt = Date.now() + this.chatBatchMs
    this._chatTimer = setTimeout(() => {
      this._chatTimer = null
      this.chatWindowAt = 0
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

  /**
   * The agent loop's gap: how long after a turn ENDS the next self-started one
   * begins. `loopMs` while there is something going on; doubling while the
   * model keeps answering "idle", never slower than `heartbeatMs`. While the
   * body is busy the loop looks in every `loopBusyMs` (never, when unset).
   */
  _loopEvery () {
    if (!(this.heartbeatMs > 0) || !(this.loopMs > 0)) return Infinity
    let base = this.loopMs
    if (this.isBodyBusy()) {
      if (!this.loopBusyMs) return Infinity
      base = Math.max(base, this.loopBusyMs)
    }
    // No `loopMs`: the old check-in, which grew linearly to four heartbeats.
    if (this._legacyLoop) return base * Math.min(4, 1 + this.idleStreak)
    const ceiling = Math.max(base, this.heartbeatMs)
    return Math.min(ceiling, base * 2 ** Math.min(8, this.idleStreak))
  }

  /** Back-compat name. */
  _heartbeatEvery () { return this._loopEvery() }

  /** One scheduling step. Starts at most one call per lane; the lanes do not wait for each other. */
  async tick () {
    if (this.paused) return
    // The two lanes are independent: a chat chunk is answered while the action
    // lane keeps thinking and the body keeps working. (A waiting chunk used to
    // cancel the in-flight action call here.)
    const jobs = []
    if (!this.busyChat) { const job = this._chatStep(); if (job) jobs.push(job) }
    if (!this.busyAction) { const job = this._actionStep(); if (job) jobs.push(job) }
    if (jobs.length) await Promise.all(jobs)
  }

  // 1. People first.
  _chatStep () {
    const now = this.now()
    if (!this.chatQueue.length || now - this.lastChatAt < this.chatMinIntervalMs) return null
    // Still inside the batching window: keep collecting. Lines that arrive
    // while a chat call is in flight pile up too, and all of them go out as ONE
    // chunk when it returns — more text in the next request, not more requests.
    if (this.chatWindowAt && Date.now() < this.chatWindowAt) return null
    if (!this._rateOk(now, 'chat')) return null
    // The whole window goes to the model as one chunk — every speaker, in order,
    // with replies to each other intact. `sender` is the most recent speaker
    // (the model gets all of them in the prompt, and picks its own addressee).
    const lines = this.chatQueue.splice(0, this.chatQueue.length)
    clearTimeout(this._chatTimer)
    this._chatTimer = null
    this.chatWindowAt = 0
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
    let loopTurn = false
    if (!this.pending.length) {
      // THE AGENT LOOP: nothing happened, so the next turn starts by itself.
      const every = this._loopEvery()
      if (!(every < Infinity)) return null
      if (now - Math.max(this.lastActionAt, this.lastActionEndAt) < every) return null
      if (!this._rateOk(now, 'action')) return null
      const busy = this.isBodyBusy()
      this.pending.push({
        text: busy
          ? 'autonomous check-in (your body is still busy — see `doing`; idle lets it carry on, or adjust/stop it if it is going wrong)'
          : 'autonomous check-in (pursue an open/new goal, explore, or idle if content)',
        external: true, urgent: false, fast: false, important: false, at: now, mono: performance.now()
      })
      this.stats.heartbeats++
      this.stats.loopTurns++
      loopTurn = true
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
    this.preempted = false
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
        // Only the loop's own turns back the loop off: an idle answer to an
        // event says nothing about how often to look around.
        if (!idle) this.idleStreak = 0
        else if (loopTurn) this.idleStreak++
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
        this.lastActionEndAt = this.now()
        if (this.pending.length) this._kick()
      })
  }
}

module.exports = { Brain }
