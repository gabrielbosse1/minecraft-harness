# Zinc harness audit: what breaks before the first real test

> **Status.** This report describes commit `53c59e4`, before any fix. Line numbers and measurements refer to that commit. What was fixed afterwards, how it was checked and what is still open is in [`FIXES.md`](FIXES.md). The scripts in `repro/` now run against the fixed code; several were extended to show both.

Commit `53c59e4` (main), 11 Nov 2026. Scope: every source file in `src/`, `zincai/` and `scripts/`, the test rig's world and session helpers, and the parts of `mineflayer`, `mineflayer-pathfinder` and `mineflayer-armor-manager` the harness depends on. Not reviewed line by line: the bodies of the 150 tests (titles only), `test/helpers/mockbot.js`, the e2e server and the blueprint JSON files.

## 1. Verdict

The reflex body is the strong part of this project. A creeper behind the bot is handled in 100–250 ms with no model call, and on open ground a 27-mob horde never touched the bot. The problems are elsewhere, and four of them would show up in the first hour on a server with friends:

1. **Zinc cannot walk through a door.** Open or closed, any wood. It cannot pass a cherry fence gate either. Oak-family gates it opens and leaves open. Separately, it closes every open door and trapdoor it walks past, including ones it never touched.
2. **On Minecraft 26.3 it no longer recognises pets.** The tame flag moved from metadata index 17 to 18; the code still reads 17. `attack wolf` is no longer refused for a friend's dog.
3. **Any mob chase calls the model every 3 seconds** with a picture that is wrong: a horde of 27 was shown as "1 threat" plus "18 zombies that cannot reach you". After about 40 seconds the shared budget of 18 calls a minute is spent and a friend talking to Zinc gets no answer for 20 seconds or more.
4. **A storage room collapses in the prompt.** With 48 labelled double chests the model received one line containing nine sign texts and zero chest ids.

Chat works and does not block the body, but Portuguese is not enforced, memory is a keyword filter, and a chat request that needs an action silently cancels whatever Zinc was doing.

| Scene | Today | Fix first |
| --- | --- | --- |
| 1. Horde | Flees well in the open; runs through the mobs in a dead end; spams the model; no kiting | Wake policy, threat line, route check |
| 2. Cherry house | Cannot enter rooms behind doors; chests work in small rooms only; no brewing, enchanting, grindstone or animal skills | Doors and gates, storage summary, pets |
| 3. PvP | A basic duelist with no model in the loop; evasion triggers are late and misfire | Evasion by time-to-impact, eating rule |
| 4. Creeper | Works: instant flee, hit-and-run when asked | Retreat that looks where it runs |
| 5. Chat | Answers while working; not always PT-BR; forgets most of what it is told | Language guard, memory tool, task resume |

**Which harness.** This report targets ZincAI (`zincai/`). Harness A (`src/`, "Zinc") shows the model no inventory, players or blocks and has no container, eat or follow actions, so scenes 2 and 5 are out of its reach by design. Its specific defects are in Appendix B. Both share the body, so body fixes help both.

**How this was checked.** The 150 existing tests pass. Eleven scripts in `audit/repro/` drive the shipped code through the repository's own test rig; every finding marked *ran* can be reproduced with them (Appendix A). Findings marked *read* come from the code and were not executed. Nothing here touched a real server or the real AMD endpoint: the rig uses a flat synthetic world, 1.21.4 block data, straight-line walking and a scripted model. Model latency, reasoning behaviour and 26.3 wire behaviour are unknown until probed (section 12).

---

## 2. Scene 1: a huge horde

### What happens today

Threat sensing counts a hostile only inside 12 blocks with line of sight (18 for ranged mobs), or inside 8 blocks when a path exists. The reflex tick is 200 ms. Fleeing never waits for the model.

In a 40-second chase by 24 zombies and 3 skeletons on flat ground, with the model always answering `idle`, no mob came closer than 5.3 blocks (*ran*, script 04). That is the good news. The same run shows three problems.

**The model is called every 3 seconds.** The bot runs 14 blocks, the zombies fall outside the 12-block radius, the reflex reports "safe" after 800 ms, the zombies catch up, the reflex reports a new threat. Each flip wakes the model. The limiter (3 s spacing) is the only thing bounding it: 13 calls in 40 s. Each call costs about 3,100 input tokens (estimated at 3.7 characters per token), of which 2,200 are the 23 tool schemas.

**What the model is shown is wrong.** Three lines from the first prompt of that episode, verbatim:

```
threats: 1 — zombie (11m N) — you are FLEEING by reflex. Decide: attack, go_to, hold; or idle to keep fleeing.
mobs: zombie (hostile, cannot reach you) x18 (nearest 12m N), skeleton (hostile, cannot reach you) x3 (nearest 22m NE)
why now: fleeing from 14 — zombie x12 (nearest 6m W), skeleton x2 (nearest 16m NE)
```

Three numbers for one horde, and the label "cannot reach you" is applied to every hostile that is merely more than 12 blocks away (`observe.js:88`). Later calls in the run show `threats: none` next to `why now: fleeing from 1 — zombie`. There are no risk figures at all: nothing about how fast they close, how many can reach the bot, which directions are open, or what the bot's own damage and armour are worth.

**Walls are not considered when choosing where to run.** The flee planner picks a point 14 blocks along an "away" vector, from three headings inside a 58° fan, and hands it to A*. Threat is a soft cost. With the real pathfinder (*ran*, script 03):

| Situation | Result |
| --- | --- |
| Dead-end corridor, zombies entering from the open end | Route found: 50 steps **through the zombies** (closest approach 0.0 blocks) and around the outside |
| Room with one doorway, zombies coming through it | Route through the doorway, 1.0 block from a zombie |
| 23-block drop behind the bot | A* spends its full 5 s; the partial route ends on the cliff edge |
| Open ground, ring with one gap | Takes the gap (this case works) |

When the bot makes no progress for 600 ms, or A* reports no path, the reflex switches to a straight sprint-jump along the escape vector for one second (`system1.js:368-403, 429-439`). That fallback checks nothing: no ledge, no lava, no wall. In the cliff case it sprints off the edge (*read*).

