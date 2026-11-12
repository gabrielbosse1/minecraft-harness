# Remediation Report — `minecraft-harness` (26.3 Wire Compatibility & Campaign Failures F1–F6)

Date: 2026-11-12  
Branch: `arena/3c51cdec-minecraft-harness`

---

## Executive Summary

All campaign blockers identified in `.zinc-test-run/reports/FAILURES.md` and `.zinc-test-run/reports/FINAL_REPORT.md` have been investigated, root-caused, and remediated with regression tests:

| Finding | Severity | Status | Summary of Fix |
| --- | --- | --- | --- |
| **F1** — 26.3 wire incompatibility (`entityDelta`, `Invalid move player packet`, `tick_end`, `punch`, sequences, light masks, `entity_teleport`, scoreboard, string mappers, NMP chat) | CRITICAL | **Fixed** (verified via real `minecraft-protocol` 26.3 & 26.1 TCP loopback tests; live Mojang 26.3 Java jar absent in sandbox) | Added idempotent postinstall patcher `scripts/apply-26.3-patches.js` wired into `package.json` `postinstall`. |
| **F2** — `chatTimeoutMs: 12000` aborted real replies under Qwen3.8 ~47s p50 latency | HIGH | **Fixed** | Raised `amd.chatTimeoutMs` to `90000` (`zincai/config.json` & `AmdToolsClient` fallback) and added p90 latency-aware upward timeout scaling when `baseMs >= 10000`. |
| **F3** — Truncation (`maxTokens: 256`), mislabeled retry failures (`(prose)`), lost empty wake-ups, `<tool_call>` leaks | HIGH | **Fixed** | Raised `amd.maxTokens` to `512` (1024 on length rescue), added `<think>` stripping & `<tool_call>` JSON recovery in `coerceAction`, enabled 2 rescue retries on broken/empty/truncated outputs, fixed failure classification logs, and surfaced empty `_fallback` in `index.js` `case 'idle'`. |
| **F4** — Interior multi-floor & cross-area `go_to` failures | HIGH | **Fixed** (harness + world builder) | Fixed `doors.js` `passageAxis` with porch stairs/slabs, allowed `repeater`/`comparator` surface walkability and top-slab stair headroom in `pathfinder_wrapper.js`, added `GoalNear` range `1 -> 2` occupied-target fallback + multi-segment `thinkTimeout` continuation in `skills.js`, and fixed defective stacked stairs / missing 2F doorway / disconnected platforms in `.zinc-test-run/scripts/build_world.js`. |
| **F5** — Oversized action/chat prompts (~6.9k avg input tokens) | MEDIUM | **Fixed** | Tightened `system_prompt.txt` (-36.7%), `chat_prompt.txt` (-34.6%), and `ACTION_TOOLS` schemas (-21.0% full / ~20% per mode), cutting ~1,210 static tokens per action call while preserving all safety rules and per-mode tool filtering. |
| **Memories** — Empty `memories.json` outside chat `remember` | MEDIUM | **Fixed** | Fixed `LongTermMemory` reload deduplication (`_vec` rebuild in `add`), added `upsertByTag`, and promoted durable non-chat facts (`remember_here`, non-empty `look_in`, `circuit_project` bind/save, saved `logic_test` results). |

---

## Detailed Root Causes & Changes

### 1. F1 — Minecraft 26.3 Wire Protocol (`scripts/apply-26.3-patches.js`, `package.json`)

