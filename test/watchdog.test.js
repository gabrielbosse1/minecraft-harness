/**
 * watchdog.test.js — the "why does it keep getting kicked" investigation, as
 * executable evidence.
 *
 * The four causes this separates look identical in the console:
 *
 *   server-silent          the server stopped sending keep_alive
 *   server-keepalive-timeout  the server stopped hearing from US
 *   loop-stall             our own process was blocked past the deadline
 *   socket-error           the TCP connection died
 *
 * Everything is driven by an injected clock, so a 10-minute failure sequence
 * runs in microseconds and never depends on wall time.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LinkWatchdog,
  classifyDisconnect,
  DEFAULT_CHECK_TIMEOUT_MS,
  STALL_FLOOR_MS
} = require('../zincai/watchdog')

/** A clock and an interval API the test drives by hand. */
function fakeTime (start = 1_000_000) {
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

test('watchdog: the default deadline is minecraft-protocol\'s own 30s', () => {
  assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 30_000)
  const w = new LinkWatchdog({ config: null })
  assert.equal(w.checkTimeoutMs(), 30_000)
})

test('watchdog: the deadline follows connection.checkTimeoutMs', () => {
  const cfg = { get: (name) => (name === 'connection.checkTimeoutMs' ? 90_000 : undefined) }
  const w = new LinkWatchdog({ config: cfg })
  assert.equal(w.checkTimeoutMs(), 90_000)
  // A nonsense value falls back to the library default instead of disarming it.
  const bad = new LinkWatchdog({ config: { get: () => 'soon' } })
  assert.equal(bad.checkTimeoutMs(), 30_000)
})

test('watchdog: a blocked event loop is measured, reported, and bounded', () => {
  const clock = fakeTime()
  const warnings = []
  const w = new LinkWatchdog({
    logger: (level, msg) => warnings.push(`${level}: ${msg}`),
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    sampleMs: 100
  })
  w.start()
  clock.advance(100)
  w._sample() // on time
  assert.equal(w.stalls.length, 0, 'an on-time tick is not a stall')

  clock.advance(2_400) // the loop was blocked: 100 expected, 2400 elapsed
  const stall = w._sample()
  assert.ok(stall, 'a 2.2s overrun is a stall')
  assert.ok(stall.ms > 1_000)
  assert.equal(w.maxStallMs, stall.ms)
  assert.match(warnings.at(-1), /event loop blocked for \d+ms/)

  // Bounded: this loop runs forever, so the history cannot grow forever.
  for (let i = 0; i < 40; i++) { clock.advance(5_000); w._sample() }
  assert.equal(w.stalls.length, 20)
  w.stop()
})

test('watchdog: a stall shorter than the floor is noise, not a stall', () => {
  assert.ok(STALL_FLOOR_MS >= 100)
  const clock = fakeTime()
  const w = new LinkWatchdog({ now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, sampleMs: 100 })
  w.start()
  clock.advance(100 + STALL_FLOOR_MS - 1)
  assert.equal(w._sample(), null)
  assert.equal(w.stalls.length, 0)
  w.stop()
})

test('watchdog: keepalive traffic is counted both ways, and silence is measured', () => {
  const clock = fakeTime()
  const w = new LinkWatchdog({ now: clock.now })
  assert.equal(w.snapshot().silentForMs, null, 'a link that never received a packet has no silence to report')
  w.noteRecv()
  w.noteSent()
  clock.advance(5_000)
  w.noteRecv()
  w.noteSent()
  const snap = w.snapshot()
  assert.equal(snap.recv, 2)
  assert.equal(snap.sent, 2)
  assert.equal(snap.silentForMs, 0)
  clock.advance(12_000)
  assert.equal(w.snapshot().silentForMs, 12_000)
})

// ---------------------------------------------------------------- classify --

test('cause: the server going quiet is NOT blamed on our loop when the loop was healthy', () => {
  const v = classifyDisconnect({
    text: 'client timed out after 30000 milliseconds',
    kind: 'end',
    maxStallMs: 0,
    checkTimeoutMs: 30_000
  })
  assert.equal(v.cause, 'server-silent')
  assert.match(v.why, /loop healthy/)
  assert.match(v.fix, /checkTimeoutMs|server/i)
})

