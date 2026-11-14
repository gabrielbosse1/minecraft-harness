/**
 * vision.js — screenshots for a model that can see.
 *
 * WHY A RENDERER AND NOT THE GAME'S OWN FRAME
 *   The bot is a headless protocol client: there is no window, no GPU and no
 *   frame buffer to grab (and the PufferPanel box it runs on has neither a
 *   display nor a browser). What it does have is the exact block and entity
 *   data the server sent. This module turns that into a picture by itself —
 *   a small ray-caster over the loaded chunks, written to a PNG with nothing
 *   but node:zlib. No native modules, no textures, no extra dependency.
 *
 * WHAT THE PICTURE IS (and is not)
 *   - `look`      first-person view from the bot's eyes (any direction).
 *   - `panorama`  the full 360° around the bot in one strip, north in the
 *                 middle, with compass marks.
 *   - `map`       top-down map (north up) with a coordinate grid, so a thing
 *                 seen in the picture can be turned into x/z for go_to.
 *   Blocks are flat colours by material, shaded by face, with block edges
 *   drawn so widths can be counted. Mobs and players are labelled boxes. It is
 *   always lit (a cave is as visible as a field) and shows no textures, signs'
 *   text, item frames or held items: exact facts still come from the block
 *   tools. It is for the GESTALT — "what kind of place is this, what is
 *   over there, which way is open" — the thing block lists are worst at.
 *
 * Everything here is synchronous-free of the game loop: `render*` yields to
 * the event loop between row batches so keep-alives and physics keep running.
 */
'use strict'

const zlib = require('node:zlib')

const DEG = Math.PI / 180

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Encode tightly packed RGB bytes as a PNG. */
function encodePng (rgb, width, height) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// Canvas + a 3x5 bitmap font (labels, compass, coordinates)
// ---------------------------------------------------------------------------
const GLYPHS = {
  A: '.#.#.#####.##.#', B: '##.#.###.#.###.', C: '.###..#..#...##', D: '##.#.##.##.###.', E: '####..##.#..###',
  F: '####..##.#..#..', G: '.###..#.##.#.##', H: '#.##.#####.##.#', I: '###.#..#..#.###', J: '..#..#..##.#.#.',
  K: '#.##.###.#.##.#', L: '#..#..#..#..###', M: '#.#######.##.#', N: '##.#.##.##.##.#', O: '.#.#.##.##.#.#.',
  P: '##.#.###.#..#..', Q: '.#.#.##.####.##', R: '##.#.###.#.##.#', S: '.###...#...###.', T: '###.#..#..#..#.',
  U: '#.##.##.##.####', V: '#.##.##.##.#.#.', W: '#.##.#######.#', X: '#.##.#.#.#.##.#', Y: '#.##.#.#..#..#.',
  Z: '###..#.#.#..###',
  0: '####.##.##.####', 1: '.#.##..#..#.###', 2: '##...#.#.#..###', 3: '##...#.#...###.', 4: '#.##.####..#..#',
  5: '####..##...###.', 6: '.###..####.####', 7: '###..#.#..#..#.', 8: '####.#####.####', 9: '####.####..###.',
  '-': '......###......', '.': '............#..', ',': '.........#.#..', ':': '....#.....#....', '[': '##.#..#..#..##.',
  ']': '.##..#..#..#.##', '(': '.#.#..#..#...#.', ')': '.#...#..#..#.#.', '/': '..#..#.#.#..#..', _: '............###',
  '=': '...###...###...', '+': '....#.###.#....', '#': '#.#####.#####.#', '>': '#...#...#.#.#..', '<': '..#.#.#...#...#',
  '?': '##...#.#.....#.', '!': '.#..#..#.....#.', '%': '#.#..#.#.#..#.#', "'": '.#..#..........', '*': '...#.#.#.#.#...'
}
// Two glyphs above were typed one cell short/long; normalise every glyph to 15 cells.
for (const k of Object.keys(GLYPHS)) GLYPHS[k] = (GLYPHS[k] + '...............').slice(0, 15)
GLYPHS.M = '#.#' + '###' + '###' + '#.#' + '#.#'
GLYPHS.W = '#.#' + '#.#' + '###' + '###' + '#.#'
GLYPHS[','] = '...' + '...' + '...' + '.#.' + '#..'

class Canvas {
  constructor (width, height) {
    this.width = width
    this.height = height
    this.rgb = new Uint8Array(width * height * 3)
  }

  set (x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 3
    this.rgb[i] = r; this.rgb[i + 1] = g; this.rgb[i + 2] = b
  }

  blend (x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 3
    this.rgb[i] = this.rgb[i] * (1 - a) + r * a
    this.rgb[i + 1] = this.rgb[i + 1] * (1 - a) + g * a
    this.rgb[i + 2] = this.rgb[i + 2] * (1 - a) + b * a
  }

