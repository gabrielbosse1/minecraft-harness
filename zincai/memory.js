/**
 * memory.js — the curated memory store and the single memory facade for ZincAI.
 *
 * Three layers, deliberately separate:
 *
 *   1. RAW HISTORY (`history.js`, `<data>/history/<category>/<day>.jsonl`)
 *      Complete, append-only evidence. Never fed to the model automatically;
 *      searchable on demand; referenced by its stable `category/file#line` ref.
 *
 *   2. ENTITY DOCUMENTS (`entities.js`, `<data>/entities/*.json`)
 *      Long-form dossiers about players (keyed by Minecraft UUID), Zinc itself,
 *      places, groups and recurring events. Grown by explicit edits, not by
 *      dumping raw events.
 *
 *   3. CURATED MEMORIES (this file, `<data>/memories.json`)
 *      Short, meaningful, provenance-tagged records Zinc deliberately keeps:
 *      categories `episodic | semantic | procedural | continuity`, evidence
 *      basis `observed | inferred | reported`, confidence, importance, stable
 *      id, evidence refs into raw history, and archival rather than deletion.
 *
 * Live working context (recent events, short-term window, ephemeral scratch,
 * preferences) lives in the same facade but is never persisted as long-term
 * knowledge and never accumulates: it is what the model reasons with now.
 *
 * Every long-term record carries: createdAt (ISO), ts (ms), updatedAt,
 * lastVerifiedAt (ms|null), provenance, basis, confidence (0..1), importance,
 * entities[], location, goalIds[], evidence[], status
 * ('active'|'outdated'|'contradicted'|'archived'|'deleted'), revision, and
 * foundational protection so important memories are never evicted for age.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const {
  fold,
  tokenize,
  embed,
  cosine,
  SYNONYMS,
  extractLocationFromText,
  hasWholeWord,
  clip
} = require('./memory_text')
const { HistoryLog } = require('./history')
const { ProfileStore } = require('./entities')

const MEMORY_CATEGORIES = new Set(['episodic', 'semantic', 'procedural', 'continuity'])
const MEMORY_BASES = new Set(['observed', 'inferred', 'reported'])
const MEMORY_STATUSES = new Set(['active', 'outdated', 'contradicted', 'archived', 'deleted'])
const MAX_MEMORY_TEXT = 1200
/**
 * Text patterns left behind by older builds that promoted raw telemetry with no
 * memory tags at all. Used only by the one-time legacy cleanup in `maintain()`.
 */
const LEGACY_TELEMETRY_TEXT = /^(?:took [\d.]+ damage\b|(?:[A-Za-z0-9_]+ )?died$|[A-Za-z0-9_]+ took damage\b|[A-Za-z0-9_]+ appeared [\d.]+m away|[A-Za-z0-9_]+ disappeared\b)/
/** Event types that are telemetry, not knowledge: history only, never curated. */
const TELEMETRY_ONLY_TYPES = new Set([
  'hurt', 'heal', 'effect', 'dimension', 'inventory', 'inventory_loss', 'weather',
  'daylight', 'chunk', 'move', 'item_collected', 'entity_hurt', 'entity_spawn',
  'player_arrived', 'player_left', 'spawn', 'despawn', 'block_change'
])

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

/** Minecraft mob/entity nouns that must never be mistaken for a player name. */
const NON_PLAYER_ENTITY = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'slime', 'magma_cube',
  'blaze', 'ghast', 'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'pillager_captain', 'piglin', 'hoglin', 'zombified_piglin', 'wither_skeleton',
  'wither', 'warden', 'elder_guardian', 'guardian', 'iron_golem', 'snow_golem', 'wolf',
  'cat', 'ocelot', 'fox', 'horse', 'villager', 'wandering_trader', 'allay', 'bee',
  'axolotl', 'goat', 'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'turtle', 'panda',
  'strider', 'item', 'arrow', 'trident', 'fireball', 'tnt', 'primed_tnt', 'boat',
  'minecart', 'player', 'unknown', 'world', 'self', 'zinc', 'zincai', 'server'
])

/** Conservative: usernames are 3–16 word characters and are not a known mob id. */
function looksLikePlayerName (name) {
  const n = String(name || '').trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) return false
  return !NON_PLAYER_ENTITY.has(fold(n))
}

