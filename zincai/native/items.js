/**
 * zincai/native/items.js — real Minecraft item rendering models.
 *
 * Items are not blocks: the client resolves an item's appearance through
 * `assets/<ns>/items/<id>.json` (the 1.21.4+ model definition) or, on older
 * versions, through `models/item/<id>.json` plus `overrides` predicates. The
 * leaves of that tree are:
 *
 *   - `item/generated` sprites, which have no JSON geometry at all: the client's
 *     `ItemModelGenerator` extrudes every opaque pixel run of the real 16x16
 *     sprite into a one-pixel-thick cuboid (that is what makes a diamond sword
 *     look like a sword and not a flat card). Multi-layer sprites (potions,
 *     leather armour, spawn eggs) stack, and each layer takes its own tint.
 *   - block models, for block items (`stone`, stairs, saplings, torches, ...).
 *   - special renderers (`minecraft:special` / `builtin/entity`): chests, beds,
 *     shulkers, banners, heads, shields, conduits, decorated pots.
 *
 * Everything is driven by the *state* of the stack: compass angle and clock
 * time, bow/crossbow pull, damage/broken, dye/potion colours, trim material,
 * custom model data, display context. Nothing is a static north/noon frame or a
 * hardcoded colour table unless the resource file itself says so.
 *
 * The public surface used by the renderer (`bake`, `quadsFor`, `displayFor`,
 * `itemNameOf`, `stats`) is unchanged from the PR #41 pipeline.
 */
'use strict'

const { namespacePath } = require('./assets')
const BUNDLED = require('./item-models-1.21.4.json')
const { evaluateModel, missingStateProperties, resolveTints, applyLegacyOverrides, WHITE } = require('./itemDefinitions')
const special = require('./specialModels')

const BUNDLED_VERSION = BUNDLED._meta?.version || '1.21.4'
const ALPHA_CUTOFF = 26
const THICKNESS = 1 / 16
const GLINT_TEXTURE = 'misc/enchanted_glint_item'

const DISPLAY_CONTEXTS = ['ground', 'thirdperson_righthand', 'thirdperson_lefthand', 'firstperson_righthand', 'firstperson_lefthand', 'gui', 'fixed', 'head']

function isBundleUsable (version) {
  if (!version) return true
  // Models are stable within a minor line; a different major/minor falls back
  // to whatever the resource pack itself provides.
  const a = String(version).split('.').slice(0, 2).join('.')
  const b = BUNDLED_VERSION.split('.').slice(0, 2).join('.')
  return a === b
}

function deg (d) { return (d * Math.PI) / 180 }

function rotatePoint (p, rotation) {
  let [x, y, z] = p
  const [rx, ry, rz] = rotation
  if (rz) {
    const c = Math.cos(deg(rz)); const s = Math.sin(deg(rz))
    const nx = x * c - y * s; const ny = x * s + y * c
    x = nx; y = ny
  }
  // Vanilla ItemTransform order: Y, then X, then Z (so Z is applied first
  // to the point, Y last).
  if (rx) {
    const c = Math.cos(deg(rx)); const s = Math.sin(deg(rx))
    const ny = y * c - z * s; const nz = y * s + z * c
    y = ny; z = nz
  }
  if (ry) {
    const c = Math.cos(deg(ry)); const s = Math.sin(deg(ry))
    const nx = x * c + z * s; const nz = -x * s + z * c
    x = nx; z = nz
  }
  return [x, y, z]
}

function applyTransform (p, transform) {
  const scale = transform?.scale || [1, 1, 1]
  const translation = transform?.translation || [0, 0, 0]
  const rotation = transform?.rotation || [0, 0, 0]
  let q = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]]
  q = rotatePoint(q, rotation)
  // Item transforms are authored in 1/16 block units.
  return [q[0] + translation[0] / 16, q[1] + translation[1] / 16, q[2] + translation[2] / 16]
}

