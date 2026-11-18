'use strict'

/**
 * AMD API retry handling — `src/amdClient.js` (AmdClient) and
 * `zincai/api_wrapper.js` (AmdToolsClient) against a local scripted HTTP
 * endpoint. Only the LLM HTTP endpoint is simulated; the client code is real.
 *
 * Covers: timeouts, rate limits (429 + Retry-After), server errors (5xx),
 * permanent errors (401/400/501), interrupted streams, successful retries,
 * preserved request payloads across attempts, and no duplicate tool calls.
 */

const http = require('http')
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { AmdClient } = require('../src/amdClient')
const { AmdToolsClient, createZincTools, coerceActions } = require('../zincai/api_wrapper')

const API_KEY = 'rc-test-retry-key'

/** Start a scripted local HTTP server. `handler(info)` must answer the request. */
function startServer (handler) {
  return new Promise((resolve, reject) => {
    const requests = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        const info = { req, res, raw, method: req.method, url: req.url }
        requests.push(info)
        try { handler(info) } catch (err) {
          if (!res.headersSent) { res.writeHead(500); res.end(String(err)) }
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        last: () => requests[requests.length - 1],
        bodies: () => requests.map((r) => { try { return JSON.parse(r.raw) } catch { return r.raw } }),
        close: () => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()) })
      })
    })
    server.on('error', reject)
  })
}

