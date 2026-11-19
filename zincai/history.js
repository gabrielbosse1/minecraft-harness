/** Append-only evidence, rebuildable keyword sidecars, and bounded cursor scans. */
'use strict'

const fs = require('fs')
const path = require('path')
const { randomUUID, createHash } = require('crypto')
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
    try { n = fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).length } catch { n = 0 }
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
          bytes: raw.bytes ?? null,
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

  _updateFileIndex (file, record, priorBytes, bytes) {
    let idx = this._loadFileIndex(file)
    if (!idx) {
      idx = { bytes: priorBytes === 0 ? 0 : null, day: path.basename(file).replace(/\.jsonl$/, ''), records: 0, tokens: new Map(), entities: [], uuids: [], kinds: {}, firstAt: record.at, lastAt: record.at, dirty: 0 }
      this._indexes.set(file, idx)
    }
    idx.bytes = idx.bytes === priorBytes ? bytes : null
    idx.records += 1
    idx.firstAt = Math.min(idx.firstAt ?? record.at, record.at)
    idx.lastAt = Math.max(idx.lastAt ?? record.at, record.at)
    for (const token of new Set(tokenize(`${record.text} ${(record.entities || []).join(' ')}`))) idx.tokens.set(token, (idx.tokens.get(token) || 0) + 1)
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
        bytes: idx.bytes,
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
      : JSON.stringify([cat, kind, clean, meta.uuid || entities, meta.where || null])
    const previous = dedupeKey ? this._recent.get(dedupeKey) : null
    const repeat = previous && at >= previous.at && at - previous.at < this.dedupeWindowMs ? previous : null
    const file = this._file(cat, at)
    // Preserve an interrupted tail as a corrupt physical line, then resume at
    // the next line. Existing evidence refs must never move.
    let priorBytes = 0
    try {
      const fd = fs.openSync(file, 'r')
      try {
        priorBytes = fs.fstatSync(fd).size
        if (priorBytes > 0) {
          const last = Buffer.alloc(1)
          fs.readSync(fd, last, 0, 1, priorBytes - 1)
          if (last[0] !== 10) {
            fs.appendFileSync(file, '\n')
            priorBytes++
            this._fileLines.delete(file)
          }
        }
      } finally { fs.closeSync(fd) }
    } catch (err) { if (err.code !== 'ENOENT') return null }
    const line = this._countLines(file) + 1
    const id = `h-${randomUUID()}`
    const record = {
      id,
      line,
      offset: priorBytes,
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
      repeats: repeat ? (repeat.repeats || 1) + 1 : (meta.repeats || null),
      repeatOf: repeat?.repeatOf || repeat?.ref || null,
      data: meta.data && typeof meta.data === 'object' ? meta.data : null
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const encoded = `${JSON.stringify(record)}\n`
      fs.appendFileSync(file, encoded, 'utf8')
      if (dedupeKey) {
        this._recent.delete(dedupeKey)
        this._recent.set(dedupeKey, { at, ref: record.ref, repeatOf: record.repeatOf, repeats: record.repeats })
        if (this._recent.size > 4096) this._recent.delete(this._recent.keys().next().value)
      }
      this._fileLines.set(file, line)
      this._updateFileIndex(file, record, priorBytes, priorBytes + Buffer.byteLength(encoded))
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

  // Read complete physical lines from a byte cursor. Bound peak memory by the
  // chunk size plus the longest line, independently of total archive size.
  *_lines (file, offset = 0, line = 0) {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      let pending = Buffer.alloc(0)
      let start = offset
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, offset)
        if (!n) break
        offset += n
        const bytes = Buffer.concat([pending, buf.subarray(0, n)])
        let i = 0; let j
        while ((j = bytes.indexOf(10, i)) !== -1) {
          const text = bytes.toString('utf8', i, j)
          const at = start
          start += j - i + 1
          i = j + 1
          yield { text, line: ++line, offset: at, next: start }
        }
        pending = bytes.subarray(i)
      }
      if (pending.length) yield { text: pending.toString('utf8'), line: line + 1, offset: start, next: offset, partial: true }
    } finally { fs.closeSync(fd) }
  }

  rebuildIndex (file) {
    this._indexes.delete(file)
    // Do not load the old sidecar while rebuilding.
    this._indexes.set(file, { bytes: 0, day: path.basename(file, '.jsonl'), records: 0, tokens: new Map(), entities: [], uuids: [], kinds: {}, firstAt: null, lastAt: null, dirty: 0 })
    const idx = this._indexes.get(file)
    let end = 0
    for (const row of this._lines(file)) {
      if (row.partial) break
      let rec
      try { rec = JSON.parse(row.text) } catch { /* invalid physical line */ }
      if (rec?.text) this._updateFileIndex(file, rec, end, row.next)
      else idx.bytes = row.next
      end = row.next
    }
    idx.dirty++
    this._flushFileIndex(file)
  }

  search ({ query = '', categories = null, category = null, entity = null,
    kind = null, goalId = null, since = null, sinceDays = null, until = null, limit = 8, maxScanFiles = null,
    maxHits = 60, cursor = null, exhaustive = false, near = null, radius = 32,
    dimension = null, world = null, regionBounds = null, minY = null, maxY = null } = {}) {
    const cats = categories || (category ? [category] : null)
    const q = String(query || '').trim(); const qFold = fold(q); const terms = tokenize(q)
    const ent = entity ? fold(entity) : null
    const signature = createHash('sha256').update(JSON.stringify([q, cats, ent, kind, goalId, since, sinceDays, until, near, radius, dimension, world, regionBounds, minY, maxY])).digest('hex')
    let resume = null
    if (cursor) {
      try { resume = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { /* invalid cursor */ }
      if (resume?.signature !== signature || typeof resume.key !== 'string' || !Number.isSafeInteger(resume.offset) || resume.offset < 0 || !Number.isSafeInteger(resume.line) || resume.line < 0) {
        return { hits: [], error: 'invalid cursor for these filters', truncated: true, scannedFiles: 0, scannedRecords: 0, nextCursor: null }
      }
    }
    since ??= Number.isFinite(sinceDays) ? (resume?.since ?? this.now() - sinceDays * 86_400_000) : null
    const files = this._files({ categories: cats, since, until })
    const candidates = files.map((f) => ({ ...f, key: `${f.day}/${f.cat}` })).filter((f) => {
      if (resume && f.key > resume.key) return false
      const idx = this._loadFileIndex(f.file)
      if (!idx) return true
      // A stale/missing sidecar can only cost time, never exclude evidence.
      try { if (idx.bytes !== fs.statSync(f.file).size) return true } catch { return true }
      if (ent && ![...(idx.entities || []), ...(idx.uuids || [])].some((v) => fold(v) === ent)) return false
      if (kind && !idx.kinds?.[kind]) return false
      return !terms.length || terms.some((t) => idx.tokens.has(t))
    }).sort((a, b) => b.key.localeCompare(a.key))
    const fileLimit = exhaustive ? Infinity : Math.max(1, Math.min(this.maxScanFiles, maxScanFiles ?? this.maxScanFiles))
    const byteLimit = exhaustive ? Infinity : Math.max(1, this.maxFileBytes)
    const hitLimit = Math.max(1, Math.min(100, Number(limit) || 8, maxHits))
    const hits = []
    let scannedFiles = 0; let scannedRecords = 0; let scannedBytes = 0; let unreadable = 0; let next = null
    outer: for (const f of candidates) {
      const offset = resume?.key === f.key ? resume.offset : 0
      let line = resume?.key === f.key ? resume.line : 0
      if (scannedFiles >= fileLimit || scannedBytes >= byteLimit || hits.length >= hitLimit) { next = { key: f.key, offset, line }; break }
      scannedFiles++
      try {
        for (const row of this._lines(f.file, offset, line)) {
          if (scannedBytes >= byteLimit || hits.length >= hitLimit) { next = { key: f.key, offset: row.offset, line }; break outer }
          line = row.line
          scannedBytes += row.next - row.offset
          let rec
          try { rec = JSON.parse(row.text) } catch { this.corruptLines++; continue }
          if (!rec?.text) continue
          scannedRecords++
          if ((kind && rec.kind !== kind) || (since !== null && rec.at < since) || (until !== null && rec.at > until)) continue
          if (goalId && rec.data?.goalId !== goalId) continue
          if (ent && ![...(rec.entities || []), rec.uuid].some((v) => v && fold(v) === ent)) continue
          const loc = rec.where
          if (regionBounds && (!loc || loc.dim !== regionBounds.dim || !['x', 'y', 'z'].every((k) => loc[k] >= regionBounds.min[k] && loc[k] <= regionBounds.max[k]))) continue
          if (world && loc?.world !== world) continue
          if (dimension && loc?.dim !== dimension) continue
          if (minY !== null && !(loc?.y >= minY)) continue
          if (maxY !== null && !(loc?.y <= maxY)) continue
          const distance = near && loc ? Math.hypot(loc.x - near.x, loc.y - near.y, loc.z - near.z) : null
          if (near && (distance === null || distance > radius)) continue
          const raw = fold(`${rec.text} ${(rec.entities || []).join(' ')}`)
          const tokenSet = new Set(tokenize(raw))
          const overlap = terms.filter((t) => tokenSet.has(t)).length
          const exact = qFold && raw.includes(qFold)
          if (terms.length ? !overlap : q && !exact) continue
          const score = (exact ? 1.4 : 0) + (terms.length ? overlap / terms.length : 0)
          hits.push({ ref: `${f.cat}/${path.basename(f.file)}#${row.line}`, id: rec.id, offset: row.offset, at: rec.at, iso: rec.iso,
            cat: f.cat, kind: rec.kind, text: clip(rec.text, 320), entities: rec.entities || [], uuid: rec.uuid || null,
            where: loc || null, distance, repeatOf: rec.repeatOf || null, score })
        }
        // A bounded page that traversed an entire stale file can safely repair
        // it without making a partial index authoritative. An explicit rebuild
        // is also available for files larger than the normal page budget.
        if (offset === 0 && this._loadFileIndex(f.file)?.bytes !== fs.statSync(f.file).size) this.rebuildIndex(f.file)
      } catch { unreadable++ }
    }
    hits.sort((a, b) => b.score - a.score || b.at - a.at)
    return { hits, scannedFiles, scannedRecords, scannedBytes, unreadable, candidateFiles: candidates.length,
      truncated: Boolean(next) || unreadable > 0, nextCursor: next ? Buffer.from(JSON.stringify({ signature, since, ...next })).toString('base64url') : null,
      corruptLines: this.corruptLines }
  }

  /** Resolve one reference and (optionally) its neighbouring lines as context. */
  read (ref, { context = 1 } = {}) {
    const m = /^([a-z]+)\/([^#]+)#(\d+)$/.exec(String(ref || '').trim())
    if (!m) return { ok: false, msg: `invalid history reference "${ref}" (expected category/YYYY-MM-DD.jsonl#line)` }
    const [, cat, file, lineText] = m
    if (!HISTORY_CATEGORIES.includes(cat)) return { ok: false, msg: `unknown history category "${cat}"` }
    const filePath = path.join(this.dir, cat, path.basename(file))
    const target = Number(lineText)
    const out = []
    let current = false
    try {
      for (const row of this._lines(filePath)) {
        if (row.line < target - context) continue
        if (row.line > target + context) break
        let rec
        try { rec = JSON.parse(row.text) } catch { continue }
        if (!rec) continue
        current ||= row.line === target
        out.push({ ...rec, ref: `${cat}/${file}#${row.line}`, current: row.line === target })
      }
    } catch { return { ok: false, msg: `history file unavailable: ${cat}/${file}` } }
    if (!current) return { ok: false, msg: `no readable record at ${ref}` }
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
