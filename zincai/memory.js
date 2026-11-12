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
  'me', 'you', 'i', 'my', 'your', 'is', 'it', 'this', 'that', 'with', 'from',
  // Portuguese (accent-folded) — the players here speak PT-BR.
  'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'uns', 'umas', 'ou', 'que', 'em',
  'no', 'na', 'nos', 'nas', 'para', 'pra', 'pro', 'com', 'por', 'eu', 'voce', 'vc',
  'meu', 'minha', 'seu', 'sua', 'ele', 'ela', 'isso', 'esse', 'essa', 'esta', 'este',
  'onde', 'fica', 'ficam', 'tem', 'como', 'qual', 'quando', 'cade', 'la', 'ali', 'aqui',
  'os', 'as', 'se', 'ao', 'mas', 'foi', 'era', 'ta', 'to', 'gente'
])

/** Lowercase and strip accents: "Baú" and "bau", "Não" and "nao" are one word. */
function fold (text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Tokenize into an accent-folded bag of meaningful words. A trailing plural
 * "s" is dropped so "diamantes"/"diamante" and "chests"/"chest" meet.
 */
function tokenize (text) {
  return fold(text)
    .replace(/[^a-z0-9\-_. ,/]/g, ' ')
    .split(/[\s,]+/)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
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

  /**
   * Identical consecutive events collapse into one line with a count, so a
   * fight ("hit zombie" x6) cannot push a friend's message out of the window.
   */
  push (evt) {
    const last = this.items[this.items.length - 1]
    const text = evt?.text || evt?.msg || ''
    if (last && last.type === evt?.type && (last.text || last.msg || '') === text && !evt?.sender) {
      last.count = (last.count || 1) + 1
      last.ts = Date.now()
      return
    }
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
  add (text, tags = [], importance = 1, provenance = null) {
    const clean = String(text).trim()
    if (!clean) return null
    const vector = embed(clean)
    for (const e of this.entries) {
      if (e.text === clean && JSON.stringify(e.provenance || null) === JSON.stringify(provenance)) return e // preserve distinct sources
      const ev = e._vec || (e._vec = embed(e.text))
      if (!provenance && !e.provenance && cosine(ev, vector) > 0.92 && Math.abs(e.importance - importance) <= 1) {
        e.ts = Date.now()
        return e
      }
    }
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), text: clean, tags, importance, ...(provenance ? { provenance } : {}) }
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

  /** Replace an existing non-provenanced entry sharing a tag (e.g. "container:chest1") or add fresh. */
  upsertByTag (tag, text, tags = [], importance = 1) {
    const clean = String(text).trim()
    if (!clean || !tag) return this.add(text, tags, importance)
    const idx = this.entries.findIndex((e) => !e.provenance && Array.isArray(e.tags) && e.tags.includes(tag))
    if (idx >= 0) {
      const existing = this.entries[idx]
      if (existing.text === clean) { existing.ts = Date.now(); return existing }
      existing.text = clean
      existing.tags = tags.includes(tag) ? tags : [tag, ...tags]
      existing.importance = importance
      existing.ts = Date.now()
      existing._vec = embed(clean)
      this.save()
      return existing
    }
    return this.add(clean, tags.includes(tag) ? tags : [tag, ...tags], importance)
  }

  /**
   * Grep-able search: literal case-insensitive substring match first; if the
   * store has no literal hits, fall back to token overlap. "Remember when we
   * built the castle?" -> grep finds the castle memory without the user
   * repeating a single detail.
   */
  grep (text, limit = 3) {
    const q = fold(text).trim()
    if (!q || !this.entries.length) return []
    const terms = tokenize(q)
    if (!terms.length) return []
    const literal = this.entries.filter((e) => fold(e.text).includes(q))
    const scored = []
    if (literal.length) {
      for (const e of literal) scored.push({ ...e, score: 1 + (e.importance || 0) * 0.1 })
    } else {
      for (const e of this.entries) {
        const low = fold(e.text)
        const hits = terms.filter((t) => low.includes(t)).length
        if (hits > 0) scored.push({ ...e, score: hits / terms.length + (e.importance || 0) * 0.05 })
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
      scored.push({ ...e, score })
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
   *
   * `window: false` keeps it out of the small working window (the "events:"
   * lines of the prompt). Use it for things the prompt already shows in a
   * section of their own — chat, results, what the reflex did — so that they
   * cannot push "hit by player Gabriel" out of a five-line window.
   */
  addEvent (evt, { promote = null, window = true } = {}) {
    if (window) this.working.push(evt)
    this.shortTerm.push(evt)
    this.ephemeral.push(evt)
    const importance = scoreImportance(evt)
    const shouldPromote = promote === null ? importance >= 2 : Boolean(promote)
    if (shouldPromote) {
      this.longTerm.add(evt.msg || evt.text || JSON.stringify(evt), evt.tags || [evt.type || 'misc'], Math.max(1, importance), { kind: 'event', source: String(evt.type || 'unknown') })
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
    const t = fold(text)
    if (/remember|recall|last time|when we|you (built|made|gave)|where.*(is|are|was)|what did we/.test(t)) return true
    // "lembra…", "onde fica o baú…", "cadê…", "da última vez…", "o que a gente fez…"
    return /lembr|onde\s|cade\b|ultima vez|quando a gente|voce (construiu|fez|deu|guardou|colocou)|o que a gente|qual (era|foi)/.test(t)
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
    const render = (h) => `${h.text} [${h.provenance?.kind || 'unknown source'}${h.provenance?.source ? `: ${h.provenance.source}` : ''}; ${h.ts ? new Date(h.ts).toISOString().slice(0, 10) : 'date unknown'}; verify before relying]`
    if (MemorySystem.isRecallQuery(q)) {
      const literal = this.longTerm.grep(q, topK)
      if (literal.length) {
        parts.push('recalled:\n' + literal.map((h) => `- ${render(h)}`).join('\n'))
      } else {
        // no literal hit — try per-significant-token grep, merge unique hits
        const tokens = tokenize(q).slice(0, 4)
        const seen = new Map()
        for (const tok of tokens) {
          for (const h of this.longTerm.grep(tok, 2)) seen.set(h.id || h.text, h)
          if (seen.size >= topK) break
        }
        if (seen.size) parts.push('recalled:\n' + [...seen.values()].slice(0, topK).map((h) => `- ${render(h)}`).join('\n'))
      }
    } else {
      const hits = this.longTerm.query(q, topK)
      if (hits.length) parts.push('memories:\n' + hits.map((h) => `- (${h.importance}*) ${render(h)}`).join('\n'))
    }
    return parts.join('\n')
  }

  /** Observe an inbound chat line (drives implicit, per-player preference tracking). */
  observeChat (sender, text) {
    if (!sender || !text) return null
    return this.preferences.observe(text, sender)
  }

  /**
   * Keep what a player told the bot. Chat used to live only in the 5-event
   * window; "o baú de diamantes fica no segundo andar" was gone a minute later
   * while "craft stick failed" was kept forever.
   * @param {boolean} addressed the line was said TO the bot
   */
  rememberChat (sender, text, { addressed = false } = {}) {
    const t = String(text || '').trim()
    if (!sender || t.length < 8) return null
    // Only statements worth recalling later: where things are, what is whose,
    // numbers. "zinc vem aqui" is a request, not a memory.
    const f = fold(t)
    // This filter is the fallback, for lines nobody answered. What a player
    // tells the bot directly is written down by the chat model itself
    // (rememberFact). The stems used to sit inside word boundaries — "guard"
    // never matched "guardei" — so three of them matched nothing at all.
    const factual = /\d|\b(base|casa|house|home|bau|baus|chest|farm|fazenda|mina|mine|portal|bed|cama|guard\w*|coloc\w*|coloqu\w*|deix\w*|escond\w*|fica|ficam|ficou|is at|are at|put|stored|keep|meu|minha|meus|minhas|my|nosso|nossa|our|amanha|hoje|ontem|semana|aniversario|irmao|irma|pai|mae|pais|amigo|amiga|alergic\w*|odeio|adoro|prefiro|vamos|vou|vai|combinad\w*)\b/.test(f)
    if (!factual || /\?\s*$/.test(t)) return null
    return this.longTerm.add(`${sender} said: ${t.slice(0, 160)}`, ['chat', String(sender)], addressed ? 2 : 1, { kind: 'player statement', source: String(sender) })
  }

  /**
   * A fact the MODEL chose to keep (the chat lane's `remember` field): where
   * something is, whose it is, a plan, a preference — in its own words.
   * @param {string} text one sentence
   * @param {{ about?: string }} [opts] the player it came from / concerns
   */
  rememberFact (text, { about = '' } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (t.length < 6) return null
    const who = String(about || '').trim()
    return this.longTerm.add(t, who ? ['fact', who] : ['fact'], 3, { kind: 'model summary of player statement', source: who || 'unknown' })
  }

  /**
   * What the bot knows from or about one player, newest first: the facts the
   * model wrote down, then lines of theirs the fallback filter kept.
   */
  factsAbout (name, limit = 6) {
    const who = String(name || '').trim()
    if (!who) return []
    const low = fold(who)
    const mine = this.longTerm.entries.filter((e) => {
      const tags = e.tags || []
      if (!tags.includes('fact') && !tags.includes('chat')) return false
      return tags.includes(who) || fold(e.text).includes(low)
    })
    mine.sort((a, b) => (Number((b.tags || []).includes('fact')) - Number((a.tags || []).includes('fact'))) || (b.ts - a.ts))
    return mine.slice(0, limit).map((e) => e.text)
  }

  /** Recent chat lines (10-minute window), oldest first — survives event spam. */
  recentChat (limit = 6) {
    return this.shortTerm.snapshot().filter((e) => e.type === 'chat').slice(-limit)
  }

  /** Preferences fragment for the prompt ('' when none). Pass a name for one player. */
  preferencesLine (who) { return this.preferences.line(5, who) }

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

  /**
   * Observe one chat line from a non-bot player. Returns detected pref or null.
   * @param {string} text
   * @param {string} [who] the speaker — preferences are kept per player
   */
  observe (text, who = '') {
    const t = String(text || '').trim()
    if (!t) return null
    // Accent-folded so "não", "nao" and "NÃO" behave alike; the captured phrase
    // keeps the folded form (it is only ever shown back to the model).
    const f = fold(t)
    const X = "([a-z0-9][a-z0-9 \\-_']{1,48})"
    const rules = [
      { re: new RegExp(`\\b(?:i|we)\\s+(?:prefer|like|love|enjoy)\\s+${X}`), polarity: 'like' },
      { re: new RegExp(`\\b(?:my\\s+)?favou?rite\\s+(?:block|style|build|material|thing)s?\\s*(?:is|are)?\\s*${X}`), polarity: 'like' },
      { re: new RegExp(`\\b(?:don't|do not|never|stop)\\s+(?:use|using|place|placing|build(?:ing)?\\s+with)\\s+${X}`), polarity: 'dislike' },
      { re: new RegExp(`\\b(?:i|we)\\s+hate\\s+${X}`), polarity: 'dislike' },
      // Portuguese. Dislikes first: "não gosto de X" also contains "gosto de X".
      { re: new RegExp(`\\b(?:nao\\s+gosto|nao\\s+curto|odeio|detesto)\\s+(?:de\\s+|da\\s+|do\\s+|das\\s+|dos\\s+)?${X}`), polarity: 'dislike' },
      { re: new RegExp(`\\bnao\\s+(?:usa|use|usar|coloca|coloque|bota|constroi|construa)\\s+(?:com\\s+)?${X}`), polarity: 'dislike' },
      { re: new RegExp(`\\b(?:eu\\s+)?(?:gosto|adoro|amo|curto|prefiro)\\s+(?:de\\s+|da\\s+|do\\s+|das\\s+|dos\\s+|mais\\s+de\\s+)?${X}`), polarity: 'like' },
      { re: new RegExp(`\\b(?:meu|minha)\\s+(?:bloco|estilo|material|coisa)\\s+(?:favorit[oa]|preferid[oa])\\s+(?:e|sao)?\\s*${X}`), polarity: 'like' }
    ]
    for (const { re, polarity } of rules) {
      const m = re.exec(f)
      if (!m) continue
      const phrase = m[1].replace(/\s+/g, ' ').trim().replace(/[.!,]+$/, '')
      if (phrase.length < 2) continue
      this._upsert(phrase, polarity, who)
      this.save()
      return { text: phrase, polarity, who: who || null }
    }
    return null
  }

  _upsert (text, polarity, who = '') {
    const key = text.toLowerCase()
    const hit = this.prefs.find((p) => p.text.toLowerCase() === key && p.polarity === polarity && (p.who || '') === who)
    if (hit) {
      hit.count += 1
      hit.ts = Date.now()
    } else {
      this.prefs.push({ text, polarity, count: 1, ts: Date.now(), ...(who ? { who } : {}) })
      this.prefs.sort((a, b) => b.count - a.count || b.ts - a.ts)
      this.prefs = this.prefs.slice(0, 80)
    }
  }

  /**
   * Compact prompt fragment. With `who`: that player's tastes only. Without:
   * every player's, labelled by name — one merged line used to attribute
   * Pedro's dislikes to Gabriel.
   */
  line (limit = 5, who) {
    if (!this.prefs.length) return ''
    const render = (list) => {
      const likes = list.filter((p) => p.polarity === 'like').slice(0, limit).map((p) => p.text)
      const dislikes = list.filter((p) => p.polarity === 'dislike').slice(0, limit).map((p) => p.text)
      const bits = []
      if (likes.length) bits.push(`likes: ${likes.join(', ')}`)
      if (dislikes.length) bits.push(`dislikes: ${dislikes.join(', ')}`)
      return bits.join('; ')
    }
    if (who !== undefined) {
      const mine = render(this.prefs.filter((p) => (p.who || '') === who))
      return mine ? `${who || 'user'} preferences: ${mine}` : ''
    }
    const names = [...new Set(this.prefs.map((p) => p.who || ''))]
    if (names.length === 1 && names[0] === '') {
      const all = render(this.prefs)
      return all ? `user preferences: ${all}` : ''
    }
    const parts = names.slice(0, 6).map((n) => `${n || 'someone'} — ${render(this.prefs.filter((p) => (p.who || '') === n))}`).filter((x) => !x.endsWith('— '))
    return parts.length ? `preferences: ${parts.join(' | ')}` : ''
  }
}

module.exports = { MemorySystem, WorkingMemory, ShortTermMemory, LongTermMemory, EphemeralMemory, PreferenceTracker, embed, cosine, tokenize, fold, scoreImportance }