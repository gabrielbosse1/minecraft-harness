'use strict'
/**
 * B5 evidence, post-fix (audit2, 7.3): before the fix, the ACTION prompt's
 * memory recall was driven by the LAST chat line on EVERY wake — however old
 * it was — so a question asked hours ago steered recall into a zombie flee
 * prompt. The fix bounds the recall query to chat no older than
 * memory.chatRecallMaxAgeMs (default 120 s): recent chat still surfaces what
 * the player just asked about (that is what makes "where is the portal?"
 * useful), stale chat no longer does.
 *
 * This script shows both halves:
 *   1. FRESH chat: a zombie wake right after the question DOES carry the
 *      recalled portal fact (the intentional behaviour is preserved).
 *   2. STALE chat: the same line aged an hour does NOT — the recall section
 *      is gone from the threat wake entirely.
 *
 *   node audit/repro/13-stale-request.js
 */
const { world, simulatedBot, addPlayer, startTestSession, sleep } = require('./_common')

/** Extract the query-driven recall section (recalled:/memories: + its '- x' lines). */
function recallSection (prompt) {
  const lines = prompt.split('\n')
  const i = lines.findIndex((l) => /^(recalled|memories):/.test(l))
  if (i < 0) return []
  const out = [lines[i]]
  for (let j = i + 1; j < lines.length && /^- /.test(lines[j]); j++) out.push(lines[j])
  return out
}

function assert2 (ok, msg) {
  if (!ok) { console.error('!! ' + msg); process.exitCode = 1 }
}

;(async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot, chat: () => ({ text: 'boas!' }), actions: () => ({ a: 'idle' }) })
  try {
    s.spawn(); await sleep(300)
    addPlayer(bot, 9, 'Gabriel', 3.5, 3.5)

    // a long-term fact about the portal, promoted (like a remembered build place)
    s.shared.memory.addEvent({ type: 'place', msg: 'o portal do nether fica em 120, 64, -40', tags: ['portal', 'nether'] }, { promote: true })

    // the player chats (unrelated to any future wake), gets an answer
    s.say('<Gabriel> zinc, onde fica o portal do nether?')
    await sleep(600)

    // 1) while the chat is FRESH: recall on a threat wake is allowed to follow it
    const before1 = s.prompts.action.length
    world.addApproaching(bot, 100, 'zombie', 9.5, 0.5, 0.05)
    await s.until(() => s.prompts.action.length > before1, 4000)
    const fresh = recallSection(s.prompts.action[s.prompts.action.length - 1])
    console.log('FRESH chat — recall section in the flee wake:')
    for (const l of fresh) console.log('  ', l)
    console.log(fresh.length ? '  => OK: recent chat still surfaces what was asked about (intended).' : '  !! regression: recent chat no longer drives recall')

    // 2) hours later, model-wise: the same wake, but the question is stale.
    // End the first episode properly first: the reflex ignores new arrivals
    // while it is already fleeing, so a second zombie only matters after the
    // first one is really gone (otherwise the "stale" capture is actually the
    // pre-aging prompt - that trap made this repro lie once already).
    bot.stopSim?.() // freeze the world ticker, then take the mob off the field
    delete bot.entities[100]
    assert2(await s.until(() => !s.internals().system1.fleeing, 9000), 'first flee episode must end')
    const line = [...s.shared.chatLog].reverse().find((l) => l.who !== 'me')
    line.ts = Date.now() - 3_600_000 // pretend it was said an hour ago
    const before2 = s.prompts.action.length
    world.addMob(bot, 101, 'zombie', 9.5, -0.5) // standing, still inside the 12 m trigger ring
    assert2(await s.until(() => s.prompts.action.length > before2, 4000), 'a second flee wake must fire')
    const stale = recallSection(s.prompts.action[s.prompts.action.length - 1])
    console.log('\nSTALE chat (1 h old) — recall section in the flee wake:')
    for (const l of stale) console.log('  ', l)
    console.log(stale.length
      ? '  !! REGRESSION: hours-old chat still steers recall (pre-fix B5 behaviour)'
      : '  => FIXED: no query-driven recall in this wake; the flee prompt stays on-topic')

    s.stop()

    // control: fresh session, no chat at all, same zombie
    const bot2 = simulatedBot()
    const s2 = startTestSession({ bot: bot2, actions: () => ({ a: 'idle' }) })
    try {
      s2.spawn(); await sleep(300)
      world.addApproaching(bot2, 100, 'zombie', 9.5, 0.5, 0.05)
      await s2.until(() => s2.prompts.action.length > 1, 4000)
      const ctrl = recallSection(s2.prompts.action[s2.prompts.action.length - 1])
      console.log(`\ncontrol (no chat ever): recall lines in the same flee wake: ${ctrl.length}`)
    } finally { s2.stop() }
  } catch (e) { try { s.stop() } catch { /* noop */ } throw e }
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
