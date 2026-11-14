/**
 * The agent loop, talking while working, the standing dig policy, a follow
 * that survives a scare, routes that keep away from mobs, and `update`.
 *
 * Whole-session scenes run against the shipped orchestrator with a simulated
 * bot and a scripted model (test/helpers/session.js); the rest are unit tests
 * of the modules those scenes rest on.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')
const { Brain } = require('../zincai/brain')
const { Timeline, formatLine } = require('../zincai/irc')
const { DigPolicy, DEFAULT_SOFT_BLOCKS } = require('../zincai/dig_policy')
const { coerceActions, toolTurnMessages, coerceReply, createZincTools, CHAT_TOOLS } = require('../zincai/api_wrapper')
const { PredictiveThreatMap, standoffFor } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { runUpdate } = require('../zincai/updater')
const supervisor = require('../zincai/supervisor')
const { COMMANDS } = require('../zincai/control_commands')

/** The part of a chat prompt below the NEW marker: what arrived since the last answer. */
const fresh = (prompt) => prompt.slice(prompt.indexOf('----- NEW since you last answered'))
const line = (prompt, label) => prompt.split('\n').find((l) => l.startsWith(label)) || ''
/** What the body is running right now, as the agenda names it (`follow Steve`), or null. */
const doing = (s) => (s.internals().skills.current() ? (s.internals().agenda.main?.label || s.internals().skills.current().label) : null)
/** Identity of the running task: a restarted one gets a new sequence number. */
const taskSeq = (s) => s.internals().agenda.main?.seq

// ===========================================================================
// 1. The loop
// ===========================================================================

test('one answer may carry several tool calls: say AND follow in the same model call', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 8, 0)
  let asked = 0
  const s = startTestSession({
    bot,
    actions: (p) => (/come with me/.test(p) && ++asked === 1
      ? [{ a: 'say', text: 'on my way' }, { a: 'follow', player: 'Steve' }]
      : null)
  })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('Steve said: come with me')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000), 'the follow started')
    assert.deepEqual(bot.log.chat, ['on my way'], 'and the line was said — by the same answer')
    assert.equal(asked, 1, 'one model call did both')
    assert.equal(s.prompts.steps.length, 0, 'starting a body task ends the turn: no extra call to hear "started"')
    assert.equal(s.prompts.requests.find((r) => r.tools[0].function.name !== 'reply').parallel_tool_calls, true)
  } finally { s.stop() }
})

test('a turn continues on what its tools returned: find, read the result, act — without waiting for another wake', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 6, 0)
  const seen = []
  const s = startTestSession({
    bot,
    actions: (p) => {
      if (!/where is Steve/.test(p)) return null
      seen.push(p)
      if (!/tool results \(this turn\)/.test(p)) return { a: 'recall', query: 'Steve' }
      if (!/- say: /.test(p)) return [{ a: 'say', text: 'found you' }, { a: 'idle' }]
      return null
    }
  })
  try {
    s.spawn()
    await sleep(150)
    const turnsBefore = s.internals().brain.stats.actionTurns
    s.internals().brain.wake('where is Steve')
    assert.ok(await s.until(() => bot.log.chat.length > 0, 3000))
    await sleep(200)
    assert.deepEqual(bot.log.chat, ['found you'])
    assert.equal(seen.length, 2, 'two model calls, one turn')
    assert.equal(s.prompts.steps.length, 1, 'the second call was a step of the same turn')
    assert.match(s.prompts.steps[0], /tool results \(this turn\):\n {2}- recall: /, 'the tool result came straight back')
    assert.equal(s.internals().brain.stats.actionTurns - turnsBefore, 1, 'the scheduler started ONE turn')
    assert.equal(s.internals().brain.stats.extraCalls, 1, 'and the extra call was counted against the rate budget')

    // On the wire: the OpenAI tool protocol — the assistant's call, then its output.
    const followUp = s.prompts.requests.filter((r) => r.tools[0].function.name !== 'reply').at(-1)
    const roles = followUp.messages.map((m) => m.role)
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool'])
    assert.equal(followUp.messages[2].tool_calls[0].function.name, 'recall')
    assert.equal(followUp.messages[3].tool_call_id, followUp.messages[2].tool_calls[0].id)
  } finally { s.stop() }
})

test('a failed call comes back in the same turn, so the model can fix it at once', async () => {
  const bot = simulatedBot()
  const s = startTestSession({
    bot,
    actions: (p) => {
      if (!/give it a try/.test(p)) return null
      if (/equip: FAILED/.test(p)) return { a: 'say', text: 'no sword on me' }
      return { a: 'equip', item: 'diamond_sword' }
    }
  })
  try {
    s.spawn()
    await sleep(150)
    const turnsBefore = s.internals().brain.stats.actionTurns
    s.internals().brain.wake('give it a try')
    assert.ok(await s.until(() => bot.log.chat.length > 0, 3000))
    assert.deepEqual(bot.log.chat, ['no sword on me'])
    assert.equal(s.internals().brain.stats.actionTurns - turnsBefore, 1, 'the failure did not need a second turn')
  } finally { s.stop() }
})

test('the step limit bounds a turn (inference.maxStepsPerTurn)', async () => {
  const bot = simulatedBot()
  let calls = 0
  const s = startTestSession({
    bot,
    cfg: (cfg) => { cfg.inference.maxStepsPerTurn = 3 },
    actions: (p) => { if (!/look around forever/.test(p)) return null; calls++; return { a: 'recall', query: `thing ${calls}` } }
  })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('look around forever')
    await s.until(() => calls >= 3, 3000)
    assert.equal(s.internals().brain.stats.actionTurns >= 1, true)
    const firstTurnSteps = s.prompts.steps.filter((p) => /look around forever/.test(p)).length
    assert.ok(firstTurnSteps >= 2, 'the turn went on for its steps')
    // No turn ever made more than 3 calls: every 3rd call is a new turn's first.
    const turns = s.internals().brain.stats.actionTurns
    assert.ok(calls <= turns * 3, `${calls} calls in ${turns} turns`)
  } finally { s.stop() }
})

