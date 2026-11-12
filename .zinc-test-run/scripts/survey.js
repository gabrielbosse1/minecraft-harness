/**
 * Terrain survey: join as Probe2, sample top blocks on a grid around spawn,
 * print min/max/surface heights so the world builder can level a build pad.
 */
'use strict'
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'Probe2', auth: 'offline', version: false })
bot.once('error', (e) => { console.log('SURVEY_ERROR', e.message); process.exit(1) })

bot.once('spawn', () => {
  const sp = bot.entity.position
  console.log('SPAWN', sp.floor().x, sp.floor().y, sp.floor().z)
  // wait for chunks around spawn
  setTimeout(() => {
    const heights = []
    for (let dx = -40; dx <= 40; dx += 4) {
      for (let dz = -40; dz <= 40; dz += 4) {
        const x = Math.floor(sp.x) + dx, z = Math.floor(sp.z) + dz
        for (let y = 100; y >= -20; y--) {
          const b = bot.blockAt(new (require('/home/anonymous/minecraft-harness/node_modules/vec3').Vec3)(x, y, z))
          if (b && b.name && b.name !== 'air' && !b.name.includes('leaves') && !b.name.endsWith('_sapling')) {
            heights.push({ x, z, y, name: b.name })
            break
          }
        }
      }
    }
    const ys = heights.map((h) => h.y)
    console.log('SURVEY n=' + heights.length + ' min=' + Math.min(...ys) + ' max=' + Math.max(...ys) + ' median=' + ys.sort((a, b) => a - b)[ys.length >> 1])
    // where is water?
    const water = heights.filter((h) => h.name === 'water')
    console.log('SURVEY_WATER', water.length)
    const names = {}
    for (const h of heights) names[h.name] = (names[h.name] || 0) + 1
    console.log('SURVEY_BLOCKS', JSON.stringify(names))
    console.log('SURVEY_HIGHEST', JSON.stringify(heights.sort((a, b) => b.y - a.y).slice(0, 6)))
    console.log('SURVEY_LOWEST', JSON.stringify(heights.sort((a, b) => a.y - b.y).slice(0, 6)))
    bot.quit()
    setTimeout(() => process.exit(0), 500)
  }, 6000)
})
