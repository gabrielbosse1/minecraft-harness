const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// XOR = (A ∨ B) ∧ ¬(A ∧ B) = AND(O, N)
// O = A ∨ B  (dust line)
// N = ¬A ∨ ¬B (dust line)  -> N = ¬(A ∧ B)
// AND(O,N): the AND front end inverts each input with a torch on a block that the
// input line points INTO, then ORs the two torch outputs, then inverts.
function world(a,b){
  const c=new Map()
  // ---- input blocks with wall levers (leave the top free) ----
  c.set(K(0,64,0),{name:'stone'}); c.set(K(1,64,0),{name:'lever',state:{face:'wall',facing:'east',powered:a}})
  c.set(K(0,64,6),{name:'stone'}); c.set(K(1,64,6),{name:'lever',state:{face:'wall',facing:'east',powered:b}})
  // ---- O = A ∨ B : dust on the input blocks joined along x=0 at z=0..6 ----
  c.set(K(0,65,0),dw({south:'side'}))
  for(let z=1;z<=5;z++) c.set(K(0,65,z),dw({north:'side',south:'side',w:eastSide(z)}))
  function eastSide(z){return (z===3)?'side':undefined}
  c.set(K(0,65,6),dw({north:'side'}))
  // O points east at z=3 into block SO => no; keep O purely for the AND input later.
  return c
}
console.log('scaffold')
