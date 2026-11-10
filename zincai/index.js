#!/usr/bin/env node
/**
 * ZincAI — dual-process Minecraft AI harness (Pufferpanel-ready).
 *
 *   System 1 (Node.js, NO LLM):  eating, dodging, doors, fall mitigation —
 *                                cheap reflexes, run on a 5 Hz tick.
 *   System 2 (AMD/Qwen):         deliberation only — planning, chat,
 *                                building, remote movement.
 *
 * Pufferpanel: plain ISO-timestamped log lines, zero ANSI colors,
 * graceful SIGINT/SIGTERM shutdown (saves memory, quits the bot, prints a
 * session summary). ./zincai-data/ holds runtime memory (gitignored).
 *
 * Username policy: the login name is ALWAYS "ZincAI" (hard rule, same class of
 * directive as the previous Zinc mandate). Any join rejection aborts the
 * process with exit code 1 — no retries, no renames.
 *
 * Usage:
 *   node zincai/index.js             start the bot
 *   node zincai/index.js --dry-run   validate config + prompt, no network
 *   node zincai/index.js --check     require-check every module, no bot
 *
 * Config: zincai/config.json (+ env overrides: MC_HOST, MC_PORT, MC_USERNAME,
 *   MC_VERSION, MC_AUTH, AMD_API_BASE_URL, AMD_MODEL, AMD_API_KEY/API_KEY,
 *   ZINC_DATA_DIR, LOG_LEVEL). AMD key resolution order: env -> config.json.
 */
'use strict'

const fs = require('fs')
const path = require('path')

// Load .env if present (local dev convenience). Real deployments (Pufferpanel)
// inject AMD_API_KEY/API_KEY as secret environment variables — those win,
// because dotenv never overrides variables that are already set.
require('dotenv').config()

const ROOT = path.join(__dirname, '..')
const ZINC_DIR = __dirname
const DATA_DIR = process.env.ZINC_DATA_DIR || path.join(ROOT, 'zincai-data')
const SYSTEM_PROMPT = fs.readFileSync(path.join(ZINC_DIR, 'system_prompt.txt'), 'utf8').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------- logging--
// logger.js is plain text with ISO timestamps — Pufferpanel-safe by design.
const logger = require('../src/logger')
const TAG = 'zincai'

