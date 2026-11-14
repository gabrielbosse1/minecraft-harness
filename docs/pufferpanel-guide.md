# Deploying ZincAI on PufferPanel v3

This guide walks through installing and running ZincAI on **PufferPanel v3**.

---

## How PufferPanel v3 Loads Templates

PufferPanel v3 does **not** have a "Templates → Import" button or a drop-in templates directory on disk. Templates are loaded in exactly two ways:

1. **Git template repository (recommended):** **Templates → Add repo**. PufferPanel clones the repo into its cache and scans `<repo-root>/<subfolder>/<name>.json`. Files at the repo root, hidden folders, and `data.json` are ignored.
2. **Manual JSON paste:** **Templates → New → Json**. Stored locally in PufferPanel's database; does not auto-update when the repo changes.

This repository already matches PufferPanel's expected layout:

```text
minecraft-harness/
└── pufferpanel/
    ├── zincai.json    # template id "zincai"
    └── README.md      # shown on the panel template page
```

---

## Step 1 — Add the Template

### Option A: Add Repository (Recommended)
1. In PufferPanel, open **Templates → Add repo**.
2. Set:
   - **Name:** `ZincAI`
   - **URL:** `https://github.com/gabrielbosse1/minecraft-harness.git` (or your fork)
   - **Branch:** `main`
3. Save. Template **`zincai`** (**Minecraft Agent (ZincAI)**) appears immediately and refreshes automatically on future pushes.

### Option B: Paste JSON into Web UI
On a machine with this repository checked out:

```sh
node pufferpanel/import.js --print > zincai-template.json
```

In PufferPanel, open **Templates → New**, switch to the **Json** tab, paste `zincai-template.json`, and click **Save**.

---

## Step 2 — Create the Server

1. Open **Servers → New server**.
2. Select template **`zincai`** and choose either the **host** environment or **docker** (`node:22-bookworm-slim`).
3. Fill in the required variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `apikey` | Yes | — | OpenAI-compatible API key (`AMD_API_KEY`, passed via env, never written to disk) |
| `host` | Yes | `127.0.0.1` | Target Minecraft server hostname/IP |
| `port` | Yes | `25565` | Target Minecraft server port |
| `auth` | Yes | `offline` | `offline` (whitelisted/cracked/private) or `microsoft` (premium account) |
| `mcversion` | No | `""` | Minecraft version (e.g. `1.21.4`), or blank to auto-detect |
| `model` | Yes | `Qwen3.8-27B` | LLM model identifier |
| `amdurl` | Yes | `https://developer.amd.com.cn/radeon/api/v1` | OpenAI-compatible API base URL |
| `repo` | Yes | `https://github.com/gabrielbosse1/minecraft-harness.git` | Git URL cloned during Install |
| `branch` | Yes | `main` | Git branch cloned during Install |
| `datadir` | Yes | `data` | Persistent runtime data & telemetry folder (`ZINC_DATA_DIR`) |

Optional pacing/lifecycle variables (`rpm`, `mininterval`, `loop`, `heartbeat`, `maxattempts`, `log`, `entrypoint`, `nodeversion`, `dockerimage`) ship with tested defaults. See [`pufferpanel/README.md`](../pufferpanel/README.md) for the full 19-variable table.

---

## Step 3 — Install & Start

1. Click **Install**. PufferPanel clones the repo, checks Node.js, installs npm dependencies (applying protocol patches via `postinstall`), and initializes the `data/` directory.
2. Click **Start**. The startup script runs `node zincai/index.js --dry-run` first so misconfigured variables fail fast in the console before touching the network, then starts ZincAI.

---

## Step 4 — Operator Control via PufferPanel Console

In-game chat is **never** a command channel. All operator control runs directly in PufferPanel's **Console** input (bare commands, no prefix):

- `status` — Connection state, position, health, active goals, limits, paused status
- `pause` / `stop` — Pause all physical body primitives immediately and suspend open goals
- `resume` — Unpause, reconcile goals against the world, and continue
- `leave` / `join` / `restart-connection` — Disconnect or reconnect without restarting Node.js
- `goals` / `jobs` / `cancel <goal-id>` — Inspect or cancel goals and jobs
- `config show` / `config set <key> <value>` / `config reset <key>` — View or adjust the 10 runtime parameters
- `update [check|force]` / `restart` / `shutdown` — Update source, restart, or stop cleanly

---

## Diagnostics

Before deploying or after modifying `pufferpanel/zincai.json`, run:

```sh
npm run pufferpanel:validate   # schema & PufferPanel v3 compatibility check
npm run pufferpanel:doctor     # deep checks (repo reachability, variable wiring, install steps)
```
