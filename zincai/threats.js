/**
 * threats.js — who is actually dangerous right now?
 *
 * Policy (owner's rule): the bot never picks a fight on its own. Its reflex
 * is to FLEE from every real threat and tell the model, which then decides
 * (attack, go somewhere, hold, or keep fleeing). This module answers the one
 * question that reflex needs: *what counts as a real threat?*
 *
 *   - Hostile mobs that can see or reach the bot. A zombie behind iron bars,
 *     in a farm's kill chamber or two floors down is NOT a threat.
 *   - A creeper whose fuse is lit, or primed TNT, close by — always.
 *   - Anything that actually hurt the bot in the last few seconds: a player,
 *     a wolf, an iron golem. Players are never threats before that. Holding a
 *     bow, a mace or a bowl near the bot means nothing.
 *   - Never: armor stands, item frames, pets, name-tagged mobs, villagers.
 *
 * It also explains damage ("fall", "starving", "hit by Gabriel") so the model
 * is not told "I was just attacked" when the bot is merely hungry.
 *
 * No LLM, no network. Works with partial mock bots.
 */
'use strict'

const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'witch',
  'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'piglin_brute',
  'phantom', 'silverfish', 'endermite', 'slime', 'magma_cube', 'blaze', 'ghast',
  'hoglin', 'zoglin', 'guardian', 'elder_guardian', 'warden', 'wither',
  'breeze', 'creaking', 'shulker', 'illusioner'
])

/** Mobs that hurt from a distance: only line of sight matters, at longer range. */
const RANGED_NAMES = new Set([
  'skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch',
  'breeze', 'guardian', 'elder_guardian', 'shulker', 'wither', 'illusioner', 'evoker'
])

/** Things that are entities but not creatures. Never a threat, never a target. */
const DECOR_NAMES = new Set([
  'armor_stand', 'item_frame', 'glow_item_frame', 'painting', 'leash_knot', 'marker',
  'item', 'experience_orb', 'item_display', 'block_display', 'text_display', 'interaction',
  'boat', 'chest_boat', 'minecart', 'chest_minecart', 'hopper_minecart', 'furnace_minecart',
  'tnt_minecart', 'spawner_minecart', 'command_block_minecart', 'end_crystal', 'falling_block',
  'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl', 'eye_of_ender',
  'fishing_bobber', 'firework_rocket', 'area_effect_cloud', 'lightning_bolt', 'potion',
  'experience_bottle', 'llama_spit', 'shulker_bullet', 'fireball', 'small_fireball',
  'dragon_fireball', 'wither_skull', 'wind_charge', 'breeze_wind_charge', 'evoker_fangs'
])

