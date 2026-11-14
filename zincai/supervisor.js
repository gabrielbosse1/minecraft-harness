/**
 * supervisor.js — the tiny parent that lets the bot restart ITSELF.
 *
 * Node cannot replace its own process image, and the panel that starts the bot
 * (PufferPanel: `node zincai/index.js`, no auto-restart) will not start it
 * again when it exits. So `node zincai/index.js` is two processes:
 *
 *   parent  this file. Loads nothing else — no mineflayer, no state. It starts
 *           the real bot as a child that shares its stdin/stdout/stderr, and
 *           waits.
 *   child   the bot. When the operator types `update` or `restart`, it saves
 *           its state, leaves the server and exits with RESTART_CODE.
 *
 * The parent sees that exit code and starts a fresh child — which loads the
 * source that is on disk NOW. Any other exit code ends both processes with
 * that code, so the panel sees exactly what it saw before.
 *
 * Opt out with ZINCAI_NO_SUPERVISOR=1 (or --no-supervisor) when something else
 * already restarts the process (systemd Restart=always, docker --restart): the
 * bot then exits with RESTART_CODE (75) after an update and that supervisor
 * brings it back.
 */
'use strict'

/** EX_TEMPFAIL: "try again". Chosen because nothing else in the bot exits with it. */
const RESTART_CODE = 75

const CHILD_FLAG = 'ZINCAI_SUPERVISED'
const OPT_OUT = 'ZINCAI_NO_SUPERVISOR'
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())

/** Should this process become the parent instead of the bot? */
function shouldSupervise (argv = process.argv, env = process.env) {
  if (truthy(env[CHILD_FLAG])) return false // we ARE the child
  if (truthy(env[OPT_OUT])) return false
  for (const flag of ['--check', '--dry-run', '--no-supervisor', '--help']) if (argv.includes(flag)) return false
  return true
}

/** Is a supervisor waiting to restart us? */
function isSupervised (env = process.env) { return truthy(env[CHILD_FLAG]) }

/**
 * Run `script` as a child, restarting it whenever it exits with RESTART_CODE.
 * Resolves with the final exit code (and calls `exit` with it).
 *
 * @param {{ script: string, args?: string[], env?: object, execPath?: string, execArgv?: string[],
 *           spawn?: Function, exit?: (code:number)=>void, log?: (msg:string)=>void,
 *           signals?: object, maxFastRestarts?: number, fastMs?: number, now?: ()=>number }} opts
 */
function supervise ({
  script,
  args = process.argv.slice(2),
  env = process.env,
  execPath = process.execPath,
  execArgv = process.execArgv,
  spawn = require('node:child_process').spawn,
  exit = (code) => process.exit(code),
  log = (msg) => process.stderr.write(`[supervisor] ${msg}\n`),
  signals = process,
  maxFastRestarts = 3,
  fastMs = 10_000,
  now = () => Date.now()
} = {}) {
  let child = null
  let stopping = false
  let fastRestarts = 0

  // The panel stops the bot with a signal to THIS process: pass it on and wait
  // for the child's own orderly shutdown (it saves memory and goals first).
  const forward = (sig) => () => {
    stopping = true
    if (child && !child.killed) { try { child.kill(sig) } catch { /* already gone */ } }
  }
  const handlers = {}
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[sig] = forward(sig)
    try { signals.on(sig, handlers[sig]) } catch { /* not supported on this platform */ }
  }
  const cleanup = () => { for (const [sig, fn] of Object.entries(handlers)) { try { signals.removeListener?.(sig, fn) } catch { /* noop */ } } }

  return new Promise((resolve) => {
    const finish = (code) => { cleanup(); resolve(code); exit(code) }
    const start = () => {
      const startedAt = now()
      try {
        child = spawn(execPath, [...execArgv, script, ...args], { stdio: 'inherit', env: { ...env, [CHILD_FLAG]: '1' } })
      } catch (err) {
        log(`could not start the bot: ${err.message || err}`)
        return finish(1)
      }
      child.on('error', (err) => {
        log(`could not start the bot: ${err.message || err}`)
        finish(1)
      })
      child.on('exit', (code, signal) => {
        if (code === RESTART_CODE && !stopping) {
          // A child that asks for a restart seconds after starting, again and
          // again, is broken source — do not spin.
          fastRestarts = now() - startedAt < fastMs ? fastRestarts + 1 : 0
          if (fastRestarts >= maxFastRestarts) {
            log(`the bot asked to restart ${fastRestarts} times within ${Math.round(fastMs / 1000)}s of starting — giving up`)
            return finish(1)
          }
          log('restarting the bot with the source on disk')
          return start()
        }
        // Asked to restart while the panel was stopping us: the stop wins.
        if (code === RESTART_CODE) return finish(0)
        finish(Number.isInteger(code) ? code : (signal ? 1 : 0))
      })
    }
    start()
  })
}

module.exports = { supervise, shouldSupervise, isSupervised, RESTART_CODE, CHILD_FLAG, OPT_OUT }
