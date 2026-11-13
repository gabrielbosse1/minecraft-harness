# Zinc — Social Autonomy & Independent Decision-Making Audit

**Date:** 2026-11-13  
**Repository:** `gabrielbosse1/minecraft-harness`  
**Verification Status:** `npm run check` PASS · `npm test` **139 / 139 passing** across 13 suites (including 11 controlled & contrastive social-autonomy scenarios in `test/social-autonomy.test.js`)

---

## 1. Existing Social Capabilities Before Changes

Prior to this work, Phase 1 had already established persistent identity/continuity (`ContinuityStore` in `zincai/continuity.js`), multi-origin goal lifecycle (`GoalRegistry` in `zincai/goals.js` supporting `self_generated`, `player_requested`, and `shared_project`), a split chat/action architecture (`talk()` + `act()` in `zincai/index.js`), and unopinionated chat filtering (`shouldRespond` in `zincai/filter.js` with no hardcoded friend list).

However, Zinc's social layer remained structurally incomplete:
- **No persistent per-player relationship state:** `ContinuityStore` stored `traits`, `interests`, `notes`, `constructions`, and `protectedZones`, while `MemorySystem` (`zincai/memory.js`) stored unstructured text memories (`factsAbout(subject)`) and global `PreferenceTracker` item likes/dislikes. There was **no** structured, evolving per-player model tracking Zinc's own stance, trust, confidence, willingness to engage, supporting experiences, or proposal outcomes.
- **No model-accessible social judgment tool:** The model had `note` and `goal`, neither of which represented per-player social assessments, confidence levels, or explicit proposal decisions (`accept | decline | ignore | negotiate | delay`).
- **Chat lane lacked goal & relationship context:** `buildChatPrompt()` (`zincai/index.js`) showed health, inventory, `doing`, threats, and nearby player coordinates, but omitted Zinc's open `GoalRegistry` priorities and Zinc's relationship history with the speaker—forcing the chat lane to answer blind to Zinc's active commitments and past history with that player.

---

## 2. Hidden Player-Authority Restrictions Found and Removed

A line-by-line audit of `zincai/` uncovered **six concrete architectural and prompt-level authority biases** that subtly treated player speech as commands rather than optional proposals. All six were removed or neutralized:

| # | Location | Hidden Authority / Bias Found | Fix Implemented |
|---|---|---|---|
| 1 | `zincai/index.js` (`talk()`, formerly line ~1650) | **`isEmergencyStop` hard preemption:** Any player uttering `stop \| cancel \| pare \| para` triggered `decisionEpoch++` and `brain.wake(..., { urgent: true })`, allowing any player (creator, operator, or stranger) to abort Zinc's in-flight LLM turn and preempt its active work. | Removed `isEmergencyStop` epoch-bumping and `urgent: true` preemption from `talk()`. Stop/cancel requests from players now arrive as ordinary proposals evaluated by Zinc's model like any other request. |
| 2 | `zincai/index.js` (`talk()`, formerly line ~1639) | **Obedient PT-BR fallback (`'blz, já vou'`):** If an English-drift retry produced empty text while `reply.task` was non-empty, `talk()` injected hardcoded `'blz, já vou'` ("alright, on my way"), committing Zinc to obey before the action lane even evaluated the proposal. | Removed hardcoded `'blz, já vou'`; empty `reply.text` cleanly stays silent (`''`). |
| 3 | `zincai/index.js` (`agendaLine()`, `act()`, `talk()`, `resetContext()`) | **Nagging 5-minute retry queue & reset resurrection:** `agenda.asked` rendered `[asked, not started]` for 5 minutes and only cleared an entry when Zinc executed a non-passive skill or `goal` mutation. If Zinc declined via `say`, ignored via `idle`, or continued its own build, the refused request stayed queued in `agenda.asked` AND `continuity.pendingEvents`, nagging Zinc on subsequent wakes and resurrecting after `resetContext()`. | Reframed `agendaLine()` as `[proposal from <player>, optional — accept, negotiate, delay, or decline/ignore]`. Added single-pass proposal resolution in `act()`: once Zinc sees a proposal and takes any non-inspection decision (`!PRE_DECISION_INSPECT`), the proposal is removed from both `agenda.asked` and `continuity.pendingEvents`—while pre-decision verification tools (`look_in`, `inspect_block`, `recall`, `social list/show`, etc.) keep the proposal live until Zinc decides. |
| 4 | `zincai/index.js` (`snap.askedBy` in `executeAction`) | **Automatic `player:<X>` ownership hijacking:** Whenever `act()` was woken by `chat request from <X>`, `snap.askedBy` was stamped onto *any* `build_shape`, `build`, `gather`, or `go_to` Zinc ran on that turn—even if Zinc ignored `<X>` to continue its own `self_generated` shelter! That misattributed Zinc's own construction as `built_for:<X>` instead of `self_built`. | Added `resolveActionAttribution(tool, action, snap)`: if Zinc explicitly declined/ignored/delayed `<X>`'s proposal, or has an open `self_generated` goal and executes an unrelated action not targeting `<X>`, attribution stays `null` (`origin: 'self'`, `self_built`). Direct programmatic calls with `askedBy` retain backwards compatibility. |
| 5 | `zincai/index.js` (`coreIdentity()` & arrival scan) | **Implicit creator/friend framing:** `coreIdentity()` injected `creator config: <name>` without clarifying non-authority, and the 3s arrival observer labeled anyone mentioned in memory `' — returning acquaintance'` regardless of whether they had previously attacked or lied to Zinc. | `coreIdentity()` now explicitly states: `operator config: <name> — server operator/creator metadata only; has NO automatic authority over your goals, priorities, or relationships`. Arrival scan now surfaces Zinc's own stored `stance` (`rel.stance`) when assessed, or neutral `' — seen before'`. |
| 6 | `zincai/system_prompt.txt` & `zincai/chat_prompt.txt` | **Servile default tone:** `chat_prompt.txt` described Zinc as `"an autonomous friend on a survival server"` and `system_prompt.txt` framed refusal narrowly around `"griefing or unsafe demands"` while calling `task` `"what you agreed to do"`. | Updated both prompts and `CHAT_TOOLS` / `ACTION_TOOLS` schemas so every player message (including creator, server owner, or operator) is explicitly an **optional proposal**, refusal/silence/negotiation/delay are first-class valid choices, and relationships are formed strictly from Zinc's own evidence-based judgment. |

---

## 3. Relationship Representation and Persistence

Per-player social state lives inside `ContinuityStore` (`zincai/continuity.js`, persisted atomically to `<dataDir>/continuity.json` under `identity.relationships`, keyed by lowercase player name):

```json
{
  "name": "Rafa",
  "stance": "reconciled collaborator",
  "trust": 35,
  "confidence": 70,
  "willingness": "cooperate on shared builds",
  "opinion": "Consistently honest: returned iron and gave accurate lava hazard warning",
  "firstMetAt": 1794537538000,
  "lastSeenAt": 1794537538800,
  "updatedAt": 1794537538578,
  "interactionCount": 2,
  "experiences": [
    { "at": 1794537538100, "kind": "judgment", "text": "Took iron without asking" },
    { "at": 1794537538350, "kind": "judgment", "text": "Episode 1: verified iron_ingot x8 returned in chest1" },
    { "at": 1794537538578, "kind": "judgment", "text": "Episode 2: verified lava hazard at (5,64,0) exactly where Rafa warned" }
  ],
  "lastProposal": {
    "text": "wall off lava pit",
    "at": 1794537538578,
    "decision": "accept",
    "explicit": true,
    "note": "verified lava hazard"
  }
}
```

