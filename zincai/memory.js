/**
 * memory.js — 3-tier memory for ZincAI.
 *
 *   Working Memory   : the last N signed observations (default 5). Cheapest,
 *                      goes into EVERY System-2 prompt.
 *   Short-Term Memory: timestamped rolling buffer of what happened in the last
 *                      10 minutes. Injected when it exists and is relevant;
 *                      pruned on read and on a timer.
 *   Long-Term Memory : durable JSON file store. Important events (crafted,
 *                      built, received gifted items, died
 *                      "player gave me X", …) are persisted here and retrieved
 *                      via cosine similarity over bag-of-words vectors,
 *                      boosted by an importance score. Only the TOP 3 are
 *                      injected into a System-2 prompt.
 *
 * Retrieval is deliberately dependency-free (no embeddings model on the AMD
 * endpoint guaranteed for arbitrary input): hashed bag-of-words cosine is
 * good enough for "built a base at 100,64,200"-style facts, and costs zero
 * tokens to compute. Swap `LongTermMemory.embed()` for a real embedding call
 * later without touching any other code.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'at', 'in', 'on', 'to', 'for',
  'me', 'you', 'i', 'my', 'your', 'is', 'it', 'this', 'that', 'with', 'from'
])

/** Tokenize into a lowercase alphanumeric bag of meaningful words. */
function tokenize (text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\-_. ,/]/g, ' ')
    .split(/[\s,]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/** Hashed bag-of-words vector (sparse map token -> tf). */
function embed (text) {
  const counts = new Map()
  for (const tok of tokenize(text)) {
    counts.set(tok, (counts.get(tok) || 0) + 1)
  }
  // L2-normalize so cosine == dot of the two maps
  let norm = 0
  for (const v of counts.values()) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (const [k, v] of counts) counts.set(k, v / norm)
  return counts
}

/** Cosine similarity of two sparse normalized vectors. */
function cosine (a, b) {
  let dot = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = large.get(k)
    if (w) dot += v * w
  }
  return dot
}

/** Heuristic importance (0..3) for an event payload, used to decide what
 *  is worth writing to long-term memory and to boost retrieval. */
function scoreImportance (evt) {
  const text = String(evt && (evt.msg || evt.text || evt.summary) || '').toLowerCase()
  const type = String(evt && evt.type || '').toLowerCase()
  if (type === 'build_complete' || type === 'gift' || /gave me|thanked|diamond|netherite/.test(text)) return 3
  if (type === 'death' || type === 'combat_win' || type === 'leveled' || type === 'crafted') return 2
  if (type === 'chat' || type === 'spawn' || type === 'move') return 1
  return 0
}

class WorkingMemory {
  constructor (max = 5) {
    this.max = max
    this.items = []
  }

  push (evt) {
    this.items.push({ ts: Date.now(), ...evt })
    while (this.items.length > this.max) this.items.shift()
  }

  last (n = this.max) {
    return this.items.slice(-n)
  }

  clear () { this.items = [] }
}

class ShortTermMemory {
  /** @param {number} minutes sliding window in minutes (default 10) */
  constructor (minutes = 10) {
    this.windowMs = minutes * 60_000
    this.items = []
  }

  push (evt) {
    this.items.push({ ts: Date.now(), ...evt })
    this.prune()
  }

  prune () {
    const cutoff = Date.now() - this.windowMs
    while (this.items.length && this.items[0].ts < cutoff) this.items.shift()
  }

  snapshot () {
    this.prune()
    return this.items.slice()
  }
}

class LongTermMemory {
  /**
   * @param {string} file absolute path of the JSON store
   */
  constructor (file) {
    this.file = file
    this.entries = []
    this._load()
  }

