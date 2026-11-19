# ZincAI — Agent & Engineering Technical Reference

Dense, factual specification of `minecraft-harness` for AI coding agents and contributors. All symbols, schemas, paths, and invariants below match the verified runtime on branch `arena/59bacbeb-minecraft-harness`.

---

## 1. Non-Negotiable Architectural Invariants

1. **Zero behavioral modes or permission switches.** Never add persona modes (`explorer`/`builder`/`hunter`), `set_mode`, `actions.allowDig`/`allowPlace`/`allowCombat`, `dig_policy`, `equip.auto`, chat relevance filters, language guards, or trusted-player UUID lists. Model agency is unconstrained; all **44 tools** are sent with a byte-identical schema every turn.
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

## 1b. Memory Architecture

See [Memory Architecture](architecture.md#2b-memory-architecture) for the current flow and Mermaid diagram. Key implementation constraints:

- `HistoryLog` is independent evidence: use cursor continuation when coverage is incomplete, or exact `category/day.jsonl#line` refs. Sidecars are optional accelerators checked against data-file byte watermarks. Do not delete evidence during automatic curation or request compaction.
- Use `memory search` for strict filters; `MemorySystem.contextBlock` uses separate relevance-based, budgeted selection. `memory objects` queries scoped generations in `PlaceIndex`; current means loaded positive presence, never live contents. `region` boxes are estimates and routes are recorded attempts.
- `EventPipeline` persists important envelopes until the accepted action/chat context has been handled. Draft prompts must not acknowledge. Checkpointing is model-independent and credit exhaustion latches inference for the process.
- `WorkJournal` evidence locators survive compaction; result detail lives in the history file. `LearnedRules` can add narrowly scoped evidence-backed advice to user context only.
- `node scripts/audit-memory.js` replays the synthetic storage workload and verifies strict filters, history paging, scoped rules, replacement, compaction locators and SIGKILL recovery at a saved-event boundary. `test/17-memory-delivery.test.js` tests real-server runtime delivery with a local scripted model provider.

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
| `vision.js` | Native-asset software renderer for `screenshot` (`look`, `panorama`, `map`): real blockstate/model/texture, entity and equipment geometry, AO, translucent water/glass, sky/sun/clouds; first-person (no own body) or third-person (bot rendered like any player) cameras |
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
| `failgate.js`, `events.js`, `observe.js`, `filter.js`, `reflex_registry.js`, `supervisor.js`, `updater.js`, `watchdog.js` | Supporting runtime services; `events.js` now also does event batching/aggregation (§10) |
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
| | `screenshot` | `{ view: 'look'\|'panorama'\|'map', direction?, at?, perspective?: 'first'\|'third' }` |
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

## 9. Inference Timeouts & Retries (`zincai/api_wrapper.js`, `src/amdClient.js`)

The endpoint is the slowest moving part of the process, and "retryable timeout"
lines in the log are the symptom operators ask about most. The retry policy is
shared by `AmdToolsClient` (the lane client used by the bot) and `AmdClient`
(`src/amdClient.js`, used by the canary and any direct callers):

| Rule | Why |
| --- | --- |
| **What is retried**: transient network failures, client timeouts, HTTP `429`, and transient server faults `500`/`502`/`503`/`504`. | These are transient; a repeat attempt with fresh backoff commonly succeeds. |
| **What is never retried**: caller cancellation (`ZINCAI_ABORTED`), `4xx` (invalid API key `401`/`403`, malformed request `400`, unsupported model `404`/`422`), and `501 Not Implemented`. | These are permanent for this endpoint — repeating cannot fix them, and retrying an invalid key or bad request just hammers the endpoint. |
| **A successful response is never retried.** | The model already answered; repeating a completed call could execute the same tool call twice. |
| **`Retry-After` is honored.** On `429`/`503` the client waits the server's requested delay (capped to 60 s, never below 1 s) before retrying, so rate limits do not turn into request storms. Without the header, exponential backoff with jitter is used (`500 ms × 2ⁿ`, capped 8 s, + up to 250 ms jitter). | The server knows best how long to wait; a fixed short retry after `429` is a request storm. |
| **Sensible limits**: `maxRetries` attempts total (default 2, configurable 0–5 via `AMD_API_MAX_RETRIES` / `AMD_CHAT_MAX_RETRIES`); on exhaustion a clear error reports the attempt count and the last error. | Bounds worst-case latency and avoids infinite loops. |
| Backoff between retries is cancellable (lane client). | A cancelled turn dies immediately, not after its remaining retries have been slept through. |
| A **real expired deadline** is counted (`stats.timeouts`), logged with the deadline and the next attempt's room, and *remembered* (`_noteTimeout`, lane client). | The next call of that lane starts with a budget that already fits. |
| Deadlines are **per lane** (action / chat) and **adaptive both ways**: `p90 × 1.5` rise, 10 % decay per success back to base. | Mixing lanes made chat inherit the action lane's slow p90. |
| The retry of a timed-out attempt gets `× 1.5` more room, up to the lane ceiling. | Waiting out a slow reasoning call beats burning all attempts on the same wall. |
| The original request payload is rebuilt identically on every attempt; conversation context and model configuration are preserved across retries. | A retry must not silently change what the model sees. |

Config (env / `defaults.json` `amd.*`): `AMD_API_TIMEOUT_MS` (base, 120 s),
`AMD_MAX_TIMEOUT_MS` (action ceiling, 180 s), `AMD_CHAT_TIMEOUT_MS` (base, 90 s),
`AMD_CHAT_MAX_TIMEOUT_MS` (chat ceiling, 120 s), `AMD_API_MAX_RETRIES` (2),
`AMD_CHAT_MAX_RETRIES` (1). `getStats()` publishes `requests`, `failures`,
`retries`, `timeouts`, `rateWaits`, and `effectiveTimeouts: { action, chat }` so
a burst is readable at a glance.

Regression tests: `08e` (cancellation is not retried / not a timeout), `08f`
(a real timeout is remembered and stays inside its own lane),
`amd-retry` (timeouts, `429` + `Retry-After`, `5xx`, permanent errors, SSE
interruption, caller abort, no duplicate tool calls) and
`events-batching` (event batching/aggregation).

### `events.js` — Event Batching & Aggregation

`EventPipeline` is the single funnel for world/internal events (`perceive()` in
`zincai/index.js` records every event). Between two model decisions events
accumulate and are delivered **together** as one chronological `event_batch`
instead of separate notifications:

| Rule | How |
| --- | --- |
| **Collection window** | Events accumulate until the next model decision; `batchWindowMs` (default 3 s, `EVENT_BATCH_WINDOW_MS`) bounds how long they may wait. A batch is delivered once per decision, capped at `maxBatchEvents` (default 64, `EVENT_MAX_BATCH_EVENTS`); leftovers form the next consecutive batch (`moreRemaining`), so nothing is dropped. |
| **One structured batch** | `{ type: 'event_batch', event_count, first_event_at, last_event_at, windowMs, events: [...] }`. Each entry keeps its UTC `timestamp`, `elapsedMs`/`ageSec`, `severity`, `description`, `where`, `entities`, `cause`, plus `count`/`first_event_at`/`last_event_at` when repeated events are coalesced. |
| **Chronological history** | The prompt block reads "recent events (chronological batch: N over Xs, oldest Ys ago)" — a history of what happened, not a single event happening now. |
| **No duplicates** | Delivered batches are marked processed (`markProcessed`, via `model`); already-delivered events never re-enter a batch. |
| **Coalescing** | Repeated identical low-priority events (same type + summary + place) merge into one entry with a count and first/last timestamps. Distinct events are never merged. |
| **Telemetry keeps everything** | The full history stays in `events.jsonl`; only relevant recent events go to the model. |

**Priority lanes** (built on the existing `reactionClass`/`importance`):

- **Critical** (`immediate` / importance ≥ 3: death, respawn, attacked, critical health, imminent threat) — `drainCritical()` returns them immediately, bypassing the batch window; they are rendered out of band ahead of the batch and marked delivered at once.
- **Important** (`fast` / importance 2: objective interrupted/paused/failed, approaching hostile mobs, player interactions, resource changes, tool breakage) — included in the next batch, prioritized when the batch cap binds.
- **Low** (ambient item pickups/drops, routine environmental updates) — aggregated/coalesced into the batch.


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
