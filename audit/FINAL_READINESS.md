# ZincAI: offline audit and pre-test readiness — 2026-11-12

## 1. Executive summary

**Verdict: suitable only for *supervised, isolated, disposable-world integration tests*, not unattended use or an ordinary shared SMP.** There are meaningful existing building blocks: two independent model lanes, local flee reflex, an escape planner, a control arbiter, typed tools, container/sign indexing, and short/long-term memory. The offline tests exercise many of these as a system, not just as isolated functions. They do not establish live protocol compatibility, survival, correct model judgment, or social safety.

This pass fixed real startup configuration loss, a tool argument/action-name override, stale in-flight responses after major changes/death/disconnect, a private-to-public chat leak, concurrent `useHand` borrowing, misleading build counts, and added a small identity/memory cue and provenance labels. This does **not** finish the requested architecture. Most importantly, exact player naming is not PvP authorization; gatherable blocks can be player structures; there is no general ownership authorization, durable task checkpoint, UUID-linked social identity, actual semantic redstone inspector, or verified PT-BR guarantee. Those are blockers for unrestricted shared-world testing.

**Evidence and limits:** The main focus is the full `zincai/` runtime; `src/` is a separate, smaller harness sharing combat/reflex components and does not inherit the new identity, memory, schema, or session fixes. We traced representative end-to-end control, memory, prompt, social, and tool paths, and reviewed the previous audit and fix logs. This is not proof that every branch of ~19,000 lines or every historical claim was independently re-executed. The historical loopback claimed in `FIXES2.md` was **not rerun**: it starts a Minecraft server, prohibited for this phase. No server, live endpoint, live game, or destructive experiment was used.

`npm run check` passed. After `npm ci --ignore-scripts`, explicitly running `node scripts/apply-26.3-data.js` succeeded; the complete final `npm test` passed **223/223**. The first run before the vendored data postinstall returned 210/212; output was truncated, so its two failures cannot be confidently attributed to a specific cause. Both dry runs succeeded with a dummy local API-key value, without connecting; neither validates real credentials or the AMD endpoint. `npm ci` reported 9 moderate dependency advisories, not individually triaged. The new tests are included in `npm test`. Runtime logs showing a server address during session tests are produced by mocked `mineflayer.createBot`, not a connection.

## 2. Architecture actually in use

```text
Minecraft packets/chat -> Mineflayer state -> ThreatSense + places + observations
        |                         |                |
        |                HurtTracker / 200ms System1 + escape flood
        |                         |                |    (local, no model)
        |                         v                v
        |                 ControlArbiter: survival > combat > task > idle
        |                         ^                ^
        |                         |        Skills / builder / combat
        |                         |                ^
        +-> Brain events -> action snapshot -> model tools -> validation -> executor
        +-> chat routing -> chat snapshot -> reply/task/remember -> Brain action wake
                                  ^
        JSON memories/preferences/conversations + dimension-keyed PlaceIndex
```

`zincai/index.js:757-853,882-951,1030-1160` builds fresh action/chat snapshots and executes decisions. `brain.js` schedules separate in-flight slots with a shared budget; reflex and movement do not wait for either model. `system1.js` and `custom_mineflayer/escape.js` manage emergency flee; `src/combat.js` handles attack timing/positioning. `control.js` mediates movement, but not every caller borrows the hand. `places.js` stores block/label/content observations; `memory.js` stores episodic text and preferences; `agenda` is only in the current session. The model can choose actions, but reflex acknowledgements and automatic resume influence later control. `perception.js` has richer standalone functions, yet `buildActionPrompt` uses only the builder-mode vision block, not its general semantic scene. This diagram describes implementation, not the desired future circuit graph or durable task service.

## 3. Verification of earlier audits

Status is **code/test-level**, not live certification. The baseline has one shallow merge commit, so earlier branches/commit history are not available here; the frozen reports and fix logs are the available checklist. The 223-test run includes the prior regression suites. Items not separately traced are marked unverified rather than endorsed.

### Second audit (`AUDIT2.md` B1–B16)

| ID | Current verification |
|---|---|
| B1 | Fixed for repeated identical failures: `failgate.js`, wired in `executeAction`; existing simulated-session test passes. Not a general semantic retry limiter. |
| B2 | Partial: reachable probe can demote visible contained melee mobs; existing B2 tests pass. Ranged, attackers and probe uncertainty intentionally exempt, not proof all enclosures are safe. |
| B3 | Fixed in code/tests: crafting approaches a table (`skills.js`, `src/recipes.js`). |
| B4 | Partial: gather/light/shelter/corpse-run exist, but raw block type does **not** prove natural or unowned; earlier “never player builds” claim is false. Farming/trading remain absent. |
| B5 | Fixed bounded age of previous chat in `buildActionPrompt`; still no general contextual retrieval. |
| B6 | Fixed in smaller `src/` harness: names and inventory supported; existing tests pass. |
| B7 | Fixed heuristic scores for mace/trident/spear in `src/combat.js`; does not establish correct new-version mechanics or tactical selection. |
| B8 | Improved, not solved: flee and ground-check logic exists; earlier point-blank simulator results remain historical, not live proof. |
| B9 | Ephemeral data now injected, but semantic scene remains outside normal action prompt. |
| B10 | Content age exposed; inspect/open before use still necessary. Server-side changes without blockUpdate remain possible. |
| B11 | Partial/regression fixed here: optional name-based trust gate existed, but `loadConfig` dropped `trust`, making it inert on normal startup. Tests previously mutated loaded config and missed this. Now loaded, but default empty, spoofable, and covers only a narrow subset. |
| B12 | Mitigation kit exists (`test/live`, canary), not verification; neither was run. |
| B13 | Partial: observed max HP in combat, but observation line still says `/20`, and absorption is not generally interchangeable with max health. Effects/version behavior unverified. |
| B14 | `hold` exists in both; the smaller harness still has self-chain/rate limits. |
| B15 | Nearby indexed block changes invalidate/adopt entries; not a complete server inventory-change subscription. |
| B16 | Deferred: dimension-aware place keys are present, not portal route planning, boats, or reliable cross-dimension travel. |

