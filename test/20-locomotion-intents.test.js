'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { goals } = require('mineflayer-pathfinder')
const { startSimulation } = require('./helpers/sim-harness')

test('real route keeps its destination through sprint, hunger downgrade and precision restoration', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const nav = internals.navigationIntents
  const wrapper = internals.wrapper
  const route = nav.register({ id: 'real-route' })
  const fast = nav.register({ id: 'real-style' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 14, from.y, from.z)
  route.publishGoal('destination', { goal })
  await waitFor(() => bot.pathfinder.isMoving() && wrapper.locomotionStats().mode === 'walk', { label: 'normal walking' })
  route.publishLocomotion('careful', { mode: 'precision', goal, expiresAt: Date.now() + 15_000 })
  await waitFor(() => wrapper.locomotionStats().mode === 'precision' && bot.controlState.sneak, { label: 'precision approach' })
  fast.publishLocomotion('urgent-travel', { mode: 'sprint', tier: 'urgent', goal, expiresAt: Date.now() + 15_000 })
  await waitFor(() => wrapper.locomotionStats().mode === 'sprint' && bot.controlState.sprint, { label: 'sprint on same route' })
  assert.equal(bot.pathfinder.goal, goal)
  mc.setHealth(bot.username, 20, 5)
  await waitFor(() => bot.food === 5 && wrapper.locomotionStats().mode === 'walk' && !bot.controlState.sprint, { label: 'low food blocks sprint' })
  assert.equal(bot.pathfinder.goal, goal)
  nav.unregister('real-style')
  await waitFor(() => wrapper.locomotionStats().mode === 'precision', { label: 'lower directive resumes' })
  route.withdrawLocomotion('careful')
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'original goal reached' })
  const stats = wrapper.locomotionStats()
  assert.ok(stats.transitions >= 4)
  assert.ok(stats.safetyDowngrades >= 1)
  t.diagnostic(JSON.stringify(stats))
})

test('real sprint-jump route launches an optional jump on loaded flat ground', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const nav = internals.navigationIntents
  const mode = nav.register({ id: 'jump-probe' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 36, from.y, from.z)
  mode.publishGoal('flat-route', { goal })
  const wrapper = internals.wrapper
  const samples = []
  const sample = () => samples.push({ pulse: wrapper._jumpPulseUntil, jump: bot.controlState.jump, grounded: bot.entity.onGround })
  bot.on('physicsTick', sample)
  t.after(() => bot.removeListener('physicsTick', sample))
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'automatic sprint-jump reaches destination' })
  const pulses = samples.flatMap((s, i) => s.pulse ? [i] : [])
  assert.ok(pulses.length >= 2, 'consecutive optional jumps on a long route')
  for (const i of pulses) {
    assert.equal(samples[i].jump, true)
    assert.equal(samples[i].grounded, true)
    assert.equal(samples[i + 1]?.grounded, false, 'pulse launches a physical jump')
    assert.equal(samples[i + 1]?.pulse, 0, 'pulse clears by the next physics tick')
    assert.equal(samples[i + 1]?.jump, false, 'jump key is not held in flight')
  }
  const stats = internals.wrapper.locomotionStats()
  assert.ok(stats.optionalJumps > 0, 'loaded flat sprint route should permit at least one simulated safe jump')
  t.diagnostic(JSON.stringify(stats))
})

test('real route cancellation clears a pending optional jump before physics can consume it', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const { wrapper, navigationIntents } = internals
  const route = navigationIntents.register({ id: 'cancel-jump' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 32, from.y, from.z)
  let cancelled
  const inspect = () => {
    if (!wrapper._jumpPulse || cancelled) return
    route.withdrawGoal('destination')
    cancelled = { pulse: wrapper._jumpPulseUntil, key: bot.controlState.jump, queued: bot.jumpQueued }
  }
  bot.on('physicsTick', inspect)
  t.after(() => bot.removeListener('physicsTick', inspect))
  route.publishGoal('destination', { goal })
  await waitFor(() => cancelled, { label: 'cancel during the optional pulse' })
  assert.deepEqual(cancelled, { pulse: 0, key: false, queued: false })
  assert.equal(bot.pathfinder.goal, null)
})

