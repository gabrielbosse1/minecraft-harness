/**
 * Regression tests for the pre-release audit (audit/REPORT.md), whole-harness
 * half: the real zincai/index.js session — scheduler, both lanes, executor,
 * skills, reflexes, combat — against a simulated bot and a scripted model
 * that reads its prompt (test/helpers/session.js). Named by defect id.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')
const { makeBot, ent, heldKeys } = require('./helpers/mockbot')
const { AdvancedCombat } = require('../src/combat')
const { Vec3 } = world

const line = (prompt, label) => prompt.split('\n').find((l) => l.startsWith(label)) || ''
const why = (prompt) => line(prompt, 'why now:')

/** Zombies that walk at the bot at zombie speed. Returns a stop function. */
function chase (bot, mobs, speed = 0.115) {
  const timer = setInterval(() => {
    const me = bot.entity.position
    for (const m of mobs) {
      if (!bot.entities[m.id]) continue
      const dx = me.x - m.position.x; const dz = me.z - m.position.z; const d = Math.hypot(dx, dz) || 1
      if (d > 1) { m.position.x += dx / d * speed; m.position.z += dz / d * speed }
    }
  }, 50)
  return () => clearInterval(timer)
}

test('T2 + T3: a horde chase with production pacing — few calls, one count, and the bot knows it is fleeing', async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['bread', 6]], held: 'iron_sword' })
  const friend = addPlayer(bot, 2, 'Gabriel', -30.5, -30.5)
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'tô correndo de zumbi, já falo contigo' }),
    cfg: (cfg) => { cfg.inference = { ...cfg.inference, minIntervalMs: 3000, chatMinIntervalMs: 1200, rpm: 18, heartbeatMs: 0 }; cfg.system1 = { ...cfg.system1, tickMs: 200 } }
  })
  let stop = () => {}
  try {
    s.spawn()
    await sleep(300)
    const before = s.prompts.action.length
    const mobs = []
    for (let i = 0; i < 14; i++) { const a = (-60 + i * 9) * Math.PI / 180; mobs.push(world.addMob(bot, 100 + i, 'zombie', 0.5 + Math.sin(a) * (8 + (i % 3) * 5), 0.5 + Math.cos(a) * (8 + (i % 3) * 5))) }
    stop = chase(bot, mobs)
    assert.ok(await s.until(() => s.internals().system1.fleeing, 2000))
    await sleep(2500)
    s.say('<Gabriel> zinc ta tudo bem ai?')
    assert.ok(await s.until(() => bot.log.chat.length === 1, 4000), 'chat is answered during the chase')
    await sleep(6500)

    const turns = s.prompts.action.slice(before)
    assert.ok(turns.length >= 1 && turns.length <= 3, `9 s of chase cost ${turns.length} action call(s) (it used to be one every 3 s)`)
    const first = turns[0]
    assert.match(why(first), /^why now: reflex: started FLEEING — zombie came close \(\d+m \w+\)/)
    const count = Number(/^threats: (\d+) in sight — zombie x(\d+)/.exec(line(first, 'threats:'))?.[1])
    assert.ok(count >= 12, `the threat line counts the horde (${count}), not just the ones inside 12 blocks`)
    assert.ok(!/zombie \(hostile/.test(line(first, 'mobs:')), 'and the same zombies are not listed again as "cannot reach you"')
    assert.match(line(first, '  if you fight:'), /→ BAD$/)
    assert.match(line(first, 'doing:'), /FLEEING by reflex/)

    // The voice that answered Gabriel was told what the body was doing.
    const heard = s.prompts.chat[0]
    assert.match(line(heard, 'doing:'), /FLEEING by reflex/)
    assert.match(line(heard, 'threats:'), /^threats: \d+ in sight — zombie x\d+ \(nearest \d+m \w+\)$/, 'the same count the action lane sees')
    assert.match(line(heard, 'reflex:'), /^reflex: FLEEING for \d+s from zombie x\d+ — ran \d+m from 0,64,0\./)

    // The zombies give up. The end is reported once, and stays known for the next minutes.
    stop()
    for (const m of mobs) { delete bot.entities[m.id] }
    assert.ok(await s.until(() => !s.internals().system1.fleeing, 8000), 'the escape ends when nothing follows')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /why now:.*reflex: safe again — fled \d+s from zombie x\d+/.test(p)), 5000))
    const after = s.prompts.action.find((p) => /reflex: safe again/.test(why(p)))
    assert.match(line(after, 'threats:'), /^threats: none$/)
    assert.match(line(after, 'reflex:'), /^reflex: \d+s ago you FLED by reflex for \d+s from zombie x\d+ \(ran \d+m from 0,64,0\); it ended because nothing followed any more\.$/)
    s.say('<Gabriel> zinc cade vc?')
    assert.ok(await s.until(() => s.prompts.chat.length === 2, 4000))
    assert.match(line(s.prompts.chat[1], 'reflex:'), /you FLED by reflex/, 'ask it a minute later and it still knows why it is where it is')
    assert.ok(friend)
  } finally { stop(); s.stop() }
})

