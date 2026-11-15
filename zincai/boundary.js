/**
 * boundary.js — lifecycle and anti-flood execution guard for physical actions.
 *
 * Ensures physical Minecraft actions only run while connected, alive, and not
 * paused by console `pause`, and enforces the sliding-window anti-flood ceiling
 * (`limits.maxPhysicalActionsPerMinute`). Does not restrict gameplay tools,
 * block types, or world regions.
 */
'use strict'

const { EventEmitter } = require('events')
const { asLogger } = require('./runtime_config')

const ACTION_CAPABILITIES = Object.freeze({
  go_to: ['move'],
  follow: ['move'],
  pace: ['move'],
  step_back: ['move'],
  stop_moving: [],
  dig: ['move', 'dig'],
  gather: ['move', 'dig'],
  place: ['move', 'place'],
  build: ['move', 'place'],
  build_shape: ['move', 'place'],
  shelter: ['move', 'place'],
  attack: ['move', 'attack'],
  take: ['move', 'container'],
  put: ['move', 'container'],
  look_in: ['move', 'container'],
  smelt: ['move', 'container'],
  use_block: ['move', 'use'],
  light_up: ['move', 'place', 'use'],
  sleep: ['move', 'use'],
  equip: ['equip'],
  eat: ['eat'],
  give: ['move', 'toss'],
  craft: ['move', 'craft'],
  run_script: ['script'],
  screenshot: [],
  find: [],
  inspect_block: [],
  inspect_region: [],
  redstone_scan: [],
  redstone_component: [],
  redstone_engineer: [],
  logic_test: [],
  circuit_project: [],
  recall: [],
  remember_here: [],
  note: [],
  social: [],
  goal: [],
  hold: [],
  stop: [],
  say: [],
  idle: []
})

const BOT_METHOD_CAPS = Object.freeze({
  setControlState: 'move',
  setGoal: 'move',
  goto: 'move',
  dig: 'dig',
  placeBlock: 'place',
  attack: 'attack',
  activateBlock: 'use',
  openContainer: 'container',
  openFurnace: 'container',
  openChest: 'container',
  equip: 'equip',
  unequip: 'equip',
  consume: 'eat',
  toss: 'toss',
  tossStack: 'toss',
  craft: 'craft',
  sleep: 'use',
  elytraFly: 'move'
})

const PRIMITIVES_PROBE = ['setControlState', 'dig', 'placeBlock', 'attack', 'equip']
const PROMISE_PRIMITIVES = new Set([
  'dig', 'placeBlock', 'equip', 'unequip', 'consume', 'toss', 'tossStack',
  'craft', 'activateBlock', 'elytraFly', 'goto', 'attack', 'sleep'
])

class PhysicalBoundary extends EventEmitter {
  constructor ({
    config,
    state = null,
    now = () => Date.now(),
    logger = () => {},
    getState = null
  } = {}) {
    super()
    if (!config) throw new Error('PhysicalBoundary requires a RuntimeConfig')
    this.config = config
    this.state = state || null
    this.getState = getState || null
    this.now = now
    this.log = asLogger(logger)

    this.paused = false
    this.pausedReason = null
    this.pausedAt = 0

    this._actionStamps = []
    this.refusals = []
    this._lastRefusalLog = new Map()
  }

  pause (reason = 'paused by operator') {
    if (this.paused) return false
    this.paused = true
    this.pausedReason = String(reason || 'paused')
    this.pausedAt = this.now()
    this.emit('paused', { reason: this.pausedReason, at: this.pausedAt })
    return true
  }

  resume () {
    if (!this.paused) return false
    this.paused = false
    const was = this.pausedReason
    this.pausedReason = null
    this.pausedAt = 0
    this.emit('resumed', { was, at: this.now() })
    return true
  }

  capabilitiesFor (tool) {
    return ACTION_CAPABILITIES[tool] || []
  }

  isPhysical (tool) {
    return this.capabilitiesFor(tool).length > 0
  }

  check (tool, { caps = null, count = false } = {}) {
    const needed = Array.isArray(caps) ? caps : this.capabilitiesFor(tool)
    if (!needed.length) return { ok: true }

    const refusal = this._lifecycleRefusal()
    if (refusal) return this._refuse(tool, refusal.code, refusal.reason)

    const rateMax = Number(this.config.get('limits.maxPhysicalActionsPerMinute'))
    if (rateMax > 0) {
      const recent = this._pruneRate()
      if (recent >= rateMax) {
        return this._refuse(tool, 'rate-limit', `physical action rate limit reached (${rateMax}/min)`)
      }
    }

    if (count) this._actionStamps.push(this.now())
    return { ok: true }
  }

  recordAction () {
    this._actionStamps.push(this.now())
    this._pruneRate()
  }

  destinationRefusal () {
    return null
  }

  net (method) {
    const cap = BOT_METHOD_CAPS[method]
    if (!cap) return { ok: true }
    const refusal = this._lifecycleRefusal()
    if (refusal) return { ok: false, code: refusal.code, reason: refusal.reason, why: refusal.reason }
    return { ok: true }
  }

  snapshot () {
    return {
      paused: this._isPaused(),
      pausedReason: this.pausedReason,
      actionsLastMinute: this._pruneRate(),
      maxActionsPerMinute: Number(this.config.get('limits.maxPhysicalActionsPerMinute')),
      lastRefusals: this.refusals.slice(-5)
    }
  }

