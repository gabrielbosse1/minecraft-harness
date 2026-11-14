/**
 * The 2026-11-14 live log, turned into tests.
 *
 *   1. Output-limit cut-offs: one retry, without reasoning, with enough room —
 *      not three calls that all die the same way.
 *   2. Vision: the screenshot renderer, the image on the wire, and the fallback
 *      for an endpoint that takes no images.
 *   3. Compaction with goal continuation: the work journal, plans, the
 *      `continue` block, and in-turn compaction.
 *   4. The harness faults the log exposed: the stale-threat refusal loop, a
 *      `hold` on invented ids reported as ok, a flat grid built as a wall,
 *      craft one batch per model call, keep-alive log spam.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { Vec3 } = require('vec3')

const logger = require('../src/logger')
for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}

const world = require('./helpers/world')
const { simulatedBot, startTestSession, sleep } = require('./helpers/session')
const { AmdToolsClient, createZincTools, toolTurnMessages, buildToolsPayload, withNoThinkSwitch, stripImages, hasImages, coerceAction } = require('../zincai/api_wrapper')
const vision = require('../zincai/vision')
const { WorkJournal, compactSteps } = require('../zincai/journal')
const { BlueprintParser } = require('../zincai/builder')
const { LoopWatchdog } = require('../zincai/watchdog')

/** Replace fetch with a scripted endpoint: each entry answers one request. */
function scriptedEndpoint (answers) {
  const requests = []
  const real = globalThis.fetch
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    requests.push(body)
    const next = answers.length > 1 ? answers.shift() : answers[0]
    const a = typeof next === 'function' ? next(body) : next
    if (a.status && a.status !== 200) return { ok: false, status: a.status, text: async () => a.text || '', json: async () => ({}) }
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: a.message, finish_reason: a.finish || 'stop' }], usage: { prompt_tokens: 12600, completion_tokens: a.tokens || 60 } }) }
  }
  return { requests, restore: () => { globalThis.fetch = real } }
}
const call = (name, args = {}) => ({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const CUT = { message: { content: '<think>Let me consider the inventory first. I have', tool_calls: undefined }, finish: 'length', tokens: 512 }
const client = (opts = {}) => new AmdToolsClient({ apiKey: 'rc-test', baseUrl: 'http://x/v1', model: 'm', maxRetries: 0, ...opts })
const MSGS = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'snapshot' }]

// ===========================================================================
// 1. Truncation and reasoning control
// ===========================================================================

test('an answer cut off by the output limit gets ONE retry: reasoning off, and never less room than before', async () => {
  const ep = scriptedEndpoint([CUT, { message: call('craft', { item: 'oak_planks' }) }])
  try {
    const amd = client({ maxTokens: 1536 })
    const r = await amd.chatWithTools(MSGS, createZincTools())
    assert.equal(r.action.a, 'craft')
    assert.equal(ep.requests.length, 2)
    const [first, retry] = ep.requests
    assert.equal(first.enable_thinking, undefined, 'the first call may reason')
    assert.equal(retry.enable_thinking, false)
    assert.deepEqual(retry.chat_template_kwargs, { enable_thinking: false })
    assert.match(retry.messages.at(-1).content, /\/no_think$/)
    assert.ok(retry.max_tokens >= 1536, `the retry used to be capped at 1024 — below the 1536 that had just been cut off (got ${retry.max_tokens})`)
    assert.ok(!retry.messages.some((m) => m.role === 'assistant' && /<think>/.test(String(m.content))), 'half a thought is not sent back')
  } finally { ep.restore() }
})

test('when the retry is cut off too, it stops at two calls and says it was the limit, not "you returned no tool call"', async () => {
  const ep = scriptedEndpoint([CUT])
  try {
    const amd = client({ maxTokens: 512 })
    const r = await amd.chatWithTools(MSGS, createZincTools())
    assert.equal(ep.requests.length, 2, 'the live log shows three ~12.6k-token calls per failed turn')
    assert.equal(r.action._truncated, true)
    assert.ok(ep.requests[1].max_tokens >= 1024)
  } finally { ep.restore() }
})

