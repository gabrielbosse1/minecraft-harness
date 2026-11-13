# PufferPanel

Everything needed to run the bot as a PufferPanel 3 server.

```
pufferpanel/
  zincai.json   the template (import this)
  import.js     validates it and copies it into the panel's template directory
```

## 1. Install the template

From a checkout on the panel node:

```sh
node pufferpanel/import.js                      # validate, print the target path
node pufferpanel/import.js --dir /var/lib/pufferpanel/templates --apply
```

`--apply` needs write access to that directory — run it as the `pufferpanel`
user, or use **Templates → Import** in the web UI and paste `zincai.json`
instead. Restart PufferPanel so it loads the template.

## 2. Create the server

Pick **Minecraft Agent (ZincAI)** on the create-server page. The variables are
grouped as Endpoint, Minecraft Server, Behaviour, Limits and Installation.

| Variable | Environment | Default | Notes |
| --- | --- | --- | --- |
| `apikey` | `AMD_API_KEY` | — | `rc-...` key. Required. Never written to disk. |
| `model` | `AMD_MODEL` | `Qwen3.8-Flash-Next` | Any alias the endpoint serves. |
| `amdurl` | `AMD_API_BASE_URL` | AMD shared endpoint | Change only for a proxy. |
| `host` | `MC_HOST` | `127.0.0.1` | Server the bot joins. |
| `port` | `MC_PORT` | `25565` | The Minecraft port, not the panel port. |
| `mcversion` | `MC_VERSION` | *(empty)* | Empty = auto-detect the server version. |
| `auth` | `MC_AUTH` | `offline` | `offline` or `microsoft`. |
| `mode` | `BOT_MODE` | `explorer` | `explorer`, `hunter`, `builder`. |
| `aliases` | `BOT_ALIASES` | `zinc` | Comma-separated chat names. |
| `language` | `BOT_LANGUAGE` | `pt-BR` | Reply check; empty disables it. |
| `candig` | `MC_CAN_DIG` | `false` | Break blocks it does not own. |
| `scaffolding` | `MC_ALLOW_SCAFFOLDING` | `false` | Place/remove scaffolding while building. |
| `elytra` | `MC_AUTO_ELYTRA` | `true` | Glide across long gaps. |
| `rpm` | `INFERENCE_RPM` | `18` | Shared model-call budget per minute. |
| `mininterval` | `INFERENCE_MIN_INTERVAL_MS` | `3000` | Spacing between action calls. |
| `heartbeat` | `INFERENCE_HEARTBEAT_MS` | `90000` | Self-prompt when idle; `0` disables. |
| `reconnect` | `RECONNECT` | `true` | Retry a dropped link after a spawn. |
| `maxattempts` | `RECONNECT_MAX_ATTEMPTS` | `40` | Retry cap before the process exits. |
| `log` | `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `datadir` | `ZINC_DATA_DIR` | `data` | Relative to the server folder, so backups include it. |
| `repo`, `branch`, `nodeversion` | — | this repo / `main` / `22` | Installation only. |
| `autostart`, `autorecover` | — | `true` | Panel behaviour. |

Nothing else is needed: no `.env`, no file to edit, no command to type. The
template passes the values in `run.environmentVars` and the bot reads them
through `src/settings.js`.

### The server must allow the name

The login name is fixed to **`ZincAI`**. For `auth = offline` the Minecraft
server must also run in offline mode (`online-mode=false`) and whitelist
`ZincAI` if a whitelist is on. A rejected first join is fatal by design —
that is a configuration error, not something to retry.

### Where the Minecraft server is

If the Minecraft server runs on the same machine as the panel node, `host`
should be the address the panel process can reach, not the panel's own port:

- host environment: `127.0.0.1` (or the LAN address of the server)
- Docker environment: `host.docker.internal` (or the host's LAN address)

## 3. What install and start do

Install:

1. refuses to continue if `git` is missing;
2. clones `repo`/`branch` into the server directory (or fetches/checks it out on
   re-install);
3. installs Node.js on host nodes (`nodejsdl` → `node22`, `npm22`) — the Docker
   image already ships it;
4. runs `npm ci --omit=dev` (which also applies the vendored 26.3 data patch);
5. creates the data directory.

Every start:

1. runs `node zincai/index.js --dry-run` as a **pre** step. It prints the
   resolved server, endpoint, data directory, behaviour switches and limits and
   exits non-zero if a variable is invalid, so a bad deployment fails before it
   touches the network;
2. runs `node zincai/index.js` (host: `node22`, Docker: `node`).

Stop sends `SIGINT` (`stopCode: 2`), which is the bot's graceful shutdown: it
saves memory and places, quits the bot and prints a session summary.

## 4. Verifying a deployment

```sh
npm run ping                    # is the Minecraft server reachable/which version
AMD_API_KEY=... npm run canary  # endpoint, auth and tool-call support
npm run dry-run                 # the same preflight the panel runs
npm run check                   # syntax-check every module
```

The panel's **Console** shows the same lines the preflight prints, so a
variable that is wrong is visible there before the bot joins anything.

## Updating the bot

Change `branch` (or push to it) and press **Install** again: the template
fetches the branch, checks it out and reinstalls dependencies. Runtime data in
`datadir` is left alone.

## Requirements

- PufferPanel 3.x
- `git` on the node (host environment)
- Node.js 18+ — installed by the template on host nodes; the Docker
  environment uses `node:${nodeversion}-bookworm-slim`
- a `rc-...` AMD Radeon Cloud key
- a Minecraft server in offline mode (or a premium account for
  `auth = microsoft`)
