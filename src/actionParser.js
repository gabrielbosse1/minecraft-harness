/**
 * Strict action parser for the AMD LLM's single-line JSON output.
 *
 * Contract (mirrors the system prompt schema):
 *   {"a":"say","t":"brb"} {"a":"craft","i":"chest"} {"a":"equip","s":0}
 *   {"a":"attack","n":"zombie"} {"a":"move","x":10,"y":64,"z":10}
 *   {"a":"elytra"} {"a":"idle"}
 *
 * Rules:
 *   - Rejects markdown fences outright (the model is instructed not to emit them).
 *   - Tolerates surrounding prose by extracting the first balanced {...} block,
 *     but JSON must parse cleanly after extraction — no silent guessing.
 *   - Coerces numeric strings for numeric fields (models do this), but rejects
 *     anything that isn't finite and in range.
 *   - Rejects unknown action types and unknown top-level value types.
 *   - Returns a typed result union; never throws.
 */
'use strict'

const ITEM_NAME_RE = /^[a-z0-9_]{1,64}$/
const ENTITY_NAME_RE = /^[a-z0-9_ ]{1,48}$/

const WORLD_LIMIT = 30_000_000 // ±half the MC world border, in blocks
const Y_MIN = -64
const Y_MAX = 400

function fail (error) {
  return { ok: false, error }
}

function toFiniteNumber (v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Validate item ids like "oak_planks" (used by the craft action + recipe resolver). */
function isValidItemName (v) {
  return typeof v === 'string' && ITEM_NAME_RE.test(v)
}

const VALIDATORS = {
  say (o) {
    if (typeof o.t !== 'string' || !o.t.trim()) return fail('say: missing t')
    return { ok: true, action: { a: 'say', t: o.t.slice(0, 200) } }
  },
  craft (o) {
    if (!isValidItemName(o.i)) return fail('craft: bad item id')
    return { ok: true, action: { a: 'craft', i: o.i } }
  },
  equip (o) {
    const s = toFiniteNumber(o.s)
    if (s === null || !Number.isInteger(s) || s < 0 || s > 8) return fail('equip: s must be int 0..8')
    return { ok: true, action: { a: 'equip', s } }
  },
  attack (o) {
    if (typeof o.n !== 'string') return fail('attack: missing n')
    const n = o.n.trim().toLowerCase()
    if (n !== 'any' && !ENTITY_NAME_RE.test(n)) return fail('attack: bad entity name')
    return { ok: true, action: { a: 'attack', n } }
  },
  move (o) {
    const x = toFiniteNumber(o.x)
    const y = toFiniteNumber(o.y)
    const z = toFiniteNumber(o.z)
    if (x === null || y === null || z === null) return fail('move: x/y/z must be numbers')
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT || y < Y_MIN || y > Y_MAX) {
      return fail('move: out of world bounds')
    }
    return { ok: true, action: { a: 'move', x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) } }
  },
  elytra () {
    return { ok: true, action: { a: 'elytra' } }
  },
  idle () {
    return { ok: true, action: { a: 'idle' } }
  }
}

/**
 * Parse raw model output into a validated action.
 * @param {string} raw  raw content string from the AMD API
 * @returns {{ok:true, action:object} | {ok:false, error:string}}
 */
function parseAction (raw) {
  if (raw === null || raw === undefined) return fail('empty output')
  let text = String(raw).trim()
  if (!text) return fail('empty output')

  // The model was told: no fences. Treat them as an error signal, not noise.
  if (text.includes('```')) return fail('code_fence')
  // Arrays / concatenated objects are not the contract. Single object only.
  if (text.startsWith('[')) return fail('not_an_object')

  // Fast path: the whole line is JSON (what we actually want).
  let candidate = text
  if (!text.startsWith('{')) {
    // Slow path: extract from the first '{' to the last '}' and retry.
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return fail('no_json_object')
    candidate = text.slice(start, end + 1)
  }

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    return fail(`invalid_json:${String(err && err.message || err).slice(0, 60)}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('not_an_object')
  }
  if (typeof parsed.a !== 'string') return fail('missing a')
  const validator = VALIDATORS[parsed.a]
  if (!validator) return fail(`unknown_action:${parsed.a.slice(0, 16)}`)
  return validator(parsed)
}

module.exports = { parseAction, isValidItemName, VALIDATORS }
