/**
 * irc.js — one timeline, written the way an IRC client shows a channel.
 *
 * The model used to get chat as `  Steve: text` with no clock, and everything
 * else that happened (a join, a death, a reflex, the result of its own action)
 * in separate untimed sections. It could not tell a line said three seconds
 * ago from one said three minutes ago, nor what happened between two lines —
 * which is most of what "context" means in a chat.
 *
 * Everything that happens is now one ordered log:
 *
 *   [14:02:07] <Steve> zinc vem aqui
 *   [14:02:09] <Zinc> já vou!
 *   [14:02:10] -Steve- psst, traz o diamante           (a whisper TO the bot)
 *   [14:02:11] >Steve< tá bom                           (a whisper BY the bot)
 *   [14:02:12] * go_to: reached Steve                   (an event / a result)
 *
 * Pure: no I/O, no mineflayer. `Timeline` is a bounded ring; the formatters
 * are functions of their arguments (a clock can be injected for tests).
 */
'use strict'

const pad = (n) => String(n).padStart(2, '0')

/** `[HH:MM:SS]` in the process's local time (what the operator's logs show). */
function stamp (ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now())
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`
}

/** "3s", "2m", "1h" — how long ago, for the header line. */
function ago (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`
}

const clean = (text, max = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * One entry as one IRC line.
 * @param {{ ts:number, kind:'chat'|'whisper'|'self'|'self_whisper'|'event', who?:string, to?:string, text:string }} e
 * @param {{ self?: string }} [opts] the bot's own nick
 */
function formatLine (e, { self = 'Zinc' } = {}) {
  const at = stamp(e.ts)
  const text = clean(e.text)
  switch (e.kind) {
    case 'chat': return `${at} <${e.who}> ${text}`
    case 'whisper': return `${at} -${e.who}- ${text}`
    case 'self': return `${at} <${self}> ${text}`
    case 'self_whisper': return `${at} >${e.to || '?'}< ${text}`
    default: return `${at} * ${text}`
  }
}

/** The legend the prompts print once above a log. */
const LEGEND = '<nick> public line | -nick- whisper to you | >nick< your whisper to them | * event (world, reflex, your own action results)'

class Timeline {
  constructor ({ max = 80, now = () => Date.now() } = {}) {
    this.max = max
    this.now = now
    this.entries = []
    this.seq = 0
  }

  /** Append one entry; returns it (with its sequence number). */
  add (kind, { who = null, to = null, text = '', ts = null } = {}) {
    const body = clean(text)
    if (!body) return null
    const entry = { seq: ++this.seq, ts: Number.isFinite(ts) ? ts : this.now(), kind, who, to, text: body }
    // A burst of identical events (the same refusal, the same reflex line) is
    // one line with a count, not ten lines pushing the conversation out.
    const last = this.entries[this.entries.length - 1]
    if (kind === 'event' && last && last.kind === 'event' && last.base === body && entry.ts - last.ts < 30_000) {
      last.count = (last.count || 1) + 1
      last.ts = entry.ts
      last.text = `${body} (x${last.count})`
      return last
    }
    if (kind === 'event') entry.base = body
    this.entries.push(entry)
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    return entry
  }

  chat (who, text, { whisper = false, ts = null } = {}) { return this.add(whisper ? 'whisper' : 'chat', { who, text, ts }) }
  said (text, { to = null, ts = null } = {}) { return this.add(to ? 'self_whisper' : 'self', { to, text, ts }) }
  event (text, { ts = null } = {}) { return this.add('event', { text, ts }) }

  clear () { this.entries = [] }

  /** The newest `max` entries, optionally only some kinds / only after a sequence number. */
  tail ({ max = 14, kinds = null, afterSeq = 0, maxAgeMs = null } = {}) {
    const now = this.now()
    let list = this.entries
    if (afterSeq) list = list.filter((e) => e.seq > afterSeq)
    if (kinds) list = list.filter((e) => kinds.includes(e.kind))
    if (Number.isFinite(maxAgeMs)) list = list.filter((e) => now - e.ts <= maxAgeMs)
    return list.slice(-max)
  }

  /** Indented IRC lines, oldest first. Empty string when there is nothing. */
  format (opts = {}) {
    const { self = 'Zinc', indent = '  ' } = opts
    return this.tail(opts).map((e) => indent + formatLine(e, { self })).join('\n')
  }
}

module.exports = { Timeline, formatLine, stamp, ago, LEGEND }
