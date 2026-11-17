/**
 * zincai/native/entityModels.js — real Minecraft entity geometry.
 *
 * Vanilla mob/player geometry lives in code (EntityModel layers), not in the
 * resource pack. Prismarine-viewer ships those exact model definitions as
 * `entities.json` (bones, pivots, cuboids, per-cube UV offsets, inflate,
 * overlay layers), which is what the client uses to build its meshes. We build
 * textured quads from that geometry with the client's cube UV mapping, so a
 * zombie is a zombie model, a cow is a cow model, and a player is the real
 * 64x64-skin player model (classic or slim) including hat/jacket/sleeves/pants
 * overlay bones.
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')

// Cube face corners and UV basis vectors — identical to the client model
// format (and prismarine-viewer's Entity.js).
const ELEM_FACES = {
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

const FACE_KEYS = Object.keys(ELEM_FACES)

function deg (v) { return (v || 0) * Math.PI / 180 }

function rotateX (p, a) {
  const c = Math.cos(a); const s = Math.sin(a)
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]
}
function rotateY (p, a) {
  const c = Math.cos(a); const s = Math.sin(a)
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]
}
function rotateZ (p, a) {
  const c = Math.cos(a); const s = Math.sin(a)
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]
}

function applyRotation (p, rot, pivot) {
  let q = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]]
  // Client bones apply Z, then Y, then X (THREE Euler order XYZ).
  if (rot[2]) q = rotateZ(q, deg(rot[2]))
  if (rot[1]) q = rotateY(q, deg(rot[1]))
  if (rot[0]) q = rotateX(q, deg(rot[0]))
  return [q[0] + pivot[0], q[1] + pivot[1], q[2] + pivot[2]]
}

function rotateDir (d, rot) {
  return applyRotation(d, rot, [0, 0, 0])
}

function uvDot (vec, size) {
  return vec[0] * size[0] + vec[1] * size[1] + vec[2] * size[2]
}

// ── Model catalogue ─────────────────────────────────────────────────────────

let cachedEntities = null

function loadEntityDefinitions () {
  if (cachedEntities) return cachedEntities
  const candidates = []
  if (process.env.ZINC_ENTITY_MODELS) candidates.push(process.env.ZINC_ENTITY_MODELS)
  try {
    candidates.push(require.resolve('prismarine-viewer/viewer/lib/entity/entities.json'))
  } catch { /* fall through */ }
  try {
    const pkg = require.resolve('prismarine-viewer/package.json')
    candidates.push(path.join(path.dirname(pkg), 'viewer', 'lib', 'entity', 'entities.json'))
  } catch { /* fall through */ }
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        cachedEntities = JSON.parse(fs.readFileSync(file, 'utf8'))
        return cachedEntities
      }
    } catch { /* try next */ }
  }
  cachedEntities = {}
  return cachedEntities
}

const ALIASES = {
  zombie_villager: 'zombie_villager',
  zombified_piglin: 'zombified_piglin',
  skeleton_horse: 'skeleton_horse',
  zombie_horse: 'zombie_horse',
  trader_llama: 'llama',
  wandering_trader: 'wandering_trader',
  mooshroom: 'mooshroom',
  mushroom_cow: 'mooshroom'
}

function modelKeyFor (name) {
  const clean = String(name || '').toLowerCase().replace(/^minecraft:/, '')
  if (ALIASES[clean]) return ALIASES[clean]
  return clean
}

/** Apply the slim (3px) arm variant to the client player model. */
function slimifyPlayer (geometry) {
  // Deep clone the bones we touch.
  const bones = geometry.bones.map((b) => ({ ...b, cubes: b.cubes ? b.cubes.map((c) => ({ ...c, origin: [...c.origin], size: [...c.size] })) : undefined }))
  for (const bone of bones) {
    if (bone.name === 'rightArm' || bone.name === 'rightSleeve') {
      for (const cube of bone.cubes || []) {
        cube.origin[0] = -7
        cube.size[0] = 3
      }
    }
    if (bone.name === 'leftArm' || bone.name === 'leftSleeve') {
      for (const cube of bone.cubes || []) {
        cube.origin[0] = 4
        cube.size[0] = 3
      }
    }
  }
  return { ...geometry, bones }
}

/**
 * Build a posed-ready entity model:
 *   { bones, quads, texture, modelName, height, width, geometry }
 * Quads live in block units (the 1/16 scale is applied here, feet at y=0,
 * model front -Z)
 * and carry the bone chain needed for animation.
 */
