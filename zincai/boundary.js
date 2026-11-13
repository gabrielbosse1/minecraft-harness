/**
 * boundary.js — the one place every physical Minecraft action is allowed or
 * refused, regardless of which subsystem asked for it.
 *
 * WHY THIS EXISTS
 *   Before this module, a physical act could enter the bot through at least six
 *   independent doors:
 *
 *     1. the action lane          executeAction() → skills / builder / combat
 *     2. background jobs          JobRegistry → startMain / startSide
 *     3. survival reflexes        System1: flee keys, eat (equip+consume), MLG
 *                                 water bucket, elytra deploy
 *     4. the pathfinder wrapper   scaffolding/digging/wind-charge helpers that
 *                                 press keys and place blocks directly
 *     5. combat                   AdvancedCombat swings through the arbiter lane
 *     6. redstone / scripts       RedstoneEngineer, run_script, scripts/*
 *
 *   A pause, a permission or an area limit that is enforced in only some of
 *   those places is not a control. So THIS module is a single gate, and every
 *   one of the six routes calls it:
 *
 *     - `check()`   — may this tool (or this raw act) run right now? Called by
 *                     executeAction, startMain, startSide, skills, builder,
 *                     combat, redstone, scripts.
 *     - `net()`     — a raw network-level primitive on the live bot
 *                     (setControlState, dig, placeBlock, activateItem, attack,
 *                     equip, consume, toss, activateBlock). Even code that
 *                     forgets to ask is stopped by the guard.
 *
 *   There is no standing exception for any subsystem. A permission the
 *   operator switched off is off for the survival reflex, for a background
 *   build and for a script alike; the difference is only in who hears about it.
 *
 *   Decisions are deny-by-default for a missing subsystem and recorded in
 *   `log` so `status` can say why the body is not moving.
 *
 *   It holds NO world state of its own beyond a recent-action counter: the
 *   pause flag, the permissions, the boundary and the limits live in the
 *   RuntimeConfig + ControlState this gate reads through small accessors.
 */
'use strict'

const { EventEmitter } = require('events')
const { TOOL_LANES, LANES } = require('./lanes')
const { asLogger } = require('./runtime_config')

/**
 * What category of physical capability does a tool need?
 *
 * A tool may need several (`place` needs movement to reach the spot), so the
 * value is a list. Every entry must be permitted.
 */
const TOOL_CAPS = Object.freeze({
  // movement
  go_to: ['move'],
  dig: ['move', 'dig'],
  gather: ['move', 'dig'],
  follow: ['move'],
  corpse_run: ['move'],
  go_home: ['move'],
  // building
  build: ['move', 'place'],
  build_shape: ['move', 'place'],
  place: ['move', 'place'],
  shelter: ['move', 'place', 'dig'],
  light_up: ['move', 'place', 'use'],
  // fighting
  attack: ['attack', 'move'],
  // containers & interaction
  take: ['container', 'move'],
  put: ['container', 'move'],
  look_in: ['container', 'move'],
  smelt: ['container', 'move', 'use'],
  use_block: ['use', 'move'],
  sleep: ['use', 'move'],
  give: ['move', 'toss'],
  equip: ['equip'],
  eat: ['eat'],
  craft: ['craft', 'move'],
  run_script: ['script'],
  redstone_engineer: ['place', 'dig', 'use', 'move']
})

/** Capability → RuntimeConfig parameter. */
const CAP_PARAM = Object.freeze({
  move: 'actions.allowMovement',
  dig: 'actions.allowDig',
  place: 'actions.allowPlace',
  attack: 'actions.allowAttack',
  container: 'actions.allowContainers',
  use: 'actions.allowUse',
  equip: 'actions.allowEquip',
  eat: 'actions.allowEat',
  toss: 'actions.allowToss',
  craft: 'actions.allowCraft',
  script: 'actions.allowScripts'
})

/** Default capabilities implied by a raw primitive (control.js KEYS + bot methods). */
const NET_CAPS = Object.freeze({
  setControlState: ['move'],
  clearControlStates: [],
  setGoal: ['move'],
  dig: ['dig', 'move'],
  placeBlock: ['place', 'move'],
  equip: ['equip'],
  unequip: ['equip'],
  consume: ['eat'],
  toss: ['toss', 'move'],
  tossStack: ['toss', 'move'],
  craft: ['craft'],
  activateItem: ['use', 'move'],
  activateBlock: ['use', 'move'],
  attack: ['attack', 'move'],
  swingArm: [],
  look: [],
  lookAt: [],
  chat: [],
  whisper: [],
  openContainer: ['container', 'move'],
  openFurnace: ['container', 'move'],
  respawn: [],
  elytraFly: ['move'],
  setQuickBarSlot: []
})

