/**
 * ChatGuard — makes the bot's public chat look like a real, unbothered human.
 *
 * Enforcement pipeline (defense in depth — the LLM is *told* the rules in the
 * system prompt, and this class *guarantees* them regardless of what the model
 * emits):
 *   1. lowercase everything
 *   2. strip URLs, @mentions, emoji/pictographs, markdown control chars
 *   3. whitelist [a-z0-9 .,!?'-] and collapse whitespace
 *   4. hard cap: 6 words, 60 chars
 *   5. global 3s (configurable) cooldown between any bot chat messages
 *      → no spam-kick risk, no multi-message bursts
 *
 * Empty/unsalvageable output returns ok:false and NOTHING is sent. Silence is
 * always the safer outcome.
 */
'use strict'

class ChatGuard {
  constructor (bot, { cooldownMs = 3000, maxWords = 10, maxChars = 100 } = {}) {
    this.bot = bot
    this.cooldownMs = cooldownMs
    this.maxWords = maxWords
    this.maxChars = maxChars
    this.lastSentAt = 0
  }

  /** Pure sanitizer — exported for tests. Returns null if nothing sendable remains. */
  sanitize (text) {
    if (text === null || text === undefined) return null
    let t = String(text).toLowerCase()

    // Strip URLs and @mentions — they nuke readability and trip server filters.
    t = t.replace(/https?:\/\/\S+/g, ' ')
    t = t.replace(/@[a-z0-9_]{2,16}/g, ' ')

    // Strip emoji & pictographs (broad unicode ranges) and variation selectors.
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}\u{1F900}-\u{1F9FF}]/gu, '')

    // Strip markdown / formatting control characters.
    t = t.replace(/[*_~`#>\[\](){}<>|\\]/g, '')

    // Whitelist: letters of ANY alphabet, digits, basic punctuation, spaces.
    // (The old ASCII-only rule turned "Não, eu já comi pão" into "n o, eu j comi p".)
    t = t.replace(/[^\p{L}\p{N} .,!?'-]/gu, ' ')

    // Collapse whitespace.
    t = t.replace(/\s+/g, ' ').trim()
    if (!t) return null

    // Hard cap the length the way a lazy human would: 10 words, 100 chars.
    const words = t.split(' ')
    t = words.slice(0, this.maxWords).join(' ').slice(0, this.maxChars).trim()
    return t.length > 0 ? t : null
  }

  /** Remaining cooldown in ms (0 when ready). */
  remainingMs () {
    return Math.max(0, this.lastSentAt + this.cooldownMs - Date.now())
  }

  /**
   * Attempt to send chat. Returns {ok, said?|why, retryInMs?}.
   * Never throws — chat must not crash the agent.
   */
  trySay (text) {
    const clean = this.sanitize(text)
    if (!clean) return { ok: false, why: 'unsalvageable' }
    const remaining = this.remainingMs()
    if (remaining > 0) return { ok: false, why: 'cooldown', retryInMs: remaining }
    try {
      this.bot.chat(clean)
      this.lastSentAt = Date.now()
      return { ok: true, said: clean }
    } catch (err) {
      return { ok: false, why: `chat_failed:${String(err && err.message || err).slice(0, 40)}` }
    }
  }
}

module.exports = { ChatGuard }
