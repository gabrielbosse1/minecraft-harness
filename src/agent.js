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

    this.started = false
    this.shuttingDown = false
    this._inferBusy = false
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

    // ---- strict whitelist compliance: any join failure = abort ------------
    bot.on('kicked', (reason) => this._fatalJoinFailure('kicked', reason))
    bot.on('error', (err) => {
      if (!this.started) this._fatalJoinFailure('error', err)
      else logger.error(TAG, `socket error: ${err.message || err}`)
    })
    bot.on('end', (reason) => {
      if (!this.started) this._fatalJoinFailure('end', reason)
      else this.shutdown('server-ended', 0)
    })

    bot.on('spawn', () => { this._onSpawn().catch((err) => logger.error(TAG, `spawn setup failed: ${err.message || err}`)) })
    bot.on('death', () => {
      this.buffer.push({ type: 'death' })
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

    // --- pathfinder movements ------------------------------------------------
    const movements = new Movements(bot)
    movements.canDig = Boolean(this.cfg.mc.canDig) // default false: no block chewing
    movements.allowSprinting = true
    bot.pathfinder.setMovements(movements)

    // --- subsystems -----------------------------------------------------------
    this.chatGuard = new ChatGuard(bot, { cooldownMs: this.cfg.chatCooldownMs })

    this.combat = new AdvancedCombat(bot, {
      maxHealth: this.cfg.maxHealth,
      disengageHealthFraction: this.cfg.disengageHealthFraction,
      attackCooldownMs: this.cfg.attackCooldownMs,
      disengageCooldownMs: this.cfg.disengageCooldownMs,
      engageRadius: this.cfg.engageRadius,
      onEvent: (evt) => this.buffer.push(evt) // combat outcome = trigger delta
    })
    this.combat.start()

    this.elytra = new ElytraController(bot, {
      minFallBlocks: this.cfg.elytraMinFallBlocks,
      gapBlocks: this.cfg.elytraGapBlocks,
      autoCooldownMs: this.cfg.elytraAutoCooldownMs,
      combatProvider: () => this.combat?.target ?? null,
      onEvent: (evt) => this.buffer.push(evt, { trigger: false })
    })
    this.elytra.start()

    this.watchdog = new AntiStuckWatchdog(bot, {
      goalActiveProvider: () => Boolean(this.lastMoveGoal) || Boolean(this.combat?.activeGoal) || Boolean(this.combat?.isEngaged),
      goalProvider: () => this.combat?.activeGoal ?? this.lastMoveGoal,
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
    this._ticker = setInterval(() => { this._maybeInfer().catch(() => {}) }, 500)
  }

  async shutdown (reason = 'manual', code = 0) {
    if (this.shuttingDown) return
    this.shuttingDown = true
    logger.info(TAG, `shutting down (${reason})`)

    clearInterval(this._ticker)
    clearTimeout(this._invDebounce)
    try { this.watchdog?.stop() } catch { /* noop */ }
    try { this.combat?.stop() } catch { /* noop */ }
    try { this.elytra?.stop() } catch { /* noop */ }

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
    const crossedLow = (prevHp > 6) !== (hp > 6)
    if (Math.abs(hp - prevHp) >= 2 || crossedLow) {
      this.buffer.push({ type: 'hp', v: hp })
    }
    const foodCrossed = (prevFood > 6) !== (food > 6)
    if (Math.abs(food - prevFood) >= 2 || foodCrossed) {
      this.buffer.push({ type: 'food', v: food })
    }
  }

  _onChatLine (raw) {
    const bot = this.bot
    // mineflayer messagestr gives "<Name> message" for chat. Ignore our own
    // echoes and anything we can't attribute (system lines — usually noise).
    const m = /^<([^>]{1,32})>\s?(.+)$/.exec(String(raw).trim())
    if (!m) return
    const user = m[1].trim()
    const msg = m[2].trim().slice(0, 80)
    if (!user || !msg) return
    if (user === bot.username) return
    this.buffer.push({ type: 'chat', user, msg })
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
    return `vitals hp=${hp} food=${food} pos=${pos} tod=${tod}`
  }

  // ---------------------------------------------------- inference engine--

  async _maybeInfer () {
    if (this.shuttingDown || !this.started || this._inferBusy) return
    const now = Date.now()
    if (now < this.nextInferAt) return
    if (this.buffer.triggerCount() === 0) return // silent server = zero tokens
    this._inferBusy = true
    this.amdCallCounter += 1

    try {
      const body = this.buffer.buildBody(this._vitalsLine())
      const messages = [
        // Byte-identical static system prompt → KV prefix cache hit.
        { role: 'system', content: SYSTEM_PROMPT },
        // ~30-60 tokens of delta events. Nothing else, ever.
        { role: 'user', content: body }
      ]

      const { content, usage } = await this.amd.chatCompletion(messages)
      this.consecutiveErrors = 0
      this.buffer.commit()
      if (this.amdCallCounter % 25 === 0) this._logKvStats()
      logger.debug(TAG, `usage prompt=${usage.promptTokens ?? '?'} cached=${usage.cachedTokens ?? '?'} :: ${truncate(content, 100)}`)

      const parsed = parseAction(content)
      if (!parsed.ok) {
        this.amd.stats.parseFailures = (this.amd.stats.parseFailures || 0) + 1
        logger.warn(TAG, `unparseable action (${parsed.error}) :: ${truncate(content, 120)}`)
        this._afterAction({ a: 'idle' }) // pay one idle — never feed garbage back
        return
      }
      await this._dispatch(parsed.action)
    } catch (err) {
      this.consecutiveErrors += 1
      const delay = Math.min(120_000, 5_000 * 2 ** (this.consecutiveErrors - 1))
      this.nextInferAt = Date.now() + delay
      logger.error(TAG, `inference failed (#${this.consecutiveErrors}): ${truncate(err.message || err, 160)} — backoff ${Math.round(delay / 1000)}s`)
    } finally {
      this._inferBusy = false
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

  async _dispatch (action) {
    const push = (evt, opts) => this.buffer.push(evt, opts)
    switch (action.a) {
      case 'say': {
        const r = this.chatGuard.trySay(action.t)
        push({ type: 'self', d: r.ok ? `said "${r.said}"` : `say_dropped:${r.why}` })
        logger.info('chat', r.ok ? `say → ${r.said}` : `say dropped (${r.why})`)
        break
      }
      case 'craft': {
        const r = await craftItem(this.bot, action.i)
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
        const held = this._equipSlot(action.s)
        push({ type: 'equip', s: action.s, i: held ?? 'empty' })
        break
      }
      case 'attack': {
        const r = await this.combat.engage(action.n)
        if (r.ok) push({ type: 'attack', n: r.target })
        else push({ type: 'action_err', a: 'attack', why: r.why })
        logger.info(TAG, r.ok ? `attacking ${r.target}` : `attack failed: ${r.why}`)
        break
      }
      case 'move': {
        const r = await this._doMove(action.x, action.y, action.z)
        push({ type: 'move', x: action.x, y: action.y, z: action.z, ok: r.ok })
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

  /** Pathfind to a position with a hard timeout. Watchdog-friendly. */
  async _doMove (x, y, z) {
    const goal = new goals.GoalNear(x, y, z, 1)
    this.lastMoveGoal = { goal, dynamic: false }
    try {
      const outcome = await Promise.race([
        this.bot.pathfinder.goto(goal).then(() => 'done', (err) => `err:${err.name || 'move_failed'}`),
        sleep(this.cfg.moveTimeoutMs).then(() => 'timeout')
      ])
      if (outcome === 'timeout') {
        try { this.bot.pathfinder.setGoal(null) } catch { /* noop */ }
        logger.warn(TAG, `move to ${x},${y},${z} timed out after ${Math.round(this.cfg.moveTimeoutMs / 1000)}s`)
        return { ok: false }
      }
      if (typeof outcome === 'string' && outcome.startsWith('err:')) {
        logger.debug(TAG, `move ended early: ${outcome}`)
        return { ok: false }
      }
      return { ok: true }
    } finally {
      this.lastMoveGoal = null
    }
  }
}

module.exports = { ZincAgent, reasonToText }
