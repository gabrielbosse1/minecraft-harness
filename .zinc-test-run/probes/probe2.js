const E = require('/home/user/minecraft-harness/zincai/redstone_engine')
const PLANE = new Set(['redstone_wire','redstone_torch','redstone_wall_torch','repeater','comparator','lever','stone_button','oak_button','oak_pressure_plate','tripwire_hook','daylight_detector','observer','piston','sticky_piston','redstone_lamp','note_block','hopper','dropper','dispenser','powered_rail','activator_rail','chest','barrel','crafter','tripwire'])
for (const d of Object.values(E.DESIGNS)) {
  const occ = new Set(d.blocks.map(b => `${b.dx||0},${b.dy||0},${b.dz||0}`))
  const has = (x,y,z) => occ.has(`${x},${y},${z}`)
  const problems = []
  // every design leaves "air" where MC needs a solid support
  for (const b of d.blocks) {
    const x = b.dx||0, y = b.dy||0, z = b.dz||0
    let needsBelow = PLANE.has(b.name) && !/_lamp$|observer|piston|hopper|dispenser|dropper|chest|barrel|rail/.test(b.name)
    if (b.name === 'redstone_wall_torch') needsBelow = false
    if (b.name === 'repeater' || b.name === 'comparator') needsBelow = true
    if (needsBelow && !has(x, y-1, z) && !/lamp|observer|lamp/.test(b.name)) problems.push(`${b.name}@${x},${y},${z} has no block beneath it`)
    if (b.name === 'redstone_torch' && has(x, y-1, z)) {
      const below = d.blocks.find(q => (q.dx||0)===x && (q.dy||0)===y-1 && (q.dz||0)===z)
      // a torch sitting on the dust block above? also torch on non-solid is invalid
      if (/wire|torch|repeater|comparator/.test(below.name)) problems.push(`redstone_torch@${x},${y},${z} stands on ${below.name} (not a solid block)`)
    }
    if (b.name === 'redstone_lamp' && has(x, y-1, z)) {
      const below = d.blocks.find(q => (q.dx||0)===x && (q.dy||0)===y-1 && (q.dz||0)===z)
      if (below.name === 'redstone_torch') problems.push(`redstone_lamp@${x},${y},${z} sits directly on a torch`)
    }
  }
  console.log(`${d.name}: ${problems.length ? 'STRUCTURALLY INVALID' : 'ok'}`)
  for (const p of problems) console.log('    -', p)
}
