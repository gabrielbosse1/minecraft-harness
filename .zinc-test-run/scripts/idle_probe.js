/**
 * Do-nothing probe: connects, spawns, then idles (no movement, no physics
 * beyond what mineflayer does by default). Used to isolate whether the
 * invalid_player_movement kick is spawn-position-driven or physics-driven.
 * Args: [seconds]
 */
'use strict'
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')
const secs = Number(process.argv[2] || 20)
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'IdleBot', auth: 'offline', version: false })
const t0 = Date.now()
const rel = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`
bot.once('error', (e) => log(rel(), 'ERROR', e.message.split('\n')[0]))
bot.once('kicked', (r) => { log(rel(), 'KICKED', JSON.stringify(r.value?.translate?.value || r)); process.exit(1) })
bot.once('spawn', () => {
  log(rel(), 'SPAWN at', `${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`, 'onGround=' + bot.entity.onGround)
  const iv = setInterval(() => {
    const p = bot.entity && bot.entity.position
    if (p) console.error(`[pos] ${rel()} y=${p.y.toFixed(2)} onGround=${bot.entity.onGround}`)
  }, 500)
  setTimeout(() => { clearInterval(iv); log('SURVIVED', secs, 's idle — no kick'); bot.quit(); setTimeout(() => process.exit(0), 300) }, secs * 1000)
})
setTimeout(() => { log('TIMEOUT'); process.exit(2) }, (secs + 15) * 1000)
