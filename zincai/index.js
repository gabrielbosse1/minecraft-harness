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
 *   node zincai/index.js --no-supervisor   one process; `update` then exits 75
 *                                    for an outer supervisor to restart
 *
 * Config: zincai/defaults.json (+ env overrides: MC_HOST, MC_PORT, MC_VERSION,
 *   MC_AUTH, AMD_API_BASE_URL, AMD_MODEL, AMD_API_KEY/API_KEY, ZINC_DATA_DIR,
 *   LOG_LEVEL). AMD key resolution order: env -> defaults.json.
 */
'use strict'

// `node zincai/index.js` is two processes: a tiny parent that only restarts
// the bot when it asks (the `update` / `restart` console commands), and the bot
// itself. The parent returns here, before anything heavy is loaded. Tests and
// `--check` / `--dry-run` never take this branch (see supervisor.js).
if (require.main === module && require('./supervisor').shouldSupervise(process.argv, process.env)) {
  require('./supervisor').supervise({ script: __filename })
  return
}

const fs = require('fs')
const path = require('path')
const { performance } = require('node:perf_hooks')
const { AsyncLocalStorage } = require('node:async_hooks')

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
const { AmdToolsClient, createZincTools, toolTurnMessages, ACTION_TOOLS } = require('./api_wrapper')
const { stamp: ircStamp, ago: ircAgo, formatLine: ircLine, LEGEND: IRC_LEGEND } = require('./irc')
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
  const file = path.join(ZINC_DIR, 'config', 'defaults.json')
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
  // defaults.json edit; they win over the file only when actually set.
  cfg.behavior.allowScaffolding = settings.bool('MC_ALLOW_SCAFFOLDING', cfg.behavior.allowScaffolding ?? false)
  cfg.behavior.autoElytra = settings.bool('MC_AUTO_ELYTRA', cfg.behavior.autoElytra ?? true)
  cfg.inference.rpm = settings.int('INFERENCE_RPM', cfg.inference.rpm, { min: 1, max: 600 })
  cfg.inference.minIntervalMs = settings.int('INFERENCE_MIN_INTERVAL_MS', cfg.inference.minIntervalMs, { min: 0 })
  cfg.inference.heartbeatMs = settings.int('INFERENCE_HEARTBEAT_MS', cfg.inference.heartbeatMs, { min: 0 })
  cfg.inference.loopMs = settings.int('INFERENCE_LOOP_MS', cfg.inference.loopMs ?? 8000, { min: 0 })
  cfg.inference.chatBatchMs = settings.int('INFERENCE_CHAT_BATCH_MS', cfg.inference.chatBatchMs ?? 6000, { min: 0 })
  cfg.reconnect.enabled = settings.bool('RECONNECT', cfg.reconnect.enabled ?? true)
  cfg.reconnect.maxAttempts = settings.int('RECONNECT_MAX_ATTEMPTS', cfg.reconnect.maxAttempts, { min: 1 })
  cfg.reconnect.keepAliveTimeoutMs = settings.int('KEEPALIVE_TIMEOUT_MS', cfg.reconnect.keepAliveTimeoutMs ?? 60_000, { min: 20_000 })

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
    /** chat AND events as one timestamped IRC-style log (irc.js) — what the prompts show */
    timeline: new (require('./irc').Timeline)({ max: cfg.inference?.timelineMax ?? 80 }),
    /** the model's standing rule for what a walk may break (dig_policy.js); persisted */
    digPolicy: new (require('./dig_policy').DigPolicy)({
      file: path.join(dataDir, 'dig-policy.json'),
      enabled: cfg.behavior?.digging?.enabled !== false,
      mode: cfg.behavior?.digging?.mode || 'list',
      allow: Array.isArray(cfg.behavior?.digging?.allow) ? cfg.behavior.digging.allow : null,
      logger: (level, msg) => logger[level]?.(TAG, msg)
    }),
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
/**
 * Process-level entry point.
 *
 * The shape is deliberate: ONE Host (configuration, boundary, connection
 * state machine, command interface) owns the process, and it creates sessions
 * on demand. Joining, leaving, restarting the link and pausing the body are
 * therefore operations of a live process, not of `main()`.
 */
