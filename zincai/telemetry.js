/**
 * telemetry.js — structured session event logging and continuation snapshots in /data.
 *
 * Captures a complete chronological record of what happened during a session:
 *   - world events (blocks, entities, chat, damage, death, inventory, environment)
 *   - survival reflexes (flee episodes, hazard escapes, eating, water clutch, elytra)
 *   - model inputs (prompts, trigger reasons, step numbers, available tools)
 *   - model thoughts & reactions (reasoning traces, assistant text, tool calls, token usage, latency)
 *   - tool execution outcomes and goal lifecycle transitions
 *   - continuation snapshots describing live state, open goals, active plan, last thought, and next steps
 *
 * Output layout under `dataDir` (default: `<repo>/data`):
 *   - `sessions/<sessionId>/events.jsonl`       newline-delimited chronological events
 *   - `sessions/<sessionId>/continuation.json`  latest structured continuation state
 *   - `sessions/<sessionId>/screenshots/*.png`  chronological archive of every screenshot Zinc captured
 *   - `screenshots/last-<view>.png`             quick pointer to the most recent screenshot per view
 *   - `latest.json`                             pointer to the latest session and summary stats
 *
 * Buffered events flush periodically during runtime, whenever the buffer reaches
 * capacity, and synchronously on shutdown/disposal.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function makeSessionId (nowMs = Date.now()) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  const suffix = crypto.randomBytes(3).toString('hex')
  return `${iso}_${suffix}`
}

function safeJson (value) {
  const seen = new WeakSet()
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return Number(v)
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]'
      seen.add(v)
    }
    return v
  })
}

function writeAtomicJson (filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, filePath)
}

function clip (text, max = 16_000) {
  if (text === null || text === undefined) return ''
  const s = String(text)
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s
}

class TelemetryRecorder {
  /**
   * @param {{
   *   dataDir: string,
   *   sessionId?: string,
   *   flushIntervalMs?: number,
   *   maxBuffer?: number,
   *   maxPromptChars?: number,
   *   now?: () => number,
   *   logger?: (level: string, msg: string) => void
   * }} opts
   */
  constructor ({
    dataDir,
    sessionId = null,
    flushIntervalMs = 5000,
    maxBuffer = 50,
    maxPromptChars = 24_000,
    now = () => Date.now(),
    logger = () => {}
  } = {}) {
    if (!dataDir) throw new Error('TelemetryRecorder requires dataDir')
    this.dataDir = path.resolve(dataDir)
    this.now = now
    this.log = typeof logger === 'function' ? logger : () => {}
    this.startedAt = this.now()
    this.sessionId = sessionId || makeSessionId(this.startedAt)
    this.sessionDir = path.join(this.dataDir, 'sessions', this.sessionId)
    this.eventsFile = path.join(this.sessionDir, 'events.jsonl')
    this.continuationFile = path.join(this.sessionDir, 'continuation.json')
    this.screenshotsDir = path.join(this.sessionDir, 'screenshots')
    this.latestScreenshotsDir = path.join(this.dataDir, 'screenshots')
    this.latestFile = path.join(this.dataDir, 'latest.json')

    this.flushIntervalMs = Math.max(250, Number(flushIntervalMs) || 5000)
    this.maxBuffer = Math.max(1, Number(maxBuffer) || 50)
    this.maxPromptChars = Math.max(512, Number(maxPromptChars) || 24_000)

    this._seq = 0
    this._screenshotSeq = 0
    this._buffer = []
    this._timer = null
    this._closed = false
    this._continuationProvider = null
    this._warned = false
    this._dirtyContinuation = true
    this.flushCount = 0

    this.stats = {
      totalEvents: 0,
      worldEvents: 0,
      reflexEvents: 0,
      modelRequests: 0,
      modelResponses: 0,
      toolExecutions: 0,
      toolFailures: 0,
      screenshots: 0,
      goalEvents: 0,
      combatEvents: 0,
      chatIn: 0,
      chatOut: 0,
      deaths: 0,
      errors: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0
    }

    this._lastModelRequest = null
    this._lastModelThought = null
    this._recentTools = []
    this._recentScreenshots = []
    this._recentEvents = []
  }

  /** Register a callback returning live continuation state (position, inventory, goals, plan, journal). */
  setContinuationProvider (fn) {
    this._continuationProvider = typeof fn === 'function' ? fn : null
    this._dirtyContinuation = true
  }

  /** Begin periodic flushing. Safe to call once at session startup. */
  start (meta = {}) {
    if (this._closed) return this
    this.record('session_start', {
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAt).toISOString(),
      ...meta
    })
    this.flush({ reason: 'start' })
    if (!this._timer) {
      this._timer = setInterval(() => {
        this.flush({ reason: 'periodic' })
      }, this.flushIntervalMs)
      if (typeof this._timer.unref === 'function') this._timer.unref()
    }
    return this
  }

  /** Buffer one timestamped event; flushes immediately when buffer fills. */
  record (type, data = {}) {
    const ms = this.now()
    const entry = {
      seq: ++this._seq,
      ts: new Date(ms).toISOString(),
      ms,
      sessionId: this.sessionId,
      type: String(type || 'event'),
      data: data && typeof data === 'object' ? data : { value: data }
    }
    this._buffer.push(entry)
    this.stats.totalEvents++
    this._dirtyContinuation = true
    this._recentEvents.push({ seq: entry.seq, ts: entry.ts, type: entry.type, summary: summarizeEntry(entry) })
    if (this._recentEvents.length > 20) this._recentEvents.shift()
    if (this._buffer.length >= this.maxBuffer) this.flush({ reason: 'buffer_full' })
    return entry
  }

  worldEvent (evt = {}) {
    this.stats.worldEvents++
    if (evt.eventType === 'death') this.stats.deaths++
    return this.record('world_event', {
      eventType: evt.eventType || 'world',
      source: evt.source || 'mineflayer',
      reactionClass: evt.reactionClass || 'ambient',
      summary: clip(evt.summary || '', 400),
      entities: Array.isArray(evt.entities) ? evt.entities.slice(0, 12) : [],
      where: evt.where || null,
      delta: evt.delta || null,
      importance: evt.importance ?? 0
    })
  }

  reflexEvent (evt = {}) {
    this.stats.reflexEvents++
    return this.record('reflex_event', {
      kind: evt.type || 'reflex',
      text: clip(evt.text || '', 400),
      urgent: Boolean(evt.urgent),
      wake: Boolean(evt.wake),
      episode: evt.episode || null
    })
  }

  chatIn ({ sender, text, whisper = false } = {}) {
    this.stats.chatIn++
    return this.record('chat_in', {
      sender: String(sender || ''),
      text: clip(text || '', 600),
      whisper: Boolean(whisper)
    })
  }

  chatOut ({ text, to = null, about = null, sent = true, reason = null } = {}) {
    this.stats.chatOut++
    return this.record('chat_out', {
      text: clip(text || '', 600),
      to: to || null,
      about: about || null,
      sent: Boolean(sent),
      reason: reason || null
    })
  }

  modelRequest ({ lane = 'action', step = 1, reasons = [], prompt = '', toolCount = 0, goalId = null, position = null } = {}) {
    this.stats.modelRequests++
    const rec = {
      lane,
      step,
      reasons: Array.isArray(reasons) ? reasons.map((r) => clip(r, 200)) : [],
      goalId: goalId || null,
      position: position || null,
      toolCount,
      promptChars: String(prompt || '').length,
      prompt: clip(prompt || '', this.maxPromptChars)
    }
    this._lastModelRequest = {
      at: new Date(this.now()).toISOString(),
      lane,
      step,
      reasons: rec.reasons,
      goalId: rec.goalId,
      promptChars: rec.promptChars
    }
    return this.record('model_request', rec)
  }

  modelResponse ({ lane = 'action', step = 1, reasoning = '', content = '', actions = null, reply = null, usage = null, ms = null, finishReason = null } = {}) {
    this.stats.modelResponses++
    const inTok = Number(usage?.prompt_tokens ?? usage?.promptTokens) || 0
    const outTok = Number(usage?.completion_tokens ?? usage?.completionTokens) || 0
    const cachedTok = Number(usage?.cached_tokens ?? usage?.cachedTokens ?? usage?.prompt_tokens_details?.cached_tokens) || 0
    this.stats.tokensIn += inTok
    this.stats.tokensOut += outTok
    this.stats.tokensCached += cachedTok
    const cleanActions = Array.isArray(actions)
      ? actions.map((a) => ({ tool: a?._unknownTool || a?._badArgs || a?.a || 'unknown', args: sanitizeArgs(a) }))
      : null
    const rec = {
      lane,
      step,
      reasoning: clip(reasoning || '', 12_000),
      content: clip(content || '', 8_000),
      actions: cleanActions,
      reply: reply || null,
      usage: usage ? { in: inTok, out: outTok, cached: cachedTok } : null,
      ms: Number.isFinite(ms) ? Math.round(ms) : null,
      finishReason: finishReason || null
    }
    this._lastModelThought = {
      at: new Date(this.now()).toISOString(),
      lane,
      step,
      reasoning: clip(reasoning || '', 4000),
      content: clip(content || '', 2000),
      actions: cleanActions,
      reply: reply ? { text: clip(reply.text || '', 300), to: reply.to || null, do: reply.do || null, task: reply.task || null } : null,
      finishReason: finishReason || null
    }
    return this.record('model_response', rec)
  }

  toolExec ({ tool, args = {}, ok = true, msg = '', ms = null, goalId = null } = {}) {
    this.stats.toolExecutions++
    if (!ok) this.stats.toolFailures++
    const rec = {
      tool: String(tool || 'unknown'),
      args: sanitizeArgs(args),
      ok: Boolean(ok),
      msg: clip(msg || '', 1000),
      ms: Number.isFinite(ms) ? Math.round(ms) : null,
      goalId: goalId || null
    }
    this._recentTools.push({ at: new Date(this.now()).toISOString(), ...rec })
    if (this._recentTools.length > 15) this._recentTools.shift()
    return this.record('tool_exec', rec)
  }

  goalEvent ({ op, goalId = null, description = '', status = '', note = '' } = {}) {
    this.stats.goalEvents++
    return this.record('goal_event', {
      op: String(op || 'update'),
      goalId: goalId || null,
      description: clip(description || '', 240),
      status: String(status || ''),
      note: clip(note || '', 300)
    })
  }

  combatEvent (evt = {}) {
    this.stats.combatEvents++
    return this.record('combat_event', {
      result: evt.result || null,
      target: evt.target || null,
      msg: clip(evt.msg || '', 300)
    })
  }

  lifecycle (phase, extra = {}) {
    return this.record('lifecycle', {
      phase: String(phase || 'event'),
      ...(extra && typeof extra === 'object' ? extra : {})
    })
  }

  operatorCommand ({ name, args = [], ok = true, reply = '' } = {}) {
    return this.record('operator_command', {
      name: String(name || ''),
      args: Array.isArray(args) ? args : [],
      ok: Boolean(ok),
      reply: clip(reply || '', 500)
    })
  }

  /**
   * Archive a captured screenshot PNG into the session log folder (and update
   * `screenshots/last-<view>.png`), and record a structured `screenshot` event
   * in `events.jsonl` + `continuation.json`.
   */
  screenshot (shot, { save = true, sentToModel = true, direction = null, at = null } = {}) {
    this.stats.screenshots++
    this._screenshotSeq++
    const view = String(shot?.view || 'look').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'look'
    const nowMs = this.now()
    const ts = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
    const seqPad = String(this._screenshotSeq).padStart(4, '0')
    let file = null
    let relativeFile = null
    let latestFile = null
    let saveError = null

    if (save !== false && Buffer.isBuffer(shot?.png) && shot.png.length > 0) {
      try {
        fs.mkdirSync(this.screenshotsDir, { recursive: true })
        file = path.join(this.screenshotsDir, `${seqPad}_${ts}_${view}.png`)
        fs.writeFileSync(file, shot.png)
        relativeFile = path.relative(this.dataDir, file)
      } catch (err) {
        saveError = String(err?.message || err)
      }
      try {
        fs.mkdirSync(this.latestScreenshotsDir, { recursive: true })
        latestFile = path.join(this.latestScreenshotsDir, `last-${view}.png`)
        fs.writeFileSync(latestFile, shot.png)
      } catch { /* best-effort latest pointer */ }
    }

    const rec = {
      seq: this._screenshotSeq,
      view,
      width: Number(shot?.width) || null,
      height: Number(shot?.height) || null,
      bytes: Buffer.isBuffer(shot?.png) ? shot.png.length : (Number(shot?.bytes) || 0),
      renderMs: Number.isFinite(shot?.renderMs) ? Math.round(shot.renderMs) : null,
      chunksLoaded: Number.isFinite(shot?.chunksLoaded) ? shot.chunksLoaded : null,
      chunksInView: Number.isFinite(shot?.chunksInView) ? shot.chunksInView : null,
      maxDist: Number.isFinite(shot?.maxDist) ? shot.maxDist : null,
      bearing: Number.isFinite(shot?.bearing) ? shot.bearing : null,
      pitch: Number.isFinite(shot?.pitch) ? shot.pitch : null,
      pos: shot?.pos || null,
      direction: direction ? String(direction) : null,
      at: at && Number.isFinite(at.x) ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null,
      entitiesSeen: Number.isFinite(shot?.entitiesSeen) ? shot.entitiesSeen : null,
      sentToModel: Boolean(sentToModel),
      file: relativeFile,
      latestFile: latestFile ? path.relative(this.dataDir, latestFile) : null,
      saveError,
      summary: clip(shot?.summary || '', 800)
    }

    this._recentScreenshots.push({
      at: new Date(nowMs).toISOString(),
      seq: rec.seq,
      view: rec.view,
      width: rec.width,
      height: rec.height,
      bytes: rec.bytes,
      renderMs: rec.renderMs,
      chunksLoaded: rec.chunksLoaded,
      chunksInView: rec.chunksInView,
      pos: rec.pos,
      file: rec.file
    })
    if (this._recentScreenshots.length > 10) this._recentScreenshots.shift()

    const entry = this.record('screenshot', rec)
    return { file, relativeFile, latestFile, saveError, entry }
  }

  error (where, err) {
    this.stats.errors++
    return this.record('error', {
      where: String(where || 'runtime'),
      message: clip(err?.message || String(err || 'unknown error'), 500),
      stack: err?.stack ? clip(err.stack, 1500) : null
    })
  }

  /** Build the continuation snapshot combining live runtime state with recent telemetry. */
  buildContinuation ({ reason = 'periodic', status = 'running' } = {}) {
    let live = {}
    if (this._continuationProvider) {
      try { live = this._continuationProvider() || {} } catch (err) { live = { providerError: String(err?.message || err) } }
    }
    const nowMs = this.now()
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      status,
      flushReason: reason,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      endedAt: status === 'stopped' ? new Date(nowMs).toISOString() : null,
      botState: live.botState || null,
      activeGoal: live.activeGoal || null,
      openGoals: live.openGoals || [],
      plan: live.plan || null,
      journalDigest: live.journalDigest || null,
      pendingProposals: live.pendingProposals || [],
      lastModelRequest: this._lastModelRequest,
      lastModelThought: this._lastModelThought,
      recentTools: this._recentTools.slice(-10),
      recentScreenshots: this._recentScreenshots.slice(-10),
      recentEvents: this._recentEvents.slice(-12),
      stats: { ...this.stats }
    }
  }

  /** Synchronously flush buffered events and continuation snapshots to /data. */
  flush ({ reason = 'manual', final = false } = {}) {
    const status = final || this._closed ? 'stopped' : 'running'
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true })
      if (this._buffer.length) {
        const lines = this._buffer.map((e) => safeJson(e)).join('\n') + '\n'
        fs.appendFileSync(this.eventsFile, lines, 'utf8')
        this._buffer.length = 0
      } else if (!fs.existsSync(this.eventsFile)) {
        fs.writeFileSync(this.eventsFile, '', 'utf8')
      }
      if (this._dirtyContinuation || final) {
        const continuation = this.buildContinuation({ reason, status })
        writeAtomicJson(this.continuationFile, continuation)
        writeAtomicJson(this.latestFile, {
          sessionId: this.sessionId,
          status,
          startedAt: continuation.startedAt,
          updatedAt: continuation.updatedAt,
          endedAt: continuation.endedAt,
          eventsFile: path.relative(this.dataDir, this.eventsFile),
          continuationFile: path.relative(this.dataDir, this.continuationFile),
          screenshotsDir: path.relative(this.dataDir, this.screenshotsDir),
          stats: continuation.stats
        })
        this._dirtyContinuation = false
      }
      this.flushCount++
      return true
    } catch (err) {
      if (!this._warned) {
        this._warned = true
        this.log('warn', `telemetry flush failed: ${err?.message || err}`)
      }
      return false
    }
  }

  /** Stop periodic timer, log session_end, and synchronously flush all remaining data. */
  close (reason = 'shutdown') {
    if (this._closed) return false
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this.record('session_end', {
      reason: String(reason || 'shutdown'),
      durationMs: Math.max(0, this.now() - this.startedAt),
      stats: { ...this.stats }
    })
    this._closed = true
    return this.flush({ reason, final: true })
  }
}

