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
 * VANILLA CONTRACT: 100% vanilla client. No RCON, no server console, no /tp,
 * no /setworldspawn, no cheats. The action surface is exactly what a player
 * can do: setControlState, attack, placeBlock/dig, activateItem, equip, and
 * the A* pathfinder. vanilla_guard.js enforces this at runtime (slash-shaped
 * chat is dropped; command-shaped actions are refused) and the startup
 * "Scout & Relocate" routine establishes bot.spawnPoint organically by
 * walking, never by asking the server to move us.
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
// System-2 action contract — native OpenAI-compatible tool schemas.
const { AmdToolsClient, createZincTools } = require('./api_wrapper')
const ZINC_TOOLS = createZincTools()

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
    system1: raw.system1,
    combat: raw.combat || {},
    threat: raw.threat || {},
    traversal: raw.traversal || {},
    scout: raw.scout || {}
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
    require('./api_wrapper'); require('./memory'); require('./perception'); require('./filter'); require('./builder'); require('./custom_mineflayer/pathfinder_wrapper'); require('./system1'); require('./reflex_registry'); require('./vanilla_guard')
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
  const { buildPerceptionText, buildVisionBlock, buildSemanticHints } = require('./perception')
  const filter = require('./filter')
  const { BlueprintParser, BuilderExecutor, generateShape, normalizeStage } = require('./builder')
  const { PathfinderWrapper, scoutSafeAnchor } = require('./custom_mineflayer/pathfinder_wrapper')
  const { installVanillaGuard, assertVanillaAction } = require('./vanilla_guard')
  const { System1 } = require('./system1')
  const { ReflexRegistry } = require('./reflex_registry')
  const { runScript } = require('./reflex_registry')
  const { AdvancedCombat } = require('../src/combat')
  const { craftItem } = require('../src/recipes')

  const memoryFile = path.join(DATA_DIR, cfg.memory.file.replace(/^zincai-data[/\\]/, ''))
  const preferencesFile = path.join(DATA_DIR, (cfg.memory.preferencesFile || 'zincai-data/preferences.json').replace(/^zincai-data[/\\]/, ''))
  const memory = new MemorySystem({
    file: memoryFile,
    preferencesFile,
    workingMax: cfg.memory.workingMax,
    shortTermMinutes: cfg.memory.shortTermMinutes,
    ephemeralMs: cfg.memory.ephemeralMs ?? 30_000
  })
  const amd = new AmdToolsClient({
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
  // Runtime vanilla invariant: no slash-command can ever leave this process.
  installVanillaGuard(bot, { logger })
  bot.loadPlugin(pathfinder)
  if (cfg.behavior.useArmorManager) bot.loadPlugin(armorManager)
  if (cfg.behavior.pvpEnabled) {
    try {
      bot.loadPlugin(require('mineflayer-pvp').plugin)
      logger.info(TAG, 'pvp reflex: mineflayer-pvp loaded')
    } catch (err) {
      logger.error(TAG, `mineflayer-pvp failed to load (${err.message || err}) — PvP reflex disabled`)
      cfg.behavior.pvpEnabled = false
    }
  }

  // Upstream-compatible custom pathfinding: doors, jitter, digging guard,
  // predictive threat map, wind-charge traversal.
  const wrapper = new PathfinderWrapper(bot, {
    allowDigging: Boolean(cfg.behavior.allowDigging),
    logger: wrapperLog,
    fleeRadius: cfg.behavior.fleeRadius ?? 8,
    threat: {
      ...(cfg.threat || {}),
      // In PvP-enabled runs, hostile players belong on the threat field too.
      includePlayers: (cfg.threat?.includePlayers ?? cfg.behavior.pvpEnabled) === true
    },
    enableWindCharge: cfg.traversal?.windCharge !== false,
    windCharge: cfg.traversal || {}
  })

  let system1 = null
  const reflexRegistry = new ReflexRegistry()
  let started = false
  let lastQueryText = ''
  let shuttingDown = false
  let inferBusy = false
  let lastInfer = 0
  let idleStreak = 0
  let selfChain = 0
  let combat = null
  let lastEatAt = 0
  let lastSayAt = 0
  let moveGoalTimer = null
  let anchor = null // organic spawn anchor chosen by Scout & Relocate (local only)
  let scouting = false
  let deathPoint = null
  let systemsReady = false // spawn fires again on respawn — build the stack once
  let lastScoutAt = 0

  function gracefulShutdown (code, reason) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(TAG, `shutting down (${reason})`)
    try { system1?.stop() } catch { /* noop */ }
    clearTimeout(moveGoalTimer)
    try { wrapper.stop() } catch { /* noop */ }
    try { combat?.stop() } catch { /* noop */ }
    memory.save()
    const s = amd.getStats()
    const hit = s.kvCacheHitRate === null ? 'n/a' : `${(s.kvCacheHitRate * 100).toFixed(1)}%`
    logger.info(TAG, `amd session: ${s.requests} calls, ${s.failures} failures, avg prompt ${s.avgPromptTokensPerCall} tok, cached ${s.cachedTokens} tok, kv-hit-rate ${hit}, tools ${s.toolCalls}${s.jsonFallbacks ? ` (json-fallback ${s.jsonFallbacks})` : ''}`)
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

  // ------------------------------------------- Scout & Relocate (vanilla) --
  /**
   * No /tp, no /setworldspawn. The bot evaluates its 30x30 surroundings,
   * scores candidate cells by projected threat + hazards + openness, picks the
   * best vector-away anchor, walks there with the A* pathfinder, and adopts it
   * as its local `bot.spawnPoint` (a JS anchor, never a server command).
   */
  async function scoutAndRelocate ({ reason = 'startup' } = {}) {
    if (scouting || shuttingDown) return null
    // mineflayer emits both 'spawn' and 'respawn' after death; one scout is enough.
    if (reason !== 'startup' && Date.now() - lastScoutAt < 5000) return null
    scouting = true
    lastScoutAt = Date.now()
    const sc = cfg.scout || {}
    try {
      if (!bot.entity?.position) return null
      // Wait (bounded) for chunks around spawn so blockAt() is real, not void.
      const waitDeadline = Date.now() + (sc.waitForWorldMs ?? 6000)
      while (Date.now() < waitDeadline) {
        try {
          const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
          if (below && below.boundingBox === 'block') break
        } catch { /* chunk not loaded yet */ }
        await sleep(250)
      }

      wrapper.threat.sample(bot, true)
      const result = scoutSafeAnchor(bot, {
        radius: sc.radius ?? 15,
        step: sc.step ?? 3,
        minRadius: sc.minRadius ?? 5,
        preferRadius: sc.preferRadius ?? 12,
        horizonTicks: wrapper.threat.horizonTicks,
        // Never re-anchor where we just died.
        avoid: deathPoint ? [{ x: deathPoint.x, y: deathPoint.y, z: deathPoint.z, radius: sc.deathAvoidRadius ?? 12 }] : []
      })
      if (!result) {
        anchor = bot.entity.position.floored()
        bot.spawnPoint = anchor.clone ? anchor.clone() : anchor
        logger.warn(TAG, `scout ${reason}: no candidate — holding current position`)
        return null
      }
      const { Vec3 } = require('vec3')
      anchor = new Vec3(result.x, result.y, result.z)
      bot.spawnPoint = anchor // LOCAL anchor only — no server command involved
      const pos = bot.entity.position
      const dist = Math.hypot(result.x - pos.x, result.y - pos.y, result.z - pos.z)
      logger.info(TAG, `scout ${reason}: anchor ${result.x},${result.y},${result.z} score=${result.score} threats=${result.threats} dist=${dist.toFixed(1)} (${result.reasons.join(', ')})`)
      memory.addEvent({ type: 'scout', msg: `anchor ${result.x},${result.y},${result.z} (${result.reasons.join(', ')})` }, { promote: true })

      if (dist > (sc.relocateAboveBlocks ?? 6)) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(result.x, result.y, result.z, 2), true)
          const moveDeadline = Date.now() + (sc.relocateTimeoutMs ?? 25_000)
          while (!shuttingDown && Date.now() < moveDeadline) {
            if (!bot.entity?.position) break
            if (bot.entity.position.distanceTo(anchor) <= 3.5) break
            await sleep(250)
          }
          try { bot.pathfinder.setGoal(null) } catch { /* noop */ }
        } catch (err) {
          logger.warn(TAG, `scout walk interrupted: ${err.message || err}`)
        }
      }
      // Arrival re-anchor: standing spot is ground truth (path may stop short).
      if (bot.entity?.position) {
        const arrived = bot.entity.position.floored()
        if (result.reasons.includes('no nearby threats')) {
          anchor = arrived
          bot.spawnPoint = arrived
        }
      }
      return result
    } finally {
      scouting = false
      maybeInfer().catch(() => {})
    }
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
    wrapper.apply() // idempotent: first call patches + starts timers

    if (systemsReady) {
      // Respawn: same bot object, same reflex stack. Reset combat state only.
      logger.info(TAG, 'respawn — reflex stack reused, combat state reset')
      try { combat?.stop() } catch { /* noop */ }
      try { combat?.start() } catch { /* noop */ }
      scoutAndRelocate({ reason: 'respawn' }).catch((err) => logger.warn(TAG, `scout failed: ${err.message || err}`))
      return
    }
    systemsReady = true

    combat = new AdvancedCombat(bot, {
      maxHealth: bot.health ?? 20,
      disengageHealthFraction: cfg.combat?.disengageHealthFraction ?? 0.3,
      critThreshold: cfg.combat?.critThreshold ?? 0.85,
      recoveryMs: cfg.combat?.recoveryMs ?? 220,
      attackCooldownMs: cfg.combat?.attackCooldownMs ?? 600,
      engageRadius: cfg.behavior.engageRadius ?? 24,
      threatMap: wrapper.threat,
      onEvent: (evt) => memory.addEvent({ type: 'combat', msg: evt.msg || 'combat event', ...evt })
    })
    combat.start()
    executor = new BuilderExecutor(bot, { scaffoldBlocks: cfg.build.scaffoldBlocks, logger: wrapperLog })

    // Mode state machine (builder|hunter|explorer) — affects sprint/jitter/drop-guard
    const mode = wrapper.setMode(cfg.behavior.mode || 'explorer')
    logger.info(TAG, `movement mode: ${mode}`)

    // System 1 — reflex registry-driven survival layer
    system1 = new System1(bot, {
      registry: reflexRegistry,
      logger,
      pathfinder: wrapper,
      memory,
      combat,
      eatBelowFood: cfg.system1.eatBelowFood ?? 18,
      fallVelocityThreshold: cfg.system1.fallVelocityThreshold ?? -0.35,
      tickMs: cfg.system1.tickMs ?? 200,
      pvpEnabled: cfg.behavior.pvpEnabled === true,
      pvpRange: cfg.behavior.pvpRange ?? 15,
      autoElytra: cfg.behavior.autoElytra !== false,
      escalate: (event) => queueSystem2({ type: 'escalation', text: `${event.type} ${event.item || event.text || ''}`.trim(), msg: `${event.type} escalated by reflex` })
    })
    system1.start()

    try { bot.armorManager?.equipAll?.() } catch { /* cosmetic */ }
    logger.info(TAG, 'ZincAI ready — System 1 on reflex, System 2 on demand')

    // Vanilla survival bootstrap: find an organic safe anchor and walk there.
    // Not awaited — reflexes stay live while the scout decides.
    scoutAndRelocate({ reason: 'startup' }).catch((err) => logger.warn(TAG, `scout failed: ${err.message || err}`))
  })

  bot.on('entityHurt', (entity) => {
    if (entity === bot.entity) {
      memory.addEvent({ type: 'hurt', msg: 'I was hit' })
      queueSystem2({ type: 'hurt', msg: 'I was just attacked' })
    }
    system1?.onEntityHurt(entity)
  })

  bot.on('playerCollect', (collector, item) => {
    if (!started || collector !== bot.entity) return
    const name = item?.name || 'item'
    memory.addEvent({ type: 'item_gained', msg: `collected ${name}` })
    system1?.onItemGained(name, null)
  })

  bot.on('death', () => {
    memory.addEvent({ type: 'death', msg: 'I died' }, { promote: true })
    deathPoint = bot.entity?.position ? bot.entity.position.clone() : null
    anchor = null
    try { wrapper.threat.clear() } catch { /* noop */ }
    setTimeout(() => { try { bot.respawn() } catch { /* not on death screen */ } }, 1500)
  })

  bot.on('respawn', () => {
    // New life, new anchor: re-scout away from the death point (no /tp, ever).
    logger.info(TAG, 'respawned — running Scout & Relocate')
    if (deathPoint) memory.addEvent({ type: 'death', msg: `died near ${Math.floor(deathPoint.x)},${Math.floor(deathPoint.y)},${Math.floor(deathPoint.z)}` })
    setTimeout(() => { scoutAndRelocate({ reason: 'respawn' }).catch(() => {}) }, 1200)
  })

  bot.on('vanilla_command_blocked', (line) => {
    logger.warn(TAG, `vanilla guard blocked: ${String(line).slice(0, 80)}`)
    memory.addEvent({ type: 'vanilla_guard', msg: 'blocked a command-shaped chat payload' })
  })

  bot.on('messagestr', (raw) => {
    const parsed = filter.parseChatLine(raw)
    if (!parsed) return // server line, not attributed chat
    if (parsed.sender === bot.username) return // never react to ourselves
    // Implicit preference tracking — silent, no tokens.
    const pref = memory.observeChat(parsed.sender, parsed.text)
    if (pref) logger.debug(TAG, `preference learned (${pref.polarity}): ${pref.text}`)
    system1?.onChatLine(parsed.sender, parsed.text)
    const friends = cfg.behavior.friends || []
    const trigger = filter.chatTriggersSystem2(parsed.text, parsed.sender, friends)
    logger.debug(TAG, `chat from ${parsed.sender}: ${parsed.text} (${trigger ? 'System 2' : 'ignored'})`)
    if (trigger) queueSystem2({ type: 'chat', sender: parsed.sender, text: parsed.text })
  })

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!started) return
    if (filter.blockEventTriggersSystem2(newBlock, bot, 20)) {
      queueSystem2({ type: 'block', msg: `block change near me: ${oldBlock?.name}->${newBlock?.name}` })
    }
  })

  // ---------------------------------------------------- System 2 --------
  function queueSystem2 (evt) {
    memory.addEvent(evt)
    if (evt && (evt.text || evt.msg)) lastQueryText = String(evt.text || evt.msg)
    // The actual inference runs on the shared gate; events just accumulate in
    // the working memory delta — one call sees everything new.
    maybeInfer().catch(() => {})
  }

  async function buildDeltaText (query) {
    const vitals = `hp=${Math.round(bot.health ?? 0)} food=${bot.food ?? 0}`
    const p = bot.entity?.position
    const pos = p ? `pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'pos=?'
    const tod = bot.time ? (bot.time.timeOfDay < 12000 ? 'day' : 'night') : '?'
    const mode = wrapper.mode || 'explorer'
    let perception = `vision (mode=${mode}):\n${buildVisionBlock(bot, { mode, range: 6, radius: 6, heightUp: 5, heightDown: 2 })}`
    if (cfg.behavior.perception3D) {
      perception += `\nvoxel grid:\n${buildPerceptionText(bot, { range: cfg.behavior.perceptionRange, fovDegrees: cfg.behavior.fovDegrees })}`
    }
    const sem = buildSemanticHints(bot, { radius: 8 })
    if (sem.zones.length) logger.debug(TAG, `avoid zones: ${sem.zones.map((z) => `${z.kind}@${z.x},${z.y},${z.z} x${z.count}`).join(' | ')}`)
    const justNow = memory.ephemeral.line()
    const working = memory.working.last(5).map((e) => `- ${e.type}${e.sender ? ':' + e.sender : ''}: ${e.text || e.msg || ''}`).join('\n') || '- (none)'
    const recalled = memory.recallBlock(query || '', cfg.memory.topK)
    const prefs = memory.preferencesLine()
    const threatLine = wrapper.threat?.summary?.() || 'threats: none'
    return [
      `vitals ${vitals} ${pos} tod=${tod} mode=${mode}`,
      `prediction: ${threatLine}`,
      prefs || null,
      recalled || null,
      justNow ? `just now: ${justNow}` : null,
      `events:\n${working}`,
      sem.text ? `semantics:\n${sem.text}` : null,
      `perception:\n${perception}`
    ].filter(Boolean).join('\n')
  }

  async function maybeInfer () {
    if (shuttingDown || !started || inferBusy) return
    if (scouting) return // let the scout establish the anchor before spending tokens
    const now = Date.now()
    if (now - lastInfer < cfg.inference.minIntervalMs) return
    const idleWait = idleStreak > 0 ? Math.min(60_000, cfg.inference.idleIntervalMs * idleStreak) : 0
    if (idleWait && now - lastInfer < idleWait) return
    if (selfChain >= cfg.inference.maxSelfChain) { selfChain = 0; await sleep(1500); return }

    inferBusy = true
    lastInfer = now
    try {
      const query = lastQueryText || memory.working.last(1)[0]?.text || memory.working.last(1)[0]?.msg || ''
      const delta = await buildDeltaText(query)
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: delta }
      ]
      const { action } = await amd.chatWithTools(messages, ZINC_TOOLS)
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


  /** Shared executor path for blueprint, inline grid and shape builds. */
  async function buildBlocks (blocks, label, stage, at) {
    let origin
    if (Array.isArray(at) && at.length >= 3 && at.every((v) => Number.isFinite(Number(v)))) {
      origin = new Vec3(Math.trunc(Number(at[0])), Math.trunc(Number(at[1])), Math.trunc(Number(at[2])))
    } else {
      origin = bot.entity.position.floored()
    }
    const preflight = parser.checkInventory(blocks, bot.inventory.items())
    if (!preflight.ok) {
      const missing = preflight.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')
      logger.warn(TAG, `${label}: missing materials — ${missing}`)
      memory.addEvent({ type: 'build_failed', msg: `cannot build ${label}${stage ? ' (' + stage + ')' : ''}: missing ${missing}` })
      return
    }
    const plan = parser.plan({ name: label, blocks }, origin, bot.entity.position)
    logger.info(TAG, `${label} — ${plan.steps.length} blocks${stage ? ` (stage ${stage})` : ''}${plan.towerNeeded ? `, tower ${plan.towerHeight} high` : ''}`)
    // Phase-scoped, idempotent execution: the LLM names a stage, the executor
    // only visits that stage's cells (foundation → walls → roof → detailing).
    const result = await executor.build(plan, { stage })
    let scaffoldNote = ''
    if (cfg.build.autoRemoveScaffold !== false) {
      try {
        const { removed } = await executor.removeScaffolds()
        if (removed > 0) scaffoldNote = `, scaffold cleared ${removed}`
      } catch (err) {
        logger.warn(TAG, `scaffold cleanup failed: ${err.message || err}`)
      }
    }
    const phaseTotal = stage && plan.phaseCounts ? plan.phaseCounts[stage] : plan.steps.length
    const summary = `build ${label}${stage ? ' (' + stage + ')' : ''}: placed ${result.placed}/${phaseTotal}${result.alreadyPresent ? `, ${result.alreadyPresent} already present` : ''}${result.skipped.length ? ' skipped ' + result.skipped.length : ''}${scaffoldNote}`
    logger.info(TAG, summary)
    memory.addEvent({ type: 'build_complete', msg: summary }, { promote: true })
  }

  async function executeAction (action) {
    const vanilla = assertVanillaAction(action)
    if (!vanilla.ok) {
      logger.warn(TAG, `refused non-vanilla action (${vanilla.why})`)
      memory.addEvent({ type: 'vanilla_guard', msg: `refused action: ${vanilla.why}` })
      return
    }
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
        // Threat-aware: reachable goal, but the route avoids projected kill zones.
        wrapper.pathTo(x, y, z, { range: 1 })
        clearTimeout(moveGoalTimer)
        moveGoalTimer = setTimeout(() => { try { bot.pathfinder.setGoal(null) } catch { /* noop */ } }, 45_000)
        memory.addEvent({ type: 'move', msg: `moving to ${x},${y},${z}` })
        return
      }
      case 'build': {
        if (!executor) return logger.warn(TAG, 'build: not ready yet')
        const stage = normalizeStage(action.stage)
        try {
          let planned
          if (action.blueprint) {
            planned = parser.load(String(action.blueprint))
          } else if (Array.isArray(action.grid)) {
            planned = parser.parseInline(action)
          } else {
            return logger.warn(TAG, 'build: need blueprint name or inline grid')
          }
          await buildBlocks(planned.blocks, String(action.blueprint || 'inline'), stage, action.at)
        } catch (err) {
          logger.error(TAG, `build failed: ${err.message || err}`)
          memory.addEvent({ type: 'build_failed', msg: `build error: ${err.message || err}` })
        }
        return
      }
      case 'build_shape': {
        if (!executor) return logger.warn(TAG, 'build_shape: not ready yet')
        const shape = String(action.shape || '')
        const block = String(action.block || '')
        const params = (action.params && typeof action.params === 'object') ? action.params : {}
        if (!shape || !block) return logger.warn(TAG, 'build_shape: need shape and block')
        const stage = normalizeStage(action.stage)
        try {
          const blocks = generateShape(shape, params, block)
          logger.info(TAG, `shape ${shape} -> ${blocks.length} blocks of ${block}`)
          await buildBlocks(blocks, `shape:${shape}`, stage, action.at)
        } catch (err) {
          logger.error(TAG, `build_shape failed: ${err.message || err}`)
          memory.addEvent({ type: 'build_failed', msg: `shape error: ${err.message || err}` })
        }
        return
      }
      case 'run_script': {
        const name = String(action.name || '')
        if (!name) return logger.warn(TAG, 'run_script: need a script name')
        try {
          const { goals } = require('mineflayer-pathfinder')
          const ctx = {
            bot, goals, memory, combat,
            pathfinder: wrapper,
            executor,
            escalate: (event) => queueSystem2({ type: 'escalation', text: `${event.type} ${event.item || event.text || ''}`.trim(), msg: `${event.type} escalated by script` }),
            system1,
            logger
          }
          const result = await runScript(name, {}, ctx)
          logger.info(TAG, `run_script ${name}: ${typeof result === 'string' ? result : JSON.stringify(result)}`)
          memory.addEvent({ type: 'script', msg: `script ${name}: ${typeof result === 'string' ? result : 'done'}` })
        } catch (err) {
          logger.error(TAG, `run_script failed: ${err.message || err}`)
        }
        return
      }
      case 'set_mode': {
        const mode = String(action.mode || '')
        const applied = wrapper.setMode(mode)
        cfg.behavior.mode = applied
        logger.info(TAG, `movement mode -> ${applied}`)
        memory.addEvent({ type: 'mode', msg: `mode ${applied}` })
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