**Choosing to fight means standing in the middle.** `attack zombie` engages one zombie in melee and tells the reflex to ignore every zombie, present and future, until the fight ends (`index.js:669`, `system1.js:253`). The combat tick looks only at its target. Break-off is at 6 health. In the simulation with 12 zombies, the bot went from 20 to 2 health in about three seconds of melee and then fled (*ran*, script 05; the rig has no jump physics, so the bot swung more slowly than it would in game, and its damage model is mine: treat the numbers as illustrative). There is no kiting for anything except creepers.

Two smaller defects make the aftermath worse. A hurt bot carrying only steak eats nothing until hunger falls to 12, so it does not regenerate (*ran*, script 07: 4 health, 17 food → eats nothing). And an acknowledgement expires silently: after `hold` or `go_to`, the bot bolts again 60–120 s later without telling the model why (*ran*, script 09).

### Against your expectations

| Expectation | Status | Why |
| --- | --- | --- |
| Model sees an amount, not every mob | Met | Grouped by type with counts and nearest |
| Risks and real statistics | Not met | No statistics; horde undercounted; false "cannot reach you" |
| Backs off with walls and its own movement in mind | Partly | Open ground yes; dead ends and cliffs no |
| Reacts quickly | Met | 200 ms tick, no model in the loop |
| Calls the model only when needed, no spam | Not met | 13–20 calls a minute in the runs, for the whole chase; only the limiter bounds it |
| Never stalls the flee or the attack-while-kiting | Partly | Flee never stalls; attack-while-kiting does not exist |
| Decides quickly without thinking | Not met | First decision lands 3 s plus API latency after the threat; no reasoning control; 3,100-token prompt |

### Options

**When to call the model**

- **A. Episode reporting with hysteresis.** Keep the design. Leave "fleeing" only when nothing is within about 20–24 blocks for 4–6 s. Wake once at the start (debounced about 500 ms so the count is complete), again only on a real change (first hit, health crossing 10 or 6, count doubling, cornered, a new explosive or ranged type), and once at the end with a summary. About 50 lines in `system1.js`. Expect 1–3 calls per episode.
- **B. Standing orders.** A small policy table that the model edits in calm moments, or that you set in config: per mob class, flee, kite or fight, with limits. For example: up to 3 zombies with iron armour → kite; creeper → flee unless carrying a bow; 6 or more hostiles → flee toward home. The reflex applies it at once and reports afterwards. No call in the hot path at all.
- **C. A tactical micro-lane.** A third lane with a tiny static prompt, one line of statistics and three or four ready-made actions written out as JSON; the reply is one letter, constrained by schema, reasoning off, with a hard deadline of about 700 ms after which the default stands. Only worth building if the endpoint answers that fast.

**How to run**

- **D. Check the route before following it.** Reject an A* route that passes within about 3 blocks of a threat or whose first steps close the distance; try headings around the whole compass; probe the ground ahead in the straight-sprint fallback. About 80 lines.
- **E. A safety-field planner.** Flood-fill the walkable cells within about 24 blocks using the pathfinder's own neighbour generator. For each cell compare the bot's arrival time with the earliest arrival of any mob. Pick the cell with the best margin that still has exits, re-evaluate four or five times a second, steer along the parent chain. This handles dead ends, doorways and cliffs, and it is the base kiting needs. Roughly 300–400 lines, testable in the existing synthetic world.
- **F. Kiting on top of E.** Swing only when exactly one mob is in reach and the retreat cell is safe; sprint-hit for knockback; never trade inside a group; use a bow when carried.

### Recommended

A and D before the first test, together with the threat-line fix and the eating rule. Then B. Then E and F, which is the real answer to "almost impossible to get cornered". C only if section 12 measures a p95 under 700 ms.

Replace the three contradictory numbers with one line the model can decide from:

```
threats: 27 hostile (zombie 24, skeleton 3); 8 within 8m, nearest 5m; closing 2.3 m/s, contact in ~2s
open directions: S, SW; cornered: no; home 120m SW
you: hp 20, no armour, iron_sword (1 zombie per ~2s); if surrounded ~9 dmg/s
```

---

## 3. Scene 2: the three-floor cherry house

### What happens today

**Getting around.** Tested with the real A* and the harness's own pathfinder configuration, in a room whose only exit is the block under test (*ran*, script 01):

| Opening | Result |
| --- | --- |
| Plain doorway | Path |
| Oak or cherry door, closed | **No path** |
| Oak door, open | **No path** |
| Oak fence gate, closed | Path, with one right-click (and it is never closed again) |
| Oak fence gate, open | **No path** |
| Cherry fence gate, closed or open | **No path** |

The wrapper registers doors as openable, but upstream treats the upper half of a door as a solid block that cannot be broken, so the move is rejected. Upstream's list of gates dates from before cherry, mangrove, bamboo, crimson, warped and pale oak. An open gate is judged solid because the check uses the block type, not its state. The system prompt nevertheless tells the model "the body handles pathfinding, doors" (`system_prompt.txt:22`), so the model will not diagnose a `no path` result. The same script with `--fix` shows a 15-line state-aware `getBlock()` wrapper that makes all seven wooden cases pass and leaves iron doors closed.

The "close the door behind me" tick looks for any open door or trapdoor next to the bot and right-clicks it once the bot moves away or 9 seconds pass (`pathfinder_wrapper.js:1158-1202`). It does not know who opened it. Walking past an open decorative trapdoor and an open door closed both (*ran*, script 02). In a decorated house that is quiet vandalism.

For the pen: Zinc cannot get in through the cherry gate. Had the gate been oak, it would open it, walk in, leave it open for the sheep, and then be unable to walk back out through the open gate.

**Knowing where things are.** The place index is the best idea in this area: it records containers, stations, beds and signs, attaches the nearest sign within 2.3 blocks as a label, remembers contents after `look_in`, and persists to disk. In the storage-room test the association was right for all 42 chests it indexed (*ran*, script 06). The trouble is what follows:

- One scan returns at most 128 blocks (`places.js:162`). The room holds 147 of interest, so 6 chests, 4 signs and all three stations were dropped. `resolve("Diamantes")` found nothing although the sign is 11 blocks away.
- All entries on a floor within 7 blocks of each other merge into one cluster, and a cluster renders as one line of at most 9 parts. Signs are rendered as parts of their own. From the middle of the aisle the complete `nearby:` block was:

```
y71 1m here: sign "Esmeralda", sign "Madeira", sign "Espadas", sign "Terra", sign "Quartzo", sign "Lapis", sign "Pedra", sign "Carvao", sign "Picaretas", +77 more
```

- `find` searches opened contents, carried items and block names, but not labels (`skills.js:502-522`).
- Tool results are cut at 220 characters (`index.js:387`), so a `look_in` of a full chest is truncated.
- Copper chests, shelves and item-frame labels are not indexed. Contents are stored by item id only, so every potion is "potion" and every enchanted book is "enchanted_book".

There is no model of the building. `perception.js` contains a scene summariser that recognises house, storage, farm and enclosure, with tests, and nothing calls it (`perception.js:568-637`). The prompt has no rooms, floors, stairs or doors. The context is not rotting; it is starved, at about 200 tokens of situation per call.

**Using things.**

| Thing | Status |
| --- | --- |
| Chests | Works by id or label: `look_in`, `take`, `put` |
| Furnaces | `smelt` works, but furnace, smoker and blast furnace are one kind, fuel is the first burnable item found (logs, blaze rods, a lava bucket), and nothing reminds the model when it is done |
| Crafting table | Must already be within reach. A table inside 8 blocks but beyond the server's reach (roughly 5.5) is "found", the window never opens, and both lanes wait 20 s per attempt (`recipes.js:26`, `index.js:704`; *read*) |
| Brewing stand | No skill; `look_in` on it fails |
| Enchanting table, grindstone, anvil | No skill |
| Sheep and cows | No feed, breed, shear or milk. `attack cow` exists and chains up to 6 kills (`index.js:565-578`): one call next to a pen of five killed all five (*ran*, script 07) |
| Gate | See above |

`take` has a wrong fallback: asked for an item whose location is unknown, it opens the nearest furnace and reports success with whatever was in the output. `take {item:"diamond"}` returned "took iron_ingot x9 from furnace1" (*ran*, script 07). Item names are matched by substring in `put`, `give` and `equip`, so "diamond" can select the diamond pickaxe when no loose diamonds are carried (`skills.js:107-112`).

**The caged mobs.** When bars block the line of sight, the mobs are not threats and are listed as "hostile, cannot reach you". Name-tagged mobs are never threats, and a collection is normally name-tagged because untagged hostiles despawn, so the common case is right. If the mobs are not named and there is any line of sight, the bot flees, the model answers `hold`, and two minutes later the acknowledgement expires and it bolts again without a new report. Nothing ever records "this room is an exhibit".

**Pets.** On 26.3 the tame flag is at metadata index 18; `isTamed` reads 17 (`threats.js:96`). With the vendored 26.3 layout a tamed wolf returns `isTamed false`, `isProtected false` (*ran*, script 07). The tests pass because the rig is 1.21.4.

**Thinking.** There is no safe-area mode. Every call uses the same 256-token cap and the same pacing.

### Against your expectations

| Expectation | Status | Why |
| --- | --- | --- |
| Use all of it with ease | Not met | Chests yes; furnaces and crafting with traps; brewing, enchanting, grindstone, animals, doors and the cherry gate no |
| Quickly identify house, layout, organisation | Not met | No structure model; the summariser is dead code |
| Know which chest stores what; relate signs to chests | Partly | The index gets it right; the prompt hides it in any large room |
| Consult nearby blocks, run its own code | Not met | No block query; `run_script` only runs files already on disk |
| Make memories, know the place later | Partly | Blocks, labels, contents and named points persist; no site-level memory; the model cannot write facts |
| Data that does not rot the context but allows lookups | Partly | Compact, but with no lookups |
| Realise the caged mobs are a collection | Partly | Right when bars block sight or mobs are named; a loop otherwise |
| Heavy thinking in a safe area | Not met | No such mode |

### Options

- **A. State-aware doors and gates** (script 01 `--fix`), plus a ledger of what the bot itself opened: close only those, close gates immediately after passing, never touch anything else.
- **B. Storage as a summary plus lookups.** In the prompt: `storage here: 48 chests, 2 rows; labels: Minerios, Diamantes, Ferro, … (+36)`. Tools: `find` also searches labels; a `list_storage {page}`. Scan incrementally with no cap. Do not render a sign that already serves as a label. Attach wall signs by their `facing` property rather than by distance, and treat an item frame on a chest as its label.
- **C. A site model.** Call the existing summariser and add a room graph: flood-fill indoor air per floor into rooms with contents, connections and a tag (storage, pen, exhibit, enchanting). Persist it as a site with a two-line description the model writes once. In the area the prompt then reads: `site "Casa do Gabriel", 3 floors — you are on floor 2 (storage). Floor 1: pen (6 sheep, 4 cows, gate E), 3 furnaces, brewing stand, exhibit (5 caged mobs). Floor 3: enchanting table, grindstone, crafting table, 4 chests.`
- **D. A survey skill.** A scripted walk through every floor that scans and, if asked, opens each chest (48 chests is about 70 seconds), with no model calls; then one deliberate call, reasoning allowed, to write the site memory. This is the place for heavy thinking.
- **E. Lookups by query.** Your idea of the model running its own code. Arbitrary JavaScript from a small model is unreliable, and Node's `vm` is not a security boundary. A read-only JSON query gives most of the value: `query {kind:"sign", near:"chest12", radius:2}`, `query {block:"*_fence_gate", radius:16}`.
- **F. Station and animal skills.** Brewing (a slot state machine with a recipe table), enchanting (`bot.openEnchantmentTable`), anvil (`bot.openAnvil`), grindstone (raw window clicks), animals (`bot.useOn`), and `attack` with a `count`.
- **G. Containment instead of line of sight.** A hostile is contained when the region it can walk does not include the bot. Contained mobs are an exhibit, are remembered as one on the site, and never trigger a flee whether or not a gap gives a sight line.

### Recommended

