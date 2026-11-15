/**
 * zincai/vision.js — lightweight pure-JS Minecraft software voxel renderer.
 *
 * Renders approximate Minecraft-style screenshots straight from Mineflayer's
 * loaded chunks (`bot.world`) with ZERO GPU, browser, WebGL, or native binary
 * dependencies (only Node's built-in `node:zlib` for PNG compression).
 *
 * Three views:
 *   - 'look'      first-person perspective screenshot (default 512x288, 86° FOV)
 *   - 'panorama'  360° cylindrical sweep (720x200), NORTH centred, compass ticks
 *   - 'map'       top-down coordinate map (world X across, world Z down)
 *
 * Visual & performance design:
 *   - Chunk-column Sampler reads loaded chunks directly via `bot.world.getColumn`,
 *     skips empty 16x16x16 air sub-chunks in O(1), uses <250 KB working memory
 *     (vs gigabytes for a full Minecraft client), and covers ALL loaded chunks
 *     in view up to `maxDist` (default 128 blocks = 8-chunk radius).
 *   - Procedural 16x16 Minecraft-faithful block textures (grass overhang on dirt
 *     sides, birch white-and-black bark, wood plank seams, cobblestone mortar,
 *     mineral-speckled ores in stone, crafting-table grid, furnace firebox,
 *     chests with iron latches, dappled foliage, framed glass, translucent water,
 *     slender glowing torches, colored stems+blossoms for flowers).
 *   - Directional sunlight tied to Minecraft time-of-day, subtle voxel corner
 *     ambient occlusion (AO), horizon distance fog, sky gradient, square sun/moon,
 *     and classic flat blocky Minecraft clouds.
 *   - Depth-tested blocky Minecraft-proportioned mobs & players grounded at
 *     their true feet Y coordinate with crisp distance labels.
 *   - Yields every 24 rows (`setImmediate`) so Mineflayer keep-alives and physics
 *     never stall while a frame is rendering.
 */
'use strict'

const zlib = require('node:zlib')
const { getBlockTexture, HAS_TEXTURES } = require('./textures')

// ── Minimal PNG encoder (RGB, colour type 2, bit depth 8) ─────────────────

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

function pngChunk (type, data) {
  const out = Buffer.allocUnsafe(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng (rgb, width, height) {
  const stride = width * 3
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 1 // Sub filter: compresses flat runs & pixel-art tiles tightly
    const src = y * stride
    raw[row + 1] = rgb[src]
    raw[row + 2] = rgb[src + 1]
    raw[row + 3] = rgb[src + 2]
    for (let x = 3; x < stride; x++) {
      raw[row + 1 + x] = (rgb[src + x] - rgb[src + x - 3]) & 0xff
    }
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const idat = zlib.deflateSync(raw, { level: 3 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ── 5x7 bitmap font (compact uppercase + digits + punctuation) ────────────

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
}

class Canvas {
  constructor (w, h) {
    this.w = w
    this.h = h
    this.rgb = new Uint8Array(w * h * 3)
  }

  set (x, y, r, g, b) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.rgb[i] = r < 0 ? 0 : r > 255 ? 255 : r
    this.rgb[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g
    this.rgb[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
  }

  blend (x, y, r, g, b, a) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return
    const i = (y * this.w + x) * 3
    const ia = 1 - a
    this.rgb[i] = (this.rgb[i] * ia + r * a) | 0
    this.rgb[i + 1] = (this.rgb[i + 1] * ia + g * a) | 0
    this.rgb[i + 2] = (this.rgb[i + 2] * ia + b * a) | 0
  }

  rect (x, y, w, h, rgb, a = 1) {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w, Math.ceil(x + w))
    const y1 = Math.min(this.h, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (a >= 1) this.set(px, py, rgb[0], rgb[1], rgb[2])
        else this.blend(px, py, rgb[0], rgb[1], rgb[2], a)
      }
    }
  }

  outline (x, y, w, h, rgb) {
    const x0 = Math.floor(x), y0 = Math.floor(y)
    const x1 = Math.ceil(x + w) - 1, y1 = Math.ceil(y + h) - 1
    for (let px = x0; px <= x1; px++) {
      this.set(px, y0, rgb[0], rgb[1], rgb[2])
      this.set(px, y1, rgb[0], rgb[1], rgb[2])
    }
    for (let py = y0; py <= y1; py++) {
      this.set(x0, py, rgb[0], rgb[1], rgb[2])
      this.set(x1, py, rgb[0], rgb[1], rgb[2])
    }
  }

  line (x0, y0, x1, y1, rgb, a = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const px = Math.round(x0 + (x1 - x0) * t)
      const py = Math.round(y0 + (y1 - y0) * t)
      if (a >= 1) this.set(px, py, rgb[0], rgb[1], rgb[2])
      else this.blend(px, py, rgb[0], rgb[1], rgb[2], a)
    }
  }

  text (x, y, str, fg = [255, 255, 255], bg = null, scale = 1) {
    const s = String(str).toUpperCase()
    const gw = 6 * scale
    const gh = 7 * scale
    if (bg) this.rect(x - 2, y - 1, s.length * gw + 3, gh + 2, bg, bg[3] ?? 0.72)
    for (let c = 0; c < s.length; c++) {
      const glyph = FONT[s[c]] || FONT[' ']
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] !== '1') continue
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              this.set(x + c * gw + col * scale + sx, y + row * scale + sy, fg[0], fg[1], fg[2])
            }
          }
        }
      }
    }
  }
}

// ── Fast integer hash for deterministic 16x16 Minecraft pixel art ─────────

function h2 (x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return (h ^ (h >>> 16)) >>> 0
}

function h3 (x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return (h ^ (h >>> 16)) >>> 0
}

