# AGENTS.md — Working Guide for AI Coding Agents

Read [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) first for the complete module map, 39-tool catalog, `data/` telemetry schemas, runtime config keys, and real-server test harness details.

---

## Verification Commands

Run these after every non-trivial change:

```sh
npm run check                        # syntax-check all JS files in zincai/, src/, scripts/, pufferpanel/
npm test                             # run all 8 real-server simulation test suites (flying-squid 1.21.4)
AMD_API_KEY=rc-test npm run dry-run  # validate config loading, env wiring, and 39-tool schema
npm run pufferpanel:validate         # validate pufferpanel/zincai.json against PufferPanel v3 rules
```

---

## Core Invariants (Do Not Break)

1. **No behavioral modes or permission switches.** Do not add persona modes (`explorer`/`builder`/`hunter`), `set_mode`, `dig_policy`, `equip.auto`, action allowlists, chat relevance filters, language guards, or trusted-player UUID lists. All **39 tools** remain exposed identically on every action turn.
2. **Vanilla client-only boundary.** No RCON, no server plugins, no slash commands. `installVanillaGuard` blocks `/...` chat (except guarded `/msg`), and `PhysicalBoundary` gates 19 Mineflayer primitives strictly on lifecycle state (`connected`, `alive`, `!paused`) and anti-flood rate limits (`limits.maxPhysicalActionsPerMinute`).
3. **Console-only operator control.** Operator commands enter via `stdin` / `Host.command(line, from)` only — never in-game chat.
4. **Unified `data/` runtime directory.** Persist all JSON stores and session telemetry (`sessions/<id>/events.jsonl`, `sessions/<id>/continuation.json`, `latest.json`) under `ZINC_DATA_DIR` (default `./data/`). Never write runtime artifacts into `zincai/data/`.
5. **Real-server tests only.** Tests in `test/` MUST exercise real `flying-squid` 1.21.4 servers (`test/helpers/mc-server.js`) and the local OpenAI-compatible HTTP test server (`test/helpers/sim-harness.js`) — do not reintroduce fake/mocked `bot` unit tests.

---

## Critical Implementation Gotchas

- **`bot.blockAt` requires `new Vec3(x, y, z)`.** Real Mineflayer calls `point.floored()` and throws on plain `{ x, y, z }` objects. Always pass a `Vec3`.
- **Defer Mineflayer method hooks to `inject_allowed`.** Methods like `bot.chat`, `bot.dig`, and `bot.placeBlock` are attached asynchronously after `mineflayer.createBot()` returns; wrap them on `inject_allowed` (with `login` fallback) if not yet present.
- **Acquire `ControlArbiter` lanes before pathfinding.** Any pathfinder/approach helper using an arbiter lane (`hands`) must call `hands.acquire(...)` and release in `finally` or `setGoal` is ignored.
- **Block name ≠ item name.** When checking inventory or placing blocks (`redstone_engine.js`, `builder.js`), map block names (`redstone_wire → redstone`, `redstone_wall_torch → redstone_torch`, `wall_torch → torch`, `tripwire → string`).
- **`GoalRegistry` status for suspended goals is `'resumable'`.** Filter open/resumable goals by `!['completed', 'failed', 'cancelled'].includes(g.status)` and read goal text from `g.description`.
- **Do not edit `node_modules/` directly.** Minecraft 26.x protocol/data patches are applied cleanly via `npm install` (`scripts/apply-26.3-data.js` & `scripts/apply-26.3-patches.js`).
- **Keep docs lean & current.** Do not commit dated scratchpad audit reports to the repository root. Update `docs/AGENT_REFERENCE.md` and human docs alongside code changes.
