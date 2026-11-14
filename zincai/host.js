/**
 * host.js — Zinc's runtime shell: the control state, the operator command
 * interface, and the object the session attaches itself to.
 *
 * SEPARATION OF CONCERNS
 *
 *   RuntimeConfig       what is permitted (persistent, validated parameters)
 *   PhysicalBoundary    where every physical act is checked
 *   ConnectionManager   the link, its states and its retry policy
 *   DeathRecovery       what a death changed and whether going home is sane
 *   Host (this file)    the process-level owner: pause flag, command parsing,
 *                       authorisation, status/jobs/goals read models, and the
 *                       single place a *session* attaches to and detaches from
 *
 *   The important property: the Host outlives sessions. `leave`, `join`,
 *   `restart-connection`, `stop`, `resume`, `status`, `config` and `help` all
 *   work whether or not a Minecraft link exists, and none of them stop the
 *   Node.js process.
 *
 * WHAT `stop` IS (and is not)
 *   `stop` is a pause of the body, not of the mind:
 *     - no new physical action may start (the boundary refuses: "paused");
 *     - cancellable work is interrupted (skills, executor, in-flight jobs);
 *     - every open goal is SUSPENDED (not deleted) with its checkpoint;
 *     - memory, identity, relationships, jobs and goal progress survive.
 *   `resume` reconciles the world BEFORE anything restarts: position, health,
 *   inventory, dimension, then each suspended goal is verified against the
 *   world, and a goal whose work already happened is completed instead of being
 *   repeated.
 *
 * Command authorisation
 *   A command is accepted only from a Minecraft UUID in `control.operators`.
 *   Offline-mode usernames are not identity, so a name alone is never enough —
 *   the player list is only used to map a UUID to a display name for the log.
 *   Refusals are logged without the command body and with a redacted sender.
 */
'use strict'

const { EventEmitter } = require('events')
const path = require('path')
const { PhysicalBoundary } = require('./boundary')
const { ConnectionManager, STATES } = require('./connection')
const { DeathRecovery, respawnSummary } = require('./death_recovery')
const { RuntimeConfig } = require('./runtime_config')
const { STATUS } = require('./goals')
const { COMMANDS } = require('./control_commands')
const { LinkWatchdog } = require('./watchdog')
const { AgentLoop } = require('./agent_loop')
const updater = require('./updater')

/**
 * Split one console line into a command and its arguments. There is no prefix.
 *
 * This used to also parse chat shapes: a `!zinc`-prefixed public message became
 * a command, and a UUID allow-list decided who could send it. Operator control
 * is console-only now (stdin of the process, or the supervisor's own calls), so
 * a command is just the words on the line — `pause`, `shutdown`, `status`.
 * Nothing coming from the game's chat can reach this function.
 */
function parseCommandLine (raw) {
  const text = String(raw || '').trim().replace(/^\/+/, '')
  if (!text) return null
  return parseTokens(text)
}

function parseTokens (text) {
  const parts = String(text || '').split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const name = parts.shift().toLowerCase()
  return { name, args: parts }
}

class Host extends EventEmitter {
  /**
   * @param {{
   *   config?: RuntimeConfig,
   *   dataDir?: string,
   *   logger?: {info:Function,warn:Function,error:Function,debug:Function},
   *   tag?: string,
   *   createSession?: (hooks:object) => object,
   *   startSession?: (hooks:object) => object,   // alias of createSession
   *   now?: () => number,
   *   setTimer?: Function, clearTimer?: Function,
   *   wasEverConnected?: boolean
   * }} opts
   */
  constructor ({
    config = null,
    dataDir = null,
    logger = null,
    tag = 'zincai',
    createSession = null,
    startSession = null,
    now = () => Date.now(),
    setTimer = null,
    clearTimer = null,
    wasEverConnected = false
  } = {}) {
    super()
    this.now = now
    this.dataDir = dataDir
    this.tag = tag
    this.logger = logger || { info () {}, warn () {}, error () {}, debug () {} }
    this.log = (level, msg) => this.logger[level]?.(this.tag, msg)

    this.config = config || new RuntimeConfig({
      file: dataDir ? require('path').join(dataDir, 'runtime-config.json') : null,
      logger: (level, msg) => this.log(level === 'warn' ? 'warn' : 'info', msg)
    })

    // Session-owned subsystems, filled by attachSession().
    this.session = null
    this.subsystems = {}

    /** ControlState: the pause flag and what it was set for. */
    this.paused = false
    this.pauseReason = ''
    this.pausedAt = 0
    this.pauseCount = 0
    this.resumeCount = 0
    /** Set when a resume needs a world reconciliation before goals restart. */
    this.needsReconcile = false

    const getBot = () => this.session?.bot || null
    this.boundary = new PhysicalBoundary({
      config: this.config,
      state: {
        isPaused: () => this.paused,
        isDead: () => this.isDead(),
        connection: () => this.connection?.state || STATES.DISCONNECTED,
        physicalRefusal: () => this.physicalRefusal()
      },
      logger: (level, msg) => this.log(level, msg),
      now,
      getPosition: () => this.position(),
      getDimension: () => this.dimension(),
      isPhysicalBusy: () => this.physicalBusy(),
      isEmergency: () => this.emergency()
    })
    this.boundary.on('refused', (entry) => {
      // One debug line per refusal burst would flood the panel log; the count
      // is in `status` and the last few are shown there.
      this.log('debug', `physical action refused: ${entry.what} — ${entry.why}`)
    })

    this.death = new DeathRecovery({
      config: this.config,
      logger: (level, msg) => this.log(level, msg),
      now,
      getPosition: () => this.position(),
      getDimension: () => this.dimension(),
      getHealth: () => this.health(),
      getInventory: () => this.inventory(),
      checkRoute: (from, to, dim) => this.checkRoute(from, to, dim)
    })

    const factory = createSession || startSession
    this.connection = new ConnectionManager({
      createSession: (hooks) => this._openSession(factory, hooks),
      config: this.config,
      logger: (level, msg) => this.log(level, msg),
      now,
      ...(setTimer ? { setTimer } : {}),
      ...(clearTimer ? { clearTimer } : {}),
      wasEverConnected
    })
    this.connection.on('fatal', (info) => this.emit('fatal', info))
    this.connection.on('state', (entry) => {
      this.emit('connection', entry)
      if (entry.to === STATES.DISCONNECTED) this.needsReconcile = true
    })

    // The link watchdog measures the two things that explain a "timeout": how
    // long the server has been silent, and how long THIS process blocked the
    // event loop. Both are needed, because minecraft-protocol arms a wall-clock
    // keepalive deadline that a stalled loop cannot honour.
    this.watchdog = new LinkWatchdog({
      config: this.config,
      logger: (level, msg) => this.log(level, msg),
      now
    })

    // The agent loop is the supervisor that turns those measurements into one
    // safe action. It only ever does what the operator could have typed.
    this.agentLoop = new AgentLoop({
      config: this.config,
      connection: this.connection,
      watchdog: this.watchdog,
      logger: (level, msg) => this.log(level, msg),
      now,
      isProcessHealthy: () => this._heartbeatHealthy(),
      onCrashLoop: (info) => {
        this.log('error', `agent loop: crash loop detected (${info.drops} drops) — staying down until the cause is fixed`)
      }
    })

    /** Advanced once per agent-loop tick: lets the watchdog tell "blocked" from "idle". */
    this._lastTickAt = now()

    /** Command history for `status`/audit: { at, by, name, ok }. */
    this.commandLog = []
    /** Answers produced by console commands, for the test harness and the log. */
    this.answers = []
    this._stdinAttached = false
  }