test('two body tasks in one answer: the second is not run (it would cancel the first)', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 8, 0)
  let asked = 0
  const s = startTestSession({
    bot,
    actions: (p) => (/both please/.test(p) && ++asked === 1
      ? [{ a: 'follow', player: 'Steve' }, { a: 'go_to', x: -20, y: 64, z: 0 }]
      : null)
  })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('both please')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000))
    await sleep(200)
    assert.equal(doing(s), 'follow Steve', 'the first one is still the one running')
  } finally { s.stop() }
})

test('asking for the follow that is already running does not restart it', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 8, 0)
  const s = startTestSession({ bot, actions: (p) => (/follow him/.test(p) ? { a: 'follow', player: 'Steve' } : null) })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('follow him')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000))
    const started = taskSeq(s)
    s.internals().brain.wake('follow him (again)')
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'follow' && /already follow/.test(r.msg)), 3000))
    assert.equal(taskSeq(s), started, 'the same walk, not a new one')
  } finally { s.stop() }
})

test('the scheduler starts turns by itself, backs off while the model idles, and snaps back on an event', async () => {
  const turns = []
  let now = 0
  let idle = true
  const brain = new Brain({
    minIntervalMs: 0,
    rpm: 1000,
    heartbeatMs: 800,
    loopMs: 100,
    now: () => now,
    act: async (reasons) => { turns.push({ at: now, why: reasons.join(' | ') }); return { idle } }
  })
  const step = async (ms) => { now += ms; await brain.tick(); await sleep(0) }
  await step(100)
  assert.equal(turns.length, 1, 'nothing was queued: the loop took a turn on its own')
  assert.match(turns[0].why, /autonomous check-in/)
  // Idle answers double the gap: 200, 400, 800 (the ceiling), 800…
  for (let i = 0; i < 30; i++) await step(50)
  const gaps = turns.slice(1).map((t, i) => t.at - turns[i].at)
  assert.deepEqual(gaps.slice(0, 3), [200, 400, 800], `gaps were ${gaps.join(',')}`)
  // Something happens: the event gets its turn and the loop is quick again.
  idle = false
  brain.wake('Steve joined', { external: true })
  await step(1)
  assert.match(turns.at(-1).why, /Steve joined/)
  const after = turns.length
  await step(100)
  assert.equal(turns.length, after + 1, 'the next self-started turn came after loopMs, not the backed-off gap')
  assert.ok(brain.stats.loopTurns >= 4)
})

test('the loop looks in on a busy body at loopBusyMs, not at loopMs — and never when that is unset', async () => {
  let now = 0
  const mk = (extra) => {
    const turns = []
    const brain = new Brain({ minIntervalMs: 0, rpm: 1000, heartbeatMs: 10_000, loopMs: 100, now: () => now, isBodyBusy: () => true, act: async (r) => { turns.push(r.join('|')); return { idle: true } }, ...extra })
    return { brain, turns }
  }
  const a = mk({ loopBusyMs: 1000 })
  const b = mk({})
  for (let i = 0; i < 12; i++) { now += 100; await a.brain.tick(); await b.brain.tick(); await sleep(0) }
  assert.equal(a.turns.length, 1, 'one look in 1.2 s of busy work')
  assert.match(a.turns[0], /your body is still busy/)
  assert.equal(b.turns.length, 0, 'no loopBusyMs: a busy body is left alone')
})

test('coerceActions reads every call of an answer; toolTurnMessages writes the turn back in both formats', () => {
  const message = {
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'say', arguments: '{"text":"oi"}' } },
      { id: 'b', type: 'function', function: { name: 'follow', arguments: '{"player":"Steve"}' } },
      { id: 'c', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }
    ]
  }
  const actions = coerceActions(message)
  assert.deepEqual(actions.map((x) => x.a), ['say', 'follow', 'idle'])
  assert.deepEqual(actions.map((x) => x._callId), ['a', 'b', 'c'])
  assert.equal(actions[2]._unknownTool, 'no_such_tool', 'an invented tool is reported, not silently dropped')
  assert.equal(coerceActions(message, { max: 2 }).length, 2)

  const calls = [{ id: 'a', name: 'say', args: { text: 'oi' }, result: 'sent' }, { id: 'b', name: 'follow', args: { player: 'Steve' }, result: 'started' }]
  const asTools = toolTurnMessages(calls)
  assert.deepEqual(asTools.map((m) => m.role), ['assistant', 'tool', 'tool'])
  assert.deepEqual(asTools[0].tool_calls.map((c) => c.id), ['a', 'b'])
  assert.equal(asTools[2].tool_call_id, 'b')
  const asText = toolTurnMessages(calls, { format: 'text' })
  assert.deepEqual(asText.map((m) => m.role), ['assistant', 'user'])
  assert.match(asText[1].content, /- follow: started/)
})

// ===========================================================================
// 2. Talking while working
// ===========================================================================

test('"follow me" in chat starts the follow from the chat lane — no action-lane thought in between', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 8, 0)
  const s = startTestSession({
    bot,
    chat: (p) => (/Steve says: zinc follow me/.test(p) ? { text: 'right behind you', do: 'follow', decision: 'accept' } : { text: '' })
  })
  try {
    s.spawn()
    await sleep(150)
    const thoughts = s.prompts.action.length
    s.say('<Steve> zinc follow me')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000), 'following')
    assert.deepEqual(bot.log.chat, ['right behind you'])
    await sleep(200)
    assert.equal(s.prompts.action.length, thoughts, 'the body started without a single action-lane model call')
    assert.equal(s.internals().agenda.main.askedBy, 'Steve', 'and it knows who it is doing it for')
  } finally { s.stop() }
})

