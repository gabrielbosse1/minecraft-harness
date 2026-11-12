/**
 * ZincAgent — wires mineflayer to the AMD API and the five subsystems.
 *
 * Lifecycle:
 *   mineflayer.createBot({username:"Zinc"})           (directive: strict name)
 *   → any join failure (kicked/error/end before spawn) = FATAL, exit(1).
 *     The bot NEVER retries under a different name (whitelist compliance).
 *   → on spawn: load movements, acquire modules (combat/elytra/watchdog/
 *     chat-guard), snapshot inventory, equip best armor, arm the inference
 *     ticker (500ms tick, self-pacing via nextInferAt).
 *
 * Inference policy (token economy):
 *   - The loop ONLY calls the AMD API when at least one *trigger* delta is
 *     pending (chat, hp/food, combat outcome, craft result, spawn, death…).
 *     A silent server costs zero tokens.
 *   - Inventory deltas never wake the LLM by default (mining = noise).
 *   - One action per AMD call; the returned self-bookkeeping event re-arms the
 *     loop for up to MAX_SELF_CHAIN steps (a bounded ReAct chain), then forces
 *     a 30s pause. 'idle' ends the chain and backs off to the idle interval.
 *   - Calls are strictly serialized (never concurrent) to respect the ~20 RPM
 *     shared tier, with exponential backoff after errors.
 *
 * Deltas flow: game events → DeltaBuffer (max 5 + 10-word memory) → tiny
 * user message → AMD → strict JSON action → parser → dispatcher.
 *
 * The BODY is shared with ZincAI (zincai/control.js, threats.js, system1.js):
 *   - one arbiter owns the keys and the pathfinder goal
 *     (survival > combat > task), so nothing here can leave a key held;
 *   - the reflex layer FLEES from every real threat and tells the model;
 *   - a fight only ever starts from the model's own {"a":"attack"} — a player
 *     is only attacked when the model names that exact player.
 * The model's answer to a threat is the decision: idle keeps fleeing, attack
 * fights, move goes somewhere else.
 */
'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const armorManager = require('mineflayer-armor-manager')

const logger = require('./logger')
const { SYSTEM_PROMPT } = require('./systemPrompt')
const { DeltaBuffer } = require('./deltaState')
const { ChatGuard } = require('./chatGuard')
const { parseAction } = require('./actionParser')
const { AmdClient } = require('./amdClient')
const { craftItem } = require('./recipes')
const { AdvancedCombat } = require('./combat')
const { ElytraController } = require('./elytra')
const { AntiStuckWatchdog } = require('./watchdog')
const { decideReconnect } = require('./reconnect')
const { ControlArbiter, PRIORITY } = require('../zincai/control')
const { ThreatSense, HurtTracker, makeReachabilityCheck, useRegistry } = require('../zincai/threats')
const { System1 } = require('../zincai/system1')
const { ReflexRegistry } = require('../zincai/reflex_registry')
const { PredictiveThreatMap, fleePlan, makeEscapePlanner } = require('../zincai/custom_mineflayer/pathfinder_wrapper')
const { describeGroup, situation } = require('../zincai/tactics')
const { parseChatLine, chatAddressesBot, botNames } = require('../zincai/filter')

