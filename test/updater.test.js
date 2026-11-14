/**
 * updater.test.js — `update`: stop, pull, restart.
 *
 * The dangerous property is not "does it pull" but "does it ever discard the
 * operator's work". A dirty working tree must stop the update before anything is
 * touched, and the pull must never happen in a process whose modules are already
 * loaded. Both are pinned here with an injected runner: no repository, no
 * network, no git.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const updater = require('../zincai/updater')

const { planUpdate, inspect, performUpdate, parseDirty, UPDATE_EXIT_CODE, DEFAULT_BRANCH } = updater

/** A git that answers from a script, and records every invocation. */
function fakeGit (answers = {}, { failOn = null } = {}) {
  const calls = []
  const run = (argv, opts = {}) => {
    calls.push({ argv, opts })
    const key = argv.slice(1).join(' ')
    if (failOn && key.startsWith(failOn)) return { status: 128, stdout: '', stderr: 'fatal: could not read from remote' }
    for (const [pattern, reply] of Object.entries(answers)) {
      if (key.startsWith(pattern)) return { status: 0, stdout: reply, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

/** A config stub: only what the updater reads. */
const cfg = (values = {}) => ({ get: (n) => ({ 'update.branch': DEFAULT_BRANCH, 'update.allowDirty': false, ...values })[n] })

// -------------------------------------------------------------- the plan --

test('update: a dirty working tree is refused before anything is touched', () => {
  const plan = planUpdate({ isGitRepo: true, hasGit: true, branch: 'main', dirty: ['zincai/brain.js', 'README.md'] })
  assert.equal(plan.ok, false)
  assert.match(plan.why, /local changes/)
  assert.match(plan.why, /refusing to discard/)
  assert.deepEqual(plan.steps, [], 'no steps are even planned')
})

test('update: a dirty tree can be accepted explicitly, and only explicitly', () => {
  const plan = planUpdate({ isGitRepo: true, hasGit: true, branch: 'main', dirty: ['x.js'], allowDirty: true })
  assert.equal(plan.ok, true)
  assert.ok(plan.steps.length > 0)
})

test('update: no git, no repository and detached HEAD each have their own refusal', () => {
  assert.match(planUpdate({ hasGit: false }).why, /git is not installed/)
  assert.match(planUpdate({ isGitRepo: false }).why, /not a git checkout/)
  assert.match(planUpdate({ branch: null }).why, /detached HEAD/)
})

test('update: the steps check out the branch and reset to the remote, not a bare pull', () => {
  const plan = planUpdate({ isGitRepo: true, hasGit: true, branch: 'arena/thing' })
  assert.ok(plan.ok)
  assert.ok(plan.steps.some((s) => /git fetch --prune origin/.test(s)))
  assert.ok(plan.steps.some((s) => /git checkout arena\/thing/.test(s)))
  // reset --hard, not pull: a local merge conflict must never leave the tree
  // half-updated while the process restarts on it.
  assert.ok(plan.steps.some((s) => /git reset --hard origin\/arena\/thing/.test(s)))
})

test('update: already current still restarts — a no-op pull is a restart, not an error', () => {
  const plan = planUpdate({ isGitRepo: true, hasGit: true, branch: 'main', behind: 0, ahead: 0 })
  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'pull')
  assert.match(plan.why || '', /already up to date/)
})

test('update: git status porcelain output becomes readable paths', () => {
  const text = ' M zincai/brain.js\n?? notes.md\nA  added.js\n'
  assert.deepEqual(parseDirty(text), ['zincai/brain.js', 'notes.md', 'added.js'])
  assert.deepEqual(parseDirty(''), [])
})

// ---------------------------------------------------------- the inspection --

test('update: inspect() reports no-git without pretending to know the branch', () => {
  const git = fakeGit({}, { failOn: '--version' })
  const state = inspect({ cwd: '/tmp/x', run: git.run })
  assert.equal(state.hasGit, false)
  assert.equal(state.isGitRepo, false)
  assert.equal(state.branch, null)
})

test('update: inspect() reads the branch and the dirty files', () => {
  const git = fakeGit({
    '--version': 'git version 2.43.0',
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'status --porcelain': ' M zincai/host.js\n'
  })
  const state = inspect({ cwd: '/repo', run: git.run })
  assert.equal(state.isGitRepo, true)
  assert.equal(state.branch, 'main')
  assert.deepEqual(state.dirty, ['zincai/host.js'])
})

// ------------------------------------------------------------ the execution --

test('update: a dirty tree aborts before a single git command runs', async () => {
  const git = fakeGit({
    '--version': 'git version 2.43.0',
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'status --porcelain': ' M zincai/index.js\n'
  })
  let exited = null
  const r = await performUpdate({
    cwd: '/repo',
    config: cfg(),
    run: git.run,
    exit: (code) => { exited = code }
  })
  assert.equal(r.ok, false)
  assert.equal(exited, null, 'the process must not exit for a refused update')
  const mutated = git.calls.filter((c) => /fetch|checkout|reset|pull/.test(c.argv.join(' ')))
  assert.equal(mutated.length, 0, 'nothing that writes may have run')
})

test('update: a successful fetch exits with the restart code, not 0', async () => {
  // Exit 0 would mean "shut down cleanly" to the supervisor, which would NOT
  // start the bot again. 75 is the one code that means "start me again".
  const git = fakeGit({
    '--version': 'git version 2.43.0',
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'status --porcelain': '',
    'fetch --prune': '',
    'rev-parse HEAD': 'aaaaaaaa\n',
    'rev-parse origin/main': 'bbbbbbbb\n'
  })
  let exited = null
  const r = await performUpdate({
    cwd: '/repo',
    config: cfg(),
    run: git.run,
    // A supervisor is present: it performs the checkout, this process just exits.
    supervisor: true,
    spawn: null,
    exit: (code) => { exited = code }
  })
  assert.equal(r.ok, true)
  assert.match(r.reply, /aaaaaaaa → bbbbbbbb/, 'the operator is told what changed')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(exited, UPDATE_EXIT_CODE)
})

test('update: a failed fetch leaves the process alive and says why', async () => {
  const git = fakeGit({
    '--version': 'git version 2.43.0',
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'status --porcelain': ''
  }, { failOn: 'fetch --prune' })
  let exited = null
  const r = await performUpdate({
    cwd: '/repo',
    config: cfg(),
    run: git.run,
    supervisor: true,
    exit: (code) => { exited = code }
  })
  assert.equal(r.ok, false)
  assert.match(r.reply, /git fetch exited 128/)
  assert.equal(exited, null, 'a failed update must not take the process down')
})

test('update: without a supervisor, the pull runs in a detached child', async () => {
  // The reason this matters: Node has already loaded the modules, so a pull in
  // THIS process would restart old code. The child is what makes it real.
  const git = fakeGit({
    '--version': 'git version 2.43.0',
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'status --porcelain': '',
    'fetch --prune': '',
    'rev-parse HEAD': '12345678\n',
    'rev-parse origin/main': '87654321\n'
  })
  let spawned = null
  const r = await performUpdate({
    cwd: '/repo',
    config: cfg(),
    run: git.run,
    supervisor: false,
    spawn: (cmd, args, opts) => { spawned = { cmd, args, opts }; return { unref () {} } },
    exit: () => {}
  })
  assert.equal(r.ok, true)
  assert.equal(spawned.cmd, '/bin/sh')
  assert.equal(spawned.opts.detached, true, 'detached, or the parent waits on its own replacement')
  assert.equal(spawned.opts.cwd, '/repo')
  assert.equal(spawned.opts.env.ZINC_UPDATED, '1')
  const script = spawned.args[1]
  assert.match(script, /git fetch --prune origin/)
  assert.match(script, /git reset --hard origin\/main/)
  assert.match(script, /exec node zincai\/index\.js/)
  // `set -e` must be its own line: "set -e && git ..." would not stop on failure.
  assert.match(script, /^set -e\n/)
})

test('update: the restart code is distinct from success and from a crash', () => {
  assert.equal(UPDATE_EXIT_CODE, 75)
  assert.notEqual(UPDATE_EXIT_CODE, 0)
  assert.ok(UPDATE_EXIT_CODE > 0 && UPDATE_EXIT_CODE < 126, 'outside the shell\'s own reserved range')
})

test('update: the update branch is configurable and defaults to main', async () => {
  assert.equal(DEFAULT_BRANCH, 'main')
  const seen = []
  const git = fakeGit({
    '--version': 'git version 2.43.0',
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --abbrev-ref HEAD': 'arena/x\n',
    'status --porcelain': '',
    'fetch --prune': ''
  })
  const r = await performUpdate({
    cwd: '/repo',
    config: cfg({ 'update.branch': 'arena/x' }),
    run: (argv, opts) => { seen.push(argv.join(' ')); return git.run(argv, opts) },
    supervisor: true,
    exit: () => {}
  })
  assert.equal(r.ok, true)
  // The fetch is the only write this process performs; the branch it targets is
  // the configured one, so the supervisor and the command cannot disagree.
  assert.ok(seen.includes('git fetch --prune origin'))
  assert.ok(r.steps.some((step) => /arena\/x/.test(step)), `steps must name the configured branch: ${r.steps}`)
})
