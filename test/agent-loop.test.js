/**
 * agent-loop.test.js — the supervisor that keeps the agent alive.
 *
 * Every case is a failure the operator actually sees ("it keeps getting
 * kicked"), driven by a fake clock and a fake link so the escalation ladder can
 * be checked exactly: revive → force restart → crash-loop stop.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { AgentLoop } = require('../zincai/agent_loop')
const { LinkWatchdog } = require('../zincai/watchdog')

/** A RuntimeConfig-shaped stub: only what the loop reads. */
function config (values = {}) {
  const v = {
    'agent.enabled': true,
    'agent.intervalMs': 15_000,
    'agent.surviveKicks': true,
    'agent.forceRestartAfterMs': 180_000,
    'agent.crashLoopDrops': 6,
    'agent.crashLoopWindowMs': 300_000,
    'agent.stallStormMs': 1_000,
    ...values
  }
  return { get: (name) => v[name] }
}

/** A ConnectionManager-shaped stub whose snapshot the test mutates. */
function link (initial = {}) {
  const s = {
    state: 'CONNECTED',
    since: 0,
    paused: false,
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    lastEnd: null,
    ...initial
  }
  const calls = []
  return {
    state: s,
    calls,
    snapshot: () => ({ ...s }),
    join: (o) => { calls.push(['join', o]); return { ok: true } },
    restart: (o) => { calls.push(['restart', o]); return { ok: true } },
    rejoin: (o) => { calls.push(['rejoin', o]); return { ok: true } }
  }
}

function fakeClock (start = 0) {
  let t = start
  const timers = []
  return {
    now: () => t,
    advance: (ms) => { t += ms },
    setInterval: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h },
    clearInterval: (h) => { if (h) h.live = false },
    timers
  }
}

test('agent loop: a healthy link is left completely alone', () => {
  const conn = link({ state: 'CONNECTED' })
  const loop = new AgentLoop({ config: config(), connection: conn })
  const r = loop.tick()
  assert.equal(r.acted, false)
  assert.equal(conn.calls.length, 0, 'no reconnect on a link that is up')
})

test('agent loop: ERROR with no retry scheduled is revived, not sat on', () => {
  // This is the state that used to be terminal: the retry budget ran out (or
  // auto-reconnect was switched while a timer was pending) and the process just
  // idled, alive but useless, until someone read the log.
  const conn = link({ state: 'ERROR', lastError: 'read ECONNRESET', nextRetryAt: null })
  const loop = new AgentLoop({ config: config(), connection: conn })
  const r = loop.tick()
  assert.equal(r.acted, true)
  assert.ok(r.actions.includes('revive'))
  assert.equal(conn.calls.length, 1)
  assert.match(conn.calls[0][1].reason, /revive/)
  assert.equal(loop.revives, 1)
})

test('agent loop: does NOT revive while a retry timer is already pending', () => {
  const conn = link({ state: 'RECONNECTING', nextRetryAt: 99_999 })
  const loop = new AgentLoop({ config: config(), connection: conn })
  const r = loop.tick()
  assert.equal(r.acted, false, 'the back-off is already doing its job')
  assert.equal(conn.calls.length, 0)
})

test('agent loop: a link down past forceRestartAfterMs is rebuilt and joins again', () => {
  const clock = fakeClock(0)
  // DISCONNECTED (not RECONNECTING): nothing is scheduled, and it has been down
  // a long time — a stale socket is the usual reason a join never completes.
  const conn = link({ state: 'DISCONNECTED', since: 0 })
  const loop = new AgentLoop({ config: config(), connection: conn, now: clock.now })
  clock.advance(200_000)
  const r = loop.tick()
  assert.equal(r.acted, true)
  assert.ok(r.actions.includes('restart'))
  assert.equal(conn.calls[0][0], 'restart')
  assert.equal(loop.restarts, 1)
})

test('agent loop: a paused body is never reconnected behind the operator\'s back', () => {
  const conn = link({ state: 'DISCONNECTED', since: 0, paused: true })
  const loop = new AgentLoop({ config: config(), connection: conn })
  const r = loop.tick()
  assert.equal(r.acted, false)
  assert.equal(conn.calls.length, 0, 'pause means pause, including the link')
})

