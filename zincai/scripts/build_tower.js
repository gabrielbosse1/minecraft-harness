/**
 * build_tower.js — pillar straight up with jump-place blocks.
 * ctx.pathfinder.pillarToHeight(targetFeetY) does the block work;
 * this script picks a sensible default (+6 blocks) and reports.
 */
'use strict'

module.exports = async function buildTower (ctx) {
  const { bot, pathfinder, log } = ctx
  if (!bot?.entity || !pathfinder?.pillarToHeight) return 'unavailable'
  const target = Math.floor(bot.entity.position.y) + 6
  log?.info?.('build_tower', `pillaring to y=${target}`)
  const ok = await pathfinder.pillarToHeight(target)
  return ok ? `tower_top_y=${Math.floor(bot.entity.position.y)}` : 'tower_failed'
}