test('B2: a reply in English is retried once, then replaced; an English "say" is held back and re-said', async () => {
  const bot = simulatedBot({ items: [['bread', 2]] })
  addPlayer(bot, 2, 'Gabriel', 3.5, 0.5)
  let chatCalls = 0
  let mode = 'retry-fixes-it'
  const s = startTestSession({
    bot,
    chat: (p) => {
      chatCalls++
      if (mode === 'retry-fixes-it') return /not in Brazilian Portuguese/.test(p) ? { text: 'tô indo aí!' } : { text: 'on my way!', task: 'go to Gabriel' }
      return { text: 'I am fine, thanks' } // stubborn
    },
    actions: (p) => {
      if (/say: FAILED — NOT SENT/.test(p)) return { a: 'say', text: 'cheguei, e aí?' }
      if (/why now:.*go_to done: reached Gabriel/.test(p)) return { a: 'say', text: 'I have arrived' }
      if (/why now:.*chat request from Gabriel/.test(p)) return { a: 'go_to', player: 'Gabriel' }
      return null
    }
  })
  try {
    s.spawn()
    await sleep(200)
    s.say('<Gabriel> zinc come here please')
    assert.ok(await s.until(() => bot.log.chat.length >= 2, 6000))
    assert.deepEqual(bot.log.chat, ['tô indo aí!', 'cheguei, e aí?'], 'both lines went out in PT-BR; the English ones never did')
    assert.equal(chatCalls, 2, 'one retry')
    assert.ok(s.prompts.action.some((p) => /chat request from Gabriel: go to Gabriel/.test(p)), 'the task survived the retry')
    assert.ok(s.prompts.action.some((p) => /say: FAILED — NOT SENT — "I have arrived" is not Brazilian Portuguese/.test(p)))

    mode = 'stubborn'
    await sleep(1300) // conversation spacing
    s.say('<Gabriel> zinc how are you')
    assert.ok(await s.until(() => bot.log.chat.length === 3, 4000))
    assert.equal(bot.log.chat[2], 'foi mal, me enrolei aqui kkk', 'a fixed PT-BR line rather than English')
  } finally { s.stop() }
})

