/**
 * api_wrapper.js — AMD Radeon Cloud client, NATIVE TOOL CALLING edition.
 *
 * Why this exists: Qwen (like every modern instruct model) was trained with
 * OpenAI-style function-calling data. Forcing it to emit raw JSON action lines
 * in a text contract fights its training and produces syntax errors, markdown
 * fences and hallucinated fields. Radeon Cloud exposes an OpenAI-compatible
 * /chat/completions endpoint, so we pass `tools` and read `message.tool_calls`
 * instead. The system prompt shrinks to persona + strategy; the *schema* is
 * the contract, and it is enforced structurally by the API, not by prompting.
 *
 * Design notes:
 *   - Same discipline as ../src/amdClient.js: Bearer auth, exponential backoff
 *     with jitter (429/5xx), timeout via AbortController, secrets redacted
 *     from every error/log path, serialized in-flight (one call at a time).
 *   - KV-cache economy is preserved: byte-identical system prompt, small
 *     delta user message, cached-token accounting exposed via getStats().
 *   - Tolerant fallback: if the endpoint ignores `tools` and answers with raw
 *     JSON content (legacy shape {"a":"say","t":"..."} OR a fenced blob), we
 *     parse it and count it as a `jsonFallback`. This keeps the bot alive on
 *     misconfigured proxies without weakening the primary path.
 *   - Tool names/arguments are mapped back to the harness's internal action
 *     shape (single-letter legacy fields) by coerceAction() so the action
 *     switch in index.js stays stable and unit-testable.
 *
 * SECURITY: the key is stored privately, never logged, and scrubbed from any
 * string that might carry it.
 */
'use strict'

const { parseUsage, redactSecrets } = require('../src/amdClient')
const logger = require('../src/logger')

const TAG = 'amd'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const backoffMs = (attempt) => Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)

// ---------------------------------------------------------------------------
// Tool schemas — the single source of truth for the System-2 action contract.
// Keep descriptions terse: every token here is re-sent on every call.
// ---------------------------------------------------------------------------
const STR = (description) => ({ type: 'string', description })
const INT = (description) => ({ type: 'integer', description })
const STAGE = STR('Build phase: foundation | walls_with_windows | roof | interior_details. One phase per call; re-runs are idempotent.')
const AT = { type: 'array', description: 'Absolute [x,y,z] origin; default: bot feet.', items: { type: 'integer' }, minItems: 3, maxItems: 3 }
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } })

const ACTION_TOOLS = [
  tool('say', 'Say one short chat line. Set `to` for a private message to one player.', {
    text: STR('Plain text, max 200 chars, in the language the players use.'),
    to: STR('Player name for a private message (optional).')
  }, ['text']),
  tool('go_to', 'Walk somewhere: a player, a remembered place or a listed id (chest2, bed1), or coordinates. You are told when you arrive or fail.', {
    player: STR('Player name.'),
    place: STR('Remembered place name or an id from "nearby".'),
    x: INT('X coordinate.'),
    y: INT('Y coordinate (optional).'),
    z: INT('Z coordinate.')
  }),
  tool('follow', 'Follow a player until you call stop or another movement.', { player: STR('Player name.') }, ['player']),
  tool('stop', 'Stop the current task, follow or fight and stand still.'),
  tool('attack', 'Fight. The ONLY way a fight ever starts. `target` = exact mob type ("zombie") or "any" hostile mob. `player` = exact player name — PvP only on your explicit decision (a duel they asked for, or someone who keeps hitting you).', {
    target: STR('Mob type, or "any".'),
    player: STR('Exact player name (PvP).')
  }),
  tool('hold', 'Stay put and stop fleeing from the threats listed now (they are harmless or you accept the risk). New threats make you flee again.'),
  tool('look_in', 'Open a container and read its contents. Empty `where` = nearest.', { where: STR('Id from "nearby" (chest2), a label, or empty.') }),
  tool('take', 'Take items from a container, or the output of a furnace.', {
    item: STR('Item id, e.g. "diamond".'),
    count: INT('How many (default: all).'),
    where: STR('Container id or label (default: nearest that has it).')
  }, ['item']),
  tool('put', 'Put carried items into a container.', {
    item: STR('Item id.'),
    count: INT('How many (default: all).'),
    where: STR('Container id or label (default: nearest).')
  }, ['item']),
  tool('smelt', 'Load the nearest furnace with an item (fuel is added from your inventory) and walk away. Collect later with take.', {
    item: STR('Item id to smelt.'),
    count: INT('How many (default: all).'),
    where: STR('Furnace id (default: nearest).')
  }, ['item']),
  tool('sleep', 'Sleep in the nearest bed (night or thunderstorm only).'),
  tool('give', 'Walk to a player and toss them an item.', {
    player: STR('Player name.'),
    item: STR('Item id.'),
    count: INT('How many (default 1).')
  }, ['player', 'item']),
  tool('eat', 'Eat now. Empty `item` = best safe food carried. (Hunger is normally handled by reflex.)', { item: STR('Item id (optional).') }),
  tool('equip', 'Equip a carried item by name.', {
    item: STR('Item id.'),
    where: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }
  }, ['item']),
  tool('use_block', 'Walk to the nearest block of this name and right-click it (door, gate, lever, button, bell).', { what: STR('Block id.') }, ['what']),
  tool('find', 'Where is a block type, or which opened container holds an item?', { what: STR('Block or item id.') }, ['what']),
  tool('remember_here', 'Save the current position under a name (home, mina, casa do Gabriel).', {
    name: STR('Place name.'),
    note: STR('Optional note.')
  }, ['name']),
  tool('craft', 'Craft an item from the 2x2/3x3 grid if materials are available.', { item: STR('Item id, e.g. "crafting_table".') }, ['item']),
  tool('build', 'Build a stored blueprint or an inline grid. Prefer build_shape for large/simple geometry.', {
    blueprint: STR('Name of a file in zincai/blueprints/ (without .json).'),
    grid: { type: 'array', description: 'Inline 3D layers (bottom-to-top), each layer an array of rows of chars; "." is air.', items: { type: 'array', items: { type: 'string' } } },
    at: AT,
    stage: STAGE
  }),
  tool('build_shape', 'Mathematically generate and build a geometric primitive — never place big builds by hand.', {
    shape: { type: 'string', enum: ['cylinder', 'dome', 'arch', 'wall', 'box', 'floor', 'ring'] },
    params: { type: 'object', description: 'Shape params: cylinder {r,h}; dome {r}; arch {w,h}; wall {l,h,axis}; box {l,w,h}; floor {l,w}; ring {r}.' },
    block: STR('Block id, e.g. "stone_bricks".'),
    at: AT,
    stage: STAGE
  }, ['shape', 'block']),
  tool('run_script', 'Run a saved automation script from zincai/scripts/ (e.g. build_tower).', { name: STR('Script name.') }, ['name']),
  tool('set_mode', 'Switch movement mode: builder (no sprint, no drops), hunter (sprint + jump-run), explorer (default).', {
    mode: { type: 'string', enum: ['builder', 'hunter', 'explorer'] }
  }, ['mode']),
  tool('idle', 'Do nothing this turn. While threats are listed this means: keep fleeing.')
]

/** The chat lane has exactly one tool: answer, and optionally hand over a task. */
const CHAT_TOOLS = [
  tool('reply', 'Answer the player. Leave `text` empty to stay silent.', {
    text: STR('One short chat line in the player\'s language. Empty = say nothing.'),
    task: STR('Only when the player asked you to DO something in the game: a short imperative for your body, e.g. "go to Gabriel", "bring Gabriel 3 diamonds from the chest". Otherwise omit.')
  }, ['text'])
]

const toOpenAi = (list) => list.map((t) => ({ type: 'function', function: JSON.parse(JSON.stringify(t)) }))

/** OpenAI-format tools array. Cloned so callers may not mutate the source. */
function createZincTools () { return toOpenAi(ACTION_TOOLS) }
function createChatTools () { return toOpenAi(CHAT_TOOLS) }

/**
 * Map tool args -> the harness's internal action shape. Arguments keep their
 * own names; the single-letter fields are legacy aliases for older call sites.
 */
const ARG_LEGACY = {
  say: (a) => ({ ...a, t: a.text }),
  craft: (a) => ({ ...a, i: a.item }),
  attack: (a) => ({ ...a, n: a.player ? undefined : (a.target ?? a.name) })
}

function parseToolCall (call, known) {
  const name = String(call?.function?.name || '')
  if (!known.some((t) => t.name === name)) {
    logger.warn(TAG, `unknown tool call "${name}" — ignoring`)
    return { error: 'unknown', name }
  }
  try {
    const rawArgs = call?.function?.arguments
    let args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {})
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
    return { name, args }
  } catch (err) {
    logger.warn(TAG, `malformed tool arguments for ${name}: ${err.message}`)
    return { error: 'args', name }
  }
}

