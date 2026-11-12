/**
 * Batch RCON client: runs a list of commands over ONE connection.
 * Usage: node rcon-batch.js <commands-file>   (one command per line, # = comment)
 * Special comment: "# sleep <ms>" pauses the batch (chunk generation).
 * Transient "not loaded / could not set" responses are retried up to 4 times.
 * Writes <commands-file>.out with one "<n>|OK|FAIL|<cmd> => <resp>" per line.
 * Exit code 0 = all ok, 1 = some failed.
 */
'use strict'
const net = require('net')
const fs = require('fs')
const path = require('path')

const file = process.argv[2]
if (!file) { console.error('usage: rcon-batch.js <commands-file>'); process.exit(2) }
const raw = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
const cmds = raw.filter((l) => l && (!l.startsWith('#') || /^# sleep/i.test(l)))

const port = Number(process.env.RCON_PORT || 25571)
const pass = process.env.RCON_PASS || 'zinctest_rcon_9f3b1a'

function buildPacket (id, type, payload) {
  const p = Buffer.from(payload, 'utf8')
  const buf = Buffer.alloc(13 + p.length)
  buf.writeInt32LE(9 + p.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  p.copy(buf, 12)
  buf[12 + p.length] = 0
  return buf
}

fs.writeFileSync(file + '.out', '')
const out = (line) => fs.appendFileSync(file + '.out', line + '\n')
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const socket = net.createConnection(port, '127.0.0.1', () => {
  socket.write(buildPacket(1, 3, pass))
})
let buf = Buffer.alloc(0)
let authed = false
let idx = 0
let pending = null // {id, cmd, retries}
let failures = 0

function runNext () {
  while (idx < cmds.length) {
    const m = cmds[idx].match(/^#\s*sleep\s+(\d+)/i)
    if (m) {
      console.error(`[batch] sleeping ${m[1]}ms`)
      sleepSync(Number(m[1]))
      idx++
      continue
    }
    break
  }
  if (idx >= cmds.length) {
    socket.destroy()
    return
  }
  const id = idx + 2
  pending = { id, cmd: cmds[idx], retries: 0 }
  socket.write(buildPacket(id, 2, cmds[idx]))
}

socket.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readInt32LE(0)
    if (buf.length < 4 + len) break
    const id = buf.readInt32LE(4)
    const type = buf.readInt32LE(8)
    const payload = buf.slice(12, 12 + len - 9).toString('utf8').replace(/\0+$/, '').replace(/\u0000/g, '').trim()
    buf = buf.slice(4 + len)
    if (id === -1) { console.error('AUTH FAIL'); process.exit(2) }
    if (!authed && id === 1) {
      authed = true
      runNext()
      continue
    }
    if (authed && pending && id === pending.id) {
      if (/not loaded|Could not set|Could not modify/i.test(payload) && pending.retries++ < 4) {
        sleepSync(2500)
        socket.write(buildPacket(id, 2, pending.cmd))
        continue
      }
      const hard = /Unknown or incomplete|Incorrect argument|Failed to|Error|not loaded|refused/i.test(payload)
      const soft = /Could not (set|modify) the (block|entity)/i.test(payload) && !hard
      if (hard) failures++
      out(`${idx + 1}|${hard ? 'FAIL' : soft ? 'WARN' : 'OK'}|${pending.cmd} => ${payload.slice(0, 200)}`)
      pending = null
      idx++
      runNext()
    }
    authed = true
  }
})
socket.on('error', (e) => { console.error('RCON_ERROR', e.code || e.message); process.exit(4) })
socket.on('close', () => {
  console.log(`batch done: ${cmds.length - failures}/${cmds.length} ok, ${failures} failures -> ${file}.out`)
  process.exit(failures ? 1 : 0)
})
