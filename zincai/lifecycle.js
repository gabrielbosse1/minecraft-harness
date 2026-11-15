'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** Durable process-session ledger. A missing shutdown is explicitly unexpected;
 * it is never assigned a guessed timestamp. Writes are atomic and session IDs
 * make startup/shutdown records idempotent across repeated close hooks. */
class LifecycleStore {
  constructor ({ file, now = () => Date.now(), id = () => crypto.randomUUID() } = {}) {
    this.file = file
    this.now = now
    this.id = id
    this.state = { version: 1, sessions: [] }
    this._load()
    const prev = this.state.sessions[this.state.sessions.length - 1] || null
    if (prev && !prev.shutdownAt) prev.outcome = 'unexpected'
    this.previous = prev ? JSON.parse(JSON.stringify(prev)) : null
    this.current = { id: this.id(), startupAt: this.now(), shutdownAt: null, shutdownReason: null, outcome: 'running', stats: {}, continuity: {} }
    this.state.sessions.push(this.current)
    this.state.sessions = this.state.sessions.slice(-100)
    this.save()
  }
  _load () {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (value?.version === 1 && Array.isArray(value.sessions)) this.state = value
    } catch {}
  }
  save () {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.state, null, 2))
      fs.renameSync(temp, this.file)
    } catch {}
  }
  shutdown (reason, { stats = {}, continuity = {} } = {}) {
    if (this.current.shutdownAt) return this.current
    this.current.shutdownAt = this.now()
    this.current.shutdownReason = String(reason || 'unknown')
    this.current.outcome = 'clean'
    this.current.stats = stats
    this.current.continuity = continuity
    this.save()
    return this.current
  }
  startupMessage (restore = {}) {
    const p = this.previous
    return `Agent process startup at ${new Date(this.current.startupAt).toISOString()}; session ${this.current.id}. ` +
      (p ? `Previous session ${p.id} started ${new Date(p.startupAt).toISOString()}, shutdown ${p.shutdownAt ? new Date(p.shutdownAt).toISOString() : 'not recorded (unexpected termination; exact time unknown)'}, reason ${p.shutdownReason || 'unknown'}, outcome ${p.outcome}. ` : 'No previous session record. ') +
      `Restored state: ${JSON.stringify(restore).slice(0, 1200)}`
  }
}
module.exports = { LifecycleStore }
