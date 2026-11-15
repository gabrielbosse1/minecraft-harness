/**
 * history.js — the raw historical record. Complete, append-only, never fed to
 * the model automatically.
 *
 * Curated memories (`memory.js`) are what Zinc chooses to remember; entity
 * documents (`entities.js`) are the long-form dossiers about people, places and
 * itself. This store is the evidence underneath both: every observation, chat
 * line, action, decision and failure, written as NDJSON under
 * `<data>/history/<category>/<YYYY-MM-DD>.jsonl`.
 *
 * Design rules:
 *   - Append only. Nothing here is rewritten, merged or "cleaned up" by
 *     maintenance, so deleting a curated memory can never destroy the record
 *     that produced it.
 *   - Never read as prompt context. The only reader is an explicit
 *     `memory {operation:"history"}` search (or a curator resolving a link), and
 *     that search is bounded: newest files first, a byte cap per file, a hit
 *     cap per call. A year of play never loads into memory at once.
 *   - Repetition is coalesced, not memorised: an identical line repeated inside
 *     the dedupe window is counted on the previous record instead of appending a
 *     new one, and the next occurrence carries `repeats`.
 *   - Every record has a stable reference (`world/2026-11-15.jsonl#12`) that a
 *     curated memory or an entity document can point back to.
 *   - Corrupt or partially written lines are skipped on read, never repaired in
 *     place, and never crash the caller.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { fold, tokenize, clip, isoDay } = require('./memory_text')

/** How many appends may accumulate before a per-file keyword index is flushed. */
const INDEX_FLUSH_EVERY = 20

const HISTORY_CATEGORIES = ['world', 'chat', 'actions', 'decisions', 'relationships', 'errors', 'maintenance']

/** Categories whose files may be pruned by age. Evidence-bearing ones never are. */
const PRUNABLE_CATEGORIES = new Set(['world', 'chat', 'actions'])

/** Event types that are pure telemetry: logged in the world file, never curated. */
const TRIVIAL_EVENT_TYPES = new Set([
  'move', 'chunk', 'weather', 'daylight', 'heal', 'effect', 'inventory',
  'item_collected', 'inventory_loss', 'position', 'tick'
])

function categoryOf (eventType = '', source = '') {
  const t = String(eventType || '').toLowerCase()
  if (t === 'chat' || t === 'whisper' || t === 'chat_in') return 'chat'
  if (t === 'say' || t === 'chat_out' || t === 'reply') return 'chat'
  if (/^(action_result|action_failure|tool|tool_exec|result)$/.test(t)) return 'actions'
  if (/^(decision|goal|goal_event|proposal|request|agreement)$/.test(t)) return 'decisions'
  if (/^(player_|entity_|relationship|social|spawn|death|combat)/.test(t)) return 'relationships'
  if (/error|exception|failure|crash/.test(t) || String(source) === 'error') return 'errors'
  return 'world'
}

class HistoryLog {
  /**
   * @param {{
   *   dir?: string,
   *   now?: () => number,
   *   sessionId?: string | null,
   *   dedupeWindowMs?: number,
   *   maxScanFiles?: number,
   *   maxFileBytes?: number,
   *   retainDays?: number,
   *   logger?: { warn?: Function, debug?: Function }
   * }} [opts]
   */
  constructor (opts = {}) {
    this.dir = opts.dir || path.join(process.cwd(), 'data', 'history')
    this.now = opts.now || (() => Date.now())
    this.sessionId = opts.sessionId || null
    this.dedupeWindowMs = Number.isFinite(opts.dedupeWindowMs) ? opts.dedupeWindowMs : 45_000
    this.maxScanFiles = Number.isFinite(opts.maxScanFiles) ? opts.maxScanFiles : 160
    this.maxFileBytes = Number.isFinite(opts.maxFileBytes) ? opts.maxFileBytes : 4_000_000
    this.retainDays = Number.isFinite(opts.retainDays) ? opts.retainDays : 0
    this.logger = opts.logger || null
    this.seq = 0
    this.written = 0
    this.suppressed = 0
    this.corruptLines = 0
    this._recent = new Map() // dedupe key -> { id, at, file, line, repeats }
    this._fileLines = new Map() // absolute file -> last known line count
    // Per-file keyword index (`<file>.idx.json`): lets an old record be found
    // by reading a few small sidecars instead of every daily log.
    this._indexes = new Map() // absolute .jsonl file -> index object
  }

