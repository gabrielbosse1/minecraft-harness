# ZincAI — tool-using Minecraft agent

ZincAI is the repository's Java Edition agent. Run it with
`node zincai/index.js` or `npm start`. It always logs in as
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
| `pocket` | safe for a few seconds, but walled in: a dead end | backs into it, faces them, reports **CORNERED** |
| `chased` | the ground goes on, but nothing far is safe (a pursuer as fast as the bot, or already on it) | runs anyway |
| `surrounded` / `trapped` | nothing is safe; pursuers on most sides / the ground ends | breaks out by the route that touches the fewest of them, and reports it |

Only walls make a pocket. If the edge of the search can be reached without
coming closer to any pursuer than the bot already is, the plan is `chased`
even when a few cells beside the bot are still safe — a player who keeps up on
an open field is not a dead end.

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
  The model decides whether to choose that player; the harness enforces exact
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

### Objectives that survive interruptions

`goals.js` is a small durable registry behind whatever the bot is doing. Every
long task (`build`, `build_shape`, `gather`, `go_to`, `follow`, `light_up`,
`shelter`, `corpse_run`) and every short job (`give`, `take`, `put`, `smelt`,
`sleep`, `look_in`, `use_block`, `craft`) gets a record with an id (`g7`), an
origin (`player:Gabriel` or `self`), a priority, a completion/failure/resume
description, and a checkpoint in `detail` — a build's resolved origin and
stage, a gather's item and count, a job's arguments.

Statuses are `pending`, `active`, `suspended`, `resumable`, `completed`,
`failed`, `cancelled`, and every change goes through one transition table;
illegal transitions are refused with a reason. Terminal states stay terminal,
but `completed` is reachable from every open state because verification can
prove an interrupted objective already done.

What happens when the work is interrupted:

| Event | The objective becomes |
| --- | --- |
| a newer main task starts | `suspended` + on the agenda shelf ("set aside") |
| a short job arrives | `suspended` ("paused for give"), resumes afterwards |
| death | `resumable` with `needsVerify`; the respawn prompt lists it |
| shutdown / link drop | saved as `resumable` before the sockets close |
| a process killed without that | demoted to `resumable` when `goals.json` loads |
| `stop` | `cancelled` — never revived |

Resuming is not replaying: the origin is the one captured when the build
started, a gather continues from the remaining count, and short jobs re-run
from their arguments. Task completion requires a successful result that does
not explicitly report incomplete work. On restart, explicit verification, and
resume, `verifyGoalAgainstWorld` checks supported objectives against blocks,
inventory, places and players; unsupported or unavailable evidence produces
an unknown verdict, not proof of completion. Build verification is
dimension-aware, so the same x/z in the nether is not evidence about an
overworld build.

The `goal` tool is the model's handle on this list: `list`, `show`, `add`,
`resume`, `suspend`, `cancel`, `complete`, `update`, `verify`. Priorities are a
guideline for ordering and reporting, not a scheduler; the model still decides
what matters. A watchdog (`goals.tickMs`, 15 s) nudges the model when a running
objective stops making checkpoints, suspends one that recorded three failures
with no progress, and nudges a waiting objective that nothing picks up. Being
slow is never treated as failure.

Operational notes: `goals.json` lives under `ZINC_DATA_DIR` and is written
atomically; run **one process per data directory** (there is no lock file), and
keep the directory persistent or every restart forgets. Restart verification
inspects the first six open objectives; the rest stay flagged `needsVerify` and
are checked on `goal resume` or `goal verify`. Tunables are the `goals` block in
`config.json`.

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
  or bounded generated shapes. Building is inventory-checked and staged
  (foundation → walls/windows → roof → details); a rerun compares block names,
  not orientation or context. `set_mode` supports `explorer`, `hunter`, and
  `builder`. Pathfinder digging is disabled by default, but `gather` digs
  directly and cannot distinguish natural resources from the same blocks in a
  structure.
