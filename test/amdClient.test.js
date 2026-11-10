/**
 * Integration test for AmdClient against a LOOPBACK mock of the Radeon Cloud
 * chat-completions endpoint. No external network is touched.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { AmdClient } = require('../src/amdClient')

/** Spin up a scripted mock server; returns {url, hits, close}. */
function mockServer (script) {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body || '{}') })
      const step = script.shift() || { status: 200, json: { choices: [{ message: { content: '{"a":"idle"}' } }], usage: {} } }
      res.writeHead(step.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(step.json ?? step))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

test('successful completion returns content, usage, and sends rc- bearer auth', async () => {
  const server = await mockServer([
    {
      status: 200,
      json: {
        id: 'chatcmpl-test',
        choices: [{ message: { content: '{"a":"idle"}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 9, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 }
      }
    }
  ])
  const client = new AmdClient({ apiKey: 'rc-testkey123', baseUrl: server.url, model: 'DeepSeek-V4-Flash-0731', maxRetries: 0 })
  const { content, usage } = await client.chatCompletion([{ role: 'system', content: 'sys' }, { role: 'user', content: 'vitals hp=20' }])
  assert.equal(content, '{"a":"idle"}')
  assert.equal(usage.cachedTokens, 100)
  assert.equal(server.hits[0].auth, 'Bearer rc-testkey123')
  assert.equal(server.hits[0].url, '/chat/completions')
  assert.equal(server.hits[0].body.max_tokens, 96)
  const stats = client.getStats()
  assert.equal(stats.kvCacheHitRate, 100 / 120)
  await server.close()
})

test('429 is retried with eventual success', async () => {
  const server = await mockServer([
    { status: 429, json: { error: { message: 'rate limited' } } },
    { status: 200, json: { choices: [{ message: { content: '{"a":"attack","n":"zombie"}' } }], usage: { prompt_tokens: 50, completion_tokens: 8 } } }
  ])
  const client = new AmdClient({ apiKey: 'rc-retrykey', baseUrl: server.url, model: 'm', maxRetries: 2 })
  const { content } = await client.chatCompletion([{ role: 'user', content: 'x' }])
  assert.equal(content, '{"a":"attack","n":"zombie"}')
  assert.equal(server.hits.length, 2)
  assert.equal(client.getStats().retries, 1)
  await server.close()
})

test('401 fails immediately without retrying and without leaking the key', async () => {
  const server = await mockServer([
    { status: 401, json: { error: { message: 'invalid api key rc-topsecret999' } } }
  ])
  const client = new AmdClient({ apiKey: 'rc-topsecret999', baseUrl: server.url, model: 'm', maxRetries: 3 })
  await assert.rejects(
    () => client.chatCompletion([{ role: 'user', content: 'x' }]),
    (err) => {
      assert.ok(!String(err.message).includes('rc-topsecret999'), 'key must be redacted from errors')
      return true
    }
  )
  assert.equal(server.hits.length, 1) // no retries on 4xx auth errors
  await server.close()
})

test('malformed response (missing content) is a hard error', async () => {
  const server = await mockServer([
    { status: 200, json: { choices: [] } }
  ])
  const client = new AmdClient({ apiKey: 'rc-x', baseUrl: server.url, model: 'm', maxRetries: 0 })
  await assert.rejects(() => client.chatCompletion([{ role: 'user', content: 'x' }]), /Malformed/)
  await server.close()
})
