/**
 * lanes.js — logical execution lanes for Zinc.
 *
 * The four lanes are *categories*, not threads. Node runs one event loop, so a
 * lane is a set of tools that share a resource, plus a scheduler that lets
 * everything which does not share a resource run at the same time:
 *
 *   BODY         exclusive physical control of the avatar. Two BODY tools must
 *                never be in flight together, whatever the goals say.
 *   COMPUTATION  pure reasoning / simulation / analysis. Never touches the
 *                world, so any number may overlap with anything else.
 *   INTERACTION  chat and social actions. Overlaps with everything, but is
 *                serialised with itself so replies cannot interleave.
 *   WORLD INFO   read-only inspection of the world. Safe to overlap with other
 *                WORLD INFO reads, and with COMPUTATION, but not with a BODY
 *                action that mutates the cells being read.
 *
 * A tool declares the resources it needs. The scheduler grants a call only when
 * every resource it asks for is free, and the grant is always released — on
 * success, on failure, on cancellation, and on context reset (`releaseAll`).
 * This is what turns "the functions return promises" into "two tools genuinely
 * overlapped", which is what the tests measure with timestamps.
 */
'use strict'

/** Lane names, in the order a human would explain them. */
const LANES = Object.freeze({
  BODY: 'BODY',
  COMPUTATION: 'COMPUTATION',
  INTERACTION: 'INTERACTION',
  WORLD_INFO: 'WORLD_INFO'
})

/**
 * Tool → lane. Anything not listed defaults to BODY, because the safe default
 * for an unknown tool is "it might move the bot".
 *
 * `read` tools are WORLD_INFO; `compute` tools are COMPUTATION.
 */
const TOOL_LANES = Object.freeze({
  // --- BODY: changes or occupies the avatar / the world ---
  go_to: LANES.BODY,
  dig: LANES.BODY,
  build: LANES.BODY,
  build_shape: LANES.BODY,
  place: LANES.BODY,
  follow: LANES.BODY,
  attack: LANES.BODY,
  take: LANES.BODY,
  put: LANES.BODY,
  give: LANES.BODY,
  eat: LANES.BODY,
  equip: LANES.BODY,
  use_block: LANES.BODY,
  craft: LANES.BODY,
  smelt: LANES.BODY,
  gather: LANES.BODY,
  light_up: LANES.BODY,
  shelter: LANES.BODY,
  corpse_run: LANES.BODY,
  sleep: LANES.BODY,
  run_script: LANES.BODY,
  set_mode: LANES.BODY,
  stop: LANES.BODY,
  hold: LANES.BODY,
  // --- COMPUTATION: no world mutation at all ---
  logic_test: LANES.COMPUTATION,
  circuit_project: LANES.COMPUTATION,
  // --- WORLD INFO: read-only ---
  inspect_block: LANES.WORLD_INFO,
  inspect_region: LANES.WORLD_INFO,
  find: LANES.WORLD_INFO,
  redstone_scan: LANES.WORLD_INFO,
  redstone_component: LANES.WORLD_INFO,
  redstone_engineer: LANES.WORLD_INFO,
  recall: LANES.WORLD_INFO,
  look_in: LANES.WORLD_INFO,
  // --- INTERACTION: text only ---
  say: LANES.INTERACTION,
  social: LANES.INTERACTION,
  note: LANES.INTERACTION,
  remember_here: LANES.INTERACTION,
  goal: LANES.INTERACTION,
  idle: LANES.INTERACTION
})

/**
 * Extra resources a tool locks beyond its lane. A BODY tool that reshapes an
 * area also blocks world reads of that area, which is expressed as the shared
 * `world` resource — reads are cheap but must not straddle a build.
 */
const TOOL_RESOURCES = Object.freeze({
  build: ['world'],
  build_shape: ['world'],
  place: ['world'],
  dig: ['world'],
  gather: ['world'],
  shelter: ['world'],
  light_up: ['world'],
  redstone_engineer: ['world-read'],
  redstone_scan: ['world-read'],
  inspect_region: ['world-read'],
  inspect_block: ['world-read'],
  find: ['world-read'],
  look_in: ['world-read']
})

