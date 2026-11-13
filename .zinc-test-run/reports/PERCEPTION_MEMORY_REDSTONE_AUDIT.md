# Zinc — Event Perception, Temporal Awareness, Memory Intelligence, Reaction Speed & Redstone Mastery

**Audit + implementation report**
Date: 2026-11-13 · Branch: `arena/ea1e525a-minecraft-harness` (from `24ad9b9` on `main`)
Environment audited: Mineflayer **4.39.0**, minecraft-data **3.119.0**, Java Edition **1.21.4** and patched **26.3**
Test result: `npm run check` PASS · `npm test` **173 / 173** (139 pre-existing tests untouched and passing + 34 new)

---

## Verdicts

| Area | Verdict | Why |
|---|---|---|
| **EVENT PERCEPTION** | **PASS** | Every listed event source is now normalized into one time-stamped pipeline that reaches the model's prompt; occurrence time is distinguished from observation time; bursts coalesce, duplicates are dropped, context resets and restarts no longer lose or replay events. |
| **REACTION SPEED** | **PASS** | Immediate reflexes act in-process with no model call (measured < 500 ms end-to-end in the rig); the reasoning lane is now woken by events instead of the 250 ms heartbeat poll; three explicit reaction classes with separate spacing; queue→model→exec→confirm latency measured separately from model inference. |
| **MEMORY** | **PASS** | Four categories, full provenance/confidence/importance metadata, observed-vs-inferred-vs-reported basis, belief superseding and contradiction handling, multi-axis bounded retrieval, importance-preserving consolidation, and all ten effectiveness checks automated. |
| **REDSTONE UNDERSTANDING** | **PASS** | 112/113 (1.21.4) and 117/118 (26.3) signal-related block ids are classified with typed state; a directed graph, dust power solver, tick simulator and a fault diagnoser that finds broken dust links and mis-rotated repeaters were demonstrated on adversarial fixtures. |
| **REDSTONE ENGINEERING** | **PARTIAL** | Design, material/ownership pre-flight, orientation-explicit placement, catalogued design reuse and **functional verification that gates goal completion** are implemented and tested. Not proven: real-server construction at scale and real Java tick behaviour (the rig uses simulated blocks; the simulator is an approximation). |

Honest summary: everything claimed above is backed by an executed test in this repo. No claim is made that this was validated against a live Minecraft server — the whole suite runs against the synthetic world in `test/helpers/world.js`.

---

## 1. Event sources inspected

| Source | Before | Now |
|---|---|---|
| Player chat (`messagestr` → `filter.parseChatLine`) | delivered, but only as a chat section entry | `eventType: chat`, `reactionClass: fast`, sender as an entity, occurrence time known |
| Player arrival/departure | **missing** — only an indirect 3-second proximity poll | `entitySpawn`/`entityGone` → `player_arrived` / `player_left` (fast / ambient) |
| Any other entity spawn/despawn | **missing** | `entity_spawn` / `entity_gone` (interest-filtered: hostiles, animals, items, projectiles, vehicles) |
| Entity attack/damage | `entityHurt` only fed the reflex layer, **never the model** | `entity_hurt` with victim, distance and health; `entity_dead` |
| Zinc receiving damage | partial (HurtTracker → note) | `damage` / `healing` events with the amount, `reactionClass: immediate`, and a wake |
| Status effects | **missing** | `status_effect` / `status_effect_end` with amplifier |
| Block placement/destruction | **missing for the model** (only `places.onBlockChange` consumer) | `block_placed` / `block_destroyed` with `delta: "dirt→air"` |
| Block state change | missing | `block_state_change`, e.g. `repeater changed (delay: 1→3)` |
| Redstone update | missing | `redstone_update` (any signal carrier) with the property diff |
| Inventory change / pickups | pickups noted; losses invisible | `inventory_gain` / `inventory_loss` (grouped per item) + `item_pickup` with who was nearby |
| Container change | partially via `places.onBlockChange` | `storage_changed` continuity note + container change events |
| Environmental hazards | reflex-only, invisible to the model | `hazard` events on escape start/end/entrapment |
| Weather / daylight / world | missing | `weather`, `daylight`, `dimension_change` |
| Position / chunk transitions | missing | `chunk_transition`, `dimension_change` |
| Goals | implicit in the goals block | `goal` progress/completion/interruption events (unchanged goal section kept) |
| Social / relationships | `social` tool + continuity | unchanged, plus `player_arrived`/`entity_hurt`/chat events surfaced |
| Results of Zinc's own actions | `results` list, prose only | `action_result` / `action_failure` with `causalActId` → rendered as `[by your act7]` |

