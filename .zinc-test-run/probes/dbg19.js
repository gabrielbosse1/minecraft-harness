const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr,r)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:r}).snapshot)
const dw=(o,tag)=>({name:'redstone_wire',state:{power:'0',...o}})

// --- AND in one plane ---
const andWorld=(av,bv)=>new Map([
 [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'redstone_torch',state:{lit:true}}],   // S_A, T_A=¬A
 [K(0,64,2),{name:'stone'}],[K(0,65,2),{name:'redstone_torch',state:{lit:true}}],   // S_B, T_B=¬B
 [K(0,65,1),dw({north:'side',south:'side',east:'side'})],                            // OR line
 [K(1,65,1),{name:'stone'}],                                                        // S_C
 [K(1,66,1),{name:'redstone_torch',state:{lit:true}}],                              // T_C
 [K(2,66,1),{name:'redstone_lamp',state:{lit:false}}],
 // input levers drive S_A / S_B from the side through dust
 [K(0,64,-1),{name:'stone'}],[K(1,64,-1),{name:'lever',state:{face:'floor',facing:'west',powered:av}}],
 [K(0,64,-2),{name:'stone'}],
 [K(0,65,-1),dw({east:'none',south:'side',north:'side'})],
 [K(-1,64,2),{name:'stone'}],[K(-2,64,2),{name:'lever',state:{face:'floor',facing:'east',powered:bv}}],
 [K(-1,65,2),dw({east:'side',west:'side'})]
])
const m=M(andWorld(false,false),[0,65,1],6)
const lampId=K(2,66,1)
for(const [a,b] of [[false,false],[false,true],[true,false],[true,true]]){
  const mm=M(andWorld(false,false),[0,65,1],6)
  const levers=mm.sources().map(s=>s.id)
  const s=mm.run({ticks:14,inputs:{[levers[1]]:a,[levers[0]]:b}})
  const last=s.frames[s.frames.length-1]
  const o=last.outputs.find(x=>x.at===lampId)
  console.log('AND',a,b,'->',o&&o.active?1:0)
}

const z=M(andWorld(false,false),[0,65,1],6)
const s=z.run({ticks:4})
console.log('idle dust',JSON.stringify(s.frames[3].dust),'torch',JSON.stringify(s.frames[3].torches))

const zz=M(andWorld(false,false),[0,65,1],6)
console.log('levers',zz.sources().map(s=>s.id+'@'+JSON.stringify(s.state)).join(' '))
const s2=zz.run({ticks:8,inputs:Object.fromEntries(zz.sources().map(s=>[s.id,true]))})
console.log('all-on dust',JSON.stringify(s2.frames[7].dust),'torch',JSON.stringify(s2.frames[7].torches))
