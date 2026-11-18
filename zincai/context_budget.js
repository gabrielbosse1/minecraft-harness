/**
 * zincai/context_budget.js — model token-limit resolution, headroom budgeting,
 * usage calibration, and tiered memory-preserving prompt compaction.
 *
 * Design principles:
 *   1. Standard model limits by default: never invent arbitrary low output caps
 *      when the user has not configured one. Resolve verified model limits from
 *      our catalog, live `/models` discovery, and HTTP 400 limit-error learning.
 *   2. Proactive compaction with headroom: reserve enough room for the model's
 *      output + reasoning tokens (and a safety margin) and start compacting
 *      BEFORE hitting the context limit.
 *   3. Reactive compaction & graceful degradation: if a call still truncates
 *      (`finish_reason: "length"`) or overflows context (HTTP 400), step up
 *      compaction tiers and escalate output headroom safely within the window.
 *   4. Memory preservation: trim transient world bloat (3D ASCII grids, verbose
 *      tool outputs, old images, ambient diffs, noisy chat tails) FIRST, while
 *      keeping memories, player facts, active goals, threats, and the immediate
 *      trigger intact as long as possible.
 */
'use strict'

/**
 * Verified native model limits (contextWindow + maxOutputTokens).
 * Matched against normalized model IDs (case-insensitive, vendor prefix stripped).
 * Sources: vendor model cards (Qwen3.8-27B / Qwen3.8-Flash-Next: 262,144 ctx /
 * 131,072 output, reasoning enabled by default; Qwen3: 131,072 / 32,768;
 * DeepSeek-R1: 128k / 32k; Llama 3.1-3.3: 131,072 / 16,384; GPT-4o / Claude /
 * Gemini standard specs).
 */
const MODEL_LIMIT_CATALOG = [
  { re: /qwen3[._-]?8[._-]?27b/i, contextWindow: 262_144, maxOutputTokens: 131_072, reasoning: true, family: 'qwen3.8-27b' },
  { re: /qwen3[._-]?8[._-]?flash/i, contextWindow: 262_144, maxOutputTokens: 131_072, reasoning: true, family: 'qwen3.8-flash' },
  { re: /qwen3[._-]?8/i, contextWindow: 262_144, maxOutputTokens: 131_072, reasoning: true, family: 'qwen3.8' },
  { re: /qwen3[._-]?5/i, contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true, family: 'qwen3.5' },
  { re: /qwen3/i, contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true, family: 'qwen3' },
  { re: /qwen2[._-]?5/i, contextWindow: 131_072, maxOutputTokens: 8_192, reasoning: false, family: 'qwen2.5' },
  { re: /qwq/i, contextWindow: 131_072, maxOutputTokens: 32_768, reasoning: true, family: 'qwq' },
  { re: /deepseek[._-]?(r1|reasoner)/i, contextWindow: 128_000, maxOutputTokens: 32_768, reasoning: true, family: 'deepseek-r1' },
  { re: /deepseek/i, contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false, family: 'deepseek' },
  { re: /llama[._-]?4/i, contextWindow: 262_144, maxOutputTokens: 16_384, reasoning: false, family: 'llama-4' },
  { re: /llama[._-]?3[._-]?[123]/i, contextWindow: 131_072, maxOutputTokens: 16_384, reasoning: false, family: 'llama-3' },
  { re: /gpt-4\.1/i, contextWindow: 1_000_000, maxOutputTokens: 32_768, reasoning: false, family: 'gpt-4.1' },
  { re: /gpt-4o/i, contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false, family: 'gpt-4o' },
  { re: /\bo[134]([-_.]|$)/i, contextWindow: 200_000, maxOutputTokens: 100_000, reasoning: true, family: 'o-series' },
  { re: /claude/i, contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true, family: 'claude' },
  { re: /gemini/i, contextWindow: 1_000_000, maxOutputTokens: 65_536, reasoning: true, family: 'gemini' }
]

const DEFAULT_MODEL_LIMITS = Object.freeze({
  contextWindow: 128_000,
  maxOutputTokens: 32_768,
  reasoning: false,
  family: 'generic',
  source: 'default'
})