  rect (x0, y0, w, h, c, a = 1) {
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.height, (y0 + h) | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(this.width, (x0 + w) | 0); x++) {
        if (a >= 1) this.set(x, y, c[0], c[1], c[2]); else this.blend(x, y, c[0], c[1], c[2], a)
      }
    }
  }

  outline (x0, y0, w, h, c) {
    this.rect(x0, y0, w, 1, c); this.rect(x0, y0 + h - 1, w, 1, c)
    this.rect(x0, y0, 1, h, c); this.rect(x0 + w - 1, y0, 1, h, c)
  }

  /** Width in pixels of `text` at `scale`. */
  static textWidth (text, scale = 2) { return String(text).length * 4 * scale - scale }

  /** Draw text with a dark backing plate so it reads on any background. */
  text (x, y, text, { scale = 2, color = [255, 255, 255], plate = [0, 0, 0], plateAlpha = 0.6 } = {}) {
    const s = String(text).toUpperCase()
    if (plate) this.rect(x - scale, y - scale, Canvas.textWidth(s, scale) + 2 * scale, 5 * scale + 2 * scale, plate, plateAlpha)
    let cx = x
    for (const ch of s) {
      const g = GLYPHS[ch]
      if (g) {
        for (let i = 0; i < 15; i++) {
          if (g[i] !== '#') continue
          this.rect(cx + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale, color)
        }
      }
      cx += 4 * scale
    }
  }

  png () { return encodePng(this.rgb, this.width, this.height) }
}

// ---------------------------------------------------------------------------
// Materials: block name -> colour + (optional) sub-block shape
// ---------------------------------------------------------------------------
/** First match wins. Colours are picked to be told apart, not to be pretty. */
const COLOR_RULES = [
  [/^(water|bubble_column)$|kelp|seagrass/, [52, 98, 214]],
  [/^lava$/, [255, 112, 20]],
  [/fire|magma/, [240, 120, 30]],
  [/glowstone|sea_lantern|shroomlight|lantern|torch|^light$|froglight|end_rod/, [255, 226, 120]],
  [/grass_block|^moss|lily_pad/, [98, 160, 62]],
  [/leaves|azalea|vine|bamboo|sugar_cane|cactus|^fern|sapling/, [52, 118, 40]],
  [/wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|sweet_berry/, [150, 170, 50]],
  [/poppy|tulip|rose|dandelion|orchid|allium|bluet|daisy|cornflower|lily_of|peony|lilac|sunflower|torchflower/, [220, 70, 110]],
  [/podzol|mycelium|rooted_dirt|coarse_dirt|^dirt$|dirt_path|farmland|^mud/, [134, 96, 67]],
  [/snow|powder_snow|^ice$|packed_ice|blue_ice|frosted_ice/, [236, 244, 250]],
  [/red_sand/, [190, 102, 44]],
  [/sandstone|^sand$|end_stone|birch_(planks|slab|stairs|fence|door|trapdoor)/, [219, 207, 150]],
  [/gravel/, [130, 126, 124]],
  [/clay/, [158, 164, 176]],
  [/coal_ore|coal_block/, [45, 45, 45]],
  [/iron_ore|raw_iron|iron_block|iron_bars|iron_door|^anvil|hopper|cauldron|minecart/, [196, 172, 150]],
  [/gold|bell/, [246, 208, 62]],
  [/diamond/, [92, 219, 213]],
  [/emerald/, [42, 190, 90]],
  [/redstone|^repeater$|^comparator$|^lever$|observer|piston|dispenser|dropper|target|tnt/, [200, 30, 30]],
  [/lapis/, [38, 76, 180]],
  [/copper/, [192, 108, 80]],
  [/amethyst|purpur|shulker|chorus/, [160, 110, 200]],
  [/obsidian|^bedrock$|blackstone|basalt|deepslate|sculk/, [44, 40, 56]],
  [/netherrack|nether_bricks|crimson|nether_wart/, [120, 40, 44]],
  [/soul_sand|soul_soil/, [84, 64, 52]],
  [/warped/, [40, 120, 120]],
  [/glass/, [190, 226, 236]],
  [/chest|barrel|crafting_table|bookshelf|lectern|loom|composter|note_block|jukebox|beehive|bee_nest/, [170, 112, 44]],
  [/furnace|smoker|stonecutter|grindstone/, [96, 96, 100]],
  [/_bed$/, [190, 50, 60]],
  [/dark_oak|spruce/, [84, 60, 36]],
  [/mangrove|acacia|cherry/, [176, 92, 70]],
  [/jungle/, [160, 116, 80]],
  [/_log$|_wood$|_stem$|_hyphae$/, [104, 82, 50]],
  [/planks|oak_|_sign|ladder|scaffolding|_fence|_door|_trapdoor|_button|pressure_plate/, [176, 142, 86]],
  [/white_|quartz|calcite|bone_block|cobweb|birch/, [232, 232, 226]],
  [/black_/, [28, 28, 32]], [/gray_/, [90, 90, 94]], [/red_|bricks?$/, [160, 60, 48]], [/orange_|pumpkin|terracotta/, [214, 122, 40]],
  [/yellow_|hay_block|sponge/, [240, 200, 60]], [/lime_|slime/, [120, 200, 50]], [/green_|melon/, [80, 120, 40]],
  [/cyan_|prismarine/, [50, 140, 150]], [/light_blue_/, [110, 170, 230]], [/blue_/, [50, 60, 170]],
  [/purple_|magenta_/, [150, 60, 180]], [/pink_/, [236, 150, 180]], [/brown_/, [110, 74, 44]],
  [/andesite|cobblestone|stone|tuff|diorite|granite|_ore$|dripstone|smooth_/, [124, 124, 126]]
]
/** Things with no collision box that are clutter in a picture (never drawn). */
const SKIP = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|light|barrier|structure_void|moving_piston|snow_?$|vine|glow_lichen|hanging_roots|spore_blossom|seagrass|tall_seagrass)$/
const FLAT = /carpet|^snow$|pressure_plate|redstone_wire|^rail$|_rail$|^repeater$|^comparator$|lily_pad|trapdoor|moss_carpet|pink_petals|leaf_litter|^tripwire$/
const SLAB = /_slab$|^farmland$|dirt_path|daylight_detector|^cake$|_bed$|enchanting_table|stonecutter/
const POST = /torch|_fence$|_wall$|^lever$|lantern|^chain$|end_rod|lightning_rod|_sign$|iron_bars|glass_pane|^ladder$|_button$|candle|^bamboo$|^cactus$|scaffolding|_fence_gate$/
const PLANT = /sapling|poppy|tulip|rose|dandelion|orchid|allium|bluet|daisy|cornflower|lily_of|mushroom$|wheat|carrots|potatoes|beetroots|sugar_cane|sweet_berry|nether_wart|_fungus$|_roots$|kelp|_stem$|torchflower|pitcher|_door$|cobweb|fire$/
const SHAPE_FLAT = [0, 0, 0, 1, 0.12, 1]
const SHAPE_SLAB = [0, 0, 0, 1, 0.5, 1]
const SHAPE_POST = [0.34, 0, 0.34, 0.66, 1, 0.66]
const SHAPE_PLANT = [0.2, 0, 0.2, 0.8, 0.85, 0.8]

