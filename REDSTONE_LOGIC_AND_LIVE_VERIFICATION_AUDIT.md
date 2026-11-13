# Redstone logic audit, bug hunt and live-verification status

Phase 4 report. Everything below separates three states honestly:

- **MODELLED-VERIFIED** — a test in `test/redstone-logic-audit.test.js` pins the
  behaviour against a documented Java rule, and the engine reproduces it.
- **MODELLED-UNVERIFIED** — the engine computes something, but no test proves it
  matches Java.
- **NOT TESTED LIVE** — would need a running Minecraft server. No server, no
  `java`, and filtered egress in this environment; nothing in this report is a
  server measurement.

Test counts at the time of writing: `test/redstone-logic-audit.test.js` is
**41 tests → 36 pass, 0 fail, 5 skipped (documented gaps)**. The whole suite is
**209 pass / 0 fail / 5 skipped**; `npm run check` passes.

---

## 1. What broke, and why (the bug hunt)

Every one of these was a silent wrong answer — the engine returned a confident
result that disagreed with Java. They are listed because they are the substance
of the audit, not incidental fixes.

### 1.1 `around()` returned NaN coordinates

`DIRS` only carries `x`/`z` (horizontal directions); the six-face walk asked for
`DIRS[d].y`, got `undefined`, produced `NaN` coordinates, and every solid
neighbour was silently dropped. Consequence: **no block-power path worked at
all**. Fixed by mapping to `{x, y: 0, z}` for the horizontal faces and using
`AXIS_VEC` for up/down.

### 1.2 Repeater/comparator front test was inverted in five places

`neighbours(pos)`/`around(pos)` report `nb.dir` as the direction **from the
neighbour to the cell under consideration**. A repeater at `nb` feeds the cell
`n` exactly when `n.state.facing === nb.dir` — the code had
`OPP[facing] === nb.dir`, i.e. it believed the device's *back* was its front.
This inverted every repeater and comparator input test in the solver, in the
simulator, in `_powerSourcesAround`, and in `predictMechanism`.

### 1.3 Blocks were powering blocks

A "adjacent powered solid powers another block" path had been added to
`blockPower`. Java does not do this: **a block never powers another block**.
Removing it was required to make the weak/strong distinction testable.

### 1.4 Dust block-power was read from the wrong faces

Dust takes block power only when it **sits on** the block (face `down`) or
**points into** it (`state[d]` is `side`/`up`, and the neighbour is not a
component). The scan was reading the opposite face. The relaxation loop also
iterated graph neighbours only, which cannot see a diagonal step; it now scans
the Cartesian set of dust cells within one block.

### 1.5 Missing property read as "disconnected"

In `dustStep` and the dust block-power scan, an **absent** direction property
meant *unknown*, but the block-power path treated `undefined` as `false`. Same
data, two answers. Both now treat missing as unknown (permissive), which is what
`propsKnown` already claims.

### 1.6 A device's front did not strongly power the block in front of it

`outputsOf()` returned *component* neighbours only, so "repeater → block → dust
on top of the block" had no path. The front face is now reported as a solid
output too, which is what makes U2c true.

### 1.7 Torch inversion read its own output as its input

Floor torch at `(1,65,0)` with dust at `(1,65,1)`: `inputsOf(torch)` reports the
support block at `(1,64,0)`, and a scan of `around(support)` found the **torch
itself** as a "power source" for its support block. The torch therefore kept
itself lit forever, and every NOT gate was a latch. Self-references are now
skipped, and `torchFeeders()` (dust visibly pointing at a torch) is kept for
diagnosis only — using it as an input makes NOT gates self-oscillate.

### 1.8 `run()` order: torches were decided after the dust solve

Deciding dust first let a NOT gate see power it had itself just created. The
order is now: observers → torches (from the previous tick's wire state, with
their 2-game-tick delay) → dust solve → repeaters → comparators → apply due
changes. This is what makes the 2-tick inverter delay observable at all.

### 1.9 `mechanismPower()` skipped solid neighbours entirely

A lamp standing beside a powered block never lit. It now folds `blockPower` of
solid faces in, and it understands that an observer's **back** face sources 15.

### 1.10 Observer direction, and a change that never expired

`changes:` entries were never cleared, so an observer re-triggered on every tick
and reported an infinite pulse. Changes are now delivered for exactly one tick;
the watched cell is `facing`, and the output face is the opposite one.

### 1.11 `describe()` was missing

`CircuitModel.describe()` is used by the tool layer (`redstone_component`
analyze/diagnose/simulate) and by the perception tests, but had been lost. It is
restored, and it reports `solid.size` (the index) rather than a non-existent
`solids` field.

### 1.12 The design catalogue contained circuits that cannot work

Re-checking every gate's geometry against the physics found three broken
designs, all now rebuilt and verified:

| design | was wrong because | now |
|---|---|---|
| `not_gate` | the input was a floating dust cell; nothing ever powered the inverter block | lever on its own block feeds the wire that points into the inverter block; **verified** `in=off → lamp on`, `in=on → lamp off after 2 ticks` |
| `and_gate` | torches with no block under them, and a lamp diagonal to its torch | two input blocks (lever each) carry wall torches `¬A`, `¬B`; those light one line = `¬A ∨ ¬B`, which points into the final inverter block; **verified** truth table `0001` |
| `nand_gate` | extra inverter stage, and the output never reached the lamp | by De Morgan the `¬A ∨ ¬B` line *is* NAND; lamp sits on it; **verified** `1110` |

---

## 2. Rules the engine now implements, and the evidence

### 2.1 Signal strength and decay

- Dust next to a source reads **15**; each following block loses exactly 1; the
  line is dead where it would reach 0.
  *Verified*: `U1` — `[15, 14, 13, … 3]` on a 13-cell line inside the radius-6
  inspection box (the box limit is a real engine constraint, `MAX_RADIUS = 6`,
  so the 0-tail is checked on a shorter line and by the no-negative rule).
- A snapshot that starts mid-wire still carries its observed strength.
  *Verified*: `U1b`.

### 2.2 Strong vs weak power — the single most important rule

| Source | Strength |
|---|---|
| repeater / comparator **front** | strong |
| torch directly **beneath** the block (never the block a wall torch hangs on) | strong |
| lever / button / plate **attached** to the block | strong |
| redstone block adjacent | strong |
| dust **on top of** the block, or dust **pointing into** it | weak |

Strong power feeds fresh dust **and** activates mechanisms; weak power activates
mechanisms and repeaters but **never** feeds a fresh dust run. *Verified*: `U2a`
(dust into a block does not light dust on the far side), `U2b` (torch under a
block: dust on top = 15, dust beside = 15, side dust beyond stays 0), `U2c`
(repeater front into a block strongly powers it: dust on top 15, one step on 14),
`U2d` (weak power lights a lamp but leaves dust on top of the block at 0).

### 2.3 Vertical dust

Straight up/down stacks never conduct (*verified*: `U3a`, plus the
`vertical_dust_stack` finding). A step up needs `up` on the **lower** cell
(*verified*: `U3c`); a step down needs `up` on the **lower** cell pointing at the
higher one (*verified*: `U3b`).

### 2.4 Repeaters

`state.delay` is in **redstone ticks** (1 → 2 game ticks, 4 → 8 game ticks); the
rear is the only input; the front never leaks backwards.
*Verified*: `U4a` (first ON at tick 2), `U4b` (first ON at tick 8), `U4c`
(side power never reaches the front), `U4d` (front-side power never appears
behind, with dust as the real signal carrier).

### 2.5 Comparators

Rear-only signal input; side inputs count only when they are **strongly**
powered; 2-game-tick delay; compare keeps the rear level unless a side exceeds
it; subtract outputs `max(rear − max(sides), 0)`; the body itself is not a power
source for dust on its side.
*Verified*: `U5a`, `U5b` (real analogue rigs: each input is a dust chain fed by a
redstone block, so the cell beside the comparator reads an exact level), `U5c`
(2-tick delay), `U5d` (no side leakage, front still drives a lamp).

**Rig correction worth recording:** a dust cell's `power` property is an
*observation*, not a source. The first version of the comparator rig asserted
levels by writing `power: "10"` into isolated dust cells, and the engine
correctly reported 0. The rig now builds real chains, which is also why the
usable level range is 10..15 (radius-6 box ⇒ at most 6 cells ⇒ `16 − n`).

### 2.6 Torches

A torch is lit ⟺ its attachment block is **not powered** (total power, strong or
weak). It changes state 2 game ticks later. A lit floor torch strongly powers
the block **above** it and never the block it stands on.
*Verified*: `U6a` (powered attachment → out after 2 ticks, lamp dark),
`U6b` (exactly `110000`), `U6c` (weak power does extinguish an attached torch —
the canonical NOT gate), `U6d` (a repeater strongly powering the support switches
it off after 2 ticks, `11000000`), `U6e` (block above powered, support block not).

> Correction to an earlier belief: *weak power does turn a torch off.* A torch
> hanging on a block that a dust line points into is exactly the standard NOT
> gate. What a torch must **not** react to is the wire it feeds itself — that
> distinction is what separates an inverter from an oscillator (§3.2).

### 2.7 Observers

The observer watches `facing`; a change there (or a client-side packet naming the
observer itself) starts a **2-game-tick** pulse at the opposite face; unrelated
changes are invisible; the pulse is finite and never latches.
*Verified*: `U7a` (`1100…`), `U7b` (all zeros), `U7c` (self-named change → `110`
then off).

