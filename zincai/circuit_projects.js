'use strict'
const fs = require('fs')
const path = require('path')
const { testLogic } = require('./logic_test')
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const MAX_BYTES = 1024 * 1024
const err = (msg) => ({ ok: false, msg })
const clean = (text) => String(text || '').replace(/[\r\n\t]+/g, ' ').slice(0, 240)

// Durable bounded investigation index. A captured location is an old
// observation, not a current physical graph or a proof of world behavior.
class CircuitProjects {
  constructor (file) {
    this.file = file
    this.projects = new Map()
    this.loadError = null
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > MAX_BYTES) throw new Error('file exceeds size limit')
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.projects) || data.projects.length > 16) throw new Error('invalid project file format')
        for (const p of data.projects) {
          const obs = p?.observation
          const validObs = !obs || (obs && typeof obs === 'object' && [obs.x, obs.y, obs.z, obs.radius, obs.ts, obs.components, obs.unloaded, obs.unreadable].every(Number.isSafeInteger) && obs.ts >= 0 && obs.ts <= 8640000000000000 && obs.radius >= 0 && obs.radius <= 2 && typeof obs.dimension === 'string' && /^[a-z0-9_:.-]{1,48}$/i.test(obs.dimension))
          const validTest = !p?.lastTest || (Number.isSafeInteger(p.lastTest.at) && p.lastTest.at >= 0 && p.lastTest.at <= 8640000000000000 && typeof p.lastTest.msg === 'string' && p.lastTest.msg.length <= 1500)
          if (!p || typeof p.name !== 'string' || !NAME.test(p.name) || this.projects.has(p.name) || !validObs || !validTest || (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 240)) || (p.spec && !testLogic(p.spec).ok)) throw new Error('invalid saved project')
          this.projects.set(p.name, p)
        }
      }
    } catch (e) { this.loadError = String(e.message || e); this.projects.clear() }
  }
  commit (project) {
    if (this.loadError) return err(`project store unavailable: ${this.loadError}`)
    if (!NAME.test(project.name)) return err('project name must be 1–32 letters, digits, underscores or hyphens')
    if (!this.projects.has(project.name) && this.projects.size >= 16) return err('project store is full (16 projects)')
    const next = new Map(this.projects); next.set(project.name, project)
    const data = JSON.stringify({ version: 1, projects: [...next.values()] }, null, 2)
    if (Buffer.byteLength(data) > MAX_BYTES) return err('project store exceeds 1 MiB limit')
    const temp = `${this.file}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(temp, data, { mode: 0o600 })
      fs.renameSync(temp, this.file)
      this.projects = next
      return { ok: true }
    } catch (e) {
      try { fs.unlinkSync(temp) } catch { /* no temporary file */ }
      return err(`project save failed: ${e.message || e}`)
    }
  }
  saveLogic (name, action, result) {
    if (typeof name !== 'string' || !NAME.test(name)) return err('project name must be 1–32 letters, digits, underscores or hyphens')
    const spec = {}
    for (const key of ['inputs', 'gates', 'outputs', 'tests', 'adder_width']) if (action[key] !== undefined) spec[key] = action[key]
    if (!testLogic(spec).ok) return err('invalid logical specification; project unchanged')
    const copy = JSON.parse(JSON.stringify(spec))
    const old = this.projects.get(name) || { name }
    const next = { ...old, spec: copy, lastTest: { at: Date.now(), msg: result.msg } }
    const written = this.commit(next)
    return written.ok ? { ok: true, msg: `saved abstract graph to project ${name}` } : written
  }
  act ({ operation: op, name, snapshot, note, page } = {}, inspector) {
    if (this.loadError) return err(`project store unavailable: ${this.loadError}`)
    if (!['list', 'show', 'graph', 'bind', 'test'].includes(op)) return err('project operation must be list, show, graph, bind or test')
    if (op === 'list') {
      if (name !== undefined || snapshot !== undefined || note !== undefined || page !== undefined) return err('list takes no project arguments')
      return { ok: true, msg: `Circuit projects: ${[...this.projects.keys()].join(', ') || 'none'}. Use show with a name; projects are not physical validation.` }
    }
    if (typeof name !== 'string' || !NAME.test(name)) return err('project name must be 1–32 letters, digits, underscores or hyphens')
    if (op === 'bind') {
      if (page !== undefined) return err('bind does not accept page')
      if (typeof snapshot !== 'string') return err('bind needs a redstone snapshot id')
      if (note !== undefined && (typeof note !== 'string' || note.length > 240)) return err('note must be text of at most 240 characters')
      const observed = inspector?.metadata(snapshot)
      if (!observed) return err('snapshot not found; capture it first')
      const old = this.projects.get(name) || { name }
      const written = this.commit({ ...old, observation: observed, ...(note === undefined ? {} : { note: clean(note) }) })
      return written.ok ? { ok: true, msg: `project ${name} saved historical region summary ${observed.dimension} ${observed.x},${observed.y},${observed.z}, radius ${observed.radius}. Snapshot is not live and graph details are not persisted.` } : written
    }
    if (snapshot !== undefined || note !== undefined || (op !== 'graph' && page !== undefined)) return err(`${op} does not accept those arguments`)
    const p = this.projects.get(name)
    if (!p) return err(`project ${name} not found`)
    if (op === 'graph') {
      if (!p.spec) return err('project has no abstract logic graph')
      const which = page === undefined ? 1 : page
      const pages = Math.max(1, Math.ceil(p.spec.gates.length / 2))
      if (!Number.isSafeInteger(which) || which < 1 || which > pages) return err(`graph page must be 1–${pages}`)
      const gates = p.spec.gates.slice((which - 1) * 2, which * 2).map((g) => `${g.id}=${g.op}(${g.inputs.join(',')})`).join('; ') || 'no gates'
      return { ok: true, msg: `Project ${name} ABSTRACT graph page ${which}/${pages}; inputs ${p.spec.inputs.join(',')}; outputs ${p.spec.outputs.join(',')}; ${gates}. Declared model only, not physical redstone.` }
    }
    if (op === 'test') {
      if (!p.spec) return err('project has no abstract logic specification; call logic_test with project name first')
      const result = testLogic(p.spec)
      if (!result.ok) return result
      const written = this.commit({ ...p, lastTest: { at: Date.now(), msg: result.msg } })
      if (!written.ok) return err(`test ran but could not save result: ${written.msg}; ${result.msg}`)
      return result
    }
    const loc = p.observation ? `observed region ${p.observation.dimension} ${p.observation.x},${p.observation.y},${p.observation.z} radius ${p.observation.radius}, captured ${new Date(p.observation.ts).toISOString()}, ${p.observation.components} components, ${p.observation.unloaded} unloaded; rescan for current state` : 'no saved region'
    const brief = (items) => items.slice(0, 4).join(',') + (items.length > 4 ? `,+${items.length - 4} more` : '')
    const spec = p.spec ? `abstract graph: inputs ${brief(p.spec.inputs)}; outputs ${brief(p.spec.outputs)}; ${p.spec.gates.length} gates` : 'no saved logic graph'
    return { ok: true, msg: `Project ${name}: ${loc}; ${spec}.${p.note ? ` Unverified hypothesis: ${clean(p.note)}.` : ''}${p.lastTest ? ` Last abstract test ${new Date(p.lastTest.at).toISOString()}: ${clean(p.lastTest.msg)}` : ''} Physical behavior is unverified.` }
  }
}
module.exports = { CircuitProjects }
