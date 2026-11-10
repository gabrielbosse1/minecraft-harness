/**
 * filter.js — heuristic event pre-filter. Pure functions (unit-testable).
 *
 * Nothing here may call an LLM. Every rule is a cheap local check; anything
 * that survives is worth spending System-2 tokens on. Anything blocked falls
 * through to System 1 (or silence).
 */
'use strict'

const TRIGGER_RE = /zincai/i
const QUESTION_RE = /\?\s*$/

/**
 * Should this chat line wake System 2?
 *
 *   - contains "zincai" (any case)                      -> yes
 *   - direct question at the bot (ends with '?')         -> yes
 *   - sender is a tracked friend (memory.friends / cfg)  -> yes
 *   - everything else (spam, emotes, general chatter)    -> no
 */
function chatTriggersSystem2 (rawLine, sender, friends = []) {
  const line = String(rawLine || '').trim()
  if (!line) return false
  if (TRIGGER_RE.test(line)) return true
  if (QUESTION_RE.test(line)) return true
  if (sender && friends.includes(sender)) return true
  return false
}

/**
 * Parse a raw mineflayer messagestr line into { sender, text } — handles the
 * "<Steve> hello" format and "Steve whispers to you: hi". Returns null for
 * lines we cannot attribute (server messages etc. — not chat).
 */
function parseChatLine (raw) {
  const s = String(raw || '').replace(/§[0-9a-fk-or]/gi, '').trim()
  let m = /^<([^>]{1,32})>\s*(.+)$/.exec(s)
  if (m) return { sender: m[1], text: m[2] }
  m = /^([^\s<>]{1,32})\s+whispers to you:\s*(.+)$/i.exec(s)
  if (m) return { sender: m[1], text: m[2] }
  return null
}

/**
 * Should this block update trigger System 2?
 * Block breaks further than `maxBlocks` away are ignored outright.
 * Nearby physical disturbances (chests/doors near the bot) are relevant.
 */
function blockEventTriggersSystem2 (blockUpdate, bot, maxBlocks = 20) {
  const pos = bot?.entity?.position
  if (!pos || !blockUpdate?.position) return false
  const dx = blockUpdate.position.x - pos.x
  const dy = blockUpdate.position.y - pos.y
  const dz = blockUpdate.position.z - pos.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist > maxBlocks) return false
  // Relevant only if it's a "container opened / lid moved" class event or a
  // block placed/broken right on top of what the bot stands near.
  const name = String(blockUpdate?.name || blockUpdate?.newName || '')
  if (/chest|barrel|shulker|furnace|hopper|door|trapdoor|gate|anvil|enchant/i.test(name)) return true
  return dist <= 6 // very close changes are worth a look
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

module.exports = { chatTriggersSystem2, parseChatLine, blockEventTriggersSystem2, combatEventTriggersSystem2 }