### 2.8 Mechanisms

Dust pointing at a piston activates it; weak power from a block does not; hoppers
lock only from an adjacent powered block (a diagonal cell does not count).
*Verified*: `U8a`, `U8b`.

---

## 3. Compositional logic

### 3.1 Gates (built from the catalogue, then driven as placed)

| gate | truth table | state |
|---|---|---|
| OR | `0111` | MODELLED-VERIFIED |
| NOT | `10` | MODELLED-VERIFIED |
| AND | `0001` | MODELLED-VERIFIED |
| NAND | `1110` | MODELLED-VERIFIED |
| XOR | `0110` expected | **GAP** (skipped test `I9d`) |
| De Morgan cross-check | `¬A ∨ ¬B` = NAND line | MODELLED-VERIFIED (the NAND design *is* this identity) |

The AND/NOT/NAND geometries were validated twice: once as a standalone world and
once through `planPlacement(...)` → `checkDesign` → simulation, so "buildable"
and "the model agrees with Java" are one property.

### 3.2 The XOR gap, stated plainly

XOR needs two torch stages that depend on each other (`¬(A∧B)` and `¬(A∨B)`
recombined). The tick model settles each stage against the *other* stage's
previous value, and for the layouts tried the two never leave the initial state.
Patching it with a special case would be pattern matching, which this engine is
explicitly not allowed to do, so it is left as a **documented limitation** with a
skipped test rather than a hidden special case.

### 3.3 Sequential logic

- **RS latch** (`I10a`): the catalogue uses a cross-coupled wall-torch pair. Set
  and hold work; the reset path does not settle in the tick model. **GAP.**
- **Clocks** (`I10b`, `R11d`): a repeater loop is not re-armed by its own output
  in the current model, so there is no oscillation to measure. A torch + dust
  feedback loop *does* oscillate in isolation, but not reliably once a lamp or a
  second stage loads it. **GAP**, and the reason is one missing mechanism (a
  loop that re-schedules itself), not a wrong truth table.
- **Latch defect rule kept:** "a latch that only works from one initial state is
  not a latch" is encoded as the set → hold → reset → hold sequence in `I10a`,
  which is exactly what fails today.

### 3.4 Held-out layouts (reasoning, not templates)

- `R11a` — a 4-way dust cross: one arm is fed by a lever, and the other three
  arms are computed. **MODELLED-VERIFIED** (centre 14, fed arm 15, other arms 13).
- `R11b` — an AND with its output inverter deleted must **not** still read
  `0001`. **MODELLED-VERIFIED**.
- `R11c` — a reversed repeater in a chain. The circuit is correctly reported as
  dead (`no_active_source`, `mechanism_unpowered`) but the specific
  `repeater_reversed` finding is not emitted. **GAP** (skipped).
- `R11e` — a lone lamp outside the wired circuit is perceived but never receives
  a fabricated edge from `traceFrom`. **MODELLED-VERIFIED**.

---

## 4. Redstone doors — engineering analysis

Doors are analysed here as mechanisms, using the rules above rather than a
template. `checkDesign` validates all catalogue designs structurally; the piston
and hidden doors are **MODELLED-UNVERIFIED** for motion, because the model has no
block-movement stage (see §5).

**Dimensions and actuation.** A 2×2 door needs the piston bodies *out of* the
doorway plane: a footprint of 4 columns of 2 blocks is the minimum, and every
piston must push into empty air. A flush/hidden door adds one block of depth per
side for the piston recess plus the wiring void; the wiring must never occupy a
cell a piston head will sweep through.

**Multi-piston synchronisation.** All pistons on one signal edge move on the
same game tick, so they are synchronised by construction. What is *not*
synchronised is the retraction of a sticky piston chain: each sticky piston pulls
one block, so a 3-deep seam needs a staggered signal (repeater delay 1, 2, 3) or
slime/honey so one piston carries the whole seam.

**Movement constraints (Java rules the engine encodes as validation only):**

- 12 blocks maximum per piston; a slime/honey assembly moves as one structure and
  is limited by the same 12-block total.
- Obsidian, bedrock, other pistons (facing into the push), block entities
  (chests, hoppers, signs, banners) and extended piston heads cannot be pushed.
- A push is refused if *any* block in the moved structure has an immovable
  blocker; the piston then does nothing at all — that is the classic silent
  door failure.
- Slime pulls on retraction, honey pulls only blocks stuck to it; neither pulls
  non-sticky blocks, which is why a 2-block-thick sticky seam needs the front
  block to be sticky.

**Directional dependency.** A piston's facing decides its push direction, and a
door's symmetry means at least two pistons must face inward. `planPlacement`
rotates every `facing` property together (a pinned test asserts the rotator maps
`east → south` for the AND design), which is what keeps a rotated door valid.

