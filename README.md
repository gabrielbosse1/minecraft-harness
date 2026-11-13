# Minecraft Harness — ZincAI

One autonomous Minecraft Java agent: **ZincAI**. A Mineflayer body, a local
survival reflex layer, and an AMD Radeon Cloud (OpenAI-compatible) model split
into two lanes that share one call budget:

| Lane | What it does |
| --- | --- |
| **Chat** | Answers a player in one short line (PT-BR by default), and may hand the body a task and a fact to remember. |
| **Action** | One structured function-tool call per turn: move, gather, craft, build, fight, sleep, remember. |

The agent does not decide to attack on its own. A local reflex layer flees from
real danger; the model decides whether to keep fleeing, move, or start a fight.
A player is attacked only after the model names that exact username. There is no
friend list, no “attack nearby player” reflex, and no server-side control. The
bot uses normal client packets; the only deliberate command exception is a
guarded private `/msg` when the model asks to whisper.

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
   | `mode` | `explorer`, `hunter` or `builder` |

   The rest have working defaults: model, call budget, aliases, reply language,
   digging/scaffolding/elytra switches, reconnection, log level.

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

No restart is needed to stop, pause, move or reconfigure the bot, and no
behavioural "mode" exists — only parameters, permissions and limits.

- **Console (PufferPanel):** type the command alone — `status`, `stop`,
  `resume`, `leave`, `join`, `restart-connection`, `goals`, `jobs`,
  `cancel <goal-id>`, `config show boundary`, `config set boundary.radius 48`,
  `help`.
- **In-game chat:** the same commands behind a prefix (`!zinc status`), answered
  by whisper. Only the Minecraft **UUIDs** in `control.operators` (template
  variable `operators`, `ZINC_OPERATORS`) may use it; anyone else is ignored
  and logged without a hint that the interface exists.
- `stop` pauses the body and suspends — never deletes — open goals; `resume`
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
  teleporting. The operator interface is a chat prefix plus the panel's own
  stdin — it needs no admin rights on the Minecraft server.
- **Digging is the model's call.** Pathfinding never breaks blocks on its own:
  it opens doors, routes around, or reports no path. The model asks with the
  `dig` tool, optionally restricting which block ids it may break
  (`materials`) or protecting others (`avoid`). The permission covers one walk
  and lapses when it ends; doors are never broken.
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
npm test              # 300 tests: mock bots + a scripted local model
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
