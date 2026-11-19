/**
 * build_tower.js — pillar straight up with jump-place blocks.
 * ctx.pathfinder.pillarToHeight(targetFeetY) does the block work;
 * this script picks a sensible default (+6 blocks) and reports.
 */
'use strict'

module.exports = async function buildTower (ctx) {
  const { bot, pathfinder, log } = ctx
  if (!bot?.entity || !pathfinder?.pillarToHeight) return { ok: false, msg: 'pillar procedure unavailable' }
  const target = Math.floor(bot.entity.position.y) + 6
  log?.info?.('build_tower', `pillaring to y=${target}`)
  const ok = await pathfinder.pillarToHeight(target)
  const actualY = Math.floor(bot.entity.position.y)
  return ok && actualY >= target
    ? { ok: true, verification: 'unverified', msg: `reached y=${actualY}; full tower structure not verified` }
    : { ok: false, msg: `tower failed: reached y=${actualY}, target y=${target}` }
}
