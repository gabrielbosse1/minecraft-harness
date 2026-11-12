#!/usr/bin/env node
/**
 * amd-canary.js — 60-second live proof that the configured endpoint can drive
 * this harness, BEFORE deploying the bot (audit2 roadmap item H).
 *
 * Checks, worst things first:
 *   1. base reachability + auth           (one bare ping call)
 *   2. tool_choice: "required" honored    (must emit a tool call, not text)
 *      — the client auto-falls back to "auto"; this canary TELLS YOU which
 *        mode your endpoint actually serves, so a weak model isn't silently
 *        running the legacy JSON path.
 *   3. the reply tool round-trip          (chat lane exactly as zincai does it)
 *   4. a PT-BR guard sample               (is the chosen language enforceable)
 *
 * Usage:   AMD_API_KEY=... node scripts/amd-canary.js
 *          (reads AMD_API_BASE_URL / AMD_MODEL like zincai/config.json; env wins)
 */
'use strict'
require('dotenv').config()
const fs = require('fs')
const path = require('path')

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zincai', 'config.json'), 'utf8'))
const baseUrl = process.env.AMD_API_BASE_URL || cfg.amd?.baseUrl
const model = process.env.AMD_MODEL || cfg.amd?.model
const apiKey = process.env.AMD_API_KEY || process.env.API_KEY || process.env.RADEON_API_KEY || cfg.amd?.apiKey

if (!apiKey || !baseUrl || !model) {
  console.error('need AMD_API_KEY (+ AMD_API_BASE_URL/AMD_MODEL or config.json amd.* values)')
  process.exit(2)
}

const { AmdToolsClient, createZincTools, createChatTools } = require('../zincai/api_wrapper')

const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return cond
}

;(async () => {
  const client = new AmdToolsClient({
    apiKey, baseUrl, model,
    timeoutMs: cfg.amd?.timeoutMs ?? 20_000,
    maxRetries: cfg.amd?.maxRetries ?? 2,
    temperature: cfg.amd?.temperature ?? 0.25,
    maxTokens: 128
  })
  let all = true

  const t0 = Date.now()
  // 1. reachability with the chat lane's real payload shape
  let reply
  try {
    reply = await client.chatReply([
      { role: 'system', content: 'You are a tool-calling test probe for a Minecraft bot. Always call the reply tool.' },
      { role: 'user', content: 'state: hp 20 | day\nplayer Gabriel says: oi! tudo bem?\nAnswer with exactly one reply tool call, in Brazilian Portuguese.' }
    ], { maxTokens: 120 })
  } catch (err) {
    ok('endpoint reachable + tool-capable', false, String(err.message || err).slice(0, 200))
    console.log('\nNothing else can be checked without a working call. Fix endpoint/key/model first.')
    process.exit(1)
  }
  all = ok('endpoint reachable (chat lane round trip)', true, `${Date.now() - t0} ms`) && all
  all = ok('reply tool call parsed', typeof reply.reply?.text === 'string', JSON.stringify(reply.reply).slice(0, 120)) && all
  all = ok('reply is Portuguese-guard passable', reply.reply?.text ? require('../zincai/filter').checkPortuguese(reply.reply.text, { names: ['Gabriel'] }).ok : false, JSON.stringify(reply.reply?.text)) && all

  // required vs auto
  const mode = client.toolChoice
  console.log(`INFO  tool_choice served as: "${mode}"${mode === 'auto' ? ' (endpoint rejected "required"; the client fell back — weaker models may need the legacy JSON parser path)' : ''}`)

  // 2. action lane, one tool
  try {
    const { action, usage } = await client.chatWithTools([
      { role: 'system', content: 'You drive a Minecraft bot by calling exactly one tool per turn. If nothing needs doing, call idle.' },
      { role: 'user', content: 'state: hp 20/20 food 20/20 | day\nthreats: none\nwhy now: canary test\nCall the idle tool.' }
    ], createZincTools())
    all = ok('action lane tool call parsed', typeof action?.a === 'string', JSON.stringify(action).slice(0, 120)) && all
    console.log(`INFO  usage reported: in=${usage?.prompt_tokens ?? usage?.promptTokens ?? '?'} cached=${usage?.prompt_tokens_details?.cached_tokens ?? usage?.cachedTokens ?? 'n/a'} — metrics.jsonl will carry these in production`)
  } catch (err) {
    all = ok('action lane', false, String(err.message || err).slice(0, 200))
  }

  console.log(all ? '\nALL GOOD — the model can drive both lanes.' : '\nPROBLEMS ABOVE — fix before deploying.')
  process.exit(all ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
