/**
 * tactics.js — the numbers behind "flee or fight".
 *
 * The model used to be shown three different counts for one horde and no
 * figures at all. This module turns what the body already knows into one
 * honest picture it can decide from without thinking:
 *
 *   how many, of what, how close, how fast they close, which ways are open,
 *   what the bot's own weapon and armour are worth against them, and a
 *   one-word estimate of the fight.
 *
 * Everything is vanilla Java numbers at normal difficulty, rounded: good for
 * choosing between "run" and "fight", not for a damage calculator. Pure
 * functions over a (possibly mocked) bot. No LLM, no network.
 */
'use strict'

const { bearing, meta } = require('./threats')

/**
 * Per mob: health, damage per hit to an unarmoured player, ground speed in
 * blocks/second, and how it hurts (melee reach ~1.6 unless noted).
 * speed = 44 × (movement attribute)²: a zombie (0.23) does 2.3 b/s, a
 * vindicator (0.35) 5.4 b/s. A sprinting player does 5.6.
 */
const MOBS = {
  zombie: { hp: 20, dmg: 3, speed: 2.3 },
  husk: { hp: 20, dmg: 3, speed: 2.3 },
  drowned: { hp: 20, dmg: 3, speed: 2.3 },
  zombie_villager: { hp: 20, dmg: 3, speed: 2.3 },
  zombified_piglin: { hp: 20, dmg: 8, speed: 3.2 },
  skeleton: { hp: 20, dmg: 4, speed: 2.8, ranged: 15 },
  stray: { hp: 20, dmg: 4, speed: 2.8, ranged: 15 },
  bogged: { hp: 16, dmg: 4, speed: 2.8, ranged: 15 },
  parched: { hp: 16, dmg: 4, speed: 2.8, ranged: 15 },
  wither_skeleton: { hp: 20, dmg: 8, speed: 2.8 },
  creeper: { hp: 20, dmg: 25, speed: 2.8, explosive: true, reach: 4.5 },
  spider: { hp: 16, dmg: 2, speed: 4.0 },
  cave_spider: { hp: 12, dmg: 2, speed: 4.0 },
  witch: { hp: 26, dmg: 6, speed: 2.8, ranged: 10 },
  pillager: { hp: 24, dmg: 4, speed: 5.4, ranged: 12 },
  vindicator: { hp: 24, dmg: 13, speed: 5.4 },
  evoker: { hp: 24, dmg: 6, speed: 4.0, ranged: 10 },
  illusioner: { hp: 32, dmg: 4, speed: 4.0, ranged: 12 },
  vex: { hp: 14, dmg: 9, speed: 7, flying: true },
  ravager: { hp: 100, dmg: 12, speed: 4.0 },
  piglin: { hp: 16, dmg: 5, speed: 5.4 },
  piglin_brute: { hp: 50, dmg: 13, speed: 5.4 },
  hoglin: { hp: 40, dmg: 6, speed: 4.0 },
  zoglin: { hp: 40, dmg: 6, speed: 4.0 },
  phantom: { hp: 20, dmg: 2, speed: 9, flying: true },
  silverfish: { hp: 8, dmg: 1, speed: 2.8 },
  endermite: { hp: 8, dmg: 2, speed: 2.8 },
  slime: { hp: 16, dmg: 4, speed: 2.5 },
  magma_cube: { hp: 16, dmg: 6, speed: 3.0 },
  blaze: { hp: 20, dmg: 5, speed: 3.0, ranged: 16, flying: true },
  ghast: { hp: 10, dmg: 17, speed: 3.0, ranged: 40, flying: true },
  breeze: { hp: 30, dmg: 3, speed: 5.0, ranged: 12 },
  guardian: { hp: 30, dmg: 6, speed: 4.0, ranged: 14 },
  elder_guardian: { hp: 80, dmg: 8, speed: 3.0, ranged: 14 },
  shulker: { hp: 30, dmg: 4, speed: 0.1, ranged: 16 },
  creaking: { hp: 1000, dmg: 3, speed: 7 },
  enderman: { hp: 40, dmg: 7, speed: 4.0 },
  warden: { hp: 500, dmg: 30, speed: 5.7 },
  wither: { hp: 300, dmg: 8, speed: 6, ranged: 20, flying: true },
  iron_golem: { hp: 100, dmg: 15, speed: 2.8 },
  wolf: { hp: 8, dmg: 4, speed: 4.0 },
  bee: { hp: 10, dmg: 2, speed: 4.0, flying: true },
  polar_bear: { hp: 30, dmg: 6, speed: 2.8 },
  llama: { hp: 22, dmg: 1, speed: 2.5, ranged: 6 },
  player: { hp: 20, dmg: 7, speed: 5.6 }
}
const UNKNOWN_MOB = { hp: 20, dmg: 4, speed: 3.0 }

