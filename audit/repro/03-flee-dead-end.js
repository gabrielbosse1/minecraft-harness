'use strict'
/**
 * Where does the flee reflex send the bot when walls matter?
 *
 *   before  fleePlan(): a point 14 blocks "away"; the REAL mineflayer-pathfinder A* plans the route.
 *   after   escapePlan(): the safety field (custom_mineflayer/escape.js) — reachable ground where the
 *           bot arrives before any mob could, preferring ground that leads out.
 *
 * Each map is then played for 12 s: zombies walk at the bot at 2.3 b/s (they stop at walls), the bot
 * runs its plan at 5.4 b/s and replans every 700 ms, as the reflex does. Reported: how close the
 * nearest zombie got, and what the bot would have told the model.
 */
const { req, world } = require('./_common')
const { Vec3, Movements } = world
const { PathfinderWrapper } = req('zincai/custom_mineflayer/pathfinder_wrapper.js')
const { ThreatSense } = req('zincai/threats')
const { cornerText } = req('zincai/tactics')

function setup (solid, zombies, botAt) {
  const bot = world.makeWorld(solid)
  bot.entity.position = new Vec3(botAt[0], 64, botAt[1])
  bot.pathfinder = { movements: null, bestHarvestTool: () => null }
  let id = 10
  for (const [x, z] of zombies) world.addMob(bot, id++, 'zombie', x, z)
  const sense = new ThreatSense(bot)
  const movements = new Movements(bot)
  bot.pathfinder.movements = movements
  const wrapper = new PathfinderWrapper(bot, { allowDigging: false, allowScaffolding: false, enableWindCharge: false, threat: { entityFilter: (e) => sense.isThreat(e) } })
  wrapper.configureMovements(movements)
  return { bot, sense, movements, wrapper, solid }
}

const mobs = (bot) => Object.values(bot.entities).filter((e) => e !== bot.entity)
const nearest = (bot) => Math.min(...mobs(bot).map((e) => Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)))
const pursuers = (bot) => mobs(bot).map((e) => ({ x: e.position.x, y: e.position.y, z: e.position.z, speed: 2.3, reach: 1.6, name: 'zombie' }))

/** Play 12 s. `route(s)` returns the cells to run through next ([{x,z}…]) and a note for the log. */
function play (s, route) {
  const { bot, solid } = s
  const free = (x, z) => !solid(Math.floor(x), 64, Math.floor(z)) && !solid(Math.floor(x), 65, Math.floor(z)) && solid(Math.floor(x), 63, Math.floor(z))
  let cells = []
  let closest = nearest(bot)
  let hits = 0
  const notes = new Set()
  for (let tick = 0; tick < 240; tick++) {
    if (tick % 14 === 0) { s.sense.assess(); const r = route(s); cells = r.cells; if (r.note) notes.add(r.note) }
    // the bot: 5.4 b/s along its cells
    let budget = 5.4 / 20
    const p = bot.entity.position
    while (budget > 0 && cells.length) {
      const c = cells[0]
      const dx = c.x + 0.5 - p.x; const dz = c.z + 0.5 - p.z; const d = Math.hypot(dx, dz)
      if (d < 0.05) { cells.shift(); continue }
      const step = Math.min(budget, d)
      const nx = p.x + dx / d * step; const nz = p.z + dz / d * step
      if (!free(nx, nz)) { cells = []; break } // walked off the map or into a wall: stop
      p.x = nx; p.z = nz; budget -= step
    }
    // the zombies: 2.3 b/s straight at the bot, stopped by walls
    for (const e of mobs(bot)) {
      const dx = p.x - e.position.x; const dz = p.z - e.position.z; const d = Math.hypot(dx, dz)
      if (d < 1.2) { if (tick % 20 === 0) hits++; continue }
      const nx = e.position.x + dx / d * (2.3 / 20); const nz = e.position.z + dz / d * (2.3 / 20)
      if (free(nx, nz)) { e.position.x = nx; e.position.z = nz } else if (free(nx, e.position.z)) e.position.x = nx
      else if (free(e.position.x, nz)) e.position.z = nz
    }
    closest = Math.min(closest, nearest(bot))
  }
  return { closest, hits, end: `${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.z)}`, notes: [...notes] }
}