function hashColor (name) {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) }
  return [110 + (h & 63), 100 + ((h >>> 8) & 63), 110 + ((h >>> 16) & 63)]
}

/** name -> { name, color, shape|null, kind } or null when it is not drawn. Pure. */
function materialFor (name, boundingBox = 'block') {
  const n = String(name || '').replace(/^minecraft:/, '')
  if (!n || SKIP.test(n)) return null
  let color = null
  for (const [re, c] of COLOR_RULES) if (re.test(n)) { color = c; break }
  const liquid = /^(water|lava|bubble_column)$/.test(n)
  let shape = null
  if (!liquid) {
    if (FLAT.test(n)) shape = SHAPE_FLAT
    else if (SLAB.test(n)) shape = SHAPE_SLAB
    else if (POST.test(n)) shape = SHAPE_POST
    else if (PLANT.test(n)) shape = SHAPE_PLANT
    else if (boundingBox === 'empty') return null // unknown passable decoration
  }
  const kind = n === 'lava' || /fire|glowstone|sea_lantern|shroomlight|lantern|torch|froglight|magma/.test(n) ? 'emissive'
    : liquid ? 'water'
      : /glass|^ice$/.test(n) ? 'glass' : 'solid'
  return { name: n, color: color || hashColor(n), shape, kind }
}

// ---------------------------------------------------------------------------
// World sampling: a lazily filled cube of material indices around the eye
// ---------------------------------------------------------------------------
class Sampler {
  constructor (bot, center, radius) {
    this.bot = bot
    this.R = radius
    this.S = radius * 2 + 1
    this.ox = Math.floor(center.x) - radius
    this.oy = Math.floor(center.y) - radius
    this.oz = Math.floor(center.z) - radius
    this.cells = new Int16Array(this.S * this.S * this.S).fill(-1)
    this.mats = [null]
    this._byName = new Map()
    this._byState = new Map()
    this._fast = Boolean(bot?.world && typeof bot.world.getBlockStateId === 'function' && bot?.registry?.blocksByStateId)
    this._probe = { x: 0, y: 0, z: 0, floored () { return this } }
    this.minY = Number.isFinite(bot?.game?.minY) ? bot.game.minY : -64
    this.maxY = this.minY + (Number.isFinite(bot?.game?.height) ? bot.game.height : 384)
  }

  _matIndex (name, bb) {
    let idx = this._byName.get(name)
    if (idx !== undefined) return idx
    const m = materialFor(name, bb)
    idx = m ? this.mats.push(m) - 1 : 0
    this._byName.set(name, idx)
    return idx
  }

  _read (x, y, z) {
    if (y < this.minY || y >= this.maxY) return 0
    try {
      if (this._fast) {
        const p = this._probe; p.x = x; p.y = y; p.z = z
        const sid = this.bot.world.getBlockStateId(p)
        if (!sid) return 0
        let idx = this._byState.get(sid)
        if (idx === undefined) {
          const b = this.bot.registry.blocksByStateId[sid]
          idx = b ? this._matIndex(b.name, b.boundingBox) : 0
          this._byState.set(sid, idx)
        }
        return idx
      }
      const b = this.bot.blockAt({ x, y, z, floored () { return this }, offset (dx, dy, dz) { return { x: x + dx, y: y + dy, z: z + dz } } })
      return b ? this._matIndex(b.name, b.boundingBox) : 0
    } catch { return 0 }
  }

  /** Material index at integer cell (0 = nothing drawn). */
  get (x, y, z) {
    const ix = x - this.ox; const iy = y - this.oy; const iz = z - this.oz
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.S || iy >= this.S || iz >= this.S) return 0
    const i = (iy * this.S + iz) * this.S + ix
    let v = this.cells[i]
    if (v === -1) { v = this._read(x, y, z); this.cells[i] = v }
    return v
  }
}

