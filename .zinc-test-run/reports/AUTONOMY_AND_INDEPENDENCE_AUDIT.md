# ZincAI Autonomy, Self-Direction, Context-Reset Continuity & Social Respect Audit

**Date:** 2026-11-13  
**Branch:** `arena/ea1e525a-minecraft-harness` (from `main` @ `24ad9b9`)  
**Verification Status:** `npm run check` PASS · `npm test` **128 / 128 passing** (`0` failures across all 12 suites)

---

## 1. Executive Summary

This audit investigated and resolved the architectural bottlenecks that previously kept ZincAI behaving like a reactive command-follower rather than an independent, persistent inhabitant of a shared vanilla Survival server.

Prior to these changes, Zinc spawned with an idle-biased wake message (`just joined the server — look around; idle is fine`), stalled for 90 seconds after calling immediate setup tools like `set_mode`, recalled long-term memories only when a player spoke in chat, lacked semantic environmental/frontier perception in its default `explorer` mode, treated visited structures and nearby chests without ownership boundaries, and had no mechanism to survive mid-session LLM context resets without either replaying chat logs or losing track of completed actions and live world mutations.

We designed and integrated a structured **World-Grounded Continuity & Autonomous Agency Architecture** (`zincai/continuity.js` + upgrades across 11 runtime modules) that gives Zinc:
1. **Intrinsic Initiative & Idle Freedom:** Neutral autonomous wakeups, immediate follow-up turns after `set_mode` / `goal` / `note` / `remember_here`, autonomous long-term memory recall seeded from active goals and world features, semantic scene/frontier perception in all modes, and calm backoff when genuinely resting (`idle` streak backoff + `isBodyBusy` heartbeat suppression).
2. **First-Class Self-Generated Goals:** `originType` (`self_generated`, `player_requested`, `shared_project`, `reactive_survival`), `reason` (explicit motivation), `participants`, and `goal combine` so Zinc forms, decomposes, reprioritizes, merges, suspends, and completes multi-step personal or shared projects without cross-linking unrelated player requests under its own goals.
3. **Arbitrary Context-Reset Continuity (Zero Transcript Replay):** Durable `continuity.json` tracking verified identity/home, self-built vs player-owned structures, emergent interests, chunk frontier & container deltas, monotonic `act_<n>` execution records (`undeliveredActions()` surfaced with `do NOT repeat` if a reset occurs before the model sees a tool result), unhandled social obligations, and live-world reconciliation on every reset or process restart.
4. **Verified Ownership & Property Respect:** Hard runtime guards in `remember_here`, `skills.gather`, `skills.take`, `BuilderExecutor`, and `index.js` backed by Portuguese/English sign classification (`Casa do Gabriel` vs `Baú Comunitário` vs `Casa para Zinc`), structural wood neighbor detection, and container ownership metadata.
5. **Fast Local Survival Reflexes Preserving High-Level Plans:** Zero-LLM 200ms contact-hazard escape (`lava`, `fire`, `soul_fire`, `magma_block`, `sweet_berry_bush`, `cactus`, `powder_snow`), 20 Hz physics-tick perpendicular projectile sidestep (`arrow`, `spectral_arrow`, `trident`, `fireball`, `small_fireball`), and mid-build survival pause/resume (`BuilderExecutor._waitForHands`) so emergencies never destroy active goals or corrupt half-built structures.

---

## 2. Root-Cause Diagnosis of Previous Passive / Brittle Behavior

