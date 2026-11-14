/**
 * death_recovery.js — deterministic state inspection after respawn.
 *
 * Records death/respawn state (position, dimension, health, inventory) so the
 * model receives an accurate post-respawn observation on its next turn.
 */
'use strict'

const { EventEmitter } = require('events')
const { asLogger } = require('./runtime_config')

class DeathRecovery extends EventEmitter {
  constructor ({
    config,
    now = () => Date.now(),
    logger = () => {},
    getPosition = () => null,
    getDimension = () => 'overworld',
    getHealth = () => null,
    getInventory = () => [],
    observe = null
  } = {}) {
    super()
    if (!config) throw new Error('DeathRecovery requires a RuntimeConfig')
    this.config = config
    this.now = now
    this.log = asLogger(logger)
    this.getPosition = getPosition
    this.getDimension = getDimension
    this.getHealth = getHealth
    this.getInventory = getInventory
    this.observe = observe

    this.deathCount = 0
    this.lastDeath = null
    this.lastOutcome = null
    this.history = []
  }

  get deaths () { return this.deathCount }
  get lastRecovery () { return this.lastOutcome }

  respawnDelayMs () { return 400 }

  onDeath (info = {}) { return this.noteDeath(info) }

  noteDeath ({ position = null, dimension = 'overworld', cause = '' } = {}) {
    this.deathCount += 1
    this.lastDeath = {
      at: this.now(),
      position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null,
      dimension: normDim(dimension),
      cause: String(cause || '').slice(0, 120)
    }
    this.emit('death', this.lastDeath)
    return this.lastDeath
  }

  async onRespawn (observation = null) {
    const snapshot = observation ? normalizeObs(observation) : this._safeObserve()
    const outcome = {
      at: this.now(),
      verdict: 'respawned',
      why: 'respawned; current position and inventory recorded',
      observation: snapshot,
      problems: []
    }
    this.lastOutcome = outcome
    this.history.push(outcome)
    if (this.history.length > 10) this.history.shift()
    const posStr = snapshot.position ? `${snapshot.position.x},${snapshot.position.y},${snapshot.position.z}` : 'unknown'
    this.log('info', `post-respawn: ${snapshot.dimension} @ ${posStr} (${snapshot.inventory.length} item stack(s))`)
    this.emit('recovered', outcome)
    return outcome
  }

  snapshot () {
    return {
      deathCount: this.deathCount,
      lastDeath: this.lastDeath,
      lastOutcome: this.lastOutcome
        ? { at: this.lastOutcome.at, verdict: this.lastOutcome.verdict, why: this.lastOutcome.why, problems: this.lastOutcome.problems }
        : null
    }
  }

  _safeObserve () {
    if (typeof this.observe === 'function') {
      try { return normalizeObs(this.observe()) } catch { /* fall through */ }
    }
    try {
      return normalizeObs({
        position: this.getPosition(),
        dimension: this.getDimension(),
        health: this.getHealth(),
        inventory: this.getInventory()
      })
    } catch {
      return { alive: true, position: null, dimension: 'overworld', health: null, inventory: [] }
    }
  }
}

function normalizeObs (s = {}) {
  const pos = s.position
  return {
    alive: s.alive !== false,
    position: pos && Number.isFinite(pos.x) ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
    dimension: normDim(s.dimension),
    health: Number.isFinite(s.health) ? s.health : null,
    inventory: Array.isArray(s.inventory) ? s.inventory.slice(0, 40) : []
  }
}

function respawnSummary (lastDeath, observation = {}) {
  const obs = normalizeObs(observation)
  const parts = []
  if (obs.position) parts.push(`at ${obs.position.x},${obs.position.y},${obs.position.z} (${obs.dimension})`)
  else parts.push(`in ${obs.dimension}`)
  if (obs.health !== null) parts.push(`hp ${Math.round(obs.health)}/20`)
  const count = obs.inventory.reduce((n, i) => n + (Number(i?.count) || 0), 0)
  parts.push(count > 0 ? `${count} items carried` : 'inventory empty')
  if (lastDeath?.position) {
    parts.push(`died at ${lastDeath.position.x},${lastDeath.position.y},${lastDeath.position.z}`)
  }
  return parts.join(', ')
}

function normDim (d) {
  return String(d || 'overworld').replace(/^minecraft:/, '').toLowerCase()
}

module.exports = { DeathRecovery, respawnSummary, normDim }