### First audit (`REPORT.md`) checklist

| IDs | Current state |
|---|---|
| M1, M2 | Door/gate handling and opened-by-us ledger exist; prior offline regression suite passes; real server behavior unverified. |
| M3, M4, M5 | Flood-based escape and ground checks implemented; dynamic replanning exists; safe route guarantees/physics not established. |
| M6 | Hazard coverage incomplete; no general risk-aware hazard policy for all listed blocks. |
| M7 | Elytra/equipment restoration still requires live verification; no comprehensive equipment transaction model. |
| M8, M9, M10, M11 | Task stuck recovery, sleeping interruption, sampling artifacts, and reachability budget not individually re-established here; assume partial/unverified, not fixed. |
| T1 | Metadata-key lookup and conservative tame handling exist; exact live registry still unverified. |
| T2, T3 | Escape episode/hysteresis and aggregated threat/watch lines exist; older simulator tests pass. Not omniscient over unloaded entities. |
| T4 | Food selection considers healing and hunger; resource-value choices remain heuristic. |
| T5 | Hold acknowledgement TTL/event reporting present, tested offline. |
| T6, T7 | Registry/hostile-name handling and charged/lit flags exist; completeness across versions unknown. |
| T8 | Shield lowering on preemption appears in combat path; live timing unverified. |
| C1 | Animal chain default one, hostile cap, tested. Does not authorize harming farm animals. |
| C2 | Still single-target fighting; horde kiting/coordinated multi-target defense incomplete. |
| C3 | Weapon scoring improved, enchantments and optimal choices remain incomplete. |
| C4 | Motion/impact forecast exists and offline tests pass; real PvP physics unverified. |
| C5, C6 | Advanced sprint-reset, opponent shield/axe tactics incomplete. |
| C7 | Partially improved, see B13 above. |
| C8 | **Previously still broken in ZincAI, fixed here:** mob-name and `any` requests could match a player whose username equalled the requested type; direct and kill-chain targeting now require `attack.player`. The smaller `src/` harness deliberately retains its legacy name-based interface. Neither enforces consent. |
| S1–S5 | Storage summaries, exact item selection, label find, longer informational results implemented and tested; sign proximity remains heuristic. |
| S6 | Furnace variants, fuel valuation, reminder/workflow limitations remain. |
| S7 | Table approach implemented. |
| S8 | Item-frame association exists; full 26.3 container coverage/double-chest correctness unverified live. |
| S9 | Gather added; breeding, trading, brewing/enchanting etc. remain missing. |
| S10, S11 | Item-component granularity and delayed-window race not independently closed; treat as open/unverified. |
| B1 | Truncation detection and retry added; no guarantee of actual endpoint behavior or complete nested schema validation. |
| B2 | PT-BR instruction, heuristic and retry exist; language detection cannot guarantee every utterance is PT-BR. |
| B3 | Same-session agenda and pause/resume implemented; not durable progress. |
| B4 | Separate chat/action lanes and reservation implemented; config loss of their AMD settings repaired here. Shared budget/endpoint can still stall. |
| B5 | Player facts and preferences persist; provenance and automatic context are incomplete. |
| B6 | General semantic scene remains unwired to regular prompt. |
| B7 | Per-phase preflight and inline palette in schema; exact orientation/placement verification remains insufficient. |
| B8 | Door handling and sleep side-task behavior implemented; not a live guarantee. |
| B9 | Per-mode schema reduction exists; still sizable, and discovery of omitted tools requires mode switch. |
| B10 | Nickname/address filters expanded; ambiguous multi-player intent remains uncertain. |
| B11 | `perception3D` and related config are not general automatic 3D reasoning; builder mode alone supplies category grids. |
| O1 | Key rotation cannot be verified from this checkout. Operator must rotate any historically exposed credentials. |
| O2 | Named metadata lookup and vendored patch exist; live 26.3 parity remains unknown. |
| O3 | Offline-mode/public-tunnel risk remains; optional name trust is not authentication. |

## 4. Important findings and changes

**P0 confirmed — player violence not authorized by code.** `zincai/index.js:1097`, `src/combat.js:538-630`: explicit model-supplied name is sufficient to initiate PvP, even if the player never attacked or consented. Prompt instruction is not a safety boundary; unknown players are neutral in sensing but not protected from an erroneous tool call. One hit can produce flee without identity; uncertain swing attribution exists in `threats.js:418,735-764`. **Not fixed**: enforce server-authenticated identity plus per-target, expiring, explicitly recorded consent or confirmed recent direct attack; default retreat, avoid authorizing on probable attribution. Disable PvP in tests until then, or isolate disposable consenting accounts.

