/**
 * flee.js — run away from whatever is dangerous right now, with a longer push
 * than the reflex gives. Exports async function(ctx). Trusted local code.
 *
 * The survival reflex (system1.js) already flees on its own; this script
 * exists for operator reflexes and {"a":"run_script","name":"flee"} calls.
 * It asks the same threat sensor what is real (no caged mobs, no bystanders)
 * and moves through the survival lane, so nothing it presses can get stuck.
 */
'use strict'

module.exports = async function flee (ctx) {
  const { bot, system1, log } = ctx
  if (!bot?.entity) return 'no_entity'
  if (!system1) return 'no_reflex_layer'
  const threats = system1.sense.assess().threats
  if (!threats.length) { log?.info?.('flee', 'nothing to flee from'); return 'nothing_to_flee' }
  // Forget earlier "hold"/"fight" decisions: this is an explicit order to run.
  system1.clearDecision()
  system1.flee({ threats })
  log?.info?.('flee', `running from ${threats[0].name} (${threats[0].distance.toFixed(1)}m)`)
  return `fleeing_${threats[0].name}`
}
