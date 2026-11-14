#!/usr/bin/env node
/**
 * update.js — the supervisor that makes the `update` command finish the job.
 *
 * WHY THIS EXISTS
 *   `update` cannot pull its own code: Node.js has already loaded every module,
 *   so replacing the files and "restarting" inside the same process would run
 *   the old code and call it a success. The command therefore exits with
 *   UPDATE_EXIT_CODE (75) after proving the remote is reachable, and something
 *   has to do the checkout and start the process again. This script is that
 *   something.
 *
 *   It is also the honest way to run the bot under PufferPanel: point the
 *   template's start command at this file and an `update` typed in the panel's
 *   console survives the process exit.
 *
 *     node scripts/update.js                 # supervise: run, and restart on 75
 *     node scripts/update.js --once          # run once, no restart
 *     node scripts/update.js --pull-only     # fetch/checkout, do not run
 *
 * Behaviour:
 *   - exit 75  → pull, then start again (that is the update)
 *   - exit 0   → stop, as asked (`shutdown`)
 *   - anything else → stop, with the same code; a crash is not an update
 *
 * The pull refuses on a dirty tree, exactly like the command does — the two
 * share zincai/updater.js so they cannot disagree.
 */
'use strict'

const path = require('path')
const { spawnSync } = require('child_process')
const updater = require('../zincai/updater')

const ROOT = path.join(__dirname, '..')
const ENTRY = path.join('zincai', 'index.js')

/**
 * Split the forwarded arguments from the supervisor's own flags.
 *
 * The panel passes the entry point explicitly (`node scripts/update.js
 * zincai/index.js`) so the template and this script cannot disagree about what
 * "the bot" is. A leading `.js` argument is that entry point; everything else is
 * forwarded to the bot unchanged (`--dry-run`, `--once` is ours).
 */
function parseArgs (argv = process.argv.slice(2)) {
  const own = new Set(['--once', '--pull-only'])
  const ownFlags = argv.filter((a) => own.has(a))
  const forwarded = argv.filter((a) => !own.has(a))
  let entry = ENTRY
  if (forwarded.length && /\.js$/.test(forwarded[0]) && !forwarded[0].startsWith('-')) {
    entry = forwarded.shift()
  }
  return { entry, forwarded, once: ownFlags.includes('--once'), pullOnly: ownFlags.includes('--pull-only') }
}

function log (msg) {
  process.stderr.write(`[update] ${msg}\n`)
}

/** Fetch and check out the configured branch. Refuses on a dirty tree. */
function pull ({ branch = updater.DEFAULT_BRANCH, allowDirty = false } = {}) {
  const state = updater.inspect({ cwd: ROOT, run: updater.runCommand })
  const plan = updater.planUpdate({
    isGitRepo: state.isGitRepo,
    hasGit: state.hasGit,
    branch: state.detached ? null : state.branch,
    dirty: state.dirty,
    allowDirty
  })
  if (!plan.ok) return { ok: false, why: plan.why }

  for (const step of plan.steps) {
    const argv = step.split(' ')
    const r = updater.runCommand(argv, { cwd: ROOT, timeoutMs: 180_000 })
    if (r.status !== 0) {
      const detail = String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]
      return { ok: false, why: `${step} exited ${r.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}` }
    }
    log(step)
  }
  return { ok: true }
}

function runOnce (extraArgs = [], entry = ENTRY) {
  const r = spawnSync(process.execPath, [entry, ...extraArgs], { cwd: ROOT, stdio: 'inherit' })
  return r.status === null ? 1 : r.status
}

function main () {
  const { entry, forwarded: forward, once, pullOnly } = parseArgs()

  // No repository / no git is not fatal for a plain run: the bot works, it just
  // cannot update itself. Say so once and carry on.
  const state = updater.inspect({ cwd: ROOT, run: updater.runCommand })
  if (!state.isGitRepo || !state.hasGit) {
    log(`not a git checkout (git=${state.hasGit ? 'yes' : 'no'}) — running without the ability to update`)
  }

  if (pullOnly) {
    const r = pull({ branch: process.env.ZINC_UPDATE_BRANCH || updater.DEFAULT_BRANCH })
    log(r.ok ? 'up to date' : `refused: ${r.why}`)
    return r.ok ? 0 : 1
  }

  if (once) {
    const code = runOnce(forward, entry)
    log(`exited ${code}`)
    return code
  }

  // The supervision loop. One process, restarted only when asked.
  for (;;) {
    const code = runOnce(forward, entry)
    if (code === updater.UPDATE_EXIT_CODE) {
      log('the bot asked for an update — pulling')
      const r = pull({ branch: process.env.ZINC_UPDATE_BRANCH || updater.DEFAULT_BRANCH })
      if (!r.ok) {
        log(`update refused (${r.why}) — not restarting into stale code`)
        return 1
      }
      log('pulled; starting again on the new code')
      continue
    }
    if (code !== 0) log(`the bot exited ${code} — not an update, so not restarting it`)
    return code
  }
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = { main, pull, parseArgs }
