const E = require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot (cells) {
  return { version: '1.21.4', game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt (p) { const c = cells[p.x + ',' + p.y + ',' + p.z]; return c ? { name: c.name, getProperties: () => c.state || {} } : { name: 'air', getProperties: () => ({}) } } }
}
const M = (cells) => new E.CircuitModel(E.perceive(bot(cells), { x: 0, y: 64, z: 0, radius: 3 }).snapshot)
const p = (m, id) => { const q = m.solvePower().power.get(id); return q ? q.model : 'n/a' }

console.log('--- A: torch UNDER a block strongly powers it -> dust on top + beside ---')
// stone at (1,64,0) with torch under at (1,63,0); dust on top (1,65,0) and beside (2,64,0)
let m = M({
  '1,63,0': { name: 'redstone_torch', state: { lit: true } },
  '1,64,0': { name: 'stone' },
  '1,65,0': { name: 'redstone_wire', state: { power: '0' } },
  '2,64,0': { name: 'redstone_wire', state: { power: '0' } }
})
console.log('  dust on top =', p(m, '1,65,0'), ' dust beside =', p(m, '2,64,0'), '  (real MC: 15 and 15)')

console.log('--- B: repeater output into a block -> block strongly powered -> dust beside it ---')
m = M({
  '0,64,0': { name: 'lever', state: { face: 'floor', facing: 'north', powered: true } },
  '1,64,0': { name: 'repeater', state: { facing: 'west', delay: '1', powered: true } },
  '2,64,0': { name: 'stone' },
  '3,64,0': { name: 'redstone_wire', state: { power: '0' } },
  '2,65,0': { name: 'redstone_wire', state: { power: '0' } }
})
console.log('  dust beyond block =', p(m, '3,64,0'), ' dust on top of block =', p(m, '2,65,0'), '  (real MC: 15, 15)')

console.log('--- C: dust STACKED vertically (no step) must not conduct ---')
m = M({
  '0,64,0': { name: 'redstone_wire', state: { power: '15', east: 'side' } },
  '0,65,0': { name: 'redstone_wire', state: { power: '0' } },
  '0,66,0': { name: 'redstone_wire', state: { power: '0' } }
})
console.log('  upper dust =', p(m, '0,65,0'), '(real MC: 0 — dust does not stack vertically)')

console.log('--- D: dust step UP needs side="up" ---')
m = M({
  '0,64,0': { name: 'stone' },
  '0,65,0': { name: 'redstone_wire', state: { power: '15', east: 'side', north: 'none', south: 'none', west: 'none' } },
  '1,65,0': { name: 'stone' },
  '1,64,0': { name: 'redstone_wire', state: { power: '0', west: 'up' } }
})
console.log('  lower dust =', p(m, '1,64,0'), '(real MC: 14 — a step down with side=up conducts)')

console.log('--- E: dust path must respect the observed power direction: cross/dot ---')
console.log('--- F: does a dust cell reading power=15 inject into neighbours? ---')
m = M({
  '0,64,0': { name: 'redstone_wire', state: { power: '15', east: 'side' } },
  '1,64,0': { name: 'redstone_wire', state: { power: '0', west: 'side' } }
})
console.log('  neighbour from observed 15 =', p(m, '1,64,0'), '(real MC: 14)')

console.log('--- G: observer pulse width and trigger source ---')
m = M({
  '0,64,0': { name: 'observer', state: { facing: 'north', powered: false } },
  '0,64,1': { name: 'redstone_wire', state: { power: '0' } },
  '0,64,2': { name: 'redstone_lamp', state: { lit: false } }
})
const sim = m.run({ ticks: 8, changes: ['0,64,-1'] })  // the watched block changed
console.log('  lamp series when the WATCHED block changes:', sim.frames.map(f => f.outputs.find(o=>o.kind==='redstone_lamp')?.active ? 1 : 0).join(''))
console.log('  (real MC: 2 game ticks of pulse)')
const sim2 = m.run({ ticks: 8, changes: ['0,64,0'] })  // observer id themselves
console.log('  lamp series when the OBSERVER id is in `changes`:', sim2.frames.map(f => f.outputs.find(o=>o.kind==='redstone_lamp')?.active ? 1 : 0).join(''))
