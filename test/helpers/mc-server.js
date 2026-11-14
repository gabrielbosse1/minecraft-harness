/**
 * test/helpers/mc-server.js — real offline Minecraft 1.21.4 server helper
 * backed by flying-squid for end-to-end gameplay simulation tests.
 *
 * Loads flying-squid without attaching its global stdin readline prompt,
 * listens on an ephemeral localhost port, and exposes direct world, entity,
 * inventory, health, chat, and second-player helpers over real TCP packets.
 */
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')

const MC_VERSION = '1.21.4'

let cachedFlyingSquid = null
let cachedDefaultSettings = null
const leakedSquidIntervals = new Set()
let intervalPatchInstalled = false

function patchFlyingSquidLeakedIntervals () {
  if (intervalPatchInstalled) return
  intervalPatchInstalled = true
  const origSetInterval = global.setInterval
  global.setInterval = function patchedSetInterval (fn, delay, ...args) {
    const handle = origSetInterval.call(this, fn, delay, ...args)
    // flying-squid's login.js starts a 5s player_info latency interval without
    // storing the handle or clearing it on logout, preventing Node test exit.
    if (delay === 5000 && typeof fn === 'function' && /update_latency|player_info/.test(String(fn))) {
      handle.unref?.()
      leakedSquidIntervals.add(handle)
    }
    return handle
  }
}

function withSuppressedReadline (fn) {
  patchFlyingSquidLeakedIntervals()
  const origCreateInterface = readline.createInterface
  readline.createInterface = () => ({
    setPrompt () {},
    prompt () {},
    on () { return this },
    once () { return this },
    close () {},
    pause () {}
  })
  try {
    return fn()
  } finally {
    readline.createInterface = origCreateInterface
  }
}

function loadFlyingSquid () {
  if (cachedFlyingSquid) return { mcServer: cachedFlyingSquid, defaultSettings: cachedDefaultSettings }
  withSuppressedReadline(() => {
    cachedFlyingSquid = require('flying-squid')
    cachedDefaultSettings = require('flying-squid/config/default-settings.json')
    // Disable flying-squid's playerdata disk writes so worldFolder:false never
    // creates a ./false/playerdata directory or leaks inventory across tests.
    try {
      const playerDat = require('flying-squid/src/lib/playerDat')
      playerDat.save = async () => {}
    } catch { /* noop */ }
  })
  return { mcServer: cachedFlyingSquid, defaultSettings: cachedDefaultSettings }
}

function getFreePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function waitFor (fn, { timeoutMs = 15_000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const val = await fn()
      if (val) return val
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? ` (${lastErr.message})` : ''}`)
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function resolveBlockStateId (mcData, Block, blockName, props = null) {
  const def = mcData.blocksByName[blockName]
  if (!def) throw new Error(`Unknown Minecraft ${MC_VERSION} block: ${blockName}`)
  if (!props || !Object.keys(props).length) return def.defaultState
  const block = Block.fromProperties(def.id, props, 0)
  return block.stateId
}

/**
 * Start a real lightweight Minecraft 1.21.4 server (flying-squid) on a random
 * free localhost port with a superflat world and zero disk world storage.
 */
async function startMcServer ({
  version = MC_VERSION,
  worldHeight = 64,
  gameMode = 0,
  difficulty = 2,
  viewDistance = 4
} = {}) {
  const { mcServer, defaultSettings } = loadFlyingSquid()
  const port = await getFreePort()
  const mcData = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)
  const Item = require('prismarine-item')(version)

  // flying-squid's log.js calls console.log on info/warn/error; mute noisy
  // startup lines unless DEBUG_MC_SERVER=1 is set.
  const quiet = process.env.DEBUG_MC_SERVER !== '1'

  const serv = withSuppressedReadline(() => mcServer.createMCServer({
    ...defaultSettings,
    port,
    'online-mode': false,
    version,
    generation: { name: 'superflat', options: { worldHeight } },
    'max-players': 8,
    'view-distance': viewDistance,
    motd: 'ZincAI Simulation Server',
    logging: false,
    gameMode,
    difficulty,
    plugins: {},
    worldFolder: false
  }))

  if (quiet) {
    serv.log = () => {}
    serv.info = () => {}
    serv.warn = () => {}
    serv.err = () => {}
    serv.debug = () => {}
  }

  let closed = false

  // flying-squid's legacy playSound writes pre-1.21.4 sound_effect frames (`dig.stone`)
  // that fail 1.21.4 protodef parsing when placing blocks; silence sound packets.
  serv.playSound = () => {}

  // 1.21.4 protocol bridge on flying-squid for packets whose wire format changed in 1.20.5/1.21.2:
  //  - client_command { actionId: 'perform_respawn' } + 1.21.4 respawn / position packets
  //  - player movement relaying with valid boolean onGround + 1.21.4 entity_teleport fields
  const POSITION_REL_ZERO = { _value: 0 }
  const playerEntityTypeId = mcData.entitiesByName?.player?.id ?? 147
  serv.on('newPlayer', (player) => {
    // Silence noisy protodef/EPIPE frames during fast test teardown.
    player._client.on('error', () => {})
    const origWrite = player._client.write.bind(player._client)
    player._client.write = (name, params) => {
      if (closed || name === 'kick_disconnect') return
      try { return origWrite(name, params) } catch { /* ignore closing socket */ }
    }

    // 1.21.4 unified player spawning into `spawn_entity` (replacing legacy `named_entity_spawn`).
    player.spawnPacketName = 'spawn_entity'
    player.entityType = playerEntityTypeId
    player.data = 0
    player.headPitch = 0

    player.sendSelfPosition = (newPosition) => {
      if (newPosition) player.position = newPosition
      try {
        player._client.write('position', {
          teleportId: 1,
          x: player.position.x,
          y: player.position.y,
          z: player.position.z,
          dx: 0,
          dy: 0,
          dz: 0,
          yaw: player.yaw || 0,
          pitch: player.pitch || 0,
          flags: POSITION_REL_ZERO
        })
      } catch { /* ignore if disconnecting */ }
    }

    player._sendRespawn = (newDifficulty, newGameMode) => {
      const ws = serv.registry?.loginPacket?.worldState || {}
      const modes = ['survival', 'creative', 'adventure', 'spectator']
      player._client.write('respawn', {
        worldState: {
          dimension: ws.dimension ?? 0,
          name: ws.name || 'minecraft:overworld',
          hashedSeed: ws.hashedSeed || [0, 0],
          gamemode: newGameMode != null ? (modes[newGameMode] || 'survival') : (ws.gamemode || 'survival'),
          previousGamemode: 255,
          isDebug: false,
          isFlat: true,
          portalCooldown: 0,
          seaLevel: ws.seaLevel ?? -63
        },
        copyMetadata: 0
      })
    }

    player._client.on('client_command', (data) => {
      if (data?.actionId === 'perform_respawn') {
        player._sendRespawn()
        player.sendSelfPosition(player.spawnPoint || new Vec3(0.5, 5, 0.5))
        player.updateHealth(20)
        player.nearbyEntities = []
        try { player.updateAndSpawn() } catch { /* ignore */ }
      }
    })

    // Ensure 1.21.4 `position` / `position_look` packets (which carry `flags.onGround` instead
    // of a bare boolean `onGround`) relay valid boolean `onGround` and 1.21.4 `entity_teleport`.
    const relayMove = (x, y, z, flags, onGround) => {
      const grounded = Boolean(flags?.onGround ?? onGround ?? true)
      const nextPos = new Vec3(x, y, z)
      const prev = player.knownPosition || player.position || nextPos
      const diff = nextPos.minus(prev)
      if (Math.abs(diff.x) > 7 || Math.abs(diff.y) > 7 || Math.abs(diff.z) > 7) {
        player._writeOthersNearby('entity_teleport', {
          entityId: player.id,
          x: nextPos.x,
          y: nextPos.y,
          z: nextPos.z,
          dx: 0,
          dy: 0,
          dz: 0,
          yaw: player.yaw || 0,
          pitch: player.pitch || 0,
          flags: POSITION_REL_ZERO,
          onGround: grounded
        })
        player.knownPosition = nextPos
      } else if (diff.x !== 0 || diff.y !== 0 || diff.z !== 0) {
        const dX = Math.trunc(diff.x * 4096)
        const dY = Math.trunc(diff.y * 4096)
        const dZ = Math.trunc(diff.z * 4096)
        player.knownPosition = prev.plus(new Vec3(dX / 4096, dY / 4096, dZ / 4096))
        player._writeOthersNearby('rel_entity_move', {
          entityId: player.id,
          dX,
          dY,
          dZ,
          onGround: grounded
        })
      }
      player.position = nextPos
      player.onGround = grounded
    }
    player._client.removeAllListeners('position')
    player._client.removeAllListeners('position_look')
    player._client.on('position', ({ x, y, z, flags, onGround } = {}) => relayMove(x, y, z, flags, onGround))
    player._client.on('position_look', ({ x, y, z, flags, onGround } = {}) => relayMove(x, y, z, flags, onGround))
  })

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('flying-squid failed to start listening within 10s')), 10_000)
    serv.once('listening', () => { clearTimeout(t); resolve() })
    serv.once('error', (err) => { clearTimeout(t); reject(err) })
  })
  // Wait briefly for pluginsReady if not already emitted
  if (!serv.pluginsReady) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1000)
      serv.once('pluginsReady', () => { clearTimeout(t); resolve() })
    })
  }

  const extraClients = []

  function getPlayer (username = 'ZincAI') {
    return serv.players.find((p) => p.username === username) || null
  }

  async function setBlock (pos, blockName, props = null) {
    const v = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    const stateId = resolveBlockStateId(mcData, Block, blockName, props)
    await serv.setBlock(serv.overworld, v, stateId)
    return v
  }

  async function fillBlocks (from, to, blockName, props = null) {
    const x0 = Math.min(Math.floor(from.x), Math.floor(to.x))
    const x1 = Math.max(Math.floor(from.x), Math.floor(to.x))
    const y0 = Math.min(Math.floor(from.y), Math.floor(to.y))
    const y1 = Math.max(Math.floor(from.y), Math.floor(to.y))
    const z0 = Math.min(Math.floor(from.z), Math.floor(to.z))
    const z1 = Math.max(Math.floor(from.z), Math.floor(to.z))
    const stateId = resolveBlockStateId(mcData, Block, blockName, props)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          await serv.setBlock(serv.overworld, new Vec3(x, y, z), stateId)
        }
      }
    }
  }

  async function getBlock (pos) {
    const v = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    return serv.overworld.getBlock(v)
  }

  function giveItem (username, itemName, count = 1, slot = null) {
    const player = getPlayer(username)
    if (!player) throw new Error(`Player not connected: ${username}`)
    const def = mcData.itemsByName[itemName]
    if (!def) throw new Error(`Unknown item: ${itemName}`)
    let targetSlot = slot
    if (targetSlot == null) {
      // Pick first empty hotbar or main inventory slot (36..44, then 9..35)
      const order = [...Array.from({ length: 9 }, (_, i) => 36 + i), ...Array.from({ length: 27 }, (_, i) => 9 + i)]
      targetSlot = order.find((s) => !player.inventory.slots[s])
      if (targetSlot == null) targetSlot = 36
    }
    player.inventory.updateSlot(targetSlot, new Item(def.id, count))
    return targetSlot
  }

  function clearInventory (username) {
    const player = getPlayer(username)
    if (!player) return
    for (let s = 0; s < player.inventory.slots.length; s++) {
      if (player.inventory.slots[s]) player.inventory.updateSlot(s, null)
    }
  }

  function setHealth (username, health, food = 20, foodSaturation = 5) {
    const player = getPlayer(username)
    if (!player) throw new Error(`Player not connected: ${username}`)
    player.food = food
    player.health = health
    player._client.write('update_health', { health, food, foodSaturation })
  }

  function hurtPlayer (username, damage = 2) {
    const player = getPlayer(username)
    if (!player) throw new Error(`Player not connected: ${username}`)
    const next = Math.max(0, (player.health ?? 20) - damage)
    player.health = next
    player._client.write('entity_status', { entityId: player.id, entityStatus: 2 })
    player._client.write('update_health', { health: next, food: player.food ?? 20, foodSaturation: 5 })
    return next
  }

  function killPlayer (username) {
    const player = getPlayer(username)
    if (!player) throw new Error(`Player not connected: ${username}`)
    player.health = 0
    player._client.write('update_health', { health: 0, food: player.food ?? 20, foodSaturation: 0 })
  }

  /**
   * Spawn any 1.21.4 entity (zombie, skeleton, creeper, cow, etc.) using
   * flying-squid's real entity lifecycle and TCP spawn packets.
   */
  function spawnMob (mobName, pos, { health = 20, metadata = [] } = {}) {
    const def = mcData.entitiesByName[mobName]
    if (!def) throw new Error(`Unknown entity: ${mobName}`)
    const v = new Vec3(pos.x, pos.y, pos.z)
    const mob = serv.initEntity('mob', def.id, serv.overworld, v)
    mob.uuid = crypto.randomUUID()
    mob.name = def.name
    mob.velocity = new Vec3(0, 0, 0)
    mob.pitch = 0
    mob.headPitch = 0
    mob.yaw = 0
    mob.gravity = new Vec3(0, -20, 0)
    mob.terminalvelocity = new Vec3(27, 27, 27)
    mob.friction = new Vec3(15, 0, 15)
    mob.size = new Vec3(0.75, 1.75, 0.75)
    mob.health = health
    mob.metadata = metadata

    // Ensure dead mobs send entity_destroy so Mineflayer removes them cleanly
    const origTakeDamage = mob.takeDamage
    mob.takeDamage = (opts = {}) => {
      const dmg = Math.max(1, Number(opts.damage) || 4)
      origTakeDamage.call(mob, { ...opts, damage: dmg })
      if (mob.health <= 0) {
        try {
          mob._writeOthers('entity_destroy', { entityIds: [mob.id] })
        } catch { /* already gone */ }
        delete serv.entities[mob.id]
      }
    }

    mob.updateAndSpawn()
    return mob
  }

  function destroyMob (mob) {
    if (!mob) return
    try { serv.destroyEntity(mob) } catch { /* noop */ }
  }

  /**
   * Connect a real second Mineflayer player (e.g., "Alice") to this server
   * so tests can simulate real multi-player chat, whispers, proximity, and following.
   */
  async function connectPlayer (username = 'Alice') {
    const playerBot = mineflayer.createBot({
      host: '127.0.0.1',
      port,
      username,
      version,
      auth: 'offline',
      keepAlive: false,
      checkTimeoutInterval: 0
    })
    extraClients.push(playerBot)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Player ${username} failed to spawn within 10s`)), 10_000)
      playerBot.once('spawn', () => { clearTimeout(t); resolve() })
      playerBot.once('error', (err) => { clearTimeout(t); reject(err) })
      playerBot.once('kicked', (r) => { clearTimeout(t); reject(new Error(`kicked: ${JSON.stringify(r)}`)) })
    })
    return playerBot
  }

  function broadcastSystemChat (text) {
    serv.broadcast(text)
  }

  async function close () {
    if (closed) return
    closed = true
    // Prevent logout.js from trying to broadcast leave messages to closing sockets.
    try { serv.broadcast = () => {} } catch { /* noop */ }
    for (const c of extraClients) {
      try { c.end?.() } catch { /* noop */ }
      try { clearTimeout(c._client?.closeTimer) } catch { /* noop */ }
      try { c._client?.socket?.destroy() } catch { /* noop */ }
    }
    extraClients.length = 0
    try { serv.stopTickInterval?.() } catch { /* noop */ }
    for (const player of [...(serv.players || [])]) {
      try { player.save = () => {} } catch { /* noop */ }
      try { clearTimeout(player._client?.closeTimer) } catch { /* noop */ }
      try { player._client?.socket?.destroy() } catch { /* noop */ }
    }
    for (const c of Object.values(serv._server?.clients || {})) {
      try { clearTimeout(c?.closeTimer) } catch { /* noop */ }
      try { c?.socket?.destroy() } catch { /* noop */ }
    }
    await sleep(40)
    try {
      await Promise.race([
        serv.destroy?.(),
        sleep(500)
      ])
    } catch { /* noop */ }
    try { serv._server?.socketServer?.close() } catch { /* noop */ }
    try { serv._server?.socketServer?.unref?.() } catch { /* noop */ }
    for (const h of leakedSquidIntervals) {
      try { clearInterval(h) } catch { /* noop */ }
    }
    leakedSquidIntervals.clear()
  }

  return {
    host: '127.0.0.1',
    port,
    version,
    serv,
    mcData,
    getPlayer,
    setBlock,
    fillBlocks,
    getBlock,
    giveItem,
    clearInventory,
    setHealth,
    hurtPlayer,
    killPlayer,
    spawnMob,
    destroyMob,
    connectPlayer,
    broadcastSystemChat,
    close
  }
}

module.exports = {
  MC_VERSION,
  startMcServer,
  waitFor,
  sleep
}
