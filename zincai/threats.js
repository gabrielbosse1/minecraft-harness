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

const { attachDoors, describe: describeDoor, blocksWalk } = require('./custom_mineflayer/doors')

const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'witch',
  'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'piglin_brute',
  'phantom', 'silverfish', 'endermite', 'slime', 'magma_cube', 'blaze', 'ghast',
  'hoglin', 'zoglin', 'guardian', 'elder_guardian', 'warden', 'wither',
  'breeze', 'creaking', 'shulker', 'illusioner',
  'parched', // 26.x desert skeleton
  'piglin' // unless the bot wears gold — see assess()
])

/** Mobs that hurt from a distance: only line of sight matters, at longer range. */
const RANGED_NAMES = new Set([
  'skeleton', 'stray', 'bogged', 'parched', 'pillager', 'blaze', 'ghast', 'witch',
  'breeze', 'guardian', 'elder_guardian', 'shulker', 'wither', 'illusioner', 'evoker'
])

/**
 * The game data calls these hostile, but they leave a player alone until
 * provoked (or, for the giant, do not exist in survival). They become threats
 * the normal way: by actually hitting the bot.
 */
const NEUTRAL_UNTIL_PROVOKED = new Set(['enderman', 'zombified_piglin', 'giant', 'ender_dragon'])

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

// ---------------------------------------------------------------------------
// Entity metadata by NAME.
//
// Metadata is a positional array and the positions move between versions:
// 26.x put `age_locked` in front of the tame flags, so "index 17" stopped
// meaning "tamed" and every pet read as wild. The game data lists the key
// names per entity; with them the harness asks for `flags`, `owneruuid`,
// `swell_dir` by name. Without game data (unit tests, a version the data does
// not cover) it falls back to the classic positions.
// ---------------------------------------------------------------------------
let layout = null // registry.entitiesByName
const indexCache = new Map()

/**
 * Give this module the server's game data. Call once per connection.
 * @returns {{ ok: boolean, problems: string[], newHostiles: string[] }}
 */
function useRegistry (registry) {
  layout = registry?.entitiesByName || null
  indexCache.clear()
  const problems = []
  const newHostiles = []
  if (!layout) return { ok: false, problems: ['no entity data — using classic metadata positions'], newHostiles }
  const need = { wolf: ['flags', 'owneruuid'], cat: ['flags', 'owneruuid'], horse: ['flags'], creeper: ['swell_dir', 'is_ignited'], zombie: ['custom_name'] }
  for (const [name, keys] of Object.entries(need)) {
    const have = layout[name]?.metadataKeys
    if (!Array.isArray(have)) { problems.push(`${name}: no metadata keys in the game data`); continue }
    for (const key of keys) if (!have.includes(key)) problems.push(`${name}: metadata key "${key}" is missing`)
  }
  // Anything the data calls hostile that this harness has never heard of is
  // treated as hostile: fleeing from a stranger is the cheap mistake.
  for (const e of Object.values(layout)) {
    const name = lower(e?.name)
    if (!name || e.type !== 'hostile') continue
    if (HOSTILE_NAMES.has(name) || NEUTRAL_UNTIL_PROVOKED.has(name)) continue
    HOSTILE_NAMES.add(name)
    newHostiles.push(name)
  }
  return { ok: problems.length === 0, problems, newHostiles }
}

/** Position of a metadata key for an entity type; -1 = not there; null = no data for this type. */
function metaIndex (entityName, key) {
  const keys = layout?.[entityName]?.metadataKeys
  if (!Array.isArray(keys)) return null
  const id = entityName + '/' + key
  let i = indexCache.get(id)
  if (i === undefined) { i = keys.indexOf(key); indexCache.set(id, i) }
  return i
}

/** Read one metadata value by key name. `classic` is the position to use when there is no game data. */
function meta (e, key, classic = null) {
  if (!e?.metadata) return undefined
  const i = metaIndex(lower(e.name), key)
  if (i === null) return classic === null ? undefined : e.metadata[classic]
  return i < 0 ? undefined : e.metadata[i]
}

const hasValue = (v) => {
  if (v === undefined || v === null || v === '') return false
  if (typeof v === 'object' && v.value === undefined && Object.keys(v).length === 0) return false
  return true
}

/** Shared entity flags (burning, sneaking, sprinting, gliding …) of any entity. */
function sharedFlags (e) {
  const v = Number(meta(e, 'shared_flags', 0))
  return Number.isFinite(v) ? v : 0
}
/** Gliding on an elytra right now? (shared flag 0x80) */
const isGliding = (e) => Boolean(e) && (e.elytraFlying === true || (sharedFlags(e) & 0x80) !== 0)
/** Using the item in hand: blocking, drawing a bow, charging a spear, eating. (living flag 0x01) */
function isUsingItem (e) {
  const v = Number(meta(e, 'living_entity_flags', 8))
  return Number.isFinite(v) && (v & 0x01) !== 0
}

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

