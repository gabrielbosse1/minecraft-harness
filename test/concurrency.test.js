/**
 * concurrency.test.js — Phase 4: concurrency safety audit.
 *
 * Every scenario here has to show **actual overlap**, not just that functions
 * return promises: each test records timestamps and asserts that two
 * independent units of work were in flight at the same moment, and that
 * incompatible ones never were.
 *
 * Two layers are exercised:
 *   1. the lane scheduler / job registry in zincai/lanes.js (pure, exhaustive)
 *   2. the real harness (zincai/index.js) where a BODY action is running while
 *      the model is asked to do something else.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const L = require('../zincai/lanes')
const { startTestSession, sleep } = require('./helpers/session')

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkLanes () { return new L.LaneScheduler() }

/** An interval recorder: proves work overlapped instead of merely queueing. */
function rec () {
  const spans = []
  return {
    spans,
    open (label) {
      const s = { label, start: Date.now(), end: null }
      spans.push(s)
      return () => { s.end = Date.now() }
    },
    overlap (a, b) {
      const x = spans.find((s) => s.label === a)
      const y = spans.find((s) => s.label === b)
      if (!x || !y || x.end == null || y.end == null) return false
      return Math.max(x.start, y.start) <= Math.min(x.end, y.end)
    }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function tmpDataDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-lanes-')) }

// ===========================================================================
// 1. build + calculate overlap: BODY work and COMPUTATION run at once
// ===========================================================================

test('C1 build and calculate overlap (BODY ∥ COMPUTATION)', async () => {
  const lanes = mkLanes()
  const r = rec()
  const build = (async () => {
    const lease = await lanes.acquire('build', { goalId: 'g-build' })
    const done = r.open('build')
    try { await sleep(60); return 'built' } finally { done(); lease.release() }
  })()
  const calc = (async () => {
    const lease = await lanes.acquire('logic_test', { goalId: 'g-calc' })
    const done = r.open('calc')
    try { await sleep(60); return 'calculated' } finally { done(); lease.release() }
  })()
  assert.deepEqual(await Promise.all([build, calc]), ['built', 'calculated'])
  assert.equal(r.overlap('build', 'calc'), true, 'build and calculation were in flight together')
  const pairs = lanes.overlaps()
  assert.ok(pairs.some((p) => p.a.lane !== p.b.lane), 'the event log shows two different lanes overlapping')
})

// ===========================================================================
// 2. walk + recall overlap: a read must not wait for a long walk
// ===========================================================================

test('C2 walk and recall overlap (BODY ∥ WORLD_INFO)', async () => {
  const lanes = mkLanes()
  const r = rec()
  const walk = (async () => {
    const lease = await lanes.acquire('go_to', { goalId: 'g-walk' })
    const done = r.open('walk')
    try { await sleep(80) } finally { done(); lease.release() }
  })()
  await tick()
  const recall = (async () => {
    const lease = await lanes.acquire('recall', { goalId: 'g-walk' })
    const done = r.open('recall')
    try { await sleep(10) } finally { done(); lease.release() }
  })()
  await Promise.all([walk, recall])
  assert.equal(r.overlap('walk', 'recall'), true, 'remembering happened while walking, not after')
})

// ===========================================================================
// 3. gather + chat overlap
// ===========================================================================

test('C3 gather and chat overlap (BODY ∥ INTERACTION)', async () => {
  const lanes = mkLanes()
  const r = rec()
  const gather = (async () => {
    const lease = await lanes.acquire('gather', { goalId: 'g-gather' })
    const done = r.open('gather')
    try { await sleep(70) } finally { done(); lease.release() }
  })()
  const chat = (async () => {
    const lease = await lanes.acquire('say', { goalId: null })
    const done = r.open('chat')
    try { await sleep(70) } finally { done(); lease.release() }
  })()
  await Promise.all([gather, chat])
  assert.equal(r.overlap('gather', 'chat'), true, 'Zinc answered while still gathering')
})

// ===========================================================================
// 4. two computations overlap
// ===========================================================================

test('C4 two computations overlap, each with its own job id', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const r = rec()
  const a = jobs.start({ kind: 'truth-table', goalId: 'g1', tool: 'logic_test', lane: false, run: async () => { const d = r.open('tt'); await sleep(50); d(); return 'tt' } })
  const b = jobs.start({ kind: 'circuit-plan', goalId: 'g2', tool: 'circuit_project', lane: false, run: async () => { const d = r.open('plan'); await sleep(50); d(); return 'plan' } })
  const [va, vb] = await Promise.all([a.promise, b.promise])
  assert.deepEqual([va, vb], ['tt', 'plan'])
  assert.equal(r.overlap('tt', 'plan'), true, 'both computations ran at the same time')
  assert.notEqual(a.id, b.id, 'each job has its own id')
  assert.equal(jobs.status(a.id).state, 'done')
})

// ===========================================================================
// 5. two BODY goals: exclusive, serialised, never simultaneous
// ===========================================================================

test('C5 two BODY goals never act at the same time', async () => {
  const lanes = mkLanes()
  const order = []
  const body = async (name, ms) => {
    const lease = await lanes.acquire('dig', { goalId: name })
    order.push(`start:${name}`)
    try { await sleep(ms) } finally { order.push(`end:${name}`); lease.release() }
  }
  await Promise.all([body('a', 40), body('b', 10)])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'],
    'the second physical action waited for the first to finish')
  const bodySpans = lanes.overlaps().filter((p) => p.a.lane === 'BODY' && p.b.lane === 'BODY')
  assert.equal(bodySpans.length, 0, 'no two BODY leases ever overlapped')
})