function clampByte (v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

// ── Material table & procedural 16x16 Minecraft block appearance ──────────

// Specific blocks FIRST, generic fallbacks LAST.
// Fields: [regex, baseRGB, pattern, accentRGB?, emissive?]
const MATERIAL_RULES = [
  // Sky / air / liquids
  [/^water$|bubble_column/, [48, 108, 224], 'water', [92, 152, 246]],
  [/^lava$/, [238, 104, 24], 'lava', [255, 210, 62], true],

  // Ground & soils
  [/^grass_block$/, [102, 168, 62], 'grass', [134, 96, 67]],
  [/^dirt_path$/, [166, 134, 78], 'path', [134, 96, 67]],
  [/^farmland$/, [114, 74, 44], 'farmland', [134, 96, 67]],
  [/^podzol$/, [118, 92, 56], 'grass', [134, 96, 67]],
  [/^mycelium$/, [134, 114, 126], 'grass', [134, 96, 67]],
  [/^dirt$|^coarse_dirt$|^rooted_dirt$/, [134, 96, 67], 'dirt'],
  [/mud_bricks/, [136, 108, 92], 'bricks', [96, 76, 64]],
  [/^mud$|packed_mud/, [94, 84, 86], 'dirt'],
  [/^snow$|snow_block|powder_snow/, [238, 244, 250], 'sand'],
  [/ice/, [152, 198, 246], 'ice'],
  [/red_sand/, [196, 106, 48], 'sand'],
  [/sandstone/, [216, 200, 148], 'stone'],
  [/sand/, [220, 206, 146], 'sand'],
  [/gravel/, [136, 132, 130], 'gravel'],
  [/clay/, [158, 164, 178], 'stone'],

  // Specific trees & wood (species BEFORE generic log/planks/leaves!)
  [/birch_log|birch_wood/, [226, 224, 214], 'birch_log', [46, 44, 42]],
  [/spruce_log|spruce_wood/, [68, 48, 30], 'log', [124, 96, 60]],
  [/dark_oak_log|dark_oak_wood/, [60, 44, 28], 'log', [108, 82, 50]],
  [/acacia_log|acacia_wood/, [108, 102, 92], 'log', [176, 98, 56]],
  [/jungle_log|jungle_wood/, [98, 82, 48], 'log', [156, 120, 82]],
  [/cherry_log|cherry_wood/, [58, 36, 44], 'log', [224, 168, 176]],
  [/mangrove_log|mangrove_wood/, [86, 62, 50], 'log', [122, 62, 54]],
  [/crimson_stem|warped_stem/, [116, 46, 76], 'log', [156, 56, 94]],
  [/_log$|_wood$|_stem$/, [108, 84, 52], 'log', [172, 142, 94]],

  [/birch_leaves/, [98, 152, 64], 'leaves'],
  [/spruce_leaves/, [52, 96, 56], 'leaves'],
  [/cherry_leaves/, [236, 164, 194], 'leaves'],
  [/azalea_leaves/, [86, 142, 56], 'leaves'],
  [/leaves|moss_block|vine/, [66, 136, 44], 'leaves'],

  [/spruce_/, [112, 82, 48], 'planks'],
  [/dark_oak_/, [68, 46, 26], 'planks'],
  [/birch_/, [206, 190, 136], 'planks'],
  [/acacia_/, [176, 96, 52], 'planks'],
  [/jungle_/, [162, 118, 82], 'planks'],
  [/cherry_/, [230, 176, 186], 'planks'],
  [/mangrove_/, [124, 56, 52], 'planks'],
  [/bamboo/, [194, 174, 82], 'planks'],

  // Utility & recognizable interior blocks
  [/^crafting_table$/, [162, 116, 68], 'crafting_table', [78, 54, 30]],
  [/furnace|smoker/, [122, 122, 124], 'furnace', [44, 42, 42]],
  [/ender_chest/, [38, 62, 66], 'chest', [186, 224, 212]],
  [/chest|barrel/, [174, 122, 48], 'chest', [214, 218, 224]],
  [/bookshelf/, [166, 132, 82], 'bookshelf', [182, 52, 52]],
  [/^tnt$/, [206, 48, 42], 'tnt', [236, 236, 232]],
  [/jack_o_lantern/, [214, 124, 28], 'pumpkin', [255, 224, 92], true],
  [/pumpkin/, [210, 122, 28], 'pumpkin', [54, 34, 12]],
  [/melon/, [126, 166, 44], 'log', [78, 118, 28]],
  [/hay_block/, [196, 166, 48], 'hay', [184, 46, 36]],
  [/anvil|smithing_table|grindstone/, [68, 68, 74], 'metal'],
  [/enchanting_table|beacon/, [76, 172, 182], 'metal', [224, 248, 255], true],

  // Ores (stone/deepslate base + distinct bright mineral cluster!)
  [/deepslate_coal_ore/, [76, 76, 82], 'ore', [24, 24, 28]],
  [/deepslate_iron_ore/, [76, 76, 82], 'ore', [218, 186, 156]],
  [/deepslate_gold_ore/, [76, 76, 82], 'ore', [252, 214, 62]],
  [/deepslate_diamond_ore/, [76, 76, 82], 'ore', [78, 230, 226]],
  [/deepslate_emerald_ore/, [76, 76, 82], 'ore', [42, 216, 98]],
  [/deepslate_redstone_ore/, [76, 76, 82], 'ore', [232, 34, 34]],
  [/deepslate_lapis_ore/, [76, 76, 82], 'ore', [42, 88, 218]],
  [/deepslate_copper_ore/, [76, 76, 82], 'ore', [222, 126, 84]],
  [/coal_ore/, [128, 128, 130], 'ore', [28, 28, 32]],
  [/iron_ore/, [128, 128, 130], 'ore', [218, 186, 156]],
  [/gold_ore/, [128, 128, 130], 'ore', [252, 214, 62]],
  [/diamond_ore/, [128, 128, 130], 'ore', [78, 230, 226]],
  [/emerald_ore/, [128, 128, 130], 'ore', [42, 216, 98]],
  [/redstone_ore/, [128, 128, 130], 'ore', [232, 34, 34]],
  [/lapis_ore/, [128, 128, 130], 'ore', [42, 88, 218]],
  [/copper_ore/, [128, 128, 130], 'ore', [222, 126, 84]],
  [/quartz_ore/, [118, 44, 44], 'ore', [232, 226, 214]],
  [/ancient_debris/, [102, 74, 64], 'ore', [168, 122, 102]],

  // Light sources
  [/soul_torch|soul_lantern/, [84, 228, 236], 'torch', [132, 98, 60], true],
  [/redstone_torch/, [238, 52, 42], 'torch', [132, 98, 60], true],
  [/torch|lantern|candle/, [255, 224, 96], 'torch', [138, 102, 60], true],
  [/glowstone|sea_lantern|shroomlight|ochre_froglight|pearlescent_froglight|verdant_froglight|redstone_lamp/, [248, 218, 118], 'glow', [255, 242, 178], true],
  [/fire|campfire/, [255, 162, 44], 'lava', [255, 232, 92], true],

  // Glass
  [/glass/, [196, 228, 242], 'glass', [238, 250, 255]],

  // Masonry & stone
  [/cobblestone|mossy_cobblestone/, [124, 124, 124], 'cobble'],
  [/stone_bricks|deepslate_bricks|polished_blackstone_bricks/, [122, 122, 124], 'bricks', [84, 84, 86]],
  [/nether_bricks/, [64, 34, 38], 'bricks', [42, 22, 26]],
  [/bricks/, [158, 86, 68], 'bricks', [196, 188, 178]],
  [/obsidian|crying_obsidian|respawn_anchor/, [36, 26, 52], 'cobble'],
  [/bedrock/, [48, 48, 52], 'cobble'],
  [/deepslate|blackstone|basalt/, [74, 74, 80], 'stone'],
  [/granite/, [154, 108, 92], 'stone'],
  [/diorite|calcite|quartz/, [216, 214, 212], 'stone'],
  [/andesite|tuff|stone/, [130, 130, 132], 'stone'],
  [/netherrack|crimson_nylium/, [116, 44, 44], 'cobble'],
  [/end_stone/, [218, 216, 158], 'cobble'],

  // Flowers (specific colors BEFORE generic flower rule!)
  [/dandelion|sunflower/, [248, 214, 42], 'flower', [56, 138, 42]],
  [/poppy|rose|red_tulip/, [226, 44, 44], 'flower', [56, 138, 42]],
  [/cornflower|blue_orchid/, [72, 132, 238], 'flower', [56, 138, 42]],
  [/oxeye_daisy|white_tulip|lily_of_the_valley|azure_bluet/, [242, 242, 238], 'flower', [56, 138, 42]],
  [/orange_tulip|torchflower/, [242, 136, 38], 'flower', [56, 138, 42]],
  [/allium|lilac|pink_tulip|peony/, [214, 118, 218], 'flower', [56, 138, 42]],
  [/tulip|flower|orchid|bluet|daisy/, [224, 84, 124], 'flower', [56, 138, 42]],

  // Crops & plants
  [/cactus|sugar_cane/, [74, 148, 54], 'reed'],
  [/wheat|carrots|potatoes|beetroots|sweet_berry/, [176, 158, 56], 'crop'],
  [/sapling|mushroom/, [98, 146, 54], 'flower', [112, 82, 48]],

  // Redstone & mechanisms
  [/redstone_wire|redstone_block|repeater|comparator/, [214, 34, 34], 'metal'],
  [/piston|observer|dispenser|dropper|hopper|rail|lever|button|pressure_plate/, [138, 138, 144], 'metal'],

  // Wood generic (oak planks, doors, fences, stairs, slabs, signs)
  [/planks|oak_|door|trapdoor|fence|gate|sign|ladder|stairs|slab/, [166, 132, 82], 'planks'],

  // Beds & dyed blocks
  [/red_bed|bed$/, [194, 48, 44], 'bed', [238, 238, 238]],
  [/white_/, [232, 234, 236], 'cloth'],
  [/black_/, [34, 34, 38], 'cloth'],
  [/red_/, [182, 46, 42], 'cloth'],
  [/blue_/, [56, 86, 178], 'cloth'],
  [/cyan_|light_blue_/, [76, 166, 198], 'cloth'],
  [/green_|lime_/, [94, 162, 54], 'cloth'],
  [/yellow_/, [234, 206, 54], 'cloth'],
  [/orange_/, [222, 126, 40], 'cloth'],
  [/purple_|magenta_|pink_/, [168, 78, 178], 'cloth'],
  [/brown_/, [118, 78, 48], 'cloth'],
  [/gray_|grey_/, [118, 120, 124], 'cloth'],

  // Metal & gem blocks
  [/diamond_block/, [86, 224, 218], 'metal'],
  [/emerald_block/, [46, 204, 96], 'metal'],
  [/gold_block/, [246, 206, 56], 'metal'],
  [/iron_block|iron_bars|iron_door/, [206, 208, 212], 'metal'],
  [/copper_block|cut_copper/, [192, 112, 76], 'metal'],
  [/coal_block/, [32, 32, 36], 'metal'],
  [/lapis_block/, [42, 78, 186], 'metal'],

  // Fallback
  [/.*/, [154, 148, 142], 'stone']
]

const SKIP = new Set([
  'air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'hanging_roots', 'cobweb'
])

const FLAT = /carpet|pressure_plate|rail|redstone_wire|repeater|comparator|snow$|lily_pad|moss_carpet|trapdoor|tripwire|button/
const SLAB = /_slab$|stonecutter|daylight_detector/
const POST = /fence$|_wall$|iron_bars|glass_pane|chain|lightning_rod|end_rod|bamboo$/
const FLOWER = /poppy|dandelion|tulip|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose|peony|sapling|mushroom|torchflower/
const CROP = /wheat|carrots|potatoes|beetroots|sweet_berry|nether_wart|sugar_cane/
const TORCH = /torch|candle/
const LANTERN = /lantern/
const CHEST = /chest$|barrel/
const BED = /_bed$/
const DOOR = /_door$/
const PATH = /^dirt_path$|^farmland$/

const SHAPE_FULL = null
const SHAPE_FLAT = [0, 0, 0, 1, 0.125, 1]
const SHAPE_SLAB = [0, 0, 0, 1, 0.5, 1]
const SHAPE_BED = [0, 0, 0, 1, 0.5625, 1]
const SHAPE_PATH = [0, 0, 0, 1, 0.9375, 1]
const SHAPE_POST = [0.375, 0, 0.375, 0.625, 1, 0.625]
const SHAPE_TORCH = [0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625]
const SHAPE_LANTERN = [0.3125, 0, 0.3125, 0.6875, 0.5625, 0.6875]
const SHAPE_CHEST = [0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]
const SHAPE_FLOWER = [0.40, 0, 0.40, 0.60, 0.50, 0.60]
const SHAPE_CROP = [0.15, 0, 0.15, 0.85, 0.62, 0.85]
const SHAPE_DOOR = [0, 0, 0.40, 1, 1, 0.60]

function materialFor (name) {
  if (!name || SKIP.has(name)) return { skip: true, name: name || 'air' }
  let rgb = [154, 148, 142]
  let pattern = 'stone'
  let accent = null
  let emissive = false
  for (const [re, col, pat, acc, em] of MATERIAL_RULES) {
    if (re.test(name)) {
      rgb = col
      pattern = pat
      accent = acc || null
      emissive = Boolean(em)
      break
    }
  }
  const glass = pattern === 'glass'
  const water = pattern === 'water'
  const leaves = pattern === 'leaves'
  let shape = SHAPE_FULL
  if (TORCH.test(name)) shape = SHAPE_TORCH
  else if (LANTERN.test(name)) shape = SHAPE_LANTERN
  else if (FLOWER.test(name)) shape = SHAPE_FLOWER
  else if (CROP.test(name)) shape = SHAPE_CROP
  else if (CHEST.test(name)) shape = SHAPE_CHEST
  else if (BED.test(name)) shape = SHAPE_BED
  else if (DOOR.test(name)) shape = SHAPE_DOOR
  else if (PATH.test(name)) shape = SHAPE_PATH
  else if (FLAT.test(name)) shape = SHAPE_FLAT
  else if (SLAB.test(name)) shape = SHAPE_SLAB
  else if (POST.test(name)) shape = SHAPE_POST

  return {
    skip: false,
    name,
    rgb,
    pattern,
    accent,
    emissive,
    glass,
    water,
    leaves,
    shape,
    opaqueFull: shape === SHAPE_FULL && !glass && !water && !leaves
  }
}

function makePalette (bot) {
  const byState = bot.registry?.blocksByStateId
  const byMat = new Map()
  const mats = [{ skip: true, name: 'air', opaqueFull: false }]
  const stateCache = new Int16Array(Math.max(4096, (byState ? Object.keys(byState).length : 0) + 1024)).fill(-1)

  function idForName (name) {
    let id = byMat.get(name)
    if (id === undefined) {
      id = mats.length
      mats.push(materialFor(name))
      byMat.set(name, id)
    }
    return id
  }

  return {
    mats,
    fromState (stateId) {
      if (stateId == null || stateId <= 0) return 0
      if (stateId < stateCache.length && stateCache[stateId] >= 0) return stateCache[stateId]
      const name = byState?.[stateId]?.name || 'air'
      const id = idForName(name)
      if (stateId < stateCache.length) stateCache[stateId] = id
      return id
    },
    fromName: idForName
  }
}

// ── Chunk-column world sampler (covers all loaded chunks, <250 KB RAM) ────

// Pack signed 16-bit chunk coords (cx, cz) into one 32-bit integer key (zero string allocations!)
function chunkKey (cx, cz) {
  return ((cx & 0xffff) << 16) | (cz & 0xffff)
}

class Sampler {
  constructor (bot, pal, eyeX, eyeZ, maxDist) {
    this.bot = bot
    this.world = bot.world
    this.pal = pal
    this.probe = { x: 0, y: 0, z: 0 }
    this.local = { x: 0, y: 0, z: 0 }
    this.chunks = new Map()
    this.chunksTouched = new Set()
    this.chunksLoaded = 0
    this.minY = -64
    this.maxY = 319
    this.globalMaxSolidY = -64
    this.globalMinSolidY = 319
    this.farthestLoadedDist = 0
    this.hasColumns = false
    // 16K-entry direct-mapped voxel cache (~160 KB) — eliminates redundant
    // `col.getBlockStateId` lookups across adjacent camera rays & AO checks.
    this._cMask = 16383
    this._cX = new Int32Array(16384).fill(0x7fffffff)
    this._cY = new Int16Array(16384)
    this._cZ = new Int32Array(16384)
    this._cV = new Int16Array(16384)

    const rawCols = this.world?.async?.columns || this.world?.columns
    if (rawCols && typeof rawCols === 'object') {
      const entries = Object.entries(rawCols)
      this.chunksLoaded = entries.length
      this.hasColumns = entries.length > 0
      for (const [key, col] of entries) {
        if (!col) continue
        const comma = key.indexOf(',')
        if (comma < 0) continue
        const cx = Number(key.slice(0, comma))
        const cz = Number(key.slice(comma + 1))
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue

        const minY = typeof col.minY === 'number' ? col.minY : -64
        const worldHeight = typeof col.worldHeight === 'number' ? col.worldHeight : 384
        if (minY < this.minY) this.minY = minY
        if (minY + worldHeight - 1 > this.maxY) this.maxY = minY + worldHeight - 1

        // Precompute non-empty section bitmask so empty air sub-chunks skip in O(1)
        const sections = Array.isArray(col.sections) ? col.sections : null
        let secMask = 0
        let colMaxY = minY - 1
        let colMinY = minY + worldHeight
        if (sections) {
          for (let i = 0; i < sections.length; i++) {
            const s = sections[i]
            if (!s) continue
            const hasBlocks = (typeof s.solidBlockCount !== 'number') || s.solidBlockCount > 0 || (s.fluidCount > 0)
            if (hasBlocks) {
              secMask |= (1 << i)
              const sy0 = minY + i * 16
              if (sy0 < colMinY) colMinY = sy0
              if (sy0 + 15 > colMaxY) colMaxY = sy0 + 15
            }
          }
        } else {
          secMask = -1
          colMinY = minY
          colMaxY = minY + worldHeight - 1
        }
        if (colMaxY > this.globalMaxSolidY) this.globalMaxSolidY = colMaxY
        if (colMinY < this.globalMinSolidY) this.globalMinSolidY = colMinY

        // Measure farthest corner of this loaded chunk from the camera
        const wx0 = cx * 16, wz0 = cz * 16
        const dx = Math.max(Math.abs(wx0 - eyeX), Math.abs(wx0 + 16 - eyeX))
        const dz = Math.max(Math.abs(wz0 - eyeZ), Math.abs(wz0 + 16 - eyeZ))
        const dist = Math.hypot(dx, dz)
        if (dist > this.farthestLoadedDist) this.farthestLoadedDist = dist

        this.chunks.set(chunkKey(cx, cz), { col, cx, cz, minY, maxY: minY + worldHeight - 1, secMask, colMinY, colMaxY })
      }
    }

    if (this.globalMaxSolidY < this.globalMinSolidY) {
      this.globalMinSolidY = this.minY
      this.globalMaxSolidY = this.maxY
    }

    // Effective draw distance: cover all loaded chunks in view up to maxDist
    this.maxDist = this.hasColumns && this.farthestLoadedDist > 0
      ? Math.min(maxDist, Math.max(24, Math.ceil(this.farthestLoadedDist) + 2))
      : maxDist
  }

  getChunk (cx, cz) {
    if (!this.hasColumns) return null
    return this.chunks.get(chunkKey(cx, cz)) || null
  }

  at (x, y, z) {
    if (y < this.minY || y > this.maxY) return 0
    const slot = ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & this._cMask
    if (this._cX[slot] === x && this._cY[slot] === y && this._cZ[slot] === z) return this._cV[slot]
    let id = 0
    if (this.hasColumns) {
      const wrap = this.chunks.get(chunkKey(x >> 4, z >> 4))
      if (wrap && y >= wrap.colMinY && y <= wrap.colMaxY) {
        const si = (y - wrap.minY) >> 4
        if (si >= 0 && si < 31 && (wrap.secMask & (1 << si))) {
          this.local.x = x & 15
          this.local.y = y
          this.local.z = z & 15
          try {
            id = this.pal.fromState(wrap.col.getBlockStateId(this.local))
          } catch { id = 0 }
        }
      }
    } else {
      // Fallback for synthetic/mock worlds without `world.columns`
      this.probe.x = x; this.probe.y = y; this.probe.z = z
      try {
        if (typeof this.world?.getBlockStateId === 'function') {
          id = this.pal.fromState(this.world.getBlockStateId(this.probe))
        } else {
          const b = this.bot.blockAt?.(this.probe)
          id = b ? this.pal.fromName(b.name) : 0
        }
      } catch { id = 0 }
    }
    this._cX[slot] = x
    this._cY[slot] = y
    this._cZ[slot] = z
    this._cV[slot] = id
    return id
  }

  isOpaqueAt (x, y, z) {
    const id = this.at(x, y, z)
    return id > 0 && this.pal.mats[id].opaqueFull
  }
}

// ── Ray-box intersection for sub-voxel shapes (torches, flowers, chests...) ─

function hitBox (ox, oy, oz, dx, dy, dz, bx, by, bz, shape) {
  let tmin = -Infinity
  let tmax = Infinity
  let axis = 1
  const bounds = [
    [bx + shape[0], bx + shape[3], ox, dx],
    [by + shape[1], by + shape[4], oy, dy],
    [bz + shape[2], bz + shape[5], oz, dz]
  ]
  for (let a = 0; a < 3; a++) {
    const [lo, hi, o, d] = bounds[a]
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null
    } else {
      let t0 = (lo - o) / d
      let t1 = (hi - o) / d
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp }
      if (t0 > tmin) { tmin = t0; axis = a }
      if (t1 < tmax) tmax = t1
      if (tmin > tmax) return null
    }
  }
  return tmax >= 0 ? { t: Math.max(0, tmin), axis } : null
}