| Area | Previous Bottleneck (Exact Location) | Behavioral Symptom |
| :--- | :--- | :--- |
| **Startup & Heartbeat Bias** | `zincai/index.js:1166` woke spawn with `'just joined the server — look around; idle is fine'`; `zincai/brain.js:110` used `'periodic check-in (nothing urgent)'`. | Biased Qwen toward returning `idle` immediately on spawn and during quiet server periods instead of surveying or pursuing self-chosen projects. |
| **Mode-Switch Stall** | `zincai/index.js:698` (`set_mode`) updated `shared.mode` without waking `brain`. | Switching `explorer -> builder` to start a project left Zinc frozen for up to 90s waiting for the next heartbeat before `build_shape` / `build_blueprint` became callable. |
| **Chat-Only Memory Recall** | `zincai/index.js:441` queried `memory.longTerm.search()` exclusively from `shared.chatLog.slice(-3)`. | When playing alone or after chat quieted down, `memories:` disappeared completely from the action prompt. |
| **Blind Default `explorer` Perception** | `zincai/index.js:455` ran `visibleBlocks` + `detectStructure` only when `shared.mode === 'builder'`. | In default `explorer` mode, Zinc could not see rivers, forest density, caves, redstone fixtures, or unexplored chunk directions unless a container/bed happened to be indexed. |
| **Unverified Home & Blind Gathering/Looting** | `remember_here` accepted any label; `skills.gather` mined the nearest matching block ID (`oak_log`, `cobblestone`); `skills.take` opened any indexed chest. | Zinc could claim a player's house as "home" by visiting it, chop `oak_log` pillars out of a player's cabin wall, or pull items from private chests. |
| **Mid-Session Context Resets** | `WorkingMemory`, `shared.convo`, `shared.chatLog`, and `results` lived only in RAM; `goals.json` had no `act_<n>` delivery tracking or structural block sampling. | Any context wipe either replayed raw chat history or caused duplicate side-effecting tool calls (e.g., repeating `put` into a chest after it already succeeded) and missed blocks broken/modified by players. |
| **Mid-Task Heartbeat Waste & Build Preemption** | `Brain._actionStep` fired 90s heartbeats even while a long `go_to`, `gather`, or `build` was actively progressing; `BuilderExecutor` lacked a survival-lane handoff wait. | Burned unnecessary API calls mid-walk and risked failed placements if `System1` briefly fled a mob during a multi-block build. |
| **Environmental Hazards & Projectiles** | `zincai/system1.js` only fled hostile mob entities, ignoring contact blocks (lava/fire/cactus/berry) and incoming arrows in `_physicsTick`. | Standing in lava or taking skeleton arrow fire required waiting multi-second LLM round-trips instead of immediate local footwork. |

---

## 3. Architectural Changes Made

### 3.1 `zincai/continuity.js` (New Module — World-Grounded Continuity & Ownership Engine)
* **`ContinuityStore` (`continuity.json`):** Persists structured agency and world ground truth across process restarts and arbitrary in-session context resets (`onContextReset(bot, { reason, goals, places, skills, agenda, system1 })`) with **zero conversation transcript storage**.
* **Action Execution Ledger (`act_<n>`):** `beginAction()` records in-flight tool executions; `finishAction()` records completion outcome and `deliveredToModel: false`; `markActionsDelivered()` marks IDs once included in a model snapshot; `describeForPrompt({ liveResultIds })` deduplicates against live `results` on normal turns while surfacing `completed before reset (do NOT repeat): [act_n] ...` whenever a context reset wiped `results` before delivery.
* **Sign & Label Ownership Classifier (`classifySignOwnership`):** Recognizes PT-BR and EN ownership markers:
  * Private player claims (`Casa do Gabriel`, `Baú da Ana`, `Gabriel's chest`, `privado`, `particular`, `não mexa`) $\rightarrow$ `{ kind: 'player', owner }`.
  * Communal/shared resources (`Baú Comunitário`, `público`, `shared chest`, `uso livre`) $\rightarrow$ `{ kind: 'shared' }`.
  * Zinc-assigned or self-built (`Casa para Zinc`, `pode usar Zinc`) $\rightarrow$ `{ kind: 'own' }`.
* **Chunk Frontier & Environmental Perception (`observeEnvironment`):** Tracks visited chunk coordinates (`dim:cx,cz`), computes unexplored N/S/E/W frontier targets (~18m out), extracts semantic scene features (`water`, `lava`, `trees(n)`, `crops`, `redstone`, `structure:house`, `underground`), detects structural claims, and logs environmental changes.
* **Property & Container Guards (`propertyGuardAt`, `propertyGuardFootprint`, `containerTakeGuard`):** Enforces spatial protection around player-owned claims and private containers unless `askedBy` matches the owner or explicit permission was granted.

### 3.2 `zincai/goals.js` (Rich Autonomous & Collaborative Goal Model)
* Added `originType` (`self_generated`, `player_requested`, `shared_project`, `reactive_survival`), `participants` (`string[]`), and `reason` (`string | null`) to durable goal records while preserving backward-compatible `origin` (`'self'` vs `'player:<Name>'`) and byte-identical `detail` persistence.
* Added `combine(ids, { description, priority, reason, origin, note })` to merge overlapping objectives cleanly into a single parent goal while cancelling superseded originals with `combined into <newId>`.
* Enhanced `describe()` to surface subgoal lineage (`step of g1`), concise `why: <reason>`, and `shared(<participants>)` / `survival` / `self` tags.