**P0 confirmed, fixed for ZincAI — mob/player name collision.** `src/combat.js:538-580`, `zincai/index.js:979,1101`: a mob request or hostile kill chain could select a player named `zombie` or `any` because string matches considered players. ZincAI now opts into explicit-player-only resolution in both paths; a mock executor test confirms `attack.target` cannot engage that player. `src/` retains the older name-based interface for compatibility and remains exposed. This fixes target-type confusion, not the lack of consent checks described above.

**P0 confirmed — property safety absent.** `skills.js:666-725`, `api_wrapper.js:108`, `index.js:499-505,1145`: gather matches block type only; a house made of oak logs/stone can be selected and dug. Building, torches, gate use, storage and scripts have no generalized property permission check. The existing trust gate is optional, username-based, limited to a few valuable item strings and scripts, and can lose attribution after the initiating turn. **Not fixed** except removing the false tool description. Before any shared-world test, require explicit operator-approved test regions and per-action/region authorization, or disable mutating tools externally; whitelisting alone does not establish ownership.

**P0 confirmed, fixed on startup — configuration dropped.** `index.js:84-125` previously omitted `trust`, `amd.maxConcurrent`, `chatTimeoutMs`, `chatMaxRetries`. Actual configuration silently fell back to defaults; tests setting `cfg.trust` after loading could not detect it. Now retained and checked by `final-audit.test.js`. The optional trust mechanism remains insufficient above.

**P0 confirmed, fixed for native tool calls — model can override selected action.** `api_wrapper.js:181-253`: previously `{a: name, ...args}` allowed `idle` with an `a: attack` argument to run a different tool. Now undeclared keys, missing required fields, basic types and enums are checked, the tool name wins, fallback JSON is validated, and selected tools must be in the offered mode catalog. Nested schemas and contextual constraints are not fully validated; semantic authorization is still mandatory. Tests cover override, missing, type and enum cases.

**P1 confirmed, partly fixed — stale decisions.** `index.js:882-909,916-951,1341,1414,1482`: previously a slow response could execute after death, disposal, or an urgent threat/new task. An epoch now discards those responses, re-wakes for changed situations, avoids reviving pre-death reasons, and suppresses actions while dead; chat replies are discarded after death/disposal. Simulated tests cover delayed death and disposal, not every teleport, chunk update, inventory change, long-running async effect or exact cancellation race. Add state/version checks to action commit points and safe recovery from teleport/dimension changes.

**P1 confirmed, fixed for guarded hand operations — overlapping priority borrowers.** `control.js:275-299` let a higher priority borrower overwrite `_handBusy` while the first was awaiting, so first restore could overwrite the emergency item. Now *all* borrowers are refused while busy and may retry. The tradeoff is that a long operation can delay emergency item use; raw `bot.equip` calls in skills/builder/combat still bypass this lock. A cancellable centralized item-use transaction is needed; current fix is not complete hand arbitration.

**P1 confirmed, fixed — private-message disclosure.** `index.js:428-446`: failed `guard.whisper` previously sent the text publicly. It is now dropped with a warning; simulated missing-recipient test checks no outgoing chat. A queued message can still become undeliverable without a model-visible result; surface that later.

**P1 confirmed — durable continuity insufficient.** `index.js:522,583-604,1414`; `memory.js:153-248`: agenda closure/progress is RAM only, discarded on death/session end; reconnect starts a new session. Memory writes catch errors silently; the 500-entry eviction can remove important social facts. No critical-state journal, compaction, consistency protocol, TTL, verified confidence, conflict handling or backup. Implement a small versioned durable objective/checkpoint store with restart marked **needs reassessment**, atomic error reporting, and tests for repeated restarts before automatic resume.

**P1 confirmed — model can be misled by memory.** `memory.js:179-248,295-379`: text overlap, substring `factsAbout`, name tags and model-written interpretations can misattribute people or conflate names; exact identity, alias/UUID mapping, contradiction handling and semantic retrieval are missing. New provenance labels/date and caution improve recall, not establish truth; `factsAbout`/preferences still lack full metadata. Bound personal recall, store source/subject separately and link to server-validated UUID.

**P1 confirmed — health/quantity reporting can mislead.** `observe.js:19-38` renders health `/20`; `skills.js:666-725` counts blocks dug, not confirmed pickups, and partial gather returns `ok`. The builder previously reported already-present blocks as newly placed; output is corrected at `index.js:1019`. Models must distinguish progress vs objective completion. Build orientation/property states are not verified by name-only idempotence. Add objective-level inventory delta verification and report partial results explicitly.

**P1 confirmed — privacy, spoofing, and prompt injection are not solved by attribution labels.** `filter.js`, `index.js:1449-1479`: messages parsed from formatted server chat are not cryptographically authenticated, and external text is included in prompts. Offline-mode names and UUIDs can be impersonated. Treat all chat, signs, memories and model summaries as untrusted data and establish server-side auth/authorization; do not grant authority from text assertions.

**P2 confirmed — incomplete action information and context.** `api_wrapper.js:51-169`, `index.js:757-853`: no general inspect/circuit trace or runtime autocomplete; mode pruning hides tools until mode change. The model sees abbreviated entities/inventory, not all equipment durability, LOS/projectiles/effects. `perception.js:495-635` semantic detection is not called on the regular action path. Add bounded targeted inspections and a discoverable catalog; do not add unsupported capability claims.

