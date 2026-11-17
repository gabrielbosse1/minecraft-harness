#!/usr/bin/env node
/**
 * scripts/build-native-data.js — regenerate the vendored, version-tagged
 * Minecraft asset metadata used as a fallback by the native renderer.
 *
 * The renderer always prefers the live client resources (official jar,
 * `.minecraft/assets` object store, prismarine-viewer's extracted client
 * resources, or a resource pack). These vendored files only cover what those
 * sources cannot provide when no jar is configured:
 *
 *   - `assets/<ns>/items/<id>.json`   item model definitions (1.21.4+):
 *     model type dispatch, tints, special renderers, trim cases.
 *   - `assets/<ns>/equipment/<id>.json` equipment (armour) layer definitions.
 *
 * Source tree: the `misode/mcmeta` asset tag that matches a Minecraft version
 * (`<version>-assets`). That repository is generated directly from the
 * official client jar, so the JSON is byte-identical to the shipped data.
 *
 * Usage:
 *   git clone --depth 1 --filter=blob:none --sparse \
 *     --branch 1.21.4-assets https://github.com/misode/mcmeta.git /tmp/mcmeta
 *   git -C /tmp/mcmeta sparse-checkout set assets/minecraft/items \
 *     assets/minecraft/equipment
 *   node scripts/build-native-data.js /tmp/mcmeta 1.21.4
 *
 * The output is metadata (model references, colours, layer names), not art:
 * textures and models continue to be read from the client resources.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function readDir (dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function collect (dir) {
  const out = {}
  for (const file of readDir(dir)) {
    try {
      out[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch (err) {
      console.warn(`[native-data] skipping ${file}: ${err.message}`)
    }
  }
  return out
}

function main () {
  const root = process.argv[2] || process.env.MCMETA_DIR
  const version = process.argv[3] || process.env.MC_VERSION || '1.21.4'
  if (!root) {
    console.error('usage: node scripts/build-native-data.js <mcmeta-checkout> [version]')
    process.exit(2)
  }
  const assets = path.join(root, 'assets', 'minecraft')
  const defs = collect(path.join(assets, 'items'))
  const equipment = collect(path.join(assets, 'equipment'))
  if (!Object.keys(defs).length) {
    console.error(`[native-data] no item definitions under ${path.join(assets, 'items')}`)
    process.exit(1)
  }

  const outDir = path.join(__dirname, '..', 'zincai', 'native')
  const write = (name, payload) => {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, JSON.stringify(payload))
    const kb = Math.round(fs.statSync(file).size / 1024)
    console.log(`[native-data] ${name}: ${Object.keys(payload.definitions || payload.equipment || {}).length} entries, ${kb} KB`)
  }

  write(`item-definitions-${version}.json`, {
    _meta: {
      version,
      source: `misode/mcmeta ${version}-assets (assets/minecraft/items)`,
      license: 'Generated from Mojang client resources; shipped as metadata fallback for local rendering only'
    },
    definitions: defs
  })

  if (Object.keys(equipment).length) {
    write(`equipment-${version}.json`, {
      _meta: {
        version,
        source: `misode/mcmeta ${version}-assets (assets/minecraft/equipment)`,
        license: 'Generated from Mojang client resources; shipped as metadata fallback for local rendering only'
      },
      equipment
    })
  }
}

main()