**Timing.** Piston extension is effectively instantaneous on the tick it is
powered, but the *signal* path is not: a repeater costs 2–8 game ticks each, and
a torch inverter 2. A door that opens in 4 ticks can close in 6 if the reset path
is longer — a real bug class that only a live server shows.

**Pulses and reset.** A button gives 10 redstone ticks; a lever is a level. Any
door driven from a button needs a latch or a piston memory, otherwise "press
twice quickly" leaves it half-open. The reset path must be independent of the
open path, or the door jams in whichever state it was interrupted in.

**Failure states to design for** (each is a `checkDesign`-style validation the
engine can already express): piston with no room to extend; sticky piston pulling
a non-sticky block; slime seam exceeding 12 blocks; a wiring cell inside the
sweep volume; an unpowered half of a mirrored pair; a chest anywhere in the
moved structure.

**When a design is too expensive or too large**, the alternatives in order of
cost are: (1) a flush door with the pistons recessed into the *floor* instead of
the wall, which halves the visible seam; (2) a 2-stage "curtain" door — two 1×2
panels that slide in opposite directions, needing 2 pistons instead of 4;
(3) a water/lava or sand-and-torch door when the door only needs to be one-way;
(4) a hopper-locked item door (see §4.2) when the requirement is access control
rather than a wall that disappears.

### 4.1 Hidden doors

A hidden door differs from a flush door in *how it is triggered*, not in
geometry: the trigger block must look like part of the wall (a painting, a
bookshelf, a piece of flooring), and its redstone must reach the pistons without
a visible wire. That forces one of: a torch under the trigger block, a
comparator behind it, an observer watching it, or a hopper/chest behind it. Each
has a different cost — the observer is cheapest and the most visible (its own
face is a tell), the hopper is invisible but adds an item-handling constraint.

### 4.2 Item-activated doors and combination locks

An item-activated door reads a container's fullness with a comparator; a
combination lock reads several levers/chests and gates them with AND/OR stages.
Both are **MODELLED-UNVERIFIED** for the container half, because the engine
deliberately does not invent item counts (the snapshot `limits` string says so:
*"no item counts inside containers"*). What the engine will do today is model
the comparator's *signal strength* given an observed strength, and validate the
wiring between stages.

---

## 5. What the model cannot do yet (stated, not hidden)

| Limitation | Effect | Why it is not patched |
|---|---|---|
| No self-rearming loop | clocks, repeater loops, some latches | a special case per shape would be pattern matching |
| No block-movement stage | piston doors verified structurally only | needs a world model, not a power model |
| Two-stage interdependent torches | XOR truth table | same reason as loops |
| Flat `run()` has no block-power state | a design whose feedback goes *through a block* cannot settle | `solvePower()` (the static solver) handles block power; the tick model does not yet |
| Radius 6 / 640 nodes | long wires must be measured in pieces | bounded work is deliberate (`MAX_RADIUS`) |
| Analogue range | comparator cases use levels 10–15 | radius cap on the test rigs, not an engine cap |

The last row is a test-rig artefact and is written down so nobody "fixes" a rig
by inventing a source.

---

## 6. Live-server verification: NOT TESTED

Nothing in this report is a measurement of a real Minecraft server.

- No `java`/`javac` in the sandbox; `apt-get` cannot install one.
- Egress to Mojang/PaperMC/maven returns `000` (filtered). Only
  `api.github.com` and `registry.npmjs.org` answer.
- Therefore: no server was started, no block was placed, no piston was fired.

Every claim above is either a **documented mechanic** (minecraft.wiki citations
for torch, repeater, comparator, observer and the memory/logic pages) or a
**model result pinned by a test**. The engine's own output says the same thing
in its `limits` field, which is included in every diagnostic message.

What a live server would add, and the checks that are ready to run against one:

1. Torch burnout after >8 toggles in 60 game ticks (the model does not implement
   burnout at all — **MODELLED-UNVERIFIED → known missing**).
2. Real piston push/pull with slime and honey, including the 12-block refusal.
3. Quasi-connectivity for pistons powered from a block *above* — the model
   already flags this as a special case in `predictMechanism`, but it is not
   tested.
4. Whether the client's update packets for observers match the
   "observer-named change" phrasing the model accepts (`U7c`).

---

## 7. Reproducing this audit

```bash
npm install
npm run check
node --test --test-timeout=20000 test/redstone-logic-audit.test.js   # 36 pass, 5 skipped
npm test                                                              # 209 pass, 5 skipped
```

Ad-hoc probes used while hunting the bugs live in `.zinc-test-run/probes/`.
They are scratch material, not part of the suite, and they are excluded from the
package test list on purpose.
