'use strict'

/**
 * events.js — Unified timestamped event perception, deduplication, burst
 * coalescing, durable delivery across context resets/restarts, and end-to-end
 * monotonic latency instrumentation for ZincAI.
 */

const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const JOURNAL_VERSION = 1
const MAX_BUFFER_EVENTS = 128
const MAX_LATENCY_SAMPLES = 256

function monoNow () {
  return performance.now()
}

function cleanText (s, max = 220) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Default reaction class & importance for canonical survival, threat,
 * objective, inventory, tool, and lifecycle events.
 */
const EVENT_DEFAULTS = Object.freeze({
  death: { reactionClass: 'immediate', importance: 3 },
  respawn: { reactionClass: 'immediate', importance: 3 },
  attacked: { reactionClass: 'immediate', importance: 3 },
  immediate_threat: { reactionClass: 'immediate', importance: 3 },
  flee_start: { reactionClass: 'immediate', importance: 3 },
  flee_end: { reactionClass: 'fast', importance: 2 },
  threat_mode_change: { reactionClass: 'fast', importance: 2 },
  hostile_approaching: { reactionClass: 'fast', importance: 2 },
  player_approaching: { reactionClass: 'deliberate', importance: 1 },
  health_threshold: { reactionClass: 'immediate', importance: 3 },
  hunger_threshold: { reactionClass: 'fast', importance: 2 },
  objective_started: { reactionClass: 'deliberate', importance: 1 },
  objective_paused: { reactionClass: 'fast', importance: 2 },
  objective_resumed: { reactionClass: 'deliberate', importance: 1 },
  objective_completed: { reactionClass: 'deliberate', importance: 2 },
  objective_failed: { reactionClass: 'fast', importance: 2 },
  item_dropped: { reactionClass: 'ambient', importance: 1 },
  item_pickup: { reactionClass: 'ambient', importance: 1 },
  inventory_capacity: { reactionClass: 'fast', importance: 2 },
  tool_low_durability: { reactionClass: 'fast', importance: 2 },
  tool_broken: { reactionClass: 'fast', importance: 2 },
  repeated_action_failure: { reactionClass: 'fast', importance: 2 }
})

/** Convert Minecraft worldTime into readable `day N HH:MM` (tick 0 = 06:00). */
function formatWorldClock (worldTime) {
  if (!worldTime || !Number.isFinite(worldTime.timeOfDay)) return ''
  const ticks = ((worldTime.timeOfDay % 24000) + 24000) % 24000
  const totalMinutes = Math.floor(((ticks + 6000) % 24000) * 1440 / 24000)
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
  const mm = String(totalMinutes % 60).padStart(2, '0')
  const dayPart = Number.isFinite(worldTime.day) ? `d${worldTime.day} ` : ''
  return `${dayPart}${hh}:${mm}`
}

function worldTimeOf (bot) {
  const t = bot?.time
  if (!t) return null
  const tod = Number.isFinite(t.timeOfDay) ? t.timeOfDay : null
  const age = Number.isFinite(t.age) ? t.age : null
  const day = Number.isFinite(t.day) ? t.day : (tod !== null && age !== null ? Math.floor(age / 24000) : null)
  if (tod === null && age === null) return null
  const phase = tod === null ? 'unknown' : (tod < 12000 ? 'day' : (tod < 13000 ? 'dusk' : (tod < 23000 ? 'night' : 'dawn')))
  const wt = { age, timeOfDay: tod, day, phase }
  wt.clock = formatWorldClock(wt)
  return wt
}

function roundWhere (pos, dim = 'overworld') {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
    dim: String(dim || 'overworld').replace(/^minecraft:/, '')
  }
}

