/**
 * perception.js — frustum-culled perception for ZincAI.
 *
 * Never dumps the world into a prompt. Everything the bot "sees" is filtered:
 *
 *   entities : keep only entities inside the look cone (FOV) or very close.
 *   blocks   : scan a small box around the bot, keep cells inside the FOV
 *              cone, compress into a palette + run-length encoded voxel grid
 *              relative to the bot (origin = bot's feet cell).
 *
 * The grid format is line-per-Y-layer:
 *   L<yOffset> <paletteIdx>:<run>,<paletteIdx>:<run> ...   (per z-row: rows separated by ' | ')
 *
 * This is small enough (~100-300 tokens for a 10x5x10 slice) to inject
 * cheaply, and dense enough for Qwen to reason about immediate surroundings.
 */
'use strict'

const DEG = Math.PI / 180

/** Angle (radians) of the bot's horizontal look vector. */
function lookYaw (bot) {
  // mineflayer keeps yaw on bot.entity.yaw (radians, 0 = north / -z).
  return bot.entity ? bot.entity.yaw : 0
}

function lookPitch (bot) {
  return bot.entity ? bot.entity.pitch : 0
}

/** True if (dx,dz) from origin lies inside the horizontal FOV cone. */
function inHorizontalFov (yaw, dx, dz, fovRad) {
  const dist = Math.hypot(dx, dz)
  if (dist < 1.5) return true // peripheral presence, always notice
  // mineflayer yaw: 0 = -z (north); look vector (dx,dz) = (-sin(yaw), -cos(yaw)).
  // (The old +cos mirrored the cone whenever the bot faced north or south.)
  const lx = -Math.sin(yaw)
  const lz = -Math.cos(yaw)
  const dot = (dx * lx + dz * lz) / dist
  return dot >= Math.cos(fovRad / 2)
}

function inVerticalFov (pitch, dy, horizontalDist, fovRad) {
  if (horizontalDist < 1.5) return true
  const angle = Math.atan2(dy, horizontalDist)
  // Expand vertical slack by half the cone so looking up/down still sees ahead.
  return Math.abs(angle - pitch) <= fovRad / 2 + 0.35
}

/**
 * Gather visible blocks in a box, frustum-culled.
 * @returns {Array<{dx:number, dy:number, dz:number, name:string}>}
 */
function visibleBlocks (bot, { range = 10, fovDegrees = 90, heightUp = 3, heightDown = 2 } = {}) {
  const pos = bot.entity?.position
  if (!pos) return []
  const yaw = lookYaw(bot)
  const pitch = lookPitch(bot)
  const fovRad = fovDegrees * DEG
  const here = pos.floored()
  const out = []
  for (let dy = -heightDown; dy <= heightUp; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const dist = Math.hypot(dx, dy, dz)
        if (dist > range) continue
        const hd = Math.hypot(dx, dz)
        if (!inHorizontalFov(yaw, dx, dz, fovRad)) continue
        if (!inVerticalFov(pitch, dy, hd, fovRad)) continue
        let block
        try {
          block = bot.blockAt(here.offset(dx, dy, dz))
        } catch {
          continue // unloaded chunk — not "seen"
        }
        if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue
        out.push({ dx, dy, dz, name: block.name })
      }
    }
  }
  return out
}

/**
 * Compress visible blocks into a palette + RLE voxel grid string.
 * Origin is the bot's feet block. Returns { text, considered, paletteSize }.
 */