  // ============================================================ session ===

  _openSession (factory, hooks) {
    if (!factory) return null
    const session = factory({
      host: this,
      config: this.config,
      boundary: this.boundary,
      epoch: hooks?.epoch,
      onSpawn: hooks?.onSpawn,
      onEnded: hooks?.onEnded
    })
    return session || null
  }

  /**
   * A session has been built: register it and everything it exposes. Called by
   * the session factory itself, BEFORE the bot is asked to join, so `status`
   * works during CONNECTING.
   */
  attachSession (session) {
    this.session = session
    this.subsystems = session.subsystems || {}
    this.needsReconcile = false
    // A session started outside the manager (main() attaches one directly, a
    // test rig does too) still belongs to the link: adopt it, so `leave` and
    // `restart-connection` dispose it instead of reporting "nothing attached".
    try {
      const c = this.connection
      if (c && !c.destroyed && c.session !== session) {
        c.session = session
        c.bot = session.bot || null
      }
    } catch { /* noop */ }
    try {
      this.applyPendingChanges({ force: true })
    } catch { /* a pending change must never break attach */ }
    this.emit('session', { session })
    return session
  }

  /** The session was disposed (link closed, leave, restart). */
  detachSession (session = null) {
    if (session && this.session !== session) return false
    this.session = null
    this.subsystems = {}
    this.needsReconcile = true
    this.emit('detach', {})
    return true
  }

  /** The session's bot spawned (first join or respawn): the link is live. */
  noteSpawn ({ first = false } = {}) {
    // A session started directly (a test rig, or a host that never went through
    // ConnectionManager.join) still has to be able to act: the spawn is proof
    // enough that the link is up.
    try {
      if (this.connection && this.connection.state !== STATES.CONNECTED && !this.connection.destroyed) {
        this.connection.everConnected = true
        this.connection.connectedAt = this.connection.connectedAt || this.now()
        this.connection._transition(STATES.CONNECTED, 'spawned (session attached directly)')
      }
    } catch { /* noop */ }
    this.emit('spawn', { first })
    if (this.needsReconcile) this.needsReconcile = false
    return true
  }

  // =========================================================== read model ==

  position () { return this.session?.bot?.entity?.position || null }
  health () { return Number.isFinite(this.session?.bot?.health) ? this.session.bot.health : null }
  food () { return Number.isFinite(this.session?.bot?.food) ? this.session.bot.food : null }
  dimension () {
    const bot = this.session?.bot
    try { return require('./places').PlaceIndex.dimensionOf(bot) } catch { return 'overworld' }
  }

  inventory () {
    try { return this.session?.bot?.inventory?.items?.() || [] } catch { return [] }
  }

  isDead () { return Boolean(this._dead) }
  markDead (yes = true) {
    this._dead = Boolean(yes)
    if (yes) this.emit('dead', { at: this.now() })
  }

  physicalBusy () {
    const s = this.session
    if (!s) return false
    try {
      if (s.busy?.()) return true
      const lanes = s.lanes
      if (lanes && typeof lanes.bodyHolder === 'function' && lanes.bodyHolder()) return true
    } catch { /* partial session */ }
    return false
  }

  emergency () {
    try { return Boolean(this.session?.emergency?.()) } catch { return false }
  }

  /** Why no physical action may happen at all right now, or null. */
  physicalRefusal () {
    // Order matters: being away from the server and being dead are facts about
    // the body, an operator pause is a choice on top of them. Report the fact.
    if (this.connection && this.connection.state !== STATES.CONNECTED) return 'not connected to the server'
    if (!this.session) return 'not connected to the server'
    if (this.isDead()) return 'dead; waiting for respawn'
    if (this.paused) return 'the body is paused by an operator (resume to continue)'
    return null
  }

  /** Best-effort route check used by the death recovery (never throws). */
  async checkRoute (from, to, dim) {
    const checker = this.subsystems?.checkRoute
    if (typeof checker !== 'function') return { ok: true, why: 'not checked' }
    return checker(from, to, dim)
  }

  // ============================================================= lifecycle ==

  /**
   * Start the link according to the configuration. Called once by main().
   */
  boot () {
    if (this.config.get('connection.joinOnStart') === false) {
      this.log('info', 'connection.joinOnStart is false — the process is up and waiting for "join"')
      return { ok: true, state: this.connection.state, waiting: true }
    }
    return this.connection.join({ reason: 'startup' })
  }

