# FIXES2 — implementing the AUDIT2 roadmap

Branch: `arena/defd49f1-minecraft-harness` · base: AUDIT2.md (this directory)
Date: 2026-11-11 · Scope: every finding in AUDIT2.md, fixed, improved, or
explicitly deferred with the reason. **Nothing here was run against a real
server** — proof is the regression suite plus the simulator repros. The
live-verification protocol for your PC is `test/live/README.md` and
`scripts/amd-canary.js`.

## Verification summary (this sandbox)

| Gate | Result |
|---|---|
| `npm test` — 212 unit/session/regression tests | **212/212 pass** |
| `node test/audit2.test.js` — audit2 regression tests (new) | **16/16 pass** |
| `cd test/e2e && node loopback.js` — real protocol, local MC server + fake AMD endpoint | **43/43 checks pass** (both harnesses) |
| `node audit/repro/05-horde-attack.js` — the B1 churn scene | churn loop cut: 4 attack calls (was 6/14 s), 3rd attempt locally refused, **no model call spent** |
| `node audit/repro/13-stale-request.js` — the B5 scene | fresh chat drives recall (kept on purpose); 1-hour-old chat does **not**; control wake 0 recall lines |
| `node audit/repro/14-penned-mob.js` — the B2 scene | penned-visible zombie no longer starts a flee; open-ground control still does |

## Finding-by-finding

### B1 (S1) — no gate on a repeatedly-failing action → FIXED, twice
- New `zincai/failgate.js`: canonical call signature (tool + stable args), and
  after `maxFails` identical failures inside `windowMs` (config
  `inference.failGateAfter` = 2, `inference.failWindowMs` = 120000) the next
  identical call is **refused locally** — no world mutation, no model wake.
  The refusal lands silently in `results:` and a `blocked repeats:` advisory
  line is added to subsequent prompts so a weak model gets an explicit
  "stop trying this" instruction.
- **Second round (this pass):** the original resets defeated the gate in the
  exact scene it was built for (repro 05): the flee reflex moved the bot >4 m
  between attempts (move-reset fired) and each zombie hit cleared the gate.
  Now: the move reset only applies to **positional** failures (`POSITIONAL`
  regex: reach/distance/not-loaded — being elsewhere is a plausible cure);
  state failures like "too hurt to fight" are NOT cured by movement. Hurt
  events no longer clear the gate; death/respawn and genuinely new threats
  still do (fair retry).
- Files: `zincai/failgate.js`, wiring in `zincai/index.js` (`executeAction`
  gate + `report()` accounting).
- Proof: `test/audit2.test.js` "B1" unit test + "B1 session" test;
  `audit/repro/05` prints `FailGate evidence: ... 1 local "skipped:" refusal`.

### B2 (S1) — contained-but-visible mobs trigger flee → FIXED
- `zincai/threats.js`: `containedDemotion` now runs whenever the mob is real
  ONLY by line-of-sight and none of the exemptions hold (attacker, ranged,
  lit/charged, probe budget). The **`(!closing || closing < 0.2)` exemption
  was removed** — it let a penned zombie that was "closing" skip the
  reachability probe entirely. An open-ground mob still probes *reachable*
  and stays a real threat (test asserts exactly this).
- Proof: `audit/repro/14` (penned vs open-ground control), audit2 tests "B2".

### B3 (S1) — craft reachable-table mismatch → FIXED
- `src/recipes.js` / `src/agent.js` / ZincAI craft path: crafting now
  **approaches the table first** (`_approachForCraft`), and the failure says
  position, e.g. "could not reach the crafting table" — a positional failure
  the FailGate resets on arrival (see B1). Proof: audit2 test "E craft-walk".

### B4 (S1) — no resource acquisition → FIXED (chores)
- New deterministic skills in `zincai/skills.js` + tools:
  `gather` (chop logs / mine with **dig allowlist**: ores, stone, logs, crops
  only — never player builds; harvest-tier check refuses BEFORE walking, and
  a cancelled dig is reported honestly), `light_up` (torch placement),
  `shelter`, `corpse_run`. Chore timeout 240 s, executor thunk wired in
  `zincai/index.js`. Zinc (`src/`) keeps its minimal profile by design.
