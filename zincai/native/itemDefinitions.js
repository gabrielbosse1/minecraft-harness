/**
 * zincai/native/itemDefinitions.js — the client's item *model definition*
 * system (1.21.4+), plus legacy `overrides` predicates.
 *
 * Since 1.21.4 an item's appearance is described by
 * `assets/<namespace>/items/<id>.json` rather than the model file itself. That
 * file is a small expression tree:
 *
 *   minecraft:model            → a model + per-layer tints
 *   minecraft:special          → a code renderer (chest, bed, shulker, banner,
 *                                head, shield, conduit, trident, decorated pot)
 *                                around a base model for the display transform
 *   minecraft:range_dispatch   → pick a model by a numeric property
 *                                (compass angle, clock time, bow pull, damage…)
 *   minecraft:select           → pick a model by a categorical property
 *                                (display context, trim material, charge type,
 *                                 dimension, main hand, block state, local time)
 *   minecraft:condition        → boolean property (using_item, broken,
 *                                has_component, bundle/has_selected_item…)
 *   minecraft:composite        → several sub-models rendered together
 *   minecraft:empty            → nothing
 *   minecraft:bundle/selected_item → the bundle's selected stack
 *
 * Tints (`minecraft:constant`, `dye`, `grass`, `potion`, `map_color`,
 * `firework`) are resolved here too: spawn egg colours, potion colours, leather
 * dye, map colours and firework stars are data in 1.21.4, not hardcoded tables.
 *
 * The renderer never invents a property value: whatever the caller does not
 * supply falls back to the definition's own default (or the property's neutral
 * value), and unsupported property names are reported through `report()`.
 */
'use strict'

const { namespacePath } = require('./assets')

const MAX_DEPTH = 32
const WHITE = [255, 255, 255]

function mod (n, m) {
  return ((n % m) + m) % m
}

