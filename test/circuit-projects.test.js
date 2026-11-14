'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { CircuitProjects } = require('../zincai/circuit_projects')
const { testLogic } = require('../zincai/logic_test')
const { coerceAction, createZincTools } = require('../zincai/api_wrapper')
const { simulatedBot, startTestSession } = require('./helpers/session')
const call = (name, args) => coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })
const spec = () => ({ inputs: ['a', 'b', 'cin'], gates: [{ id: 'sum', op: 'FULL_SUM', inputs: ['a', 'b', 'cin'] }, { id: 'carry', op: 'FULL_CARRY', inputs: ['a', 'b', 'cin'] }], outputs: ['sum', 'carry'], adder_width: 1 })

test('reusable full-adder operations test all cases and report named output dependency cone', () => {
  const good = testLogic(spec())
  assert.match(good.msg, /8\/8 vectors matched/)
  const faulty = spec(); faulty.gates[1] = { id: 'carry', op: 'OR', inputs: ['a', 'b'] }
  const r = testLogic(faulty)
  assert.match(r.msg, /differing outputs: carry/)
  assert.match(r.msg, /Declared dependency cone for carry: carry,a,b \(not a fault diagnosis\)/)
  assert.match(r.msg, /Not Minecraft simulation/)
  const bad = spec(); bad.gates[0].inputs.pop()
  assert.equal(testLogic(bad).ok, false)
})
test('projects persist logical specifications, last tests and explicitly historical observations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-circuits-'))
  try {
    const file = path.join(dir, 'projects.json'); let p = new CircuitProjects(file)
    const s = spec(); const result = testLogic(s)
    assert.equal(p.saveLogic('adder', s, result).ok, true)
    const inspector = { metadata: () => ({ x: 1, y: 64, z: -3, radius: 2, dimension: 'overworld', version: '26.3', ts: 1000, components: 4, unloaded: 1, unreadable: 0 }) }
    assert.equal(p.act({ operation: 'bind', name: 'adder', snapshot: 'rs1', note: 'Check the carry wire' }, inspector).ok, true)
    s.gates[0].op = 'OR' // saved copy cannot change through the caller's reference
    p = new CircuitProjects(file)
    assert.match(p.act({ operation: 'list' }).msg, /adder/)
    const show = p.act({ operation: 'show', name: 'adder' })
    assert.match(show.msg, /observed region overworld 1,64,-3/)
    assert.match(show.msg, /rescan for current state/)
    assert.match(show.msg, /inputs a,b,cin; outputs sum,carry/)
    assert.match(show.msg, /Unverified hypothesis: Check the carry wire/)
    assert.match(show.msg, /Physical behavior is unverified/)
    assert.match(p.act({ operation: 'graph', name: 'adder' }).msg, /sum=FULL_SUM\(a,b,cin\)/)
    assert.equal(p.act({ operation: 'graph', name: 'adder', page: 2 }).ok, false)
    assert.match(p.act({ operation: 'test', name: 'adder' }).msg, /8\/8 vectors matched/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('invalid specs, missing snapshots, corrupt store and invalid names fail without replacing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-circuits-'))
  try {
    const file = path.join(dir, 'projects.json'); let p = new CircuitProjects(file)
    assert.equal(p.saveLogic('../escape', spec(), testLogic(spec())).ok, false)
    assert.equal(p.saveLogic('bad', { ...spec(), outputs: ['missing'] }, { msg: 'x' }).ok, false)
    assert.equal(p.act({ operation: 'bind', name: 'good', snapshot: 'rs99' }, { metadata: () => null }).ok, false)
    fs.writeFileSync(file, '{broken json')
    p = new CircuitProjects(file)
    assert.match(p.act({ operation: 'list' }).msg, /store unavailable/)
    assert.equal(p.saveLogic('good', spec(), testLogic(spec())).ok, false)
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken json')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('model workflow binds a snapshot, saves a named logical graph and reruns by name', async () => {
  const tools = createZincTools()
  assert.ok(tools.some((t) => t.function.name === 'circuit_project'))
  // Unconditional: circuit work is not a persona you have to switch into.
  assert.ok(createZincTools({ mode: 'explorer' }).some((t) => t.function.name === 'circuit_project'))
  // An out-of-enum operation is NOT dropped by the schema any more: it reaches
  // the handler, which explains what it accepts. Dropping the call first meant
  // the model lost `name`/`snapshot`/`note` too and got no hint.
  const badOp = call('circuit_project', { operation: 'bad' })
  assert.equal(badOp.a, 'circuit_project')
  assert.equal(badOp.operation, 'bad')
  const bot = simulatedBot(); const oldBlockAt = bot.blockAt.bind(bot)
  bot.blockAt = (p) => p.x === 0 && p.y === 64 && p.z === 0 ? { name: 'repeater', getProperties: () => ({ facing: 'north', powered: false, delay: 1, locked: false }) } : oldBlockAt(p)
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn(); const snap = { threatIds: [], askedBy: null }
    await s.internals().executeAction(call('redstone_scan', { x: 0, y: 64, z: 0 }), snap)
    await s.internals().executeAction(call('circuit_project', { operation: 'bind', name: 'adder', snapshot: 'rs1', note: 'maybe carry' }), snap)
    assert.match(s.internals().results.at(-1).msg, /saved historical region summary/)
    await s.internals().executeAction(call('logic_test', { ...spec(), project: 'adder' }), snap)
    assert.match(s.internals().results.at(-1).msg, /saved abstract graph/)
    await s.internals().executeAction(call('circuit_project', { operation: 'test', name: 'adder' }), snap)
    assert.match(s.internals().results.at(-1).msg, /8\/8 vectors matched/)
    const reopened = new CircuitProjects(path.join(s.shared.dataDir, 'circuit-projects.json'))
    assert.match(reopened.act({ operation: 'show', name: 'adder' }).msg, /rescan for current state/)
    assert.equal(bot.log.attack.length, 0); assert.equal(bot.log.goals.length, 0)
  } finally { s.stop() }
})

test('four-bit adder built from reusable full-adder outputs passes all vectors', () => {
  const inputs = ['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3', 'cin']
  const gates = []; const outputs = []; let carry = 'cin'
  for (let i = 0; i < 4; i++) {
    const ins = [`a${i}`, `b${i}`, carry]
    gates.push({ id: `s${i}`, op: 'FULL_SUM', inputs: ins }, { id: `c${i}`, op: 'FULL_CARRY', inputs: ins })
    outputs.push(`s${i}`); carry = `c${i}`
  }
  outputs.push(carry)
  const r = testLogic({ inputs, gates, outputs, adder_width: 4 })
  assert.match(r.msg, /512\/512 vectors matched/)
})
