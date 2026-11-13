#!/usr/bin/env node
/**
 * ZincAI — dual-process Minecraft AI harness (Pufferpanel-ready).
 *
 *   System 1 (Node.js, NO LLM)   survival reflexes: FLEE from real threats,
 *                                eat, fall protection, swimming.
 *   System 2 (AMD/Qwen)          two lanes sharing one rate limit:
 *                                  chat lane   — answers people, fast
 *                                  action lane — one tool call per turn
 *
 * OWNER POLICY
 *   - The bot never starts a fight and never attacks a player by itself.
 *     Fighting (mobs or a duel) happens only when the model calls `attack`.
 *   - Its reflex toward every real threat is to flee until the model decides.
 *   - There is no friend list and no PvP switch.
 *
 * One ControlArbiter owns the movement keys, the pathfinder goal and the main
 * hand; reflexes, combat and tasks are lanes with fixed priorities
 * (survival > combat > task), so they can no longer cancel each other or
 * leave keys held.
 *
 * Pufferpanel: plain ISO-timestamped log lines, zero ANSI colors, graceful
 * SIGINT/SIGTERM shutdown (saves memory, quits the bot, prints a session
 * summary). ./zincai-data/ holds runtime memory (gitignored).
 *
 * Username policy: the login name is ALWAYS "ZincAI" (hard rule). A rejection
 * on the first join aborts the process with exit code 1 — no retries, no
 * renames. After a session that did spawn, a dropped link or a server restart
 * is retried with back-off under the same name.
 *
 * VANILLA CONTRACT: 100% vanilla client. No RCON, no server console, no /tp,
 * no cheats. vanilla_guard.js enforces it at runtime; the single exception is
 * a private message (/msg) built by the guard itself.
 *
 * Usage:
 *   node zincai/index.js             start the bot
 *   node zincai/index.js --dry-run   validate config + prompts, no network
 *   node zincai/index.js --check     require-check every module, no bot
 *
 * Config: zincai/config.json (+ env overrides: MC_HOST, MC_PORT, MC_VERSION,
 *   MC_AUTH, AMD_API_BASE_URL, AMD_MODEL, AMD_API_KEY/API_KEY, ZINC_DATA_DIR,
 *   LOG_LEVEL). AMD key resolution order: env -> config.json.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { performance } = require('node:perf_hooks')

// No .env and no dotenv: everything arrives as environment variables, which is
// exactly what a PufferPanel template's run.environmentVars becomes. Secrets
// (AMD_API_KEY / API_KEY / RADEON_API_KEY) are read only by src/settings.js
// and are never logged.
const settings = require('../src/settings')

const ROOT = path.join(__dirname, '..')
const ZINC_DIR = __dirname
const DATA_DIR = settings.str('ZINC_DATA_DIR', path.join(ROOT, 'zincai-data'))
const SYSTEM_PROMPT = fs.readFileSync(path.join(ZINC_DIR, 'system_prompt.txt'), 'utf8').trim()
const CHAT_PROMPT = fs.readFileSync(path.join(ZINC_DIR, 'chat_prompt.txt'), 'utf8').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { AmdToolsClient, createZincTools } = require('./api_wrapper')
const { FailGate } = require('./failgate')
const { ContinuityStore } = require('./continuity')
const { LaneScheduler, JobRegistry, laneOf, LANES } = require('./lanes')
const ZINC_TOOLS = createZincTools()

// logger.js is plain text with ISO timestamps — Pufferpanel-safe by design.
const logger = require('../src/logger')
const TAG = 'zincai'

const { decideReconnect, FATAL_KICK_RE } = require('../src/reconnect')

/** Why an attack request was refused, in words the model can act on. */
const ATTACK_WHY = {
  no_target: 'nothing of that kind in sight within range',
  player_not_in_sight: 'that player is not in sight (too far away or offline) — go_to them first',
  no_line_of_sight: 'that mob is behind bars or walls (caged or unreachable) — not attacking through them',
  protected: 'refused: that is a pet, a name-tagged mob, a villager or a golem',
  name_the_player: 'refused: to fight a player name them exactly in attack.player',
  disengage_cooldown: 'still recovering from the last fight (10 s)',
  low_hp: 'too hurt to fight — the body would break it off at once; get away and eat first',
  dead: 'I am dead',
  no_position: 'not spawned yet'
}

// ============================================================ config ====
function option (envName, configName, fallback, allowed) {
  return settings.option([envName, configName], fallback, allowed)
}

function loadConfig () {
  const file = path.join(ZINC_DIR, 'config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rejected = []
  const opt = (res) => { if (res.rejected) rejected.push(res.rejected); return res.value }

  const auth = opt(option('MC_AUTH', 'auth', raw.server.auth || 'offline', ['offline', 'microsoft']))
  const version = settings.str(['MC_VERSION', 'server.version'], raw.server.version || '')

  const cfg = {
    server: {
      // The server the bot joins. PufferPanel's MC_HOST may be an IP or a host
      // name (play.example.net); the port is the Minecraft port, not the panel's.
      host: settings.str(['MC_HOST', 'server.host'], raw.server.host),
      port: settings.int(['MC_PORT', 'server.port'], raw.server.port, { min: 1, max: 65535 }),
      // HARD RULE: always ZincAI, no matter what config/env says.
      username: 'ZincAI',
      auth,
      version: version || false
    },
    amd: {
      apiKey: settings.apiKey() || raw.amd.apiKey || null,
      baseUrl: settings.str(['AMD_API_BASE_URL', 'amd.baseUrl'], raw.amd.baseUrl).replace(/\/+$/, ''),
      model: settings.str(['AMD_MODEL', 'amd.model'], raw.amd.model),
      maxTokens: settings.int(['AMD_MAX_TOKENS', 'amd.maxTokens'], raw.amd.maxTokens ?? 256, { min: 16, max: 4096 }),
      temperature: settings.float(['AMD_TEMPERATURE', 'amd.temperature'], raw.amd.temperature ?? 0.25, { min: 0, max: 1.5 }),
      timeoutMs: settings.int(['AMD_API_TIMEOUT_MS', 'amd.timeoutMs'], raw.amd.timeoutMs ?? 20_000, { min: 1_000, max: 600_000 }),
      maxRetries: settings.int(['AMD_API_MAX_RETRIES', 'amd.maxRetries'], raw.amd.maxRetries ?? 2, { min: 0, max: 5 }),
      maxConcurrent: settings.int(['AMD_MAX_CONCURRENT', 'amd.maxConcurrent'], raw.amd.maxConcurrent ?? 2, { min: 1, max: 8 }),
      chatTimeoutMs: settings.int(['AMD_CHAT_TIMEOUT_MS', 'amd.chatTimeoutMs'], raw.amd.chatTimeoutMs ?? null, { min: 1_000, max: 600_000 }),
      chatMaxRetries: settings.int(['AMD_CHAT_MAX_RETRIES', 'amd.chatMaxRetries'], raw.amd.chatMaxRetries ?? 1, { min: 0, max: 5 })
    },
    inference: raw.inference || {},
    memory: raw.memory || {},
    trust: raw.trust || {},
    identity: raw.identity || {},
    behavior: raw.behavior || {},
    build: raw.build || {},
    system1: raw.system1 || {},
    combat: raw.combat || {},
    threat: raw.threat || {},
    traversal: raw.traversal || {},
    scout: raw.scout || {},
    reconnect: raw.reconnect || {},
    places: raw.places || {},
    goals: raw.goals || {}
  }

  // A handful of behaviour knobs are worth exposing to the panel without a
  // config.json edit; they win over the file only when actually set.
  const aliases = settings.str('BOT_ALIASES', null)
  if (aliases !== null) cfg.behavior.aliases = aliases.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)
  const language = settings.str('BOT_LANGUAGE', null)
  if (language !== null) cfg.behavior.language = language
  cfg.behavior.allowScaffolding = settings.bool('MC_ALLOW_SCAFFOLDING', cfg.behavior.allowScaffolding ?? false)
  cfg.behavior.autoElytra = settings.bool('MC_AUTO_ELYTRA', cfg.behavior.autoElytra ?? true)
  cfg.behavior.mode = settings.str('BOT_MODE', cfg.behavior.mode)
  cfg.inference.rpm = settings.int('INFERENCE_RPM', cfg.inference.rpm, { min: 1, max: 600 })
  cfg.inference.minIntervalMs = settings.int('INFERENCE_MIN_INTERVAL_MS', cfg.inference.minIntervalMs, { min: 0 })
  cfg.inference.heartbeatMs = settings.int('INFERENCE_HEARTBEAT_MS', cfg.inference.heartbeatMs, { min: 0 })
  cfg.reconnect.enabled = settings.bool('RECONNECT', cfg.reconnect.enabled ?? true)
  cfg.reconnect.maxAttempts = settings.int('RECONNECT_MAX_ATTEMPTS', cfg.reconnect.maxAttempts, { min: 1 })

  // Used by validateConfig() and the --dry-run summary; never logged with values.
  Object.defineProperty(cfg, '_rejectedOptions', { value: rejected, enumerable: false })
  return cfg
}

function validateConfig (cfg) {
  const errors = []
  if (!cfg.amd.apiKey) errors.push('AMD API key missing — set the template variable AMD_API_KEY (or API_KEY / RADEON_API_KEY) to an rc-... key')
  if (!cfg.server.host) errors.push('MC_HOST is empty — set it to the Minecraft server address')
  if (!['offline', 'microsoft'].includes(cfg.server.auth)) errors.push('MC_AUTH must be "offline" or "microsoft"')
  if (!Number.isFinite(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) errors.push('MC_PORT out of range (1-65535)')
  try { new URL(cfg.amd.baseUrl) } catch { errors.push('AMD_API_BASE_URL is not a valid URL') }
  for (const r of cfg._rejectedOptions || []) {
    errors.push(`${r.name}="${r.value}" is not one of: ${r.allowed.join(', ')}`)
  }
  return errors
}

/**
 * Everything that outlives a reconnect: memory, places, the model client,
 * conversations. One per process (tests build their own with a temp dir).
 */
function makeShared (cfg, { dataDir = DATA_DIR } = {}) {
  fs.mkdirSync(dataDir, { recursive: true })
  const { MemorySystem } = require('./memory')
  const { PlaceIndex } = require('./places')
  const { BlueprintParser } = require('./builder')
  const { GoalRegistry } = require('./goals')
  const at = (configured, fallback) => path.join(dataDir, String(configured || fallback).replace(/^zincai-data[/\\]/, ''))
  const memoryFile = at(cfg.memory.file, 'memories.json')
  const shared = {
    cfg,
    dataDir,
    memoryFile,
    memory: new MemorySystem({
      file: memoryFile,
      preferencesFile: at(cfg.memory.preferencesFile, 'preferences.json'),
      workingMax: cfg.memory.workingMax,
      shortTermMinutes: cfg.memory.shortTermMinutes,
      ephemeralMs: cfg.memory.ephemeralMs ?? 30_000
    }),
    places: new PlaceIndex({ file: at(cfg.places.file, 'places.json'), logger: (level, msg) => logger[level]?.(TAG, msg) }),
    // Durable objectives: the agenda below is session RAM, this is the record
    // that survives a context reset, a death and a restart (goals.js).
    goals: new GoalRegistry({
      file: at(cfg.goals?.file, 'goals.json'),
      logger: (level, msg) => logger[level]?.(TAG, msg),
      max: cfg.goals?.maxGoals ?? 40,
      terminalKeep: cfg.goals?.terminalKeep ?? 12
    }),
    continuity: new ContinuityStore({
      file: at(cfg.continuity?.file, 'continuity.json'),
      botName: cfg.server?.username || 'ZincAI'
    }),
    amd: new AmdToolsClient({
      apiKey: cfg.amd.apiKey,
      baseUrl: cfg.amd.baseUrl,
      model: cfg.amd.model,
      timeoutMs: cfg.amd.timeoutMs,
      maxRetries: cfg.amd.maxRetries,
      temperature: cfg.amd.temperature,
      maxTokens: cfg.amd.maxTokens,
      maxConcurrent: cfg.amd.maxConcurrent ?? 2,
      chatTimeoutMs: cfg.amd.chatTimeoutMs ?? null,
      chatMaxRetries: cfg.amd.chatMaxRetries ?? 1
    }),
    parser: new BlueprintParser({ scaffoldBlocks: cfg.build.scaffoldBlocks, reach: cfg.build.reach }),
    // Durable perception journal: undelivered important events survive a
    // context reset AND a process restart; already-processed ones never replay.
    events: new (require('./events').EventPipeline)({ file: at(cfg.events?.journalFile, 'events-journal.json') }),
    redstoneLibrary: new (require('./redstone_engine').RedstoneLibrary)(at(cfg.redstone?.libraryFile, 'redstone-library.json')),
    /** per-player conversation, oldest first: name -> [{ who:'them'|'me', text, ts }] */
    convo: new Map(),
    /** everything said in public recently, both sides */
    chatLog: [],
    shuttingDown: false,
    everSpawned: false,
    attempts: 0,
    session: null
  }
  // Conversations survive a restart: "what were we talking about" used to be
  // lost with the process.
  const convoFile = path.join(dataDir, 'conversations.json')
  try {
    const saved = JSON.parse(fs.readFileSync(convoFile, 'utf8'))
    const fresh = Date.now() - 7 * 24 * 3600_000
    for (const [name, lines] of Object.entries(saved.convo || {})) {
      const kept = (Array.isArray(lines) ? lines : []).filter((l) => l && l.text && l.ts > fresh).slice(-10)
      if (kept.length) shared.convo.set(name, kept)
    }
  } catch { /* first run */ }
  shared.saveConvo = () => {
    try {
      const tmp = convoFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ convo: Object.fromEntries(shared.convo) }), 'utf8')
      fs.renameSync(tmp, convoFile)
    } catch { /* best effort */ }
  }
  return shared
}

// ============================================================ boot ====
function main () {
  if (process.argv.includes('--check')) {
    for (const m of ['./api_wrapper', './memory', './perception', './filter', './builder', './continuity', './custom_mineflayer/pathfinder_wrapper', './custom_mineflayer/doors', './custom_mineflayer/escape', './system1', './tactics', './reflex_registry', './vanilla_guard', './control', './threats', './places', './skills', './observe', './brain', './events', './redstone_engine']) require(m)
    require('minecraft-data')('26.3') // postinstall patch must be in place
    logger.info(TAG, '--check OK — all modules load, 26.3 data present')
    return
  }

  const cfg = loadConfig()

  if (process.argv.includes('--dry-run')) {
    const errors = validateConfig(cfg)
    logger.info(TAG, `config: host=${cfg.server.host} port=${cfg.server.port} user=${cfg.server.username} auth=${cfg.server.auth} version=${cfg.server.version || 'auto'}`)
    logger.info(TAG, `amd: model=${cfg.amd.model} base=${cfg.amd.baseUrl} key=${cfg.amd.apiKey ? 'present' : 'MISSING'}`)
    logger.info(TAG, `data dir: ${DATA_DIR} (memories, places, goals, metrics)`)
    logger.info(TAG, `behaviour: mode=${cfg.behavior.mode} aliases=${(cfg.behavior.aliases || []).join(',') || '-'} language=${cfg.behavior.language || 'off'} elytra=${cfg.behavior.autoElytra ? 'yes' : 'no'}`)
    logger.info(TAG, `limits: rpm=${cfg.inference.rpm} minInterval=${cfg.inference.minIntervalMs}ms heartbeat=${cfg.inference.heartbeatMs}ms reconnect=${cfg.reconnect.enabled ? `${cfg.reconnect.maxAttempts} attempts` : 'off'}`)
    logger.info(TAG, `prompts: action ${SYSTEM_PROMPT.split(/\s+/).length} words, chat ${CHAT_PROMPT.split(/\s+/).length} words (static), ${ZINC_TOOLS.length} tools`)
    logger.info(TAG, 'policy: flee from real threats until the model decides; no PvP unless the model names a player; no friend list')
    for (const e of errors) logger.error(TAG, e)
    process.exitCode = errors.length ? 1 : 0
    return
  }

  const bootErrors = validateConfig(cfg)
  if (bootErrors.length) {
    for (const e of bootErrors) logger.error(TAG, e)
    process.exit(1)
  }

  const shared = makeShared(cfg)
  const { memoryFile } = shared

  function summary () {
    const s = shared.amd.getStats()
    const hit = s.kvCacheHitRate === null ? 'n/a' : `${(s.kvCacheHitRate * 100).toFixed(1)}%`
    logger.info(TAG, `amd session: ${s.requests} calls (${s.chatReplies} chat), ${s.failures} failures, avg prompt ${s.avgPromptTokensPerCall} tok, cached ${s.cachedTokens} tok, kv-hit-rate ${hit}, tools ${s.toolCalls}${s.jsonFallbacks ? ` (fallback ${s.jsonFallbacks})` : ''}`)
    logger.info(TAG, `memory: long-term ${shared.memory.longTerm.entries.length} entries saved to ${memoryFile}; places ${shared.places.blocks.size} blocks, ${shared.places.named.size} named`)
  }

  function shutdown (code, reason) {
    if (shared.shuttingDown) return
    shared.shuttingDown = true
    logger.info(TAG, `shutting down (${reason})`)
    try { shared.session?.dispose(true) } catch { /* noop */ }
    try { shared.memory.save() } catch { /* best effort */ }
    try { shared.places.save(true) } catch { /* best effort */ }
    try { shared.saveConvo() } catch { /* best effort */ }
    summary()
    // Hard-exit safety net: the process must die with `code` even if the
    // socket never closes (join failure before spawn, etc.).
    setTimeout(() => process.exit(code), 1_000)
  }

  /** Called by a session when its connection is over. */
  function sessionEnded ({ kind, text, spawned }) {
    if (shared.shuttingDown) return
    shared.session = null
    if (spawned) shared.attempts = 0
    const verdict = decideReconnect({ kind, text, everSpawned: shared.everSpawned, attempts: shared.attempts, reconnect: cfg.reconnect })
    if (verdict.action === 'exit') {
      for (const line of verdict.log) logger.error(TAG, line)
      return shutdown(verdict.code, verdict.reason)
    }
    shared.attempts = verdict.attempt
    logger.warn(TAG, `connection over (${kind}: ${text || 'no reason'}) — reconnecting in ${Math.round(verdict.delayMs / 1000)}s (attempt ${verdict.attempt}/${verdict.maxAttempts})`)
    try { shared.memory.save(); shared.places.save(true) } catch { /* best effort */ }
    setTimeout(() => { if (!shared.shuttingDown) shared.session = startSession(shared, sessionEnded) }, verdict.delayMs)
  }

  process.on('SIGINT', () => shutdown(0, 'SIGINT'))
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  process.on('unhandledRejection', (err) => logger.error(TAG, `unhandled rejection: ${err?.message || err}`))
  process.on('exit', (code) => { try { shared.memory.save() } catch { /* best effort */ }; if (code !== 0) logger.error(TAG, `exit code ${code}`) })

  shared.session = startSession(shared, sessionEnded)
}

// ========================================================= one session ==
/**
 * One connection to the server: the bot and everything attached to it.
 * @returns {{ dispose: (quit?: boolean) => void }}
 */
