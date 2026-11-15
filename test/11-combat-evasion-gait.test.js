'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')

const { MotionTracker, forecastImpact } = require('../src/combat')
const { isAutoFightCandidate, canHaveOwner } = require('../zincai/threats')
const { situation, describeSituation } = require('../zincai/tactics')
const { ReflexRegistry } = require('../zincai/reflex_registry')
const { System1 } = require('../zincai/system1')
const { PathfinderWrapper } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { selfLine } = require('../zincai/observe')
const { createZincTools } = require('../zincai/api_wrapper')
const { TOOL_LANES, LANES } = require('../zincai/lanes')

function mockWorldBot ({ pos = new Vec3(0, 64, 0), health = 20, food = 20, items = [], entities = {} } = {}) {
  const controls = {}
  const listeners = new Map()
  const bot = {
    username: 'ZincAI',
    health,
    food,
    entity: {
      id: 999,
      type: 'player',
      position: pos.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      isInWater: false,
      isInLava: false,
      isSneaking: false
    },
    entities,
    players: {},
    heldItem: items[0] || null,
    controlState: controls,
    inventory: {
      slots: [],
      items: () => items
    },
    pathfinder: {
      movements: { allowSprinting: true },
      goal: null,
      isMoving: () => Boolean(bot.pathfinder.goal),
      setGoal (g) { bot.pathfinder.goal = g }
    },
    blockAt (p) {
      const y = Math.floor(p.y)
      if (y <= 63) return { name: 'grass_block', boundingBox: 'block', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) }
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) }
    },
    setControlState (k, v) {
      controls[k] = Boolean(v)
      if (k === 'sneak') bot.entity.isSneaking = Boolean(v)
    },
    clearControlStates () {
      for (const k of Object.keys(controls)) controls[k] = false
      bot.entity.isSneaking = false
    },
    look (yaw) {
      bot.entity.yaw = yaw
      return Promise.resolve()
    },
    lookAt () { return Promise.resolve() },
    on (ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev).add(fn)
    },
    removeListener (ev, fn) {
      listeners.get(ev)?.delete(fn)
    },
    emit (ev, ...args) {
      for (const fn of listeners.get(ev) || []) fn(...args)
    }
  }
  return { bot, controls }
}

test('11a: Trident, spear, and mace evasion work in forecastImpact and idle System1', () => {
  const me = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) }

  // 1. Sprinting player with trident (5.6 b/s = 0.28 b/tick, no usingItem/gliding)
  const tridentAttacker = {
    id: 10,
    type: 'player',
    username: 'Attacker',
    position: new Vec3(0, 64, 4.5),
    heldItem: { name: 'trident' }
  }
  const tridentImp = forecastImpact(tridentAttacker, me, { vx: 0, vy: 0, vz: -0.28, falling: false, fallen: 0 }, {})
  assert.ok(tridentImp, 'expected trident sprint charge to trigger impact forecast')
  assert.equal(tridentImp.kind, 'charge')

  // 2. Sprinting player with iron_spear
  const spearAttacker = {
    id: 11,
    type: 'player',
    username: 'Spearman',
    position: new Vec3(4.2, 64, 0),
    heldItem: { name: 'iron_spear' }
  }
  const spearImp = forecastImpact(spearAttacker, me, { vx: -0.28, vy: 0, vz: 0, falling: false, fallen: 0 }, {})
  assert.ok(spearImp, 'expected spear sprint charge to trigger impact forecast')
  assert.equal(spearImp.kind, 'charge')

  // 3. Mace jump-smash (earlier fall >= 0.7 blocks & rising leap) + ground sprint-charge
  const maceFaller = {
    id: 12,
    type: 'player',
    username: 'Macer',
    position: new Vec3(0.5, 66.2, 0.5),
    heldItem: { name: 'mace' }
  }
  const smashImp = forecastImpact(maceFaller, me, { vx: -0.02, vy: -0.28, vz: -0.02, falling: true, fallen: 0.9 }, {})
  assert.ok(smashImp, 'expected mace falling smash to trigger impact forecast')
  assert.equal(smashImp.kind, 'smash')

  const maceRunner = {
    id: 13,
    type: 'player',
    username: 'MaceRunner',
    position: new Vec3(0, 64, 5.0),
    heldItem: { name: 'mace' }
  }
  const maceCharge = forecastImpact(maceRunner, me, { vx: 0, vy: 0, vz: -0.28, falling: false, fallen: 0 }, {})
  assert.ok(maceCharge, 'expected mace sprint charge to trigger impact forecast')
  assert.equal(maceCharge.kind, 'charge')

  // 4. Idle System1 (no active combat) dodges when a player runs at it with a trident
  let fakeNow = 10_000
  const runner = {
    id: 21,
    type: 'player',
    username: 'Lancer',
    position: new Vec3(0, 64, 5.6),
    heldItem: { name: 'trident' },
    metadata: []
  }
  const { bot, controls } = mockWorldBot({ entities: { 21: runner } })
  const events = []
  const sys1 = new System1(bot, {
    registry: new ReflexRegistry(),
    now: () => fakeNow,
    onEvent: (e) => events.push(e)
  })
  // Feed 3 motion ticks so MotionTracker measures sprint velocity (~5.6 b/s toward bot)
  for (let i = 0; i < 3; i++) {
    fakeNow += 50
    runner.position = new Vec3(0, 64, 5.6 - (i + 1) * 0.28)
    sys1._evadeIncomingStrike()
  }
  assert.ok(sys1._impactEvade, 'idle System1 should initiate evade against trident runner')
  assert.equal(controls.forward, true)
  assert.equal(controls.sprint, true)
  assert.ok(events.some((e) => e.type === 'evade'), 'should emit evade event')
  sys1.stop()
})

