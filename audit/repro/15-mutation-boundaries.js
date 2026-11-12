'use strict'
// Offline diagnostic: synthetic bot and scripted model; dig/place are mocked.
// No Minecraft server, live model, or actual world mutation occurs.
// Run from the repository root: node audit/repro/15-mutation-boundaries.js
const { req, world, simulatedBot, startTestSession, sleep } = require('./_common')
const { coerceAction } = req('zincai/api_wrapper')
const action = (name, args = {}) =>
  coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })
const snap = () => ({ threatIds: [], askedBy: null, reasons: [] })
async function gather(mode) {
  const b = simulatedBot({
    blocks: { '2,64,0': 'oak_log' },
    items: mode === 'matching-resource' ? [] : [['wooden_axe']]
  })
  const events = []
  let release
  let equipWaiting = false
  const origEquip = b.equip
  if (mode !== 'matching-resource')
    b.equip = async (item, dest) => {
      if (item?.name === 'wooden_axe') {
        equipWaiting = true
        events.push('equip-wait')
        await new Promise((r) => (release = r))
      }
      await origEquip(item, dest)
    }
  const s = startTestSession({ bot: b, actions: [{ a: 'gather', item: 'oak_log', count: 1 }] })
  b.dig = async (block) =>
    events.push({
      event: 'dig',
      name: block.name,
      where: [block.position.x, block.position.y, block.position.z],
      owner: s.internals().arbiter.owner()
    })
  try {
    s.spawn()
    if (mode === 'matching-resource') {
      await s.until(() => events.some((e) => e?.event === 'dig'), 4000)
      await s.until(() => s.internals().results.some((r) => r.label === 'gather'), 4000)
    } else {
      if (!(await s.until(() => equipWaiting, 4000))) throw Error('no pending axe equip')
      if (mode === 'stop') {
        await s.internals().executeAction(action('stop'), snap())
        events.push('stop-returned')
      } else {
        world.addMob(b, 70, 'zombie', b.entity.position.x + 2, b.entity.position.z)
        b.pathfinder.getPathFromTo = function* () {
          yield { result: { status: 'success', path: [] } }
        }
        if (!(await s.until(() => s.internals().system1.fleeing && s.internals().arbiter.owner() === 'survival', 2500)))
          throw Error('survival did not preempt')
        events.push('survival-took-control')
      }
      release()
      release = null
      await s.until(() => events.some((e) => e?.event === 'dig'), 3000)
      await sleep(100)
    }
    return {
      mode,
      canDig: b.pathfinder.movements.canDig,
      events,
      results: s
        .internals()
        .results.filter((r) => r.label === 'gather' || r.label === 'stop')
        .map(({ label, ok, msg }) => ({ label, ok, msg }))
    }
  } finally {
    if (release) release()
    s.stop()
  }
}
async function buildStop() {
  const b = simulatedBot({ items: [['cobblestone', 4]] })
  let release,
    waiting = false,
    placed = false
  const events = []
  const origEquip = b.equip,
    origBlock = b.blockAt.bind(b)
  b.equip = async (item, dest) => {
    if (item?.name === 'cobblestone') {
      waiting = true
      events.push('equip-wait')
      await new Promise((r) => (release = r))
    }
    await origEquip(item, dest)
  }
  b.blockAt = (p, ...args) =>
    placed && Math.floor(p.x) === 2 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0
      ? { name: 'cobblestone', position: new world.Vec3(2, 64, 0), boundingBox: 'block' }
      : origBlock(p, ...args)
  const s = startTestSession({
    bot: b,
    actions: [{ a: 'build', grid: [['#']], palette: { '#': 'cobblestone' }, at: [2, 64, 0] }],
    cfg: (cfg) => {
      cfg.behavior.mode = 'builder'
    }
  })
  b.placeBlock = async (ref, face) => {
    events.push({
      event: 'place',
      ref: [ref.position.x, ref.position.y, ref.position.z],
      face: [face.x, face.y, face.z],
      owner: s.internals().arbiter.owner()
    })
    placed = true
  }
  try {
    s.spawn()
    if (!(await s.until(() => waiting, 4000)))
      throw Error('no pending build equip; ' + JSON.stringify(s.internals().results))
    await s.internals().executeAction(action('stop'), snap())
    events.push('stop-returned')
    release()
    release = null
    await s.until(() => events.some((e) => e?.event === 'place'), 2000)
    await sleep(300)
    return {
      events,
      placed,
      results: s
        .internals()
        .results.filter((r) => r.label === 'build' || r.label === 'stop')
        .map(({ label, ok, msg }) => ({ label, ok, msg }))
    }
  } finally {
    if (release) release()
    s.stop()
  }
}
async function shelterStop() {
  const b = simulatedBot({ items: [['dirt', 8]] })
  let release,
    waiting = false
  const events = []
  let dest = null
  const origEquip = b.equip,
    origBlock = b.blockAt.bind(b),
    origControl = b.setControlState
  b.equip = async (item, destn) => {
    if (item?.name === 'dirt' && !waiting) {
      waiting = true
      events.push('equip-wait')
      await new Promise((r) => (release = r))
    }
    await origEquip(item, destn)
  }
  b.setControlState = (key, value) => {
    if (key === 'jump' && value) events.push({ event: 'jump', postStop: events.includes('stop-returned') })
    origControl(key, value)
  }
  b.blockAt = (p, ...args) =>
    dest && Math.floor(p.x) === dest.x && Math.floor(p.y) === dest.y && Math.floor(p.z) === dest.z
      ? { name: 'dirt', position: new world.Vec3(dest.x, dest.y, dest.z), boundingBox: 'block' }
      : origBlock(p, ...args)
  b.placeBlock = async (ref, face) => {
    events.push({ event: 'place', postStop: events.includes('stop-returned') })
    dest = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
    b.entity.position.y = 67
  }
  b.dig = async (block) => {
    events.push({ event: 'cleanup', name: block.name })
    dest = null
  }
  const s = startTestSession({ bot: b, actions: [{ a: 'shelter' }] })
  try {
    s.spawn()
    if (!(await s.until(() => waiting, 4000))) throw Error('no pending shelter equip')
    await s.internals().executeAction(action('stop'), snap())
    events.push('stop-returned')
    release()
    release = null
    await s.until(() => events.some((e) => e?.event === 'place'), 3000)
    await sleep(300)
    return {
      events,
      results: s
        .internals()
        .results.filter((r) => r.label === 'stop' || r.label === 'shelter')
        .map(({ label, ok, msg }) => ({ label, ok, msg }))
    }
  } finally {
    if (release) release()
    s.stop()
  }
}
;(async () => {
  for (const mode of ['matching-resource', 'stop', 'preempt']) console.log('gather', JSON.stringify(await gather(mode)))
  console.log('build', JSON.stringify(await buildStop()))
  console.log('shelter', JSON.stringify(await shelterStop()))
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