### 3.3 `zincai/places.js`, `zincai/skills.js` & `zincai/builder.js` (Respectful World Execution)
* **`zincai/places.js`:** Extended `remember()` with `ownership` and `owner`, rendered ownership/notes in `describeNamed()`, and added `lastDiff` (`+item xN` / `-item xN`) container delta tracking in `noteContents()`.
* **`zincai/skills.js`:** Added `_isStructuralResourceBlock()` (detecting logs/stone adjacent to planks, doors, glass, stairs, slabs, beds, chests, or walls) and `guard` callback support in `gather()` so autonomous gathering skips player buildings and harvests wild resources instead.
* **`zincai/builder.js`:** Added `_waitForHands()` so `BuilderExecutor` pauses cleanly while `System1` holds the survival lane (fleeing a creeper/lava) and re-approaches once safe; added protected-fixture skipping (`bed`, `chest`, `spawner`, Signs, Redstone) and `onProgress` callbacks for durable build progress tracking.

### 3.4 `zincai/system1.js` (Zero-LLM Contact Hazard & Projectile Reflexes)
* **`_detectContactHazard` & `_tickHazardEscape`:** Every 200ms tick checks feet/body/support blocks for `lava`, `fire`, `soul_fire`, `magma_block`, `sweet_berry_bush`, `cactus`, and `powder_snow`, acquires the `survival` lane immediately, steps toward the safest adjacent clear/water block (`_findSafeHazardExit`), and releases control automatically once clear without cancelling open goals.
* **`_dodgeIncomingProjectile` (20 Hz `physicsTick`):** Detects incoming `arrow`, `spectral_arrow`, `trident`, `fireball`, and `small_fireball` entities within 14m whose 2D velocity ray passes within 1.35m of Zinc's hitbox and pulses a 180ms perpendicular strafe (`left`/`right`) toward solid footing.

### 3.5 `zincai/brain.js`, `zincai/api_wrapper.js`, `zincai/index.js` & Prompts
* **`zincai/brain.js`:** Added `isBodyBusy` check in `_actionStep` (suppressing redundant 90s heartbeat LLM calls while the body is actively navigating, gathering, building, or fleeing), neutral `'autonomous check-in'` wake label, and `clearContext()` for clean state resets.
* **`zincai/api_wrapper.js`:** Added `note` tool (durable observation + emergent `interest` + optional place `ownership`/`owner` tagging, available in every mode), extended `goal` (`combine`, `reason`, `origin`), `remember_here` (`home`, `ownership`, `owner`), and `set_mode` descriptions.
* **`zincai/index.js`:** Wired `ContinuityStore`, autonomous memory search fallback (querying open goal descriptions + world features when chat is silent), immediate follow-up `brain.wake('mode switched to ...')` on `set_mode`, 3s background environment/player-arrival observer, property/container guards on `gather`/`take`/`build_*`/`remember_here`, and `resetContext({ reason, wake })`.
* **`zincai/system_prompt.txt` & `zincai/chat_prompt.txt`:** Rewritten to frame Zinc as an independent player with genuine curiosity, calm idle freedom, strict ownership/home verification rules, mode switching awareness, continuity-snapshot trust, and natural informal Brazilian Portuguese (`pt-BR`) social voice.

---

## 4. Context-Reset Continuity Architecture & Verification (§5.3 Scenarios 1–10)

When `resetContext({ reason, wake })` runs (or the Node process restarts):
1. **Ephemeral conversational buffers are wiped completely:** `memory.working.clear()`, `brain.clearContext()`, `shared.convo.clear()`, `shared.chatLog.length = 0`, `results.length = 0`. Zero lines of old chat transcript are carried over or re-tokenized.
2. **World reconciliation runs against live Mineflayer state (`continuity.onContextReset`):**
   * Re-reads exact live `pos`, `dimension`, `health`, `food`, and active body controller (`skills.current()`, `agenda.main`, `agenda.combat`, `system1.fleeing`).
   * Re-verifies open `GoalRegistry` goals against live inventory/position (`reconcileOnStart`).
   * Samples recorded `constructions` against `bot.blockAt()` to detect any blocks removed or altered by players while context was gone.
   * Collects any `undeliveredActions()` (`deliveredToModel === false`) so side-effecting tools that completed right before the reset are explicitly shown as `completed before reset (do NOT repeat): [act_n] ...` exactly once, then marked delivered.