- Proof: audit2 tests "C gather allowlist" (×2), helper `findBlock` /
  `inventory.count` added to `test/helpers/session.js`.

### B5 (S2) — stale chat drives recall on every wake → FIXED
- Action-lane recall now queries memory with the last chat line **only if it
  is younger than `memory.chatRecallMaxAgeMs` (default 120 s)**, or when the
  wake itself is a chat request. Fresh-chat behavior (the useful half — "onde
  fica o portal?" surfaces the portal place) is preserved on purpose.
- Files: `zincai/index.js`, `zincai/config.json` (documented key).
- Proof: audit2 test "B5" (fresh drives / stale doesn't), repro 13 rewritten
  to show both halves against real reflex wakes. Note: working-memory
  `events:` and `just now:` sections still show *recent* items by design —
  the fix targets the query-driven `recalled:`/`memories:` section only.

### B6 (S2) — Zinc `equip` addressed a hotbar index the model never saw → FIXED
- Zinc's prompt now carries an inventory line with names+counts, and `equip`
  accepts item names (resolved via `src/actionParser.js` + `src/agent.js`).
  Proof: fixes tests (early batch), full suite.

### B7 (S2) — mace/trident/spear never auto-equipped → FIXED
- `src/combat.js` `_weaponScore`: mace 13, trident ≈ netherite axe, spear 9 —
  used by auto-equip so 1.21+ weapons are considered.

### B8 (S1) — point-blank rear creepers → IMPROVED, residual documented
- Repro 08 now: creeper at 3.2 m behind — fuse lit **2/6** runs (was 3/6);
  at 4 m and 10 m: 0/6. The residual is sim-timing margin (reaction
  101-255 ms at 200 ms tick vs a ~1.5 s fuse), not a logic hole; on the real
  server tick cadence this needs the live protocol check (scenario 3 in
  `test/live/README.md`).

### B9 (S2) — dead ephemeral memory → FIXED
- The ephemeral 30 s buffer now shows up as a `just now:` line in the action
  prompt, excluding anything that has its own section (chat/results/threats).

### B10 (S2) — chest-content staleness invisible → FIXED
- `zincai/places.js` `_ageSuffix`: container lines show how long ago contents
  were seen ("seen 40 s ago"), so the model can distrust old numbers.

### B11 (S2) — no trust model → FIXED (opt-in)
- `trust.owners` / `trust.trusted` in `zincai/config.json`; default off and
  inert. When lists exist, a guest asking for `give`/`take`/`put` on storage
  or automation is refused with an actionable message; owners are not
  restricted. Documented in config: offline-mode usernames are spoofable —
  this is a filter, not authentication.
- Proof: audit2 test "D trust guest/owner" (spy on `bot.toss`).

### B12 (S0-risk) — never verified live → MITIGATED (verification kit shipped)
- `scripts/amd-canary.js`: pre-deploy probe of the real AMD endpoint —
  reachability/auth, `tool_choice: "required"` vs `"auto"` report, a real
  reply-tool PT round-trip, and the PT-BR guard on a sample answer. Exits 2
  without a key; reads `AMD_API_KEY`/`AMD_API_BASE_URL`/`AMD_MODEL` or
  `config.json amd.*`. **Run this first on your PC** (weaker model included —
  the canary tells you if it can tool-call reliably at all).
- `test/live/README.md`: Paper/vanilla 1.21.x offline-mode staging protocol
  with a 20-scenario pass table and failure-report instructions.

### B13 (S2) — `maxHealth` fixed at 20 → FIXED
- Shared `src/combat.js` `noteHealth(hp)`: absorption/health-boost hearts
  arrive as hp > 20; the largest observed value becomes the base and the
  disengage threshold recomputes. Wired from `zincai/index.js` health events
  and Zinc's `src/agent.js` `_onHealth`. Vanilla never moves from 20.
- Proof: audit2 test "B13".

### B14 (S3) — Zinc hold semantics vs ZincAI → FIXED
- ZincAI: `hold` decisions acknowledged via `reflex.acknowledge(shown,
  { label: 'hold', ttlMs: 30 min })`; Zinc gained the same `hold` case, so a
  "they're harmless" answer outlives individual tasks in both harnesses.
- Proof: fixes.session tests T5/T5+B3 (flake-hardened: one 2 s `until`
  window widened to 6 s — see "Test hygiene").

### B15 (S2) — places rescan gap → FIXED, both halves
- `blockUpdate` on an indexed position invalidates instantly (broken chest
  leaves the index; re-kinded container gets contents wiped) — existing.
- **New (this pass):** a blockUpdate for a NOT-yet-indexed container is
  **adopted** immediately if it falls inside the axis-aligned box of the last
  real scan (`_lastScan` + radius + 2, 30 s window, same dimension) — a chest
  placed right next to the bot is usable at once; edits 120 m away or in the
  nether are ignored cheaply (the bbox filter). Sign/label attaching stays
  with the regular scan wave.
- Proof: audit2 tests "B15" + "B15b" (adoption / distance / dimension / cold).

### B16 (S3) — no dimensions/boats → DEFERRED (documented P2)
- Portals/nether navigation, boats/ice-roads, long-range elytra flight,
  villager trading, farming, embeddings: not provable in this sandbox without
  a live server; each is documented with a design in AUDIT2 §7.9. No half-
  hidden stubs were added.

### Scenario 32 — per-player chat monopoly → FIXED
- `behavior.chatPerPlayerPerMinute` (default 8): excess addressed lines from
  the same player are dropped with a log line before they touch the chat lane.
- Proof: audit2 test "scenario 32". (One trap fixed along the way: the test
  must count only `Player says:` input lines — the quoted `conversation
  history` legitimately repeats recent accepted lines.)

## Roadmap letters (AUDIT2 §7.9) also landed

- **D-full** (chat rate) — done as `chatPerPlayerPerMinute` (scenario 32).
- **E** (craft walk) — see B3.
- **F** (builder per-phase preflight) — `zincai/index.js` builder path: each
  phase preflights its own material list; shortages come back as structured
  `missing` the model can turn into `gather` or a chat ask.
- **G** (token spend) — per-mode tool schemas (`createZincTools({mode})`,
  27 total with mode-appropriate drops; `say/idle/stop/find/set_mode` always
  kept) and **usage accounting**: every call (both lanes) appends to
  `metrics.jsonl`, so the §7.6 table can be produced from data, not
  estimates. Provider prompt-caching is endpoint-side — check with canary.
- **I** (response validation + guard) — `api_wrapper.js` retries exactly one
  more time ONLY for truly broken answers (unknown tool / invalid args /
  empty / `finish_reason: "length"`, with a maxTokens bump on truncation).
  **Prose answers are never silently retried** — the executor's
  "you answered in prose without calling a tool" is the contract the model
  sees once. `filter.js`: ES/FR/DE function words added, and the PT accent
  bonus only counts when no foreign function word is present ("bonjour, ça
  va?" stopped passing as PT).
- Prompt diet — `src/systemPrompt.js` SYSTEM_PROMPT is now 149 words with the
  required identity line ("Zinc… admit you are a bot.").

## Weak-model design rules applied everywhere

Refuse locally, never wake on a refusal, keep refusal messages ≤ ~110 chars
and actionable ("use different arguments, go somewhere else first, or use say
to explain"), validate args harness-side, one controlled retry for broken
outputs only. The deterministic body still carries everything; the weaker
model only decides.

## Test hygiene (to keep your PC runs trustworthy)

- Always tear simulated sessions down with `s.stop()` — bare
  `session.dispose()` leaks handles and hangs the runner.
- `node --test` runs files in parallel; two flaky-looking failures this pass
  (T5 hold, scenario 32) were a CPU-starved 2 s window and a regex that also
  matched quoted history, both fixed in the tests — not in the behavior.

## What to run on your PC (in order)

1. `npm test` → expect 212/212.
2. `cd test/e2e && npm install && node loopback.js` → expect 43/43.
3. `AMD_API_KEY=… node scripts/amd-canary.js` → must print ALL GOOD.
4. `test/live/README.md` staging protocol → the 20-scenario table.
