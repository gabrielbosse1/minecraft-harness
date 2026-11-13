/**
 * custom_mineflayer/doors.js — doors, fence gates and trapdoors judged by their
 * STATE, not by their block type.
 *
 * Upstream mineflayer-pathfinder decides from the block type alone. The result
 * (measured): every door is a wall whether it is open or
 * closed, an OPEN fence gate is a wall, and gates newer than dark oak are not
 * known at all. Its own "useOne" step also leaves the executor in a state that
 * needs a replan, and throws when scaffolding blocks are carried.
 *
 * So the harness owns the whole thing instead:
 *   - planning   (attachDoors): a door/gate cell is walkable along its passage
 *                when it is clear now, or when the walker can clear it by hand;
 *   - execution  (pathfinder_wrapper.js): the bot right-clicks what is in its
 *                way, remembers exactly what it touched, and puts it back.
 *
 * Geometry, from the block states (no collision-shape tables needed, so data
 * drift between versions cannot break it):
 *   door      a thin panel. `open=false`: across the `facing` axis. `open=true`:
 *             along it. Whichever axis has room on both sides is the passage,
 *             so a door someone mounted sideways ("open" when it reads closed)
 *             works too.
 *   gate      closed = a bar through the middle of the cell; open = nothing.
 *   trapdoor  closed = a floor (or a lid); open = an upright panel across its
 *             `facing` axis. Never operated: a hatch or a shutter is somebody's
 *             decoration far more often than it is the way through.
 * Iron doors and iron trapdoors need redstone; they are used when they happen
 * to be open and never clicked.
 */
'use strict'

const { Vec3 } = require('vec3')

/** @returns {'door'|'gate'|'trapdoor'|null} */
function kindOf (name) {
  if (typeof name !== 'string') return null
  if (name.endsWith('_fence_gate')) return 'gate'
  if (name.endsWith('_trapdoor')) return 'trapdoor'
  if (name.endsWith('_door')) return 'door'
  return null
}

/** Everything the state says about one door-like block, or null. */
function describe (block) {
  const kind = kindOf(block?.name)
  if (!kind) return null
  let props = {}
  try { props = (typeof block.getProperties === 'function' && block.getProperties()) || {} } catch { /* unknown state: treat as closed */ }
  const facing = String(props.facing || 'north')
  return {
    kind,
    name: block.name,
    open: props.open === true || props.open === 'true',
    facing,
    axis: (facing === 'east' || facing === 'west') ? 'x' : 'z',
    half: props.half != null ? String(props.half) : null,
    byHand: !block.name.startsWith('iron_')
  }
}

/** Would this state stop someone walking through its cell along `axis` ('x' | 'z')? */
function blocksWalk (d, axis) {
  if (d.kind === 'gate') return !d.open
  if (d.kind === 'door') return axis === d.axis ? !d.open : d.open
  return d.open ? axis === d.axis : true // trapdoor
}

const isDoorLike = (block) => kindOf(block?.name) !== null

/**
 * The axis a door serves: the one with room on both sides. A door in a wall
 * has exactly one; a door standing free (or boxed in) falls back to `facing`.
 */
function passageAxis (bot, pos, d) {
  if (d.kind !== 'door') return d.axis
  const room = (dx, dz) => {
    let b = null
    try { b = bot.blockAt(new Vec3(pos.x + dx, pos.y, pos.z + dz), false) } catch { return false }
    if (!b) return false
    if (b.boundingBox !== 'block' || isDoorLike(b)) return true
    // A porch stair or slab step right outside a door still grants passage when head space above it is clear.
    if (/_(stairs|slab)$/.test(String(b.name || ''))) {
      try {
        const head = bot.blockAt(new Vec3(pos.x + dx, pos.y + 1, pos.z + dz), false)
        return Boolean(head) && (head.boundingBox !== 'block' || isDoorLike(head))
      } catch { return false }
    }
    return false
  }
  const along = { x: () => room(1, 0) && room(-1, 0), z: () => room(0, 1) && room(0, -1) }
  if (along[d.axis]()) return d.axis
  const other = d.axis === 'x' ? 'z' : 'x'
  return along[other]() ? other : d.axis
}

/** One key per door (both halves) or gate. */
function keyOf (pos, d) {
  const y = d && d.kind === 'door' && d.half === 'upper' ? pos.y - 1 : pos.y
  return `${pos.x},${y},${pos.z}`
}

/**
 * Teach one Movements instance about door states.
 *
 * @param {object} movements a mineflayer-pathfinder Movements
 * @param {{ operate?: boolean, isJammed?: (key:string)=>boolean, stepCost?: number }} [opts]
 *   operate   true: the walker can right-click wooden doors and gates (the bot).
 *             false: it can only use what is open right now (a zombie).
 *   isJammed  doors that refused to open; routed around until they are forgotten.
 *   stepCost  extra cost for a cell that needs a click (a short detour wins).
 * @returns {boolean} attached
 */
function attachDoors (movements, { operate = true, isJammed = null, stepCost = 0 } = {}) {
  if (!movements || typeof movements.getBlock !== 'function') return false
  const settings = movements._zincaiDoors || (movements._zincaiDoors = {})
  Object.assign(settings, { operate: Boolean(operate), isJammed: typeof isJammed === 'function' ? isJammed : () => false, stepCost: Number(stepCost) || 0 })
  // Upstream's own handling is replaced, not extended.
  movements.canOpenDoors = false
  try { movements.openable?.clear?.() } catch { /* older upstream */ }
  if (settings.attached) return true
  settings.attached = true

  const bot = movements.bot
  const original = movements.getBlock
  movements.getBlock = function (pos, dx, dy, dz) {
    const b = original.call(this, pos, dx, dy, dz)
    const d = b && b.name && b.position ? describe(b) : null
    if (!d) return b
    b.openable = false
    // Which way is the walker crossing this cell? Cells below the walker are fallen
    // through, never walked through, so only the cells at body height have an axis.
    const diagonal = dx !== 0 && dz !== 0
    const axis = dy < 0 || diagonal ? null : (dx !== 0 ? 'x' : (dz !== 0 ? 'z' : null))

    if (d.kind === 'trapdoor') {
      b.physical = !d.open // shut: a floor or a lid. Open: a hole with a panel beside it.
      b.safe = d.open && !diagonal && (axis === null || !blocksWalk(d, axis))
      return b
    }
    b.physical = false // nobody stands on a door or a gate
    if (diagonal) { b.safe = false; return b } // no cutting corners through a doorway
    if (axis === null) { b.safe = d.kind === 'door' || d.open; return b } // the cell the walker is in / drops through
    let clear = false
    if (passageAxis(bot, b.position, d) === axis) {
      clear = !blocksWalk(d, axis)
      if (!clear && settings.operate && d.byHand && !settings.isJammed(keyOf(b.position, d))) clear = true
    }
    b.safe = clear
    return b
  }

  // A cell that needs a click costs a little, so a short way round is preferred.
  if (Array.isArray(movements.exclusionAreasStep)) {
    const fee = (block) => {
      if (!settings.stepCost || !settings.operate) return 0
      const d = block && block.name ? describe(block) : null
      if (!d || d.kind === 'trapdoor' || !d.byHand) return 0
      return blocksWalk(d, passageAxis(bot, block.position, d)) ? settings.stepCost : 0
    }
    fee._zincaiDoorCost = true
    movements.exclusionAreasStep.push(fee)
  }
  return true
}

module.exports = { kindOf, describe, blocksWalk, passageAxis, keyOf, isDoorLike, attachDoors }
