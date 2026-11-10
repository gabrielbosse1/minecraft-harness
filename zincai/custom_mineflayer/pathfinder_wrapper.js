/**
 * custom_mineflayer/pathfinder_wrapper.js — upstream-compatible custom pathfinding.
 *
 * Hard rule: we NEVER touch node_modules/mineflayer(-pathfinder).
 * Everything here is either
 *   (a) prototype-level monkey-patching guarded by an idempotence marker, or
 *   (b) extension through official extension points (instance flags, sets,
 *       and exclusion-area hooks), or
 *   (c) behavior implemented in bot-level ticks (open → pass → close).
 *
 * So `npm update mineflayer` / `npm update mineflayer-pathfinder` can pull
 * upstream fixes without breaking this file — as long as the documented hooks
 * still exist. Every patch fails SOFT (logs a warning) instead of crashing
 * the process when upstream shifts underneath us.
 *
 * Implements:
 *   1. Door/trapdoor sub-routine: route through doors (useOne "open" step),
 *      track the door the bot opened, CLOSE it once the bot has passed.
 *      Never breaks doors; iron doors are treated as solid.
 *   2. Settable digging: config.allowDigging=false => pathfinder treats
 *      every block as unbreakable (canDig=false + safeToBreak()=>false).
 *   3. Door cost override: routing through a door costs `doorCost` (default
 *      4) extra — the bot prefers going around when reasonably short.
 *   4. Human movement mimicry: ±2° yaw/pitch micro-jitter, variable
 *      sprint/walk cycles (never 100% sprint), forced walk near hazards,
 *      and 200–800ms idle pauses when the heading changes abruptly.
 */
'use strict'

const PATCH_MARK = Symbol.for('zincai.pathfinder.patched')
const DEG = Math.PI / 180

const isDoorOrTrapdoorName = (name) => (/_door$/i.test(name) || /_trapdoor$/i.test(name)) && !/iron/i.test(name)

