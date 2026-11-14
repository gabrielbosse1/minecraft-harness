/**
 * 06 — Real-server durable goals, death + auto-respawn recovery, and Host
 * operator console commands (status, pause, resume, config, leave, join).
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { startSimulation } = require('./helpers/sim-harness')

describe('06 — real-server goals, death recovery & operator console', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('persists goals across real server death & auto-respawn and reconciles cleanly', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, dataDir, waitFor } = sim

    // 1. Create a persistent multi-step goal via the `goal` tool
    llm.enqueueAction({
      reasoning: 'Record a persistent goal with concrete steps.',
      toolCalls: [{
        name: 'goal',
        arguments: {
          operation: 'add',
          description: 'Build a watchtower by spawn',
          origin: 'self_generated',
          steps: ['collect oak logs', 'build foundation', 'add lookout deck'],
          next: 'collect oak logs'
        }
      }]
    })
    internals.brain.wake('plan watchtower goal', { external: true, urgent: true })

    await waitFor(() => internals.goals.openGoals().some((g) => /watchtower/i.test(g.description || g.label || '')), {
      timeoutMs: 10_000,
      label: 'watchtower goal created'
    })
    const watchtower = internals.goals.openGoals().find((g) => /watchtower/i.test(g.description || g.label || ''))
    assert.ok(fs.existsSync(path.join(dataDir, 'goals.json')), 'goals.json persisted in dataDir')

    // 2. Kill the real player on flying-squid -> must auto-respawn automatically (no autoRespawn toggle!)
    let died = false
    let respawned = false
    bot.once('death', () => { died = true })
    bot.once('spawn', () => { respawned = true })

    mc.killPlayer('ZincAI')

    await waitFor(() => died, { timeoutMs: 10_000, label: 'client receiving real death packet' })
    await waitFor(() => respawned && bot.health > 0, { timeoutMs: 15_000, label: 'automatic respawn on flying-squid' })

    // Verify DeathRecovery recorded the death AND the open watchtower goal survived respawn!
    assert.ok(internals.deathRecovery.deaths >= 1, 'DeathRecovery recorded real death')
    assert.ok(internals.goals.get(watchtower.id), 'watchtower goal survived death and respawn')

    // 3. Complete the goal via `goal complete`
    await waitFor(() => !internals.brain.busyAction, { label: 'brain idle after respawn' })
    llm.enqueueAction({
      reasoning: 'Mark the watchtower goal complete.',
      toolCalls: [{ name: 'goal', arguments: { operation: 'complete', id: watchtower.id, note: 'done' } }]
    })
    internals.brain.wake('finish watchtower goal', { external: true, urgent: true })

    await waitFor(() => internals.goals.get(watchtower.id)?.status === 'completed', {
      timeoutMs: 10_000,
      label: 'watchtower goal completed'
    })
  })

  it('handles real operator console commands: status, config, pause/resume boundary, leave & join', async () => {
    sim = await startSimulation({ autoStartHost: true })
    const { mc, host, llm, waitFor, sleep } = sim

    // 1. `status` and `config show` reflect clean minimal schema (no removed behavioral toggles)
    const statusOut = (await host.command('status')).reply
    assert.match(statusOut, /CONNECTED/i)

    const cfgOut = (await host.command('config show')).reply
    assert.match(cfgOut, /limits\.maxPhysicalActionsPerMinute/)
    assert.doesNotMatch(cfgOut, /actions\.allowDig|boundary\.enabled|communication\.publicChat|death\.autoRespawn|connection\.autoReconnect/)

    const setOut = (await host.command('config set limits.maxPhysicalActionsPerMinute 80')).reply
    assert.match(setOut, /80/)
    assert.equal(host.config.get('limits.maxPhysicalActionsPerMinute'), 80)

    // 2. `pause` blocks physical actions at the boundary without losing goals
    const pauseOut = (await host.command('pause')).reply
    assert.match(pauseOut, /paused/i)
    assert.equal(host.paused, true)

    const startPos = sim.bot.entity.position.clone()
    const farTarget = startPos.floored().offset(6, 0, 0)
    llm.enqueueAction({
      reasoning: 'Try walking while paused.',
      toolCalls: [{ name: 'go_to', arguments: { x: farTarget.x, y: farTarget.y, z: farTarget.z } }]
    })
    sim.internals.brain.wake('attempt move while paused', { external: true, urgent: true })
    await sleep(600)
    // Bot must still be at startPos because PhysicalBoundary refused physical movement while paused!
    assert.ok(sim.bot.entity.position.distanceTo(startPos) < 1.5, 'paused bot must not walk')

    // 3. `resume` unpauses and allows real walking again
    const resumeOut = (await host.command('resume')).reply
    assert.match(resumeOut, /resumed/i)
    assert.equal(host.paused, false)

    llm.enqueueAction({
      reasoning: 'Now resumed — walk to target.',
      toolCalls: [{ name: 'go_to', arguments: { x: farTarget.x, y: farTarget.y, z: farTarget.z } }]
    })
    sim.internals.brain.wake('walk after resume', { external: true, urgent: true })
    await waitFor(() => Math.hypot(sim.bot.entity.position.x - farTarget.x, sim.bot.entity.position.z - farTarget.z) <= 2.5, {
      timeoutMs: 15_000,
      label: 'bot walking after operator resume'
    })

    // 4. `leave` disconnects cleanly from flying-squid, and `join` reconnects cleanly!
    const leaveOut = (await host.command('leave')).reply
    assert.match(leaveOut, /left|disconnect/i)
    await waitFor(() => !mc.getPlayer('ZincAI'), { timeoutMs: 8_000, label: 'ZincAI disconnected from server' })

    const joinOut = (await host.command('join')).reply
    assert.match(joinOut, /join|connect/i)
    await waitFor(() => host.session?.isSpawned?.() && mc.getPlayer('ZincAI'), {
      timeoutMs: 15_000,
      label: 'ZincAI reconnected and spawned back into real server'
    })
  })
})