function answer (res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function resetConnection ({ req, res }) {
  // Simulates a transient network failure mid-connection.
  try { res.socket?.destroy() } catch { /* noop */ }
  try { req.socket?.destroy() } catch { /* noop */ }
}

function neverAnswers ({ res }) {
  // Simulates a dead upstream: the socket is held open without a response.
}

function sseAnswer (res, { chunks = [], thenClose = true, status = 200 } = {}) {
  res.writeHead(status, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  let i = 0
  const push = () => {
    if (i >= chunks.length) { if (thenClose) res.end(); return }
    res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
    i++
    setTimeout(push, 20)
  }
  setTimeout(push, 20)
}

const makeClient = (overrides = {}) => new AmdClient({
  apiKey: API_KEY, baseUrl: overrides.baseUrl, model: 'sim-model',
  timeoutMs: overrides.timeoutMs ?? 150, maxRetries: overrides.maxRetries ?? 2
})

describe('amd-retry — AmdClient (src/amdClient.js)', () => {
  test('1a: succeeds on the first attempt when the endpoint is healthy', async () => {
    const server = await startServer((info) => answer(info.res, 200, {
      choices: [{ message: { content: 'ok' } }]
    }))
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
      assert.equal(result.content, 'ok')
      assert.equal(client.stats.requests, 1)
      assert.equal(client.stats.retries, 0)
      assert.equal(server.requests.length, 1)
    } finally { await server.close() }
  })

  test('1b: retries after a transient network failure and recovers', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) resetConnection(info)
      else answer(info.res, 200, { choices: [{ message: { content: 'recovered' } }] })
    })
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
      assert.equal(result.content, 'recovered')
      assert.equal(server.requests.length, 2)
      assert.equal(client.stats.retries, 1)
      assert.equal(client.stats.requests, 2)
    } finally { await server.close() }
  })

  test('1c: retries after a client timeout and recovers', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) neverAnswers(info) // client times out at 150 ms
      else answer(info.res, 200, { choices: [{ message: { content: 'late but ok' } }] }, {}, 20)
    })
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
      assert.equal(result.content, 'late but ok')
      assert.equal(server.requests.length, 2)
      assert.equal(client.stats.timeouts, 1)
      assert.equal(client.stats.retries, 1)
    } finally { await server.close() }
  })

  test('1d: HTTP 429 with Retry-After is honored before retrying (no request storm)', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) answer(info.res, 429, { error: { message: 'rate limited' } }, { 'retry-after': '2' })
      else answer(info.res, 200, { choices: [{ message: { content: 'after backoff' } }] })
    })
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const t0 = Date.now()
      const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
      const elapsed = Date.now() - t0
      assert.equal(result.content, 'after backoff')
      assert.equal(server.requests.length, 2)
      assert.equal(client.stats.retries, 1)
      assert.ok(elapsed >= 1_800, `expected Retry-After wait (~2s), got ${elapsed} ms`)
      assert.equal(client.stats.rateWaits, 1)
    } finally { await server.close() }
  })

  test('1e: HTTP 429 without Retry-After still retries with exponential backoff + jitter', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) answer(info.res, 429, { error: { message: 'rate limited' } })
      else answer(info.res, 200, { choices: [{ message: { content: 'ok' } }] })
    })
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
      assert.equal(result.content, 'ok')
      assert.equal(server.requests.length, 2)
    } finally { await server.close() }
  })

  test('1f: HTTP 500 is retried and recovers', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) answer(info.res, 500, { error: { message: 'internal error' } })
      else answer(info.res, 200, { choices: [{ message: { content: 'ok' } }] })
    })
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
      assert.equal(result.content, 'ok')
      assert.equal(server.requests.length, 2)
    } finally { await server.close() }
  })

  test('1g: HTTP 502 / 503 / 504 are retried', async () => {
    for (const status of [502, 503, 504]) {
      const server = await startServer((info) => {
        if (server.requests.length === 1) answer(info.res, status, { error: { message: 'fault' } })
        else answer(info.res, 200, { choices: [{ message: { content: 'ok' } }] })
      })
      try {
        const client = makeClient({ baseUrl: server.baseUrl })
        const result = await client.chatCompletion([{ role: 'user', content: 'hi' }])
        assert.equal(result.content, 'ok', `status ${status} recovered`)
        assert.equal(server.requests.length, 2, `status ${status} retried`)
      } finally { await server.close() }
    }
  })

  test('1h: permanent errors are NOT retried: 400, 401, 403, 404, 501', async () => {
    for (const status of [400, 401, 403, 404, 501]) {
      const server = await startServer((info) => answer(info.res, status, { error: { message: 'permanent' } }))
      try {
        const client = makeClient({ baseUrl: server.baseUrl })
        await assert.rejects(() => client.chatCompletion([{ role: 'user', content: 'hi' }]), /HTTP /)
        assert.equal(server.requests.length, 1, `status ${status} must not be retried`)
        assert.equal(client.stats.retries, 0, `status ${status} must not retry`)
      } finally { await server.close() }
    }
  })

  test('1i: when all attempts fail the error is clear and reports the attempt count', async () => {
    const server = await startServer((info) => answer(info.res, 500, { error: { message: 'always broken' } }))
    try {
      const client = makeClient({ baseUrl: server.baseUrl, maxRetries: 1 })
      await assert.rejects(() => client.chatCompletion([{ role: 'user', content: 'hi' }]), /after 2 attempt/)
      assert.equal(server.requests.length, 2)
      assert.equal(client.stats.failures, 1)
      assert.equal(client.stats.retries, 1)
    } finally { await server.close() }
  })

  test('1j: the original request payload (context + model config) is preserved across retries', async () => {
    const messages = [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'decide now' }]
    const server = await startServer((info) => {
      const body = JSON.parse(info.raw || '{}')
      if (server.requests.length === 1) resetConnection(info)
      else {
        assert.deepEqual(body.messages, messages, 'messages preserved across retry')
        assert.equal(body.model, 'sim-model')
        assert.equal(body.stream, false)
        answer(info.res, 200, { choices: [{ message: { content: 'ok' } }] })
      }
    })
    try {
      const client = makeClient({ baseUrl: server.baseUrl })
      const result = await client.chatCompletion(messages)
      assert.equal(result.content, 'ok')
      assert.equal(server.requests.length, 2)
    } finally { await server.close() }
  })
})