function buildVoxelGrid (blocks, { range = 10, heightUp = 3, heightDown = 2 } = {}) {
  if (!blocks.length) return { text: '(nothing visible)', considered: 0, paletteSize: 0 }
  const palette = []
  const paletteIndex = new Map()
  const idxFor = (name) => {
    if (!paletteIndex.has(name)) {
      paletteIndex.set(name, palette.length)
      palette.push(name)
    }
    return paletteIndex.get(name)
  }
  // y -> z -> list of [dx, palIdx]
  const cells = new Map()
  for (const { dx, dy, dz, name } of blocks) {
    const li = idxFor(name)
    const key = dy
    if (!cells.has(key)) cells.set(key, new Map())
    const zmap = cells.get(key)
    if (!zmap.has(dz)) zmap.set(dz, [])
    zmap.get(dz).push([dx, li])
  }
  const legend = palette.map((name, i) => `${i}=${name}`).join(' ')
  const lines = [`palette: ${legend}`]
  for (let dy = -heightDown; dy <= heightUp; dy++) {
    const zmap = cells.get(dy)
    if (!zmap) continue
    const rows = []
    const zs = [...zmap.keys()].sort((a, b) => a - b)
    for (const dz of zs) {
      const arr = zmap.get(dz).sort((a, b) => a[0] - b[0])
      // RLE along x
      const runs = []
      let lastIdx = -1
      let run = 0
      let lastX = null
      for (const [dx, pi] of arr) {
        if (pi === lastIdx && lastX !== null && dx === lastX + run) {
          run++
        } else {
          if (run > 0) runs.push(`${lastIdx}:${run}`)
          lastIdx = pi
          run = 1
          lastX = dx
        }
      }
      if (run > 0) runs.push(`${lastIdx}:${run}`)
      // encode as xStart:index x run… keep the x-offset since grid is sparse
      rows.push(`z${dz >= 0 ? '+' : ''}${dz} x${String(arr[0][0]).padStart(2, ' ')}… ${runs.join(',')}`)
    }
    lines.push(`L${dy >= 0 ? '+' : ''}${dy} ${rows.join(' | ')}`)
  }
  return { text: lines.join('\n'), considered: blocks.length, paletteSize: palette.length }
}

/** Visible (frustum-culled) entities around the bot. */
function visibleEntities (bot, { range = 24, fovDegrees = 90 } = {}) {
  const pos = bot.entity?.position
  if (!pos) return []
  const yaw = lookYaw(bot)
  const fovRad = fovDegrees * DEG
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue
    const dx = e.position.x - pos.x
    const dy = e.position.y - pos.y
    const dz = e.position.z - pos.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > range) continue
    if (!inHorizontalFov(yaw, dx, dz, fovRad)) continue
    out.push({
      type: e.name || (e.username ? 'player' : 'unknown'),
      username: e.username || null,
      dist: Math.round(dist * 10) / 10,
      hp: e.health ?? null
    })
  }
  out.sort((a, b) => a.dist - b.dist)
  return out.slice(0, 12)
}

/**
 * Compose the perception text for a System-2 prompt. Pure function of the
 * bot state; caller decides when to pay for it.
 */
function buildPerceptionText (bot, opts = {}) {
  const blocks = visibleBlocks(bot, opts)
  const grid = buildVoxelGrid(blocks, opts)
  const ents = visibleEntities(bot, opts)
  const entLine = ents.length
    ? `seen: ${ents.map((e) => `${e.username || e.type}(${e.dist}m${e.hp !== null ? ',hp=' + e.hp : ''})`).join(', ')}`
    : 'seen: none'
  return `${entLine}\nvoxel view (origin=you, FOV-culled):\n${grid.text}`
}


// ============================================================================
// "LATENT SPATIAL REPRESENTATION" — 2D ASCII vision for the text-only LLM.
// A flat, aligned character grid is to Qwen what a canvas is to a vision
// model: it can judge symmetry, openings, and drift at a glance.
//
// Top-down map (build alignment, footprint, door gaps, symmetry):
//   rows = z-3..z+N, cols = x-N..x+N, '@' = bot.
// Cross-section (facade/arch/wall alignment):
//   rows = y descending (top row = highest), cols = x (or z) across bot,
//   sliced along the axis the bot faces.
//
// Character legend (fixed): . air  # solid  s dirt/grass  S sand/gravel
//   G glass  D door/trapdoor/gate  C chest/barrel  T wood/planks/log
//   F leaves  W water  L lava  O ores/precious blocks  l light source
//   B bed  ? unloaded/unknown
// ============================================================================

const VISION_LEGEND = '. air  # solid  s soil  S sand/gravel  G glass  D door  C chest  T wood  F leaves  W water  L lava  O ore  l light  B bed  = stairs/slab  | fence/bars/wall  f furnace/station  i sign  @ you'