  /**
   * PAUSE THE BODY. Idempotent. Never touches memory, identity, goals' data or
   * the process.
   * @param {{ reason?:string, by?:string, cancelJobs?:boolean }} [opts]
   */
  stop ({ reason = 'operator stop', by = 'operator', cancelJobs = true } = {}) {
    const already = this.paused
    this.paused = true
    this.pauseReason = String(reason || 'operator stop').slice(0, 120)
    this.pausedAt = this.now()
    this.pauseCount++
    // What was running is interrupted; nothing is restarted by itself.
    const details = { interrupted: [], suspended: [], cancelledJobs: 0 }
    const s = this.session
    if (s && !already) {
      try { details.interrupted.push(...(s.stopPhysical?.() || [])) } catch (err) { this.log('debug', `stop: ${err?.message || err}`) }
    }
    // Goals are SUSPENDED with their checkpoints — never deleted, never reset.
    const goals = this.subsystems?.goals
    if (goals) {
      try {
        for (const goal of goals.openGoals()) {
          const r = goals.suspend(goal.id, { reason: `paused (${this.pauseReason})`, by: 'operator' })
          if (r.ok) details.suspended.push(goal.id)
        }
        try { goals.save({ force: true }) } catch { /* best effort */ }
      } catch (err) { this.log('debug', `stop: goal suspension failed: ${err?.message || err}`) }
    }
    if (cancelJobs) {
      try {
        const jobs = this.subsystems?.jobs
        if (jobs) {
          for (const job of jobs.active()) if (jobs.cancel(job.id, 'paused by operator')) details.cancelledJobs++
        }
      } catch (err) { this.log('debug', `stop: job cancellation failed: ${err?.message || err}`) }
    }
    // The link stays up: a paused bot is still in the world, it just does not act.
    this.emit('paused', { reason: this.pauseReason, by, details })
    this.log('warn', `body paused (${this.pauseReason})${details.suspended.length ? ` — ${details.suspended.length} goal(s) suspended` : ''}${details.cancelledJobs ? `, ${details.cancelledJobs} job(s) cancelled` : ''}`)
    return { ok: true, alreadyPaused: already, paused: true, ...details }
  }

  /**
   * UNPAUSE. Reconciles the world first, then resumes only work that is still
   * valid. A goal whose work already happened is completed, not repeated.
   */
  async resume ({ by = 'operator', reconcile = true } = {}) {
    if (!this.paused) return { ok: true, alreadyRunning: true, paused: false, resumed: [], completed: [], dropped: [] }
    const result = { ok: true, paused: false, reconciled: null, resumed: [], completed: [], dropped: [], kept: [] }
    // 1. World + inventory reconciliation before anything restarts.
    if (reconcile && this.session && this.connection.state === STATES.CONNECTED) {
      try {
        result.reconciled = await this.reconcileWorld()
      } catch (err) { this.log('warn', `resume: reconciliation failed: ${err?.message || err}`) }
    }
    this.paused = false
    this.pauseReason = ''
    this.pausedAt = 0
    this.resumeCount++
    // 2. Only now may the body act again — and each goal is checked against the
    //    world before it is handed back to the scheduler.
    const s = this.session
    const goals = this.subsystems?.goals
    if (goals) {
      for (const goal of goals.list({ status: STATUS.suspended })) {
        let verdict = null
        try {
          verdict = s?.verifyGoal ? await s.verifyGoal(goal.id) : { state: 'unknown', note: 'not checked' }
        } catch (err) { verdict = { state: 'unknown', note: String(err?.message || err) } }
        if (verdict?.state === 'complete') { result.completed.push(goal.id); continue }
        if (verdict?.state === 'invalid') { result.dropped.push({ id: goal.id, why: verdict.note }); continue }
        // Never blindly repeat: a goal that cannot be verified goes back as
        // resumable+needsVerify so the model (not the scheduler) decides.
        if (verdict?.state === 'unknown') {
          goals.update(goal.id, { needsVerify: true })
          result.kept.push({ id: goal.id, why: verdict.note })
          continue
        }
        const r = goals.suspend(goal.id, { reason: 'ready to resume (verified)', by: 'operator' })
        if (r.ok) { goals.update(goal.id, { needsVerify: true }); result.resumed.push(goal.id) }
      }
      try { goals.save({ force: true }) } catch { /* best effort */ }
    }
    try { s?.onResumed?.({ reconciled: result.reconciled }) } catch (err) { this.log('debug', `resume hook: ${err?.message || err}`) }
    this.emit('resumed', result)
    this.log('info', `body resumed${result.resumed.length ? ` — ${result.resumed.length} goal(s) handed back` : ''}${result.completed.length ? `, ${result.completed.length} already done` : ''}`)
    return result
  }

  /**
   * Inspect the ACTUAL player state and report what changed. Used by `resume`,
   * by a reconnect and by death recovery.
   */
  async reconcileWorld () {
    const bot = this.session?.bot
    const pos = this.position()
    const report = {
      at: this.now(),
      position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
      dimension: this.dimension(),
      health: this.health(),
      food: this.food(),
      inventory: this.inventory().map((i) => ({ name: i.name, count: i.count })).slice(0, 36),
      stale: false
    }
    try { report.places = this.subsystems?.places?.blocks?.size ?? null } catch { /* noop */ }
    if (bot && this.subsystems?.reconcileEngine) {
      try { report.engine = await this.subsystems.reconcileEngine() } catch (err) { report.engine = { error: String(err?.message || err).slice(0, 120) } }
    }
    this.emit('reconciled', report)
    return report
  }

  // ============================================================= commands ==

