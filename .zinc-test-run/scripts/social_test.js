/**
 * Social stage driver: runs Gabriel on a timed chat scenario and logs
 * everything (Gabriel input, its observed chat, and — from the bot log —
 * ZincAI's replies). Usage: node social_test.js <scenario-file>
 * Scenario file: JSON { "steps": [ {at: <sec from start>, cmd: "say ..."} ] }
 */
'use strict'
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const scenarioFile = process.argv[2]
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
const out = scenarioFile.replace(/\.json$/, '') + '.log'

const child = spawn('node', [path.join(__dirname, 'gabriel.js')], { stdio: ['pipe', 'pipe', 'pipe'] })
const t0 = Date.now()
const log = (line) => fs.appendFileSync(out, `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}\n`)
child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => log('GABRIEL| ' + l)))
child.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => log('GABRIEL-ERR| ' + l)))
child.on('exit', (code) => { log(`GABRIEL_EXIT code=${code}`); finish() })

let finished = false
function finish () {
  if (finished) return
  finished = true
  try { child.stdin.end() } catch { /* */ }
  setTimeout(() => process.exit(0), 1000)
}

for (const step of scenario.steps) {
  setTimeout(() => {
    try {
      child.stdin.write(step.cmd + '\n')
      log(`DRIVER> ${step.cmd}`)
    } catch (e) { log(`DRIVER_ERR ${e.message}`) }
  }, step.at * 1000)
}
// quit at the end + 20s margin
const total = Math.max(...scenario.steps.map((s) => s.at))
setTimeout(() => { try { child.stdin.write('quit\n') } catch { /* */ } finish() }, (total + 20) * 1000)
setTimeout(finish, (total + 60) * 1000)
