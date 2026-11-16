# ZincAI — Agent & Engineering Technical Reference

Dense, factual specification of `minecraft-harness` for AI coding agents and contributors. All symbols, schemas, paths, and invariants below match the verified runtime on branch `arena/59bacbeb-minecraft-harness`.

---

## 1. Non-Negotiable Architectural Invariants

1. **Zero behavioral modes or permission switches.** Never add persona modes (`explorer`/`builder`/`hunter`), `set_mode`, `actions.allowDig`/`allowPlace`/`allowCombat`, `dig_policy`, `equip.auto`, chat relevance filters, language guards, or trusted-player UUID lists. Model agency is unconstrained; all **41 tools** are sent with a byte-identical schema every turn.
2. **Vanilla client-only boundary.** No RCON, no server plugins, no op commands. `installVanillaGuard` (`zincai/vanilla_guard.js`) blocks any `/...` chat line except guarded `/msg <onlinePlayer> <text>` whispers and emits `vanilla_command_blocked`.
3. **Physical boundary is lifecycle + anti-flood only.** `PhysicalBoundary` (`zincai/boundary.js`) gates 19 Mineflayer primitives strictly on `connected`, `alive`, `!paused`, and sliding-window `limits.maxPhysicalActionsPerMinute` (default `600`, `0` = unlimited).
4. **Defer Mineflayer method wrapping to `inject_allowed`.** Immediately after `mineflayer.createBot(...)` returns, plugins have not attached `bot.chat`, `bot.dig`, `bot.placeBlock`, etc. Both `installVanillaGuard` and `installPhysicalGuard` MUST hook `bot.once('inject_allowed', ...)` (with a `login` fallback) when methods are absent at call time.
5. **Always pass `new Vec3(x, y, z)` to `bot.blockAt(...)`.** Real Mineflayer calls `point.floored()` and throws on plain `{ x, y, z }` objects. Never pass raw object literals to `bot.blockAt`.
6. **Acquire `ControlArbiter` lanes before driving pathfinder/body.** Any code driving `executor._approach` or `bot.pathfinder` through a `ControlArbiter` lane (`hands`) MUST call `hands.acquire({ ttlMs, reason })` and `hands.release()` in `finally` (see `placePlan` in `zincai/redstone_engine.js`). Unacquired lanes silently drop `setGoal`.
7. **Map Minecraft block names to inventory item names when building/placing.** `redstone_wire → redstone`, `redstone_wall_torch → redstone_torch`, `wall_torch → torch`, `soul_wall_torch → soul_torch`, `tripwire → string`. Verify placed blocks against `expectedBlockName` in `BuilderExecutor._placeAt`.
8. **Console-only operator control.** Operator commands enter strictly via process `stdin` (`host.attachStdin()`) or programmatic `host.command(line, from)`. In-game chat is never parsed as an operator command.
9. **Honest perception & reporting.** Never invent unknown block states, unverified redstone power flow, container contents, or heuristic room labels. Static redstone scans do not claim live circuit verification (`verify` requires observed world output transitions).
10. **Unified `data/` runtime storage.** All persistent JSON stores and session telemetry default to `<repo>/data` (override via `ZINC_DATA_DIR`). Never write runtime files to `zincai/data/`.

---

## 1b. Memory Architecture (three stores, one facade)

`MemorySystem` (`zincai/memory.js`) is the only memory object the runtime talks
to. It owns three physically separate stores plus volatile working context.

| Store | Path | Contents | Automatic prompt use |
| --- | --- | --- | --- |
| Raw history | `data/history/<category>/<YYYY-MM-DD>.jsonl` (+ `<day>.idx.json` keyword sidecars) | every observation, chat line, tool outcome, decision, relationship event and error; append-only | **never** — only explicit `memory {operation:"history"}` searches (newest files first, ≤`maxScanFiles` files, ≤`maxFileBytes` each) |
| Entity dossiers | `data/entities/<kind>-<id>.json`, `data/entities/index.json` | long-form Markdown-backed documents: player (UUID-keyed), self, place, group, event; sections `identity, description, interactions, preferences, behavior, facts, uncertainties, timeline, notes`; `evidence[]`, `memoryIds[]` | `recognitionBlock()` for visible/speaking/referenced players, budgeted |
| Curated memories | `data/memories.json` | short records: category, `basis` (`observed`/`reported`/`inferred`), confidence, importance, stable id, `evidence[]` (history refs), `profileId`, `status` (`active`/`outdated`/`contradicted`/`archived`/`deleted`) | `contextBlock()` (goal + position + entity + players), budgeted per compaction level |
| Working context | in-process | `working` (last 5), `shortTerm` (10 min), `ephemeral` (30 s), preferences | prompt sections, never persisted as knowledge |