test('cause: the SAME message is a loop stall when the loop was blocked past the deadline', () => {
  // This is the whole point of the module: identical text, opposite diagnosis.
  const v = classifyDisconnect({
    text: 'client timed out after 30000 milliseconds',
    kind: 'end',
    maxStallMs: 31_000,
    checkTimeoutMs: 30_000
  })
  assert.equal(v.cause, 'loop-stall')
  assert.match(v.why, /blocked for \d+ms/)
  assert.match(v.fix, /blocked the loop|synchronous/i)
})

test('cause: a server keepalive kick is attributed to the server, and is certain', () => {
  const v = classifyDisconnect({ kind: 'kicked', text: 'KeepAliveTimeout' })
  assert.equal(v.cause, 'server-keepalive-timeout')
  assert.equal(v.certain, true, 'the reason string is unambiguous here')
})

test('cause: socket errors are separated from timeouts', () => {
  for (const text of ['read ECONNRESET', 'socket hang up', 'connect ECONNREFUSED 127.0.0.1:25565', 'write EPIPE']) {
    const v = classifyDisconnect({ kind: 'error', text })
    assert.equal(v.cause, 'socket-error', text)
    assert.match(v.fix, /localhost|server/i)
  }
})

test('cause: a policy kick is reported as a kick, never as a timeout', () => {
  const v = classifyDisconnect({ kind: 'kicked', text: 'You are not white-listed on this server' })
  assert.equal(v.cause, 'kicked')
  assert.match(v.why, /white-listed/)
})

test('cause: no reason given is honest about being unknown', () => {
  const v = classifyDisconnect({ kind: 'end', text: '' })
  assert.equal(v.cause, 'unknown')
  assert.equal(v.certain, false)
  assert.match(v.fix, /evidence/i)
})

test('cause: keepAliveError code is treated as a client deadline, not a socket death', () => {
  const v = classifyDisconnect({ kind: 'end', code: 'keepAliveError', text: '', maxStallMs: 0 })
  assert.equal(v.cause, 'server-silent')
})

// ----------------------------------------------------------------- records --

test('watchdog: a disconnect record carries the evidence that produced the cause', () => {
  const clock = fakeTime()
  const w = new LinkWatchdog({ now: clock.now })
  w.noteRecv(); w.noteSent()
  clock.advance(1_000)
  w.noteRecv(); w.noteSent()
  clock.advance(30_500)

  const record = w.noteEnd({ kind: 'end', text: 'client timed out after 30000 milliseconds' })
  assert.equal(record.cause, 'server-silent')
  assert.equal(record.recv, 2)
  assert.equal(record.sent, 2)
  assert.equal(record.silentForMs, 30_500, 'how long the server had actually been quiet')
  assert.equal(record.maxStallMs, 0, 'and that the loop was not the reason')
})

test('watchdog: explain() reads like an investigation, not a status dump', () => {
  const clock = fakeTime()
  const w = new LinkWatchdog({ now: clock.now })
  w.noteRecv(); w.noteSent()
  clock.advance(31_000)
  w.noteEnd({ kind: 'end', text: 'client timed out after 30000 milliseconds' })
  const text = w.explain()
  for (const needle of ['cause:', 'last packet from the server', 'keepalives this link', 'worst loop stall', 'deadline in force', 'what to do:']) {
    assert.ok(text.includes(needle), `explain() must include "${needle}"\n${text}`)
  }
})

test('watchdog: explain() with no history says so instead of inventing one', () => {
  const w = new LinkWatchdog({})
  assert.match(w.explain(), /no disconnect has been recorded/i)
})

test('watchdog: reset() forgets a previous link, keeping the stall history honest', () => {
  const clock = fakeTime()
  const w = new LinkWatchdog({ now: clock.now })
  w.noteRecv(); w.noteSent()
  clock.advance(500)
  w.start()
  clock.advance(9_000)
  w._sample()
  assert.ok(w.maxStallMs > 0)
  w.reset()
  assert.equal(w.sent, 0)
  assert.equal(w.recv, 0)
  assert.equal(w.maxStallMs, 0, 'a stall from the old link must not blame the new one')
  assert.equal(w.stalls.length, 0)
  w.stop()
})

test('watchdog: a stop/start cycle does not leak intervals', () => {
  const clock = fakeTime()
  const w = new LinkWatchdog({ now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval })
  w.start(); w.start()
  assert.equal(clock.timers.length, 1, 'start() is idempotent')
  w.stop(); w.stop()
  assert.equal(clock.timers[0].live, false)
})
