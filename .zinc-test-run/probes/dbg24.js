const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr,r)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:r}).snapshot)
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// NOT: wire points INTO a block, torch stands on that block.
const notWorld=(on)=>new Map([
 [K(0,64,0),{name:'stone'}],[K(0,64,1),{name:'stone'}],
 [K(0,65,0),{name:'stone'}],[K(0,66,0),{name:'lever',state:{face:'floor',facing:'south',powered:on}}],
 [K(0,65,1),dw({west:'side',east:'side'})],
 [K(0,65,2),{name:'stone'}],                       // inverting block
 [K(0,66,2),{name:'redstone_torch',state:{lit:true}}],
 [K(1,66,2),{name:'redstone_lamp',state:{lit:false}}]
])
for(const on of [false,true]){
 const m=M(notWorld(on),[0,65,1],4)
 const s=m.run({ticks:8})
 console.log('NOT in='+on,'dust',s.frames.map(f=>f.dust['0,65,1']).join(','),
  'torch',s.frames.map(f=>f.torches['0,66,2']?1:0).join(''),
  'lamp',s.frames.map(f=>{const o=f.outputs.find(x=>x.at===K(1,66,2));return o&&o.active?1:0}).join(''))
}