/** Heuristic importance (0..3) for an event payload. */
function scoreImportance (evt) {
  const text = String(evt && (evt.msg || evt.text || evt.summary) || '').toLowerCase()
  const type = String(evt && evt.type || '').toLowerCase()
  // Ordinary transient telemetry is not permanent knowledge. Promote only
  // durable discoveries, commitments, relationship evidence, recurring lessons,
  // and significant milestones; damage/movement/chat remain episodic windows.
  if (/complaint|bug|limitation|promise|boundary|repeatedly|recurring/.test(text) || type === 'build_complete' || type === 'gift') return 2
  if (type === 'death' || type === 'combat_win' || type === 'leveled' || type === 'crafted') return 1
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
      status: MEMORY_STATUSES.has(e.status) ? e.status : 'active',
      foundational: Boolean(e.foundational || (e.importance >= 3 && basis !== 'reported')),
      revision: Number.isFinite(e.revision) ? e.revision : 0,
      evidence: Array.isArray(e.evidence) ? [...new Set(e.evidence.map(String))].slice(-40) : [],
      profileId: e.profileId ? String(e.profileId) : null,
      mergedFrom: Array.isArray(e.mergedFrom) ? e.mergedFrom.map(String) : [],
      occurrences: Number.isFinite(e.occurrences) ? e.occurrences : 1
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
    const clean = clip(String(text || ''), meta.maxText ?? MAX_MEMORY_TEXT)
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
        if (Array.isArray(meta.evidence) && meta.evidence.length) existing.evidence = [...new Set([...(existing.evidence || []), ...meta.evidence.map(String)])].slice(-40)
        if (meta.profileId) existing.profileId = String(meta.profileId)
        existing.revision = (existing.revision || 0) + 1
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
        if (Array.isArray(meta.evidence) && meta.evidence.length) e.evidence = [...new Set([...(e.evidence || []), ...meta.evidence.map(String)])].slice(-40)
        if (entities.length) e.entities = [...new Set([...(e.entities || []), ...entities])]
        this._invalidateCache()
        this.save()
        return e
      }
      const ev = e._vec || (e._vec = embed(e.text))
      if (!provenance && !e.provenance && e.basis === basis && e.category === category && cosine(ev, vector) > 0.92 && Math.abs(e.importance - importance) <= 1) {
        e.updatedAt = now
        e.ts = now
        e.occurrences = (e.occurrences || 1) + 1
        if (basis === 'observed') e.lastVerifiedAt = now
        if (Array.isArray(meta.evidence) && meta.evidence.length) e.evidence = [...new Set([...(e.evidence || []), ...meta.evidence.map(String)])].slice(-40)
        this._invalidateCache()
        this.save()
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
      revision: 0,
      evidence: Array.isArray(meta.evidence) ? [...new Set(meta.evidence.map(String))].slice(-40) : [],
      profileId: meta.profileId ? String(meta.profileId) : null,
      mergedFrom: [],
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

  // ------------------------------------------------------------ identity --
  /** Look one record up by its stable id (archived and deleted records included). */
  get (id, { includeDeleted = true } = {}) {
    const key = String(id || '').trim()
    if (!key) return null
    const entry = this.entries.find((e) => e.id === key)
    if (!entry) return null
    if (!includeDeleted && entry.status === 'deleted') return null
    return entry
  }

  // ------------------------------------------------------------- editing --
  /**
   * Update a curated record in place. Whitelisted fields only; the previous
   * text is preserved in `previousText` so an edit never erases what was
   * believed before. Returns `{ ok, entry }` or `{ ok:false, msg }`.
   */
  update (id, patch = {}, { reason = '' } = {}) {
    const entry = this.get(id)
    if (!entry) return { ok: false, msg: `memory #${id} not found` }
    if (entry.status === 'deleted') return { ok: false, msg: `memory #${id} is deleted; restore it first` }
    let dirty = false
    if (patch.text !== undefined && String(patch.text).trim()) {
      const next = clip(String(patch.text), MAX_MEMORY_TEXT)
      if (next !== entry.text) {
        entry.previousText = entry.text
        entry.text = next
        entry._vec = embed(next)
        dirty = true
      }
    }
    if (patch.category && MEMORY_CATEGORIES.has(patch.category)) { entry.category = patch.category; dirty = true }
    if (patch.basis && MEMORY_BASES.has(patch.basis)) { entry.basis = patch.basis; dirty = true }
    if (Number.isFinite(patch.confidence)) { entry.confidence = Math.max(0, Math.min(1, patch.confidence)); dirty = true }
    if (Number.isFinite(patch.importance)) { entry.importance = Math.max(0, Math.min(5, Math.trunc(patch.importance))); dirty = true }
    if (patch.lastVerifiedAt !== undefined) { entry.lastVerifiedAt = Number.isFinite(patch.lastVerifiedAt) ? patch.lastVerifiedAt : null; dirty = true }
    if (Array.isArray(patch.tags)) { entry.tags = [...new Set(patch.tags.map(String))]; dirty = true }
    if (Array.isArray(patch.entities)) { entry.entities = [...new Set(patch.entities.map(String))]; dirty = true }
    if (Array.isArray(patch.goalIds)) { entry.goalIds = [...new Set(patch.goalIds.map(String))]; dirty = true }
    if (patch.location !== undefined) { entry.location = patch.location || null; dirty = true }
    if (patch.status && MEMORY_STATUSES.has(patch.status)) { entry.status = patch.status; dirty = true }
    if (patch.uncertainty !== undefined) { entry.uncertainty = patch.uncertainty ? clip(String(patch.uncertainty), 240) : null; dirty = true }
    if (Array.isArray(patch.evidence)) {
      entry.evidence = [...new Set([...(entry.evidence || []), ...patch.evidence.map(String)])].slice(-40)
      dirty = true
    }
    if (!dirty) return { ok: true, unchanged: true, entry }
    entry.revision = (entry.revision || 0) + 1
    entry.updatedAt = this.now()
    entry.lastEditReason = reason ? clip(reason, 160) : entry.lastEditReason || null
    this._invalidateCache()
    this.save()
    return { ok: true, entry }
  }

  /** Attach raw-history evidence references to a curated record. */
  linkEvidence (id, refs = []) {
    const entry = this.get(id)
    if (!entry) return { ok: false, msg: `memory #${id} not found` }
    const list = (Array.isArray(refs) ? refs : [refs]).map(String).filter(Boolean)
    const before = entry.evidence.length
    entry.evidence = [...new Set([...entry.evidence, ...list])].slice(-40)
    if (entry.evidence.length === before) return { ok: true, unchanged: true, entry }
    entry.updatedAt = this.now()
    this._invalidateCache()
    this.save()
    return { ok: true, entry }
  }

  /** Soft archive: the record leaves active recall, its id and provenance stay. */
  archive (id, { reason = '' } = {}) {
    const entry = this.get(id)
    if (!entry) return { ok: false, msg: `memory #${id} not found` }
    if (entry.status === 'archived') return { ok: true, unchanged: true, entry }
    entry.status = 'archived'
    entry.archivedAt = this.now()
    entry.archiveReason = reason ? clip(reason, 160) : null
    entry.updatedAt = this.now()
    this._invalidateCache()
    this.save()
    return { ok: true, entry }
  }

  restore (id) {
    const entry = this.get(id)
    if (!entry) return { ok: false, msg: `memory #${id} not found` }
    entry.status = 'active'
    entry.archivedAt = null
    entry.deletedAt = null
    entry.updatedAt = this.now()
    this._invalidateCache()
    this.save()
    return { ok: true, entry }
  }

  /**
   * Remove a curated record. Default is a soft delete: the record, its id and
   * its history evidence all stay on disk, only active recall stops returning
   * it. `hard: true` erases the curated row itself — the raw history files it
   * points at are never touched by either mode.
   */
  remove (id, { hard = false, reason = '' } = {}) {
    const idx = this.entries.findIndex((e) => e.id === String(id || ''))
    if (idx < 0) return { ok: false, msg: `memory #${id} not found` }
    const entry = this.entries[idx]
    if (hard) {
      this.entries.splice(idx, 1)
      this._invalidateCache()
      this.save()
      return { ok: true, hard: true, removed: entry.id, historyRefs: entry.evidence || [] }
    }
    entry.status = 'deleted'
    entry.deletedAt = this.now()
    entry.deleteReason = reason ? clip(reason, 160) : null
    entry.updatedAt = this.now()
    this._invalidateCache()
    this.save()
    return { ok: true, hard: false, removed: entry.id, historyRefs: entry.evidence || [] }
  }

  /**
   * Merge overlapping records into one. The target keeps the earliest timestamp
   * and inherits tags, entities, goal links and evidence; every source is
   * archived with `supersededBy` (never deleted) so the trail stays auditable.
   */
  merge ({ ids = [], into = null, text = null, reason = '' } = {}) {
    const list = [...new Set(ids.map(String))].map((id) => this.get(id)).filter(Boolean)
    if (list.length < 2) return { ok: false, msg: 'merge needs at least two existing memory ids' }
    const target = into ? this.get(into) : list[0]
    if (!target) return { ok: false, msg: `merge target #${into} not found` }
    const sources = list.filter((e) => e.id !== target.id)
    if (!sources.length) return { ok: false, msg: 'merge needs records distinct from the target' }
    if (text) {
      target.previousText = target.text
      target.text = clip(String(text), MAX_MEMORY_TEXT)
      target._vec = embed(target.text)
    }
    const allTs = [target.ts, ...sources.map((s2) => s2.ts)].filter(Number.isFinite)
    const earliestTs = allTs.length ? Math.min(...allTs) : this.now()
    for (const source of sources) {
      target.tags = [...new Set([...(target.tags || []), ...(source.tags || [])])]
      target.entities = [...new Set([...(target.entities || []), ...(source.entities || [])])]
      target.goalIds = [...new Set([...(target.goalIds || []), ...(source.goalIds || [])])]
      target.evidence = [...new Set([...(target.evidence || []), ...(source.evidence || [])])].slice(-40)
      target.mergedFrom = [...new Set([...(target.mergedFrom || []), source.id, ...(source.mergedFrom || [])])]
      target.occurrences = (target.occurrences || 1) + (source.occurrences || 1)
      target.importance = Math.max(target.importance || 1, source.importance || 1)
      // Keep the weaker confidence: a merged record must not look better
      // verified than the weakest evidence it now contains.
      target.confidence = Math.min(target.confidence ?? 1, source.confidence ?? 1)
      if (!target.location && source.location) target.location = source.location
      if (!target.provenance && source.provenance) target.provenance = source.provenance
      source.status = 'archived'
      source.supersededBy = target.id
      source.archivedAt = this.now()
      source.updatedAt = this.now()
    }
    // A record built from contradictory bases is not "verified".
    if (new Set([target.basis, ...sources.map((x) => x.basis)]).size > 1) target.basis = 'inferred'
    target.ts = earliestTs
    target.createdAt = new Date(earliestTs).toISOString()
    target.revision = (target.revision || 0) + 1
    target.updatedAt = this.now()
    target.lastEditReason = reason ? clip(reason, 160) : `merged ${sources.length} records`
    this._invalidateCache()
    this.save()
    return { ok: true, entry: target, archived: sources.map((x) => x.id) }
  }

  /** Groups of active records that say nearly the same thing. Non-destructive. */
  duplicates ({ threshold = 0.9, limit = 25, categories = null } = {}) {
    const active = this.entries.filter((e) => e.status === 'active' && (!categories || categories.includes(e.category)))
    const groups = []
    const taken = new Set()
    for (let i = 0; i < active.length; i++) {
      const a = active[i]
      if (taken.has(a.id)) continue
      const group = [a]
      const av = a._vec || (a._vec = embed(a.text))
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j]
        if (taken.has(b.id) || b.category !== a.category || b.basis !== a.basis) continue
        if (JSON.stringify(b.location || null) !== JSON.stringify(a.location || null)) continue
        const sim = cosine(av, b._vec || (b._vec = embed(b.text)))
        if (sim >= threshold) group.push(b)
      }
      if (group.length > 1) {
        for (const g of group) taken.add(g.id)
        groups.push({
          ids: group.map((g) => g.id),
          similarity: Math.round(threshold * 100) / 100,
          category: a.category,
          entries: group.map((g) => ({ id: g.id, text: clip(g.text, 160), importance: g.importance, basis: g.basis, ts: g.ts }))
        })
        if (groups.length >= limit) break
      }
    }
    return groups
  }

  // --------------------------------------------------------- maintenance --
  /**
   * One maintenance pass. Conservative by construction:
   *   - expired low-value episodic records are archived (never deleted),
   *   - genuine duplicates are merged only above a high similarity threshold,
   *   - old versions of a live subject are marked `outdated` (still readable),
   *   - capacity pressure archives low-value records, never foundational ones.
   * Returns a report instead of performing any change the caller cannot see.
   */
  maintain ({ now = this.now(), episodicTtlMs = 30 * 24 * 60 * 60_000, duplicateThreshold = 0.94, maxActive = this.maxEntries } = {}) {
    const report = { archived: 0, merged: [], outdated: 0, duplicatesRemaining: [], active: 0, total: 0, foundational: 0, archivedTotal: 0 }
    // 1a. Expire low-value episodic noise.
    for (const entry of this.entries) {
      const age = now - (entry.updatedAt || entry.ts || now)
      if (entry.status === 'active' && entry.category === 'episodic' && !entry.foundational && (entry.importance || 0) <= 1 && age > episodicTtlMs) {
        entry.status = 'archived'
        entry.archivedAt = now
        entry.archiveReason = 'episodic retention window expired'
        report.archived++
      }
    }
    // 1b. Legacy backfill cleanup: older builds promoted ordinary telemetry
    // ("X took damage 16m away") into curated memory. Those rows are not
    // knowledge; archive them (ids, tags and provenance stay readable) so real
    // memories are findable again. This is a one-time effect per row.
    report.legacyArchived = 0
    for (const entry of this.entries) {
      if (entry.status !== 'active') continue
      const tags = (entry.tags || []).map((t) => String(t).toLowerCase())
      if (tags.includes('fact') || tags.includes('note') || tags.includes('relationship') || tags.includes('agreement') || tags.includes('lesson')) continue
      const legacyTelemetry = tags.some((t) => TELEMETRY_ONLY_TYPES.has(t)) ||
        LEGACY_TELEMETRY_TEXT.test(String(entry.text || ''))
      if (!legacyTelemetry) continue
      // An importance-3 damage row was still telemetry; it is preserved by the
      // archive, not by pretending it was curated knowledge.
      entry.status = 'archived'
      entry.archivedAt = now
      entry.archiveReason = 'legacy telemetry row (not curated knowledge)'
      entry.foundational = false
      report.archived++
      report.legacyArchived++
    }
    // 2. Merge true duplicates (same category/basis/location, >= threshold).
    for (const group of this.duplicates({ threshold: duplicateThreshold })) {
      const res = this.merge({ ids: group.ids, reason: 'maintenance: duplicate merge' })
      if (res.ok) report.merged.push({ into: res.entry.id, archived: res.archived })
    }
    // 3. Old versions of a live subject are superseded, not forgotten.
    const bySubject = new Map()
    for (const entry of this.entries) {
      if (entry.status !== 'active' || !entry.subjectKey || entry.category !== 'semantic') continue
      const list = bySubject.get(entry.subjectKey) || []
      list.push(entry)
      bySubject.set(entry.subjectKey, list)
    }
    for (const list of bySubject.values()) {
      if (list.length < 2) continue
      list.sort((a, b) => (b.lastVerifiedAt || b.ts || 0) - (a.lastVerifiedAt || a.ts || 0))
      for (const stale of list.slice(1)) {
        stale.status = 'outdated'
        stale.supersededBy = list[0].id
        stale.updatedAt = now
        report.outdated++
      }
    }
    // 4. Capacity: archive the least valuable active records, never foundational.
    const active = this.entries.filter((e) => e.status === 'active')
    if (active.length > maxActive) {
      active.sort((a, b) => (a.importance || 0) - (b.importance || 0) || (a.confidence || 0) - (b.confidence || 0) || (a.updatedAt || a.ts) - (b.updatedAt || b.ts))
      for (const e of active.slice(0, active.length - maxActive)) {
        if (e.foundational) continue
        e.status = 'archived'
        e.archivedAt = now
        e.archiveReason = 'active capacity exceeded'
        report.archived++
      }
    }
    report.duplicatesRemaining = this.duplicates({ threshold: duplicateThreshold, limit: 10 }).map((g) => g.ids)
    report.active = this.entries.filter((e) => e.status === 'active').length
    report.total = this.entries.length
    report.foundational = this.entries.filter((e) => e.foundational && e.status === 'active').length
    report.archivedTotal = this.entries.filter((e) => e.status === 'archived').length
    this._invalidateCache()
    this.save()
    return report
  }

  /** Backwards-compatible consolidation entry point. */
  consolidate () {
    this.maintain({ duplicateThreshold: 0.94 })
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
    const activeEntries = this.entries.filter((e) => e.status !== 'outdated' && e.status !== 'archived')
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
      if (e.status === 'outdated' || e.status === 'archived' || e.status === 'deleted') continue
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
    includeArchived = false,
    includeDeleted = false,
    budgetChars = 0,
    k = 4
  } = {}) {
    const cacheKey = JSON.stringify({ query, category, entity, near, radius, goalId, sinceMs, includeContradicted, includeArchived, includeDeleted, budgetChars, k })
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
      if (e.status === 'archived' && !includeArchived) continue
      if (e.status === 'deleted' && !includeDeleted) continue
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
    let top = scored.slice(0, k)
    if (budgetChars > 0) {
      const kept = []
      let used = 0
      for (const hit of top) {
        const cost = String(hit.text || '').length + 48
        if (used + cost > budgetChars) break
        used += cost
        kept.push(hit)
      }
      top = kept
    }
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

  /**
   * Text search with an explicit match explanation, used by the `memory`
   * tool. Unlike `retrieve` (which is for automatic prompt context), this is
   * allowed to browse archived records and to report *why* something matched.
   */
  search ({
    query = '',
    category = null,
    entity = null,
    status = 'active',
    near = null,
    goalId = null,
    sinceMs = null,
    k = 8,
    budgetChars = 1400
  } = {}) {
    const res = this.retrieve({
      query,
      category,
      entity,
      near,
      goalId,
      sinceMs,
      includeContradicted: true,
      includeArchived: status === 'archived' || status === 'all',
      k,
      budgetChars
    })
    const entries = res.entries.filter((e) => {
      if (status === 'all') return e.status !== 'deleted'
      if (status === 'archived') return e.status === 'archived'
      return e.status === 'active' || e.status === 'contradicted'
    })
    return { ...res, entries, totalStoreSize: this.entries.length }
  }

  /** Counting metadata only; never returns memory text. */
  stats () {
    const by = {}
    for (const e of this.entries) by[`${e.category}/${e.status}`] = (by[`${e.category}/${e.status}`] || 0) + 1
    return {
      file: this.file,
      total: this.entries.length,
      byCategoryStatus: by,
      foundational: this.entries.filter((e) => e.foundational).length,
      withEvidence: this.entries.filter((e) => (e.evidence || []).length > 0).length,
      maxEntries: this.maxEntries
    }
  }
}