function positiveInt (v, min = 1, max = 10_000_000) {
  if (v === undefined || v === null || v === '') return null
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

/**
 * Resolve verified standard limits for a model identifier.
 * @param {string} model
 * @returns {{contextWindow:number, maxOutputTokens:number, reasoning:boolean, family:string, source:string}}
 */
function resolveModelLimits (model) {
  const raw = String(model || '').trim()
  const base = raw.includes('/') ? raw.split('/').pop() : raw
  for (const entry of MODEL_LIMIT_CATALOG) {
    if (entry.re.test(raw) || entry.re.test(base)) {
      return {
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        reasoning: entry.reasoning,
        family: entry.family,
        source: 'catalog'
      }
    }
  }
  // Recognize this configured vision model without claiming unverified vendor
  // limits; keep the same conservative generic budget until live metadata or
  // an endpoint limit error supplies authoritative numbers.
  if (/minicpm[-_.]?v[-_.]?4[._-]?7/i.test(raw) || /minicpm[-_.]?v[-_.]?4[._-]?7/i.test(base)) {
    return { ...DEFAULT_MODEL_LIMITS, family: 'minicpm-v-4.7', source: 'default' }
  }
  return { ...DEFAULT_MODEL_LIMITS }
}

/**
 * Extract character count and image count from OpenAI-shaped messages.
 * @param {Array<object>} messages
 * @returns {{chars:number, images:number, messageCount:number}}
 */
function measureMessages (messages) {
  let chars = 0
  let images = 0
  const list = Array.isArray(messages) ? messages : []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'text' && typeof part.text === 'string') chars += part.text.length
        else if (part.type === 'image_url') images += 1
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        chars += String(tc?.function?.name || '').length
        chars += String(tc?.function?.arguments || '').length + 24
      }
    }
    if (m.name) chars += String(m.name).length
  }
  return { chars, images, messageCount: list.length }
}

function measureTools (tools) {
  if (!Array.isArray(tools) || !tools.length) return 0
  try { return JSON.stringify(tools).length } catch { return 0 }
}

/**
 * Parse endpoint error text for context-window / output-limit rejections and
 * unsupported parameter rejections (e.g. reasoning_effort on strict proxies).
 */