/** Creatures the bot must never be talked into hitting by a loose type match. */
const PROTECTED_NAMES = new Set(['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'allay'])

const TAMABLE_FLAG_4 = new Set(['wolf', 'cat', 'parrot'])
const TAMABLE_FLAG_2 = new Set(['horse', 'donkey', 'mule', 'llama', 'trader_llama', 'skeleton_horse', 'zombie_horse', 'camel'])

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

const lower = (v) => String(v || '').toLowerCase()

/** Compass direction from one point to another (north is -z, east is +x). */
function bearing (from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.hypot(dx, dz) < 0.5) return 'here'
  const deg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360
  return COMPASS[Math.round(deg / 45) % 8]
}

/** "5m NE", "12m S, 3 up". */
function whereIs (from, to) {
  const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const dy = Math.round(to.y - from.y)
  const vert = Math.abs(dy) >= 2 ? `, ${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}` : ''
  return `${Math.round(d)}m ${bearing(from, to)}${vert}`
}

const isPlayer = (e) => Boolean(e) && (e.type === 'player' || lower(e.name) === 'player')
const VEHICLE_RE = /(_boat|_raft|minecart)$/
const isDecor = (e) => !e || DECOR_NAMES.has(lower(e.name)) || VEHICLE_RE.test(lower(e.name))

/** Name-tagged? (entity metadata index 2 = custom name on every modern version) */
function isNamed (e) {
  if (!e || isPlayer(e)) return false
  const raw = e.metadata?.[2]
  if (raw === undefined || raw === null || raw === '') return false
  if (typeof raw === 'object' && raw.value === undefined && Object.keys(raw).length === 0) return false
  return true
}

/** Tamed pet or mount? Best effort from the tame flag; unknown reads as false. */
function isTamed (e) {
  if (!e) return false
  const name = lower(e.name)
  const flags = Number(e.metadata?.[17])
  if (!Number.isFinite(flags)) return false
  if (TAMABLE_FLAG_4.has(name)) return (flags & 0x04) !== 0
  if (TAMABLE_FLAG_2.has(name)) return (flags & 0x02) !== 0
  return false
}

/** Must never be attacked on a type match: decor, pets, named mobs, villagers. */
function isProtected (e) {
  if (!e) return true
  if (isDecor(e)) return true
  if (PROTECTED_NAMES.has(lower(e.name))) return true
  return isNamed(e) || isTamed(e)
}

/** Creeper swelling? (metadata 16 = state, 1 while the fuse burns; 18 = ignited) */
function creeperFuseLit (e) {
  if (!e || lower(e.name) !== 'creeper') return false
  const state = e.metadata?.[16]
  const ignited = e.metadata?.[18]
  return state === 1 || ignited === true || ignited === 1
}

const eyeOf = (e) => ({ x: e.position.x, y: e.position.y + (Number(e.height) || 1.8) * 0.85, z: e.position.z })

/**
 * Cheap line-of-sight test: walk the segment in 0.4-block steps and stop at
 * the first block with a collision box. Bars, fences, glass and doors all
 * count as walls here — the question is "can it get at me", not "can I see
 * its pixels". Unloaded space is treated as open.
 */
function clearLine (bot, from, to, { step = 0.4, maxDist = 32 } = {}) {
  if (!bot?.blockAt || !from || !to) return true
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const dist = Math.hypot(dx, dy, dz)
  if (dist > maxDist) return false
  const n = Math.max(1, Math.ceil(dist / step))
  const p = { x: 0, y: 0, z: 0 }
  let lastKey = ''
  for (let i = 1; i < n; i++) {
    const t = i / n
    p.x = Math.floor(from.x + dx * t)
    p.y = Math.floor(from.y + dy * t)
    p.z = Math.floor(from.z + dz * t)
    const key = `${p.x},${p.y},${p.z}`
    if (key === lastKey) continue
    lastKey = key
    let block = null
    try { block = bot.blockAt(p, false) } catch { block = null }
    if (block && block.boundingBox === 'block') return false
  }
  return true
}

/** Either eye-to-eye or eye-to-feet clear counts as "it has a line on me". */
function hasLineOfSight (bot, entity) {
  const me = bot?.entity
  if (!me?.position || !entity?.position) return false
  const myEye = eyeOf(me)
  if (clearLine(bot, eyeOf(entity), myEye)) return true
  return clearLine(bot, eyeOf(entity), { x: me.position.x, y: me.position.y + 0.3, z: me.position.z })
}

/**
 * Reachability probe built on the real pathfinder: "could a walking mob get
 * from where it stands to me?" — no digging, no placing, no doors. Bounded to
 * a few milliseconds and cached, so a zombie around a corner is noticed while
 * a zombie in a cage is not.
 */
function makeReachabilityCheck (bot, { Movements, goals, budgetMs = 6, cacheMs = 2000, now = () => Date.now() } = {}) {
  if (!Movements || !goals) return () => null
  let movements = null
  const cache = new Map()
  return function reachable (entity) {
    // Checked per call: the pathfinder plugin is injected after createBot().
    if (!bot?.pathfinder?.getPathFromTo) return null
    const me = bot.entity?.position
    if (!me || !entity?.position) return null
    const hit = cache.get(entity.id)
    const t = now()
    if (hit && t - hit.at < cacheMs) return hit.value
    let value = null
    try {
      if (!movements) {
        movements = new Movements(bot)
        movements.canDig = false
        movements.allow1by1towers = false
        movements.allowParkour = false
        movements.canOpenDoors = false
        movements.scafoldingBlocks = []
        movements.allowEntityDetection = false
      }
      const goal = new goals.GoalNear(Math.floor(me.x), Math.floor(me.y), Math.floor(me.z), 1)
      const gen = bot.pathfinder.getPathFromTo(movements, entity.position, goal, {
        timeout: budgetMs, tickTimeout: budgetMs, searchRadius: 24, optimizePath: false, resetEntityIntersects: false
      })
      const first = gen.next().value
      value = first?.result?.status === 'success'
    } catch { value = null }
    cache.set(entity.id, { at: t, value })
    if (cache.size > 128) for (const [id, v] of cache) if (t - v.at > cacheMs) cache.delete(id)
    return value
  }
}

class ThreatSense {
  /**
   * @param {object} bot
   * @param {{ radius?: number, rangedRadius?: number, closeRadius?: number,
   *           attackerMemoryMs?: number, reachable?: (e:object)=>boolean|null,
   *           now?: () => number }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.radius = Number.isFinite(opts.radius) ? opts.radius : 12
    this.rangedRadius = Number.isFinite(opts.rangedRadius) ? opts.rangedRadius : 18
    this.closeRadius = Number.isFinite(opts.closeRadius) ? opts.closeRadius : 8
    this.blastRadius = Number.isFinite(opts.blastRadius) ? opts.blastRadius : 8
    this.attackerMemoryMs = Number.isFinite(opts.attackerMemoryMs) ? opts.attackerMemoryMs : 15_000
    this.reachable = typeof opts.reachable === 'function' ? opts.reachable : () => null
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    /** id -> { at, name, player } for things that actually hurt the bot */
    this.attackers = new Map()
    this.last = { threats: [], ids: new Set(), at: 0 }
    this._fall = { minVy: 0, at: 0 }
    /** id -> time of the last arm swing seen (attribution fallback) */
    this._swings = new Map()
    /**
     * True once the server has sent a damage_event packet (1.19.4+): from then
     * on a hit with no named source really is environmental, and nobody gets
     * blamed for standing nearby and mining.
     */
    this.sourcesNamed = false
  }

  /** Somebody swung an arm. Only used to guess an attacker on servers that never name one. */
  noteSwing (entity) {
    if (!entity || entity === this.bot.entity || entity.id === undefined || entity.id === null) return
    const now = this.now()
    this._swings.set(entity.id, now)
    if (this._swings.size > 64) {
      for (const [id, at] of this._swings) if (now - at > 2000) this._swings.delete(id)
    }
  }

  /** The nearest creature or player that swung at arm's length within the last moment. */
  _recentSwinger ({ withinMs = 900, reach = 6 } = {}) {
    const me = this.bot.entity?.position
    if (!me) return null
    const now = this.now()
    let best = null
    let bestD = Infinity
    for (const [id, at] of this._swings) {
      if (now - at > withinMs) continue
      const e = this.bot.entities?.[id]
      if (!e?.position || e === this.bot.entity || isDecor(e)) continue
      const d = Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z)
      if (d <= reach && d < bestD) { best = e; bestD = d }
    }
    return best
  }

  /** Record who hurt the bot (the `source` mineflayer reports on 1.20+). */
  noteAttacker (source) {
    if (!source || source === this.bot.entity || isDecor(source)) return null
    const name = isPlayer(source) ? (source.username || 'player') : lower(source.name)
    this.attackers.set(source.id, { at: this.now(), name, player: isPlayer(source) })
    return name
  }

  /** The model chose to stop treating someone as hostile (or they logged off). */
  forgive (idOrName) {
    for (const [id, a] of this.attackers) {
      if (id === idOrName || a.name === idOrName) this.attackers.delete(id)
    }
  }

  isRecentAttacker (entity) {
    const a = entity && this.attackers.get(entity.id)
    if (!a) return false
    if (this.now() - a.at > this.attackerMemoryMs) { this.attackers.delete(entity.id); return false }
    return true
  }

  /** Call every physics tick: remembers the fastest recent fall for damage cause. */
  trackMotion () {
    const vy = Number(this.bot.entity?.velocity?.y) || 0
    const t = this.now()
    if (vy < this._fall.minVy || t - this._fall.at > 1500) this._fall = { minVy: Math.min(vy, 0), at: t }
  }

  /**
   * Current real threats, nearest first.
   * @returns {{ threats: Array<object>, ids: Set<number>, at: number }}
   */
  assess () {
    const bot = this.bot
    const me = bot?.entity?.position
    const out = []
    if (!me) { this.last = { threats: out, ids: new Set(), at: this.now() }; return this.last }
    for (const id of Object.keys(bot.entities || {})) {
      const e = bot.entities[id]
      if (!e || !e.position || e === bot.entity) continue
      if (e.isValid === false) continue
      const name = lower(e.name)
      const dx = e.position.x - me.x
      const dy = e.position.y - me.y
      const dz = e.position.z - me.z
      const distance = Math.hypot(dx, dy, dz)
      if (distance > 40) continue

      // Primed TNT: get away, whoever lit it.
      if (name === 'tnt' && distance <= this.blastRadius) {
        out.push(this._entry(e, 'tnt', distance, { kind: 'explosive', hard: true, lit: true, los: true }))
        continue
      }
      if (isDecor(e)) continue

      const attacker = this.isRecentAttacker(e)
      if (isPlayer(e)) {
        // Players are neutral until they actually hit the bot.
        if (attacker && distance <= 24) out.push(this._entry(e, e.username || 'player', distance, { kind: 'player', attacker: true, los: true }))
        continue
      }

      const hostile = HOSTILE_NAMES.has(name)
      if (!hostile && !attacker) continue
      if (!attacker && (isNamed(e) || isTamed(e))) continue // someone's exhibit or pet

      const ranged = RANGED_NAMES.has(name)
      const lit = creeperFuseLit(e)
      if (lit && distance <= this.blastRadius) {
        out.push(this._entry(e, name, distance, { kind: 'mob', hard: true, lit: true, los: true, attacker }))
        continue
      }
      const limit = attacker ? 24 : (ranged ? this.rangedRadius : this.radius)
      if (distance > limit) continue

      const los = hasLineOfSight(bot, e)
      let real = los || attacker
      if (!real && !ranged && distance <= this.closeRadius) real = this.reachable(e) === true
      if (!real) continue
      out.push(this._entry(e, name, distance, { kind: 'mob', ranged, los, attacker, lit }))
    }
    out.sort((a, b) => a.distance - b.distance)
    this.last = { threats: out, ids: new Set(out.map((t) => t.id)), at: this.now() }
    return this.last
  }

  _entry (entity, name, distance, extra) {
    const me = this.bot.entity.position
    return {
      id: entity.id,
      entity,
      name,
      distance,
      bearing: bearing(me, entity.position),
      where: whereIs(me, entity.position),
      kind: 'mob',
      ranged: false,
      los: false,
      lit: false,
      attacker: false,
      hard: false,
      ...extra
    }
  }

  /** Used by the threat map so A* only pays for threats that are real. */
  isThreat (entity) {
    return Boolean(entity) && this.last.ids.has(entity.id)
  }

  /** One line for the model: totals by type, nearest of each, what is urgent. */
  describe (threats = this.last.threats) {
    if (!threats.length) return 'none'
    const groups = new Map()
    for (const t of threats) {
      const g = groups.get(t.name) || { name: t.name, count: 0, nearest: t, lit: false, attacker: false, kind: t.kind }
      g.count++
      if (t.distance < g.nearest.distance) g.nearest = t
      g.lit = g.lit || t.lit
      g.attacker = g.attacker || t.attacker
      groups.set(t.name, g)
    }
    const parts = [...groups.values()]
      .sort((a, b) => a.nearest.distance - b.nearest.distance)
      .slice(0, 6)
      .map((g) => {
        const tags = []
        if (g.kind === 'player') tags.push('player, hit you')
        else if (g.attacker) tags.push('hit you')
        if (g.lit) tags.push('FUSE LIT')
        const label = g.count > 1 ? `${g.name} x${g.count}` : g.name
        return `${label} (${g.count > 1 ? 'nearest ' : ''}${g.nearest.where}${tags.length ? '; ' + tags.join(', ') : ''})`
      })
    return `${threats.length} — ${parts.join(', ')}`
  }

  /**
   * Explain a hit on the bot in words the model can act on.
   * @param {object|null} source the entity mineflayer blames, if any
   * @returns {{ cause: string, text: string, attacker: string|null, entity?: object }}
   *   `entity` is set when the attacker was guessed rather than named.
   */
  damageCause (source) {
    const bot = this.bot
    if (source && source !== bot.entity && !isDecor(source)) {
      const who = isPlayer(source) ? (source.username || 'a player') : lower(source.name)
      return { cause: isPlayer(source) ? 'player' : 'mob', text: `hit by ${isPlayer(source) ? 'player ' : ''}${who}`, attacker: who }
    }
    const flags = Number(bot.entity?.metadata?.[0])
    if (bot.entity?.isInLava) return { cause: 'lava', text: 'burning in lava', attacker: null }
    if (Number.isFinite(flags) && (flags & 0x01)) return { cause: 'fire', text: 'on fire', attacker: null }
    if (Number.isFinite(bot.oxygenLevel) && bot.oxygenLevel <= 0) return { cause: 'drowning', text: 'drowning (out of air)', attacker: null }
    if (this.now() - this._fall.at < 1500 && this._fall.minVy < -0.6) return { cause: 'fall', text: 'fall damage', attacker: null }
    if (Number.isFinite(bot.food) && bot.food <= 0) return { cause: 'starving', text: 'starving (food is 0)', attacker: null }
    // Servers before 1.19.4 never name the source. Whoever swung an arm at us
    // from arm's length a moment ago is the best guess — said as a guess.
    if (!this.sourcesNamed) {
      const swinger = this._recentSwinger()
      if (swinger) {
        const player = isPlayer(swinger)
        const who = player ? (swinger.username || 'a player') : lower(swinger.name)
        return { cause: player ? 'player' : 'mob', text: `probably hit by ${player ? 'player ' : ''}${who}`, attacker: who, entity: swinger }
      }
    }
    // Otherwise blame the closest plausible hostile.
    const near = this.assess().threats.find((t) => t.distance <= 4.5 || (t.ranged && t.los))
    if (near) return { cause: 'mob', text: `probably hit by ${near.name}`, attacker: near.name }
    return { cause: 'unknown', text: 'took damage (cause unknown)', attacker: null }
  }
}