const TAG = 'agent'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const truncate = (s, n = 140) => {
  const str = String(s)
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

/**
 * Flatten a modern (1.20.2+ NBT) or classic JSON chat component into plain
 * text. Kick reasons from recent servers are NBT compounds shaped like
 *   { type: 'compound', value: { text: { type: 'string', value: 'x' } } }
 * or nested with extra/with lists. Classic components look like
 *   { text: 'msg', extra: [ ... ] }
 */
function chatComponentToText (node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map(chatComponentToText).join('')

  if (typeof node === 'object') {
    // Serialized NBT node: { type: 'string'|'compound'|'list'|..., value: ... }
    if (typeof node.type === 'string' && 'value' in node) {
      if (node.type === 'compound') return compoundToText(node.value)
      if (node.type === 'list') {
        const inner = node.value
        if (Array.isArray(inner)) return inner.map(chatComponentToText).join('')
        if (inner && Array.isArray(inner.value)) return inner.value.map(chatComponentToText).join('')
        return chatComponentToText(inner)
      }
      return chatComponentToText(node.value) // string/byte/int/...
    }
    // Untyped compound (prismarine-nbt sometimes hands us the bare value map)
    if (isPlainValueMap(node)) return compoundToText(node)
    // Classic JSON chat component
    return compoundToText(node)
  }
  return String(node)
}

function isPlainValueMap (obj) {
  const keys = Object.keys(obj)
  return keys.length > 0 && keys.every((k) => !['type', 'value'].includes(k)) &&
    (keys.includes('text') || keys.includes('translate') || keys.includes('extra') || keys.includes('with') || keys.includes('keybind'))
}

function compoundToText (map) {
  if (!map || typeof map !== 'object') return String(map ?? '')
  let out = ''
  if (map.text !== undefined) out += chatComponentToText(map.text)
  else if (map.translate !== undefined) out += chatComponentToText(map.translate)
  else if (map.keybind !== undefined) out += chatComponentToText(map.keybind)
  if (map.extra !== undefined) out += chatComponentToText(map.extra)
  if (map.with !== undefined) out += chatComponentToText(map.with)
  if (out) return out
  // No recognized chat fields — surface any embedded string leaves so the
  // message is not lost, rather than dumping raw key soup.
  const leaves = collectStringLeaves(map)
  return leaves.length ? leaves.join(' ') : JSON.stringify(map)
}

function collectStringLeaves (node, acc = []) {
  if (typeof node === 'string') { if (node) acc.push(node); return acc }
  if (Array.isArray(node)) { for (const item of node) collectStringLeaves(item, acc); return acc }
  if (node && typeof node === 'object') {
    if (typeof node.type === 'string' && 'value' in node) return collectStringLeaves(node.value, acc)
    for (const [k, v] of Object.entries(node)) { if (k === 'type') continue; collectStringLeaves(v, acc) }
  }
  return acc
}

/** Kick reasons arrive as Buffers, NBT/JSON-ish objects, or JSON strings. */
function reasonToText (reason) {
  try {
    if (reason === null || reason === undefined) return 'unknown'
    if (Buffer.isBuffer(reason)) reason = reason.toString('utf8')
    if (typeof reason === 'object') return truncate(chatComponentToText(reason) || JSON.stringify(reason), 200)
    const s = String(reason)
    // Common shape: {"text":"You are not whitelisted"} as a JSON *string*
    try {
      return truncate(chatComponentToText(JSON.parse(s)), 200)
    } catch {
      return truncate(s, 200)
    }
  } catch {
    return 'unparseable_reason'
  }
}

class ZincAgent {
  constructor (config) {
    this.cfg = config
    // Throws if the AMD key is missing — fail fast, before touching the network.
    this.amd = new AmdClient({
      apiKey: config.amdApiKey,
      baseUrl: config.amdBaseUrl,
      model: config.amdModel,
      timeoutMs: config.amdTimeoutMs,
      maxRetries: config.amdMaxRetries,
      temperature: config.amdTemperature,
      maxTokens: config.amdMaxTokens
    })
    this.buffer = new DeltaBuffer({ maxEvents: 5, memoryWords: 10 })

    this.bot = null
    this.chatGuard = null
    this.combat = null
    this.elytra = null
    this.watchdog = null
    // Shared body (built on spawn): who owns the controls, what is dangerous,
    // and the flee-first reflexes.
    this.arbiter = null
    this.sense = null
    this.threatMap = null
    this.reflex = null
    this.hurts = null
    this._threatTimer = null
    this._moveSeq = 0
    this._lastHurt = { at: 0, text: '' }

    this.started = false
    this.shuttingDown = false
    this._inferBusy = false
    this._activeInferId = null
    this._inferSequence = 0
    this._sessionGeneration = 0
    this.selfChain = 0
    this.consecutiveErrors = 0
    this.nextInferAt = 0
    this.amdCallCounter = 0

    this.lastMoveGoal = null
    this._invSnapshot = new Map()
    this._invDebounce = null
    this._prevHp = null
    this._prevFood = null
    this._ticker = null
    this._spawnCount = 0
  }

  // ------------------------------------------------------------ lifecycle--

  async start () {
    const { host, port, username, version, auth } = this.cfg.mc
    logger.info(TAG, `connecting to ${host}:${port} as "${username}" (auth=${auth})`)

    this.bot = mineflayer.createBot({
      host,
      port,
      username, // hard directive: "Zinc" unless deliberately overridden
      version: version || false,
      auth,
      checkTimeoutInterval: 30_000
    })
    this.bot.loadPlugin(pathfinder)
    this.bot.loadPlugin(armorManager)
    this._wireBotEvents()
  }

  _wireBotEvents () {
    const bot = this.bot

    bot.on('login', () => logger.info(TAG, `logged in as ${bot.username}`))

    // ---- strict whitelist compliance: a failed FIRST join = abort ---------
    // After a session that did spawn, a dropped link or a server restart is
    // retried with back-off under the same name (src/reconnect.js).
    bot.on('kicked', (reason) => this._connectionOver('kicked', reason))
    bot.on('error', (err) => {
      if (!this.started) this._connectionOver('error', err)
      else logger.error(TAG, `socket error: ${err.message || err}`)
    })
    bot.on('end', (reason) => this._connectionOver('end', reason))

    bot.on('spawn', () => { this._onSpawn().catch((err) => logger.error(TAG, `spawn setup failed: ${err.message || err}`)) })
    bot.on('death', () => {
      try { this.hurts?.flush() } catch { /* noop */ }
      this.buffer.push({ type: 'death' })
      // Nobody owns anything any more, and every earlier decision is void.
      this._moveSeq += 1
      try { this.combat?.stop(); this.combat?.start() } catch { /* noop */ }
      try { this.reflex?.reset() } catch { /* noop */ }
      try { this.arbiter?.reset('death') } catch { /* noop */ }
      try { this.threatMap?.clear() } catch { /* noop */ }
      // Real players respawn. Give the death screen a beat.
      setTimeout(() => { try { bot.respawn() } catch { /* not on death screen */ } }, 1500)
    })
    bot.on('respawn', () => this.buffer.push({ type: 'respawn' }))
    bot.on('health', () => this._onHealth())
    bot.on('messagestr', (raw) => this._onChatLine(raw))

    // NOTE: mineflayer injects its core plugins on a 0ms timer after
    // createBot() returns — bot.inventory does NOT exist synchronously.
    // Poll briefly until it does, then subscribe. (Deterministic; spawn is
    // always preceded by injection.)
    let inventoryPolls = 0
    const inventoryTimer = setInterval(() => {
      if (bot.inventory) {
        clearInterval(inventoryTimer)
        bot.inventory.on('updateSlot', () => this._scheduleInvDiff())
        logger.debug(TAG, 'inventory tracking armed')
      } else if (++inventoryPolls > 100) {
        clearInterval(inventoryTimer)
        logger.warn(TAG, 'inventory window never appeared — inventory deltas disabled')
      }
    }, 50)
  }

  /** The connection is gone: abort, exit, or reconnect — per the shared policy. */
  _connectionOver (kind, detail) {
    if (this.shuttingDown || this._reconnecting) return // kicked + end both fire
    const verdict = decideReconnect({
      kind,
      text: reasonToText(detail),
      everSpawned: this._everSpawned === true,
      attempts: this._attempts || 0,
      reconnect: this.cfg.reconnect,
      botName: this.cfg.mc.username
    })
    if (verdict.action === 'exit') {
      if (verdict.reason === 'join-failed') return this._fatalJoinFailure(kind, detail)
      for (const line of verdict.log) logger.error(TAG, line)
      return this.shutdown(verdict.reason, verdict.code)
    }
    this._reconnecting = true
    this._attempts = verdict.attempt
    logger.warn(TAG, `connection over (${kind}) — reconnecting in ${Math.round(verdict.delayMs / 1000)}s (attempt ${verdict.attempt}/${verdict.maxAttempts})`)
    this._teardownSession()
    setTimeout(() => {
      this._reconnecting = false
      if (!this.shuttingDown) this.start().catch((err) => logger.error(TAG, `reconnect failed: ${err.message || err}`))
    }, verdict.delayMs)
  }

  /** Stop everything attached to the dead bot so start() can build afresh. */
  _teardownSession () {
    // Invalidate any model response still in flight. Keep its busy lock until
    // it settles: AmdClient deliberately serializes requests, and the new
    // connection must not launch a concurrent completion.
    this._sessionGeneration += 1
    clearInterval(this._ticker)
    clearTimeout(this._invDebounce)
    this._stopBody()
    try {
      this.bot?.removeAllListeners()
      // A dying socket can still emit 'error'; with no listener at all Node
      // would throw it and take the process down mid-reconnect.
      this.bot?.on('error', () => {})
    } catch { /* noop */ }
    try { this.bot?.end?.() } catch { /* already gone */ }
    this.started = false
    this._spawnCount = 0
    this.lastMoveGoal = null
    this.combat = null
    this.elytra = null
    this.watchdog = null
    this.reflex = null
    this.hurts = null
    this.arbiter = null
    this.sense = null
    this.threatMap = null
  }

  /** Stop every subsystem that drives the bot (shutdown and reconnect). */
  _stopBody () {
    this._moveSeq += 1
    clearInterval(this._threatTimer)
    this._threatTimer = null
    try { this.watchdog?.stop() } catch { /* noop */ }
    try { this.hurts?.stop() } catch { /* noop */ }
    try { this.reflex?.stop() } catch { /* noop */ }
    try { this.combat?.stop() } catch { /* noop */ }
    try { this.elytra?.stop() } catch { /* noop */ }
    try { this.arbiter?.stop() } catch { /* noop */ }
  }

  _fatalJoinFailure (kind, detail) {
    if (this.shuttingDown) return // mineflayer emits kicked + end/error — log FATAL only once
    const reason = reasonToText(detail)
    // DO NOT retry, DO NOT rename — the whitelist mandate is absolute.
    logger.error(TAG, `FATAL: join rejected (${kind}): ${reason}`)
    logger.error(TAG, 'aborting. Check MC_USERNAME="Zinc", the server whitelist, and MC_AUTH.')
    this.shutdown('join-failed', 1)
  }

  async _onSpawn () {
    const bot = this.bot
    this._spawnCount += 1

    if (this._spawnCount > 1) {
      // A later spawn means we respawned or the server moved us.
      this.buffer.push({ type: 'spawn' }, { trigger: false })
      return
    }

    this.started = true
    this._everSpawned = true
    this._attempts = 0

    // --- pathfinder movements ------------------------------------------------
    const movements = new Movements(bot)
    movements.canDig = Boolean(this.cfg.mc.canDig) // default false: no block chewing
    movements.allowSprinting = true
    // Upstream pillars up and bridges with dirt/cobblestone from the inventory.
    // Around other people's builds that is griefing: off.
    movements.allow1by1towers = false
    movements.scafoldingBlocks = [] // (sic)
    bot.pathfinder.setMovements(movements)

    // --- the shared body: controls, threat sense --------------------------------
    // Pets and fuses are read from entity metadata by key name (26.x moved them).
    try {
      const data = useRegistry(bot.registry)
      for (const problem of data.problems) logger.warn(TAG, `game data: ${problem}`)
    } catch (err) { logger.debug(TAG, `game data check skipped: ${err.message || err}`) }
    this.arbiter = new ControlArbiter(bot)
    this.sense = new ThreatSense(bot, { reachable: makeReachabilityCheck(bot, { Movements, goals }) })
    // A* pays extra to walk near real threats, and the flee planner uses the
    // same map. Only what the threat sense calls real counts: never a caged
    // mob, never a player who is merely standing there.
    this.threatMap = new PredictiveThreatMap({ entityFilter: (e) => this.sense.isThreat(e) })
    this.threatMap.attachToMovements(movements)
    this._threatTimer = setInterval(() => {
      try { this.threatMap.sample(bot) } catch { /* no entity yet */ }
    }, this.threatMap.sampleMs)

    // --- subsystems -----------------------------------------------------------
    this.chatGuard = new ChatGuard(bot, { cooldownMs: this.cfg.chatCooldownMs })

    this.combat = new AdvancedCombat(bot, {
      maxHealth: this.cfg.maxHealth,
      disengageHealthFraction: this.cfg.disengageHealthFraction,
      attackCooldownMs: this.cfg.attackCooldownMs,
      disengageCooldownMs: this.cfg.disengageCooldownMs,
      engageRadius: this.cfg.engageRadius,
      hands: this.arbiter.lane('combat', PRIORITY.combat),
      threatMap: this.threatMap,
      fleeOnDisengage: false, // running away is the reflex layer's job
      // During a fight, also dodge any other player who hit the bot lately.
      watch: () => this._recentPlayerAttackers(),
      onEvent: (evt) => this._onCombatEvent(evt) // combat outcome = trigger delta
    })
    this.combat.start()

    // The reflex layer: flee from every real threat until the model decides;
    // eat, break a long fall, swim. It has no attack action at all.
    this.reflex = new System1(bot, {
      registry: new ReflexRegistry(),
      logger,
      arbiter: this.arbiter,
      sense: this.sense,
      combat: this.combat,
      // Where to run: the wall-aware planner first, the old "point away" as its fallback.
      pathfinder: { escapePlan: makeEscapePlanner(bot, { Movements }), fleePlan: (opts) => fleePlan(bot, this.threatMap, opts) },
      autoElytra: false, // the ElytraController below owns gliding
      tickMs: this.cfg.reflexTickMs,
      onEvent: (evt) => this._onReflexEvent(evt)
    })
    this.reflex.start()
    this.hurts = new HurtTracker(bot, this.sense, {
      isReady: () => this.started && !this.shuttingDown,
      onHurt: (cause, info) => this._onHurt(cause, info)
    }).start()

    this.elytra = new ElytraController(bot, {
      minFallBlocks: this.cfg.elytraMinFallBlocks,
      gapBlocks: this.cfg.elytraGapBlocks,
      autoCooldownMs: this.cfg.elytraAutoCooldownMs,
      combatProvider: () => this.combat?.target ?? null,
      onEvent: (evt) => this.buffer.push(evt, { trigger: false })
    })
    this.elytra.start()

    this.watchdog = new AntiStuckWatchdog(bot, {
      // Only while the PATHFINDER is supposed to be moving us. A melee fight
      // stands its ground on purpose; counting it as "stuck" made the bot turn
      // its back on the enemy every few seconds.
      // And never while fleeing: the reflex has its own no-progress handling,
      // and a 180° turn there means turning back toward the danger.
      goalActiveProvider: () => this.arbiter?.owner() !== 'survival' && (Boolean(this.lastMoveGoal) || Boolean(this.combat?.activeGoal)),
      goalProvider: () => this.combat?.activeGoal ?? this.lastMoveGoal,
      // The routine taps keys and clears the path directly; if the flee
      // reflex takes over meanwhile it stops, and either way the arbiter puts
      // the current driver's goal and keys back afterwards.
      abortProvider: () => this.arbiter?.owner() === 'survival',
      reapply: () => this.arbiter?.reassert(),
      onUnstuck: () => this.buffer.push({ type: 'unstuck', ok: true })
    })
    this.watchdog.start()

    // --- inventory snapshot (baseline for deltas) ------------------------------
    this._invSnapshot = this._countInventory()
    // Only baseline what we can actually observe — anything unknown stays null
    // so the first health packet initializes it SILENTLY (no phantom deltas).
    this._prevHp = Number.isFinite(bot.health) ? bot.health : null
    this._prevFood = Number.isFinite(bot.food) ? bot.food : null

    // Best armor on, automatically, like a geared-up player would.
    try { await bot.armorManager?.equipAll?.() } catch (err) { logger.debug(TAG, `armor equip: ${err.message || err}`) }

    logger.info(TAG, `spawn OK — model=${this.cfg.amdModel} endpoint=${this.cfg.amdBaseUrl}`)
    logger.info(TAG, 'harness ready. Silence is default; acting only on deltas.')

    // Inference ticker — actual pacing is enforced in _maybeInfer.
    this._ticker = setInterval(() => { this._maybeInfer().catch(() => {}) }, this.cfg.inferenceTickMs || 500)
  }

  async shutdown (reason = 'manual', code = 0) {
    if (this.shuttingDown) return
    this.shuttingDown = true
    logger.info(TAG, `shutting down (${reason})`)

    clearInterval(this._ticker)
    clearTimeout(this._invDebounce)
    this._stopBody()

    this._logKvStats()

    try { this.bot?.quit() } catch { /* already gone */ }
    // Hard-exit safety net in case the connection never closes. Deliberately
    // REF'd: the process must exit with the requested code even if the event
    // loop empties out first (e.g. join failure before spawn).
    setTimeout(() => process.exit(code), 1_000)
  }

  _logKvStats () {
    const s = this.amd.getStats()
    const hit = s.kvCacheHitRate === null ? 'n/a (no cache metrics reported)' : `${(s.kvCacheHitRate * 100).toFixed(1)}%`
    logger.info(TAG, `amd session: ${s.requests} calls, ${s.failures} failures, avg prompt ${s.avgPromptTokensPerCall} tok, cached ${s.cachedTokens} tok, kv-hit-rate ${hit}`)
  }

  // ------------------------------------------------------- delta sources--

  _onHealth () {
    const bot = this.bot
    if (bot.health === undefined) return
    const hp = Math.round(bot.health)
    // audit2 B13: absorption/health-boost raise real hp past the vanilla 20;
    // the observed maximum becomes the combat base (odds + disengage).
    try { this.combat?.noteHealth?.(hp) } catch { /* cosmetic */ }
    const food = Math.round(bot.food ?? 20)
    const prevHp = this._prevHp
    const prevFood = this._prevFood
    this._prevHp = hp
    this._prevFood = food

    if (prevHp === null || prevHp === undefined || prevFood === null || prevFood === undefined) {
      // First reliable observation becomes the baseline — never a delta.
      this._prevHp = hp
      this._prevFood = food
      return
    }
    // Emit a delta only on meaningful movement: ≥2 hp swing, or crossing the
    // 30% disengage threshold (6 hp), or food ≥2 change / crossing 6.
    // Losing health is reported by _onHurt, with the cause; this is recovery.
    const crossedLow = (prevHp > 6) !== (hp > 6)
    if (hp > prevHp && (hp - prevHp >= 2 || crossedLow)) {
      this.buffer.push({ type: 'hp', v: hp })
    }
    const foodCrossed = (prevFood > 6) !== (food > 6)
    if (Math.abs(food - prevFood) >= 2 || foodCrossed) {
      this.buffer.push({ type: 'food', v: food })
    }
  }

  /** One hit on the bot, with its cause in words ("hit by zombie", "fall damage"). */
  _onHurt (cause, { hp }) {
    const now = Date.now()
    const repeat = cause.text === this._lastHurt.text && now - this._lastHurt.at < 5000
    this._lastHurt = { at: now, text: cause.text }
    if (repeat || hp <= 0) return // same story again, or the death event tells it
    this.buffer.push({ type: 'hurt', msg: cause.text, hp })
    this._urgent()
  }

  /**
   * Someone is waiting or something is dangerous: do not sit out the idle
   * interval (15 s) or the self-chain pause. The minimum spacing between
   * calls still holds, and so does the back-off after API errors.
   */
  _urgent () {
    if (this.consecutiveErrors > 0) return
    const earliest = (this._lastInferAt || 0) + this.cfg.inferenceMinIntervalMs
    if (this.nextInferAt > earliest) this.nextInferAt = earliest
  }

  /** The reflex layer started or stopped fleeing. */
  _onReflexEvent (evt) {
    if (!evt || !evt.text) return
    if (evt.type === 'threat') {
      this.buffer.push({ type: 'threat', msg: evt.text }) // wakes the model: it decides
      this._urgent()
    } else this.buffer.push({ type: evt.type || 'reflex', msg: evt.text }, { trigger: false })
  }

  _onCombatEvent (evt) {
    // Only the OUTCOME is news. The blow-by-blow (every hit, sidestep and
    // arrow) used to wake the model on each swing and push chat out of the
    // five-event window.
    if (!evt || !evt.result) return
    const name = this._fightLabel || 'target'
    this._fightLabel = null
    if (this._leavingFight) return // the model itself moved on: not news
    const msg = evt.result === 'won' ? `${name} down` : evt.result === 'lost' ? `lost ${name}` : String(evt.msg || 'disengaged')
    this.buffer.push({ type: 'combat', msg })
    // The fight is over (won, lost or broken off): the decision to fight goes
    // with it, and whatever is still around is fled from again.
    try { this.reflex?.clearDecision() } catch { /* noop */ }
  }

  _onChatLine (raw) {
    const bot = this.bot
    // Vanilla "<Name> message" plus the usual plugin formats and whispers.
    // Ignore our own echoes and anything we can't attribute (system lines).
    const players = Object.keys(bot.players || {})
    const parsed = parseChatLine(raw, { players })
    if (!parsed) return
    const user = String(parsed.sender).trim()
    const msg = String(parsed.text).trim().slice(0, 80)
    if (!user || !msg) return
    if (user === bot.username) return
    // Only lines meant for the bot wake the model; the rest is context.
    const forMe = chatAddressesBot(msg, {
      names: botNames(bot.username, this.cfg.aliases || ['zinc']),
      whisper: parsed.whisper,
      othersOnline: players.filter((p) => p !== bot.username).length
    })
    const evt = { type: 'chat', user, msg }
    // Where the speaker stands, when the bot can see them: the only way this
    // tiny prompt can answer "come here".
    const at = bot.players?.[user]?.entity?.position
    if (forMe && at) evt.at = `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`
    this.buffer.push(evt, { trigger: Boolean(forMe) })
    if (forMe) this._urgent()
  }

  _countInventory () {
    const counts = new Map()
    if (!this.bot) return counts
    for (const item of this.bot.inventory.items()) {
      counts.set(item.name, (counts.get(item.name) || 0) + item.count)
    }
    return counts
  }

  _scheduleInvDiff () {
    clearTimeout(this._invDebounce)
    this._invDebounce = setTimeout(() => this._emitInvDelta(), 300)
  }

  _emitInvDelta () {
    const now = this._countInventory()
    const prev = this._invSnapshot
    const changes = []
    const names = new Set([...now.keys(), ...prev.keys()])
    for (const name of names) {
      const d = (now.get(name) || 0) - (prev.get(name) || 0)
      if (d !== 0) changes.push(`${d > 0 ? '+' : ''}${d} ${name}`)
    }
    this._invSnapshot = now
    if (!changes.length) return
    // Keep the line bounded: max 6 items, rest summarized.
    const shown = changes.slice(0, 6).join(',')
    const suffix = changes.length > 6 ? `,+${changes.length - 6} more` : ''
    this.buffer.push({ type: 'inv_delta', d: shown + suffix }, { trigger: this.cfg.inferOnInventoryDelta })
  }

  _vitalsLine () {
    const bot = this.bot
    const hp = Math.round(bot?.health ?? 0)
    const food = Math.round(bot?.food ?? 0)
    const p = bot?.entity?.position
    const pos = p ? `${Math.trunc(p.x)},${Math.trunc(p.y)},${Math.trunc(p.z)}` : '?,?,?'
    const tod = bot?.time?.isDay === false ? 'night' : 'day'
    // Deliberately O(1) size — this is the ONLY state we always send.
    // audit2 B6: plus one short inventory line, so "equip" and "craft" name
    // real items instead of guessing invisible hotbar slots. Capped.
    let inv = ''
    try {
      const kinds = [...this._countInventory().entries()].slice(0, 12)
      inv = ` inv ${kinds.length ? kinds.map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(', ') : 'empty'}`
    } catch { inv = '' }
    const vitals = `vitals hp=${hp} food=${food} pos=${pos} tod=${tod}${inv}`
    // …plus one line while something dangerous is around, so the model knows
    // what its answer is deciding about — and what its body did by itself.
    // One count: everything hostile that has a line on the bot, near or still
    // approaching (it used to count only the ones inside 12 blocks, so a horde
    // of 27 read as "1").
    const coming = this.sense?.coming?.() || []
    const reflex = this.reflex?.reflexLine?.({ brief: true }) || null
    if (!coming.length) return reflex ? `${vitals}\nreflex you ${reflex}` : vitals
    const picture = situation(bot, coming)
    const kinds = picture ? picture.groups.slice(0, 4).map(describeGroup).join(', ') : this.sense.describe(coming)
    const state = this.reflex?.fleeing ? `you are ${reflex || 'FLEEING by reflex'}` : 'not fleeing (you decided)'
    return `${vitals}\nthreats ${coming.length} in sight — ${kinds} — ${state}`
  }

  /** Players who hit the bot within the threat sense's memory and are still in view. */
  _recentPlayerAttackers () {
    const out = []
    const bot = this.bot
    if (!bot || !this.sense?.attackers) return out
    for (const [id, a] of this.sense.attackers) {
      if (!a.player) continue
      const e = bot.entities?.[id]
      if (e && this.sense.isRecentAttacker(e)) out.push(e)
    }
    return out
  }

  // ---------------------------------------------------- inference engine--

  async _maybeInfer () {
    if (this.shuttingDown || !this.started || this._inferBusy) return
    const now = Date.now()
    if (now < this.nextInferAt) return
    if (this.buffer.triggerCount() === 0) return // silent server = zero tokens
    this._inferBusy = true
    const inferId = ++this._inferSequence
    this._activeInferId = inferId
    this._lastInferAt = now
    this.amdCallCounter += 1

    const session = this.bot // a reconnect swaps the bot under a call in flight
    const generation = this._sessionGeneration
    try {
      const body = this.buffer.buildBody(this._vitalsLine())
      // The threats this prompt shows: the model's answer decides about these.
      // …and whatever the body is running from right now, in sight or not.
      const shown = [...new Set([...(this.sense?.last?.dangerIds || this.sense?.last?.ids || []), ...(this.reflex?.chasers || []).map((t) => t.id)])]
      const messages = [
        // Byte-identical static system prompt → KV prefix cache hit.
        { role: 'system', content: SYSTEM_PROMPT },
        // ~30-60 tokens of delta events. Nothing else, ever.
        { role: 'user', content: body }
      ]

      const { content, usage } = await this.amd.chatCompletion(messages)
      this.consecutiveErrors = 0
      // The answer belongs to a connection that no longer exists: keep the
      // events for the next session instead of acting on a dead bot.
      if (session !== this.bot || generation !== this._sessionGeneration || !this.started || this.shuttingDown) return
      if (this.amdCallCounter % 25 === 0) this._logKvStats()
      logger.debug(TAG, `usage prompt=${usage.promptTokens ?? '?'} cached=${usage.cachedTokens ?? '?'} :: ${truncate(content, 100)}`)

      const parsed = parseAction(content)
      if (!parsed.ok) {
        this.amd.stats.parseFailures = (this.amd.stats.parseFailures || 0) + 1
        logger.warn(TAG, `unparseable action (${parsed.error}) :: ${truncate(content, 120)}`)
        // The events are only consumed once an answer could be read: a
        // malformed reply used to throw away the chat line it was about.
        // One retry; a second garbage answer drops them so we never loop.
        this._parseFails = (this._parseFails || 0) + 1
        if (this._parseFails >= 2) { this.buffer.commit(); this._parseFails = 0; this._afterAction({ a: 'idle' }) } else { this.selfChain = 0; this.nextInferAt = Date.now() + this.cfg.inferenceMinIntervalMs }
        return
      }
      this._parseFails = 0
      this.buffer.commit()
      await this._dispatch(parsed.action, shown)
    } catch (err) {
      // A timeout/rejection from a dead connection is not an error in the
      // fresh session and must not impose its back-off on that session.
      if (session !== this.bot || generation !== this._sessionGeneration || this.shuttingDown) return
      this.consecutiveErrors += 1
      const delay = Math.min(120_000, 5_000 * 2 ** (this.consecutiveErrors - 1))
      this.nextInferAt = Date.now() + delay
      logger.error(TAG, `inference failed (#${this.consecutiveErrors}): ${truncate(err.message || err, 160)} — backoff ${Math.round(delay / 1000)}s`)
    } finally {
      // Only the request that owns this lock may release it. It stays held
      // across reconnects until the old request settles, preserving the
      // client's one-in-flight request guarantee.
      if (this._activeInferId === inferId) {
        this._activeInferId = null
        this._inferBusy = false
      }
    }
  }

  _afterAction (action) {
    if (action.a === 'idle') {
      this.selfChain = 0
      this.nextInferAt = Date.now() + this.cfg.inferenceIdleIntervalMs
      return
    }
    this.selfChain += 1
    if (this.selfChain >= this.cfg.maxSelfChain) {
      this.selfChain = 0
      logger.warn(TAG, `self-chain cap (${this.cfg.maxSelfChain}) reached — forced 30s pause`)
      this.nextInferAt = Date.now() + 30_000
      return
    }
    this.nextInferAt = Date.now() + this.cfg.inferenceMinIntervalMs
  }

  async _dispatch (action, shown = []) {
    const push = (evt, opts) => this.buffer.push(evt, opts)
    switch (action.a) {
      case 'say': {
        const r = this.chatGuard.trySay(action.t)
        push({ type: 'self', d: r.ok ? `said "${r.said}"` : `say_dropped:${r.why}` })
        logger.info('chat', r.ok ? `say → ${r.said}` : `say dropped (${r.why})`)
        break
      }
      case 'craft': {
        const r = await craftItem(this.bot, action.i, { approach: (table) => this._approachForCraft(table) })
        if (r.ok) {
          push({ type: 'craft', i: action.i, ok: true })
          logger.info(TAG, `crafted ${action.i}`)
        } else {
          push({ type: 'craft', i: action.i, ok: false, why: r.why })
          logger.info(TAG, `craft ${action.i} failed: ${r.why}`)
        }
        break
      }
      case 'equip': {
        // audit2 B6: by item name (from the inv line) — the old slot number
        // stayed as a fallback. Names equip from ANYWHERE in the inventory.
        if (action.i) {
          const q = String(action.i).toLowerCase()
          const found = this.bot.inventory.items().find((it) => it.name === q) ||
            this.bot.inventory.items().find((it) => it.name.endsWith('_' + q))
          if (found) {
            try {
              await this.bot.equip(found, 'hand')
              push({ type: 'equip', i: found.name, ok: true })
            } catch (err) {
              push({ type: 'action_err', a: 'equip', why: String(err?.message || err).slice(0, 60) })
            }
          } else push({ type: 'action_err', a: 'equip', why: `not carrying ${q} (see inv line)` })
        } else {
          const held = this._equipSlot(action.s)
          push({ type: 'equip', s: action.s, i: held ?? 'empty' })
        }
        break
      }
      case 'hold': {
        // audit2 B14: the missing decision — accept the threats shown (penned
        // mobs, a guarded friend) instead of only flee/attack/move.
        this.reflex?.acknowledge(shown, { label: 'hold', ttlMs: 30 * 60_000 })
        push({ type: 'self', d: `hold: not running from ${shown.length} shown threat${shown.length === 1 ? '' : 's'} (until one hits me or something new shows up)` })
        logger.info(TAG, `hold acknowledged for ${shown.length} threat(s)`)
        break
      }
      case 'attack': {
        const r = await this.combat.engage(action.n)
        if (r.ok) {
          this._fightLabel = r.target
          push({ type: 'attack', n: r.target })
          // The model decided to fight: stop fleeing from what it was shown.
          // "attack zombie" also covers zombies that arrive later; a player
          // fight covers that player only.
          const any = ['any', 'hostile', 'hostiles', 'mob'].includes(String(action.n).toLowerCase().trim())
          const versusPlayer = this.combat.target?.type === 'player'
          // For as long as the fight lasts (it is cleared when the fight ends); two minutes was a silent bolt mid-fight.
          this.reflex?.acknowledge(shown, { types: versusPlayer || any ? [] : [r.target], all: any, ttlMs: 10 * 60_000, label: 'fight' })
        } else push({ type: 'action_err', a: 'attack', why: r.why })
        logger.info(TAG, r.ok ? `attacking ${r.target}` : `attack failed: ${r.why}`)
        break
      }
      case 'move': {
        // The model decided to go somewhere: that is its answer to the threats
        // it was shown, and it replaces a fight in progress (the newest
        // decision wins). The walk runs in the background and reports when it
        // ends, so chat and new dangers are still answered on the way.
        if (this.combat?.isEngaged) {
          this._leavingFight = true
          try { this.combat.disengage('moved on', { cooldown: false }) } finally { this._leavingFight = false }
        }
        this.reflex?.acknowledge(shown, { label: 'move' })
        this._startMove(action.x, action.y, action.z)
        break
      }
      case 'elytra': {
        const r = await this.elytra.deploy('manual')
        if (!r.ok) logger.info(TAG, `elytra deploy declined: ${r.why}`)
        push({ type: 'elytra', ok: r.ok })
        break
      }
      case 'idle': {
        push({ type: 'self', d: 'idle' }, { trigger: false })
        break
      }
      default:
        logger.warn(TAG, `unhandled action (parser should have caught): ${action.a}`)
    }
    this._afterAction(action)
  }

  /**
   * audit2 E/B3: walk next to a crafting table before bot.craft — the finder
   * sees 8 m but craft needs ~4.5 m. Refuses to run while the survival lane
   * owns the body; replaces an in-flight plain walk (the model's newest
   * decision wins — the minimal harness has no agenda to resume one).
   */
  async _approachForCraft (table) {
    const p = table?.position
    if (!p || !this.bot?.pathfinder?.setGoal) return { ok: false, why: 'no pathfinder' }
    if (this.arbiter?.owner?.() === 'survival') return { ok: false, why: 'body is busy fleeing' }
    const goal = new goals.GoalGetToBlock(p.x, p.y, p.z)
    try {
      this.bot.pathfinder.setGoal(goal)
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        if (this.arbiter?.owner?.() === 'survival') return { ok: false, why: 'fleeing took over' }
        const d = this.bot.entity?.position?.distanceTo(p)
        if (d === undefined || d === null) return { ok: false, why: 'no position' }
        if (d <= 4) return { ok: true }
        await new Promise((r) => setTimeout(r, 200))
      }
      return { ok: false, why: 'timeout walking to the table' }
    } finally {
      try { if (this.bot?.pathfinder?.goal === goal) this.bot.pathfinder.setGoal(null) } catch { /* gone */ }
    }
  }

  /** Equip hotbar slot 0-8 (player window slots 36-44). */
  _equipSlot (slot) {
    const index = 36 + slot
    const item = this.bot.inventory.slots[index]
    try {
      this.bot.setQuickBarSlot(slot)
    } catch (err) {
      logger.debug(TAG, `setQuickBarSlot failed: ${err.message || err}`)
      return null
    }
    // After setQuickBarSlot the held item becomes index 36+slot of the player window.
    return this.bot.inventory.slots[index]?.name ?? item?.name ?? null
  }

  /** Start a walk and report how it ended as a delta (the model's wake-up). */
  _startMove (x, y, z) {
    const seq = ++this._moveSeq
    this._doMove(x, y, z, seq).then((r) => {
      if (seq !== this._moveSeq) return // replaced by a newer move, death or shutdown: not news
      if (!this.combat?.isEngaged) { try { this.reflex?.clearDecision() } catch { /* noop */ } }
      this.buffer.push({ type: 'move', x, y, z, ok: r.ok, ...(r.why ? { why: r.why } : {}) })
    })
  }

  /**
   * Walk to a position through the arbiter's task lane, with a hard timeout.
   * While a reflex (fleeing) or a fight drives, the walk is paused — that time
   * does not count — and it resumes by itself afterwards. Watchdog-friendly.
   */
  async _doMove (x, y, z, seq = this._moveSeq) {
    const bot = this.bot
    const goal = new goals.GoalNear(x, y, z, 1)
    const lane = this.arbiter.lane('task', PRIORITY.task)
    const mine = { goal, dynamic: false }
    this.lastMoveGoal = mine
    let noPath = false
    const onPath = (r) => { if (lane.isTop && r && r.status === 'noPath') noPath = true }
    bot.on('path_update', onPath)
    lane.acquire({ reason: 'move' })
    lane.setGoal(goal, false)
    let budget = this.cfg.moveTimeoutMs
    let last = Date.now()
    try {
      for (;;) {
        await sleep(150)
        const now = Date.now()
        if (seq !== this._moveSeq) return { ok: false, why: 'replaced' }
        const here = bot.entity?.position
        if (!here) return { ok: false, why: 'no_position' }
        if (!lane.isTop) { last = now; continue } // fleeing or fighting: paused
        budget -= now - last
        last = now
        if (goal.isEnd(here.floored())) return { ok: true }
        if (noPath) return { ok: false, why: 'no_path' }
        if (budget <= 0) {
          logger.warn(TAG, `move to ${x},${y},${z} timed out after ${Math.round(this.cfg.moveTimeoutMs / 1000)}s`)
          return { ok: false, why: 'timeout' }
        }
      }
    } finally {
      try { bot.removeListener('path_update', onPath) } catch { /* gone */ }
      // A replaced walk must not wipe the goal its replacement just set.
      if (seq === this._moveSeq) {
        try { lane.setGoal(null); lane.clearControlStates(); lane.release('move over') } catch { /* bot gone */ }
      }
      if (this.lastMoveGoal === mine) this.lastMoveGoal = null
    }
  }
}

module.exports = { ZincAgent, reasonToText }
