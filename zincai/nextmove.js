/**
 * nextmove.js — the turn-level decision frame ("your move:").
 *
 * WHY THIS FILE EXISTS
 *
 * A recorded session (docs/INCIDENT-2026-11-17-inventory-loop.md) spent two
 * hours re-reading its own plan and inspecting an empty furnace. Nothing was
 * broken in the tool layer: every call worked. What was missing was a *question*.
 *
 * The prompt the model received each turn was made of snapshots (state,
 * inventory, goals) and one history block (`continue <goal>`), whose own
 * instruction was "trust it and do the ->/next step". When the world invalidated
 * that step — the barrel was full, so "organize inventory into barrels" could
 * never report success — the block kept saying it, the harness kept waking the
 * model on every successful inspection, and the model kept obeying. It was not
 * stuck; it had nothing else to answer.
 *
 * So this module builds, on every turn, an explicit decision frame:
 *
 *   your move: <what changed / what is blocked, in one line>
 *     - <option> — <why it is available now>            (2..4 grounded options)
 *     - ...
 *   pick one, or write a better one (goal update/replan), or say what would
 *   unblock you. Idling is a decision too — but not while an option below is
 *   executable.
 *
 * Rules this module follows:
 *   - It never invents an option. Every line is derived from live state passed
 *     in by index.js (inventory, position, nearby index, goals, fail gate) or
 *     from a fixed, small set of unconditional invitations (scope a project,
 *     go and look) that are always true.
 *   - It never says "do this" when the world already refused. A blocked step is
 *     reported as blocked, with the failure, and the model is told it may retire
 *     it. That is the missing escape hatch from the loop this file exists to fix.
 *   - It is cheap and deterministic: no model calls, no I/O, pure rendering.
 *
 * Pure local logic, unit-tested (test/16-turn-decision-frame.test.js). Nothing
 * here executes an action; it only makes the decision visible.
 */
'use strict'

const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Goal statuses that are still being worked on. */
const OPEN = new Set(['pending', 'active', 'suspended', 'resumable'])

/**
 * A step is "blocked" when its backing tool kept failing. This is the single
 * fact the old prompt never stated, and the one that ends the organise-forever
 * loop: a step the world refuses is not a step to keep starting.
 */
function blockedStep (step, { failAfter = 2 } = {}) {
  if (!step || step.done) return null
  const n = Number(step.fails) || 0
  if (n < failAfter) return null
  return { n, why: clean(step.lastError || 'failed', 90) }
}

/**
 * Ordered candidate moves. Each is `{ text, why, weight, line }`.
 * Weight is only used to rank; nothing is executed from here.
 */
