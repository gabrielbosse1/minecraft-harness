const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(m,c,r)=>new E.CircuitModel(E.perceive(bot(m),{x:c[0],y:c[1],z:c[2],radius:r}).snapshot)

// comparator rig with lever rear + dust sides
function rig(mode, rearOn, left, right){
  const c=new Map([[K(1,63,0),{name:'stone'}],[K(2,63,0),{name:'stone'}],
    [K(1,64,0),{name:'lever',state:{face:'floor',facing:'east',powered:rearOn}}],
    [K(2,64,0),{name:'comparator',state:{facing:'west',mode,powered:false}}],
    [K(3,64,0),{name:'redstone_lamp',state:{lit:false}}]])
  if(left!=null){c.set(K(2,63,1),{name:'stone'});c.set(K(2,64,1),{name:'redstone_wire',state:{power:String(left)}})}
  if(right!=null){c.set(K(2,63,-1),{name:'stone'});c.set(K(2,64,-1),{name:'redstone_wire',state:{power:String(right)}})}
  return c
}
for(const [mode,rear,l,r] of [['compare',true,10,10],['compare',true,null,null],['subtract',true,4,2],['subtract',true,7,6]]){
  const m=M(rig(mode,rear,l,r),[2,64,0],3)
  const sim=m.run({ticks:6})
  console.log(mode,'rear',rear,'L',l,'R',r,'-> lamp series',sim.frames.map(f=>f.outputs[0].active?1:0).join(''))
}

// U2c: repeater into block, dust above the block
let c=new Map([[K(0,64,0),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'floor',facing:'east',powered:true}}],
 [K(1,64,0),{name:'repeater',state:{facing:'west',delay:'1',powered:true}}],
 [K(2,64,0),{name:'stone'}],[K(2,65,0),{name:'redstone_wire',state:{power:'0'}}]])
let m=M(c,[2,64,0],3)
console.log('U2c top-of-block =', m.solvePower().power.get(K(2,65,0))?.model)

// torch inversion: lever on the support block itself
c=new Map([[K(1,64,0),{name:'stone'}],[K(1,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:false}}],
 [K(1,65,0),{name:'redstone_torch',state:{lit:true}}],[K(2,64,0),{name:'redstone_lamp',state:{lit:false}}]])
m=M(c,[1,64,0],3)
console.log('U6a cold: torches',m.run({ticks:4}).frames.map(f=>f.torches[K(1,65,0)]?1:0).join(''),'lamp',m.run({ticks:4}).frames.map(f=>f.outputs[0].active?1:0).join(''))

// observer
c=new Map([[K(0,64,-1),{name:'stone'}],[K(0,64,0),{name:'observer',state:{facing:'north',powered:false}}],
 [K(0,64,1),{name:'stone'}],[K(0,65,1),{name:'redstone_lamp',state:{lit:false}}]])
m=M(c,[0,64,0],3)
const s=m.run({ticks:8,changes:['0,64,-1']})
console.log('U7a observer pulse', s.frames.map(f=>f.outputs[0].active?1:0).join(''), JSON.stringify(s.frames.map(f=>f.observers)))
