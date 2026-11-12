# Goal Orchestration Audit — Zinc (minecraft-harness)

Date: 2026-11-12
Branch: `arena/9b7ab8ea-minecraft-harness` (from `main` @ `67cb863`)
Scope: goal orchestration, priorities, autonomy, persistent task state — and the
interactions between them. **Not** a general audit: the wire protocol, chat,
perception and building code were only touched where they carry goal state.

---

## Verdict

> **CONDITIONAL — no objective can be silently lost inside the tested envelope;
> three operational conditions (C1–C3, §H.4) must hold.**
>
> Before this review the answer would have been **NOT READY**: the review found
> six real defects (fix table in §H.1), four of which lost or froze an objective
> — including a transition rule that made it *impossible* to close an
> interrupted build that the world proved finished, and a progress clamp that
> reported 0% forever. They are fixed and covered by tests.
> What remains is documented in §H.3 — all of it expressible as an operational
> note, none of it requiring another architectural change.

| The user's priorities | Verdict |
| --- | --- |
| Lost objectives | **Pass** — G1–G8, G10, G14 (and fix D3/D4, which were the actual holes) |
| Incorrect priority handling | **Pass** — deterministic priority map, newest-decision-wins, waiting list ordered by priority then age (G6, G7, G11) |
| Controller conflicts | **Pass** — one body, one main task, side jobs *pause* rather than run beside (G6, G7, G11); no fake concurrency was introduced |
| Stale actions | **Pass** — decision epoch + goal-id snapshot + fresh-threat check (G9) |
| Broken task persistence | **Pass** — atomic JSON, forced saves on every transition, demotion on load (G1, G2, G14) |
| Incorrect resumption | **Pass** — same origin, remaining work, world re-read first (G3, G5, G8, G16) |
| Infinite task loops | **Pass with watch item** — stall nudge, blocked suspend, resume cap, starvation nudge (G7, G13); see R3 in §H.3 |
| Incorrect completion detection | **Pass** — completion requires task evidence *and* a world verdict (G10, G5) |
| Data races around goal state | **Pass with watch item** — single-writer registry, sequence-tagged late results, terminal states guarded (G2, G7); see R1 in §H.3 |

Reproduction: `npm test` → **282/282 pass**, `npm run check` → clean. The 16
goal-orchestration tests are `test/goal-orchestration.test.js` (G1–G16).

---

## A. Method and evidence base

What was actually read and run (not assumed):

1. **Current implementation, end to end.**
   `zincai/goals.js` (601 lines, new), `zincai/index.js` (2170 lines — agenda,
   goal helpers, prompt lanes, watchdog, lifecycle hooks), `zincai/skills.js`
   (gather/build progress contract), `zincai/builder.js` (phases, plan),
   `zincai/control.js` (lanes/arbiter), `zincai/system1.js`, `zincai/brain.js`,
   `zincai/api_wrapper.js` (tool schema), `zincai/config.json`.
2. **Prior findings**, used only as a list of questions to check against code:
   `.zinc-test-run/reports/{FAILURES,FINAL_REPORT,REMEDIATION_REPORT}.md`.
   Every claimed remediation relevant to goals was re-verified in the source;
   none was taken on trust.
3. **The test rig**, because the live server is not reachable from this sandbox:
   `test/helpers/session.js` (real `startSession` with a simulated bot),
   `test/helpers/world.js`. `test/helpers/session.js` was extended to accept a
   shared `dataDir`, which is what makes a *restart* testable (`stop()`, new
   session, same `goals.json`).
4. **New behavioural tests**: `test/goal-orchestration.test.js`, G1–G16, each
   one a scenario from the review brief (identity, restart, interruption,
   death, priority, two players, staleness, completion, progress, dimension).
5. **Full suite + syntax gate** after every change: `npm test` (282),
   `npm run check`.

Explicitly **not** verified here: a real Minecraft server. Anything that depends
on server physics (creepers, chunk unload, a bot pushed out of a block) is left
to the campaign rig; the tests assert the orchestration contract, not the world.

---

## B. What the orchestration layer is now