function categoryChar (block) {
  if (!block) return '?'
  const n = block.name || ''
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.'
  if (/chest|barrel|shulker/.test(n)) return 'C'
  if (/door|trapdoor|fence_gate/.test(n)) return 'D'
  // Furniture and partial blocks used to be indistinguishable from a wall.
  if (/_sign$/.test(n)) return 'i'
  if (/^(furnace|blast_furnace|smoker|crafting_table|enchanting_table|brewing_stand|grindstone|smithing_table|stonecutter|loom|cartography_table|fletching_table|lectern)$|anvil$/.test(n)) return 'f'
  if (/_bed$/.test(n)) return 'B' // "bedrock" is not a bed
  if (/_stairs$|_slab$/.test(n)) return '='
  if (/_fence$|_wall$|iron_bars|_pane$|chain$/.test(n)) return '|'
  if (/glass/.test(n)) return 'G'
  if (/log|wood|planks|stem|hyphae/.test(n)) return 'T'
  if (/leaves/.test(n)) return 'F'
  if (n === 'water' || n === 'flowing_water') return 'W'
  if (n === 'lava' || n === 'flowing_lava') return 'L'
  if (/ore$|ore_/.test(n) || /block_of_(iron|gold|diamond|netherite|emerald)/.test(n)) return 'O'
  if (/torch|lantern|glowstone|sea_lantern|campfire/.test(n)) return 'l'
  if (/grass_block|dirt|podzol|mycelium|coarse_dirt|rooted_dirt|moss_block/.test(n)) return 's'
  if (/sand|gravel|red_sand/.test(n)) return 'S'
  return '#'
}

/**
 * Top-down ASCII map centered on the bot. NOT frustum-culled (a builder needs
 * the whole footprint), purely local (range-bounded).
 * @returns {string}
 */
function buildTopDownGrid (bot, { range = 6 } = {}) {
  const pos = bot.entity?.position
  if (!pos) return '(no position)'
  const cx = Math.floor(pos.x)
  const cy = Math.floor(pos.y)
  const cz = Math.floor(pos.z)
  const lines = [`top view y=${cy} (rows z=${cz - range}..${cz + range}, cols x=${cx - range}..${cx + range})`]
  for (let dz = -range; dz <= range; dz++) {
    let row = ''
    for (let dx = -range; dx <= range; dx++) {
      if (dx === 0 && dz === 0) { row += '@'; continue }
      let block = null
      try { block = bot.blockAt(pos.floored().offset(dx, 0, dz)) } catch { /* unloaded */ }
      row += categoryChar(block)
    }
    lines.push((dz >= 0 ? '+' : '') + String(dz), ' ', row)
  }
  // join line chunks into real lines
  const out = []
  for (let i = 0; i < lines.length; i += 3) out.push(String(lines[i]).padStart(4) + ' ' + lines[i + 2])
  return out.join('\n')
}

/**
 * Cross-section (vertical slice) through the bot, along the axis it faces.
 * Rows descend from highest y to lowest. Useful for checking wall height,
 * arch springing, and roof slope before placing.
 */
function buildCrossSection (bot, { radius = 6, heightUp = 5, heightDown = 2 } = {}) {
  const pos = bot.entity?.position
  if (!pos) return '(no position)'
  const yaw = lookYaw(bot)
  const alongX = Math.abs(Math.sin(yaw)) >= Math.abs(Math.cos(yaw)) // facing mostly ±x?
  const bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z)
  const lines = [`cross-section through ${alongX ? 'x' : 'z'} axis (rows y, cols ${alongX ? 'z' : 'x'})`]
  for (let dy = heightUp; dy >= -heightDown; dy--) {
    let row = ''
    for (let d = -radius; d <= radius; d++) {
      if (d === 0 && dy === 0) { row += '@'; continue }
      const off = alongX ? [0, dy, d] : [d, dy, 0]
      let block = null
      try { block = bot.blockAt(pos.floored().offset(off[0], off[1], off[2])) } catch { /* unloaded */ }
      row += categoryChar(block)
    }
    lines.push(`${String(by + dy).padStart(3)} ${row}`)
  }
  return lines.join('\n')
}