test('agent loop: surviveKicks=false leaves every reconnect to the operator', () => {
  const conn = link({ state: 'ERROR' })
  const loop = new AgentLoop({ config: config({ 'agent.surviveKicks': false }), connection: conn })
  const r = loop.tick()
  assert.equal(r.acted, false)
  assert.equal(conn.calls.length, 0)
})

test('agent loop: a wedged process is reported instead of being blamed on the link', () => {
  let healthy = false
  const conn = link({ state: 'CONNECTED' })
  const loop = new AgentLoop({
    config: config(),
    connection: conn,
    isProcessHealthy: () => healthy
  })
  const r = loop.tick()
  assert.ok(r.actions.includes('process-stalled'))
  assert.equal(conn.calls.length, 0, 'never touch the socket from inside a blocked loop')
})

test('agent loop: the process-stall warning is rate-limited, not repeated every tick', () => {
  const clock = fakeClock(0)
  const actions = []
  const loop = new AgentLoop({
    config: config(),
    connection: link({ state: 'CONNECTED' }),
    isProcessHealthy: () => false,
    now: clock.now,
    logger: (level, msg) => actions.push(msg)
  })
  loop.tick()
  clock.advance(15_000)
  loop.tick()
  assert.equal(actions.length, 1, 'one warning per minute, not one per tick')
  clock.advance(60_000)
  loop.tick()
  assert.equal(actions.length, 2)
})

test('agent loop: repeated drops become a crash loop, and reconnecting stops', () => {
  const clock = fakeClock(0)
  const watchdog = new LinkWatchdog({ now: clock.now })
  const conn = link({ state: 'ERROR', lastError: 'kicked: server full' })
  const stops = []
  const loop = new AgentLoop({
    config: config({ 'agent.crashLoopDrops': 3 }),
    connection: conn,
    watchdog,
    now: clock.now,
    onCrashLoop: (info) => stops.push(info)
  })

  for (let i = 0; i < 3; i++) {
    clock.advance(1_000)
    watchdog.noteEnd({ kind: 'kicked', text: `kicked: server full (${i})` })
    loop.tick()
  }
  assert.equal(stops.length, 1, 'the crash loop is announced once')
  assert.equal(loop.crashLoop, true)
  assert.equal(stops[0].drops, 3)

  // From here, the loop must NOT reconnect on its own: hammering a server that
  // keeps rejecting you hides the cause and makes it worse.
  const before = conn.calls.length
  clock.advance(20_000)
  loop.tick()
  assert.equal(conn.calls.length, before, 'no reconnect during a crash loop')
  assert.match(loop.summary(), /crash loop/i)
})

test('agent loop: a successful connection clears the crash loop', () => {
  const clock = fakeClock(0)
  const watchdog = new LinkWatchdog({ now: clock.now })
  const conn = link({ state: 'ERROR' })
  const loop = new AgentLoop({ config: config({ 'agent.crashLoopDrops': 2 }), connection: conn, watchdog, now: clock.now })
  for (let i = 0; i < 2; i++) { clock.advance(1_000); watchdog.noteEnd({ kind: 'kicked', text: 'nope' }); loop.tick() }
  assert.equal(loop.crashLoop, true)
  conn.state.state = 'CONNECTED'
  loop.tick()
  assert.equal(loop.crashLoop, false, 'the operator (or a good retry) fixed it; forget the loop')
})

test('agent loop: drops older than the window do not count toward a crash loop', () => {
  const clock = fakeClock(0)
  const watchdog = new LinkWatchdog({ now: clock.now })
  const conn = link({ state: 'CONNECTED' })
  const loop = new AgentLoop({
    config: config({ 'agent.crashLoopDrops': 3, 'agent.crashLoopWindowMs': 60_000 }),
    connection: conn,
    watchdog,
    now: clock.now
  })
  // Two drops, then an hour of calm, then two more: not a crash loop.
  for (let i = 0; i < 2; i++) { clock.advance(1_000); watchdog.noteEnd({ kind: 'end', text: 'x' }); loop.tick() }
  clock.advance(3_600_000)
  for (let i = 0; i < 2; i++) { clock.advance(1_000); watchdog.noteEnd({ kind: 'end', text: 'y' }); loop.tick() }
  assert.equal(loop.crashLoop, false)
})