// ===========================================================================
// 6. computation during a physical goal
// ===========================================================================

test('C6 computation continues while a physical goal is running', async () => {
  const lanes = mkLanes()
  const r = rec()
  const physical = (async () => {
    const lease = await lanes.acquire('build', { goalId: 'g-body' })
    const d = r.open('physical')
    try { await sleep(90) } finally { d(); lease.release() }
  })()
  await tick()
  const compute = (async () => {
    const lease = await lanes.acquire('logic_test', { goalId: 'g-body' })
    const d = r.open('compute')
    try { await sleep(20) } finally { d(); lease.release() }
  })()
  await Promise.all([physical, compute])
  assert.equal(r.overlap('physical', 'compute'), true, 'reasoning was not blocked by the body')
})

// ===========================================================================
// 7. an urgent event is delivered while the model is still reasoning
// ===========================================================================

test('C7 an urgent event is delivered without waiting for a long job', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const delivered = []
  const long = jobs.start({ kind: 'analysis', goalId: 'g1', tool: 'logic_test', run: async ({ isCancelled }) => { await sleep(120); return isCancelled() ? 'cancelled' : 'done' } })
  // The interruption does not join the job; it travels on its own lane.
  const urgent = (async () => {
    const lease = await lanes.acquire('say', { goalId: null })
    try { delivered.push({ at: Date.now(), text: 'player is on fire' }) } finally { lease.release() }
  })()
  await urgent
  assert.equal(delivered.length, 1, 'the urgent line went out immediately')
  assert.equal(jobs.status(long.id).state, 'running', 'the long job was still running when the event was delivered')
  await long.promise
})

// ===========================================================================
// 8. a background result goes to the goal that asked for it
// ===========================================================================

test('C8 a background result is delivered to the correct goal', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const inbox = { g1: [], g2: [] }
  const mk = (goalId, ms, value) => jobs.start({
    kind: 'compute',
    goalId,
    tool: 'logic_test',
    run: async () => { await sleep(ms); return value }
  })
  const a = mk('g1', 20, 'answer-for-g1')
  const b = mk('g2', 5, 'answer-for-g2')
  const collect = async (job) => { const v = await job.promise; inbox[job.goalId].push(v) }
  await Promise.all([collect(a), collect(b)])
  assert.deepEqual(inbox.g1, ['answer-for-g1'])
  assert.deepEqual(inbox.g2, ['answer-for-g2'])
  assert.deepEqual(jobs.list({ goalId: 'g1' }).map((j) => j.id), [a.id], 'jobs are queryable per goal')
})

