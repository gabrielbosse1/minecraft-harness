const { makeWorld, Movements, goals, plan } = require('/home/user/minecraft-harness/test/helpers/world')
const { PathfinderWrapper } = require('/home/user/minecraft-harness/zincai/custom_mineflayer/pathfinder_wrapper')
const { DigPolicy } = require('/home/user/minecraft-harness/zincai/dig_policy')

const inClaim = (x, y, z) => x >= 3 && x <= 7 && z >= -25 && z <= 25
const world = (x, y, z) => {
  if (y <= 63) return true
  if (x === 5 && z >= -25 && z <= 25 && (y === 64 || y === 65)) return 'oak_planks'
  return false
}

function rig (digEnabled, guard) {
  const bot = makeWorld(world)
  const w = new PathfinderWrapper(bot, { logger: () => {}, digPolicy: new DigPolicy({ enabled: digEnabled }), isProtected: guard })
  const mv = new Movements(bot)
  bot.pathfinder = { movements: mv, setMovements (m) { this.movements = m }, bestHarvestTool: () => null }
  w.configureMovements(mv)
  return { bot, mv, w }
}
function report (label, r) {
  const cells = [...new Set(r.path ? r.path.flatMap(m => m.toBreak).map(b => `${b.x},${b.y},${b.z}`) : [])]
  const inClaimCells = cells.filter(c => { const [x,, z] = c.split(',').map(Number); return inClaim(x, 0, z) })
  console.log(`${label.padEnd(34)} status=${String(r.status).padEnd(8)} breaks=${String(cells.length).padEnd(3)} inside-claim=${inClaimCells.length}`)
}

// 1. standing policy, planks belong to somebody (claim guard on)
{
  const { bot, mv } = rig(false, (p) => inClaim(p.x, p.y, p.z))
  report('standing policy', plan(bot, mv, new goals.GoalBlock(10, 64, 0), { timeout: 6000 }))
}
// 2. dig corridor open, claim guard on  <- the claim being tested
{
  const { bot, mv, w } = rig(true, (p) => inClaim(p.x, p.y, p.z))
  w.beginDigging({ canDig: null, maxMs: 60_000 })
  report('dig corridor (ClaimGuard ON)', plan(bot, mv, new goals.GoalBlock(10, 64, 0), { timeout: 6000 }))
}
// 3. control: standing policy with no claim, to prove the wall is otherwise a wall
{
  const { bot, mv } = rig(false, () => false)
  report('standing policy, no claim', plan(bot, mv, new goals.GoalBlock(10, 64, 0), { timeout: 6000 }))
}
// 4. control: dig corridor with the guard that protects nothing
{
  const { bot, mv, w } = rig(true, () => false)
  w.beginDigging({ canDig: null, maxMs: 60_000 })
  report('dig corridor, guard neutralised', plan(bot, mv, new goals.GoalBlock(10, 64, 0), { timeout: 6000 }))
}