/** Tint textures are cached by (texture, colour); `special.tintedTexture`. */
function tintQuads (quads, tints, kind) {
  if (!tints || !tints.length) return quads
  return quads.map((quad) => {
    let index = -1
    if (kind === 'generated') index = quad.tintLayer ?? -1
    else if (typeof quad.tintindex === 'number') index = quad.tintindex
    if (index < 0 || index >= tints.length) return quad
    const rgb = tints[index]
    if (!rgb || (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255)) return quad
    return { ...quad, tex: special.tintedTexture(quad.tex, rgb), tint: rgb, tintIndex: index }
  })
}

class ItemModelStore {
  constructor ({ version, assets, blockModels, registry } = {}) {
    this.version = version
    this.assets = assets
    this.blockModels = blockModels
    this.registry = registry
    this.bundle = isBundleUsable(version) ? BUNDLED.models : {}
    this.bundleVersion = BUNDLED_VERSION
    this._resolveCache = new Map()
    this._bakeCache = new Map()
    this._modelCache = new Map()
    this._definitionReported = new Set()
    this._glintTexture = null
    this.stats = {
      models: 0,
      generated: 0,
      blockItems: 0,
      specials: 0,
      definitions: 0,
      tints: 0,
      dynamic: new Set(),
      missingModels: new Set(),
      missingTextures: new Set(),
      unsupported: new Set(),
      unsupportedReasons: new Map(),
      needsState: new Set(),
      needsStateReasons: new Map(),
      specialKinds: new Set()
    }
  }

  itemNameOf (item) {
    if (!item) return null
    if (typeof item.name === 'string' && item.name) return item.name
    if (typeof item === 'string') return item
    const def = this.registry?.items?.[item.type]
    return def?.name || null
  }

