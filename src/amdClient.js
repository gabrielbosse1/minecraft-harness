/**
 * AMD Radeon Cloud client — OpenAI-compatible Chat Completions.
 *
 * Endpoint:  POST {AMD_API_BASE_URL}/chat/completions   (default:
 *            https://developer.amd.com.cn/radeon/api/v1 — the Token Factory
 *            shared endpoint, served from AMD Radeon GPUs).
 * Auth:      Authorization: Bearer $API_KEY   (rc-... keys sent as-is, per spec)
 *
 * KV cache / token-economy strategy (the reason this harness exists):
 *   - The system prompt is byte-identical on every call (zincai/system_prompt.txt);
 *     Radeon Cloud / DeepSeek prefix-cache the longest shared prefix, so after
 *     the first call the ~110-word system prefix is billed as cache hits.
 *   - The user message is ~30-60 tokens of deltas. Nothing else is sent.
 *   - max_tokens=96 and temperature=0.25: one JSON action line, deterministic.
 *   - Usage counters (incl. cached_tokens) are tracked every call and exposed
 *     via getStats(); the agent logs a rolling cache hit rate periodically.
 *
 * Free-tier etiquette (shared endpoint, ~20 RPM, daily points budget):
 *   - in-flight requests are never fired concurrently (the agent serializes),
 *   - 429/5xx get exponential backoff with jitter (2 retries by default),
 *   - non-retryable errors (4xx auth/schema) fail immediately and loudly.
 *
 * SECURITY: the key is accepted in the constructor, stored privately, and
 * redacted from every error/log path that could carry it.
 */
'use strict'

const logger = require('./logger')

const TAG = 'amd'

/** Redact anything that looks like our API key material before logging. */
function redactSecrets (s, literalKey) {
  let out = String(s)
  out = out.replace(/rc-[A-Za-z0-9_-]{4,}/g, 'rc-[redacted]')
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  if (literalKey) {
    out = out.split(String(literalKey)).join('[redacted]')
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const backoffMs = (attempt) => Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)

// Statuses that indicate a transient server/rate-limit fault and MAY be retried.
// 501 Not Implemented (e.g. unsupported model or endpoint feature) is NOT here:
// it is permanent for this endpoint, not a transient fault.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parse an HTTP `Retry-After` header into a wait duration in ms.
 * Accepts a delay in seconds or an HTTP-date. Returns null when absent or
 * unparseable. The result is clamped to [1s, 60s] so a misbehaving endpoint
 * cannot stall the client forever or turn a 429 into a near-instant retry.
 */
function parseRetryAfter (headerValue) {
  if (!headerValue) return null
  const raw = String(headerValue).trim()
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.round(secs * 1000)))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, at - Date.now()))
  return null
}

/** Redact anything that looks like our API key material before logging. */

/** Pure: build the request body. Exported for tests. */
function buildChatPayload ({ model, messages, temperature, maxTokens }) {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false
  }
}

/**
 * Pure: normalize usage accounting across the shapes different OpenAI-compatible
 * backends emit. DeepSeek-style: prompt_cache_hit_tokens / prompt_cache_miss_tokens.
 * OpenAI-style:  prompt_tokens_details.cached_tokens. Anthropic-style: cache_read_input_tokens.
 * Exported for tests.
 */
function parseUsage (u) {
  if (!u || typeof u !== 'object') {
    return { promptTokens: null, completionTokens: null, cachedTokens: null, hitRate: null }
  }
  const prompt = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens
    : (Number.isFinite(u.input_tokens) ? u.input_tokens : null)
  const completion = Number.isFinite(u.completion_tokens) ? u.completion_tokens
    : (Number.isFinite(u.output_tokens) ? u.output_tokens : null)
  let cached = null
  if (Number.isFinite(u.prompt_cache_hit_tokens)) cached = u.prompt_cache_hit_tokens
  else if (u.prompt_tokens_details && Number.isFinite(u.prompt_tokens_details.cached_tokens)) cached = u.prompt_tokens_details.cached_tokens
  else if (Number.isFinite(u.cache_read_input_tokens)) cached = u.cache_read_input_tokens
  else if (Number.isFinite(u.cached_tokens)) cached = u.cached_tokens
  const hitRate = cached !== null && prompt ? cached / prompt : null
  return { promptTokens: prompt, completionTokens: completion, cachedTokens: cached, hitRate }
}