test('real native pathfinder steps up onto a raised destination without an optional pulse', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const route = internals.navigationIntents.register({ id: 'native-step' })
  const from = bot.entity.position.floored()
  const block = from.offset(5, 0, 0)
  await mc.setBlock(block, 'stone')
  const goal = new goals.GoalBlock(block.x, block.y + 1, block.z)
  route.publishLocomotion('walk', { mode: 'walk', goal, expiresAt: Date.now() + 10_000 })
  route.publishGoal('destination', { goal })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'native jump onto stone' })
  assert.equal(internals.wrapper.locomotionStats().optionalJumps, 0)
})

test('changing gait during a real optional pulse clears the held and queued jump', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const { wrapper, navigationIntents } = internals
  const route = navigationIntents.register({ id: 'interrupt-style' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 32, from.y, from.z)
  let switched
  const inspect = () => {
    if (!wrapper._jumpPulse || switched) return
    wrapper.setGait('walk')
    switched = { pulse: wrapper._jumpPulseUntil, key: bot.controlState.jump, queued: bot.jumpQueued }
  }
  bot.on('physicsTick', inspect)
  t.after(() => bot.removeListener('physicsTick', inspect))
  route.publishGoal('destination', { goal })
  await waitFor(() => switched && wrapper.locomotionStats().mode === 'walk', { label: 'switch to walk during pulse' })
  assert.deepEqual(switched, { pulse: 0, key: false, queued: false })
  assert.equal(bot.pathfinder.goal, goal)
})

test('real low-clearance tunnel permits travel but vetoes optional jumps', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const route = internals.navigationIntents.register({ id: 'low-clearance' })
  const from = bot.entity.position.floored()
  await mc.fillBlocks(from.offset(-1, 2, -1), from.offset(19, 2, 1), 'stone')
  const goal = new goals.GoalBlock(from.x + 18, from.y, from.z)
  route.publishLocomotion('fast', { mode: 'sprint_jump', goal, expiresAt: Date.now() + 15_000 })
  route.publishGoal('destination', { goal })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'travel under low ceiling' })
  assert.equal(internals.wrapper.locomotionStats().optionalJumps, 0)
})

