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

test('combat refreshes the scoped lease independently of follow-goal creation', () => {
  const { AdvancedCombat } = require('../../src/combat')
  const { Vec3 } = require('vec3')
  let now = 1000
  const nav = new NavigationIntents({ arbiter: {}, now: () => now })
  const objective = nav.register({ id: 'objective' })
  const locomotion = nav.register({ id: 'combat' })
  objective.publishLocomotion('prior', { mode: 'precision', expiresAt: 60_000 })
  const target = { id: 1, position: new Vec3(20, 64, 0) }
  const pathfinder = { isMoving: () => true }
  let goalWrites = 0
  const combat = Object.assign(Object.create(AdvancedCombat.prototype), {
    bot: { pathfinder, entities: { 1: target } }, now: () => now, target,
    profile: { min: 2 }, locomotion,
    hands: { setGoal (goal) { goalWrites++; pathfinder.goal = goal }, release () {} },
    _releaseBow () {}, _shield () {}
  })
  for (; now <= 13_000; now += 1000) {
    combat._ensureFollowGoal()
    assert.equal(nav.resolveLocomotion({ goal: pathfinder.goal, owner: 'combat' }).mode, 'sprint')
  }
  assert.equal(goalWrites, 1)
  combat._letGo()
  assert.equal(nav.resolveLocomotion({ goal: pathfinder.goal, owner: 'combat' }).mode, 'precision')
  combat._ensureFollowGoal()
  delete combat.bot.entities[1]
  assert.equal(nav.resolveLocomotion({ goal: pathfinder.goal, owner: 'combat' }).mode, 'precision')
})
