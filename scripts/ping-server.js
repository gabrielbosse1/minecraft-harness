#!/usr/bin/env node
/**
 * Reachability + version check for the configured Minecraft server.
 * Reads the same environment variables as the bot (MC_HOST / MC_PORT /
 * MC_VERSION), never joins, never touches the AMD API.
 *
 *   npm run ping
 *
 * Exit 0 = server answered the status handshake (prints version/player info).
 * Exit 1 = unreachable / tunnel down / payload filtered — see the message.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const settings = require('../src/settings')
const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'zincai', 'config', 'defaults.json'), 'utf8'))

const host = settings.str(['MC_HOST', 'server.host'], defaults.server.host)
const port = settings.int(['MC_PORT', 'server.port'], defaults.server.port, { min: 1, max: 65535 })
const version = settings.str(['MC_VERSION', 'server.version'], defaults.server.version || '')
const auth = settings.str(['MC_AUTH', 'server.auth'], defaults.server.auth || 'offline')

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
  console.log(`pinging ${host}:${port} (bot identity: ZincAI, auth=${auth})`)
  const primary = version || '26.3'
  let r = await tryPing(primary)
  if (!r.ok && primary !== mc.defaultVersion) {
    console.log(`ping with version ${primary} failed (${r.err.code || r.err.message}) — retrying with ${mc.defaultVersion}`)
    r = await tryPing(mc.defaultVersion)
  }
  if (!r.ok) {
    console.error(`FAIL after ${r.ms}ms: ${r.err.code || r.err.message}`)
    console.error('checklist: (1) is the server/tunnel reachable from this host? (2) is MC_PORT correct? (3) is the server online? (4) does MC_AUTH match the server mode?')
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