// ── Amanatides-Woo voxel DDA with empty-subchunk skipping & translucency ──

function castRay (sampler, mats, ox, oy, oz, dx, dy, dz, maxDist, trackChunks = false) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz)
  const sx = dx >= 0 ? 1 : -1
  const sy = dy >= 0 ? 1 : -1
  const sz = dz >= 0 ? 1 : -1
  const txD = Math.abs(dx) > 1e-9 ? Math.abs(1 / dx) : 1e9
  const tyD = Math.abs(dy) > 1e-9 ? Math.abs(1 / dy) : 1e9
  const tzD = Math.abs(dz) > 1e-9 ? Math.abs(1 / dz) : 1e9
  let tx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? x + 1 - ox : ox - x) * txD) : 1e9
  let ty = Math.abs(dy) > 1e-9 ? ((dy > 0 ? y + 1 - oy : oy - y) * tyD) : 1e9
  let tz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? z + 1 - oz : oz - z) * tzD) : 1e9

  let t = 0
  let axis = 1
  let glassOverlay = null
  let waterEntry = null
  const useCols = sampler.hasColumns
  const maxSolidY = sampler.globalMaxSolidY
  const minSolidY = sampler.globalMinSolidY
  const maxWaterTrace = 12
  let lastCx = 0x7fffffff
  let lastCz = 0x7fffffff
  let curChunk = null

  while (t < maxDist) {
    // Early sky exit when marching away from all solid geometry vertically
    if (dy >= 0 && y > maxSolidY) break
    if (dy <= 0 && y < minSolidY) break

    let id = 0
    if (useCols) {
      const cx = x >> 4
      const cz = z >> 4
      if (cx !== lastCx || cz !== lastCz) {
        lastCx = cx
        lastCz = cz
        const ck = chunkKey(cx, cz)
        curChunk = sampler.chunks.get(ck) || null
        if (curChunk && trackChunks) sampler.chunksTouched.add(ck)
      }
      if (curChunk && y >= curChunk.colMinY && y <= curChunk.colMaxY) {
        const si = (y - curChunk.minY) >> 4
        if (si >= 0 && si < 31 && (curChunk.secMask & (1 << si))) {
          const slot = ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & sampler._cMask
          if (sampler._cX[slot] === x && sampler._cY[slot] === y && sampler._cZ[slot] === z) {
            id = sampler._cV[slot]
          } else {
            sampler.local.x = x & 15
            sampler.local.y = y
            sampler.local.z = z & 15
            id = sampler.pal.fromState(curChunk.col.getBlockStateId(sampler.local))
            sampler._cX[slot] = x
            sampler._cY[slot] = y
            sampler._cZ[slot] = z
            sampler._cV[slot] = id
          }
        }
      }
    } else {
      id = sampler.at(x, y, z)
    }

    if (id > 0) {
      const mat = mats[id]
      if (!mat.skip) {
        if (mat.water) {
          if (!waterEntry) {
            waterEntry = { t, axis, x, y, z, id }
          }
          // Stop underwater trace after maxWaterTrace so deep oceans don't waste rays
          if (t - waterEntry.t >= maxWaterTrace) {
            return {
              t: waterEntry.t, axis: waterEntry.axis,
              x: waterEntry.x, y: waterEntry.y, z: waterEntry.z,
              id: waterEntry.id, glassOverlay, waterEntry, underwaterOnly: true
            }
          }
        } else if (mat.glass) {
          if (!glassOverlay) {
            glassOverlay = { t, axis, x, y, z, id }
          }
        } else if (mat.shape) {
          const hit = hitBox(ox, oy, oz, dx, dy, dz, x, y, z, mat.shape)
          if (hit && hit.t < maxDist) {
            return { t: hit.t, axis: hit.axis, x, y, z, id, glassOverlay, waterEntry }
          }
        } else {
          return { t, axis, x, y, z, id, glassOverlay, waterEntry }
        }
      }
    }

    // Advance voxel DDA (with fast skip across completely empty 16x16x16 subchunks!)
    if (useCols && (!curChunk || y < curChunk.colMinY || y > curChunk.colMaxY || !(curChunk.secMask & (1 << ((y - curChunk.minY) >> 4))))) {
      // Jump to the boundary of the current 16x16x16 sub-chunk
      const nx = dx > 0 ? ((x >> 4) + 1) * 16 : (dx < 0 ? (x >> 4) * 16 - 1 : x)
      const ny = dy > 0 ? ((y >> 4) + 1) * 16 : (dy < 0 ? (y >> 4) * 16 - 1 : y)
      const nz = dz > 0 ? ((z >> 4) + 1) * 16 : (dz < 0 ? (z >> 4) * 16 - 1 : z)
      const tJumpX = Math.abs(dx) > 1e-9 ? ((dx > 0 ? nx - ox : (nx + 1) - ox) / dx) : 1e9
      const tJumpY = Math.abs(dy) > 1e-9 ? ((dy > 0 ? ny - oy : (ny + 1) - oy) / dy) : 1e9
      const tJumpZ = Math.abs(dz) > 1e-9 ? ((dz > 0 ? nz - oz : (nz + 1) - oz) / dz) : 1e9
      let tNext = Math.min(tJumpX, tJumpY, tJumpZ)
      if (tNext > t + 1e-4) {
        if (tNext >= maxDist) break
        const eps = tNext + 1e-4
        x = Math.floor(ox + dx * eps)
        y = Math.floor(oy + dy * eps)
        z = Math.floor(oz + dz * eps)
        t = tNext
        axis = tJumpX <= tJumpY && tJumpX <= tJumpZ ? 0 : (tJumpY <= tJumpZ ? 1 : 2)
        tx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? x + 1 - ox : ox - x) * txD) : 1e9
        ty = Math.abs(dy) > 1e-9 ? ((dy > 0 ? y + 1 - oy : oy - y) * tyD) : 1e9
        tz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? z + 1 - oz : oz - z) * tzD) : 1e9
        continue
      }
    }

    if (tx < ty) {
      if (tx < tz) { t = tx; tx += txD; x += sx; axis = 0 }
      else { t = tz; tz += tzD; z += sz; axis = 2 }
    } else {
      if (ty < tz) { t = ty; ty += tyD; y += sy; axis = 1 }
      else { t = tz; tz += tzD; z += sz; axis = 2 }
    }
  }

  if (waterEntry) {
    return {
      t: waterEntry.t, axis: waterEntry.axis,
      x: waterEntry.x, y: waterEntry.y, z: waterEntry.z,
      id: waterEntry.id, glassOverlay, waterEntry, underwaterOnly: true
    }
  }
  return glassOverlay ? { t: maxDist, sky: true, glassOverlay } : null
}

// ── Procedural 16x16 Minecraft block texture evaluator ────────────────────

const _texOut = new Uint8Array(3)
const _pxOut = new Uint8Array(3)

