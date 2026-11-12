'use strict'
/**
 * B2 evidence (audit2, 7.3): a hostile mob VISIBLE but penned behind a fence
 * inside the 12 m trigger ring is classified as a live threat (real = LoS) —
 * the reachability probe only ever ADDS hidden hostiles, never demotes a
 * visible contained one (zincai/threats.js:511-514). Expected correct
 * behavior: classification = hidden/watch, no flee episode.
 *
 *   node audit/repro/14-penned-mob.js
 *
 * Run A (control): same zombie in the open — flee SHOULD start.
 * Run B: zombie sealed inside a one-block oak-fence pen — flee should NOT start.
 */
const { world, simulatedBot, startTestSession, sleep } = require('./_common')

function penBlocks (cx, cz) {
  const b = {}
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue
    b[`${cx + dx},64,${cz + dz}`] = 'oak_fence'
  }
  return b
}

async function run (label, fenced) {
  const bot = simulatedBot({ blocks: fenced ? penBlocks(8, 0) : {} })
  const s = startTestSession({ bot, actions: () => ({ a: 'idle' }) })
  s.spawn(); await sleep(400)
  world.addMob(bot, 100, 'zombie', 8.5, 0.5) // 8 m east, static, LoS over the fence
  await sleep(1200) // several reflex ticks (50 ms in test pace)
  const snap = s.internals().sense.assess()
  const classified = snap.threats.some((t) => t.id === 100) ? 'THREAT'
    : snap.watch.some((t) => t.id === 100) ? 'watch'
      : snap.hidden.some((t) => t.id === 100) ? 'hidden' : 'unlisted'
  const fled = s.prompts.action.some((p) => /started FLEEING/.test(p))
  console.log(`${label}: classification=${classified} | flee episode started: ${fled ? 'YES' : 'no'}`)
  s.session.dispose()
  return { classified, fled }
}

;(async () => {
  console.log('zombie 8 m away, static; the bot has full line of sight in both runs\n')
  const a = await run('A control (open ground)   ', false)
  const b = await run('B fenced pen (contained) ', true)
  console.log()
  if (a.fled && b.fled) console.log('=> CONFIRMED B2: penned-visible mob behaves exactly like a loose one (flee + model wake).')
  else if (a.fled && !b.fled) console.log('=> fixed: containment demoted the penned zombie.')
  else if (!a.fled) console.log('=> unexpected: control did not flee — check rig.')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
