/**
 * procedures.js — high-level survival procedures built on top of Skills,
 * AdvancedCombat, and ControlArbiter.
 *
 * Each procedure composes low-level body primitives (walk, equip, dig, craft,
 * combat, furnace smelt) with active ground-drop collection and strict
 * inventory verification, while honouring reflex preemption (ControlArbiter)
 * and player-property / PvP safety guards.
 */
'use strict'

const { Vec3 } = require('vec3')
const { findBlocksFast } = require('./block_search')
const { isProtected, isPlayer } = require('./threats')
const { FOODS, chooseFood } = require('./system1')
const { PRIORITY } = require('./control')
const { craftItem } = require('../src/recipes')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fold = (s) => String(s || '').trim().toLowerCase()

/**
 * Exact item names a mined block drops in vanilla survival (without Silk Touch).
 * Used to verify actual inventory gain after breaking blocks and collecting drops.
 */
const DROP_ITEMS_FOR_BLOCK = {
  stone: ['cobblestone', 'stone'],
  deepslate: ['cobbled_deepslate', 'deepslate'],
  coal_ore: ['coal'],
  deepslate_coal_ore: ['coal'],
  iron_ore: ['raw_iron', 'iron_ore'],
  deepslate_iron_ore: ['raw_iron', 'deepslate_iron_ore'],
  copper_ore: ['raw_copper', 'copper_ore'],
  deepslate_copper_ore: ['raw_copper', 'deepslate_copper_ore'],
  gold_ore: ['raw_gold', 'gold_ore'],
  deepslate_gold_ore: ['raw_gold', 'deepslate_gold_ore'],
  nether_gold_ore: ['gold_nugget'],
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
  nether_quartz_ore: ['quartz'],
  clay: ['clay_ball', 'clay'],
  glowstone: ['glowstone_dust'],
  grass_block: ['dirt', 'grass_block'],
  gravel: ['gravel', 'flint'],
  snow_block: ['snowball', 'snow_block'],
  snow: ['snowball'],
  melon: ['melon_slice'],
  short_grass: ['wheat_seeds'],
  tall_grass: ['wheat_seeds'],
  wheat: ['wheat', 'wheat_seeds'],
  carrots: ['carrot'],
  potatoes: ['potato'],
  beetroots: ['beetroot', 'beetroot_seeds'],
  sugar_cane: ['sugar_cane'],
  sweet_berry_bush: ['sweet_berries']
}

/** Raw food items -> their cooked furnace/smoker outputs. */
const RAW_TO_COOKED = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp'
}

/** Safe huntable food/resource animals (default pool when `target` is "food" or omitted). */
const HUNTABLE_ANIMALS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'cod', 'salmon', 'hoglin'
])

/** Expected drops for common hunted animals (for drop verification). */
const LOOT_ITEMS_FOR_MOB = {
  cow: ['beef', 'cooked_beef', 'leather'],
  mooshroom: ['beef', 'cooked_beef', 'leather'],
  pig: ['porkchop', 'cooked_porkchop'],
  sheep: ['mutton', 'cooked_mutton', 'white_wool', 'light_gray_wool', 'gray_wool', 'black_wool', 'brown_wool'],
  chicken: ['chicken', 'cooked_chicken', 'feather'],
  rabbit: ['rabbit', 'cooked_rabbit', 'rabbit_hide', 'rabbit_foot'],
  cod: ['cod', 'cooked_cod', 'bone_meal'],
  salmon: ['salmon', 'cooked_salmon', 'bone_meal'],
  hoglin: ['porkchop', 'cooked_porkchop', 'leather'],
  spider: ['string', 'spider_eye'],
  skeleton: ['bone', 'arrow'],
  zombie: ['rotten_flesh', 'iron_ingot', 'carrot', 'potato']
}

const FUEL_ITEMS = new Set([
  'coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block', 'stick', 'bamboo'
])
const WOOD_FUEL_RE = /(_planks|_log|_wood|_slab|fence|stairs|crafting_table)$/

const ok = (msg, extra = {}) => ({ ok: true, msg, text: msg, ...extra })
const fail = (msg, extra = {}) => ({ ok: false, msg, text: msg, ...extra })

/**
 * Given block names targeted by mining, compute the set of item names that
 * could enter the inventory when those blocks break.
 */
function expectedDropsFor (blockNames = []) {
  const out = new Set()
  for (const name of blockNames) {
    const mapped = DROP_ITEMS_FOR_BLOCK[name]
    if (mapped) {
      for (const m of mapped) out.add(m)
    } else if (name) {
      out.add(name)
    }
  }
  return out
}

