'use strict'
/**
 * Scene 5 under load. A friend talks to Zinc while a horde chases it. Production pacing.
 * Prints how long each reply took and how many action calls the chase made meanwhile.
 *
 *   node audit/repro/11-chat-during-chase.js [modelLatencyMs=0] [seconds=60] [actionLatencyMs]
 *
 * The scripted model is instant by default; pass a latency to see what a real endpoint adds.
 * A third argument makes only the ACTION lane that slow (a struggling endpoint): the chat
 * lane has its own in-flight slot and its own share of the call budget, so replies must not wait.
 */
const { world, simulatedBot, addPlayer, startTestSession, sleep } = require('./_common')
const LATENCY = Number(process.argv[2] || 0)
const SECONDS = Number(process.argv[3] || 60)
const ACTION_LATENCY = process.argv[4] !== undefined ? Number(process.argv[4]) : LATENCY

;(async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['bread', 12]], held: 'iron_sword' })
  let actionCalls = 0
  const s = startTestSession({
    bot,
    actions: () => { actionCalls++; return null },
    chat: (p) => ({ text: 'to correndo de zumbi, ja falo contigo' }),
    cfg: (cfg) => { cfg.inference = { ...cfg.inference, minIntervalMs: 3000, chatMinIntervalMs: 1200, rpm: 18, heartbeatMs: 90000 }; cfg.system1 = { ...cfg.system1, tickMs: 200 }; cfg.behavior = { ...cfg.behavior, chatCooldownMs: 1500 } }
  })
  if (LATENCY > 0 || ACTION_LATENCY > 0) {
    const instant = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      let chat = false
      try { chat = JSON.parse(opts.body).tools?.[0]?.function?.name === 'reply' } catch { /* not ours */ }
      await sleep(chat ? LATENCY : ACTION_LATENCY)
      return instant(url, opts)
    }
  }
  s.spawn(); await sleep(300)
  addPlayer(bot, 9, 'Gabriel', 3.5, 3.5)
  const mobs = []
  let id = 100
  for (let i = 0; i < 24; i++) { const a = (-100 + (200 * i) / 23) * Math.PI / 180; const r = 6 + (i % 6) * 3; mobs.push(world.addMob(bot, id++, 'zombie', 0.5 + Math.sin(a) * r, 0.5 - Math.cos(a) * r)) }
  const sim = setInterval(() => { const me = bot.entity.position; for (const m of mobs) { const dx = me.x - m.position.x; const dz = me.z - m.position.z; const d = Math.hypot(dx, dz) || 1; m.position.x += dx / d * 0.115; m.position.z += dz / d * 0.115 } }, 50)

  const t0 = Date.now()
  const before = actionCalls
  const delays = []
  const asks = [4, 13, 22, 31, 40, 49].filter((t) => t < SECONDS - 8)
  // After the last line the run continues to SECONDS, then waits for the budget window to roll over.
  for (const at of asks) {
    await sleep(Math.max(0, t0 + at * 1000 - Date.now()))
    const said = bot.log.chat.length
    const t = Date.now()
    const brain = s.internals().brain
    const used = brain.calls.filter((c) => t - (c.at ?? c) <= 60000).length
    s.say(`<Gabriel> zinc, tudo bem ai? (${at})`)
    const ok = await s.until(() => bot.log.chat.length > said, 7500)
    delays.push(`+${at}s (budget used ${used}/${brain.rpm}): ` + (ok ? ((Date.now() - t) / 1000).toFixed(1) + ' s' : 'nothing within 7.5 s'))
  }
  await sleep(Math.max(0, t0 + SECONDS * 1000 - Date.now()))
  const atEnd = bot.log.chat.length
  await sleep(12000)
  clearInterval(sim)
  const afterRollover = bot.log.chat.length
  const n = actionCalls - before
  console.log(`model latency ${LATENCY} ms${ACTION_LATENCY !== LATENCY ? ` (action lane ${ACTION_LATENCY} ms)` : ''}, ${SECONDS} s chase by 24 zombies, a friend speaks ${asks.length} times`)
  console.log(`  action-lane calls made by the chase: ${n} (${(n / SECONDS * 60).toFixed(0)} per minute; the budget is 18, of which 4 are reserved for chat)`)
  console.log("  time from the friend's line to Zinc's reply in chat:")
  for (const d of delays) console.log('    ' + d)
  console.log(`  replies in chat at ${SECONDS} s: ${atEnd}; 12 s later, once the one-minute window rolled over: ${afterRollover} (queued lines from one sender are answered together)`)

  s.stop(); process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
