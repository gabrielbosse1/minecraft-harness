'use strict'
/**
 * Scene 2, floor 2. A storage room: 48 double chests in two rows, two tiers, each with a
 * wall sign on its front, plus a crafting table, a furnace and a brewing stand.
 * What does the place index learn, and what does the model actually get in "nearby:"?
 */
const { req, world } = require('./_common')
const { Vec3, registry, Block } = world
const { PlaceIndex } = req('zincai/places')

const LABELS = ['Minerios', 'Diamantes', 'Ferro', 'Ouro', 'Redstone', 'Carvao', 'Madeira', 'Pedra', 'Comida', 'Sementes', 'Mob drops', 'Ferramentas',
  'Armaduras', 'Pocoes', 'Livros', 'Encantados', 'Vidro', 'La', 'Terra', 'Areia', 'Nether', 'End', 'Decoracao', 'Diversos',
  'Flores', 'Corantes', 'Concreto', 'Terracota', 'Cobre', 'Lapis', 'Esmeralda', 'Quartzo', 'Peixes', 'Couro', 'Papel', 'Tralha',
  'Trilhos', 'Slime', 'Ossos', 'Polvora', 'Flechas', 'Arcos', 'Espadas', 'Picaretas', 'Baldes', 'Camas', 'Portas', 'Tochas']
const placed = new Map()
const signs = new Map()
let n = 0
for (const [chestZ, signZ] of [[0, 1], [8, 7]]) {
  for (let tier = 0; tier < 2; tier++) {
    for (let i = 0; i < 12; i++) {
      const x = -12 + i * 2
      placed.set(`${x},${70 + tier},${chestZ}`, 'chest'); placed.set(`${x + 1},${70 + tier},${chestZ}`, 'chest')
      placed.set(`${x},${70 + tier},${signZ}`, 'cherry_wall_sign'); signs.set(`${x},${70 + tier},${signZ}`, LABELS[n++])
    }
  }
}
placed.set('13,70,4', 'crafting_table'); placed.set('13,70,5', 'furnace'); placed.set('13,70,6', 'brewing_stand')

// Real block states: each pair is one double chest (left/right halves), and each sign
// hangs on the chest behind it. Row 1 faces south (signs at z+1), row 2 faces north.
const stateOf = (name, x, z) => {
  const def = registry.blocksByName[name || 'air']
  if (name === 'chest') {
    const facing = z === 0 ? 'south' : 'north'
    const even = ((x % 2) + 2) % 2 === 0
    // Seen from the front: for a south-facing chest the west block is the right half.
    const type = facing === 'south' ? (even ? 'right' : 'left') : (even ? 'left' : 'right')
    return Block.fromProperties(def.id, { facing, type, waterlogged: false }, 0)
  }
  if (name === 'cherry_wall_sign') return Block.fromProperties(def.id, { facing: z === 1 ? 'south' : 'north', waterlogged: false }, 0)
  return Block.fromStateId(def.defaultState, 0)
}
const cache = new Map()
const bot = {
  registry,
  game: { dimension: 'overworld' },
  entities: {},
  entity: { position: new Vec3(0.5, 70, 4.5) }, // middle of the aisle
  blockAt (p) {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    let b = cache.get(key)
    if (!b) {
      const name = placed.get(key)
      b = stateOf(name, Math.floor(p.x), Math.floor(p.z))
      b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      if (signs.has(key)) b.getSignText = () => [signs.get(key), '']
      cache.set(key, b)
    }
    return b
  },
  findBlocks ({ matching, maxDistance = 16, count = 64 }) {
    const ids = new Set(matching)
    const out = []
    for (const key of placed.keys()) {
      const [x, y, z] = key.split(',').map(Number)
      const v = new Vec3(x, y, z)
      if (v.distanceTo(bot.entity.position) <= maxDistance && ids.has(bot.blockAt(v).type)) out.push(v)
    }
    return out.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, count)
  }
}

const places = new PlaceIndex({})
places.scan(bot, { radius: 16, force: true })
const all = [...places.blocks.values()]
const chests = all.filter((e) => e.kind === 'chest')
let right = 0
for (const c of chests) { const x0 = c.x % 2 === 0 ? c.x : c.x - 1; if (c.label === signs.get(`${x0},${c.y},${c.z === 0 ? 1 : 7}`)) right++ }
console.log('In the room: 48 double chests, 48 signs, 3 work stations (147 blocks of interest).')
console.log(`Indexed after one scan from the middle of the aisle: ${chests.length} chests, ${all.filter((e) => e.kind === 'sign').length} signs, ${all.filter((e) => !['chest', 'sign'].includes(e.kind)).length} stations.`)
console.log(`Sign → chest association: ${right}/${chests.length} indexed chests carry the right label.`)
const text = places.describeNearby(bot.entity.position, { dim: 'overworld' })
console.log('\n--- the complete "nearby:" block the model receives ---\n' + text + '\n')
const labelsShown = LABELS.filter((l) => text.includes(l)).length
console.log(`chest ids the model can see: ${(text.match(/chest\d+/g) || []).length} of 48; labels it can address by name: ${labelsShown} of 48; prompt size: ${text.length} characters`)
for (const q of ['Diamantes', 'Ferro', 'ferramenta', 'brewing_stand']) {
  const e = places.resolve(q, bot.entity.position, { dim: 'overworld' })
  console.log(`resolve("${q}") →`, e ? `${e.id}${e.label ? ` "${e.label}"` : ''} at ${e.x},${e.y},${e.z}` : 'not found')
}
if (typeof places.listStorage === 'function') {
  const page = places.listStorage(bot.entity.position, { dim: 'overworld', page: 1 })
  console.log(`\nfind {what:"storage"} → page ${page.page}/${page.pages} of ${page.total}: ${page.lines.slice(0, 6).join('; ')}; …`)
}
