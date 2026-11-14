/**
 * updater.js — `update`: pull the newest source from GitHub, in place.
 *
 * What the console command does, in order, and what each step refuses:
 *
 *   1. inspect   must be a git checkout with a remote. Local edits to tracked
 *                files stop the update (`update force` discards them).
 *   2. fetch     the branch this checkout is on, from `origin`. A shallow
 *                clone (the panel installs with --depth 1) is fetched shallow.
 *   3. compare   already at the newest commit → nothing else happens.
 *   4. apply     fast-forward. A history that diverged is refused unless
 *                forced; a shallow clone is moved the way the panel's own
 *                Install does (to the fetched commit).
 *   5. install   `npm ci` — only when package.json, the lockfile or the
 *                postinstall scripts changed (or node_modules is missing).
 *   6. check     `node zincai/index.js --check` against the NEW source. If it
 *                does not load, the checkout is rolled back to the old commit
 *                and the running bot is left alone.
 *
 * Nothing here restarts anything: the caller (host.js) does that once this
 * returned `{ ok: true, changed: true }`. Every step runs `git`/`npm`/`node`
 * directly (no shell), and `exec` is injectable so the tests need no network.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const REPO_ROOT = path.join(__dirname, '..')

/** Run a program; never rejects. @returns {Promise<{code:number, stdout:string, stderr:string}>} */
function defaultExec (cmd, args, { cwd, timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32' && /^npm(\.cmd)?$/.test(cmd)
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: useShell }, (err, stdout, stderr) => {
      const code = err ? (Number.isInteger(err.code) ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && !Number.isInteger(err.code) ? err.message : '') || '') })
    })
  })
}

const short = (sha) => String(sha || '').trim().slice(0, 7) || '?'
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).slice(-1)[0] || ''
/** Never echo a credential that is embedded in a remote URL. */
const redactUrl = (s) => String(s || '').replace(/\/\/[^/@\s]+@/g, '//***@')

/** Files whose change means dependencies must be reinstalled. */
const INSTALL_TRIGGERS = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|scripts\/apply-[^/]+\.js|patches\/)/

/**
 * @param {{ cwd?: string, force?: boolean, checkOnly?: boolean, install?: boolean, verify?: boolean,
 *           exec?: Function, log?: (msg:string)=>void, env?: object }} [opts]
 * @returns {Promise<{ ok:boolean, changed:boolean, from?:string, to?:string, branch?:string,
 *                     summary:string, steps:string[], commits?:string[], installed?:boolean }>}
 */
