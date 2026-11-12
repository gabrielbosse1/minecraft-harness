'use strict'

// Bounded declarative combinational logic only. This neither executes code nor
// models a Minecraft world. Gate order is topological; cycles are rejected.
const LIMITS = { inputs: 9, gates: 128, outputs: 9, tests: 512 }
const ID = /^[A-Za-z][A-Za-z0-9_]{0,23}$/
const OPERATIONS = new Set(['AND', 'OR', 'XOR', 'NOT', 'BUF', 'NAND', 'NOR', 'FULL_SUM', 'FULL_CARRY'])
const fail = (why) => ({ ok: false, msg: `abstract logic test rejected: ${why}` })
const exactKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(obj, k))
const bits = (value, length) => typeof value === 'string' && value.length === length && /^[01]+$/.test(value)
const little = (n, width) => Array.from({ length: width }, (_, i) => ((n >> i) & 1) ? '1' : '0').join('')

/** Inputs/outputs and bit strings share order; adder bits are LSB first. */
function testLogic ({ inputs, gates, outputs, tests, adder_width: width } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > LIMITS.inputs || !inputs.every((id) => typeof id === 'string' && ID.test(id)) || new Set(inputs).size !== inputs.length) return fail('inputs must be 1–9 unique identifiers')
  if (!Array.isArray(gates) || gates.length > LIMITS.gates) return fail('gates must be an array of at most 128 gates')
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > LIMITS.outputs || !outputs.every((id) => typeof id === 'string' && ID.test(id)) || new Set(outputs).size !== outputs.length) return fail('outputs must be 1–9 unique identifiers')
  const available = new Set(inputs)
  for (const gate of gates) {
    if (!exactKeys(gate, ['id', 'op', 'inputs']) || typeof gate.id !== 'string' || !ID.test(gate.id) || available.has(gate.id) || !OPERATIONS.has(gate.op)) return fail('invalid or duplicate gate id, fields, or operation')
    const arity = gate.op === 'NOT' || gate.op === 'BUF' ? 1 : (gate.op === 'FULL_SUM' || gate.op === 'FULL_CARRY' ? 3 : 2)
    if (!Array.isArray(gate.inputs) || gate.inputs.length !== arity || !gate.inputs.every((id) => typeof id === 'string' && available.has(id))) return fail('gate inputs must reference earlier signals and match the operation arity; cycles are unsupported')
    available.add(gate.id)
  }
  if (!outputs.every((id) => available.has(id))) return fail('outputs must reference existing signals')
  let vectors
  if (width !== undefined) {
    if (tests !== undefined || !Number.isInteger(width) || width < 1 || width > 4 || inputs.length !== 2 * width + 1 || outputs.length !== width + 1) return fail('adder_width 1–4 requires no tests, 2*width+1 inputs and width+1 outputs')
    vectors = []
    for (let a = 0; a < 2 ** width; a++) for (let b = 0; b < 2 ** width; b++) for (let carry = 0; carry < 2; carry++) {
      const total = a + b + carry
      vectors.push({ in_bits: little(a, width) + little(b, width) + carry, out_bits: little(total, width + 1) })
    }
  } else {
    if (!Array.isArray(tests) || tests.length < 1 || tests.length > LIMITS.tests) return fail('provide 1–512 test vectors or adder_width')
    for (const t of tests) if (!exactKeys(t, ['in_bits', 'out_bits']) || !bits(t.in_bits, inputs.length) || !bits(t.out_bits, outputs.length)) return fail('each vector needs binary in_bits/out_bits matching input/output lengths')
    vectors = tests
  }
  let first = null
  let failures = 0
  const distinct = new Set()
  for (const v of vectors) {
    distinct.add(v.in_bits)
    const state = new Map(inputs.map((id, i) => [id, v.in_bits[i] === '1']))
    for (const g of gates) {
      const a = state.get(g.inputs[0]); const b = state.get(g.inputs[1]); const c = state.get(g.inputs[2])
      let result
      switch (g.op) {
        case 'AND': result = a && b; break
        case 'OR': result = a || b; break
        case 'XOR': result = a !== b; break
        case 'NOT': result = !a; break
        case 'BUF': result = a; break
        case 'NAND': result = !(a && b); break
        case 'NOR': result = !(a || b); break
        case 'FULL_SUM': result = (a !== b) !== c; break
        case 'FULL_CARRY': result = (a && b) || (a && c) || (b && c); break
      }
      state.set(g.id, result)
    }
    const actual = outputs.map((id) => state.get(id) ? '1' : '0').join('')
    if (actual !== v.out_bits) {
      failures++
      if (!first) first = { input: v.in_bits, expected: v.out_bits, actual }
    }
  }
  let counterexample = ''
  if (first) {
    const mismatched = outputs.filter((_, i) => first.expected[i] !== first.actual[i])
    const gateById = new Map(gates.map((g) => [g.id, g]))
    const seen = new Set(); const queue = [mismatched[0]]
    while (queue.length) {
      const id = queue.shift()
      if (seen.has(id)) continue
      seen.add(id)
      const g = gateById.get(id)
      if (g) queue.push(...g.inputs)
    }
    const cone = [...seen].slice(0, 8).join(',') + (seen.size > 8 ? `,+${seen.size - 8} more` : '')
    counterexample = ` First mismatch: inputs=${first.input}, expected=${first.expected}, actual=${first.actual} (ordered as declared); differing outputs: ${mismatched.join(',')}. Declared dependency cone for ${mismatched[0]}: ${cone} (not a fault diagnosis).`
  }
  return { ok: true, msg: `ABSTRACT Boolean logic only: ${vectors.length - failures}/${vectors.length} vectors matched; ${distinct.size}/${2 ** inputs.length} distinct input combinations tested.${counterexample} Not Minecraft simulation; no timing, feedback, physical layout or fault cause inferred.` }
}
module.exports = { testLogic }
