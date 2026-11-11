/**
 * Loopback end-to-end check.
 *
 * Everything real except the model and the world:
 *   - a local Minecraft server (flying-squid 1.16.5, flat world) in a child process;
 *   - the REAL harness processes (`node zincai/index.js`, `node src/index.js`),
 *     speaking the real protocol through mineflayer;
 *   - "Gabriel", an ordinary mineflayer client playing the friend;
 *   - a local HTTP endpoint standing in for the AMD API, answering from a small
 *     scripted policy that READS the prompt like the model would.
 *
 * What it proves that the unit tests cannot: login, tab list, chat with
 * accents over the wire, real pathfinding/physics against a server, real
 * attack packets, and what the harness actually sends to the model.
 *
 * What it cannot prove: mob AI (flying-squid mobs stand still and never
 * attack), /msg (not implemented by this server), Minecraft 26.3 behaviour,
 * and the real AMD endpoint.
 *
 *   cd test/e2e && npm install && node loopback.js            # both harnesses
 *   node loopback.js --only=zincai | --only=zinc
 *
 * Logs: test/e2e/logs/*.log (git-ignored). Exit code 0 = every check passed.
 */
'use strict'

const { fork, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const LOGS = path.join(__dirname, 'logs')
const MC_PORT = Number(process.env.E2E_MC_PORT || 25599)
const MODEL_PORT = Number(process.env.E2E_MODEL_PORT || 18099)
const VERSION = '1.16.5'
const GROUND_Y = 5 // flying-squid superflat: players stand at y=5
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null

let mineflayer
try {
  mineflayer = require('mineflayer')
  require.resolve('flying-squid')
} catch (err) {
  console.error('[e2e] missing dependencies. Run `npm ci` in the repo root and `npm install` in test/e2e first.')
  console.error(`[e2e] (${err.message.split('\n')[0]})`)
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...a) => console.log('[e2e]', ...a)
const checks = []
function check (name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) })
  log(ok ? 'PASS' : 'FAIL', name, detail ? `— ${detail}` : '')
  return Boolean(ok)
}
async function until (fn, ms, step = 100) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= end) return false
    await sleep(step)
  }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// ---------------------------------------------------------------- server ---
function startServer () {
  fs.mkdirSync(LOGS, { recursive: true })
  const out = fs.openSync(path.join(LOGS, 'server.log'), 'w')
  const child = fork(path.join(__dirname, 'server.js'), [], {
    stdio: ['ignore', out, out, 'ipc'],
    env: { ...process.env, E2E_MC_PORT: String(MC_PORT), E2E_MC_VERSION: VERSION }
  })
  let n = 0
  const waiting = new Map()
  const ready = new Promise((resolve, reject) => {
    child.on('message', (m) => {
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id)
        waiting.delete(m.id)
        if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result)
      } else if (m.event === 'listening') resolve()
      else if (m.event === 'error') reject(new Error(m.error))
    })
    child.on('exit', (code) => reject(new Error(`server exited (${code})`)))
  })
  const ask = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = ++n
    waiting.set(id, { resolve, reject })
    child.send({ id, cmd, args })
  })
  return {
    ready,
    ask,
    player: async (name) => (await ask('players')).find((p) => p.name === name) || null,
    stop: () => { try { child.send({ cmd: 'stop' }) } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 500) }
  }
}

// ----------------------------------------------------------------- model ---
/**
 * Stand-in for the AMD endpoint. Three lanes, told apart by the request:
 *   zinc   — harness A: no tools; the answer is one JSON action as text
 *   chat   — harness B's chat lane: the only tool is `reply`
 *   act    — harness B's action lane: the 23 action tools
 */