function sampleBlockTexture (mat, axis, dx, dy, dz, fx, fy, fz, bx, by, bz, out = _texOut) {
  // Normalize UV to sub-box if non-full block so textures align cleanly
  let u = 0, v = 0
  if (mat.shape) {
    const [x0, y0, z0, x1, y1, z1] = mat.shape
    const nx = Math.max(0, Math.min(0.999, (fx - x0) / Math.max(1e-4, x1 - x0)))
    const ny = Math.max(0, Math.min(0.999, (fy - y0) / Math.max(1e-4, y1 - y0)))
    const nz = Math.max(0, Math.min(0.999, (fz - z0) / Math.max(1e-4, z1 - z0)))
    if (axis === 0) { u = nz; v = 1 - ny }
    else if (axis === 2) { u = nx; v = 1 - ny }
    else { u = nx; v = nz }
  } else {
    if (axis === 0) { u = fz; v = 1 - fy }
    else if (axis === 2) { u = fx; v = 1 - fy }
    else { u = fx; v = fz }
  }
  const tu = Math.min(15, Math.max(0, (u * 16) | 0))
  const tv = Math.min(15, Math.max(0, (v * 16) | 0))

  const topFace = axis === 1 && dy <= 0
  const botFace = axis === 1 && dy > 0

  const face = topFace ? 'top' : (botFace ? 'bottom' : 'side')
  const realTex = mat.name ? getBlockTexture(mat.name, face) : null
  if (realTex) {
    const idx = ((tv & 15) * 16 + (tu & 15)) * 4
    if (realTex[idx + 3] >= 16) {
      out[0] = realTex[idx]
      out[1] = realTex[idx + 1]
      out[2] = realTex[idx + 2]
      return out
    }
  }

  let r = mat.rgb[0]
  let g = mat.rgb[1]
  let b = mat.rgb[2]
  const pat = mat.pattern

  if (pat === 'grass') {
    const dirt = mat.accent || [134, 96, 67]
    if (topFace) {
      const n = ((h2(tu + bx * 5, tv + bz * 5) & 31) - 16)
      r += n * 0.7; g += n * 0.9; b += n * 0.5
    } else if (botFace) {
      const n = ((h2(tu, tv) & 31) - 16)
      r = dirt[0] + n; g = dirt[1] + n * 0.8; b = dirt[2] + n * 0.6
    } else {
      // Iconic Minecraft grass overhang along top 2..4 pixels of dirt side!
      const overhang = 2 + (h2(tu, 7) % 3)
      if (tv < overhang) {
        const n = ((h2(tu, tv) & 15) - 8)
        r += n; g += n; b += n * 0.6
      } else {
        const h = h2(tu, tv)
        const n = ((h & 31) - 16)
        // Occasional small stone pebble in Minecraft dirt texture
        if ((h & 255) < 16) {
          r = 122 + (n >> 1); g = 118 + (n >> 1); b = 114 + (n >> 1)
        } else {
          r = dirt[0] + n; g = dirt[1] + n * 0.85; b = dirt[2] + n * 0.7
        }
      }
    }
  } else if (pat === 'path') {
    const dirt = mat.accent || [134, 96, 67]
    if (topFace) {
      const n = ((h2(tu + bx * 3, tv + bz * 3) & 31) - 16)
      r += n * 0.8; g += n * 0.7; b += n * 0.5
    } else if (tv < 2 && !botFace) {
      const n = ((h2(tu, tv) & 15) - 8)
      r += n; g += n * 0.9; b += n * 0.6
    } else {
      const n = ((h2(tu, tv) & 31) - 16)
      r = dirt[0] + n; g = dirt[1] + n * 0.85; b = dirt[2] + n * 0.7
    }
  } else if (pat === 'farmland') {
    const n = ((h2(tu, tv) & 15) - 8)
    const furrow = topFace && (tv % 4 === 1) ? -22 : 0
    r += n + furrow; g += n * 0.8 + furrow; b += n * 0.6 + furrow
  } else if (pat === 'dirt') {
    const h = h2(tu, tv)
    const n = ((h & 31) - 16)
    if ((h & 255) < 18) { r = 124; g = 120; b = 116 }
    else { r += n; g += n * 0.85; b += n * 0.7 }
  } else if (pat === 'sand') {
    const n = ((h2(tu, tv) & 15) - 8)
    r += n; g += n * 0.95; b += n * 0.85
  } else if (pat === 'gravel') {
    const n = ((h2(tu >> 1, tv >> 1) & 63) - 32)
    r += n; g += n; b += n
  } else if (pat === 'planks') {
    const board = tv >> 2
    const seamH = (tv & 3) === 0
    const seamV = (tu === 0 && (board & 1) === 0) || (tu === 8 && (board & 1) === 1)
    const grain = ((h2(tu >> 1, tv) & 15) - 8)
    const mul = seamH ? 0.72 : (seamV ? 0.76 : 1.0)
    r = r * mul + grain
    g = g * mul + grain * 0.85
    b = b * mul + grain * 0.65
  } else if (pat === 'birch_log') {
    if (axis === 1) {
      const edge = tu === 0 || tu === 15 || tv === 0 || tv === 15
      const ring = Math.max(Math.abs(tu - 7.5), Math.abs(tv - 7.5))
      if (edge) { r = 216; g = 214; b = 204 }
      else {
        const dark = ((ring | 0) & 1) === 0 ? -10 : 8
        r = 198 + dark; g = 184 + dark; b = 138 + dark
      }
    } else {
      // Iconic white birch bark with dark horizontal charcoal marks!
      const rowHash = h2(tv, 41)
      const markStart = rowHash & 15
      const markLen = 2 + ((rowHash >> 4) % 3)
      const inMark1 = (tv % 3 === 1) && ((tu - markStart + 16) & 15) < markLen
      const mark2Start = (rowHash >> 8) & 15
      const inMark2 = (tv % 5 === 3) && ((tu - mark2Start + 16) & 15) < 2
      if (inMark1 || inMark2) {
        const dark = mat.accent || [46, 44, 42]
        r = dark[0]; g = dark[1]; b = dark[2]
      } else {
        const n = ((h2(tu, tv) & 15) - 8)
        r += n; g += n; b += n
      }
    }
  } else if (pat === 'log') {
    if (axis === 1) {
      const edge = tu === 0 || tu === 15 || tv === 0 || tv === 15
      const inner = mat.accent || [172, 142, 94]
      if (edge) { r *= 0.88; g *= 0.88; b *= 0.88 }
      else {
        const ring = Math.max(Math.abs(tu - 7.5), Math.abs(tv - 7.5))
        const shade = ((ring | 0) & 1) === 0 ? -12 : 8
        r = inner[0] + shade; g = inner[1] + shade * 0.9; b = inner[2] + shade * 0.7
      }
    } else {
      // Vertical bark ridges
      const stripe = ((h2(tu, 13) & 31) - 16)
      const detail = ((h2(tu, tv) & 15) - 8)
      r += stripe + detail * 0.5
      g += stripe * 0.85 + detail * 0.4
      b += stripe * 0.65 + detail * 0.3
    }
  } else if (pat === 'leaves') {
    const h = h2(tu, tv) & 15
    const cluster = h2(tu >> 1, tv >> 1) & 3
    if (h < 3) { r *= 0.46; g *= 0.50; b *= 0.44 } // deep shadow gaps inside canopy
    else if (cluster === 0) { r *= 1.18; g *= 1.16; b *= 1.10 }
    else if (cluster === 1) { r *= 0.82; g *= 0.84; b *= 0.80 }
  } else if (pat === 'cobble') {
    // Classic irregular cobblestone chunks + dark mortar seams
    const cellX = (tu + ((tv >> 2) & 1) * 2) >> 2
    const cellY = tv >> 2
    const localX = (tu + ((tv >> 2) & 1) * 2) & 3
    const localY = tv & 3
    const mortar = localY === 0 || localX === 0
    const tone = ((h2(cellX, cellY) & 31) - 16)
    const fine = ((h2(tu, tv) & 15) - 8)
    const mul = mortar ? 0.68 : 1.0
    r = (r + tone + fine * 0.5) * mul
    g = (g + tone + fine * 0.5) * mul
    b = (b + tone + fine * 0.5) * mul
  } else if (pat === 'bricks') {
    const row = tv >> 2
    const mortar = (tv & 3) === 0 || (((tu + (row & 1) * 4) & 7) === 0)
    if (mortar) {
      const m = mat.accent || [188, 184, 178]
      r = m[0]; g = m[1]; b = m[2]
    } else {
      const tone = ((h2((tu + (row & 1) * 4) >> 3, row) & 15) - 8)
      const grain = ((h2(tu, tv) & 7) - 4)
      r += tone + grain; g += tone + grain; b += tone + grain
    }
  } else if (pat === 'stone') {
    const n = ((h2(tu >> 1, tv) & 15) - 8) + ((h2(tu, tv) & 7) - 4)
    r += n; g += n; b += n
  } else if (pat === 'ore') {
    // Stone base with iconic Minecraft pixel-cluster ore veins!
    const inNugget =
      (tu >= 3 && tu <= 5 && tv >= 3 && tv <= 4) ||
      (tu >= 10 && tu <= 12 && tv >= 4 && tv <= 6) ||
      (tu >= 4 && tu <= 6 && tv >= 10 && tv <= 12) ||
      (tu >= 11 && tu <= 13 && tv >= 11 && tv <= 12) ||
      (tu === 7 && tv === 7)
    if (inNugget && mat.accent) {
      const n = ((h2(tu, tv) & 15) - 8)
      r = mat.accent[0] + n
      g = mat.accent[1] + n
      b = mat.accent[2] + n
    } else {
      const n = ((h2(tu >> 1, tv) & 15) - 8)
      r += n; g += n; b += n
    }
  } else if (pat === 'crafting_table') {
    const dark = mat.accent || [78, 54, 30]
    if (topFace) {
      // Classic 3x3 crafting grid framed by warm oak border!
      const border = tu <= 1 || tu >= 14 || tv <= 1 || tv >= 14
      const gridLine = !border && (tu === 5 || tu === 10 || tv === 5 || tv === 10)
      if (border) { r = 136; g = 92; b = 50 }
      else if (gridLine) { r = dark[0]; g = dark[1]; b = dark[2] }
      else {
        const n = ((h2(tu, tv) & 15) - 8)
        r = 186 + n; g = 144 + n * 0.9; b = 90 + n * 0.7
      }
    } else {
      const plankSeam = (tv & 3) === 0
      const toolBar = tv >= 2 && tv <= 7 && (tu === 4 || tu === 5 || tu === 10 || tu === 11)
      if (toolBar) { r = 68; g = 68; b = 74 }
      else if (plankSeam) { r *= 0.74; g *= 0.74; b *= 0.74 }
      else {
        const n = ((h2(tu, tv) & 15) - 8)
        r += n; g += n * 0.85; b += n * 0.7
      }
    }
  } else if (pat === 'furnace') {
    if (axis !== 1 && tu >= 4 && tu <= 11 && ((tv >= 3 && tv <= 6) || (tv >= 10 && tv <= 13))) {
      // Iconic dark firebox + upper oven opening on furnace side
      r = 38; g = 36; b = 36
    } else {
      const seam = (tv === 0 || tv === 8 || tv === 15)
      const n = ((h2(tu, tv) & 15) - 8)
      const mul = seam ? 0.74 : 1.0
      r = (r + n) * mul; g = (g + n) * mul; b = (b + n) * mul
    }
  } else if (pat === 'chest') {
    const border = tu === 0 || tu === 15 || tv === 0 || tv === 15
    const lidSplit = axis !== 1 && tv === 5
    const latch = axis !== 1 && tu >= 7 && tu <= 8 && tv >= 4 && tv <= 7
    if (latch) {
      const l = mat.accent || [214, 218, 224]
      r = l[0]; g = l[1]; b = l[2]
    } else if (border || lidSplit) {
      r *= 0.48; g *= 0.46; b *= 0.42
    } else {
      const n = ((h2(tu, tv) & 15) - 8)
      r += n; g += n * 0.85; b += n * 0.65
    }
  } else if (pat === 'bookshelf') {
    if (axis !== 1 && tv >= 2 && tv <= 13 && tv !== 7 && tv !== 8) {
      const bookCols = [[182, 50, 46], [56, 132, 68], [62, 92, 174], [198, 162, 54], [148, 82, 162]]
      const col = bookCols[(tu >> 1) % bookCols.length]
      const spine = (tu & 1) === 0 ? 1.0 : 0.82
      r = col[0] * spine; g = col[1] * spine; b = col[2] * spine
    } else {
      const n = ((h2(tu, tv) & 15) - 8)
      r += n; g += n * 0.85; b += n * 0.65
    }
  } else if (pat === 'torch') {
    // Bottom 70% = oak stick; top 30% = glowing bright flame!
    if (tv <= 4) {
      if (tv <= 2 && tu >= 4 && tu <= 11) { r = 255; g = 244; b = 158 }
      else { r = mat.rgb[0]; g = mat.rgb[1]; b = mat.rgb[2] }
    } else {
      const stick = mat.accent || [138, 102, 60]
      const n = ((h2(tu, tv) & 15) - 8)
      r = stick[0] + n; g = stick[1] + n * 0.85; b = stick[2] + n * 0.7
    }
  } else if (pat === 'flower') {
    // Top half = vibrant flower petals; lower half = crisp green stem!
    const stem = mat.accent || [56, 138, 42]
    if (tv > 7 || (tv > 5 && (tu < 3 || tu > 12))) {
      const n = ((h2(tu, tv) & 15) - 8)
      r = stem[0] + n * 0.5; g = stem[1] + n; b = stem[2] + n * 0.5
    } else {
      const n = ((h2(tu, tv) & 15) - 8)
      r += n; g += n; b += n
    }
  } else if (pat === 'bed') {
    if (topFace && tu < 5) {
      const p = mat.accent || [238, 238, 238]
      r = p[0]; g = p[1]; b = p[2]
    } else if (!topFace && tv > 10) {
      r = 154; g = 118; b = 74
    }
  } else if (pat === 'water') {
    const wave = ((tu + tv + bx * 3 + bz * 5) & 7) === 0 ? 18 : (((tu - tv + bx * 2) & 7) === 0 ? -10 : 0)
    r += wave; g += wave * 1.1; b += wave * 0.8
  } else if (pat === 'lava') {
    const hot = ((h2(tu >> 1, tv >> 1) & 3) === 0)
    if (hot && mat.accent) { r = mat.accent[0]; g = mat.accent[1]; b = mat.accent[2] }
  } else if (pat === 'tnt') {
    if (axis !== 1 && tv >= 5 && tv <= 10) {
      r = 236; g = 236; b = 232
    }
  } else {
    const n = ((h2(tu, tv) & 15) - 8)
    r += n; g += n; b += n
  }

  out[0] = clampByte(r)
  out[1] = clampByte(g)
  out[2] = clampByte(b)
  return out
}

// ── Subtle Minecraft voxel ambient occlusion (creases & contact shadows) ──

