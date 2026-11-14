/**
 * 05 — Real-server redstone inspection, abstract logic testing, circuit
 * projects, and redstone engineering against live flying-squid chunks.
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation } = require('./helpers/sim-harness')

describe('05 — real-server redstone inspection, logic & engineering', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('scans a real redstone circuit, runs logic_test & circuit_project, and designs/places redstone', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor } = sim

    const origin = bot.entity.position.floored()
    // Build a real powered redstone line on the server at y = origin.y:
    // lever (powered=true) -> redstone_wire (power=15) -> repeater (delay=2, powered=true) -> redstone_lamp (lit=true)
    const leverPos = origin.offset(2, 0, 0)
    const wirePos = origin.offset(3, 0, 0)
    const repPos = origin.offset(4, 0, 0)
    const lampPos = origin.offset(5, 0, 0)

    await mc.setBlock(leverPos, 'lever', { face: 'floor', facing: 'east', powered: true })
    await mc.setBlock(wirePos, 'redstone_wire', { power: 15, east: 'side', west: 'side' })
    await mc.setBlock(repPos, 'repeater', { facing: 'west', delay: 2, powered: true })
    await mc.setBlock(lampPos, 'redstone_lamp', { lit: true })

    await waitFor(() =>
      bot.blockAt(leverPos)?.name === 'lever' &&
      bot.blockAt(wirePos)?.name === 'redstone_wire' &&
      bot.blockAt(repPos)?.name === 'repeater' &&
      bot.blockAt(lampPos)?.name === 'redstone_lamp',
    { label: 'redstone bench visible to client' })

    // 1. Scan real redstone circuit + analyze with redstone_engineer + run logic_test + save project
    llm.enqueueAction({
      reasoning: 'Scan the redstone line, analyze it, and verify a 2-input XOR logic graph.',
      toolCalls: [
        { name: 'redstone_scan', arguments: { x: wirePos.x, y: wirePos.y, z: wirePos.z, radius: 2 } },
        { name: 'redstone_engineer', arguments: { operation: 'analyze', x: wirePos.x, y: wirePos.y, z: wirePos.z, radius: 3 } },
        { name: 'redstone_engineer', arguments: { operation: 'design', design: 'not' } },
        {
          name: 'logic_test',
          arguments: {
            project: 'xor_demo',
            inputs: ['A', 'B'],
            gates: [{ id: 'Q', op: 'XOR', inputs: ['A', 'B'] }],
            outputs: ['Q'],
            tests: [
              { in_bits: '00', out_bits: '0' },
              { in_bits: '01', out_bits: '1' },
              { in_bits: '10', out_bits: '1' },
              { in_bits: '11', out_bits: '0' }
            ]
          }
        },
        { name: 'circuit_project', arguments: { operation: 'show', name: 'xor_demo' } }
      ]
    })
    internals.brain.wake('inspect redstone circuit and test xor logic', { external: true, urgent: true })

    await waitFor(() => {
      const execs = sim.readTelemetryEvents().filter((e) => e.type === 'tool_exec')
      return execs.some((e) => e.data.tool === 'circuit_project' && e.data.ok)
    }, { timeoutMs: 15_000, label: 'redstone inspection and logic_test tool chain' })

    const execs = sim.readTelemetryEvents().filter((e) => e.type === 'tool_exec')
    const scanEv = execs.find((e) => e.data.tool === 'redstone_scan')
    assert.ok(scanEv?.data?.ok, 'redstone_scan succeeded')
    assert.match(scanEv.data.msg, /lever|repeater|redstone_wire|redstone_lamp/i)

    const analyzeEv = execs.find((e) => e.data.tool === 'redstone_engineer' && /analyze|components|circuit|lever|lamp|wire/i.test(e.data.msg))
    assert.ok(analyzeEv?.data?.ok, 'redstone_engineer analyze succeeded')

    const logicEv = execs.find((e) => e.data.tool === 'logic_test')
    assert.ok(logicEv?.data?.ok, 'logic_test passed 4/4 XOR vectors')
    assert.match(logicEv.data.msg, /xor_demo/i)

    // 2. Follow up with `redstone_component` using the snapshot id returned by `redstone_scan`
    const snapIdMatch = /\b(rs\d+)\b/i.exec(scanEv.data.msg)
    assert.ok(snapIdMatch, `expected snapshot id (rsN) in redstone_scan output, got: ${scanEv.data.msg}`)
    await waitFor(() => !internals.brain.busyAction, { label: 'brain idle before component inspect' })
    llm.enqueueAction({
      reasoning: 'Inspect the repeater block inside the captured redstone snapshot.',
      toolCalls: [{
        name: 'redstone_component',
        arguments: { snapshot: snapIdMatch[1], x: repPos.x, y: repPos.y, z: repPos.z }
      }]
    })
    internals.brain.wake('inspect repeater in snapshot', { external: true, urgent: true })

    await waitFor(() =>
      sim.readTelemetryEvents().some((e) => e.type === 'tool_exec' && e.data.tool === 'redstone_component' && e.data.ok),
    { timeoutMs: 10_000, label: 'redstone_component inspect' })

    // 3. Place a real redstone NOT gate using `redstone_engineer { operation: "place", design: "not" }`
    mc.giveItem('ZincAI', 'stone', 16)
    mc.giveItem('ZincAI', 'redstone_torch', 8)
    mc.giveItem('ZincAI', 'redstone', 16)
    mc.giveItem('ZincAI', 'lever', 4)
    mc.giveItem('ZincAI', 'redstone_lamp', 4)
    await waitFor(() => bot.inventory.items().some((i) => i.name === 'redstone_torch'), {
      label: 'redstone supplies in inventory'
    })

    const placeOrigin = origin.offset(0, 0, 4)
    await waitFor(() => !internals.skills.current() && !internals.brain.busyAction, { label: 'idle before redstone place' })
    llm.enqueueAction({
      reasoning: 'Place a NOT gate redstone circuit at placeOrigin.',
      toolCalls: [{
        name: 'redstone_engineer',
        arguments: { operation: 'place', design: 'not', x: placeOrigin.x, y: placeOrigin.y, z: placeOrigin.z }
      }]
    })
    internals.brain.wake('place NOT gate', { external: true, urgent: true })

    await waitFor(() => {
      const list = sim.readTelemetryEvents().filter((e) => e.type === 'tool_exec' && e.data.tool === 'redstone_engineer')
      return list.length >= 3
    }, { timeoutMs: 20_000, label: 'redstone_engineer place completed' })

    // Verify at least one real redstone block was placed around placeOrigin on the server!
    let foundPlaced = false
    for (let dx = -2; dx <= 5; dx++) {
      for (let dy = 0; dy <= 2; dy++) {
        for (let dz = -2; dz <= 5; dz++) {
          const b = await mc.getBlock(placeOrigin.offset(dx, dy, dz))
          if (b && b.name !== 'air' && b.name !== 'grass_block' && b.name !== 'dirt') {
            foundPlaced = true
          }
        }
      }
    }
    assert.ok(foundPlaced, 'redstone_engineer placed real blocks on the flying-squid server')
  })
})
