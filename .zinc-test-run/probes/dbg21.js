const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr,r)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:r}).snapshot)
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// inputs feed the support blocks from the SIDE at the support level
function andWorld(){
  return new Map([
    [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'redstone_torch',state:{lit:true}}],  // S_A / T_A
    [K(0,64,2),{name:'stone'}],[K(0,65,2),{name:'redstone_torch',state:{lit:true}}],  // S_B / T_B
    [K(0,65,1),dw({north:'side',south:'side',east:'side'})],                          // OR line
    [K(1,65,1),{name:'stone'}],[K(1,66,1),{name:'redstone_torch',state:{lit:true}}],  // S_C / T_C
    [K(2,66,1),{name:'redstone_lamp',state:{lit:false}}],
    // input A: dust at the support level pointing into S_A, fed by a lever
    [K(0,63,-1),{name:'stone'}],[K(0,64,-1),dw({east:'side'})],
    [K(0,63,-2),{name:'stone'}],[K(0,64,-2),{name:'lever',state:{face:'floor',facing:'east',powered:false}}],
    // input B: same on the +z side
    [K(0,63,3),{name:'stone'}],[K(0,64,3),dw({east:'none',north:'side'})],
    [K(0,63,4),{name:'stone'}],[K(0,64,4),{name:'lever',state:{face:'floor',facing:'north',powered:false}}]
  ])
}
const m0=M(andWorld(),[0,65,1],6)
console.log('nodes',m0.nodes.map(n=>n.id+':'+n.kind).join(' '))
const lev=m0.sources().map(s=>s.id); console.log('levers',lev)
let table=''
for(const [a,b] of [[false,false],[false,true],[true,false],[true,true]]){
  const m=M(andWorld(),[0,65,1],6)
  const s=m.run({ticks:16,inputs:{[lev[0]]:a,[lev[1]]:b}})
  const t=s.frames[15]
  table += (t.outputs.find(x=>x.at===K(2,66,1))?.active?1:0)
  if(table.length<=1||a&&b) console.log(a,b,'dust',JSON.stringify(t.dust),'torch',JSON.stringify(t.torches))
}
console.log('AND table',table)