/** Facade: one object the rest of the app talks to. */
class MemorySystem {
  /**
   * @param {{
   *   file?: string, preferencesFile?: string, dataDir?: string,
   *   historyDir?: string, entitiesDir?: string,
   *   history?: HistoryLog, profiles?: ProfileStore,
   *   workingMax?: number, shortTermMinutes?: number, ephemeralMs?: number,
   *   retainDays?: number, maxEntries?: number, now?: () => number
   * }} [opts]
   */
  constructor ({
    file,
    workingMax = 5,
    shortTermMinutes = 10,
    preferencesFile,
    dataDir = null,
    historyDir = null,
    entitiesDir = null,
    history = null,
    profiles = null,
    retainDays = 0,
    maxEntries = 500,
    ephemeralMs = 30_000,
    now = () => Date.now()
  } = {}) {
    this.now = now
    const store = file || path.join(__dirname, '..', 'zincai-data', 'memories.json')
    const baseDir = dataDir || path.dirname(store)
    this.working = new WorkingMemory(workingMax)
    this.shortTerm = new ShortTermMemory(shortTermMinutes)
    this.longTerm = new LongTermMemory(store, { now, maxEntries })
    this.ephemeral = new EphemeralMemory(ephemeralMs)
    this.preferences = new PreferenceTracker(preferencesFile || path.join(baseDir, 'preferences.json'))
    // Raw evidence + long-form dossiers: separate stores, separate files.
    this.history = history || new HistoryLog({ dir: historyDir || path.join(baseDir, 'history'), now, retainDays })
    this.profiles = profiles || new ProfileStore({ dir: entitiesDir || path.join(baseDir, 'entities'), now })
    this._recognitionCache = { key: '', at: 0, text: '' }
    this._contextCache = { key: '', at: 0, text: '' }
  }

