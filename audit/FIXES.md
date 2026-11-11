# What was fixed after the audit

`REPORT.md` describes the harness as it was. This file lists what changed afterwards, by the defect ids of section 8 of the report, how each change was checked, and what is still open.

Everything here was checked in the repository's own rig: a synthetic block world with the real mineflayer-pathfinder A*, a simulated bot, and a scripted model. The rig has no jump physics and no mob AI, uses 1.21.4 block data, and treats mobs as points. At the end the loopback rig of `test/e2e` was run as well: the real harness processes against a local flying-squid 1.16.5 server and a scripted model. **Nothing was run against the production server, any 26.3 server, or the AMD endpoint.**

- Tests: `npm test` runs 196 tests (150 before). `test/fixes.test.js` (32) and `test/fixes.session.test.js` (12) are new and named by defect id. Two tests were added to older files, and 13 older tests were updated because they asserted the old behaviour (listed at the end).
- Scripts: `node audit/repro/<name>` from the repository root. Scripts 03, 06, 07, 09 and 11 were rewritten or extended to show before and after.
- Loopback: `cd test/e2e && npm install && node loopback.js` passes 43 of 43 checks for both harnesses. Its first run failed two checks and found a defect the rig had missed (the "cornered on open ground" row below). Its mobs stand still and never attack.

## The design asked for: the body flees by itself, the model still decides, and the bot knows it fled

| Part | Where | What it does |
| --- | --- | --- |
| One honest picture | `zincai/threats.js`, `zincai/tactics.js` | Every hostile is counted once: `threats` (close enough to start an escape), `watch` (in the open, up to 32 blocks), `hidden` (no line, no route). The prompt shows one count, the pressure, the open sides, and what a fight would cost with the gear carried (GOOD / RISKY / BAD). |
| One escape, one episode | `zincai/system1.js` | Starts inside the trigger ring (12 melee, 18 ranged). Lasts while anything follows inside 22 blocks or keeps closing. Ends after 4 s with nothing following, or when the model decides. |
| A route, not a direction | `zincai/custom_mineflayer/escape.js` | Floods walkable ground and compares the bot's arrival time with the mobs'. Results: `open`, `pocket` (cornered), `chased`, `surrounded`, `trapped`. With nothing safe it breaks out by the route that touches the fewest mobs. The straight-sprint fallback checks for walls, drops and lava first. |
| The bot knows | `system1.reflexLine()`, both prompts | Wake-ups: `started FLEEING` (may jump the 3 s spacing), `still FLEEING` on material changes and every 30 s, `safe again` with duration, distance and cost. The same facts are a line in every action prompt and every chat prompt, during the escape and for 3 minutes after. |
| The model decides | `zincai/index.js` | `idle` keeps fleeing, `attack` fights, `go_to` / `follow` goes elsewhere, `hold` stops running without cancelling the task. A decision covers what was shown and what the body was running from. A task's decision lasts as long as the task and comes back with it after a pause; `hold` is about the mobs and lasts 30 min whatever the bot does next. Both end early only for a reason (a hit, a lit fuse, low health, something new). When the body runs again the model is told why, including "your hold decision ran out". |

The owner policy is unchanged: no reflex attacks, no fight unless the model calls `attack`, a player only by exact name, no friend list, vanilla client only.

## The four first-hour problems

| # | Problem | Ids | Before | After | Checked by |
| --- | --- | --- | --- | --- | --- |
| 1 | Doors and gates | M1, M2 | Every door and every gate newer than dark oak: `noPath`. The wrapper closed doors and trapdoors it never opened. | All wooden doors and gates pass, open or closed. The bot closes only what it opened. Trapdoors and iron doors are never clicked. A door that will not open is given up after 3 clicks and named in the `go_to` result. | 11 tests `M1` / `M2`; scripts 01, 02 |
| 2 | Pets on 26.3 | T1 | Tame flag read at index 17; on 26.3 it is at 18, so every pet read as wild. | Metadata is read by key name from the server's game data. An unreadable tame state counts as protected. Startup logs any key the data lacks. | 2 tests `T1`; script 07 |
| 3 | Chase: a call every 3 s, wrong picture, chat silenced | T2, T3, B4 | 13 action calls in 40 s. `threats: 1` beside `zombie x18 (cannot reach you)`. Chat unanswered once the 18-call budget was spent. | 2 calls in 40 s (3 in 70 s). `threats: 27 in sight — zombie x24, skeleton x3`. Six lines from a friend during a 60 s chase all answered in 1.5–1.8 s (model latency 1.5 s). With the action lane slowed to 15 s per call, four lines in 40 s were answered in 1.5–1.8 s. | tests `T2`, `T3`, `T2 + T3`, `B4`; scripts 04, 11 |
| 4 | Storage room | S1, S2, S3, S4, S5 | 42 of 48 chests indexed, no stations, prompt was nine sign texts and "+77 more". `take diamond` took iron from a furnace. | 48 of 48 chests, all labels, all stations; a 753-character summary in which every label is an address. `find` knows labels and lists storage in pages. `take` never guesses and "diamond" is never the diamond pickaxe. | tests `S1` (2), `S3`, `S2 + S4`; scripts 06, 07 |

