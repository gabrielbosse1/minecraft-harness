#!/usr/bin/env node
/**
 * postinstall — makes Minecraft Java 26.3 usable with minecraft-data@3.119.0.
 *
 * WHY THIS EXISTS:
 *   minecraft-data 3.119.0 (latest on npm) ships pc data only up to 26.1.
 *   The 26.3 release data was generated upstream and lives in open PR
 *   PrismarineJS/minecraft-data#1345 (fork: suisarbre/minecraft-data@312f3ca,
 *   protocol version 777). We vendor those 23 JSON/YAML files in
 *   vendor/minecraft-data-26.3/ and copy them into the installed
 *   minecraft-data package, injecting a '26.3' entry into its generated
 *   data.js. See vendor/minecraft-data-26.3/VENDORED.md for provenance
 *   and SHA-256 hashes.
 *
 *   Once minecraft-data publishes pc/26.3 to npm, delete this script,
 *   the vendor folder, and the DATA_26_3 override (tracked as an issue).
 *
 * IDEMPOTENT: safe to run on every npm install / npm ci.
 * FAILS LOUDLY: if anything is missing, installation exits non-zero with a
 * precise message — a silently half-patched bot is worse than a red install.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const REPO = path.join(__dirname, '..')
const VENDOR_DIR = path.join(REPO, 'vendor', 'minecraft-data-26.3', 'pc-26.3')
const PKG_DIR = path.join(REPO, 'node_modules', 'minecraft-data')
const TARGET_DIR = path.join(PKG_DIR, 'minecraft-data', 'data', 'pc', '26.3')
const DATA_JS = path.join(PKG_DIR, 'data.js')
const DATA_PATHS = path.join(PKG_DIR, 'minecraft-data', 'data', 'dataPaths.json')

function die (msg) {
  console.error(`\n[apply-26.3-data] FATAL: ${msg}`)
  console.error('[apply-26.3-data] The bot cannot connect to a 26.3 server without this patch.')
  console.error('[apply-26.3-data] Fix the issue above or run: node scripts/apply-26.3-data.js')
  process.exit(1)
}

function info (msg) {
  console.log(`[apply-26.3-data] ${msg}`)
}

// ---------------------------------------------------------- 1. sanity input
if (!fs.existsSync(VENDOR_DIR)) die(`vendored data not found at ${VENDOR_DIR} (is the vendor/ folder committed?)`)
const vendorFiles = fs.readdirSync(VENDOR_DIR).filter((f) => /\.(json|yml)$/.test(f))
if (vendorFiles.length < 20) die(`suspiciously few vendored files (${vendorFiles.length}) in ${VENDOR_DIR}`)
if (!fs.existsSync(PKG_DIR)) die(`minecraft-data not installed at ${PKG_DIR} — run npm install first`)

// ------------------------------------------------- 2. copy 26.3 data folder
fs.rmSync(TARGET_DIR, { recursive: true, force: true })
fs.mkdirSync(TARGET_DIR, { recursive: true })
for (const f of vendorFiles) {
  fs.copyFileSync(path.join(VENDOR_DIR, f), path.join(TARGET_DIR, f))
}
info(`copied ${vendorFiles.length} vendored 26.3 files into node_modules/minecraft-data`)

// ------------------------------------------------- 2b. unblock mineflayer's version gate
// mineflayer refuses versions newer than its own testedVersions list:
//   if (versionData['>'](latestSupportedVersion) && versionData.version !== latestSupportedProtocolVersion)
//     throw new Error(...)
// 26.3's data (patched in by this script) is newer, so teach the gate about
// it — the exact thing the next mineflayer release will do. Idempotent.
function patchVersionGates () {
  const mineflayerVersionJs = path.join(REPO, 'node_modules', 'mineflayer', 'lib', 'version.js')
  try {
    let src = fs.readFileSync(mineflayerVersionJs, 'utf8')
    if (src.includes("'26.3'")) {
      info('mineflayer version gate already knows 26.3')
    } else {
      const anchored = src.replace("'26.1']", "'26.1', '26.3']")
      if (anchored === src) die('could not patch mineflayer lib/version.js — upstream layout changed')
      fs.writeFileSync(mineflayerVersionJs, anchored)
      info('patched mineflayer testedVersions: + 26.3 (latestSupportedVersion becomes 26.3)')
    }
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('[apply-26.3-data] warning: mineflayer not present, skipping version-gate patch')
    else throw err
  }

  const protocolVersionJs = path.join(REPO, 'node_modules', 'minecraft-protocol', 'src', 'version.js')
  try {
    let src = fs.readFileSync(protocolVersionJs, 'utf8')
    if (src.includes("'26.3'")) {
      info('minecraft-protocol supportedVersions already knows 26.3')
    } else {
      const anchored = src.replace("'26.1']", "'26.1', '26.3']")
      if (anchored === src) {
        console.warn('[apply-26.3-data] warning: minecraft-protocol version.js anchor not found — skipping')
      } else {
        fs.writeFileSync(protocolVersionJs, anchored)
        info('patched minecraft-protocol supportedVersions: + 26.3')
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('[apply-26.3-data] warning: minecraft-protocol not present, skipping')
    else throw err
  }

  // prismarine-chunk has no 26.3 entry; everything from 1.18 through 26.1
  // maps to the same modern chunk implementation, so 26.3 joins that mapping.
  const chunkJs = path.join(REPO, 'node_modules', 'prismarine-chunk', 'src', 'index.js')
  try {
    let src = fs.readFileSync(chunkJs, 'utf8')
    if (src.includes('26.3:')) {
      info('prismarine-chunk already knows 26.3')
    } else {
      const anchor = "    26.1: require('./pc/1.18/chunk')"
      const anchored = src.replace(anchor, anchor + ",\n    26.3: require('./pc/1.18/chunk')")
      if (anchored === src) die('could not patch prismarine-chunk — upstream layout changed')
      fs.writeFileSync(chunkJs, anchored)
      info('patched prismarine-chunk: pc 26.3 -> pc/1.18/chunk (modern chunk implementation)')
    }
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('[apply-26.3-data] warning: prismarine-chunk not present, skipping')
    else throw err
  }

  // prismarine-physics ships its own feature-version table with exact string
  // membership checks on majorVersion. Clone 26.1's support into 26.3.
  const physicsFeatures = path.join(REPO, 'node_modules', 'prismarine-physics', 'lib', 'features.json')
  try {
    let src = fs.readFileSync(physicsFeatures, 'utf8')
    if (src.includes('"26.3"')) {
      info('prismarine-physics features already know 26.3')
    } else {
      const anchored = src.split('"26.1"').join('"26.1", "26.3"')
      if (anchored === src) die('could not patch prismarine-physics features.json — upstream layout changed')
      fs.writeFileSync(physicsFeatures, anchored)
      info('patched prismarine-physics features.json: 26.1 feature support extended to 26.3')
    }
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('[apply-26.3-data] warning: prismarine-physics not present, skipping')
    else throw err
  }
}
/** Files that exist upstream but must point at a shared path, like 26.1 does. */
const SHARED_ALIAS = {
  // 26.3 PR ships the real loot tables — point at them.
  // (listed for clarity; they exist, so the generic branch handles them)
  // 26.3 has no mapIcons/windows of its own — reuse what 26.1 reuses:
  mapIcons: 'pc/1.20.2/mapIcons.json',
  windows: 'pc/1.16.1/windows.json'
}