- **Survival:** the body eats from a food whitelist, uses a water bucket only
  for a fall that warrants a clutch (default threshold 5 blocks), swims when
  submerged, and can deploy an elytra through Mineflayer's `bot.elytraFly()`
  when enabled and properly equipped. Without an elytra, deployment returns
  `no_elytra`; there is no pretend glide.
- **Vanilla guard:** slash-command chat is blocked. The one private-message
  exception is generated by the guard itself as `/msg <online-player> …` when
  the model asks for a whisper. A server/plugin must actually implement `/msg`.

## Action and chat tools

The complete action tool list is:

`say`, `go_to`, `follow`, `stop`, `attack`, `hold`, `look_in`, `take`, `put`,
`smelt`, `sleep`, `give`, `eat`, `equip`, `use_block`, `inspect_block`,
`inspect_region`, `redstone_scan`, `redstone_component`, `find`, `remember_here`,
`craft`, `gather`, `light_up`, `shelter`, `corpse_run`, `logic_test`,
`circuit_project`, `build`, `build_shape`, `run_script`, `goal`, `set_mode`,
`idle`.
Explorer mode omits the four builder/logic/project tools from the offered set,
not all mutators; the model can also select `set_mode`. Modes are not a
property-permission boundary. Shape floors use `{w,d}` and boxes `{w,d,h}`;
unsupported parameters and oversized plans are refused rather than guessed.

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

## Digging is the model's decision

There is no digging switch: not an operator variable, not a config flag. A
route is always planned through the world as it is — doors and gates are
opened, hazards are avoided, and if there is no way through the walk reports
"no path" instead of tunnelling.

Breaking is a request. The model calls the `dig` tool with a destination
(player, saved place or `[x,y,z]`) and optionally:

- `materials` — a list of block ids it may break (`[oak_log]`, `[dirt, stone]`);
  everything else becomes unbreakable for that trip;
- `avoid` — block ids it must never break, whatever else is allowed.

That permission is a *window*, not a setting: it opens for one walk, closes
when the walk ends (success, no-path, cancellation or a safety preemption), and
expires on its own after at most two minutes. Escapes, `follow` and every other
route keep the strict no-dig geometry. Doors, gates and trapdoors are never
breakable in any window, and a route never carves into liquid or mines what
holds up gravel or a mob.

## Configuration and operation

[`config.json`](config.json) holds **defaults only**. Everything it contains is
overridden by an environment variable of the same meaning, which is how a
PufferPanel template configures the bot: template variable -> `${VAR}` in
`run.environmentVars` -> process env -> `loadConfig()`. There is no `.env` and
no dotenv; nothing is read from a file the panel does not control.

