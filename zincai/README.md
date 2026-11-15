# `zincai/` Runtime Guide

`zincai/` contains the ZincAI Minecraft Java agent runtime. Run it directly with `node zincai/index.js` (`npm start`), or validate configuration without connecting using `node zincai/index.js --dry-run` (`npm run dry-run`).

---

## Entrypoint & CLI Flags

- `node zincai/index.js` — Launches under `supervisor.js` (unless `ZINCAI_NO_SUPERVISOR=1`) and boots `Host` + `ConnectionManager`.
- `node zincai/index.js --dry-run` — Loads defaults, env overrides, and `RuntimeConfig`; validates API key and tool schema; prints summary and exits `0`.
- `node zincai/index.js --check` — Runs quick module/config sanity checks and exits.

---

## Module Map

### Core Orchestration & Lifecycle
| Module | Responsibility |
| --- | --- |
| `index.js` | Main entrypoint, `makeShared`, `startSession`, tool dispatch, event wiring, continuation builder |
| `host.js` | Process-lifetime host (`boot`, `command`, `dispatch`, `pause`, `resume`, `leave`, `join`, `stop`) |
| `connection.js` | Reconnection state machine (`DISCONNECTED`/`CONNECTING`/`CONNECTED`/`DISCONNECTING`/`RECONNECTING`) with exponential backoff |
| `supervisor.js` | Worker supervision, restart codes, and clean shutdown propagation |
| `updater.js` | Console-triggered `update [check|force]` git pull & restart support |
| `control_commands.js` | Parser & help text for the 15 console-only operator commands |
| `runtime_config.js` | Validated store for the 10 live operator parameters (`data/runtime-config.json`) |
| `protocol_keepalive.js` | Exact server keep-alive echoing + silent-link liveness timeout |
| `watchdog.js` | Event-loop stall and stuck-session watchdog |

### Safety & Body Control
| Module | Responsibility |
| --- | --- |
| `boundary.js` | `PhysicalBoundary` + `installPhysicalGuard` gating 19 Mineflayer primitives behind lifecycle state & anti-flood limits |
| `vanilla_guard.js` | `installVanillaGuard` blocking `/...` slash commands on `bot.chat` (except guarded `/msg` whispers) |
| `control.js` | `ControlArbiter` priority lanes (`survival` > `combat` > `task` > `idle`) |
| `system1.js` | Local survival reflexes (threat flee, contact hazard escape, eat, water clutch, elytra, swim) |
| `threats.js` | `ThreatSense` & `HurtTracker` (hostile/watch/hidden rings, reachability checks, protected entities) |
| `tactics.js` | Vanilla melee/armor fight estimator shown to the model during threats |
| `armor.js` | Automatic armor upgrade equipping with manual slot hold overrides |
| `death_recovery.js` | Death tracking, respawn delay, and post-respawn inventory/position observation |
| `failgate.js` | Repeated tool-failure detection to prevent infinite failing retry loops |

### Model, Prompts & Lanes
| Module | Responsibility |
| --- | --- |
| `api_wrapper.js` | OpenAI-compatible tool definitions (39 tools), request/response normalization, reasoning extraction |
| `brain.js` | Action-lane agent loop, wake scheduling, `situationVersion` staleness checks, tool-result feedback |
| `lanes.js` | Two-lane scheduler (`chat` + `action`) sharing one RPM budget with reserved chat capacity |
| `irc.js` | Unified chronological IRC-style timeline of chat, whispers, and world events |
| `filter.js` | Chat sanitization & message formatting helpers |
| `system_prompt.txt` | Action-lane system prompt |
| `chat_prompt.txt` | Chat-lane system prompt |

### Perception, World & Action Execution
| Module | Responsibility |
| --- | --- |
| `perception.js` | Grounded prompt snapshot of position, health, inventory, surroundings, entities, and places |
| `observe.js` | Real-time world observation & delta summaries |
| `events.js` | World event bus translating Mineflayer events into structured timeline/telemetry events |
| `vision.js` | Software renderer producing `look`, `panorama`, and `map` images for `screenshot` |
| `places.js` | Remembered coordinates and discovered containers/workstations (`data/places.json`) |
| `block_search.js` | Fast chunk-indexed block search |
| `block_inspect.js` / `region_inspect.js` | Grounded single-block and paginated region block-state inspection |
| `skills.js` | High-level skills: `gather` (any diggable block), `craft`, `smelt`, `sleep`, containers, `light_up`, `shelter`, `corpse_run` |
| `builder.js` | Grid blueprints (`build`) & parametric shapes (`build_shape`) with block-state verification |
| `reflex_registry.js` | Local reusable scripts invoked via `run_script` |
| `custom_mineflayer/pathfinder_wrapper.js` | Threat-aware pathfinding wrapper |
| `custom_mineflayer/escape.js` | Node-bounded BFS escape planner |
| `custom_mineflayer/doors.js` | Door/gate/trapdoor walkability & interaction helpers |

