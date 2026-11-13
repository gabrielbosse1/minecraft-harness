const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
const S=(x,z)=>({name:'stone'})
// ---- XOR layout (y=64 blocks, y=65 dust/torches, y=63 supports) ----
const world=(a,b)=>new Map([
  // input blocks and their levers (wall levers leave the top free)
  [K(0,64,0),S()],[K(1,64,0),{name:'lever',state:{face:'wall',facing:'east',powered:a}}],
  [K(0,64,4),S()],[K(1,64,4),{name:'lever',state:{face:'wall',facing:'east',powered:b}}],
  // O = A ∨ B : dust on top of each input block, joined along x=0
  [K(0,65,0),dw({south:'side'})],
  [K(0,65,1),dw({north:'side',south:'side',east:'side'})],
  [K(0,65,2),dw({north:'side',south:'side'})],
  [K(0,65,3),dw({north:'side',south:'side'})],
  [K(0,65,4),dw({north:'side'})],
  // O points east into block SO=(1,65,2)... wait dust at (0,65,2) points east at (1,65,2)
  [K(1,65,2),S()],                                  // SO, weakly powered by O
  [K(1,65,3),{name:'redstone_wall_torch',state:{facing:'south',lit:true}}],  // T_O = ¬O
  // ¬A and ¬B: wall torches on the far side of the input blocks
  [K(-1,64,0),{name:'redstone_wall_torch',state:{facing:'west',lit:true}}],
  [K(-1,64,4),{name:'redstone_wall_torch',state:{facing:'west',lit:true}}],
  // N = ¬A ∨ ¬B along x=-1
  [K(-1,64,1),dw({north:'side',south:'side'})],
  [K(-1,64,2),dw({north:'side',south:'side',west:'side'})],
  [K(-1,64,3),dw({north:'side',south:'side'})],
  // N points west into SN=(-2,64,2); torch on top = A ∧ B
  [K(-2,64,2),S()],
  [K(-2,65,2),{name:'redstone_torch',state:{lit:true}}],
  // final: ¬O and A∧B both light the line at z=1 which points into SX
  [K(0,64,1),S()],
  [K(0,65,1),dw({north:'side',south:'side',east:'side'})],
  [K(1,64,1),S()],
  [K(1,65,1),dw({north:'side',south:'side',west:'side'})],
  [K(2,64,1),S()],                                  // SX
  [K(2,65,1),{name:'redstone_torch',state:{lit:true}}],
  [K(3,65,1),{name:'redstone_lamp',state:{lit:false}}]
])
const m=new E.CircuitModel(E.perceive(bot(world(false,false)),{x:0,y:65,z:2,radius:6}).snapshot)
const srcs=m.sources().map(s=>s.id).sort()
console.log('srcs',srcs.join('|'))
const lamp=m.mechanisms().find(x=>x.kind==='redstone_lamp').id
let table=''
for(let i=0;i<4;i++){
 const inputs={}; srcs.forEach((id,k)=>inputs[id]=Boolean(i&(1<<(1-k))))
 const s=m.run({ticks:20,inputs}); table+=(s.frames[19].outputs.find(x=>x.at===lamp).active?1:0)
}
console.log('XOR table',table)
console.log('nodes',m.nodes.map(n=>n.id+':'+n.kind).join(' '))
const d=m.run({ticks:6})
console.log('idle dust',JSON.stringify(d.frames[5].dust))
console.log('idle torch',JSON.stringify(d.frames[5].torches))
const P=m.solvePower().power
for(const id of ['0,65,0','0,65,1','-1,64,1']){
  console.log(id, JSON.stringify(P.get(id)))
}
console.log('bp(0,64,0)',JSON.stringify(m.blockPower(0,64,0,P)))
console.log('inputsOf (-1,64,0)',JSON.stringify(m.inputsOf(m.nodeAt(-1,64,0))))
