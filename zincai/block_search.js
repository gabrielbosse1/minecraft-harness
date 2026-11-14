/**
 * block_search.js — "where is the nearest X" without holding the thread.
 *
 * mineflayer's bot.findBlocks walks every chunk section in range and, for each
 * one, builds a Block object per palette entry to ask whether the section can
 * contain the block at all. When the answer is "no" everywhere — the block is
 * simply not around, which is exactly when a gather wants to look further —
 * that is the whole cost, and it grows with the cube of the radius: measured on
 * a 1.21.4 world, 40 ms at 32 blocks, 150 ms at 64, a full second at 128, all
 * of it synchronous (nothing read from the server meanwhile).
 *
 * This does the same search on raw state ids: one Set lookup per palette
 * entry, no objects, nearest columns first with an early exit once enough hits
 * are closer than anything still unvisited, and a time budget as a last line.
 * A bot without real chunk columns (a simulated one) falls back to findBlocks.
 */
'use strict'

const { Vec3 } = require('vec3')

/** Every block-state id of the given block type ids. */
function stateIdsOf (registry, blockIds) {
  const out = new Set()
  for (const id of blockIds) {
    const b = registry.blocks?.[id]
    if (!b) continue
    const lo = b.minStateId ?? b.defaultState
    const hi = b.maxStateId ?? lo
    if (lo === undefined) continue
    for (let s = lo; s <= hi; s++) out.add(s)
  }
  return out
}

/**
 * @param {object} bot
 * @param {number[]} blockIds block TYPE ids (registry.blocksByName[x].id)
 * @param {{ maxDistance?: number, count?: number, point?: object, budgetMs?: number }} [opts]
 * @returns {Vec3[] & { truncated?: boolean }} nearest first, at most `count`
 */
function findBlocksFast (bot, blockIds, { maxDistance = 32, count = 1, point = null, budgetMs = 40 } = {}) {
  const ids = Array.isArray(blockIds) ? blockIds : [blockIds]
  const origin = point || bot.entity?.position
  const world = bot.world
  const sample = origin && world && typeof world.getColumn === 'function'
    ? world.getColumn(Math.floor(origin.x / 16), Math.floor(origin.z / 16))
    : null
  if (!origin || !sample || !Array.isArray(sample.sections) || typeof sample.getBlockStateId !== 'function') {
    return bot.findBlocks({ matching: ids, maxDistance, count, ...(point ? { point } : {}) })
  }
  const wanted = stateIdsOf(bot.registry, ids)
  if (!wanted.size) return []
  const minY = Number.isFinite(sample.minY) ? sample.minY : (bot.game?.minY ?? 0)
  const px = Math.floor(origin.x); const py = Math.floor(origin.y); const pz = Math.floor(origin.z)
  const r = Math.max(1, maxDistance)
  const r2 = r * r

  // Columns in range, nearest first (by the closest point of the column).
  const cols = []
  const c0x = Math.floor((px - r) / 16); const c1x = Math.floor((px + r) / 16)
  const c0z = Math.floor((pz - r) / 16); const c1z = Math.floor((pz + r) / 16)
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cz = c0z; cz <= c1z; cz++) {
      const dx = Math.max(cx * 16 - px, 0, px - (cx * 16 + 15))
      const dz = Math.max(cz * 16 - pz, 0, pz - (cz * 16 + 15))
      const d2 = dx * dx + dz * dz
      if (d2 <= r2) cols.push({ cx, cz, d2 })
    }
  }
  cols.sort((a, b) => a.d2 - b.d2)

  const hits = [] // { x, y, z, d2 }
  let worst = Infinity // distance² of the count-th best hit so far
  const started = Date.now()
  let truncated = false
  const pos = { x: 0, y: 0, z: 0 }
  for (const col of cols) {
    if (hits.length >= count && col.d2 > worst) break // nothing left can be closer
    if (Date.now() - started > budgetMs) { truncated = true; break }
    const column = world.getColumn(col.cx, col.cz)
    if (!column || !Array.isArray(column.sections)) continue
    const s0 = Math.max(0, (py - r - minY) >> 4)
    const s1 = Math.min(column.sections.length - 1, (py + r - minY) >> 4)
    for (let si = s0; si <= s1; si++) {
      const section = column.sections[si]
      if (!section) continue
      // The palette says in a few lookups whether the section can hold it.
      const palette = section.palette
      if (Array.isArray(palette)) {
        let any = false
        for (let i = 0; i < palette.length; i++) { if (wanted.has(palette[i])) { any = true; break } }
        if (!any) continue
      }
      // A uniform section (all air, all stone) is one value, no palette:
      // one lookup decides the whole 4096 blocks.
      const uniform = !Array.isArray(palette) && section.data && typeof section.data.value === 'number' && section.data.data === undefined
      if (uniform && !wanted.has(section.data.value)) continue
      const baseY = si * 16 + minY
      for (let ly = 0; ly < 16; ly++) {
        const wy = baseY + ly
        const dy = wy - py
        if (dy * dy > r2) continue
        pos.y = wy
        for (let lz = 0; lz < 16; lz++) {
          pos.z = lz
          const dz = col.cz * 16 + lz - pz
          for (let lx = 0; lx < 16; lx++) {
            pos.x = lx
            if (!wanted.has(column.getBlockStateId(pos))) continue
            const dx = col.cx * 16 + lx - px
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 > r2) continue
            hits.push({ x: col.cx * 16 + lx, y: wy, z: col.cz * 16 + lz, d2 })
          }
        }
      }
    }
    if (hits.length >= count) {
      hits.sort((a, b) => a.d2 - b.d2)
      if (hits.length > count * 4) hits.length = count * 4
      worst = hits[Math.min(count, hits.length) - 1].d2
    }
  }
  hits.sort((a, b) => a.d2 - b.d2)
  const out = hits.slice(0, count).map((h) => new Vec3(h.x, h.y, h.z))
  if (truncated) out.truncated = true
  return out
}

module.exports = { findBlocksFast, stateIdsOf }
