/**
 * 15 — Comprehensive verification of autonomous survival, 3-mode threat response,
 * weighted elliptical threat-aware navigation, high-level procedural skills,
 * autonomous survival planning, death cause & timestamped events, objective
 * continuity, and natural pt-BR social separation (real flying-squid + unit).
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

const { startSimulation } = require('./helpers/sim-harness')
const { ThreatResponseEngine, MODES, evaluateRecovery } = require('../zincai/threat_response')
const { chooseFood } = require('../zincai/system1')
const { PredictiveThreatMap } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { planSafeDetour, ellipseThreatCost } = require('../zincai/custom_mineflayer/escape')
const { SurvivalPlanner, inspectTools } = require('../zincai/survival_planner')
const { EventPipeline, formatWorldClock } = require('../zincai/events')
const { GoalRegistry } = require('../zincai/goals')
const { DeathRecovery, respawnSummary, inferDeathCause } = require('../zincai/death_recovery')
const { expectedDropsFor, DROP_ITEMS_FOR_BLOCK } = require('../zincai/procedures')
const { inventoryLine } = require('../zincai/observe')
const { RuntimeConfig } = require('../zincai/runtime_config')
const { SYSTEM_PROMPT, CHAT_PROMPT } = require('../zincai/index')

function makeMockBot ({
  pos = new Vec3(0, 64, 0),
  health = 20,
  food = 20,
  items = [],
  entities = {}
} = {}) {
  return {
    username: 'ZincAI',
    health,
    food,
    oxygenLevel: 20,
    entity: {
      id: 0,
      position: pos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      onGround: true,
      isInLava: false,
      isInWater: false
    },
    time: { timeOfDay: 6000, age: 30000, day: 1 },
    game: { dimension: 'overworld' },
    entities,
    players: {},
    inventory: {
      slots: [],
      items: () => items.slice()
    },
    registry: {
      items: {},
      blocksByName: {}
    },
    blockAt: (p) => {
      if (!p) return null
      if (p.y < 64) return { name: 'stone', boundingBox: 'block', position: p.clone() }
      return { name: 'air', boundingBox: 'empty', position: p.clone() }
    }
  }
}

/** Pure walkable flat-grid Movements mock for testing planSafeDetour. */
function flatMovements ({ blocked = new Set() } = {}) {
  const dirs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.41], [1, -1, 1.41], [-1, 1, 1.41], [-1, -1, 1.41]
  ]
  return {
    getNeighbors (node) {
      const out = []
      for (const [dx, dz, cost] of dirs) {
        const nx = node.x + dx
        const nz = node.z + dz
        if (blocked.has(`${nx},${nz}`)) continue
        out.push({ x: nx, y: node.y, z: nz, cost })
      }
      return out
    }
  }
}

