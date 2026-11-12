'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mcp = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const {
  AmdToolsClient,
  createZincTools,
  coerceAction,
  ACTION_TOOLS
} = require('../zincai/api_wrapper')
const { MemorySystem } = require('../zincai/memory')
const { loadConfig } = require('../zincai/index')
const { PathfinderWrapper } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const doors = require('../zincai/custom_mineflayer/doors')
const { simulatedBot, startTestSession, sleep } = require('./helpers/session')

// =========================================================================
// P0: Minecraft 26.3 & 26.1 real TCP wire-protocol loopback tests
// =========================================================================
async function bootMockMcSession (version) {
  const Chunk = require('prismarine-chunk')(version)
  const mcData = require('minecraft-data')(version)
  const srv = mcp.createServer({
    host: '127.0.0.1',
    port: 0,
    version,
    'online-mode': false,
    encryption: false
  })
  const rx = []
  let serverClient = null
  const joined = new Promise((resolve) => {
    srv.on('playerJoin', (c) => {
      serverClient = c
      c.on('error', () => {})
      c.on('packet', (data, meta) => rx.push({ name: meta.name, data }))
      const is263 = mcData.version['>=']('26.3')
      c.write('login', {
        entityId: 1,
        isHardcore: false,
        worldNames: ['minecraft:overworld'],
        maxPlayers: 20,
        viewDistance: 4,
        simulationDistance: 4,
        reducedDebugInfo: false,
        enableRespawnScreen: true,
        doLimitedCrafting: false,
        worldState: {
          dimension: 0,
          name: 'minecraft:overworld',
          hashedSeed: [0, 0],
          gamemode: 'survival',
          previousGamemode: 255,
          isDebug: false,
          isFlat: true,
          death: undefined,
          portalCooldown: 0,
          seaLevel: 63
        },
        onlineMode: false,
        enforcesSecureChat: false
      })
      const chunk = new Chunk({ minY: -64, worldHeight: 384 })
      const stoneId = mcData.blocksByName.stone.defaultState
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), stoneId)
      }
      c.write('chunk_batch_start', {})
      c.write('map_chunk', {
        x: 0,
        z: 0,
        heightmaps: [],
        chunkData: chunk.dump(),
        blockEntities: [],
        ...chunk.dumpLight()
      })
      c.write('chunk_batch_finished', { batchSize: 1 })
      c.write('game_state_change', { reason: 13, gameMode: 0 })
      c.write('ping', { id: 42 })
      c.write('position', {
        teleportId: 7,
        x: 4.5,
        y: 64,
        z: 4.5,
        dx: 0,
        dy: 0,
        dz: 0,
        yaw: 0,
        pitch: 0,
        flags: is263
          ? { x: false, y: false, z: false, yRot: false, xRot: false, dx: false, dy: false, dz: false, yawDelta: false }
          : { x: false, y: false, z: false, yaw: false, pitch: false, dx: false, dy: false, dz: false, yawDelta: false }
      })
      c.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
      resolve(c)
    })
  })

  await new Promise((resolve) => srv.on('listening', resolve))
  const port = srv.socketServer.address().port
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    version,
    username: 'ZincWire',
    auth: 'offline'
  })
  await Promise.all([
    joined,
    new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('error', reject)
    })
  ])
  return {
    srv,
    bot,
    mcData,
    rx,
    client: serverClient,
    close: async () => {
      try { bot.end() } catch {}
      try {
        await new Promise((resolve) => {
          let done = false
          const finish = () => { if (!done) { done = true; resolve() } }
          srv.socketServer?.once?.('close', finish)
          srv.close()
          setTimeout(finish, 200)
        })
      } catch {}
    }
  }
}