**P2 risk — concurrency outside arbiter.** `builder.js:309-352`, `skills.js`, `src/combat.js` use direct equip/look/attack in places. Movement arbitration does not automatically cancel an in-flight dig, window transaction, `placeBlock`, equip, or HTTP request. Need cancellable tokens and revalidation before/after awaits. Current offline tests do not establish a universal single-owner invariant.

## 5. Scenario-by-scenario evaluation

Labels: **limited test** = a narrowly controlled, non-destructive or disposable test is informative, not that the scene is solved. **Not ready** = prerequisite capability/safety is absent. All likely outcomes are predictions, not observed live results.

1. **Open horde — limited test.** `threats.js`, `tactics.js`, `index.js:757` aggregate visible/watch mobs by type, pressure and rough fight cost, rather than 100 individual records. Escape continues locally; model chooses idle/hold/attack/move. Counts are only loaded/in-range; gear durability, effects and actual attack lanes are missing. Single-target combat is not horde kiting; likely escape is more viable than fighting. Exercise scaling in a disposable arena.
2. **Confined horde — limited test.** Escape flood shares pathfinder walkability and estimates arrival; cornered/chased signals tell model. It does not model full 3D room topology, changing gates or exact mob AI; a blocked route or enclosure can still trap it. No durable room graph. Test narrow maps and blocked exits under supervision.
3. **Creeper behind — limited test.** Local sense/flee can preempt follow without an LLM: new simulated session test checks survival lane while response is pending. Route ground checks exist; close fuse timing and damage are unproven. Combat has a creeper retreat, not guaranteed death verification and safe resumption in real latency.
4. **Ranged mix — limited test.** Type, range and LOS contribute to threat/watch; combat can use shield/ranged behavior. No reliable multi-direction projectile/cover model, potion-specific tactics, exposed-angle plan or comprehensive effects snapshot. Flee likely safer than chasing. Build controlled cover/shooter tests.
5. **Mace PvP — not ready for unrestricted PvP.** Motion tracker and `forecastImpact` identify a substantial downward fall toward the bot, with local evasive movement. No verified actual-version damage calculation, bait understanding, robust shield/corner policy or enforceable consent. Test only with consenting isolated accounts.
6. **Spear/elytra PvP — not ready for unrestricted PvP.** Motion estimates and closest approach trigger lateral evasion for selected attackers (`src/combat.js:198-365,1125`). Sparse/jittering packets and changed direction limit prediction; no continuous flight opponent policy. Test varied trajectories offline/isolated first.
7. **Melee PvP — not ready.** Weapon profile, cooldown, shield/strafe and critical-hit mechanics exist. No comprehensive axe-vs-shield/sprint-reset/knockback planning; some equipment writes bypass arbiter. Model chooses target, but policy authorization is absent. Isolated melee tests only.
8. **Critical injury — limited test.** Local food/healing selection and low-health flee/attack refusal exist; status appears in prompts. It does not plan full equipment replacement, safe-base logistics, or preserve every interrupted task; high-value golden apple choice is heuristic. Validate partial supplies and reassessment.
9. **Cherry house — not ready for semantic mapping.** `places.js` records stations, signs and coordinates; optional builder grids provide categories. Semantic scene detector exists but is not wired; no robust floors/rooms/connections/safe-home conclusion or house ownership model. Avoid assuming it will understand this structure.
10. **Organized storage — limited test.** Sign/frame proximity associates labels and `find`/`look_in`/`take` reopen and inspect actual contents; cached contents show age. Similar labels and moved signs can misassociate; no ownership rules or guaranteed knowledge of every chest. Test disposable labeled storage, including changes and ambiguity.
11. **Contained hostile mobs — limited test.** Reachability demotes some visible melee exhibits; recent attackers, explosive and ranged cases are treated more conservatively. Probe budget/unknown and barriers are imperfect; no explicit enclosure model or gate-state causality. Test with a controlled pen without risking valuable exhibits.
12. **Utility workflow — partial/not ready for full scene.** Craft and basic furnace/container steps exist with model-selected sequencing; station labels are indexed. Brewing, enchanting, grindstone and complete dependency planning are not tools. No automation proving final equipment. Test basic craft/smelt only in disposable storage.
13. **Multilevel navigation — limited test.** Mineflayer A* and door ledger can navigate coordinates/stairs/wooden doors; failures and jams are surfaced. No semantic floor/room graph or durable alternative-route reasoning; gates changed by players need rechecking. No promise of complete route recovery.
14. **Cave exploration — not ready as an autonomous expedition.** Position, named places and dimension-keyed indices persist, and model can ask to remember a location. No explored frontier map, breadcrumb graph, supply budget or robust lost recovery. Cave hazard/supply risk requires a supervised small test.
15. **Environmental hazards — limited test.** Local fallback checks walls/drop/lava, water swimming and fall clutch exist; pathfinder can avoid some threats. No comprehensive fire, drowning, powder snow, suffocation or void policy; equipment/terrain-dependent traversal is not reliably known. Test one hazard at a time in a disposable arena.
16. **Interrupted long task — limited test.** Same-session main/side agenda pause/resume with limited retries and control preemption. Gather progress is not durable and replay may over-collect; death/reconnect loses agenda. Model can stop/replace but cannot rely on checkpoints. Test bounded follow/build interruptions, not unattended resource quotas.
17. **Chat during task — limited test.** Chat and action calls are separate, reserved budget, movement continues, and prompts demand PT-BR. Heuristic filter is fallible; queued/lost/late replies and task supersession need stress testing. No universal PT-BR guarantee. The new privacy guard never publishes a failed whisper.
18. **Multiple speakers — limited test.** Address filter, per-sender chat history/preferences, and attribution exist; names and messages may be spoofed and intent conflicts are not resolved by a structured authority model. Name-matched memory can be false/old; group chatter could be misrouted. Test with consenting users and ambiguous wording.
19. **Long session/context pressure — not ready for durable autonomy.** Calls are fresh snapshots, not an ever-growing conversation; bounded working/recent records and top-k recall reduce context growth. No true structured compaction or persistent task source of truth, no semantic memory coverage, and 500-record eviction/silent I/O can lose knowledge. Repeated reopen test checks stored facts, not compaction quality over hours.
20. **Lag/death/recovery — limited test.** Death stops controls/clears main and remembers a death place; reconnection reconstructs session; stale model responses are now discarded for several key changes. Items/inventory may have changed, incomplete entity updates are not confirmed deaths, and actions in progress may still cross awaits. Fault-inject teleport, packets, inventory and delayed model separately.
21. **Animal farm — not ready.** Perception can group animals and protect named/tamed entities; `attack` can still kill an ordinary farm animal. No breeding readiness, species food interaction, shearing/milking or ownership/enclosure capacity tools. Do not test against valuable animals.
22. **Large player group — limited, no unrestricted PvP.** Player observations list closest eight, not robust totals/relations; name-based remembered facts may surface for up to three, uncertain. Unknown people are not automatically threat-classified just for proximity; exact-name attack still has no consent gate. No ally/team/group role model.
23. **Creator/friends — not ready for verified recognition.** New optional identity config is injected in both ZincAI prompts; no creator is configured by default. Stored player statements/preferences can reappear after restart, name-based and uncertain. There is no UUID profile matching or verified operator authority; names do not prove identity.
24. **Unknown/spoofing attacker — not ready for shared-world PvP.** Unknown approach remains neutral locally; direct damage may trigger flight without identity. Offline mode and chat parsing cannot prove claimed identity, and probable swings are not confirmed attacks. Prompt-only PvP safeguards do not prevent an erroneous named attack.
25. **Shared property — not ready.** Default pathfinder digging is off but `gather` directly digs allowlisted types, and model-driven storage/build/use actions lack general ownership checks. Trust filter is default-off and partial. Never let it operate on real shared property before authorization boundaries exist.
26. **3D redstone inspection — not ready.** Absolute positions and a builder-mode cross-section show block categories, not component facing/properties or directed connections. `perception.js` has voxel helpers but no model-facing bounded block-state inspector/trace. No valid inference of a real circuit can be promised.
27. **Redstone computer — not ready.** No circuit graph, simulation, timing model, signal tracer or controlled test hypotheses. Shape and blueprint placement are geometry, not a verified logical designer. Incrementally add bounded state inspection and offline graph analysis before considering autonomous mutation.
28. **Crop maintenance — not ready.** Gather can dig allowlisted blocks but lacks maturity/replant verification, field ownership, yield quota or durable progress. It can count blocks rather than collected crops. Avoid real farms; add crop-specific safe operations and stage checks.
29. **Villagers/trading — not ready.** Generic mob summary and station index do not expose professions, offers, transaction costs or trade execution. Player-managed infrastructure has no ownership guard. No meaningful full-scene test until interfaces exist.
30. **Large building — limited disposable test.** Shape/blueprint phases, palette and name-based idempotence exist; model chooses design and phase. Preflight and recorded result help, but block state/orientation, world conflict permissions, durable per-cell plan, and verified dimensions are missing. Existing occupied/different blocks and terrain require supervision.
31. **Inventory/logistics — limited test.** Inventory names/counts and automatic tools are visible; take/put locate storage and refresh contents. Not all item kinds appear after cap; no durability/enchantment/rarity prioritization, capacity plan or safe-discard system. Long collection can stall or produce partial results.
32. **Nether/End — not ready.** Observations and indexed places include dimension, preventing some coordinate conflation. Portal pairing, destination planning, void/Nether survival and verified return routes are absent; a recorded coordinate is not a route. Test dimension transition only after a safe reset plan exists.
33. **Elytra flight — not ready.** Deployment/firework and fall behavior exist (the smaller harness also has `src/elytra.js`), but not comprehensive aerial path planning, obstacle anticipation or landing verification. Avoid valuable equipment and voids in initial tests.
34. **Loadout/potions — not ready.** Basic inventory/equip/craft/smelt and heuristic weapon selection are available. There is no potion brewing/enchanting planner, resource-budget optimizer or objective-specific loadout/workflow. Model must not be told these capabilities already exist.
35. **Unexpected ambush — limited isolated test.** Damage may initiate local flight before model response; attribution can be unknown/probable, and recent attackers are sensed. No guaranteed cover, projectile source identification or safe escalation; no hard PvP permission. Test attacker attribution and retreat, not unrestricted retaliation.
36. **Multi-opponent PvP — not ready.** Threat aggregation notices attackers and combat tracks target/recent hitters, but no allies, roles, reliable target valuation or coordinated multi-threat control. Model has meaningful target choice but incomplete observations. Only constrained isolated fixtures.
37. **Unusual PvP tactics — not ready.** Some TNT/projectile/ground threats are recognized, but no complete potion vs pearl trajectory/effect model, trap interpretation, terrain manipulation or shield/potion reasoning. Test passive detection in disposable fixtures; do not infer robust tactical understanding.
38. **Cooperation — limited chat/navigation test.** Player attribution, recent dialogue and task text offer basic delegation; short jobs may pause/resume main work. No shared multi-player task state, authoritative completion evidence or conflict arbitration; it may duplicate work. Test explicit assignments with observers.
39. **Operating a redstone machine — not ready.** Generic `use_block` can click nearest named control, but lacks purpose/connection identification, state verification and owner permission. It could click the wrong lever or disturb a machine. Do not expose valuable infrastructure.

