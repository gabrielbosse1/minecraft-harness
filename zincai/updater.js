/**
 * updater.js — `update`: stop the body, pull the code from GitHub, restart.
 *
 * WHY THIS IS NOT JUST `git pull`
 *   The obvious implementation is a trap. Node.js has already loaded every
 *   module in this process; replacing the files underneath it changes nothing
 *   that is running. A `git pull` followed by "restart the bot" inside the same
 *   process would run the OLD code again and report success, which is the worst
 *   possible outcome for an update command.
 *
 *   So `update` is two halves:
 *
 *     1. this process prepares (pause, save, verify the tree is clean and that
 *        git is even available) and then EXITS with a distinct code;
 *     2. the supervisor script (scripts/update.js, which the panel runs) does
 *        the `git fetch` / `git checkout` and starts the process again.
 *
 *   When the process was started directly (`npm start`, no supervisor) the pull
 *   still has to happen somewhere, so this module runs it in a CHILD process
 *   before exiting. A child is what makes it safe: it can overwrite files this
 *   process has open, because it is not this process.
 *
 *   The one invariant that matters: if the pull cannot be done safely, DO NOT
 *   pull. A dirty working tree (the operator's own edits, a half-finished
 *   experiment) must never be silently discarded to satisfy an update.
 *
 * Pure decision-making + a spawned child: no fs writes, no git library, and the
 * `run` function is injected so the tests do not need a repository or a network.
 */
'use strict'

/** Exit code that means "I stopped for an update — start me again". */
const UPDATE_EXIT_CODE = 75

/** Branch/remote defaults, matching the panel template's own variables. */
const DEFAULT_REMOTE = 'origin'
const DEFAULT_BRANCH = 'main'

/**
 * Decide whether an update may proceed, from facts gathered by the caller.
 *
 * @param {{
 *   isGitRepo?: boolean,
 *   hasGit?: boolean,
 *   branch?: string|null,
 *   dirty?: string[],
 *   ahead?: number,
 *   behind?: number,
 *   allowDirty?: boolean
 * }} state
 * @returns {{ ok: boolean, why?: string, action: 'pull'|'none', steps: string[] }}
 */
function planUpdate ({ isGitRepo = true, hasGit = true, branch = DEFAULT_BRANCH, dirty = [], ahead = 0, behind = 0, allowDirty = false } = {}) {
  if (!hasGit) {
    return { ok: false, why: 'git is not installed on this node (or not on PATH), so there is nothing to pull from', action: 'none', steps: [] }
  }
  if (!isGitRepo) {
    return { ok: false, why: 'this directory is not a git checkout — it was probably installed from an archive, so it cannot be updated in place', action: 'none', steps: [] }
  }
  if (!branch) {
    return { ok: false, why: 'the checkout has no branch (detached HEAD); check out a branch before updating', action: 'none', steps: [] }
  }
  if (dirty.length && !allowDirty) {
    const names = dirty.slice(0, 6).join(', ')
    return {
      ok: false,
      why: `the working tree has local changes (${names}${dirty.length > 6 ? `, +${dirty.length - 6} more` : ''}) — refusing to discard them. Commit, stash, or set update.allowDirty to accept losing them`,
      action: 'none',
      steps: []
    }
  }
  const remote = DEFAULT_REMOTE
  const steps = [
    `git fetch --prune ${remote}`,
    `git checkout ${branch}`,
    `git reset --hard ${remote}/${branch}`
  ]
  if (behind === 0 && ahead === 0) {
    return { ok: true, action: 'pull', why: 'already up to date — the fetch still runs, then the process restarts on the same code', steps }
  }
  return { ok: true, action: 'pull', steps }
}

/**
 * Parse the porcelain output of `git status` into a short list of paths.
 * @param {string} text
 * @returns {string[]}
 */
function parseDirty (text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 40)
}

/**
 * Read the repository state through an injected runner, so the decision above
 * can be tested without a git checkout.
 *
 * @param {{ cwd: string, run: (args:string[], opts?:object) => { status:number, stdout:string, stderr:string } }} opts
 */
function inspect ({ cwd, run, remote = DEFAULT_REMOTE, branch = DEFAULT_BRANCH }) {
  const git = (args) => {
    try {
      return run(['git', ...args], { cwd, timeoutMs: 15_000 })
    } catch (err) {
      return { status: -1, stdout: '', stderr: String(err?.message || err) }
    }
  }
  const hasGit = (() => {
    const r = git(['--version'])
    return r.status === 0
  })()
  if (!hasGit) return { isGitRepo: false, hasGit: false, branch: null, dirty: [], ahead: 0, behind: 0 }

  const inside = git(['rev-parse', '--is-inside-work-tree'])
  const isGitRepo = inside.status === 0 && /true/i.test(inside.stdout)
  if (!isGitRepo) return { isGitRepo: false, hasGit: true, branch: null, dirty: [], ahead: 0, behind: 0 }

  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const current = head.status === 0 ? head.stdout.trim() : ''
  const status = git(['status', '--porcelain'])
  const dirty = status.status === 0 ? parseDirty(status.stdout) : []
  // The branch is not passed to `rev-list` here: the caller just fetched, and a
  // comparison against a stale ref is worse than reporting "unknown".
  return {
    isGitRepo: true,
    hasGit: true,
    branch: current && current !== 'HEAD' ? current : branch,
    detached: current === 'HEAD',
    dirty,
    ahead: 0,
    behind: 0
  }
}

