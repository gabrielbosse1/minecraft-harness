# Concurrent execution audit

This report covers the lane scheduler, regional resource keys and resumable build
jobs in the simulated harness. It does **not** claim verification on a live
Minecraft server. Latest full run: **244 passed, 0 failed, 5 skipped**.
`npm run check` passed; the targeted concurrency suite passed 33 tests and the
goal-orchestration suite passed 18 tests. Reproduction commands are below.

## Architecture and resource keys

`zincai/lanes.js` groups actions into BODY, WORLD_INFO, COMPUTATION and
INTERACTION lanes. BODY and INTERACTION are exclusive; WORLD_INFO and
COMPUTATION are shared. An acquisition grants the complete set of resources at
once, never one chunk at a time. A waiting acquisition holds no partial set.
Read-only actions use `tryAcquire`: a conflict is reported as busy, not executed
without a lock. BODY actions wait for their grant. A background action takes
ownership of the lease until its work actually exits.

The scheduler accepts footprints and names 16-by-16 block columns as
`world:chunkX,chunkZ` and `world-read:chunkX,chunkZ`. Readers share; a writer
excludes readers of its chunks. Coarse `world` and `world-read` conflict with
regional keys, so roaming actions cannot bypass a regional lock. Invalid or
unknown footprints fall back to coarse locks; footprints exceeding 64 regions
also fall back. Region coordinates use floor division, including negatives.
`R1`–`R13` cover shared reads, reverse and boundary boxes, multi-chunk atomicity,
coarse/regional conflicts, waiters, and the oversized fallback. G17 also drives
real harness inspection actions: a conflicting read is refused while an
unrelated region can be inspected during a build.

At the action boundary only bounded `inspect_block`, `inspect_region` and
eligible `build_shape` calls get regional footprints. Roaming `dig`, `gather`,
`find`, blueprint builds and operations without a proven footprint stay coarse.
`look_in` is BODY because opening a container can move the bot. A shape that may
need scaffolding, or has outstanding scaffolds to clean up, uses a coarse lock.
For a regional build, unexpected additional scaffold needs are skipped rather
than mutating outside the lease; retrying/replanning may be necessary.

## Build jobs and interruption

A `build` or `build_shape` main task creates an in-memory `JobRegistry` job tied
to the durable goal. It records progress from the executor; the action can return
while the job continues. The worker inherits a BODY lease, or acquires one if
resuming outside a BODY action, and releases it only after the worker finishes.
Goal cancellation and suspension signal the job and builder. A resumed goal is
reconciled against observed blocks, keeps its original origin and plan, and
starts a new job. Inventory preflight counts blocks still missing from observed
world state; unreadable cells are conservatively treated as missing.

A context reset drops waiting decisions, settling their promises, but does not
unlock a running build or erase its in-memory job. Process restart is different:
job records are not persisted; existing goal persistence and world reconciliation
provide the manual recovery path. Cancellation is cooperative and can wait for
an in-flight operation to return.

## Evidence

| Evidence | Scope |
|---|---|
| C1–C20, `test/concurrency.test.js` | Scheduler overlap/exclusion, job lifecycle, cancellation, lane classification, and simulated-session instrumentation. Some scenarios exercise scheduler units rather than physical actions. |
| R1–R13, same file | Region key overlap, lock sharing, atomicity, fallback, waiters, background build lease, and job resource waiting. |
| G3, `test/goal-orchestration.test.js` | A real simulated build is interrupted; the same durable goal and origin are resumed under a new job. |
| G17, same file | A live simulated build retains its job and BODY lease across context reset; real near and far inspections exercise regional admission; cancelling the goal stops the job. |
| G18, same file | An interrupted build completes from observed world progress using only the remaining materials. |
| Existing goal restart tests | Persisted goal metadata and reconciliation, not persistence of an in-memory job. |

C9/C19 and R10 test the scheduler's explicit `releaseAll` primitive, not the
session reset behavior: forcibly releasing a lease while its worker still runs is
unsafe. Session reset instead uses `dropWaiters` and preserves active leases.

## Limits / NOT TESTED

- **Live Minecraft: NOT TESTED.** These tests use the synthetic bot and world;
  packet timing, real chunk loading, server lag and actual placement/scaffolding
  behavior remain unverified. No Java server was run in this environment.
- Job records and their progress are **in memory only**. A process restart does
  not automatically restart a job: a persisted goal must be reconciled and
  resumed. Other long actions do not all create job records.
- The lock model covers the mapped executor actions, not all Mineflayer, combat,
  survival-reflex or plugin activity. Reflexes can bypass the action scheduler;
  do not treat the locks as a global server-side transaction or an atomic world
  snapshot. Other players can modify the world concurrently.
- This is a single event loop, not CPU parallelism. Read failures are returned
  as busy instead of waiting. Lane/resource classification is static, and
  callers that cannot prove a bounded footprint intentionally serialize more.
- A lease cannot make a worker instantly cancellable. The scheduler does not
  implement priority-based preemption. Some replacement and error paths outside
  the tested goal/build flows remain dependent on cooperative cancellation.
- The scheduler's replay cache and job registry tests do not establish exactly
  once physical mutations across process crashes or loss of server responses.
- The existing redstone suite has five skips; see
  `REDSTONE_LOGIC_AND_LIVE_VERIFICATION_AUDIT.md` for those modeling gaps.

## Reproduction

```sh
npm run check
node --test --test-timeout=20000 test/concurrency.test.js
node --test --test-timeout=20000 test/goal-orchestration.test.js
npm test
```

Run the test commands sequentially: several suites share process-wide test
fixtures and concurrent test invocations can produce misleading failures.
