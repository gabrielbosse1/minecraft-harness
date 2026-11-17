'use strict'

/**
 * Entity appearance resolution.
 *
 * The client decides an entity's texture, model variant, tint, extra render
 * layers and scale from *synced metadata*, not from the entity type alone.
 * This module reads the real metadata keys
 * (`bot.registry.entitiesByName[name].metadataKeys`) and resolves the same
 * choices the vanilla renderers make, using the vanilla texture paths that the
 * loaded resources actually contain.
 *
 * Nothing here invents textures: when a variant texture is absent the caller
 * gets `textureRef: null` (or a note) so the renderer can report it.
 */

const { DYE_COLORS } = require('./specialModels')

// minecraft-data maps metadata names → protocol index; mineflayer stores
// `entity.metadata` keyed by that same index.
function metadataKeysFor (registry, name) {
  try {
    return registry?.entitiesByName?.[name]?.metadataKeys || null
  } catch {
    return null
  }
}

/**
 * Read a synced metadata value by its registry key name.
 *
 * Accepts the three shapes seen in the wild: mineflayer's index-keyed object,
 * an index-keyed array, and `{ key, value }` entry arrays (protocol capture /
 * test doubles).
 */
function metaValue (entity, registry, key, fallback = undefined) {
  if (!entity) return fallback
  const metadata = entity.metadata
  if (metadata == null) return fallback
  if (typeof metadata === 'object' && !Array.isArray(metadata) && metadata[key] !== undefined) return metadata[key]
  const keys = metadataKeysFor(registry, entity.name)
  if (!keys) return fallback
  const index = keys.indexOf(key)
  if (index < 0) return fallback
  if (Array.isArray(metadata)) {
    // Protocol captures and test doubles use `{ key, value }` entries; the
    // array itself is not index-aligned in that case.
    const entry = metadata.find((m) => m && typeof m === 'object' && 'key' in m && Number(m.key) === index)
    if (entry) return entry.value
    const probe = metadata[index]
    if (probe === undefined) return fallback
    if (probe && typeof probe === 'object' && 'value' in probe) return probe.value
    return probe
  }
  if (typeof metadata === 'object' && metadata[index] !== undefined) return metadata[index]
  return fallback
}

function isBaby (entity, registry) {
  if (!entity) return false
  if (entity.isBaby === true || entity.baby === true) return true
  if (entity.type === 'player') return false
  const flag = metaValue(entity, registry, 'baby')
  if (typeof flag === 'boolean') return flag
  if (typeof flag === 'number') return flag !== 0
  return false
}

// Vanilla registry orders (1.21.4). These are the indices carried in metadata.
const CAT_VARIANTS = ['tabby', 'black', 'red', 'siamese', 'british', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black']
const WOLF_VARIANTS = ['pale', 'snowy', 'ashen', 'black', 'chestnut', 'rusty', 'spotted', 'striped', 'woods']
const AXOLOTL_VARIANTS = ['lucy', 'wild', 'gold', 'cyan', 'blue']
const PARROT_VARIANTS = ['red_blue', 'blue', 'green', 'yellow_blue', 'grey']
const RABBIT_VARIANTS = ['brown', 'white', 'black', 'white_splotched', 'gold', 'salt', 'toast']
// coat id → vanilla horse coat name (texture `entity/horse/horse_<name>`)
const HORSE_COATS = ['white', 'creamy', 'chestnut', 'brown', 'black', 'gray', 'darkbrown']
const HORSE_MARKINGS = ['none', 'white', 'whitefield', 'whitedots', 'blackdots']
const MOOSHROOM_VARIANTS = ['red', 'brown']
const FOX_VARIANTS = ['red', 'snow']
const SHEEP_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'silver', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const LLAMA_VARIANTS = ['creamy', 'white', 'brown', 'gray']
const PANDA_GENES = ['normal', 'lazy', 'worried', 'playful', 'brown', 'weak', 'aggressive']
const VILLAGER_TYPES = ['desert', 'jungle', 'plains', 'savanna', 'snow', 'swamp', 'taiga']
const VILLAGER_PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher',
  'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']

const BOAT_WOODS = ['acacia', 'birch', 'dark_oak', 'jungle', 'mangrove', 'oak', 'pale_oak', 'spruce', 'bamboo']
const MINECART_KINDS = ['minecart', 'chest_minecart', 'furnace_minecart', 'hopper_minecart', 'spawner_minecart', 'tnt_minecart', 'command_block_minecart']

