const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// XOR = (A ∧ ¬B) ∨ (¬A ∧ B). Build each term as its own two-stage torch AND.
// Term1: ¬B is a torch on B's block; then T1 = ¬(A ∧ ¬B)? Let us instead use
// the classic 4-torch design:
//   I_A = ¬A, I_B = ¬B  (torches on the input blocks)
//   M_A = ¬(A ∧ I_B)  ... needs an AND of dust.
// Verified simple design: two "input inverters" + one dust cross where each arm
// carries A resp. B; XOR = dust-of-(A∨B) gated by an inverter on the (A∧B) line.
// Keep it concrete instead: implement XOR as (A∨B) ∧ NAND, i.e. one AND gate with
// inputs OR and NAND, reusing the verified AND geometry twice.
const andBlocks=(ox,oz,a1,a2)=>[
 [K(ox,64,oz+0),{name:'stone'}],[K(ox,65,oz+0),{name:'lever',state:{face:'floor',facing:'south',powered:a1}}],
 [K(ox+1,64,oz+0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(ox+1,64,oz+1),dw({north:'side',south:'side'})],
 [K(ox+1,64,oz+2),dw({north:'side',south:'side',east:'side'})],
 [K(ox+1,64,oz+3),dw({north:'side',south:'side'})],
 [K(ox,64,oz+4),{name:'stone'}],[K(ox,65,oz+4),{name:'lever',state:{face:'floor',facing:'north',powered:a2}}],
 [K(ox+1,64,oz+4),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(ox+2,64,oz+2),{name:'stone'}],[K(ox+2,65,oz+2),{name:'redstone_torch',state:{lit:true}}]
]
const w=(a,b)=>new Map([
 ...andBlocks(0,0,a,b),            // NAND at (2,65,2)
 [K(0,63,2),{name:'stone'}],
 [K(5,65,2),{name:'redstone_lamp',state:{lit:false}}]
])
console.log('nand reuse')
