/**
 * Gabriel — a plain mineflayer client standing in for a second (human) player.
 * Long-lived: connect, then read commands from stdin (one per line):
 *   say <text>          chat a message
 *   tp <x> <y> <z>      teleport (for positioning; not a bot capability)
 *   look                report where Gabriel looks (debug)
 *   status              report pos + nearest entities
 *   quit                graceful exit
 * Logs everything to stdout with timestamps.
 */
'use strict'
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'Gabriel', auth: 'offline', version: false })

bot.once('error', (e) => { log('GABRIEL_ERROR', e.message) })
bot.once('kicked', (r) => { log('GABRIEL_KICKED', JSON.stringify(r)) })
bot.once('end', (r) => { log('GABRIEL_END', r || 'ended') })
bot.on('chat', (msg, name) => log('CHAT from', name, ':', msg.message))
bot.on('entityHurt', (e) => log('GABRIEL_HURT by', e.attacker ? e.attacker.name : '?'))
bot.on('death', () => log('GABRIEL_DEATH'))
bot.on('respawn', () => { const p = bot.entity?.position; log('GABRIEL_RESPAWN', p && `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`) })

bot.once('spawn', () => {
  const p = bot.entity.position
  log('GABRIEL_SPAWNED', `v=${bot.version}`, `pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`)
  // move near the base entrance so chat distances are small
  const mc = require('mineflayer-pathfinder')
  bot.pathfinder = mc(bot)
  try {
    bot.pathfinder.lookForPath(new (require('vec3').Vec3)(0, 80, 13), 10, { goal: new (require('mineflayer-pathfinder').Goal)( { x: 0, y: 80, z: 13 } ) })
  } catch (e) { log('GABRIEL_PATH_ERR', e.message) }
})

require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  try {
    switch (cmd) {
      case 'say': bot.chat(rest.join(' ')); break
      case 'tell': bot.chat(`<${rest[0]}> ${rest.slice(1).join(' ')}`); break
      case 'tp': if (bot.entity) { const [x, y, z] = rest.map(Number); bot.lookAt(new (require('vec3').Vec3)(x, y, z)); try { bot.teleport ? null : null } catch {} log('tp not a client ability — use /tp via RCON for Gabriel'); } break
      case 'status': {
        const p = bot.entity && bot.entity.position
        const near = bot.nearestEntity((e) => e.type === 'hostile' || e.type === 'player' || e.name === 'ZincAI')
        log('GABRIEL_STATUS', p ? `pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : 'no pos', near ? `nearest=${near.name} d=${bot.distanceTo(near).toFixed(1)}` : 'near=none')
        break
      }
      case 'look': {
        const v = bot.entity?.position
        const yaw = bot.yaw, pitch = bot.pitch
        log('GABRIEL_LOOK', v ? `pos=${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)} yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}` : 'no pos')
        break
      }
      case 'swing': bot.swingArm(); break
      case 'attack': {
        const t = bot.nearestEntity((e) => e.name === rest[0] || e.type === rest[0])
        if (t) { bot.lookAt(t.position.offset(0, 1, 0)); bot.attack(t) } else log('attack: target not found')
        break
      }
      case 'eat': {
        const food = bot.inventory.items().find((i) => i.name === rest[0] || (i.name || '').includes(rest[0]))
        if (food) { const slot = bot.inventory.slotOfItem(food); bot.equip(food, 'hand'); bot.activateItem() } else log('eat: item not found')
        break
      }
      case 'give': {
        // drop an item for the bot to pick up: <item> <count>
        const it = bot.inventory.items().find((i) => i.name === rest[0])
        if (it) { bot.toss(Number(rest[1]) || 1, it) } else log('give: item not found')
        break
      }
      case 'health': log('GABRIEL_HEALTH', bot.health, 'food', bot.food)
      case 'quit': bot.quit(); setTimeout(() => process.exit(0), 500); break
      default: log('unknown cmd', cmd)
    }
  } catch (e) { log('CMD_ERR', cmd, e.message) }
})
