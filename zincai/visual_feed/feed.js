'use strict'
const hud = document.getElementById('hud')
const fmt = p => p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}` : 'unknown'
async function refresh () {
  try {
    const response = await fetch('state', { cache: 'no-store' })
    if (!response.ok) throw new Error('feed unavailable')
    const s = await response.json()
    hud.textContent = `BOT ${fmt(s.position)} · ${s.facing}\n${s.dimension} · ${s.biome}\nHealth ${s.health ?? '?'} · Hunger ${s.food ?? '?'}\nGoal: ${s.goal || 'none'}\nAction: ${s.action || 'none'}\nNavigation: ${s.navigation.status} ${s.navigation.progress || ''}\nNext: ${fmt(s.navigation.waypoint)} · Destination: ${fmt(s.navigation.destination)}\n${s.navigation.resetReason ? 'Last reset: ' + s.navigation.resetReason + '\n' : ''}Nearby (not visibility-tested): ${s.entities.join(', ') || 'none'}`
  } catch { hud.textContent = 'Visual feed disconnected' }
}
refresh()
setInterval(refresh, 500)