A, the pet index, B and the `take` fallback before the first test. Then G, D and C. F in the order your friends actually ask for it; animals and brewing first. E as the JSON query, not as code. Add a safe-area mode: no threats for 60 s and inside a known site → reasoning on and a larger token cap for survey summaries and memory writing only.

---

## 4. Scene 3: PvP

### What happens today

A fight starts only when the model calls `attack` with a player's exact name. From then on a 20 Hz controller runs it with no model call, which is the right shape for what you asked. The controller picks the best sword or axe by material, moves a shield to an empty off-hand, keeps a 2.0–2.9 block band, strafes with random flips, jump-crits every swing at a full cooldown, backpedals after each hit, and raises the shield between swings. It breaks off at 6 health with a 10 s lockout, after which the flee reflex takes over. A golden apple is eaten at 8 health or less.

What it does not do, checked against each item you listed (*ran*, script 07, unless marked):

- **Mace.** The trigger is "mace in hand and vertical motion, within 6 blocks". An ordinary jump sets it off, and so does walking down stairs, so a player who hops with a mace makes the bot run for 1.4 s every time. A real dive reaches the trigger about 200 ms before impact. The response lowers the shield and turns the bot's back.
- **Spear with elytra.** Detected only while the attacker has vertical speed. A level glide at head height is tagged plain melee. The trigger is 8 blocks: 130–270 ms at 30–60 m/s.
- **Spear at low speed.** A charge on foot or mounted is tagged plain melee.
- **Only the current target is watched** (`combat.js:749-757`). A third player diving in during a duel is not seen.
- **Distance** follows the bot's own weapon, not the opponent's reach, which matters against a spear.
- **No sprint-reset.** Melee never sprints (`combat.js:809-816`).
- **Shield.** No axe when the opponent blocks. If the flee reflex preempts the fight, the tick returns before lowering it (`combat.js:721`; *read*).
- **Weapons.** Copper sword and axe, mace, trident and spear are never auto-equipped (`combat.js:582`); enchantments are ignored.
- **Eating.** Normal food is never eaten in a fight, and the steak rule from scene 1 applies afterwards. No totem, potions or pearls.
- **Fleeing** is decided only by 6 health, with maximum health hard-coded at 20.

The model's only channel during a duel is the full 3,100-token action turn. Repeated hits from the same player are deduplicated with a 4-second window that restarts on every hit (`index.js:883`; *read*), so a sustained fight wakes it once. If it answers that wake with any task tool, the duel ends, because every task tool cancels the fight (`index.js:420-424`).

### Against your expectations

| Expectation | Status |
| --- | --- |
| Flee from mace attacks | Partly: late, misfires on jumps and stairs |
| Sidestep spear with elytra | Partly: only steep dives, too late to matter |
| Sidestep a spear at low speed | Not met |
| Keep good distance | Partly: by its own weapon only |
| Jump at the right times | Partly: crit-jump every swing, nothing else |
| Know when to flee, when to eat, which item | Not met beyond two fixed thresholds |
| Shield and sprint reset | Shield minimal; sprint reset absent |
| No thinking, typed JSON, few-token questions | The loop has no model, which is right; the fast channel does not exist |

### Options

- **A. Evasion by time-to-impact.** From relative velocity and `entity.elytraFlying`, act when impact is under about 0.9 s away and the predicted miss distance is under 2.5 blocks. Sidestep to the side with more room. Apply it to any player who hit the bot in the last 15 s, not only the target. For the mace, require a fall of at least 1.5 blocks; leave the landing circle if there is time, otherwise face the attacker with the shield up and counter during their 1.7 s cooldown. I believe a shield still blocks a smash; confirm that on 26.3.
- **B. Read the opponent's hand.** Metadata `living_entity_flags` bit 0 says a player is using an item: blocking, drawing a bow, charging a spear. That gives spear charges on the ground, shield-up (switch to axe) and bow-drawn (strafe or block).
- **C. Sprint-reset and reach-aware spacing.** Sprint into each hit, release forward for two or three ticks, re-sprint. Set the band from the opponent's weapon.
- **D. Consumables.** Totem to the off-hand under 8 health, golden apple when the opponent has just swung and is more than 4 blocks away, and the eating rule fixed.
- **E. The micro-lane from scene 1** for stance only (fight, kite, flee, eat), with a deadline. No model can drive dodges; at best it chooses a stance every few seconds.

### Recommended

For a friendly server, where PvP is a duel someone asked for: fix the misfires and the eating rule now; then A and B, which are what make it look competent; C and D after. Add duel manners to standing orders: stop at the opponent's word or at 6 health, and say "gg".

---

## 5. Scene 4: a creeper behind Zinc

### What happens today

This scene works. Threat sensing uses the entity list, not a field of view, so "behind" makes no difference. A creeper appearing 3.2, 4 or 10 blocks behind got the body moving in 100–250 ms, and the fuse was lit in 1 of 18 runs (*ran*, script 08; open ground, and the rig walks at sprint speed at once, so add 150–300 ms in game for turning and path planning). A lit creeper within 8 blocks overrides every earlier decision, including `hold` and an ongoing fight, and the flee distance grows by 4.

Kiting happens only if the model then calls `attack creeper`: walk in, one sprint hit for knockback, run for 1.5 s or until 7.5 blocks away, wait for the fuse to go out, repeat (`combat.js:872-894`). That is the sequence you described.

### Gaps

- The kiting retreat is a straight sprint-jump away from the creeper with no look at walls, drops or other mobs (`combat.js:931-946`). With a wall behind the bot it stays inside the blast.
- Nothing checks that there is room to retreat before going in.
- The flee has the dead-end problem from scene 1.
- A creeper that keeps following produces the same model-call oscillation as the zombies.
- Charged creepers get the same distances as normal ones.
- Nothing protects builds. The bot will lead a creeper to the house if the house is "away".

### Recommended

Give the kiting retreat the same route check as the flee (option D of scene 1, then the safety field). Before the first hit, require 8 free blocks behind the bot. Add a rule to the flee planner that prefers directions away from remembered sites. Put "creeper: flee; kite only with room and at least an iron sword" in standing orders, so the choice is made once and not at every flip.

---

## 6. Scene 5: a calm chat

