/**
 * settings.test.js — the configuration path a PufferPanel deployment actually
 * uses: template variable -> ${VAR} in run.environmentVars -> process env ->
 * loadConfig(). No .env is involved anywhere.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const settings = require('../src/settings')
const { loadConfig, validateConfig } = require('../zincai/index.js')
const { validate } = require('../pufferpanel/import')

const template = require('../pufferpanel/zincai.json')

/** Run fn with a temporary, exact environment. */
function withEnv (vars, fn) {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, vars)
  try {
    return fn()
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

test('settings: a panel sends strings — booleans and numbers are read leniently', () => {
  withEnv({ A: 'true', B: 'false', C: '1', D: '0', E: 'yes', F: 'off', G: ' 25565 ', H: 'nonsense' }, () => {
    assert.equal(settings.bool('A', false), true)
    assert.equal(settings.bool('B', true), false)
    assert.equal(settings.bool('C', false), true)
    assert.equal(settings.bool('D', true), false)
    assert.equal(settings.bool('E', false), true)
    assert.equal(settings.bool('F', true), false)
    assert.equal(settings.int('G', 1), 25565)
    assert.equal(settings.int('H', 7), 7, 'garbage falls back instead of producing NaN')
    assert.equal(settings.bool('MISSING', true), true)
  })
})

test('settings: an empty variable never blanks a default, and the first set name wins', () => {
  withEnv({ EMPTY: '', BLANK: '   ', SHOUT: 'loud', dotted: 'quiet' }, () => {
    assert.equal(settings.str('EMPTY', 'fallback'), 'fallback')
    assert.equal(settings.str('BLANK', 'fallback'), 'fallback')
    assert.equal(settings.str(['EMPTY', 'SHOUT'], 'fallback'), 'loud')
    assert.equal(settings.str(['EMPTY', 'dotted'], 'fallback'), 'quiet')
    assert.equal(settings.int('EMPTY', 42), 42)
  })
})

test('settings: integers are clamped to the documented bounds', () => {
  withEnv({ LOW: '1', HIGH: '99999', NEG: '-5' }, () => {
    assert.equal(settings.int('LOW', 10, { min: 4, max: 64 }), 4)
    assert.equal(settings.int('HIGH', 10, { min: 4, max: 64 }), 64)
    assert.equal(settings.int('NEG', 0, { min: 0 }), 0)
  })
})

test('settings: an unsupported enum value is reported, never silently coerced', () => {
  withEnv({ MODE: 'pirate' }, () => {
    const r = settings.option(['MODE'], 'explorer', ['explorer', 'hunter', 'builder'])
    assert.equal(r.value, 'explorer')
    assert.deepEqual(r.rejected, { name: 'MODE', value: 'pirate', allowed: ['explorer', 'hunter', 'builder'] })
    assert.deepEqual(validateConfig(loadConfig()).filter((e) => /MODE/.test(e)).length, 0, 'MODE is not a defaults.json-bound enum')
  })
})

test('settings: the AMD key is resolved from the panel variable, in every accepted name', () => {
  withEnv({ AMD_API_KEY: 'rc-panel' }, () => assert.equal(settings.apiKey(), 'rc-panel'))
  withEnv({ API_KEY: 'rc-legacy' }, () => assert.equal(settings.apiKey(), 'rc-legacy'))
  withEnv({ RADEON_API_KEY: 'rc-radeon' }, () => assert.equal(settings.apiKey(), 'rc-radeon'))
  withEnv({ AMD_API_KEY: 'rc-first', API_KEY: 'rc-second' }, () => assert.equal(settings.apiKey(), 'rc-first'))
  withEnv({}, () => assert.equal(settings.apiKey(), null))
  withEnv({ AMD_API_KEY: '' }, () => assert.equal(settings.apiKey(), null), 'an empty secret is not a secret')
})

test('config: the shipped defaults.json is self-contained — no server address, no key', () => {
  const raw = require('../zincai/config/defaults.json')
  assert.equal(raw.amd.apiKey, '', 'a key must never be committed')
  assert.equal(raw.server.host, '127.0.0.1', 'a deployment address must never be committed')
  assert.equal(raw.server.username, 'ZincAI')
})

test('config: template environment variables drive every documented knob', () => {
  withEnv({
    AMD_API_KEY: 'rc-panel',
    AMD_API_BASE_URL: 'https://proxy.example/v1/',
    AMD_MODEL: 'Some-Model',
    AMD_MAX_TOKENS: '640',
    AMD_TEMPERATURE: '0.4',
    AMD_API_TIMEOUT_MS: '45000',
    AMD_CHAT_TIMEOUT_MS: '60000',
    AMD_MAX_CONCURRENT: '1',
    MC_HOST: 'mc.example.net',
    MC_PORT: '25566',
    MC_VERSION: '1.21.4',
    MC_AUTH: 'MICROSOFT',
    MC_ALLOW_SCAFFOLDING: 'true',
    MC_AUTO_ELYTRA: 'false',
    // BOT_MODE / BOT_ALIASES / BOT_LANGUAGE are set but must be INERT now:
    // there are no modes, no name gating and no forced language. A panel
    // template that still carries these variables keeps booting unchanged.
    BOT_MODE: 'builder',
    BOT_ALIASES: 'Zinc, Helper ,',
    BOT_LANGUAGE: 'en',
    INFERENCE_RPM: '30',
    INFERENCE_MIN_INTERVAL_MS: '1500',
    INFERENCE_HEARTBEAT_MS: '0',
    RECONNECT: 'false',
    RECONNECT_MAX_ATTEMPTS: '5',
    ZINC_DATA_DIR: 'data',
    LOG_LEVEL: 'warn'
  }, () => {
    const cfg = loadConfig()
    assert.deepEqual(validateConfig(cfg), [])
    assert.deepEqual(cfg.server, { host: 'mc.example.net', port: 25566, username: 'ZincAI', auth: 'microsoft', version: '1.21.4' })
    assert.equal(cfg.amd.apiKey, 'rc-panel')
    assert.equal(cfg.amd.baseUrl, 'https://proxy.example/v1', 'a trailing slash is trimmed')
    assert.equal(cfg.amd.model, 'Some-Model')
    assert.equal(cfg.amd.maxTokens, 640)
    assert.equal(cfg.amd.temperature, 0.4)
    assert.equal(cfg.amd.timeoutMs, 45000)
    assert.equal(cfg.amd.chatTimeoutMs, 60000)
    assert.equal(cfg.amd.maxConcurrent, 1)
    assert.equal(cfg.behavior.allowScaffolding, true)
    assert.equal(cfg.behavior.autoElytra, false)
    // None of these exist any more; the env vars are accepted and ignored.
    assert.equal(cfg.behavior.mode, undefined, 'there is no mode')
    assert.equal(cfg.behavior.aliases, undefined, 'names are not a gate')
    assert.equal(cfg.behavior.language, undefined, 'language is the model\'s call')
    assert.equal(cfg.inference.rpm, 30)
    assert.equal(cfg.inference.minIntervalMs, 1500)
    assert.equal(cfg.inference.heartbeatMs, 0)
    assert.equal(cfg.reconnect.enabled, false)
    assert.equal(cfg.reconnect.maxAttempts, 5)
  })
})

test('config: dotted names override the same keys as defaults.json', () => {
  withEnv({ 'AMD_API_KEY': 'rc-x', 'server.host': 'dotted.example', 'server.port': '25599', 'amd.model': 'Dotted-Model' }, () => {
    const cfg = loadConfig()
    assert.equal(cfg.server.host, 'dotted.example')
    assert.equal(cfg.server.port, 25599)
    assert.equal(cfg.amd.model, 'Dotted-Model')
    assert.deepEqual(validateConfig(cfg), [])
  })
})

test('config: with nothing set, the committed defaults are a valid offline deployment', () => {
  withEnv({ AMD_API_KEY: 'rc-dummy' }, () => {
    const cfg = loadConfig()
    assert.deepEqual(validateConfig(cfg), [])
    assert.equal(cfg.server.host, '127.0.0.1')
    assert.equal(cfg.server.port, 25565)
    assert.equal(cfg.server.version, false, 'empty MC_VERSION means auto-detect')
    assert.equal(cfg.server.auth, 'offline')
  })
})

test('config: a missing key fails validation with a message that names the panel variable', () => {
  withEnv({}, () => {
    const errors = validateConfig(loadConfig())
    assert.equal(errors.length, 1)
    assert.match(errors[0], /AMD_API_KEY/)
    assert.doesNotMatch(errors[0], /\.env/, 'the message must not point at a file that no longer exists')
  })
})

test('config: a bad enum fails loudly; a blank variable means "not set", never an empty host', () => {
  withEnv({ AMD_API_KEY: 'rc-x', MC_AUTH: 'modded', MC_HOST: '   ' }, () => {
    const cfg = loadConfig()
    const errors = validateConfig(cfg)
    assert.ok(errors.some((e) => /MC_AUTH/.test(e)), 'MC_AUTH is rejected by name')
    assert.equal(cfg.server.host, '127.0.0.1', 'a blank panel variable falls back to the committed default')
    assert.ok(!errors.some((e) => /MC_HOST/.test(e)))
  })
})

test('template: pufferpanel/zincai.json passes its own validation', () => {
  assert.deepEqual(validate(template), [])
})

test('template: every environmentVars entry is a declared variable or a literal', () => {
  const vars = template.run.environmentVars
  const declared = Object.keys(template.data)
  for (const [name, value] of Object.entries(vars)) {
    assert.match(name, /^[0-9A-Za-z_]+$/)
    for (const m of value.matchAll(/\$\{([^}]+)\}/g)) {
      assert.ok(declared.includes(m[1]), `${name} references undeclared \${${m[1]}}`)
    }
  }
})

