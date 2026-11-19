/**
 * entities.js — long-form, durable dossiers about *subjects*: players, Zinc
 * itself, places, groups and recurring events.
 *
 * Why a separate store from `memories.json`:
 *   - A durable memory is one fact with provenance metadata. A dossier is a
 *     living document that grows (description, relationship, interactions,
 *     preferences, behaviour, uncertainties, evidence) and is written in
 *     Markdown a human can read.
 *   - Subjects need stable identity. A player dossier is keyed by Minecraft
 *     UUID, never by username: names change, and two accounts must never share
 *     a dossier. A name-only dossier is created only when no UUID is known yet,
 *     and is upgraded in place the first time a UUID is seen.
 *   - One file per subject (`<data>/entities/player-<uuid>.json`) keeps writes
 *     atomic and isolates corruption: a damaged dossier is quarantined and
 *     rebuilt, while every other subject stays intact.
 *
 * The store is deliberately independent of the game runtime: it takes plain
 * `{ uuid, name }` inputs and can therefore be tested without a bot.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { fold, tokenize, clip, hasWholeWord } = require('./memory_text')

const PROFILE_SCHEMA = 1
const SECTIONS = ['identity', 'description', 'interactions', 'preferences', 'behavior', 'facts', 'uncertainties', 'timeline', 'notes']
const MAX_SECTION_ITEMS = 60
const MAX_ITEM_CHARS = 600
const MAX_DOC_CHARS = 20_000
const MAX_EVIDENCE = 200
const MAX_MEMORY_LINKS = 200
const MAX_NAMES = 10
const MAX_TAGS = 24

const SECTION_TITLES = {
  identity: 'Identity notes',
  description: 'General description',
  interactions: 'Important interactions',
  preferences: 'Preferences',
  behavior: 'Observed behaviour',
  facts: 'Important facts',
  uncertainties: 'Uncertainties',
  timeline: 'History / relationship changes',
  notes: 'Notes'
}

const KINDS = new Set(['player', 'self', 'place', 'group', 'event', 'subject'])

function nowIso (ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : 'unknown'
}

function slug (s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown'
}

function normalizeUuid (uuid) {
  const u = String(uuid || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(u)
    ? u.replace(/([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})/, '$1-$2-$3-$4-$5')
    : (u || null)
}

function cleanItem (text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS)
}

function normalizeSection (list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const item = raw && typeof raw === 'object'
      ? {
          at: Number.isFinite(raw.at) ? raw.at : null,
          text: cleanItem(raw.text),
          source: raw.source ? String(raw.source).slice(0, 40) : null,
          ref: raw.ref ? String(raw.ref).slice(0, 120) : null
        }
      : { at: null, text: cleanItem(raw), source: null, ref: null }
    if (!item.text) continue
    const key = fold(item.text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.slice(-MAX_SECTION_ITEMS)
}

function emptyProfile ({ kind = 'player', uuid = null, name = null, now = Date.now() } = {}) {
  const k = KINDS.has(kind) ? kind : 'subject'
  const u = normalizeUuid(uuid)
  const display = clip(String(name || '').trim(), 40) || (k === 'self' ? 'Zinc' : 'unknown')
  const key = u ? `${k}:${u}` : `${k}:name:${slug(display)}`
  return {
    schema: PROFILE_SCHEMA,
    id: key,
    kind: k,
    uuid: u,
    identityBasis: u ? 'uuid' : 'name-only',
    names: [display],
    displayName: display,
    aliasesStale: [],
    firstSeenAt: now,
    firstSeenNote: null,
    lastSeenAt: now,
    interactions: 0,
    relationship: {
      stance: null,
      trust: null,
      confidence: null,
      willingness: null,
      assessment: '',
      updatedAt: null,
      evidence: []
    },
    sections: {
      identity: [],
      description: [],
      interactions: [],
      preferences: [],
      behavior: [],
      facts: [],
      uncertainties: [],
      timeline: [],
      notes: []
    },
    doc: '',
    evidence: [],
    memoryIds: [],
    tags: [],
    status: 'active',
    supersededBy: null,
    mergedFrom: [],
    revision: 0,
    createdAt: now,
    updatedAt: now
  }
}

class ProfileStore {
  /**
   * @param {{ dir?: string, now?: () => number, logger?: object }} [opts]
   */
  constructor (opts = {}) {
    this.dir = opts.dir || path.join(process.cwd(), 'data', 'entities')
    this.now = opts.now || (() => Date.now())
    this.logger = opts.logger || null
    this.cache = new Map()
    this.corruptions = []
    this.index = { version: 1, byUuid: {}, byName: {}, entries: {} }
    this._loadIndex()
  }

  // ------------------------------------------------------------- storage --
  _indexFile () { return path.join(this.dir, 'index.json') }

  _fileName (id) {
    return `${String(id).replace(/:\/\/?/g, '-').replace(/[^a-zA-Z0-9_.-]+/g, '-')}.json`
  }

  _loadIndex () {
    let loaded = false
    try {
      const raw = JSON.parse(fs.readFileSync(this._indexFile(), 'utf8'))
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
        this.index = {
          version: 1,
          byUuid: raw.byUuid && typeof raw.byUuid === 'object' ? raw.byUuid : {},
          byName: raw.byName && typeof raw.byName === 'object' ? raw.byName : {},
          entries: raw.entries
        }
        loaded = true
      }
    } catch { loaded = false }
    if (!loaded) this._rebuildIndex()
  }

  _rebuildIndex () {
    this.index = { version: 1, byUuid: {}, byName: {}, entries: {} }
    let files = []
    try { files = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && n !== 'index.json') } catch { return }
    for (const name of files) {
      const file = path.join(this.dir, name)
      try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!entry || !entry.id) continue
        this._indexEntry(entry, name)
      } catch { this._quarantine(file, 'index rebuild: unreadable') }
    }
    if (files.length) this._saveIndex()
  }

  _saveIndex () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this._indexFile()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.index), 'utf8')
      fs.renameSync(tmp, this._indexFile())
    } catch (err) {
      this.logger?.warn?.('entities', `index save failed: ${err?.message || err}`)
    }
  }

  _indexEntry (entry, fileName = null) {
    const file = fileName || this.index.entries[entry.id]?.file || this._fileName(entry.id)
    this.index.entries[entry.id] = {
      kind: entry.kind,
      uuid: entry.uuid || null,
      names: (entry.names || []).slice(0, MAX_NAMES),
      file,
      status: entry.status || 'active',
      updatedAt: entry.updatedAt || entry.firstSeenAt || null
    }
    if (entry.uuid) this.index.byUuid[entry.uuid] = entry.id
    for (const name of entry.names || []) {
      const k = fold(name)
      if (!k) continue
      // Keep the most recently updated profile for a reused username.
      const other = this.index.byName[k]
      if (!other || other === entry.id) this.index.byName[k] = entry.id
      else {
        const otherAt = this.index.entries[other]?.updatedAt || 0
        if ((entry.updatedAt || 0) >= otherAt) this.index.byName[k] = entry.id
      }
    }
  }

  _quarantine (file, why) {
    const target = `${file}.corrupt-${this.now()}`
    try { fs.renameSync(file, target) } catch { /* keep the original if renaming fails */ }
    this.corruptions.push({ file: path.basename(file), at: this.now(), why, quarantine: path.basename(target) })
    this.logger?.warn?.('entities', `quarantined corrupt profile ${path.basename(file)} (${why})`)
    return target
  }

  _read (file) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!entry || !entry.id) throw new Error('missing id')
      return this._normalize(entry)
    } catch (err) {
      this._quarantine(file, `unreadable: ${err?.message || err}`)
      return null
    }
  }

  _normalize (entry) {
    const out = {
      ...emptyProfile({ kind: entry.kind, uuid: entry.uuid || null, name: entry.displayName || (entry.names || [])[0] || null, now: Number.isFinite(entry.firstSeenAt) ? entry.firstSeenAt : this.now() }),
      ...entry
    }
    out.schema = PROFILE_SCHEMA
    out.kind = KINDS.has(out.kind) ? out.kind : 'subject'
    out.uuid = normalizeUuid(out.uuid)
    out.identityBasis = out.uuid ? 'uuid' : (out.identityBasis || 'name-only')
    out.names = [...new Set((Array.isArray(out.names) ? out.names : []).map((n) => clip(String(n), 40)).filter(Boolean))].slice(0, MAX_NAMES)
    out.displayName = clip(String(out.displayName || out.names[0] || 'unknown'), 40)
    out.firstSeenAt = Number.isFinite(out.firstSeenAt) ? out.firstSeenAt : this.now()
    out.lastSeenAt = Number.isFinite(out.lastSeenAt) ? out.lastSeenAt : out.firstSeenAt
    out.interactions = Number.isFinite(out.interactions) ? out.interactions : 0
    out.relationship = {
      stance: out.relationship?.stance ? clip(out.relationship.stance, 48) : null,
      trust: Number.isFinite(out.relationship?.trust) ? Math.max(-100, Math.min(100, Math.trunc(out.relationship.trust))) : null,
      confidence: Number.isFinite(out.relationship?.confidence) ? Math.max(0, Math.min(100, Math.trunc(out.relationship.confidence))) : null,
      willingness: out.relationship?.willingness ? clip(out.relationship.willingness, 80) : null,
      assessment: clip(out.relationship?.assessment || '', 400),
      updatedAt: Number.isFinite(out.relationship?.updatedAt) ? out.relationship.updatedAt : null,
      evidence: Array.isArray(out.relationship?.evidence) ? out.relationship.evidence.slice(-20) : []
    }
    const rawSections = (out.sections && typeof out.sections === 'object') ? out.sections : {}
    out.sections = {}
    for (const section of SECTIONS) out.sections[section] = normalizeSection(rawSections[section])
    out.doc = String(out.doc || '').slice(0, MAX_DOC_CHARS)
    out.evidence = (Array.isArray(out.evidence) ? out.evidence : [])
      .map((e) => (typeof e === 'string' ? { ref: e, at: null, note: null } : { ref: String(e?.ref || ''), at: Number.isFinite(e?.at) ? e.at : null, note: e?.note ? clip(e.note, 200) : null }))
      .filter((e) => e.ref)
      .slice(-MAX_EVIDENCE)
    out.memoryIds = [...new Set((Array.isArray(out.memoryIds) ? out.memoryIds : []).map(String))].slice(-MAX_MEMORY_LINKS)
    out.tags = [...new Set((Array.isArray(out.tags) ? out.tags : []).map((t) => clip(String(t), 32)).filter(Boolean))].slice(0, MAX_TAGS)
    out.status = ['active', 'archived', 'merged'].includes(out.status) ? out.status : 'active'
    out.revision = Number.isFinite(out.revision) ? out.revision : 0
    out.updatedAt = Number.isFinite(out.updatedAt) ? out.updatedAt : out.firstSeenAt
    return out
  }

  save (entry) {
    if (!entry || !entry.id) return null
    const normalized = this._normalize(entry)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const file = path.join(this.dir, this.index.entries[normalized.id]?.file || this._fileName(normalized.id))
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(normalized), 'utf8')
      fs.renameSync(tmp, file)
      this._indexEntry(normalized, path.basename(file))
      this._saveIndex()
      this.cache.set(normalized.id, normalized)
      return normalized
    } catch (err) {
      this.logger?.warn?.('entities', `save failed for ${entry.id}: ${err?.message || err}`)
      return null
    }
  }

  // -------------------------------------------------------------- lookup --
  /** Resolve any of: profile id, UUID, username. */
  resolveKey (key) {
    const k = String(key || '').trim()
    if (!k) return null
    if (this.index.entries[k]) return k
    const uuid = normalizeUuid(k)
    if (uuid && this.index.byUuid[uuid]) return this.index.byUuid[uuid]
    const byName = this.index.byName[fold(k)]
    if (byName) return byName
    // `player:name:foo`, `place:spawn` etc.
    const short = k.replace(/^[a-z]+:/i, '')
    if (this.index.entries[short]) return short
    return null
  }

  get (key, { includeArchived = true } = {}) {
    const id = this.resolveKey(key)
    if (!id) return null
    const meta = this.index.entries[id]
    if (!meta) return null
    if (!includeArchived && meta.status === 'archived') return null
    if (this.cache.has(id)) return this.cache.get(id)
    const entry = this._read(path.join(this.dir, meta.file))
    if (!entry) {
      delete this.index.entries[id]
      this._saveIndex()
      return null
    }
    this.cache.set(id, entry)
    return entry
  }

  list ({ kind = null, includeArchived = false } = {}) {
    const out = []
    for (const [id, meta] of Object.entries(this.index.entries)) {
      if (kind && meta.kind !== kind) continue
      if (!includeArchived && meta.status === 'archived') continue
      const entry = this.get(id)
      if (entry) out.push(entry)
    }
    out.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    return out
  }

  /**
   * Find or create the dossier for a subject. Identity rules:
   *   - UUID wins. A name-only dossier is upgraded in place the first time its
   *     owner's UUID is observed, keeping all existing history.
   *   - A UUID never merges into a dossier owned by a different UUID: the same
   *     username used by another account gets its own dossier.
   */
  ensure ({ uuid = null, name = null, kind = 'player', at = null } = {}) {
    const k = KINDS.has(kind) ? kind : 'subject'
    const u = normalizeUuid(uuid)
    const display = clip(String(name || '').trim(), 40)
    const ts = Number.isFinite(at) ? at : this.now()
    if (!u && !display) return null
    let id = (u && this.index.byUuid[u]) || (display && this.index.byName[fold(display)]) || null
    let entry = id ? this.get(id) : null
    let created = false

    // Same username, different account: never share a dossier.
    if (entry && u && entry.uuid && entry.uuid !== u) {
      id = this.index.byUuid[u] || null
      entry = id ? this.get(id) : null
    }

    if (!entry) {
      const base = emptyProfile({ kind: k, uuid: u, name: display, now: ts })
      // A name-only subject keeps its name in the id so re-identification can
      // upgrade it; a UUID subject is id-stable from the first sighting.
      id = base.id
      const base2 = this.index.entries[id]
      if (base2) id = `${id}-${slug(display)}-${ts.toString(36)}`
      entry = { ...base, id }
      created = true
    } else if (entry.status === 'archived') {
      entry.status = 'active'
      entry.archivedAt = null
    }

    let dirty = created
    if (u && !entry.uuid) {
      entry.uuid = u
      entry.identityBasis = 'uuid'
      dirty = true
    }
    if (display && !entry.names.some((n) => fold(n) === fold(display))) {
      if (entry.names.length >= MAX_NAMES) {
        // Keep the oldest name (it is the earliest identity evidence) and the
        // newest; the middle one is moved to `aliasesStale` rather than lost.
        const dropped = entry.names.splice(1, 1)[0]
        if (dropped) entry.aliasesStale = [...new Set([...(entry.aliasesStale || []), dropped])].slice(-20)
      }
      entry.names.push(display)
      dirty = true
    }
    if (created) {
      entry.sections.description = [{ at: ts, text: `${display || 'subject'} first encountered ${nowIso(ts)}.`, source: 'observation', ref: null }]
    }
    entry.lastSeenAt = ts
    if (u && display && entry.kind === 'player') {
      entry.aliasPeriods ||= []
      const last = entry.aliasPeriods.at(-1)
      if ((!last || fold(last.name) !== fold(display)) && (!last || ts >= last.observedFrom)) {
        if (last) last.replacedByObservationAt = ts
        entry.aliasPeriods.push({ name: display, observedFrom: ts, replacedByObservationAt: null })
        dirty = true
      }
    }
    if (entry.kind === 'player' && display && fold(entry.displayName) !== fold(display)) {
      // A rename is identity evidence worth keeping: record the previous name.
      if (!entry.aliasesStale.includes(entry.displayName)) entry.aliasesStale = [...new Set([...(entry.aliasesStale || []), entry.displayName])].slice(-20)
      entry.displayName = display
      dirty = true
    }
    if (dirty) this.save(entry)
    return entry
  }

  // --------------------------------------------------------------- edits --
  update (key, patch = {}, { reason = '' } = {}) {
    const entry = this.get(key)
    if (!entry) return { ok: false, msg: `no entity profile for "${key}"` }
    const before = { relationship: { ...entry.relationship }, displayName: entry.displayName, status: entry.status }
    let dirty = false
    if (patch.displayName) {
      const name = clip(String(patch.displayName), 40)
      if (name && !entry.names.some((n) => fold(n) === fold(name))) entry.names.push(name)
      entry.displayName = name
      dirty = true
    }
    if (Array.isArray(patch.names)) {
      for (const name of patch.names) {
        const n = clip(String(name), 40)
        if (n && !entry.names.some((x) => fold(x) === fold(n))) { entry.names.push(n); dirty = true }
      }
      entry.names = entry.names.slice(-MAX_NAMES)
    }
    if (patch.relationship && typeof patch.relationship === 'object') {
      const r = patch.relationship
      if (r.stance !== undefined) entry.relationship.stance = r.stance ? clip(String(r.stance), 48) : null
      if (r.trust !== undefined) entry.relationship.trust = Number.isFinite(Number(r.trust)) ? Math.max(-100, Math.min(100, Math.trunc(Number(r.trust)))) : null
      if (r.confidence !== undefined) entry.relationship.confidence = Number.isFinite(Number(r.confidence)) ? Math.max(0, Math.min(100, Math.trunc(Number(r.confidence)))) : null
      if (r.willingness !== undefined) entry.relationship.willingness = r.willingness ? clip(String(r.willingness), 80) : null
      if (r.assessment !== undefined) entry.relationship.assessment = clip(String(r.assessment), 400)
      entry.relationship.updatedAt = this.now()
      dirty = true
    }
    if (patch.tags) {
      entry.tags = [...new Set([...entry.tags, ...(Array.isArray(patch.tags) ? patch.tags : [patch.tags])].map((t) => clip(String(t), 32)).filter(Boolean))].slice(0, MAX_TAGS)
      dirty = true
    }
    if (patch.doc !== undefined) {
      entry.doc = String(patch.doc || '').slice(0, MAX_DOC_CHARS)
      dirty = true
    }
    if (patch.status && ['active', 'archived'].includes(patch.status)) {
      entry.status = patch.status
      entry.archivedAt = patch.status === 'archived' ? this.now() : null
      dirty = true
    }
    if (Array.isArray(patch.evidence)) { this._mergeEvidence(entry, patch.evidence); dirty = true }
    // Keep the previous assessment: a relationship that changes is itself
    // history, and the old view must remain auditable.
    const changedRel = JSON.stringify(before.relationship) !== JSON.stringify(entry.relationship)
    if (changedRel) {
      const old = [
        before.relationship.stance ? `stance=${before.relationship.stance}` : null,
        before.relationship.trust !== null && before.relationship.trust !== undefined ? `trust=${before.relationship.trust}` : null,
        before.relationship.assessment ? `"${clip(before.relationship.assessment, 120)}"` : null
      ].filter(Boolean).join(', ')
      const next = [
        entry.relationship.stance ? `stance=${entry.relationship.stance}` : null,
        entry.relationship.trust !== null ? `trust=${entry.relationship.trust}` : null,
        entry.relationship.assessment ? `"${clip(entry.relationship.assessment, 160)}"` : null
      ].filter(Boolean).join(', ')
      this._appendRaw(entry, 'timeline', old ? `relationship changed from ${old} to ${next}` : `relationship assessed: ${next}`, { source: 'self', reason })
    }
    if (!dirty) return { ok: true, unchanged: true, entry }
    entry.revision += 1
    entry.updatedAt = this.now()
    const saved = this.save(entry)
    return saved ? { ok: true, entry: saved } : { ok: false, msg: 'write failed; the previous dossier is intact' }
  }

  _appendRaw (entry, section, text, meta = {}) {
    const key = SECTIONS.includes(section) ? section : 'notes'
    const item = {
      at: Number.isFinite(meta.at) ? meta.at : this.now(),
      text: cleanItem(text),
      source: meta.source ? String(meta.source).slice(0, 40) : null,
      ref: meta.ref ? String(meta.ref).slice(0, 120) : null
    }
    if (!item.text) return null
    const list = entry.sections[key]
    if (list.some((x) => fold(x.text) === fold(item.text))) return null
    list.push(item)
    if (list.length > MAX_SECTION_ITEMS) list.splice(0, list.length - MAX_SECTION_ITEMS)
    return item
  }

  appendNote (key, section, text, meta = {}) {
    const entry = this.get(key)
    if (!entry) return { ok: false, msg: `no entity profile for "${key}"` }
    const item = this._appendRaw(entry, section, text, meta)
    if (!item) return { ok: true, unchanged: true, entry }
    entry.revision += 1
    entry.updatedAt = this.now()
    if (meta.evidence) this._mergeEvidence(entry, [meta.evidence])
    const saved = this.save(entry)
    return saved ? { ok: true, entry: saved } : { ok: false, msg: 'write failed' }
  }

  setSection (key, section, text) {
    const entry = this.get(key)
    if (!entry) return { ok: false, msg: `no entity profile for "${key}"` }
    const s = SECTIONS.includes(section) ? section : 'notes'
    entry.sections[s] = normalizeSection(String(text || '').split('\n').map((line) => line.replace(/^[-*]\s*/, '')).filter(Boolean))
    entry.revision += 1
    entry.updatedAt = this.now()
    const saved = this.save(entry)
    return saved ? { ok: true, entry: saved } : { ok: false, msg: 'write failed' }
  }

  _mergeEvidence (entry, refs) {
    for (const raw of refs) {
      const ref = typeof raw === 'string' ? raw : raw?.ref
      if (!ref) continue
      const note = typeof raw === 'object' && raw?.note ? clip(raw.note, 200) : null
      if (entry.evidence.some((e) => e.ref === ref)) continue
      entry.evidence.push({ ref: String(ref), at: Number.isFinite(raw?.at) ? raw.at : this.now(), note })
    }
    if (entry.evidence.length > MAX_EVIDENCE) entry.evidence.splice(0, entry.evidence.length - MAX_EVIDENCE)
  }

  linkEvidence (key, refs) {
    const entry = this.get(key)
    if (!entry) return { ok: false, msg: `no entity profile for "${key}"` }
    const before = entry.evidence.length
    this._mergeEvidence(entry, Array.isArray(refs) ? refs : [refs])
    if (entry.evidence.length === before) return { ok: true, unchanged: true, entry }
    entry.revision += 1
    entry.updatedAt = this.now()
    const saved = this.save(entry)
    return saved ? { ok: true, entry: saved } : { ok: false, msg: 'write failed' }
  }

  linkMemories (key, ids) {
    const entry = this.get(key)
    if (!entry) return { ok: false, msg: `no entity profile for "${key}"` }
    const before = entry.memoryIds.length
    entry.memoryIds = [...new Set([...entry.memoryIds, ...(Array.isArray(ids) ? ids : [ids]).map(String)])].slice(-MAX_MEMORY_LINKS)
    if (entry.memoryIds.length === before) return { ok: true, unchanged: true, entry }
    entry.updatedAt = this.now()
    const saved = this.save(entry)
    return saved ? { ok: true, entry: saved } : { ok: false, msg: 'write failed' }
  }

  markSeen (key, { at = null, name = null } = {}) {
    const entry = this.get(key)
    if (!entry) return null
    entry.lastSeenAt = Number.isFinite(at) ? at : this.now()
    if (name && !entry.names.some((n) => fold(n) === fold(name))) entry.names.push(clip(name, 40))
    return this.save(entry)
  }

  /** Merge overlapping dossiers into one, preserving every note and evidence ref. */
  merge ({ keys = [], into = null } = {}) {
    const sources = keys.map((k) => this.get(k)).filter(Boolean)
    if (sources.length < 2) return { ok: false, msg: 'merge needs at least two existing profiles' }
    const target = into ? this.get(into) : sources[0]
    if (!target) return { ok: false, msg: `merge target "${into}" not found` }
    const merged = []
    for (const source of sources) {
      if (source.id === target.id) continue
      for (const section of SECTIONS) {
        for (const item of source.sections[section] || []) this._appendRaw(target, section, item.text, { at: item.at, source: item.source, ref: item.ref })
      }
      if (source.doc) target.doc = clip(`${target.doc ? `${target.doc}\n\n` : ''}${source.doc}`, MAX_DOC_CHARS)
      this._mergeEvidence(target, source.evidence)
      target.names = [...new Set([...target.names, ...source.names])].slice(-MAX_NAMES)
      target.memoryIds = [...new Set([...target.memoryIds, ...source.memoryIds])].slice(-MAX_MEMORY_LINKS)
      target.tags = [...new Set([...target.tags, ...source.tags])].slice(0, MAX_TAGS)
      target.firstSeenAt = Math.min(target.firstSeenAt, source.firstSeenAt)
      target.interactions += source.interactions || 0
      target.mergedFrom = [...new Set([...(target.mergedFrom || []), source.id, ...(source.mergedFrom || [])])]
      // Relationship: keep the target's assessment if set, otherwise adopt the
      // source's — never silently overwrite a considered view.
      if (!target.relationship.stance && source.relationship.stance) {
        target.relationship = { ...source.relationship, evidence: [...target.relationship.evidence] }
      }
      source.status = 'merged'
      source.supersededBy = target.id
      source.archivedAt = this.now()
      this.save(source)
      this._appendRaw(target, 'timeline', `merged dossier ${source.displayName} (${source.id}) into this one`, { source: 'maintenance' })
      merged.push(source.id)
    }
    target.revision += 1
    target.updatedAt = this.now()
    this.save(target)
    return { ok: true, id: target.id, merged }
  }

  archive (key, { reason = '' } = {}) {
    const entry = this.get(key)
    if (!entry) return { ok: false, msg: `no entity profile for "${key}"` }
    entry.status = 'archived'
    entry.archivedAt = this.now()
    this._appendRaw(entry, 'timeline', `archived${reason ? `: ${reason}` : ''}`, { source: 'self' })
    entry.revision += 1
    entry.updatedAt = this.now()
    this.save(entry)
    return { ok: true, id: entry.id }
  }

  // -------------------------------------------------------------- output --
  render (key, { max = 8000, lookupMemory = null } = {}) {
    const entry = typeof key === 'string' ? this.get(key) : key
    if (!entry) return null
    const lines = []
    const titleKind = entry.kind === 'player' ? `Player profile: ${entry.displayName}` : `${entry.kind[0].toUpperCase()}${entry.kind.slice(1)} profile: ${entry.displayName}`
    lines.push(`# ${titleKind}`)
    lines.push('')
    lines.push(`- Identity: ${entry.uuid ? `Minecraft UUID ${entry.uuid} (verified identity basis)` : 'name-only — no UUID observed yet, identity may be wrong after a rename'}`)
    lines.push(`- Known names: ${entry.names.join(', ') || 'unknown'}${(entry.aliasesStale || []).length ? ` (previous: ${entry.aliasesStale.join(', ')})` : ''}`)
    lines.push(`- First encountered: ${nowIso(entry.firstSeenAt)}${entry.firstSeenNote ? ` — ${entry.firstSeenNote}` : ''}`)
    lines.push(`- Last seen: ${nowIso(entry.lastSeenAt)} (${entry.interactions} recorded interaction${entry.interactions === 1 ? '' : 's'})`)
    if (entry.tags.length) lines.push(`- Tags: ${entry.tags.join(', ')}`)
    if (entry.status !== 'active') lines.push(`- Status: ${entry.status}${entry.supersededBy ? ` (superseded by ${entry.supersededBy})` : ''}`)
    lines.push('')
    const r = entry.relationship
    const relBits = [
      `stance=${r.stance || 'unassessed'}`,
      r.trust !== null ? `trust=${r.trust}/100` : 'trust=unset',
      r.confidence !== null ? `confidence=${r.confidence}%` : 'confidence=unset',
      r.willingness ? `willingness="${r.willingness}"` : null
    ].filter(Boolean)
    lines.push('## Relationship')
    lines.push(relBits.join(', '))
    if (r.assessment) lines.push('', r.assessment)
    if (!r.stance && !r.assessment) lines.push('', '_No assessment yet — form one from evidence, not from one isolated interaction._')
    lines.push('')
    for (const section of SECTIONS) {
      const items = entry.sections[section] || []
      if (!items.length) continue
      lines.push(`## ${SECTION_TITLES[section]}`)
      for (const item of items.slice(-40)) lines.push(`- ${item.at ? `[${nowIso(item.at).slice(0, 10)}] ` : ''}${item.text}${item.ref ? ` (evidence: ${item.ref})` : ''}`)
      lines.push('')
    }
    if (entry.doc.trim()) {
      lines.push('## Written notes')
      lines.push(entry.doc.trim())
      lines.push('')
    }
    if (entry.evidence.length) {
      lines.push('## Relevant historical records')
      for (const e of entry.evidence.slice(-25)) lines.push(`- ${e.ref}${e.at ? ` (${nowIso(e.at).slice(0, 10)})` : ''}${e.note ? ` — ${e.note}` : ''}`)
      lines.push('')
    }
    if (entry.memoryIds.length) {
      lines.push('## Linked curated memories')
      for (const id of entry.memoryIds.slice(-25)) {
        let label = `#${id}`
        try {
          const rec = lookupMemory ? lookupMemory(id) : null
          if (rec) label += ` [${rec.status}${rec.category ? `, ${rec.category}` : ''}, ${nowIso(rec.ts).slice(0, 10)}] ${clip(rec.text, 160)}`
        } catch { /* a broken link must not break the dossier */ }
        lines.push(`- ${label}`)
      }
      lines.push('')
    }
    if (entry.mergedFrom.length) lines.push(`_Merged from: ${entry.mergedFrom.join(', ')}_`)
    const text = lines.join('\n').trim()
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }

  /** Compact dossier line for the prompt. Must stay short; details are one tool call away. */
  summary (key, { maxChars = 300 } = {}) {
    const entry = typeof key === 'string' ? this.get(key) : key
    if (!entry) return ''
    const bits = []
    bits.push(`${entry.displayName}${entry.uuid ? ` (uuid ${entry.uuid})` : ' (name-only, identity unverified)'}`)
    if (entry.identityBasis === 'uuid') bits.push('identity verified')
    const r = entry.relationship
    if (r.stance || r.trust !== null) {
      const conf = r.confidence !== null ? `, conf ${r.confidence}%` : ''
      bits.push(`relationship: ${r.stance || 'unassessed'}${r.trust !== null ? ` (trust ${r.trust}/100${conf})` : ''}`)
    }
    const lastInteraction = (entry.sections.interactions || []).slice(-1)[0]
    const lastFact = (entry.sections.facts || []).slice(-1)[0]
    const desc = (entry.sections.description || []).slice(-1)[0]
    if (r.assessment) bits.push(clip(r.assessment, 120))
    else if (desc) bits.push(clip(desc.text, 110))
    if (lastFact) bits.push(`fact: ${clip(lastFact.text, 90)}`)
    if (lastInteraction) bits.push(`last: ${clip(lastInteraction.text, 90)}`)
    if ((entry.sections.uncertainties || []).length) bits.push(`uncertain: ${clip(entry.sections.uncertainties.slice(-1)[0].text, 70)}`)
    return clip(bits.join(' — '), maxChars)
  }

  search (query, { kind = null, limit = 8 } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const terms = tokenize(q)
    const qFold = fold(q)
    const scored = []
    for (const [id, meta] of Object.entries(this.index.entries)) {
      if (kind && meta.kind !== kind) continue
      const entry = this.get(id)
      if (!entry) continue
      const hay = fold([entry.displayName, ...(entry.names || []), entry.doc, ...SECTIONS.flatMap((s) => (entry.sections[s] || []).map((i) => i.text))].join(' '))
      let score = 0
      if (qFold && hay.includes(qFold)) score += 1.5
      if (terms.length) score += terms.filter((t) => hay.includes(t)).length / terms.length
      if ((entry.names || []).some((n) => hasWholeWord(n, q))) score += 1.2
      if (score <= 0.05) continue
      if (entry.status === 'archived') score *= 0.6
      scored.push({ id: entry.id, displayName: entry.displayName, kind: entry.kind, score: Math.round(score * 1000) / 1000, summary: this.summary(entry, { maxChars: 240 }) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** Non-destructive housekeeping: bounded sections, deduped evidence, honest reporting. */
  maintenance ({ now = this.now(), staleDays = 180 } = {}) {
    const report = { checked: 0, normalized: 0, needsAssessment: [], noEvidence: [], staleNameOnly: [], corrupt: this.corruptions.slice() }
    for (const id of Object.keys(this.index.entries)) {
      const entry = this.get(id)
      if (!entry) continue
      report.checked++
      const before = JSON.stringify(entry)
      for (const section of SECTIONS) entry.sections[section] = normalizeSection(entry.sections[section])
      entry.evidence = entry.evidence.slice(-MAX_EVIDENCE)
      if (JSON.stringify(entry) !== before) {
        entry.revision += 1
        entry.updatedAt = now
        this.save(entry)
        report.normalized++
      }
      const r = entry.relationship
      if (!r.stance && !r.assessment && (entry.sections.interactions || []).length >= 3) report.needsAssessment.push(entry.id)
      if (!entry.evidence.length && (entry.sections.interactions || []).length) report.noEvidence.push(entry.id)
      if (!entry.uuid && entry.kind === 'player' && now - entry.lastSeenAt > staleDays * 24 * 3600_000) report.staleNameOnly.push(entry.id)
    }
    return report
  }
}

module.exports = {
  ProfileStore,
  SECTIONS,
  SECTION_TITLES,
  PROFILE_SCHEMA,
  KINDS,
  emptyProfile,
  normalizeUuid,
  slug
}
