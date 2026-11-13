const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr,r)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:r}).snapshot)
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})

// AND / NAND (one plane). Inputs are levers standing on their own block next to
// each inverter support, so a lever strongly powers exactly one support block.
function andWorld(){
  return new Map([
    [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'redstone_torch',state:{lit:true}}],   // S_A, T_A = ¬A
    [K(0,64,2),{name:'stone'}],[K(0,65,2),{name:'redstone_torch',state:{lit:true}}],   // S_B, T_B = ¬B
    [K(0,65,1),dw({north:'side',south:'side',east:'side'})],                            // OR line
    [K(1,65,1),{name:'stone'}],                                                        // S_C
    [K(1,66,1),{name:'redstone_torch',state:{lit:true}}],                              // T_C = A ∧ B
    [K(2,66,1),{name:'redstone_lamp',state:{lit:false}}],
    // input A: lever on its own block, beside S_A
    [K(0,64,-1),{name:'stone'}],[K(0,65,-1),{name:'lever',state:{face:'floor',facing:'south',powered:false}}],
    // input B: lever on its own block, beside S_B
    [K(0,64,3),{name:'stone'}],[K(0,65,3),{name:'lever',state:{face:'floor',facing:'north',powered:false}}]
  ])
}
const base=M(andWorld(),[0,65,1],6)
const [lA,lB]=base.sources().map(s=>s.id)
const lampId=K(2,66,1)
let table=''
for(const [a,b] of [[false,false],[false,true],[true,false],[true,true]]){
  const m=M(andWorld(),[0,65,1],6)
  const s=m.run({ticks:14,inputs:{[lA]:a,[lB]:b}})
  const last=s.frames[s.frames.length-1]
  const o=last.outputs.find(x=>x.at===lampId)
  table+= (o&&o.active?1:0)
}
console.log('AND truth table (00,01,10,11) =',table)
const m0=M(andWorld(),[0,65,1],6)
console.log('nodes',m0.nodes.map(n=>n.id+':'+n.kind).join(' '))
const s0=m0.run({ticks:6})
console.log('dust',JSON.stringify(s0.frames[5].dust))
console.log('torches',JSON.stringify(s0.frames[5].torches))
console.log('inputsOf 0,65,1',JSON.stringify(m0.inputsOf(m0.nodeAt(0,65,1)).map(i=>i.dir+'/'+(i.node&&i.node.id))))
console.log('bp(0,64,0)',JSON.stringify(m0.blockPower(0,64,0,m0.solvePower().power)))
