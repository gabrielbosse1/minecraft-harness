const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:ctr[3]}).snapshot)

// U2d weak power: block powered by dust pointing in
let c=new Map([
 [K(0,63,0),{name:'redstone_block'}],
 [K(0,64,0),{name:'redstone_wire',state:{power:'0',east:'side'}}],
 [K(0,63,-1),{name:'stone'}],
 [K(1,63,0),{name:'stone'}],
 [K(1,64,0),{name:'redstone_wire',state:{power:'0',west:'side',east:'none'}}],
 [K(1,63,-1),{name:'stone'}],
 [K(2,63,0),{name:'stone'}],
 [K(2,64,0),{name:'redstone_wire',state:{power:'0',west:'side',east:'none'}}],
 [K(2,63,-1),{name:'stone'}],
 [K(3,64,0),{name:'stone'}],          // target block
 [K(3,65,0),{name:'redstone_lamp',state:{lit:false}}],
 [K(3,63,0),{name:'redstone_wire',state:{power:'0'}}],
 [K(4,64,0),{name:'stone'}],[K(4,63,0),{name:'stone'}],
 [K(4,64,0),{name:'stone'}],
 [K(4,65,0),{name:'redstone_wire',state:{power:'0',west:'none'}}]
])
let m=M(c,[2,64,0,4]); let p=m.solvePower().power
console.log('U2d dust',p.get(K(2,64,0))?.model,'lampOn',JSON.stringify(m.predictMechanism(m.nodeAt(3,65,0),p)?.expected),'topDust',p.get(K(3,63,0))?.model,'far',p.get(K(4,65,0))?.model)

// U6a torch inversion, lever attached to the support block
const torchRig=(on)=>new Map([
 [K(1,64,0),{name:'stone'}],
 [K(1,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:on}}],
 [K(1,65,0),{name:'redstone_torch',state:{lit:!on}}],
 [K(2,64,0),{name:'redstone_lamp',state:{lit:false}}]
])
for(const on of [false,true]){
  const mm=M(torchRig(on),[1,64,0,3]); const s=mm.run({ticks:6})
  console.log('U6a on='+on,'lamp',s.frames.map(f=>f.outputs[0].active?1:0).join(''),'torch',s.frames.map(f=>f.torches[K(1,65,0)]?1:0).join(''))
}

// U4d: front power must not travel backwards (lever on the FRONT side, not the rear)
c=new Map([
 [K(2,64,0),{name:'repeater',state:{facing:'east',delay:'1',powered:false}}],
 [K(1,64,0),{name:'redstone_lamp',state:{lit:false}}],
 [K(1,64,1),{name:'stone'}],
 [K(1,64,2),{name:'lever',state:{face:'wall',facing:'south',powered:true}}]
])
console.log('U4d', M(c,[2,64,0,4]).run({ticks:8}).frames.map(f=>f.outputs[0].active?1:0).join(''))