test('real pace jump shares pulse ownership across stop, route, gait and emergency handoff', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, internals, waitFor } = sim
  const { wrapper, arbiter, navigationIntents } = internals
  const act = (action) => internals.executeAction(action, internals.buildActionPrompt(['pace pulse integration']))
  const jump = async () => {
    await act({ a: 'pace', jump: true })
    assert.equal(wrapper._jumpPulse?.kind, 'manual')
    assert.equal(bot.controlState.jump, true)
    assert.equal(bot.jumpQueued, true)
    return wrapper._jumpPulse
  }
  const clear = () => {
    assert.equal(wrapper._jumpPulseUntil, 0)
    assert.equal(bot.controlState.jump, false)
    assert.equal(bot.jumpQueued, false)
  }
  await waitFor(() => bot.entity.onGround && !bot.controlState.jump && !bot.jumpQueued, { label: "settled before manual jump" })
  // Freeze physics to reproduce a pending pulse and exercise its watchdog
  // independently of physicsTick. The actual controls are Mineflayer's.
  bot.physicsEnabled = false
  const stale = await jump()
  await act({ a: 'stop' })
  clear()
  const current = await jump()
  assert.notEqual(current, stale)
  assert.equal(wrapper.cancelJumpPulse(stale), false)
  assert.equal(bot.controlState.jump, true)
  await act({ a: 'pace', gait: 'walk' })
  clear()
  await jump()
  const origin = bot.entity.position.floored()
  const route = navigationIntents.register({ id: 'pace-route' })
  route.publishGoal('replacement', { goal: new goals.GoalBlock(origin.x + 10, origin.y, origin.z) })
  clear()
  await jump()
  const urgent = arbiter.lane('test-emergency', 'survival')
  urgent.acquire({ reason: 'test pending jump ownership transfer' })
  clear()
  urgent.setControlState('jump', true)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(bot.controlState.jump, true, 'old watchdog cannot release the new driver’s key')
  urgent.setControlState('jump', false)
  urgent.release('test takeover ended')
  route.withdrawGoal('replacement')
  bot.physicsEnabled = true
  await waitFor(() => bot.entity.onGround && !bot.jumpQueued, { label: 'emergency control drained' })
  for (let i = 0; i < 2; i++) {
    await jump()
    await waitFor(() => !bot.entity.onGround && !bot.controlState.jump, { label: 'manual physical takeoff and key release' })
    await waitFor(() => bot.entity.onGround, { label: 'manual landing' })
  }
  bot.physicsEnabled = false
  await jump()
  await waitFor(() => wrapper._jumpPulseUntil === 0, { label: 'watchdog without physics ticks' })
  clear()
  await act({ a: 'pace', gait: 'auto' })
  let autoPulse
  let manualAttempt
  const overlap = () => {
    if (autoPulse || wrapper._jumpPulse?.kind !== 'automatic') return
    autoPulse = wrapper._jumpPulse
    bot.physicsEnabled = false
    manualAttempt = act({ a: 'pace', jump: true }).then(() => {
      assert.equal(wrapper._jumpPulse, autoPulse, 'manual request cannot overwrite automatic ownership')
      assert.equal(bot.controlState.jump, true)
    })
  }
  bot.on('physicsTick', overlap)
  t.after(() => bot.removeListener('physicsTick', overlap))
  bot.physicsEnabled = true
  route.publishGoal('replacement', { goal: new goals.GoalBlock(origin.x + 36, origin.y, origin.z) })
  await waitFor(() => autoPulse, { label: 'automatic pulse after consecutive manual jumps' })
  await manualAttempt
  route.withdrawGoal('replacement')
  clear()
  bot.physicsEnabled = true
})

for (const kind of ['automatic', 'manual']) test(`real creeper entering during a ${kind} pulse takes survival priority and route resumes`, async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const { wrapper, system1, arbiter, navigationIntents } = internals
  const route = navigationIntents.register({ id: 'creeper-interruption-route' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 36, from.y, from.z)
  let creeper, danger, oldPulse, packetState
  const spawnDuringPulse = () => {
    if (creeper || wrapper._jumpPulse?.kind !== kind) return
    oldPulse = wrapper._jumpPulse
    assert.equal(bot.controlState.jump, true)
    bot.physicsEnabled = false
    danger = bot.entity.position.offset(4, 0, 0)
    creeper = mc.spawnMob('creeper', danger)
  }
  const receive = entity => {
    if (entity.id !== creeper?.id) return
    packetState = { pulse: wrapper._jumpPulseUntil, jump: bot.controlState.jump, queued: bot.jumpQueued }
    bot.physicsEnabled = true
  }
  if (kind === 'automatic') bot.on('physicsTick', spawnDuringPulse)
  bot.on('entitySpawn', receive)
  t.after(() => { bot.removeListener('physicsTick', spawnDuringPulse); bot.removeListener('entitySpawn', receive) })
  route.publishGoal('destination', { goal })
  if (kind === 'manual') {
    await waitFor(() => bot.entity.onGround && !bot.jumpQueued, { label: 'grounded before pace' })
    bot.physicsEnabled = false
    await internals.executeAction({ a: 'pace', jump: true }, internals.buildActionPrompt(['manual jump before danger']))
    assert.equal(wrapper._jumpPulse?.kind, 'manual')
    spawnDuringPulse()
  }
  await waitFor(() => packetState, { label: 'real creeper packet during pending jump' })
  assert.deepEqual(packetState, { pulse: 0, jump: false, queued: false })
  await waitFor(() => system1.fleeing && arbiter.top()?.priority >= 3 && bot.entity.position.distanceTo(danger) > 6, { label: 'survival takes priority and opens distance' })
  assert.notEqual(wrapper._jumpPulse, oldPulse)
  mc.destroyMob(creeper)
  await waitFor(() => !system1.fleeing && bot.pathfinder.goal === goal, { label: 'same original route resumes' })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'original destination reached after threat', timeoutMs: 25_000 })
})