## 6. Identity and social reasoning

The two ZincAI static prompts establish its name, AI status, friendly SMP role and PT-BR policy. This pass adds a shared compact identity line to **every fresh action and chat request**, and optional `identity.creator.name` / `identity.creator.uuid` in `zincai/config.json`. Both default empty because the creator's Minecraft identity is not present in the repository. This is operator configuration, not a verification system. Supply a real name and canonical UUID only through trusted operator configuration; independently configure an authenticated online-mode server/proxy before associating the live player with that record. `server.auth` is the bot's login method, not proof the server authenticates all players.

No friends whitelist determines hostility: `ThreatSense` ignores players until attributed damage; friendships are name-based conversation/facts/preferences. The new action snapshot surfaces up to two facts each for three visible names, marked name-based/unverified; chat already retrieves facts about the sender. This does not make them authoritative relationships: `factsAbout` searches text substrings and tags, may confuse speaker and subject and returns no UUIDs; ordinary player claims and inferred preferences can be false. The creator does not automatically receive hard-coded privileges from this new identity configuration. `trust.owners` is a separate, opt-in, name-based filter, now actually loaded; it must not be mistaken for authenticated authorization.

A direct attack can trigger fleeing without the attacker's identity. However, the model may call `attack.player` for an exact visible name with no runtime consent check; the prompt's warning/duel rule is insufficient. Swings close to Zinc on older/limited servers can be probable causes only; do not treat that as confirmed evidence to authorize violence. Friendly group membership and team consent are not encoded. Proposed next step: track observed server UUID, its authentication assurance, current per-player interactions and confirmed damage separately; explicit expiring duel consent must be scoped to that identity, target, session and revocation. Default to flee/neutral, not a whitelist of enemies.

