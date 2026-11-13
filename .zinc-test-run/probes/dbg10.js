const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const plan=E.planPlacement('not',{x:0,y:64,z:0})
const cells=new Map(plan.placements.map(p=>[K(p.x,p.y,p.z),{name:p.name,state:p.state}]))
console.log('NOT plan:',plan.placements.map(p=>`${p.name}@${p.x},${p.y},${p.z} ${JSON.stringify(p.state||{})}`).join('\n'))
const per=E.perceive(bot(cells),{x:0,y:64,z:1,radius:4})
const m=new E.CircuitModel(per.snapshot)
console.log('nodes',m.nodes.map(n=>n.id+':'+n.kind).join(' '))
console.log('sources',m.sources().map(n=>n.id).join(' '),'mechs',m.mechanisms().map(n=>n.id+':'+n.kind).join(' '))
const src=m.sources()[0]
const sim=m.run({ticks:10,inputs:{[src.id]:true}})
console.log('lamp series',sim.frames.map(f=>f.outputs.map(o=>o.active?1:0).join('')).join(''))
console.log('torches',JSON.stringify(sim.frames.map(f=>f.torches)))