All **10 mandatory reset scenarios** from §5.3 are covered in `test/autonomy-independence.test.js` (`Test 10.3`):
1. **Mid-exploration:** Preserves visited chunk frontier (`overworld:0,0`) and unexplored directions while wiping chat logs.
2. **Mid-navigation (`go_to`):** Reconciles live in-progress walk without interrupting pathfinder arrival.
3. **Mid-construction (`build_shape`):** Tracks construction footprint and detects post-build block edits.
4. **During combat / danger (`zombie` flee):** Preserves live `actively fleeing` reflex state across reset.
5. **Immediately after creating a self-goal:** Preserves `g1 PENDING` + `reason` with zero chat replay.
6. **After `put` succeeded in world before model saw result:** Surfaces `[act_3] put: OK` under `completed before reset (do NOT repeat)` on the post-reset turn and clears it once delivered.
7. **Multiple active & suspended goals:** Preserves both `SUSPENDED` lower-priority survey goal and `PENDING` higher-priority build goal.
8. **Unhandled player communication:** Preserves concise structured `pendingEvents` (`Ana: "meet Ana at the river"`) without raw chat history.
9. **Player modifies environment right before reset:** Detects missing sampled blocks from Zinc's floor (`missing 2/4 sampled block(s)`).
10. **Process restart mid-multi-step action:** Transitions in-flight `running` action in `continuity.json` to `interruptedAction` (`status: 'interrupted_by_restart'`).

---

## 5. Prompt, Schema & Token Efficiency Comparison

