/**
 * zincai/native/boxGeometry.js — the client's cuboid unwrap.
 *
 * Vanilla entity/block-entity models are built from cuboids whose six faces are
 * laid out on a texture sheet by `ModelPart.Cube`:
 *
 *   width  = 2*depth + 2*width          height = depth + height
 *   down   = (u+d,        v    ) x (w,   d)
 *   up     = (u+d+w,      v    ) x (w,   d)
 *   west   = (u,          v+d  ) x (d,   h)
 *   north  = (u+d,        v+d  ) x (w,   h)
 *   east   = (u+d+2w,     v+d  ) x (d,   h)
 *   south  = (u+d+2w+d,   v+d  ) x (d,   h)
 *
 * This table is the one the renderer has always used for entity cubes (it
 * matches prismarine-viewer's client model mapping), factored out here so block
 * entity renderers, item special renderers and mob models all share one
 * implementation of the client's UV layout instead of three variants.
 */
'use strict'

// Corner + UV basis per face. `corners` entries are
// [xBit, yBit, zBit, uBit, vBit] and the uv basis vectors are dotted with the
// cube size, exactly like the client's cube builder.
const FACES = {
  up: {
    dir: [0, 1, 0],
    u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1],
    corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]]
  },
  down: {
    dir: [0, -1, 0],
    u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1],
    corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]]
  },
  east: {
    dir: [1, 0, 0],
    u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1],
    corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]]
  },
  west: {
    dir: [-1, 0, 0],
    u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1],
    corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]]
  },
  north: {
    dir: [0, 0, -1],
    u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 1],
    corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]]
  },
  south: {
    dir: [0, 0, 1],
    u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1],
    corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]]
  }
}

const FACE_KEYS = ['up', 'down', 'east', 'west', 'north', 'south']

function dot (vec, size) {
  return vec[0] * size[0] + vec[1] * size[1] + vec[2] * size[2]
}

function rotatePoint (p, axis, angleDeg, origin = [0, 0, 0]) {
  const angle = (angleDeg || 0) * Math.PI / 180
  if (!angle) return [p[0], p[1], p[2]]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const x = p[0] - origin[0]
  const y = p[1] - origin[1]
  const z = p[2] - origin[2]
  if (axis === 'x') return [x + origin[0], y * c - z * s + origin[1], y * s + z * c + origin[2]]
  if (axis === 'z') return [x * c - y * s + origin[0], x * s + y * c + origin[1], z + origin[2]]
  return [x * c + z * s + origin[0], y + origin[1], -x * s + z * c + origin[2]]
}

function rotateDir (d, axis, angleDeg) {
  return rotatePoint(d, axis, angleDeg, [0, 0, 0])
}

/**
 * Build the six quads of one client cuboid.
 *
 * @param {object} cube
 * @param {number[]} cube.origin   model-space origin in 1/16 block units
 *                                 (x/z relative to the block/entity centre)
 * @param {number[]} cube.size     size in 1/16 block units
 * @param {number[]} cube.uv       texture offset in pixels
 * @param {number} [cube.inflate]  per-face outward inflation in 1/16 units
 * @param {object} [cube.rotation] { axis, angle, origin } in model units
 * @param {object} cube.tex        Texture with width/height/rgba
 * @param {number} [cube.texW]     sheet width (defaults to the real texture)
 * @param {number} [cube.texH]     sheet height (defaults to the real texture)
 * @param {object} [opts]
 * @param {string} [opts.layer]    render layer ('opaque' | 'cutout' | 'translucent')
 * @param {boolean} [opts.shade]   apply vanilla directional face shading
 * @param {number} [opts.tintindex]
 * @param {boolean} [opts.noShadeUv] use a single flat UV for every face
 * @param {object} [opts.faceUv]   explicit per-face [u0,v0,u1,v1] in pixels
 * @param {string[]} [opts.only]   restrict to these faces
 * @param {string[]} [opts.skip]   drop these faces
 * @param {function} [opts.mapPosition] extra model→world point mapping
 * @returns {Array} quads in block units (1 unit = 1 block)
 */
