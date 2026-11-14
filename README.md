# Minecraft Harness — ZincAI

One autonomous Minecraft Java agent: **ZincAI**. A Mineflayer body, a local
survival reflex layer, and an AMD Radeon Cloud (OpenAI-compatible) model split
into two lanes that share one call budget:

| Lane | What it does |
| --- | --- |
| **Chat** | Reads the last few seconds of chat as one IRC-style window, answers whoever (if anyone) it judges needs an answer — in that person's language — and may hand the body a task and a fact to remember. |
| **Action** | One structured function-tool call per turn: move, gather, craft, build, fight, sleep, remember. |

The agent does not decide to attack on its own. A local reflex layer flees from
real danger; the model decides whether to keep fleeing, move, or start a fight.
A player is attacked only after the model names that exact username. There is no
friend list, no “attack nearby player” reflex, and no server-side control. The
bot uses normal client packets; the only deliberate command exception is a
guarded private `/msg` when the model asks to whisper.

## Complete model freedom

The model is not steered by the harness. Concretely:

- **No modes.** `explorer` / `hunter` / `builder` and the `set_mode` tool are
  gone. Every tool — build, `build_shape`, `logic_test`, `circuit_project`,
  combat, redstone inspection, everything — is in the schema on **every** turn.
  The per-turn schema is byte-identical, which also keeps prefix caching cheap.
  Movement posture (cautious while placing blocks, parkour while fleeing) is
  chosen by the wrapper from what the body is doing, never by a persona.
- **No relevance filter.** A chat line is not scored for whether it mentions
  the bot's name, whether a question “must” be for it, or whether that player
  has spoken too often. Every attributable line is logged, remembered and given
  to the model, which decides what concerns it.
- **A real agent loop.** A turn is *think → call tools → read what they
  returned → think again*, not one model call and one tool call. An answer may
  carry several calls (`say` + `follow`), each result goes straight back to
  the model as tool output, and the turn ends when the model calls `idle` or
  has put the body to work — at most `inference.maxStepsPerTurn` (6) model
  calls. The next turn then starts **by itself** `inference.loopMs` (8 s) after
  the last one ended; while the model keeps idling the gap doubles up to
  `heartbeatMs`, and anything that happens resets it. While the body is busy
  the loop looks in every `loopBusyMs` (30 s).
- **Talking never waits for the body.** Chat has its own lane and is answered
  while the body walks, builds or follows; `say` is not a body action and does
  not interrupt one. When the chat lane agrees to "follow me", "come here" or
  "stop", it starts that itself (`reply.do`) the moment it answers; any other
  request (`reply.task`) goes to the action lane ahead of whatever that lane was
  thinking about. Ordinary chat no longer cancels the action thought — only a
  request handed to the body does.
- **IRC-style log.** Lines are collected in a ~6 s window
  (`inference.chatBatchMs`) and delivered as **one chunk**: several speakers, in
  arrival order. Both prompts show the same timestamped log, chat and events
  interleaved in the order they happened —
  `[14:02:07] <Steve> zinc vem aqui`, `[14:02:09] -Steve- a whisper`,
  `[14:02:11] <ZincAI> to indo`, `[14:02:15] * hurt: hit by a zombie` — with
  the time *now* in the header and a marker where the unread lines begin. A
  burst of eight lines is one model call, not eight, and nothing in the window
  is dropped for volume.
- **Language is free.** There is no language guard, no retry, and no canned
  replacement line. The model answers in whatever language the person it is
  talking to is using, and the words it chooses are the words that go out.
- **No trust lists.** `trust.owners` / `trust.trusted` are gone. The model
  forms its own view of every player from evidence — the system prompt still
  tells it that nobody, including its creator, has automatic authority.
- **The only limits left** are not policy about what the model may think or do:
  the **API budget** (`inference.rpm`, `minIntervalMs`, `heartbeatMs`,
  `chatReserve`), a **self-protection rate** on physical actions that keeps the
  server's anti-cheat from kicking the bot
  (`limits.maxPhysicalActionsPerMinute`, default 600), one-line-per-second
  speech pacing (a Minecraft server limit, not a cap on what may be said), and
  the **emergency stop**: `pause` / `stop` and `shutdown` on the console.
  Owner and property protection remain, because those protect *other players'*
  builds from damage, not the model from its own judgement.

It ships with a **PufferPanel template**: the panel clones the repository,
installs Node.js and the dependencies, passes every setting in as an environment
variable, and runs the bot. There is no `.env`, no committed key, and nothing to
configure by hand.

## Quick start (PufferPanel)

