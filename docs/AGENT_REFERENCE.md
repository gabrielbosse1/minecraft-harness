# ZincAI — Agent & Engineering Technical Reference

Dense, factual specification of `minecraft-harness` for AI coding agents and contributors. All symbols, schemas, paths, and invariants below match the verified runtime on branch `arena/59bacbeb-minecraft-harness`.

---

## 1. Non-Negotiable Architectural Invariants

1. **Zero behavioral modes or permission switches.** Never add persona modes (`explorer`/`builder`/`hunter`), `set_mode`, `actions.allowDig`/`allowPlace`/`allowCombat`, `dig_policy`, `equip.auto`, chat relevance filters, language guards, or trusted-player UUID lists. Model agency is unconstrained; all **39 tools** are sent with a byte-identical schema every turn.
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
| `index.js` | Entrypoint, `loadConfig`, `makeShared`, `createHost`, `startSession`, 39-tool switch, `buildLiveContinuation` |
| `api_wrapper.js` | `AmdToolsClient`, `ACTION_TOOLS` (39), `createRecoveryTools`, `extractReasoning`, `coerceActions`, `buildToolsPayload` |
| `context_budget.js` | `ContextBudget`, `resolveModelLimits`, `/models` discovery, HTTP 400 limit learning, proactive/reactive compaction, `trimIncompleteSentence` |
| `brain.js` | `Brain` — multi-step action loop (`maxStepsPerTurn: 6`), `wake(reason, opts)`, `situationVersion` staleness guard |
| `lanes.js` | `LaneScheduler` — concurrent `chat` + `action` lanes sharing `rpm` (18) with `chatReserve` (4) |
| `irc.js` | `IrcTimeline` — unified chronological log of chat, whispers, and world events |
| `system1.js` | `System1` — 200ms survival reflex tick (threat flee, contact hazard lookahead/exit, eat, water clutch, elytra, swim) |
| `threats.js` | `ThreatSense` (trigger 12m / ranged 18m / close 8m / watch 32m), `HurtTracker`, `isProtected`, `isHostileMob` |
| `tactics.js` | Vanilla melee/armor fight estimator injected into prompts during threats |
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
| `memory.js` | `MemoryStore` (working, short-term, episodic/procedural; `data/memories.json`) |
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
- `src/combat.js` — `AdvancedCombat` (weapon selection, crit timing, sprint-reset, reach, chain kills, `explicitPlayersOnly`).
- `src/recipes.js` — Crafting tree solver over `prismarine-recipe`.
- `src/logger.js`, `src/reasonToText.js`, `src/reconnect.js`, `src/settings.js` — Shared utilities.
- `scripts/apply-26.3-data.js` & `scripts/apply-26.3-patches.js` — Run automatically on `npm install` (`postinstall`) to add Minecraft 26.x protocol/registry compatibility to `node_modules/`.
- `scripts/ping-server.js` (`npm run ping`) & `scripts/amd-canary.js` (`npm run canary`) — Live connectivity probes.
- `pufferpanel/zincai.json`, `import.js`, `doctor.js` — PufferPanel v3 template (19 variables, 6 install steps).

---

## 4. Action Tool Catalog (39 Tools, `zincai/api_wrapper.js`)

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
| | `note` | `{ text, interest?, tags? }` |
| | `recall` | `{ query, limit? }` |
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

---

## 7. Real-Server Simulation Testing (`test/`)

All tests run against **real local Minecraft 1.21.4 servers (`flying-squid@^1.12.0`)** over localhost TCP sockets and a local OpenAI-compatible HTTP server (`test/helpers/sim-harness.js`). No mocked `bot` objects.

### Commands
```sh
npm run check                # syntax check every JS module
npm test                     # node --test test/*.test.js (all 9 suites, 18 end-to-end tests)
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