/** Ray vs. box [x0..x1] inside cell (cx,cy,cz). Returns { t, axis } or null. */
function hitShape (shape, cx, cy, cz, ox, oy, oz, dx, dy, dz) {
  let tmin = -Infinity; let tmax = Infinity; let axis = 1
  const lo = [cx + shape[0], cy + shape[1], cz + shape[2]]
  const hi = [cx + shape[3], cy + shape[4], cz + shape[5]]
  const o = [ox, oy, oz]; const d = [dx, dy, dz]
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue }
    let t1 = (lo[a] - o[a]) / d[a]; let t2 = (hi[a] - o[a]) / d[a]
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tmin) { tmin = t1; axis = a }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  return { t: Math.max(0, tmin), axis }
}

const FACE_LIGHT = [0.72, 1.0, 0.86] // x faces, top/bottom, z faces

/**
 * March one ray through the voxel grid (Amanatides–Woo).
 * @returns {{ t:number, mat:number, axis:number, x:number, y:number, z:number, tint:number[]|null } | null}
 */
function castRay (sampler, ox, oy, oz, dx, dy, dz, maxDist) {
  let x = Math.floor(ox); let y = Math.floor(oy); let z = Math.floor(oz)
  const sx = dx > 0 ? 1 : -1; const sy = dy > 0 ? 1 : -1; const sz = dz > 0 ? 1 : -1
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity
  let tx = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) * tdx) : Infinity
  let ty = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) * tdy) : Infinity
  let tz = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) * tdz) : Infinity
  let t = 0
  let axis = 1
  let tint = null
  let first = true
  for (let guard = 0; guard < 512 && t <= maxDist; guard++) {
    const m = first ? 0 : sampler.get(x, y, z) // never draw the cell the eye is in
    first = false
    if (m) {
      const mat = sampler.mats[m]
      if (mat.shape) {
        const h = hitShape(mat.shape, x, y, z, ox, oy, oz, dx, dy, dz)
        if (h && h.t <= maxDist) return { t: h.t, mat: m, axis: h.axis, x, y, z, tint }
      } else if (mat.kind === 'glass') {
        if (!tint) tint = mat.color // look through, slightly tinted
      } else {
        return { t, mat: m, axis, x, y, z, tint }
      }
    }
    if (tx <= ty && tx <= tz) { t = tx; tx += tdx; x += sx; axis = 0 } else if (ty <= tz) { t = ty; ty += tdy; y += sy; axis = 1 } else { t = tz; tz += tdz; z += sz; axis = 2 }
  }
  return tint ? { t: maxDist, mat: 0, axis: 1, x, y, z, tint } : null
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const BEARING_OF = { n: 0, north: 0, ne: 45, northeast: 45, e: 90, east: 90, se: 135, southeast: 135, s: 180, south: 180, sw: 225, southwest: 225, w: 270, west: 270, nw: 315, northwest: 315 }
const norm360 = (deg) => ((deg % 360) + 360) % 360
const compassName = (deg) => COMPASS[Math.round(norm360(deg) / 45) % 8]
/** Compass bearing (deg, 0 = north/-z, 90 = east/+x) of mineflayer's yaw (radians, 0 = north, counter-clockwise). */
const bearingOfYaw = (yaw) => norm360(-(Number(yaw) || 0) / DEG)
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve))

function eyeOf (bot) {
  const p = bot?.entity?.position
  if (!p) return null
  const eyeH = Number.isFinite(bot.entity.eyeHeight) ? bot.entity.eyeHeight : (Number.isFinite(bot.entity.height) ? bot.entity.height * 0.9 : 1.62)
  return { x: p.x, y: p.y + eyeH, z: p.z }
}

function skyColors (bot) {
  const tod = Number(bot?.time?.timeOfDay)
  const night = Number.isFinite(tod) && tod >= 13000 && tod <= 23000
  const dimName = String(bot?.game?.dimension || 'overworld')
  if (/nether/.test(dimName)) return { top: [70, 20, 20], horizon: [110, 40, 34], ambient: 0.9, label: 'nether' }
  if (/end/.test(dimName)) return { top: [16, 10, 26], horizon: [40, 30, 56], ambient: 0.9, label: 'the end' }
  return night
    ? { top: [10, 14, 34], horizon: [34, 42, 74], ambient: 0.7, label: 'night (the picture is lit anyway; real light is not shown)' }
    : { top: [98, 158, 238], horizon: [186, 214, 246], ambient: 1, label: 'day' }
}

