/**
 * zincai/textures.js — Pure-JS loader for actual Minecraft 16x16 block textures
 * shipped in `node_modules/prismarine-viewer/public/textures/1.21.4/blocks/`.
 *
 * Zero external dependencies: uses `node:fs`, `node:path`, and `node:zlib`.
 * Decodes PNGs (RGBA, RGB, Grayscale, Grayscale+Alpha, Indexed/PLTE) into
 * 16x16 RGBA Uint8Arrays, applies Minecraft biome tinting for grayscale
 * foliage/grass/water textures, and caches results in memory.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const TEXTURE_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  'prismarine-viewer',
  'public',
  'textures',
  '1.21.4',
  'blocks'
)

const HAS_TEXTURES = fs.existsSync(TEXTURE_DIR)

// ── Minimal PNG decoder ────────────────────────────────────────────────────

function paethPredictor (a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function decodePng (buf) {
  if (buf.length < 8 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    return null
  }
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette = null
  let trns = null
  const idatChunks = []

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const dataStart = pos + 8
    const dataEnd = dataStart + len
    if (dataEnd > buf.length) break

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart)
      height = buf.readUInt32BE(dataStart + 4)
      bitDepth = buf[dataStart + 8]
      colorType = buf[dataStart + 9]
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataEnd)
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    pos = dataEnd + 4 // skip CRC
  }

  if (!width || !height || bitDepth !== 8 || idatChunks.length === 0) return null

  const bpp =
    colorType === 6 ? 4 :
    colorType === 2 ? 3 :
    colorType === 4 ? 2 :
    (colorType === 0 || colorType === 3) ? 1 : 0
  if (!bpp) return null

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks))
  const stride = width * bpp
  const raw = new Uint8Array(height * stride)

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]
    const inRow = y * (stride + 1) + 1
    const outRow = y * stride
    const prevRow = (y - 1) * stride

    for (let x = 0; x < stride; x++) {
      const val = inflated[inRow + x]
      const a = x >= bpp ? raw[outRow + x - bpp] : 0
      const b = y > 0 ? raw[prevRow + x] : 0
      const c = (x >= bpp && y > 0) ? raw[prevRow + x - bpp] : 0
      let recon = val
      if (filter === 1) recon = (val + a) & 0xff
      else if (filter === 2) recon = (val + b) & 0xff
      else if (filter === 3) recon = (val + ((a + b) >> 1)) & 0xff
      else if (filter === 4) recon = (val + paethPredictor(a, b, c)) & 0xff
      raw[outRow + x] = recon
    }
  }

  // Extract top 16x16 (animated MC textures are vertical strips 16xN)
  const outW = Math.min(16, width)
  const outH = Math.min(16, height)
  const rgba = new Uint8Array(16 * 16 * 4)

  for (let y = 0; y < 16; y++) {
    const sy = Math.min(outH - 1, Math.floor((y * outH) / 16))
    for (let x = 0; x < 16; x++) {
      const sx = Math.min(outW - 1, Math.floor((x * outW) / 16))
      const di = (y * 16 + x) * 4
      const si = sy * stride + sx * bpp

      if (colorType === 6) {
        rgba[di] = raw[si]
        rgba[di + 1] = raw[si + 1]
        rgba[di + 2] = raw[si + 2]
        rgba[di + 3] = raw[si + 3]
      } else if (colorType === 2) {
        rgba[di] = raw[si]
        rgba[di + 1] = raw[si + 1]
        rgba[di + 2] = raw[si + 2]
        rgba[di + 3] = 255
      } else if (colorType === 4) {
        rgba[di] = raw[si]
        rgba[di + 1] = raw[si]
        rgba[di + 2] = raw[si]
        rgba[di + 3] = raw[si + 1]
      } else if (colorType === 0) {
        rgba[di] = raw[si]
        rgba[di + 1] = raw[si]
        rgba[di + 2] = raw[si]
        rgba[di + 3] = 255
      } else if (colorType === 3 && palette) {
        const idx = raw[si]
        const pi = idx * 3
        rgba[di] = palette[pi] ?? 0
        rgba[di + 1] = palette[pi + 1] ?? 0
        rgba[di + 2] = palette[pi + 2] ?? 0
        rgba[di + 3] = (trns && idx < trns.length) ? trns[idx] : 255
      }
    }
  }

  return rgba
}

// ── Texture cache & Minecraft block-face resolution ────────────────────────

const fileCache = new Map() // filename -> Uint8Array(1024) | null
const faceCache = new Map() // `${blockName}:${face}` -> Uint8Array(1024) | null

function loadPngFile (filename) {
  if (!HAS_TEXTURES) return null
  if (fileCache.has(filename)) return fileCache.get(filename)
  const full = path.join(TEXTURE_DIR, filename)
  let decoded = null
  try {
    if (fs.existsSync(full)) {
      decoded = decodePng(fs.readFileSync(full))
    }
  } catch {
    decoded = null
  }
  fileCache.set(filename, decoded)
  return decoded
}

function tintRgba (src, tintRgb) {
  if (!src) return null
  const out = new Uint8Array(src.length)
  const tr = tintRgb[0] / 255
  const tg = tintRgb[1] / 255
  const tb = tintRgb[2] / 255
  for (let i = 0; i < src.length; i += 4) {
    out[i] = Math.min(255, Math.round(src[i] * tr))
    out[i + 1] = Math.min(255, Math.round(src[i + 1] * tg))
    out[i + 2] = Math.min(255, Math.round(src[i + 2] * tb))
    out[i + 3] = src[i + 3]
  }
  return out
}

const GRASS_TINT = [124, 189, 107]
const FOLIAGE_TINT = [106, 168, 79]
const SPRUCE_TINT = [97, 153, 97]
const BIRCH_TINT = [128, 167, 85]
const WATER_TINT = [63, 118, 228]

function candidateFiles (name, face) {
  const clean = name.startsWith('waxed_') ? name.slice(6) : name
  if (face === 'top') {
    return [`${clean}_top.png`, `${clean}_end.png`, `${clean}.png`]
  }
  if (face === 'bottom') {
    return [`${clean}_bottom.png`, `${clean}_top.png`, `${clean}_end.png`, `${clean}.png`]
  }
  return [`${clean}_side.png`, `${clean}_front.png`, `${clean}.png`]
}

/**
 * Get a 16x16 RGBA Uint8Array for `(blockName, face)` where face is
 * `'top' | 'bottom' | 'side'`, or `null` if no actual Minecraft texture
 * is available for that block.
 */