function cubeQuads (cube, opts = {}) {
  const [ox, oy, oz] = cube.origin
  const [sx, sy, sz] = cube.size
  const inflate = cube.inflate || 0
  const tex = cube.tex
  const texW = cube.texW || tex?.width || 64
  const texH = cube.texH || tex?.height || 64
  const layer = opts.layer || 'cutout'
  const out = []
  const only = opts.only ? new Set(opts.only) : null
  const skip = opts.skip ? new Set(opts.skip) : null
  for (const side of FACE_KEYS) {
    if (only && !only.has(side)) continue
    if (skip && skip.has(side)) continue
    const f = FACES[side]
    const positions = []
    const uvs = []
    for (const c of f.corners) {
      let p = [
        ox + c[0] * sx + (c[0] ? inflate : -inflate),
        oy + c[1] * sy + (c[1] ? inflate : -inflate),
        oz + c[2] * sz + (c[2] ? inflate : -inflate)
      ]
      if (cube.rotation) p = rotatePoint(p, cube.rotation.axis, cube.rotation.angle, cube.rotation.origin || [0, 0, 0])
      if (opts.mapPosition) p = opts.mapPosition(p)
      positions.push([p[0] / 16, p[1] / 16, p[2] / 16])
      // `mirrorU` implements the client's CubeListBuilder.mirror(): the face's
      // u basis is swapped, which is how one arm/leg texture serves both sides.
      const uBit = opts.mirrorU ? !c[3] : Boolean(c[3])
      if (opts.faceUv) {
        const [u0, v0, u1, v1] = opts.faceUv[side] || opts.faceUv.all || [0, 0, texW, texH]
        uvs.push([(uBit ? u1 : u0) / texW, (c[4] ? v1 : v0) / texH])
      } else {
        const u = (cube.uv[0] + (uBit ? dot(f.u1, cube.size) : dot(f.u0, cube.size))) / texW
        const v = (cube.uv[1] + (c[4] ? dot(f.v1, cube.size) : dot(f.v0, cube.size))) / texH
        uvs.push([u, v])
      }
    }
    let normal = f.dir
    if (opts.mirrorU) normal = [-normal[0], normal[1], normal[2]]
    if (cube.rotation) normal = rotateDir(normal, cube.rotation.axis, cube.rotation.angle)
    out.push({
      pos: positions,
      uv: uvs,
      normal,
      shadeDir: normal[1] > 0.5 ? 'up' : normal[1] < -0.5 ? 'down' : Math.abs(normal[2]) > 0.5 ? (normal[2] > 0 ? 'south' : 'north') : (normal[0] > 0 ? 'east' : 'west'),
      shade: opts.shade !== false,
      cullface: null,
      tintindex: opts.tintindex ?? -1,
      layer,
      tex,
      texName: tex?.name || 'missing',
      boxFace: side,
      specialGeometry: true
    })
  }
  return out
}

/** Rotate a quad set around an axis (degrees) with optional translation. */
function transformQuads (quads, { axis = null, angle = 0, origin = [0, 0, 0], translate = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  return quads.map((q) => {
    const pos = q.pos.map((p) => {
      let v = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]]
      if (axis && angle) v = rotatePoint(v, axis, angle, origin)
      return [v[0] + translate[0], v[1] + translate[1], v[2] + translate[2]]
    })
    const n = axis && angle ? rotateDir(q.normal, axis, angle) : q.normal
    return {
      ...q,
      pos,
      normal: n,
      shadeDir: n[1] > 0.5 ? 'up' : n[1] < -0.5 ? 'down' : Math.abs(n[2]) > 0.5 ? (n[2] > 0 ? 'south' : 'north') : (n[0] > 0 ? 'east' : 'west')
    }
  })
}

module.exports = { FACES, FACE_KEYS, cubeQuads, rotatePoint, rotateDir, transformQuads }