test('agent loop: a stalled loop is escalated as a stall, not as a kick', () => {
  const clock = fakeClock(0)
  const watchdog = new LinkWatchdog({ now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, sampleMs: 100 })
  watchdog.start()
  clock.advance(6_000)
  watchdog._sample() // a 5.9s stall

  const warnings = []
  const loop = new AgentLoop({
    config: config(),
    connection: link({ state: 'CONNECTED' }),
    watchdog,
    now: clock.now,
    onStallStorm: (info) => warnings.push(info)
  })
  const r = loop.tick()
  assert.equal(r.acted, true)
  assert.ok(r.actions.includes('stall-warning'))
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].maxMs >= 5_000)
  // And it is explicit that this will be misread as a timeout — the whole point.
  assert.match(loop.actions.at(-1).what, /keepalive timeout/i)
  watchdog.stop()
})

test('agent loop: start() is idempotent and stop() clears the timer', () => {
  const clock = fakeClock()
  const loop = new AgentLoop({
    config: config(),
    connection: link(),
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval
  })
  loop.start(); loop.start()
  assert.equal(clock.timers.length, 1)
  loop.stop(); loop.stop()
  assert.equal(clock.timers[0].live, false)
})

test('agent loop: snapshot() is what `watchdog` prints, and it stays bounded', () => {
  const loop = new AgentLoop({ config: config(), connection: link({ state: 'ERROR' }) })
  for (let i = 0; i < 50; i++) loop.tick()
  const snap = loop.snapshot()
  assert.equal(snap.running, false)
  assert.equal(snap.intervalMs, 15_000)
  assert.ok(snap.actions.length <= 8, 'the audit trail is bounded')
  assert.ok(loop.actions.length <= 40)
})

test('agent loop: a manager parked in RECONNECTING with no timer is revived for real', () => {
  // This is the hole the integration check found: `restart()` used to refuse a
  // join with "an attempt is already in flight" when the timer had been
  // cancelled, so the revive was a silent no-op. The link stayed down forever
  // while the loop reported that it had acted.
  const { ConnectionManager } = require('../zincai/connection')
  const { RuntimeConfig } = require('../zincai/runtime_config')
  const cfg = new RuntimeConfig({})
  let sessions = 0
  const cm = new ConnectionManager({
    createSession: () => { sessions += 1; return { dispose: () => {}, bot: {}, isSpawned: () => false } },
    config: cfg,
    logger: () => {}
  })
  // A link that spawned once, then failed, then had its retry timer dropped.
  cm.everConnected = true
  cm._fail('read ECONNRESET')
  cm._cancelRetry()
  assert.equal(cm.state, 'RECONNECTING')
  assert.equal(cm.nextRetryAt, null, 'nothing is scheduled — this is the parked state')

  const loop = new AgentLoop({ config: cfg, connection: cm, logger: () => {}, isProcessHealthy: () => true })
  const r = loop.tick()
  assert.equal(r.acted, true)
  assert.ok(r.actions.includes('revive'))
  assert.equal(cm.state, 'CONNECTING', 'the revive must actually open a connection')
  assert.equal(sessions, 1)
})

test('connection: restart() recovers a parked RECONNECTING manager', () => {
  const { ConnectionManager } = require('../zincai/connection')
  const { RuntimeConfig } = require('../zincai/runtime_config')
  const cfg = new RuntimeConfig({})
  let sessions = 0
  const cm = new ConnectionManager({
    createSession: () => { sessions += 1; return { dispose: () => {}, bot: {}, isSpawned: () => false } },
    config: cfg,
    logger: () => {}
  })
  cm.everConnected = true
  cm._fail('read ECONNRESET')
  cm._cancelRetry()
  const r = cm.restart({ reason: 'operator restart' })
  assert.equal(r.ok, true, `restart must not claim "already in flight" when nothing is: ${r.why}`)
  assert.equal(cm.state, 'CONNECTING')
  assert.equal(sessions, 1)
})
