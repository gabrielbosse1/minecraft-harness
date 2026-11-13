const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const plan=E.planPlacement('not',{x:0,y:64,z:0})
const cells=new Map(plan.placements.map(q=>[K(q.x,q.y,q.z),{name:q.name,state:q.state}]))
const m=new E.CircuitModel(E.perceive(bot(cells),{x:0,y:64,z:1,radius:4}).snapshot)
const t=m.nodeAt(0,65,2)
console.log('inputsOf torch',JSON.stringify(m.inputsOf(t)))
console.log('torchFeeders',JSON.stringify(m.torchFeeders(t).map(f=>f.node.id)))
const src=m.sources()[0]
for(const on of [false,true]){
  const s=m.run({ticks:8,inputs:{[src.id]:on}})
  console.log('on='+on,'dust',s.frames.map(f=>f.dust['0,65,1']).join(','),'torch',s.frames.map(f=>f.torches['0,65,2']?1:0).join(''),'lamp',s.frames.map(f=>f.outputs.map(o=>o.active?1:0)).join(''))
}
