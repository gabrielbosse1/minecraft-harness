const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(`${p.x},${p.y},${p.z}`);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>`${x},${y},${z}`
const cells=new Map([
 [K(0,64,0),{name:'stone'}],
 [K(0,65,0),{name:'redstone_wire',state:{power:'15',east:'side'}}],
 [K(1,64,0),{name:'stone'}],
 [K(2,64,0),{name:'stone'}],
 [K(1,65,0),{name:'redstone_wire',state:{power:'0',west:'side',east:'side'}}],
 [K(2,65,0),{name:'redstone_wire',state:{power:'0',west:'side'}}]])
const m=new E.CircuitModel(E.perceive(bot(cells),{x:1,y:64,z:0,radius:3}).snapshot)
console.log('nodes',m.nodes.map(n=>n.id+':'+n.kind))
console.log('solid',[...m.solid])
const {power}=m.solvePower()
for(const [k,v] of power) console.log(k, JSON.stringify(v))