const before = (s) => {
  const plan = s.wrapper.fleePlan({ distance: 14 })
  if (!plan) return { cells: [], note: 'no plan' }
  const r = world.plan(s.bot, s.movements, plan.goal, { timeout: 400 })
  return { cells: r.path.map((n) => ({ x: n.x, z: n.z })), note: r.status === 'success' ? null : `A* ${r.status}` }
}
const after = (s) => {
  const plan = s.wrapper.escapePlan(pursuers(s.bot), { radius: 18, budgetMs: 60 })
  if (!plan) return { cells: [], note: 'no plan' }
  return { cells: plan.path.slice(1).map((n) => ({ x: n.x, z: n.z })), note: plan.cornered ? cornerText(plan.why) : (plan.why === 'chased' ? 'chased' : null) }
}

function scenario (label, solid, zombies, botAt) {
  console.log(label)
  for (const [name, route] of [['before', before], ['after ', after]]) {
    const r = play(setup(solid, zombies, botAt), route)
    console.log(`   ${name}: nearest zombie got to ${r.closest.toFixed(1)} blocks; hit ${r.hits}×; ended at ${r.end}${r.notes.length ? `; told the model: ${r.notes.join(' / ')}` : ''}`)
  }
  console.log('')
}

// 1. Corridor 3 wide, closed at z=-1, open at z=21, roofed. The bot is near the closed end.
const corridor = (x, y, z) => y <= 63 ||
  (y >= 64 && y <= 66 && (((x === -2 || x === 2) && z >= -1 && z <= 20) || (z === -1 && x >= -2 && x <= 2))) ||
  (y === 67 && x >= -2 && x <= 2 && z >= -1 && z <= 20)
scenario('1) dead-end corridor, 6 zombies walking in from the open end (there is no way out)', corridor,
  [[0.5, 8.5], [-0.5, 9.5], [1.5, 10.5], [0.5, 11.5], [-0.5, 12.5], [1.5, 13.5]], [0.5, 2.5])

// 2. 11x11 roofed room with one doorway (south). Zombies come in through it.
const room = (x, y, z) => y <= 63 ||
  (y >= 64 && y <= 66 && (((x === -6 || x === 6) && z >= -6 && z <= 6) || ((z === -6 || z === 6) && x >= -6 && x <= 6)) && !(z === 6 && x === 0 && y <= 65)) ||
  (y === 67 && x >= -6 && x <= 6 && z >= -6 && z <= 6)
scenario('2) room with a single doorway, 4 zombies entering through it (there is no way out)', room, [[0.5, 5.5], [0.5, 7.5], [1.5, 8.5], [-0.5, 9.5]], [0.5, -3.5])

// 3. Open ground, zombies in front, a 23-block drop four blocks behind the bot.
const cliff = (x, y, z) => (z <= -5 ? y <= 40 : y <= 63)
scenario('3) cliff behind the bot (23-block drop), 4 zombies in front', cliff, [[0.5, 8.5], [3.5, 9.5], [-3.5, 9.5], [0.5, 11.5]], [0.5, -0.5])

// 4. Open ground, ring of zombies with one gap (west): the simple case.
const ring = []
for (let i = 0; i < 16; i++) { const a = (i / 16) * 2 * Math.PI; if (Math.abs(a - Math.PI * 1.5) >= 0.6) ring.push([0.5 + Math.sin(a) * 8, 0.5 - Math.cos(a) * 8]) }
scenario('4) open ground, ring of 13 zombies with a gap to the west', world.flat, ring, [0.5, 0.5])

// 5. A side room off a corridor: the way out is past the door the zombies are coming through,
//    but the room has a second exit on the far side.
const twoExits = (x, y, z) => y <= 63 ||
  (y >= 64 && y <= 66 && (((x === -6 || x === 6) && z >= -6 && z <= 6) || ((z === -6 || z === 6) && x >= -6 && x <= 6)) && !(z === 6 && x === 0 && y <= 65) && !(x === -6 && z === -4 && y <= 65)) ||
  (y === 67 && x >= -6 && x <= 6 && z >= -6 && z <= 6)
scenario('5) the same room with a second doorway in the far wall', twoExits, [[0.5, 5.5], [0.5, 7.5], [1.5, 8.5], [-0.5, 9.5]], [0.5, -1.5])
