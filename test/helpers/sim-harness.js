/**
 * test/helpers/sim-harness.js — end-to-end simulation harness pairing a real
 * flying-squid Minecraft server with a real ZincAI session (Mineflayer +
 * Host + TelemetryRecorder) and a local OpenAI-compatible HTTP LLM endpoint.
 *
 * Only the remote cloud LLM HTTP endpoint is scripted locally; the Minecraft
 * server, TCP protocol, Mineflayer client, chunks, physics, pathfinding,
 * combat, reflexes, chat, persistence, and telemetry are 100% real.
 */
'use strict'

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { startMcServer, waitFor, sleep, MC_VERSION } = require('./mc-server')
const { loadConfig, makeShared, startSession, createHost } = require('../../zincai/index')

/**
 * Lightweight local OpenAI-compatible `/chat/completions` HTTP server for
 * deterministic scripted model turns (supporting tool_calls, reasoning_content,
 * content, usage, and finish_reason).
 */
async function startScriptedLlmServer () {
  const requests = []
  const actionQueue = []
  const chatQueue = []
  let seq = 0

  function enqueueAction (response) {
    actionQueue.push(response)
  }

  function enqueueChat (response) {
    chatQueue.push(response)
  }

  function formatCompletion (spec, isChat) {
    const id = `chatcmpl-sim-${++seq}`
    if (typeof spec === 'function') spec = spec()
    // Tool-call response (standard OpenAI format)
    if (spec?.toolCalls || spec?.tool_calls) {
      const list = (spec.toolCalls || spec.tool_calls).map((tc, idx) => ({
        id: tc.id || `call_${seq}_${idx}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})
        }
      }))
      return {
        id,
        object: 'chat.completion',
        model: 'sim-model',
        choices: [{
          index: 0,
          finish_reason: spec.finishReason || 'tool_calls',
          message: {
            role: 'assistant',
            content: spec.content ?? '',
            reasoning_content: spec.reasoning || '',
            tool_calls: list
          }
        }],
        usage: spec.usage || { prompt_tokens: 420, completion_tokens: 48, total_tokens: 468 }
      }
    }
    if (isChat && spec?.reply) {
      return {
        id,
        object: 'chat.completion',
        model: 'sim-model',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: spec.reasoning || '',
            tool_calls: [{
              id: `call_chat_${seq}`,
              type: 'function',
              function: {
                name: 'reply',
                arguments: JSON.stringify(spec.reply)
              }
            }]
          }
        }],
        usage: spec.usage || { prompt_tokens: 210, completion_tokens: 32, total_tokens: 242 }
      }
    }
    // Default idle / silent reply
    const fallbackCall = isChat
      ? { name: 'reply', arguments: JSON.stringify({ text: '' }) }
      : { name: 'idle', arguments: '{}' }
    return {
      id,
      object: 'chat.completion',
      model: 'sim-model',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: spec?.reasoning || '',
          tool_calls: [{ id: `call_default_${seq}`, type: 'function', function: fallbackCall }]
        }
      }],
      usage: { prompt_tokens: 180, completion_tokens: 12, total_tokens: 192 }
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      const toolNames = (body.tools || []).map((t) => t?.function?.name).filter(Boolean)
      const isChat = toolNames.length === 1 && toolNames[0] === 'reply'
      requests.push({
        ts: Date.now(),
        lane: isChat ? 'chat' : 'action',
        body,
        toolNames,
        messages: body.messages || []
      })
      const next = isChat ? chatQueue.shift() : actionQueue.shift()
      const payload = formatCompletion(next, isChat)
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(payload))
    })
  })

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })
  const { port } = server.address()

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    enqueueAction,
    enqueueChat,
    actionRequests: () => requests.filter((r) => r.lane === 'action'),
    chatRequests: () => requests.filter((r) => r.lane === 'chat'),
    close: () => new Promise((resolve) => {
      try { server.closeIdleConnections?.() } catch { /* noop */ }
      try { server.closeAllConnections?.() } catch { /* noop */ }
      server.close(() => resolve())
      try { server.unref?.() } catch { /* noop */ }
    })
  }
}

/**
 * Boot a full simulation environment:
 *  - Real flying-squid Minecraft 1.21.4 server
 *  - Local OpenAI-compatible HTTP LLM endpoint
 *  - Real ZincAI shared state, TelemetryRecorder, Host, and Mineflayer session
 */
async function startSimulation ({
  cfgOverrides = {},
  autoStartHost = false,
  keepDataDir = false
} = {}) {
  const mc = await startMcServer()
  const llm = await startScriptedLlmServer()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zincai-sim-'))

  const baseCfg = loadConfig()
  const cfg = {
    ...baseCfg,
    server: {
      ...baseCfg.server,
      host: mc.host,
      port: mc.port,
      username: 'ZincAI',
      auth: 'offline',
      version: MC_VERSION
    },
    amd: {
      ...baseCfg.amd,
      apiKey: 'rc-sim-test-key',
      baseUrl: llm.baseUrl,
      model: 'sim-model',
      timeoutMs: 15_000,
      retries: 0
    },
    inference: {
      ...baseCfg.inference,
      minIntervalMs: 120,
      chatMinIntervalMs: 100,
      chatBatchMs: 250,
      urgentMinIntervalMs: 100,
      loopMs: 600,
      loopBusyMs: 2000,
      heartbeatMs: 0,
      rpm: 120,
      chatReserve: 30,
      maxStepsPerTurn: 6,
      ...(cfgOverrides.inference || {})
    },
    system1: {
      ...baseCfg.system1,
      tickMs: 100,
      calmMs: 800,
      reportGapMs: 500,
      ...(cfgOverrides.system1 || {})
    },
    reconnect: {
      ...baseCfg.reconnect,
      keepAliveTimeoutMs: 30_000,
      maxAttempts: 5,
      baseDelayMs: 200,
      maxDelayMs: 1000
    },
    telemetry: {
      flushIntervalMs: 250,
      maxBuffer: 20
    },
    ...cfgOverrides,
    // Always preserve server/amd connection fields
    ...(cfgOverrides.server ? { server: { ...baseCfg.server, host: mc.host, port: mc.port, username: 'ZincAI', auth: 'offline', version: MC_VERSION, ...cfgOverrides.server } } : {})
  }

  // Silence logger noise during tests unless DEBUG_ZINCAI=1
  if (process.env.DEBUG_ZINCAI !== '1') {
    const logger = require('../../src/logger')
    if (logger && typeof logger.setLevel === 'function') logger.setLevel('error')
  }

  const shared = makeShared(cfg, { dataDir })
  shared.telemetry.start({
    version: MC_VERSION,
    host: mc.host,
    port: mc.port,
    model: cfg.amd.model
  })

  const host = createHost(shared, {
    startSession: (s, onEnd, opts) => startSession(s, onEnd, opts)
  })
  shared.host = host

  let session = null
  if (autoStartHost) {
    host.boot()
    await waitFor(() => host.session?.isSpawned?.() && host.session?.internals?.()?.brain, {
      timeoutMs: 15_000,
      label: 'host session spawn'
    })
    session = host.session
  } else {
    session = startSession(shared, () => {}, { host })
    await waitFor(() => session.isSpawned() && session.internals().brain, {
      timeoutMs: 15_000,
      label: 'ZincAI spawn and subsystems ready'
    })
  }
  // Ensure server player entry is registered and initial chunks settled
  await waitFor(() => mc.getPlayer('ZincAI') && session.bot.entity?.position, {
    timeoutMs: 10_000,
    label: 'server player registration'
  })
  // Let the initial spawn orientation turn complete as default `idle` so tests
  // can enqueue scripted actions deterministically without racing boot.
  await waitFor(() => llm.actionRequests().length >= 1 && !session.internals().brain.busyAction, {
    timeoutMs: 10_000,
    label: 'initial boot turn settled'
  })
  await sleep(100)

  function readTelemetryEvents () {
    shared.telemetry.flush()
    const raw = fs.existsSync(shared.telemetry.eventsFile)
      ? fs.readFileSync(shared.telemetry.eventsFile, 'utf8')
      : ''
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  function readContinuation () {
    const f = shared.telemetry.continuationFile
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  }

  function readLatestIndex () {
    const f = shared.telemetry.latestFile
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  }

  async function stop () {
    const activeSession = host.session || session
    try { host.stop?.() } catch { /* noop */ }
    try { activeSession?.dispose?.(true) } catch { /* noop */ }
    try { clearTimeout(activeSession?.bot?._client?.closeTimer) } catch { /* noop */ }
    try { activeSession?.bot?._client?.socket?.destroy() } catch { /* noop */ }
    try { shared.telemetry.close({ reason: 'test_end' }) } catch { /* noop */ }
    try { shared.watchdog?.stop?.() } catch { /* noop */ }
    await sleep(80)
    await llm.close()
    await mc.close()
    if (!keepDataDir) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* noop */ }
    }
  }

  return {
    mc,
    llm,
    cfg,
    shared,
    host,
    get session () { return host.session || session },
    get bot () { return (host.session || session).bot },
    get internals () { return (host.session || session).internals() },
    dataDir,
    readTelemetryEvents,
    readContinuation,
    readLatestIndex,
    waitFor,
    sleep,
    stop
  }
}

module.exports = {
  startSimulation,
  startScriptedLlmServer,
  waitFor,
  sleep
}