test('template: the key is a variable and is only ever passed through the environment', () => {
  assert.ok(template.data.apikey, 'apikey is a variable')
  assert.equal(template.data.apikey.value, '')
  assert.equal(template.run.environmentVars.AMD_API_KEY, '${apikey}')
  const text = JSON.stringify(template.install)
  assert.doesNotMatch(text, /apikey/, 'the key must never be written to a file during install')
})

test('template: stops the bot gracefully with SIGINT (exit 130) like a panel stop button', () => {
  assert.equal(template.run.stopCode, 2)
  assert.equal(template.run.stop, undefined, 'stopCode wins; a console "stop" command would be meaningless')
})

test('template: the boot command is the full ZincAI agent, run through a preflight check', () => {
  const commands = template.run.command.map((c) => c.command).join(' ')
  assert.match(commands, /\$\{entrypoint\}/)
  assert.equal(template.data.entrypoint.value, 'zincai/index.js', 'the boot command runs the full ZincAI agent')
  assert.doesNotMatch(JSON.stringify(template), /src\/index\.js/, 'the retired harness must not be referenced')
  assert.match(template.run.pre.map((p) => p.commands.join(' ')).join(' '), /--dry-run/)
  assert.ok(template.install.some((op) => op.type === 'command' && op.commands.join(' ').includes('npm')), 'dependencies are installed by the template, not by hand')
  assert.ok(template.install.some((op) => op.type === 'nodejsdl' || op.if === "env == 'host'"), 'a host install provisions Node.js')
  assert.equal(template.install.some((op) => op.type === 'writefile'), false, 'no .env is generated: variables come from run.environmentVars')
})

test('template: the datadir variable matches what the bot actually reads', () => {
  assert.equal(template.run.environmentVars.ZINC_DATA_DIR, '${datadir}')
  assert.ok(!path.isAbsolute(template.data.datadir.value), 'a relative data dir stays inside the server folder, so backups include it')
})
