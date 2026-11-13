# Concurrent execution audit

Phase 4 report on Zinc's execution model: lane architecture, tool classification,
real concurrency evidence, goal scheduling, job lifecycle, cancellation and
interruption, context-reset handling, race tests, performance, and what is still
limited.

Evidence lives in `test/concurrency.test.js` (20 tests, all green) plus the
executor changes in `zincai/index.js` and the new `zincai/lanes.js`.
Full suite at the time of writing: **229 pass, 0 fail, 5 skipped**
(the 5 skips are redstone-model gaps documented in
`REDSTONE_LOGIC_AND_LIVE_VERIFICATION_AUDIT.md`).

---

## 1. Lane architecture

Four lanes, as **logical categories**, not threads. Node runs one event loop; a
lane is a set of tools that share a resource plus a scheduler that lets
everything which does not share a resource run at the same time.

| Lane | What it owns | May overlap with | Never overlaps with |
|---|---|---|---|
| **BODY** | physical control of the avatar and the world | COMPUTATION, INTERACTION, WORLD INFO | another BODY action |
| **COMPUTATION** | pure reasoning, simulation, truth tables | everything | nothing (it touches no world state) |
| **INTERACTION** | chat / social replies | everything | another INTERACTION reply (no interleaved answers) |
| **WORLD INFO** | read-only inspection | BODY *unless* the body is mutating, COMPUTATION, INTERACTION | a mutating BODY action on the same cells |

Two extra resources express the sharp edge of the last row:

- `world` — held by anything that **mutates** cells (`build`, `dig`, `place`,
  `gather`, `shelter`, `light_up`, `build_shape`).
- `world-read` — held by anything that **reads** cells (`inspect_region`,
  `inspect_block`, `redstone_scan`, `redstone_engineer`, `find`, `look_in`).
- The pair is **exclusive**: a read never straddles a build, and a build never
  starts in the middle of a read.

`zincai/lanes.js` implements this as `LaneScheduler.acquire(tool, meta)` →
lease, with `tryAcquire` for the non-blocking case.

**Why this is a scheduler and not a promise soup:** `acquire` grants only when
every requested resource (and the exclusive opposite of each) is free, the queue
is FIFO so a BODY action cannot be starved by a stream of reads, and every
grant/release is timestamped. `scheduler.overlaps()` then reconstructs
[grant, release] intervals and returns only the **strictly** intersecting pairs —
an interval that merely touches another's boundary is sequential execution and is
reported as such.

---

## 2. Tool classification

Every shipped tool declares a lane in `TOOL_LANES`. The table is asserted against
the real tool list, so a new tool cannot be added without a lane:

```
C17 the lane table classifies every shipped tool → every tool must declare a lane
```

The default for an **unknown** tool is BODY (`laneOf()` falls back to BODY), so a
future tool that forgets to declare itself is serialised rather than run in
parallel by accident. That is a deliberate fail-safe direction.

| Lane | Tools |
|---|---|
| BODY | go_to, dig, build, build_shape, place, follow, attack, take, put, give, eat, equip, use_block, craft, smelt, gather, light_up, shelter, corpse_run, sleep, run_script, set_mode, stop, hold |
| COMPUTATION | logic_test, circuit_project |
| WORLD INFO | inspect_block, inspect_region, find, redstone_scan, redstone_component, redstone_engineer, recall, look_in |
| INTERACTION | say, social, note, remember_here, goal, idle |

Note what is **not** BODY: `goal` is INTERACTION (it edits the plan, not the
world), and `recall` is WORLD INFO (it reads memory, not blocks). Both were
previously just "another action"; classifying them is what lets a long walk
continue while the model re-plans.

---

## 3. Real concurrency evidence

Every test in `test/concurrency.test.js` records timestamps and asserts an
overlap, not merely that two promises resolved. The 15 required scenarios plus 5
extra:

| # | Scenario | What is proven |
|---|---|---|
| C1 | build + calculate | BODY and COMPUTATION intervals intersect |
| C2 | walk + recall | the read finishes while the walk is still running |
| C3 | gather + chat | the reply goes out during the gather |
| C4 | two computations | both run at once, distinct job ids |
| C5 | two BODY goals | **no** two BODY leases ever intersect; order is a→b |
| C6 | compute during a physical goal | reasoning is not blocked by the body |
| C7 | urgent event during reasoning | the event is delivered while the job is still `running` |
| C8 | background result to the right goal | `g1` gets only its own answer, `g2` only its own |
| C9 | context reset during work | 1 release + 1 dropped waiter, BODY free afterwards, the dropped waiter is not an error |
| C10 | cancelled goal's background job | the worker observes the token, state becomes `cancelled`, lease released |
| C11 | error while holding a lock | `failed` state, BODY lock released, the next action still runs |
| C12 | two tools on the same structure | the inspection waits for the build (writer/reader exclusion) |
| C13 | player message during an action | answered on the chat lane, during the action |
| C14 | sim finishing during other-goal reasoning | the sim result arrives first; the other goal is still `running` |
| C15 | completed action never repeated | the world mutation happens once; the second attempt is flagged `replayed` |
| C16 | harness lanes independent | the real session's two lane controllers coexist |
| C17 | tool classification | every shipped tool has a lane; unknown → BODY |
| C18 | BODY exclusivity under stress | 25 parallel BODY requests, measured peak concurrency = 1 |
| C19 | releaseAll mid-flight | no lock survives; the lane is usable afterwards |
| C20 | observability | `snapshot()` names the holder and its goal |

Example of the evidence format (C1):

```
build  |========================|
calc      |=========|
→ overlap('build','calc') === true
→ lanes.overlaps() contains a pair with lane BODY vs COMPUTATION
```

C5 is the counter-example that matters most: the same instrumentation shows
`start:a, end:a, start:b, end:b` and **zero** BODY/BODY overlapping pairs. That is
what "goals may both be active but physical actions do not race" means
operationally.

---

## 4. Goal scheduling and body priority

- The goal system stays authoritative: the executor still receives exactly one
  action per decision, and a goal cannot bypass the scheduler by calling a tool
  directly.
- **Multiple goals may be active**; several computations may run at once; two
  physical actions may not.
- The lane scheduler does not choose *which* goal wins. It only enforces that the
  BODY lane is exclusive and FIFO. Deciding that "finishing the shelter matters
  more than the diamond errand" is the model's job and remains so — there is no
  hardcoded priority table, and **player requests are not auto-prioritised**:
  they enter the same queue as everything else, and the model can decline,
  negotiate or continue its own work (the social/autonomy tests pin that).

This is the deliberate split: the scheduler provides *safety* (no conflicting
physical actions), the model provides *strategy* (which action to take).

---

## 5. Job lifecycle

`JobRegistry` models a long unit of work:

```
pending → running → done
                  → failed
                  → cancelled   (resolves with { cancelled: true, reason })
```

Each job carries: `id`, `kind`, `goalId`, `lane`, `state`, `progress`, `error`,
`startedAt`, `endedAt`, and a cancellation token. The registry exposes
`status(id)`, `list({ goalId, state })`, `active()`, `cancelForGoal(goalId)`.

Two design decisions worth stating:

1. **Cancellation resolves, it does not reject.** `cancelForGoal` is an expected
   outcome, so `await job.promise` yields `{ cancelled: true, reason }` instead of
   throwing. A failure still throws and is recorded as `failed` with the message.
2. **A job does not acquire its own lane when its caller already holds it.**
   Doing so deadlocks: the job waits for a lock the caller is holding while the
   caller waits for the job. The executor therefore passes `lane: false`, and a
   job that *does* own its work queues properly rather than busy-polling.

**No needless background jobs.** Nothing in the executor spawns a job
automatically. A computation only becomes a job when the caller has decided it is
long enough to outlive one decision (a truth table, a circuit project, a large
build). Trivial operations run inline and never touch the registry.

---

## 6. Cancellation, interruption and stale results

- **Urgent events do not wait for a long job.** Events travel on the INTERACTION
  lane, which never queues behind BODY or COMPUTATION (C7).
