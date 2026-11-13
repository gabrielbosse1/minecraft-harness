const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const plan=E.planPlacement('and',{x:0,y:64,z:0})
const cells=new Map(plan.placements.map(q=>[K(q.x,q.y,q.z),{name:q.name,state:q.state}]))
const m=new E.CircuitModel(E.perceive(bot(cells),{x:2,y:65,z:2,radius:6}).snapshot)
const srcs=m.sources().map(s=>s.id)
const lamp=m.mechanisms().find(x=>x.kind==='redstone_lamp').id
for(const [a,b] of [[true,true],[true,false],[false,true],[false,false]]){
  const s=m.run({ticks:14,inputs:{[srcs[0]]:a,[srcs[1]]:b}})
  const last=s.frames[s.frames.length-1]
  console.log(a,b,'lamp',last.outputs.map(o=>o.active?1:0).join(''),
   'torches',JSON.stringify(last.torches),
   'dust',JSON.stringify(last.dust))
}