test('auto mode: after two cut-offs in a row the next calls skip reasoning up front', async () => {
  const ep = scriptedEndpoint([CUT, { message: call('idle') }, CUT, { message: call('idle') }, { message: call('idle') }])
  try {
    const amd = client({ maxTokens: 512, thinking: 'auto' })
    await amd.chatWithTools(MSGS, createZincTools())
    await amd.chatWithTools(MSGS, createZincTools())
    await amd.chatWithTools(MSGS, createZincTools())
    assert.equal(ep.requests.length, 5)
    assert.equal(ep.requests[4].enable_thinking, false, 'the third answer is asked for without a reasoning phase')
    assert.equal(amd.stats.truncatedAnswers, 2)
  } finally { ep.restore() }
})

test('thinking "off" never reasons; "on" never switches it off; a complete call in a length-finished answer is used as is', async () => {
  let ep = scriptedEndpoint([{ message: call('idle') }])
  try {
    await client({ thinking: 'off' }).chatWithTools(MSGS, createZincTools())
    assert.equal(ep.requests[0].enable_thinking, false)
  } finally { ep.restore() }
  ep = scriptedEndpoint([CUT, { message: call('idle') }])
  try {
    await client({ thinking: 'on' }).chatWithTools(MSGS, createZincTools())
    assert.equal(ep.requests[1].enable_thinking, undefined)
  } finally { ep.restore() }
  ep = scriptedEndpoint([{ message: call('go_to', { x: 1, z: 2 }), finish: 'length' }])
  try {
    const r = await client().chatWithTools(MSGS, createZincTools())
    assert.equal(r.action.a, 'go_to')
    assert.equal(ep.requests.length, 1)
  } finally { ep.restore() }
})

test('an endpoint that rejects the reasoning fields keeps only the /no_think prompt switch', async () => {
  const ep = scriptedEndpoint([
    (body) => ('enable_thinking' in body ? { status: 400, text: 'Unrecognized request argument supplied: enable_thinking' } : { message: call('idle') })
  ])
  try {
    const amd = client({ thinking: 'off' })
    const r = await amd.chatWithTools(MSGS, createZincTools())
    assert.equal(r.action.a, 'idle')
    assert.equal(amd.thinkingFields, false)
    assert.equal(ep.requests.at(-1).enable_thinking, undefined)
    assert.match(ep.requests.at(-1).messages.at(-1).content, /\/no_think/)
  } finally { ep.restore() }
})

test('a reasoning-only answer (content null, reasoning_content, finish length) is a cut-off, not a malformed response', async () => {
  const ep = scriptedEndpoint([{ message: { content: null, reasoning_content: 'thinking…' }, finish: 'length' }, { message: call('idle') }])
  try {
    const r = await client().chatWithTools(MSGS, createZincTools())
    assert.equal(r.action.a, 'idle')
    assert.equal(ep.requests.length, 2)
  } finally { ep.restore() }
})

test('chat replies: chatThinking "off" asks without reasoning; a cut-off reply is retried without it', async () => {
  let ep = scriptedEndpoint([{ message: call('reply', { text: 'oi' }) }])
  try {
    const { reply } = await client({ chatThinking: 'off' }).chatReply(MSGS)
    assert.equal(reply.text, 'oi')
    assert.equal(ep.requests[0].enable_thinking, false)
  } finally { ep.restore() }
  ep = scriptedEndpoint([{ message: { content: '' }, finish: 'length' }, { message: call('reply', { text: 'fui minerar' }) }])
  try {
    const { reply } = await client({ chatThinking: 'auto' }).chatReply(MSGS, { maxTokens: 200 })
    assert.equal(reply.text, 'fui minerar')
    assert.equal(ep.requests[0].enable_thinking, undefined)
    assert.equal(ep.requests[1].enable_thinking, false)
  } finally { ep.restore() }
})