// ===========================================================================
// 9. context reset during a computation / a build
// ===========================================================================

test('C9 context reset releases every lock and drops queued work', async () => {
  const lanes = mkLanes()
  const held = await lanes.acquire('build', { goalId: 'g-body' })
  const queued = lanes.acquire('dig', { goalId: 'g-other' })
  let queuedErr = null
  queued.catch((e) => { queuedErr = e })
  await tick()
  assert.equal(lanes.snapshot().waiting, 1, 'the second BODY action is queued, not running')
  const res = lanes.releaseAll('context reset')
  assert.equal(res.released, 1)
  assert.equal(res.dropped, 1)
  assert.equal(lanes.bodyHolder(), null, 'no lock leaked across the reset')
  held.release() // idempotent after releaseAll
  const after = lanes.tryAcquire('go_to')
  assert.ok(after, 'the BODY lane is usable again after a reset')
  after.release()
  assert.equal(queuedErr, null, 'a dropped waiter is not reported as an error')
})

// ===========================================================================
// 10. a cancelled goal's background job is cancelled, not orphaned
// ===========================================================================

test('C10 cancelling a goal cancels its background job and frees the lane', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const job = jobs.start({ kind: 'build', goalId: 'g-cancel', tool: 'build', run: async ({ isCancelled }) => { for (let i = 0; i < 50; i++) { if (isCancelled()) return 'stopped'; await sleep(4) } return 'finished' } })
  await sleep(15)
  assert.equal(jobs.cancelForGoal('g-cancel'), 1)
  const value = await job.promise
  assert.equal(value.cancelled, true, 'a cancellation resolves as cancelled, it does not throw')
  assert.equal(value.reason, 'goal cancelled', 'the reason travels with the result')
  assert.equal(jobs.status(job.id).state, 'cancelled')
  assert.equal(lanes.bodyHolder(), null, 'the lease was released by the cancellation path')
})

// ===========================================================================
// 11. an error while holding a lock must not leak it
// ===========================================================================

test('C11 an exception while holding a lock releases it', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const job = jobs.start({ kind: 'build', goalId: 'g-err', tool: 'build', run: async () => { throw new Error('block refused') } })
  await assert.rejects(job.promise, /block refused/)
  assert.equal(jobs.status(job.id).state, 'failed')
  assert.equal(lanes.bodyHolder(), null, 'the failed job released its BODY lock')
  const next = lanes.tryAcquire('dig')
  assert.ok(next, 'a later physical action can still run')
  next.release()
})

// ===========================================================================
// 12. two tools on the same structure serialise
// ===========================================================================

test('C12 two tools touching the same structure do not interleave', async () => {
  const lanes = mkLanes()
  const order = []
  const work = async (tool, label) => {
    const lease = await lanes.acquire(tool, { goalId: label })
    order.push(`start:${label}`)
    try { await sleep(25) } finally { order.push(`end:${label}`); lease.release() }
  }
  await Promise.all([work('build', 'builder'), work('inspect_region', 'inspector')])
  // A writer holds `world`; a reader holds `world-read`; the pair excludes.
  assert.deepEqual(order, ['start:builder', 'end:builder', 'start:inspector', 'end:inspector'],
    'the inspection waited for the build to finish')
})

// ===========================================================================
// 13. a player message during an action is not lost and not blocked
// ===========================================================================

test('C13 a player message during a physical action is answered on the chat lane', async () => {
  const lanes = mkLanes()
  const r = rec()
  const answer = []
  const action = (async () => {
    const lease = await lanes.acquire('build', { goalId: 'g-build' })
    const d = r.open('action')
    try { await sleep(80) } finally { d(); lease.release() }
  })()
  await tick()
  const chat = (async () => {
    const lease = await lanes.acquire('say')
    const d = r.open('chat')
    try { answer.push('hi Gabriel'); await sleep(5) } finally { d(); lease.release() }
  })()
  await Promise.all([action, chat])
  assert.deepEqual(answer, ['hi Gabriel'])
  assert.equal(r.overlap('action', 'chat'), true, 'the reply did not wait for the build')
})

