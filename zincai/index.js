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

// Load .env if present (local dev convenience). Real deployments (Pufferpanel)
// inject AMD_API_KEY/API_KEY as secret environment variables — those win,
// because dotenv never overrides variables that are already set.
require('dotenv').config()

const ROOT = path.join(__dirname, '..')
const ZINC_DIR = __dirname
const DATA_DIR = process.env.ZINC_DATA_DIR || path.join(ROOT, 'zincai-data')
const SYSTEM_PROMPT = fs.readFileSync(path.join(ZINC_DIR, 'system_prompt.txt'), 'utf8').trim()
const CHAT_PROMPT = fs.readFileSync(path.join(ZINC_DIR, 'chat_prompt.txt'), 'utf8').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { AmdToolsClient, createZincTools } = require('./api_wrapper')
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
function loadConfig () {
  const file = path.join(ZINC_DIR, 'config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const str = (envName, fallback) => (process.env[envName] !== undefined && process.env[envName] !== '' ? process.env[envName] : fallback)
  const int = (envName, fallback) => {
    const v = Number(process.env[envName])
    return Number.isFinite(v) && process.env[envName] !== '' ? Math.trunc(v) : fallback
  }
  return {
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
      maxTokens: raw.amd.maxTokens ?? 256,
      temperature: raw.amd.temperature ?? 0.25,
      timeoutMs: raw.amd.timeoutMs ?? 20_000,
      maxRetries: raw.amd.maxRetries ?? 2
    },
    inference: raw.inference || {},
    memory: raw.memory || {},
    behavior: raw.behavior || {},
    build: raw.build || {},
    system1: raw.system1 || {},
    combat: raw.combat || {},
    threat: raw.threat || {},
    traversal: raw.traversal || {},
    scout: raw.scout || {},
    reconnect: raw.reconnect || {},
    places: raw.places || {}
  }
}

