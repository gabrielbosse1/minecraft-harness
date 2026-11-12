'use strict'
/**
 * Measured wire size of the two model calls (audit2, section 7.6/7.7).
 * Wraps the scripted-model fetch, captures raw request bodies per lane, and
 * prints exact byte/char counts (tokens estimated at the repo's 3.7 chars/tok).
 *
 *   node audit/repro/12-call-sizes.js
 */
const { world, simulatedBot, addPlayer, startTestSession, sleep } = require('./_common')

;(async () => {
  const bot = simulatedBot({ items: [['iron_sword'], ['bread', 12]], held: 'iron_sword' })
  const s = startTestSession({
    bot,
    chat: () => ({ text: 'fica em cento e vinte, menos quarenta!' }),
    actions: () => ({ a: 'idle' })
  })

  // capture raw request bodies AFTER the session installs its scripted fetch
  const scripted = globalThis.fetch
  const wire = { chat: [], action: [] }
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    const lane = body.tools?.[0]?.function?.name === 'reply' ? 'chat' : 'action'
    wire[lane].push({
      total: JSON.stringify(body).length,
      tools: JSON.stringify(body.tools || []).length,
      system: String(body.messages[0]?.content || '').length,
      user: String(body.messages[body.messages.length - 1]?.content || '').length
    })
    return scripted(url, opts)
  }

  s.spawn(); await sleep(300)
  addPlayer(bot, 9, 'Gabriel', 3.5, 3.5)
  // a small conversation so the chat lane carries realistic history
  for (const t of ['zinc, tudo bem?', 'onde fica o portal do nether?', 'valeu zinc!']) {
    s.say(`<Gabriel> ${t}`); await sleep(700)
  }
  // then a threat wake for the action lane during conversation context
  world.addApproaching(bot, 100, 'zombie', 10.5, 0.5, 0)
  await sleep(1200)

  const tok = (c) => Math.round(c / 3.7)
  for (const lane of ['chat', 'action']) {
    const calls = wire[lane]
    if (!calls.length) { console.log(`${lane}: no calls captured`); continue }
    const last = calls[calls.length - 1]
    const tot = calls.reduce((a, c) => a + c.total, 0)
    console.log(`${lane}: ${calls.length} call(s). last call on the wire: ${last.total} chars (~${tok(last.total)} tokens) = tools ${last.tools} + system ${last.system} + user ${last.user}`)
    console.log(`   lane total this session: ${tot} chars (~${tok(tot)} tokens)`)
  }
  console.log(`\nlast chat user message (${s.prompts.chat.length ? s.prompts.chat[s.prompts.chat.length - 1].length : 0} chars):`)
  console.log(s.prompts.chat.length ? s.prompts.chat[s.prompts.chat.length - 1] : '(none)')
  s.session.dispose(); process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