/** Entity type → the model catalogue key that draws it. */
function modelKeyFor (name) {
  const clean = String(name || '').toLowerCase().replace(/^minecraft:/, '')
  if (clean === 'giant') return 'zombie'
  if (clean === 'illusioner') return 'evoker'
  if (clean === 'trader_llama') return 'llama'
  if (clean === 'spectral_arrow') return 'arrow'
  if (clean === 'tropical_fish') return 'tropical_fish'
  if (MINECART_KINDS.includes(clean)) return 'minecart'
  if (/_chest_boat$/.test(clean)) return 'boat'
  if (/_raft$/.test(clean)) return 'boat'
  if (/_boat$/.test(clean)) return 'boat'
  return clean
}

function woodOf (name) {
  const clean = String(name || '').toLowerCase()
  const match = /^(acacia|birch|cherry|dark_oak|jungle|mangrove|oak|pale_oak|spruce|bamboo)_/.exec(clean)
  return match ? match[1] : null
}

/**
 * Resolve an entity's appearance.
 *
 * @param {object} entity mineflayer entity (or a test double with metadata)
 * @param {object} opts `{ registry, definitions }`
 * @returns {{modelKey:string, textureRef:string|null, tint:number[]|null,
 *   extraLayers:Array<{textureRef:string,tint:number[]|null,bones:string[]|null,note?:string}>,
 *   geometryVariant:string|null, baby:boolean, scale:number, variant:string|null,
 *   notes:string[]}}
 */
