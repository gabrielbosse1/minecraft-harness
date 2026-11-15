'use strict'

/**
 * Real-server test suite 09: Minecraft screenshot vision system, procedural
 * block fidelity, full loaded-chunk coverage, lightweight footprint, and
 * session screenshot archiving + structured telemetry logging.
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

test('09a: Procedural Minecraft block materials & textures render iconic block identities', () => {
  const { materialFor, sampleBlockTexture } = vision._internal

  // Birch log must be bright white bark with charcoal flecks — NOT brown oak!
  const birch = materialFor('birch_log')
  assert.equal(birch.pattern, 'birch_log')
  assert.ok(birch.rgb[0] > 200 && birch.rgb[1] > 200 && birch.rgb[2] > 195, 'birch_log must be white bark')
  const birchDarkMarks = []
  for (let tv = 0; tv < 16; tv++) {
    for (let tu = 0; tu < 16; tu++) {
      const col = sampleBlockTexture(birch, 2, 0, 0, -1, (tu + 0.5) / 16, 1 - (tv + 0.5) / 16, 0, 0, 0, 0, new Uint8Array(3))
      if (col[0] < 80) birchDarkMarks.push([tu, tv])
    }
  }
  assert.ok(birchDarkMarks.length >= 6, 'birch_log side must show dark charcoal bark flecks')

  // Grass block: green top, brown dirt lower side with green overhang at very top!
  const grass = materialFor('grass_block')
  const grassTop = sampleBlockTexture(grass, 1, 0, -1, 0, 0.5, 1, 0.5, 0, 0, 0, new Uint8Array(3))
  assert.ok(grassTop[1] > grassTop[0] + 30, 'grass_block top must be green')
  const grassSideTop = sampleBlockTexture(grass, 2, 0, 0, -1, 0.5, 0.95, 0, 0, 0, 0, new Uint8Array(3))
  assert.ok(grassSideTop[1] > grassSideTop[0] + 20, 'grass_block side upper lip must be green grass')
  const grassSideBot = sampleBlockTexture(grass, 2, 0, 0, -1, 0.5, 0.25, 0, 0, 0, 0, new Uint8Array(3))
  assert.ok(grassSideBot[0] > grassSideBot[2] + 30, 'grass_block side lower body must be brown dirt')

  // Poppy (red) vs dandelion (yellow), both with compact slender flower geometry
  const poppy = materialFor('poppy')
  const dandelion = materialFor('dandelion')
  assert.equal(poppy.pattern, 'flower')
  assert.equal(dandelion.pattern, 'flower')
  assert.ok(poppy.rgb[0] > 190 && poppy.rgb[1] < 80, 'poppy blossom must be red')
  assert.ok(dandelion.rgb[0] > 210 && dandelion.rgb[1] > 180 && dandelion.rgb[2] < 80, 'dandelion blossom must be yellow')
  assert.ok(poppy.shape && (poppy.shape[3] - poppy.shape[0]) <= 0.25, 'flowers must be slender, not huge cubes')

  // Torch: slender stick + bright emissive flame at top
  const torch = materialFor('torch')
  assert.equal(torch.emissive, true)
  assert.ok(torch.shape && (torch.shape[3] - torch.shape[0]) <= 0.15, 'torch must be a thin Minecraft stick')

  // Diamond ore: stone background + bright cyan mineral nugget pixels
  const diamond = materialFor('diamond_ore')
  assert.equal(diamond.pattern, 'ore')
  const orePix = sampleBlockTexture(diamond, 2, 0, 0, -1, 4.5 / 16, 1 - 3.5 / 16, 0, 0, 0, 0, new Uint8Array(3))
  const stonePix = sampleBlockTexture(diamond, 2, 0, 0, -1, 0.5 / 16, 1 - 0.5 / 16, 0, 0, 0, 0, new Uint8Array(3))
  assert.ok(orePix[2] > 190 && orePix[1] > 190, 'diamond_ore nugget pixel must be bright cyan')
  assert.ok(Math.abs(stonePix[0] - stonePix[2]) < 20, 'diamond_ore background must be grey stone')
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
