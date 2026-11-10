# ZincAI — dual-process Minecraft AI harness

Production harness for a **private whitelist Java server**, engineered for
**Pufferpanel** deployments, the **AMD Radeon Cloud Token Factory** (ROCm /
local inference endpoint), and tuned for **Qwen 3.8 27B** (Token Factory alias
`Qwen3.8-Flash-Next`, swappable via `AMD_MODEL`).

> **Identity rule:** the bot always joins as **`ZincAI`**. Any whitelist or
> login rejection aborts the process (exit 1). No retries, no renames — same
> class of rule the repo has always used; note this supersedes the old
> `Zinc` name for this harness.

## Architecture

```
system 1 (Node.js, NO LLM)          system 2 (Qwen via AMD API)
  reflex registry, not hardcoded:     planning, chat, remote movement,
  eat < 18 hunger, back-jump from     building, crafting, mode switches —
  hostiles < 2m, water bucket,        only when the pre-filter lets it through
  flee (hostile within 8 m),          (chat mentions "ZincAI" / question / friend;
  door/trapdoor, fall bucket,         block events > 20 blocks away dropped;
  anti-stuck watchdog, 200 ms tick    spam costs zero tokens)
        │                                      ▲
        └──────── heuristic pre-filter ────────┘
  reflexes escalate to System 2 only via call_system2 reflexes — System 1
  itself never calls the LLM

  (opt-in: instant PvP reflex, auto-elytra on big falls)
```

- **Native tool calling** (`zincai/api_wrapper.js`): the System-2 action
  contract is an OpenAI-compatible `tools` array — `say, move, build,
  build_shape, run_script, set_mode, craft, attack, equip, idle` with full
  JSON schemas — sent with `tool_choice: "auto"` and
  `parallel_tool_calls: false`. Qwen answers with `tool_calls`, not
  syntax-error-prone raw JSON. If the endpoint ever ignores `tools`, a
  tolerant fallback parses the legacy single-line JSON shape and counts it
  (`jsonFallbacks` in the session stats) — the bot degrades, it does not die.

- **Perception is three-layer** (`zincai/perception.js`): (1) frustum-culled
  voxel palette + run-length grid, **plus a 2D ASCII "vision" block** —
  top-down grid always, cross-section in builder mode; (2) **semantic
  clustering** — hostile mobs > 15 → `clutter: N mobs (zombie x12, …)`
  summary + avoid zone (never enumerated individually; the nearest threat
  rides in the summary), > 10 chests → storage zone, players tagged with
  distance; (3) **structure inference** — walls + roof/door →
  `structures: house (…)` (conservative; walls alone never match).
  Clutter clusters surface as avoid-zones in the delta. Mineflayer-pathfinder
  has no region-cost API (patching its A* is off-limits), so mob-dense avoidance
  is delivered via the flee reflex and tactical prompting, not cost weighting.
  A 3D voxel grid can be enabled with `perception3D: true`.
- **Memory is 3-tier + ephemeral** (`zincai/memory.js`): Working (5 events) →
  10-minute Short-term → Long-term JSON store (`zincai-data/memories.json`,
  gitignored) retrieved by cosine × importance (top 3 injected). On top of
  that: a **30 s ephemeral action buffer** ("placed 3 dirt blocks") injected as
  a rolling tail, **grep-first recall** for queries like "remember when we
  built the castle?" (token grep over the long-term store, substring fallback
  to cosine), and **implicit preference tracking**
  (`zincai-data/preferences.json`) that auto-learns what the user likes
  (e.g. "gothic style", "stone bricks") and subtly biases future builds/chat.
- **Building** (`zincai/builder.js`): the LLM **never places blocks one by
  one** for anything bigger than decoration — it names a primitive and the
  harness computes coordinates. `generateShape()` emits cylinder, dome, arch
  (apex == h), wall, box, floor, ring. `BlueprintParser` loads local
  blueprints, inline 3-D arrays, or 2-D slices with an `at` origin,
  pre-flights the inventory, sequences bottom-to-top, and towers up with
  jump-place pillars when a layer exceeds jump reach. Every placement is
  confirmed against the world state (packet acks are unreliable — a block is
  accepted as placed only when `blockAt` shows the target block). Hierarchical
  decomposition is enforced in the prompt: foundation → walls → roof →
  detailing, planned before the first block. Voyager/MineDojo-style: code
  executes, the model decides.
- **Custom pathfinding** (`zincai/custom_mineflayer/pathfinder_wrapper.js`):
  never touches `node_modules`. Doors/trapdoors are registered as upstream
  `useOne` steps (open → pass → close), routed with a configurable door cost
  (default 4 — the bot prefers going around), **never broken**; `allowDigging:false`
  makes every block unbreakable (`canDig=false` + prototype-level `safeToBreak`
  guard); ±2° yaw/pitch micro-jitter, variable sprint/walk cycles (sprint is
  never the default), forced walk near edges/air/lava, 200–800 ms idle pauses
  on abrupt heading changes. `npm update mineflayer` keeps working.
- **Scaffold auto-remove** (`zincai/builder.js`): blocks the executor itself
  places via jump-place towers are tracked and dug back out top-down after a
  build (`build.autoRemoveScaffold: true` by default). Pre-existing world is
  never touched; blocks replaced mid-cleanup are left alone.