## The per-scene items

| Scene | Item | Ids | Change | Checked by |
| --- | --- | --- | --- | --- |
| Horde | Wake policy, one threat line, route check | T2, T3 | See above. | above; script 03 |
| Horde | `attack` when too hurt | not in the report; found re-running script 05 | An `attack` at or below the break-off health (6 of 20) used to engage, call the escape off, break off on the next tick and lock fighting out for 10 s, once per model call. It is now refused with the reason ("too hurt to fight … get away and eat first") and the escape carries on. | test `T3: an attack…`; script 05 |
| Horde | Eating | T4 | Hurt and below 18 hunger: eat the best food even if it overshoots. | test `T4`; script 07 |
| Horde | `hold` expiring silently | T5 | `hold` lasts 30 min, cancels nothing, and is not wiped when some other task ends (it was: the bot bolted from mobs it had been told to ignore as soon as it finished handing over an item). A paused task gets its decision back when it resumes. Any new escape is announced with its reason. | tests `T5` (2), `T5 + B3`; script 09 |
| House | Animals | C1 | `attack cow` kills one cow; `count` for more. Hostile mobs are still chained. | test `C1`; script 07 |
| PvP | Cornered on open ground | not in the report; found by the loopback run | Fleeing from a player on a flat world, the model was told "CORNERED — the only safe ground is a dead end" and woken for it. A player is as fast as the bot, so only a few cells beside it were safe and the planner took that for a pocket. Now only walls make a pocket: if the edge of the search can be reached without coming closer to a pursuer than the bot is, the plan is `chased`. | test "escape: a player who keeps up…"; loopback check "never tells the model it is cornered on flat, open ground" |
| PvP | Evasion by time-to-impact | scene 3, options A and B | A mace smash is recognised by a real fall on course to land in reach (a hop or a staircase is ignored, with or without packet jitter). A charge is recognised by closing speed and line (a level glide counts; a spear in use on foot counts). Other players who hit the bot recently are watched too. Copper sword and axe are auto-equipped. The shield is lowered when the flee reflex takes over. | 4 tests ("mace: a hop is ignored…", "forecastImpact…", "PvP: packet jitter…", "PvP: during a duel…"); script 07 |
| Creeper | Retreat that checks walls and drops | scene 4 | Hit-and-run is refused where there is no ground to back off on. Every retreat picks a heading with ground. Reaction time is unchanged: 99–253 ms measured on the old code, 50–280 ms on the new, both set by the 200 ms reflex tick. | test "creeper: no hit-and-run…"; script 08 |
| Chat | Language | B2 | Both prompts say always PT-BR. Every outgoing line is checked by function words; a foreign chat reply is retried once, then replaced; a foreign `say` is held back and re-asked once. | tests `B2` (2) |
| Chat | Memory | B5 | The chat tool has a `remember` field; facts are stored per player and shown as `you know from <player>:`. The fallback filter's dead stems are fixed. Conversations are saved to disk. Reflex events, results and chat no longer occupy the five-line event window. | tests `B5` (2); script 07 |
| Chat | Task resume | B3 | A short job pauses the long task, which resumes by itself. An `agenda:` line shows what is paused, set aside, or asked and not started. | tests `B3` (2) |
| Chat | Nicknames | B10 (part) | "zincão", "zinquinho", and "Zinco," as a call are recognised. "zinco é um metal" is not. | existing filter test; script 07 |

## Escape planner: old and new on five maps

Script 03 plays each map for 12 s. Zombies walk at the bot at 2.3 blocks per second and stop at walls; the bot runs its plan at 5.4 and replans every 700 ms. This compares the two planners' routes only: there is no collision between bodies and a "hit" is a zombie within 1.2 blocks once a second. Four of the five maps gave the same numbers in every run recorded in full (ten for the old planner, three for the final code). The cliff map was run 18 times: the old planner's result there depends on A* timing. It let the zombies within 0.8–1.0 blocks 15 times (0–3 hits), within 0.5 blocks once (10 hits), and got clean away twice (9.0 blocks, no hits). The new planner gave 8.0 blocks and no hits in all 18.