test('chat is answered while the body follows, and answering does not stop the follow', async () => {
  const bot = simulatedBot()
  const steve = addPlayer(bot, 2, 'Steve', 8, 0)
  const s = startTestSession({
    bot,
    chat: (p) => {
      if (/Steve says: zinc follow me/.test(p)) return { text: 'ok', do: 'follow' }
      if (/Steve says: what are you holding/.test(p)) return { text: 'nothing right now' }
      return { text: '' }
    },
    actions: (p) => (/say something/.test(p) ? { a: 'say', text: 'still here' } : null)
  })
  try {
    s.spawn()
    await sleep(150)
    s.say('<Steve> zinc follow me')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000))
    const started = taskSeq(s)

    // The player walks off; mid-walk they ask something.
    steve.position.x = 20
    await sleep(150)
    s.say('<Steve> what are you holding')
    assert.ok(await s.until(() => bot.log.chat.includes('nothing right now'), 3000), 'answered mid-task')
    const prompt = s.prompts.chat.at(-1)
    assert.match(line(prompt, 'doing:'), /following Steve/, 'the chat lane is told what the body is busy with')

    // The action lane talks too — `say` is not a body action.
    s.internals().brain.wake('say something')
    assert.ok(await s.until(() => bot.log.chat.includes('still here'), 3000))
    await sleep(150)
    assert.equal(doing(s), 'follow Steve')
    assert.equal(taskSeq(s), started, 'one uninterrupted follow through both conversations')
  } finally { s.stop() }
})

test('reply.do "stop" stops the body from chat; reply.to picks who is answered', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 8, 0)
  addPlayer(bot, 3, 'Alex', -6, 0)
  const s = startTestSession({
    bot,
    chat: (p) => {
      if (/zinc follow me/.test(fresh(p))) return { text: 'ok', do: 'follow', to: 'Steve' }
      if (/zinc stop/.test(fresh(p))) return { text: 'stopping', do: 'stop' }
      return { text: '' }
    }
  })
  try {
    s.spawn()
    await sleep(150)
    // Alex speaks last in the window, but the model answers Steve.
    s.say('<Steve> zinc follow me')
    s.say('<Alex> lol')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000), 'followed the player it named, not the last speaker')
    s.say('<Steve> zinc stop')
    assert.ok(await s.until(() => doing(s) === null, 3000), 'stopped from chat')
  } finally { s.stop() }
})

test('the reply tool carries `to` and `do`; anything else in `do` is dropped', () => {
  const reply = CHAT_TOOLS.find((t) => t.name === 'reply')
  assert.deepEqual(reply.parameters.properties.do.enum, ['follow', 'come', 'stop'])
  const r = coerceReply({ tool_calls: [{ function: { name: 'reply', arguments: JSON.stringify({ text: 'ok', to: 'Steve', do: 'follow' }) } }] })
  assert.equal(r.to, 'Steve')
  assert.equal(r.do, 'follow')
  const bad = coerceReply({ tool_calls: [{ function: { name: 'reply', arguments: JSON.stringify({ text: 'ok', do: 'attack' }) } }] })
  assert.ok(!bad.do, 'the chat lane cannot start anything but follow / come / stop')
})

// ===========================================================================
// 3. The log: IRC style, with times
// ===========================================================================

test('Timeline: one ordered log of chat and events, each line with its clock time', () => {
  let t = Date.UTC(2026, 0, 1, 14, 2, 7)
  const tl = new Timeline({ now: () => t })
  tl.chat('Steve', 'zinc vem aqui'); t += 2000
  tl.chat('Steve', 'psst', { whisper: true }); t += 2000
  tl.said('to indo'); t += 1000
  tl.said('ok', { to: 'Steve' }); t += 3000
  tl.event('hurt: hit by a zombie'); t += 1000
  tl.event('hurt: hit by a zombie')
  const out = tl.format({ self: 'Zinc' }).split('\n').map((l) => l.trim().replace(/^\[[^\]]+\] /, ''))
  assert.deepEqual(out, ['<Steve> zinc vem aqui', '-Steve- psst', '<Zinc> to indo', '>Steve< ok', '* hurt: hit by a zombie (x2)'])
  assert.match(tl.format({ self: 'Zinc' }), /^ {2}\[\d\d:\d\d:\d\d\] <Steve>/, 'every line is stamped')
  assert.equal(tl.tail({ kinds: ['chat', 'whisper'] }).length, 2)
  assert.equal(tl.tail({ afterSeq: 2 }).length, 3, 'everything after a point — what the chat lane has not seen yet')
  assert.match(formatLine({ ts: t, kind: 'chat', who: 'A', text: 'b' }), /^\[\d\d:\d\d:\d\d\] <A> b$/)
})

test('both prompts show the IRC log: chat and events in the order they happened, with the time now', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Steve', 6, 0)
  const s = startTestSession({ bot, chat: (p) => (/Steve says: oi zinc/.test(p) ? { text: 'e ai' } : { text: '' }) })
  try {
    s.spawn()
    await sleep(150)
    s.say('<Steve> oi zinc')
    assert.ok(await s.until(() => bot.log.chat.length > 0, 3000))
    bot.health = 15
    bot.emit('entityHurt', bot.entity)
    await sleep(150)
    s.say('<Steve> what happened?')
    assert.ok(await s.until(() => s.prompts.chat.length >= 2, 3000))
    const prompt = s.prompts.chat.at(-1)
    assert.match(prompt, /^chat log \(IRC style, oldest first; it is now \[\d\d:\d\d:\d\d\]; .*you are <ZincAI>\):$/m)
    const log = prompt.slice(prompt.indexOf('chat log ('))
    const order = ['<Steve> oi zinc', '<ZincAI> e ai', '----- NEW since you last answered: 1 chat line from Steve', '<Steve> what happened?']
    let at = -1
    for (const piece of order) {
      const i = log.indexOf(piece)
      assert.ok(i > at, `"${piece}" is in the log, in order`)
      at = i
    }
    assert.match(log, /^ {2}\[\d\d:\d\d:\d\d\] \* hurt/m, 'what happened to the body is a line of the same log')
    assert.ok(log.indexOf('* hurt') < log.indexOf('<Steve> what happened?'), 'before the question about it')

    // The action lane reads the same log.
    s.internals().brain.wake('look at the log')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /look at the log/.test(p)), 3000))
    const act = s.prompts.action.find((p) => /look at the log/.test(p))
    assert.match(act, /^log \(IRC style, oldest first; it is now \[\d\d:\d\d:\d\d\]/m)
    assert.match(act, /^ {2}\[\d\d:\d\d:\d\d\] <Steve> what happened\?$/m)
    assert.match(act, /^ {2}\[\d\d:\d\d:\d\d\] <ZincAI> e ai$/m)
  } finally { s.stop() }
})

