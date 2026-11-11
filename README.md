# Minecraft Harness — Zinc and ZincAI

Two Mineflayer-based Minecraft Java agents share a survival/combat body, but
have different model interfaces:

| Harness | Entry point | Minecraft name | Model interface |
| --- | --- | --- | --- |
| **Zinc** | `src/index.js` (`npm start`) | `Zinc` by default | One compact JSON action per call; addressed chat and important game events wake the model. |
| **ZincAI** | `zincai/index.js` (`npm run start:zincai`) | Always `ZincAI` | Separate chat and action lanes; OpenAI-compatible function tools for actions. |

The agents do not decide to attack on their own. A local reflex layer flees
from real danger; the model decides whether to keep fleeing, move, or start a
fight (ZincAI also has a `hold` action). A player is attacked only after the model names that exact
username. There is no friend list, no “attack nearby player” reflex, and no
server-side control. Both bots use normal client actions; the only deliberate
command exception is a guarded private `/msg` for ZincAI when the model asks to
send a whisper.

## Quick start

Requirements: Node.js 18 or newer, a Minecraft Java server, and an AMD Radeon
Cloud Token Factory API key (or a compatible OpenAI-style endpoint).

```sh
npm ci                         # also installs the repository's 26.3 data patch
cp .env.example .env           # fill in API_KEY and your server address
npm start                      # Zinc
npm run start:zincai            # or ZincAI
```

Set `MC_HOST`, `MC_PORT`, and `MC_AUTH` in `.env` or the process environment.
Leave `MC_VERSION` empty for protocol auto-detection, or pin a tested version.
With `MC_AUTH=offline`, the Minecraft server must also be in offline mode and
whitelist the corresponding name. Zinc defaults to `MC_USERNAME=Zinc`; ZincAI
ignores `MC_USERNAME` and always logs in as `ZincAI`.

The AMD key can be supplied as `API_KEY`, `AMD_API_KEY`, or
`RADEON_API_KEY`. `AMD_API_BASE_URL` defaults to
`https://developer.amd.com.cn/radeon/api/v1`. The default model differs by
harness (`DeepSeek-V4-Flash-0731` for Zinc, `Qwen3.8-Flash-Next` for ZincAI);
set `AMD_MODEL` to an endpoint-supported model. Do not put real credentials in
`zincai/config.json` or commit a `.env` file.

> **Credential warning:** this repository previously tracked a real `.env`.
> The current change removes it from Git tracking, but the key may remain in
> repository history. Treat it as exposed and rotate/revoke it in the AMD
> dashboard. Keep your local `.env`; it is ignored by Git.

## Behavior and safety

- **Flee first.** The survival body recognizes hostile mobs that can see or
  reach the bot, immediate hazards such as lit creepers, and entities that
  recently hurt it. Pets, named mobs, decorative entities, and peaceful players
  merely nearby are not treated as active threats. A player who hits the bot
  triggers a flee and a named wake-up, not retaliation. The escape route is
  planned over the ground the bot can actually walk (no walls, drops or dead
  ends when there is a way out), one escape is reported as one episode, and
  both harnesses are told what the body did by itself: that it is fleeing, or
  that it fled, from what and how far.
- **The model owns the fight decision.** `idle` keeps the bot fleeing. `attack`
  is the only way a fight starts. Mob attacks require the exact type or
  `any` (hostiles only), line of sight, and a non-protected target. PvP requires
  an explicit exact player name; `player` and `any` never select a player.
- **One owner for movement.** Survival, combat, and task lanes arbitrate
  movement goals and keys (`survival > combat > task`) so concurrent behavior
  does not leave controls held or cancel a more urgent flee.
- **Vanilla-only operation.** No RCON, console commands, teleportation, or
  server cheats. Slash-prefixed chat is blocked; the guarded ZincAI whisper
  helper constructs `/msg` itself for an online player.
- **Reconnects.** A failed first join (including a whitelist rejection) is
  fatal. After a successful spawn, both harnesses can retry a dropped
  connection/server restart with backoff and the same username.

## How the two harnesses differ

### Zinc (`src/`)

A small, low-token harness. A quiet server does not trigger model requests;
only addressed chat and important deltas do. The prompt contains vitals, a
short event buffer, and the nearby-threat line rather than ZincAI's fuller
inventory/place observation. Chat replies are constrained to 10 words and
100 characters while preserving accents. The action response is one JSON
object such as `{"a":"move","x":12,"y":64,"z":-4}`. Walks run in the
background through the task lane, so the agent can still process a new threat
or chat while moving. Zinc shares control, threat sensing, and flee-reflex
modules from `zincai/`.