function computeVoxelAO (sampler, hit, dx, dy, dz, fx, fy, fz) {
  let ao = 1.0
  const bx = hit.x, by = hit.y, bz = hit.z
  if (hit.axis === 1 && dy <= 0) {
    // Top face: darken softly near adjacent walls rising above this block
    if (fx < 0.32 && sampler.isOpaqueAt(bx - 1, by + 1, bz)) ao -= (0.32 - fx) * 0.92
    if (fx > 0.68 && sampler.isOpaqueAt(bx + 1, by + 1, bz)) ao -= (fx - 0.68) * 0.92
    if (fz < 0.32 && sampler.isOpaqueAt(bx, by + 1, bz - 1)) ao -= (0.32 - fz) * 0.92
    if (fz > 0.68 && sampler.isOpaqueAt(bx, by + 1, bz + 1)) ao -= (fz - 0.68) * 0.92
  } else if (hit.axis === 0 || hit.axis === 2) {
    // Vertical face: contact shadow at ground crease & beneath roof overhang
    const nx = hit.axis === 0 ? (dx > 0 ? -1 : 1) : 0
    const nz = hit.axis === 2 ? (dz > 0 ? -1 : 1) : 0
    if (fy < 0.28 && sampler.isOpaqueAt(bx + nx, by - 1, bz + nz)) ao -= (0.28 - fy) * 0.85
    if (fy > 0.72 && sampler.isOpaqueAt(bx + nx, by + 1, bz + nz)) ao -= (fy - 0.72) * 0.95
    // Horizontal inner corners
    if (hit.axis === 2) {
      if (fx < 0.26 && sampler.isOpaqueAt(bx - 1, by, bz + nz)) ao -= (0.26 - fx) * 0.75
      if (fx > 0.74 && sampler.isOpaqueAt(bx + 1, by, bz + nz)) ao -= (fx - 0.74) * 0.75
    } else {
      if (fz < 0.26 && sampler.isOpaqueAt(bx + nx, by, bz - 1)) ao -= (0.26 - fz) * 0.75
      if (fz > 0.74 && sampler.isOpaqueAt(bx + nx, by, bz + 1)) ao -= (fz - 0.74) * 0.75
    }
  }
  return Math.max(0.62, ao)
}

// ── Sky, Sun/Moon, Stars & Blocky Minecraft Clouds ────────────────────────

function skyProfile (bot) {
  const dim = String(bot.game?.dimension || 'overworld').toLowerCase()
  if (dim.includes('nether')) {
    return { zenith: [76, 22, 22], horizon: [118, 38, 28], ambient: 0.78, label: 'nether', dim: 'nether', sun: null, clouds: false }
  }
  if (dim.includes('end')) {
    return { zenith: [16, 12, 28], horizon: [34, 24, 52], ambient: 0.65, label: 'end', dim: 'end', sun: null, clouds: false }
  }
  const tod = Number.isFinite(bot.time?.timeOfDay) ? ((bot.time.timeOfDay % 24000) + 24000) % 24000 : 4000
  // Sun rises East (+x) at tod=0, arches high at tod=6000, sets West (-x) at tod=12000
  const sunAngle = (tod / 24000) * Math.PI * 2
  const sunX = Math.cos(sunAngle)
  const sunY = Math.sin(sunAngle)
  const sunZ = -0.32
  const sunLen = Math.hypot(sunX, sunY, sunZ) || 1
  const sunDir = [sunX / sunLen, sunY / sunLen, sunZ / sunLen]

  if (tod > 13000 && tod < 23000) {
    return {
      zenith: [10, 14, 34], horizon: [26, 36, 68], ambient: 0.42,
      label: 'night', dim: 'overworld', night: true,
      sun: [-sunDir[0], -sunDir[1], -sunDir[2]], clouds: true
    }
  }
  if ((tod >= 11500 && tod <= 13000) || tod >= 23000 || tod < 500) {
    return {
      zenith: [86, 108, 178], horizon: [236, 152, 92], ambient: 0.78,
      label: 'twilight', dim: 'overworld', night: false,
      sun: sunDir, clouds: true
    }
  }
  return {
    zenith: [106, 160, 248], horizon: [190, 218, 252], ambient: 1.0,
    label: 'day', dim: 'overworld', night: false,
    sun: sunDir, clouds: true
  }
}

function skyPixel (sky, dx, dy, dz, eyeX, eyeY, eyeZ) {
  const k = Math.max(0, Math.min(1, dy * 1.45 + 0.08))
  let r = sky.horizon[0] + (sky.zenith[0] - sky.horizon[0]) * k
  let g = sky.horizon[1] + (sky.zenith[1] - sky.horizon[1]) * k
  let b = sky.horizon[2] + (sky.zenith[2] - sky.horizon[2]) * k

  // Classic square Minecraft sun / moon (tangent-plane box test!)
  if (sky.sun && dy > -0.05) {
    const sx = sky.sun[0], sy = sky.sun[1], sz = sky.sun[2]
    const dot = dx * sx + dy * sy + dz * sz
    if (dot > 0.94) {
      // Orthonormal tangent basis around sun vector
      const rl = Math.hypot(-sz, sx) || 1
      const rx = -sz / rl, rz = sx / rl
      const ux = -sy * rz, uy = sx * rz - sz * rx, uz = sy * rx
      const du = Math.abs(dx * rx + dz * rz)
      const dv = Math.abs(dx * ux + dy * uy + dz * uz)
      const box = Math.max(du, dv)
      if (box < 0.085) {
        if (sky.night) { r = 232; g = 236; b = 248 }
        else { r = 255; g = 252; b = 212 }
      } else if (box < 0.18 && !sky.night) {
        const glow = (0.18 - box) / 0.095
        r += (255 - r) * glow * 0.36
        g += (240 - g) * glow * 0.30
        b += (190 - b) * glow * 0.20
      }
    }
  }

  // Night stars
  if (sky.night && dy > 0.14) {
    const sx = Math.floor(Math.atan2(dx, dz) * 90)
    const sy = Math.floor(Math.asin(Math.max(-1, Math.min(1, dy))) * 90)
    if ((h2(sx, sy) & 1023) === 0) {
      r = 228; g = 234; b = 252
    }
  }

  // Classic flat blocky Minecraft clouds high overhead
  if (sky.clouds && dy > 0.055) {
    const tCloud = 52 / dy
    if (tCloud < 520) {
      const cx = Math.floor((eyeX + dx * tCloud) / 14)
      const cz = Math.floor((eyeZ + dz * tCloud) / 14)
      const isCloud = ((h2(cx, cz) & 7) === 0) || (((h2(cx - 1, cz) & 7) === 0) && ((h2(cx, cz + 1) & 3) === 0))
      if (isCloud) {
        const fade = Math.max(0, Math.min(1, (dy - 0.055) * 4.5)) * (1 - tCloud / 560)
        const ca = fade * (sky.night ? 0.22 : 0.72)
        const cr = sky.night ? 140 : 246
        const cg = sky.night ? 152 : 250
        const cb = sky.night ? 178 : 255
        r = r * (1 - ca) + cr * ca
        g = g * (1 - ca) + cg * ca
        b = b * (1 - ca) + cb * ca
      }
    }
  }

  _pxOut[0] = clampByte(r)
  _pxOut[1] = clampByte(g)
  _pxOut[2] = clampByte(b)
  return _pxOut
}

// ── Shading hit point with textures, AO, water/glass translucency & fog ──

function shadeHit (sampler, mats, hit, ox, oy, oz, dx, dy, dz, sky, maxDist) {
  // Pure sky (possibly seen through glass!)
  if (!hit || hit.sky) {
    const col = skyPixel(sky, dx, dy, dz, ox, oy, oz)
    if (hit?.glassOverlay) {
      applyGlassOverlay(col, mats[hit.glassOverlay.id], hit.glassOverlay, ox, oy, oz, dx, dy, dz)
    }
    return col
  }

  const mat = mats[hit.id]
  const px = ox + dx * hit.t
  const py = oy + dy * hit.t
  const pz = oz + dz * hit.t
  const fx = px - Math.floor(px)
  const fy = py - Math.floor(py)
  const fz = pz - Math.floor(pz)

  // Anti-aliased procedural 16x16 Minecraft pixel texture (skipped completely past fade range!)
  const detailFade = Math.max(0, Math.min(1, 1 - (hit.t - 10) / 36))
  let baseR, baseG, baseB
  if (detailFade <= 0) {
    if (mat.pattern === 'grass' && hit.axis !== 1) {
      baseR = 126; baseG = 108; baseB = 66
    } else {
      baseR = mat.rgb[0]; baseG = mat.rgb[1]; baseB = mat.rgb[2]
    }
  } else {
    const tex = sampleBlockTexture(mat, hit.axis, dx, dy, dz, fx, fy, fz, hit.x, hit.y, hit.z, _texOut)
    if (detailFade >= 1) {
      baseR = tex[0]; baseG = tex[1]; baseB = tex[2]
    } else if (mat.pattern === 'grass' && hit.axis !== 1) {
      baseR = tex[0] * detailFade + 126 * (1 - detailFade)
      baseG = tex[1] * detailFade + 108 * (1 - detailFade)
      baseB = tex[2] * detailFade + 66 * (1 - detailFade)
    } else {
      baseR = tex[0] * detailFade + mat.rgb[0] * (1 - detailFade)
      baseG = tex[1] * detailFade + mat.rgb[1] * (1 - detailFade)
      baseB = tex[2] * detailFade + mat.rgb[2] * (1 - detailFade)
    }
  }

  // Authentic Minecraft directional face shading (top bright, N/S medium, E/W slightly cooler, bottom dim)
  let light = hit.axis === 1 ? (dy > 0 ? 0.56 : 1.0) : (hit.axis === 2 ? 0.85 : 0.74)
  if (!mat.emissive) {
    light *= sky.ambient
    if (!mat.shape && hit.t < 38) {
      light *= computeVoxelAO(sampler, hit, dx, dy, dz, fx, fy, fz)
    }
  } else {
    // Emissive torches, lava, glowstone stay luminous even at night
    light = Math.max(light, 0.96)
  }

  let r = baseR * light
  let g = baseG * light
  let b = baseB * light

  // Translucent water tint & depth absorption when ray passed through water before hitting riverbed!
  if (hit.waterEntry && !hit.underwaterOnly) {
    const wMat = mats[hit.waterEntry.id]
    const depth = Math.max(0, hit.t - hit.waterEntry.t)
    const wx = ox + dx * hit.waterEntry.t
    const wz = oz + dz * hit.waterEntry.t
    const ripple = (((Math.floor(wx * 4) + Math.floor(wz * 4)) & 3) === 0) ? 14 : 0
    const wr = (wMat.rgb[0] + ripple) * sky.ambient
    const wg = (wMat.rgb[1] + ripple) * sky.ambient
    const wb = (wMat.rgb[2] + ripple * 0.5) * sky.ambient
    const alpha = Math.max(0.42, Math.min(0.86, 0.44 + depth * 0.095))
    r = r * (1 - alpha) + wr * alpha
    g = g * (1 - alpha) + wg * alpha
    b = b * (1 - alpha) + wb * alpha
  }

  _pxOut[0] = clampByte(r)
  _pxOut[1] = clampByte(g)
  _pxOut[2] = clampByte(b)

  // Translucent framed glass overlay
  if (hit.glassOverlay) {
    applyGlassOverlay(_pxOut, mats[hit.glassOverlay.id], hit.glassOverlay, ox, oy, oz, dx, dy, dz)
  }

  // Smooth Minecraft distance fog starting at 68% of effective render distance
  const fogStart = maxDist * 0.68
  if (hit.t > fogStart) {
    const f = Math.min(1, (hit.t - fogStart) / Math.max(8, maxDist - fogStart))
    const fog = f * f * 0.82
    _pxOut[0] = clampByte(_pxOut[0] * (1 - fog) + sky.horizon[0] * fog)
    _pxOut[1] = clampByte(_pxOut[1] * (1 - fog) + sky.horizon[1] * fog)
    _pxOut[2] = clampByte(_pxOut[2] * (1 - fog) + sky.horizon[2] * fog)
  }

  return _pxOut
}

function applyGlassOverlay (buf, gMat, gHit, ox, oy, oz, dx, dy, dz) {
  const px = ox + dx * gHit.t
  const py = oy + dy * gHit.t
  const pz = oz + dz * gHit.t
  const fx = px - Math.floor(px)
  const fy = py - Math.floor(py)
  const fz = pz - Math.floor(pz)
  const u = gHit.axis === 0 ? fz : fx
  const v = gHit.axis === 1 ? fz : (1 - fy)
  const tu = Math.min(15, Math.max(0, (u * 16) | 0))
  const tv = Math.min(15, Math.max(0, (v * 16) | 0))
  const frame = tu === 0 || tu === 15 || tv === 0 || tv === 15
  const glint = (tu === 3 && tv === 3) || (tu === 4 && tv === 2) || (tu === 12 && tv === 11) || (tu === 11 && tv === 12)
  const a = frame ? 0.66 : (glint ? 0.56 : 0.16)
  const col = (frame || glint) ? (gMat.accent || [238, 250, 255]) : gMat.rgb
  buf[0] = clampByte(buf[0] * (1 - a) + col[0] * a)
  buf[1] = clampByte(buf[1] * (1 - a) + col[1] * a)
  buf[2] = clampByte(buf[2] * (1 - a) + col[2] * a)
  return buf
}