const ENTITY_SKIP = /^(item|experience_orb|arrow|spectral_arrow|snowball|egg|ender_pearl|area_effect_cloud|marker|item_display|block_display|text_display|interaction|falling_block|fishing_bobber|leash_knot|lightning_bolt|eye_of_ender|firework_rocket|item_frame|glow_item_frame|painting|armor_stand)$/
function entityList (bot, eye, maxDist, isHostile) {
  const out = []
  for (const e of Object.values(bot?.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue
    const name = String(e.username || e.name || e.displayName || 'entity').toLowerCase()
    if (!e.username && ENTITY_SKIP.test(name)) continue
    const h = Number.isFinite(e.height) && e.height > 0 ? e.height : 1.8
    const w = Number.isFinite(e.width) && e.width > 0 ? e.width : 0.6
    const cx = e.position.x; const cy = e.position.y + h / 2; const cz = e.position.z
    const dist = Math.hypot(cx - eye.x, cy - eye.y, cz - eye.z)
    if (dist > maxDist) continue
    const player = Boolean(e.username) || e.type === 'player'
    const hostile = !player && Boolean(isHostile ? isHostile(name, e) : (e.type === 'hostile' || e.kind === 'Hostile mobs'))
    out.push({ id: e.id, name: player ? String(e.username || 'player') : name, player, hostile, h, w, cx, cy, cz, feetY: e.position.y, dist, color: player ? [40, 220, 240] : hostile ? [240, 40, 40] : [250, 230, 90] })
  }
  return out.sort((a, b) => b.dist - a.dist) // far first, so near ones draw on top
}

function shadeHit (hit, sampler, ox, oy, oz, dx, dy, dz, sky, maxDist) {
  const mat = sampler.mats[hit.mat]
  let [r, g, b] = mat.color
  const px = ox + dx * hit.t; const py = oy + dy * hit.t; const pz = oz + dz * hit.t
  if (mat.kind !== 'emissive') {
    let light = FACE_LIGHT[hit.axis]
    if (hit.axis === 1 && dy > 0) light = 0.55 // looking at an underside
    light *= sky.ambient
    // Block edges: a thin dark line where the hit point is near a cell border,
    // on the two axes of the face. Fades with distance so far terrain is clean.
    if (hit.t < 24 && !mat.shape) {
      const f = (v) => { const q = v - Math.floor(v); return Math.min(q, 1 - q) }
      const e = hit.axis === 0 ? Math.min(f(py), f(pz)) : hit.axis === 1 ? Math.min(f(px), f(pz)) : Math.min(f(px), f(py))
      if (e < 0.02 + hit.t * 0.004) light *= 0.72
    }
    if (mat.kind === 'water') light = 0.85 * sky.ambient + 0.1
    r *= light; g *= light; b *= light
  }
  const fog = Math.min(1, (hit.t / maxDist) ** 2) * 0.85
  r = r * (1 - fog) + sky.horizon[0] * fog
  g = g * (1 - fog) + sky.horizon[1] * fog
  b = b * (1 - fog) + sky.horizon[2] * fog
  return [r, g, b]
}

function skyAt (sky, dy) {
  const k = Math.max(0, Math.min(1, dy * 1.4 + 0.1))
  return [sky.horizon[0] * (1 - k) + sky.top[0] * k, sky.horizon[1] * (1 - k) + sky.top[1] * k, sky.horizon[2] * (1 - k) + sky.top[2] * k]
}

function shareList (counts, mats, total, max = 7) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([m, n]) => `${mats[m].name} ${Math.max(1, Math.round((n / total) * 100))}%`)
}

// ---------------------------------------------------------------------------
// look / panorama
// ---------------------------------------------------------------------------
/**
 * Render what a ray-per-pixel camera sees.
 * @param {object} bot mineflayer bot
 * @param {{ view?: 'look'|'panorama', bearing?: number, pitch?: number, fov?: number, width?: number, height?: number,
 *           maxDist?: number, isHostile?: Function }} opts  bearing/pitch in degrees (pitch + = up)
 * @returns {Promise<{ png: Buffer, width: number, height: number, summary: string, view: string }>}
 */
