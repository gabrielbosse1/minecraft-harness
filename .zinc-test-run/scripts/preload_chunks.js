/**
 * Chunk preloader: forceload a region, then poll a corner setblock until the
 * chunks are actually loaded (up to ~4 min), so a subsequent build batch does
 * not race generation. Usage: node preload_chunks.js <cx0> <cz0> <cx1> <cz1> [keep]
 * (keep = do NOT remove the forceload afterwards)
 */
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const rcon = (cmd) => spawnSync('node', [path.join(__dirname, 'rcon.js'), cmd], { encoding: 'utf8', timeout: 15000 }).stdout.trim()

async function main () {
  const [cx0, cz0, cx1, cz1] = process.argv.slice(2).map(Number)
  const keep = process.argv[6] === 'keep'
  const corner = [cx0 * 16, 95, cz0 * 16]
  rcon(`forceload add ${cx0} ${cz0} ${cx1} ${cz1}`)
  console.log(`preloading chunks x=${cx0}..${cx1} z=${cz0}..${cz1} (corner probe ${corner.join(',')})`)
  const t0 = Date.now()
  for (let i = 0; i < 48; i++) {
    const r = rcon(`setblock ${corner[0]} ${corner[1]} ${corner[2]} minecraft:air`)
    if (!/not loaded/i.test(r)) {
      console.log(`CHUNKS_LOADED after ${((Date.now() - t0) / 1000).toFixed(0)}s (${i + 1} polls)`)
      if (!keep) rcon(`forceload remove ${cx0} ${cz0} ${cx1} ${cz1}`)
      process.exit(0)
    }
    await new Promise((res) => setTimeout(res, 5000))
  }
  console.error('CHUNKS_TIMEOUT after 4 min')
  process.exit(1)
}
main()
