'use strict'

// Priorities are compatible with ControlArbiter's existing lane adapter.
const NAV_PRIORITY = Object.freeze({ opportunity: 0.5, objective: 1, override: 2, urgent: 2.5, safety: 3 })

function selectIntent (candidates) {
  let best = null
  for (const candidate of candidates) {
    if (!best || candidate.priority > best.priority) best = candidate
  }
  return best
}

/** Session-local registry. Modules receive scoped publishers, not the bot. */
class NavigationIntents {
  constructor ({ arbiter, now = Date.now, dimension = () => null, available = () => true, requestDecision = () => null, onResult = () => {}, logger = () => {} }) {
    this.arbiter = arbiter
    this.now = now
    this.dimension = dimension
    this.available = available
    this.requestDecision = requestDecision
    this.onResult = onResult
    this.log = logger
    this.modules = new Map()
    this.zones = new Map()
  }

  register ({ id, dependencies = [], modelAssisted = false, observe = null, onResult = null, ...metadata }, start = () => {}) {
    if (typeof id !== 'string' || !id || this.modules.has(id) || dependencies.some((dep) => !this.modules.has(dep))) throw new Error(`invalid or unresolved navigation module: ${id}`)
    const m = { id, dependencies: dependencies.slice(), modelAssisted, metadata, observe, onResult, lanes: new Set(), goals: new Map(), active: null }
    this.modules.set(id, m)
    const live = () => this.modules.get(id) === m
    const publishGoal = (goalId, spec) => {
      if (!live()) return false
      if (!goalId || typeof spec?.goal?.isEnd !== 'function') throw new TypeError('a goal ID and pathfinder goal are required')
      const tier = spec.tier || 'objective'
      const priority = Object.hasOwn(NAV_PRIORITY, tier) ? NAV_PRIORITY[tier] : null
      if (!priority || (priority >= NAV_PRIORITY.override && (!spec.reason || !Number.isFinite(spec.expiresAt)))) throw new TypeError('overrides require a reason and finite expiry')
      m.goals.set(goalId, { ...spec, id: goalId, priority, source: id, createdAt: this.now(), dim: spec.dim ?? this.dimension() })
      this.tick()
      return true
    }
    const zoneKey = (key) => JSON.stringify([id, key])
    const publishZone = (key, spec) => {
      if (!live()) return false
      if (!key || ![spec?.x, spec?.y, spec?.z, spec?.radius, spec?.expiresAt].every(Number.isFinite) || spec.radius <= 0) throw new TypeError('finite zone coordinates, radius and expiry required')
      this.zones.set(zoneKey(key), { ...spec, id: key, source: id, dim: spec.dim ?? this.dimension(), createdAt: this.now(), severity: Math.max(0, Math.min(60, Number(spec.severity) || 0)) })
      return true
    }
    const api = Object.freeze({
      publishGoal,
      publishOverride: (key, spec) => publishGoal(key, { ...spec, tier: spec.tier || 'override' }),
      publishDanger: publishZone,
      // Constraints are currently spatial: hard exclusion or soft clearance cost.
      publishConstraint: publishZone,
      withdrawGoal: (key) => { if (live()) this._retire(m, key, 'withdrawn') },
      withdrawZone: (key) => live() && this.zones.delete(zoneKey(key)),
      readState: () => this.snapshot(),
      requestDecision: (event) => live() && modelAssisted ? this.requestDecision({ ...event, source: id }) : null
    })
    m.api = api
    try { m.cleanup = start(api) } catch (err) { this.unregister(id); throw err }
    return api
  }

  _retire (m, key, state) {
    const goal = m.goals.get(key)
    if (!goal) return
    m.goals.delete(key)
    if (m.active?.id === key) { m.active.lane.release(state); m.active = null }
    const result = Object.freeze({ source: m.id, id: key, parentObjective: goal.parentObjective || null, state })
    try { this.onResult(result) } catch { /* observers must not hold controls */ }
    if (typeof m.onResult === 'function') queueMicrotask(() => {
      if (this.modules.get(m.id) !== m) return
      try { m.onResult(result, m.api) } catch (err) { this.log('warn', `navigation result observer ${m.id}: ${err.message}`) }
    })
  }

