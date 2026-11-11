/**
 * An editable block world plus a walker that follows the REAL A* route the way
 * the pathfinder's executor does: node by node, stopped by whatever door or
 * gate is physically shut in front of it. Right-clicks toggle block states
 * (after an optional server delay), so "open → pass → close" can be tested
 * end to end without a server.
 */
'use strict'

const { EventEmitter } = require('events')
const world = require('./world')
const doors = require('../../zincai/custom_mineflayer/doors')
const { Vec3, registry, Block } = world

const AIR = registry.blocksByName.air.defaultState
const STONE = registry.blocksByName.stone.defaultState
const stateOf = (name, props = {}) => Block.fromProperties(registry.blocksByName[name].id, props, 0).stateId

/** Both halves of a door at (x, y, z). */
function doorStates (name, { open = false, facing = 'north', hinge = 'left' } = {}) {
  return {
    lower: stateOf(name, { half: 'lower', open, facing, hinge, powered: false }),
    upper: stateOf(name, { half: 'upper', open, facing, hinge, powered: false })
  }
}
const gateState = (name, { open = false, facing = 'north' } = {}) => stateOf(name, { facing, in_wall: false, open, powered: false })
const trapdoorState = (name, { open = false, facing = 'north', half = 'bottom' } = {}) => stateOf(name, { facing, half, open, powered: false, waterlogged: false })

/**
 * @param {(x:number,y:number,z:number)=>boolean} solid terrain (true = stone)
 * @param {{ latencyTicks?: number, locked?: string[] }} [opts]
 *   latencyTicks: ticks before a right-click changes the block (a real server is never instant)
 *   locked: 'x,y,z' keys of doors that ignore clicks (a claim plugin)
 */
function editableWorld (solid = world.flat, { latencyTicks = 0, locked = [] } = {}) {
  const states = new Map()
  const lockedSet = new Set(locked)
  const pending = [] // { at: tick, fn }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    version: '1.21.4',
    game: { minY: -64, height: 384 },
    entities: {},
    inventory: { items: () => [] },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, -0.0784, 0), onGround: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0 },
    clicks: [],
    tickNo: 0
  })
  bot.entities[1] = bot.entity
  bot.blockAt = (p) => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const s = states.get(`${x},${y},${z}`) ?? (solid(x, y, z) ? STONE : AIR)
    const b = Block.fromStateId(s, 0)
    b.position = new Vec3(x, y, z)
    return b
  }
  bot.set = (x, y, z, state) => { states.set(`${x},${y},${z}`, state) }
  bot.placeDoor = (x, y, z, name, opts) => { const d = doorStates(name, opts); bot.set(x, y, z, d.lower); bot.set(x, y + 1, z, d.upper) }
  bot.placeGate = (x, y, z, name, opts) => bot.set(x, y, z, gateState(name, opts))
  bot.placeTrapdoor = (x, y, z, name, opts) => bot.set(x, y, z, trapdoorState(name, opts))
  bot.isOpen = (x, y, z) => Boolean(doors.describe(bot.blockAt(new Vec3(x, y, z)))?.open)

  const toggle = (pos) => {
    const block = bot.blockAt(pos)
    const d = doors.describe(block)
    if (!d || !d.byHand) return
    const flip = (p) => {
      const b = bot.blockAt(p)
      if (!doors.describe(b)) return
      const props = b.getProperties()
      bot.set(p.x, p.y, p.z, Block.fromProperties(b.type, { ...props, open: !d.open }, 0).stateId)
    }
    flip(pos)
    if (d.kind === 'door') flip(pos.offset(0, d.half === 'upper' ? -1 : 1, 0))
  }
  bot.activateBlock = async (block) => {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    bot.clicks.push({ name: block.name, key, tick: bot.tickNo })
    if (lockedSet.has(key)) return
    const pos = block.position.clone()
    if (latencyTicks > 0) pending.push({ at: bot.tickNo + latencyTicks, fn: () => toggle(pos) })
    else toggle(pos)
  }
  bot.serverTick = () => {
    bot.tickNo++
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= bot.tickNo) { pending[i].fn(); pending.splice(i, 1) }
  }

  let moving = false
  let movements = null
  bot.pathfinder = {
    get movements () { return movements },
    setMovements (m) { movements = m; bot.replan = true },
    isMoving: () => moving,
    bestHarvestTool: () => null
  }
  bot._setMoving = (v) => { moving = v }
  return bot
}

/** Is the walker physically stopped from stepping from `from` into `to`? */
function shutBetween (bot, from, to) {
  const axis = to.x !== from.x ? 'x' : 'z'
  for (const cell of [to, from]) {
    for (const dy of [0, 1]) {
      const d = doors.describe(bot.blockAt(new Vec3(cell.x, cell.y + dy, cell.z)))
      if (!d || d.kind === 'trapdoor') continue
      if (doors.blocksWalk(d, axis)) return true
    }
  }
  return false
}

/**
 * Plan with the real A* and walk the route at 4 blocks/s, running the
 * wrapper's door tick on a simulated 20 Hz clock.
 * @returns {Promise<{ status:string, arrived:boolean, ticks:number, replans:number }>}
 */
async function walkTo (bot, wrapper, goal, { maxTicks = 1200, speed = 0.2, after = 40 } = {}) {
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  let replans = 0
  let ticks = 0
  let arrived = false
  let status = 'success'
  try {
    let path = null
    const plan = () => {
      const r = world.plan(bot, bot.pathfinder.movements, goal, { timeout: 2000 })
      status = r.status
      path = r.path
      bot.replan = false
      bot._setMoving(path.length > 0)
      bot.emit('path_update', r)
      return r
    }
    plan()
    let stuck = 0
    while (ticks < maxTicks) {
      ticks++
      clock += 50
      bot.serverTick()
      if (bot.replan) { replans++; plan() }
      if (path.length) {
        const me = bot.entity.position
        const from = me.floored()
        const node = path[0]
        const to = { x: node.x, y: node.y, z: node.z }
        const crossing = to.x !== from.x || to.z !== from.z
        if (crossing && shutBetween(bot, from, to)) {
          if (++stuck > 70) { stuck = 0; replans++; plan() } // upstream: "stuck" after 3.5 s
        } else {
          stuck = 0
          const dx = node.x + 0.5 - me.x; const dz = node.z + 0.5 - me.z
          const len = Math.hypot(dx, dz)
          if (len <= speed) { me.x = node.x + 0.5; me.z = node.z + 0.5; me.y = node.y; path.shift() } else { me.x += dx / len * speed; me.z += dz / len * speed }
        }
        if (!path.length) { bot._setMoving(false); arrived = goal.isEnd(bot.entity.position.floored()) }
      } else if (after-- <= 0) break
      wrapper._doorTick()
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    Date.now = realNow
  }
  return { status, arrived, ticks, replans }
}

module.exports = { editableWorld, walkTo, doorStates, gateState, trapdoorState, stateOf, AIR, STONE }
