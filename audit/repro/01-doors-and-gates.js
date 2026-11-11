'use strict'
/**
 * Can the pathfinder, configured exactly as the harness configures it, get out
 * of a closed room whose only opening is a door / fence gate / trapdoor?
 *
 *   node audit/repro/01-doors-and-gates.js
 *
 * At the time of the audit every door, and every gate newer than dark oak, answered "noPath".
 * The harness now judges doors by block state (zincai/custom_mineflayer/doors.js); the clicks
 * are made by the wrapper on the way, not planned by A*, so the route itself contains none.
 * (--fix applies the 15-line sketch from the report on top; it is no longer needed.)
 */
const { req, world } = require('./_common')
const { Vec3, registry, Block, Movements, goals } = world
const { PathfinderWrapper } = req('zincai/custom_mineflayer/pathfinder_wrapper.js')
const FIX = process.argv.includes('--fix')

const AIR = registry.blocksByName.air.defaultState
const STONE = registry.blocksByName.stone.defaultState
const state = (name, props) => Block.fromProperties(registry.blocksByName[name].id, props, 0).stateId
const door = (name, open) => ({ lower: state(name, { half: 'lower', open, facing: 'north', hinge: 'left', powered: false }), upper: state(name, { half: 'upper', open, facing: 'north', hinge: 'left', powered: false }) })
const gate = (name, open) => ({ lower: state(name, { facing: 'north', in_wall: false, open, powered: false }), upper: AIR })

/** 7x6 room (walls 3 high), bot inside, a 1x2 opening at x=0,z=3 filled with `opening`. */
function room (opening) {
  const cache = new Map()
  const bot = {
    registry, version: '1.21.4', game: { minY: -64, height: 384 }, entities: {}, inventory: { items: () => [] },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, -0.0784, 0), onGround: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0 },
    blockAt (p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const key = `${x},${y},${z}`
      let b = cache.get(key)
      if (!b) {
        let s = y <= 63 ? STONE : AIR
        if (y >= 64 && y <= 66) {
          const wall = ((x === -4 || x === 4) && z >= -4 && z <= 3) || ((z === -4 || z === 3) && x >= -4 && x <= 4)
          if (wall) s = (x === 0 && z === 3 && y <= 65) ? (y === 64 ? opening.lower : opening.upper) : STONE
        }
        b = Block.fromStateId(s, 0); b.position = new Vec3(x, y, z); cache.set(key, b)
      }
      return b
    }
  }
  bot.entities[1] = bot.entity
  bot.pathfinder = { movements: null, bestHarvestTool: () => null }
  return bot
}

/** The fix sketched in the report: every wooden door/gate is openable, open ones are simply walkable. */
function stateAware (movements) {
  const DOOR = /_door$/; const GATE = /_fence_gate$/; const TRAP = /_trapdoor$/
  for (const b of registry.blocksArray) if ((DOOR.test(b.name) || GATE.test(b.name) || TRAP.test(b.name)) && !/iron/.test(b.name)) movements.openable.add(b.id)
  const original = movements.getBlock
  movements.getBlock = function (pos, dx, dy, dz) {
    const b = original.call(this, pos, dx, dy, dz)
    const n = b && b.name
    if (!n || /iron/.test(n) || !(DOOR.test(n) || GATE.test(n))) return b
    const p = b.getProperties()
    const open = p.open === true || p.open === 'true'
    if (open || (DOOR.test(n) && p.half === 'upper')) { b.safe = true; b.physical = false; b.openable = false }
    return b
  }
}

function run (label, opening) {
  const bot = room(opening)
  const movements = new Movements(bot)
  bot.pathfinder.movements = movements
  new PathfinderWrapper(bot, { allowDigging: false, allowScaffolding: false, enableWindCharge: false }).configureMovements(movements)
  if (FIX) stateAware(movements)
  const r = world.plan(bot, movements, new goals.GoalBlock(0, 64, 6), { timeout: 3000 })
  const uses = r.path.reduce((n, m) => n + m.toPlace.filter((t) => t.useOne).length, 0)
  console.log(`${label.padEnd(28)} ${r.status.padEnd(8)} ${uses ? `(right-clicks planned by upstream A*: ${uses})` : ''}`)
}

console.log(FIX ? 'WITH the state-aware getBlock() sketch:' : 'CURRENT harness configuration:')
run('plain doorway (air)', { lower: AIR, upper: AIR })
run('oak_door, closed', door('oak_door', false))
run('oak_door, OPEN', door('oak_door', true))
run('cherry_door, closed', door('cherry_door', false))
run('iron_door, closed', door('iron_door', false))
run('oak_fence_gate, closed', gate('oak_fence_gate', false))
run('oak_fence_gate, OPEN', gate('oak_fence_gate', true))
run('cherry_fence_gate, closed', gate('cherry_fence_gate', false))
run('cherry_fence_gate, OPEN', gate('cherry_fence_gate', true))
