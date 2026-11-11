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

// ============================================================================
// Phased decomposition — the LLM plans in phases, the executor places them.
//
//   foundation  →  walls (with windows)  →  roof  →  detailing/interior
//
// The phase of a block is derived from geometry (vertical position) and
// material role (doors/glass/torches are detailing even at ground level), so
// the model never has to emit coordinates. Every block belongs to exactly ONE
// phase, which makes per-phase builds idempotent: re-running a phase only
// fills what is missing.
// ============================================================================

const PHASE_ORDER = ['foundation', 'walls', 'roof', 'detailing']
const PHASE_ALIASES = {
  foundation: 'foundation',
  base: 'foundation',
  walls: 'walls',
  wall: 'walls',
  walls_with_windows: 'walls',
  wall_with_windows: 'walls',
  roof: 'roof',
  roofing: 'roof',
  detailing: 'detailing',
  details: 'detailing',
  interior: 'detailing',
  interior_details: 'detailing'
}

/** Decorative / fixture blocks: detailing wherever they sit vertically. */
const DETAILING_BLOCK_RE = /(door|trapdoor|fence_gate|glass|pane|torch|lantern|candle|campfire|chest|barrel|shulker|bed|sign|banner|painting|item_frame|flower_pot|carpet|bookshelf|crafting_table|furnace|smoker|anvil|cauldron|brewing_stand|enchanting_table|ladder|rail|button|lever|pressure_plate|skull|head|bell|composter|lectern|loom|cartography_table|smithing_table|stonecutter|grindstone|beehive|note_block|jukebox|respawn_anchor)/

const isDetailingBlock = (name) => DETAILING_BLOCK_RE.test(String(name || '').toLowerCase())

/**
 * Split a block list into the four canonical phases. Deterministic, pure and
 * lossless: concatenating the phases yields every input block exactly once.
 * @param {Array<{dy:number,name:string}>} blocks
 * @returns {{foundation:Array, walls:Array, roof:Array, detailing:Array}}
 */
