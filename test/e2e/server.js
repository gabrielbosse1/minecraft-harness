/**
 * Local Minecraft server for the loopback check: flying-squid, run as a child
 * process so that its logging (it is loud) goes to a file and a crash in it
 * cannot take the runner down. Driven over IPC by loopback.js.
 *
 * Two flying-squid 1.12.0 defects are patched here, at run time:
 *   1. the tab list is sent to everyone EXCEPT the player who just joined, so
 *      mineflayer ignores every player that was already online (it drops a
 *      player spawn whose uuid it has never seen in player_info);
 *   2. PvP knockback is (victim − attacker) × 5 with no cap, which overflows
 *      the int16 velocity packet from far away and kicks everyone nearby.
 */
'use strict'

const squid = require('flying-squid')
const { Vec3 } = require('vec3')

const PORT = Number(process.env.E2E_MC_PORT || 25599)
const VERSION = process.env.E2E_MC_VERSION || '1.16.5'
const mcData = require('minecraft-data')(VERSION)

const serv = squid.createMCServer({
  motd: 'zinc loopback',
  port: PORT,
  'max-players': 8,
  'online-mode': false,
  logging: false,
  gameMode: 0,
  difficulty: 1,
  worldFolder: undefined,
  generation: { name: 'superflat', options: {} },
  kickTimeout: 10000,
  plugins: {},
  modpe: false,
  'view-distance': 4,
  'player-list-text': { header: { text: '' }, footer: { text: '' } },
  'everybody-op': true,
  'max-entities': 100,
  version: VERSION
})

serv.on('newPlayer', (player) => {
  // (1) also tell the newcomer who is online — before their entities are sent.
  const sendList = serv._sendPlayerList
  serv._sendPlayerList = (toPlayer) => {
    sendList(toPlayer)
    try {
      toPlayer._client.write('player_info', {
        action: 'add_player',
        data: serv.players.map((other) => ({
          uuid: other.uuid,
          name: other.username,
          properties: other.profileProperties,
          gamemode: other.gameMode,
          ping: other._client.latency
        }))
      })
    } catch (err) { console.error('player list patch failed:', err.message) }
  }
  // (2) knockback no stronger than a hard vanilla hit.
  const sendVelocity = player.sendVelocity
  player.sendVelocity = (vel, maxVel) => {
    const len = vel.norm()
    return sendVelocity(len > 8 ? vel.scaled(8 / len) : vel, maxVel)
  }
})

const pos = (p) => ({ x: p.x, y: p.y, z: p.z })
const commands = {
  players: () => serv.players.map((p) => ({ name: p.username, id: p.id, health: p.health, position: pos(p.position) })),
  entity: ({ id }) => {
    const e = serv.entities[id]
    return e ? { exists: true, health: e.health, name: e.name, position: pos(e.position) } : { exists: false }
  },
  summon: ({ name, x, y, z }) => {
    const def = mcData.entitiesByName[name]
    if (!def) throw new Error(`unknown entity ${name}`)
    return { id: serv.spawnMob(def.id, serv.overworld, new Vec3(x, y, z)).id }
  },
  despawn: ({ id }) => { serv.entities[id]?.destroy(); return {} },
  teleport: async ({ name, x, y, z }) => { await serv.getPlayer(name).teleport(new Vec3(x, y, z)); return {} },
  heal: ({ name }) => { serv.getPlayer(name).updateHealth(20); return {} },
  give: ({ name, item, count = 1 }) => {
    const Item = require('prismarine-item')(VERSION)
    const p = serv.getPlayer(name)
    p.inventory.updateSlot(p.inventory.firstEmptyInventorySlot(), new Item(mcData.itemsByName[item].id, count))
    return {}
  }
}

process.on('message', async (m) => {
  if (!m || !m.cmd) return
  try {
    if (m.cmd === 'stop') { try { serv.quit('loopback over') } catch { /* noop */ } process.exit(0) }
    const result = await commands[m.cmd](m.args || {})
    process.send({ id: m.id, result })
  } catch (err) {
    process.send({ id: m.id, error: String(err && err.message ? err.message : err) })
  }
})

serv.on('listening', (port) => process.send({ event: 'listening', port }))
serv.on('error', (err) => { console.error('server error:', err); process.send({ event: 'error', error: String(err.message || err) }) })
// One client misbehaving must not end the run.
process.on('uncaughtException', (err) => { console.error('uncaught (ignored):', err && err.stack ? err.stack : err) })
process.on('unhandledRejection', (err) => { console.error('unhandled (ignored):', err && err.stack ? err.stack : err) })
