const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
const world=(a,b)=>new Map([
 [K(0,63,1),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'floor',facing:'south',powered:a}}],
 [K(0,63,0),{name:'stone'}],[K(0,64,0),dw({north:'side',south:'side'})],
 [K(0,63,-1),{name:'stone'}],[K(0,64,-1),{name:'stone'}],
 [K(0,65,-1),{name:'redstone_torch',state:{lit:true}}],
 [K(0,63,3),{name:'stone'}],[K(0,64,3),{name:'stone'}],
 [K(0,65,3),{name:'redstone_torch',state:{lit:true}}],
 [K(0,63,4),{name:'stone'}],[K(0,64,4),dw({north:'side',south:'side'})],
 [K(0,63,5),{name:'stone'}],[K(0,64,5),{name:'lever',state:{face:'floor',facing:'north',powered:b}}],
 [K(0,63,2),{name:'stone'}],[K(0,64,2),{name:'stone'}],
 [K(0,65,2),dw({north:'side',south:'side',east:'side'})],
 [K(1,63,2),{name:'stone'}],[K(1,64,2),{name:'stone'}],
 [K(1,65,2),{name:'redstone_torch',state:{lit:true}}],
 [K(2,65,2),{name:'redstone_lamp',state:{lit:false}}]
])
const m=new E.CircuitModel(E.perceive(bot(world(false,false)),{x:0,y:64,z:2,radius:6}).snapshot)
const srcs=m.sources().map(s=>s.id).sort()
const lamp=m.mechanisms().find(x=>x.kind==='redstone_lamp').id
let table=''
for(let i=0;i<4;i++){
 const inputs={}; srcs.forEach((id,k)=>inputs[id]=Boolean(i&(1<<(1-k))))
 const s=m.run({ticks:16,inputs}); table+=(s.frames[15].outputs.find(x=>x.at===lamp).active?1:0)
}
console.log('srcs',srcs.join('|'),'AND',table)
const d=m.run({ticks:16,inputs:{[srcs[0]]:false,[srcs[1]]:false}})
console.log('idle dust',JSON.stringify(d.frames[15].dust))
console.log('idle torch',JSON.stringify(d.frames[15].torches))
const d2=m.run({ticks:16,inputs:{[srcs[0]]:true,[srcs[1]]:false}})
console.log('A-only dust',JSON.stringify(d2.frames[15].dust))
console.log('A-only torch',JSON.stringify(d2.frames[15].torches))