function decomposePhases (blocks) {
  const out = { foundation: [], walls: [], roof: [], detailing: [] }
  const list = (blocks || []).filter(Boolean)
  if (!list.length) return out
  let minY = Infinity
  let maxY = -Infinity
  for (const b of list) {
    const y = Number.isFinite(b.dy) ? b.dy : 0
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const span = maxY - minY
  // Top quarter becomes roof; flat structures (span < 3) have no roof band.
  const roofStart = span >= 3 ? maxY - Math.max(1, Math.round(span * 0.25)) : maxY + 1
  for (const b of list) {
    const y = Number.isFinite(b.dy) ? b.dy : 0
    if (isDetailingBlock(b.name)) out.detailing.push(b)
    else if (y <= minY) out.foundation.push(b)
    else if (y > roofStart) out.roof.push(b)
    else out.walls.push(b)
  }
  return out
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
   * Expose the phase split for callers that want to pre-flight per stage.
   * @param {Array<{dy:number,name:string}>} blocks
   */
  decompose (blocks) {
    const phases = decomposePhases(blocks)
    const counts = Object.fromEntries(PHASE_ORDER.map((p) => [p, phases[p].length]))
    return { phases, counts, order: PHASE_ORDER }
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
    // Absolute `at` origin wins; otherwise blueprint y=0 sits on the bot's floor.
    const originY = Number.isFinite(Number(origin?.y)) ? Math.floor(origin.y) : Math.floor(botPos.y)
    const standBase = Math.floor(botPos.y)
    const phaseBuckets = decomposePhases(parsed.blocks)
    const phaseOf = new Map()
    for (const phase of PHASE_ORDER) {
      for (const b of phaseBuckets[phase]) phaseOf.set(b, phase) // identity-keyed
    }
    const steps = []
    for (const b of parsed.blocks) {
      const worldY = originY + b.dy
      const topReach = standBase + this.reach
      const needsTower = worldY > topReach + 0.0
      steps.push({ x: origin.x + b.dx, y: worldY, z: origin.z + b.dz, name: b.name, needsTower, localDy: b.dy, phase: phaseOf.get(b) || 'walls' })
    }
    const maxY = originY + maxLocalY
    const towerNeeded = maxY > standBase + this.reach
    const towerHeight = towerNeeded ? Math.ceil(maxY - (standBase + this.reach)) : 0
    return { steps, towerNeeded, maxY, towerHeight, originY, phaseCounts: Object.fromEntries(Object.entries(phaseBuckets).map(([k, v]) => [k, v.length])) }
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
    // Optional ControlArbiter lane (zincai/control.js). Without it the builder
    // drives the pathfinder directly, as before.
    this.hands = opts.hands || null
    this.cancelRequested = false
    this.placedScaffolds = [] // { pos, name } — only blocks WE placed via pillar towers
    this._trackedKeys = new Set() // dedupe re-placements of the same cell
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

  /**
   * Walk within reach of a block. Goes through the task lane when one was
   * injected, so a flee reflex can interrupt the build and the walk resumes
   * afterwards; time spent interrupted does not count against the 20 s budget.
   */
  async _approach (target, distance = 3) {
    const { goals } = require('mineflayer-pathfinder')
    const goal = new goals.GoalNear(target.x, target.y, target.z, distance)
    const setGoal = (g) => {
      try {
        if (this.hands) this.hands.setGoal(g, true)
        else this.bot.pathfinder.setGoal(g, true)
      } catch (err) { this.log('debug', `approach: ${err.message || err}`) }
    }
    setGoal(goal)
    let budget = 20_000
    let last = Date.now()
    while (!this.cancelRequested) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const now = Date.now()
      if (this.hands && this.hands.active && !this.hands.isTop) { last = now; continue }
      budget -= now - last
      last = now
      const p = this.bot.entity?.position
      if (p && Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z) <= distance + 0.6) break
      if (budget <= 0) { this.log('debug', 'approach: timeout'); break }
    }
    setGoal(null)
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
    let tried = 0
    for (const { ref, face } of refOffsets) {
      const refBlock = bot.blockAt(ref)
      if (!refBlock || refBlock.name === 'air' || refBlock.name === 'cave_air') continue
      tried++
      try {
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
        // placeBlock resolves on the dest blockUpdate; poll the world in
        // parallel as ground truth so an unmatched ack never hangs placement.
        const placePromise = bot.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))
        // Avoid an unhandled rejection if the poll wins the race below.
        placePromise.catch(() => {})
        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          const placed = bot.blockAt(target)
          if (placed && placed.name === itemName) return true
          const outcome = await Promise.race([placePromise.then(() => 'ok', (err) => err), new Promise((r) => setTimeout(() => r('pending'), 200))])
          if (outcome !== 'pending') {
            const after = bot.blockAt(target)
            if (!(after && after.name === itemName) && !(outcome && outcome.message)) {
              this.log('debug', `face ${face.x},${face.y},${face.z} placed but target reads ${after?.name ?? 'unknown'}`)
            }
            if (outcome && outcome.message) this.log('debug', `face ${face.x},${face.y},${face.z} rejected: ${outcome.message}`)
            if (after && after.name === itemName) return true
            break
          }
        }
      } catch (err) {
        this.log('debug', `face ${face.x},${face.y},${face.z} rejected: ${err.message || err}`)
      }
    }
    if (tried === 0) this.log('debug', `no solid neighbour to place against for ${itemName}@${target.x},${target.y},${target.z}`)
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
    let stall = 0
    let lastFeetY = Math.floor(bot.entity.position.y)
    while (guard++ < 40) {
      const feetY = Math.floor(bot.entity.position.y)
      if (feetY >= targetY) return true
      if (feetY > lastFeetY) { stall = 0; lastFeetY = feetY } else if (++stall >= 6) {
        this.log('debug', `tower stalled at y=${feetY}; aborting pillar attempt`)
        return false
      }
      const scaffold = this._pickScaffold()
      if (!scaffold) { this.log('warn', 'out of scaffold blocks mid-tower'); return false }
      await bot.equip(scaffold, 'hand')
      const baseY = Math.floor(bot.entity.position.y)
      const basePos = bot.entity.position.floored()
      const below = bot.blockAt(basePos.offset(0, -1, 0))
      if (!below) return false
      // Jump first, place AFTER rising past +1 block: the server refuses to
      // place a block into the player's own floored cell, so placing while
      // grounded always fails. Near the apex the feet cell is one above the
      // target — placing at the threshold can race ahead of the move packets,
      // so target ~1.12 and treat the block write as confirmed by a world poll
      // rather than the packet ack alone.
      bot.setControlState('jump', true)
      const airborneDeadline = Date.now() + 1500
      while (Date.now() < airborneDeadline) {
        if (bot.entity.position.y - baseY >= 1.12) break
        await new Promise((r) => setTimeout(r, 40))
      }
      const dest = basePos
      try {
        const refBlock = bot.blockAt(basePos.offset(0, -1, 0))
        if (refBlock && refBlock.name !== 'air') {
          const placePromise = bot.placeBlock(refBlock, new Vec3(0, 1, 0))
          placePromise.catch(() => {}) // avoid unhandled rejection when the world poll wins
          const deadline = Date.now() + 3000
          while (Date.now() < deadline) {
            const now = bot.blockAt(dest)
            if (now && now.name === scaffold.name) break
            const outcome = await Promise.race([
              placePromise.then(() => 'settled', () => 'settled'),
              new Promise((r) => setTimeout(() => r('pending'), 150))
            ])
            if (outcome !== 'pending') break
          }
          if (bot.blockAt(dest)?.name === scaffold.name) {
            const key = `${dest.x},${dest.y},${dest.z}`
            if (!this._trackedKeys.has(key)) {
              this._trackedKeys.add(key)
              this.placedScaffolds.push({ pos: dest.clone(), name: scaffold.name })
            }
          }
          else this.log('debug', `tower place at ${dest} not confirmed`)
        }
      } catch (err) {
        this.log('debug', `tower place failed: ${err.message || err}`)
      }
      bot.setControlState('jump', false)
      // Wait for touchdown (on the placed block on success, back on the ground otherwise)
      const landDeadline = Date.now() + 2500
      while (Date.now() < landDeadline) {
        if (bot.entity.onGround) break
        await new Promise((r) => setTimeout(r, 60))
      }
      await new Promise((r) => setTimeout(r, 80))
    }
    return Math.floor(bot.entity.position.y) >= targetY
  }

  /**
   * Dig back down the pillar we just climbed. Only touches blocks placed by
   * pillarUpTo during THIS process — never pre-existing world. Digs top-down;
   * the bot falls one block per dig onto the remaining scaffold.
   * @returns {Promise<{removed:number}>}
   */
  async removeScaffolds () {
    const mine = [...this.placedScaffolds]
    this.placedScaffolds = []
    if (mine.length === 0) return { removed: 0 }
    const bot = this.bot
    let removed = 0
    mine.sort((a, b) => b.pos.y - a.pos.y)
    for (const { pos, name } of mine) {
      const now = bot.blockAt(pos)
      if (!now || now.name !== name) continue // replaced or already gone — leave it
      const feet = bot.entity.position
      const d = Math.hypot(feet.x - pos.x, feet.y - pos.y, feet.z - pos.z)
      if (d > 6) await this._approach(pos, 2) // slow but may path across the site
      try {
        const target = bot.blockAt(pos)
        if (!target || target.name !== name) continue
        await bot.dig(target)
        removed++
        await new Promise((r) => setTimeout(r, 120))
      } catch (err) {
        this.log('debug', `scaffold dig failed at ${pos}: ${err.message || err}`)
      }
    }
    this._trackedKeys.clear()
    this.log('info', `scaffold cleanup: removed ${removed} block${removed === 1 ? '' : 's'}`)
    return { removed }
  }

  /**
   * Execute a plan (optionally one phase at a time).
   *
   * Placement is IDEMPOTENT: a cell that already holds the right block is
   * counted as `alreadyPresent` and never re-placed. Steps are always ordered
   * foundation → walls → roof → detailing, then bottom-to-top inside a phase,
   * so a re-run after a disconnect resumes exactly where the world left off.
   *
   * @param {{steps:Array}} plan
   * @param {{stage?:string}} [opts] restrict to one hierarchical phase
   * @returns {Promise<{ok:boolean, placed:number, alreadyPresent:number,
   *   skipped:string[], missing:Array, towerUsed:number, stage:string|null}>}
   */
  async build (plan, { stage = null } = {}) {
    this.cancelRequested = false
    this.hands?.acquire?.({ reason: 'building' })
    try {
      return await this._build(plan, { stage })
    } finally {
      this.hands?.setGoal?.(null)
    }
  }

  async _build (plan, { stage = null } = {}) {
    const bot = this.bot
    const wanted = normalizeStage(stage)
    let placed = 0
    let alreadyPresent = 0
    const skipped = []
    let towerUsed = 0
    const steps = [...plan.steps]
      .map((s, i) => ({ ...s, _i: i, phase: s.phase || 'walls' }))
      .filter((s) => (wanted ? s.phase === wanted : true))
      .sort((a, b) => (PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)) || (a.y - b.y) || (a._i - b._i))
    for (const step of steps) {
      if (this.cancelRequested) return { ok: false, reason: 'cancelled', placed, alreadyPresent, skipped, missing: [], towerUsed, stage: wanted }
      const target = new (require('vec3').Vec3)(step.x, step.y, step.z)
      // Idempotency: the world may already match (previous run, another builder).
      try {
        const existing = bot.blockAt?.(target)
        if (existing && existing.name === step.name) { alreadyPresent++; placed++; continue }
      } catch { /* unloaded cell — fall through to place */ }
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
    return { ok: skipped.length === 0, placed, alreadyPresent, skipped, missing: [], towerUsed, stage: wanted }
  }
}