function parseLimitError (text) {
  const s = String(text || '')
  const low = s.toLowerCase()

  let learnedContext = null
  const ctxPatterns = [
    /maximum\s+context\s+length\s+(?:is|of)\s+(\d[\d,_]*)/i,
    /context[_\s-]*(?:length|window|limit|size)\s*(?:is|of|:|=|exceeds)?\s*(\d[\d,_]*)/i,
    /max[_\s-]*model[_\s-]*len\s*(?:is|of|:|=)?\s*(\d[\d,_]*)/i,
    /prompt[^.\n]{0,80}?(?:limit|max(?:imum)?)\s*(?:is|of|:)?\s*(\d[\d,_]*)\s*tokens?/i
  ]
  for (const re of ctxPatterns) {
    const m = s.match(re)
    if (m) {
      const n = positiveInt(m[1].replace(/[,_]/g, ''), 2_048, 2_000_000)
      if (n) { learnedContext = n; break }
    }
  }

  let learnedOutput = null
  const outPatterns = [
    /max_(?:completion_)?tokens[^.\n]{0,60}?(?:<=|must\s+be\s+(?:<=|less\s+than\s+or\s+equal\s+to|at\s+most)|limit\s*(?:is|of)?|exceeds(?:\s+the)?(?:\s+maximum)?)\s*(\d[\d,_]*)/i,
    /maximum\s+output\s+tokens?\s*(?:is|of|:|\()?\s*(\d[\d,_]*)/i,
    /output[_\s-]*tokens?\s*(?:limit|max(?:imum)?)\s*(?:is|of|:)?\s*(\d[\d,_]*)/i
  ]
  for (const re of outPatterns) {
    const m = s.match(re)
    if (m) {
      const n = positiveInt(m[1].replace(/[,_]/g, ''), 128, 500_000)
      if (n) { learnedOutput = n; break }
    }
  }

  const isContextOverflow = Boolean(
    learnedContext ||
    /context_length_exceeded|maximum\s+context\s+length|prompt\s+is\s+too\s+long|input\s+(?:is\s+)?too\s+long|too\s+many\s+tokens|exceeds\s+(?:the\s+)?(?:model'?s?\s+)?context|reduce\s+the\s+length\s+of\s+the\s+messages|token\s+limit\s+exceeded/i.test(low)
  )

  const isOutputLimitError = Boolean(
    learnedOutput ||
    (/max_(?:completion_)?tokens/.test(low) && /(exceed|too\s+large|must\s+be|invalid|at\s+most|greater\s+than|maximum)/i.test(low))
  )

  const isUnsupportedParam = Boolean(
    /(unrecognized\s+request\s+argument|extra\s+inputs\s+are\s+not\s+permitted|unknown\s+(?:field|parameter|argument)|unexpected\s+keyword|invalid\s+(?:additional\s+)?(?:field|parameter|property))/i.test(low) &&
    /(reasoning_effort|chat_template_kwargs|enable_thinking|thinking)/i.test(low)
  )

  return { isContextOverflow, isOutputLimitError, isUnsupportedParam, learnedContext, learnedOutput }
}

/**
 * Trim a chat reply that was cut off by `finish_reason === 'length'` back to
 * the last clean sentence or clause boundary so players never receive broken
 * mid-word or mid-preposition fragments (like "pensando em montar uma ").
 */
function trimIncompleteSentence (text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // Already ends cleanly with terminal punctuation or closing quote/paren.
  if (/[.!?…]["')\]»”’]?$/.test(s)) return s

  // 1. Prefer the last full sentence boundary if it keeps at least 30% of text.
  let lastSentenceEnd = -1
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i]
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '…') && (i === s.length - 1 || /\s|["')\]»”’]/.test(s[i + 1]))) {
      lastSentenceEnd = i + 1
      break
    }
  }
  if (lastSentenceEnd >= Math.max(12, Math.floor(s.length * 0.30))) {
    return s.slice(0, lastSentenceEnd).trim()
  }

  // 2. Otherwise fall back to the last natural clause boundary (, ; : —) if substantial.
  const clauseMatch = s.match(/^(.{15,}?)[,;:\u2014]\s+[^,;:\u2014]*$/)
  if (clauseMatch && clauseMatch[1].length >= Math.floor(s.length * 0.45)) {
    return clauseMatch[1].trim() + '.'
  }

  // 3. Otherwise strip trailing dangling articles/prepositions/conjunctions and close cleanly.
  const dangling = /\s+(?:a|o|as|os|um|uma|uns|umas|de|da|do|das|dos|em|na|no|nas|nos|pra|para|por|com|que|e|ou|mas|the|an|to|of|in|on|at|for|with|and|or|but|my|your|our|this|that)\s*$/i
  let clipped = s
  // Drop a very short trailing partial token if the raw text clearly ended mid-phrase
  const words = clipped.split(' ')
  if (words.length >= 4 && !/[.!?…,:;]$/.test(clipped)) {
    while (words.length >= 4 && dangling.test(' ' + words[words.length - 1])) {
      words.pop()
    }
    clipped = words.join(' ').replace(/[,;:\-]+$/, '').trim()
  }
  if (clipped && !/[.!?…]$/.test(clipped)) clipped += '...'
  return clipped
}

/**
 * Determine whether a line carries high-value memory, goal, threat, or
 * immediate trigger context that compaction MUST preserve longest.
 */
// `your move` is the turn's actual question: under pressure it is the LAST line
// that may be dropped. A compacted prompt that keeps the state but loses the
// question is how a session ends up re-reading instead of deciding.
const PRESERVE_LINE_RE = /^(?:your move|recalled|remembered|known|prefs|about\s+\S+|goals?|plan|continue|progress|BLOCKED|THREAT|threats|danger|you|inventory|doing|why now|asked|proposals?|pending|direct|room|player|\[?\d{2}:\d{2}\]?.*(?:whispered|said))/i

/**
 * Generic message-level compactor for callers that do not supply a domain
 * prompt rebuilder (or as an emergency safety net over already-built messages).
 * Trims ASCII grids, verbose tool results, old images, and low-priority lines
 * first while preserving memory, goal, threat, and trigger lines.
 */
function compactMessagesFallback (messages, { level = 1, maxUserChars = null } = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (level <= 0 && !maxUserChars) return list

  const dropImages = level >= 1
  const toolResultLimit = level >= 3 ? 220 : level === 2 ? 500 : 1200
  const keepRecentHistory = level >= 3 ? 2 : level === 2 ? 4 : 8
  const targetUserChars = maxUserChars || (level >= 4 ? 1800 : level === 3 ? 3200 : level === 2 ? 5500 : 9000)

  // Separate leading system/user prompt from multi-step tool history if present.
  const out = []
  const historyStart = list.findIndex((m, idx) => idx >= 2 && (m.role === 'assistant' || m.role === 'tool'))
  const head = historyStart === -1 ? list : list.slice(0, historyStart)
  const tail = historyStart === -1 ? [] : list.slice(historyStart)

  for (const m of head) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'system') {
      // Never touch system prompt unless survival level 4 and explicitly huge
      out.push(m)
      continue
    }
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n')
          : String(m.content || '')
      const compacted = compactUserText(text, { level, maxChars: targetUserChars })
      if (dropImages || typeof m.content === 'string') {
        out.push({ ...m, content: compacted })
      } else {
        out.push({ ...m, content: [{ type: 'text', text: compacted }] })
      }
      continue
    }
    out.push(m)
  }

  if (tail.length) {
    const keptTail = tail.length > keepRecentHistory ? tail.slice(-keepRecentHistory) : tail
    const droppedCount = tail.length - keptTail.length
    if (droppedCount > 0) {
      out.push({ role: 'user', content: `[compacted ${droppedCount} earlier tool-step messages to preserve context room]` })
    }
    for (const m of keptTail) {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > toolResultLimit) {
        out.push({ ...m, content: `${m.content.slice(0, toolResultLimit - 14)}… [compacted]` })
      } else if (dropImages && Array.isArray(m.content)) {
        const textOnly = m.content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n')
        out.push({ ...m, content: textOnly.slice(0, toolResultLimit) || '[image omitted during compaction]' })
      } else {
        out.push(m)
      }
    }
  }

  return out
}

