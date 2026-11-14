const fs = require('fs')
const src = fs.readFileSync('/home/user/minecraft-harness/zincai/index.js', 'utf8').split('\n')
const starts = src.map((l, i) => [i, (l.match(/^\s*case '([a-z_]+)':/) || [])[1]]).filter(x => x[1])
const tools = ['dig','gather','build','build_shape','take','put','smelt','use_block','sleep','light_up','craft','shelter','give','look_in']
for (const t of tools) {
  const k = starts.findIndex(x => x[1] === t)
  if (k < 0) continue
  const a = starts[k][0]
  const b = k + 1 < starts.length ? starts[k + 1][0] : src.length
  const body = src.slice(a, b).join('\n')
  const g = []
  if (/propertyGuardAt/.test(body)) g.push('propertyGuardAt')
  if (/containerTakeGuard/.test(body)) g.push('containerTakeGuard')
  if (/canWrite/.test(body)) g.push('canWrite')
  if (/buildBlocks/.test(body)) g.push('buildBlocks(→guard)')
  console.log(`${t.padEnd(14)} ${String(b - a).padStart(4)} lines  ${g.length ? g.join(' + ') : '*** NONE ***'}`)
}