const mobStats = (name) => MOBS[String(name || '').toLowerCase()] || UNKNOWN_MOB

/** Ground speed of this particular entity (babies are 1.5× on the attribute: 2.25× the speed). */
function mobSpeed (entity, name = entity?.name) {
  const s = mobStats(name)
  let speed = s.speed
  try { if (meta(entity, 'baby') === true) speed *= 2.25 } catch { /* partial entity */ }
  return speed
}

/** How close it must get to hurt: melee ~1.6, a creeper 4.5, an archer most of its range. */
function mobReach (name) {
  const s = mobStats(name)
  if (s.reach) return s.reach
  if (s.ranged) return Math.min(10, s.ranged * 0.7)
  return 1.6
}

/** Item names an entity shows: [main hand, off hand, feet, legs, chest, head] (mineflayer's order). */
function shownGear (entity) {
  const eq = Array.isArray(entity?.equipment) ? entity.equipment : []
  const name = (i) => (eq[i] && typeof eq[i].name === 'string' ? eq[i].name : null)
  return { hand: entity?.heldItem?.name || name(0), offhand: name(1), armor: [name(5), name(4), name(3), name(2)].filter(Boolean) }
}

/**
 * A player as an opponent, from what can be seen: the weapon in hand and the
 * armour worn. Their skill cannot be seen; the estimate assumes a competent one.
 */
function playerStats (entity) {
  const gear = shownGear(entity)
  const weapon = weaponStats(gear.hand)
  const bow = /^(bow|crossbow)$/.test(String(gear.hand || ''))
  let armor = 0
  for (const piece of gear.armor) armor += armorPieceValue(piece)
  return {
    hp: 20,
    dmg: bow ? 7 : weapon.dmg * (weapon.kind === 'none' ? 1 : 1.25), // some of their hits are crits
    speed: 5.6,
    ranged: bow ? 20 : 0,
    reach: 3,
    rate: bow ? 0.8 : Math.min(weapon.speed, 1.6) * 0.6, // hits landing per second
    armor,
    player: true,
    hand: gear.hand || 'bare hands',
    shield: gear.offhand === 'shield' || gear.hand === 'shield'
  }
}

/** The numbers for one threat entry: a player who hit the bot is a player, not an unknown mob. */
const statsOf = (t) => (t && t.kind === 'player' ? playerStats(t.entity) : mobStats(t?.name))
const reachOf = (t) => (t && t.kind === 'player' ? (/^(bow|crossbow)$/.test(String(shownGear(t.entity).hand || '')) ? 12 : 3) : mobReach(t?.name))

// --- the bot's side --------------------------------------------------------
const TIER_SWORD = { wooden: 4, golden: 4, stone: 5, copper: 5, iron: 6, diamond: 7, netherite: 8 }
const TIER_AXE = { wooden: 7, golden: 7, stone: 9, copper: 9, iron: 9, diamond: 9, netherite: 10 }
const AXE_SPEED = { wooden: 0.8, stone: 0.8, copper: 0.9, iron: 0.9, golden: 1.0, diamond: 1.0, netherite: 1.0 }

