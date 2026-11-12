'use strict'
// Offline diagnostic: synthetic entities/world and scripted model; not a game.
// Run from the repository root: node audit/repro/16-threat-boundaries.js
const { req, world, simulatedBot, addPlayer, startTestSession, sleep } = require('./_common')
const { makeReachabilityCheck, ThreatSense, hasLineOfSight } = req('zincai/threats')
const { Movements, goals } = world

// A close hostile behind a wall, where the path outcome is not known. This
// intentionally records current behavior rather than asserting that it is safe.
function occludedStatus(reachable) {
  const b = simulatedBot({ blocks: { '2,64,0': 'stone', '2,65,0': 'stone', '2,66,0': 'stone' } })
  try {
    const mob = world.addMob(b, 10, 'zombie', 4.5, 0.5)
    const picture = new ThreatSense(b, { reachable: () => reachable }).assess()
    return {
      reachable,
      lineOfSight: hasLineOfSight(b, mob),
      threats: picture.threats.length,
      hidden: picture.hidden.length,
      caged: picture.hidden[0]?.caged ?? false
    }
  } finally {
    b.stopSim()
  }
}

async function checkStatus(status) {
  const b = simulatedBot()
  try {
    const mob = world.addMob(b, 10, 'zombie', 4.5, 0.5)
    b.pathfinder.getPathFromTo = function* () {
      yield { result: { status, path: [] } }
    }
    const check = makeReachabilityCheck(b, { Movements, goals, cacheMs: 0 })
    const sense = new ThreatSense(b, { reachable: check })
    const r = sense.assess()
    return {
      status,
      reachable: check(mob),
      threats: r.threats.length,
      hidden: r.hidden.length,
      caged: r.hidden[0]?.caged ?? false
    }
  } finally {
    b.stopSim()
  }
}
async function sessionThreat(kind) {
  const b = simulatedBot()
  b.pathfinder.getPathFromTo = function* () {
    yield { result: { status: 'timeout', path: [] } }
  }
  const s = startTestSession({ bot: b })
  try {
    s.spawn()
    await sleep(200)
    if (kind === 'zombie') world.addMob(b, 10, 'zombie', 4.5, 0.5)
    if (kind === 'arrow') world.addMob(b, 10, 'arrow', 4.5, 0.5, { vx: -0.8, type: 'object' })
    if (kind === 'stranger') addPlayer(b, 10, 'NeutralGuest', 4.5, 0.5, 'diamond_sword')
    await sleep(250)
    const { sense, system1, arbiter, buildActionPrompt } = s.internals()
    const r = sense.assess()
    await system1.tick()
    const prompt = buildActionPrompt(['audit probe']).text
    return {
      kind,
      threats: r.threats.map((e) => e.name),
      hidden: r.hidden.map((e) => ({ name: e.name, caged: e.caged })),
      fleeing: system1.fleeing,
      owner: arbiter.owner(),
      lines: prompt.split('\n').filter((l) => /^(threats|mobs|players):/.test(l))
    }
  } finally {
    s.stop()
  }
}
async function actualHorde() {
  const b = simulatedBot({ items: [['iron_sword'], ['bread', 6]], held: 'iron_sword' })
  addPlayer(b, 2, 'Gabriel', -30.5, -30.5)
  const counts = {}
  const orig = b.pathfinder.getPathFromTo
  b.pathfinder.getPathFromTo = function* (...args) {
    for (const v of orig.apply(this, args)) {
      const status = v?.result?.status ?? 'unknown'
      counts[status] = (counts[status] || 0) + 1
      yield v
    }
  }
  const s = startTestSession({
    bot: b,
    cfg: (cfg) => {
      cfg.inference = { ...cfg.inference, minIntervalMs: 3000, chatMinIntervalMs: 1200, rpm: 18, heartbeatMs: 0 }
      cfg.system1 = { ...cfg.system1, tickMs: 200 }
    }
  })
  let timer
  try {
    s.spawn()
    await sleep(300)
    const before = s.prompts.action.length
    const mobs = []
    for (let i = 0; i < 14; i++) {
      const a = ((-60 + i * 9) * Math.PI) / 180
      mobs.push(
        world.addMob(b, 100 + i, 'zombie', 0.5 + Math.sin(a) * (8 + (i % 3) * 5), 0.5 + Math.cos(a) * (8 + (i % 3) * 5))
      )
    }
    timer = setInterval(() => {
      const me = b.entity.position
      for (const m of mobs) {
        const dx = me.x - m.position.x,
          dz = me.z - m.position.z,
          d = Math.hypot(dx, dz) || 1
        if (d > 1) {
          m.position.x += (dx / d) * 0.115
          m.position.z += (dz / d) * 0.115
        }
      }
    }, 50)
    const found = await s.until(() => s.prompts.action.length > before, 4500)
    const p = s.prompts.action[before] || ''
    return {
      found,
      probeStatuses: counts,
      firstLines: p.split('\n').filter((l) => /^(threats|mobs|why now):/.test(l)),
      fleeing: s.internals().system1.fleeing
    }
  } finally {
    clearInterval(timer)
    s.stop()
  }
}
;(async () => {
  for (const status of ['success', 'partial', 'timeout', 'noPath', 'unexpected'])
    console.log('status', JSON.stringify(await checkStatus(status)))
  for (const reachable of [true, false, null]) console.log('occluded', JSON.stringify(occludedStatus(reachable)))
  for (const kind of ['zombie', 'arrow', 'stranger']) console.log('session', JSON.stringify(await sessionThreat(kind)))
  console.log('horde', JSON.stringify(await actualHorde()))
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