function entityAppearance (entity, opts = {}) {
  const { registry, definitions = {} } = opts
  const name = String(entity?.name || entity?.type || '').toLowerCase().replace(/^minecraft:/, '')
  const modelKey = modelKeyFor(name)
  const entry = definitions[modelKey] || definitions[name] || {}
  const textures = entry.textures || {}
  const pick = (...keys) => {
    for (const key of keys) if (key && textures[key]) return textures[key]
    return null
  }

  const out = {
    modelKey,
    textureRef: null,
    // Ordered alternatives so the renderer can pick the first sheet the loaded
    // resources actually contain (vanilla path first, catalogue second).
    textureCandidates: [],
    tint: null,
    extraLayers: [],
    geometryVariant: null,
    baby: false,
    scale: 1,
    variant: null,
    notes: []
  }

  // DYE_COLORS is keyed by vanilla dye name; metadata carries the colour index.
  const dye = (index) => {
    const name = SHEEP_COLORS[index]
    if (!name) return null
    const key = name === 'silver' ? 'light_gray' : name
    return DYE_COLORS[key] || null
  }
  const num = (key, fallback = 0) => {
    const value = Number(metaValue(entity, registry, key))
    return Number.isFinite(value) ? value : fallback
  }
  const layer = (textureRef, extra = {}) => {
    if (!textureRef) return
    const candidates = (extra.candidates || [textureRef]).filter(Boolean)
    out.extraLayers.push({ textureRef, textureCandidates: candidates, tint: extra.tint ?? null, bones: extra.bones ?? null, note: extra.note })
  }
  const setTexture = (candidates, variant) => {
    const list = candidates.filter(Boolean)
    out.textureCandidates = list
    out.textureRef = list[0] || null
    if (variant !== undefined) out.variant = variant
  }

  if (name === 'sheep') {
    const wool = num('wool', 0)
    const colorIndex = wool & 0x0f
    const sheared = (wool & 0x10) !== 0
    const color = SHEEP_COLORS[colorIndex] || 'white'
    if (sheared) {
      setTexture([pick('sheared'), 'entity/sheep/sheep'], 'sheared')
    } else {
      // Vanilla draws `sheep.png` (face/legs) plus a dyed `sheep_fur.png`
      // layer over body + head. The dye is the wool colour, read from metadata.
      setTexture(['entity/sheep/sheep', pick('default')], color)
      out.tint = dye(colorIndex)
      layer('entity/sheep/sheep_fur', { tint: out.tint, bones: ['head', 'body'], candidates: [pick('wool'), 'entity/sheep/sheep_fur'] })
    }
  } else if (name === 'cat') {
    const variant = num('variant', 0)
    const flags = num('flags', 0)
    const tamed = (flags & 0x04) !== 0
    const key = CAT_VARIANTS[variant] || 'tabby'
    setTexture([`entity/cat/${key}`, pick(key), 'entity/cat/tabby'], `${key}${tamed ? '/tame' : ''}`)
    if (tamed) {
      const collar = num('collar_color', -1)
      if (collar >= 0 && dye(collar)) layer('entity/cat/cat_collar', { tint: dye(collar), bones: ['head', 'body'] })
    }
    if (!textures[key]) out.notes.push(`cat variant ${key} has no texture in the catalogue`)
  } else if (name === 'wolf') {
    const variant = num('variant', 0)
    const flags = num('flags', 0)
    const tamed = (flags & 0x04) !== 0
    const angry = (flags & 0x02) !== 0
    const coat = WOLF_VARIANTS[variant] || 'pale'
    const base = coat === 'pale' ? 'entity/wolf/wolf' : `entity/wolf/wolf_${coat}`
    const suffix = angry ? '_angry' : tamed ? '_tame' : ''
    setTexture([`${base}${suffix}`, `${base}_tame`, base, pick('default')], `${coat}${suffix}`)
    if (tamed) {
      const collar = num('collar_color', -1)
      if (collar >= 0 && dye(collar)) layer('entity/wolf/wolf_collar', { tint: dye(collar), bones: ['head', 'body'] })
    }
  } else if (name === 'fox') {
    const type = num('type', 0)
    const snow = type === 1 || FOX_VARIANTS[type] === 'snow'
    setTexture([pick(snow ? 'arctic' : 'red'), 'entity/fox/snow_fox', 'entity/fox/fox'])
    out.variant = snow ? 'snow' : 'red'
  } else if (name === 'mooshroom') {
    const type = num('type', 0)
    const brown = type === 1 || MOOSHROOM_VARIANTS[type] === 'brown'
    setTexture([`entity/cow/${brown ? 'brown' : 'red'}_mooshroom`, pick(brown ? 'brown' : 'default')], brown ? 'brown' : 'red')
  } else if (name === 'horse' || name === 'skeleton_horse' || name === 'zombie_horse') {
    const packed = num('type_variant', 0)
    const coat = HORSE_COATS[packed & 0xff] || 'brown'
    const markings = HORSE_MARKINGS[(packed >> 8) & 0xff] || 'none'
    if (name === 'horse') {
      setTexture([`entity/horse/horse_${coat}`, pick(`base_${coat}`), pick('base_brown')], `base_${coat}`)
      if (markings !== 'none') {
        const key = `markings_${markings}`
        layer(pick(key) || `entity/horse/horse_markings_${markings}`, { bones: ['Body', 'Neck', 'Head'], candidates: [`entity/horse/horse_markings_${markings}`, pick(key)] })
      }
    } else {
      setTexture([pick(name), `entity/horse/horse_${name === 'skeleton_horse' ? 'skeleton' : 'zombie'}`])
      out.variant = name
    }
  } else if (name === 'donkey' || name === 'mule' || name === 'llama' || name === 'trader_llama') {
    if (name === 'llama' || name === 'trader_llama') {
      const variant = num('variant', 0)
      const key = LLAMA_VARIANTS[variant] || 'creamy'
      setTexture([`entity/llama/${key}`, pick(key), pick('creamy')], key)
      const decor = num('chest', -1)
      if (decor) out.notes.push('llama carpet layer is not composited')
    } else {
      setTexture([pick(name), pick('default'), `entity/horse/${name}`])
      out.variant = name
    }
  } else if (name === 'villager' || name === 'zombie_villager' || name === 'wandering_trader') {
    if (name === 'wandering_trader') {
      setTexture(['entity/wandering_trader', pick('default')])
      out.variant = 'wandering_trader'
    } else {
      const data = metaValue(entity, registry, 'villager_data') || {}
      const professionId = typeof data === 'object' ? Number(data.profession) : Number(data)
      const typeId = typeof data === 'object' ? Number(data.type) : 0
      const profession = VILLAGER_PROFESSIONS[Number.isFinite(professionId) ? professionId : 0] || 'none'
      out.variant = profession
      const key = profession === 'none' ? 'farmer' : profession === 'weaponsmith' ? 'smith' : profession
      const folder = name === 'zombie_villager' ? 'zombie_villager' : 'villager'
      setTexture([`entity/${folder}/profession/${key}`, pick(key), `entity/${folder}/profession/farmer`])
      const type = VILLAGER_TYPES[Number.isFinite(typeId) ? typeId : 0] || 'plains'
      out.variant = `${profession}/${type}`
      // The biome `type` sheet is a partial overlay whose UVs are authored
      // against the vanilla villager layers; drawing it over this catalogue's
      // geometry produced a mismatched silhouette, so it is reported instead of
      // being drawn incorrectly.
      out.notes.push(`villager biome overlay villager/type/${type} is not composited`)
    }
  } else if (name === 'armor_stand') {
    setTexture([pick('default'), 'entity/armorstand/wood'])
  } else if (name === 'shulker') {
    const color = num('color', 16)
    const key = color >= 0 && color < 16 ? SHEEP_COLORS[color].replace('silver', 'light_gray') : null
    setTexture([key ? `entity/shulker/shulker_${key}` : 'entity/shulker/shulker', pick(key), pick('undyed'), 'entity/shulker/shulker'], key || 'undyed')
  } else if (name === 'axolotl') {
    const variant = num('variant', 0)
    const key = AXOLOTL_VARIANTS[variant] || 'lucy'
    setTexture([`entity/axolotl/axolotl_${key}`, pick(key)], key)
  } else if (name === 'parrot') {
    const variant = num('variant', 0)
    const key = PARROT_VARIANTS[variant] || 'red_blue'
    setTexture([`entity/parrot/parrot_${key}`, pick(key)], key)
  } else if (name === 'rabbit') {
    const type = num('type', 0)
    const key = RABBIT_VARIANTS[type] || 'brown'
    setTexture([`entity/rabbit/${key}`, pick(key), pick('brown')], key)
  } else if (name === 'panda') {
    const gene = num('main_gene', 0)
    const key = PANDA_GENES[gene] || 'normal'
    setTexture([`entity/panda/${key === 'normal' ? 'panda' : `${key}_panda`}`, pick(key === 'normal' ? 'default' : key)], key)
  } else if (name === 'squid' || name === 'glow_squid') {
    setTexture([`entity/${name}/${name}`, `entity/${name}`, pick('default')])
  } else if (name === 'slime' || name === 'magma_cube') {
    const size = Math.max(1, Math.min(127, num('size', 4)))
    setTexture([pick('default'), 'entity/slime/slime'])
    out.scale = size / 4
    out.variant = `size ${size}`
  } else if (name === 'spectral_arrow') {
    setTexture([pick('default'), 'entity/projectiles/spectral_arrow'])
  } else if (name === 'arrow') {
    setTexture([pick('default'), 'entity/projectiles/arrow'])
  } else if (MINECART_KINDS.includes(name)) {
    setTexture([pick('default'), 'entity/minecart'])
    if (name !== 'minecart') out.notes.push(`${name} uses the minecart model; the chest/furnace/tnt block on top is a separate client model`)
  } else if (/_boat$/.test(name) || /_raft$/.test(name)) {
    const wood = woodOf(name) || 'oak'
    const key = wood === 'dark_oak' ? 'darkoak' : wood
    setTexture([pick(key), `entity/boat/${wood}`])
    out.geometryVariant = null
    out.variant = wood
    if (/_chest_boat$/.test(name)) out.notes.push('chest boat chest is a separate client model and is not drawn')
  } else {
    setTexture([pick('default'), entry.textures ? pick(...Object.keys(textures)) : null])
  }

  if (name === 'giant') out.scale = 6
  out.baby = isBaby(entity, registry)
  out.scale = out.baby ? out.scale * 0.5 : out.scale
  return out
}

module.exports = {
  CAT_VARIANTS,
  WOLF_VARIANTS,
  AXOLOTL_VARIANTS,
  PARROT_VARIANTS,
  RABBIT_VARIANTS,
  HORSE_COATS,
  HORSE_MARKINGS,
  SHEEP_COLORS,
  LLAMA_VARIANTS,
  VILLAGER_TYPES,
  VILLAGER_PROFESSIONS,
  modelKeyFor,
  entityAppearance,
  metaValue,
  isBaby,
  metadataKeysFor
}
