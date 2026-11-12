/**
 * Aggregate all campaign measurements into reports/METRICS.json and append a
 * section to reports/FINAL_REPORT.md (or reports/METRICS_SNAPSHOT_<ts>.md).
 *   node aggregate_metrics.js [snapshot]
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DATA = path.join(ROOT, 'zincai-data')
const REPORTS = path.join(ROOT, 'reports')

function readJsonl (f) {
  try {
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

const modelCalls = readJsonl(path.join(DATA, 'metrics.jsonl'))
const samples = readJsonl(path.join(ROOT, 'metrics', 'samples.jsonl'))
const manifest = JSON.parse(fs.readFileSync(path.join(REPORTS, 'manifest.json'), 'utf8'))

const latency = modelCalls.map((c) => c.ms ?? c.latency_ms).filter((v) => Number.isFinite(v))
const inTok = modelCalls.reduce((s, c) => s + (c.in ?? c.input_tokens ?? 0), 0)
const outTok = modelCalls.reduce((s, c) => s + (c.out ?? c.output_tokens ?? 0), 0)
const cached = modelCalls.reduce((s, c) => s + (c.cached ?? c.cached_tokens ?? 0), 0)
const p = (arr, q) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

const botLog = fs.existsSync(path.join(ROOT, 'logs', 'bot.log')) ? fs.readFileSync(path.join(ROOT, 'logs', 'bot.log'), 'utf8') : ''
const count = (re) => (botLog.match(re) || []).length
const serverLog = fs.existsSync(path.join(ROOT, 'server', 'logs', 'latest.log')) ? fs.readFileSync(path.join(ROOT, 'server', 'logs', 'latest.log'), 'utf8') : ''
const tpsLines = (serverLog.match(/Tick \(20ms\)[^\n]*/g) || []).slice(-10)

const results = manifest.completed_tests || []
const failures = manifest.failed_tests || []

const metrics = {
  generated_at: new Date().toISOString(),
  campaign: manifest.campaign,
  stage: manifest.current_stage,
  elapsed_min: manifest.started_at ? ((Date.now() - new Date(manifest.started_at).getTime()) / 60000).toFixed(1) : null,
  tests: {
    attempted: results.length + failures.length + (manifest.skipped_tests || []).length + (manifest.interrupted_tests || []).length,
    passed: results.length,
    failed: failures.length,
    skipped: (manifest.skipped_tests || []).length,
    interrupted: (manifest.interrupted_tests || []).length,
    pass_rate: results.length + failures.length ? (100 * results.length / (results.length + failures.length)).toFixed(1) + '%' : 'n/a'
  },
  model: {
    calls_total: modelCalls.length,
    in_tokens: inTok, out_tokens: outTok, cached_tokens: cached,
    avg_in_per_call: modelCalls.length ? Math.round(inTok / modelCalls.length) : null,
    avg_out_per_call: modelCalls.length ? Math.round(outTok / modelCalls.length) : null,
    latency_ms: { min: p(latency, 0), p50: p(latency, 0.5), p90: p(latency, 0.9), max: p(latency, 1) }
  },
  bot: {
    log_lines: botLog ? botLog.split('\n').length : 0,
    deaths: count(/died|death|respawn/gi),
    flee_episodes: count(/FLEEING/gi),
    errors: count(/\bERROR\b|error:/gi),
    model_timeouts: count(/timeout|ETIMEDOUT/gi),
    kicked: count(/kicked|kick/gi)
  },
  server: {
    recent_tps: tpsLines.map((l) => l.slice(0, 160)),
    warnings_count: (serverLog.match(/WARN\]/g) || []).length,
    errors_count: (serverLog.match(/ERROR\]/g) || []).length
  },
  resources: samples.length ? {
    samples: samples.length,
    server_rss_mib_max: Math.max(...samples.map((s) => s.server_rss_mib || 0)),
    bot_rss_mib_max: Math.max(...samples.map((s) => s.bot_rss_mib || 0)),
    system_free_mib_min: Math.min(...samples.map((s) => s.system_free_mib || 0)),
    last: samples[samples.length - 1]
  } : null,
  incidents: manifest.incidents || []
}

fs.writeFileSync(path.join(REPORTS, 'METRICS.json'), JSON.stringify(metrics, null, 2))
const md = [
  `## Metrics snapshot — ${metrics.generated_at}`,
  '',
  `- Stage: **${metrics.stage}**, elapsed **${metrics.elapsed_min} min**`,
  `- Tests: **${metrics.tests.passed} pass / ${metrics.tests.failed} fail / ${metrics.tests.skipped} skip / ${metrics.tests.interrupted} interrupted** (rate ${metrics.tests.pass_rate})`,
  `- Model: **${metrics.model.calls_total} calls**, in=${metrics.model.in_tokens} out=${metrics.model.out_tokens} cached=${metrics.model.cached_tokens} tokens; latency p50=${metrics.model.latency_ms.p50}ms p90=${metrics.model.latency_ms.p90}ms`,
  `- Bot log: ${metrics.bot.log_lines} lines, deaths=${metrics.bot.deaths}, flee episodes=${metrics.bot.flee_episodes}, errors=${metrics.bot.errors}`,
  `- Server TPS (recent): ${(metrics.server.recent_tps.join(' | ') || 'no tick lines yet')}`,
  `- Resources: server RSS max ${metrics.resources?.server_rss_mib_max} MiB, bot RSS max ${metrics.resources?.bot_rss_mib_max} MiB, free min ${metrics.resources?.system_free_mib_min} MiB`,
  ''
].join('\n')
if (process.argv[2] === 'snapshot') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  fs.writeFileSync(path.join(REPORTS, `METRICS_SNAPSHOT_${ts}.md`), md)
} else {
  const f = path.join(REPORTS, 'FINAL_REPORT.md')
  let base = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  fs.writeFileSync(f, base + '\n' + md)
}
console.log(`metrics written: ${modelCalls.length} model calls, ${samples.length} samples`)
console.log(`tests: ${metrics.tests.passed}/${metrics.tests.attempted} passed; latency p50=${metrics.model.latency_ms.p50}ms`)