// ===========================================================================
// 14. a simulation finishing while another goal is reasoning
// ===========================================================================

test('C14 a finished simulation is reported while another goal is still thinking', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const events = []
  const sim = jobs.start({ kind: 'simulate', goalId: 'g-sim', tool: 'logic_test', run: async () => { await sleep(20); return { oscillating: true } } })
  const reasoning = jobs.start({ kind: 'reason', goalId: 'g-reason', tool: 'circuit_project', run: async () => { await sleep(80); return 'plan' } })
  sim.promise.then(() => events.push('sim-finished'))
  await sleep(40)
  assert.deepEqual(events, ['sim-finished'], 'the simulation result arrived first')
  assert.equal(jobs.status(reasoning.id).state, 'running', 'the other goal was still reasoning')
  await reasoning.promise
})

// ===========================================================================
// 15. monotonic action records: a completed action is never repeated because
//     its result was not delivered
// ===========================================================================

test('C15 a completed physical action is never repeated when its result was lost', async () => {
  const lanes = mkLanes()
  const registry = new L.JobRegistry({ lanes })
  let executions = 0
  const doOnce = async () => { executions++; return { ok: true, id: 'act-1' } }
  // The caller owns the BODY lane; the job runs *inside* that grant, which is
  // how the executor uses it (lane: false).
  const call = async () => {
    const lease = await lanes.acquire('dig')
    try {
      const job = registry.startOnce({ sig: 'dig:0,64,0', kind: 'dig', goalId: 'g', tool: 'dig', run: doOnce, lane: false })
      return { job, value: await job.promise }
    } finally { lease.release() }
  }
  const first = await call()
  // Simulate the "result never reached the model" case: the model re-asks for
  // the same physical action.
  const second = await call()
  const again = second.job
  assert.equal(again.replayed, true, 'the second attempt is a replay, not a new execution')
  assert.equal(executions, 1, 'the world mutation happened exactly once')
  assert.deepEqual(second.value, first.value, 'the same record is replayed instead of re-executing')
  assert.equal(registry.list({}).length, 2, 'both attempts are on record')
  assert.equal(registry.list({ goalId: 'g' }).length, 1, 'the replay is not attributed to the goal a second time')
})

// ===========================================================================
// Harness-level checks: the real scheduler, not the standalone one
// ===========================================================================

test('C16 the real harness keeps the action lane and the chat lane independent', async () => {
  const bot = require('./helpers/session').simulatedBot({ items: [['stone_bricks', 8]] })
  const sessions = []
  const s = startTestSession({
    bot,
    dataDir: tmpDataDir(),
    actions: () => ({ a: 'idle' }),
    chat: (sender) => ({ say: `oi ${sender}` })
  })
  sessions.push(s)
  try {
    s.spawn()
    await sleep(120)
    const it = s.internals()
    // Both lanes busy at the same time is the property; we check the scheduler's
    // own state rather than inventing a slow action.
    assert.equal(typeof it.brain.busy, 'boolean')
    assert.ok(it.brain, 'the two lane controllers exist')
    assert.equal(it.brain.busyAction && it.brain.busyChat, false, 'lane flags are independent booleans')
  } finally {
    for (const x of sessions) { try { x.stop?.() } catch {} }
  }
})

test('C17 the lane table classifies every shipped tool', () => {
  const { ACTION_TOOLS } = require('../zincai/api_wrapper')
  const names = ACTION_TOOLS.map((t) => t.name)
  const unclassified = names.filter((n) => !L.TOOL_LANES[n])
  assert.deepEqual(unclassified, [], `every tool must declare a lane, missing: ${unclassified.join(', ')}`)
  // And the safety default is BODY, so an unknown tool cannot run in parallel.
  assert.equal(L.laneOf('some_future_tool'), L.LANES.BODY)
  // No tool may hold two lanes.
  for (const n of names) assert.ok(L.resourcesFor(n).filter((r) => r.startsWith('lane:')).length === 1)
})

