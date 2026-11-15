'use strict'

const path = require('node:path')
const http = require('node:http')
const express = require('express')
const { Server } = require('socket.io')
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView')
const { supportedVersions } = require('prismarine-viewer/viewer/lib/version')

// The state IDs of adjacent game versions are not interchangeable. Never use
// prismarine-viewer's implicit "same major" fallback for an unknown version.
function startVisualFeed (bot, { host = '127.0.0.1', port = 3000, viewDistance = 4, snapshot, onError = () => {} } = {}) {
  if (!supportedVersions.includes(bot.version)) throw new Error(`visual feed has no exact assets for Minecraft ${bot.version}`)
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server)
  const page = path.join(__dirname, 'visual_feed')
  const assets = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public')
  app.get('/', (req, res) => res.sendFile(path.join(page, 'index.html')))
  app.get('/feed.js', (req, res) => res.sendFile(path.join(page, 'feed.js')))
  app.get('/state', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(snapshot()) })
  app.use(express.static(assets, { index: false }))
  const point = p => ({ x: p.x + 0.5, y: p.y + 0.15, z: p.z + 0.5 })
  io.on('connection', socket => {
    if (!bot.entity?.position) { socket.disconnect(); return }
    socket.emit('version', bot.version)
    const world = new WorldView(bot.world, Math.max(1, Math.min(8, viewDistance)), bot.entity.position, socket)
    world.listenToBot(bot)
    world.init(bot.entity.position).catch(onError)
    const position = () => {
      if (!bot.entity?.position) return
      socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: bot.entity.pitch, addMesh: false })
      world.updatePosition(bot.entity.position).catch(onError)
    }
    const route = () => {
      if (!bot.entity?.position) return
      const nav = snapshot().navigation
      const steps = nav.path.slice(0, 256).map(point)
      const start = bot.entity.position
      const line = [{ x: start.x, y: start.y + 0.15, z: start.z }, ...steps]
      socket.emit('primitive', line.length > 1 ? { id: 'route', type: 'line', points: line, color: 0x50dcff } : { id: 'route' })
      socket.emit('primitive', steps.length ? { id: 'next', type: 'points', points: [steps[0]], size: 10, color: 0xffdc46 } : { id: 'next' })
      socket.emit('primitive', nav.destination ? { id: 'destination', type: 'points', points: [point(nav.destination)], size: 12, color: 0xff5a50 } : { id: 'destination' })
    }
    bot.on('move', position)
    position(); route()
    const timer = setInterval(route, 500)
    socket.on('disconnect', () => { clearInterval(timer); bot.removeListener('move', position); world.removeListenersFromBot(bot) })
  })
  // Respawns/dimension changes need a new world snapshot and renderer.
  const respawn = () => { for (const socket of io.sockets.sockets.values()) socket.conn.close() }
  bot.on('respawn', respawn)
  server.on('error', onError)
  server.listen(port, host)
  return { server, close () { bot.removeListener('respawn', respawn); io.close(); server.close() } }
}
module.exports = { startVisualFeed }