async function renderCamera (bot, opts = {}) {
  const eye = eyeOf(bot)
  if (!eye) throw new Error('no body position yet')
  const view = opts.view === 'panorama' ? 'panorama' : 'look'
  const pano = view === 'panorama'
  const width = Math.max(96, Math.min(1024, Math.trunc(opts.width || (pano ? 720 : 448))))
  const height = Math.max(64, Math.min(768, Math.trunc(opts.height || (pano ? 200 : 252))))
  const maxDist = Math.max(8, Math.min(96, Math.trunc(opts.maxDist || 64)))
  const bearing = pano ? 0 : norm360(Number.isFinite(opts.bearing) ? opts.bearing : bearingOfYaw(bot.entity.yaw))
  const pitch = pano ? 0 : Math.max(-89, Math.min(89, Number.isFinite(opts.pitch) ? opts.pitch : (Number(bot.entity.pitch) || 0) / DEG))
  const fov = Math.max(40, Math.min(120, Number(opts.fov) || 90))
  const sky = skyColors(bot)
  const sampler = new Sampler(bot, eye, maxDist + 1)
  const canvas = new Canvas(width, height)
  const zbuf = new Float32Array(width * height).fill(Infinity)
  const counts = new Map()
  let skyPx = 0

  const b = bearing * DEG; const p = pitch * DEG
  const fwd = [Math.sin(b) * Math.cos(p), Math.sin(p), -Math.cos(b) * Math.cos(p)]
  const right = [Math.cos(b), 0, Math.sin(b)]
  const up = [-Math.sin(b) * Math.sin(p), Math.cos(p), Math.cos(b) * Math.sin(p)]
  const tanH = Math.tan((fov / 2) * DEG)
  const tanV = tanH * (height / width)
  const panoTanV = Math.tan(40 * DEG) // ±40° vertical in the strip

  const dirFor = (px, py) => {
    if (pano) {
      const ang = ((px + 0.5) / width - 0.5) * 2 * Math.PI // centre column = north
      const v = (0.5 - (py + 0.5) / height) * 2 * panoTanV
      const l = Math.hypot(1, v)
      return [Math.sin(ang) / l, v / l, -Math.cos(ang) / l]
    }
    const u = ((px + 0.5) / width - 0.5) * 2 * tanH
    const v = (0.5 - (py + 0.5) / height) * 2 * tanV
    const x = fwd[0] + right[0] * u + up[0] * v
    const y = fwd[1] + right[1] * u + up[1] * v
    const z = fwd[2] + right[2] * u + up[2] * v
    const l = Math.hypot(x, y, z)
    return [x / l, y / l, z / l]
  }

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const [dx, dy, dz] = dirFor(px, py)
      const hit = castRay(sampler, eye.x, eye.y, eye.z, dx, dy, dz, maxDist)
      let c
      if (hit && hit.mat) {
        c = shadeHit(hit, sampler, eye.x, eye.y, eye.z, dx, dy, dz, sky, maxDist)
        zbuf[py * width + px] = hit.t
        counts.set(hit.mat, (counts.get(hit.mat) || 0) + 1)
      } else {
        c = skyAt(sky, dy)
        skyPx++
      }
      if (hit && hit.tint) c = [c[0] * 0.7 + hit.tint[0] * 0.3, c[1] * 0.7 + hit.tint[1] * 0.3, c[2] * 0.7 + hit.tint[2] * 0.3]
      canvas.set(px, py, c[0], c[1], c[2])
    }
    if (py % 24 === 23) await yieldLoop()
  }

  // ---- entities: labelled boxes, depth-tested against the terrain ----
  const seen = []
  for (const e of entityList(bot, eye, maxDist, opts.isHostile)) {
    const rx = e.cx - eye.x; const ry = e.cy - eye.y; const rz = e.cz - eye.z
    let sxp, syp, scale
    if (pano) {
      const ang = Math.atan2(rx, -rz) // bearing of the entity
      const horiz = Math.hypot(rx, rz) || 1e-6
      sxp = (ang / (2 * Math.PI) + 0.5) * width
      syp = (0.5 - (ry / horiz) / (2 * panoTanV)) * height
      scale = height / (2 * panoTanV * horiz)
    } else {
      const zc = rx * fwd[0] + ry * fwd[1] + rz * fwd[2]
      if (zc < 0.3) continue
      const xc = rx * right[0] + ry * right[1] + rz * right[2]
      const yc = rx * up[0] + ry * up[1] + rz * up[2]
      sxp = (xc / (zc * tanH) * 0.5 + 0.5) * width
      syp = (0.5 - yc / (zc * tanV) * 0.5) * height
      scale = width / (2 * tanH * zc)
    }
    if (sxp < -10 || sxp > width + 10 || syp < -10 || syp > height + 10) continue
    const zi = Math.max(0, Math.min(height - 1, Math.round(syp))) * width + Math.max(0, Math.min(width - 1, Math.round(sxp)))
    if (zbuf[zi] < e.dist - 0.8) continue // behind terrain
    const bw = Math.max(4, Math.round(e.w * scale)); const bh = Math.max(6, Math.round(e.h * scale))
    const x0 = Math.round(sxp - bw / 2); const y0 = Math.round(syp - bh / 2)
    canvas.rect(x0, y0, bw, bh, e.color, 0.85)
    canvas.outline(x0, y0, bw, bh, [0, 0, 0])
    const label = `${e.name.slice(0, 14)} ${Math.round(e.dist)}m`
    const tw = Canvas.textWidth(label, 2)
    canvas.text(Math.max(2, Math.min(width - tw - 2, Math.round(sxp - tw / 2))), Math.max(2, y0 - 14), label, { scale: 2, color: e.color })
    const side = pano ? compassName((sxp / width - 0.5) * 360) : (sxp < width / 3 ? 'left' : sxp > (2 * width) / 3 ? 'right' : 'centre')
    seen.push(`${e.name} [id=${e.id}] ${Math.round(e.dist)}m ${side}${e.hostile ? ' HOSTILE' : e.player ? ' player' : ''}`)
  }

  // ---- overlay ----
  const pos = bot.entity.position
  const here = `X ${Math.floor(pos.x)} Y ${Math.floor(pos.y)} Z ${Math.floor(pos.z)}`
  let centre = ''
  if (pano) {
    for (const [label, frac] of [['S', 0.012], ['W', 0.25], ['N', 0.5], ['E', 0.75], ['S', 0.988]]) {
      const x = Math.round(frac * width)
      canvas.rect(x, 0, 1, height, [255, 255, 255], 0.25)
      canvas.text(Math.max(3, Math.min(width - 12, x - 4)), 4, label, { scale: 3, color: [255, 240, 120] })
    }
    for (const [label, frac] of [['SW', 0.125], ['NW', 0.375], ['NE', 0.625], ['SE', 0.875]]) canvas.text(Math.round(frac * width) - 7, 6, label, { scale: 2, color: [220, 220, 220] })
    canvas.text(4, height - 14, `360 PANORAMA  ${here}`, { scale: 2 })
  } else {
    const cx = width >> 1; const cy = height >> 1
    canvas.rect(cx - 5, cy, 11, 1, [255, 255, 255]); canvas.rect(cx, cy - 5, 1, 11, [255, 255, 255])
    canvas.text(4, 4, `LOOKING ${compassName(bearing)}${Math.abs(pitch) >= 20 ? (pitch > 0 ? ' UP' : ' DOWN') : ''}  ${here}`, { scale: 2 })
    const hit = castRay(sampler, eye.x, eye.y, eye.z, fwd[0], fwd[1], fwd[2], maxDist)
    centre = hit && hit.mat
      ? `crosshair: ${sampler.mats[hit.mat].name} at ${hit.x},${hit.y},${hit.z} (${Math.round(hit.t)}m)`
      : `crosshair: nothing within ${maxDist}m (open air)`
  }

  const total = width * height
  const blocks = shareList(counts, sampler.mats, total)
  const summary = [
    pano
      ? `panorama from ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} — full circle, NORTH in the middle, W left of it, E right, S at both edges; ${sky.label}`
      : `view from ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)} looking ${compassName(bearing)} (bearing ${Math.round(bearing)}°, pitch ${Math.round(pitch)}°, ${fov}° wide); ${sky.label}`,
    `in frame: ${blocks.length ? blocks.join(', ') : 'no blocks'}; open sky/air ${Math.round((skyPx / total) * 100)}%`,
    centre || null,
    seen.length ? `creatures in frame: ${seen.reverse().slice(0, 8).join('; ')}` : 'creatures in frame: none',
    `drawn from block data out to ${maxDist}m: flat colours, no textures or light levels`
  ].filter(Boolean).join('\n')
  return { png: canvas.png(), width, height, summary, view }
}

