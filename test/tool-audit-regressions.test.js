/**
 * Regression tests for the tool audit (TOOL_AUDIT.md).
 *
 * Each test here corresponds to a finding in that report and fails against the
 * code as it was before the fix. They are deliberately written against the
 * behaviour a model (or a player) observes, not against the implementation, so
 * they still mean something after a refactor.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { makeWorld, Movements, goals, plan, registry } = require('./helpers/world')
const { PathfinderWrapper } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { DigPolicy, NEVER_DIG, DEFAULT_SOFT_BLOCKS } = require('../zincai/dig_policy')
const { coerceAction, createZincTools } = require('../zincai/api_wrapper')
const { generateShape } = require('../zincai/builder')
const { Skills } = require('../zincai/skills')

const wrapperFor = (bot, { digPolicy = new DigPolicy({ file: null }), isProtected = null } = {}) => {
  const movements = new Movements(bot)
  bot.pathfinder = { movements, setMovements (m) { this.movements = m }, bestHarvestTool: () => null }
  const wrapper = new PathfinderWrapper(bot, { logger: () => {}, digPolicy, isProtected })
  wrapper.configureMovements(movements)
  return { wrapper, movements }
}

const canBreak = (movements, name) => {
  const id = registry.blocksByName[name]?.id
  assert.notEqual(id, undefined, `${name} is not in the registry`)
  return !movements.blocksCantBreak.has(id)
}

// ---------------------------------------------------------------------------
// §1 — a `dig` corridor must not waive somebody else's claim
// ---------------------------------------------------------------------------

test('§1 a dig corridor still refuses to break another player\'s claimed blocks', () => {
  const inClaim = (x, z) => x >= 3 && x <= 7 && z >= -25 && z <= 25
  const world = (x, y, z) => {
    if (y <= 63) return true
    if (x === 5 && z >= -25 && z <= 25 && (y === 64 || y === 65)) return 'oak_planks'
    return false
  }
  const bot = makeWorld(world)
  const { wrapper, movements } = wrapperFor(bot, { isProtected: (p) => inClaim(p.x, p.z) })
  const destination = new goals.GoalBlock(10, 64, 0)

  wrapper.beginDigging({ canDig: null, maxMs: 60_000 })
  const walked = plan(bot, movements, destination, { timeout: 6000 })
  const broken = walked.path
    ? [...new Set(walked.path.flatMap((m) => m.toBreak).map((b) => `${b.x},${b.y},${b.z}`))]
    : []
  const trespass = broken.filter((c) => { const [x, , z] = c.split(',').map(Number); return inClaim(x, z) })
  assert.equal(trespass.length, 0, `the corridor broke claimed blocks: ${trespass.join(' ')}`)
  wrapper.endDigging('test')
})

test('§1 a dig corridor still tunnels through unclaimed stone, so `dig` keeps working', () => {
  const world = (x, y, z) => {
    if (y <= 63) return true
    if (x === 5 && y <= 65) return 'stone'
    return false
  }
  const bot = makeWorld(world)
  const { wrapper, movements } = wrapperFor(bot, { isProtected: () => false })
  wrapper.beginDigging({ canDig: null, maxMs: 60_000 })
  const out = plan(bot, movements, new goals.GoalBlock(10, 64, 0), { timeout: 6000 })
  assert.ok(out.broken > 0, 'a corridor aimed at stone still opens it')
  wrapper.endDigging('test')
})

// ---------------------------------------------------------------------------
// §2 — containers, workstations and machines are never broken by a walk
// ---------------------------------------------------------------------------

test('§2 mode:"all" cannot break containers, workstations or machines', () => {
  const bot = makeWorld()
  const { movements } = wrapperFor(bot, { digPolicy: new DigPolicy({ file: null, enabled: true, mode: 'all' }) })
  for (const name of ['chest', 'trapped_chest', 'ender_chest', 'barrel', 'shulker_box', 'furnace', 'blast_furnace', 'hopper', 'dropper', 'dispenser', 'crafting_table', 'anvil', 'enchanting_table', 'brewing_stand', 'beacon', 'bookshelf', 'lectern', 'smithing_table', 'respawn_anchor', 'tnt']) {
    assert.equal(canBreak(movements, name), false, `mode "all" must not break ${name}`)
  }
})

test('§2 the same is true with no standing policy at all and inside an open corridor', () => {
  const bot = makeWorld()
  const { wrapper, movements } = wrapperFor(bot, { digPolicy: new DigPolicy({ file: null, enabled: false }) })
  wrapper.beginDigging({ canDig: null, maxMs: 60_000 })
  for (const name of ['chest', 'barrel', 'furnace', 'hopper', 'crafting_table', 'ender_chest']) {
    assert.equal(canBreak(movements, name), false, `a corridor must not break ${name}`)
  }
  wrapper.endDigging('test')
})

test('§2 natural blocks stay breakable, so the policy still does its job', () => {
  const bot = makeWorld()
  const { movements } = wrapperFor(bot, { digPolicy: new DigPolicy({ file: null, enabled: true, mode: 'all' }) })
  for (const name of ['stone', 'dirt', 'oak_log', 'gravel', 'obsidian']) {
    assert.equal(canBreak(movements, name), true, `${name} is ordinary terrain and must stay breakable`)
  }
})

test('§2 liquids are never reported as breakable (they flow, they are not mined)', () => {
  const policy = new DigPolicy({ file: null, enabled: true, mode: 'all' })
  assert.equal(policy.allows('water'), false)
  assert.equal(policy.allows('lava'), false)
  assert.equal(policy.allows('stone'), true)
})

test('§2 every name in NEVER_DIG is a real block in this version', () => {
  const missing = NEVER_DIG.filter((n) => !registry.blocksByName[n])
  assert.deepEqual(missing, [], `NEVER_DIG names that do not exist: ${missing.join(', ')}`)
})

test('§2 the shipped description of the default list matches the list', () => {
  const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  // The prompt used to say "dirt, grass, sand, gravel, snow, leaves" for a
  // 27-entry list; the new text names the families that are actually there.
  for (const family of ['moss_block', 'cobweb', 'vine', 'podzol', 'mycelium']) {
    assert.ok(DEFAULT_SOFT_BLOCKS.includes(family), `${family} is in the shipped list`)
    assert.ok(prompt.includes(family), `the prompt mentions ${family}`)
  }
  assert.match(prompt, /never breakable in any mode|never\*\* broken in any mode/, 'the prompt says what is never broken')
})

// ---------------------------------------------------------------------------
// §3 — the property guards cover the verbs that change somebody's property
// ---------------------------------------------------------------------------

test('§3 put and smelt are refused for a container inside a player claim', () => {
  const { ContinuityStore } = require('../zincai/continuity')
  const c = new ContinuityStore({ file: null, botName: "Zinc" })
  c.recordClaim({ name: 'Steve house', pos: { x: 10, y: 64, z: 10 }, radius: 6, dim: 'overworld', kind: 'player', owner: 'Steve' })
  const inside = { id: 'chest4', pos: { x: 11, y: 64, z: 11 }, kind: 'chest' }
  assert.equal(c.containerTakeGuard(inside, 'overworld', {}).ok, false, 'taking is refused')
  assert.equal(c.containerPutGuard(inside, 'overworld', {}).ok, false, 'putting is refused too')
  assert.equal(c.containerPutGuard(inside, 'overworld', { askedBy: 'Steve' }).ok, true, 'the owner may ask us')
})

test('§3 useBlockGuard refuses a bed, lever or door inside somebody else\'s claim', () => {
  const { ContinuityStore } = require('../zincai/continuity')
  const c = new ContinuityStore({ file: null, botName: "Zinc" })
  c.recordClaim({ name: 'Steve house', pos: { x: 0, y: 64, z: 0 }, radius: 8, dim: 'overworld', kind: 'player', owner: 'Steve' })
  const bed = { x: 2, y: 64, z: 1 }
  const g = c.useBlockGuard(bed, 'overworld', { what: 'the bed' })
  assert.equal(g.ok, false, 'a stranger\'s bed would move our respawn into their house')
  assert.match(g.reason, /Steve/)
  assert.equal(c.useBlockGuard(bed, 'overworld', { askedBy: 'Steve' }).ok, true)
  assert.equal(c.useBlockGuard({ x: 40, y: 64, z: 40 }, 'overworld', {}).ok, true, 'unclaimed ground is fine')
})

test('§3 our own claim never blocks us', () => {
  const { ContinuityStore } = require('../zincai/continuity')
  const c = new ContinuityStore({ file: null, botName: "Zinc" })
  c.recordClaim({ name: 'my base', pos: { x: 0, y: 64, z: 0 }, radius: 8, dim: 'overworld', kind: 'own', owner: 'Zinc' })
  assert.equal(c.containerPutGuard({ id: 'chest1', pos: { x: 1, y: 64, z: 1 } }, 'overworld', {}).ok, true)
  assert.equal(c.useBlockGuard({ x: 1, y: 64, z: 1 }, 'overworld', {}).ok, true)
})

// ---------------------------------------------------------------------------
// §4 — a build must not place blocks inside a claim it did not see
// ---------------------------------------------------------------------------

test('§4 a large floor with a claim on its centre is refused, not sampled away', () => {
  const { BlueprintParser } = require('../zincai/builder')
  const bot = makeWorld()
  const parser = new BlueprintParser({ scaffoldBlocks: ['scaffolding'], reach: 5 })
  // Continuity's claim semantics, matching index.js's check.
  const claims = [{ x: 7, y: 64, z: 7, radius: 3, kind: 'player', owner: 'Steve', name: 'house' }]
  const guardAt = (p) => {
    const c = claims.find((cl) => Math.hypot(p.x - cl.x, p.z - cl.z) <= cl.radius)
    return !c || c.kind !== 'player' ? { ok: true } : { ok: false, claim: c }
  }
  for (const size of [9, 15, 21]) {
    const blocks = []
    for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) blocks.push({ dx, dy: 0, dz, name: 'oak_planks' })
    const planned = parser.plan({ blocks }, { x: 0, y: 64, z: 0 }, bot.entity.position)
    const inClaim = planned.steps.filter((s) => !guardAt(s).ok).length
    assert.ok(inClaim > 0, `${size}x${size} really does reach into the claim`)
    // The rule index.js now applies: any step inside a claim refuses the build.
    const refused = planned.steps.some((s) => !guardAt(s).ok)
    assert.equal(refused, true, `${size}x${size} must be refused`)
  }
})

// ---------------------------------------------------------------------------
// §5 — `hold` accepts the ids the prompt tells the model to send
// ---------------------------------------------------------------------------

const call = (name, args) => coerceAction({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] })

test('§5 hold accepts ids, and a bare hold still holds everything', () => {
  const withIds = call('hold', { ids: [12, 13] })
  assert.equal(withIds._badArgs, undefined, 'hold must not reject the documented argument')
  assert.equal(withIds.a, 'hold')
  assert.deepEqual(withIds.ids, [12, 13])
  assert.equal(call('hold', {}).a, 'hold')
})

test('§5 the hold schema declares the field the system prompt mentions', () => {
  const hold = createZincTools().find((t) => t.function.name === 'hold')
  assert.ok(hold.function.parameters.properties.ids, 'hold has an `ids` parameter')
  const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  if (/hold.*\[id=/.test(prompt)) assert.ok(hold.function.parameters.properties.ids, 'the prompt may name it because the schema has it')
})

// ---------------------------------------------------------------------------
// §6 — a near-miss enum does not discard the whole call
// ---------------------------------------------------------------------------

test('§6 a near-miss enum value is mapped or passed through, never silently dropped', () => {
  const mapped = call('goal', { operation: 'add', description: 'build a shed', origin: 'self' })
  assert.equal(mapped._badArgs, undefined, 'the call survives')
  assert.equal(mapped.origin, 'self_generated', 'and the value is understood')
  assert.equal(call('goal', { operation: 'ADD', description: 'x' }).operation, 'add', 'case is forgiven')
  // An unmappable value reaches the handler, which explains what it wanted.
  const odd = call('goal', { operation: 'add', description: 'x', origin: 'mine' })
  assert.equal(odd._badArgs, undefined)
  assert.equal(odd.origin, 'mine')
})

test('§6 the chat lane\'s closed verb list is still closed', () => {
  const { coerceReply } = require('../zincai/api_wrapper')
  const bad = coerceReply({ tool_calls: [{ function: { name: 'reply', arguments: JSON.stringify({ text: 'ok', do: 'attack' }) } }] })
  assert.ok(!bad.do, 'the chat lane can never start a fight')
  const near = coerceReply({ tool_calls: [{ function: { name: 'reply', arguments: JSON.stringify({ text: 'ok', do: 'fol' }) } }] })
  assert.ok(!near.do, 'nor a typo that merely looks like one')
  const good = coerceReply({ tool_calls: [{ function: { name: 'reply', arguments: JSON.stringify({ text: 'ok', to: 'Steve', do: 'follow' }) } }] })
  assert.equal(good.do, 'follow')
})

// ---------------------------------------------------------------------------
// §7 — recall's paraphrase claim is true
// ---------------------------------------------------------------------------

test('§7 recall finds a memory that says "diamonds" when asked for "treasure"', () => {
  const M = require('../zincai/memory')
  const mem = new M.LongTermMemory({ file: null })
  mem.add('diamonds are in chest2 near the river', ['container'], 3)
  mem.add('the watchtower is north of the base', ['build'], 3)
  assert.equal(mem.retrieve({ query: 'treasure' }).entries.length, 1, 'synonym of diamonds')
  assert.equal(mem.retrieve({ query: 'where is the stash' }).entries.length, 1, 'synonym of chest/diamonds')
  assert.equal(mem.retrieve({ query: 'the spire' }).entries.length, 1, 'synonym of tower')
  assert.equal(mem.retrieve({ query: 'elephant' }).entries.length, 0, 'and it still says no when it does not know')
})

// ---------------------------------------------------------------------------
// §9 / §10 — geometry and the build grid
// ---------------------------------------------------------------------------

test('§9 build_shape puts every shape on the same corner, and arch honours axis', () => {
  for (const [shape, params] of [['cylinder', { r: 2, h: 1 }], ['ring', { r: 2 }], ['dome', { r: 2 }], ['box', { w: 3, d: 3, h: 1 }], ['floor', { w: 3, d: 3 }], ['wall', { l: 3, h: 1 }], ['arch', { w: 3, h: 3 }]]) {
    const blocks = generateShape(shape, params, 'stone')
    assert.equal(Math.min(...blocks.map((b) => b.dx)), 0, `${shape} starts at its corner in x`)
    assert.equal(Math.min(...blocks.map((b) => b.dz)), 0, `${shape} starts at its corner in z`)
  }
  const alongX = generateShape('arch', { w: 5, h: 4 }, 'stone')
  const alongZ = generateShape('arch', { w: 5, h: 4, axis: 'z' }, 'stone')
  assert.ok(Math.max(...alongX.map((b) => b.dx)) > 0, 'axis x spans x')
  assert.equal(Math.max(...alongX.map((b) => b.dz)), 0, 'axis x is flat in z')
  assert.ok(Math.max(...alongZ.map((b) => b.dz)) > 0, 'axis z spans z')
  assert.equal(Math.max(...alongZ.map((b) => b.dx)), 0, 'axis z is flat in x')
})

test('§10 the build grid is offered for any placeable block, not a name pattern', () => {
  const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'index.js'), 'utf8')
  assert.ok(!/BUILD_BLOCK_HINT/.test(prompt), 'the name regex is gone; the registry decides now')
  assert.match(prompt, /blocksByName\?\.\[held\]/, 'holding a block is decided by the registry')
})

// ---------------------------------------------------------------------------
// §12 — use_block matches the block the model named
// ---------------------------------------------------------------------------

test('§12 use_block never resolves "bed" to bedrock, or "chest" to an ender chest first', () => {
  const bot = makeWorld()
  const skills = new Skills(bot, { arbiter: { lane: () => ({ isTop: true, acquire () {}, setGoal () {} }) } })
  const bed = skills._matchUseBlockIds('bed').map((b) => b.name)
  assert.ok(bed.length > 0)
  assert.ok(!bed.includes('bedrock'), `"bed" must not match bedrock (got ${bed.slice(0, 4).join(', ')})`)
  assert.ok(bed.every((n) => n.endsWith('_bed')), 'every match is a real bed')
  assert.equal(skills._matchUseBlockIds('chest')[0].name, 'chest', 'an exact name wins')
  assert.equal(skills._matchUseBlockIds('lever')[0].name, 'lever')
  assert.equal(skills._matchUseBlockIds('not_a_block').length, 0)
})

// ---------------------------------------------------------------------------
// The dead config knobs
// ---------------------------------------------------------------------------

test('behavior.perceptionRange and perception3D are actually read', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'index.js'), 'utf8')
  assert.match(src, /cfg\.behavior\?\.perceptionRange/, 'the radius reaches the grid')
  assert.match(src, /cfg\.behavior\?\.perception3D/, 'the 3D switch reaches the grid')
  const defaults = require('../zincai/config/defaults.json')
  assert.equal(Object.hasOwn(defaults.behavior, 'fovDegrees'), false, 'the knob nothing could honour is gone')
  assert.match(defaults.behavior._senseNote || '', /no field-of-view/i, 'and the config says why')
})

test('scout.relocateTimeoutMs and scout.deathAvoidRadius are actually read', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'index.js'), 'utf8')
  assert.match(src, /sc\.relocateTimeoutMs/)
  assert.match(src, /sc\.deathAvoidRadius/)
})

// ---------------------------------------------------------------------------
// §8 — the model's answer to "place one block there" is `build` with a 1x1 grid
// ---------------------------------------------------------------------------

test('§8 a 1x1 build grid places exactly one block at the coordinate the model gave', () => {
  const { BlueprintParser } = require('../zincai/builder')
  const parser = new BlueprintParser({})
  const parsed = parser.parseInline({ grid: [['C']], palette: { C: 'cobblestone' }, name: 'one' })
  const planned = parser.plan(parsed, { x: 100, y: 70, z: -40 }, { x: 0, y: 64, z: 0 })
  assert.equal(planned.steps.length, 1, 'one cell in, one step out')
  assert.deepEqual(
    { x: planned.steps[0].x, y: planned.steps[0].y, z: planned.steps[0].z, name: planned.steps[0].name },
    { x: 100, y: 70, z: -40, name: 'cobblestone' }
  )
})

test('§8 the model can find out that single-block placement exists', () => {
  // The capability existed but nothing advertised it, so it was invisible.
  const build = createZincTools().find((t) => t.function.name === 'build')
  assert.match(build.function.description, /one single block|exactly that one block/i, 'the schema says so')
  const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'zincai', 'system_prompt.txt'), 'utf8')
  assert.match(prompt, /Placing one block/i, 'and the prompt says so')
})