// ============================================================================
// Shape primitives — mathematical block-coordinate generators.
// The LLM NEVER places blocks one by one for large structures; it names a
// shape, we compute every coordinate locally. Voyager-style: code executes.
// ============================================================================

/**
 * Generate blocks of a geometric primitive.
 * @param {string} shape cylinder|dome|arch|wall|box|floor|ring
 * @param {object} p    shape params (see each branch)
 * @param {string} block block id (e.g. "stone") — all placed blocks share it
 * @returns {Array<{dx:number, dy:number, dz:number, name:string}>}
 */
function generateShape (shape, p = {}, block = 'stone') {
  if (!block || !/^[a-z0-9_]+$/.test(block)) throw new Error(`build_shape: bad block id "${block}"`)
  const B = []
  const push = (x, y, z) => B.push({ dx: x, dy: y, dz: z, name: block })
  const axis = (p.axis === 'z') ? 'z' : 'x'

  switch (String(shape)) {
    case 'cylinder': {
      const r = Math.max(1, Math.trunc(Number(p.r) || 3))
      const h = Math.max(1, Math.trunc(Number(p.h) || 6))
      const filled = Boolean(p.filled)
      const th = Math.max(1, Math.trunc(Number(p.th) || 1)) // shell thickness
      for (let y = 0; y < h; y++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const d2 = dx * dx + dz * dz
            if (d2 > r * r) continue
            if (!filled) {
              const inner = (r - th) > 0 ? (r - th) : 0
              if (inner > 0 && d2 < inner * inner) continue
            }
            push(dx, y, dz)
          }
        }
      }
      break
    }
    case 'dome': {
      const r = Math.max(2, Math.trunc(Number(p.r) || 5))
      const th = Math.max(1, Math.trunc(Number(p.th) || 1))
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const d = Math.hypot(dx, dz)
          if (d > r) continue
          const y = Math.round(Math.sqrt(Math.max(0, r * r - d * d)))
          push(dx, y, dz)
          for (let t = 1; t < th; t++) push(dx, Math.max(0, y - t), dz)
        }
      }
      break
    }
    case 'arch': {
      const w = Math.max(3, Math.trunc(Number(p.w) || 10))
      const h = Math.max(3, Math.trunc(Number(p.h) || 8))
      const th = Math.max(1, Math.trunc(Number(p.th) || 1))
      // Semicircle arc springing from y=S with apex exactly at h:
      //   r = w/2, cx = (w-1)/2, endOffset = sqrt(r^2 - cx^2), S = h - r + endOffset
      //   y(x) = S + sqrt(r^2 - (x-cx)^2) - endOffset   ->  y(0)=S, y(cx)=h
      // Columns fill [0..round(S)]; the arc closes the curve onto the columns.
      const r = w / 2
      const cx = (w - 1) / 2
      const endOffset = Math.sqrt(Math.max(0, r * r - cx * cx))
      const S = Math.max(0.5, h - r + endOffset)
      const colTop = Math.round(S)
      const seen = new Set()
      for (let t = 0; t < th; t++) {
        for (let dz = 0; dz < th; dz++) {
          for (let x = 0; x < w; x++) {
            const cells = []
            if (x < th && x === t) for (let y = 0; y <= colTop; y++) cells.push([x, y])
            if (x >= w - th && (x - (w - th)) === t) for (let y = 0; y <= colTop; y++) cells.push([x, y])
            const dy2 = r * r - (x - cx) * (x - cx)
            if (dy2 >= 0) cells.push([x, Math.round(S + Math.sqrt(dy2) - endOffset)])
            for (const [bx, by] of cells) {
              const key = `${bx},${by},${dz}`
              if (seen.has(key)) continue
              seen.add(key)
              push(bx, by, dz)
            }
          }
        }
      }
      break
    }
    case 'wall': {
      const l = Math.max(1, Math.trunc(Number(p.l) || 20))
      const h = Math.max(1, Math.trunc(Number(p.h) || 5))
      const th = Math.max(1, Math.trunc(Number(p.th) || 1))
      for (let t = 0; t < th; t++) {
        for (let i = 0; i < l; i++) {
          for (let y = 0; y < h; y++) {
            if (axis === 'x') push(i, y, t)
            else push(t, y, i)
          }
        }
      }
      break
    }
    case 'box': {
      const w = Math.max(1, Math.trunc(Number(p.w) || 6))
      const h = Math.max(1, Math.trunc(Number(p.h) || 4))
      const d = Math.max(1, Math.trunc(Number(p.d) || 6))
      const filled = Boolean(p.filled)
      const th = Math.max(1, Math.trunc(Number(p.th) || 1))
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          for (let z = 0; z < d; z++) {
            const onShell = x < th || x >= w - th || y < th || y >= h - th || z < th || z >= d - th
            if (!filled && !onShell) continue
            push(x, y, z)
          }
        }
      }
      break
    }
    case 'floor': {
      const w = Math.max(1, Math.trunc(Number(p.w) || 10))
      const d = Math.max(1, Math.trunc(Number(p.d) || 10))
      for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) push(x, 0, z)
      break
    }
    case 'ring': {
      const r = Math.max(2, Math.trunc(Number(p.r) || 6))
      const th = Math.max(1, Math.trunc(Number(p.th) || 1))
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const d2 = dx * dx + dz * dz
          const inner = Math.max(0, r - th)
          if (d2 <= r * r && d2 >= inner * inner) push(dx, 0, dz)
        }
      }
      break
    }
    default:
      throw new Error(`build_shape: unknown shape "${shape}" (cylinder|dome|arch|wall|box|floor|ring)`)
  }
  // bottom-to-top order (gravity-safe placement)
  B.sort((a, b) => a.dy - b.dy)
  return B
}

/**
 * Hierarchical stage label used in events/prompt.
 * Accepts the LLM's natural phase names as well as the canonical four:
 *   foundation | walls | walls_with_windows | roof | interior_details | detailing
 * Unknown labels return null (the caller then builds the whole plan).
 */
function normalizeStage (s) {
  const v = String(s || '').toLowerCase().trim().replace(/[\s-]+/g, '_')
  return PHASE_ALIASES[v] || null
}

module.exports = { BlueprintParser, BuilderExecutor, BLUEPRINT_DIR, generateShape, normalizeStage, decomposePhases, PHASE_ORDER, PHASE_ALIASES, isDetailingBlock }
