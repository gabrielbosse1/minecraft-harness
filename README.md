# Minecraft Harness — ZincAI

**ZincAI** is an autonomous Minecraft Java Edition agent built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) and backed by an OpenAI-compatible LLM API (configured for AMD Radeon Cloud by default).

The harness connects to any vanilla Minecraft Java server (including 1.21.4 and patched 26.x builds) as a normal client player (`ZincAI`) with **no RCON, no server plugins, no slash commands, and no behavioral modes**.

---

## Core Design

| Principle | How it works |
| --- | --- |
| **Model freedom** | No personas (`explorer`/`builder`/`hunter`), no hidden tool gating, no hardcoded gather whitelists, and no language or chat-relevance filters. All **39 tools** are exposed on every action turn with an identical JSON schema for prefix-cache efficiency. |
| **Reflexes flee; the model decides** | Local `System1` survival reflexes handle immediate self-preservation (eating, fleeing real threats via BFS escape planning, hazard exit, water clutch, armor upgrades) without waiting on the API. The model decides whether to keep fleeing, fight (`attack`), move elsewhere (`go_to`/`follow`), or stand ground (`hold`). |
| **Two concurrent LLM lanes** | **Chat lane** reads batched IRC-style chat windows and replies naturally in the speaker's language — without blocking ongoing movement or building — and can trigger immediate simple actions (`reply.do`) or hand tasks to the action lane (`reply.task`). **Action lane** runs a multi-step tool loop (`think → tool → observe → think`) up to `maxStepsPerTurn`. |
| **Strict vanilla client boundary** | `installVanillaGuard` blocks command-shaped chat (`/...`) from ever leaving the client (except guarded `/msg` whispers), and `installPhysicalGuard` gates all 19 Mineflayer movement/world primitives behind lifecycle state (`connected`, `alive`, `paused`) and an anti-flood rate ceiling (`limits.maxPhysicalActionsPerMinute`). |
| **Layered memory** | Three separate stores, not one pile: append-only **raw history** (`data/history/<category>/<day>.jsonl`, never fed to the model automatically), long-form **entity dossiers** keyed by Minecraft UUID (`data/entities/*.json`), and short, evidence-tagged **curated memories** (`data/memories.json`). Player recognition, goal/location/entity recall and idle-time maintenance are automatic; every curated record points back to the raw evidence that produced it. |
| **Full session telemetry in `data/`** | Every session writes structured NDJSON event logs (`events.jsonl`), live continuation state (`continuation.json`), and a session index (`latest.json`) under `data/` alongside persistent goals, memory, history, dossiers, journal, places, and circuit stores. |

---

## Quick Start (Local)

**Requirements:** Node.js 18+ (tested on Node 22) and an API key for your OpenAI-compatible model endpoint.

```sh
git clone https://github.com/gabrielbosse1/minecraft-harness.git
cd minecraft-harness
npm install

cp .env.example .env
# Edit .env with AMD_API_KEY, MC_HOST, MC_PORT, MC_AUTH, MC_VERSION
set -a; . ./.env; set +a

# Validate configuration without connecting
npm run dry-run

# Launch ZincAI
npm start
```

### Quick Start (PufferPanel v3)

ZincAI ships a ready-to-use PufferPanel v3 template at `pufferpanel/zincai.json`:

1. In PufferPanel, go to **Templates → Add repo** and point it at this repository (`branch: main`), or run `node pufferpanel/import.js --print` and paste into **Templates → New → Json**.
2. Create a server from template **`zincai`** and set `apikey`, `host`, `port`, `auth`, and `mcversion`.
3. Click **Install**, then **Start**. Every start runs `node zincai/index.js --dry-run` before connecting.

See [`docs/pufferpanel-guide.md`](docs/pufferpanel-guide.md) and [`pufferpanel/README.md`](pufferpanel/README.md) for the full walkthrough.

---

## Runtime Control & Data Layout

Operator control is **console-only** (process `stdin`, bare words with no prefix; in-game chat is never a command channel):

```text
status | pause | stop | resume | leave | join | restart-connection
goals | jobs | cancel <id> | config [show|set|reset] | update | restart | shutdown | help
```

All runtime persistence and telemetry lives under `ZINC_DATA_DIR` (default: `./data/`):

```text
data/
├── latest.json                         # pointer to the most recent session + summary stats
├── sessions/<sessionId>/
│   ├── events.jsonl                    # NDJSON stream: lifecycle, world, reflex, chat, model, tools, goals
│   └── continuation.json               # live/final snapshot: botState, openGoals, activeGoal, plan, lastModelThought
├── goals.json                          # persistent goal registry
├── memories.json                       # curated memories (provenance, confidence, evidence refs)
├── entities/                           # long-form dossiers: player-<uuid>.json, places, groups, self
│   └── index.json                      # UUID ↔ name ↔ dossier index (rebuilt if missing)
├── history/                            # raw append-only evidence, never auto-injected
│   ├── world/<YYYY-MM-DD>.jsonl         # observations and world events
│   ├── chat/<YYYY-MM-DD>.jsonl          # conversations
│   ├── actions/<YYYY-MM-DD>.jsonl       # tool calls and their outcomes
│   ├── decisions/<YYYY-MM-DD>.jsonl     # goals, agreements, memory/relationship changes
│   ├── relationships/<YYYY-MM-DD>.jsonl # player arrivals, gifts, attacks
│   ├── errors/<YYYY-MM-DD>.jsonl        # failures worth investigating
│   ├── maintenance/<YYYY-MM-DD>.jsonl   # what each organiser pass changed
│   └── <category>/<day>.idx.json        # per-file keyword index (bounded search)
├── continuity.json                     # social relationships, norms & self-model
├── journal.json                        # structured plans & session digest
├── places.json                         # remembered coordinates & discovered POIs
├── preferences.json                    # learned preferences
├── circuit_projects.json               # saved redstone & logic-test projects
├── redstone_library.json               # learned/verified redstone designs
└── runtime-config.json                 # live operator overrides (10 runtime parameters)
```

