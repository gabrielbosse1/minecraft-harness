const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
// AND-minus-B: A on, B off. Final block at (2,65,1): dust (1,66,2),(2,66,2) point in?
const cells=new Map([
 [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:true}}],
 [K(0,64,1),{name:'redstone_wire',state:{power:'0',north:'side',south:'side'}}],
 [K(0,64,2),{name:'stone'}],[K(0,65,2),{name:'redstone_torch',state:{lit:true}}],
 [K(3,64,0),{name:'stone'}],[K(3,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:false}}],
 [K(3,64,1),{name:'redstone_wire',state:{power:'0',north:'side',south:'side'}}],
 [K(3,64,2),{name:'stone'}],[K(3,65,2),{name:'redstone_torch',state:{lit:true}}],
 [K(1,64,2),{name:'stone'}],[K(2,64,2),{name:'stone'}],
 [K(1,65,2),{name:'redstone_wire',state:{power:'0',east:'side',west:'side'}}],
 [K(2,65,2),{name:'redstone_wire',state:{power:'0',east:'side',west:'side'}}],
 [K(2,64,1),{name:'stone'}],[K(2,65,1),{name:'redstone_torch',state:{lit:true}}],
 [K(1,65,1),{name:'redstone_lamp'}]
])
const m=new E.CircuitModel(E.perceive(bot(cells),{x:1,y:65,z:1,radius:5}).snapshot)
const s=m.run({ticks:12})
console.log('dust',JSON.stringify(s.frames[11].dust))
console.log('torch',JSON.stringify(s.frames[11].torches))
console.log('bp(2,64,1)',JSON.stringify(m.blockPower(2,64,1,m.solvePower().power)))