test('11b: Combat odds & auto-kiting engage unnamed unowned hostiles with good gear, flee when outmatched, and respect holds', async () => {
  const { bot } = mockWorldBot({
    health: 20,
    food: 20,
    items: [{ name: 'iron_sword', count: 1 }]
  })

  const wildZombie = { id: 101, name: 'zombie', position: new Vec3(5, 64, 0), metadata: [] }
  const namedZombie = { id: 102, name: 'zombie', position: new Vec3(5, 64, 0), metadata: [0, 0, 'Bob'] }
  const wolf = { id: 103, name: 'wolf', position: new Vec3(5, 64, 0), metadata: [] }
  const villager = { id: 104, name: 'villager', position: new Vec3(5, 64, 0), metadata: [] }

  assert.equal(isAutoFightCandidate(wildZombie, bot), true)
  assert.equal(isAutoFightCandidate(namedZombie, bot), false)
  assert.equal(canHaveOwner(wolf), true)
  assert.equal(isAutoFightCandidate(wolf, bot), false)
  assert.equal(isAutoFightCandidate(villager, bot), false)

  // Single zombie with iron_sword at 20 HP -> high winChance & autoEngage=true
  const soloSit = situation(bot, [{
    id: 101, name: 'zombie', kind: 'mob', distance: 5, where: '5m E', entity: wildZombie, closing: 1.5
  }])
  assert.ok(soloSit.fight.winChance >= 75, `expected >=75% winChance, got ${soloSit.fight.winChance}`)
  assert.equal(soloSit.fight.autoEngage, true)
  const desc = describeSituation(soloSit).join('\n')
  assert.match(desc, /win ~\d+%/)

  // Overwhelming horde (20 zombies, no armor) -> low winChance & autoEngage=false
  const horde = Array.from({ length: 20 }, (_, i) => ({
    id: 200 + i, name: 'zombie', kind: 'mob', distance: 5, where: '5m E',
    entity: { id: 200 + i, name: 'zombie', position: new Vec3(5, 64, i * 0.2), metadata: [] },
    closing: 1.8
  }))
  const hordeSit = situation(bot, horde)
  assert.ok(hordeSit.fight.winChance < 65, `expected <65% winChance vs 20 zombies, got ${hordeSit.fight.winChance}`)
  assert.equal(hordeSit.fight.autoEngage, false)

  // System1 auto-engages wild zombie instead of fleeing, and respects suppressAutoFight
  bot.entities = { 101: wildZombie }
  let engagedWith = null
  const mockCombat = {
    isEngaged: false,
    autoDefense: false,
    cooldownUntil: 0,
    target: null,
    async engage (req, opts) {
      engagedWith = { req, opts }
      this.isEngaged = true
      this.autoDefense = Boolean(opts?.autoDefense)
      this.target = wildZombie
      return { ok: true, target: 'zombie' }
    },
    disengage () {
      this.isEngaged = false
      this.autoDefense = false
      this.target = null
    }
  }
  const sys1 = new System1(bot, { registry: new ReflexRegistry(), combat: mockCombat })
  sys1.registerBuiltins()
  await sys1.tick()
  assert.ok(engagedWith, 'System1 should auto-engage unnamed zombie when well-armed')
  assert.equal(engagedWith.opts.autoDefense, true)
  assert.equal(sys1.fleeing, false, 'should not panic-flee when auto-engaging favorable odds')

  // Model overrides via suppressAutoFight / hold
  mockCombat.disengage()
  engagedWith = null
  sys1.suppressAutoFight([101], 30_000)
  sys1.clearDecision()
  await sys1.tick()
  assert.equal(engagedWith, null, 'must not re-auto-engage after model suppressed it')
  sys1.stop()
})