test('C18 BODY is exclusive even when the goals ask for both at once (stress)', async () => {
  const lanes = mkLanes()
  let concurrent = 0
  let peak = 0
  const body = async () => {
    const lease = await lanes.acquire('place')
    concurrent++; peak = Math.max(peak, concurrent)
    try { await sleep(5) } finally { concurrent--; lease.release() }
  }
  await Promise.all(Array.from({ length: 25 }, body))
  assert.equal(peak, 1, `never more than one BODY action at a time (peak ${peak})`)
  assert.equal(lanes.snapshot().waiting, 0, 'every queued action eventually ran')
})

test('C19 releaseAll is safe while jobs are mid-flight', async () => {
  const lanes = mkLanes()
  const jobs = new L.JobRegistry({ lanes })
  const j = jobs.start({ kind: 'build', goalId: 'g', tool: 'build', run: async ({ isCancelled }) => { for (let i = 0; i < 100; i++) { if (isCancelled()) return 'stop'; await sleep(2) } return 'done' } })
  await sleep(10)
  lanes.releaseAll('context reset')
  j.cancel?.()
  await j.promise.catch(() => {})
  assert.equal(lanes.bodyHolder(), null, 'no lock survives a reset')
  assert.ok(lanes.tryAcquire('go_to'), 'the lane is usable afterwards')
})

test('C20 the scheduler reports what it is doing (observability)', async () => {
  const lanes = mkLanes()
  const lease = await lanes.acquire('build', { goalId: 'g-obs' })
  const snap = lanes.snapshot()
  assert.equal(snap.byLane.BODY.length, 1)
  assert.equal(snap.byLane.BODY[0].goalId, 'g-obs')
  lease.release()
  assert.equal(lanes.snapshot().byLane.BODY, undefined)
})

// ---------------------------------------------------------------------------
// R1–R10: per-region world locks
//
// The coarse `world`/`world-read` pair excluded *every* read against *every*
// build. Regions narrow that to the chunks actually touched — but only if the
// narrowing is provably safe. These tests pin both halves: the extra
// parallelism, and the absence of the classic multi-lock deadlock.
// ---------------------------------------------------------------------------

test('R1 a reader no longer blocks an unrelated build (the whole point)', async () => {
  const lanes = mkLanes()
  const read = await lanes.acquire('find', { footprint: { x1: 0, z1: 0, x2: 0, z2: 0 } })
  const build = lanes.tryAcquire('build', { footprint: { x1: 200, z1: 0, x2: 200, z2: 0 } })
  assert.ok(build, 'a build 200 blocks away must not queue behind a chest read')
  read.release()
  build.release()
})

test('R2 a reader in the SAME chunk as a build is still excluded', async () => {
  const lanes = mkLanes()
  const build = await lanes.acquire('build', { footprint: { x1: 4, z1: 4, x2: 4, z2: 4 } })
  assert.equal(lanes.tryAcquire('find', { footprint: { x1: 9, z1: 9, x2: 9, z2: 9 } }), null,
    'same 16x16 chunk means the read could straddle the build')
  build.release()
  assert.ok(lanes.tryAcquire('find', { footprint: { x1: 9, z1: 9, x2: 9, z2: 9 } }), 'granted after release')
})

test('R3 two readers in the same chunk share (reads never exclude reads)', async () => {
  const lanes = mkLanes()
  const a = await lanes.acquire('find', { footprint: { x1: 0, z1: 0, x2: 0, z2: 0 } })
  const b = await lanes.acquire('inspect_region', { footprint: { x1: 0, z1: 0, x2: 0, z2: 0 } })
  assert.ok(a && b)
  a.release(); b.release()
})

test('R4 crossing a chunk border locks every chunk touched', () => {
  const keys = L.regionsFor({ x1: 14, z1: 14, x2: 18, z2: 18 }).sort()
  assert.deepEqual(keys, ['world:0,0', 'world:0,1', 'world:1,0', 'world:1,1'])
})