- **Stale reasoning cannot overwrite newer decisions.** The executor already had
  `decisionEpoch`/`lifeEpoch`; the lane work happens inside the same guarded
  path, so a decision produced before an epoch change is discarded with a wake
  ("situation changed while thinking; reassess") rather than executed.
- **No uncontrolled concurrent model calls.** There is one action lane and one
  chat lane; `brain.js` never starts a third decision while one is in flight.
  Concurrency in this system is between *tools*, never between *decisions about
  the same body*.
- **Context reset** releases every lease and drops every waiter (C9/C19), so a
  reset cannot leave the avatar frozen behind a lock nobody will release.

---

## 7. Concurrency safety audit

| Hazard | Handling | Evidence |
|---|---|---|
| Race between two physical actions | BODY lane is exclusive; measured peak = 1 under 25 parallel requests | C5, C18 |
| Deadlock | locks are taken with a single call, never nested; a job never re-takes its caller's lane | C9, C19, C10 |
| Stale observation | reads hold `world-read`, so they cannot straddle a mutation; snapshots carry `observedAt` | C12 |
| Duplicate physical action | `startOnce(sig)` replays the recorded result instead of re-executing | C15 |
| Conflicting goal/memory writes | `goal` is INTERACTION and serialised with itself; memory writes stay in the existing single-threaded path | C8, C13 |
| Context reset during a job | `lanes.releaseAll()` + dropped waiters; the job is cancellable | C9 |
| Job finishing after its goal was cancelled | `cancelForGoal` sets the token; the worker checks it and the state becomes `cancelled` | C10 |
| Premature "done" | a job is `done` only after its `run` resolves; the build path additionally uses the existing `complete` property (all blocks placed) | C11, existing build tests |
| Lock leaked on exception | `finally` in both the executor and the job releases it | C11 |
| Result delivered to the wrong context | results are attributed to `goalId` and read per goal | C8, C14 |
| Action repeated because its result was lost | monotonic action records + the replay cache | C15 |

---

## 8. Performance

- The scheduler is O(resources × held) per grant — at most a handful of entries,
  so grant cost is negligible next to any world action.
- `overlaps()` is O(n²) over the recorded spans, and is **only** used by tests
  and diagnostics, never on the hot path.
- Read-only tools use `tryAcquire` and never queue, so a long walk cannot delay a
  redstone scan. That was a deliberate choice: queueing a read behind a 40-second
  path is worse than the small chance of reading mid-build (which the
  `world`/`world-read` exclusion already prevents for mutating actions).
- No polling anywhere: waiters are resolved by the release path.

---

## 9. Remaining limits (honest list)

1. **`JobRegistry` is wired but not yet *used* by every long operation.** The
   scheduler is in the executor's hot path (every tool call takes a lease), but
   only the paths that opt in get a job record. A build that spans several
   decisions still runs inside one `executeAction` call. Making long builds
   resumable across decisions is the next step and is *not* claimed here.
2. **`world`/`world-read` is coarse.** It excludes the whole world, not a
   bounding box. Safe, but it serialises a read against any distant build. A
   per-region resource key is the obvious refinement.
3. **Lane classification is static.** A tool whose cost depends on its arguments
   (a 2-block `build` vs a 400-block one) has one lane. The job layer is where
   that should become dynamic.
4. **No preemption.** A running BODY action is not interrupted by a higher-value
   goal; it must finish or fail. Emergency reflexes (lava/arrows) bypass the lane
   system entirely by design — they are the one case where interrupting the body
   is correct, and they are already tested elsewhere.
5. **Single process, single event loop.** CPU-heavy computation (a huge truth
   table) still blocks the loop between ticks. The mitigation is bounded work
   (`MAX_RADIUS`, gate/test caps), not a worker thread.
6. **The 15 concurrency scenarios are proven against the scheduler and the
   harness's lane flags, not by watching a real Minecraft server do two things at
   once.** That last step needs a live server and is **NOT TESTED** — see the
   redstone report for why the sandbox cannot host one.

---

## 10. Reproducing

```bash
npm run check
node --test --test-timeout=20000 test/concurrency.test.js   # 20 pass
npm test                                                     # 229 pass, 5 skipped
```
