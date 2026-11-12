/**
 * Goal-orchestration audit regression suite (GOAL_ORCHESTRATION_AUDIT.md).
 *
 * Half unit (goals.js — lifecycle, persistence, restart recovery) and half
 * whole-harness (the real zincai/index.js session: agenda + goal registry +
 * arbiter + reflexes + skills) driven by the simulated bot and scripted model
 * of test/helpers/session.js.
 *
 * Named by defect id (G1…G12, S1…S6) so the report can point at evidence.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')
const { GoalRegistry, STATUS } = require('../zincai/goals')
const { coerceAction } = require('../zincai/api_wrapper')
const { normalizeStage, generateShape } = require('../zincai/builder')
const { Vec3 } = world

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-goals-'))
const line = (prompt, label) => prompt.split('\n').find((l) => l.startsWith(label)) || ''

/**
 * Make the synthetic bot able to place blocks: `placeBlock` records the block
 * the imminent `equip` put in the hand, and `blockAt` serves it back. Without
 * this the real BuilderExecutor has nothing to build against.
 */
function buildable (bot) {
  const extra = new Map()
  const realBlockAt = bot.blockAt.bind(bot)
  bot.blockAt = (p, def) => {
    if (!p) return null
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const name = extra.get(`${x},${y},${z}`)
    if (name) return { name, type: world.registry.blocksByName[name]?.id ?? 1, position: new Vec3(x, y, z), boundingBox: 'block', diggable: true, light: 15 }
    return realBlockAt(p, def)
  }
  bot.placeBlock = async (refBlock, face) => {
    const t = refBlock.position.offset(face.x, face.y, face.z)
    extra.set(`${t.x},${t.y},${t.z}`, bot.heldItem?.name || 'dirt')
  }
  return extra
}

const openOf = (s, pred = () => true) => s.shared.goals.openGoals().filter(pred)
/** The snapshot a real turn would carry (threats, asker and the ACTIVE goal id). */
const snapNow = (it, extra = {}) => ({ ...it.buildActionPrompt(['test']), ...extra })

// ===========================================================================
// A. The registry itself: identity, lifecycle, terminal states, persistence
// ===========================================================================

