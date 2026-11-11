'use strict'
/**
 * Scene 1. 24 zombies + 3 skeletons converge on the bot on open, flat ground.
 * Production pacing (3 s spacing, 18 rpm). The scripted model always answers "idle" (= keep fleeing).
 * Prints: how often the model is called and why, what it is shown, and how big a call is.
 *
 *   node audit/repro/04-horde-call-rate.js [seconds=40]
 */
const { req, world, simulatedBot, startTestSession, sleep, line } = require('./_common')
const api = req('zincai/api_wrapper')
const SECONDS = Number(process.argv[2] || 40)

;(async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['bread', 12], ['shield'], ['golden_apple', 2]], held: 'iron_sword' })
  const calls = []
  const s = startTestSession({
    bot,
    actions: (p) => { calls.push({ t: Date.now(), p }); return null },
    cfg: (cfg) => { cfg.inference = { ...cfg.inference, minIntervalMs: 3000, chatMinIntervalMs: 1200, rpm: 18, heartbeatMs: 90000 }; cfg.system1 = { ...cfg.system1, tickMs: 200 } }
  })
  s.spawn(); await sleep(300)
  const t0 = Date.now()
  const mobs = []
  let id = 100
  for (let i = 0; i < 24; i++) { const a = (-100 + (200 * i) / 23) * Math.PI / 180; const r = 6 + (i % 6) * 3; mobs.push(world.addMob(bot, id++, 'zombie', 0.5 + Math.sin(a) * r, 0.5 - Math.cos(a) * r)) }
  for (let i = 0; i < 3; i++) mobs.push(world.addMob(bot, id++, 'skeleton', 14 + i * 2, -9))
  let closest = Infinity
  const sim = setInterval(() => { // zombies 2.3 m/s, skeletons hold 8 blocks
    const me = bot.entity.position
    for (const m of mobs) {
      const dx = me.x - m.position.x; const dz = me.z - m.position.z; const d = Math.hypot(dx, dz) || 1
      closest = Math.min(closest, d)
      if (m.name === 'skeleton' && d < 8) continue
      m.position.x += dx / d * 0.115; m.position.z += dz / d * 0.115
    }
  }, 50)
  await sleep(SECONDS * 1000)
  clearInterval(sim)
  const mine = calls.filter((c) => c.t >= t0)
  console.log(`${SECONDS} s chase, model always "idle": ${mine.length} action-lane calls = ${(mine.length / SECONDS * 60).toFixed(0)} per minute; closest any mob got: ${closest.toFixed(1)} blocks\n`)
  for (const c of mine) console.log(`  +${((c.t - t0) / 1000).toFixed(0).padStart(2)}s  ${line(c.p, 'why now:').slice(0, 110)}\n        ${line(c.p, 'threats:').slice(0, 110)}`)
  const first = mine.find((c) => /FLEEING by reflex/.test(c.p)) || mine[0]
  console.log('\n--- the first prompt of the episode, verbatim ---\n' + first.p)
  const tok = (chars) => Math.round(chars / 3.7)
  const index = req('zincai/index.js')
  const tools = JSON.stringify(api.createZincTools())
  console.log(`\nsize of one action call (≈3.7 chars/token): system ${tok(index.SYSTEM_PROMPT.length)} + tools ${tok(tools.length)} + snapshot ${tok(first.p.length)} ≈ ${tok(index.SYSTEM_PROMPT.length + tools.length + first.p.length)} input tokens`)
  s.stop(); process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
