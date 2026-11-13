const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const dw=(o)=>({name:'redstone_wire',state:{power:'0',...o}})
const S=(x,y,z)=>[K(x,y,z),{name:'stone'}]; const st=(x,y,z)=>{st.list.push([K(x,y,z),{name:'stone'}])}; st.list=[];
// Classic 1-torch clock: floor torch T on S; T's output dust runs to a block SB;
// a wall torch on SB inverts it; SB's inverter output dust points back INTO S.
const world=()=>new Map([
  [K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'stone'}],                       // S with floor torch on top
  [K(0,66,0),{name:'redstone_torch',state:{lit:true}}],          // T
  // T's output: dust east along y=66 (needs blocks under: y=65 row)
  [K(1,65,0),{name:'stone'}],[K(1,65,1),{name:'stone'}],[K(2,65,1),{name:'stone'}],
  [K(1,66,0),dw({west:'side',south:'side'})],
  [K(1,66,1),dw({north:'side',east:'side'})],
  // inverter block SB at (2,65,1) powered weakly by that dust -> wall torch on it
  [K(2,66,1),{name:'redstone_wall_torch',state:{facing:'east',lit:true}}],
  // inverter output dust at y=66 going west then pointing into S at (0,65,0)
  [K(1,65,2),{name:'stone'}],[K(0,65,2),{name:'stone'}],
  [K(2,66,2),dw({west:'side',north:'side'})],
  [K(1,66,2),dw({east:'side',west:'side'})],
  [K(0,66,2),dw({east:'side',west:'side',north:'side'})],
  [K(0,66,1),dw({north:'side',south:'side'})],
  [K(0,65,1),dw({south:'side'})],                    // points north into S
  [K(3,64,0),{name:'stone'}],[K(3,65,0),{name:'redstone_lamp',state:{lit:false}}]
])
const m=new E.CircuitModel(E.perceive(bot(world()),{x:1,y:65,z:1,radius:6}).snapshot)
console.log('nodes',m.nodes.length)
const s=m.run({ticks:40})
console.log('osc',s.oscillating,s.period)
console.log('torch',s.frames.map(f=>f.torches['0,66,0']?1:0).join(''))
console.log('lamp ',s.frames.map(f=>f.outputs.map(o=>o.active?1:0).join('')).join(''))
const p=m.solvePower().power
console.log('dust solutions:')
for(const n of m.nodes.filter(n=>n.kind==='dust')) console.log(' ',n.id,JSON.stringify(n.state),'->',p.get(n.id)?.model)
console.log('T',m.nodeAt(0,66,0)&&JSON.stringify(m.inputsOf(m.nodeAt(0,66,0))))
