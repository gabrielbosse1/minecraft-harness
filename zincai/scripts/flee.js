/**
 * flee.js — run away from the nearest hostile mob at full speed.
 * Exports async function(ctx). Trusted local code. The pathfinder's built-in
 * flee tick already does this continuously; this script exists for reflexes
 * and LLM {"a":"run_script","name":"flee"} invocations, with a longer push.
 */
'use strict'

module.exports = async function flee (ctx) {
  const { bot, goals, log } = ctx
  if (!bot?.entity) return 'no_entity'
  let nearest = null
  let nearestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity) continue
    if (!/zombie|skeleton|creeper|spider|drowned|husk|witch|blaze|phantom|enderman/i.test(e.name || '')) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d < nearestDist) { nearestDist = d; nearest = e }
  }
  if (!nearest) { log?.info?.('flee', 'nothing to flee from') ; return 'nothing_to_flee' }
  const away = bot.entity.position.minus(nearest.position)
  away.y = 0
  if (away.norm() < 0.01) away.set(1, 0, 0)
  away.normalize()
  const target = bot.entity.position.plus(away.scale(16))
  bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 2), true)
  const movements = bot.pathfinder?.movements
  if (movements) movements.allowSprinting = true
  bot.setControlState('sprint', true)
  log?.info?.('flee', `running from ${nearest.name} (${nearestDist.toFixed(1)}m)`)
  return `fleeing_${nearest.name}`
}
