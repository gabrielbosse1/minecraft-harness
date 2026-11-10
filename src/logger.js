/**
 * Minimal, dependency-free leveled logger.
 *
 * SECURITY: this logger never prints process.env, the AMD API key, or any
 * header that could carry a credential. Keep it that way.
 */
'use strict'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const activeLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info

function ts () {
  return new Date().toISOString()
}

function log (level, tag, msg, meta) {
  if (LEVELS[level] < activeLevel) return
  const line = `${ts()} [${level}] ${tag} ${msg}`
  if (meta === undefined) {
    ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line)
  } else {
    ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line, meta)
  }
}

module.exports = {
  debug: (tag, msg, meta) => log('debug', tag, msg, meta),
  info: (tag, msg, meta) => log('info', tag, msg, meta),
  warn: (tag, msg, meta) => log('warn', tag, msg, meta),
  error: (tag, msg, meta) => log('error', tag, msg, meta)
}