// ── Camera & coordinate conventions ───────────────────────────────────────

const COMPASS_DEG = {
  n: 0, north: 0, ne: 45, northeast: 45, e: 90, east: 90, se: 135, southeast: 135,
  s: 180, south: 180, sw: 225, southwest: 225, w: 270, west: 270, nw: 315, northwest: 315
}
const COMPASS_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function bearingName (deg) {
  const n = ((deg % 360) + 360) % 360
  return COMPASS_NAMES[Math.round(n / 45) % 8]
}

function yawToBearing (yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  return ((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360
}

function dirFor (bearingDeg, pitchDeg) {
  const b = bearingDeg * Math.PI / 180
  const p = pitchDeg * Math.PI / 180
  const cp = Math.cos(p)
  return [Math.sin(b) * cp, Math.sin(p), -Math.cos(b) * cp]
}

function resolveAim (bot, opts) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  if (opts.at && Number.isFinite(opts.at.x) && Number.isFinite(opts.at.y) && Number.isFinite(opts.at.z)) {
    const dx = opts.at.x + 0.5 - eye.x
    const dy = opts.at.y + 0.5 - eye.y
    const dz = opts.at.z + 0.5 - eye.z
    const horiz = Math.hypot(dx, dz) || 1e-6
    return {
      bearing: ((Math.atan2(dx, -dz) * 180 / Math.PI) + 360) % 360,
      pitch: Math.max(-75, Math.min(75, Math.atan2(dy, horiz) * 180 / Math.PI)),
      note: `aimed at ${Math.floor(opts.at.x)},${Math.floor(opts.at.y)},${Math.floor(opts.at.z)}`
    }
  }
  const d = typeof opts.direction === 'string' ? opts.direction.trim().toLowerCase() : ''
  const curBearing = yawToBearing(bot.entity.yaw || 0)
  const curPitch = Math.max(-75, Math.min(75, (bot.entity.pitch || 0) * 180 / Math.PI))
  if (!d || d === 'ahead' || d === 'forward') return { bearing: curBearing, pitch: curPitch }
  if (d === 'behind' || d === 'back') return { bearing: (curBearing + 180) % 360, pitch: 0 }
  if (d === 'left') return { bearing: (curBearing + 270) % 360, pitch: 0 }
  if (d === 'right') return { bearing: (curBearing + 90) % 360, pitch: 0 }
  if (d === 'up') return { bearing: curBearing, pitch: 65 }
  if (d === 'down') return { bearing: curBearing, pitch: -65 }
  if (d in COMPASS_DEG) return { bearing: COMPASS_DEG[d], pitch: 0 }
  return { bearing: curBearing, pitch: curPitch }
}

// ── Minecraft-proportioned blocky entity silhouettes & labels ─────────────

const ENTITY_STYLES = {
  player: { kind: 'humanoid', w: 0.62, h: 1.80, head: [214, 170, 138], hair: [72, 48, 30], shirt: [56, 168, 184], pants: [54, 72, 152], tag: [92, 232, 255] },
  zombie: { kind: 'humanoid', w: 0.62, h: 1.90, head: [88, 138, 68], hair: [62, 102, 48], shirt: [54, 148, 152], pants: [56, 62, 136], tag: [255, 92, 92] },
  husk: { kind: 'humanoid', w: 0.62, h: 1.90, head: [158, 142, 104], hair: [122, 108, 76], shirt: [134, 118, 86], pants: [98, 86, 62], tag: [255, 92, 92] },
  drowned: { kind: 'humanoid', w: 0.62, h: 1.90, head: [82, 144, 134], hair: [58, 110, 104], shirt: [68, 112, 106], pants: [54, 78, 82], tag: [255, 92, 92] },
  skeleton: { kind: 'humanoid', w: 0.56, h: 1.92, head: [212, 212, 208], hair: [188, 188, 184], shirt: [198, 198, 194], pants: [176, 176, 172], tag: [255, 92, 92] },
  creeper: { kind: 'creeper', w: 0.60, h: 1.70, body: [78, 172, 68], dark: [46, 122, 40], tag: [255, 92, 92] },
  enderman: { kind: 'humanoid', w: 0.60, h: 2.85, head: [26, 24, 30], hair: [22, 20, 26], shirt: [24, 22, 28], pants: [20, 18, 24], eyes: [224, 78, 248], tag: [255, 92, 92] },
  spider: { kind: 'spider', w: 1.35, h: 0.85, body: [56, 52, 58], eyes: [232, 34, 34], tag: [255, 92, 92] },
  villager: { kind: 'humanoid', w: 0.62, h: 1.95, head: [194, 148, 118], hair: [152, 112, 82], shirt: [132, 86, 56], pants: [94, 62, 40], tag: [142, 232, 152] },
  cow: { kind: 'quadruped', w: 0.92, h: 1.38, body: [110, 74, 48], spot: [226, 224, 218], head: [96, 64, 42], tag: [248, 228, 112] },
  pig: { kind: 'quadruped', w: 0.90, h: 0.92, body: [238, 166, 174], spot: [224, 146, 156], head: [242, 174, 182], tag: [248, 228, 112] },
  sheep: { kind: 'quadruped', w: 0.90, h: 1.30, body: [234, 230, 222], spot: [216, 212, 204], head: [188, 158, 134], tag: [248, 228, 112] },
  chicken: { kind: 'quadruped', w: 0.45, h: 0.72, body: [242, 242, 240], spot: [226, 226, 224], head: [246, 246, 244], tag: [248, 228, 112] },
  horse: { kind: 'quadruped', w: 1.25, h: 1.60, body: [138, 92, 54], spot: [96, 62, 36], head: [122, 80, 46], tag: [248, 228, 112] },
  wolf: { kind: 'quadruped', w: 0.65, h: 0.85, body: [198, 194, 188], spot: [148, 144, 138], head: [184, 180, 174], tag: [248, 228, 112] }
}

function styleForEntity (e, hostile) {
  if (e.type === 'player') return ENTITY_STYLES.player
  const key = String(e.name || e.type || '').toLowerCase()
  for (const [k, s] of Object.entries(ENTITY_STYLES)) {
    if (key.includes(k)) return hostile ? { ...s, tag: [255, 92, 92] } : s
  }
  return {
    kind: hostile ? 'humanoid' : 'quadruped',
    w: e.width || 0.7,
    h: e.height || 1.4,
    head: hostile ? [188, 72, 68] : [214, 186, 98],
    hair: hostile ? [136, 48, 46] : [178, 150, 74],
    shirt: hostile ? [164, 56, 56] : [196, 168, 84],
    pants: hostile ? [112, 42, 46] : [144, 122, 62],
    body: hostile ? [176, 62, 62] : [206, 178, 92],
    spot: [164, 138, 72],
    tag: hostile ? [255, 92, 92] : [248, 228, 112]
  }
}

function entityList (bot, eye, maxDist, isHostile) {
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue
    if (e.type !== 'player' && e.type !== 'mob' && e.type !== 'hostile' && e.type !== 'animal' && e.type !== 'passive') continue
    const name = e.type === 'player' ? (e.username || 'player') : (e.name || e.type || 'mob')
    const hostile = e.type !== 'player' && (isHostile ? isHostile(name) : e.type === 'hostile')
    const style = styleForEntity(e, hostile)
    const dist = Math.hypot(e.position.x - eye.x, e.position.y + style.h * 0.5 - eye.y, e.position.z - eye.z)
    if (dist < 0.8 || dist > maxDist) continue
    out.push({
      id: e.id,
      name,
      type: e.name || e.type,
      isPlayer: e.type === 'player',
      hostile,
      style,
      x: e.position.x,
      feetY: e.position.y,
      z: e.position.z,
      w: style.w,
      h: style.h,
      dist
    })
  }
  out.sort((a, b) => b.dist - a.dist)
  return out
}

function drawDepthRect (canvas, zbuf, x0, y0, x1, y1, dist, col, alpha = 1) {
  const ix0 = Math.max(0, Math.floor(x0))
  const iy0 = Math.max(0, Math.floor(y0))
  const ix1 = Math.min(canvas.w, Math.ceil(x1))
  const iy1 = Math.min(canvas.h, Math.ceil(y1))
  let drawn = 0
  for (let py = iy0; py < iy1; py++) {
    const row = py * canvas.w
    for (let px = ix0; px < ix1; px++) {
      if (dist <= zbuf[row + px] + 0.45) {
        if (alpha >= 1) canvas.set(px, py, col[0], col[1], col[2])
        else canvas.blend(px, py, col[0], col[1], col[2], alpha)
        drawn++
      }
    }
  }
  return drawn
}

function drawMinecraftEntity (canvas, zbuf, e, sx, yTop, yBot, bw, bh) {
  const s = e.style
  const xL = sx - bw / 2
  const xR = sx + bw / 2
  let vis = 0
  const eyeCol = s.eyes || [26, 26, 30]

  if (s.kind === 'humanoid') {
    // Head (top 26%), torso + arms (26%..66%), two legs (66%..100%)
    const headBot = yTop + bh * 0.26
    const torsoBot = yTop + bh * 0.66
    const headW = bw * 0.68
    vis += drawDepthRect(canvas, zbuf, sx - headW / 2, yTop, sx + headW / 2, headBot, e.dist, s.head)
    drawDepthRect(canvas, zbuf, sx - headW / 2, yTop, sx + headW / 2, yTop + (headBot - yTop) * 0.30, e.dist, s.hair)
    // Eyes
    if (bw >= 7) {
      const ey0 = yTop + (headBot - yTop) * 0.46
      const ey1 = yTop + (headBot - yTop) * 0.64
      drawDepthRect(canvas, zbuf, sx - headW * 0.28, ey0, sx - headW * 0.08, ey1, e.dist, eyeCol)
      drawDepthRect(canvas, zbuf, sx + headW * 0.08, ey0, sx + headW * 0.28, ey1, e.dist, eyeCol)
    }
    // Torso & arms
    vis += drawDepthRect(canvas, zbuf, xL, headBot, xR, torsoBot, e.dist, s.shirt)
    // Two legs with thin gap
    const legGap = Math.max(1, bw * 0.08)
    vis += drawDepthRect(canvas, zbuf, sx - bw * 0.36, torsoBot, sx - legGap / 2, yBot, e.dist, s.pants)
    vis += drawDepthRect(canvas, zbuf, sx + legGap / 2, torsoBot, sx + bw * 0.36, yBot, e.dist, s.pants)
  } else if (s.kind === 'creeper') {
    const headBot = yTop + bh * 0.30
    const bodyBot = yTop + bh * 0.78
    vis += drawDepthRect(canvas, zbuf, sx - bw * 0.42, yTop, sx + bw * 0.42, headBot, e.dist, s.body)
    vis += drawDepthRect(canvas, zbuf, sx - bw * 0.34, headBot, sx + bw * 0.34, bodyBot, e.dist, s.dark)
    vis += drawDepthRect(canvas, zbuf, sx - bw * 0.45, bodyBot, sx + bw * 0.45, yBot, e.dist, s.body)
    if (bw >= 8) {
      const ey0 = yTop + (headBot - yTop) * 0.28
      const ey1 = yTop + (headBot - yTop) * 0.52
      drawDepthRect(canvas, zbuf, sx - bw * 0.26, ey0, sx - bw * 0.06, ey1, e.dist, [20, 24, 20])
      drawDepthRect(canvas, zbuf, sx + bw * 0.06, ey0, sx + bw * 0.26, ey1, e.dist, [20, 24, 20])
      drawDepthRect(canvas, zbuf, sx - bw * 0.14, ey1, sx + bw * 0.14, yTop + (headBot - yTop) * 0.85, e.dist, [20, 24, 20])
    }
  } else if (s.kind === 'spider') {
    const bodyTop = yTop + bh * 0.25
    const bodyBot = yTop + bh * 0.78
    vis += drawDepthRect(canvas, zbuf, xL + bw * 0.15, bodyTop, xR - bw * 0.15, bodyBot, e.dist, s.body)
    // Legs splayed out
    vis += drawDepthRect(canvas, zbuf, xL, bodyTop + bh * 0.2, xL + bw * 0.16, yBot, e.dist, [34, 32, 36])
    vis += drawDepthRect(canvas, zbuf, xR - bw * 0.16, bodyTop + bh * 0.2, xR, yBot, e.dist, [34, 32, 36])
    if (bw >= 10) {
      drawDepthRect(canvas, zbuf, sx - bw * 0.14, bodyTop + bh * 0.15, sx - bw * 0.04, bodyTop + bh * 0.32, e.dist, s.eyes)
      drawDepthRect(canvas, zbuf, sx + bw * 0.04, bodyTop + bh * 0.15, sx + bw * 0.14, bodyTop + bh * 0.32, e.dist, s.eyes)
    }
  } else {
    // Quadruped (cow, pig, sheep, horse, wolf, chicken): head, chunky body with spot, 4 legs
    const bodyTop = yTop + bh * 0.22
    const bodyBot = yTop + bh * 0.70
    vis += drawDepthRect(canvas, zbuf, xL, bodyTop, xR, bodyBot, e.dist, s.body)
    if (s.spot) {
      drawDepthRect(canvas, zbuf, xL + bw * 0.18, bodyTop + bh * 0.08, xL + bw * 0.52, bodyTop + bh * 0.34, e.dist, s.spot)
    }
    // Head perched at top-center/front
    vis += drawDepthRect(canvas, zbuf, sx - bw * 0.30, yTop, sx + bw * 0.30, yTop + bh * 0.42, e.dist, s.head)
    if (bw >= 9) {
      drawDepthRect(canvas, zbuf, sx - bw * 0.18, yTop + bh * 0.14, sx - bw * 0.08, yTop + bh * 0.24, e.dist, eyeCol)
      drawDepthRect(canvas, zbuf, sx + bw * 0.08, yTop + bh * 0.14, sx + bw * 0.18, yTop + bh * 0.24, e.dist, eyeCol)
    }
    // Legs grounded squarely at yBot
    vis += drawDepthRect(canvas, zbuf, xL + bw * 0.08, bodyBot, xL + bw * 0.30, yBot, e.dist, s.head)
    vis += drawDepthRect(canvas, zbuf, xR - bw * 0.30, bodyBot, xR - bw * 0.08, yBot, e.dist, s.head)
  }

  return vis
}

