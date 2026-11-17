/**
 * survival_planner.js — autonomous survival need assessment & routine planner.
 *
 * Continuously evaluates:
 *   1. Hunger & food reserves (cooked vs raw food, wheat, nearby food animals)
 *   2. Tool availability & durability (pickaxe, axe, sword, shovel)
 *   3. Essential materials (wood, stone/cobblestone, coal/fuel, iron)
 *
 * Separates URGENT survival needs (starving / critically hurt without ready
 * food — allowed to pause an ordinary objective and resume it afterwards) from
 * ROUTINE upkeep (cooking raw meat, replacing worn/missing tools, stocking
 * essentials when idle AND local ingredients/blocks/animals actually exist).
 */
'use strict'

const { FOODS } = require('./system1')
const { RAW_TO_COOKED, HUNTABLE_ANIMALS, carriedFoodSummary } = require('./procedures')
const { isProtected, isPlayer } = require('./threats')
const { findBlocksFast } = require('./block_search')

/** Vanilla max durability fallback by tool material prefix. */
const MATERIAL_MAX_DURABILITY = {
  wooden: 59,
  golden: 32,
  stone: 131,
  iron: 250,
  diamond: 1561,
  netherite: 2031
}

const TOOL_KINDS = ['pickaxe', 'sword', 'axe', 'shovel']
const TOOL_RE = /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|sword|axe|shovel)$/

/** Inspect durability & availability of carried tools. */
function inspectTools (bot) {
  const items = bot?.inventory?.items?.() || []
  const byKind = { pickaxe: [], sword: [], axe: [], shovel: [] }
  const lowDurability = []

  for (const it of items) {
    if (!it?.name) continue
    const m = TOOL_RE.exec(it.name)
    if (!m) continue
    const material = m[1]
    const kind = m[2]
    const regMax = bot?.registry?.items?.[it.type]?.maxDurability
    const maxDur = Number(regMax) || MATERIAL_MAX_DURABILITY[material] || 131
    const used = Number(it.durabilityUsed ?? it.nbt?.value?.Damage?.value ?? 0)
    const remaining = Math.max(0, maxDur - used)
    const ratio = maxDur > 0 ? remaining / maxDur : 1
    const info = {
      name: it.name,
      material,
      kind,
      slot: it.slot,
      maxDur,
      used,
      remaining,
      ratio: Math.round(ratio * 100) / 100
    }
    byKind[kind].push(info)
    if (remaining <= 14 || ratio <= 0.15) lowDurability.push(info)
  }

  const missing = TOOL_KINDS.filter((k) => byKind[k].length === 0)
  return { byKind, lowDurability, missing }
}

/** Count carried essential materials. */
function inspectEssentials (bot) {
  const items = bot?.inventory?.items?.() || []
  let logs = 0
  let planks = 0
  let sticks = 0
  let cobble = 0
  let coal = 0
  let torches = 0
  let iron = 0
  let rawIron = 0
  let craftingTable = 0
  let furnace = 0

  for (const it of items) {
    const c = Number(it.count) || 0
    if (/(_log|_stem|_hyphae)$/.test(it.name)) logs += c
    else if (/_planks$/.test(it.name)) planks += c
    else if (it.name === 'stick') sticks += c
    else if (it.name === 'cobblestone' || it.name === 'cobbled_deepslate') cobble += c
    else if (it.name === 'coal' || it.name === 'charcoal') coal += c
    else if (it.name === 'torch') torches += c
    else if (it.name === 'iron_ingot') iron += c
    else if (it.name === 'raw_iron') rawIron += c
    else if (it.name === 'crafting_table') craftingTable += c
    else if (it.name === 'furnace' || it.name === 'smoker') furnace += c
  }
  const woodEquiv = logs + Math.floor(planks / 4)
  return { logs, planks, woodEquiv, sticks, cobble, coal, torches, iron, rawIron, craftingTable, furnace }
}

/** Check whether any eligible food animal exists within `radius` blocks. */
function hasNearbyFoodAnimal (bot, radius = 32) {
  const pos = bot?.entity?.position
  if (!pos || !bot?.entities) return null
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue
    if (isPlayer(e) || isProtected(e, bot)) continue
    const name = String(e.name || '').toLowerCase()
    if (!HUNTABLE_ANIMALS.has(name)) continue
    const d = e.position.distanceTo(pos)
    if (d <= radius && d < bestDist) { bestDist = d; best = { name, distance: Math.round(d * 10) / 10 } }
  }
  return best
}