### Redstone & Logic Engineering
| Module | Responsibility |
| --- | --- |
| `redstone_inspect.js` | Honest static snapshot capture (`redstone_scan`, `redstone_component`) |
| `redstone_engine.js` | Circuit analysis, fault diagnosis, design catalog, inventory-mapped placement, and live `verify` |
| `logic_test.js` | Abstract Boolean combinational logic truth-table evaluator |
| `circuit_projects.js` | Persistent redstone/logic project store (`data/circuit_projects.json`) |

### Memory, Continuity & Telemetry
| Module | Responsibility |
| --- | --- |
| `goals.js` | Persistent goal registry with lifecycle transitions & reconciliation (`data/goals.json`) |
| `memory.js` | Working, short-term, and long-term episodic/procedural memory (`data/memories.json`) |
| `continuity.js` | Player relationship models, evidence history, and self-notes (`data/continuity.json`) |
| `journal.js` | Multi-step plans and continuation digests (`data/journal.json`) |
| `telemetry.js` | `TelemetryRecorder` writing `data/sessions/<id>/events.jsonl`, `continuation.json`, and `data/latest.json` |

---

## Tool Surface (39 Tools)

All 39 tools are always registered on every action turn:

- **Movement & Navigation:** `go_to`, `follow`, `stop`, `dig`, `corpse_run`
- **Gathering, Crafting & Storage:** `gather`, `craft`, `smelt`, `look_in`, `take`, `put`, `give`
- **Building & Utility:** `build`, `build_shape`, `light_up`, `shelter`, `use_block`, `sleep`, `eat`, `equip`, `run_script`
- **Combat & Survival Decisions:** `attack`, `hold`
- **Perception & Inspection:** `inspect_block`, `inspect_region`, `find`, `remember_here`, `screenshot`
- **Redstone & Logic:** `redstone_scan`, `redstone_component`, `redstone_engineer`, `logic_test`, `circuit_project`
- **Social, Memory & Goals:** `say`, `goal`, `note`, `recall`, `social`, `idle`

---

## Runtime Config Keys (`config show` / `config set`)

Only infrastructure and pacing parameters are exposed at runtime:

- `limits.maxConcurrentJobs` (default `4`)
- `limits.maxPhysicalActionsPerMinute` (default `600`, `0` = unlimited)
- `limits.maxGoalRuntimeMinutes` (default `0`, `0` = off)
- `connection.minRetryDelayMs` (`5000`), `connection.retryDelayMs` (`5000`), `connection.maxRetryDelayMs` (`120000`), `connection.maxRetries` (`40`)
- `death.respawnDelayMs` (`1500`)
- `control.allowConsole` (`true`), `control.auditLog` (`true`)

### Visual feed and navigation

Set `VISION_FEED_PORT=3000` to enable an optional live, first-person WebGL
viewer at `http://127.0.0.1:3000/`. It streams loaded chunks, block updates,
entities, position and the pathfinder's remaining steps, with an F3-style bot
HUD. The cyan line bends through the actual planned steps (not the travelled
trail); yellow marks the next step and red the destination. It is a polyline,
not a smoothed prediction: smoothing could falsely imply a route through blocks.
The line is redrawn as steps are consumed and cleared on reset or goal change.
Progress is consumed/total steps in the latest path calculation, not an ETA.

**Security:** the viewer has no authentication and exposes world and bot state.
It binds to loopback by default. Set `VISION_FEED_HOST=0.0.0.0` only on a
trusted network or behind an authenticated access-controlled proxy.

The live viewer uses Prismarine Viewer's bundled Minecraft block models and
textures and currently requires an exact supported version: 1.8.8, 1.9.4,
1.10.2, 1.11.2, 1.12.2, 1.13.2, 1.14.4, 1.15.2, 1.16.1, 1.16.4, 1.17.1,
1.18.1, 1.19, 1.20.1, 1.21.1 or 1.21.4. In particular, 26.3 is unsupported;
the viewer logs a warning rather than interpreting state IDs using the wrong
version. The viewer is first-person, not panoramic; its entity rendering,
lighting and animations are not a full Minecraft client. Nearby labels are not
visibility-tested. Player skins and SkinRestorer integration are not implemented.

The agent's `screenshot` tool remains an **on-demand procedural renderer**, with
a panorama, map, HUD, and depth-tested route overlay; it does not use the live
viewer or vanilla assets. Neither renderer should be treated as authoritative
for precise visibility or appearance. Mineflayer receives player profile skin
properties from the server, but neither renderer consumes them yet.