**Root cause:** `scripts/apply-26.3-data.js` copied vendored `26.3` `minecraft-data` files and lifted version gates, but left `minecraft-protocol@1.68.0`, `prismarine-chunk@1.41.0`, and `mineflayer@4.39.0` without the 26.3 wire codecs and physics/action packet semantics (upstream PrismarineJS `node-minecraft-protocol#1538/#1553`, `prismarine-chunk#334`, `mineflayer#4144/#4206/#4194/#4146/#4125`, `5a19e83`, `bfefb7f`, `ec4b5a4`). Specifically:
- `entityDelta` native type missing -> client crash parsing `rel_entity_move` / `entity_move_look` (`ctx.entityDelta is not a function`).
- `mineflayer/lib/plugins/physics.js` did not flush queued `pong`/`teleport_confirm` replies before `position`, did not echo `{x, y, z, yRot, xRot}` on `teleport_confirm`, did not skip physics on unloaded chunks, and did not send `tick_end` -> server kicked after ~400ms with `multiplayer.disconnect.invalid_player_movement`.
- `swingArm` sent removed `arm_animation` instead of `punch`; `player_action` IDs, `sequence` counters, and `use_item` `rotation` were missing or stale.
- `prismarine-chunk` parsed 26.3 chunk light masks (`ByteArray`) incorrectly.
- `entity_teleport` (`EntityTeleportHasRelativeFlags`), `scoreboard_score`/`reset_score`, `particle` `xMaxSpeed`, `entity_action`/`client_command` string mappers, and NMP `server/chat.js` checksum/ack validation needed 26.3/1.21.2+ alignment.

**Fix:** Implemented marker-checked idempotent patching in `scripts/apply-26.3-patches.js`, wired via `npm run postinstall` (`node scripts/apply-26.3-data.js && node scripts/apply-26.3-patches.js`). Verified idempotent across consecutive `postinstall` runs and validated end-to-end against real `minecraft-protocol` TCP servers for both `26.3` and `26.1`.

### 2. F2 — Chat & Action Timeouts (`zincai/config.json`, `zincai/api_wrapper.js`)

**Root cause:** `zincai/config.json` configured `amd.chatTimeoutMs: 12000` while Qwen3.8-27B measured 10.3s–113.6s latency (47.2s p50, 99.5s p90), aborting chat replies and dropping player task handoffs.

**Fix:**
- Raised `amd.chatTimeoutMs` to `90000` in `zincai/config.json` and fallback default in `AmdToolsClient`.
- Added sliding 16-sample latency tracking (`_recordLatency`, `_effectiveTimeoutMs`) scaling upward to `1.5 * p90` (capped at 180s action / 120s chat) only when `baseMs >= 10000`, keeping short unit-test timeouts untouched.

### 3. F3 — Truncation, `<tool_call>` Leaks, Retry Labels, & Wake Loss (`zincai/config.json`, `zincai/api_wrapper.js`, `zincai/index.js`)

**Root cause:** `amd.maxTokens: 256` clipped tool-call completions (`finish_reason: "length"` -> `out: 256` in `METRICS.json`). Failed retries were uniformly logged as `(prose)`, single-retry recovery missed multi-step failures, leaked `<tool_call>` / `<think>` text failed tool parsing, and empty `_fallback` responses hit `case 'idle'` silently without informing the model.

