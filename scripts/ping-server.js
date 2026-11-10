#!/usr/bin/env node
/**
 * Reachability + version check for the configured Minecraft server.
 * Uses the same .env as the bot, never joins, never touches the AMD API.
 *
 *   npm run ping
 *
 * Exit 0 = server answered the status handshake (prints version/player info).
 * Exit 1 = unreachable / tunnel down / payload filtered — see the message.
 */
'use strict'

const { loadConfig } = require('../src/config')

const cfg = loadConfig()
const { host, port, version, username, auth } = cfg.mc

let mc
try {
  mc = require('minecraft-protocol')
} catch (err) {
  console.error('minecraft-protocol not installed — run npm ci first')
  process.exit(1)
}

async function tryPing (v) {
  const t0 = Date.now()
  try {
    const res = await mc.ping({ host, port, version: v })
    return { ok: true, res, ms: Date.now() - t0, used: v }
  } catch (err) {
    return { ok: false, err, ms: Date.now() - t0, used: v }
  }
}

;(async () => {
  console.log(`pinging ${host}:${port} (bot identity: ${username}, auth=${auth})`)
  const primary = version || '26.3'
  let r = await tryPing(primary)
  if (!r.ok && primary !== mc.defaultVersion) {
    console.log(`ping with version ${primary} failed (${r.err.code || r.err.message}) — retrying with ${mc.defaultVersion}`)
    r = await tryPing(mc.defaultVersion)
  }
  if (!r.ok) {
    console.error(`FAIL after ${r.ms}ms: ${r.err.code || r.err.message}`)
    console.error('checklist: (1) is the ply.gg tunnel running? (2) is MC_PORT correct? (3) is the server actually online? (4) MC_AUTH matches server mode?')
    process.exit(1)
  }
  const v = r.res.version || {}
  const p = r.res.players || {}
  console.log(`OK in ${r.ms}ms (as ${r.used})`)
  console.log(`  version: ${v.name || '?'} (protocol ${v.protocol ?? '?'})`)
  console.log(`  players: ${p.online ?? '?'}/${p.max ?? '?'}`)
  const motd = typeof r.res.description === 'string' ? r.res.description : (r.res.description && r.res.description.text) || JSON.stringify(r.res.description).slice(0, 120)
  if (motd) console.log(`  motd:    ${String(motd).replace(/\s+/g, ' ').trim()}`)
  process.exit(0)
})().catch((err) => { console.error('ping crashed:', err); process.exit(1) })