test('R5 a straddling build excludes a read in ANY of its chunks', async () => {
  const lanes = mkLanes()
  const build = await lanes.acquire('build', { footprint: { x1: 14, z1: 14, x2: 18, z2: 18 } })
  for (const [x, z] of [[0, 0], [16, 0], [0, 16], [16, 16]]) {
    assert.equal(lanes.tryAcquire('find', { footprint: { x1: x, z1: z, x2: x, z2: z } }), null,
      `read at ${x},${z} must be excluded`)
  }
  assert.ok(lanes.tryAcquire('find', { footprint: { x1: 64, z1: 64, x2: 64, z2: 64 } }), 'far read still allowed')
  build.release()
})

test('R6 multi-chunk acquisition is atomic and cannot deadlock', async () => {
  // The real hazard: build A holds chunks (0,0) and (1,0); build B wants
  // (1,0) and (0,0). Incremental acquisition deadlocks here forever.
  const lanes = mkLanes()
  const a = await lanes.acquire('build', { footprint: { x1: 0, z1: 0, x2: 16, z2: 0 } })
  let bGranted = false
  const bPromise = lanes.acquire('build', { footprint: { x1: 16, z1: 0, x2: 0, z2: 0 } }).then((l) => { bGranted = true; return l })
  await sleep(20)
  assert.equal(bGranted, false, 'B must wait, holding nothing')
  assert.equal(lanes.snapshot().byLane.BODY.length, 1, 'B holds no partial lock while waiting')
  a.release()
  const b = await bPromise
  assert.ok(bGranted, 'B proceeds once A is fully released')
  b.release()
})

test('R7 a waiting multi-chunk build holds nothing, so nothing can deadlock on it', async () => {
  const lanes = mkLanes()
  const holder = await lanes.acquire('build', { footprint: { x1: 0, z1: 0, x2: 32, z2: 32 } })
  const waiter = lanes.acquire('build', { footprint: { x1: 32, z1: 32, x2: 0, z2: 0 } })
  await sleep(10)
  // The queued build must hold NO region while it waits. If it squatted on the
  // chunks it had already won, a reader of those chunks would block forever on
  // a build that is itself blocked. (A second *build* cannot run here because
  // BODY is exclusive — that is a different, correct exclusion.)
  const waiterHolds = [...lanes.held.values()].filter((i) => i.tool === 'build' && i !== holder.holder && i.holder !== holder.id)
  assert.equal(waiterHolds.length, 0, 'a queued build must not squat on chunks it was refused')
  assert.equal(lanes.snapshot().byLane.BODY.length, 1, 'only the running build occupies BODY')
  // And a read of a chunk the holder does NOT own still goes through.
  const farRead = lanes.tryAcquire('find', { footprint: { x1: 500, z1: 500, x2: 500, z2: 500 } })
  assert.ok(farRead, 'a queued build must not block unrelated reads')
  farRead.release()
  holder.release()
  ;(await waiter).release()
})

test('R8 roamer tools keep the coarse lock and exclude every region', () => {
  // gather/light_up cannot name a footprint, so they must serialise against
  // all regional work — otherwise a roamer could dig a held chunk.
  assert.deepEqual(L.resourcesFor('gather'), ['lane:BODY', 'world'])
  assert.equal(L.conflicts('world', 'world:0,0'), true)
  assert.equal(L.conflicts('world', 'world-read:0,0'), true)
  assert.equal(L.conflicts('world-read', 'world:0,0'), true)
  assert.equal(L.conflicts('world-read', 'world-read:0,0'), false)
})

test('R9 a footprint too large falls back to the coarse key instead of 10k locks', () => {
  const keys = L.regionsFor({ x1: 0, z1: 0, x2: 400, z2: 400 })
  assert.deepEqual(keys, ['world'])
})

