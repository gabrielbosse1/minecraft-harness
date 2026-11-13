/**
 * reasonToText.js — turn a disconnect/kick reason into one readable line.
 *
 * A kick arrives as a Buffer, a serialized NBT node, a classic JSON chat
 * component or a JSON *string* of one. All four shapes are flattened to text so
 * a whitelist rejection can be logged and classified (see reconnect.js)
 * instead of being dumped as key soup.
 *
 * Pure: no bot, no network, never throws.
 */
'use strict'

const truncate = (s, n = 140) => {
  const str = String(s)
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

/**
 * Flatten a modern (1.20.2+ NBT) or classic JSON chat component into plain
 * text. Kick reasons from recent servers are NBT compounds shaped like
 *   { type: 'compound', value: { text: { type: 'string', value: 'x' } } }
 * or nested with extra/with lists. Classic components look like
 *   { text: 'msg', extra: [ ... ] }
 */
function chatComponentToText (node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map(chatComponentToText).join('')

  if (typeof node === 'object') {
    // Serialized NBT node: { type: 'string'|'compound'|'list'|..., value: ... }
    if (typeof node.type === 'string' && 'value' in node) {
      if (node.type === 'compound') return compoundToText(node.value)
      if (node.type === 'list') {
        const inner = node.value
        if (Array.isArray(inner)) return inner.map(chatComponentToText).join('')
        if (inner && Array.isArray(inner.value)) return inner.value.map(chatComponentToText).join('')
        return chatComponentToText(inner)
      }
      return chatComponentToText(node.value) // string/byte/int/...
    }
    // Untyped compound (prismarine-nbt sometimes hands us the bare value map)
    if (isPlainValueMap(node)) return compoundToText(node)
    // Classic JSON chat component
    return compoundToText(node)
  }
  return String(node)
}

function isPlainValueMap (obj) {
  const keys = Object.keys(obj)
  return keys.length > 0 && keys.every((k) => !['type', 'value'].includes(k)) &&
    (keys.includes('text') || keys.includes('translate') || keys.includes('extra') || keys.includes('with') || keys.includes('keybind'))
}

function compoundToText (map) {
  if (!map || typeof map !== 'object') return String(map ?? '')
  let out = ''
  if (map.text !== undefined) out += chatComponentToText(map.text)
  else if (map.translate !== undefined) out += chatComponentToText(map.translate)
  else if (map.keybind !== undefined) out += chatComponentToText(map.keybind)
  if (map.extra !== undefined) out += chatComponentToText(map.extra)
  if (map.with !== undefined) out += chatComponentToText(map.with)
  if (out) return out
  // No recognized chat fields — surface any embedded string leaves so the
  // message is not lost, rather than dumping raw key soup.
  const leaves = collectStringLeaves(map)
  return leaves.length ? leaves.join(' ') : JSON.stringify(map)
}

function collectStringLeaves (node, acc = []) {
  if (typeof node === 'string') { if (node) acc.push(node); return acc }
  if (Array.isArray(node)) { for (const item of node) collectStringLeaves(item, acc); return acc }
  if (node && typeof node === 'object') {
    if (typeof node.type === 'string' && 'value' in node) return collectStringLeaves(node.value, acc)
    for (const [k, v] of Object.entries(node)) { if (k === 'type') continue; collectStringLeaves(v, acc) }
  }
  return acc
}

/** Kick reasons arrive as Buffers, NBT/JSON-ish objects, or JSON strings. */
function reasonToText (reason) {
  try {
    if (reason === null || reason === undefined) return 'unknown'
    if (Buffer.isBuffer(reason)) reason = reason.toString('utf8')
    if (typeof reason === 'object') return truncate(chatComponentToText(reason) || JSON.stringify(reason), 200)
    const s = String(reason)
    // Common shape: {"text":"You are not whitelisted"} as a JSON *string*
    try {
      return truncate(chatComponentToText(JSON.parse(s)), 200)
    } catch {
      return truncate(s, 200)
    }
  } catch {
    return 'unparseable_reason'
  }
}

module.exports = { reasonToText, chatComponentToText }