| Map | Old: nearest, hits | New: nearest, hits | New tells the model |
| --- | --- | --- | --- |
| Dead-end corridor, no way out | 0.3 blocks, 29 | 0.3 blocks, 1 | CORNERED first, then breaks out |
| Room with one doorway, zombies coming in | 0.6 blocks, 10 | 1.1 blocks, 0 | CORNERED first, then breaks out |
| Cliff behind the bot | 0.8–1.0 blocks, 0–3 in 15 of 18 runs; 0.5 blocks, 10 in 1; 9.0 blocks, 0 in 2 | 8.0 blocks, 0 | nothing (ordinary escape) |
| Ring of 13 zombies with one gap | 0.7 blocks, 15 | 3.5 blocks, 0 | nothing |
| Room with a second doorway | 1.2 blocks, 19 | 6.4 blocks, 0 | nothing |

## Not fixed

These were in the report but not in the list that was agreed to fix first.

- **Fighting a horde.** `attack zombie` against 12 zombies still loses (script 05: 0 kills; the fight is broken off below 6 of 20 health and the run ends at 5, against 2 before the fixes). What changed is that the prompt says so before the model chooses, and that a second `attack` at that health is refused with the reason.
- **Mobs with a line of sight that cannot reach the bot** (a pen with a low fence, an unnamed exhibit) still start an escape. `hold` now sticks, but each new mob asks again. The report's option G (containment instead of line of sight) is not implemented.
- **PvP beyond evasion.** No sprint-reset, no spacing by the opponent's reach, no axe against a shield, no totem or potions. Mace, trident and spear are still not auto-equipped.
- **Stations and animals.** No skills for brewing, enchanting, anvil, grindstone, breeding or shearing (S9). Furnace types and fuel choice are as before (S6). Crafting-table reach (S7).
- **Site model and survey** (scene 2, options C and D), the JSON query tool (E), and the safe-area thinking mode.
- **Model call details.** No reasoning control and `finish_reason` is still not read (B1). 23 tool schemas on every action call (B9). The fixes made each call larger: about 3,600 input tokens now (about 3,100 before), of which the static prefix is about 3,400 (2,900 before). These are estimates at 3.7 characters per token, not tokenizer counts.
- **Building.** Phase pre-flight still wants materials for every phase; the inline grid still lacks a palette (B7).
- **Harness A** (`src/`) received only what it shares with ZincAI: the new reflex, the escape planner, the honest count, the reflex line and the combat changes. Its own limits from Appendix B stand.

## Not verified

- No run against the production server or any 26.3 server. The loopback run is on 1.16.5 with mobs that do not move, so it shows login, chat with accents, pathfinding, the flee from a player's hit, an explicit fight and the flee from a zombie over the real protocol, and nothing about doors, storage, pets, a horde or PvP evasion. Still unverified: door clicks under real latency, real mob pathing around the bot, sprint-jump physics, shield timing, sign and item-frame data on 26.3.
- No run against the AMD endpoint: two calls in flight at once, `tool_choice`, the model's use of the new `remember` and `count` fields, how a small model reads the threat block.
- The 26.3 metadata layout comes from the vendored data file, not from a 26.3 server.
- The fight estimate is arithmetic on vanilla numbers. It ignores enchantments, effects, terrain and skill.
- The language check tells Portuguese from English only.

## Older tests that changed, and why

Added to older files: `elite.test.js` "forecastImpact…" and `rework.test.js` "brain: chat keeps a reserved share…".

| Test | Change |
| --- | --- |
| `elite.test.js` "mace panic…" | Asserted that a hop sets off the retreat. Now: a hop is ignored, a real dive is dodged. |
| `elite.test.js` "reflexes never fight…" | Waited 850 ms for "safe"; the calm period is now 4 s (the test sets 600 ms) and asserts the new texts. |
| `elite.test.js` "prompts…" | Asserted "language of the message"; now asserts always PT-BR and the reflex wording. |
| `rework.test.js` "respawn…", `session.test.js` "dying once…" | Asserted upstream `canOpenDoors`; doors are now handled by `doors.js`. |
| `rework.test.js` "combat targeting…" | A piglin is hostile unless the bot wears gold; the test uses a zombified piglin for the neutral case and adds the gold case. |
| `rework.test.js` "brain: wake-ups…", "brain: a failed call…" | Asserted one call in flight for both lanes; chat now runs beside the action call, and the action lane leaves chat a reserve. |
| `session.test.js` "a zombie appears…", "a player hits the bot…" | Prompt formats: one threat block, the reflex line, the attacker's gear. |
| `zinc.session.test.js` (2) | Harness A's threat line and event text. |
| `test/e2e/loopback.js` "tells the model it is fleeing…" | Matched the old threat line (`fleeing from 1 — zombie`); now matches each harness's new wording. One check per harness was added ("never tells the model it is cornered on flat, open ground"), so the rig has 43 checks instead of 41. |
| `harness.test.js` "combat engage cooldown…" | Asserted "cooldown" as the reason at 4 health; the reason there is now "too hurt", and the cooldown is asserted after healing. |