// ============================================================ config ====
function loadConfig () {
  const file = path.join(ZINC_DIR, 'config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const str = (envName, fallback) => (process.env[envName] !== undefined && process.env[envName] !== '' ? process.env[envName] : fallback)
  const int = (envName, fallback) => {
    const v = Number(process.env[envName])
    return Number.isFinite(v) && process.env[envName] !== '' ? Math.trunc(v) : fallback
  }
  const bool = (envName, fallback) => {
    const v = process.env[envName]
    if (v === undefined || v === '') return fallback
    return /^(1|true|yes|on)$/i.test(v.trim())
  }
  const cfg = {
    server: {
      host: str('MC_HOST', raw.server.host),
      port: int('MC_PORT', raw.server.port),
      // HARD RULE: always ZincAI, no matter what config/env says.
      username: 'ZincAI',
      auth: str('MC_AUTH', raw.server.auth || 'offline'),
      version: str('MC_VERSION', raw.server.version || '') || false
    },
    amd: {
      apiKey: process.env.AMD_API_KEY || process.env.API_KEY || process.env.RADEON_API_KEY || raw.amd.apiKey || null,
      baseUrl: str('AMD_API_BASE_URL', raw.amd.baseUrl).replace(/\/+$/, ''),
      model: str('AMD_MODEL', raw.amd.model),
      maxTokens: raw.amd.maxTokens ?? 96,
      temperature: raw.amd.temperature ?? 0.25,
      timeoutMs: raw.amd.timeoutMs ?? 20_000,
      maxRetries: raw.amd.maxRetries ?? 2
    },
    inference: raw.inference,
    memory: raw.memory,
    behavior: raw.behavior,
    build: raw.build,
    system1: raw.system1
  }
  return cfg
}

function validateConfig (cfg) {
  const errors = []
  if (!cfg.amd.apiKey) errors.push('AMD API key missing — set AMD_API_KEY (or API_KEY) in the environment, or amd.apiKey in zincai/config.json')
  if (!['offline', 'microsoft'].includes(cfg.server.auth)) errors.push('server.auth must be "offline" or "microsoft"')
  if (!Number.isFinite(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) errors.push('server.port out of range')
  try { new URL(cfg.amd.baseUrl) } catch { errors.push('amd.baseUrl is not a valid URL') }
  return errors
}

// ============================================================ boot ====
function main () {
  if (process.argv.includes('--check')) {
    require('./memory'); require('./perception'); require('./filter'); require('./builder'); require('./custom_mineflayer/pathfinder_wrapper')
    require('minecraft-data')('26.3') // postinstall patch must be in place
    logger.info(TAG, '--check OK — all modules load, 26.3 data present')
    return
  }

  const cfg = loadConfig()

  if (process.argv.includes('--dry-run')) {
    const errors = validateConfig(cfg)
    logger.info(TAG, `config: host=${cfg.server.host} port=${cfg.server.port} user=${cfg.server.username} auth=${cfg.server.auth} version=${cfg.server.version || 'auto'}`)
    logger.info(TAG, `amd: model=${cfg.amd.model} base=${cfg.amd.baseUrl} key=${cfg.amd.apiKey ? 'present' : 'MISSING'}`)
    logger.info(TAG, `system prompt: ${SYSTEM_PROMPT.split(/\s+/).length} words (static)`)
    for (const e of errors) logger.error(TAG, e)
    process.exitCode = errors.length ? 1 : 0
    return
  }

  const bootErrors = validateConfig(cfg)
  if (bootErrors.length) {
    for (const e of bootErrors) logger.error(TAG, e)
    process.exit(1)
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })

  const mineflayer = require('mineflayer')
  const { pathfinder, goals } = require('mineflayer-pathfinder')
  const { Vec3 } = require('vec3')
  const armorManager = require('mineflayer-armor-manager')

  const { MemorySystem } = require('./memory')
  const { buildPerceptionText } = require('./perception')
  const filter = require('./filter')
  const { BlueprintParser, BuilderExecutor } = require('./builder')
  const { PathfinderWrapper } = require('./custom_mineflayer/pathfinder_wrapper')
  const { AdvancedCombat } = require('../src/combat')
  const { craftItem } = require('../src/recipes')
  const { AmdClient } = require('../src/amdClient')

  const memoryFile = path.join(DATA_DIR, cfg.memory.file.replace(/^zincai-data[/\\]/, ''))
  const memory = new MemorySystem({
    file: memoryFile,
    workingMax: cfg.memory.workingMax,
    shortTermMinutes: cfg.memory.shortTermMinutes
  })
  const amd = new AmdClient({
    apiKey: cfg.amd.apiKey,
    baseUrl: cfg.amd.baseUrl,
    model: cfg.amd.model,
    timeoutMs: cfg.amd.timeoutMs,
    maxRetries: cfg.amd.maxRetries,
    temperature: cfg.amd.temperature,
    maxTokens: cfg.amd.maxTokens
  })

  const parser = new BlueprintParser({ scaffoldBlocks: cfg.build.scaffoldBlocks, reach: cfg.build.reach })
  let executor = null // created after spawn (needs bot)
  const wrapperLog = (level, msg) => logger[level === 'debug' ? 'debug' : level]?.(TAG, msg)

  // ---------------------------------------------------- bot lifecycle ----
  logger.info(TAG, `connecting to ${cfg.server.host}:${cfg.server.port} as "${cfg.server.username}" (auth=${cfg.server.auth}, version=${cfg.server.version || 'auto'})`)
  const bot = mineflayer.createBot({
    host: cfg.server.host,
    port: cfg.server.port,
    username: cfg.server.username, // always ZincAI — enforced in loadConfig()
    version: cfg.server.version || false,
    auth: cfg.server.auth,
    checkTimeoutInterval: 30_000
  })
  bot.loadPlugin(pathfinder)
  if (cfg.behavior.useArmorManager) bot.loadPlugin(armorManager)

  // Upstream-compatible custom pathfinding: doors, jitter, digging guard.
  const wrapper = new PathfinderWrapper(bot, {
    allowDigging: Boolean(cfg.behavior.allowDigging),
    logger: wrapperLog
  })

  let system1Timer = null // assigned below; shutdown may run before that (join failure)
  let started = false
  let shuttingDown = false
  let inferBusy = false
  let lastInfer = 0
  let idleStreak = 0
  let selfChain = 0
  let combat = null
  let lastEatAt = 0
  let lastSayAt = 0
  let moveGoalTimer = null

  function gracefulShutdown (code, reason) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(TAG, `shutting down (${reason})`)
    clearInterval(system1Timer)
    clearTimeout(moveGoalTimer)
    try { wrapper.stop() } catch { /* noop */ }
    try { combat?.stop() } catch { /* noop */ }
    memory.save()
    const s = amd.getStats()
    const hit = s.kvCacheHitRate === null ? 'n/a' : `${(s.kvCacheHitRate * 100).toFixed(1)}%`
    logger.info(TAG, `amd session: ${s.requests} calls, ${s.failures} failures, avg prompt ${s.avgPromptTokensPerCall} tok, cached ${s.cachedTokens} tok, kv-hit-rate ${hit}`)
    logger.info(TAG, `memory: long-term ${memory.longTerm.entries.length} entries saved to ${memoryFile}`)
    try { bot.quit() } catch { /* already gone */ }
    // Hard-exit safety net: the process must die with `code` even if the
    // socket never closes (join failure before spawn, etc.).
    setTimeout(() => process.exit(code), 1_000)
  }

  function fatalJoinFailure (kind, detail) {
    if (shuttingDown) return
    const text = detail && detail.message ? detail.message : typeof detail === 'object' ? JSON.stringify(detail).slice(0, 200) : String(detail)
    logger.error(TAG, `FATAL: join rejected (${kind}): ${text}`)
    logger.error(TAG, 'aborting. Check the ply.gg tunnel, the whitelist (name "ZincAI"), and MC_AUTH.')
    gracefulShutdown(1, 'join-failed')
  }

  // ------------------------------------------------- event wiring --------
  bot.on('login', () => logger.info(TAG, `logged in as ${bot.username}`))
  bot.on('kicked', (reason) => { if (!started) fatalJoinFailure('kicked', reason); else gracefulShutdown(1, 'kicked') })
  bot.on('error', (err) => { if (!started) fatalJoinFailure('error', err); else logger.error(TAG, `socket error: ${err.message || err}`) })
  bot.on('end', (reason) => { if (!started) fatalJoinFailure('end', reason); else gracefulShutdown(0, 'server-ended') })

  bot.on('spawn', () => {
    started = true
    logger.info(TAG, `spawn OK — model=${cfg.amd.model}`)

    // Pathfinder movements (custom wrapper applied after construction).
    const { Movements } = require('mineflayer-pathfinder')
    const movements = new Movements(bot)
    movements.canDig = Boolean(cfg.behavior.allowDigging)
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)
    wrapper.apply() // patches this movements instance + prototype hooks

    combat = new AdvancedCombat(bot, {
      maxHealth: 20,
      disengageHealthFraction: 0.3,
      onEvent: (evt) => memory.addEvent({ type: 'combat', msg: evt.msg || 'combat event', ...evt })
    })
    combat.start()
    executor = new BuilderExecutor(bot, { scaffoldBlocks: cfg.build.scaffoldBlocks, logger: wrapperLog })

    try { bot.armorManager?.equipAll?.() } catch { /* cosmetic */ }
    logger.info(TAG, 'ZincAI ready — System 1 on reflex, System 2 on demand')
  })

  bot.on('death', () => {
    memory.addEvent({ type: 'death', msg: 'I died' }, { promote: true })
    setTimeout(() => { try { bot.respawn() } catch { /* not on death screen */ } }, 1500)
  })

  bot.on('messagestr', (raw) => {
    const parsed = filter.parseChatLine(raw)
    if (!parsed) return // server line, not attributed chat
    if (parsed.sender === bot.username) return // never react to ourselves
    const friends = cfg.behavior.friends || []
    const trigger = filter.chatTriggersSystem2(parsed.text, parsed.sender, friends)
    logger.debug(TAG, `chat from ${parsed.sender}: ${parsed.text} (${trigger ? 'System 2' : 'ignored'})`)
    if (trigger) queueSystem2({ type: 'chat', sender: parsed.sender, text: parsed.text })
  })

  bot.on('entityHurt', (entity) => {
    // Bot itself hurt => high priority; a nearby fight worth a look.
    if (entity === bot.entity) {
      memory.addEvent({ type: 'hurt', msg: 'I was hit' })
      queueSystem2({ type: 'hurt', msg: 'I was just attacked' })
    }
  })

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!started) return
    if (filter.blockEventTriggersSystem2(newBlock, bot, 20)) {
      queueSystem2({ type: 'block', msg: `block change near me: ${oldBlock?.name}->${newBlock?.name}` })
    }
  })

  // ---------------------------------------------------- System 1 --------
  const FOOD_RE = /(bread|apple|potato|carrot|beef|porkchop|chicken|mutton|salmon|cod|berries|cookie|melon_slice|cooked_|golden_carrot|steak|stew|mushroom_stew|beetroot)/
  // hoist: shutdown clears this timer; assignment happens right here at boot
  system1Timer = setInterval(() => {
    if (!started || shuttingDown) return
    try {
      // 1) hunger — eat the best food on hand
      if (bot.food < cfg.system1.eatBelowFood && Date.now() - lastEatAt > 8_000) {
        const food = bot.inventory.items().find((i) => FOOD_RE.test(i.name))
        if (food) {
          lastEatAt = Date.now()
          bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {})
        }
      }
      // 2) immediate danger dodge — hostile inside 2 blocks: jump + back away
      for (const e of Object.values(bot.entities || {})) {
        if (!e?.position || e === bot.entity) continue
        const hostile = /zombie|skeleton|creeper|spider|drowned|husk|witch|blaze|phantom/i.test(e.name || '')
        if (!hostile) continue
        const d = e.position.distanceTo(bot.entity.position)
        if (d < 2.0) {
          bot.setControlState('back', true)
          bot.setControlState('jump', true)
          setTimeout(() => { try { bot.setControlState('back', false); bot.setControlState('jump', false) } catch { /* gone */ } }, 500)
          break
        }
      }
      // 3) fall mitigation — water bucket if we're dropping fast
      const vy = bot.entity?.velocity?.y ?? 0
      if (vy < cfg.system1.fallVelocityThreshold) {
        const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket')
        if (bucket) {
          bot.equip(bucket, 'hand').then(() => bot.activateItem()).catch(() => {})
        }
      }
    } catch (err) {
      logger.debug(TAG, `system1 tick: ${err.message || err}`)
    }
  }, 200)

  // ---------------------------------------------------- System 2 --------
  function queueSystem2 (evt) {
    memory.addEvent(evt)
    // The actual inference runs on the shared gate; events just accumulate in
    // the working memory delta — one call sees everything new.
    maybeInfer().catch(() => {})
  }

  async function buildDeltaText (query) {
    const vitals = `hp=${Math.round(bot.health ?? 0)} food=${bot.food ?? 0}`
    const p = bot.entity?.position
    const pos = p ? `pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'pos=?'
    const tod = bot.time ? (bot.time.timeOfDay < 12000 ? 'day' : 'night') : '?'
    const perception = buildPerceptionText(bot, { range: cfg.behavior.perceptionRange, fovDegrees: cfg.behavior.fovDegrees })
    const working = memory.working.last(5).map((e) => `- ${e.type}${e.sender ? ':' + e.sender : ''}: ${e.text || e.msg || ''}`).join('\n') || '- (none)'
    const recalled = memory.promptBlock(query || '', cfg.memory.topK)
    return [
      `vitals ${vitals} ${pos} tod=${tod}`,
      recalled ? `memories:\n${recalled}` : null,
      `events:\n${working}`,
      `perception:\n${perception}`
    ].filter(Boolean).join('\n')
  }

  async function maybeInfer () {
    if (shuttingDown || !started || inferBusy) return
    const now = Date.now()
    if (now - lastInfer < cfg.inference.minIntervalMs) return
    const idleWait = idleStreak > 0 ? Math.min(60_000, cfg.inference.idleIntervalMs * idleStreak) : 0
    if (idleWait && now - lastInfer < idleWait) return
    if (selfChain >= cfg.inference.maxSelfChain) { selfChain = 0; await sleep(1500); return }

    inferBusy = true
    lastInfer = now
    try {
      const query = memory.working.last(1)[0]?.text || memory.working.last(1)[0]?.msg || ''
      const delta = await buildDeltaText(query)
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: delta }
      ]
      const { content } = await amd.chatCompletion(messages)
      const action = parseActionLine(content)
      selfChain = action.a === 'idle' ? 0 : selfChain + 1
      idleStreak = action.a === 'idle' ? idleStreak + 1 : 0
      await executeAction(action)
    } catch (err) {
      logger.error(TAG, `system2 failed: ${err.message || err}`)
      idleStreak += 1
    } finally {
      inferBusy = false
    }
  }

  /** Strict single-line JSON parse with a markdown-fence recovery. */
  function parseActionLine (raw) {
    let s = String(raw || '').trim()
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
    if (fence) s = fence[1].trim()
    const line = s.split('\n').find((l) => l.trim().startsWith('{')) || s
    try {
      const obj = JSON.parse(line.trim())
      if (obj && typeof obj === 'object' && typeof obj.a === 'string') return obj
    } catch { /* fall through */ }
    logger.warn(TAG, `unparseable action from model: ${s.slice(0, 120)}`)
    return { a: 'idle' }
  }

  async function executeAction (action) {
    switch (action.a) {
      case 'idle':
        return
      case 'say': {
        const t = String(action.t || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!t) return
        if (Date.now() - lastSayAt < cfg.behavior.chatCooldownMs) return logger.debug(TAG, 'say dropped by cooldown')
        lastSayAt = Date.now()
        try { bot.chat(t); memory.addEvent({ type: 'chat', msg: `I said: ${t}` }) } catch { /* chat gamemode */ }
        return
      }
      case 'move': {
        const x = Number(action.x); const y = Number(action.y); const z = Number(action.z)
        if (![x, y, z].every(Number.isFinite)) return logger.warn(TAG, 'move: bad coordinates')
        bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1), true)
        clearTimeout(moveGoalTimer)
        moveGoalTimer = setTimeout(() => { try { bot.pathfinder.setGoal(null) } catch { /* noop */ } }, 45_000)
        memory.addEvent({ type: 'move', msg: `moving to ${x},${y},${z}` })
        return
      }
      case 'build': {
        if (!executor) return logger.warn(TAG, 'build: not ready yet')
        try {
          let planned
          if (action.blueprint) {
            planned = parser.load(String(action.blueprint))
          } else if (Array.isArray(action.grid)) {
            planned = parser.parseInline(action)
          } else {
            return logger.warn(TAG, 'build: need blueprint name or inline grid')
          }
          const origin = bot.entity.position.floored()
          const preflight = parser.checkInventory(planned.blocks, bot.inventory.items())
          if (!preflight.ok) {
            const missing = preflight.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')
            logger.warn(TAG, `build: missing materials — ${missing}`)
            memory.addEvent({ type: 'build_failed', msg: `cannot build ${planned.name}: missing ${missing}` })
            return
          }
          const plan = parser.plan(planned, origin, bot.entity.position)
          logger.info(TAG, `building ${planned.name} — ${plan.steps.length} blocks (tower ${plan.towerNeeded ? plan.towerHeight + ' high' : 'not needed'})`)
          const result = await executor.build(plan)
          const summary = `build ${planned.name}: placed ${result.placed}/${plan.steps.length}${result.skipped.length ? ' skipped ' + result.skipped.length : ''}`
          logger.info(TAG, summary)
          memory.addEvent({ type: 'build_complete', msg: summary }, { promote: true })
        } catch (err) {
          logger.error(TAG, `build failed: ${err.message || err}`)
          memory.addEvent({ type: 'build_failed', msg: `build error: ${err.message || err}` })
        }
        return
      }
      case 'craft': {
        const item = String(action.i || '')
        if (!item) return
        const r = await craftItem(bot, item)
        logger.info(TAG, `craft ${item}: ${r.ok ? 'ok' : 'failed — ' + (r.why || 'unknown')}`)
        memory.addEvent({ type: 'crafted', msg: r.ok ? `crafted ${item}` : `craft ${item} failed: ${r.why || ''}` })
        return
      }
      case 'attack': {
        const name = String(action.n || '').toLowerCase()
        if (combat && name) {
          const r = await combat.engage(name)
          logger.info(TAG, `attack ${name}: ${r?.ok ? 'engaging' : (r?.why || 'failed')}`)
        }
        return
      }
      case 'equip': {
        const s = Math.trunc(Number(action.s))
        if (!Number.isFinite(s)) return
        const items = bot.inventory.items()
        const item = items[Math.max(0, Math.min(items.length - 1, s))]
        if (item) await bot.equip(item, 'hand').catch(() => {})
        return
      }
      default:
        logger.warn(TAG, `unknown action "${action.a}" — ignoring`)
    }
  }

  // ------------------------------------------------- signals -------------
  process.on('SIGINT', () => gracefulShutdown(0, 'SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown(0, 'SIGTERM'))
  process.on('unhandledRejection', (err) => logger.error(TAG, `unhandled rejection: ${err?.message || err}`))
  process.on('exit', (code) => { try { memory.save() } catch { /* best effort */ }; if (code !== 0) logger.error(TAG, `exit code ${code}`) })
}

main()