  setSessionId (id) { this.history?.setSession?.(id) }

  /**
   * Live context plus raw history. Curated promotion is deliberately strict:
   * telemetry (`hurt`, `entity_hurt`, `player_arrived`, …) is evidence in the
   * history log and, where relevant, a dossier note — never a curated memory.
   */
  addEvent (evt, { promote = null, window = true } = {}) {
    if (window) this.working.push(evt)
    this.shortTerm.push(evt)
    this.ephemeral.push(evt)
    const importance = scoreImportance(evt)
    // Raw history is written by the perception funnel (`perceive`) — the one
    // place that sees every event with its provenance — so this method never
    // duplicates it and never promotes telemetry into curated memory.
    const historyRef = evt.historyRef || null
    const type = String(evt.type || '').toLowerCase()
    const shouldPromote = promote === null
      ? (importance >= 3 && !TELEMETRY_ONLY_TYPES.has(type))
      : Boolean(promote)
    if (shouldPromote) {
      this.longTerm.add(
        evt.msg || evt.text || JSON.stringify(evt),
        evt.tags || [evt.type || 'misc'],
        Math.max(1, importance),
        evt.provenance || { kind: evt.basis === 'reported' ? 'player claim' : evt.basis === 'inferred' ? 'inferred event' : 'direct observation', source: String(evt.sender || evt.type || 'unknown') },

        {
          category: evt.category || 'episodic',
          basis: evt.basis || 'observed',
          confidence: evt.confidence ?? 0.9,
          location: evt.where || undefined,
          entities: evt.entities || (evt.sender ? [evt.sender] : []),
          goalIds: evt.goalId ? [evt.goalId] : [],
          evidence: historyRef ? [historyRef] : [],
          profileId: evt.profileId || null
        }
      )
    }
    return historyRef
  }