/** Pure: render one event as a prompt line with UTC time + elapsed age. */
function formatEventLine (e, nowMs, { badge, batch = false } = {}) {
  const ageSec = Math.max(0, Math.round((nowMs - e.timestampMs) / 1000))
  const ageStr = ageSec < 90 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`
  const mcClock = e.worldTime?.clock || formatWorldClock(e.worldTime)
  const worldPart = mcClock
    ? `, mc ${mcClock}${e.worldTime?.phase ? ` ${e.worldTime.phase}` : ''}`
    : (e.worldTime?.phase ? `, ${e.worldTime.phase}` : '')
  const timeTag = e.timestamp.slice(11, 19)
  const sevTag = badge ? `[${badge}] ` : ''
  const locTag = e.where ? ` @${e.where.x},${e.where.y},${e.where.z}` : ''
  const whoTag = e.entities?.length ? ` [${e.entities.join(',')}]` : ''
  let countTag = ''
  if (e.count) {
    const first = e.first_event_at || new Date(e.first_timestampMs ?? e.timestampMs).toISOString()
    const last = e.last_event_at || new Date(e.last_timestampMs ?? e.timestampMs).toISOString()
    countTag = ` (x${e.count}${first ? ` ${first.slice(11, 19)}Z–${last.slice(11, 19)}Z` : ''})`
  }
  const recTag = batch
    ? (e.recovered ? ' [undelivered before restart]' : ' [NEW]')
    : (e.recovered ? ' [undelivered before restart]' : '')
  return `  - #${e.sequence} ${sevTag}[${timeTag}Z, ${ageStr}${worldPart}] ${e.type}${locTag}${whoTag}: ${e.description}${countTag}${recTag}`
}

function sameWhere (a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.z === b.z && a.dim === b.dim
}

function percentile (sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[idx] * 100) / 100
}

/**
 * Rolling monotonic stage latency recorder. Separates external LLM inference
 * time (`modelInferenceMs`) from Zinc's internal scheduling & execution stages.
 */
class LatencyTracker {
  constructor ({ maxSamples = MAX_LATENCY_SAMPLES } = {}) {
    this.maxSamples = maxSamples
    this.stages = new Map()
  }

  record (stage, ms) {
    if (!Number.isFinite(ms) || ms < 0) return
    let arr = this.stages.get(stage)
    if (!arr) {
      arr = []
      this.stages.set(stage, arr)
    }
    arr.push(ms)
    if (arr.length > this.maxSamples) arr.shift()
  }

  statsFor (stage) {
    const arr = this.stages.get(stage) || []
    if (!arr.length) {
      return { count: 0, min: null, p50: null, p90: null, p95: null, max: null, mean: null }
    }
    const sorted = arr.slice().sort((a, b) => a - b)
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    return {
      count: sorted.length,
      min: Math.round(sorted[0] * 100) / 100,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      max: Math.round(sorted[sorted.length - 1] * 100) / 100,
      mean: Math.round((sum / sorted.length) * 100) / 100
    }
  }

  summary () {
    const keys = [
      'occurrenceToReceiptMs',
      'observationToReceiptMs',
      'receiptToQueueMs',
      'receiptToReflexMs',
      'queueToModelMs',
      'modelInferenceMs',
      'responseToExecMs',
      'execToConfirmMs',
      'architectureOverheadMs'
    ]
    const out = {}
    for (const k of keys) out[k] = this.statsFor(k)
    for (const k of this.stages.keys()) {
      if (!out[k]) out[k] = this.statsFor(k)
    }
    return out
  }
}

