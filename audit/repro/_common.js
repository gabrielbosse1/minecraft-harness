'use strict'
// Shared plumbing for the audit repro scripts. Nothing here touches the network:
// the scripts drive the shipped code with the repo's own test rig (test/helpers).
const path = require('path')
const ROOT = path.join(__dirname, '..', '..')
const req = (p) => require(path.join(ROOT, p))

const logger = req('src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}
process.env.DOTENV_CONFIG_QUIET = 'true'

const world = req('test/helpers/world')
const session = req('test/helpers/session')
const line = (prompt, label) => (prompt.split('\n').find((l) => l.startsWith(label)) || '')

module.exports = { ROOT, req, world, ...session, line }
