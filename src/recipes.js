/**
 * Recipe resolver — 100% local, zero LLM tokens.
 *
 * The LLM asks for {"a":"craft","i":"chest"}; THIS module figures out how —
 * recipes, ingredients, crafting-table requirements — using prismarine-recipe
 * directly against the exact registry mineflayer is running on (bot.registry,
 * which is prismarine-registry for the negotiated server version).
 *
 * Algorithm (mirrors mineflayer's own requirementsMetForRecipe):
 *   1. Resolve the item id from its name (bot.registry.itemsByName).
 *   2. Recipe.find(itemId, null) → all recipes producing it.
 *   3. For each recipe: subtract usage from the bot's inventory counts.
 *      - recipe needs a table? → look for one within REACH (8 blocks). If none,
 *        remember we *could* craft it with a table and keep looking.
 *      - all ingredient deltas satisfiable → pick it.
 *   4. Execute with bot.craft() (mineflayer's crafting executor — it performs
 *      the real window clicks, including opening the table).
 *
 * Everything returns a compact {ok, why?} object — that, not a recipe listing,
 * is what goes back to the AMD API as a delta. Tokens stay tiny.
 */
'use strict'

const { isValidItemName } = require('./actionParser')

const TABLE_REACH = 8

/** Find a crafting table block near the bot, or null. */
function findCraftingTable (bot) {
  const blockId = bot.registry?.blocksByName?.crafting_table?.id
  if (blockId === undefined) return null
  try {
    return bot.findBlock({ matching: blockId, maxDistance: TABLE_REACH })
  } catch {
    return null
  }
}

/**
 * Check whether the bot's inventory can satisfy a recipe's delta.
 * @returns {boolean}
 */
function canAfford (bot, recipe, minResultCount = 1) {
  const craftCount = Math.ceil(minResultCount / Math.max(1, recipe.result?.count || 1))
  for (const d of recipe.delta || []) {
    // d.count is negative for ingredients (they are consumed), positive for results.
    if (d.count >= 0) continue
    const have = bot.inventory.count(d.id, d.metadata)
    if (have + d.count * craftCount < 0) return false
  }
  return true
}

/**
 * Resolve the best executable recipe for `itemName`.
 * @returns {{ok:true, recipe:object, table:?object, item:object} | {ok:false, why:string}}
 */
function resolveRecipe (bot, itemName) {
  if (!isValidItemName(itemName)) {
    return { ok: false, why: 'bad_item_id' }
  }
  const registry = bot.registry
  if (!registry || !registry.itemsByName) {
    return { ok: false, why: 'registry_unavailable' }
  }
  const item = registry.itemsByName[itemName]
  if (!item) return { ok: false, why: 'unknown_item' }

  // prismarine-recipe against the *live* registry — never a stale hardcode.
  const { Recipe } = require('prismarine-recipe')(registry)
  const candidates = Recipe.find(item.id, null)
  if (!candidates.length) return { ok: false, why: 'no_recipe' }

  let blockedByTable = false
  for (const recipe of candidates) {
    let table = null
    if (recipe.requiresTable) {
      table = findCraftingTable(bot)
      if (!table) {
        blockedByTable = true
        continue // maybe another variant doesn't need a table (rare, but free to check)
      }
    }
    if (canAfford(bot, recipe, 1)) {
      return { ok: true, recipe, table, item }
    }
  }
  return blockedByTable ? { ok: false, why: 'need_crafting_table' } : { ok: false, why: 'missing_materials' }
}

/**
 * Craft one `itemName`. Never throws.
 *
 * audit2 B3/E: the table finder looks 8 m out but bot.craft needs the table
 * within interaction reach (~4.5 m), so a table 4.5-8 m away failed with a
 * window error and the model just retried forever. `approach` (optional)
 * walks the bot next to the table first; callers own HOW (ZincAI routes it
 * through the task control lane, Zinc through a guarded plain walk).
 *
 * @param {(table:object)=>Promise<{ok:boolean, why?:string}>} [opts.approach]
 * @returns {Promise<{ok:true, item:string, count:number} | {ok:false, why:string}>}
 */
async function craftItem (bot, itemName, { approach = null } = {}) {
  const resolved = resolveRecipe(bot, itemName)
  if (!resolved.ok) return resolved
  try {
    if (resolved.table && approach) {
      const me = bot.entity?.position
      const tp = resolved.table.position
      if (me && tp && me.distanceTo(tp) > 3.5) {
        const a = await approach(resolved.table)
        if (!a?.ok) return { ok: false, why: `table_unreachable:${a?.why || 'no path'}` }
      }
    }
    await bot.craft(resolved.recipe, 1, resolved.table || null)
    return { ok: true, item: itemName, count: resolved.recipe.result?.count || 1 }
  } catch (err) {
    const msg = String(err && err.message || err)
    // mineflayer throws "missing ingredient" mid-click if inventory shifted under us.
    const why = /missing ingredient/i.test(msg) ? 'missing_materials'
      : /requires craftingTable/i.test(msg) ? 'need_crafting_table'
        : /window/i.test(msg) ? 'table_window_failed'
          : 'craft_failed'
    return { ok: false, why }
  }
}

module.exports = { craftItem, resolveRecipe, canAfford, findCraftingTable, TABLE_REACH }
