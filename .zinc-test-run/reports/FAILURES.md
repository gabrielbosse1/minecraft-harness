# FAILURES — zinc-autonomous-test (2026-11-12)

Live campaign ran on **Minecraft 26.1** loopback (real vanilla server, real
Qwen3.8-27B model, real `node zincai/index.js` bot). 34 tests attempted:
22 pass / 8 fail / 4 skip. Failures classified below.

---

## F1 — CRITICAL — 26.3 protocol not wire-compatible (blocks SMP deployment)

- **Scenario:** connect the real mineflayer stack (mineflayer 4.39 +
  minecraft-protocol 1.68.0 + vendored 26.3 data) to a real Mojang 26.3 server.
- **Observed:** every client — 5 independent probes, all with the repo's own
  postinstall applied — is **kicked ~400 ms after spawn** with
  `multiplayer.disconnect.invalid_player_movement`, AND the client process
  crashes parsing a real server packet:
  `TypeError: Read error for undefined : ctx.entityDelta is not a function`
  in `packet_rel_entity_move`.
- **Expected:** bot joins and holds a session on 26.3 (the repo's stated
  target; 244/244 offline tests pass on the vendored data).
- **Diagnosis (high confidence):** the vendored 26.3 `protocol.json`
  (protocol 777, generated from **unmerged** PRs
  PrismarineJS/minecraft-data#1300/#1345) declares `entityDelta` as a
  `"native"` type, but `minecraft-protocol@1.68.0` (the latest release) never
  registers a native `entityDelta` implementation. The repo's
  `scripts/apply-26.3-data.js` only (a) copies the data JSON files and
  (b) removes mineflayer's version gate — it does **not** make the wire
  format work. Server-side the client's movement packets are rejected
  (`player_movement_check` is a boolean gamerule in 26.3, no "warn" mode).
  Logs: `.zinc-test-run/logs/server.out` (26.3), `logs/server-261.out`
  (comparison), `scripts/trace_join.js` / `idle_probe.js` reproducers.
- **Responsible subsystem:** infrastructure / vendored protocol data.
  **Not** an AI or harness-reasoning defect.
- **Needs code change:** YES. Either (a) wait for `minecraft-data`+
  `minecraft-protocol` releases that include 26.3 natively, (b) port and
  register the missing native types (entityDelta and any others in 777) into
  a patched `minecraft-protocol`, or (c) pin the SMP to 26.1.

## F2 — HIGH — chat lane default timeout aborts real replies

- **Scenario:** second player (Gabriel, mineflayer client) sends an addressed
  chat asking the bot to run `redstone_scan`.
- **Observed:** chat lane reached the model, then
  `zincai chat lane failed: This operation was aborted` after ~12 s; the bot
  logged `-> (silent)` and the task handoff was lost.
- **Root cause:** measured model latency on Qwen3.8-27B is **p50 ≈ 46 s**
  (9.7k-token prompts); `chatTimeoutMs` default is **12 000 ms**,
  `chatMaxRetries: 1` — so the chat lane can never complete a normal reply.
  The action lane had the same problem (`timeoutMs` 20 000 vs 47–99 s
  observed); it was raised to 120 s during this campaign (see
  `zincai/config.json` note), but the chat lane still aborts.
- **Classification:** configuration mismatch with the chosen model
  (harness infrastructure). **Needs code/config change:** YES —
  `chatTimeoutMs` ≥ 60 s (or per-model adaptive timeout).

## F3 — HIGH — model intermittently returns prose instead of a tool call

- **Observed (live, 7 occurrences in the final window 14:43–14:59):**
  `amd model retry still produced no valid tool call (prose)`.
  `tool_choice:"required"` is served by the endpoint (canary proved it), but
  Qwen3.8-27B still occasionally emits non-tool text; the harness's one retry
  also failed, and the wake-up was lost. Frequency climbed late in the
  campaign — roughly one failed wake-up per 3 min in the last half hour —
  so the bot idled out the tail of the session.
- **Classification:** model reliability (endpoint/model), partially mitigable
  by harness (retry count / stricter prompt).
- **Needs code change:** consider 2nd retry with a corrective nudge message,
  or model swap.

## F4 — HIGH — interior multi-floor navigation fails

- **Observed:** bot indexed its own bed (2F) as `bed1` in `places.json`, then
  `sleep` and `go_to {"place":"bed1"}` both FAILED:
  `could not reach bed1: no path`. The 1F→2F route is interior cherry stairs
  with an open door; the pathfinder found no route (likely the stairs' half
  block states or the door orientation on the auto-built house).
- **Also observed (final minutes):** 4/4 `go_to` attempts to the redstone
  lab (0,105,−65) — same floor, flat route — all returned `no path` as well,
  so the problem is not limited to interior stairs: cross-area routing on
  this 1F also fails. Final log line before shutdown: `go_to: FAILED — did
  not arrive: no path; now at 4,106,9`.
- **Impact:** anything on floors 2–3 (bed, enchanting, grindstone, brewing,
  the mob cage, the 2F/3F chests) is effectively unreachable by the bot,
  and reliable cross-area `go_to` on 1F is in doubt. The bot only ever
  reliably used the 1F around the base.
- **Classification:** navigation failure (pathfinder vs constructed geometry).

## F5 — MEDIUM — action-lane prompt is very large → slow, expensive calls

- **Measured:** avg input **6 670 tokens/call** (up to 9 792), avg latency
  46 s, one call 113 s. 22 calls consumed 146 748 input tokens.
- **Impact:** at 3 s min interval the bot can realistically take ~1 action
  every 30–60 s; heartbeats and task resumption feel sluggish; token cost is
  high for a 27B free-tier model.
- **Classification:** context-management / performance. Not a correctness bug.

## F6 — LOW (campaign-side, documented for the operator) — infra hazards hit

- Vanilla **auto-pause** ("Server empty for 60 seconds, pausing") stalls
  forceload chunk generation 3×; a keeper client was required for world prep.
  (In production with a real player present this does not apply.)
- 26.1 vs 26.3 command differences cost setup time: `forceload` takes BLOCK
  coords on 26.1; `time get`→`time query`; `player_movement_check` is boolean.

---

### What was NOT testable this window (honest gaps)

- Live 26.3 behavior (blocked by F1).
- Live melee/PvP/projectile combat decisions (flee reflex proven; the model's
  attack decision, kiting, arrow-dodge were not exercised — no second real
  player, and time budget).
- Live `build`/`build_shape` construction (Area D fully built and stocked, but
  no build task was issued before the deadline).
- Live `redstone_scan`/`logic_test` execution by the bot (blocked by F2's
  chat-lane abort; the tools' offline suites pass 254/254 and the lab was
  built and verified block-by-block).
- Memory recall **after a context reset** (the live session stayed in one
  context window; `memories.json` remained `[]` because the chat lane — the
  primary `remember` path — was aborting per F2).