/** Reasons that are about the person asking to see them — never the raw internals. */
const REASON_TEXT = Object.freeze({
  paused: 'the body is paused by an operator (resume to continue)',
  disconnected: 'not connected to the server',
  dying: 'dead; waiting for respawn',
  busy: 'the body is busy with another physical action',
  rate: 'physical action limit reached for this minute',
  boundary: 'that is outside the permitted area',
  boundary_unknown: 'position unknown, so the permitted area cannot be checked',
  emergency: 'an emergency reflex is driving the body'
})

class PhysicalBoundary extends EventEmitter {
  /**
   * @param {{
   *   config: import('./runtime_config').RuntimeConfig,
   *   state?: object,               // ControlState (paused / connection / death)
   *   logger?: (level:string, msg:string) => void,
   *   now?: () => number,
   *   getPosition?: () => {x:number,y:number,z:number}|null,
   *   getDimension?: () => string,
   *   isPhysicalBusy?: () => boolean,
   *   isEmergency?: () => boolean
   * }} opts
   */
  constructor ({ config, state = null, logger = () => {}, now = () => Date.now(), getPosition = null, getDimension = null, isPhysicalBusy = null, isEmergency = null } = {}) {
    super()
    this.config = config
    this.state = state
    this.log = asLogger(logger)
    this.now = now
    this.getPosition = getPosition
    this.getDimension = getDimension
    this.isPhysicalBusy = isPhysicalBusy || (() => false)
    this.isEmergency = isEmergency || (() => false)
    /** Recent physical action timestamps (sliding window for the rate limit). */
    this.recent = []
    this.refused = 0
    this.allowed = 0
    /** Last few refusals, for `status` and the prompts. */
    this.lastRefusals = []
    /** Per-act capability list: actId → caps, so `status` can say what was authorised. */
    this._actCaps = new Map()
  }

  // ----------------------------------------------------------- decisions --

  /**
   * May `tool` run now?
   * @param {string} tool tool name, `script <name>`, or a raw primitive name
   * @param {{ actId?: string, action?: object, caps?: string[], strict?: boolean }} [opts]
   * @returns {{ ok:boolean, why?:string, caps:string[], detail?:string }}
   */
  check (tool, { actId = null, action = null, caps = null, strict = false } = {}) {
    const needed = caps || capsForTool(tool)
    const refusal = this._refusal(needed, { tool, strict })
    if (refusal) {
      this._deny(tool, refusal, { actId })
      return { ok: false, why: refusal, caps: needed }
    }
    if (actId) this._actCaps.set(actId, new Set(needed))
    // A permitted physical act counts against the sliding window here, once
    // per act — not once per packet, which would make the ceiling meaningless.
    if (needed.length) this._count()
    return { ok: true, caps: needed }
  }

  /**
   * Gate for a raw network primitive (used by the wrapped bot).
   * Never records a refusal into the sliding window and never counts as a
   * "physical action" — only a permitted actuation does.
   */
  net (primitive, { scoped = null } = {}) {
    const needed = NET_CAPS[primitive] || []
    const refusal = this._refusal(needed, { tool: primitive, primitive: true })
    if (refusal) { this._deny(primitive, refusal, {}); return { ok: false, why: refusal } }
    return { ok: true }
  }

  /** Was this act already authorised, and did it need the given capability? */
  actCaps (actId) {
    const caps = actId ? this._actCaps.get(actId) : null
    return caps || null
  }

  consumeAct (actId) {
    if (actId) this._actCaps.delete(actId)
  }

  /**
   * The area check for one position. Returns null when the act is allowed.
   * A pending join (position unknown) is NOT treated as "outside": the wrapper
   * would otherwise refuse the very first movement after a reconnect.
   */
  areaRefusal (pos = null, dim = null) {
    if (!this.config.get('boundary.enabled')) return null
    const p = pos || (this.getPosition ? this.getPosition() : null)
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null
    const wanted = String(this.config.get('boundary.dimension') || 'overworld')
    const here = String(dim || (this.getDimension ? this.getDimension() : wanted) || 'overworld').replace(/^minecraft:/, '')
    if (here !== wanted) {
      return this.config.get('boundary.blockOutside')
        ? `boundary: this is the ${here}, and permission to act applies to the ${wanted}`
        : null
    }
    const cx = Number(this.config.get('boundary.centerX'))
    const cz = Number(this.config.get('boundary.centerZ'))
    const r = Number(this.config.get('boundary.radius'))
    const distance = Math.hypot(p.x - cx, p.z - cz)
    if (distance > r) {
      return this.config.get('boundary.blockOutside')
        ? `boundary: ${Math.round(distance)} blocks from the centre of the permitted area (radius ${r})`
        : null
    }
    return null
  }

