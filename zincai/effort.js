/**
 * effort.js — does THIS model call need a reasoning phase?
 *
 * A reasoning model writes its thoughts before the tool call, and on a slow
 * endpoint those thoughts are the whole wait: ~10 tokens/second means 1500
 * tokens of deliberation is two and a half minutes for a 30-token call. Most
 * calls do not need any of it — the plan exists, the last step worked, the
 * next step is written down. A few do: a player asked for something new,
 * something failed and the approach has to change, there is no plan yet.
 *
 * `decideEffort` sorts a call into one of the two, from facts the harness
 * already has. No model call, no heuristics on the wording of chat.
 *
 *   quick  reasoning switched off for this call (answer = the tool call)
 *   think  reasoning on, with room for it (amd.thinkMaxTokens)
 *
 * Pure: everything comes in through the argument.
 */
'use strict'

const MODES = ['adaptive', 'auto', 'on', 'off']

/**
 * @param {{
 *   mode?: string,            inference.thinking
 *   step?: number,            1 = first call of the turn
 *   reasons?: string[],       why this turn started (wake reasons)
 *   danger?: boolean,         threats shown / fleeing / low health
 *   lastFailed?: boolean,     the newest tool result is a failure
 *   stepFailed?: boolean,     (step > 1) a call of the previous step failed
 *   stepAsked?: boolean,      (step > 1) the previous step was a question whose answer needs weighing
 *   loop?: boolean,           the journal's loop check fired
 *   hasGoal?: boolean,        there is a current objective
 *   hasNext?: boolean,        ... and its next step is written down (plan → or `next`)
 *   thinkStreak?: number,     consecutive thinking calls so far
 * }} s
 * @returns {{ think: boolean, why: string, line: string }}
 */
function decideEffort (s = {}) {
  const mode = MODES.includes(s.mode) ? s.mode : 'adaptive'
  const reasons = Array.isArray(s.reasons) ? s.reasons : []
  const quick = (why, line) => ({ think: false, why, line: line || QUICK_LINE })
  const think = (why, about) => ({ think: true, why, line: `this turn: THINK BRIEFLY — ${about} Two or three short sentences, then the call.` })

  if (mode === 'off') return quick('thinking off')
  if (mode === 'on' || mode === 'auto') return { think: true, why: `thinking ${mode}`, line: '' }

  // Seconds matter more than depth: a three-minute thought about a zombie two
  // blocks away is answered by the zombie.
  if (s.danger) return quick('danger', 'this turn: QUICK — you are in danger and every second of thought is a second of damage. One call now: `attack`, `shelter`, `eat`, `go_to` somewhere open, or `idle` to keep running.')

  if ((s.step || 1) > 1) {
    if (s.stepFailed) return think('a call just failed', 'your last call failed: read why and change the approach (different tool, different arguments, a smaller ask).')
    if (s.stepAsked) return think('weighing what was found', 'you asked and got an answer: decide what it means for the plan.')
    return quick('continuing the turn')
  }

  const has = (re) => reasons.some((r) => re.test(String(r)))
  if (has(/^chat request from /)) return think('a player asked for something', 'a player asked for something: decide whether and how you do it, and what the first call is.')
  if (has(/\b(died|death|respawn)/i)) return think('after a death', 'you died: decide what must be different this time (safety first), then the first call.')
  if (s.loop) return think('repeating itself', 'the loop check says you are repeating yourself: pick a different call.')
  if (s.lastFailed) return think('the last result failed', 'the last result is a failure: read why and change the approach.')
  if (!s.hasGoal) return think('no objective', 'you have no current objective: choose one (or `idle`).')
  if (!s.hasNext) return think('no plan yet', 'this goal has no plan: write it once with `goal` (`steps`), and start the first step in the same answer.')
  // The cheap path must not become the only path: every so often, look up.
  if (Number(s.quickStreak) >= 8) return think('periodic review', 'you have acted without reflecting for a while: is the plan still right? If yes, carry on with the → step.')
  return quick('continuing the plan')
}

const QUICK_LINE = 'this turn: QUICK — nothing new to decide. Do the `→` / `next` step with the tool call now.'

/** Tools whose result is information to weigh, not an action that happened. */
const QUESTION_TOOLS = new Set(['screenshot', 'redstone_scan', 'redstone_component', 'logic_test', 'inspect_region', 'recall'])

module.exports = { decideEffort, MODES, QUESTION_TOOLS }
