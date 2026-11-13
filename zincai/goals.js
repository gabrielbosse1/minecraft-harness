/**
 * goals.js — the durable objective registry.
 *
 * WHY THIS EXISTS
 *   The agenda in index.js (main / paused / shelved / asked) is session RAM:
 *   it holds runnable closures, it is dropped on death (`agenda.main = null`),
 *   it disappears on restart, and the only trace of a replaced objective is a
 *   label string. The model's context is not a task database either: a
 *   compaction, a 180 s model call, or one creeper can erase what the bot was
 *   building.
 *
 *   A goal here is DATA, not a closure:
 *
 *     id, description, kind, origin, priority, parent/related ids, status,
 *     resources, preconditions, dependencies, progress, completion/failure/
 *     interruption/resume conditions, timestamps, checkpoint detail (what to
 *     re-run: blueprint + stage + origin, item + count, player/place/coords),
 *     attempts/resumes/fails, last error, and a short transition history.
 *
 *   Lifecycle:  pending → active → suspended → resumable → completed | failed
 *                                                                  | cancelled
 *   `cancelled` and `completed` are terminal: a cancelled objective can never
 *   be revived by a late tool result. `failed` may be retried only through an
 *   explicit resume *after* the world has been re-checked (see index.js
 *   reconcileGoal): a command succeeding does not prove an objective did.
 *
 *   Persistence: an atomic JSON file in the data dir, written on every
 *   transition (throttled for progress ticks) and on shutdown. On load, any
 *   goal that was `active`/`pending` when the process died becomes
 *   `resumable` with `needsVerify: true` — the world may have changed while
 *   nobody was looking (a chest emptied by a player, a finished build whose
 *   completion event never got saved).
 *
 * Pure data + fs. No mineflayer, no LLM.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const STATUS = Object.freeze({
  pending: 'pending',
  active: 'active',
  suspended: 'suspended',
  resumable: 'resumable',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
})

/** Statuses that still describe unfinished work. */
const OPEN_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'resumable'])
/** Terminal statuses. */
const CLOSED_STATUSES = Object.freeze(['completed', 'failed', 'cancelled'])

/**
 * Allowed transitions. Anything else is refused (and reported) instead of
 * being silently applied, so a late completion event cannot overwrite a
 * cancellation and a cancelled goal cannot be restarted by accident.
 */
// `completed` is reachable from every open state on purpose: verification
// against the world can prove an interrupted (or never-started) goal already
// done — a build finished just before a crash, a chest already emptied into
// the inventory. Terminal states stay terminal.
const LEGAL = Object.freeze({
  pending: ['active', 'suspended', 'resumable', 'cancelled', 'failed', 'completed'],
  active: ['suspended', 'resumable', 'completed', 'failed', 'cancelled'],
  suspended: ['active', 'resumable', 'cancelled', 'failed', 'completed'],
  resumable: ['active', 'suspended', 'cancelled', 'failed', 'completed'],
  completed: [],
  failed: ['active', 'cancelled'],
  cancelled: []
})

const LABEL = Object.freeze({
  pending: 'PENDING',
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  resumable: 'RESUME-READY',
  completed: 'DONE',
  failed: 'FAILED',
  cancelled: 'CANCELLED'
})

const isOpen = (goal) => OPEN_STATUSES.includes(goal?.status)
const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
const clean = (text, max = 200) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

class GoalRegistry {
  /**
   * @param {{ file?: string|null, logger?: (level:string,msg:string)=>void,
   *           max?: number, terminalKeep?: number, now?: () => number,
   *           saveThrottleMs?: number }} [opts]
   */
  constructor ({ file = null, logger = () => {}, max = 40, terminalKeep = 12, now = () => Date.now(), saveThrottleMs = 1500 } = {}) {
    this.file = file || null
    this.log = logger
    this.max = Math.max(4, clampInt(max, 4, 500, 40))
    this.terminalKeep = Math.max(0, clampInt(terminalKeep, 0, 200, 12))
    this.now = now
    this.saveThrottleMs = Math.max(0, Number(saveThrottleMs) || 0)
    this.goals = []
    this.seq = 0
    this.savedAt = 0
    this._lastSaveAt = 0
    this._dirty = false
    /** Set by load(): the ids that came back from disk. */
    this.restored = []
    if (this.file) this.load()
  }

