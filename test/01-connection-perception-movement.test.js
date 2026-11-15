/**
 * 01 — Real-server connection, perception, inspection tools, and pathfinder movement.
 *
 * Connects ZincAI to a real offline flying-squid 1.21.4 server and drives
 * real end-to-end tool calls via a local OpenAI-compatible HTTP endpoint:
 *  - Spawn & world state observation in action prompts
 *  - Clean 39-tool surface (no removed dig_policy or equip.auto toggles)
 *  - Pathfinding around a real stone barrier via LLM-issued `go_to`
 *  - Ground-truth `find`, `inspect_block`, `inspect_region`, `remember_here`, `screenshot`
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation } = require('./helpers/sim-harness')

describe('01 — real-server connection, perception & movement', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('spawns, observes real world/inventory/places, exposes clean tools, and navigates around an obstacle', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor, sleep } = sim

    // Seed real world features around spawn: chest, furnace, wall obstacle, oak log
    const origin = bot.entity.position.floored()
    const chestPos = origin.offset(3, 0, 0)
    const furnacePos = origin.offset(3, 0, 1)
    const goalPos = origin.offset(8, 0, 0)

    await mc.setBlock(chestPos, 'chest')
    await mc.setBlock(furnacePos, 'furnace')
    // Place a 3-wide, 2-high stone wall directly between spawn and goalPos (at x+5)
    await mc.fillBlocks(origin.offset(5, 0, -1), origin.offset(5, 1, 1), 'stone')
    mc.giveItem('ZincAI', 'cobblestone', 24)
    mc.giveItem('ZincAI', 'iron_pickaxe', 1)

    await waitFor(() => bot.blockAt(chestPos)?.name === 'chest' && bot.blockAt(origin.offset(5, 0, 0))?.name === 'stone', {
      label: 'client receiving seeded blocks'
    })
    await waitFor(() => bot.inventory.items().some((i) => i.name === 'iron_pickaxe'), {
      label: 'client receiving inventory items'
    })

    // 1. Verify action prompt reflects real server state (coords, inventory, nearby chest/furnace)
    const snap = internals.buildActionPrompt(['simulation inspection check'])
    assert.match(snap.text, /cobblestone x24|cobblestone/i)
    assert.match(snap.text, /iron_pickaxe/i)
    assert.match(snap.text, /chest1/i)
    assert.match(snap.text, /furnace1/i)
    // Removed heuristics & policy lines must not appear
    assert.doesNotMatch(snap.text, /STORAGE ROOM/i)
    assert.doesNotMatch(snap.text, /digging:/i)

    // 2. Verify initial LLM request has the clean tool schema (no dig_policy, no equip.auto)
    await waitFor(() => llm.actionRequests().length >= 1, { label: 'initial LLM action request' })
    const firstReq = llm.actionRequests()[0]
    assert.ok(!firstReq.toolNames.includes('dig_policy'), 'dig_policy tool must be removed')
    assert.ok(firstReq.toolNames.includes('go_to'))
    assert.ok(firstReq.toolNames.includes('gather'))
    assert.ok(firstReq.toolNames.includes('build_shape'))
    assert.ok(firstReq.toolNames.includes('redstone_engineer'))
    assert.ok(firstReq.toolNames.includes('screenshot'), 'visual tool is exposed to the action model')
    assert.ok(firstReq.toolNames.includes('memory'), 'agent-controlled memory tool is exposed')
    const goToSchema = firstReq.body.tools.find((t) => t.function.name === 'go_to')
    assert.match(goToSchema.function.description, /x and z alone/i)
    const equipSchema = firstReq.body.tools.find((t) => t.function.name === 'equip')
    assert.ok(equipSchema, 'equip tool exists')
    assert.equal(equipSchema.function.parameters.properties.auto, undefined, 'equip.auto toggle must be removed')

    // 3. Queue a real LLM turn: inspect_block -> inspect_region -> find -> remember_here -> screenshot -> go_to around the stone wall!
    llm.enqueueAction({
      reasoning: 'Let me inspect the chest, remember spawn, take a screenshot, and walk around the wall.',
      toolCalls: [
        { name: 'inspect_block', arguments: { x: chestPos.x, y: chestPos.y, z: chestPos.z } },
        { name: 'inspect_region', arguments: { x: origin.x + 4, y: origin.y, z: origin.z, radius: 2 } },
        { name: 'find', arguments: { what: 'chest' } },
        { name: 'remember_here', arguments: { name: 'spawn_camp' } },
        { name: 'screenshot', arguments: { view: 'look' } },
        { name: 'go_to', arguments: { x: goalPos.x, z: goalPos.z } }
      ]
    })
    internals.brain.wake('inspect camp and walk around stone barrier', { external: true, urgent: true })

    // Wait for real Mineflayer pathfinder to navigate around the 3-wide stone wall to goalPos!
    await waitFor(() => {
      const p = bot.entity.position
      return Math.hypot(p.x - goalPos.x, p.z - goalPos.z) <= 2.5
    }, { timeoutMs: 20_000, label: 'bot walking around stone wall to target coordinates' })

    // Verify wall was navigated AROUND (intact) and named place was saved
    assert.equal((await mc.getBlock(origin.offset(5, 0, 0))).name, 'stone')
    const savedPlace = sim.shared.places.named.get('spawn_camp')
    assert.ok(savedPlace, 'remember_here saved spawn_camp')

    // Verify tool results recorded ground truth in NDJSON telemetry
    const events = sim.readTelemetryEvents()
    const toolExecs = events.filter((e) => e.type === 'tool_exec')
    assert.ok(toolExecs.some((e) => e.data.tool === 'inspect_block' && e.data.ok && /chest/i.test(e.data.msg)), 'inspect_block saw real chest')
    assert.ok(toolExecs.some((e) => e.data.tool === 'inspect_region' && e.data.ok && /Region page/i.test(e.data.msg)), 'inspect_region read real chunks')
    assert.ok(toolExecs.some((e) => e.data.tool === 'find' && e.data.ok && /chest/i.test(e.data.msg)), 'find located real chest')
    assert.ok(toolExecs.some((e) => e.data.tool === 'screenshot' && e.data.ok), 'screenshot rendered from live chunks')
    await sleep(100)
  })
})