function buildEntityModel (name, {
  texture = null,
  slim = false,
  variant = null,
  capeTexture = null
} = {}) {
  const defs = loadEntityDefinitions()
  const key = modelKeyFor(name)
  const entry = defs[key]
  if (!entry) return null

  const geometryKey = variant && entry.geometry[variant] ? variant : 'default'
  let geometry = entry.geometry[geometryKey]
  if (!geometry) return null
  if (key === 'player' && slim) geometry = slimifyPlayer(geometry)

  const textureWidth = geometry.texturewidth || 64
  const textureHeight = geometry.textureheight || 64

  // Build bone chains root → bone.
  const boneByName = new Map()
  for (const b of geometry.bones) boneByName.set(b.name, b)
  const chainFor = (bone) => {
    const chain = []
    let cur = bone
    let depth = 0
    while (cur && depth++ < 32) {
      chain.unshift(cur)
      cur = cur.parent ? boneByName.get(cur.parent) : null
    }
    return chain.map((b) => ({
      name: b.name,
      pivot: b.pivot || [0, 0, 0],
      rotation: b.bind_pose_rotation || b.rotation || [0, 0, 0],
      staticRotation: b.bind_pose_rotation || b.rotation || [0, 0, 0]
    }))
  }

  const quads = []
  for (const bone of geometry.bones) {
    if (bone.neverRender || !bone.cubes) continue
    const chain = chainFor(bone)
    for (const cube of bone.cubes) {
      const size = cube.size
      const uv = cube.uv
      const inflate = cube.inflate || 0
      const cubeRotation = cube.rotation || null
      for (const side of FACE_KEYS) {
        const f = ELEM_FACES[side]
        const positions = []
        const uvs = []
        const uvsPx = []
        const positionsModel = []
        for (const c of f.corners) {
          let p = [
            cube.origin[0] + c[0] * size[0] + (c[0] ? inflate : -inflate),
            cube.origin[1] + c[1] * size[1] + (c[1] ? inflate : -inflate),
            cube.origin[2] + c[2] * size[2] + (c[2] ? inflate : -inflate)
          ]
          if (cubeRotation) p = applyRotation(p, cubeRotation.map((v) => -v), cube.pivot || [0, 0, 0])
          positionsModel.push(p)
          positions.push([p[0] / 16, p[1] / 16, p[2] / 16])
          const uvPx = [
            uv[0] + (c[3] ? uvDot(f.u1, size) : uvDot(f.u0, size)),
            uv[1] + (c[4] ? uvDot(f.v1, size) : uvDot(f.v0, size))
          ]
          uvs.push([uvPx[0] / textureWidth, uvPx[1] / textureHeight])
          uvsPx.push(uvPx)
        }
        quads.push({
          pos: positions,
          modelPos: positionsModel,
          uv: uvs,
          uvPx: uvsPx,
          normal: f.dir,
          shadeDir: side,
          chain,
          cubeRotation,
          bone: bone.name,
          side,
          inflate
        })
      }
    }
  }

  // Optional cape from the player's skin profile.
  if (capeTexture && defs[key]?.geometry?.cape) {
    const capeGeo = defs[key].geometry.cape
    const capeBones = new Map(capeGeo.bones.map((b) => [b.name, b]))
    for (const bone of capeGeo.bones) {
      if (bone.neverRender || !bone.cubes) continue
      const chain = []
      let cur = bone
      let depth = 0
      while (cur && depth++ < 16) { chain.unshift(cur); cur = cur.parent ? capeBones.get(cur.parent) : null }
      const chainOut = chain.map((b) => ({
        name: `cape:${b.name}`,
        pivot: b.pivot || [0, 0, 0],
        rotation: b.bind_pose_rotation || b.rotation || [0, 0, 0],
        staticRotation: b.bind_pose_rotation || b.rotation || [0, 0, 0]
      }))
      for (const cube of bone.cubes) {
        for (const side of FACE_KEYS) {
          const f = ELEM_FACES[side]
          const positions = []
          const uvs = []
          for (const c of f.corners) {
            const p = [
              cube.origin[0] + c[0] * cube.size[0],
              cube.origin[1] + c[1] * cube.size[1],
              cube.origin[2] + c[2] * cube.size[2]
            ]
            positions.push([p[0] / 16, p[1] / 16, p[2] / 16])
            uvs.push([
              (cube.uv[0] + (c[3] ? uvDot(f.u1, cube.size) : uvDot(f.u0, cube.size))) / (capeGeo.texturewidth || 64),
              (cube.uv[1] + (c[4] ? uvDot(f.v1, cube.size) : uvDot(f.v0, cube.size))) / (capeGeo.textureheight || 32)
            ])
          }
          quads.push({ pos: positions, uv: uvs, normal: f.dir, shadeDir: side, chain: chainOut, bone: `cape:${bone.name}`, side, cape: true })
        }
      }
    }
  }

  let height = 1.8
  let width = 0.6
  if (geometry.visible_bounds_height) height = geometry.visible_bounds_height
  if (geometry.visible_bounds_width) width = geometry.visible_bounds_width
  let minY = Infinity
  let maxY = -Infinity
  for (const q of quads) {
    const owner = q.chain[q.chain.length - 1]
    const bind = owner?.staticRotation || [0, 0, 0]
    for (const p0 of q.pos) {
      const p = (bind[0] || bind[1] || bind[2])
        ? applyRotation(p0, bind.map((v) => -v), owner.pivot.map((v) => v / 16))
        : p0
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
    }
  }
  if (Number.isFinite(minY)) { height = Math.max(0.2, maxY - minY); width = Math.max(0.4, width) }

  return {
    name: key,
    quads,
    texture,
    capeTexture,
    modelName: `${key}${variant ? `:${variant}` : ''}${slim ? ':slim' : ''}`,
    height,
    width,
    textureWidth,
    textureHeight
  }
}