```
                 ┌──────────────────────────────────────────────┐
   model turn →  │ executeAction(action, snap)                  │
                 │   • staleActionReason(action, snap)          │  ← refuse
                 │   • build / gather / go_to → startMain()     │
                 │   • give / take / put / smelt → startSide()   │
                 │   • goal tool            → runGoalOp()       │
                 └───────────────┬──────────────────────────────┘
                                 │ one body, one owner
                 ┌───────────────▼──────────────────────────────┐
                 │ agenda = { main, shelved[], asked[] }        │  in-process
                 │   startMain: shelfMain(prev) → replaceTask() │
                 │   startSide: pauseMain() → resumeMain()      │
                 │   resumeMain: cap/age → shelf + wake, never  │
                 │               delete                         │
                 └───────────────┬──────────────────────────────┘
                                 │ every task owns a record
                 ┌───────────────▼──────────────────────────────┐
                 │ zincai/goals.js — GoalRegistry (durable)     │  on disk
                 │   pending→active→{completed,failed}          │
                 │   active→suspended|resumable|…               │
                 │   load(): active/pending ⇒ resumable+verify  │
                 │   atomic write (tmp+rename), forced on state │
                 └───────────────┬──────────────────────────────┘
                                 │ world is the only ground truth
                 ┌───────────────▼──────────────────────────────┐
                 │ verifyGoalAgainstWorld → applyVerdict        │
                 │   complete | partial | unknown | invalid     │
                 │   called by: goal resume/verify, respawn,    │
                 │   first join, goalTick (stall/blocked)       │
                 └──────────────────────────────────────────────┘
```