// ===========================================================================
// 4. Digging: a standing flag and a list, both the model's
// ===========================================================================

test('DigPolicy: a switch, a mode and an editable list — saved, and never the unbreakable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-dig-'))
  const file = path.join(dir, 'dig-policy.json')
  try {
    const p = new DigPolicy({ file })
    assert.equal(p.enabled, true)
    assert.equal(p.allows('dirt'), true)
    assert.equal(p.allows('oak_leaves'), true, 'wildcards: *_leaves')
    assert.equal(p.allows('stone'), false, 'stone is a decision, not a default')
    assert.equal(p.allows('oak_log'), false)
    assert.ok(DEFAULT_SOFT_BLOCKS.includes('gravel'))

    const r = p.apply({ add: ['stone', 'Deepslate'], remove: ['sand'] })
    assert.equal(r.ok, true)
    assert.equal(p.allows('stone') && p.allows('deepslate'), true)
    assert.equal(p.allows('sand'), false)
    assert.equal(p.apply({ add: ['bedrock'] }).ok, false, 'never-breakable blocks cannot be added')
    assert.equal(p.allows('bedrock'), false)

    p.apply({ mode: 'all' })
    assert.equal(p.allows('obsidian'), true)
    assert.equal(p.allows('bedrock'), false, 'not even in mode all')
    p.apply({ can_dig: false })
    assert.equal(p.allows('dirt'), false, 'the switch wins')

    // It is on disk: a restart keeps the model's rule.
    const again = new DigPolicy({ file })
    assert.equal(again.enabled, false)
    assert.equal(again.mode, 'all')
    again.apply({ can_dig: true, mode: 'list' })
    assert.equal(again.allows('stone'), true, 'the edited list survived too')
    again.apply({ reset: true })
    assert.equal(again.allows('stone'), false)
    assert.equal(again.allows('sand'), true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('dig_policy in a session: the model sets it once, it shows on every turn, applies to walks and survives a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-digsess-'))
  try {
    const bot = simulatedBot()
    const s = startTestSession({
      bot,
      dataDir,
      actions: (p) => {
        if (/tool results \(this turn\)/.test(p)) return null
        if (/open up the list/.test(p)) return { a: 'dig_policy', add: ['stone'] }
        if (/no digging now/.test(p)) return { a: 'dig_policy', can_dig: false }
        return null
      }
    })
    try {
      s.spawn()
      await sleep(150)
      const movements = () => bot.pathfinder.movements
      const stone = bot.registry.blocksByName.stone.id
      const dirt = bot.registry.blocksByName.dirt.id
      const planks = bot.registry.blocksByName.oak_planks.id
      assert.equal(movements().canDig, true, 'walking may break what the list allows, from the start')
      assert.equal(movements().blocksCantBreak.has(dirt), false)
      assert.equal(movements().blocksCantBreak.has(stone), true, 'stone is not on the starting list')
      assert.equal(movements().blocksCantBreak.has(planks), true, 'nothing crafted ever is')

      s.internals().brain.wake('open up the list')
      assert.ok(await s.until(() => movements().blocksCantBreak.has(stone) === false, 3000), 'the walk rule changed with the call')
      assert.equal(movements().blocksCantBreak.has(planks), true)
      s.internals().brain.wake('show me')
      assert.ok(await s.until(() => s.prompts.action.some((p) => /show me/.test(p)), 3000))
      assert.match(line(s.prompts.action.find((p) => /show me/.test(p)), 'digging:'), /walking may break only: .*stone/, 'and the model is shown its own rule every turn')

      s.internals().brain.wake('no digging now')
      assert.ok(await s.until(() => movements().canDig === false, 3000), 'can_dig off: a walk breaks nothing')
      s.internals().brain.wake('show me again')
      assert.ok(await s.until(() => s.prompts.action.some((p) => /show me again/.test(p)), 3000))
      assert.match(line(s.prompts.action.find((p) => /show me again/.test(p)), 'digging:'), /never breaks blocks \(can_dig OFF\)/)
    } finally { s.stop() }

    // A new process, the same data directory: the flag is still what the model set.
    const bot2 = simulatedBot()
    const s2 = startTestSession({ bot: bot2, dataDir })
    try {
      s2.spawn()
      await sleep(150)
      assert.equal(bot2.pathfinder.movements.canDig, false, 'still off after a restart')
      assert.equal(s2.shared.digPolicy.allows('stone'), false, 'off is off')
      s2.shared.digPolicy.apply({ can_dig: true })
      assert.equal(s2.shared.digPolicy.allows('stone'), true, 'and the list it edited is still there')
    } finally { s2.stop() }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})

test('the operator switch still wins: actions.allowDig off means a walk breaks nothing, whatever the policy says', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    assert.equal(bot.pathfinder.movements.canDig, true)
    s.shared.host.config.set('actions.allowDig', false, { by: 'test' })
    s.internals().wrapper.refreshDigPolicy()
    assert.equal(bot.pathfinder.movements.canDig, false)
    s.internals().brain.wake('look at the rule')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /look at the rule/.test(p)), 3000))
    assert.match(line(s.prompts.action.find((p) => /look at the rule/.test(p)), 'digging:'), /OFF by the operator/)
  } finally { s.stop() }
})