## 2. Events previously missing, delayed or wrongly delivered

Concrete defects found and fixed:

1. **`entityHurt` reached no model-facing surface.** `bot.on('entityHurt')` only called `system1.onEntityHurt`, whose `onEvent` only writes `note({type:'entity_hurt'})`, and `note` for an unknown type lands in working memory which the prompt reads as `events:`. The victim's *name* was lost — only `msg` survived. Now: victim name, distance and health are recorded, coalesced per victim (`x4`), and titled.
2. **Block changes were delivered to the place index only.** A player breaking a chest while Zinc built was invisible. Now recorded, with `occurrenceTimeKnown: false` when the change is discovered from a scan.
3. **No polling-free wake.** `Brain.start(250)` polled `tick()` every 250 ms, so a hazard/chat event could sit up to a quarter second before the lane even looked at it. `wake()`/`hear()` now schedule a `queueMicrotask` kick.
4. **The whole wake queue was one speed.** `urgentMinIntervalMs` vs `minIntervalMs` only. There was no fast tier for "a player just walked up while I was mining".
5. **`clearContext()` dropped everything.** An important undelivered event (or a hazard wake) queued across a context reset vanished.
6. **A failed `act()` lost its reasons** except for `heartbeat`-prefixed text — the regex did not match the actual `autonomous check-in (…)` string produced by the scheduler, so a genuine event that caused a failed turn was silently dropped. Fixed.
7. **`Brain` had no `performance.now()` timestamps on queue entries** — no way to measure queue→model without wall-clock skew.

## 3. Timestamp architecture and accuracy

Every event carries (`zincai/events.js`):

```json
{
  "sequence": 42,
  "timestamp": "2026-11-13T03:32:55.138Z",
  "timestampMs": 1763004775138,
  "monotonicTime": 4813.27,
  "worldTime": { "age": 48120, "timeOfDay": 1130, "day": 2, "phase": "day" },
  "occurrenceTimeKnown": true,
  "occurredAt": 1763004775138,
  "observedAt": 1763004775138,
  "receivedAt": 1763004775138,
  "processedAt": null,
  "source": "mineflayer",
  "eventType": "entity_hurt",
  "reactionClass": "fast",
  "observationBasis": "direct",
  "importance": 2,
  "summary": "Gabriel took damage 4m away (health 14)",
  "where": { "x": 12, "y": 64, "z": 3, "dim": "overworld" },
  "entities": ["Gabriel"],
  "causalActId": null,
  "delta": null,
  "groupKey": "hurt:Gabriel",
  "groupCount": 1,
  "samples": null
}
```

**Honesty rule (enforced in code, tested).** `record()` only sets `occurredAt` when the caller declares the instant known (`occurredAt` supplied, or `occurrenceTimeKnown: true`). Otherwise `occurredAt` is `null`, `timestampMs` falls back to `observedAt`, and the prompt renders:

```
- #7 [observed 5s ago (14:03:22Z, exact occurrence time unknown)] block_state_change @2,64,2: redstone_wire changed (power: 0→14) (scanned_diff)
```

Live packets (chat, damage, hurt, pickups, spawns) are `occurrenceTimeKnown: true`; scan discoveries (block updates, container diffs, inventory polls, weather/daylight transitions, chunk changes) are `false`. There is a dedicated test (`5.`) that a 42 s-late event keeps its original `occurredAt`, is flagged stale in the prompt, and that unknown-occurrence events render the explicit "exact occurrence time unknown" wording.

Wall clock is used for persistence and cross-session chronology; `performance.now()` (`monotonicTime`) is used for every latency measurement and intra-process ordering.

## 4. Ordering, deduplication and recovery