## 7. Memory and contexts

* `MemorySystem`: 5-entry working memory, 10-minute short-term events, 30-second ephemeral ring, up to 500 long-term JSON entries with timestamps/importance; per-player preferences persist separately. Conversation history persists at most ten lines per player, fresh for seven days on load (`index.js:142-205`, `memory.js`). PlaceIndex persists dimension-keyed blocks, labels, last-seen contents and named locations. Saves use temporary files and rename, but write/read exceptions are swallowed: missing/corrupt files can silently reset state.
* Each call uses static role text plus a current snapshot, not a continuously growing transcript; no actual LLM context-compactor or iterative rolling summary exists. Snapshot reconstruction avoids repeated-summary degradation **only for data actually preserved outside it**. Agenda, progress, causal reasoning and some recent context disappear at restart/death; active context can be stale within a call. Reopening JSON four times in a new test demonstrates raw facts survive ordinary reload, not creator authentication, all critical state, or repeated compaction.
* `recallBlock` uses accent-folding, simple token overlap/cosine and literal grep. Chat query drives recall; fresh recent chat or an action request drives action recall. This pass adds a small category/index cue to both lanes and name-based visible-player retrieval. It is a static description of existing stores, **not a dynamically derived inventory of stored projects or semantic search**, and automatic lookup is not yet triggered reliably on entering a known house, machine, or task. `find` is the concrete tool for places/items/labels; there is no general explicit memory-query tool.
* Newly written chat statements and model summaries carry source-kind/source, and recall shows source/date/verify warnings. Legacy facts explicitly show unknown source. This is provenance, **not calibrated confidence** or proof the summary faithfully reflects the original chat. Preferences and player fact presentation are less complete, exact repeats can retain the old timestamp, and current observations should supersede caches only with explicit conflict handling. Raw player messages should not be treated as instructions.
* Cost measurements from current serialized strings, using a rough 3.7 characters/token (not a tokenizer, excluding JSON request framing and dynamic snapshots): action system prompt 4,007 characters ≈1,083 tokens; chat prompt 1,922 ≈519; tool schemas explorer 8,432 ≈2,279, hunter 7,544 ≈2,039, builder 9,649 ≈2,608; chat tool schema 819 ≈221. Added identity/index line is roughly 400–500 characters depending on configuration. Actual billing varies with tokenizer, snapshots, retries and provider caching; usage metrics record provider-reported counts when available. No live usage measured here. As snapshots repeat stable state, optimize only after measuring, without hiding changes or evidence.
* Isolation is partial: separate chat/action histories and model calls share memory and world state, but no independent tactical/technical contexts or shared durable task graph. Narrow contexts plus a common versioned state store would reduce rot without partitioning knowledge; never let a model-generated summary overwrite source evidence.

## 8. Tool calls and autonomy

Native tool schemas carry names, descriptions, required fields, enums and some defaults, and executor resolves player/place/container identifiers. `tactics.js` provides concrete flee/hold/fight choices in prompts, with threat IDs captured for acknowledgement. This is more structured than an untyped natural-language-only interface. It is not partially populated function calling, a runtime autocomplete service, or a general capability discovery tool; `createZincTools` sends a per-mode subset and a mode change is necessary to expose other tools. New schema checks cover top-level fields/types/enums and offered tools, not every nested constraint, number bound or valid real-world target. Retry is bounded; logical failures are still possible and `FailGate` only suppresses repeated identical failures.

