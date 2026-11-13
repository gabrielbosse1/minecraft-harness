const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:ctr[3]}).snapshot)
const ser=(s,id)=>s.frames.map(f=>{const o=f.outputs.find(x=>x.at===id);return o&&o.active?1:0}).join('')

// U6a with the lamp actually adjacent to the torch
const mk=(on)=>new Map([[K(1,64,0),{name:'stone'}],[K(1,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:on}}],
 [K(1,65,0),{name:'redstone_torch',state:{lit:!on}}],[K(2,65,0),{name:'redstone_lamp',state:{lit:false}}]])
for(const on of [true,false]){const s=M(mk(on),[1,64,0,3]).run({ticks:8})
 console.log('U6a on='+on,ser(s,'2,65,0'),JSON.stringify(s.frames[0].torches))}

// U6d: repeater strongly powers a block, wall torch on it goes out
let c=new Map([
 [K(-1,64,0),{name:'stone'}],[K(-1,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(0,64,0),{name:'repeater',state:{facing:'west',delay:'1',powered:true}}],
 [K(1,64,0),{name:'stone'}],
 [K(2,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}]])
let m=M(c,[1,64,0,3])
console.log('U6d inputsOf torch',JSON.stringify(m.inputsOf(m.nodeAt(2,64,0))))
let s=m.run({ticks:8})
console.log('U6d torch',s.frames.map(f=>f.torches['2,64,0']?1:0).join(''))

// U6e: wall torch does not power its support but does power its other neighbours
c=new Map([[K(1,64,0),{name:'stone'}],[K(2,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(2,64,1),{name:'redstone_lamp',state:{lit:false}}]])
m=M(c,[1,64,0,3]); s=m.run({ticks:6})
console.log('U6e lamp beside torch',ser(s,'2,64,1'),'support bp',JSON.stringify(m.blockPower(1,64,0,m.solvePower().power)))

// U5d: comparator body must not power side dust
c=new Map([[K(1,64,0),{name:'stone'}],[K(1,65,0),{name:'redstone_block'}],
 [K(2,64,0),{name:'comparator',state:{facing:'west',mode:'compare',powered:true}}],
 [K(2,64,1),{name:'redstone_wire',state:{power:'0',west:'none'}}]])
m=M(c,[2,64,0,3]); console.log('U5d side dust',m.solvePower().power.get('2,64,1')?.model)