  setSession (sessionId) {
    this.sessionId = sessionId || null
  }

  _category (cat) {
    const c = String(cat || 'world').toLowerCase()
    return HISTORY_CATEGORIES.includes(c) ? c : 'world'
  }

  _file (category, ts) {
    return path.join(this.dir, category, `${isoDay(ts)}.jsonl`)
  }

  _countLines (file) {
    if (this._fileLines.has(file)) return this._fileLines.get(file)
    let n = 0
    try { n = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch { n = 0 }
    this._fileLines.set(file, n)
    return n
  }

  // ------------------------------------------------------- keyword index --
  _indexPath (file) { return file.replace(/\.jsonl$/, '.idx.json') }

  _loadFileIndex (file) {
    if (this._indexes.has(file)) return this._indexes.get(file)
    let idx = null
    try {
      const raw = JSON.parse(fs.readFileSync(this._indexPath(file), 'utf8'))
      if (raw && typeof raw === 'object' && raw.tokens) {
        idx = {
          day: raw.day || path.basename(file).replace(/\.jsonl$/, ''),
          records: Number(raw.records) || 0,
          tokens: new Map(Object.entries(raw.tokens || {})),
          entities: Array.isArray(raw.entities) ? raw.entities : [],
          uuids: Array.isArray(raw.uuids) ? raw.uuids : [],
          kinds: raw.kinds && typeof raw.kinds === 'object' ? raw.kinds : {},
          firstAt: Number(raw.firstAt) || null,
          lastAt: Number(raw.lastAt) || null,
          dirty: 0
        }
      }
    } catch { idx = null }
    if (idx) this._indexes.set(file, idx)
    return idx
  }

  _updateFileIndex (file, record) {
    let idx = this._loadFileIndex(file)
    if (!idx) {
      idx = { day: path.basename(file).replace(/\.jsonl$/, ''), records: 0, tokens: new Map(), entities: [], uuids: [], kinds: {}, firstAt: record.at, lastAt: record.at, dirty: 0 }
      this._indexes.set(file, idx)
    }
    idx.records += 1
    idx.firstAt = Math.min(idx.firstAt ?? record.at, record.at)
    idx.lastAt = Math.max(idx.lastAt ?? record.at, record.at)
    for (const token of new Set(tokenize(record.text))) idx.tokens.set(token, (idx.tokens.get(token) || 0) + 1)
    for (const entity of record.entities || []) {
      const e = String(entity)
      if (!idx.entities.some((x) => fold(x) === fold(e))) idx.entities.push(clip(e, 40))
    }
    if (record.uuid && !idx.uuids.includes(String(record.uuid))) idx.uuids.push(String(record.uuid))
    idx.kinds[record.kind] = (idx.kinds[record.kind] || 0) + 1
    idx.dirty += 1
    if (idx.dirty >= INDEX_FLUSH_EVERY) this._flushFileIndex(file)
  }

  _flushFileIndex (file) {
    const idx = this._indexes.get(file)
    if (!idx || !idx.dirty) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = {
        day: idx.day,
        records: idx.records,
        tokens: Object.fromEntries(idx.tokens),
        entities: idx.entities,
        uuids: idx.uuids,
        kinds: idx.kinds,
        firstAt: idx.firstAt,
        lastAt: idx.lastAt
      }
      const target = this._indexPath(file)
      const tmp = `${target}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, target)
      idx.dirty = 0
    } catch { /* the index is an optimisation; logs remain authoritative */ }
  }

  flushIndexes () {
    for (const file of this._indexes.keys()) this._flushFileIndex(file)
  }

  /**
   * Append one raw record. Returns the stored record (with its `ref`) or the
   * record that absorbed a repeat. Never throws.
   */
  append (category, text, meta = {}) {
    const cat = this._category(category)
    const clean = clip(text, meta.maxText ?? 2000)
    if (!clean) return null
    const at = Number.isFinite(meta.at) ? meta.at : this.now()
    const kind = clip(meta.kind || 'event', 40)
    const entities = Array.isArray(meta.entities) ? meta.entities.map(String).filter(Boolean).slice(0, 12) : []
    const dedupeKey = meta.dedupeKey === null
      ? null
      : `${cat}|${kind}|${clean}|${meta.uuid || entities.join(',')}`
    if (dedupeKey) {
      const prev = this._recent.get(dedupeKey)
      if (prev && at - prev.at < this.dedupeWindowMs) {
        prev.repeats = (prev.repeats || 1) + 1
        prev.at = at
        this.suppressed++
        return { ...prev, deduped: true }
      }
    }
    const file = this._file(cat, at)
    const line = this._countLines(file) + 1
    const id = `h-${at.toString(36)}-${(++this.seq).toString(36)}`
    const record = {
      id,
      ref: `${cat}/${path.basename(file)}#${line}`,
      at,
      iso: new Date(at).toISOString(),
      cat,
      kind,
      text: clean,
      entities,
      uuid: meta.uuid ? String(meta.uuid) : null,
      where: meta.where || null,
      session: meta.session || this.sessionId || null,
      importance: Number.isFinite(meta.importance) ? meta.importance : null,
      repeats: meta.repeats || null,
      data: meta.data && typeof meta.data === 'object' ? meta.data : null
    }
    if (dedupeKey) this._recent.set(dedupeKey, { id, at, file, line, repeats: 1 })
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      this._fileLines.set(file, line)
      this._updateFileIndex(file, record)
      this.written++
      return record
    } catch (err) {
      this.logger?.warn?.('history', `append failed: ${err?.message || err}`)
      return null
    }
  }

  /** Map a perceived event onto a raw record (and skip pure transient telemetry). */
  recordPerceived (spec = {}) {
    const type = String(spec.eventType || spec.type || 'event')
    const importance = Number.isFinite(spec.importance) ? spec.importance : 0
    const cat = categoryOf(type, spec.source)
    if (cat === 'world' && importance <= 0 && TRIVIAL_EVENT_TYPES.has(type.toLowerCase())) return null
    if (importance <= 0 && !['chat', 'actions', 'decisions', 'errors'].includes(cat)) return null
    return this.append(cat, spec.summary || spec.text || spec.msg, {
      kind: type,
      at: Number.isFinite(spec.observedAt) ? spec.observedAt : spec.at,
      entities: spec.entities || (spec.sender ? [spec.sender] : []),
      uuid: spec.uuid || null,
      where: spec.where || null,
      importance,
      data: spec.data || null,
      dedupeKey: spec.dedupeKey === undefined ? undefined : spec.dedupeKey
    })
  }

  _files ({ categories = null, since = null, until = null } = {}) {
    const wanted = categories
      ? (Array.isArray(categories) ? categories : [categories]).map((c) => this._category(c))
      : HISTORY_CATEGORIES.slice()
    const out = []
    for (const cat of wanted) {
      const dir = path.join(this.dir, cat)
      let names = []
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().reverse() } catch { continue }
      for (const name of names) {
        const day = name.replace(/\.jsonl$/, '')
        if (since && day < isoDay(since)) continue
        if (until && day > isoDay(until)) continue
        out.push({ cat, day, file: path.join(dir, name) })
      }
    }
    // Newest days first across every category, so a bounded scan sees recent
    // evidence before ancient history.
    out.sort((a, b) => (b.day < a.day ? -1 : b.day > a.day ? 1 : 0))
    return out
  }

  _readRecords (file) {
    let raw = ''
    try {
      const size = fs.statSync(file).size
      if (size > this.maxFileBytes) {
        const fd = fs.openSync(file, 'r')
        try {
          const buf = Buffer.alloc(this.maxFileBytes)
          fs.readSync(fd, buf, 0, this.maxFileBytes, size - this.maxFileBytes)
          raw = buf.toString('utf8')
          const nl = raw.indexOf('\n')
          raw = nl >= 0 ? raw.slice(nl + 1) : raw
        } finally { fs.closeSync(fd) }
      } else {
        raw = fs.readFileSync(file, 'utf8')
      }
    } catch { return [] }
    const lines = raw.split('\n')
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (rec && rec.text) out.push(rec)
      } catch { this.corruptLines++ }
    }
    return out
  }

  /**
   * Bounded full-text search over raw history. Exact identifiers first, then
   * keyword overlap, then recency. Returns compact hits plus a `ref` that
   * `read()` (and a curated memory's `evidence` field) can resolve.
   */
  search ({
    query = '',
    categories = null,
    category = null,
    entity = null,
    kind = null,
    since = null,
    until = null,
    limit = 8,
    maxScanFiles = null,
    maxHits = 60
  } = {}) {
    const cats = categories || (category ? [category] : null)
    // Make records appended since the last flush searchable.
    this.flushIndexes()
    const q = String(query || '').trim()
    const qFold = fold(q)
    const terms = tokenize(q)
    const entFold = entity ? fold(entity) : null
    const maxFiles = Math.min(this.maxScanFiles, Number.isFinite(maxScanFiles) ? maxScanFiles : this.maxScanFiles)
    const files = this._files({ categories: cats, since, until })
    // Pick candidate files from the small per-file keyword indexes FIRST: an
    // experience from months ago is found by reading a handful of sidecars and
    // then two or three daily logs, never the whole history.
    const candidates = []
    for (const f of files) {
      const idx = this._loadFileIndex(f.file)
      let score = 0
      if (!idx) {
        // Unindexed file (older install, or an index that failed to write):
        // still searchable, but only after the indexed candidates.
        candidates.push({ f, score: 0.05 })
        continue
      }
      if (entFold) {
        const inEntities = (idx.entities || []).some((e) => fold(e) === entFold)
        const inUuids = (idx.uuids || []).some((u) => fold(u) === entFold)
        if (!inEntities && !inUuids) continue
        score += 1
      }
      if (kind) {
        if (!idx.kinds || !idx.kinds[kind]) continue
        score += 0.5
      }
      if (terms.length) {
        const overlap = terms.filter((t) => idx.tokens.has(t)).length
        if (!overlap) continue
        score += overlap / terms.length
      }
      if (!entFold && !kind && !terms.length) continue
      candidates.push({ f, score })
    }
    candidates.sort((a, b) => (b.score - a.score) || (a.f.day < b.f.day ? 1 : a.f.day > b.f.day ? -1 : 0))
    const hits = []
    let scannedFiles = 0
    let scannedRecords = 0
    for (const { f } of candidates) {
      if (scannedFiles >= maxFiles || hits.length >= maxHits) break
      const records = this._readRecords(f.file)
      scannedFiles++
      scannedRecords += records.length
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]
        if (kind && rec.kind !== kind) continue
        if (since && rec.at < since) continue
        if (until && rec.at > until) continue
        const recFold = fold(`${rec.text} ${(rec.entities || []).join(' ')}`)
        if (entFold) {
          const inEntities = (rec.entities || []).some((e) => fold(e) === entFold)
          if (!inEntities && !(rec.uuid && fold(rec.uuid) === entFold) && !recFold.includes(entFold)) continue
        }
        let score = 0
        if (qFold && recFold.includes(qFold)) score += 1.4
        if (terms.length) {
          const overlap = terms.filter((t) => recFold.includes(t)).length
          if (!overlap && !(qFold && recFold.includes(qFold))) continue
          score += overlap / terms.length
        } else if (!entFold && !kind) {
          continue
        }
        if (!score) score = 0.2
        // Recency nudge (a week-old line matters less than a fresh one).
        score += Math.max(0, 0.25 - (this.now() - rec.at) / (30 * 24 * 3600_000))
        hits.push({
          ref: `${f.cat}/${path.basename(f.file)}#${(rec.line || i + 1)}`,
          id: rec.id,
          at: rec.at,
          iso: rec.iso,
          cat: rec.cat || f.cat,
          kind: rec.kind,
          text: clip(rec.text, 320),
          entities: rec.entities || [],
          uuid: rec.uuid || null,
          score: Math.round(score * 1000) / 1000
        })
      }
    }
    hits.sort((a, b) => (b.score - a.score) || (b.at - a.at))
    return {
      hits: hits.slice(0, Math.max(1, limit)),
      scannedFiles,
      scannedRecords,
      candidateFiles: candidates.length,
      truncated: candidates.length > scannedFiles,
      corruptLines: this.corruptLines
    }
  }

  /** Resolve one reference and (optionally) its neighbouring lines as context. */
  read (ref, { context = 1 } = {}) {
    const m = /^([a-z]+)\/([^#]+)#(\d+)$/.exec(String(ref || '').trim())
    if (!m) return { ok: false, msg: `invalid history reference "${ref}" (expected category/YYYY-MM-DD.jsonl#line)` }
    const [, cat, file, lineText] = m
    if (!HISTORY_CATEGORIES.includes(cat)) return { ok: false, msg: `unknown history category "${cat}"` }
    const filePath = path.join(this.dir, cat, path.basename(file))
    let raw = ''
    try { raw = fs.readFileSync(filePath, 'utf8') } catch { return { ok: false, msg: `history file vanished: ${cat}/${file}` } }
    const lines = raw.split('\n')
    const idx = Math.max(1, Number(lineText)) - 1
    const out = []
    const lo = Math.max(0, idx - Math.max(0, context))
    const hi = Math.min(lines.length - 1, idx + Math.max(0, context))
    for (let i = lo; i <= hi; i++) {
      const line = (lines[i] || '').trim()
      let rec = null
      try { rec = line ? JSON.parse(line) : null } catch { rec = null }
      if (!rec) continue
      out.push({
        ref: `${cat}/${file}#${i + 1}`,
        at: rec.at,
        iso: rec.iso,
        kind: rec.kind,
        text: rec.text,
        entities: rec.entities || [],
        current: i === idx
      })
    }
    if (!out.length) return { ok: false, msg: `no readable record at ${ref}` }
    return { ok: true, ref, cat, file, records: out }
  }

  /** Counts only — cheap enough to show in a status line, never full contents. */
  stats () {
    const byCategory = {}
    let records = 0
    let days = 0
    for (const cat of HISTORY_CATEGORIES) {
      const dir = path.join(this.dir, cat)
      let names = []
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort() } catch { byCategory[cat] = { files: 0, records: 0 }; continue }
      let count = 0
      for (const name of names) {
        count += this._countLines(path.join(dir, name))
      }
      byCategory[cat] = {
        files: names.length,
        records: count,
        firstDay: names[0]?.replace(/\.jsonl$/, '') || null,
        lastDay: names[names.length - 1]?.replace(/\.jsonl$/, '') || null
      }
      records += count
      days = Math.max(days, names.length)
    }
    return { dir: this.dir, records, days, byCategory, written: this.written, suppressed: this.suppressed, corruptLines: this.corruptLines }
  }

  /**
   * Age-based pruning for the high-volume, low-evidence categories only.
   * `decisions`, `errors`, `relationships` and `maintenance` are never pruned:
   * they are the audit trail a curated memory points back to. `retainDays: 0`
   * (the default) keeps everything.
   */
  prune ({ retainDays = this.retainDays, dryRun = false } = {}) {
    const removed = []
    if (!Number.isFinite(retainDays) || retainDays <= 0) return { removed, retainDays }
    const cutoff = isoDay(this.now() - retainDays * 24 * 3600_000)
    for (const cat of HISTORY_CATEGORIES) {
      if (!PRUNABLE_CATEGORIES.has(cat)) continue
      const dir = path.join(this.dir, cat)
      let names = []
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')) } catch { continue }
      for (const name of names) {
        if (name.replace(/\.jsonl$/, '') >= cutoff) continue
        const file = path.join(dir, name)
        if (!dryRun) { try { fs.unlinkSync(file) } catch { continue } }
        this._fileLines.delete(file)
        removed.push(`${cat}/${name}`)
      }
    }
    return { removed, retainDays, cutoff }
  }

  /** Flush pending keyword indexes (records themselves are already durable). */
  save () {
    this.flushIndexes()
    return { ok: true }
  }

  flush () { return this.save() }
}

module.exports = {
  HistoryLog,
  HISTORY_CATEGORIES,
  PRUNABLE_CATEGORIES,
  TRIVIAL_EVENT_TYPES,
  categoryOf
}