function compactUserText (text, { level = 1, maxChars = 6000 } = {}) {
  let s = String(text || '')
  if (!s) return s

  // 1. Always drop bulky 3D ASCII map/grid blocks at level >= 1
  if (level >= 1) {
    s = s.replace(/(?:^|\n)(?:3d\s+map|local\s+grid|grid|map)\s*\([^)]*\):[\s\S]*?(?=\n[a-zA-Z0-9_-]+(?:\s*\([^)]*\))?:|$)/gi, '\n')
    // Also strip dense ASCII coordinate/slice blocks (lines like "y+0: .....")
    s = s.replace(/(?:^|\n)(?:y[+-]\d+:|level\s+[+-]?\d+:).*(?:\n(?:[.#~@A-Za-z0-9_+:\-\s]{8,}))*/g, '')
  }

  const lines = s.split('\n')
  const trimmed = []
  let inDroppedSection = false
  const dropHeaders = level >= 3
    ? /^(?:nearby|perceived|ambient|entities|blocks|weather|biome|chat\s+history|recent\s+chat|continuity|world\s+notes)\s*:/i
    : level >= 2
      ? /^(?:nearby|perceived|ambient|entities|blocks|weather|biome)\s*:/i
      : /^(?:ambient)\s*:/i

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      inDroppedSection = false
      if (trimmed.length && trimmed[trimmed.length - 1] !== '') trimmed.push('')
      continue
    }
    if (/^[a-zA-Z0-9 _()-]{2,28}:/.test(line)) {
      inDroppedSection = dropHeaders.test(line) && !PRESERVE_LINE_RE.test(line)
    }
    if (inDroppedSection) continue
    const lineCap = PRESERVE_LINE_RE.test(line)
      ? (level >= 4 ? 260 : 500)
      : (level >= 3 ? 160 : 320)
    trimmed.push(line.length > lineCap ? `${line.slice(0, lineCap - 1)}…` : line)
  }

  let result = trimmed.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (result.length <= maxChars) return result

  // Still over maxChars: preserve high-priority memory/goal/threat/trigger lines first,
  // then fill remaining room with other lines from the tail (most recent first).
  const finalLines = result.split('\n').filter((l) => l.trim().length > 0)
  const mustKeepIdx = new Set()
  for (let i = 0; i < finalLines.length; i++) {
    if (PRESERVE_LINE_RE.test(finalLines[i]) || i === 0 || i >= finalLines.length - 3) {
      mustKeepIdx.add(i)
    }
  }
  let used = 0
  const chosen = new Set()
  for (const idx of mustKeepIdx) {
    const len = finalLines[idx].length + 1
    if (used + len <= maxChars || chosen.size < 4) {
      chosen.add(idx)
      used += len
    }
  }
  for (let i = finalLines.length - 1; i >= 0; i--) {
    if (chosen.has(i)) continue
    const len = finalLines[i].length + 1
    if (used + len <= maxChars) {
      chosen.add(i)
      used += len
    }
  }
  result = finalLines.filter((_, i) => chosen.has(i)).join('\n')
  if (result.length > maxChars) result = `${result.slice(0, Math.max(200, maxChars - 14))}\n…[compacted]`
  return result
}

