// Does build's 3-cell claim check actually cover the footprint it is about to place?
const { BlueprintParser } = require('/home/user/minecraft-harness/zincai/builder')
const { makeWorld } = require('/home/user/minecraft-harness/test/helpers/world')
const bot = makeWorld()
const parser = new BlueprintParser({ scaffoldBlocks: ['scaffolding'], reach: 5 })

const claim = { x: 8, y: 64, z: 8, radius: 3, kind: 'player', owner: 'Steve' }
const guardAt = (p) => Math.hypot(p.x - claim.x, p.z - claim.z) <= claim.radius ? { ok: false } : { ok: true }

for (const size of [9, 15, 21]) {
  for (const where of ['corner', 'middle']) {
    const blocks = []
    for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) blocks.push({ dx, dy: 0, dz, name: 'oak_planks' })
    const plan = parser.plan({ blocks }, { x: 0, y: 64, z: 0 }, bot.entity.position)
    // index.js:2619 sampling, verbatim
    const samples = [plan.steps[0], plan.steps[Math.floor(plan.steps.length / 2)], plan.steps[plan.steps.length - 1]]
    const c = where === 'corner' ? { ...claim, x: size - 2, z: size - 2 } : { ...claim, x: 4, z: 4 }
    const bad = plan.steps.filter(s => Math.hypot(s.x - c.x, s.z - c.z) <= c.radius).length
    const refused = samples.some(s => Math.hypot(s.x - c.x, s.z - c.z) <= c.radius)
    console.log(`${size}x${size} claim@${where.padEnd(6)} samples=${samples.map(s => `${s.x},${s.z}`).join(' ').padEnd(16)} refused=${String(refused).padEnd(5)} cells-in-claim=${bad}`)
  }
}
