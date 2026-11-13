const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
// XOR via De Morgan twice, using only dust + torches on powered blocks:
//   X = (A ∨ B) ∧ ¬(A ∧ B)
// Stage 1 (input inverters): T_A = ¬A, T_B = ¬B -> NAND line N = ¬A ∨ ¬B = ¬(A∧B)
// Stage 2: OR line O = A ∨ B  (A and B each point into a shared dust cell)
// Stage 3: X = O ∧ N. The NAND line N points into block S1; a torch on S1 is ¬N = A∧B.
//          Then X = ¬(¬O ∨ (A∧B)) -> OR the ¬O line and the (A∧B) line into block S2,
//          torch on S2 = X.
const world=(a,b)=>new Map([
 [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:a}}],
 [K(0,64,4),{name:'stone'}],[K(0,65,4),{name:'lever',state:{face:'floor',facing:'north',powered:b}}],
 [K(1,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(1,64,4),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 // N = ¬A ∨ ¬B  (straight line z=1..3)
 [K(1,64,1),dw({north:'side',south:'side'})],
 [K(1,64,2),dw({north:'side',south:'side',east:'side'})],
 [K(1,64,3),dw({north:'side',south:'side'})],
 // O = A ∨ B  (line at z=-1: A and B each point into (0,64,-1))
 [K(0,64,-1),dw({north:'side',south:'side',east:'side'})],
 [K(1,64,-1),dw({west:'side'})],
 // ¬O: block S_no at (2,64,-1) is powered by O; the wall torch on it is ¬O
 [K(2,64,-1),{name:'stone'}],
 [K(2,64,-2),{name:'redstone_wall_torch',state:{facing:'north',lit:true}}],
 // A∧B : the NAND line points into block S1 at (2,64,2); a torch on S1 = A∧B
 [K(2,64,2),{name:'stone'}],
 [K(2,64,3),{name:'redstone_wall_torch',state:{facing:'north',lit:true}}],
 // X = ¬( ¬O ∨ (A∧B) ): both torch outputs light the line at z=3 -> block S2 at (3,64,3)
 [K(2,64,3),{name:'redstone_wall_torch',state:{facing:'north',lit:true}}]
])
// too tangled; test pieces separately
console.log('piecewise')
