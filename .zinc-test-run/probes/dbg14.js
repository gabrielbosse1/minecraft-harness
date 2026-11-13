const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:3}).snapshot)
let c=new Map([[K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'redstone_torch',state:{lit:true}}]])
let m=M(c,[0,64,0])
console.log('lone torch',m.run({ticks:8}).frames.map(f=>f.torches['0,65,0']?1:0).join(''))
c=new Map([[K(0,64,0),{name:'stone'}],[K(1,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(1,64,1),{name:'redstone_wire',state:{power:'0',north:'side'}}]])
m=M(c,[1,64,0])
const s=m.run({ticks:10})
console.log('torch',s.frames.map(f=>f.torches['1,64,0']?1:0).join(''))
console.log('dust ',s.frames.map(f=>f.dust['1,64,1']).join(','))