/**
 * One callback per hit on the bot, however the server announces it: a hurt
 * event, a named damage source (1.19.4+), or simply less health. Some servers
 * and plugins never send the victim a hurt event at all; the health packet is
 * the ground truth, and the events only add *who*.
 *
 * Shared by both harnesses so "I was hit, by whom" has one implementation.
 */
class HurtTracker {
  /**
   * @param {object} bot
   * @param {ThreatSense} sense
   * @param {{ onHurt: (cause: {cause:string,text:string,attacker:string|null}, info: {hp:number, source:object|null}) => void,
   *           isReady?: () => boolean, settleMs?: number, refractoryMs?: number, now?: () => number }} opts
   */
  constructor (bot, sense, { onHurt, isReady = () => true, settleMs = 120, refractoryMs = 250, now = () => Date.now() } = {}) {
    this.bot = bot
    this.sense = sense
    this.onHurt = typeof onHurt === 'function' ? onHurt : () => {}
    this.isReady = isReady
    this.settleMs = settleMs
    this.refractoryMs = refractoryMs
    this.now = now
    this._pending = null
    this._timer = null
    this._lastSettledAt = -Infinity
    this._prevHp = null
    this._onEntityHurt = (entity, source) => { if (entity && entity === this.bot.entity) this._hit(source || null) }
    this._onHealth = () => {
      const hp = Number(this.bot.health)
      if (!Number.isFinite(hp)) return
      if (this._prevHp !== null && hp < this._prevHp - 0.01) this._hit(null)
      this._prevHp = hp
    }
    this._onSwing = (entity) => { try { this.sense.noteSwing(entity) } catch { /* cosmetic */ } }
    this._onDamageEvent = () => { this.sense.sourcesNamed = true }
  }

