/**
 * Campaign supervisor for zinc-autonomous-test.
 *
 * Durable state: manifest.json (atomic writes, tmp+rename) + append-only events.jsonl.
 *   node supervisor.js init
 *   node supervisor.js record <testId> <pass|fail|skip|interrupt> [detail]
 *   node supervisor.js stage <name>
 *   node supervisor.js status
 *   node supervisor.js monitor      (foreground loop: health + metrics sampling)
 *   node supervisor.js stop         (graceful: bot SIGTERM, then RCON stop)
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MANIFEST = path.join(ROOT, 'reports', 'manifest.json')
const EVENTS = path.join(ROOT, 'reports', 'events.jsonl')
const METRICS = path.join(ROOT, 'metrics')
const SERVER_LOG = path.join(ROOT, 'logs', 'server.out')
const BOT_LOG = path.join(ROOT, 'logs', 'bot.log')
const MC_PORT = 25570
const RCON = path.join(__dirname, 'rcon.js')

const now = () => new Date().toISOString()
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const ts = (s) => (s ? new Date(s).getTime() : 0)

function load () {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch {
    return {
      campaign: 'zinc-autonomous-test',
      started_at: null, deadline: null,
      current_stage: 'setup', current_stage_since: null,
      completed_tests: [], failed_tests: [], skipped_tests: [], interrupted_tests: [],
      server_pid: null, bot_pid: null,
      server_restarts: 0, bot_restarts: 0,
      incidents: [], notes: []
    }
  }
}
function save (m) {
  const tmp = MANIFEST + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2))
  fs.renameSync(tmp, MANIFEST)
}
function event (type, data) {
  fs.appendFileSync(EVENTS, JSON.stringify({ t: now(), type, ...data }) + '\n')
}
function isAlive (pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function rcon (cmd) {
  const r = spawnSync('node', [RCON, cmd], { encoding: 'utf8', timeout: 15000 })
  return (r.stdout || '').trim()
}

const [cmd, arg1, arg2, arg3] = process.argv.slice(2)

switch (cmd) {
  case 'init': {
    const start = Date.now()
    const m = load()
    m.started_at = now()
    m.deadline = new Date(start + 4 * 3600 * 1000).toISOString() // hard 4h wall clock
    m.current_stage = 'setup'
    m.current_stage_since = m.started_at
    save(m)
    event('campaign_start', { deadline: m.deadline })
    console.log(JSON.stringify(m, null, 2))
    break
  }
  case 'record': {
    const [id, status, detail] = [arg1, arg2, arg3 || '']
    const m = load()
    const bucket = { pass: 'completed_tests', fail: 'failed_tests', skip: 'skipped_tests', interrupt: 'interrupted_tests' }[status]
    if (!bucket) { console.error('bad status'); process.exit(1) }
    if (!m[bucket].some((t) => t.id === id)) m[bucket].push({ id, status, detail, at: now() })
    save(m)
    event('test', { id, status, detail })
    console.log(`recorded ${id} = ${status} (${m.completed_tests.length} pass / ${m.failed_tests.length} fail / ${m.skipped_tests.length} skip)`)
    break
  }
  case 'stage': {
    const m = load()
    m.current_stage = arg1
    m.current_stage_since = now()
    save(m)
    event('stage', { stage: arg1 })
    console.log(`stage -> ${arg1}`)
    break
  }
  case 'note': {
    const m = load()
    m.notes.push({ at: now(), text: arg1 })
    save(m)
    event('note', { text: arg1 })
    console.log('noted')
    break
  }
  case 'incident': {
    const m = load()
    m.incidents.push({ at: now(), kind: arg1, detail: arg2 || '' })
    save(m)
    event('incident', { kind: arg1, detail: arg2 })
    console.log('incident recorded')
    break
  }
  case 'status': {
    const m = load()
    const elapsed = m.started_at ? (Date.now() - ts(m.started_at)) / 60000 : 0
    const remaining = m.deadline ? (ts(m.deadline) - Date.now()) / 60000 : 0
    console.log(JSON.stringify({
      stage: m.current_stage,
      stage_since: m.current_stage_since,
      elapsed_min: elapsed.toFixed(1),
      remaining_min: remaining.toFixed(1),
      pass: m.completed_tests.length, fail: m.failed_tests.length,
      skip: m.skipped_tests.length, interrupt: m.interrupted_tests.length,
      server_alive: isAlive(m.server_pid), bot_alive: isAlive(m.bot_pid),
      server_pid: m.server_pid, bot_pid: m.bot_pid,
      incidents: m.incidents.length
    }, null, 2))
    break
  }
  case 'sample': {
    // One metrics snapshot: process resources + server TPS if available.
    const m = load()
    if (!m.started_at) { console.error('not started'); process.exit(1) }
    const snap = { t: now(), stage: m.current_stage,
      elapsed_s: Math.round((Date.now() - ts(m.started_at)) / 1000) }
    const rss = (pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')
        return Math.round(parseInt(stat[23], 10) * os.constants.mem.PAGE_SIZE / 1048576 * 10) / 10 // MiB
      } catch { return null }
    }
    snap.server_rss_mib = rss(m.server_pid)
    snap.bot_rss_mib = rss(m.bot_pid)
    const mem = os.freemem()
    snap.system_free_mib = Math.round(mem / 1048576)
    snap.server_alive = isAlive(m.server_pid)
    snap.bot_alive = isAlive(m.bot_pid)
    if (isAlive(m.server_pid)) {
      snap.tps = rcon('tps 1').split('\n')[0] || 'n/a'
    }
    // model call metrics from ZincAI data dir
    const mj = path.join(ROOT, 'zincai-data', 'metrics.jsonl')
    try {
      const lines = fs.readFileSync(mj, 'utf8').trim().split('\n').filter(Boolean)
      const last = JSON.parse(lines[lines.length - 1])
      snap.model_calls_total = lines.length
      snap.last_model = { at: last.ts, in: last.in, out: last.out, ms: last.ms, cached: last.cached }
    } catch { /* no model calls yet */ }
    const out = path.join(METRICS, 'samples.jsonl')
    fs.appendFileSync(out, JSON.stringify(snap) + '\n')
    if (process.argv[3] === 'print') console.log(JSON.stringify(snap))
    break
  }
  case 'monitor': {
    // Long-running health monitor (run in background): samples every 60s,
    // detects dead server/bot, records incidents. Does NOT restart anything —
    // the orchestrator (me) decides restarts with bounded attempts.
    event('monitor_start', {})
    while (true) {
      const m = load()
      if (m.deadline && Date.now() > ts(m.deadline)) {
        event('deadline_reached', {})
        break
      }
      try { require('child_process').execSync('node ' + JSON.stringify(__filename) + ' sample', { timeout: 20000 }) } catch { /* */ }
      const m2 = load()
      if (!isAlive(m2.server_pid) && m2.current_stage !== 'shutdown') {
        event('server_down', { stage: m2.current_stage })
      }
      if (!isAlive(m2.bot_pid) && m2.current_stage !== 'shutdown') {
        event('bot_down', { stage: m2.current_stage, bot_pid: m2.bot_pid })
      }
      // deadline: write a flag file the orchestrator checks
      const freeMem = os.freemem()
      if (freeMem < 512 * 1048576) event('low_memory', { free_mib: Math.round(freeMem / 1048576) })
      sleepSync(60000)
    }
    console.log('monitor: deadline reached or exiting')
    break
  }
  case 'stop': {
    // Graceful shutdown: bot first, then server.
    const m = load()
    if (isAlive(m.bot_pid)) {
      try { process.kill(m.bot_pid, 'SIGTERM') } catch { /* */ }
      for (let i = 0; i < 30 && isAlive(m.bot_pid); i++) sleepSync(1000)
      if (isAlive(m.bot_pid)) { try { process.kill(m.bot_pid, 'SIGKILL') } catch { /* */ } }
      event('bot_stopped', { pid: m.bot_pid })
    }
    if (isAlive(m.server_pid)) {
      const out = rcon('stop')
      console.log(out)
      for (let i = 0; i < 60 && isAlive(m.server_pid); i++) sleepSync(1000)
      if (isAlive(m.server_pid)) { try { process.kill(m.server_pid, 'SIGKILL') } catch { /* */ } }
      event('server_stopped', { pid: m.server_pid })
    }
    m.current_stage = 'shutdown'
    save(m)
    break
  }
  default:
    console.error('usage: supervisor.js <init|record|stage|note|incident|status|sample|monitor|stop> [args]')
    process.exit(1)
}
