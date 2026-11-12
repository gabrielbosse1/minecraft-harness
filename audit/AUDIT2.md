# Zinc / ZincAI — Real-SMP Reliability Audit (second pass)

> **Status update (2026-11-11, same branch): every finding below is now FIXED, IMPROVED, or explicitly DEFERRED — see `audit/FIXES2.md` for the per-finding fix log, proofs (212/212 tests, 43/43 e2e loopback, re-run repros 05/08/13/14), and the PC staging protocol (`test/live/README.md`, `scripts/amd-canary.js`).** The body of this document is kept as the frozen audit snapshot; line numbers refer to the pre-fix tree.

- Repository: `gabrielbosse1/minecraft-harness`, branch `arena/defd49f1-minecraft-harness`, base commit `29c9733` (main, merge of PR #6).
- Type: read-only audit. No source files were modified. All commands below were actually executed in this environment on 2026-11-11.
- Builds on the pre-release audit (`audit/REPORT.md`, commit `53c59e4`) and its fix log (`audit/FIXES.md`). Every fix claimed there was re-verified against the current tree; only still-open or newly found issues are reported as open.
- Label convention: **[confirmed]** = read in code and/or reproduced by a script or test run in this session. **[likely]** = strong code evidence, but the failure needs a live server to be certain. **[theoretical]** = architectural risk, not yet observed.

**Verification status of this environment (measured):**

| Check | Result |
|---|---|
| `npm test` (9 unit/session suites) | **196/196 pass** (98 s) |
| `test/e2e/loopback.js` (real processes, flying-squid 1.16.5 server, scripted model) | **43/43 checks pass** |
| `audit/repro/01..11` | all execute; before/after behaviors match `FIXES.md` |
| Live AMD endpoint, live Mojang server, real hostile mob AI | **not verifiable from this sandbox** (network-restricted); flagged wherever a claim depends on them |

---

## 7.1 Executive summary

**What this project is.** Two Java-Edition Mineflayer harnesses sharing one body: **Zinc** (`src/`, ~300 input tokens/call, one JSON action per call, seven actions) and **ZincAI** (`zincai/`, ~3,600 input tokens/call, 23 function tools, two model lanes). Around both sits a non-trivial deterministic body: a `ThreatSense` classifier, a System-1 reflex (flee/eat/MLG/swim/elytra), a time-based flood-fill escape planner, state-aware door handling, threat-cost-injected A*, a 20 Hz combat controller with cooldown-gated crits, a ControlArbiter with four priority lanes, a container/sign/label place index, a three-tier memory system, a blueprint/shape builder, and an agenda with pause/resume.

**Verdict.** ZincAI is architecturally the soundest LLM-driven Minecraft bot in this class I can defend from the code alone: *everything that must react in under a second is deterministic local code*, and the model is only used where judgment is needed. On a **friendly SMP it will reliably**: survive nights in the open, flee creepers and hordes, navigate doors and storage halls, fetch/store items in labelled chests, chat in PT-BR while working, remember per-player facts, resume interrupted tasks, reconnect after drops, and report what its body did. It will **not** (by construction, not by bug): gather/mine/farm anything, trade, brew/enchant, use boats/portals, or win fights it should avoid — and it **cannot be trusted alone overnight yet**, for three reasons: (1) nothing rate-limits the model repeating an action the body just refused (measured: 6 refused `attack` calls in 14 s), (2) visible-but-contained mobs still trigger escapes (fence pens, unnamed exhibits), (3) every live-dependency (AMD endpoint, `tool_choice:"required"`, 26.3 protocol data, real mob AI) is unverified.

**What breaks first on a real SMP, in order:**
1. **Live-integration unknowns** — endpoint/tool-calling compatibility and the vendored 26.3 data have never touched a live server (README says so itself). First deploy will be integration debugging, not behavior debugging.
2. **Model stubbornness without a harness-side failure gate** (`attack` loop measured in `audit/repro/05`; same shape applies to any repeatedly failing action — `craft` at a too-far table, `take` from a chest another player just emptied). Burns the 18 rpm budget and produces prompt whiplash.
3. **Contained-but-visible mobs trigger flee** — a LoS-visible zombie behind a fence within 12 m is classified as a real threat (`zincai/threats.js:511`; the reachability probe only *adds* hidden hostiles, never demotes visible ones). Known and listed "not fixed" in the prior audit. The `hold` tool is the mitigation, but it costs a model call per episode.
4. **Nothing can acquire resources.** No `mine`/`gather`/`harvest`/`chop` skill exists in either harness; the bot can only redistribute what players already stocked. For a "helpful SMP member" this is the largest functional hole.
5. **PvP beyond casual is outmatched** — no sprint-reset/combo control, no totem/potion logic, generic distance bands; the mace/elytra-charge dodges exist and are simulated, but a competent player wins.

**Highest-value fixes** (full roadmap in 7.9): P0 = live smoke rig (Paper staging + AMD canary), failure-aware action gate, containment demotion in ThreatSense, craft-table approach fix (one-liner class), minimal owner/trust gate for storage-giving actions, response validation (`finish_reason`/empty-tool retry). P1 = deterministic chore skills (gather/mine/torch/shelter), builder per-phase preflight, tool-schema slimming/prompt caching, staleness surfacing for chest contents.

---

## 7.2 Existing architecture

```text
                         ┌──────────────── AMD-compatible endpoint ───────────────┐
                         │  (OpenAI-style chat completions, tool calling)          │
                         └───────▲───────────────────────────────▲────────────────┘
                                 │ chat completions              │ tool_choice: required
             ┌───────────────────┴───────────────┐   ┌───────────┴─────────────────────┐
             │ Zinc (src/) — minimal lane        │   │ ZincAI (zincai/) — two lanes    │
             │ 1 call = 1 JSON action,           │   │ brain.js scheduler:             │
             │ prompt = vitals + ≤5 delta        │   │  CHAT lane  (1.2 s spacing,     │
             │ events + 10-word memory           │   │   12 s timeout, 4/18 rpm        │
             │ actions: say/craft/equip/attack/  │   │   reserved) → reply(text,task,  │
             │  move/elytra/idle                 │   │   remember)                     │
             │ trigger-gated, self-chain ≤12     │   │  ACTION lane (3 s spacing, 1 s  │
             └───────────────┬───────────────────┘   │   urgent) → one of 23 tools     │
                             │                       └───────────┬─────────────────────┘
                             │    both harnesses drive the same body below              │
        ┌────────────────────▼─────────────────────────────────▼────────────────────┐
        │ zincai/index.js · executeAction · agenda (main / side-job pause / shelf / │
        │   asked) · prompt builders (self/inventory/threats/players/mobs/nearby/   │
        │   places/prefs/recall/chat/results/events/why)                            │
        ├───────────────────────────────────────────────────────────────────────────┤
        │ MODEL-OWNED layer (deliberate): skills.js (go_to/follow/take/put/smelt/   │
        │   sleep/give/eat/equip/use_block/find/remember_here), builder.js          │
        │   (BlueprintParser + BuilderExecutor, staged, idempotent), craft via      │
        │   src/recipes.js (prismarine-recipe), run_script (trusted local JS)       │
        ├───────────────────────────────────────────────────────────────────────────┤
        │ BODY layer (deterministic, no LLM):                                      │
        │  control.js  ControlArbiter — lanes survival > combat > task > idle       │
        │  threats.js  ThreatSense: LoS + reachability probe + attacker memory      │
        │  system1.js  reflex flee/eat/MLG-water/elytra/swim; episodes, hysteresis, │
        │              model decisions (attack/go_to/hold) with TTL + expiry reports│
        │  tactics.js  situation counts, pressure, fight-cost arithmetic            │
        │  combat.js   AdvancedCombat 20 Hz: crit timing, strafe, creeper           │
        │              hit-and-run, ranged mode, mace/charge evasion forecast       │
        │  custom_mineflayer/pathfinder_wrapper.js  PredictiveThreatMap A* costs,   │
        │              doors, wind-charge traversal, humanizer                      │
        │  custom_mineflayer/escape.js  flood-fill escape planner (bot clock vs     │
        │              mob clock per cell; open/pocket/chased/surrounded/trapped)   │
        │  custom_mineflayer/doors.js   state-aware door/gate handling              │
        │  elytra.js (Zinc) auto glide deploy + firework boost/chase                │
        │  watchdog.js, chatGuard.js, vanilla_guard.js, reconnect.js, amdClient.js  │
        │  memory.js (working 5 / short-term 10 min / long-term ≤500 JSON /         │
        │   preferences / convo 7 d), places.js (container+sign index, persisted)   │
        └───────────────────────────────────────────────────────────────────────────┘
                             │ Mineflayer + vendored minecraft-data 26.3
```

**Design spine.** Perception and survival are local and free (200 ms reflex tick; `ThreatSense.assess()`; escape planner). The model wakes only on triggers (threat/hurt/chat/task events/heartbeat) and is *told* what the body did rather than asked to do it. Tasks are model-owned (`go_to`, `follow`, builds) but every control goes through the arbiter, so a reflex can seize movement mid-task and hand it back. That is the correct division of labor for current LLMs and this audit's scenario results are mostly downstream of that choice.
---

## 7.3 Critical bugs and design flaws

Severity: **S0** safety/friendly-SMP-breaking, **S1** scenario-failing, **S2** cost/latency/reliability drag, **S3** hygiene.

| # | Severity | Status | Issue | Where | Effect / evidence |
|---|---|---|---|---|---|
| B1 | S1 | **[confirmed]** | No harness-side gate on a repeatedly **refused/failing** model action | `zincai/index.js` `executeAction` failure path (results fed back, but nothing blocks re-issue); measured in `audit/repro/05` | Model answered refused attacks **6×/14 s** ("too hurt to fight") — each is a full ~3.6 k-token call. Same shape for `craft` at a far table, `take` from an emptied chest. Burns rpm, crowds out chat lane, never converges. |
| B2 | S1 | **[confirmed]** by code **and repro 14**: `real = los \|\| attacker` (LoS over a fence counts); the reachability probe at :514 can only *promote* hidden close hostiles, never *demote* a visible contained one | `zincai/threats.js:511-514`; `audit/repro/14-penned-mob.js` | A zombie sealed in a one-block oak-fence pen at 8 m triggers a FLEEING episode + model wake **identically** to the same zombie loose in the open (both runs started flee within ~200 ms). On a settled SMP base with farms/zoos this means repeated escapes + wakes until a `hold` decision. Prior audit lists as not fixed; still present. |
| B3 | S1 | **[confirmed]** | **Craft reachable-table mismatch**: `findCraftingTable` searches 8 m (`TABLE_REACH = 8`), then `bot.craft(recipe, 1, table)` is called with no approach step; Mineflayer requires the table within interaction reach (~4.5 m) | `src/recipes.js:26,33,96-106`; called by `src/agent.js:754` and `zincai/index.js:978-981` | Any table-needed craft attempted from 4.5–8 m fails as `table_window_failed`/`craft_failed`, then (per B1) the model may just retry. Prior audit S7; still present. |
| B4 | S1 | **[confirmed]** | **No resource-acquisition capability anywhere**: no mine/chop/gather/harvest/fish/trade tool or skill; pathfinder digging disabled by default | absence across `zincai/skills.js`, `zincai/api_wrapper.js` tool list, `src/agent.js` actions | The bot cannot restock itself: all domestic value (take/put/smelt/give) depends on players pre-stocking chests. On a real SMP this makes "be helpful" depend entirely on donations. Architectural gap, not a bug. |
| B5 | S2 | **[confirmed]** by code **and repro 13** | **On every action wake — including pure reflex/threat wakes — `recallBlock` is queried with the last chat message regardless of its age or the wake reason.** The stale text is not shown as a `request:` line, but its retrieval results are injected as `recalled:`/`memories:` into the flee prompt | `zincai/index.js:687-688`; `audit/repro/13-stale-request.js` | Measured: a wake whose `why now:` is `reflex: started FLEEING — zombie came close` still carried the block `recalled: - o portal do nether fica em 120, 64, -40`, driven by a chat line from the simulated "hours ago"; the no-chat control wake had zero memory lines. Effect: mild prompt pollution during survival moments plus a subtle behavioral nudge (an old "vem aqui" can bias a flee decision). The flip side is intentional (it is how "last death" surfaces on respawn) — the fix is an age/addressing bound, not removal. |
| B6 | S2 | **[confirmed]** | **Zinc's `equip` addresses a hotbar slot number the model has never seen**; Zinc's prompt carries no inventory line at all | `src/actionParser.js:50-53`, `src/agent.js:764-765`, `src/systemPrompt.js` | Zinc equips blind (random slot 0-8 guesses); cap of its usefulness. (ZincAI's `equip` takes an item name — `zincai/skills.js:514` — correct harness, wrong one has the flaw.) |
| B7 | S2 | **[confirmed]** | `_equipBestWeapon` only pattern-matches classic **sword/axe tiers**; mace, trident, spear are never auto-equipped even when carried | `src/combat.js:684` (`_equipBestWeapon`), profiles at :68-100 do know these weapons | Model must call `equip mace` explicitly (ZincAI can; Zinc cannot do it by name — see B6). Also no sprint-reset, no shield-vs-creeper policy, `maxHealth` hardcoded 20 (`:387`) so Totem/Absorption skews disengage math. |
| B8 | S1 | **[confirmed-by-repro]** | **Point-blank rear creepers can still explode**: at 3.2 m behind the bot, fuse lit in 3/6 sim runs despite 105-262 ms body reaction; at ≥4 m, 0/6 | `audit/repro/08` (measured) | Survival reflex is excellent but not physics-breaking; confined/point-blank creeper encounters remain lethal-ish. Mitigations exist (lit-fuse hard threat, blast radius) — the residual is detection latency + fuse time, a real-world limit, not a logic bug. |
| B9 | S2 | **[confirmed]** | **Dead code / dead capabilities**: (a) `EphemeralMemory` constructed and written on every event (`zincai/memory.js:251,267`) but **no read path exists** — the doc at :291 promises an ephemeral window in `recallBlock` that the implementation never joins; (b) `perception.js` semantic scene/`detectStructures` have **no callers** outside the file | `zincai/memory.js`, `zincai/perception.js` (grep: zero external refs) | Pure drag: tokens in neither case, but ~600 lines of untested-in-integration code and a false doc promise. Either wire ephemeral into the action prompt (it is the right place for "just now" context) or delete both. |
| B10 | S2 | **[confirmed]** | **Chest-contents staleness is invisible to the model**: `lookedAt` timestamps exist but no age is shown; another player emptying/moving stock between scans leaves the model trusting phantom contents | `zincai/places.js` (contents cache, `lookedAt`), prompt builder `zincai/index.js` (nearby/storage lines) | `take` will fail with a hint (`where` resolution is honest), so no unsafe act — but multi-step plans are built on stale beliefs; combined with B1 this is a call-burner on busy SMPs. |
| B11 | S2 | **[likely]** | **No player trust/permission model**: anyone whose chat addresses the bot can ask it to fetch and `give` stored valuables; "friendly SMP" is an assumption, not a control | chat addressing `zincai/filter.js`; `give` in `zincai/skills.js`; no owner allowlist in `zincai/config.json` | One guest saying "zinc, me dá os diamantes" can drain the "Diamantes" chest unless the model declines on manners alone. The system prompt is the only guard. |
| B12 | S0-risk | **[theoretical]** | **Vendored 26.3 data + `tool_choice:"required"` + live AMD endpoint have never been verified live** | `scripts/apply-26.3-data.js`, README "Known limits", `zincai/api_wrapper.js` (required→auto fallback exists) | Entity metadata is now read by key name (26.3-index regression test passes), so a reorder no longer turns pets wild — but whether the *data itself* matches a live 26.3 server, and whether the endpoint honors required tool choice, decides if first boot works at all. |
| B13 | S2 | **[confirmed]** | **`maxHealth` fixed at 20** in combat odds & disengage threshold (`disengageAt = maxHealth*0.3`) | `src/combat.js:376,387,404-405`, `zincai/tactics.js` prompt line "armor 0/20" | Minor in vanilla (always 20); wrong under Absorption/health-boost effects — fight estimate and low-hp refusal trigger off a wrong base. |
| B14 | S3 | **[confirmed]** | **Zinc self-chain cap 12 ⇒ forced 30 s pause** with no escalation of pace under sustained threat; also Zinc has **no `hold`** — on threats it can only idle/attack/move | `src/agent.js` (chain cap), `src/actionParser.js` (action set) | Under a horde the reflex does the running, so the cap mostly costs timely *decisions* (e.g. delayed "go home"). Acceptable for a demo harness; disqualifying for unattended use. |
| B15 | S2 | **[likely]** | **Places rescan skip** (`moved<4 m && <15 s`) defers re-indexing; combined with B10, base interiors change under the bot between scans | `zincai/places.js` scan gating | New chest placed right next to the bot may be invisible for up to 15 s + next scan wave. Small but explains "robotic" moments. |
| B16 | S3 | **[confirmed]** | No dimensions/boats support: portals, nether navigation, boats/ice-roads absent (portal awareness exists only inside the unused `perception.js` structure detector) | grep confirms zero handling outside `perception.js:429,511,545` | Any task crossing a portal or water body stalls/path-fails. Out of scope today; listed so the roadmap owns it explicitly. |

**Fixed since the prior audit, re-verified in this pass** (do not re-fix): door/gate state handling incl. never touching unopened doors; pet/named/tamed protection **by metadata key name** (26.3-safe, repro 07); chase-spam / escape hysteresis (`pocket`/`cornered` honesty, repro 03/04); storage-room summarize-by-label (48/48 chests labelled, 753-char prompt block, repro 06); `take` never guesses; 30-minute `hold` survives task switches (repro 09); PT-BR enforcement incl. retry + fixed fallback line; agenda pause/resume with decision restore; kill-chain capped and animals single by default (repro 07); mace/elytra-charge forecast dodges (repro 07); language/weapon regressions all green in `fixes.test.js`/`fixes.session.test.js` and 43/43 loopback checks.

---

## 7.4 Evaluation of the twenty scenarios

Verdicts: ✅ reliable · 🟡 conditional (works under stated bounds) · ❌ cannot / will fail · ⚪ unverifiable here (needs live server).

1. **Horde attack — open field** — 🟡 **survives, won't win.** Flee reflex at 12 m (near-instant, measured 0.1-0.27 s reaction), escape planner picks `chased`/`open`, threat-cost A* avoids walking back in, model woken with fight-cost arithmetic ("≈ 59 s to kill them all, ≈ 365 dmg → BAD" — measured prompt, repro 04) steering it away from fighting. Kills: if the model insists, the combat loop dies slowly with disengage churn (repro 05). Outcome on a real SMP: bot ends up 60-90 m away, safe, informed model files a report. Good.
2. **Horde — confined/inside a building** — 🟡. Strongest planner feature: `pocket` verdict backs into dead ends *facing them* and reports CORNERED; a second doorway changes the plan to `chased` (repro 03, measured end-to-end escape geometry). Risk: "breaking out through a crowd" was only ever validated geometrically — no mob-push/hit physics in the rig (README admits). Live behavior against 8 real zombies in a corridor is **the** thing to watch first.
3. **Creeper** — 🟡. Lit fuse or TNT = hard threat (always flee, no model veto). Measured (repro 08): creeper at 10 m behind — gap 13-15 m after 1.7 s, fuse lit 0/6; at 3.2 m — fuse 3/6. Charged creepers get a wider ring (`threats.js:498-501`). Outcome: reliable against visible/approaching creepers, dangerous around blind corners and while pillaring.
4. **Ranged attacker (skeletons, pillagers)** — 🟡. Ranged trigger ring 18 m; counted into pressure; flee works. Fighting one skeleton is feasible (strafe + cooldown crits); fighting a pack is not (no arrow-dodge). The odds line says BAD and the model is told — outcome depends on model listening. Bow use by the bot exists (`ranged` profile with min/max bands, `combat.js:79`) but is inventory-luck dependent.
5. **Mace PvP** — 🟡/❌. Smash forecast uses measured motion: real fall ≥1.5 blocks, landing within reach, miss ≤2.5, impact ≤0.9 s → dodge (sim-verified). That's the best you can do without F6 prediction, and better than most hobby bots. But: no totem handling, no anti-stunlock, one dodge = one jump; a mace player who adapts wins. For friendly duels vs casuals: fun and survivable. Vs a geared aggressor: ❌.
6. **Elytra / spear-charge PvP** — ❌ (defense-only 🟡). Charge detection (body arriving faster than sprint on a ≤2.5-block line, ≤0.9 s) is verified in sim; the bot's *own* elytra is auto-deploy/boost with firework logic (`src/elytra.js`), and used as a chase/clutch tool. But offense vs a flying opponent, 3-D tracking with a 20 Hz melee brain, is out of scope; expect losses.
7. **Melee PvP (sword)** — 🟡. Cooldown-gated crit-jump swings at the right threshold, strafe flips, shield raised only vs players between swings, disengage at 30 % hp with 10 s lockout, hurt-attribution report, and a consent-shaped policy (exact-name PvP, needs explicit duel or continued aggression). Missing: sprint-reset/kb control, pot/totem play, bow-slotting pressure. Honest verdict: beats a button-masher, loses to a practiced 1.9+ PvPer. On a *friendly* SMP that is the right ceiling.
8. **Critical injury (low hp, hurt repeatedly)** — ✅ mostly. Eat rule (hurt + food<18 → best food; serialized main-hand, so snack-vs-sword conflicts are arbitrated), MLG-water falls ≥5 blocks, swim reflex, fight refusal at low hp with an explicit explanatory message, flee hysteresis avoids flip-flop. Gaps: no totem use, no "hole up and regenerate" skill, and panic pathing has no light-level awareness. Deepest risk is food running out mid-escape.
9. **Cherry-house discovery (recognizing a player build)** — 🟡. What works: any structure with containers/stations/beds inside 16 m is indexed, persisted, labelled by signs, and resummarized cleanly (48-chest room → 753-char block). What does not: a *pretty house with no chests* is invisible — the scene/structure recognizer exists but is dead code (B9). So "discover and remember Gabriel's cherry house" works if there's a chest/bed inside; fails for pure architecture.
10. **Organized storage** — ✅. Best domestic feature, measured: 48/48 sign associations, `find {what:"Diamantes"}` resolves the label, `find {what:"storage"}` pages, `take` refuses to guess, double-chest merge, item-frame labels. Caveats: contents are item-id-only (no enchanted-book/potion NBT — two different enchanted books collapse), staleness invisible (B10), and scan radius 16 m means a huge warehouse needs a walk-through.
11. **Contained mobs (zoo/pen/exhibit)** — 🟡 leaning ❌ (B2). Named/caged-by-key/tamed = protected and excluded ✔. *Unnamed visible* penned mobs inside 12 m still trigger escapes; the only clean resolution is a model `hold` (30 min) per group. On a base with a mob zoo this produces exactly the "spooked robot" behavior players mock. Priority fix.
12. **Crafting facilities** — 🟡. Basic 2x2/3x3 crafting: resolve-by-live-registry, inventory affording ✔ but B3 (table reach) + B1 make table crafts fragile from >4.5 m. Smelt: works, naive (furnace types, fuel choice, partial stacks). No brewing/enchanting/anvil/grindstone/smithing. Verdict: sticks/planks/chests by request — yes; run a functional workshop — no.
13. **Multilevel navigation** — 🟡. Stairs/slabs/doors/gates ✔; escape planner is time-based per Y-level reachability ✔; builder towers up and *removes its own scaffolds* (only its own, dig verified). Weak: ladders/vines (Mineflayer's eternal flakiness — untested here, [likely]), water elevators (none), and the pathfinder cannot dig so a blocked stairwell = no path report (honest failure, at least).
14. **Cave exploration** — 🟡/❌. As a *passenger*: fine — threat map, mobility, retreat all work underground. As a *caving agent*: no torch placement, no mining, no ore awareness, and watch-ring 32 m in caves means constant harmless-mob pressure reports until `hold`. Current answer to "go caving" is technically `go_to` + vibes. ❌ for the common intent.
15. **Environmental hazards** — 🟡/✅. Falls: MLG bucket ≥5 blocks + elytra fallback (Zinc), sim-verified. Water: swim reflex, no drowning panic issues in tests. Lava/fire: A* pays to avoid, escape `clearToRun` checks lava before sprinting; being *on* fire has no dedicated response beyond flee+eat. Powder snow, magma, sweet-berry: unhandled. Cactus: no special-case (low damage, acceptable).
16. **Interrupted tasks (task preemption/resume)** — ✅. Agenda machinery is genuinely good: side jobs pause mains, decisions restore on resume, sleep resumes in the morning, shelved builds live 30 min, asked-requests queue 5 min, resume cap 8 × 30 min max age; escape decisions recalled 180 s. Tested in `session.test.js`/`zinc.session.test.js`. This is production-shaped.
17. **Chat-while-tasking, PT-BR** — ✅. Separate chat lane (never queues behind the action call), 4/18 rpm reserve, addressing rules (names/aliases/whispers/continuing conversation/one-player questions) with non-addressed chatter not waking the model; every outbound line is function-word-checked as PT-BR with one retry + fixed fallback; `say` in another language is refused. Loopback verified PT-BR small talk during a chase. The remaining risk is a PT-BR-ignoring *model* (see B-mitigations; filter checks EN-vs-PT only).
18. **Multi-player / social memory** — 🟡. Per-player facts (`remember` written by the chat model, shown as "you know from X:"), preferences learned from language patterns, convo persisted 7 days, whisper support (server-plugin dependent). Missing: trust tiers (B11), shared/group facts model ("the server's rules"), and per-player threat memory beyond the 15 s attacker window. Works for friends; exploitable by strangers.
19. **Long-session context pressure** — ✅ architecturally. Prompt is rebuilt stateless every wake: input size is O(current situation), not O(session length) — ~3.6 k tokens at minute 1 and at hour 8 alike (measured sizing, 7.6). Memory growth is bounded (working 5, short-term 10 min, long-term ≤500 with importance-first eviction, convo 7 days). Residual risks: eviction can drop an early base coordinate if 500 chattier entries follow (importance weights mitigate), and the model re-pays the ~3.4 k static prefix every wake (7.6).
20. **Lag / desync / death recovery** — 🟡/✅. Reconnect with backoff, first-join-fatal policy, respawn event → wake with "items were dropped at place 'last death'" and the death is auto-promoted to long-term memory (`zincai/index.js:1206-1212,1074-1076`); builds are idempotent (world-diff re-check per block), so a mid-build disconnect resumes correctly. Lag: 20 s × 3 API timeout with lane isolation means a hung model never freezes the body (reflex is local), but a *slow* SMP (dropped entity updates) degrades LoS/closing-rate quality silently — no TPS probe. Death-item recovery itself is model-driven (`go_to place:"last death"`) — doable, not a guaranteed chore.

---

## 7.5 Additional scenarios found during the audit

Verdicts use the same scale. These were chosen to stress systems the twenty did not.

21. **Nether trip / portal traversal** — ❌. No portal logic, no dimension awareness in pathing, no nether-specific threat tuning (piglin aggression rules, ghasts in the 18 m ranged ring would work, but lava lakes + fall holes + no digging = path chaos). `find/go_to` are same-dimensional. (B16)
22. **Boat / ice-road / water travel** — ❌. No enter-vehicle logic. Long water crossings path around or drown-risk; swim reflex prevents drowning but a 2 km lake = walk the shoreline.
23. **Villager trading** — ❌. Mineflayer supports `bot.trade`; no tool/skill exposes it. Emeralds flow only via chest middlemen.
24. **Farming / animal husbandry** — ❌. No harvest/replant/breed/shear/milk skill; animal kill-chain is correctly single per call (repro 07). A "farm run" is impossible end-to-end.
25. **Long-range elytra travel + landing** — 🟡/❌. Zinc's `elytra.js` auto-deploys + firework-boosts and can chase-hop a 24 m gap; ZincAI uses elytra as a fall-save. Neither has "fly to coordinates": no glide-steering, no landing logic, no durability check. Travel by air = model guessing `go_to` mid-glide, which the task lane will fight.
26. **Overnight with no bed nearby** — 🟡. `sleep` exists and resumes tasks in the morning; without a bed the bot idles/flees all night — safe, but a deterministic "pillar up / dig a bolt-hole / place torch" night skill does not exist. Survival is reflex-guaranteed; productivity is zero.
27. **Server restart / kick / proxy transfer mid-task** — ✅/🟡. Reconnect + idempotent builds + persisted places/memory; in-flight task is cancelled on death/kick (arbiter reset) and, for mains, can be re-asked from the agenda. A kicked state mid-smelt loses furnace contents bookkeeping (contents cache persists but the furnace was 'opened', not tracked as inventory) — edge, acceptable.
28. **Another player reorganizes storage between scans** — 🟡 (B10/B15). Bot walks to a now-empty chest, `take` fails honestly with a hint, no unsafe act, but the plan was built on stale beliefs and (B1) retries are likely. Socially harmless, token-wasteful.
29. **TNT griefing / lit TNT near base** — ✅ (defense). Primed TNT in blast radius is a hard threat — bot flees and reports, never defuses. Correct posture for a friendly SMP.
30. **Being given items / player drops at feet** — 🟡. `give` is bot→player only; there is no pickup-intent skill. Auto-pickup happens physically if walked over; deliberate "take these" from a player = the giver must use a chest or drop + model `go_to`+luck. Awkward but not unsafe.
31. **Two ZincAI processes / name collision** — ❌ guard-by-construction only: login name is hard-coded `ZincAI`/`Zinc`; a second instance fails first join (fatal) — correct fail-closed, but operationally there is no stand-by/failover story.
32. **Spam/loop protection versus players** — 🟡. ChatGuard (3 s cooldown, 100 chars, lowercase) limits Zinc; ZincAI chat-lane spacing 1.2 s + PT-BR checks; a player whisper-looping the bot burns the 4 rpm chat reserve, never the action lane's 14. Adequate; no per-player rate limit though — one griefer can monopolize the chat lane.
33. **Model API hard-down for hours** — ✅ graceful: body keeps surviving (reflex is model-free); chat/event handling stalls; zero crash paths found — reconnect/shutdown handling verified in loopback. The bot becomes a very durable scarecrow until the API returns.
34. **Chunk unload/loading teleport lag on long `go_to`** — 🟡. GoalNear across unloaded frontier has no chunk-wait logic; timeouts report honestly (`no path`). Long expeditions need waypoints; the model can chain them but that is per-leg model calls.

**What Zinc (small harness) covers from the above:** essentially only the survival reflex slice (flee/eat/MLG/elytra) + chat + single crafts + attack/move. Scenarios 9-13, 16, 18-19 domestic are structurally out of reach for Zinc (no inventory/places lines, no take/put/sleep/follow, equip-by-slot blind — B6). Treat Zinc as the reference implementation of "how small can the prompt be while the body carries everything," not as a deployable SMP member.

---

## 7.6 Context-window and memory analysis

**Shape of the cost.** Both harnesses are **stateless-per-call**: the entire world view is rebuilt from local indexes on every wake. There is no conversation history in the action lane at all (a deliberate, correct trade). Consequence: *input tokens per call are constant in session length* — long sessions press on **call count**, not context size.

**Measured sizes** (executed in this session; character counts exact, token counts at the repo's own ≈3.7 chars/token rule — the 3.7 ratio itself is an *estimate*, marked est):

| Component | Chars (measured) | Tokens (est @3.7) |
|---|---|---|
| ZincAI action: system prompt (`zincai/system_prompt.txt`) | 4,007 | ≈1,083 |
| ZincAI action: 23 tool schemas (`api_wrapper.js`) | 8,523 | ≈2,304 |
| ZincAI action: typical horde snapshot (state block) | ≈890 | ≈240 |
| **ZincAI action call total (horde)** | **≈13,420** | **≈3,626 (matches repro 04's printed 3626)** |
| **ZincAI action call total (mid-conversation, 1 zombie)** — measured on the wire by repro 12 (whole request: system+user+tools) | **13,830** | **≈3,738** |
| ZincAI chat call (whole request: `chat_prompt.txt` system 1,921 + `reply` schema 819 + 431-char user with 4-line conversation) — measured on the wire by repro 12 | **3,422** | **≈925** |
| Zinc full call (system + vitals + 5 events + memory) | ≈85 + ≈1,180 | ≈317 total (measured by repro 10: 262 system + 55 user) |

**Where the tokens go.** ~63 % of every ZincAI action call is **tool schemas**; system prompt ~30 %; the actual world state ~7 %. The snapshot is impressively lean (27 hostile mobs rendered in ≈240 tokens). The cost problem is therefore *prompt-prefix overhead × wake rate*, not context rot.

**Memory tiers and pressure:**

| Tier | Bound | Growth behavior over hours | Risk |
|---|---|---|---|
| working (`memory.js`) | 5 entries | constant | none; but "what was I doing 6 events ago" is gone |
| short-term | 10 min | constant | none |
| long-term JSON | 500 entries, cosine>0.92 dedupe, evict lowest-importance-then-oldest (`memory.js:193-196`) | linear until cap, then churn | many chatty days can evict day-1 coordinates; importance weighting (deaths/builds/gifts promoted) is the only defense — **unmeasured in practice** [theoretical] |
| conversation | 7 days | time-bounded | none |
| places index | radius-scanned, persisted, summarized >9 | bounded by world | stale contents invisible (B10) |
| ephemeral | 30 s × 12 | — | **dead code** (B9): written, never read |
| chat line window in prompts | 6 lines | constant | speaker context older than 6 lines exists only if `remember`/facts caught it |

**Asymptotic verdict:** context-window blowup is a non-issue by design; information *loss* (working=5, eviction at 500, chat=6) is the real pressure. The system forgets by dropping, never by overflowing — the right failure mode for 8-hour sessions.

---

## 7.7 Latency and API usage

**Rate & spacing (configured, `zincai/config.json` + `zincai/brain.js`):** shared 18 rpm; chat reserve 4 rpm; action spacing 3 s (1 s urgent: reflex starts/material changes/cornered); chat spacing 1.2 s; AMD client timeout 20 s with ≤2 retries (worst-case 60 s for one action call; chat timeout 12 s with no retry of the same wake). Lanes never queue behind each other.

**Per-call latency profile (est; sandbox cannot reach AMD):** action answer = endpoint latency (one completion, one tool call, `tool_choice:required`, no re-prompt); a slow/hung endpoint costs the body **nothing** (reflex independent) and costs the chat lane at most one late reply.

**API consumption scenarios (input tokens; est from measured sizes; output is tiny — one tool call or one chat line, <120 tok):**

| Situation | Calls/min | Input tokens/min | Input tokens/hour |
|---|---|---|---|
| Idle overnight (heartbeat 90 s → ×(1+idleStreak) up to 6 min) | 0.2-0.7 | ~0.7-2.5 k | ~40-150 k |
| Domestic work (storage run, fetch/craft for a player) | 2-5 | ~7-18 k | — (session-scale: 15-40 k/task) |
| Active combat/escape episode | up to 18 cap; observed 6 refused actions in 14 s (B1, repro 05) | up to ~65 k at cap; typical episode 8-15 calls ≈ 29-54 k | unbounded if episode never resolves — the cap is the only ceiling |
| Chat-heavy evening (3 players talking to it) | chat ≤4 reserved + occasional action | ~4-8 k | ~250-500 k |

**Findings:** (1) the rpm cap is the only defense against token storms, and B1 shows the model can burn it entirely on refusals; (2) 63 % of spend is static prefix — if the endpoint supports **prompt caching**, enable it: same-prefix calls make the 3.4 k static part near-free; (3) per-mode schema subsets (e.g. builder mode need not ship `smelt`/`sleep` schemas) could shave 15-30 % of the schema block; (4) there is **no usage accounting logged** — `AmdToolsClient` returns `usage` (`api_wrapper.js`) and it should be persisted per call to make this table real instead of estimated.

---

## 7.8 Recommended architecture

**Keep the spine.** The reflex/arbiter/escape-planner/places/agenda structure is correct and should not be re-architected. Change at the edges, in this spirit: *every repeatedly-needed behavior should migrate from "the model improvises it every time" to "local code does it, the model names it."* Today judgement tasks are wired that way; acquisition and maintenance chores are not — that asymmetry is the main gap.

For each proposal: how it works · problem · changes · pros · cons · complexity · API/latency impact · friendly-SMP fit.

### A. Failure-aware action gate (P0)
- **How:** in `executeAction`'s failure path, key each failure by `tool+canonical-args` (e.g. `attack:zombie`, `craft:iron_pickaxe`, `take:chest41:diamond`); on ≥2 identical failures within N seconds, (a) refuse the next identical call locally with a richer message ("already failed twice: table too far — walk closer or pick another table"), (b) append the failure signature to the threat/results line so the prompt itself discourages a third attempt, (c) auto-clear on success or on state change that plausibly fixes it (moved ≥4 m, inventory changed, N s passed).
- **Problem:** B1 (measured 6 refused calls/14 s); token burn and model whiplash.
- **Changes:** ~80 lines in `zincai/index.js` + tests; Zinc's executor gets the same two-line guard.
- **Pros:** kills the worst measured token-storm with zero model-quality dependency; generic across all tools. **Cons:** a genuinely transient failure could be briefly blocked (mitigated by the state-change reset). **Complexity:** low. **API impact:** strictly negative (fewer calls; worst-case savings ≈ full 18 rpm). **SMP fit:** neutral-safe.

### B. Containment demotion in ThreatSense (P0)
- **How:** for a LoS-visible hostile inside the trigger ring, run the *existing* reachability probe (already cached, 6 ms budget) as a **demotion** check too: `real && route===false` ⇒ move it to `hidden` (with `caged:true`) unless it is a recent attacker or lit/explosive. Fenence/wall pens already fail reachability; exhibits keep working. Keep the kill-switch: a contained mob that *damaged* the bot recently stays real.
- **Problem:** B2 — penned/zoo mobs trigger escapes and model wakes on a settled base.
- **Changes:** ~15 lines in `zincai/threats.js` classify loop + poison-test entries; the probe infra already exists (used additively at :514).
- **Pros:** removes the most socially embarrassing behavior class; zero new dependencies. **Cons:** a mob that *can* reach the bot by a long route while looking penned stays real (correct); probe cheapness must be re-verified on a busy base (≈1 extra cached probe per visible contained mob per 2 s). **Complexity:** low. **API impact:** reduces spurious wakes. **SMP fit:** high — zoos and farms stop scaring the bot.

### C. Deterministic chore skills (P1, the real unlock)
- **How:** add code-owned skills following the existing skills.js pattern, each with explicit params, body-level execution, honest failure strings: `gather {item, count}` (mine/flawless pathfind-to-block + dig with digging-enabled Movements scoped to the skill), `chop {log, count}`, `harvest {crop}`, `light_up {radius}` (torch placement with light-level threshold), `shelter` (3x3x2 bolt-hole or pillar using builder primitives + scaffold cleanup that already exists), `corpse_run` (go_to 'last death' + pickup watch + inventory-full handling). The model only *chooses* chores; the body does grids, tools, and retries.
- **Problem:** B4 (no acquisition), scenario 14/16 gaps; today every unmet material need dead-ends a task.
- **Changes:** new `zincai/chores.js` (~400-600 lines), 4-6 new tool schemas (+~600-900 schema tokens — offset by G), permission gate D applies to digging near claims. **Pros:** converts the bot from redistributor to participant; deterministic = testable; each chore kills a whole class of model improvisations. **Cons:** Mineflayer digging near bases must be claim/consent-aware (dig allowlist: ore/stone/logs/crops only, never player builds — heuristic + configured blacklist); biggest single build in this roadmap. **Complexity:** medium-high. **API impact:** *reduces* calls per task (one chore call replaces tens of go_to/craft turns). **SMP fit:** high if dig allowlist is strict.

### D. Owner/trust model (P0-minimal, P1-full)
- **How:** config `trust: { owners: [...], trusted: [...] }`; action-side gate: `give`/`take`/`put` on containers labelled valuable (config regex, e.g. `Diamantes|Netherite`) and any `run_script` require requester ∈ trusted; owners may override holds; chat policy line injected per-speaker ("speaker trust: guest").
- **Problem:** B11 — any addressed stranger can drain storage via politeness.
- **Changes:** ~60 lines (config + one gate in executeAction + prompt line). **Pros:** cheap, deterministic, auditable. **Cons:** security-by-username (offline-mode name spoofing is a *server* config issue — document it). **Complexity:** low. **API impact:** none. **SMP fit:** essential for a bot with storage access.

### E. Craft-table approach fix (P0, one-liner class)
- **How:** in `craftItem` (or its callers), when `recipe.requiresTable` and distance(table) > 4, pathfind `GoalNear(table, 2)` first; reuse threat-map cost so the approach itself is safe. **Problem:** B3. **Changes:** ~15 lines in `src/recipes.js` + test. **Pros:** deletes a whole failure class. **Cons:** none. **Complexity:** trivial. **API impact:** fewer retries (with A). **SMP fit:** neutral.

### F. Builder preflight per phase + full palette exposure (P1)
- **How:** check materials for the *current* stage only (foundation → walls → roof → details), return a structured `missing` list the model can turn into `gather` (C) or a chat ask; include the block palette in the inline-grid schema description; final phase reports per-stage counters that already exist.
- **Problem:** build starts that stall mid-roof (prior audit item), model blind to what a stage needs. **Changes:** `zincai/builder.js` preflight scoping + schema text. **Pros:** builds become resumable by design; user gets a useful shopping list. **Cons:** none material. **Complexity:** low. **API impact:** fewer doomed build wakes. **SMP fit:** good — never silently consumes.

### G. Prompt-prefix economy (P1)
- **How:** (1) persist `usage` per call (client already returns it) into a metrics log; (2) enable provider prompt caching when available; (3) per-mode schema subsets: builder mode ships build tools; explorer drops `smelt/sleep/build`; (4) shorten the four longest tool descriptions by moving policy details into `system_prompt.txt` (which caches with the same prefix either way — so prefer *deleting* redundant text over moving it).
- **Problem:** 63 % of per-call input is schemas (measured). **Changes:** config + schema assembly in `api_wrapper.js`; metrics writer. **Pros:** 15-30 % input reduction without behavior change; caching makes the static ~3.4 k near-free per extra call. **Cons:** per-mode schemas risk the model lacking a tool it suddenly wants — mitigate by always keeping `say/idle/stop/find/set_mode` (mode switch is itself a tool). **Complexity:** low-medium. **SMP fit:** neutral.

### H. Live verification rig (P0)
- **How:** a local **Paper 1.21.x** server (real mob AI, real movement, plugins optional) stood up in CI-adjacent scripts; the existing loopback pattern extended: scripted model driver + scenario steps; AMD canary = one CI job hitting the real endpoint with a 1-tool "say" and asserting `tool_choice:required` behavior (fallback to `auto` already coded). **Problem:** B12 and every ⚪ in 7.4. **Changes:** `test/live/` directory; no production code. **Pros:** converts "likely/theoretical" to measured; first-boot confidence. **Cons:** Docker/CI weight; Paper download in CI. **Complexity:** medium. **API impact:** none (canary ~50 tokens/day). **SMP fit:** it *is* the SMP-fit gate.

### I. Response validation & language hardening (P0)
- **How:** check `finish_reason` and empty-tool-call responses (retry once with "you must call a tool"); extend the PT-BR check with a couple of ES/FR/DE function words; surface "uncertain classification" as a prompt line rather than silent. **Problem:** silent non-answers and non-PT lines slipping through short utterances (filter limitation is documented). **Changes:** `zincai/api_wrapper.js` + `zincai/filter.js`. **Pros:** closes the last "the model answered nothing" hole. **Cons:** retry costs one call. **Complexity:** low. **API impact:** +occasional retry. **SMP fit:** needed.

### J. Traversal kit (P2)
- **How:** boats (`bot.mount`), portal walk-through + dimension tag on places entries, elytra "fly_to" (deploy → pitch control → flare land) as a skill with fuel/durability guard; nether routing gets a stricter Movements set. **Problem:** B16; scenarios 21-22, 25. **Complexity:** high (elytra landing is genuinely hard to make safe). **API impact:** neutral. **SMP fit:** good once C and gate D exist.

### K. Wire or delete the dead capabilities (P2)
- **How:** either surface `memory.ephemeral` as a `just now:` line in the action prompt (recommended: genuinely useful for "the chest I just opened"), and call `semanticScene` from builder mode's prompt — or delete both. **Problem:** B9. **Complexity:** trivial either way. **API impact:** wiring adds ≈30-60 tokens/wake.

### L. Posture on the two harnesses (decision, P1)
- **Recommendation:** productionize **ZincAI only**; keep Zinc as the minimal-reference (and its reflex body shared). If Zinc must remain deployed: add an inventory line + equip-by-name (`src/agent.js`) and a `hold` action; do not chase full domestic parity — that duplicates ZincAI badly. **Complexity:** the minimal Zinc patch is low. **SMP fit:** reduces the attack surface of two divergent behavior sets.

---

## 7.9 Prioritized roadmap (P0 → P3)

**P0 — "safe to leave alone on the server" (days, all small):**
1. **H** Live verification rig: Paper staging server + AMD canary (`tool_choice:required` fallback assertion). *Unblocks every ⚪ in this report.*
2. **A** Failure-aware action gate. *Stops the measured refusal storms.*
3. **B** Containment demotion via the existing reachability probe. *Stops pen/zoo flee loops.*
4. **E** Craft-table approach before `bot.craft`.
5. **D-min** Owner/trusted gate on `give/take/put` for valuables + `run_script` owner-only.
6. **I** `finish_reason`/empty-tool retry + ES/DE/FR words in the language check.
7. Persist `usage` per call (from **G**) so token claims stop being estimates.

**P1 — "actually useful member" (1-2 weeks):**
8. **C** Chore skills v1: `gather/chop` (dig-allowlisted), `light_up`, `shelter`, `corpse_run`.
9. **F** Builder per-phase preflight + palette in schema.
10. **G** Caching + per-mode schema subsets.
11. **D-full** trust tiers surfaced in prompts; per-player chat rate limit (scenario 32).
12. Staleness surfacing for chest contents (`lookedAt` age in the line; B10) and a 0ms-cost invalidation on `blockUpdate` for indexed containers (B15).
13. **L** Zinc: inventory line + equip-by-name + `hold`, or formally freeze Zinc as demo.

**P2 — "world-ready" (weeks, only with P1 green live):**
14. **J** Boats, portals/dimension-aware places, basic nether routing.
15. Smelt v2 (furnace types, fuel policy, partial stacks); brewing/enchant/anvil skills if SMP actually wants them.
16. Combat polish *iff duels are in scope*: sprint-reset timing, bow-slot pressure, totem equip rule — otherwise skip entirely; friendly SMP does not need it.
17. **K** Wire ephemeral + semanticScene or delete them.

**P3 — "ambitious" (only with evidence):** elytra `fly_to` with landing; group/shared memory model; embeddings instead of bag-of-words (only if long-term >500 shows real recall failures in metrics); TPS/latency probe adapting watch radii.

Explicitly **not recommended**: a chain-of-thought/planning lane (the agenda already carries intent; CoT would double input cost for tasks the body handles), vision models (architectural mismatch — the voxel ASCII view + places index covers the actual needs listed here), and auto-retaliation defaults (current consent posture is SMP-correct).

## 7.10 Testing plan with metrics

**Gate philosophy:** keep the 196 unit + 43 loopback checks green forever; each P0/P1 item lands with (a) a repro script in `audit/repro/` that fails before/passes after, and (b) a live-staging assertion.

| Layer | What | Pass metrics |
|---|---|---|
| Canary (per deploy) | AMD endpoint: 1 required-tool call, 1 auto fallback, PT-BR line check | 3/3; p95 latency recorded |
| Live staging (Paper 1.21.x, real mobs, 2-3 human or bot "players") | The 20 scenarios + scenarios 21-34 that are in-scope for the phase | per-scenario outcome (below) |
| Soak | 8 h unattended friendly-base session | 0 crashes; 0 deaths to non-point-blank causes; calls/day ≤ 1,500 input ≤ 3 M tokens (targets, to be recalibrated by real `usage` data); PT-BR compliance 100 % of outbound lines; 0 valuable-chest actions by non-trusted names |
| Chaos | kill bot mid-build; restart server mid-follow; empty a chest between plan and take; tee a penned zombie + a free zombie | build resumes idempotently (0 double-placed, 0 lost scaffolds); task state consistent; `take` fails honestly ≤2 calls; bot flees the free zombie and ignores the penned one (post-B) |
| Combat box | spawn-camped creeper at 3/4/6/8/10 m behind; 24-zombie open horde; 8-zombie corridor | fuse-lit rate at each range (baseline 3/6 @3.2 m); horde: safe-distance reached, time-to-safe, calls consumed (target ≤ 12 calls/episode post-A) |
| Domestic KPIs | storage fetch task ("bring me 4 diamonds") | success rate, wall-clock, calls/task (target ≤ 8), stale-content failures (target 0 post-P1.12) |
| Social | 3 players interleaved PT/EN chatter + one griefer asking for diamonds | correct addressee rate; 0 unwarranted `give`; chat answers ≤ 3 s p95 during a flee episode |
| Regression | `npm test`, `loopback.js`, all `audit/repro/*` | 196 + 43 + all repros green |

**Instrumentation to add first (part of P0.7):** per-call `{lane, why, tool, ok, in_tok, out_tok, latency_ms}` JSONL; counters for escapes started/ended, holds, refusals, repeated-failure gate hits; a session summary line on shutdown. Every metric row above then becomes a query over logs, not a re-run.

---

## Appendix — verification log (what was actually executed)

- `npm install` → `npm test`: 196/196 pass (98 s).
- `test/e2e`: `npm install` (flying-squid) → `node loopback.js`: **43/43 pass**, incl. both harnesses end-to-end against a real 1.16.5 protocol server with scripted model; PT-BR chat captured; hurt attribution, flee-then-decide attack, stop, cornered-honesty checks all pass.
- `audit/repro/01-11` re-run: doors 9/9 including iron-door honest `noPath`; escape planner cliff/ring/two-exit cases all 0 hits taken post-fix; horde snapshot cost printed 3,626 input tokens; attack-refusal loop (B1) reproduced; 48-chest storage room labelled 48/48 with a 753-char prompt block; creeper timing runs (B8); metadata-key domestication check; hold/TTL expiry transcript correct; Zinc minimal call ≈317 tokens.
- Token sizes measured by serializing the real artifacts: `system_prompt.txt` 4,007 chars; 23 tool schemas 8,523 chars; `chat_prompt.txt` 1,922 chars; horde snapshot 890 chars. Token columns use the repo's 3.7 chars/token heuristic (est); exact tokens require the live tokenizer.
- New this pass: `audit/repro/12-call-sizes.js` (measured on-the-wire request sizes: action 13,830 chars ≈ 3,738 tok; chat 3,422 chars ≈ 925 tok), `13-stale-request.js` (B5 confirmed with a no-chat control: stale chat drives `recalled:` inside a pure flee wake), `14-penned-mob.js` (B2 confirmed with an open-ground control: penned-visible zombie starts a flee episode identically to a loose one).
- Not executable here: anything requiring the live AMD endpoint, a Mojang-protocol ≥1.21 production server, or real hostile mob AI. All dependent claims are labelled ⚪/[likely]/[theoretical] above.