Hard rules enforced by the implementation:

- Telemetry types (`hurt`, `heal`, `entity_hurt`, `player_arrived`, `player_left`,
  `dimension`, `inventory`, `weather`, `move`, …) are history-only; curated
  promotion requires importance ≥ 3 **and** a non-telemetry type, or an explicit
  `promote: true`.
- Player identity is the UUID. A name-only dossier is upgraded in place on first
  UUID sighting; a different UUID reusing a username gets its own dossier.
- `archive`/`delete` only change the curated row (`deleted`/`archived`, restorable);
  raw history files are never touched. `maintain()` merges true duplicates
  (cosine ≥ 0.94, same category/basis/location), supersedes old `subjectKey`
  versions as `outdated`, archives expired low-value episodes, and never evicts
  `foundational` records.
- Corrupt dossiers are quarantined as `<file>.corrupt-<ts>` and rebuilt; corrupt
  curated JSON starts empty; partial NDJSON lines are skipped on read.
- `HistoryLog.append` coalesces an identical line inside a 45 s window into
  `repeats` instead of appending a second record.
- Only durable chat is curated: a player line becomes a `reported` claim when it
  carries a coordinate, a structure/container, ownership or a stated preference
  (or an agreement). Small talk stays in raw history and in the dossier's
  evidence. A reported claim recorded without explicit evidence is anchored to
  the most recent chat/relationship history record.
- `maintain()` also archives rows written by older builds that promoted ordinary
  telemetry ("X took damage 16m away") and clears their `foundational` flag, and
  seeds name-only player dossiers from recurring legacy memories (upgraded in
  place when the UUID is later observed).

### Automatic retrieval (one budgeted block per turn)

`MemorySystem.contextBlock()` composes, in this order, inside
`memory.recallBudgetChars` (820 at L0 → 220 at L4, shrinking with compaction):

1. `recognitionBlock()` — up to 2 players in front of Zinc, resolved by UUID →
   one dossier line each (identity basis, relationship stance/trust, last fact).
2. Curated recall — sparse-embedding + keyword + entity + proximity + goal +
   recency ranking, `recallTopK` 3 (2 at L4), 45% of the budget.
3. `past attempts (raw log):` — at L0/L1 only, a ≤4-file keyword search of
   `errors`/`decisions`/`actions` for the current goal/query, 2 lines. Never a
   dump; skipped when less than 140 characters of budget remain.

The block is cached for 3 s keyed by query/goal/position/players/level, so a
prompt rebuild does not re-rank. `memory {operation:"history"}` is the way to ask
for more; measured cost with 400 curated records and 60 history files is
~0.6 ms per uncached build (test 13n).

---

## 2. Boot Chain & Exports (`zincai/index.js`)

```text
CLI: node zincai/index.js [--dry-run | --check]
  ├── supervisor.js (unless ZINCAI_NO_SUPERVISOR=1 or --dry-run/--check)
  └── main():
        1. loadConfig()           # zincai/config/defaults.json + env overrides
        2. makeShared(cfg)        # process-lifetime stores & controllers:
             - runtimeConfig (RuntimeConfig, data/runtime-config.json)
             - boundary      (PhysicalBoundary)
             - goals         (GoalRegistry, data/goals.json)
             - memory        (MemoryStore, data/memories.json + preferences.json)
             - continuity    (ContinuityStore, data/continuity.json)
             - journal       (Journal, data/journal.json)
             - places        (PlaceIndex, data/places.json)
             - circuits      (CircuitProjectStore, data/circuit_projects.json)
             - redstoneLib   (RedstoneLibrary, data/redstone_library.json)
             - telemetry     (TelemetryRecorder, data/sessions/<sessionId>/)
             - watchdog      (Watchdog)
        3. createHost(cfg, shared) # zincai/host.js:
             - owns ConnectionManager (zincai/connection.js)
             - boots via host.boot()
             - attaches stdin console commands via host.attachStdin()
             - connects via startSession(cfg, shared, opts)
```