test('real sustained combat retains sprint preference and restores a suspended route on target loss', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const { combat, arbiter, navigationIntents } = internals
  const from = bot.entity.position.floored()
  await mc.fillBlocks(from.offset(-2, -1, -2), from.offset(24, -1, 2), 'soul_sand')
  mc.giveItem(bot.username, 'iron_sword', 1)
  await waitFor(() => bot.inventory.items().some(item => item.name === 'iron_sword'), { label: 'sword equipped for pursuit' })
  const target = mc.spawnMob('zombie', from.offset(22, 0, 0))
  await waitFor(() => bot.entities[target.id], { label: 'exact target visible' })
  const route = navigationIntents.register({ id: 'suspended-home' })
  const home = new goals.GoalBlock(from.x - 12, from.y, from.z)
  route.publishGoal('home', { goal: home })
  const engaged = await combat.engage({ entityId: target.id })
  assert.equal(engaged.ok, true, engaged.why)
  const startedAt = Date.now()
  await waitFor(() => {
    assert.equal(combat.target?.id, target.id)
    assert.equal(arbiter.owner(), 'combat')
    assert.equal(navigationIntents.resolveLocomotion({ goal: bot.pathfinder.goal, owner: 'combat' })?.mode, 'sprint')
    return Date.now() - startedAt >= 5200
  }, { label: 'valid uninterrupted sprint approach over five seconds' })
  const danger = bot.entity.position.offset(0, 0, 4)
  const creeper = mc.spawnMob('creeper', danger)
  await waitFor(() => internals.system1.fleeing && arbiter.top()?.priority >= 3 && bot.entity.position.distanceTo(danger) > 6, { label: 'creeper interrupts combat with physical egress' })
  mc.destroyMob(target)
  mc.destroyMob(creeper)
  await waitFor(() => !combat.isEngaged && bot.pathfinder.goal === home, { label: 'target loss restores exact prior home goal' })
  assert.equal(navigationIntents.resolveLocomotion({ goal: home, owner: arbiter.owner() }), null)
  await waitFor(() => home.isEnd(bot.entity.position.floored()), { label: 'arrived at original home after combat', timeoutMs: 25_000 })
})