  // ------------------------------------------------------------- storage --

  load () {
    this.goals = []
    this.seq = 0
    this.restored = []
    if (!this.file) return this
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.log('warn', `goals: unreadable store (${err.message || err}) — starting empty`)
      return this
    }
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.goals) ? raw.goals : [])
    this.seq = Math.max(0, clampInt(raw?.seq, 0, 1e9, 0))
    const now = this.now()
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.id || !item.description) continue
      const goal = this._normalize(item)
      // A process that died mid-task leaves `active` behind. Nobody is running
      // it any more, and the world may have changed: it is resumable, not active.
      if (goal.status === STATUS.active || goal.status === STATUS.pending) {
        const was = goal.status
        goal.status = STATUS.resumable
        goal.needsVerify = true
        goal.resumeReason = was === STATUS.active
          ? 'interrupted: the harness restarted while this was running'
          : 'interrupted: the harness restarted before this started'
        goal.suspendedAt = now
        this._history(goal, was, STATUS.resumable, 'restored after restart')
      }
      if (goal.status === STATUS.suspended) goal.needsVerify = true
      this.goals.push(goal)
      this.restored.push(goal.id)
      const n = Number(String(goal.id).replace(/^g/, ''))
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n)
    }
    this._prune()
    return this
  }

  _normalize (item) {
    const now = this.now()
    const progress = item.progress && typeof item.progress === 'object' ? item.progress : {}
    const origin = clean(item.origin || 'self', 60)
    const derivedOriginType = origin.startsWith('shared:') || item.originType === 'shared_project'
      ? 'shared_project'
      : (origin.startsWith('player:') || item.originType === 'player_requested' ? 'player_requested' : 'self_generated')
    const derivedParticipants = Array.isArray(item.participants)
      ? item.participants.map((p) => clean(p, 32)).filter(Boolean).slice(0, 6)
      : (origin.startsWith('player:') ? [origin.slice(7)].filter(Boolean) : (origin.startsWith('shared:') ? origin.slice(7).split(',').map((p) => clean(p, 32)).filter(Boolean) : []))
    return {
      id: clean(item.id, 24),
      description: clean(item.description, 160),
      kind: clean(item.kind || 'declared', 24),
      origin,
      originType: derivedOriginType,
      participants: derivedParticipants,
      reason: clean(item.reason || '', 160),
      priority: clampInt(item.priority, 0, 100, 50),
      parentId: item.parentId ? clean(item.parentId, 24) : null,
      relatedIds: Array.isArray(item.relatedIds) ? item.relatedIds.map((x) => clean(x, 24)).slice(0, 8) : [],
      status: Object.prototype.hasOwnProperty.call(STATUS, item.status) ? item.status : STATUS.pending,
      resources: Array.isArray(item.resources) ? item.resources.slice(0, 12) : [],
      preconditions: Array.isArray(item.preconditions) ? item.preconditions.map((x) => clean(x, 120)).slice(0, 6) : [],
      dependencies: Array.isArray(item.dependencies) ? item.dependencies.map((x) => clean(x, 24)).slice(0, 6) : [],
      progress: {
        percent: clampInt(progress.percent, 0, 100, 0),
        done: Number.isFinite(Number(progress.done)) ? Number(progress.done) : 0,
        total: Number.isFinite(Number(progress.total)) ? Number(progress.total) : null,
        note: clean(progress.note || '', 120)
      },
      completion: clean(item.completion || '', 160),
      failure: clean(item.failure || '', 160),
      interruption: clean(item.interruption || '', 120),
      resume: clean(item.resume || '', 160),
      detail: item.detail && typeof item.detail === 'object' ? item.detail : {},
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
      progressAt: Number(item.progressAt) || Number(item.updatedAt) || now,
      startedAt: Number(item.startedAt) || null,
      endedAt: Number(item.endedAt) || null,
      attempts: clampInt(item.attempts, 0, 9999, 0),
      resumes: clampInt(item.resumes, 0, 9999, 0),
      fails: clampInt(item.fails, 0, 9999, 0),
      lastError: clean(item.lastError || '', 160),
      suspendedBy: item.suspendedBy ? clean(item.suspendedBy, 40) : null,
      suspendReason: item.suspendReason ? clean(item.suspendReason, 120) : null,
      resumeReason: item.resumeReason ? clean(item.resumeReason, 120) : null,
      needsVerify: Boolean(item.needsVerify),
      stalledAt: Number(item.stalledAt) || null,
      stallWarnedAt: Number(item.stallWarnedAt) || null,
      history: Array.isArray(item.history) ? item.history.slice(-8).map((h) => ({
        at: Number(h?.at) || now,
        from: clean(h?.from || '?', 16),
        to: clean(h?.to || '?', 16),
        reason: clean(h?.reason || '', 100)
      })) : []
    }
  }

  /** Atomic write (temp + rename). Throttled unless `force`. */
  save ({ force = false } = {}) {
    if (!this.file) return false
    const now = this.now()
    if (!force && this.saveThrottleMs > 0 && now - this._lastSaveAt < this.saveThrottleMs) {
      this._dirty = true
      return false
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      const payload = { v: 1, savedAt: now, seq: this.seq, goals: this.goals }
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, this.file)
      this.savedAt = now
      this._lastSaveAt = now
      this._dirty = false
      return true
    } catch (err) {
      this.log('warn', `goals: save failed (${err.message || err})`)
      return false
    }
  }

  /** Flush a throttled write at the end of a tick. */
  maybeSave () {
    if (this._dirty) return this.save({ force: true })
    return false
  }

  // -------------------------------------------------------------- lookup --

  get size () { return this.goals.length }

  get (id) {
    const key = clean(id, 24).toLowerCase()
    return this.goals.find((g) => g.id.toLowerCase() === key) || null
  }

  /** Best-effort lookup by id prefix or by words in the description. */
  find (text) {
    const q = clean(text, 80).toLowerCase()
    if (!q) return null
    const byId = this.goals.find((g) => q.startsWith(g.id.toLowerCase()))
    if (byId) return byId
    const words = q.split(/[^a-z0-9_]+/).filter((w) => w.length > 2)
    let best = null
    for (const g of this.goals) {
      const desc = `${g.description} ${g.kind}`.toLowerCase()
      const hits = words.filter((w) => desc.includes(w)).length
      if (hits > 0 && (!best || hits > best.hits)) best = { goal: g, hits }
    }
    return best ? best.goal : null
  }

  list ({ status = null, open = false } = {}) {
    let out = this.goals
    if (status) out = out.filter((g) => g.status === status)
    if (open) out = out.filter(isOpen)
    return out.slice().sort((a, b) => {
      const ao = isOpen(a) ? 0 : 1
      const bo = isOpen(b) ? 0 : 1
      if (ao !== bo) return ao - bo
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.createdAt - b.createdAt
    })
  }

  openGoals () { return this.list({ open: true }) }

  /** The currently running objective, if any. */
  active () { return this.goals.find((g) => g.status === STATUS.active) || nodesFirst(this.goals) }

  // ------------------------------------------------------------ creation --

  /**
   * @param {{ description:string, kind?:string, origin?:string, priority?:number,
   *           parentId?:string|null, relatedIds?:string[], resources?:Array,
   *           preconditions?:string[], dependencies?:string[],
   *           completion?:string, failure?:string, interruption?:string, resume?:string,
   *           detail?:object, status?:string }} spec
   */
  add (spec = {}) {
    const now = this.now()
    const description = clean(spec.description, 160)
    if (!description) return null
    this.seq += 1
    const goal = this._normalize({
      id: `g${this.seq}`,
      description,
      kind: spec.kind || 'declared',
      origin: spec.origin || 'self',
      originType: spec.originType,
      participants: spec.participants,
      reason: spec.reason || '',
      priority: spec.priority,
      parentId: spec.parentId || null,
      relatedIds: spec.relatedIds || [],
      status: spec.status || STATUS.pending,
      resources: spec.resources || [],
      preconditions: spec.preconditions || [],
      dependencies: spec.dependencies || [],
      completion: spec.completion || '',
      failure: spec.failure || '',
      interruption: spec.interruption || '',
      resume: spec.resume || '',
      detail: spec.detail || {},
      createdAt: now,
      updatedAt: now,
      progressAt: now
    })
    this.goals.push(goal)
    this._history(goal, 'none', goal.status, 'created')
    this._prune()
    this.save({ force: true })
    return goal
  }

  /**
   * Patch non-status fields (detail checkpoint, progress note, resources…).
   * A terminal goal is never patched: what is done is done.
   */
  update (id, patch = {}) {
    const goal = this.get(id)
    if (!goal) return null
    if (!isOpen(goal) && (patch.detail || patch.progress || patch.resources)) return goal
    if (patch.description) goal.description = clean(patch.description, 160)
    if (patch.reason !== undefined) goal.reason = clean(patch.reason, 160)
    if (patch.origin) {
      goal.origin = clean(patch.origin, 60)
      goal.originType = goal.origin.startsWith('shared:') || patch.originType === 'shared_project'
        ? 'shared_project'
        : (goal.origin.startsWith('player:') || patch.originType === 'player_requested' ? 'player_requested' : 'self_generated')
    } else if (patch.originType && ['self_generated', 'player_requested', 'shared_project'].includes(patch.originType)) {
      goal.originType = patch.originType
    }
    if (Array.isArray(patch.participants)) goal.participants = patch.participants.map((p) => clean(p, 32)).filter(Boolean).slice(0, 6)
    if (patch.priority !== undefined) goal.priority = clampInt(patch.priority, 0, 100, goal.priority)
    if (patch.detail && typeof patch.detail === 'object') goal.detail = { ...goal.detail, ...patch.detail }
    if (Array.isArray(patch.resources)) goal.resources = patch.resources.slice(0, 12)
    if (Array.isArray(patch.preconditions)) goal.preconditions = patch.preconditions.map((x) => clean(x, 120)).slice(0, 6)
    if (Array.isArray(patch.dependencies)) goal.dependencies = patch.dependencies.map((x) => clean(x, 24)).slice(0, 6)
    if (Array.isArray(patch.relatedIds)) goal.relatedIds = patch.relatedIds.map((x) => clean(x, 24)).slice(0, 8)
    if (patch.parentId !== undefined) goal.parentId = patch.parentId ? clean(patch.parentId, 24) : null
    if (patch.needsVerify !== undefined) goal.needsVerify = Boolean(patch.needsVerify)
    if (patch.completion) goal.completion = clean(patch.completion, 160)
    if (patch.resume) goal.resume = clean(patch.resume, 160)
    goal.updatedAt = this.now()
    this.save()
    return goal
  }

  /**
   * Combine two or more open goals into a single unified goal, recording the
   * merged goal IDs on `relatedIds` and cancelling superseded entries.
   */
  combine (ids = [], spec = {}) {
    const sources = ids.map((id) => this.get(id)).filter((g) => g && isOpen(g))
    if (sources.length < 2) return null
    const maxPrio = Math.max(...sources.map((g) => g.priority || 50))
    const mergedDesc = clean(spec.description, 160) || clean(sources.map((g) => g.description).join(' + '), 160)
    const players = [...new Set(sources.flatMap((g) => g.participants || []))]
    const hasSelf = sources.some((g) => g.originType === 'self_generated')
    const origin = spec.origin || (players.length && hasSelf ? `shared:${players.join(',')}` : players.length ? `player:${players[0]}` : 'self')
    const combined = this.add({
      description: mergedDesc,
      kind: spec.kind || 'declared',
      origin,
      participants: players,
      reason: spec.reason || clean(sources.map((g) => g.reason).filter(Boolean).join('; '), 160),
      priority: spec.priority ?? maxPrio,
      relatedIds: sources.map((g) => g.id)
    })
    for (const src of sources) {
      this.cancel(src.id, { reason: `combined into ${combined.id}` })
    }
    return combined
  }

  /**
   * Record progress. `progressAt` is the stall clock: only a real checkpoint
   * (blocks placed, items gathered, world re-verified) resets it — a heartbeat
   * or a failed retry does not.
   */
  progress (id, { done = null, total = null, percent = null, note = '', touch = true } = {}) {
    const goal = this.get(id)
    if (!goal || !isOpen(goal)) return goal
    const p = goal.progress
    if (Number.isFinite(Number(done))) p.done = Number(done)
    if (Number.isFinite(Number(total))) p.total = Number(total)
    if (percent !== null && percent !== undefined && Number.isFinite(Number(percent))) p.percent = clampInt(percent, 0, 100, p.percent)
    else if (Number.isFinite(p.total) && p.total > 0) p.percent = clampInt(Math.round((p.done / p.total) * 100), 0, 100, p.percent)
    if (note) p.note = clean(note, 120)
    if (touch) goal.progressAt = this.now()
    goal.updatedAt = this.now()
    this.save()
    return goal
  }

  /** A failure without a status change: the stall/blocked monitor counts these. */
  recordFailure (id, error) {
    const goal = this.get(id)
    if (!goal || !isOpen(goal)) return goal
    goal.fails += 1
    goal.lastError = clean(error, 160)
    goal.updatedAt = this.now()
    this.save()
    return goal
  }

  /** Mark the stall notification so the model is nudged once, not every tick. */
  noteStall (id, at = this.now()) {
    const goal = this.get(id)
    if (!goal) return null
    goal.stalledAt = at
    goal.stallWarnedAt = at
    goal.updatedAt = at
    this.save()
    return goal
  }

  // ---------------------------------------------------------- transitions --

  /**
   * The one place status changes. Illegal transitions are refused with a
   * reason, never applied.
   * @returns {{ ok:boolean, goal:object|null, why?:string }}
   */
  transition (id, to, { reason = '', note = '', progress = null, detail = null, error = null, by = null, at = null } = {}) {
    const goal = this.get(id)
    if (!goal) return { ok: false, goal: null, why: `no goal ${id}` }
    const from = goal.status
    if (from === to) return { ok: true, goal, why: 'already there' }
    if (!LEGAL[from] || !LEGAL[from].includes(to)) {
      return { ok: false, goal, why: `${goal.id} is ${from}; it cannot become ${to}` }
    }
    const now = at || this.now()
    goal.status = to
    goal.updatedAt = now
    if (to === STATUS.active) {
      goal.attempts += 1
      goal.startedAt = goal.startedAt || now
      goal.endedAt = null
      goal.suspendedBy = null
      goal.suspendReason = null
      goal.progressAt = now
      goal.stallWarnedAt = null
      goal.stalledAt = null
      if (from === STATUS.suspended || from === STATUS.resumable || from === STATUS.failed) {
        goal.resumes += 1
        goal.resumeReason = clean(reason || 'resumed', 120)
      }
    }
    if (to === STATUS.suspended) {
      goal.suspendedAt = now
      goal.suspendedBy = by ? clean(by, 40) : null
      goal.suspendReason = clean(reason || 'suspended', 120)
    }
    if (to === STATUS.resumable) {
      goal.suspendedAt = now
      goal.suspendReason = clean(reason || 'interrupted', 120)
      goal.resumeReason = goal.suspendReason
      goal.needsVerify = true
    }
    if (to === STATUS.completed) {
      goal.endedAt = now
      if (Number.isFinite(goal.progress.total) && goal.progress.total > 0) goal.progress.done = goal.progress.total
      goal.progress.percent = 100
      goal.needsVerify = false
    }
    if (to === STATUS.failed || to === STATUS.cancelled) {
      goal.endedAt = now
      if (to === STATUS.failed) { goal.fails += 1; goal.lastError = clean(error || reason || 'failed', 160) }
      goal.needsVerify = false
    }
    if (progress) this.progress(goal.id, progress)
    if (detail && typeof detail === 'object') goal.detail = { ...goal.detail, ...detail }
    if (note) goal.progress.note = clean(note, 120)
    this._history(goal, from, to, reason || note || '')
    this.save({ force: true })
    return { ok: true, goal }
  }

  activate (id, opts = {}) {
    const goal = this.get(id)
    if (goal && goal.status === STATUS.failed) {
      // A retry of a failed objective only with the world re-checked.
      return this.transition(id, STATUS.active, { ...opts, reason: opts.reason || 'retry after failure' })
    }
    return this.transition(id, STATUS.active, opts)
  }

  suspend (id, opts = {}) { return this.transition(id, STATUS.suspended, opts) }
  resume (id, opts = {}) { return this.transition(id, STATUS.active, opts) }
  complete (id, opts = {}) { return this.transition(id, STATUS.completed, opts) }
  fail (id, opts = {}) { return this.transition(id, STATUS.failed, opts) }
  cancel (id, opts = {}) { return this.transition(id, STATUS.cancelled, opts) }

  /**
   * Restart/interruption: whatever was open becomes resumable with a reason.
   * Used on death, disconnect and shutdown. Terminal goals are untouched.
   */
  suspendAll ({ reason = 'interrupted', only = null } = {}) {
    const touched = []
    for (const goal of this.goals) {
      if (!isOpen(goal)) continue
      if (only && !only(goal)) continue
      const r = this.transition(goal.id, STATUS.resumable, { reason, at: this.now() })
      if (r.ok) touched.push(goal.id)
    }
    if (touched.length) this.save({ force: true })
    return touched
  }

  /** `stop`: the model ended everything. Cancelled goals never come back. */
  cancelAll ({ reason = 'cancelled' } = {}) {
    const touched = []
    for (const goal of this.goals) {
      if (!isOpen(goal)) continue
      const r = this.cancel(goal.id, { reason })
      if (r.ok) touched.push(goal.id)
    }
    if (touched.length) this.save({ force: true })
    return touched
  }

  _history (goal, from, to, reason) {
    goal.history.push({ at: this.now(), from, to, reason: clean(reason, 100) })
    if (goal.history.length > 8) goal.history.splice(0, goal.history.length - 8)
  }

  // ------------------------------------------------------------ monitoring --

  /**
   * Active goals whose progress clock has run out. The caller decides what to
   * do (nudge the model, suspend, fail); waiting is legitimate for some kinds,
   * so `expectsWait` is honoured here.
   */
  stalled ({ stallMs = 180_000, remindMs = 300_000, now = this.now() } = {}) {
    const out = []
    for (const goal of this.goals) {
      if (goal.status !== STATUS.active) continue
      if (goal.detail && goal.detail.expectsWait) continue
      if (now - goal.progressAt < stallMs) continue
      if (goal.stallWarnedAt && now - goal.stallWarnedAt < remindMs) continue
      out.push(goal)
    }
    return out
  }

  /** Goals that have been waiting (suspended/resumable/pending) the longest. */
  waiting ({ now = this.now(), minAgeMs = 0 } = {}) {
    return this.goals
      .filter((g) => (g.status === STATUS.suspended || g.status === STATUS.resumable || g.status === STATUS.pending))
      .filter((g) => now - (g.suspendedAt || g.updatedAt || g.createdAt) >= minAgeMs)
      .sort((a, b) => (b.priority - a.priority) || ((a.suspendedAt || a.createdAt) - (b.suspendedAt || b.createdAt)))
  }

  /** Compact one-line renderings for a prompt, open goals first. */
  brief ({ limit = 6, now = this.now(), includeClosed = true } = {}) {
    const open = this.list({ open: true })
    const closed = includeClosed ? this.goals.filter((g) => !isOpen(g)).sort((a, b) => (b.endedAt || b.updatedAt) - (a.endedAt || a.updatedAt)).slice(0, 2) : []
    return [...open, ...closed].slice(0, Math.max(1, limit)).map((g) => this.describe(g, { now }))
  }

  /** One goal as one line: `g3 ACTIVE build small_house — 46% (55/120), 2m ago`. */
  describe (goal, { now = this.now(), verbose = false } = {}) {
    if (!goal) return ''
    const age = (ts) => {
      if (!ts) return ''
      const sec = Math.max(0, Math.round((now - ts) / 1000))
      if (sec < 90) return `${sec}s ago`
      const min = Math.round(sec / 60)
      return min < 90 ? `${min}m ago` : `${Math.round(min / 60)}h ago`
    }
    const bits = [`${goal.id} ${LABEL[goal.status] || goal.status} ${goal.description}`]
    if (goal.parentId) bits.push(`step of ${goal.parentId}`)
    const p = goal.progress
    if (Number.isFinite(p.total) && p.total > 0) bits.push(`${p.percent}% (${p.done}/${p.total})`)
    else if (p.note) bits.push(p.note)
    else if (goal.reason) bits.push(`why: ${goal.reason}`)
    if (goal.originType === 'shared_project') bits.push(`shared(${goal.participants?.join(',') || goal.origin.replace(/^shared:/, '')})`)
    else if (goal.origin && goal.origin !== 'self') bits.push(`from ${goal.origin.replace(/^player:/, '')}`)
    else bits.push('self')
    if (goal.status === STATUS.active) bits.push(`started ${age(goal.startedAt || goal.progressAt)}`)
    else if (goal.suspendReason && isOpen(goal)) bits.push(goal.suspendReason)
    else if (goal.status === STATUS.failed && goal.lastError) bits.push(goal.lastError)
    else if (!isOpen(goal) && goal.endedAt) bits.push(age(goal.endedAt))
    if (verbose) {
      if (goal.reason) bits.push(`reason: ${goal.reason}`)
      if (goal.detail && Object.keys(goal.detail).length) bits.push(`checkpoint ${JSON.stringify(goal.detail).slice(0, 160)}`)
      if (goal.resume) bits.push(`resume: ${goal.resume}`)
      if (goal.needsVerify) bits.push('verify against the world before resuming')
      if (goal.history.length) bits.push(goal.history.slice(-3).map((h) => `${h.from}→${h.to}${h.reason ? ` (${h.reason})` : ''}`).join(', '))
    }
    return bits.filter(Boolean).join(' — ').slice(0, verbose ? 500 : 220)
  }

  /** A detailed, bounded view for `goal show`. */
  show (id) {
    const goal = this.get(id)
    if (!goal) return null
    return {
      ...goal,
      line: this.describe(goal, { verbose: true })
    }
  }

  // ---------------------------------------------------------------- upkeep --

  /** Keep the file small: oldest terminal goals go first, then lowest priority. */
  _prune () {
    const closed = this.goals.filter((g) => !isOpen(g))
    if (closed.length > this.terminalKeep) {
      const keep = new Set(closed.sort((a, b) => (b.endedAt || b.updatedAt) - (a.endedAt || a.updatedAt)).slice(0, this.terminalKeep).map((g) => g.id))
      this.goals = this.goals.filter((g) => isOpen(g) || keep.has(g.id))
    }
    while (this.goals.length > this.max) {
      const victim = this.goals.filter((g) => !isOpen(g)).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))[0]
      if (!victim) break
      this.goals.splice(this.goals.indexOf(victim), 1)
    }
  }

  /** Stable, short status counts for logs. */
  summary () {
    const counts = {}
    for (const g of this.goals) counts[g.status] = (counts[g.status] || 0) + 1
    return counts
  }
}

// A tiny guard for the `active()` helper: if several are marked active (a bug
// elsewhere), prefer the highest priority and oldest-started one.
function nodesFirst (goals) {
  return goals.filter((g) => g.status === STATUS.active)
    .sort((a, b) => (b.priority - a.priority) || (a.startedAt - b.startedAt))[0] || null
}

module.exports = { GoalRegistry, STATUS, OPEN_STATUSES, CLOSED_STATUSES, LEGAL, LABEL, isOpen }