  /**
   * Authorise and run one command.
   *
   * @param {string} line the command text, without the chat prefix when it came
   *   from chat (the caller strips it) or with it (both are accepted)
   * @param {{ source?:'chat'|'console'|'internal', uuid?:string|null, name?:string|null,
   *           raw?:string }} [from]
   * @returns {Promise<{ ok:boolean, silent?:boolean, reply?:string, name?:string }>}
   */
  async command (line, from = {}) {
    const source = from.source || 'console'
    const parsed = parseCommandLine(line)
    if (!parsed) return { ok: false, silent: true }
    const { name, args } = parsed
    const spec = COMMANDS.find((c) => c.name === name)
    const who = { source, uuid: from.uuid || null, name: from.name || null }

    // 1. Authorisation. Console and internal callers only.
    //
    // There is no `chat` source any more: a command cannot arrive over the
    // game's chat, so there is no UUID list to consult and no way for a player
    // to probe the surface. `control.allowConsole: false` is the one switch
    // left, for a deployment that wants the host controllable only by its own
    // supervisor calls rather than by anyone with stdin on the container.
    const auth = this.authorize(who)
    if (!auth.ok) {
      if (this.config.get('control.auditLog') !== false) {
        this.log('warn', `control: refused a "${name}"-shaped command from ${source} (${auth.why})`)
      }
      this.emit('unauthorized', { name, source, why: auth.why })
      return { ok: false, silent: true, unauthorized: true, name }
    }
    if (!spec) {
      const reply = `unknown command "${name}" — try: help`
      this._audit(name, who, false)
      return { ok: false, name, reply }
    }
    let result
    try {
      result = await this.dispatch(name, args, who)
    } catch (err) {
      result = { ok: false, reply: `${name} failed: ${String(err?.message || err).slice(0, 160)}` }
      this.log('error', `control: ${name} failed: ${err?.message || err}`)
    }
    this._audit(name, who, result.ok)
    const out = { name, ok: result.ok !== false, reply: result.reply || '', data: result.data || null, whisper: result.whisper !== false }
    if (out.reply) this.answers.push({ at: this.now(), name, reply: out.reply, by: who.name, source })
    if (this.answers.length > 50) this.answers.shift()
    // The answer is never broadcast: it goes to the operator who asked.
    try { this.onAnswer?.(out, who) } catch (err) { this.log('debug', `control: answer delivery failed: ${err?.message || err}`) }
    return out
  }

  /**
   * Is this sender allowed to control the bot?
   *
   * Only console and internal callers exist. The old branches — a chat source,
   * a `control.operators` UUID allow-list, "the sender has no verified UUID" —
   * are gone with the chat command surface. Whoever holds the process's stdin
   * is the operator; that is the whole model.
   */
  authorize ({ source = 'console', name = null } = {}) {
    if (source === 'internal') return { ok: true, why: 'internal' }
    if (source === 'console') {
      if (this.config.get('control.allowConsole') === false) return { ok: false, why: 'console commands are disabled (control.allowConsole)' }
      return { ok: true, why: 'console', name: name || null }
    }
    return { ok: false, why: `source "${source}" cannot control this process; control is console-only` }
  }

  _audit (name, who, ok) {
    this.commandLog.push({ at: this.now(), name, by: who.name, source: who.source, ok: Boolean(ok) })
    if (this.commandLog.length > 100) this.commandLog.shift()
    if (this.config.get('control.auditLog') === false) return
    const tail = commandTail(name, this)
    this.log(ok ? 'info' : 'warn', `control: ${name} by ${who.name || who.uuid || who.source}${tail ? ` ${tail}` : ''}`)
  }

  /** Run one already-authorised command. */
  /**
   * Is the process itself responsive? The agent loop uses this to avoid blaming
   * the network for a blocked event loop: a tick that should have run
   * agent.intervalMs ago and did not means the loop is wedged, and touching the
   * link from inside a wedged loop makes it worse.
   */
  _heartbeatHealthy () {
    const budget = Math.max(5_000, this.agentLoop ? this.agentLoop.intervalMs() * 4 : 60_000)
    return this.now() - this._lastTickAt <= budget
  }

  /** Start the link watchdog and the agent loop (idempotent). */
  startSupervision () {
    let started = false
    try { started = this.watchdog.start() || started } catch (err) { this.log('warn', `watchdog did not start: ${err?.message || err}`) }
    if (this.config.get('agent.enabled') !== false) {
      try { started = this.agentLoop.start() || started } catch (err) { this.log('warn', `agent loop did not start: ${err?.message || err}`) }
    }
    return started
  }

  /** Stop both. The measurements stop; nothing on disk is touched. */
  stopSupervision () {
    try { this.watchdog.stop() } catch { /* noop */ }
    try { this.agentLoop.stop() } catch { /* noop */ }
  }

  async dispatch (name, args = [], who = { source: 'internal' }) {
    switch (name) {
      case 'status': return this.commandStatus()
      // `pause` and `stop` are the same handbrake; both words work because both
      // are in people's fingers. Reversible, deletes nothing.
      case 'pause':
      case 'stop': return { ok: true, reply: this._stopReply(this.stop({ reason: `paused by ${who.name || who.source}`, by: who.name || who.source })) }
      case 'resume': return { ok: true, reply: this._resumeReply(await this.resume({ by: who.name || who.source })) }
      case 'leave': {
        const r = this.connection.leave({ reason: `left by ${who.name || who.source}` })
        if (this.paused === false) this.stop({ reason: 'link left', by: who.name || who.source })
        return { ok: r.ok, reply: `left the server (link ${this.connection.state}); the process, goals and this interface are still running` }
      }
      case 'join': {
        const r = this.connection.rejoin({ reason: `joined by ${who.name || who.source}` })
        return {
          ok: r.ok,
          reply: r.ok
            ? `joining ${this.describeServer()} (link ${this.connection.state}); goals stay suspended until the world is reconciled`
            : `could not join: ${r.why || this.connection.lastError || 'already connecting'}`
        }
      }
      case 'restart-connection': {
        const r = this.connection.restart({ reason: `restart-connection by ${who.name || who.source}` })
        return { ok: r.ok, reply: r.ok ? `re-established the link to ${this.describeServer()} (link ${this.connection.state})` : `could not restart the link: ${r.why || 'unknown'}` }
      }
      case 'goals': return this.commandGoals()
      case 'jobs': return this.commandJobs()
      case 'cancel': return this.commandCancel(args[0])
      case 'config': return this.commandConfig(args)
      // `update`: stop, pull, restart. The pull itself cannot happen in this
      // process (the modules are already loaded), so this exits with a distinct
      // code and the supervisor — or a detached child — does the checkout and
      // starts the new code.
      case 'update': return this.commandUpdate(args)
      case 'link': return this.commandLink(args)
      case 'watchdog': return this.commandWatchdog(args)
      // The emergency stop: not a policy change, the end of the process. State
      // is saved by the session's shutdown() before the exit, so a later start
      // resumes from disk; `pause` is the reversible version.
      case 'shutdown': {
        const code = Number.isFinite(Number(args[0])) ? Number(args[0]) : 0
        const reply = `shutting down (exit ${code}) — state is saved first; use pause instead if you only want the body stopped`
        // Deferred so the reply reaches the console before the process dies.
        setImmediate(() => {
          try {
            if (this.session?.shutdown) this.session.shutdown(code, `shutdown by ${who.name || who.source}`)
            else { this.shutdown({ reason: `shutdown by ${who.name || who.source}` }); setTimeout(() => process.exit(code), 250) }
          } catch { process.exit(code) }
        })
        return { ok: true, reply, data: { exitCode: code } }
      }
      case 'help': return { ok: true, reply: helpText(this) }
      default: return { ok: false, reply: `unknown command "${name}" — try: help` }
    }
  }

