'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const Block = require('prismarine-block')(require('prismarine-registry')('1.21.4'))

const world = require('./helpers/world')
const { ContinuityStore, classifySignOwnership } = require('../zincai/continuity')
const { simulatedBot, addPlayer, startTestSession, sleep } = require('./helpers/session')

/**
 * Equip `simulatedBot` with dynamic block placement, digging, and `setBlock`
 * over real `prismarine-block` instances so `BuilderExecutor`, `skills.gather`,
 * `skills.dig`, and `PlaceIndex` exercise the full Mineflayer surface.
 */
function mutableBot (opts = {}) {
  const dynamic = new Map(Object.entries(opts.blocks || {}))
  const bot = simulatedBot({ ...opts, blocks: Object.fromEntries(dynamic) })
  const baseBlockAt = bot.blockAt.bind(bot)

  bot.blockAt = (p, extra) => {
    if (!p) return null
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const key = `${x},${y},${z}`
    if (dynamic.has(key)) {
      const name = dynamic.get(key)
      const state = world.registry.blocksByName[name]?.defaultState ?? world.registry.blocksByName.air.defaultState
      const b = Block.fromStateId(state, 0)
      b.position = new Vec3(x, y, z)
      return b
    }
    return baseBlockAt(p, extra)
  }

  bot.setBlock = (x, y, z, name) => {
    dynamic.set(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, name)
  }

  bot.findBlocks = ({ matching, maxDistance = 16, count = 64 }) => {
    const ids = new Set(Array.isArray(matching) ? matching : [matching])
    const out = []
    for (const [key, name] of dynamic.entries()) {
      if (name === 'air') continue
      const [x, y, z] = key.split(',').map(Number)
      const v = new Vec3(x, y, z)
      if (v.distanceTo(bot.entity.position) > maxDistance) continue
      const blk = bot.blockAt(v)
      if (blk && ids.has(blk.type)) out.push(v)
    }
    return out.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, count)
  }

  bot.placeBlock = async (refBlock, face) => {
    const t = refBlock.position.offset(face.x, face.y, face.z)
    const itemName = bot.heldItem?.name || 'dirt'
    dynamic.set(`${t.x},${t.y},${t.z}`, itemName)
    const stack = bot.inventory.items().find((i) => i.name === itemName)
    if (stack && stack.count > 0) stack.count -= 1
  }

  bot.dig = async (blk) => {
    if (!blk?.position) return
    dynamic.set(`${blk.position.x},${blk.position.y},${blk.position.z}`, 'air')
  }

  if (bot.pathfinder && !bot.pathfinder.bestHarvestTool) {
    bot.pathfinder.bestHarvestTool = () => null
  }

  return bot
}

function addEntity (bot, id, name, x, y, z, velocity = { x: 0, y: 0, z: 0 }, extra = {}) {
  const ent = {
    id,
    type: 'mob',
    name,
    displayName: name,
    position: new Vec3(x, y, z),
    velocity: new Vec3(velocity.x, velocity.y, velocity.z),
    height: 1.8,
    width: 0.6,
    metadata: [],
    equipment: [],
    isValid: true,
    ...extra
  }
  bot.entities[id] = ent
  return ent
}

const snapNow = (it, extra = {}) => ({ ...it.buildActionPrompt(['test']), ...extra })

// ============================================================================
// 10.1 Unprompted World Behavior & Mode Unlock Discovery
// ============================================================================

