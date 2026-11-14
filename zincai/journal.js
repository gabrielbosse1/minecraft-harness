/**
 * journal.js — deterministic compaction with goal continuation.
 *
 * Maintains a persistent work journal compacted deterministically (without
 * extra model calls) into:
 *   - recent steps: latest tool calls with identical repeats merged.
 *   - digest: older work folded per goal into counted successes, failures,
 *     deaths, and active locations.
 *   - plan: the model's ordered steps for a goal, with done marks and a next
 *     pointer (`goal {steps, done, next}`).
 *
 * `continuation()` renders a compact continuation block so any fresh turn
 * (after death, restart, context reset, or loop tick) picks up where work
 * left off. `compactSteps()` trims older multi-step turn results in memory.
 *
 * Also here: `compactSteps()`, the in-turn compaction for a multi-step turn
 * (older tool results are shortened and old screenshots dropped once the turn's
 * own history grows past its budget).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const clean = (s, max = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const NO_GOAL = '-'

/** Tools whose calls say nothing about progress (reads, talk, bookkeeping). */
const QUIET = new Set(['idle', 'say', 'reply', 'recall', 'goal', 'social', 'note', 'hold', 'stop', 'inspect_block', 'inspect_region', 'find', 'look_in', 'screenshot', 'redstone_scan', 'redstone_component', 'remember_here'])

/** Stable short signature of a call: tool + the arguments that identify WHAT, not where exactly. */
function signature (tool, args = {}) {
  const a = args || {}
  const what = a.item || a.shape || a.blueprint || a.block || a.what || a.player || a.place || a.target || a.operation || ''
  return `${tool}${what ? ` ${clean(what, 40)}` : ''}`
}

/** A call as one readable phrase: `gather oak_log x20`, `go_to 32,94,49`. */
function phrase (tool, args = {}) {
  const a = args || {}
  const bits = [tool]
  const what = a.item || a.shape || a.blueprint || a.block || a.what || a.target || a.operation
  if (what) bits.push(clean(what, 40))
  if (a.count) bits.push(`x${a.count}`)
  if (a.player) bits.push(clean(a.player, 20))
  if (a.place) bits.push(clean(a.place, 30))
  if (Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.z))) bits.push(`${a.x},${Number.isFinite(Number(a.y)) ? a.y : '~'},${a.z}`)
  if (Array.isArray(a.at) && a.at.length === 3) bits.push(`@${a.at.join(',')}`)
  if (a.id && tool === 'goal') bits.push(clean(a.id, 12))
  return bits.join(' ')
}

class WorkJournal {
  /**
   * @param {{ file?: string|null, now?: () => number, keepRecent?: number, maxDigest?: number, logger?: Function }} opts
   */
  constructor ({ file = null, now = () => Date.now(), keepRecent = 10, maxDigest = 8, logger = () => {} } = {}) {
    this.file = file
    this.now = now
    this.keepRecent = Math.max(4, Math.min(30, Math.trunc(keepRecent) || 10))
    this.maxDigest = Math.max(3, Math.min(20, Math.trunc(maxDigest) || 8))
    this.log = logger
    /** Recent steps, oldest first: { t, tool, sig, text, ok, msg, n, goal, pos } */
    this.recent = []
    /** goalId|'-' -> { done: {sig:{text,n,last,t}}, failed: {sig:{text,n,why,t}}, deaths: [{t,where,cause}], since, steps } */
    this.digest = {}
    /** goalId -> { steps: [{ text, done }], next, updatedAt } */
    this.plans = {}
    /** The goal the model is working on (what a respawn / restart continues). */
    this.focus = null
    this.compactions = 0
    this._dirty = false
    this._savedAt = 0
    this.load()
  }

