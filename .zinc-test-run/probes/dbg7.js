const E=require('/home/user/minecraft-harness/zincai/redstone_engine')
function bot(cells){return{version:'1.21.4',game:{dimension:'minecraft:overworld'},entity:{position:{x:0,y:64,z:0}},
 blockAt(p){const c=cells.get(p.x+','+p.y+','+p.z);return c?{name:c.name,getProperties:()=>c.state||{}}:{name:'air',getProperties:()=>({})}}}}
const K=(x,y,z)=>x+','+y+','+z
const M=(c,ctr=2)=>new E.CircuitModel(E.perceive(bot(c),{x:ctr[0],y:ctr[1],z:ctr[2],radius:ctr[3]}).snapshot)

// U1 lever on the head cell's block
let c=new Map([[K(0,64,0),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}]])
for(let i=0;i<=16;i++){c.set(K(-i,64,0),{name:'stone'});c.set(K(-i,65,0),{name:'redstone_wire',state:{power:'0',east:i===0?'none':'side',west:i===16?'none':'side',north:'none',south:'none'}})}
let p=M(c,[-8,65,0,6]).solvePower().power
console.log('U1', Array.from({length:18},(_,i)=>p.get(K(-i,65,0))?.model??0).join(','))

// U3c step up: lower (0,64,0) east=up, higher (1,65,0) west=side
const mk=(up)=>new Map([[K(0,64,0),{name:'redstone_wire',state:{power:'0',east:up?'up':'none'}}],
 [K(0,63,0),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(0,63,1),{name:'stone'}],
 [K(1,64,0),{name:'stone'}],[K(1,65,0),{name:'redstone_wire',state:{power:'0',west:'side'}}]])
console.log('U3c up', M(mk(true),[0,64,0,3]).solvePower().power.get(K(1,65,0))?.model, 'off', M(mk(false),[0,64,0,3]).solvePower().power.get(K(1,65,0))?.model)

// U2c repeater front into block
c=new Map([[K(0,64,0),{name:'stone'}],[K(0,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(1,64,0),{name:'repeater',state:{facing:'west',delay:'1',powered:true}}],
 [K(2,64,0),{name:'stone'}],[K(2,65,0),{name:'redstone_wire',state:{power:'0'}}],
 [K(3,64,0),{name:'stone'}],[K(3,65,0),{name:'redstone_wire',state:{power:'0',west:'side'}}]])
p=M(c,[2,64,0,3]).solvePower().power
console.log('U2c top',p.get(K(2,65,0))?.model,'next',p.get(K(3,65,0))?.model)

// U2d weak power: dust on top of block (1,64,0), lamp below it
c=new Map([[K(1,64,0),{name:'stone'}],[K(1,65,0),{name:'redstone_wire',state:{power:'0'}}],
 [K(1,63,0),{name:'redstone_lamp',state:{lit:false}}],
 [K(1,64,2),{name:'stone'}],[K(1,64,3),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(2,64,0),{name:'stone'}],[K(2,65,0),{name:'redstone_wire',state:{power:'0',west:'none'}}]])
const m2=M(c,[1,64,0,3]); p=m2.solvePower().power
console.log('U2d dust',p.get(K(1,65,0))?.model,'lamp',JSON.stringify(m2.predictMechanism(m2.nodeAt(1,63,0),p).expected),'fresh',p.get(K(2,65,0))?.model)

// U4d front power not reaching rear
c=new Map([[K(1,64,0),{name:'stone'}],[K(1,64,1),{name:'lever',state:{face:'wall',facing:'south',powered:true}}],
 [K(2,64,0),{name:'repeater',state:{facing:'east',delay:'1',powered:false}}],
 [K(3,64,0),{name:'redstone_lamp',state:{lit:false}}]])
console.log('U4d', M(c,[2,64,0,3]).run({ticks:8}).frames.map(f=>f.outputs[0].active?1:0).join(''))

// U6a torch inversion: lever powers the support block
const torchRig=(on)=>{const cc=new Map([[K(1,64,0),{name:'stone'}],
 [K(1,64,-1),{name:'stone'}],[K(1,64,-2),{name:'lever',state:{face:'wall',facing:'south',powered:on}}],
 [K(1,65,0),{name:'redstone_torch',state:{lit:!on}}],
 [K(2,64,0),{name:'redstone_lamp',state:{lit:false}}]]);return cc}
for(const on of [false,true]){const mm=M(torchRig(on),[1,64,0,3]);const s=mm.run({ticks:6})
 console.log('U6a on='+on,'lamp',s.frames.map(f=>f.outputs[0].active?1:0).join(''))}