class ContextBudget {
  /**
   * @param {object} opts
   * @param {string} opts.model
   * @param {number|null} [opts.contextWindow] Explicit context window override (null = auto-resolve)
   * @param {number|null} [opts.maxOutputTokens] Explicit model max output override (null = auto-resolve)
   * @param {number} [opts.proactiveRatio=0.75] Trigger proactive compaction at this share of hardPromptBudget
   * @param {number} [opts.reserveOutputRatio=0.25] Fraction of context reserved for model output/reasoning
   */
  constructor ({
    model = '',
    contextWindow = null,
    maxOutputTokens = null,
    proactiveRatio = 0.75,
    reserveOutputRatio = 0.25
  } = {}) {
    const resolved = resolveModelLimits(model)
    this.model = String(model || '')
    this.family = resolved.family
    this.reasoning = resolved.reasoning

    const explicitCtx = positiveInt(contextWindow, 2_048, 2_000_000)
    const explicitOut = positiveInt(maxOutputTokens, 128, 500_000)

    this._explicitContext = explicitCtx
    this._explicitOutput = explicitOut
    this.contextWindow = explicitCtx || resolved.contextWindow
    this.maxOutputTokens = explicitOut || resolved.maxOutputTokens
    this.source = explicitCtx ? 'explicit' : resolved.source

    this.proactiveRatio = Math.max(0.45, Math.min(0.92, Number(proactiveRatio) || 0.75))
    this.reserveOutputRatio = Math.max(0.10, Math.min(0.45, Number(reserveOutputRatio) || 0.25))

    // Empirical chars -> tokens ratio (calibrated dynamically from live `usage.prompt_tokens`).
    // Initialized conservatively at 0.30 (~3.33 chars/token) to account for JSON schemas & UTF-8.
    this.tokensPerChar = 0.30
    this.calibrationSamples = 0
    this.discovered = false
    this.learnedFromErrors = 0
  }

  /**
   * Apply live `/models` endpoint metadata if advertised (e.g. vLLM/SGLang/AMD/OpenAI).
   * Respects explicit user overrides if set.
   */
  applyModelMetadata (payload) {
    if (!payload) return false
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.data)
        ? payload.data
        : [payload]
    if (!list.length) return false

    const norm = (s) => String(s || '').trim().toLowerCase()
    const target = norm(this.model)
    const targetBase = target.includes('/') ? target.split('/').pop() : target
    const match =
      list.find((m) => norm(m?.id || m?.name) === target) ||
      list.find((m) => {
        const id = norm(m?.id || m?.name)
        const base = id.includes('/') ? id.split('/').pop() : id
        return base && base === targetBase
      }) ||
      (list.length === 1 ? list[0] : null)