### `Host` Public API (`zincai/host.js`)
- `boot()` — Starts `ConnectionManager` and initiates connection.
- `command(line, from = 'console')` — Async; parses & executes a console command, returns `{ ok, reply, ... }`.
- `dispatch(name, args, who)` — Low-level command dispatcher.
- `pause(reason)` / `resume()` / `leave()` / `join()` / `stop()` — Lifecycle controls.
- `attachSession(session)` — Wires an externally created `startSession` handle into `Host`.
- Properties: `host.session`, `host.paused`, `host.config` (`RuntimeConfig`).

### `startSession` Return Handle (`zincai/index.js`)
- `bot` — Live Mineflayer bot instance.
- `isSpawned()` — Boolean spawn state.
- `dispose(quiet)` — Tears down timers, pathfinder, guards, listeners, and client socket cleanly.
- `internals()` — Exposes `{ brain, system1, armor, combat, skills, executor, pathfinder, redstone, boundary, vanillaGuard, arbiter, sense }` for diagnostics and real-server simulation tests.

---

## 3. Repository & Module Map

### `zincai/`
| File | Key Exports / Role |
| --- | --- |
| `index.js` | Entrypoint, `loadConfig`, `makeShared`, `createHost`, `startSession`, 41-tool switch, `buildLiveContinuation` |
| `api_wrapper.js` | `AmdToolsClient`, `ACTION_TOOLS` (41), `createRecoveryTools`, `extractReasoning`, `coerceActions`, `buildToolsPayload` |
| `context_budget.js` | `ContextBudget`, `resolveModelLimits`, `/models` discovery, HTTP 400 limit learning, proactive/reactive compaction, `trimIncompleteSentence` |
| `brain.js` | `Brain` — multi-step action loop (`maxStepsPerTurn: 6`), `wake(reason, opts)`, `situationVersion` staleness guard |
| `lanes.js` | `LaneScheduler` — concurrent `chat` + `action` lanes sharing `rpm` (18) with `chatReserve` (4) |
| `irc.js` | `IrcTimeline` — unified chronological log of chat, whispers, and world events |
| `system1.js` | `System1` — 200ms survival reflex tick (threat flee, contact hazard lookahead/exit, eat, water clutch, elytra, swim) |
| `threats.js` | `ThreatSense` (trigger 12m / ranged 18m / close 8m / watch 32m), `HurtTracker`, `isProtected`, `isHostileMob` |
| `tactics.js` | Vanilla melee/armor fight estimator injected into prompts during threats; emitted threat entries include usable entity ids |
| `environment.js` | Block-derived sky/roof/ground/light/hazard/facing/biome observations and bounded surface-exit candidates |
| `build_site.js` | Preflight validation for large habitation sites (cave roof, liquid, unloaded cells, unsupported foundation) |
| `control.js` | `ControlArbiter`, `PRIORITY` (`survival > combat > task > idle`) |
| `boundary.js` | `PhysicalBoundary`, `installPhysicalGuard`, `ACTION_CAPABILITIES`, `BOT_METHOD_CAPS` (19 gated bot methods) |
| `vanilla_guard.js` | `installVanillaGuard`, `isCommandLine`, `assertVanillaAction`, `FORBIDDEN_ACTION_FIELDS` |
| `armor.js` | `ArmorKeeper` — automatic armor upgrades; manual `equip` holds the chosen slot without needing toggles |
| `death_recovery.js` | `DeathRecovery` — `onDeath`/`noteDeath`, `onRespawn`, `respawnDelayMs()`, `deaths`, `lastRecovery` |
| `skills.js` | `Skills` — `gather` (any diggable vanilla block via `UNGATHERABLE_BLOCKS` + aliases), `craft`, `smelt`, containers, `sleep`, `light_up`, `shelter`, `corpse_run` |
| `builder.js` | `BuilderExecutor`, `generateShape`, `normalizeStage`; `_placeAt(target, itemName, expectedBlockName)` |
| `redstone_inspect.js` | `RedstoneInspector` — static snapshot capture (`rs<N>`) & component query |
| `redstone_engine.js` | `RedstoneEngineer`, `preflight`, `placePlan`, `functionalTest`, `BLOCK_TO_ITEM` (`redstone_wire→redstone`), `DESIGNS` |
| `logic_test.js` | Abstract Boolean combinational logic truth-table verifier |
| `circuit_projects.js` | `CircuitProjectStore` (`data/circuit_projects.json`) |
| `perception.js` | `buildVisionBlock`, `VISION_LEGEND` — grounded text world summary |
| `vision.js` | Lightweight chunk-column software voxel renderer for `screenshot` (`look`, `panorama`, `map`) with procedural 16×16 Minecraft block textures, AO, translucent water/glass, sky/sun/clouds, and blocky entities |
| `places.js` | `PlaceIndex` (`places.named`, containers, workstations; `data/places.json`) |
| `block_search.js`, `block_inspect.js`, `region_inspect.js` | Fast block lookup and honest paginated inspection |
| `goals.js` | `GoalRegistry` (`STATUS`: `active`, `queued`, `waiting`, `resumable`, `blocked`, `completed`, `failed`, `cancelled`; `list()`, `openGoals()`, `suspendAll()`) |
| `memory.js` | `MemorySystem` facade + `LongTermMemory` curated store (`data/memories.json`): stable ids, `get`/`update`/`archive`/`restore`/`remove`/`merge`/`duplicates`/`search`, evidence links, non-destructive `maintain`; automatic `contextBlock`/`recognitionBlock` |
| `memory_text.js` | Shared tokenizer, accent folding, synonym table, sparse bag-of-words embed/cosine, whole-word match, clipping — used by all three memory stores |
| `history.js` | `HistoryLog`: append-only NDJSON raw history under `data/history/<category>/<day>.jsonl`, per-file keyword sidecar index, bounded `search`/`read`, coalesced repeats, opt-in age pruning of world/chat/actions only |
| `entities.js` | `ProfileStore`: one JSON+Markdown dossier per subject under `data/entities/` (players keyed by UUID, name-only upgrade, rename handling), sections, evidence/memory links, merge, quarantine on corruption |
| `continuity.js` | `ContinuityStore` (`getRelationship`, social stances, evidence; `data/continuity.json`) |
| `journal.js` | `Journal` (goal plans & session digest; `data/journal.json`) |
| `telemetry.js` | `TelemetryRecorder`, `makeSessionId`, `setContinuationProvider`, `lifecycle`, `worldEvent`, `reflexEvent`, `chatIn`, `chatOut`, `modelRequest`, `modelResponse`, `toolExec`, `screenshot` (archives session PNGs under `sessions/<id>/screenshots/`), `goalEvent`, `combatEvent`, `operatorCommand`, `error`, `flush`, `close` |
| `runtime_config.js` | `RuntimeConfig`, `SCHEMA` (10 validated parameters) |
| `control_commands.js` | `COMMANDS` (15 console commands), `parseCommand`, `helpText` |
| `connection.js` | `ConnectionManager` — exponential backoff reconnect state machine |
| `host.js` | `Host` — process-lifetime owner & stdin console bridge |
| `protocol_keepalive.js` | Exact keep-alive echo + silent server timeout |
| `failgate.js`, `events.js`, `observe.js`, `filter.js`, `reflex_registry.js`, `supervisor.js`, `updater.js`, `watchdog.js` | Supporting runtime services |
| `custom_mineflayer/pathfinder_wrapper.js` | Threat-aware pathfinder wrapper (40-tick threat penalty grid, action-derived posture) |
| `custom_mineflayer/escape.js` | Node-bounded BFS escape planner (`open`/`pocket`/`chased`/`surrounded`/`trapped`) |
| `custom_mineflayer/doors.js` | Door/gate/trapdoor walkability & opening |