// ---------------------------------------------------------------------------
// map (top-down)
// ---------------------------------------------------------------------------
/**
 * Top-down map, north up, with a coordinate grid.
 * @param {{ radius?: number, cell?: number, isHostile?: Function }} opts
 */
async function renderMap (bot, opts = {}) {
  const eye = eyeOf(bot)
  if (!eye) throw new Error('no body position yet')
  const pos = bot.entity.position
  const R = Math.max(8, Math.min(48, Math.trunc(opts.radius || 32)))
  const cell = Math.max(3, Math.min(10, Math.trunc(opts.cell || (R <= 16 ? 10 : R <= 32 ? 6 : 4))))
  const span = R * 2 + 1
  const margin = 34
  const width = span * cell + margin + 4
  const height = span * cell + margin + 18
  const canvas = new Canvas(width, height)
  canvas.rect(0, 0, width, height, [24, 24, 28])
  const bx = Math.floor(pos.x); const by = Math.floor(pos.y); const bz = Math.floor(pos.z)
  const sampler = new Sampler(bot, { x: bx, y: by, z: bz }, R + 1)

  // Under a roof (a cave, a house)? Then map the level the bot is on, not the
  // surface far above it.
  let covered = false
  for (let dy = 2; dy <= Math.min(R, 24); dy++) {
    const m = sampler.get(bx, by + dy, bz)
    if (m && !sampler.mats[m].shape && sampler.mats[m].kind !== 'glass' && !/leaves/.test(sampler.mats[m].name)) { covered = true; break }
  }
  const top = covered ? by + 2 : by + Math.min(R, 32)
  const bottom = by - Math.min(R, 32)
  const heights = new Int16Array(span * span).fill(-32768)
  const matAt = new Int16Array(span * span)
  const counts = new Map()
  for (let iz = 0; iz < span; iz++) {
    for (let ix = 0; ix < span; ix++) {
      const x = bx - R + ix; const z = bz - R + iz
      for (let y = top; y >= bottom; y--) {
        const m = sampler.get(x, y, z)
        if (!m) continue
        heights[iz * span + ix] = y; matAt[iz * span + ix] = m
        counts.set(m, (counts.get(m) || 0) + 1)
        break
      }
    }
    if (iz % 16 === 15) await yieldLoop()
  }
  let minH = Infinity; let maxH = -Infinity
  for (let i = 0; i < heights.length; i++) if (heights[i] > -32768) { minH = Math.min(minH, heights[i]); maxH = Math.max(maxH, heights[i]) }
  for (let iz = 0; iz < span; iz++) {
    for (let ix = 0; ix < span; ix++) {
      const i = iz * span + ix
      const px = margin + ix * cell; const py = margin + iz * cell
      if (heights[i] === -32768) { canvas.rect(px, py, cell, cell, [8, 8, 10]); continue }
      const mat = sampler.mats[matAt[i]]
      // Relief: higher than the bot = lighter, lower = darker; a step up toward
      // the north/west casts an edge, so cliffs and walls read as lines.
      const rel = Math.max(-1, Math.min(1, (heights[i] - by) / 12))
      let light = mat.kind === 'emissive' ? 1 : 0.82 + rel * 0.28
      const n = iz > 0 ? heights[i - span] : heights[i]
      const w = ix > 0 ? heights[i - 1] : heights[i]
      if (n > heights[i] || w > heights[i]) light *= 0.8
      else if (n < heights[i] || w < heights[i]) light *= 1.08
      canvas.rect(px, py, cell, cell, [Math.min(255, mat.color[0] * light), Math.min(255, mat.color[1] * light), Math.min(255, mat.color[2] * light)])
    }
  }
  // Coordinate grid: a line on every multiple of 8 (16 when zoomed out), labelled with the world coordinate.
  const step = R > 32 ? 16 : 8
  for (let ix = 0; ix < span; ix++) {
    const x = bx - R + ix
    if (x % step !== 0) continue
    const px = margin + ix * cell
    canvas.rect(px, margin, 1, span * cell, [255, 255, 255], 0.28)
    const label = String(x)
    canvas.text(Math.max(margin, Math.min(width - Canvas.textWidth(label, 2) - 2, px - Canvas.textWidth(label, 2) / 2)) | 0, 18, label, { scale: 2, plate: null, color: [255, 240, 120] })
  }
  for (let iz = 0; iz < span; iz++) {
    const z = bz - R + iz
    if (z % step !== 0) continue
    const py = margin + iz * cell
    canvas.rect(margin, py, span * cell, 1, [255, 255, 255], 0.28)
    canvas.text(1, py - 4, String(z), { scale: 2, plate: null, color: [140, 220, 255] })
  }
  canvas.text(margin, 3, `X (YELLOW) ACROSS  Z (BLUE) DOWN  NORTH IS UP`, { scale: 2, plate: null })
  // Entities.
  const seen = []
  for (const e of entityList(bot, eye, R * 1.5, opts.isHostile)) {
    const ix = Math.floor(e.cx) - (bx - R); const iz = Math.floor(e.cz) - (bz - R)
    if (ix < 0 || iz < 0 || ix >= span || iz >= span) continue
    const px = margin + ix * cell + (cell >> 1); const py = margin + iz * cell + (cell >> 1)
    canvas.rect(px - 3, py - 3, 7, 7, [0, 0, 0]); canvas.rect(px - 2, py - 2, 5, 5, e.color)
    canvas.text(Math.min(width - 60, px + 6), py - 4, e.name.slice(0, 10), { scale: 2, color: e.color })
    seen.push(`${e.name} [id=${e.id}] at ${Math.floor(e.cx)},${Math.floor(e.feetY)},${Math.floor(e.cz)}${e.hostile ? ' HOSTILE' : e.player ? ' player' : ''}`)
  }
  // The bot: a white marker with a line pointing where it faces.
  const mx = margin + R * cell + (cell >> 1); const my = margin + R * cell + (cell >> 1)
  const bb = bearingOfYaw(bot.entity.yaw) * DEG
  for (let k = 0; k < 12; k++) canvas.rect(Math.round(mx + Math.sin(bb) * k) - 1, Math.round(my - Math.cos(bb) * k) - 1, 2, 2, [255, 255, 255])
  canvas.rect(mx - 4, my - 4, 9, 9, [0, 0, 0]); canvas.rect(mx - 3, my - 3, 7, 7, [255, 255, 255])
  canvas.text(mx + 7, my + 5, 'YOU', { scale: 2 })
  canvas.text(margin, height - 14, `1 CELL = 1 BLOCK  GRID EVERY ${step}  ${covered ? 'ROOFED: YOUR LEVEL' : 'SURFACE'}`, { scale: 2, plate: null })

  const total = span * span
  const summary = [
    `map centred on you at ${bx},${by},${bz}: ${span}x${span} blocks (x ${bx - R}..${bx + R}, z ${bz - R}..${bz + R}), north up, grid line every ${step} blocks labelled with world x (top, yellow) and z (left, blue)`,
    covered ? 'you are under a roof/underground: the map shows your own level, not the surface above' : `surface heights y ${minH}..${maxH} (lighter = higher than you, darker = lower)`,
    `ground: ${shareList(counts, sampler.mats, total).join(', ') || 'nothing loaded'}`,
    seen.length ? `creatures: ${seen.slice(-8).join('; ')}` : 'creatures: none',
    'you = white square, the white line shows your facing'
  ].join('\n')
  return { png: canvas.png(), width, height, summary, view: 'map' }
}

