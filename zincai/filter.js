/**
 * filter.js — heuristic event pre-filter. Pure functions (unit-testable).
 *
 * Nothing here may call an LLM. Every rule is a cheap local check that
 * decides whether a chat line is *for the bot*.
 *
 * There is no friend list: every player is treated the same. What matters is
 * whether the line addresses the bot — by name, by whisper, or by carrying
 * on a conversation the bot is already in.
 */
'use strict'

/** Lowercase and strip accents ("Zínc" → "zinc", "você" → "voce"). */
const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

const QUESTION_RE = /\?\s*$/
const NAME_OK = /^[A-Za-z0-9_]{1,16}$/

/**
 * Names the bot answers to: its login name plus short forms. "ZincAI" is
 * called "zinc" by everyone, so "zinc vem aqui" must count.
 * @param {string} username
 * @param {string[]} [aliases]
 */
function botNames (username, aliases = []) {
  const out = new Set()
  const add = (n) => { const f = fold(n).replace(/[^a-z0-9_]/g, ''); if (f.length >= 3) out.add(f) }
  add(username)
  for (const a of aliases) add(a)
  const base = fold(username).replace(/(ai|bot|_bot|_ai)$/, '')
  if (base.length >= 3) out.add(base)
  return [...out]
}

/** Does the line mention one of the bot's names as a word? */
function mentionsBot (text, names) {
  const f = fold(text)
  return names.some((n) => new RegExp(`(^|[^a-z0-9_])${n}([^a-z0-9_]|$)`).test(f))
}

/**
 * Is this chat line addressed to the bot?
 *
 * @param {string} text the message
 * @param {{ names: string[], whisper?: boolean, inConversation?: boolean,
 *           othersOnline?: number }} ctx
 *   inConversation — the bot and this sender exchanged lines in the last minute
 *   othersOnline   — players online besides the bot
 * @returns {false | 'whisper' | 'name' | 'conversation' | 'question'}
 */
function chatAddressesBot (text, { names = [], whisper = false, inConversation = false, othersOnline = Infinity } = {}) {
  const line = String(text || '').trim()
  if (!line) return false
  if (whisper) return 'whisper'
  if (mentionsBot(line, names)) return 'name'
  if (inConversation) return 'conversation'
  // A question with only one other person online can only be for the bot.
  if (QUESTION_RE.test(line) && othersOnline <= 1) return 'question'
  return false
}

/** Back-compat shim for the old signature (friends are ignored on purpose). */
function chatTriggersSystem2 (rawLine, _sender, _friends = [], names = ['zincai', 'zinc']) {
  return Boolean(chatAddressesBot(rawLine, { names, othersOnline: 1 }))
}

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
  botNames,
  mentionsBot,
  chatAddressesBot,
  chatTriggersSystem2,
  parseChatLine,
  blockEventTriggersSystem2,
  combatEventTriggersSystem2
}