### `src/`, `scripts/`, `pufferpanel/`
- `src/amdClient.js` — OpenAI-compatible HTTP client with retries, concurrency cap, reasoning extraction (`reasoning_content`/`reasoning`/`<think>`).
- `zincai/api_wrapper.js` — `AmdToolsClient`: per-lane call queues, native tool calling, and the **retry/timeout policy** (see §9). A call cancelled by the caller is never retried; only a real expired deadline is a retryable timeout.
- `src/combat.js` — `AdvancedCombat` (weapon selection, crit timing, sprint-reset, reach, chain kills, `explicitPlayersOnly`).
- `src/recipes.js` — Crafting tree solver over `prismarine-recipe`.
- `src/logger.js`, `src/reasonToText.js`, `src/reconnect.js`, `src/settings.js` — Shared utilities.
- `scripts/apply-26.3-data.js` & `scripts/apply-26.3-patches.js` — Run automatically on `npm install` (`postinstall`) to add Minecraft 26.x protocol/registry compatibility to `node_modules/`.
- `scripts/ping-server.js` (`npm run ping`) & `scripts/amd-canary.js` (`npm run canary`) — Live connectivity probes.
- `pufferpanel/zincai.json`, `import.js`, `doctor.js` — PufferPanel v3 template (19 variables, 6 install steps).