* **Sequence**: monotonic `sequence` per pipeline, rendered in ascending order in the prompt even when prioritised for selection.
* **Deduplication**: `dedupeKey` (explicit, or `eventType|summary|where`) within a sliding `dedupeWindowMs` (600 ms default) → `stats.deduped`, the duplicate is *not* appended. Test 6.
* **Burst coalescing**: same `groupKey` within 1.5 s merges into one event with `groupCount`, up to 4 distinct `samples`, and a merged entity list; the prompt renders `(x4: … / …)`. Test 2, 8.
* **Bounded queue**: `maxEvents` 128; eviction prefers already-processed and `importance: 0` rows, so a flood of ambient updates can never evict an undelivered hazard. `stats.droppedAmbient` counts what was thrown away. Test 13.
* **Durability**: `events-journal.json` (write-temp-then-rename) persists only `processedAt === null && importance >= 2`, capped at 64.
* **Restart recovery**: on boot only undelivered important events are restored, tagged `recoveredFromRestart` and rendered `[undelivered before restart]` with their **original** `timestamp`. Anything already processed (`processedAt !== null`) is never replayed. Test 7.
* **Context reset**: `pipeline.onContextReset()` keeps undelivered important events (`importance ≥ 2`), drops the rest, and the reset wake text names how many survived:
  `context reset (test-reset) — continuity reconciled with live world; 1 undelivered important event(s) kept (#22 hazard)`.
  `brain.clearContext({ preserveImportant: true })` keeps `urgent`/`important` wakes. Test 4.
* **Causality**: `causalActId` links an event to the continuity action that produced it; `report()` stamps `execToConfirmMs` for that act id and emits an `action_result` event carrying it.

## 5. Model-facing delivery evidence

The complete path, all inside `startSession`:

```
Mineflayer event / internal poll
  → perceive(spec)                        (index.js, single funnel)
      ├─ pipeline.record(...)             (zincai/events.js)
      ├─ note(...)                        (working memory; legacy `events:` section)
      ├─ memory.longTerm.add(...)         (importance ≥ 2, provenance kept)
      └─ brain.wake(... reactionClass)    (fast/urgent spacing, immediate kick)
  → buildActionPrompt(reasons)
      └─ pipeline.formatForPrompt({ max: 8, excludeTypes: OWN_SECTION })
         → markProcessed(shownSequences, { via: 'model' })
  → System-2 model → tool call → executeAction → report() → action_result event
```

Because `formatForPrompt` runs *inside* `buildActionPrompt`, an event can only be marked delivered if it was actually rendered into the text the model received. The rendered block in a live test prompt (scenario 12) is:

```
perceived (timestamped; [NEW] = not yet delivered, "(scanned_diff)" = you discovered it late, exact time unknown):
  - #18 [2s ago (03:32:57Z, day)] explosion @0,64,0: creeper exploded 3m away [NEW]
```

and for a self-caused event (scenario 8):

```
  - #3 [0s ago (03:33:01Z)] action_result: dig completed: 3 blocks [by your act7]
  - #6 [0s ago (03:33:01Z)] inventory_gain: +3 oak_log (x2: +3 oak_log / +3 oak_log)
```

Fields established per event: **what** (summary), **when** (age + UTC time + world phase, or "exact occurrence time unknown"), **where** (`@x,y,z` + dimension), **who** (`[entities]`), **direct vs inferred** (`(scanned_diff)`/`(inferred)`/`(reported)`), **still relevant** (`NEW`, age, or already processed), **what changed** (`delta`, `power: 0→14`).

Repetitive noise control: `OWN_SECTION = {chat, said, result, request, threat, safe, fled}` never appears in the perceived block (they have dedicated prompt sections), ambient `importance: 0` events are only shown once as context and then age out after 90 s, and per-kind grouping keeps a horde or a mining spree to a handful of lines.

## 6. Decision latency measurements and bottlenecks

Measured in-process with a scripted model that blocks for a realistic 420 ms (`/tmp/measure.js` run inside the real session):

| Stage | samples | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| occurrence → receipt | 13 | 40 ms | 80 ms | 80 ms | 80 ms |
| observation → receipt | 12 | 0 ms | 0 ms | 0 ms | 0 ms |
| receipt → queue | 25 | 0 ms | 0.02 ms | 0.10 ms | 0.14 ms |
| queue → model invocation | 38 | 5.27 ms | 857.14 ms | 857.15 ms | 857.16 ms |
| **model inference** | 14 | **419.98 ms** | 420.40 ms | 421.90 ms | 421.90 ms |
| receipt → reflex | — | (reflexes never queue; they run in the 200 ms tick) | | | |
| exec → confirmation | 32 | 0.65 ms | 1.52 ms | 3.82 ms | 4.76 ms |

Redstone tool cost (in-process, 8 repetitions each, radius 2 / 4 components):