    if (!match || typeof match !== 'object') return false
    let changed = false

    const ctx =
      positiveInt(match.context_length, 2_048, 2_000_000) ||
      positiveInt(match.max_model_len, 2_048, 2_000_000) ||
      positiveInt(match.context_window, 2_048, 2_000_000) ||
      positiveInt(match.max_context_length, 2_048, 2_000_000) ||
      positiveInt(match.input_token_limit, 2_048, 2_000_000) ||
      positiveInt(match.n_ctx, 2_048, 2_000_000)

    const out =
      positiveInt(match.max_output_tokens, 256, 500_000) ||
      positiveInt(match.max_completion_tokens, 256, 500_000) ||
      positiveInt(match.output_token_limit, 256, 500_000)

    if (ctx && !this._explicitContext) {
      this.contextWindow = ctx
      this.source = 'models-api'
      changed = true
    }
    if (out && !this._explicitOutput) {
      this.maxOutputTokens = Math.min(out, this.contextWindow)
      changed = true
    }
    if (changed) this.discovered = true
    return changed
  }

  /**
   * Inspect an HTTP 400 error message to learn real runtime limits dynamically.
   */
  learnFromError (errorText) {
    const info = parseLimitError(errorText)
    if (info.learnedContext && info.learnedContext < this.contextWindow) {
      this.contextWindow = info.learnedContext
      if (this.maxOutputTokens > this.contextWindow) {
        this.maxOutputTokens = Math.max(256, Math.floor(this.contextWindow * 0.5))
      }
      this.source = 'error-learned'
      this.learnedFromErrors += 1
    }
    if (info.learnedOutput && info.learnedOutput < this.maxOutputTokens) {
      this.maxOutputTokens = info.learnedOutput
      this.learnedFromErrors += 1
    }
    return info
  }

  /**
   * Calibrate token estimator against live server-reported prompt_tokens.
   */
  observeUsage ({ promptChars = 0, promptTokens = 0 } = {}) {
    if (promptChars < 400 || promptTokens < 100) return
    const ratio = promptTokens / promptChars
    if (!Number.isFinite(ratio) || ratio < 0.14 || ratio > 0.70) return
    this.tokensPerChar = this.calibrationSamples === 0
      ? (this.tokensPerChar * 0.5 + ratio * 0.5)
      : (this.tokensPerChar * 0.7 + ratio * 0.3)
    this.calibrationSamples += 1
  }

  /**
   * Estimate total prompt tokens (messages + tool schemas + images).
   */
  estimateTokens (messages, tools = null) {
    const m = measureMessages(messages)
    const toolChars = measureTools(tools)
    const totalChars = m.chars + toolChars
    const textTokens = Math.ceil(totalChars * this.tokensPerChar)
    const imageTokens = m.images * 768
    const framingTokens = m.messageCount * 6 + (Array.isArray(tools) ? tools.length * 4 : 0)
    return {
      totalTokens: textTokens + imageTokens + framingTokens,
      totalChars,
      messageChars: m.chars,
      toolChars,
      images: m.images
    }
  }

  /**
   * Compute prompt budget and output headroom for a given lane.
   * Reserves ample room for the model's standard output/reasoning budget
   * when no explicit cap is configured.
   */
  room ({ lane = 'action', explicitMaxTokens = null } = {}) {
    const ctx = this.contextWindow
    const maxOut = Math.min(this.maxOutputTokens, Math.max(256, ctx - 512))
    const explicit = positiveInt(explicitMaxTokens, 16, 500_000)

    let outputReserve
    if (explicit) {
      outputReserve = Math.min(explicit, Math.floor(ctx * 0.50))
    } else if (lane === 'chat') {
      const target = Math.max(2_048, Math.floor(ctx * Math.min(0.20, this.reserveOutputRatio)))
      outputReserve = Math.min(maxOut, target, Math.floor(ctx * 0.40))
    } else {
      const target = Math.max(4_096, Math.floor(ctx * this.reserveOutputRatio))
      outputReserve = Math.min(maxOut, target, Math.floor(ctx * 0.45))
    }

    const safetyMargin = Math.max(512, Math.min(8_192, Math.floor(ctx * 0.05)))
    const hardPromptBudget = Math.max(1_024, ctx - outputReserve - safetyMargin)
    const softCompactAt = Math.max(768, Math.floor(hardPromptBudget * this.proactiveRatio))

    return {
      contextWindow: ctx,
      maxOutputTokens: maxOut,
      outputReserve,
      safetyMargin,
      hardPromptBudget,
      softCompactAt,
      availableOutputFor: (estimatedPromptTokens) => {
        const prompt = Math.max(0, Math.ceil(Number(estimatedPromptTokens) || 0))
        return Math.max(256, Math.min(maxOut, ctx - prompt - 256))
      }
    }
  }

  /**
   * Decide whether proactive compaction should run BEFORE calling the model,
   * and at which tier (0..4).
   */
  planCompaction ({ estimatedTokens, floor = 0, lane = 'action', explicitMaxTokens = null } = {}) {
    const r = this.room({ lane, explicitMaxTokens })
    const baseFloor = Math.max(0, Math.min(4, Math.trunc(Number(floor) || 0)))
    let level = baseFloor
    let reason = baseFloor > 0 ? 'session_floor' : 'within_budget'

    if (estimatedTokens > r.hardPromptBudget * 1.15) {
      level = Math.max(level, 3)
      reason = 'over_hard_budget'
    } else if (estimatedTokens > r.hardPromptBudget) {
      level = Math.max(level, 2)
      reason = 'at_hard_budget'
    } else if (estimatedTokens > r.softCompactAt) {
      level = Math.max(level, 1)
      reason = 'proactive_soft_limit'
    }

    return {
      level,
      needed: level > 0,
      proactive: estimatedTokens > r.softCompactAt,
      reason,
      estimatedTokens,
      ...r
    }
  }

  /**
   * Compute an escalated output token budget for a `finish_reason === 'length'`
   * recovery attempt, respecting the model's standard limits and remaining
   * context room (`contextWindow - estimatedPromptTokens - 256`).
   */
  escalatedMaxTokens ({ previousMaxTokens = null, completionTokens = 0, estimatedPromptTokens = 0, attempt = 1, lane = 'action' } = {}) {
    const r = this.room({ lane })
    const avail = r.availableOutputFor(estimatedPromptTokens)
    const prev = positiveInt(previousMaxTokens, 64, 500_000) || positiveInt(completionTokens, 64, 500_000) || (lane === 'chat' ? 1_024 : 2_048)
    const minStep = attempt >= 3
      ? (lane === 'chat' ? 8_192 : 16_384)
      : attempt === 2
        ? (lane === 'chat' ? 4_096 : 8_192)
        : (lane === 'chat' ? 2_048 : 4_096)
    const desired = Math.max(prev * 2, minStep)
    return Math.min(avail, desired)
  }

  snapshot () {
    const actionRoom = this.room({ lane: 'action' })
    const chatRoom = this.room({ lane: 'chat' })
    return {
      model: this.model,
      family: this.family,
      reasoning: this.reasoning,
      source: this.source,
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      tokensPerChar: Number(this.tokensPerChar.toFixed(3)),
      calibrationSamples: this.calibrationSamples,
      discovered: this.discovered,
      learnedFromErrors: this.learnedFromErrors,
      actionSoftCompactAt: actionRoom.softCompactAt,
      actionHardPromptBudget: actionRoom.hardPromptBudget,
      actionOutputReserve: actionRoom.outputReserve,
      chatSoftCompactAt: chatRoom.softCompactAt,
      chatHardPromptBudget: chatRoom.hardPromptBudget,
      chatOutputReserve: chatRoom.outputReserve
    }
  }
}

module.exports = {
  ContextBudget,
  MODEL_LIMIT_CATALOG,
  DEFAULT_MODEL_LIMITS,
  resolveModelLimits,
  parseLimitError,
  measureMessages,
  measureTools,
  trimIncompleteSentence,
  compactMessagesFallback,
  compactUserText,
  positiveInt
}
