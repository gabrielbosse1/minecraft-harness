'use strict'
// Full-protocol trace of a join, to pinpoint the invalid_player_movement kick
// and the entityDelta parse crash.
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')
process.on('uncaughtException', (e) => { console.log(`[${new Date().toISOString().slice(11,23)}] UNCAUGHT ${e.message}`) })
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)

// trace every client<->server packet name
const states = require('/home/anonymous/minecraft-harness/node_modules/minecraft-protocol/src/states')
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'Trace2', auth: 'offline', version: false })
const t0 = Date.now()
const rel = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`

const proto = bot.protocol
if (proto) {
  // hook the low-level socket write to log packets SENT
  proto.on?.('packet', (name, values) => {
    const brief = { pos: values.position?.[1]?.toFixed?.(1), y: values.y, state: values.state }
    log('TX', name, brief && Object.keys(brief).length ? JSON.stringify(brief) : '')
  })
  proto.prependListener?.('packet', (name) => {
    log('RX', name)
  })
}
bot.once('error', (e) => log(rel(), 'ERR', e.message.split('\n')[0]))
bot.once('kicked', (r) => { log(rel(), 'KICKED', JSON.stringify(r)); setTimeout(() => process.exit(1), 200) })
bot.once('spawn', () => {
  log(rel(), 'SPAWN y=' + bot.entity.position.y.toFixed(1), 'onGround=' + bot.entity.onGround)
  setTimeout(() => { log('STILL ALIVE 12s'); bot.quit(); setTimeout(() => process.exit(0), 200) }, 12000)
})
setTimeout(() => { log('TIMEOUT'); process.exit(2) }, 25000)