test('the dig_policy tool is in the action set and described as a standing rule', () => {
  const tool = createZincTools().find((t) => t.function.name === 'dig_policy')
  assert.ok(tool)
  assert.deepEqual(Object.keys(tool.function.parameters.properties).sort(), ['add', 'can_dig', 'mode', 'remove', 'reset'])
  assert.deepEqual(tool.function.parameters.properties.mode.enum, ['list', 'all'])
  assert.match(tool.function.description, /standing rule/i)
  assert.match(tool.function.description, /persists/i)
})

// ===========================================================================
// 5. Follow survives a scare
// ===========================================================================

test('a zombie during a follow: the body dodges, and the SAME follow carries on — nobody has to ask again', async () => {
  const bot = simulatedBot()
  const steve = addPlayer(bot, 2, 'Steve', 6, 0)
  const s = startTestSession({ bot, actions: (p) => (/follow Steve now/.test(p) ? { a: 'follow', player: 'Steve' } : null) })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('follow Steve now')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000))
    const started = taskSeq(s)
    const callsBefore = s.prompts.action.length

    // A zombie walks right up to the bot.
    const zombie = world.addMob(bot, 7, 'zombie', bot.entity.position.x + 0.5, bot.entity.position.z + 3.5)
    assert.ok(await s.until(() => s.internals().system1.fleeing, 3000), 'the reflex reacted')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /dodging — "following Steve" is only paused and resumes by itself/.test(p)), 3000),
      'the model is told the follow is paused, not over')
    assert.equal(s.internals().agenda.main?.label, 'follow Steve', 'the follow is still the task')
    assert.equal(s.internals().skills.current()?.paused, true, 'paused while the body dodges')
    assert.equal(taskSeq(s), started)
    const during = s.prompts.action.find((p) => /dodging — "following Steve"/.test(p))
    assert.match(line(during, 'doing:'), /^doing: following Steve \(\d+s\) — paused while the body flees, resumes by itself after/)
    assert.match(line(during, '  reflex:'), /DODGING zombie .* goes straight back to "following Steve"/)
    assert.match(line(during, '  decide:'), /idle = let the body dodge and go back to "following Steve" by itself/)
    // A model that asks for the follow again anyway does not tear it down.
    await s.internals().executeAction({ a: 'follow', player: 'Steve' }, { threatIds: [7], reasons: [], shownActionIds: [], shownProposals: [], goalId: s.internals().agenda.main.goalId })
    assert.equal(taskSeq(s), started, 'asked again mid-dodge: still the same follow')
    s.internals().results.length = 0

    // The zombie is gone (killed by someone, burnt, out of range).
    delete bot.entities[7]
    bot.emit('entityGone', zombie)
    assert.ok(await s.until(() => !s.internals().system1.fleeing, 4000), 'the dodge ended')
    steve.position.x += 12
    assert.ok(await s.until(() => doing(s) === 'follow Steve' && s.internals().skills.current().paused === false && bot.pathfinder.goal?.constructor?.name === 'GoalFollow', 3000), 'following again')
    assert.equal(taskSeq(s), started, 'the same follow — it was never cancelled')
    await sleep(300)
    const reasked = s.prompts.action.slice(callsBefore).filter((p) => /follow Steve now/.test(p)).length
    assert.equal(reasked, 0, 'no model call was needed to start it again')
    assert.ok(!s.internals().results.some((r) => r.label === 'follow'), 'and the follow never reported an end')
  } finally { s.stop() }
})

test('follow does not end because the player went out of sight for a moment', async () => {
  const bot = simulatedBot()
  const steve = addPlayer(bot, 2, 'Steve', 6, 0)
  const s = startTestSession({ bot, actions: (p) => (/go with Steve/.test(p) ? { a: 'follow', player: 'Steve' } : null) })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('go with Steve')
    assert.ok(await s.until(() => doing(s) === 'follow Steve', 3000))
    // Out of entity range: the server stops sending the entity.
    delete bot.entities[2]
    bot.players.Steve.entity = null
    await sleep(700)
    assert.equal(doing(s), 'follow Steve', 'still following (it walks to where he was last seen)')
    // …and he is back.
    steve.position.x = 14
    bot.entities[2] = steve
    bot.players.Steve.entity = steve
    await sleep(400)
    assert.equal(doing(s), 'follow Steve')
    assert.ok(!s.internals().results.some((r) => r.label === 'follow'), 'no "follow ended" in between')

    // Leaving the game is different: that ends it, and says so.
    delete bot.entities[2]
    delete bot.players.Steve
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'follow'), 4000))
    assert.match(s.internals().results.find((r) => r.label === 'follow').msg, /Steve left the game/)
  } finally { s.stop() }
})

// ===========================================================================
// 6. Routes keep away from mobs
// ===========================================================================

function mobBot (mobs, at = { x: 0, y: 64, z: 0 }) {
  const entities = {}
  mobs.forEach((m, i) => { entities[i + 10] = { id: i + 10, name: m.name, type: 'hostile', position: { x: m.x, y: m.y ?? 64, z: m.z }, velocity: { x: 0, y: 0, z: 0 } } })
  return { entity: { position: at }, entities }
}