test('B3: a short job pauses the long task and it resumes by itself; hold cancels nothing; stop cancels all', async () => {
  const bot = simulatedBot({ items: [['bread', 5]] })
  const gabriel = addPlayer(bot, 2, 'Gabriel', 12.5, 0.5)
  addPlayer(bot, 3, 'Pedro', -6.5, 4.5)
  bot.toss = async (type, _meta, n) => { bot.log.tossed = (bot.log.tossed || 0) + n }
  const s = startTestSession({
    bot,
    chat: (p) => (/Pedro says/.test(p) ? { text: 'toma aí', task: 'give Pedro 1 bread' } : (/para/.test(p) ? { text: 'parei', task: 'stop' } : { text: 'bora', task: 'follow Gabriel' })),
    actions: (p) => {
      const w = why(p)
      if (/chat request from Gabriel: stop/.test(w)) return { a: 'stop' }
      if (/chat request from Pedro: give Pedro 1 bread/.test(w)) return { a: 'give', player: 'Pedro', item: 'bread', count: 1 }
      if (/chat request from Gabriel: follow Gabriel/.test(w)) return { a: 'follow', player: 'Gabriel' }
      return null
    }
  })
  try {
    s.spawn()
    await sleep(200)
    s.say('<Gabriel> zinc me segue')
    const skills = () => s.internals().skills
    assert.ok(await s.until(() => skills().current()?.label === 'following Gabriel', 4000))
    assert.ok(await s.until(() => bot.entity.position.distanceTo(gabriel.position) < 4, 6000))
    assert.match(line(s.internals().buildActionPrompt(['test']).text, 'doing:'), /^doing: following Gabriel \(\d+s, asked by Gabriel\)$/)

    // "hold" is an answer about threats, not a new task: the follow goes on.
    await s.internals().executeAction({ a: 'hold' }, { threatIds: [] })
    assert.equal(skills().current()?.label, 'following Gabriel', 'hold used to cancel the task')

    // Pedro asks for bread in the middle of it.
    s.say('<Pedro> zinc me da um pao')
    assert.ok(await s.until(() => /giving bread to Pedro/.test(skills().current()?.label || ''), 4000), 'the side job runs')
    const during = s.internals().buildActionPrompt(['test']).text
    assert.match(line(during, 'agenda:'), /^agenda: \[main, PAUSED for give\] follow Gabriel, asked by Gabriel \(\d+s ago\) — carries on by itself afterwards; stop cancels it$/)
    assert.ok(await s.until(() => bot.log.tossed === 1, 8000), 'Pedro got his bread')
    assert.ok(await s.until(() => skills().current()?.label === 'following Gabriel', 3000), 'and the bot went back to following Gabriel without being told')
    assert.ok(await s.until(() => bot.entity.position.distanceTo(gabriel.position) < 4, 8000))
    assert.equal(line(s.internals().buildActionPrompt(['test']).text, 'agenda:'), '', 'nothing is pending any more')
    assert.ok(s.internals().results.some((r) => r.label === 'give' && r.ok), 'the result of the side job was reported')

    s.say('<Gabriel> zinc para')
    assert.ok(await s.until(() => skills().current() === null && s.internals().agenda.main === null, 4000), 'stop ends the long task for good')
    await sleep(400)
    assert.equal(skills().current(), null, 'and nothing resumes it')
  } finally { s.stop() }
})

test('B3: a request the body did not start is kept on the agenda until it does', async () => {
  const bot = simulatedBot({ items: [['bread', 5]] })
  addPlayer(bot, 2, 'Gabriel', 6.5, 0.5)
  let allow = false
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'já vou', task: 'go to Gabriel' }),
    actions: (p) => (allow && /\[asked, not started\] Gabriel: go to Gabriel/.test(p) ? { a: 'go_to', player: 'Gabriel' } : null)
  })
  try {
    s.spawn()
    await sleep(200)
    s.say('<Gabriel> zinc vem aqui')
    assert.ok(await s.until(() => s.prompts.action.some((p) => /chat request from Gabriel/.test(why(p))), 3000))
    await sleep(200) // the turn that got the request answered idle (a model having a bad moment)
    assert.equal(s.internals().skills.current(), null)
    assert.match(line(s.internals().buildActionPrompt(['test']).text, 'agenda:'), /^agenda: \[asked, not started\] Gabriel: go to Gabriel \(\d+s ago\)$/)
    allow = true
    s.internals().brain.wake('heartbeat')
    assert.ok(await s.until(() => s.internals().results.some((r) => /reached Gabriel/.test(r.msg)), 6000), 'the next turn still sees the request and carries it out')
    assert.equal(line(s.internals().buildActionPrompt(['test']).text, 'agenda:'), '')
  } finally { s.stop() }
})