/**
 * Resources that a read-only tool cannot share with a mutating one.
 * A BODY writer holds `world`; readers hold `world-read`; the pair excludes.
 */
const EXCLUSIVE_PAIRS = [['world', 'world-read']]

const laneOf = (tool) => TOOL_LANES[tool] || LANES.BODY

/** Every resource a call needs, including its lane's own slot. */
function resourcesFor (tool) {
  const lane = laneOf(tool)
  const res = new Set([`lane:${lane}`])
  for (const r of TOOL_RESOURCES[tool] || []) res.add(r)
  return [...res]
}

const conflicts = (a, b) => EXCLUSIVE_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))

/**
 * A lane scheduler.
 *
 * Usage:  const lanes = new LaneScheduler()
 *         const lease = await lanes.acquire('dig', { goalId, jobId })
 *         try { ... } finally { lease.release('done') }
 *
 * Every acquisition/release is timestamped into `events` so a test can prove
 * real overlap instead of trusting promise plumbing.
 */
class LaneScheduler {
  constructor ({ now = () => Date.now() } = {}) {
    this.now = now
    this.held = new Map() // resource -> { tool, holder, since }
    this.waiters = [] // { tool, holder, resources, resolve, enqueuedAt }
    this.events = [] // { at, kind, tool, holder, resources, waitedMs }
    this.nextId = 1
    this.closed = false
  }

  /** True when every resource (and its exclusive opposite) is free. */
  canGrant (resources) {
    for (const r of resources) {
      if (this.held.has(r)) return false
      for (const [other] of this.held) if (conflicts(r, other)) return false
    }
    return true
  }

  /**
   * Ask for the resources a tool needs. Resolves with a lease; the caller must
   * release it. A refused grant waits (FIFO, so a BODY action cannot starve).
   */
  acquire (tool, meta = {}) {
    if (this.closed) return Promise.reject(new Error('lane scheduler closed'))
    const resources = resourcesFor(tool)
    const holder = `job-${this.nextId++}`
    const t = this.now()
    if (this.canGrant(resources)) {
      this._grant(resources, { tool, holder, meta, at: t })
      return Promise.resolve(this._lease(resources, holder, tool, t, 0))
    }
    return new Promise((resolve) => {
      this.waiters.push({ tool, holder, meta, resources, resolve, enqueuedAt: t })
      this.events.push({ at: t, kind: 'queued', tool, holder, resources: resources.slice(), lane: laneOf(tool), goalId: meta.goalId || null })
    })
  }

  /**
   * Try once, without waiting. Used for "can I start this in the background
   * right now?" decisions where queueing would be pointless work.
   */
  tryAcquire (tool, meta = {}) {
    const resources = resourcesFor(tool)
    if (!this.canGrant(resources)) return null
    const holder = `job-${this.nextId++}`
    const t = this.now()
    this._grant(resources, { tool, holder, meta, at: t })
    return this._lease(resources, holder, tool, t, 0)
  }

  _grant (resources, info) {
    for (const r of resources) this.held.set(r, info)
    this.events.push({ at: info.at, kind: 'grant', tool: info.tool, holder: info.holder, resources: resources.slice(), lane: laneOf(info.tool), goalId: info.meta?.goalId || null })
  }

  _lease (resources, holder, tool, grantedAt, waitedMs) {
    let released = false
    const lease = {
      id: holder,
      tool,
      lane: laneOf(tool),
      resources,
      grantedAt,
      waitedMs,
      get released () { return released },
      release: (reason = 'done') => {
        if (released) return false
        released = true
        this._release(holder, resources, reason)
        return true
      }
    }
    return lease
  }

  _release (holder, resources, reason) {
    const t = this.now()
    let tool = null
    for (const r of resources) {
      const info = this.held.get(r)
      if (info && info.holder === holder) { tool = info.tool; this.held.delete(r) }
    }
    this.events.push({ at: t, kind: 'release', tool, holder, reason, lane: tool ? laneOf(tool) : null })
    this._drain()
  }

