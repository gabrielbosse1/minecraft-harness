# PufferPanel Template (`pufferpanel/`)

Files in this folder package ZincAI as a native **PufferPanel v3** server template:

```text
pufferpanel/
├── zincai.json   # PufferPanel v3 template definition (19 variables, 6 install steps)
├── import.js     # validates zincai.json, prints pasteable JSON, or scaffolds a template repo
├── doctor.js     # checks clone URL reachability, variable mappings, and install script hygiene
└── README.md     # displayed on the PufferPanel template detail page
```

---

## Adding the Template to PufferPanel v3

- **Recommended (Git Repo):** In PufferPanel, open **Templates → Add repo**, enter `https://github.com/gabrielbosse1/minecraft-harness.git` (or your fork) and branch `main`. PufferPanel scans `<subfolder>/<name>.json` and registers **`zincai`** automatically.
- **Manual UI Paste:** Run `node pufferpanel/import.js --print` and paste the output into **Templates → New → Json**.
- **Standalone Template Repo:** Run `node pufferpanel/import.js --dir /path/to/repo --apply` to copy `zincai.json` and `README.md` into the exact subfolder layout PufferPanel v3 scans.

---

## Template Variables (19)

| Variable | Type | Required | Default | Env Var | Purpose |
| --- | --- | --- | --- | --- | --- |
| `repo` | string | Yes | `https://github.com/gabrielbosse1/minecraft-harness.git` | — | Git repository cloned during Install |
| `branch` | string | Yes | `main` | — | Git branch checked out during Install |
| `entrypoint` | string | Yes | `zincai/index.js` | — | Node entrypoint executed on Start |
| `nodeversion` | string | No | `""` | — | Optional Node version pin for host env |
| `dockerimage` | string | No | `node:22-bookworm-slim` | — | Container image for Docker env |
| `apikey` | string | Yes | `""` | `AMD_API_KEY` | Inference API key (kept in env, never written to disk) |
| `model` | string | Yes | `Qwen3.8-27B` | `AMD_MODEL` | Model name |
| `amdurl` | string | Yes | `https://developer.amd.com.cn/radeon/api/v1` | `AMD_API_BASE_URL` | OpenAI-compatible endpoint base URL |
| `host` | string | Yes | `127.0.0.1` | `MC_HOST` | Minecraft server host |
| `port` | integer | Yes | `25565` | `MC_PORT` | Minecraft server port |
| `mcversion` | string | No | `""` | `MC_VERSION` | Minecraft version (e.g. `1.21.4`) or empty for auto-detect |
| `auth` | string | Yes | `offline` | `MC_AUTH` | `offline` or `microsoft` |
| `rpm` | integer | Yes | `18` | `INFERENCE_RPM` | Combined LLM calls-per-minute budget |
| `mininterval` | integer | Yes | `3000` | `INFERENCE_MIN_INTERVAL_MS` | Minimum ms between action-lane calls |
| `loop` | integer | Yes | `8000` | `INFERENCE_LOOP_MS` | Action loop cadence when idle |
| `heartbeat` | integer | Yes | `90000` | `INFERENCE_HEARTBEAT_MS` | Maximum idle backoff ceiling |
| `maxattempts` | integer | Yes | `40` | `RECONNECT_MAX_ATTEMPTS` | Reconnect attempts before exiting |
| `log` | string | Yes | `info` | `LOG_LEVEL` | Console log verbosity (`debug`/`info`/`warn`/`error`) |
| `datadir` | string | Yes | `data` | `ZINC_DATA_DIR` | Directory for persistent stores & session telemetry |

There are **no** behavioral mode switches, permission toggles, chat-command allowlists, or language overrides to configure.

---

## Validation & Troubleshooting

```sh
node pufferpanel/import.js    # validate JSON structure & PufferPanel v3 rules
node pufferpanel/doctor.js    # verify repo URL reachability & variable bindings
```

- **Template not listed after Add repo:** Ensure `zincai.json` stays inside a subfolder (`pufferpanel/`), is not named `data.json`, and parses cleanly (`npm run pufferpanel:validate`).
- **`git clone` asks for username/token during Install:** Point `repo` to a public clone URL or configure SSH deploy keys on the PufferPanel node.
- **Startup exits immediately:** Check the PufferPanel console output from the built-in `node zincai/index.js --dry-run` preflight check (most commonly a missing `apikey` or invalid `port`).
- **Controlling the running bot:** Type bare commands (`status`, `pause`, `resume`, `leave`, `join`, `goals`, `config show`, `shutdown`, `help`) directly in PufferPanel's console. See [`docs/pufferpanel-guide.md`](../docs/pufferpanel-guide.md).