function candidates (ctx = {}) {
  const {
    inv = [], food = 20, health = 20, openGoals = [], plan = null,
    blocked = [], storageFull = null, hasBuildingMaterials = false,
    survival = null, nearby = null, home = null, recentFailures = [],
    idleStreak = 0
  } = ctx
  const has = (re) => inv.find((i) => re.test(i.name) && (i.count || 0) > 0) || null
  const out = []

  const push = (text, why, weight) => {
    if (!text) return
    out.push({ text: clean(text, 150), why: clean(why, 150), weight })
  }

  // 1. Survival obligations outrank ambition, and are stated first so a model
  //    that reads only one line still reads the right one.
  if (survival) push(survival, 'needed before anything else', 100)
  if (food <= 6) push('eat or hunt food now', `food is ${Math.round(food)}/20`, 98)
  if (health <= 6) push('get safe: walls/roof, then heal in daylight', `health is ${Math.round(health)}/20`, 96)

  // 2. A blocked plan step is the single most useful thing to name: it is what
  //    the old prompt hid. Retiring it is an action, not a confession.
  if (blocked.length) {
    const b = blocked[0]
    push(
      `retire step ${b.index}${b.text ? ` "${clean(b.text, 60)}"` : ''} — ${b.why || 'it keeps failing'} — and write the concrete next step (goal update ${b.goalId ? b.goalId + ' ' : ''}drop/next)`,
      `attempted ${b.n}× and the world kept refusing`,
      94
    )
  }

  // 3. The plan's own open step, restated as something the model can *do*.
  if (plan && plan.next && !blocked.length) push(`continue: ${plan.next}`, `it is your own next note for ${plan.goalId || 'this goal'}`, 90)

  // 4. Storage that is full is a decision, not a chore to retry blind.
  if (storageFull) push(`stop storing into ${storageFull}: it is full — put it elsewhere (find storage) or keep carrying it`, 'the last put was refused: destination full', 88)

  // 5. Food reserve, tools, light: the ordinary upkeep a session forgets.
  const rawFood = inv.filter((i) => /^(beef|porkchop|chicken|mutton|rabbit|potato|cod|salmon)$/.test(i.name) && i.count > 0)
  const cooked = inv.filter((i) => /cooked_|^bread$|baked_potato/.test(i.name) && i.count > 0)
  if (!cooked.length && rawFood.length) push(`prepare_food (${rawFood.reduce((n, i) => n + i.count, 0)} raw carried, 0 cooked)`, 'raw food does not heal as much', 70)
  const lowTool = inv.find((i) => /_(pickaxe|axe|sword)$/.test(i.name) && i.durabilityLeft !== undefined && i.durabilityLeft < 15)
  if (lowTool) push(`craft a replacement ${lowTool.name}`, `${lowTool.durabilityLeft} uses left`, 72)
  const logs = inv.filter((i) => /_log$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  const torches = inv.filter((i) => i.name === 'torch').reduce((n, i) => n + i.count, 0)
  if (logs >= 3 && torches < 8 && has(/^(stick|coal|charcoal)$/)) push('craft torches', `${logs} logs carried, ${torches} torches`, 45)

  // 6. Something to build with, and no build running.
  if (hasBuildingMaterials) push('start a build with what you carry (build_shape wall/floor, or a small shelter)', 'you are holding placeable blocks', 40)

  // 7. Company.
  if (nearby && nearby.players && nearby.players.length) {
    push(`check in with ${nearby.players[0]} (say, or go_to them)`, 'they are close enough to talk to', 38)
  }

  // 8. Always-true invitations. These exist because "pick a new objective" was
  //    the only self-generated move the old prompt ever offered, and it arrived
  //    only when a goal died.
  push('pick or promote one concrete objective of your own (goal add with steps)', openGoals.length ? 'your current goal covers only part of what you want' : 'no objective is open', 30)
  push('go and look at somewhere you have not been (screenshot map/panorama, then walk)', 'the world is bigger than the base', 20)

  // A model that has idled several turns in a row is not being asked politely
  // any more: the smallest real move is named instead of a menu.
  if (idleStreak >= 3 && out.length) {
    return out.map((o, i) => (i < 2 ? { ...o, weight: o.weight + 40, why: `${o.why} — you have idled ${idleStreak} turns; do this one` } : o))
  }
  return out
}

/**
 * Render the `your move:` block.
 *
 * @param {object} ctx  see `candidates`, plus:
 *   `reason`    the event(s) that woke this turn (from brain: "look_in done: …")
 *   `stalled`   ms since the focused goal last made progress (0 when unknown)
 *   `inspectRepeat` { subject, n } when the same read tool was just used n times
 * @returns {{ text: string, options: Array<{text:string,why:string}> }}
 */
function render (ctx = {}) {
  const { reason = '', stalled = 0, max = 4 } = ctx
  const lines = []
  const opts = candidates(ctx).sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, max))

  // The headline says what this turn is ABOUT. A read-only result is news, but
  // news is not a decision — say so, otherwise the model answers the news again.
  const why = []
  if (ctx.inspectRepeat && ctx.inspectRepeat.n >= 2) {
    why.push(`you have read ${ctx.inspectRepeat.subject ? `"${clean(ctx.inspectRepeat.subject, 40)}"` : 'the same thing'} ${ctx.inspectRepeat.n}× and the answer did not change — that reads as finished, not as more to check`)
  }
  if (stalled >= 20 * 60_000) why.push(`nothing on this objective has changed in ${Math.round(stalled / 60_000)} min`)
  if (ctx.starved) why.push(`this objective has been waiting ${Math.round(ctx.starved / 60_000)} min without being worked on`)
  if (reason) why.push(clean(reason, 200))

  lines.push(`your move: ${why.length ? why.join('; ') : 'decide the next thing to do'}`)
  for (const o of opts) lines.push(`  - ${o.text}${o.why ? ` — ${o.why}` : ''}`)
  if (!opts.length) lines.push('  - nothing is available from here: say what would unblock you, or idle')
  const executable = opts.some((o) => o.weight >= 40)
  lines.push(executable
    ? '  pick one, write a better one (goal add/update), or refuse with a reason. `idle` is legitimate only when every option above is blocked or pointless.'
    : '  pick one, or idle — none of these is urgent.')
  return { text: lines.join('\n'), options: opts.map((o) => ({ text: o.text, why: o.why })) }
}