**Fix:**
- Raised `amd.maxTokens` from `256` to `512` (bumping up to `1024` on `length` truncation rescue).
- Updated `coerceAction` to strip `<think>...</think>` blocks and extract `<tool_call>{...}</tool_call>` payloads through schema validation before JSON/prose fallback.
- Upgraded `chatWithTools` to perform up to 2 corrective rescue retries when an answer is truncated (`length`), empty, unknown-tool, or malformed-args (preserving the existing test contract that non-length prose returns directly to the executor's `reply` error feedback).
- Replaced misleading `'prose'` retry log label with accurate classification (`truncated (length)` / `unknown "..."` / `bad args (...)` / `empty` / `prose`), and surfaced empty `_fallback` in `zincai/index.js` `case 'idle'`.

### 4. F4 — Navigation (`doors.js`, `pathfinder_wrapper.js`, `skills.js`, `.zinc-test-run/scripts/build_world.js`)

**Root cause split (code vs. campaign test-world geometry):**
1. **Harness / pathfinder code bugs:**
   - `doors.js` `passageAxis` checked only `pos.y` for room clearance, misclassifying doors with porch stairs or slabs outside.
   - `mineflayer-pathfinder` treated `repeater` and `comparator` (height `0.125` >= `0.1`) as impassable solid walls, and rejected stair climbs under `type=top` stairwell slabs (`blockA` `(0,2,0)` safe check ignored top-half underside clearance `>= 2.5`).
   - `skills.js` `goTo` reset `_noPathAt = 0` *after* `lane.setGoal(...)` (clearing synchronous/immediate `noPath`), failed `GoalNear(..., 1)` whenever `(x, y, z)` was occupied by a solid block/device, and stalled mid-walk when `AStar` hit its 5s `thinkTimeout` on long routes.
2. **Campaign world builder defects (`.zinc-test-run/scripts/build_world.js`):**
   - Area A stacked all 4 `1F->2F` and `2F->3F` stairs vertically in single `(9, y, 7)` / `(-9, y, -7)` columns with no stairwell openings in the `f2y`/`f3y` slabs and no doorway in the 2F `x=0` partition wall.
   - Area A was disconnected from Areas E, D, and C across `FLOOR=105` with `allowScaffolding=false` and `maxDropDown=4`.

**Fix:**
- Updated `doors.js` `passageAxis` to accept porch stairs/slabs with clear head height.
- Updated `pathfinder_wrapper.js` to add `repeater` and `comparator` to `movements.carpets` and patch `Movements.prototype.getMoveJumpUp` for half-step climbs under top-half ceiling blocks (`minY >= 0.5`).
- Updated `skills.js` `_walk` (reset `_noPathAt` before `setGoal`, lift `thinkTimeout >= 8000`, add up to 4 progress-gated segment continuations) and `goTo` (automatic `GoalNear(..., 2)` fallback on occupied/diagonal `no path`, plus jammed-door hints).
- Fixed `.zinc-test-run/scripts/build_world.js` Area A ascending stairwell openings + 2F partition doorway + inter-area walkways connecting Area A to Areas E, D, and C.

### 5. F5 — Prompt & Tool Schema Overhead (`zincai/system_prompt.txt`, `zincai/chat_prompt.txt`, `zincai/api_wrapper.js`)

Measured reduction (4 chars ≈ 1 token):
- `system_prompt.txt`: `4,420 chars (~1,105 tok)` → `2,796 chars (~699 tok)` (**-36.7%**)
- `chat_prompt.txt`: `1,931 chars (~483 tok)` → `1,263 chars (~316 tok)` (**-34.6%**)
- `ACTION_TOOLS` (`null` / 33 tools): `15,326 chars (~3,832 tok)` → `12,109 chars (~3,027 tok)` (**-21.0%**)
- `explorer` (29 tools): `10,657` → `8,564 chars` (**-19.6%**); `hunter` (26 tools): `9,769` → `7,783 chars` (**-20.3%**); `builder` (31 tools): `14,716` → `11,564 chars` (**-21.4%**)

### 6. Non-Chat Persistent Memory (`zincai/memory.js`, `zincai/index.js`)

**Fix:**
- Lazily rebuilt `e._vec` during `LongTermMemory.add` so reloaded `memories.json` entries deduplicate across restarts, and added `upsertByTag` to keep mutable facts (like container contents or updated place notes) single-entry.
- Promoted durable non-chat exploration & engineering events to `memories.json`: `remember_here`, non-empty `look_in` container summaries, `circuit_project` bindings/saves, and saved `logic_test` passes.

---

## Verification & Honest Gaps

Executed after final edits:
- `npm run postinstall` (run consecutively to confirm idempotency): **PASS** (all 72 patch steps reported `already patched` on second run).
- `npm run check`: **PASS** (syntax valid across all 37 source files).
- `npm test`: **266 / 266 PASS** across all 17 test files (`test/remediation.test.js` adds 12 regression tests covering 26.3 wire loopback, 26.1 regression, F2 timeouts, F3 rescue/recovery, F4 stairs/slabs/doors/`go_to`, F5 budgets, and durable memory promotion).

**Sandbox limitation (honest gap):** No Java runtime or official Mojang 26.3 dedicated server JAR is present in this sandbox (and `piston-meta.mojang.com` is unreachable), so live Java dedicated-server validation of `26.3` and live Qwen3.8 campaign re-execution could not be run here; `26.3` and `26.1` protocol compliance was verified over real TCP sockets using `minecraft-protocol` servers + `prismarine-chunk`.