### What happens today

There are two lanes. The chat lane answers first, with that player's last eight lines, status, inventory, named places and up to three recalled memories; it may hand a task to the action lane. The body keeps running whatever it was doing meanwhile. Replies are queued and spaced, not dropped. That matches the core of what you asked.

- **Language.** The chat prompt says "Reply in the language of the message … unless they write in another language" (`chat_prompt.txt:4`), and the action lane's `say` says "the language the players use". Nothing checks the output. A friend who writes in English gets English, and action-lane messages built from English tool results can leak English.
- **Memory.** A chat line reaches long-term memory only if it contains a digit or one of about 30 keywords and is not a question (`memory.js:333`). Three of the keywords are stems wrapped in word boundaries (`guard`, `coloc`, `deix`), so they never match "guardei", "coloquei" or "deixei". Kept: "o pedro eh meu irmao". Dropped: "coloquei a picareta na fornalha", "meus pais chegam amanha", "amanha a gente vai matar o dragao" (*ran*, script 07). The model has no way to write a memory. What Zinc itself promised is not stored. Conversation history lives in RAM and is lost on restart. Recall is bag-of-words, top three.
- **Addressing.** Whisper, name as a whole word, a 60-second conversation window, or a question when only one other player is online; then the model may still answer with silence. "Zinco", "zincão" and "o bot" are not recognised, and neither is a player standing next to Zinc and looking at it (*ran*, script 07).
- **Switching.** Pure chat does not disturb the task. But `give`, `look_in`, `take`, `put`, `sleep`, `go_to`, `follow`, `hold` and the build tools all cancel the running task first (`index.js:420-424`), and nothing resumes it. "Zinc, me dá um pão" during a build ends the build. The prompt has no agenda line, so after the bread the model has only the recent chat to remind it what it was doing.
- **One call at a time.** Both lanes share one in-flight slot and one budget of 18 calls a minute (`brain.js:104-177`). A slow action call (20 s timeout, three attempts) delays the chat reply. A mob chase spends the budget: with a friend speaking every 9 seconds during a chase, the first four lines were answered in 2.0–2.5 s (model latency set to 1.5 s), then the budget stood at 18 of 18: the line sent at 40 s waited more than 20 s and was answered together with the one sent at 49 s (*ran*, script 11).
- **Human feel.** The prompt asks for one short informal line. There is no typing delay, and join, leave and death messages are ignored, so Zinc never greets anyone.

### Against your expectations

| Expectation | Status |
| --- | --- |
| Human-sounding | Partly: depends on the model; no pacing |
| Remembers everything it was told, and the important things | Not met |
| Decides whether a message is for it | Partly: misses nicknames and proximity |
| Always PT-BR | Not met |
| Chat does not interrupt the task | Met; but chat itself goes silent when a chase has spent the call budget |
| Switches between chatting and working mid-task | Partly: any chat-triggered action drops the task |

### Options

- **A. Language.** State "always Brazilian Portuguese, whatever language the message is in" in both prompts, and add a deterministic guard on every outgoing line: a stop-word ratio test, one retry with a stricter instruction, then a canned line.
- **B. Memory the model writes.** Add `remember` and `about` fields to the chat lane's `reply` tool, stored per player. In calm moments run one deliberate call that condenses the day's conversation with each player into five to ten facts, injected when that player speaks. Store Zinc's own promises and show the open ones.
- **C. Addressing.** Fuzzy name match (prefix plus suffix, edit distance 1, aliases), a proximity-and-gaze cue, and a longer window when Zinc asked the question.
- **D. A task stack and an agenda line.** Short side tasks push and pop; `follow`, `build` and `go_to` resume afterwards unless the model says `stop`. The prompt carries `agenda: [main] build small_house, walls, 40/120, asked by Gabriel 12 min ago | [side] give Pedro bread`.
- **E. Concurrency.** Let a chat call run alongside an action call, give chat its own reserved budget and a shorter timeout (8 s, one retry), and a canned PT-BR line when the endpoint is down.
- **F. Presence.** A typing delay proportional to length, a greeting on join once per session, and a short reaction to a friend's death, each rate-limited.

### Recommended

A and the three dead stems now; they are an hour of work. Then D and B, which are what "remembers" and "switches mid-task" really need. Then E, C and F.

---

## 7. Other situations

**Where Zinc should do well**

- A single hostile or a creeper in the open: reflex, verified.
- Status questions in chat: health, position, inventory and current task are in the chat prompt.
- "Vem aqui" and "me segue" across open terrain when the player is in view.
- Fetching from a known chest by id or label, giving an item, a simple smelt.
- Not griefing on purpose: no digging, no scaffolding by default, slash commands blocked, villagers, golems and named mobs protected, players attacked only by exact name.
- Long falls: water bucket and elytra reflexes.
- Surviving an API outage: reflexes continue and wake reasons are re-queued.

**Where it will fail or annoy people**

| Situation | What happens |
| --- | --- |
| Any building with doors | Cannot enter; `no path` |
| A night outdoors with no bed | Flee and "safe" alternate until morning, calling the model about 18 times a minute |
| Gathering anything | Impossible. Digging is off and there is no mining, chopping, farming or fishing tool. Zinc can carry, store, smelt, craft and build only with what it is given |
| "Kill a cow for me" | Kills up to six |
| A friend dies near Zinc | Zinc collects the drops by walking over them and the armour manager puts on anything better than what it wears. There is no "give everything back" |
| A friend asks for items | Taken from whichever chest matches, with no notion of whose chest it is |
| Everyone wants to skip the night | Zinc sleeps only if the model decides to and it has seen a bed nearby. Once in bed, a movement order cannot work until morning because `bot.wake()` is never called (*read*) |
| Crop fields | Upstream avoids only fire, cobweb and lava. Jump and drop moves onto farmland trample it; magma, cactus, berry bushes and powder snow are not avoided |
| Nether | Piglins are not on the hostile list (the 26.3 data marks them hostile), and there is no gold-armour logic. Portals are not handled |
| Elytra | Opens on a long fall, glides at a fixed pitch, no steering or landing. The chestplate is not put back afterwards |
| Servers with `/tpa` or `/home` | The vanilla guard blocks every slash command except `/msg` |
| An idle-timeout on the server | Zinc stands still between heartbeats; it will be kicked and reconnect in a loop |
| A prankster | There are no trust levels. Anyone can ask for its items or talk it into a duel with someone else |
| Fair play | Client physics has no slowdown for eating or blocking, and swings land from 3.3 blocks. Vanilla accepts both; an anti-cheat plugin will flag them |