test('11c: Speed observation, gait control, pace tool, and prompt improvements', () => {
  const { bot, controls } = mockWorldBot()
  const wrapper = new PathfinderWrapper(bot)
  wrapper.apply()

  assert.equal(wrapper.setGait('crouch'), 'crouch')
  assert.equal(controls.sneak, true)
  assert.equal(bot.pathfinder.movements.allowSprinting, false)

  assert.equal(wrapper.setGait('walk'), 'walk')
  assert.equal(controls.sneak, false)
  assert.equal(bot.pathfinder.movements.allowSprinting, false)

  assert.equal(wrapper.setGait('sprint'), 'sprint')
  assert.equal(bot.pathfinder.movements.allowSprinting, true)

  assert.equal(wrapper.setGait('sprint_jump'), 'sprint_jump')
  assert.equal(bot.pathfinder.movements.allowSprinting, true)

  // Simulate movement ticks so speed measurement reports live m/s in selfLine()
  bot.pathfinder.goal = { x: 40, z: 0 }
  for (let i = 1; i <= 5; i++) {
    bot.entity.position = new Vec3(i * 0.35, 64, 0)
    bot.entity.velocity = new Vec3(0.35, 0, 0)
    bot.emit('physicsTick')
  }
  const motion = wrapper.getMotionState()
  assert.ok(motion.speedMs > 0, `expected positive speed, got ${motion.speedMs}`)
  const line = selfLine(bot)
  assert.match(line, /speed \d+\.\d+ m\/s \(/)

  assert.equal(wrapper.jumpOnce(), true)
  assert.equal(controls.jump, true)

  wrapper.stop()

  // Tool contract: pace exists on INTERACTION lane; go_to/dig/follow expose gait
  const tools = createZincTools()
  const byName = new Map(tools.map((t) => [t.function.name, t.function]))
  assert.ok(tools.length >= 35)
  assert.ok(byName.has('pace'))
  assert.equal(TOOL_LANES.pace, LANES.INTERACTION)
  for (const name of ['go_to', 'dig', 'follow']) {
    assert.ok(byName.get(name).parameters.properties.gait, `${name} should accept gait`)
  }

  // Prompt improvements: screenshot encouraged before digging/building, rich house design, speed & gaits
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  assert.ok(!prompt.includes('3x3 hut'), 'prompt should no longer encourage basic 3x3 huts')
  assert.match(prompt, /Before `dig`, `gather`, or clearing ground/)
  assert.match(prompt, /sprint_jump/)
  assert.match(prompt, /Architectural Planning/)
})
