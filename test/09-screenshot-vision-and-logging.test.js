'use strict'

/**
 * Real-server test suite 09: Minecraft screenshot vision system backed by real
 * client resources, block/model/texture fidelity, full loaded-chunk coverage,
 * lightweight footprint, and session screenshot archiving + structured
 * telemetry logging.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { startMcServer, waitFor, sleep } = require('./helpers/mc-server')
const { startSimulation } = require('./helpers/sim-harness')
const vision = require('../zincai/vision')
const { loadConfig } = require('../zincai/index')

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function assertValidPng (buf, expectedW, expectedH, label = 'png') {
  assert.ok(Buffer.isBuffer(buf), `${label}: must be a Buffer`)
  assert.ok(buf.length > 500, `${label}: PNG too small (${buf.length} bytes)`)
  assert.deepEqual(buf.subarray(0, 8), PNG_SIG, `${label}: invalid PNG signature`)
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR', `${label}: missing IHDR`)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (expectedW) assert.equal(w, expectedW, `${label}: width mismatch (${w} !== ${expectedW})`)
  if (expectedH) assert.equal(h, expectedH, `${label}: height mismatch (${h} !== ${expectedH})`)
}

test('09a: Native client resources resolve real blockstate models, textures, render layers and tints', () => {
  const { createAssetProvider, BlockModelStore, buildEntityModel } = vision._internal
  const mc = require('minecraft-data')('1.21.4')

  const assets = createAssetProvider({ version: '1.21.4' })
  assert.ok(assets.info.sources.length >= 1, 'must discover a real client resource root')
  assert.equal(assets.info.version, '1.21.4')

  const average = (tex) => {
    const sum = [0, 0, 0]
    for (let i = 0; i < tex.rgba.length; i += 4) {
      sum[0] += tex.rgba[i]; sum[1] += tex.rgba[i + 1]; sum[2] += tex.rgba[i + 2]
    }
    const n = tex.width * tex.height
    return sum.map((v) => Math.round(v / n))
  }

  // Vanilla ships most 16x16 block textures as 4-bit palette PNGs. Decoding
  // them as greyscale used to turn oak planks and cherry logs nearly black, so
  // assert the real palette colours come through.
  const planks = assets.blockTexture('oak_planks')
  assert.ok(planks && planks.width === 16 && planks.height === 16, 'oak_planks texture must load')
  const planksAvg = average(planks)
  assert.ok(planksAvg[0] > 120 && planksAvg[0] < 210, `oak planks red channel must be real wood (${planksAvg})`)
  assert.ok(planksAvg[1] > 90 && planksAvg[2] < 130, `oak planks must be warm brown (${planksAvg})`)

  // Alpha must survive exactly: glass is mostly holes with an opaque frame.
  const glassTex = assets.blockTexture('glass')
  let clear = 0
  let frame = 0
  for (let i = 3; i < glassTex.rgba.length; i += 4) {
    if (glassTex.rgba[i] === 0) clear++
    else if (glassTex.rgba[i] === 255) frame++
  }
  assert.ok(clear > 100, `glass must keep its transparent interior (${clear} clear texels)`)
  assert.ok(frame >= 20, `glass must keep its opaque frame (${frame} frame texels)`)

  const store = new BlockModelStore({ version: '1.21.4', registry: mc }, assets)
  const model = (name, props) => {
    const def = mc.blocksByName[name]
    assert.ok(def, `registry has ${name}`)
    const id = def.defaultState
    return store.modelForState(id, 0, 0, 0)
  }

  // Real blockstate → model → parent → element baking (stairs have 11+ quads).
  const stairs = model('oak_stairs')
  assert.ok(stairs.quads.length >= 10, `oak_stairs must resolve its real model (${stairs.quads.length} quads)`)
  const stairsNames = new Set(stairs.texturesUsed.map((t) => t.name))
  assert.ok(stairsNames.has('oak_planks'), 'stairs must use the oak plank texture from its model')

  // Render layers come from the model/material, not a blanket transparency.
  assert.equal(model('stone').layer, 'opaque')
  assert.match(model('glass').layer, /cutout/)
  assert.match(model('cherry_leaves').layer, /cutout/)
  const stained = model('red_stained_glass')
  assert.equal(stained.layer, 'translucent')
  const water = model('water')
  assert.equal(water.layer, 'translucent')
  assert.equal(water.fluid, true)
  assert.ok(water.aabb[4] > 0.8 && water.aabb[4] < 1, 'water surface must sit slightly below the block top')

  // Grass is a real model with a dedicated top, dirt side and overlay layer.
  const grass = model('grass_block')
  const grassTex = new Set(grass.texturesUsed.map((t) => t.name))
  for (const name of ['grass_block_top', 'grass_block_side', 'grass_block_side_overlay', 'dirt']) {
    assert.ok(grassTex.has(name), `grass_block model must include ${name}`)
  }

  // Biome tints are resolved from the real colormap/tints data.
  const plainsGrass = store.tintColor('grass_block', 0, 'plains', {})
  assert.deepEqual(plainsGrass, [145, 189, 89], 'plains grass tint must be the vanilla colormap value')
  const cherryGrass = store.tintColor('grass_block', 0, 'cherry_grove', {})
  assert.deepEqual(cherryGrass, [182, 219, 97], 'cherry grove grass tint must come from tints.json')

  // Player/entity geometry: real 64x64 skin UVs, classic vs slim arms.
  const wide = buildEntityModel('player', {})
  const slim = buildEntityModel('player', { slim: true })
  const armWidth = (m) => {
    const q = m.quads.find((quad) => quad.bone === 'rightArm' && quad.side === 'up')
    const xs = q.pos.map((p) => p[0])
    return Math.round((Math.max(...xs) - Math.min(...xs)) * 16)
  }
  assert.equal(armWidth(wide), 4, 'classic player arms are 4 px wide')
  assert.equal(armWidth(slim), 3, 'slim player arms are 3 px wide')
  const head = wide.quads.find((q) => q.bone === 'head' && q.side === 'north')
  assert.ok(head && head.uv.every(([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1), 'skin UVs are normalised')

  // No fabricated texture names: every texture comes from a model reference.
  assert.equal(store.stats.missingTextures.size, 0, `missing textures: ${[...store.stats.missingTextures].join(',')}`)
})

test('09b: Real Minecraft world renders look/panorama/map covering all loaded chunks cleanly & lightly', { timeout: 60_000 }, async () => {
  const mc = await startMcServer({ viewDistance: 5 })
  try {
    const bot = await mc.connectPlayer('VisionBot')
    const alice = await mc.connectPlayer('Alice')
    await waitFor(() => bot.entity?.position && alice.entity?.position, { timeoutMs: 10_000 })
    await sleep(400)

    const o = bot.entity.position.floored()
    const y0 = o.y

    // Build a recognizable multi-chunk Minecraft scene (cabin + birch tree + pond + ore cliff + distant tower)
    const cx = o.x, cz = o.z - 12
    await mc.fillBlocks(new Vec3(cx - 2, y0, cz - 2), new Vec3(cx + 2, y0 + 3, cz + 2), 'oak_planks')
    await mc.setBlock(new Vec3(cx - 1, y0 + 1, cz + 2), 'glass')
    await mc.setBlock(new Vec3(cx, y0 + 2, cz + 3), 'torch')
    await mc.fillBlocks(new Vec3(o.x + 3, y0 - 1, o.z - 6), new Vec3(o.x + 6, y0 - 1, o.z - 3), 'water')
    await mc.setBlock(new Vec3(o.x - 5, y0, o.z - 8), 'birch_log')
    await mc.setBlock(new Vec3(o.x - 5, y0 + 1, o.z - 8), 'birch_log')
    await mc.setBlock(new Vec3(o.x - 5, y0 + 2, o.z - 8), 'birch_leaves')
    await mc.setBlock(new Vec3(o.x - 2, y0, o.z - 5), 'poppy')
    await mc.setBlock(new Vec3(o.x + 2, y0, o.z - 5), 'dandelion')
    // Distant landmark 3+ chunks away
    await mc.fillBlocks(new Vec3(o.x + 12, y0, o.z - 46), new Vec3(o.x + 15, y0 + 12, o.z - 43), 'stone_bricks')
    await sleep(300)

    const cfg = loadConfig()
    const look = await vision.screenshot(bot, {
      view: 'look',
      direction: 'north',
      width: cfg.vision.width,
      height: cfg.vision.height,
      maxDist: cfg.vision.maxDistance
    })
    const pano = await vision.screenshot(bot, { view: 'panorama', maxDist: cfg.vision.maxDistance })
    const map = await vision.screenshot(bot, { view: 'map', radius: cfg.vision.mapRadius })

    assertValidPng(look.png, cfg.vision.width, cfg.vision.height, 'look')
    assertValidPng(pano.png, 720, 200, 'panorama')
    assertValidPng(map.png, null, null, 'map')

    // Verify all loaded chunks in view are covered
    assert.ok(look.chunksLoaded >= 25, `expected loaded chunks >= 25, got ${look.chunksLoaded}`)
    assert.ok(look.chunksInView >= 8, `look view should cover multiple loaded chunks, got ${look.chunksInView}`)
    assert.ok(look.maxDist >= 64, `maxDist should span loaded chunks (>= 64), got ${look.maxDist}`)
    assert.ok(pano.chunksInView >= Math.floor(pano.chunksLoaded * 0.65), `360° panorama should cover most loaded chunks (${pano.chunksInView}/${pano.chunksLoaded})`)
    assert.ok(map.chunksInView >= 9, `map should span surrounding chunks (${map.chunksInView})`)

    // Verify lightweight render latency (far lighter than booting a Minecraft client)
    assert.ok(look.renderMs < 4000, `look render too slow: ${look.renderMs}ms`)
    assert.ok(pano.renderMs < 4000, `pano render too slow: ${pano.renderMs}ms`)
    assert.ok(map.renderMs < 1500, `map render too slow: ${map.renderMs}ms`)

    // Verify recognizable world contents in summaries
    assert.match(look.summary, /oak_planks/i, 'look summary should report the oak cabin')
    assert.match(look.summary, /loaded chunks in view/i, 'look summary should report chunk coverage')
    assert.match(pano.summary, /panorama from/i)
    assert.match(map.summary, /map centred on you/i)
  } finally {
    await mc.close()
  }
})

test('09c: ZincAI runtime screenshot tool saves every PNG in session logs & records structured telemetry', { timeout: 60_000 }, async () => {
  const sim = await startSimulation({
    cfgOverrides: {
      inference: { loopMs: 0, heartbeatMs: 0 }
    }
  })

  try {
    const internals = sim.session.internals()
    const alice = await sim.mc.connectPlayer('Alice')
    const aliceHeard = []
    alice.on('messagestr', (msg) => aliceHeard.push(msg))

    // Enqueue two screenshot calls (look + panorama) followed by a confirmation say
    const startIdx = sim.llm.actionRequests().length
    sim.llm.enqueueAction({
      toolCalls: [{ name: 'screenshot', arguments: { view: 'look', direction: 'north' } }]
    })
    sim.llm.enqueueAction({
      toolCalls: [{ name: 'screenshot', arguments: { view: 'panorama' } }]
    })
    sim.llm.enqueueAction({
      toolCalls: [{ name: 'say', arguments: { text: 'Captured look and panorama!' } }]
    })

    internals.brain.wake('take screenshots of the world', { external: true, fast: true })

    await waitFor(
      () => aliceHeard.some((m) => m.includes('Captured look and panorama!')),
      { timeoutMs: 20_000, label: 'Zinc finishes screenshot capture turn' }
    )

    // Flush telemetry so events.jsonl, continuation.json, and latest.json are all on disk
    sim.shared.telemetry.flush({ reason: 'test_verify' })

    const shotsDir = sim.shared.telemetry.screenshotsDir
    assert.ok(fs.existsSync(shotsDir), `session screenshots dir must exist: ${shotsDir}`)
    const archived = fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort()
    assert.equal(archived.length, 2, `expected 2 chronologically archived PNGs, got: ${archived.join(', ')}`)
    assert.match(archived[0], /^0001_.*_look\.png$/)
    assert.match(archived[1], /^0002_.*_panorama\.png$/)

    // Every saved archive file AND last-<view>.png must be a real valid PNG at its proper aspect ratio
    assertValidPng(fs.readFileSync(path.join(shotsDir, archived[0])), 512, 288, archived[0])
    assertValidPng(fs.readFileSync(path.join(shotsDir, archived[1])), 720, 200, archived[1])
    assertValidPng(fs.readFileSync(path.join(sim.dataDir, 'screenshots', 'last-look.png')), 512, 288, 'last-look.png')
    assertValidPng(fs.readFileSync(path.join(sim.dataDir, 'screenshots', 'last-panorama.png')), 720, 200, 'last-panorama.png')

    // Telemetry events.jsonl must contain structured screenshot entries with saved file paths + chunk stats
    const events = fs.readFileSync(sim.shared.telemetry.eventsFile, 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const shotEvts = events.filter((e) => e.type === 'screenshot')
    assert.equal(shotEvts.length, 2, 'events.jsonl must record 2 screenshot events')
    for (const ev of shotEvts) {
      assert.ok(ev.data.file && ev.data.file.endsWith('.png'), 'screenshot event must include saved relative PNG path')
      assert.ok(fs.existsSync(path.join(sim.dataDir, ev.data.file)), `logged screenshot file must exist on disk: ${ev.data.file}`)
      assert.ok(ev.data.width > 0 && ev.data.height > 0, 'screenshot event must include dimensions')
      assert.ok(ev.data.bytes > 500, 'screenshot event must include PNG byte size')
      assert.ok(ev.data.chunksLoaded > 0 && ev.data.chunksInView > 0, 'screenshot event must include loaded/visible chunk counts')
      assert.equal(ev.data.sentToModel, true)
    }

    // continuation.json and latest.json must expose screenshot stats & directory
    const cont = JSON.parse(fs.readFileSync(sim.shared.telemetry.continuationFile, 'utf8'))
    assert.equal(cont.stats.screenshots, 2)
    assert.equal(cont.recentScreenshots.length, 2)
    const latest = JSON.parse(fs.readFileSync(sim.shared.telemetry.latestFile, 'utf8'))
    assert.equal(latest.stats.screenshots, 2)
    assert.ok(latest.screenshotsDir.includes('screenshots'))

    // Follow-up LLM request after screenshot tool call must carry the inline data:image/png;base64 attachment
    const burst = sim.llm.actionRequests().slice(startIdx)
    const hasInlinePng = burst.slice(1).some((req) =>
      JSON.stringify(req.messages).includes('data:image/png;base64,')
    )
    assert.ok(hasInlinePng, 'model must receive inline base64 PNG image attachment after screenshot tool call')
  } finally {
    await sim.stop()
  }
})

test('09d: pathfinder events drive navigation overlays and clear stale paths', { timeout: 60_000 }, async () => {
  const mc = await startMcServer({ viewDistance: 3 })
  try {
    const bot = await mc.connectPlayer('NavigationVision')
    const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')
    bot.loadPlugin(pathfinder)
    const tracker = require('../zincai/vision_navigation').trackNavigation(bot)
    bot.pathfinder.setMovements(new Movements(bot))
    const pos = bot.entity.position.floored()
    bot.pathfinder.setGoal(new goals.GoalNear(pos.x + 5, pos.y, pos.z, 1))
    await waitFor(() => tracker.snapshot().path.length > 0 || tracker.snapshot().status === 'reached', { timeoutMs: 10000 })
    const nav = tracker.snapshot()
    assert.ok(['navigating', 'reached'].includes(nav.status))
    assert.equal(nav.destination.x, pos.x + 5)
    const shot = await vision.screenshot(bot, { view: 'panorama', maxDist: 32, navigation: nav, goal: 'test destination', action: 'walk' })
    assertValidPng(shot.png, 720, 200)
    assert.match(shot.summary, /GOAL test destination/i)
    assert.match(shot.summary, /NAV (navigating|reached)/i)
    bot.pathfinder.setGoal(null)
    assert.equal(tracker.snapshot().status, 'idle')
    assert.equal(tracker.snapshot().path.length, 0)
    tracker.dispose()
  } finally { await mc.close() }
})

test('09e: live viewer streams real chunks and the pathfinder pending steps', { timeout: 60_000 }, async () => {
  const mc = await startMcServer({ viewDistance: 3 })
  let feed, socket, tracker
  try {
    const bot = await mc.connectPlayer('LiveVision')
    const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')
    bot.loadPlugin(pathfinder)
    tracker = require('../zincai/vision_navigation').trackNavigation(bot)
    bot.pathfinder.setMovements(new Movements(bot))
    const errors = []
    feed = require('../zincai/visual_feed').startVisualFeed(bot, {
      port: 0, viewDistance: 2, onError: err => errors.push(err),
      snapshot: () => ({ navigation: tracker.snapshot() })
    })
    if (!feed.server.listening) await new Promise(resolve => feed.server.once('listening', resolve))
    const url = `http://127.0.0.1:${feed.server.address().port}`
    assert.equal((await fetch(url)).status, 200)
    assert.equal((await fetch(`${url}/state`)).status, 200)
    const client = require('socket.io-client')
    socket = client(url)
    let chunks = 0, line = null
    socket.on('loadChunk', () => { chunks++ })
    socket.on('primitive', p => { if (p.id === 'route' && p.type === 'line') line = p })
    await waitFor(() => chunks > 0, { timeoutMs: 10000 })
    const pos = bot.entity.position.floored()
    let emittedPath
    bot.on('path_update', result => { if (result.path.length) emittedPath = result.path })
    bot.pathfinder.setGoal(new goals.GoalNear(pos.x + 15, pos.y, pos.z, 1))
    await waitFor(() => emittedPath && line, { timeoutMs: 10000 })
    assert.deepEqual(tracker.snapshot().path, emittedPath.slice(0, 2048).map(({ x, y, z }) => ({ x, y, z })))
    assert.ok(line.points.length > 1)
    await waitFor(() => tracker.snapshot().progress && Number(tracker.snapshot().progress.split('/')[0]) > 0, { timeoutMs: 15000 })
    assert.deepEqual(tracker.snapshot().path, emittedPath.slice(0, 2048).map(({ x, y, z }) => ({ x, y, z })))
    assert.deepEqual(errors, [])
  } finally {
    socket?.disconnect()
    feed?.close()
    tracker?.dispose()
    await mc.close()
  }
})