test('the threat field has a standoff ring: a creeper standing still is not "safe" from two blocks away', () => {
  assert.equal(standoffFor('creeper'), 7)
  assert.ok(standoffFor('skeleton') > standoffFor('zombie'), 'what shoots is given more room than what must reach you')

  const bot = mobBot([{ name: 'creeper', x: 10, z: 0 }])
  const map = new PredictiveThreatMap({ corridorRadius: 0 })
  map.sample(bot, true)
  const cost = (x, z) => map.costAt({ x, y: 64, z })
  assert.ok(cost(10, 3) > 0, '3 blocks beside it costs — that is inside its fuse range')
  assert.ok(cost(10, 5) > 0, 'and so does 5')
  assert.equal(cost(10, 8), 0, 'beyond the ring a route is free again')
  assert.ok(cost(10, 1) > cost(10, 3) && cost(10, 3) > cost(10, 5), 'the closer, the dearer: a route bends around it')
  assert.ok(cost(10, 0) <= 95, 'never "impossible": the bot can still get out when it is boxed in')

  // The old field for comparison: one small sphere, nothing at 3 blocks.
  const old = new PredictiveThreatMap({ corridorRadius: 0, standoff: false })
  old.sample(bot, true)
  assert.equal(old.costAt({ x: 10, y: 64, z: 3 }), 0)
})

test('real A*: the route bends around a creeper instead of brushing past it', () => {
  const { PathfinderWrapper } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
  const route = (threatOpts) => {
    const bot = world.makeWorld()
    world.addMob(bot, 5, 'creeper', 10.5, 0.5)
    const movements = new world.Movements(bot)
    bot.pathfinder = { ...(bot.pathfinder || {}), movements, setMovements (m) { this.movements = m } }
    const wrapper = new PathfinderWrapper(bot, { logger: () => {}, threat: threatOpts })
    wrapper.configureMovements(movements)
    wrapper.threat.sample(bot, true)
    const out = world.plan(bot, movements, new world.goals.GoalXZ(20, 0))
    assert.equal(out.status, 'success')
    const nearest = Math.min(...out.path.map((n) => Math.hypot(n.x + 0.5 - 10.5, n.z + 0.5 - 0.5)))
    return { nearest, length: out.path.length }
  }
  const before = route({ standoff: false })
  const now = route({})
  assert.ok(before.nearest < 3.5, `the old field let the route pass ${before.nearest.toFixed(1)} blocks from it — inside fuse range`)
  assert.ok(now.nearest >= 4.5, `the route now keeps ${now.nearest.toFixed(1)} blocks away`)
  assert.ok(now.length < before.length + 16, 'for a detour of a few steps, not a trek')
})

test('a walking mob is avoided along the whole stretch it is about to cover, not only where it stands', () => {
  let now = 1000
  const bot = mobBot([{ name: 'zombie', x: 10, z: 0 }])
  const map = new PredictiveThreatMap({ corridorRadius: 0, now: () => now })
  map.sample(bot, true)
  // It walks +z at 0.2 blocks/tick (4 b/s).
  now += 200
  bot.entities[10].position = { x: 10, y: 64, z: 0.8 }
  map.sample(bot, true)
  const t = map.threats[0]
  assert.ok(t.future.z > 6, `projected ahead (${t.future.z.toFixed(1)})`)
  assert.ok(map.costAt({ x: 12, y: 64, z: 4 }) > 0, 'half way along its path is priced')
  assert.ok(map.costAt({ x: 12, y: 64, z: 4 }) > map.costAt({ x: 12, y: 64, z: -4 }), 'ahead of it costs more than behind it')
})

test('a route already being walked is planned again when a mob moves onto it', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const wrapper = s.internals().wrapper
    // A straight route east, planned with nothing around.
    const route = Array.from({ length: 14 }, (_, i) => ({ x: i + 1, y: 64, z: 0 }))
    const { goals } = require('mineflayer-pathfinder')
    bot.pathfinder.setGoal(new goals.GoalBlock(40, 64, 0))
    bot.emit('path_update', { status: 'success', path: route })
    let replans = 0
    const real = bot.pathfinder.setMovements
    bot.pathfinder.setMovements = function (m) { replans++; return real.call(this, m) }
    await sleep(450)
    assert.equal(wrapper._watchRoute(), false, 'a clear route is left alone')
    assert.equal(replans, 0)

    // A creeper wanders onto it, 8 blocks ahead. (A reflex is not what is being
    // tested here: the route watcher is, so it is asked directly.)
    world.addMob(bot, 9, 'creeper', 8.5, 0.5)
    assert.ok(await s.until(() => { wrapper.threat.sample(bot, true); return wrapper.threat.threats.length > 0 }, 3000), 'the creeper is on the threat map')
    wrapper._path = route // (whatever the reflex planned meanwhile: this test is about the errand's route)
    wrapper._routeBaseline = 0
    if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new goals.GoalBlock(40, 64, 0))
    const ahead = wrapper.routeThreat()
    assert.ok(ahead.worst >= wrapper.routeReplanCost, `the steps ahead became dangerous (${ahead.worst})`)
    assert.equal(wrapper._watchRoute(Date.now() + 5000), true, 'so the route is planned again')
    assert.ok(replans >= 1)
    assert.ok(wrapper.threatReplans >= 1)

    // The new plan is the new baseline: no better route, no spinning.
    bot.emit('path_update', { status: 'success', path: route })
    assert.equal(wrapper._watchRoute(Date.now() + 10_000), false, 'the same danger does not trigger a second re-plan')
  } finally { s.stop() }
})

// ===========================================================================
// 7. update / restart
// ===========================================================================

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim()