class AmdClient {
  /**
   * @param {{apiKey:string, baseUrl:string, model:string, timeoutMs?:number,
   *          maxRetries?:number, temperature?:number, maxTokens?:number}} opts
   */
  constructor ({ apiKey, baseUrl, model, timeoutMs = 20_000, maxRetries = 2, temperature = 0.25, maxTokens = 96 }) {
    if (!apiKey) {
      // Fail fast, before we ever create a bot. Never include the (missing)
      // key in the error — only the variable name.
      throw new Error('AMD API key missing: set AMD_API_KEY (or API_KEY / RADEON_API_KEY)')
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.temperature = temperature
    this.maxTokens = maxTokens
    this._apiKey = String(apiKey) // private by convention; never exposed

    this.stats = {
      requests: 0,
      failures: 0,
      retries: 0,
      timeouts: 0,
      rateWaits: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      callsWithCacheInfo: 0
    }
  }

  async _fetchWithTimeout (url, options, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (err) {
      // Tag the cause so the retry loop can say "timeout" only when OUR
      // deadline rang: a network abort is not a slow endpoint, and logging it
      // as one sends operators looking in the wrong place.
      if (err && typeof err === 'object' && controller.signal.aborted) err.zincaiTimedOut = true
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * One chat completion. Serialized by the caller — never called concurrently.
   * @param {{role:string, content:string}[]} messages
   * @returns {Promise<{content:string, usage:object, raw:object}>}
   */
  async chatCompletion (messages) {
    const payload = buildChatPayload({
      model: this.model,
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens
    })
    const url = `${this.baseUrl}/chat/completions`
    const headers = {
      // rc-... keys are sent verbatim as the Bearer token, exactly as AMD documents.
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mineflayer-zinc-agent/1.0'
    }

    let attempt = 0
    let lastError = null
    let lastRetryAfterMs = null // Retry-After owed from the previous attempt's 429/503
    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        this.stats.retries += 1
        // Exactly one wait between attempts: honor the server's Retry-After when
        // it gave one (rate limits must not turn into request storms), otherwise
        // exponential backoff with jitter. The original request payload is
        // rebuilt identically on every attempt — conversation context and model
        // configuration are preserved across retries.
        await sleep(lastRetryAfterMs ?? backoffMs(attempt - 1))
        lastRetryAfterMs = null
      }
      attempt += 1
      this.stats.requests += 1
      try {
        const res = await this._fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, this.timeoutMs)

        // Retryable: rate limiting and transient server faults (500/502/503/504).
        // A successful status is never retried: the model already answered, so
        // repeating could execute the same tool call twice.
        if (RETRYABLE_STATUS.has(res.status)) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 200), this._apiKey)
          lastError = new Error(`HTTP ${res.status}: ${snippet}`)
          const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'))
          if (retryAfterMs) {
            this.stats.rateWaits += 1
            lastRetryAfterMs = retryAfterMs
            logger.warn(TAG, `retryable HTTP ${res.status} (Retry-After ${Math.round(retryAfterMs / 1000)}s) (attempt ${attempt}/${this.maxRetries + 1})`)
          } else {
            logger.warn(TAG, `retryable HTTP ${res.status} (attempt ${attempt}/${this.maxRetries + 1})`)
          }
          continue
        }

        // Non-retryable: 4xx (invalid key, malformed request, unsupported
        // model) and any 5xx outside the retryable set (e.g. 501). Fail
        // immediately and loudly — retrying cannot fix these.
        if (!res.ok) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 300), this._apiKey)
          this.stats.failures += 1
          throw new Error(`HTTP ${res.status}: ${snippet}`)
        }

        const data = await res.json()
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          this.stats.failures += 1
          throw new Error('Malformed response: choices[0].message.content missing')
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
        return { content: content.trim(), usage, raw: data }
      } catch (err) {
        // Timeouts and network errors are retryable; everything above already accounted for.
        const isAbort = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))
        const isNetwork = err instanceof TypeError // fetch network failures
        if (isAbort || isNetwork) {
          lastError = new Error(redactSecrets(err.message || String(err), this._apiKey))
          if (err?.zincaiTimedOut) {
            this.stats.timeouts += 1
            // Say which deadline rang and for how long, so a retry burst reads as one event.
            logger.warn(TAG, `retryable timeout: no response within ${Math.round(this.timeoutMs / 1000)}s (attempt ${attempt}/${this.maxRetries + 1})`)
          } else {
            logger.warn(TAG, `retryable ${isAbort ? 'timeout' : 'network'} error (attempt ${attempt}/${this.maxRetries + 1})`)
          }
          continue
        }
        throw err
      }
    }

    this.stats.failures += 1
    const message = lastError
      ? `AMD request failed after ${attempt} attempt(s); last error: ${lastError.message}`
      : `AMD request failed after ${attempt} attempt(s)`
    throw new Error(message)
  }

  /** Rolling telemetry for the cache-hit report. */
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

module.exports = { AmdClient, parseUsage, buildChatPayload, redactSecrets }
