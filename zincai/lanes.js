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
 * success, failure and cancellation. Context reset drops waiters but preserves
 * leases belonging to work that is still running.
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
  look_in: LANES.BODY,
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

/**
 * Region keys.
 *
 * The world lock used to be one global pair of names, so reading a single chest
 * blocked a build two hundred blocks away. Regions make the lock local: a cell
 * lives in a 16x16 column of chunks, and a footprint locks exactly the chunks
 * it touches.
 *
 * The one rule that keeps this deadlock-free: a footprint's keys are computed
 * up front and granted **all at once** (see `canGrant`). If a build took its
 * chunks one at a time, two overlapping builds could each hold half of what the
 * other needs and wait forever.
 */
const REGION_SHIFT = 4 // 2^4 = 16 blocks per chunk axis

const regionKey = (x, z) => `world:${Math.floor(x / 16)},${Math.floor(z / 16)}`

/** Enumerate every touched chunk, falling back to a coarse lock when large. */
function regionsFor (footprint) {
  if (!footprint) return []
  const keys = new Set()
  if (Array.isArray(footprint)) {
    for (const b of footprint) {
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) return []
      keys.add(regionKey(b.x, b.z))
      if (keys.size > MAX_REGION_KEYS) return [COARSE_WORLD]
    }
    return [...keys]
  }
  const { x1, z1, x2, z2 } = footprint
  if (![x1, z1, x2, z2].every(Number.isSafeInteger)) return []
  const minX = Math.floor(Math.min(x1, x2) / 16)
  const maxX = Math.floor(Math.max(x1, x2) / 16)
  const minZ = Math.floor(Math.min(z1, z2) / 16)
  const maxZ = Math.floor(Math.max(z1, z2) / 16)
  if ((maxX - minX + 1) * (maxZ - minZ + 1) > MAX_REGION_KEYS) return [COARSE_WORLD]
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) keys.add(`world:${x},${z}`)
  }
  return [...keys]
}

/** Coarse keys, kept for tools that roam and cannot declare a footprint. */
const COARSE_WORLD = 'world'
const COARSE_WORLD_READ = 'world-read'

/**
 * Upper bound on chunks one footprint may lock. Above this the coarse key is
 * used instead: a 400x400 build should serialise the world, not allocate a
 * 625-entry lock set on every call.
 */
const MAX_REGION_KEYS = 64

/**
 * Which keys may be held by several holders at once?
 *
 *   world-read / world-read:<chunk>  readers of the same cells, safe to share
 *   lane:WORLD_INFO                  any number of read-only inspections
 *   lane:COMPUTATION                 pure reasoning, touches nothing
 *
 * BODY is deliberately absent: two physical actions never overlap. INTERACTION
 * is absent too — two replies must not interleave their lines.
 */
const SHARED_LANES = new Set([LANES.WORLD_INFO, LANES.COMPUTATION])

const isShared = (resource) => {
  if (typeof resource !== 'string') return false
  if (resource === COARSE_WORLD_READ || resource.startsWith('world-read:')) return true
  if (resource.startsWith('lane:')) return SHARED_LANES.has(resource.slice(5))
  return false
}

const laneOf = (tool) => TOOL_LANES[tool] || LANES.BODY

/**
 * Every resource a call needs, including its lane's own slot.
 *
 * `opts.footprint` narrows a world lock to the chunks the call actually
 * touches. Without one the tool keeps whatever TOOL_RESOURCES declares, which
 * for roamer tools (`gather`, `light_up`) is the coarse world key.
 */
function resourcesFor (tool, opts = {}) {
  const lane = laneOf(tool)
  const res = new Set([`lane:${lane}`])
  const declared = TOOL_RESOURCES[tool] || []
  for (const r of declared) res.add(r)
  // A footprint only replaces the coarse key; other resources stay.
  const footprintKeys = opts.footprint ? regionsFor(opts.footprint) : []
  if (footprintKeys.length) {
    const writes = declared.includes(COARSE_WORLD) || declared.includes(COARSE_WORLD_READ)
    if (writes) {
      res.delete(COARSE_WORLD)
      res.delete(COARSE_WORLD_READ)
      const reader = declared.includes(COARSE_WORLD_READ) && !declared.includes(COARSE_WORLD)
      for (const k of footprintKeys) res.add(reader ? (k === COARSE_WORLD ? COARSE_WORLD_READ : k.replace(/^world:/, 'world-read:')) : k)
    }
  }
  return [...res]
}