function buildBlock () {
  const lines = ["    '26.3': {"]
  const files = vendorFiles.filter((f) => f.endsWith('.json'))
  for (const f of files.sort()) {
    const key = f.replace(/\.json$/, '')
    lines.push(`      get ${key} () { return require("./minecraft-data/data/pc/26.3/${f}") },`)
  }
  for (const [key, rel] of Object.entries(SHARED_ALIAS)) {
    if (!files.includes(`${key}.json`)) {
      lines.push(`      get ${key} () { return require("./minecraft-data/data/${rel}") },`)
    }
  }
  // proto.yml (getter-less path, same convention as other entries)
  if (vendorFiles.includes('proto.yml')) {
    lines.push("      proto: __dirname + '/minecraft-data/data/pc/26.3/proto.yml'")
  }
  lines.push('    }')
  return lines.join('\n')
}

const dataJs = fs.readFileSync(DATA_JS, 'utf8')
if (dataJs.includes("'26.3'")) {
  info("data.js already contains a '26.3' entry — skipping injection")
} else {
  // Anchor: the end of the '26.1' block is immediately before the pc map closes:
  //       proto: __dirname + '/minecraft-data/data/pc/latest/proto.yml'\n    }\n  },\n  'bedrock': {
  const anchor = "      proto: __dirname + '/minecraft-data/data/pc/latest/proto.yml'\n    }\n  },\n  'bedrock': {"
  const block = "      proto: __dirname + '/minecraft-data/data/pc/latest/proto.yml'\n    },\n" + buildBlock() + "\n  },\n  'bedrock': {"
  if (!dataJs.includes(anchor)) {
    die('could not find the 26.1 anchor in data.js — upstream layout changed; inspect node_modules/minecraft-data/data.js manually')
  }
  fs.writeFileSync(DATA_JS, dataJs.replace(anchor, block))
  info("injected '26.3' entry into data.js")
}