// ── Perspective (`look`) & 360° (`panorama`) renderer ─────────────────────

function formatPoint (p) { return p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?' }

async function renderCamera (bot, opts) {
  const t0 = performance.now()
  const isPano = opts.view === 'panorama'
  const w = Math.max(160, Math.min(800, Math.trunc(opts.width || (isPano ? 720 : 512))))
  const h = Math.max(100, Math.min(480, Math.trunc(opts.height || (isPano ? 200 : 288))))
  const configuredMax = Math.max(24, Math.min(192, Math.trunc(opts.maxDist || 128)))

  const eye = bot.entity.position.offset(0, 1.62, 0)
  const pal = makePalette(bot)
  const sampler = new Sampler(bot, pal, eye.x, eye.z, configuredMax)
  const maxDist = sampler.maxDist
  const mats = pal.mats
  const sky = skyProfile(bot)
  const canvas = new Canvas(w, h)
  const zbuf = new Float32Array(w * h).fill(maxDist + 1)

  const aim = isPano ? { bearing: 0, pitch: 0 } : resolveAim(bot, opts)
  const fwd = dirFor(aim.bearing, aim.pitch)
  const rLen = Math.hypot(-fwd[2], fwd[0]) || 1
  const right = [-fwd[2] / rLen, 0, fwd[0] / rLen]
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0]
  ]
  const fovRad = (opts.fov || 86) * Math.PI / 180
  const halfW = Math.tan(fovRad / 2)
  const halfH = halfW * (h / w)
  const panoVert = 92 * Math.PI / 180

  const counts = new Map()
  let skyPx = 0
  let centerHit = null

  for (let py = 0; py < h; py++) {
    if (py > 0 && (py & 23) === 0) await new Promise((r) => setImmediate(r))
    const ny = 1 - 2 * (py + 0.5) / h
    const trackRow = (py & 3) === 0
    for (let px = 0; px < w; px++) {
      let dx, dy, dz
      if (isPano) {
        const az = ((px + 0.5) / w - 0.5) * Math.PI * 2
        const el = ny * (panoVert / 2)
        const ce = Math.cos(el)
        dx = Math.sin(az) * ce
        dy = Math.sin(el)
        dz = -Math.cos(az) * ce
      } else {
        const nx = 2 * (px + 0.5) / w - 1
        dx = fwd[0] + right[0] * nx * halfW + up[0] * ny * halfH
        dy = fwd[1] + right[1] * nx * halfW + up[1] * ny * halfH
        dz = fwd[2] + right[2] * nx * halfW + up[2] * ny * halfH
        const inv = 1 / Math.hypot(dx, dy, dz)
        dx *= inv; dy *= inv; dz *= inv
      }

      const hit = castRay(sampler, mats, eye.x, eye.y, eye.z, dx, dy, dz, maxDist, trackRow && (px & 3) === 0)
      const col = shadeHit(sampler, mats, hit, eye.x, eye.y, eye.z, dx, dy, dz, sky, maxDist)
      canvas.set(px, py, col[0], col[1], col[2])

      if (hit && !hit.sky) {
        zbuf[py * w + px] = hit.t
        const name = mats[hit.id].name
        counts.set(name, (counts.get(name) || 0) + 1)
        if (!isPano && px === (w >> 1) && py === (h >> 1)) centerHit = { name, x: hit.x, y: hit.y, z: hit.z, dist: hit.t }
      } else {
        skyPx++
      }
    }
  }

  // Draw the actual pending route as a depth-tested 3D polyline. Sampling in
  // world space naturally handles bends and the panorama's wraparound seam.
  const nav = opts.navigation
  const route = (nav?.path || []).slice(0, 256)
  const projectMarker = (point, color, size = 2) => {
    const vx = point.x - eye.x, vy = point.y - eye.y, vz = point.z - eye.z
    const dist = Math.hypot(vx, vy, vz)
    if (dist < 0.5 || dist > maxDist) return
    let sx, sy
    if (isPano) {
      sx = (Math.atan2(vx, -vz) / (2 * Math.PI) + 0.5) * w
      sy = (0.5 - Math.atan2(vy, Math.hypot(vx, vz)) / panoVert) * h
    } else {
      const tz = vx * fwd[0] + vy * fwd[1] + vz * fwd[2]
      if (tz <= 0) return
      sx = (1 + (vx * right[0] + vy * right[1] + vz * right[2]) / (tz * halfW)) * w / 2
      sy = (1 - (vx * up[0] + vy * up[1] + vz * up[2]) / (tz * halfH)) * h / 2
    }
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return
    drawDepthRect(canvas, zbuf, sx - size, sy - size, sx + size + 1, sy + size + 1, dist, color)
  }
  const asWorld = p => ({ x: p.x + 0.5, y: p.y + 0.15, z: p.z + 0.5 })
  const linePoints = [{ x: bot.entity.position.x, y: bot.entity.position.y + 0.15, z: bot.entity.position.z }, ...route.map(asWorld)]
  for (let i = 1; i < linePoints.length; i++) {
    const a = linePoints[i - 1], b = linePoints[i]
    const steps = Math.min(512, Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 10)))
    for (let j = 0; j <= steps; j++) {
      const t = j / steps
      projectMarker({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, [80, 220, 255], 1)
    }
  }
  if (route[0]) projectMarker(asWorld(route[0]), [255, 220, 70], 2)
  if (nav?.destination) projectMarker(asWorld(nav.destination), [255, 90, 80], 3)

  // Project grounded Minecraft-style entities with per-pixel depth occlusion
  const seenEnts = []
  for (const e of entityList(bot, eye, maxDist, opts.isHostile)) {
    const vx = e.x - eye.x
    const vz = e.z - eye.z
    let sx, yTop, yBot, bw, bh, side
    if (isPano) {
      const az = Math.atan2(vx, -vz)
      const horiz = Math.hypot(vx, vz) || 1e-6
      const elTop = Math.atan2(e.feetY + e.h - eye.y, horiz)
      const elBot = Math.atan2(e.feetY - eye.y, horiz)
      sx = ((az / (Math.PI * 2)) + 0.5) * w
      yTop = (0.5 - elTop / panoVert) * h
      yBot = (0.5 - elBot / panoVert) * h
      bh = Math.max(8, yBot - yTop)
      bw = Math.max(5, bh * (e.w / e.h))
      side = bearingName(((az * 180 / Math.PI) + 360) % 360)
    } else {
      const midY = e.feetY + e.h * 0.5 - eye.y
      const tz = vx * fwd[0] + midY * fwd[1] + vz * fwd[2]
      if (tz < 0.6) continue
      const tx = vx * right[0] + midY * right[1] + vz * right[2]
      const tyTop = vx * up[0] + (e.feetY + e.h - eye.y) * up[1] + vz * up[2]
      const tyBot = vx * up[0] + (e.feetY - eye.y) * up[1] + vz * up[2]
      const ndcX = tx / (tz * halfW)
      if (Math.abs(ndcX) > 1.08) continue
      sx = (ndcX + 1) * 0.5 * w
      yTop = (1 - tyTop / (tz * halfH)) * 0.5 * h
      yBot = (1 - tyBot / (tz * halfH)) * 0.5 * h
      if (yBot < 0 || yTop > h) continue
      bh = Math.max(8, yBot - yTop)
      bw = Math.max(5, (e.w / (tz * halfW)) * 0.5 * w)
      side = ndcX < -0.25 ? 'left' : ndcX > 0.25 ? 'right' : 'centre'
    }

    const vis = drawMinecraftEntity(canvas, zbuf, e, sx, yTop, yBot, bw, bh)
    if (vis < 6) continue

    const label = `${e.name.slice(0, 12)} ${e.hostile ? "HOSTILE " : ""}${Math.round(e.dist)}m`
    const lx = Math.max(2, Math.min(w - label.length * 6 - 3, Math.round(sx - label.length * 3)))
    const ly = Math.max(12, Math.round(yTop) - 10)
    canvas.text(lx, ly, label, e.style.tag, [12, 14, 18, 0.78])
    seenEnts.push({ ...e, side })
  }

  // Minimal non-intrusive HUD overlays (Minecraft crosshair + compact coordinates)
  const p = bot.entity.position.floored()
  if (isPano) {
    const marks = [
      [0.0, 'S', true], [0.125, 'SW', false], [0.25, 'W', true], [0.375, 'NW', false],
      [0.5, 'N', true], [0.625, 'NE', false], [0.75, 'E', true], [0.875, 'SE', false], [1.0, 'S', true]
    ]
    for (const [f, lab, major] of marks) {
      const mx = Math.min(w - 1, Math.round(f * (w - 1)))
      if (major && f > 0 && f < 1) {
        for (let py = 12; py < h; py++) canvas.blend(mx, py, 255, 255, 255, 0.22)
      }
      const lx = Math.max(2, Math.min(w - lab.length * 6 - 2, mx - Math.floor(lab.length * 3)))
      canvas.text(lx, 3, lab, major ? [255, 232, 118] : [210, 224, 240], [12, 18, 28, 0.78])
    }
    canvas.text(4, h - 10, `360 PANORAMA  X ${p.x} Y ${p.y} Z ${p.z}`, [242, 246, 250], [10, 14, 20, 0.72])
  } else {
    const cx = w >> 1, cy = h >> 1
    for (let d = -5; d <= 5; d++) {
      if (Math.abs(d) > 1) {
        canvas.set(cx + d, cy, 245, 245, 245)
        canvas.set(cx, cy + d, 245, 245, 245)
      }
    }
    const dirLabel = aim.note ? aim.note.toUpperCase() : `LOOKING ${bearingName(aim.bearing)}`
    canvas.text(4, 3, `${dirLabel}  X ${p.x} Y ${p.y} Z ${p.z}`, [245, 248, 252], [10, 14, 20, 0.72])
  }

  const biome = (() => { try { return bot.blockAt(bot.entity.position)?.biome?.name || 'unknown' } catch { return 'unknown' } })()
  const dimension = bot.game?.dimension || 'unknown'
  const hud = [
    `BOT ${p.x} ${p.y} ${p.z} ${bearingName(yawToBearing(bot.entity.yaw || 0))} ${dimension} ${biome}`,
    `HP ${bot.health ?? '?'} FOOD ${bot.food ?? '?'} GOAL ${opts.goal || 'none'}`,
    `ACTION ${opts.action || 'none'} NAV ${nav?.status || 'unknown'} ${nav?.progress || ''}`,
    `NEXT ${formatPoint(nav?.waypoint)} DEST ${formatPoint(nav?.destination)} ${nav?.resetReason || ''}`
  ]
  hud.forEach((line, i) => canvas.text(4, 14 + i * 9, line.slice(0, Math.max(1, Math.floor((w - 8) / 6))), [240, 245, 250], [10, 14, 20, 0.8]))

  const totalPx = w * h
  const topBlocks = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, n]) => `${name} ${Math.max(1, Math.round(n * 100 / totalPx))}%`)
  const skyPct = Math.round(skyPx * 100 / totalPx)
  const chunksInView = sampler.chunksTouched.size

  const lines = []
  if (isPano) {
    lines.push(`panorama from ${p.x},${p.y},${p.z} — full circle, NORTH in the middle, W left of it, E right, S at both edges; ${sky.label}`)
  } else {
    lines.push(`view from ${p.x},${p.y},${p.z} looking ${bearingName(aim.bearing)} (bearing ${Math.round(aim.bearing)}°, pitch ${Math.round(aim.pitch)}°, ${opts.fov || 86}° wide); ${sky.label}${aim.note ? `, ${aim.note}` : ''}`)
  }
  lines.push(`in frame: ${topBlocks.join(', ') || 'nothing solid'}; open sky/air ${skyPct}%`)
  if (centerHit) lines.push(`crosshair: ${centerHit.name} at ${centerHit.x},${centerHit.y},${centerHit.z} (${Math.round(centerHit.dist)}m)`)
  if (seenEnts.length) {
    const list = seenEnts.slice(0, 10).map((e) =>
      `${e.name} [id=${e.id}] ${Math.round(e.dist)}m ${e.side}${e.hostile ? ' HOSTILE' : e.isPlayer ? ' player' : ''}`
    )
    lines.push(`creatures in frame: ${list.join('; ')}`)
  }
  const chunkNote = sampler.chunksLoaded > 0
    ? `${chunksInView}/${sampler.chunksLoaded} loaded chunks in view, out to ${maxDist}m`
    : `out to ${maxDist}m`
  lines.push(`bot: ${hud.join('; ')}`)
  lines.push(`rendered directly from loaded block data (${chunkNote}, procedural block textures & lighting)`)

  const png = encodePng(canvas.rgb, w, h)
  const renderMs = Math.round(performance.now() - t0)
  return {
    png,
    width: w,
    height: h,
    bytes: png.length,
    renderMs,
    chunksLoaded: sampler.chunksLoaded,
    chunksInView,
    maxDist,
    bearing: Math.round(aim.bearing),
    pitch: Math.round(aim.pitch),
    pos: { x: p.x, y: p.y, z: p.z },
    entitiesSeen: seenEnts.length,
    summary: lines.join('\n'),
    view: isPano ? 'panorama' : 'look'
  }
}

