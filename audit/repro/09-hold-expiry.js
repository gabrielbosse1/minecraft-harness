'use strict'
/**
 * Scene 2, the exhibit. Three hostile mobs that never move, with line of sight to the bot
 * (an un-named collection behind a low fence, a pen with a gap…). The model answers "hold".
 *
 * Before: the acknowledgement lasted 120 s, then the bot bolted with no model call saying so.
 * Now: "hold" stands for 30 minutes, ends early only for a reason (a hit, a lit fuse, something
 * new), and whenever the body starts running again the model is told — including when the
 * decision simply ran out. The expiry is forced by hand here.
 */
const { world, simulatedBot, startTestSession, sleep, line } = require('./_common')

;(async () => {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const calls = []
  const s = startTestSession({
    bot,
    actions: (p) => { const act = /^doing: .*FLEEING by reflex/m.test(p) ? { a: 'hold' } : null; calls.push(`${line(p, 'why now:').slice(0, 150)}  → ${act ? 'hold' : 'idle'}`); return act },
    cfg: (cfg) => { cfg.system1 = { ...cfg.system1, tickMs: 200 }; cfg.inference = { ...cfg.inference, minIntervalMs: 1000 } }
  })
  s.spawn(); await sleep(300)
  for (let i = 0; i < 3; i++) world.addMob(bot, 60 + i, 'zombie', 7.5, i - 1)
  await s.until(() => calls.some((c) => /→ hold/.test(c)), 6000)
  await sleep(1500)
  const system1 = s.internals().system1
  console.log(`1) model answered "hold": fleeing=${system1.fleeing}; the prompt now says: ${system1.decisionLine()}`)

  let before = bot.entity.position.clone()
  let seen = calls.length
  await sleep(4000)
  console.log(`2) four seconds later, same three zombies: the bot moved ${bot.entity.position.distanceTo(before).toFixed(1)} blocks; new model calls: ${calls.length - seen}`)

  // The safety net runs out (30 minutes in production).
  before = bot.entity.position.clone()
  seen = calls.length
  for (const h of system1._holds.values()) h.until = Date.now() - 1
  await sleep(2500)
  const told = calls.slice(seen).filter((c) => /started FLEEING/.test(c))
  console.log(`3) the decision ran out: the bot ran ${bot.entity.position.distanceTo(before).toFixed(1)} blocks; model calls announcing it: ${told.length}`)
  for (const c of told) console.log('      ' + c)
  await sleep(3000)
  console.log('\nevery action-lane call in this run:'); for (const c of calls) console.log('   ' + c)
  s.stop(); process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
