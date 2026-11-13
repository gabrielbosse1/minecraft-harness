#!/usr/bin/env node
/**
 * pufferpanel/import.js — validate the ZincAI template and lay it out as a
 * PufferPanel 3 template repository.
 *
 * HOW PUFFERPANEL 3 ACTUALLY READS TEMPLATES (services/templates.go, v3):
 * there is no template directory on disk to drop a file into, and there is no
 * "Templates -> Import" button. A template reaches the panel one of two ways:
 *
 *   1. SAVED IN THE DATABASE — the web UI: Templates -> New, paste the JSON in
 *      the "Json" tab, Save. The name comes from the JSON's own `name` field
 *      and it is stored in the panel's database (repo id 0, "Local").
 *   2. FROM A GIT REPOSITORY — Templates -> "Add repo": Name, Url, Branch. The
 *      panel clones that repository into <cache>/template-repos/<id>/ and reads
 *      templates from its IMMEDIATE SUBFOLDERS:
 *          repo-root/<any-folder>/<template-name>.json   (+ optional README.md)
 *      Files at the repository root are ignored. The template name is the file
 *      name without ".json"; the `name` field inside is not used on this path.
 *
 * So this script writes mode 2: `--dir <root>` produces
 *   <root>/zincai/zincai.json
 *   <root>/zincai/README.md      (what the panel shows on the template page)
 * and you point the panel's "Add repo" at a git repository containing that
 * layout — this repository already does (see pufferpanel/README.md).
 *
 *   node pufferpanel/import.js                  # validate, explain both paths
 *   node pufferpanel/import.js --dir <root>     # dry run: print what it writes
 *   node pufferpanel/import.js --dir <root> --apply
 *   node pufferpanel/import.js --print          # the JSON to paste into the UI
 *
 * `--print` is the paste path: the template needs a `name` field there, since
 * the UI takes the name from the JSON and not from the file name.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, 'zincai.json')
const README_SOURCE = path.join(__dirname, 'README.md')
// The panel reads <repo>/<folder>/<name>.json — one folder per game, which is
// also how github.com/PufferPanel/templates is laid out.
const FOLDER_NAME = 'zincai'
const FILE_NAME = 'zincai.json'
/** Template name the panel will show for a repository import (the file name). */
const TEMPLATE_NAME = 'zincai'

function parseArgs (argv) {
  const out = { apply: false, dir: null, help: false, print: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--print') out.print = true
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
  // Not an error for a repository template (the file name is the name), but the
  // web UI refuses to save a template without it, so it is reported.
  if (template.name !== undefined) need(typeof template.name === 'string' && template.name.trim(), 'name must be a non-empty string when present')

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
    console.log('usage: node pufferpanel/import.js [--dir <repo root>] [--apply] [--print]')
    return 0
  }

  const template = JSON.parse(fs.readFileSync(SOURCE, 'utf8'))
  const errors = validate(template)
  if (errors.length) {
    for (const e of errors) console.error(`template error: ${e}`)
    return 1
  }
  console.log(`template OK: ${template.display} (${Object.keys(template.data).length} variables, ${(template.install || []).length} install steps)`)

  // The paste path: PufferPanel's UI takes the template name from the JSON, so
  // the printed object carries the name the panel will show.
  if (args.print) {
    process.stdout.write(JSON.stringify({ name: TEMPLATE_NAME, ...template }, null, 4) + '\n')
    return 0
  }

  if (!args.dir) {
    console.log('')
    console.log('PufferPanel 3 has no template folder to copy into. Two ways in:')
    console.log('')
    console.log('  1. Web UI  — Templates -> New, paste the output of:')
    console.log('                 node pufferpanel/import.js --print')
    console.log('     (the name comes from the JSON, so this path needs the name field)')
    console.log('')
    console.log('  2. Git repo — Templates -> Add repo (Name / Url / Branch). The panel')
    console.log('     clones it and reads <root>/<folder>/<name>.json. This repository')
    console.log('     already has that layout at pufferpanel/. To produce a repo tree')
    console.log('     yourself:')
    console.log('                 node pufferpanel/import.js --dir <root> --apply')
    return 0
  }

  const folder = path.join(args.dir, FOLDER_NAME)
  const target = path.join(folder, FILE_NAME)
  const targetReadme = path.join(folder, 'README.md')
  console.log(`target: ${target}`)
  console.log(`        ${targetReadme}`)

  if (!args.apply) {
    console.log('dry run — re-run with --apply to write them')
    return 0
  }
  fs.mkdirSync(folder, { recursive: true })
  fs.copyFileSync(SOURCE, target)
  if (fs.existsSync(README_SOURCE)) fs.copyFileSync(README_SOURCE, targetReadme)
  console.log('written — commit/push this tree, then add the repository in the panel')
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

module.exports = { validate, parseArgs, FOLDER_NAME, FILE_NAME, TEMPLATE_NAME }
