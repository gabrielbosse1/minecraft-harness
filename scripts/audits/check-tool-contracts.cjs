'use strict'

// Read-only audit probe; run from any directory with runtime dependencies installed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const api = require('../../zincai/api_wrapper')
const { LaneScheduler } = require('../../zincai/lanes')
const captured = require('../../docs/audits/body-tool-contracts.json')
const index = fs.readFileSync(path.join(__dirname, '../../zincai/index.js'), 'utf8')
const message = (name, args) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })

test('exported wire contract exactly matches action, recovery and chat arrays', () => {
  assert.deepEqual(captured, {
    action: api.createZincTools(), recovery: api.createRecoveryTools(), chat: api.createChatTools()
  })
})

for (const { function: tool } of captured.action) {
  test(`${tool.name}: dispatcher label, required fields and unexpected fields`, () => {
    assert.ok(index.includes(`case '${tool.name}'`))
    assert.equal(api.coerceAction(message(tool.name, { unexpected: true }))._badArgs, tool.name)
    const empty = api.coerceAction(message(tool.name, {}))
    if (tool.parameters.required?.length) assert.equal(empty._badArgs, tool.name)
    else assert.equal(empty.a, tool.name)
  })
}

test('reply: closed do enum rejects unsupported body verbs', () => {
  assert.equal(api.coerceReply(message('reply', { text: '', do: 'follow' })).do, 'follow')
  assert.equal(api.coerceReply(message('reply', { text: '', do: 'attack' })).do, '')
  assert.equal(api.coerceReply(message('reply', { do: 'follow' }))._via, 'prose')
})

test('audit reproducer: parser accepts semantic boundary cases at its shallow layer', () => {
  for (const [name, args] of [
    ['go_to', {}], ['inspect_region', { x: 0, y: 0, z: 0, radius: 99 }],
    ['pace', { gait: 'bogus' }], ['take', { item: 'stone', count: -1 }]
  ]) assert.equal(api.coerceAction(message(name, args)).a, name)
})

test('audit reproducer: stop and hold are admitted independently of navigation', () => {
  const scheduler = new LaneScheduler()
  const walk = scheduler.tryAcquire('go_to')
  assert.ok(walk)
  const control = ['stop', 'hold'].map((tool) => scheduler.tryAcquire(tool))
  assert.ok(control.every(Boolean))
  assert.equal(scheduler.bodyHolder().holder, walk.id)
  control.forEach((lease) => lease.release())
  walk.release()
  const stop = scheduler.tryAcquire('stop')
  assert.ok(stop)
  stop.release()
})


test('targeted cancellation aborts its lease without allowing a conflicting grant', async () => {
  const scheduler = new LaneScheduler()
  const walking = scheduler.tryAcquire('go_to')
  const queued = scheduler.acquire('gather')
  assert.equal(scheduler.requestBodyCancellation('wrong-id'), false)
  assert.equal(scheduler.requestBodyCancellation(walking.id), true)
  assert.equal(walking.signal.aborted, true)
  assert.equal(scheduler.tryAcquire('gather'), null)
  assert.equal(scheduler.dropBodyWaiters(), 1)
  assert.equal(await queued, null)
  assert.equal(await scheduler.waitForBodyRelease(walking.id, 0), false)
  walking.release()
  assert.equal(await scheduler.waitForBodyRelease(walking.id), true)
})

test('stop action ID is optional and validated as a string', () => {
  assert.equal(api.coerceAction(message('stop', { action_id: 'job-42' })).action_id, 'job-42')
  assert.equal(api.coerceAction(message('stop', { action_id: 42 }))._badArgs, 'stop')
})
