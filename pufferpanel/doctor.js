#!/usr/bin/env node
/**
 * pufferpanel/doctor.js — "incompatible with environment 'host'" and friends.
 *
 * PufferPanel's create-server page decides compatibility in the BROWSER, before
 * any request reaches the daemon (client/frontend/.../SelectTemplate.vue):
 *
 *   templateEnvMatches(t)  = t.supportedEnvironments.some(e => e.type === env)
 *   templateOsMatches(t)   = !t.requirements.os   || t.requirements.os === os
 *   templateArchMatches(t) = !t.requirements.arch || t.requirements.arch === arch
 *
 * where `env`, `os` and `arch` come from the NODE the server is being created
 * on: GET /api/nodes/{id}/features → GET /daemon/features, i.e.
 * { environments: [...], os: runtime.GOOS, arch: runtime.GOARCH }. The match is
 * a strict string comparison, so a node that reports `tty` does not match a
 * template that only lists `host` — even though PufferPanel maps host, tty and
 * standard to the SAME environment implementation (servers/env_loader.go).
 *
 * That is exactly the trap this script checks for.
 *
 *   node pufferpanel/doctor.js                     # check the committed template
 *   node pufferpanel/doctor.js --env tty
 *   node pufferpanel/doctor.js --env host --os linux --arch arm64
 *   node pufferpanel/doctor.js --json '{...}'      # a template you pasted in
 */

'use strict'

const fs = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, 'zincai.json')

/** PufferPanel maps these three names to the same TTY host environment. */
const HOST_FAMILY = ['host', 'tty', 'standard']

/**
 * The subset of pufferpanel.Server (server.go) / Execution (server.go) whose
 * JSON shape the decoder actually enforces. This matters more than any other
 * check in this file:
 *
 *   services/templates.go GetAllFromRepo → readTemplateFromDisk does
 *     json.NewDecoder(file).Decode(template)
 *   and on error it logs and `continue`s. The template is not listed at all —
 *   no greyed-out row, no error in the UI, just nothing. A single JSON string
 *   where the struct declares a bool (e.g. "autostart": "${autostart}") is
 *   enough: encoding/json cannot coerce "..." into bool, so the WHOLE template
 *   is dropped from the panel.
 *
 * `any` means the field is an interface{} and accepts anything.
 */
const SERVER_FIELDS = {
  type: 'string',
  display: 'string',
  icon: 'string',
  data: 'object',
  groups: 'array',
  install: 'array',
  uninstall: 'array',
  run: 'object',
  environment: 'object',
  supportedEnvironments: 'array',
  requirements: 'object',
  stats: 'object',
  query: 'object',
  keepAlive: 'object'
}

const EXECUTION_FIELDS = {
  command: 'any',
  stop: 'string',
  stopCode: 'integer',
  pre: 'array',
  post: 'array',
  environmentVars: 'object',
  workingDirectory: 'string',
  stdin: 'object',
  autostart: 'boolean',
  autorecover: 'boolean',
  autorestart: 'boolean',
  expectedExitCode: 'integer'
}

const kindOf = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v

function checkShape (object, fields, prefix, errors) {
  for (const [key, value] of Object.entries(object || {})) {
    const want = fields[key]
    if (!want || want === 'any') continue
    const got = kindOf(value)
    const ok = want === 'integer' ? got === 'number' && Number.isInteger(value) : got === want
    if (!ok) errors.push(`${prefix}${key} is ${got} (${JSON.stringify(value)}) but PufferPanel declares ${want}`)
  }
}

/**
 * Every place the panel's decoder would reject this template. Returns [] when
 * the panel can read it, which is the only way it shows up in the panel at all.
 */
function decodeErrors (template) {
  const errors = []
  checkShape(template, SERVER_FIELDS, '', errors)
  checkShape(template.run, EXECUTION_FIELDS, 'run.', errors)
  return errors
}

