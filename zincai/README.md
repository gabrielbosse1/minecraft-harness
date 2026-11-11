# ZincAI — tool-using Minecraft agent

ZincAI is the larger of the repository's two Java Edition harnesses. Run it
with `node zincai/index.js` or `npm run start:zincai`. It always logs in as
**`ZincAI`**. The body uses Mineflayer client packets and normal pathfinding;
it does not use RCON, server-console access, teleport commands, or cheats.

Its AMD-compatible model integration has two serialized lanes sharing one
request budget:

- **Chat lane:** a short, separate reply to a player, optionally with a task
  for the action lane.
- **Action lane:** one structured function-tool call. The model chooses the
  task; local code owns controls, execution, survival reflexes, and results.

## Safety and decision policy

### Flee first; the model decides whether to stop

`ThreatSense` distinguishes active dangers from nearby scenery. By default it
tracks hostile mobs with line of sight within 12 blocks (18 for ranged mobs),
reachable ordinary hostiles within 8 blocks, lit creepers or primed TNT within
8 blocks, and entities that actually hurt ZincAI recently. A player is neutral
unless they hit the bot; that player remains a remembered threat for 15 seconds
(up to 24 blocks). Pets, named mobs, decor, and mobs that are neither visible
nor reachable are not active threats.

The survival reflex flees without calling the model. It uses a threat-aware
path when possible and a direct sprint/jump fallback when it cannot find a
route or make progress. It stops after the live danger has been gone for a
short settling period. A `fleeing from …` event wakes the model, which then
chooses what happens next:

- `idle` — keep fleeing;
- `attack` — explicitly fight the requested target;
- `go_to` or `follow` — take a different route/task;
- `hold` — accept the listed danger and stand its ground.

A new threat, a lit creeper, or very low health can restart fleeing. Decisions
are attached only to the threat IDs/types shown in the prompt, with a bounded
lifetime. There is no automatic attack reflex and no `pvpEnabled` switch.

### Targeting rules

- A mob attack must name its exact type (or `any`, meaning a hostile mob only).
  The target must be visible; pets, named mobs, villagers, golems, and other
  protected entities are refused. The fight engine handles weapon selection,
  reach, cooldowns, approach, and stopping on death/loss.
- PvP requires the action tool's `player` field to exactly name one visible
  player. `attack: "player"` and `attack: "any"` never match a player. If a
  named player is not visible, the model is told to `go_to` them first.
- A hit by a player triggers fleeing and a wake-up; the reflex never retaliates.
  The model is instructed to require an explicit duel request or continued
  aggression before it chooses that exact player. The harness enforces exact
  name selection, not a separate server-side consent/duel protocol.
- A kill may chain to another mob of the same requested type (up to six kills)
  without another model call; players are never chained. Dead entity objects
  are tombstoned so a delayed destroy packet cannot restart the fight against
  the just-killed mob.

### One owner for the controls

`zincai/control.js` provides a `ControlArbiter` with fixed priorities:

```
survival > combat > task > idle
```

Each lane owns its controls and pathfinder goal. A higher-priority flee can
preempt a walk or fight; when it releases, a still-valid lower-priority task
can resume. Main-hand use is serialized so eating or equipping does not fight
combat over the same slot. Death, reconnect, task replacement, and shutdown
release controls.

## Perception, memory, and execution

- **Action prompt:** current HP/food/position/time/mode, inventory, what the
  bot is doing, threats, visible players with coordinates/direction/held item,
  nearby mobs, scanned containers/places, recent chat, results, and the reason
  for the wake-up. The optional ASCII block view is included in builder mode;
  this is not a vision model.
- **Chat addressing:** names/aliases, whispers, a continuing conversation, or
  an unambiguous one-player question can wake the chat lane. There is no friend
  list. `zinc` is an alias; ordinary unrelated chatter does not call the model.
- **Hurt attribution:** health changes are tracked even when the server sends no
  hurt event. If the server names the damage source, it is reported. On servers
  that do not, a recent arm swing close to ZincAI can be reported as a
  *probable* attacker, not as a certainty.
- **Memory and places:** short working/episodic history, long-term JSON memory,
  preferences, and discovered/named places persist under `zincai-data/` by
  default. Set `ZINC_DATA_DIR` to a writable persistent directory in a hosted
  deployment. The memory store is local, not an external embedding service.
- **Movement:** `PredictiveThreatMap` adds bounded costs for predicted hostile
  positions to Mineflayer pathfinding, without making a dangerous route
  categorically impossible. A* flee plans are recalculated; a straight
  sprint/jump fallback is used if a safe route cannot be maintained.
- **Building:** the action tools can build a saved blueprint, an inline grid,
  or generated shapes. Building is inventory-checked, staged
  (foundation → walls/windows → roof → details), and idempotent where the
  target block is already present. `set_mode` supports `explorer`, `hunter`,
  and `builder`. Pathfinding does not mine blocks by default.
