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
origin (`player:Steve` or `self`), a priority, a completion/failure/resume
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
`defaults.json`.

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
- **The agent loop** (`brain.js`, `act()` in `index.js`). One turn is
  *think → tool calls → their results → think again*:
  - an answer may carry several tool calls; they run in order
    (`parallel_tool_calls: true`; an endpoint that rejects the flag is retried
    without it and remembered);
  - what each call returned is sent straight back as OpenAI `tool` messages
    (or as plain text for an endpoint whose chat template rejects them) and the
    model is asked again, up to `inference.maxStepsPerTurn` (6) calls per turn,
    each counted against `inference.rpm`;
  - the turn ends when the model calls `idle`, when a call put the body to work
    (`go_to`, `follow`, `build`… — that work runs in the background and its
    result starts the next turn), when every call was fire-and-forget (`say`,
    `note`) and succeeded, or when a player's request preempted it;
  - one body task per answer: a second physical call in the same answer is
    returned as `NOT RUN` instead of cancelling the first; asking for the
    `follow` that is already running does not restart it;
  - between turns the scheduler starts the next one by itself: `loopMs` (8 s)
    after the last one ended, doubling while the model idles up to
    `heartbeatMs` (90 s), back to `loopMs` on any event; every `loopBusyMs`
    (30 s) while the body is busy. `heartbeatMs: 0` or `loopMs: 0` turns the
    loop off (events only).
- **Chat is a window, not a summons — and it never waits for the body.** Lines
  are batched for ~6 s (`inference.chatBatchMs`) and handed to the model as one
  chunk — every speaker, in arrival order — and only when there is data.
  There is **no relevance filter**: nothing checks the bot's name, counts how
  many players are online, or drops a line because the player has spoken too
  often. The model reads the window and decides who, if anyone, it is answering
  (`reply.to`). The chat lane runs beside the action lane: it answers while the
  body walks or builds, and answering cancels nothing. When the reply agrees to
  one of the three things that need no planning it starts it at once —
  `reply.do: follow | come | stop` — and anything else (`reply.task`) is handed
  to the action lane ahead of whatever it was thinking about (that, and only
  that, preempts an in-flight action call).
- **One log, IRC style, with times** (`irc.js`). Chat and events share one
  timeline and both prompts show it oldest-first, every line stamped:
  `[14:02:07] <Steve> text` public, `[14:02:09] -Steve- text` a whisper to the
  bot, `<ZincAI>` its own lines, `>Steve< text` its whisper out,
  `[14:02:15] * hurt: …` an event (world, reflex, own action result); repeats
  collapse to `(x3)`. The header carries the time *now*. The chat prompt puts a
  `----- NEW since you last answered -----` marker where the unread lines begin,
  so the model reads what it has not seen in the context it already had.
- **Language is the model's.** There is no language check on the way out, no
  retry and no replacement line: it answers in the language the person it is
  talking to used, and the words it chose are the words that go out.
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
  not orientation or context. Pathfinder digging is disabled by default, but `gather` digs
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
`redstone_engineer`, `circuit_project`, `build`, `build_shape`, `run_script`,
`goal`, `dig`, `dig_policy`, `note`, `social`, `recall`, `idle`.

**That is the whole list, on every turn.** There is no mode, no `set_mode` and
no per-mode subset: the schema is byte-identical from call to call (which also
keeps prefix caching cheap), so the model never discovers that the verb it needs
was hidden by a persona it picked ten minutes ago. Shape floors use `{w,d}` and
boxes `{w,d,h}`; unsupported parameters and oversized plans are refused rather
than guessed.

The separate chat lane has one `reply(text, to, do, task, decision, remember)`
tool. `to` names the player being answered when several are talking; `do`
(`follow` / `come` / `stop`) starts that body action immediately; `task` is
anything else the model wants its action lane to do or verify; `remember` holds
a fact worth keeping. Chat and action
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

Two tools, both the model's:

**`dig_policy` — the standing rule for what a WALK may break**
(`dig_policy.js`). It is a persistent flag plus an editable list, not a
per-walk permission:

| Argument | Effect |
| --- | --- |
| `can_dig: true \| false` | the switch. Off = walking never breaks a block |
| `mode: "list" \| "all"` | `list` = only blocks on the list; `all` = anything in the way, except the never-break set (bedrock, barriers, portals and frames, spawners, vaults, command/structure blocks, reinforced deepslate) |
| `add: [...]`, `remove: [...]` | edit the list; ids or `*` wildcards (`*_leaves`) |
| `reset: true` | back to the starting list |
| *(none)* | read the rule back |