// ── Top-down coordinate map renderer ──────────────────────────────────────

async function renderMap (bot, opts) {
  const t0 = performance.now()
  const radius = Math.max(12, Math.min(48, Math.trunc(opts.radius || 32)))
  const side = radius * 2 + 1
  const cell = Math.max(4, Math.min(8, Math.floor(384 / side)))
  const mapPx = side * cell
  const padL = 32, padT = 24, padR = 8, padB = 14
  const w = padL + mapPx + padR
  const h = padT + mapPx + padB

  const pos = bot.entity.position.floored()
  const pal = makePalette(bot)
  const sampler = new Sampler(bot, pal, pos.x, pos.z, radius + 16)
  const mats = pal.mats
  const canvas = new Canvas(w, h)
  canvas.rect(0, 0, w, h, [16, 20, 26])

  const yTopSearch = Math.min(sampler.globalMaxSolidY + 2, pos.y + 44)
  const yBotSearch = Math.max(sampler.globalMinSolidY - 1, pos.y - 32)
  const heights = new Int16Array(side * side).fill(-9999)
  const matIds = new Int16Array(side * side)
  const counts = new Map()
  let minY = Infinity, maxY = -Infinity

  for (let gz = 0; gz < side; gz++) {
    if (gz > 0 && (gz & 7) === 0) await new Promise((r) => setImmediate(r))
    const wz = pos.z - radius + gz
    for (let gx = 0; gx < side; gx++) {
      const wx = pos.x - radius + gx
      if (sampler.hasColumns) sampler.chunksTouched.add(chunkKey(wx >> 4, wz >> 4))
      for (let wy = yTopSearch; wy >= yBotSearch; wy--) {
        const id = sampler.at(wx, wy, wz)
        if (id > 0 && !mats[id].skip) {
          heights[gz * side + gx] = wy
          matIds[gz * side + gx] = id
          const name = mats[id].name
          counts.set(name, (counts.get(name) || 0) + 1)
          if (wy < minY) minY = wy
          if (wy > maxY) maxY = wy
          break
        }
      }
    }
  }

  for (let gz = 0; gz < side; gz++) {
    for (let gx = 0; gx < side; gx++) {
      const i = gz * side + gx
      const id = matIds[i]
      let r = 24, g = 28, b = 34
      if (id > 0) {
        const m = mats[id]
        const hy = heights[i]
        const northY = gz > 0 ? heights[i - side] : hy
        const westY = gx > 0 ? heights[i - 1] : hy
        const slope = (hy - northY) * 0.085 + (hy - westY) * 0.05
        const rel = Math.max(-0.22, Math.min(0.24, (hy - pos.y) * 0.02))
        const shade = Math.max(0.50, Math.min(1.30, 1 + rel + Math.max(-0.22, Math.min(0.22, slope))))
        const topTex = m.name ? getBlockTexture(m.name, 'top') : null
        if (topTex) {
          const x0 = padL + gx * cell
          const y0 = padT + gz * cell
          for (let py = 0; py < cell; py++) {
            const tv = Math.min(15, Math.floor((py * 16) / cell))
            for (let px = 0; px < cell; px++) {
              const tu = Math.min(15, Math.floor((px * 16) / cell))
              const ti = (tv * 16 + tu) * 4
              const tr = topTex[ti + 3] >= 16 ? topTex[ti] : m.rgb[0]
              const tg = topTex[ti + 3] >= 16 ? topTex[ti + 1] : m.rgb[1]
              const tb = topTex[ti + 3] >= 16 ? topTex[ti + 2] : m.rgb[2]
              canvas.set(x0 + px, y0 + py, clampByte(tr * shade), clampByte(tg * shade), clampByte(tb * shade))
            }
          }
          continue
        }
        r = clampByte(m.rgb[0] * shade)
        g = clampByte(m.rgb[1] * shade)
        b = clampByte(m.rgb[2] * shade)
      }
      canvas.rect(padL + gx * cell, padT + gz * cell, cell, cell, [r, g, b])
    }
  }

  // Coordinate grid lines every 8 blocks
  const step = 8
  for (let wx = Math.ceil((pos.x - radius) / step) * step; wx <= pos.x + radius; wx += step) {
    const px = padL + Math.round((wx - (pos.x - radius) + 0.5) * cell)
    canvas.line(px, padT, px, padT + mapPx - 1, [255, 255, 255], 0.24)
    const lab = String(wx)
    canvas.text(Math.max(padL, Math.min(w - lab.length * 6 - 1, px - Math.floor(lab.length * 3))), 13, lab, [250, 224, 118])
  }
  for (let wz = Math.ceil((pos.z - radius) / step) * step; wz <= pos.z + radius; wz += step) {
    const py = padT + Math.round((wz - (pos.z - radius) + 0.5) * cell)
    canvas.line(padL, py, padL + mapPx - 1, py, [255, 255, 255], 0.24)
    canvas.text(2, Math.max(padT, Math.min(padT + mapPx - 8, py - 3)), String(wz), [132, 212, 252])
  }
  canvas.text(padL, 2, 'X (YELLOW) ACROSS   Z (BLUE) DOWN   NORTH IS UP', [224, 232, 240])
  canvas.text(padL, h - 10, `1 CELL = 1 BLOCK  GRID EVERY ${step}  SURFACE`, [186, 196, 208])

  // Remaining path in world X/Z, clipped to the map. Do not draw segments
  // outside the map: Canvas.line is not a clipping rasterizer.
  const navPoints = [bot.entity.position, ...(opts.navigation?.path || [])]
  const mapPoint = (p) => {
    if (!p || Math.abs(p.x - pos.x) > radius || Math.abs(p.z - pos.z) > radius) return null
    return [padL + Math.round((p.x - pos.x + radius + 0.5) * cell), padT + Math.round((p.z - pos.z + radius + 0.5) * cell)]
  }
  for (let i = 1; i < navPoints.length; i++) {
    const a = mapPoint(navPoints[i - 1]), b = mapPoint(navPoints[i])
    if (a && b) canvas.line(a[0], a[1], b[0], b[1], [80, 220, 255])
    if (b) canvas.rect(b[0] - 1, b[1] - 1, 3, 3, i === 1 ? [255, 220, 70] : [80, 220, 255])
  }
  const dest = mapPoint(opts.navigation?.destination)
  if (dest) canvas.rect(dest[0] - 3, dest[1] - 3, 7, 7, [255, 90, 80])

  // Entities on map
  const entsOnMap = []
  for (const e of entityList(bot, bot.entity.position, radius * 1.45, opts.isHostile)) {
    const dx = e.x - pos.x, dz = e.z - pos.z
    if (Math.abs(dx) > radius || Math.abs(dz) > radius) continue
    const px = padL + Math.round((dx + radius + 0.5) * cell)
    const py = padT + Math.round((dz + radius + 0.5) * cell)
    const col = e.style.tag
    canvas.rect(px - 2, py - 2, 5, 5, col)
    canvas.outline(px - 3, py - 3, 7, 7, [0, 0, 0])
    const lab = e.name.slice(0, 10)
    canvas.text(Math.max(padL, Math.min(padL + mapPx - lab.length * 6, px + 4)), Math.max(padT, py - 3), lab, col, [10, 14, 20, 0.80])
    entsOnMap.push(e)
  }

  // Bot position & facing arrow
  const bx = padL + Math.round((radius + 0.5) * cell)
  const bz = padT + Math.round((radius + 0.5) * cell)
  const fwd = dirFor(yawToBearing(bot.entity.yaw || 0), 0)
  canvas.line(bx, bz, Math.round(bx + fwd[0] * cell * 2.5), Math.round(bz + fwd[2] * cell * 2.5), [255, 255, 255])
  canvas.rect(bx - 3, bz - 3, 7, 7, [255, 255, 255])
  canvas.outline(bx - 4, bz - 4, 9, 9, [0, 0, 0])
  canvas.text(bx + 6, bz + 3, 'YOU', [255, 255, 255], [10, 14, 20, 0.82])

  const total = side * side
  const topGround = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, n]) => `${name} ${Math.max(1, Math.round(n * 100 / total))}%`)
  const chunksInView = sampler.chunksTouched.size

  const lines = [
    `map centred on you at ${pos.x},${pos.y},${pos.z}: ${side}x${side} blocks (x ${pos.x - radius}..${pos.x + radius}, z ${pos.z - radius}..${pos.z + radius}), north up, grid line every ${step} blocks labelled with world x (top, yellow) and z (left, blue)`
  ]
  if (Number.isFinite(minY)) lines.push(`surface heights y ${minY}..${maxY} (lighter = higher than you, darker = lower)`)
  lines.push(`ground: ${topGround.join(', ') || 'unloaded'}`)
  if (entsOnMap.length) {
    lines.push(`creatures: ${entsOnMap.slice(0, 10).map((e) =>
      `${e.name} [id=${e.id}] at ${Math.floor(e.x)},${Math.floor(e.feetY)},${Math.floor(e.z)}${e.hostile ? ' HOSTILE' : e.isPlayer ? ' player' : ''}`
    ).join('; ')}`)
  }
  lines.push(`you = white square, the white line shows your facing (${chunksInView}/${sampler.chunksLoaded} loaded chunks sampled)`)

  const png = encodePng(canvas.rgb, w, h)
  const renderMs = Math.round(performance.now() - t0)
  return {
    png,
    width: w,
    height: h,
    bytes: png.length,
    renderMs,
    chunksLoaded: sampler.chunksLoaded,
    chunksInView,
    maxDist: radius,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    entitiesSeen: entsOnMap.length,
    summary: lines.join('\n'),
    view: 'map'
  }
}

// ── Public entry point ────────────────────────────────────────────────────

async function screenshot (bot, opts = {}) {
  if (!bot?.entity?.position) throw new Error('bot is not spawned yet')
  const view = String(opts.view || 'look').trim().toLowerCase()
  if (view === 'map' || view === 'top' || view === 'overhead') return renderMap(bot, opts)
  if (view === 'panorama' || view === 'pano' || view === '360' || view === 'around') return renderCamera(bot, { ...opts, view: 'panorama' })
  return renderCamera(bot, { ...opts, view: 'look' })
}

module.exports = { screenshot, encodePng, _internal: { materialFor, sampleBlockTexture, skyProfile } }