function sanitizeArgs (obj) {
  if (!obj || typeof obj !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'a' || k.startsWith('_') || v === undefined) continue
    out[k] = typeof v === 'string' ? clip(v, 500) : v
  }
  return out
}

function summarizeEntry (entry) {
  const d = entry.data || {}
  switch (entry.type) {
    case 'world_event': return `${d.eventType}: ${d.summary || ''}`
    case 'reflex_event': return `${d.kind}: ${d.text || ''}`
    case 'chat_in': return `<${d.sender}> ${d.text || ''}`
    case 'chat_out': return `-> ${d.to || 'public'}: ${d.text || ''}`
    case 'model_request': return `${d.lane}#${d.step} (${(d.reasons || []).join('; ')})`
    case 'model_response': return `${d.lane}#${d.step} -> ${Array.isArray(d.actions) ? d.actions.map((a) => a.tool).join('+') : (d.reply?.text ? 'reply' : 'silent')}`
    case 'tool_exec': return `${d.tool}: ${d.ok ? 'ok' : 'FAILED'} — ${d.msg || ''}`
    case 'screenshot': return `screenshot(${d.view} ${d.width}x${d.height}, ${d.renderMs ?? '?'}ms, chunks=${d.chunksInView ?? '?'}/${d.chunksLoaded ?? '?'})${d.file ? ` -> ${d.file}` : ''}`
    case 'goal_event': return `${d.op} ${d.goalId || ''}: ${d.description || d.note || ''}`
    case 'combat_event': return d.msg || d.result || 'combat'
    default: return d.reason || d.message || entry.type
  }
}

module.exports = { TelemetryRecorder, makeSessionId }