/**
 * The "vision" block injected into System-2 prompts while building.
 * Top-down always; cross-section when the bot is in builder mode.
 */
function buildVisionBlock (bot, { mode = 'explorer', range = 6, radius = 6, heightUp = 5, heightDown = 2 } = {}) {
  const parts = [`vision legend: ${VISION_LEGEND}`, buildTopDownGrid(bot, { range })]
  if (mode === 'builder') parts.push(buildCrossSection(bot, { radius, heightUp, heightDown }))
  return parts.join('\n')
}
// ============================================================================
// Semantic clustering — answers "what is this place?" in one line instead of
// making the model count blocks and mobs. Zero LLM tokens are involved; this
// is pure heuristic structure, cheap enough to run on every inference.
// ============================================================================

/** Names treated as hostile for threat tagging (Java edition, 1.21.x). */
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube',
  'ghast', 'blaze', 'guardian', 'elder_guardian', 'drowned', 'husk', 'stray', 'phantom', 'pillager',
  'vindicator', 'evoker', 'ravager', 'vex', 'silverfish', 'endermite', 'shulker', 'hoglin', 'zoglin',
  'piglin_brute', 'warden', 'breeze', 'bogged', 'creaking'
])

/**
 * Classify an entity by its (lower) registry name.
 * @returns {'player'|'hostile'|'mob'|'item'|'object'}
 */
function classifyEntityName (name) {
  const n = String(name || '').toLowerCase()
  if (n === 'player') return 'player'
  if (HOSTILE_MOBS.has(n)) return 'hostile'
  if (n === 'item' || n === 'experience_orb' || n === 'arrow' || n === 'snowball' || n === 'fireball' || n === 'splash_potion' || n === 'egg' || n === 'trident') return 'item'
  // Decor is an entity, not a creature: 16 item frames are not "mob clutter".
  if (/^(armor_stand|item_frame|glow_item_frame|painting|leash_knot|end_crystal|falling_block)$|_boat$|_raft$|minecart$|_display$/.test(n)) return 'object'
  if (n.includes('bot')) return 'object'
  return 'mob'
}

/**
 * Cluster raw entity sightings for a System-2 prompt.
 * Pure function — pass pre-filtered entities for testability.
 * @param {Array<{name?:string, username?:string, dist:number, position?:{x,y,z}}>} ents
 * @returns {{lines:string[], zones:Array<{kind:string,x:number,y:number,z:number,count:number,radius:number}>}}
 */
