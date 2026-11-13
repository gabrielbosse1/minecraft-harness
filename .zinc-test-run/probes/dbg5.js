const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
function rig(mode,rear,left,right){
  const cells=new Map([
    [K(1,64,0),{name:'stone'}],
    [K(1,65,0),{name:'redstone_wire',state:{power:String(rear),east:'side'}}],
    [K(2,64,0),{name:'comparator',state:{facing:'west',mode,powered:false}}],
    [K(3,64,0),{name:'redstone_lamp',state:{lit:false}}]])
  if(left!=null){cells.set(K(2,64,1),{name:'redstone_wire',state:{power:String(left),west:'none',north:'side'}});cells.set(K(2,64,2),{name:'stone'});cells.set(K(2,65,1),{name:'redstone_block'})}
  if(right!=null){cells.set(K(2,64,-1),{name:'redstone_wire',state:{power:String(right),west:'none',south:'side'}});cells.set(K(2,64,-2),{name:'stone'});cells.set(K(2,65,-1),{name:'redstone_block'})}
  return cells
}
for(const [mode,r,l,rt] of [['compare',15,10,10],['compare',10,12,3],['compare',7,7,2],['compare',0,null,null],['subtract',15,4,2],['subtract',4,4,0],['subtract',4,7,6]]){
  const m=new E.CircuitModel(E.perceive(bot(rig(mode,r,l,rt)),{x:2,y:64,z:0,radius:3}).snapshot)
  const s=m.run({ticks:6})
  const p=m.solvePower().power
  console.log(mode,r,l,rt,'lamp',s.frames.map(f=>f.outputs[0].active?1:0).join(''),
   'Ldust',p.get(K(2,64,1))?.model,'Rdust',p.get(K(2,64,-1))?.model,'reardust',p.get(K(1,65,0))?.model)
}