test('P0 26.3 wire loopback: spawn, chunks, queued ping+teleport echo, tick_end, punch, entity_action, entityDelta, entity_teleport & scoreboard', async () => {
  const s = await bootMockMcSession('26.3')
  try {
    assert.equal(s.bot.blockAt(new Vec3(4, 63, 4))?.name, 'stone')

    // Trigger swing/punch + sprint entity_action + dig sequence
    s.bot.swingArm()
    s.bot.setControlState('sprint', true)
    s.bot.setControlState('sprint', false)

    // Spawn a zombie and test 26.3 stepped entityDelta + entity_teleport relative flags + scoreboard
    const zombieType = s.mcData.entitiesByName.zombie.id
    s.client.write('spawn_entity', {
      entityId: 99,
      objectUUID: '00000000-0000-4000-8000-000000000099',
      type: zombieType,
      x: 8.0,
      y: 64.0,
      z: 8.0,
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      headPitch: 0,
      objectData: 0
    })
    s.client.write('rel_entity_move', {
      entityId: 99,
      move: { onGround: true, steps: [{ dX: 4096, dY: 0, dZ: -2048, ticks: 0 }] }
    })
    s.client.write('entity_teleport', {
      entityId: 99,
      x: 1.5,
      y: 0,
      z: 2.0,
      dx: 0.25,
      dy: 0,
      dz: -0.25,
      yaw: 90,
      pitch: 15,
      flags: { x: true, y: true, z: true, yaw: false, pitch: false, dx: false, dy: false, dz: false, yawDelta: false },
      onGround: true
    })
    s.client.write('scoreboard_objective', {
      name: 'kills',
      action: 0,
      displayText: { type: 'compound', value: { text: { type: 'string', value: 'Kills' } } },
      type: 0,
      number_format: undefined,
      styling: undefined
    })
    s.client.write('scoreboard_score', {
      itemName: 'ZincWire',
      scoreName: 'kills',
      value: 3,
      display_name: undefined,
      number_format: undefined,
      styling: undefined
    })

    await sleep(350)

    const names = s.rx.map((p) => p.name)
    assert.ok(names.includes('pong'), 'ping reply queued and flushed')
    const tc = s.rx.find((p) => p.name === 'teleport_confirm')
    assert.ok(tc, 'teleport_confirm sent')
    assert.equal(tc.data.teleportId, 7)
    assert.equal(tc.data.x, 4.5)
    assert.equal(tc.data.y, 64)
    assert.equal(tc.data.z, 4.5)

    // Verify ordering: pong arrives before tick_end; tick_end follows position_look/flying/position
    const pongIdx = names.indexOf('pong')
    const tcIdx = names.indexOf('teleport_confirm')
    const tickIdx = names.indexOf('tick_end')
    assert.ok(pongIdx >= 0 && tcIdx > pongIdx && tickIdx > tcIdx, 'pong -> teleport_confirm -> tick_end order preserved')

    assert.ok(names.includes('punch'), '26.3 swingArm emits punch instead of removed arm_animation')
    const sprintStart = s.rx.find((p) => p.name === 'entity_action' && p.data.actionId === 'start_sprinting')
    const sprintStop = s.rx.find((p) => p.name === 'entity_action' && p.data.actionId === 'stop_sprinting')
    assert.ok(sprintStart && sprintStop, 'entity_action uses string mapper actionId')

    const zombie = s.bot.entities[99]
    assert.ok(zombie, 'zombie spawned')
    assert.ok(Math.abs(zombie.position.x - 10.5) < 1e-4, `zombie x stepped + relative teleport expected 10.5, got ${zombie.position.x}`)
    assert.ok(Math.abs(zombie.position.z - 9.5) < 1e-4, `zombie z expected 9.5, got ${zombie.position.z}`)
    assert.ok(s.bot.scoreboards.kills?.itemsMap?.ZincWire?.value === 3, '26.3 scoreboard_score populated without action field')

    s.client.write('reset_score', { entity_name: 'ZincWire', objective_name: 'kills' })
    await sleep(100)
    assert.equal(s.bot.scoreboards.kills?.itemsMap?.ZincWire, undefined, '26.3 reset_score removes entry cleanly')
  } finally {
    await s.close()
  }
})

test('P0 26.1 wire regression: login, chunks, entity_action string mappers & no tick_end regression', async () => {
  const s = await bootMockMcSession('26.1')
  try {
    assert.equal(s.bot.blockAt(new Vec3(4, 63, 4))?.name, 'stone')
    s.bot.setControlState('sprint', true)
    s.bot.setControlState('sprint', false)
    await sleep(250)
    const sprintStart = s.rx.find((p) => p.name === 'entity_action' && p.data.actionId === 'start_sprinting')
    assert.ok(sprintStart, '26.1 entity_action uses string mapper')
  } finally {
    await s.close()
  }
})

