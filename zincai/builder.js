/**
 * builder.js — BlueprintParser: LLM build commands -> sequential, scaffold-aware
 * Mineflayer placement.
 *
 * Research references: Voyager (LLM emits a skill; code executes it) and
 * MineDojo (structured action space over block placements). The LLM is
 * NEVER asked to micromanage block coordinates one at a time; it names a
 * blueprint (local file) or hands us a small inline grid, and this module
 * computes EVERYTHING else locally:
 *
 *   - bottom-to-top build order (gravity-safe),
 *   - inventory requirements per material (pre-flight check),
 *   - whether the bot can reach each layer (jump-reach ~4.5 blocks),
 *   - scaffold/dirt towers when the structure exceeds reach,
 *   - re-verification of each placed block with a retry budget,
 *   - compact {ok, placed, skipped, missing[], towerUsed} feedback for the LLM.
 *
 * Blueprint file format (zincai/blueprints/*.json):
 *   {
 *     "name": "small_house",
 *     "palette": { "#": "oak_planks", "G": "glass" },
 *     "grid": [[ layer(y=0) rows z ], [ layer(y=1) ... ], ...]
 *   }
 *   Each cell is one palette char or '.'/' ' for air. Grid layout per layer:
 *   rows indexed by z, columns by x. y grows bottom -> top.
 *
 * Inline grid format (LLM output):
 *   {"a":"build","grid": [[[...],[...]], ...], "palette": {"#": "stone"}}
 *   grid[y][z][x] — same semantics.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const BLUEPRINT_DIR = path.join(__dirname, 'blueprints')
const AIR = new Set(['.', ' ', 'air', 'cave_air', 'void_air'])

/** Parse one grid layer (array of row strings) or array-of-arrays. */
function parseLayer (layer) {
  const rows = []
  for (const row of layer) {
    rows.push(Array.isArray(row) ? row.slice() : String(row).split(''))
  }
  return rows
}

/**
 * BlueprintParser — pure parsing/planning, no bot needed (unit-testable).
 */
class BlueprintParser {
  constructor ({ blueDir = BLUEPRINT_DIR, scaffoldBlocks = ['dirt', 'cobblestone', 'netherrack'], reach = 4.5 } = {}) {
    this.blueDir = blueDir
    this.scaffoldBlocks = scaffoldBlocks
    this.reach = reach
  }

