const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
// U1 exact replica
const cells=new Map()
const conn=(i)=>({east:i===0?'none':'side',west:i===17?'none':'side',north:'none',south:'none'})
for(let i=0;i<=17;i++){cells.set(K(-i,64,0),{name:'stone'});cells.set(K(-i,65,0),{name:'redstone_wire',state:{power:'0',...conn(i)}})}
cells.set(K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}})
const per=E.perceive(bot(cells),{x:-8,y:65,z:0,radius:6})
console.log('nodes',per.snapshot.nodes.length, per.snapshot.nodes.map(n=>n.id).slice(0,5))
const m=new E.CircuitModel(per.snapshot)
const p=m.solvePower().power
console.log(Array.from({length:18},(_,i)=>p.get(K(-i,65,0))?.model??0).join(','))