test('G1: a goal has a durable identity, a full record and a legal lifecycle', () => {
  const dir = tmpDir()
  try {
    const reg = new GoalRegistry({ file: path.join(dir, 'goals.json') })
    const g = reg.add({
      description: 'build small_house (walls)',
      kind: 'build',
      origin: 'player:Gabriel',
      priority: 60,
      parentId: null,
      resources: [{ name: 'oak_planks', count: 120 }],
      preconditions: ['standing at 12,64,-3'],
      completion: 'all wall blocks present',
      failure: 'no planks left',
      interruption: 'creeper, death, restart',
      resume: 'same origin, same stage, already-placed blocks skipped',
      detail: { at: [12, 64, -3], stage: 'walls', args: { blueprint: 'small_house', stage: 'walls' } }
    })
    assert.match(g.id, /^g\d+$/)
    assert.equal(g.status, STATUS.pending)
    for (const field of ['description', 'origin', 'priority', 'parentId', 'relatedIds', 'resources', 'preconditions', 'dependencies', 'progress', 'completion', 'failure', 'interruption', 'resume', 'detail', 'createdAt', 'updatedAt', 'history']) {
      assert.ok(Object.prototype.hasOwnProperty.call(g, field), `goal has ${field}`)
    }

    assert.equal(reg.resume(g.id).ok, true)
    assert.equal(reg.get(g.id).status, STATUS.active)
    assert.equal(reg.get(g.id).attempts, 1)
    assert.equal(reg.suspend(g.id, { reason: 'paused for give', by: 'give' }).ok, true)
    assert.equal(reg.get(g.id).suspendReason, 'paused for give')
    assert.equal(reg.resume(g.id, { reason: 'after the give' }).ok, true)
    assert.equal(reg.get(g.id).resumes, 1)
    assert.equal(reg.complete(g.id, { note: 'walls done' }).ok, true)
    assert.equal(reg.get(g.id).status, STATUS.completed)
    assert.equal(reg.get(g.id).progress.percent, 100)

    // Terminal is terminal: a completed or cancelled goal cannot be revived.
    assert.equal(reg.resume(g.id).ok, false)
    assert.match(reg.resume(g.id).why, /cannot become active/)
    const c = reg.add({ description: 'explore the cave' })
    assert.equal(reg.cancel(c.id).ok, true)
    assert.equal(reg.resume(c.id).ok, false)
    assert.equal(reg.get(c.id).status, STATUS.cancelled)

    // Progress is a checkpoint, not a heartbeat.
    const p = reg.add({ description: 'gather oak_log x32', kind: 'gather', detail: { args: { item: 'oak_log', count: 32 } } })
    reg.resume(p.id)
    reg.progress(p.id, { done: 18, total: 32, note: '18/32 dug' })
    assert.equal(reg.get(p.id).progress.percent, 56)
    assert.equal(reg.get(p.id).progress.note, '18/32 dug')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('G2: a restart never leaves a goal "active"; it comes back resumable, with its checkpoint', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'goals.json')
  try {
    let reg = new GoalRegistry({ file })
    const build = reg.add({ description: 'build small_house (walls)', kind: 'build', origin: 'player:Gabriel', detail: { at: [12, 64, -3], stage: 'walls', args: { blueprint: 'small_house' } } })
    reg.resume(build.id)
    reg.progress(build.id, { done: 55, total: 120 })
    const pending = reg.add({ description: 'give Pedro bread', kind: 'give' })
    reg.cancel(reg.add({ description: 'old chore' }).id)
    assert.equal(reg.save({ force: true }), true)

    // The process dies. A new one reads the same file.
    reg = new GoalRegistry({ file })
    const after = reg.get(build.id)
    assert.equal(after.status, STATUS.resumable, 'an interrupted active goal is resumable, not active')
    assert.equal(after.needsVerify, true, 'and must be checked against the world before continuing')
    assert.match(after.resumeReason, /restarted/)
    assert.deepEqual(after.detail.at, [12, 64, -3], 'the checkpoint survived')
    assert.equal(after.progress.done, 55)
    assert.equal(reg.get(pending.id).status, STATUS.resumable)
    assert.equal(reg.list({}).filter((g) => g.status === STATUS.active).length, 0, 'nobody owns anything after a restart')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ===========================================================================
// B. Whole session: identity, interruption, resume, death, restart
// ===========================================================================

test('G3: a build interrupted mid-way resumes at the SAME origin and from the observed progress', async () => {
  const bot = simulatedBot({ items: [['dirt', 64]] })
  const placed = buildable(bot)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    await it.executeAction({ a: 'build_shape', shape: 'wall', params: { l: 8, h: 2 }, block: 'dirt', at: [3, 64, 2] }, snapNow(it, { askedBy: 'Gabriel' }))
    const goal = openOf(s).find((g) => g.kind === 'build_shape')
    assert.ok(goal, 'the build became a durable goal')
    assert.equal(goal.origin, 'player:Gabriel')
    assert.deepEqual(goal.detail.at, [3, 64, 2], 'the origin is captured when the build starts')
    assert.equal(goal.status, 'active')

    // Interrupt it while it is still half-built: a new main task replaces it.
    await sleep(900)
    assert.equal(s.shared.goals.get(goal.id).status, 'active', 'still running before the interruption')
    assert.ok(placed.size > 0, 'some of the wall is in the world already')
    await it.executeAction({ a: 'go_to', x: -14, z: 12 }, snapNow(it))
    const first = s.shared.goals.get(goal.id)
    assert.equal(first.status, 'suspended')
    assert.match(first.suspendReason, /set aside/)
    assert.deepEqual(first.detail.at, [3, 64, 2], 'still knows where its half-built wall is')
    assert.ok(first.detail.args && first.detail.args.shape === 'wall')
    assert.ok(it.agenda.shelved.some((x) => x.goalId === goal.id), 'and it is on the agenda shelf')
    assert.match(it.buildActionPrompt(['test']).text, new RegExp(`${goal.id} SUSPENDED`))

    // Resume it: the world is re-read first, then the SAME origin and plan are
    // used — no second structure at the bot's feet.
    const resume = await it.runGoalOp({ operation: 'resume', id: goal.id })
    assert.equal(resume.ok, true, resume.msg)
    assert.match(resume.msg, /\d+\/16 blocks in place/, `the checkpoint was reconciled with the world (${resume.msg})`)
    assert.deepEqual(it.agenda.main?.detail?.at, [3, 64, 2], 'resumed at the original site, not at the feet')
    assert.equal(s.shared.goals.get(goal.id).status, 'active')

    // Cancelling stops the body and is terminal.
    await it.executeAction({ a: 'goal', operation: 'cancel', id: goal.id }, snapNow(it))
    assert.equal(s.shared.goals.get(goal.id).status, 'cancelled')
    assert.equal(it.agenda.main, null, 'nothing keeps building a cancelled objective')
    assert.ok(await s.until(() => it.skills.current() === null, 3000))
  } finally { s.stop() }
})

test('G4: a death does not delete the objective — it becomes resumable and the respawn says so', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 8.5, 0.5)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    await it.executeAction({ a: 'follow', player: 'Gabriel' }, { threatIds: [], askedBy: 'Gabriel' })
    const goal = openOf(s).find((g) => g.kind === 'follow')
    assert.ok(goal)
    assert.equal(goal.status, 'active')

    bot.emit('death')
    await sleep(50)
    assert.equal(it.agenda.main, null, 'nothing is running in the new life')
    const dead = s.shared.goals.get(goal.id)
    assert.equal(dead.status, 'resumable')
    assert.match(dead.suspendReason, /died at/)
    assert.deepEqual(dead.detail.args, { player: 'Gabriel' }, 'the checkpoint is intact')

    bot.entity.position.set(0.5, 64, 0.5)
    s.spawn()
    assert.ok(await s.until(() => s.prompts.action.some((p) => new RegExp(`respawned at 0,64,0.*unfinished:.*${goal.id}`).test(p)), 4000), 'the model is told what is unfinished')
    assert.match(s.prompts.action.find((p) => /respawned at/.test(p)) || '', new RegExp(`- ${goal.id} RESUME-READY`))

    // Resuming it runs the same objective again (not a new anonymous one).
    await it.executeAction({ a: 'goal', operation: 'resume', id: goal.id }, { threatIds: [], askedBy: null })
    assert.equal(s.shared.goals.get(goal.id).status, 'active')
    assert.ok(await s.until(() => /following Gabriel/.test(it.skills.current()?.label || ''), 3000))
  } finally { s.stop() }
})