---

## 8. Defect list

P0: fix before the first real test. P1: before friends rely on it. P2: later. *ran N* refers to script N in `audit/repro/`.

### Movement and pathfinding

| ID | Pri | Where | Problem | Evidence |
| --- | --- | --- | --- | --- |
| M1 | P0 | `pathfinder_wrapper.js:1130-1156`; upstream `movements.js:95-101, 390-396` | Doors impassable in any state; cherry and the other newer gates impassable; open gates impassable; oak-family gates opened and never closed | ran 1 |
| M2 | P0 | `pathfinder_wrapper.js:1158-1202` | Closes any open door or trapdoor beside the bot, whoever opened it | ran 2 |
| M3 | P0 | `pathfinder_wrapper.js:683-702` | Flee destination ignores topology: in a dead end the route goes through the mobs | ran 3 |
| M4 | P0 | `system1.js:368-403, 429-439`; `combat.js:931-946` | Straight-sprint fallback and combat retreat check no ledge, lava or wall | read; ran 3 case 3 |
| M5 | P1 | `system1.js:387-402`; `pathfinder_wrapper.js:690-696` | Flee replans every 2 s against moving mobs; three headings in a 58° fan | read |
| M6 | P1 | `pathfinder_wrapper.js:979-987` | No hazard costs added: farmland, magma, cactus, berry bushes, powder snow, campfires | read |
| M7 | P1 | `system1.js:598-623`; armor-manager `equipItem` | Chestplate not restored after the elytra reflex; picking up a chestplate swaps the elytra out | read |
| M8 | P2 | `skills.js:38, 123-161` | No stuck detection for task walks beyond a fixed 60 s budget and one retry | read |
| M9 | P2 | `skills.js:397-413` | `bot.wake()` is never called; orders given in bed cannot run | read |
| M10 | P2 | `pathfinder_wrapper.js:193-205, 686` | A forced threat-map sample right after the timed one can zero the velocity estimates | read |
| M11 | P2 | `threats.js:167-201` | Reachability probe: up to 6 ms per hidden hostile every 2 s on the main loop | read |

### Threat sensing and survival

| ID | Pri | Where | Problem | Evidence |
| --- | --- | --- | --- | --- |
| T1 | P0 | `threats.js:93-101` | Pets not recognised on 26.3: tame flags read at index 17, now at 18 | ran 7 |
| T2 | P0 | `system1.js:309-311, 331-346, 441-451` | Flee and "safe" alternate at the 12-block edge; model woken every 3 s | ran 4 |
| T3 | P0 | `observe.js:88`; `threats.js:333-339` | Hostiles 12–24 blocks away labelled "cannot reach you"; threat count covers only the nearest ring | ran 4 |
| T4 | P0 | `system1.js:95-107` | A hurt bot with only high-value food eats nothing until hunger is 12 | ran 7 |
| T5 | P1 | `system1.js:250-260, 331-346`; `index.js:436-438` | Acknowledgements expire silently after 60–120 s; the bot bolts with no report | ran 9 |
| T6 | P1 | `threats.js:24-32` | Static hostile list; 26.3 data adds piglin and parched (also enderman, zombified piglin, giant) | 26.3 entity list |
| T7 | P2 | `threats.js:111-117, 215` | Charged creepers treated like normal ones | read |
| T8 | P2 | `combat.js:721, 622-634` | Shield stays raised when the flee reflex preempts a fight | read |

### Combat

| ID | Pri | Where | Problem | Evidence |
| --- | --- | --- | --- | --- |
| C1 | P1 | `index.js:565-578`; `combat.js:447-452` | `attack <type>` chains up to 6 kills, farm animals included; no count | ran 7 |
| C2 | P1 | `index.js:669`; `combat.js:685-689, 770-860` | In a group: single-target melee, whole type ignored until the fight ends, break-off only at 6 health | ran 5 |
| C3 | P1 | `combat.js:54, 576-593` | Copper tools, mace, trident, spear never auto-equipped; enchantments ignored | ran 7 |
| C4 | P1 | `combat.js:194-223, 240-271, 749-757` | Evasion by distance, late; mace tag on jumps and stairs; level glides and ground charges missed; target only | ran 7 |
| C5 | P2 | `combat.js:809-816` | No sprint-reset | read |
| C6 | P2 | `combat.js:798-801` | Shield only against players, briefly; no axe against a blocking opponent | read |
| C7 | P2 | `index.js:805`; `combat.js:305` | Maximum health hard-coded at 20 | read |
| C8 | P2 | `combat.js:441-446` | A player named like a mob type can be matched by a mob request | read |

### Places, containers and skills

| ID | Pri | Where | Problem | Evidence |
| --- | --- | --- | --- | --- |
| S1 | P0 | `places.js:162, 315-329, 335-370` | Large rooms: 128-block scan cap, one line per floor cluster, 9 parts, signs crowd out chest ids | ran 6 |
| S2 | P0 | `skills.js:318, 324-329` | `take` falls back to the nearest furnace and reports success with its output | ran 7 |
| S3 | P1 | `skills.js:107-112, 330-331` | Item names matched by substring in put, give, equip, take | read |
| S4 | P1 | `skills.js:502-522` | `find` does not search sign labels | read |
| S5 | P1 | `index.js:387`; `skills.js:298` | Results cut at 220 characters | read |
| S6 | P1 | `places.js:34`; `skills.js:367-392` | Furnace types not distinguished; fuel is the first burnable item; no reminder | read |
| S7 | P1 | `recipes.js:26-34, 99`; `index.js:701-706` | Crafting table accepted up to 8 blocks away with no walk; both lanes wait 20 s per failed attempt | read |
| S8 | P1 | `places.js:29-42, 232-238` | Copper chests, shelves, item-frame labels not indexed; two single chests side by side merged as one | read; 26.3 block list |
| S9 | P1 | `api_wrapper.js:48-119` | No skills for brewing, enchanting, grindstone, anvil, animals or gathering | read |
| S10 | P2 | `skills.js:272-278` | Contents by item id only: no potion type, enchantment or name | read |
| S11 | P2 | `skills.js:259-270` | A container that will not open costs 20 s; a second open inside that window can be picked up by the stale call | read |