/**
 * Normalize one model message into an internal action object `{a, ...args}`.
 * Never throws — any failure yields {a:'idle'} plus a marker saying why, so
 * the executor can tell the model its answer did nothing.
 * @param {object} message choices[0].message from the completion
 * @param {boolean} strict when true (default) unknown/broken calls become idle
 */
function coerceAction (message, strict = true) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (toolCalls.length > 0) {
    const parsed = parseToolCall(toolCalls[0], ACTION_TOOLS)
    if (parsed.error === 'unknown') return strict ? { a: 'idle', _unknownTool: parsed.name } : null
    if (parsed.error === 'args') return strict ? { a: 'idle', _badArgs: parsed.name } : null
    const { name, args } = parsed
    const mapped = ARG_LEGACY[name] ? ARG_LEGACY[name](args) : { ...args }
    return { a: name, ...mapped, _via: 'tool' }
  }

  // Fallback: endpoint ignored `tools` and answered with plain content —
  // recover the legacy single-line JSON contract rather than crash.
  const content = typeof message?.content === 'string' ? message.content : ''
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content)
  const s = (fence ? fence[1] : content).trim()
  const line = s.split('\n').find((l) => l.trim().startsWith('{')) || s
  try {
    const obj = JSON.parse(line.trim())
    if (obj && typeof obj === 'object' && typeof obj.a === 'string') {
      // Legacy {"a":"move"} is today's go_to.
      if (obj.a === 'move') obj.a = 'go_to'
      return { ...obj, _via: 'json-fallback' }
    }
  } catch { /* fall through */ }
  if (content) logger.warn(TAG, `model answered in prose without a tool call: ${content.slice(0, 120)}`)
  // Prose used to vanish silently. Keep it so the caller can report it back.
  return strict ? { a: 'idle', _fallback: true, ...(content.trim() ? { _prose: content.trim().slice(0, 300) } : {}) } : null
}

/**
 * Normalize a chat-lane message into { text, task }. Prose without a tool
 * call is taken as the reply itself — in a chat lane that is what it is.
 */
function coerceReply (message) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (toolCalls.length > 0) {
    const parsed = parseToolCall(toolCalls[0], CHAT_TOOLS)
    if (!parsed.error) {
      return { text: String(parsed.args.text ?? '').trim(), task: String(parsed.args.task ?? '').trim(), _via: 'tool' }
    }
  }
  const content = typeof message?.content === 'string' ? message.content.trim() : ''
  // Some models wrap the answer in quotes or prefix their own name.
  const text = content.replace(/^["'“”]+|["'“”]+$/g, '').replace(/^(zinc(ai)?|me)\s*:\s*/i, '').split('\n')[0].trim()
  return { text, task: '', _via: 'prose' }
}

/**
 * Pure: build the request body. Exported for tests.
 *
 * tool_choice is "required" by default: with "auto" a model that answered in
 * prose produced an idle turn and nobody was told. Endpoints that reject
 * "required" are handled in the client (it falls back to "auto" once).
 */
function buildToolsPayload ({ model, messages, temperature, maxTokens, tools, toolChoice = 'required' }) {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: false
  }
}