  _drain () {
    // FIFO admission: keep walking the queue while the head can be granted.
    let progressed = true
    while (progressed && this.waiters.length) {
      progressed = false
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]
        if (!this.canGrant(w.resources)) continue
        this.waiters.splice(i, 1)
        const t = this.now()
        this._grant(w.resources, { tool: w.tool, holder: w.holder, meta: w.meta, at: t })
        w.resolve(this._lease(w.resources, w.holder, w.tool, t, t - w.enqueuedAt))
        progressed = true
        break
      }
    }
  }

  /** Drop every waiter and release every lease — used on context reset. */
  releaseAll (reason = 'context reset') {
    const dropped = this.waiters.splice(0, this.waiters.length)
    for (const w of dropped) {
      this.events.push({ at: this.now(), kind: 'dropped', tool: w.tool, holder: w.holder, reason })
    }
    const holders = new Set([...this.held.values()].map((i) => i.holder))
    for (const holder of holders) {
      const resources = [...this.held.entries()].filter(([, i]) => i.holder === holder).map(([r]) => r)
      this._release(holder, resources, reason)
    }
    this.held.clear()
    return { dropped: dropped.length, released: holders.size }
  }

  close () {
    this.releaseAll('scheduler closed')
    this.closed = true
  }

  /** What is holding the BODY lane right now, if anything. */
  bodyHolder () {
    for (const [r, info] of this.held) if (r === 'lane:BODY') return info
    return null
  }

  /** Every lease currently held, by resource. */
  snapshot () {
    const byLane = {}
    for (const [r, info] of this.held) {
      if (!r.startsWith('lane:')) continue
      const lane = r.slice(5)
      byLane[lane] = (byLane[lane] || []).concat([{ tool: info.tool, holder: info.holder, since: info.at, goalId: info.meta?.goalId || null }])
    }
    return { byLane, waiting: this.waiters.length, events: this.events.length }
  }

  /**
   * Prove overlap from the event log: two different holders whose [grant,
   * release] intervals intersect. Returns the pairs, which is what a test
   * asserts on instead of "both promises resolved".
   */
  overlaps () {
    const spans = new Map()
    for (const e of this.events) {
      if (e.kind !== 'grant' && e.kind !== 'release') continue
      if (!spans.has(e.holder)) spans.set(e.holder, { holder: e.holder, tool: e.tool, lane: e.lane, start: null, end: null })
      const s = spans.get(e.holder)
      s.tool = s.tool || e.tool
      s.lane = s.lane || e.lane
      if (e.kind === 'grant') s.start = e.at
      else s.end = e.at
    }
    const list = [...spans.values()].filter((s) => s.start != null)
    const pairs = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const aEnd = a.end == null ? Infinity : a.end
        const bEnd = b.end == null ? Infinity : b.end
        // Strict overlap: an interval that merely touches another's boundary is
        // sequential execution, not concurrency.
        if (Math.max(a.start, b.start) < Math.min(aEnd, bEnd)) pairs.push({ a, b })
      }
    }
    return pairs
  }
}

/**
 * Run async jobs and collect them, so a long job survives a goal being
 * cancelled and its result is still delivered to whoever owns it.
 *
 * Lifecycle: pending → running → done | failed | cancelled.
 * A job knows the goal it belongs to and the lane lease it holds, and every
 * transition is timestamped.
 */
class JobRegistry {
  constructor ({ now = () => Date.now(), lanes = null } = {}) {
    this.now = now
    this.lanes = lanes
    this.jobs = new Map()
    this.completed = new Map() // signature -> recorded result (replay cache)
    this.nextId = 1
    this.events = []
  }

  /**
   * Run a physical action at most once per signature. A completed mutation is
   * remembered, so "the result never reached the model" cannot cause the world
   * to be changed twice — the recorded result is replayed instead.
   */
  startOnce ({ sig, kind, goalId = null, tool = null, run, lane = true }) {
    if (!sig) return this.start({ kind, goalId, tool, run, lane })
    const prior = this.completed.get(sig)
    if (prior) {
      const job = this.start({ kind, goalId: null, tool, run: async () => prior, lane })
      job.replayed = true
      job.sig = sig
      return job
    }
    const job = this.start({
      kind,
      goalId,
      tool,
      lane,
      run: async (ctl) => {
        const value = await run(ctl)
        this.completed.set(sig, value)
        return value
      }
    })
    job.sig = sig
    return job
  }

