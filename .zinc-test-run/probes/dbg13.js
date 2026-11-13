const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const W=(plan)=>new Map(plan.placements.map(q=>[K(q.x,q.y,q.z),{name:q.name,state:q.state}]))
const M=(cells,ctr,r)=>new E.CircuitModel(E.perceive(bot(cells),{x:ctr[0],y:ctr[1],z:ctr[2],radius:r}).snapshot)
const ser=(s,id)=>s.frames.map(f=>{const o=f.outputs.find(x=>x.at===id);return o&&o.active?1:0}).join('')
for(const d of ['not','and','or','xor']){
  const plan=E.planPlacement(d,{x:0,y:64,z:0})
  const m=M(W(plan),[2,65,2],6)
  const srcs=m.sources().map(s=>s.id)
  const lamp=m.mechanisms()[0].id
  let out=''
  for(let i=0;i<(1<<srcs.length);i++){
    const inputs={}
    srcs.forEach((id,k)=>inputs[id]=Boolean(i&(1<<(srcs.length-1-k))))
    out+=ser(m.run({ticks:16,inputs}),lamp).slice(-1)
  }
  console.log(d,'sources',srcs.join('|'),'lamp',lamp,'->',out)
}
// proposed clock: torch inverter with dust feedback
const cells=new Map([
 [K(0,64,0),{name:'stone'}],                       // support block S
 [K(1,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(1,64,1),{name:'redstone_wire',state:{power:'0',north:'side'}}],
 [K(0,64,1),{name:'redstone_wire',state:{power:'0',east:'side',north:'side'}}],
 [K(1,64,2),{name:'redstone_lamp'}]
])
const m=M(cells,[1,64,1],3)
const s=m.run({ticks:20})
console.log('clock torch',s.frames.map(f=>f.torches['1,64,0']?1:0).join(''))
console.log('clock lamp ',s.frames.map(f=>f.outputs.map(o=>o.active?1:0).join('')).join(''))
console.log('osc',s.oscillating,s.period)
