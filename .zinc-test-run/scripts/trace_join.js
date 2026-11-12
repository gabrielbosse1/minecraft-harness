/**
 * Minimal join-only probe with protocol tracing, to diagnose the
 * "Invalid move player packet received" kick on 26.3.
 */
'use strict'
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')

process.env.DEBUG = process.env.DEBUG || 'minecraft-protocol:*'
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'TraceBot', auth: 'offline', version: false })
const t0 = Date.now()
const rel = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`

bot.once('error', (e) => log(rel(), 'ERROR', e.message.split('\n')[0]))
bot.once('kicked', (r) => { log(rel(), 'KICKED', JSON.stringify(r)); setTimeout(() => process.exit(1), 300) })
bot.once('spawn', () => {
  log(rel(), 'SPAWN at', bot.entity.position)
  // report entity y over time to see if physics drifts
  const iv = setInterval(() => {
    const p = bot.entity && bot.entity.position
    if (p) console.error(`[pos] ${rel()} y=${p.y.toFixed(3)} onGround=${bot.entity.onGround}`)
  }, 250)
  setTimeout(() => { clearInterval(iv); log('STILL CONNECTED after 25s — success'); bot.quit(); setTimeout(() => process.exit(0), 300) }, 25000)
})
setTimeout(() => { log('TIMEOUT 40s'); process.exit(2) }, 40000)