function startSession (shared, onEnded) {
  const { cfg, memory, places, amd, parser } = shared
  // Logical execution lanes: BODY is exclusive, COMPUTATION / INTERACTION /
  // WORLD INFO may overlap. Every tool call takes a lease, and the lease is
  // released on success, failure, cancellation and context reset.
  const lanes = new LaneScheduler()
  const jobs = new JobRegistry({ lanes })

  const mineflayer = require('mineflayer')
  const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')
  const { Vec3 } = require('vec3')
  const armorManager = require('mineflayer-armor-manager')

  const { buildVisionBlock, VISION_LEGEND } = require('./perception')
  const filter = require('./filter')
  const { BuilderExecutor, generateShape, normalizeStage } = require('./builder')
  const { PathfinderWrapper, scoutSafeAnchor } = require('./custom_mineflayer/pathfinder_wrapper')
  const { installVanillaGuard, assertVanillaAction } = require('./vanilla_guard')
  const { System1 } = require('./system1')
  const { ReflexRegistry, runScript } = require('./reflex_registry')
  const { ControlArbiter, PRIORITY } = require('./control')
  const { ThreatSense, HurtTracker, makeReachabilityCheck, useRegistry, isHostileMob } = require('./threats')
  const tactics = require('./tactics')
  const { clearToRun } = require('./custom_mineflayer/escape')
  const { PlaceIndex } = require('./places')
  const { Skills } = require('./skills')
  const { Brain } = require('./brain')
  const observe = require('./observe')
  const { AdvancedCombat } = require('../src/combat')
  const { craftItem } = require('../src/recipes')
  const { reasonToText } = require('../src/reasonToText')

  const wrapperLog = (level, msg) => logger[level === 'debug' ? 'debug' : level]?.(TAG, msg)

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
  const guard = installVanillaGuard(bot, { logger })
  bot.loadPlugin(pathfinder)
  if (cfg.behavior.useArmorManager) bot.loadPlugin(armorManager)

  // --- who owns what ------------------------------------------------------
  const arbiter = new ControlArbiter(bot, { logger: wrapperLog })
  const sense = new ThreatSense(bot, {
    radius: cfg.threat.radius ?? 12,
    rangedRadius: cfg.threat.rangedRadius ?? 18,
    attackerMemoryMs: cfg.threat.attackerMemoryMs ?? 15_000,
    reachable: makeReachabilityCheck(bot, { Movements, goals })
  })
  const wrapper = new PathfinderWrapper(bot, {
    allowScaffolding: cfg.behavior.allowScaffolding === true,
    logger: wrapperLog,
    // A* only pays for threats that are real (line of sight / reachable / hit us).
    threat: { ...(cfg.threat || {}), entityFilter: (e) => sense.isThreat(e) },
    isUrgent: () => arbiter.owner() === 'survival' || arbiter.owner() === 'combat',
    enableWindCharge: cfg.traversal?.windCharge !== false,
    windCharge: cfg.traversal || {}
  })
  const botNames = filter.botNames(cfg.server.username, cfg.behavior.aliases || [])

  let spawned = false
  let systemsReady = false
  let ended = false
  // In-flight decisions must not act on an obsolete life or danger snapshot.
  let decisionEpoch = 0
  let lifeEpoch = 0
  let alive = true
  let combat = null
  let system1 = null
  let skills = null
  let executor = null
  let brain = null
  let fight = null // { request, label, kills, player }
  let task = null // { id, label, startedAt } for background work that is not a Skill
  let taskSeq = 0
  let lastHurt = { at: 0, text: '' }
  let lastSayAt = 0
  const results = [] // what the last actions did: { label, ok, msg, ts }
  const continuity = shared.continuity || (shared.continuity = new ContinuityStore({
    file: path.join(shared.dataDir || DATA_DIR, 'continuity.json'),
    botName: cfg.server?.username || 'ZincAI'
  }))
  const redstoneInspector = new (require('./redstone_inspect').RedstoneInspector)(bot)
  const redstoneEngineer = new (require('./redstone_engine').RedstoneEngineer)(bot, {
    library: shared.redstoneLibrary,
    memory,
    executor: () => executor,
    canWrite: (pos) => {
      try {
        const claim = continuity.claimAt(pos, dim())
        if (!claim) return true
        return claim.kind === 'own' || (claim.owner && claim.owner.toLowerCase() === String(bot.username).toLowerCase())
      } catch { return true }
    },
    logger
  })
  const circuitProjects = shared.circuitProjects || (shared.circuitProjects = new (require('./circuit_projects').CircuitProjects)(path.join(shared.dataDir || DATA_DIR, 'circuit-projects.json')))
  const sayQueue = []
  const timers = new Set()
  const every = (ms, fn) => { const t = setInterval(fn, ms); timers.add(t); return t }

  // Chat, results, requests and what the reflex did each have a section of
  // their own in the prompt; they stay out of the five-line event window so
  // they cannot push a real event ("hit by player Gabriel") out of it.
  const OWN_SECTION = new Set(['chat', 'said', 'result', 'request', 'threat', 'safe', 'fled'])
  const note = (evt, opts = {}) => { try { memory.addEvent(evt, { window: !OWN_SECTION.has(evt?.type), ...opts }) } catch { /* never let memory break the loop */ } }

  // ------------------------------------------------- event perception ----
  // `perceive()` is the single funnel from a raw Mineflayer/internal event to
  // (a) the time-stamped pipeline the model is shown, and (b) the working
  // memory that older prompt sections read. Recording is cheap and never
  // throws; a perception failure must never take the session down.
  const pipeline = shared.events
  const latency = pipeline.latency
  const recentEntityPos = new Map() // entity id -> {x,y,z,at}
  const lastSeenPlayers = new Set()
  const perceive = (spec = {}) => {
    let rec = null
    try {
      rec = pipeline.record({
        source: spec.source || 'world',
        eventType: spec.eventType || spec.type || 'misc',
        reactionClass: spec.reactionClass || 'ambient',
        summary: spec.summary || spec.text || spec.msg || '',
        where: spec.where === undefined ? here() : (spec.where || null),
        entities: spec.entities || [],
        occurredAt: spec.occurredAt,
        occurrenceTimeKnown: spec.occurrenceTimeKnown,
        observedAt: spec.observedAt,
        observationBasis: spec.observationBasis,
        causalActId: spec.causalActId || null,
        delta: spec.delta || null,
        groupKey: spec.groupKey || null,
        dedupeKey: spec.dedupeKey,
        importance: spec.importance
      }, bot)
    } catch (err) { logger.debug(TAG, `event record failed: ${err.message || err}`) }
    if (spec.remember !== false) {
      note({
        type: spec.memoryType || spec.eventType || 'event',
        msg: spec.summary || spec.text,
        text: spec.summary || spec.text,
        sender: spec.sender
      })
    }
    // Important perceived events become episodic long-term memories with their
    // real provenance, so a restart can recall them (with occurrence honesty).
    if ((spec.importance ?? 0) >= 2 && spec.persist !== false && spec.eventType !== 'chat') {
      try {
        memory.longTerm.add(spec.summary || spec.text, ['event', spec.eventType], spec.importance, {
          kind: spec.observationBasis === 'reported' ? 'reported' : 'world_observation',
          source: spec.source || 'world'
        }, {
          category: 'episodic',
          basis: spec.observationBasis === 'reported' ? 'reported' : (spec.occurrenceTimeKnown === false ? 'inferred' : 'observed'),
          confidence: spec.occurrenceTimeKnown === false ? 0.7 : 0.9,
          location: spec.where ? { x: Math.floor(spec.where.x ?? spec.where[0] ?? 0), y: Math.floor(spec.where.y ?? 0), z: Math.floor(spec.where.z ?? 0), dim: dim() } : null,
          entities: spec.entities || []
        })
      } catch { /* memory best-effort */ }
    }
    if (spec.wake) {
      try {
        brain?.wake(spec.wake, {
          external: spec.external !== false,
          urgent: spec.reactionClass === 'immediate',
          fast: spec.reactionClass === 'fast',
          important: (spec.importance ?? 0) >= 2 || spec.reactionClass === 'immediate'
        })
      } catch { /* brain not up yet */ }
    }
    return rec
  }
  /** Latency bookkeeping around one model call (all monotonic). */
  const markInvocation = (meta) => {
    if (!meta) return { invokeMono: null }
    if (Number.isFinite(meta.queuedMono)) latency.record('queueToModelMs', Math.max(0, meta.invokeMono - meta.queuedMono))
    return meta
  }
  const markModel = (meta, startedMono) => {
    if (!meta) return
    latency.record('modelInferenceMs', Math.max(0, performance.now() - startedMono))
    if (Number.isFinite(meta.queuedMono)) latency.record('queueToModelMs', Math.max(0, meta.invokeMono - meta.queuedMono))
    latency.record('architectureOverheadMs', Math.max(0, (meta.invokeMono - meta.queuedMono) || 0))
  }
  const here = () => bot.entity?.position
  const dim = () => PlaceIndex.dimensionOf(bot)
  const ago = (ts) => { const sec = Math.max(0, Math.round((Date.now() - ts) / 1000)); return sec < 90 ? `${sec}s` : `${Math.round(sec / 60)}m` }

  // The server's language. Every outgoing line is checked (filter.js): the
  // prompts and tool results are English, and telling the model is not enough.
  const LANGUAGE = String(cfg.behavior.language ?? 'pt-BR').toLowerCase()
  const inLanguage = (text) => !LANGUAGE.startsWith('pt') || filter.checkPortuguese(text, { names: Object.keys(bot.players || {}) }).ok
  let foreignSays = { n: 0, at: 0 }

  // ------------------------------------------------------------- speech --
  const convoOf = (name) => { if (!shared.convo.has(name)) shared.convo.set(name, []); return shared.convo.get(name) }
  function pushConvo (name, who, text) {
    const list = convoOf(name)
    list.push({ who, text, ts: Date.now() })
    if (list.length > 10) list.splice(0, list.length - 10)
  }
  function logChat (who, text) {
    shared.chatLog.push({ who, text, ts: Date.now() })
    if (shared.chatLog.length > 12) shared.chatLog.splice(0, shared.chatLog.length - 12)
  }
  /** The bot and this player exchanged lines within the last minute. */
  // A sender may wake the chat lane at most this often (sliding minute).
  const chatRate = {
    hits: new Map(),
    allow (sender) {
      const max = cfg.behavior.chatPerPlayerPerMinute ?? 8
      if (!(max > 0)) return true
      const now = Date.now()
      const key = String(sender).toLowerCase()
      const list = (this.hits.get(key) || []).filter((t) => now - t < 60_000)
      if (list.length >= max) { this.hits.set(key, list); return false }
      list.push(now)
      this.hits.set(key, list)
      return true
    },
    prune () { const now = Date.now(); for (const [k, v] of this.hits) { const l = v.filter((t) => now - t < 60_000); if (!l.length) this.hits.delete(k); else this.hits.set(k, l) } }
  }

  const inConversation = (name) => {
    const list = shared.convo.get(name)
    const last = list && list[list.length - 1]
    return Boolean(last) && Date.now() - last.ts < 60_000 && list.some((l) => l.who === 'me' && Date.now() - l.ts < 90_000)
  }

  /** Queue a chat line. Lines are spaced out, never dropped. */
  function speak (text, { to = null, about = null } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^\/+/, '').slice(0, 200)
    if (!t) return false
    sayQueue.push({ text: t, to, about })
    if (sayQueue.length > 6) sayQueue.splice(0, sayQueue.length - 6)
    flushSay()
    return true
  }
  function flushSay () {
    if (!sayQueue.length || ended) return
    const wait = (cfg.behavior.chatCooldownMs ?? 1500) - (Date.now() - lastSayAt)
    if (wait > 0) { const t = setTimeout(() => { timers.delete(t); flushSay() }, wait + 20); timers.add(t); return }
    const { text, to, about } = sayQueue.shift()
    lastSayAt = Date.now()
    try {
      const whispered = to ? guard.whisper(to, text) : false
      if (to && !whispered) {
        logger.warn(TAG, `private message to ${to} not sent (recipient unavailable or invalid); never falling back to public chat`)
        if (sayQueue.length) flushSay()
        return
      }
      if (!to) bot.chat(text)
      logChat('me', whispered ? `(to ${to}) ${text}` : text)
      if (to || about) pushConvo(to || about, 'me', text)
      note({ type: 'said', msg: `I said${whispered ? ` to ${to}` : ''}: ${text}` })
    } catch (err) { logger.debug(TAG, `chat failed: ${err.message || err}`) }
    if (sayQueue.length) flushSay()
  }

  // ------------------------------------------------------ action results --
  const INFORMATIONAL = new Set(['find', 'look_in', 'inspect_block', 'inspect_region', 'logic_test', 'redstone_scan', 'redstone_component', 'redstone_engineer', 'recall', 'circuit_project', 'goal', 'note', 'social', 'remember_here'])
  // stop the model re-issuing a call the body keeps refusing.
  const failGate = new FailGate({
    windowMs: cfg.inference?.failWindowMs ?? 120_000,
    maxFails: cfg.inference?.failGateAfter ?? 2
  })
  /** The action whose turn is executing right now, for failure attribution. */
  let gateCtx = null
  let currentActId = null
  /** actId -> monotonic ms when the action started, for exec→confirm latency. */
  const actStartedMono = new Map()
  /**
   * Record what an action did and, when the model needs to know right away
   * (a failure, a finished task, information it asked for), wake it.
   */
  function report (label, result, { wake = null, actId = null } = {}) {
    const r = result && typeof result === 'object' ? result : { ok: true, msg: String(result ?? 'done') }
    // What the model asked to be told (a chest's contents, a storage list) is
    // not cut to a headline: at 220 characters a full chest lost its second half.
    const msg = String(r.msg || (r.ok ? 'done' : 'failed')).slice(0, INFORMATIONAL.has(label) ? 900 : 260)
    if (gateCtx && String(gateCtx.a) === label) {
      if (!r.ok) failGate.recordFailure(gateCtx, msg, here())
      else failGate.recordSuccess(gateCtx)
    }
    const resolvedActId = actId || currentActId || null
    let finalActId = resolvedActId
    if (label !== 'reply') {
      try { finalActId = continuity.finishAction(resolvedActId, { tool: label, summary: null, ok: Boolean(r.ok), msg }) } catch { /* noop */ }
    }
    const resultTs = Date.now()
    results.push({ label, ok: Boolean(r.ok), msg, ts: resultTs, at: new Date(resultTs).toISOString(), actId: finalActId })
    if (results.length > 5) results.splice(0, results.length - 5)
    // Confirm-time instrumentation + a timestamped event carrying which of
    // Zinc's own actions this result belongs to (`[by your actN]` in prompts).
    try {
      if (actStartedMono.has(finalActId)) {
        latency.record('execToConfirmMs', Math.max(0, performance.now() - actStartedMono.get(finalActId)))
        actStartedMono.delete(finalActId)
      }
      if (label !== 'reply') {
        perceive({
          source: 'self', eventType: r.ok ? 'action_result' : 'action_failure',
          reactionClass: r.ok ? 'ambient' : 'fast',
          summary: `${label} ${r.ok ? 'completed' : 'failed'}: ${msg}`.slice(0, 200),
          causalActId: finalActId || null,
          occurredAt: resultTs > 0 ? resultTs : undefined,
          observationBasis: 'direct',
          importance: r.ok ? 0 : 1,
          remember: false
        })
      }
    } catch { /* never let instrumentation break reporting */ }
    logger.info(TAG, `${label}: ${r.ok ? 'ok' : 'FAILED'} — ${msg}`)
    note({ type: 'result', msg: `${label}: ${msg}` })
    // Promote durable world/exploration findings (not ephemeral walk/eat failures) to long-term memory.
    if (r.ok) {
      try {
        if (label === 'look_in') {
          const cid = (msg.match(/^([a-z_]+\d+)\b/i) || [])[1] || ''
          if (cid && places?.blocks) {
            for (const e of places.blocks.values()) {
              if (e.id === cid.toLowerCase() && e.lastDiff) {
                continuity.recordChange('storage_changed', `${e.id}${e.label ? ` "${e.label}"` : ''} changed: ${e.lastDiff}`)
                break
              }
            }
          }
          if (!/is empty\b/i.test(msg)) {
            const tag = cid ? `container:${cid.toLowerCase()}` : null
            const summary = `container ${msg}`.slice(0, 220)
            if (tag && typeof memory.longTerm?.upsertByTag === 'function') memory.longTerm.upsertByTag(tag, summary, ['container', cid.toLowerCase()], 2)
            else memory.longTerm?.add(summary, ['container'], 2)
          }
        } else if (label === 'circuit_project' && /^(bound|saved)\b/i.test(msg)) {
          memory.longTerm?.add(`circuit project: ${msg}`.slice(0, 220), ['redstone', 'circuit'], 2)
        }
      } catch { /* never let memory persistence break reporting */ }
    }
    const shouldWake = wake === null ? (!r.ok || INFORMATIONAL.has(label)) : wake
    if (shouldWake) brain?.wake(`${label} ${r.ok ? 'done' : 'failed'}: ${msg}`, { external: false })
  }

  // ------------------------------------------------------------ trust ----
  /**
   * optional trust gate. The default has NO lists configured
   * and behaves exactly as before (everyone equal). Once trust.owners or
   * trust.trusted name players, a guest whose chat request reached the body
   * may not: take/give valuables, run scripts. The bot's own initiative
   * (askedBy null) is never gated. Matching is offline-safe best effort —
   * username spoofing is a server-config matter (documented in README).
   */
  const trustCfg = cfg.trust || {}
  const trustLists = { owners: (trustCfg.owners || []).map((n) => String(n).toLowerCase()), trusted: (trustCfg.trusted || []).map((n) => String(n).toLowerCase()) }
  const trustConfigured = trustLists.owners.length > 0 || trustLists.trusted.length > 0
  const TRUST_VALUABLE = /(diamond|diamante|netherite|esmeralda|emerald|ancient_debris|elytra|beacon|tesouro|valioso|enchanted_golden)/i
  function trustLevel (name) {
    if (!name) return 'self'
    const n = String(name).toLowerCase()
    if (trustLists.owners.includes(n)) return 'owner'
    if (trustLists.trusted.includes(n)) return 'trusted'
    return 'guest'
  }
  function trustCheck (a, action, askedBy) {
    if (!trustConfigured || !askedBy || trustLevel(askedBy) !== 'guest') return null
    const who = `${askedBy} is not in the trust list (config trust.owners/trusted) — an owner can ask this. Tell the player that`
    if (a === 'run_script') return `refused for ${askedBy}: ${who}`
    if (a === 'give' && TRUST_VALUABLE.test(String(action.item || ''))) return `refused for ${askedBy}: ${who}`
    if (a === 'take' && (TRUST_VALUABLE.test(String(action.item || '')) || TRUST_VALUABLE.test(String(action.where || '')))) return `refused for ${askedBy}: ${who}`
    return null
  }

  // ------------------------------------------------------------ agenda ---
  /**
   * What the bot is meant to be doing, beyond the one skill that happens to
   * be running:
   *
   *   main     a long task (go_to, follow, a build). A short side job — give,
   *            take, put, look_in, smelt, use_block, sleep, a fight — PAUSES
   *            it and it carries on by itself afterwards. It used to be
   *            cancelled: "Zinc, me dá um pão" ended the build. `stop` ends it.
   *   shelved  a build that a newer main task replaced: not running, shown so
   *            the model can pick it up again.
   *   asked    requests the chat voice handed over that the body has not
   *            acted on yet (the turn they arrived in answered idle or failed).
   */
  const agenda = { main: null, shelved: [], asked: [] }
  let proposalSeq = 0
  const MAIN_MAX_AGE_MS = 30 * 60_000

  // ------------------------------------------------ durable objectives ---
  // `agenda` above is what runs in THIS process. `goals` (goals.js) is the
  // durable record behind it: the problem was never "which task is running",
  // it was that a death, a restart or a compaction erased what the bot was
  // doing, with no checkpoint to resume from.
  const goalReg = shared.goals
  const GOALS = cfg.goals || {}
  const GOAL_PRIORITY = { shelter: 80, corpse_run: 75, gather: 60, build: 55, build_shape: 55, craft: 50, go_to: 45, dig: 45, give: 45, follow: 40, take: 40, put: 40, light_up: 35, smelt: 35, sleep: 30, look_in: 25 }
  const goalPriority = (tool) => Math.max(0, Math.min(100, Math.trunc(Number(GOAL_PRIORITY[String(tool)] ?? 45))))
  const SIDE_KINDS = new Set(['take', 'put', 'smelt', 'craft', 'sleep', 'look_in', 'use_block', 'give'])
  let goalToolSeq = 0

  function pruneAgenda () {
    const now = Date.now()
    agenda.shelved = agenda.shelved.filter((x) => now - x.at < MAIN_MAX_AGE_MS)
    agenda.asked = agenda.asked.filter((x) => now - x.at < 5 * 60_000)
  }

  /** The action's own arguments, minus the tool name and internal markers. */
  function goalArgs (action) {
    const out = {}
    for (const [k, v] of Object.entries(action || {})) {
      if (k === 'a' || k.startsWith('_') || v === undefined || v === null) continue
      out[k] = v
    }
    return out
  }

  /**
   * What is needed to run this task again later, in the same place, with the
   * remaining work. A build's origin is resolved NOW: re-running `build` with
   * no `at` used to anchor the structure at the bot's new feet position, i.e.
   * a second house beside the first.
   */
  function goalDetailFor (tool, action) {
    const detail = { args: goalArgs(action) }
    if (String(tool).startsWith('build')) {
      const p = here()
      const at = Array.isArray(action.at) && action.at.length >= 3 && action.at.every((v) => Number.isFinite(Number(v)))
        ? action.at.map((v) => Math.trunc(Number(v)))
        : (p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null)
      if (at) detail.at = at
      // Which dimension the site is in: the same x,z means a different place
      // in the nether, and re-reading "the house" there is not evidence.
      try { detail.dim = dim() } catch { /* no world yet */ }
      if (action.stage) detail.stage = String(action.stage)
    }
    return detail
  }

  /** The registry record behind a task the model just started. */
  function openGoalForMain (spec) {
    const taskOrigin = spec.askedBy ? `player:${spec.askedBy}` : (spec.origin || 'self')
    const declared = goalReg.openGoals()
      .filter((g) => g.kind === 'declared' && (g.status === 'pending' || g.status === 'active'))
      .filter((g) => {
        if (spec.askedBy) {
          return g.origin === `player:${spec.askedBy}` || (g.participants || []).some((p) => p.toLowerCase() === spec.askedBy.toLowerCase())
        }
        return g.originType === 'self_generated' || g.origin === 'self' || g.originType === 'shared_project'
      })
      .sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt))[0] || null
    // The kind is the tool family: it decides how the checkpoint is replayed.
    const kind = String(spec.tool || 'task').split(' ')[0]
    const goal = goalReg.add({
      description: spec.label,
      kind,
      origin: taskOrigin,
      priority: spec.priority ?? goalPriority(spec.tool),
      parentId: spec.parentId || (declared ? declared.id : null),
      completion: 'the task reports success and the world agrees (verified, not just "the call returned")',
      failure: 'the task failed and no retry made progress',
      interruption: 'safety reflex, fight, death, restart, a newer task or the model itself',
      resume: 're-run the same task from this checkpoint (build: same origin and stage; gather: the remaining count)',
      detail: spec.detail || {}
    })
    if (goal && declared) goalReg.update(declared.id, { detail: { activeChild: goal.id } })
    return goal
  }

  /** The task finished: record what actually happened, never "the call returned". */
  function finishGoal (goalId, r) {
    if (!goalId) return
    const goal = goalReg.get(goalId)
    if (!goal) return
    // A late result may not revive a cancelled objective nor overwrite a
    // completion that was already recorded.
    if (goal.status === 'cancelled' || goal.status === 'completed') return
    const msg = String(r?.msg || (r?.ok ? 'done' : 'failed')).slice(0, 160)
    if (r?.progress) goalReg.progress(goalId, r.progress)
    if (/\b(replaced|paused|cancelled)\b/i.test(msg)) {
      goalReg.suspend(goalId, { reason: msg.slice(0, 100), by: 'task' })
      return
    }
    if (r && r.ok && r.complete !== false) goalReg.complete(goalId, { note: msg })
    else if (r && r.ok) goalReg.suspend(goalId, { reason: `stopped before finishing: ${msg.slice(0, 90)}`, by: 'task' })
    else goalReg.fail(goalId, { error: msg || 'failed' })
  }

  /** Start (or restart after a pause) the main task. */
  function launch (main) {
    main.seq = (main.seq || 0) + 1
    try {
      continuity.currentState.activeGoalId = main.goalId || null
      continuity.currentState.activity = String(main.tool || '').startsWith('build') ? 'building' : main.tool === 'gather' ? 'gathering' : 'navigating'
      continuity.currentState.why = main.label || ''
    } catch { /* noop */ }
    const actId = continuity.beginAction({ tool: main.tool, summary: main.label, sig: `${main.tool}:${main.label}`, goalId: main.goalId || null })
    // A restart waits until the previous run has really stopped: a cancelled
    // build needs a moment to notice, and two builds must never run at once.
    const again = () => main.run()
    main.running = main.running ? main.running.then(again, again) : main.run()
    background(main.tool, main.running, { showAs: main.showAs || null, main, seq: main.seq, actId })
  }

  /** Put the running objective aside without losing it. */
  function shelfMain (main, reason) {
    if (!main) return
    if (main.goalId && goalReg.get(main.goalId)) goalReg.suspend(main.goalId, { reason, by: 'agenda' })
    if (!agenda.shelved.some((x) => main.goalId && x.goalId === main.goalId)) {
      agenda.shelved.push({ label: main.label, askedBy: main.askedBy || null, at: Date.now(), goalId: main.goalId || null })
      if (agenda.shelved.length > 4) agenda.shelved.shift()
    }
  }

  /**
   * A long task begins. Whatever ran before ends (the newest decision wins);
   * it is set aside with its checkpoint — whatever kind it was, not just a
   * build, and never silently.
   * @param {{ tool:string, label:string, run:() => Promise<object>, askedBy?:string|null, showAs?:string, resumable?:boolean, goalId?:string, detail?:object, priority?:number, origin?:string }} spec
   */
  function startMain (spec) {
    const prev = agenda.main
    if (prev) shelfMain(prev, `set aside: ${spec.label} was started`)
    agenda.shelved = agenda.shelved.filter((x) => !spec.goalId || x.goalId !== spec.goalId)
    replaceTask()
    const main = { ...spec, startedAt: Date.now(), paused: null, resumes: 0, seq: 0 }
    let goal = main.goalId ? goalReg.get(main.goalId) : null
    if (goal) {
      goalReg.update(goal.id, { detail: { ...(goal.detail || {}), ...(spec.detail || {}) } })
      goalReg.resume(goal.id, { reason: 'run again' })
    } else {
      goal = openGoalForMain(spec)
      main.goalId = goal ? goal.id : null
      if (goal) goalReg.resume(goal.id, { reason: spec.askedBy ? `asked by ${spec.askedBy}` : 'started' })
    }
    agenda.main = main
    launch(main)
  }

  /** Make room for something short without losing the main task. @returns true when a main task was paused */
  function pauseMain (by, { until = null } = {}) {
    const main = agenda.main
    if (!main) return false
    if (main.resumable === false) {
      agenda.main = null
      if (main.goalId) goalReg.cancel(main.goalId, { reason: `cancelled to make room for ${by}` })
      return false
    }
    main.paused = { by, at: Date.now(), until }
    if (main.goalId) goalReg.suspend(main.goalId, { reason: `paused for ${by}`, by })
    return true
  }

  /**
   * A short job: the main task waits for it and resumes afterwards.
   * @param {string} label tool name
   * @param {() => Promise<object>} run
   */
  function startSide (label, run, opts = {}) {
    if (pauseMain(label, opts)) {
      try { skills?.cancel('paused') } catch { /* noop */ }
      try { executor?.cancel() } catch { /* noop */ }
      leaveFight('new task')
    } else replaceTask()
    // A short job is an objective too (a player is owed a loaf).
    let goal = opts.goalId ? goalReg.get(opts.goalId) : null
    if (goal) {
      goalReg.resume(goal.id, { reason: 'resumed as a side job' })
    } else {
      goal = goalReg.add({
        description: opts.describe || String(label),
        kind: String(label).split(' ')[0],
        origin: opts.askedBy ? `player:${opts.askedBy}` : 'self',
        priority: goalPriority(label),
        completion: 'this one job reports success',
        resume: 're-run the same short job (checkpoint kept in detail)',
        detail: opts.detail || {}
      })
      if (goal) goalReg.resume(goal.id, { reason: 'side job started' })
    }
    const actId = continuity.beginAction({ tool: label, summary: opts.describe || String(label), sig: `${label}:${opts.describe || ''}`, goalId: goal ? goal.id : null })
    return background(label, run(), { side: true, goalId: goal ? goal.id : null, actId })
  }

  /** The side job is over: back to the main task, if one is waiting and nothing else runs. */
  function resumeMain (after) {
    const main = agenda.main
    if (!main || !main.paused || ended) return false
    if (main.paused.until === 'wake' && bot.isSleeping) return false // the wake event resumes it
    if (skills?.current() || combat?.isEngaged) return false // whatever is running calls this again when it ends
    if (Date.now() - main.startedAt > MAIN_MAX_AGE_MS || main.resumes >= (GOALS.maxResumes ?? 8)) {
      // It used to be deleted here. An objective interrupted eight times is
      // exactly the one a player still wants finished: it is set aside, with
      // its checkpoint and a reason, and the model is told.
      agenda.main = null
      shelfMain(main, `set aside after ${main.resumes} interruptions or ${Math.round((Date.now() - main.startedAt) / 60000)} min`)
      note({ type: 'dropped', msg: `set aside ${main.label} (interrupted too often or too old); it is still on the goal list` })
      supersede(`gave up on ${main.label}`)
      brain?.wake(`${main.label} was set aside after ${main.resumes} interruptions; it is still open (goal resume or goal cancel)`, { external: true })
      return false
    }
    main.paused = null
    main.resumes++
    if (main.goalId) goalReg.resume(main.goalId, { reason: `resumed after ${after}` })
    // The decision that came with the task comes back with it (the side job
    // replaced it) — except about anything that hit the bot in the meantime.
    const d = main.decision
    if (d?.ids?.length) {
      const still = d.ids.filter((id) => { const e = bot.entities?.[id]; return e && !sense.isRecentAttacker(e) })
      if (still.length) system1?.acknowledge(still, d.opts)
    }
    note({ type: 'resumed', msg: `back to ${main.label} after ${after}` })
    logger.info(TAG, `resuming ${main.label} after ${after}`)
    supersede(`resumed ${main.label}`)
    launch(main)
    return true
  }

  /** The agenda as one prompt line, or null when there is nothing beyond what "doing:" says. */
  function agendaLine () {
    pruneAgenda()
    const parts = []
    const m = agenda.main
    if (m && m.paused) parts.push(`[main, PAUSED for ${m.paused.by}] ${m.label}${m.askedBy ? `, asked by ${m.askedBy}` : ''} (${ago(m.startedAt)} ago) — carries on by itself afterwards; stop cancels it`)
    for (const x of agenda.shelved) parts.push(`[set aside] ${x.label}${x.askedBy ? `, asked by ${x.askedBy}` : ''} (${ago(x.at)} ago) — call it again to continue`)
    for (const x of agenda.asked) parts.push(`[proposal from ${x.from} — optional: accept, negotiate, delay, decline, or ignore] ${x.text} (${ago(x.at)} ago)`)
    return parts.length ? `agenda: ${parts.join(' | ')}` : null
  }

  /**
   * Determine whether an action executed during `snap` was chosen for `snap.askedBy`
   * or for Zinc itself (`null`). Prevents a player's chat message from hijacking
   * ownership/origin of Zinc's own active self-generated projects when Zinc chooses
   * to ignore or decline the player's request and continue its own work.
   */
  function resolveActionAttribution (tool, action, snap) {
    const asker = snap?.askedBy || null
    if (!asker) return null
    const reasons = Array.isArray(snap?.reasons) ? snap.reasons : null
    const reqLine = reasons ? [...reasons].reverse().find((r) => /^chat request from /.test(r)) : null
    // Programmatic/synthetic snapshots without a live chat-request reason keep explicit `snap.askedBy`.
    if (!reqLine) return asker
    if (action?.player && String(action.player).toLowerCase() === asker.toLowerCase()) return asker
    const rel = continuity.getRelationship(asker)
    if (rel?.lastProposal?.explicit && ['decline', 'ignore', 'delay'].includes(rel.lastProposal.decision) && (Date.now() - (rel.lastProposal.at || 0)) < 15_000) {
      return null
    }
    const openSelfGoals = goalReg.openGoals().filter((g) => g.kind === 'declared' && (g.originType === 'self_generated' || g.origin === 'self'))
    if (!openSelfGoals.length) return asker
    const proposalBody = reqLine.replace(/^chat request from \S+?:\s*/, '').toLowerCase()
    const needles = [
      String(tool || '').toLowerCase(),
      action?.item ? String(action.item).toLowerCase() : '',
      action?.block ? String(action.block).toLowerCase() : '',
      action?.shape ? String(action.shape).toLowerCase() : '',
      action?.place ? String(action.place).toLowerCase() : '',
      action?.where ? String(action.where).toLowerCase() : ''
    ].filter((s) => s.length >= 3)
    if (needles.some((n) => proposalBody.includes(n))) return asker
    // Zinc has an open self-generated goal and chose an action unrelated to the player's proposal.
    return null
  }

  // ------------------------------------------- goals: prompt & watchdog --

  /** Invalidate an in-flight model decision: the situation it answered has changed. */
  function supersede (reason) {
    if (!brain || !brain.busyAction) return false
    decisionEpoch++
    logger.debug(TAG, `in-flight decision superseded (${reason})`)
    return true
  }

  /** The durable objective list as prompt lines, or null when there is nothing. */
  function goalLines () {
    const open = goalReg.openGoals()
    if (!open.length) return null
    const now = Date.now()
    const limit = Math.max(1, Math.min(8, GOALS.promptMax ?? 6))
    const waiting = goalReg.waiting({ now })
    const head = `goals (${open.length} open${waiting.length ? `; longest waiting: ${waiting[0].id} ${waiting[0].description.slice(0, 40)}` : ''}): a goal is not lost when a task pauses, dies or restarts — inspect with goal show <id>, continue with goal resume <id>, drop with goal cancel <id>`
    return [head, ...goalReg.brief({ limit, now }).map((l) => `  - ${l}`)].join('\n')
  }

  /** One compact line for the chat lane: active goals (yours, shared, or accepted). */
  function goalBriefLine () {
    const open = goalReg.openGoals()
    if (!open.length) return null
    const bits = open.slice(0, 3).map((g) => `${g.id} ${g.status} ${g.description} [${g.originType || g.origin || 'self'} p=${g.priority}]`)
    const more = open.length > 3 ? ` (+${open.length - 3} more)` : ''
    return `goals: ${bits.join(' | ')}${more}`
  }

  /** Origin + checkpoint for a short job, so it is not anonymous in the registry. */
  function sideOpts (label, action, snap) {
    return {
      askedBy: resolveActionAttribution(label, action, snap),
      describe: describeSide(label, action),
      detail: goalDetailFor(label, action)
    }
  }

  /** "take diamond x5 from chest2" — the readable form of a short job. */
  function describeSide (label, action) {
    const bits = []
    if (action.item) bits.push(String(action.item))
    if (action.count) bits.push(`x${action.count}`)
    if (action.where) bits.push(`${label === 'put' ? 'into' : 'from'} ${action.where}`)
    if (action.player) bits.push(`to ${action.player}`)
    if (action.what) bits.push(String(action.what))
    if (action.i && !action.item) bits.push(String(action.i))
    return bits.length ? `${label} ${bits.join(' ')}` : label
  }

  // Actions that are worth refusing when the world moved while the model was
  // thinking: a delayed answer must not start quiet work beside a new creeper
  // or resurrect a task that another controller already replaced.
  const QUIET_TASKS = new Set(['build', 'build_shape', 'gather', 'take', 'put', 'smelt', 'sleep', 'use_block', 'craft', 'look_in', 'light_up', 'shelter', 'follow', 'go_to', 'dig', 'run_script'])
  function staleActionReason (action, snap) {
    if (GOALS.staleGuard === false) return null // opt out from config (debugging)
    if (!snap || !QUIET_TASKS.has(action.a)) return null
    const known = new Set(snap.threatIds || [])
    const fresh = [...(sense.last?.dangerIds || [])].filter((id) => !known.has(id))
    if (fresh.length) {
      return `refused: ${fresh.length} new threat${fresh.length === 1 ? '' : 's'} came close while you were deciding (not in the snapshot you answered). Decide again — fight, hold or flee.`
    }
    const then = snap.goalId || null
    const now = agenda.main && !agenda.main.paused ? agenda.main.goalId : null
    if (then !== now) {
      return `refused: the active task changed while you were deciding${then ? ` (${then} was running then)` : ''}${now ? `; ${now} is running now` : ''}. Read goals/doing and decide again.`
    }
    return null
  }

  /**
   * Is a stored objective still true? The world is the only ground truth:
   * a saved plan is not evidence that the chest still holds the diamonds or
   * that the wall was not finished before the process died.
   * @returns {{ state:'complete'|'partial'|'unknown'|'invalid', note:string, done?:number, total?:number }}
   */
  function verifyGoalAgainstWorld (goal) {
    const d = (goal && goal.detail) || {}
    const args = (d && d.args) || {}
    try {
      if (goal.kind === 'build' || goal.kind === 'build_shape') {
        if (!Array.isArray(d.at) || d.at.length < 3) return { state: 'unknown', note: 'no build origin recorded, so the site cannot be checked' }
        if (d.dim && dim() && d.dim !== dim()) return { state: 'unknown', note: `the site is in the ${d.dim} and this is the ${dim()} — go there to check it` }
        let parsed
        if (args.blueprint) parsed = parser.load(String(args.blueprint))
        else if (Array.isArray(args.grid)) parsed = parser.parseInline({ grid: args.grid, palette: args.palette || {} })
        else if (args.shape) parsed = { blocks: generateShape(String(args.shape), args.params || {}, String(args.block)) }
        else return { state: 'unknown', note: 'no plan recorded for this build' }
        const origin = new Vec3(Math.trunc(d.at[0]), Math.trunc(d.at[1]), Math.trunc(d.at[2]))
        const plan = parser.plan(parsed, origin, bot.entity.position)
        const stage = d.stage ? normalizeStage(d.stage) : null
        const steps = stage ? plan.steps.filter((st) => st.phase === stage) : plan.steps
        if (!steps.length) return { state: 'unknown', note: 'the plan has no blocks for that stage' }
        let present = 0
        let missing = 0
        let unreadable = 0
        for (const st of steps) {
          let block = null
          try { block = bot.blockAt(new Vec3(st.x, st.y, st.z)) } catch { block = null }
          if (!block) unreadable++
          else if (block.name === st.name) present++
          else missing++
        }
        const total = steps.length
        if (present === total) return { state: 'complete', done: present, total, note: `all ${total} blocks of this ${stage || 'build'} are already in place at ${d.at.join(',')}` }
        if (unreadable > total / 2) return { state: 'unknown', done: present, total, note: `the site is not loaded (${unreadable}/${total} cells unreadable)` }
        return { state: 'partial', done: present, total, note: `${present}/${total} blocks in place, ${missing} still missing` }
      }
      if (goal.kind === 'gather') {
        const want = String(args.item || '').toLowerCase().trim()
        const total = Math.max(1, Math.trunc(Number(args.count) || 1))
        const have = bot.inventory.items().filter((i) => i.name === want).reduce((n, i) => n + (Number(i.count) || 0), 0)
        if (!want) return { state: 'unknown', note: 'no item recorded for this gather' }
        if (have >= total) return { state: 'complete', done: have, total, note: `carrying ${have} ${want} (asked for ${total})` }
        return { state: 'partial', done: have, total, note: `carrying ${have} of ${total} ${want}` }
      }
      if (goal.kind === 'go_to') {
        if (args.place) {
          const place = places.getPlace(args.place)
          if (!place) return { state: 'invalid', note: `the place "${args.place}" is no longer known` }
          return { state: 'unknown', note: `the place "${args.place}" still exists at ${place.x},${place.y},${place.z}` }
        }
        if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.z)) && here()) {
          const p = here()
          const dx = Number(args.x) - p.x
          const dz = Number(args.z) - p.z
          if (Math.hypot(dx, dz) <= 2) return { state: 'complete', note: `already standing at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }
        }
        return { state: 'unknown', note: 'walking there again is the only way to know' }
      }
      if (goal.kind === 'follow') {
        const who = String(args.player || '')
        if (who && !bot.players?.[who]) return { state: 'invalid', note: `${who} is not on the server any more` }
        return { state: 'unknown', note: `${who || 'the player'} must be seen again before following` }
      }
      if (goal.kind === 'take' || goal.kind === 'put') {
        const where = String(args.where || '')
        const entry = where ? places.resolve(where, here(), { dim: dim() }) : null
        const want = String(args.item || '')
        if (entry && entry.contents && want) {
          const inside = Number(entry.contents[want] || 0)
          if (goal.kind === 'take' && inside === 0) return { state: 'invalid', note: `the container no longer holds ${want} (someone may have emptied it)` }
        }
        return { state: 'unknown', note: 'the container must be opened again to be sure' }
      }
      if (goal.kind === 'declared') return { state: 'unknown', note: 'a declared objective has no world state of its own; judge it from what you see' }
      return { state: 'unknown', note: 'nothing verifiable is recorded for this kind of goal' }
    } catch (err) {
      return { state: 'invalid', note: `cannot be verified: ${String(err?.message || err).slice(0, 100)}` }
    }
  }

  /** Apply a verification verdict to the record (never to a terminal goal). */
  function applyVerdict (goal, verdict) {
    if (!goal) return verdict
    goal.verifiedAt = Date.now()
    if (!['pending', 'active', 'suspended', 'resumable', 'failed'].includes(goal.status)) return verdict
    if (verdict.state === 'complete') {
      goalReg.complete(goal.id, { note: `verified in the world: ${verdict.note}` })
      note({ type: 'goal', msg: `${goal.id} ${goal.description}: ${verdict.note} — marked completed` }, { promote: true })
    } else if (verdict.state === 'invalid') {
      goalReg.fail(goal.id, { error: verdict.note })
      note({ type: 'goal', msg: `${goal.id} ${goal.description} is no longer valid: ${verdict.note}` }, { promote: true })
    } else if (verdict.state === 'partial') {
      goalReg.update(goal.id, { needsVerify: false })
      goalReg.progress(goal.id, { done: verdict.done, total: verdict.total, note: verdict.note })
    }
    return verdict
  }

  function reconcileGoal (goal) { return applyVerdict(goal, verifyGoalAgainstWorld(goal)) }

  /**
   * Rebuild a runnable from the checkpoint: what the goal needs to continue,
   * with the remaining work — not the whole task from the start.
   */
  function runFromDetail (goal) {
    const d = (goal && goal.detail) || {}
    const args = d.args || {}
    const kind = String(goal.kind || '')
    try {
      if (kind === 'build') {
        let planned
        if (args.blueprint) planned = parser.load(String(args.blueprint))
        else if (Array.isArray(args.grid)) planned = parser.parseInline({ grid: args.grid, palette: args.palette || {} })
        else return { ok: false, why: 'no blueprint or grid was recorded, so the build cannot be continued' }
        const name = String(args.blueprint || 'inline')
        return { ok: true, tool: 'build', label: goal.description, run: () => buildBlocks(planned.blocks, name, d.stage || args.stage, d.at || args.at) }
      }
      if (kind === 'build_shape') {
        if (!args.shape || !args.block) return { ok: false, why: 'the shape and block were not recorded' }
        const blocks = generateShape(String(args.shape), args.params || {}, String(args.block))
        return { ok: true, tool: 'build_shape', label: goal.description, run: () => buildBlocks(blocks, `shape:${args.shape}`, d.stage || args.stage, d.at || args.at) }
      }
      if (kind === 'gather') {
        const want = String(args.item || '')
        const total = Math.max(1, Math.trunc(Number(args.count) || 1))
        const done = Math.max(0, Math.trunc(Number(goal.progress?.done) || 0))
        const remaining = Math.max(1, total - done)
        return { ok: true, tool: 'gather', label: goal.description, run: () => skills.gather({ item: want, count: remaining, radius: args.radius }) }
      }
      if (kind === 'go_to') {
        const target = args.player ? { player: args.player } : args.place ? { place: args.place } : { x: args.x, y: args.y, z: args.z }
        return { ok: true, tool: 'go_to', label: goal.description, run: () => skills.goTo(target) }
      }
      if (kind === 'follow') return { ok: true, tool: 'follow', label: goal.description, run: () => skills.follow({ player: args.player }) }
      if (kind === 'light_up') return { ok: true, tool: 'light_up', label: goal.description, run: () => skills.lightUp({ radius: args.radius }) }
      if (kind === 'shelter') return { ok: true, tool: 'shelter', label: goal.description, run: () => skills.shelter() }
      if (kind === 'corpse_run') return { ok: true, tool: 'corpse_run', label: goal.description, run: () => skills.corpseRun() }
      if (SIDE_KINDS.has(kind)) {
        if (typeof skills[kind] !== 'function') return { ok: false, why: `no way to re-run ${kind}` }
        return { ok: true, tool: kind, side: true, label: goal.description, run: () => skills[kind]({ ...args }) }
      }
      return { ok: false, why: 'this goal has no executable checkpoint; start it with the normal tools' }
    } catch (err) {
      return { ok: false, why: `its checkpoint no longer loads: ${String(err?.message || err).slice(0, 100)}` }
    }
  }

  /** The `goal` tool: the model's handle on its own objective list. */
  async function runGoalOp (action, snap = null) {
    const op = String(action.operation || 'list').toLowerCase()
    const wanted = String(action.id || action.description || '').trim()
    const goal = action.id ? goalReg.get(action.id) : (op === 'resume' || op === 'show' || op === 'cancel' || op === 'suspend' || op === 'complete' || op === 'verify' ? goalReg.find(wanted) : null)
    switch (op) {
      case 'list': {
        const open = goalReg.openGoals()
        const closed = goalReg.list({}).filter((g) => !['pending', 'active', 'suspended', 'resumable'].includes(g.status)).slice(0, 3)
        if (!open.length && !closed.length) return { ok: true, msg: 'no goals recorded yet — main tasks create them automatically; goal add records one that is not started yet' }
        const fmt = (g) => goalReg.describe(g)
        return { ok: true, msg: `goals (${open.length} open): ${open.map(fmt).join(' | ') || 'none open'}${closed.length ? ` || recently finished: ${closed.map(fmt).join(' | ')}` : ''}` }
      }
      case 'show': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        const view = goalReg.show(goal.id)
        return { ok: true, msg: view.line }
      }
      case 'add': {
        const desc = String(action.description || '').trim()
        if (!desc) return { ok: false, msg: 'goal add needs a description of the objective' }
        const defaultOrigin = (!action.origin && snap?.askedBy) ? 'player_requested' : 'self_generated'
        const rawOrigin = String(action.origin || defaultOrigin)
        const players = String(action.player || (rawOrigin === 'player_requested' && snap?.askedBy ? snap.askedBy : '')).split(',').map((s) => s.trim()).filter(Boolean)
        const originStr = rawOrigin === 'shared_project'
          ? `shared:${players.join(',') || 'players'}`
          : (rawOrigin === 'player_requested' && players[0] ? `player:${players[0]}` : 'self')
        const parentGoal = action.parent ? goalReg.get(action.parent) : null
        const g = goalReg.add({
          description: desc,
          kind: 'declared',
          origin: originStr,
          originType: ['self_generated', 'player_requested', 'shared_project'].includes(rawOrigin) ? rawOrigin : 'self_generated',
          participants: players,
          reason: action.reason || action.note || '',
          priority: action.priority ?? 50,
          parentId: parentGoal ? parentGoal.id : null,
          completion: 'the whole objective is done, not one step of it',
          resume: 'start it with the normal tools; compatible main tasks link to it as steps',
          detail: { declaredAt: Date.now() }
        })
        if (rawOrigin === 'shared_project') {
          for (const p of players) continuity.touchPlayer(p, { sharedGoal: true, interacted: true })
        }
        return { ok: true, msg: `goal ${g.id} recorded (${g.originType}): ${g.description}${g.parentId ? ` [subgoal of ${g.parentId}]` : ''}.` }
      }
      case 'update': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        const patch = {}
        if (action.description && action.id) patch.description = String(action.description)
        if (action.priority !== undefined) patch.priority = action.priority
        if (action.reason !== undefined) patch.reason = String(action.reason)
        if (action.parent !== undefined) patch.parentId = action.parent ? String(action.parent) : null
        if (action.origin) {
          const players = String(action.player || '').split(',').map((s) => s.trim()).filter(Boolean)
          patch.originType = action.origin
          if (players.length) patch.participants = players
          patch.origin = action.origin === 'shared_project'
            ? `shared:${(players.length ? players : goal.participants || ['players']).join(',')}`
            : (action.origin === 'player_requested' && players[0] ? `player:${players[0]}` : 'self')
        }
        if (action.note) patch.detail = { lastNote: String(action.note).slice(0, 140) }
        if (Object.keys(patch).length) goalReg.update(goal.id, patch)
        if (action.percent !== undefined || action.note !== undefined) {
          goalReg.progress(goal.id, { percent: action.percent, note: action.note })
        }
        return { ok: true, msg: `updated: ${goalReg.describe(goalReg.get(goal.id))}` }
      }
      case 'combine': {
        const ids = String(action.id || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
        if (ids.length < 2) return { ok: false, msg: 'goal combine needs at least two comma-separated goal ids in `id` (e.g. "g1,g2")' }
        for (const gid of ids) stopGoalIfRunning(gid)
        const merged = goalReg.combine(ids, {
          description: action.description,
          reason: action.reason || action.note,
          priority: action.priority
        })
        if (!merged) return { ok: false, msg: `could not combine "${action.id}" — need at least two open goals` }
        return { ok: true, msg: `combined [${ids.join(', ')}] into ${merged.id}: ${goalReg.describe(merged)}` }
      }
      case 'verify': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        const before = goal.status
        const verdict = reconcileGoal(goalReg.get(goal.id))
        const after = goalReg.get(goal.id)
        return { ok: verdict.state !== 'invalid', msg: `${after.id} (was ${before}, now ${after.status}): ${verdict.note}` }
      }
      case 'suspend': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        stopGoalIfRunning(goal.id)
        const r = goalReg.suspend(goal.id, { reason: action.note ? String(action.note).slice(0, 100) : 'suspended by the model', by: 'model' })
        return r.ok ? { ok: true, msg: `${goal.id} suspended: ${goal.description}` } : { ok: false, msg: r.why }
      }
      case 'cancel': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        stopGoalIfRunning(goal.id)
        const r = goalReg.cancel(goal.id, { reason: action.note ? String(action.note).slice(0, 100) : 'cancelled by the model' })
        return r.ok ? { ok: true, msg: `${goal.id} cancelled; it will not come back on its own: ${goal.description}` } : { ok: false, msg: r.why }
      }
      case 'complete': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        stopGoalIfRunning(goal.id)
        // A redstone goal that was verified incomplete (or never verified) is
        // not completed just because the model says so.
        const detail = goalReg.get(action.id)?.detail || {}
        if (detail.redstoneVerified === null && detail.redstoneVerificationFailed) {
          return report('goal', { ok: false, msg: `goal ${action.id} NOT completed: its redstone failed functional verification — diagnose, fix and verify again first` }, { wake: true })
        }
        const r = goalReg.complete(goal.id, { note: action.note ? String(action.note).slice(0, 100) : 'marked complete by the model' })
        return r.ok ? { ok: true, msg: `${goal.id} completed: ${goal.description}` } : { ok: false, msg: r.why }
      }
      case 'resume': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        if (!['pending', 'active', 'suspended', 'resumable', 'failed'].includes(goal.status)) {
          return { ok: false, msg: `${goal.id} is ${goal.status}; it cannot be resumed` }
        }
        if (goal.status === 'active' && agenda.main?.goalId === goal.id) return { ok: true, msg: `${goal.id} is already running: ${goalReg.describe(goal)}` }
        // Always look at the world before continuing an old plan.
        const verdict = reconcileGoal(goalReg.get(goal.id))
        const fresh = goalReg.get(goal.id)
        if (!fresh) return { ok: false, msg: `goal ${goal.id} disappeared` }
        if (fresh.status === 'completed') return { ok: true, msg: `${fresh.id} needed no work: ${verdict.note}` }
        if (fresh.status === 'cancelled') return { ok: false, msg: `${fresh.id} was cancelled` }
        if (verdict.state === 'invalid') return { ok: false, msg: `${fresh.id} cannot be resumed: ${verdict.note}. Replan it (a new goal) or cancel it.` }
        if (verdict.state === 'unknown' && fresh.status === 'failed') {
          return { ok: false, msg: `${fresh.id} failed and cannot be checked from here (${verdict.note}); look at it first (goal show ${fresh.id}) and decide whether to retry` }
        }
        const spec = runFromDetail(fresh)
        if (!spec.ok) {
          const r = goalReg.resume(fresh.id, { reason: 'resume requested' })
          return r.ok
            ? { ok: true, msg: `${fresh.id} is active again: ${fresh.description}. ${spec.why}; start it with the normal tools.` }
            : { ok: false, msg: r.why }
        }
        if (spec.side && agenda.main) {
          startSide(spec.tool, spec.run, { describe: spec.label, detail: fresh.detail, goalId: fresh.id })
          return { ok: true, msg: `resuming ${fresh.id} as a side job (the current task waits): ${spec.label}` }
        }
        startMain({ tool: spec.tool, label: spec.label, goalId: fresh.id, detail: fresh.detail, askedBy: fresh.origin.startsWith('player:') ? fresh.origin.slice(7) : null, run: spec.run, priority: fresh.priority })
        return { ok: true, msg: `resuming ${fresh.id}: ${spec.label}${verdict.state === 'partial' ? ` (${verdict.note})` : ''}` }
      }
      default:
        return { ok: false, msg: `unknown goal operation "${op}" (list|show|add|resume|suspend|cancel|complete|update|verify)` }
    }
  }

  /** Stop the body if this goal is the one running: a cancelled goal must not keep working. */
  function stopGoalIfRunning (goalId) {
    if (agenda.main?.goalId === goalId) {
      agenda.main = null
      try { skills?.cancel('goal changed') } catch { /* noop */ }
      try { executor?.cancel() } catch { /* noop */ }
    } else if (agenda.main?.paused && agenda.main.goalId === goalId) {
      agenda.main = null
    }
  }

  /**
   * Periodic goal upkeep: no-progress detection, blocked tasks, starvation of
   * waiting objectives, and a throttled save. Runs locally — the model is only
   * woken when a decision is actually needed.
   */
  function goalTick () {
    const now = Date.now()
    try { goalReg.maybeSave() } catch { /* best effort */ }
    for (const goal of goalReg.stalled({ stallMs: GOALS.stallMs ?? 180_000, remindMs: GOALS.remindMs ?? 300_000, now })) {
      if (goal.id !== agenda.main?.goalId) continue // only the objective that is actually running
      goalReg.noteStall(goal.id, now)
      const secs = Math.round((now - goal.progressAt) / 1000)
      note({ type: 'goal', msg: `no progress on ${goal.description} for ${secs}s` })
      brain?.wake(`no progress on ${goal.id} ${goal.description} for ${secs}s${goal.progress?.note ? ` (last checkpoint: ${goal.progress.note})` : ''} — check it with goal verify ${goal.id}, then keep it, replan or cancel it`, { external: true })
    }
    const running = agenda.main?.goalId ? goalReg.get(agenda.main.goalId) : null
    if (running && running.status === 'active' && running.fails >= (GOALS.maxFails ?? 3) && now - running.progressAt > (GOALS.stallMs ?? 180_000)) {
      goalReg.suspend(running.id, { reason: `blocked after ${running.fails} failed attempts (${running.lastError || 'no progress'})`, by: 'monitor' })
      goalReg.update(running.id, { needsVerify: true })
      agenda.main = null
      try { skills?.cancel('blocked') } catch { /* noop */ }
      try { executor?.cancel() } catch { /* noop */ }
      note({ type: 'goal', msg: `${running.id} suspended: blocked after repeated failures` })
      brain?.wake(`${running.id} looks blocked (${running.fails} failures, no progress: ${running.lastError || 'unknown'}); it is suspended. Check the world before resuming, or cancel it`, { external: true })
    }
    // A waiting objective must not starve silently when nothing is running.
    if (!agenda.main && !combat?.isEngaged && !skills?.current()) {
      const waiting = goalReg.waiting({ now, minAgeMs: GOALS.starveMs ?? 300_000 })[0]
      const lastNudge = Number(waiting?.detail?.starveNudgedAt) || 0
      if (waiting && now - lastNudge > (GOALS.starveRemindMs ?? 600_000)) {
        goalReg.update(waiting.id, { detail: { starveNudgedAt: now } })
        brain?.wake(`unfinished goal ${waiting.id} "${waiting.description}" has been waiting ${Math.round((now - (waiting.suspendedAt || waiting.updatedAt || waiting.createdAt)) / 60000)} min; resume it (goal resume ${waiting.id}) or cancel it`, { external: true })
      }
    }
  }

  /**
   * Re-check restored objectives against the world once the chunks are there.
   * A completion event that never got saved, or a chest emptied overnight,
   * becomes visible here instead of being rediscovered mid-task.
   */
  function reconcileRestored () {
    if (!goalReg.openGoals().length) return 0
    let checked = 0
    let completed = 0
    let invalid = 0
    for (const goal of goalReg.openGoals().slice(0, 6)) {
      if (!['build', 'build_shape', 'gather', 'go_to', 'follow', 'take', 'put'].includes(goal.kind)) continue
      const d = goal.detail || {}
      if (d.dim && d.dim !== dim()) continue // a nether trip must not "complete" an overworld build
      if (d.at && here() && Math.hypot(d.at[0] - here().x, d.at[2] - here().z) > (GOALS.verifyRadius ?? 64)) continue
      const verdict = reconcileGoal(goalReg.get(goal.id))
      checked++
      if (verdict.state === 'complete') completed++
      if (verdict.state === 'invalid') invalid++
    }
    if (checked) logger.info(TAG, `goals: re-checked ${checked} restored objective(s) against the world — ${completed} already done, ${invalid} no longer valid`)
    return checked
  }

  /**
   * Run long work in the background; the model is told how it ended.
   * `showAs` labels work that is not a Skill (builds, scripts) in "doing:".
   * `main` / `seq` mark the agenda's main task; `side` a job it is paused for.
   */
  function background (label, promise, { showAs = null, main = null, seq = 0, side = false, goalId = null, actId = null } = {}) {
    const id = ++taskSeq
    if (showAs) task = { id, label: showAs, startedAt: Date.now() }
    Promise.resolve(promise)
      .then((r) => r, (err) => ({ ok: false, msg: String(err?.message || err) }))
      .then((r) => {
        if (task?.id === id) task = null
        if (main) {
          // An earlier run of this task, or a task the agenda no longer holds: not news.
          if (agenda.main !== main || main.seq !== seq) return
          // Cancelled to make room for a side job: it will be launched again.
          if (main.paused) return
          agenda.main = null
          finishGoal(main.goalId, r)
        } else if (goalId) {
          finishGoal(goalId, r)
        }
        if (!combat?.isEngaged) system1?.clearDecision()
        // Replaced by the model's own next instruction: not news.
        if (/\b(replaced|paused)\b/.test(String(r?.msg || ''))) { if (side) resumeMain(label); return }
        // "No path" has a reason more often than not: say it.
        const jam = wrapper.lastJam
        if (label === 'go_to' && r && !r.ok && jam && Date.now() - jam.at < 30_000) {
          r = { ...r, msg: `${r.msg} — the ${jam.name} at ${jam.x},${jam.y},${jam.z} would not open (locked or protected); there may be another way in` }
        }
        const resumedMain = side ? resumeMain(label) : false
        // Avoid redundant LLM wakes when:
        //  - `sleep` succeeded (the `wake` morning event wakes us once night passes),
        //  - `eat` succeeded (eating food does not need a strategic round-trip),
        //  - a non-informational side chore succeeded and already resumed `agenda.main`.
        const quietSuccess = Boolean(r?.ok) && (label === 'sleep' || label === 'eat' || (resumedMain && !INFORMATIONAL.has(label)))
        report(label, r, { wake: !quietSuccess, actId })
      })
  }

  /**
   * The model started something new: whatever the body was doing ends. That
   * includes a fight — the newest decision wins, and the model can always
   * attack again. (The attack tool itself keeps its fight, of course.)
   */
  function replaceTask ({ keepFight = false } = {}) {
    try { skills?.cancel('replaced') } catch { /* noop */ }
    try { executor?.cancel() } catch { /* noop */ }
    if (!keepFight) leaveFight('new task')
  }

  /** End the current fight without a report: the model asked for it. @returns the opponent entity, if any */
  function leaveFight (reason) {
    const opponent = combat?.target || null
    const was = fight
    fight = null // first: the disengage event below must not be reported as a result
    if (combat?.isEngaged) combat.disengage(reason, { cooldown: false })
    return was ? opponent : null
  }

  /**
   * The model answered while threats were on screen: it has decided about
   * them — all the ones it was shown, near or still approaching. The decision
   * lasts as long as the task it belongs to (background() clears it), not a
   * fixed minute: a bot that bolts 60 s into a walk it was told to make is
   * worse than one that never obeyed.
   */
  function decided (snap, opts) {
    const ids = snap?.threatIds || []
    if (ids.length) system1?.acknowledge(ids, opts)
    return { ids, opts }
  }

  // ---------------------------------------------------------- prompts ----
  function doingLine () {
    const parts = []
    if (bot.isSleeping) parts.push('sleeping')
    if (combat?.isEngaged) parts.push(`fighting ${fight?.label || combat.wantedName || 'target'}${fight?.kills ? ` (${fight.kills} down)` : ''}`)
    const cur = skills?.current()
    const main = agenda.main && !agenda.main.paused ? agenda.main : null
    const asker = main?.askedBy ? `, asked by ${main.askedBy}` : ''
    if (cur) parts.push(`${cur.label} (${cur.seconds}s${asker})${cur.paused ? ' — paused while the body flees, resumes by itself after' : ''}`)
    else if (task) parts.push(`${task.label} (${Math.round((Date.now() - task.startedAt) / 1000)}s${asker})`)
    if (system1?.fleeing) parts.push('FLEEING by reflex')
    return `doing: ${parts.length ? parts.join('; ') : 'nothing'}`
  }

  /** The escape route as the reflex sees it right now (wall-aware), or null. */
  function routeNow () {
    const plan = system1?.fleeing ? system1._flee?.plan : null
    return plan && plan.why !== 'vector' ? { cornered: Boolean(plan.cornered), why: plan.why } : null
  }

  /**
   * Everything about danger in one block: who is coming (one count, by type),
   * how hard they press, which ways are open, what a fight would cost — then
   * what the body is doing about it and what the model may decide.
   */
  function threatLines () {
    const coming = sense.coming()
    const reflex = system1?.reflexLine() || null
    if (!coming.length) return reflex ? ['threats: none', `reflex: ${reflex}`] : ['threats: none']
    const picture = tactics.situation(bot, coming, { canRun: (dir) => clearToRun(bot, dir, { blocks: 4 }) })
    const [head, ...rest] = tactics.describeSituation(picture, { route: routeNow() })
    const lines = [`threats: ${head}`, ...rest.map((l) => '  ' + l)]
    if (reflex) lines.push(`  reflex: ${reflex}`)
    if (system1?.fleeing) lines.push('  decide: idle = keep fleeing | attack = fight | go_to / follow = go there instead | hold = stop running, they are harmless or accepted')
    else if (combat?.isEngaged) lines.push('  you chose to fight.')
    else {
      const d = system1?.decisionLine()
      lines.push(d ? `  ${d}.` : '  not close enough to make the body run yet.')
    }
    return lines
  }

  /** The same facts for the chat voice, short: who is there, and what the body is doing about it. */
  function threatBrief () {
    const coming = sense.coming()
    const reflex = system1?.reflexLine() || null
    const out = []
    const picture = coming.length ? tactics.situation(bot, coming) : null
    out.push(picture ? `threats: ${tactics.describeSituation(picture)[0]}` : 'threats: none')
    if (reflex) out.push(`reflex: ${reflex}`)
    return out
  }

  /** Why each hostile that is NOT coming at the bot is not a threat. */
  function hostileNotes () {
    const notes = new Map()
    for (const t of sense.last.hidden || []) notes.set(t.id, t.caged ? 'hostile, shut in — cannot reach you' : 'hostile, no line on you')
    return notes
  }

  function chatLines (max = 6) {
    return shared.chatLog.slice(-max).map((l) => `  ${l.who === 'me' ? 'you' : l.who}: ${l.text}`).join('\n')
  }

  function coreIdentity () {
    const creator = cfg.identity?.creator || {}
    const name = String(creator.name || '').trim().slice(0, 40)
    const uuid = String(creator.uuid || '').trim().slice(0, 40)
    if (!name && !uuid) return null
    return `operator config: ${name || 'name unknown'}${uuid ? ` (UUID ${uuid})` : ''} — not independently authenticated and carries NO automatic authority over your goals, priorities, or relationships (requests remain optional proposals).`
  }

  function buildActionPrompt (reasons) {
    const pos = here()
    sense.assess()
    try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* partial world */ }
    try { continuity.observeEnvironment(bot, places) } catch { /* partial world */ }
    // Everything shown as coming at the bot is what a decision this turn is
    // about — and everything the body is running from right now, including
    // the ones that slipped behind a corner a moment ago (they are not in the
    // threat block, and "hold" used to leave the bot running from them).
    const threatIds = [...new Set([...sense.last.dangerIds, ...(system1?.chasers || []).map((t) => t.id)])]
    const mode = wrapper.mode || 'explorer'
    continuity.currentState.mode = mode
    const nearby = pos ? places.describeNearby(pos, { dim: dim() }) : ''
    const named = pos ? places.describeNamed(pos, { dim: dim() }) : ''
    // Build a grounded recall query: recent chat request if present, otherwise
    // active goals + nearby places/players + personal interests so long-term
    // memory works during unprompted autonomous operation and after resets!
    const lastChat = shared.chatLog.filter((l) => l.who !== 'me').slice(-1)[0]
    const chatRecallAgeMs = cfg.memory.chatRecallMaxAgeMs ?? 120_000
    const chatQuery = [...reasons].reverse().find((r) => /^chat request/.test(r)) ||
      (lastChat && Date.now() - lastChat.ts <= chatRecallAgeMs ? lastChat.text : '')
    const autoQuery = chatQuery || [
      ...goalReg.openGoals().slice(0, 2).map((g) => g.description),
      ...Object.keys(bot.players || {}).filter((n) => n !== bot.username && bot.players[n]?.entity?.position).slice(0, 2),
      ...(continuity.identity.interests || []).slice(0, 2),
      named.slice(0, 80)
    ].filter(Boolean).join(' ')
    const recalled = memory.recallBlock(autoQuery, cfg.memory.topK ?? 3)
    const prefs = memory.preferencesLine()
    const chat = chatLines()
    const res = results.slice(-4).map((r) => `  - ${r.label}: ${r.ok ? '' : 'FAILED — '}${r.msg}`).join('\n')
    const events = memory.working.last(6)
      .filter((e) => !OWN_SECTION.has(e.type))
      .map((e) => `  - ${e.type}: ${e.text || e.msg || ''}${e.count > 1 ? ` (x${e.count})` : ''}`).join('\n')
    // Timestamped perception window: what happened, when (occurrence vs
    // observation), where, to whom, and whether it was seen or only inferred.
    const perceived = pipeline.formatForPrompt({ max: 8, excludeTypes: OWN_SECTION })
    if (perceived.shownSequences.length) {
      try { pipeline.markProcessed(perceived.shownSequences, { via: 'model' }) } catch { /* noop */ }
    }
    const ephItems = (memory.ephemeral?.snapshot?.() || [])
      .filter((e) => !OWN_SECTION.has(e.type) && (e.text || e.msg))
      .slice(-4)
      .map((e) => String(e.text || e.msg))
    const justNow = ephItems.length ? `just now: ${ephItems.join('; ').slice(0, 220)}` : null
    const visibleFacts = Object.entries(bot.players || {}).filter(([name, p]) => name !== bot.username && p?.entity?.position).slice(0, 3).flatMap(([name]) => memory.factsAbout(name, 2).map((f) => `${name}: ${f}`))
    const liveResultIds = new Set(results.slice(-4).map((r) => r.actId).filter(Boolean))
    const relevantPlayers = [
      ...Object.keys(bot.players || {}).filter((n) => n !== bot.username),
      ...agenda.asked.map((x) => x.from),
      ...goalReg.openGoals().flatMap((g) => g.participants || [])
    ]
    const continuityBlock = continuity.describeForPrompt(bot, { places, liveResultIds, relevantPlayers })
    const shownActionIds = [
      ...continuity.undeliveredActions().map((a) => a.id),
      ...(continuity.currentState.interruptedAction ? [continuity.currentState.interruptedAction.id] : [])
    ]
    const shownProposals = agenda.asked.map((x) => ({ ...x }))
    const lines = [
      coreIdentity(),
      continuityBlock || null,
      visibleFacts.length ? `visible player memories (name-based, unverified): ${visibleFacts.join(' | ')}` : null,
      observe.selfLine(bot, { mode }),
      observe.inventoryLine(bot),
      doingLine(),
      agendaLine(),
      goalLines(),
      ...threatLines(),
      observe.playersLine(bot),
      observe.mobsLine(bot, { threatIds: sense.last.dangerIds, notes: hostileNotes() }),
      nearby ? `nearby:\n${nearby.split('\n').map((l) => '  ' + l).join('\n')}` : 'nearby: no chests, furnaces or beds seen within 24 blocks',
      named ? `places: ${named}` : null,
      prefs || null,
      recalled || null,
      chat ? `chat (recent):\n${chat}` : null,
      res ? `results (your last actions):\n${res}` : null,
      events ? `events:\n${events}` : null,
      perceived.text ? `perceived (timestamped; [NEW] = not yet delivered, "(scanned_diff)" = you discovered it late, exact time unknown):\n${perceived.text}` : null,
      failGate.advisoryLine(pos) || null,
      justNow,
      `why now: ${reasons.join('; ')}`
    ]
    if (mode === 'builder') {
      try { lines.push(`grid (builder mode; legend: ${VISION_LEGEND}):\n${buildVisionBlock(bot, { mode, range: 6, radius: 6, heightUp: 5, heightDown: 2 })}`) } catch { /* cosmetic */ }
    }
    // Who asked for what this turn is about (the newest chat request among the reasons).
    const asked = /^chat request from (\S+?):/.exec([...reasons].reverse().find((r) => /^chat request from /.test(r)) || '')
    return {
      text: lines.filter(Boolean).join('\n'),
      threatIds,
      askedBy: asked ? asked[1] : null,
      reasons,
      shownActionIds,
      shownProposals,
      // Which objective this snapshot was taken for: a delayed answer about
      // one objective must not act on another (see staleActionReason).
      goalId: agenda.main && !agenda.main.paused ? (agenda.main.goalId || null) : null
    }
  }

  function buildChatPrompt (sender, incoming) {
    const pos = here()
    if (pos) { try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* partial world */ } }
    const nearby = pos ? places.describeNearby(pos, { dim: dim() }) : ''
    const named = pos ? places.describeNamed(pos, { dim: dim() }) : ''
    const history = convoOf(sender).slice(0, -incoming.length || undefined).slice(-8)
      .map((l) => `  ${l.who === 'me' ? 'you' : sender}: ${l.text}`).join('\n')
    const latest = incoming.map((l) => `${l.whisper ? '(whisper) ' : ''}${l.text}`).join(' / ')
    const recalled = memory.recallBlock(latest, cfg.memory.topK ?? 3)
    const prefs = memory.preferencesLine(sender)
    // What this player told the bot before, in the model's own words.
    const known = memory.factsAbout(sender, cfg.memory.factsPerPlayer ?? 6)
    const relLine = continuity.formatRelationship(sender)
    const events = memory.working.last(4)
      .filter((e) => !OWN_SECTION.has(e.type))
      .map((e) => `${e.type}: ${e.text || e.msg || ''}`).join(' | ')
    const lines = [
      coreIdentity(),
      observe.selfLine(bot, { mode: wrapper.mode || 'explorer' }),
      observe.inventoryLine(bot, { max: 16 }),
      doingLine(),
      agendaLine(),
      goalBriefLine(),
      `relationship with ${relLine}`,
      ...threatBrief(),
      observe.playersLine(bot),
      nearby ? `nearby: ${nearby.split('\n').join(' | ')}` : null,
      named ? `places: ${named}` : null,
      events ? `recent events: ${events}` : null,
      prefs || null,
      known.length ? `you know from ${sender}:\n${known.map((t) => `  - ${t}`).join('\n')}` : null,
      recalled || null,
      history ? `conversation with ${sender} so far:\n${history}` : null,
      `${sender} says: ${latest}`
    ]
    return lines.filter(Boolean).join('\n')
  }

  // ------------------------------------------------------- model turns ---
  /** Read-only / setup actions that inspect state before deciding on a pending player proposal. */
  function isPreDecisionInspect (action) {
    if (!action) return false
    const a = String(action.a || '')
    if (['look_in', 'inspect_block', 'inspect_region', 'redstone_scan', 'redstone_component', 'redstone_engineer', 'recall', 'find', 'set_mode', 'equip', 'eat'].includes(a)) return true
    if (a === 'social' && ['list', 'show'].includes(String(action.operation || 'list'))) return true
    if (a === 'goal' && ['list', 'show', 'verify'].includes(String(action.operation || 'list'))) return true
    return false
  }

  // one metrics JSONL line per model call — the usage numbers in
  // this repo's cost tables stop being estimates the first time this runs
  // against a live endpoint that reports them.
  let metricsWarned = false
  function logUsage (lane, why, usage, ms, tool) {
    try {
      if (!usage) return
      const row = {
        ts: new Date().toISOString(), lane, tool: tool || null,
        why: String(why || '').slice(0, 80),
        in: usage.prompt_tokens ?? usage.promptTokens ?? null,
        out: usage.completion_tokens ?? usage.completionTokens ?? null,
        cached: usage.cached_tokens ?? usage.cachedTokens ?? usage.prompt_tokens_details?.cached_tokens ?? null,
        ms: Number.isFinite(ms) ? ms : null
      }
      fs.appendFileSync(path.join(shared.dataDir || DATA_DIR, 'metrics.jsonl'), JSON.stringify(row) + '\n')
    } catch (err) {
      if (!metricsWarned) { metricsWarned = true; logger.warn(TAG, `metrics log unavailable: ${err.message || err}`) }
    }
  }
  // per-mode tool schemas (cached; one JSON per mode so prefix
  // caching still sees a stable schema block within a mode).
  const modeToolsCache = new Map()
  function modeTools (mode) {
    const m = ['explorer', 'hunter', 'builder'].includes(mode) ? mode : 'explorer'
    if (!modeToolsCache.has(m)) modeToolsCache.set(m, createZincTools({ mode: m }))
    return modeToolsCache.get(m)
  }

  async function act (reasons, meta = null) {
    if (!alive || ended) return { idle: true }
    const snap = buildActionPrompt(reasons)
    const epoch = decisionEpoch
    const life = lifeEpoch
    logger.debug(TAG, `action turn (${reasons.join(' | ')})`)
    // the action lane ships only the tools the current mode can
    // use (build tools only in builder mode) — a smaller schema block per call.
    const tools = modeTools(wrapper.mode || 'explorer')
    const t0 = Date.now()
    const invokeMono = performance.now()
    if (meta && Number.isFinite(meta.queuedMono)) {
      latency.record('queueToModelMs', Math.max(0, (meta.invokeMono || invokeMono) - meta.queuedMono))
    }
    const { action, usage } = await amd.chatWithTools([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: snap.text }
    ], tools)
    latency.record('modelInferenceMs', performance.now() - invokeMono)
    logUsage('action', reasons.join(' | '), usage, Date.now() - t0, action?.a)
    if (ended) return { idle: true }
    if (epoch !== decisionEpoch) {
      const context = life === lifeEpoch ? reasons.join('; ') : 'previous life ended; reassess after respawn'
      brain.wake(`decision discarded: situation changed while thinking; reassess. ${context}`, { external: true })
      return { idle: false }
    }
    // The model successfully received all action outcomes included in this snapshot.
    if (snap.shownActionIds?.length) {
      continuity.markActionsDelivered(snap.shownActionIds)
    }
    await executeAction(action, snap)
    // Player requests are optional proposals. Once Zinc has completed a non-inspect
    // decision turn where a proposal was presented — whether accepting, scheduling
    // via `goal`, negotiating/declining via `say` or `social`, ignoring via `idle`,
    // or continuing its own work — resolve that proposal cleanly without nagging or
    // retrying until compliance!
    if (snap.shownProposals?.length && !isPreDecisionInspect(action) && !action._prose && !action._unknownTool && !action._badArgs && !action._fallback) {
      const shownIds = new Set(snap.shownProposals.map((p) => p.id).filter(Boolean))
      agenda.asked = agenda.asked.filter((x) => x.id ? !shownIds.has(x.id) : !snap.shownProposals.some((p) => p.from === x.from && p.text === x.text))
      continuity.resolvePendingEvents((e) => e.kind === 'player_request' && !agenda.asked.some((x) => x.from === e.from && x.text === e.text))
      for (const p of snap.shownProposals) {
        if (action.a === 'social' && action.decision && (!action.player || action.player.toLowerCase() === p.from.toLowerCase())) continue
        const existingRel = continuity.getRelationship(p.from)
        if (existingRel?.lastProposal?.explicit && (Date.now() - (existingRel.lastProposal.at || 0)) < 30_000) continue
        const actedForThem = resolveActionAttribution(action.a, action, { ...snap, askedBy: p.from }) === p.from &&
          !['idle', 'say', 'note', 'social', 'stop', 'hold'].includes(action.a) &&
          !(action.a === 'goal' && ['resume', 'suspend', 'cancel', 'complete'].includes(String(action.operation || '')) && goalReg.get(action.id || '')?.origin === 'self')
        const inferred = actedForThem
          ? 'accept'
          : (action.a === 'say' ? 'responded' : (action.a === 'idle' ? 'ignore' : 'prioritized_own_goal'))
        continuity.recordProposalOutcome(p.from, p.text, inferred, action.a === 'say' ? String(action.text || '') : action.a)
      }
    }
    return { idle: action.a === 'idle' && !action._prose }
  }

  async function talk (sender, lines, meta = null) {
    const text = buildChatPrompt(sender, lines)
    const messages = [
      { role: 'system', content: CHAT_PROMPT },
      { role: 'user', content: text }
    ]
    const maxTokens = cfg.inference.chatMaxTokens ?? 120
    const tChat0 = Date.now()
    const chatInvokeMono = performance.now()
    if (meta && Number.isFinite(meta.queuedMono)) {
      latency.record('queueToModelMs', Math.max(0, (meta.invokeMono || chatInvokeMono) - meta.queuedMono))
      latency.record('architectureOverheadMs', Math.max(0, (meta.invokeMono || chatInvokeMono) - meta.queuedMono))
    }
    const epoch = lifeEpoch
    let { reply, usage: chatUsage } = await amd.chatReply(messages, { maxTokens })
    latency.record('modelInferenceMs', performance.now() - chatInvokeMono)
    if (ended || epoch !== lifeEpoch) return
    logUsage('chat', `${sender}: ${lines.map((l) => l.text).join(' / ').slice(0, 60)}`, chatUsage, Date.now() - tChat0, 'reply')
    // Language guard: one more try with a plain instruction, then a fixed line.
    if (reply.text && !inLanguage(reply.text)) {
      logger.warn(TAG, `chat reply was not ${LANGUAGE} ("${reply.text.slice(0, 80)}") — asking once more`)
      brain?.spent?.('chat')
      try {
        const again = await amd.chatReply([
          ...messages,
          { role: 'assistant', content: reply.text },
          { role: 'user', content: 'That reply was not in Brazilian Portuguese. Call reply again: the same meaning in informal Brazilian Portuguese (PT-BR), nothing else changed.' }
        ], { maxTokens })
        reply = {
          ...again.reply,
          task: again.reply.task || reply.task,
          decision: again.reply.decision || reply.decision,
          remember: again.reply.remember || reply.remember
        }
      } catch (err) { logger.debug(TAG, `language retry failed: ${err.message || err}`) }
      if (reply.text && !inLanguage(reply.text)) reply = { ...reply, text: reply.task ? 'peraí, deixa eu ver aqui' : 'foi mal, me enrolei aqui kkk' }
    }
    if (ended || epoch !== lifeEpoch) return
    const whisper = lines.some((l) => l.whisper)
    if (reply.text) speak(reply.text, { to: whisper ? sender : null, about: sender })
    if (reply.remember) {
      const kept = memory.rememberFact(reply.remember, { about: sender })
      if (kept) logger.info(TAG, `remembered (from ${sender}): ${kept.text}`)
    }
    continuity.touchPlayer(sender, { interacted: true })
    const incomingSummary = lines.map((l) => l.text).join(' / ').slice(0, 120)
    if (reply.decision && !reply.task) {
      continuity.recordProposalOutcome(sender, incomingSummary, reply.decision, reply.text || '', { explicit: true })
    }
    if (reply.task) {
      // Player requests are proposals, never hard preemptions over Zinc's own in-flight thinking.
      const propId = `prop_${++proposalSeq}`
      note({ type: 'request', sender, text: `${sender} proposed: ${reply.task}` })
      agenda.asked.push({ id: propId, from: sender, text: reply.task, at: Date.now() })
      if (agenda.asked.length > 8) agenda.asked.shift()
      continuity.addPendingEvent({ kind: 'player_request', from: sender, text: reply.task })
      brain.wake(`chat request from ${sender}: ${reply.task}`, { external: true, urgent: false })
    }
    logger.info(TAG, `chat ${sender}: "${lines.map((l) => l.text).join(' / ').slice(0, 80)}" -> ${reply.text ? `"${reply.text.slice(0, 80)}"` : '(silent)'}${reply.task ? ` [task: ${reply.task.slice(0, 60)}]` : ''}`)
  }

  // ------------------------------------------------------------ fights ---
  function endFight (okFlag, text) {
    fight = null
    system1?.clearDecision()
    report('fight', { ok: okFlag, msg: text }, { wake: true })
    resumeMain('the fight')
  }

  function onCombatEvent (evt) {
    note({ type: 'combat', msg: evt.msg })
    if (!evt.result) return
    const f = fight
    if (!f) return
    if (evt.result === 'won') {
      f.kills++
      // "attack zombie" means the zombies, not one zombie: take the next one of
      // the same kind without another model call — for HOSTILE mobs. An animal
      // is one animal unless a count was given ("attack cow" beside a pen used
      // to empty the pen). Never chained for players.
      if (!f.player && f.kills < f.limit && Number(bot.health) > combat.disengageAt + 2) {
        combat.engage(f.request, { explicitPlayersOnly: true }).then((r) => {
          if (fight !== f) return
          if (r.ok) note({ type: 'combat', msg: `next ${r.target}` })
          else endFight(true, `${f.label} down${f.kills > 1 ? ` (${f.kills} killed)` : ''}; no more in sight`)
        })
        return
      }
      return endFight(true, `${f.label} down${f.kills > 1 ? ` (${f.kills} killed)` : ''}`)
    }
    if (evt.result === 'lost') return endFight(false, `lost the ${f.label}: ${evt.msg}${f.kills ? ` (${f.kills} killed before)` : ''}`)
    return endFight(false, `${evt.msg} (hp ${Math.round(Number(bot.health ?? 0))})${f.kills ? `; ${f.kills} killed` : ''}`)
  }

  // ------------------------------------------------------------ builds ---
  async function buildBlocks (blocks, label, stage, at, { askedBy = null } = {}) {
    let origin
    if (Array.isArray(at) && at.length >= 3 && at.every((v) => Number.isFinite(Number(v)))) {
      origin = new Vec3(Math.trunc(Number(at[0])), Math.trunc(Number(at[1])), Math.trunc(Number(at[2])))
    } else {
      origin = bot.entity.position.floored()
    }
    const plan = parser.plan({ name: label, blocks }, origin, bot.entity.position)
    // Property respect check: never build over another player's claimed structure without authorization.
    if (plan.steps?.length) {
      for (const probe of [plan.steps[0], plan.steps[Math.floor(plan.steps.length / 2)], plan.steps[plan.steps.length - 1]]) {
        const g = continuity.propertyGuardAt(probe, dim(), { askedBy })
        if (!g.ok) {
          return { ok: false, msg: `refused to build ${label}: footprint overlaps ${g.reason} — move to clear ground or get permission first` }
        }
      }
    }
    const phaseBlocks = stage && plan.steps ? plan.steps.filter((s) => (s.phase || 'walls') === stage).map((s) => ({ name: s.name })) : blocks
    const preflight = parser.checkInventory(phaseBlocks, bot.inventory.items())
    if (!preflight.ok) {
      const missing = preflight.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')
      return { ok: false, msg: `cannot build ${label}${stage ? ' (' + stage + ')' : ''}: missing ${missing}. Gather them (gather) or ask a player, then call the same stage again — phases already placed do not redo.` }
    }
    logger.info(TAG, `${label} — ${plan.steps.length} blocks${stage ? ` (stage ${stage})` : ''}${plan.towerNeeded ? `, tower ${plan.towerHeight} high` : ''}`)
    const runningGoalId = agenda.main?.goalId || null
    const result = await executor.build(plan, {
      stage,
      onProgress: ({ placed, total }) => {
        if (runningGoalId && (placed === 1 || placed % 4 === 0 || placed === total)) {
          goalReg.progress(runningGoalId, { done: placed, total, note: `${placed}/${total} blocks` })
        }
      }
    })
    let scaffoldNote = ''
    if (cfg.build.autoRemoveScaffold !== false) {
      try {
        const { removed } = await executor.removeScaffolds()
        if (removed > 0) scaffoldNote = `, scaffold cleared ${removed}`
      } catch (err) { logger.warn(TAG, `scaffold cleanup failed: ${err.message || err}`) }
    }
    const phaseTotal = stage && plan.phaseCounts ? plan.phaseCounts[stage] : plan.steps.length
    const text = `build ${label}${stage ? ' (' + stage + ')' : ''}: completed ${result.placed}/${phaseTotal} (${result.placed - (result.alreadyPresent || 0)} newly placed${result.alreadyPresent ? `, ${result.alreadyPresent} already present` : ''})${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}${result.reason === 'cancelled' ? ', cancelled' : ''}${scaffoldNote}`
    if (result.placed > 0) {
      note({ type: 'build_complete', msg: text }, { promote: true })
      try {
        continuity.recordConstruction({
          label,
          steps: plan.steps.slice(0, Math.max(1, result.placed)),
          dim: dim(),
          origin: askedBy ? `player:${askedBy}` : 'self',
          askedBy
        })
      } catch { /* noop */ }
    }
    // The objective is complete only when every block of the phase is in
    // place — a loop that returned is not the same thing.
    return {
      ok: result.ok,
      msg: text,
      progress: { done: result.placed, total: phaseTotal, note: `${result.placed}/${phaseTotal} blocks` },
      complete: result.ok && Boolean(phaseTotal) && result.placed >= phaseTotal
    }
  }

  // ----------------------------------------------------------- executor --
  async function executeAction (action, snap) {
    const execStartMono = performance.now()
    const vanilla = assertVanillaAction(action)
    if (!vanilla.ok) {
      logger.warn(TAG, `refused non-vanilla action (${vanilla.why})`)
      return report(action.a || 'action', { ok: false, msg: `refused: ${vanilla.why} — you cannot run commands` })
    }
    const a = action.a
    // min: a guest (chat-asker outside the trust lists) may not
    // reach valuables or automation. Off when no lists are configured.
    const trustRefusal = trustCheck(a, action, snap?.askedBy)
    if (trustRefusal) return report(a, { ok: false, msg: trustRefusal })
    // the exact same call failed repeatedly seconds ago — refuse
    // it locally instead of running the world mutation again. No wake: the
    // quiet refusal shows up in the next natural prompt's results.
    if (a !== 'idle') {
      const blocked = failGate.check(action, here())
      if (blocked) return report(a, { ok: false, msg: blocked }, { wake: false })
    }
    // A decision generated for a situation that no longer exists must not act:
    // the model may have been thinking for a minute and a half.
    const stale = staleActionReason(action, snap)
    if (stale) {
      logger.info(TAG, `stale ${a} refused: ${stale.slice(0, 120)}`)
      return report(a, { ok: false, msg: stale }, { wake: false })
    }
    if (a !== 'idle') logger.info(TAG, `action: ${a} ${JSON.stringify(Object.fromEntries(Object.entries(action).filter(([k]) => !k.startsWith('_') && k !== 'a')))}`)
    // Take the lane this tool belongs to. BODY is exclusive, so a second
    // physical action cannot start while one is in flight; COMPUTATION,
    // INTERACTION and WORLD_INFO run alongside it. `tryAcquire` is used for
    // read-only tools (they must not queue behind a long walk) and `acquire`
    // for everything that has to be serialised. The lease is released in the
    // finally block of the executor wrapper below.
    let laneLease = null
    try {
      const lane = laneOf(a)
      if (lane === LANES.WORLD_INFO || lane === LANES.COMPUTATION) {
        laneLease = lanes.tryAcquire(a, { goalId: agenda.main?.goalId || null })
      } else {
        laneLease = await lanes.acquire(a, { goalId: agenda.main?.goalId || null })
      }
    } catch { laneLease = null }
    gateCtx = action
    const IMMEDIATE_TRACKED = new Set(['say', 'stop', 'hold', 'equip', 'redstone_scan', 'redstone_component', 'redstone_engineer', 'recall', 'circuit_project', 'logic_test', 'inspect_region', 'inspect_block', 'find', 'remember_here', 'note', 'social', 'goal', 'set_mode'])
    currentActId = IMMEDIATE_TRACKED.has(a)
      ? continuity.beginAction({ tool: a, summary: `${a} ${JSON.stringify(goalArgs(action)).slice(0, 80)}`, sig: `${a}:${JSON.stringify(goalArgs(action))}`, goalId: agenda.main?.goalId || null, args: goalArgs(action) })
      : null
    if (currentActId) actStartedMono.set(currentActId, execStartMono)
    if (actStartedMono.size > 32) actStartedMono.delete(actStartedMono.keys().next().value)
    try {
    switch (a) {
      case 'idle':
        // Prose, invalid tool calls, or empty tool-less responses used to vanish silently; tell the model once.
        if (action._prose) report('reply', { ok: false, msg: 'you answered in prose without calling a tool, so nothing happened — call a tool (say to talk)' })
        else if (action._unknownTool) report('reply', { ok: false, msg: `there is no tool "${action._unknownTool}"` })
        else if (action._badArgs) report('reply', { ok: false, msg: `arguments for ${action._badArgs} failed schema validation` })
        else if (action._fallback) report('reply', { ok: false, msg: 'you returned no tool call, so nothing happened — call exactly ONE listed tool (or idle to wait)' })
        return
      case 'say': {
        const text = String(action.t ?? action.text ?? '')
        if (text.trim() && !inLanguage(text)) {
          // Not the server's language: hold it back and ask again — once.
          const again = Date.now() - foreignSays.at < 60_000 ? foreignSays.n + 1 : 1
          foreignSays = { n: again, at: Date.now() }
          logger.warn(TAG, `say held back (not ${LANGUAGE}): "${text.slice(0, 80)}"`)
          return report('say', { ok: false, msg: again <= 1 ? `NOT SENT — "${text.slice(0, 60)}" is not Brazilian Portuguese. Say it again in informal PT-BR.` : 'not sent (still not Brazilian Portuguese); dropped' }, { wake: again <= 1 })
        }
        foreignSays = { n: 0, at: 0 }
        const said = speak(text, { to: action.to ? String(action.to) : null })
        if (!said) report('say', { ok: false, msg: 'empty text' })
        return
      }
      case 'move': // legacy name
      case 'go_to': {
        const target = { player: action.player, place: action.place, x: action.x, y: action.y, z: action.z }
        const where = action.player || action.place || (Number.isFinite(Number(action.x)) ? `${Math.round(Number(action.x))},${Math.round(Number(action.z))}` : 'somewhere')
        const askedBy = resolveActionAttribution('go_to', action, snap)
        return startMain({ tool: 'go_to', label: `go to ${where}`, askedBy, detail: goalDetailFor('go_to', target), decision: decided(snap, { label: 'go_to' }), run: () => skills.goTo(target) })
      }
      case 'dig': {
        const target = { player: action.player, place: action.place, x: action.x, y: action.y, z: action.z, materials: action.materials, avoid: action.avoid }
        const askedBy = resolveActionAttribution('dig', action, snap)
        if (Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.z))) {
          const g = continuity.propertyGuardAt({ x: Number(action.x), y: Number(action.y ?? here()?.y ?? 64), z: Number(action.z) }, dim(), { askedBy })
          if (!g.ok) return report('dig', { ok: false, msg: `refused to dig: destination is inside ${g.reason} — use go_to or get permission` })
        }
        const where = action.player || action.place || (Number.isFinite(Number(action.x)) ? `${Math.round(Number(action.x))},${Math.round(Number(action.z))}` : 'somewhere')
        const limit = Array.isArray(action.materials) && action.materials.length ? ` breaking only ${action.materials.join('/')}` : ''
        return startMain({ tool: 'dig', label: `dig to ${where}${limit}`, askedBy, detail: goalDetailFor('dig', target), decision: decided(snap, { label: 'dig' }), run: () => skills.dig(target) })
      }
      case 'follow': {
        const askedBy = resolveActionAttribution('follow', action, snap)
        return startMain({ tool: 'follow', label: `follow ${action.player}`, askedBy, detail: goalDetailFor('follow', { player: action.player }), decision: decided(snap, { label: 'follow', ttlMs: 30 * 60_000 }), run: () => skills.follow({ player: action.player }) })
      }
      case 'stop': {
        const duel = fight?.player ? combat?.target : null
        agenda.main = null
        agenda.asked = []
        // Cancelled is terminal: a late tool result cannot bring it back.
        try { goalReg.cancelAll({ reason: 'stop' }) } catch { /* best effort */ }
        replaceTask()
        system1.clearDecision()
        // A duel the model agreed to and then called off: the hits were part
        // of it, so the opponent is not somebody to run from afterwards.
        if (duel) sense.forgive(duel.id)
        return report('stop', { ok: true, msg: 'stop requested; in-progress actions or survival movement may continue' }, { wake: false })
      }
      case 'hold': {
        // "They are harmless or accepted": the body stops running from them. It
        // does NOT cancel what the bot was doing — a paused task resumes; `stop`
        // is the tool that ends a task. (It used to cancel, and to expire
        // silently two minutes later.)
        decided(snap, { label: 'hold', ttlMs: 30 * 60_000 })
        const n = snap.threatIds.length
        const cur = skills?.current()
        return report('hold', { ok: true, msg: n ? `no longer running from ${n} listed threat${n === 1 ? '' : 's'}${cur ? `; carrying on with ${cur.label}` : ''}. The body runs again if one of them hurts you, a fuse is lit, or something new shows up` : 'nothing to hold against (no threats listed)' }, { wake: false })
      }
      case 'attack': {
        const request = action.player
          ? { player: String(action.player) }
          : String(action.target ?? action.n ?? action.name ?? 'any').toLowerCase().trim()
        const r = await combat.engage(request, { explicitPlayersOnly: true })
        if (!r.ok) return report('attack', { ok: false, msg: ATTACK_WHY[r.why] || r.why })
        // A fight is a side job: the main task waits for it.
        if (pauseMain('a fight')) { try { skills?.cancel('paused') } catch { /* noop */ }; try { executor?.cancel() } catch { /* noop */ } } else replaceTask({ keepFight: true })
        const anyHostile = typeof request === 'string' && ['any', 'hostile', 'hostiles', 'mob'].includes(request)
        const isPlayerFight = typeof request === 'object'
        const wanted = Math.trunc(Number(action.count))
        const hostileKind = !isPlayerFight && (anyHostile || isHostileMob(r.target, bot))
        const limit = isPlayerFight ? 1 : (Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, 24) : (hostileKind ? (cfg.combat.maxChainKills ?? 6) : 1))
        fight = { request, label: r.target, kills: 0, player: isPlayerFight, limit }
        // Fighting zombies covers the zombies that arrive later, too — for as long as the fight lasts.
        system1.acknowledge(snap.threatIds, { types: fight.player || anyHostile ? [] : [r.target], all: anyHostile, ttlMs: 10 * 60_000, label: 'fight' })
        return report('attack', { ok: true, msg: `fighting ${r.target}` }, { wake: false })
      }
      // Short jobs: a main task (follow, go_to, a build) waits for them and resumes.
      case 'look_in':
        decided(snap, { label: 'look_in' })
        return startSide('look_in', () => skills.lookIn({ where: action.where }), sideOpts('look_in', action, snap))
      case 'take': {
        if (here() && places) {
          try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* noop */ }
          const entry = places.resolve(action.where || '', here(), { dim: dim() })
          const cg = continuity.containerTakeGuard(entry, dim(), { askedBy: snap?.askedBy })
          if (!cg.ok) return report('take', { ok: false, msg: `refused: ${cg.reason}` })
        }
        decided(snap, { label: 'take' })
        return startSide('take', () => skills.take({ item: action.item, count: action.count, where: action.where }), sideOpts('take', action, snap))
      }
      case 'put':
        decided(snap, { label: 'put' })
        return startSide('put', () => skills.put({ item: action.item, count: action.count, where: action.where }), sideOpts('put', action, snap))
      case 'smelt':
        decided(snap, { label: 'smelt' })
        return startSide('smelt', () => skills.smelt({ item: action.item, count: action.count, where: action.where }), sideOpts('smelt', action, snap))
      case 'sleep':
        decided(snap, { label: 'sleep' })
        return startSide('sleep', () => skills.sleep(), { ...sideOpts('sleep', action, snap), until: 'wake' })
      case 'give':
        decided(snap, { label: 'give' })
        return startSide('give', () => skills.give({ player: action.player, item: action.item, count: action.count }), sideOpts('give', action, snap))
      case 'use_block':
        decided(snap, { label: 'use_block' })
        return startSide('use_block', () => skills.useBlock({ what: action.what }), sideOpts('use_block', action, snap))
      case 'eat':
        return background('eat', skills.eat({ item: action.item }))
      case 'equip':
        return report('equip', await skills.equip({ item: action.item, where: action.where }), { wake: null })
      case 'redstone_engineer': {
        const started = performance.now()
        const res = await redstoneEngineer.act(action)
        latency.record('responseToExecMs', performance.now() - started)
        // Goal integration: a redstone build/repair earns progress from what was
        // actually placed, and the goal may only be COMPLETED after functional
        // verification — never from placement alone.
        const op = String(action.operation || '').toLowerCase()
        const gid = agenda.main?.goalId || null
        if (gid) {
          try {
            if (op === 'place' && Number.isFinite(res.plan?.placements?.length)) {
              goalReg.progress(gid, { total: res.plan.placements.length, percent: 70, note: `redstone placed: ${res.msg.slice(0, 80)}` })
            }
            if (op === 'verify') {
              if (res.verified) {
                goalReg.progress(gid, { percent: 100, note: `redstone functionally verified: ${res.msg.slice(0, 90)}` })
                goalReg.update(gid, { detail: { ...(goalReg.get(gid)?.detail || {}), redstoneVerified: Date.now(), redstoneVerificationFailed: null, verification: res.msg.slice(0, 160) } })
              } else {
                goalReg.recordFailure?.(gid, `redstone verification failed: ${res.msg.slice(0, 120)}`)
                goalReg.update(gid, { detail: { ...(goalReg.get(gid)?.detail || {}), redstoneVerified: null, redstoneVerificationFailed: Date.now() } })
              }
            }
          } catch (err) { logger.debug(TAG, `redstone goal progress: ${err.message || err}`) }
        }
        const verifiedNow = op === 'verify' && res.verified
        return report('redstone_engineer', res, verifiedNow ? { wake: false } : {})
      }
      case 'recall': {
        const near = [action.x, action.y, action.z].every(Number.isInteger)
          ? { x: action.x, y: action.y, z: action.z, dim: dim() }
          : null
        const res = memory.longTerm.retrieve({
          query: String(action.query || ''),
          category: ['episodic', 'semantic', 'procedural', 'continuity'].includes(String(action.category)) ? String(action.category) : null,
          entity: action.entity ? String(action.entity) : null,
          goalId: action.goal ? String(action.goal) : null,
          near,
          k: cfg.memory.topK ?? 4
        })
        const lines = res.entries.length
          ? res.entries.map((h) => `- [${h.category}${h.basis !== 'observed' ? `, ${h.basis}` : ''}${h.status !== 'active' ? `, ${h.status}` : ''} | score ${h.score}] ${memory.formatEntry(h)}`).join('\n')
          : `nothing relevant found — ${res.unknownReason}`
        const header = `recall "${String(action.query || '').slice(0, 60)}" (${res.entries.length}/${res.totalStoreSize} stored memories considered)`
        return report('recall', { ok: true, msg: `${header}\n${lines}` })
      }
      case 'redstone_scan':
        return report('redstone_scan', redstoneInspector.scan(action))
      case 'redstone_component':
        return report('redstone_component', redstoneInspector.inspect(action))
      case 'circuit_project':
        return report('circuit_project', circuitProjects.act(action, redstoneInspector))
      case 'logic_test': {
        const result = require('./logic_test').testLogic(action)
        if (result.ok && action.project !== undefined) {
          const saved = circuitProjects.saveLogic(action.project, action, result)
          if (!saved.ok) return report('logic_test', { ok: false, msg: `Project NOT saved: ${saved.msg}. Test result: ${result.msg}` })
          result.msg += ` ${saved.msg}.`
          try { memory.longTerm?.add(`logic_test "${action.project}" passed: ${result.msg}`.slice(0, 220), ['redstone', 'logic'], 2) } catch { /* noop */ }
        }
        return report('logic_test', result)
      }
      case 'inspect_region':
        return report('inspect_region', require('./region_inspect').inspectRegion(bot, action))
      case 'inspect_block':
        return report('inspect_block', require('./block_inspect').inspectBlock(bot, action))
      case 'find':
        return report('find', skills.find({ what: action.what, page: action.page }))
      case 'remember_here': {
        const p = here()?.floored()
        const ownership = action.ownership && ['own', 'shared', 'player', 'unknown'].includes(action.ownership) ? action.ownership : ''
        if (p && (action.home === true || ownership === 'own')) {
          const conflict = continuity.claimAt(p, dim())
          if (conflict && conflict.kind === 'player' && (!snap?.askedBy || conflict.owner?.toLowerCase() !== snap.askedBy.toLowerCase())) {
            return report('remember_here', { ok: false, msg: `refused: cannot claim "${conflict.name}" (${conflict.owner || 'player'}'s property) as yours` })
          }
        }
        let homeMsg = ''
        if (p && action.home === true) {
          const basis = snap?.askedBy ? 'assigned' : 'self_built'
          const hr = continuity.setHome({ place: action.name, pos: p, dim: dim(), basis, assignedBy: snap?.askedBy || null })
          if (!hr.ok) return report('remember_here', { ok: false, msg: `refused to set home: ${hr.reason}` })
          homeMsg = ` (verified home [${hr.home.basis}])`
        }
        const res = skills.rememberHere({ name: action.name, note: action.note })
        if (res.ok && p) {
          try {
            if (ownership || action.owner) {
              places.remember(action.name, p, { dim: dim(), note: action.note, ownership: ownership || (action.home ? 'own' : ''), owner: action.owner || '' })
            }
            if (ownership && ownership !== 'unknown') {
              continuity.recordClaim({ name: action.name, pos: p, radius: 9, dim: dim(), kind: ownership, owner: action.owner || (ownership === 'own' ? bot.username : null), note: action.note || '', source: 'model_note' })
            }
            const loc = `${p.x},${p.y},${p.z} (${dim()})`
            memory.longTerm?.upsertByTag(`place:${String(action.name).toLowerCase()}`, `saved place "${action.name}" at ${loc}${ownership ? ` [${ownership}${action.owner ? ':' + action.owner : ''}]` : ''}${action.note ? `: ${action.note}` : ''}`, ['place', String(action.name).toLowerCase()], 2)
          } catch { /* noop */ }
          res.msg += homeMsg
        }
        return report('remember_here', res, { wake: null })
      }
      case 'note': {
        const text = String(action.text || '').trim().slice(0, 220)
        const interest = String(action.interest || '').trim().slice(0, 60)
        if (!text && !interest) return report('note', { ok: false, msg: 'note needs `text` and/or `interest`' })
        const parts = []
        if (text) {
          try { memory.longTerm?.add(text, ['note', 'self'], 2, { source: 'self', verified: true }) } catch { /* noop */ }
          parts.push(`remembered "${text}"`)
        }
        if (interest) {
          const list = continuity.updateInterest(interest)
          parts.push(`interests now: ${list.length ? list.join(', ') : 'none'}`)
        }
        return report('note', { ok: true, msg: parts.join('; ') }, { wake: null })
      }
      case 'social': {
        const op = String(action.operation || 'list').toLowerCase()
        if (op === 'list') {
          const all = continuity.listRelationships()
          if (!all.length) return report('social', { ok: true, msg: 'no player relationships recorded yet — form your own opinions as you observe and interact' })
          return report('social', { ok: true, msg: `relationships (${all.length}): ${all.slice(0, 8).map((e) => continuity.formatRelationship(e.name)).join(' || ')}` })
        }
        const who = String(action.player || snap?.askedBy || '').trim()
        if (!who) return report('social', { ok: false, msg: `social ${op} requires a player name` })
        if (op === 'show') {
          return report('social', { ok: true, msg: continuity.formatRelationship(who) })
        }
        if (op === 'update' || op === 'decide') {
          const matchProp = (snap?.shownProposals || agenda.asked || []).find((p) => p.from?.toLowerCase() === who.toLowerCase())
          const updated = continuity.updateRelationship(who, {
            stance: action.stance,
            trust: action.trust,
            confidence: action.confidence,
            willingness: action.willingness,
            opinion: action.opinion,
            evidence: action.evidence,
            decision: action.decision,
            proposalText: matchProp?.text || ''
          })
          if (!updated) return report('social', { ok: false, msg: `invalid player "${who}"` })
          if (action.decision) {
            agenda.asked = agenda.asked.filter((x) => x.from?.toLowerCase() !== who.toLowerCase())
            continuity.resolvePendingEvents((e) => e.kind === 'player_request' && e.from?.toLowerCase() === who.toLowerCase())
          }
          if (action.opinion || action.evidence) {
            const memSummary = `opinion on ${updated.name}: stance=${updated.stance || 'unassessed'}${updated.trust !== null ? `, trust=${updated.trust}` : ''}${updated.summary ? ` — ${updated.summary}` : ''}${action.evidence ? ` (evidence: ${action.evidence})` : ''}`.slice(0, 220)
            try { memory.longTerm?.upsertByTag?.(`rel:${updated.name.toLowerCase()}`, memSummary, ['relationship', updated.name], 2) } catch { /* noop */ }
          }
          return report('social', { ok: true, msg: `updated ${continuity.formatRelationship(who)}` })
        }
        return report('social', { ok: false, msg: `unknown social operation "${op}" (list|show|update|decide)` })
      }
      case 'gather': {
        decided(snap, { label: 'gather' })
        const n = Math.max(1, Math.min(64, Math.trunc(Number(action.count)) || 1))
        const askedBy = resolveActionAttribution('gather', action, snap)
        return startMain({ tool: 'gather', label: `gather ${action.item}${n > 1 ? ` x${n}` : ''}`, askedBy, detail: goalDetailFor('gather', { item: action.item, count: n, radius: action.radius }), decision: decided(snap, { label: 'gather' }), run: () => skills.gather({ item: action.item, count: n, radius: action.radius, guard: (p) => continuity.propertyGuardAt(p, dim(), { askedBy }) }) })
      }
      case 'light_up': {
        decided(snap, { label: 'light_up' })
        return startMain({ tool: 'light_up', label: 'lighting the area', askedBy: resolveActionAttribution('light_up', action, snap), decision: decided(snap, { label: 'light_up' }), run: () => skills.lightUp({ radius: action.radius }) })
      }
      case 'shelter': {
        decided(snap, { label: 'shelter' })
        return startMain({ tool: 'shelter', label: 'sheltering', askedBy: resolveActionAttribution('shelter', action, snap), decision: decided(snap, { label: 'shelter' }), run: () => skills.shelter() })
      }
      case 'corpse_run': {
        decided(snap, { label: 'corpse_run' })
        return startMain({ tool: 'corpse_run', label: 'going back to last death', askedBy: resolveActionAttribution('corpse_run', action, snap), decision: decided(snap, { label: 'corpse_run' }), run: () => skills.corpseRun() })
      }
      case 'craft': {
        // runs as a side job through skills.craft, which WALKS
        // to the table (task lane) before crafting. A main task pauses for it.
        const item = String(action.i ?? action.item ?? '')
        if (!item) return report('craft', { ok: false, msg: 'craft needs an item' })
        decided(snap, { label: 'craft' })
        return startSide('craft', () => skills.craft({ item }), sideOpts('craft', action, snap))
      }
      case 'build': {
        if (!executor) return report('build', { ok: false, msg: 'not ready yet' })
        const stage = normalizeStage(action.stage)
        let planned
        try {
          if (action.blueprint) planned = parser.load(String(action.blueprint))
          else if (Array.isArray(action.grid)) planned = parser.parseInline(action)
          else return report('build', { ok: false, msg: `need a blueprint name (${parser.listAvailable().join(', ')}) or an inline grid` })
        } catch (err) { return report('build', { ok: false, msg: String(err.message || err) }) }
        const what = `${action.blueprint || 'inline grid'}${stage ? ` (${stage})` : ''}`
        // Re-running a phase is idempotent, so a paused build simply runs again
        // — at the SAME origin, which is resolved now and kept in the goal
        // checkpoint (re-running without `at` used to build a second house).
        const detail = goalDetailFor('build', action)
        const askedBy = resolveActionAttribution('build', action, snap)
        return startMain({ tool: 'build', label: `build ${what}`, askedBy, showAs: `building ${what}`, detail, decision: decided(snap, { label: 'build', ttlMs: 30 * 60_000 }), run: () => buildBlocks(planned.blocks, String(action.blueprint || 'inline'), stage, detail.at, { askedBy }) })
      }
      case 'build_shape': {
        if (!executor) return report('build_shape', { ok: false, msg: 'not ready yet' })
        const shape = String(action.shape || '')
        const block = String(action.block || '')
        const params = (action.params && typeof action.params === 'object') ? action.params : {}
        if (!shape || !block) return report('build_shape', { ok: false, msg: 'need shape and block' })
        let blocks
        try { blocks = generateShape(shape, params, block) } catch (err) { return report('build_shape', { ok: false, msg: String(err.message || err) }) }
        const detail = goalDetailFor('build_shape', action)
        const askedBy = resolveActionAttribution('build_shape', action, snap)
        return startMain({ tool: 'build_shape', label: `build ${shape} of ${block}`, askedBy, showAs: `building ${shape} of ${block}`, detail, decision: decided(snap, { label: 'build', ttlMs: 30 * 60_000 }), run: () => buildBlocks(blocks, `shape:${shape}`, normalizeStage(action.stage), detail.at, { askedBy }) })
      }
      case 'run_script': {
        const name = String(action.name || '')
        if (!name) return report('run_script', { ok: false, msg: 'need a script name' })
        decided(snap, { label: 'script' })
        const ctx = {
          bot, goals, memory, combat, pathfinder: wrapper, executor, system1, logger, arbiter, skills, places,
          escalate: (event) => brain.wake(`${event.type} ${event.item || event.text || ''}`.trim())
        }
        // A script is not safe to run twice, so a side job ends it instead of pausing it.
        return startMain({ tool: `run_script ${name}`, label: `script ${name}`, askedBy: snap.askedBy, showAs: `running script ${name}`, resumable: false, run: () => runScript(name, {}, ctx).then((out) => ({ ok: true, msg: typeof out === 'string' ? out : 'done' })) })
      }
      case 'goal': {
        return report('goal', await runGoalOp(action, snap))
      }
      case 'set_mode': {
        const prevMode = wrapper.mode || 'explorer'
        const applied = wrapper.setMode(String(action.mode || ''))
        cfg.behavior.mode = applied
        continuity.currentState.mode = applied
        return report('set_mode', { ok: true, msg: `mode switched to ${applied}` }, { wake: prevMode !== applied })
      }
      default:
        return report(String(a), { ok: false, msg: `unknown action "${a}"` })
    }
    } finally {
      gateCtx = null
      currentActId = null
      // The lane lease is always released here — success, failure, an early
      // return or a thrown error. A leaked BODY lock would freeze the avatar.
      try { laneLease?.release('action finished') } catch { /* noop */ }
    }
  }

  // ------------------------------------------ optional Scout & Relocate --
  async function scoutAndRelocate () {
    const sc = cfg.scout || {}
    if (sc.enabled !== true || !here()) return
    const deadline = Date.now() + (sc.waitForWorldMs ?? 6000)
    while (Date.now() < deadline && !ended) {
      try {
        const below = bot.blockAt(here().floored().offset(0, -1, 0))
        if (below && below.boundingBox === 'block') break
      } catch { /* chunk not loaded yet */ }
      await sleep(250)
    }
    sense.assess()
    wrapper.threat.sample(bot, true)
    const result = scoutSafeAnchor(bot, {
      radius: sc.radius ?? 15, step: sc.step ?? 3, minRadius: sc.minRadius ?? 5, preferRadius: sc.preferRadius ?? 12,
      horizonTicks: wrapper.threat.horizonTicks, avoid: []
    })
    if (!result) return
    logger.info(TAG, `scout: anchor ${result.x},${result.y},${result.z} (${result.reasons.join(', ')})`)
    const p = here()
    if (Math.hypot(result.x - p.x, result.y - p.y, result.z - p.z) > (sc.relocateAboveBlocks ?? 6)) {
      background('scout', skills.goTo({ x: result.x, y: result.y, z: result.z }))
    }
  }

  // ------------------------------------------------------ event wiring ---
  bot.on('login', () => logger.info(TAG, `logged in as ${bot.username}`))

  bot.on('spawn', () => {
    alive = true
    const first = !spawned
    spawned = true
    shared.everSpawned = true
    shared.attempts = 0

    // A fresh Movements every spawn; the wrapper re-applies EVERYTHING to it
    // (doors, mode, digging guard, scaffolding policy, threat costs).
    const movements = new Movements(bot)
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)
    wrapper.apply()

    if (systemsReady) {
      // Respawn: same bot object, same stack. Nobody owns anything any more.
      const p = here()
      logger.info(TAG, 'respawned')
      wrapper.setMode(cfg.behavior.mode || 'explorer')
      // A death does not erase the plan: the objectives went back to the
      // registry as resumable, and are re-checked against the world.
      let rechecked = 0
      try { rechecked = reconcileRestored() } catch (err) { logger.debug(TAG, `goal reconcile: ${err.message || err}`) }
      const open = goalReg.openGoals()
      const pending = open.length ? `; unfinished: ${open.slice(0, 4).map((g) => goalReg.describe(g)).join(' | ')}` : ''
      brain.wake(`respawned at ${p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'spawn'}; items were dropped at place "last death"${pending}${rechecked ? ` (re-checked ${rechecked} goal(s) against the world)` : ''}`)
      return
    }
    systemsReady = true
    logger.info(TAG, `spawn OK — model=${cfg.amd.model}`)

    // Entity metadata is read by key name from the server's game data, so a
    // version that reorders it (26.x moved the tame flag) cannot turn pets wild.
    const data = useRegistry(bot.registry)
    for (const problem of data.problems) logger.warn(TAG, `game data: ${problem} — pets of that kind are treated as protected`)
    if (data.newHostiles.length) logger.info(TAG, `game data lists hostile mobs this harness has no notes on, treated as hostile: ${data.newHostiles.join(', ')}`)

    combat = new AdvancedCombat(bot, {
      maxHealth: 20,
      disengageHealthFraction: cfg.combat.disengageHealthFraction ?? 0.3,
      critThreshold: cfg.combat.critThreshold ?? 1.0,
      recoveryMs: cfg.combat.recoveryMs ?? 220,
      attackCooldownMs: cfg.combat.attackCooldownMs ?? 600,
      engageRadius: cfg.behavior.engageRadius ?? 24,
      threatMap: wrapper.threat,
      hands: arbiter.lane('combat', PRIORITY.combat),
      // Running away is the survival layer's job here.
      fleeOnDisengage: false,
      // During a fight, also dodge any other player who hit the bot lately.
      watch: () => {
        const out = []
        for (const [id, a] of sense.attackers) {
          const e = a.player ? bot.entities?.[id] : null
          if (e && sense.isRecentAttacker(e)) out.push(e)
        }
        return out
      },
      onEvent: onCombatEvent
    })
    combat.start()

    const taskLane = arbiter.lane('task', PRIORITY.task)
    executor = new BuilderExecutor(bot, { scaffoldBlocks: cfg.build.scaffoldBlocks, logger: wrapperLog, hands: taskLane })
    skills = new Skills(bot, { arbiter, places, logger: wrapperLog, whisper: guard.whisper, executor: () => executor, pathfinder: () => wrapper })
    wrapper.setMode(cfg.behavior.mode || 'explorer')

    brain = new Brain({
      act,
      talk,
      isBodyBusy: () => Boolean(skills?.current() || task || combat?.isEngaged || system1?.fleeing),
      logger: (level, msg) => logger[level]?.(TAG, msg),
      minIntervalMs: cfg.inference.minIntervalMs ?? 3000,
      chatMinIntervalMs: cfg.inference.chatMinIntervalMs ?? 1200,
      rpm: cfg.inference.rpm ?? 18,
      chatReserve: cfg.inference.chatReserve ?? 4,
      urgentMinIntervalMs: cfg.inference.urgentMinIntervalMs ?? 1000,
      heartbeatMs: cfg.inference.heartbeatMs ?? 90_000,
      maxSelfChain: cfg.inference.maxSelfChain ?? 12
    })

    system1 = new System1(bot, {
      registry: new ReflexRegistry(),
      logger,
      arbiter,
      sense,
      combat,
      pathfinder: wrapper,
      memory,
      eatBelowFood: cfg.system1.eatBelowFood ?? 18,
      lowHealth: cfg.system1.lowHealth ?? 10,
      fleeBelowHealth: cfg.system1.fleeBelowHealth ?? 6,
      mlgFallBlocks: cfg.system1.mlgFallBlocks ?? 5,
      fleeDistance: cfg.system1.fleeDistance ?? 14,
      releaseRadius: cfg.system1.releaseRadius ?? 22,
      calmMs: cfg.system1.calmMs ?? 4000,
      reportGapMs: cfg.system1.reportGapMs ?? 6000,
      stillFleeingMs: cfg.system1.stillFleeingMs ?? 30_000,
      recallMs: cfg.system1.recallMs ?? 180_000,
      tickMs: cfg.system1.tickMs ?? 200,
      autoElytra: cfg.behavior.autoElytra !== false,
      escalate: (event) => brain.wake(`${event.type} ${event.item || event.text || ''}`.trim()),
      // The reflex reports; the model decides. The start of an escape (and
      // anything that makes it worse) may jump the queue; its end may not.
      onEvent: (evt) => {
        note({ type: evt.type, msg: evt.text })
        if (evt.wake && evt.urgent === true) decisionEpoch++
        if (evt.wake) brain.wake(evt.text, { external: true, urgent: evt.urgent === true })
        // A new danger on screen changes the world: what failed a moment ago
        // (run away, fight back) may now be the right call.
        if (evt.type === 'threat') failGate.clearContext()
        // An escape that cost health or dragged on says something about that
        // place. Written in a fixed form (kinds, 16-block cell, day or night)
        // so the tenth escape from the same spot is the same memory, not a tenth one.
        const ep = evt.episode
        if (ep && (ep.lost > 0 || ep.seconds >= 20)) {
          const tod = bot.time?.timeOfDay
          const when = Number.isFinite(tod) && tod >= 13000 && tod < 23000 ? 'at night' : 'by day'
          const cell = (v) => Math.round(v / 16) * 16
          const kinds = String(ep.from).replace(/ x\d+/g, '')
          try { memory.longTerm.add(`dangerous ${when} around ${cell(ep.start.x)},${cell(ep.start.z)} (${dim()}): had to run from ${kinds}`, ['danger'], 1) } catch { /* never let memory break the loop */ }
        }
      }
    })
    system1.start()
    brain.start()

    // A task interrupted by the flee reflex resumes by itself; tell the model.
    arbiter.on('preempt', ({ lane, by, reason }) => { if (lane === 'task') note({ type: 'interrupted', msg: `task paused: ${by} lane took over (${reason || 'reflex'})` }) })
    arbiter.on('resume', ({ lane }) => { if (lane === 'task') note({ type: 'resumed', msg: 'task resumed after the interruption' }) })

    let lastWorldWakeAt = 0
    const nearbyPlayerSeen = new Set()
    every(3000, () => {
      try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* partial world */ }
      try {
        const env = continuity.observeEnvironment(bot, places)
        const now = Date.now()
        const bodyIdle = !agenda.main && !skills?.current() && !task && !combat?.isEngaged && !system1?.fleeing && !brain?.busyAction
        // Notice newly arrived / returning players within 24m without spamming wakes.
        const pos = here()
        if (pos && bot.players) {
          const currentlyNear = new Set()
          for (const [pname, pobj] of Object.entries(bot.players)) {
            if (pname === bot.username || !pobj?.entity?.position) continue
            const d = Math.hypot(pobj.entity.position.x - pos.x, pobj.entity.position.z - pos.z)
            if (d <= 24) {
              currentlyNear.add(pname)
              if (!nearbyPlayerSeen.has(pname)) {
                const rel = continuity.touchPlayer(pname)
                if (bodyIdle && now - lastWorldWakeAt >= 25_000) {
                  lastWorldWakeAt = now
                  const viewTag = rel?.entry?.stance ? ` — your view: ${rel.entry.stance}` : ''
                  brain.wake(`player ${pname} arrived nearby (${Math.round(d)}m)${viewTag}`, { external: true })
                }
              }
            }
          }
          nearbyPlayerSeen.clear()
          for (const pname of currentlyNear) nearbyPlayerSeen.add(pname)
        }
        if (env.changes.length && bodyIdle && now - lastWorldWakeAt >= 25_000) {
          lastWorldWakeAt = now
          brain.wake(`world change noticed: ${env.changes.slice(0, 2).join('; ')}`, { external: true })
        }
      } catch { /* partial world */ }
    })
    every(60_000, () => { try { memory.save(); places.save(); continuity.save(); shared.saveConvo?.() } catch { /* best effort */ } })
    every(GOALS.tickMs ?? 15_000, () => { try { goalTick() } catch (err) { logger.debug(TAG, `goal tick: ${err.message || err}`) } })

    try { bot.armorManager?.equipAll?.() } catch { /* cosmetic */ }
    logger.info(TAG, 'ZincAI ready — reflexes flee, the model decides; chat lane + action lane on demand')
    if (first) {
      let restored = 0
      try { restored = reconcileRestored() } catch (err) { logger.debug(TAG, `goal reconcile: ${err.message || err}`) }
      try {
        for (const evt of continuity.pendingEvents) {
          if (evt.kind === 'player_request' && evt.from && evt.text && !agenda.asked.some((x) => x.from === evt.from && x.text === evt.text)) {
            agenda.asked.push({ from: evt.from, text: evt.text, at: evt.at || Date.now() })
          }
        }
        if (continuity.stateVersion > 0) {
          continuity.reconcileWithWorld(bot, { goals: goalReg, places, skills, building: Boolean(task), combat, system1, reason: 'session_boot' })
        }
      } catch { /* best effort */ }
      const open = goalReg.openGoals()
      const carried = open.length
        ? `; objectives restored (${open.length}): ${open.slice(0, 4).map((g) => goalReg.describe(g)).join(' | ')}${open.length > 4 ? ` +${open.length - 4} more` : ''} — verify against the world before resuming`
        : ''
      brain.wake(`joined the server — orient yourself, check open goals or surroundings, or idle if content${carried}`)
      if (restored) logger.info(TAG, `goals: re-checked ${restored} restored objective(s) at startup`)
      scoutAndRelocate().catch((err) => logger.warn(TAG, `scout failed: ${err.message || err}`))
    }
  })

  // One report per hit, however the server announces it (hurt event, named
  // source on 1.19.4+, or just less health), with the cause in plain words:
  // no more "I was just attacked" for hunger, falls and fire.
  const hurts = new HurtTracker(bot, sense, {
    isReady: () => systemsReady && !ended,
    onHurt: (cause, { hp }) => {
      note({ type: 'hurt', msg: cause.text })
      const hitMatch = /hit by player ([A-Za-z0-9_]{1,20})/i.exec(String(cause.text || ''))
      if (hitMatch) {
        try { continuity.recordPlayerObservation(hitMatch[1], `${cause.text} (hp ${hp})`) } catch { /* noop */ }
      }
      // do NOT clear the fail gate here — being hit is exactly the
      // state in which "too hurt to fight" keeps failing; clearing re-armed
      // the churn loop (repro 05). Death and new threats still clear it.
      const now = Date.now()
      if (hp > 0 && (cause.text !== lastHurt.text || now - lastHurt.at > 4000)) brain.wake(`hurt: ${cause.text} (hp ${hp})`, { external: true })
      lastHurt = { at: now, text: cause.text }
    }
  }).start()
  bot.on('entityHurt', (entity) => { if (entity !== bot.entity) system1?.onEntityHurt(entity) })

  // ------------------------------------------------- entity perception ---
  // Spawn/despawn/damage of everything else used to be invisible to the model:
  // only the reflex layer subscribed to entityHurt. Every branch below is cheap
  // and coalesces, so a horde does not become 200 prompt lines.
  const ENTITY_INTEREST_RE = /^(player|zombie|skeleton|spider|creeper|enderman|witch|slime|magma_cube|blaze|ghast|phantom|drowned|husk|stray|pillager|vindicator|ravager|piglin|hoglin|zombified_piglin|wither_skeleton|warden|elder_guardian|guardian|iron_golem|wolf|cat|fox|horse|villager|wandering_trader|allay|bee|axolotl|goat|cow|pig|sheep|chicken|rabbit|turtle|panda|strider|boat|minecart|item|arrow|trident|fireball|small_fireball|wind_charge|tnt|primed_tnt)$/
  bot.on('entitySpawn', (entity) => {
    if (!systemsReady || !entity || entity === bot.entity) return
    const name = String(entity.name || entity.displayName || 'entity')
    if (!ENTITY_INTEREST_RE.test(name)) return
    const isPlayer = entity.type === 'player' || entity.username
    const d = here() && entity.position ? Math.round(entity.position.distanceTo(here())) : null
    perceive({
      source: 'mineflayer', eventType: isPlayer ? 'player_arrived' : 'entity_spawn',
      reactionClass: isPlayer ? 'fast' : 'ambient',
      summary: `${isPlayer ? (entity.username || 'player') : name} appeared${d !== null ? ` ${d}m away` : ''}`,
      entities: [isPlayer ? (entity.username || name) : name],
      where: entity.position || null,
      occurrenceTimeKnown: true,
      observedAt: Date.now(),
      observationBasis: 'direct',
      importance: isPlayer ? 2 : (name === 'item' ? 0 : 1),
      groupKey: isPlayer ? null : `spawn:${name}`,
      memoryType: isPlayer ? 'player_arrived' : 'spawn',
      wake: null
    })
  })
  bot.on('entityGone', (entity) => {
    if (!systemsReady || !entity || entity === bot.entity) return
    const name = String(entity.name || entity.displayName || 'entity')
    if (!ENTITY_INTEREST_RE.test(name)) return
    const isPlayer = entity.type === 'player' || entity.username
    perceive({
      source: 'mineflayer', eventType: isPlayer ? 'player_left' : 'entity_gone',
      reactionClass: 'ambient',
      summary: `${isPlayer ? (entity.username || 'player') : name} disappeared (out of range, died or logged off)`,
      entities: [isPlayer ? (entity.username || name) : name],
      where: entity.position || null,
      occurrenceTimeKnown: true,
      observationBasis: 'direct',
      importance: 1,
      groupKey: `gone:${name}`,
      memoryType: isPlayer ? 'player_left' : 'despawn'
    })
  })
  bot.on('entityHurt', (entity) => {
    if (!systemsReady || !entity) return
    const name = String(entity.name || entity.displayName || 'entity')
    const isPlayer = entity.type === 'player' || entity.username
    const label = isPlayer ? (entity.username || 'player') : name
    const d = here() && entity.position ? Math.round(entity.position.distanceTo(here())) : null
    perceive({
      source: 'mineflayer', eventType: 'entity_hurt',
      reactionClass: isPlayer ? 'fast' : 'ambient',
      summary: `${label} took damage${d !== null ? ` ${d}m away` : ''}${entity.health !== undefined ? ` (health ${Math.round(entity.health)})` : ''}`,
      entities: [label],
      where: entity.position || null,
      occurrenceTimeKnown: true,
      observationBasis: 'direct',
      importance: isPlayer ? 2 : 1,
      groupKey: `hurt:${label}`,
      memoryType: 'entity_hurt'
    })
  })
  bot.on('entityDead', (entity) => {
    if (!systemsReady || !entity) return
    const name = String(entity.name || entity.displayName || 'entity')
    const label = (entity.type === 'player' || entity.username) ? (entity.username || 'player') : name
    perceive({
      source: 'mineflayer', eventType: 'entity_dead',
      reactionClass: 'fast',
      summary: `${label} died`,
      entities: [label],
      where: entity.position || null,
      occurrenceTimeKnown: true,
      observationBasis: 'direct',
      importance: 2,
      memoryType: 'death_other'
    })
  })
  bot.on('entityMoved', (entity) => {
    if (!systemsReady || !entity || entity === bot.entity) return
    const isPlayer = entity.type === 'player' || entity.username
    const name = String(entity.name || '')
    if (!isPlayer && name !== 'creeper' && name !== 'warden') return // only movers that matter
    const prev = recentEntityPos.get(entity.id)
    const nowMs = Date.now()
    if (prev && nowMs - prev.at < 3000) return
    recentEntityPos.set(entity.id, { x: entity.position?.x, at: nowMs })
    if (recentEntityPos.size > 64) recentEntityPos.delete(recentEntityPos.keys().next().value)
    if (!prev) return
    const dx = (entity.position?.x ?? 0) - prev.x
    if (Math.abs(dx) < 6) return
    perceive({
      source: 'mineflayer', eventType: 'entity_moved',
      reactionClass: 'ambient',
      summary: `${isPlayer ? (entity.username || 'player') : name} moved ${Math.round(Math.abs(dx))} blocks ${dx > 0 ? 'east' : 'west'}`,
      entities: [isPlayer ? (entity.username || 'player') : name],
      where: entity.position || null,
      occurrenceTimeKnown: false,
      observationBasis: 'direct',
      importance: 0,
      groupKey: `moved:${entity.username || name}`,
      memoryType: 'move'
    })
  })

  // ---------------------------------------------- environment perception --
  const playerChunkOf = () => {
    const p = here()
    if (!p) return null
    return `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`
  }
  let lastChunk = null
  every(1200, () => {
    if (!systemsReady || ended) return
    const chunk = playerChunkOf()
    if (chunk && lastChunk && chunk !== lastChunk) {
      perceive({
        source: 'internal', eventType: 'chunk_transition',
        reactionClass: 'ambient',
        summary: `moved into chunk ${chunk}`,
        occurrenceTimeKnown: false,
        observedAt: Date.now(),
        observationBasis: 'direct', importance: 0, memoryType: 'chunk'
      })
    }
    if (chunk) lastChunk = chunk
  })
  let lastDim = null
  let lastWeather = null
  let lastDayPhase = null
  every(2500, () => {
    if (!systemsReady || ended) return
    const d = String(bot.game?.dimension || '')
    if (lastDim && d && d !== lastDim) {
      perceive({
        source: 'internal', eventType: 'dimension_change',
        reactionClass: 'fast',
        summary: `dimension changed ${lastDim.replace('minecraft:', '')} → ${d.replace('minecraft:', '')}`,
        occurrenceTimeKnown: true, observationBasis: 'direct', importance: 3, memoryType: 'dimension'
      })
    }
    if (d) lastDim = d
    const raining = Boolean(bot.isRaining)
    if (lastWeather !== null && raining !== lastWeather) {
      perceive({
        source: 'internal', eventType: 'weather',
        reactionClass: 'ambient',
        summary: raining ? 'it started raining' : 'the rain stopped',
        occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: 0, memoryType: 'weather'
      })
    }
    lastWeather = raining
    const t = bot.time?.timeOfDay
    if (Number.isFinite(t)) {
      const phase = t < 12000 ? 'day' : t < 13000 ? 'dusk' : t < 23000 ? 'night' : 'dawn'
      if (lastDayPhase && phase !== lastDayPhase) {
        perceive({
          source: 'internal', eventType: 'daylight',
          reactionClass: 'ambient',
          summary: `daylight phase changed ${lastDayPhase} → ${phase}`,
          occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: 0, memoryType: 'daylight'
        })
      }
      lastDayPhase = phase
    }
  })
  // Zinc's own status effects and inventory deltas.
  let lastEffects = new Map()
  let lastInventory = new Map()
  let lastHp = Number(bot.health)
  const snapshotInventory = () => {
    const m = new Map()
    try { for (const i of bot.inventory?.items?.() || []) m.set(i.name, (m.get(i.name) || 0) + i.count) } catch { /* none */ }
    return m
  }
  every(2000, () => {
    if (!systemsReady || ended) return
    let effects = new Map()
    try {
      for (const e of bot.entity?.effects ? Object.values(bot.entity.effects) : []) effects.set(e.name || e.id || 'effect', e.amplifier ?? 0)
    } catch { effects = new Map() }
    for (const [name, amp] of effects) {
      if (!lastEffects.has(name)) {
        perceive({
          source: 'internal', eventType: 'status_effect',
          reactionClass: 'fast',
          summary: `gained ${name}${amp ? ` ${amp + 1}` : ''}`,
          occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: 1, memoryType: 'effect'
        })
      }
    }
    for (const [name] of lastEffects) {
      if (!effects.has(name)) {
        perceive({
          source: 'internal', eventType: 'status_effect_end',
          reactionClass: 'ambient',
          summary: `${name} wore off`,
          occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: 0, memoryType: 'effect'
        })
      }
    }
    lastEffects = effects
    const inv = snapshotInventory()
    if (lastInventory.size) {
      for (const [name, count] of inv) {
        const before = lastInventory.get(name) || 0
        if (count > before) {
          perceive({
            source: 'internal', eventType: 'inventory_gain',
            reactionClass: 'fast',
            summary: `+${count - before} ${name} (now ${count})`,
            occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: 1,
            groupKey: `inv:${name}`, memoryType: 'inventory'
          })
        }
      }
      for (const [name, count] of lastInventory) {
        const nowCount = inv.get(name) || 0
        if (nowCount < count) {
          perceive({
            source: 'internal', eventType: 'inventory_loss',
            reactionClass: 'ambient',
            summary: `-${count - nowCount} ${name} (now ${nowCount})`,
            occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: count - nowCount >= 8 ? 1 : 0,
            groupKey: `invloss:${name}`, memoryType: 'inventory'
          })
        }
      }
    }
    lastInventory = inv
    // Health regen / damage while nothing else reported it.
    const hp = Number(bot.health)
    if (Number.isFinite(hp)) {
      if (hp < lastHp) perceive({
        source: 'internal', eventType: 'damage', reactionClass: 'immediate',
        summary: `took ${+(lastHp - hp).toFixed(1)} damage (hp ${hp})`,
        occurrenceTimeKnown: true, observationBasis: 'direct', importance: 3, memoryType: 'hurt',
        wake: `took damage (hp ${hp})`
      })
      else if (hp > lastHp + 0.5) perceive({
        source: 'internal', eventType: 'healing', reactionClass: 'ambient',
        summary: `healed to ${hp}`,
        occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct', importance: 0, memoryType: 'heal'
      })
      lastHp = hp
    }
  })

  // a container block changing under the bot (opened or
  // broken by someone else, a new chest placed) invalidates what the index
  // thought was inside — at zero cost, no waiting for the next 3 s scan.
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!systemsReady) return
    try { places.onBlockChange(oldBlock, newBlock, { dim: dim() }) } catch { /* cosmetic */ }
    // The model never saw block changes before: only the place index did.
    const RS_RE = /^(redstone_wire|repeater|comparator|observer|piston|sticky_piston|piston_head|redstone_torch|redstone_wall_torch|lever|.*_button|.*_pressure_plate|redstone_lamp|hopper|dropper|dispenser|note_block|tripwire|tripwire_hook|target|daylight_detector|redstone_block|.*_door|.*_trapdoor)/
    const from = oldBlock?.name || 'air'
    const to = newBlock?.name || 'air'
    if (from === to) {
      // Same block, changed state (repeater delay, lamp lit, dust power…).
      let a = null; let b = null
      try { a = oldBlock?.getProperties?.() } catch { a = null }
      try { b = newBlock?.getProperties?.() } catch { b = null }
      if (!a || !b) return
      const diff = Object.keys(b).filter((k) => String(a[k]) !== String(b[k])).slice(0, 3)
      if (!diff.length) return
      const pos = newBlock?.position
      const isRedstone = RS_RE.test(to)
      perceive({
        source: 'mineflayer', eventType: isRedstone ? 'redstone_update' : 'block_state_change',
        reactionClass: 'ambient',
        summary: `${to} changed (${diff.map((k) => `${k}: ${a[k]}→${b[k]}`).join(', ')})`,
        where: pos || null,
        occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct',
        importance: isRedstone ? 1 : 0,
        groupKey: `state:${pos ? `${pos.x},${pos.y},${pos.z}` : to}`,
        memoryType: isRedstone ? 'redstone' : 'block'
      })
      return
    }
    const pos = newBlock?.position || oldBlock?.position
    const placedByOther = from === 'air'
    perceive({
      source: 'mineflayer', eventType: RS_RE.test(to) || RS_RE.test(from) ? 'redstone_update' : (placedByOther ? 'block_placed' : 'block_destroyed'),
      reactionClass: 'ambient',
      summary: placedByOther ? `${to} placed` : (to === 'air' ? `${from} destroyed/broken` : `${from} → ${to}`),
      where: pos || null,
      delta: `${from}→${to}`,
      occurrenceTimeKnown: false, observedAt: Date.now(), observationBasis: 'direct',
      importance: RS_RE.test(to) || RS_RE.test(from) ? 1 : 0,
      groupKey: `block:${to}`
    })
  })

  // absorption/health-boost show up as hp above the vanilla 20 —
  // that observed value is the only honest base for fight odds and the
  // low-hp disengage threshold.
  bot.on('health', () => { try { combat?.noteHealth?.(bot.health) } catch { /* cosmetic */ } })

  bot.on('playerCollect', (collector, item) => {
    if (!systemsReady || collector !== bot.entity) return
    const itemName = item?.name || 'item'
    let nearPlayer = null
    const p = here()
    if (p && bot.players) {
      let bestD = 6.0
      for (const [pname, pobj] of Object.entries(bot.players)) {
        if (pname === bot.username || !pobj?.entity?.position) continue
        const d = pobj.entity.position.distanceTo(p)
        if (d <= bestD) { bestD = d; nearPlayer = { name: pname, d: Math.round(d) } }
      }
    }
    if (nearPlayer) {
      // Record raw factual proximity only — NEVER auto-label as friend!
      try { continuity.recordPlayerObservation(nearPlayer.name, `nearby (${nearPlayer.d}m) when you collected ${itemName}`) } catch { /* noop */ }
      note({ type: 'item_collected', msg: `collected ${itemName} (${nearPlayer.name} ${nearPlayer.d}m away)` })
    }
    system1?.onItemGained(itemName, null)
    perceive({
      source: 'mineflayer', eventType: 'item_pickup',
      reactionClass: 'fast',
      summary: `picked up ${itemName}${nearPlayer ? ` (${nearPlayer.name} ${nearPlayer.d}m away)` : ''}`,
      entities: nearPlayer ? [nearPlayer.name] : [],
      where: here(),
      occurrenceTimeKnown: true, observationBasis: 'direct',
      importance: 1, groupKey: `pickup:${itemName}`, memoryType: 'item_collected', remember: false
    })
  })

  bot.on('death', () => {
    alive = false
    decisionEpoch++
    lifeEpoch++
    const p = here()
    const where = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown'
    hurts.flush() // name the killing blow before writing the obituary
    logger.warn(TAG, `died at ${where}${lastHurt.text ? ` (${lastHurt.text})` : ''}`)
    note({ type: 'death', msg: `I died at ${where}${lastHurt.text ? ` — ${lastHurt.text}` : ''}` }, { promote: true })
    if (p) places.remember('last death', p, { dim: dim(), note: lastHurt.text })
    failGate.clearContext()
    fight = null
    // A new life, not a new plan: the main task stops running but goes back to
    // the registry as resumable, with its checkpoint. (It used to be deleted.)
    try {
      if (agenda.main?.goalId) goalReg.suspend(agenda.main.goalId, { reason: `died at ${where}`, by: 'death' })
      goalReg.suspendAll({ reason: `died at ${where}` })
      goalReg.save({ force: true })
    } catch (err) { logger.debug(TAG, `goal death handling: ${err.message || err}`) }
    agenda.main = null // a new life: the model is told and decides what to pick up again
    try { skills?.cancel('died') } catch { /* noop */ }
    try { executor?.cancel() } catch { /* noop */ }
    try { combat?.stop(); combat?.start() } catch { /* noop */ }
    try { system1?.reset() } catch { /* noop */ }
    try { arbiter.reset('death') } catch { /* noop */ }
    try { wrapper.threat.clear() } catch { /* noop */ }
    const t = setTimeout(() => { timers.delete(t); try { bot.respawn() } catch { /* not on death screen */ } }, 1500)
    timers.add(t)
  })

  bot.on('wake', () => {
    if (!systemsReady) return
    note({ type: 'woke', msg: 'woke up' })
    // A task that waited for the night carries on; only an idle bot needs a thought.
    if (!resumeMain('sleeping')) brain.wake('woke up (morning)')
  })

  bot.on('vanilla_command_blocked', (line) => {
    logger.warn(TAG, `vanilla guard blocked: ${String(line).slice(0, 80)}`)
    report('say', { ok: false, msg: 'blocked: chat that starts with "/" is a command and you cannot run commands' })
  })

  bot.on('messagestr', (raw) => {
    if (!systemsReady) return
    const players = Object.keys(bot.players || {})
    const parsed = filter.parseChatLine(raw, { players })
    if (!parsed) return // server line, not attributed chat
    if (parsed.sender === bot.username) return // never react to ourselves
    const { sender, text, whisper } = parsed
    const pref = memory.observeChat(sender, text)
    if (pref) logger.debug(TAG, `preference learned from ${sender} (${pref.polarity}): ${pref.text}`)
    system1?.onChatLine(sender, text)
    logChat(sender, whisper ? `(whisper) ${text}` : text)
    note({ type: 'chat', sender, text: `${sender}: ${text}` })
    perceive({
      source: 'mineflayer', eventType: 'chat', reactionClass: 'fast',
      summary: `${sender}: ${text}`,
      entities: [sender],
      sender,
      dedupeKey: null,
      groupKey: `chat:${sender}`,
      occurrenceTimeKnown: true, observationBasis: 'direct', importance: 2,
      memoryType: 'chat', remember: false
    })
    const why = filter.chatAddressesBot(text, {
      names: botNames,
      whisper,
      inConversation: inConversation(sender),
      othersOnline: players.filter((p) => p !== bot.username).length
    })
    memory.rememberChat(sender, text, { addressed: Boolean(why) })
    logger.debug(TAG, `chat from ${sender}: ${text} (${why ? `for me: ${why}` : 'not for me'})`)
    if (!why) return
    // one spamming player may not monopolize the chat
    // lane's reserved budget — over the per-player limit the line is dropped
    // (still logged/remembered above, just never answered).
    if (!chatRate.allow(sender)) {
      logger.warn(TAG, `chat rate limit: dropping extra line from ${sender}`)
      return
    }
    pushConvo(sender, 'them', text)
    brain.hear(sender, text, { whisper })
  })

  /**
   * Arbitrary context reset boundary: wipes all transient conversation,
   * working-memory, ephemeral, and turn-result buffers while preserving live
   * body execution and reconstructing operational continuity strictly from
   * compact persistent records + live world ground truth.
   */
  function resetContext ({ reason = 'context_reset', wake = true } = {}) {
    decisionEpoch++
    // A context reset must not leave a lane locked or a background job running
    // against a world the model no longer remembers.
    try { lanes.releaseAll('context reset') } catch { /* noop */ }
    results.length = 0
    try { memory.working.clear() } catch { /* noop */ }
    try { if (memory.shortTerm) memory.shortTerm.items = [] } catch { /* noop */ }
    try {
      if (memory.ephemeral) {
        memory.ephemeral.clear?.()
        if (Array.isArray(memory.ephemeral.items)) memory.ephemeral.items = []
      }
    } catch { /* noop */ }
    try { shared.convo.clear() } catch { /* noop */ }
    try { shared.chatLog.length = 0 } catch { /* noop */ }
    // Undelivered IMPORTANT events survive a context reset; already-delivered
    // ambient chatter does not. The brain keeps urgent/important wakes.
    let survived = []
    try { survived = pipeline.onContextReset() } catch { /* noop */ }
    try { brain?.clearContext({ preserveImportant: true }) } catch { /* noop */ }
    for (const evt of continuity.pendingEvents) {
      if (evt.kind === 'player_request' && evt.from && evt.text && !agenda.asked.some((x) => x.from === evt.from && x.text === evt.text)) {
        agenda.asked.push({ from: evt.from, text: evt.text, at: evt.at || Date.now() })
      }
    }
    const summary = continuity.reconcileWithWorld(bot, {
      goals: goalReg,
      places,
      skills,
      building: Boolean(task),
      combat,
      system1,
      reason
    })
    if (wake && systemsReady && !ended) {
      const keptNote = survived.length ? `; ${survived.length} undelivered important event(s) kept (${survived.slice(-3).map((e) => `#${e.sequence} ${e.eventType}`).join(', ')})` : ''
      brain?.wake(`context reset (${reason}) — continuity reconciled with live world${keptNote}`, { external: true, important: true })
    }
    return summary
  }

  // ------------------------------------------------------ session end ----
  function dispose (quit = false) {
    if (ended) return
    ended = true
    decisionEpoch++
    lifeEpoch++
    // What was running when the link dropped is not finished: resumable, and
    // on disk before the sockets close.
    try { goalReg.suspendAll({ reason: quit ? 'shutdown' : 'connection ended' }); goalReg.save({ force: true }) } catch { /* best effort */ }
    try { continuity.save() } catch { /* best effort */ }
    for (const t of timers) { clearInterval(t); clearTimeout(t) }
    timers.clear()
    try { brain?.stop() } catch { /* noop */ }
    try { skills?.dispose() } catch { /* noop */ }
    try { executor?.cancel() } catch { /* noop */ }
    try { system1?.stop() } catch { /* noop */ }
    try { combat?.stop() } catch { /* noop */ }
    try { wrapper.stop() } catch { /* noop */ }
    try { arbiter.stop() } catch { /* noop */ }
    try { hurts.stop() } catch { /* noop */ }
    if (quit) { try { bot.quit() } catch { /* already gone */ } }
  }

  function over (kind, detail) {
    if (ended) return
    let text = ''
    try { text = detail && detail.message ? detail.message : reasonToText(detail) } catch { text = String(detail ?? '') }
    dispose(false)
    try { bot.removeAllListeners('end'); bot.end?.() } catch { /* already gone */ }
    onEnded({ kind, text: String(text || '').slice(0, 200), spawned })
  }

  bot.on('kicked', (reason) => over('kicked', reason))
  bot.on('end', (reason) => over('end', reason))
  bot.on('error', (err) => {
    // Before spawn a socket error IS the end of this attempt; afterwards the
    // 'end' event follows and carries the session down.
    if (!spawned) over('error', err)
    else logger.error(TAG, `socket error: ${err.message || err}`)
  })

  // `internals` exists for the session test; nothing in the harness uses it.
  return {
    dispose,
    resetContext,
    bot,
    internals: () => ({
      arbiter, sense, wrapper, combat, system1, skills, brain, results, agenda,
      events: pipeline, latency, redstoneEngineer, redstoneLibrary: shared.redstoneLibrary,
      goals: goalReg, continuity, resetContext, executeAction, buildActionPrompt, buildChatPrompt,
      lanes, jobs, laneOf: (tool) => laneOf(tool), LANES,
      // Goal orchestration surface (tests and the session's own monitor):
      startMain, resumeMain, finishGoal, runGoalOp, goalLines, goalTick,
      reconcileRestored, reconcileGoal, verifyGoalAgainstWorld, staleActionReason
    })
  }
}

if (require.main === module) main()

module.exports = { loadConfig, validateConfig, makeShared, startSession, decideReconnect, FATAL_KICK_RE, ATTACK_WHY, SYSTEM_PROMPT, CHAT_PROMPT }
