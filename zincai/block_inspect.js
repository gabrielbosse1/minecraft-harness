'use strict'

const { Vec3 } = require('vec3')

// A bounded, read-only observation of one loaded block; not a redstone trace.
function inspectBlock (bot, { x, y, z } = {}) {
  if (![x, y, z].every(Number.isSafeInteger)) return { ok: false, msg: 'coordinates must be safe integers' }
  const pos = bot.entity?.position
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return { ok: false, msg: 'position unavailable' }
  if (Math.hypot(x + 0.5 - pos.x, y + 0.5 - pos.y, z + 0.5 - pos.z) > 8) return { ok: false, msg: 'block is beyond the 8 block inspection radius' }
  let block
  try { block = bot.blockAt(new Vec3(x, y, z)) } catch { return { ok: false, msg: 'block observation failed' } }
  if (!block) return { ok: false, msg: 'block is not loaded or observable' }
  let properties = 'unavailable'
  try {
    const raw = block.getProperties?.()
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entries = Object.entries(raw)
      const safe = entries.filter(([k, v]) => /^[a-z0-9_]{1,40}$/.test(k) && (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && String(v).length <= 40) || (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v)))).sort(([a], [b]) => a.localeCompare(b)).slice(0, 8)
      properties = (safe.length ? safe.map(([k, v]) => `${k}=${v}`).join(', ') : '(none reported)') + (safe.length < entries.length ? ' [some properties omitted]' : '')
    }
  } catch { /* no property data */ }
  const name = /^[a-z0-9_]{1,80}$/.test(block.name || '') ? block.name : 'unknown'
  const dim = String(bot.game?.dimension || 'unknown').replace(/[^a-z0-9_:.-]/gi, '').slice(0, 80)
  return { ok: true, msg: `observed ${name} at ${x},${y},${z} in ${dim}; properties: ${properties}. Snapshot only; no connectivity or behavior inferred.` }
}
module.exports = { inspectBlock }
