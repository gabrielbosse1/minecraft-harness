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
  constructor ({ file, workingMax = 5, shortTermMinutes = 10 } = {}) {
    this.working = new WorkingMemory(workingMax)
    this.shortTerm = new ShortTermMemory(shortTermMinutes)
    this.longTerm = new LongTermMemory(file || path.join(__dirname, '..', 'zincai-data', 'memories.json'))
  }

  /**
   * Record an event in working + short-term memory; promote to long-term when
   * (a) it clears the importance threshold or (b) the caller forces it.
   */
  addEvent (evt, { promote = null } = {}) {
    this.working.push(evt)
    this.shortTerm.push(evt)
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

  save () { this.longTerm.save() }
}

module.exports = { MemorySystem, WorkingMemory, ShortTermMemory, LongTermMemory, embed, cosine, tokenize, scoreImportance }
