#!/usr/bin/env node
/**
 * pufferpanel/import.js — install the ZincAI template into a PufferPanel.
 *
 * PufferPanel 3 keeps imported templates under its data directory. The panel
 * normally imports them from the web UI (Templates -> Import); this script does
 * the same thing from a shell, so a node can be provisioned without clicking.
 *
 *   node pufferpanel/import.js                       # print where it should go
 *   node pufferpanel/import.js --dir /var/lib/pufferpanel/templates
 *   node pufferpanel/import.js --dir /var/lib/pufferpanel/templates --apply
 *
 * Without --apply nothing is written: the template is validated and the target
 * path is printed. With --apply the file is copied (or overwritten) and the
 * panel must be restarted to pick it up. Needs write access to the template
 * directory, i.e. run it as the pufferpanel user.
 *
 * A file dropped in that directory can also be imported by hand: Templates ->
 * Import, paste pufferpanel/zincai.json.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, 'zincai.json')
const FILE_NAME = 'zincai.json'
const DEFAULT_DIRS = [
  '/var/lib/pufferpanel/templates',
  '/etc/pufferpanel/templates'
]

function parseArgs (argv) {
  const out = { apply: false, dir: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--dir') out.dir = argv[++i]
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length)
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

/** Structural checks against the PufferPanel template spec. Returns []. */
function validate (template) {
  const errors = []
  const need = (cond, msg) => { if (!cond) errors.push(msg) }

  need(typeof template.type === 'string' && template.type, 'type is required')
  need(typeof template.display === 'string' && template.display, 'display is required')
  need(template.environment && ['host', 'docker'].includes(template.environment.type), 'environment.type must be host or docker')
  need(Array.isArray(template.supportedEnvironments) && template.supportedEnvironments.length > 0, 'supportedEnvironments must list at least one environment')
  need(template.data && typeof template.data === 'object', 'data is required')

  for (const [key, v] of Object.entries(template.data || {})) {
    need(/^[0-9A-Za-z_]+$/.test(key), `data key "${key}" must be alphanumeric`)
    need(['option', 'string', 'boolean', 'integer'].includes(v.type), `data.${key}.type is invalid`)
    if (v.type === 'option') need(Array.isArray(v.options) && v.options.length > 0, `data.${key} is an option without options`)
    if (v.type === 'integer') need(typeof v.value === 'number', `data.${key} is an integer with a non-numeric value`)
  }

  // Every ${token} used anywhere must be a declared variable.
  const declared = new Set(Object.keys(template.data || {}))
  const used = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(/\$\{([^}]+)\}/g)) used.add(m[1])
    } else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(template.run)
  walk(template.install)
  for (const name of used) {
    if (declared.has(name)) continue
    if (['env', 'os', 'arch', 'server', 'success', 'ip', 'port'].includes(name)) continue
    errors.push(`undeclared variable \${${name}} used in the template`)
  }

  const run = template.run || {}
  need(run.command !== undefined, 'run.command is required')
  need(typeof run.stopCode === 'number' || typeof run.stop === 'string', 'run needs stopCode or stop')
  const ops = [...(run.pre || []), ...(run.post || []), ...(template.install || [])]
  for (const op of ops) {
    need(typeof op.type === 'string', 'an operation is missing its type')
  }
  return errors
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node pufferpanel/import.js [--dir <template dir>] [--apply]')
    return 0
  }

  const template = JSON.parse(fs.readFileSync(SOURCE, 'utf8'))
  const errors = validate(template)
  if (errors.length) {
    for (const e of errors) console.error(`template error: ${e}`)
    return 1
  }
  console.log(`template OK: ${template.display} (${Object.keys(template.data).length} variables, ${(template.install || []).length} install steps)`)

  const targetDir = args.dir || DEFAULT_DIRS.find((d) => fs.existsSync(d))
  if (!targetDir) {
    console.log('no PufferPanel template directory found; pass --dir <path> (usually /var/lib/pufferpanel/templates)')
    return 0
  }
  const target = path.join(targetDir, FILE_NAME)
  console.log(`target: ${target}`)

  if (!args.apply) {
    console.log('dry run — re-run with --apply to write it, then restart the panel')
    return 0
  }
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(SOURCE, target)
  console.log('written — restart PufferPanel, then create a server from this template')
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}

module.exports = { validate, parseArgs }