test('G5: after a restart the objectives are restored, verified against the world, and resumable', async () => {
  const dir = tmpDir()
  const at = [3, 64, 2]
  const cells = generateShape('box', { w: 4, d: 4, h: 2 }, 'dirt').map((b) => [at[0] + b.dx, at[1] + b.dy, at[2] + b.dz])
  try {
    // --- session 1: a build whose blocks all reached the world, but whose
    //     completion event never reached the goal record (process killed).
    const botA = simulatedBot({ items: [['dirt', 32]] })
    buildable(botA)
    addPlayer(botA, 2, 'Gabriel', 6.5, 0.5)
    const a = startTestSession({ bot: botA, dataDir: dir })
    a.spawn()
    await sleep(150)
    const built = a.shared.goals.add({
      description: 'build box of dirt (walls 4x4)',
      kind: 'build_shape',
      origin: 'player:Gabriel',
      detail: { at, args: { shape: 'box', params: { w: 4, d: 4, h: 2 }, block: 'dirt' } }
    })
    a.shared.goals.resume(built.id)
    // Another objective that is genuinely unfinished.
    const open = a.shared.goals.add({ description: 'follow Gabriel', kind: 'follow', origin: 'player:Gabriel', detail: { args: { player: 'Gabriel' } } })
    a.shared.goals.resume(open.id)
    a.shared.goals.save({ force: true })
    a.stop()
    assert.ok(fs.existsSync(path.join(dir, 'goals.json')), 'goals are on disk')
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'goals.json'), 'utf8'))
    assert.equal(persisted.goals.find((g) => g.id === built.id).status, 'resumable', 'the drop marked it interrupted, not finished')

    // --- session 2: same data dir, and the world really does hold the house.
    const botB = simulatedBot({ items: [['dirt', 32]] })
    const placed = buildable(botB)
    for (const [x, y, z] of cells) placed.set(`${x},${y},${z}`, 'dirt')
    addPlayer(botB, 2, 'Gabriel', 6.5, 0.5)
    const b = startTestSession({ bot: botB, dataDir: dir })
    try {
      b.spawn()
      const restored = b.shared.goals.list({})
      assert.ok(restored.length >= 2)
      const build = b.shared.goals.get(built.id)
      assert.equal(build.status, 'completed', 'the world said the house was already finished — completion was reconciled, not assumed')
      assert.match(build.progress.note, /verified in the world/)
      const follow = b.shared.goals.get(open.id)
      assert.equal(follow.status, 'resumable', 'the unfinished objective came back')
      assert.equal(follow.needsVerify, true)
      assert.ok(await b.until(() => b.prompts.action.some((p) => new RegExp(`objectives restored.*${open.id}`).test(p)), 6000), 'the model is told what survived')
    } finally { b.stop() }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('G6: a replaced long task is set aside, not forgotten (not only builds)', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 20.5, 0.5)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    await it.executeAction({ a: 'follow', player: 'Gabriel' }, snapNow(it, { askedBy: 'Gabriel' }))
    const follow = openOf(s).find((g) => g.kind === 'follow')
    await it.executeAction({ a: 'go_to', x: 3, z: 3 }, snapNow(it))
    const after = s.shared.goals.get(follow.id)
    assert.equal(after.status, 'suspended')
    assert.match(after.suspendReason, /set aside: go to 3,3 was started/)
    assert.ok(it.agenda.shelved.some((x) => x.goalId === follow.id), 'the agenda shelf shows it')
    assert.match(it.buildActionPrompt(['test']).text, new RegExp(`${follow.id} SUSPENDED follow Gabriel`))
  } finally { s.stop() }
})