---

## 4. Action Tool Catalog (41 Tools, `zincai/api_wrapper.js`)

| Category | Tool | Key Arguments |
| --- | --- | --- |
| **Movement** | `go_to` | `{ x, y, z }` or `{ player }` or `{ place }` |
| | `follow` | `{ player, distance? }` |
| | `dig` | `{ x, y, z, materials? }` |
| | `stop` | `{}` |
| | `corpse_run` | `{}` |
| **Gathering & Craft** | `gather` | `{ item, count?, radius? }` (any diggable vanilla block; aliases supported) |
| | `craft` | `{ item, count? }` |
| | `smelt` | `{ item, fuel?, count? }` |
| | `look_in` | `{ x, y, z }` or `{ container }` |
| | `take` | `{ item, count?, x?, y?, z? }` |
| | `put` | `{ item, count?, x?, y?, z? }` |
| | `give` | `{ player, item, count? }` |
| **Building & Body** | `build` | `{ grid, palette, at: [x,y,z] }` or `{ blueprint, at }` |
| | `build_shape` | `{ shape, block, at: [x,y,z], params }` (e.g. `wall: { l, h, th?, axis }`) |
| | `light_up` | `{ radius? }` |
| | `shelter` | `{}` |
| | `use_block` | `{ x, y, z }` |
| | `sleep` | `{}` |
| | `eat` | `{ item? }` |
| | `equip` | `{ item, where? }` (`hand`/`off-hand`/`head`/`torso`/`legs`/`feet`; holds armor slot) |
| | `run_script` | `{ name, args? }` |
| **Combat & Reflex** | `attack` | `{ target?, player?, count? }` (players require explicit `player` username; protected entities refused) |
| | `hold` | `{ ids? }` (suppress reflex flee from currently listed threats) |
| **Inspection** | `inspect_block` | `{ x, y, z }` |
| | `inspect_region` | `{ x, y, z, radius?, page? }` |
| | `find` | `{ what, radius? }` |
| | `remember_here` | `{ name, note? }` |
| | `screenshot` | `{ view: 'look'\|'panorama'\|'map', fov?, range? }` |
| **Redstone & Logic** | `redstone_scan` | `{ x, y, z, radius? }` (returns snapshot id `rs<N>`) |
| | `redstone_component` | `{ snapshot, x, y, z }` |
| | `redstone_engineer` | `{ operation: 'analyze'\|'design'\|'place'\|'verify'\|..., ... }` |
| | `logic_test` | `{ project?, inputs, gates, outputs, tests }` |
| | `circuit_project` | `{ operation: 'list'\|'show'\|'save'\|'delete', name?, ... }` |
| **Social & Meta** | `say` | `{ text, to? }` |
| | `goal` | `{ operation: 'add'\|'update'\|'complete'\|'fail'\|'cancel'\|'list', ... }` |
| | `memory` | `{ operation: recall\|search\|read\|remember\|update\|archive\|delete\|restore\|merge\|duplicates\|link\|profile\|profiles\|history\|organize, ... }` |
| | `note` | `{ text, interest?, tags? }` |
| | `recall` | `{ query, category?, entity?, goal?, x/y/z? }` |
| | `social` | `{ operation: 'show'\|'update', player, stance?, trust?, confidence?, willingness?, opinion?, evidence? }` |
| | `idle` | `{ reason? }` |

---

## 5. Runtime Config (10 Keys) & Console Commands (15)

