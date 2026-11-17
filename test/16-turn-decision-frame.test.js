'use strict'

/**
 * 16 — the turn decision frame, and the inventory loop it exists to prevent.
 *
 * The recorded session (docs/INCIDENT-2026-11-17-inventory-loop.md) is the
 * fixture: a full barrel, an unmeasurable "organize inventory" step, a stale
 * `next` note pointing at an empty furnace, and hour after hour of successful
 * read-only inspections. Every assertion below fails on the code that shipped
 * that session.
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const move = require('../zincai/nextmove')
const { WorkJournal } = require('../zincai/journal')

/** The incident's plan, verbatim from goals.json/journal.json. */
const INCIDENT_PLAN = [
  'craft iron pickaxe', // done
  'craft iron armor set', // done
  'organize inventory into barrels', // ← the step that cannot end
  'expand/finish base interior'
]
const INCIDENT_NEXT = 'furnace2 smelting 11 raw_iron (~110s) → collect 11 ingots (have 4, total 15)'

function incidentJournal () {
  let now = 1_000_000
  const j = new WorkJournal({ now: () => now, keepRecent: 10 })
  j.setPlan('g6', INCIDENT_PLAN)
  j.markDone('g6', [1, 2])
  j.setNext('g6', INCIDENT_NEXT)
  return { j, tick: (ms = 1000) => { now += ms; return now } }
}

describe('16 — a plan step that the world refuses must be able to end', () => {
  test('16a: a step is blocked after two failures of the tool that advances it, and the render stops saying "do this now"', () => {
    const { j, tick } = incidentJournal()
    assert.match(j.planLine('g6'), /3→ organize inventory into barrels/, 'starts as the current step')

    tick()
    const first = j.noteStepFailure('g6', 'put', { item: 'cobblestone', where: 'barrel1' }, 'put failed: destination full')
    assert.equal(first.step, 3)
    assert.equal(first.blocked, false, 'one failure is not a block')
    assert.match(j.planLine('g6'), /3→ organize inventory/, 'still the current step after one failure')

    tick()
    const second = j.noteStepFailure('g6', 'put', { item: 'dirt', where: 'barrel1' }, 'put failed: destination full')
    assert.equal(second.blocked, true)
    const line = j.planLine('g6')
    assert.match(line, /3⊘ organize inventory into barrels \(blocked 2×: put failed: destination full\)/)
    assert.doesNotMatch(line, /3→/, 'a blocked step must never render as "do this now" — that is the loop')
    assert.match(line, /4→ expand\/finish base interior/, 'the next real step takes the arrow instead')
  })

  test('16b: a stale `next` note is retired once the step it described is blocked', () => {
    const { j, tick } = incidentJournal()
    assert.match(j.nextStep('g6'), /furnace2 smelting/, 'the note is the next step to begin with')
    tick()
    j.noteStepFailure('g6', 'put', { item: 'cobblestone' }, 'put failed: destination full')
    tick()
    j.noteStepFailure('g6', 'put', { item: 'dirt' }, 'put failed: destination full')
    // The note was written before the blockage. It is now history, not a plan.
    assert.doesNotMatch(String(j.nextStep('g6')), /furnace2 smelting/,
      'a note from before the world changed must not survive the change')
  })

  test('16c: retiring a step is explicit, keeps the reason, and unblocks the goal', () => {
    const { j, tick } = incidentJournal()
    for (let i = 0; i < 2; i++) { tick(); j.noteStepFailure('g6', 'put', { item: 'cobblestone' }, 'put failed: destination full') }
    const retired = j.retire('g6', [3], { why: 'barrel1 is full', status: 'impossible' })
    assert.deepEqual(retired, ['organize inventory into barrels'])
    assert.match(j.planLine('g6'), /3✗ organize inventory into barrels \(impossible: barrel1 is full\)/)
    assert.equal(j.blockedSteps('g6').length, 0, 'a retired step is no longer blocking anything')
    assert.equal(j.nextStep('g6'), 'expand/finish base interior', 'the goal has somewhere to go again')
  })

  test('16d: the continuation block names the blocked step and tells the model it may retire it', () => {
    const { j, tick } = incidentJournal()
    for (let i = 0; i < 2; i++) { tick(); j.noteStepFailure('g6', 'put', { item: 'cobblestone' }, 'put failed: destination full') }
    const block = j.continuation({ goal: { id: 'g6', description: 'Set up core gear' } })
    assert.match(block, /BLOCKED: step 3 "organize inventory into barrels" failed 2×/)
    assert.match(block, /replan/, 'it must offer the escape hatch, or the model has none')
  })

  test('16e: a step written with different words keeps its attempt history (no re-inventing a dead step)', () => {
    const { j, tick } = incidentJournal()
    for (let i = 0; i < 2; i++) { tick(); j.noteStepFailure('g6', 'put', { item: 'cobblestone' }, 'put failed: destination full') }
    j.setPlan('g6', INCIDENT_PLAN) // same text re-submitted
    assert.equal(j.plans.g6.steps[2].fails, 2, 'rewriting the plan must not launder a blocked step')
  })
})

