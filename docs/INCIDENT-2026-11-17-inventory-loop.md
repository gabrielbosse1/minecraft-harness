# Incident report — the session that organised its inventory for two hours

Session `2026-11-17T18-01-44-622Z_28d26c` (Zinc, bot `Zinc`, operator `Faylan25`).

* **Start** 18:01:44Z. **Last event in the dump** 20:44:09Z. **Deaths:** 0. **HP/food at the end:** 20/20.
* 143 model requests, 119 tool executions, **37 tool failures**, 2.24 M tokens in / 82 k out.
* One declared goal, `g6 "Set up core gear: pickaxe + armor, then expand base"`, still `pending`
  at the end — it was never once `active`, never got an `attempts` counter, and its `progress`
  stayed `0%`.
* The model's last thought (20:43:17Z) is eight paragraphs of "wait, let me re-read the block" and it
  ends by calling `look_in furnace2` — for the **third** time in seven minutes, on a furnace the
  prompt had already told it three times was empty.

## The short answer

**It was not stuck in the sense of being unable to act. It was stuck in the sense that nothing ever
asked it a question that required a decision.** The harness reached a state where every turn's
"why now" was a *result of a read-only inspection*, and every goal-continuation block pointed at a
step (`organize inventory into barrels`) that (a) had no completion criterion, (b) could never
succeed because its only target container was full, and (c) was described in the system prompt as a
valid way to spend a turn. Under those three facts, inspecting a furnace and re-reading the plan is
the *locally optimal* behaviour for the model. It is not a model failure first. It is a harness
failure that produced a model failure.

The loop, precisely:

```
look_in furnace2  (empty, empty, empty)
      ↓  "look_in done" → wake → new action turn
  model re-reads the continue block, which still says
      "organize inventory into barrels"  +  "furnace2 smelting 11 raw_iron (~110s)"
      ↓  it checks furnace2 because the note mentions it
look_in furnace2  (empty, empty, empty) ...
```

Nothing in that cycle was ever contradicted by the harness. That is the bug.

---

## 1. What first caused it

Four independent causes, in the order they bit.

### 1.1 The prompt's `continue` block froze a plan that the world had already invalidated

At 19:47:01Z the model wrote the plan for `g6` and a `next` note:

```
plan: 1✓ craft iron pickaxe | 2✓ craft iron armor set | 3→ organize inventory into barrels | 4. expand/finish base interior
next: furnace2 smelting 11 raw_iron (~110s) → sleep to pass night → collect 11 ingots (have 4, total 15)
      → craft chestplate(8)+leggings(7) → organize inventory → expa
```

That plan was **never revised again**, and it was rendered into every single subsequent prompt by
`journal.continuation()` (`zincai/journal.js`), under the system prompt's instruction:

> The `continue <goal>` block is your **working memory** … **Trust it and do the `→`/`next` step.**
> Do not rebuild the plan from zero each turn.

Two things were wrong with it by 20:30Z:

* **The smelt was already done.** The model had taken the 11 ingots at 19:51 and crafted with them.
  `continue` still opens with "furnace2 smelting 11 raw_iron (~110s) → … collect 11 ingots".
* **The iron was not obtainable.** Every mining attempt after 19:18 had failed:
  `g33 mine iron x12` (failed, `could not mine iron: nearby blocks were unreachable or interrupted`),
  `g42 mine iron x4` (failed, same), plus three `gather iron` failures in the digest. The model's own
  note said "collect 11 ingots (have 4, total 15) → craft chestplate(8)+leggings(7)" — with 4 ingots
  and no working way to get more, that step is unreachable *and the block never said so*.

So the prompt handed the model a stale task list and an instruction to trust it. The model did
exactly that: for 55 minutes, most turns re-derived the same state from the same text.