  start () {
    const bot = this.bot
    // Health already known (started after spawn): that is the baseline, so
    // the very first hit is not mistaken for it.
    if (this._prevHp === null && Number.isFinite(Number(bot.health)) && bot.health !== null && bot.health !== undefined) this._prevHp = Number(bot.health)
    try {
      bot.on('entityHurt', this._onEntityHurt)
      bot.on('health', this._onHealth)
      bot.on('entitySwingArm', this._onSwing)
      bot._client?.on?.('damage_event', this._onDamageEvent)
    } catch { /* partial mock */ }
    return this
  }

  stop () {
    const bot = this.bot
    clearTimeout(this._timer)
    this._timer = null
    this._pending = null
    try {
      bot.removeListener?.('entityHurt', this._onEntityHurt)
      bot.removeListener?.('health', this._onHealth)
      bot.removeListener?.('entitySwingArm', this._onSwing)
      bot._client?.removeListener?.('damage_event', this._onDamageEvent)
    } catch { /* gone */ }
  }

  /** Report a hit that is still waiting for its source (call this at death). */
  flush () {
    if (this._pending) this._settle()
  }

  _hit (source) {
    if (!this.isReady()) return
    if (this._pending) { if (source) this._pending.source = source; return }
    // The same hit often arrives twice (health packet, then the hurt event);
    // damage immunity makes a genuinely new hit impossible this soon. A name
    // that arrives late is still worth keeping.
    if (this.now() - this._lastSettledAt < this.refractoryMs) {
      if (source) this.sense.noteAttacker(source)
      return
    }
    this._pending = { source }
    this._timer = setTimeout(() => this._settle(), this.settleMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  _settle () {
    clearTimeout(this._timer)
    this._timer = null
    const pending = this._pending
    this._pending = null
    if (!pending) return
    const cause = this.sense.damageCause(pending.source)
    // A named source, or — on servers that never name one — whoever swung at us.
    const culprit = pending.source || cause.entity || null
    if (culprit) this.sense.noteAttacker(culprit)
    this._lastSettledAt = this.now()
    try { this.onHurt(cause, { hp: Math.round(Number(this.bot.health ?? 0)), source: culprit }) } catch { /* the sink's problem */ }
  }
}

module.exports = {
  ThreatSense,
  HurtTracker,
  HOSTILE_NAMES,
  RANGED_NAMES,
  DECOR_NAMES,
  PROTECTED_NAMES,
  bearing,
  whereIs,
  isPlayer,
  isDecor,
  isNamed,
  isTamed,
  isProtected,
  creeperFuseLit,
  clearLine,
  hasLineOfSight,
  makeReachabilityCheck
}