/**
 * Install-safety checks for the values baked into a template.
 *
 * These are not decode errors — the panel accepts these happily and then the
 * install fails on the node, which is a far worse place to find out. The one
 * that bit us: `repo` carried a placeholder (`github.com/your-name/...`), so
 * `git clone` asked GitHub for a repository that does not exist, GitHub
 * answered with a credential prompt, and the install died with
 * "Invalid username or token" — looking like an auth problem when the real
 * problem was that nobody had ever replaced the placeholder.
 */
const PLACEHOLDER_RE = /(your-name|your-org|your_org|yourname|example\.(com|org)|CHANGEME|<[a-z-]+>)/i
function installErrors (template) {
  const errors = []
  // `--json` and the file on disk carry the panel's variable map under `data`;
  // a template pasted in the web UI keeps the same shape. A bare template with
  // no `data` simply has nothing to check.
  const vars = (template && template.data) || {}
  const repo = vars.repo && vars.repo.value
  if (typeof repo === 'string' && PLACEHOLDER_RE.test(repo)) {
    errors.push(`repo is a placeholder (${repo}) — the node will try to clone a repository that does not exist and the panel will prompt for a password. Set it to the real clone URL.`)
  }
  // A clone URL nobody can reach without credentials is fine ONLY when it says so.
  if (typeof repo === 'string' && /^git@github\.com:/.test(repo) && !/private/i.test(String(vars.repo.desc || ''))) {
    errors.push('repo uses an SSH URL but its description does not say a deploy key is required — a node without one will hang on the host key prompt')
  }
  if (vars.repo && vars.repo.userEdit === false && typeof repo === 'string' && PLACEHOLDER_RE.test(repo)) {
    errors.push('repo is a placeholder AND userEdit is false — nobody can fix it from the panel; the template is unusable as shipped')
  }
  return errors
}

function parseArgs (argv) {
  const out = { env: 'host', os: process.platform === 'linux' ? 'linux' : process.platform, arch: null, json: null, scan: null, refresh: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--env') out.env = argv[++i]
    else if (a.startsWith('--env=')) out.env = a.slice('--env='.length)
    else if (a === '--os') out.os = argv[++i]
    else if (a.startsWith('--os=')) out.os = a.slice('--os='.length)
    else if (a === '--arch') out.arch = argv[++i]
    else if (a.startsWith('--arch=')) out.arch = a.slice('--arch='.length)
    else if (a === '--json') out.json = argv[++i]
    else if (a === '--scan') out.scan = argv[++i] || path.join(__dirname, '..')
    else if (a.startsWith('--scan=')) out.scan = a.slice('--scan='.length)
    else if (a === '--refresh') out.refresh = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!out.arch) out.arch = process.arch
  return out
}

/** The same three predicates SelectTemplate.vue runs, in the same order. */
function compatibility (template, { env, os, arch }) {
  const supported = Array.isArray(template.supportedEnvironments) && template.supportedEnvironments.length
    ? template.supportedEnvironments
    : (template.environment ? [template.environment] : [])
  const requirements = template.requirements || {}
  return {
    env: { ok: supported.some((e) => e && e.type === env), have: supported.map((e) => e && e.type), want: env },
    os: { ok: !requirements.os || requirements.os === os, have: requirements.os || '(any)', want: os },
    arch: { ok: !requirements.arch || requirements.arch === arch, have: requirements.arch || '(any)', want: arch },
    // Values the panel decodes happily but the node cannot install from.
    install: installErrors(template)
  }
}

/**
 * Emulate services/templates.go GetAllFromRepo: every NON-DOT top-level directory
 * is scanned, and every `*.json` directly inside it (except `data.json`) is
 * loaded as a template named after the file. A file that is not a template still
 * gets listed — with no display name and no supportedEnvironments, so the panel
 * shows it as a nameless, permanently incompatible entry.
 */