test('payload helpers are pure and leave an ordinary request untouched', () => {
  const plain = buildToolsPayload({ model: 'm', messages: MSGS, temperature: 0.2, maxTokens: 64, tools: [] })
  assert.equal('enable_thinking' in plain, false)
  assert.equal(plain.messages, MSGS)
  const off = withNoThinkSwitch(MSGS)
  assert.equal(MSGS[1].content, 'snapshot', 'the input is not modified')
  assert.equal(off[1].content, 'snapshot\n/no_think')
  const parts = withNoThinkSwitch([{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:x' } }] }])
  assert.equal(parts[0].content[0].text, 'see\n/no_think')
})

// ===========================================================================
// 2. Vision
// ===========================================================================

/** Decode a PNG written by vision.js back to { width, height, rgb }. */
function decodePng (png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const width = png.readUInt32BE(16); const height = png.readUInt32BE(20)
  let off = 8; const idat = []
  while (off < png.length) {
    const len = png.readUInt32BE(off); const type = png.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const px = (x, y) => { const i = y * (width * 3 + 1) + 1 + x * 3; return [raw[i], raw[i + 1], raw[i + 2]] }
  return { width, height, px }
}

/** Flat grass at y 63, a stone wall 6 blocks north (z = -6), an oak log to the east. */
function sceneBot () {
  const bot = world.makeWorld((x, y, z) => {
    if (y <= 63) return y === 63 ? 'grass_block' : true
    if (z === -6 && y <= 68 && Math.abs(x) <= 8) return 'stone'
    if (x === 5 && z === 0 && y <= 67) return 'oak_log'
    return false
  })
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.time = { timeOfDay: 6000 }
  return bot
}

test('look: a valid PNG whose pixels are the wall in front and the ground below, with the crosshair block named', async () => {
  const bot = sceneBot()
  const shot = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 160, height: 90 })
  const img = decodePng(shot.png)
  assert.equal(img.width, 160); assert.equal(img.height, 90)
  assert.match(shot.summary, /looking N /)
  assert.match(shot.summary, /crosshair: stone at 0,65,-6 \(6m\)/)
  assert.match(shot.summary, /stone \d+%/)
  assert.match(shot.summary, /grass_block \d+%/)
  const wall = img.px(120, 40); const ground = img.px(120, 86); const sky = img.px(80, 1)
  assert.ok(Math.abs(wall[0] - wall[1]) < 12 && Math.abs(wall[1] - wall[2]) < 12, `the wall is grey (${wall})`)
  assert.ok(ground[1] > ground[0] && ground[1] > ground[2], `the ground is green (${ground})`)
  assert.ok(sky[2] > sky[0], `above the wall is sky (${sky})`)
})

test('look: direction and `at` turn the camera; the log is east, not north', async () => {
  const bot = sceneBot()
  const east = await vision.screenshot(bot, { view: 'look', direction: 'east', width: 128, height: 72 })
  assert.match(east.summary, /looking E /)
  assert.match(east.summary, /crosshair: oak_log at 5,65,0/)
  const at = await vision.screenshot(bot, { view: 'look', at: [5, 65, 0], width: 128, height: 72 })
  assert.match(at.summary, /crosshair: oak_log at 5,65,0/)
  const south = await vision.screenshot(bot, { view: 'look', direction: 'south', width: 128, height: 72 })
  assert.doesNotMatch(south.summary, /stone \d+%|oak_log/)
})

test('creatures are drawn and listed with their ids; one behind a wall is not', async () => {
  const bot = sceneBot()
  world.addMob(bot, 41, 'zombie', 0.5, -3.5)
  world.addMob(bot, 42, 'skeleton', 0.5, -12.5) // behind the wall
  const shot = await vision.screenshot(bot, { view: 'look', direction: 'north', width: 160, height: 90, isHostile: (n) => n === 'zombie' || n === 'skeleton' })
  assert.match(shot.summary, /zombie \[id=41\] 4m centre HOSTILE/)
  assert.doesNotMatch(shot.summary, /skeleton/)
  const img = decodePng(shot.png)
  const body = img.px(76, 60)
  assert.ok(body[0] > 180 && body[1] < 110, `a hostile is a red box (${body})`)
})

test('panorama covers the whole circle; map is north-up with world coordinates in its summary', async () => {
  const bot = sceneBot()
  world.addMob(bot, 43, 'cow', -6.5, 0.5, { type: 'animal' })
  const pano = await vision.screenshot(bot, { view: 'panorama' })
  assert.match(pano.summary, /NORTH in the middle/)
  assert.match(pano.summary, /stone \d+%/)
  assert.match(pano.summary, /oak_log/)
  assert.match(pano.summary, /cow \[id=43\] \d+m W/)
  const map = await vision.screenshot(bot, { view: 'map', radius: 16 })
  assert.equal(map.view, 'map')
  assert.match(map.summary, /33x33 blocks \(x -16\.\.16, z -16\.\.16\)/)
  assert.match(map.summary, /cow \[id=43\] at -7,64,0/)
  const img = decodePng(map.png)
  assert.ok(img.width > 300 && img.height > 300)
})

test('materials: clutter is skipped, shapes are partial, unknown blocks still get a stable colour', () => {
  assert.equal(vision.materialFor('short_grass', 'empty'), null)
  assert.equal(vision.materialFor('air'), null)
  assert.ok(vision.materialFor('oak_slab').shape)
  assert.equal(vision.materialFor('lava').kind, 'emissive')
  assert.equal(vision.materialFor('water').kind, 'water')
  assert.deepEqual(vision.materialFor('zz_future_block').color, vision.materialFor('zz_future_block').color)
  assert.equal(vision.bearingOfYaw(0), 0)
  assert.equal(vision.compassName(vision.bearingOfYaw(-Math.PI / 2)), 'E')
})

test('images on the wire: after the tool results, as image parts; stripped for an endpoint that takes none', () => {
  const calls = [{ id: 'c1', name: 'screenshot', args: { view: 'look' }, result: 'view from 0,64,0…' }]
  const msgs = toolTurnMessages(calls, { images: [{ url: 'data:image/png;base64,AAAA', caption: 'screenshot (look):' }] })
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1].role, 'tool')
  assert.equal(msgs[2].role, 'user')
  assert.equal(msgs[2].content[1].image_url.url, 'data:image/png;base64,AAAA')
  assert.equal(hasImages(msgs), true)
  const text = toolTurnMessages(calls, { format: 'text', images: [{ url: 'data:image/png;base64,AAAA' }] })
  assert.equal(text[1].content.at(-1).type, 'image_url')
  const stripped = stripImages(msgs)
  assert.equal(hasImages(stripped), false)
  assert.match(stripped[2].content, /image omitted/)
  assert.equal(toolTurnMessages(calls).length, 2, 'no images, no extra message')
})