/** Check whether any block matching `names` exists within `radius` (cheap bounded scan). */
function hasNearbyBlock (bot, names, radius = 24) {
  if (!bot?.entity?.position || !bot?.registry?.blocksByName) return false
  const ids = []
  for (const n of names) {
    const b = bot.registry.blocksByName[n]
    if (b) ids.push(b.id)
  }
  if (!ids.length) return false
  try {
    const found = findBlocksFast(bot, ids, { maxDistance: radius, count: 1, budgetMs: 25 })
    return Boolean(found && found.length)
  } catch { return false }
}

/** Count all edible safe hunger points carried (including raw if desperate). */
function edibleReserve (bot) {
  const summary = carriedFoodSummary(bot)
  const items = bot?.inventory?.items?.() || []
  let anySafePoints = summary.cookedPoints
  for (const it of items) {
    const info = FOODS[it.name]
    if (info && info.raw && !info.risky) anySafePoints += info.points * it.count
  }
  return { ...summary, anySafePoints }
}

class SurvivalPlanner {
  constructor ({
    now = () => Date.now(),
    enabled = true,
    minCookedPoints = 20,
    urgentFoodThreshold = 8,
    urgentHealthThreshold = 12,
    idleGraceMs = 20_000,
    needCooldownMs = 90_000,
    urgentCooldownMs = 25_000,
    scanRadius = 24
  } = {}) {
    this.now = now
    this.enabled = enabled
    this.minCookedPoints = minCookedPoints
    this.urgentFoodThreshold = urgentFoodThreshold
    this.urgentHealthThreshold = urgentHealthThreshold
    this.idleGraceMs = idleGraceMs
    this.needCooldownMs = needCooldownMs
    this.urgentCooldownMs = urgentCooldownMs
    this.scanRadius = scanRadius
    this._cooldowns = new Map() // needKey -> untilMs
    this._lastAssessment = null
    this._lastScanAt = 0
  }

  reset () {
    this._cooldowns.clear()
    this._lastAssessment = null
    this._lastScanAt = 0
  }

  markAttempted (key, { urgent = false } = {}) {
    const cd = urgent ? this.urgentCooldownMs : this.needCooldownMs
    this._cooldowns.set(key, this.now() + cd)
  }

  _onCooldown (key, t) {
    return (this._cooldowns.get(key) || 0) > t
  }