### Brain, prompts and memory

| ID | Pri | Where | Problem | Evidence |
| --- | --- | --- | --- | --- |
| B1 | P0 | `api_wrapper.js:224-235, 335-350` | No reasoning control; `finish_reason` never read; caps of 256 and 120 tokens | read |
| B2 | P0 | `chat_prompt.txt:4`; `system_prompt.txt:31`; `api_wrapper.js:50` | Language is "of the message"; no output check | read |
| B3 | P1 | `index.js:420-424, 634-733` | Every task tool cancels the running task, `hold` and `sleep` included; no resume; no agenda | read |
| B4 | P1 | `brain.js:104-177`; `api_wrapper.js:287-365` | One call at a time for both lanes; shared budget, which a chase exhausts in about 40 s, silencing chat (T2 removes the cause); 20 s × 3 | ran 11 |
| B5 | P1 | `memory.js:327-336` | Chat memory is a keyword filter with three dead stems; the model cannot write memory | ran 7 |
| B6 | P1 | `perception.js:568-637` | Scene summariser never called | read |
| B7 | P1 | `index.js:592`; `api_wrapper.js:101-106`; `builder.js:142-145` | A build phase demands materials for all phases; inline `grid` cannot work because the schema has no `palette` | ran 7 |
| B8 | P1 | `system_prompt.txt:22, 33` | "The body handles doors" is false; "at night, sleep" cancels running tasks | read |
| B9 | P2 | `api_wrapper.js:48-119` | 23 tool schemas, about 2,200 tokens, on every action call | ran 4 |
| B10 | P2 | `filter.js:25-60` | Nicknames and proximity not recognised | ran 7 |
| B11 | P2 | `config.json:46-51` | `fovDegrees`, `perceptionRange`, `perception3D` are read by nothing | read |

### Operations

| ID | Pri | Problem |
| --- | --- | --- |
| O1 | P0 | The README says a real `.env` was once committed. Rotate that key |
| O2 | P0 | The 26.3 data is an unmerged upstream PR, and T1 shows the drift is real. Resolve metadata indices by name from `registry.entitiesByName[...].metadataKeys` at start-up and fail loudly on a miss |
| O3 | P1 | Offline-mode server behind a public tunnel, and no trust levels in the bot. Whitelist at minimum |

---

## 9. What confuses the model

These are places where a competent model, reading exactly what it is given, would still choose badly.

1. **Three counts for one horde**, and `threats: none` beside `why now: fleeing from…` (T2, T3).
2. **"Cannot reach you"** on mobs that are walking toward it (T3).
3. **`hold` means "stay put" and cancels the task.** There is no "ignore these and carry on". A paused task "resumes after", but any decision replaces it.
4. **No history and no agenda.** A three-step request survives only as long as the original chat line stays in the last six.
5. **The storage line** shows signs without ids and a header ("y71 1m here") that describes a centroid.
6. **Labels are Portuguese, item ids English**, and `find` cannot bridge them.
7. **"The body handles doors"**, followed by `could not reach chest3: no path` with no hint of what blocked it.
8. **`take` reporting success** with a different item.
9. **`attack cow`** killing six when one was meant.
10. **"At night with a bed nearby, sleep"** against "follow Gabriel".
11. **Two voices.** The chat lane promises; the action lane, which cannot see that promise except in the chat log, may fail or say something else.
12. **Results cut at 220 characters**, mid-list.

What a small fast model does well here: choose one tool from a clear request, write short Portuguese, pick between two or three options given honest numbers. What it does badly: keep state across stateless turns, reason about space from bearings, count, and hold two instructions that pull apart. The fixes above move work from the second list to the first.

---

## 10. Ingestion and decision methods compared

**How the world reaches the model**

| Method | Tokens | Good at | Bad at | Verdict here |
| --- | --- | --- | --- | --- |
| Delta events (harness A) | ~300 per call | Cost | Almost everything: the model is blind | Not enough for an SMP |
| Text snapshot (ZincAI today) | ~200 situation, ~3,100 total | Cheap, deterministic, hard to inject | Space, layout, anything no summariser covers | Keep as the base |
| Snapshot plus lookups | Same, plus on demand | Large storage, signs, "where is" | Needs one more turn per lookup | Add (scene 2, options B and E) |
| ASCII or voxel grid | 300–1,500 | Short-range building alignment | Small models read it poorly; heavy | Keep for builder mode only |
| Site and room graph | 50–150 where relevant | "What is this place", routes, exhibits | Must be built and kept fresh | Add (scene 2, option C) |
| Model-written code (Voyager style) | Thousands per step | Novel tasks, exploration | Slow, unreliable with a small model, unsafe near other people's builds | Not for this server |
| Screenshots to a vision model | High | Appearance | Latency, cost, flakiness | No |

**How decisions leave the model**

| Method | Latency | Good at | Bad at | Verdict here |
| --- | --- | --- | --- | --- |
| One JSON line (harness A) | One call per step | Tiny | Fragile, no arguments by name | Superseded |
| One tool call per turn (ZincAI today) | 3 s spacing plus the call | Reliable parsing, bounded actions | Multi-step chores, anything real-time | Keep for deliberate work |
| A plan of several steps | One call for the chore | Fetch-smelt-deliver chains | Needs an executor that re-plans on failure | Add with the task stack |
| Standing orders | Zero | Hordes, creepers, duel manners | Only covers what was foreseen | Add first for danger |
| Micro-lane, one-letter answer | Must be under ~700 ms | Stance in ambiguous danger | Useless if the endpoint is slow | Measure, then decide |
| Behaviour tree or utility scoring, no model | 50 ms | Dodging, kiting, spacing | No judgement | This is the reflex body; extend it |

