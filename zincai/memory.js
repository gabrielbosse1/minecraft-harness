/**
 * memory.js — Multi-category, provenance-aware memory intelligence for ZincAI.
 *
 * Categories supported:
 *   - episodic   : specific events, player interactions, build outcomes, discoveries
 *   - semantic   : verified world knowledge, locations, storage contents, redstone facts
 *   - procedural : skills, successful methods, failure lessons, reusable redstone techniques
 *   - continuity : active project context, agreements, unfinished multi-session state
 *
 * Every long-term record carries structured metadata:
 *   createdAt (ISO), ts (ms), lastVerifiedAt (ms|null), provenance, basis
 *   ('observed' | 'inferred' | 'reported'), confidence (0..1), importance,
 *   entities[], location {x,y,z,dim}, goalIds[], status ('active'|'outdated'|'contradicted'),
 *   and foundational protection so important memories are never evicted merely for age.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const MEMORY_CATEGORIES = new Set(['episodic', 'semantic', 'procedural', 'continuity'])
const MEMORY_BASES = new Set(['observed', 'inferred', 'reported'])

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

/** Extract coordinates like "100,64,200" or "100 64 200" from text when not explicitly passed. */
function extractLocationFromText (text, defaultDim = 'overworld') {
  const m = String(text || '').match(/(-?\d{1,6})\s*[, ]\s*(-?\d{1,4})\s*[, ]\s*(-?\d{1,6})/)
  if (!m) return null
  const x = Number(m[1]); const y = Number(m[2]); const z = Number(m[3])
  if (![x, y, z].every(Number.isFinite) || y < -128 || y > 400) return null
  return { x, y, z, dim: defaultDim }
}

function inferCategory (text, tags = [], provenance = null) {
  const tset = new Set((tags || []).map((t) => String(t).toLowerCase()))
  const low = fold(text)
  if (tset.has('procedural') || tset.has('lesson') || tset.has('procedure') || tset.has('redstone_design') || /\b(how to|method|technique|avoid repeating|lesson|worked when|failed because|blueprint|circuit design)\b/.test(low)) {
    return 'procedural'
  }
  if (tset.has('continuity') || tset.has('agreement') || tset.has('goal') || /\b(agreed|agreement|combinado|promised|resume|unfinished)\b/.test(low)) {
    return 'continuity'
  }
  if (tset.has('container') || tset.has('place') || tset.has('semantic') || tset.has('redstone_fact') || provenance?.kind === 'player statement' || provenance?.kind === 'model summary of player statement' || /\b(chest\d*|is at|located at|contains|keeps|stored at)\b/.test(low)) {
    return 'semantic'
  }
  return 'episodic'
}

function inferBasis (provenance) {
  const k = String(provenance?.kind || '').toLowerCase()
  if (k.includes('player statement') || k.includes('reported') || k.includes('claim')) return 'reported'
  if (k.includes('inferred') || k.includes('hypothesis')) return 'inferred'
  return 'observed'
}