Model judgment survives: it can hold, flee by default, choose attack/go_to/follow, stop or schedule chores; local body owns fast movement, hazard reflex and cooldowns. `hold` and automatic resume can nevertheless accept stale danger or restart work without strategic reassessment. `stop` cancels running/paused work; a survival lane preempts a task's movement. That does not cancel every in-flight world mutation or hand operation, and `useHand` does not govern all direct equipment operations. A successful tool dispatch is not always successful objective completion, particularly partial gather and asynchronous smelting.

## 9. Implemented modifications and verification

| Files | Actual change and purpose | Evidence |
|---|---|---|
| `zincai/index.js`, `zincai/config.json` | Preserve trust/concurrency/timeouts on the real loader; optional creator name/UUID and bounded core identity/index in both prompts; bounded visible-name facts with explicit uncertainty. No creator invented, no UUID authentication claimed. | `final-audit.test.js`: real loader matches config; both prompts contain configured identity; player fact injected. |
| `zincai/memory.js` | Store optional source-kind/source on new event/chat/summary records; keep same text from different sources distinct; expose source/date/verification reminder in recall, label older records unknown. | Reopen/search four times, check separate sources; existing 223-test suite. No compaction or identity verification test is claimed. |
| `zincai/index.js` | Reject in-flight action after urgent change/new request/death, avoid action while dead, suppress late chat/action after session end; point metrics at the session's configured data directory. | Mock delayed action after death, urgent creeper, and delayed chat after dispose; prior mock sessions pass. New-chat and other invalidation paths are not exhaustively tested. |
| `zincai/api_wrapper.js` | Validate native arguments/basic schema and JSON fallback; reject extra action fields and unoffered tools; tool name cannot be overridden; correct unsafe gather description. | New malformed/override/type/enum tests and existing tool/fallback tests. Nested validation and world authorization remain open. |
| `src/combat.js`, `zincai/index.js` | ZincAI opts into explicit-player-only targeting for both initial attacks and kill chains, avoiding collisions with mob names without breaking the smaller harness's legacy interface. | Mock resolver and executor tests; no PvP authorization or live test is implied. |
| `zincai/control.js` | Refuse **all** concurrent `useHand` borrowers rather than let a high-priority borrower overlap an existing one; caller may retry. | Deferred-operation test verifies no overlap and proper restore, then successful retry. Does not serialize direct `bot.equip`; emergency wait is a tradeoff. |
| `zincai/index.js` | Drop undeliverable private message instead of public fallback; distinguish newly placed from already-present in build result. | Missing-recipient simulated test; existing idempotent builder tests. |
| `test/final-audit.test.js`, `package.json` | Add eleven offline regressions, including close creeper preempting an active follow with model response still pending; add them to standard test command. | 223/223 final suite, no live Minecraft. |

No database migration, task journal, PvP consent enforcement, property permission system, generalized 3D/redstone interface, or live server test was implemented. Those are not hidden behind the above incremental changes.

## 10. Dedicated test-server checklist (later, not run here)

**Before connecting:** disposable isolated world; backup/rollback; no real player property, animals, valuables, machines or production credentials; operator present and able to disconnect; disable risky tools/PvP externally or constrain with server protections. Do not rely on the optional name trust gate. Choose a supported explicit Minecraft version; verify registry compatibility, endpoint/tool-call canary, bot auth, and server authentication policy. Record model, config, RTT, version, seed and logs. Protect metrics/conversation data because they contain player text.

1. **P0 connection / single player / artificial latency:** login, snapshots, chat, death/respawn, disconnect/reconnect, teleport, hung/late model reply, stop and replacement while movement/interaction is pending. Check no old command or chat leaks into a new life. Repeat with delayed packets and chunk loads.
2. **P0 safe interaction / multiple players:** unknown approach, similar names/claims, direct vs unaddressed chat, whisper recipient disconnect, identity assurance and consent. Do not enable actual attacks until PvP authorization exists. Confirm neutral behavior and source uncertainty.
3. **P0 property / prepared disposable structures:** place wood logs/stone as a house near natural resources; verify region/permission boundary once implemented before enabling gather, gates, build, storage, or machine controls. Test protection server-side as well as in harness.
4. **P1 creeper / controlled mobs:** existing follow then rear creeper at several starting distances; measure detection-to-preemption, distance at detonation, blocked-route handling, and task recovery. Repeat under induced latency; disposable gear only. Controlled mixed horde 5 → 30 → 50 → 100 with observable route/CPU/call rate and bounded prompts; no claim of victory.
5. **P1 navigation/contained mobs / prepared structure:** walled exhibit, fence pen, ranged behind bars, doors/gates, stairs, dead end and changed obstacle; verify claims against actual reachability and ensure nothing opens a valuable pen.
6. **P1 storage / prepared signed chests:** duplicate signs, chest relocation/content changes by second player, actual withdrawal counts, stale index, furnace output and partial stock. Check ownership and return/rollback before running.
7. **P1 chat/task / multiple players:** concurrent dialogue during movement, chat budget, new/contradictory tasks, long-running follow, tool break/full inventory, model delay. Inspect command progress vs completed objective and PT-BR output manually.
8. **P1 continuity / multiple context resets and long-running sessions:** seeded creator and player records, repeated fresh prompts, process restarts, death/reconnect, source conflicts and storage changes; verify no identity invention, stale ownership or silently lost tasks. Current architecture is expected to fail durable task continuity.
9. **P2 combat / consenting multiple players and specific equipment:** sword/axe/shield/mace, spear/elytra trajectories, projectiles and cover; instrument velocities, attack timings, priority transitions and consent for each target. Only after hard authorization is in place.
10. **P2/P3 prepared redstone/complex builds:** start read-only with bounded state inspection once implemented; only a disposable machine with owner-approved mutations. Multi-floor build and block-state orientation require manual block-by-block verification, never a production mechanism.
11. **P2/P3 special environments/equipment:** caves, hazards, portal transitions, Elytra, farming, trading, potion stations only after their missing interfaces/safeguards are designed; separate each failure mode and ensure a safe recovery.