  unregister (id) {
    const m = this.modules.get(id)
    if (!m) return false
    this.modules.delete(id)
    for (const dependent of [...this.modules.values()]) if (dependent.dependencies.includes(id)) this.unregister(dependent.id)
    for (const key of m.goals.keys()) this._retire(m, key, 'disabled')
    for (const [key, zone] of this.zones) if (zone.source === id) this.zones.delete(key)
    for (const lane of m.lanes) this.arbiter.lanes.delete(lane.name)
    try { if (typeof m.cleanup === 'function') m.cleanup() } catch (err) { this.log('debug', `navigation cleanup ${id}: ${err.message}`) }
    return true
  }

  cancelGoals (reason = 'cancelled') {
    for (const m of this.modules.values()) for (const key of m.goals.keys()) this._retire(m, key, reason)
  }

  close () { for (const id of this.modules.keys()) this.unregister(id) }

  /** Pass an immutable observation frame; a failed contributor is withdrawn. */
  observe (frame) {
    for (const m of this.modules.values()) {
      try { m.observe?.(frame, m.api) } catch (err) {
        this.log('warn', `navigation observer ${m.id} disabled: ${err.message}`)
        this.unregister(m.id)
      }
    }
  }

  tick (position = null) {
    const now = this.now()
    const dim = this.dimension()
    for (const [key, zone] of this.zones) if (now >= zone.expiresAt) this.zones.delete(key)
    for (const m of this.modules.values()) {
      for (const [key, goal] of m.goals) {
        try {
          if (now >= (goal.expiresAt ?? Infinity)) this._retire(m, key, 'expired')
          else if (goal.dim !== dim || goal.valid?.() === false) this._retire(m, key, 'invalid')
          else if (position && m.active?.id === key && m.active.lane.isTop && (goal.complete ? goal.complete(position) : !goal.dynamic && goal.goal.isEnd(position))) this._retire(m, key, 'arrived')
        } catch { this._retire(m, key, 'invalid') }
      }
      const desired = this.available() ? selectIntent(m.goals.values()) : null
      if (!desired) { m.active?.lane.release('navigation unavailable'); m.active = null; continue }
      if (m.active?.intent === desired && m.active.lane.active) continue
      const previous = m.active
      // One adapter lane per source/tier; no new low-level driver.
      const lane = this.arbiter.lane(`intent:${m.id}:${desired.priority}`, desired.priority)
      m.lanes.add(lane)
      if (previous?.lane !== lane) previous?.lane.release('intent changed')
      lane.setGoal(desired.goal, desired.dynamic)
      lane.acquire({ reason: desired.reason || desired.id })
      m.active = { id: desired.id, intent: desired, lane }
    }
  }

  field () {
    const now = this.now()
    const dim = this.dimension()
    const zones = [...this.zones.values()].filter((z) => z.dim === dim && now < z.expiresAt)
    if (!zones.length) return null
    return (point, from = null) => {
      let cost = 0
      for (const zone of zones) {
        const distance = Math.hypot(point.x - zone.x, point.y - zone.y, point.z - zone.z)
        if (distance >= zone.radius) continue
        if (zone.hard) {
          const previousDistance = from ? Math.hypot(from.x - zone.x, from.y - zone.y, from.z - zone.z) : Infinity
          // A newly published region may already contain the avatar. Only
          // outwards steps are allowed inside it, so the field can't trap it.
          if (previousDistance >= zone.radius || distance <= previousDistance) return Infinity
        }
        cost += zone.severity * (1 - distance / zone.radius)
      }
      return Math.min(60, cost)
    }
  }

  objectiveTether () {
    const winner = this.arbiter.top()
    const active = [...this.modules.values()].find((m) => m.active?.lane === winner)?.active?.intent
    if (!active || active.priority >= NAV_PRIORITY.safety) return null
    const target = active.target?.position || active.target || active.goal.entity?.position || active.goal
    const position = [target?.x, target?.y, target?.z].every(Number.isFinite)
      ? { x: target.x, y: target.y, z: target.z } : null
    return { label: active.reason || active.id, position }
  }

  snapshot () {
    return {
      dimension: this.dimension(), owner: this.arbiter.owner(),
      locomotion: [...this.arbiter.lanes.values()].filter((lane) => lane.active).map(({ name, reason, priority, expiresAt, goal }) => ({ source: name, reason, priority, expiresAt, hasPathGoal: !!goal })),
      goals: [...this.modules.values()].flatMap((module) => [...module.goals.values()].map(({ id, source, priority, parentObjective, reason, createdAt, expiresAt }) => ({ id, source, priority, parentObjective, reason, createdAt, expiresAt }))),
      zones: [...this.zones.values()].map((z) => ({ ...z }))
    }
  }
}

module.exports = { NavigationIntents, NAV_PRIORITY, selectIntent }