### Runtime Config (`zincai/runtime_config.js` → `data/runtime-config.json`)
| Key | Type | Default | Range |
| --- | --- | --- | --- |
| `limits.maxConcurrentJobs` | integer | `4` | `1..64` |
| `limits.maxPhysicalActionsPerMinute` | integer | `600` | `0..10000` (`0` = unlimited) |
| `limits.maxGoalRuntimeMinutes` | integer | `0` | `0..1440` (`0` = off) |
| `connection.minRetryDelayMs` | integer | `5000` | `250..600000` |
| `connection.retryDelayMs` | integer | `5000` | `250..600000` |
| `connection.maxRetryDelayMs` | integer | `120000` | `500..3600000` |
| `connection.maxRetries` | integer | `40` | `1..1000` |
| `death.respawnDelayMs` | integer | `1500` | `0..60000` |
| `control.allowConsole` | boolean | `true` | — |
| `control.auditLog` | boolean | `true` | — |

`zincai/config/defaults.json` → `memory` (not operator-settable at runtime):
`file`, `preferencesFile`, `workingMax` (5), `shortTermMinutes` (10),
`ephemeralMs` (30000), `topK` (3), `factsPerPlayer` (6), `chatRecallMaxAgeMs`
(120000), `recallBudgetChars` (820), `maxEntries` (500), `episodicTtlMs`
(30 days), `maintenanceCheckMs` (60000), `maintenanceIntervalMs` (6 h),
`maintenance.activeThreshold` (400), `maintenance.duplicateThreshold` (0.94),
`history.dir` (`data/history`), `history.retainDays` (`0` = keep everything),
`entities.dir` (`data/entities`).

### Console Commands (`zincai/control_commands.js`)
`status`, `pause`, `stop`, `resume`, `leave`, `join`, `restart-connection`, `goals`, `jobs`, `cancel <goal-id>`, `config [show [group|name] | set <name> <value> | reset <name>]`, `update [check|force]`, `restart`, `shutdown [exit-code]`, `help`.

---

## 6. Telemetry & Persistence Schemas (`data/`)

Root directory: `ZINC_DATA_DIR` (default `<repo>/data`).

### `data/sessions/<sessionId>/events.jsonl`
NDJSON; one JSON object per line:
```json
{ "seq": 1, "ts": "2026-11-14T22:00:00.000Z", "ms": 1794693600000, "sessionId": "...", "type": "tool_exec", "data": { ... } }
```
Event `type` values: `session_start`, `session_end`, `lifecycle` (`data.phase`: `spawn` | `death` | `respawn`), `world_event`, `reflex_event`, `chat_in`, `chat_out`, `model_request`, `model_response`, `tool_exec`, `goal_event`, `combat_event`, `operator_command`, `error`.

### `data/sessions/<sessionId>/continuation.json`
```json
{
  "schemaVersion": 1,
  "sessionId": "...",
  "status": "running | stopped",
  "flushReason": "start | periodic | stop | ...",
  "startedAt": "ISO",
  "updatedAt": "ISO",
  "endedAt": "ISO | null",
  "botState": { "connected": true, "alive": true, "dimension": "overworld", "position": { "x": 0, "y": 5, "z": 0 }, "health": 20, "food": 20, "activity": "", "inventory": [], "recentChat": [] },
  "activeGoal": { "id": "g1", "status": "active", "kind": "declared", "description": "...", "label": "...", "origin": "self", "progress": {} },
  "openGoals": [ ... ],
  "plan": null,
  "journalDigest": {},
  "pendingProposals": [],
  "lastModelRequest": {},
  "lastModelThought": { "at": "ISO", "lane": "action", "reasoning": "...", "content": "..." },
  "recentTools": [],
  "recentEvents": [],
  "stats": { "totalEvents": 0, "worldEvents": 0, "reflexEvents": 0, "modelRequests": 0, "modelResponses": 0, "toolExecutions": 0, "toolFailures": 0, "goalEvents": 0, "combatEvents": 0, "chatIn": 0, "chatOut": 0, "deaths": 0, "errors": 0, "tokensIn": 0, "tokensOut": 0, "tokensCached": 0 }
}
```
Note: `openGoals` includes all non-terminal goals (`!['completed', 'failed', 'cancelled'].includes(g.status)`), including `resumable` goals suspended on shutdown so the next session sees them cleanly.

