/**
 * Probe: does the real mineflayer stack connect to the live 26.3 loopback
 * server as the given (offline) player? Prints what it observes then quits.
 *   node mc-probe.js [name] [seconds]
 */
'use strict'
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')

const name = process.argv[2] || 'Probe'
const hold = Number(process.argv[3] || 25)

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25570,
  username: name,
  auth: 'offline',
  version: false // auto-detect
})

bot.once('error', (e) => {
  console.log('PROBE_ERROR', e.message)
  try { bot.quit() } catch { /* */ }
  setTimeout(() => process.exit(1), 500)
})
bot.once('kicked', (r) => {
  console.log('PROBE_KICKED', JSON.stringify(r))
  process.exit(2)
})
bot.once('spawn', () => {
  const pos = bot.entity.position
  console.log('PROBE_SPAWN version=' + bot.version + ' proto=' + (bot.protocol ? bot.protocol.protocolVersion : '?'))
  console.log('PROBE_POS ' + pos.floor().x + ',' + pos.floor().y + ',' + pos.floor().z)
  const g = bot.game
  console.log('PROBE_GAME dim=' + g.dimension + ' gamemode=' + g.gameType + ' time=' + g.time + ' isDaytime=' + g.isDaytime)
  const ground = bot.blockAt(bot.entity.position.floored().sub({ x: 0, y: 1, z: 0 }))
  console.log('PROBE_GROUND', ground && ground.name)
  const nearby = bot.nearestEntity((e) => e.type === 'hostile')
  console.log('PROBE_HOSTILE', nearby ? nearby.name + ' dist=' + bot.distanceTo(nearby).toFixed(1) : 'none')
  const inv = bot.inventoryItems()
  console.log('PROBE_INV', inv.map((i) => i.name + 'x' + i.count).join(',') || '(empty)')
  // movement test: walk forward 3s
  bot.look(0, 0)
  bot.setControlState('forward', true)
  setTimeout(() => {
    bot.setControlState('forward', false)
    const p2 = bot.entity.position
    console.log('PROBE_MOVERESULT from=' + pos.x.toFixed(1) + ',' + pos.z.toFixed(1) + ' to=' + p2.x.toFixed(1) + ',' + p2.z.toFixed(1))
    console.log('PROBE_CHAT_TRY')
    bot.chat('oi, sou um probe')
  }, 3000)
  setTimeout(() => {
    console.log('PROBE_OK')
    bot.quit()
    setTimeout(() => process.exit(0), 500)
  }, hold * 1000)
})