/** Name-tagged? */
function isNamed (e) {
  if (!e || isPlayer(e)) return false
  return hasValue(meta(e, 'custom_name', 2))
}

/**
 * Tamed pet or mount?
 *   true / false  the game data (or the classic layout) says so
 *   null          this is a tamable kind but its state cannot be read
 */
function tameState (e) {
  if (!e) return false
  const name = lower(e.name)
  const known = metaIndex(name, 'flags')
  if (known === null) {
    // No game data for this type: classic positions (1.17 – 1.21).
    const flags = Number(e.metadata?.[17])
    if (TAMABLE_FLAG_4.has(name)) return Number.isFinite(flags) ? (flags & 0x04) !== 0 : false
    if (TAMABLE_FLAG_2.has(name)) return Number.isFinite(flags) ? (flags & 0x02) !== 0 : false
    return false
  }
  const ownerAt = metaIndex(name, 'owneruuid')
  if (ownerAt !== null && ownerAt >= 0) {
    // Wolves, cats, parrots and whatever tamable comes next: an owner, or the tame bit.
    if (hasValue(e.metadata?.[ownerAt])) return true
    if (known < 0) return null
    const flags = Number(e.metadata?.[known])
    return Number.isFinite(flags) ? (flags & 0x04) !== 0 : false
  }
  if (TAMABLE_FLAG_2.has(name)) {
    if (known < 0) return null
    const flags = Number(e.metadata?.[known])
    return Number.isFinite(flags) ? (flags & 0x02) !== 0 : false
  }
  if (TAMABLE_FLAG_4.has(name)) return null // tamable, but the data has no owner key for it
  return false
}

/** Tamed pet or mount? Unknown reads as false here; isProtected() is the cautious one. */
const isTamed = (e) => tameState(e) === true

/** Must never be attacked on a type match: decor, pets, named mobs, villagers. */
function isProtected (e) {
  if (!e) return true
  if (isDecor(e)) return true
  if (PROTECTED_NAMES.has(lower(e.name))) return true
  // A pet whose tame flag cannot be read is still somebody's pet until proven wild.
  return isNamed(e) || tameState(e) !== false
}

/** Creeper swelling? (`swell_dir` is 1 while the fuse burns; `is_ignited` after flint and steel) */
function creeperFuseLit (e) {
  if (!e || lower(e.name) !== 'creeper') return false
  const state = meta(e, 'swell_dir', 16)
  const ignited = meta(e, 'is_ignited', 18)
  return state === 1 || ignited === true || ignited === 1
}

/** A charged creeper: twice the blast. */
function creeperCharged (e) {
  if (!e || lower(e.name) !== 'creeper') return false
  const v = meta(e, 'is_powered', 17)
  return v === true || v === 1
}

/** Piglins leave anyone in gold alone. */
function wearsGold (bot) {
  for (const slot of [5, 6, 7, 8]) {
    const name = bot?.inventory?.slots?.[slot]?.name
    if (typeof name === 'string' && name.startsWith('golden_')) return true
  }
  return false
}

