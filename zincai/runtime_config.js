/**
 * runtime_config.js — persistent, schema-driven operational parameter store.
 *
 * Holds infrastructure, rate-cap, reconnect, and console-control parameters
 * persisted in `<dataDir>/runtime-config.json`. Does not define gameplay modes,
 * action permissions, or model behavior toggles.
 *
 * Pure data + fs. No mineflayer, no LLM, no timers.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const SCHEMA_VERSION = 2

const TYPES = Object.freeze(['boolean', 'integer', 'number', 'string', 'enum', 'uuid-list', 'string-list'])

const SCHEMA = Object.freeze([
  // --------------------------------------------------------------- limits --
  {
    name: 'limits.maxConcurrentJobs',
    group: 'limits',
    type: 'integer',
    default: 4,
    min: 1,
    max: 64,
    apply: 'boundary',
    describe: 'background jobs allowed at once (applies as running jobs finish)'
  },
  {
    name: 'limits.maxPhysicalActionsPerMinute',
    group: 'limits',
    type: 'integer',
    default: 600,
    min: 0,
    max: 10_000,
    apply: 'immediate',
    describe: 'sliding-window anti-flood ceiling on physical actions per minute (0 = unlimited)'
  },
  {
    name: 'limits.maxGoalRuntimeMinutes',
    group: 'limits',
    type: 'integer',
    default: 0,
    min: 0,
    max: 1440,
    apply: 'immediate',
    describe: 'suspend a goal that runs longer than this without completing (0 = off)'
  },

  // ----------------------------------------------------------- connection --
  {
    name: 'connection.minRetryDelayMs',
    group: 'connection',
    type: 'integer',
    default: 5_000,
    min: 250,
    max: 600_000,
    apply: 'immediate',
    describe: 'minimum delay between reconnect retries'
  },
  {
    name: 'connection.retryDelayMs',
    group: 'connection',
    type: 'integer',
    default: 5_000,
    min: 250,
    max: 600_000,
    apply: 'immediate',
    describe: 'initial reconnect delay; doubles per attempt up to maxRetryDelayMs'
  },
  {
    name: 'connection.maxRetryDelayMs',
    group: 'connection',
    type: 'integer',
    default: 120_000,
    min: 500,
    max: 3_600_000,
    apply: 'immediate',
    describe: 'maximum delay between reconnect retries'
  },
  {
    name: 'connection.maxRetries',
    group: 'connection',
    type: 'integer',
    default: 40,
    min: 1,
    max: 1_000,
    apply: 'immediate',
    describe: 'reconnect attempts before exiting after a dropped session'
  },

  // ---------------------------------------------------------------- death --
  {
    name: 'death.respawnDelayMs',
    group: 'death',
    type: 'integer',
    default: 1_500,
    min: 0,
    max: 60_000,
    apply: 'immediate',
    describe: 'delay before sending respawn after death'
  },

  // -------------------------------------------------------------- control --
  {
    name: 'control.allowConsole',
    group: 'control',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'accept operator commands on stdin'
  },
  {
    name: 'control.auditLog',
    group: 'control',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'log every console command'
  }
])

const DEFINITIONS = SCHEMA.map((d) => Object.freeze({ apply: 'immediate', ...d }))
const BY_NAME = new Map(DEFINITIONS.map((d) => [d.name, d]))
const GROUPS = [...new Set(DEFINITIONS.map((d) => d.group))]

function normalizeUuid (raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[{}]/g, '')
  const bare = s.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(bare)) return null
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`
}

const cleanText = (raw, max = 64) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

class RuntimeConfig extends EventEmitter {
  constructor ({ file = null, logger = () => {}, env = process.env, now = () => Date.now() } = {}) {
    super()
    this.file = file || null
    this.log = asLogger(logger)
    this.now = now
    this.values = {}
    this.defaults = {}
    this.overrides = {}
    this.pending = {}
    this.loadedAt = 0
    this.saveCount = 0
    for (const def of DEFINITIONS) this.defaults[def.name] = def.default
    for (const def of DEFINITIONS) this.values[def.name] = def.default
    this.load()
    this.applyEnv(env)
  }

  static schema (group = null) {
    return group ? DEFINITIONS.filter((d) => d.group === group) : DEFINITIONS.slice()
  }

  static groups () { return GROUPS.slice() }

  static definition (name) { return BY_NAME.get(String(name ?? '').trim()) || null }

  static has (name) { return BY_NAME.has(String(name ?? '').trim()) }

  static validate (name, raw) {
    const def = BY_NAME.get(String(name ?? '').trim())
    if (!def) return { ok: false, error: `unknown parameter "${name}"` }
    return validateValue(def, raw)
  }

  static describeValue (def) {
    if (!def) return ''
    switch (def.type) {
      case 'boolean': return 'true | false'
      case 'integer': return `${def.min ?? '-∞'}..${def.max ?? '∞'}`
      case 'number': return `${def.min ?? '-∞'}..${def.max ?? '∞'}`
      case 'enum': return (def.values || []).join(' | ')
      case 'uuid-list': return 'comma-separated UUIDs'
      case 'string-list': return 'comma-separated words'
      default: return def.maxLength ? `text (max ${def.maxLength})` : 'text'
    }
  }

  get (name) {
    const def = BY_NAME.get(String(name ?? '').trim())
    if (!def) return undefined
    return this.values[def.name]
  }

  effectiveValue (name) { return this.get(name) }

  isPending (name) { return Boolean(this.pending[name]) }

  pendingChanges () {
    return Object.entries(this.pending).map(([name, p]) => ({ name, ...p }))
  }

  all () {
    const out = {}
    for (const def of DEFINITIONS) out[def.name] = this.values[def.name]
    return out
  }

  group (group) {
    return DEFINITIONS.filter((d) => d.group === group).map((d) => ({
      name: d.name,
      value: this.values[d.name],
      default: d.default,
      definition: d
    }))
  }

  format ({ group = null, names = null } = {}) {
    const defs = names
      ? names.map((n) => BY_NAME.get(n)).filter(Boolean)
      : (group ? DEFINITIONS.filter((d) => d.group === group) : DEFINITIONS)
    const lines = []
    let current = null
    for (const d of defs) {
      if (!names && d.group !== current) { lines.push(`[${d.group}]`); current = d.group }
      const value = formatValue(this.values[d.name])
      const suffix = this.pending[d.name] ? ' (change pending: applies at the next safe boundary)' : ''
      lines.push(`  ${d.name} = ${value}${suffix}`)
      if (d.describe) lines.push(`      ${d.describe}${d.type === 'boolean' ? '' : ` — ${RuntimeConfig.describeValue(d)}`}`)
    }
    return lines.join('\n')
  }

  set (name, raw, { by = 'operator', physicalBusy = false } = {}) {
    const def = BY_NAME.get(String(name ?? '').trim())
    if (!def) return { ok: false, name, error: `unknown parameter "${name}" — try: config show` }
    const verdict = validateValue(def, raw)
    if (!verdict.ok) return { ok: false, name, error: verdict.error }
    const oldValue = this.values[def.name]
    const value = verdict.value
    if (sameValue(oldValue, value)) {
      return { ok: true, name: def.name, oldValue, value, applied: 'now', unchanged: true }
    }
    const boundaryBlocked = def.apply === 'boundary' && physicalBusy
    if (boundaryBlocked) {
      this.pending[def.name] = { value, requestedAt: this.now(), by, reason: `${def.apply} change while a physical action is running` }
      this.emit('pending', { name: def.name, value, oldValue, by })
      return {
        ok: true,
        name: def.name,
        oldValue,
        value,
        applied: 'boundary',
        reason: 'a physical action is running; the old value stays until it ends, then the new one is applied'
      }
    }
    delete this.pending[def.name]
    this.values[def.name] = value
    this.overrides[def.name] = 'file'
    this.save()
    const change = { name: def.name, oldValue, value, by, applied: 'now', at: this.now() }
    this.emit('change', change)
    return { ok: true, ...change }
  }

  applyPending ({ force = false, physicalBusy = false } = {}) {
    const applied = []
    for (const [name, p] of Object.entries(this.pending)) {
      const def = BY_NAME.get(name)
      if (!def) { delete this.pending[name]; continue }
      if (!force && physicalBusy) continue
      delete this.pending[name]
      const oldValue = this.values[name]
      this.values[name] = p.value
      this.overrides[name] = 'file'
      applied.push({ name, oldValue, value: p.value })
      this.emit('change', { name, oldValue, value: p.value, by: p.by, applied: 'boundary', at: this.now() })
    }
    if (applied.length) this.save()
    return applied
  }

  reset (name, { by = 'operator' } = {}) {
    const def = BY_NAME.get(String(name ?? '').trim())
    if (!def) return { ok: false, error: `unknown parameter "${name}"` }
    const oldValue = this.values[name]
    delete this.pending[name]
    this.values[name] = def.default
    delete this.overrides[name]
    this.save()
    this.emit('change', { name, oldValue, value: def.default, by, applied: 'now', reset: true, at: this.now() })
    return { ok: true, name, oldValue, value: def.default }
  }

  applyEnv (_env = process.env) {
    // Operational parameters are configured through defaults/file/console.
  }

  load () {
    this.loadedAt = this.now()
    if (!this.file) return this
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.log('warn', `runtime config: unreadable store (${err.message || err}) — using defaults`)
      return this
    }
    const values = raw && typeof raw === 'object' ? (raw.values || raw) : {}
    for (const [name, value] of Object.entries(values)) {
      const def = BY_NAME.get(name)
      if (!def) continue
      const verdict = validateValue(def, value)
      if (!verdict.ok) { this.log('warn', `runtime config: saved value for ${name} is invalid (${verdict.error}) — keeping default`); continue }
      this.values[name] = verdict.value
      this.overrides[name] = 'file'
    }
    return this
  }

  save () {
    this.saveCount++
    if (!this.file) return false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const body = JSON.stringify({ version: SCHEMA_VERSION, savedAt: new Date(this.now()).toISOString(), values: this.all() }, null, 2)
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, this.file)
      return true
    } catch (err) {
      this.log('warn', `runtime config: could not save (${err.message || err}) — change is live for this process only`)
      return false
    }
  }
}

function asLogger (logger) {
  if (typeof logger === 'function') return logger
  if (logger && typeof logger === 'object') {
    return (level, msg) => (logger[level] || logger.info || (() => {}))(msg)
  }
  return () => {}
}

function validateValue (def, raw) {
  if (!def) return { ok: false, error: 'no definition' }
  try {
    switch (def.type) {
      case 'boolean': return coerceBoolean(def, raw)
      case 'integer': return coerceNumber(def, raw, true)
      case 'number': return coerceNumber(def, raw, false)
      case 'enum': return coerceEnum(def, raw)
      case 'string': return coerceString(def, raw)
      case 'uuid-list': return coerceUuidList(def, raw)
      case 'string-list': return coerceStringList(def, raw)
      default: return { ok: false, error: `parameter "${def.name}" has an unsupported type` }
    }
  } catch (err) {
    return { ok: false, error: `${def.name}: ${String(err?.message || err).slice(0, 80)}` }
  }
}

const TRUE_RE = /^(1|true|yes|on|enable|enabled|sim|ligado)$/i
const FALSE_RE = /^(0|false|no|off|disable|disabled|nao|não|desligado)$/i

function coerceBoolean (def, raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  const s = String(raw ?? '').trim()
  if (s === '') return { ok: false, error: `${def.name} needs true or false` }
  if (TRUE_RE.test(s)) return { ok: true, value: true }
  if (FALSE_RE.test(s)) return { ok: true, value: false }
  return { ok: false, error: `${def.name} needs true or false (got "${s.slice(0, 24)}")` }
}

function coerceNumber (def, raw, integer) {
  if (Array.isArray(raw) || (raw !== null && typeof raw === 'object')) {
    return { ok: false, error: `${def.name} needs a number` }
  }
  const s = String(raw ?? '').trim()
  if (s === '') return { ok: false, error: `${def.name} needs a number` }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, error: `${def.name} needs a number (got "${s.slice(0, 24)}")` }
  if (integer && !Number.isInteger(n)) return { ok: false, error: `${def.name} needs a whole number (got ${s})` }
  const min = def.min ?? -Infinity
  const max = def.max ?? Infinity
  if (n < min || n > max) return { ok: false, error: `${def.name} must be between ${min} and ${max} (got ${s})` }
  return { ok: true, value: n }
}

function coerceEnum (def, raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  const allowed = (def.values || []).map((v) => String(v).toLowerCase())
  if (!allowed.includes(s)) return { ok: false, error: `${def.name} must be one of: ${(def.values || []).join(', ')}` }
  return { ok: true, value: (def.values || [])[allowed.indexOf(s)] }
}

function coerceString (def, raw) {
  if (Array.isArray(raw) || (raw !== null && typeof raw === 'object')) return { ok: false, error: `${def.name} needs text` }
  const value = cleanText(raw, def.maxLength ?? 64)
  if (!value && !def.allowEmpty) return { ok: false, error: `${def.name} cannot be empty` }
  if (def.pattern && !def.pattern.test(value)) return { ok: false, error: `${def.name} has an unexpected form` }
  return { ok: true, value }
}

function coerceUuidList (def, raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/)
  const out = []
  for (const item of list) {
    const s = String(item ?? '').trim()
    if (!s) continue
    const uuid = normalizeUuid(s.split(':')[0])
    if (!uuid) return { ok: false, error: `${def.name} needs Minecraft UUIDs; "${s.slice(0, 40)}" is not one` }
    if (!out.includes(uuid)) out.push(uuid)
  }
  return { ok: true, value: out }
}

function coerceStringList (def, raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/)
  const out = []
  for (const item of list) {
    const s = cleanText(item, 32)
    if (!s) continue
    if (!out.some((v) => v.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return { ok: true, value: out }
}

function sameValue (a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}

function formatValue (value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : '(empty)'
  if (typeof value === 'string' && value === '') return '""'
  return String(value)
}

module.exports = {
  RuntimeConfig,
  SCHEMA: DEFINITIONS,
  GROUPS,
  TYPES,
  SCHEMA_VERSION,
  normalizeUuid,
  validateValue,
  formatValue,
  asLogger
}