function main () {
  if (process.argv.includes('--check')) {
    for (const m of ['./api_wrapper', './memory', './perception', './filter', './builder', './continuity', './custom_mineflayer/pathfinder_wrapper', './custom_mineflayer/doors', './custom_mineflayer/escape', './system1', './tactics', './reflex_registry', './vanilla_guard', './control', './threats', './places', './skills', './observe', './brain', './events', './redstone_engine', './runtime_config', './boundary', './connection', './death_recovery', './host', './control_commands', './irc', './dig_policy', './updater', './supervisor', './watchdog', './block_search', './armor', './lanes', './goals']) require(m)
    require('minecraft-data')('26.3') // postinstall patch must be in place
    logger.info(TAG, '--check OK — all modules load, 26.3 data present')
    return
  }

  const cfg = loadConfig()

  if (process.argv.includes('--dry-run')) {
    const errors = validateConfig(cfg)
    logger.info(TAG, `config: host=${cfg.server.host} port=${cfg.server.port} user=${cfg.server.username} auth=${cfg.server.auth} version=${cfg.server.version || 'auto'}`)
    logger.info(TAG, `amd: model=${cfg.amd.model} base=${cfg.amd.baseUrl} key=${cfg.amd.apiKey ? 'present' : 'MISSING'}`)
    logger.info(TAG, `data dir: ${DATA_DIR} (memories, places, goals, metrics, runtime-config)`)
    logger.info(TAG, `behaviour: elytra=${cfg.behavior.autoElytra ? 'yes' : 'no'} limits=${cfg.inference.rpm}/min`)
    logger.info(TAG, `agent loop: ${cfg.inference.heartbeatMs > 0 && cfg.inference.loopMs > 0 ? `every ${cfg.inference.loopMs}ms, backing off to ${cfg.inference.heartbeatMs}ms while idle` : 'off (events only)'}; up to ${cfg.inference.maxStepsPerTurn ?? 6} model steps per turn; chat window ${cfg.inference.chatBatchMs}ms`)
    logger.info(TAG, `limits: rpm=${cfg.inference.rpm} minInterval=${cfg.inference.minIntervalMs}ms heartbeat=${cfg.inference.heartbeatMs}ms reconnect=${cfg.reconnect.enabled ? `${cfg.reconnect.maxAttempts} attempts` : 'off'} keepAliveTimeout=${cfg.reconnect.keepAliveTimeoutMs}ms`)
    logger.info(TAG, `prompts: action ${SYSTEM_PROMPT.split(/\s+/).length} words, chat ${CHAT_PROMPT.split(/\s+/).length} words (static), ${ZINC_TOOLS.length} tools`)
    logger.info(TAG, 'policy: flee from real threats until the model decides; no PvP unless the model names a player; no friend list')
    // The control plane is part of the preflight: an empty operator list and a
    // prefix nobody knows are configuration mistakes, not surprises at runtime.
    try {
      const rc = new (require('./runtime_config').RuntimeConfig)({ file: path.join(DATA_DIR, 'runtime-config.json') })
      logger.info(TAG, `control: console=${rc.get('control.allowConsole') ? 'stdin' : 'off'} (no chat commands; no prefix) joinOnStart=${rc.get('connection.joinOnStart') ? 'yes' : 'no'}`)
    } catch (err) { logger.warn(TAG, `control: could not read the runtime config: ${err?.message || err}`) }
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

  // One Host for the whole process: it owns the runtime configuration, the
  // physical boundary, the link state machine and the command interface.
  // A session is something the Host creates, not something main() is.
  const host = shared.host || (shared.host = createHost(shared, cfg))

  function shutdown (code, reason) {
    if (shared.shuttingDown) return
    shared.shuttingDown = true
    logger.info(TAG, `shutting down (${reason})`)
    try { host.shutdown({ reason, quit: true }) } catch { /* already gone */ }
    try { shared.memory.save() } catch { /* best effort */ }
    try { shared.places.save(true) } catch { /* best effort */ }
    try { shared.saveConvo() } catch { /* best effort */ }
    summary()
    // Hard-exit safety net: the process must die with `code` even if the
    // socket never closes (join failure before spawn, etc.).
    setTimeout(() => process.exit(code), 1_000)
  }
  shared.shutdown = shutdown

  // A link that cannot be retried (a rejected first join, a ban, an exhausted
  // retry budget) ends the process — the same rule as before, now decided by
  // the connection manager instead of a setTimeout chain.
  host.on('fatal', (info) => {
    for (const line of fatalLines(info)) logger.error(TAG, line)
    shutdown(info?.reason === 'retries-exhausted' || info?.reason === 'fatal-error' || info?.reason === 'join-failed' ? 1 : 0, info?.reason || 'fatal')
  })
  host.on('ended' in host ? 'ended' : 'detach', () => { try { shared.memory.save(); shared.places.save(true) } catch { /* best effort */ } })
  host.connection.on('ended', () => { try { shared.memory.save(); shared.places.save(true) } catch { /* best effort */ } })

  process.on('SIGINT', () => shutdown(0, 'SIGINT'))
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  // The supervisor was killed outright (panel Kill, kill -9, OOM) and could not
  // pass a signal on: leave the server and exit instead of running on unowned.
  require('./supervisor').watchParent({ onGone: () => shutdown(0, 'the supervisor process is gone') })
  process.on('unhandledRejection', (err) => logger.error(TAG, `unhandled rejection: ${err?.message || err}`))
  process.on('exit', (code) => {
    try { shared.memory.save() } catch { /* best effort */ }
    // 75 is not a failure: it is `update` / `restart` asking the supervisor for a fresh process.
    if (code === require('./supervisor').RESTART_CODE) logger.info(TAG, 'exiting to restart on the source on disk')
    else if (code !== 0) logger.error(TAG, `exit code ${code}`)
  })
  // `update` / `restart` leave through the same door as every other exit:
  // save everything, leave the server, then exit with the restart code.
  host.exitProcess = (code, reason) => shutdown(code, reason)

  // Says what froze when something freezes: a stall of this thread is logged
  // with the function that held it, a silent server is logged as a silent
  // server. Report-only (watchdog.js); ZINCAI_WATCHDOG=0 turns it off.
  try {
    const { LoopWatchdog, watchdogEnabled, stackEnabled } = require('./watchdog')
    if (watchdogEnabled()) {
      shared.watchdog = new LoopWatchdog({ log: (level, msg) => logger[level]?.(TAG, msg), stack: stackEnabled() }).start()
      host.watchdog = shared.watchdog // `status` shows its counters
    }
  } catch (err) { logger.debug(TAG, `watchdog unavailable: ${err.message || err}`) }

  // The control interface is up before the first join: status, config, help and
  // even stop/resume work while the link is still CONNECTING.
  host.attachStdin()
  logger.info(TAG, 'control: console commands ready (no prefix: pause, shutdown, status). In-game chat is a conversation, never a command channel.')
  host.boot()
}

/** The lines a terminal connection failure prints. */
function fatalLines (info = {}) {
  const reason = info.reason || 'fatal'
  const text = info.text || 'no details'
  if (reason === 'join-failed') {
    return [
      `FATAL: join rejected before the first spawn (${text})`,
      `aborting. Check the host/port, the whitelist (name "${'ZincAI'}"), and MC_AUTH. A failed first join is never retried.`
    ]
  }
  if (reason === 'retries-exhausted') return [`FATAL: gave up reconnecting (${text})`]
  return [`FATAL: ${reason} — ${text}`]
}

/**
 * Build the process-level Host around a shared context.
 *
 * `createSession` here is the session FACTORY: the Host calls it for every
 * join, and each call produces a brand-new session with a brand-new bot, so a
 * reconnect can never inherit a stale listener, a stale lease or a stale world
 * snapshot.
 */
function createHost (shared, cfg, { dataDir = null } = {}) {
  const { Host } = require('./host')
  return new Host({
    dataDir: dataDir || shared.dataDir || DATA_DIR,
    logger,
    tag: TAG,
    createSession: (hooks) => startSession(shared, hooks && hooks.onEnded ? hooks.onEnded : null, { host: hooks?.host || shared.host || null, hooks })
  })
}

// ========================================================= one session ==
/**
 * One connection to the server: the bot and everything attached to it.
 *
 * Called once per join by the ConnectionManager (or directly by the test
 * harness). Everything a session owns is created here and destroyed by
 * `dispose()`, which is what makes "reconnect without duplicate listeners"
 * checkable: a second call builds a second, independent set of listeners on a
 * second bot.
 *
 * @param {object} shared process-level context (memory, places, goals, amd…)
 * @param {(info:object) => void} [onEnded] called once when this session's link ends
 * @param {{ host?: object, hooks?: object }} [opts]
 * @returns {{ dispose: (quit?: boolean) => void, subsystems: object }}
 */
function startSession (shared, onEnded, { host = null, hooks = null } = {}) {
  const { cfg, memory, places, amd, parser } = shared
  // One timestamped IRC-style log of chat and events (irc.js), and the model's
  // standing dig policy. Both live on `shared` so they outlive a reconnect.
  const timeline = shared.timeline || (shared.timeline = new (require('./irc').Timeline)())
  const digPolicy = shared.digPolicy || (shared.digPolicy = new (require('./dig_policy').DigPolicy)({ file: null }))
  // The host is the process-level shell. When a session is started directly
  // (the test harness), a minimal one is created so the boundary, the control
  // interface and the pause flag behave exactly as in production.
  const owner = host || shared.host || null
  // The shared enforcement boundary. It is consulted by the lane scheduler,
  // by every lane's key/goal write, by each physical tool and by the bot-level
  // guard below — one decision point, so no route can bypass it.
  const config = owner?.config || (shared.config = shared.config || new (require('./runtime_config').RuntimeConfig)({
    // One config per process: a directly-started session (the test harness)
    // still reads and writes the same persistent store a Host would.
    file: shared.dataDir ? path.join(shared.dataDir, 'runtime-config.json') : null,
    logger: (level, msg) => logger[level]?.(TAG, msg)
  }))
  const boundary = owner?.boundary || new (require('./boundary').PhysicalBoundary)({
    config,
    logger: (level, msg) => logger[level]?.(TAG, msg),
    getPosition: () => botRef()?.entity?.position || null,
    getDimension: () => { try { return PlaceIndex.dimensionOf(botRef()) } catch { return 'overworld' } }
  })
  const gateFor = (resources = []) => {
    // Only a physical lane is gated here: reads and reasoning are never
    // blocked by a pause, an area limit or a permission.
    if (!resources.some((r) => r === 'lane:BODY')) return null
    const verdict = boundary.check('__lane__', { caps: ['move'] })
    return verdict.ok ? null : verdict.why
  }
  // Logical execution lanes: BODY is exclusive, COMPUTATION / INTERACTION /
  // WORLD INFO may overlap. Every tool call takes a lease, and the lease is
  // released on success, failure, cancellation and context reset.
  const lanes = new LaneScheduler({ gate: gateFor })
  const jobs = new JobRegistry({ lanes })

  const mineflayer = require('mineflayer')
  const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')
  const { Vec3 } = require('vec3')
  const { ArmorKeeper } = require('./armor')

  const { buildVisionBlock, VISION_LEGEND } = require('./perception')
  const filter = require('./filter')
  const { BuilderExecutor, generateShape, normalizeStage } = require('./builder')
  const { PathfinderWrapper, scoutSafeAnchor } = require('./custom_mineflayer/pathfinder_wrapper')
  const { installVanillaGuard, assertVanillaAction } = require('./vanilla_guard')
  const { System1 } = require('./system1')
  const { ReflexRegistry, runScript } = require('./reflex_registry')
  const { ControlArbiter, PRIORITY } = require('./control')
  const { DeathRecovery } = require('./death_recovery')
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

  // `botRef` exists because the boundary is created before the bot: it asks for
  // the CURRENT bot, which a reconnect replaces.
  let bot = null
  // Every listener this session installs on its bot is recorded, so `dispose()`
  // can take all of them off again. A reconnect then builds ONE fresh set on a
  // new bot instead of stacking a second copy on the old one.
  const botListeners = []
  const onBot = (event, fn) => {
    bot.on(event, fn)
    botListeners.push([event, fn])
    return fn
  }
  const botRef = () => bot
  logger.info(TAG, `connecting to ${cfg.server.host}:${cfg.server.port} as "${cfg.server.username}" (auth=${cfg.server.auth}, version=${cfg.server.version || 'auto'})`)
  bot = mineflayer.createBot({
    host: cfg.server.host,
    port: cfg.server.port,
    username: cfg.server.username, // always ZincAI — enforced in loadConfig()
    version: cfg.server.version || false,
    auth: cfg.server.auth,
    // How long without a keep-alive before the client gives the link up. The
    // server sends one every 15 s; 30 s (the library default) drops the bot
    // after ONE late keep-alive — a server on a small board that stalls on a
    // world save, or a hitch on our side — and costs a reconnect and whatever
    // the body was doing. 60 s rides through that and still ends a dead link.
    checkTimeoutInterval: Math.max(20_000, Number(cfg.reconnect?.keepAliveTimeoutMs) || 60_000)
  })
  // Every packet from the server is a sign of life (watchdog.js): silence is
  // then reported as the server's, a stall of this thread as ours.
  try {
    const wd = shared.watchdog
    if (wd && bot._client?.on) {
      bot._client.on('packet', () => wd.traffic())
      bot._client.on('connect', () => wd.linkUp())
      bot._client.on('end', () => wd.linkDown())
    }
  } catch { /* a simulated bot has no client */ }
  // Runtime vanilla invariant: no slash-command can ever leave this process.
  const guard = installVanillaGuard(bot, { logger })
  bot.loadPlugin(pathfinder)
  // Network-level physical barrier: every primitive that could move the body or
  // change the world is refused while the body is paused, disconnected, dead or
  // outside its permissions. Installed BEFORE any subsystem gets the bot.
  const physicalGuard = require('./boundary').installPhysicalGuard(bot, boundary, {
    logger: (level, msg) => logger[level]?.(TAG, msg)
  })

  // --- who owns what ------------------------------------------------------
  const arbiter = new ControlArbiter(bot, { logger: wrapperLog })
  // Every lane write (keys and pathfinder goals) goes through the boundary, and
  // a lane that would drive the body while it is paused or forbidden stays
  // silent instead of pressing keys into a wall.
  arbiter.setGate((cap) => boundary.check('__lane__', { caps: [cap] }))
  // Wears the best armor carried (armor.js). It looks at the inventory when
  // something changes — it never reads an item out of an entity, which is how
  // the plugin it replaces crashed the process — and it leaves alone every
  // slot the model dressed or emptied itself. The model's choice (auto on/off,
  // held slots) lives on `shared`, so a reconnect does not forget it.
  const armorPrefs = shared.armorPrefs || (shared.armorPrefs = { auto: cfg.behavior.useArmorManager !== false, held: new Set() })
  const armor = new ArmorKeeper(bot, {
    prefs: armorPrefs,
    // Through the hand lock: one click sequence at a time, never across an eat or a swap.
    equip: (item, dest) => arbiter.useHand('armor', item, async () => {}, { dest, restore: false, priority: PRIORITY.task }),
    log: (level, msg) => logger[level]?.(TAG, msg),
    onWorn: (list) => note({ type: 'armor', msg: list.map((w) => `put on ${w.on}${w.off ? ` (was ${w.off})` : ''}`).join(', ') })
  })
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
    windCharge: cfg.traversal || {},
    // What an ordinary walk may break: the model's standing policy, under the
    // operator's switch, and never inside somebody else's build.
    digPolicy,
    digAllowed: () => config.get('actions.allowDig') !== false && config.get('actions.allowMovement') !== false,
    isProtected: (pos) => { try { return !continuity.propertyGuardAt(pos, dim(), {}).ok } catch { return false } },
    policyDigCost: cfg.behavior?.digging?.cost
  })

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
  /** The most recent boundary refusal inside this session: { at, what, why }. */
  let lastRefusal = null
  const onRefused = (entry) => { lastRefusal = entry }
  boundary.on('refused', onRefused)
  const continuity = shared.continuity || (shared.continuity = new ContinuityStore({
    file: path.join(shared.dataDir || DATA_DIR, 'continuity.json'),
    botName: cfg.server?.username || 'ZincAI'
  }))
  const redstoneInspector = new (require('./redstone_inspect').RedstoneInspector)(bot)
  const redstoneEngineer = new (require('./redstone_engine').RedstoneEngineer)(bot, {
    library: shared.redstoneLibrary,
    memory,
    executor: () => executor,
    // The engineer right-clicks levers and can place components; it is granted
    // those capabilities only for the duration of one engineering call (see
    // executeAction), so the standing permission stays the operator's.
    boundary,
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
  const deathRecovery = new DeathRecovery({
    config,
    logger: (level, msg) => logger[level]?.(TAG, msg),
    getPosition: () => here(),
    getDimension: () => dim(),
    getHealth: () => bot.health,
    getInventory: () => bot.inventory?.items?.() || [],
    checkRoute: (from, to) => checkRouteHome(from, to)
  })
  const sayQueue = []
  const timers = new Set()
  const every = (ms, fn) => { const t = setInterval(fn, ms); timers.add(t); return t }

  // Chat, results, requests and what the reflex did each have a section of
  // their own in the prompt; they stay out of the five-line event window so
  // they cannot push a real event ("hit by player Steve") out of it.
  const OWN_SECTION = new Set(['chat', 'said', 'result', 'request', 'threat', 'safe', 'fled'])
  // Event types that are already lines of the IRC log in their own right
  // (chat as <nick>, the bot's own lines as <Zinc>), or too noisy to be worth one.
  const TIMELINE_SKIP = new Set(['chat', 'said', 'request'])
  const note = (evt, opts = {}) => {
    try { memory.addEvent(evt, { window: !OWN_SECTION.has(evt?.type), ...opts }) } catch { /* never let memory break the loop */ }
    try {
      const text = evt?.msg || evt?.text
      if (text && !TIMELINE_SKIP.has(evt.type)) timeline.event(evt.type && !['result', 'threat', 'safe', 'fled'].includes(evt.type) ? `${evt.type}: ${text}` : String(text))
    } catch { /* the log is a view; never let it break the loop */ }
  }

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

  // Language is the model's call, not the harness's.
  //
  // There used to be a language gate here: every outgoing line was scored against
  // a Portuguese word list, a non-conforming `say` was held back and retried
  // once, and a chat reply that failed twice was replaced with a canned
  // Portuguese sentence. That made the bot speak the operator's language even
  // when a player was speaking another one, and it overrode the model's own
  // judgement about what to say — the harness editing its output. Removed.
  //
  // What remains is the model's own copy quality: it sees who is talking, in
  // which language, and answers accordingly. There is no `behavior.language`
  // switch to read — a hint about "the server's usual language" would be the
  // operator's guess about a conversation the model can see, so it is not
  // passed in at all.

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
  /** The bot's own nick in the IRC log. */
  const selfNick = () => bot.username || cfg.server?.username || 'Zinc'
  /**
   * Communication permissions. These are permission checks, not instructions:
   * they do not tell Zinc what to say or whom to trust — they decide only
   * whether a line may leave the process.
   */
  function maySpeak ({ to = null } = {}) {
    if (to) return config.get('communication.privateMessages') !== false
    return config.get('communication.publicChat') !== false
  }

  /** May the bot answer a player who addressed it at all? */
  function canReplyToChat () { return config.get('communication.replyToChat') !== false }

  /** Queue a chat line. Lines are spaced out, never dropped. */
  function speak (text, { to = null, about = null } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^\/+/, '').slice(0, 200)
    if (!t) return false
    if (!maySpeak({ to })) {
      logger.warn(TAG, `speech refused: ${to ? 'communication.privateMessages' : 'communication.publicChat'} is off`)
      // Tell the model the line did not go out, so it does not believe a
      // refusal is a delivery.
      report('say', { ok: false, msg: `NOT SENT — ${to ? 'private messages' : 'public chat'} are switched off by the operator (${to ? 'communication.privateMessages' : 'communication.publicChat'})` }, { wake: false })
      return false
    }
    sayQueue.push({ text: t, to, about })
    if (sayQueue.length > 6) sayQueue.splice(0, sayQueue.length - 6)
    flushSay()
    return true
  }
  function flushSay () {
    if (!sayQueue.length || ended) return
    // Two things used to happen here and no longer do: a per-minute cap on
    // public lines (limits.maxPublicChatPerMinute) that DROPPED the text once
    // reached, and a `behavior.chatCooldownMs` gap that throttled speech. A cap
    // that discards what the model decided to say is the harness overriding its
    // judgement; a dropped line is also invisible to the model.
    //
    // What remains is a pacing floor of one line per second. That is the
    // Minecraft server's own chat-rate behaviour (and most plugins mute a
    // burst), written where the model can see it: the line waits in the queue
    // and goes out, and `say` reports that it was queued. Nothing is discarded
    // for being the fifth line of the minute — the only budget left is the
    // model's API calls, not its words.
    const wait = 1000 - (Date.now() - lastSayAt)
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
      timeline.said(text, { to: whispered ? to : null })
      if (to || about) pushConvo(to || about, 'me', text)
      note({ type: 'said', msg: `I said${whispered ? ` to ${to}` : ''}: ${text}` })
    } catch (err) { logger.debug(TAG, `chat failed: ${err.message || err}`) }
    if (sayQueue.length) flushSay()
  }

  // ------------------------------------------------------ action results --
  const INFORMATIONAL = new Set(['find', 'look_in', 'inspect_block', 'inspect_region', 'logic_test', 'redstone_scan', 'redstone_component', 'redstone_engineer', 'recall', 'circuit_project', 'goal', 'note', 'social', 'remember_here', 'dig_policy'])
  // stop the model re-issuing a call the body keeps refusing.
  const failGate = new FailGate({
    windowMs: cfg.inference?.failWindowMs ?? 120_000,
    maxFails: cfg.inference?.failGateAfter ?? 2
  })
  /** The action whose turn is executing right now, for failure attribution. */
  let gateCtx = null
  /**
   * While a turn executes one of its tool calls, every result reported lands
   * here too, so the turn can hand it straight back to the model as that call's
   * output and continue (see act()).
   */
  let resultTap = null
  let currentActId = null
  /**
   * Lane-lease handoff.
   *
   * Some tools (`build_shape`, `build`, `gather`) do not finish inside
   * executeAction: they hand the physical work to startMain/startSide, which
   * run in the background. Releasing the lane lease in executeAction's finally
   * block therefore freed BODY while blocks were still being placed — a second
   * physical action could start mid-build. AsyncLocalStorage keeps each
   * invocation's lease separate when independent actions overlap; a claimed
   * lease is released when its background work really ends.
   */
  const leaseContext = new AsyncLocalStorage()

  /** Transfer a BODY lease from this invocation to its background work. */
  function adoptLease (promise, why) {
    const ctx = leaseContext.getStore()
    if (!ctx || ctx.claimed || ctx.lease?.lane !== LANES.BODY) return promise
    ctx.claimed = true
    return Promise.resolve(promise).finally(() => {
      try { ctx.lease.release(why) } catch { /* noop */ }
    })
  }
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
    const wakeText = `${label} ${r.ok ? 'done' : 'failed'}: ${msg}`
    if (resultTap) resultTap.push({ label, ok: Boolean(r.ok), msg, wakeText: shouldWake ? wakeText : null })
    if (shouldWake) brain?.wake(wakeText, { external: false })
  }

  // ------------------------------------------------------------ trust ----
  // The trust gate is gone.
  //
  // It was a name list in the config that decided, for chat-initiated actions
  // only, whether the model was allowed to give away a diamond or run a script:
  // an O(nobody)-line policy whose stated premise was that offline-mode names
  // are not identity anyway. The model reads who asked, what it has done for
  // them before and what it stands to lose, and decides; the harness does not
  // get a second veto it cannot explain to the model. Ownership and property
  // protection still exist and are still enforced, because those protect OTHER
  // players' builds from being damaged, not the model from thinking.

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
  /** Timeline sequence number the chat lane has already been shown (everything after it is "new"). */
  let chatSeenSeq = 0
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
    const ctx = leaseContext.getStore()
    const inheritedBody = Boolean(ctx && !ctx.claimed && ctx.lease?.lane === LANES.BODY)
    const previous = main.running
    const run = async (ctl = null) => {
      if (previous) { try { await previous } catch { /* previous run failed */ } }
      let ownLease = null
      try {
        // A resumed goal or side-job callback has no BODY lease to hand off.
        // Acquire one before starting any physical work, never from a caller
        // that already owns it.
        if (!inheritedBody) ownLease = await lanes.acquire(main.tool, { goalId: main.goalId })
        if ((!inheritedBody && !ownLease) || ended || agenda.main !== main || main.paused || ctl?.isCancelled()) {
          return { ok: false, msg: 'cancelled before starting' }
        }
        return await main.run()
      } finally {
        if (ownLease) ownLease.release(`${main.tool} finished`)
      }
    }
    let running
    if (main.tool === 'build' || main.tool === 'build_shape') {
      const job = jobs.start({ kind: main.tool, goalId: main.goalId, tool: main.tool, lane: false, run })
      main.jobId = job.id
      running = job.promise
    } else {
      running = run()
    }
    // The lane lease follows the WORK, not the call that started it.
    main.running = adoptLease(running, `${main.tool} finished`)
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
    main.pendingInterrupt = false
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
    const ctx = leaseContext.getStore()
    const inheritedBody = Boolean(ctx && !ctx.claimed && ctx.lease?.lane === LANES.BODY)
    const work = (async () => {
      let lease = null
      try {
        if (!inheritedBody) lease = await lanes.acquire(label, { goalId: goal?.id || null })
        if ((!inheritedBody && !lease) || ended) return { ok: false, msg: 'cancelled before starting' }
        return await run()
      } finally { if (lease) lease.release(`${label} finished`) }
    })()
    return background(label, adoptLease(work, `${label} finished`), { side: true, goalId: goal ? goal.id : null, actId })
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
    jobs.cancelForGoal(goalId, 'goal changed')
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
          if (main.paused || main.pendingInterrupt) return
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

  /**
   * Why the body is not acting, when the reason is not the model's decision.
   * A paused body cannot do anything at all, so the model is told that in one
   * line instead of being shown a snapshot that invites another call.
   */
  function boundaryLine () {
    const paused = owner?.paused === true
    const link = owner?.connection?.state
    if (link && link !== 'CONNECTED') return `body: not connected (${link}) — no physical action can run right now; goals are safe, say something only if it was queued`
    if (paused) return 'body: PAUSED by the operator — no physical action will run; goals stay suspended (not deleted) until resume; you may still reason, talk if permitted, and plan'
    if (lastRefusal && Date.now() - lastRefusal.at < 20_000) return `body: last physical action refused — ${lastRefusal.what}: ${lastRefusal.why}`
    return null
  }

  /** What the body is doing, in one short sentence, for `status`. */
  function activityText () {
    const parts = []
    const cur = skills?.current()
    if (cur) parts.push(`${cur.label} (${cur.seconds}s)`)
    else if (task) parts.push(`${task.label} (${Math.round((Date.now() - task.startedAt) / 1000)}s)`)
    if (combat?.isEngaged) parts.push(`fighting ${fight?.label || 'target'}`)
    if (system1?.fleeing) parts.push('fleeing by reflex')
    const main = agenda.main
    if (main) parts.push(`${main.paused ? 'paused: ' : ''}${main.label}${main.goalId ? ` [${main.goalId}]` : ''}`)
    if (!parts.length) parts.push('nothing')
    return parts.join('; ')
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
    if (system1?.fleeing) {
      const errand = system1.dodgingFor
      lines.push(errand
        ? `  decide: idle = let the body dodge and go back to "${errand}" by itself | attack = fight | hold = stop dodging, they are harmless or accepted | stop = give up "${errand}"`
        : '  decide: idle = keep fleeing | attack = fight | go_to / follow = go there instead | hold = stop running, they are harmless or accepted')
    }
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

  /**
   * The recent log, IRC style: every line with its clock time, chat and events
   * in the one order they happened. `kinds` narrows it (the action prompt has
   * its own sections for results and threats, so it shows chat + world events).
   */
  function chatLines (max = 10, opts = {}) {
    return timeline.format({ max, self: selfNick(), ...opts })
  }
  /** The header that tells the model how to read the log and what time it is. */
  function logHeader (label = 'log') {
    return `${label} (IRC style, oldest first; it is now ${ircStamp(Date.now())}; ${IRC_LEGEND}; you are <${selfNick()}>)`
  }

  /** What a walk may break right now — the model's own standing rule. */
  function diggingLine () {
    if (config.get('actions.allowDig') === false) return 'digging: OFF by the operator (actions.allowDig) — nothing can be broken'
    return `digging: ${digPolicy.describe()}`
  }

  /**
   * Is the body holding something you *build* with? The 3D cross-section used
   * to be builder-mode-only; the grid is now offered whenever the situation
   * looks like building, so the model is never handed a build job blind.
   */
  const BUILD_BLOCK_HINT = /(planks|log|stone|dirt|cobble|brick|concrete|terracotta|wool|glass|sand|gravel|deepslate|_slab|_stairs|_fence|_wall|scaffold|torch|redstone|_door|_trapdoor|ladder|rail)/i
  function holdingBuildMaterials () {
    try {
      const held = bot.heldItem?.name
      if (held && BUILD_BLOCK_HINT.test(held)) return true
      // Mid-build the executor holds a scaffold or a placement item even when
      // the model is between tool calls; the running task is the better signal.
      if (task && /build/i.test(String(task.tool || ''))) return true
      return false
    } catch { return false }
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
    const chat = chatLines(16, { maxAgeMs: cfg.inference?.logMaxAgeMs ?? 15 * 60_000 })
    const res = results.slice(-4).map((r) => `  - ${r.label}: ${r.ok ? '' : 'FAILED — '}${r.msg}`).join('\n')
    // (World events used to be an untimed `events:` list here. They are lines
    // of the IRC log now — `[14:02:07] * hurt: hit by player Steve` — in order
    // with the chat they happened between.)
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
      observe.selfLine(bot),
      armor.brief() || null,
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
      diggingLine(),
      chat ? `${logHeader('log')}:\n${chat}` : null,
      res ? `results (your last actions):\n${res}` : null,
      perceived.text ? `perceived (timestamped; [NEW] = not yet delivered, "(scanned_diff)" = you discovered it late, exact time unknown):\n${perceived.text}` : null,
      failGate.advisoryLine(pos) || null,
      boundaryLine(),
      justNow,
      `why now: ${reasons.join('; ')}`
    ]
    // The 3D grid used to be builder-only. Building is something the model
    // chooses, so the sense it builds WITH must not be locked behind a persona:
    // if it is holding blocks (or something it made), it gets the grid.
    if (holdingBuildMaterials()) {
      try { lines.push(`grid (legend: ${VISION_LEGEND}):\n${buildVisionBlock(bot, { range: 6, radius: 6, heightUp: 5, heightDown: 2 })}`) } catch { /* cosmetic */ }
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

  /**
   * The chat chunk, as a person reads a chat window.
   *
   * `incoming` is every line from the batching window — several players, replies
   * to each other, whispers mixed in, in arrival order. The model is given the
   * whole thing and decides what concerns it; nothing here scores relevance,
   * matches its name, or decides which line is "for" it. The one thing this
   * function does do is make the stream legible: who spoke, in what order, and
   * whether it was said aloud or whispered.
   */
  /**
   * Who is on the server. With one other player online there is nobody else
   * their public chat could be for — the model used to read "is this line for
   * me?" as an open question even then, and stayed silent to direct questions.
   */
  function roomLine () {
    const self = bot.username
    const names = Object.keys(bot.players || {}).filter((n) => n && n !== self)
    if (!names.length) return null
    if (names.length === 1) return `room: only you and ${names[0]} are online — whatever ${names[0]} says in public chat is said to you`
    return `room: ${names.length} other players online (${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}) — public chat may be for any of you`
  }

  function buildChatPrompt (sender, incoming) {
    const pos = here()
    if (pos) { try { places.scan(bot, { radius: cfg.places.scanRadius ?? 16 }) } catch { /* partial world */ } }
    const nearby = pos ? places.describeNearby(pos, { dim: dim() }) : ''
    const named = pos ? places.describeNamed(pos, { dim: dim() }) : ''
    const self = selfNick()
    const latest = incoming.map((l) => l.text).join(' / ')
    const speakers = [...new Set(incoming.map((l) => l.sender).filter(Boolean))]
    const others = speakers.filter((n) => n !== sender)
    const recalled = memory.recallBlock(latest, cfg.memory.topK ?? 3)
    const prefs = memory.preferencesLine(sender)
    // What this player told the bot before, in the model's own words.
    const known = memory.factsAbout(sender, cfg.memory.factsPerPlayer ?? 6)
    const relLine = continuity.formatRelationship(sender)

    // THE LOG. One IRC-style window: what was already there (chat and events,
    // each with its clock time), a marker, then everything that arrived since
    // the last time this lane answered — the lines to react to, and whatever
    // happened in the world between them.
    const windowMax = cfg.inference?.chatLogLines ?? 16
    const seenSeq = chatSeenSeq
    const all = timeline.tail({ max: 400 })
    const fresh = all.filter((e) => e.seq > seenSeq)
    // A line that reached the brain without passing through the chat handler
    // (a test, a replay) is still part of the window.
    for (const l of incoming) {
      const kind = l.whisper ? 'whisper' : 'chat'
      if (!fresh.some((e) => e.kind === kind && e.who === l.sender && e.text === String(l.text).replace(/\s+/g, ' ').trim().slice(0, 240))) {
        fresh.push({ seq: Infinity, ts: l.at ?? Date.now(), kind, who: l.sender, text: l.text })
      }
    }
    fresh.sort((x, y) => x.ts - y.ts)
    const older = all.filter((e) => e.seq <= seenSeq).slice(-Math.max(4, windowMax - Math.min(fresh.length, windowMax - 4)))
    chatSeenSeq = timeline.seq
    const fmt = (e) => `  ${ircLine(e, { self })}`
    const newChat = fresh.filter((e) => e.kind === 'chat' || e.kind === 'whisper')
    // Lines from before this process's log (a restart ago): what was said, how long ago.
    const oldestShown = older.length ? older[0].ts : (fresh.length ? fresh[0].ts : Date.now())
    const earlier = convoOf(sender).filter((l) => l.ts < oldestShown).slice(-4)
      .map((l) => `  [${ircAgo(Date.now() - l.ts)} ago] <${l.who === 'me' ? self : sender}> ${l.text}`).join('\n')
    const lines = [
      coreIdentity(),
      observe.selfLine(bot),
      observe.inventoryLine(bot, { max: 16 }),
      doingLine(),
      agendaLine(),
      goalBriefLine(),
      `relationship with ${relLine}`,
      ...threatBrief(),
      observe.playersLine(bot),
      roomLine(),
      nearby ? `nearby: ${nearby.split('\n').join(' | ')}` : null,
      named ? `places: ${named}` : null,
      prefs || null,
      known.length ? `you know from ${sender}:\n${known.map((t) => `  - ${t}`).join('\n')}` : null,
      recalled || null,
      earlier ? `earlier with ${sender} (before this log):\n${earlier}` : null,
      `${logHeader('chat log')}:`,
      older.length ? older.map(fmt).join('\n') : '  (nothing earlier)',
      `  ----- NEW since you last answered: ${newChat.length} chat line${newChat.length === 1 ? '' : 's'} from ${speakers.join(', ') || 'nobody'} (the last few seconds, batched) -----`,
      fresh.map(fmt).join('\n'),
      // One new line: say plainly which one is to be answered.
      newChat.length === 1 ? `${newChat[0].who} says: ${newChat[0].text}` : null,
      others.length
        ? 'more than one person is talking; decide for yourself who you are answering (set `to`), and name them in your line if it is unclear.'
        : null
    ]
    return lines.filter(Boolean).join('\n')
  }

  // ------------------------------------------------------- model turns ---
  /** Read-only / setup actions that inspect state before deciding on a pending player proposal. */
  function isPreDecisionInspect (action) {
    if (!action) return false
    const a = String(action.a || '')
    if (['look_in', 'inspect_block', 'inspect_region', 'redstone_scan', 'redstone_component', 'redstone_engineer', 'recall', 'find', 'equip', 'eat'].includes(a)) return true
    if (a === 'social' && ['list', 'show'].includes(String(action.operation || 'list'))) return true
    if (a === 'goal' && ['list', 'show', 'verify'].includes(String(action.operation || 'list'))) return true
    return false
  }

  // one metrics JSONL line per model call — the usage numbers in
  // this repo's cost tables stop being estimates the first time this runs
  // against a live endpoint that reports them.
  let metricsWarned = false
  const SLOW_CALL_MS = 20_000
  let slowCallSaidAt = 0
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
      // A slow endpoint is the usual reason "the bot does nothing for half a
      // minute": say so where the operator is looking, at most once a minute.
      if (row.ms >= SLOW_CALL_MS && Date.now() - slowCallSaidAt > 60_000) {
        slowCallSaidAt = Date.now()
        logger.info(TAG, `model call took ${(row.ms / 1000).toFixed(0)}s (${lane} lane${row.in ? `, ${row.in} prompt tokens` : ''}${row.out ? `, ${row.out} generated` : ''}) — the bot waits for the endpoint, not the other way round; every call is timed in metrics.jsonl`)
      }
    } catch (err) {
      if (!metricsWarned) { metricsWarned = true; logger.warn(TAG, `metrics log unavailable: ${err.message || err}`) }
    }
  }
  // One tool schema, built once. It is byte-identical on every call, which is
  // what prefix caching needs, and it never shrinks: there is no mode to be in.
  const ALL_TOOLS = createZincTools()

  // ------------------------------------------------------ the agent turn --
  /** Declared argument names per tool, to echo a call back to the model exactly as it made it. */
  const TOOL_PROPS = new Map(ACTION_TOOLS.map((t) => [t.name, new Set(Object.keys(t.parameters?.properties || {}))]))
  function publicArgs (action) {
    const props = TOOL_PROPS.get(action.a)
    const out = {}
    for (const [k, v] of Object.entries(action || {})) {
      if (k === 'a' || k.startsWith('_') || v === undefined) continue
      if (props && !props.has(k)) continue
      out[k] = v
    }
    return out
  }
  /** An answer that called nothing usable (prose, an invented tool, broken arguments). */
  const isBrokenCall = (action) => Boolean(action && (action._prose || action._unknownTool || action._badArgs || action._fallback))
  /** Is the body in the middle of something a tool started? (A reflex running is not a task.) */
  const bodyWorking = () => Boolean(skills?.current() || task || combat?.isEngaged)
  /**
   * Does this call leave the model with something to react to in the SAME turn?
   * A failure does (fix it now). Anything that returns information does (that
   * is why it was asked). Talking and note-taking do not: they are done when
   * they are sent, and a second model call just to hear "ok" would be waste.
   */
  const FIRE_AND_FORGET = new Set(['say', 'note', 'remember_here'])
  function wantsFollowUp (action, outputs) {
    if (outputs.some((o) => !o.ok)) return true
    const a = action.a
    if (FIRE_AND_FORGET.has(a)) return false
    if (a === 'goal') return ['list', 'show', 'verify'].includes(String(action.operation || 'list'))
    if (a === 'social') return ['list', 'show'].includes(String(action.operation || 'list'))
    return true
  }
  /** `tool` = OpenAI tool messages; `text` = the same content as plain messages (set once an endpoint rejects the former). */
  let toolResultFormat = cfg.inference?.toolResultFormat === 'text' ? 'text' : 'tool'

  /**
   * ONE TURN OF THE AGENT LOOP.
   *
   * A turn used to be one model call and one tool call: "answer Steve AND
   * start following him" was two turns, and a `find` could not be acted on
   * until some later event woke the model again. A turn is now a loop:
   *
   *   think → call any number of tools → read what they returned → think …
   *
   * It keeps going while the model has something to react to, and ends when
   *   - the model calls `idle` (nothing more to do right now),
   *   - a tool put the body to work (go_to, follow, build…): that work runs in
   *     the background and its result starts the next turn,
   *   - every call was fire-and-forget (say, note) and succeeded,
   *   - a player's request preempted it, the world changed under it, or the
   *     step / rate budget ran out.
   * Between turns the scheduler (brain.js) starts the next one by itself.
   */
  async function act (reasons, meta = null) {
    if (!alive || ended) return { idle: true }
    const snap = buildActionPrompt(reasons)
    const epoch = decisionEpoch
    const life = lifeEpoch
    logger.debug(TAG, `action turn (${reasons.join(' | ')})`)
    const tools = ALL_TOOLS
    const maxSteps = Math.max(1, Math.min(12, Math.trunc(Number(cfg.inference.maxStepsPerTurn ?? 6)) || 1))
    const head = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: snap.text }
    ]
    /** What each earlier step of this turn called and got back: [{ calls, content }]. */
    const history = []
    const buildMessages = () => [...head, ...history.flatMap((h) => toolTurnMessages(h.calls, { format: toolResultFormat, content: h.content }))]
    /** Every action this turn executed, in order. */
    const executed = []
    let step = 0
    for (;;) {
      step++
      const t0 = Date.now()
      const invokeMono = performance.now()
      if (step === 1 && meta && Number.isFinite(meta.queuedMono)) {
        latency.record('queueToModelMs', Math.max(0, (meta.invokeMono || invokeMono) - meta.queuedMono))
      }
      // The call is abortable — but not by ordinary chat any more (the chat lane
      // answers on its own). It is cancelled when a player's request has just
      // been handed to the body (brain.preempt): what this thought is deciding
      // is then already out of date.
      const controller = new AbortController()
      brain.inflightAbort = (why) => {
        if (controller.signal.aborted) return false
        logger.info(TAG, `interrupting action turn (${why})`)
        controller.abort()
        return true
      }
      let result
      try {
        try {
          result = await amd.chatWithTools(buildMessages(), tools, { signal: controller.signal })
        } catch (err) {
          // An endpoint whose chat template rejects tool messages: say the same
          // thing in plain text, for the rest of the session.
          if (step > 1 && toolResultFormat === 'tool' && [400, 404, 415, 422].includes(Number(err?.status))) {
            logger.warn(TAG, `endpoint rejected tool-result messages (HTTP ${err.status}); sending tool results as text from now on`)
            toolResultFormat = 'text'
            result = await amd.chatWithTools(buildMessages(), tools, { signal: controller.signal })
          } else throw err
        }
      } catch (err) {
        if (step === 1) throw err
        // What already ran, ran. Its results are still queued as wake-ups.
        logger.warn(TAG, `turn step ${step} failed (${err?.message || err}); the turn ends here`)
        break
      } finally {
        if (brain) brain.inflightAbort = null
      }
      const actions = Array.isArray(result.actions) && result.actions.length ? result.actions : [result.action]
      latency.record('modelInferenceMs', performance.now() - invokeMono)
      logUsage('action', `${step > 1 ? `step ${step}: ` : ''}${reasons.join(' | ')}`, result.usage, Date.now() - t0, actions.map((x) => x?.a).join('+'))
      if (ended) return { idle: true }
      // A turn cancelled mid-thought is not a failure and not an idle: nothing
      // it "decided" may run. On the first step, ask again; on a later one the
      // request that preempted it is already queued.
      if (actions[0] && actions[0]._interrupted) {
        if (step === 1) brain.wake(`reassess: your previous thinking was interrupted because a player's request came first. ${reasons.join('; ')}`, { external: true, fast: true })
        return { idle: false }
      }
      if (epoch !== decisionEpoch) {
        if (step === 1) {
          const context = life === lifeEpoch ? reasons.join('; ') : 'previous life ended; reassess after respawn'
          brain.wake(`decision discarded: situation changed while thinking; reassess. ${context}`, { external: true })
        }
        return { idle: false }
      }
      // The model successfully received all action outcomes included in this snapshot.
      if (step === 1 && snap.shownActionIds?.length) continuity.markActionsDelivered(snap.shownActionIds)

      // ---- run every call of this answer, in order ----
      const calls = []
      const consumedWakes = []
      let wantsEnd = false
      let bodyStarted = null
      let followUp = false
      for (const action of actions) {
        if (ended || !alive) break
        const callName = action._unknownTool || action._badArgs || action.a
        const plainIdle = action.a === 'idle' && !isBrokenCall(action)
        if (plainIdle) wantsEnd = true
        // The body does one thing at a time. A second physical call in the same
        // answer would cancel the first before it took a step.
        if (bodyStarted && laneOf(action.a) === LANES.BODY) {
          const text = `NOT RUN: ${bodyStarted} was started by this same answer and the body does one thing at a time. Wait for its result (you will be woken), then call ${action.a}.`
          calls.push({ id: action._callId, name: callName, args: publicArgs(action), result: text })
          logger.info(TAG, `${action.a} skipped: ${bodyStarted} already started in this answer`)
          continue
        }
        const tap = []
        resultTap = tap
        try {
          await executeAction(action, snap)
        } finally {
          if (resultTap === tap) resultTap = null
        }
        executed.push(action)
        const own = tap.filter((r) => r.label === action.a || (action.a === 'idle' && r.label === 'reply'))
        const startedBody = !plainIdle && !own.length && laneOf(action.a) === LANES.BODY && bodyWorking()
        let text
        if (startedBody) {
          bodyStarted = action.a
          text = `started — ${doingLine().replace(/^doing: /, '')}. It runs by itself; its result starts your next turn. Do not call it again.`
        } else if (tap.length) {
          text = tap.map((r) => `${r.label === action.a ? '' : `${r.label}: `}${r.ok ? '' : 'FAILED — '}${r.msg}`).join(' | ')
        } else {
          text = plainIdle ? 'ok' : (action.a === 'say' ? 'sent' : 'done')
        }
        calls.push({ id: action._callId, name: callName, args: publicArgs(action), result: text })
        for (const r of tap) if (r.wakeText) consumedWakes.push(r.wakeText)
        // A broken answer (prose, an invented tool) ends the turn and is told
        // about it at the start of the next one, with a fresh snapshot.
        if (!plainIdle && !isBrokenCall(action) && !startedBody && wantsFollowUp(action, tap)) followUp = true
      }

      if (!followUp || wantsEnd || bodyStarted || ended || !alive) break
      if (step >= maxSteps) { logger.info(TAG, `turn reached its step limit (${maxSteps}); the next turn continues`); break }
      if (brain.preempted || epoch !== decisionEpoch || life !== lifeEpoch) break
      if (!brain.takeCall('action')) { logger.debug(TAG, 'turn paused: model budget for this minute is spent'); break }
      // These results are handed back right now, as tool output: they must not
      // also wake a second turn about the same thing.
      brain.unwake(consumedWakes)
      history.push({ calls, content: result.content || '' })
    }

    // Player requests are optional proposals. Once Zinc has completed a non-inspect
    // decision turn where a proposal was presented — whether accepting, scheduling
    // via `goal`, negotiating/declining via `say` or `social`, ignoring via `idle`,
    // or continuing its own work — resolve that proposal cleanly without nagging or
    // retrying until compliance!
    const action = executed.find((x) => x.a !== 'idle' && !isPreDecisionInspect(x)) || executed[0] || { a: 'idle' }
    if (snap.shownProposals?.length && executed.length && !isPreDecisionInspect(action) && !isBrokenCall(action)) {
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
    return { idle: executed.length === 0 || executed.every((x) => x.a === 'idle' && !x._prose) }
  }

  /** Which player a chat reply is about: the one it names, if they are in the window or online; else the last speaker. */
  function replyTarget (reply, sender, lines) {
    const wanted = String(reply?.to || '').trim().toLowerCase()
    if (!wanted) return sender
    const known = [...new Set([...lines.map((l) => l.sender), ...Object.keys(bot.players || {})].filter(Boolean))].filter((n) => n !== bot.username)
    return known.find((n) => n.toLowerCase() === wanted) || known.find((n) => n.toLowerCase().startsWith(wanted)) || sender
  }

  /** The body actions the chat lane may start by itself (`reply.do`). */
  const CHAT_DO = {
    follow: (who) => ({ a: 'follow', player: who }),
    come: (who) => ({ a: 'go_to', player: who }),
    stop: () => ({ a: 'stop' })
  }

  /** Why a chat window got no line: the model's own choice, or an answer that never arrived whole. */
  function silentWhy (reply) {
    if (reply._empty === 'cut_off') return '(no answer: the model\'s output was cut off before it finished a reply — raise inference.chatMaxTokens if this repeats)'
    if (reply._empty === 'no_call') return '(no answer: the model returned neither a reply call nor text)'
    return `(chose not to answer${reply.decision ? `: ${reply.decision}` : ''})`
  }

  async function talk (sender, lines, meta = null) {
    const text = buildChatPrompt(sender, lines)
    const messages = [
      { role: 'system', content: CHAT_PROMPT },
      { role: 'user', content: text }
    ]
    const maxTokens = cfg.inference.chatMaxTokens ?? 200
    const tChat0 = Date.now()
    const chatInvokeMono = performance.now()
    if (meta && Number.isFinite(meta.queuedMono)) {
      latency.record('queueToModelMs', Math.max(0, (meta.invokeMono || chatInvokeMono) - meta.queuedMono))
      latency.record('architectureOverheadMs', Math.max(0, (meta.invokeMono || chatInvokeMono) - meta.queuedMono))
    }
    const epoch = lifeEpoch
    const { reply, usage: chatUsage } = await amd.chatReply(messages, { maxTokens })
    latency.record('modelInferenceMs', performance.now() - chatInvokeMono)
    if (ended || epoch !== lifeEpoch) return
    logUsage('chat', `${sender}: ${lines.map((l) => l.text).join(' / ').slice(0, 60)}`, chatUsage, Date.now() - tChat0, 'reply')
    if (ended || epoch !== lifeEpoch) return
    // Who this answer is for: the player the model named, else the last speaker.
    const target = replyTarget(reply, sender, lines)
    // A chunk may mix whispers and public lines. Answer the loudest constraint:
    // if any line in it was whispered to the bot, the reply stays private, so a
    // private question is never answered in public just because someone else
    // said something in the same few seconds.
    const whisper = lines.some((l) => l.whisper)
    const whisperTo = whisper ? (lines.some((l) => l.whisper && l.sender === target) ? target : lines.find((l) => l.whisper).sender) : null
    if (reply.text && !canReplyToChat()) {
      logger.warn(TAG, `chat reply to ${target} not sent: communication.replyToChat is off`)
    } else if (reply.text) {
      // The answer itself is not "new" to the next window — unless someone
      // spoke while it was being written, in which case their line stays new.
      const unseen = timeline.tail({ max: 400, afterSeq: chatSeenSeq }).some((e) => e.kind === 'chat' || e.kind === 'whisper')
      speak(reply.text, { to: whisperTo, about: target })
      if (!unseen) chatSeenSeq = timeline.seq
    }
    if (reply.remember) {
      const kept = memory.rememberFact(reply.remember, { about: target })
      if (kept) logger.info(TAG, `remembered (from ${target}): ${kept.text}`)
    }
    for (const who of new Set([sender, target])) continuity.touchPlayer(who, { interacted: true })
    const incomingSummary = lines.map((l) => l.text).join(' / ').slice(0, 120)
    if (reply.decision && !reply.task && !reply.do) {
      continuity.recordProposalOutcome(target, incomingSummary, reply.decision, reply.text || '', { explicit: true })
    }
    // `do`: the chat lane decided the body should act, and the act is one of
    // the three that need no planning. It starts NOW — while the line is still
    // being typed out — instead of waiting for an action-lane thought that can
    // take a minute. The body's own lane is told through the usual result.
    const doIt = reply.do && CHAT_DO[reply.do] ? CHAT_DO[reply.do](target) : null
    if (doIt && alive && !ended) {
      note({ type: 'request', sender: target, text: `${target} asked: ${reply.do}${reply.do === 'stop' ? '' : ` ${target}`} — started from chat` })
      continuity.recordProposalOutcome(target, incomingSummary, 'accept', reply.text || reply.do, { explicit: true })
      // Whatever the action lane is thinking right now was decided before this.
      brain.preempt(`chat started ${reply.do}`)
      const chatSnap = {
        text: '',
        threatIds: [...new Set([...(sense.last?.dangerIds || []), ...(system1?.chasers || []).map((t) => t.id)])],
        askedBy: target,
        reasons: [`chat request from ${target}: ${reply.do}`],
        shownActionIds: [],
        shownProposals: [],
        goalId: agenda.main && !agenda.main.paused ? (agenda.main.goalId || null) : null
      }
      try {
        await executeAction({ ...doIt, _via: 'chat' }, chatSnap)
      } catch (err) { logger.warn(TAG, `chat-started ${reply.do} failed: ${err?.message || err}`) }
    }
    if (reply.task) {
      // The chat lane decided the body should do this. It goes to the action
      // lane at once, ahead of whatever that lane was thinking about: it is
      // still Zinc's own decision (the action lane may weigh it against its
      // goals), but it must not sit behind a minute-long stale thought.
      const propId = `prop_${++proposalSeq}`
      note({ type: 'request', sender: target, text: `${target} proposed: ${reply.task}` })
      agenda.asked.push({ id: propId, from: target, text: reply.task, at: Date.now() })
      if (agenda.asked.length > 8) agenda.asked.shift()
      continuity.addPendingEvent({ kind: 'player_request', from: target, text: reply.task })
      brain.wake(`chat request from ${target}: ${reply.task}`, { external: true, fast: true, important: true, preempt: true })
    }
    logger.info(TAG, `chat ${sender}: "${lines.map((l) => l.text).join(' / ').slice(0, 80)}" -> ${reply.text ? `"${reply.text.slice(0, 80)}"` : silentWhy(reply)}${reply.do ? ` [do: ${reply.do} ${target}]` : ''}${reply.task ? ` [task: ${reply.task.slice(0, 60)}]` : ''}`)
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
  /**
   * Which chunks will this action touch? Returns a footprint the lane
   * scheduler can turn into per-region locks, or null when the action's reach
   * is unbounded (`gather`, `light_up` roam) and must keep the coarse key.
   *
   * Only shapes whose extent we can compute cheaply are narrowed; anything
   * uncertain stays coarse, which is always safe — just less parallel.
   */
  /**
   * The coordinate an action is aimed at, when it has one: a walk, a dig, a
   * build origin or a build_shape origin. Resolves a saved place name through
   * the place index so "go_to place: shed" is checked like "go_to 400,400".
   */
  function destinationOf (action) {
    const a = action?.a
    if (!['go_to', 'move', 'dig', 'build', 'build_shape', 'place', 'gather', 'light_up', 'corpse_run'].includes(a)) return null
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    if (a === 'build_shape' && Array.isArray(action.at) && action.at.length >= 3) return { x: num(action.at[0]), z: num(action.at[2]) }
    if (a === 'build' && Array.isArray(action.at) && action.at.length >= 3) return { x: num(action.at[0]), z: num(action.at[2]) }
    const x = num(action.x)
    const z = num(action.z)
    if (x !== null && z !== null) return { x, y: num(action.y), z }
    const placeName = action.place || (a === 'go_to' && action.where) || null
    if (placeName) {
      try {
        const entry = places.resolve(String(placeName), here(), { dim: dim() })
        if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.z)) return { x: entry.x, y: entry.y, z: entry.z }
      } catch { /* unknown place: the skill will report it */ }
    }
    return null
  }

  function footprintOf (action) {
    const a = action?.a
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    if (a === 'inspect_block') {
      const x = num(action.x ?? action.at?.[0])
      const z = num(action.z ?? action.at?.[2])
      if (x == null || z == null) return null
      return { x1: x, z1: z, x2: x, z2: z }
    }
    if (a === 'inspect_region') {
      const x = action.x; const z = action.z; const r = action.radius ?? 1
      if (![x, z, r].every(Number.isSafeInteger) || r < 0 || r > 2) return null
      return { x1: x - r, z1: z - r, x2: x + r, z2: z + r }
    }
    if (a === 'build_shape') {
      const at = action.at
      const shape = String(action.shape || '')
      const params = action.params
      if (!Array.isArray(at) || at.length < 3 || !at.slice(0, 3).every(v => Number.isFinite(Number(v))) || !params) return null
      try {
        const blocks = generateShape(shape, params, action.block || 'stone')
        if (!blocks.length || executor?.placedScaffolds?.length) return null
        const feetY = Math.floor(bot.entity.position.y)
        if (blocks.some(b => Math.trunc(Number(at[1])) + (b.dy || 0) - feetY > 4)) return null
        let x1 = Infinity; let z1 = Infinity; let x2 = -Infinity; let z2 = -Infinity
        for (const b of blocks) {
          const x = Math.trunc(Number(at[0])) + (b.dx || 0)
          const z = Math.trunc(Number(at[2])) + (b.dz || 0)
          if (x < x1) x1 = x
          if (x > x2) x2 = x
          if (z < z1) z1 = z
          if (z > z2) z2 = z
        }
        return { x1, z1, x2, z2 }
      } catch { return null }
    }
    return null
  }

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
    // A resumed build needs only materials missing from the observed world.
    // Unknown/unloaded cells count as missing rather than assuming success.
    const phaseSteps = stage ? plan.steps.filter((s) => (s.phase || 'walls') === stage) : plan.steps
    const remaining = phaseSteps.filter((step) => {
      try { return bot.blockAt(new Vec3(step.x, step.y, step.z))?.name !== step.name } catch { return true }
    })
    const preflight = parser.checkInventory(remaining, bot.inventory.items())
    if (!preflight.ok) {
      const missing = preflight.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')
      return { ok: false, msg: `cannot build ${label}${stage ? ' (' + stage + ')' : ''}: missing ${missing}. Gather them (gather) or ask a player, then call the same stage again — phases already placed do not redo.` }
    }
    logger.info(TAG, `${label} — ${plan.steps.length} blocks${stage ? ` (stage ${stage})` : ''}${plan.towerNeeded ? `, tower ${plan.towerHeight} high` : ''}`)
    const runningGoalId = agenda.main?.goalId || null
    const runningJob = agenda.main?.jobId ? jobs.jobs.get(agenda.main.jobId) : null
    const lease = leaseContext.getStore()?.lease
    const regional = lease?.lane === LANES.BODY && lease.resources.some(r => r.startsWith('world:'))
    const result = await executor.build(plan, {
      stage,
      allowScaffold: !regional,
      onProgress: ({ placed, total }) => {
        if (runningJob) runningJob.progress = { done: placed, total }
        if (runningGoalId && (placed === 1 || placed % 4 === 0 || placed === total)) {
          goalReg.progress(runningGoalId, { done: placed, total, note: `${placed}/${total} blocks` })
        }
      }
    })
    let scaffoldNote = ''
    if (!regional && cfg.build.autoRemoveScaffold !== false) {
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

  /**
   * Is `action` the task the body is running right now? Returns its label
   * ("following Steve (41s)") when it is, else null. Only for the two tools
   * that mean "keep doing this": follow, and go_to a player.
   */
  function sameAsRunning (action) {
    const main = agenda.main
    const cur = skills?.current()
    if (!main || main.paused || !cur || main.tool !== action?.a) return null
    const norm = (v) => String(v || '').trim().toLowerCase()
    if (action.a === 'follow' && action.player) {
      if (norm(main.label) !== norm(`follow ${action.player}`)) return null
    } else if (action.a === 'go_to' && action.player && !action.place && action.x === undefined) {
      if (norm(main.label) !== norm(`go to ${action.player}`)) return null
    } else return null
    return `${cur.label} (${cur.seconds}s)`
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
    // THE SHARED BOUNDARY, first refusal of the tool path. Read-only and
    // reasoning tools are never gated here (the boundary returns ok for them);
    // anything physical is checked against the pause flag, the permissions, the
    // permitted area and the action rate before a lease is even requested.
    const physical = boundary.check(a, { action })
    if (!physical.ok) {
      return report(a, { ok: false, msg: `refused: ${physical.why}` }, { wake: false })
    }
    // Where the action is AIMED matters as much as where the body stands: a walk
    // or a build outside the permitted area must not start just because the
    // body is still inside it.
    const destination = destinationOf(action)
    const awayTarget = destination ? boundary.destinationRefusal(destination) : null
    if (awayTarget) return report(a, { ok: false, msg: `refused: ${awayTarget}` }, { wake: false })
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
    // Asking for what the body is ALREADY doing must not restart it: the loop
    // looks in on a long follow every half minute, and a model that answers
    // "follow Steve" again used to cancel the walk and start it over.
    const running = sameAsRunning(action)
    if (running) return report(a, { ok: true, msg: `already ${running} — still going, not restarted. Call stop to end it, or idle to let it continue.` }, { wake: false })
    // Logged as the model made the call: the internal short aliases of an
    // argument (craft's `i`, say's `t`) are not a second argument.
    if (a !== 'idle') logger.info(TAG, `action: ${a} ${JSON.stringify(publicArgs(action))}`)
    // Take the lane this tool belongs to. BODY is exclusive, so a second
    // physical action cannot start while one is in flight; COMPUTATION,
    // INTERACTION and WORLD_INFO run alongside it. `tryAcquire` is used for
    // read-only tools (they must not queue behind a long walk) and `acquire`
    // for everything that has to be serialised. The lease is released in the
    // finally block of the executor wrapper below.
    let laneLease = null
    try {
      const lane = laneOf(a)
      // A newer physical decision interrupts the current task before waiting
      // for its lease; the old task retains its lock until it really exits.
      if (lane === LANES.BODY && agenda.main && lanes.bodyHolder()) {
        agenda.main.pendingInterrupt = true
        replaceTask()
      }
      const footprint = footprintOf(action)
      const meta = { goalId: agenda.main?.goalId || null, footprint }
      if (lane === LANES.WORLD_INFO || lane === LANES.COMPUTATION) {
        laneLease = lanes.tryAcquire(a, meta)
      } else {
        laneLease = await lanes.acquire(a, meta)
      }
    } catch { laneLease = null }
    if (!laneLease) {
      if (agenda.main?.pendingInterrupt) { shelfMain(agenda.main, 'interrupted while another action waited'); agenda.main = null }
      // A refusal at the lease (paused, disconnected, out of quota) says so in
      // the model's own terms; a genuine resource conflict keeps its old text.
      const again = boundary.check(a, { action })
      const why = again.ok ? 'resource busy' : again.why
      return report(a, { ok: false, msg: `${why} — nothing was started; retry when the body is free` }, { wake: false })
    }
    return leaseContext.run({ lease: laneLease, claimed: false }, async () => {
    gateCtx = action
    const IMMEDIATE_TRACKED = new Set(['say', 'stop', 'hold', 'equip', 'dig_policy', 'redstone_scan', 'redstone_component', 'redstone_engineer', 'recall', 'circuit_project', 'logic_test', 'inspect_region', 'inspect_block', 'find', 'remember_here', 'note', 'social', 'goal'])
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
        else if (action._fallback) report('reply', { ok: false, msg: 'you returned no tool call, so nothing happened — call a listed tool (say to talk, idle to wait)' })
        return
      case 'say': {
        const text = String(action.t ?? action.text ?? '')
        // No language check: what the model chose to say goes out as said.
        // speak() reports its own reason (a permission that is off, a recipient
        // that is not online); only genuinely empty text is reported here.
        if (!text.trim()) { report('say', { ok: false, msg: 'empty text' }); return }
        speak(text, { to: action.to ? String(action.to) : null })
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
      case 'dig_policy': {
        // The model's own standing rule for what a walk may break. Read it,
        // switch it, edit the list — and the route in progress re-plans with it.
        const change = { can_dig: action.can_dig, mode: action.mode, add: action.add, remove: action.remove, reset: action.reset }
        const r = digPolicy.apply(change, { registry: bot.registry })
        if (r.changed) {
          try { wrapper.refreshDigPolicy() } catch { /* next plan picks it up */ }
          note({ type: 'dig_policy', msg: r.msg.slice(0, 160) })
        }
        const gated = config.get('actions.allowDig') === false ? ' (NOTE: the operator has digging switched off — actions.allowDig — so nothing is broken until that changes)' : ''
        return report('dig_policy', { ok: r.ok, msg: `${r.msg}${gated}` }, { wake: false })
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
        return background('eat', adoptLease(skills.eat({ item: action.item }), 'eat finished'))
      case 'equip': {
        // `auto` is the model's switch for the armor keeper; it may come alone
        // or with an item.
        let autoNote = ''
        if (typeof action.auto === 'boolean') {
          autoNote = `armor is now ${armor.setAuto(action.auto)}`
          if (!String(action.item || '').trim()) return report('equip', { ok: true, msg: autoNote }, { wake: null })
        }
        const res = await skills.equip({ item: action.item, where: action.where })
        // What the model put on or took off by hand stays as it left it —
        // which only needs saying (and holding) when the autopilot would have
        // chosen differently: wearing the best piece anyway changes nothing.
        if (res.ok && res.slot && res.slot !== 'hand' && armorPrefs.auto && armor.plan().some((step) => step.slot === res.slot)) {
          armor.hold(res.slot)
          res.msg += ` — ${res.slot} stays as you set it (equip {auto:true} lets the best armor be put on by itself again)`
        }
        if (autoNote) res.msg += `; ${autoNote}`
        return report('equip', res, { wake: null })
      }
      case 'redstone_engineer': {
        const started = performance.now()
        // Its placements and lever flips are checked against the same
        // permissions as everything else, on every primitive it issues.
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
          // A script talks to the same guarded bot as everything else: there is
          // no unguarded handle to hand it.
          boundary, check: (tool) => boundary.check(tool),
          escalate: (event) => brain.wake(`${event.type} ${event.item || event.text || ''}`.trim())
        }
        // A script is not safe to run twice, so a side job ends it instead of pausing it.
        return startMain({ tool: `run_script ${name}`, label: `script ${name}`, askedBy: snap.askedBy, showAs: `running script ${name}`, resumable: false, run: () => runScript(name, {}, ctx).then((out) => ({ ok: true, msg: typeof out === 'string' ? out : 'done' })) })
      }
      case 'goal': {
        return report('goal', await runGoalOp(action, snap))
      }
      default:
        return report(String(a), { ok: false, msg: `unknown action "${a}"` })
    }
    } finally {
      gateCtx = null
      currentActId = null
      // The lease is released here unless a background task adopted it: that
      // task owns the lane until its work is genuinely over. A leaked BODY
      // lock would freeze the avatar, so every path must release exactly once.
      if (!leaseContext.getStore().claimed) { try { laneLease.release('action finished') } catch { /* noop */ } }
      if (agenda.main?.pendingInterrupt) { shelfMain(agenda.main, `interrupted by ${a}`); agenda.main = null }
    }
    })
  }

  // -------------------------------------------------- operator commands -----
  // There is no chat command surface any more.
  //
  // It used to live here: a `!zinc`-prefixed line in public chat was parsed,
  // matched against a UUID allow-list, and dispatched to the process host, with
  // the answer whispered back. That meant a command channel existed wherever a
  // player could type — the game server's own chat — authorised by a list the
  // panel maintained, and every refusal was a probe.
  //
  // Control is the console only: the process's stdin, or the `pause` / `stop` /
  // `shutdown` functions the supervisor already calls. Bare words, no prefix —
  // see control_commands.js and host.attachStdin().

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

  /**
   * The route check the death recovery uses: a real A* probe from where the
   * body stands to the designated room, so a blocked route is reported once
   * instead of being walked into repeatedly.
   * @returns {Promise<{ok:boolean, why?:string}>}
   */
  async function checkRouteHome (from, to) {
    try {
      const { GoalNear } = require('mineflayer-pathfinder').goals
      const goal = new GoalNear(Math.trunc(to.x), Math.trunc(to.y), Math.trunc(to.z), 2)
      const paths = bot.pathfinder?.getPathFromTo
      if (typeof paths !== 'function') return { ok: true, why: 'route not checkable here' }
      const movements = bot.pathfinder.movements
      if (!movements) return { ok: true, why: 'route not checkable here' }
      const it = paths.call(bot.pathfinder, movements, new Vec3(from.x, from.y, from.z), goal, { timeout: 4000, tickTimeout: 40 })
      const step = it.next()
      const status = step?.value?.result?.status
      if (status === 'noPath') return { ok: false, why: 'no way through' }
      if (status === 'timeout') return { ok: false, why: 'the route took too long to find' }
      return { ok: true, why: status || 'unknown' }
    } catch (err) {
      return { ok: false, why: String(err?.message || err).slice(0, 100) }
    }
  }

  /**
   * After a respawn: inspect the real body, re-check the objectives, decide
   * about the designated room, and tell the model ONE honest sentence.
   */
  async function reconcileAfterRespawn () {
    const p = here()
    const observation = {
      position: p,
      dimension: dim(),
      health: bot.health,
      inventory: bot.inventory?.items?.() || []
    }
    // 1. Objectives: a death never erases the plan, but the world may have
    //    moved on. Everything still open is re-verified where it can be.
    let rechecked = 0
    try { rechecked = reconcileRestored() } catch (err) { logger.debug(TAG, `goal reconcile: ${err.message || err}`) }
    // 2. The designated room: one decision, reported once, never a loop.
    const recovery = await deathRecovery.onRespawn(observation)
    // 3. Resume only what remains valid: goals that could be verified are put
    //    back on the agenda as resumable+needsVerify; a goal already done in
    //    the world was completed by reconcileRestored/reconcileGoal.
    const open = goalReg.openGoals()
    const pending = open.length ? `; unfinished: ${open.slice(0, 4).map((g) => goalReg.describe(g)).join(' | ')}` : ''
    const summary = require('./death_recovery').respawnSummary(deathRecovery.lastDeath, observation)
    const tail = recovery.verdict === 'go_home'
      ? `; ${recovery.why}`
      : recovery.verdict === 'report'
        ? `; cannot return to the designated room: ${recovery.why}`
        : ''
    brain?.wake(`respawned — ${summary}${pending}${rechecked ? ` (re-checked ${rechecked} goal(s) against the world)` : ''}${tail}`, { external: true, important: true })
    if (recovery.verdict === 'go_home' && recovery.target) {
      // A single ordinary task, so it is cancellable and visible like any other.
      try {
        startMain({
          tool: 'go_to',
          label: `return to the designated room (${recovery.target.x},${recovery.target.y},${recovery.target.z})`,
          askedBy: null,
          detail: { args: { x: recovery.target.x, y: recovery.target.y, z: recovery.target.z }, cause: 'respawn' },
          run: () => skills.goTo({ x: recovery.target.x, y: recovery.target.y, z: recovery.target.z })
        })
      } catch (err) { logger.warn(TAG, `return-home task could not start: ${err?.message || err}`) }
    }
    return { observation, recovery, rechecked }
  }

  // ------------------------------------------------------ event wiring ---
  onBot('login', () => logger.info(TAG, `logged in as ${bot.username}`))

  onBot('spawn', () => {
    alive = true
    owner?.markDead?.(false)
    const first = !spawned
    spawned = true
    shared.everSpawned = true
    shared.attempts = 0
    // Tell the link manager (and the process-level host) that this session is
    // really in the world. Until it hears this, the boundary refuses every
    // physical action — which is exactly why a stale connection cannot act.
    try { hooks?.onSpawn?.() } catch (err) { logger.debug(TAG, `spawn hook: ${err?.message || err}`) }
    try { owner?.noteSpawn?.({ first }) } catch { /* noop */ }

    // A fresh Movements every spawn; the wrapper re-applies EVERYTHING to it
    // (doors, mode, digging guard, scaffolding policy, threat costs).
    const movements = new Movements(bot)
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)
    wrapper.apply()

    if (systemsReady) {
      // Respawn: same bot object, same stack, NEW life. Reconcile against what
      // the body actually is now — never against the life that ended.
      const p = here()
      logger.info(TAG, 'respawned')
      owner?.markDead?.(false)
      reconcileAfterRespawn().catch((err) => logger.warn(TAG, `respawn reconcile failed: ${err?.message || err}`))
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
      // The model's armor choices cover the fight's shield too.
      mayTakeShield: () => armorPrefs.auto && !armorPrefs.held.has('off-hand'),
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
    executor = new BuilderExecutor(bot, { scaffoldBlocks: cfg.build.scaffoldBlocks, logger: wrapperLog, hands: taskLane, boundary })
    skills = new Skills(bot, { arbiter, places, logger: wrapperLog, whisper: guard.whisper, executor: () => executor, pathfinder: () => wrapper, boundary })

    brain = new Brain({
      act,
      talk,
      isBodyBusy: () => Boolean(skills?.current() || task || combat?.isEngaged || system1?.fleeing),
      logger: (level, msg) => logger[level]?.(TAG, msg),
      minIntervalMs: cfg.inference.minIntervalMs ?? 3000,
      chatMinIntervalMs: cfg.inference.chatMinIntervalMs ?? 1200,
      // The IRC window: chat is handed over in chunks this long, not one wake
      // per line. 0 disables batching (each line is its own chunk).
      chatBatchMs: cfg.inference.chatBatchMs ?? 6000,
      rpm: cfg.inference.rpm ?? 18,
      chatReserve: cfg.inference.chatReserve ?? 4,
      urgentMinIntervalMs: cfg.inference.urgentMinIntervalMs ?? 1000,
      // THE AGENT LOOP: the next turn starts `loopMs` after the last one ended,
      // backing off to `heartbeatMs` while the model keeps answering idle, and
      // looking in on a busy body every `loopBusyMs`. heartbeatMs 0 = off.
      heartbeatMs: cfg.inference.heartbeatMs ?? 90_000,
      loopMs: cfg.inference.loopMs ?? 8000,
      loopBusyMs: cfg.inference.loopBusyMs ?? 30_000,
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
      // With a walk under way (follow, go_to, any errand) an escape is a short
      // dodge that comes back, not a retreat that abandons it.
      tether: () => (cfg.system1.tether === false ? null : (skills?.tether?.() || null)),
      tetherTriggerRadius: cfg.system1.tetherTriggerRadius ?? 6,
      tetherReleaseRadius: cfg.system1.tetherReleaseRadius ?? 9,
      tetherCalmMs: cfg.system1.tetherCalmMs ?? 1200,
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

    // The inventory window exists from here on (mineflayer adds it when its
    // plugins are injected, after createBot returned): listen, and look once.
    try { armor.attach(); armor.poke() } catch (err) { logger.debug(TAG, `armor keeper: ${err.message || err}`) }
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
  onBot('entityHurt', (entity) => { if (entity !== bot.entity) system1?.onEntityHurt(entity) })

  // ------------------------------------------------- entity perception ---
  // Spawn/despawn/damage of everything else used to be invisible to the model:
  // only the reflex layer subscribed to entityHurt. Every branch below is cheap
  // and coalesces, so a horde does not become 200 prompt lines.
  const ENTITY_INTEREST_RE = /^(player|zombie|skeleton|spider|creeper|enderman|witch|slime|magma_cube|blaze|ghast|phantom|drowned|husk|stray|pillager|vindicator|ravager|piglin|hoglin|zombified_piglin|wither_skeleton|warden|elder_guardian|guardian|iron_golem|wolf|cat|fox|horse|villager|wandering_trader|allay|bee|axolotl|goat|cow|pig|sheep|chicken|rabbit|turtle|panda|strider|boat|minecart|item|arrow|trident|fireball|small_fireball|wind_charge|tnt|primed_tnt)$/
  onBot('entitySpawn', (entity) => {
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
  onBot('entityGone', (entity) => {
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
  onBot('entityHurt', (entity) => {
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
  onBot('entityDead', (entity) => {
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
  onBot('entityMoved', (entity) => {
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
  onBot('blockUpdate', (oldBlock, newBlock) => {
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
  onBot('health', () => { try { combat?.noteHealth?.(bot.health) } catch { /* cosmetic */ } })

  onBot('playerCollect', (collector, item) => {
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

  onBot('death', () => {
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
    // Every job that cannot survive a new life is cancelled here; the goal
    // RECORDS above survive, which is the difference between losing work and
    // losing the plan.
    try { for (const job of jobs.active()) jobs.cancel(job.id, 'died') } catch { /* best effort */ }
    // Death is an event, not a process failure: the recovery subsystem records
    // the loss and inspects the respawn when it really happens.
    try {
      deathRecovery.onDeath({ position: p, dimension: dim(), inventory: bot.inventory?.items?.() || [] })
      owner?.markDead?.(true)
    } catch (err) { logger.debug(TAG, `death record: ${err.message || err}`) }
    if (config.get('death.autoRespawn') === false) {
      logger.warn(TAG, 'death.autoRespawn is off — the body stays on the death screen until "join" or a config change')
    } else {
      const delay = deathRecovery.respawnDelayMs()
      const t = setTimeout(() => { timers.delete(t); try { bot.respawn() } catch { /* not on death screen */ } }, delay)
      timers.add(t)
    }
  })

  onBot('wake', () => {
    if (!systemsReady) return
    note({ type: 'woke', msg: 'woke up' })
    // A task that waited for the night carries on; only an idle bot needs a thought.
    if (!resumeMain('sleeping')) brain.wake('woke up (morning)')
  })

  onBot('vanilla_command_blocked', (line) => {
    logger.warn(TAG, `vanilla guard blocked: ${String(line).slice(0, 80)}`)
    report('say', { ok: false, msg: 'blocked: chat that starts with "/" is a command and you cannot run commands' })
  })

  /**
   * Every attributable chat line goes into the IRC stream.
   *
   * What used to happen here, in order: a control-prefix check intercepted
   * operator commands out of public chat; `chatAddressesBot` scored the line for
   * relevance (its name? a question with one person online? already in
   * conversation?) and RETURNED on anything it judged "not for me", so the model
   * never saw it; and `chatRate` silently dropped a player's excess lines before
   * the brain got them. Three separate human-authored policies deciding what the
   * model was allowed to notice, on top of the model's own judgement.
   *
   * None of that is here. A line is logged, perceived, remembered, and handed to
   * `brain.hear`, which batches the last few seconds into one chunk. The model
   * reads the window and decides who (if anyone) it is answering — that
   * judgement is the model's job, and it is better at it than a name regex,
   * because it can see the surrounding conversation.
   *
   * Operator control is console-only now; nothing in chat is a command.
   */
  onBot('messagestr', (raw) => {
    const players = Object.keys(bot.players || {})
    const parsed = filter.parseChatLine(raw, { players })
    if (!parsed) return // server line, not attributed chat
    if (parsed.sender === bot.username) return // never react to ourselves
    const { sender, text, whisper } = parsed
    if (!systemsReady) return
    const pref = memory.observeChat(sender, text)
    if (pref) logger.debug(TAG, `preference learned from ${sender} (${pref.polarity}): ${pref.text}`)
    system1?.onChatLine(sender, text)
    logChat(sender, whisper ? `(whisper) ${text}` : text)
    timeline.chat(sender, text, { whisper })
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
    memory.rememberChat(sender, text, { addressed: null })
    logger.debug(TAG, `chat from ${sender}: ${text}`)
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
    // A reset drops stale queued decisions, but running work keeps its lease.
    try { lanes.dropWaiters('context reset') } catch { /* noop */ }
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
    try { timeline.clear(); chatSeenSeq = timeline.seq } catch { /* noop */ }
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
    try { armor?.detach() } catch { /* noop */ }
    try { executor?.cancel() } catch { /* noop */ }
    try { system1?.stop() } catch { /* noop */ }
    try { combat?.stop() } catch { /* noop */ }
    try { wrapper.stop() } catch { /* noop */ }
    try { arbiter.stop() } catch { /* noop */ }
    try { hurts.stop() } catch { /* noop */ }
    // Every scoped permission dies with the session, so a reconnect can never
    // inherit a grant that belonged to a body that no longer exists.
    try { for (const job of jobs.active()) jobs.cancel(job.id, 'session ended') } catch { /* best effort */ }
    // Uninstall the network guard so a stale wrapper can never answer for a
    // bot that is gone.
    try { physicalGuard?.uninstall?.() } catch { /* noop */ }
    try { boundary.removeListener('refused', onRefused) } catch { /* noop */ }
    // The listeners go with the session: nothing of this body may still be
    // wired to an event after its link is gone.
    for (const [event, fn] of botListeners) {
      try { bot.removeListener(event, fn) } catch { /* noop */ }
    }
    botListeners.length = 0
    if (quit) { try { bot.quit() } catch { /* already gone */ } }
    if (owner) { try { owner.detachSession?.(session) } catch { /* noop */ } }
  }

  function over (kind, detail) {
    if (ended) return
    let text = ''
    try { text = detail && detail.message ? detail.message : reasonToText(detail) } catch { text = String(detail ?? '') }
    dispose(false)
    try { bot.removeAllListeners('end'); bot.end?.() } catch { /* already gone */ }
    onEnded?.({ kind, text: String(text || '').slice(0, 200), spawned })
  }

  onBot('kicked', (reason) => over('kicked', reason))
  onBot('end', (reason) => over('end', reason))
  onBot('error', (err) => {
    // Before spawn a socket error IS the end of this attempt; afterwards the
    // 'end' event follows and carries the session down.
    if (!spawned) over('error', err)
    else logger.error(TAG, `socket error: ${err.message || err}`)
  })

  /**
   * What the Host and the control interface need from a live session.
   *
   * `stopPhysical` is the pause: it releases every key and pathfinder goal,
   * cancels the cancellable work and leaves the goals, memory and listeners
   * exactly where they are. `onResumed` is the other half: it lets the world
   * reconciliation that `resume` performed wake the model with the result.
   */
  const subsystems = {
    cfg,
    goals: goalReg,
    jobs,
    lanes,
    places,
    continuity,
    memory,
    parser,
    checkRoute: (from, to) => checkRouteHome(from, to),
    reconcileEngine: async () => ({ deaths: deathRecovery.deaths, lastRecovery: deathRecovery.lastRecovery }),
    onConfigChange: (name, oldValue, value) => {
      // A parameter that changes how the body behaves takes effect here, with no
      // restart and no behavioural "mode" change.
      if (name === 'boundary.enabled' && value === true) {
        logger.info(TAG, `boundary on: ${config.get('boundary.dimension')} radius ${config.get('boundary.radius')} around ${config.get('boundary.centerX')},${config.get('boundary.centerZ')}`)
      }
      if (name === 'connection.autoReconnect') logger.info(TAG, `auto reconnect is now ${value ? 'on' : 'off'}`)
    },
    activity: () => activityText(),
    stopGoal: (goalId) => stopGoalIfRunning(goalId),
    verifyGoal: async (goalId) => {
      const goal = goalReg.get(goalId)
      if (!goal) return { state: 'invalid', note: `no goal ${goalId}` }
      return reconcileGoal(goalReg.get(goalId))
    },
    onResumed: (info) => {
      if (!systemsReady || ended) return
      const detail = info?.reconciled
      brain?.wake(`resumed by the operator${detail?.position ? ` at ${detail.position.x},${detail.position.y},${detail.position.z}` : ''}; the world was reconciled — check what is still valid before acting`, { external: true, important: true })
    },
    busy: () => Boolean(skills?.current() || task || combat?.isEngaged),
    emergency: () => Boolean(system1?.fleeing)
  }
  const session = {
    dispose,
    resetContext,
    bot,
    subsystems,
    isSpawned: () => spawned,
    /**
     * The operator's `shutdown`: the irreversible half of the emergency stop.
     * `dispose()` only tears down this session's body and model stack; the
     * process-level shutdown saves memory, places and conversation, prints the
     * summary and exits. Exposed here so the host's console command can reach
     * it without the host knowing about this module's internals.
     */
    shutdown: (code = 0, reason = 'shutdown') => {
      if (typeof shared.shutdown === 'function') return shared.shutdown(code, reason)
      try { dispose() } catch { /* already gone */ }
      setTimeout(() => process.exit(code), 250)
      return false
    },
    /**
     * The operator's pause. Cancellable work is interrupted, keys are released,
     * nothing is deleted.
     * @returns {string[]} what was interrupted
     */
    stopPhysical: () => {
      const interrupted = []
      if (combat?.isEngaged) { leaveFight('operator stop'); interrupted.push('fight') }
      if (skills?.current()) { skills.cancel('paused by operator'); interrupted.push(`skill ${skills.current()?.label || ''}`.trim()) }
      if (task) interrupted.push(`task ${task.label}`)
      try { executor?.cancel() } catch { /* noop */ }
      try { for (const job of jobs.active()) { jobs.cancel(job.id, 'paused by operator'); interrupted.push(`job ${job.id}`) } } catch { /* best effort */ }
      try { arbiter.halt('paused by operator') } catch { /* noop */ }
      try { lanes.dropWaiters('paused by operator') } catch { /* noop */ }
      try { system1?.reset() } catch { /* noop */ }
      try { brain?.clearContext({ preserveImportant: true }) } catch { /* noop */ }
      // Goals stay on disk, suspended, with their checkpoints.
      try { goalReg.suspendAll({ reason: 'paused by operator' }); goalReg.save({ force: true }) } catch { /* best effort */ }
      agenda.main = null
      return interrupted
    },
    /**
     * Check a goal against the ACTUAL world/inventory. Used by the operator's
     * `resume` and by death recovery: a goal whose work already happened is
     * completed, never repeated.
     */
    verifyGoal: async (goalId) => {
      const goal = goalReg.get(goalId)
      if (!goal) return { state: 'invalid', note: `no goal ${goalId}` }
      return reconcileGoal(goal)
    },
    internals: () => ({
      arbiter, sense, wrapper, combat, system1, skills, brain, results, agenda,
      events: pipeline, latency, redstoneEngineer, redstoneLibrary: shared.redstoneLibrary,
      goals: goalReg, continuity, resetContext, executeAction, buildActionPrompt, buildChatPrompt,
      lanes, jobs, laneOf: (tool) => laneOf(tool), LANES, footprintOf,
      // Goal orchestration surface (tests and the session's own monitor):
      startMain, resumeMain, finishGoal, runGoalOp, goalLines, goalTick,
      reconcileRestored, reconcileGoal, verifyGoalAgainstWorld, staleActionReason,
      // Control surface (tests and the operator interface):
      host: owner, config, boundary, physicalGuard, deathRecovery, subsystems,
      stopPhysical: session.stopPhysical,
      reconcileAfterRespawn, respawn: () => bot.emit('spawn'), kill: () => bot.emit('death')
    })
  }
  // Register with the process-level host so `status`, `stop`, `config` and the
  // chat command interface work against THIS session.
  if (owner && typeof owner.attachSession === 'function') {
    try { owner.attachSession(session) } catch (err) { logger.debug(TAG, `host attach: ${err?.message || err}`) }
  }
  return session
}

if (require.main === module) main()

module.exports = {
  loadConfig,
  validateConfig,
  makeShared,
  startSession,
  createHost,
  fatalLines,
  decideReconnect,
  FATAL_KICK_RE,
  ATTACK_WHY,
  SYSTEM_PROMPT,
  CHAT_PROMPT
}