  // --------------------------------------------------------------- update --

  /**
   * `update`: stop the body, pull, restart on the new code.
   *
   * Order matters. The body is paused and the state saved BEFORE git runs, so a
   * failure to fetch leaves a paused, consistent bot rather than a half-stopped
   * one — and the refusal cases (dirty tree, no git) are decided before anything
   * is touched at all.
   */
  async commandUpdate (args = []) {
    // The repository root is this file's parent: zincai/host.js → <repo>.
    const cwd = this.rootDir || path.join(__dirname, '..')
    // A supervisor (scripts/update.js, or the panel) restarts us after the exit.
    // Without one, updater spawns a detached child to do the checkout instead.
    const hasSupervisor = Boolean(process.env.ZINC_SUPERVISED)
    // 1. Stop cleanly first: no writes racing the checkout, no goal mid-action.
    try { this.stop({ reason: 'update', by: 'update' }) } catch { /* best effort */ }
    try { this.config.save() } catch { /* best effort */ }

    const result = await updater.performUpdate({
      cwd,
      config: this.config,
      logger: (level, msg) => this.log(level, msg),
      supervisor: hasSupervisor,
      spawn: hasSupervisor ? null : undefined
    })
    if (!result.ok) {
      // Nothing was pulled and the process is still here. Say why, and leave the
      // body paused: an operator who asked for an update does not want it acting
      // on stale code while they read the error.
      this.log('error', result.reply)
      return { ok: false, reply: result.reply, data: { steps: result.steps || [] } }
    }
    return { ok: true, reply: result.reply, data: { steps: result.steps || [] } }
  }

  // ----------------------------------------------------------------- link --

  /** `link [explain]`: the watchdog's evidence for the last disconnect. */
  commandLink (args = []) {
    const w = this.watchdog
    const snap = w.snapshot()
    const wantExplain = String(args[0] || '').toLowerCase() === 'explain'
    const lines = []
    lines.push(`link: ${this.connection.state}${snap.silentForMs !== null ? `, last packet ${Math.round(snap.silentForMs / 1000)}s ago` : ''}`)
    lines.push(`  keepalives: ${snap.sent} sent, ${snap.recv} received`)
    lines.push(`  deadline: ${Math.round(snap.checkTimeoutMs / 1000)}s (connection.checkTimeoutMs) — the client ends the link itself if a keep_alive does not arrive in that window`)
    lines.push(`  worst event-loop stall: ${snap.maxStallMs}ms${snap.maxStallMs >= 250 ? ' ← long enough to miss a keepalive' : ''}`)
    if (wantExplain || this.connection.state !== STATES.CONNECTED) lines.push(w.explain())
    lines.push('  recent drops:')
    if (!snap.ends.length) lines.push('    none since this link started')
    for (const e of snap.ends) {
      lines.push(`    ${new Date(e.at).toISOString()}  ${e.cause}  (${e.kind}${e.text ? `: ${e.text.slice(0, 60)}` : ''})`)
    }
    return { ok: true, reply: lines.join('\n'), data: snap }
  }

  // ------------------------------------------------------------- watchdog --

  /** `watchdog [on|off]`: the supervisor's counters and what it has done. */
  commandWatchdog (args = []) {
    const verb = String(args[0] || '').toLowerCase()
    if (verb === 'on' || verb === 'off') {
      const value = verb === 'on'
      const verdict = this.config.set ? this.config.set('agent.surviveKicks', value) : null
      if (verdict && verdict.ok === false) return { ok: false, reply: `could not change agent.surviveKicks: ${verdict.why || 'rejected'}` }
      if (value && !this.agentLoop.running && this.config.get('agent.enabled') !== false) this.agentLoop.start()
      return { ok: true, reply: `agent loop survival is now ${value ? 'on' : 'off'}${value ? '' : ' — the link will only be re-armed by connection.autoReconnect and by you'}` }
    }
    const a = this.agentLoop.snapshot()
    const w = this.watchdog.snapshot()
    const lines = [
      `agent loop: ${a.running ? 'running' : 'stopped'}, every ${Math.round(a.intervalMs / 1000)}s, survival ${a.enabled ? 'on' : 'off'}`,
      `  ${this.agentLoop.summary()}`,
      `  worst stall: ${w.maxStallMs}ms across ${w.stalls.length} recorded stall(s)`,
      'recent actions:'
    ]
    if (!a.actions.length) lines.push('    none — nothing has needed fixing')
    for (const act of a.actions) {
      lines.push(`    ${new Date(act.at).toISOString()}  ${act.what}${act.detail ? ` (${act.detail})` : ''}`)
    }
    return { ok: true, reply: lines.join('\n'), data: { agent: a, watchdog: w } }
  }

  describeServer () {
    const cfg = this.subsystems?.cfg || {}
    const host = cfg.server?.host || 'the configured server'
    const port = cfg.server?.port ? `:${cfg.server.port}` : ''
    return `${host}${port}`
  }

  // ---------------------------------------------------------------- status --

  commandStatus () {
    return { ok: true, reply: this.statusText(), data: this.status() }
  }

