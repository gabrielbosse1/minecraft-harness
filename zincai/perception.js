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
  // mineflayer keeps yaw on bot.entity.yaw (radians, 0 = south).
  return bot.entity ? bot.entity.yaw : 0
}

function lookPitch (bot) {
  return bot.entity ? bot.entity.pitch : 0
}

/** True if (dx,dz) from origin lies inside the horizontal FOV cone. */
function inHorizontalFov (yaw, dx, dz, fovRad) {
  const dist = Math.hypot(dx, dz)
  if (dist < 1.5) return true // peripheral presence, always notice
  // mineflayer yaw: 0=+z(south), π=-z; entity look vector (dx,dz) = (-sin(yaw), cos(yaw))
  const lx = -Math.sin(yaw)
  const lz = Math.cos(yaw)
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

const VISION_LEGEND = '. air  # solid  s soil  S sand/gravel  G glass  D door  C chest  T wood  F leaves  W water  L lava  O ore  l light  B bed  @ you'

function categoryChar (block) {
  if (!block) return '?'
  const n = block.name || ''
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.'
  if (/chest|barrel|shulker/.test(n)) return 'C'
  if (/door|trapdoor|fence_gate/.test(n)) return 'D'
  if (/glass/.test(n)) return 'G'
  if (/log|wood|planks|stem|hyphae/.test(n)) return 'T'
  if (/leaves/.test(n)) return 'F'
  if (n === 'water' || n === 'flowing_water') return 'W'
  if (n === 'lava' || n === 'flowing_lava') return 'L'
  if (/ore$|ore_/.test(n) || /block_of_(iron|gold|diamond|netherite|emerald)/.test(n)) return 'O'
  if (/torch|lantern|glowstone|sea_lantern|campfire/.test(n)) return 'l'
  if (/bed/.test(n)) return 'B'
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

module.exports = { visibleBlocks, visibleEntities, buildVoxelGrid, buildPerceptionText, inHorizontalFov, buildTopDownGrid, buildCrossSection, buildVisionBlock, categoryChar, VISION_LEGEND }
