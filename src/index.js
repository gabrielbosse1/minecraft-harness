#!/usr/bin/env node
/**
 * mineflayer-zinc — autonomous Minecraft agent backed by the AMD Radeon Cloud API.
 *
 * Usage:
 *   node src/index.js              start the bot (joins the configured server)
 *   node src/index.js --dry-run    validate config + prompt budget, no network
 *
 * Environment is loaded from .env (see .env.example). The AMD API key MUST be
 * an Radeon Cloud Token Factory key (rc-...). The key is never logged.
 */
'use strict'

const logger = require('./logger')
const { loadConfig, validateConfig } = require('./config')
const { SYSTEM_PROMPT, wordCount } = require('./systemPrompt')

function printDryRun (cfg) {
  const { errors, warnings } = validateConfig(cfg)
  logger.info('dry-run', `config: host=${cfg.mc.host} port=${cfg.mc.port} user=${cfg.mc.username} auth=${cfg.mc.auth}`)
  logger.info('dry-run', `amd: model=${cfg.amdModel} base=${cfg.amdBaseUrl} key=${cfg.amdApiKey ? 'present (rc-*****)' : 'MISSING'}`)
  logger.info('dry-run', `system prompt: ${wordCount(SYSTEM_PROMPT)} words (limit 150), static=${true}`)
  for (const w of warnings) logger.warn('dry-run', w)
  if (errors.length) {
    for (const e of errors) logger.error('dry-run', e)
    process.exitCode = 1
    return
  }
  logger.info('dry-run', 'config OK — not connecting to anything (--dry-run)')
}

async function main () {
  const cfg = loadConfig()

  if (process.argv.includes('--dry-run')) {
    printDryRun(cfg)
    return
  }

  const { errors, warnings } = validateConfig(cfg)
  for (const w of warnings) logger.warn('boot', w)
  if (errors.length) {
    for (const e of errors) logger.error('boot', e)
    logger.error('boot', 'refusing to start with invalid config')
    process.exit(1)
  }

  // Lazy require so --dry-run never loads the network stack.
  const { ZincAgent } = require('./agent')
  const agent = new ZincAgent(cfg)

  const onSignal = (sig) => {
    logger.info('boot', `received ${sig}`)
    agent.shutdown(sig, 0)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  // A rejected promise inside the bot must never take the process down silently.
  process.on('unhandledRejection', (err) => {
    logger.error('boot', `unhandledRejection: ${err?.message || err}`)
  })

  await agent.start()
}

main().catch((err) => {
  logger.error('boot', `fatal: ${err?.message || err}`)
  process.exit(1)
})