/** Total count of carried items whose names are in `nameSet`. */
function countItemsInSet (bot, nameSet) {
  if (!bot?.inventory || !nameSet?.size) return 0
  let total = 0
  for (const it of bot.inventory.items()) {
    if (nameSet.has(it.name)) total += Number(it.count) || 0
  }
  return total
}

/** Snapshot inventory counts for a set of names (or all items if null). */
function inventorySnapshot (bot, nameSet = null) {
  const counts = new Map()
  if (!bot?.inventory) return counts
  for (const it of bot.inventory.items()) {
    if (nameSet && !nameSet.has(it.name)) continue
    counts.set(it.name, (counts.get(it.name) || 0) + (Number(it.count) || 0))
  }
  return counts
}

/** Positive deltas between two inventory snapshots. */
function diffSnapshots (before, after) {
  const gained = {}
  let total = 0
  for (const [name, count] of after.entries()) {
    const d = count - (before.get(name) || 0)
    if (d > 0) {
      gained[name] = d
      total += d
    }
  }
  return { gained, total }
}

/** True if entity is a dropped item stack in the world. */
function isDroppedItem (e) {
  if (!e || !e.position) return false
  const name = String(e.name || '').toLowerCase()
  const display = String(e.displayName || '').toLowerCase()
  return name === 'item' || display === 'item'
}

/** True when a higher-priority reflex (e.g. flee/combat) currently owns the body. */
function isPreempted (skills) {
  if (!skills?.lane) return false
  if (skills.lane.active) return !skills.lane.isTop
  const owner = skills.arbiter?.owner
  return Boolean(owner && owner !== skills.lane)
}

/**
 * Craft an item inside an existing `_run` token without cancelling it.
 * Automatically places a carried crafting table if needed.
 */
async function craftWithinToken (skills, token, itemName, count = 1) {
  const bot = skills.bot
  const want = fold(itemName).replace(/\s+/g, '_')
  if (!want || token?.cancelled) return { ok: false, count: 0 }
  const approach = async (table) => {
    const ap = await skills._approachBlock(token, table.position)
    return ap.ok ? { ok: true } : { ok: false, why: ap.why }
  }
  let r = await craftItem(bot, want, { approach })
  if (!r.ok && r.why === 'need_crafting_table' && !token?.cancelled && skills._item?.('crafting_table')) {
    const spot = await skills._placeCarried?.('crafting_table')
    if (spot) r = await craftItem(bot, want, { approach })
  }
  if (!r.ok) return { ok: false, count: 0, why: r.why }
  const wantN = Math.max(1, Math.min(256, Math.trunc(Number(count)) || 1))
  let made = r.count || 1
  while (made < wantN && !token?.cancelled) {
    const more = await craftItem(bot, want, { approach })
    if (!more.ok) break
    made += more.count || 1
  }
  return { ok: true, item: r.item || want, count: made }
}

/**
 * Walk over nearby dropped item entities around `center` to actively pick up
 * drops rather than leaving mined/hunted items on the floor.
 *
 * Honours `token.cancelled` and reflex preemption (`isPreempted(skills)`).
 */
async function collectNearbyDrops (skills, token, center, {
  radius = 6.5,
  maxWalks = 5,
  expectedItems = null,
  settleMs = 260,
  walkTimeoutMs = 4500
} = {}) {
  const bot = skills.bot
  if (!bot?.entity?.position || !center) return { walks: 0, remaining: 0, delta: 0, gained: {} }
  const before = inventorySnapshot(bot, expectedItems)
  if (settleMs > 0) await sleep(settleMs)

  let walks = 0
  const visited = new Set()
  const { GoalNear } = skills._goals()

  while (walks < maxWalks && !token?.cancelled) {
    if (isPreempted(skills)) break
    const drops = []
    for (const e of Object.values(bot.entities || {})) {
      if (!isDroppedItem(e) || visited.has(e.id)) continue
      const dc = Math.hypot(e.position.x - center.x, e.position.z - center.z)
      const dy = Math.abs(e.position.y - center.y)
      if (dc <= radius && dy <= 4) {
        drops.push({ entity: e, dist: bot.entity.position.distanceTo(e.position) })
      }
    }
    if (!drops.length) break
    drops.sort((a, b) => a.dist - b.dist)
    const next = drops[0].entity
    visited.add(next.id)
    if (drops[0].dist <= 1.2) {
      await sleep(160)
      continue
    }
    walks++
    const p = next.position
    try {
      await skills._walk(token, new GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 0), {
        timeoutMs: walkTimeoutMs,
        done: () => !bot.entities?.[next.id] || bot.entity.position.distanceTo(p) <= 1.2
      })
    } catch { /* drop may have been picked up mid-step */ }
    await sleep(180)
  }

  let remaining = 0
  for (const e of Object.values(bot.entities || {})) {
    if (!isDroppedItem(e)) continue
    if (Math.hypot(e.position.x - center.x, e.position.z - center.z) <= radius && Math.abs(e.position.y - center.y) <= 4) {
      remaining++
    }
  }
  const after = inventorySnapshot(bot, expectedItems)
  const diff = diffSnapshots(before, after)
  return { walks, remaining, delta: diff.total, gained: diff.gained }
}

