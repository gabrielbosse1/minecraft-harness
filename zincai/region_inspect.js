'use strict'

const { inspectBlock } = require('./block_inspect')

// Paginated snapshots, never a claim about an entire loaded region or a trace.
function inspectRegion (bot, { x, y, z, radius = 1, page = 1 } = {}) {
  if (![x, y, z, radius, page].every(Number.isSafeInteger) || radius < 0 || radius > 2 || page < 1) return { ok: false, msg: 'region requires safe integer coordinates, radius 0–2 and page >= 1' }
  if (![x - radius, x + radius, y - radius, y + radius, z - radius, z + radius].every(Number.isSafeInteger)) return { ok: false, msg: 'region coordinates exceed safe integer range' }
  const pos = bot.entity?.position
  if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return { ok: false, msg: 'position unavailable' }
  // Furthest cell center must be inside the same bound as inspect_block.
  if (Math.hypot(Math.abs(x + 0.5 - pos.x) + radius, Math.abs(y + 0.5 - pos.y) + radius, Math.abs(z + 0.5 - pos.z) + radius) > 8) return { ok: false, msg: 'region extends beyond the 8 block inspection radius' }
  const side = 2 * radius + 1
  const total = side ** 3
  const pages = Math.ceil(total / 4)
  if (page > pages) return { ok: false, msg: `page out of range; this region has ${pages} pages` }
  const lines = []
  const start = (page - 1) * 4
  for (let i = start; i < Math.min(start + 4, total); i++) {
    const dx = (i % side) - radius
    const dy = (Math.floor(i / side) % side) - radius
    const dz = Math.floor(i / (side * side)) - radius
    const bx = x + dx; const by = y + dy; const bz = z + dz
    const r = inspectBlock(bot, { x: bx, y: by, z: bz })
    let message = r.ok ? r.msg.replace(/\. Snapshot only; no connectivity or behavior inferred\.$/, '') : `${bx},${by},${bz}: ${r.msg}`
    if (message.length > 145) message = message.slice(0, 120) + ' [details omitted]'
    lines.push(message)
  }
  return { ok: true, msg: `Region page ${page}/${pages} (${start + 1}–${Math.min(start + 4, total)} of ${total} cells): ${lines.join(' | ')}. Non-atomic client snapshots; no connectivity inferred.` }
}
module.exports = { inspectRegion }