| operation | p50 | max |
|---|---|---|
| `analyze` (perceive + graph + compare + diagnose) | 0.95 ms | 5.95 ms |
| `diagnose` | 0.82 ms | 4.63 ms |
| `simulate` (40 ticks) | 1.58 ms | 3.20 ms |
| `recall` (empty store) | 0.60 ms | 1.37 ms |

**Interpretation and bottlenecks.**
* Zinc's own architecture (receipt→queue 0.14 ms max, exec→confirm 4.76 ms max, redstone analysis < 6 ms) is two to four orders of magnitude cheaper than a model call. The bottleneck is **model inference**, not the harness.
* `queueToModelMs` p90 ≈ 857 ms is *by design*: it is rate-limit spacing (`minIntervalMs`/`fastMinIntervalMs`/`urgentMinIntervalMs`) plus the deliberate refusal to run two conflicting decisions over the same body. p50 (5 ms) shows most events that deserve a turn get one almost immediately.
* The reflex path contributes **0 ms of queue latency** because it never enters a queue: `System1.tick()` (200 ms default, 50 ms in tests) drives keys directly through the control arbiter. In the rig a lava-detection tick completed in < 500 ms including the escape plan.
* Previously the same numbers were unmeasurable: `Brain` had no monotonic stamps and results had no act linkage.

## 7. Memory architecture and retrieval improvements

`zincai/memory.js` rewritten around four explicit categories and a provenance model, keeping the old API (`longTerm.add/query/grep`, `MemorySystem.addEvent/rememberChat/rememberFact/factsAbout/recentChat/preferencesLine`) intact.

* **Categories**: `episodic | semantic | procedural | continuity`, inferred from tags/text when not given, always settable.
* **Metadata**: `id, ts, createdAt (ISO), updatedAt, lastVerifiedAt, category, basis (observed|inferred|reported), confidence, importance, foundational, tags, entities, location {x,y,z,dim}, goalIds, subjectKey, status (active|outdated|contradicted), occurrences, provenance, previousText, contradictionNote, contradictedBy, supersededBy`.
* **Provenance is not decorative**: `rememberChat` / `rememberFact` always write `basis: 'reported'`, confidence 0.38–0.42, `lastVerifiedAt: null`; `recordKnowledge` defaults to `observed` (0.92) or takes an explicit basis; missing properties are never invented as 0/false.
* **Belief updating**: `add()` with a `subjectKey` + `observed` basis updates the single active record in place (keeps `previousText`), instead of appending a conflicting duplicate. `upsertByTag` does the same for place/container records.
* **Contradiction handling**: `reconcileObservation({subjectKey, observedItems, location})` writes the verified observation, then marks matching `reported`/`inferred` records `contradicted` (confidence 0.05, `contradictionNote: "verified empty of diamante on …"`) and matching stale `observed` records `outdated`/`supersededBy`.
* **Retrieval** (`retrieve({query, category, entity, near, radius, goalId, sinceMs, k})`): weighted blend of token cosine, literal substring, entity/tag match, spatial proximity (dimension-aware), goal link; multiplied by importance and confidence, penalised for contradicted status; `outdated` excluded, `contradicted` hidden unless `includeContradicted`. Returns `{found, totalStoreSize, entries, unknownReason}` and a 2 s cache keyed on the full query so identical consecutive calls do not re-scan.
* **Consolidation**: near-duplicates (cosine > 0.90, same category/basis/location) merge and accumulate `occurrences`; over capacity, eviction ranks `foundational` memories infinitely high so a foundational or old-but-important memory is never dropped for age; importance/confidence/recency decide the rest. Repetitive failures collapse into one record with a count rather than one memory per failed placement.
* **Prompt rendering** (`formatEntry`) labels trust explicitly: `verified observation (conf 92%, verified 2026-11-13)`, `inferred (conf 65%)`, `UNVERIFIED CLAIM by Lucas (conf 38%)`, `CONTRADICTED CLAIM (verified empty of diamante on …)`.

## 8. Memory persistence and verification results

All stated checks run in `test/perception-memory-redstone.test.js`:

| # | Check | Test | Result |
|---|---|---|---|
| 14 / M1 | location discovered in an earlier session | `14.` + `memory effectiveness` | PASS (survives reload, location retained) |
| M2 | where resources were stored | `memory effectiveness` | PASS (`barrel1` found by "where did I store redstone") |
| M3 | previous construction failure lesson | `memory effectiveness` | PASS (procedural category retrieval) |
| M4 | agreement with another player | `memory effectiveness` | PASS (`continuity`, entity-scoped) |
| 15 / M5 | verified fact vs unverified claim | `15.`, `memory effectiveness` | PASS (claim low confidence, unverified, labelled; verified fact ranks higher) |
| M6 / 17 | outdated belief corrected by contradictory evidence | `17.`, `memory effectiveness` | PASS (in-place update, stale value no longer presented, old value kept as history) |
| 16 / M8 | bounded retrieval without the whole history | `16.` | PASS (`k` respected, `totalStoreSize` reported, 120 ambient notes never dumped) |
| M7 / 18 | resume a complex project after repeated resets and a restart | `18.` | PASS (goal + checkpoint survive 3 resets and a process restart) |
| M9 | how a previously successful redstone mechanism worked | `memory effectiveness`, `26.` | PASS (procedural recall; verified design reloaded) |
| M10 | recognise that it does not know | `memory effectiveness` | PASS (`unknownReason` → "treat as unknown and inspect the world rather than guessing") |

## 9. Redstone perception capabilities

* **Coverage**: of every block id matching the redstone/mechanism vocabulary in `minecraft-data`, **112/113 classified for 1.21.4** and **117/118 for 26.3** (the only unclassified id is `redstone_ore`, which is not a component). New in this pass: `piston_head`, `moving_piston`, all `*_door`, `*_trapdoor`, `*_fence_gate`, `tripwire`, `trapped_chest`, `lightning_rod`, `sculk_sensor`, `calibrated_sculk_sensor`, `crafter`, powered/activator/detector rails, weighted pressure plates.
* **State normalization** (`normalizeState`) parses both prismarine string numerics (`"15"`, `"3"`) and numbers, coerces booleans, keeps only whitelisted safe keys, and — critically — **omits properties the client did not report** rather than fabricating `0`/`false` (`s3.facing === undefined` is asserted).
* **Adjacency**: the perception reads a one-cell margin beyond the requested radius so a component on the boundary still has neighbour evidence, and it records the surrounding **solid** block set (needed for torch support and strong-power candidates).
* **What it explicitly cannot see** (reported verbatim to the model as `limits`): scheduled ticks, strong vs weak powering, quasi-connectivity, container fullness, and item contents.
* Older conservative inspectors (`redstone_inspect.js`, `block_inspect.js`, `region_inspect.js`) keep their exact wording; `redstone_inspect` gained the extra kinds/properties without changing its message contract (`test/redstone-inspect.test.js` still 6/6).

## 10. Redstone reasoning and construction capabilities

**Circuit representation** (`CircuitModel`): nodes with typed state; directed `edges` (`signal_path`, `dust_link`, `dust_logic_output`, `observer_pulse`, `mechanism_input`, `dust_link_geometry`) each with `evidence` and a `confidence` label; `outputsOf`/`inputsOf` that encode Java conventions (repeater input is the **rear** = `facing`; observer output is `opposite(facing)`; wall-torch support is `pos + opposite(facing)`); a fixed-point dust power solver; `inputPower`/`blockPowerAt` for solid-block powering; `predictMechanism` per device kind (lamp `lit`, piston `extended`, door `open`, hopper `enabled = !powered`, dropper/dispenser `triggered`, note block `powered`).

**Diagnosis** (`diagnose`) emits severity-tagged findings with evidence: `no_active_source`, `dust_gap`, `dust_visually_unlinked`, `repeater_wrong_facing`, `repeater_reversed`, `orientation_unknown`, `repeater_locked`, `repeater_delay`, `comparator_mode`, `mechanism_mismatch`, `mechanism_unpowered`, `feedback_loop`, `vertical_dust_stack`.

Live sample (adversarial fixture, re-rotated repeater), from `test 21` / manual run:

```
diagnosis:
  - [high] repeater_wrong_facing @3,64,0: repeater reads its rear at north (3,64,-1) which is cold,
    but signal is arriving from the side (west(dust 15)) — a repeater only accepts input from its rear,
    so it is very likely rotated 90°: set facing to the powered side
```

broken-link fixture:

```
diagnosis:
  - [medium] dust_visually_unlinked @2,64,0: dust here reads power=0 while its west neighbour reads 15,
    and the west side does not connect (none) — the run is deliberately broken or a block is in the way
```