/** Best carried pickaxe tier (0=wood, 1=stone, 2=iron, 3=diamond, 4=netherite, -1=none). */
function heldPickaxeTier (item, tiers) {
  return item?.name?.endsWith('_pickaxe') ? (tiers[item.name.split('_')[0]] ?? -1) : -1
}

function bestPickaxeTier (bot, TOOL_TIERS) {
  const picks = (bot.inventory?.items?.() || []).filter((i) => /_pickaxe$/.test(i.name))
  return picks.reduce((m, p) => Math.max(m, TOOL_TIERS[p.name.split('_')[0]] ?? 0), -1)
}

/**
 * Attempt to ensure at least `needTier` pickaxe (0 = wooden, 1 = stone) using
 * carried materials before mining. Purely opportunistic: if materials are not
 * carried, returns `{ ok: false, reason }` honestly without wandering off.
 */
async function ensurePickaxeTier (skills, token, needTier, TOOL_TIERS) {
  const bot = skills.bot
  if (bestPickaxeTier(bot, TOOL_TIERS) >= needTier) return { ok: true, crafted: null }
  if (needTier > 1) return { ok: false, reason: 'higher-tier pickaxe must be crafted or retrieved first' }

  const wantName = needTier === 1 ? 'stone_pickaxe' : 'wooden_pickaxe'
  const count = (re) => (bot.inventory?.items?.() || []).filter((i) => (typeof re === 'string' ? i.name === re : re.test(i.name))).reduce((s, i) => s + i.count, 0)
  const logs = (bot.inventory?.items?.() || []).filter((i) => /(_log|_stem|_hyphae)$/.test(i.name))

  if (count(/_planks$/) < 4 && logs.length) {
    const planksName = logs[0].name.replace(/(_log|_stem|_hyphae)$/, '_planks')
    await craftWithinToken(skills, token, planksName, 4).catch(() => {})
  }
  if (count('stick') < 2 && count(/_planks$/) >= 2) {
    await craftWithinToken(skills, token, 'stick', 4).catch(() => {})
  }
  const hasTableNear = Boolean(skills._resolveBlock?.('crafting_table', new Set(['table'])))
  if (!hasTableNear && count('crafting_table') === 0 && count(/_planks$/) >= 4) {
    await craftWithinToken(skills, token, 'crafting_table', 1).catch(() => {})
  }
  if (wantName === 'wooden_pickaxe' && count(/_planks$/) >= 3 && count('stick') >= 2) {
    const res = await craftWithinToken(skills, token, 'wooden_pickaxe', 1).catch(() => ({ ok: false }))
    if (res?.ok) return { ok: true, crafted: 'wooden_pickaxe' }
  }
  if (wantName === 'stone_pickaxe' && count('cobblestone') >= 3 && count('stick') >= 2) {
    const res = await craftWithinToken(skills, token, 'stone_pickaxe', 1).catch(() => ({ ok: false }))
    if (res?.ok) return { ok: true, crafted: 'stone_pickaxe' }
  }
  return { ok: false, reason: `cannot auto-craft ${wantName} from current inventory` }
}

/**
 * High-level procedure: mine/harvest a resource, actively collect drops, and
 * verify actual inventory increase.
 */
