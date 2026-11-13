/**
 * pufferpanel.test.js — the template behaves like a PufferPanel 3 template.
 *
 * The checks mirror what the panel itself does at install and start time:
 * every operation type must exist in PufferPanel's factory list, conditions
 * are CEL expressions against the template's own variables, the run command is
 * a list of alternatives (not a sequence of steps), and a stop is either a
 * console command or a signal code.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const template = require('../pufferpanel/zincai.json')
const { validate, parseArgs } = require('../pufferpanel/import')

// operations/operation_process.go, PufferPanel 3
const OPERATIONS = new Set([
  'alterfile', 'archive', 'command', 'console', 'curseforge', 'dockerpull',
  'download', 'extract', 'fabricdl', 'forgedl', 'javadl', 'mkdir', 'mojangdl',
  'move', 'neoforgedl', 'nodejsdl', 'paperdl', 'resolveforgeversion',
  'resolveneoforgeversion', 'sleep', 'spongedl', 'stdin', 'steamgamedl',
  'writefile'
])

const allOperations = () => [
  ...(template.install || []),
  ...(template.run.pre || []),
  ...(template.run.post || [])
]

test('template: every operation type is one PufferPanel actually implements', () => {
  for (const op of allOperations()) {
    assert.ok(OPERATIONS.has(op.type), `unknown operation type: ${op.type}`)
  }
})

test('template: conditions only use CEL-safe syntax and known variables', () => {
  const declared = new Set([...Object.keys(template.data), 'env', 'os', 'arch'])
  const conditions = allOperations().map((op) => op.if).filter(Boolean)
  assert.ok(conditions.length > 0)
  for (const cond of conditions) {
    assert.doesNotMatch(cond, /\$\{/, `a condition must not contain template tokens: ${cond}`)
    const bare = cond.replace(/'[^']*'/g, "''") // arguments inside functions are literals, not variables
    for (const m of bare.matchAll(/([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const word = m[1]
      if (['env', 'os', 'arch', 'host', 'docker', 'windows', 'linux', 'true', 'false', 'in_path', 'file_exists'].includes(word)) continue
      assert.ok(declared.has(word), `condition "${cond}" references undeclared "${word}"`)
    }
  }
})

test('template: the run command is a list of alternatives with a default', () => {
  const cmds = template.run.command
  assert.ok(Array.isArray(cmds))
  assert.ok(cmds.some((c) => c.if === undefined), 'one unconditional command must exist as the fallback')
  const docker = cmds.find((c) => c.command === 'node ${entrypoint}' && c.if === undefined)
  assert.ok(docker, 'Docker gets a plain node command: the image already has Node.js')
  const host = cmds.find((c) => /^node\$\{nodeversion\}/.test(c.command) && /host/.test(c.if))
  assert.ok(host, 'a host run uses the installed node${nodeversion} binary')
})

test('template: stop is a signal code, and the bot handles SIGINT/SIGTERM', () => {
  assert.equal(typeof template.run.stopCode, 'number')
  const src = fs.readFileSync(path.join(__dirname, '..', 'zincai', 'index.js'), 'utf8')
  assert.match(src, /process\.on\('SIGINT'/)
  assert.match(src, /process\.on\('SIGTERM'/)
})

test('template: Node.js is provisioned on host nodes only', () => {
  const dl = template.install.find((op) => op.type === 'nodejsdl')
  assert.ok(dl, 'nodejsdl is used on host nodes')
  assert.match(dl.if, /host/)
  assert.match(dl.if, /nodeversion/)
  assert.equal(template.data.nodeversion.value, '22')
})

test('template: dependencies are installed without dev dependencies', () => {
  const commands = template.install.flatMap((op) => op.commands || []).join(' \n ')
  assert.match(commands, /npm\$\{nodeversion\} ci --omit=dev/, 'host install uses the downloaded npm')
  assert.match(commands, /npm ci --omit=dev/, 'docker install uses the image npm')
})

test('template: install never regenerates a settings file — variables come from the panel', () => {
  assert.equal(allOperations().some((op) => op.type === 'writefile'), false)
  for (const [name, value] of Object.entries(template.run.environmentVars)) {
    assert.equal(typeof value, 'string', `${name} must be a string`)
  }
})

test('template: datadir is guaranteed to exist before the bot writes to it', () => {
  const mkdir = template.install.find((op) => op.type === 'mkdir')
  assert.ok(mkdir)
  assert.equal(mkdir.target, '${datadir}')
  assert.equal(template.run.environmentVars.ZINC_DATA_DIR, '${datadir}')
})

test('template: an invalid key fails the install step and is named', () => {
  assert.equal(template.data.apikey.required, true)
  const { validate: v } = require('../pufferpanel/import')
  const clone = JSON.parse(JSON.stringify(template))
  delete clone.data.apikey
  assert.ok(v(clone).some((e) => /apikey/.test(e)), 'a template without the key variable is rejected')
})

test('template: every host-family environment is declared (host, tty, standard) plus docker', () => {
  const types = template.supportedEnvironments.map((e) => e.type)
  // PufferPanel maps host/tty/standard to the SAME implementation
  // (servers/env_loader.go) but SelectTemplate.vue compares the strings exactly,
  // so a node reporting "tty" must find its own entry or the template is greyed
  // out as "Incompatible with environment 'host'".
  assert.deepEqual(types.sort(), ['docker', 'host', 'standard', 'tty'])
  const docker = template.supportedEnvironments.find((e) => e.type === 'docker')
  assert.match(docker.image, /^node:\$\{nodeversion\}/, 'the Docker image follows the nodeversion variable')
})

test('template: the doctor agrees with every host-family environment name', () => {
  const { compatibility } = require('../pufferpanel/doctor')
  for (const env of ['host', 'tty', 'standard', 'docker']) {
    const v = compatibility(template, { env, os: 'linux', arch: 'arm64' })
    assert.equal(v.env.ok, true, `${env} must be offered on an arm64 linux node`)
    assert.equal(v.os.ok, true)
    assert.equal(v.arch.ok, true, 'no architecture requirement is declared')
  }
  // An unknown environment is still refused, so the check is real.
  assert.equal(compatibility(template, { env: 'nope', os: 'linux', arch: 'arm64' }).env.ok, false)
})

test('template: host conditions treat host, tty and standard alike', () => {
  const conditions = allOperations().map((op) => op.if).filter(Boolean)
  // Nothing may still compare only against 'host': that is the bug that made
  // the template unusable on a node that reports another host-family name.
  for (const cond of conditions) {
    if (!/\bhost\b/.test(cond)) continue
    for (const alias of ['tty', 'standard']) {
      assert.match(cond, new RegExp(alias), `condition "${cond}" must accept "${alias}" too`)
    }
  }
  // And the docker branch must not swallow a tty node.
  const fallback = template.install.find((op) => /npm ci/.test((op.commands || []).join(' ')) && /^\!/.test(op.if || ''))
  assert.ok(fallback, 'a non-host install branch exists')
  assert.match(fallback.if, /tty/)
})

test('repo layout: the panel scan finds exactly one template, and it is ours', () => {
  // services/templates.go GetAllFromRepo walks every non-dot top-level folder and
  // loads every *.json directly inside it (except data.json) as a template named
  // after the file. A stray JSON becomes a nameless, permanently incompatible
  // entry in the create-server list — which is what made the panel show a blank
  // template on top of the real one.
  const { scanRepo } = require('../pufferpanel/doctor')
  const root = path.join(__dirname, '..')
  const entries = scanRepo(root)
  assert.equal(entries.length, 1, `exactly one scannable JSON is allowed, found: ${entries.map((e) => e.path).join(', ')}`)
  assert.equal(entries[0].path, path.join('pufferpanel', 'zincai.json'))
  assert.ok(entries[0].parsed, 'the template parses')
})

test('repo layout: no other two-level JSON exists that the panel would mis-list', () => {
  // Belt and braces: even if a future file lands in a scanned position, it must
  // be a real template (has type/display/install/run), never a config blob.
  const { scanRepo } = require('../pufferpanel/doctor')
  const entries = scanRepo(path.join(__dirname, '..'))
  for (const entry of entries) {
    assert.ok(entry.parsed, `${entry.path} must be valid JSON`)
    const looksLikeTemplate = Boolean(entry.parsed.type || entry.parsed.display || entry.parsed.install || entry.parsed.run)
    assert.ok(looksLikeTemplate, `${entry.path} would be listed by the panel as a nameless template`)
    assert.ok(Array.isArray(entry.parsed.supportedEnvironments) && entry.parsed.supportedEnvironments.length,
      `${entry.path} must declare supportedEnvironments or it can never be used`)
  }
})

test('doctor: --scan exits non-zero for a repo with a stray JSON, zero for ours', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'doctor.js')
  const ok = execFileSync(process.execPath, [script, '--scan', path.join(__dirname, '..'), '--env', 'host', '--arch', 'arm64'], { encoding: 'utf8' })
  assert.match(ok, /1 template\(s\), all usable/)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-scan-'))
  fs.mkdirSync(path.join(tmp, 'mod'))
  fs.writeFileSync(path.join(tmp, 'mod', 'stray.json'), '{"a":1}')
  let code = 0
  let out = ''
  try {
    execFileSync(process.execPath, [script, '--scan', tmp], { encoding: 'utf8' })
  } catch (err) {
    code = err.status
    out = String(err.stdout)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  assert.equal(code, 1, 'a stray JSON must fail the scan')
  assert.match(out, /PHANTOM/)
  assert.match(out, /nameless/)
})

test('doctor: --refresh refuses to run without credentials, and exports the helper', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'doctor.js')
  const env = { ...process.env }
  delete env.PUFFER_USER
  delete env.PUFFER_PASS
  let code = 0
  let err = ''
  try {
    execFileSync(process.execPath, [script, '--refresh'], { encoding: 'utf8', env, stdio: 'pipe' })
  } catch (e) {
    code = e.status
    err = String(e.stderr)
  }
  assert.equal(code, 1, 'no credentials must be a failure, not a silent success')
  assert.match(err, /PUFFER_USER/)

  const { refreshMain } = require('../pufferpanel/doctor')
  assert.equal(typeof refreshMain, 'function')
  // It must be async: the old sync entry point printed
  // "The code argument must be of type number. Received an instance of Promise".
  assert.ok(refreshMain.constructor.name === 'AsyncFunction')
})

test('config: the shipped defaults live outside the folder the panel scans', () => {
  // zincai/config/defaults.json is three levels deep on purpose: <folder>/<file>.json
  // would be picked up as a template by the panel and shown as a blank entry.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'zincai', 'config', 'defaults.json')))
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'zincai', 'config.json')),
    'zincai/config.json would be mis-read by PufferPanel as a template')
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'zincai', 'defaults.json')),
    'zincai/defaults.json would also be mis-read (the scanner takes any *.json)')
})

test('doctor: reports the node it was given, and fails a real incompatibility', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'doctor.js')
  const good = execFileSync(process.execPath, [script, '--env', 'tty', '--os', 'linux', '--arch', 'arm64'], { encoding: 'utf8' })
  assert.match(good, /environment: OK/)
  assert.match(good, /arm64/)

  // A template that lists only "host" is what produced the reported error.
  const onlyHost = JSON.stringify({ ...template, supportedEnvironments: [{ type: 'host' }, { type: 'docker' }] })
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [script, '--env', 'tty', '--json', onlyHost], { encoding: 'utf8' })
  } catch (err) {
    code = err.status
    out = String(err.stdout)
  }
  assert.equal(code, 1, 'an incompatible template must exit non-zero')
  assert.match(out, /INCOMPATIBLE/)
  assert.match(out, /host-family trap/)
})

test('import.js: --dir, --apply and --print are parsed, unknown flags are refused', () => {
  assert.deepEqual(parseArgs([]), { apply: false, dir: null, help: false, print: false })
  assert.deepEqual(parseArgs(['--dir', '/tmp/x', '--apply']), { apply: true, dir: '/tmp/x', help: false, print: false })
  assert.deepEqual(parseArgs(['--dir=/tmp/x']), { apply: false, dir: '/tmp/x', help: false, print: false })
  assert.deepEqual(parseArgs(['--print']), { apply: false, dir: null, help: false, print: true })
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
})

test('import.js: a dry run writes nothing, --apply lays out a template REPOSITORY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tpl-'))
  const script = path.join(__dirname, '..', 'pufferpanel', 'import.js')

  const dry = execFileSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' })
  assert.match(dry, /template OK/)
  assert.match(dry, /\/zincai\/zincai\.json/)
  assert.deepEqual(fs.readdirSync(dir), [], 'a dry run must not create files')

  const applied = execFileSync(process.execPath, [script, '--dir', dir, '--apply'], { encoding: 'utf8' })
  assert.match(applied, /add the repository in the panel/)
  // PufferPanel 3 reads <repo-root>/<folder>/<name>.json — not a flat file.
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'zincai', 'zincai.json'), 'utf8'))
  assert.deepEqual(written, template)
  assert.ok(fs.existsSync(path.join(dir, 'zincai', 'README.md')), 'the panel shows the folder README')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('import.js: no --dir explains both real import paths instead of a fake directory', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'import.js')
  const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  assert.match(out, /Templates -> New/, 'the web UI path')
  assert.match(out, /Add repo/, 'the git repository path')
  // PufferPanel 3 has no template folder and no Import button; claiming either
  // sends the operator looking for something that does not exist.
  assert.doesNotMatch(out, /no PufferPanel template directory found/)
})

test('import.js: --print emits the named JSON the web UI needs', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'import.js')
  const out = execFileSync(process.execPath, [script, '--print'], { encoding: 'utf8' })
  const parsed = JSON.parse(out.slice(out.indexOf('{')))
  // TemplateCreate.vue takes the template name from the JSON body, not the file.
  assert.equal(parsed.name, 'zincai')
  assert.equal(parsed.display, template.display)
  assert.deepEqual(parsed.data, template.data)
})

test('import.js: the committed template validates with no errors', () => {
  assert.deepEqual(validate(template), [])
})

// ---------------------------------------------------------------------------
// The decoder, not just the conditions.
//
// services/templates.go GetAllFromRepo -> readTemplateFromDisk decodes the
// file into pufferpanel.Server (a Go struct) and, on any error, logs and
// `continue`s. The template is then not merely incompatible: it is absent.
// That is what happened with:
//
//     "run": { "autostart": "${autostart}", "autorecover": "${autorecover}" }
//
// Execution.Autostart is a Go bool, encoding/json cannot unmarshal a string
// into it, and the panel listed nothing at all. These tests keep that from
// coming back, and keep the doctor/import checks honest about catching it.
// ---------------------------------------------------------------------------

test('template: run.autostart/autorecover/autorestart are real booleans, not tokens', () => {
  // A Go bool field. A "${var}" string here makes the panel drop the template.
  for (const key of ['autostart', 'autorecover', 'autorestart']) {
    if (template.run[key] === undefined) continue
    assert.equal(typeof template.run[key], 'boolean', `run.${key} must be a JSON boolean`)
  }
  assert.equal(typeof template.run.stopCode, 'number', 'stopCode is a Go int')
})

test('template: no variable shadows a panel-owned server flag', () => {
  // run.autostart / run.autorecover are template-level booleans that the panel
  // copies onto each server; there is no way for a ${token} to reach them.
  // Exposing them as variables therefore could never work, so they must not
  // exist — and must not be referenced from a group either.
  for (const key of ['autostart', 'autorecover', 'autorestart']) {
    assert.equal(template.data[key], undefined, `data.${key} cannot be forwarded to run.${key} (Go bool)`)
  }
  for (const group of template.groups || []) {
    for (const key of ['autostart', 'autorecover', 'autorestart']) {
      assert.ok(!group.variables.includes(key), `group "${group.display}" references data.${key}, which does not exist`)
    }
  }
})

test('template: every group variable exists, and every user-visible variable is grouped', () => {
  const declared = new Set(Object.keys(template.data))
  const grouped = new Set()
  for (const group of template.groups || []) {
    for (const name of group.variables) {
      assert.ok(declared.has(name), `group "${group.display}" lists "${name}", which is not in data`)
      grouped.add(name)
    }
  }
  for (const [name, variable] of Object.entries(template.data)) {
    // ui/Variables.vue filters `internal` variables out of the settings page, so
    // an internal variable without a group is intentional (`entrypoint` is only
    // read by the install/run commands). A non-internal one would be invisible
    // to the operator for no reason.
    if (variable.internal) continue
    assert.ok(grouped.has(name), `data.${name} belongs to no group, so the create-server page will not show it`)
  }
})

test('template: the panel\'s decoder accepts it (doctor.decodeErrors)', () => {
  const { decodeErrors, SERVER_FIELDS, EXECUTION_FIELDS } = require('../pufferpanel/doctor')
  assert.deepEqual(decodeErrors(template), [])
  // The mirror must stay in step with pufferpanel.Server / Execution, or it
  // would happily pass a template the panel silently drops.
  assert.equal(SERVER_FIELDS.run, 'object')
  assert.equal(EXECUTION_FIELDS.autostart, 'boolean')
  assert.equal(EXECUTION_FIELDS.autorecover, 'boolean')
  assert.equal(EXECUTION_FIELDS.stopCode, 'integer')
})

test('doctor: names the decoder failure instead of blaming the environment', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'doctor.js')
  // Every compatibility predicate passes, so the old doctor said "OK" here.
  const broken = JSON.stringify({ ...template, run: { ...template.run, autostart: '${autostart}', autorecover: '${autorecover}' } })
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [script, '--json', broken, '--env', 'host', '--os', 'linux', '--arch', 'arm64'], { encoding: 'utf8' })
  } catch (err) {
    code = err.status
    out = String(err.stdout)
  }
  assert.equal(code, 1, 'an undecodable template must fail, not report ready')
  assert.match(out, /environment: OK/)
  assert.match(out, /decoder:\s+WOULD BE DROPPED/)
  assert.match(out, /run\.autostart is string .* declares boolean/)
  assert.doesNotMatch(out, /will be offered for that node/)
})

test('doctor: --scan flags a template the panel would silently drop', () => {
  const script = path.join(__dirname, '..', 'pufferpanel', 'doctor.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-decode-'))
  fs.mkdirSync(path.join(tmp, 'agent'))
  fs.writeFileSync(path.join(tmp, 'agent', 'agent.json'),
    JSON.stringify({ type: 'minecraft-java', display: 'x', run: { command: 'node x.js', autostart: '${autostart}' }, environment: { type: 'host' }, supportedEnvironments: [{ type: 'host' }] }))
  let code = 0
  let out = ''
  try {
    execFileSync(process.execPath, [script, '--scan', tmp], { encoding: 'utf8' })
  } catch (err) {
    code = err.status
    out = String(err.stdout)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  assert.equal(code, 1, 'a dropped template must fail the scan')
  assert.match(out, /DROPPED/)
  assert.match(out, /silently dropped/)
})

test('import.js: refuses the token-in-a-bool that made the template vanish', () => {
  const broken = JSON.parse(JSON.stringify(template))
  broken.run.autostart = '${autostart}'
  const errors = validate(broken)
  assert.ok(errors.some((e) => /run\.autostart is string .* declares boolean/.test(e)),
    `expected a bool-shape error, got: ${JSON.stringify(errors)}`)
  // And the real template is still clean.
  assert.deepEqual(validate(template), [])
})