/**
 * One entry point for the `screenshot` tool.
 * @param {{ view?: string, direction?: string, at?: number[], isHostile?: Function, width?: number, height?: number, maxDist?: number, radius?: number }} opts
 */
async function screenshot (bot, opts = {}) {
  const view = ['look', 'panorama', 'map'].includes(String(opts.view)) ? String(opts.view) : 'look'
  if (view === 'map') return renderMap(bot, opts)
  if (view === 'panorama') return renderCamera(bot, { ...opts, view: 'panorama', width: opts.panoramaWidth, height: opts.panoramaHeight })
  const cam = { ...opts, view: 'look' }
  const eye = eyeOf(bot)
  if (Array.isArray(opts.at) && opts.at.length === 3 && opts.at.every((v) => Number.isFinite(Number(v))) && eye) {
    const dx = Number(opts.at[0]) + 0.5 - eye.x; const dy = Number(opts.at[1]) + 0.5 - eye.y; const dz = Number(opts.at[2]) + 0.5 - eye.z
    cam.bearing = norm360(Math.atan2(dx, -dz) / DEG)
    cam.pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1e-6) / DEG
  } else if (opts.direction) {
    const d = String(opts.direction).toLowerCase().trim()
    if (d === 'up') cam.pitch = 60
    else if (d === 'down') cam.pitch = -60
    else if (d in BEARING_OF) { cam.bearing = BEARING_OF[d]; cam.pitch = 0 }
  }
  return renderCamera(bot, cam)
}

/** OpenAI-style image part for a PNG buffer. */
function imagePart (png) {
  return { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` } }
}

module.exports = { screenshot, renderCamera, renderMap, imagePart, encodePng, materialFor, castRay, Sampler, Canvas, bearingOfYaw, compassName, BEARING_OF }