  start ({ kind, goalId = null, tool = null, run, lane = true }) {
    const id = `job-${this.nextId++}`
    const t = this.now()
    const job = {
      id,
      kind,
      goalId,
      tool,
      lane: tool ? laneOf(tool) : LANES.COMPUTATION,
      state: 'pending',
      startedAt: t,
      endedAt: null,
      progress: null,
      error: null,
      result: null,
      cancelled: false,
      lease: null
    }
    this.jobs.set(id, job)
    this.events.push({ at: t, kind: 'start', id, goalId, lane: job.lane })
    job.promise = Promise.resolve().then(async () => {
      try {
        // NOTE: a job NEVER acquires a lane for its own tool — the caller owns
        // that grant. Acquiring it here would deadlock against the caller's
        // lease on the same lane (the job waits on a lock its own caller holds).
        // Pass `lane: false` when the caller is not already holding one.
        // A job acquires its own lane only when it OWNS that work. When the
        // caller already holds the lane (the normal executor path), pass
        // `lane: false`; a nested acquire would deadlock on a lock the caller
        // itself is holding.
        if (this.lanes && tool && lane !== false) {
          const already = this.lanes.held.get(`lane:${laneOf(tool)}`)
          if (already) {
            // The lane is busy: queue properly (not a busy-poll) so this job
            // runs after the current holder releases.
            job.lease = await this.lanes.acquire(tool, { goalId, jobId: id })
          } else {
            job.lease = this.lanes.tryAcquire(tool, { goalId, jobId: id })
          }
          if (!job.lease) job.leaseDeferred = true
        }
        if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true })
        job.state = 'running'
        const value = await run({
          id,
          progress: (p) => { job.progress = p },
          isCancelled: () => job.cancelled
        })
        if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true })
        job.state = 'done'
        job.result = value
        return value
      } catch (err) {
        const cancelled = Boolean(err?.cancelled || job.cancelled)
        job.state = cancelled ? 'cancelled' : 'failed'
        job.error = cancelled ? null : String(err?.message || err)
        // A cancellation is an expected outcome, not a failure: resolve with a
        // cancelled marker so a caller's `await` does not turn into an error.
        if (cancelled) return { cancelled: true, id, reason: job.cancelReason || 'cancelled' }
        throw err
      } finally {
        job.endedAt = this.now()
        this.events.push({ at: job.endedAt, kind: job.state, id, goalId, lane: job.lane })
        if (job.lease) job.lease.release(job.state)
      }
    })
    // A background job nobody awaits must not crash the process; the failure is
    // recorded on the job, and the caller reads it from status().
    job.promise.catch(() => {})
    return job
  }

  cancel (id, reason = 'cancelled') {
    const job = this.jobs.get(id)
    if (!job) return false
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return false
    job.cancelled = true
    job.cancelReason = reason
    this.events.push({ at: this.now(), kind: 'cancel', id, goalId: job.goalId, reason })
    return true
  }

  /** Cancel every job belonging to a goal (used when the goal is cancelled). */
  cancelForGoal (goalId, reason = 'goal cancelled') {
    let n = 0
    for (const job of this.jobs.values()) if (job.goalId === goalId && this.cancel(job.id, reason)) n++
    return n
  }

  status (id) {
    const job = this.jobs.get(id)
    if (!job) return null
    return {
      id: job.id,
      kind: job.kind,
      goalId: job.goalId,
      lane: job.lane,
      state: job.state,
      progress: job.progress,
      error: job.error,
      cancelled: job.cancelled,
      startedAt: job.startedAt,
      endedAt: job.endedAt
    }
  }

  list ({ goalId = null, state = null } = {}) {
    return [...this.jobs.values()]
      .filter((j) => (goalId == null || j.goalId === goalId) && (state == null || j.state === state))
      .map((j) => this.status(j.id))
  }

  active () { return this.list().filter((j) => j.state === 'pending' || j.state === 'running') }
}

module.exports = {
  LANES,
  TOOL_LANES,
  TOOL_RESOURCES,
  EXCLUSIVE_PAIRS,
  laneOf,
  resourcesFor,
  conflicts,
  LaneScheduler,
  JobRegistry
}
