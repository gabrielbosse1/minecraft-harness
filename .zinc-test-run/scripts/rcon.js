/**
 * Minimal loopback RCON client for the isolated test server.
 * Usage: node rcon.js "<command>"   (one command per invocation)
 * Packet: [len:4 LE][id:4][type:4][payload...][0x00] where len = 9 + payload.length
 */
'use strict'
const net = require('net')

const port = Number(process.env.RCON_PORT || 25571)
const pass = process.env.RCON_PASS || 'zinctest_rcon_9f3b1a'
const cmd = process.argv[2]

function buildPacket (id, type, payload) {
  const p = Buffer.from(payload, 'utf8')
  const buf = Buffer.alloc(13 + p.length) // 4 len + 4 id + 4 type + p + 1 nul
  buf.writeInt32LE(9 + p.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  p.copy(buf, 12)
  buf[12 + p.length] = 0
  return buf
}

const socket = net.createConnection(port, '127.0.0.1', () => {
  socket.write(buildPacket(1, 3, pass)) // 3 = SERVERDATA_AUTH
})
let authed = false
let buf = Buffer.alloc(0)
const timeout = setTimeout(() => {
  console.log('RCON_TIMEOUT')
  socket.destroy()
  process.exit(3)
}, 10000)

socket.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readInt32LE(0)
    if (buf.length < 4 + len) break
    const id = buf.readInt32LE(4)
    const type = buf.readInt32LE(8)
    const payload = buf.slice(12, 12 + len - 9).toString('utf8')
    buf = buf.slice(4 + len)
    if (id === -1 && type === 2) { // auth failed (id -1)
      console.log('RCON_AUTH_FAIL')
      socket.destroy()
      process.exit(2)
    }
    if (authed && id === 2) {
      clearTimeout(timeout)
      console.log(payload)
      socket.destroy()
      process.exit(0)
    }
    authed = true
    if (cmd !== undefined) socket.write(buildPacket(2, 2, cmd)) // 2 = SERVERDATA_EXECCMD
  }
})
socket.on('error', (e) => {
  console.log(`RCON_ERROR ${e.code || e.message}`)
  process.exit(4)
})