Key invariant: **the registry never trusts a caller.** `finishGoal` closes a
goal only for `r.ok && r.complete !== false` (`index.js:625-642`), and
`build`/`gather` return `complete` only from counted evidence
(`index.js:1582-1588`, `skills.js:778`). The model's own `goal complete` is the
one deliberate exception (it is the model's objective list), and it is still
refused on terminal states by the transition table (`goals.js:65-74`).

---

## C. Identity and persistence of objectives

**Findings — Pass.**

* Every main task creates a record with `origin` (`player:<name>` or `self`),
  `priority`, completion/failure/interruption/resume conditions and a
  `detail` checkpoint (`index.js:585-611`); every short job does too
  (`index.js:707-731`, `sideOpts` at `808`). Evidence: G1 (full record, legal
  lifecycle, identity survives a reload) and G12 (`goal add/list/show/update`).
* The checkpoint is *the same place and the remaining work*: a build resolves
  `at` **when it starts** — the old bug re-anchored a resumed house at the bot's
  new feet (`index.js:585-600`, comment kept deliberately). Evidence: G3
  asserts `detail.at === [3,64,2]` before and after the interruption and that
  the resumed main carries the same `at`.
* Shutdown is safe by construction: `dispose()` calls
  `suspendAll + save({force:true})` before sockets close (`index.js:2115-2118`);
  a process that dies without that leaves `active` behind, and `load()` demotes
  `active`/`pending` to `resumable` + `needsVerify` with a history entry
  (`goals.js:118-160`, demotion at 138-148). Evidence: G2 (disk holds `resumable`, checkpoint
  intact), G14 (five consecutive restarts do not degrade: no duplicate ids,
  no lost checkpoint, no growth in attempts).
* Storage is a single JSON file, written atomically (temp + rename,
  `goals.js:209-232`), throttled for progress ticks and forced for every
  transition. Bounded: `maxGoals 40`, `terminalKeep 12`, `history` 8,
  description 160 chars, `detail` per kind (`config.json goals`, `goals.js:573-590`).
  On-disk shape is versioned (`{v:1, savedAt, seq, goals}`), so a future format
  change is detectable rather than silently misread.

**Defect found and fixed here — D1:** `progress()` only ever accepted an explicit
`percent`; when a caller supplied `done`/`total` (the normal case) the clamp
path computed `0` because `Number(null) === 0` was treated as a caller-supplied
percent. Every objective showed 0% ("made no progress") no matter how much work
was done, which also poisoned the stall display the model reads. Fixed at
`goals.js:351-367`; G1 asserts 56% for 18/32 and G15 asserts 75% then the
100% clamp for over-counted `done`.

---

## D. Priorities, arbitration and “no fake concurrency”

**Findings — Pass.**

* Priorities are a static, documented map (`index.js:559`:
  shelter 80 > corpse_run 75 > gather 60 > build 55 > craft 50 > go_to 45 >
  give 45 > follow 40 …) with a 45 default, clamped 0–100, overridable per goal
  via the `goal` tool. It is a *sorting and reporting* device, not a scheduler:
  no preemption happens because of a number. That matches the brief
  (“priority categories are guidelines … the model retains judgment; code
  enforces only obvious emergency safety”).
* `list()` sorts open-first, then priority desc, then age (`goals.js:266-279`);
  `waiting()` sorts by priority then age (`goals.js:518-525`) and is what the
  prompt header and the starvation nudge read. Evidence: G11 (two players, the
  newer request runs, the older one is visibly waiting and survives the turn).
* **One body.** `startMain` shelves the previous main, then `replaceTask()`
  cancels skills/executor before launching (`index.js:669-687`); `startSide`
  calls `pauseMain` and cancels the body before the side job runs
  (`index.js:707-731`); `resumeMain` refuses while a skill or a fight owns the
  body (`index.js:733-763`). There is exactly one controller — no second
  controller writes the same movement/hand state. This is the deliberate answer
  to “do not implement fake concurrency by letting several controllers
  manipulate the same controls”.
* Emergency reflex remains outside the agenda (`system1` flee) and simply pauses
  the running skill; the goal stays `active` and resumes by itself, which is
  correct: a creeper is not a task change.

**Defect class checked and found absent:** a late result from a replaced task
overwriting the new one. `background()` tags each run with the main's `seq` and
drops the result when `agenda.main !== main || main.seq !== seq`
(`index.js:1178-1184`); `finishGoal` also refuses to touch `cancelled` or
`completed` goals (`index.js:625-631`). Evidence: G6 (a follow replaced by a
go_to is `suspended` with a reason, on the shelf, and the prompt says so), G7
(eight replacements never delete the objective; the ninth sets it aside with a
reason and wakes the model rather than dropping it).

---

## E. Interruption, death, restart and resumption

**Findings — Pass, with two real defects fixed (D2, D3).**

| Event | Code path | What the objective becomes | Test |
| --- | --- | --- | --- |
| New main task replaces the old | `startMain → shelfMain` | `suspended`, reason “set aside: …”, on `agenda.shelved` | G6, G7 |
| Side job (give/take/smelt…) arrives | `startSide → pauseMain` | `suspended`, reason “paused for …”, resumes by itself | G7, G11 |
| Death | `bot.on('death')` → `suspend` + `suspendAll` + forced save | `resumable` (with `needsVerify`), respawn prompt lists it | G4 |
| Shutdown / link drop | `dispose` → `suspendAll` + forced save | `resumable` on disk before sockets close | G2, G14 |
| Hard kill (no dispose) | `load()` demotion | `resumable` + `needsVerify` + history “restored after restart” | G2, G5 |
| Explicit stop | `case 'stop'` → `cancelAll` | `cancelled` — terminal, never revived | G12 |

* **Resumption is not replay.** `runFromDetail()` rebuilds the runnable from the
  checkpoint — same `at`, same stage, gather continues from `total - done`
  (`index.js:953-995`). `goal resume` always reconciles with the world first
  (`index.js:1062-1074`), and refuses when the verdict is `invalid`
  (“cannot be resumed: the container no longer holds diamond”) or when a failed
  goal cannot be checked at all. Evidence: G3 (the resume message reports the world-measured
  `N/16 blocks in place` and the run continues at `[3,64,2]`), G8 (an emptied chest and a player who
  left the server are both refused, marked `failed`, and the model is shown
  why), G5.
* **Defect found and fixed — D2:** a `build_shape` goal was recorded with
  `kind: 'build'` because the kind was computed with
  `String(spec.tool).startsWith('build')`. On resume that checkpoint was
  replayed as a blueprint build, which has no `blueprint`/`grid`, so the model
  was told “no blueprint or grid was recorded, so the build cannot be
  continued” — a half-built structure became unrecoverable. Fixed at
  `index.js:602-611` (kind is the tool family verbatim); `runFromDetail`
  already had the correct `build_shape` branch (`index.js:966-970`). Evidence:
  G3, G5, G16 (all build_shape scenarios).
* **Defect found and fixed — D3:** `LEGAL` had no edge into `completed` from
  `resumable`, `suspended` or `pending`. So when restart verification proved a
  house was already finished, `applyVerdict → complete()` was refused
  (“g1 is resumable; it cannot become completed”) and the objective could never
  close — it would be resumed and re-verified forever. Fixed at
  `goals.js:65-74` (comment explains why completion is reachable from every
  open state while terminal states stay terminal). This is exactly the
  “incorrect completion detection / infinite loop” class the brief asks about.
  Evidence: G5 (`resumable → completed` from the world alone), G10.

---

## F. Completion detection

**Findings — Pass.**

* Completion is a two-key operation: the task must report success **and** not
  disclaim completeness, and for builds/gathers that flag is computed from
  counted work, never from “the promise resolved”. `buildBlocks` returns
  `complete: result.placed >= phaseTotal` and reports `already present`
  (`index.js:1582-1588`); `gather` returns `complete: dug >= wanted && !cancelled`
  (`skills.js:778`). A cancelled skill is a suspension, not a completion.
* `verifyGoalAgainstWorld` gives a per-kind verdict matrix
  (`index.js:853-929`): build (block-by-block against the plan, per stage),
  gather (inventory count), go_to (place exists / already within 2 blocks),
  follow (player still on the server), take/put (indexed container contents),
  declared (nothing — explicitly “judge it from what you see”). Unreadable cells
  degrade to `unknown` rather than guessing; an exception becomes `invalid`
  with the reason.
* Partial verdicts write a real checkpoint (`applyVerdict`, `index.js:930-945`)
  so `goal show` and the prompt percentages reflect the world, not the plan.
* Evidence: G10 (a `complete: false` result stays open; only the world verdict
  closes it), G5 (a build finished before the crash is reconciled to
  `completed` with “verified in the world”, while the genuinely unfinished
  follow goal comes back `resumable` + `needsVerify`), G8 (invalid is refused
  and failed, never resumed), G16 (a build verified in the overworld is
  `completed`; the same x/z in the nether is `unknown` — see D4).

**Defect found and fixed — D4:** verification was dimension-blind: it compared
blocks at `(x,y,z)` wherever the bot happened to be. A restart in the nether
at similar coordinates could read a *different* structure's blocks, and — worse
— mark an overworld build `completed` or `partial` on the wrong dimension's
terrain. `goalDetailFor` now records `detail.dim` (`index.js:593-595`),
verification returns `unknown` across dimensions (`index.js:859`), and
`reconcileRestored` skips foreign-dimension goals instead of “re-checking”
them (`index.js:1154`). Evidence: G16.

---

## G. Staleness, loops and starvation

**Findings — Pass.**

* **Stale decisions.** A turn carries a snapshot; before acting,
  `staleActionReason` refuses quiet work when (a) a threat appeared that the
  snapshot did not contain, or (b) the active goal id changed
  (`index.js:832-852`). In parallel, `supersede()` bumps `decisionEpoch`
  (`index.js:780-787`) when a main task is resumed or given up
  (`index.js:745,761`), the epoch is bumped directly for a new chat instruction
  (`index.js:1509`) and for urgent wakes (`index.js:1961`), and `act()` throws
  away an answer whose epoch moved (`index.js:1457-1462`). Evidence: G9 (a decision made while goal
  A ran is refused once B runs; a decision made with an empty threat list is
  refused when a creeper appears). This closes the “resurrect a task another
  controller already replaced” hole.
* **Not every pause is a failure.** Status changes only on evidence: a stall is
  a *wake* (`goalTick`, `index.js:1110-1119`) that asks the model to verify,
  keep, replan or cancel; it is never a suspension. Suspension needs three
  recorded failures plus 180 s without a checkpoint (`index.js:1121-1130`).
  `progress()` is only called on real checkpoints, so a slow but healthy task
  is not “failed for being slow”; legitimate waiting is additionally honoured by
  `detail.expectsWait` in `stalled()` (`goals.js:505-516`) — see R4, it is a hook
  no kind currently sets.
* **No infinite loops.** A goal can be resumed at most `maxResumes` 8 times or
  `MAIN_MAX_AGE_MS` 30 min, after which it is *shelved* with a reason and the
  model is woken (`index.js:733-751`). A waiting objective that nothing picks up
  is nudged after `starveMs` 5 min, at most once per `starveRemindMs` 10 min
  (`index.js:1132-1138`). Every nudge is idempotent per window
  (`stallWarnedAt`, `starveNudgedAt`), so the tick cannot chat-spam.
* Evidence: G13 (one wake per stall window, no suspension for being slow), G7
  (the ninth interruption sets aside, never deletes), G11 (a waiting goal is
  visible and ordered).

---

## H. Defects fixed in this review, residual risks, verdict

### H.1 Defects (all found by this review, all fixed, all covered by tests)

| # | Defect | Effect if shipped | Fix | Test |
| --- | --- | --- | --- | --- |
| D1 | `progress()` treated a null `percent` as 0% | every objective reported 0% and looked stalled | `goals.js:351-367` | G1, G15 |
| D2 | build kind collapsed `build_shape` → `build` | a half-built shape could not be resumed at all | `index.js:602-611` | G3, G5, G16 |
| D3 | no legal edge into `completed` from `resumable`/`suspended`/`pending` | a finished build could never be closed after a restart — resumed forever | `goals.js:65-74` | G5, G10 |
| D4 | verification ignored dimension | wrong-dimension terrain could complete/invalidate a build | `index.js:593-595, 859, 1154` | G16 |
| D5 | `sense.last.dangerIds` is a `Set`, consumed as an array | **action lane crashed** (`filter is not a function`) on every turn with threats; goals died with it | `index.js:836` (`[...(…)]`) | G9 + full suite |
| D6 | `startSide` with an existing goal created a second record | duplicate objectives for one job | `index.js:714-718` | G7, G11 |

D5 predates this review in origin but was only visible under the new prompt
path; it is listed because it was the cause of 18 unrelated test failures and
because it silently killed the action lane — the worst possible failure mode
for goal orchestration.

### H.2 What the tests now prove (16 scenarios, `test/goal-orchestration.test.js`)

| Test | Asserts |
| --- | --- |
| G1 | durable identity, full record, legal/illegal transitions, progress math |
| G2 | restart demotes `active` → `resumable` + checkpoint survives on disk |
| G3 | interrupted build resumes at the **same origin**, from world-observed progress |
| G4 | death → `resumable`; respawn prompt shows the objective as RESUME-READY |
| G5 | restart + world already built → `completed` reconciled; unfinished → `resumable` |
| G6 | a replaced long task is set aside (any kind), with reason and shelf entry |
| G7 | eight replacements never delete; the ninth shelves + wakes, terminal only on request |
| G8 | emptied chest / departed player → refused, `failed`, model shown why |
| G9 | decisions for an old situation are refused before acting |
| G10 | a returned call is not proof; only a world verdict completes |
| G11 | two players: both recorded; newer runs, older waits, priority order |
| G12 | `goal` tool: add/list/update/verify/cancel; cancelled stays cancelled |
| G13 | stall wakes once per window; being slow is not failure |
| G14 | five restarts: no degradation, no duplicate ids, no lost checkpoint |
| G15 | progress columns and stage labels agree with the builder |
| G16 | verification is dimension-aware; a foreign dimension is not evidence |

### H.3 Residual risks (accepted, documented, not blocking)

* **R1 — one process per `goals.json`.** The registry is a single-writer JSON
  file with atomic replacement, no lock. Two bot processes sharing a data dir
  would clobber each other's last write. The bot is single-process by design;
  a lock file would be the smallest future fix if that ever changes.
* **R2 — restart verification looks at the first six open goals.** `reconcileRestored`
  slices to 6 per spawn to bound startup cost (`index.js:1150`; only kinds with
  a verifier are actually checked). The rest keep
  `needsVerify: true` and are verified on `goal resume`/`goal verify`. Correct,
  just not eager.
* **R3 — a resumed goal whose kind has no executable checkpoint** (e.g. a
  `declared` objective, `run_script`) becomes `active` while the body does
  nothing; the model is told “start it with the normal tools”. If it never does,
  the stall nudge fires after 3 min and the model decides. No loop, but the
  record is briefly optimistic.
* **R4 — `detail.expectsWait` is honoured but never set.** Long legitimate waits
  (smelting, overnight sleep) are side jobs and therefore not `active` when they
  wait, so the gap is theoretical today. If a future long kind needs it, the set
  point is `startMain`'s detail.
* **R5 — progress saves are throttled (1.5 s);** transitions are always forced.
  A hard kill can lose at most a fraction of a second of percentage, never a
  status change.
* **R6 — the tests use the simulated rig.** Server-side physics, chunk unload
  and mob behaviour are out of scope here and remain the campaign rig's job.

### H.4 Conditions for the verdict

* **C1** — run one bot process per `goals.json` (see R1).
* **C2** — the data dir must be writable and persistent; `goals.json` is the
  objective memory (a read-only container makes every restart forget).
* **C3** — treat `needsVerify` goals as “look before you continue”: the system
  enforces this on `goal resume`, but a model that ignores the prompt can still
  start a fresh plan beside a half-finished one (it loses nothing — the old goal
  is shelved, not deleted — it just wastes a trip).

### H.5 Bottom line

A reliable goal registry + explicit state transitions + a single body with
pause/resume arbitration is **sufficient** for Zinc's objective continuity; no
multi-agent redesign is warranted, and none was introduced. The remaining work
is operational (C1–C2) and, at most, an expansion of the verification matrix for
kinds added later. With D1–D6 fixed, the nine failure modes named in the brief
are each demonstrated as handled by an executable test rather than by an
argument.