The starting list is soft, common, cheap-to-replace terrain — dirt, grass,
sand, gravel, clay, snow, leaves, vines, moss, plants, soul sand — and
deliberately no stone, ore or wood: breaking those is a decision, so the model
makes it once (`add: ["stone", "deepslate"]` before going underground) rather
than hitting "no path" at every block. The rule is shown on every action turn
as the `digging:` line, applies to every route (`go_to`, `follow`, errands), is
saved in `<data dir>/dig-policy.json` and survives restarts;
`behavior.digging` in `config/defaults.json` only sets the first-run values.

Whatever the policy says, a walk never breaks:

- a block that touches a crafted block, or lies inside a claimed/owned area —
  other players' builds are not terrain;
- doors, gates, trapdoors (they are opened), containers, anything that holds
  back liquid, or what supports gravel or a mob;
- anything at all while the operator switch `actions.allowDig` is off.

Each broken block costs extra path cost (`behavior.digging.cost`), so a short
way around is still preferred over tunnelling.

**`dig` — one deliberate corridor.** A destination (player, saved place or
`[x,y,z]`) and optionally `materials` (the only ids it may break) and `avoid`
(ids it must never break). That permission is a *window*: it opens for one
walk, closes when the walk ends (success, no-path, cancellation or a safety
preemption), and expires on its own after at most two minutes. It is how the
model breaks what its standing rule does not cover — on purpose, once.

## Follow, flee, and routes around mobs

- **`follow` is a loop, not one walk** (`skills.js`). It re-reads the player
  every pass, waits while a reflex has the controls and then carries on, walks
  to the last-seen position when the player leaves entity range, and keeps
  retrying an unreachable stretch. It ends by itself only when the player
  leaves the game, has been out of sight for 45 s, or has been unreachable for
  60 s — and reports which. `stop` (or a new body task) ends it.
- **A scare is a dodge when there is a walk to come back to** (`system1.js`).
  With an errand under way the escape reflex starts only when something hostile
  is within `tetherTriggerRadius` (6), plans the dodge *toward* where the walk
  was heading (`escape.js`), and ends after `tetherCalmMs` (1.2 s) with nothing
  within `tetherReleaseRadius` (9) — instead of running until nothing hostile
  is within 22 blocks. The paused task resumes by itself; the model is told
  `dodging — "following Steve" is only paused and resumes by itself`, and the
  end of the dodge does not wake it. At `lowHealth` or below the full escape
  applies. `system1.tether: false` restores the old behaviour.
- **Routes keep away from mobs** (`PredictiveThreatMap` in
  `custom_mineflayer/pathfinder_wrapper.js`). Every A* step pays a threat cost:
  a *standoff ring* per mob type (creeper 7 blocks, ranged mobs 8, melee 5,
  warden 14…) measured from the whole stretch the mob will cover in the next
  two seconds, its projected position, and its line to the bot. The cost is
  quadratic — steep next to the mob, nearly free at the rim — and capped below
  the pathfinder's "impossible" line, so it bends routes without walling the
  bot in. A **route watcher** re-plans a route that is already being walked
  when the steps ahead have become clearly more dangerous than when it was
  planned (`threat.routeReplanCost` 12, `routeReplanRise` 8, at most every
  `routeReplanMs` 1.2 s).

## Operator control (runtime, no restart)

Zinc keeps its identity, its goals and its own decisions; what an operator gets
is a **control plane**, not a personality. Apart from `shutdown`, `update` and
`restart`, nothing here kills the Node.js process, and nothing switches it into a different "mode" — there is no
autonomous/safe/building/restricted switch anywhere in this code. There are
parameters, permissions and limits, each of which can be read and changed while
the bot is running.

### Commands

One entry point, one implementation (`zincai/host.js`, described by
`zincai/control_commands.js`):

- **console / stdin** — the PufferPanel console. A command is typed on its own,
  with **no prefix**: `status`, `pause`, `shutdown 1`, `config show boundary`.

The answer is printed on the console. Nothing typed in **game chat** is a
command, for anyone.

