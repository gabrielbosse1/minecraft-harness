/**
 * Reconnect policy, shared by both harnesses. Pure, so it can be tested.
 *
 *   - never joined at all            → exit 1 (hard rule: no retries, no renames)
 *   - kicked for a reason a retry cannot fix (whitelist, ban…) → exit 1
 *   - reconnect disabled             → exit like before (kick 1, end 0)
 *   - otherwise                      → retry with exponential back-off, same name
 */
'use strict'

/** Kick reasons that retrying cannot fix. */
const FATAL_KICK_RE = /white-?list|banned|not allowed|invalid session|verify username|outdated (client|server)|incompatible|logged in from another location|duplicate login|name .*taken/i

/**
 * @param {{ kind: 'kicked'|'end'|'error', text?: string, everSpawned: boolean,
 *           attempts?: number, reconnect?: { enabled?: boolean, baseDelayMs?: number,
 *           maxDelayMs?: number, maxAttempts?: number }, botName?: string }} input
 * @returns {{ action: 'exit', code: number, reason: string, log: string[] }
 *          | { action: 'retry', attempt: number, maxAttempts: number, delayMs: number }}
 */
function decideReconnect ({ kind, text = '', everSpawned, attempts = 0, reconnect = {}, botName = 'ZincAI' }) {
  if (!everSpawned) {
    return {
      action: 'exit',
      code: 1,
      reason: 'join-failed',
      log: [`FATAL: join rejected (${kind}): ${text}`, `aborting. Check the ply.gg tunnel, the whitelist (name "${botName}"), and MC_AUTH.`]
    }
  }
  if (kind === 'kicked' && FATAL_KICK_RE.test(text)) {
    return { action: 'exit', code: 1, reason: 'kicked', log: [`kicked for a reason a retry cannot fix: ${text}`] }
  }
  if (reconnect.enabled === false) {
    return { action: 'exit', code: kind === 'kicked' ? 1 : 0, reason: kind === 'kicked' ? 'kicked' : 'server-ended', log: [] }
  }
  const maxAttempts = reconnect.maxAttempts ?? 40
  const attempt = attempts + 1
  if (attempt > maxAttempts) {
    return { action: 'exit', code: 1, reason: 'reconnect-exhausted', log: [`gave up after ${maxAttempts} reconnect attempts`] }
  }
  const delayMs = Math.min(reconnect.maxDelayMs ?? 120_000, (reconnect.baseDelayMs ?? 5_000) * 2 ** Math.min(8, attempt - 1))
  return { action: 'retry', attempt, maxAttempts, delayMs }
}

module.exports = { decideReconnect, FATAL_KICK_RE }