### `data/latest.json`
Points to `{ sessionId, status, startedAt, updatedAt, eventsFile, continuationFile, stats }`.

### `data/memories.json` (curated)
JSON array. One record:
```json
{
  "id": "m...", "ts": 1794693600000, "createdAt": "ISO", "updatedAt": 1794693600000,
  "lastVerifiedAt": 1794693600000,
  "text": "Chest 1 holds 12 iron ingots and 4 gold",
  "category": "semantic", "basis": "observed", "confidence": 0.95, "importance": 3,
  "foundational": true, "tags": ["container", "chest1"], "entities": ["Faylan25"],
  "location": { "x": 10, "y": 64, "z": 20, "dim": "overworld" },
  "goalIds": [], "subjectKey": "container:chest1", "status": "active",
  "occurrences": 3, "revision": 1,
  "evidence": ["world/2026-11-15.jsonl#42"],
  "profileId": "player:069a79f4-44e9-4726-a6b4-7a5b2f5d3a11",
  "provenance": { "kind": "direct_observation", "source": "world" }
}
```
`previousText` preserves an edited value; `archiveReason`/`deletedAt`/`lastEditReason`
record lifecycle changes; `mergedFrom[]`/`supersededBy` link merges. Archived and
deleted records remain on disk (restorable); only `hard:true` deletes the row.

### `data/entities/<kind>-<id>.json` (dossiers)
One file per subject. Player ids are `player:<uuid>` (`player:name:<slug>` until a
UUID is seen, upgraded in place). Fields: `schema, id, kind, uuid, identityBasis,
names[], aliasesStale[], displayName, firstSeenAt, lastSeenAt, interactions,
relationship{stance,trust,confidence,willingness,assessment,evidence[]},
sections{identity,description,interactions,preferences,behavior,facts,uncertainties,timeline,notes},
doc, evidence[{ref,at,note}], memoryIds[], tags[], status, mergedFrom[], revision,
createdAt, updatedAt`. `index.json` maps uuid/name → id and is rebuilt by scanning
the directory when missing or corrupt.

### `data/history/<category>/<day>.jsonl` (raw)
One JSON record per line:
```json
{ "id": "h-...", "ref": "world/2026-11-15.jsonl#42", "at": 1794693600000,
  "iso": "ISO", "cat": "world", "kind": "entity_hurt", "text": "...",
  "entities": ["Steve"], "uuid": null, "where": {"x":10,"y":64,"z":20,"dim":"overworld"},
  "session": "...", "importance": 1, "repeats": null, "data": {} }
```
`<day>.idx.json` holds `{day, records, tokens{}, entities[], uuids[], kinds{},
firstAt, lastAt}` and is what makes an old record findable without scanning every
file. `history.search()` returns hits ranked by keyword/entity/kind + recency with
`ref`, `scannedFiles`, `candidateFiles`, `truncated`.

---

## 7. Real-Server Simulation Testing (`test/`)

All tests run against **real local Minecraft 1.21.4 servers (`flying-squid@^1.12.0`)** over localhost TCP sockets and a local OpenAI-compatible HTTP server (`test/helpers/sim-harness.js`). No mocked `bot` objects.

### Commands
```sh
npm run check                # syntax check every JS module
npm test                     # node --test test/*.test.js (13 suites, 49 tests)
AMD_API_KEY=rc-test npm run dry-run
npm run pufferpanel:validate
```

### `flying-squid` 1.21.4 Protocol & Lifecycle Quirks (already solved in `test/helpers/mc-server.js`)
- Always spread `flying-squid/config/default-settings.json` with `worldFolder: false`, `online-mode: false`, `logging: false`, `plugins: {}`.
- Patch `playerDat.save = async () => {}` so `worldFolder: false` does not create `./false/playerdata/` and leak state across runs.
- Suppress `readline.createInterface` during `require('flying-squid')` and `createMCServer()` (otherwise `log.js` binds stdin).
- Track and clear `flying-squid`'s leaked 5000ms `fillTabList` interval and `serv.stopTickInterval()`, plus `minecraft-protocol`'s 30s `client.closeTimer` on both bot and extra clients so `node --test` exits immediately.
- `serv.playSound = () => {}` avoids pre-1.21.4 string `sound_effect` frames when placing blocks.
- 1.21.4 protocol bridge in `serv.on('newPlayer', ...)` handles:
  - `player.spawnPacketName = 'spawn_entity'` + `entityType = mcData.entitiesByName.player.id` (replaces removed `named_entity_spawn`),
  - `client_command { actionId: 'perform_respawn' }` → 1.21.4 `respawn { worldState, copyMetadata: 0 }` + `position { dx:0, dy:0, dz:0, flags: { _value: 0 } }`,
  - `position` / `position_look` relaying boolean `flags?.onGround` + 1.21.4 `entity_teleport` fields.