  // ------------------------------------------------------------ persistence --
  load () {
    if (!this.file) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object') {
        this.recent = Array.isArray(raw.recent) ? raw.recent.filter((e) => e && e.tool).slice(-this.keepRecent * 2) : []
        this.digest = raw.digest && typeof raw.digest === 'object' ? raw.digest : {}
        this.plans = raw.plans && typeof raw.plans === 'object' ? raw.plans : {}
        this.focus = typeof raw.focus === 'string' ? raw.focus : null
        this.compactions = Number(raw.compactions) || 0
      }
    } catch { /* first run or unreadable: start empty */ }
  }

  save ({ force = false } = {}) {
    if (!this.file || (!this._dirty && !force)) return
    if (!force && this.now() - this._savedAt < 2000) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, focus: this.focus, compactions: this.compactions, recent: this.recent, digest: this.digest, plans: this.plans }))
      fs.renameSync(tmp, this.file)
      this._dirty = false
      this._savedAt = this.now()
    } catch (err) { this.log('debug', `journal save: ${err.message || err}`) }
  }

  _touch () { this._dirty = true; this.save() }

  _bucket (goalId) {
    const key = goalId || NO_GOAL
    if (!this.digest[key]) this.digest[key] = { done: {}, failed: {}, deaths: [], since: this.now(), steps: 0 }
    return this.digest[key]
  }

  // ---------------------------------------------------------------- writing --
  /**
   * One finished tool call.
   * @param {{ tool: string, args?: object, ok: boolean, msg?: string, goalId?: string|null, pos?: {x:number,y:number,z:number}|null }} step
   */
  record ({ tool, args = {}, ok, msg = '', goalId = null, pos = null }) {
    if (!tool || tool === 'idle' || tool === 'reply') return null
    const sig = signature(tool, args)
    const text = phrase(tool, args)
    const last = this.recent[this.recent.length - 1]
    const where = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : null
    if (last && last.sig === sig && last.text === text && last.ok === Boolean(ok) && (last.goal || null) === (goalId || null)) {
      last.n = (last.n || 1) + 1
      last.msg = clean(msg, 200)
      last.t = this.now()
      if (where) last.pos = where
    } else {
      this.recent.push({ t: this.now(), tool, sig, text, ok: Boolean(ok), msg: clean(msg, 200), n: 1, goal: goalId || null, pos: where })
    }
    if (this.recent.length > this.keepRecent + 4) this.compact()
    this._touch()
    return this.recent[this.recent.length - 1]
  }

  /** A death belongs to whatever goal was in focus: it is the most important thing a continuation must say. */
  death ({ where = 'unknown', cause = '', goalId = this.focus } = {}) {
    const b = this._bucket(goalId)
    b.deaths.push({ t: this.now(), where: clean(where, 40), cause: clean(cause, 60) })
    if (b.deaths.length > 6) b.deaths.splice(0, b.deaths.length - 6)
    this.recent.push({ t: this.now(), tool: 'DIED', sig: 'DIED', text: `died at ${clean(where, 40)}${cause ? ` (${clean(cause, 60)})` : ''}`, ok: false, msg: '', n: 1, goal: goalId || null, pos: clean(where, 40) })
    this._touch()
  }

  /**
   * Fold the oldest recent steps into the per-goal digest. Deterministic: the
   * same steps always give the same digest, and nothing is invented.
   * @returns {number} how many steps were folded
   */
  compact ({ keep = this.keepRecent } = {}) {
    const over = this.recent.length - Math.max(0, keep)
    if (over <= 0) return 0
    const old = this.recent.splice(0, over)
    for (const e of old) {
      if (e.tool === 'DIED') continue // already counted in deaths
      const b = this._bucket(e.goal)
      b.steps += e.n || 1
      if (QUIET.has(e.tool)) continue
      const side = e.ok ? b.done : b.failed
      const cur = side[e.sig] || { text: e.text, n: 0 }
      cur.n += e.n || 1
      cur.t = e.t
      cur.text = e.text
      if (e.ok) cur.last = clean(e.msg, 90); else cur.why = clean(e.msg, 110)
      side[e.sig] = cur
      // A thing that now works is no longer "what keeps failing".
      if (e.ok && b.failed[e.sig]) delete b.failed[e.sig]
      for (const s of [b.done, b.failed]) {
        const keys = Object.keys(s)
        if (keys.length > this.maxDigest) {
          keys.sort((x, y) => (s[x].t || 0) - (s[y].t || 0)).slice(0, keys.length - this.maxDigest).forEach((k) => delete s[k])
        }
      }
    }
    this.compactions++
    this._touch()
    return old.length
  }

  // ------------------------------------------------------------------ plans --
  /** Replace a goal's ordered steps (done marks of steps with the same text are kept). */
  setPlan (goalId, steps) {
    if (!goalId) return null
    const prev = this.plans[goalId]
    const list = (Array.isArray(steps) ? steps : String(steps || '').split(/\s*(?:;|\n|\d+[.)]\s)\s*/))
      .map((s) => clean(s, 90)).filter(Boolean).slice(0, 10)
    if (!list.length) return prev || null
    const wasDone = new Set((prev?.steps || []).filter((s) => s.done).map((s) => s.text.toLowerCase()))
    this.plans[goalId] = { steps: list.map((text) => ({ text, done: wasDone.has(text.toLowerCase()) })), next: prev?.next || '', updatedAt: this.now() }
    this._touch()
    return this.plans[goalId]
  }

  /** Mark step(s) done by 1-based number. Returns the numbers actually marked. */
  markDone (goalId, numbers) {
    const plan = this.plans[goalId]
    if (!plan) return []
    const marked = []
    for (const raw of [].concat(numbers)) {
      const i = Math.trunc(Number(raw)) - 1
      if (plan.steps[i] && !plan.steps[i].done) { plan.steps[i].done = true; marked.push(i + 1) }
    }
    if (marked.length) { plan.updatedAt = this.now(); this._touch() }
    return marked
  }

  /** The model's own note of the very next thing to do for this goal. */
  setNext (goalId, text) {
    if (!goalId) return
    const plan = this.plans[goalId] || (this.plans[goalId] = { steps: [], next: '', updatedAt: this.now() })
    plan.next = clean(text, 160)
    plan.updatedAt = this.now()
    this._touch()
  }

  setFocus (goalId) {
    const next = goalId || null
    if (this.focus === next) return
    this.focus = next
    this._touch()
  }

  /** Forget goals that no longer exist or are closed (their digest is of no use to anyone). */
  prune (openGoalIds = []) {
    const open = new Set(openGoalIds)
    let changed = false
    for (const key of Object.keys(this.digest)) if (key !== NO_GOAL && !open.has(key)) { delete this.digest[key]; changed = true }
    for (const key of Object.keys(this.plans)) if (!open.has(key)) { delete this.plans[key]; changed = true }
    if (this.focus && !open.has(this.focus)) { this.focus = null; changed = true }
    if (changed) this._touch()
  }

  // ---------------------------------------------------------------- reading --
  _age (t) {
    const sec = Math.max(0, Math.round((this.now() - (t || this.now())) / 1000))
    if (sec < 90) return `${sec}s`
    const min = Math.round(sec / 60)
    return min < 90 ? `${min}m` : `${Math.round(min / 60)}h`
  }

  planLine (goalId) {
    const plan = this.plans[goalId]
    if (!plan || !plan.steps.length) return null
    const firstOpen = plan.steps.findIndex((s) => !s.done)
    return plan.steps.map((s, i) => `${i + 1}${s.done ? '✓' : i === firstOpen ? '→' : '.'} ${s.text}`).join(' | ')
  }

  /** The step to do now: the model's own `next`, else the first plan step not done. */
  nextStep (goalId) {
    const plan = this.plans[goalId]
    if (!plan) return null
    if (plan.next) return plan.next
    const open = plan.steps.find((s) => !s.done)
    return open ? open.text : null
  }

  /**
   * Is the model going round in circles? The same successful call many times
   * with nothing else in between, or the same failure repeated.
   */
  loopHint () {
    const tail = this.recent.slice(-6)
    const rep = tail.find((e) => e.n >= 3 && !QUIET.has(e.tool))
    if (rep) {
      return rep.ok
        ? `you called "${rep.text}" ${rep.n} times in a row — if you need more, ask for the amount in ONE call (count) and move on to the next step`
        : `"${rep.text}" failed ${rep.n} times in a row (${rep.msg.slice(0, 80)}) — do something different`
    }
    const holds = tail.filter((e) => e.tool === 'hold' && !e.ok)
    if (holds.reduce((n, e) => n + e.n, 0) >= 2) return 'hold keeps failing: use the ids from the threats list (or no ids at all), never guessed numbers'
    return null
  }

  /**
   * The block that lets a fresh turn continue the work.
   * @param {{ goal?: {id:string, description:string, status?:string}|null, exclude?: number }} opts
   *        `exclude` = how many of the newest steps are already shown elsewhere (results).
   */
  continuation ({ goal = null, exclude = 0 } = {}) {
    const lines = []
    const gid = goal?.id || null
    const b = this.digest[gid || NO_GOAL]
    if (goal) {
      lines.push(`continue ${goal.id} "${clean(goal.description, 110)}" — this is your current objective; it does NOT need \`goal resume\`, just do the next step:`)
      const plan = this.planLine(gid)
      if (plan) lines.push(`  plan: ${plan}`)
      else lines.push('  plan: none written yet — set one once with goal {operation:"update", id, steps:[…]} so you stop re-planning every turn')
      const next = this.nextStep(gid)
      if (next) lines.push(`  next: ${next}`)
    }
    if (b) {
      const done = Object.values(b.done).sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, this.maxDigest)
      const failed = Object.values(b.failed).sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, this.maxDigest)
      if (done.length) lines.push(`  done earlier${goal ? '' : ' (no goal set)'}: ${done.map((d) => `${d.text}${d.n > 1 ? ` ×${d.n}` : ''}${d.last ? ` → ${d.last}` : ''}`).join('; ')}`)
      if (failed.length) lines.push(`  still failing: ${failed.map((f) => `${f.text}${f.n > 1 ? ` ×${f.n}` : ''} — ${f.why || 'failed'}`).join('; ')}`)
      if (b.deaths.length) {
        const d = b.deaths.slice(-3)
        lines.push(`  deaths on this ${goal ? 'goal' : 'stretch'}: ${b.deaths.length} (${d.map((x) => `${x.where}${x.cause ? ` ${x.cause}` : ''}, ${this._age(x.t)} ago`).join('; ')}) — what killed you before will kill you again: change the approach, not just the place`)
      }
    }
    const shown = this.recent.slice(0, Math.max(0, this.recent.length - Math.max(0, exclude))).filter((e) => !gid || !e.goal || e.goal === gid).slice(-6)
    if (shown.length) {
      lines.push(`  recent steps (oldest first): ${shown.map((e) => `${e.text}${e.n > 1 ? ` ×${e.n}` : ''}${e.tool === 'DIED' ? '' : e.ok ? ' ok' : ` FAILED${e.msg ? ` (${e.msg.slice(0, 70)})` : ''}`}`).join(' → ')}`)
    }
    const hint = this.loopHint()
    if (hint) lines.push(`  loop check: ${hint}`)
    if (!lines.length) return null
    if (!goal) lines.unshift('work so far (compacted):')
    return lines.join('\n')
  }

  /** One sentence for a wake-up after a respawn/restart. */
  resumeSentence (goal) {
    if (!goal) return ''
    const next = this.nextStep(goal.id)
    return `your objective is still ${goal.id} "${clean(goal.description, 80)}"${next ? `; next step: ${next}` : ''} (see the continue block; no goal resume needed)`
  }

  stats () {
    return { recent: this.recent.length, goals: Object.keys(this.digest).length, plans: Object.keys(this.plans).length, compactions: this.compactions, focus: this.focus }
  }
}

