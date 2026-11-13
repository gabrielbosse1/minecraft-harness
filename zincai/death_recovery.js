/**
 * death_recovery.js — death is an event in the bot's life, not a process
 * failure.
 *
 * WHAT WENT WRONG BEFORE
 *   The death handler did the important memory work (suspend every open goal,
 *   save it, drop the agenda, cancel the body) and then `bot.respawn()` after a
 *   fixed 1.5 s. Two things were missing:
 *
 *     1. nothing inspected where the body actually came back, so a spawn in the
 *        nether or 3000 blocks away was silently treated as "same place";
 *     2. nothing decided whether going home was possible. A return route that
 *        is blocked (a wall, a locked door, a different dimension, a permitted
 *        area that excludes the spawn) used to become an endless "no path"
 *        loop — the bot walking at a wall until the goal watchdog gave up.
 *
 * WHAT THIS MODULE DECIDES
 *   After the respawn we know: the new position, the dimension, the health, the
 *   inventory and where the designated room is. From that we can say, once:
 *
 *     - go home       the room is in this dimension, inside the permitted area,
 *                     and a route exists → hand a single walk to the ordinary
 *                     task lane (so it is a normal goal, cancellable, visible).
 *     - report        the room is unreachable, in another dimension, or outside
 *                     the boundary → say so, do not walk, do not repeat.
 *     - nothing        no home configured, or return-on-death is off.
 *
 *   `checkRoute` and `verify` are injected: this module does no world I/O, so
 *   it is testable without mineflayer and reusable by the control layer.
 *
 * No mineflayer, no LLM, no timers.
 */
'use strict'

const { asLogger } = require('./runtime_config')

const clean = (text, max = 200) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const normDim = (d) => String(d ?? '').replace(/^minecraft:/, '') || 'overworld'

class DeathRecovery {
  /**
   * @param {{
   *   config: import('./runtime_config').RuntimeConfig,
   *   logger?: (level:string,msg:string)=>void,
   *   now?: () => number,
   *   getPosition: () => {x:number,y:number,z:number}|null,
   *   getDimension: () => string,
   *   getHealth?: () => number,
   *   getInventory?: () => Array<{name:string,count:number}>,
   *   checkRoute?: (from:object, to:object, dim:string) => Promise<{ok:boolean, why?:string}>|{ok:boolean,why?:string}
   * }} opts
   */
  constructor ({ config, logger = () => {}, now = () => Date.now(), getPosition, getDimension, getHealth = () => null, getInventory = () => [], checkRoute = null } = {}) {
    this.config = config
    this.log = asLogger(logger)
    this.now = now
    this.getPosition = getPosition
    this.getDimension = getDimension
    this.getHealth = getHealth
    this.getInventory = getInventory
    this.checkRoute = checkRoute

    this.deaths = 0
    this.lastDeath = null // { at, position, dimension, inventory }
    this.pending = null // { since, attempt, reported } while dead and waiting
    this.lastRecovery = null // { at, verdict, why, target }
  }

  /** Home target from the boundary group, or null when it is not configured. */
  home () {
    if (this.config.get('boundary.enabled') !== true) return null
    return {
      x: Number(this.config.get('boundary.homeX')),
      y: Number(this.config.get('boundary.homeY')),
      z: Number(this.config.get('boundary.homeZ')),
      dimension: normDim(this.config.get('boundary.homeDimension'))
    }
  }

  /** Delay before asking the server to respawn. */
  respawnDelayMs () { return Math.max(0, Number(this.config.get('death.respawnDelayMs')) || 0) }

  /**
   * The death event. Records the loss; the caller is responsible for stopping
   * the body (skills/executor cancel) and suspending goals — both already exist
   * in the session and are reused.
   */
  onDeath ({ position = null, dimension = null, inventory = null } = {}) {
    const pos = position || (this.getPosition ? this.getPosition() : null)
    const dim = normDim(dimension || (this.getDimension ? this.getDimension() : 'overworld'))
    const items = Array.isArray(inventory) ? inventory : this.getInventory()
    this.deaths++
    this.lastDeath = {
      at: this.now(),
      position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
      dimension: dim,
      // What the body had, so the model can reason about the corpse run without
      // pretending the inventory survived.
      inventory: (items || []).map((i) => ({ name: String(i.name || '?'), count: Number(i.count) || 1 })).slice(0, 36)
    }
    this.pending = { since: this.now(), attempt: 0, reported: false }
    this.log('warn', `died at ${this.lastDeath.position ? `${this.lastDeath.position.x},${this.lastDeath.position.y},${this.lastDeath.position.z}` : 'unknown'} in the ${dim}`)
    return this.lastDeath
  }