function startModel () {
  const model = { policy: { zinc: null, chat: null, act: null }, prompts: { zinc: [], chat: [], act: [] }, requests: [] }
  let calls = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let payload
      try { payload = JSON.parse(body) } catch { res.writeHead(400); res.end('{}'); return }
      const user = String(payload.messages[payload.messages.length - 1].content)
      model.requests.push({ tool_choice: payload.tool_choice, tools: payload.tools ? payload.tools.length : 0, auth: req.headers.authorization })
      let message
      if (!payload.tools) {
        model.prompts.zinc.push(user)
        const action = (model.policy.zinc && model.policy.zinc(user)) || { a: 'idle' }
        message = { role: 'assistant', content: JSON.stringify(action) }
      } else {
        const lane = payload.tools[0].function.name === 'reply' ? 'chat' : 'act'
        model.prompts[lane].push(user)
        const call = (model.policy[lane] && model.policy[lane](user)) || (lane === 'chat' ? { name: 'reply', args: { text: '' } } : { name: 'idle', args: {} })
        message = { role: 'assistant', content: null, tool_calls: [{ id: `call_${++calls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: `cmpl-${calls}`, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 12, total_tokens: Math.ceil(body.length / 4) + 12 } }))
    })
  })
  return new Promise((resolve) => server.listen(MODEL_PORT, '127.0.0.1', () => resolve({ ...model, model, close: () => server.close() })))
}

// --------------------------------------------------------------- harness ---
function startHarness (entry, name, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zinc-e2e-'))
  const logFile = fs.createWriteStream(path.join(LOGS, `${name}.log`))
  const lines = []
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      MC_HOST: '127.0.0.1',
      MC_PORT: String(MC_PORT),
      MC_VERSION: VERSION,
      MC_AUTH: 'offline',
      AMD_API_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
      // A dummy key in every name the harnesses read, so the real one in a
      // local .env is never used (and the endpoint is this machine anyway).
      API_KEY: 'rc-loopback',
      AMD_API_KEY: 'rc-loopback',
      RADEON_API_KEY: 'rc-loopback',
      ZINC_DATA_DIR: dataDir,
      LOG_LEVEL: 'debug',
      RECONNECT: 'false',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let exited = null
  const onData = (buf) => {
    logFile.write(buf)
    for (const line of String(buf).split('\n')) if (line.trim()) lines.push(line)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('exit', (code, signal) => { exited = { code, signal } })
  return {
    lines,
    exited: () => exited,
    saw: (re) => lines.some((l) => re.test(l)),
    async stop () {
      if (!exited) child.kill('SIGINT')
      await until(() => exited, 5000)
      if (!exited) child.kill('SIGKILL')
      logFile.end()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------- friend ---
function joinFriend (username) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: MC_PORT, username, auth: 'offline', version: VERSION })
    const heard = []
    bot.on('messagestr', (line) => heard.push(String(line)))
    bot.once('spawn', () => resolve({ bot, heard, heardFrom: (name, re) => heard.some((l) => l.includes(name) && re.test(l)) }))
    bot.once('error', reject)
    bot.on('kicked', (reason) => log(`${username} was kicked: ${reason}`))
  })
}

/** Walk up to `target` and punch it `times` times, like a player would. */
async function punch (friend, targetName, times, server) {
  const victim = await server.player(targetName)
  const me = await server.player(friend.bot.username)
  // Stand two blocks away (the server computes knockback from the distance).
  const dx = me.position.x - victim.position.x
  const dz = me.position.z - victim.position.z
  const len = Math.hypot(dx, dz) || 1
  await server.ask('teleport', { name: friend.bot.username, x: victim.position.x + dx / len * 2, y: victim.position.y, z: victim.position.z + dz / len * 2 })
  await sleep(600)
  let landed = 0
  for (let i = 0; i < times; i++) {
    const entity = friend.bot.players[targetName]?.entity
    if (!entity) break
    await friend.bot.lookAt(entity.position.offset(0, 1.5, 0), true)
    friend.bot.attack(entity) // swings the arm, then sends the attack
    landed++
    await sleep(550)
  }
  return landed
}

// ------------------------------------------------------------- scenarios ---
/**
 * The same four scenes for either harness; `h` describes how to talk to it.
 */
async function runScenes (h, { server, model, friend }) {
  const name = h.botName
  const tag = (s) => `${name}: ${s}`
  log(`--- ${name} (${h.entry}) ---`)
  const before = { zinc: model.prompts.zinc.length, chat: model.prompts.chat.length, act: model.prompts.act.length }
  const proc = startHarness(h.entry, name.toLowerCase(), h.env)
  const prompts = () => h.prompts(model, before)

  try {
    // -- scene 0: join ------------------------------------------------------
    const ready = await until(() => proc.saw(h.readyRe) || proc.exited(), 30_000)
    check(tag('joins the server and reports ready'), ready && !proc.exited(), proc.exited() ? `exited ${JSON.stringify(proc.exited())}` : '')
    if (!ready || proc.exited()) return
    check(tag('logs in under its fixed name'), Boolean(await until(() => server.player(name), 5000)))
    check(tag('is visible to a player who was already online'), Boolean(await until(() => friend.bot.players[name]?.entity, 5000)))

    await server.ask('teleport', { name, x: 0.5, y: GROUND_Y, z: 0.5 })
    await server.ask('teleport', { name: 'Gabriel', x: 12.5, y: GROUND_Y, z: 0.5 })
    await sleep(1500)
    const idleCalls = prompts().length

    // -- scene 1: "zinc vem aqui" ------------------------------------------
    h.phase('come')
    friend.bot.chat('zinc vem aqui')
    if (h.immediateReply) {
      const answered = await until(() => friend.heardFrom(name, /já vou/i), 20_000)
      check(tag('answers "zinc vem aqui" in Portuguese, accents intact over the wire'), answered, answered ? '' : `heard: ${JSON.stringify(friend.heard.slice(-4))}`)
    } else {
      const started = await until(() => h.comeStarted(), 20_000)
      check(tag('uses the addressed chat event to start walking (no separate chat lane)'), started)
    }
    const arrived = await until(async () => {
      const a = await server.player(name); const b = await server.player('Gabriel')
      return a && b && dist(a.position, b.position) <= 3.5
    }, 40_000, 250)
    const a1 = await server.player(name); const b1 = await server.player('Gabriel')
    check(tag('walks to the player who called it'), arrived, `distance ${dist(a1.position, b1.position).toFixed(1)} (started 12.0)`)
    check(tag('says so when it arrives (the model is told the walk ended)'), await until(() => friend.heardFrom(name, /cheguei/i), 20_000), `heard: ${JSON.stringify(friend.heard.filter((l) => l.includes(name)))}`)
    check(tag('the model saw who spoke and where they stand'), prompts().some((p) => h.sawRequest.test(p)))
    log(`${name}: model calls while nothing happened: ${idleCalls}`)

    // -- scene 2: the friend punches it ------------------------------------
    h.phase('punched')
    await sleep(1000)
    const hpBefore = (await server.player(name)).health
    const landed = await punch(friend, name, 2, server)
    await sleep(400)
    const hpAfter = (await server.player(name)).health
    check(tag('(rig) the punches landed'), landed === 2 && hpAfter < hpBefore, `hp ${hpBefore} → ${hpAfter}`)
    const told = await until(() => prompts().find((p) => /hit by player Gabriel/.test(p)), 15_000)
    check(tag('tells the model WHO hit it'), Boolean(told), told ? (String(told).split('\n').find((l) => /hit by player Gabriel/.test(l)) || '').trim().slice(0, 110) : `last prompt: ${String(prompts().slice(-1)[0]).slice(0, 300)}`)
    const ranOff = await until(async () => {
      const a = await server.player(name); const b = await server.player('Gabriel')
      return dist(a.position, b.position) >= 8
    }, 12_000, 250)
    const a2 = await server.player(name); const b2 = await server.player('Gabriel')
    check(tag('backs away from the player who hit it'), ranOff, `distance ${dist(a2.position, b2.position).toFixed(1)}`)
    await sleep(3000)
    check(tag('does NOT hit back on its own'), (await server.player('Gabriel')).health === 20, `Gabriel hp ${(await server.player('Gabriel')).health}`)

    // -- scene 3: the model names the player → and only then PvP ------------
    h.phase('duel')
    await server.ask('heal', { name })
    friend.bot.chat('zinc, duelo! pode vir')
    const hitBack = await until(async () => (await server.player('Gabriel')).health < 20, 45_000, 250)
    check(tag('fights the player once the model names them (attack → exact name)'), hitBack, `Gabriel hp ${(await server.player('Gabriel')).health}`)
    h.phase('calm')
    friend.bot.chat('zinc para, chega')
    await sleep(6000)
    const hpStop = (await server.player('Gabriel')).health
    await sleep(4000)
    check(tag('stops when told to'), (await server.player('Gabriel')).health === hpStop, `Gabriel hp ${hpStop} → ${(await server.player('Gabriel')).health}`)
    await server.ask('heal', { name })
    await server.ask('heal', { name: 'Gabriel' })

    // -- scene 4: a zombie --------------------------------------------------
    // Let the "Gabriel hit me" memory (15 s) run out first.
    await server.ask('teleport', { name: 'Gabriel', x: 60.5, y: GROUND_Y, z: 60.5 })
    await server.ask('teleport', { name, x: 0.5, y: GROUND_Y, z: 0.5 })
    await sleep(17_000)
    const here = (await server.player(name)).position
    h.phase('zombie')
    const zombie = await server.ask('summon', { name: 'zombie', x: here.x + 5, y: GROUND_Y, z: here.z })
    const fled = await until(async () => {
      const a = await server.player(name); const z = await server.ask('entity', { id: zombie.id })
      return z.exists && dist(a.position, z.position) >= 11
    }, 15_000, 250)
    const a3 = await server.player(name); const z3 = await server.ask('entity', { id: zombie.id })
    check(tag('runs from a zombie that appears 5 blocks away'), fled, `distance ${z3.exists ? dist(a3.position, z3.position).toFixed(1) : '?'}`)
    const toldFleeing = await until(() => prompts().find((p) => h.toldFleeing.test(p)), 10_000)
    check(tag('tells the model it is fleeing, and from what'), Boolean(toldFleeing), toldFleeing ? (String(toldFleeing).split('\n').find((l) => /FLEEING/.test(l)) || '').trim().slice(0, 150) : `last prompt: ${String(prompts().slice(-1)[0]).slice(0, 400)}`)
    await sleep(2000)
    check(tag('does not touch the zombie without a decision'), (await server.ask('entity', { id: zombie.id })).health === 20, `zombie hp ${(await server.ask('entity', { id: zombie.id })).health}`)

    h.phase('kill')
    friend.bot.chat('zinc mata o zumbi')
    const killed = await until(async () => !(await server.ask('entity', { id: zombie.id })).exists, 70_000, 250)
    const z4 = await server.ask('entity', { id: zombie.id })
    check(tag('kills it once the model says attack zombie'), killed, killed ? '' : `zombie hp ${z4.health}`)
    check(tag('reports the outcome to the model'), Boolean(await until(() => prompts().find((p) => /zombie down/.test(p)), 15_000)))
    if (!killed) await server.ask('despawn', { id: zombie.id })

    check(tag('never crashed or dropped out'), !proc.exited(), proc.exited() ? JSON.stringify(proc.exited()) : '')
    const errors = proc.lines.filter((l) => /\[error\]|Unhandled|TypeError|ReferenceError/.test(l))
    check(tag('logged no errors'), errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300))
    // A flat world has no dead ends. (This rig caught the escape planner calling
    // the ground beside a player who keeps up "the only safe ground is a dead end".)
    const cornered = prompts().find((p) => /CORNERED|TRAPPED|SURROUNDED|STUCK/.test(p))
    check(tag('never tells the model it is cornered on flat, open ground'), !cornered, cornered ? (String(cornered).split('\n').find((l) => /CORNERED|TRAPPED|SURROUNDED|STUCK/.test(l)) || '').trim().slice(0, 150) : '')
    log(`${name}: model calls in total: ${prompts().length}`)
  } finally {
    await proc.stop()
    await sleep(1500)
  }
}

/** Harness B (ZincAI): chat lane + action lane, tools. */
function zincai (model) {
  let phase = 'idle'
  const saidArrived = { v: false }
  model.policy.chat = (p) => {
    const last = (p.match(/Gabriel says: (.*)/g) || []).pop() || ''
    if (/vem aqui/.test(last)) return { name: 'reply', args: { text: 'já vou!', task: 'go to Gabriel' } }
    if (/duelo/.test(last)) return { name: 'reply', args: { text: 'bora!', task: 'duel Gabriel (he asked for it)' } }
    if (/para, chega/.test(last)) return { name: 'reply', args: { text: 'beleza, parei', task: 'stop fighting' } }
    if (/mata o zumbi/.test(last)) return { name: 'reply', args: { text: 'deixa comigo', task: 'kill the zombie' } }
    return { name: 'reply', args: { text: '' } }
  }
  model.policy.act = (p) => {
    const why = (p.split('\n').find((l) => l.startsWith('why now:')) || '')
    if (phase === 'come') {
      if (/go_to done: reached Gabriel/.test(why) && !saidArrived.v) { saidArrived.v = true; return { name: 'say', args: { text: 'cheguei, e aí?' } } }
      if (/chat request from Gabriel: go to Gabriel/.test(why)) return { name: 'go_to', args: { player: 'Gabriel' } }
    }
    if (phase === 'duel' && /chat request from Gabriel: duel/.test(why)) return { name: 'attack', args: { player: 'Gabriel' } }
    if (phase === 'calm' && /chat request from Gabriel: stop/.test(why)) return { name: 'stop', args: {} }
    if (phase === 'kill' && /chat request from Gabriel: kill the zombie/.test(why)) return { name: 'attack', args: { target: 'zombie' } }
    return { name: 'idle', args: {} } // while threats are listed this means: keep fleeing
  }
  return {
    botName: 'ZincAI',
    entry: 'zincai/index.js',
    env: {},
    readyRe: /ZincAI ready/,
    sawRequest: /Gabriel says: zinc vem aqui/,
    toldFleeing: /reflex: FLEEING for \d+s from zombie/,
    prompts: (m, before) => [...m.prompts.chat.slice(before.chat), ...m.prompts.act.slice(before.act)],
    immediateReply: true,
    comeStarted: () => true,
    phase: (p) => { phase = p }
  }
}

/** Harness A (Zinc): one tiny prompt, one JSON action. */
function zinc (model) {
  let phase = 'idle'
  let saidArrived = false
  let saidComing = false
  model.policy.zinc = (p) => {
    if (phase === 'come') {
      const m = /"user":"Gabriel","msg":"zinc vem aqui","at":"(-?\d+),(-?\d+),(-?\d+)"/.exec(p)
      if (m && !saidComing) { saidComing = true; return { a: 'move', x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } }
      if (/"type":"move".*"ok":true/.test(p) && !saidArrived) { saidArrived = true; return { a: 'say', t: 'cheguei, e aí?' } }
    }
    if (phase === 'duel' && /duelo/.test(p) && !/"type":"attack","n":"Gabriel"/.test(p)) return { a: 'attack', n: 'Gabriel' }
    if (phase === 'calm' && /para, chega/.test(p)) return { a: 'move', x: 0, y: GROUND_Y, z: 0 } // walking away ends the fight
    if (phase === 'kill' && /mata o zumbi/.test(p) && !/"type":"attack","n":"zombie"/.test(p)) return { a: 'attack', n: 'zombie' }
    return { a: 'idle' }
  }
  return {
    botName: 'Zinc',
    entry: 'src/index.js',
    env: { MC_USERNAME: 'Zinc' },
    readyRe: /harness ready/,
    sawRequest: /"user":"Gabriel","msg":"zinc vem aqui","at":"-?\d+,-?\d+,-?\d+"/,
    toldFleeing: /threats 1 in sight — zombie[^\n]* — you are FLEEING by reflex/,
    prompts: (m, before) => m.prompts.zinc.slice(before.zinc),
    immediateReply: false,
    comeStarted: () => saidComing,
    phase: (p) => { phase = p }
  }
}

// ------------------------------------------------------------------ main ---
async function main () {
  const server = startServer()
  const cleanup = []
  let failed = false
  try {
    await server.ready
    log(`server up on 127.0.0.1:${MC_PORT} (flying-squid, Minecraft ${VERSION})`)
    const model = await startModel()
    cleanup.push(() => model.close())
    const friend = await joinFriend('Gabriel')
    cleanup.push(() => { try { friend.bot.end() } catch { /* noop */ } })
    log('Gabriel (plain mineflayer client) is online')

    if (!ONLY || ONLY === 'zincai') await runScenes(zincai(model.model), { server, model: model.model, friend })
    if (!ONLY || ONLY === 'zinc') await runScenes(zinc(model.model), { server, model: model.model, friend })

    const keys = new Set(model.model.requests.map((r) => r.auth))
    check('the harnesses only ever sent the dummy key to the local endpoint', keys.size <= 1 && (keys.size === 0 || keys.has('Bearer rc-loopback')))
    const choices = [...new Set(model.model.requests.filter((r) => r.tools).map((r) => String(r.tool_choice)))]
    if (choices.length) log(`ZincAI tool_choice sent: ${choices.join(', ')}`)
  } catch (err) {
    failed = true
    log('rig error:', err && err.stack ? err.stack : err)
  } finally {
    for (const fn of cleanup.reverse()) { try { fn() } catch { /* noop */ } }
    server.stop()
  }
  const bad = checks.filter((c) => !c.ok)
  log(`${checks.length - bad.length}/${checks.length} checks passed${bad.length ? ` — FAILED: ${bad.map((c) => c.name).join('; ')}` : ''}`)
  setTimeout(() => process.exit(failed || bad.length ? 1 : 0), 800)
}

main()
