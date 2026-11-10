/**
 * Central configuration — loaded once from environment (.env via dotenv).
 *
 * .env is expected to look like:
 *   API_KEY="rc-..."          (Radeon Cloud Token Factory key; NEVER logged)
 *   AMD_API_BASE_URL=...      (optional override)
 *   AMD_MODEL=...             (optional override)
 *   MC_HOST / MC_PORT / MC_AUTH / MC_VERSION / MC_USERNAME
 *
 * The AMD key is exposed ONLY as config.amdApiKey and handed to the HTTP
 * client; no other module ever reads process.env directly.
 */
'use strict'

require('dotenv').config() // loads .env from the repo root if present

function str (name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : String(v)
}

function int (name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function float (name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

function loadConfig () {
  // ---- AMD / Radeon Cloud -------------------------------------------------
  // .env in this private repo carries API_KEY="rc-...". We also accept the
  // more explicit names; first one wins. The key value is never printed.
  const amdApiKey = process.env.API_KEY || process.env.AMD_API_KEY || process.env.RADEON_API_KEY || null
  const amdBaseUrl = str('AMD_API_BASE_URL', 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/+$/, '')
  const amdModel = str('AMD_MODEL', 'DeepSeek-V4-Flash-0731')

  // ---- Minecraft ----------------------------------------------------------
  // Directive 1: the bot MUST attempt the name "Zinc". MC_USERNAME defaults to
  // it; overriding is possible for local testing but logs a loud warning, and
  // ANY join failure is fatal — the bot never retries under another name.
  const username = str('MC_USERNAME', 'Zinc')

  return {
    amdApiKey,
    amdBaseUrl,
    amdModel,
    amdTimeoutMs: int('AMD_API_TIMEOUT_MS', 20_000, { min: 1_000, max: 120_000 }),
    amdMaxRetries: int('AMD_API_MAX_RETRIES', 2, { min: 0, max: 5 }),
    // The action output is a single line of JSON (<40 tokens). 96 gives room
    // without paying for rambling. Temperature is low — this is control flow,
    // not creative writing.
    amdMaxTokens: int('AMD_MAX_TOKENS', 96, { min: 16, max: 512 }),
    amdTemperature: float('AMD_TEMPERATURE', 0.25, { min: 0, max: 1.5 }),

    mc: {
      host: str('MC_HOST', '127.0.0.1'),
      port: int('MC_PORT', 25565, { min: 1, max: 65535 }),
      username,
      // false = auto-detect server version. Pin with MC_VERSION=1.20.4 if needed.
      version: str('MC_VERSION', '') || false,
      // 'offline' for cracked/private servers, 'microsoft' for premium accounts.
      auth: str('MC_AUTH', 'offline'),
      // Movements for mineflayer-pathfinder. canDig=false by default: the bot
      // will jump/detour rather than chew through blocks it might not own.
      canDig: bool('MC_CAN_DIG', false)
    },

    // ---- Behaviour knobs ---------------------------------------------------
    chatCooldownMs: int('CHAT_COOLDOWN_MS', 3_000, { min: 500 }),
    /** Minimum spacing between AMD calls — keeps us under the ~20 RPM free tier. */
    inferenceMinIntervalMs: int('INFERENCE_MIN_INTERVAL_MS', 3_000, { min: 250 }),
    /** After an idle answer, back off to this interval — nothing is worth tokens. */
    inferenceIdleIntervalMs: int('INFERENCE_IDLE_INTERVAL_MS', 15_000, { min: 1_000 }),
    /** Cap on back-to-back self-chained (non-idle) actions before a forced pause. */
    maxSelfChain: int('MAX_SELF_CHAIN', 12, { min: 1, max: 50 }),
    /** Whether inventory deltas alone wake the LLM (usually noise — mining spam). */
    inferOnInventoryDelta: bool('INFER_ON_INV_DELTA', false),

    maxHealth: 20,
    /** Disengage threshold: 30% of max health. */
    disengageHealthFraction: 0.3,
    engageRadius: int('ENGAGE_RADIUS', 24, { min: 4, max: 64 }),
    attackCooldownMs: int('ATTACK_COOLDOWN_MS', 600, { min: 100 }),
    /** After disengaging, refuse to re-engage for this long. */
    disengageCooldownMs: int('DISENGAGE_COOLDOWN_MS', 10_000, { min: 1_000 }),

    moveTimeoutMs: int('MOVE_TIMEOUT_MS', 45_000, { min: 2_000 }),
    elytraMinFallBlocks: float('ELYTRA_MIN_FALL', 4, { min: 1 }),
    elytraGapBlocks: int('ELYTRA_GAP_BLOCKS', 24, { min: 8 }),
    elytraAutoCooldownMs: int('ELYTRA_AUTO_COOLDOWN_MS', 15_000, { min: 1_000 })
  }
}

/**
 * Fail-fast validation. Returns {errors:[], warnings:[]}.
 * Never includes secret values in the messages.
 */
function validateConfig (cfg) {
  const errors = []
  const warnings = []
  if (!cfg.amdApiKey) {
    errors.push('AMD API key missing. Set API_KEY (or AMD_API_KEY / RADEON_API_KEY) in .env')
  } else if (!String(cfg.amdApiKey).startsWith('rc-')) {
    warnings.push('AMD key does not start with the documented "rc-" prefix — double-check it')
  }
  if (cfg.mc.username !== 'Zinc') {
    warnings.push(`MC_USERNAME is "${cfg.mc.username}" but the whitelist directive mandates "Zinc". Join failures will still abort the process.`)
  }
  if (!['offline', 'microsoft'].includes(cfg.mc.auth)) {
    errors.push('MC_AUTH must be "offline" or "microsoft"')
  }
  try {
    new URL(cfg.amdBaseUrl) // shape check only; we never print it with credentials
  } catch {
    errors.push('AMD_API_BASE_URL is not a valid URL')
  }
  return { errors, warnings }
}

module.exports = { loadConfig, validateConfig }