/** Packed 0xRRGGBB (or signed int from the JSON) → [r,g,b]. */
function rgbFromInt (value, fallback = WHITE) {
  if (value == null || !Number.isFinite(Number(value))) return fallback
  const n = Number(value) & 0xffffff
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function nameOf (ref) {
  return namespacePath(ref || '')
}

/**
 * Vanilla property values. Each reader receives the render state and returns
 * the property's value, or `undefined` when the state does not carry it (the
 * caller then falls back to the definition's default/fallback branch).
 */
const PROPERTIES = {
  'minecraft:time': (s) => {
    if (Number.isFinite(s.timeFraction)) return s.timeFraction
    if (!Number.isFinite(s.dayTime)) return undefined
    // ClockItemPropertyFunction: (dayTime + 6000) mod 24000 / 24000
    return mod(s.dayTime + 6000, 24000) / 24000
  },
  'minecraft:compass': (s) => {
    if (Number.isFinite(s.compassFraction)) return s.compassFraction
    if (!Number.isFinite(s.compassAngle)) return undefined
    // CompassItemPropertyFunction: atan2(dz, dx) / 2π, positive modulo 1.
    return mod(s.compassAngle / 360, 1)
  },
  'minecraft:crossbow/pull': (s) => (Number.isFinite(s.pull) ? s.pull : undefined),
  'minecraft:bow/pull': (s) => (Number.isFinite(s.pull) ? s.pull : undefined),
  'minecraft:use_duration': (s) => {
    if (Number.isFinite(s.useDuration)) return s.useDuration
    // Bow/crossbow models express the draw in ticks (scale 0.05). Callers that
    // only know the 0..1 pull still resolve to the right frame.
    if (Number.isFinite(s.pull)) return s.pull * 20
    return undefined
  },
  'minecraft:use_cycle': (s) => (Number.isFinite(s.useCycle) ? s.useCycle : undefined),
  'minecraft:damage': (s) => (Number.isFinite(s.damage) && Number.isFinite(s.maxDamage) && s.maxDamage > 0
    ? Math.min(1, Math.max(0, s.damage / s.maxDamage))
    : undefined),
  'minecraft:count': (s) => (Number.isFinite(s.count) ? s.count : undefined),
  'minecraft:custom_model_data': (s) => (Number.isFinite(s.customModelData) ? s.customModelData : undefined)
}

const CONDITIONS = {
  'minecraft:using_item': (s) => Boolean(s.usingItem),
  'minecraft:broken': (s) => {
    if (typeof s.broken === 'boolean') return s.broken
    return Number.isFinite(s.damage) && Number.isFinite(s.maxDamage) && s.maxDamage > 0 && s.damage >= s.maxDamage - 1
  },
  'minecraft:fishing_rod/cast': (s) => Boolean(s.fishing || s.cast),
  'minecraft:bundle/has_selected_item': (s) => Boolean(s.bundleSelectedItem),
  'minecraft:has_component': (s, node) => {
    const wanted = String(node.component || '').replace(/^minecraft:/, '')
    return Boolean(s.hasComponent?.(wanted))
  },
  'minecraft:extended_view': (s) => Boolean(s.extendedView)
}

function selectKey (value) {
  if (Array.isArray(value)) return value.map(selectKey)
  return String(value).replace(/^minecraft:/, '')
}

function matchLocalTime (when, state) {
  const days = (state.localDays || []).map(String)
  if (Array.isArray(when)) return when.some((w) => days.includes(String(w)))
  return days.includes(String(when))
}

/**
 * Resolve an item model definition tree to a concrete model.
 *
 * @param {object} definition  parsed `items/<id>.json` (`{ model: ... }`)
 * @param {object} state       render state (see module docs)
 * @param {object} [opts]
 * @param {Set} [opts.reported] collects unsupported property/type names
 * @param {number} [opts.depth]
 * @returns {{kind:'model'|'special'|'empty'|'composite', model?:string,
 *   tints?:Array, special?:object, models?:Array}}
 */
function evaluateModel (definition, state = {}, opts = {}) {
  const reported = opts.reported || new Set()
  const node = definition && (definition.model || definition)
  const resolve = (n, depth) => {
    if (!n || depth > MAX_DEPTH) return { kind: 'empty' }
    const type = String(n.type || (n.model ? 'minecraft:model' : 'minecraft:empty')).replace(/^minecraft:/, '')
    switch (type) {
      case 'model':
        return { kind: 'model', model: nameOf(n.model), tints: n.tints || null }
      case 'special':
        return { kind: 'special', model: nameOf(n.base || n.model), special: n.model && n.model.type ? n.model : null, tints: n.tints || null }
      case 'empty':
        return { kind: 'empty' }
      case 'composite':
        return { kind: 'composite', models: (n.models || []).map((m) => resolve(m, depth + 1)) }
      case 'range_dispatch': {
        const property = String(n.property || '')
        const reader = PROPERTIES[property]
        if (!reader) { reported.add(property || 'range_dispatch:unknown'); break }
        let value = reader(state)
        if (value === undefined) return resolve(n.fallback, depth + 1)
        const scale = Number.isFinite(n.scale) ? n.scale : 1
        const offset = Number.isFinite(n.offset) ? n.offset : 0
        value = value * scale + offset
        const entries = (n.entries || []).slice().sort((a, b) => (a.threshold || 0) - (b.threshold || 0))
        let chosen = null
        for (const entry of entries) {
          if (value >= (entry.threshold || 0)) chosen = entry
        }
        // `normalize` (damage) rebases the thresholds onto 0..1.
        if (n.normalize && Number.isFinite(state.maxDamage) && state.maxDamage > 0) {
          const norm = value * state.maxDamage
          chosen = null
          for (const entry of entries) if (norm >= (entry.threshold || 0)) chosen = entry
        }
        return resolve(chosen ? chosen.model : n.fallback, depth + 1)
      }
      case 'select': {
        const property = String(n.property || '')
        const cases = n.cases || []
        const value = selectValue(property, state, n, reported)
        if (value === undefined) return resolve(n.fallback, depth + 1)
        const wanted = Array.isArray(value) ? value.map(selectKey) : selectKey(value)
        for (const c of cases) {
          const when = selectKey(c.when)
          const hit = Array.isArray(wanted)
            ? (Array.isArray(when) ? when.some((w) => wanted.includes(w)) : wanted.includes(when))
            : (Array.isArray(when) ? when.includes(wanted) : when === wanted)
          if (hit) return resolve(c.model, depth + 1)
        }
        return resolve(n.fallback, depth + 1)
      }
      case 'condition': {
        const property = String(n.property || '')
        const reader = CONDITIONS[property]
        if (!reader) { reported.add(property || 'condition:unknown'); break }
        const result = reader(state, n)
        return resolve(result ? n.on_true : n.on_false, depth + 1)
      }
      case 'bundle/selected_item':
        return state.bundleSelectedItem
          ? { kind: 'model', model: nameOf(state.bundleSelectedItem.model || state.bundleSelectedItem), source: 'bundle' }
          : { kind: 'empty' }
      default:
        reported.add(`type:${type}`)
        return { kind: 'empty' }
    }
    return resolve(n.fallback, depth + 1)
  }
  return resolve(node, opts.depth || 0)
}

function selectValue (property, state, node, reported) {
  switch (String(property)) {
    case 'minecraft:display_context':
      return state.displayContext
    case 'minecraft:main_hand':
      return state.mainHand
    case 'minecraft:charge_type':
      return state.chargeType
    case 'minecraft:trim_material':
      return state.trimMaterial
    case 'minecraft:context_dimension':
      return state.dimension || 'minecraft:overworld'
    case 'minecraft:context_entity_type':
      return state.entityType
    case 'minecraft:local_time':
      return state.localDays || []
    case 'minecraft:block_state': {
      const prop = node.block_state_property
      if (!prop || !state.blockEntity) return undefined
      const props = state.blockEntity
      return props[prop]
    }
    case 'minecraft:component':
      return state.componentValue?.(String(node.component || '').replace(/^minecraft:/, ''))
    default:
      reported.add(`select:${property}`)
      return undefined
  }
}

/**
 * Resolve the tint colours for a resolved model.
 * Returns an array indexed by layer (`layer0`, `layer1`, …) or `tintindex`.
 */
function resolveTints (tintList, state = {}, reported = new Set()) {
  if (!Array.isArray(tintList) || !tintList.length) return []
  return tintList.map((tint) => {
    const type = String(tint?.type || '').replace(/^minecraft:/, '')
    switch (type) {
      case 'constant':
        return rgbFromInt(tint.value)
      case 'dye':
        return rgbFromInt(Number.isFinite(state.dyeColor) ? state.dyeColor : tint.default)
      case 'grass':
        if (Number.isFinite(state.grassColor)) return rgbFromInt(state.grassColor)
        return rgbFromInt(tint.default != null ? tint.default : 0x91bd59)
      case 'potion':
        return rgbFromInt(Number.isFinite(state.potionColor) ? state.potionColor : tint.default)
      case 'map_color':
        return rgbFromInt(Number.isFinite(state.mapColor) ? state.mapColor : tint.default)
      case 'firework':
        return rgbFromInt(Number.isFinite(state.fireworkColor) ? state.fireworkColor : tint.default)
      case 'custom_model_data':
        return rgbFromInt(Number.isFinite(state.customModelDataColor) ? state.customModelDataColor : tint.default)
      case 'team':
        return rgbFromInt(tint.default)
      default:
        reported.add(`tint:${type}`)
        return WHITE
    }
  })
}

/**
 * Legacy (pre-1.21.4) item models express variation with `overrides`:
 *   { predicate: { pulling: 1 }, model: 'item/bow_pulling_2' }
 * Predicate names map onto the same render state.
 */
function applyLegacyOverrides (rawModel, state = {}, reported = new Set()) {
  if (!rawModel || !Array.isArray(rawModel.overrides) || !rawModel.overrides.length) return rawModel
  let best = null
  let bestScore = -1
  for (const override of rawModel.overrides) {
    if (!override || !override.predicate) continue
    let score = 0
    let matches = true
    for (const [key, raw] of Object.entries(override.predicate)) {
      const wanted = Number(raw)
      const actual = legacyPredicateValue(key, state)
      if (actual === undefined) { matches = false; break }
      if (actual < wanted - 1e-9) { matches = false; break }
      score = Math.max(score, wanted)
    }
    if (matches && score >= bestScore) { best = override; bestScore = score }
  }
  return best ? { ...rawModel, model: best.model, overrides: null, _overrideModel: best.model } : rawModel
}

function legacyPredicateValue (key, state) {
  switch (key) {
    case 'damage': return Number.isFinite(state.damage) && Number.isFinite(state.maxDamage) && state.maxDamage > 0 ? state.damage / state.maxDamage : undefined
    case 'damaged': return state.damage > 0 ? 1 : 0
    case 'pulling': return Number.isFinite(state.pull) ? state.pull : undefined
    case 'pulling_hand': return state.pull
    case 'pull': return state.pull
    case 'charge': return state.pull
    case 'firework': return state.chargeType === 'firework' ? 1 : 0
    case 'angle': return Number.isFinite(state.compassAngle) ? state.compassAngle : undefined
    case 'time': return Number.isFinite(state.dayTime) ? state.dayTime : undefined
    case 'custom_model_data': return Number.isFinite(state.customModelData) ? state.customModelData : undefined
    case 'broken': return state.broken ? 1 : 0
    case 'throwing': return state.usingItem ? 1 : 0
    case 'cast': return state.fishing ? 1 : 0
    default:
      return undefined
  }
}


/**
 * Which live-world properties does this definition need but the state did not
 * supply? Used to report `needs world state` instead of "unsupported".
 */
function missingStateProperties (definition, state = {}) {
  const missing = new Set()
  const walk = (n, depth) => {
    if (!n || depth > MAX_DEPTH) return
    const type = String(n.type || (n.model ? 'minecraft:model' : 'minecraft:empty')).replace(/^minecraft:/, '')
    if (type === 'model' || type === 'special' || type === 'empty') return
    if (type === 'composite') { for (const m of n.models || []) walk(m, depth + 1); return }
    if (type === 'range_dispatch') {
      const property = String(n.property || '')
      const reader = PROPERTIES[property]
      if (!reader) missing.add(property || 'range_dispatch:unknown')
      else if (reader(state) === undefined) missing.add(property)
      walk(n.fallback, depth + 1)
      for (const e of n.entries || []) walk(e.model, depth + 1)
      return
    }
    if (type === 'select') {
      const property = String(n.property || '')
      if (selectValue(property, state, n, new Set()) === undefined) missing.add(property)
      walk(n.fallback, depth + 1)
      for (const c of n.cases || []) walk(c.model, depth + 1)
      return
    }
    if (type === 'condition') {
      const property = String(n.property || '')
      if (!CONDITIONS[property]) missing.add(property)
      walk(n.on_true, depth + 1)
      walk(n.on_false, depth + 1)
      return
    }
    walk(n.fallback, depth + 1)
  }
  walk(definition && (definition.model || definition), 0)
  return [...missing]
}

module.exports = {
  PROPERTIES,
  CONDITIONS,
  evaluateModel,
  missingStateProperties,
  resolveTints,
  applyLegacyOverrides,
  rgbFromInt,
  WHITE
}