// --------------------------------------- 4. patch dataPaths.json (cosmetic)
try {
  const dp = JSON.parse(fs.readFileSync(DATA_PATHS, 'utf8'))
  if (dp.pc && !dp.pc['26.3']) {
    const base = dp.pc['26.1']
    if (base) {
      const entry = {}
      for (const [k, v] of Object.entries(base)) {
        entry[k] = v === 'pc/26.1' ? 'pc/26.3' : v
      }
      if (vendorFiles.includes('blockLoot.json')) entry.blockLoot = 'pc/26.3'
      if (vendorFiles.includes('entityLoot.json')) entry.entityLoot = 'pc/26.3'
      dp.pc['26.3'] = entry
      fs.writeFileSync(DATA_PATHS, JSON.stringify(dp, null, 2))
      info("added pc['26.3'] to dataPaths.json")
    }
  }
} catch (err) {
  // Non-fatal: nothing in the runtime loader consumes dataPaths.json.
  console.warn(`[apply-26.3-data] warning: dataPaths.json not patched (${err.message})`)
}

patchVersionGates()

// ------------------------------------------------------------ 5. verification
// Fresh module registry so the patched data.js is actually loaded.
for (const key of Object.keys(require.cache)) {
  if (key.includes('minecraft-data')) delete require.cache[key]
}
let mcData
try {
  mcData = require('minecraft-data')('26.3')
} catch (err) {
  die(`require('minecraft-data')('26.3') threw: ${err.message}`)
}
if (!mcData) die("require('minecraft-data')('26.3') returned null")
if (!Array.isArray(mcData.blocksArray) || mcData.blocksArray.length < 1000) die('26.3 blocks.json did not load correctly')
if (!Array.isArray(mcData.itemsArray) || mcData.itemsArray.length < 1000) die('26.3 items.json did not load correctly')
if (!mcData.blocksByName?.stone || !mcData.itemsByName?.stone) die('26.3 name indexes did not load correctly')
if (!mcData.recipes) die('26.3 recipes.json did not load correctly')
if (!mcData.protocol || !mcData.protocol.play) die('26.3 protocol.json did not load correctly')
if (mcData.version.version !== 777) die(`protocol version mismatch: expected 777, got ${mcData.version.version}`)

let registry
try {
  registry = require('prismarine-registry')('26.3')
} catch (err) {
  die(`prismarine-registry('26.3') threw: ${err.message}`)
}
if (!registry?.itemsByName?.stone) die('prismarine-registry(26.3) is missing expected items')

const chest = registry.itemsByName.chest
const { Recipe } = require('prismarine-recipe')(registry)
const chestRecipes = chest ? Recipe.find(chest.id, null).length : 0

// Replicate mineflayer/lib/loader.js's version gate with the patched packages.
const mineflayerVersionJs = require.resolve('mineflayer/lib/version.js')
delete require.cache[mineflayerVersionJs]
const mfVersionModule = require(mineflayerVersionJs)
if (!mfVersionModule.testedVersions.includes('26.3')) {
  die('mineflayer lib/version.js was not patched (testedVersions missing 26.3)')
}
const latestSupport = mfVersionModule.testedVersions[mfVersionModule.testedVersions.length - 1]
const latestProtocolVersion = require('minecraft-data').versionsByMinecraftVersion.pc[latestSupport].version
if (registry.version['>'](latestSupport) && registry.version.version !== latestProtocolVersion) {
  die('mineflayer version gate would still reject 26.3')
}
info(`OK — mineflayer version gate admits 26.3 (latest supported: ${latestSupport})`)

// prismarine-chunk must resolve a 26.3 implementation.
try {
  const chunkLoader = require('prismarine-chunk')
  const ChunkColumn = chunkLoader(registry)
  if (typeof ChunkColumn !== 'function') die('prismarine-chunk(26.3) did not return a chunk constructor')
  info('OK — prismarine-chunk resolves pc 26.3 (pc/1.18/chunk implementation)')
} catch (err) {
  die(`prismarine-chunk('26.3') failed: ${err.message}`)
}

// prismarine-physics must find liquid-gravity support features for 26.3.
try {
  const features = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', 'prismarine-physics', 'lib', 'features.json'), 'utf8'))
  const supported = features.some(({ name, versions }) => name === 'proportionalLiquidGravity' && versions.includes('26.3'))
  if (!supported) die('prismarine-physics features.json does not support 26.3 liquid gravity')
  info('OK — prismarine-physics feature table covers 26.3')
} catch (err) {
  die(`prismarine-physics features.json check failed: ${err.message}`)
}

info(`OK — mcData 26.3 loaded: ${mcData.blocksArray.length} blocks, ${mcData.itemsArray.length} items, protocol ${mcData.version.version}`)
info(`OK — prismarine-registry 26.3 ready, chest recipes found: ${chestRecipes}`)
