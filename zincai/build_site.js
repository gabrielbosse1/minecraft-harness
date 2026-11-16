'use strict'

const { Vec3 } = require('vec3')
const NATURAL_OVERHEAD = /stone|deepslate|dirt|grass|netherrack|end_stone|sand|gravel|tuff|calcite|basalt|blackstone|bedrock|clay|mud|dripstone|ore/i

/** Return an actionable refusal for a large habitation build, otherwise null. */
function buildSiteError (bot, { label, origin, steps = [] } = {}) {
  if (!bot?.blockAt || !origin || steps.length < 12 || !/house|home|shelter|watchtower|cabin|cottage|hut/i.test(String(label))) return null
  const base = steps.filter((s) => s.y === origin.y)
  const xs = base.map((s) => s.x); const zs = base.map((s) => s.z)
  const cx = xs.length ? Math.floor((Math.min(...xs) + Math.max(...xs)) / 2) : origin.x
  const cz = zs.length ? Math.floor((Math.min(...zs) + Math.max(...zs)) / 2) : origin.z
  const at = (x, y, z) => {
    try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), false) || null } catch { return null }
  }
  const ground = at(cx, origin.y - 1, cz)
  const baseBlock = at(cx, origin.y, cz)
  if (!ground || !baseBlock) return `refused to build ${label}: site blocks are not loaded/verified; move to a loaded, visible surface location and retry`
  if (/water|lava/.test(ground.name) || /water|lava/.test(baseBlock.name)) return `refused to build ${label}: the foundation site is in ${ground.name}/${baseBlock.name}; choose dry, solid ground`
  let roof = null; let roofY = null
  for (let y = origin.y + 1; y <= origin.y + 16; y++) {
    const b = at(cx, y, cz)
    if (!b) break
    if (b.boundingBox === 'block') { roof = b; roofY = y; break }
  }
  if (roof && NATURAL_OVERHEAD.test(roof.name)) return `refused to build ${label}: natural ${roof.name} overhead at y=${roofY} means this is cave/underground, not an outdoor building site; use go_to to reach open sky, then choose solid dry ground`
  const supports = base.filter((s) => {
    const b = at(s.x, origin.y - 1, s.z)
    return b && b.boundingBox === 'block' && !/water|lava|air/.test(b.name)
  }).length
  if (base.length >= 4 && supports < Math.ceil(base.length * 0.6)) return `refused to build ${label}: only ${supports}/${base.length} foundation cells have solid support; move to level solid ground`
  return null
}

module.exports = { buildSiteError }