test('B5: the chat voice writes down what it is told, and reads it back next time', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 3.5, 0.5)
  const s = startTestSession({
    bot,
    chat: (p) => (/onde/.test(line(p, 'Gabriel says:')) ? { text: 'no baú do segundo andar' } : { text: 'blz, anotado', remember: 'Gabriel guarda os diamantes no baú do segundo andar' })
  })
  try {
    s.spawn()
    await sleep(200)
    s.say('<Gabriel> zinc, coloquei os diamantes no bau do segundo andar')
    assert.ok(await s.until(() => bot.log.chat.length === 1, 3000))
    assert.equal(s.shared.memory.factsAbout('Gabriel')[0], 'Gabriel guarda os diamantes no baú do segundo andar')
    await sleep(1300)
    s.say('<Gabriel> zinc onde eu guardei os diamantes?')
    assert.ok(await s.until(() => s.prompts.chat.length === 2, 3000))
    assert.match(s.prompts.chat[1], /you know from Gabriel:\n {2}- Gabriel guarda os diamantes no baú do segundo andar/)
    // …and it is on disk, with the conversation, for the next run.
    s.shared.memory.save()
    s.shared.saveConvo()
    const { makeShared } = require('../zincai/index.js')
    const again = makeShared(s.shared.cfg, { dataDir: require('path').dirname(s.shared.memoryFile) })
    assert.equal(again.memory.factsAbout('Gabriel')[0], 'Gabriel guarda os diamantes no baú do segundo andar')
    assert.ok(again.convo.get('Gabriel').some((l) => /coloquei os diamantes/.test(l.text)), 'the conversation survived the restart')
  } finally { s.stop() }
})

test('C1: "attack cow" is one cow; a count is a count; zombies are still taken one after another', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(200)
    const cows = [0, 1, 2, 3].map((i) => world.addMob(bot, 20 + i, 'cow', 2.5 + i, 2.5, { type: 'animal' }))
    const hp = new Map()
    bot.on('test_attack', (e) => {
      const left = (hp.get(e.id) ?? 2) - 1
      hp.set(e.id, left)
      if (left <= 0) { bot.emit('entityDead', e); delete bot.entities[e.id]; bot.emit('entityGone', e) }
    })
    const alive = () => cows.filter((c) => bot.entities[c.id]).length
    const fights = () => s.internals().results.filter((r) => r.label === 'fight')

    await s.internals().executeAction({ a: 'attack', target: 'cow' }, { threatIds: [] })
    assert.ok(await s.until(() => fights().length === 1, 8000))
    await sleep(600)
    assert.equal(alive(), 3, 'one call next to a pen used to empty the pen')
    assert.match(fights()[0].msg, /^cow down$/)

    await s.internals().executeAction({ a: 'attack', target: 'cow', count: 2 }, { threatIds: [] })
    assert.ok(await s.until(() => fights().length === 2, 12_000))
    await sleep(600)
    assert.equal(alive(), 1)
    assert.match(fights()[1].msg, /^cow down \(2 killed\)$/)

    const zombies = [0, 1, 2].map((i) => world.addMob(bot, 40 + i, 'zombie', -3.5 - i, 0.5))
    await s.internals().executeAction({ a: 'attack', target: 'zombie' }, { threatIds: zombies.map((z) => z.id) })
    assert.ok(await s.until(() => fights().length === 3, 15_000))
    assert.match(fights()[2].msg, /^zombie down \(3 killed\)/, 'hostile mobs of the named kind are still chained')
  } finally { s.stop() }
})

