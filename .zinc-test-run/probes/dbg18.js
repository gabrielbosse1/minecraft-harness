const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// AND: two inverter torches feed a common dust line that points into S_C;
// torch T_C on S_C lights the lamp. Output = ¬(¬A ∨ ¬B).
const c=new Map([
 [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'redstone_torch',state:{lit:true}}],
 [K(0,64,3),{name:'stone'}],[K(0,65,3),{name:'redstone_torch',state:{lit:true}}],
 [K(0,64,1),{name:'stone'}],[K(1,64,0),{name:'stone'}],[K(1,64,1),{name:'stone'}],[K(1,64,2),{name:'stone'}],[K(1,64,3),{name:'stone'}],
 [K(2,64,1),{name:'stone'}],[K(2,65,1),{name:'stone'}],[K(2,66,1),{name:'redstone_torch',state:{lit:true}}],
 [K(3,66,1),{name:'redstone_lamp',state:{lit:false}}],
 [K(1,65,0),dw({west:'side',south:'side'})],
 [K(1,65,1),dw({north:'side',south:'side',east:'side'})],
 [K(1,65,2),dw({north:'side',south:'side'})],
 [K(1,65,3),dw({north:'side',west:'side'})]
])
const m=new E.CircuitModel(E.perceive(bot(c),{x:1,y:65,z:1,radius:5}).snapshot)
const lamp=(s)=>s.frames[s.frames.length-1].outputs.map(o=>o.active?1:0).join('')
// drive the two torches directly through their support blocks by adding levers is awkward;
// instead simulate by toggling torch lit via inputs? use 'inputs' on torch ids is not a source.
console.log('torches', m.nodes.filter(n=>n.kind==='torch').map(n=>n.id).join(' '))
const s=m.run({ticks:10}); console.log('lamp',s.frames.map(f=>f.outputs.map(o=>o.active?1:0).join('')).join(''));console.log('dust',JSON.stringify(s.frames[9].dust),'torch',JSON.stringify(s.frames[9].torches))