class EventPipeline {
  /**
   * @param {{
   *   file?: string | null,
   *   now?: () => number,
   *   mono?: () => number,
   *   maxEvents?: number,
   *   dedupeWindowMs?: number,
   *   coalesceWindowMs?: number,
   *   batchWindowMs?: number,
   *   maxBatchEvents?: number
   * }} opts
   */
  constructor ({
    file = null,
    now = () => Date.now(),
    mono = monoNow,
    maxEvents = MAX_BUFFER_EVENTS,
    dedupeWindowMs = 600,
    coalesceWindowMs = 1500,
    batchWindowMs = 3_000,
    maxBatchEvents = 64
  } = {}) {
    this.file = file
    this.now = now
    this.mono = mono
    this.maxEvents = maxEvents
    this.dedupeWindowMs = dedupeWindowMs
    this.coalesceWindowMs = coalesceWindowMs
    // How long events may accumulate before a model decision forces a batch:
    // a short collection window so bursts are not delivered one event at a time.
    this.batchWindowMs = Math.max(0, batchWindowMs)
    this.maxBatchEvents = Math.max(1, Math.trunc(maxBatchEvents))
    this.sequence = 0
    this.lastDeliveredSeq = 0
    this.events = []
    this._dedupeMap = new Map() // dedupeKey -> { timestampMs, seq }
    this._batchOpenedAt = null // ms when the current undelivered-batch window opened
    this.latency = new LatencyTracker()
    this.stats = {
      emitted: 0,
      deduped: 0,
      coalesced: 0,
      recoveredOnBoot: 0,
      droppedAmbient: 0,
      batchesDelivered: 0,
      criticalDelivered: 0
    }
    this._dirty = false
    this._load()
  }

  /** Delivery lane for one event: critical (immediate), batch (next batch), summary (aggregated). */
  deliveryLane (evt) {
    const importance = evt.importance || 0
    if (evt.reactionClass === 'immediate' || importance >= 3) return 'critical'
    if (evt.reactionClass === 'fast' || importance === 2) return 'batch'
    return 'summary'
  }