  /**
   * Record a structured semantic, procedural, episodic, or continuity memory.
   * When the subject is a known entity and the text is long-form, the body is
   * also filed in that entity's dossier: a short curated memory points at it,
   * so the profile can grow without turning every memory into an essay.
   */
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
    source = 'self',
    evidence = [],
    profile = null
  } = {}) {
    const body = clip(String(text || ''), MAX_MEMORY_TEXT)
    if (!body) return null
    // A reported claim must be traceable to the conversation that produced it.
    let evidenceList = Array.isArray(evidence) ? evidence.map(String).filter(Boolean) : []
    if (!evidenceList.length && basis === 'reported' && entities.length) {
      const ref = this.latestHistoryRef(entities[0])
      if (ref) evidenceList = [ref]
    }
    let profileId = profile || null
    if (!profileId && entities.length === 1) {
      const found = this.profiles.get(entities[0])
      if (found) profileId = found.id
    }
    const entry = this.longTerm.add(
      body,
      tags,
      importance,
      { kind: `${basis}_${category}`, source },
      {
        category,
        basis,
        confidence,
        entities,
        location,
        goalIds,
        subjectKey,
        foundational,
        evidence: evidenceList,
        profileId
      }
    )
    if (profileId && entry) {
      this.profiles.linkMemories(profileId, [entry.id])
      this.profiles.linkEvidence(profileId, evidenceList)
    }
    return entry
  }

  /** Most recent raw record involving an entity, used to anchor reported claims. */
  latestHistoryRef (entity, categories = ['chat', 'relationships']) {
    try {
      const res = this.history.search({ entity: String(entity), categories, limit: 1 })
      return res.hits[0]?.ref || null
    } catch { return null }
  }

  // ------------------------------------------------------------- history --
  /** Append a raw historical record (never fed to the model automatically). */
  appendHistory (category, kind, text, meta = {}) {
    return this.history.append(category, text, { kind, ...meta })
  }

  searchHistory (opts = {}) { return this.history.search(opts) }

  readHistory (ref, opts = {}) { return this.history.read(ref, opts) }

  // ------------------------------------------------------------ profiles --
  /** Ensure a dossier exists for this player, keyed by UUID when one is known. */
  observePlayer (name, { uuid = null, at = null, kind = null, note = null, evidenceRef = null, interaction = false } = {}) {
    const display = String(name || '').trim()
    if (!display) return null
    const profile = this.profiles.ensure({ kind: 'player', uuid, name: display, at })
    if (!profile) return null
    if (interaction || kind) {
      profile.interactions = (profile.interactions || 0) + 1
      if (kind && note) {
        this.profiles.appendNote(profile.id, 'interactions', note, { at, source: 'observation', evidence: evidenceRef })
      }
      this.profiles.save(profile)
    }
    if (evidenceRef) this.profiles.linkEvidence(profile.id, [evidenceRef])
    return profile
  }

  /** Mirror Zinc's own considered relationship view into the dossier. */
  syncProfileFromRelationship (name, relationship = {}) {
    if (!name || !relationship) return null
    const profile = this.profiles.get(name) || this.observePlayer(name, { at: relationship.lastSeenAt || this.now() })
    if (!profile) return null
    const evidence = Array.isArray(relationship.experiences)
      ? relationship.experiences.slice(-3).map((e) => `relationship ${e.kind || 'note'}: ${clip(e.text, 180)}${e.at ? ` (${new Date(e.at).toISOString().slice(0, 10)})` : ''}`)
      : []
    this.profiles.update(profile.id, {
      relationship: {
        stance: relationship.stance ?? undefined,
        trust: relationship.trust ?? undefined,
        confidence: relationship.confidence ?? undefined,
        willingness: relationship.willingness ?? undefined,
        assessment: relationship.summary ?? undefined
      }
    }, { reason: 'synced from social relationship' })
    for (const line of evidence) this.profiles.appendNote(profile.id, 'interactions', line, { source: 'social' })
    if (relationship.lastProposal?.text) {
      this.profiles.appendNote(profile.id, 'interactions', `request "${clip(relationship.lastProposal.text, 120)}" -> ${relationship.lastProposal.decision}`, { at: relationship.lastProposal.at, source: 'social' })
    }
    return this.profiles.get(profile.id)
  }

  /**
   * Resolve a subject by name/uuid, creating the right *kind* of dossier when it
   * does not exist yet: a real player gets a player dossier (UUID-identified), a
   * place/group/other subject gets a generic one. Never invents a player.
   */
  ensureSubject (name, { uuid = null, kind = null } = {}) {
    const who = String(name || '').trim()
    if (!who) return null
    const existing = this.profiles.get(who)
    if (existing) return existing
    const resolvedKind = kind || (uuid ? 'player' : 'subject')
    return this.profiles.ensure({ kind: resolvedKind, uuid, name: who, at: this.now() })
  }

  /** Full dossier as Markdown (tool output). */
  playerProfile (key, { max = 6000 } = {}) {
    return this.profiles.render(key, { max, lookupMemory: (id) => this.longTerm.get(id) })
  }

  /**
   * Automatic recognition: the concise working-memory block shown when a
   * familiar player is visible, speaking, or referenced. Budgeted on purpose —
   * a dossier is one tool call away, the prompt gets the headline only.
   */
  recognitionBlock (names = [], { uuidOf = null, maxChars = 700, maxPlayers = 3 } = {}) {
    const list = [...new Set((names || []).map(String).filter(Boolean))].slice(0, maxPlayers)
    if (!list.length) return ''
    const now = this.now()
    // Resolve identity BEFORE consulting the cache: the same username with a
    // different UUID is a different person and must never reuse a cached view.
    const resolved = []
    for (const name of list) {
      let uuid = null
      try { uuid = uuidOf ? uuidOf(name) : null } catch { uuid = null }
      const profile = this.profiles.ensure({ kind: 'player', uuid, name, at: now })
      if (profile) resolved.push({ name, uuid, profile })
    }
    const key = JSON.stringify(resolved.map((r) => [r.name, r.uuid, r.profile.id, r.profile.revision, r.profile.updatedAt]))
    if (this._recognitionCache.key === key && now - this._recognitionCache.at < 4000) return this._recognitionCache.text
    const lines = []
    let used = 0
    for (const { name, uuid, profile } of resolved) {
      const knowsSomething = profile.interactions > 0 ||
        Boolean(profile.relationship.stance) ||
        (profile.evidence || []).length > 0 ||
        (profile.memoryIds || []).length > 0 ||
        ['interactions', 'preferences', 'behavior', 'facts', 'uncertainties', 'timeline', 'notes']
          .some((sec) => Array.isArray(profile.sections?.[sec]) && profile.sections[sec].length > 0)
      if (!knowsSomething) {
        // First sighting: one short, honest line, not an empty dossier dump.
        const seen = `first time I have seen ${name}` + (uuid ? ' (uuid recorded)' : ' (no UUID yet)')
        if (used + seen.length <= maxChars || !lines.length) { lines.push(`- ${seen}`); used += seen.length }
        continue
      }
      const summary = this.profiles.summary(profile, { maxChars: Math.max(120, Math.max(0, maxChars - used) - 12) })
      if (!summary) continue
      const tightened = summary.length > 260 ? `${summary.slice(0, 259)}…` : summary
      lines.push(`- ${tightened}`)
      used += tightened.length
      if (used >= maxChars) break
    }
    const text = lines.length ? `known players (from their own dossiers; evidence-backed):\n${lines.join('\n')}` : ''
    this._recognitionCache = { key, at: now, text }
    return text
  }

  // --------------------------------------------------------- retrieval ---
  /**
   * Automatic contextual retrieval for the next decision. Combines curated
   * recall with the player awareness that situation implies, and stays inside
   * a character budget. Cached for a couple of seconds so a prompt rebuild does
   * not re-run the ranking on every token.
   */
  contextBlock ({ query = '', goal = null, near = null, players = [], entity = null, budgetChars = 700, topK = 3, level = 0, includePlayers = true } = {}) {
    const parts = []
    const key = JSON.stringify({ query, goal: goal?.id || goal?.description || goal, near: near ? `${Math.round(near.x / 8)}:${Math.round(near.z / 8)}:${near.dim || ''}` : null, players, entity, budgetChars, level, includePlayers })
    const now = this.now()
    if (this._contextCache.key === key && now - this._contextCache.at < 3000) return this._contextCache.text
    const recognition = includePlayers
      ? this.recognitionBlock(players, { maxChars: Math.min(budgetChars, Math.max(180, budgetChars * 0.55)) })
      : ''
    if (recognition) parts.push(recognition)
    const q = String(query || (goal ? goal.description || '' : '')).trim()
    if (q || near || entity || goal?.id) {
      const res = this.longTerm.retrieve({
        query: q,
        near: near || null,
        goalId: goal?.id || null,
        entity: entity || null,
        includeArchived: false,
        includeContradicted: true,
        budgetChars: Math.max(120, Math.floor(budgetChars * 0.45)),
        k: topK
      })
      if (res.entries.length) {
        const header = MemorySystem.isRecallQuery(q) ? 'recalled:' : 'relevant memories:'
        const lines = res.entries.map((h) => `- (${h.importance}*) ${this.formatEntry(h)}`)
        parts.push(`${header}\n${lines.join('\n')}`)
      }
    }
    // Previous attempts at the same task, straight from the raw log: a bounded
    // keyword search (never a dump) that tells Zinc what already failed before
    // it repeats the mistake. Only at the cheap compaction tiers.
    if (level <= 1 && q.length >= 6 && this.history) {
      try {
        const used = parts.join('\n').length
        if (budgetChars - used > 140) {
          const past = this.history.search({ query: q, categories: ['errors', 'decisions', 'actions'], limit: 2, maxScanFiles: 4 })
          const lines = past.hits
            .filter((h) => String(h.text || '').length >= 16)
            .slice(0, 2)
            .map((h) => `- [${String(h.iso || '').slice(0, 10)}] ${clip(h.text, 150)} (${h.cat}/${h.kind})`)
          if (lines.length) parts.push(`past attempts (raw log):\n${lines.join('\n')}`)
        }
      } catch { /* retrieval must never break a prompt */ }
    }
    let text = parts.join('\n')
    if (text.length > budgetChars) text = `${text.slice(0, Math.max(0, budgetChars - 1))}…`
    this._contextCache = { key, at: now, text }
    return text
  }

  // ------------------------------------------------------- maintenance ---
  /**
   * Full maintenance: curated store (merge duplicates, supersede old versions,
   * archive expired noise) plus dossiers (normalise, dedupe, and report the
   * gaps a curator should fill). The report is also written to raw history so a
   * later session can see what was reorganised and why.
   */
  maintainAll ({ episodicTtlMs = 30 * 24 * 60 * 60_000, duplicateThreshold = 0.94, maxActive = null, retainDays = this.history.retainDays, now = this.now() } = {}) {
    // Age pruning is opt-in (`history.retainDays` > 0) and never touches the
    // evidence-bearing categories. Complete history is the default.
    let historyPruned = null
    try { historyPruned = this.history.prune({ retainDays, dryRun: true }) } catch (err) { historyPruned = { error: String(err?.message || err) } }
    if (historyPruned && historyPruned.removed > 0) {
      try { historyPruned = this.history.prune({ retainDays }) } catch (err) { historyPruned = { error: String(err?.message || err) } }
    }
    const curated = this.longTerm.maintain({
      now,
      episodicTtlMs,
      duplicateThreshold,
      ...(maxActive ? { maxActive } : {})
    })
    let profiles
    try { profiles = this.profiles.maintenance({ now }) } catch (err) { profiles = { error: String(err?.message || err) } }
    // Seed dossiers for recurring players that only exist as scattered legacy
    // memories (e.g. an upgraded deployment). Names come from the memory's own
    // `entities`/tags; nothing is invented about them.
    const seeded = []
    const entityCounts = new Map()
    for (const entry of this.longTerm.entries) {
      if (entry.status !== 'active') continue
      for (const name of entry.entities || []) {
        if (!looksLikePlayerName(name)) continue
        const list = entityCounts.get(name) || []
        list.push(entry)
        entityCounts.set(name, list)
      }
    }
    for (const [name, entries] of entityCounts) {
      if (entries.length < 2 || this.profiles.get(name)) continue
      const profile = this.profiles.ensure({ kind: 'player', name, at: now })
      if (!profile) continue
      const times = entries.map((e) => e.ts).filter(Boolean).sort((a, b) => a - b)
      if (times.length) {
        profile.firstSeenAt = Math.min(profile.firstSeenAt || times[0], times[0])
        profile.lastSeenAt = Math.max(profile.lastSeenAt || 0, times[times.length - 1])
        this.profiles.save()
      }
      this.profiles.appendNote(profile.id, 'description', `Recurring player known from ${entries.length} memories${(profile.uuid ? '' : '; identity is name-only until their UUID is observed')}.`, { source: 'maintenance' })
      for (const entry of entries.slice(0, 20)) {
        this.profiles.linkMemories(profile.id, [entry.id])
        if ((entry.evidence || []).length) this.profiles.linkEvidence(profile.id, entry.evidence)
      }
      seeded.push({ id: profile.id, name, memories: entries.length })
    }

    // Link curated memories that mention a known player but were never filed in
    // that player's dossier (Zinc "noticed but did not incorporate").
    const unincorporated = []
    for (const entry of this.longTerm.entries) {
      if (entry.status !== 'active' || !(entry.entities || []).length) continue
      for (const name of entry.entities) {
        const profile = this.profiles.get(name)
        if (!profile) continue
        if (!(profile.memoryIds || []).includes(entry.id)) {
          unincorporated.push({ memoryId: entry.id, profileId: profile.id, text: clip(entry.text, 120) })
          if (unincorporated.length <= 25) this.profiles.linkMemories(profile.id, [entry.id])
          if ((entry.evidence || []).length) this.profiles.linkEvidence(profile.id, entry.evidence)
        }
      }
    }
    const report = {
      at: now,
      curated,
      historyPruned,
      profiles,
      seededProfiles: seeded,
      unincorporated: unincorporated.slice(0, 25),
      duplicatesRemaining: curated.duplicatesRemaining
    }
    try {
      this.history.append('maintenance', `maintenance: ${curated.merged.length} merged, ${curated.archived} archived, ${curated.outdated} superseded, ${profiles.needsAssessment?.length || 0} dossiers need assessment`, { kind: 'organize', at: now, data: { curated: { ...curated, merged: curated.merged.length }, profiles } })
    } catch { /* history is best effort */ }
    return report
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
  rememberChat (sender, text, { addressed = false, evidence = null } = {}) {
    const t = String(text || '').trim()
    if (!sender || t.length < 8) return null
    const f = fold(t)
    const isAgreement = /\b(combinad\w*|agreed|deal|promet\w*|vamos construir|ponte publica)\b/.test(f)
    // Only a DURABLE claim is worth a curated row: a coordinate, a structure or
    // container, ownership/possession, a stated preference, or an agreement.
    // Ordinary conversation ("oi", "vou minerar agora") stays in raw history and
    // in the player's dossier evidence — promoting it drowned real knowledge.
    const durable = /\b-?\d{1,5}\s*[,/ ]\s*-?\d{1,3}\s*[,/ ]\s*-?\d{1,5}\b/.test(f) ||
      /\b(base|casa|home|house|chest|barrel|farm|fazenda|mina|mine|portal|bed|cama|storage|forja|forge|workshop|oficina)\b/.test(f) ||
      /\b(prefiro|prefer|odeio|hate|adoro|love|alergic\w*|allergic\w*)\b/.test(f) ||
      /\b(meu|minha|my|nosso|nossa|our)\b.{0,30}\b(chest|base|farm|house|casa|mine|mina|portal|barrel)\b/.test(f)
    if ((!durable && !isAgreement) || /\?\s*$/.test(t)) return null
    const profile = this.profiles.ensure({ kind: 'player', name: String(sender), at: this.now() })
    const entry = this.longTerm.add(
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
        foundational: isAgreement,
        evidence: evidence ? [String(evidence)] : [],
        profileId: profile?.id || null
      }
    )
    if (profile && entry) {
      this.profiles.linkMemories(profile.id, [entry.id])
      if (evidence) this.profiles.linkEvidence(profile.id, [String(evidence)])
    }
    return entry
  }

  /**
   * A player statement summarized by the chat lane (`reply.remember`).
   * Stored strictly as an UNVERIFIED reported statement (`basis: 'reported'`),
   * unless it is an explicit social agreement with that player.
   */
  rememberFact (text, { about = '', evidence = null } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    if (t.length < 6) return null
    const who = String(about || '').trim()
    const isAgreement = /\b(agreed|agreement|combinad\w*|deal|shared|public)\b/i.test(t)
    const profile = who ? this.profiles.ensure({ kind: 'player', name: who, at: this.now() }) : null
    const entry = this.longTerm.add(
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
        foundational: isAgreement,
        evidence: evidence ? [String(evidence)] : [],
        profileId: profile?.id || null
      }
    )
    if (profile && entry) {
      this.profiles.appendNote(profile.id, 'facts', `[reported by ${who}, unverified] ${clip(t, 300)}`, { source: 'player statement', evidence })
      this.profiles.linkMemories(profile.id, [entry.id])
    }
    return entry
  }

  factsAbout (name, limit = 6) {
    const who = String(name || '').trim()
    if (!who) return []
    const low = fold(who)
    const mine = this.longTerm.entries.filter((e) => {
      if (e.status === 'outdated') return false
      const tags = e.tags || []
      if (!tags.includes('fact') && !tags.includes('chat') && !(e.entities || []).some((x) => fold(x) === low)) return false
      return (e.tags || []).some((t) => fold(t) === low) || (e.entities || []).some((x) => fold(x) === low) ||
        hasWholeWord(e.text, who)
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

  save () {
    this.longTerm.save()
    this.preferences.save()
    try { this.history.save() } catch { /* best effort */ }
    return { memories: this.longTerm.entries.length, profiles: Object.keys(this.profiles.index.entries).length }
  }

  stats () {
    let history = null
    try { history = this.history.stats() } catch { history = null }
    return {
      curated: this.longTerm.stats(),
      history,
      profiles: {
        dir: this.profiles.dir,
        total: Object.keys(this.profiles.index.entries).length,
        byKind: Object.values(this.profiles.index.entries).reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc }, {}),
        corrupt: this.profiles.corruptions.length
      },
      working: { window: this.working.items.length, shortTerm: this.shortTerm.items.length, ephemeral: this.ephemeral.items.length }
    }
  }
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

module.exports = {
  MemorySystem,
  WorkingMemory,
  ShortTermMemory,
  LongTermMemory,
  EphemeralMemory,
  PreferenceTracker,
  embed,
  cosine,
  tokenize,
  fold,
  clip,
  scoreImportance,
  extractLocationFromText,
  SYNONYMS,
  looksLikePlayerName,
  MEMORY_CATEGORIES,
  MEMORY_BASES,
  MEMORY_STATUSES,
  TELEMETRY_ONLY_TYPES,
  HistoryLog,
  ProfileStore
}