describe('16 — replan is a repair, not a reset', () => {
  test('16p: a `next` written by replan is authoritative; one written before the breakage is not', () => {
    let now = 1_000_000
    const j = new WorkJournal({ now: () => now, keepRecent: 10 })
    j.setPlan('g6', INCIDENT_PLAN)
    j.markDone('g6', [1, 2])
    j.setNext('g6', INCIDENT_NEXT)
    for (let i = 0; i < 2; i++) { now += 1000; j.noteStepFailure('g6', 'put', { item: 'cobblestone' }, 'put failed: destination full') }
    assert.doesNotMatch(String(j.nextStep('g6')), /furnace2 smelting/, 'the pre-breakage note is history')

    // replan: drop then set — the order the goal handler uses.
    now += 1000
    j.retire('g6', [3], { why: 'barrel1 is full', status: 'impossible' })
    now += 1000
    j.setNext('g6', 'build a small storage shed for the deepslate')
    assert.equal(j.nextStep('g6'), 'build a small storage shed for the deepslate',
      'a note written after the repair is the model\'s own new plan and must survive')
  })
})

describe('16 — the loop the old checks could not see', () => {
  test('16f: alternating inspections of the same subject are repetition (identical signatures are not required)', () => {
    const { j, tick } = (() => {
      let now = 1_000_000
      const jj = new WorkJournal({ now: () => now, keepRecent: 10 })
      return { j: jj, tick: () => { now += 30_000; return now } }
    })()
    // The incident's last ten minutes: furnace2, furnace1, find raw_iron, furnace2 …
    for (const [tool, what] of [['look_in', 'furnace2'], ['look_in', 'furnace1'], ['find', 'raw_iron'], ['look_in', 'furnace2'], ['look_in', 'furnace2']]) {
      tick()
      j.record({ tool, args: tool === 'look_in' ? { where: what } : { what }, ok: true, msg: `${what} at 70,92,-3: input empty, fuel empty, output empty`, goalId: 'g6' })
    }
    const hint = j.loopHint()
    assert.ok(hint, 'seven minutes of inspections must produce a loop check')
    assert.match(hint, /inspect/i)
    const streak = j.readStreak()
    assert.ok(streak.n >= 2, 'the harness must know it is repeating reads')
    assert.equal(streak.changed, false, 'and that the answer did not change')
  })

  test('16g: a read that changed IS news — the loop check must not fire on it', () => {
    let now = 1_000_000
    const j = new WorkJournal({ now: () => now, keepRecent: 10 })
    j.record({ tool: 'look_in', args: { where: 'furnace2' }, ok: true, msg: 'furnace2: input raw_iron x11', goalId: 'g6' })
    now += 1000
    j.record({ tool: 'look_in', args: { where: 'furnace2' }, ok: true, msg: 'furnace2: output iron_ingot x11', goalId: 'g6' })
    assert.equal(j.readStreak().changed, true, 'a different answer means the world moved')
  })

  test('16h: an all-read turn is recognised as changing nothing', () => {
    assert.equal(move.isReadOnly(['look_in', 'find', 'goal']), true)
    assert.equal(move.isReadOnly(['look_in', 'go_to']), false)
    assert.equal(move.isReadOnly(['idle']), false, 'idle is not a read; it is a decision')
  })
})

