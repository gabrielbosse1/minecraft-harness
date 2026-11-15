'use strict'

// Pathfinder emits the array it then consumes with shift(). Retain that array
// by reference, but never mutate it: snapshots copy it for safe consumers.
// This tracks actual pending steps, including routes that loop back on themselves.
function trackNavigation (bot) {
  let path = []
  let total = 0
  let state = { status: 'idle', destination: null, resetReason: null }
  const point = (p) => p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null
  const handlers = {
    goal_updated (goal) {
      path = []; total = 0
      state = { status: goal ? 'waiting' : 'idle', destination: point(goal), resetReason: null }
    },
    path_update (result) {
      path = Array.isArray(result.path) ? result.path : []
      total = path.length
      state = { ...state, status: result.status === 'noPath' || result.status === 'timeout' ? 'waiting' : (path.length ? 'navigating' : 'waiting'), searchStatus: result.status }
    },
    path_reset (reason) {
      if (reason === 'goal_updated') return
      path = []; total = 0
      state = { ...state, status: reason === 'stuck' ? 'stuck' : 'recalculating', resetReason: String(reason || 'unknown') }
    },
    goal_reached () { path = []; total = 0; state = { ...state, status: 'reached' } },
    path_stop () { path = []; total = 0; state = { ...state, status: 'idle', destination: null } }
  }
  for (const [event, handler] of Object.entries(handlers)) bot.on(event, handler)
  return {
    snapshot () {
      const remaining = path.slice(0, 2048).map(point).filter(Boolean)
      return { ...state, path: remaining, waypoint: remaining[0] || null, progress: total ? `${Math.max(0, total - path.length)}/${total}` : null }
    },
    dispose () { for (const [event, handler] of Object.entries(handlers)) bot.removeListener(event, handler); path = [] }
  }
}
module.exports = { trackNavigation }
