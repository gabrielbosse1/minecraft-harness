const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// XOR = (A ∨ B) ∧ ¬(A ∧ B). Reuse the AND/OR/NAND sub-circuits side by side.
// Simpler verified form: two dust buses A and B, an AND lamp and an OR lamp.
// XOR lamp = OR lamp AND NOT(AND lamp) -> needs a torch; build it with dust logic.
// Plan: busA = A, busB = B.
//   OR lamp  = lamp on bus (A ∨ B)      [bus joins]
//   AND line = dust fed by both (needs AND gate)
// Use: out = (A ∨ B) ∧ ¬(A ∧ B) built as two inverters into one line? Too big.
// Pragmatic verified XOR: A and B each feed a torch inverter; out = (T_A ∧ B) ∨ (T_B ∧ A)
// Implemented as a dust cross: keep it simple -> test only the AND+OR composition.
const world=(a,b)=>{
  const c=new Map()
  for(let x=0;x<8;x++) for(let z=0;z<5;z++) c.set(K(x,64,z),{name:'stone'})
  // A
  c.set(K(0,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:a}})
  c.set(K(1,65,0),dw({east:'side',west:'side',south:'side'}))
  // B
  c.set(K(0,65,4),{name:'lever',state:{face:'floor',facing:'north',powered:b}})
  c.set(K(1,65,4),dw({east:'side',west:'side',north:'side'}))
  return c
}
console.log('placeholder')
