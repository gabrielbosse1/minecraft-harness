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
const ACTION_TOOLS = [
  {
    name: 'say',
    description: 'Send a short chat line to nearby players.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Plain text, max 200 chars. No JSON, no markup.' } },
      required: ['text']
    }
  },
  {
    name: 'move',
    description: 'Walk to a position. Use when a task needs the bot elsewhere.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }
      },
      required: ['x', 'y', 'z']
    }
  },
  {
    name: 'build',
    description: 'Build a stored blueprint or an inline grid. Prefer build_shape for large/simple geometry.',
    parameters: {
      type: 'object',
      properties: {
        blueprint: { type: 'string', description: 'Name of a file in zincai/blueprints/ (without .json).' },
        grid: { type: 'array', description: 'Inline 3D layers (bottom-to-top), each layer an array of rows of chars; "." is air.', items: { type: 'array', items: { type: 'string' } } },
        at: { type: 'array', description: 'Absolute [x,y,z] origin; default: bot feet.', items: { type: 'integer' }, minItems: 3, maxItems: 3 },
        stage: { type: 'string', description: 'Hierarchical stage label: foundation | walls | roof | detailing.' }
      }
    }
  },
  {
    name: 'build_shape',
    description: 'Mathematically generate and build a geometric primitive — never place big builds by hand.',
    parameters: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['cylinder', 'dome', 'arch', 'wall', 'box', 'floor', 'ring'] },
        params: { type: 'object', description: 'Shape params: cylinder {r,h}; dome {r}; arch {w,h}; wall {l,h,axis}; box {l,w,h}; floor {l,w}; ring {r}.' },
        block: { type: 'string', description: 'Block id, e.g. "stone_bricks".' },
        at: { type: 'array', description: 'Absolute [x,y,z] origin; default: bot feet.', items: { type: 'integer' }, minItems: 3, maxItems: 3 },
        stage: { type: 'string', description: 'Hierarchical stage label: foundation | walls | roof | detailing.' }
      },
      required: ['shape', 'block']
    }
  },
  {
    name: 'run_script',
    description: 'Run a saved automation script from zincai/scripts/ (e.g. build_tower, flee).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'set_mode',
    description: 'Switch movement mode: builder (safe, no drops), hunter (sprint + jump-run), explorer (default).',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['builder', 'hunter', 'explorer'] } },
      required: ['mode']
    }
  },
  {
    name: 'craft',
    description: 'Craft an item from the 2x2/3x3 grid if materials are available.',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string', description: 'Item id, e.g. "crafting_table".' } },
      required: ['item']
    }
  },
  {
    name: 'attack',
    description: 'Deliberately engage a named hostile/player with the combat AI. Reflex combat (players within 15 m) is handled by System 1 automatically.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Entity name, e.g. "zombie".' } },
      required: ['name']
    }
  },
  {
    name: 'equip',
    description: 'Equip the Nth item in the inventory to the main hand.',
    parameters: {
      type: 'object',
      properties: { slot: { type: 'integer', minimum: 0 } },
      required: ['slot']
    }
  },
  {
    name: 'idle',
    description: 'Do nothing this turn. Prefer this over inventing work.',
    parameters: { type: 'object', properties: {} }
  }
]

/** OpenAI-format tools array. Cloned so callers may not mutate the source. */
function createZincTools () {
  return ACTION_TOOLS.map((t) => ({ type: 'function', function: JSON.parse(JSON.stringify(t)) }))
}

/** Map tool args -> the harness's internal (legacy single-letter) action shape. */
const ARG_LEGACY = {
  say: (a) => ({ t: a.text }),
  craft: (a) => ({ i: a.item }),
  attack: (a) => ({ n: a.name }),
  equip: (a) => ({ s: a.slot })
}