test('G7: eight interruptions set a task aside instead of deleting it', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 20.5, 0.5)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    await it.executeAction({ a: 'follow', player: 'Gabriel' }, { threatIds: [], askedBy: 'Gabriel' })
    const main = it.agenda.main
    const goal = s.shared.goals.get(main.goalId)
    assert.ok(goal)
    // Simulate the 9th pause of a task that keeps being interrupted.
    main.paused = { by: 'give', at: Date.now(), until: null }
    main.resumes = 8
    it.skills.cancel('test pause')
    assert.ok(await s.until(() => it.skills.current() === null, 3000), 'the follow stopped')
    assert.equal(it.agenda.main, main, 'a paused main is kept while its side job runs')
    assert.equal(it.resumeMain('test'), false)
    assert.equal(it.agenda.main, null)
    const setAside = s.shared.goals.get(goal.id)
    assert.equal(setAside.status, 'suspended', 'still open')
    assert.match(setAside.suspendReason, /interruptions/)
    assert.ok(it.agenda.shelved.some((x) => x.goalId === goal.id))
    assert.ok(await s.until(() => s.prompts.action.some((p) => new RegExp(`${goal.id} SUSPENDED`).test(p)), 4000), 'and the model is told')
  } finally { s.stop() }
})

// ===========================================================================
// C. Verification before resuming, stale decisions, completion evidence
// ===========================================================================

test('G8: an objective whose world changed is not blindly resumed', async () => {
  const bot = simulatedBot({
    items: [['dirt', 8]],
    blocks: { '6,64,0': 'chest' },
    containers: { '6,64,0': {} } // the chest a player emptied during the interruption
  })
  addPlayer(bot, 2, 'Gabriel', 3.5, 0.5)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    s.shared.places.scan(bot, { force: true })
    const chest = s.shared.places.near(bot.entity.position, { dim: 'overworld', radius: 16 }).find((e) => e.kind === 'chest')
    assert.ok(chest, 'the chest is indexed')
    s.shared.places.noteContents(chest, {}, { dim: 'overworld', freeSlots: 27 })
    const goal = s.shared.goals.add({
      description: 'take diamond x8 from chest1',
      kind: 'take',
      origin: 'player:Gabriel',
      detail: { args: { item: 'diamond', count: 8, where: 'chest' } }
    })
    s.shared.goals.resume(goal.id)
    // A follow goal whose player left the server.
    const gone = s.shared.goals.add({ description: 'follow Ghost', kind: 'follow', detail: { args: { player: 'Ghost' } } })
    s.shared.goals.resume(gone.id)

    const take = await it.runGoalOp({ operation: 'resume', id: goal.id })
    const follow = await it.runGoalOp({ operation: 'resume', id: gone.id })
    assert.equal(take.ok, false, 'a plan built on a chest that is now empty is refused')
    assert.match(take.msg, /cannot be resumed: the container no longer holds diamond/)
    assert.equal(s.shared.goals.get(goal.id).status, 'failed')
    assert.equal(follow.ok, false)
    assert.match(follow.msg, /cannot be resumed|is not on the server/)
    assert.equal(s.shared.goals.get(gone.id).status, 'failed')
    // Nothing was started on the strength of a stale plan.
    assert.equal(it.agenda.main, null)
    // The model can see why, and replan.
    await it.executeAction({ a: 'goal', operation: 'show', id: goal.id }, snapNow(it))
    assert.match(it.results.at(-1).msg, /FAILED.*the container no longer holds diamond/)
  } finally { s.stop() }
})