test('an endpoint that refuses the image is asked again without it, and remembered for the session', async () => {
  const withImage = [...MSGS, { role: 'user', content: [{ type: 'text', text: 'shot' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
  const ep = scriptedEndpoint([(body) => (hasImages(body.messages) ? { status: 400, text: 'image input is not supported by this model' } : { message: call('idle') })])
  try {
    const amd = client()
    const r = await amd.chatWithTools(withImage, createZincTools())
    assert.equal(r.action.a, 'idle')
    assert.equal(amd.visionSupported, false)
    assert.equal(ep.requests.length, 2)
    await amd.chatWithTools(withImage, createZincTools())
    assert.equal(ep.requests.length, 3, 'the next call does not try the image again')
    assert.equal(hasImages(ep.requests[2].messages), false)
  } finally { ep.restore() }
})

test('the screenshot tool is offered, validated, and is a read-only lane', () => {
  const t = createZincTools().find((x) => x.function.name === 'screenshot')
  assert.ok(t)
  assert.match(t.function.description, /orientation/i)
  assert.match(t.function.description, /inspect_block/)
  const a = coerceAction({ tool_calls: [{ function: { name: 'screenshot', arguments: '{"view":"panorama"}' } }] })
  assert.equal(a.a, 'screenshot'); assert.equal(a.view, 'panorama')
  const L = require('../zincai/lanes')
  assert.equal(L.laneOf('screenshot'), L.LANES.WORLD_INFO)
})

test('session: screenshot returns its picture to the model on the next step of the same turn, and saves a copy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-shot-'))
  let n = 0
  const s = startTestSession({
    dataDir,
    bot: simulatedBot(),
    actions: (p) => (/where am i/.test(p) && ++n === 1 ? { a: 'screenshot', view: 'look', direction: 'north' } : { a: 'idle' })
  })
  try {
    s.spawn()
    await sleep(150)
    s.internals().brain.wake('where am i')
    assert.ok(await s.until(() => s.prompts.requests.some((r) => hasImages(r.messages)), 4000), 'a request carried the image')
    const req = s.prompts.requests.find((r) => hasImages(r.messages))
    const tool = req.messages.find((m) => m.role === 'tool')
    assert.match(tool.content, /view from .* looking N/)
    assert.match(tool.content, /image is attached/)
    const pic = req.messages.at(-1)
    assert.equal(pic.role, 'user')
    assert.match(pic.content.find((x) => x.type === 'image_url').image_url.url, /^data:image\/png;base64,iVBOR/)
    assert.ok(fs.existsSync(path.join(dataDir, 'screenshots', 'last-look.png')))
  } finally { await s.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) }
})

