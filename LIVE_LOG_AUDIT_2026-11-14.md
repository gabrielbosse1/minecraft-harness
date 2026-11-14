# Live log audit — 2026-11-14, 13:32 → 15:44 UTC

Two hours and twelve minutes of `Qwen3.8-Flash-Next` (Qwen 3.8 27B) on the action lane.
The log's own closing line counts **245 model calls and 88 tool calls** for the session; this
excerpt shows **4 deaths** and the one chat line in it going unanswered. Net progress on goal `g25` ("small base near the grove"):
a crafting table, some planks, three dirt blocks.

> Counts, timestamps and token figures below were written up from notes on the log, not
> re-counted against it line by line. Treat them as approximate and check any you rely on.

Each finding says what the log shows, what the code did, and whether it is fixed in
this change. "Fixed" items have tests in `test/vision-compaction.test.js`.

## A. Harness faults

| # | What the log shows | Cause in the code | Status |
|---|---|---|---|
| A1 | `model retry still produced no valid tool call (truncated (length))` 20+ times; almost every one is `~38k prompt tokens, 2560 generated` and 155–349 s. From 15:07 to 15:44 not one action ran. | `amd.maxTokens` is 512 and the model reasons before it calls. 2560 = 512 + 1024 + 1024: the first answer was cut off, then asked for again **twice**, reasoning still on, each retry capped at `min(1024, 2×max)`. Three ~12.6k-token prompts for nothing. | **Fixed.** One retry, reasoning switched off, never less room than the first call. |
| A2 | Every *successful* action is `~25k prompt tokens` — never ~12.6k. | Same cause: every first answer of the session was cut off at 512 and only the retry produced the call. Each decision cost two calls. | **Fixed** by A1 plus `inference.thinking` (`auto` skips reasoning up front after two cut-offs in a row; `off` never reasons). |
| A3 | `reply: FAILED — you returned no tool call, so nothing happened` after each of those. | The feedback blamed the model for an answer the output limit cut off, and it went into the next prompt as a result. | **Fixed.** The result now says the limit was hit while reasoning. |
| A4 | `go_to: FAILED — refused: 1 new threat came close while you were deciding` → `hold {"ids":[1]}` → `hold: ok — no threat with id 1 is listed` → `go_to` refused again → `hold {"ids":[1,2,3,4,5,6,7,8]}` → refused → step limit. Three times (13:46, 14:26–14:28, 14:37). | (a) The refusal never said which threat or its id, and the id was not in the snapshot the model had. (b) The turn kept comparing against its first snapshot, so every later call was refused for the same threat. (c) `hold` on ids that match nothing returned **ok**. | **Fixed.** The refusal lists `zombie [id=77] 6m E`; once told, the next call is not refused for the same threats; `hold` on unknown ids fails and lists the real ones; `hold` sees threats that arrived mid-turn. |
| A5 | `build {grid:[["s","s","s"],…]}` → `inline — 9 blocks` → `completed 3/3 (2 newly placed, 1 already present)`. | The schema said "3D layers of palette strings"; a 3×3 array of single cells was read as 3 layers × 3 rows × 1 column — a wall — and `foundation` is its bottom layer: 3 blocks. | **Fixed.** A grid of single cells is one flat layer; the schema now shows both forms. |
| A6 | `craft oak_planks` → `x4`, nine separate model calls (60–340 s each). | `craft` had no amount. | **Fixed.** `craft {item, count}`; the result says how many are carried. |
| A7 | `g25 is active again: … this goal has no executable checkpoint; start it with the normal tools; start it with the normal tools.` (twice). | The same clause concatenated twice, on a call the model should not have needed to make. | **Fixed** (text), and see C below (the call is no longer needed). |
| A8 | Model calls with no outcome at all: 14:29:28, 14:35:01, 14:40:46, 14:46:57 (66–155 s each). | The decision was discarded because the situation changed while the model thought; that was logged at debug level only. | **Fixed** (now logged at info, with the reason). The waste itself shrinks only with faster calls (A1/A2). |
| A9 | `no keep-alive challenge for 60.1s …` / `server keep-alives resumed after 120.0s`, alternating every minute for the whole run — about half of all log lines. | This server sends a keep-alive every 120 s; the check assumed 60 s and never learned. | **Fixed.** The cadence is learned on the first resume; later gaps are reported only past 1.5× it. |
| A10 | `cannot build shape:floor (foundation): missing oak_planks x76`. | `build_shape floor` with no `params` silently picks a large default, and the message gave neither the size nor what was carried. | **Partly fixed.** The message now gives total blocks, needed and carried, and says to shrink it. The default size is unchanged. |
| A11 | Chat: `Faylan25: "what did you do so long zinc?" -> (no answer: the model's output was cut off…)` after 120 s and 1600 tokens. | Same reasoning cut-off as A1, on the chat lane. | **Fixed.** Chat replies are asked for without reasoning by default (`inference.chatThinking: off`), and a cut-off reply is retried without it. |
| A12 | `reflex: still FLEEING after 611s — they keep coming` → `died (hit by zombie)`. Also a 157 s flee from hp 10 → 5 → dead. | The escape planner picked the reachable cell with the most seconds in hand within 18 blocks and nothing else: it did not look at what kind of ground that was (a ledge, a notch between walls), at hostiles that were not chasing yet, or further than 18 blocks. Each escape ended somewhere worse than it started, with more mobs. | **Fixed (planner).** Among safe cells it now prefers level open ground, few mobs near the spot and on the way, the direction where a 48-block survey finds level empty land, and its current heading. `test/flee-ground.test.js`. Not yet run on a live server. |
| A13 | `died at 13,54,40 (fall damage)` 20 s after `CORNERED`, from a spot at y≈96. | The escape route was allowed any drop the pathfinder allows. | **Fixed.** Escape routes take no drop of more than 3 blocks. |
| A14 | `reflex flee: Faylan25 (1)` → cornered → `died (on fire)`. | Confirmed by the owner: Faylan25 did hit the bot (to test it), so treating them as an attacker was correct. The death is A12: where it ran. | **Not a fault.** |
| A15 | 13:36:53: `died` → `reflex flee: zombie, skeleton … (1m NE)` → `respawned` → `safe again — fled 4s (ran 0m)`. | The reflex fired on the mobs at the death spot between death and respawn. | **Not fixed** (harmless, but it is noise and a wasted wake). |
| A16 | Prompt is ~12.6k tokens per call. | System prompt (~3.5k) + 40 tool schemas (~5.5k) + snapshot. 84% is served from cache, so the cost is mostly in generated tokens, not here. | **Not changed.** This change adds about 900 prompt tokens (guidance + one tool). |

