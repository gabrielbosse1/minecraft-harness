'use strict'

/**
 * `node scripts/asset-coverage.js [version]`
 *
 * Audits the *loaded* client resources (the same asset layer the renderer
 * uses) and prints what can be drawn, what needs live world state and what is
 * genuinely unsupported — with a reason for every gap. Nothing is inferred from
 * file names alone: every item model is baked and every entity texture is
 * looked up through `zincai/native/assets.js`.
 */

const minecraftData = require('minecraft-data')
const { createAssetProvider } = require('../zincai/native/assets')
const { BlockModelStore } = require('../zincai/native/blockModels')
const { loadEntityDefinitions, buildEntityModel } = require('../zincai/native/entityModels')
const { entityAppearance, metaValue, modelKeyFor } = require('../zincai/native/entityAppearance')
const { ItemModelStore } = require('../zincai/native/items')

function main () {
  const version = process.argv[2] || process.env.ZINC_MC_VERSION || '1.21.4'
  const mc = minecraftData(version)
  const assets = createAssetProvider({ version })
  const worldBot = { registry: mc, version, blockAt: () => null, world: { columns: new Map() } }
  const blocks = new BlockModelStore(worldBot, assets)
  const items = new ItemModelStore({ version, assets, blockModels: blocks, registry: mc })
  const definitions = loadEntityDefinitions()

  console.log(`assets: ${assets.label} [${assets.info.sources.join('; ')}]`)
  console.log(`version: ${version}${assets.info.versionNote ? ` (${assets.info.versionNote})` : ''}`)

  // ── Items ────────────────────────────────────────────────────────────────
  const itemNames = Object.keys(mc.itemsByName)
  const stats = { generated: 0, block: 0, special: 0, composite: 0, needsState: [], unsupported: [], missingTextures: new Set() }
  const specialKinds = new Set()
  for (const name of itemNames) {
    // Items whose definition is display-context dependent (e.g. spyglass) are
    // baked in the GUI context, which is the one an inventory/report needs.
    let baked = items.bake(name)
    if (!baked) {
      const stack = { name, count: 1 }
      baked = items.quadsForStack(stack, 'gui', { displayContext: 'gui' })
    }
    if (baked) {
      if (baked.kind === 'generated') stats.generated++
      else if (baked.kind === 'block') stats.block++
      else if (baked.kind === 'special') { stats.special++; specialKinds.add(baked.specialKind) } else stats.composite++
      for (const texture of baked.textures || []) if (!texture || texture.missing) stats.missingTextures.add(name)
      continue
    }
    if (items.stats.needsState.has(name)) stats.needsState.push(`${name} (${items.stats.needsStateReasons.get(name)})`)
    else if (items.stats.unsupported.has(name)) stats.unsupported.push(`${name} (${items.stats.unsupportedReasons.get(name) || 'unknown'})`)
    else stats.unsupported.push(`${name} (no model resolved)`)
  }
  const drawable = stats.generated + stats.block + stats.special + stats.composite
  console.log(`\nitems: ${drawable}/${itemNames.length} drawable (${stats.generated} generated, ${stats.block} block items, ${stats.special} special, ${stats.composite} composite)`)
  if (specialKinds.size) console.log(`  special renderers: ${[...specialKinds].sort().join(', ')}`)
  if (stats.needsState.length) console.log(`  needs live world state: ${stats.needsState.join(', ')}`)
  if (stats.unsupported.length) {
    const byReason = new Map()
    for (const entry of stats.unsupported) {
      const reason = entry.slice(entry.indexOf('(') + 1, -1)
      if (!byReason.has(reason)) byReason.set(reason, [])
      byReason.get(reason).push(entry.slice(0, entry.indexOf(' (')))
    }
    for (const [reason, names] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  unsupported (${names.length}) — ${reason}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` … +${names.length - 8}` : ''}`)
    }
  }

  // ── Blocks ───────────────────────────────────────────────────────────────
  let states = 0
  let drawableStates = 0
  let specialStates = 0
  const missingTextures = new Set()
  const SPECIAL_ONLY = ['chest', 'ender_chest', 'trapped_chest', 'shulker_box', 'bed', 'banner', 'wall_banner', 'conduit', 'decorated_pot', 'head', 'player_head', 'zombie_head', 'skeleton_skull', 'wither_skeleton_skull', 'creeper_head', 'dragon_head', 'piglin_head', 'sign', 'hanging_sign', 'skull']
  for (const block of Object.values(mc.blocksByName)) {
    const first = block.minStateId
    const last = block.maxStateId
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue
    for (let stateId = first; stateId <= last; stateId++) {
      states++
      const model = blocks.modelForState(stateId, 0, 0, 0)
      if (!model) { missingTextures.add(block.name); continue }
      if (model.quads.length) drawableStates++
      else if (model.special) specialStates++

    }
  }
  console.log(`\nblocks: ${drawableStates}/${states} block states drawable (${specialStates} are client special renderers)`)
  const missingBlockTextures = blocks.stats?.missingTextures ? [...blocks.stats.missingTextures] : []
  if (missingBlockTextures.length) console.log(`  missing block textures: ${missingBlockTextures.slice(0, 12).join(', ')}${missingBlockTextures.length > 12 ? ` … +${missingBlockTextures.length - 12}` : ''}`)

  // ── Entities ─────────────────────────────────────────────────────────────
  const entityNames = Object.keys(mc.entitiesByName)
  const entity = { drawable: [], needsTexture: [], noGeometry: [], noModel: [] }
  // Types drawn by dedicated paths in the renderer rather than the entity catalogue.
  const OTHER_PATH = new Set(['player', 'item', 'item_frame', 'glow_item_frame', 'painting', 'tnt', 'falling_block',
    'marker', 'interaction', 'area_effect_cloud', 'lightning_bolt', 'ominous_item_spawner', 'text_display', 'item_display', 'block_display'])
  for (const name of entityNames) {
    if (OTHER_PATH.has(name)) continue
    const key = modelKeyFor(name)
    const geometry = buildEntityModel(key)
    if (name === 'player') { entity.drawable.push(name); continue }
    const appearance = entityAppearance({ name, metadata: {} }, { registry: mc, definitions })
    const texture = (appearance.textureCandidates || []).some((ref) => assets.entityTexture(ref))
    if (geometry && texture) entity.drawable.push(name)
    else if (geometry && !texture) entity.needsTexture.push(name)
    else if (!geometry) entity.noGeometry.push(name)
    else entity.noModel.push(name)
  }
  console.log(`\nentities: ${entity.drawable.length}/${entityNames.length} with real geometry + texture`)
  if (entity.noGeometry.length) console.log(`  no client geometry in these resources: ${entity.noGeometry.join(', ')}`)
  if (entity.needsTexture.length) console.log(`  geometry but no texture: ${entity.needsTexture.join(', ')}`)

  // ── Vanilla particle/special-only entities ───────────────────────────────
  const nonVisual = ['marker', 'interaction', 'area_effect_cloud', 'lightning_bolt', 'ominous_item_spawner', 'text_display', 'item_display', 'block_display']
  console.log(`  no client model by design: ${nonVisual.filter((n) => entityNames.includes(n)).join(', ')}`)

  // Metadata-key sanity for the mobs whose look depends on synced state.
  const variantMobs = ['sheep', 'cat', 'wolf', 'fox', 'mooshroom', 'horse', 'llama', 'villager', 'shulker', 'axolotl', 'parrot', 'rabbit', 'panda', 'slime']
  const variantKeys = variantMobs
    .map((name) => `${name}: ${(mc.entitiesByName[name]?.metadataKeys || []).filter(Boolean).slice(16).join(',')}`)
  console.log(`\nvariant metadata keys:\n  ${variantKeys.join('\n  ')}`)
  console.log(`\nmetadata helper available for tests: ${typeof metaValue === 'function'}`)
}

main()