### How memory is organised

| Layer | Contents | Read by |
| --- | --- | --- |
| **Working memory** | current goals/plans, recent events, weather/hazards, retrieved memories, recent tool results | rebuilt every turn; never grows without bound |
| **Curated memories** (`data/memories.json`) | short, meaningful records with category (`episodic`/`semantic`/`procedural`/`continuity`), evidence basis (`observed`/`reported`/`inferred`), confidence, importance, stable id and `evidence` references | automatic recall (goal/location/entity/player) plus `recall` / `memory` |
| **Entity dossiers** (`data/entities/`) | long-form Markdown-backed documents per subject: identity (Minecraft UUID), first seen, description, relationship assessment, interactions, preferences, behaviour, facts, uncertainties, timeline, evidence | automatic recognition when the subject is visible or speaks, plus `memory {operation:"profile"}` |
| **Raw history** (`data/history/`) | complete append-only log of observations, chat, actions, decisions and errors, one NDJSON file per category per day | only explicit, bounded `memory {operation:"history"}` searches (keyword sidecar index) |

Each turn Zinc receives one budgeted retrieval block: the dossier line of the
players in front of it, the memories that match its goal/position/request, and —
early in the prompt — a short `past attempts (raw log)` warning about earlier
failures on the same task. Nothing else is pushed: history is pulled.

Rules the harness enforces: telemetry (`hurt`, `entity_hurt`, `player_arrived`, …)
is logged but never curated; ordinary conversation is history-only while a
coordinate/ownership/preference claim is curated as `reported`; a player dossier
is keyed by UUID and upgraded in place on rename; archive/delete of a curated
memory never touches raw history; maintenance merges duplicates, archives stale
noise (including telemetry rows promoted by older builds) and seeds name-only
dossiers for recurring players, but never deletes foundational records or
evidence.

---

## Verification & Real-Server Simulation Tests

All tests run against **real local Minecraft 1.21.4 servers (`flying-squid`)** over localhost TCP sockets with a real Mineflayer client and a local OpenAI-compatible HTTP endpoint — no mocked `bot` objects.

```sh
npm run check                # syntax check every JS module in zincai/, src/, scripts/, pufferpanel/
npm test                     # run all real-server simulation suites (test/01..13)
npm run dry-run              # verify env/config resolution & tool schema without connecting
npm run pufferpanel:validate # validate pufferpanel/zincai.json against PufferPanel v3 rules
```

| Test suite | Coverage |
| --- | --- |
| `test/01-connection-perception-movement.test.js` | Real server join, physical boundary, world/inventory perception, 39-tool schema, `inspect_block`, `inspect_region`, `find`, `remember_here`, `screenshot`, obstacle pathfinding |
| `test/02-gathering-digging-building.test.js` | Real `gather` (`oak_log` + arbitrary vanilla blocks like `amethyst_block`), `build`, `build_shape`, `dig` |
| `test/03-chat-social-lanes.test.js` | Real second player (`Alice`), TCP chat lane reply, immediate `reply.do: "come"`, `social`, `note`, `say`, runtime `vanilla_guard` blocking `/op` |
| `test/04-reflexes-combat-survival.test.js` | `ArmorKeeper` auto-equip & manual slot hold, `System1` flee reflex against real zombie, `attack` killing a real zombie on server |
| `test/05-redstone-inspection-engineering.test.js` | Real redstone circuit scan, `redstone_component`, `redstone_engineer` (`analyze`, `design`, `place`), `logic_test` (XOR), `circuit_project` |
| `test/06-goals-continuity-recovery-control.test.js` | Persistent goal continuity across real death & automatic respawn, `Host` operator commands (`status`, `config`, `pause`, `resume`, `leave`, `join`) |
| `test/07-telemetry-and-persistence.test.js` | End-to-end NDJSON `events.jsonl` stream, verbatim `reasoning_content` capture, `continuation.json`, `latest.json`, and `data/` store persistence |
| `test/13-memory-architecture.test.js` | UUID-keyed dossiers across renames, profile updates that keep the old assessment, curated delete/archive that never touches raw history, automatic recognition of a real joining player, bounded history search, duplicate merge, maintenance that preserves evidence, chat-noise gating, retrieval latency, schema/handler parity, and corrupted/partial/duplicate files |

---

## Documentation Map

- [`docs/architecture.md`](docs/architecture.md) — System architecture, control arbitration, reflex loop, tool execution, telemetry, and persistence.
- [`zincai/README.md`](zincai/README.md) — Module-by-module guide to `zincai/` and the 39-tool surface.
- [`docs/pufferpanel-guide.md`](docs/pufferpanel-guide.md) — Step-by-step PufferPanel v3 setup guide.
- [`pufferpanel/README.md`](pufferpanel/README.md) — Template specification, variables, and diagnostics.
- [`AGENTS.md`](AGENTS.md) & [`docs/AGENT_REFERENCE.md`](docs/AGENT_REFERENCE.md) — Dense technical reference and invariants for AI coding agents and contributors.