/**
 * In-turn compaction: a turn of several steps re-sends every earlier tool
 * result on every call. Once that history is over budget, the OLDEST results
 * are shortened to a headline (the newest `keepFull` stay whole) and only the
 * newest screenshot keeps its image.
 * @param {Array<{ calls: Array<{ result: string }>, images?: object[] }>} history
 * @param {{ maxChars?: number, keepFull?: number, headline?: number }} opts
 * @returns {Array} a compacted COPY (the input is not modified)
 */
function compactSteps (history, { maxChars = 6000, keepFull = 2, headline = 160 } = {}) {
  const list = (history || []).map((h) => ({ ...h, calls: (h.calls || []).map((c) => ({ ...c })) }))
  // Images: newest step that has any keeps them; older ones become text.
  let imageKept = false
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].images?.length) continue
    if (!imageKept) { imageKept = true; continue }
    list[i] = { ...list[i], images: [], imagesDropped: true }
  }
  const size = () => list.reduce((n, h) => n + h.calls.reduce((m, c) => m + String(c.result || '').length, 0), 0)
  for (let i = 0; i < list.length - keepFull && size() > maxChars; i++) {
    for (const c of list[i].calls) {
      const r = String(c.result || '')
      if (r.length > headline + 24) c.result = `${r.slice(0, headline)}… [compacted: ${r.length - headline} more chars dropped — call the tool again if you need them]`
    }
  }
  return list
}

module.exports = { WorkJournal, compactSteps, signature, phrase }
