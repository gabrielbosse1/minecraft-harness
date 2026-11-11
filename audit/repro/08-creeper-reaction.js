'use strict'
/**
 * Scene 4. A creeper appears behind the bot (the bot faces north, the creeper is south) on open ground.
 * How long until the body moves, and does the creeper ever get to light its fuse? No model involved.
 */
const { world, simulatedBot, startTestSession, sleep } = require('./_common')

async function trial (dist) {
  const bot = simulatedBot({ items: [['iron_sword']], held: 'iron_sword' })
  const s = startTestSession({ bot, actions: () => null, cfg: (cfg) => { cfg.system1 = { ...cfg.system1, tickMs: 200 }; cfg.inference = { ...cfg.inference, minIntervalMs: 3000 } } })
  s.spawn(); await sleep(250 + Math.random() * 200)
  bot.entity.yaw = 0
  const start = bot.entity.position.clone()
  const c = world.addMob(bot, 50, 'creeper', 0.5, 0.5 + dist, { metadata: {} })
  const t0 = Date.now()
  let firstMove = null; let lit = false
  const sim = setInterval(() => { // creeper walks at 2.5 m/s and starts its fuse inside 3 blocks
    const me = bot.entity.position
    const dx = me.x - c.position.x; const dz = me.z - c.position.z; const d = Math.hypot(dx, dz)
    if (d < 3) { lit = true; c.metadata = { 16: 1 } } else { c.position.x += dx / d * 0.125; c.position.z += dz / d * 0.125 }
    if (firstMove === null && me.distanceTo(start) > 0.05) firstMove = Date.now() - t0
  }, 50)
  await sleep(1700)
  clearInterval(sim)
  const out = { firstMove, gap: Math.hypot(bot.entity.position.x - c.position.x, bot.entity.position.z - c.position.z), lit }
  s.stop()
  return out
}

;(async () => {
  for (const d of [10, 4, 3.2]) {
    const rs = []
    for (let i = 0; i < 6; i++) rs.push(await trial(d))
    console.log(`creeper appears ${d} blocks behind: body moves after ${Math.min(...rs.map((r) => r.firstMove))}–${Math.max(...rs.map((r) => r.firstMove))} ms; gap 1.7 s later ${Math.min(...rs.map((r) => r.gap)).toFixed(1)}–${Math.max(...rs.map((r) => r.gap)).toFixed(1)} blocks; fuse lit in ${rs.filter((r) => r.lit).length}/6 runs`)
  }
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
