# Tool audit — misleading tools and tools that limit the model

Scope: everything the model can call, everything that decides what it may call,
and every config knob that claims to shape either. Two questions per finding:

1. **Does the tool lie?** Does it advertise more than it does, or tell the model
   something untrue about position, geometry, logic, or the state of its body?
2. **Does the harness limit the model?** Does it silently shrink what the player
   can build with, wear, hold, fight, or say?

Method: read every prompt and schema, then **ran the real code** against the
synthetic world (`test/helpers/world.js` = real prismarine blocks, real
`mineflayer-pathfinder` Movements + A\*, real prismarine-physics). Anything
marked **CONFIRMED** is a reproduction, not an opinion. **VERIFIED-BY-READ**
means it was traced through code a headless rig cannot drive (a live inventory
window, mostly).

Severity: **S1** = the bot damages something the harness promises to protect, or
the model is told a falsehood that leads it to act wrongly. **S2** = real
capability gap or silent limitation. **S3** = wording and drift.

Three of my first-pass suspicions were **wrong** and are recorded in §15 — pet
protection, PvP range, and passive mobs all work. I would rather say that than
ship a scarier report.

---

## 1. S1 — `dig` breaks through somebody else's claim, and both prompts say it does not

The `dig` schema (`api_wrapper.js:63`) calls itself "ONE deliberate corridor".
`system_prompt.txt` tells the model:

> Whatever the rule says, a walk never breaks a block that is part of something
> built (it touches crafted blocks) or lies in someone's claim.

Both protections live in one function, `_configureBreakGuard()`
(`custom_mineflayer/pathfinder_wrapper.js:1539`), and it opens with:

```js
if (this._digWindow && Date.now() <= this._digWindow.expiresAt) return 0
```

The `dig` corridor **is** the dig window (`skills.js:428` →
`beginDigging`). So the exact call the model uses to dig a tunnel is the one call
where the "touches a crafted block" test and the "inside a claim" test are
switched off. `propertyGuardAt` still refuses a *destination* inside a claim
(`index.js:2812`), but nothing checks the cells the corridor passes *through* —
and a player's house is usually between the bot and where it is going, not at
the destination.

**CONFIRMED** (`.probe/p30.js`, real A\*, four arms): a 40-block claimed plank
wall, destination on the far side and therefore outside the claim.

```
standing policy              status=success  breaks=0   inside-claim=0
dig corridor (claim guard ON) status=success  breaks=1   inside-claim=1   ← the finding
standing policy, no claim     status=success  breaks=0   inside-claim=0
dig corridor, guard neutered  status=success  breaks=1   inside-claim=1
```

Arms 1 and 2 differ **only** in whether `beginDigging()` ran, and arm 2 breaks a
block the claim guard explicitly protects. The earlier 40×2 wall probe
(`/tmp/probe5.js`) showed 3 breaks; this one uses a single-block-thick wall so
the comparison is unambiguous.

**Blast radius is wider than one call.** There is exactly one `endDigging`
caller in the codebase (`skills.js:329`), and the window stays open for up to
**120 s** (`Math.min(this.moveTimeoutMs, 120_000)`). `gather` walks to each
target with `_walk` and never closes the window, so any `gather` started while a
corridor is open inherits claim-blind digging.

**Fix:** do not short-circuit `isProtected` on `_digWindow`. The corridor is the
model's aim; a claim is still somebody else's property. If the model really needs
to pass a claim, that is what asking the owner is for.

---

## 2. S1 — `dig_policy {mode:"all"}` makes containers and machines breakable, and the tool says otherwise

Four user-facing strings promise the opposite of the code:

- schema (`api_wrapper.js:75`): "all = anything in the way (doors, containers,
  bedrock never)"
- system prompt: "`mode: \"all\"` — anything in the way may be broken (bedrock,
  portals, spawners and the like never are)"
- `DigPolicy` header: "'all' anything in the way may be broken, except what is
  never broken (bedrock, doors, containers, portal frames…)"
- the runtime confirmation the model reads back, verbatim: *"walking may break
  ANY block in the way (mode all; doors, containers and bedrock are never
  broken)"*