The shape that fits your scenes is three tiers. Tier 0, at 20 Hz with no model: reflexes, the safety field, kiting, PvP micro. Tier 1, standing orders and, if fast enough, the micro-lane: stance. Tier 2, the two lanes you have, with reasoning allowed only in a safe area: chat, chores, surveying, memory.

---

## 11. Plan

**Before the first real test.** About three to four days.

| Item | Size |
| --- | --- |
| M1 doors and gates, state-aware, with a ledger of what Zinc opened; M2 falls out of the ledger | 1 day |
| T1 and O2: metadata indices by name, with a start-up check | 2 hours |
| T2 and T3: hysteresis, episode wake policy, one honest threat line | 1 day |
| M3 and M4 stopgap: route check and ground probe | Half a day |
| S1: storage summary, no scan cap, signs folded into labels; `find` searches labels (S4) | Half a day |
| S2, T4, B2 and the three dead stems in B5 | 2 hours together |
| B1: reasoning off, read `finish_reason`, per-lane timeouts, after probing the endpoint | Half a day |
| O1: rotate the key | Minutes |

**Before friends rely on it.** About two weeks.

- Standing orders (scene 1, option B), then the safety-field planner and kiting (E, F).
- Task stack and agenda line (B3); memory the model writes and per-player profiles (B5).
- `attack` with a count and no chaining on passive mobs (C1); exact item matching (S3); furnace types and a done-reminder (S6); walk to the crafting table (S7).
- Containment test for exhibits; the survey skill; the site model.
- Trust levels (owner, trusted, guest) for giving items, fighting players and taking from labelled chests.
- Hazard costs in travel (M6); `bot.wake()` before movement (M9).
- Separate chat budget and concurrent chat call (B4); tool subsets by situation (B9).

**Later.** Brewing, enchanting, anvil, grindstone and animal skills; PvP options A to D; gathering restricted to natural blocks away from sites; presence features; a decision on whether to keep harness A.

---

## 12. Checklist for the first real test

**The endpoint, before anything else.** Send the real action payload 20 times and record:

- p50 and p95 latency for the action call and for the chat call.
- Whether the response carries `reasoning_content` and how many completion tokens it uses.
- `finish_reason`: any `length` with a 256-token cap means truncated tool calls.
- Whether `tool_choice: "required"` is honoured or the fallback to `"auto"` fires.
- The effect of the provider's switch for reasoning (for Qwen-family models this is usually `enable_thinking: false`, sometimes under `chat_template_kwargs`).
- Whether cached prompt tokens are reported; the 2,900-token static prefix should be.

**On the 26.3 server**, with one friend, in this order:

1. A tamed wolf and a name-tagged zombie in view: `mobs:` should say "(pet)" and "(named)".
2. A sign on a chest: the label appears in `nearby:`.
3. A closed door between Zinc and a chest: `go_to` succeeds and the door is closed again.
4. A lit creeper: Zinc runs although the model was told to `hold`.
5. Five zombies at night: count the model calls in one minute.
6. A whisper, and a line in English: both answered in Portuguese.

**Server settings worth a look:** `playersSleepingPercentage` below 100 so Zinc cannot block the night; `player-idle-timeout` off or Zinc given an idle fidget; a whitelist.

---

## Appendix A. Repro scripts

Run from the repository root after `npm ci`. None touches the network.

| Script | Shows | Time |
| --- | --- | --- |
| `node audit/repro/01-doors-and-gates.js` (add `--fix` for the sketch) | M1 | 1 s |
| `node audit/repro/02-door-tick.js` | M2 | 1 s |
| `node audit/repro/03-flee-dead-end.js` | M3, M4 | 6 s |
| `node audit/repro/04-horde-call-rate.js [seconds]` | T2, T3, B9 | 40 s |
| `node audit/repro/05-horde-attack.js [zombies]` | C2 | 16 s |
| `node audit/repro/06-storage-room.js` | S1 | 1 s |
| `node audit/repro/07-misc.js` | S2, B5, B10, B7, T4, C3, C4, T1, C1 | 17 s |
| `node audit/repro/08-creeper-reaction.js` | Scene 4 timing | 35 s |
| `node audit/repro/09-hold-expiry.js` | T5 | 9 s |
| `node audit/repro/10-harness-a-horde.js [seconds]` | Appendix B: call rate and prompt of harness A | 40 s |
| `node audit/repro/11-chat-during-chase.js [latencyMs] [seconds]` | B4 | 72 s |

## Appendix B. Harness A (`src/`)

Read, not executed, except the horde run (script 10): the same chase produced 20 model calls a minute. The first showed `threats 10 — zombie x10 (nearest 5m W)`; later ones showed only `fleeing from 1 — zombie (12m N)`. One call is about 300 input tokens.

- The model is blind. The prompt is vitals, up to five events and a ten-word memory line (`agent.js:615-629`, `deltaState.js:23-25, 136-153`). `equip` takes a hotbar slot number the model cannot see (`agent.js:784-795`). There are no eat, follow, container or sleep actions.
- Chat is cut to 80 and then 64 characters (`agent.js:566`, `deltaState.js:25`). The guard lowercases, caps at 10 words, and drops lines that arrive inside the 3 s cooldown (`chatGuard.js:20-70`). The language rule is again "of the message" (`systemPrompt.js:16`).
- Every non-idle action queues another call (`agent.js:719-770`). Hunger and health events wake the model although it cannot eat (`agent.js:507-510`). After one failed parse retry the events are dropped (`agent.js:666-675`).
- One serialized lane with 3 s spacing, a 96-token cap and no reasoning control (`agent.js:633-696`, `amdClient.js:47-55`).
- The elytra controller's fall guard and chase require the elytra in the inventory and never fire when it is already worn (`elytra.js:75-77, 208-212`). The rocket is equipped outside the arbiter and the weapon is not restored (`elytra.js:109-123`). It holds forward with no steering or landing (`elytra.js:170`).
- The anti-stuck routine turns 180° and hops with no ledge check (`watchdog.js:141-169`), and may fire during melee when a paused move exists (`agent.js:430`).
- `mineflayer-pvp` is a dependency and is imported nowhere.
