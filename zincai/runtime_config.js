/**
 * runtime_config.js — the persistent, schema-driven parameter store.
 *
 * WHY THIS EXISTS
 *   Zinc is autonomous: it keeps its identity, its goals and its own judgement.
 *   An operator still needs to *bound* it — which physical acts are allowed,
 *   where it may act, whether it may speak in public, how often it may retry a
 *   dead link — without restarting it and without swapping its behaviour for a
 *   different "mode".
 *
 *   So there are no modes here. There is one flat set of independently
 *   adjustable parameters, each with a type, a range and a documented meaning.
 *   Every parameter is:
 *
 *     - inspectable        config / config show <group> / config show <name>
 *     - validated          type + range + enum; unknown names are refused
 *     - persistent         data/runtime-config.json, reloaded on restart
 *     - individually free  changing one never implies changing another
 *
 *   `apply` says WHEN a change can take effect:
 *
 *     'immediate'  the new value is enforced from this instant (a permission
 *                  turning off refuses the next call; the in-flight call is
 *                  untouched).
 *     'boundary'   cannot be honoured while a physical action is running —
 *                  the old value stays until the action finishes and the
 *                  change is recorded as pending, with the reason.
 *
 *   Precedence, lowest first: schema default → runtime-config.json → env
 *   (control.operators / control.prefix, so a panel template can pin the
 *   operator list at install time).
 *
 * Pure data + fs. No mineflayer, no LLM, no timers.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const SCHEMA_VERSION = 1

/** Types understood by the validator. */
const TYPES = Object.freeze(['boolean', 'integer', 'number', 'string', 'enum', 'uuid-list', 'string-list'])

/**
 * The whole surface. One entry per parameter; nothing is hardcoded in the
 * command layer, so `config show` and the enforcement code can never drift.
 */