test('G9: a decision generated for an old situation is refused before it acts', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 12.5, 0.5)
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()

    // (a) a new danger appeared while the model was thinking.
    const snapQuiet = { threatIds: [], askedBy: null, goalId: null }
    world.addMob(bot, 40, 'zombie', 1.5, 0.5)
    it.sense.assess()
    const danger = await it.executeAction({ a: 'gather', item: 'oak_log', count: 4 }, snapQuiet)
    assert.ok(it.results.at(-1))
    assert.equal(it.results.at(-1).ok, false)
    assert.match(it.results.at(-1).msg, /new threat.*came close while you were deciding/)
    assert.equal(it.agenda.main, null, 'quiet work never started')

    // (b) the active task changed while the model was thinking.
    delete bot.entities[40]
    it.sense.assess()
    await it.executeAction({ a: 'follow', player: 'Gabriel' }, { threatIds: [], askedBy: null })
    const staleSnap = { threatIds: [], askedBy: null, goalId: null }
    await it.executeAction({ a: 'take', item: 'bread', where: 'chest' }, staleSnap)
    assert.equal(it.results.at(-1).ok, false)
    assert.match(it.results.at(-1).msg, /active task changed while you were deciding/)
    assert.equal(it.agenda.main?.label, 'follow Gabriel', 'the running task was not replaced by the stale answer')

    // The explicit debugging opt-out disables the guard, not the controls arbiter.
    const action = { a: 'take', item: 'bread', where: 'chest' }
    s.shared.cfg.goals.staleGuard = false
    assert.equal(it.staleActionReason(action, staleSnap), null)
    s.shared.cfg.goals.staleGuard = true
    assert.match(it.staleActionReason(action, staleSnap), /active task changed/)
  } finally { s.stop() }
})

test('G10: a goal is complete only when the world says so — a returned call is not proof', async () => {
  const bot = simulatedBot({ items: [['oak_log', 16]] })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    const goal = s.shared.goals.add({
      description: 'gather oak_log x8',
      kind: 'gather',
      detail: { args: { item: 'oak_log', count: 8 } }
    })
    s.shared.goals.resume(goal.id)
    // The bot already carries all eight logs: the objective needs no work.
    const verdict = it.verifyGoalAgainstWorld(s.shared.goals.get(goal.id))
    assert.equal(verdict.state, 'complete')
    it.reconcileGoal(s.shared.goals.get(goal.id))
    assert.equal(s.shared.goals.get(goal.id).status, 'completed')
    assert.match(s.shared.goals.get(goal.id).progress.note, /carrying 16 oak_log/)

    // A partially done gather reports the real remainder, and a resume asks
    // only for what is missing (not the whole count again).
    bot.inventory.items().find((i) => i.name === 'oak_log').count = 5
    const g2 = s.shared.goals.add({ description: 'gather oak_log x8', kind: 'gather', detail: { args: { item: 'oak_log', count: 8 } } })
    s.shared.goals.resume(g2.id)
    s.shared.goals.progress(g2.id, { done: 5, total: 8 })
    const verdict2 = it.verifyGoalAgainstWorld(s.shared.goals.get(g2.id))
    assert.equal(verdict2.state, 'partial')
    assert.equal(verdict2.note, 'carrying 5 of 8 oak_log')
  } finally { s.stop() }
})

// ===========================================================================
// D. Multiple objectives, priority, starvation, and the goal tool
// ===========================================================================