/** A "GitHub" (bare repo), a developer clone that pushes to it, and the bot's checkout. */
function makeRepos () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-update-'))
  const origin = path.join(root, 'origin.git')
  const dev = path.join(root, 'dev')
  const live = path.join(root, 'live')
  fs.mkdirSync(origin)
  git(origin, 'init', '--bare', '-b', 'main')
  git(root, 'clone', '-q', origin, dev)
  fs.mkdirSync(path.join(dev, 'zincai'))
  fs.writeFileSync(path.join(dev, 'zincai', 'index.js'), 'process.exit(0)\n')
  fs.writeFileSync(path.join(dev, 'README.md'), 'v1\n')
  git(dev, 'checkout', '-q', '-b', 'main')
  git(dev, 'add', '-A')
  git(dev, 'commit', '-q', '-m', 'v1')
  git(dev, 'push', '-q', 'origin', 'main')
  git(root, 'clone', '-q', origin, live)
  fs.mkdirSync(path.join(live, 'node_modules')) // "already installed"
  const push = (file, content, msg) => {
    fs.writeFileSync(path.join(dev, file), content)
    git(dev, 'add', '-A')
    git(dev, 'commit', '-q', '-m', msg)
    git(dev, 'push', '-q', 'origin', 'main')
    return git(dev, 'rev-parse', 'HEAD')
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  return { root, live, push, env, head: () => git(live, 'rev-parse', 'HEAD'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('update: pulls what was pushed, checks it loads, and reports what changed', async () => {
  const r = makeRepos()
  try {
    const none = await runUpdate({ cwd: r.live, env: r.env })
    assert.equal(none.ok, true)
    assert.equal(none.changed, false)
    assert.match(none.summary, /already up to date: main @ [0-9a-f]{7}/)

    const sha = r.push('README.md', 'v2\n', 'fix the follow')
    const peek = await runUpdate({ cwd: r.live, env: r.env, checkOnly: true })
    assert.equal(peek.available, true)
    assert.equal(peek.changed, false, '`update check` touches nothing')
    assert.notEqual(r.head(), sha)
    assert.match(peek.summary, /update available: main [0-9a-f]{7} → [0-9a-f]{7} \(1 commit\)/)

    const done = await runUpdate({ cwd: r.live, env: r.env })
    assert.equal(done.ok, true)
    assert.equal(done.changed, true)
    assert.equal(r.head(), sha, 'the checkout is on the pushed commit')
    assert.equal(fs.readFileSync(path.join(r.live, 'README.md'), 'utf8'), 'v2\n')
    assert.match(done.summary, /updated main [0-9a-f]{7} → [0-9a-f]{7}: fix the follow/)
    assert.equal(done.installed, false, 'no dependency file changed: npm is not run')
    assert.ok(done.steps.includes('new source passes --check'))
  } finally { r.cleanup() }
})

test('update: a source that does not load is rolled back and the running bot is left alone', async () => {
  const r = makeRepos()
  try {
    const before = r.head()
    r.push('zincai/index.js', 'process.stderr.write("SyntaxError: boom\\n"); process.exit(1)\n', 'break everything')
    const out = await runUpdate({ cwd: r.live, env: r.env })
    assert.equal(out.ok, false)
    assert.equal(out.changed, false, 'nothing to restart on')
    assert.match(out.summary, /rolled back to [0-9a-f]{7}: the new source does not load \(SyntaxError: boom\)/)
    assert.equal(r.head(), before, 'the checkout is back where it was')
  } finally { r.cleanup() }
})

test('update: local edits are refused unless forced; dependency changes reinstall', async () => {
  const r = makeRepos()
  try {
    r.push('package.json', '{"name":"x","version":"2.0.0"}\n', 'bump deps')
    fs.writeFileSync(path.join(r.live, 'README.md'), 'edited by hand\n')
    const refused = await runUpdate({ cwd: r.live, env: r.env })
    assert.equal(refused.ok, false)
    assert.match(refused.summary, /1 tracked file has local changes \(README\.md\).*update force/)

    const ran = []
    const { defaultExec } = require('../zincai/updater')
    const exec = (cmd, args, opts) => {
      if (cmd === 'npm') { ran.push(args.join(' ')); return Promise.resolve({ code: 0, stdout: '', stderr: '' }) }
      return defaultExec(cmd, args, opts)
    }
    const forced = await runUpdate({ cwd: r.live, env: r.env, force: true, exec })
    assert.equal(forced.ok, true)
    assert.equal(forced.changed, true)
    assert.equal(fs.readFileSync(path.join(r.live, 'README.md'), 'utf8'), 'v1\n', 'the hand edit is gone, as asked')
    assert.equal(ran.length, 1, 'package.json changed: npm ci ran')
    assert.match(ran[0], /^ci\b/)
    assert.equal(forced.installed, true)
  } finally { r.cleanup() }
})

test('console: `update` restarts only after a successful pull; `update check` and a failure do not', async () => {
  const s = startTestSession({ bot: simulatedBot(), host: true })
  try {
    const host = s.shared.host
    const exits = []
    host.exitProcess = (code, reason) => exits.push({ code, reason })
    host.isSupervised = () => true
    assert.ok(COMMANDS.some((c) => c.name === 'update') && COMMANDS.some((c) => c.name === 'restart'))

    const calls = []
    host.updater = async (opts) => { calls.push(opts); return { ok: true, changed: false, summary: 'already up to date: main @ abc1234' } }
    let out = await host.command('update', { source: 'console' })
    assert.equal(out.ok, true)
    assert.match(out.reply, /already up to date/)
    await sleep(20)
    assert.equal(exits.length, 0, 'nothing new: no restart')

    out = await host.command('update check', { source: 'console' })
    assert.equal(calls.at(-1).checkOnly, true)
    out = await host.command('update force', { source: 'console' })
    assert.equal(calls.at(-1).force, true)
    out = await host.command('update sideways', { source: 'console' })
    assert.equal(out.ok, false)
    assert.match(out.reply, /usage: update \[check \| force\]/)

    host.updater = async () => ({ ok: false, changed: false, summary: 'update rolled back to abc1234: the new source does not load' })
    out = await host.command('update', { source: 'console' })
    assert.equal(out.ok, false)
    await sleep(20)
    assert.equal(exits.length, 0, 'a failed update leaves the running bot alone')

    host.updater = async () => ({ ok: true, changed: true, summary: 'updated main abc1234 → def5678: fix the follow' })
    out = await host.command('update', { source: 'console' })
    assert.equal(out.ok, true)
    assert.match(out.reply, /updated main abc1234 → def5678: fix the follow\nrestarting now/)
    await sleep(20)
    assert.deepEqual(exits.map((e) => e.code), [supervisor.RESTART_CODE], 'exit 75: the supervisor starts it again')

    out = await host.command('restart', { source: 'console' })
    await sleep(20)
    assert.equal(exits.length, 2)
    assert.equal(exits[1].code, supervisor.RESTART_CODE)
  } finally { s.stop() }
})

test('supervisor: on for a normal start, off for one-shot runs and when opted out; a restart request is exit 75', () => {
  assert.equal(supervisor.RESTART_CODE, 75)
  assert.equal(supervisor.shouldSupervise([], {}), true)
  assert.equal(supervisor.shouldSupervise(['--check'], {}), false)
  assert.equal(supervisor.shouldSupervise(['--dry-run'], {}), false)
  assert.equal(supervisor.shouldSupervise(['--no-supervisor'], {}), false)
  assert.equal(supervisor.shouldSupervise([], { [supervisor.OPT_OUT]: '1' }), false)
  assert.equal(supervisor.shouldSupervise([], { [supervisor.CHILD_FLAG]: '1' }), false, 'the child does not supervise itself')
  assert.equal(supervisor.isSupervised({ [supervisor.CHILD_FLAG]: '1' }), true)
  assert.equal(supervisor.isSupervised({}), false)
})

test('supervisor: restarts the child on exit 75 and passes any other exit code through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-sup-'))
  try {
    const marker = path.join(dir, 'runs')
    const child = path.join(dir, 'child.js')
    // First run asks for a restart; the second exits 3.
    fs.writeFileSync(child, `
      const fs = require('fs')
      const n = fs.existsSync(${JSON.stringify(marker)}) ? Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')) : 0
      fs.writeFileSync(${JSON.stringify(marker)}, String(n + 1))
      if (!process.env.${supervisor.CHILD_FLAG}) process.exit(9)
      process.exit(n === 0 ? ${supervisor.RESTART_CODE} : 3)
    `)
    const runner = path.join(dir, 'run.js')
    fs.writeFileSync(runner, `
      const { supervise } = require(${JSON.stringify(require.resolve('../zincai/supervisor'))})
      supervise({ script: ${JSON.stringify(child)}, log: () => {} })
    `)
    let code = 0
    try { execFileSync(process.execPath, [runner], { stdio: 'ignore', timeout: 20_000 }) } catch (err) { code = err.status }
    assert.equal(fs.readFileSync(marker, 'utf8'), '2', 'the child ran twice: once, then again after asking for a restart')
    assert.equal(code, 3, 'and the final exit code is the child\'s own')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('supervisor: a parent that is killed outright takes the bot with it (no orphan left logged in)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-orphan-'))
  const { spawn } = require('node:child_process')
  try {
    const up = path.join(dir, 'up')
    const gone = path.join(dir, 'gone')
    const child = path.join(dir, 'child.js')
    // Stands in for the bot: stays alive on a timer, like a connected session.
    fs.writeFileSync(child, `
      const fs = require('fs')
      const { watchParent } = require(${JSON.stringify(require.resolve('../zincai/supervisor'))})
      const watching = watchParent({ onGone: () => { fs.writeFileSync(${JSON.stringify(gone)}, 'saved'); process.exit(0) } })
      fs.writeFileSync(${JSON.stringify(up)}, String(process.pid) + ' ' + watching)
      setInterval(() => {}, 1000)
    `)
    const runner = path.join(dir, 'run.js')
    fs.writeFileSync(runner, `
      const { supervise } = require(${JSON.stringify(require.resolve('../zincai/supervisor'))})
      supervise({ script: ${JSON.stringify(child)}, log: () => {} })
    `)
    const parent = spawn(process.execPath, [runner], { stdio: 'ignore' })
    const waitFor = async (file, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fs.existsSync(file)) return true; await sleep(25) } return false }
    assert.ok(await waitFor(up, 10_000), 'the child came up')
    const [pid, watching] = fs.readFileSync(up, 'utf8').split(' ')
    assert.equal(watching, 'true', 'a supervised child watches its parent')
    try {
      parent.kill('SIGKILL') // no handler runs: nothing is forwarded
      assert.ok(await waitFor(gone, 10_000), 'the child noticed and shut itself down')
      await sleep(100)
      assert.throws(() => process.kill(Number(pid), 0), /ESRCH/, 'and it is really gone')
    } finally { try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ } }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('supervisor: watchParent is a no-op without a supervisor, and fires once', () => {
  const { EventEmitter } = require('node:events')
  let n = 0
  // Not supervised: nothing is registered even if a channel happens to exist.
  const plain = Object.assign(new EventEmitter(), { channel: { unref () {} } })
  assert.equal(supervisor.watchParent({ proc: plain, env: {}, onGone: () => n++ }), false)
  assert.equal(plain.listenerCount('disconnect'), 0)
  // Supervised but started without a channel (ZINCAI_SUPERVISED set by hand).
  assert.equal(supervisor.watchParent({ proc: new EventEmitter(), env: { [supervisor.CHILD_FLAG]: '1' }, onGone: () => n++ }), false)
  let unrefd = 0
  const kid = Object.assign(new EventEmitter(), { channel: { unref () { unrefd++ } } })
  assert.equal(supervisor.watchParent({ proc: kid, env: { [supervisor.CHILD_FLAG]: '1' }, onGone: () => n++ }), true)
  assert.equal(unrefd, 1, 'the channel does not keep the process alive by itself')
  kid.emit('disconnect'); kid.emit('disconnect')
  assert.equal(n, 1)
})

test('update: without git where the bot runs, the refusal says so instead of blaming the checkout', async () => {
  const exec = async (cmd) => (cmd === 'git' ? { code: 1, stdout: '', stderr: 'spawn git ENOENT' } : { code: 0, stdout: '', stderr: '' })
  const r = await runUpdate({ cwd: os.tmpdir(), exec })
  assert.equal(r.ok, false)
  assert.equal(r.changed, false)
  assert.match(r.summary, /git is not installed where the bot runs/)
  assert.match(r.summary, /Install in the panel/)
})