`NEVER_DIG` (`dig_policy.js:42`) is bedrock, barrier, command blocks, structure
block, jigsaw, end portal frame/portal, nether portal, spawner, trial spawner,
vault, reinforced deepslate. **No container. No machine. No workstation.** Doors
are covered separately by `doors.js`; nothing else is.

**CONFIRMED** (`/tmp/probe8.js`, real Movements, standing policy `mode:"all"`):

```
barrel         BREAKABLE      enchanting_table BREAKABLE
furnace        BREAKABLE      beacon           BREAKABLE
blast_furnace  BREAKABLE      bookshelf        BREAKABLE
hopper         BREAKABLE      shulker_box      BREAKABLE
dropper        BREAKABLE      trapped_chest    BREAKABLE
dispenser      BREAKABLE      ender_chest      BREAKABLE
crafting_table BREAKABLE      tnt              BREAKABLE
anvil          BREAKABLE      spawner          protected
oak_door       protected      bedrock          protected
```

`ender_chest` is breakable. A player's storage room is a corridor through it.

The `dig` corridor path is *not* affected here, because `endDigging()`
re-applies upstream's own base set (`_zincaiBaseCantBreak`), which does include
chest — that is why the chest case in `/tmp/probe6.js` comes back safe.
`mode:"all"` is the broken one, and it is the mode the prompt recommends for
underground work: "add the block or switch to `all` once".

**Fix:** move the container/machine/workstation families into `NEVER_DIG`, or
add a `NEVER_DIG_POLICY` used only by the passive path, then correct the four
strings above.

---

## 3. S1 — the property guards cover five verbs out of fourteen, so `take` is refused and `put` is not