1. Get the template into the panel — PufferPanel 3 takes it either from a git
   repository or pasted into the web UI; it has no template folder and no
   "Import" button:

   ```sh
   node pufferpanel/import.js            # validate + explain both paths
   node pufferpanel/import.js --print    # the JSON to paste into Templates → New
   ```

   **Easiest:** in the panel, **Templates → Add repo** with this repository's
   URL and branch — the template in `pufferpanel/` is already laid out the way
   the panel scans (`<subfolder>/<name>.json`). See
   [`pufferpanel/README.md`](pufferpanel/README.md#1-get-the-template-into-the-panel),
   and the step-by-step walkthrough is in [`docs/pufferpanel-guide.md`](docs/pufferpanel-guide.md).

2. **Servers → New server**, pick the **zincai** template, and fill in the
   variables:

   | Variable | What to put |
   | --- | --- |
   | `apikey` | your `rc-...` Radeon Cloud key — becomes `AMD_API_KEY`, never a file |
   | `host` / `port` | the Minecraft server the bot joins (not the panel port) |
   | `auth` | `offline` for a private server with the name `ZincAI` whitelisted, `microsoft` for a premium account |
   | `mcversion` | a version like `1.21.4`, or empty to auto-detect |

   The rest have working defaults: model, call budget, digging/scaffolding/
   elytra switches, reconnection, log level. There is no `mode`, no alias list
   and no reply language to configure — see **Complete model freedom** below.

3. Press **Install**, then **Start**. Install clones the branch, installs
   dependencies and creates `data/`; every start first runs
   `node zincai/index.js --dry-run`, so a bad variable is reported in the
   console before the bot ever touches the network.

Details, the full variable list and the environment overrides are in
[`pufferpanel/README.md`](pufferpanel/README.md).

## Quick start (no panel)

Requirements: Node.js 18 or newer and an AMD Radeon Cloud Token Factory key
(or a compatible OpenAI-style endpoint).

```sh
npm ci
export AMD_API_KEY=rc-...
export MC_HOST=play.example.net MC_PORT=25565 MC_AUTH=offline
npm start                      # == node zincai/index.js
```

Everything is configured through environment variables — the same names the
template uses; [`.env.example`](.env.example) lists them with empty values and
explains how to export them locally. `zincai/defaults.json` holds defaults only,
and its `amd.apiKey` stays empty on purpose: the key is never a file. See
[`zincai/README.md`](zincai/README.md#configuration-and-operation) for the full
table.

## Controlling a running bot

No restart is needed to stop, pause or reconfigure the bot.

**The console is the only control surface, and there is no prefix.** Type the
command alone — `status`, `pause`, `stop`, `resume`, `leave`, `join`,
`restart-connection`, `goals`, `jobs`, `cancel <goal-id>`,
`config show boundary`, `config set boundary.radius 48`, `help` — and the two
emergency ones: `pause` (stop the body, keep everything) and `shutdown`
(save state, leave the server, exit the process).

**`update` — push, type one word, test.** `update` fetches the branch the
checkout is on from GitHub, fast-forwards to it, runs `npm ci` only if
`package.json` / the lockfile / an install script changed, proves the new
source loads (`--check`), and only then saves state, leaves the server and
restarts the process on the new code. If any step fails the checkout is rolled
back and the running bot is not touched. `update check` only reports whether
there is something to pull; `update force` discards local edits to tracked
files; `restart` restarts on the source that is on disk without pulling.
Memory, goals, places and the dig policy are on disk and are picked up again.

The restart works because `node zincai/index.js` is two processes: a tiny
supervisor (`zincai/supervisor.js`, no state) and the bot as its child; the
child exits with code 75 and the supervisor starts a fresh one. If systemd or
Docker already restarts the process, set `ZINCAI_NO_SUPERVISOR=1` (or pass
`--no-supervisor`) and let that do it.

Nothing typed in **game chat** is a command, for anyone: not with a `!prefix`,
not from a server operator, not from the account's creator. Chat is conversation
and reaches the model like any other line. There is no UUID allow-list and no
command prefix to configure, because there is nothing in chat to authorise.

- `pause` (alias `stop`) stops the body and suspends — never deletes — open
  goals; `resume`
  reconciles the real world before handing work back; `leave` drops the link but
  keeps the process, memory, goals and the interface alive; `join` reconnects
  that same process once, without duplicate listeners or jobs.
- Every limit (`boundary.*`, `actions.allow*`, `limits.*`, `communication.*`,
  `connection.*`, `death.*`, `control.*`) is a typed, validated, persisted
  parameter. `config show` lists the effective values and the defaults.
- One enforcement boundary (`zincai/boundary.js`) sits in front of every
  physical route — scheduler lanes, reflexes, the builder, tool dispatch, and
  the Mineflayer primitives themselves — so no path can press a key, dig, place
  or attack while the body is paused, disconnected, dead or outside the
  permitted area. Reasoning, memory and (if allowed) chat keep working.
- Death is not a crash: the body suspends its physical work, waits for the
  respawn, inspects the real position/inventory and only then resumes what is
  still valid. A route that is blocked or outside the permitted area is
  reported, never retried forever.

Details: [`zincai/README.md#operator-control-runtime-no-restart`](zincai/README.md#operator-control-runtime-no-restart).

## Behavior and safety

- **Flee first.** The survival body recognizes hostile mobs that can see or
  reach the bot, immediate hazards such as lit creepers, and entities that
  recently hurt it. Pets, named mobs, decorative entities, and peaceful players
  merely nearby are not threats. A player who hits the bot triggers a flee and a
  named wake-up, not retaliation. The escape route is planned over ground the bot
  can actually walk, and the model is told what the body did by itself.
- **The model owns the fight decision.** `idle` keeps the bot fleeing; `attack`
  is the only way a fight starts. Mob attacks require the exact type or `any`
  (hostiles only), line of sight, and a non-protected target. PvP requires an
  explicit exact player name.
- **One owner for movement.** Survival, combat and task lanes arbitrate
  movement goals and keys (`survival > combat > task`), so concurrent behavior
  cannot leave controls held or cancel a more urgent flee.
- **Vanilla-only operation.** No RCON, no server console commands, no
  teleporting. The operator interface is the panel's own stdin — it needs no
  admin rights on the Minecraft server, and nothing in game chat can reach it.
- **A follow survives a scare.** With a walk under way (`follow`, `go_to`, any
  errand) the escape reflex only *dodges*: it starts when something hostile is
  within 6 blocks, sidesteps toward where the walk was heading, ends as soon as
  nothing is within 9, and the same walk carries on — the model does not have to
  ask again, and is told the task is paused, not over. `follow` itself keeps
  going through lost sight (it walks to where the player was last seen, up to
  45 s) and unreachable stretches (it retries for 60 s), and only ends by
  itself when the player leaves the game. At low health the full escape applies.
- **Routes keep away from mobs.** Every path step pays for coming near a
  hostile: inside its standoff ring (creeper 7 blocks, shooters 8, melee 5), at
  the spot it will reach in the next two seconds, and on its line to the bot. A
  route that is already being walked is planned again when a mob moves onto it
  (`threat.routeReplan*`). It is a cost, never a wall: a boxed-in bot still
  gets out.
- **Digging is the model's standing rule.** What a walk may break on its own
  is a persistent flag and a list the model edits with the `dig_policy` tool:
  `can_dig` on/off, `mode` `list` or `all`, `add` / `remove` block ids
  (`*_leaves` wildcards), `reset`. It starts with soft terrain only — dirt,
  grass, sand, gravel, snow, leaves — so one block of dirt is no longer "no
  path", while stone, ores and wood are broken only once the model adds them.
  The rule is shown on every turn (`digging: …`), saved in
  `<data dir>/dig-policy.json`, and survives restarts. Whatever it says, a walk
  never breaks a block that touches a crafted block (someone's build) or lies in
  a claim, doors are never broken, and the operator switch `actions.allowDig`
  turns all of it off. The `dig` tool remains for one deliberate corridor
  (`materials` / `avoid`).
- **Reconnects.** A failed first join (including a whitelist rejection) is
  fatal. After a successful spawn, a dropped connection or server restart is
  retried with backoff under the same name.
- **Panel-friendly logging.** Plain ISO-timestamped lines, no ANSI colours,
  secrets never printed, `SIGINT`/`SIGTERM` handled for a graceful stop that
  saves memory and places first.

## Layout

```
zincai/            the agent: index, prompts, tools, memory, perception, reflexes
  custom_mineflayer/   door/gate handling, escape planner, pathfinder wrapper
  scripts/             local scripts the model can invoke with run_script
src/               shared modules: AMD client, combat, recipes, reconnect, logger, settings
pufferpanel/       the PufferPanel template + importer
scripts/           install helpers (26.3 data patch), ping, endpoint canary
test/              the automated suite (mock bots, scripted model, no network)
vendor/            vendored Minecraft 26.3 data, installed by `npm ci`
```

## Checks and tests

```sh
npm test              # 381 tests: mock bots + a scripted local model
npm run check         # syntax-check every module
npm run dry-run       # resolve config, print it, no network
npm run ping          # server reachability/version, no join, no model call
```

The suite never calls the real AMD endpoint and never joins a production
server. `test/settings.test.js` covers the template → environment → config path
that a panel deployment depends on.

Optional, with a real key:

```sh
AMD_API_KEY=rc-... npm run canary    # 60-second endpoint/auth/tool-call proof
```

## Notes

- Runtime memory, places, goals and metrics go to `ZINC_DATA_DIR`
  (`data/` in the template, `zincai-data/` by default) — gitignored.
- `npm ci` also runs `scripts/apply-26.3-data.js`, which installs vendored,
  unmerged `minecraft-data` files into `node_modules`. The data is unofficial;
  prefer version auto-detection or a server version you have verified.
- [`zincai/README.md`](zincai/README.md) documents the tool/action and survival
  policies in depth.

MIT License.