/**
 * Pose quads (walk cycle, head look) and convert model units to world space.
 * Returns an array of world-space quads: { pos:[4 x Vec3], uv:[4 x [u,v]],
 * normal, tex, layer, bone, side }.
 */
function poseEntityModel (model, pose, xform) {
  const cy = Math.cos(xform.yaw || 0)
  const sy = Math.sin(xform.yaw || 0)
  // Model UVs are authored in texture pixels. Normalise them against the real
  // image, not the model's nominal size: 64x32 textures are often padded to
  // 64x64 (zombie) and some models omit their nominal size entirely (sheep).
  const texW = model.texture?.width || model.textureWidth || 64
  const texH = model.texture?.height || model.textureHeight || 64
  const out = []
  for (const quad of model.quads) {
    const positions = []
    const uvs = []
    const normals = []
    const owner = quad.chain[quad.chain.length - 1]
    const bind = owner?.staticRotation || [0, 0, 0]
    for (let i = 0; i < 4; i++) {
      let p = quad.pos[i].slice()
      // Bind pose: like the client, a cube is built in absolute model space and
      // rotated around its *own* bone pivot only. Ancestor bind rotations must
      // not move it (a cow's legs hang straight down even though its body bone
      // carries the 90° quadruped rotation).
      if (bind[0] || bind[1] || bind[2]) p = applyRotation(p, bind.map((v) => -v), owner.pivot.map((v) => v / 16))
      // Animation deltas accumulate down the chain.
      for (const bone of quad.chain) {
        const add = pose?.[bone.name]
        if (add && (add[0] || add[1] || add[2])) p = applyRotation(p, add.map((v) => v * 180 / Math.PI), bone.pivot.map((v) => v / 16))
      }
      if (quad.cape && pose?.cape) p = applyRotation(p, pose.cape, [0, 24 / 16, 3 / 16])
      // Model units → blocks (already /16), yaw around feet, world translate.
      const x = p[0] * cy + p[2] * sy + xform.x
      const z = -p[0] * sy + p[2] * cy + xform.z
      positions.push([x, p[1] + xform.y, z])
      const px = quad.uvPx?.[i]
      uvs.push(px ? [px[0] / texW, px[1] / texH] : quad.uv[i])
      let n = quad.normal
      if (bind[0] || bind[1] || bind[2]) n = rotateDir(n, bind.map((v) => -v))
      if (pose) {
        for (const bone of quad.chain) {
          const add = pose[bone.name]
          if (add) n = rotateDir(n, add.map((v) => v * 180 / Math.PI))
        }
      }
      normals.push([n[0] * cy + n[2] * sy, n[1], -n[0] * sy + n[2] * cy])
    }
    let nx = 0; let ny = 0; let nz = 0
    for (const n of normals) { nx += n[0]; ny += n[1]; nz += n[2] }
    const len = Math.hypot(nx, ny, nz) || 1
    out.push({
      ...quad,
      pos: positions,
      uv: uvs,
      normal: [nx / len, ny / len, nz / len],
      tex: quad.cape ? model.capeTexture : model.texture,
      layer: quad.cape
        ? 'cutout'
        : (model.texture?.hasSemiAlpha ? 'translucent' : 'cutout')
    })
  }
  return out
}

module.exports = {
  buildEntityModel,
  poseEntityModel,
  loadEntityDefinitions,
  modelKeyFor,
  ELEM_FACES
}
