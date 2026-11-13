/**
 * observe.js — what the model is shown about the bot and its surroundings.
 *
 * The old prompt had no inventory (yet `equip` wanted a slot number), listed
 * players as "player Steve 12m" with no position or direction (yet `move`
 * wanted coordinates), capped entities at 16 and counted item frames as mobs.
 * Everything here is a short, labelled line with totals, compass directions
 * and absolute coordinates where a tool can use them.
 *
 * Pure functions over a (possibly mocked) bot. No LLM, no network.
 */
'use strict'

const { whereIs, isPlayer, isDecor, isNamed, isTamed, isHostileMob, HOSTILE_NAMES } = require('./threats')
const { heldItemName } = require('../src/combat')

const ARMOR_SLOTS = [5, 6, 7, 8]

/** hp / food / position / time / mode / what is held and worn. */
function selfLine (bot, { mode = 'explorer' } = {}) {
  const p = bot.entity?.position
  const pos = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?'
  const dim = String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '')
  const t = bot.time?.timeOfDay
  const tod = !Number.isFinite(t) ? '?' : (t < 12000 ? 'day' : (t < 13000 ? 'dusk' : (t < 23000 ? 'night' : 'dawn')))
  const held = bot.heldItem?.name || 'nothing'
  const worn = []
  for (const slot of ARMOR_SLOTS) {
    const item = bot.inventory?.slots?.[slot]
    if (item?.name) worn.push(item.name)
  }
  const off = bot.inventory?.slots?.[45]?.name
  return `state: hp ${Math.round(Number(bot.health ?? 0))}/20 food ${Math.round(Number(bot.food ?? 0))}/20 | pos ${pos} ${dim} | ${tod}${bot.isRaining ? ', raining' : ''} | mode ${mode} | holding ${held}${off ? ` + ${off} (off-hand)` : ''}${worn.length ? ` | wearing ${worn.join(', ')}` : ' | no armor'}`
}

/** "inventory (9/36 slots): iron_sword, bread x12, …" — every kind, counted. */
function inventoryLine (bot, { max = 28 } = {}) {
  let items = []
  try { items = bot.inventory.items() } catch { return 'inventory: unknown' }
  if (!items.length) return 'inventory: empty'
  const counts = new Map()
  for (const it of items) counts.set(it.name, (counts.get(it.name) || 0) + (it.count || 1))
  const list = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} x${c}` : n))
  const more = list.length > max ? `, +${list.length - max} more kinds` : ''
  return `inventory (${items.length}/36 slots): ${list.slice(0, max).join(', ')}${more}`
}

/** Players in view: name, distance, direction, absolute position, what they hold. */
function playersLine (bot, { max = 8 } = {}) {
  const me = bot.entity?.position
  if (!me) return 'players: ?'
  const seen = []
  const far = []
  for (const [name, p] of Object.entries(bot.players || {})) {
    if (name === bot.username) continue
    const e = p?.entity
    if (!e?.position) { far.push(name); continue }
    seen.push({ name, e, d: e.position.distanceTo ? e.position.distanceTo(me) : Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z) })
  }
  seen.sort((a, b) => a.d - b.d)
  const parts = seen.slice(0, max).map(({ name, e }) => {
    const held = heldItemName(e)
    return `${name} ${whereIs(me, e.position)} at ${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}${held ? ` (holding ${held})` : ''}`
  })
  if (far.length) parts.push(`online but out of sight: ${far.slice(0, 6).join(', ')}`)
  return parts.length ? `players: ${parts.join('; ')}` : 'players: none online'
}

/**
 * Creatures around that are NOT current threats, as totals by type with the
 * nearest one's direction. Decor (armor stands, item frames, dropped items)
 * is left out; pets and named mobs are marked so nobody mistakes them for
 * wild ones. `threatIds` (everything coming at the bot) are excluded — they
 * have their own block. `notes` maps an entity id to why it is not a threat.
 */
function mobsLine (bot, { radius = 24, threatIds = new Set(), max = 8, notes = null } = {}) {
  const me = bot.entity?.position
  if (!me) return ''
  const groups = new Map()
  let items = 0
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity || isPlayer(e)) continue
    const name = String(e.name || '').toLowerCase()
    if (!name) continue
    const d = Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z)
    if (d > radius) continue
    if (name === 'item') { items++; continue }
    if (isDecor(e) || threatIds.has(e.id)) continue
    // Why a hostile is listed here and not under threats: the sense says so
    // per mob (shut in / out of sight). "Cannot reach you" used to be stamped
    // on every hostile more than 12 blocks away, walking toward the bot or not.
    let tag = ''
    if (isTamed(e)) tag = ' (pet)'
    else if (isNamed(e)) tag = ' (named)'
    else if (isHostileMob(name, bot)) tag = ` (${notes?.get(e.id) || 'hostile, not coming at you'})`
    else if (HOSTILE_NAMES.has(name)) tag = ' (leaves you alone while you wear gold)'
    const key = name + tag
    const g = groups.get(key) || { key, count: 0, nearest: e, d: Infinity }
    g.count++
    if (d < g.d) { g.d = d; g.nearest = e }
    groups.set(key, g)
  }
  const parts = [...groups.values()].sort((a, b) => a.d - b.d).slice(0, max)
    .map((g) => `${g.key}${g.count > 1 ? ` x${g.count}` : ''} (${g.count > 1 ? 'nearest ' : ''}${whereIs(me, g.nearest.position)})`)
  if (groups.size > max) parts.push(`+${groups.size - max} more kinds`)
  if (items) parts.push(`${items} dropped item${items > 1 ? 's' : ''}`)
  return parts.length ? `mobs: ${parts.join(', ')}` : ''
}

module.exports = { selfLine, inventoryLine, playersLine, mobsLine }