const SCHEMA = Object.freeze([
  // ------------------------------------------------------------- boundary --
  {
    name: 'boundary.enabled',
    group: 'boundary',
    type: 'boolean',
    default: false,
    apply: 'immediate',
    describe: 'refuse physical actions outside the permitted area and report the violation'
  },
  {
    name: 'boundary.centerX',
    group: 'boundary',
    type: 'integer',
    default: 0,
    min: -30_000_000,
    max: 30_000_000,
    describe: 'x centre of the permitted area (ignored while boundary.enabled is false)'
  },
  {
    name: 'boundary.centerZ',
    group: 'boundary',
    type: 'integer',
    default: 0,
    min: -30_000_000,
    max: 30_000_000,
    describe: 'z centre of the permitted area'
  },
  {
    name: 'boundary.radius',
    group: 'boundary',
    type: 'integer',
    default: 256,
    min: 0,
    max: 1_000_000,
    describe: 'horizontal radius (blocks) around the centre where the body may act'
  },
  {
    name: 'boundary.dimension',
    group: 'boundary',
    type: 'string',
    default: 'overworld',
    apply: 'immediate',
    describe: 'dimension the permitted area applies to (overworld, the_nether, the_end)'
  },
  {
    name: 'boundary.homeX',
    group: 'boundary',
    type: 'integer',
    default: 0,
    min: -30_000_000,
    max: 30_000_000,
    describe: 'x of the designated room / home the body returns to after a death'
  },
  {
    name: 'boundary.homeY',
    group: 'boundary',
    type: 'integer',
    default: 64,
    min: -256,
    max: 4096,
    describe: 'y of the designated room'
  },
  {
    name: 'boundary.homeZ',
    group: 'boundary',
    type: 'integer',
    default: 0,
    min: -30_000_000,
    max: 30_000_000,
    describe: 'z of the designated room'
  },
  {
    name: 'boundary.homeDimension',
    group: 'boundary',
    type: 'string',
    default: 'overworld',
    describe: 'dimension of the designated room'
  },
  {
    name: 'boundary.returnHomeOnDeath',
    group: 'boundary',
    type: 'boolean',
    default: false,
    apply: 'immediate',
    describe: 'after a respawn, walk back to the designated room (needs boundary.enabled + a route)'
  },
  {
    name: 'boundary.blockOutside',
    group: 'boundary',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'refuse new targets outside the permitted area (false = only report)'
  },

  // -------------------------------------------------------------- actions --
  {
    name: 'actions.allowMovement',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'walking, pathfinder goals and control keys'
  },
  {
    name: 'actions.allowDig',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'breaking blocks and the dig/gather tools'
  },
  {
    name: 'actions.allowPlace',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'placing blocks: build, build_shape, place, shelter, scaffolding'
  },
  {
    name: 'actions.allowAttack',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'swinging at entities (never starts a fight on its own; this can only forbid it)'
  },
  {
    name: 'actions.allowContainers',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'opening chests, barrels, furnaces (take, put, look_in, smelt)'
  },
  {
    name: 'actions.allowUse',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'right-clicking blocks: levers, buttons, doors, beds (use_block, light_up, sleep)'
  },
  {
    name: 'actions.allowEquip',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'moving items between inventory slots and hands (equip)'
  },
  {
    name: 'actions.allowEat',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'eating and drinking (the hunger reflex included)'
  },
  {
    name: 'actions.allowToss',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'dropping items (give)'
  },
  {
    name: 'actions.allowCraft',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'crafting and smelting recipes (craft)'
  },
  {
    name: 'actions.allowScripts',
    group: 'actions',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'running a local script with run_script'
  },

  // --------------------------------------------------------------- limits --
  {
    name: 'limits.maxConcurrentJobs',
    group: 'limits',
    type: 'integer',
    default: 4,
    min: 1,
    max: 64,
    apply: 'boundary',
    describe: 'background jobs allowed at once; a lower value takes effect as running jobs end'
  },
  {
    name: 'limits.maxPhysicalActionsPerMinute',
    group: 'limits',
    type: 'integer',
    default: 240,
    min: 0,
    max: 10_000,
    apply: 'immediate',
    describe: 'sliding-window ceiling on physical actions (0 = no ceiling)'
  },
  {
    name: 'limits.maxPublicChatPerMinute',
    group: 'limits',
    type: 'integer',
    default: 12,
    min: 0,
    max: 200,
    apply: 'immediate',
    describe: 'sliding-window ceiling on public chat lines (0 = no ceiling)'
  },
  {
    name: 'limits.maxGoalRuntimeMinutes',
    group: 'limits',
    type: 'integer',
    default: 0,
    min: 0,
    max: 1440,
    apply: 'immediate',
    describe: 'suspend (never delete) a goal that has run this long without completing; 0 = off'
  },

  // -------------------------------------------------------- communication --
  {
    name: 'communication.publicChat',
    group: 'communication',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'may send public chat messages'
  },
  {
    name: 'communication.privateMessages',
    group: 'communication',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'may send private messages (/msg). Never a fallback to public chat'
  },
  {
    name: 'communication.replyToChat',
    group: 'communication',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'may answer a player who addresses it (independent of the two above)'
  },

  // ----------------------------------------------------------- connection --
  {
    name: 'connection.joinOnStart',
    group: 'connection',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'join the configured server when the process starts'
  },
  {
    name: 'connection.autoReconnect',
    group: 'connection',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'after a link that had spawned once, join again automatically'
  },
  {
    name: 'connection.minRetryDelayMs',
    group: 'connection',
    type: 'integer',
    default: 5_000,
    min: 250,
    max: 600_000,
    apply: 'immediate',
    describe: 'floor of the retry delay: the maximum retry frequency'
  },
  {
    name: 'connection.retryDelayMs',
    group: 'connection',
    type: 'integer',
    default: 5_000,
    min: 250,
    max: 600_000,
    apply: 'immediate',
    describe: 'first retry delay; doubles per attempt up to connection.maxRetryDelayMs'
  },
  {
    name: 'connection.maxRetryDelayMs',
    group: 'connection',
    type: 'integer',
    default: 120_000,
    min: 500,
    max: 3_600_000,
    apply: 'immediate',
    describe: 'ceiling of the retry delay'
  },
  {
    name: 'connection.maxRetries',
    group: 'connection',
    type: 'integer',
    default: 40,
    min: 1,
    max: 1_000,
    apply: 'immediate',
    describe: 'attempts before giving up on a link that had already spawned'
  },

  // ---------------------------------------------------------------- death --
  {
    name: 'death.autoRespawn',
    group: 'death',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'press respawn automatically after a death'
  },
  {
    name: 'death.respawnDelayMs',
    group: 'death',
    type: 'integer',
    default: 1_500,
    min: 0,
    max: 60_000,
    apply: 'immediate',
    describe: 'how long to wait before pressing respawn'
  },

  // -------------------------------------------------------------- control --
  {
    name: 'control.prefix',
    group: 'control',
    type: 'string',
    default: '!zinc',
    apply: 'immediate',
    describe: 'chat prefix for operator commands, e.g. "!zinc status"'
  },
  {
    name: 'control.operators',
    group: 'control',
    type: 'uuid-list',
    default: [],
    apply: 'immediate',
    describe: 'Minecraft UUIDs allowed to run control commands (never usernames alone)'
  },
  {
    name: 'control.operatorNames',
    group: 'control',
    type: 'string-list',
    default: [],
    apply: 'immediate',
    describe: 'display names bound to control.operators for logs; grants no authority'
  },
  {
    name: 'control.allowConsole',
    group: 'control',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'accept the same commands on stdin (the PufferPanel console)'
  },
  {
    name: 'control.announce',
    group: 'control',
    type: 'boolean',
    default: false,
    apply: 'immediate',
    describe: 'answer a refused chat command in public chat (off = log only; an authorised answer is always a whisper)'
  },
  {
    name: 'control.auditLog',
    group: 'control',
    type: 'boolean',
    default: true,
    apply: 'immediate',
    describe: 'write every command and every refused attempt to the log'
  }
])