- **Survival:** the body eats from a food whitelist, uses a water bucket only
  for a fall that warrants a clutch (default threshold 5 blocks), swims when
  submerged, and can deploy an elytra through Mineflayer's `bot.elytraFly()`
  when enabled and properly equipped. Without an elytra, deployment returns
  `no_elytra`; there is no pretend glide.
- **Vanilla guard:** slash-command chat is blocked. The one private-message
  exception is generated by the guard itself as `/msg <online-player> …` when
  the model asks for a whisper. A server/plugin must actually implement `/msg`.

## Action and chat tools

The current action tool list is:

`say`, `go_to`, `follow`, `stop`, `attack`, `hold`, `look_in`, `take`, `put`,
`smelt`, `sleep`, `give`, `eat`, `equip`, `use_block`, `find`, `remember_here`,
`craft`, `build`, `build_shape`, `run_script`, `set_mode`, `idle`.

The separate chat lane has one `reply(text, task)` tool. `task` is optional and
is used only when the player asks ZincAI to do something in the world. Chat and
action calls share the same serialized client/rate limit. Requests ask for a
tool call with `tool_choice: "required"`; if an OpenAI-compatible endpoint
rejects `required`, the client falls back to `"auto"`. If the endpoint ignores
tools and returns the legacy JSON action as text, a compatibility parser is
available. Neither path has been verified against AMD's live endpoint in this
sandbox.

Tool schemas and their argument descriptions are the source of truth in
[`api_wrapper.js`](api_wrapper.js); the action policy is in
[`system_prompt.txt`](system_prompt.txt) and the chat voice in
[`chat_prompt.txt`](chat_prompt.txt).

## Configuration and operation

Configuration is in [`config.json`](config.json), with environment overrides:

| Variable | Meaning |
| --- | --- |
| `MC_HOST`, `MC_PORT` | Minecraft server address. |
| `MC_VERSION` | Explicit protocol version; empty means auto-detect. |
| `MC_AUTH` | `offline` or `microsoft`, as supported by the deployment. |
| `AMD_API_KEY`, `API_KEY`, `RADEON_API_KEY` | API key; environment variables take precedence over the config value. |
| `AMD_API_BASE_URL` | OpenAI-compatible API base URL. |
| `AMD_MODEL` | Model name/alias accepted by the configured endpoint. |
| `ZINC_DATA_DIR` | Writable data directory for memory, preferences, and places. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. |

The login name is hard-coded to `ZincAI`; `MC_USERNAME` does not rename it.
The first join failure is fatal. Once it has spawned, a dropped connection or
server restart is retried under the same name with backoff (see
`reconnect` in `config.json`). A whitelist/ban rejection is not retried.

Useful commands:

```sh
npm ci
node zincai/index.js --check      # load modules and check vendored 26.3 data
API_KEY=rc-dummy node zincai/index.js --dry-run
npm run start:zincai
```

For Pufferpanel or another process manager, inject the key as a secret
environment variable, choose a persistent `ZINC_DATA_DIR`, and run
`npm run start:zincai`. Do not put a real key in `config.json` or `.env` in
Git.

## Testing

```sh
npm test
npm run check
node zincai/index.js --check
```

The automated suite uses mock bots and scripted model responses. The optional
real-protocol loopback rig is in [`../test/e2e/`](../test/e2e/): after
installing that directory's `flying-squid` dependency, run
`node loopback.js --only=zincai` there. It runs the actual ZincAI process,
Mineflayer players, and local mock model against a local Minecraft 1.16.5
server. The model is not AMD, and flying-squid's mobs do not provide normal
hostile AI. The runner header records the exact checks and known limitations.

## Known limits / unverified assumptions

- Neither the AMD live endpoint nor `tool_choice: "required"` has been tested
  from this environment. Its fallback to `"auto"` is implemented, not an
  assertion that AMD accepts either payload.
- The Java 26.3 data is vendored from an unmerged upstream series and has not
  been live-tested. In particular, the entity-metadata indices used for
  custom names, creeper fuse/ignition, and tame flags remain assumptions.
- Shield behavior through `activateItem(true)`, water-bucket placement on a
  real server, `/msg` support, and sign-text APIs need server-side/live
  verification.
- The optional loopback cannot validate hostile mob AI, production physics,
  Minecraft 26.3, the real AMD service, or a production whitelist.
- Skills `follow`, `put`, `smelt`, `sleep`, and `use_block` have not all been
  exercised against a real server. The code's unit/session tests are not a
  substitute for those live checks.
- Structure perception is a local heuristic, not a full-world oracle; the
  builder-mode ASCII grid is a simple voxel slice, not pixels seen by a
  multimodal model.

The root [`README.md`](../README.md) covers both Zinc and ZincAI.
