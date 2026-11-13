const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o,tag)=>({name:'redstone_wire',state:{power:'0',...o}})
// XOR = (A ∨ B) ∧ ¬(A ∧ B)
//  - Torches T_A = ¬A, T_B = ¬B  (each fed by the input lever through one dust cell
//    pointing into the lever block? no: the lever stands on its own block and
//    strongly powers it, so a wall torch on THAT block is ¬input.)
//  - AND-of-the-inputs: the two input blocks each weakly/strongly light a shared cell
//  - out = (A∨B) ∧ ¬(A∧B)
const world=(a,b)=>new Map([
 // input blocks (lever on top strongly powers them)
 [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'lever',state:{face:'floor',facing:'south',powered:a}}],
 [K(0,64,4),{name:'stone'}],[K(0,65,4),{name:'lever',state:{face:'floor',facing:'north',powered:b}}],
 // T_A = ¬A and T_B = ¬B hung on their own input blocks
 [K(1,64,0),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 [K(1,64,4),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
 // NAND line: T_A and T_B each light it while their input is off
 [K(1,64,1),dw({north:'side',south:'side'})],
 [K(1,64,2),dw({north:'side',south:'side',east:'side'})],
 [K(1,64,3),dw({north:'side',south:'side'})],
 // NAND output = lamp on that line
 [K(2,64,2),{name:'redstone_lamp',state:{lit:false}}],
 // AND of A and B: both input blocks also drive a shared dust cell (A∧B)
 [K(0,64,2),{name:'redstone_wire',state:{power:'0',north:'side',south:'side'}}],
 // out cell: NAND line east AND the (A∧B) line -> build a torch stage:
 // inverter on (A∧B): wall torch on block (0,64,3)? block must be strongly powered by A∧B
 [K(0,64,3),{name:'stone'}],
 [K(1,64,3),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}]  // conflicts with the NAND line
])
console.log('needs a different topology')
