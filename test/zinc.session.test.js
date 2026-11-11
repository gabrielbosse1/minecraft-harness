/**
 * Harness A ("Zinc", src/) end to end: the real ZincAgent against a simulated
 * bot and a scripted model that reads the prompt. These pin the owner's rule
 * for the small harness too:
 *
 *   - the body flees from every real threat until the model decides;
 *   - nothing is ever attacked unless the model says so, and a player only
 *     when the model names that exact player.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const world = require('./helpers/world')
const { simulatedBot, addPlayer, sleep } = require('./helpers/session')
const { startZincSession } = require('./helpers/zincSession')

const has = (p, re) => re.test(p)

test('A: a zombie appears — the body flees and reports; idle keeps fleeing; only "attack" starts a fight', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  let fight = false
  const s = startZincSession({
    bot,
    model: (p) => (fight && has(p, /^threats /m) && !has(p, /"type":"attack"/) ? { a: 'attack', n: 'zombie' } : { a: 'idle' })
  })
  try {
    s.spawn()
    await sleep(200)
    assert.equal(s.prompts.length, 0, 'a quiet server costs no tokens')
    const zombie = world.addMob(bot, 7, 'zombie', 0.5, 5.5)
    let hits = 0
    bot.on('test_attack', (e) => {
      if (e === zombie && ++hits === 3) { bot.emit('entityDead', zombie); delete bot.entities[7]; bot.emit('entityGone', zombie) }
    })

    assert.ok(await s.until(() => s.agent.reflex.fleeing, 2000), 'flee reflex')
    assert.equal(s.agent.arbiter.owner(), 'survival')
    assert.ok(await s.until(() => s.prompts.length >= 1, 2000), 'the model is woken')
    const told = s.prompts[0]
    assert.match(told, /^threats 1 — zombie \(\d+m \w+\) — you are fleeing$/m)
    assert.match(told, /"type":"threat","msg":"fleeing from 1 — zombie/)
    // It answered idle: that means keep running, and still no swing.
    await sleep(400)
    assert.equal(s.agent.reflex.fleeing, true, 'idle keeps fleeing')
    assert.equal(bot.log.attack.length, 0, 'no attack without the model')

    // Now the model decides to fight (the next wake-up carries the threats line).
    fight = true
    s.say('<Gabriel> zinc mata ele')
    assert.ok(await s.until(() => bot.log.attack.length > 0, 8000), 'the fight starts only now')
    assert.equal(s.agent.reflex.fleeing, false, 'the decision ends the flee')
    assert.ok(await s.until(() => !bot.entities[7], 8000), 'zombie killed')
    assert.ok(bot.log.attack.every((id) => id === 7))
    assert.ok(await s.until(() => s.prompts.some((p) => has(p, /"type":"combat","msg":"zombie down"/)), 4000), 'the outcome is reported')
    assert.ok(!s.prompts.some((p) => has(p, /"msg":"hit zombie/)), 'single hits never reach the model')
    assert.ok(await s.until(() => s.agent.arbiter.owner() === 'idle', 2000), 'nothing is left held')
    assert.ok(Object.values(bot.controls).every((v) => !v), `keys released: ${JSON.stringify(bot.controls)}`)
  } finally { s.stop() }
})

test('A: a player hits the bot — it backs off and says who; vague attacks never land on a player', async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const gabriel = addPlayer(bot, 2, 'Gabriel', 2.5, 0.5, 'diamond_sword')
  addPlayer(bot, 3, 'Pedro', -2.5, 0.5, 'bow') // a bystander with a bow
  const answers = []
  const s = startZincSession({
    bot,
    model: (p) => {
      if (!has(p, /Gabriel \(\d+m \w+; player, hit you\)/)) return { a: 'idle' }
      const refused = (p.match(/"type":"action_err","a":"attack"/g) || []).length + answers.filter((a) => a === 'refused').length
      if (has(p, /name_the_player|no_target/)) answers.push('refused')
      const n = answers.filter((a) => a === 'refused').length
      if (has(p, /"type":"attack","n":"Gabriel"/)) return { a: 'idle' }
      if (n === 0 && refused === 0) return { a: 'attack', n: 'player' } // refused: no name
      if (n === 1) return { a: 'attack', n: 'any' } // refused: "any" is never a player
      return { a: 'attack', n: 'Gabriel' } // the explicit decision
    }
  })
  try {
    s.spawn()
    await sleep(250)
    assert.equal(s.agent.reflex.fleeing, false, 'armed players standing nearby are not threats')
    assert.equal(s.prompts.length, 0)

    bot.health = 17
    bot.emit('health')
    bot.emit('entityHurt', bot.entity, gabriel) // the server names the source (1.19.4+)
    assert.ok(await s.until(() => s.agent.reflex.fleeing, 2000), 'it runs from whoever hit it')
    assert.ok(await s.until(() => s.prompts.length >= 1, 2000))
    assert.match(s.prompts[0], /"type":"hurt","msg":"hit by player Gabriel","hp":17/)
    assert.ok(!/Pedro/.test(s.prompts[0]), 'the bystander is not mentioned')
    assert.equal(bot.log.attack.length, 0, 'no retaliation by reflex')

    assert.ok(await s.until(() => s.prompts.some((p) => has(p, /"why":"name_the_player"/)), 6000), '"player" is refused with a reason')
    assert.ok(await s.until(() => s.prompts.some((p) => has(p, /"why":"no_target"/)), 6000), '"any" never matches a player')
    assert.equal(bot.log.attack.length, 0)
    assert.ok(await s.until(() => bot.log.attack.length > 0, 10_000), 'the named duel')
    assert.ok(bot.log.attack.every((id) => id === 2), 'only Gabriel, never the bystander')
  } finally { s.stop() }
})

test('A: on a server that never names the attacker, the one who swung is blamed — as a guess', async () => {
  const bot = simulatedBot()
  const gabriel = addPlayer(bot, 2, 'Gabriel', 2.0, 0.5)
  const s = startZincSession({ bot })
  try {
    s.spawn()
    await sleep(200)
    bot.emit('entitySwingArm', gabriel)
    bot.health = 18
    bot.emit('health') // flying-squid and some plugins send nothing else
    assert.ok(await s.until(() => s.prompts.length >= 1, 2000))
    assert.match(s.prompts[0], /"type":"hurt","msg":"probably hit by player Gabriel","hp":18/)
    assert.ok(await s.until(() => s.agent.reflex.fleeing, 1000))
    assert.equal(bot.log.attack.length, 0)
  } finally { s.stop() }
})

test('A: PT-BR chat — "zinc vem aqui" carries the speaker\'s position; the walk does not block the model; accents survive', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 12.5, 0.5)
  addPlayer(bot, 3, 'Pedro', -30.5, 0.5)
  const s = startZincSession({
    bot,
    model: (p) => {
      if (has(p, /"type":"move".*"ok":true/)) return { a: 'say', t: 'Cheguei! Você tá aí?' }
      if (has(p, /"msg":"zinc\?"/)) return { a: 'say', t: 'já vou, peraí' }
      const m = /"user":"Gabriel","msg":"zinc vem aqui","at":"(-?\d+),(-?\d+),(-?\d+)"/.exec(p)
      if (m) return { a: 'move', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    await sleep(200)
    s.say('<Pedro> alguém tem ferro?') // not for the bot: context only, no call
    await sleep(200)
    assert.equal(s.prompts.length, 0, 'chatter between others does not wake the model')
    s.say('<Gabriel> zinc vem aqui')
    assert.ok(await s.until(() => bot.pathfinder.goal, 2000), 'walking')
    s.say('<Gabriel> zinc?') // asked again while on the way
    assert.ok(await s.until(() => bot.log.chat.includes('já vou, peraí'), 3000), 'answered while walking')
    assert.ok(await s.until(() => bot.log.chat.includes('cheguei! você tá aí?'), 8000), `arrival reported: ${JSON.stringify(bot.log.chat)}`)
    assert.ok(bot.entity.position.distanceTo(bot.entities[2].position) <= 3, 'next to Gabriel')
  } finally { s.stop() }
})

test('A: a malformed answer does not eat the chat line it was about', async () => {
  const bot = simulatedBot()
  addPlayer(bot, 2, 'Gabriel', 3.5, 0.5)
  let calls = 0
  const s = startZincSession({ bot, model: () => (++calls === 1 ? 'sure! let me help with that' : { a: 'say', t: 'oi' }) })
  try {
    s.spawn()
    await sleep(150)
    s.say('<Gabriel> zinc, oi')
    assert.ok(await s.until(() => bot.log.chat.includes('oi'), 4000), 'answered on the retry')
    assert.match(s.prompts[1], /"msg":"zinc, oi"/, 'the second call still shows the line')
  } finally { s.stop() }
})

test('A: a dropped connection is retried under the same name; a whitelist kick is not', async () => {
  const first = simulatedBot()
  const s = startZincSession({ bot: first })
  try {
    s.spawn()
    await sleep(150)
    assert.equal(s.created(), 1)
    const second = s.nextBot(simulatedBot())
    first.emit('end', 'socketClosed')
    assert.ok(await s.until(() => s.created() === 2, 2000), 'reconnected')
    assert.equal(s.exits.length, 0)
    second.emit('spawn')
    await sleep(150)
    assert.equal(s.agent.started, true)
    // The new session has a working body: a zombie makes it flee.
    world.addMob(second, 9, 'zombie', 0.5, 5.5)
    assert.ok(await s.until(() => s.agent.reflex?.fleeing, 2000), 'reflexes run on the new connection')
    // Kicked for a reason a retry cannot fix.
    second.emit('kicked', JSON.stringify({ text: 'You are not whitelisted on this server!' }))
    assert.deepEqual(s.exits, [{ reason: 'kicked', code: 1 }])
    assert.equal(s.created(), 2, 'no further attempt')
    first.stopSim()
  } finally { s.stop() }
})

test('A: a failed first join is still fatal — no retry, no rename', async () => {
  const s = startZincSession({ bot: simulatedBot() })
  try {
    s.bot.emit('kicked', JSON.stringify({ text: 'You are not whitelisted on this server!' }))
    await sleep(100)
    assert.deepEqual(s.exits, [{ reason: 'join-failed', code: 1 }])
    assert.equal(s.created(), 1)
  } finally { s.stop() }
})

test('A: a response from a dropped session is ignored and cannot unlock a second in-flight call', async () => {
  const first = simulatedBot()
  let answerOld
  const oldReply = new Promise((resolve) => { answerOld = resolve })
  let calls = 0
  const s = startZincSession({
    bot: first,
    model: (_p, n) => {
      calls = n
      return n === 1 ? oldReply : { a: 'say', t: 'new session' }
    }
  })
  try {
    s.spawn()
    await sleep(150)
    s.say('<Gabriel> zinc old request')
    assert.ok(await s.until(() => calls === 1, 2000), 'old request is in flight')
    assert.equal(s.agent._inferBusy, true)

    const next = simulatedBot()
    first.emit('end', 'socketClosed')
    s.nextBot(next)
    assert.ok(await s.until(() => s.created() === 2, 2000), 'reconnected')
    s.spawn()
    await sleep(100)
    s.say('<Gabriel> zinc new request')
    await sleep(150)
    assert.equal(calls, 1, 'one request at a time, even across reconnect')
    assert.equal(s.agent._inferBusy, true, 'the old request still owns the lock')

    answerOld({ a: 'say', t: 'stale answer' })
    assert.ok(await s.until(() => calls >= 2, 2000), 'the queued new-session prompt is sent after the stale call settles')
    assert.ok(await s.until(() => next.log.chat.includes('new session'), 2000), 'the new session acts on its own answer')
    assert.ok(!first.log.chat.includes('stale answer'))
    assert.ok(!next.log.chat.includes('stale answer'), 'the old response never controls the new bot')
  } finally {
    // If an assertion failed before the response, do not leave the serialized
    // call and its simulated bot timer hanging around.
    answerOld?.({ a: 'idle' })
    s.stop()
  }
})
