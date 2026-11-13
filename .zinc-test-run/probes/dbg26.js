const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
// AND: line = ¬A ∨ ¬B sits on top of the final inverter block; a WALL torch hangs
// on that block's side, so a powered line extinguishes it: out = A ∧ B.
const world=()=>new Map([
 // input A -> inverter A
 [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:false}}],
 [K(0,64,1),{name:'redstone_wire',state:{power:'0',north:'side',south:'side'}}],
 [K(0,64,2),{name:'stone'}],[K(0,65,2),{name:'redstone_torch',state:{lit:true}}],
 // input B -> inverter B
 [K(3,64,0),{name:'stone'}],[K(3,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:false}}],
 [K(3,64,1),{name:'redstone_wire',state:{power:'0',north:'side',south:'side'}}],
 [K(3,64,2),{name:'stone'}],[K(3,65,2),{name:'redstone_torch',state:{lit:true}}],
 // OR line on top of the final block
 [K(1,64,2),{name:'stone'}],[K(2,64,2),{name:'stone'}],
 [K(1,65,2),{name:'redstone_wire',state:{power:'0',east:'side',west:'side'}}],
 [K(2,65,2),{name:'redstone_wire',state:{power:'0',east:'side',west:'side'}}],
 // final: wall torch on the side of (2,64,2) facing south => support (2,64,2)
 [K(2,64,3),{name:'redstone_wall_torch',state:{facing:'south',lit:true}}],
 [K(3,64,3),{name:'redstone_lamp',state:{lit:false}}]
])
const m=new E.CircuitModel(E.perceive(bot(world()),{x:2,y:65,z:2,radius:6}).snapshot)
const srcs=m.sources().map(s=>s.id).sort()
const lamp=m.mechanisms().find(x=>x.kind==='redstone_lamp').id
let table=''
for(let i=0;i<4;i++){
 const inputs={}; srcs.forEach((id,k)=>inputs[id]=Boolean(i&(1<<(1-k))))
 const s=m.run({ticks:18,inputs})
 const o=s.frames[17].outputs.find(x=>x.at===lamp)
 table+=(o&&o.active?1:0)
}
console.log('sources',srcs.join('|'),'walltorch support?',JSON.stringify(m.inputsOf(m.nodeAt(2,64,3))))
console.log('AND table',table)