  /** The machine-readable status behind the `status` command. */
  status () {
    const s = this.session
    const goals = this.subsystems?.goals || null
    const jobs = this.subsystems?.jobs || null
    let goalCounts = {}
    try { goalCounts = goals?.summary?.() || {} } catch { /* no session */ }
    const link = this.connection.snapshot()
    const boundary = this.boundary.snapshot()
    const pos = this.position()
    return {
      connection: link,
      paused: this.paused,
      pauseReason: this.pauseReason,
      pausedFor: this.pausedAt ? this.now() - this.pausedAt : 0,
      dead: this.isDead(),
      alive: !this.isDead() && link.state === STATES.CONNECTED,
      position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
      dimension: this.dimension(),
      health: this.health(),
      food: this.food(),
      activity: this.activity(),
      goals: { counts: goalCounts, open: goalCounts.active || goalCounts.suspended || goalCounts.pending || goalCounts.resumable ? (goalCounts.active || 0) + (goalCounts.suspended || 0) + (goalCounts.pending || 0) + (goalCounts.resumable || 0) : 0 },
      jobs: { active: jobs ? jobs.active().length : 0 },
      limits: this.limits(),
      boundary,
      death: this.death.snapshot(),
      pendingConfig: this.config.pendingChanges().map((p) => p.name),
      commands: this.commandLog.length,
      // The two answers to "why does it keep getting kicked": what the link has
      // been doing, and whether this process is capable of keeping up with it.
      link: {
        lastCause: this.watchdog.ends.length ? this.watchdog.ends[this.watchdog.ends.length - 1].cause : null,
        silentForMs: this.watchdog.snapshot().silentForMs,
        checkTimeoutMs: this.watchdog.checkTimeoutMs(),
        maxStallMs: this.watchdog.snapshot().maxStallMs,
        drops: this.watchdog.ends.length
      },
      agent: this.agentLoop.snapshot()
    }
  }

  /** Current activity, in words. */
  activity () {
    const s = this.session
    if (this.paused) return 'paused (no physical action)'
    if (this.isDead()) return 'dead (waiting for respawn)'
    if (this.connection.state !== STATES.CONNECTED) return `idle (${this.connection.state.toLowerCase()})`
    try {
      const doing = s?.activity?.()
      if (doing) return String(doing).slice(0, 200)
    } catch { /* partial session */ }
    return 'idle'
  }

  /** Every effective limit, defaults included. */
  limits () {
    return {
      actions: {
        movement: this.config.get('actions.allowMovement'),
        dig: this.config.get('actions.allowDig'),
        place: this.config.get('actions.allowPlace'),
        attack: this.config.get('actions.allowAttack'),
        containers: this.config.get('actions.allowContainers'),
        use: this.config.get('actions.allowUse'),
        equip: this.config.get('actions.allowEquip'),
        eat: this.config.get('actions.allowEat'),
        toss: this.config.get('actions.allowToss'),
        craft: this.config.get('actions.allowCraft'),
        scripts: this.config.get('actions.allowScripts')
      },
      communication: {
        publicChat: this.config.get('communication.publicChat'),
        privateMessages: this.config.get('communication.privateMessages'),
        replyToChat: this.config.get('communication.replyToChat')
      },
      rates: {
        maxPhysicalActionsPerMinute: this.config.get('limits.maxPhysicalActionsPerMinute'),
        maxConcurrentJobs: this.config.get('limits.maxConcurrentJobs'),
        maxGoalRuntimeMinutes: this.config.get('limits.maxGoalRuntimeMinutes')
      },
      boundary: this.config.get('boundary.enabled')
        ? {
            dimension: this.config.get('boundary.dimension'),
            centre: [this.config.get('boundary.centerX'), this.config.get('boundary.centerZ')],
            radius: this.config.get('boundary.radius'),
            blockOutside: this.config.get('boundary.blockOutside'),
            home: [this.config.get('boundary.homeX'), this.config.get('boundary.homeY'), this.config.get('boundary.homeZ')],
            returnHomeOnDeath: this.config.get('boundary.returnHomeOnDeath')
          }
        : 'off'
    }
  }

  statusText () {
    const st = this.status()
    const link = st.connection
    const L = []
    L.push(`connection: ${link.state}${link.state === STATES.CONNECTED && link.connectedForMs ? ` for ${fmtAge(link.connectedForMs)}` : ''}${link.attempts ? ` (retry ${link.attempts}/${link.maxRetries})` : ''}${link.lastError && link.state !== STATES.CONNECTED ? ` — ${link.lastError}` : ''}`)
    L.push(`paused: ${st.paused ? `YES (${st.pausedFor ? `${fmtAge(st.pausedFor)} ago` : 'just now'}; ${st.pauseReason || 'no reason'})` : 'no'}`)
    L.push(`life: ${st.dead ? 'DEAD (waiting for respawn)' : 'alive'}${st.health !== null ? `, health ${st.health}` : ''}${st.food !== null ? `, food ${st.food}` : ''}${st.position ? `, at ${st.position.x},${st.position.y},${st.position.z} in the ${st.dimension}` : ''}`)
    L.push(`activity: ${st.activity}`)
    const g = st.goals.counts || {}
    L.push(`goals: ${g.active || 0} active, ${g.suspended || 0} suspended, ${(g.pending || 0) + (g.resumable || 0)} waiting, ${g.completed || 0} completed`)
    const jobs = this.subsystems?.jobs
    if (jobs) {
      const active = jobs.active()
      L.push(`jobs: ${active.length} active${active.length ? ` — ${active.slice(0, 4).map((j) => `${j.id} ${j.tool || j.kind}${j.goalId ? `(${j.goalId})` : ''}`).join(', ')}` : ''}`)
    } else L.push('jobs: 0 active')
    const limits = st.limits
    const off = Object.entries(limits.actions).filter(([, v]) => v === false).map(([k]) => k)
    L.push(`limits: ${st.boundary.actionsLastMinute}/${limits.rates.maxPhysicalActionsPerMinute} physical actions last minute; public chat ${limits.communication.publicChat ? 'on' : 'off'}; private messages ${limits.communication.privateMessages ? 'on' : 'off'}; permissions off: ${off.length ? off.join(',') : 'none'}`)
    L.push(`boundary: ${st.boundary.boundary ? `${st.boundary.boundary.dimension} r=${st.boundary.boundary.radius} around ${st.boundary.boundary.center.join(',')}${limits.boundary.blockOutside ? '' : ' (report only)'}` : 'off'}`)
    if (st.pendingConfig.length) L.push(`pending config: ${st.pendingConfig.join(', ')} (apply at the next safe boundary)`)
    const refused = st.boundary.lastRefusals || []
    if (refused.length) L.push(`last refusals: ${refused.slice(-3).map((r) => `${r.what}: ${r.why}`).join(' | ')}`)
    return L.join('\n')
  }