test('server block changes veto optional launch over liquids, steps and dangerous drops', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const { wrapper, navigationIntents } = internals
  const route = navigationIntents.register({ id: 'changed-landing' })
  const from = bot.entity.position.floored()
  const goal = new goals.GoalBlock(from.x + 36, from.y, from.z)
  let landing
  const freeze = () => {
    const pos = bot.entity.position
    if (landing || Math.floor(pos.x / 16) === Math.floor((pos.x + 3) / 16) || !wrapper._safeOptionalJump()) return
    bot.physicsEnabled = false
    wrapper.cancelJumpPulse()
    landing = bot.entity.position.offset(3, 0, 0).floored()
  }
  bot.on('physicsTick', freeze)
  t.after(() => bot.removeListener('physicsTick', freeze))
  route.publishGoal('destination', { goal })
  await waitFor(() => landing, { label: 'freeze at a valid loaded launch without consuming the jump' })
  assert.equal(wrapper._safeOptionalJump(), true)
  const support = landing.offset(0, -1, 0)
  const originalSupport = bot.blockAt(support).name
  const replace = async (pos, name) => {
    await mc.setBlock(pos, name)
    await waitFor(() => bot.blockAt(pos)?.name === name, { label: `client received ${name}` })
  }
  for (const hazard of ['water', 'lava', 'stone', 'stone_stairs']) {
    await replace(landing, hazard)
    assert.equal(wrapper._safeOptionalJump(), false, `cannot launch toward ${hazard}`)
    await replace(landing, 'air')
    assert.equal(wrapper._safeOptionalJump(), true)
  }
  await mc.fillBlocks(support.offset(0, -5, 0), support, 'air')
  await waitFor(() => bot.blockAt(support)?.name === 'air' && bot.blockAt(support.offset(0, -5, 0))?.name === 'air', { label: 'server opened six-block drop' })
  assert.equal(wrapper._safeOptionalJump(), false, 'no launch when support is missing at the edge')
  await replace(support, originalSupport)
  assert.equal(wrapper._safeOptionalJump(), true)
  const intruder = mc.spawnMob('zombie', landing.offset(0.5, 0, 0.5))
  await waitFor(() => bot.entities[intruder.id], { label: 'hostile received in the launch corridor' })
  assert.equal(wrapper._safeOptionalJump(), false)
  mc.destroyMob(intruder)
  await waitFor(() => !bot.entities[intruder.id], { label: 'hostile despawn packet' })
  const serverBot = mc.getPlayer(bot.username)
  const chunkX = Math.floor(landing.x / 16); const chunkZ = Math.floor(landing.z / 16)
  const column = await mc.serv.overworld.getColumn(chunkX, chunkZ)
  serverBot._client.write('unload_chunk', { chunkX, chunkZ })
  await waitFor(() => bot.blockAt(landing) === null, { label: 'landing column actually unloaded from client' })
  assert.ok(bot.blockAt(bot.entity.position), 'takeoff column remains loaded')
  assert.equal(wrapper._safeOptionalJump(), false)
  await serverBot.sendChunk(chunkX, chunkZ, column)
  await waitFor(() => bot.blockAt(landing), { label: 'landing column reloaded' })
  bot.physicsEnabled = true
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'same route remains traversable after restoring support', timeoutMs: 25_000 })
})

test('real pathfinder turns a right-angle corridor without launching into the bend', async (t) => {
  const sim = await startSimulation()
  t.after(() => sim.stop())
  const { bot, mc, internals, waitFor } = sim
  const route = internals.navigationIntents.register({ id: 'right-angle' })
  const from = bot.entity.position.floored()
  // Open east leg, then south leg; the high inner wall blocks diagonal cuts.
  await mc.fillBlocks(from.offset(-2, 0, 1), from.offset(9, 3, 12), 'stone')
  await mc.fillBlocks(from.offset(11, 0, -2), from.offset(11, 3, 12), 'stone')
  await mc.fillBlocks(from.offset(-2, 0, -2), from.offset(11, 3, -2), 'stone')
  const goal = new goals.GoalBlock(from.x + 10, from.y, from.z + 11)
  let bendSamples = 0
  const inspect = () => {
    const p = bot.entity.position
    const yaw = bot.entity.yaw
    if (p.x > from.x + 7 && p.x < from.x + 9.25 && p.z < from.z + 1 && bot.controlState.forward && -Math.sin(yaw) > 0.8) {
      bendSamples++
      assert.equal(internals.wrapper._jumpPulse, null, 'do not launch toward the end of the east leg')
    }
  }
  bot.on('physicsTick', inspect)
  t.after(() => bot.removeListener('physicsTick', inspect))
  route.publishLocomotion('fast', { mode: 'sprint_jump', goal, expiresAt: Date.now() + 20_000 })
  route.publishGoal('destination', { goal })
  await waitFor(() => goal.isEnd(bot.entity.position.floored()), { label: 'native steering completes the corner' })
  assert.ok(bendSamples > 0, 'observed forward movement toward the actual turn')
})
