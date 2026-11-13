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

/**
 * Does the line mention one of the bot's names as a word?
 *
 * Brazilian nicknames count: "zincão", "zinquinho", "zinczinho" are the name.
 * "Zinco" is also what friends type — but it is the Portuguese word for the
 * metal, so it only counts when it is plainly a call: "Zinco, cadê você?",
 * "bora, zinco!", or the word alone.
 */
function mentionsBot (text, names) {
  const f = fold(text)
  return names.some((n) => {
    if (new RegExp(`(^|[^a-z0-9_])${n}([^a-z0-9_]|$)`).test(f)) return true
    if (n.length < 4) return false
    const stem = n.endsWith('c') ? `(?:${n}|${n.slice(0, -1)}qu)` : n
    if (new RegExp(`(^|[^a-z0-9_])${stem}(?:ao|zao|inho|zinho|uinho|ito)([^a-z0-9_]|$)`).test(f)) return true
    return new RegExp(`^\\s*${n}o\\s*([,!?:]|$)|,\\s*${n}o\\s*[!?.]*\\s*$`).test(f)
  })
}

// ---------------------------------------------------------------------------
// Language guard. The server speaks Brazilian Portuguese; the prompts, the
// tool results and the model's own habits are English. Telling the model is
// not enough, so every outgoing line is checked: function words do not lie.
// ---------------------------------------------------------------------------
const PT_WORDS = new Set((
  'de da dos das que nao o os um uma pra para com em na nos nas eu voce vc vcs ele ela eles elas meu minha seu sua teu tua isso esse essa ' +
  'isto este esta aqui ali ja ta tava tao vou vai vamos bora tem tenho tinha foi sou estou estava mas por se como quando onde cade sim ' +
  'blz beleza valeu vlw opa oi ola eai tb tambem agora depois ainda muito mais menos bem bom boa obrigado obrigada desculpa mal pode posso ' +
  'quer quero queria tudo nada daqui dai entao pq porque ne kk kkk kkkk tchau ate fui cheguei peguei guardei coloquei achei fiz vi te lhe nem ou ' +
  'ao aos pelo pela num numa dele dela mim ti vem ir indo ficar fica perto longe hoje amanha ontem noite dia aquele aquela quem qual sem sobre ' +
  'tive tava to precisa preciso consigo consegui deu da faz fazer fazendo falta acabou pronto calma espera pera opa eita nossa cara mano galera ' +
  'la ai so correndo fugindo voltei voltando chegando seguindo parei dormir comer'
).split(' '))
const EN_WORDS = new Set((
  'the is are was were i you he she it we they my your his her this that these those and but not of in on at for with from have has had ' +
  'does did will would can could should there here what where when why how yes thanks thank sorry please just now then im ill dont cant ' +
  'its got get going coming be been an hello hey sure okay right some any all out up if about over by too very need want take give found ' +
  'done wait let lets nothing something am hi nearby away back again still running fleeing following arrived cannot didnt wont youre ive'
).split(' '))
// Words both languages use ("a", "as", "do", "no", "me", "so", "to", "come", "ok"…) are in neither list.
const STRONG_EN = new Set(['hello', 'thanks', 'sorry', 'yes', 'sure', 'please', 'done', 'wait', 'coming', 'here', 'there', 'nothing', 'what', 'why', 'where', 'how', 'okay'])
// the guard used to know only PT vs EN. A smaller model may drift
// into Spanish/French/German instead; these function words count AGAINST the
// line exactly like English does (they never collide with the PT function set,
// after accent folding).
const FOREIGN_WORDS = new Set((
  'hola gracias estoy estas quiero quieres puedes tambien ahora donde porque siempre hermano tengo buenos buenas senior senor amigo ' +
  'bonjour merci oui pourquoi comment avec vous tres bienvenue salut ' +
  'hallo danke bitte ich nicht und du bist guten morgen freund warum'
).split(' '))
// A single one of these words is already enough to reject a one-word line.
const STRONG_FOREIGN = new Set(['hola', 'gracias', 'bonjour', 'merci', 'oui', 'hallo', 'danke', 'bitte', 'salut'])

/**
 * Is this outgoing chat line in the server's language?
 * @param {string} text
 * @param {{ names?: string[] }} [opts] player names to ignore ("Steve" is not a word of any language)
 * @returns {{ ok: boolean, pt: number, en: number, words: number }}
 */
function checkPortuguese (text, { names = [] } = {}) {
  const raw = String(text || '')
  const skip = new Set(names.map((n) => fold(n)))
  const words = fold(raw).split(/[^a-z_0-9]+/).filter((w) => w && !/[_0-9]/.test(w) && !skip.has(w))
  let pt = 0
  let en = 0
  let foreign = false
  for (const w of words) {
    if (PT_WORDS.has(w)) pt++
    else if (EN_WORDS.has(w)) en++
    else if (FOREIGN_WORDS.has(w)) { en++; foreign = true }
  }
  // Accents point to Portuguese — unless a known foreign function word is
  // already in play ("bonjour, comment ça va?" must not read as PT).
  if (!foreign && /[ãõçáéíóúâêôà]/i.test(raw)) pt += 2
  let ok = true
  if (words.length === 1) ok = !STRONG_EN.has(words[0]) && !STRONG_FOREIGN.has(words[0])
  else if (en >= 2 && en > pt) ok = false
  else if (en >= 1 && pt === 0 && words.length >= 2) ok = false
  return { ok, pt, en, words: words.length }
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
  checkPortuguese,
  chatAddressesBot,
  chatTriggersSystem2,
  parseChatLine,
  blockEventTriggersSystem2,
  combatEventTriggersSystem2
}