class AmdToolsClient {
  /**
   * Drop-in replacement for AmdClient at the call site, with the same
   * constructor contract and the same getStats() shape (plus tool metrics).
   */
  constructor ({ apiKey, baseUrl, model, timeoutMs = 20_000, maxRetries = 2, temperature = 0.25, maxTokens = 256, toolChoice = 'required' }) {
    if (!apiKey) {
      // Never include the (missing) key in the error — only the variable name.
      throw new Error('AMD API key missing: set AMD_API_KEY (or API_KEY) in .env')
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.temperature = temperature
    this.maxTokens = maxTokens
    this._apiKey = String(apiKey)

    this.stats = {
      requests: 0,
      failures: 0,
      retries: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      callsWithCacheInfo: 0,
      toolCalls: 0,
      jsonFallbacks: 0,
      unknownToolCalls: 0,
      chatReplies: 0
    }
    this.toolChoice = toolChoice
    this._chain = Promise.resolve()
  }

  async _fetchWithTimeout (url, options, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * One request, retried on 429/5xx/timeouts, serialised against every other
   * call of this client (two lanes share one endpoint and one rate limit).
   * @returns {Promise<{message:object, usage:object, raw:object}>}
   */
  async _complete ({ messages, tools, maxTokens = this.maxTokens, temperature = this.temperature }) {
    const run = () => this._completeNow({ messages, tools, maxTokens, temperature })
    const next = this._chain.then(run, run)
    this._chain = next.then(() => {}, () => {})
    return next
  }

  async _completeNow ({ messages, tools, maxTokens, temperature }) {
    const url = `${this.baseUrl}/chat/completions`
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mineflayer-zincai/3.0'
    }

    let attempt = 0
    let lastError = null
    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        this.stats.retries += 1
        await sleep(backoffMs(attempt - 1))
      }
      attempt += 1
      this.stats.requests += 1
      const payload = buildToolsPayload({ model: this.model, messages, temperature, maxTokens, tools, toolChoice: this.toolChoice })
      try {
        const res = await this._fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, this.timeoutMs)

        if (res.status === 429 || res.status >= 500) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 200), this._apiKey)
          lastError = new Error(`HTTP ${res.status}: ${snippet}`)
          logger.warn(TAG, `retryable HTTP ${res.status} (attempt ${attempt}/${this.maxRetries + 1})`)
          continue
        }

        if (!res.ok) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 300), this._apiKey)
          // Some OpenAI-compatible servers only know tool_choice "auto"/"none".
          if (res.status === 400 && this.toolChoice === 'required' && /tool_choice|required/i.test(snippet)) {
            logger.warn(TAG, 'endpoint rejected tool_choice "required" — falling back to "auto" for this session')
            this.toolChoice = 'auto'
            attempt -= 1 // not the model's fault: do not burn a retry
            continue
          }
          this.stats.failures += 1
          throw new Error(`HTTP ${res.status}: ${snippet}`)
        }

        const data = await res.json()
        const message = data?.choices?.[0]?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          this.stats.failures += 1
          throw new Error('Malformed response: choices[0].message has neither content nor tool_calls')
        }
        const usage = parseUsage(data?.usage)
        if (usage.promptTokens !== null) {
          this.stats.promptTokens += usage.promptTokens
          this.stats.completionTokens += usage.completionTokens || 0
          if (usage.cachedTokens !== null) {
            this.stats.cachedTokens += usage.cachedTokens
            this.stats.callsWithCacheInfo += 1
          }
        }
        return { message, usage, raw: data }
      } catch (err) {
        const isAbort = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))
        const isNetwork = err instanceof TypeError
        if (isAbort || isNetwork) {
          lastError = new Error(redactSecrets(err.message || String(err), this._apiKey))
          logger.warn(TAG, `retryable ${isAbort ? 'timeout' : 'network'} error (attempt ${attempt}/${this.maxRetries + 1})`)
          continue
        }
        throw err
      }
    }

    this.stats.failures += 1
    throw lastError || new Error('AMD request failed after retries')
  }

  /**
   * One tool-enabled completion for the ACTION lane.
   * @param {{role:string, content:string}[]} messages
   * @param {object[]} tools OpenAI-format tools (see createZincTools)
   * @returns {Promise<{action:object, content:string, usage:object, raw:object}>}
   */
  async chatWithTools (messages, tools = createZincTools()) {
    const { message, usage, raw } = await this._complete({ messages, tools })
    const action = coerceAction(message)
    if (action._via === 'tool') this.stats.toolCalls += 1
    else if (action._fallback || action._badArgs) this.stats.jsonFallbacks += 1
    if (action._unknownTool) this.stats.unknownToolCalls += 1
    return { action, content: typeof message.content === 'string' ? message.content.trim() : '', usage, raw }
  }

  /**
   * One completion for the CHAT lane: a short reply, optionally a task for
   * the action lane.
   * @returns {Promise<{reply:{text:string, task:string}, usage:object}>}
   */
  async chatReply (messages, { maxTokens = 120 } = {}) {
    const { message, usage } = await this._complete({ messages, tools: createChatTools(), maxTokens, temperature: Math.max(this.temperature, 0.5) })
    this.stats.chatReplies += 1
    return { reply: coerceReply(message), usage }
  }

  /** Telemetry compatible with the v1 session report + tool metrics. */
  getStats () {
    const s = this.stats
    const hitRate = s.cachedTokens > 0 && s.promptTokens > 0 ? s.cachedTokens / s.promptTokens : null
    return {
      ...s,
      avgPromptTokensPerCall: s.requests ? Math.round(s.promptTokens / s.requests) : 0,
      avgCompletionTokensPerCall: s.requests ? Math.round(s.completionTokens / s.requests) : 0,
      kvCacheHitRate: hitRate,
      uptimeMinutes: Math.round((Date.now() - this._startedAt) / 60_000) || 0
    }
  }

  _startedAt = Date.now()
}

module.exports = { AmdToolsClient, createZincTools, createChatTools, coerceAction, coerceReply, buildToolsPayload, ACTION_TOOLS, CHAT_TOOLS }
