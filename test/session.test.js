/**
 * Whole-harness tests: the real zincai/index.js session — scheduler, chat
 * lane, action lane, executor, skills, reflexes, arbiter, combat — driven by
 * a simulated bot and a scripted model (test/helpers/session.js).
 *
 * These are the audit's scenes, replayed against the shipped orchestrator.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')
const { decideReconnect } = require('../zincai/index.js')

const keysDown = (bot) => Object.entries(bot.controls).filter(([, v]) => v).map(([k]) => k)
const line = (prompt, label) => prompt.split('\n').find((l) => l.startsWith(label)) || ''

test('chat in PT-BR: "zinc vem aqui" is heard, answered, turned into a task, done and reported back', async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['bread', 5]], held: 'iron_sword' })
  addPlayer(bot, 2, 'Gabriel', 10.5, 0.5, 'diamond_pickaxe')
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'já vou!', task: 'go to Gabriel' }),
    actions: (p) => {
      if (/why now:.*go_to done: reached Gabriel/.test(p)) return { a: 'say', text: 'cheguei, e aí?' }
      if (/why now:.*chat request from Gabriel/.test(p)) return { a: 'go_to', player: 'Gabriel' }
      return null // idle
    }
  })
  try {
    s.spawn()
    await sleep(200)
    s.say('<Gabriel> zinc vem aqui')
    assert.ok(await s.until(() => s.internals().results.some((r) => /reached Gabriel/.test(r.msg)), 8000), 'the bot walked to Gabriel')
    assert.ok(await s.until(() => bot.log.chat.length === 2, 3000))

    assert.deepEqual(bot.log.chat, ['já vou!', 'cheguei, e aí?'], 'accents intact, both lines delivered')
    assert.ok(bot.entity.position.distanceTo(bot.players.Gabriel.entity.position) <= 3.3)

    // The chat lane saw who spoke, where they are and the message.
    assert.match(s.prompts.chat[0], /Gabriel says: zinc vem aqui/)
    assert.match(s.prompts.chat[0], /players: Gabriel 10m E at 10,64,0/)
    // The action lane got the request, with names it can use…
    const asked = s.prompts.action.find((p) => /chat request from Gabriel: go to Gabriel/.test(p))
    assert.ok(asked, 'the task reached the action lane')
    assert.match(asked, /inventory \(2\/36 slots\): iron_sword, bread x5/)
    // …and was woken with the RESULT when the walk ended (it used to hear nothing).
    const after = s.prompts.action.find((p) => /why now: go_to done: reached Gabriel/.test(p))
    assert.ok(after, 'completion wakes the model')
    assert.match(after, /results \(your last actions\):\n {2}- go_to: reached Gabriel/)
  } finally { s.stop() }
})

test('a zombie appears: the reflex flees and reports; nothing is attacked until the model says so', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  // First answer about the zombie: idle (keep fleeing). Second: fight it.
  let asked = 0
  const s = startTestSession({ bot, actions: (p) => (/^doing: FLEEING by reflex$/m.test(p) && ++asked >= 2 ? { a: 'attack', target: 'zombie' } : null) })
  try {
    s.spawn()
    await sleep(200)
    const zombie = world.addMob(bot, 7, 'zombie', 0.5, 6.5)
    let hits = 0
    bot.on('test_attack', (e) => {
      if (e === zombie && ++hits === 3) { bot.emit('entityDead', zombie); delete bot.entities[7]; bot.emit('entityGone', zombie) }
    })

    assert.ok(await s.until(() => s.internals().system1.fleeing, 2000), 'flee reflex')
    assert.equal(s.internals().arbiter.owner(), 'survival')
    // The model answers "idle" first: that means keep fleeing — and still no swing.
    assert.ok(await s.until(() => s.prompts.action.some((p) => /^doing: FLEEING by reflex$/m.test(p)), 3000))
    assert.equal(bot.log.attack.length, 0, 'no attack without the model')
    await sleep(300)
    assert.equal(s.internals().system1.fleeing, true, 'idle keeps fleeing')
    // Nothing else wakes it while it runs, so nudge it the way a second event would.
    s.internals().brain.wake('still fleeing')
    const told = s.prompts.action.find((p) => /^doing: FLEEING by reflex$/m.test(p))
    // One block says it all: who (one count), how hard they press and which ways
    // are open, what a fight would cost, what the body is doing, what may be decided.
    assert.match(line(told, 'threats:'), /^threats: 1 in sight — zombie \(\d+m S\)$/)
    assert.match(line(told, '  pressure:'), /^ {2}pressure: \d within 8m.* \| ways out: open /)
    assert.match(line(told, '  if you fight:'), /iron_sword 6 dmg, armor 0\/20, hp 20: ≈ \d+s to kill it, you would take ≈ \d+ dmg → GOOD$/)
    assert.match(line(told, '  reflex:'), /^ {2}reflex: FLEEING for \d+s from zombie — ran \d+m from 0,64,0\. The body did this by itself; idle keeps it running\.$/)
    assert.match(line(told, '  decide:'), /idle = keep fleeing \| attack = fight \| go_to \/ follow = go there instead \| hold = stop running/)
    assert.match(line(told, 'why now:'), /reflex: started FLEEING — zombie came close \(\d+m S\)/)
    assert.ok(!/cannot reach you/.test(told), 'the zombie it runs from is not also listed as unable to reach it')

    // Then it decides to fight.
    assert.ok(await s.until(() => hits >= 3, 10_000), 'the fight happens only after attack')
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'fight'), 3000))
    const fight = s.internals().results.find((r) => r.label === 'fight')
    assert.match(fight.msg, /^zombie down/)
    await sleep(100)
    assert.deepEqual(keysDown(bot), [], 'no key outlives the fight')
    assert.equal(s.internals().arbiter.owner(), 'idle')
    assert.equal(s.internals().system1.fleeing, false)
  } finally { s.stop() }
})

test('a player hits the bot: it backs off and talks; PvP happens only when the model names that player', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const gabriel = addPlayer(bot, 2, 'Gabriel', 2.5, 0.5, 'diamond_sword')
  addPlayer(bot, 3, 'Pedro', -2.5, 0.5, 'bow') // a bystander holding a bow, closer than nobody
  // A model that escalates step by step, reading its own results.
  const s = startTestSession({
    bot,
    actions: (p) => {
      if (!/hit by player Gabriel/.test(p)) return null
      const failed = (p.match(/attack: FAILED/g) || []).length
      if (!/you: \(to Gabriel\)/.test(p)) return { a: 'say', text: 'ei Gabriel, para com isso', to: 'Gabriel' }
      if (failed === 0) return { a: 'attack', target: 'player' } // refused: no name
      if (failed === 1) return { a: 'attack', target: 'any' } // refused: "any" is never a player
      return /fighting Gabriel/.test(p) ? null : { a: 'attack', player: 'Gabriel' } // the explicit decision
    }
  })
  try {
    s.spawn()
    await sleep(200)
    assert.equal(s.internals().system1.fleeing, false, 'armed players standing nearby are not threats')

    bot.health = 17
    bot.emit('entityHurt', bot.entity) // the bare event…
    bot.emit('entityHurt', bot.entity, gabriel) // …then the one that names the source
    assert.ok(await s.until(() => bot.log.chat.length > 0, 4000))
    assert.deepEqual(bot.log.chat, ['/msg Gabriel ei Gabriel, para com isso'], 'a private warning, nothing else')
    s.internals().brain.wake('Gabriel keeps hitting')
    const told = s.prompts.action.find((p) => /hit by player Gabriel/.test(p))
    assert.match(line(told, 'why now:'), /hurt: hit by player Gabriel \(hp 17\)/)
    assert.match(line(told, 'threats:'), /Gabriel \(\d+m \w+; player, hit you; diamond_sword, armor 0\/20\)/)
    assert.ok(!/Pedro/.test(line(told, 'threats:')), 'the bystander is not a threat')
    assert.equal(bot.log.attack.length, 0)

    // Vague attack requests never land on a player.
    assert.ok(await s.until(() => s.internals().results.filter((r) => r.label === 'attack' && !r.ok).length >= 2, 6000))
    const refused = s.internals().results.filter((r) => r.label === 'attack' && !r.ok).map((r) => r.msg)
    assert.match(refused[0], /name them exactly in attack\.player/)
    assert.equal(bot.log.attack.length, 0)

    // Naming the player is the model's explicit decision — only then.
    assert.ok(await s.until(() => bot.log.attack.length > 0, 10_000), 'explicit duel')
    assert.ok(bot.log.attack.every((id) => id === 2), 'only Gabriel, never the bystander')
  } finally { s.stop() }
})

test('a friend\'s house: the model addresses chests by the ids it is shown; results come back', async () => {
  const bot = simulatedBot({
    items: [['bread', 5]],
    blocks: { '4,64,3': 'chest', '6,64,3': 'furnace', '5,64,-2': 'red_bed' },
    containers: { '4,64,3': { diamond: 12, iron_ingot: 30 } }
  })
  addPlayer(bot, 2, 'Gabriel', 3.5, -3.5)
  // The model works through the errand from what each result tells it.
  const s = startTestSession({
    bot,
    actions: (p) => {
      if (/give: tossed/.test(p)) return null
      if (/take: took diamond x3/.test(p)) return { a: 'give', player: 'Gabriel', item: 'diamond', count: 3 }
      if (/look_in: chest1/.test(p)) return { a: 'take', item: 'diamond', count: 3, where: 'chest1' }
      if (/chat request from Gabriel/.test(p)) return { a: 'look_in', where: 'chest1' }
      return null
    }
  })
  try {
    let tossed = null
    bot.toss = async (type, _meta, n) => { tossed = { name: world.registry.items[type].name, n } }
    s.spawn()
    await sleep(200)
    const { brain } = s.internals()
    brain.wake('chat request from Gabriel: bring Gabriel 3 diamonds from the chest')

    assert.ok(await s.until(() => tossed !== null, 12_000), 'the errand completes')
    assert.deepEqual(tossed, { name: 'diamond', n: 3 })
    const first = s.prompts.action.find((p) => /chat request from Gabriel/.test(p))
    const room = first.split('\n').find((l) => /^ {2}y64 /.test(l)) || ''
    for (const id of ['chest1 [not opened yet]', 'furnace1', 'bed1 (red)']) assert.ok(room.includes(id), `the room line names ${id}: ${room}`)
    const results = s.internals().results.map((r) => `${r.label}: ${r.msg}`)
    assert.ok(results.some((r) => /^look_in: chest1 at 4,64,3: iron_ingot x30, diamond x12 \(25 free slots\)$/.test(r)), results.join(' | '))
    assert.ok(results.some((r) => /^take: took diamond x3 from chest1 \(9 left there\)$/.test(r)), results.join(' | '))
    assert.ok(results.some((r) => /^give: tossed diamond x3 to Gabriel$/.test(r)), results.join(' | '))
    // What it saw is remembered for next time.
    const later = s.prompts.action[s.prompts.action.length - 1]
    assert.match(later, /chest1 \[iron_ingot x30, diamond x9\]/)
    assert.equal(bot.log.opened, bot.log.closed, 'every opened container was closed')
  } finally { s.stop() }
})

test('a prose answer no longer vanishes: the model is told it did nothing', async () => {
  const bot = simulatedBot()
  let first = true
  const s = startTestSession({ bot, actions: () => { if (first) { first = false; return { prose: 'Sure! I will head over to the village now.' } } return null } })
  try {
    s.spawn()
    assert.ok(await s.until(() => s.prompts.action.length >= 2, 4000), 'a second turn follows the prose one')
    assert.match(s.prompts.action[1], /reply: FAILED — you answered in prose without calling a tool, so nothing happened/)
    assert.equal(bot.log.chat.length, 0)
  } finally { s.stop() }
})

test('dying once does not break doors or leave anything owned', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const s = startTestSession({ bot, actions: (p) => (/why now:.*test: go somewhere/.test(p) ? { a: 'go_to', x: 30, z: 0 } : null) })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('test: go somewhere')
    assert.ok(await s.until(() => s.internals().skills.current(), 3000), 'walking')
    bot.emit('death')
    await sleep(50)
    assert.equal(s.internals().arbiter.owner(), 'idle', 'nobody owns the controls after death')
    assert.ok(await s.until(() => s.internals().skills.current() === null, 1000), 'the walk was cancelled')
    bot.entity.position.set(0.5, 64, 0.5)
    s.spawn() // respawn
    const movements = bot.pathfinder.movements
    assert.equal(movements._zincaiDoors?.attached, true, 'door routing is attached to the fresh Movements')
    assert.equal(movements.canOpenDoors, false, 'upstream door handling stays off (doors.js replaces it)')
    assert.equal(movements.allow1by1towers, false)
    assert.equal(movements._zincaiThreatCost, true)
    assert.ok(s.shared.places.getPlace('last death'), 'the death point is remembered for item recovery')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /why now:.*respawned at 0,64,0/.test(p)), 3000))
  } finally { s.stop() }
})

test('reconnect policy: first join failure is fatal; a dropped link after a good session is retried', () => {
  // Hard rule kept: a rejected FIRST join aborts — no retries, no renames.
  assert.equal(decideReconnect({ kind: 'kicked', text: 'You are not white-listed', everSpawned: false }).action, 'exit')
  assert.equal(decideReconnect({ kind: 'error', text: 'ECONNREFUSED', everSpawned: false }).code, 1)
  // After a session that did spawn: server restart / dropped link → back-off.
  const first = decideReconnect({ kind: 'end', text: 'socketClosed', everSpawned: true, attempts: 0, reconnect: { baseDelayMs: 5000, maxDelayMs: 120000 } })
  assert.deepEqual(first, { action: 'retry', attempt: 1, maxAttempts: 40, delayMs: 5000 })
  assert.equal(decideReconnect({ kind: 'error', text: 'ECONNREFUSED', everSpawned: true, attempts: 3, reconnect: {} }).delayMs, 40_000)
  assert.equal(decideReconnect({ kind: 'end', text: '', everSpawned: true, attempts: 20, reconnect: {} }).delayMs, 120_000, 'capped')
  // …but not when retrying cannot help, and not forever.
  assert.equal(decideReconnect({ kind: 'kicked', text: 'You are banned from this server', everSpawned: true, attempts: 0 }).action, 'exit')
  assert.equal(decideReconnect({ kind: 'kicked', text: 'Server closed', everSpawned: true, attempts: 0, reconnect: {} }).action, 'retry')
  assert.equal(decideReconnect({ kind: 'end', text: '', everSpawned: true, attempts: 40, reconnect: {} }).reason, 'reconnect-exhausted')
  assert.deepEqual(decideReconnect({ kind: 'end', text: '', everSpawned: true, reconnect: { enabled: false } }), { action: 'exit', code: 0, reason: 'server-ended', log: [] })
})