**Simulation** (`run`): discrete tick loop with dust relaxation and decay, torch inversion with support power, repeater delay queues, comparator compare/subtract with side inputs, observer pulse windows, and mechanism outputs per tick; oscillation detection reports the period. It is labelled in the tool output as *"the engine's discrete-tick MODEL (approximate Java mechanics), not a server measurement"*.

**Reasoning/design**: a catalogue of 11 designs (`and_gate_torch`, `or_gate`, `not_gate`, `xor_gate`, `rs_latch`, `clock_1hz`, `pulse_extender`, `item_sorter`, `state_detector`, `auto_farm`, plus the deliberately-retained naive `and_gate` flagged with its topology caveat), `designFor()` behaviour matching in English and PT-BR ("acender a lâmpada só quando as duas alavancas estiverem ligadas" → `and_gate_torch`), and `compareDesigns()` on resources, footprint/volume, block count, delay, complexity and reliability with an explicit note that reliability is only confirmed by a live test.

**Construction**: `planPlacement(design, origin, {rotate})` rotates both offsets and every `facing`, `preflight` checks inventory shortfall **and** `canWrite` ownership (wired to `continuity.claimAt`) and occupied cells, and `placePlan` drives the existing `BuilderExecutor._approach/_placeAt` so arbiter lanes, flee interruption and scaffolding all still apply. Failure text names each block that failed and each cell that was skipped or blocked. The tool message ends with *"This does NOT mean the circuit works — call redstone_engineer verify"*.

**Verification** (`functionalTest`): toggles the real input blocks via `bot.activateBlock`, polls the real output block states (`outputActive` per kind), compares against expectations, and only returns `verified: true` when nothing mismatched **and** the outputs actually moved. Inconclusive (unreadable outputs / nothing moved) is reported as inconclusive, never as success. A passing verification writes a procedural memory and a library lesson; a failing one records a goal failure.

**Goal gating** (§4.4): a redstone goal can carry `detail.redstoneVerified` / `detail.redstoneVerificationFailed`. `goal complete` on a goal whose redstone failed functional verification is refused:
`goal g1 NOT completed: its redstone failed functional verification — diagnose, fix and verify again first` (test *"redstone goal: placement alone leaves the goal open…"*).

**Learning** (`RedstoneLibrary`, `<dataDir>/redstone-library.json`): stores designs with `verified`, `lastTestedAt`, `uses`, `tags` and deduplicated debugging lessons (a repeated lesson bumps `count` instead of appending), plus procedural/semantic memory entries. A corrupt file is detected (`loadError`) and never trusted. Reuse is tested by reloading from disk in a fresh instance and finding the verified design by behaviour.

## 11. Redstone test results

| # | Scenario | Result |
|---|---|---|
| 19 | inspect and explain a basic powered circuit | PASS (4 nodes, 1 source, 1 mechanism, model agrees with all observed states, simulator says lamp ON) |
| 20 | identify a disconnected redstone signal | PASS (both `dust_visually_unlinked` and `dust_gap` distinguished) |
| 21 | identify an incorrectly oriented repeater | PASS (`repeater_wrong_facing`, points at the exact block and the powered side) |
| 22 | explain a comparator circuit | PASS (mode, facing, rear semantics; container fullness honestly unknown) |
| 23 | design a simple AND gate | PASS (behaviour match from PT-BR, comparison against OR, rotation-aware plan) |
| 24 | build and verify a simple clock | PASS (placement alone refused without an executor; functional verification observes the blink and records the lesson) |
| 25 | debug a circuit that does not produce its expected output | PASS (diagnose → verify reports **inconclusive**, not success → lesson stored) |
| 26 | save a successful design and reuse it later | PASS (survives reload, found by behaviour, corrupt file rejected) |

Plus: full component-kind matrix, string/number property parsing, and missing-property honesty.

## 12. Tool and model limitations

