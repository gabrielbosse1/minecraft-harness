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
  eat < 18 hunger, dodge at < 2m,     planning, chat, remote movement,
  doors/trapdoors, fall bucket,       building blueprints, crafting,
  anti-stuck (5 Hz tick)              attack decisions — only when needed
        │                                      ▲
        └────── heuristic pre-filter ──────────┘
   (chat must mention "ZincAI", be a question, or come from a tracked friend;
    block events > 20 blocks away are dropped; spam costs zero tokens)
```

- **Perception is frustum-culled** (`zincai/perception.js`): entities and
  blocks are only visible inside the FOV cone; the local area is compressed to
  a palette + run-length voxel grid relative to the bot (~100–300 tokens).
- **Memory is 3-tier** (`zincai/memory.js`): Working (5 events) → Short-term
  (10-minute rolling buffer) → Long-term JSON store (`zincai-data/memories.json`,
  gitignored) retrieved by bag-of-words cosine × importance. Only the **top 3**
  memories are ever injected into a System-2 prompt.
- **Building** (`zincai/builder.js`): `BlueprintParser` loads local blueprints
  (`zincai/blueprints/*.json`) or an inline grid from the LLM, pre-flights the
  inventory, sequences bottom-to-top, towers up with jump-place pillars when a
  layer exceeds jump reach (`build.reach`, default 4.5), and verifies every
  placed block with a retry budget. Voyager/MineDojo-style: code executes,
  the model decides.
- **Custom pathfinding** (`zincai/custom_mineflayer/pathfinder_wrapper.js`):
  never touches `node_modules`. Doors/trapdoors are registered as upstream
  `useOne` steps (open → pass → close), routed with a configurable door cost
  (default 4 — the bot prefers going around), **never broken**; `allowDigging:false`
  makes every block unbreakable (`canDig=false` + prototype-level `safeToBreak`
  guard); ±2° yaw/pitch micro-jitter, variable sprint/walk cycles (sprint is
  never the default), forced walk near edges/air/lava, 200–800 ms idle pauses
  on abrupt heading changes. `npm update mineflayer` keeps working.
- **LLM contract** (`zincai/system_prompt.txt`): single-line JSON only, no
  markdown. Schema: `say | move | build | craft | attack | equip | idle`.

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

Loopback e2e (flying-squid + mocked AMD) passes 6/6 from this environment —
see `.e2e-scratch/` in the branch working tree (gitignored; recreate with
`npm run e2e:zincai` style wiring or from the session notes).

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
  the skip list is logged and fed back to the model.
- FOV perception is a cone approximation, not true line-of-sight raycasts.
  Dense forests will look "full" to the model; that's the intended trade-off.
- 26.3 support = vendored unmerged PR data (see VENDORED.md). Auto-detect
  (`version: ""`) is the safe setting.
