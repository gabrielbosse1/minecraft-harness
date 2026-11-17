/**
 * zincai/native/png.js — dependency-free PNG decoder for real Minecraft
 * resource-pack textures.
 *
 * Unlike the old 16x16-only helper this decodes the full image (all vanilla
 * block/entity skins are 16..128 px, animated textures are vertical strips
 * 16 x (16 * frames)), preserves the alpha channel exactly, and exposes the
 * `.mcmeta` animation descriptor so the renderer can advance animation frames
 * exactly like the client does.
 */
'use strict'

const zlib = require('node:zlib')

function paeth (a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Decode a PNG Buffer into { width, height, rgba } (RGBA8, straight alpha).
 * Supports bit depth 8/16, colour types 0/2/3/4/6 and tRNS. Returns null on
 * malformed input instead of throwing, so a broken resource-pack file cannot
 * take down the renderer.
 */
function decodePng (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null
  if (buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) return null

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette = null
  let trns = null
  const idat = []

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const start = pos + 8
    const end = start + len
    if (end > buf.length) break
    if (type === 'IHDR') {
      width = buf.readUInt32BE(start)
      height = buf.readUInt32BE(start + 4)
      bitDepth = buf[start + 8]
      colorType = buf[start + 9]
      interlace = buf[start + 12]
    } else if (type === 'PLTE') {
      palette = buf.subarray(start, end)
    } else if (type === 'tRNS') {
      trns = buf.subarray(start, end)
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    pos = end + 4
  }

  if (!width || !height || !idat.length) return null
  if (interlace) return null // vanilla textures are not interlaced
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return null

  const channels = colorType === 6 ? 4
    : colorType === 2 ? 3
      : colorType === 4 ? 2
        : colorType === 3 ? 1
          : colorType === 0 ? 1 : 0
  if (!channels) return null

  let inflated
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }

  const bitsPerPixel = channels * bitDepth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const raw = Buffer.allocUnsafe(stride * height)

  let offset = 0
  for (let y = 0; y < height; y++) {
    if (offset >= inflated.length) return null
    const filter = inflated[offset++]
    const row = y * stride
    const prev = (y - 1) * stride
    for (let x = 0; x < stride; x++) {
      const val = inflated[offset + x]
      if (val === undefined) return null
      const a = x >= bpp ? raw[row + x - bpp] : 0
      const b = y > 0 ? raw[prev + x] : 0
      const c = (x >= bpp && y > 0) ? raw[prev + x - bpp] : 0
      let out = val
      if (filter === 1) out = (val + a) & 0xff
      else if (filter === 2) out = (val + b) & 0xff
      else if (filter === 3) out = (val + ((a + b) >> 1)) & 0xff
      else if (filter === 4) out = (val + paeth(a, b, c)) & 0xff
      else if (filter !== 0) return null
      raw[row + x] = out
    }
    offset += stride
  }

  const rgba = new Uint8Array(width * height * 4)
  const maxVal = (1 << bitDepth) - 1

  // Raw sample value at the PNG's native bit depth (palette indices stay 0..15
  // for 4-bit palette images instead of being rescaled to 0..255).
  const readRaw = (rowStart, index) => {
    if (bitDepth === 8) return raw[rowStart + index]
    if (bitDepth === 16) return raw[rowStart + index * 2] // high byte ≈ 8-bit
    const bit = index * bitDepth
    const byte = raw[rowStart + (bit >> 3)]
    const shift = 8 - bitDepth - (bit & 7)
    return (byte >> shift) & maxVal
  }

  const readSample = (rowStart, index) => {
    const v = readRaw(rowStart, index)
    if (bitDepth === 8) return v
    if (bitDepth === 16) return v
    return Math.round((v * 255) / maxVal)
  }

  for (let y = 0; y < height; y++) {
    const row = y * stride
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4
      if (colorType === 6) {
        const si = bitDepth === 16 ? x * 8 : x * 4
        rgba[di] = raw[row + si]
        rgba[di + 1] = raw[row + si + (bitDepth === 16 ? 2 : 1)]
        rgba[di + 2] = raw[row + si + (bitDepth === 16 ? 4 : 2)]
        rgba[di + 3] = raw[row + si + (bitDepth === 16 ? 6 : 3)]
      } else if (colorType === 2) {
        const si = bitDepth === 16 ? x * 6 : x * 3
        rgba[di] = raw[row + si]
        rgba[di + 1] = raw[row + si + (bitDepth === 16 ? 2 : 1)]
        rgba[di + 2] = raw[row + si + (bitDepth === 16 ? 4 : 2)]
        rgba[di + 3] = 255
      } else if (colorType === 4) {
        const v = readSample(row, x * 2)
        const a = readSample(row, x * 2 + 1)
        rgba[di] = rgba[di + 1] = rgba[di + 2] = v
        rgba[di + 3] = a
      } else if (colorType === 0) {
        const v = readSample(row, x)
        rgba[di] = rgba[di + 1] = rgba[di + 2] = v
        rgba[di + 3] = 255
      } else if (colorType === 3 && palette) {
        const index = readRaw(row, x)
        const pi = index * 3
        rgba[di] = palette[pi] ?? 0
        rgba[di + 1] = palette[pi + 1] ?? 0
        rgba[di + 2] = palette[pi + 2] ?? 0
        rgba[di + 3] = trns && index < trns.length ? trns[index] : 255
      }
    }
  }

  return { width, height, rgba }
}

/**
 * Parse a vanilla `.mcmeta` animation descriptor.
 *   { animation: { frametime: 2, frames: [0,1,2,1], interpolate: false } }
 */
function decodeMcmeta (buf) {
  if (!buf) return null
  try {
    const json = JSON.parse(buf.toString('utf8'))
    const anim = json?.animation
    if (!anim) return null
    return {
      frametime: Number.isFinite(anim.frametime) ? anim.frametime : 1,
      interpolate: Boolean(anim.interpolate),
      frames: Array.isArray(anim.frames)
        ? anim.frames.map((f) => (typeof f === 'object' ? Number(f.index) || 0 : Number(f) || 0))
        : null
    }
  } catch {
    return null
  }
}

module.exports = { decodePng, decodeMcmeta }