  _load () {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      this.sequence = Number.isSafeInteger(raw.sequence) ? raw.sequence : 0
      this.lastDeliveredSeq = Number.isSafeInteger(raw.lastDeliveredSeq) ? raw.lastDeliveredSeq : 0
      // Only recover UND-ELIVERED important events (`processedAt === null && importance >= 2`).
      // Already-processed events (`processedAt !== null`) are NEVER replayed as new events!
      if (Array.isArray(raw.undelivered)) {
        for (const e of raw.undelivered) {
          if (!e || e.processedAt !== null || !this.isDurable(e)) continue
          this.events.push({
            ...e,
            recoveredFromRestart: true,
            monotonicTime: this.mono()
          })
          this.stats.recoveredOnBoot += 1
        }
      }
    } catch { /* corrupt journal: start clean without crashing */ }
  }

  isDurable (e) { return e.importance >= 2 || this.deliveryLane(e) === 'critical' }

  save () {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const undelivered = this.events
        .filter((e) => e.processedAt === null && this.isDurable(e))
        .map(({ _queuedMono, ...rest }) => rest)
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({
        v: JOURNAL_VERSION,
        savedAt: this.now(),
        sequence: this.sequence,
        lastDeliveredSeq: this.lastDeliveredSeq,
        undelivered
      }))
      fs.renameSync(tmp, this.file)
      this._dirty = false
      return true
    } catch { return false }
  }

  _pruneDedupe (nowMs) {
    if (this._dedupeMap.size < 128) return
    for (const [k, v] of this._dedupeMap) {
      if (nowMs - v.timestampMs > this.dedupeWindowMs * 4) this._dedupeMap.delete(k)
    }
  }

  /**
   * Record a normalized world or internal event with full temporal provenance.
   *
   * Honesty rule on timestamps:
   *  - Pass `occurredAt` ONLY when the event happened at a known instant (e.g. a
   *    live packet or Zinc's own action).
   *  - When Zinc discovers a prior change later (e.g. during a region/container
   *    scan), omit `occurredAt` (or set `occurrenceTimeKnown: false`): the event
   *    records `observedAt` without pretending to know when the block actually changed!
   */
  record (spec = {}, bot = null) {
    const receivedAt = Number.isFinite(spec.receivedAt) ? spec.receivedAt : this.now()
    const recvMono = this.mono()
    const observedAt = Number.isFinite(spec.observedAt) ? spec.observedAt : receivedAt
    const occurrenceTimeKnown = spec.occurrenceTimeKnown !== undefined
      ? Boolean(spec.occurrenceTimeKnown)
      : Number.isFinite(spec.occurredAt)
    const occurredAt = occurrenceTimeKnown
      ? (Number.isFinite(spec.occurredAt) ? spec.occurredAt : observedAt)
      : null
    const timestampMs = occurredAt !== null ? occurredAt : observedAt

    const eventType = cleanText(spec.eventType || spec.type || 'misc', 40).toLowerCase()
    const summary = cleanText(spec.summary || spec.text || spec.msg || eventType, 220)
    const dedupeKey = spec.dedupeKey !== undefined
      ? (spec.dedupeKey ? String(spec.dedupeKey) : null)
      : `${eventType}|${summary}|${spec.where ? `${spec.where.x},${spec.where.y},${spec.where.z}` : ''}`

    this._pruneDedupe(receivedAt)
    const dedupeMs = Number.isFinite(spec.dedupeWindowMs) ? spec.dedupeWindowMs : this.dedupeWindowMs
    if (dedupeKey && dedupeMs > 0) {
      const prev = this._dedupeMap.get(dedupeKey)
      if (prev && (receivedAt - prev.timestampMs) <= dedupeMs) {
        this.stats.deduped += 1
        return { deduped: true, event: this.events.find((e) => e.sequence === prev.seq) || null }
      }
    }

    if (occurrenceTimeKnown && occurredAt !== null) {
      this.latency.record('occurrenceToReceiptMs', Math.max(0, receivedAt - occurredAt))
    } else {
      this.latency.record('observationToReceiptMs', Math.max(0, receivedAt - observedAt))
    }

    const groupKey = spec.groupKey || null
    if (groupKey) {
      for (let i = this.events.length - 1; i >= Math.max(0, this.events.length - 8); i--) {
        const prev = this.events[i]
        if (!this.isDurable(prev) && prev.processedAt === null && prev.groupKey === groupKey && (receivedAt - prev.receivedAt) <= this.coalesceWindowMs) {
          prev.groupCount = (prev.groupCount || 1) + 1
          prev.lastTimestampMs = timestampMs
          prev.lastReceivedAt = receivedAt
          if (spec.entities?.length) {
            for (const ent of spec.entities) {
              if (!prev.entities.includes(ent) && prev.entities.length < 12) prev.entities.push(ent)
            }
          }
          if (!prev.samples) prev.samples = [prev.summary]
          if (prev.samples.length < 4 && !prev.samples.includes(summary)) prev.samples.push(summary)
          if (spec.groupSummary) prev.summary = cleanText(spec.groupSummary(prev), 220)
          this.stats.coalesced += 1
          if (dedupeKey) this._dedupeMap.set(dedupeKey, { timestampMs: receivedAt, seq: prev.sequence })
          return { deduped: false, coalesced: true, event: prev }
        }
      }
    }

    this.sequence += 1
    const worldTime = spec.worldTime !== undefined ? spec.worldTime : worldTimeOf(bot)
    const where = spec.where ? roundWhere(spec.where, spec.where.dim || bot?.game?.dimension) : null
    const defaults = EVENT_DEFAULTS[eventType] || null
    const reactionClass = ['immediate', 'fast', 'deliberate', 'ambient'].includes(spec.reactionClass)
      ? spec.reactionClass
      : (defaults?.reactionClass || 'deliberate')
    const importance = Number.isFinite(spec.importance)
      ? spec.importance
      : (defaults?.importance ?? (reactionClass === 'immediate' ? 3 : reactionClass === 'fast' ? 2 : reactionClass === 'ambient' ? 0 : 1))
    const deliveryLane = reactionClass === 'immediate' || importance >= 3 ? 'critical'
      : reactionClass === 'fast' || importance === 2 ? 'batch'
      : 'summary'

    const queuedMono = this.mono()
    this.latency.record('receiptToQueueMs', Math.max(0, queuedMono - recvMono))

    // Open a fresh collection window the first time an undelivered event
    // arrives after the previous batch was delivered (or at startup).
    if (this._batchOpenedAt === null) this._batchOpenedAt = receivedAt

    const evt = {
      sequence: this.sequence,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      monotonicTime: recvMono,
      worldTime,
      occurrenceTimeKnown,
      occurredAt,
      observedAt,
      receivedAt,
      processedAt: spec.processedAt ?? null,
      source: cleanText(spec.source || 'internal', 32),
      eventType,
      reactionClass,
      observationBasis: ['direct', 'scanned_diff', 'inferred', 'reported'].includes(spec.observationBasis)
        ? spec.observationBasis
        : (occurrenceTimeKnown ? 'direct' : 'scanned_diff'),
      importance,
      summary,
      where,
      entities: Array.isArray(spec.entities) ? spec.entities.map((e) => cleanText(e, 32)).filter(Boolean).slice(0, 8) : [],
      causalActId: spec.causalActId || null,
      delta: spec.delta ? cleanText(spec.delta, 120) : null,
      groupKey,
      chat: spec.chat || null,
      groupCount: 1,
      samples: null,
      deliveryLane,
      _queuedMono: queuedMono
    }

    if (dedupeKey) this._dedupeMap.set(dedupeKey, { timestampMs: receivedAt, seq: evt.sequence })
    this.events.push(evt)
    this.stats.emitted += 1
    this._enforceBounds()
    if (this.isDurable(evt) && evt.processedAt === null) {
      this._dirty = true
      this.save()
    }
    return { deduped: false, coalesced: false, event: evt }
  }

  _enforceBounds () {
    if (this.events.length <= this.maxEvents) return
    // Evict processed or ambient (importance === 0) oldest entries first so a
    // flood of irrelevant ambient updates NEVER drops undelivered important events!
    while (this.events.length > this.maxEvents) {
      const idx = this.events.findIndex((e) => e.processedAt !== null || !this.isDurable(e))
      if (idx >= 0) {
        if ((this.events[idx].importance || 0) === 0 && this.events[idx].processedAt === null) {
          this.stats.droppedAmbient += 1
        }
        this.events.splice(idx, 1)
      } else {
        break // never evict unacknowledged durable envelopes
      }
    }
  }

  /** Stamp an event (or sequence list) as processed/delivered to the model or reflex. */
  markProcessed (sequences, { at = this.now(), mono = this.mono(), via = 'model' } = {}) {
    const set = new Set(Array.isArray(sequences) ? sequences : [sequences])
    let dirty = false
    for (const e of this.events) {
      if (!set.has(e.sequence) || e.processedAt !== null) continue
      e.processedAt = at
      e.processedVia = via
      if (e.sequence > this.lastDeliveredSeq) this.lastDeliveredSeq = e.sequence
      if (Number.isFinite(e._queuedMono)) {
        const waitMs = Math.max(0, mono - e._queuedMono)
        if (via === 'reflex') this.latency.record('receiptToReflexMs', waitMs)
        else this.latency.record('queueToModelMs', waitMs)
      }
      if (this.isDurable(e)) dirty = true
    }
    if (dirty) this.save()
  }

  /**
   * Context-reset handler: drops already-delivered and trivial ambient chatter,
   * while preserving undelivered important events (`processedAt === null && importance >= 2`)
   * with their original timestamps so mid-reset emergencies or discoveries are never lost!
   */
  onContextReset () {
    this.events = this.events.filter((e) => e.processedAt === null && this.isDurable(e))
    this.save()
    return this.events.slice()
  }

  undelivered ({ minImportance = 1 } = {}) {
    return this.events.filter((e) => e.processedAt === null && (e.importance || 0) >= minImportance)
  }

  /** Undelivered critical events that bypass the batch window (death, critical health, attack, imminent threat). */
  drainCritical ({ nowMs = this.now() } = {}) {
    const critical = this.events
      .filter((e) => e.processedAt === null && this.deliveryLane(e) === 'critical')
      .sort((a, b) => a.sequence - b.sequence)
    return {
      events: critical,
      count: critical.length,
      firstEventAt: critical.length ? critical[0].timestamp : null,
      lastEventAt: critical.length ? critical[critical.length - 1].timestamp : null
    }
  }

  /**
   * Build one structured `event_batch` from the events accumulated since the
   * last model decision. Critical events are excluded — they are delivered
   * immediately via drainCritical() instead of waiting for the batch window.
   *
   * @returns {{ type:string, event_count:number, first_event_at:string|null,
   *   last_event_at:string|null, windowMs:number, overdue:boolean,
   *   events:object[], moreRemaining:number }}
   */
  formatBatch ({ maxEvents = this.maxBatchEvents, excludeTypes = new Set(), nowMs = this.now() } = {}) {
    const maxEv = Math.max(1, Math.trunc(maxEvents))
    const waitedMs = Math.max(0, nowMs - (this._batchOpenedAt || nowMs))
    // Close the collection window: the next record() opens a fresh window.
    this._batchOpenedAt = null

    const candidates = this.events.filter((e) => {
      if (e.chat || (excludeTypes.has(e.eventType) && !this.isDurable(e))) return false
      if (this.deliveryLane(e) === 'critical') return false // bypasses the batch entirely
      const ageMs = Math.max(0, nowMs - e.receivedAt)
      return e.processedAt === null
        ? (ageMs <= 10 * 60_000 || this.isDurable(e))
        : false // already delivered: never injected into a later batch
    })

    // Priority at the cap: higher importance first, then most recent — a full
    // batch never silently drops important events in favor of ambient chatter.
    const prioritized = candidates.slice().sort((a, b) => {
      if ((b.importance || 0) !== (a.importance || 0)) return (b.importance || 0) - (a.importance || 0)
      return b.sequence - a.sequence
    }).slice(0, maxEv)
    prioritized.sort((a, b) => a.sequence - b.sequence) // chronological for delivery

    const moreRemaining = Math.max(0, candidates.length - prioritized.length)
    const entries = prioritized.map((e) => this.batchEventEntry(e, nowMs))
    const events = this.coalesceBatchEvents(entries, nowMs)
    const first = events[0]
    const last = events[events.length - 1]

    this.stats.batchesDelivered += 1
    return {
      type: 'event_batch',
      event_count: events.length,
      first_event_at: first ? first.timestamp : null,
      last_event_at: last ? last.timestamp : null,
      windowMs: waitedMs,
      overdue: this.batchWindowMs > 0 && waitedMs > this.batchWindowMs,
      events,
      sequences: prioritized.map((e) => e.sequence),
      moreRemaining
    }
  }

  /** One ordered decision frame. Reserve a slot for the newest expedited event
   * when the backlog exceeds the context budget; omitted IDs stay pending. */
  formatDecisionBatch ({ maxEvents = this.maxBatchEvents, excludeTypes = new Set(), nowMs = this.now() } = {}) {
    const candidates = this.events.filter((e) => e.processedAt === null && !e.chat &&
      (!excludeTypes.has(e.eventType) || this.isDurable(e))).sort((a, b) => a.sequence - b.sequence)
    const limit = Math.max(2, Math.trunc(maxEvents) || 2)
    const selected = candidates.slice(0, limit)
    const urgent = candidates.findLast((e) => this.deliveryLane(e) === 'critical')
    if (urgent && selected.length === limit && urgent.sequence > selected[limit - 1].sequence) selected[limit - 1] = urgent
    const events = selected.map((e) => this.batchEventEntry(e, nowMs))
    return { type: 'event_batch', events, event_count: events.length, sequences: selected.map((e) => e.sequence), moreRemaining: candidates.length - events.length }
  }

  /** One batch entry, with elapsed time so the model knows how old the event is. */
  batchEventEntry (e, nowMs) {
    const ageMs = Math.max(0, nowMs - e.timestampMs)
    const severity = (e.importance || 0) >= 3 ? 'critical'
      : (e.importance || 0) === 2 ? 'high'
      : (e.importance || 0) === 1 ? 'medium' : 'low'
    const entry = {
      sequence: e.sequence,
      type: e.eventType,
      timestamp: e.timestamp,
      timestampMs: e.timestampMs,
      elapsedMs: ageMs,
      ageSec: Math.max(0, Math.round(ageMs / 1000)),
      severity,
      description: e.summary,
      where: e.where,
      entities: e.entities,
      cause: e.causalActId || null,
      recovered: Boolean(e.recoveredFromRestart),
      observationBasis: e.observationBasis
    }
    entry.first_timestampMs = e.timestampMs
    entry.last_timestampMs = e.timestampMs
    if (e.groupCount > 1) {
      entry.count = e.groupCount
      entry.first_event_at = e.timestamp
      entry.last_event_at = new Date(e.lastTimestampMs || e.timestampMs).toISOString()
    }
    return entry
  }

  /**
   * Coalesce repeated identical low-priority events into one entry with a count
   * and first/last timestamps. Distinct events are never merged.
   */
  coalesceBatchEvents (entries, nowMs) {
    const out = []
    for (const entry of entries) {
      const prev = out[out.length - 1]
      if (prev && prev.severity === 'low' && entry.severity === 'low' &&
          prev.type === entry.type && prev.description === entry.description &&
          sameWhere(prev.where, entry.where)) {
        prev.count = (prev.count || 1) + 1
        if (!prev.first_event_at) prev.first_event_at = new Date(prev.first_timestampMs).toISOString()
        prev.last_event_at = entry.timestamp
        prev.last_timestampMs = entry.timestampMs
        prev.elapsedMs = Math.max(0, nowMs - entry.timestampMs)
        prev.ageSec = Math.max(0, Math.round(prev.elapsedMs / 1000))
        if (entry.cause && !prev.cause) prev.cause = entry.cause
        for (const ent of entry.entities || []) {
          if (!prev.entities.includes(ent) && prev.entities.length < 12) prev.entities.push(ent)
        }
        continue
      }
      out.push(entry)
    }
    return out
  }

  /** Render one batch entry as a prompt line (chronological history, not "happening now"). */
  formatBatchEventLine (e, nowMs) {
    return formatEventLine(e, nowMs, { badge: e.severity, batch: true })
  }

  /** Render one critical event as an immediate (out-of-batch) prompt line. */
  formatCriticalEventLine (e, nowMs) {
    return formatEventLine(this.batchEventEntry(e, nowMs), nowMs, { badge: 'CRITICAL', batch: false })
  }

  /**
   * Render the accumulated batch as a single structured text block for the
   * model prompt: a chronological history of recent events with timestamps and
   * elapsed ages — explicitly not a single event happening now.
   * @returns {{ text: string, shownSequences: number[], events: object[] }}
   */
  formatBatchForPrompt ({ batch, nowMs = this.now() } = {}) {
    if (!batch || !batch.events.length) return { text: '', shownSequences: [], events: [] }
    const first = batch.events[0]
    const last = batch.events[batch.events.length - 1]
    const oldestAgeSec = Math.max(0, Math.round((nowMs - first.timestampMs) / 1000))
    const ageStr = oldestAgeSec < 90 ? `${oldestAgeSec}s ago` : `${Math.round(oldestAgeSec / 60)}m ago`
    const spanSec = Math.max(0, Math.round((last.timestampMs - first.timestampMs) / 1000))
    const header = `recent events (chronological batch: ${batch.event_count}${spanSec > 0 ? ` over ${spanSec}s` : ''}, oldest ${ageStr})`
    const lines = [header, ...batch.events.map((e) => this.formatBatchEventLine(e, nowMs))]
    return {
      text: lines.join('\n'),
      shownSequences: batch.events.map((e) => e.sequence),
      events: batch.events
    }
  }

  /**
   * Select and format the most relevant events for a System-2 prompt without
   * flooding context. Excludes event types that already have dedicated prompt
   * sections (`chat` when `excludeTypes` requests it) unless recovered/critical.
   *
   * @returns {{ text: string, shownSequences: number[], events: object[] }}
   */
  formatForPrompt ({ max = 8, excludeTypes = new Set(), nowMs = this.now() } = {}) {
    const candidates = this.events.filter((e) => {
      if (e.chat || (excludeTypes.has(e.eventType) && !this.isDurable(e))) return false
      const ageMs = Math.max(0, nowMs - e.receivedAt)
      // Keep undelivered events (up to 10m) and recent delivered context (up to 90s).
      if (e.processedAt === null) return ageMs <= 10 * 60_000 || e.recoveredFromRestart
      return ageMs <= 90_000 && (e.importance || 0) >= 1
    })
    if (!candidates.length) return { text: '', shownSequences: [], events: [] }

    // Prioritize undelivered + higher importance first, then render chronologically (`sequence` asc)!
    const prioritized = candidates.slice().sort((a, b) => {
      const au = a.processedAt === null ? 1 : 0
      const bu = b.processedAt === null ? 1 : 0
      if (au !== bu) return bu - au
      if ((b.importance || 0) !== (a.importance || 0)) return (b.importance || 0) - (a.importance || 0)
      return b.sequence - a.sequence
    }).slice(0, max)
    prioritized.sort((a, b) => a.sequence - b.sequence)

    const lines = prioritized.map((e) => {
      const ageSec = Math.max(0, Math.round((nowMs - e.timestampMs) / 1000))
      const ageStr = ageSec < 90 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`
      const mcClock = e.worldTime?.clock || formatWorldClock(e.worldTime)
      const worldPart = mcClock
        ? `, mc ${mcClock}${e.worldTime?.phase ? ` ${e.worldTime.phase}` : ''}`
        : (e.worldTime?.phase ? `, ${e.worldTime.phase}` : '')
      const timeTag = e.occurrenceTimeKnown
        ? `${ageStr} (${e.timestamp.slice(11, 19)}Z${worldPart})`
        : `observed ${ageStr} (${e.timestamp.slice(11, 19)}Z${worldPart}, exact occurrence time unknown)`
      const sevTag = (e.importance || 0) >= 3 ? '[CRITICAL] ' : ((e.importance || 0) === 2 ? '[HIGH] ' : '')
      const locTag = e.where ? ` @${e.where.x},${e.where.y},${e.where.z}` : ''
      const whoTag = e.entities?.length ? ` [${e.entities.join(',')}]` : ''
      const basisTag = e.observationBasis !== 'direct' ? ` (${e.observationBasis})` : ''
      const selfTag = e.causalActId ? ` [by your ${e.causalActId}]` : ''
      const recTag = e.recoveredFromRestart ? ' [undelivered before restart]' : (e.processedAt === null ? ' [NEW]' : '')
      const burstTag = e.groupCount > 1
        ? ` (x${e.groupCount}${e.samples?.length > 1 ? `: ${e.samples.slice(0, 3).join(' / ')}` : ''})`
        : ''
      return `  - #${e.sequence} ${sevTag}[${timeTag}] ${e.eventType}${locTag}${whoTag}: ${e.summary}${burstTag}${basisTag}${selfTag}${recTag}`
    })

    return {
      text: lines.join('\n'),
      shownSequences: prioritized.map((e) => e.sequence),
      events: prioritized
    }
  }
}

module.exports = { EventPipeline, LatencyTracker, EVENT_DEFAULTS, formatWorldClock, worldTimeOf, monoNow }
