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

test('template: both supported environments are declared', () => {
  const types = template.supportedEnvironments.map((e) => e.type)
  assert.deepEqual(types.sort(), ['docker', 'host'])
  const docker = template.supportedEnvironments.find((e) => e.type === 'docker')
  assert.match(docker.image, /^node:\$\{nodeversion\}/, 'the Docker image follows the nodeversion variable')
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