test('S2 + S4: take never guesses a container; find knows the labels', async () => {
  const bot = simulatedBot({
    items: [['bread', 2]],
    blocks: { '4,64,3': 'chest', '6,64,3': 'furnace', '4,65,3': 'oak_wall_sign', '-5,64,3': 'chest', '-5,65,3': 'oak_wall_sign' },
    containers: { '4,64,3': { diamond: 12, diamond_pickaxe: 1 }, '-5,64,3': { iron_ingot: 30 } }
  })
  const signs = { '4,65,3': 'Diamantes', '-5,65,3': 'Ferro' }
  const blockAt = bot.blockAt.bind(bot)
  bot.blockAt = (p) => { const b = blockAt(p); const t = signs[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]; if (t) b.getSignText = () => [t, '']; return b }
  let furnaceTaken = 0
  bot.openFurnace = async () => ({ outputItem: () => ({ name: 'iron_ingot', count: 9 }), inputItem: () => null, fuelItem: () => null, takeOutput: async () => { furnaceTaken++; return { name: 'iron_ingot', count: 9 } }, close () {} })
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(250)
    const run = async (action) => {
      const n = s.internals().results.length
      const before = s.internals().results[n - 1]
      await s.internals().executeAction(action, { threatIds: [] })
      await s.until(() => { const r = s.internals().results; return r.length > n || r[r.length - 1] !== before }, 6000)
      const r = s.internals().results
      return r[r.length - 1]
    }
    // Nobody knows where the diamonds are yet: it says so and opens nothing.
    const blind = await run({ a: 'take', item: 'diamond' })
    assert.equal(blind.ok, false)
    assert.match(blind.msg, /^I do not know where diamond is: no opened container holds it and no label matches — 2 containers here not opened yet/)
    assert.match(blind.msg, /furnaces: furnace1/)
    assert.equal(bot.log.opened || 0, 0, 'no container was opened')
    assert.equal(furnaceTaken, 0, 'and the furnace was not emptied (it used to be: "took iron_ingot x9")')
    // Asking the furnace for the wrong thing takes nothing either.
    const wrong = await run({ a: 'take', item: 'diamond', where: 'furnace1' })
    assert.match(wrong.msg, /furnace1's output is iron_ingot x9, not diamond — nothing was taken/)
    assert.equal(furnaceTaken, 0)

    // find knows the label although the chest was never opened…
    const found = await run({ a: 'find', what: 'Diamantes' })
    assert.match(found.msg, /chest\d+ is labelled "Diamantes" \(\d+m \w+ at 4,64,3; not opened yet/)
    // …and the label is an address.
    const took = await run({ a: 'take', item: 'diamond', count: 3, where: 'Diamantes' })
    assert.match(took.msg, /^took diamond x3 from chest\d+ \(9 left there\)$/, 'the diamonds, not the diamond pickaxe')
    // Now it is known, no address is needed.
    const again = await run({ a: 'take', item: 'diamond', count: 1 })
    assert.match(again.msg, /^took diamond x1 from chest\d+ \(8 left there\)$/)
    const list = await run({ a: 'find', what: 'storage' })
    assert.match(list.msg, /^storage: 2 containers, page 1\/1 \(nearest first\): chest\d+ "Diamantes" \d+m \w+ \[diamond x8, diamond_pickaxe x1\]; chest\d+ "Ferro" \d+m \w+$/)
  } finally { s.stop() }
})

test('M1: a go_to stopped by a door that would not open says which door', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(200)
    const { wrapper, skills } = s.internals()
    wrapper.lastJam = { x: 3, y: 64, z: 7, name: 'oak_door', at: Date.now() }
    const walk = skills.goTo.bind(skills)
    skills.goTo = () => walk({ place: 'nowhere I know' }) // fails at once
    await s.internals().executeAction({ a: 'go_to', x: 30, z: 0 }, { threatIds: [], askedBy: null })
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'go_to'), 3000))
    assert.match(s.internals().results.find((r) => r.label === 'go_to').msg, /the oak_door at 3,64,7 would not open \(locked or protected\); there may be another way in$/)
  } finally { s.stop() }
})

