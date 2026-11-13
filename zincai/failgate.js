/**
 * failgate.js — stops the model from burning the call budget on an action
 * the body keeps refusing or failing .
 *
 * The measured failure shape: the model answers a refused
 * `attack` again every 3 s — six calls in 14 s, each a full ~3.7k-token
 * prompt, converging never. The same shape appears with `craft` at a table
 * that stayed out of reach, or `take` from a chest another player emptied.
 *
 * Rule: when the SAME call signature (tool + stable args) has failed
 * `maxFails` times inside `windowMs`, the next identical call is refused
 * locally — no world mutation, no reflex interference — and the refusal is
 * recorded WITHOUT waking the model (it shows up in the next natural
 * prompt's results). The failure is also advertised in the prompt so a
 * weaker model gets an explicit "stop trying this" instruction.
 *
 * Only SYNCHRONOUS failures are gated (the churn source). Long tasks that
 * fail later in the background report through a different path and never
 * loop at this cadence.
 *
 * Resets (the world plausibly changed, so a retry is fair):
 *   - any SUCCESS of the same tool clears that tool's entries;
 *   - the bot moving more than `moveBlocks` since a POSITIONAL failure
 *     ("could not reach", "too far", "not loaded" — being elsewhere is the
 *     cure). State failures ("too hurt to fight", "no food") do NOT clear on
 *     movement: the body dragging the bot away (the flee reflex) used to
 *     re-arm the very loop the gate exists to stop (repro 05);
 *   - death/respawn or a NEW threat on screen (clearContext). A hurt event by
 *     itself never clears: being hit does not make "too hurt to fight" viable.
 * Pure local logic, unit-tested. Nothing here talks to the model.
 */
'use strict'

const GATEABLE = new Set([
  'attack', 'craft', 'take', 'put', 'smelt', 'give', 'sleep',
  'use_block', 'look_in', 'equip', 'eat', 'go_to', 'follow', 'build', 'build_shape'
])

/** Fields that change what a call means. Anything else (formatting junk) is ignored. */
const SIG_FIELDS = ['target', 'player', 'n', 'name', 'item', 'count', 'where', 'x', 'y', 'z', 'place', 'blueprint', 'shape', 'block']

/** Failure wording whose cause is WHERE the bot was — moving cures these. */
const POSITIONAL = /could not reach|too far|out of reach|not loaded|can'?t see|no path|unreachable/i

class FailGate {
  constructor ({ windowMs = 120_000, maxFails = 2, moveBlocks = 4, now = () => Date.now() } = {}) {
    this.windowMs = windowMs
    this.maxFails = maxFails
    this.moveBlocks = moveBlocks
    this.now = now
    /** sig -> { n, at, msg, x, z } */
    this.entries = new Map()
    this._lastPos = null
  }

  /** Canonical signature for a gateable action, or null for ungateable ones (say/idle/hold/find/stop/set_mode…). */
  signature (action) {
    const a = String(action?.a || '')
    if (!GATEABLE.has(a)) return null
    const parts = []
    for (const f of SIG_FIELDS) {
      const v = action[f]
      if (v === undefined || v === null || v === '') continue
      parts.push(`${f}=${String(v).toLowerCase().trim()}`)
    }
    return `${a}|${parts.join(',')}`
  }

  /** Forget per-tool entries (a success proves the world can change). */
  clearTool (tool) {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${tool}|`)) this.entries.delete(k)
  }

  /** World context changed — hurt, new threat, death. Retry is fair again. */
  clearContext () {
    this.entries.clear()
  }

  _expired (e) { return this.now() - e.at > this.windowMs }

  /** Has the bot moved enough that a retry is reasonable? Only positional failures earn that. */
  _moved (e, pos) {
    if (!e.posOnly) return false
    if (!pos || e.x === undefined) return false
    return Math.hypot(pos.x - e.x, pos.z - e.z) > this.moveBlocks
  }

  /**
   * Check BEFORE executing. Returns null when the call may proceed, else a
   * refusal message for the model.
   * @param {object} action
   * @param {{x:number, z:number}} [pos] bot position for the move reset
   */
  check (action, pos) {
    const sig = this.signature(action)
    if (!sig) return null
    const e = this.entries.get(sig)
    if (!e) return null
    if (this._expired(e) || this._moved(e, pos)) { this.entries.delete(sig); return null }
    if (e.n < this.maxFails) return null
    return `skipped: the exact same ${String(action.a)} failed ${e.n}x in the last ${Math.round(this.windowMs / 1000)}s (${e.msg}). Do NOT call it again unchanged — use different arguments, go somewhere else first, or use say to explain.`
  }

  /** Record a synchronous failure of an action (called from executeAction's report path). */
  recordFailure (action, msg, pos) {
    const sig = this.signature(action)
    if (!sig) return
    const prev = this.entries.get(sig)
    const m = String(msg || 'failed')
    this.entries.set(sig, {
      n: (prev ? prev.n : 0) + 1,
      at: this.now(),
      msg: m.slice(0, 110),
      posOnly: POSITIONAL.test(m),
      x: pos?.x, z: pos?.z
    })
    if (this.entries.size > 24) {
      // oldest first
      let oldestK = null; let oldestAt = Infinity
      for (const [k, v] of this.entries) if (v.at < oldestAt) { oldestAt = v.at; oldestK = k }
      this.entries.delete(oldestK)
    }
  }

  /** A success of this tool: its past failures no longer mean anything. */
  recordSuccess (action) {
    const sig = this.signature(action)
    if (!sig) return
    this.entries.delete(sig)
  }

  /**
   * Prompt advisory line: what is currently blocked and why, so the model
   * does not have to infer the gate from silence. null when nothing is gated.
   */
  advisoryLine (pos) {
    const parts = []
    for (const [sig, e] of this.entries) {
      if (this._expired(e) || this._moved(e, pos)) continue
      if (e.n < this.maxFails) continue
      parts.push(`${sig.split('|')[0]} (${e.n}x: ${e.msg.slice(0, 60)})`)
    }
    if (!parts.length) return null
    return `blocked repeats: ${parts.slice(0, 3).join('; ')} — do not call these unchanged; change args, move first, or say it in chat`
  }
}

module.exports = { FailGate, GATEABLE }