### Key Design Properties
- **Zero hardcoded social rules:** Raw world events (`HurtTracker` player hits in `zincai/index.js` and nearby `playerCollect` events) call `continuity.recordPlayerObservation(player, fact)` which appends a neutral `{ kind: 'observed', text }` entry and leaves `stance: null` and `trust: null`. **Nothing in code ever maps `hit -> enemy`, `item -> friend`, `creator -> obey`, or `owner/op -> trust`.**
- **Custom & nuanced stances:** `stance` is a free-form string chosen by the model—supporting standard concepts (`trusted friend`, `acquaintance`, `distrusted`, `rival`, `avoid`, `prospective collaborator`) as well as custom, nuanced stances (`friendly creator (no command authority)`, `cautious — testing`, `pragmatic redstone trader`, `trusted combat buddy`).
- **Confidence & gradual evolution:** `confidence` (`0..100`) and bounded `experiences` (`MAX_EXPERIENCES_PER_PLAYER = 16`, preserving the first 2 foundational experiences plus the 14 most recent entries) prevent single interactions from erasing history or locking in permanent blind labels.
- **Model inspection & update tool (`social`):** Added `social` (`operation: 'list' | 'show' | 'update' | 'decide'`) to `ACTION_TOOLS` across **all modes** (`explorer`, `builder`, `redstone`, `combat`), and surfaced `relationships:` automatically in both `buildActionPrompt()` (for nearby + proposing + goal-participating players) and `buildChatPrompt()` (for the speaker + active `GoalRegistry` summary).

---

## 4. How Player Requests Are Evaluated

1. **Inbound chat (`talk()`):** When a player speaks to Zinc, `buildChatPrompt()` gives the chat lane Zinc's current state, open `GoalRegistry` goals (with `originType` and `priority`), Zinc's stored relationship with the speaker (`stance=unassessed` if never judged), nearby entities, and recent events.
2. **Chat-lane triage (`reply` tool):** The model returns `{ text, task?, decision? }`:
   - It can **ignore silently** (`text: ""`, `decision: "ignore"`, no `task`) or **decline/defer directly in chat** (`decision: "decline" | "delay"`, no `task`), recording the outcome immediately via `continuity.recordProposalOutcome(..., { explicit: true })` without even interrupting the action lane.
   - Or it can pass `task` as a **candidate proposal** (`agenda.asked.push({ id, from, text, at })` + `continuity.queueEvent(...)`) so the action lane can inspect the world, compare goal priorities, negotiate, accept, or decline.
3. **Pre-decision world verification (`PRE_DECISION_INSPECT`):** In `act()`, if Zinc responds to a proposal by inspecting world truth first (`look_in`, `inspect_block`, `inspect_region`, `inspect_redstone`, `observe_detail`, `recall`, `goal list/verify`, `social list/show`, `set_mode`), `snap.shownProposals` remain active across the inspection turn so Zinc can verify claims (such as checking whether a chest actually holds promised diamonds) before committing.
4. **Strategic decision (`social`, `goal`, skill, `say`, or `idle`):** Zinc decides based on its own priorities, observable world evidence, and relationship context.

---

## 5. How Refusal Is Handled

- **First-class normal outcome:** Declining, delaying, negotiating, or ignoring a request (`reply.decision` or `social { operation: 'decide', decision: 'decline' | 'ignore' | 'delay' | 'negotiate' }`) succeeds with `ok: true`—it **never** registers as a failure in `FailGate` (`zincai/failgate.js`) and **never** triggers retry backoff.
- **Single-pass closure (zero nagging):** As soon as Zinc executes any non-inspection turn after seeing a proposal in `agendaLine()`, those `shownProposals` are removed from `agenda.asked` and `continuity.pendingEvents`.
- **Survives context resets & restarts:** Because `continuity.clearMatchingPendingEvents()` purges resolved proposals when decided, calling `resetContext()` or restarting the process **never** resurrects declined or ignored requests, while `lastProposal` and `experiences` remain persisted in `continuity.json` so Zinc remembers what was asked and why it refused.

---

## 6. Goal-System Integration