  _stopReply (r) {
    const bits = ['body paused — no new physical action will start']
    if (r.interrupted?.length) bits.push(`interrupted ${r.interrupted.join(', ')}`)
    if (r.suspended?.length) bits.push(`${r.suspended.length} goal(s) suspended with their checkpoints`)
    if (r.cancelledJobs) bits.push(`${r.cancelledJobs} job(s) cancelled`)
    bits.push('memory, identity, goals and the process are untouched')
    return bits.join('; ')
  }

  _resumeReply (r) {
    const bits = ['body resumed']
    if (r.reconciled) bits.push(`world reconciled (${r.reconciled.position ? `at ${r.reconciled.position.x},${r.reconciled.position.y},${r.reconciled.position.z}` : 'position unknown'}${r.reconciled.health !== null ? `, health ${r.reconciled.health}` : ''})`)
    if (r.resumed?.length) bits.push(`${r.resumed.length} goal(s) handed back to the scheduler (verified first)`)
    if (r.completed?.length) bits.push(`${r.completed.length} already done in the world — marked completed instead of repeated`)
    if (r.dropped?.length) bits.push(`${r.dropped.length} no longer valid (${r.dropped.map((d) => d.id).join(', ')})`)
    if (r.kept?.length) bits.push(`${r.kept.length} kept for a decision (cannot be verified from here)`)
    return bits.join('; ')
  }

  // ----------------------------------------------------------------- goals --

