/**
 * 04 — Real-server survival reflexes (System1), armor management, and combat.
 *
 * Tests real entity threats on flying-squid:
 *  - Spawning a real zombie + low HP -> System1 reflex flees away & emits reflex_event
 *  - ArmorKeeper automatically wears better carried armor, while manual `equip` holds the chosen slot
 *  - Full HP + iron_sword + `attack {target: "zombie"}` -> AdvancedCombat kills the real zombie on server
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation } = require('./helpers/sim-harness')

describe('04 — real-server survival reflexes, armor & combat', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('flees a real zombie at low HP via System1 reflex and manages armor without mode toggles', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    // 1. Give iron + diamond chestplates; ArmorKeeper should auto-equip the better diamond chestplate
    mc.giveItem('ZincAI', 'iron_chestplate', 1)
    mc.giveItem('ZincAI', 'diamond_chestplate', 1)
    await waitFor(() =>
      bot.inventory.slots.some((i) => i && i.name === 'diamond_chestplate') &&
      bot.inventory.slots.some((i) => i && i.name === 'iron_chestplate'),
    { label: 'armor items in inventory or equipped slots' })
    await waitFor(() => bot.inventory.slots[6]?.name === 'diamond_chestplate', {
      timeoutMs: 8_000,
      label: 'ArmorKeeper auto-equipping diamond_chestplate'
    })

    // 2. Manual `equip` swaps to iron_chestplate and holds torso slot (without needing any `equip.auto` flag)
    llm.enqueueAction({
      reasoning: 'Wear iron chestplate manually.',
      toolCalls: [{ name: 'equip', arguments: { item: 'iron_chestplate', where: 'torso' } }]
    })
    internals.brain.wake('equip iron chestplate', { external: true, urgent: true })
    await waitFor(() => bot.inventory.slots[6]?.name === 'iron_chestplate', {
      timeoutMs: 10_000,
      label: 'manual equip putting on iron_chestplate'
    })
    assert.ok(sim.shared.armorPrefs.held.has('torso'), 'manual equip holds torso slot')

    // 3. Drop health to critical (5 HP) and spawn a real zombie 4 blocks away -> System1 must flee!
    const startPos = bot.entity.position.clone()
    const zombiePos = startPos.floored().offset(4, 0, 0)
    mc.setHealth('ZincAI', 5, 20)
    await waitFor(() => bot.health <= 5, { label: 'client health dropped to 5' })

    const zombie = mc.spawnMob('zombie', zombiePos, { health: 20 })
    await waitFor(() => Object.values(bot.entities).some((e) => e.name === 'zombie'), {
      label: 'client observing real zombie entity'
    })

    // Wait for System1 reflex to detect the zombie and move ZincAI away from it!
    await waitFor(() => {
      const dist = bot.entity.position.distanceTo(zombiePos)
      const events = sim.readTelemetryEvents()
      const fled = events.some((e) => e.type === 'reflex_event')
      return dist >= 6.5 && (fled || internals.system1.fleeing)
    }, { timeoutMs: 15_000, label: 'System1 fleeing real zombie at low HP' })

    mc.destroyMob(zombie)
  })

  it('engages and kills a real zombie on the server via the attack tool', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    mc.setHealth('ZincAI', 20, 20)
    mc.giveItem('ZincAI', 'iron_sword', 1)
    await waitFor(() => bot.health >= 20 && bot.inventory.items().some((i) => i.name === 'iron_sword'), {
      label: 'full health and iron sword ready'
    })

    const origin = bot.entity.position.floored()
    // Spawn zombie at 14m: outside ThreatSense's 12m reflex flee ring, inside combat engage range.
    const zombie = mc.spawnMob('zombie', origin.offset(14, 0, 0), { health: 8 })
    await waitFor(() => Object.values(bot.entities).some((e) => e.id === zombie.id), {
      label: 'real zombie visible to client'
    })

    // LLM calls `attack { target: "zombie" }`
    llm.enqueueAction({
      reasoning: 'Full HP with an iron sword; engage the zombie directly.',
      toolCalls: [{ name: 'attack', arguments: { target: 'zombie', count: 1 } }]
    })
    internals.brain.wake('zombie right beside me', { external: true, urgent: true })

    // Verify zombie actually takes damage and dies on the real flying-squid server!
    await waitFor(() => !mc.serv.entities[zombie.id] || zombie.health <= 0, {
      timeoutMs: 15_000,
      label: 'real zombie killed on flying-squid server'
    })

    const events = sim.readTelemetryEvents()
    assert.ok(events.some((e) => e.type === 'combat_event'), 'combat_event recorded in telemetry')
  })
})