/**
 * Every parameter gets an `apply` rule; 'immediate' is the default because it
 * is the stricter promise (the value is honoured at once). Only a parameter
 * whose change would be unsafe mid-action declares 'boundary'.
 */
const DEFINITIONS = SCHEMA.map((d) => Object.freeze({ apply: 'immediate', ...d }))
const BY_NAME = new Map(DEFINITIONS.map((d) => [d.name, d]))
const GROUPS = [...new Set(DEFINITIONS.map((d) => d.group))]

/** Normalise a UUID: lowercase, dashes optional in the input. */
function normalizeUuid (raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[{}]/g, '')
  const bare = s.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(bare)) return null
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`
}

/** Collapse whitespace and cap a free-text parameter. */
const cleanText = (raw, max = 64) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

class RuntimeConfig extends EventEmitter {
  /**
   * @param {{ file?: string|null, logger?: (level:string,msg:string)=>void,
   *           env?: object, now?: () => number, saveThrottleMs?: number }} [opts]
   */
  constructor ({ file = null, logger = () => {}, env = process.env, now = () => Date.now() } = {}) {
    super()
    this.file = file || null
    this.log = asLogger(logger)
    this.now = now
    this.values = {}
    this.defaults = {}
    this.overrides = {} // where a non-default value came from: 'file' | 'env'
    this.pending = {} // name -> { value, waitingOn, requestedAt }
    this.loadedAt = 0
    this.saveCount = 0
    for (const def of DEFINITIONS) this.defaults[def.name] = def.default
    for (const def of DEFINITIONS) this.values[def.name] = def.default
    this.load()
    this.applyEnv(env)
  }

  // ------------------------------------------------------------- schema ---

  /** Every parameter definition, optionally filtered to one group. */
  static schema (group = null) {
    return group ? DEFINITIONS.filter((d) => d.group === group) : DEFINITIONS.slice()
  }

  static groups () { return GROUPS.slice() }

  /** Definition for one parameter, or null (used to reject unknown names). */
  static definition (name) { return BY_NAME.get(String(name ?? '').trim()) || null }

  /** Does this name exist? */
  static has (name) { return BY_NAME.has(String(name ?? '').trim()) }

  // --------------------------------------------------------- validation ---

  /**
   * Validate one raw value against its definition.
   * Accepted input is deliberately generous (a chat line is a string, a panel
   * checkbox is "true"), but the RESULT is always the declared type — or a
   * refusal that names the parameter and the range.
   * @returns {{ ok: boolean, value?: any, error?: string }}
   */
  static validate (name, raw) {
    const def = BY_NAME.get(String(name ?? '').trim())
    if (!def) return { ok: false, error: `unknown parameter "${name}"` }
    return validateValue(def, raw)
  }

  /** Allowed values for a parameter, for help/status output. */
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

  // ------------------------------------------------------------- values ---

  /** Current value in force (a pending change is not in force yet). */
  get (name) {
    const def = BY_NAME.get(String(name ?? '').trim())
    if (!def) return undefined
    return this.values[def.name]
  }

  /** Effective value of a parameter whose *pending* change has been applied. */
  effectiveValue (name) { return this.get(name) }

  /** True when a change is waiting for a safe boundary. */
  isPending (name) { return Boolean(this.pending[name]) }

  pendingChanges () {
    return Object.entries(this.pending).map(([name, p]) => ({ name, ...p }))
  }

  /** The full effective configuration as a plain object. */
  all () {
    const out = {}
    for (const def of DEFINITIONS) out[def.name] = this.values[def.name]
    return out
  }

  /** One group as `[{ name, value, default, def }]`. */
  group (group) {
    return DEFINITIONS.filter((d) => d.group === group).map((d) => ({
      name: d.name,
      value: this.values[d.name],
      default: d.default,
      definition: d
    }))
  }

  /** Human-readable listing for `config`/`config show`. */
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

  // -------------------------------------------------------------- change ---

  /**
   * Change one parameter.
   * @param {string} name
   * @param {any} raw
   * @param {{ by?: string, physicalBusy?: boolean, reason?: string }} [opts]
   *   physicalBusy — a physical action is in flight right now. A parameter with
   *   `apply: 'boundary'` is then recorded as pending instead of applied.
   * @returns {{ ok:boolean, name:string, oldValue?:any, value?:any,
   *             applied?:'now'|'boundary', reason?:string, error?:string }}
   */
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
      // The old value stays in force: half-applying a limit mid-action is how a
      // job gets orphaned. It is recorded, explained and applied when the body
      // is idle again (Host.applyPendingChanges / attachSession).
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

  /** Put a pending change into force. Called at a safe boundary. */
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

  /** Return one parameter to its schema default (and forget the override). */
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

  // ----------------------------------------------------------- env/file ---

  /**
   * Environment wins over the file for the knobs a panel template must be able
   * to pin without an edit: the operator list, the command prefix and whether
   * the process joins on start.
   */
  applyEnv (env = process.env) {
    const ops = env.ZINC_OPERATORS ?? env.CONTROL_OPERATORS
    if (ops !== undefined && String(ops).trim() !== '') {
      const verdict = validateValue(BY_NAME.get('control.operators'), ops)
      if (verdict.ok) {
        this.values['control.operators'] = verdict.value
        this.overrides['control.operators'] = 'env'
      } else {
        this.log('warn', `control.operators from the environment ignored: ${verdict.error}`)
      }
    }
    const prefix = env.ZINC_COMMAND_PREFIX ?? env.CONTROL_PREFIX
    if (prefix !== undefined && String(prefix).trim() !== '') {
      const verdict = validateValue(BY_NAME.get('control.prefix'), prefix)
      if (verdict.ok) {
        this.values['control.prefix'] = verdict.value
        this.overrides['control.prefix'] = 'env'
      }
    }
    // The panel checkbox that decides whether the process joins at all.
    const join = env.ZINC_JOIN_ON_START ?? env.CONTROL_JOIN_ON_START
    if (join !== undefined && String(join).trim() !== '') {
      const verdict = validateValue(BY_NAME.get('connection.joinOnStart'), join)
      if (verdict.ok) {
        this.values['connection.joinOnStart'] = verdict.value
        this.overrides['connection.joinOnStart'] = 'env'
      }
    }
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
      if (!def) { this.log('warn', `runtime config: ignoring unknown saved parameter "${name}"`); continue }
      const verdict = validateValue(def, value)
      if (!verdict.ok) { this.log('warn', `runtime config: saved value for ${name} is invalid (${verdict.error}) — keeping the default`); continue }
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
      fs.renameSync(tmp, this.file) // atomic: a crash mid-write cannot truncate the store
      return true
    } catch (err) {
      this.log('warn', `runtime config: could not save (${err.message || err}) — the change is live for this process only`)
      return false
    }
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Accept either `(level, msg) => void` or an `{ info, warn, error }` logger.
 * Both exist in this codebase; a control module should not care which.
 */
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
    // Accept "uuid:Name" so an operator entry can carry its display name; only
    // the UUID half is ever compared.
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