function getBlockTexture (blockName, face = 'side') {
  if (!HAS_TEXTURES || !blockName) return null
  const key = `${blockName}:${face}`
  if (faceCache.has(key)) return faceCache.get(key)

  let tex = null
  if (blockName === 'grass_block') {
    if (face === 'top') tex = tintRgba(loadPngFile('grass_block_top.png'), GRASS_TINT)
    else if (face === 'bottom') tex = loadPngFile('dirt.png')
    else tex = loadPngFile('grass_block_side.png')
  } else if (blockName === 'water' || blockName === 'flowing_water') {
    tex = tintRgba(loadPngFile('water_still.png'), WATER_TINT)
  } else if (blockName === 'lava' || blockName === 'flowing_lava') {
    tex = loadPngFile('lava_still.png')
  } else if (blockName === 'spruce_leaves') {
    tex = tintRgba(loadPngFile('spruce_leaves.png'), SPRUCE_TINT)
  } else if (blockName === 'birch_leaves') {
    tex = tintRgba(loadPngFile('birch_leaves.png'), BIRCH_TINT)
  } else if (blockName.endsWith('_leaves')) {
    tex = tintRgba(loadPngFile(`${blockName}.png`), FOLIAGE_TINT)
  } else if (blockName === 'crafting_table' && face === 'bottom') {
    tex = loadPngFile('oak_planks.png')
  } else if (blockName === 'snow_block') {
    tex = loadPngFile('snow.png')
  } else {
    for (const file of candidateFiles(blockName, face)) {
      const loaded = loadPngFile(file)
      if (loaded) { tex = loaded; break }
    }
  }

  faceCache.set(key, tex)
  return tex
}

module.exports = {
  HAS_TEXTURES,
  TEXTURE_DIR,
  decodePng,
  getBlockTexture
}