  commandGoals () {
    const goals = this.subsystems?.goals
    if (!goals) return { ok: true, reply: 'goals: registry not loaded yet (no session)' }
    const open = goals.list({ open: true })
    const closes = goals.list().filter((g) => !['pending', 'active', 'suspended', 'resumable'].includes(g.status))
    const by = (s) => open.filter((g) => g.status === s)
    const L = []
    const sec = (label, list) => {
      if (!list.length) return
      L.push(`${label} (${list.length}):`)
      for (const g of list.slice(0, 8)) L.push(`  ${goals.describe(g)}`)
      if (list.length > 8) L.push(`  … and ${list.length - 8} more`)
    }
    sec('active', by('active'))
    sec('suspended', by('suspended'))
    sec('waiting', [...by('pending'), ...by('resumable')])
    sec('completed', closes.filter((g) => g.status === 'completed').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)))
    sec('failed / cancelled', closes.filter((g) => g.status === 'failed' || g.status === 'cancelled').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)))
    if (!L.length) return { ok: true, reply: 'goals: none recorded' }
    return { ok: true, reply: L.join('\n'), data: goals.list() }
  }

  // ------------------------------------------------------------------ jobs --

  commandJobs () {
    const jobs = this.subsystems?.jobs
    if (!jobs) return { ok: true, reply: 'jobs: no job registry yet (no session)' }
    const all = jobs.list()
    const active = all.filter((j) => j.state === 'pending' || j.state === 'running')
    const done = all.filter((j) => j.state !== 'pending' && j.state !== 'running').slice(-6)
    const L = []
    L.push(`jobs: ${active.length} active, ${all.length} total`)
    if (active.length) {
      for (const j of active) {
        // Resource ownership: which lane and which goal holds what.
        const res = j.state === 'pending' ? 'waiting for the BODY lane' : `${j.lane} lane`
        const prog = j.progress ? ` progress ${typeof j.progress === 'number' ? j.progress : JSON.stringify(j.progress).slice(0, 60)}` : ''
        L.push(`  ${j.id} ${j.state} ${j.tool || j.kind} — ${res}${j.goalId ? `, goal ${j.goalId}` : ''}${prog}${j.cancelled ? ' (cancelling)' : ''}`)
      }
    }
    for (const j of done) L.push(`  ${j.id} ${j.state} ${j.tool || j.kind}${j.goalId ? `, goal ${j.goalId}` : ''}${j.error ? ` — ${j.error.slice(0, 80)}` : ''}`)
    return { ok: true, reply: L.join('\n'), data: all }
  }

  // ---------------------------------------------------------------- cancel --

  commandCancel (id) {
    const goals = this.subsystems?.goals
    if (!id) return { ok: false, reply: 'cancel needs a goal id (see: goals)' }
    if (!goals) return { ok: false, reply: 'cancel: the goal registry is not loaded yet (no session)' }
    const goal = goals.get(id) || goals.find(id)
    if (!goal) return { ok: false, reply: `cancel: no goal matches "${String(id).slice(0, 40)}"` }
    // Cancel THIS goal and the jobs that belong to it; nothing else.
    let cancelledJobs = 0
    try {
      const jobs = this.subsystems?.jobs
      if (jobs) cancelledJobs = jobs.cancelForGoal(goal.id, 'goal cancelled by operator')
    } catch { /* best effort */ }
    const stopped = this.session?.stopGoal ? this.session.stopGoal(goal.id) : false
    const r = goals.cancel(goal.id, { reason: 'cancelled by operator', by: 'operator' })
    try { goals.save({ force: true }) } catch { /* best effort */ }
    if (!r.ok) return { ok: false, reply: `cancel ${goal.id}: ${r.why}` }
    const bits = [`${goal.id} cancelled: ${goal.description}`]
    if (cancelledJobs) bits.push(`${cancelledJobs} job(s) of this goal cancelled`)
    if (stopped) bits.push('its running work was stopped')
    bits.push('other goals untouched')
    return { ok: true, reply: bits.join('; ') }
  }

  // ---------------------------------------------------------------- config --

  async commandConfig (args = []) {
    const sub = String(args[0] || 'show').toLowerCase()
    const rest = args.slice(1)
    if (sub === 'show' || sub === 'get' || sub === '') {
      const target = rest[0] || null
      if (target && RuntimeConfig.has(target)) {
        const def = RuntimeConfig.definition(target)
        return { ok: true, reply: [`${def.name} = ${require('./runtime_config').formatValue(this.config.get(target))}`, `  ${def.describe}`, `  range: ${RuntimeConfig.describeValue(def)}`, `  default: ${require('./runtime_config').formatValue(def.default)}`, `  apply: ${def.apply}`].join('\n') }
      }
      if (target && RuntimeConfig.groups().includes(target)) return { ok: true, reply: this.config.format({ group: target }) }
      if (target) return { ok: false, reply: `config show: unknown parameter or group "${String(target).slice(0, 40)}" — groups: ${RuntimeConfig.groups().join(', ')}` }
      return { ok: true, reply: this.config.format() + this._pendingFooter() }
    }
    if (sub === 'set') {
      const name = rest[0]
      const rawValue = rest.slice(1).join(' ')
      if (!name) return { ok: false, reply: 'config set needs a parameter name and a value (see: config)' }
      if (rawValue === '') return { ok: false, reply: `config set ${name}: needs a value` }
      const r = this.config.set(name, rawValue, { by: 'operator', physicalBusy: this.physicalBusy() })
      if (!r.ok) return { ok: false, reply: `config set refused: ${r.error}` }
      if (r.unchanged) return { ok: true, reply: `${r.name} already ${formatConfigValue(r.value)} — nothing changed` }
      this._afterConfigChange(r.name, r.oldValue, r.value)
      const head = r.applied === 'boundary'
        ? `${r.name}: ${formatConfigValue(r.oldValue)} → ${formatConfigValue(r.value)} recorded, NOT yet in force`
        : `${r.name}: ${formatConfigValue(r.oldValue)} → ${formatConfigValue(r.value)}`
      return { ok: true, reply: r.applied === 'boundary' ? `${head}\n  ${r.reason}` : head, data: r }
    }
    if (sub === 'reset') {
      const name = rest[0]
      if (!name) return { ok: false, reply: 'config reset needs a parameter name' }
      const before = this.config.get(name)
      const r = this.config.reset(name, { by: 'operator' })
      if (!r.ok) return { ok: false, reply: `config reset refused: ${r.error}` }
      this._afterConfigChange(name, before, r.value)
      return { ok: true, reply: `${name}: reset to the default ${formatConfigValue(r.value)}` }
    }
    if (sub === 'groups') return { ok: true, reply: `groups: ${RuntimeConfig.groups().join(', ')}` }
    return { ok: false, reply: `config: unknown subcommand "${sub}" (show|set|reset|groups)` }
  }

  _pendingFooter () {
    const pending = this.config.pendingChanges()
    if (!pending.length) return ''
    return `\npending (waiting for a safe boundary): ${pending.map((p) => `${p.name}=${formatConfigValue(p.value)}`).join(', ')}`
  }

  /** React to a parameter that changes how the runtime behaves right now. */
  _afterConfigChange (name, oldValue, value) {
    if (name.startsWith('connection.') || name === 'connection.autoReconnect') {
      try { this.connection.policyChanged() } catch { /* no retry timer */ }
    }
    try { this.subsystems?.onConfigChange?.(name, oldValue, value) } catch (err) { this.log('debug', `config hook: ${err?.message || err}`) }
  }

  /** Apply changes that were waiting for a safe boundary. */
  applyPendingChanges ({ force = false } = {}) {
    if (!this.config.pendingChanges().length) return []
    const applied = this.config.applyPending({ force, physicalBusy: !force && this.physicalBusy() })
    for (const a of applied) {
      this.log('info', `config: ${a.name} ${formatConfigValue(a.oldValue)} → ${formatConfigValue(a.value)} applied at a safe boundary`)
      this._afterConfigChange(a.name, a.oldValue, a.value)
    }
    return applied
  }

  // --------------------------------------------------------------- console --

  /**
   * Accept commands on stdin, so the PufferPanel console is the control
   * interface when the operator is already in the panel.
   */
  attachStdin (stream = process.stdin) {
    if (this._stdinAttached || !stream || typeof stream.on !== 'function') return false
    this._stdinAttached = true
    const onLine = (buf) => {
      const line = String(buf || '').trim()
      if (!line) return
      this.command(line, { source: 'console', name: 'console' })
        .then((r) => { if (r?.reply) process.stdout.write(`${r.reply}\n`) })
        .catch(() => {})
    }
    let buffer = ''
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk) => {
      buffer += chunk
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        onLine(line)
      }
      if (buffer.length > 4096) buffer = ''
    })
    return true
  }

  // ------------------------------------------------------------- shutdown --

  /** Process shutdown: save everything, close the link. Not reachable by a command. */
  shutdown ({ reason = 'shutdown', quit = true } = {}) {
    try { this.config.save() } catch { /* best effort */ }
    try { this.connection.destroy({ quit }) } catch { /* already gone */ }
    this.emit('shutdown', { reason })
    return true
  }
}

// ------------------------------------------------------------------ helpers

function helpText (host) {
  return require('./control_commands').helpText({
    allowConsole: host.config.get('control.allowConsole') !== false
  })
}

function commandTail (name, host) {
  if (name === 'status' || name === 'help' || name === 'goals' || name === 'jobs') return ''
  return ''
}

function formatConfigValue (value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : '(empty)'
  if (value === '') return '""'
  return String(value)
}

function fmtAge (ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000))
  if (sec < 90) return `${sec}s`
  const min = Math.round(sec / 60)
  return min < 90 ? `${min}m` : `${(min / 60).toFixed(1)}h`
}

module.exports = {
  Host,
  COMMANDS,
  parseCommandLine,
  helpText,
  respawnSummary,
  STATES
}