We compare exact measurements across three points in the repository's history:
1. **Historical Live Qwen3.8-27B Campaign (`1dab001`):** `.zinc-test-run/reports/METRICS.json` (`28` live calls, `192,598` input tokens, `150,400` cached tokens = `78.1%` prefix cache hit, `avg_in_per_call: 6,879` tokens, `p50: 47.2s`, `12` pre-PR #10 timeouts).
2. **`main` Baseline (`24ad9b9`, post-PR #10/#11/#12):** Prior to this audit.
3. **This Branch (Post-Autonomy & Continuity Audit):** With `ContinuityStore`, `note` tool, updated `goal`/`remember_here`/`set_mode`, and updated prompts.

### 5.1 Static Prefix Footprint (100% Prefix-Cached Across Turns)

| Component | `main` (`24ad9b9`) | Post-Audit Branch | Delta | Cache Behavior |
| :--- | ---: | ---: | ---: | :--- |
| `zincai/system_prompt.txt` | 3,070 chars (~768 tok) | 3,732 chars (~933 tok) | +165 tok | Static system message — prefix-cached |
| `zincai/chat_prompt.txt` | 1,263 chars (~316 tok) | 1,601 chars (~400 tok) | +84 tok | Static chat system message — prefix-cached |
| `explorer` mode tools (default) | 31 tools · 10,227 chars (~2,557 tok) | 32 tools · 11,488 chars (~2,872 tok) | +315 tok | Static per mode — prefix-cached |
| `hunter` mode tools | 28 tools · 9,446 chars (~2,362 tok) | 29 tools · 10,707 chars (~2,677 tok) | +315 tok | Static per mode — prefix-cached |
| `builder` mode tools | 33 tools · 13,227 chars (~3,307 tok) | 34 tools · 14,488 chars (~3,622 tok) | +315 tok | Static per mode — prefix-cached |
| Full `ACTION_TOOLS` (unfiltered) | 35 tools · 13,772 chars (~3,443 tok) | 36 tools · 15,033 chars (~3,758 tok) | +315 tok | Only used if mode filtering disabled |
| `CHAT_TOOLS` (`reply`) | 1 tool · 788 chars (~197 tok) | 1 tool · 788 chars (~197 tok) | 0 tok | Unchanged |

### 5.2 Dynamic Per-Turn & Session-Long Call Efficiency Gains

* **Zero Uncached Transcript Growth Across Context Resets:** Previously, `shared.convo` + `shared.chatLog` accumulated raw lines in memory while resets lost action delivery state. Now, `ContinuityStore.describeForPrompt()` adds only **~45–160 tokens** of structured state (`identity:`, `world:`, and post-reset `continuity:` / `completed before reset:` lines only when non-empty) and deduplicates live `results` (`liveResultIds`) so normal turns never pay twice for recent tool outcomes.
* **Eliminated Mid-Task Heartbeat Calls (`Brain.isBodyBusy`):** Previously, a 3-minute walk, gather, or multi-phase build triggered 2 unsolicited heartbeat LLM calls (~7,600–13,700 input tokens) while the body was already busy executing the current plan. `isBodyBusy` suppresses 100% of unsolicited heartbeats during active movement/gathering/building/fleeing while keeping reactive wakes (`hurt`, `chat`, `task finished`) instantaneous.
* **Eliminated 90s Dead-Air Stall on `set_mode`:** Immediate wake on mode change lets Zinc switch `explorer -> builder` and start `build_shape` in <1s instead of sitting idle for 90s.
* **Zero-LLM Hazard & Projectile Reflexes:** Lava/fire/berry/cactus escape and arrow sidesteps execute in **0 LLM calls (<200ms)** instead of triggering slow emergency reasoning turns while taking damage.

---

## 6. Verification & Automated Test Suite Summary

All **128 automated tests** across **12 test files** pass with zero regressions (`npm run check && npm test`):

| Suite | Tests | Status | Focus |
| :--- | ---: | :---: | :--- |
| `test/autonomy-independence.test.js` | 8 | PASS | **New:** §10.1 unprompted world perception/mode chaining, §10.2 self-goal lifecycle (`add`/`reason`/`combine`/`update`/subgoals/competing player requests), §10.3 all 10 arbitrary context-reset scenarios, §10.4 sign/house/chest ownership & verified home guards, §10.5 creative blocked-path `go_to` $\rightarrow$ selective `dig` strategy switch, §10.6 idle backoff & `isBodyBusy` efficiency, §10.7a lava escape + arrow sidestep reflexes, §10.7b mid-build survival preemption & resume |
| `test/goal-orchestration.test.js` | 15 | PASS | Durable `GoalRegistry` G1–G15 invariants, interruption recovery, `stop` semantics, world reconciliation |
| `test/session.test.js` | 18 | PASS | Full Mineflayer session harness, combat reactions, whisper privacy, chat lane + action lane coordination |
| `test/capabilities.test.js` | 16 | PASS | Skills, crafting, gathering, container interactions, mode tool filtering |
| `test/digging.test.js` | 7 | PASS | Real A* `Movements` corridor digging, `materials`/`avoid` constraints, prompt invariants |
| `test/circuit-projects.test.js` | 12 | PASS | Phased redstone circuit project planning, verification, repair |
| `test/redstone-inspect.test.js` | 9 | PASS | Block, region, and redstone signal inspection |
| `test/logic.test.js` | 6 | PASS | Logic simulation & truth-table verification |
| `test/pufferpanel.test.js` & `test/settings.test.js` | 18 | PASS | PufferPanel deployment template, env var validation, offline/online settings |
| `test/amdClient.test.js` & `test/zincai.test.js` | 19 | PASS | OpenAI/AMD gateway retries, tool coercion, memory embeddings, structure detection, scaffolds |

---

## 7. Live Server Validation Readiness & Remaining Limitations

* **Sandbox Environment Note:** This container environment has no Java runtime (`java` binary absent), no running Minecraft 26.3 server process, and no `AMD_API_KEY` secret configured, so end-to-end tests were executed against the deterministic `prismarine-world` / `prismarine-physics` / `mineflayer-pathfinder` full-session simulator (`test/helpers/session.js` + `test/helpers/world.js`).
* **Ready for Live Campaign Validation:** To run a live multi-hour autonomy & reset campaign on a Paper/Vanilla 26.3 server with `AMD_API_KEY`:
  1. Launch Zinc via `npm start` (or PufferPanel template `pufferpanel/zincai.json`).
  2. Call `session.resetContext({ reason: 'live_test' })` at any point (or send `SIGINT` / restart container) to exercise live context-reset reconciliation against `zincai-data/continuity.json` and `zincai-data/goals.json`.
* **Known Limitations & Future Extensions:**
  * Sign text extraction reads standard 1.20+/1.21+ front/back sign NBT (`front_text` / `back_text` / `getSignText`); custom server plugins using floating armor-stand holograms instead of block signs are not yet parsed as property claims unless a player mentions ownership in chat or Zinc tags the place via `note` / `remember_here`.
  * `ContinuityStore` samples up to 24 representative blocks per recorded construction for O(1) reset reconciliation; subtle 1-block cosmetic edits on huge (>200 block) builds may fall outside the 24-block sample unless near the centroid or corners.
