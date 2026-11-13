# Putting ZincAI into PufferPanel — a guide

Written against **PufferPanel v3** source, not against the marketing docs. The
relevant files, if you want to check my work:

| What | Where |
| --- | --- |
| Template scanning rules | [`services/templates.go`](https://github.com/pufferpanel/pufferpanel/blob/v3/services/templates.go) (`Get`, `validateRepoOnDisk`) |
| Template REST API | [`web/api/templates.go`](https://github.com/pufferpanel/pufferpanel/blob/v3/web/api/templates.go) |
| Save-from-UI behaviour | [`client/frontend/src/views/TemplateCreate.vue`](https://github.com/pufferpanel/pufferpanel/blob/v3/client/frontend/src/views/TemplateCreate.vue) |
| Variable model | [`variable.go`](https://github.com/pufferpanel/pufferpanel/blob/v3/variable.go) |
| Console input | [`web/daemon/server.go`](https://github.com/pufferpanel/pufferpanel/blob/v3/web/daemon/server.go) (`postConsole` → `server.Execute`) |
| Template format docs | <https://docs.pufferpanel.com/en/3.x/templates/templates.html> |

## The two things nobody tells you

1. **There is no "Templates → Import" button.** Templates get into the panel in
   exactly two ways: **Templates → New** (typed/pasted into the web UI, stored in
   the panel's database as repo `0` / "Local") or **Templates → Add repo** (the
   panel clones a git repo and reads templates from it).
2. **There is no template folder on disk.** `services.Template.GetAllFromRepo`
   only ever reads `os.ReadDir` over a **cloned git repository** in
   `<daemon.data.cache>/template-repos/<repoID>/`. So copying a JSON into
   `/var/lib/pufferpanel/templates` — which our old docs told you to do — creates
   a file the panel never looks at.

And the scanning rule that trips everyone up:

```
<repo-root>/
├── <subfolder>/            <- must be a subfolder; the root is NOT scanned
│   ├── <name>.json         <- template name = file name (minus .json)
│   └── README.md           <- optional, shown on the template page
```

- Files at the repository root are **ignored**.
- A file named `data.json` is **skipped**.
- Hidden folders (`.*`) are skipped.
- On the repository path the JSON's own `name` field is **not** used — the file
  name is. The `name` field only matters for the web-UI paste path.

## Path A — add this repository (recommended)

The template already lives at `pufferpanel/zincai.json` with a `README.md` next
to it, which is exactly the layout above.

1. Push the branch you want to run (this repo's `main`).
2. Panel → **Templates** → **Add repo**:

   | Field | Value |
   | --- | --- |
   | Name | `ZincAI` |
   | Url | `https://github.com/<you>/minecraft-harness.git` — fork this repo first |
   | Branch | `main` |

3. The template appears immediately as **`zincai`** → display name
   **Minecraft Agent (ZincAI)**.

The panel keeps a local clone and pulls it at most every 5 minutes, so a later
push to `main` shows up on its own.

Private fork? Use the SSH URL and put a deploy key on the node, or the
credentials fields on the repo entry.

## Path B — paste it into the web UI

No git access on the node? On any machine with this repo:

```sh
node pufferpanel/import.js --print > zincai-template.json
```

Then panel → **Templates** → **New** → **Json** tab → paste the file →
**Save**. Name it `zincai` (that is the name in the JSON).

This one is stored in the panel's database, so it does **not** follow the
repository: after a template change you paste again. Prefer Path A.

## Making your own template repository

```sh
node pufferpanel/import.js --dir /srv/zincai-templates --apply
# /srv/zincai-templates/zincai/zincai.json
# /srv/zincai-templates/zincai/README.md
cd /srv/zincai-templates && git init && git add . && git commit -m templates && git push
```

Then **Add repo** pointing at *that* repository.

Anything else `import.js` can do:

```sh
node pufferpanel/import.js           # validate the template, explain both paths
node pufferpanel/import.js --dir X   # dry run: print exactly what it would write
node pufferpanel/import.js --print   # the JSON for the web UI (adds the name)
```

## Step 3 — create the server

**Servers** → **New server**:

| Field | Value |
| --- | --- |
| Name / id | anything, e.g. `zinc` |
| Template | `zincai` (under the repo you added, or under **Local**) |
| Environment | **host** (Node installed by the panel) or **docker** |

Then the variables. The minimum to get a bot in the world:

| Variable | What to put |
| --- | --- |
| `apikey` | your `rc-...` Radeon Cloud key → becomes `AMD_API_KEY`, never a file |
| `host` | the Minecraft server's address, not the panel's |
| `port` | the Minecraft port (25565), not the panel port |
| `auth` | `offline` for a private/offline-mode server, `microsoft` for premium |
| `operators` | **your Minecraft UUID**, comma-separated — without it chat control is refused |

Everything else has a working default. The Full list is in
[`pufferpanel/README.md`](../pufferpanel/README.md#2-create-the-server).

### Which address for `host`?

- Server on the same machine as the node → `127.0.0.1` (host env) or
  `host.docker.internal` (docker env).
- Server elsewhere → its LAN/public address.
- Never the panel's own port.

### The server must accept the bot

The login name is hard-coded to **`ZincAI`**. With `auth = offline` the
Minecraft server must run `online-mode=false`, and if it has a whitelist,
`ZincAI` has to be on it. A rejected first join is fatal by design.

## If the template is greyed out: "Incompatible with environment"

This is a **browser-side** filter, not a failure of your board. `SelectTemplate.vue`
compares strings, exactly:

```js
supportedEnvironments.some(e => e.type === env)      // env, os, arch come from
!requirements.os   || requirements.os === os         // GET /daemon/features on
!requirements.arch || requirements.arch === arch     // the node you picked
```

PufferPanel implements `host`, `tty` and `standard` with **one** environment
(`servers/env_loader.go` maps all three to `CreateTTYEnvironment`), but if your
node reports `tty`, a template that only lists `host` will not match. That was a
real bug in this template; it now declares all three plus `docker`.

Diagnose your own node:

```sh
node pufferpanel/doctor.js --env tty --os linux --arch arm64
node pufferpanel/doctor.js --env docker        # if you want the Docker env
```

It prints the exact three predicates and explains the failure. The node's own
answer is in **Nodes → \<your node\>** (or `GET /api/nodes/<id>/features`):

```json
{ "environments": ["host","tty","standard"], "os": "linux", "arch": "arm64" }
```

### On an Orange Pi 5 / Raspberry Pi specifically

Nothing in this project is architecture-specific — it is plain Node.js, and the
only native dependency (`minecraft-protocol`'s crypto) ships prebuilt for
`linux/arm64`. On a **host** node, PufferPanel's `nodejsdl` downloads
`node-v22-linux-arm64.tar.xz` itself and symlinks `node22`/`npm22`, so do not
install Node by hand. What *can* bite on a small ARM board:

| Symptom | Cause / fix |
| --- | --- |
| Install succeeds, Start dies at once | Out of RAM (a 4 GB board is fine; 1–2 GB boards need swap). `--dry-run` needs ~150 MB, a full session more. |
| `npm ci` killed mid-install | Same: add swap, or set the Install memory limit higher. |
| Bot joins then the panel shows it stopped | `autorestart` is `false`; a crash is a crash. Read the console. |
| Slow replies, timeouts | The model runs in the cloud; latency is the endpoint, not the board. |
| "Unsupported environment on the selected node" | The node advertises nothing (`docker.disallowHost=true` in the daemon config removes host/tty/standard). |

## Two entries, one of them blank

PufferPanel scans your repo rather than looking for a specific file: **every
non-dot top-level folder**, and **every `*.json` directly inside it** except
`data.json`, becomes a template named after the file (`services/templates.go`).
A JSON that is not a template is still listed — no display name, no
`supportedEnvironments` — so it sits there blank and can never be used.

If you see a nameless greyed-out entry next to the real one, that is a stray
`<folder>/<file>.json` in the repo you forked. Check with:

```sh
node pufferpanel/doctor.js --scan .      # non-zero if anything is not a template
```

The bot's defaults file moved to `zincai/config/defaults.json` for exactly this
reason — at `zincai/config.json` it was being imported as a nameless template.

### After updating: sync your fork

The `repo` variable points at **your** fork, so a fix merged upstream does not
reach the panel until your fork has it (`git pull` the default branch, or
"Sync fork" on GitHub), **and** the panel's 5-minute template cache expires.
Both of those are common reasons for "I applied the fix and nothing changed".

## Step 4 — install and start

Press **Install**. On a host node the template:

1. refuses to run if `git` is missing;
2. clones `repo`/`branch` into the server directory (or fetches/checks out on
   re-install);
3. downloads Node.js (`nodejsdl`, `nodeversion` = 22) and uses `node22`/`npm22`;
4. runs `npm ci --omit=dev` (which also applies the vendored 26.3 data patch);
5. creates `datadir` (`data/`).

Press **Start**. The `run.pre` step runs `node22 zincai/index.js --dry-run`
first: it prints the resolved server, endpoint, data dir, behaviour, limits and
a `control:` line, and exits non-zero on a bad variable — the bot never touches
the network with a broken config. Then the real process starts.

Watch the console for:

```
[info] zincai control: prefix="!zinc" operators=1 console=stdin joinOnStart=yes
```

`operators=NONE` means chat commands are closed and only the console works.

## Step 5 — drive it without restarting

The panel's **Console** tab sends your line to the process's stdin, so a command
is typed bare (no prefix), one line, then Enter:

```
status
config show boundary
config set boundary.radius 48
stop
resume
```

`stop` pauses the body and suspends goals without deleting anything; `leave`
disconnects but keeps the process and console; `join` brings the link back. In
Minecraft chat the same commands go behind the prefix (`!zinc status`) and are
answered by whisper, for the UUIDs in `operators` only.

**Stop button** = `SIGINT` (`stopCode: 2`) → graceful shutdown: save memory and
places, quit the bot, print a summary. Runtime data survives, including
`datadir/runtime-config.json`, so your `config set` changes are still there on
the next start.

## Troubleshooting, by symptom

| Symptom | Cause |
| --- | --- |
| Repo added, **no template listed** | The JSON sits at the clone root instead of a subfolder, or is named `data.json`. |
| Repo shows a clone error | Wrong branch name, or the node can't reach the URL (private repo without a deploy key/PAT). |
| Template list looks stale after a push | The panel caches the clone for ~5 minutes. |
| Template saves from the UI but is nameless | The pasted JSON had no `name` field — use `import.js --print`. |
| Install fails at `npm ci` | Node too old on the node, or no network to the npm registry. |
| Start fails immediately | Read the `--dry-run` output above the failure: it names the bad variable. |
| Template greyed out, "Incompatible with environment 'host'" | The browser-side env match — see the section above; run `node pufferpanel/doctor.js --env <what the node reports>`. |
| Bot can't join | Wrong `host`/`port`, server not in offline mode, or `ZincAI` not whitelisted. |
| `!zinc status` in chat is ignored | `operators` is empty, or your UUID is wrong — check the `control:` line and `config show control`. |
| Console commands do nothing | The process isn't running (a stopped server has no stdin). |
| Bot stops as soon as it starts | Both restart flags are `false`, so an exit stays an exit. Read the console: the `--dry-run` preflight prints the invalid variable above the failure. |
| Bot comes back a few seconds after pressing **Stop** | `run.autorecover` is `true` in your fork. The panel's Stop does not set `skipRestart`, so a signal death (exit 130) is classed as a crash. Set it to `false` — see [the README](../pufferpanel/README.md#why-autorecover-is-false). |
| **No template listed at all** | The panel could not decode the JSON and skipped the file silently. Run `node pufferpanel/doctor.js` — a `decoder:` line other than `OK` names the field. See [the README](../pufferpanel/README.md#it-does-not-show-up-at-all-nothing-listed-no-error). |