/** Is this mob type hostile to THIS bot right now? (A piglin is not, to someone in gold.) */
function isHostileMob (name, bot) {
  const n = lower(name)
  if (!HOSTILE_NAMES.has(n)) return false
  return !(n === 'piglin' && wearsGold(bot))
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
    if (block && block.boundingBox === 'block') {
      // An open door or gate is a hole in the wall, whatever its block type says.
      const d = describeDoor(block)
      if (d && d.kind !== 'trapdoor' && !blocksWalk(d, Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z')) continue
      return false
    }
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
 * from where it stands to me?" — no digging, no placing, no opening doors
 * (open ones are walked through). Bounded to
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
        // A mob walks through whatever stands open and is stopped by whatever is shut.
        attachDoors(movements, { operate: false })
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
    // Beyond the trigger ring hostiles are still WATCHED: counted honestly for
    // the model, and used to decide when an escape is really over.
    this.watchRadius = Number.isFinite(opts.watchRadius) ? opts.watchRadius : 32
    this.blastRadius = Number.isFinite(opts.blastRadius) ? opts.blastRadius : 8
    this.attackerMemoryMs = Number.isFinite(opts.attackerMemoryMs) ? opts.attackerMemoryMs : 15_000
    this.reachable = typeof opts.reachable === 'function' ? opts.reachable : () => null
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    /** id -> { at, name, player } for things that actually hurt the bot */
    this.attackers = new Map()
    this.last = { threats: [], watch: [], hidden: [], ids: new Set(), dangerIds: new Set(), at: 0 }
    /** id -> { d, at, closing } : how fast each hostile is closing on the bot (blocks/s, + = nearer) */
    this._track = new Map()
    /** id -> { at, value } : line-of-sight answers for the outer ring, reused for half a second */
    this._losCache = new Map()
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
   * Who is dangerous right now, nearest first, in three honest groups:
   *
   *   threats  real and close: they see the bot or can walk to it, inside the
   *            trigger ring (or they hit it, or a fuse is lit). These start
   *            the flee reflex.
   *   watch    wild hostiles in the open further out. Not a reason to start
   *            running, but they are coming, they are counted, and an escape
   *            is not over while they follow.
   *   hidden   wild hostiles with no line on the bot and no route to it:
   *            behind bars, behind walls, on another floor.
   *
   * @returns {{ threats: object[], watch: object[], hidden: object[], ids: Set<number>, dangerIds: Set<number>, at: number }}
   */
  assess () {
    const bot = this.bot
    const me = bot?.entity?.position
    const now = this.now()
    const out = []
    const watch = []
    const hidden = []
    if (!me) { this.last = { threats: out, watch, hidden, ids: new Set(), dangerIds: new Set(), at: now }; return this.last }
    const gold = wearsGold(bot)
    const seen = new Set()
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
        if (attacker && distance <= 24) { seen.add(e.id); out.push(this._entry(e, e.username || 'player', distance, { kind: 'player', attacker: true, los: true, closing: this._closing(e.id, distance, now) })) }
        continue
      }

      let hostile = HOSTILE_NAMES.has(name)
      if (hostile && name === 'piglin' && gold) hostile = false
      if (!hostile && !attacker) continue
      if (!attacker && (isNamed(e) || tameState(e) === true)) continue // someone's exhibit or pet

      seen.add(e.id)
      const closing = this._closing(e.id, distance, now)
      const ranged = RANGED_NAMES.has(name)
      const lit = creeperFuseLit(e)
      const charged = name === 'creeper' && creeperCharged(e)
      const blast = charged ? this.blastRadius * 1.6 : this.blastRadius
      if (lit && distance <= blast) {
        out.push(this._entry(e, name, distance, { kind: 'mob', hard: true, lit: true, los: true, attacker, charged, closing }))
        continue
      }
      const limit = attacker ? 24 : (ranged ? this.rangedRadius : (charged ? this.radius + 4 : this.radius))
      if (distance > limit) {
        if (distance > this.watchRadius) continue
        const los = this._cachedLos(e, now)
        ;(los ? watch : hidden).push(this._entry(e, name, distance, { kind: 'mob', ranged, los, lit, charged, closing }))
        continue
      }

      const los = hasLineOfSight(bot, e)
      let real = los || attacker
      let route = null
      if (!real && !ranged && distance <= this.closeRadius) { route = this.reachable(e); real = route === true }
      if (!real) {
        hidden.push(this._entry(e, name, distance, { kind: 'mob', ranged, los, lit, charged, closing, caged: route === false }))
        continue
      }
      out.push(this._entry(e, name, distance, { kind: 'mob', ranged, los, attacker, lit, charged, closing }))
    }
    for (const id of this._track.keys()) if (!seen.has(id)) this._track.delete(id)
    if (this._losCache.size > 96) for (const [id, v] of this._losCache) if (now - v.at > 2000) this._losCache.delete(id)
    const byDistance = (a, b) => a.distance - b.distance
    out.sort(byDistance); watch.sort(byDistance); hidden.sort(byDistance)
    const ids = new Set(out.map((t) => t.id))
    const dangerIds = new Set(ids)
    for (const t of watch) dangerIds.add(t.id)
    this.last = { threats: out, watch, hidden, ids, dangerIds, at: now }
    return this.last
  }

  /** Blocks per second this entity is closing on the bot (+ = getting nearer), smoothed. */
  _closing (id, distance, now) {
    const prev = this._track.get(id)
    if (!prev) { this._track.set(id, { d: distance, at: now, closing: null }); return null }
    const dt = (now - prev.at) / 1000
    if (dt < 0.15) return prev.closing
    const raw = Math.max(-12, Math.min(12, (prev.d - distance) / dt))
    const closing = prev.closing === null || dt > 2 ? raw : prev.closing * 0.6 + raw * 0.4
    this._track.set(id, { d: distance, at: now, closing })
    return closing
  }

  _cachedLos (e, now) {
    const hit = this._losCache.get(e.id)
    if (hit && now - hit.at < 500) return hit.value
    const value = hasLineOfSight(this.bot, e)
    this._losCache.set(e.id, { at: now, value })
    return value
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
      charged: false,
      closing: null,
      ...extra
    }
  }

  /** Used by the threat map so A* pays for everything that is coming, near or not yet near. */
  isThreat (entity) {
    return Boolean(entity) && this.last.dangerIds.has(entity.id)
  }

  /** Everything hostile that has a line on the bot: the trigger ring plus the watch ring. */
  coming () {
    return this.last.watch.length ? [...this.last.threats, ...this.last.watch].sort((a, b) => a.distance - b.distance) : this.last.threats
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
  tameState,
  useRegistry,
  meta,
  metaIndex,
  sharedFlags,
  isGliding,
  isUsingItem,
  creeperCharged,
  wearsGold,
  isHostileMob,
  NEUTRAL_UNTIL_PROVOKED,
  isProtected,
  creeperFuseLit,
  clearLine,
  hasLineOfSight,
  makeReachabilityCheck
}