* **Tool surface** (`api_wrapper.js`): `redstone_engineer` (9 operations) and `recall` added to **explorer, hunter and builder**; every `MODE_DROP_TOOLS` entry preserved (`logic_test`/`circuit_project` still dropped in explorer and hunter); every tool still has `required.length ≤ 4`; `parseToolCall` still rejects undeclared fields. Results are timestamped (`results[].at`), `INFORMATIONAL` tools get 900-char messages, and errors are surfaced through `report()` rather than swallowed.
* **Perception never blocks on action execution**: redstone analysis reads `bot.blockAt` snapshots and returns in ~1 ms; it does not await the executor. Placement does use the executor and is therefore subject to arbiter preemption (deliberately, so a flee still interrupts).
* **No unnecessary redstone work**: `perceive()` is only called by `redstone_engineer`; the ambient event pollers never scan redstone.
* **Real model caveat**: the suite proves delivery to the prompt and tool execution — the model in tests is scripted. Whether a live model *chooses* the right tool with the right arguments is a property of the model and its prompt; the system prompt now documents `perceived`, `recall` and the `redstone_engineer` workflow explicitly, and the labels ("verified observation", "UNVERIFIED CLAIM", "inconclusive") are designed to prevent over-claiming by the model.
* **Not modeled**: strong vs weak powering, quasi-connectivity, tick-priority/update ordering, container fullness (comparator signal strength from inventory), and real server tick timing. These are stated to the model instead of guessed.
* **Placement of complex designs** (sorter filters, auto-farm fluids) is explicitly bounded: those designs carry a `caveat` naming the manual step the engine will not fake.

## 13. Regression test results

```
npm run check   → PASS  (adds node --check for zincai/events.js and zincai/redstone_engine.js)
npm test        → 173 / 173 pass, 0 fail
                  139 pre-existing tests unchanged and green
                   34 new tests in test/perception-memory-redstone.test.js
```

Pre-existing invariants verified intact: `test/redstone-inspect.test.js` (6/6, including every conservative string), `test/circuit-projects.test.js`, `test/logic.test.js` mode drops, `test/capabilities.test.js` inspector wording, `test/zincai.test.js` memory API and tool-schema constraints, autonomy and social-autonomy suites.

No existing test was weakened or deleted.

## 14. Remaining deficiencies and recommended next steps

1. **Live-server validation.** Everything above ran against `test/helpers/world.js`. The next step is a scouting run on the actual server recording `latency.summary()` to `metrics.jsonl` and comparing observed vs predicted dust power on real circuits — that is the only way to move **REDSTONE ENGINEERING** from PARTIAL to PASS.
2. **Comparator/container fullness.** `bot.openContainer` on a block adjacent to a comparator gives real item counts; feeding `containerFullness` into the solver would remove the biggest remaining blind spot (and the `output strength/container data unknown` caveat).
3. **Strong/weak powering and quasi-connectivity.** Requires modelling per-face powering rules; today the engine says it cannot know rather than guessing. Worth doing only alongside live-server fixtures.
4. **Reflex→model latency (`receiptToReflexMs`) is currently unmeasured** because reflexes bypass the queue. Recording `monoNow()` at event receipt and at reflex actuation would make the "immediate" tier measurable end-to-end.
5. **Camera/attention budget.** The event budget (`max: 8`, 90 s delivered-window) is static; an adaptive window during known-idle periods would surface more ambient context without cost during work.
6. **Simulation fidelity.** The tick model treats dust decay and torch inversion correctly for common topologies but does not model update order (e.g. two observers racing). Label it as a model, and prefer live verification — which the goal gate already enforces.
7. **Real model evaluation.** Run the same 26 scenarios with the production model and record whether it actually calls `redstone_engineer`/`recall` at the right moments; the transcripts would belong in this report's section 5.

---

### Files touched

* **New**: `zincai/events.js` (EventPipeline, LatencyTracker, worldTimeOf, monoNow) — 428 lines; `zincai/redstone_engine.js` (perception, CircuitModel, designs, placement, verification, RedstoneLibrary, RedstoneEngineer) — 1 976 lines; `test/perception-memory-redstone.test.js` (34 tests).
* **Rewritten**: `zincai/memory.js` (categories, provenance, retrieval, consolidation).
* **Extended**: `zincai/index.js` (perception funnel, 12 new listeners/pollers, latency instrumentation, `recall` + `redstone_engineer` execution, reset/restart recovery, redstone goal gating), `zincai/brain.js` (microtask wake, three reaction classes, preserved important wakes, monotonic queue stamps), `zincai/system1.js` (forward velocity hazard lookahead), `zincai/redstone_inspect.js` (component coverage), `zincai/api_wrapper.js` (two new tools), `zincai/system_prompt.txt` (events/memory/redstone guidance), `package.json`.