Relevant environment settings include `MC_USERNAME` (default `Zinc`),
`MC_CAN_DIG` (default `false`), `INFERENCE_MIN_INTERVAL_MS`,
`INFERENCE_IDLE_INTERVAL_MS`, `INFERENCE_TICK_MS`, `REFLEX_TICK_MS`,
`CHAT_COOLDOWN_MS`, and `RECONNECT` (default `true`). See `src/config.js` for
bounds and defaults.

### ZincAI (`zincai/`)

A fuller agent with an independent chat-reply lane and an action-planning lane
(a reply never waits for the body's call, and part of the call budget is
reserved for chat).
Its action schemas are in `zincai/api_wrapper.js`; it sends
`tool_choice: "required"` and falls back to `"auto"` if the endpoint rejects
that setting. If a compatible endpoint ignores tools and returns JSON text, the
client has a compatibility fallback. ZincAI uses `zincai/config.json` plus
these environment overrides: `MC_HOST`, `MC_PORT`, `MC_VERSION`, `MC_AUTH`,
`AMD_API_BASE_URL`, `AMD_MODEL`, `AMD_API_KEY`/`API_KEY`, `ZINC_DATA_DIR`, and
`LOG_LEVEL`. The bot name is fixed to `ZincAI`.

Its action tools are `say`, `go_to`, `follow`, `stop`, `attack`, `hold`,
`look_in`, `take`, `put`, `smelt`, `sleep`, `give`, `eat`, `equip`,
`use_block`, `find`, `remember_here`, `craft`, `build`, `build_shape`,
`run_script`, `set_mode`, and `idle`. The chat lane has one `reply` tool with
optional task hand-off. There is no `behavior.friends` list or `pvpEnabled`
switch.

For ZincAI configuration, feature details, persistence, tool semantics, and
known limits, see [`zincai/README.md`](zincai/README.md).

## Checks and tests

```sh
npm test
npm run check
node zincai/index.js --check
API_KEY=rc-dummy node src/index.js --dry-run
API_KEY=rc-dummy node zincai/index.js --dry-run
```

The unit/session suites use mocked Mineflayer bots and a scripted local model;
they do not call the real AMD API or join a production server.

[`audit/REPORT.md`](audit/REPORT.md) is a pre-release audit of both harnesses
against five play scenes; [`audit/FIXES.md`](audit/FIXES.md) lists what was
fixed afterwards, how each fix was checked and what is still open.
`audit/repro/*.js` are the scripts behind the numbers (`node audit/repro/<name>`
from the repository root).

### Local Minecraft loopback E2E

A separate, opt-in loopback rig starts a local `flying-squid` server, a local
mock model endpoint, and the real Zinc and/or ZincAI process. Gabriel is a
plain Mineflayer client. It exercises login, player visibility, Portuguese
chat, real pathfinding, a player-hit/flee scene, explicit player combat, and a
zombie scene with “no attack before the model decides.” It is deliberately not
part of `npm test` and never sends a real API key to the mock endpoint.

```sh
npm ci
cd test/e2e
npm install
node loopback.js                 # both harnesses (1.16.5; takes a few minutes)
node loopback.js --only=zinc     # Zinc only
node loopback.js --only=zincai  # ZincAI only
```

The rig's logs go to `test/e2e/logs/` (ignored by Git). Its `flying-squid`
server includes small compatibility patches for the tab list and knockback.
Its mobs do not provide normal mob AI, so the run is not evidence of survival
against a live hostile mob. It does not verify the real AMD endpoint, `/msg`,
Java 26.3, or production-server behavior. See the E2E script header for the
exact scope.

## Java 26.3 data patch

`npm ci` runs `scripts/apply-26.3-data.js`, which installs vendored,
unmerged `minecraft-data` files into `node_modules` and adjusts dependency
version maps. It does not change repo source or the server. The data is
unofficial and has not been verified against a live 26.3 server from this
sandbox. Prefer version auto-detection or a server version verified in your
environment; treat 26.3 protocol/data behavior as unconfirmed.

## Development notes

- `npm run ping` checks server status/version without joining or calling the
  model.
- Runtime memory and place data go under `zincai-data/` by default (ignored by
  Git); set `ZINC_DATA_DIR` to a persistent writable directory for ZincAI.
- `zincai/README.md` documents the ZincAI tool/action and survival policies.
- All local edits are branch-scoped; no deployment or live-server changes are
  performed by the test commands.

MIT License.