/**
 * Thematic repetition detector. `journal.loopHint()` only fires on three
 * IDENTICAL signatures, which is why `look_in furnace1` / `look_in furnace2` /
 * `find raw_iron` alternating for seven minutes produced no warning at all.
 *
 * @param {Array<{tool:string, sig?:string, text?:string}>} steps newest last
 * @returns {{ count:number, subject:string|null, tools:string[] }|null}
 */
function repetition (steps = [], { window = 8, min = 3, reads = READ_TOOLS } = {}) {
  const tail = steps.slice(-window)
  // A merged entry stands for `n` calls: `look_in furnace2 ×3` is three reads
  // even though it is one row, and the loop detector must count calls, not rows.
  const calls = (e) => Math.max(1, Number(e?.n) || 1)
  const totalCalls = tail.reduce((s, e) => s + calls(e), 0)
  if (totalCalls < min) return null
  const readsOnly = tail.filter((s) => reads.has(String(s?.tool || '')))
  // Subject = the item/block/container the read was about, from `sig` ("find raw_iron").
  const subjectOf = (s) => {
    const sig = String(s.sig || s.text || '')
    const m = /^(?:find|look_in|inspect_block|inspect_region|redstone_scan)\s+(.+)$/.exec(sig)
    return m ? m[1].trim().toLowerCase() : null
  }
  if (readsOnly.reduce((s, e) => s + calls(e), 0) >= min) {
    // Same subject read `min` times, or reads dominating the window.
    const counts = new Map()
    for (const s of readsOnly) {
      const subj = subjectOf(s)
      if (!subj) continue
      counts.set(subj, (counts.get(subj) || 0) + calls(s))
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= min) return { count: top[1], subject: top[0], tools: [...new Set(readsOnly.map((s) => s.tool))] }
    const readCalls = readsOnly.reduce((s, e) => s + calls(e), 0)
    if (readCalls >= Math.max(min, Math.ceil(totalCalls * 0.6))) {
      return { count: readCalls, subject: top ? top[0] : null, tools: [...new Set(readsOnly.map((s) => s.tool))] }
    }
  }
  return null
}

/** Tools that only look. A turn made of these changes nothing in the world. */
const READ_TOOLS = new Set([
  'look_in', 'find', 'inspect_block', 'inspect_region', 'redstone_scan',
  'redstone_component', 'redstone_engineer', 'recall', 'memory', 'goal',
  'social', 'screenshot', 'events', 'threats'
])

/** Did this turn actually change anything in the world? */
function isReadOnly (tools = []) {
  const real = tools.filter((t) => t && t !== 'idle' && t !== 'reply')
  return real.length > 0 && real.every((t) => READ_TOOLS.has(String(t)))
}

module.exports = { render, candidates, repetition, isReadOnly, blockedStep, READ_TOOLS, OPEN }
