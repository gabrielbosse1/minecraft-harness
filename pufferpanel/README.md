# PufferPanel

Everything needed to run the bot as a PufferPanel 3 server.

```
pufferpanel/
  zincai.json   the template itself
  import.js     validates it, prints it for the web UI, or lays out a template repo
```

Verified against PufferPanel **v3** (`services/templates.go`, `web/api/templates.go`,
`client/frontend/src/views/TemplateCreate.vue`). Two things there are worth
knowing before you go looking for them:

- **There is no `Templates → Import` button.** Templates arrive either through
  **Templates → New** in the web UI (saved into the panel's database) or by
  adding a **git repository** with **Add repo**.
- **There is no template folder to drop a file into.** The panel clones a
  repository into its own cache and reads `<repo-root>/<subfolder>/<name>.json`.
  That is why `templates.x.json` must live under a folder, not at the root.

## 1. Get the template into the panel

Pick one of the two paths below. Both end with the template listed under
**Templates**.

### Path A — from the git repository (recommended, and it updates itself)

The repository already has the layout the panel wants, in `pufferpanel/`:

```
minecraft-harness/
└── pufferpanel/
    ├── zincai.json     -> template name "zincai"
    └── README.md       -> shown on the template page
```

1. Make sure the branch you want is pushed to a repository the panel node can
   reach (public, or with a deploy key / PAT configured on the repo entry).
2. In the panel: **Templates → Add repo**. Name `ZincAI`, Url
   `https://github.com/<you>/minecraft-harness.git`, Branch `main`.
3. The panel clones it and lists the template. It refreshes the clone every few
   minutes, so a push to the branch shows up without touching the panel.

> The repository root is what the panel scans, so the JSON must be inside a
> subfolder of the clone root. `pufferpanel/` is that subfolder; if you fork and
> move things, keep one folder per template with the `.json` inside it.

### Path B — paste it into the web UI (no git access needed)

```sh
node pufferpanel/import.js --print > zincai-template.json
```

Open **Templates → New**, switch to the **Json** tab, paste the file, **Save**.
The template name comes from the JSON's `name` field (`zincai`) — that field
exists only for this path, because a repository template takes its name from the
file name instead.

This path is a one-off: the panel stores it in its database, so it does not
follow the repository. Re-paste after a template change.

### Making your own template repository

If you want to host the template yourself instead of pointing at this repo:

```sh
node pufferpanel/import.js --dir /srv/zincai-templates --apply
# writes /srv/zincai-templates/zincai/zincai.json
#        /srv/zincai-templates/zincai/README.md
```

Commit that tree, push it, and add **that** repository in the panel.

Validate without writing anything at any time:

```sh
node pufferpanel/import.js          # checks the template, prints both paths
```

### If the panel shows the repo but no template

- The JSON is not in a subfolder — the panel ignores files at the clone root.
- The file is named `data.json` — that name is skipped by the scanner.
- The branch name in **Add repo** does not exist on the remote.
- The node has no network/git access to the URL: check the panel log for the
  clone error, and use an SSH URL plus a deploy key for a private repository.
- The JSON parses but does not **decode** into PufferPanel's structs — the file
  is skipped silently. See
  [It does not show up at all](#it-does-not-show-up-at-all-nothing-listed-no-error).

### One bad template does not break the others — one bad *repo* does

These are two different failures and they look identical from the browser.

**A bad file inside a repo is contained.** `GetAllFromRepo` reads each JSON
independently and `continue`s past one it cannot decode, so the other templates
in the same repo are still listed. A malformed template costs you that one
entry, nothing else. (A JSON that does not *parse* is worse: it is still listed,
as a nameless, permanently incompatible row — that is the "no name" section
below.)

**A repo that fails to list is not contained.** Look at what the frontend does
with the per-repo answer (`client/api/src/templates.js`):

```js
try   { templates = await this.listRepoTemplates(repo.id) }
catch (e) { error = e ... }            // templates stays undefined
res.push({ ...repo, templates, error })
```

and then (`SelectTemplate.vue`, `load()`):

```js
if (repos[repo].templates.length === 0) return   // no guard for undefined
```

`undefined.length` throws. That happens **before** any repo is added to the
list, so the create-server template step renders nothing — including templates
from repos that are perfectly healthy. The *Templates* page itself shows the
error per repo and keeps working; it is the **create-server** step that goes
blank.

`GET /api/templates/{repo}` returns 500 only when it cannot read the clone at
all: `validateRepoOnDisk` failing to clone or pull (bad branch, unreachable URL,
missing credentials), or `os.ReadDir` failing. A template that merely fails to
decode never produces a 500, so this template could not cause it. Check
**Templates** for a red error row, or run:

```sh
PUFFER_URL=... PUFFER_USER=... PUFFER_PASS=... node pufferpanel/doctor.js --refresh
```

It reports the clone error for the repo that is actually broken instead of
leaving you guessing.

### The panel scans the whole repository you point it at

**Add repo** points the panel at a repository and it scans **everything** in it.
If you add a repository that is not a template collection (this one, for
example, if you point at the root), every `*.json` a level inside a folder
becomes a candidate — some are templates, most are not. That is harmless in
itself (the bad ones are skipped or shown as nameless rows), but it is noise,
and it is why `pufferpanel/zincai.json` exists as a template-only subfolder.

The tidy setup is a **dedicated template repository** containing just:

```sh
node pufferpanel/import.js --dir /srv/zincai-templates --apply
# /srv/zincai-templates/zincai/zincai.json
# /srv/zincai-templates/zincai/README.md
```

Point **Add repo** at that, and nothing else in this repository can ever affect
the panel's template list.

### "Incompatible with environment 'host'" (Orange Pi, Raspberry Pi, any node)

The create-server page filters templates **in the browser**, with a strict string
comparison against what the node reports (`SelectTemplate.vue` →
`template.supportedEnvironments.some(e => e.type === env)`, where `env` comes
from `GET /daemon/features` on that node). PufferPanel implements `host`, `tty`
and `standard` with one and the same environment (`servers/env_loader.go`), but
a node that calls it `tty` will not match a template that only lists `host`.

The template now declares `host`, `tty`, `standard` and `docker`, and its
conditions treat all three host names alike, so this cannot happen again. To
check a template against your own node — including whether the board is the
problem, which it never is — run:

```sh
node pufferpanel/doctor.js --env tty --os linux --arch arm64   # what your node reports
node pufferpanel/doctor.js --env docker                        # if you use the Docker env
```

It prints the three real predicates (`env`, `os`, `arch`), says which one fails
and why, and names the host-family trap explicitly. Useful values: `--env` is
one of `host`, `tty`, `standard`, `docker`; get the node's own answer from
**Nodes → your node** or from `GET /api/nodes/<id>/features`.

If the panel *still* greys the template out:

| Check | Why |
| --- | --- |
| `--env docker` on a node without a working Docker socket | Docker is only advertised when the node can reach its socket. |
| A stale template in the panel | The panel caches the template repository for ~5 minutes; re-add the repo or wait. |
| `requirements.arch` / `requirements.os` in a **forked** copy | Those are single strings; `arch` cannot list both `x64` and `arm64`, so leave them out. |
| Node too old / wrong arch | Nothing here is architecture-specific; on a host node `nodejsdl` downloads `linux/arm64` (or `armv7l`) by itself. |

### It does not show up at all (nothing listed, no error)

A template the panel cannot **decode** is not greyed out — it is absent. The
scanner opens each JSON with `json.NewDecoder(file).Decode(&Template)` and, if
that returns an error, logs it and `continue`s (`services/templates.go`), so the
row simply never exists. The browser then shows an empty list, which looks like
a broken panel rather than a broken template.

The decoder is strict about the JSON type of every field, and several fields in
`run` are Go scalars rather than strings:

| Field | Go type | So |
| --- | --- | --- |
| `run.autostart` | `bool` | `true` / `false` only |
| `run.autorecover` | `bool` | `true` / `false` only |
| `run.autorestart` | `bool` | `true` / `false` only |
| `run.stopCode` | `int` | a number, never `"2"` |
| `run.stop`, `run.workingDirectory` | `string` | strings |

A `"${autostart}"` token in `run.autostart` is a **string**, so `Decode` fails
and the whole template disappears. That was a real bug in this template, and it
is why it is now gone:

- `run.autostart` is literal `true`; `run.autorecover` is literal `false` (see below).
- The `autostart` / `autorecover` **variables are gone**. There was never a way
  to forward them: the panel assigns those booleans per server, from the
  **Edit → flags** endpoint (`GET`/`POST /api/servers/{id}/flags`), not from a
  template variable. A variable by that name could only ever have been a
  string in a bool field.

Both checks in this repository now catch the class of bug:

```sh
node pufferpanel/import.js            # structural + Go-type validation
node pufferpanel/doctor.js            # adds the `decoder:` line
node pufferpanel/doctor.js --scan .   # DROPPED = the panel would skip the file
```

### Why `autorecover` is `false`

`autorecover` is not "keep the bot running". It is "restart after an exit that
is not the expected one" (`servers/server.go`, `afterExit`):

```go
graceful := exitCode == p.Execution.ExpectedExitCode
if p.skipAutoRestart { /* do nothing */ }
else if graceful && p.Execution.AutoRestartFromGraceful { StartViaService(p) }
else if !graceful && p.Execution.AutoRestartFromCrash   { StartViaService(p) }
```

`skipAutoRestart` is set by `/restart` and `/kill`, but **not** by `/stop`
unless the caller passes `?skipRestart=true` — and the panel's own Stop button
does not (`client/api/src/servers.js`, `action()` only sends `?wait=`). So a
plain Stop still reaches `afterExit`.

`stopCode: 2` sends SIGINT, and the bot exits **0** on it. `expectedExitCode` is
unset, i.e. 0, so that exit *is* graceful: with `autorestart: false` nothing
restarts. But if the process is killed by the signal instead of catching it,
Node reports `128 + 2 = 130`, which is not 0 — that is a "crash", and with
`autorecover: true` the panel restarts the bot seconds after the operator
pressed Stop. `expectedExitCode` cannot be set to cover both 0 and 130, so the
only correct value here is `autorecover: false`.

The consequence, stated plainly:

- **Stop really stops.** The process stays down until you press Start.
- **A genuine crash is not retried by the panel.** The bot already retries
  *connection* loss itself (`reconnect` / `maxattempts` variables) with
  back-off, which is the failure that actually happens in practice — a server
  restart, a lag spike, a kick. A process-level crash left the bot down before
  this template existed, and it leaves it down now.
- If you would rather have crash recovery and can accept the Stop-is-a-restart
  behaviour, set `"autorecover": true` in your fork. Prefer leaving it `false`.

### It shows up with no name (and stays "incompatible" forever)

PufferPanel does **not** look for "the template" in your repo. It scans *every*
non-dot top-level folder and loads **every `*.json` directly inside it** (except
`data.json`) as a template, named after the file (`services/templates.go`,
`GetAllFromRepo`). A stray JSON gets listed too — with **no display name** and no
`supportedEnvironments`, so it appears blank and can never match any environment.

That is why the same panel could show a nameless, greyed-out entry *and* still
say "incompatible": there were two entries, and only one of them was ours.
`zincai/config.json` (the bot's defaults) used to sit exactly in that scanned
position. It now lives one level deeper, at `zincai/config/defaults.json`, which
the scanner does not reach.

Check any copy of the repo the same way the panel reads it:

```sh
node pufferpanel/doctor.js --scan .        # PHANTOM = a file the panel will mis-list
```

`--scan` exits non-zero if anything in the repo is not a usable template, so it
also works in CI. Rule of thumb: **a `.json` at `<folder>/<file>.json` is a
template** unless the file is called `data.json` — no template JSON anywhere
else in the repo.

### The template vanished after an update

Usually not a disappeared file — usually the panel **failed to clone**. The repo
row is re-pulled by `git` on every cache miss, and while that pull is running
`validateRepoOnDisk` holds a lock; a failing pull (wrong branch name, private
repo with no credentials, network blip) makes the template list come back empty
or error, and the page shows nothing to pick.

Force it and see what the panel really has:

```sh
PUFFER_URL=http://127.0.0.1:8080 PUFFER_USER=admin PUFFER_PASS=... \
  node pufferpanel/doctor.js --refresh
```

`PUFFER_USER` is the account **email** (that is what `POST /auth/login` takes);
`PUFFER_PASS` is its password. It logs in the same way the browser does, then
deletes and re-adds each git template repository over the panel's own API
(`DELETE`/`POST /api/templates`). The new row gets a new id, so the panel has no
cached clone to reuse and the next listing clones from scratch. It then prints
what the panel really lists and checks each entry the same way the server does
(missing display name, or a JSON type the decoder rejects). Exit code is
non-zero if anything is still broken.

Over SSH on the node the equivalent is to delete the clone directory and reload
the page — but note the location is a **config value**, not a fixed path:

```sh
# the cache root is `daemon.data.cache` (default: <data folder>/cache)
sudo ls -d /var/lib/pufferpanel/cache/template-repos/*   # then remove the ones to refresh
```

If you are not sure where the panel keeps its data, check the `dataFolder` /
`daemon.data.cache` settings in the panel's config rather than assuming
`/var/lib/pufferpanel`.

Two things to check first, because they account for most of these:

| Check | Why it matters |
| --- | --- |
| The repo row's branch | It must be a branch that exists *in the repo it clones*. The template default is `main`. |
| Which repository is cloned | The row clones **its own stored URL**. If that is your fork, the fix must be on the fork's branch — upstream `main` is not enough. |

## 2. Create the server

**Servers → New server**, then pick the template — it appears as **zincai**
under the repository you added, or under **Local** if you pasted it. Its display
name is **Minecraft Agent (ZincAI)**. Give the server a name and an id, choose
**host** or **docker** as the environment, and fill in the variables: Endpoint,
Minecraft Server, Behaviour, Limits, Operator Control and Installation.

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
| `scaffolding` | `MC_ALLOW_SCAFFOLDING` | `false` | Place/remove scaffolding while building. |
| `elytra` | `MC_AUTO_ELYTRA` | `true` | Glide across long gaps. |
| `rpm` | `INFERENCE_RPM` | `18` | Shared model-call budget per minute. |
| `mininterval` | `INFERENCE_MIN_INTERVAL_MS` | `3000` | Spacing between action calls. |
| `heartbeat` | `INFERENCE_HEARTBEAT_MS` | `90000` | Self-prompt when idle; `0` disables. |
| `reconnect` | `RECONNECT` | `true` | Retry a dropped link after a spawn. |
| `maxattempts` | `RECONNECT_MAX_ATTEMPTS` | `40` | Retry cap before the process exits. |
| `operators` | `ZINC_OPERATORS` | *(empty)* | Comma-separated Minecraft **UUIDs** allowed to control the bot over chat. Empty closes the chat interface; the console still works. Usernames are not identity. |
| `commandprefix` | `ZINC_COMMAND_PREFIX` | `!zinc` | Chat prefix for operator commands. |
| `joinonstart` | `ZINC_JOIN_ON_START` | `true` | Off = the process starts without joining and waits for `join` on the console. |
| `log` | `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `datadir` | `ZINC_DATA_DIR` | `data` | Relative to the server folder, so backups include it. |
| `repo`, `branch`, `nodeversion` | — | this repo / `main` / `22` | Installation only. |
| ~~`autostart`, `autorecover`~~ | — | — | **Removed.** The panel owns these two flags per server; see [It does not show up at all](#it-does-not-show-up-at-all-nothing-listed-no-error). |

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

### Controlling the bot without restarting it

The **Console** tab is the operator interface: type a command on its own and
press enter. Nothing restarts the process, and none of it needs admin rights on
the Minecraft server.

```
status                      connection, life, activity, goals, jobs, limits
stop                        pause the body; suspend (never delete) open goals
resume                      reconcile the world, then resume what is still valid
leave                       disconnect; keep the process, goals and this console
join                        reconnect this process to the server
restart-connection          rebuild the link without a new process
goals / jobs                what is running, what is waiting
cancel g7                   cancel one goal and its jobs
config show boundary        every boundary limit, with defaults
config set boundary.radius 48
config set operators <uuid>,<uuid>
help
```

The same commands work in Minecraft chat behind the prefix (`!zinc status`) for
the UUIDs listed in `operators`; the answer arrives by whisper. Config changes
are written to `datadir/runtime-config.json` and survive a reinstall or a
restart. A change that cannot take effect mid-action says so and is applied at
the next safe boundary.

## 4. Verifying a deployment

```sh
npm run ping                    # is the Minecraft server reachable/which version
AMD_API_KEY=... npm run canary  # endpoint, auth and tool-call support
npm run dry-run                 # the same preflight the panel runs
npm run check                   # syntax-check every module
```

The panel's **Console** shows the same lines the preflight prints, so a
variable that is wrong is visible there before the bot joins anything. Expect a
`control:` line naming the command prefix, how many operator UUIDs are
configured and whether the process joins on start — if it says
`operators=NONE`, chat commands will be refused and only the console will work.

Type an operator command straight into the console (no prefix, one line, press
enter) to prove the control path end to end:

```
status
```

## Updating the bot

Push to the branch the server was installed from, then press **Install** in the
panel: the template runs `git fetch`/`checkout` on that branch and
`npm ci --omit=dev` again. Runtime data in `datadir` (memory, places, goals,
`runtime-config.json`) is left alone, and **Start** runs the `--dry-run`
preflight first, so a broken update is visible before the bot joins.

Pressing **Install** is also how you pick up a changed *template* — but the
panel caches the template repository for a few minutes, so a brand-new variable
can take a moment to appear.

## Requirements

- PufferPanel 3.x
- `git` on the node (host environment)
- Node.js 18+ — installed by the template on host nodes; the Docker
  environment uses `node:${nodeversion}-bookworm-slim`
- a `rc-...` AMD Radeon Cloud key
- a Minecraft server in offline mode (or a premium account for
  `auth = microsoft`)
