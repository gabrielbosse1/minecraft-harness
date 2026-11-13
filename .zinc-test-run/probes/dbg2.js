const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(`${p.x},${p.y},${p.z}`);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>`${x},${y},${z}`
const M=(cells,c,dx,r)=>new E.CircuitModel(E.perceive(bot(cells),{x:c[0],y:c[1],z:c[2],radius:r}).snapshot)

// U2b torch under block
let m=M(new Map([
 [K(1,63,0),{name:'redstone_torch',state:{lit:true}}],
 [K(1,64,0),{name:'stone'}],
 [K(1,65,0),{name:'redstone_wire',state:{power:'0'}}],
 [K(2,64,0),{name:'redstone_wire',state:{power:'0'}}],
 [K(0,64,0),{name:'stone'}],[K(2,63,0),{name:'stone'}],[K(0,65,0),{name:'stone'}],[K(2,65,0),{name:'stone'}]]),[1,64,0],0,3)
let p=m.solvePower().power
console.log('U2b top=',p.get(K(1,65,0))?.model,'side=',p.get(K(2,64,0))?.model)
console.log('   blockPower 1,64,0 =',JSON.stringify(m.blockPower(1,64,0,p)))

// U3a vertical stack
m=M(new Map([[K(0,64,0),{name:'stone'}],[K(0,65,0),{name:'redstone_wire',state:{power:'15'}}],[K(0,66,0),{name:'redstone_wire',state:{power:'0'}}]]),[0,65,0],0,2)
p=m.solvePower().power
console.log('U3a upper=',p.get(K(0,66,0))?.model, 'codes', m.diagnose().map(f=>f.code))

// U4a repeater delay
m=M(new Map([
 [K(0,64,0),{name:'stone'}],
 [K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(1,64,0),{name:'repeater',state:{facing:'west',delay:'1',powered:false}}],
 [K(2,64,0),{name:'redstone_lamp',state:{lit:false}}]]),[1,64,0],0,3)
let sim=m.run({ticks:10})
console.log('U4a series', sim.frames.map(f=>f.outputs[0].active?1:0).join(''))
console.log('   rear level sees?', JSON.stringify(m.inputsOf(m.nodeAt(1,64,0))))