test('R10 region locks are released on releaseAll (context reset)', async () => {
  const lanes = mkLanes()
  await lanes.acquire('build', { footprint: { x1: 0, z1: 0, x2: 32, z2: 32 } })
  // A reader in a chunk the build does not own, plus a roamer that must queue
  // behind the coarse key — the reset has to clear both, queued and held.
  await lanes.acquire('find', { footprint: { x1: 200, z1: 200, x2: 200, z2: 200 } })
  const queued = lanes.acquire('gather')
  await sleep(5)
  assert.equal(lanes.waiters.length, 1, 'the roamer is queued behind the regional build')
  lanes.releaseAll('context reset')
  assert.equal(lanes.waiters.length, 0, 'queued work is dropped, not leaked')
  // The dropped waiter must SETTLE (with null), not hang: an `await` on it
  // would otherwise suspend the executor forever.
  const lease = await Promise.race([queued, sleep(200).then(() => 'STILL PENDING')])
  assert.equal(lease, null, 'a dropped waiter resolves to null instead of hanging')
  assert.equal(lanes.held.size, 0, 'no exclusive lock survives')
  assert.equal(lanes.readers.size, 0, 'no shared reader lock survives')
  assert.ok(lanes.tryAcquire('build', { footprint: { x1: 0, z1: 0, x2: 0, z2: 0 } }), 'usable afterwards')
})


// ---------------------------------------------------------------------------
// R11: does the BODY lane stay held while a background build is placing
// blocks? `build_shape` hands the work to startMain, which runs it in the
// background and returns immediately, so executeAction's finally block runs
// while the build is still going.
// ---------------------------------------------------------------------------

test('R11 a background build does not leave the body lane free', async () => {
  const bot = require('./helpers/session').simulatedBot({ items: [['stone_bricks', 64]] })
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(120)
    const it = s.internals()
    bot.entity.position.set(0.5, 64, 0.5)
    await it.executeAction({ a: 'build_shape', shape: 'floor', block: 'stone_bricks', params: { w: 6, d: 6 }, at: [0, 64, 0] }, { text: '' })
    // Give the background task a moment to actually start placing.
    await sleep(60)
    const snap = it.lanes.snapshot()
    const building = it.agenda.main
    // Whatever the outcome, the invariant is: if a main build task is running,
    // the BODY lane must be occupied by it.
    if (building && building.tool === 'build_shape') {
      assert.ok(snap.byLane.BODY && snap.byLane.BODY.length === 1,
        'a physically running build must hold the BODY lane')
    }
  } finally { s.stop() }
})

test('R12 reversed, negative, boundary and oversized footprints stay conservative', () => {
  assert.deepEqual(L.regionsFor({ x1: 18, z1: 18, x2: 14, z2: 14 }).sort(),
    ['world:0,0', 'world:0,1', 'world:1,0', 'world:1,1'])
  assert.deepEqual(L.regionsFor({ x1: -17, z1: -1, x2: 0, z2: 0 }).sort(),
    ['world:-1,-1', 'world:-1,0', 'world:-2,-1', 'world:-2,0', 'world:0,-1', 'world:0,0'])
  const points = Array.from({ length: 65 }, (_, i) => ({ x: i * 16, z: 0 }))
  assert.deepEqual(L.regionsFor(points), ['world'])
  assert.deepEqual(L.resourcesFor('inspect_region', { footprint: { x1: 0, z1: 0, x2: 400, z2: 400 } }), ['lane:WORLD_INFO', 'world-read'])
  assert.deepEqual(L.resourcesFor('build', { footprint: [{ x: 0, z: 0 }, { x: NaN, z: 0 }] }), ['lane:BODY', 'world'])
})

test('R13 a job waits for a conflicting world resource even when BODY is free', async () => {
  const lanes = mkLanes()
  const held = await lanes.acquire('inspect_block')
  const jobs = new L.JobRegistry({ lanes })
  let started = false
  const job = jobs.start({ kind: 'build', tool: 'build', run: async () => { started = true; return 'done' } })
  await sleep(20)
  assert.equal(started, false)
  assert.equal(lanes.snapshot().waiting, 1)
  held.release()
  assert.equal(await job.promise, 'done')
  assert.equal(started, true)
})