  _isPaused () {
    if (this.paused) return true
    try { return Boolean(this.state?.isPaused?.()) } catch { return false }
  }

  _lifecycleRefusal () {
    if (this.state) {
      try {
        if (typeof this.state.physicalRefusal === 'function') {
          const msg = this.state.physicalRefusal()
          if (msg) {
            const code = /paused/i.test(msg) ? 'paused' : /dead/i.test(msg) ? 'dead' : 'disconnected'
            return { code, reason: msg }
          }
        }
        if (this.state.isDead?.()) return { code: 'dead', reason: 'body is dead; waiting for respawn' }
        if (this.state.isPaused?.()) return { code: 'paused', reason: 'body is paused by operator (resume to continue)' }
      } catch { /* fall through */ }
    }
    if (this.getState) {
      try {
        const st = this.getState() || {}
        if (st.connected === false) return { code: 'disconnected', reason: 'not connected to the server' }
        if (st.alive === false) return { code: 'dead', reason: 'body is dead; waiting for respawn' }
      } catch { /* fall through */ }
    }
    if (this.paused) return { code: 'paused', reason: `body is paused (${this.pausedReason})` }
    return null
  }

  _pruneRate () {
    const cutoff = this.now() - 60_000
    while (this._actionStamps.length && this._actionStamps[0] < cutoff) this._actionStamps.shift()
    return this._actionStamps.length
  }

  _refuse (tool, code, reason) {
    const entry = { at: this.now(), tool, what: tool, code, reason, why: reason }
    this.refusals.push(entry)
    if (this.refusals.length > 30) this.refusals.shift()
    const key = `${tool}:${code}`
    const last = this._lastRefusalLog.get(key) || 0
    if (entry.at - last >= 5_000) {
      this._lastRefusalLog.set(key, entry.at)
      this.log('warn', `action refused [${code}] ${tool}: ${reason}`)
    }
    this.emit('refused', entry)
    return { ok: false, code, reason, why: reason }
  }
}

function refuseValue (primitive, reason) {
  if (primitive === 'openContainer' || primitive === 'openFurnace' || primitive === 'openChest') {
    return Promise.reject(Object.assign(new Error(`refused: ${reason || 'body unavailable'}`), { refused: true, boundary: true }))
  }
  if (PROMISE_PRIMITIVES.has(primitive)) return Promise.resolve(undefined)
  return undefined
}

function installPhysicalGuard (bot, boundary, { logger = () => {} } = {}) {
  if (!bot || !boundary) return { gated: 0, uninstall: () => {} }
  if (bot.__zincaiPhysicalGuard) return bot.__zincaiPhysicalGuard
  const log = asLogger(logger)
  const originals = new Map()
  const state = { gated: 0, uninstall }

  const gate = (obj, name, isRelease = null) => {
    if (!obj || typeof obj[name] !== 'function') return
    const key = `${obj === bot ? 'bot' : 'pf'}.${name}`
    if (originals.has(key)) return
    const original = obj[name]
    originals.set(key, { obj, name, original })
    obj[name] = function guardedPrimitive (...args) {
      if (isRelease && isRelease(...args)) return original.apply(this, args)
      const verdict = boundary.net(name)
      if (!verdict.ok) return refuseValue(name, verdict.reason)
      return original.apply(this, args)
    }
  }

  const installNow = () => {
    gate(bot, 'setControlState', (_ctrl, val) => val === false)
    gate(bot, 'dig')
    gate(bot, 'placeBlock')
    gate(bot, 'activateBlock')
    gate(bot, 'attack')
    gate(bot, 'equip')
    gate(bot, 'unequip')
    gate(bot, 'consume')
    gate(bot, 'toss')
    gate(bot, 'tossStack')
    gate(bot, 'craft')
    gate(bot, 'sleep')
    gate(bot, 'openContainer')
    gate(bot, 'openFurnace')
    gate(bot, 'openChest')
    gate(bot, 'elytraFly')
    if (bot.pathfinder) {
      gate(bot.pathfinder, 'setGoal', (goal) => goal === null || goal === undefined)
      gate(bot.pathfinder, 'goto')
      gate(bot.pathfinder, 'stop', () => true)
    }
    state.gated = originals.size
    log(originals.size ? 'info' : 'debug', `physical boundary installed — ${originals.size} primitives gated`)
  }

  let pending = null
  const ready = PRIMITIVES_PROBE.some((name) => typeof bot[name] === 'function')
  if (ready || typeof bot.once !== 'function') installNow()
  else {
    pending = () => { pending = null; installNow() }
    bot.once('inject_allowed', pending)
  }

  function uninstall () {
    if (pending) {
      try { bot.removeListener?.('inject_allowed', pending) } catch { /* noop */ }
      pending = null
    }
    for (const { obj, name, original } of originals.values()) {
      try { obj[name] = original } catch { /* already replaced */ }
    }
    originals.clear()
    delete bot.__zincaiPhysicalGuard
  }

  bot.__zincaiPhysicalGuard = state
  return state
}

module.exports = {
  PhysicalBoundary,
  installPhysicalGuard,
  ACTION_CAPABILITIES,
  BOT_METHOD_CAPS
}
