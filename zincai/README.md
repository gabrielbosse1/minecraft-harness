# ZincAI — tool-using Minecraft agent

ZincAI is the larger of the repository's two Java Edition harnesses. Run it
with `node zincai/index.js` or `npm run start:zincai`. It always logs in as
**`ZincAI`**. The body uses Mineflayer client packets and normal pathfinding;
it does not use RCON, server-console access, teleport commands, or cheats.

Its AMD-compatible model integration has two lanes sharing one request budget:

- **Chat lane:** a short, separate reply to a player, optionally with a task
  for the action lane and a fact to remember.
- **Action lane:** one structured function-tool call. The model chooses the
  task; local code owns controls, execution, survival reflexes, and results.

Each lane has one call in flight at a time and the two do not queue behind each
other, so a slow action call never holds a chat reply. Of the calls-per-minute
budget (`inference.rpm`, 18) a share is reserved for chat
(`inference.chatReserve`, 4).

## Safety and decision policy

### Flee first; the model decides whether to stop

`ThreatSense` sorts hostiles into three groups and counts each mob once:

- **threats** — inside the trigger ring: hostile mobs with a line on the bot
  within 12 blocks (18 for ranged mobs), reachable ordinary hostiles within 8,
  lit creepers or primed TNT in blast range, and anything that actually hurt
  ZincAI in the last 15 seconds (a player is neutral until they hit).
- **watch** — hostiles in the open further out, up to 32 blocks. They do not
  start an escape, but they are counted, A* pays to walk near them, and an
  escape is not over while they keep coming.
- **hidden** — hostiles with no line on the bot and no route to it (behind
  bars or walls, on another floor). Pets, named mobs and decor are none of these.

Entity metadata (tame flag, owner, creeper fuse, custom name) is read **by key
name** from the server's game data, so a version that reorders it cannot turn a
pet into a wild animal. A tamable animal whose state cannot be read counts as
protected.

**The escape.** The survival reflex flees without calling the model. One escape
is one *episode*: it starts when a threat is inside the trigger ring, lasts
while anything still follows inside the release ring (22 blocks) or keeps
closing, and ends after 4 seconds with nothing following (or when the model
decides). The destination comes from an escape planner
(`custom_mineflayer/escape.js`) that floods the ground the bot can walk and
compares two clocks per cell — when the bot gets there, when a mob could — so
"away" is never behind a wall, over a cliff, or through the horde:

| Plan | Meaning | What the body does |
| --- | --- | --- |
| `open` | safe ground that leads out | runs there |
| `pocket` | safe for a few seconds, but a dead end | backs into it, faces them, reports **CORNERED** |
| `chased` | nothing is safe but the ground goes on (a pursuer as fast as the bot, or already on it) | runs anyway |
| `surrounded` / `trapped` | nothing is safe; pursuers on most sides / the ground ends | breaks out by the route that touches the fewest of them, and reports it |

If A* has no route or the bot stops making ground it sprints along the first
leg of the plan — after checking there is ground to sprint on (no wall, no drop
of more than 3, no lava).

**The bot knows what its body did.** The model is woken when an escape starts
(`reflex: started FLEEING — zombie came close (6m S)`), on material changes
(a lit fuse, a new ranged or explosive kind, many more of them, health dropping
a band, cornered), every 30 seconds while it lasts, and when it ends
(`reflex: safe again — fled 19s from zombie x24, skeleton x3 (ran 66m)`). The
start and anything urgent may jump the normal 3-second spacing between calls.
Every prompt of **both** lanes carries the same facts:

```
doing: FLEEING by reflex
threats: 27 in sight — zombie x24 (nearest 5m NE), skeleton x3 (nearest 15m NE; ranged)
  pressure: 4 within 8m; closing 1.5 m/s, contact in ~4s | ways out: open SE, S, SW
  if you fight: iron_sword 6 dmg, armor 0/20, hp 20: ≈ 59s to kill them all, you would take ≈ 365 dmg → BAD
  reflex: FLEEING for 1s from zombie x24, skeleton x3 — ran 3m from 0,64,0. The body did this by itself; idle keeps it running.
  decide: idle = keep fleeing | attack = fight | go_to / follow = go there instead | hold = stop running, they are harmless or accepted
```

and for three minutes after an escape: `reflex: 40s ago you FLED by reflex for
19s from zombie x24 (ran 66m from 0,64,0); it ended because nothing followed
any more.` The fight estimate (`tactics.js`) is arithmetic on vanilla numbers
with the gear carried — good for choosing between running and fighting, not a
damage calculator.

**The model decides.** While the body flees:

- `idle` — keep fleeing;
- `attack` — explicitly fight the requested target;
- `go_to` or `follow` — go there instead;
- `hold` — stop running from the listed threats; the task in progress carries on.

A decision covers the threats that were shown, plus anything the body was
running from at that moment that had just slipped out of sight. `attack`,
`go_to`, `follow` and the short jobs stand until their task ends (with a long
safety net); a long task paused for a short job gets its decision back when it
resumes. `hold` is about the mobs, not about a task: it stands for 30 minutes
whatever the bot does next. Every decision ends early for a reason: one of the
accepted threats hurts the bot (not during a chosen fight), a lit creeper, very
low health, or a new threat. Whenever the body starts running again the model
is told — including when a decision simply ran out. There is no automatic
attack reflex and no `pvpEnabled` switch.

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
- A kill may chain to another **hostile** mob of the same requested type (up to
  six kills) without another model call. An animal is one animal per call
  unless the call gives a `count`; players are never chained. Dead entity
  objects are tombstoned so a delayed destroy packet cannot restart the fight
  against the just-killed mob.
