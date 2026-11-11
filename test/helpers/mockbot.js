/**
 * Mock mineflayer bot for reflex/combat tests: an EventEmitter with a
 * control-state map and a pathfinder stub that mirrors upstream 2.4.5, where
 * setGoal() -> resetPath() -> bot.clearControlStates().
 */
'use strict'

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

function makeBot ({ items = [], held = null, yaw = 0, health = 20, food = 20, floorY = 64, blockAt = null } = {}) {
  const bot = new EventEmitter()
  bot.setMaxListeners(60)
  const controls = Object.fromEntries(CONTROLS.map((c) => [c, false]))
  const log = { setGoal: [], activate: 0, deactivate: 0, equip: [], attack: [], consume: 0, chat: [], elytraFly: 0, looks: [] }
  bot.username = 'ZincAI'
  bot.health = health
  bot.food = food
  bot.heldItem = held ? { name: held } : null
  bot.entity = { id: 1, position: new Vec3(0.5, floorY, 0.5), velocity: new Vec3(0, -0.0784, 0), yaw, pitch: 0, onGround: true, height: 1.8, metadata: [] }
  bot.entities = { 1: bot.entity }
  bot.players = {}
  bot.controls = controls
  bot.log = log
  bot.setControlState = (c, v) => { controls[c] = Boolean(v) }
  bot.getControlState = (c) => controls[c]
  bot.clearControlStates = () => { for (const c of CONTROLS) controls[c] = false }
  bot.inventory = { items: () => items, slots: [] }
  bot.blockAt = blockAt || ((p) => {
    const y = Math.floor(p.y)
    return y < floorY ? { name: 'stone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }
  })
  bot.lookAt = async (p) => { log.looks.push(p) }
  bot.look = async (y, p) => { bot.entity.yaw = y; bot.entity.pitch = p; log.looks.push({ yaw: y, pitch: p }) }
  bot.equip = async (item, dest) => { log.equip.push(`${item?.name}@${dest || 'hand'}`); if (!dest || dest === 'hand') bot.heldItem = item }
  bot.activateItem = () => { log.activate++ }
  bot.deactivateItem = () => { log.deactivate++ }
  bot.attack = (e) => { log.attack.push(e?.id) }
  bot.consume = async () => { log.consume++ }
  bot.elytraFly = async () => { log.elytraFly++ }
  bot.chat = (t) => log.chat.push(t)
  let goal = null
  bot.pathfinder = {
    get goal () { return goal },
    movements: null,
    setGoal (g, dynamic) {
      goal = g
      log.setGoal.push({ kind: g === null ? 'null' : g.constructor.name, dynamic: Boolean(dynamic) })
      bot.clearControlStates() // upstream resetPath('goal_updated')
    },
    setMovements (m) { this.movements = m },
    isMoving: () => goal !== null
  }
  return bot
}

/** Entity factory. Players expose equipment[]; mobs report the gravity constant as vy. */
function ent (id, name, x, z, extra = {}) {
  const player = name === 'player'
  const e = {
    id,
    name,
    type: player ? 'player' : 'hostile',
    position: new Vec3(x, extra.y ?? 64, z),
    velocity: new Vec3(0, player ? 0 : -0.0784, 0),
    onGround: true, // mineflayer never updates this for other entities
    height: 1.8,
    equipment: new Array(6),
    metadata: [],
    isValid: true,
    ...extra
  }
  delete e.y
  Object.defineProperty(e, 'heldItem', { get () { return this.equipment[0] }, configurable: true })
  return e
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const heldKeys = (bot) => Object.entries(bot.controls).filter(([, v]) => v).map(([k]) => k).sort().join('+') || '(none)'

module.exports = { makeBot, ent, sleep, heldKeys, CONTROLS, Vec3 }