**Why the model never noticed:** the continuation block is *always* present, *always* authoritative
and *never* annotated with a reason to doubt it. The only counter-evidence available was a
`still failing:` line deep inside the same block, phrased as history ("`mine_resource ×2 — could not
mine iron`"), not as a constraint on the plan. Reading it does not tell you "step 3 is impossible",
it tells you "mining was hard earlier". The harness knew the plan was dead; the prompt did not say so.

### 1.2 `organize inventory into barrels` was an unfalsifiable goal

The step has:

* no target state ("organised" is not checkable),
* no owning tool (there is no `organize` tool, no `sort` tool, no `stash` tool),
* no success signal the harness could ever emit,
* and one working implementation: `put` one item type at a time until something refuses.

The model tried `put cooked_mutton x40 into barrel1` (ok) and `put cobblestone x23 into barrel1`
(**`put failed: destination full`**). At that point the *only* remaining legal moves under this step
were to try another barrel or to give up — and there was no signal that either had happened. The
work journal recorded the failure and kept the step open. It is a step that can be *attempted*
forever and can never be *finished*.

**Why this is a harness bug and not a model bug:** the harness measures progress as "the task
reported success". A step whose completion is a *judgement* rather than a *world fact* can never be
retired by the harness, so the model is forced to keep re-declaring it, and the loop check never
fires because `organize` is not a `count`-able repeat of a tool call — it is a repeat of a *theme*.

### 1.3 Read-only tools were treated as events that deserve a wake

`INFORMATIONAL` (`zincai/index.js:940`) contains `look_in`, `find`, `inspect_*`, `screenshot`,
`recall`, `goal`… and `report()` (`index.js:1108`) says:

```js
const shouldWake = wake === null ? (!r.ok || INFORMATIONAL.has(label)) : wake
```

i.e. **every successful `look_in` wakes the model immediately.** Combined with the agent loop
(`loopMs: 8000`, `zincai/config/defaults.json`) and no `loopBusyMs` limit while idle, this makes
"inspect something, get woken, inspect something" a self-sustaining cycle at ~1 model call/minute
with no cost signal and no requirement to change state. The last hour of the session is almost
entirely this: `look_in` → wake → `find` → `look_in` → `put` → `look_in`.

That is not wrong in isolation — a `look_in` result *is* news. The bug is that it was the **only**
news. Nothing in the prompt ever asked a question the inspection could not answer.

### 1.4 The company echoed the stall, and the model complied

```
Faylan25: faz oque quiser no server, você é livre, recomendaria tentar fazer sua casa e tals,
          organizar seu inventario, e sobreviver.
Zinc:     beleza, vou organizar esse inventário lotado e pensar num cantinho pra mim.
```

The single most concrete instruction the model received in the whole session was "organizar seu
inventário". It answered "vou organizar esse inventário" and then wrote `organize inventory into
barrels` into its plan — likely as a social commitment, i.e. exactly the kind of thing the prompt
tells it to keep. At 20:38 the operator asks *"Zinc, any news, did you do anything?"* and the model
answers *"not much, still hanging out at the base honestly … haven't really expanded anything yet"*.
**It reported the stall accurately out loud and did not change it.** That is the signature of a
model that has no *decision* to make: it can only describe the state it is in, because nothing has
told it that describing is not the job.

---

## 2. Why it persisted — the specific prompt clauses

| # | Where | What it says | What it actually did |
|---|---|---|---|
| 2.1 | `system_prompt.txt` → CONTINUING, NOT RE-PLANNING | "**Trust it and do the `→`/`next` step.** Do not rebuild the plan from zero each turn" | Removed re-planning as a legitimate move, and gave no exception for *the plan being invalidated by world facts*. The model obeyed literally. |
| 2.2 | same block | "`loop check` lines mean you are repeating yourself: read them and change the call" | `loopHint()` only fires on **3 identical signatures** (`journal.js:loopHint`), and `QUIET` excludes `look_in`/`find` from the digest. So the exact loop the session was in — *alternating* `look_in furnace1` / `look_in furnace2` / `find raw_iron` — could never produce a `loop check`. The safety net existed and was blind. |
| 2.3 | `system_prompt.txt` → AGENCY | "Create, reprioritize, refine, combine, decompose, suspend, resume, or cancel objectives" | Every word here is about **objectives**. Nothing says *the plan under an objective* is disposable, or that a step which failed twice should be rewritten. So the model kept the objective and kept the step. |
| 2.4 | `system_prompt.txt` → THINKING | "Think concisely … Do not restate inventory, coordinates, tool schemas, or written plans back to yourself" | Aimed at verbosity; delivered to a model whose problem was *comprehension* of a contradictory block. The final thought is a 600-word restatement of the block — the model had no permitted way to resolve the contradiction except by re-reading it aloud. |
| 2.5 | `system_prompt.txt` → TOOLS | `look_in` is "Open container and list contents (empty = nearest)" | There is no guidance on *when inspecting is over*. Nothing says "if two inspections in a row told you the same thing, stop inspecting". |
| 2.6 | `system_prompt.txt` → SURVIVAL | "pay attention to the `survival:` line …" | `survival:` was absent the whole time (20/20 food, 13 cooked mutton). Correctly so — but it means the *only* push toward action in the whole prompt is threat/food, both of which were fine. No push toward *ambition*. |
| 2.7 | `idle` tool description | "Do not call idle to procrastinate when an active goal has a next step you can execute now." | `g6` had a next step (`organize inventory`) that *could not* be executed. So `idle` was forbidden, and the only remaining legal move was to inspect more. |
| 2.8 | `goal` tool | `done` = "number of the plan step you just finished" | Requires the model to *decide* a fuzzy step is finished, with no verification. It never did. There is no harness-side notion of a step completing from a task result, so the plan's ✓ marks are frozen forever. |

**The pattern:** the prompt is extremely good at telling the model *what it may do* and *how to
continue*, and almost silent on *how to notice that continuing is wrong*. All the anti-loop
machinery that exists (`loop check`, `fail gate`, stall detection) keys off **identical tool
signatures** and **tool failures**. The session's loop had *varying* signatures and *succeeding*
tools (`look_in` returned ok every time). Every safety net was structurally blind to it.

Concretely, the harness detected the stall exactly once — `g6`'s
`detail.starveNudgedAt` was set at 20:37:48 by `goalTick()`'s starve check (`index.js:1967`),
after ~2h19m of a `pending` top-level goal. It nudged, and the nudge text was
*"unfinished goal g6 … resume it (goal resume g6) or cancel it"* — which is not even correct advice
for a `declared` goal the model was already working on. It had no effect.

---

## 3. What was fixed

Three layers. Every claim below is covered by `test/16-turn-decision-frame.test.js`
(15 tests, including a verbatim replay of this session's plan and journal).

### 3.1 A real agent loop: every turn is a *question*, not the last answer again

New module `zincai/nextmove.js`, wired in as the `your move:` prompt block
(`index.js → buildYourMove`).

* Built on **every** turn from live state. In order of precedence it states:
  1. **what is finished** — "you have read `furnace2` 2× and the answer did not change
     — that reads as finished, not as more to check";
  2. **how long nothing has changed** — "nothing on this objective has changed in 55 min";
  3. **what is blocked and why** — "retire step 3 `organize inventory into barrels` …
     attempted 2× and the world kept refusing";
  4. **2–4 concrete moves available now**, each with the reason it is available
     ("stop storing into `barrel1`: it is full", "start a build with what you carry";
     survival needs always outrank ambition and are spoken first);
  5. **the contract**: pick one, write a better one, or refuse with a reason.
     `idle` is legitimate only when every option is blocked or pointless.
* It never invents an option; with an empty world it degrades to exactly two
  always-true invitations ("pick or promote one concrete objective", "go and look
  at somewhere you have not been"). Test `16n` pins that.
* The block cannot throw (`buildYourMove` is wrapped) and **survives compaction** —
  `your move` and `BLOCKED` were added to `PRESERVE_LINE_RE` in `context_budget.js`,
  so the question is the last thing dropped under pressure, not the first.

### 3.2 Goals whose steps can actually end

`zincai/journal.js`, `zincai/index.js` (goal handler), `zincai/api_wrapper.js` (schema).

* **Per-step attempt tracking.** `journal.noteStepFailure()` maps a failed tool to
  the plan step it was trying to advance (`put` → "organize/storage/barrel",
  `mine_resource` → "iron/mine", `build` → "house/wall/roof"…) and counts it.
  After two failures the step renders as `3⊘ organize inventory into barrels
  (blocked 2×: put failed: destination full)` — never again as `→ do this now`.
  This is the single fact the old prompt lacked.
* **Steps can be retired, in one call.** New `goal {operation:"replan", drop:[3],
  impossible:true, next:"…"}` (also works via `update`) marks a step `✗ impossible`
  or `✗ dropped` *with its reason kept*, and sets the real next move. Cheap on
  purpose: a model under budget pressure must not have to spend four calls to
  stop doing something impossible.
* **A dead step blocks its own arrow, not the goal.** `nextStep()` skips blocked
  and retired steps, so the goal falls through to the next real one.
* **Stale `next` notes expire.** A note written when the plan looked healthy is
  no longer trusted once any step of that plan is blocked. In the replay test the
  19:47 note ("furnace2 smelting 11 raw_iron …") is retired and the plan points at
  "expand/finish base interior".
* **Blocked steps are surfaced where the model already looks**, in the
  `continue` block, with the exact escape hatch:
  `BLOCKED: step 3 … Retire it (goal {operation:"replan", id:"g6", drop:[3], …})`.
* **Rewriting a plan cannot launder a dead step**: `setPlan()` keeps the attempt
  record of any step whose text is re-submitted (test `16e`).

### 3.3 The loop detectors were blind — now they are not

`journal.signature()`, `journal.loopHint()`, `journal.readStreak()`,
`nextmove.repetition()`, `index.js → report()`.

* **`where` is now part of the signature.** Before, `look_in furnace1` and
  `look_in furnace2` were the *same* call, so the second overwrote the first's
  answer and the harness could not tell one read from two. That single omission
  also meant a merged repeat destroyed the evidence that the answer had changed.
* **Merged repeats keep their answers** (`msgs[]`), so "the same read twice with
  two different answers" — a furnace finishing — is visible instead of erased.
* **Thematic repetition is detected**, not just identical signatures. The session's
  actual shape (alternating `look_in furnace1` / `look_in furnace2` / `find
  raw_iron` for seven minutes) now produces:
  `loop check: 5 of your last 8 steps were inspections about "raw_iron" and the
  world did not change — you already have that answer. Act on it, or if you
  cannot, say what blocks you and retire the step that needs it.`
* **A redundant read no longer buys a model call.** `report()` still records the
  result in `results`, but does not wake the model when the same subject has given
  the same answer twice. A read that *changed* still wakes it. This is what stops
  `look_in → wake → look_in` from eating the call budget while leaving the model
  fully informed.
* **The starvation nudge was wrong and fired on a goal being worked on.** It now
  ignores goals with recent child activity (`detail.lastTouchedAt`), and when it
  fires it names the blocked step and offers `do it / replan it / cancel it`
  instead of the inapplicable advice "resume it (goal resume g6)" — which cannot
  apply to a declared goal that was never suspended.

### 3.4 Prompt and tool descriptions

`zincai/system_prompt.txt`, `zincai/api_wrapper.js`.

* `CONTINUING, NOT RE-PLANNING` gained the exception it was missing: **"a plan the
  world has contradicted must be rewritten, and rewriting it is not 're-planning
  from zero'"**. "Trust the block" now means trust its *facts*, not its *hopes*.
* New **`WHEN A STEP CANNOT END`** section naming the four observed anti-patterns —
  organise-forever, inspect-forever, verify-forever, retry-forever — each with the
  required response, and the rule that a blocked step has exactly three valid
  answers (change approach / retire it / say what blocks you).
* `THINKING` gained the rule the model needed: *"if you catch yourself re-reading
  the same block to work out what it means, the block is wrong, not your reading.
  Two identical readings is the ceiling; the third read is the bug."*
* New **`HOW A TURN IS PUT TO YOU`** explains the `your move:` block, that its
  options are facts rather than orders, and that answering with another inspection
  of something the block just called finished is the one thing that is not a move.
* New **`AMBITION & INITIATIVE`** — the positive obligation the old prompt never
  stated: keep at least one thing of your own in motion, follow the unlock chain
  after each completed step, and treat "did you do anything?" as a signal you have
  been invisible. Idling is valid; repeating a finished check is not.
* `idle`'s description no longer forbids idling on a *blocked* next step (the old
  wording left inspection as the only legal move); `look_in` and `find` now state
  their follow-up obligation (one answer, then act).

### 3.5 Why this also addresses "no initiative"

The session had **one** self-generated top-level goal for 2h20m and spoke only
after being poked. Two structural causes:

1. **Direction required declaring a whole project.** A model that must declare a
   full objective to have any direction declares one and then clings to it. The
   frame now offers concrete *small* moves (build with what you carry, craft the
   replacement tool, plant the seeds, light the tunnel, talk to the person next to
   you) which can be adopted as-is or promoted to a goal.
2. **Nothing said ambition was part of the job.** The prompt said "you are free"
   and then spent most of its length on constraints and *don'ts*. `AMBITION &
   INITIATIVE` states the positive version, and the frame's `idle 3 turns in a
   row → "do this one"` rule makes drift visible instead of silent.

## 4. Timeline of the loop, for reference

| Time (UTC) | Event | Reading |
|---|---|---|
| 18:01 | connect | operator says "you are free to make your own decisions" |
| 18:03–18:06 | chat | operator suggests *"organizar seu inventario"*; model agrees in chat |
| 18:18:38 | `g6` declared (`pending`) | plan written 19:47, never revised |
| 18:20–19:51 | real work: mine → smelt → craft boots/pickaxe | **the productive stretch** |
| 19:18:28 | `g33 mine iron x12` starts | will fail at 20:26 |
| 19:52–20:12 | smelt/furnace checks, `g40`–`g44` | work has become inspection of past work |
| 20:18:42 | `goal update g45 done:1` → **`g45 has no open step number 1 — plan: none`** | the model tried to advance a plan that did not exist, because child goals (`g43`–`g46`) reuse plan slots |
| 20:20:56 | `find` → **`resource busy`** | tool refused while body busy |
| 20:26:21 | `g33` fails: *nearby blocks were unreachable or interrupted* | last mining attempt |
| 20:28:50 | `go_to` → **`refused: the active task changed while you were deciding`** | the model's own delayed decisions are being refused |
| 20:32:52 | arrives at base | |
| 20:34:39 | `put cooked_mutton x40 into barrel1` ok | |
| 20:36:43 → 20:43:17 | `look_in` ×3, `find` ×2, `put` fail | **the loop** |
| 20:37:48 | `goalTick` starve nudge fires for `g6` | first detection, after 2h19m; no effect |
| 20:41:55 | `put cobblestone x23` → **`destination full`** | |
| 20:44:09 | last event | `look_in furnace2` — same answer as 20:36:43 |