`continuity.js` exports exactly two guards, `propertyGuardAt` (claims) and
`containerTakeGuard` (someone else's chest). Which verbs consult them:

```
dig               propertyGuardAt
gather            propertyGuardAt
build             buildBlocks → propertyGuardAt
build_shape       buildBlocks → propertyGuardAt
take              containerTakeGuard
put               *** NONE ***
smelt             *** NONE ***
use_block         *** NONE ***
sleep             *** NONE ***
light_up          *** NONE ***
craft             *** NONE ***
shelter           *** NONE ***
give              *** NONE ***
```

**CONFIRMED** (`.probe/p34.js`, parses each `case` arm out of `index.js`).
`skills.js` never requires `continuity` at all — `grep -c continuity` returns
**0** — so no skill can enforce a claim on its own; every guard is the caller's
job, and eight callers forgot.

The result is a set of holes that are *individualy* defensible and *together*
incoherent. The harness will refuse to take a diamond from a labelled chest, and
in the same turn will:

- **`put`** deposit items into that same chest — `skills.js:729`, unguarded.
  A model that misreads a "store my stuff" request wipes the owner's inventory
  arrangement, or fills their chest with cobblestone.
- **`smelt`** load the owner's furnace with its own ore and burn the owner's
  coal — `skills.js:755-758`, unguarded.
- **`use_block`** right-click anything within 16 blocks — `skills.js:884`
  `bot.activateBlock`. That opens their door, flips their lever, fires their
  dispenser, and pushes their button. The prompt files `use_block` under
  "levers, buttons, doors, beds", i.e. exactly the things that change state.
- **`sleep`** in the nearest bed — `skills.js:897`. On a server where a bed sets
  spawn, this **moves the bot's respawn point into a stranger's house**, which is
  the single most persistent thing a bot can do to another player. Nothing checks
  ownership, and the schema says only "Sleep in nearest bed".
- **`light_up`** and **`_placeCarried`** place blocks on whatever floor is
  within 2 blocks and dark, including the floor of a claimed house.

**The limiting side of the same bug:** because there is no `put` guard, the
model also has no way to *ask* to store things in a permitted container and get a
clear "that one is Steve's" — the guard that exists knows the answer and is never
asked.

**Fix:** give `put`/`smelt` the mirror of `containerTakeGuard`, and give
`use_block`/`sleep`/`light_up`/`_placeCarried` a `propertyGuardAt` on the target
block. `sleep` in particular should refuse a bed inside a claim it does not own,
or at minimum say whose bed it is.

---

## 4. S1 — `build`'s claim check samples three cells, and two of them are usually the same corner

`index.js:2619`:

```js
for (const probe of [plan.steps[0], plan.steps[Math.floor(plan.steps.length / 2)], plan.steps[plan.steps.length - 1]]) {
  const g = continuity.propertyGuardAt(probe, dim(), { askedBy })
```

Three probes for a plan that may be thousands of cells. Worse, they are not
spread over the *footprint*: `parser.plan` emits steps in build order, so for a
flat floor all three share x≈z on the same diagonal. **CONFIRMED**
(`.probe/p26.js`):

```
 9x9  claim@corner  samples=0,0 4,4 8,8      refused=true   cells-in-claim=18
 9x9  claim@middle  samples=0,0 4,4 8,8      refused=true   cells-in-claim=29
15x15 claim@corner  samples=0,0 7,7 14,14    refused=true   cells-in-claim=18
15x15 claim@middle  samples=0,0 7,7 14,14    refused=false  cells-in-claim=29
21x21 claim@corner  samples=0,0 10,10 20,20  refused=true   cells-in-claim=18
21x21 claim@middle  samples=0,0 10,10 20,20  refused=false  cells-in-claim=29
```

Rows 4 and 6 are the escape: a 15×15 floor (or larger) with a player's claim on
its centre passes the check and puts **29 blocks inside the claim**. The check
gets weaker as the build gets bigger, which is backwards.

**Fix:** test every step (the plan is already materialised, and `claimAt` is a
linear scan over a small array), or at minimum test the footprint's corners plus
a sample per claim the plan's bounding box intersects.

---

## 5. S1 — `hold` cannot accept the argument both prompts tell the model to give it

`api_wrapper.js:98`: `tool('hold', 'Accept currently listed threats…')` — **zero
declared parameters**. `parseToolCall` rejects any undeclared field
(`api_wrapper.js:290`). Meanwhile `system_prompt.txt` says:

> `hold` ignores listed threats (`[id=…]`) to continue your task

and the live threat block (`index.js:1868`, `describeSituation`) prints ids.

**CONFIRMED:**

```js
coerceAction({tool_calls:[{function:{name:"hold", arguments:'{"ids":[12,13]}'}}]})
→ {"a":"idle","_badArgs":"hold"}
```

The tool never runs. The model is told "arguments for hold failed schema
validation" with no hint of the valid shape, at the exact moment it is being
chased and wants to stop running. `hold` ignores its arguments anyway — the
handler at `index.js:2849` acts on the whole current threat snapshot — so the
schema is simply missing the field it advertises.

**Fix:** declare `targets: {type:'array', items:{type:'string'}}` (even if the
handler still holds everything) or drop `[id=…]` from the prompt.

---

## 6. S2 — a free-text enum silently discards the model's entire answer

`parseToolCall` validates every key against `spec.enum`. For fields whose
*handler* already validates and degrades gracefully, this is strictly worse than
letting the value through.

`goal.origin` is `enum: ['self_generated','player_requested','shared_project']`,
but `runGoalOp` defaults it when absent, and `system_prompt.txt` documents
`goal` without spelling the enum. A model that writes `"origin":"self"` or
`"origin":"mine"` loses the **whole call** — description, priority, reason and
all — before `runGoalOp` is reached.

**CONFIRMED:**

```js
coerceAction({tool_calls:[{function:{name:"goal", arguments:
  '{"operation":"add","description":"build a shed","origin":"self"}'}}]})
→ {"a":"idle","_badArgs":"goal"}
```

Same shape for `social.operation`, `redstone_engineer.operation` and
`circuit_project.operation`. Those handlers contain "must be one of …" messages
that are **dead code**, because the schema rejects the value first. So the model
gets the least informative of the two possible errors.

**Fix:** either drop enums from fields whose handler validates, or have
`parseToolCall` return the offending value and let the handler explain.

---

## 7. S2 — `recall` says "semantic", and is a word-overlap score

`api_wrapper.js:193`: "Search long-term memory with relevance ranking (semantic,
entity, location, goal)". `system_prompt.txt`: "`recall` searches long-term
memory by text, `category`…".