async function runUpdate ({
  cwd = REPO_ROOT,
  force = false,
  checkOnly = false,
  install = true,
  verify = true,
  exec = defaultExec,
  log = () => {},
  env = process.env
} = {}) {
  const steps = []
  const say = (msg) => { steps.push(msg); log(msg) }
  const git = (args, opts = {}) => exec('git', args, { cwd, env, ...opts })
  const failed = (summary, extra = {}) => { say(summary); return { ok: false, changed: false, summary, steps, ...extra } }

  // 1. inspect ------------------------------------------------------------
  const inside = await git(['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 && /ENOENT/.test(inside.stderr)) {
    // e.g. a slim Docker image: the source is a checkout, but nothing here can pull.
    return failed('cannot update: git is not installed where the bot runs — install git there, or update by pressing Install in the panel')
  }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return failed(`cannot update: ${cwd} is not a git checkout (install with git clone, or reinstall from the panel)`)
  }
  const head = await git(['rev-parse', 'HEAD'])
  if (head.code !== 0) return failed(`cannot update: no commit checked out (${lastLine(head.stderr)})`)
  const from = head.stdout.trim()
  let branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (!branch || branch === 'HEAD') {
    // Detached (a panel install can leave it that way): follow the remote's default branch.
    const def = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    branch = def.code === 0 ? def.stdout.trim().replace(/^origin\//, '') : 'main'
  }
  const remote = await git(['remote', 'get-url', 'origin'])
  if (remote.code !== 0) return failed('cannot update: this checkout has no "origin" remote to pull from')
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (dirty.length && !force && !checkOnly) {
    return failed(`cannot update: ${dirty.length} tracked file${dirty.length === 1 ? ' has' : 's have'} local changes (${dirty.slice(0, 4).map((l) => l.replace(/^\S+\s+/, '')).join(', ')}${dirty.length > 4 ? ', …' : ''}). Commit or revert them, or run "update force" to discard them.`, { from, branch })
  }

  // 2. fetch --------------------------------------------------------------
  const shallow = (await git(['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true'
  say(`fetching ${branch} from ${redactUrl(remote.stdout.trim())}${shallow ? ' (shallow)' : ''}`)
  const fetched = await git(['fetch', ...(shallow ? ['--depth', '1'] : []), 'origin', branch], { timeoutMs: 180_000 })
  if (fetched.code !== 0) return failed(`cannot update: git fetch failed — ${redactUrl(lastLine(fetched.stderr)) || 'no detail'}`, { from, branch })
  const target = await git(['rev-parse', 'FETCH_HEAD'])
  if (target.code !== 0) return failed(`cannot update: nothing was fetched for ${branch}`, { from, branch })
  const to = target.stdout.trim()

  // 3. compare ------------------------------------------------------------
  if (to === from && !(force && dirty.length)) {
    const summary = `already up to date: ${branch} @ ${short(from)}`
    say(summary)
    return { ok: true, changed: false, from, to, branch, summary, steps }
  }
  const logOut = shallow ? { code: 1, stdout: '' } : await git(['log', '--oneline', '--no-decorate', '-n', '12', `${from}..${to}`])
  const commits = logOut.code === 0 ? logOut.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  if (checkOnly) {
    const summary = to === from
      ? `already up to date: ${branch} @ ${short(from)}`
      : `update available: ${branch} ${short(from)} → ${short(to)}${commits.length ? ` (${commits.length}${commits.length === 12 ? '+' : ''} commit${commits.length === 1 ? '' : 's'})` : ''} — run "update" to apply and restart`
    say(summary)
    return { ok: true, changed: false, available: to !== from, from, to, branch, commits, summary, steps }
  }

  // 4. apply --------------------------------------------------------------
  let applied
  if (force || shallow) {
    // A shallow clone has no ancestry to fast-forward along; the tree is
    // clean (checked above), so moving to the fetched commit loses nothing.
    applied = await git(['reset', '--hard', to])
  } else {
    applied = await git(['merge', '--ff-only', to])
    if (applied.code !== 0) {
      return failed(`cannot update: ${branch} has local commits that are not on GitHub, so it cannot fast-forward (${lastLine(applied.stderr) || 'diverged'}). Push them, or run "update force" to drop them and take GitHub's version.`, { from, to, branch })
    }
  }
  if (applied.code !== 0) return failed(`cannot update: could not move to ${short(to)} — ${lastLine(applied.stderr)}`, { from, to, branch })
  say(`source is now ${branch} @ ${short(to)} (was ${short(from)})`)

  const rollback = async (why) => {
    const back = await git(['reset', '--hard', from])
    return failed(`update rolled back to ${short(from)}: ${why}${back.code === 0 ? '' : ` (and the rollback itself failed: ${lastLine(back.stderr)} — reinstall from the panel)`}. The running bot was not touched.`, { from, to, branch })
  }

  // 5. install ------------------------------------------------------------
  const diff = await git(['diff', '--name-only', from, to])
  const changedFiles = diff.code === 0 ? diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : null
  const needInstall = install && (changedFiles === null || changedFiles.some((f) => INSTALL_TRIGGERS.test(f)) || !fs.existsSync(path.join(cwd, 'node_modules')))
  let installed = false
  if (needInstall) {
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production'
    const args = ['ci', '--no-audit', '--no-fund', ...(production ? ['--omit=dev'] : [])]
    say(`dependencies changed — running npm ${args.join(' ')}`)
    const npm = await exec('npm', args, { cwd, env, timeoutMs: 600_000 })
    if (npm.code !== 0) return rollback(`npm ci failed — ${lastLine(npm.stderr) || lastLine(npm.stdout) || 'no detail'}`)
    installed = true
  }

  // 6. check --------------------------------------------------------------
  if (verify) {
    const entry = path.join('zincai', 'index.js')
    const check = await exec(process.execPath, [entry, '--check'], { cwd, env, timeoutMs: 120_000 })
    if (check.code !== 0) return rollback(`the new source does not load (${lastLine(check.stderr) || lastLine(check.stdout) || `exit ${check.code}`})`)
    say('new source passes --check')
  }

  const summary = `updated ${branch} ${short(from)} → ${short(to)}${commits.length ? `: ${commits.slice(0, 3).map((c) => c.replace(/^\S+\s+/, '')).join(' | ')}${commits.length > 3 ? ` (+${commits.length - 3} more)` : ''}` : ''}${installed ? '; dependencies reinstalled' : ''}`
  return { ok: true, changed: true, from, to, branch, commits, installed, summary, steps }
}

module.exports = { runUpdate, defaultExec, REPO_ROOT, INSTALL_TRIGGERS }
