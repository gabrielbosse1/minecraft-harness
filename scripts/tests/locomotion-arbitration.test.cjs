'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { NavigationIntents } = require('../../zincai/navigation_intents')

test('style arbitration retains lower priorities and expires or removes publishers', () => {
  let now = 1000
  const nav = new NavigationIntents({ arbiter: {}, now: () => now })
  const primary = nav.register({ id: 'primary' })
  const rival = nav.register({ id: 'rival' })
  const safety = nav.register({ id: 'safety' })
  const goal = {}
  primary.publishLocomotion('work', { mode: 'precision', goal, expiresAt: 3000 })
  rival.publishLocomotion('work', { mode: 'sprint', goal, expiresAt: 3000 })
  assert.equal(nav.resolveLocomotion({ goal }).mode, 'precision')
  assert.equal(nav.resolveLocomotion({ goal: {} }), null)
  safety.publishLocomotion('escape', { mode: 'sprint_jump', tier: 'safety', mandatory: true, allowOptionalJump: false, expiresAt: 1300 })
  assert.equal(nav.resolveLocomotion({ goal }).mode, 'sprint_jump')
  assert.equal(nav.resolveLocomotion({ goal }).allowOptionalJump, false)
  now = 1300
  assert.equal(nav.resolveLocomotion({ goal }).mode, 'precision')
  nav.unregister('primary')
  assert.equal(nav.resolveLocomotion({ goal }).mode, 'sprint')
  now = 3000
  assert.equal(nav.resolveLocomotion({ goal }), null)
})