The implementation (`memory.js:44` `tokenize`, `:52` `embed`, `:498` `retrieve`)
is a bag of words with plural folding and a 30-word stop list, scored with cosine
similarity. There is no embedding model and no synonym table.

**CONFIRMED** (`/tmp/probe14.js`):

```
"where are the diamonds"             -> 1 hit  ("diamonds are in chest2…")
"diamonds"                           -> 1 hit
"elephant"                           -> 0 hits
"treasure"                           -> 0 hits   ← same concept, other word
"where does steve keep his stuff"    -> 1 hit  (shares "steve" only)
```

The behaviour is defensible — it is cheap, local and honest in its result body —
but the *word* "semantic" is the one the model reads, and it means the model
will believe a zero-hit recall is evidence of absence. A player calling a chest
"the stash" and a memory saying "diamonds" will never meet.

**Fix:** either say "keyword (word overlap)" in both the schema and the prompt,
or add a small synonym/fuzzy-token step. The honest label costs nothing.

---

## 8. S2 — the body has no verb for most of what it can carry

The tool surface is "everything, always". The **verbs** are the missing pieces.
Each row was checked against the schema list and the dispatch switch:

| Capability | Status | Evidence |
| --- | --- | --- |
| Use a carried item by hand — bucket, ender pearl, boat, firework, potion, totem, wind charge | **no tool** | No `use_item` verb. `activateItem` appears only in the wind-charge path, the bow path and two reflexes (`system1.js`, `pathfinder_wrapper.js:679`). |
| Place a single block at chosen coordinates | **no tool** | `place` exists in `TOOL_CAPS`, `lanes.js` and `boundary.js` and is **not in `ACTION_TOOLS`**. Only `build`/`build_shape`/`redstone_engineer place`. |
| Choose a hotbar slot / use a specific inventory slot | **no tool** | `setQuickBarSlot` is gated in `boundary.js:123` and called **nowhere**. |
| Enchant, repair, brew, trade with a villager | **no tool** | `enchanting_table`, `anvil`, `brewing_stand` are indexed as places (`places.js STATION_KINDS`) and can be walked to, but no verb uses them. |
| Shear, milk, tame, ride, leash, fish, ignite, set spawn | **no tool** | none. |
| Put a specific item in the off hand and keep it there | partial | `equip {where:'off-hand'}` works, but `armor.js` re-ranks shield vs totem unless the model has held the slot. |
| Eat any real food | partial | `FOODS` whitelist (`system1.js:56`) covers 32 of the game's 44 edible items; `HEALING` (`:93`) adds `golden_apple`/`enchanted_golden_apple` at a health threshold, which is the correct usage. The 10 with no path at all are `tropical_fish`, `pufferfish`, `spider_eye`, `poisonous_potato`, `chorus_fruit`, `suspicious_stew` and the four fish buckets — all either harmful or situational, so this is the most defensible limit in the list. |

