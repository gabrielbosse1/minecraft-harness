# mineflayer-zinc

Autonomous **Minecraft Java** agent built on [Mineflayer](https://github.com/PrismarineJS/mineflayer),
driven by the **AMD Radeon Cloud Token Factory API** (free tier — DeepSeek-V4-Flash-0731 by default).
The bot plays as **Zinc** on a single whitelist-only server: it chats, moves, fights, flies,
and stays silent unless the world changes.

Design goals, in order:

1. **Minimal token burn.** A short, *static* system prompt (≤150 words) plus *delta-only*
   user messages (vitals/inventory/chat/events that actually changed). The static prefix
   keeps KV-cache hit rates high on the AMD side; the session summary printed at shutdown
   reports calls, cached tokens, and KV hit-rate.
2. **Never blow up, never impersonate.** The bot always joins as `Zinc`. **Any** join
   failure (kick, error, disconnect before spawn) is fatal — the process exits with code 1
   instead of retrying or renaming. One whitelist, one identity.
3. **No block chewing.** Pathfinder navigation with `canDig=false` by default; the bot
   detours or jumps rather than mining your world.

## Quick start

```bash
npm ci                 # installs deps AND applies the Java 26.3 support patch (postinstall)
cp .env.example .env   # then fill in your values (see below)
npm run dry-run        # validates config + prompt budget, touches no network
npm start              # joins the server
```

Node.js ≥ 18 required. Java itself is **not** required — the protocol stack is pure JS.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEY` | — (**required**) | Radeon Cloud Token Factory key, `rc-...`. Also accepted: `AMD_API_KEY`, `RADEON_API_KEY`. Never logged. |
| `AMD_API_BASE_URL` | `https://developer.amd.com.cn/radeon/api/v1` | Chat-completions endpoint (OpenAI-compatible). Override for other regions/proxies. |
| `AMD_MODEL` | `DeepSeek-V4-Flash-0731` | Any model your Token Factory key can call (e.g. `Qwen3.8-Flash-Next`). |
| `AMD_API_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `AMD_API_MAX_RETRIES` | `2` | Retries on 5xx/network/429 (with backoff). |
| `AMD_MAX_TOKENS` | `96` | Action output is one line of JSON (<40 tok). 96 is headroom, not permission to ramble. |
| `AMD_TEMPERATURE` | `0.25` | This is control flow, not creative writing. |
| `MC_HOST` | `127.0.0.1` | Server host. |
| `MC_PORT` | `25565` | Server port. |
| `MC_USERNAME` | `Zinc` | **Keep `Zinc`.** Overriding logs a loud warning; join failures are still fatal. |
| `MC_VERSION` | *(empty = auto-detect)* | Recommended: leave empty — the client pings the server for its version. Set explicitly (e.g. `26.3`) to skip auto-detect. |
| `MC_AUTH` | `offline` | `offline` for cracked/private (whitelist) servers; `microsoft` with a real account. |
| `MC_CAN_DIG` | `false` | Allow pathfinder to break blocks for navigation. |
| `INFERENCE_MIN_INTERVAL_MS` | `3000` | Minimum spacing between AMD calls (stays under the ~20 RPM free tier). |
| `INFERENCE_IDLE_INTERVAL_MS` | `15000` | Backoff after an idle answer. |
| `MAX_SELF_CHAIN` | `12` | Cap on back-to-back non-idle actions before a forced breather. |
| `CHAT_COOLDOWN_MS` | `3000` | Bot won't spam chat faster than this. |
| `ENGAGE_RADIUS` | `24` | Mob/player engagement scan radius (combat). |
| `ATTACK_COOLDOWN_MS` | `600` | Min ms between swings. |
| `DISENGAGE_COOLDOWN_MS` | `10000` | After fleeing (≤30% HP), won't re-engage for this long. |
| `ELYTRA_MIN_FALL` / `ELYTRA_GAP_BLOCKS` | `4` / `24` | Elytra deployment heuristics. |

The bot expects the server to whitelist **`Zinc`**. If `MC_AUTH=offline`, the server must be
in offline mode as well (whitelist names are compared, not UUIDs).

### What you'll see at runtime

- Every AMD call logs its prompt size; `/shutdown` (SIGINT/SIGTERM) prints a session summary:
  `requests`, `failures`, `avg prompt tokens/call`, `cached tokens`, `kv-hit-rate`.
- If the AMD key is missing or the server rejects the join, the process exits **before**
  wasting tokens: config is validated first, then the join is attempted exactly once.
- If the LLM returns unusable output, the bot idles — it never crashes on a bad completion.

## Java Edition 26.3 support (unofficial data)

**There is no npm release of `minecraft-data` containing pc/26.3** (latest at time of
writing: `minecraft-data@3.119.0`, latest official version 26.1). This repo therefore ships
**unmerged PR data**, pinned and integrity-checked:

- Source: https://github.com/PrismarineJS/minecraft-data/pull/1345
  (commit `312f3cada17a7d9e2e1a1834fe26f17296163096` of `suisarbre/minecraft-data@port-26.3`,
  the tail of the stacked series #1300 → #1301 → #1345, `mergeable: clean`)
- Vendored files: `vendor/minecraft-data-26.3/pc-26.3/` with a SHA-256 manifest
  (`vendor/minecraft-data-26.3/VENDORED.md` — `sha256sum -c` verifies them)
- `npm ci` / `npm install` runs `scripts/apply-26.3-data.js`, which copies the data into
  `node_modules/minecraft-data` and patches *installed dependencies only* (never repo source):
  the lazy loader entry, `dataPaths.json`, mineflayer's `testedVersions`,
  minecraft-protocol's `supportedVersions`, the `prismarine-chunk` version map, and
  `prismarine-physics`'s feature table. All patches extend 26.1 behavior lists to 26.3 and
  **fail loudly** if an upstream anchor disappears after a dependency upgrade.

**Caveats**

- This is generated, unreviewed output. It works for login/play in theory but has not been
  smoke-tested against a live 26.3 server from this environment.
- `MC_VERSION` empty (auto-detect) is the safest setting; the client then negotiates
  whatever the server speaks.
- When the PR series merges and a new `minecraft-data` lands on npm, do:
  ```bash
  npm install minecraft-data@latest   # or first release containing pc/26.3
  git rm -r vendor scripts/apply-26.3-data.js
  # drop the "postinstall" line from package.json
  ```
  and verify with `npm ci && npm run dry-run && npm test`.

## Security

- **Never commit `.env`.** It carries your Radeon Cloud key. This repository currently has a
  committed `.env` — the key in it must be considered compromised: **rotate it** in the AMD
  Token Factory dashboard, and remove the file from tracking with `git rm --cached .env`
  (plus add `.env` to `.gitignore`). History rewriting is optional; rotation is mandatory.
- The key is never logged or sent anywhere except `AMD_API_BASE_URL`
  (`redactSecrets` scrubs `rc-…` values from logs and errors).
- No telemetry. The only outbound connections are `AMD_API_BASE_URL` and your Minecraft server.

## Development

```bash
npm test          # node:test suite (85 tests) — no network, loopback mocks only
npm run dry-run   # config + prompt validation
npm run check     # syntax-check every src module
npm run ping      # reachability + version check of the configured server (no join, no LLM call)
```

`npm run ping` exits 0 and prints the server's reported version, player count and MOTD
when the status handshake succeeds — run it before `npm start` if you are unsure whether
the tunnel is up or which version it speaks.

Agent loop, subsystems (combat AI, elytra controller, anti-stuck watchdog, chat guard,
action parser) are documented in the module headers under `src/`. The end-to-end harness
used for local verification runs Mineflayer against a loopback
[flying-squid](https://github.com/PrismarineJS/flying-squid) server — it lives outside the
repo (`/tmp/e2e/`) and is not required to run the bot.

## ZincAI (dual-process harness)

A second, self-contained harness lives in [`zincai/`](zincai/README.md):
a Pufferpanel-ready, Qwen 3.8 27B–tuned bot with System 1/System 2 dual-process
architecture, native OpenAI-compatible tool calling, FOV-frustum perception
plus 2D ASCII "vision", predictive threat mapping (`PredictiveThreatMap`) and
semantic structure/material clustering, 3-tier memory with
ephemeral action buffer and grep-first recall, mathematical shape primitives
(`build_shape`), scaffold-aware phased + idempotent building with automatic
scaffold removal, elite weapon-aware combat (85 % cooldown gate, crit timing,
mace panic, elytra dodge, perpendicular arrow strafing), wind-charge gap/wall
traversal, a vanilla-only Scout & Relocate startup (no commands, ever), and an
opt-in instant-PvP reflex.
It joins as **ZincAI** (the name mandated for it). See `zincai/README.md`.

## License

MIT
