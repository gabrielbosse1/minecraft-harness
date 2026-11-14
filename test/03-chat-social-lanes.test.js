/**
 * 03 — Real-server multiplayer chat lane, `reply.do` instant action, `say`,
 * vanilla slash-command guard, and independent social/memory tools.
 *
 * Connects a real second Mineflayer player (`Alice`) to the same flying-squid
 * server and tests full round-trip TCP chat and concurrent chat/action lanes.
 */
'use strict'

const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { startSimulation } = require('./helpers/sim-harness')

describe('03 — real-server multiplayer chat, lanes & social tools', () => {
  let sim = null
  afterEach(async () => {
    if (sim) { await sim.stop(); sim = null }
  })

  it('receives real player chat from Alice, replies over TCP, runs reply.do immediately, and enforces vanilla guard', async () => {
    sim = await startSimulation()
    const { mc, llm, bot, internals, waitFor, sleep } = sim

    // Connect a real second Mineflayer player ("Alice") to the same flying-squid server
    const alice = await mc.connectPlayer('Alice')
    const aliceHeard = []
    alice.on('messagestr', (msg) => aliceHeard.push(msg))

    // Have Alice walk ~6 blocks away using real Mineflayer movement so `do: "come"` walks ZincAI over
    const startPos = bot.entity.position.clone()
    await alice.look(0, 0, true)
    alice.setControlState('forward', true)
    await waitFor(() => alice.entity.position.distanceTo(startPos) >= 5.5, {
      timeoutMs: 8_000,
      label: 'Alice walking away from ZincAI'
    })
    alice.setControlState('forward', false)
    const aliceSpot = alice.entity.position.clone()
    await waitFor(() => {
      const a = bot.players?.Alice?.entity?.position
      return a && a.distanceTo(startPos) >= 4.0
    }, { timeoutMs: 8_000, label: 'ZincAI observing Alice at offset spot' })

    // Queue scripted chat-lane reply with `do: "come"` and `remember`
    llm.enqueueChat({
      reasoning: 'Alice greeted me and asked me to walk over.',
      reply: {
        text: 'Heading over to you now Alice!',
        to: 'Alice',
        do: 'come',
        remember: 'Alice is friendly and lives east of spawn'
      }
    })

    // Alice sends real Minecraft chat over TCP
    alice.chat('Hey ZincAI, can you come over here?')

    // 1. Alice receives ZincAI's actual spoken line over TCP
    await waitFor(() => aliceHeard.some((m) => /Heading over to you now Alice!/i.test(m)), {
      timeoutMs: 12_000,
      label: 'Alice receiving ZincAI chat reply over TCP'
    })

    // 2. `reply.do = "come"` immediately walks ZincAI toward Alice!
    await waitFor(() => {
      const p = bot.entity.position
      return Math.hypot(p.x - aliceSpot.x, p.z - aliceSpot.z) <= 3.0
    }, { timeoutMs: 15_000, label: 'ZincAI walking to Alice via reply.do=come' })

    // 3. `reply.remember` persisted fact into long-term memory
    const recalled = sim.shared.memory.longTerm.retrieve({ query: 'Alice friendly', k: 5 })
    assert.ok(recalled.entries.some((e) => /Alice/i.test(e.text)), 'reply.remember stored Alice fact')

    // 4. Action lane: `say`, `social update`, `note`, and `vanilla_guard` blocking slash commands!
    await waitFor(() => !internals.skills.current() && !internals.brain.busyAction, {
      timeoutMs: 10_000,
      label: 'body settled after come'
    })
    llm.enqueueAction({
      reasoning: 'Update my social view of Alice, save a note, and speak in public chat.',
      toolCalls: [
        {
          name: 'social',
          arguments: {
            operation: 'update',
            player: 'Alice',
            stance: 'collaborator',
            trust: 65,
            confidence: 50,
            willingness: 'cooperate',
            opinion: 'Helpful teammate east of spawn.',
            evidence: 'Greeted warmly and invited me over.'
          }
        },
        { name: 'note', arguments: { text: 'Alice camp is east of spawn', interest: 'team_building' } },
        { name: 'say', arguments: { text: 'Made it over here!' } }
      ]
    })
    internals.brain.wake('log social update and greet Alice', { external: true, urgent: true })

    await waitFor(() => aliceHeard.some((m) => /Made it over here!/i.test(m)), {
      timeoutMs: 12_000,
      label: 'Alice receiving ZincAI public say over TCP'
    })

    // Verify social stance persisted in ContinuityStore
    const rel = sim.shared.continuity.getRelationship('Alice')
    assert.equal(rel?.stance, 'collaborator')
    assert.equal(rel?.trust, 65)

    // Verify vanilla_guard blocks raw slash commands from ever leaving the bot
    let blockedLine = null
    bot.once('vanilla_command_blocked', (line) => { blockedLine = line })
    bot.chat('/op ZincAI')
    assert.equal(blockedLine, '/op ZincAI', 'vanilla_guard must block /op commands')
    await sleep(100)
  })
})