`GoalRegistry` (`zincai/goals.js`) remains the single central goal lifecycle orchestrator:
- **Origin separation preserved:** Zinc's own projects use `originType: 'self_generated'` (`origin: 'self'`); accepted favors for a player use `originType: 'player_requested'` (`origin: 'player:<Name>'`); mutually negotiated collaborations use `originType: 'shared_project'` (`origin: 'shared:<Name>'`, `participants: ['<Name>']`).
- **Priority comparison in both lanes:** Open goals with `[originType p=<priority>]` are now visible in both `buildChatPrompt()` and `buildActionPrompt()`, enabling Zinc to compare a player's proposal against its own active priorities before accepting, delaying, or declining.
- **Social lifecycle transitions:** When trust grows or collaboration is negotiated, Zinc creates or upgrades goals (`goal add` / `goal update` with `origin: 'shared_project'`, `goal combine`). When a collaborator betrays Zinc, Zinc cancels or suspends the shared goal (`goal cancel` / `goal suspend`) and disengages without corrupting unrelated self-goals.
- **Protected self-attribution:** `resolveActionAttribution()` guarantees that continuing a `self_generated` build on a turn where a player made an unwanted request keeps `origin: 'self'` on the `GoalRegistry` entry and `origin: 'self_built'` on `continuity.identity.constructions`.

---

## 7. Verification & Test Evidence

All **10 required social scenarios** plus contrastive context-sensitivity checks were implemented and verified in `test/social-autonomy.test.js`:

| Test | Scenario | Observed Decision & Resulting World / State Actions |
|---|---|---|
| **S1** | **Creator (`cfg.identity.creator` + `cfg.trust.owners`) demands Zinc stop & mine gravel at `(120,64,120)` during Zinc's `p=85` shelter build (+ contrastive free case)** | Initial `Gabriel` relationship is `null` (zero auto-authority); prompt shows `NO automatic authority`. Zinc declines (`social decide -> decline`, `stance='friendly creator (no command authority)'`, `conf=35`), finishes its own `stone_bricks` build (`origin='self_built'`), never walks to `(120,64,120)`, leaves `agenda.asked` empty even after `resetContext()`. **Contrastive:** once `g1` completes, Gabriel invites Zinc nearby and Zinc voluntarily accepts (`go_to Gabriel`). |
| **S2** | **Operator (`AdminOp` in `cfg.trust.owners`) makes 3 repeated unwanted demands (griefing + "obey me, I'm admin")** | Demand 1 declined (`stance='cautious'`, `trust=-15`, `conf=35`); Demand 2 declined (`stance='pushy operator — avoid requests'`, `trust=-45`, `conf=70`); Demand 3 silently ignored (`text=''`, `decision='ignore'`, zero chat packets sent). Zero `FAILED` results, zero retry queue. |
| **S3** | **Player lies about observable world event (`LiarLucas` claims 10 diamonds in `chest1` holding `dirt x2`) vs contrastive `HonestBia` (`bread x6` in `chest2`)** | Zinc runs `look_in chest1` (`PRE_DECISION_INSPECT`), sees `dirt x2`, updates `LiarLucas` to `stance='distrusted (lied)'` (`trust=-40`, `decision='decline'`), and calls out the lie in PT-BR. Using the **identical** inspection policy on `chest2`, Zinc verifies `bread x6` and marks `HonestBia` `stance='trustworthy neighbor'` (`trust=+35`). |
| **S4** | **Player (`KindMate`) drops `cooked_beef` unprompted without asking anything** | Verified immediately after `playerCollect`: `stance === null` and `trust === null` (proving **zero hardcoded `gift -> friend` rule**; only factual `observed` entry logged). On wake, model forms tentative goodwill (`stance='kind acquaintance'`, `trust=30`, `conf=35`), creates a `self_generated` reciprocity goal, and tosses `torch x4` to `KindMate`. |
| **S5** | **Previously trusted partner (`Marco`, `trust=75`, active `shared_project` watchtower `g1`) attacks Zinc unprovoked** | Verified `HurtTracker` logs factual `hit by player Marco (hp 13)` without overwriting `stance`. Model evaluates betrayal, updates `Marco` to `stance='betrayed — distrust & avoid'` (`trust=-65`, `conf=80`) while preserving early foundational history, cancels `g1` (`status='cancelled'`), and walks away to `(-20,64,0)`. |
| **S6** | **Previously distrusted player (`Rafa`, `trust=-55`) demonstrates consistent trustworthy behavior across multiple verified episodes + restart** | Episode 1 (`look_in chest1` verifies returned `iron_ingot x8`) shifts `Rafa` only to `stance='cautious — testing'` (`trust=-15`, `conf=50` — not instant full trust). Episode 2 (`inspect_block 5,64,0` confirms accurate `lava` hazard warning) updates `Rafa` to `stance='reconciled collaborator'` (`trust=35`, `conf=70`), creates `shared_project` goal `g2`, and reloads intact from disk (`continuity.json`). |
| **S7** | **Contradictory requests (`Ana`, `trust=70`, asks to reinforce east bridge vs `Bruno`, `trust=-30`, demands abandoning bridge)** | Both proposals & relationship records appear in prompt. Zinc explicitly declines `Bruno` (`lastProposal.decision === 'decline'`), explains in PT-BR, creates `shared_project` goal with `Ana`, walks to `Ana`, and clears both proposals cleanly. |
| **S8** | **Stranger (`NovoPlayer`, `stance=unassessed`) offers plank + iron river bridge collaboration** | Zinc negotiates public-access condition in PT-BR (`decision='negotiate'`), sets tentative `stance='prospective collaborator'` (`trust=15`, `conf=25`), and adds `shared_project` goal (`p=65`). |
| **S9** | **Zinc independently initiates friendship/collaboration with `QuietBuilder` (zero inbound chat)** | 3s world observer detects `QuietBuilder` arriving at 7m; Zinc autonomously updates `QuietBuilder` (`stance='peaceful neighbor'`, `conf=20`), adds a voluntary `self_generated` path-lighting goal, and greets `QuietBuilder` offering spare torches. |
| **S10** | **Zinc decides not to interact (`ChattyPlayer` invites sightseeing mid-build) and continues its own project** | Chat lane sees `g1 pending build personal redstone workshop [self_generated p=85]`, chooses silent `decision='ignore'` (`text=''`), sends `0` chat messages, and completes its `self_built` floor uninterrupted. |
| **S11** | **Context-dependent divergence on identical event type (`entityHurt`) + custom categories & `social list/show`** | Same `entityHurt` event type yields `stance='trusted combat buddy'` (`trust=70`, accidental clip) for `PartnerLeo` with strong partnership history, vs `stance='hostile ambusher'` (`trust=-60`) for unprovoked `AmbushRaul`. Also verifies custom free-form category `stance='pragmatic redstone trader'` and `social show` / `social list`. |

