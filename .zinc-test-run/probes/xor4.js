const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
/**
 * XOR built only from the two verified primitives.
 *  O  = A ∨ B      : dust on the two input blocks, joined along x=0
 *  N  = ¬A ∨ ¬B    : wall torches on the input blocks, joined along x=-1
 * Then AND(O,N) with the verified AND front end:
 *  - O is read by an inverter: O points east into block P1, torch on P1 = ¬O
 *  - N is read by an inverter: N points west into block P2, torch on P2 = ¬N
 *  - those two torches light one line L = ¬O ∨ ¬N
 *  - L points into block P3, torch on P3 = ¬(¬O ∨ ¬N) = O ∧ N = XOR
 */
function world(a,b){
  const c=new Map()
  // input blocks + wall levers (top stays free for the OR line)
  c.set(K(0,64,0),{name:'stone'}); c.set(K(1,64,0),{name:'lever',state:{face:'wall',facing:'east',powered:a}})
  c.set(K(0,64,4),{name:'stone'}); c.set(K(1,64,4),{name:'lever',state:{face:'wall',facing:'east',powered:b}})
  // O = A ∨ B, dust on the input blocks, straight run at x=0
  c.set(K(0,65,0),dw({south:'side'}))
  c.set(K(0,65,1),dw({north:'side',south:'side'}))
  c.set(K(0,65,2),dw({north:'side',south:'side',east:'side'}))   // points east into P1
  c.set(K(0,65,3),dw({north:'side',south:'side'}))
  c.set(K(0,65,4),dw({north:'side'}))
  // N = ¬A ∨ ¬B: wall torches on the input blocks (west face -> facing west)
  c.set(K(-1,64,0),{name:'redstone_wall_torch',state:{facing:'west',lit:true}})
  c.set(K(-1,64,4),{name:'redstone_wall_torch',state:{facing:'west',lit:true}})
  c.set(K(-1,64,1),dw({north:'side',south:'side'}))
  c.set(K(-1,64,2),dw({north:'side',south:'side',east:'side'}))  // points east into P2 (block at 0,64,2)
  c.set(K(-1,64,3),dw({north:'side',south:'side'}))
  return c
}
const m=new E.CircuitModel(E.perceive(bot(world(false,false)),{x:0,y:65,z:2,radius:6}).snapshot)
const srcs=m.sources().map(s=>s.id).sort()
for(const [a,b] of [[false,false],[true,true]]){
  const mm=new E.CircuitModel(E.perceive(bot(world(a,b)),{x:0,y:65,z:2,radius:6}).snapshot)
  const p=mm.solvePower().power
  console.log(a,b,'O(0,65,2)=',p.get(K(0,65,2))?.model,'N(-1,64,2)=',p.get(K(-1,64,2))?.model,
   'bp(0,64,2)',JSON.stringify(mm.blockPower(0,64,2,p)))
}
console.log('nodes',m.nodes.map(n=>n.id+':'+n.kind).join(' '))