/** Damage per hit and swings per second of whatever is held. */
function weaponStats (itemName) {
  const name = String(itemName || '')
  let m = /^(wooden|golden|stone|copper|iron|diamond|netherite)_sword$/.exec(name)
  if (m) return { name, dmg: TIER_SWORD[m[1]], speed: 1.6, kind: 'sword' }
  m = /^(wooden|golden|stone|copper|iron|diamond|netherite)_axe$/.exec(name)
  if (m) return { name, dmg: TIER_AXE[m[1]], speed: AXE_SPEED[m[1]], kind: 'axe' }
  if (name === 'trident') return { name, dmg: 9, speed: 1.1, kind: 'trident' }
  if (name === 'mace') return { name, dmg: 6, speed: 0.6, kind: 'mace' }
  if (/_spear$/.test(name)) return { name, dmg: 5, speed: 1.0, kind: 'spear' }
  return { name: name || 'bare hands', dmg: 1, speed: 4, kind: 'none' }
}

const ARMOR_POINTS = {
  leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], copper: [2, 4, 3, 1],
  iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3]
}
const ARMOR_PART = { helmet: 0, chestplate: 1, leggings: 2, boots: 3 }

/** Armour points of one worn piece. */
function armorPieceValue (name) {
  if (!name) return 0
  if (name === 'turtle_helmet') return 2
  const m = /^(leather|golden|chainmail|copper|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/.exec(name)
  return m ? ARMOR_POINTS[m[1]][ARMOR_PART[m[2]]] : 0
}

/** Armour points worn (0–20). */
function armorPoints (bot) {
  let points = 0
  for (const slot of [5, 6, 7, 8]) points += armorPieceValue(bot?.inventory?.slots?.[slot]?.name)
  return points
}

/** Best melee weapon carried (not necessarily held): the fight would use it. */
function bestWeapon (bot) {
  let best = weaponStats(bot?.heldItem?.name)
  let items = []
  try { items = bot.inventory.items() } catch { items = [] }
  for (const it of items) {
    const w = weaponStats(it.name)
    if (w.kind === 'sword' || w.kind === 'axe') {
      if (w.dmg * Math.min(w.speed, 1.6) > best.dmg * Math.min(best.speed, 1.6)) best = w
    }
  }
  return best
}

// --- the picture ------------------------------------------------------------
const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const SECTOR_DIR = {
  N: { x: 0, z: -1 }, NE: { x: 0.707, z: -0.707 }, E: { x: 1, z: 0 }, SE: { x: 0.707, z: 0.707 },
  S: { x: 0, z: 1 }, SW: { x: -0.707, z: 0.707 }, W: { x: -1, z: 0 }, NW: { x: -0.707, z: -0.707 }
}

/**
 * Everything worth knowing about the hostiles around, as data.
 *
 * @param {object} bot
 * @param {Array<object>} hostiles entries from ThreatSense (threats + watch): { name, distance, entity, kind, ranged, lit, attacker, closing? }
 * @param {{ canRun?: (dir:{x:number,z:number}) => boolean }} [opts]
 */
function situation (bot, hostiles, { canRun = null } = {}) {
  const me = bot?.entity?.position
  const list = (hostiles || []).filter((t) => t && t.entity?.position)
  if (!me || !list.length) return null
  const groups = new Map()
  let within8 = 0; let inReach = 0; let hitYou = 0; let ranged = 0; let explosive = 0; let lit = 0; let players = 0
  let nearest = list[0]
  let contactIn = Infinity
  const closings = []
  const crowd = Object.fromEntries(SECTORS.map((s) => [s, 0]))
  for (const t of list) {
    const stats = statsOf(t)
    const reach = reachOf(t)
    const g = groups.get(t.name) || { name: t.name, count: 0, nearest: t, stats, player: t.kind === 'player', attacker: false, lit: false, charged: false }
    g.count++
    if (t.distance < g.nearest.distance) g.nearest = t
    g.attacker = g.attacker || Boolean(t.attacker)
    g.lit = g.lit || Boolean(t.lit)
    g.charged = g.charged || Boolean(t.charged)
    groups.set(t.name, g)
    if (t.distance < nearest.distance) nearest = t
    if (t.distance <= 8) within8++
    if (t.distance <= reach + 1.6) inReach++
    if (t.attacker) hitYou++
    if (stats.ranged) ranged++
    if (stats.explosive) explosive++
    if (t.lit) lit++
    if (t.kind === 'player') players++
    if (t.distance <= 12) { const b = bearing(me, t.entity.position); if (crowd[b] !== undefined) crowd[b]++ }
    if (Number.isFinite(t.closing)) {
      closings.push(t.closing)
      if (t.closing > 0.3) contactIn = Math.min(contactIn, Math.max(0, t.distance - reach) / t.closing)
    }
  }
  closings.sort((a, b) => b - a)
  // The pace of the ones that matter: the fastest-closing third.
  const lead = closings.slice(0, Math.max(1, Math.ceil(closings.length / 3)))
  const closing = lead.length ? lead.reduce((a, b) => a + b, 0) / lead.length : null

  const open = []
  const blocked = []
  for (const s of SECTORS) {
    const i = SECTORS.indexOf(s)
    const near = crowd[s] + 0.5 * (crowd[SECTORS[(i + 1) % 8]] + crowd[SECTORS[(i + 7) % 8]])
    const ground = canRun ? canRun(SECTOR_DIR[s]) : true
    if (near < 1 && ground) open.push(s)
    else blocked.push(s)
  }

  // --- what a fight would cost -------------------------------------------
  const hp = Number(bot.health ?? 20)
  const armor = armorPoints(bot)
  const through = (dmg, points) => dmg * (1 - Math.min(0.8, points * 0.04))
  const weapon = bestWeapon(bot)
  const crit = weapon.kind === 'sword' || weapon.kind === 'axe' ? 1.5 : 1
  const swing = 1 / Math.min(weapon.speed, 1.6) + 0.1
  let seconds = 0
  let meleeHit = 0; let meleeCount = 0
  let duel = 0 // damage per second from players: no knock-back discount, they strafe and crit
  for (const g of groups.values()) {
    const s = g.stats
    const perHit = Math.max(0.5, through(weapon.dmg * crit, s.armor || 0))
    seconds += g.count * Math.ceil(s.hp / perHit) * swing * (s.shield ? 1.5 : 1)
    if (s.player) duel += g.count * through(s.dmg, armor) * s.rate
    else if (!s.explosive) { meleeHit += g.count * through(s.dmg, armor); meleeCount += g.count }
  }
  // Half a second of immunity after each hit: at most two hits a second land, however many mobs.
  const perSecond = meleeCount ? (meleeHit / meleeCount) * Math.min(meleeCount, 2) : 0
  // One opponent at a time gets knocked back and lands about every third second.
  const pressure = (meleeCount <= 1 ? perSecond * 0.35 : (meleeCount === 2 ? perSecond * 0.6 : perSecond)) + duel
  const cost = pressure * seconds
  let verdict = 'good'
  if (cost >= hp * 0.9 || explosive >= 3) verdict = 'bad'
  else if (cost >= hp * 0.4 || explosive > 0 || hp <= 8 || players > 0) verdict = 'risky'

  return {
    total: list.length,
    groups: [...groups.values()].sort((a, b) => a.nearest.distance - b.nearest.distance),
    nearest,
    within8,
    inReach,
    hitYou,
    ranged,
    explosive,
    lit,
    players,
    closing,
    contactIn: Number.isFinite(contactIn) ? contactIn : null,
    open,
    blocked,
    me: { hp, armor, weapon },
    fight: { seconds, cost, perSecond: pressure, verdict }
  }
}

const r1 = (v) => (Math.round(v * 10) / 10).toString()

/** What "no good way out" means, in the words the model reads. `why` comes from the escape planner. */
function cornerText (why) {
  if (why === 'surrounded') return 'SURROUNDED — they are on every side, no safe way out'
  if (why === 'trapped') return 'TRAPPED — shut in with them, the ground ends here'
  if (why === 'stuck') return 'STUCK — nowhere to step'
  return 'CORNERED — the only safe ground is a dead end'
}

/** "zombie x24 (nearest 5m NE)", "skeleton (15m N; ranged)", "Gabriel (3m E; player, hit you; diamond_sword, armor 20/20)". */
function describeGroup (g) {
  const tags = []
  const stats = g.stats || mobStats(g.name)
  if (g.player) {
    tags.push(g.attacker ? 'player, hit you' : 'player')
    tags.push(`${stats.hand}, armor ${stats.armor}/20${stats.shield ? ', shield' : ''}`)
  } else {
    const kind = []
    if (g.attacker) kind.push('hit you')
    if (g.lit) kind.push('FUSE LIT')
    if (g.charged) kind.push('charged')
    if (stats.ranged) kind.push('ranged')
    if (stats.explosive && !g.lit) kind.push('explodes')
    if (kind.length) tags.push(kind.join(', '))
  }
  return `${g.name}${g.count > 1 ? ` x${g.count}` : ''} (${g.count > 1 ? 'nearest ' : ''}${g.nearest.where}${tags.length ? '; ' + tags.join('; ') : ''})`
}

/**
 * The lines the model reads. Three short lines; nothing when calm.
 *   [0] who:      "27 in sight — zombie x24 (nearest 5m NE), skeleton x3 (nearest 15m NE; ranged)"
 *   [1] pressure: how close, how fast, which ways are open
 *   [2] odds:     what a fight would cost with the gear carried
 * @param {ReturnType<typeof situation>} s
 * @param {{ route?: { cornered:boolean, why:string } | null }} [opts]
 */
function describeSituation (s, { route = null } = {}) {
  if (!s) return []
  const kinds = s.groups.slice(0, 5).map(describeGroup)
  if (s.groups.length > 5) kinds.push(`+${s.groups.length - 5} more kinds`)
  const head = `${s.total} in sight — ${kinds.join(', ')}`

  const press = [`${s.within8} within 8m`]
  if (s.inReach) press.push(`${s.inReach} in striking range`)
  if (s.lit) press.push(`${s.lit} creeper FUSE LIT`)
  if (s.hitYou) press.push(`${s.hitYou} already hit you`)
  if (s.closing !== null) {
    if (s.closing > 0.3) press.push(`closing ${r1(s.closing)} m/s${s.contactIn !== null ? `, contact in ~${Math.max(1, Math.round(s.contactIn))}s` : ''}`)
    else if (s.closing < -0.3) press.push(`falling behind ${r1(-s.closing)} m/s (you are outrunning them)`)
    else press.push('keeping their distance')
  }
  let ways
  if (route && route.cornered) ways = cornerText(route.why)
  else {
    ways = s.open.length ? `open ${s.open.join(', ')}` : 'no open side'
    // "Chased" is only worth saying while they really keep up.
    if (route && route.why === 'chased' && !(s.closing !== null && s.closing < -0.3)) ways += ' — but they are as fast as you or already on you: running alone will not shake them off'
  }
  const time = s.fight.seconds > 90 ? '90+' : String(Math.max(1, Math.round(s.fight.seconds)))
  const odds = `${s.me.weapon.name} ${s.me.weapon.dmg} dmg, armor ${s.me.armor}/20, hp ${Math.round(s.me.hp)}: ≈ ${time}s to kill ${s.total > 1 ? 'them all' : (s.players ? 'them' : 'it')}, you would take ≈ ${Math.round(s.fight.cost)} dmg → ${s.fight.verdict.toUpperCase()}${s.players ? ' (a player may be better or worse than this)' : ''}`
  return [head, `pressure: ${press.join('; ')} | ways out: ${ways}`, `if you fight: ${odds}`]
}

module.exports = { MOBS, mobStats, mobSpeed, mobReach, playerStats, statsOf, reachOf, shownGear, weaponStats, armorPoints, bestWeapon, situation, describeSituation, describeGroup, cornerText, SECTOR_DIR }
