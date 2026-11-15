/**
 * memory_text.js — the text-matching primitives shared by every memory layer.
 *
 * Curated memories (`memory.js`), the raw history log (`history.js`) and the
 * entity documents (`entities.js`) must agree on one tokenizer, one synonym
 * table and one similarity metric, or the same query would rank the same
 * evidence differently depending on which store answered it. Keeping them here
 * (instead of inside `memory.js`) also keeps the three stores dependency-free
 * and independently testable.
 */
'use strict'

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'at', 'in', 'on', 'to', 'for',
  'me', 'you', 'i', 'my', 'your', 'is', 'it', 'this', 'that', 'with', 'from',
  // Portuguese (accent-folded) — the players here speak PT-BR.
  'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'uns', 'umas', 'ou', 'que', 'em',
  'no', 'na', 'nos', 'nas', 'para', 'pra', 'pro', 'com', 'por', 'eu', 'voce', 'vc',
  'meu', 'minha', 'seu', 'sua', 'ele', 'ela', 'isso', 'esse', 'essa', 'esta', 'este',
  'onde', 'fica', 'ficam', 'tem', 'como', 'qual', 'quando', 'cade', 'la', 'ali', 'aqui',
  'os', 'as', 'se', 'ao', 'mas', 'foi', 'era', 'ta', 'to', 'gente'
])

/** Lowercase and strip accents: "Baú" and "bau", "Não" and "nao" are one word. */
function fold (text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Small, curated synonym map for the vocabulary a Minecraft player actually
 * uses when asking where something is. This is what lets "the stash"/"treasure"
 * meet a memory that says "diamonds". It is deliberately a fixed table, not a
 * model: cheap, predictable, and honest about being a lookup.
 */
const SYNONYMS = [
  ['diamond', 'gem', 'jewel', 'treasure', 'loot', 'stash', 'hoard', 'swag', 'valuable'],
  ['iron', 'ingot'],
  ['gold', 'gilded'],
  ['chest', 'box', 'container', 'storage', 'store'],
  ['house', 'home', 'base', 'cabin', 'hut', 'shelter', 'cottage'],
  ['farm', 'field', 'crops', 'plantation'],
  ['food', 'eat', 'meal', 'provision'],
  ['weapon', 'sword', 'blade', 'gear', 'kit'],
  ['armor', 'armour', 'protection'],
  ['mine', 'mineshaft', 'cavea', 'cave', 'cavern'],
  ['river', 'stream', 'water'],
  ['village', 'town', 'hamlet'],
  ['nether', 'hell'],
  ['enchanted', 'enchantment', 'enchants'],
  ['station', 'workbench', 'bench', 'table'],
  ['furnace', 'smelter', 'kiln', 'oven'],
  ['bed', 'bunk'],
  ['door', 'gate', 'entrance'],
  ['tower', 'spire', 'watchtower'],
  ['bridge', 'crossing'],
  ['path', 'road', 'trail', 'way'],
  ['tunnel', 'corridor', 'shaft'],
  ['portal', 'gateway'],
  ['tree', 'forest', 'wood', 'woods', 'grove'],
  ['spawn', 'origin', 'start']
]

const SYNONYM_OF = (() => {
  const map = new Map()
  for (const group of SYNONYMS) {
    const canonical = group[0]
    for (const word of group) {
      if (!map.has(word)) map.set(word, canonical)
    }
  }
  return map
})()

/** Tokens usable for substring checks (no synonym folding). */
function rawTokens (text) {
  return fold(text)
    .replace(/[^a-z0-9\-_. ,/]/g, ' ')
    .split(/[,\s/]+/)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * Tokenize into an accent-folded bag of meaningful words. A trailing plural
 * "s" is dropped so "diamantes"/"diamante" and "chests"/"chest" meet, and the
 * curated synonyms are folded onto one canonical word.
 */
function tokenize (text) {
  return rawTokens(text).map((w) => SYNONYM_OF.get(w) || w)
}

/** Hashed bag-of-words vector (sparse map token -> tf). */
function embed (text) {
  const counts = new Map()
  for (const tok of tokenize(text)) {
    counts.set(tok, (counts.get(tok) || 0) + 1)
  }
  let norm = 0
  for (const v of counts.values()) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (const [k, v] of counts) counts.set(k, v / norm)
  return counts
}

/** Cosine similarity of two sparse normalized vectors. */
function cosine (a, b) {
  if (!a || !b) return 0
  let dot = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = large.get(k)
    if (w) dot += v * w
  }
  return dot
}

/** True when `needle` appears in `haystack` as a whole word (accent/case folded). */
function hasWholeWord (haystack, needle) {
  const n = fold(needle).trim()
  if (!n) return false
  const h = fold(haystack)
  if (!h.includes(n)) return false
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(h)
}

/** Extract coordinates like "100,64,200" or "100 64 200" from text. */
function extractLocationFromText (text, defaultDim = 'overworld') {
  const m = String(text || '').match(/(-?\d{1,6})\s*[, ]\s*(-?\d{1,4})\s*[, ]\s*(-?\d{1,6})/)
  if (!m) return null
  const x = Number(m[1]); const y = Number(m[2]); const z = Number(m[3])
  if (![x, y, z].every(Number.isFinite) || y < -128 || y > 400) return null
  return { x, y, z, dim: defaultDim }
}

/** Collapse whitespace and cap a string, marking cut text with an ellipsis. */
function clip (text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!Number.isFinite(max) || s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1))}…`
}

/** ISO date (UTC) of a ms timestamp; 'unknown' when not a number. */
function isoDay (ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : 'unknown'
}

module.exports = {
  STOPWORDS,
  SYNONYMS,
  SYNONYM_OF,
  fold,
  rawTokens,
  tokenize,
  embed,
  cosine,
  hasWholeWord,
  extractLocationFromText,
  clip,
  isoDay
}