describe('15 — autonomous threat response, elliptical nav, procedures, survival & events', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('15a: 3-mode ThreatResponseEngine handles AVOID, ENGAGE, FLEE, creeper priority, hysteresis & cooldowns', () => {
    let now = 10_000
    const engine = new ThreatResponseEngine({ now: () => now })

    // 1. Mid-range zombie while on an objective -> AVOID (does not preempt)
    const botArmed = makeMockBot({ health: 20, food: 20, items: [{ name: 'iron_sword', count: 1 }] })
    const farZombie = {
      id: 1, name: 'zombie', kind: 'mob', distance: 10, closing: 0.2,
      entity: { id: 1, name: 'zombie', position: new Vec3(10, 64, 0), metadata: [] }
    }
    const d1 = engine.evaluate(botArmed, [farZombie], { hasObjective: true })
    assert.equal(d1.mode, MODES.AVOID, 'moderate distant threat during objective should select AVOID')

    // 2. Close manageable zombie with iron_sword & healthy HP/food -> ENGAGE (even while tethered)
    const closeZombie = {
      id: 2, name: 'zombie', kind: 'mob', distance: 3.8, closing: 1.2,
      entity: { id: 2, name: 'zombie', position: new Vec3(3.8, 64, 0), metadata: [] }
    }
    const d2 = engine.evaluate(botArmed, [closeZombie], { hasObjective: true })
    assert.equal(d2.mode, MODES.ENGAGE, 'manageable close non-explosive hostile with iron sword should ENGAGE')
    assert.equal(d2.target.id, 2)

    // 3. Creeper at close range -> NEVER ENGAGE, immediate critical FLEE!
    const creeper = {
      id: 3, name: 'creeper', kind: 'mob', distance: 5.5, closing: 0.5, lit: false,
      entity: { id: 3, name: 'creeper', position: new Vec3(5.5, 64, 0), metadata: [] }
    }
    const d3 = engine.evaluate(botArmed, [creeper], { hasObjective: true })
    assert.equal(d3.mode, MODES.FLEE, 'creeper inside critical radius must trigger FLEE, never ENGAGE')
    assert.equal(d3.critical, true)

    // 4. Flee hysteresis: stays in FLEE until minFleeMs + calmMs clear, then exits with cooldown
    now += 400
    const dStay = engine.evaluate(botArmed, [], { hasObjective: true })
    assert.equal(dStay.mode, MODES.FLEE, 'flee should respect minFleeMs hysteresis before exiting')

    now += 2000
    const dExit = engine.evaluate(botArmed, [], { hasObjective: true })
    assert.equal(dExit.mode, MODES.NONE, 'flee exits cleanly once threats cleared past calmMs')
    assert.equal(dExit.exitedFlee, true)

    // 5. Non-critical trigger during flee cooldown stays in AVOID (no oscillation),
    //    whereas critical lit creeper bypasses cooldown immediately!
    const botMedium = makeMockBot({ health: 15, food: 20, items: [{ name: 'stone_sword', count: 1 }] })
    const pairZombies = [
      { id: 4, name: 'zombie', kind: 'mob', distance: 7.0, closing: 0.4, entity: { id: 4, name: 'zombie', position: new Vec3(7, 64, 0), metadata: [] } },
      { id: 6, name: 'zombie', kind: 'mob', distance: 7.5, closing: 0.4, entity: { id: 6, name: 'zombie', position: new Vec3(7.5, 64, 1), metadata: [] } }
    ]
    now += 300
    const dCooldown = engine.evaluate(botMedium, pairZombies, { hasObjective: false })
    assert.equal(dCooldown.mode, MODES.AVOID, 'non-critical trigger inside flee cooldown should stay in AVOID')

    const litCreeper = {
      id: 5, name: 'creeper', kind: 'mob', distance: 7.5, closing: 0.8, lit: true,
      entity: { id: 5, name: 'creeper', position: new Vec3(7.5, 64, 0), metadata: [] }
    }
    const dBypass = engine.evaluate(botMedium, [litCreeper], { hasObjective: false })
    assert.equal(dBypass.mode, MODES.FLEE, 'critical lit creeper must bypass flee cooldown immediately')
    assert.equal(dBypass.critical, true)

    // 6. Starving / low-food degrades combat odds -> never auto-engages when cannot sprint
    const botStarving = makeMockBot({ health: 16, food: 4, items: [{ name: 'iron_sword', count: 1 }] })
    const engine2 = new ThreatResponseEngine({ now: () => now })
    const dStarve = engine2.evaluate(botStarving, [closeZombie], { hasObjective: false })
    assert.notEqual(dStarve.mode, MODES.ENGAGE, 'must not auto-engage when food <= 6 (cannot sprint)')

    // 7. Post-flee recovery evaluation recommends eating when hurt/hungry with food carried
    const botHurtWithFood = makeMockBot({ health: 9, food: 12, items: [{ name: 'cooked_beef', count: 3 }] })
    const rec = evaluateRecovery(botHurtWithFood, { chooseFood })
    assert.equal(rec.shouldEat, true)
    assert.equal(rec.foodItem, 'cooked_beef')
  })

  it('15b: weighted directional elliptical threat field + pinch penalty + terrain-aware planSafeDetour', () => {
    const bot = makeMockBot({ pos: new Vec3(0, 64, 0) })
    const zEast = {
      id: 10, name: 'zombie', position: new Vec3(8, 64, 0),
      velocity: new Vec3(-0.18, 0, 0) // moving west toward bot!
    }
    const zNorth = {
      id: 11, name: 'zombie', position: new Vec3(8, 64, 4),
      velocity: new Vec3(-0.18, 0, 0)
    }
    bot.entities = { 10: zEast, 11: zNorth }

    const map = new PredictiveThreatMap({ now: () => 5000 })
    map.sample(bot, true)
    const ellipses = map.ellipses()
    assert.equal(ellipses.length, 2)
    assert.ok(ellipses[0].aForward > ellipses[0].bLateral, 'ellipse stretches further ahead along velocity than laterally')
    assert.ok(ellipses[0].bLateral > ellipses[0].aRear, 'ellipse is wider laterally than behind')

    // Forward point in front of moving zombie has much higher threat cost than behind it
    const aheadScore = map.threatScoreAt({ x: 4, y: 64, z: 0 })
    const behindScore = map.threatScoreAt({ x: 12, y: 64, z: 0 })
    assert.ok(aheadScore > behindScore * 1.5, `ahead score (${aheadScore}) should clearly exceed behind score (${behindScore})`)

    // Pinch zone between two overlapping enemy ellipses adds extra multi-enemy penalty
    const singleA = ellipseThreatCost([ellipses[0]], 6, 64, 2)
    const singleB = ellipseThreatCost([ellipses[1]], 6, 64, 2)
    const both = ellipseThreatCost(ellipses, 6, 64, 2)
    assert.ok(both.hits === 2 && both.score > singleA.score + singleB.score, 'overlapping ellipses apply pinch-zone penalty')

    // Safe detour planner routes around the pair toward destination (16, 64, 0) without entering critical zones
    const detour = planSafeDetour(bot, flatMovements(), { x: 16, y: 64, z: 0 }, map, { terrain: false })
    assert.ok(detour, 'planSafeDetour should produce a valid detour plan')
    assert.equal(detour.safe, true, 'chosen detour should avoid critical danger zones')
    assert.ok(Math.abs(detour.waypoint.z) >= 2 || detour.waypoint.x > 0, 'detour should swing cleanly around the zombie cluster')
  })

  it('15c: SurvivalPlanner prioritizes urgent food vs routine upkeep and stays quiet on empty world', () => {
    let now = 50_000
    const planner = new SurvivalPlanner({ now: () => now, idleGraceMs: 10_000 })

    // 1. Starving with raw beef + coal + furnace -> URGENT prepare_food (eat_after: true)
    const starvingRaw = makeMockBot({
      health: 10,
      food: 4,
      items: [{ name: 'beef', count: 3 }, { name: 'coal', count: 4 }, { name: 'furnace', count: 1 }]
    })
    const urgentPlan = planner.decide(starvingRaw, { busy: true, hasActiveGoal: true, idleMs: 0 })
    assert.ok(urgentPlan, 'starving with raw food + furnace should trigger urgent survival plan')
    assert.equal(urgentPlan.need.tier, 'urgent')
    assert.equal(urgentPlan.need.tool, 'prepare_food')
    assert.equal(urgentPlan.preemptObjective, true)
    assert.match(planner.promptLine(starvingRaw), /HUNGRY.*prepare_food/)

    // 2. Starving with no food at all + nearby cow -> URGENT hunt_and_loot
    const cow = { id: 50, name: 'cow', position: new Vec3(9, 64, 0), metadata: [] }
    const starvingHunt = makeMockBot({ health: 14, food: 5, items: [], entities: { 50: cow } })
    const huntPlan = planner.decide(starvingHunt, { busy: false, hasActiveGoal: false, idleMs: 0 })
    assert.equal(huntPlan?.need?.tool, 'hunt_and_loot')
    assert.equal(huntPlan?.need?.tier, 'urgent')

    // 3. Healthy + idle with worn-out pickaxe (5/131) and cobble/sticks -> ROUTINE craft stone_pickaxe
    const lowDurPick = { name: 'stone_pickaxe', count: 1, slot: 36, durabilityUsed: 126 }
    const wornBot = makeMockBot({
      health: 20,
      food: 20,
      items: [
        lowDurPick,
        { name: 'cooked_beef', count: 6 },
        { name: 'cobblestone', count: 10 },
        { name: 'stick', count: 4 }
      ]
    })
    const tools = inspectTools(wornBot)
    assert.equal(tools.lowDurability.length, 1)
    assert.equal(tools.lowDurability[0].remaining, 5)
    assert.match(inventoryLine(wornBot), /low durability: stone_pickaxe 5\/131/)
    const routinePlan = planner.decide(wornBot, { busy: false, hasActiveGoal: false, idleMs: 15_000 })
    assert.equal(routinePlan?.need?.tier, 'routine')
    assert.equal(routinePlan?.need?.tool, 'craft')
    assert.equal(routinePlan?.need?.args?.item, 'stone_pickaxe')

    // 4. Healthy + well-supplied on empty world -> returns null (never invents useless tasks)
    const emptyWorldBot = makeMockBot({
      health: 20,
      food: 20,
      items: [
        { name: 'iron_pickaxe', count: 1, slot: 36, durabilityUsed: 5 },
        { name: 'iron_sword', count: 1, slot: 37, durabilityUsed: 2 },
        { name: 'cooked_beef', count: 8 }
      ]
    })
    const nothing = planner.decide(emptyWorldBot, { busy: false, hasActiveGoal: false, idleMs: 60_000 })
    assert.equal(nothing, null, 'well-supplied bot on empty world must not spawn routine survival tasks')
  })

  it('15d: GoalRegistry dedupes open goals, preserves primary/subtask hierarchy & emits lifecycle events', () => {
    const lifecycle = []
    const reg = new GoalRegistry({
      onLifecycle: (e) => lifecycle.push(e.eventType)
    })

    const g1 = reg.add({ description: 'Build cottage', priority: 70 })
    const g1Dup = reg.add({ description: 'build cottage', priority: 60 })
    assert.equal(g1.id, g1Dup.id, 'duplicate open goal must reuse existing record')

    reg.activate(g1.id, { reason: 'start' })
    const sub = reg.add({ description: 'Gather oak logs', parentId: g1.id, priority: 65 })
    reg.activate(sub.id, { reason: 'step 1' })
    assert.equal(reg.primaryGoal().id, g1.id, 'primaryGoal must return top-level objective, not child subtask')
    assert.equal(reg.subtasksOf(g1.id).length, 1)

    reg.recordInterruption(g1.id, 'creeper flee', { by: 'survival' })
    assert.equal(reg.get(g1.id).status, 'resumable')
    reg.complete(sub.id, { note: 'logs collected' })
    const resumed = reg.resumePrimary('safe again')
    assert.equal(resumed.ok, true)
    assert.equal(reg.get(g1.id).status, 'active')
    assert.ok(lifecycle.includes('objective_started'))
    assert.ok(lifecycle.includes('objective_paused'))
    assert.ok(lifecycle.includes('objective_completed'))
    assert.ok(lifecycle.includes('objective_resumed'))
  })

  it('15e: EventPipeline formats UTC + elapsed + MC clock + priority badges; DeathRecovery preserves cause', () => {
    const pipe = new EventPipeline({ now: () => 1_700_000_010_000 })
    assert.equal(formatWorldClock({ timeOfDay: 0, day: 1 }), 'd1 06:00')
    assert.equal(formatWorldClock({ timeOfDay: 6000, day: 1 }), 'd1 12:00')
    assert.equal(formatWorldClock({ timeOfDay: 18000, day: 2 }), 'd2 00:00')

    const mockBot = makeMockBot()
    pipe.record({ eventType: 'death', summary: 'died at 10,64,5 (killed by creeper)', occurredAt: 1_700_000_005_000 }, mockBot)
    pipe.record({ eventType: 'repeated_action_failure', summary: 'dig failed 2 times', occurredAt: 1_700_000_007_000 }, mockBot)

    const formatted = pipe.formatForPrompt({ max: 6, nowMs: 1_700_000_010_000 })
    assert.match(formatted.text, /\[CRITICAL\]/)
    assert.match(formatted.text, /mc d1 12:00 day/)
    assert.match(formatted.text, /5s ago/)
    assert.match(formatted.text, /\[HIGH\].*repeated_action_failure/)

    // Death cause inference & respawn summary
    const cause = inferDeathCause(mockBot, { lastAttacker: { name: 'creeper', kind: 'mob' } })
    assert.equal(cause, 'killed by creeper')
    const dr = new DeathRecovery({ config: new RuntimeConfig({}) })
    dr.onDeath({ position: { x: 10, y: 64, z: 5 }, dimension: 'overworld', cause })
    const summary = respawnSummary(dr.lastDeath, { position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', health: 20, inventory: [] })
    assert.match(summary, /cause: killed by creeper/)

    // Verify expected drop mapping for mining verification
    assert.ok(expectedDropsFor(['stone']).has('cobblestone'))
    assert.ok(expectedDropsFor(['iron_ore']).has('raw_iron'))
    assert.ok(DROP_ITEMS_FOR_BLOCK.coal_ore.includes('coal'))

    // Verify natural pt-BR guidance & conversation/action separation exist in prompts
    assert.match(CHAT_PROMPT, /Brazilian Portuguese/)
    assert.match(CHAT_PROMPT, /Conversation vs\. action/)
    assert.match(SYSTEM_PROMPT, /mine_resource/)
    assert.match(SYSTEM_PROMPT, /hunt_and_loot/)
    assert.match(SYSTEM_PROMPT, /prepare_food/)
  })

  it('15f: real server — creeper triggers immediate FLEE (never ENGAGE), emits flee_start/flee_end & clears safely', async () => {
    sim = await startSimulation()
    const { mc, bot, internals, waitFor } = sim

    // Give iron sword + full HP: against a zombie it would ENGAGE, but against a creeper it MUST FLEE!
    mc.setHealth('ZincAI', 20, 20)
    mc.giveItem('ZincAI', 'iron_sword', 1)
    await waitFor(() => bot.inventory.items().some((i) => i.name === 'iron_sword'), { label: 'iron_sword ready' })

    const origin = bot.entity.position.floored()
    const creeperPos = origin.offset(4, 0, 0)
    const creeper = mc.spawnMob('creeper', creeperPos, { health: 20 })
    await waitFor(() => Object.values(bot.entities).some((e) => e.name === 'creeper'), { label: 'creeper visible' })

    await waitFor(() => {
      const dist = bot.entity.position.distanceTo(creeperPos)
      const evts = internals.events.events
      const sawFleeStart = evts.some((e) => e.eventType === 'flee_start')
      return dist >= 6.8 && (sawFleeStart || internals.system1.threatMode === MODES.FLEE)
    }, { timeoutMs: 14_000, label: 'immediate flee away from creeper despite carrying iron_sword' })

    assert.notEqual(internals.combat.isEngaged, true, 'must never auto-engage a creeper in melee')

    // Remove creeper -> flee exits cleanly and emits flee_end
    mc.destroyMob(creeper)
    await waitFor(() => !internals.system1.fleeing && internals.events.events.some((e) => e.eventType === 'flee_end'), {
      timeoutMs: 12_000,
      label: 'flee_end emitted after creeper cleared'
    })
  })

  it('15g: real server — mine_resource breaks blocks & verifies drops; hunt_and_loot enforces safety guard & kills real cow; prepare_food diagnoses missing furnace honestly', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    const origin = bot.entity.position.floored()
    // Place real oak_log blocks right beside ZincAI
    const log1 = origin.offset(3, 0, 0)
    const log2 = origin.offset(3, 1, 0)
    mc.setBlock(log1, 'oak_log')
    mc.setBlock(log2, 'oak_log')
    await waitFor(() => bot.blockAt(log1)?.name === 'oak_log', { label: 'oak_log visible' })

    // 1. mine_resource mines real oak_log blocks and verifies inventory drop pickup
    llm.enqueueAction({
      reasoning: 'Mine 2 oak_log blocks via mine_resource procedure.',
      toolCalls: [{ name: 'mine_resource', arguments: { item: 'oak_log', count: 2, radius: 16 } }]
    })
    internals.brain.wake('mine oak logs', { external: true, urgent: true })
    await waitFor(() => bot.blockAt(log1)?.name === 'air' && bot.blockAt(log2)?.name === 'air', {
      timeoutMs: 15_000,
      label: 'mine_resource broke both oak_log blocks on server'
    })
    await waitFor(() => internals.results.some((r) => r.label === 'mine_resource' && r.ok && /\+2/.test(r.msg)), {
      timeoutMs: 8_000,
      label: 'mine_resource reported verified +2 oak_log collection'
    })

    // 2. prepare_food with raw beef and no furnace reports honest diagnostic (never hallucinates success)
    mc.giveItem('ZincAI', 'beef', 2)
    await waitFor(() => bot.inventory.items().some((i) => i.name === 'beef' && i.count >= 2), { label: 'raw beef received' })
    llm.enqueueAction({
      reasoning: 'Try preparing raw beef.',
      toolCalls: [{ name: 'prepare_food', arguments: { item: 'beef', count: 2 } }]
    })
    internals.brain.wake('prepare beef', { external: true, urgent: true })
    await waitFor(() => internals.results.some((r) => r.label === 'prepare_food' && /no furnace/i.test(r.msg)), {
      timeoutMs: 8_000,
      label: 'prepare_food honestly reported missing furnace'
    })

    // 3. hunt_and_loot refuses protected targets (villager)
    llm.enqueueAction({
      reasoning: 'Test safety guard against protected target.',
      toolCalls: [{ name: 'hunt_and_loot', arguments: { target: 'villager', count: 1 } }]
    })
    internals.brain.wake('test hunt guard', { external: true, urgent: true })
    await waitFor(() => internals.results.some((r) => r.label === 'hunt_and_loot' && !r.ok && /refused|protected/i.test(r.msg)), {
      timeoutMs: 8_000,
      label: 'hunt_and_loot refused protected villager target'
    })

    // 4. hunt_and_loot hunts a real cow on flying-squid server
    mc.giveItem('ZincAI', 'iron_sword', 1)
    await waitFor(() => bot.inventory.items().some((i) => i.name === 'iron_sword'), { label: 'iron_sword ready' })
    const cowPos = bot.entity.position.floored().offset(5, 0, 0)
    const cow = mc.spawnMob('cow', cowPos, { health: 6 })
    await waitFor(() => Object.values(bot.entities).some((e) => e.id === cow.id), { label: 'real cow visible' })

    llm.enqueueAction({
      reasoning: 'Hunt the nearby cow for food.',
      toolCalls: [{ name: 'hunt_and_loot', arguments: { target: 'cow', count: 1, radius: 24 } }]
    })
    internals.brain.wake('hunt cow', { external: true, urgent: true })
    await waitFor(() => !mc.serv.entities[cow.id] || cow.health <= 0, {
      timeoutMs: 15_000,
      label: 'hunt_and_loot killed real cow on server'
    })
    await waitFor(() => internals.results.some((r) => r.label === 'hunt_and_loot' && r.ok && /hunted cow/i.test(r.msg)), {
      timeoutMs: 8_000,
      label: 'hunt_and_loot verified hunt completion'
    })
  })

  it('15h: real server — peaceful player approaching + pt-BR casual chat do not cancel active objective; death records cause + respawn event', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    // Start a real walking objective
    const origin = bot.entity.position.floored()
    const dest = origin.offset(14, 0, 0)
    llm.enqueueAction({
      reasoning: 'Walk to destination.',
      toolCalls: [{ name: 'go_to', arguments: { x: dest.x, z: dest.z } }]
    })
    internals.brain.wake('walk east', { external: true, urgent: true })
    await waitFor(() => internals.agenda.main?.tool === 'go_to', { timeoutMs: 8_000, label: 'go_to objective active' })

    // Connect a real peaceful player nearby & send casual pt-BR greeting
    const friend = await mc.connectPlayer('Lucas')
    try {
      llm.enqueueChat({
        reasoning: 'Resposta casual em pt-BR sem mexer no objetivo atual.',
        reply: { text: 'Opa Lucas, tudo certo! Só dando uma caminhada aqui.' }
      })
      friend.chat('E aí Zinc, tudo bem?')

      await waitFor(() => bot.entity.position.distanceTo(dest) <= 3.5, {
        timeoutMs: 15_000,
        label: 'active go_to objective completed undisturbed by peaceful player or casual chat'
      })
      await waitFor(() => internals.events.events.some((e) => e.eventType === 'player_approaching'), {
        timeoutMs: 10_000,
        label: 'informational player_approaching recorded'
      })
      assert.equal(internals.system1.fleeing, false, 'peaceful player must never trigger flee')
    } finally {
      try { friend.quit() } catch { /* gone */ }
    }

    // Trigger real death & respawn lifecycle and verify cause + timestamped events
    internals.kill()
    await waitFor(() => internals.events.events.some((e) => e.eventType === 'death'), {
      timeoutMs: 5_000,
      label: 'death event recorded'
    })
    assert.ok(internals.deathRecovery.lastDeath?.cause, 'death recovery records death cause')
    internals.respawn()
    await waitFor(() => internals.events.events.some((e) => e.eventType === 'respawn'), {
      timeoutMs: 8_000,
      label: 'respawn event recorded'
    })
  })
})
