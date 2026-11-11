'use strict'
/**
 * The wrapper's "close the door behind me" tick: does it also close doors and
 * trapdoors the bot never opened? The bot just walks past them here.
 */
const { req, world } = require('./_common')
const { Vec3, registry, Block } = world
const { PathfinderWrapper } = req('zincai/custom_mineflayer/pathfinder_wrapper.js')

const state = (name, props) => Block.fromProperties(registry.blocksByName[name].id, props, 0).stateId
const placed = new Map([
  ['1,64,0', state('cherry_trapdoor', { facing: 'north', half: 'bottom', open: true, powered: false, waterlogged: false })], // decoration
  ['5,64,1', state('cherry_door', { half: 'lower', open: true, facing: 'north', hinge: 'left', powered: false })] // left open by a friend
])
const clicked = []
const bot = {
  registry,
  entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true },
  blockAt (p) {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    const s = placed.get(`${x},${y},${z}`) ?? (y <= 63 ? registry.blocksByName.stone.defaultState : registry.blocksByName.air.defaultState)
    const b = Block.fromStateId(s, 0); b.position = new Vec3(x, y, z); return b
  },
  activateBlock: async (b) => { clicked.push(`${b.name} at ${b.position.x},${b.position.y},${b.position.z}`) },
  on () {}, removeListener () {}
}
const wrapper = new PathfinderWrapper(bot, { enableWindCharge: false })
const realNow = Date.now
let t = realNow()
Date.now = () => t
for (let step = 0; step <= 160; step++) { // 8 blocks east, 20 ticks per block; no goal, nothing opened by the bot
  bot.entity.position = new Vec3(0.5 + step * 0.05, 64, 0.5)
  t += 50
  wrapper._doorTick()
}
Date.now = realNow
console.log('The bot walked 8 blocks past an open trapdoor and an open door it never touched.')
console.log('Right-clicked (closed) by the wrapper:', clicked.length ? clicked.join(' ; ') : 'nothing')