  rawModel (name) {
    const clean = namespacePath(name).replace(/^item\//, '')
    const fromPack = this.assets?.itemModel(clean)
    if (fromPack) return fromPack
    return this.bundle[clean] || null
  }

  /** `assets/<ns>/items/<id>.json` (1.21.4+ model definition). */
  definition (name) {
    return this.assets?.itemDefinition?.(name) || null
  }

  /**
   * Resolve the real parent chain, merging textures/display/elements exactly
   * like the client's model loader. Returns null when nothing exists.
   */
  resolve (name, depth = 0) {
    if (!name || depth > 24) return null
    const clean = namespacePath(name).replace(/^item\//, '')
    if (this._resolveCache.has(clean)) return this._resolveCache.get(clean)
    const raw = this.rawModel(clean)
    if (!raw) { this._resolveCache.set(clean, null); return null }

    const out = {
      name: clean,
      textures: {},
      display: {},
      elements: null,
      gui_light: null,
      generated: false,
      special: false,
      blockParent: null,
      source: raw._source || 'bundled'
    }
    const parentRef = raw.parent ? namespacePath(raw.parent) : null
    if (parentRef) {
      if (parentRef === 'builtin/generated') {
        out.generated = true
      } else if (parentRef === 'builtin/entity') {
        out.special = true
      } else if (parentRef.startsWith('block/')) {
        out.blockParent = parentRef
      } else {
        const parent = this.resolve(parentRef.replace(/^item\//, ''), depth + 1)
        if (parent) {
          Object.assign(out.textures, parent.textures)
          Object.assign(out.display, parent.display)
          out.elements = parent.elements
          out.gui_light = parent.gui_light
          out.generated = out.generated || parent.generated
          out.special = out.special || parent.special
          out.blockParent = out.blockParent || parent.blockParent
        }
      }
    }
    if (raw.textures) Object.assign(out.textures, raw.textures)
    if (raw.display) Object.assign(out.display, raw.display)
    if (raw.elements) out.elements = raw.elements
    if (raw.gui_light) out.gui_light = raw.gui_light
    this._resolveCache.set(clean, out)
    return out
  }

  resolveTextureName (ref, textures, depth = 0) {
    if (ref == null) return null
    let s = String(ref)
    while (s.startsWith('#') && depth < 16) {
      const next = textures[s.slice(1)]
      if (next == null) return null
      s = String(next)
      depth++
    }
    return namespacePath(s)
  }

  textureFor (ref) {
    if (!ref) return null
    const tex = this.assets?.itemTexture(ref)
    if (!tex) {
      this.stats.missingTextures.add(ref)
      return null
    }
    return tex
  }

  /** Extrude one sprite layer into the client's generated-item cuboid. */
  _extrudeLayer (tex, layerName, layerIndex = 0) {
    const quads = []
    const solid = []
    for (let row = 0; row < 16; row++) {
      solid[row] = []
      for (let col = 0; col < 16; col++) {
        tex.sample((col + 0.5) / 16, (row + 0.5) / 16, 0, 0, _sample)
        solid[row][col] = _sample[3] >= ALPHA_CUTOFF
      }
    }
    const zf = THICKNESS / 2
    const zb = -THICKNESS / 2
    const layer = tex.hasSemiAlpha ? 'translucent' : 'cutout_mipped'
    const yFor = (row) => 1 - (row + 1) / 16
    const push = (pos, uv, normal) => {
      quads.push({ pos, uv, tex, normal, layer, texName: tex.name, itemLayer: layerName, tintLayer: layerIndex })
    }
    for (let row = 0; row < 16; row++) {
      let col = 0
      while (col < 16) {
        if (!solid[row][col]) { col++; continue }
        const start = col
        while (col < 16 && solid[row][col]) col++
        const end = col
        const x0 = start / 16 - 0.5
        const x1 = end / 16 - 0.5
        const y0 = yFor(row) - 0.5
        const y1 = yFor(row - 1) - 0.5
        const u0 = start / 16
        const u1 = end / 16
        const v0 = row / 16
        const v1 = (row + 1) / 16
        // Front (+Z) and back (-Z). Back UVs are mirrored so the sprite is not
        // horizontally flipped when viewed from behind.
        push([[x0, y0, zf], [x1, y0, zf], [x0, y1, zf], [x1, y1, zf]],
          [[u0, v1], [u1, v1], [u0, v0], [u1, v0]], [0, 0, 1])
        push([[x0, y0, zb], [x1, y0, zb], [x0, y1, zb], [x1, y1, zb]],
          [[u1, v1], [u0, v1], [u1, v0], [u0, v0]], [0, 0, -1])
        // Exposed sides: the one-pixel extrusion the client generates.
        if (!(row > 0 && solid[row - 1].slice(start, end).some(Boolean))) {
          push([[x0, y1, zb], [x1, y1, zb], [x0, y1, zf], [x1, y1, zf]],
            [[u0, v0], [u1, v0], [u0, v0], [u1, v0]], [0, 1, 0])
        }
        if (!(row < 15 && solid[row + 1].slice(start, end).some(Boolean))) {
          push([[x0, y0, zb], [x1, y0, zb], [x0, y0, zf], [x1, y0, zf]],
            [[u0, v1], [u1, v1], [u0, v1], [u1, v1]], [0, -1, 0])
        }
        if (!(start > 0 && solid[row][start - 1])) {
          push([[x0, y0, zb], [x0, y0, zf], [x0, y1, zb], [x0, y1, zf]],
            [[u0, v1], [u0, v1], [u0, v0], [u0, v0]], [-1, 0, 0])
        }
        if (!(end < 16 && solid[row][end])) {
          push([[x1, y0, zb], [x1, y0, zf], [x1, y1, zb], [x1, y1, zf]],
            [[u1, v1], [u1, v1], [u1, v0], [u1, v0]], [1, 0, 0])
        }
      }
    }
    return quads
  }

  _blockQuads (blockRef) {
    if (!this.blockModels) return null
    let baked = null
    if (blockRef) baked = this.blockModels.bake(blockRef)
    if (baked && baked.quads?.length) return baked
    return null
  }

  _blockItemQuads (name) {
    const reg = this.registry
    const def = reg?.blocksByName?.[name]
    if (def && def.defaultState != null && this.blockModels?.modelForState) {
      const baked = this.blockModels.modelForState(def.defaultState, 0, 0, 0)
      if (baked?.quads?.length) return { baked, ref: `block/${name}`, display: this._blockDisplay() }
    }
    const baked = this._blockQuads(`block/${name}`)
    if (baked) return { baked, ref: `block/${name}`, display: this._blockDisplay() }
    return null
  }

  _blockDisplay () {
    const block = this.assets?.model('block')
    return block?.display || null
  }

  /**
   * Bake a resolved model reference (`item/...` or `block/...`) into model
   * space quads. This is the shared leaf used by definitions, legacy models and
   * composite trees.
   */
  bakeModelRef (ref, { display = null, tints = null, kindHint = null } = {}) {
    if (!ref) return null
    const clean = namespacePath(ref)
    const cacheKey = `${clean}|${JSON.stringify(tints || null)}|${kindHint || ''}|${JSON.stringify(display || null)}`
    if (this._modelCache.has(cacheKey)) return this._modelCache.get(cacheKey)

    let out = null
    if (clean.startsWith('block/')) {
      const baked = this._blockQuads(clean)
      if (baked) {
        out = {
          name: clean,
          kind: 'block',
          quads: baked.quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0] - 0.5, p[1], p[2] - 0.5]) })),
          display: { ...this._blockDisplay(), ...(display || {}) },
          textures: baked.texturesUsed,
          source: 'block-model',
          blockRef: clean
        }
      }
    } else {
      const resolved = this.resolve(clean)
      if (resolved) {
        if (resolved.blockParent) {
          const baked = this._blockQuads(resolved.blockParent)
          if (baked) {
            out = {
              name: clean,
              kind: 'block',
              quads: baked.quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0] - 0.5, p[1], p[2] - 0.5]) })),
              display: { ...this._blockDisplay(), ...resolved.display, ...(display || {}) },
              textures: baked.texturesUsed,
              source: resolved.source,
              blockRef: resolved.blockParent
            }
          }
        }
        if (!out && !resolved.special && !resolved.elements) {
          const layers = Object.keys(resolved.textures)
            .filter((k) => /^layer\d+$/.test(k))
            .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
          const quads = []
          const textures = []
          for (let li = 0; li < layers.length; li++) {
            const key = layers[li]
            const texRef = this.resolveTextureName(resolved.textures[key], resolved.textures)
            if (!texRef) continue
            const tex = this.textureFor(texRef)
            if (!tex) continue
            quads.push(...this._extrudeLayer(tex, key, li))
            textures.push(tex)
          }
          if (quads.length) {
            out = {
              name: clean,
              kind: 'generated',
              quads,
              display: { ...resolved.display, ...(display || {}) },
              textures,
              source: resolved.source
            }
          }
        }
        if (!out && resolved.special) {
          // Legacy `builtin/entity` model without a 1.21.4 definition: use the
          // special renderer for the item name when one exists.
          out = this._legacySpecial(clean, resolved.display)
        }
      }
    }

    if (out && tints && tints.length) {
      out = { ...out, quads: tintQuads(out.quads, tints, out.kind), tints }
      this.stats.tints++
    }
    this._modelCache.set(cacheKey, out)
    return out
  }

  /** Legacy `builtin/entity` items: map the item id onto a special renderer. */
  _legacySpecial (name, display) {
    const base = name.replace(/^item\//, '').split('_').slice(0, -1).join('_')
    const d = display || {}
    let descriptor = null
    let context = {}
    if (name.includes('shield')) descriptor = { type: 'minecraft:shield' }
    else if (name.includes('bed')) descriptor = { type: 'minecraft:bed', texture: name.split('_')[0] }
    else if (name.includes('shulker_box')) descriptor = { type: 'minecraft:shulker_box', texture: name.includes('shulker_box') ? (name === 'shulker_box' ? 'shulker' : `shulker_${name.split('_')[0]}`) : 'shulker' }
    else if (name.includes('banner')) descriptor = { type: 'minecraft:banner', color: name.split('_')[0] }
    else if (/_head$|_skull$/.test(name)) descriptor = { type: 'minecraft:head', kind: name.includes('player') ? 'player' : name.split('_')[0] }
    else if (name === 'chest' || name === 'trapped_chest' || name === 'ender_chest') descriptor = { type: 'minecraft:chest', texture: name === 'ender_chest' ? 'ender' : 'normal' }
    else if (name === 'conduit') descriptor = { type: 'minecraft:conduit' }
    else if (name === 'decorated_pot') descriptor = { type: 'minecraft:decorated_pot' }
    void base
    if (!descriptor) return null
    const built = special.buildSpecial(descriptor, { assets: this.assets, context })
    if (!built) return null
    return {
      name,
      kind: 'special',
      specialKind: built.kind,
      quads: built.quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0], p[1] - 0.5, p[2]]) })),
      display: d,
      textures: built.textures,
      source: `special:${built.kind}`,
      provenance: built.provenance,
      notes: built.notes
    }
  }

  /** Definition-driven bake, with the full stack/world state. */
  bakeStack (item, opts = {}) {
    const name = this.itemNameOf(item)
    if (!name) return null
    const state = opts.state || {}
    const definition = this.definition(name)
    if (definition) {
      this.stats.definitions++
      return this._bakeFromDefinition(name, definition, state, opts)
    }
    // Legacy: `models/item/<id>.json` with optional `overrides` predicates.
    const clean = namespacePath(name).replace(/^item\//, '')
    const raw = this.rawModel(clean)
    if (raw && Array.isArray(raw.overrides) && raw.overrides.length) {
      const picked = applyLegacyOverrides(raw, state, this._definitionReported)
      const target = picked?._overrideModel ? namespacePath(picked._overrideModel) : null
      if (target) {
        this.stats.dynamic.add(`overrides:${name}`)
        const baked = this.bakeModelRef(target)
        if (baked) return { ...baked, name }
      }
    }
    const baked = this.bake(name)
    if (baked) return baked
    this.stats.unsupported.add(name)
    if (!this.stats.unsupportedReasons.has(name)) {
      this.stats.unsupportedReasons.set(name, `no drawable model in the loaded resources (${this.assets?.info?.version || this.version})`)
    }
    return null
  }

  _bakeFromDefinition (name, definition, state, opts) {
    const reported = this._definitionReported
    const resolved = evaluateModel(definition, state, { reported })
    const tints = resolved.tints ? resolveTints(resolved.tints, state, reported) : null
    if (resolved.kind === 'model') {
      const baked = this.bakeModelRef(resolved.model, { tints })
      if (baked) return { ...baked, name, modelName: baked.name, definition: true }
    } else if (resolved.kind === 'composite') {
      const parts = []
      let display = null
      for (const part of resolved.models || []) {
        let sub = null
        if (part.kind === 'model') sub = this.bakeModelRef(part.model, { tints: part.tints ? resolveTints(part.tints, state, reported) : null })
        else if (part.kind === 'special') sub = this._bakeSpecial(part, state, opts)
        if (!sub) continue
        display = display || sub.display
        parts.push(sub)
      }
      if (parts.length) {
        this.stats.specials += parts.filter((p) => p.kind === 'special').length
        return {
          name,
          modelName: parts[0].name,
          kind: parts.some((p) => p.kind !== 'generated') ? 'composite' : 'generated',
          quads: parts.flatMap((p) => p.quads),
          display: parts[0].display,
          textures: parts.flatMap((p) => p.textures || []),
          source: 'definition:composite',
          definition: true,
          notes: parts.flatMap((p) => p.notes || [])
        }
      }
    } else if (resolved.kind === 'special') {
      const baked = this._bakeSpecial(resolved, state, opts)
      if (baked) return { ...baked, name, definition: true }
    } else if (resolved.kind === 'empty') {
      // Compass/clock/... are state-selected: no geometry without live world
      // state is correct behaviour, not an unsupported item.
      const missing = missingStateProperties(this.definition(name), state)
      if (missing.length) {
        this.stats.needsState.add(name)
        this.stats.needsStateReasons.set(name, missing.join(', '))
      } else {
        this.stats.unsupported.add(name)
        if (!this.stats.unsupportedReasons.has(name)) {
          this.stats.unsupportedReasons.set(name, 'item definition resolves to minecraft:empty')
        }
      }
      return null
    }

    // Nothing drawable from the definition: report precisely why.
    const reason = resolved.kind === 'special'
      ? `special renderer ${resolved.special?.type || 'unknown'} is not implemented`
      : `item definition did not resolve to a drawable model (${resolved.kind})`
    this.stats.unsupported.add(name)
    this.stats.unsupportedReasons.set(name, reason)
    return null
  }

  _bakeSpecial (resolved, state, opts = {}) {
    const descriptor = resolved.special
    if (!descriptor) return null
    const type = String(descriptor.type || '').replace(/^minecraft:/, '')
    const base = this.resolve(resolved.model) || null
    const context = {
      patterns: state.bannerPatterns || null,
      banner: state.bannerColor != null
        ? { color: state.bannerColor, patterns: state.bannerPatterns || [] }
        : null,
      sherds: state.potSherds || null,
      texture: type === 'head' && state.headTexture ? state.headTexture : null
    }
    const built = special.buildSpecial(descriptor, { assets: this.assets, context })
    if (!built) {
      this.stats.unsupportedReasons.set(`${type}`, `special renderer ${type} needs a texture that is missing from the loaded resources`)
      return null
    }
    this.stats.specials++
    this.stats.specialKinds.add(built.kind)
    const display = base?.display || this._blockDisplay() || {}
    const quads = tintQuads(built.quads, resolved.tints ? resolveTints(resolved.tints, state, this._definitionReported) : null, 'special')
    // Block-style specials (chest, bed, shulker, banner, skull, conduit, pot,
    // sign) are authored from the block floor, so move them to item space.
    // Hand-authored specials (shield, trident) are already centred.
    const itemQuads = built.anchor === 'center'
      ? quads
      : quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0], p[1] - 0.5, p[2]]) }))
    return {
      name: resolved.model || type,
      kind: 'special',
      specialKind: built.kind,
      quads: withGlint(itemQuads, state, this),
      display,
      textures: built.textures,
      source: `special:${built.kind}`,
      provenance: built.provenance,
      notes: built.notes
    }
  }

  /**
   * Bake an item name into model-space quads (no stack state). Kept for API
   * compatibility: compasses/clocks use their first frame here, the state-aware
   * path is `bakeStack`.
   */
  bake (name) {
    const clean = namespacePath(name)
    if (!clean || clean === 'air') return null
    if (this._bakeCache.has(clean)) return this._bakeCache.get(clean)
    const definition = this.definition(clean)
    let out = null
    if (definition) {
      out = this._bakeFromDefinition(clean, definition, {})
    } else {
      const resolved = this.resolve(clean)
      if (resolved?.blockParent) out = this.bakeModelRef(resolved.blockParent, { display: resolved.display })
      if (!out && resolved) out = this.bakeModelRef(clean)
      if (!out && !resolved) {
        const block = this._blockItemQuads(clean)
        if (block) {
          out = {
            name: clean,
            kind: 'block',
            quads: block.baked.quads.map((q) => ({ ...q, pos: q.pos.map((p) => [p[0] - 0.5, p[1], p[2] - 0.5]) })),
            display: block.display,
            textures: block.baked.texturesUsed,
            source: 'block-model',
            blockRef: block.ref
          }
        }
      }
      if (!out && resolved?.special) out = this._legacySpecial(clean, resolved.display)
      if (!out && resolved && !resolved.elements && !resolved.special) {
        this.stats.unsupported.add(clean)
        if (!this.stats.unsupportedReasons.has(clean)) {
          this.stats.unsupportedReasons.set(clean, 'item model resolves to no geometry (no generated sprite layers and no special renderer)')
        }
      }
    }

    if (out) {
      this.stats.models++
      if (out.kind === 'generated') this.stats.generated++
      else if (out.kind === 'block') this.stats.blockItems++
      else if (out.kind === 'special') this.stats.specials++
    } else if (!definition) {
      this.stats.missingModels.add(clean)
    }
    this._bakeCache.set(clean, out)
    return out
  }

  /** Real display transform for a context (`ground`, `thirdperson_righthand`). */
  displayFor (baked, context) {
    if (!baked) return null
    if (baked.display?.[context]) return baked.display[context]
    return null
  }

  /**
   * Item quads with the model's real display transform applied, still in
   * model space (centred on the origin). `context` is a vanilla display slot.
   */
  quadsFor (name, context = 'ground') {
    const baked = this.bake(name)
    if (!baked) return null
    return {
      ...baked,
      quads: applyDisplayToQuads(baked.quads, this.displayFor(baked, context))
    }
  }

  /** State-aware variant of `quadsFor` used by the renderer. */
  quadsForStack (item, context = 'ground', state = {}) {
    const baked = this.bakeStack(item, { state: { ...state, displayContext: context } })
    if (!baked) return null
    const glinted = withGlint(baked.quads, { ...state, enchanted: state.enchanted ?? isEnchanted(item) }, this)
    const transform = this.displayFor(baked, context)
    return {
      ...baked,
      quads: applyDisplayToQuads(glinted, transform),
      displayTransform: transform || null
    }
  }

  /** Glint sheet (never required: absence just means no shimmer). */
  glintTexture () {
    if (this._glintTexture !== null) return this._glintTexture
    this._glintTexture = this.assets?.miscTexture?.(GLINT_TEXTURE) || false
    return this._glintTexture
  }

  /** Human-readable coverage for logs/tests. */
  coverage () {
    return {
      models: this.stats.models,
      generated: this.stats.generated,
      blockItems: this.stats.blockItems,
      specials: this.stats.specials,
      definitions: this.stats.definitions,
      specialKinds: [...this.stats.specialKinds].sort(),
      dynamic: [...this.stats.dynamic].sort(),
      unsupported: [...this.stats.unsupported].sort(),
      unsupportedReasons: Object.fromEntries(this.stats.unsupportedReasons),
      needsState: [...this.stats.needsState].sort(),
      needsStateReasons: Object.fromEntries(this.stats.needsStateReasons),
      missingModels: [...this.stats.missingModels].sort(),
      missingTextures: [...this.stats.missingTextures].sort(),
      unresolvedDefinitionProperties: [...this._definitionReported].sort()
    }
  }
}