test('G11: two requests from two players are both recorded; the newer one runs, the older one waits', async () => {
  const bot = simulatedBot({ items: [['bread', 5]] })
  addPlayer(bot, 2, 'Gabriel', 10.5, 0.5)
  addPlayer(bot, 3, 'Pedro', -10.5, 0.5)
  bot.toss = async (type, _m, n) => { bot.log.tossed = (bot.log.tossed || 0) + n }
  const s = startTestSession({
    bot,
    chat: (p) => (/Pedro/.test(p) ? { text: 'já vou', task: 'give Pedro 1 bread' } : { text: 'já vou', task: 'follow Gabriel' })
  })
  try {
    s.spawn()
    await sleep(200)
    const it = s.internals()
    s.say('<Gabriel> zinc me segue')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /chat request from Gabriel/.test(p)), 3000))
    await it.executeAction({ a: 'follow', player: 'Gabriel' }, { threatIds: [], askedBy: 'Gabriel' })
    s.say('<Pedro> zinc me da um pao')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /chat request from Pedro/.test(p)), 3000))
    await it.executeAction({ a: 'give', player: 'Pedro', item: 'bread', count: 1 }, { threatIds: [], askedBy: 'Pedro' })

    const open = openOf(s)
    assert.ok(open.some((g) => g.kind === 'follow' && g.origin === 'player:Gabriel'), 'Gabriel\'s objective is kept')
    assert.ok(open.some((g) => g.kind === 'give' && g.origin === 'player:Pedro'), 'Pedro\'s objective is kept')
    assert.ok(await s.until(() => (bot.log.tossed || 0) === 1, 8000))
    // The older follow resumes by itself after the side job.
    assert.ok(await s.until(() => /following Gabriel/.test(it.skills.current()?.label || ''), 5000))
    assert.equal(s.shared.goals.get(open.find((g) => g.kind === 'follow').id).status, 'active')
    assert.equal(s.shared.goals.get(open.find((g) => g.kind === 'give').id).status, 'completed')
  } finally { s.stop() }
})

test('G12: the goal tool records, lists, updates, verifies and cancels objectives — cancelled stays cancelled', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    const snap = { threatIds: [], askedBy: 'Gabriel', goalId: null }
    assert.equal(coerceAction({ tool_calls: [{ function: { name: 'goal', arguments: JSON.stringify({ operation: 'add', description: 'deliver 3 bread to Pedro' }) } }] }).a, 'goal')

    await it.executeAction({ a: 'goal', operation: 'add', description: 'deliver 3 bread to Pedro', priority: 70 }, snap)
    const declared = s.shared.goals.list({ status: 'pending' })[0]
    assert.ok(declared, 'the declared objective exists')
    assert.equal(declared.priority, 70)
    assert.match(it.results.at(-1).msg, new RegExp(`${declared.id} recorded`))
    assert.match(it.buildActionPrompt(['test']).text, new RegExp(`- ${declared.id} PENDING deliver 3 bread to Pedro`))

    // A main task started right after is linked as its step.
    addPlayer(bot, 2, 'Pedro', 4.5, 0.5)
    await it.executeAction({ a: 'go_to', player: 'Pedro' }, { threatIds: [], askedBy: 'Gabriel' })
    const step = s.shared.goals.list({ status: 'active' }).find((g) => g.kind === 'go_to')
    assert.equal(step.parentId, declared.id, 'the step is a child of the declared objective')

    await it.executeAction({ a: 'goal', operation: 'update', id: declared.id, note: 'Pedro is at the base', percent: 30 }, snap)
    assert.equal(s.shared.goals.get(declared.id).progress.percent, 30)
    assert.match(s.shared.goals.get(declared.id).detail.lastNote, /Pedro is at the base/)

    await it.executeAction({ a: 'goal', operation: 'cancel', id: declared.id }, snap)
    assert.equal(s.shared.goals.get(declared.id).status, 'cancelled')
    await it.executeAction({ a: 'goal', operation: 'resume', id: declared.id }, snap)
    assert.equal(s.shared.goals.get(declared.id).status, 'cancelled', 'a cancelled goal never reactivates')
    assert.match(it.results.at(-1).msg, /cannot be resumed/)

    // And `stop` cancels the running objective for good.
    await it.executeAction({ a: 'stop' }, snap)
    assert.equal(s.shared.goals.openGoals().length, 0, 'nothing is left open after stop')
  } finally { s.stop() }
})

test('G13: a goal that stops making progress wakes the model once — and is not failed for being slow', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 20.5, 0.5)
  const s = startTestSession({
    bot,
    cfg: (c) => { c.goals = { ...(c.goals || {}), stallMs: 60, remindMs: 60_000, tickMs: 30, starveMs: 600_000 } }
  })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    await it.executeAction({ a: 'follow', player: 'Gabriel' }, { threatIds: [], askedBy: null })
    const goal = openOf(s).find((g) => g.kind === 'follow')
    assert.ok(await s.until(() => s.prompts.action.some((p) => new RegExp(`no progress on ${goal.id}`).test(p)), 4000), 'the model is nudged')
    const after = s.shared.goals.get(goal.id)
    assert.equal(after.status, 'active', 'slow is not failed')
    assert.ok(after.stallWarnedAt, 'and it is not nudged every tick')
    await sleep(200)
    const nudges = s.prompts.action.filter((p) => new RegExp(`no progress on ${goal.id}`).test(p)).length
    assert.equal(nudges, 1, `one nudge per reminder window (got ${nudges})`)
  } finally { s.stop() }
})

