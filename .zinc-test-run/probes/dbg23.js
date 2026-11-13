const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const plan=E.planPlacement('not',{x:0,y:64,z:0})
const cells=new Map(plan.placements.map(q=>[K(q.x,q.y,q.z),{name:q.name,state:q.state}]))
const m=new E.CircuitModel(E.perceive(bot(cells),{x:0,y:64,z:1,radius:4}).snapshot)
const src=m.sources()[0].id
const lamp=m.mechanisms()[0].id
// reuse ONE model, two runs (this is what truthTable does)
for(const on of [false,true,false]){
  const s=m.run({ticks:16,inputs:{[src]:on}})
  console.log('reuse on='+on, s.frames[s.frames.length-1].outputs.find(o=>o.at===lamp).active)
}
const m2=new E.CircuitModel(E.perceive(bot(cells),{x:0,y:64,z:1,radius:4}).snapshot)
const s2=m2.run({ticks:16,inputs:{[src]:true}})
console.log('FRESH on=true dust',JSON.stringify(s2.frames[15].dust),'torch',JSON.stringify(s2.frames[15].torches))
console.log('source id',src,'state',JSON.stringify(m2.sources()[0].state))
console.log('sourceStrength', E.sourceStrength(m2.sources()[0],{inputs:{[src]:true}}))
const m3=new E.CircuitModel(E.perceive(bot(cells),{x:0,y:64,z:1,radius:4}).snapshot)
const s3=m3.run({ticks:8,inputs:{[src]:true}})
console.log('tick dust',JSON.stringify(s3.frames.map(f=>f.dust['0,65,1'])))
console.log('tick torch',JSON.stringify(s3.frames.map(f=>f.torches['0,65,2'])))