// ===========================================================================
// 3. Compaction with goal continuation
// ===========================================================================

test('journal: identical repeats merge, old steps fold into a counted per-goal digest, nothing is invented', () => {
  let now = 1_000_000
  const j = new WorkJournal({ now: () => now, keepRecent: 4 })
  for (let i = 0; i < 9; i++) { now += 60_000; j.record({ tool: 'craft', args: { item: 'oak_planks' }, ok: true, msg: 'crafted oak_planks x4', goalId: 'g25' }) }
  assert.equal(j.recent.length, 1)
  assert.equal(j.recent[0].n, 9)
  j.record({ tool: 'build_shape', args: { shape: 'floor', block: 'oak_planks' }, ok: false, msg: 'missing oak_planks x76', goalId: 'g25' })
  j.record({ tool: 'gather', args: { item: 'oak_log', count: 20 }, ok: false, msg: 'no oak_log within 32 blocks', goalId: 'g25' })
  j.record({ tool: 'go_to', args: { x: 32, y: 94, z: 49 }, ok: true, msg: 'arrived at 32,94,50', goalId: 'g25' })
  j.death({ where: '-25,102,47', cause: 'hit by zombie', goalId: 'g25' })
  j.record({ tool: 'say', args: { text: 'hi' }, ok: true, msg: 'sent', goalId: 'g25' })
  j.record({ tool: 'gather', args: { item: 'oak_log', count: 20 }, ok: true, msg: 'dig calls completed: 20/20', goalId: 'g25' })
  j.compact({ keep: 2 })
  const d = j.digest.g25
  assert.equal(d.done['craft oak_planks'].n, 9)
  assert.match(d.failed['build_shape floor'].why, /missing oak_planks x76/)
  assert.equal(d.deaths.length, 1)
  const block = j.continuation({ goal: { id: 'g25', description: 'small base near the grove' } })
  assert.match(block, /continue g25 "small base near the grove"/)
  assert.match(block, /does NOT need `goal resume`/)
  assert.match(block, /done earlier: .*craft oak_planks ×9/)
  assert.match(block, /still failing: build_shape floor — missing oak_planks x76/)
  assert.match(block, /deaths on this goal: 1 \(-25,102,47 hit by zombie/)
  assert.match(block, /recent steps .*gather oak_log x20 ok/)
})

test('journal: a failure that later succeeds leaves "still failing"; the loop check names a repeated call', () => {
  const j = new WorkJournal({ keepRecent: 4 })
  j.record({ tool: 'gather', args: { item: 'oak_log' }, ok: false, msg: 'none within 32', goalId: 'g1' })
  j.record({ tool: 'go_to', args: { x: 1, z: 2 }, ok: true, msg: 'arrived', goalId: 'g1' })
  j.record({ tool: 'gather', args: { item: 'oak_log' }, ok: true, msg: 'dug 5', goalId: 'g1' })
  j.compact({ keep: 0 })
  assert.equal(j.digest.g1.failed['gather oak_log'], undefined)
  for (let i = 0; i < 3; i++) j.record({ tool: 'craft', args: { item: 'oak_planks' }, ok: true, msg: 'x4', goalId: 'g1' })
  assert.match(j.loopHint(), /"craft oak_planks" 3 times in a row.*count/)
  const k = new WorkJournal()
  k.record({ tool: 'hold', args: { ids: [1] }, ok: false, msg: 'no threat has id 1' })
  k.record({ tool: 'go_to', args: { x: 1, z: 1 }, ok: false, msg: 'refused' })
  k.record({ tool: 'hold', args: { ids: [1, 2] }, ok: false, msg: 'no threat has id 1, 2' })
  assert.match(k.loopHint(), /never guessed numbers/)
})

test('journal: a plan keeps its done marks, points at the next step, and survives a restart on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-journal-'))
  const file = path.join(dir, 'journal.json')
  try {
    const j = new WorkJournal({ file })
    j.setFocus('g25')
    j.setPlan('g25', ['get 20 oak_log', 'craft 40 planks', 'build 3x3 hut', 'door + torch'])
    assert.deepEqual(j.markDone('g25', 1), [1])
    assert.equal(j.nextStep('g25'), 'craft 40 planks')
    j.setNext('g25', 'craft {item:"oak_planks", count:40}')
    j.record({ tool: 'gather', args: { item: 'oak_log', count: 20 }, ok: true, msg: '20/20', goalId: 'g25' })
    j.save({ force: true })

    const again = new WorkJournal({ file })
    assert.equal(again.focus, 'g25')
    assert.equal(again.planLine('g25'), '1✓ get 20 oak_log | 2→ craft 40 planks | 3. build 3x3 hut | 4. door + torch')
    const block = again.continuation({ goal: { id: 'g25', description: 'small base' } })
    assert.match(block, /plan: 1✓ get 20 oak_log \| 2→ craft 40 planks/)
    assert.match(block, /next: craft \{item:"oak_planks", count:40\}/)
    assert.match(again.resumeSentence({ id: 'g25', description: 'small base' }), /still g25 .*next step: craft/)
    // Re-planning keeps what was already done.
    again.setPlan('g25', ['get 20 oak_log', 'craft 40 planks', 'build 5x5 hut'])
    assert.match(again.planLine('g25'), /^1✓ get 20 oak_log/)
    again.prune([])
    assert.equal(again.focus, null)
    assert.equal(again.planLine('g25'), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('in-turn compaction: old tool results shrink to a headline past the budget, only the newest screenshot keeps its image', () => {
  const big = 'x'.repeat(3000)
  const history = [
    { calls: [{ name: 'inspect_region', result: big }], images: [{ url: 'data:1' }] },
    { calls: [{ name: 'inspect_region', result: big }] },
    { calls: [{ name: 'screenshot', result: 'view…' }], images: [{ url: 'data:2' }] },
    { calls: [{ name: 'find', result: big }] }
  ]
  const out = compactSteps(history, { maxChars: 6000, keepFull: 2 })
  assert.ok(out[0].calls[0].result.length < 400)
  assert.match(out[0].calls[0].result, /\[compacted: \d+ more chars dropped/)
  assert.equal(out[3].calls[0].result.length, 3000, 'the newest results stay whole')
  assert.deepEqual(out[0].images, [])
  assert.equal(out[2].images.length, 1)
  assert.equal(history[0].calls[0].result.length, 3000, 'the input is not modified')
  assert.equal(compactSteps(history.slice(1, 2), { maxChars: 6000 })[0].calls[0].result.length, 3000, 'under budget: untouched')
})

test('session: a goal with steps is shown back as a continue block, and comes back by itself after a death', async () => {
  let stage = 0
  const s = startTestSession({
    bot: simulatedBot(),
    actions: (p) => {
      if (/start the base/.test(p) && stage === 0) { stage = 1; return { a: 'goal', operation: 'add', description: 'small base near the grove', steps: ['get 20 oak_log', 'craft 40 planks', 'build 3x3 hut'] } }
      if (/first step done/.test(p) && stage === 1) { stage = 2; return { a: 'goal', operation: 'update', id: 'g1', done: 1, next: 'craft oak_planks count 40' } }
      return { a: 'idle' }
    }
  })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    it.brain.wake('start the base')
    assert.ok(await s.until(() => it.goals.openGoals().length === 1, 3000))
    const gid = it.goals.openGoals()[0].id
    assert.equal(it.journal.focus, gid)
    assert.match(it.results.find((r) => r.label === 'goal').msg, /plan: 1→ get 20 oak_log \| 2\. craft 40 planks/)
    it.brain.wake('first step done')
    assert.ok(await s.until(() => it.journal.nextStep(gid) === 'craft oak_planks count 40', 3000))
    const prompt = it.buildActionPrompt(['check']).text
    assert.match(prompt, new RegExp(`continue ${gid} "small base near the grove"`))
    assert.match(prompt, /plan: 1✓ get 20 oak_log \| 2→ craft 40 planks \| 3\. build 3x3 hut/)
    assert.match(prompt, /next: craft oak_planks count 40/)

    // Death: the goal is suspended by the registry — and continued without a `goal resume` call.
    it.kill()
    assert.notEqual(it.goals.get(gid).status, 'active')
    it.respawn()
    await it.reconcileAfterRespawn()
    assert.equal(it.goals.get(gid).status, 'active', 'a plan of the model\'s own is current again by itself')
    const after = it.buildActionPrompt(['respawned']).text
    assert.match(after, /deaths on this goal: 1/)
    assert.match(after, /next: craft oak_planks count 40/)
    // Asking to resume what is already current is answered without re-running anything.
    const r = await it.runGoalOp({ a: 'goal', operation: 'resume', id: gid }, {})
    assert.match(r.msg, /already your current objective/)
    assert.doesNotMatch(r.msg, /start it with the normal tools; start it with the normal tools/)
  } finally { await s.stop() }
})

// ===========================================================================
// 4. Harness faults from the log
// ===========================================================================

test('a stale refusal names the new threats with their ids, and does not refuse the informed second call', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    const snap = { threatIds: [], goalId: null }
    world.addMob(bot, 77, 'zombie', 6, 0)
    it.sense.assess()
    assert.ok(it.sense.last.dangerIds.has(77))
    const why = it.staleActionReason({ a: 'go_to', x: 30, z: 30 }, snap)
    assert.match(why, /1 new threat came close/)
    assert.match(why, /zombie \[id=77\] \d+m/)
    assert.match(why, /hold \{ids:\[77\]\}/)
    assert.equal(it.staleActionReason({ a: 'go_to', x: 30, z: 30 }, snap), null, 'the model has been told: its next call is a decision, not a stale one')
    // …but a threat that arrives after that is new again.
    world.addMob(bot, 78, 'skeleton', -7, 0)
    it.sense.assess()
    assert.match(it.staleActionReason({ a: 'gather', item: 'oak_log' }, snap), /skeleton \[id=78\]/)
  } finally { await s.stop() }
})

