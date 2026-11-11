/**
 * Whole-harness rig for harness A (src/, "Zinc"): the real ZincAgent with only
 * two things replaced — mineflayer.createBot (a simulated bot in a synthetic
 * world) and global fetch (a scripted model that reads the prompt). Everything
 * in between is the shipped code: delta buffer, inference loop, dispatcher,
 * shared body (arbiter, threat sense, reflexes, combat).
 */
'use strict'

const { simulatedBot, sleep } = require('./session')

/**
 * @param {{ model?: (prompt: string, n: number) => (object|string|null),
 *           bot?: object, cfg?: (cfg: object) => void }} script
 *   model: the policy. It gets the user message exactly as the model would and
 *   returns an action object (or raw text, to test malformed answers).
 */
function startZincSession ({ model = () => ({ a: 'idle' }), bot = simulatedBot(), cfg: tweak = null } = {}) {
  const dress = (b) => {
    // Same simulated bot as the ZincAI rig, under harness A's name. Players
    // the test already added stay in the tab list.
    b.username = 'Zinc'
    delete b.players.ZincAI
    b.players.Zinc = { entity: b.entity, username: 'Zinc' }
    return b
  }
  let current = dress(bot)
  process.env.API_KEY = process.env.API_KEY || 'rc-test-key'

  // 1. mineflayer.createBot → the simulated bot (again on every reconnect).
  const mineflayer = require('mineflayer')
  const realCreateBot = mineflayer.createBot
  let created = 0
  mineflayer.createBot = () => { created += 1; return current }

  // 2. fetch → scripted model.
  const prompts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const user = body.messages[body.messages.length - 1].content
    prompts.push(user)
    const out = await model(user, prompts.length)
    const content = typeof out === 'string' ? out : JSON.stringify(out || { a: 'idle' })
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 60, completion_tokens: 8 } }), text: async () => '' }
  }

  const { loadConfig } = require('../../src/config')
  const { ZincAgent } = require('../../src/agent')
  const cfg = loadConfig()
  // Test pace.
  Object.assign(cfg, { inferenceMinIntervalMs: 30, inferenceIdleIntervalMs: 400, inferenceTickMs: 20, chatCooldownMs: 10, reflexTickMs: 50, moveTimeoutMs: 8000 })
  cfg.reconnect = { enabled: true, baseDelayMs: 30, maxDelayMs: 60, maxAttempts: 3 }
  if (tweak) tweak(cfg)

  const agent = new ZincAgent(cfg)
  // The real shutdown ends the process; record it instead.
  const exits = []
  agent.shutdown = async (reason, code) => {
    if (agent.shuttingDown) return
    agent.shuttingDown = true
    exits.push({ reason, code })
    clearInterval(agent._ticker)
    agent._stopBody()
  }
  agent.start()

  return {
    agent,
    get bot () { return current },
    prompts,
    exits,
    created: () => created,
    /** The bot the NEXT createBot() call returns (a reconnect). */
    nextBot (b) { current = dress(b); return current },
    spawn () { current.emit('spawn') },
    say (line) { current.emit('messagestr', line) },
    async until (fn, ms = 4000) {
      const end = Date.now() + ms
      while (Date.now() < end) { if (fn()) return true; await sleep(25) }
      return false
    },
    stop () {
      agent.shuttingDown = true
      clearInterval(agent._ticker)
      try { agent._stopBody() } catch { /* noop */ }
      try { current.stopSim?.() } catch { /* noop */ }
      try { bot.stopSim?.() } catch { /* noop */ }
      globalThis.fetch = realFetch
      mineflayer.createBot = realCreateBot
    }
  }
}

module.exports = { startZincSession }
