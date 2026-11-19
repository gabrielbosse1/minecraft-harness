'use strict'

const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { fold } = require('./memory_text')

/** Agent advice only. It never writes or supplies a system-role message. */
class LearnedRules {
  constructor ({ file, history, now = Date.now }) {
    this.file = file
    this.history = history
    this.now = now
    try { this.rows = JSON.parse(fs.readFileSync(file, 'utf8')).rows } catch { this.rows = [] }
    if (!Array.isArray(this.rows)) this.rows = []
  }

  _commit (rows) {
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, rows }))
      fs.renameSync(`${this.file}.tmp`, this.file)
      this.rows = rows
      return true
    } catch { return false }
  }

  edit ({ id = null, text, world, dimension, goal, evidence, confidence, expiresAt, retire = false }) {
    const old = id ? this.rows.find((r) => r.id === id) : null
    if (id && !old) return { ok: false, msg: 'unknown learned rule' }
    const { revisions = [], ...previous } = old || {}
    const at = this.now()
    const body = String(text ?? old?.text ?? '').trim().slice(0, 360)
    const scope = { world: world || old?.scope.world, dimension: dimension || old?.scope.dimension, goal: goal || old?.scope.goal }
    const refs = Array.isArray(evidence) && evidence.length ? [...new Set(evidence)] : (old?.evidence || [])
    const expiry = expiresAt ?? old?.expiresAt ?? null
    if (!retire) {
      if (!body || !scope.world || !scope.dimension || !scope.goal) return { ok: false, msg: 'rule requires text and an exact objective/world/dimension scope' }
      if (!refs.length || !refs.every((ref) => {
        const r = this.history.read(ref, { context: 0 }).records?.find((x) => x.current)
        return r?.cat === 'actions' && /^(action_ok|action_failed)$/.test(r.kind) &&
          r.where?.world === scope.world && r.where?.dim === scope.dimension && r.data?.goalId === scope.goal &&
          ['go_to', 'gather', 'mine_resource', 'craft', 'smelt', 'build', 'build_shape', 'sleep'].includes(r.data?.tool)
      })) return { ok: false, msg: 'link actual scoped execution evidence; chat, signs and memory edits cannot activate a rule' }
      if (this.rows.some((r) => r.id !== id && r.status === 'active' && fold(r.text) === fold(body) && JSON.stringify(r.scope) === JSON.stringify(scope))) return { ok: false, msg: 'that rule already exists in this scope' }
    }
    if (retire && !old) return { ok: false, msg: 'retirement requires a rule ID' }
    const row = { id: old?.id || randomUUID(), text: body, source: 'agent interpretation of tool evidence', scope,
      evidence: refs, confidence: Math.min(1, Math.max(0, confidence ?? old?.confidence ?? 0.5)),
      createdAt: old?.createdAt || at, reviewedAt: at, expiresAt: expiry,
      status: retire ? 'retired' : 'active', revisions: old ? [...revisions, previous] : [] }
    const rows = [...this.rows.filter((r) => r.id !== row.id), row]
    return this._commit(rows) ? { ok: true, msg: `${row.status} rule ${row.id}` } : { ok: false, msg: 'rule save failed' }
  }

  view (row) {
    return row.expiresAt !== null && row.expiresAt <= this.now() && row.status === 'active' ? { ...row, status: 'expired' } : row
  }

  applicable ({ world, dimension, goal }) {
    return this.rows.map((r) => this.view(r)).filter((r) => r.status === 'active' && world === r.scope.world && dimension === r.scope.dimension && goal === r.scope.goal)
      .sort((a, b) => b.confidence - a.confidence || b.reviewedAt - a.reviewedAt).slice(0, 2)
  }
}

module.exports = { LearnedRules }
