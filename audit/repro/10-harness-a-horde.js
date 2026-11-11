'use strict'
/**
 * The horde of script 04 against harness A (src/, "Zinc"), production pacing, model always idle.
 * Shows the call rate and everything this harness lets the model see.
 */
const { req, world, simulatedBot, sleep } = require('./_common')
const { startZincSession } = req('test/helpers/zincSession')
const { SYSTEM_PROMPT } = req('src/systemPrompt')
const SECONDS = Number(process.argv[2] || 40)

;(async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['bread', 12]], held: 'iron_sword' })
  const calls = []
  const s = startZincSession({
    bot,
    model: (p) => { calls.push({ t: Date.now(), p }); return { a: 'idle' } },
    cfg: (cfg) => Object.assign(cfg, { inferenceMinIntervalMs: 3000, inferenceIdleIntervalMs: 15000, inferenceTickMs: 500, reflexTickMs: 200, chatCooldownMs: 3000 })
  })
  s.spawn(); await sleep(400)
  const t0 = Date.now()
  const mobs = []
  let id = 100
  for (let i = 0; i < 24; i++) { const a = (-100 + (200 * i) / 23) * Math.PI / 180; const r = 6 + (i % 6) * 3; mobs.push(world.addMob(bot, id++, 'zombie', 0.5 + Math.sin(a) * r, 0.5 - Math.cos(a) * r)) }
  const sim = setInterval(() => { const me = bot.entity.position; for (const m of mobs) { const dx = me.x - m.position.x; const dz = me.z - m.position.z; const d = Math.hypot(dx, dz) || 1; m.position.x += dx / d * 0.115; m.position.z += dz / d * 0.115 } }, 50)
  await sleep(SECONDS * 1000)
  clearInterval(sim)
  const mine = calls.filter((c) => c.t >= t0)
  const tok = (chars) => Math.round(chars / 3.7)
  console.log(`harness A, ${SECONDS} s chase by 24 zombies, model always "idle": ${mine.length} calls = ${(mine.length / SECONDS * 60).toFixed(0)} per minute`)
  console.log(`one call ≈ ${tok(SYSTEM_PROMPT.length)} (system) + ${tok(mine[0].p.length)} (user) input tokens\n`)
  console.log('--- the first user message of the episode, complete ---\n' + mine[0].p)
  console.log('\n--- a later one ---\n' + mine[Math.min(4, mine.length - 1)].p)
  s.stop(); process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
