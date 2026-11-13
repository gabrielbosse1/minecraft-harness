const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const design=process.argv[2]||'and'
const radius=Number(process.argv[3]||5)
const ctr=JSON.parse(process.argv[4]||'[1,64,1]')
const plan=E.planPlacement(design,{x:0,y:64,z:0})
console.log('checkDesign',JSON.stringify(E.checkDesign(plan.name||design)))
const cells=new Map(plan.placements.map(q=>[K(q.x,q.y,q.z),{name:q.name,state:q.state}]))
const m=new E.CircuitModel(E.perceive(bot(cells),{x:ctr[0],y:ctr[1],z:ctr[2],radius}).snapshot)
const srcs=m.sources().map(s=>s.id).sort()
const lamp=m.mechanisms().find(x=>x.kind==='redstone_lamp').id
let table=''
for(let i=0;i<(1<<srcs.length);i++){
  const inputs={}
  srcs.forEach((id,k)=>inputs[id]=Boolean(i&(1<<(srcs.length-1-k))))
  const s=m.run({ticks:20,inputs})
  const last=s.frames[s.frames.length-1]
  const o=last.outputs.find(x=>x.at===lamp)
  table+=(o&&o.active?1:0)
}
console.log('sources',srcs.join('|'),'lamp',lamp,'table',table)
const dbg=m.run({ticks:20,inputs:Object.fromEntries(srcs.map(s=>[s,false]))})
console.log('idle dust',JSON.stringify(dbg.frames[19].dust))
console.log('idle torch',JSON.stringify(dbg.frames[19].torches))
console.log('allOn dust',JSON.stringify(m.run({ticks:20,inputs:Object.fromEntries(srcs.map(s=>[s,true]))}).frames[19].dust))