  /**
   * Pure assessment of current survival state & ranked needs.
   * Returns `{ hp, food, reserve, tools, essentials, urgent, routine, topNeed }`.
   */
  assess (bot, { scanWorld = true } = {}) {
    const t = this.now()
    const hp = Number(bot?.health ?? 20)
    const food = Number(bot?.food ?? 20)
    const reserve = edibleReserve(bot)
    const tools = inspectTools(bot)
    const essentials = inspectEssentials(bot)

    const urgent = []
    const routine = []

    const hasFuel = essentials.coal > 0 || essentials.logs > 0 || essentials.planks >= 2 || essentials.sticks >= 2
    const hasFurnaceOrCobble = essentials.furnace > 0 || essentials.cobble >= 8 || (scanWorld && hasNearbyBlock(bot, ['furnace', 'smoker'], 16))
    const canPrepareFood = (reserve.wheatCount >= 3) || (reserve.rawCount > 0 && hasFuel && hasFurnaceOrCobble)
    const nearbyPrey = hasNearbyFoodAnimal(bot, 32)

    // --- 1. Food & hunger needs --------------------------------------------
    const hungryNow = food <= this.urgentFoodThreshold || (hp <= this.urgentHealthThreshold && food < 18)
    if (hungryNow && reserve.cookedCount === 0) {
      if (canPrepareFood) {
        urgent.push({
          key: 'urgent_prepare_food',
          tier: 'urgent',
          priority: 92,
          title: 'Prepare and eat food immediately',
          tool: 'prepare_food',
          args: { count: Math.min(4, Math.max(1, reserve.rawCount || Math.floor(reserve.wheatCount / 3))), eat_after: true },
          reason: `food ${Math.round(food)}/20, hp ${Math.round(hp)}/20, 0 cooked food (${reserve.rawCount} raw, ${reserve.wheatCount} wheat)`
        })
      } else if (nearbyPrey && hp > 6) {
        urgent.push({
          key: 'urgent_hunt_food',
          tier: 'urgent',
          priority: 88,
          title: `Hunt ${nearbyPrey.name} for food`,
          tool: 'hunt_and_loot',
          args: { target: nearbyPrey.name, count: 2, radius: 32 },
          reason: `food ${Math.round(food)}/20, no cooked food; ${nearbyPrey.name} spotted ${nearbyPrey.distance}m away`
        })
      }
    } else if (reserve.cookedPoints < this.minCookedPoints) {
      if (canPrepareFood && (reserve.rawCount >= 2 || reserve.wheatCount >= 3)) {
        routine.push({
          key: 'routine_prepare_food',
          tier: 'routine',
          priority: 62,
          title: 'Cook raw food / craft bread reserves',
          tool: 'prepare_food',
          args: { count: Math.min(4, Math.max(1, reserve.rawCount || Math.floor(reserve.wheatCount / 3))), eat_after: food < 16 },
          reason: `low ready food (${reserve.cookedPoints} pts); carrying ${reserve.rawCount} raw + ${reserve.wheatCount} wheat`
        })
      } else if (nearbyPrey && reserve.cookedCount === 0 && reserve.rawCount < 2) {
        routine.push({
          key: 'routine_hunt_food',
          tier: 'routine',
          priority: 56,
          title: `Hunt ${nearbyPrey.name} to stock food`,
          tool: 'hunt_and_loot',
          args: { target: nearbyPrey.name, count: 2, radius: 32 },
          reason: `no food reserves; ${nearbyPrey.name} nearby (${nearbyPrey.distance}m)`
        })
      }
    }

    // --- 2. Tool availability & durability ---------------------------------
    const pickLow = tools.lowDurability.find((x) => x.kind === 'pickaxe')
    const swordLow = tools.lowDurability.find((x) => x.kind === 'sword')
    const needPick = tools.byKind.pickaxe.length === 0 || (tools.byKind.pickaxe.length === 1 && Boolean(pickLow))
    const needSword = tools.byKind.sword.length === 0 || (tools.byKind.sword.length === 1 && Boolean(swordLow))

    if (needPick) {
      const canCraftStone = essentials.cobble >= 3 && (essentials.sticks >= 2 || essentials.planks >= 2 || essentials.logs >= 1)
      const canCraftWood = essentials.planks >= 3 && (essentials.sticks >= 2 || essentials.planks >= 5 || essentials.logs >= 2)
      if (canCraftStone) {
        routine.push({
          key: 'routine_craft_stone_pickaxe',
          tier: 'routine',
          priority: 60,
          title: 'Craft replacement stone pickaxe',
          tool: 'craft',
          args: { item: 'stone_pickaxe', count: 1 },
          reason: pickLow ? `pickaxe almost broken (${pickLow.remaining}/${pickLow.maxDur})` : 'no pickaxe carried'
        })
      } else if (canCraftWood) {
        routine.push({
          key: 'routine_craft_wooden_pickaxe',
          tier: 'routine',
          priority: 58,
          title: 'Craft wooden pickaxe',
          tool: 'craft',
          args: { item: 'wooden_pickaxe', count: 1 },
          reason: pickLow ? `pickaxe almost broken (${pickLow.remaining}/${pickLow.maxDur})` : 'no pickaxe carried'
        })
      }
    }

    if (needSword) {
      const canCraftIron = essentials.iron >= 2 && (essentials.sticks >= 1 || essentials.planks >= 2 || essentials.logs >= 1)
      const canCraftStone = essentials.cobble >= 2 && (essentials.sticks >= 1 || essentials.planks >= 2 || essentials.logs >= 1)
      if (canCraftIron) {
        routine.push({
          key: 'routine_craft_iron_sword',
          tier: 'routine',
          priority: 59,
          title: 'Craft iron sword for defense',
          tool: 'craft',
          args: { item: 'iron_sword', count: 1 },
          reason: swordLow ? `sword low durability (${swordLow.remaining}/${swordLow.maxDur})` : 'no sword carried'
        })
      } else if (canCraftStone) {
        routine.push({
          key: 'routine_craft_stone_sword',
          tier: 'routine',
          priority: 55,
          title: 'Craft stone sword for defense',
          tool: 'craft',
          args: { item: 'stone_sword', count: 1 },
          reason: swordLow ? `sword low durability (${swordLow.remaining}/${swordLow.maxDur})` : 'no sword carried'
        })
      }
    }

    // --- 3. Essential materials (only when genuinely available nearby) -----
    if (scanWorld) {
      if (essentials.woodEquiv < 3 && hasNearbyBlock(bot, ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'], this.scanRadius)) {
        routine.push({
          key: 'routine_gather_wood',
          tier: 'routine',
          priority: 52,
          title: 'Gather essential wood logs',
          tool: 'mine_resource',
          args: { item: 'log', count: 4, radius: this.scanRadius },
          reason: `low wood reserves (${essentials.logs} logs, ${essentials.planks} planks)`
        })
      }
      if (essentials.cobble < 8 && tools.byKind.pickaxe.length > 0 && hasNearbyBlock(bot, ['stone', 'cobblestone'], this.scanRadius)) {
        routine.push({
          key: 'routine_gather_stone',
          tier: 'routine',
          priority: 50,
          title: 'Mine cobblestone for tools/furnace',
          tool: 'mine_resource',
          args: { item: 'stone', count: 8, radius: this.scanRadius },
          reason: `low stone reserves (${essentials.cobble} cobble)`
        })
      }
      if (essentials.coal + essentials.torches < 4 && tools.byKind.pickaxe.length > 0 && hasNearbyBlock(bot, ['coal_ore', 'deepslate_coal_ore'], this.scanRadius)) {
        routine.push({
          key: 'routine_gather_coal',
          tier: 'routine',
          priority: 49,
          title: 'Mine coal for fuel and torches',
          tool: 'mine_resource',
          args: { item: 'coal', count: 4, radius: this.scanRadius },
          reason: `low fuel/light (${essentials.coal} coal, ${essentials.torches} torches)`
        })
      }
      const hasStonePlusPick = tools.byKind.pickaxe.some((p) => p.material !== 'wooden' && p.material !== 'golden')
      if (essentials.iron + essentials.rawIron < 3 && hasStonePlusPick && hasNearbyBlock(bot, ['iron_ore', 'deepslate_iron_ore'], this.scanRadius)) {
        routine.push({
          key: 'routine_gather_iron',
          tier: 'routine',
          priority: 48,
          title: 'Mine iron ore for gear',
          tool: 'mine_resource',
          args: { item: 'iron', count: 3, radius: this.scanRadius },
          reason: `low iron reserves (${essentials.iron} ingots, ${essentials.rawIron} raw)`
        })
      }
    }

    urgent.sort((a, b) => b.priority - a.priority)
    routine.sort((a, b) => b.priority - a.priority)
    const eligibleUrgent = urgent.filter((n) => !this._onCooldown(n.key, t))
    const eligibleRoutine = routine.filter((n) => !this._onCooldown(n.key, t))

    const res = {
      at: t,
      hp,
      food,
      reserve,
      tools,
      essentials,
      urgent,
      routine,
      topNeed: eligibleUrgent[0] || eligibleRoutine[0] || null,
      topUrgent: eligibleUrgent[0] || null,
      topRoutine: eligibleRoutine[0] || null
    }
    this._lastAssessment = res
    return res
  }

  /**
   * Decide whether autonomous survival action should trigger right now.
   *
   * - Never interrupts combat or fleeing.
   * - URGENT needs may preempt an ordinary active objective (caller suspends it and resumes later).
   * - ROUTINE needs ONLY run when idle for at least `idleGraceMs` with no active goal.
   */
  decide (bot, {
    busy = false,
    fleeing = false,
    inCombat = false,
    hasActiveGoal = false,
    idleMs = 0
  } = {}) {
    if (!this.enabled || !bot?.entity || fleeing || inCombat) return null
    const t = this.now()
    const shouldScan = (t - this._lastScanAt) >= 4000
    if (shouldScan) this._lastScanAt = t
    const state = this.assess(bot, { scanWorld: shouldScan })

    if (state.topUrgent) {
      return { need: state.topUrgent, state, preemptObjective: Boolean(busy || hasActiveGoal) }
    }
    if (!busy && !hasActiveGoal && idleMs >= this.idleGraceMs && state.topRoutine) {
      return { need: state.topRoutine, state, preemptObjective: false }
    }
    return null
  }

  /** Short one-line survival status for the action prompt (null when healthy & well-supplied). */
  promptLine (bot) {
    if (!bot?.entity) return null
    const st = this.assess(bot, { scanWorld: false })
    const notes = []
    if (st.food <= this.urgentFoodThreshold && st.reserve.cookedCount === 0) {
      notes.push(`HUNGRY (${Math.round(st.food)}/20 food, 0 cooked${st.reserve.rawCount ? `, ${st.reserve.rawCount} raw — call prepare_food` : ' — hunt_and_loot or gather food'})`)
    } else if (st.reserve.cookedCount === 0 && st.reserve.rawCount >= 2) {
      notes.push(`carrying ${st.reserve.rawCount} raw food with 0 cooked (prepare_food when safe)`)
    } else if (st.reserve.cookedPoints === 0 && st.reserve.rawCount === 0 && st.food < 16) {
      notes.push(`low food (${Math.round(st.food)}/20) and carrying no edible food`)
    }
    if (st.tools.lowDurability.length) {
      const list = st.tools.lowDurability.slice(0, 2).map((x) => `${x.name} ${x.remaining}/${x.maxDur}`).join(', ')
      notes.push(`low tool durability: ${list}`)
    }
    if (!notes.length) return null
    return `survival: ${notes.join('; ')}`
  }
}

module.exports = {
  SurvivalPlanner,
  inspectTools,
  inspectEssentials,
  edibleReserve,
  hasNearbyFoodAnimal,
  MATERIAL_MAX_DURABILITY
}