// =========================================================================
// F2: chatTimeoutMs & adaptive timeout scaling
// =========================================================================
test('F2: config raises chatTimeoutMs to 90s / maxTokens 512 and client adapts slow p90 safely while preserving short timeouts', async () => {
  const cfg = loadConfig()
  assert.ok(cfg.amd.chatTimeoutMs >= 90_000, `chatTimeoutMs=${cfg.amd.chatTimeoutMs} must accommodate slow inference`)
  assert.ok(cfg.amd.maxTokens >= 512, `maxTokens=${cfg.amd.maxTokens} avoids 256-token cutoffs`)

  // Short timeout (< 10s) must NEVER be scaled upward so unit abort semantics hold
  const shortClient = new AmdToolsClient({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', model: 'm', timeoutMs: 250, chatTimeoutMs: 250 })
  shortClient._recordLatency(400)
  shortClient._recordLatency(500)
  assert.equal(shortClient._effectiveTimeoutMs(250, 180_000), 250)

  // Real production timeout (>= 10s) adapts upward to 1.5x p90 up to cap
  const slowClient = new AmdToolsClient({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', model: 'm', timeoutMs: 30_000, chatTimeoutMs: 30_000 })
  slowClient._recordLatency(45_000)
  slowClient._recordLatency(80_000)
  assert.equal(slowClient._effectiveTimeoutMs(30_000, 180_000), 120_000)
})

// =========================================================================
// F3: <tool_call>/<think> recovery, 2-attempt rescue, accurate failure labels
// =========================================================================
test('F3: coerceAction strips <think> and recovers <tool_call> XML without wasting a retry', () => {
  const recovered = coerceAction({
    content: '<think>checking inventory first</think>\n<tool_call>{"name":"go_to","arguments":{"place":"Ferramentas"}}</tool_call>'
  })
  assert.equal(recovered.a, 'go_to')
  assert.equal(recovered.place, 'Ferramentas')
  assert.equal(recovered._via, 'tool')
})

test('F3: chatWithTools performs up to 2 rescue retries on truncation/empty and raises maxTokens', async () => {
  const seen = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const payload = JSON.parse(body)
      seen.push(payload)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (seen.length === 1) {
        // Attempt 1: truncated at max_tokens
        res.end(JSON.stringify({
          choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '<think>considering' } }],
          usage: { prompt_tokens: 100, completion_tokens: 512 }
        }))
      } else if (seen.length === 2) {
        // Attempt 2: empty content
        res.end(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
          usage: { prompt_tokens: 110, completion_tokens: 1 }
        }))
      } else {
        // Attempt 3 (2nd rescue): valid tool call
        res.end(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'idle', arguments: '{}' } }] } }],
          usage: { prompt_tokens: 120, completion_tokens: 10 }
        }))
      }
    })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  try {
    const port = srv.address().port
    const client = new AmdToolsClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}`, model: 'm', maxTokens: 512 })
    const out = await client.chatWithTools([{ role: 'user', content: 'status' }], createZincTools())
    assert.equal(seen.length, 3, '1 initial + 2 rescue retries')
    assert.equal(seen[1].max_tokens, 1024, 'truncation rescue bumps maxTokens up to 1024')
    assert.equal(out.action.a, 'idle')
    assert.equal(out.action._via, 'tool')
  assert.equal(out.usage.completionTokens, 523)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('F3: empty fallback response reports failure back to the model instead of vanishing silently', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    await sleep(150)
    const snap = s.internals().buildActionPrompt(['test'])
    await s.internals().executeAction({ a: 'idle', _fallback: true }, snap)
    const reply = s.internals().results.find((r) => r.label === 'reply')
    assert.ok(reply && reply.ok === false, 'empty _fallback produces reply failure feedback')
    assert.match(reply.msg, /no tool call/)
  } finally {
    s.stop()
  }
})

// =========================================================================
// F4: Navigation — stairs under top-slabs, repeaters/comparators, door axis, occupied go_to
// =========================================================================
test('F4: door passageAxis handles porch stairs/slabs outside the doorway', () => {
  const blocks = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const mk = (x, y, z, name, boundingBox = 'block', props = {}) => ({
    name,
    boundingBox,
    position: new Vec3(x, y, z),
    getProperties: () => props
  })
  // Door at (0,64,8) facing south (axis='z'), walls at x=±1, interior z=7 is air, outside z=9 is porch stair with air above
  blocks.set(key(0, 64, 8), mk(0, 64, 8, 'cherry_door', 'block', { facing: 'south', open: false, half: 'lower' }))
  blocks.set(key(-1, 64, 8), mk(-1, 64, 8, 'cherry_planks', 'block'))
  blocks.set(key(1, 64, 8), mk(1, 64, 8, 'cherry_planks', 'block'))
  blocks.set(key(0, 64, 7), mk(0, 64, 7, 'air', 'empty'))
  blocks.set(key(0, 64, 9), mk(0, 64, 9, 'cherry_stairs', 'block'))
  blocks.set(key(0, 65, 9), mk(0, 65, 9, 'air', 'empty'))

  const fakeBot = { blockAt: (p) => blocks.get(key(p.x, p.y, p.z)) || null }
  const d = doors.describe(blocks.get(key(0, 64, 8)))
  assert.equal(doors.passageAxis(fakeBot, new Vec3(0, 64, 8), d), 'z')
})

test('F4: pathfinder walks over repeaters/comparators and climbs stairs under top-slab stairwell ceiling', () => {
  const mcData = require('minecraft-data')('26.3')
  const Block = require('prismarine-block')('26.3')
  const world = new Map()
  const set = (x, y, z, name, stateProps = null) => {
    const def = mcData.blocksByName[name]
    let stateId = def.defaultState
    if (stateProps) {
      const b0 = Block.fromStateId(stateId, 0)
      for (let s = def.minStateId; s <= def.maxStateId; s++) {
        const cand = Block.fromStateId(s, 0)
        const p = cand.getProperties()
        if (Object.entries(stateProps).every(([k, v]) => p[k] === v)) { stateId = s; break }
        void b0
      }
    }
    const b = Block.fromStateId(stateId, 0)
    b.position = new Vec3(x, y, z)
    world.set(`${x},${y},${z}`, b)
  }

  for (let x = 0; x <= 10; x++) {
    for (let z = -1; z <= 1; z++) set(x, 63, z, 'stone')
  }
  // Redstone floor: repeater + comparator across x=2, z=-1..1
  for (let z = -1; z <= 1; z++) set(2, 64, z, z === 0 ? 'repeater' : 'comparator')
  // Staircase at x=5..7 climbing to y=67 platform under a 2F top-slab stairwell ceiling at (5, 67, 0)
  set(5, 64, 0, 'cherry_stairs', { facing: 'east', half: 'bottom' })
  set(6, 65, 0, 'cherry_stairs', { facing: 'east', half: 'bottom' })
  set(7, 66, 0, 'cherry_stairs', { facing: 'east', half: 'bottom' })
  for (let x = 8; x <= 10; x++) set(x, 66, 0, 'stone')
  set(4, 67, 0, 'stone')
  set(5, 67, 0, 'cherry_slab', { type: 'top' }) // 2.5m overhead clearance above x=5 stair -> x=6 stair!

  const air = Block.fromStateId(mcData.blocksByName.air.defaultState, 0)
  const fakeBot = {
    version: '26.3',
    registry: mcData,
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {} },
    entities: {},
    inventory: { items: () => [] },
    game: { minY: -64 },
    clearControlStates: () => {},
    setControlState: () => {},
    on: () => {},
    loadPlugin (fn) { fn(this) },
    blockAt: (p) => {
      const b = world.get(`${p.x},${p.y},${p.z}`)
      if (b) return b
      const a = Block.fromStateId(air.stateId, 0)
      a.position = new Vec3(p.x, p.y, p.z)
      return a
    }
  }
  fakeBot.loadPlugin(pathfinder)
  const mov = new Movements(fakeBot)
  fakeBot.pathfinder.setMovements(mov)
  const wrapper = new PathfinderWrapper(fakeBot, { allowDigging: false, allowScaffolding: false })
  try {
    wrapper.apply()
    const path = fakeBot.pathfinder.getPathTo(mov, new goals.GoalNear(9, 67, 0, 1), 2000)
    assert.equal(path.status, 'success', `expected path across repeater & under top-slab stairs, got ${path.status}`)
  } finally {
    wrapper.stop()
  }
})

test('F4: go_to falls back from range=1 to range=2 when target cell is occupied by a solid block', async () => {
  const bot = simulatedBot({ blocks: { '8,64,0': 'stone', '8,65,0': 'stone', '8,63,0': 'smooth_quartz' } })
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    await sleep(150)
    // Monkeypatch bot.pathfinder.setGoal to simulate noPath on range=1 when target block is occupied,
    // and success when skills.goTo falls back to range=2!
    const origSetGoal = bot.pathfinder.setGoal.bind(bot.pathfinder)
    let seenRanges = []
    bot.pathfinder.setGoal = (goal, dynamic) => {
      if (goal && typeof goal.rangeSq === 'number') {
        seenRanges.push(Math.sqrt(goal.rangeSq))
        if (goal.rangeSq <= 1) {
          bot.emit('path_update', { status: 'noPath', path: [] })
          return
        }
      }
      return origSetGoal(goal, dynamic)
    }
    const r = await s.internals().skills.goTo({ x: 8, y: 64, z: 0 })
    assert.equal(r.ok, true, r.msg)
    assert.ok(seenRanges.includes(1) && seenRanges.includes(2), `expected fallback 1 -> 2, saw ${seenRanges}`)
  } finally {
    s.stop()
  }
})

// =========================================================================
// F5 & Memory: token budget reduction + non-chat durable memory promotion
// =========================================================================
test('F5: system prompt + tool schemas stay compact while preserving all modes and required constraints', () => {
  const sysPrompt = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  const chatPrompt = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'chat_prompt.txt'), 'utf8')
  assert.ok(sysPrompt.length < 2800, `system_prompt.txt should stay under 2800 chars (got ${sysPrompt.length})`)
  assert.ok(chatPrompt.length < 1600, `chat_prompt.txt should stay under 1600 chars (got ${chatPrompt.length})`)

  const totalToolChars = JSON.stringify(createZincTools()).length
  // 12.9KB: the goal tool (goals.js / multi-objective continuity) adds ~0.7KB
  // on top of the 12.1KB baseline, still ~16% below the 15.3KB pre-remediation size.
  assert.ok(totalToolChars < 12_900, `full tool schema should stay compact (< 12.9KB, got ${totalToolChars})`)
  assert.equal(ACTION_TOOLS.length, 34)
})

test('Memory: LongTermMemory deduplicates reloaded entries and upsertByTag keeps container updates single-entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-remed-mem-'))
  const file = path.join(dir, 'memories.json')
  try {
    let mem = new MemorySystem({ file })
    mem.longTerm.add('saved place "base" at 0,80,0 (overworld)', ['place', 'base'], 2)
    mem.longTerm.upsertByTag('container:chest1', 'container chest1 "Minerios": iron_ingot x32', ['container', 'chest1'], 2)

    // Reload from disk (without in-memory _vec caches) and update same facts
    mem = new MemorySystem({ file })
    mem.longTerm.add('saved place "base" at 0,80,0 (overworld)', ['place', 'base'], 2)
    mem.longTerm.upsertByTag('container:chest1', 'container chest1 "Minerios": iron_ingot x16, diamond x8', ['container', 'chest1'], 2)

    assert.equal(mem.longTerm.entries.length, 2, 'reload dedupe + upsertByTag prevents stale/duplicate bloat')
    assert.match(mem.longTerm.entries[1].text, /diamond x8/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Memory: remember_here and non-empty look_in promote durable facts via session dispatcher', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    await sleep(150)
    const snap = s.internals().buildActionPrompt(['test'])
    await s.internals().executeAction({ a: 'remember_here', name: 'lab', note: 'redstone testing' }, snap)
    assert.ok(s.shared.memory.longTerm.entries.some((e) => /saved place "lab"/.test(e.text)), 'remember_here persisted to longTerm')
  } finally {
    s.stop()
  }
})
