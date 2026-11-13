/**
 * settings.js — the single place where process configuration is resolved.
 *
 * There is no `.env`, no dotenv and no committed credentials. Configuration
 * arrives one way: environment variables, which is exactly how PufferPanel
 * hands a template's `run.environmentVars` to the process.
 *
 *   PufferPanel template variable  ->  ${VAR} in run.environmentVars  ->  env
 *
 * Two flavours of knob are supported side by side, because the two files that
 * describe the bot disagree in style:
 *
 *   - SHOUTING_SNAKE_CASE (MC_HOST, AMD_MODEL, ZINC_DATA_DIR ...) — the
 *     PufferPanel template variables. Always win.
 *   - dotted.lowerCase (server.host, amd.model ...) — the same meaning as the
 *     keys inside zincai/config.json. Accepted so a deployment can override a
 *     single config.json value without a new template variable.
 *
 * Booleans and integers are read leniently: a template checkbox arrives as
 * "true"/"false" and a number as "10", but hand-written values ("yes", 1) work
 * too. An empty value always means "not set", so an untouched optional
 * variable never blanks a default.
 *
 * Secrets (AMD_API_KEY / API_KEY / RADEON_API_KEY) live here and nowhere else:
 * no other module reads process.env, and the value is never logged.
 */
'use strict'

const TRUE_RE = /^(1|true|yes|on)$/i
const FALSE_RE = /^(0|false|no|off)$/i

/** Raw value of the first name that is set and non-empty, else undefined. */
function lookup (names) {
  if (!Array.isArray(names)) names = [names] // a bare string would iterate its characters
  for (const name of names) {
    const raw = process.env[name]
    if (raw !== undefined && String(raw).trim() !== '') return String(raw).trim()
  }
  return undefined
}

/** Plain string; an empty value counts as absent so it can never blank a default. */
function str (names, fallback) {
  if (!Array.isArray(names)) names = [names]
  const v = lookup(names)
  return v === undefined ? fallback : v
}

/** Integer, clamped to [min, max]; garbage falls back instead of throwing. */
function int (names, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (!Array.isArray(names)) names = [names]
  const raw = lookup(names)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Float, clamped to [min, max]. */
function float (names, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (!Array.isArray(names)) names = [names]
  const raw = lookup(names)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Boolean. Accepts what a panel actually sends: true/false, 1/0, yes/no, on/off.
 * Anything unrecognised keeps the fallback rather than silently flipping it.
 */
function bool (names, fallback) {
  if (!Array.isArray(names)) names = [names]
  const raw = lookup(names)
  if (raw === undefined) return fallback
  if (TRUE_RE.test(raw)) return true
  if (FALSE_RE.test(raw)) return false
  return fallback
}

/**
 * Enumerated string. A value outside `allowed` is not silently coerced: it is
 * returned in `rejected` so validateConfig() can fail the boot with a message
 * that names the variable.
 */
function option (names, fallback, allowed) {
  if (!Array.isArray(names)) names = [names]
  const raw = lookup(names)
  if (raw === undefined) return { value: fallback, rejected: null }
  const v = raw.toLowerCase()
  if (allowed.includes(v)) return { value: v, rejected: null }
  return { value: fallback, rejected: { name: names[0], value: raw, allowed } }
}

/**
 * The AMD Radeon Cloud Token Factory key, or null.
 * Resolution order matches every other module's historical behaviour.
 */
function apiKey () {
  return lookup(['AMD_API_KEY', 'API_KEY', 'RADEON_API_KEY', 'amd.apiKey']) || null
}

module.exports = { lookup, str, int, float, bool, option, apiKey }