test('hold on invented ids FAILS and lists the real ones; hold on a threat that arrived mid-turn works', async () => {
  const bot = simulatedBot()
  const s = startTestSession({ bot })
  try {
    s.spawn()
    await sleep(150)
    const it = s.internals()
    const snap = { threatIds: [], reasons: [] }
    world.addMob(bot, 91, 'zombie', 7, 0)
    it.sense.assess()
    await it.executeAction({ a: 'hold', ids: [1, 2, 3] }, snap)
    const bad = it.results.at(-1)
    assert.equal(bad.ok, false, 'the live log shows "hold: ok — no threat with id 1 is listed"')
    assert.match(bad.msg, /no threat has id 1, 2, 3.*\[id=…\].*91/)
    await it.executeAction({ a: 'hold', ids: [91] }, snap)
    const good = it.results.at(-1)
    assert.equal(good.ok, true)
    assert.match(good.msg, /no longer running from 1 listed threat/)
  } finally { await s.stop() }
})

test('a flat grid of single cells is ONE layer (a floor), not a wall; row strings keep their 3D meaning', () => {
  const parser = new BlueprintParser({})
  const flat = parser.parseInline({ grid: [['s', 's', 's'], ['s', 's', 's'], ['s', 's', 's']], palette: { s: 'dirt' } })
  assert.equal(flat.blockCount, 9)
  assert.ok(flat.blocks.every((b) => b.dy === 0), 'the live log built 3 of these 9 as a "foundation" and stacked the rest')
  assert.equal(flat.flatRead, true)
  assert.match(flat.note, /ONE flat layer 3x3/)
  const wall = parser.parseInline({ grid: [['sss'], ['sss']], palette: { s: 'dirt' } })
  assert.equal(new Set(wall.blocks.map((b) => b.dy)).size, 2)
  assert.equal(wall.flatRead, undefined)
  const one = parser.parseInline({ grid: [['C']], palette: { C: 'cobblestone' } })
  assert.equal(one.blockCount, 1)
  const column = parser.parseInline({ grid: [['C'], ['C'], ['C']], palette: { C: 'cobblestone' } })
  assert.equal(new Set(column.blocks.map((b) => b.dy)).size, 3, 'a 1-wide pillar is still a pillar')
})

