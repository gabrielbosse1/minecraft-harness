'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { testLogic } = require('../zincai/logic_test')
const { createZincTools, coerceAction } = require('../zincai/api_wrapper')
const { simulatedBot, startTestSession } = require('./helpers/session')

function adder (width) {
  const inputs = [...Array.from({ length: width }, (_, i) => `a${i}`), ...Array.from({ length: width }, (_, i) => `b${i}`), 'cin']
  const gates = []
  const outputs = []
  let carry = 'cin'
  for (let i = 0; i < width; i++) {
    gates.push({ id: `x${i}`, op: 'XOR', inputs: [`a${i}`, `b${i}`] })
    gates.push({ id: `s${i}`, op: 'XOR', inputs: [`x${i}`, carry] })
    gates.push({ id: `ab${i}`, op: 'AND', inputs: [`a${i}`, `b${i}`] })
    gates.push({ id: `xc${i}`, op: 'AND', inputs: [`x${i}`, carry] })
    gates.push({ id: `c${i}`, op: 'OR', inputs: [`ab${i}`, `xc${i}`] })
    outputs.push(`s${i}`); carry = `c${i}`
  }
  outputs.push(carry)
  return { inputs, gates, outputs, adder_width: width }
}

test('four bit adder is checked over all 512 input combinations, abstract only', () => {
  const r = testLogic(adder(4))
  assert.equal(r.ok, true)
  assert.match(r.msg, /512\/512 vectors matched; 512\/512 distinct input combinations tested/)
  assert.match(r.msg, /Not Minecraft simulation; no timing, feedback, physical layout or fault cause inferred/)
})
test('incorrect carry gives a real counterexample, never an invented cause', () => {
  const spec = adder(4)
  spec.gates.find((g) => g.id === 'c2').op = 'AND'
  const r = testLogic(spec)
  assert.match(r.msg, /First mismatch: inputs=[01]{9}, expected=[01]{5}, actual=[01]{5}/)
  assert.doesNotMatch(r.msg, /likely (failure|fault)/i)
  const [input, expected, actual] = /inputs=([01]+), expected=([01]+), actual=([01]+)/.exec(r.msg).slice(1)
  assert.notEqual(expected, actual)
  const a = parseInt(input.slice(0, 4).split('').reverse().join(''), 2)
  const b = parseInt(input.slice(4, 8).split('').reverse().join(''), 2)
  const reference = Array.from({ length: 5 }, (_, i) => String(((a + b + Number(input[8])) >> i) & 1)).join('')
  assert.equal(expected, reference)
})
test('supported gates evaluate all input combinations', () => {
  for (const [op, expected] of Object.entries({ AND: '0001', OR: '0111', XOR: '0110', NAND: '1110', NOR: '1000' })) {
    const tests = ['00', '01', '10', '11'].map((in_bits, i) => ({ in_bits, out_bits: expected[i] }))
    const r = testLogic({ inputs: ['a', 'b'], gates: [{ id: 'out', op, inputs: ['a', 'b'] }], outputs: ['out'], tests })
    assert.match(r.msg, /4\/4 vectors matched/, op)
  }
  for (const [op, expected] of [['NOT', '10'], ['BUF', '01']]) {
    const tests = ['0', '1'].map((in_bits, i) => ({ in_bits, out_bits: expected[i] }))
    const r = testLogic({ inputs: ['a'], gates: [{ id: 'out', op, inputs: ['a'] }], outputs: ['out'], tests })
    assert.match(r.msg, /2\/2 vectors matched/, op)
  }
})
test('explicit vectors report unique cases rather than falsely claiming full coverage', () => {
  const r = testLogic({ inputs: ['a', 'b'], gates: [{ id: 'x', op: 'XOR', inputs: ['a', 'b'] }], outputs: ['x'], tests: [{ in_bits: '10', out_bits: '1' }, { in_bits: '10', out_bits: '1' }] })
  assert.match(r.msg, /2\/2 vectors matched; 1\/4 distinct input combinations/)
})
test('invalid gates, cycles, unknown signals, excessive inputs and invalid vectors are rejected', () => {
  const base = adder(1)
  for (const bad of [
    { ...base, gates: [{ id: 'x', op: 'BUF', inputs: ['x'] }] },
    { ...base, gates: [{ id: 'x', op: 'NOT', inputs: ['a0', 'b0'] }] },
    { ...base, gates: [{ id: 'x', op: 'eval', inputs: ['a0'] }] },
    { ...base, gates: [{ id: 'x', op: 'BUF', inputs: ['a0'], extra: 1 }] },
    { ...base, outputs: ['missing', 'c0'] },
    { ...base, inputs: Array(10).fill('a') },
    { ...base, tests: [{ in_bits: '001', out_bits: '11' }] },
    { inputs: ['a'], gates: [], outputs: ['a'], tests: [{ in_bits: '1', out_bits: 'x' }] }
  ]) assert.equal(testLogic(bad).ok, false, JSON.stringify(bad))
})
test('model schema exposes builder-only logic testing and dispatches into results', async () => {
  assert.ok(createZincTools({ mode: 'builder' }).some((t) => t.function.name === 'logic_test'))
  assert.ok(!createZincTools({ mode: 'hunter' }).some((t) => t.function.name === 'logic_test'))
  assert.ok(!createZincTools({ mode: 'explorer' }).some((t) => t.function.name === 'logic_test'))
  const spec = adder(1)
  const action = coerceAction({ tool_calls: [{ function: { name: 'logic_test', arguments: JSON.stringify(spec) } }] })
  assert.equal(action.a, 'logic_test')
  assert.equal(coerceAction({ tool_calls: [{ function: { name: 'logic_test', arguments: '{}' } }] })._badArgs, 'logic_test')
  const bot = simulatedBot()
  const s = startTestSession({ bot, actions: () => null })
  try {
    s.spawn()
    await s.internals().executeAction(action, { threatIds: [], askedBy: null })
    const result = s.internals().results.find((r) => r.label === 'logic_test')
    assert.equal(result.ok, true)
    assert.match(result.msg, /8\/8 vectors matched/)
    assert.match(result.msg, /Not Minecraft simulation/)
    assert.equal(bot.log.goals.length, 0)
    assert.equal(bot.log.attack.length, 0)
  } finally { s.stop() }
})