  _load () {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.entries = parsed.filter((e) => e && e.text)
    } catch {
      // Missing/corrupt store — start empty, never crash the bot.
      this.entries = []
    }
  }

  /** Atomic-ish save (write temp then rename). */
  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      // Strip in-memory-only vector caches before persisting.
      const persistable = this.entries.map(({ _vec, ...rest }) => rest)
      fs.writeFileSync(tmp, JSON.stringify(persistable), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch {
      // A lost save is not worth a crash; it is logged by the caller.
    }
  }

  /** Add an important fact. Dedupes near-identical facts. */
  add (text, tags = [], importance = 1) {
    const clean = String(text).trim()
    if (!clean) return null
    const vector = embed(clean)
    for (const e of this.entries) {
      if (e.text === clean) return e // exact dedupe
      if (e._vec && cosine(e._vec, vector) > 0.92 && Math.abs(e.importance - importance) <= 1) {
        e.ts = Date.now()
        return e
      }
    }
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), text: clean, tags, importance }
    entry._vec = vector
    this.entries.push(entry)
    // Cap the store at 500 entries, evicting lowest importance then oldest.
    if (this.entries.length > 500) {
      this.entries.sort((a, b) => (a.importance - b.importance) || (a.ts - b.ts))
      this.entries = this.entries.slice(this.entries.length - 500)
    }
    this.save()
    return entry
  }

  /**
   * Grep-able search: literal case-insensitive substring match first; if the
   * store has no literal hits, fall back to token overlap. "Remember when we
   * built the castle?" -> grep finds the castle memory without the user
   * repeating a single detail.
   */
  grep (text, limit = 3) {
    const q = String(text || '').trim().toLowerCase()
    if (!q || !this.entries.length) return []
    const terms = tokenize(q)
    const literal = this.entries.filter((e) => e.text.toLowerCase().includes(q))
    const scored = []
    if (literal.length) {
      for (const e of literal) scored.push({ text: e.text, score: 1 + (e.importance || 0) * 0.1 })
    } else {
      for (const e of this.entries) {
        const low = e.text.toLowerCase()
        const hits = terms.filter((t) => low.includes(t)).length
        if (hits > 0) scored.push({ text: e.text, score: hits / terms.length + (e.importance || 0) * 0.05 })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** Top-K relevant memories for a query string. */
  query (text, k = 3) {
    if (!this.entries.length) return []
    const q = embed(text)
    const scored = []
    for (const e of this.entries) {
      const v = e._vec || (e._vec = embed(e.text))
      const sim = cosine(q, v)
      if (sim <= 0.05) continue
      const score = sim * (1 + (e.importance || 0) * 0.35)
      scored.push({ text: e.text, tags: e.tags || [], importance: e.importance || 0, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}

/** Facade: one object the rest of the app talks to. */
class MemorySystem {
  constructor ({ file, workingMax = 5, shortTermMinutes = 10, preferencesFile, ephemeralMs = 30_000 } = {}) {
    this.working = new WorkingMemory(workingMax)
    this.shortTerm = new ShortTermMemory(shortTermMinutes)
    this.longTerm = new LongTermMemory(file || path.join(__dirname, '..', 'zincai-data', 'memories.json'))
    this.ephemeral = new EphemeralMemory(ephemeralMs)
    this.preferences = new PreferenceTracker(preferencesFile || path.join(path.dirname(file || path.join(__dirname, '..', 'zincai-data', 'memories.json')), 'preferences.json'))
  }

  /**
   * Record an event in working + short-term memory; promote to long-term when
   * (a) it clears the importance threshold or (b) the caller forces it.
   */
  addEvent (evt, { promote = null } = {}) {
    this.working.push(evt)
    this.shortTerm.push(evt)
    this.ephemeral.push(evt)
    const importance = scoreImportance(evt)
    const shouldPromote = promote === null ? importance >= 2 : Boolean(promote)
    if (shouldPromote) {
      this.longTerm.add(evt.msg || evt.text || JSON.stringify(evt), evt.tags || [evt.type || 'misc'], Math.max(1, importance))
    }
  }

  /** Build the "MEMORIES" block for a System-2 prompt. */
  promptBlock (queryText, topK = 3) {
    const hits = this.longTerm.query(queryText, topK)
    if (!hits.length) return ''
    return hits.map((h) => `- (${h.importance}*) ${h.text}`).join('\n')
  }

  /** True when the query smells like a recall request ("remember when..."). */
  static isRecallQuery (text) {
    return /remember|recall|last time|when we|you (built|made|gave)|where.*(is|are|was)|what did we/i.test(String(text || ''))
  }

  /**
   * Full memory context: ephemeral "just now" window + recalled hits.
   * If the query looks like a recall request, grep the store LITERALLY first
   * (exact place names like "castle"), then fall back to vector retrieval.
   */
  recallBlock (queryText, topK = 3) {
    const q = String(queryText || '').trim()
    if (!q) return ''
    const parts = []
    if (MemorySystem.isRecallQuery(q)) {
      const literal = this.longTerm.grep(q, topK)
      if (literal.length) {
        parts.push('recalled:\n' + literal.map((h) => `- ${h.text}`).join('\n'))
      } else {
        // no literal hit — try per-significant-token grep, merge unique hits
        const tokens = tokenize(q).slice(0, 4)
        const seen = new Set()
        for (const tok of tokens) {
          for (const h of this.longTerm.grep(tok, 2)) seen.add(h.text)
          if (seen.size >= topK) break
        }
        if (seen.size) parts.push('recalled:\n' + [...seen].slice(0, topK).map((t) => `- ${t}`).join('\n'))
      }
    } else {
      const hits = this.longTerm.query(q, topK)
      if (hits.length) parts.push('memories:\n' + hits.map((h) => `- (${h.importance}*) ${h.text}`).join('\n'))
    }
    return parts.join('\n')
  }

  /** Observe an inbound chat line (drives implicit preference tracking). */
  observeChat (sender, text) {
    if (!sender || !text) return null
    return this.preferences.observe(text)
  }

  /** One-line preferences fragment for the prompt, or '' */
  preferencesLine () { return this.preferences.line() }

  save () { this.longTerm.save(); this.preferences.save() }
}


// ============================================================================
// v2 upgrades — ephemeral buffer, grep-able long-term, implicit preferences
// ============================================================================

/**
 * EphemeralMemory — a rolling 30-second action/observation window.
 * Injected into prompts as "just now"; discarded fast; never persisted.
 */
class EphemeralMemory {
  constructor (maxAgeMs = 30_000, max = 12) {
    this.maxAgeMs = maxAgeMs
    this.max = max
    this.items = []
  }

  push (evt) {
    this.items.push({ ts: Date.now(), ...evt })
    this.prune()
  }

  prune () {
    const cutoff = Date.now() - this.maxAgeMs
    while (this.items.length && this.items[0].ts < cutoff) this.items.shift()
    while (this.items.length > this.max) this.items.shift()
  }

  snapshot () { this.prune(); return this.items.slice() }

  /** Compact single-line rendering, e.g. "placed 3 dirt, said hi, moved north" */
  line () {
    this.prune()
    if (!this.items.length) return ''
    return this.items
      .map((e) => e.text || e.msg || e.type)
      .slice(-8)
      .join('; ')
  }
}

/**
 * PreferenceTracker — implicit user-preference learning from chat lines.
 * No explicit commands: we watch for "I prefer/like/love X", "don't use X",
 * "favourite X is Y" and keep a weighted tally on disk.
 */
class PreferenceTracker {
  constructor (file) {
    this.file = file
    this.prefs = [] // { text, polarity: 'like'|'dislike', count, ts }
    this._load()
  }

  _load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) this.prefs = parsed
    } catch { this.prefs = [] }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.prefs.slice(0, 100)), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch { /* non-fatal */ }
  }

  /** Observe one chat line from a non-bot player. Returns detected pref or null. */
  observe (text) {
    const t = String(text || '').trim()
    if (!t) return null
    const rules = [
      { re: /\b(?:i|we)\s+(?:prefer|like|love|enjoy)\s+([a-z0-9][a-z0-9 \-_']{1,48})/i, polarity: 'like' },
      { re: /\b(?:my\s+)?favou?rite\s+(?:block|style|build|material|thing)s?\s*(?:is|are)?\s*([a-z0-9][a-z0-9 \-_']{1,48})/i, polarity: 'like' },
      { re: /\b(?:don't|do not|never|stop)\s+(?:use|using|place|placing|build(?:ing)?\s+with)\s+([a-z0-9][a-z0-9 \-_']{1,48})/i, polarity: 'dislike' },
      { re: /\b(?:i|we)\s+hate\s+([a-z0-9][a-z0-9 \-_']{1,48})/i, polarity: 'dislike' }
    ]
    for (const { re, polarity } of rules) {
      const m = re.exec(t)
      if (!m) continue
      const phrase = m[1].replace(/\s+/g, ' ').trim().replace(/[.!,]+$/, '')
      if (phrase.length < 2) continue
      this._upsert(phrase, polarity)
      this.save()
      return { text: phrase, polarity }
    }
    return null
  }

  _upsert (text, polarity) {
    const key = text.toLowerCase()
    const hit = this.prefs.find((p) => p.text.toLowerCase() === key && p.polarity === polarity)
    if (hit) {
      hit.count += 1
      hit.ts = Date.now()
    } else {
      this.prefs.push({ text, polarity, count: 1, ts: Date.now() })
      this.prefs.sort((a, b) => b.count - a.count || b.ts - a.ts)
      this.prefs = this.prefs.slice(0, 50)
    }
  }

  /** Compact one-line prompt fragment: "likes: gothic style, stone bricks; dislikes: dirt towers" */
  line (limit = 5) {
    if (!this.prefs.length) return ''
    const likes = this.prefs.filter((p) => p.polarity === 'like').slice(0, limit).map((p) => p.text)
    const dislikes = this.prefs.filter((p) => p.polarity === 'dislike').slice(0, limit).map((p) => p.text)
    const bits = []
    if (likes.length) bits.push(`likes: ${likes.join(', ')}`)
    if (dislikes.length) bits.push(`dislikes: ${dislikes.join(', ')}`)
    return bits.length ? `user preferences: ${bits.join('; ')}` : ''
  }
}


module.exports = { MemorySystem, WorkingMemory, ShortTermMemory, LongTermMemory, EphemeralMemory, PreferenceTracker, embed, cosine, tokenize, scoreImportance }