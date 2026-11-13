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
    for (const m of ['./api_wrapper', './memory', './perception', './filter', './builder', './custom_mineflayer/pathfinder_wrapper', './custom_mineflayer/doors', './custom_mineflayer/escape', './system1', './tactics', './reflex_registry', './vanilla_guard', './control', './threats', './places', './skills', './observe', './brain']) require(m)
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
  const redstoneInspector = new (require('./redstone_inspect').RedstoneInspector)(bot)
  const circuitProjects = shared.circuitProjects || (shared.circuitProjects = new (require('./circuit_projects').CircuitProjects)(path.join(shared.dataDir || DATA_DIR, 'circuit-projects.json')))
  const sayQueue = []
  const timers = new Set()
  const every = (ms, fn) => { const t = setInterval(fn, ms); timers.add(t); return t }

  // Chat, results, requests and what the reflex did each have a section of
  // their own in the prompt; they stay out of the five-line event window so
  // they cannot push a real event ("hit by player Gabriel") out of it.
  const OWN_SECTION = new Set(['chat', 'said', 'result', 'request', 'threat', 'safe', 'fled'])
  const note = (evt, opts = {}) => { try { memory.addEvent(evt, { window: !OWN_SECTION.has(evt?.type), ...opts }) } catch { /* never let memory break the loop */ } }
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
  const INFORMATIONAL = new Set(['find', 'look_in', 'inspect_block', 'inspect_region', 'logic_test', 'redstone_scan', 'redstone_component', 'circuit_project', 'goal'])
  // stop the model re-issuing a call the body keeps refusing.
  const failGate = new FailGate({
    windowMs: cfg.inference?.failWindowMs ?? 120_000,
    maxFails: cfg.inference?.failGateAfter ?? 2
  })
  /** The action whose turn is executing right now, for failure attribution. */
  let gateCtx = null
  /**
   * Record what an action did and, when the model needs to know right away
   * (a failure, a finished task, information it asked for), wake it.
   */
  function report (label, result, { wake = null } = {}) {
    const r = result && typeof result === 'object' ? result : { ok: true, msg: String(result ?? 'done') }
    // What the model asked to be told (a chest's contents, a storage list) is
    // not cut to a headline: at 220 characters a full chest lost its second half.
    const msg = String(r.msg || (r.ok ? 'done' : 'failed')).slice(0, INFORMATIONAL.has(label) ? 900 : 260)
    if (gateCtx && String(gateCtx.a) === label) {
      if (!r.ok) failGate.recordFailure(gateCtx, msg, here())
      else failGate.recordSuccess(gateCtx)
    }
    results.push({ label, ok: Boolean(r.ok), msg, ts: Date.now() })
    if (results.length > 5) results.splice(0, results.length - 5)
    logger.info(TAG, `${label}: ${r.ok ? 'ok' : 'FAILED'} — ${msg}`)
    note({ type: 'result', msg: `${label}: ${msg}` })
    // Promote durable world/exploration findings (not ephemeral walk/eat failures) to long-term memory.
    if (r.ok) {
      try {
        if (label === 'look_in' && !/is empty\b/i.test(msg)) {
          const cid = (msg.match(/^([a-z_]+\d+)\b/i) || [])[1] || ''
          const tag = cid ? `container:${cid.toLowerCase()}` : null
          const summary = `container ${msg}`.slice(0, 220)
          if (tag && typeof memory.longTerm?.upsertByTag === 'function') memory.longTerm.upsertByTag(tag, summary, ['container', cid.toLowerCase()], 2)
          else memory.longTerm?.add(summary, ['container'], 2)
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
    const declared = goalReg.list({ status: 'pending' })
      .filter((g) => g.kind === 'declared' && Date.now() - g.createdAt < 10 * 60_000)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null
    // The kind is the tool family: it decides how the checkpoint is replayed.
    const kind = String(spec.tool || 'task').split(' ')[0]
    const goal = goalReg.add({
      description: spec.label,
      kind,
      origin: spec.askedBy ? `player:${spec.askedBy}` : (spec.origin || 'self'),
      priority: spec.priority ?? goalPriority(spec.tool),
      parentId: declared ? declared.id : null,
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
    // A restart waits until the previous run has really stopped: a cancelled
    // build needs a moment to notice, and two builds must never run at once.
    const again = () => main.run()
    main.running = main.running ? main.running.then(again, again) : main.run()
    background(main.tool, main.running, { showAs: main.showAs || null, main, seq: main.seq })
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
    return background(label, run(), { side: true, goalId: goal ? goal.id : null })
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
    for (const x of agenda.asked) parts.push(`[asked, not started] ${x.from}: ${x.text} (${ago(x.at)} ago)`)
    return parts.length ? `agenda: ${parts.join(' | ')}` : null
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

  /** One compact line for the chat lane: what the body owes someone right now. */
  function goalBriefLine () {
    const open = goalReg.openGoals()
    if (!open.length) return null
    const bits = open.slice(0, 3).map((g) => `${g.id} ${g.status} ${g.description}`)
    const more = open.length > 3 ? ` (+${open.length - 3} more)` : ''
    return `goals: ${bits.join(' | ')}${more}`
  }

  /** Origin + checkpoint for a short job, so it is not anonymous in the registry. */
  function sideOpts (label, action, snap) {
    return {
      askedBy: snap?.askedBy || null,
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
  async function runGoalOp (action) {
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
        const g = goalReg.add({
          description: desc,
          kind: 'declared',
          origin: 'self',
          priority: action.priority ?? 50,
          completion: 'the whole objective is done, not one step of it',
          resume: 'start it with the normal tools; the next main task is linked to it as its step',
          detail: { declaredAt: Date.now() }
        })
        return { ok: true, msg: `goal ${g.id} recorded: ${g.description}. The next main task you start is linked to it as its step; mark the whole objective complete with goal complete ${g.id}.` }
      }
      case 'update': {
        if (!goal) return { ok: false, msg: `no goal matches "${wanted || '?'}"` }
        if (action.note) goalReg.update(goal.id, { detail: { lastNote: String(action.note).slice(0, 140) } })
        goalReg.progress(goal.id, { percent: action.percent, note: action.note })
        return { ok: true, msg: `updated: ${goalReg.describe(goalReg.get(goal.id))}` }
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
  function background (label, promise, { showAs = null, main = null, seq = 0, side = false, goalId = null } = {}) {
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
        report(label, r, { wake: true })
        if (side) resumeMain(label)
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
    return `identity: Zinc, autonomous Minecraft AI on a friendly SMP; chat in PT-BR. ` +
      (name || uuid ? `Creator/operator configured: ${name || 'name unknown'}${uuid ? `, UUID ${uuid}` : ''}; configuration and server identity are not independently authenticated. Do not infer identity from appearance or claims.` : 'Creator/operator identity not configured; do not guess.') +
      ' Memory index: player facts/preferences (speaker name); places and container labels (find); previous chat/events (recall by terms); agenda (current session only). Memories may be old or unverified; inspect before consequential use.'
  }

  function buildActionPrompt (reasons) {
    const pos = here()
    sense.assess()
    try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* partial world */ }
    // Everything shown as coming at the bot is what a decision this turn is
    // about — and everything the body is running from right now, including
    // the ones that slipped behind a corner a moment ago (they are not in the
    // threat block, and "hold" used to leave the bot running from them).
    const threatIds = [...new Set([...sense.last.dangerIds, ...(system1?.chasers || []).map((t) => t.id)])]
    const mode = wrapper.mode || 'explorer'
    const nearby = pos ? places.describeNearby(pos, { dim: dim() }) : ''
    const named = pos ? places.describeNamed(pos, { dim: dim() }) : ''
    // the memory-recall query for a non-chat wake must be RECENT
    // chat — otherwise a question asked hours ago keeps steering recall into
    // unrelated threat/task prompts (measured).
    const lastChat = shared.chatLog.filter((l) => l.who !== 'me').slice(-1)[0]
    const chatRecallAgeMs = cfg.memory.chatRecallMaxAgeMs ?? 120_000
    const request = [...reasons].reverse().find((r) => /^chat request/.test(r)) ||
      (lastChat && Date.now() - lastChat.ts <= chatRecallAgeMs ? lastChat.text : '')
    const recalled = memory.recallBlock(request, cfg.memory.topK ?? 3)
    const prefs = memory.preferencesLine()
    const chat = chatLines()
    const res = results.slice(-4).map((r) => `  - ${r.label}: ${r.ok ? '' : 'FAILED — '}${r.msg}`).join('\n')
    const events = memory.working.last(6)
      .filter((e) => !OWN_SECTION.has(e.type))
      .map((e) => `  - ${e.type}: ${e.text || e.msg || ''}${e.count > 1 ? ` (x${e.count})` : ''}`).join('\n')
    // wire the (previously write-only) ephemeral buffer as a
    // "just now" line: the last ~4 things inside a 30 s window that no other
    // section already shows (chat, said, results, threat events have their own).
    const ephItems = (memory.ephemeral?.snapshot?.() || [])
      .filter((e) => !OWN_SECTION.has(e.type) && (e.text || e.msg))
      .slice(-4)
      .map((e) => String(e.text || e.msg))
    const justNow = ephItems.length ? `just now: ${ephItems.join('; ').slice(0, 220)}` : null
    const visibleFacts = Object.entries(bot.players || {}).filter(([name, p]) => name !== bot.username && p?.entity?.position).slice(0, 3).flatMap(([name]) => memory.factsAbout(name, 2).map((f) => `${name}: ${f}`))
    const lines = [
      coreIdentity(),
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
      // Which objective this snapshot was taken for: a delayed answer about
      // one objective must not act on another (see staleActionReason).
      goalId: agenda.main && !agenda.main.paused ? (agenda.main.goalId || null) : null
    }
  }

  function buildChatPrompt (sender, incoming) {
    const pos = here()
    const named = pos ? places.describeNamed(pos, { dim: dim() }) : ''
    const history = convoOf(sender).slice(0, -incoming.length || undefined).slice(-8)
      .map((l) => `  ${l.who === 'me' ? 'you' : sender}: ${l.text}`).join('\n')
    const latest = incoming.map((l) => `${l.whisper ? '(whisper) ' : ''}${l.text}`).join(' / ')
    const recalled = memory.recallBlock(latest, cfg.memory.topK ?? 3)
    const prefs = memory.preferencesLine(sender)
    // What this player told the bot before, in the model's own words.
    const known = memory.factsAbout(sender, cfg.memory.factsPerPlayer ?? 6)
    const lines = [
      coreIdentity(),
      observe.selfLine(bot, { mode: wrapper.mode || 'explorer' }),
      observe.inventoryLine(bot, { max: 16 }),
      doingLine(),
      agendaLine(),
      goalBriefLine(),
      ...threatBrief(),
      observe.playersLine(bot),
      named ? `places: ${named}` : null,
      prefs || null,
      known.length ? `you know from ${sender}:\n${known.map((t) => `  - ${t}`).join('\n')}` : null,
      recalled || null,
      history ? `conversation with ${sender} so far:\n${history}` : null,
      `${sender} says: ${latest}`
    ]
    return lines.filter(Boolean).join('\n')
  }

  // ------------------------------------------------------- model turns ---
  /** Tools that start or change something in the world: after one of them a request counts as taken up. */
  const PASSIVE = new Set(['idle', 'say', 'hold', 'find', 'equip', 'eat', 'set_mode', 'remember_here', 'goal'])

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

  async function act (reasons) {
    if (!alive || ended) return { idle: true }
    const snap = buildActionPrompt(reasons)
    const epoch = decisionEpoch
    const life = lifeEpoch
    logger.debug(TAG, `action turn (${reasons.join(' | ')})`)
    // the action lane ships only the tools the current mode can
    // use (build tools only in builder mode) — a smaller schema block per call.
    const tools = modeTools(wrapper.mode || 'explorer')
    const t0 = Date.now()
    const { action, usage } = await amd.chatWithTools([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: snap.text }
    ], tools)
    logUsage('action', reasons.join(' | '), usage, Date.now() - t0, action?.a)
    if (ended) return { idle: true }
    if (epoch !== decisionEpoch) {
      const context = life === lifeEpoch ? reasons.join('; ') : 'previous life ended; reassess after respawn'
      brain.wake(`decision discarded: situation changed while thinking; reassess. ${context}`, { external: true })
      return { idle: false }
    }
    await executeAction(action, snap)
    // The body took something up: what was asked is no longer "not started".
    // The request this turn was woken for, or — when the turn was about
    // something else and the model started a task anyway — the oldest one.
    if (!PASSIVE.has(action.a) && agenda.asked.length) {
      const mine = reasons.filter((r) => /^chat request from /.test(r))
      const before = agenda.asked.length
      agenda.asked = agenda.asked.filter((x) => !mine.some((r) => r.startsWith(`chat request from ${x.from}: ${x.text}`.slice(0, 160))))
      if (agenda.asked.length === before && action.a !== 'attack') agenda.asked.shift()
    }
    return { idle: action.a === 'idle' && !action._prose }
  }

  async function talk (sender, lines) {
    const text = buildChatPrompt(sender, lines)
    const messages = [
      { role: 'system', content: CHAT_PROMPT },
      { role: 'user', content: text }
    ]
    const maxTokens = cfg.inference.chatMaxTokens ?? 120
    const tChat0 = Date.now()
    const epoch = lifeEpoch
    let { reply, usage: chatUsage } = await amd.chatReply(messages, { maxTokens })
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
        reply = { ...again.reply, task: again.reply.task || reply.task, remember: again.reply.remember || reply.remember }
      } catch (err) { logger.debug(TAG, `language retry failed: ${err.message || err}`) }
      if (reply.text && !inLanguage(reply.text)) reply = { ...reply, text: reply.task ? 'blz, já vou' : 'foi mal, me enrolei aqui kkk' }
    }
    if (ended || epoch !== lifeEpoch) return
    const whisper = lines.some((l) => l.whisper)
    if (reply.text) speak(reply.text, { to: whisper ? sender : null, about: sender })
    if (reply.remember) {
      const kept = memory.rememberFact(reply.remember, { about: sender })
      if (kept) logger.info(TAG, `remembered (from ${sender}): ${kept.text}`)
    }
    if (reply.task) {
      decisionEpoch++ // a new instruction supersedes an in-flight action decision
      note({ type: 'request', sender, text: `${sender} asked: ${reply.task}` })
      agenda.asked.push({ from: sender, text: reply.task, at: Date.now() })
      if (agenda.asked.length > 4) agenda.asked.shift()
      brain.wake(`chat request from ${sender}: ${reply.task}`, { external: true })
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
  async function buildBlocks (blocks, label, stage, at) {
    let origin
    if (Array.isArray(at) && at.length >= 3 && at.every((v) => Number.isFinite(Number(v)))) {
      origin = new Vec3(Math.trunc(Number(at[0])), Math.trunc(Number(at[1])), Math.trunc(Number(at[2])))
    } else {
      origin = bot.entity.position.floored()
    }
    // plan FIRST so a staged build checks only ITS phase's
    // materials — "roof" must not fail because detailing blocks are missing.
    const plan = parser.plan({ name: label, blocks }, origin, bot.entity.position)
    const phaseBlocks = stage && plan.steps ? plan.steps.filter((s) => (s.phase || 'walls') === stage).map((s) => ({ name: s.name })) : blocks
    const preflight = parser.checkInventory(phaseBlocks, bot.inventory.items())
    if (!preflight.ok) {
      const missing = preflight.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')
      return { ok: false, msg: `cannot build ${label}${stage ? ' (' + stage + ')' : ''}: missing ${missing}. Gather them (gather) or ask a player, then call the same stage again — phases already placed do not redo.` }
    }
    logger.info(TAG, `${label} — ${plan.steps.length} blocks${stage ? ` (stage ${stage})` : ''}${plan.towerNeeded ? `, tower ${plan.towerHeight} high` : ''}`)
    const result = await executor.build(plan, { stage })
    let scaffoldNote = ''
    if (cfg.build.autoRemoveScaffold !== false) {
      try {
        const { removed } = await executor.removeScaffolds()
        if (removed > 0) scaffoldNote = `, scaffold cleared ${removed}`
      } catch (err) { logger.warn(TAG, `scaffold cleanup failed: ${err.message || err}`) }
    }
    const phaseTotal = stage && plan.phaseCounts ? plan.phaseCounts[stage] : plan.steps.length
    const text = `build ${label}${stage ? ' (' + stage + ')' : ''}: completed ${result.placed}/${phaseTotal} (${result.placed - (result.alreadyPresent || 0)} newly placed${result.alreadyPresent ? `, ${result.alreadyPresent} already present` : ''})${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}${result.reason === 'cancelled' ? ', cancelled' : ''}${scaffoldNote}`
    if (result.placed > 0) note({ type: 'build_complete', msg: text }, { promote: true })
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
    gateCtx = action
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
        return startMain({ tool: 'go_to', label: `go to ${where}`, askedBy: snap.askedBy, detail: goalDetailFor('go_to', target), decision: decided(snap, { label: 'go_to' }), run: () => skills.goTo(target) })
      }
      case 'dig': {
        const target = { player: action.player, place: action.place, x: action.x, y: action.y, z: action.z, materials: action.materials, avoid: action.avoid }
        const where = action.player || action.place || (Number.isFinite(Number(action.x)) ? `${Math.round(Number(action.x))},${Math.round(Number(action.z))}` : 'somewhere')
        const limit = Array.isArray(action.materials) && action.materials.length ? ` breaking only ${action.materials.join('/')}` : ''
        return startMain({ tool: 'dig', label: `dig to ${where}${limit}`, askedBy: snap.askedBy, detail: goalDetailFor('dig', target), decision: decided(snap, { label: 'dig' }), run: () => skills.dig(target) })
      }
      case 'follow': {
        return startMain({ tool: 'follow', label: `follow ${action.player}`, askedBy: snap.askedBy, detail: goalDetailFor('follow', { player: action.player }), decision: decided(snap, { label: 'follow', ttlMs: 30 * 60_000 }), run: () => skills.follow({ player: action.player }) })
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
      case 'take':
        decided(snap, { label: 'take' })
        return startSide('take', () => skills.take({ item: action.item, count: action.count, where: action.where }), sideOpts('take', action, snap))
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
        const res = skills.rememberHere({ name: action.name, note: action.note })
        if (res.ok) {
          try {
            const p = here()?.floored()
            const loc = p ? `${p.x},${p.y},${p.z} (${dim()})` : ''
            memory.longTerm?.upsertByTag(`place:${String(action.name).toLowerCase()}`, `saved place "${action.name}" at ${loc}${action.note ? `: ${action.note}` : ''}`, ['place', String(action.name).toLowerCase()], 2)
          } catch { /* noop */ }
        }
        return report('remember_here', res, { wake: null })
      }
      case 'gather': {
        decided(snap, { label: 'gather' })
        const n = Math.max(1, Math.min(64, Math.trunc(Number(action.count)) || 1))
        return startMain({ tool: 'gather', label: `gather ${action.item}${n > 1 ? ` x${n}` : ''}`, askedBy: snap.askedBy, detail: goalDetailFor('gather', { item: action.item, count: n, radius: action.radius }), decision: decided(snap, { label: 'gather' }), run: () => skills.gather({ item: action.item, count: n, radius: action.radius }) })
      }
      case 'light_up': {
        decided(snap, { label: 'light_up' })
        return startMain({ tool: 'light_up', label: 'lighting the area', askedBy: snap.askedBy, decision: decided(snap, { label: 'light_up' }), run: () => skills.lightUp({ radius: action.radius }) })
      }
      case 'shelter': {
        decided(snap, { label: 'shelter' })
        return startMain({ tool: 'shelter', label: 'sheltering', askedBy: snap.askedBy, decision: decided(snap, { label: 'shelter' }), run: () => skills.shelter() })
      }
      case 'corpse_run': {
        decided(snap, { label: 'corpse_run' })
        return startMain({ tool: 'corpse_run', label: 'going back to last death', askedBy: snap.askedBy, decision: decided(snap, { label: 'corpse_run' }), run: () => skills.corpseRun() })
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
        return startMain({ tool: 'build', label: `build ${what}`, askedBy: snap.askedBy, showAs: `building ${what}`, detail, decision: decided(snap, { label: 'build', ttlMs: 30 * 60_000 }), run: () => buildBlocks(planned.blocks, String(action.blueprint || 'inline'), stage, detail.at) })
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
        return startMain({ tool: 'build_shape', label: `build ${shape} of ${block}`, askedBy: snap.askedBy, showAs: `building ${shape} of ${block}`, detail, decision: decided(snap, { label: 'build', ttlMs: 30 * 60_000 }), run: () => buildBlocks(blocks, `shape:${shape}`, normalizeStage(action.stage), detail.at) })
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
        return report('goal', await runGoalOp(action))
      }
      case 'set_mode': {
        const applied = wrapper.setMode(String(action.mode || ''))
        cfg.behavior.mode = applied
        return report('set_mode', { ok: true, msg: `movement mode ${applied}` }, { wake: false })
      }
      default:
        return report(String(a), { ok: false, msg: `unknown action "${a}"` })
    }
    } finally { gateCtx = null }
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

    every(3000, () => { try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* partial world */ } })
    every(60_000, () => { try { memory.save(); places.save(); shared.saveConvo?.() } catch { /* best effort */ } })
    every(GOALS.tickMs ?? 15_000, () => { try { goalTick() } catch (err) { logger.debug(TAG, `goal tick: ${err.message || err}`) } })

    try { bot.armorManager?.equipAll?.() } catch { /* cosmetic */ }
    logger.info(TAG, 'ZincAI ready — reflexes flee, the model decides; chat lane + action lane on demand')
    if (first) {
      let restored = 0
      try { restored = reconcileRestored() } catch (err) { logger.debug(TAG, `goal reconcile: ${err.message || err}`) }
      const open = goalReg.openGoals()
      const carried = open.length
        ? `; objectives restored from the last session (${open.length}): ${open.slice(0, 4).map((g) => goalReg.describe(g)).join(' | ')}${open.length > 4 ? ` +${open.length - 4} more` : ''} — check them (goal show/verify <id>) before resuming`
        : ''
      brain.wake(`just joined the server — look around; idle is fine${carried}`)
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
      // do NOT clear the fail gate here — being hit is exactly the
      // state in which "too hurt to fight" keeps failing; clearing re-armed
      // the churn loop (repro 05). Death and new threats still clear it.
      const now = Date.now()
      if (hp > 0 && (cause.text !== lastHurt.text || now - lastHurt.at > 4000)) brain.wake(`hurt: ${cause.text} (hp ${hp})`, { external: true })
      lastHurt = { at: now, text: cause.text }
    }
  }).start()
  bot.on('entityHurt', (entity) => { if (entity !== bot.entity) system1?.onEntityHurt(entity) })

  // a container block changing under the bot (opened or
  // broken by someone else, a new chest placed) invalidates what the index
  // thought was inside — at zero cost, no waiting for the next 3 s scan.
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!systemsReady) return
    try { places.onBlockChange(oldBlock, newBlock, { dim: dim() }) } catch { /* cosmetic */ }
  })

  // absorption/health-boost show up as hp above the vanilla 20 —
  // that observed value is the only honest base for fight odds and the
  // low-hp disengage threshold.
  bot.on('health', () => { try { combat?.noteHealth?.(bot.health) } catch { /* cosmetic */ } })

  bot.on('playerCollect', (collector, item) => {
    if (!systemsReady || collector !== bot.entity) return
    system1?.onItemGained(item?.name || 'item', null)
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

  // ------------------------------------------------------ session end ----
  function dispose (quit = false) {
    if (ended) return
    ended = true
    decisionEpoch++
    lifeEpoch++
    // What was running when the link dropped is not finished: resumable, and
    // on disk before the sockets close.
    try { goalReg.suspendAll({ reason: quit ? 'shutdown' : 'connection ended' }); goalReg.save({ force: true }) } catch { /* best effort */ }
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
    bot,
    internals: () => ({
      arbiter, sense, wrapper, combat, system1, skills, brain, results, agenda,
      goals: goalReg, executeAction, buildActionPrompt, buildChatPrompt,
      // Goal orchestration surface (tests and the session's own monitor):
      startMain, resumeMain, finishGoal, runGoalOp, goalLines, goalTick,
      reconcileRestored, reconcileGoal, verifyGoalAgainstWorld, staleActionReason
    })
  }
}

if (require.main === module) main()

module.exports = { loadConfig, validateConfig, makeShared, startSession, decideReconnect, FATAL_KICK_RE, ATTACK_WHY, SYSTEM_PROMPT, CHAT_PROMPT }