// ===========================================================================
// E. Files on disk are the source of truth, not closures
// ===========================================================================

test('G14: goals survive repeated restarts without progressive degradation', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'goals.json')
  try {
    let reg = new GoalRegistry({ file })
    const g = reg.add({
      description: 'build small_house (walls)',
      kind: 'build',
      origin: 'player:Gabriel',
      priority: 55,
      detail: { at: [12, 64, -3], stage: 'walls', args: { blueprint: 'small_house', stage: 'walls' } },
      resume: 'same origin, same stage'
    })
    reg.resume(g.id)
    reg.progress(g.id, { done: 55, total: 120, note: '55/120' })
    let last = reg
    for (let i = 0; i < 5; i++) last = new GoalRegistry({ file: last.save({ force: true }) && file })
    const after = last.get(g.id)
    assert.equal(after.description, 'build small_house (walls)')
    assert.deepEqual(after.detail, { at: [12, 64, -3], stage: 'walls', args: { blueprint: 'small_house', stage: 'walls' } }, 'the checkpoint is byte-identical after five reloads')
    assert.equal(after.origin, 'player:Gabriel')
    assert.equal(after.priority, 55)
    assert.equal(after.resume, 'same origin, same stage')
    assert.equal(after.progress.done, 55)
    assert.equal(after.progress.total, 120)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('G16: verification is dimension-aware — another dimension is not evidence', async () => {
  const bot = simulatedBot({ items: [['dirt', 32]] })
  const placed = buildable(bot)
  const at = [3, 64, 2]
  const cells = generateShape('box', { w: 4, d: 4, h: 2 }, 'dirt').map((b) => [at[0] + b.dx, at[1] + b.dy, at[2] + b.dz])
  for (const [x, y, z] of cells) placed.set(`${x},${y},${z}`, 'dirt')
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    const goal = s.shared.goals.add({
      description: 'build box of dirt (overworld)',
      kind: 'build_shape',
      detail: { at, dim: 'overworld', args: { shape: 'box', params: { w: 4, d: 4, h: 2 }, block: 'dirt' } }
    })
    s.shared.goals.resume(goal.id)
    const here = it.reconcileGoal(s.shared.goals.get(goal.id))
    assert.equal(here.state, 'complete', 'in the overworld the same blocks do complete it')
    assert.equal(s.shared.goals.get(goal.id).status, 'completed')
    // The bot travels to the nether; the same x/z there is a different place.
    bot.game.dimension = 'the_nether'
    const there = it.verifyGoalAgainstWorld(s.shared.goals.get(goal.id))
    assert.equal(there.state, 'unknown')
    assert.match(there.note, /site is in the overworld and this is the the_nether/)
    const open = s.shared.goals.add({
      description: 'build a second box',
      kind: 'build_shape',
      detail: { at, dim: 'overworld', args: { shape: 'box', params: { w: 4, d: 4, h: 2 }, block: 'dirt' } }
    })
    s.shared.goals.resume(open.id)
    it.reconcileRestored()
    assert.equal(s.shared.goals.get(open.id).status, 'active', 'a far-away build is left alone, not marked done')
    assert.equal(s.shared.goals.get(goal.id).status, 'completed', 'the one verified at home stays completed')
  } finally { s.stop() }
})

test('G15: progress columns and stage labels stay consistent with the builder', () => {
  assert.equal(normalizeStage('walls'), 'walls')
  assert.equal(normalizeStage('interior_details'), normalizeStage('detailing'), 'the LLM wording and the canonical phase agree')
  const dir = tmpDir()
  try {
    const reg = new GoalRegistry({ file: path.join(dir, 'goals.json') })
    const g = reg.add({ description: 'x', kind: 'build' })
    reg.resume(g.id)
    reg.progress(g.id, { done: 3, total: 4 })
    assert.equal(reg.get(g.id).progress.percent, 75)
    reg.progress(g.id, { done: 5, total: 4 })
    assert.equal(reg.get(g.id).progress.percent, 100, 'clamped')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