| Command | What it does |
| --- | --- |
| `status` | connection state, life, pause, activity, open goals, running jobs, effective limits |
| `pause` (alias `stop`) | the emergency handbrake: no new physical action, cancellable work interrupted, open goals **suspended — never deleted**, memory/identity/process untouched. Changes no policy: everything the model may do, it may still do |
| `shutdown [code]` | the other half of the emergency stop: save memory/places/goals, leave the server, exit the process. `pause` is the reversible one |
| `update [check \| force]` | pull the newest source from GitHub and restart on it (below) |
| `restart` | restart the whole process on the source that is on disk, without pulling |
| `resume` | inspect the real world and inventory first, then hand back only the goals that still make sense |
| `leave` | disconnect Mineflayer; the process, memory, goals, reasoning and this interface stay up |
| `join` | reconnect the existing process to the configured server |
| `restart-connection` | drop and rebuild the link without a new process |
| `goals` | open, suspended, waiting and completed objectives |
| `jobs` | background jobs, their resources and cancellation state |
| `cancel <goal-id>` | cancel exactly one goal and the jobs that belong to it |
| `config` | `config show [group\|name]`, `config set <name> <value>`, `config reset <name>` |
| `help` | the list above |

**`update`** is the quick test loop — push to GitHub, type `update`, the bot
comes back on the new code (`updater.js`):

1. refuses if tracked files have local edits (unless `update force`);
2. `git fetch origin <current branch>` (a shallow panel checkout stays shallow);
3. nothing new → says so and stops; `update check` stops here either way;
4. fast-forwards (`merge --ff-only`; a shallow or forced update resets to the
   fetched commit);
5. runs `npm ci` only if `package.json`, the lockfile or an install script
   changed (`--omit=dev` under `NODE_ENV=production`);
6. runs `node zincai/index.js --check` on the new source;
7. on any failure in 5–6 resets the checkout to where it was and reports — the
   running bot is untouched;
8. on success saves state, leaves the server and exits with code **75**.

