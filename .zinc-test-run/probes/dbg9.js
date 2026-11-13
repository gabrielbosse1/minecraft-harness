const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:ctr[3]}).snapshot)

// U2d corrected
let c=new Map([
 [K(0,63,0),{name:'redstone_block'}],
 [K(0,64,0),{name:'redstone_wire',state:{power:'0',east:'side'}}],
 [K(0,63,-1),{name:'stone'}],
 [K(1,63,0),{name:'stone'}],[K(1,64,0),{name:'redstone_wire',state:{power:'0',west:'side',east:'side'}}],[K(1,63,-1),{name:'stone'}],
 [K(2,63,0),{name:'stone'}],[K(2,64,0),{name:'redstone_wire',state:{power:'0',west:'side',east:'side'}}],[K(2,63,-1),{name:'stone'}],
 [K(3,64,0),{name:'stone'}],            // weakly powered target
 [K(3,64,1),{name:'redstone_lamp',state:{lit:false}}],  // mechanism: ON
 [K(3,65,0),{name:'redstone_wire',state:{power:'0',north:'none'}}]  // dust on top: stays 0
])
let m=M(c,[2,64,0,4]); let p=m.solvePower().power
console.log('U2d dustAt2',p.get(K(2,64,0))?.model,'lamp',JSON.stringify(m.predictMechanism(m.nodeAt(3,64,1),p)?.expected),'topDust',p.get(K(3,65,0))?.model)

// U2c
c=new Map([[K(0,64,0),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(1,64,0),{name:'repeater',state:{facing:'west',delay:'1',powered:true}}],
 [K(2,64,0),{name:'stone'}],[K(2,65,0),{name:'redstone_wire',state:{power:'0',east:'none'}}],
 [K(3,64,0),{name:'stone'}],[K(3,65,0),{name:'redstone_wire',state:{power:'0',west:'side'}}]])
p=M(c,[2,64,0,3]).solvePower().power
console.log('U2c top',p.get(K(2,65,0))?.model,'next',p.get(K(3,65,0))?.model)

// U6d repeater strongly powers a support block; the torch on it turns off
c=new Map([[K(0,64,0),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(1,64,0),{name:'repeater',state:{facing:'west',delay:'1',powered:true}}],
 [K(2,64,0),{name:'stone'}],
 [K(2,65,0),{name:'redstone_torch',state:{lit:true}}],
 [K(3,64,0),{name:'redstone_lamp',state:{lit:false}}]])
m=M(c,[2,64,0,3]); let s=m.run({ticks:8})
console.log('U6d lamp',s.frames.map(f=>f.outputs[0].active?1:0).join(''),'torch',s.frames.map(f=>f.torches[K(2,65,0)]?1:0).join(''))

// U6e a torch does not power the block it is attached to
c=new Map([[K(1,64,0),{name:'stone'}],[K(1,65,0),{name:'redstone_torch',state:{lit:true}}],
 [K(2,64,0),{name:'stone'}],[K(2,65,0),{name:'redstone_wire',state:{power:'0',west:'none'}}],
 [K(0,64,0),{name:'redstone_lamp',state:{lit:false}}]])
m=M(c,[1,65,0,3]); p=m.solvePower().power
console.log('U6e supportBlockPowered?',JSON.stringify(m.blockPower(1,64,0,p)),'dustBeside',p.get(K(2,65,0))?.model)

// U7c observer triggers when `changes` names the observer itself
c=new Map([[K(0,64,-1),{name:'stone'}],[K(0,64,0),{name:'observer',state:{facing:'north',powered:false}}],
 [K(0,64,1),{name:'redstone_lamp',state:{lit:false}}]])
m=M(c,[0,64,0,3])
console.log('U7c selfChange lamp',m.run({ticks:6,changes:['0,64,0']}).frames.map(f=>f.outputs[0].active?1:0).join(''))