## 11. Roadmap and acceptance status

### P0 — must fix or strictly mitigate before tests involving other people/property

* Implement enforceable per-target PvP authorization/confirmed-attacker distinction, revocation and no attack on unverified claims. Provide a global server/operator disable; test legacy swing ambiguity and delayed decisions. Until then, no unrestricted PvP.
* Implement explicit ownership/region/action authorization and a protected test sandbox for gather/build/containers/gates/scripts. Type allowlists are not ownership. Until then, disable mutation or use only disposable protected fixtures.
* Establish authenticated server identity and operator configuration, rotate any previously exposed credentials. Validate real endpoint/protocol with isolated operator-run canary, never confuse dummy dry-run with integration success.

### P1 — strongly recommended before representative autonomy testing

* Persist versioned objective/progress/checkpoints, pending requests and necessary causal facts, revalidate after reconnect/death; distinguish partial block digs, collected items, and objective completion.
* Centralize all hands/world operations with cancellation, rollback or post-await revalidation; stale state epochs for teleport, dimension, inventory and task replacement; ensure urgent items can interrupt safely rather than wait forever.
* Stable UUID-linked player records with authenticated/unverified assurance, explicit provenance/conflict/freshness, data loss alarms and safe bounded retrieval triggered by observed people/places/tasks. Make the index reflect actual retrievable categories.
* Schema validation including nested structures, bounds and contextual targets; expose discoverable targeted inspections and errors. Verify PT-BR with a stronger approach while preserving names and short Portuguese phrases; do not promise absolute language correctness from heuristics.

### P2 — evaluate during controlled testing

* Measure planner, 100-mob performance, escape failure and lag; improve cover/projectile geometry, equipment durability/status, multi-threat targeting, hazard coverage and terminal-state detection based on evidence.
* Improve building block state/orientation checks, local path recovery, storage label disambiguation and freshness; compact per-mode tool catalog/autocomplete and real provider token accounting.

### P3 — longer-term development

* Persistent 3D site/room/frontier graph, dimension/portal routing, flight and landing controller, redstone block-state inspector/graph and bounded simulation, task-specific circuit debugging; incremental and read-only first.
* Trading, breeding/shearing, mature crop/replant workflows, brewing/enchanting/loadouts and cooperative shared-task state. These require game-version mechanics, permission boundaries and controlled verification, not a hardcoded library masquerading as reasoning.

### Acceptance criteria — honest disposition

| Requirement | Status |
|---|---|
| Compact core identity every ZincAI window | **Partial**: static role + new configurable line; creator is unconfigured/unverified, no durable relationship summary. Smaller `src/` harness not changed. |
| Creator and frequent people survive resets | **Partial**: configured text and name-based memories persist on normal reload; no authenticated UUID linkage or guaranteed retention. |
| Unknown players neutral / defend unknown attacker | **Partial**: neutral sensing and local flee; exact-name attacks have no hard authorization and damage attribution can be uncertain. |
| Relevant concise observations and automatic recall/index | **Partial**: aggregation, bounded name/chat recall and static category cue; missing many triggers, semantic retrieval, real available-record index and tactical detail. |
| Attribution/freshness/confidence | **Partial**: source/date labels on new recall; no calibrated confidence, conflict resolution, uniform fact display or strong identity provenance. |
| Compaction preserves task/world through repeated resets | **Not met**: fresh snapshots avoid transcript growth, but no real compactor or durable task state. Reopen test is not a compaction test. |
| Prepared structures, schemas, discovery and autonomy | **Partial**: tool schemas/defaults and tactical suggestions; no runtime autocomplete/general inspection, shallow validation; model chooses actions but safety gate incomplete. |
| Local reflex, interruption and cancellation | **Partial**: simulated creeper preemption and control lanes; world mutations/hands are not universally cancellable or serialized, response validity coverage incomplete. |
| Successful action vs objective completion | **Partial**: results report many failures; gather counts dug, not picked-up, and partial success remains possible. Build report now distinguishes existing from new. |
| PT-BR chat concurrent with work | **Partial**: separate lanes and heuristic guard; never a linguistic guarantee, shared budget and delayed-message cases remain. |
| Durable task resume, rich 3D and redstone | **Not met**: session-only agenda, category slices rather than state-aware 3D circuit/route graph. |
| Earlier fixes verified / all offline work complete | **Partial**: the checklist above identifies traced/tested items and explicitly unverified ones; the full suite passed, not every historical issue was independently reproduced. |
| No live test misrepresented | **Met**: no Minecraft server or endpoint was started/contacted in this pass. |