/**
 * Normalize one model message into an internal action object `{a, ...args}`.
 * Never throws — any failure yields {a:'idle'} and a warning.
 * @param {object} message choices[0].message from the completion
 * @param {boolean} strict when true (default) unknown/broken calls become idle
 */
function coerceAction (message, strict = true) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (toolCalls.length > 0) {
    const call = toolCalls[0]
    const name = String(call?.function?.name || '')
    const known = ACTION_TOOLS.some((t) => t.name === name)
    if (!known) {
      logger.warn(TAG, `unknown tool call "${name}" — ignoring`)
      return strict ? { a: 'idle', _unknownTool: name } : null
    }
    let args = {}
    try {
      const rawArgs = call?.function?.arguments
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {})
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
    } catch (err) {
      logger.warn(TAG, `malformed tool arguments for ${name}: ${err.message}`)
      return strict ? { a: 'idle', _badArgs: name } : null
    }
    const legacy = ARG_LEGACY[name] ? ARG_LEGACY[name](args) : { ...args }
    return { a: name, ...legacy, _via: 'tool' }
  }

  // Fallback: endpoint ignored `tools` and answered with plain content —
  // recover the legacy single-line JSON contract rather than crash.
  const content = typeof message?.content === 'string' ? message.content : ''
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content)
  const s = (fence ? fence[1] : content).trim()
  const line = s.split('\n').find((l) => l.trim().startsWith('{')) || s
  try {
    const obj = JSON.parse(line.trim())
    if (obj && typeof obj === 'object' && typeof obj.a === 'string') return { ...obj, _via: 'json-fallback' }
  } catch { /* fall through */ }
  if (content) logger.warn(TAG, `unparseable model reply: ${content.slice(0, 120)}`)
  return strict ? { a: 'idle', _fallback: true } : null
}

/** Pure: build the request body. Exported for tests. */
function buildToolsPayload ({ model, messages, temperature, maxTokens, tools }) {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false
  }
}

class AmdToolsClient {
  /**
   * Drop-in replacement for AmdClient at the call site, with the same
   * constructor contract and the same getStats() shape (plus tool metrics).
   */
  constructor ({ apiKey, baseUrl, model, timeoutMs = 20_000, maxRetries = 2, temperature = 0.25, maxTokens = 256 }) {
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
      unknownToolCalls: 0
    }
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
   * One tool-enabled chat completion. Serialized by the caller.
   * @param {{role:string, content:string}[]} messages
   * @param {object[]} tools OpenAI-format tools (see createZincTools)
   * @returns {Promise<{action:object, content:string, usage:object, raw:object}>}
   */
  async chatWithTools (messages, tools = createZincTools()) {
    const payload = buildToolsPayload({
      model: this.model,
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      tools
    })
    const url = `${this.baseUrl}/chat/completions`
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mineflayer-zincai/2.0'
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
          this.stats.failures += 1
          throw new Error(`HTTP ${res.status}: ${snippet}`)
        }

        const data = await res.json()
        const message = data?.choices?.[0]?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          this.stats.failures += 1
          throw new Error('Malformed response: choices[0].message has neither content nor tool_calls')
        }

        const action = coerceAction(message)
        if (action._via === 'tool') this.stats.toolCalls += 1
        else if (action._fallback || action._badArgs) this.stats.jsonFallbacks += 1
        if (action._unknownTool) this.stats.unknownToolCalls += 1

        const usage = parseUsage(data?.usage)
        if (usage.promptTokens !== null) {
          this.stats.promptTokens += usage.promptTokens
          this.stats.completionTokens += usage.completionTokens || 0
          if (usage.cachedTokens !== null) {
            this.stats.cachedTokens += usage.cachedTokens
            this.stats.callsWithCacheInfo += 1
          }
        }
        return { action, content: typeof message.content === 'string' ? message.content.trim() : '', usage, raw: data }
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

module.exports = { AmdToolsClient, createZincTools, coerceAction, buildToolsPayload, ACTION_TOOLS }
