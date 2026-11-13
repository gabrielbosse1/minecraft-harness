const E = require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot (cells) {
  return { version: '1.21.4', game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt (p) { const c = cells[p.x + ',' + p.y + ',' + p.z]; return c ? { name: c.name, getProperties: () => c.state || {} } : { name: 'air', getProperties: () => ({}) } } }
}
const snapOf = (cells) => E.perceive(bot(cells), { x: 0, y: 64, z: 0, radius: 3 }).snapshot

console.log('--- P1 rotated dust links keep stale direction keys ---')
const plan = E.planPlacement('or', { x: 0, y: 64, z: 0 }, { rotate: 'east' })
for (const p of plan.placements.filter(p => /wire|repeater/.test(p.name))) console.log(' ', p.x, p.y, p.z, p.name, JSON.stringify(p.state))

console.log('--- P2 strong vs weak power: 15A dust into block, dust on far side ---')
// dust A at (0,64,0) power 15 -> solid block (1,64,0) -> dust at (2,64,0)
const cells = {
  '0,64,0': { name: 'redstone_wire', state: { east: 'side', power: '15' } },
  '1,64,0': { name: 'stone' },
  '2,64,0': { name: 'redstone_wire', state: { west: 'side', power: '0' } }
}
const m = new E.CircuitModel(snapOf(cells))
const { power } = m.solvePower()
console.log('  model power dust@2 =', power.get('2,64,0').model, ' observed 0   (real MC: 0 — weak power does not feed dust)')

console.log('--- P3 torch on side of powered block: indirect powering ---')
// lever strongly powers block (1,64,0); wall torch on its EAST side at (2,64,0) facing east(=away)
const c3 = {
  '0,64,0': { name: 'lever', state: { face: 'wall', facing: 'east', powered: true } },
  '1,64,0': { name: 'stone' },
  '2,64,0': { name: 'redstone_wall_torch', state: { facing: 'east', lit: true } }
}
const m3 = new E.CircuitModel(snapOf(c3))
console.log('  model torch lit =', m3.run({ticks: 6}).outputs.map(o=>o), 'torch states:', JSON.stringify(m3.run({ticks:6}).frames.at(-1).torches))
console.log('  (real MC: lever on the block strongly powers it -> torch goes OUT)')

console.log('--- P4 AND gate design as a real world ---')
const cellsAnd = {}
for (const p of E.planPlacement('and', { x: 0, y: 64, z: 0 }).placements) cellsAnd[p.x + ',' + p.y + ',' + p.z] = { name: p.name, state: p.state }
const m4 = new E.CircuitModel(snapOf(cellsAnd))
console.log('  nodes:', m4.nodes.length, 'edges:', m4.edges.length)
console.log('  simulate:', JSON.stringify(m4.run({ ticks: 12 }).outputs))

console.log('--- P5 repeater delay units (state delay=1 => 2 game ticks) ---')
const c5 = {
  '0,64,0': { name: 'lever', state: { face: 'floor', powered: true } },
  '1,64,0': { name: 'repeater', state: { facing: 'west', delay: '1', powered: false } },
  '2,64,0': { name: 'redstone_lamp', state: { lit: false } }
}
const s5 = new E.CircuitModel(snapOf(c5)).run({ ticks: 8 })
console.log('  lamp on at tick:', s5.frames.map((f, i) => f.outputs[0].active ? i : null).filter(x => x !== null)[0], '(real MC: powered at tick 2)')