/**
 * Do two resource names exclude each other?
 *
 * Three cases matter, and getting the third one wrong is a silent data race:
 *
 *   1. the explicit coarse pair (`world` vs `world-read`);
 *   2. a reader and a writer of the SAME chunk (`world:0,0` vs `world-read:0,0`);
 *   3. the coarse key against any region — a tool that roams (it cannot name a
 *      footprint) may touch every chunk, so it must exclude every region.
 *      Only `world` vs `world-read:*` and `world-read` vs `world:*` are
 *      excluded here, because readers may share with readers.
 */
const conflicts = (a, b) => {
  if (EXCLUSIVE_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) return true
  const parse = (k) => {
    const m = /^world(-read)?:(.+)$/.exec(k)
    return m ? { read: Boolean(m[1]), region: m[2] } : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa && pb) return pa.region === pb.region && pa.read !== pb.read
  if (pa || pb) {
    // lane:* never conflicts with a regional key; only world(-read) does.
    const other = pa ? b : a
    if (other.startsWith('lane:')) return false
  }
  // One coarse, one regional: exclude when either side is a writer or when the
  // coarse side is a writer (a roamer can reach the other's chunk).
  const coarse = a === COARSE_WORLD || a === COARSE_WORLD_READ ? a : (b === COARSE_WORLD || b === COARSE_WORLD_READ ? b : null)
  const regional = coarse === a ? pb : pa
  if (!coarse || !regional) return false
  if (coarse === COARSE_WORLD) return true // roaming writer vs any chunk reader/writer
  return !regional.read // roaming reader vs a chunk writer only
}

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
  constructor ({ now = () => Date.now(), gate = null } = {}) {
    this.now = now
    /**
     * Optional shared enforcement gate: (resources) => null | reason.
     * When set, no lease is granted while it refuses, so a paused body cannot
     * start work by waiting for the lock to free up. Waiting requests are
     * re-tried when the gate opens (see drainIfOpen).
     */
    this.gate = typeof gate === 'function' ? gate : null
    this.held = new Map() // exclusive resource -> { tool, holder, since }
    /**
     * Shared resources (readers). A reader key may be held by many holders at
     * once — two agents inspecting the same chunk is not a conflict. Kept in a
     * separate map so `held` stays exactly "the exclusive locks", which is what
     * `held.size === 0` after a reset is asserting.
     */
    this.readers = new Map() // resource -> Map(holder -> info)
    this.waiters = [] // { tool, holder, resources, resolve, enqueuedAt }
    this.events = [] // { at, kind, tool, holder, resources, waitedMs }
    this.nextId = 1
    this.closed = false
  }

  /** True when every resource (and its exclusive opposite) is free. */
  canGrant (resources) {
    for (const r of resources) {
      // Exclusive keys are one-at-a-time; reader keys are shared, so occupancy
      // by other readers is fine — but a writer of the same chunk is not.
      if (!isShared(r) && this.held.has(r)) return false
      for (const [other] of this.held) if (conflicts(r, other)) return false
      for (const [other] of this.readers) if (conflicts(r, other)) return false
    }
    return true
  }

  /**
   * Ask for the resources a tool needs. Resolves with a lease; the caller must
   * release it. A refused grant waits; compatible waiters may pass a blocked one.
   */
  acquire (tool, meta = {}) {
    if (this.closed) return Promise.reject(new Error('lane scheduler closed'))
    const resources = resourcesFor(tool, meta)
    const holder = `job-${this.nextId++}`
    const t = this.now()
    // A closed gate (the body is paused, disconnected or out of quota) never
    // queues: it resolves null at once, so a paused body cannot accumulate
    // waiting work that all fires the instant the pause ends.
    const gateRefusal = this.gate ? this.gate(resources, meta) : null
    if (gateRefusal) {
      this.events.push({ at: t, kind: 'refused', tool, holder, reason: String(gateRefusal).slice(0, 120), lane: laneOf(tool), goalId: meta.goalId || null })
      return Promise.resolve(null)
    }
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
    const resources = resourcesFor(tool, meta)
    if (this.gate && this.gate(resources, meta)) return null
    if (!this.canGrant(resources)) return null
    const holder = `job-${this.nextId++}`
    const t = this.now()
    this._grant(resources, { tool, holder, meta, at: t })
    return this._lease(resources, holder, tool, t, 0)
  }

  _grant (resources, info) {
    for (const r of resources) {
      if (isShared(r)) {
        if (!this.readers.has(r)) this.readers.set(r, new Map())
        this.readers.get(r).set(info.holder, info)
      } else {
        this.held.set(r, info)
      }
    }
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
      if (isShared(r)) {
        const owners = this.readers.get(r)
        const info = owners?.get(holder)
        if (info) {
          tool = info.tool
          owners.delete(holder)
          if (!owners.size) this.readers.delete(r)
        }
        continue
      }
      const info = this.held.get(r)
      if (info && info.holder === holder) { tool = info.tool; this.held.delete(r) }
    }
    this.events.push({ at: t, kind: 'release', tool, holder, reason, lane: tool ? laneOf(tool) : null })
    this._drain()
  }

  /** Re-try every waiting request (called when a pause ends or a limit lifts). */
  drainIfOpen () {
    if (!this.waiters.length) return 0
    const before = this.waiters.length
    this._drain()
    return before - this.waiters.length
  }

  _drain () {
    // Scan queued requests and grant compatible ones; this is not strict FIFO.
    let progressed = true
    while (progressed && this.waiters.length) {
      progressed = false
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]
        // A waiter queued before the pause must not be granted while the gate
        // is closed; a request that is refused outright is always safe.
        if (this.gate && this.gate(w.resources, w.meta)) continue
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

  /** Drop queued work without releasing leases held by still-running work. */
  dropWaiters (reason = 'context reset') {
    const dropped = this.waiters.splice(0, this.waiters.length)
    for (const w of dropped) {
      this.events.push({ at: this.now(), kind: 'dropped', tool: w.tool, holder: w.holder, reason })
      // Settle the promise! A dropped waiter that is never resolved leaves
      // `await lanes.acquire(...)` suspended forever — a silently wedged
      // executor rather than a clean abort. Callers already treat a falsy lease
      // as "did not get it" (see the null-safe release in executeAction).
      try { w.resolve(null) } catch { /* waiter already gone */ }
    }
    return dropped.length
  }

  /** Drop waiters and forcibly release leases; only safe after work stops. */
  releaseAll (reason = 'scheduler closed') {
    const dropped = this.dropWaiters(reason)
    const holders = new Set([...this.held.values()].map((i) => i.holder))
    for (const owners of this.readers.values()) for (const i of owners.values()) holders.add(i.holder)
    for (const holder of holders) {
      const resources = [
        ...[...this.held.entries()].filter(([, i]) => i.holder === holder).map(([r]) => r),
        ...[...this.readers.entries()].filter(([, o]) => o.has(holder)).map(([r]) => r)
      ]
      this._release(holder, resources, reason)
    }
    this.held.clear()
    this.readers.clear()
    return { dropped, released: holders.size }
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
    const add = (r, info) => {
      if (!r.startsWith('lane:')) return
      const lane = r.slice(5)
      byLane[lane] = (byLane[lane] || []).concat([{ tool: info.tool, holder: info.holder, since: info.at, goalId: info.meta?.goalId || null }])
    }
    for (const [r, info] of this.held) add(r, info)
    for (const [r, owners] of this.readers) for (const info of owners.values()) add(r, info)
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
        // A caller that already owns the lease passes lane: false. Otherwise
        // wait for the complete resource set, even when BODY itself is free.
        if (this.lanes && tool && lane !== false) {
          job.lease = await this.lanes.acquire(tool, { goalId, jobId: id })
          if (!job.lease) throw Object.assign(new Error('lease dropped'), { cancelled: true })
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
  COARSE_WORLD,
  COARSE_WORLD_READ,
  REGION_SHIFT,
  MAX_REGION_KEYS,
  regionKey,
  regionsFor,
  laneOf,
  resourcesFor,
  conflicts,
  isShared,
  LaneScheduler,
  JobRegistry
}