function scanRepo (root) {
  const found = []
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === 'node_modules') continue
    const full = path.join(root, dir.name)
    for (const file of fs.readdirSync(full, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name === 'data.json') continue
      const filePath = path.join(full, file.name)
      let parsed = null
      let error = null
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      } catch (err) {
        error = err.message
      }
      found.push({ name: file.name.slice(0, -'.json'.length), path: path.relative(root, filePath), parsed, error })
    }
  }
  return found
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node pufferpanel/doctor.js [--env host|tty|standard|docker] [--os linux] [--arch arm64|x64] [--json <template>] [--scan <repo root>] [--refresh]')
    return 0
  }

  if (args.refresh) return refreshMain()
  if (args.scan) return scanMain(args)

  const template = args.json ? JSON.parse(args.json) : JSON.parse(fs.readFileSync(SOURCE, 'utf8'))
  const verdict = compatibility(template, args)

  console.log(`template: ${template.display || template.name || '(unnamed)'}`)
  console.log(`node:     env=${args.env} os=${args.os} arch=${args.arch}`)
  console.log('')
  console.log(`environment: ${verdict.env.ok ? 'OK' : 'INCOMPATIBLE'}  (template offers: ${verdict.env.have.join(', ') || 'nothing'}; node reports: ${verdict.env.want})`)
  console.log(`os:          ${verdict.os.ok ? 'OK' : 'INCOMPATIBLE'}  (template: ${verdict.os.have}; node: ${verdict.os.want})`)
  console.log(`arch:        ${verdict.arch.ok ? 'OK' : 'INCOMPATIBLE'}  (template: ${verdict.arch.have}; node: ${verdict.arch.want})`)

  // A template the panel cannot decode is never listed at all — it is not a
  // compatibility problem, so say it first and say it plainly.
  const undecodable = decodeErrors(template)
  console.log(`decoder:     ${undecodable.length ? 'WOULD BE DROPPED' : 'OK'}  (PufferPanel's json.Decode into pufferpanel.Server)`)
  if (undecodable.length) {
    for (const e of undecodable) console.log(`             ${e}`)
    console.log('\nThe panel skips a template it cannot decode (services/templates.go logs and')
    console.log('continues), so it never appears: no row, no error, nothing to grey out.')
    console.log('Fix: give those fields the JSON type the struct declares — run.autostart,')
    console.log('autorecover and autorestart are Go bools, so they take true/false and never')
    console.log('a "${...}" token. The same flags are set per server by the panel itself.')
    return 1
  }

  // Values the panel accepts but the node cannot act on: a placeholder clone URL
  // fails at INSTALL time, on the node, looking like an auth error.
  if (verdict.install.length) {
    console.log('\nThe panel will list this template, but installing it will fail:')
    for (const e of verdict.install) console.log(`  - ${e}`)
    console.log('Fix: correct the value in the template JSON before shipping it.')
    return 1
  }

  const ok = verdict.env.ok && verdict.os.ok && verdict.arch.ok
  if (ok) {
    console.log('\nThis template will be offered for that node.')
    return 0
  }

  console.log('\nThe create-server page will list it under "Incompatible templates".')
  if (!verdict.env.ok) {
    const family = HOST_FAMILY.includes(args.env) ? HOST_FAMILY : []
    if (family.length && verdict.env.have.some((t) => family.includes(t))) {
      console.log('\nWhy: this is the host-family trap. PufferPanel implements "host",')
      console.log('"tty" and "standard" with ONE environment (servers/env_loader.go),')
      console.log(`but the page compares the strings exactly, so a node reporting "${args.env}"`)
      console.log('does not match a template that only lists "host".')
      console.log('Fix: add the alias to the template\'s supportedEnvironments list.')
    } else if (verdict.env.want === 'docker') {
      console.log('\nThe node does not advertise docker. Docker is only offered when the')
      console.log('node can actually talk to its Docker socket (GET /daemon/features).')
      console.log('Fix: create the server with the host environment, or fix Docker on the node.')
    } else {
      console.log(`\nThe node reports "${args.env}", which the template does not list.`)
    }
  }
  if (!verdict.os.ok) {
    console.log(`\nOS: the template requires "${verdict.os.have}" but the node reports "${verdict.os.want}".`)
  }
  if (!verdict.arch.ok) {
    console.log(`\nArchitecture: the template requires "${verdict.arch.have}" but the node reports "${verdict.arch.want}".`)
    console.log('`requirements.arch` is a single string, not a list, so it is best left out')
    console.log('unless the template truly cannot run elsewhere.')
  }

  // An ARM node is supported for everything this template does, so say so
  // rather than leaving the operator wondering whether the board is the problem.
  if (args.arch === 'arm64' || args.arch === 'arm') {
    console.log('\nNote on ARM (Orange Pi, Raspberry Pi): nothing in this project is')
    console.log('architecture-specific — it is plain Node.js, so an ARM node runs it with')
    console.log(`its own node/npm. If an operator does pin a version, operations/nodejsdl`)
    console.log(`downloads the matching linux build itself (GOARCH ${args.arch}).`)
  }
  return 1
}