/** Does this stack carry enchantments (glint)? */
function isEnchanted (item) {
  if (!item) return false
  try {
    if (Array.isArray(item.enchants) && item.enchants.length) return true
    if (item.componentMap?.has?.('enchantments')) {
      const data = item.componentMap.get('enchantments').data
      return Array.isArray(data) ? data.length > 0 : Boolean(data)
    }
    if (Array.isArray(item.components)) {
      return item.components.some((c) => c?.type === 'enchantments' || c?.type === 'minecraft:enchantments' || c?.type === 'stored_enchantments')
    }
    if (item.nbt?.value?.Enchantments) return Array.isArray(item.nbt.value.Enchantments.value) && item.nbt.value.Enchantments.value.length > 0
  } catch { /* unrecognised item shape */ }
  return false
}

/**
 * Vanilla's enchantment glint: a scrolling `misc/enchanted_glint_item` sheet
 * multiplied over the item surface. The client does this in a shader; here it
 * is an additive overlay quad per face, offset along the face normal.
 */
function withGlint (quads, state, store) {
  if (!state?.enchanted) return quads
  const tex = store.glintTexture?.()
  if (!tex) return quads
  const out = quads.slice()
  for (const q of quads) {
    out.push({
      ...q,
      pos: q.pos.map((p) => [p[0] + q.normal[0] * 0.0008, p[1] + q.normal[1] * 0.0008, p[2] + q.normal[2] * 0.0008]),
      uv: [[0, 1], [1, 1], [0, 0], [1, 0]],
      layer: 'glint',
      tex,
      texName: tex.name,
      glint: true,
      shade: false,
      tintindex: -1
    })
  }
  return out
}

function applyDisplayToQuads (quads, transform) {
  if (!transform) return quads.map((q) => ({ ...q, pos: q.pos.map((p) => p.slice()) }))
  return quads.map((q) => ({
    ...q,
    pos: q.pos.map((p) => applyTransform(p, transform))
  }))
}

const _sample = [0, 0, 0, 0]

module.exports = {
  ItemModelStore,
  applyTransform,
  applyDisplayToQuads,
  rotatePoint,
  isEnchanted,
  tintQuads,
  withGlint,
  BUNDLED_VERSION,
  DISPLAY_CONTEXTS,
  ALPHA_CUTOFF,
  WHITE
}