- Spawn mobs via `serv.initEntity('mob', mcData.entitiesByName[name].id, serv.overworld, pos)` + `mob.updateAndSpawn()` (not `serv.spawnMob`), and never call `flying-squid`'s `player.teleport()` directly (move test players via Mineflayer `setControlState`).
- In `sim-harness.js`, `startSimulation()` waits for the initial spawn wake (`llm.actionRequests().length >= 1 && !brain.busyAction`) before returning so scripted actions enqueued by tests are never consumed by the boot turn.
- When testing `attack` deterministically against a hostile mob without racing `System1`'s flee reflex, spawn the mob beyond `ThreatSense.radius` (`12m`, e.g. `14m`) and inside `combat.engage` range (`24m`). When checking inventory items that `ArmorKeeper` may auto-equip immediately, inspect `bot.inventory.slots` (slots `5..8` included), not just `bot.inventory.items()`.

---

## 9. Inference Timeouts & Retries (`zincai/api_wrapper.js`)

The endpoint is the slowest moving part of the process, and "retryable timeout"
lines in the log are the symptom operators ask about most. The policy:

| Rule | Why |
| --- | --- |
| A **caller cancellation** (a chat line preempting an action thought, session ending) is an `AbortError` with `code: ZINCAI_ABORTED` — never retried, never logged as a timeout. | The old code could not tell the two abort sources apart, so a preempted turn re-sent the same request 3× and printed 3 "retryable timeout" lines for nothing. |
| Backoff between retries is cancellable. | A cancelled turn must die immediately, not after its remaining retries have been slept through. |
| A **real expired deadline** is counted (`stats.timeouts`), logged with the deadline and the next attempt's room, and *remembered* (`_noteTimeout`). | The next call of that lane then starts with a budget that already fits, instead of timing out on the same too-short number again. |
| Deadlines are **per lane** (action / chat) and **adaptive both ways**: they rise at once to `p90 × 1.5` of that lane's samples and decay 10 % per successful call back to the configured base. | Mixing the two lanes made chat inherit the action lane's slow p90; a factor that only grew left a recovered endpoint stuck on a 3-minute deadline. |
| The retry of a timed-out attempt gets `× 1.5` more room, up to the lane ceiling. | Waiting out a genuinely slow reasoning call beats burning all attempts on the same wall. |

Config (env / `defaults.json` `amd.*`): `AMD_API_TIMEOUT_MS` (base, 120 s),
`AMD_MAX_TIMEOUT_MS` (action ceiling, 180 s), `AMD_CHAT_TIMEOUT_MS` (base, 90 s),
`AMD_CHAT_MAX_TIMEOUT_MS` (chat ceiling, 120 s), `AMD_API_MAX_RETRIES` (2),
`AMD_CHAT_MAX_RETRIES` (1). `getStats()` publishes `timeouts`, `aborted`, and
`effectiveTimeouts: { action, chat }` so a burst is readable at a glance.

Regression tests: `08e` (cancellation is not retried / not a timeout) and `08f`
(a real timeout is remembered and stays inside its own lane).

### Vision navigation snapshots and live viewer

`vision_navigation.js` observes Mineflayer pathfinder events and retains the
upstream mutable pending path array read-only (the pinned pathfinder consumes it
in place). Snapshots copy the remaining nodes; resets, goal changes and stop
clear stale routes. `vision.js` shows the route on its procedural screenshots.
Optional `VISION_FEED_PORT` starts `visual_feed.js`, a loopback-by-default,
unauthenticated Prismarine WebGL viewer using exact-version block assets. It
streams the same predicted polyline, with a HUD. It is first-person rather than
panoramic and does not provide SkinRestorer skins. 26.3 is unsupported by the
viewer and must not be mapped to a different asset version.