class PathfinderWrapper {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ allowDigging?: boolean, doorCost?: number, jitterDegrees?: number, logger?: (level:string,msg:string)=>void }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.allowDigging = opts.allowDigging !== undefined ? Boolean(opts.allowDigging) : false
    this.doorCost = Number.isFinite(opts.doorCost) ? opts.doorCost : 4
    this.jitterRad = ((opts.jitterDegrees ?? 2) * DEG)
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {}
    this._pendingClose = null // { position: Vec3-like, openedAt: number }
    this._jitterTimer = null
    this._sprintTimer = null
    this._sprintWalkPhase = 'sprint'
    this._lastHeading = null
    this._pauseUntil = 0
    this._applied = []
    this._tickHandlers = [] // physicsTick listeners we own — removed in stop()

    // --- v2: movement modes -----------------------------------------------
    // 'explorer' (default, balanced) | 'builder' (steady, no sprint, cautious
    // drops) | 'hunter' (always sprint-jump parkour). Flee-reflex is always on.
    this.mode = 'explorer'
    this.fleeRadius = Number.isFinite(opts.fleeRadius) ? opts.fleeRadius : 8
    this._fleeUntil = 0
    this._lastFleeCheck = 0
    this._jumpSprintTimer = null
  }

  /** Modes: 'builder' | 'hunter' | 'explorer' */
  setMode (mode) {
    this.mode = ['builder', 'hunter', 'explorer'].includes(mode) ? mode : 'explorer'
    const m = this._movements()
    if (m) {
      if (this.mode === 'builder') { m.allowSprinting = false; m.maxDropDown = 1 }
      else if (this.mode === 'hunter') { m.allowSprinting = true; m.maxDropDown = 4 }
      else { m.allowSprinting = true; m.maxDropDown = 4 }
    }
    // Hunter: rhythmic jump pulses while sprinting — parkour over 1-block gaps.
    clearInterval(this._jumpSprintTimer)
    this._jumpSprintTimer = null
    if (this.mode === 'hunter') {
      this._jumpSprintTimer = setInterval(() => {
        const bot = this.bot
        if (!bot.entity?.onGround) return
        if (bot.pathfinder?.isMoving?.()) {
          bot.setControlState('jump', true)
          setTimeout(() => { try { bot.setControlState('jump', false) } catch { /* noop */ } }, 180)
        }
      }, 550)
    }
    return this.mode
  }

  /** Register one of OUR physicsTick handlers (named so stop() can remove it). */
  _onTick (fn) {
    this._tickHandlers.push(fn)
    this.bot.on('physicsTick', fn)
  }

  /** Idempotent prototype patch helper. */
  _patch (target, name, factory) {
    const key = `${name}`
    if (target[PATCH_MARK] && target[PATCH_MARK].has(key)) return // already patched
    const original = target[name]
    if (typeof original !== 'function') {
      this.log('warn', `pathfinder hook ${name} missing — skipping patch`)
      return
    }
    target[name] = factory(original)
    ;(target[PATCH_MARK] || (target[PATCH_MARK] = new Set())).add(key)
    this._applied.push(key)
  }

  /**
   * Apply all patches against THIS bot's loaded pathfinder package.
   * Call AFTER bot.loadPlugin(pathfinder).
   */
  apply () {
    this._patchDigging()
    this._patchDoors()
    this._startHumanizer()
    this._onTick(this._fleeTick.bind(this))
    return this._applied
  }

  // ------------------------------------------------ enemy-flee inversion--
  /**
   * Emergency reflex: nearest hostile closer than fleeRadius => invert the goal
   * and run AWAY at speed, with jumping. <1.5m is treated as melee and left to
   * the combat controller. Never fights the combat system at point-blank;
   * never overrides an active builder task.
   */
  _fleeTick () {
    const bot = this.bot
    const now = Date.now()
    if (!bot.entity || now - this._lastFleeCheck < 400) return
    this._lastFleeCheck = now
    if (this.mode === 'builder') return // builders finish the course first

    let nearest = null
    let nearestDist = Infinity
    for (const e of Object.values(bot.entities || {})) {
      if (!e?.position || e === bot.entity) continue
      if (!/zombie|skeleton|creeper|spider|drowned|husk|witch|blaze|phantom|enderman/i.test(e.name || '')) continue
      const d = e.position.distanceTo(bot.entity.position)
      if (d < nearestDist) { nearestDist = d; nearest = e }
    }
    if (nearest && nearestDist < this.fleeRadius && nearestDist > 1.5) {
      if (now < this._fleeUntil) return
      const away = bot.entity.position.minus(nearest.position)
      away.y = 0
      if (away.norm() < 0.01) away.set(1, 0, 0)
      const target = bot.entity.position.plus(away.normalize().scale(12))
      try {
        const { goals } = require('mineflayer-pathfinder')
        bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 2), true)
        this._fleeUntil = now + 2500
        const m = this._movements()
        if (m) m.allowSprinting = true
        bot.setControlState('sprint', true)
        this.log('info', `fleeing ${nearest.name} (${nearestDist.toFixed(1)}m)`)
      } catch (err) {
        this.log('debug', `flee failed: ${err.message || err}`)
      }
    }
  }

  // ------------------------------------------------------------- digging--
  _patchDigging () {
    if (this.allowDigging) {
      this.log('debug', 'allowDigging=true — pathfinder may break blocks to route')
      return
    }
    // Instance flag first (upstream reads it everywhere).
    const movements = this._movements()
    if (movements) {
      movements.canDig = false
      movements.digCost = 1000 // belt and braces: digging is never "cheap"
    }
    // Prototype-level: even if something sets canDig=true later, breakable
    // blocks still cannot be "safely broken" for moves when digging is off.
    try {
      const { Movements } = require('mineflayer-pathfinder')
      this._patch(Movements.prototype, 'safeToBreak', (orig) => function () {
        if (!this.canDig) return false
        return orig.apply(this, arguments)
      })
    } catch (err) {
      this.log('warn', `digging guard not patched: ${err.message || err}`)
    }
  }

  // -------------------------------------------------------------- doors--
  _patchDoors () {
    const movements = this._movements()
    if (!movements) {
      this.log('warn', 'no Movements instance yet — door routing not applied (create movements first)')
      return
    }
    const registry = this.bot.registry
    let added = 0
    for (const block of registry.blocksArray) {
      if (!isDoorOrTrapdoorName(block.name)) continue
      if (!movements.openable.has(block.id)) {
        movements.openable.add(block.id)
        added++
      }
    }
    // canOpenDoors flips the upstream branch where a move step into the door
    // emits a "useOne" (right-click) instead of blocking. This is the
    // upstream-sanctioned hook for exactly this behavior.
    movements.canOpenDoors = true

    // Door cost override: every candidate step through a door/trapdoor pays
    // `doorCost` extra — detours are preferred when reasonably short.
    const doorIds = new Set()
    for (const block of registry.blocksArray) {
      if (isDoorOrTrapdoorName(block.name)) doorIds.add(block.id)
    }
    const doorCost = this.doorCost
    if (Array.isArray(movements.exclusionAreasStep) && !movements.exclusionAreasStep._zincaiDoorCost) {
      const fn = (block) => (block && doorIds.has(block.type) ? doorCost : 0)
      fn._zincaiDoorCost = true
      movements.exclusionAreasStep.push(fn)
    }
    this.log('info', `door routing: ${added} door/trapdoor ids registered, doorCost=${this.doorCost}, canOpenDoors=true`)

    // Open → pass → close tracking on the bot itself.
    this._onTick(this._doorTick.bind(this))
  }

  _doorTick () {
    const bot = this.bot
    if (!bot.entity) return
    const now = Date.now()

    // Detect a door the bot just opened (state flipped to open, adjacent).
    if (!this._pendingClose) {
      const since = now - (this._lastDoorScan || 0)
      if (since < 250) return
      this._lastDoorScan = now
      try {
        const door = this._adjacentOpenDoor()
        if (door) this._pendingClose = { position: door.position, openedAt: now }
      } catch { /* transient */ }
      return
    }
    // Bot passed through (or 9s elapsed): close it again. Never break doors.
    const p = this._pendingClose.position
    const dx = bot.entity.position.x - (p.x + 0.5)
    const dy = bot.entity.position.y - p.y
    const dz = bot.entity.position.z - (p.z + 0.5)
    const dist = Math.hypot(dx, dy, dz)
    if (dist > 1.8 || now - this._pendingClose.openedAt > 9000) {
      const target = bot.blockAt(p)
      if (target && isDoorOrTrapdoorName(target.name) && target.getProperties?.().open) {
        this.bot.activateBlock(target).catch((err) => this.log('debug', `door close failed: ${err.message || err}`))
      }
      this._pendingClose = null
    }
  }

  _adjacentOpenDoor () {
    const bot = this.bot
    const pos = bot.entity.position.floored()
    for (let dy = -1; dy <= 1; dy++) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const block = bot.blockAt(pos.offset(dx, dy, dz))
        if (block && isDoorOrTrapdoorName(block.name)) {
          const props = block.getProperties?.() || {}
          if (props.open === true || props.open === 'true') return block
        }
      }
    }
    return null
  }

  /**
   * Jump-place pillar to at least targetY (integer feet height).
   * Consumes scaffold blocks from inventory. Returns true on success.
   * @param {number} targetY
   * @param {string[]} scaffoldBlocks
   */
  async pillarToHeight (targetY, scaffoldBlocks = ['dirt', 'cobblestone', 'netherrack']) {
    const bot = this.bot
    const { Vec3 } = require('vec3')
    let guard = 0
    while (guard++ < 40) {
      const feetY = Math.floor(bot.entity?.position?.y ?? 0)
      if (feetY >= targetY) return true
      const scaffold = bot.inventory.items().find((i) => scaffoldBlocks.includes(i.name))
      if (!scaffold) { this.log('warn', 'pillar: out of scaffold blocks'); return false }
      await bot.equip(scaffold, 'hand').catch(() => {})
      bot.setControlState('jump', true)
      await new Promise((r) => setTimeout(r, 120))
      try {
        const refBlock = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
        if (refBlock) await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
      } catch (err) {
        this.log('debug', `pillar place failed: ${err.message || err}`)
      }
      bot.setControlState('jump', false)
      await new Promise((r) => setTimeout(r, 180))
    }
    return false
  }

  _movements () {
    return this.bot.pathfinder?.movements || null
  }

  // ------------------------------------------------- human movement mimic--
  _startHumanizer () {
    const bot = this.bot

    // ±2° micro-jitter on a randomized cadence — never on a fixed metronome.
    const jitter = () => {
      this._jitterTimer = setTimeout(jitter, 400 + Math.random() * 700)
      if (Date.now() < this._pauseUntil) return
      if (!bot.entity || !bot.pathfinder) return
      if (!bot.pathfinder.isMoving?.() && !bot.pathfinder.goal) return
      const jYaw = (Math.random() * 2 - 1) * this.jitterRad
      const jPitch = (Math.random() * 2 - 1) * this.jitterRad
      bot.look(bot.entity.yaw + jYaw, bot.entity.pitch + jPitch, true).catch(() => {})
    }
    jitter()

    // Variable sprint/walk cycles — sprint is a gait, not a default.
    // Danger override: never sprint airborne, in liquid, or next to a drop-off.
    const cycle = () => {
      this._sprintTimer = setTimeout(cycle, this._sprintWalkPhase === 'sprint' ? 900 + Math.random() * 1600 : 400 + Math.random() * 800)
      const movements = this._movements()
      if (!movements) return
      if (this._sprintWalkPhase === 'sprint') {
        this._sprintWalkPhase = 'walk'
      } else {
        this._sprintWalkPhase = 'sprint'
      }
      const hazard = this._nearHazard()
      movements.allowSprinting = this._sprintWalkPhase === 'sprint' && !hazard
    }
    cycle()

    // Idle pause on abrupt heading change while navigating (200–800ms).
    const headingPause = () => {
      if (!bot.entity || !bot.pathfinder) return
      if (!bot.pathfinder.isMoving?.()) { this._lastHeading = null; return }
      const yaw = bot.entity.yaw
      if (this._lastHeading !== null) {
        let d = Math.abs(yaw - this._lastHeading) % (2 * Math.PI)
        if (d > Math.PI) d = 2 * Math.PI - d
        if (d > 1.0 && Date.now() >= this._pauseUntil) {
          this._pauseUntil = Date.now() + 200 + Math.random() * 600
          for (const c of ['forward', 'sprint', 'jump']) bot.setControlState(c, false)
        }
      }
      this._lastHeading = yaw
    }
    this._onTick(headingPause)
  }

  _nearHazard () {
    const bot = this.bot
    try {
      if (!bot.entity.onGround) return true // airborne — do not sprint
      if (bot.entity.isInWater || bot.entity.isInLava) return true
      const pos = bot.entity.position.floored()
      // Drop-off probe: the block directly below the next step is air/lava?
      const ahead = bot.entity.position.floored().offset(
        Math.round(-Math.sin(bot.entity.yaw)),
        0,
        Math.round(Math.cos(bot.entity.yaw))
      )
      const below = bot.blockAt(ahead.offset(0, -1, 0))
      if (!below) return true // edge of loaded world — cautious, not suicidal
      if (below.name === 'air' || below.name === 'cave_air') return true
      if (/lava|fire/.test(below.name)) return true
    } catch { /* transient — assume safe */ }
    return false
  }

  /** Remove OUR timers and physicsTick listeners (called on shutdown). */
  stop () {
    clearTimeout(this._jitterTimer)
    clearTimeout(this._sprintTimer)
    clearInterval(this._jumpSprintTimer)
    this._jumpSprintTimer = null
    for (const fn of this._tickHandlers) {
      try { this.bot.removeListener('physicsTick', fn) } catch { /* bot gone */ }
    }
    this._tickHandlers = []
  }
}

module.exports = { PathfinderWrapper, isDoorOrTrapdoorName }