function mineResource (skills, {
  item,
  count = 4,
  radius = 32,
  ensureTool = true,
  guard = null,
  resolveGatherTargets,
  HARVEST_NEED,
  TOOL_TIERS
} = {}) {
  const bot = skills.bot
  const TOOL_NAMES = ['wooden', 'stone', 'iron', 'diamond']
  return skills._run('mine_resource', async (token) => {
    const want = fold(item).replace(/\s+/g, '_')
    const targets = resolveGatherTargets(bot.registry, want)
    if (!targets) {
      return fail(`"${item || ''}" is not a mineable resource (use e.g. oak_log, wood, stone, coal, iron, diamond, sand).`)
    }
    token.label = `mining ${want}`
    skills.lane?.acquire?.({ reason: token.label })
    const need = Math.max(...targets.names.map((n) => HARVEST_NEED[n] ?? -1))
    let craftedToolNote = ''
    if (need >= 0 && bestPickaxeTier(bot, TOOL_TIERS) < need) {
      if (ensureTool) {
        const prep = await ensurePickaxeTier(skills, token, need, TOOL_TIERS)
        if (prep.ok && prep.crafted) craftedToolNote = ` (crafted ${prep.crafted})`
      }
      if (bestPickaxeTier(bot, TOOL_TIERS) < need) {
        const picks = bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name))
        return fail(`need at least a ${TOOL_NAMES[need]} pickaxe to mine ${targets.names[0]} (carrying: ${picks.map((p) => p.name).join(', ') || 'none'})`)
      }
    }

    const wanted = Math.max(1, Math.min(64, Math.trunc(Number(count)) || 4))
    const effRadius = Math.max(4, Math.min(48, Math.trunc(Number(radius)) || 32))
    const expectedDrops = expectedDropsFor(targets.names)
    const beforeSnap = inventorySnapshot(bot, expectedDrops)
    const beforeTotal = countItemsInSet(bot, expectedDrops)

    let dug = 0
    let misses = 0
    let dropWalks = 0
    const skippedKeys = new Set()
    let protectedReason = ''
    const deadline = Date.now() + (skills.choreTimeoutMs || 240_000)

    while (dug < wanted && misses < 5 && Date.now() < deadline) {
      if (token.cancelled) break
      // Wait smoothly while a survival reflex (e.g. creeper flee) owns the body
      if (isPreempted(skills)) {
        await sleep(350)
        continue
      }
      let allPos = []
      try { allPos = findBlocksFast(bot, targets.ids, { maxDistance: effRadius, count: 24 }) } catch (err) {
        return fail(`resource scan failed: ${err.message || err}`)
      }
      if (!allPos.length) {
        if (dug > 0) break
        return fail(skills._gatherMiss(want, targets, effRadius))
      }
      const candidates = []
      for (const p of allPos) {
        const k = `${p.x},${p.y},${p.z}`
        if (skippedKeys.has(k)) continue
        const g = typeof guard === 'function' ? guard(p) : null
        if (g && g.ok === false) {
          skippedKeys.add(k)
          if (!protectedReason) protectedReason = g.reason || 'protected player property'
          continue
        }
        candidates.push(p)
        if (candidates.length >= 8) break
      }
      if (!candidates.length) {
        if (dug > 0) break
        return fail(`cannot mine ${want} here: nearby targets are ${protectedReason || 'protected'}`)
      }
      for (const p of candidates) {
        if (dug >= wanted || token.cancelled || Date.now() >= deadline) break
        if (isPreempted(skills)) { await sleep(350); break }
        const near = await skills._walk(token, new (skills._goals().GoalGetToBlock)(p.x, p.y, p.z))
        if (!near.ok) { misses++; skippedKeys.add(`${p.x},${p.y},${p.z}`); continue }
        const block = bot.blockAt(p)
        if (!block || !targets.names.includes(block.name)) continue
        if (isPreempted(skills) || token.cancelled) break
        await skills._equipToolFor(block.name)
        try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch { /* cosmetic */ }
        if (token.cancelled || isPreempted(skills)) break
        const current = bot.blockAt(p)
        if (!current || current.name !== block.name || current.stateId !== block.stateId) continue
        const allowed = typeof guard === 'function' ? guard(p) : null
        if (allowed?.ok === false) { skippedKeys.add(`${p.x},${p.y},${p.z}`); continue }
        const requiredTier = HARVEST_NEED[current.name] ?? -1
        if (requiredTier >= 0 && heldPickaxeTier(bot.heldItem, TOOL_TIERS) < requiredTier) {
          misses++
          continue
        }
        try {
          await bot.dig(current)
          const observed = bot.blockAt(p)
          if (!observed || observed.name === current.name) { misses++; continue }
          dug++
          const pickup = await collectNearbyDrops(skills, token, p, {
            radius: 5.5,
            maxWalks: 3,
            expectedItems: expectedDrops,
            settleMs: 280
          })
          dropWalks += pickup.walks
        } catch (err) {
          if (token.cancelled || isPreempted(skills)) break
          misses++
          skills.log('debug', `mine_resource dig failed at ${p.x},${p.y},${p.z}: ${err.message || err}`)
        }
      }
    }

    // Final sweep right around the bot for any stray drops
    if (dug > 0 && !token.cancelled && bot.entity?.position) {
      const finalSweep = await collectNearbyDrops(skills, token, bot.entity.position, {
        radius: 6.5,
        maxWalks: 4,
        expectedItems: expectedDrops,
        settleMs: 250
      })
      dropWalks += finalSweep.walks
    }

    const afterSnap = inventorySnapshot(bot, expectedDrops)
    const diff = diffSnapshots(beforeSnap, afterSnap)
    const afterTotal = countItemsInSet(bot, expectedDrops)
    const gainedSummary = Object.entries(diff.gained).map(([k, v]) => `${k} +${v}`).join(', ') || 'none detected'

    const meta = {
      progress: { done: dug, total: wanted },
      complete: dug >= wanted && diff.total > 0 && !token.cancelled,
      execution: token.cancelled ? 'cancelled' : dug >= wanted && diff.total > 0 ? 'completed' : dug > 0 ? 'partial' : 'failed',
      verification: diff.total > 0 ? 'inventory_delta_observed' : 'pickup_not_verified',
      evidence: { requestedBlocks: wanted, observedBlocksBroken: dug, remainingBlocks: Math.max(0, wanted - dug), gained: diff.gained },
      mined: dug,
      collected: diff.total,
      gained: diff.gained,
      inventoryTotal: afterTotal,
      dropWalks
    }
    if (dug > 0) {
      return ok(
        `mined ${dug}/${wanted} ${want}${craftedToolNote}, ${wanted - dug} blocks remaining; observed inventory gains: ${gainedSummary} (now carrying ${afterTotal} matching items; ${afterTotal - beforeTotal >= 0 ? `+${afterTotal - beforeTotal}` : afterTotal - beforeTotal} net)`,
        meta
      )
    }
    return fail(`could not mine ${want}: nearby blocks were unreachable or interrupted`, meta)
  })
}