## B. What the model did wrong

These are decisions, not harness errors — though several were made far more likely by
the harness giving it no thread to hold on to (C).

1. **It re-planned from zero on every call.** 800–2500 output tokens to arrive at
   `craft oak_planks`, again and again. Nothing in its prompt said what it had already
   done for the goal.
2. **No plan for the goal.** `g25` still read "Craft crafting_table, then wooden pickaxe
   + axe; eat…" two hours later; it was never updated, split, or marked.
3. **It started the base at four different places** (22,139,80 → 18,138,88 → 24,132,87
   → −6,96,57) and never checked materials first: a 76-plank floor with about 20 planks.
4. **It invented threat ids** (`[1]`, `[1,2]`, `[1..8]`) instead of reading them.
5. **It never responded to danger as danger.** Four deaths, and not one
   `shelter`, `sleep`, `attack`, `eat` or wall. After each death it walked back to the
   same area with the same plan (−4,96,58 twice; both ended in death).
6. **It called `goal resume` after each death** for a goal that was simply waiting.
7. **It reasoned past its output limit** 20+ times without ever shortening its
   reasoning, although each failure was reported back to it (misleadingly — A3).
8. **It never answered the one player who spoke to it.**

## C. What was added

- **Reasoning control** — `inference.thinking` / `inference.chatThinking` (`auto|on|off`),
  sent as `chat_template_kwargs.enable_thinking`, `enable_thinking` and the `/no_think`
  prompt switch; an endpoint that rejects the fields keeps only the prompt switch.
- **Vision** — `screenshot {view: look|panorama|map, direction, at}` (`zincai/vision.js`).
  The bot is a headless protocol client, so there is no game frame to capture: the
  picture is ray-cast from the loaded chunks and encoded as PNG in-process, with no new
  dependency. It is sent as an `image_url` part after the tool result. An endpoint that
  refuses images is detected once and the tool falls back to its text summary. The last
  image of each view is saved in `<data dir>/screenshots/`.
- **Guidance on when to look** — a `SENSES` section in the system prompt: screenshot for
  orientation only; `inspect_block` / `inspect_region` / `find` for exact blocks; the
  grid for building; the redstone tools for redstone; the threat lines for mobs.
- **Compaction with goal continuation** — `zincai/journal.js`, persisted in
  `<data dir>/journal.json`. Every tool result is journaled against its goal; old steps
  are folded, without a model call, into counted facts (what worked ×n, what keeps
  failing and why, deaths). Goals take a plan: `goal {steps, done, next}`. Each turn
  shows a `continue <goal>` block built from those, a death no longer needs
  `goal resume`, and inside one multi-step turn old tool results are cut to a headline
  past `compaction.turnMaxChars`.

## Not verified

Nothing here was run against the live AMD endpoint or a Minecraft server: this
environment can reach neither. In particular it is untested whether
`Qwen3.8-Flash-Next` on Radeon Cloud (a) honours any of the three "no reasoning"
switches and (b) accepts `image_url` input. Both have fallbacks, and both are visible
in the first minutes of a run: look for `the next 10 action calls skip the reasoning
phase`, `endpoint rejected enable_thinking`, or `endpoint rejected the image input`.

## Next

1. Run it on the server and watch the first escapes: the planner change (A12) is tested
   on synthetic terrain only.
2. If reasoning cannot be switched off on this endpoint, raise `amd.maxTokens` to ~1500
   so the first answer fits, and accept the latency.
3. The reflex still only runs. Eating while running, walling in, or fighting a lone weak
   mob are not implemented.