function clusterEntities (ents) {
  const lines = []
  const zones = []
  if (!Array.isArray(ents) || ents.length === 0) return { lines, zones }
  const players = []
  const hostile = []
  const mobs = new Map()   // name -> { count, sx, sy, sz }
  const items = new Map()  // name -> count
  for (const e of ents) {
    const name = String(e.username ? 'player' : (e.name || 'unknown')).toLowerCase()
    const cls = classifyEntityName(name)
    if (cls === 'player') { players.push(e); continue }
    if (cls === 'item') { items.set(name, (items.get(name) || 0) + 1); continue }
    const agg = mobs.get(name) || { count: 0, sx: 0, sy: 0, sz: 0 }
    agg.count += 1
    if (e.position) { agg.sx += e.position.x; agg.sy += e.position.y; agg.sz += e.position.z }
    mobs.set(name, agg)
    if (cls === 'hostile') hostile.push({ ...e, name })
  }
  for (const p of players.slice(0, 6)) {
    lines.push(`player ${p.username || 'unknown'} ${p.dist}m`)
  }
  // Clutter culling — over the threshold, mobs are NEVER enumerated;
  // the nearest threat rides in the summary instead.
  const mobTotal = [...mobs.values()].reduce((s, m) => s + m.count, 0)
  if (mobTotal > 15) {
    let nearest = Infinity
    for (const e of ents) {
      const cls = classifyEntityName(String(e.username ? 'player' : (e.name || 'unknown')).toLowerCase())
      if (cls === 'mob' || cls === 'hostile') nearest = Math.min(nearest, e.dist ?? Infinity)
    }
    const parts = [...mobs.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 4).map(([n, m]) => `${n} x${m.count}`).join(', ')
    const near = Number.isFinite(nearest) ? `, nearest ${Math.round(nearest * 10) / 10}m` : ''
    lines.push(`clutter: ${mobTotal} mobs (${parts}${near}) — avoid this area`)
    const positioned = [...mobs.values()].filter((m) => m.sx !== 0 || m.sy !== 0 || m.sz !== 0)
    if (positioned.length) {
      const wsum = positioned.reduce((s, m) => s + m.count, 0)
      const cx = positioned.reduce((s, m) => s + (m.sx / m.count) * m.count, 0) / wsum
      const cy = positioned.reduce((s, m) => s + (m.sy / m.count) * m.count, 0) / wsum
      const cz = positioned.reduce((s, m) => s + (m.sz / m.count) * m.count, 0) / wsum
      zones.push({ kind: 'mob_cluster', x: Math.round(cx), y: Math.round(cy), z: Math.round(cz), count: mobTotal, radius: 8 })
    }
  } else {
    for (const h of hostile.slice(0, 6)) {
      lines.push(`hostile ${h.name} ${h.dist}m`)
    }
    if (mobs.size) {
      lines.push(`mobs: ${[...mobs.entries()].map(([n, m]) => `${n} x${m.count}`).join(', ')}`)
    }
  }
  // Item clutter — same treatment.
  const itemTotal = [...items.values()].reduce((s, c) => s + c, 0)
  if (itemTotal > 10) {
    const parts = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n} x${c}`).join(', ')
    lines.push(`items: ${itemTotal} (${parts})`)
  }
  return { lines: lines.slice(0, 12), zones }
}

// Block categories for structure inference.
const WALL_BLOCKS = new Set(['cobblestone', 'stone', 'stone_bricks', 'mossy_cobblestone', 'mossy_stone_bricks', 'bricks', 'cracked_stone_bricks', 'deepslate_bricks', 'deepslate_tiles', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crimson_planks', 'warped_planks', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo_planks', 'pale_oak_planks', 'pale_oak_log', 'sandstone', 'smooth_stone', 'quartz_block', 'terracotta', 'white_concrete', 'deepslate_brick_wall', 'cobblestone_wall', 'stone_brick_wall'])
const ROOF_BLOCKS = /(stairs|slab|terracotta|deepslate_tile|smooth_stone)$/
const DOOR_BLOCKS = /(door|trapdoor|fence_gate)$/
const GLASS_BLOCKS = /glass/
const CHEST_BLOCKS = /(chest|barrel)$/

/**
 * Infer structure semantics from a block-name list. Conservative by design —
 * only house-like structures are tagged, never guessed wildly.
 * @param {string[]} blockNames names of the blocks in the visible cube
 * @returns {null | {kind:string, walls:number, roof:number, doors:number, glass:number}}
 */
function detectStructure (blockNames) {
  let walls = 0; let roof = 0; let doors = 0; let glass = 0; let chests = 0
  for (const raw of blockNames || []) {
    const n = String(raw || '').toLowerCase()
    if (WALL_BLOCKS.has(n)) walls++
    else if (ROOF_BLOCKS.test(n)) roof++
    else if (DOOR_BLOCKS.test(n)) doors++
    else if (GLASS_BLOCKS.test(n)) glass++
    else if (CHEST_BLOCKS.test(n)) chests++
  }
  if (walls >= 6 && (doors >= 1 || roof >= 3)) return { kind: 'house', walls, roof, doors, glass, chests }
  if (walls >= 12 && doors === 0 && roof === 0) return { kind: 'incomplete_structure', walls, roof, doors, glass, chests }
  return null
}

// ============================================================================
// Semantic compression — "block vomit" → ideas.
//
// Qwen does not need 400 block ids; it needs the *idea* of the place:
// "stone tower with a glass slit and three barrels". clusterBlocks rolls the
// cube up into material shares; detectStructures infers what the place IS.
// Both are pure (no bot), cheap (single pass) and bounded (top-N output), so
// they can run on every inference without touching the token budget.
// ============================================================================

/** Ordered category rules — first match wins. */
const BLOCK_CATEGORY_RULES = [
  ['storage', /(chest|barrel|shulker_box|hopper|dispenser|dropper|furnace|smoker|blast_furnace)/],
  ['light', /(torch|lantern|glowstone|sea_lantern|shroomlight|campfire|candle|beacon|froglight)/],
  ['glass', /(glass|beacon)/],
  ['door', /(door|trapdoor|fence_gate)/],
  ['farming', /(wheat|crop|carrot|potato|beetroot|farmland|pumpkin|melon|hay_block|composter|sugar_cane)/],
  ['nether', /(netherrack|obsidian|nether_portal|crying_obsidian|soul_|nether_brick|blackstone|basalt|magma|glowstone)/],
  ['metal', /(iron|gold|copper|diamond|emerald|netherite|anvil|rail|chain)/],
  ['water', /(water|ice|bubble_column|kelp|seagrass)/],
  ['terrain', /(dirt|grass_block|short_grass|tall_grass|sand|gravel|podzol|mycelium|snow|clay|mud|moss_block|sculk|rooted_dirt|coarse_dirt)/],
  ['foliage', /(leaves|vine|fern|flower|mushroom|sapling|azalea|moss_carpet|kelp|seagrass)/],
  ['wood', /(log|wood|planks|fence|stairs|slab|stem|hyphae|bamboo)/],
  ['stone', /(stone|cobble|brick|deepslate|granite|diorite|andesite|tuff|sandstone|terracotta|concrete|quartz|prismarine|basalt|calcite|dripstone)/]
]

/**
 * Category id for a block name. Unknown blocks fall into 'other' rather than
 * inventing a category — conservative semantics beat confident nonsense.
 * @param {string} name
 * @returns {string}
 */
function categorizeBlock (name) {
  const n = String(name || '').toLowerCase()
  for (const [cat, re] of BLOCK_CATEGORY_RULES) if (re.test(n)) return cat
  return 'other'
}

/**
 * Roll a visible-block list into material shares (top-N categories).
 * @param {Array<{name:string}>} blocks
 * @param {{top?:number}} [opts]
 * @returns {{total:number, materials:Array<{category:string,count:number,share:number}>, text:string}}
 */
function clusterBlocks (blocks, { top = 4 } = {}) {
  const counts = new Map()
  let total = 0
  for (const b of blocks || []) {
    if (!b || !b.name) continue
    const n = String(b.name)
    if (n === 'air' || n === 'cave_air' || n === 'void_air') continue
    const cat = categorizeBlock(n)
    counts.set(cat, (counts.get(cat) || 0) + 1)
    total++
  }
  if (!total) return { total: 0, materials: [], text: '' }
  const materials = [...counts.entries()]
    .map(([category, count]) => ({ category, count, share: count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, top))
  // Sub-2% entries are noise in a prompt ("door 0%"); keep them out of the
  // text while still reporting them in `materials` for programmatic callers.
  const salient = materials.filter((m) => m.share >= 0.02)
  const text = (salient.length ? salient : materials.slice(0, 1))
    .map((m) => `${m.category} ${Math.round(m.share * 100)}% (${m.count})`)
    .join(', ')
  return { total, materials, text }
}

/** Count helper over visible block names. */
function countBy (blocks, re) {
  let n = 0
  for (const b of blocks || []) if (re.test(String(b?.name || ''))) n++
  return n
}

/**
 * Infer the structures/features in a visible cube from geometry + materials.
 * Returns at most `max` entries so the prompt stays a summary, never a dump.
 * @param {Array<{dx?:number,dy?:number,dz?:number,name:string}>} blocks
 * @param {{max?:number}} [opts]
 * @returns {Array<{kind:string, confidence:number, evidence:string}>}
 */
function detectStructures (blocks, { max = 3 } = {}) {
  const list = (blocks || []).filter((b) => b && b.name && !/^(air|cave_air|void_air)$/.test(b.name))
  if (!list.length) return []
  const found = []
  const add = (kind, confidence, evidence) => found.push({ kind, confidence, evidence })

  const walls = list.filter((b) => WALL_BLOCKS.has(String(b.name).toLowerCase())).length
  const roof = countBy(list, ROOF_BLOCKS)
  const doors = countBy(list, DOOR_BLOCKS)
  const glass = countBy(list, GLASS_BLOCKS)
  const chests = countBy(list, CHEST_BLOCKS)
  const fences = countBy(list, /(fence|fence_gate|wall)$/)
  const rails = countBy(list, /rail$/)
  const torches = countBy(list, /(torch|lantern|campfire)/)
  const logs = countBy(list, /(log|stem|hyphae)$/)
  const leaves = countBy(list, /leaves$/)
  const obsidian = countBy(list, /(obsidian|nether_portal)/)
  const crops = countBy(list, /(wheat|carrots|potatoes|beetroots|pumpkin|melon|sugar_cane)/)
  const farmland = countBy(list, /farmland/)
  const water = countBy(list, /(water|ice|kelp|seagrass)/)
  const path = countBy(list, /(dirt_path|gravel|path$)/)
  const cracked = countBy(list, /(cracked|mossy)/)

  // Vertical profile over *structural* blocks only — terrain must not inflate
  // the footprint or the model would see a "house" in a flat field.
  const isStructural = (b) => {
    const n = String(b.name || '').toLowerCase()
    return WALL_BLOCKS.has(n) || ROOF_BLOCKS.test(n) || DOOR_BLOCKS.test(n) ||
      GLASS_BLOCKS.test(n) || CHEST_BLOCKS.test(n) || /(fence|fence_gate|wall)$/.test(n)
  }
  const columns = new Map()
  let maxDy = 0
  for (const b of list) {
    if (!Number.isFinite(b.dx) || !Number.isFinite(b.dz)) continue
    if (!isStructural(b) && !(Number.isFinite(b.dy) && b.dy >= 1)) continue
    const key = `${b.dx},${b.dz}`
    const h = Number.isFinite(b.dy) ? b.dy : 0
    columns.set(key, Math.max(columns.get(key) ?? -Infinity, h))
    if (h > maxDy) maxDy = h
  }
  const tallColumns = [...columns.values()].filter((h) => h >= 6).length

  // Conservative: a roof, or a door + real window wall, makes a house.
  if (walls >= 6 && (roof >= 3 || (doors >= 1 && glass >= 2 && columns.size >= 5))) {
    add('house', 0.9, `walls=${walls} doors=${doors} roof=${roof}`)
  }
  if (maxDy >= 6 && tallColumns >= 1 && tallColumns <= 16 && walls >= 6) add('tower', 0.78, `height=${maxDy} footprint=${columns.size}`)
  if (chests >= 4) add('storage', 0.92, `${chests} chests/barrels`)
  if (crops >= 6 || (farmland >= 4 && water > 0)) add('farm', 0.8, `crops=${crops} water=${water}`)
  if (rails >= 4) add('mine_entrance', 0.8, `rails=${rails}`)
  if (obsidian >= 8) add('portal', 0.85, `obsidian=${obsidian}`)
  if (fences >= 8) add('enclosure', 0.7, `fences=${fences}`)
  if (water >= 4 && walls + roof >= 10) add('bridge', 0.6, `stone=${walls + roof} water=${water}`)
  if (path >= 8 && doors === 0) add('road', 0.55, `path blocks=${path}`)
  if (logs >= 3 && leaves >= 8) add('grove', 0.7, `logs=${logs} leaves=${leaves}`)
  if (cracked >= 3) add('ruins', 0.6, `cracked=${cracked}`)
  if (doors >= 2 && walls >= 10 && columns.size >= 6) add('village_building', 0.65, `doors=${doors} walls=${walls}`)

  // Deduplicate and keep the strongest signals only.
  const seen = new Set()
  return found
    .sort((a, b) => b.confidence - a.confidence)
    .filter((s) => (seen.has(s.kind) ? false : (seen.add(s.kind), true)))
    .slice(0, max)
}

/**
 * Compose the semantic "idea" of the immediate world: scene + materials +
 * entity clusters. Bounded output (~5 lines) regardless of block count.
 * @param {import('mineflayer').Bot} bot
 * @param {{radius?:number, maxEntities?:number}} [opts]
 * @returns {{text:string, zones:Array, structures:Array, materials:Array}}
 */
function semanticScene (bot, { radius = 8, maxEntities = 16 } = {}) {
  const pos = bot?.entity?.position
  const zones = []
  if (!pos) return { text: '', zones, structures: [], materials: [] }
  // Full 360° scan: semantics must not depend on which way the bot faces.
  const blocks = visibleBlocks(bot, { range: radius, fovDegrees: 360, heightUp: 6, heightDown: 3 })
  const structures = detectStructures(blocks)
  const clustered = clusterBlocks(blocks)
  const lines = []
  if (structures.length) {
    lines.push(`scene: ${structures.map((s) => `${s.kind}${s.confidence >= 0.85 ? '' : '?'}`).join(' | ')}`)
  }
  if (clustered.text) lines.push(`materials: ${clustered.text}`)

  // Terrain hint — one clause, derived from the same cube (no extra scan).
  const water = countBy(blocks, /(water|kelp|seagrass)/)
  const stone = countBy(blocks, /(stone|deepslate|tuff)/)
  const chests = countBy(blocks, CHEST_BLOCKS)
  let ceiling = false
  try {
    const above = bot.blockAt?.(pos.floored ? pos.floored().offset(0, 4, 0) : pos)
    ceiling = Boolean(above && above.boundingBox === 'block')
  } catch { /* unloaded above — assume open */ }
  const underground = stone > blocks.length * 0.55 && water === 0
  const terrain = []
  if (underground) terrain.push('underground')
  if (water > 0) terrain.push('water nearby')
  if (!underground && !water) terrain.push('open ground')
  if (ceiling) terrain.push('ceiling')
  if (terrain.length) lines.push(`terrain: ${terrain.join(', ')}`)

  // Feature vocabulary: the "idea" of doors/windows/light/storage in one line.
  const features = []
  const doorCount = countBy(blocks, DOOR_BLOCKS)
  const glassCount = countBy(blocks, GLASS_BLOCKS)
  const lightCount = countBy(blocks, /(torch|lantern|glowstone|sea_lantern|campfire|candle)/)
  if (doorCount) features.push(`door x${doorCount}`)
  if (glassCount) features.push(`glass x${glassCount}`)
  if (lightCount) features.push(`light x${lightCount}`)
  if (chests && chests < 4) features.push(`barrels x${chests}`)
  if (features.length) lines.push(`features: ${features.join(', ')}`)

  if (chests >= 4) zones.push({ kind: 'storage', x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), count: chests, radius })

  // Entities: same cube, clustered (never enumerated when dense).
  const rawEnts = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue
    const dx = e.position.x - pos.x; const dy = e.position.y - pos.y; const dz = e.position.z - pos.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist > Math.max(16, radius * 2)) continue
    rawEnts.push({ name: e.name, username: e.username, dist: Math.round(dist * 10) / 10, position: e.position })
  }
  rawEnts.sort((a, b) => a.dist - b.dist)
  const cluster = clusterEntities(rawEnts.slice(0, maxEntities))
  lines.push(...cluster.lines)
  zones.push(...cluster.zones)
  return { text: lines.slice(0, 12).join('\n'), zones, structures, materials: clustered.materials }
}

/**
 * Build the semantic perception block for a System-2 prompt.
 * @param {import('mineflayer').Bot} bot
 * @param {{radius?:number}} [opts]
 * @returns {{text:string, zones:Array}}
 */
function buildSemanticHints (bot, { radius = 6 } = {}) {
  const scene = semanticScene(bot, { radius })
  return { text: scene.text, zones: scene.zones }
}

module.exports = {
  visibleBlocks,
  visibleEntities,
  buildVoxelGrid,
  buildPerceptionText,
  inHorizontalFov,
  buildTopDownGrid,
  buildCrossSection,
  buildVisionBlock,
  categoryChar,
  VISION_LEGEND,
  classifyEntityName,
  clusterEntities,
  detectStructure,
  detectStructures,
  clusterBlocks,
  categorizeBlock,
  semanticScene,
  buildSemanticHints
}