  /**
   * Is a DESTINATION inside the permitted area? A walk, a dig or a build whose
   * target lies outside it is refused before anything starts — checking only
   * where the body stands would let it walk out one step at a time.
   * @param {{x?:number,z?:number}|null} target
   */
  destinationRefusal (target = null) {
    if (!target) return null
    const x = Number(target.x)
    const z = Number(target.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    return this.areaRefusal({ x, y: Number(target.y) || 0, z })
  }

  /** Does a target position (e.g. a build origin) fall inside the permitted area? */
  targetRefusal (target = null) {
    if (!target || !this.config.get('boundary.enabled')) return null
    return this.areaRefusal(target)
  }

  // ------------------------------------------------------------ internals --

  _refusal (needed, { tool = '', strict = false, primitive = false } = {}) {
    if (!needed || !needed.length) return null
    // 1. The pause / connection / death gate comes first: none of the other
    //    checks matter when no physical action may happen at all.
    const state = this.state
    if (state) {
      const hard = typeof state.physicalRefusal === 'function'
        ? state.physicalRefusal()
        : (state.isPaused?.() ? 'paused' : (state.connectionRefusal?.() || (state.isDead?.() ? 'dying' : null)))
      if (hard) return hard
    }
    // 2. Per-capability permissions. No subsystem has a standing exception:
    //    a permission the operator switched off is off for the survival reflex,
    //    a background build and a script alike.
    for (const cap of needed) {
      const param = CAP_PARAM[cap]
      if (!param) continue // unknown capability: nothing to enforce
      if (this.config.get(param) === false) return `refused: ${param} is off`
    }
    // 3. The permitted area.
    if (needed.some((c) => c === 'move' || c === 'dig' || c === 'place')) {
      const area = this.areaRefusal()
      if (area) return area
    }
    // 4. The sliding-window ceiling. Not applied to a primitive: one tool call
    //    legitimately becomes many packets (a build is hundreds of blocks) and
    //    counting packets would make the limit meaningless.
    if (!primitive) {
      const perMinute = Number(this.config.get('limits.maxPhysicalActionsPerMinute'))
      if (perMinute > 0) {
        const cutoff = this.now() - 60_000
        this.recent = this.recent.filter((t) => t >= cutoff)
        if (this.recent.length >= perMinute) return REASON_TEXT.rate
      }
    }
    return null
  }

  _count () {
    this.recent.push(this.now())
    if (this.recent.length > 2_000) this.recent.splice(0, this.recent.length - 1_000)
  }

  _deny (what, why, { actId = null } = {}) {
    this.refused++
    const entry = { at: this.now(), what: String(what || '?').slice(0, 60), why: String(why || '').slice(0, 120), actId }
    this.lastRefusals.push(entry)
    if (this.lastRefusals.length > 12) this.lastRefusals.shift()
    this.emit('refused', entry)
    return entry
  }

  /** Note that a permitted physical action started (for the rate window). */
  noteAction (what = 'action') {
    this.allowed++
    this._count()
    this.emit('action', { what: String(what).slice(0, 60), at: this.now() })
  }

  /** A compact view for `status` and the prompts. */
  snapshot () {
    const cutoff = this.now() - 60_000
    const recent = this.recent.filter((t) => t >= cutoff)
    return {
      paused: Boolean(this.state?.isPaused?.()),
      connection: this.state?.connection?.() || 'CONNECTED',
      dead: Boolean(this.state?.isDead?.()),
      physicalBusy: Boolean(this.isPhysicalBusy()),
      emergency: Boolean(this.isEmergency?.()),
      allowed: this.allowed,
      refused: this.refused,
      actionsLastMinute: recent.length,
      maxActionsPerMinute: Number(this.config.get('limits.maxPhysicalActionsPerMinute')),
      boundary: this.config.get('boundary.enabled')
        ? {
            center: [Number(this.config.get('boundary.centerX')), Number(this.config.get('boundary.centerZ'))],
            radius: Number(this.config.get('boundary.radius')),
            dimension: this.config.get('boundary.dimension')
          }
        : null,
      lastRefusals: this.lastRefusals.slice(-4)
    }
  }
}

/** Capability list for a tool name (never throws; unknown = conservative). */
function capsForTool (tool) {
  const raw = String(tool || '').trim()
  if (!raw) return []
  if (raw.startsWith('script')) return TOOL_CAPS.run_script.slice()
  const head = raw.split(' ')[0]
  if (TOOL_CAPS[head]) return TOOL_CAPS[head].slice()
  // An unknown tool that the scheduler would put on the BODY lane is assumed to
  // be able to move and to change the world: conservative by default.
  if (TOOL_LANES[head] === LANES.BODY) return ['move', 'dig', 'place']
  if (TOOL_LANES[head]) return [] // read-only / computation / interaction
  // Unknown tool: the scheduler puts it on the BODY lane (laneOf defaults to it),
  // so assume the same capabilities the body lane implies.
  return ['move', 'dig', 'place']
}

/**
 * Install the network-level barrier on a live bot.
 *
 * Every physical primitive Mineflayer exposes is wrapped so it is checked
 * against the boundary at the moment it would hit the wire. This is what turns
 * the boundary from "most callers ask" into "no caller can bypass it": a
 * reflex, a background builder or a script that forgot to call check() is still
 * stopped here.
 *
 * Releasing control is never blocked — setControlState(key, false),
 * clearControlStates(), setGoal(null), stop() and deactivateItem() always work,
 * because a pause that cannot let go of the keys is worse than no pause.
 *
 * Idempotent per bot: installPhysicalGuard(bot) twice is a no-op, and a new bot
 * (a reconnect) gets its own installation.
 *
 * @param {object} bot mineflayer bot
 * @param {PhysicalBoundary} boundary
 * @param {{ logger?: (level:string,msg:string)=>void, onRefused?: Function }} [opts]
 * @returns {{ uninstall: Function, refused: number }}
 */
function installPhysicalGuard (bot, boundary, { logger = () => {}, onRefused = null } = {}) {
  if (!bot) return { uninstall: () => {}, refused: 0 }
  const log = asLogger(logger)
  if (bot.__zincaiPhysicalGuard) return bot.__zincaiPhysicalGuard
  const originals = new Map()
  const state = { refused: 0, uninstall }

  const gate = (obj, name, optional = null) => {
    const original = obj?.[name]
    if (typeof original !== 'function') return false
    originals.set(`${name}`, { obj, name, original })
    const wrapped = function (...args) {
      if (optional && optional(...args)) return original.apply(this, args) // a release
      const verdict = boundary.net(name)
      if (!verdict.ok) {
        state.refused++
        log('debug', `physical guard refused ${name}: ${verdict.why}`)
        try { onRefused?.({ primitive: name, why: verdict.why }) } catch { /* observer must not throw */ }
        return refuseValue(name)
      }
      return original.apply(this, args)
    }
    obj[name] = wrapped
    return true
  }

  // Movement and control-state writes; releasing a key is always allowed.
  gate(bot, 'setControlState', (key, value) => value === false)
  gate(bot, 'clearControlStates', () => true)
  // World mutation.
  gate(bot, 'dig')
  gate(bot, 'placeBlock')
  gate(bot, 'activateItem')
  gate(bot, 'activateBlock')
  gate(bot, 'attack')
  gate(bot, 'equip')
  gate(bot, 'unequip')
  gate(bot, 'consume')
  gate(bot, 'toss')
  gate(bot, 'tossStack')
  gate(bot, 'craft')
  gate(bot, 'openContainer')
  gate(bot, 'openFurnace')
  gate(bot, 'elytraFly')
  // Pathfinder: dropping a goal releases the body, setting one drives it.
  if (bot.pathfinder) {
    gate(bot.pathfinder, 'setGoal', (goal) => goal === null || goal === undefined)
    gate(bot.pathfinder, 'goto')
    gate(bot.pathfinder, 'stop', () => true)
  }

  function uninstall () {
    for (const { obj, name, original } of originals.values()) {
      try { obj[name] = original } catch { /* already replaced */ }
    }
    originals.clear()
    delete bot.__zincaiPhysicalGuard
  }

  bot.__zincaiPhysicalGuard = state
  log('info', `physical boundary installed — ${originals.size} primitives gated`)
  return state
}

/** A refused primitive resolves like a no-op, so `await` callers do not throw. */
function refuseValue (primitive) {
  if (primitive === 'openContainer' || primitive === 'openFurnace') {
    return Promise.reject(Object.assign(new Error('refused: containers are not permitted'), { refused: true, boundary: true }))
  }
  if (PROMISE_PRIMITIVES.has(primitive)) return Promise.resolve(undefined)
  return undefined
}

const PROMISE_PRIMITIVES = new Set([
  'dig', 'placeBlock', 'equip', 'unequip', 'consume', 'toss', 'tossStack',
  'craft', 'activateBlock', 'elytraFly', 'goto', 'attack'
])

module.exports = {
  PhysicalBoundary,
  installPhysicalGuard,
  capsForTool,
  TOOL_CAPS,
  NET_CAPS,
  CAP_PARAM,
  REASON_TEXT
}