function validateConfig (cfg) {
  const errors = []
  if (!cfg.amd.apiKey) errors.push('AMD API key missing — set AMD_API_KEY (or API_KEY) in the environment or a local .env, or amd.apiKey in zincai/config.json')
  if (!['offline', 'microsoft'].includes(cfg.server.auth)) errors.push('server.auth must be "offline" or "microsoft"')
  if (!Number.isFinite(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) errors.push('server.port out of range')
  try { new URL(cfg.amd.baseUrl) } catch { errors.push('amd.baseUrl is not a valid URL') }
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
  const at = (configured, fallback) => path.join(dataDir, String(configured || fallback).replace(/^zincai-data[/\\]/, ''))
  const memoryFile = at(cfg.memory.file, 'memories.json')
  const shared = {
    cfg,
    memoryFile,
    memory: new MemorySystem({
      file: memoryFile,
      preferencesFile: at(cfg.memory.preferencesFile, 'preferences.json'),
      workingMax: cfg.memory.workingMax,
      shortTermMinutes: cfg.memory.shortTermMinutes,
      ephemeralMs: cfg.memory.ephemeralMs ?? 30_000
    }),
    places: new PlaceIndex({ file: at(cfg.places.file, 'places.json'), logger: (level, msg) => logger[level]?.(TAG, msg) }),
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
  const { reasonToText } = require('../src/agent')

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
    allowDigging: Boolean(cfg.behavior.allowDigging),
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
      if (!whispered) bot.chat(text)
      logChat('me', whispered ? `(to ${to}) ${text}` : text)
      if (to || about) pushConvo(to || about, 'me', text)
      note({ type: 'said', msg: `I said${whispered ? ` to ${to}` : ''}: ${text}` })
    } catch (err) { logger.debug(TAG, `chat failed: ${err.message || err}`) }
    if (sayQueue.length) flushSay()
  }

  // ------------------------------------------------------ action results --
  const INFORMATIONAL = new Set(['find', 'look_in'])
  /**
   * Record what an action did and, when the model needs to know right away
   * (a failure, a finished task, information it asked for), wake it.
   */
  function report (label, result, { wake = null } = {}) {
    const r = result && typeof result === 'object' ? result : { ok: true, msg: String(result ?? 'done') }
    // What the model asked to be told (a chest's contents, a storage list) is
    // not cut to a headline: at 220 characters a full chest lost its second half.
    const msg = String(r.msg || (r.ok ? 'done' : 'failed')).slice(0, INFORMATIONAL.has(label) ? 900 : 260)
    results.push({ label, ok: Boolean(r.ok), msg, ts: Date.now() })
    if (results.length > 5) results.splice(0, results.length - 5)
    logger.info(TAG, `${label}: ${r.ok ? 'ok' : 'FAILED'} — ${msg}`)
    note({ type: 'result', msg: `${label}: ${msg}` })
    const shouldWake = wake === null ? (!r.ok || INFORMATIONAL.has(label)) : wake
    if (shouldWake) brain?.wake(`${label} ${r.ok ? 'done' : 'failed'}: ${msg}`, { external: false })
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

  function pruneAgenda () {
    const now = Date.now()
    agenda.shelved = agenda.shelved.filter((x) => now - x.at < MAIN_MAX_AGE_MS)
    agenda.asked = agenda.asked.filter((x) => now - x.at < 5 * 60_000)
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

  /**
   * A long task begins. Whatever ran before ends (the newest decision wins);
   * a build that was in progress is set aside, not forgotten.
   * @param {{ tool:string, label:string, run:() => Promise<object>, askedBy?:string|null, showAs?:string, resumable?:boolean }} spec
   */
  function startMain (spec) {
    const prev = agenda.main
    if (prev && /^build/.test(prev.tool) && !/^build/.test(spec.tool)) {
      agenda.shelved.push({ label: prev.label, askedBy: prev.askedBy || null, at: Date.now() })
      if (agenda.shelved.length > 3) agenda.shelved.shift()
    }
    agenda.shelved = agenda.shelved.filter((x) => x.label !== spec.label)
    replaceTask()
    const main = { ...spec, startedAt: Date.now(), paused: null, resumes: 0, seq: 0 }
    agenda.main = main
    launch(main)
  }

  /** Make room for something short without losing the main task. @returns true when a main task was paused */
  function pauseMain (by, { until = null } = {}) {
    const main = agenda.main
    if (!main) return false
    if (main.resumable === false) { agenda.main = null; return false }
    main.paused = { by, at: Date.now(), until }
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
    return background(label, run(), { side: true })
  }

  /** The side job is over: back to the main task, if one is waiting and nothing else runs. */
  function resumeMain (after) {
    const main = agenda.main
    if (!main || !main.paused || ended) return false
    if (main.paused.until === 'wake' && bot.isSleeping) return false // the wake event resumes it
    if (skills?.current() || combat?.isEngaged) return false // whatever is running calls this again when it ends
    if (Date.now() - main.startedAt > MAIN_MAX_AGE_MS || main.resumes >= 8) {
      agenda.main = null
      note({ type: 'dropped', msg: `gave up on ${main.label} (interrupted too often or too old)` })
      return false
    }
    main.paused = null
    main.resumes++
    // The decision that came with the task comes back with it (the side job
    // replaced it) — except about anything that hit the bot in the meantime.
    const d = main.decision
    if (d?.ids?.length) {
      const still = d.ids.filter((id) => { const e = bot.entities?.[id]; return e && !sense.isRecentAttacker(e) })
      if (still.length) system1?.acknowledge(still, d.opts)
    }
    note({ type: 'resumed', msg: `back to ${main.label} after ${after}` })
    logger.info(TAG, `resuming ${main.label} after ${after}`)
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

  /**
   * Run long work in the background; the model is told how it ended.
   * `showAs` labels work that is not a Skill (builds, scripts) in "doing:".
   * `main` / `seq` mark the agenda's main task; `side` a job it is paused for.
   */
  function background (label, promise, { showAs = null, main = null, seq = 0, side = false } = {}) {
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
    const request = [...reasons].reverse().find((r) => /^chat request/.test(r)) || shared.chatLog.filter((l) => l.who !== 'me').slice(-1)[0]?.text || ''
    const recalled = memory.recallBlock(request, cfg.memory.topK ?? 3)
    const prefs = memory.preferencesLine()
    const chat = chatLines()
    const res = results.slice(-4).map((r) => `  - ${r.label}: ${r.ok ? '' : 'FAILED — '}${r.msg}`).join('\n')
    const events = memory.working.last(6)
      .filter((e) => !OWN_SECTION.has(e.type))
      .map((e) => `  - ${e.type}: ${e.text || e.msg || ''}${e.count > 1 ? ` (x${e.count})` : ''}`).join('\n')
    const lines = [
      observe.selfLine(bot, { mode }),
      observe.inventoryLine(bot),
      doingLine(),
      agendaLine(),
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
      `why now: ${reasons.join('; ')}`
    ]
    if (mode === 'builder') {
      try { lines.push(`grid (builder mode; legend: ${VISION_LEGEND}):\n${buildVisionBlock(bot, { mode, range: 6, radius: 6, heightUp: 5, heightDown: 2 })}`) } catch { /* cosmetic */ }
    }
    // Who asked for what this turn is about (the newest chat request among the reasons).
    const asked = /^chat request from (\S+?):/.exec([...reasons].reverse().find((r) => /^chat request from /.test(r)) || '')
    return { text: lines.filter(Boolean).join('\n'), threatIds, askedBy: asked ? asked[1] : null, reasons }
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
      observe.selfLine(bot, { mode: wrapper.mode || 'explorer' }),
      observe.inventoryLine(bot, { max: 16 }),
      doingLine(),
      agendaLine(),
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
  const PASSIVE = new Set(['idle', 'say', 'hold', 'find', 'equip', 'eat', 'set_mode', 'remember_here'])

  async function act (reasons) {
    const snap = buildActionPrompt(reasons)
    logger.debug(TAG, `action turn (${reasons.join(' | ')})`)
    const { action } = await amd.chatWithTools([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: snap.text }
    ], ZINC_TOOLS)
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
    let { reply } = await amd.chatReply(messages, { maxTokens })
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
    const whisper = lines.some((l) => l.whisper)
    if (reply.text) speak(reply.text, { to: whisper ? sender : null, about: sender })
    if (reply.remember) {
      const kept = memory.rememberFact(reply.remember, { about: sender })
      if (kept) logger.info(TAG, `remembered (from ${sender}): ${kept.text}`)
    }
    if (reply.task) {
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
        combat.engage(f.request).then((r) => {
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
    const preflight = parser.checkInventory(blocks, bot.inventory.items())
    if (!preflight.ok) {
      const missing = preflight.missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')
      return { ok: false, msg: `cannot build ${label}${stage ? ' (' + stage + ')' : ''}: missing ${missing}` }
    }
    const plan = parser.plan({ name: label, blocks }, origin, bot.entity.position)
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
    const text = `build ${label}${stage ? ' (' + stage + ')' : ''}: placed ${result.placed}/${phaseTotal}${result.alreadyPresent ? `, ${result.alreadyPresent} already present` : ''}${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}${result.reason === 'cancelled' ? ', cancelled' : ''}${scaffoldNote}`
    if (result.placed > 0) note({ type: 'build_complete', msg: text }, { promote: true })
    return { ok: result.ok, msg: text }
  }

  // ----------------------------------------------------------- executor --
  async function executeAction (action, snap) {
    const vanilla = assertVanillaAction(action)
    if (!vanilla.ok) {
      logger.warn(TAG, `refused non-vanilla action (${vanilla.why})`)
      return report(action.a || 'action', { ok: false, msg: `refused: ${vanilla.why} — you cannot run commands` })
    }
    const a = action.a
    if (a !== 'idle') logger.info(TAG, `action: ${a} ${JSON.stringify(Object.fromEntries(Object.entries(action).filter(([k]) => !k.startsWith('_') && k !== 'a')))}`)
    switch (a) {
      case 'idle':
        // Prose without a tool call used to vanish silently; say so once.
        if (action._prose) report('reply', { ok: false, msg: 'you answered in prose without calling a tool, so nothing happened — call a tool (say to talk)' })
        else if (action._unknownTool) report('reply', { ok: false, msg: `there is no tool "${action._unknownTool}"` })
        else if (action._badArgs) report('reply', { ok: false, msg: `arguments for ${action._badArgs} were not valid JSON` })
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
        return startMain({ tool: 'go_to', label: `go to ${where}`, askedBy: snap.askedBy, decision: decided(snap, { label: 'go_to' }), run: () => skills.goTo(target) })
      }
      case 'follow': {
        return startMain({ tool: 'follow', label: `follow ${action.player}`, askedBy: snap.askedBy, decision: decided(snap, { label: 'follow', ttlMs: 30 * 60_000 }), run: () => skills.follow({ player: action.player }) })
      }
      case 'stop': {
        const duel = fight?.player ? combat?.target : null
        agenda.main = null
        agenda.asked = []
        replaceTask()
        system1.clearDecision()
        // A duel the model agreed to and then called off: the hits were part
        // of it, so the opponent is not somebody to run from afterwards.
        if (duel) sense.forgive(duel.id)
        return report('stop', { ok: true, msg: 'stopped' }, { wake: false })
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
        const r = await combat.engage(request)
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
        return startSide('look_in', () => skills.lookIn({ where: action.where }))
      case 'take':
        decided(snap, { label: 'take' })
        return startSide('take', () => skills.take({ item: action.item, count: action.count, where: action.where }))
      case 'put':
        decided(snap, { label: 'put' })
        return startSide('put', () => skills.put({ item: action.item, count: action.count, where: action.where }))
      case 'smelt':
        decided(snap, { label: 'smelt' })
        return startSide('smelt', () => skills.smelt({ item: action.item, count: action.count, where: action.where }))
      case 'sleep':
        decided(snap, { label: 'sleep' })
        return startSide('sleep', () => skills.sleep(), { until: 'wake' })
      case 'give':
        decided(snap, { label: 'give' })
        return startSide('give', () => skills.give({ player: action.player, item: action.item, count: action.count }))
      case 'use_block':
        decided(snap, { label: 'use_block' })
        return startSide('use_block', () => skills.useBlock({ what: action.what }))
      case 'eat':
        return background('eat', skills.eat({ item: action.item }))
      case 'equip':
        return report('equip', await skills.equip({ item: action.item, where: action.where }), { wake: null })
      case 'find':
        return report('find', skills.find({ what: action.what, page: action.page }))
      case 'remember_here':
        return report('remember_here', skills.rememberHere({ name: action.name, note: action.note }), { wake: null })
      case 'craft': {
        const item = String(action.i ?? action.item ?? '')
        if (!item) return report('craft', { ok: false, msg: 'craft needs an item' })
        const r = await craftItem(bot, item)
        return report('craft', { ok: Boolean(r.ok), msg: r.ok ? `crafted ${item}` : `could not craft ${item}: ${r.why || 'unknown'}` }, { wake: !r.ok })
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
        // Re-running a phase is idempotent, so a paused build simply runs again.
        return startMain({ tool: 'build', label: `build ${what}`, askedBy: snap.askedBy, showAs: `building ${what}`, decision: decided(snap, { label: 'build', ttlMs: 30 * 60_000 }), run: () => buildBlocks(planned.blocks, String(action.blueprint || 'inline'), stage, action.at) })
      }
      case 'build_shape': {
        if (!executor) return report('build_shape', { ok: false, msg: 'not ready yet' })
        const shape = String(action.shape || '')
        const block = String(action.block || '')
        const params = (action.params && typeof action.params === 'object') ? action.params : {}
        if (!shape || !block) return report('build_shape', { ok: false, msg: 'need shape and block' })
        let blocks
        try { blocks = generateShape(shape, params, block) } catch (err) { return report('build_shape', { ok: false, msg: String(err.message || err) }) }
        return startMain({ tool: 'build_shape', label: `build ${shape} of ${block}`, askedBy: snap.askedBy, showAs: `building ${shape} of ${block}`, decision: decided(snap, { label: 'build', ttlMs: 30 * 60_000 }), run: () => buildBlocks(blocks, `shape:${shape}`, normalizeStage(action.stage), action.at) })
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
      case 'set_mode': {
        const applied = wrapper.setMode(String(action.mode || ''))
        cfg.behavior.mode = applied
        return report('set_mode', { ok: true, msg: `movement mode ${applied}` }, { wake: false })
      }
      default:
        return report(String(a), { ok: false, msg: `unknown action "${a}"` })
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
    const first = !spawned
    spawned = true
    shared.everSpawned = true
    shared.attempts = 0

    // A fresh Movements every spawn; the wrapper re-applies EVERYTHING to it
    // (doors, mode, digging guard, scaffolding policy, threat costs).
    const movements = new Movements(bot)
    movements.canDig = Boolean(cfg.behavior.allowDigging)
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)
    wrapper.apply()

    if (systemsReady) {
      // Respawn: same bot object, same stack. Nobody owns anything any more.
      const p = here()
      logger.info(TAG, 'respawned')
      wrapper.setMode(cfg.behavior.mode || 'explorer')
      brain.wake(`respawned at ${p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'spawn'}; items were dropped at place "last death"`)
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
    skills = new Skills(bot, { arbiter, places, logger: wrapperLog, whisper: guard.whisper })
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
        if (evt.wake) brain.wake(evt.text, { external: true, urgent: evt.urgent === true })
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

    try { bot.armorManager?.equipAll?.() } catch { /* cosmetic */ }
    logger.info(TAG, 'ZincAI ready — reflexes flee, the model decides; chat lane + action lane on demand')
    if (first) {
      brain.wake('just joined the server — look around; idle is fine')
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
      const now = Date.now()
      if (hp > 0 && (cause.text !== lastHurt.text || now - lastHurt.at > 4000)) brain.wake(`hurt: ${cause.text} (hp ${hp})`, { external: true })
      lastHurt = { at: now, text: cause.text }
    }
  }).start()
  bot.on('entityHurt', (entity) => { if (entity !== bot.entity) system1?.onEntityHurt(entity) })

  bot.on('playerCollect', (collector, item) => {
    if (!systemsReady || collector !== bot.entity) return
    system1?.onItemGained(item?.name || 'item', null)
  })

  bot.on('death', () => {
    const p = here()
    const where = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown'
    hurts.flush() // name the killing blow before writing the obituary
    logger.warn(TAG, `died at ${where}${lastHurt.text ? ` (${lastHurt.text})` : ''}`)
    note({ type: 'death', msg: `I died at ${where}${lastHurt.text ? ` — ${lastHurt.text}` : ''}` }, { promote: true })
    if (p) places.remember('last death', p, { dim: dim(), note: lastHurt.text })
    fight = null
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
    pushConvo(sender, 'them', text)
    brain.hear(sender, text, { whisper })
  })

  // ------------------------------------------------------ session end ----
  function dispose (quit = false) {
    if (ended) return
    ended = true
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
  return { dispose, bot, internals: () => ({ arbiter, sense, wrapper, combat, system1, skills, brain, results, agenda, executeAction, buildActionPrompt, buildChatPrompt }) }
}

if (require.main === module) main()

module.exports = { loadConfig, validateConfig, makeShared, startSession, decideReconnect, FATAL_KICK_RE, ATTACK_WHY, SYSTEM_PROMPT, CHAT_PROMPT }
