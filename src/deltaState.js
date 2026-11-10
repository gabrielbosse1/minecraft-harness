/**
 * Delta-State Builder — the context-window firewall between the game and the LLM.
 *
 * WHAT THE LLM EVER SEES (everything else is deliberately never sent):
 *   vitals hp=18 food=20 pos=12,64,-98 tod=day     <- O(1) one-liner, ~12 tokens
 *   memory: fighting zombie, low hp                 <- rolling 10-word memory, only if any
 *   {"type":"chat","user":"Steve","msg":"hello"}     <- <= 5 delta events, one JSON obj per line
 *
 * Rules implemented here:
 *   - At most MAX_EVENTS (5) pending delta events are ever in a prompt.
 *   - When a 6th event arrives the OLDEST is folded into a rolling `memory:`
 *     string that is hard-truncated to MEMORY_WORDS (10) words. Deterministic,
 *     computed in Node — zero extra LLM calls for compression.
 *   - No full world state, no full inventory dump, no chat log. Ever.
 *   - The KV-cache-critical property: the system prompt (see systemPrompt.js)
 *     is byte-identical between calls; only this tiny user body varies.
 *
 * Event size hygiene: every event is string-truncated (<=64 chars per string),
 * keys are whitelisted per type, and `_`-prefixed internal keys are stripped.
 */
'use strict'

const MAX_EVENTS = 5
const MEMORY_WORDS = 10
const MAX_STRING = 64

/** Whitelist of event keys we are willing to forward. Anything else is dropped. */
const ALLOWED_KEYS = {
  chat: ['user', 'msg'],
  inv_delta: ['d'],
  hp: ['v'],
  food: ['v'],
  spawn: [],
  respawn: [],
  death: [],
  craft: ['i', 'ok', 'why'],
  equip: ['s', 'i'],
  attack: ['n'],
  combat: ['msg'],
  move: ['x', 'y', 'z', 'ok'],
  elytra: ['ok'],
  unstuck: ['ok'],
  action_err: ['a', 'why'],
  self: ['d']
}

function wordCount (s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length
}

function truncateString (v, max = MAX_STRING) {
  const s = String(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Normalize/whitelist an inbound event. Returns null if the event type is
 * unknown (we never forward event types we don't explicitly allow).
 */
function sanitizeEvent (event) {
  if (!event || typeof event.type !== 'string') return null
  const keys = ALLOWED_KEYS[event.type]
  if (!keys) return null
  const out = { type: event.type }
  for (const k of keys) {
    const v = event[k]
    if (v === undefined || v === null) continue
    if (typeof v === 'string') out[k] = truncateString(v)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * Map an evicted event to a short (<=3 word) phrase for the rolling memory.
 * Deterministic — no LLM involved.
 */
function toMemoryPhrase (e) {
  switch (e.type) {
    case 'chat': return `chat ${truncateString(e.user, 20)}`
    case 'inv_delta': {
      const first = String(e.d || '').split(',')[0].trim()
      return first ? `inv ${truncateString(first, 22)}` : 'inv change'
    }
    case 'hp': return Number(e.v) <= 6 ? 'low hp' : 'hp change'
    case 'food': return 'hungry'
    case 'craft': return e.ok ? `made ${e.i}` : `craft fail ${e.i}`
    case 'combat': {
      const msg = String(e.msg || '').toLowerCase()
      if (msg.startsWith('engaged')) return `fighting ${msg.split(' ')[1] || 'mob'}`
      if (msg.startsWith('disengaged')) return 'retreating'
      if (msg.includes('down') || msg.includes('dead')) return 'won fight'
      return 'fighting'
    }
    case 'attack': return `fighting ${e.n}`
    case 'death': return 'died'
    case 'respawn': return 'respawned'
    case 'spawn': return 'spawned'
    case 'elytra': return 'flying'
    case 'unstuck': return 'got stuck'
    case 'action_err': return `err ${e.a}`
    case 'equip': return `slot ${e.s}`
    case 'move': return e.ok ? 'moved' : 'move fail'
    case 'self': return null // self-chatter carries no memory value
    default: return null
  }
}

class DeltaBuffer {
  constructor ({ maxEvents = MAX_EVENTS, memoryWords = MEMORY_WORDS } = {}) {
    this.maxEvents = maxEvents
    this.memoryWords = memoryWords
    /** @type {{event: object, trigger: boolean}[]} pending events not yet shown to the LLM */
    this.pending = []
    /** @type {string[]} rolling memory phrases, oldest first */
    this.memoryPhrases = []
    this.memory = ''
    // telemetry for the token-savings report
    this.totalPushed = 0
    this.totalEvicted = 0
  }

  /**
   * Push one delta event.
   * @param {object} event  e.g. {type:'inv_delta', d:'+3 oak_log'}
   * @param {{trigger?: boolean}} opts trigger=false events are shown as context
   *   but never wake the inference loop on their own (used for 'self' bookkeeping
   *   that would otherwise hot-loop the API).
   */
  push (event, { trigger = true } = {}) {
    const clean = sanitizeEvent(event)
    if (!clean) return false
    this.pending.push({ event: clean, trigger: Boolean(trigger) })
    this.totalPushed += 1
    // Fold whatever overflows the 5-event window into the 10-word memory.
    while (this.pending.length > this.maxEvents) {
      const oldest = this.pending.shift()
      this.totalEvicted += 1
      const phrase = toMemoryPhrase(oldest.event)
      if (phrase) this.absorbMemory(phrase)
    }
    return true
  }

  absorbMemory (phrase) {
    this.memoryPhrases.push(phrase)
    this.rebuildMemory()
  }

  rebuildMemory () {
    // Hard cap: "memory: " + phrases joined by ", " must stay <= memoryWords words.
    while (this.memoryPhrases.length > 0 &&
           wordCount('memory: ' + this.memoryPhrases.join(', ')) > this.memoryWords) {
      this.memoryPhrases.shift() // drop the oldest phrase first
    }
    this.memory = this.memoryPhrases.length ? 'memory: ' + this.memoryPhrases.join(', ') : ''
  }

  triggerCount () {
    return this.pending.reduce((n, p) => n + (p.trigger ? 1 : 0), 0)
  }

  /**
   * Build the tiny user-message body. Does NOT clear anything — call commit()
   * only after the AMD round-trip succeeds, so failed calls don't lose deltas.
   */
  buildBody (vitalsLine) {
    const lines = [vitalsLine]
    if (this.memory) lines.push(this.memory)
    for (const { event } of this.pending) lines.push(JSON.stringify(event))
    return lines.join('\n')
  }

  /** Called after a successful inference: pending events have been consumed. */
  commit () {
    this.pending = []
  }

  stats () {
    return {
      pushed: this.totalPushed,
      evictedToMemory: this.totalEvicted,
      pending: this.pending.length,
      memory: this.memory
    }
  }
}

module.exports = { DeltaBuffer, sanitizeEvent, toMemoryPhrase, wordCount, MAX_EVENTS, MEMORY_WORDS }
