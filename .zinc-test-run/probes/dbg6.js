const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
// chain of dust whose LAST cell reads 15 (redstone block under it); level falls by 1 per step
function chain(cells, x,y,z, dx,dz, level){
  const n = 16 - level
  for(let i=0;i<n;i++){
    const cx=x+dx*i, cz=z+dz*i
    cells.set(K(cx,y-1,cz),{name:'stone'})
    cells.set(K(cx,y,cz),{name:'redstone_wire',state:{power:'0'}})
  }
  const fx=x+dx*(n-1), fz=z+dz*(n-1)
  cells.set(K(fx,y-1,fz),{name:'redstone_block'})
}
function rig(mode, rear, left, right){
  const c=new Map()
  c.set(K(0,64,0),{name:'comparator',state:{facing:'west',mode,powered:false}})
  c.set(K(1,64,0),{name:'redstone_lamp',state:{lit:false}})
  if(rear>0){ c.set(K(-1,64,0),{name:'stone'}); c.set(K(-1,65,0),{name:'redstone_wire',state:{power:'0'}})
    // rear chain runs west along x, starting at the cell on top of the rear block
    chain(c,-1,65,0,-1,0,rear) }
  if(left>0){ chain(c,0,64,1,0,1,left) }
  if(right>0){ chain(c,0,64,-1,0,-1,right) }
  return c
}
for(const [mode,r,l,rt] of [['compare',15,10,10],['compare',11,12,10],['compare',12,12,12],['compare',0,0,0],['subtract',15,10,10],['subtract',12,12,12],['subtract',15,12,10],['subtract',10,10,10]]){
  const m=new E.CircuitModel(E.perceive(bot(rig(mode,r,l,rt)),{x:0,y:64,z:0,radius:6}).snapshot)
  const s=m.run({ticks:6})
  const last=s.frames[s.frames.length-1]
  console.log(mode,r,l,rt,'lamp',s.frames.map(f=>f.outputs[0].active?1:0).join(''),'level',JSON.stringify(last.comparators))
}
