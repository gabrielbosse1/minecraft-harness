const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
const world=(a,b)=>{
  const c=new Map()
  for(let x=0;x<4;x++) for(let z=0;z<6;z++) c.set(K(x,64,z),{name:'stone'})   // make floor explicit
  c.set(K(0,65,0),{name:'stone'}); c.set(K(0,66,0),{name:'lever',state:{face:'floor',facing:'south',powered:a}})
  c.set(K(1,65,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}})
  c.set(K(1,65,1),dw({north:'side',south:'side'}))
  c.set(K(1,65,2),dw({north:'side',south:'side',east:'side'}))
  c.set(K(1,65,3),dw({north:'side',south:'side'}))
  c.set(K(0,65,4),{name:'stone'}); c.set(K(0,66,4),{name:'lever',state:{face:'floor',facing:'north',powered:b}})
  c.set(K(1,65,4),{name:'redstone_wall_torch',state:{facing:'east',lit:true}})
  c.set(K(2,65,2),{name:'stone'})
  c.set(K(2,66,2),{name:'redstone_torch',state:{lit:true}})
  c.set(K(3,66,2),{name:'redstone_lamp',state:{lit:false}})
  return c
}
const m=new E.CircuitModel(E.perceive(bot(world(false,false)),{x:1,y:65,z:2,radius:6}).snapshot)
const srcs=m.sources().map(s=>s.id).sort()
const lamp=m.mechanisms().find(x=>x.kind==='redstone_lamp').id
let table=''
for(let i=0;i<4;i++){
 const inputs={}; srcs.forEach((id,k)=>inputs[id]=Boolean(i&(1<<(1-k))))
 const s=m.run({ticks:16,inputs}); table+=(s.frames[15].outputs.find(x=>x.at===lamp).active?1:0)
}
console.log('srcs',srcs.join('|'),'AND',table)
const d=m.run({ticks:16,inputs:Object.fromEntries(srcs.map(s=>[s,false]))})
console.log('idle dust',JSON.stringify(d.frames[15].dust),'torch',JSON.stringify(d.frames[15].torches))