| Variable | Meaning |
| --- | --- |
| `MC_HOST`, `MC_PORT` | Minecraft server address and port. |
| `MC_VERSION` | Explicit protocol version; empty means auto-detect. |
| `MC_AUTH` | `offline` or `microsoft`. An unsupported value fails the boot. |
| `MC_ALLOW_SCAFFOLDING`, `MC_AUTO_ELYTRA` | Pillar/bridge while travelling, and elytra gliding. |
| `AMD_API_KEY`, `API_KEY`, `RADEON_API_KEY` | API key. Set it as a panel variable; it is never written to disk. |
| `AMD_API_BASE_URL`, `AMD_MODEL` | Endpoint base URL and model alias. |
| `AMD_MAX_TOKENS`, `AMD_TEMPERATURE`, `AMD_API_TIMEOUT_MS`, `AMD_CHAT_TIMEOUT_MS`, `AMD_MAX_CONCURRENT` | Model-call shape and lane concurrency. |
| `BOT_MODE` | `explorer`, `hunter` or `builder`. |
| `BOT_ALIASES` | Comma-separated chat names besides `ZincAI`. |
| `BOT_LANGUAGE` | Reply-language check (`pt-BR`, `en`, `es`, `fr`, `de`; empty = off). |
| `INFERENCE_RPM`, `INFERENCE_MIN_INTERVAL_MS`, `INFERENCE_HEARTBEAT_MS` | Call budget, spacing and self-prompt. |
| `RECONNECT`, `RECONNECT_MAX_ATTEMPTS` | Post-spawn reconnection behaviour. |
| `ZINC_DATA_DIR` | Writable data directory (relative to the server folder in the template). |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error`. |

Dotted names (`server.host`, `amd.model`, `behavior.allowScaffolding`, ...) are
accepted as well and mean the same key in `config.json`, so a single default can
be overridden without inventing a template variable. An empty variable always
means "not set" — it can never blank a default by accident.

The login name is hard-coded to `ZincAI`; `MC_USERNAME` does not rename it.
The first join failure is fatal. Once it has spawned, a dropped connection or
server restart is retried under the same name with backoff (see
`reconnect` in `config.json`). A whitelist/ban rejection is not retried.

Useful commands:

```sh
npm ci
npm run check                     # syntax-check every module
npm start                         # == node zincai/index.js
npm run dry-run                   # validate config + prompt budget, no network
```

`--dry-run` prints the resolved server, endpoint, data directory, behaviour
switches and limits, so a panel deployment can be verified by pressing the
preflight that the template runs before every start.

### Running under PufferPanel

[`../pufferpanel/zincai.json`](../pufferpanel/zincai.json) is a complete
PufferPanel 3 template: it clones the repository, installs Node.js and the
dependencies, creates the data directory, and passes every setting above as an
environment variable. The API key is a template variable that only ever becomes
`AMD_API_KEY` in the process environment, never a file.

```sh
node pufferpanel/import.js                     # validate + show the target path
node pufferpanel/import.js --dir /var/lib/pufferpanel/templates --apply
```

Then restart the panel and create a server from the "Minecraft Agent (ZincAI)"
template. Host and Docker environments are both supported; the run command is
chosen by the panel, not written out twice.

## Testing

```sh
npm test          # the suite the template ships with
npm run check
```

The suite uses mock bots and scripted model responses — no engine, no account,
no network. `test/session.test.js` drives whole sessions through the real
dispatcher, `test/zincai.test.js` covers perception/memory/tools, and
`test/settings.test.js` proves the template-to-environment wiring documented
above.

## Known limits / unverified assumptions

- Use only a supervised disposable world with enforced server-side boundaries.
  In a synthetic session, an equip already in progress allowed build/shelter to
  invoke placement after `stop`; shelter also attempted cleanup. Other actions
  may cross awaited operations. A stop response is not proof all mutations have
  ceased, and direct gathering cannot distinguish natural resources from the
  same blocks in a structure. This does not require tracking an owner for every
  item or block; use appropriate world/region safeguards for tests. No live
  mutation was tested.
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

### Investigating a small redstone region

`redstone_scan` reads a cube (radius 0–2, within eight blocks) and returns a
session snapshot ID, component counts, unreadable/unloaded cells and a page of
coordinates. For later pages use `redstone_scan` with `snapshot` and `page`.
`redstone_component` takes that snapshot ID and a listed `x,y,z`; it returns
reported block states and pages of nearby graph relationships. The snapshot is
non-atomic, becomes stale and only the four most recent are kept in the session.
Observed mutual dust-side state is geometry evidence, **not proof of power**;
adjacencies, stepped dust, non-component blocks, chunk boundaries and
quasi-connectivity remain uncertain. Comparator output strength can be unknown.
Use `inspect_block` for additional states. None of these tools changes the world.

In builder mode, `logic_test` can save its validated abstract graph and result
by providing `project`; `circuit_project` with `operation: "bind"`, the same
`name` and a `snapshot` saves a historical location/summary and optional
unverified hypothesis. `show`, `graph` (paginated), `test` and `list` retrieve
or rerun the saved investigation. The bounded store in
`zincai-data/circuit-projects.json` persists up to 16 projects; physical graph
details are not persisted and the region must be rescanned to refresh them.
`FULL_SUM` and `FULL_CARRY` gates provide reusable three-input Boolean full
adder outputs. Testing is abstract only: a counterexample identifies differing
outputs and a declared dependency cone, **not a physical fault or its cause**.
No timing, live signal propagation, layout verification or world mutation is
performed by this workflow.