test('10.1 unprompted behavior: perceives world features/frontier, recalls autonomous memory, and chains mode switch without 90s stall', async () => {
  const blocks = {
    '4,63,0': 'water', '4,63,1': 'water', '4,63,2': 'water', '5,63,0': 'water', '5,63,1': 'water', '5,63,2': 'water',
    '-4,64,2': 'oak_log', '-4,65,2': 'oak_log', '-4,66,2': 'oak_log', '-4,67,2': 'oak_leaves', '-3,67,2': 'oak_leaves',
    '3,64,-4': 'repeater', '4,64,-4': 'redstone_wire'
  }
  const bot = mutableBot({ items: [['cobblestone', 16]], blocks })
  let step = 0
  const s = startTestSession({
    bot,
    actions: () => {
      step++
      if (step === 1) return { a: 'note', text: 'River east of spawn has a redstone repeater nearby', interest: 'river bridges' }
      if (step === 2) return { a: 'set_mode', mode: 'builder' }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    assert.ok(await s.until(() => step >= 3, 4000), 'chained note -> set_mode(builder) -> next turn without external chat or 90s stall')
    const firstPrompt = s.prompts.action[0]
    assert.match(firstPrompt, /identity: home: none established yet/, 'never fabricates home ownership on spawn')
    assert.match(firstPrompt, /world: features: .*redstone.*water|world: features: .*water.*redstone/, 'explorer mode sees semantic scene features')
    assert.match(firstPrompt, /unexplored:/, 'surfaces unexplored adjacent chunk directions')
    assert.doesNotMatch(firstPrompt, /just joined the server — look around; idle is fine/, 'startup wake is neutral, not idle-biased')

    const thirdPrompt = s.prompts.action[2]
    assert.match(thirdPrompt, /mode builder/, 'switched to builder mode')
    assert.match(thirdPrompt, /interests: river bridges/, 'emergent personal interest persisted from experience')
    assert.match(thirdPrompt, /River east of spawn/, 'long-term memory recalled autonomously without player chat')
  } finally {
    s.stop()
  }
})

// ============================================================================
// 10.2 Self-Generated Goal Lifecycle & Competing Player Requests
// ============================================================================

test('10.2 self-generated goals: create with reason, subgoals, reprioritize, combine, execute project, and weigh competing requests', async () => {
  const bot = mutableBot({ items: [['stone_bricks', 24], ['bread', 4]] })
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(120)
    const it = s.internals()
    const selfSnap = { threatIds: [], askedBy: null, goalId: null }

    // 1. Self-generated goal with explicit motivation/reason.
    await it.executeAction({
      a: 'goal',
      operation: 'add',
      description: 'build a stone footbridge over the east creek',
      reason: 'crossing water slows down trips to the forest',
      priority: 60
    }, selfSnap)
    const g1 = it.goals.get('g1')
    assert.equal(g1.origin, 'self')
    assert.equal(g1.originType, 'self_generated')
    assert.equal(g1.reason, 'crossing water slows down trips to the forest')
    assert.match(it.goals.describe(g1), /why: crossing water slows down trips/)

    // 2. Second overlapping self-goal -> combine into unified project!
    await it.executeAction({
      a: 'goal',
      operation: 'add',
      description: 'add lanterns along the east creek path',
      reason: 'dark riverbanks spawn mobs at night',
      priority: 55
    }, selfSnap)
    await it.executeAction({
      a: 'goal',
      operation: 'combine',
      id: 'g1,g2',
      description: 'build lit stone footbridge over the east creek',
      priority: 72
    }, selfSnap)
    assert.equal(it.goals.get('g1').status, 'cancelled')
    assert.equal(it.goals.get('g2').status, 'cancelled')
    const g3 = it.goals.get('g3')
    assert.equal(g3.status, 'pending')
    assert.equal(g3.priority, 72)
    assert.deepEqual(g3.relatedIds, ['g1', 'g2'])

    // 3. Modify / reprioritize & convert to shared project when friend joins in.
    await it.executeAction({
      a: 'goal',
      operation: 'update',
      id: 'g3',
      priority: 80,
      origin: 'shared_project',
      player: 'Gabriel',
      note: 'Gabriel offered lanterns for the bridge'
    }, selfSnap)
    assert.equal(it.goals.get('g3').priority, 80)
    assert.equal(it.goals.get('g3').originType, 'shared_project')
    assert.deepEqual(it.goals.get('g3').participants, ['Gabriel'])

    // 4. Execute build_shape step -> links as child of g4 & records self-built construction when origin is self.
    await it.executeAction({ a: 'goal', operation: 'add', description: 'lay stone marker at camp', priority: 85 }, selfSnap)
    const g4 = it.goals.get('g4')
    await it.executeAction({ a: 'set_mode', mode: 'builder' }, selfSnap)
    await it.executeAction({
      a: 'build_shape',
      shape: 'floor',
      block: 'stone_bricks',
      params: { w: 2, d: 2 },
      at: [2, 64, 2]
    }, snapNow(it, { askedBy: null }))
    assert.ok(await s.until(() => it.continuity.identity.constructions.length > 0, 4000), 'recorded verified self_built construction')
    const stepGoal = it.goals.list({}).find((g) => g.kind === 'build_shape')
    assert.equal(stepGoal.parentId, g4.id, 'build step auto-linked to compatible declared goal')
    assert.equal(it.continuity.identity.constructions[0].origin, 'self_built')

    // 5. Competing non-urgent player request does NOT cross-link under Zinc's self goal.
    addPlayer(bot, 2, 'Pedro', 3, 0)
    await it.executeAction({ a: 'go_to', player: 'Pedro' }, snapNow(it, { askedBy: 'Pedro' }))
    const pedroGoal = it.goals.list({}).find((g) => g.kind === 'go_to')
    assert.equal(pedroGoal.origin, 'player:Pedro')
    assert.notEqual(pedroGoal.parentId, g4.id, 'player request never mislinked as sub-step of Zinc self-goal')
  } finally {
    s.stop()
  }
})

// ============================================================================
// 10.3 Arbitrary Context Reset Continuity (All 10 Scenarios from §5.3)
// ============================================================================

test('10.3 context resets (Scenarios 1–10): survives arbitrary resets without conversation replay, reconciles world truth, and prevents duplicate actions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-continuity-10-'))
  const blocks = {
    '4,64,0': 'chest'
  }
  const containers = { '4,64,0': { iron_ingot: 2 } }
  const bot = mutableBot({ items: [['stone_bricks', 16], ['iron_ingot', 5]], blocks, containers })
  const s = startTestSession({ bot, dataDir: dir, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(120)
    const it = s.internals()

    // --- Scenario 1 (Exploring) & Scenario 5 (Right after creating a goal) ---
    it.continuity.observeEnvironment(bot, s.shared.places)
    await it.executeAction({ a: 'goal', operation: 'add', description: 'chart the northern ridge', reason: 'find high ground', priority: 65 }, snapNow(it, { askedBy: null }))
    s.shared.convo.set('Gabriel', [{ who: 'them', text: 'huge old chat history line', ts: Date.now() }])
    s.shared.chatLog.push({ who: 'Gabriel', text: 'huge old chat history line', ts: Date.now() })

    const r15 = s.resetContext({ reason: 'mid_exploration_and_goal_create', wake: false })
    assert.equal(r15.resetCount, 1)
    assert.equal(s.shared.convo.size, 0, 'conversation history wiped on context reset')
    assert.equal(s.shared.chatLog.length, 0, 'chatLog wiped on context reset')
    const pAfter15 = it.buildActionPrompt(['post-reset']).text
    assert.doesNotMatch(pAfter15, /huge old chat history line/, 'zero conversation transcript replayed')
    assert.match(pAfter15, /g1 PENDING chart the northern ridge/, 'newly created goal survived reset')
    assert.ok(it.continuity.frontier['overworld:0,0']?.visits >= 1, 'visited frontier chunk preserved across reset')

    // --- Scenario 2 (While navigating to a destination) ---
    await it.executeAction({ a: 'go_to', x: 18, y: 64, z: 0 }, snapNow(it, { askedBy: null }))
    await sleep(60)
    const r2 = s.resetContext({ reason: 'mid_navigation', wake: false })
    assert.ok(r2.notes.some((n) => /body currently running|world pos/.test(n)) || it.skills.current(), 'reconciled live navigation controller')
    assert.ok(await s.until(() => !it.agenda.main && Math.hypot(bot.entity.position.x - 18, bot.entity.position.z) < 2.5, 5000), 'navigation completed smoothly across mid-walk context reset')

    // --- Scenario 6 (After a tool succeeded in world BEFORE model received its result!) ---
    bot.entity.position.set(3.5, 64, 0.5)
    s.shared.places.scan(bot, { radius: 16, force: true })
    await it.executeAction({ a: 'put', item: 'iron_ingot', count: 3, where: 'chest1' }, snapNow(it, { askedBy: null }))
    assert.ok(await s.until(() => containers['4,64,0'].iron_ingot === 5 && it.results.some((r) => r.label === 'put' && r.ok), 3000), 'put succeeded in world')
    // Trigger arbitrary reset BEFORE any subsequent model turn receives `results`!
    assert.equal(it.continuity.undeliveredActions().some((a) => a.tool === 'put' && a.ok), true)
    s.resetContext({ reason: 'before_tool_result_delivered', wake: false })
    assert.equal(it.results.length, 0, 'transient results buffer cleared by reset')
    const snap6 = it.buildActionPrompt(['post-reset'])
    assert.match(snap6.text, /completed before reset \(do NOT repeat\): .*\[act_\d+\] put.*OK/, 'undelivered completed action explicitly surfaced to prevent duplicate execution')
    it.continuity.markActionsDelivered(snap6.shownActionIds)
    assert.doesNotMatch(it.buildActionPrompt(['next-turn']).text, /completed before reset \(do NOT repeat\): .*put/)

    // --- Scenario 3 (During construction) & Scenario 9 (Player modifies environment) ---
    await it.executeAction({ a: 'set_mode', mode: 'builder' }, snapNow(it, { askedBy: null }))
    await it.executeAction({ a: 'build_shape', shape: 'floor', block: 'stone_bricks', params: { w: 2, d: 2 }, at: [6, 64, 2] }, snapNow(it, { askedBy: null }))
    assert.ok(await s.until(() => !it.agenda.main && bot.blockAt(new Vec3(6, 64, 2))?.name === 'stone_bricks', 4000))
    // Player removes 2 blocks of Zinc's completed construction right before a context reset!
    bot.setBlock(6, 64, 2, 'air')
    bot.setBlock(7, 64, 2, 'air')
    const r9 = s.resetContext({ reason: 'after_env_modification', wake: false })
    assert.ok(r9.notes.some((n) => /missing.*sampled block/.test(n)), 'world reconciliation detected blocks removed by player from self-built project')
    assert.match(it.buildActionPrompt(['post-reset']).text, /missing .* sampled block/, 'prompt surfaces live world discrepancy')

    // --- Scenario 4 (During combat/danger) & Scenario 7 (Multiple active/suspended goals) & Scenario 8 (Player communicating) ---
    await it.executeAction({ a: 'goal', operation: 'add', description: 'build storage room', priority: 75 }, snapNow(it, { askedBy: null }))
    await it.executeAction({ a: 'goal', operation: 'suspend', id: 'g1', note: 'pausing ridge survey while building storage' }, snapNow(it, { askedBy: null }))
    it.continuity.addPendingEvent({ kind: 'player_request', from: 'Ana', text: 'meet Ana at the river' })
    const zombie = addEntity(bot, 91, 'zombie', bot.entity.position.x + 3, 64, bot.entity.position.z)
    await it.system1.tick()
    assert.equal(it.system1.fleeing, true, 'fleeing from zombie')
    const r478 = s.resetContext({ reason: 'combat_multigoal_chat', wake: false })
    assert.ok(r478.notes.some((n) => /actively fleeing/.test(n)), 'Scenario 4: live danger/fleeing state preserved across reset')
    const p478 = it.buildActionPrompt(['post-reset']).text
    assert.match(p478, /SUSPENDED chart the northern ridge/, 'Scenario 7: suspended goal preserved')
    assert.match(p478, /PENDING build storage room/, 'Scenario 7: higher-priority pending goal preserved')
    assert.match(p478, /Ana: "meet Ana at the river"/, 'Scenario 8: unhandled player communication survived context wipe')
    delete bot.entities[zombie.id]

    // --- Scenario 10 (Process restart mid-multi-step action) ---
    it.continuity.beginAction({ tool: 'gather', summary: 'gather oak_log x8', sig: 'gather:oak_log', goalId: 'g5' })
  } finally {
    s.stop()
  }

  const rebooted = new ContinuityStore({ file: path.join(dir, 'continuity.json') })
  assert.ok(rebooted.currentState.interruptedAction, 'Scenario 10: in-flight action transitioned to interruptedAction on restart')
  assert.equal(rebooted.currentState.interruptedAction.status, 'interrupted_by_restart')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ============================================================================
// 10.4 Ownership, Home Verification & Property Respect
// ============================================================================

test('10.4 ownership & respect: protects player houses/private chests, never assumes home from visiting, and allows communal/own use', async () => {
  assert.equal(classifySignOwnership('Casa do Gabriel', 'ZincAI').kind, 'player')
  assert.equal(classifySignOwnership('Casa do Gabriel', 'ZincAI').owner, 'Gabriel')
  assert.equal(classifySignOwnership('Baú Comunitário', 'ZincAI').kind, 'shared')
  assert.equal(classifySignOwnership('Casa para Zinc', 'ZincAI').kind, 'own')
  assert.equal(classifySignOwnership('Bem-vindos ao servidor', 'ZincAI').kind, 'unknown')

  const blocks = {
    '4,64,0': 'oak_log', '4,65,0': 'oak_log',
    '5,64,0': 'oak_planks', '5,65,0': 'oak_planks',
    '4,64,1': 'oak_door',
    '6,64,0': 'chest',
    '-5,64,0': 'chest'
  }
  const containers = {
    '6,64,0': { diamond: 8 },
    '-5,64,0': { bread: 6 }
  }
  const bot = mutableBot({ items: [['stone_bricks', 20]], blocks, containers })
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(100)
    const it = s.internals()
    const autoSnap = { threatIds: [], askedBy: null, goalId: null }

    // 1. Visiting an unknown structure does NOT let Zinc claim it as home without evidence!
    await it.executeAction({ a: 'remember_here', name: 'cool_house', home: true }, autoSnap)
    assert.equal(it.results.at(-1).ok, false, 'cannot declare unverified location as home')
    assert.equal(it.continuity.identity.home, null)

    // 2. Index containers and label Gabriel's chest vs communal chest.
    s.shared.places.scan(bot, { radius: 16, force: true })
    for (const e of s.shared.places.blocks.values()) {
      if (e.x === 6 && e.z === 0) e.label = 'Baú do Gabriel'
      if (e.x === -5 && e.z === 0) e.label = 'Baú Comunitário'
    }
    it.continuity.observeEnvironment(bot, s.shared.places)

    // 3. Autonomous `gather oak_log` refuses to mine logs attached to Gabriel's house!
    const gatherHouse = await it.skills.gather({
      item: 'oak_log',
      count: 1,
      radius: 12,
      guard: (p) => it.continuity.propertyGuardAt(p, 'overworld', { askedBy: null })
    })
    assert.equal(gatherHouse.ok, false, 'refused to mine oak_log belonging to built structure/property')
    assert.equal(bot.blockAt(new Vec3(4, 64, 0)).name, 'oak_log', 'house oak_log untouched')

    // 4. Add a wild tree far from Gabriel's claim at (-14,64,-10) -> `gather` mines the wild tree while skipping Gabriel's house!
    bot.setBlock(-14, 64, -10, 'oak_log')
    let dugPos = null
    const origDig = bot.dig.bind(bot)
    bot.dig = async (blk) => { dugPos = blk.position; return origDig(blk) }
    const gatherWild = await it.skills.gather({
      item: 'oak_log',
      count: 1,
      radius: 28,
      guard: (p) => it.continuity.propertyGuardAt(p, 'overworld', { askedBy: null })
    })
    assert.equal(gatherWild.ok, true, 'mined wild oak_log')
    assert.deepEqual([dugPos.x, dugPos.y, dugPos.z], [-14, 64, -10], 'dug wild tree, never house pillar')

    // 5. Private vs Communal vs Owner-Authorized container access.
    const gabrielChest = [...s.shared.places.blocks.values()].find((e) => e.x === 6)
    const sharedChest = [...s.shared.places.blocks.values()].find((e) => e.x === -5)
    await it.executeAction({ a: 'take', item: 'diamond', count: 1, where: gabrielChest.id }, autoSnap)
    assert.equal(it.results.at(-1).ok, false, 'autonomous take from Gabriel private chest refused')
    assert.match(it.results.at(-1).msg, /Gabriel's/)

    assert.equal(it.continuity.containerTakeGuard(sharedChest, 'overworld', { askedBy: null }).ok, true)
    assert.equal(it.continuity.containerTakeGuard(gabrielChest, 'overworld', { askedBy: 'Gabriel' }).ok, true, 'allowed when owner explicitly asks')

    // 6. Autonomous build overlapping Gabriel's property is refused!
    await it.executeAction({ a: 'set_mode', mode: 'builder' }, autoSnap)
    await it.executeAction({ a: 'build_shape', shape: 'floor', block: 'stone_bricks', params: { w: 2, d: 2 }, at: [5, 64, 1] }, snapNow(it, { askedBy: null }))
    assert.ok(await s.until(() => it.results.some((r) => r.label === 'build_shape' && !r.ok), 3000))
    assert.match(it.results.find((r) => r.label === 'build_shape').msg, /overlaps .*Gabriel's property/)

    // 7. Building Zinc's own shelter on unclaimed land establishes verified home!
    bot.entity.position.set(-18, 64, 12)
    it.continuity.recordConstruction({
      label: 'zinc_cabin_house',
      steps: Array.from({ length: 14 }, (_, i) => ({ x: -18 + (i % 4), y: 64, z: 12 + Math.floor(i / 4), name: 'stone_bricks' })),
      dim: 'overworld',
      origin: 'self'
    })
    assert.ok(it.continuity.identity.home, 'verified home established from self_built house')
    assert.equal(it.continuity.identity.home.basis, 'self_built')
  } finally {
    s.stop()
  }
})

// ============================================================================
// 10.5 Creative Problem Solving (Blocked Path -> Selective Dig Avoiding Walls)
// ============================================================================

test('10.5 creative problem solving: detects blocked path, switches from go_to to selective dig without breaking stone_bricks', async () => {
  // Enclose spawn completely at radius 3 in stone_bricks EXCEPT a dirt doorway at (3,64..65,0)!
  const blocks = {}
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      if (Math.abs(x) !== 3 && Math.abs(z) !== 3) continue
      for (let y = 64; y <= 66; y++) {
        blocks[`${x},${y},${z}`] = (x === 3 && z === 0 && y <= 65) ? 'dirt' : 'stone_bricks'
      }
    }
  }
  const bot = mutableBot({ blocks })
  const dugBlocks = []
  const origDig = bot.dig.bind(bot)
  bot.dig = async (b) => { dugBlocks.push(b.name); return origDig(b) }
  // Wire real A* route planning onto `pathfinder.setGoal` so walls emit `path_update: noPath` on `go_to` and `dig` breaks `toBreak` cells!
  const baseSetGoal = bot.pathfinder.setGoal.bind(bot.pathfinder)
  bot.pathfinder.setGoal = (g, dynamic) => {
    if (!g || !bot.pathfinder.movements) return baseSetGoal(g, dynamic)
    const res = world.plan(bot, bot.pathfinder.movements, g)
    if (res.status !== 'success') {
      baseSetGoal(null)
      setImmediate(() => bot.emit('path_update', { status: 'noPath' }))
      return
    }
    ;(async () => {
      for (const node of res.path) {
        for (const br of node.toBreak || []) {
          const blk = bot.blockAt(new Vec3(br.x, br.y, br.z))
          if (blk && blk.name !== 'air') await bot.dig(blk)
        }
      }
      baseSetGoal(g, dynamic)
    })()
  }

  let turn = 0
  const s = startTestSession({
    bot,
    actions: (p) => {
      turn++
      if (turn === 1) return { a: 'go_to', x: 6, y: 64, z: 0 }
      if (/go_to: FAILED/.test(p)) return { a: 'dig', x: 6, y: 64, z: 0, materials: ['dirt'], avoid: ['stone_bricks'] }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    assert.ok(await s.until(() => Math.hypot(bot.entity.position.x - 6, bot.entity.position.z) < 2.2, 6000), 'autonomous strategy switch from failed go_to to selective dig succeeded')
    assert.ok(s.internals().results.some((r) => r.label === 'go_to' && !r.ok), 'first attempt recorded go_to failure')
    assert.ok(dugBlocks.length >= 2 && dugBlocks.every((n) => n === 'dirt'), 'broke only dirt doorway, zero stone_bricks damaged')
    assert.equal(bot.blockAt(new Vec3(3, 64, 1)).name, 'stone_bricks', 'adjacent stone_bricks wall intact')
  } finally {
    s.stop()
  }
})

// ============================================================================
// 10.6 Natural Idle Behavior & Wake-Up Efficiency
// ============================================================================

test('10.6 idle & wake efficiency: respects calm idle periods, backs off check-ins, and skips heartbeats while body is busy', async () => {
  let busyFlag = false
  let nowMs = 1_000_000
  let turns = 0
  const { Brain } = require('../zincai/brain')
  const brain = new Brain({
    now: () => nowMs,
    heartbeatMs: 90_000,
    minIntervalMs: 3000,
    isBodyBusy: () => busyFlag,
    act: async () => { turns++; return { idle: true } },
    talk: async () => {}
  })

  busyFlag = true
  brain.lastActionAt = nowMs
  nowMs += 120_000
  await brain.tick()
  assert.equal(turns, 0, 'zero unsolicited heartbeat calls while body is actively progressing')

  busyFlag = false
  await brain.tick()
  assert.equal(turns, 1)
  await sleep(10)
  nowMs += 100_000
  await brain.tick()
  assert.equal(turns, 1, 'idle backoff respected: not woken again after 100s when idleStreak=1 (needs 180s)')
  nowMs += 90_000
  await brain.tick()
  assert.equal(turns, 2, 'woken cleanly once 180s backoff elapsed')
})

// ============================================================================
// 10.7 Emergency Interruption & Resume (Lava Hazard, Projectile Dodge, Mid-Build Flee)
// ============================================================================

test('10.7a emergency local reflexes: escapes lava contact and sidesteps incoming arrows with zero LLM latency', async () => {
  const bot = mutableBot({ blocks: { '0,64,0': 'lava' } })
  let llmCalls = 0
  const s = startTestSession({
    bot,
    actions: () => { llmCalls++; return { a: 'idle' } }
  })
  try {
    s.spawn()
    await sleep(80)
    const it = s.internals()
    await it.executeAction({ a: 'goal', operation: 'add', description: 'finish mining tunnel', priority: 70 }, { threatIds: [], askedBy: null })

    // 1. Lava contact triggers local System1 escape immediately (<200ms), zero LLM wait, preserving open goal!
    await it.system1.tick()
    assert.equal(it.system1.fleeing, true, 'lava contact activated survival escape reflex')
    assert.equal(it.arbiter.owner(), 'survival', 'survival lane took immediate control')
    assert.equal(it.goals.get('g1').status, 'pending', 'open goal was NOT cancelled by local hazard escape')

    // Move clear of lava -> survival releases automatically!
    bot.setBlock(0, 64, 0, 'air')
    bot.entity.position.set(2.5, 64, 0.5)
    await it.system1.tick()
    assert.equal(it.system1.fleeing, false, 'released hazard escape as soon as clear')

    // 2. Incoming arrow triggers 20 Hz perpendicular sidestep pulse in physicsTick!
    addEntity(bot, 77, 'arrow', 2.5, 64.9, -6.0, { x: 0, y: 0, z: 0.8 })
    bot.emit('physicsTick')
    const dodgedLeftOrRight = Boolean(bot.controls.left || bot.controls.right)
    assert.equal(dodgedLeftOrRight, true, '20 Hz physicsTick pulsed perpendicular sidestep against incoming arrow')
  } finally {
    s.stop()
  }
})

test('10.7b emergency mid-build interruption: pauses block placement during survival preemption and finishes build once safe', async () => {
  const bot = mutableBot({ items: [['stone_bricks', 16]] })
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  try {
    s.spawn()
    await sleep(100)
    const it = s.internals()
    await it.executeAction({ a: 'set_mode', mode: 'builder' }, { threatIds: [], askedBy: null })

    await it.executeAction({
      a: 'build_shape',
      shape: 'floor',
      block: 'stone_bricks',
      params: { w: 3, d: 3 },
      at: [1, 64, 1]
    }, snapNow(it, { askedBy: null }))

    // Preempt with survival lane briefly while build is running!
    await sleep(40)
    const survivalLane = it.arbiter.lane('survival')
    survivalLane.acquire({ ttlMs: 350, reason: 'creeper_nearby' })
    await sleep(250)
    survivalLane.release('safe')

    assert.ok(await s.until(() => {
      let count = 0
      for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) if (bot.blockAt(new Vec3(x, 64, z))?.name === 'stone_bricks') count++
      return count === 9
    }, 6000), 'all 9 blocks placed after survival preemption cleared')
  } finally {
    s.stop()
  }
})