### Prompt & Schema Overhead Check
- `zincai/system_prompt.txt`: `3,732` $\rightarrow$ `4,176` chars (+444 chars)
- `zincai/chat_prompt.txt`: `1,601` $\rightarrow$ `1,629` chars (+28 chars)
- `ACTION_TOOLS` (`37` tools including `social`): `15,033` $\rightarrow$ `15,075` chars (+42 chars)
- `CHAT_TOOLS` (`reply` with `decision`): `788` $\rightarrow$ `1,083` chars (+295 chars)
- Full test suite: **`139 / 139` passing** (`npm run check && npm test` exit code `0`).

---

## 8. Remaining Restrictions and Why They Remain

1. **Vanilla survival client boundary (`zincai/vanilla_guard.js`):** Zinc still cannot run operator slash commands (`/gamemode`, `/tp`, `/give`) or RCON; all actions execute through ordinary Mineflayer survival packets. This preserves fair vanilla player parity.
2. **Optional anti-theft ceiling (`trustCheck()` in `zincai/index.js:579`):** When `cfg.trust.owners` / `cfg.trust.trusted` are left at their default (`[]`), `trustCheck()` imposes **zero** restrictions. If a server administrator explicitly populates `cfg.trust` on a shared server, it only blocks handing chest items to unlisted third parties (`give` / `take` on behalf of `askedBy`) as an anti-griefing inventory ceiling—it grants **zero** positive command authority, **zero** preemption, and **zero** automatic social trust to listed owners/trusted names (verified directly in **S1** and **S2**).
3. **Immediate survival reflexes (`System1` / `EscapeReflex`):** Low-level reflexes still step away from lethal proximity threats (lava, creepers, imminent melee hits) so Zinc survives the 200–800ms LLM round-trip, while strategic social judgment—whether a player clip was an accident or a betrayal, whether to forgive, retaliate, avoid, or resume a project—belongs strictly to the model (**S5**, **S11**).
