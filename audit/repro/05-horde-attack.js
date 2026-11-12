'use strict'
/**
 * Scene 1, the other branch: the model answers "attack zombie" while 12 zombies converge.
 * Damage model (crude, for illustration only): a bot hit does 8, zombies have 20 hp and
 * hit for 3 once a second from 1.5 blocks (normal difficulty, no armour).
 */
const { world, simulatedBot, startTestSession, sleep, line } = require('./_common')
const N = Number(process.argv[2] || 12)

;(async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['cooked_beef', 12]], held: 'iron_sword' })
  const calls = []
  const s = startTestSession({
    bot,
    actions: (p) => {
      const act = /FLEEING by reflex/.test(p) && /zombie/.test(line(p, 'threats:')) ? { a: 'attack', target: 'zombie' } : null
      calls.push({ t: Date.now(), text: `${line(p, 'why now:').slice(0, 120)}  → ${act ? 'attack zombie' : 'idle'}` })
      return act
    },
    cfg: (cfg) => { cfg.inference = { ...cfg.inference, minIntervalMs: 3000, rpm: 18, heartbeatMs: 90000 }; cfg.system1 = { ...cfg.system1, tickMs: 200 } }
  })
  s.spawn(); await sleep(300)
  const t0 = Date.now()
  const mobs = []
  for (let i = 0; i < N; i++) { const a = (i / N) * 2 * Math.PI * 0.6; const r = 9 + (i % 4) * 2; const m = world.addMob(bot, 100 + i, 'zombie', 0.5 + Math.sin(a) * r, 0.5 - Math.cos(a) * r); m.hp = 20; mobs.push(m) }
  let kills = 0; let hits = 0
  bot.on('test_attack', (e) => {
    const m = mobs.find((x) => x.id === e?.id)
    if (!m || !bot.entities[m.id] || Math.hypot(bot.entity.position.x - m.position.x, bot.entity.position.z - m.position.z) > 3.3) return
    if ((m.hp -= 8) <= 0) { kills++; delete bot.entities[m.id]; bot.emit('entityDead', m); bot.emit('entityGone', m) }
  })
  const lastHit = new Map()
  const sim = setInterval(() => {
    const me = bot.entity.position
    for (const m of mobs) {
      if (!bot.entities[m.id]) continue
      const dx = me.x - m.position.x; const dz = me.z - m.position.z; const d = Math.hypot(dx, dz) || 1
      if (d > 1.0) { m.position.x += dx / d * Math.min(0.115, d); m.position.z += dz / d * Math.min(0.115, d) }
      if (d < 1.5 && bot.health > 0 && Date.now() - (lastHit.get(m.id) || 0) > 1000) {
        lastHit.set(m.id, Date.now()); hits++
        bot.health = Math.max(0, bot.health - 3)
        bot.emit('entityHurt', bot.entity, m); bot.emit('health')
      }
    }
  }, 50)
  const trace = []
  const tr = setInterval(() => {
    const me = bot.entity.position
    const near = mobs.filter((m) => bot.entities[m.id]).map((m) => Math.hypot(me.x - m.position.x, me.z - m.position.z))
    const i = s.internals()
    trace.push(`t=${((Date.now() - t0) / 1000).toFixed(1).padStart(4)}s hp=${String(bot.health).padStart(2)} kills=${kills} zombies within 3 blocks=${near.filter((d) => d <= 3).length} driver=${i.arbiter.owner()} combat=${i.combat.state}`)
  }, 1500)
  await sleep(15000)
  clearInterval(sim); clearInterval(tr)
  console.log(`${N} zombies, model says "attack zombie": ${kills} killed, ${hits} hits taken, hp ${bot.health}/20 after 15 s\n`)
  for (const l of trace) console.log('  ' + l)
  console.log('\nmodel calls:'); for (const c of calls) console.log(`  +${((c.t - t0) / 1000).toFixed(0).padStart(2)}s ${c.text}`)
  // audit2 B1 proof: after the FailGate fix the doomed loop is cut locally.
  // Before the fix this scene showed 6 attack calls / 14 s, each ~3.7k tokens;
  // after it, the 3rd identical attempt is refused with "skipped:" and no wake.
  const attacks = calls.filter((c) => /→ attack/.test(c.text)).length
  const skipped = s.internals().results.filter((r) => /skipped: the exact same/.test(r.msg)).length
  console.log(`\nFailGate evidence: ${attacks} attack calls total (was 6 pre-fix), ${skipped} local "skipped:" refusal(s)`)
  if (!skipped) console.log('  !! gate did NOT fire — regression')
  else console.log('  OK — the churn loop is cut without spending a model call')
  s.stop(); process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
