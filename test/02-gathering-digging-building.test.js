/**
 * 02 — Real-server gathering (any vanilla block), digging, placing & building.
 *
 * Tests real world mutation end-to-end against flying-squid:
 *  - Gathering oak_log AND a non-whitelist vanilla block (amethyst_block)
 *  - Digging through a real cobblestone barrier to reach a destination
 *  - Placing individual blocks (`place`) and multi-block structures (`build_shape`)
 *  - Verifying every block change directly on the Minecraft server's world chunks
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation } = require('./helpers/sim-harness')

describe('02 — real-server gathering, digging, placing & building', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('gathers both oak_log and non-whitelist vanilla amethyst_block on the real server', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    const origin = bot.entity.position.floored()
    const log1 = origin.offset(2, 0, 0)
    const log2 = origin.offset(2, 0, 1)
    const amethyst = origin.offset(-2, 0, 0)

    await mc.setBlock(log1, 'oak_log')
    await mc.setBlock(log2, 'oak_log')
    await mc.setBlock(amethyst, 'amethyst_block')
    mc.giveItem('ZincAI', 'diamond_axe', 1)
    mc.giveItem('ZincAI', 'diamond_pickaxe', 1)

    await waitFor(() =>
      bot.blockAt(log1)?.name === 'oak_log' &&
      bot.blockAt(amethyst)?.name === 'amethyst_block' &&
      bot.inventory.items().some((i) => i.name === 'diamond_pickaxe'),
    { label: 'seeded blocks and tools visible to bot' })

    // Gather 2 oak_logs via LLM tool call
    llm.enqueueAction({
      reasoning: 'Gather two oak logs nearby.',
      toolCalls: [{ name: 'gather', arguments: { item: 'oak_log', count: 2 } }]
    })
    internals.brain.wake('need oak logs', { external: true, urgent: true })

    await waitFor(async () =>
      (await mc.getBlock(log1)).name === 'air' &&
      (await mc.getBlock(log2)).name === 'air',
    { timeoutMs: 20_000, label: 'both oak_logs broken on server' })

    // Wait for first gather skill & wake turn to finish before starting amethyst gather
    await waitFor(() => !internals.skills.current() && !internals.brain.busyAction, {
      timeoutMs: 10_000,
      label: 'gather oak_log settled'
    })
    await sim.sleep(150)

    // Now gather a non-whitelist vanilla block: amethyst_block!
    llm.enqueueAction({
      reasoning: 'Mine the amethyst_block nearby — gather supports any vanilla block.',
      toolCalls: [{ name: 'gather', arguments: { item: 'amethyst_block', count: 1 } }]
    })
    internals.brain.wake('mine amethyst block', { external: true, urgent: true })

    await waitFor(async () => (await mc.getBlock(amethyst)).name === 'air', {
      timeoutMs: 20_000,
      label: 'amethyst_block broken on server'
    })
  })

  it('places blocks and builds a real multi-block shape on the server', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    const origin = bot.entity.position.floored()
    const singlePos = origin.offset(2, 0, 0)
    const wallOrigin = origin.offset(0, 0, 3)

    mc.giveItem('ZincAI', 'cobblestone', 48)
    mc.giveItem('ZincAI', 'oak_planks', 32)
    await waitFor(() => bot.inventory.items().some((i) => i.name === 'cobblestone' && i.count >= 48), {
      label: 'building materials in inventory'
    })

    // 1. Place a single oak_planks block at singlePos using `build` inline grid
    llm.enqueueAction({
      reasoning: 'Place a single oak planks marker block.',
      toolCalls: [{
        name: 'build',
        arguments: {
          grid: [['P']],
          palette: { P: 'oak_planks' },
          at: [singlePos.x, singlePos.y, singlePos.z]
        }
      }]
    })
    internals.brain.wake('place oak plank', { external: true, urgent: true })

    await waitFor(async () => (await mc.getBlock(singlePos)).name === 'oak_planks', {
      timeoutMs: 15_000,
      label: 'single oak_planks placed on server'
    })

    // 2. Build a real 3x2 cobblestone wall via build_shape!
    await waitFor(() => !internals.skills.current() && !internals.brain.busyAction, {
      timeoutMs: 10_000,
      label: 'body idle before build_shape'
    })
    llm.enqueueAction({
      reasoning: 'Build a 3-wide, 2-high cobblestone wall at wallOrigin.',
      toolCalls: [{
        name: 'build_shape',
        arguments: {
          shape: 'wall',
          block: 'cobblestone',
          at: [wallOrigin.x, wallOrigin.y, wallOrigin.z],
          params: { l: 3, h: 2, axis: 'x' }
        }
      }]
    })
    internals.brain.wake('build cobblestone wall', { external: true, urgent: true })

    await waitFor(async () => {
      let placed = 0
      for (let dx = 0; dx < 3; dx++) {
        for (let dy = 0; dy < 2; dy++) {
          const b = await mc.getBlock(wallOrigin.offset(dx, dy, 0))
          if (b.name === 'cobblestone') placed++
        }
      }
      return placed === 6
    }, { timeoutMs: 25_000, label: 'all 6 cobblestone wall blocks placed on server' })

    // Verify all 6 blocks exist on the server
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const b = await mc.getBlock(wallOrigin.offset(dx, dy, 0))
        assert.equal(b.name, 'cobblestone', `expected cobblestone at +${dx},+${dy}`)
      }
    }
  })

  it('refuses a large house build under natural cave rock before placing any blocks', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim
    const origin = bot.entity.position.floored()
    const buildAt = [origin.x + 8, origin.y, origin.z + 8]
    const roof = new (require('vec3'))(buildAt[0] + 2, buildAt[1] + 5, buildAt[2] + 1)
    await mc.setBlock(roof, 'stone')
    await waitFor(() => bot.blockAt(roof)?.name === 'stone', { label: 'natural stone ceiling loaded' })
    llm.enqueueAction({ toolCalls: [{ name: 'build', arguments: { blueprint: 'small_house', at: buildAt } }] })
    internals.brain.wake('test house site', { external: true, urgent: true })
    await waitFor(() => internals.results.some((r) => r.label === 'build' && !r.ok && /cave\/underground/.test(r.msg)), {
      timeoutMs: 10_000, label: 'house site refused as cave'
    })
    assert.equal((await mc.getBlock(new (require('vec3'))(...buildAt))).name, 'air', 'refusal must happen before placement')
  })

  it('refuses a blind vertical shaft dig and recommends a walkable route', async () => {
    sim = await startSimulation()
    const { llm, bot, internals, waitFor } = sim
    const pos = bot.entity.position.floored()
    llm.enqueueAction({ toolCalls: [{ name: 'dig', arguments: { x: pos.x, y: pos.y + 6, z: pos.z } }] })
    internals.brain.wake('test avoid blind shaft', { external: true, urgent: true })
    await waitFor(() => internals.results.some((r) => r.label === 'dig' && !r.ok && /vertical shaft request/.test(r.msg)), {
      timeoutMs: 10_000, label: 'blind upward dig refused'
    })
    assert.equal(bot.entity.position.floored().x, pos.x)
    assert.equal(bot.entity.position.floored().z, pos.z)
  })

  it('digs through a dirt barrier to reach coordinates on the other side', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    const origin = bot.entity.position.floored()
    // Build a 1x2x5 sealed dirt wall right in front of the bot along x+2 (z from -2 to +2, y 0..2)
    // and box the sides so digging through dirt is the direct route to x+4
    await mc.fillBlocks(origin.offset(2, 0, -2), origin.offset(2, 2, 2), 'dirt')
    await mc.fillBlocks(origin.offset(-1, 0, -2), origin.offset(5, 2, -2), 'stone')
    await mc.fillBlocks(origin.offset(-1, 0, 2), origin.offset(5, 2, 2), 'stone')
    mc.giveItem('ZincAI', 'diamond_shovel', 1)

    await waitFor(() => bot.blockAt(origin.offset(2, 0, 0))?.name === 'dirt' && bot.inventory.items().some((i) => i.name === 'diamond_shovel'), {
      label: 'dirt barrier and shovel visible'
    })

    const target = origin.offset(4, 0, 0)
    llm.enqueueAction({
      reasoning: 'Dig through the dirt barrier to reach the far side.',
      toolCalls: [{ name: 'dig', arguments: { x: target.x, y: target.y, z: target.z, materials: ['dirt'] } }]
    })
    internals.brain.wake('dig through dirt barrier', { external: true, urgent: true })

    await waitFor(async () => {
      const p = bot.entity.position
      const breached = (await mc.getBlock(origin.offset(2, 0, 0))).name === 'air' ||
        (await mc.getBlock(origin.offset(2, 0, -1))).name === 'air' ||
        (await mc.getBlock(origin.offset(2, 0, 1))).name === 'air'
      return breached && Math.hypot(p.x - target.x, p.z - target.z) <= 2.5
    }, { timeoutMs: 25_000, label: 'bot digging through dirt barrier to target' })
  })
})