**CONFIRMED:** `ACTION_TOOLS` has no `place`; `setQuickBarSlot` occurs once in
the whole repo (in `boundary.js`'s capability table) and is never called;
`system1.js` FOODS vs `vendor/minecraft-data-26.3/foods.json` differ by exactly
those 10 items (the 32 it does list match the game data on points *and*
saturation).

This is the biggest *capability* cluster. Armor, tools, weapons and building
blocks are fine. Consumables and utility items are, in practice, not part of the
game for this agent: it can carry a water bucket but cannot pour it, cannot
pearl, cannot boat, cannot potion, cannot totem-swap deliberately, and cannot
place one block where it wants without going through a build plan.

The prompt's "Every tool is available on every turn" is true. "You have your own
body" is about two-thirds true.

---

## 9. S2 — `build_shape` mixes two coordinate conventions under one `at`

`api_wrapper.js:47`: `AT` → "Origin [x,y,z]; default: feet." The model reads
"origin" as the corner the shape starts from.

**CONFIRMED** (`generateShape`, extents relative to `at`):

```
cylinder r2 h1 : x -2..2  z -2..2  y 0..0     ← CENTRED on `at`
ring r2        : x -2..2  z -2..2  y 0..0     ← CENTRED
dome r2        : x -2..2  z -2..2  y 0..2     ← CENTRED
box w3 d3 h1   : x  0..2  z  0..2  y 0..0     ← corner at `at`
floor 3x3      : x  0..2  z  0..2  y 0..0     ← corner
wall l3 h1     : x  0..2  z  0..0  y 0..0     ← corner
arch w3 h3     : x  0..2  z  0..0  y 0..3     ← corner, and one course too tall
```

`build_shape {shape:"cylinder", at:[100,64,100]}` puts its west edge at x=98;
`{shape:"box"}` at the same `at` puts its west edge at x=100. A model stacking a
dome on a box — the natural way to build a tower — is off by `r` in both axes
with no warning. `arch` also emits `y = 0…h`, i.e. **h+1 courses**, while
`params.h` is documented as the height. And `arch` ignores `axis` entirely,
though the schema lists `axis` in the shared `params` description, so a model
that rotates a wall and then its arch gets one silent non-rotation.

**Fix:** one convention (corner) for every shape, documented per shape; `arch`
emits `h` courses and honours `axis`.

---

## 10. S2 — the 3D build grid is offered only for regex-matched materials

`index.js:2032` appends the top-down + cross-section grid `if (holdingBuildMaterials())`.
That is `BUILD_BLOCK_HINT` (`index.js:1927`), a name regex:
`planks|log|stone|dirt|cobble|brick|concrete|terracotta|wool|glass|sand|gravel|deepslate|_slab|_stairs|_fence|_wall|scaffold|torch|redstone|_door|_trapdoor|ladder|rail`.

Not in it: `blackstone`, `basalt`, `tuff`, `calcite`, `quartz_block`,
`purpur_block`, `prismarine*`, `amethyst_block`, `copper_block`, `nether_bricks`
(✓ via `brick`). So a model building in quartz or blackstone is handed **no grid
at all**, while a model holding dirt gets one.

The prompt says: "When you hold building materials (or start a build) the prompt
includes a local 3D grid automatically, so you are never handed a build blind."
A quartz builder is handed a build blind.

**Fix:** ask the registry instead of the name — `bot.registry.blocksByName[held]`
answers "is this a block" exactly — or key the grid off the running task too.

---

## 11. S2 — the config's perception knobs are dead, and the live "vision" is 360°

`perception.js` has `visibleBlocks`/`visibleEntities` with an `fovDegrees`
parameter and a `buildPerceptionText` that uses them. **Nothing in `index.js`
calls any of them.** The live prompt uses `buildVisionBlock`
(`index.js:486`, `:2033`), which is a 360° box scan around the bot — no FOV, no
occlusion, no line of sight.

So the model is shown blocks *behind* it and *through walls* as though it can
see them, and three config keys that suggest you can tune this
(`behavior.fovDegrees` 90, `behavior.perceptionRange` 10,
`behavior.perception3D` false) are read by **nothing**: 0 occurrences outside
`config/defaults.json` for the last two, and `fovDegrees` only as a function
parameter that is never supplied from config. `scout.relocateTimeoutMs` and
`scout.deathAvoidRadius` are dead the same way (0 occurrences).

**CONFIRMED** by exhaustive grep across `zincai/**/*.js`.

**Fix:** delete the dead keys (an operator who sets them is configuring
nothing), and decide whether the build grid should be 360° (current) or
FOV-limited (documented) — right now the code and the config disagree without
saying so.

---

## 12. S2 — `use_block` matches by substring, so it acts on the wrong block

`skills.js:872`: `b.name === q || b.name.includes(q)`, then `positions[0]`.
There is no ranking, no tie-break and no disambiguation, so a generic word picks
an arbitrary member of a family, nearest-first.

**CONFIRMED** (`.probe/p31.js`, real 1.21.4 registry):

```
"button" -> 14 blocks   "door"   -> 42 blocks
"bed"    -> 17 blocks   "furnace" -> 2 blocks
"chest"  -> 3 blocks
```

`use_block {what:"bed"}` can therefore walk to **bedrock** (it sorts first
alphabetically and `includes('bed')` matches it), and `use_block {what:"chest"}`
may pick `ender_chest` — a block with a completely different interaction —
over the chest the model meant. Combined with §3 (no claim guard on
`use_block`), "open my chest" can end up flipping a stranger's lever.

**Fix:** exact-match first, then a shared-suffix family match with a documented
preference order, and echo the block actually used (it already does) plus a
"did you mean" list when the match is ambiguous.

---

## 13. S3 — `logic_test` is honest in its body and oversold in its handle

`adder_width`: "Exhaustive unsigned adder width 1–4". The tool is a
*combinational* evaluator; it is exhaustive **over the abstract gate graph**.
`system_prompt.txt` files it in the REDSTONE section next to
`redstone_engineer verify`, which really does toggle levers in the world. Its
result text says all of this clearly ("Not Minecraft simulation; no timing,
feedback, physical layout or fault cause inferred") — the *description*, the line
the model acts on first, does not.

Cosmetic, but cheap to fix: prefix with "ABSTRACT (no world) —", which is what
the implementation comment already says.

---

## 14. S3 — prompt / README drift about the default dig list

`README.md` and `system_prompt.txt` both describe the shipped dig list as
"dirt, grass, sand, gravel, snow, leaves". `DEFAULT_SOFT_BLOCKS`
(`dig_policy.js:30`) has **27 entries**, including `*_leaves`, `moss_block`,
`moss_carpet`, `cobweb`, `vine`, `soul_sand`, `soul_soil`, `podzol`, `mycelium`,
`rooted_dirt`, `dirt_path`, `mud`, `clay`, `powder_snow`, `short_grass`,
`tall_grass`, `fern`, `large_fern`, `dead_bush`.

A model trusting the description believes a swamp forces a detour; in fact the
walk strips the vines and moss out of its way. Low harm, but it teaches the model
that the prompt understates what the body does — which is exactly the opposite of
what the rest of this harness is careful about.

Also worth one line each:

- `find`: "Find block type, item in opened containers, chest label, or storage."
  The body answers "no opened container holds it", so a model reading only the
  schema may believe it searches every container. Say "opened" in the summary.
- `corpse_run` takes no arguments and admits pickup/despawn are not verified —
  accurate, just note that "walk near last death" is the whole of it.
- `hold`'s schema is a single sentence with no parameters, and the prompt
  contradicts it (see §5).

---

## 15. Clean — things that look dangerous and check out

Each of these was a plausible "dangerous tool" and each survived a real test.
Recording them is the point of an audit: it should be as specific about what is
fine as about what is broken.

| Suspect | Verdict | How it was checked |
| --- | --- | --- |
| `attack` kills a player's tamed wolf or cat | **safe** | **CONFIRMED** `/tmp/probe11.js`: registry loaded, `owneruuid` at index 18, `tameState=true`, `isProtected=true`, `attack wolf → protected`. My first read of the code said the opposite; the version-aware `metadataKeys` table in `threats.js:86` is what makes it work, and it needs `useRegistry()` (which `index.js` calls). |
| `attack.player` only works inside `engageRadius` | **false** — PvP reaches further | **CONFIRMED** `/tmp/probe12.js`: a player at 40 blocks is `TARGETED`; the radius check is only applied to mobs. My earlier draft claimed otherwise and was wrong. |
| `attack` on a passive animal | **works** | **CONFIRMED** `/tmp/probe12.js`: `cow` at 5 blocks → `TARGETED`. Only `zombie` at 30 blocks → `no_target`, which is correct. My earlier draft claimed passives were unreachable; also wrong. |
| `attack` hits villager / golem / named mob | **safe** | `isProtected` → `PROTECTED_NAMES` + `isNamed`; **CONFIRMED** `iron_golem → protected`, `villager → protected`. |
| `shelter` pillars up out of a player's build | **safe** | `pillarUpTo` consumes inventory only and records each cell in `placedScaffolds`; `removeScaffolds` re-reads the world and skips a cell holding anything other than the block it placed (`builder.js:459`). |
| `dig` into a claimed house when the destination *is* inside it | **refused** | `propertyGuardAt` in `index.js:2812` runs before the corridor opens, on the destination cell. Only the through-the-claim case (§1) escapes. **VERIFIED-BY-READ** — the guard is in `index.js`, so a wrapper-only rig cannot reach it. |
| `take` steals from a labelled chest | **safe** | `containerTakeGuard` (`continuity.js:535`) refuses on a `player:owner` label or a player claim unless the asker is that player. |
| `redstone_engineer place` overwrites a claim | **refused** | `canWrite` (`index.js:631`) → `preflight` blocks the cell. |
| `say` runs a `/command` | **impossible** | `vanilla_guard.js` strips a leading `/` before the wire; `whisper()` is the one constructed exception and it validates the username against the online list. |
| `build` overwrites a chest / bed / door / redstone | **refused** | `PROTECTED_FIXTURE_RE` (`builder.js:524`) skips the cell and reports `protected:<name>@x,y,z`. The hole in §4 is the *claim* probe, not the fixture probe. |
| `light_up` / `craft` use up the player's torches or blocks | **safe** | both consume `this._item(...)` from the bot's own inventory only. The §3 finding is about *placement*, not consumption. |
| the rate limit silently eats actions | **by design and visible** | 600 physical acts/min; the refusal appears in the next prompt via `boundaryLine()`. |
| food table drifts from game data | **exact** | all 32 whitelisted foods match `foods.json` on points and saturation; the gap is the 10 *missing* foods (§8), not wrong numbers. |
| `threat` / `tactics` mob tables vs `entities.json` | **exact** | all 37 `HOSTILE_NAMES` and all 45 `MOBS` are real 26.3 entities; no typos, no ghost mobs. |
| `armor` tables vs `items.json` | **exact** | all 28 armor pieces recognised, copper set included. |
| `logic_test` accepts a cycle | **rejected** | topological order enforced; "cycles are unsupported" returned. |
| redstone inspectors overclaim power | **safe** | every string ends with an explicit "snapshot only / no power proven" clause; edges are `adjacent_unresolved` unless the dust geometry itself proves the link. |
| `build_shape` can be made to hang the event loop | **bounded** | parameter whitelist, 1–128 range, 250k-iteration ceiling, 32 768-block cap, all before any inventory preflight. |
| `dig_policy` accepts a block that does not exist | **rejected** | **CONFIRMED** `/tmp/probe16.js`: `add ['definitely_not_a_block']` → `ok:false`; a real block resolves through the registry. |
| `run_script` can load an arbitrary path | **safe** | `reflex_registry.js:53` strips `.js`, then `[^a-z0-9_-]` (so `../` cannot survive) and resolves inside `zincai/scripts/`. Only two scripts ship. |
| `run_script` is a hidden escape hatch for the model | **no** | only `scripts/` is reachable and the model cannot write files there — but it is undocumented in `system_prompt.txt`, so it is a capability the model will not discover (see §8 for the same pattern). |

---

## Priority

1. **§1** `dig` waives the claim + crafted-block guard — the only finding that
   destroys another player's build.
2. **§2** `mode:"all"` makes containers and machines breakable, and four strings
   say it cannot — destroys player storage.
3. **§3** eight of fourteen verbs skip the property guards: `put` into a
   stranger's chest, `sleep` in a stranger's bed, `use_block` on a stranger's
   lever.
4. **§4** `build`'s claim check samples three cells — a claim inside a large
   footprint is not seen.
5. **§5** `hold` cannot accept `ids` — the model cannot do the one thing the
   prompt tells it to do when it is being chased.
6. **§6** enum strictness discards whole answers on `goal` / `social` /
   `redstone_engineer`.
7. **§8** no `use_item`, no `place`, no slot control — the largest capability
   gap, and the one that makes "every tool is available" only half true.
8. **§9** `build_shape` origin conventions and `arch` height.
9. **§7** "semantic" naming on a keyword search.
10. **§10–§12** grid regex, dead FOV knobs, `use_block` substring matching.
11. **§13–§14** wording.

Reproduction scripts are in `.probe/` (workspace, so they persist) and
`/tmp/probe*.js`. Each is a standalone `node` script that uses the repo's own
test world. Nothing here was measured on a live server.