if (require.main === module) {
  try {
    const result = main()
    // --refresh is async; everything else returns a number.
    if (result && typeof result.then === 'function') {
      result.then((code) => { process.exitCode = code }).catch((err) => {
        console.error(err.message)
        process.exitCode = 1
      })
    } else {
      process.exitCode = result
    }
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}

/** Report every phantom entry the panel would list for a template repo. */
function scanMain (args) {
  const entries = scanRepo(path.resolve(args.scan))
  console.log(`scanning ${path.resolve(args.scan)} the way PufferPanel does`)
  console.log('(every non-dot top-level folder, every *.json directly inside it, except data.json)')
  console.log('')
  let broken = 0
  let dropped = 0
  for (const entry of entries) {
    const isTemplate = entry.parsed && (entry.parsed.type || entry.parsed.display || entry.parsed.run || entry.parsed.install)
    const verdict = entry.parsed ? compatibility(entry.parsed, args) : { env: { ok: false }, os: { ok: false }, arch: { ok: false } }
    const undecodable = entry.parsed ? decodeErrors(entry.parsed) : []
    const install = entry.parsed ? installErrors(entry.parsed) : []
    const ok = isTemplate && !undecodable.length && !install.length && verdict.env.ok && verdict.os.ok && verdict.arch.ok
    if (!isTemplate) broken++
    if (undecodable.length) dropped++
    if (install.length) broken++
    console.log(`${ok ? 'OK        ' : undecodable.length ? 'DROPPED   ' : 'PHANTOM   '} ${entry.path}`)
    console.log(`           name="${entry.name}" display=${JSON.stringify((entry.parsed && entry.parsed.display) || '')}`)
    if (entry.error) console.log(`           not valid JSON: ${entry.error}`)
    else if (undecodable.length) {
      console.log('           the panel cannot decode this template, so it lists NOTHING for it:')
      for (const e of undecodable) console.log(`             ${e}`)
    } else if (install.length) {
      console.log('           the panel lists it, but INSTALL will fail on the node:')
      for (const e of install) console.log(`             ${e}`)
    } else if (!isTemplate) console.log('           not a template: no type/display/install/run. The panel lists it anyway,')
    if (!isTemplate && entry.parsed && !entry.error) console.log('           with no name and no supportedEnvironments, so it can never be used.')
  }
  console.log('')
  if (dropped) {
    console.log(`${dropped} template(s) would be silently dropped by the panel's JSON decoder.`)
    console.log("Fix: a field's JSON type must match PufferPanel's Go struct - run.autostart,")
    console.log('autorecover and autorestart are booleans, not "${...}" strings. See --help.')
    return 1
  }
  if (broken) {
    console.log(`${broken} file(s) would show up as a nameless "incompatible" entry.`)
    console.log('Fix: rename or move them out of the two-level layout the panel scans.')
    return 1
  }
  console.log(`${entries.length} template(s), all usable on env=${args.env} os=${args.os} arch=${args.arch}.`)
  return 0
}

/**
 * Force the panel to re-pull the template repository.
 *
 * validateRepoOnDisk caches the clone per repo ID and only re-pulls when
 * LastRefreshed is older than 5 minutes; while a pull is in flight it holds
 * pathLock, so other requests may report an error instead of a template list.
 * Removing and re-adding the repo wipes the clone from
 * <data>/cache/template-repos/<id>, which is the reliable way to pick up a new
 * commit immediately.
 *
 * Note that the panel clones the URL stored in the repo row — if that is your
 * fork, an upstream merge changes nothing until the fork has the commit.
 */
/**
 * Log in and force the panel to re-clone its template repositories.
 *
 * PufferPanel does NOT accept HTTP Basic auth on /api/* (middleware/auth.go only
 * takes `Authorization: Bearer ...` or the puffer_auth cookie), so the only way
 * in from a script is POST /auth/login, which sets the cookie and returns the
 * session's scopes. We then send the cookie back — it is the same session the
 * browser would use, so this adds no privileged path and no stored password.
 *
 * What "refresh" really is: PufferPanel keeps the clone under
 * <data>/cache/template-repos/<repo id> and re-pulls it at most every 5 min
 * (services/templates.go validateRepoOnDisk). DELETE + POST /api/templates
 * gives the repo a new id, which guarantees a fresh clone on the next listing —
 * the same thing the browser does when you remove and re-add the repo.
 */
async function refreshMain () {
  const base = (process.env.PUFFER_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
  const user = process.env.PUFFER_USER
  const pass = process.env.PUFFER_PASS
  if (!user || !pass) {
    console.error('Set PUFFER_USER and PUFFER_PASS (a panel admin) — optionally PUFFER_URL.')
    console.error('This logs in, deletes the template repository and re-adds the same URL,')
    console.error('which gives it a new id and forces a fresh clone on the next listing.')
    return 1
  }

  let cookie = null
  const call = async (method, endpoint, body) => {
    const headers = { 'Content-Type': 'application/json' }
    if (cookie) headers.Cookie = cookie
    const res = await fetch(base + endpoint, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    })
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    for (const c of setCookie) {
      if (c.startsWith('puffer_auth=')) cookie = c.split(';')[0]
    }
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    return { status: res.status, body: parsed }
  }

  try {
    // 1. Log in the way the web UI does: same endpoint, same cookie.
    const login = await call('POST', '/auth/login', { email: user, password: pass })
    if (login.status !== 200) {
      console.error(`POST /auth/login -> ${login.status}: ${JSON.stringify(login.body)}`)
      console.error('PUFFER_USER is the panel account EMAIL, not the username.')
      return 1
    }
    if (login.body && login.body.needsSecondFactor) {
      console.error('That account has a second factor enabled, which this script cannot answer.')
      console.error('Nothing was changed. Use a panel admin without 2FA, or clear the cache')
      console.error('on the node instead (see pufferpanel/README.md).')
      return 1
    }
    if (!cookie) {
      console.error('Login succeeded but the panel did not set a puffer_auth cookie;')
      console.error('check that PUFFER_URL points at the panel itself (not a proxy that drops cookies).')
      return 1
    }

    // 2. Re-add each git repo, which is what invalidates the clone.
    const repos = await call('GET', '/api/templates')
    if (repos.status === 401 || repos.status === 403) {
      console.error(`GET /api/templates -> ${repos.status}: the account lacks templates.view`)
      return 1
    }
    if (repos.status !== 200) {
      console.error(`GET /api/templates -> ${repos.status}: ${JSON.stringify(repos.body)}`)
      return 1
    }
    const rows = Array.isArray(repos.body) ? repos.body : []
    const gitRepos = rows.filter((r) => r.id !== 0)
    if (!gitRepos.length) {
      console.log('No git template repositories are configured — nothing to refresh.')
      console.log('Templates that were pasted in the web UI live in the panel database (repo 0)')
      console.log('and never need a re-clone; re-paste them if the JSON itself changed.')
      return 0
    }

    // Before touching anything, find out whether any repo already fails to
    // list. If one does, the create-server step is blank for EVERY repo, because
    // SelectTemplate.vue reads `templates.length` on the undefined result — so
    // say which repo it is instead of re-adding repos blindly.
    const blanking = []
    for (const repo of gitRepos) {
      const listed = await call('GET', `/api/templates/${repo.id}`)
      if (listed.status !== 200) blanking.push({ repo, status: listed.status, body: listed.body })
    }
    if (blanking.length) {
      console.error('Before refresh: these repositories fail to list. While one of them')
      console.error('does, the create-server template step shows NO templates at all —')
      console.error('including those from repos that are fine (SelectTemplate.vue reads')
      console.error('`templates.length` on the undefined result of the failed repo).')
      for (const b of blanking) {
        console.error(`  repo ${b.repo.id} "${b.repo.name}" ${b.repo.url} (branch ${b.repo.branch || 'main'})`)
        console.error(`    GET /api/templates/${b.repo.id} -> ${b.status}: ${JSON.stringify(b.body)}`)
      }
      console.error('Re-cloning below; a stale clone is often all it was.')
      console.error('')
    }

    // Only what is still broken AFTER the re-clone counts as a failure.
    let bad = 0
    for (const repo of gitRepos) {
      console.log(`repo ${repo.id} "${repo.name}" ${repo.url} (branch ${repo.branch || 'main'})`)
      const del = await call('DELETE', `/api/templates/${repo.id}`)
      if (del.status >= 300) {
        console.error(`  DELETE -> ${del.status}: ${JSON.stringify(del.body)}`)
        bad++
        continue
      }
      const add = await call('POST', '/api/templates', { name: repo.name, url: repo.url, branch: repo.branch || 'main' })
      if (add.status >= 300) {
        console.error(`  POST -> ${add.status}: ${JSON.stringify(add.body)}`)
        console.error('  The repo was removed; re-add it in Templates -> Add repo with the same values.')
        bad++
        continue
      }
      const newId = add.body && add.body.id !== undefined ? add.body.id : repo.id
      const fresh = await call('GET', `/api/templates/${newId}`)
      if (fresh.status !== 200) {
        console.error(`  GET /api/templates/${newId} -> ${fresh.status}: ${JSON.stringify(fresh.body)}`)
        console.error('  Still failing after a fresh clone — this is the repo that blanks the')
        console.error('  create-server template list. Fix its URL/branch/credentials, or remove it.')
        bad++
        continue
      }
      const list = Array.isArray(fresh.body) ? fresh.body : []
      console.log(`  now lists: ${list.length ? list.map((t) => t.name).join(', ') : '(nothing)'}`)
      if (!list.length) {
        console.error('  The clone worked but contains no template. The panel reads')
        console.error('  <repo root>/<folder>/<name>.json and ignores files at the root.')
        console.error('  Also check the branch exists: a wrong branch makes the clone fail.')
        bad++
        continue
      }
      for (const t of list) {
        const problems = decodeErrors(t)
        if (!t.display) problems.push('no display name: the JSON is not a template, or the panel could not read it')
        if (problems.length) {
          console.error(`  ${t.name}: NOT USABLE`)
          for (const p of problems) console.error(`    ${p}`)
          bad++
        } else {
          console.log(`  ${t.name}: "${t.display}" OK`)
        }
      }
    }

    if (bad) {
      console.error('\nSome entries above would not work in the panel. Fix them and push;')
      console.error('the panel re-pulls the repository by itself within five minutes.')
      return 1
    }
    console.log('\nDone. Open Templates in the panel to see them.')
    return 0
  } catch (err) {
    console.error(`could not talk to the panel: ${err.message}`)
    return 1
  }
}

module.exports = { compatibility, parseArgs, scanRepo, refreshMain, decodeErrors, installErrors, PLACEHOLDER_RE, HOST_FAMILY, SERVER_FIELDS, EXECUTION_FIELDS }
