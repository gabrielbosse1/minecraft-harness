/**
 * test/helpers/fake-world.js — offline synthetic Minecraft world for renderer
 * tests. A real prismarine-chunk column set + the real minecraft-data
 * registry, exposed through the small part of the Mineflayer bot API that
 * `zincai/vision.js` reads (world.columns, entity, entities, players, time).
 *
 * No server, socket, or world generation is involved: tests place exactly the
 * blocks they want and render them through the real native asset pipeline.
 */
'use strict'

const Chunk = require('prismarine-chunk')('1.21.4')
const Block = require('prismarine-block')('1.21.4')
const registry = require('minecraft-data')('1.21.4')
const { Vec3 } = require('vec3')

const VERSION = '1.21.4'

function createFakeWorld ({ minX = -8, maxX = 40, minZ = -16, maxZ = 32, groundY = 64 } = {}) {
  const columns = new Map()

  function column (cx, cz) {
    const key = `${cx},${cz}`
    let col = columns.get(key)
    if (!col) {
      col = new Chunk({ minY: -64, worldHeight: 384 })
      columns.set(key, col)
    }
    return col
  }

  function stateFor (name, props) {
    const def = registry.blocksByName[name]
    if (!def) throw new Error(`unknown block ${name}`)
    if (!props) return def.defaultState
    for (let id = def.minStateId; id <= def.maxStateId; id++) {
      const p = Block.fromStateId(id, 0).getProperties()
      let ok = true
      for (const [key, value] of Object.entries(props)) {
        if (String(p[key]) !== String(value)) { ok = false; break }
      }
      if (ok) return id
    }
    return def.defaultState
  }

  function set (x, y, z, name, props) {
    const state = stateFor(name, props)
    column(x >> 4, z >> 4).setBlock(new Vec3(x & 15, y, z & 15), Block.fromStateId(state, 0), false)
  }

  function fill (x0, y0, z0, x1, y1, z1, name, props) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) set(x, y, z, name, props)
      }
    }
  }

  // A grass plain with stone underneath, so nothing floats in unloaded space.
  for (let x = minX; x < maxX; x++) {
    for (let z = minZ; z < maxZ; z++) {
      set(x, groundY - 1, z, 'stone')
      set(x, groundY, z, 'grass_block')
    }
  }

  function blockAt (p) {
    const col = columns.get(`${p.x >> 4},${p.z >> 4}`)
    if (!col) return null
    const id = col.getBlockStateId({ x: p.x & 15, y: p.y, z: p.z & 15 })
    return registry.blocksByStateId[id] || null
  }

  function makeBot ({ x = 8.5, y = groundY, z = 10.5, yaw = 0, pitch = 0 } = {}) {
    return {
      version: VERSION,
      registry,
      world: { columns },
      entity: { position: new Vec3(x, y, z), yaw, pitch },
      entities: {},
      players: {},
      time: { timeOfDay: 6000 },
      game: { dimension: 'overworld' },
      health: 20,
      food: 20,
      blockAt
    }
  }

  return { version: VERSION, registry, columns, set, fill, blockAt, makeBot, groundY }
}

module.exports = { createFakeWorld, VERSION, registry }