- During a fight the controller dodges by time-to-impact, judged from measured
  motion: a mace coming down from a real fall (1.5 blocks or more, on course to
  land within reach — not a hop, not a staircase), or a body arriving faster
  than a sprint or driving a spear in, on a line that passes within 2.5 blocks
  in under 0.9 s. It watches the target and any other player who hit the bot
  recently. A creeper hit-and-run is refused when there is no ground to back
  off on, and every retreat checks for walls and drops first.

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
  bot is doing, the agenda, the threat block and the reflex line (above),
  visible players with coordinates/direction/held item, nearby mobs, scanned
  containers/places, recent chat, results, and the reason for the wake-up. The
  optional ASCII block view is included in builder mode; this is not a vision
  model.
- **Tasks and the agenda:** `go_to`, `follow` and builds are long tasks. A short
  job — `give`, `take`, `put`, `look_in`, `smelt`, `use_block`, `sleep`, a
  fight — pauses the long task and it resumes by itself afterwards (sleep
  resumes in the morning). `stop` cancels everything. The `agenda:` line shows
  a paused task, a build that a newer task set aside, and requests from chat
  that the body has not started yet.
- **Chat addressing:** names/aliases, whispers, a continuing conversation, or
  an unambiguous one-player question can wake the chat lane. There is no friend
  list. `zinc` is an alias, and nicknames built on it count ("zincão",
  "zinquinho"; "Zinco," as a call); ordinary unrelated chatter does not call
  the model.
- **Language:** the server speaks Brazilian Portuguese (`behavior.language`).
  Every outgoing line is checked by its function words. A chat reply in another
  language is retried once and then replaced by a fixed PT-BR line; an
  action-lane `say` in another language is not sent and the model is asked to
  say it again.
- **Hurt attribution:** health changes are tracked even when the server sends no
  hurt event. If the server names the damage source, it is reported. On servers
  that do not, a recent arm swing close to ZincAI can be reported as a
  *probable* attacker, not as a certainty.
- **Memory and places:** short working/episodic history, long-term JSON memory,
  preferences, conversations, and discovered/named places persist under
  `zincai-data/` by default. Set `ZINC_DATA_DIR` to a writable persistent
  directory in a hosted deployment. The memory store is local, not an external
  embedding service. What a player tells the bot is written down by the chat
  model itself (the `remember` field of `reply`) and shown again as
  `you know from <player>:` the next time that player speaks; a keyword filter
  remains as the fallback for lines nobody answered.
- **Storage rooms:** containers, work stations, beds and signs are indexed while
  walking (no cap per scan). A wall sign labels the container it hangs on, any
  other sign the nearest container, and an item frame labels a container with
  the item it shows. Double chests are recognised from their block state. A
  room with more containers than fit on one prompt line is shown as a summary
  — how many, the nearest few with ids, and every label — because a label is
  an address (`where: "Diamantes"`). `find` looks up an item, a label, or lists
  the storage in pages. `take` without `where` only goes to a container known
  to hold the item; it never guesses.
- **Movement:** `PredictiveThreatMap` adds bounded costs for predicted hostile
  positions to Mineflayer pathfinding, without making a dangerous route
  categorically impossible. Doors and gates are judged by block state
  (`custom_mineflayer/doors.js`): the bot opens wooden doors and gates of every
  wood type on its route, closes exactly the ones it opened, never touches
  trapdoors or anything it did not open, and reports a door that would not
  open instead of a bare "no path". Iron doors are walls unless they stand open.
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

The separate chat lane has one `reply(text, task, remember)` tool. `task` is
optional and is used only when the player asks ZincAI to do something in the
world; `remember` is optional and holds a fact worth keeping. Chat and action
calls share one rate limit, with a reserved share for chat. Requests ask for a
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

The automated suite uses mock bots and scripted model responses.
`test/fixes.test.js` and `test/fixes.session.test.js` are the regression tests
for the pre-release audit, named by defect id; the audit itself, the scripts
that measured each problem and the before/after numbers are in
[`../audit/`](../audit/) (`REPORT.md`, `FIXES.md`, `repro/`). The optional
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
  been live-tested. Entity metadata is now read by key name from that data, so
  the harness no longer depends on fixed positions — but the data itself
  (which key sits where on a real 26.3 server) remains an assumption, and the
  startup log says so if a key it needs is missing.
- The escape planner, the door handling, the dodge logic and the fight
  estimate were tested against a synthetic block world with the real A*, a
  simulated bot and a scripted model — not against a server. The rig has no
  jump physics and no mob AI; mobs are treated as points, so "breaking out"
  through a crowd is geometry, not a promise about hits taken. The first live
  session should watch exactly these.
- The language check knows Portuguese from English by function words. It does
  not detect other languages, and a very short English line with no function
  word in it can pass.
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