- **Reflex engine** (`zincai/reflex_registry.js` + `zincai/system1.js`):
  System 1 is a registry, not a hardcoded if-chain — `register_reflex({trigger,
  action, script?})` with cooldowns; built-ins cover eat/dodge/water-bucket,
  hostile flee (1.5–8 m → pathfind away + sprint, skipped in builder mode) and
  door/trapdoor handling. Scripts live in `zincai/scripts/` (`flee.js`,
  `build_tower.js`) and can be invoked from System 2 via
  `{"a":"run_script","name":"build_tower"}`. Complex unhandled events escalate
  to System 2 via `call_system2` reflexes.
- **Instant PvP (opt-in)**: `behavior.pvpEnabled: true` (default **false** —
  this harness runs on a private whitelist) + `mineflayer-pvp` — a `player_near`
  reflex hands the fight to System 1 with zero LLM tokens: best-sword equip,
  jump-crit/strafe loop, auto-disengage below 6 HP, System 2 notified on fight
  end (won / disengaged / losing). `behavior.autoElytra: true` deploys a carried
  elytra on falls > 4 blocks.
- **Modes** (`{"a":"set_mode","mode":"builder|hunter|explorer"}`): explorer
  defaults (sprint allowed), hunter (auto-sprint + jump-while-running for
  gaps), builder (never drops more than 1 block).
- **LLM contract** (`zincai/system_prompt.txt`): persona + strategy only
  (~350 words, no JSON grammar). The action contract lives in tool schemas:
  `say | move | build | build_shape | run_script | set_mode | craft | attack |
  equip | idle`.

## Pufferpanel deployment

1. Create a **Node.js** server (Node ≥ 18), point it at this repo.
2. Install: `npm ci` (postinstall applies the Java **26.3** data patch — see
   `vendor/minecraft-data-26.3/VENDORED.md`; the unofficial-data caveats there
   apply here too).
3. Secrets: set `AMD_API_KEY` (or reuse the repo's `API_KEY` via
   `require('dotenv').config()` fallback) as a Pufferpanel **secret variable**.
   Do **not** commit real keys; `amd.apiKey` in `config.json` is empty by default.
4. Edit `zincai/config.json` (or env vars — env wins): `server.host/port`,
   `amd.model` (default `Qwen3.8-Flash-Next`), `behavior.friends` (tracked chat
   partners), `behavior.allowDigging` (`false` = no block chewing).
5. Whitelist **`ZincAI`** on the server (offline-mode name or Microsoft account
   matching `server.auth`).
6. Start command: `npm run start:zincai` (or `node zincai/index.js`).
   Stop: send SIGTERM — the bot saves memory, quits cleanly, prints the AMD
   session summary (calls, avg prompt tokens, kv-hit-rate).

## Verify before going live

```bash
node zincai/index.js --check     # modules + 26.3 data present
node zincai/index.js --dry-run   # config + prompt validation, zero network
npm run ping                     # server reachable? which version? (shared script)
```

Loopback e2e (flying-squid + mocked AMD) passes 6/6 — see `.e2e-scratch/` in
the branch working tree (gitignored, not committed):

- `zincai-e2e.js` — full boot against flying-squid 1.21.4, mocked AMD endpoint;
  checks spawn, heuristic filter, AMD call + in-game reply, spam immunity,
  stats on shutdown, memory persistence.
- `build-e2e.js` — builder pipeline against loopback 1.16.5 (the 1.21.4
  flying-squid↔mineflayer packet stream is lossy, which corrupts client-side
  physics; the harness placement logic itself is version-agnostic). Checks
  wall placement (2×2 on solid ground), a one-block pillar tower (dirt consumed,
  in-world block verified), and tracked scaffold cleanup (dug back out, zero
  blocks left in world). ZincAI's full staircase jump-place is covered by the
  same code path and must be verified live (`npm run start:zincai` on the
  production host) — the loopback cannot deterministically validate the second
  pillar step.

## Extending

- **New blueprint:** drop `zincai/blueprints/<name>.json`
  (`palette` + `grid` layers, bottom-to-top, `.` = air). The LLM then builds it
  with `{"a":"build","blueprint":"<name>"}`.
- **Real embeddings:** swap `LongTermMemory`'s `embed()/cosine()` for an
  embedding endpoint call — nothing else changes.
- **Friend tracking:** `behavior.friends: ["Steve"]` or teach
  `MemorySystem` to promote chat contacts to friends after N interactions.

## Known limits / honesty corner

- Building is pragmatic, not pixel-perfect: jump-pillar towers, place against
  any adjacent face, retries with backoff. Complex interiors may skip blocks —
  the skip list is logged and fed back to the model. A block whose six
  neighbours are ALL air cannot be placed (no face to attach to); the executor
  says so in its debug log.
- The 30 s ephemeral buffer is working memory, not truth — expect the model to
  reference actions it just took without claiming deeper knowledge.
- PvP defaults OFF. On a whitelist with friends, flipping `pvpEnabled` makes
  the bot fight any player on sight — opt in deliberately.
- Structure inference is conservative (walls + roof/door) and will miss exotic
  builds; it is a hint for the model, not a game-state oracle.
- mob clutter > 15 entities is summarized, never enumerated; the nearest mob
  rides in the summary line.
- Implicit preferences are a bias, not a lock — the user can always override.
- FOV perception is a cone approximation, not true line-of-sight raycasts.
  Dense forests will look "full" to the model; that's the intended trade-off.
- 26.3 support = vendored unmerged PR data (see VENDORED.md). Auto-detect
  (`version: ""`) is the safe setting.
