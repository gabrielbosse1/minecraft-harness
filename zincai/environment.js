'use strict'

const { Vec3 } = require('vec3')

const NATURAL_OVERHEAD = /stone|deepslate|dirt|grass|netherrack|end_stone|sand|gravel|tuff|calcite|basalt|blackstone|bedrock|clay|mud|dripstone|ore|terracotta/
const EXIT_CACHE = new WeakMap()

function blockAt (bot, x, y, z) {
  try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), false) || null } catch { return null }
}

function surfaceExitCandidates (bot, x, y, z, { now = Date.now(), ttlMs = 2500 } = {}) {
  const cached = EXIT_CACHE.get(bot)
  const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  if (cached && cached.key === key && now - cached.at < ttlMs) return cached.value
  const dirs = [{ dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 }]
  const candidates = []
  const top = Math.max(y + 1, Math.min(Number(bot.game?.maxY) || 320, 320))
  for (const d of dirs) {
    for (const radius of [8, 16, 24]) {
      const tx = x + d.dx * radius; const tz = z + d.dz * radius
      let found = null
      for (let fy = Math.floor(y + 64); fy >= Math.floor(y - 4); fy--) {
        const ground = blockAt(bot, tx, fy - 1, tz)
        const feet = blockAt(bot, tx, fy, tz)
        const head = blockAt(bot, tx, fy + 1, tz)
        if (!ground || !feet || !head || ground.boundingBox !== 'block' || /water|lava|magma|fire|cactus|powder_snow/.test(ground.name) || feet.boundingBox === 'block' || head.boundingBox === 'block') continue
        let sky = true
        for (let sy = fy + 2; sy <= top; sy++) {
          const b = blockAt(bot, tx, sy, tz)
          if (!b) { sky = false; break }
          if (b.boundingBox === 'block') { sky = false; break }
        }
        if (sky) { found = { x: tx, y: fy, z: tz, distance: radius }; break }
      }
      if (found) { candidates.push(found); break }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  const result = candidates.slice(0, 2)
  EXIT_CACHE.set(bot, { key, at: now, value: result })
  return result
}

function environmentSnapshot (bot) {
  const p = bot?.entity?.position
  if (!p || !bot?.blockAt) return null
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
  const feet = blockAt(bot, x, y, z)
  const ground = blockAt(bot, x, y - 1, z)
  let overhead = null; let overheadY = null
  for (let dy = 1; dy <= 16; dy++) {
    const b = blockAt(bot, x, y + dy, z)
    if (!b) break
    if (b.boundingBox === 'block') { overhead = b; overheadY = y + dy; break }
  }
  let skyVisible = false
  const top = Math.max(y + 1, Math.min(Number(bot.game?.maxY) || 320, 320))
  if (overheadY === null) {
    skyVisible = true
    for (let yy = y + 1; yy <= top; yy++) {
      const b = blockAt(bot, x, yy, z)
      if (!b) { skyVisible = null; break }
      if (b.boundingBox === 'block') { skyVisible = false; break }
    }
  }
  const submerged = Boolean(feet && /water|bubble_column/.test(feet.name))
  const nearHazard = []
  for (const [dx, dy, dz] of [[0,0,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]) {
    const b = blockAt(bot, x + dx, y + dy, z + dz)
    if (!b) continue
    if (/lava/.test(b.name) && !nearHazard.includes('lava')) nearHazard.push('lava')
    if (/fire|magma/.test(b.name) && !nearHazard.includes('fire/magma')) nearHazard.push('fire/magma')
  }
  const light = Number.isFinite(feet?.light) ? feet.light : null
  const skyLight = Number.isFinite(feet?.skyLight) ? feet.skyLight : null
  const yaw = Number(bot.entity?.yaw)
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const facing = Number.isFinite(yaw) ? compass[Math.round((((yaw * 180 / Math.PI) + 180) % 360 + 360) % 360 / 45) % 8] : null
  let biome = null
  try {
    const id = bot.world?.getBiome?.(new Vec3(x, y, z))
    if (Number.isInteger(id)) biome = bot.registry?.biomes?.[id]?.name || bot.registry?.biomesArray?.[id]?.name || null
  } catch { /* biome data may be unavailable or asynchronous */ }
  const overheadName = overhead?.name || null
  let enclosure = 'surface'
  if (skyVisible === false) enclosure = overheadName && NATURAL_OVERHEAD.test(overheadName) ? 'cave/underground' : 'inside/under a structure'
  else if (skyVisible === null) enclosure = 'unknown (chunks unloaded above)'
  const parts = [`${enclosure}${skyVisible === true ? ', sky visible' : skyVisible === false ? ', sky blocked' : ''}`]
  if (facing) parts.push(`facing ${facing}`)
  if (biome) parts.push(`biome ${biome}`)
  parts.push(`ground ${ground?.name || 'unknown'}`)
  if (overheadName) parts.push(`overhead ${overheadName} at y=${overheadY}`)
  else if (skyVisible === true) parts.push('no nearby roof')
  if (light !== null) parts.push(`block light ${light}/15`)
  if (skyLight !== null) parts.push(`sky light ${skyLight}/15`)
  if (submerged) parts.push('underwater')
  if (Number.isFinite(bot.oxygenLevel)) parts.push(`oxygen ${bot.oxygenLevel}`)
  if (nearHazard.length) parts.push(`near ${nearHazard.join('/')}`)
  let surfaceExits = []
  if (skyVisible === false && NATURAL_OVERHEAD.test(overheadName || '') && y < 62) {
    try { surfaceExits = surfaceExitCandidates(bot, x, y, z) } catch { surfaceExits = [] }
    if (surfaceExits.length) parts.push(`nearby open-sky walkable candidates (route not verified; use go_to, never tunnel upward): ${surfaceExits.map((c) => `${c.x},${c.y},${c.z}`).join(' or ')}`)
    else parts.push('no nearby open-sky walkable candidate verified; do not tunnel upward blindly')
  }
  return { x, y, z, skyVisible, enclosure, ground: ground?.name || null, overhead: overheadName, overheadY, light, skyLight, submerged, hazards: nearHazard, surfaceExits, line: `environment: ${parts.join(' | ')}` }
}

module.exports = { environmentSnapshot, surfaceExitCandidates }
