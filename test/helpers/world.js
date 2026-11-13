/**
 * Synthetic block world for tests: real prismarine blocks, the REAL
 * mineflayer-pathfinder Movements + A*, and real prismarine-physics — only the
 * terrain and the entities are made up. No server, no network.
 */
'use strict'

const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.4')
const Block = require('prismarine-block')(registry)
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')

const STONE = registry.blocksByName.stone.defaultState
const AIR = registry.blocksByName.air.defaultState

/** Flat ground at y <= 63, air above. */
const flat = (x, y, z) => y <= 63

/**
 * @param {(x:number,y:number,z:number)=>boolean|string} solidFn true = stone,
 *        a string = that block name, false = air
 */
function makeWorld (solidFn = flat, { items = [] } = {}) {
  const cache = new Map()
  const bot = Object.assign(new EventEmitter(), {
    registry,
    version: '1.21.4',
    game: { minY: -64, height: 384 },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, -0.0784, 0), onGround: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0 },
    entities: {},
    inventory: { items: () => items.map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    // mineflayer-pathfinder -> bot.pathfinder.bestHarvestTool(block) whenever a
    // route may break a block. No tools in these worlds: an empty hand.
    pathfinder: { bestHarvestTool: () => null },
    blockAt (p) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const key = x + ',' + y + ',' + z
      let b = cache.get(key)
      if (!b) {
        const what = solidFn(x, y, z)
        const state = what === true ? STONE : (typeof what === 'string' ? registry.blocksByName[what].defaultState : AIR)
        b = Block.fromStateId(state, 0)
        b.position = new Vec3(x, y, z)
        cache.set(key, b)
      }
      return b
    }
  })
  bot.entities[1] = bot.entity
  return bot
}

/** Add a mob standing on the ground (vy = gravity constant, like the real game). */
function addMob (bot, id, name, x, z, { vx = 0, vz = 0, y = 64, ...extra } = {}) {
  const e = { id, name, type: name === 'player' ? 'player' : 'hostile', position: new Vec3(x, y, z), velocity: new Vec3(vx, -0.0784, vz), height: 1.95, width: 0.6, onGround: true, ...extra }
  bot.entities[id] = e
  return e
}

/** Mob at (x,z) walking straight at the bot's position at `speed` blocks/tick. */
function addApproaching (bot, id, name, x, z, speed = 0.115) {
  const me = bot.entity.position
  const len = Math.hypot(x - me.x, z - me.z) || 1
  return addMob(bot, id, name, x, z, { vx: -(x - me.x) / len * speed, vz: -(z - me.z) / len * speed })
}

/** Run A* the way bot.pathfinder does: 40 ms slices until done or `timeout`. */
function plan (bot, movements, goal, { timeout = 5000, tickTimeout = 40 } = {}) {
  const p = bot.entity.position.floored()
  const start = new Move(p.x, p.y, p.z, movements.countScaffoldingItems(), 0)
  movements.clearCollisionIndex()
  movements.updateCollisionIndex()
  const ctx = new AStar(start, movements, goal, timeout, tickTimeout, -1)
  let result = ctx.compute()
  while (result.status === 'partial') result = ctx.compute()
  return {
    status: result.status,
    ms: Math.round(result.time),
    visited: result.visitedNodes,
    path: result.path,
    placed: result.path.reduce((n, m) => n + m.toPlace.filter((t) => !t.useOne).length, 0),
    broken: result.path.reduce((n, m) => n + m.toBreak.length, 0)
  }
}

/** Closest horizontal approach of a path to any other entity. */
function closestApproach (bot, path) {
  let best = Infinity
  for (const n of path) {
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity) continue
      best = Math.min(best, Math.hypot(e.position.x - (n.x + 0.5), e.position.z - (n.z + 0.5)))
    }
  }
  return best
}

module.exports = { Vec3, registry, Block, Movements, goals, flat, makeWorld, addMob, addApproaching, plan, closestApproach }