describe('16 — the decision frame', () => {
  const incidentCtx = () => ({
    inv: [
      { name: 'iron_pickaxe', count: 1 }, { name: 'cobbled_deepslate', count: 331 },
      { name: 'cobblestone', count: 243 }, { name: 'cooked_mutton', count: 13 },
      { name: 'iron_ingot', count: 4 }, { name: 'coal', count: 28 }
    ],
    food: 20,
    health: 20,
    openGoals: [{ id: 'g6', status: 'pending', description: 'Set up core gear' }],
    plan: { next: INCIDENT_NEXT, goalId: 'g6' },
    blocked: [{ index: 3, text: 'organize inventory into barrels', n: 2, why: 'put failed: destination full', goalId: 'g6' }],
    storageFull: 'barrel1',
    hasBuildingMaterials: true,
    nearby: { players: ['Faylan25'], containers: 14 },
    reason: 'look_in done: furnace2 at 70,92,-3: input empty, fuel empty, output empty',
    stalled: 55 * 60_000,
    inspectRepeat: { subject: 'furnace2', n: 2 }
  })

  test('16i: the frame says what is finished, what is blocked, and offers grounded moves', () => {
    const { text, options } = move.render(incidentCtx())
    assert.match(text, /^your move:/)
    assert.match(text, /read "furnace2" 2× and the answer did not change/)
    assert.match(text, /nothing on this objective has changed in 55 min/)
    assert.ok(options.length >= 3 && options.length <= 4, 'a frame is a short menu, not a plan')
    assert.match(text, /retire step 3 "organize inventory into barrels"/)
    assert.match(text, /stop storing into barrel1/)
    // Every option carries a reason: an unexplained menu is a puzzle, not a choice.
    for (const o of options) assert.ok(o.why && o.why.length > 3, `option "${o.text}" has no reason`)
  })

  test('16j: survival outranks ambition and is spoken first', () => {
    const ctx = incidentCtx()
    ctx.food = 4
    ctx.health = 20
    const first = move.render(ctx).options[0]
    assert.match(first.text, /eat|food/i)
  })

  test('16k: with nothing open and nothing wrong, the frame still asks for a choice (never empty)', () => {
    const { text } = move.render({ inv: [], food: 20, health: 20, openGoals: [] })
    assert.match(text, /your move:/)
    assert.match(text, /pick or promote one concrete objective/)
    assert.match(text, /go and look at somewhere you have not been/)
  })

  test('16l: a model that has idled three turns is told to do one thing, not offered a menu', () => {
    const ctx = incidentCtx()
    ctx.idleStreak = 3
    const { options } = move.render(ctx)
    assert.match(options[0].why, /idled 3 turns; do this one/)
  })

  test('16m: blockedStep respects the "two failures" rule and ignores done steps', () => {
    assert.equal(move.blockedStep({ text: 'x', fails: 1 }), null)
    assert.ok(move.blockedStep({ text: 'x', fails: 2 }))
    assert.equal(move.blockedStep({ text: 'x', fails: 5, done: true }), null)
  })

  test('16n: the frame never invents an option it cannot justify from the context', () => {
    // An empty world: only the two always-true invitations are allowed.
    const { options } = move.render({ inv: [], food: 20, health: 20, openGoals: [] })
    assert.deepEqual(options.map((o) => o.text).sort(), [
      'go and look at somewhere you have not been (screenshot map/panorama, then walk)',
      'pick or promote one concrete objective of your own (goal add with steps)'
    ].sort())
  })
})

describe('16 — replay of the recorded session (docs/INCIDENT-2026-11-17-inventory-loop.md)', () => {
  test('16o: the plan, the stale note and the two refusals from the real session now produce a decision, not a loop', () => {
    let now = 1_794_947_000_000
    const j = new WorkJournal({ now: () => now, keepRecent: 10 })
    // journal.json, verbatim.
    j.setPlan('g6', ['craft iron pickaxe', 'craft iron armor set', 'organize inventory into barrels', 'expand/finish base interior'])
    j.markDone('g6', [1, 2])
    j.setNext('g6', 'furnace2 smelting 11 raw_iron (~110s) → sleep to pass night → collect 11 ingots (have 4, total 15) → craft chestplate(8)+leggings(7) → organize inventory → expa')
    // journal.json recent[], verbatim: the last ten minutes of the session.
    const recent = [
      ['look_in', 'furnace2', true, 'furnace2 at 70,92,-3: input empty, fuel empty, output empty'],
      ['find', 'raw_iron', false, 'nothing known about "raw_iron" (no block within 48, no opened container holds it, no label matches)'],
      ['find', 'storage', true, 'storage: 14 containers, page 1/1'],
      ['look_in', 'furnace1', true, 'furnace1 at 66,92,-3: input empty, fuel white_wool x1, output empty'],
      ['put', 'cobblestone', false, 'put failed: destination full'],
      ['look_in', 'furnace2', true, 'furnace2 at 70,92,-3: input empty, fuel empty, output empty']
    ]
    for (const [tool, what, ok, msg] of recent) {
      now += 90_000
      j.record({ tool, args: tool === 'look_in' ? { where: what } : tool === 'put' ? { item: what, where: 'barrel1' } : { what }, ok, msg, goalId: 'g6' })
    }
    // The two `put` refusals the harness saw, applied to the plan.
    j.noteStepFailure('g6', 'put', { item: 'cobblestone', where: 'barrel1' }, 'put failed: destination full')
    j.noteStepFailure('g6', 'put', { item: 'dirt', where: 'barrel1' }, 'put failed: destination full')

    // 1. The dead step is no longer the current step.
    assert.match(j.planLine('g6'), /3⊘ organize inventory into barrels \(blocked 2×/)
    // 2. The stale 19:47 note no longer leads anywhere.
    assert.equal(j.nextStep('g6'), 'expand/finish base interior')
    // 3. The loop that shipped silently now produces a warning.
    assert.ok(j.loopHint(), 'the recorded session must produce a loop check')
    // 4. And the model is handed a way out in the block it trusts.
    const block = j.continuation({ goal: { id: 'g6', description: 'Set up core gear: pickaxe + armor, then expand base' } })
    assert.match(block, /BLOCKED: step 3/)
    assert.match(block, /goal \{operation:"replan"/)
  })
})