describe('amd-retry — AmdToolsClient (zincai/api_wrapper.js)', () => {
  test('2a: an interrupted SSE stream is not delivered partially; the retry returns the full message', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) {
        // Stream one chunk, then go silent forever: the stream idle deadline
        // rings mid-stream and the attempt is retried (no partial delivery).
        info.res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        info.res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n')
      } else {
        sseAnswer(info.res, { chunks: [
          { choices: [{ delta: { content: 'hello' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'go_to', arguments: JSON.stringify({ x: 1, z: 2 })}}] }}] },
          { choices: [{ delta: { content: '' } }] }
        ] })
      }
    })
    try {
      const client = new AmdToolsClient({
        apiKey: API_KEY, baseUrl: server.baseUrl, model: 'sim-model',
        timeoutMs: 15_000, maxRetries: 1, streamIdleTimeoutMs: 100,
        maxTimeoutMs: 60_000, chatMaxTimeoutMs: 60_000
      })
      const res = await client._completeNow({
        messages: [{ role: 'user', content: 'go there' }],
        tools: createZincTools(),
        lane: 'action',
        timeoutMs: 15_000,
        maxRetries: 1
      })
      assert.equal(res.message.content, 'hello')
      assert.deepEqual(res.message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'go_to', arguments: JSON.stringify({ x: 1, z: 2 }) } }])
      assert.equal(server.requests.length, 2, 'interrupted stream retried once')
      assert.equal(client.stats.timeouts, 1)
    } finally { await server.close() }
  })

  test('2b: a caller-aborted request is never retried (no duplicate model requests)', async () => {
    const server = await startServer((info) => {
      // Eventually answers, but the caller aborts first.
      setTimeout(() => { try { info.res.end(JSON.stringify({ choices: [{ message: { content: 'too late' } }] }) ) } catch { /* noop */ } }, 500)
    })
    try {
      const client = new AmdToolsClient({
        apiKey: API_KEY, baseUrl: server.baseUrl, model: 'sim-model',
        timeoutMs: 10_000, maxRetries: 2
      })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      await assert.rejects(() => client._completeNow({
        messages: [{ role: 'user', content: 'hi' }],
        tools: createZincTools(),
        lane: 'action',
        timeoutMs: 10_000,
        maxRetries: 2,
        signal: controller.signal
      }), /cancelled by the caller/)
      assert.equal(server.requests.length, 1, 'aborted request not retried')
      assert.equal(client.stats.aborted, 1)
    } finally { await server.close() }
  })

  test('2c: after a retried timeout the harness receives exactly one tool call (no duplicate execution)', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) neverAnswers(info) // timeout
      else answer(info.res, 200, {
        id: 'cmpl-1', object: 'chat.completion', model: 'sim-model',
        choices: [{ index: 0, finish_reason: 'tool_calls',
          message: { role: 'assistant', content: '', tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'go_to', arguments: JSON.stringify({ x: 3, z: 4 }) } }
          ] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      })
    })
    try {
      const client = new AmdToolsClient({
        apiKey: API_KEY, baseUrl: server.baseUrl, model: 'sim-model',
        timeoutMs: 80, maxRetries: 2
      })
      const res = await client._completeNow({
        messages: [{ role: 'user', content: 'go there' }],
        tools: createZincTools(),
        lane: 'action',
        timeoutMs: 80,
        maxRetries: 2
      })
      assert.equal(server.requests.length, 2, 'one retry happened')
      const actions = coerceActions(res.message, { max: 6 })
      assert.equal(actions.length, 1, 'exactly one action after retry')
      assert.equal(actions[0].a, 'go_to')
    } finally { await server.close() }
  })

  test('2d: 429 with Retry-After on the tools path waits and recovers', async () => {
    const server = await startServer((info) => {
      if (server.requests.length === 1) answer(info.res, 429, { error: { message: 'slow down' } }, { 'retry-after': '1' })
      else answer(info.res, 200, { choices: [{ message: { content: 'ok' } }] })
    })
    try {
      const client = new AmdToolsClient({
        apiKey: API_KEY, baseUrl: server.baseUrl, model: 'sim-model',
        timeoutMs: 10_000, maxRetries: 1
      })
      const t0 = Date.now()
      const res = await client._completeNow({
        messages: [{ role: 'user', content: 'hi' }],
        tools: createZincTools(),
        lane: 'action',
        timeoutMs: 10_000,
        maxRetries: 1
      })
      assert.ok(Date.now() - t0 >= 900, 'Retry-After honored on tools path')
      assert.equal(res.message.content, 'ok')
      assert.equal(server.requests.length, 2)
    } finally { await server.close() }
  })
})