/**
 * High-level procedure: safely hunt an eligible non-protected animal/mob for
 * food/materials and actively walk over and verify dropped loot.
 *
 * Strictly forbids hunting players, villagers, iron golems, named mobs, or
 * owned/tamed companions.
 */
function huntAndLoot (skills, combat, {
  target = 'food',
  count = 1,
  radius = 32,
  maxDurationMs = 90_000
} = {}) {
  const bot = skills.bot
  return skills._run('hunt_and_loot', async (token) => {
    const hp = Number(bot.health ?? 20)
    if (hp <= 6) return fail(`too hurt to hunt (${Math.round(hp)}/20 HP) — heal or eat first`)

    const q = fold(target).replace(/\s+/g, '_')
    const PROTECTED_HUNT_NAMES = new Set([
      'player', 'villager', 'wandering_trader', 'iron_golem', 'snow_golem',
      'allay', 'wolf', 'cat', 'horse', 'donkey', 'mule', 'camel', 'axolotl', 'parrot'
    ])
    if (q && PROTECTED_HUNT_NAMES.has(q)) {
      return fail(`refused: ${q} is protected — hunt_and_loot never targets players, villagers, iron golems, or companions`)
    }
    const wantAnyFood = !q || q === 'food' || q === 'animal' || q === 'animals' || q === 'meat'
    const wanted = Math.max(1, Math.min(8, Math.trunc(Number(count)) || 1))
    const effRadius = Math.max(8, Math.min(48, Math.trunc(Number(radius)) || 32))
    token.label = `hunting ${wantAnyFood ? 'food animals' : q}`

    const isEligible = (e) => {
      if (!e || e === bot.entity || !e.position) return false
      if (isPlayer(e)) return false
      if (isProtected(e, bot)) return false
      const name = fold(e.name || e.displayName)
      if (!name || name === 'item' || name === 'experience_orb' || name === 'creeper') return false
      if (wantAnyFood) return HUNTABLE_ANIMALS.has(name)
      return name === q || name.includes(q)
    }

    const equipBestWeapon = async () => {
      try {
        const items = bot.inventory.items()
        const rank = (name) => {
          if (/netherite_sword/.test(name)) return 90
          if (/diamond_sword/.test(name)) return 85
          if (/iron_sword/.test(name)) return 75
          if (/stone_sword/.test(name)) return 65
          if (/wooden_sword|golden_sword/.test(name)) return 55
          if (/netherite_axe/.test(name)) return 80
          if (/diamond_axe/.test(name)) return 76
          if (/iron_axe/.test(name)) return 68
          if (/stone_axe/.test(name)) return 58
          if (/wooden_axe/.test(name)) return 48
          return 0
        }
        const best = items.slice().sort((a, b) => rank(b.name) - rank(a.name))[0]
        if (best && rank(best.name) > 0 && bot.heldItem?.name !== best.name) {
          await bot.equip(best, 'hand')
        }
      } catch { /* best-effort */ }
    }

    const beforeAll = inventorySnapshot(bot)
    let kills = 0
    const huntedKinds = new Map()
    const deadline = Date.now() + maxDurationMs
    skills.lane?.acquire?.({ reason: token.label })

    while (kills < wanted && Date.now() < deadline && !token.cancelled) {
      if (Number(bot.health ?? 20) <= 6) break
      if (isPreempted(skills)) { await sleep(350); continue }
      const pos = bot.entity?.position
      if (!pos) break
      const candidates = Object.values(bot.entities || {})
        .filter((e) => isEligible(e) && e.position.distanceTo(pos) <= effRadius)
        .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))

      if (!candidates.length) {
        if (kills > 0) break
        return fail(`no eligible ${wantAnyFood ? 'food animals (cow/pig/sheep/chicken/rabbit)' : q} within ${effRadius} blocks`)
      }

      const prey = candidates[0]
      const preyName = fold(prey.name || 'animal')
      let lastKnownPos = prey.position.clone()
      await equipBestWeapon()

      const { GoalFollow } = skills._goals()
      const killDeadline = Math.min(deadline, Date.now() + 20_000)
      let killed = false
      let lastSwing = 0

      while (Date.now() < killDeadline && !token.cancelled) {
        if (Number(bot.health ?? 20) <= 6) break
        if (isPreempted(skills)) { await sleep(350); continue }
        const livePrey = bot.entities?.[prey.id]
        if (!livePrey || !livePrey.position) {
          killed = true
          break
        }
        lastKnownPos = livePrey.position.clone()
        const d = bot.entity.position.distanceTo(livePrey.position)
        if (d > 2.9) {
          const walkRes = await skills._walk(token, new GoalFollow(livePrey, 2), {
            dynamic: true,
            timeoutMs: 4500,
            done: () => !bot.entities?.[prey.id] || bot.entity.position.distanceTo(livePrey.position) <= 2.8
          })
          if (!walkRes.ok && !bot.entities?.[prey.id]) { killed = true; break }
          if (!walkRes.ok) break
        }
        if (!bot.entities?.[prey.id]) { killed = true; break }
        if (isPreempted(skills) || token.cancelled) break
        const now = Date.now()
        if (now - lastSwing >= 600) {
          lastSwing = now
          await equipBestWeapon()
          try { await bot.lookAt(livePrey.position.offset(0, 0.7, 0), true) } catch { /* cosmetic */ }
          try { bot.attack(livePrey) } catch { /* entity vanished */ }
        }
        await sleep(160)
      }

      if (killed || !bot.entities?.[prey.id]) {
        kills++
        huntedKinds.set(preyName, (huntedKinds.get(preyName) || 0) + 1)
        const expectedLoot = new Set(LOOT_ITEMS_FOR_MOB[preyName] || [])
        await collectNearbyDrops(skills, token, lastKnownPos, {
          radius: 7.0,
          maxWalks: 5,
          expectedItems: expectedLoot.size ? expectedLoot : null,
          settleMs: 360
        })
      } else {
        // Could not finish this target; move on or abort if nothing else left
        break
      }
    }

    const afterAll = inventorySnapshot(bot)
    const diff = diffSnapshots(beforeAll, afterAll)
    const lootSummary = Object.entries(diff.gained).map(([k, v]) => `${k} +${v}`).join(', ') || 'no drops picked up'
    const kindsSummary = [...huntedKinds.entries()].map(([k, v]) => `${k} x${v}`).join(', ')
    const meta = {
      progress: { done: kills, total: wanted },
      complete: kills >= wanted && !token.cancelled,
      kills,
      loot: diff.gained,
      lootCount: diff.total
    }
    if (kills > 0) {
      return ok(`hunted ${kindsSummary}; verified loot collected: ${lootSummary}`, meta)
    }
    return fail(`could not complete hunt for ${wantAnyFood ? 'food animals' : q} (interrupted or target escaped)`, meta)
  })
}