/** Heuristic importance (0..3) for an event payload. */
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
   * @param {{ now?: () => number, maxEntries?: number }} [opts]
   */
  constructor (file, opts = {}) {
    this.file = file
    this.now = opts.now || (() => Date.now())
    this.maxEntries = opts.maxEntries || 500
    this.entries = []
    this._retrieveCache = { key: '', at: 0, result: null }
    this._load()
  }

  _normalizeLoaded (e) {
    const ts = Number.isFinite(e.ts) ? e.ts : this.now()
    const prov = e.provenance || null
    const basis = MEMORY_BASES.has(e.basis) ? e.basis : inferBasis(prov)
    const category = MEMORY_CATEGORIES.has(e.category) ? e.category : inferCategory(e.text, e.tags, prov)
    return {
      ...e,
      ts,
      createdAt: e.createdAt || new Date(ts).toISOString(),
      updatedAt: e.updatedAt || ts,
      lastVerifiedAt: e.lastVerifiedAt !== undefined ? e.lastVerifiedAt : (basis === 'observed' ? ts : null),
      category,
      basis,
      confidence: Number.isFinite(e.confidence) ? e.confidence : (basis === 'observed' ? 0.9 : basis === 'inferred' ? 0.65 : 0.4),
      importance: Number.isFinite(e.importance) ? e.importance : 1,
      entities: Array.isArray(e.entities) ? e.entities : [],
      location: e.location !== undefined ? e.location : extractLocationFromText(e.text),
      goalIds: Array.isArray(e.goalIds) ? e.goalIds : [],
      status: e.status || 'active',
      foundational: Boolean(e.foundational || (e.importance >= 3 && basis !== 'reported'))
    }
  }

  _load () {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((e) => e && e.text).map((e) => this._normalizeLoaded(e))
      }
    } catch {
      this.entries = []
    }
  }

  _invalidateCache () {
    this._retrieveCache = { key: '', at: 0, result: null }
  }

  /** Atomic-ish save (write temp then rename). */
  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      const persistable = this.entries.map(({ _vec, ...rest }) => rest)
      fs.writeFileSync(tmp, JSON.stringify(persistable), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch { /* non-fatal */ }
  }

  /**
   * Add a memory entry. Backwards-compatible positional signature:
   * `add(text, tags = [], importance = 1, provenance = null, meta = {})`
   */
  add (text, tags = [], importance = 1, provenance = null, meta = {}) {
    const clean = String(text || '').trim()
    if (!clean) return null
    const now = Number.isFinite(meta.ts) ? meta.ts : this.now()
    const basis = MEMORY_BASES.has(meta.basis) ? meta.basis : inferBasis(provenance)
    const category = MEMORY_CATEGORIES.has(meta.category) ? meta.category : inferCategory(clean, tags, provenance)
    const confidence = Number.isFinite(meta.confidence)
      ? Math.max(0, Math.min(1, meta.confidence))
      : (basis === 'observed' ? 0.92 : basis === 'inferred' ? 0.65 : 0.4)
    const location = meta.location !== undefined ? meta.location : extractLocationFromText(clean)
    const entities = Array.isArray(meta.entities) ? [...new Set(meta.entities.map(String))] : []
    const goalIds = Array.isArray(meta.goalIds) ? [...new Set(meta.goalIds.map(String))] : []
    const subjectKey = meta.subjectKey ? String(meta.subjectKey) : null
    const foundational = meta.foundational !== undefined
      ? Boolean(meta.foundational)
      : (importance >= 3 && basis !== 'reported')

    // If a subjectKey is supplied for an observed belief, update the existing active entry!
    if (subjectKey && basis === 'observed') {
      const existing = this.entries.find((e) => e.subjectKey === subjectKey && e.basis === 'observed' && e.status === 'active')
      if (existing) {
        if (existing.text !== clean) existing.previousText = existing.text
        existing.text = clean
        existing.updatedAt = now
        existing.ts = now
        existing.lastVerifiedAt = now
        existing.confidence = Math.max(existing.confidence || 0.9, confidence)
        existing.importance = Math.max(existing.importance || 1, importance)
        existing.tags = [...new Set([...(existing.tags || []), ...(tags || [])])]
        if (location) existing.location = location
        if (entities.length) existing.entities = [...new Set([...(existing.entities || []), ...entities])]
        if (goalIds.length) existing.goalIds = [...new Set([...(existing.goalIds || []), ...goalIds])]
        existing._vec = embed(clean)
        this._invalidateCache()
        this.save()
        return existing
      }
    }

    const vector = embed(clean)
    for (const e of this.entries) {
      if (e.status !== 'active') continue
      if (e.text === clean && JSON.stringify(e.provenance || null) === JSON.stringify(provenance) && e.basis === basis) {
        e.updatedAt = now
        e.occurrences = (e.occurrences || 1) + 1
        if (basis === 'observed') e.lastVerifiedAt = now
        this._invalidateCache()
        return e
      }
      const ev = e._vec || (e._vec = embed(e.text))
      if (!provenance && !e.provenance && e.basis === basis && e.category === category && cosine(ev, vector) > 0.92 && Math.abs(e.importance - importance) <= 1) {
        e.updatedAt = now
        e.ts = now
        e.occurrences = (e.occurrences || 1) + 1
        if (basis === 'observed') e.lastVerifiedAt = now
        this._invalidateCache()
        return e
      }
    }

    const entry = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      ts: now,
      createdAt: new Date(now).toISOString(),
      updatedAt: now,
      lastVerifiedAt: basis === 'observed' ? now : (meta.lastVerifiedAt ?? null),
      text: clean,
      category,
      basis,
      confidence,
      importance,
      foundational,
      tags: Array.isArray(tags) ? tags.slice() : [],
      entities,
      location,
      goalIds,
      subjectKey,
      status: 'active',
      occurrences: 1,
      ...(provenance ? { provenance } : {})
    }
    entry._vec = vector
    this.entries.push(entry)
    this._invalidateCache()
    if (this.entries.length > this.maxEntries) this.consolidate()
    this.save()
    return entry
  }

  /** Replace an existing non-provenanced entry sharing a tag (e.g. "container:chest1") or add fresh. */
  upsertByTag (tag, text, tags = [], importance = 1, meta = {}) {
    const clean = String(text).trim()
    if (!clean || !tag) return this.add(text, tags, importance, null, meta)
    const now = this.now()
    const idx = this.entries.findIndex((e) => !e.provenance && e.status === 'active' && Array.isArray(e.tags) && e.tags.includes(tag))
    if (idx >= 0) {
      const existing = this.entries[idx]
      if (existing.text !== clean) existing.previousText = existing.text
      existing.text = clean
      existing.tags = tags.includes(tag) ? tags : [tag, ...tags]
      existing.importance = importance
      existing.ts = now
      existing.updatedAt = now
      existing.lastVerifiedAt = now
      existing.basis = 'observed'
      existing.confidence = 0.95
      if (meta.location) existing.location = meta.location
      existing._vec = embed(clean)
      this._invalidateCache()
      this.save()
      return existing
    }
    return this.add(clean, tags.includes(tag) ? tags : [tag, ...tags], importance, null, {
      ...meta,
      subjectKey: tag,
      basis: 'observed',
      confidence: 0.95,
      category: meta.category || 'semantic'
    })
  }

  /**
   * Consolidate duplicates, collapse repetitive low-value failure entries, and
   * trim strictly non-foundational low-importance records when over capacity.
   * Foundational memories (`foundational === true`) are NEVER deleted for age.
   */
  consolidate () {
    // 1. Merge near-identical episodic entries with the same category & basis.
    const kept = []
    for (const e of this.entries) {
      if (e.foundational || e.status !== 'active') { kept.push(e); continue }
      const ev = e._vec || (e._vec = embed(e.text))
      const dup = kept.find((k) =>
        k.status === 'active' &&
        k.category === e.category &&
        k.basis === e.basis &&
        JSON.stringify(k.location || null) === JSON.stringify(e.location || null) &&
        cosine(k._vec || (k._vec = embed(k.text)), ev) > 0.90
      )
      if (dup) {
        dup.occurrences = (dup.occurrences || 1) + (e.occurrences || 1)
        dup.updatedAt = Math.max(dup.updatedAt || dup.ts, e.updatedAt || e.ts)
        dup.importance = Math.max(dup.importance || 1, e.importance || 1)
        continue
      }
      kept.push(e)
    }
    this.entries = kept

    // 2. If still above maxEntries, evict non-foundational, contradicted/outdated or lowest-utility entries first.
    if (this.entries.length > this.maxEntries) {
      const evictRank = (e) => {
        if (e.foundational) return 1e9 + (e.importance || 3) * 1000
        const statusWeight = e.status === 'active' ? 100 : 0
        return statusWeight + (e.importance || 0) * 50 + (e.confidence || 0.5) * 20 + ((e.updatedAt || e.ts) / 1e11)
      }
      this.entries.sort((a, b) => evictRank(a) - evictRank(b))
      this.entries = this.entries.slice(this.entries.length - this.maxEntries)
    }
    this._invalidateCache()
  }

  /**
   * Reconcile existing beliefs and unverified player claims against a new
   * direct world observation (e.g., opening a chest or inspecting a block).
   */
  reconcileObservation ({ subjectKey = null, text, observedItems = null, location = null, category = 'semantic', tags = [], importance = 2, entities = [], goalIds = [] } = {}) {
    const now = this.now()
    const updated = this.add(text, tags, importance, { kind: 'direct_observation', source: 'world' }, {
      subjectKey,
      location,
      category,
      basis: 'observed',
      confidence: 0.98,
      lastVerifiedAt: now,
      entities,
      goalIds,
      foundational: importance >= 3
    })

    const contradicted = []
    if (Array.isArray(observedItems)) {
      const presentSet = new Set(observedItems.map((i) => fold(i).replace(/s$/, '')))
      const NOTABLE_ITEMS = ['diamond', 'diamante', 'netherite', 'emerald', 'esmeralda', 'gold', 'ouro', 'iron', 'ferro', 'bread', 'pao', 'coal', 'carvao', 'redstone', 'torch', 'tocha', 'tnt', 'obsidian', 'pickaxe', 'sword', 'espada']
      for (const e of this.entries) {
        if (e === updated || e.status !== 'active') continue
        const low = fold(e.text)
        const sameTarget = (subjectKey && ((e.tags || []).includes(subjectKey) || e.subjectKey === subjectKey || low.includes(fold(subjectKey.split(':').pop())))) ||
          (location && e.location && e.location.dim === location.dim && Math.hypot(e.location.x - location.x, e.location.z - location.z) <= 4) ||
          (e.basis === 'reported' && /\b(bau|chest|barrel|container|estoque)\b/.test(low) && (!e.location || (location && Math.hypot(e.location.x - location.x, e.location.z - location.z) <= 12)))
        if (!sameTarget) continue
        if (e.basis === 'reported' || e.basis === 'inferred') {
          const claimedMissing = NOTABLE_ITEMS.filter((item) => low.includes(item.replace(/s$/, '')) && !presentSet.has(item.replace(/s$/, '')))
          if (claimedMissing.length > 0) {
            e.status = 'contradicted'
            e.confidence = 0.05
            e.updatedAt = now
            e.contradictedBy = updated?.id || 'observation'
            e.contradictionNote = `verified empty of ${claimedMissing.join(', ')} on ${new Date(now).toISOString().slice(0, 19)}Z`
            contradicted.push(e)
          }
        } else if (e.basis === 'observed' && subjectKey && e.subjectKey !== subjectKey && low.includes(fold(subjectKey.split(':').pop())) && e.text !== updated?.text) {
          e.status = 'outdated'
          e.updatedAt = now
          e.supersededBy = updated?.id || null
        }
      }
    }
    if (contradicted.length) {
      this._invalidateCache()
      this.save()
    }
    return { entry: updated, contradicted }
  }

  /** Grep-able search (backwards compatible). */
  grep (text, limit = 3) {
    const q = fold(text).trim()
    if (!q || !this.entries.length) return []
    const terms = tokenize(q)
    if (!terms.length) return []
    const activeEntries = this.entries.filter((e) => e.status !== 'outdated')
    const literal = activeEntries.filter((e) => fold(e.text).includes(q))
    const scored = []
    if (literal.length) {
      for (const e of literal) {
        const trustMult = e.status === 'contradicted' ? 0.2 : (0.6 + (e.confidence ?? 0.8) * 0.4)
        scored.push({ ...e, score: (1 + (e.importance || 0) * 0.1) * trustMult })
      }
    } else {
      for (const e of activeEntries) {
        const low = fold(e.text)
        const hits = terms.filter((t) => low.includes(t)).length
        if (hits > 0) {
          const trustMult = e.status === 'contradicted' ? 0.2 : (0.6 + (e.confidence ?? 0.8) * 0.4)
          scored.push({ ...e, score: (hits / terms.length + (e.importance || 0) * 0.05) * trustMult })
        }
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** Top-K relevant memories for a query string (backwards compatible). */
  query (text, k = 3) {
    if (!this.entries.length) return []
    const q = embed(text)
    const scored = []
    for (const e of this.entries) {
      if (e.status === 'outdated') continue
      const v = e._vec || (e._vec = embed(e.text))
      const sim = cosine(q, v)
      if (sim <= 0.05) continue
      const confBoost = e.status === 'contradicted' ? 0.15 : (0.55 + (e.confidence ?? 0.85) * 0.45)
      const score = sim * (1 + (e.importance || 0) * 0.35) * confBoost
      scored.push({ ...e, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  /**
   * Multi-dimensional retrieval combining semantic similarity, entity match,
   * spatial proximity, goal link, category filter, temporal bounds, and
   * importance × confidence weighting. Never loads the full history!
   */
  retrieve ({
    query = '',
    category = null,
    entity = null,
    near = null,
    radius = 32,
    goalId = null,
    sinceMs = null,
    includeContradicted = false,
    k = 4
  } = {}) {
    const cacheKey = JSON.stringify({ query, category, entity, near, radius, goalId, sinceMs, includeContradicted, k })
    const now = this.now()
    if (this._retrieveCache.key === cacheKey && (now - this._retrieveCache.at) < 2000 && this._retrieveCache.result) {
      return { ...this._retrieveCache.result, cached: true }
    }

    const qTrim = String(query || '').trim()
    const qVec = qTrim ? embed(qTrim) : null
    const qFold = fold(qTrim)
    const qTerms = qTrim ? tokenize(qTrim) : []
    const entFold = entity ? fold(entity) : null

    const scored = []
    for (const e of this.entries) {
      if (e.status === 'outdated') continue
      if (e.status === 'contradicted' && !includeContradicted) continue
      if (category && e.category !== category) continue
      if (sinceMs !== null && (e.updatedAt || e.ts) < sinceMs) continue

      let relevance = 0
      const low = fold(e.text)

      if (qVec && qVec.size > 0) {
        const v = e._vec || (e._vec = embed(e.text))
        const sim = cosine(qVec, v)
        relevance += sim * 1.2
        if (qFold.length >= 3 && low.includes(qFold)) relevance += 0.65
        else if (qTerms.length) {
          const overlap = qTerms.filter((t) => low.includes(t)).length / qTerms.length
          relevance += overlap * 0.45
        }
      } else if (!entFold && !near && !goalId && category) {
        relevance = 0.4 // pure category browse
      }

      if (entFold) {
        const hasEnt = (e.entities || []).some((x) => fold(x) === entFold) ||
          (e.tags || []).some((x) => fold(x) === entFold) ||
          low.includes(entFold)
        if (!hasEnt) {
          if (!qTrim && !near && !goalId) continue
        } else {
          relevance += 0.75
        }
      }

      if (near && Number.isFinite(near.x) && Number.isFinite(near.z)) {
        if (e.location && (!near.dim || !e.location.dim || e.location.dim === near.dim)) {
          const d = Math.hypot(e.location.x - near.x, (e.location.y || 0) - (near.y || 0), e.location.z - near.z)
          if (d <= radius) relevance += 0.8 * (1 - d / Math.max(1, radius + 1))
          else if (!qTrim && !entFold && !goalId) continue
        } else if (!qTrim && !entFold && !goalId) {
          continue
        }
      }

      if (goalId) {
        if ((e.goalIds || []).includes(goalId) || (e.tags || []).includes(goalId)) relevance += 0.85
        else if (!qTrim && !entFold && !near) continue
      }

      if (relevance <= 0.08) continue
      const impWeight = 1 + Math.min(4, e.importance || 1) * 0.25
      const confWeight = e.status === 'contradicted' ? 0.2 : (0.45 + (e.confidence ?? 0.8) * 0.55)
      const score = relevance * impWeight * confWeight
      scored.push({ ...e, score: Math.round(score * 1000) / 1000 })
    }

    scored.sort((a, b) => (b.score - a.score) || ((b.updatedAt || b.ts) - (a.updatedAt || a.ts)))
    const top = scored.slice(0, k)
    const out = {
      found: top.length > 0,
      totalStoreSize: this.entries.length,
      entries: top,
      unknownReason: top.length === 0
        ? `no verified or reported memory matched "${qTrim || category || entity || goalId || 'location'}" — treat as unknown and inspect the world rather than guessing`
        : null
    }
    this._retrieveCache = { key: cacheKey, at: now, result: out }
    return out
  }
}

/** Facade: one object the rest of the app talks to. */
class MemorySystem {
  constructor ({ file, workingMax = 5, shortTermMinutes = 10, preferencesFile, ephemeralMs = 30_000, now = () => Date.now() } = {}) {
    this.now = now
    this.working = new WorkingMemory(workingMax)
    this.shortTerm = new ShortTermMemory(shortTermMinutes)
    this.longTerm = new LongTermMemory(file || path.join(__dirname, '..', 'zincai-data', 'memories.json'), { now })
    this.ephemeral = new EphemeralMemory(ephemeralMs)
    this.preferences = new PreferenceTracker(preferencesFile || path.join(path.dirname(file || path.join(__dirname, '..', 'zincai-data', 'memories.json')), 'preferences.json'))
  }

  addEvent (evt, { promote = null, window = true } = {}) {
    if (window) this.working.push(evt)
    this.shortTerm.push(evt)
    this.ephemeral.push(evt)
    const importance = scoreImportance(evt)
    const shouldPromote = promote === null ? importance >= 2 : Boolean(promote)
    if (shouldPromote) {
      this.longTerm.add(
        evt.msg || evt.text || JSON.stringify(evt),
        evt.tags || [evt.type || 'misc'],
        Math.max(1, importance),
        { kind: 'event', source: String(evt.type || 'unknown') },
        {
          category: evt.category || 'episodic',
          basis: evt.basis || 'observed',
          confidence: evt.confidence ?? 0.9,
          location: evt.where || undefined,
          entities: evt.entities || (evt.sender ? [evt.sender] : []),
          goalIds: evt.goalId ? [evt.goalId] : []
        }
      )
    }
  }

  /** Record a structured semantic, procedural, episodic, or continuity memory. */
  recordKnowledge ({
    text,
    category = 'semantic',
    basis = 'observed',
    confidence = 0.92,
    importance = 3,
    tags = [],
    entities = [],
    location = null,
    goalIds = [],
    subjectKey = null,
    foundational = false,
    source = 'self'
  } = {}) {
    return this.longTerm.add(
      text,
      tags,
      importance,
      { kind: `${basis}_${category}`, source },
      { category, basis, confidence, entities, location, goalIds, subjectKey, foundational }
    )
  }

  formatEntry (h) {
    const basisLabel = h.status === 'contradicted'
      ? `CONTRADICTED CLAIM (${h.contradictionNote || 'disproven by observation'})`
      : h.basis === 'reported'
        ? `UNVERIFIED CLAIM by ${h.provenance?.source || 'player'} (conf ${Math.round((h.confidence ?? 0.4) * 100)}%)`
        : h.basis === 'inferred'
          ? `inferred (conf ${Math.round((h.confidence ?? 0.65) * 100)}%)`
          : `verified observation (conf ${Math.round((h.confidence ?? 0.9) * 100)}%${h.lastVerifiedAt ? `, verified ${new Date(h.lastVerifiedAt).toISOString().slice(0, 10)}` : ''})`
    const loc = h.location ? ` @${h.location.x},${h.location.y},${h.location.z}` : ''
    const prev = h.previousText ? ` (updated from: "${h.previousText.slice(0, 60)}")` : ''
    const occ = (h.occurrences || 1) > 1 ? ` [seen x${h.occurrences}]` : ''
    return `[${h.category || 'memory'} | ${basisLabel}]${loc} ${h.text}${prev}${occ}`
  }

  promptBlock (queryText, topK = 3) {
    const hits = this.longTerm.query(queryText, topK)
    if (!hits.length) return ''
    return hits.map((h) => `- (${h.importance}*) ${this.formatEntry(h)}`).join('\n')
  }

  static isRecallQuery (text) {
    const t = fold(text)
    if (/remember|recall|last time|when we|you (built|made|gave)|where.*(is|are|was)|what did we/.test(t)) return true
    return /lembr|onde\s|cade\b|ultima vez|quando a gente|voce (construiu|fez|deu|guardou|colocou)|o que a gente|qual (era|foi)/.test(t)
  }

  recallBlock (queryText, topK = 3, context = {}) {
    const q = String(queryText || '').trim()
    if (!q && !context.near && !context.goalId && !context.entity) return ''
    const parts = []
    if (q && MemorySystem.isRecallQuery(q)) {
      const literal = this.longTerm.grep(q, topK)
      if (literal.length) {
        parts.push('recalled:\n' + literal.map((h) => `- ${this.formatEntry(h)}`).join('\n'))
        return parts.join('\n')
      }
    }
    const res = this.longTerm.retrieve({
      query: q,
      near: context.near || null,
      goalId: context.goalId || null,
      entity: context.entity || null,
      k: topK
    })
    if (res.entries.length) {
      const header = q && MemorySystem.isRecallQuery(q) ? 'recalled:' : 'memories:'
      parts.push(`${header}\n` + res.entries.map((h) => `- (${h.importance}*) ${this.formatEntry(h)}`).join('\n'))
    }
    return parts.join('\n')
  }

  observeChat (sender, text) {
    if (!sender || !text) return null
    return this.preferences.observe(text, sender)
  }

  /**
   * Keep what a player told the bot — ALWAYS tagged `basis: 'reported'` with
   * modest confidence (`0.35..0.42`) so a player claim is NEVER mistaken for
   * verified world truth!
   */
  rememberChat (sender, text, { addressed = false } = {}) {
    const t = String(text || '').trim()
    if (!sender || t.length < 8) return null
    const f = fold(t)
    const factual = /\d|\b(base|casa|house|home|bau|baus|chest|farm|fazenda|mina|mine|portal|bed|cama|guard\w*|coloc\w*|coloqu\w*|deix\w*|escond\w*|fica|ficam|ficou|is at|are at|put|stored|keep|meu|minha|meus|minhas|my|nosso|nossa|our|amanha|hoje|ontem|semana|aniversario|irmao|irma|pai|mae|pais|amigo|amiga|alergic\w*|odeio|adoro|prefiro|vamos|vou|vai|combinad\w*|diamante\w*|diamond\w*)\b/.test(f)
    if (!factual || /\?\s*$/.test(t)) return null
    const isAgreement = /\b(combinad\w*|agreed|deal|promet\w*|vamos construir|ponte publica)\b/.test(f)
    return this.longTerm.add(
      `${sender} claimed/said: ${t.slice(0, 160)}`,
      ['chat', String(sender), ...(isAgreement ? ['agreement'] : ['claim'])],
      addressed ? 2 : 1,
      { kind: 'player statement', source: String(sender) },
      {
        category: isAgreement ? 'continuity' : 'semantic',
        basis: 'reported',
        confidence: 0.38,
        lastVerifiedAt: null,
        entities: [String(sender)],
        foundational: isAgreement
      }
    )
  }

  /**
   * A player statement summarized by the chat lane (`reply.remember`).
   * Stored strictly as an UNVERIFIED reported statement (`basis: 'reported'`),
   * unless it is an explicit social agreement with that player.
   */
  rememberFact (text, { about = '' } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (t.length < 6) return null
    const who = String(about || '').trim()
    const isAgreement = /\b(agreed|agreement|combinad\w*|deal|shared|public)\b/i.test(t)
    return this.longTerm.add(
      t,
      who ? ['fact', who] : ['fact'],
      isAgreement ? 3 : 2,
      { kind: 'model summary of player statement', source: who || 'unknown' },
      {
        category: isAgreement ? 'continuity' : 'semantic',
        basis: 'reported',
        confidence: isAgreement ? 0.6 : 0.42,
        lastVerifiedAt: null,
        entities: who ? [who] : [],
        foundational: isAgreement
      }
    )
  }

  factsAbout (name, limit = 6) {
    const who = String(name || '').trim()
    if (!who) return []
    const low = fold(who)
    const mine = this.longTerm.entries.filter((e) => {
      if (e.status === 'outdated') return false
      const tags = e.tags || []
      if (!tags.includes('fact') && !tags.includes('chat') && !(e.entities || []).some((x) => fold(x) === low)) return false
      return tags.includes(who) || (e.entities || []).some((x) => fold(x) === low) || fold(e.text).includes(low)
    })
    mine.sort((a, b) => (Number((b.tags || []).includes('fact')) - Number((a.tags || []).includes('fact'))) || (b.ts - a.ts))
    return mine.slice(0, limit).map((e) => {
      if (e.status === 'contradicted') return `[CONTRADICTED: ${e.contradictionNote || 'false claim'}] ${e.text}`
      if (e.basis === 'reported') return `[unverified claim] ${e.text}`
      return e.text
    })
  }

  recentChat (limit = 6) {
    return this.shortTerm.snapshot().filter((e) => e.type === 'chat').slice(-limit)
  }

  preferencesLine (who) { return this.preferences.line(5, who) }

  save () { this.longTerm.save(); this.preferences.save() }
}

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

  clear () { this.items = [] }

  snapshot () { this.prune(); return this.items.slice() }

  line () {
    this.prune()
    if (!this.items.length) return ''
    return this.items
      .map((e) => e.text || e.msg || e.type)
      .slice(-8)
      .join('; ')
  }
}

class PreferenceTracker {
  constructor (file) {
    this.file = file
    this.prefs = []
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

  observe (text, who = '') {
    const t = String(text || '').trim()
    if (!t) return null
    const f = fold(t)
    const X = "([a-z0-9][a-z0-9 \\-_']{1,48})"
    const rules = [
      { re: new RegExp(`\\b(?:i|we)\\s+(?:prefer|like|love|enjoy)\\s+${X}`), polarity: 'like' },
      { re: new RegExp(`\\b(?:my\\s+)?favou?rite\\s+(?:block|style|build|material|thing)s?\\s*(?:is|are)?\\s*${X}`), polarity: 'like' },
      { re: new RegExp(`\\b(?:don't|do not|never|stop)\\s+(?:use|using|place|placing|build(?:ing)?\\s+with)\\s+${X}`), polarity: 'dislike' },
      { re: new RegExp(`\\b(?:i|we)\\s+hate\\s+${X}`), polarity: 'dislike' },
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

module.exports = { MemorySystem, WorkingMemory, ShortTermMemory, LongTermMemory, EphemeralMemory, PreferenceTracker, embed, cosine, tokenize, fold, scoreImportance, MEMORY_CATEGORIES, MEMORY_BASES }