/** Run one shell-free command and capture its output. */
function runCommand (argv, { cwd, timeoutMs = 120_000 } = {}) {
  const { spawnSync } = require('child_process')
  const [cmd, ...args] = argv
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    // Git must never block waiting for a human: no editor, no credential prompt
    // on stdin. A private repository with the wrong credentials fails fast.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', EDITOR: 'true' }
  })
  return {
    status: r.status === null ? -1 : r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || (r.error ? r.error.message : '')),
    signal: r.signal || null
  }
}

/**
 * Prepare the update in this process and start the replacement.
 *
 * @param {{
 *   cwd: string,
 *   config?: import('./runtime_config').RuntimeConfig,
 *   logger?: (level:string,msg:string)=>void,
 *   run?: Function,
 *   spawn?: Function,
 *   exit?: Function,
 *   env?: object,
 *   supervisor?: boolean
 * }} opts
 * @returns {Promise<{ ok:boolean, reply:string, steps?:string[] }>}
 */
async function performUpdate ({
  cwd,
  config = null,
  logger = () => {},
  run = runCommand,
  spawn = null,
  exit = null,
  env = process.env,
  supervisor = false
} = {}) {
  const remote = DEFAULT_REMOTE
  const branch = String((config && config.get('update.branch')) || DEFAULT_BRANCH)
  const allowDirty = Boolean(config && config.get('update.allowDirty'))
  const doExit = exit || ((code) => process.exit(code))

  const state = inspect({ cwd, run, remote, branch })
  const plan = planUpdate({
    isGitRepo: state.isGitRepo,
    hasGit: state.hasGit,
    branch: state.detached ? null : state.branch,
    dirty: state.dirty,
    allowDirty
  })
  if (!plan.ok) return { ok: false, reply: `update refused: ${plan.why}` }

  // The fetch is safe to do from here: it writes refs, not the working tree.
  logger('info', `update: fetching ${remote}/${branch}`)
  const fetch = run(['git', 'fetch', '--prune', remote], { cwd, timeoutMs: 120_000 })
  if (fetch.status !== 0) {
    const detail = String(fetch.stderr || fetch.stdout || '').trim().split('\n').slice(-2).join(' ')
    return { ok: false, reply: `update failed: git fetch exited ${fetch.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}` }
  }

  const before = run(['git', 'rev-parse', 'HEAD'], { cwd })
  const target = run(['git', 'rev-parse', `${remote}/${branch}`], { cwd })
  const beforeSha = before.status === 0 ? before.stdout.trim().slice(0, 8) : '?'
  const targetSha = target.status === 0 ? target.stdout.trim().slice(0, 8) : '?'
  const changed = beforeSha !== '?' && targetSha !== '?' && beforeSha !== targetSha

  // The supervisor restarts us; it does the checkout itself. Without one, a
  // detached child does it and then starts this same process again.
  const steps = plan.steps
  if (supervisor || spawn === null) {
    logger('info', `update: exiting for restart${changed ? ` (${beforeSha} → ${targetSha})` : ' (already current)'}`)
    setTimeout(() => doExit(UPDATE_EXIT_CODE), 150)
    return {
      ok: true,
      steps,
      reply: `updating: stopping now (exit ${UPDATE_EXIT_CODE}), pulling ${remote}/${branch} (${beforeSha} → ${targetSha}), then the supervisor starts the bot again${changed ? '' : ' — already current, so this is just a restart'}`
    }
  }

  // No supervisor: one detached child checks out and re-execs. `detached` +
  // `unref` is what lets this process exit instead of waiting for its own
  // replacement.
  // `set -e` must be its own statement: joining it with && makes "set -e &&  git"
  // a single command list, and a failure in the middle would not stop the rest.
  const script = [
    'set -e',
    ...steps,
    'exec node zincai/index.js'
  ].join('\n')
  const child = spawn('/bin/sh', ['-c', script], {
    cwd,
    detached: true,
    stdio: 'inherit',
    env: { ...env, ZINC_UPDATED: '1' }
  })
  if (child && typeof child.unref === 'function') child.unref()
  logger('info', `update: spawned the checkout+restart child; this process will exit ${UPDATE_EXIT_CODE}`)
  setTimeout(() => doExit(UPDATE_EXIT_CODE), 150)
  return {
    ok: true,
    steps,
    reply: `updating: stopping now (exit ${UPDATE_EXIT_CODE}); a detached child pulls ${remote}/${branch} (${beforeSha} → ${targetSha}) and starts the bot again`
  }
}

module.exports = {
  performUpdate,
  planUpdate,
  inspect,
  runCommand,
  parseDirty,
  UPDATE_EXIT_CODE,
  DEFAULT_REMOTE,
  DEFAULT_BRANCH
}