/**
 * Count total edible hunger points currently carried (excluding risky raw chicken/rotten flesh).
 */
function carriedFoodSummary (bot) {
  const items = bot?.inventory?.items?.() || []
  let cookedPoints = 0
  let cookedCount = 0
  let rawCount = 0
  const rawItems = []
  let wheatCount = 0
  for (const it of items) {
    if (it.name === 'wheat') wheatCount += it.count
    const info = FOODS[it.name]
    if (!info) continue
    if (RAW_TO_COOKED[it.name]) {
      rawCount += it.count
      rawItems.push(it)
    } else if (!info.risky && !info.raw) {
      cookedCount += it.count
      cookedPoints += info.points * it.count
    }
  }
  return { cookedCount, cookedPoints, rawCount, rawItems, wheatCount }
}

/**
 * High-level procedure: prepare edible food from inventory — crafts bread from
 * wheat when available, cooks raw meat/potatoes in a nearby or crafted furnace
 * (collecting cooked output when quick), and optionally eats if hungry.
 */
function prepareFood (skills, {
  item = '',
  count = 4,
  eatAfter = false,
  waitForSmelt = true
} = {}) {
  const bot = skills.bot
  return skills._run('prepare_food', async (token) => {
    token.label = 'preparing food'
    skills.lane?.acquire?.({ reason: token.label })
    const steps = []
    let didProgress = false
    const summaryBefore = carriedFoodSummary(bot)
    const wanted = Math.max(1, Math.min(32, Math.trunc(Number(count)) || 4))

    // 1. Craft bread from carried wheat if we have >= 3 wheat and either requested bread or general food
    const req = fold(item).replace(/\s+/g, '_')
    if ((!req || req === 'bread' || req === 'wheat') && summaryBefore.wheatCount >= 3) {
      const loaves = Math.min(wanted, Math.floor(summaryBefore.wheatCount / 3))
      if (loaves > 0) {
        let res = await craftWithinToken(skills, token, 'bread', loaves).catch(() => ({ ok: false }))
        if (!res?.ok && res?.why === 'need_crafting_table' && !token.cancelled) {
          // Auto-craft a crafting table from carried logs/planks if available
          const items = bot.inventory.items()
          const planksCount = items.filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0)
          const logItem = items.find((i) => /(_log|_stem|_hyphae)$/.test(i.name))
          if (planksCount < 4 && logItem) {
            const planksName = logItem.name.replace(/(_log|_stem|_hyphae)$/, '_planks')
            await craftWithinToken(skills, token, planksName, 4).catch(() => {})
          }
          const planksNow = bot.inventory.items().filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0)
          if (planksNow >= 4 && !bot.inventory.items().some((i) => i.name === 'crafting_table')) {
            const tbl = await craftWithinToken(skills, token, 'crafting_table', 1).catch(() => ({ ok: false }))
            if (tbl?.ok) steps.push('crafted crafting_table')
          }
          res = await craftWithinToken(skills, token, 'bread', loaves).catch(() => ({ ok: false }))
        }
        if (res?.ok) {
          didProgress = true
          steps.push(`crafted bread x${res.count || loaves}`)
        } else if (res?.why) {
          steps.push(`could not craft bread from ${summaryBefore.wheatCount} wheat (${res.why})`)
        }
      }
    }

    // 2. Smelt/cook raw food if carried
    const itemsNow = bot.inventory.items()
    const rawPool = itemsNow.filter((i) => RAW_TO_COOKED[i.name] && (!req || i.name === req || RAW_TO_COOKED[i.name] === req))
    if (rawPool.length && !token.cancelled) {
      // Pick highest-value raw food first (beef/porkchop > mutton/salmon > chicken/cod/potato)
      const rank = { beef: 8, porkchop: 8, mutton: 6, salmon: 6, chicken: 5, rabbit: 5, cod: 5, potato: 4, kelp: 2 }
      rawPool.sort((a, b) => (rank[b.name] || 0) - (rank[a.name] || 0))
      const rawItem = rawPool[0]
      const cookedName = RAW_TO_COOKED[rawItem.name]
      const batch = Math.min(wanted, rawItem.count)

      // Locate an existing furnace/smoker nearby, or place one from inventory, or craft from 8 cobble
      let entry = skills._resolveBlock('furnace', new Set(['furnace']))
      if (!entry) {
        let carriedFurnace = bot.inventory.items().find((i) => i.name === 'furnace' || i.name === 'smoker')
        if (!carriedFurnace) {
          const cobble = bot.inventory.items().filter((i) => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0)
          if (cobble >= 8) {
            const crafted = await craftWithinToken(skills, token, 'furnace', 1).catch(() => ({ ok: false }))
            if (crafted?.ok) {
              steps.push('crafted furnace')
              carriedFurnace = bot.inventory.items().find((i) => i.name === 'furnace')
            }
          }
        }
        if (carriedFurnace && typeof skills._placeCarried === 'function') {
          const placedPos = await skills._placeCarried(carriedFurnace.name)
          if (placedPos) {
            steps.push(`placed ${carriedFurnace.name} at ${placedPos.x},${placedPos.y},${placedPos.z}`)
            try { skills.places.scan(bot, { force: true }) } catch { /* best-effort */ }
            entry = skills._resolveBlock('furnace', new Set(['furnace']))
          }
        }
      }

      if (entry) {
        const fuel = bot.inventory.items().find((i) => i.name !== rawItem.name && (FUEL_ITEMS.has(i.name) || WOOD_FUEL_RE.test(i.name)))
        if (fuel) {
          const { win, err } = await skills._open(token, entry)
          if (!err && win) {
            try {
              const haveFuel = bot.inventory.items().filter((i) => i.name === fuel.name).reduce((s, i) => s + i.count, 0)
              const needFuel = Math.min(haveFuel, Math.max(1, Math.ceil(batch / (fuel.name === 'coal' || fuel.name === 'charcoal' ? 8 : 1.5))))
              if (!win.fuelItem()) await win.putFuel(fuel.type, null, needFuel)
              await win.putInput(rawItem.type, null, batch)
              didProgress = true
              steps.push(`loaded ${rawItem.name} x${batch} + ${fuel.name} x${needFuel} into ${entry.id}`)

              // For quick batches (<= 3 items), wait and take cooked output immediately
              const shouldWait = waitForSmelt && batch <= 3
              if (shouldWait) {
                const waitDeadline = Date.now() + batch * 10_800 + 2500
                let taken = 0
                while (taken < batch && Date.now() < waitDeadline && !token.cancelled && !isPreempted(skills)) {
                  const out = win.outputItem?.()
                  if (out && out.count > 0) {
                    try {
                      await win.takeOutput()
                      taken += out.count
                    } catch { /* retry next poll */ }
                  }
                  if (taken < batch) await sleep(600)
                }
                if (taken > 0) steps.push(`collected ${cookedName} x${taken}`)
              } else {
                steps.push(`smelting in progress (~${batch * 10}s) — collect ${cookedName} from ${entry.id}`)
              }
            } finally {
              try { win.close() } catch { /* already closed */ }
            }
          } else {
            steps.push(`could not open ${entry.id}: ${err || 'unreachable'}`)
          }
        } else {
          steps.push(`have ${rawItem.name} x${rawItem.count} but no furnace fuel (need coal, charcoal, planks, or logs)`)
        }
      } else {
        steps.push(`have ${rawItem.name} x${rawItem.count} but no furnace nearby (and <8 cobblestone to craft one)`)
      }
    }

    // 3. Optionally eat if requested and hungry/hurt
    if (eatAfter && !token.cancelled && (Number(bot.food ?? 20) < 18 || Number(bot.health ?? 20) < 16)) {
      const foodChoice = chooseFood(bot.inventory.items(), { food: Number(bot.food ?? 20), health: Number(bot.health ?? 20), healing: true })
      if (foodChoice) {
        const eatRes = await skills.arbiter.useHand('eat', foodChoice, () => bot.consume(), { priority: PRIORITY.task, restore: true }).catch(() => ({ ok: false }))
        if (eatRes?.ok) {
          didProgress = true
          steps.push(`ate ${foodChoice.name}`)
        }
      }
    }

    const summaryAfter = carriedFoodSummary(bot)
    const meta = {
      cookedBefore: summaryBefore.cookedCount,
      cookedAfter: summaryAfter.cookedCount,
      rawRemaining: summaryAfter.rawCount,
      steps
    }
    if (didProgress) {
      return ok(`prepare_food: ${steps.join('; ')} (carrying ${summaryAfter.cookedCount} cooked items, ${summaryAfter.rawCount} raw)`, meta)
    }
    if (steps.length) {
      return fail(`prepare_food: ${steps.join('; ')} (carrying ${summaryAfter.cookedCount} cooked items, ${summaryAfter.rawCount} raw)`, meta)
    }
    if (summaryAfter.cookedCount > 0) {
      return ok(`already carrying ready food (${summaryAfter.cookedCount} cooked items, ${summaryAfter.cookedPoints} hunger pts)`, meta)
    }
    return fail('no wheat or raw food to prepare — hunt animals (hunt_and_loot) or harvest crops first', meta)
  })
}

module.exports = {
  DROP_ITEMS_FOR_BLOCK,
  RAW_TO_COOKED,
  HUNTABLE_ANIMALS,
  LOOT_ITEMS_FOR_MOB,
  expectedDropsFor,
  collectNearbyDrops,
  mineResource,
  huntAndLoot,
  prepareFood,
  carriedFoodSummary
}