  listAvailable () {
    try {
      return fs.readdirSync(this.blueDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  /** Load a blueprint file by name (sans extension). */
  load (name) {
    const safe = String(name).replace(/[^a-z0-9_-]/gi, '')
    const file = path.join(this.blueDir, `${safe}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) // throws with clear ENOENT/JSON errors — caller wraps
    return this._parseDoc(raw, safe)
  }

  /** Parse an inline LLM grid document. */
  parseInline (doc) {
    return this._parseDoc(doc, 'inline')
  }

  _parseDoc (doc, name) {
    if (!doc || !Array.isArray(doc.grid) || !doc.palette) {
      throw new Error('blueprint needs { palette, grid }')
    }
    const blocks = []
    const layers = doc.grid
    for (let y = 0; y < layers.length; y++) {
      const rows = parseLayer(layers[y])
      for (let z = 0; z < rows.length; z++) {
        const cols = rows[z]
        for (let x = 0; x < cols.length; x++) {
          const key = cols[x]
          if (AIR.has(String(key))) continue
          const blockName = doc.palette[key]
          if (!blockName) throw new Error(`unknown palette key "${key}" at y=${y} z=${z} x=${x}`)
          blocks.push({ dx: x, dy: y, dz: z, name: blockName })
        }
      }
    }
    // bottom -> top, then nearest-first inside each layer (stable placement order)
    blocks.sort((a, b) => (a.dy - b.dy) || (Math.abs(a.dx - Math.floor(0)) + Math.abs(a.dz - Math.floor(0))) - (Math.abs(b.dx - Math.floor(0)) + Math.abs(b.dz - Math.floor(0))))
    return { name, blocks, blockCount: blocks.length }
  }

  /** Inventory census: { name -> count } (summed over stacks). */
  static census (items) {
    const map = new Map()
    for (const item of items || []) {
      map.set(item.name, (map.get(item.name) || 0) + item.count)
    }
    return map
  }

  /**
   * Pre-flight: can the bot materialize these blocks?
   * Scaffold blocks (for towers) are demanded IN ADDITION to the blueprint.
   * Returns { ok, missing: [{name, need, have}], counts }.
   */
  checkInventory (blocks, items, towerBlocks = []) {
    const need = new Map()
    for (const b of blocks) need.set(b.name, (need.get(b.name) || 0) + 1)
    for (const name of towerBlocks) need.set(name, (need.get(name) || 0) + 1)
    const census = BlueprintParser.census(items)
    const missing = []
    for (const [name, count] of need) {
      const have = census.get(name) || 0
      if (have < count) missing.push({ name, need: count, have })
    }
    return { ok: missing.length === 0, missing, counts: Object.fromEntries(need) }
  }

  /**
   * Build the execution plan.
   *
   * @param {{blocks:Array}} parsed
   * @param {{x,y,z}} origin        world offset (bot's feet at build start)
   * @param {{x,y,z}} botPos        current bot position (same axes)
   * @returns plan { steps[], towerNeeded, maxY, towerHeight }
   *   steps: [{ x, y, z, name, needsTower, towerY? }]
   */
  plan (parsed, origin, botPos) {
    const maxLocalY = parsed.blocks.reduce((m, b) => Math.max(m, b.dy), 0)
    const baseY = Math.floor(botPos.y)
    const originY = baseY // blueprint y=0 sits on the bot's current floor
    const standBase = baseY
    const steps = []
    for (const b of parsed.blocks) {
      const worldY = originY + b.dy
      const topReach = standBase + this.reach
      const needsTower = worldY > topReach + 0.0
      steps.push({ x: origin.x + b.dx, y: worldY, z: origin.z + b.dz, name: b.name, needsTower, localDy: b.dy })
    }
    const maxY = originY + maxLocalY
    const towerNeeded = maxY > standBase + this.reach
    const towerHeight = towerNeeded ? Math.ceil(maxY - (standBase + this.reach)) : 0
    return { steps, towerNeeded, maxY, towerHeight, originY }
  }
}

/**
 * Executes a plan against a live bot. Kept separate from the parser so the
 * parser stays unit-testable without a bot.
 */
class BuilderExecutor {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{ scaffoldBlocks?: string[], logger?: (level, msg) => void, buildStepDelayMs?: number }} [opts]
   */
  constructor (bot, opts = {}) {
    this.bot = bot
    this.scaffoldBlocks = opts.scaffoldBlocks || ['dirt', 'cobblestone', 'netherrack']
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {}
    this.stepDelayMs = opts.buildStepDelayMs ?? 60
    this.cancelRequested = false
  }

  cancel () { this.cancelRequested = true }

  /** Best scaffold block available in inventory. */
  _pickScaffold () {
    const inv = this.bot.inventory.items()
    for (const name of this.scaffoldBlocks) {
      const it = inv.find((i) => i.name === name)
      if (it) return it
    }
    return null
  }

  /** Count of a given block-name item currently held. */
  _count (name) {
    return this.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
  }

  /** Walk within reach of a block; returns true when close enough to place. */
  async _approach (target, distance = 3) {
    const { goals } = require('mineflayer-pathfinder')
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('approach timeout')), 20_000)
      this.bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, distance), true)
      const iv = setInterval(() => {
        const p = this.bot.entity?.position
        if (!p) return
        const d = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z)
        if (d <= distance + 0.6) { clearInterval(iv); clearTimeout(t); resolve() }
      }, 150)
    }).catch((err) => this.log('debug', `approach: ${err.message || err}`))
    try { this.bot.pathfinder.setGoal(null) } catch { /* noop */ }
  }

  /**
   * Place ONE block at the target position against a known good reference.
   * Resolves true on success (verified), false otherwise.
   */
  async _placeAt (target, itemName) {
    const bot = this.bot
    const item = bot.inventory.items().find((i) => i.name === itemName)
    if (!item) return false
    try { await bot.equip(item, 'hand') } catch { return false }
    const refOffsets = [
      { ref: target.offset(0, -1, 0), face: { x: 0, y: 1, z: 0 } },  // place on top of the block below
      { ref: target.offset(0, 1, 0), face: { x: 0, y: -1, z: 0 } },  // hang under the block above
      { ref: target.offset(1, 0, 0), face: { x: -1, y: 0, z: 0 } },
      { ref: target.offset(-1, 0, 0), face: { x: 1, y: 0, z: 0 } },
      { ref: target.offset(0, 0, 1), face: { x: 0, y: 0, z: -1 } },
      { ref: target.offset(0, 0, -1), face: { x: 0, y: 0, z: 1 } }
    ]
    const { Vec3 } = require('vec3')
    for (const { ref, face } of refOffsets) {
      const refBlock = bot.blockAt(ref)
      if (!refBlock || refBlock.name === 'air' || refBlock.name === 'cave_air') continue
      try {
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))
        await new Promise((r) => setTimeout(r, this.stepDelayMs))
        const placed = bot.blockAt(target)
        if (placed && placed.name === itemName) return true
      } catch {
        // try the next reference face
      }
    }
    return false
  }

  /**
   * Pillar-jump upward until the bot stands at/above targetY.
   * Classic jump-place-under-feet tower. Consumes scaffold blocks.
   */
  async pillarUpTo (targetY) {
    const bot = this.bot
    const Vec3 = require('vec3').Vec3
    let guard = 0
    while (guard++ < 40) {
      const feetY = Math.floor(bot.entity.position.y)
      if (feetY >= targetY) return true
      const scaffold = this._pickScaffold()
      if (!scaffold) { this.log('warn', 'out of scaffold blocks mid-tower'); return false }
      await bot.equip(scaffold, 'hand')
      const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!below) return false
      bot.setControlState('jump', true)
      await new Promise((r) => setTimeout(r, 120))
      try {
        const refBlock = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
        if (refBlock) await bot.placeBlock(refBlock, new Vec3(0, 1, 0))
      } catch (err) {
        this.log('debug', `tower place failed: ${err.message || err}`)
      }
      bot.setControlState('jump', false)
      await new Promise((r) => setTimeout(r, 180))
    }
    return false
  }

  /**
   * Execute a full plan. Returns compact stats for the LLM.
   */
  async build (plan) {
    this.cancelRequested = false
    const bot = this.bot
    let placed = 0
    const skipped = []
    let towerUsed = 0
    for (const step of plan.steps) {
      if (this.cancelRequested) return { ok: false, reason: 'cancelled', placed, skipped, missing: [], towerUsed }
      const target = new (require('vec3').Vec3)(step.x, step.y, step.z)
      const needed = step.y - Math.floor(bot.entity.position.y)
      if (needed > 4) {
        const before = this._count(this.scaffoldBlocks[0])
        const ok = await this.pillarUpTo(step.y - 3)
        if (ok) towerUsed += Math.max(0, before - this._count(this.scaffoldBlocks[0]))
      }
      await this._approach(target, 3)
      const ok = await this._placeAt(target, step.name)
      if (ok) placed++
      else skipped.push(`${step.name}@${step.x},${step.y},${step.z}`)
    }
    // Tower blocks are consumed from scaffold inventory — caller reports usage.
    return { ok: skipped.length === 0, placed, skipped, missing: [], towerUsed }
  }
}

module.exports = { BlueprintParser, BuilderExecutor, BLUEPRINT_DIR }