  /**
   * The respawn event. Inspect the ACTUAL new state (never the pre-death one)
   * and decide, once, what to do about the designated room.
   *
   * @param {{ position?:object, dimension?:string, health?:number, inventory?:Array,
   *           canWalk?: boolean }} [observation]
   * @returns {Promise<{ verdict:'go_home'|'report'|'nothing', why:string, target?:object,
   *                     observation:object, problems:string[] }>}
   */
  async onRespawn (observation = {}) {
    const pos = observation.position || (this.getPosition ? this.getPosition() : null)
    const dim = normDim(observation.dimension || (this.getDimension ? this.getDimension() : 'overworld'))
    const health = observation.health ?? (this.getHealth ? this.getHealth() : null)
    const inventory = observation.inventory || (this.getInventory ? this.getInventory() : [])
    const snapshot = {
      position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
      dimension: dim,
      health,
      slotsUsed: Array.isArray(inventory) ? inventory.length : 0
    }
    const problems = []
    if (!snapshot.position) problems.push('the respawn position is not known yet')

    if (!this.config.get('boundary.enabled')) {
      this.pending = null
      return this._record({ verdict: 'nothing', why: 'no permitted area is configured, so there is nowhere to return to', observation: snapshot, problems })
    }
    if (!this.config.get('boundary.returnHomeOnDeath')) {
      this.pending = null
      return this._record({ verdict: 'nothing', why: 'returning home after death is off (boundary.returnHomeOnDeath)', observation: snapshot, problems })
    }
    const home = this.home()
    if (!home) {
      this.pending = null
      return this._record({ verdict: 'nothing', why: 'no designated room is configured', observation: snapshot, problems })
    }
    // 1. The room is in another dimension: a walk cannot cross it. Say so once.
    if (snapshot.dimension !== home.dimension) {
      this.pending = null
      return this._record({
        verdict: 'report',
        why: `respawned in the ${snapshot.dimension}, and the designated room is in the ${home.dimension} — no walking route across dimensions`,
        target: home,
        observation: snapshot,
        problems
      })
    }
    // 2. The room is outside the permitted area: walking there would fight the
    //    boundary, so it is reported, not attempted.
    const centre = { x: Number(this.config.get('boundary.centerX')), z: Number(this.config.get('boundary.centerZ')) }
    const radius = Number(this.config.get('boundary.radius'))
    if (Math.hypot(home.x - centre.x, home.z - centre.z) > radius) {
      this.pending = null
      return this._record({
        verdict: 'report',
        why: `the designated room at ${home.x},${home.z} is outside the permitted area (radius ${radius} around ${centre.x},${centre.z})`,
        target: home,
        observation: snapshot,
        problems
      })
    }
    // 3. Already there.
    if (snapshot.position && Math.hypot(snapshot.position.x - home.x, snapshot.position.z - home.z) <= 3 && Math.abs(snapshot.position.y - home.y) <= 4) {
      this.pending = null
      return this._record({ verdict: 'nothing', why: 'already at the designated room', target: home, observation: snapshot, problems })
    }
    // 4. Is there a route? One check, then a single decision — never a loop.
    if (observation.canWalk === false) {
      this.pending = null
      return this._record({
        verdict: 'report',
        why: 'the body is not able to walk right now (permissions or connection), so the route home was not attempted',
        target: home,
        observation: snapshot,
        problems
      })
    }
    if (this.checkRoute && snapshot.position) {
      let route = null
      try {
        route = await this.checkRoute(snapshot.position, home, snapshot.dimension)
      } catch (err) {
        route = { ok: false, why: String(err?.message || err).slice(0, 120) }
      }
      if (route && route.ok === false) {
        this.pending = null
        return this._record({
          verdict: 'report',
          why: `the route back to the designated room is blocked (${clean(route.why || 'no path', 100)}) — not walking into it repeatedly`,
          target: home,
          observation: snapshot,
          problems
        })
      }
    }
    this.pending = null
    return this._record({
      verdict: 'go_home',
      why: `heading back to the designated room at ${home.x},${home.y},${home.z} in the ${home.dimension}`,
      target: home,
      observation: snapshot,
      problems
    })
  }

  _record (result) {
    this.lastRecovery = { at: this.now(), verdict: result.verdict, why: result.why, target: result.target || null }
    if (result.verdict === 'report') this.log('warn', `death recovery: ${result.why}`)
    else if (result.verdict === 'go_home') this.log('info', `death recovery: ${result.why}`)
    return result
  }

  /** A compact view for `status`. */
  snapshot () {
    return {
      deaths: this.deaths,
      lastDeath: this.lastDeath,
      dead: Boolean(this.pending),
      lastRecovery: this.lastRecovery,
      home: this.home(),
      returnHomeOnDeath: this.config.get('boundary.returnHomeOnDeath') === true
    }
  }
}

/**
 * The reconciliation summary after a respawn, in one line the model can read:
 * what changed between the life that ended and the one that started.
 */
function respawnSummary (death, observation = {}) {
  const parts = []
  const pos = observation.position
  if (pos) parts.push(`respawned at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
  const dim = observation.dimension
  if (dim) parts.push(`in the ${normDim(dim)}`)
  if (Number.isFinite(observation.health)) parts.push(`health ${observation.health}`)
  const items = Array.isArray(observation.inventory) ? observation.inventory.length : null
  if (items !== null) parts.push(items ? `${items} inventory slot(s) carried` : 'empty inventory — the items are at the death site')
  if (death?.position) parts.push(`died at ${death.position.x},${death.position.y},${death.position.z}`)
  return parts.join('; ')
}

module.exports = { DeathRecovery, respawnSummary, normDim }