// ---------------------------------------------------------------------------
// Combat: room to retreat, and eyes for more than the target
// ---------------------------------------------------------------------------

test('creeper: no hit-and-run with a wall behind — the fight is refused instead of ending inside the blast', async () => {
  const boxed = (p) => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    if (y < 64) return { name: 'stone', boundingBox: 'block', position: p }
    // A wall across the north, two blocks behind the bot, and side walls: only the creeper's side is open.
    const wall = y <= 66 && (z === -2 || Math.abs(x) === 2)
    return wall ? { name: 'stone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
  }
  const events = []
  const bot = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword', blockAt: boxed })
  bot.entities[6] = ent(6, 'creeper', 0.5, 4.5)
  const combat = new AdvancedCombat(bot, { onEvent: (e) => events.push(e) })
  assert.equal((await combat.engage('creeper')).ok, true)
  combat._tick()
  assert.equal(combat.isEngaged, false)
  assert.equal(bot.log.attack.length, 0, 'it never went in')
  assert.match(events[events.length - 1].msg, /no room to back off from the creeper here/)
  assert.equal(events[events.length - 1].result, 'aborted')

  // The same creeper on open ground: one hit, then away — along ground that exists.
  const open = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  open.entities[6] = ent(6, 'creeper', 0.5, 3.0)
  const c2 = new AdvancedCombat(open, {})
  await c2.engage('creeper')
  c2._tick()
  assert.deepEqual(open.log.attack, [6])
  assert.equal(heldKeys(open), 'forward+jump+sprint')
  c2.stop()
})

test('PvP: during a duel a third player diving in with a mace is seen and dodged', async () => {
  let t = 50_000
  const bot = makeBot({ items: [{ name: 'iron_sword' }], held: 'iron_sword' })
  const duelist = ent(2, 'player', 0.5, 3.0, { username: 'Gabriel' })
  const diver = ent(3, 'player', 1.5, 0.5, { username: 'Pedro', y: 74 })
  diver.equipment[0] = { name: 'mace' }
  bot.entities[2] = duelist
  bot.entities[3] = diver
  const events = []
  const combat = new AdvancedCombat(bot, { now: () => t, onEvent: (e) => events.push(e), watch: () => [diver] })
  assert.equal((await combat.engage({ player: 'Gabriel' })).ok, true)
  let v = 0
  let y = 74
  let dodged = null
  for (let i = 0; i < 40 && y > 64; i++) {
    t += 50
    v = (v - 0.08) * 0.98
    y = Math.max(64, y + v)
    diver.position = new Vec3(1.5, y, 0.5)
    combat._tick()
    if (dodged === null && combat.state === 'retreat') dodged = y
  }
  assert.ok(dodged !== null && dodged - 64 > 1.5, `dodged while the diver was still ${dodged !== null ? (dodged - 64).toFixed(1) : '?'} blocks up`)
  assert.ok(events.some((e) => /dodged Pedro's mace smash/.test(e.msg)), JSON.stringify(events.map((e) => e.msg)))
  assert.equal(bot.log.attack.includes(3), false, 'dodging is not attacking: Pedro was never hit')
  combat.stop()
})

// ---------------------------------------------------------------------------
// T5, whole harness: what a decision covers and how long it lasts
// ---------------------------------------------------------------------------

test('T5: "hold" is about the mobs, not the task — it outlives the next tasks, and ends when one of them hits', async () => {
  const bot = simulatedBot({ items: [['bread', 5]] })
  addPlayer(bot, 2, 'Gabriel', -4.5, 0.5)
  bot.toss = async () => { bot.log.tossed = (bot.log.tossed || 0) + 1 }
  const s = startTestSession({ bot, actions: (p) => (/^doing: .*FLEEING by reflex/m.test(p) ? { a: 'hold' } : null) })
  try {
    s.spawn()
    await sleep(200)
    // An exhibit with a view: three zombies that never move.
    const zombies = [0, 1, 2].map((i) => world.addMob(bot, 60 + i, 'zombie', 7.5, i - 1))
    const { system1, sense } = s.internals()
    const flees = () => s.prompts.action.filter((p) => /reflex: started FLEEING/.test(why(p))).length
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'hold' && r.ok), 4000), 'the model answered hold')
    assert.ok(await s.until(() => !system1.fleeing, 6000), 'the reflex stands down once the hold lands')
    assert.equal(flees(), 1)

    // A short job comes and goes. Its own decision ends with it; the hold does not.
    await s.internals().executeAction({ a: 'give', player: 'Gabriel', item: 'bread', count: 1 }, s.internals().buildActionPrompt(['test']))
    assert.ok(await s.until(() => bot.log.tossed === 1 && s.internals().skills.current() === null, 6000))
    await sleep(500)
    assert.equal(system1.fleeing, false, 'it used to bolt here: any finished task wiped the hold')
    // A walk comes and goes, too.
    await s.internals().executeAction({ a: 'go_to', x: 1, z: 3 }, s.internals().buildActionPrompt(['test']))
    assert.ok(await s.until(() => s.internals().results.some((r) => r.label === 'go_to' && r.ok), 6000))
    await sleep(500)
    assert.equal(system1.fleeing, false)
    assert.equal(flees(), 1, 'and the model was not asked again')
    assert.match(line(s.internals().buildActionPrompt(['test']).text, '  you chose hold'), /^ {2}you chose hold \d+s ago about 3 listed threats; the body will not run from them, whatever you do next, unless one of them hurts you\.$/)

    // "Harmless" stops being true when one of them lands a hit.
    sense.noteAttacker(zombies[0])
    assert.ok(await s.until(() => flees() === 2, 4000), 'the body runs again and says so')
  } finally { s.stop() }
})

