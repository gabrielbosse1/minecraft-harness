/**
 * filter.js — chat line parsing. Pure functions (unit-testable, no LLM).
 *
 * What this file used to be: an "is this line for the bot?" filter. It matched
 * the bot's names and Portuguese nicknames built on them, guessed from the
 * number of players online whether a question "must" be for the bot, tried to
 * carry on conversations, scored outgoing text against a Portuguese word list,
 * and dropped anything that failed. The model never saw the lines it judged
 * irrelevant, and the harness rewrote what it did say.
 *
 * All of that is gone. A chat line is a fact, not a candidate: the model reads
 * the last few seconds of chat as one window and decides for itself who, if
 * anyone, it is answering. This module only parses — who spoke, in what body,
 * and whether it was whispered — so the rest of the harness never has to guess
 * at a server's message format.
 *
 * `behavior.aliases` and the name-matching helpers that fed this filter are
 * removed with it; there is nothing left that needs to know what the bot is
 * called, because nothing gates on its name any more.
 */
'use strict'

/** Lowercase and strip accents ("Zínc" → "zinc", "você" → "voce"). */
const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

const NAME_OK = /^[A-Za-z0-9_]{1,16}$/

/**
 * Parse a raw mineflayer messagestr line into { sender, text, whisper }.
 * Returns null for lines that are not attributable chat (server messages).
 *
 * Handles vanilla (`<Steve> hi`, `Steve whispers to you: hi`) and the common
 * plugin formats (`[Rank] Steve: hi`, `Steve » hi`, `Steve > hi`,
 * `[Steve -> me] hi`). The loose formats only count when `players` (online
 * usernames) is given and contains the sender, so "Server: restarting" or a
 * death message is never mistaken for chat.
 *
 * @param {string} raw
 * @param {{ players?: string[] }} [opts]
 */
function parseChatLine (raw, { players = null } = {}) {
  const s = String(raw || '').replace(/§[0-9a-fk-or]/gi, '').trim()
  if (!s) return null
  let m = /^<([^>]{1,32})>\s*(.+)$/.exec(s)
  if (m) return { sender: cleanName(m[1]), text: m[2], whisper: false }
  m = /^([^\s<>]{1,32})\s+whispers to you:\s*(.+)$/i.exec(s)
  if (m) return { sender: cleanName(m[1]), text: m[2], whisper: true }
  m = /^\[\s*([A-Za-z0-9_]{1,16})\s*(?:->|→|»)\s*(?:me|you|eu|mim|voce|você)\s*\]\s*(.+)$/i.exec(s)
  if (m) return { sender: m[1], text: m[2], whisper: true }
  m = /^([A-Za-z0-9_]{1,16})\s*(?:->|→)\s*(?:me|you)\s*[:»>]?\s*(.+)$/i.exec(s)
  if (m) return { sender: m[1], text: m[2], whisper: true }
  if (!Array.isArray(players) || !players.length) return null
  const online = new Map(players.map((p) => [String(p).toLowerCase(), String(p)]))
  // "[Rank] Name: msg" · "Name: msg" · "Name » msg" · "Name > msg" · "[Rank] Name » msg"
  m = /^(?:\[[^\]]{1,24}\]\s*|\([^)]{1,24}\)\s*)*~?([A-Za-z0-9_]{1,16})(?:\s*\[[^\]]{1,24}\])?\s*(?::|»|>|›|\|)\s+(.+)$/.exec(s)
  if (m && online.has(m[1].toLowerCase())) return { sender: online.get(m[1].toLowerCase()), text: m[2], whisper: false }
  return null
}

/** Strip rank prefixes a server may put inside the angle brackets. */
function cleanName (raw) {
  const parts = String(raw).trim().split(/\s+/)
  const last = parts[parts.length - 1].replace(/^[~*@+]+/, '')
  return NAME_OK.test(last) ? last : String(raw).trim()
}

/**
 * Legacy: should this block update wake the model? The harness no longer
 * wakes on block updates at all (furnaces, doors and growing crops kept it
 * busy answering "idle"); kept for scripts and tests that still import it.
 */
function blockEventTriggersSystem2 (blockUpdate, bot, maxBlocks = 20) {
  const pos = bot?.entity?.position
  if (!pos || !blockUpdate?.position) return false
  const dx = blockUpdate.position.x - pos.x
  const dy = blockUpdate.position.y - pos.y
  const dz = blockUpdate.position.z - pos.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist > maxBlocks) return false
  const name = String(blockUpdate?.name || blockUpdate?.newName || '')
  if (/chest|barrel|shulker|furnace|hopper|door|trapdoor|gate|anvil|enchant/i.test(name)) return true
  return dist <= 6
}

/** Should this entity event (hurt/despawn/spawn) wake System 2? */
function combatEventTriggersSystem2 (event, bot) {
  const pos = bot?.entity?.position
  if (!pos) return false
  const p = event?.position
  if (!p) return true // no position => e.g. bot itself got hurt: definitely relevant
  const dist = Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z)
  return dist <= 30
}

module.exports = {
  fold,
  parseChatLine,
  blockEventTriggersSystem2,
  combatEventTriggersSystem2
}
