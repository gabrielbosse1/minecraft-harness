const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr,r)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:r}).snapshot)
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// torch clock: wall torch on S, output dust runs to a vertical inverter that feeds S back
const cells=new Map([
 [K(0,64,0),{name:'stone'}],                                  // S
 [K(1,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}], // T (attached to S)
 [K(1,64,1),dw({north:'side',south:'side'})],                  // output line
 [K(1,64,2),dw({north:'side',east:'side'})],
 [K(2,64,2),{name:'stone'}],                                   // S2
 [K(2,65,2),{name:'redstone_torch',state:{lit:true}}],         // inverter
 [K(2,65,1),dw({south:'side',west:'side'})],                   // feedback east-west
 [K(1,65,1),dw({east:'side',north:'side'})],
 [K(1,65,0),dw({south:'side',west:'none'})],                   // waits: feedback must reach S
 [K(0,65,0),dw({east:'side',south:'none'})],                   // into the block above S? no...
 [K(3,64,2),{name:'redstone_lamp',state:{lit:false}}]
])
const m=M(cells,[1,64,1],4)
const s=m.run({ticks:24})
console.log('torch',s.frames.map(f=>f.torches['1,64,0']?1:0).join(''))
console.log('lamp ',s.frames.map(f=>f.outputs.map(o=>o.active?1:0).join('')).join(''))
console.log('osc',s.oscillating,s.period)
