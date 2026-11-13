const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// Clock: torch inverter with an odd dust feedback, plus a wall lever "enable"
const world=(on)=>new Map([
 [K(0,64,1),{name:'stone'}],[K(0,64,2),{name:'stone'}],[K(1,64,2),{name:'stone'}],
 [K(0,64,-1),{name:'stone'}],[K(1,64,-1),{name:'stone'}],[K(2,64,-1),{name:'stone'}],
 [K(3,64,-1),{name:'stone'}],[K(2,64,0),{name:'stone'}],[K(3,64,0),{name:'stone'}],
 [K(3,64,1),{name:'stone'}],[K(2,64,1),{name:'stone'}],[K(0,65,-1),{name:'stone'}],
 [K(1,65,-1),{name:'stone'}],[K(3,65,-1),{name:'stone'}],[K(3,65,0),{name:'stone'}],
 [K(3,65,1),{name:'stone'}],[K(0,65,1),{name:'stone'}],[K(0,65,0),{name:'stone'}],
 [K(2,65,0),{name:'stone'}],
 [K(0,64,0),{name:'stone'}],                       // S
 [K(1,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],   // T
 [K(1,64,1),dw({north:'side',south:'side'})],
 [K(1,64,2),dw({north:'side',east:'side'})],
 [K(2,64,2),{name:'stone'}],                       // S2
 [K(2,65,2),{name:'redstone_torch',state:{lit:true}}],  // feedback inverter
 [K(2,65,1),dw({south:'side',west:'side'})],
 [K(1,65,1),dw({east:'side',north:'side'})],
 [K(1,65,0),dw({south:'side',west:'none'})],
 [K(1,65,1),dw({east:'side',south:'side'})],
 [K(3,64,2),{name:'redstone_lamp',state:{lit:false}}]
])
const m=new E.CircuitModel(E.perceive(bot(world()),{x:1,y:64,z:1,radius:4}).snapshot)
const s=m.run({ticks:40})
console.log('osc',s.oscillating,'period',s.period)
console.log('lamp',s.frames.map(f=>f.outputs.map(o=>o.active?1:0).join('')).join(''))
console.log('torch',s.frames.map(f=>f.torches['1,64,0']?1:0).join(''))
console.log('dust',s.frames.slice(0,12).map(f=>f.dust['1,64,1']).join(','))
console.log('feedback torch',s.frames.slice(0,12).map(f=>f.torches['2,65,2']?1:0).join(''))
