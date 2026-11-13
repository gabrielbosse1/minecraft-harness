const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:3}).snapshot)
const mk=(p)=>new Map([[K(1,64,0),{name:'stone'}],[K(1,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:p}}],
 [K(1,65,0),{name:'redstone_torch',state:{lit:true}}],[K(2,65,0),{name:'redstone_lamp',state:{lit:false}}]])
for(const p of [true,false]){
  const m=M(mk(p),[1,64,0])
  const t=m.nodeAt(1,65,0)
  console.log('leverPowered='+p,'inputsOf',JSON.stringify(m.inputsOf(t).map(i=>({dir:i.dir,role:i.role,node:i.node&&i.node.id,solid:i.solid}))))
  console.log('  torch',m.run({ticks:6}).frames.map(f=>f.torches['1,65,0']?1:0).join(''))
}