test('craft takes a count, and the goal tool takes steps/done/next', () => {
  const craft = coerceAction({ tool_calls: [{ function: { name: 'craft', arguments: '{"item":"oak_planks","count":40}' } }] })
  assert.equal(craft.count, 40)
  const goal = coerceAction({ tool_calls: [{ function: { name: 'goal', arguments: '{"operation":"update","id":"g1","done":2,"next":"build","steps":["a","b"]}' } }] })
  assert.equal(goal.done, 2); assert.equal(goal.next, 'build'); assert.deepEqual(goal.steps, ['a', 'b'])
})

test('a server that sends keep-alives every 120 s is learned once instead of warned about every two minutes', () => {
  const logs = []
  let now = 10_000
  const wd = new LoopWatchdog({ log: (level, msg) => logs.push({ level, msg }), now: () => now, stack: false })
  wd.linkUp({ timeoutMs: 60_000 })
  wd.packet('keep_alive', { keepAliveId: 1n })
  const cycle = (id) => {
    for (let i = 0; i < 120; i++) { now += 1000; wd.packet('entity_status', {}); wd._checkKeepAlive(now) }
    wd.packet('keep_alive', { keepAliveId: id })
  }
  cycle(2n)
  assert.equal(logs.filter((l) => l.level === 'warn').length, 1, 'the first late stream is still reported')
  assert.match(logs.at(-1).msg, /keep-alives resumed after 120\.0s.*cadence is ~120s.*only past 180s/)
  const before = logs.length
  cycle(3n); cycle(4n); cycle(5n)
  assert.equal(logs.length, before, 'six more minutes, not one more line')
  // A real gap for THIS server is still reported.
  for (let i = 0; i < 181; i++) { now += 1000; wd.packet('entity_status', {}); wd._checkKeepAlive(now) }
  assert.equal(logs.filter((l) => l.level === 'warn').length, 2)
})