test('T5 + B3: a resumed task gets its decision back; a decision covers everything the body is running from', async () => {
  const bot = simulatedBot({ items: [['bread', 5]] })
  addPlayer(bot, 2, 'Gabriel', 3.5, 0.5)
  addPlayer(bot, 3, 'Pedro', -3.5, 2.5)
  bot.toss = async () => { bot.log.tossed = (bot.log.tossed || 0) + 1 }
  const s = startTestSession({ bot, actions: (p) => (/^doing: .*FLEEING by reflex/m.test(p) ? { a: 'follow', player: 'Gabriel' } : null) })
  try {
    s.spawn()
    await sleep(200)
    world.addMob(bot, 60, 'zombie', 0.5, 8.5) // stands there, in plain sight
    const { system1, skills } = s.internals()
    const flees = () => s.prompts.action.filter((p) => /reflex: started FLEEING/.test(why(p))).length
    assert.ok(await s.until(() => skills.current()?.label === 'following Gabriel' && !system1.fleeing, 5000), 'the model chose to follow Gabriel instead of running')
    assert.equal(system1.decision.label, 'follow')

    // Pedro wants bread: a side job, with a decision of its own.
    await s.internals().executeAction({ a: 'give', player: 'Pedro', item: 'bread', count: 1 }, s.internals().buildActionPrompt(['test']))
    assert.equal(system1.decision.label, 'give')
    assert.ok(await s.until(() => bot.log.tossed === 1 && skills.current()?.label === 'following Gabriel', 8000), 'bread delivered, back to following')
    await sleep(500)
    assert.equal(system1.decision?.label, 'follow', 'the follow came back with its decision')
    assert.equal(system1.fleeing, false, 'so the zombie it was told to ignore is still ignored')
    assert.equal(flees(), 1)

    // Mid-escape, a chaser that slipped behind a corner is still part of what a decision is about.
    system1.chasers = [{ id: 777, name: 'zombie' }]
    assert.ok(s.internals().buildActionPrompt(['test']).threatIds.includes(777))
    system1.chasers = []
  } finally { s.stop() }
})