Exit code 75 is the restart request. `node zincai/index.js` starts a small
supervisor (`supervisor.js`) that runs the bot as a child sharing its console;
on 75 it starts a fresh child, on any other code it exits with that code. It
forwards the panel's stop signal and gives up if the bot asks to restart three
times within ten seconds of starting. If the supervisor itself is killed
outright (the panel's Kill, `kill -9`, the OOM killer) the bot notices over the
IPC channel it holds to it, saves its state and leaves, so it is never left
running with nothing that can stop it. `ZINCAI_NO_SUPERVISOR=1` or
`--no-supervisor` runs the bot as a single process for setups where systemd or
Docker already restarts it. `--check` and `--dry-run` never start a supervisor.

`pause` and `leave` are different on purpose: a paused bot is still standing in
the world and can still talk; a bot that has left is not in the world at all.
Both keep the goal registry on disk and the scheduler alive.

### Authorisation

**Whoever holds the process's console is the operator.** That is the whole
model. There is no chat command surface to authorise, so there is no prefix, no
UUID allow-list, and no `control.operators` / `control.operatorNames` /
`control.announce` to maintain — a player cannot probe a surface that does not
exist.

- `control.allowConsole` (default on) is the console path; turn it off if the
  panel console is shared with people who should not steer the body. The
  supervisor's own pause/stop calls still work.
- `ZINC_OPERATORS` and `ZINC_COMMAND_PREFIX` are read by nobody. A template that
  still sets them keeps booting; the variables are inert.

Console commands are audited in the log with the command, the actor and the outcome
(`control.auditLog`).

### Parameters

Every limit is a named, typed, persisted parameter in
`<datadir>/runtime-config.json` (`zincai/runtime_config.js`). They are inspected
and changed with the generic `config` command — there is no per-setting command
to remember, and `config show` lists defaults and effective values together.

| Parameter | Type | Default | Applies |
| --- | --- | --- | --- |
| `boundary.enabled` | boolean | false | immediate |
| `boundary.centerX` / `centerZ` | integer | 0 / 0 | immediate |
| `boundary.radius` | integer | 256 | immediate |
| `boundary.dimension` | string | overworld | immediate |
| `boundary.homeX` / `homeY` / `homeZ` | integer | 0 / 64 / 0 | immediate |
| `boundary.homeDimension` | string | overworld | immediate |
| `boundary.returnHomeOnDeath` | boolean | false | immediate |
| `boundary.blockOutside` | boolean | true | immediate |
| `actions.allowMovement` | boolean | true | immediate |
| `actions.allowDig` | boolean | true | immediate |
| `actions.allowPlace` | boolean | true | immediate |
| `actions.allowAttack` | boolean | true | immediate |
| `actions.allowContainers` | boolean | true | immediate |
| `actions.allowUse` | boolean | true | immediate |
| `actions.allowEquip` | boolean | true | immediate |
| `actions.allowEat` | boolean | true | immediate |
| `actions.allowToss` | boolean | true | immediate |
| `actions.allowCraft` | boolean | true | immediate |
| `actions.allowScripts` | boolean | true | immediate |
| `limits.maxConcurrentJobs` | integer | 4 | next safe boundary |
| `limits.maxPhysicalActionsPerMinute` | integer | 240 | immediate |
| `limits.maxGoalRuntimeMinutes` | integer | 0 (off) | immediate |
| `communication.publicChat` | boolean | true | immediate |
| `communication.privateMessages` | boolean | true | immediate |
| `communication.replyToChat` | boolean | true | immediate |
| `connection.joinOnStart` | boolean | true | immediate |
| `connection.autoReconnect` | boolean | true | immediate |
| `connection.retryDelayMs` / `minRetryDelayMs` / `maxRetryDelayMs` | integer | 5000 / 5000 / 120000 | immediate |
| `connection.maxRetries` | integer | 40 | immediate |
| `death.autoRespawn` | boolean | true | immediate |
| `death.respawnDelayMs` | integer | 1500 | immediate |
| `control.allowConsole` | boolean | true | immediate |
| `control.auditLog` | boolean | true | immediate |

`config set` validates the type and range, rejects unknown names, prints the old
and new value, and writes the file atomically, so a restart (or a `leave` /
`join` cycle) keeps the change. A parameter that cannot take effect mid-action
(`limits.maxConcurrentJobs`) reports **"will be applied at the next safe
boundary — NOT yet in force"** and is applied when the body goes idle; it is
never silently dropped, and it never changes the bot's identity.

The communication switches are permissions, not opinions: `communication.publicChat
= false` stops a line from leaving, and says so to the model, but it does not
tell Zinc whom to like, trust or cooperate with.

### One enforcement boundary

`zincai/boundary.js` is the single place a physical action is authorised, and
every route asks it:

- `zincai/lanes.js` — a BODY lane lease is refused before it starts;
- `ControlArbiter` — every key and pathfinder goal write passes a gate;
- `Skills` (walk, dig, build, gather, combat helpers) — before the act;
- `BuilderExecutor` — between blocks, so a stop lands mid-build;
- the executor's tool dispatch — before a tool body runs;
- **`installPhysicalGuard`** — at the wire: `setControlState`, `dig`,
  `placeBlock`, `attack`, `useItem`, `activateBlock`, `toss`, `equip`, the
  pathfinder and the chat/whisper calls are wrapped on the bot object itself,
  so even a module that bypasses the scheduler cannot press a key while the
  body is paused, disconnected, dead or outside its permissions. Key
  *releases* are always allowed, so nothing is left held.

The order of a decision is: pause / connection / death → the per-capability
parameter → the permitted area (body and, for a walk or a build, the
destination) → the sliding action rate limit. Reads and reasoning (`inspect_block`,
`inspect_region`, `find`, `redstone_scan`, `logic_test`, `recall`, `social`,
`goal`, `idle`) are never blocked by any of it: a paused bot may keep thinking,
planning and — if the operator allows it — talking.

A refusal is not silent *to the model*: the action prompt carries a one-line
`body:` field (`PAUSED by the operator`, `not connected`, `refused:
actions.allowDig is off`), so the model re-plans instead of retrying blind.

### Connection lifecycle

`zincai/connection.js` is a small state machine: `DISCONNECTED`, `CONNECTING`,
`CONNECTED`, `RECONNECTING`, `DISCONNECTING`, `ERROR`. The process outlives the
link: while disconnected there are no physical actions, no fabricated events,
and no stale world snapshot presented as current — reasoning and the control
interface keep working, and goals stay on disk. On reconnect the manager
verifies the connection, hands the session ONE set of listeners (a disposed
session takes its listeners off its own bot with it), inspects the real state,
reconciles position/health/inventory/dimension, and only then lets work resume.
Retries are bounded: a rejected first join is fatal, a dropped link is retried
with backoff between `connection.minRetryDelayMs` and
`connection.maxRetryDelayMs`, at most `connection.maxRetries` times. Hooks are
epoch-guarded, so a late callback from an old session can never act on a new one.

### Death and respawn

A death is not a failure of the process. `zincai/death_recovery.js` records what
was lost, suspends the physical work, waits out `death.respawnDelayMs`, and then
**inspects** the respawn: real coordinates, real dimension, real inventory. If
`boundary.returnHomeOnDeath` is on and the home is reachable inside the
permitted area, the body walks back; if the home is in another dimension, or
outside the permitted area, or the route is blocked, it **reports** — it never
repeats an impossible walk.

### Tests

`test/control-runtime.test.js` covers the whole surface against the real
session: pause/resume, stop mid-walk, stop mid-build, stop during a background
job, disconnect with a goal open, reconnect without a new process, reconnect
without duplicate listeners, death → respawn → recovery, config persistence
across a restart, a config change while a goal runs, a targeted `cancel`, and a
stale world (an action planned before a change is refused with the reason).

## Configuration and operation

[`defaults.json`](config/defaults.json) holds **defaults only**. Everything it contains is
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
| `BOT_MODE`, `BOT_ALIASES`, `BOT_LANGUAGE` | **Inert.** There are no modes, no name gating and no language check. A template that still sets them keeps booting. |
| `INFERENCE_RPM`, `INFERENCE_MIN_INTERVAL_MS` | Call budget and spacing. |
| `INFERENCE_LOOP_MS`, `INFERENCE_HEARTBEAT_MS` | The agent loop: pause after a turn (8000) and the longest it backs off to while idle (90000). `0` in either turns the loop off. |
| `INFERENCE_CHAT_BATCH_MS` | How long chat lines are collected into one chunk (6000). |
| `ZINCAI_NO_SUPERVISOR` | `1` = run as one process; `update`/`restart` then exit 75 for an outside supervisor. |
| `RECONNECT`, `RECONNECT_MAX_ATTEMPTS` | Post-spawn reconnection behaviour. |
| `ZINC_OPERATORS`, `ZINC_COMMAND_PREFIX` | **Inert.** Control is console-only; there is no chat command interface to configure. |
| `ZINC_JOIN_ON_START` | Join the server when the process starts (`connection.joinOnStart`); `false` waits for `join`. |
| `ZINC_DATA_DIR` | Writable data directory (relative to the server folder in the template). |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error`. |

Dotted names (`server.host`, `amd.model`, `behavior.allowScaffolding`, ...) are
accepted as well and mean the same key in `defaults.json`, so a single default can
be overridden without inventing a template variable. An empty variable always
means "not set" — it can never blank a default by accident.

The login name is hard-coded to `ZincAI`; `MC_USERNAME` does not rename it.
The first join failure is fatal. Once it has spawned, a dropped connection or
server restart is retried under the same name with backoff (see
`reconnect` in `defaults.json`). A whitelist/ban rejection is not retried.

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
node pufferpanel/import.js          # validate + explain both import paths
node pufferpanel/import.js --print  # the JSON to paste into Templates → New
```

PufferPanel 3 has no template directory and no "Import" button: it stores
templates in its database (web UI) or reads them from an added git repository,
where it scans `<repo-root>/<subfolder>/<name>.json`. This repository already
has that layout under `pufferpanel/`, so **Templates → Add repo** pointed at
this repository is the shortest path. Host and Docker environments are both
supported; the run command is chosen by the panel, not written out twice.

## Testing

```sh
npm test          # the suite the template ships with
npm run check
```

The suite uses mock bots and scripted model responses — no engine, no account,
no network. `test/session.test.js` drives whole sessions through the real
dispatcher, `test/zincai.test.js` covers perception/memory/tools,
`test/control-runtime.test.js` drives the operator interface, the boundary, the
connection state machine and death recovery against a live session, and
`test/settings.test.js` proves the template-to-environment wiring documented
above.

## Known limits / unverified assumptions

- Use only a supervised disposable world with enforced server-side boundaries.
  The pause is enforced at the scheduler, at every skill, inside the builder
  loop and at the Mineflayer primitives, and a synthetic session confirms that a
  stop mid-walk, mid-build and mid-job all land — but a single primitive already
  on the wire cannot be recalled. A stop response means "nothing new starts and
  everything held is released", not "every mutation has already ceased".
  Shelter cleanup and an equip already in progress are the two places where a
  step can still complete after the pause. Direct gathering cannot distinguish
  natural resources from the same blocks in a structure. No live mutation was
  tested.
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
- Shield behavior through `activateItem(true)`, water-bucket placement on a
  real server, `/msg` support, and sign-text APIs need server-side/live
  verification.
- The optional loopback cannot validate hostile mob AI, production physics,
  Minecraft 26.3, the real AMD service, or a production whitelist.
- Skills `follow`, `put`, `smelt`, `sleep`, and `use_block` have not all been
  exercised against a real server. The code's unit/session tests are not a
  substitute for those live checks.
- Structure perception is a local heuristic, not a full-world oracle; the ASCII
  grid (offered whenever the bot is holding build materials) is a simple voxel
  slice, not pixels seen by a multimodal model.

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
