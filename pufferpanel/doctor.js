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

function parseArgs (argv) {
  const out = { env: 'host', os: process.platform === 'linux' ? 'linux' : process.platform, arch: null, json: null, help: false }
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
    arch: { ok: !requirements.arch || requirements.arch === arch, have: requirements.arch || '(any)', want: arch }
  }
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node pufferpanel/doctor.js [--env host|tty|standard|docker] [--os linux] [--arch arm64|x64] [--json <template>]')
    return 0
  }

  const template = args.json ? JSON.parse(args.json) : JSON.parse(fs.readFileSync(SOURCE, 'utf8'))
  const verdict = compatibility(template, args)

  console.log(`template: ${template.display || template.name || '(unnamed)'}`)
  console.log(`node:     env=${args.env} os=${args.os} arch=${args.arch}`)
  console.log('')
  console.log(`environment: ${verdict.env.ok ? 'OK' : 'INCOMPATIBLE'}  (template offers: ${verdict.env.have.join(', ') || 'nothing'}; node reports: ${verdict.env.want})`)
  console.log(`os:          ${verdict.os.ok ? 'OK' : 'INCOMPATIBLE'}  (template: ${verdict.os.have}; node: ${verdict.os.want})`)
  console.log(`arch:        ${verdict.arch.ok ? 'OK' : 'INCOMPATIBLE'}  (template: ${verdict.arch.have}; node: ${verdict.arch.want})`)

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
    console.log('architecture-specific — it is plain Node.js. On a host node PufferPanel')
    console.log(`downloads Node.js ${template.data && template.data.nodeversion ? template.data.nodeversion.value : '22'} for linux/${args.arch} itself`)
    console.log('(operations/nodejsdl maps GOARCH arm64 → arm64, arm → armv7l).')
  }
  return 1
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}

module.exports = { compatibility, parseArgs, HOST_FAMILY }
