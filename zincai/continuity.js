'use strict'

/**
 * ContinuityStore — compact, versioned operational continuity, verified
 * ownership/home identity, emergent personal interests, and spatial/world-change
 * perception across arbitrary context resets and process restarts.
 *
 * Design rules:
 *  - Never stores conversation transcripts or raw world dumps.
 *  - World state is ALWAYS ground truth: checkpointed values are reconciled
 *    against live position, inventory, blocks, containers, and running skills.
 *  - Ownership and home identity are strictly evidence-based (`self_built`,
 *    `assigned`, `built_for_zinc`, `shared`, `player`, `unknown`) — never
 *    inferred merely from visiting a place or standing near a structure.
 *  - Action IDs (`act_<seq>`) track in-flight and completed-but-undelivered
 *    actions so arbitrary mid-turn context resets never repeat irreversible
 *    world actions.
 */

const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { visibleBlocks, detectStructures, clusterBlocks } = require('./perception')

const SCHEMA_VERSION = 1
const MAX_CONSTRUCTIONS = 24
const MAX_CLAIMS = 32
const MAX_INTERESTS = 6
const MAX_RECENT_ACTIONS = 8
const MAX_RECENT_CHANGES = 8
const MAX_PENDING_EVENTS = 8
const MAX_FRONTIER_CELLS = 192
const MAX_RELATIONSHIPS = 24

const REDSTONE_RE = /redstone|repeater|comparator|piston|observer|hopper|lever|button|pressure_plate|daylight_detector|target|dropper|dispenser|tripwire|sculk_sensor/
const ORE_RE = /_ore$|^ancient_debris$/
const CROP_RE = /wheat|carrots|potatoes|beetroots|melon|pumpkin|sugar_cane|sweet_berry_bush|cocoa|nether_wart|farmland/
const WATER_RE = /water|kelp|seagrass/
const PASSABLE_RE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|snow|carpet|.*_carpet|dandelion|poppy|torch|wall_torch)$/
const HAZARD_GROUND_RE = /lava|fire|magma|cactus|sweet_berry_bush|powder_snow|water/

function clean (s, max = 140) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function roundPos (p) {
  if (!p) return null
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

function dist2D (a, b) {
  if (!a || !b) return Infinity
  return Math.hypot((a.x || 0) - (b.x || 0), (a.z || 0) - (b.z || 0))
}

function dist3D (a, b) {
  if (!a || !b) return Infinity
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0))
}

/**
 * Parse explicit ownership cues from a sign or container label without
 * guessing. Ambiguous or decorative text returns `{ kind: 'unknown' }`.
 *
 * @param {string} rawText
 * @param {string} [botName='ZincAI']
 * @returns {{ kind: 'own'|'shared'|'player'|'unknown', owner: string|null, basis: string|null }}
 */
function classifySignOwnership (rawText, botName = 'ZincAI') {
  const raw = clean(rawText, 120)
  if (!raw) return { kind: 'unknown', owner: null, basis: null }
  const low = raw.toLowerCase()
  const botBase = String(botName || 'zinc').toLowerCase().replace(/ai$/, '') || 'zinc'
  const botFull = String(botName || 'zincai').toLowerCase()

  // Explicit assignment or ownership for Zinc.
  const ownRe = new RegExp(`\\b(casa\\s+d[eo]\\s+(?:${botBase}|${botFull})|ba[uú]\\s+d[eo]\\s+(?:${botBase}|${botFull})|para\\s+(?:${botBase}|${botFull})|for\\s+(?:${botBase}|${botFull})|(?:${botBase}|${botFull})'?s\\s+(?:house|home|chest|base|room|workshop)|lar\\s+d[eo]\\s+(?:${botBase}|${botFull}))\\b`, 'i')
  if (ownRe.test(raw)) {
    const builtFor = /\b(para|for)\b/i.test(raw)
    return { kind: 'own', owner: botName, basis: builtFor ? 'built_for_zinc' : 'assigned' }
  }

  // Explicit communal / shared markers.
  if (/\b(comunit[aá]ri[oa]|p[uú]blic[oa]|compartilhad[oa]|uso\s+livre|shared|public|community|free\s+to\s+use|common\s+chest|todos)\b/i.test(low)) {
    return { kind: 'shared', owner: null, basis: 'sign_shared' }
  }

  // Named player property in PT-BR or EN: "Casa do Steve", "Baú da Nadia", "Nadia's chest", "Propriedade de Ely", "Privado - Steve"
  const ptOwner = raw.match(/\b(?:casa|lar|base|torre|oficina|ba[uú]|estoque|propriedade|quarto|fazenda|mina)\s+d[eoa]s?\s+([A-Za-z0-9_]{2,20})\b/i)
  if (ptOwner) {
    const owner = ptOwner[1]
    if (!/^(todos|comunidade|comum|vila|aldeia|server|servidor)$/i.test(owner)) {
      if (owner.toLowerCase() === botBase || owner.toLowerCase() === botFull) {
        return { kind: 'own', owner: botName, basis: 'assigned' }
      }
      return { kind: 'player', owner, basis: 'sign_owner' }
    }
  }
  const enOwner = raw.match(/\b([A-Za-z0-9_]{2,20})'s\s+(?:house|home|base|chest|storage|vault|room|tower|farm|mine|workshop|build|stuff)\b/i)
  if (enOwner) {
    const owner = enOwner[1]
    if (owner.toLowerCase() === botBase || owner.toLowerCase() === botFull) {
      return { kind: 'own', owner: botName, basis: 'assigned' }
    }
    return { kind: 'player', owner, basis: 'sign_owner' }
  }
  const privNamed = raw.match(/\b(?:privad[oa]|private|n[aã]o\s+mexa|keep\s+out|only)\b[:\s-]*([A-Za-z0-9_]{2,20})?/i)
  if (privNamed && /\b(privad[oa]|private|n[aã]o\s+mexa|keep\s+out)\b/i.test(raw)) {
    const owner = privNamed[1] && !/^(chest|bau|baú|aqui|here|please|pfv)$/i.test(privNamed[1]) ? privNamed[1] : null
    return { kind: 'player', owner, basis: 'sign_private' }
  }
  return { kind: 'unknown', owner: null, basis: null }
}

class ContinuityStore {
  /**
   * @param {{ file: string, botName?: string, now?: () => number }} opts
   */
  constructor ({ file, botName = 'ZincAI', now = () => Date.now() } = {}) {
    this.file = file
    this.botName = botName
    this.now = now
    this.stateVersion = 0
    this.actionSeq = 0
    this.eventSeq = 0
    this.constructionSeq = 0
    this.resetCount = 0
    this.lastReset = null // { at, reason, reconciledSummary }
    this.identity = {
      home: null,
      constructions: [],
      claims: [],
      interests: [],
      relationships: {}
    }
    this.currentState = {
      activity: 'idle',
      activeGoalId: null,
      why: '',
      mode: 'explorer',
      location: null,
      immediateAction: null,
      interruptedAction: null
    }
    this.recentActions = []
    this.recentChanges = []
    this.pendingEvents = []
    this.frontier = {}
    this._lastSceneSummary = ''
    this._lastUnexplored = []
    this.load()
  }

  _bump () {
    this.stateVersion += 1
  }

  load () {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!d || typeof d !== 'object') return
      this.stateVersion = Number(d.stateVersion) || 0
      this.actionSeq = Number(d.actionSeq) || 0
      this.eventSeq = Number(d.eventSeq) || 0
      this.constructionSeq = Number(d.constructionSeq) || 0
      this.resetCount = Number(d.resetCount) || 0
      if (d.identity && typeof d.identity === 'object') {
        this.identity.home = d.identity.home || null
        this.identity.constructions = Array.isArray(d.identity.constructions) ? d.identity.constructions.slice(-MAX_CONSTRUCTIONS) : []
        this.identity.claims = Array.isArray(d.identity.claims) ? d.identity.claims.slice(-MAX_CLAIMS) : []
        this.identity.interests = Array.isArray(d.identity.interests) ? d.identity.interests.map((x) => clean(x, 60)).filter(Boolean).slice(0, MAX_INTERESTS) : []
        this.identity.relationships = (d.identity.relationships && typeof d.identity.relationships === 'object') ? d.identity.relationships : {}
      }
      if (d.currentState && typeof d.currentState === 'object') {
        this.currentState = {
          activity: d.currentState.activity || 'idle',
          activeGoalId: d.currentState.activeGoalId || null,
          why: clean(d.currentState.why, 120),
          location: d.currentState.location || null,
          immediateAction: null,
          interruptedAction: d.currentState.interruptedAction || null
        }
        // If the previous process crashed or reset mid-action, preserve it for
        // live-world reconciliation instead of silently losing or repeating it.
        if (d.currentState.immediateAction && d.currentState.immediateAction.status === 'running') {
          this.currentState.interruptedAction = {
            ...d.currentState.immediateAction,
            status: 'interrupted_by_restart',
            interruptedAt: this.now()
          }
        }
      }
      this.recentActions = Array.isArray(d.recentActions) ? d.recentActions.slice(-MAX_RECENT_ACTIONS) : []
      this.recentChanges = Array.isArray(d.recentChanges) ? d.recentChanges.slice(-MAX_RECENT_CHANGES) : []
      this.pendingEvents = Array.isArray(d.pendingEvents) ? d.pendingEvents.slice(-MAX_PENDING_EVENTS) : []
      this.frontier = (d.frontier && typeof d.frontier === 'object') ? d.frontier : {}
    } catch { /* corrupt checkpoint: start clean, live world remains truth */ }
  }

  save () {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      const payload = {
        v: SCHEMA_VERSION,
        stateVersion: this.stateVersion,
        savedAt: this.now(),
        actionSeq: this.actionSeq,
        eventSeq: this.eventSeq,
        constructionSeq: this.constructionSeq,
        resetCount: this.resetCount,
        identity: this.identity,
        currentState: this.currentState,
        recentActions: this.recentActions.slice(-MAX_RECENT_ACTIONS),
        recentChanges: this.recentChanges.slice(-MAX_RECENT_CHANGES),
        pendingEvents: this.pendingEvents.slice(-MAX_PENDING_EVENTS),
        frontier: this._trimmedFrontier()
      }
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
      fs.renameSync(tmp, this.file)
    } catch { /* best-effort persistence */ }
  }

  _trimmedFrontier () {
    const entries = Object.entries(this.frontier || {})
    if (entries.length <= MAX_FRONTIER_CELLS) return this.frontier
    entries.sort((a, b) => (b[1]?.lastAt || 0) - (a[1]?.lastAt || 0))
    const kept = Object.fromEntries(entries.slice(0, MAX_FRONTIER_CELLS))
    this.frontier = kept
    return kept
  }

  // --------------------------------------------------- action & event ledger ---

  beginAction ({ tool, summary, sig = '', goalId = null, args = null }) {
    this.actionSeq += 1
    const id = `act_${this.actionSeq}`
    this.currentState.immediateAction = {
      id,
      tool: String(tool || 'unknown'),
      summary: clean(summary || tool, 120),
      sig: clean(sig, 120),
      goalId: goalId || this.currentState.activeGoalId || null,
      args: args || null,
      startedAt: this.now(),
      status: 'running'
    }
    this._bump()
    this.save()
    return id
  }

  finishAction (id, { tool, summary, sig = '', ok, msg }) {
    const running = this.currentState.immediateAction
    const resolvedId = id || running?.id || `act_${++this.actionSeq}`
    const resolvedTool = tool || running?.tool || 'action'
    const resolvedSummary = clean(summary || running?.summary || resolvedTool, 120)
    const resolvedSig = clean(sig || running?.sig || '', 120)
    if (running && (!id || running.id === id)) {
      this.currentState.immediateAction = null
    }
    this.recentActions.push({
      id: resolvedId,
      tool: resolvedTool,
      summary: resolvedSummary,
      sig: resolvedSig,
      ok: Boolean(ok),
      msg: clean(msg, 180),
      at: this.now(),
      deliveredToModel: false
    })
    if (this.recentActions.length > MAX_RECENT_ACTIONS) {
      this.recentActions.splice(0, this.recentActions.length - MAX_RECENT_ACTIONS)
    }
    this._bump()
    this.save()
    return resolvedId
  }

  undeliveredActions () {
    return this.recentActions.filter((a) => !a.deliveredToModel)
  }

  markActionsDelivered (ids) {
    if (!Array.isArray(ids) || !ids.length) return
    const set = new Set(ids)
    let dirty = false
    for (const a of this.recentActions) {
      if (set.has(a.id) && !a.deliveredToModel) {
        a.deliveredToModel = true
        dirty = true
      }
    }
    if (this.currentState.interruptedAction && set.has(this.currentState.interruptedAction.id)) {
      this.currentState.interruptedAction = null
      dirty = true
    }
    if (dirty) {
      this._bump()
      this.save()
    }
  }

  addPendingEvent ({ kind, from = null, text }) {
    const cleanText = clean(text, 160)
    if (!cleanText) return null
    const dup = this.pendingEvents.find((e) => e.kind === kind && e.from === from && e.text === cleanText)
    if (dup) {
      dup.at = this.now()
      this._bump()
      this.save()
      return dup.id
    }
    this.eventSeq += 1
    const evt = { id: `evt_${this.eventSeq}`, kind: clean(kind, 32), from: from ? clean(from, 32) : null, text: cleanText, at: this.now() }
    this.pendingEvents.push(evt)
    if (this.pendingEvents.length > MAX_PENDING_EVENTS) {
      this.pendingEvents.splice(0, this.pendingEvents.length - MAX_PENDING_EVENTS)
    }
    this._bump()
    this.save()
    return evt.id
  }

  resolvePendingEvents (predicate) {
    const before = this.pendingEvents.length
    this.pendingEvents = this.pendingEvents.filter((e) => !predicate(e))
    if (this.pendingEvents.length !== before) {
      this._bump()
      this.save()
    }
  }

  recordChange (kind, text) {
    const cleanText = clean(text, 140)
    if (!cleanText) return false
    const now = this.now()
    const recentDup = this.recentChanges.find((c) => c.text === cleanText && (now - c.at) < 180_000)
    if (recentDup) return false
    this.recentChanges.push({ kind: clean(kind, 32), text: cleanText, at: now })
    if (this.recentChanges.length > MAX_RECENT_CHANGES) {
      this.recentChanges.splice(0, this.recentChanges.length - MAX_RECENT_CHANGES)
    }
    this._bump()
    this.save()
    return true
  }

  // ----------------------------------------- identity, home & ownership -----

  /**
   * Record a verified construction completed or progressed by Zinc.
   */
  recordConstruction ({ label, steps = [], dim = 'overworld', origin = 'self', askedBy = null }) {
    if (!Array.isArray(steps) || !steps.length) return null
    let minX = Infinity; let minY = Infinity; let minZ = Infinity
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
    for (const s of steps) {
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) continue
      if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x
      if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y
      if (s.z < minZ) minZ = s.z; if (s.z > maxZ) maxZ = s.z
    }
    if (!Number.isFinite(minX)) return null
    const cx = Math.round((minX + maxX) / 2)
    const cy = minY
    const cz = Math.round((minZ + maxZ) / 2)
    const sampleBlocks = steps.slice(0, 8).map((s) => ({ x: s.x, y: s.y, z: s.z, name: s.name }))
    const isSelf = !askedBy && (origin === 'self' || origin === 'self_generated')
    const existing = this.identity.constructions.find((c) => c.dim === dim && Math.abs(c.x - cx) <= 4 && Math.abs(c.z - cz) <= 4 && c.label === clean(label, 48))
    if (existing) {
      existing.minX = Math.min(existing.minX, minX); existing.maxX = Math.max(existing.maxX, maxX)
      existing.minY = Math.min(existing.minY, minY); existing.maxY = Math.max(existing.maxY, maxY)
      existing.minZ = Math.min(existing.minZ, minZ); existing.maxZ = Math.max(existing.maxZ, maxZ)
      existing.blockCount = Math.max(existing.blockCount || 0, steps.length)
      existing.sampleBlocks = sampleBlocks
      existing.builtAt = this.now()
      this._bump()
      this.save()
      return existing
    }
    this.constructionSeq += 1
    const rec = {
      id: `build_${this.constructionSeq}`,
      label: clean(label || 'structure', 48),
      x: cx,
      y: cy,
      z: cz,
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      blockCount: steps.length,
      sampleBlocks,
      dim,
      origin: isSelf ? 'self_built' : `built_for:${askedBy || origin}`,
      builtAt: this.now()
    }
    this.identity.constructions.push(rec)
    if (this.identity.constructions.length > MAX_CONSTRUCTIONS) {
      this.identity.constructions.splice(0, this.identity.constructions.length - MAX_CONSTRUCTIONS)
    }
    const radius = Math.max(4, Math.ceil(Math.hypot(maxX - minX, maxZ - minZ) / 2) + 2)
    if (isSelf) {
      this.recordClaim({ name: rec.label, pos: { x: cx, y: cy, z: cz }, radius, dim, kind: 'own', owner: this.botName, source: 'self_built' })
      if (!this.identity.home && /house|home|casa|abrigo|cabin|shelter|hut|cottage|base/i.test(rec.label) && steps.length >= 12) {
        this.setHome({ place: rec.label, pos: { x: cx, y: cy, z: cz }, dim, basis: 'self_built' })
      }
    } else if (askedBy) {
      this.recordClaim({ name: rec.label, pos: { x: cx, y: cy, z: cz }, radius, dim, kind: 'shared', owner: askedBy, note: `built with/for ${askedBy}`, source: 'commissioned_build' })
    }
    this._bump()
    this.save()
    return rec
  }

  recordClaim ({ name, pos, radius = 8, dim = 'overworld', kind = 'unknown', owner = null, note = '', source = 'observed' }) {
    const p = roundPos(pos)
    if (!p) return null
    const validKind = ['own', 'player', 'shared', 'unknown'].includes(kind) ? kind : 'unknown'
    const existing = this.identity.claims.find((c) => c.dim === dim && dist2D(c, p) <= Math.max(4, Math.min(c.radius || 8, radius)))
    if (existing) {
      // Never overwrite a verified player claim with an unverified own claim.
      if (existing.kind === 'player' && validKind === 'own' && source !== 'player_assigned') return existing
      existing.name = clean(name || existing.name, 40)
      existing.kind = validKind
      existing.owner = owner ? clean(owner, 32) : existing.owner
      if (note) existing.note = clean(note, 100)
      existing.radius = Math.max(existing.radius || 6, Math.min(24, radius))
      existing.source = source
      this._bump()
      this.save()
      return existing
    }
    const claim = {
      name: clean(name || 'site', 40),
      x: p.x,
      y: p.y,
      z: p.z,
      radius: Math.max(4, Math.min(24, Number(radius) || 8)),
      dim,
      kind: validKind,
      owner: owner ? clean(owner, 32) : null,
      note: clean(note, 100),
      source
    }
    this.identity.claims.push(claim)
    if (this.identity.claims.length > MAX_CLAIMS) {
      this.identity.claims.splice(0, this.identity.claims.length - MAX_CLAIMS)
    }
    this._bump()
    this.save()
    return claim
  }

  /**
   * Establish Zinc's home ONLY when backed by real evidence:
   *  - `self_built`: near a structure Zinc constructed itself,
   *  - `assigned` / `built_for_zinc`: explicitly assigned by a player or sign,
   * Never permits claiming a location already known to belong to another player.
   */
  setHome ({ place, pos, dim = 'overworld', basis = 'self_built', assignedBy = null }) {
    const p = roundPos(pos)
    if (!p) return { ok: false, reason: 'missing coordinates' }
    const conflicting = this.claimAt(p, dim)
    if (conflicting && conflicting.kind === 'player') {
      return { ok: false, reason: `cannot claim ${conflicting.owner || 'another player'}'s property (${conflicting.name}) as home` }
    }
    const selfBuiltNearby = this.identity.constructions.some((c) => c.dim === dim && c.origin === 'self_built' && dist2D(c, p) <= 16)
    const ownSignClaim = conflicting && conflicting.kind === 'own'
    const validBasis = (basis === 'assigned' || basis === 'built_for_zinc')
      ? basis
      : (selfBuiltNearby ? 'self_built' : (ownSignClaim ? 'assigned' : null))
    if (!validBasis) {
      return { ok: false, reason: 'home requires verified evidence (build your own shelter/house first, or have a player explicitly assign one)' }
    }
    this.identity.home = {
      place: clean(place || 'home', 40),
      x: p.x,
      y: p.y,
      z: p.z,
      dim,
      basis: validBasis,
      assignedBy: assignedBy ? clean(assignedBy, 32) : null,
      setAt: this.now()
    }
    this.recordClaim({ name: place || 'home', pos: p, radius: 10, dim, kind: 'own', owner: this.botName, source: validBasis })
    this._bump()
    this.save()
    return { ok: true, home: this.identity.home }
  }

  claimAt (pos, dim = 'overworld') {
    if (!pos) return null
    let best = null
    let bestD = Infinity
    for (const c of this.identity.claims) {
      if (c.dim && c.dim !== dim) continue
      const d = dist2D(c, pos)
      if (d <= (c.radius || 8) && d < bestD) {
        best = c
        bestD = d
      }
    }
    return best
  }

  /**
   * Check whether an autonomous modification/mining action at `pos` would
   * intrude on another player's property.
   */
  propertyGuardAt (pos, dim = 'overworld', { askedBy = null } = {}) {
    const claim = this.claimAt(pos, dim)
    if (!claim) return { ok: true, claim: null }
    if (claim.kind === 'own') return { ok: true, claim }
    if (claim.kind === 'player') {
      if (askedBy && claim.owner && askedBy.toLowerCase() === claim.owner.toLowerCase()) {
        return { ok: true, claim }
      }
      const who = claim.owner ? `${claim.owner}'s` : 'private player'
      return { ok: false, claim, reason: `protected ${who} property "${claim.name}" at (${claim.x},${claim.y},${claim.z})` }
    }
    return { ok: true, claim }
  }

  /**
   * Evaluate whether taking items from `entry` (`places` container) is allowed.
   * Reversible `look_in` is always permitted; autonomous `take` from a private
   * player container (by sign label or enclosing player house claim) is refused.
   */
  containerTakeGuard (entry, dim = 'overworld', { askedBy = null } = {}) {
    if (!entry) return { ok: true }
    const labelText = entry.label || entry.text || ''
    const labelCheck = classifySignOwnership(labelText, this.botName)
    if (labelCheck.kind === 'own' || labelCheck.kind === 'shared') return { ok: true, ownership: labelCheck.kind }
    if (labelCheck.kind === 'player') {
      if (askedBy && labelCheck.owner && askedBy.toLowerCase() === labelCheck.owner.toLowerCase()) {
        return { ok: true, ownership: 'player_authorized' }
      }
      const who = labelCheck.owner ? `${labelCheck.owner}'s` : 'a private'
      return { ok: false, ownership: 'private', reason: `${entry.id} is marked as ${who} private container ("${labelText}") — do not take items without permission` }
    }
    const ePos = entry.pos || entry
    const claim = this.claimAt(ePos, dim)
    if (claim && claim.kind === 'player') {
      if (askedBy && claim.owner && askedBy.toLowerCase() === claim.owner.toLowerCase()) {
        return { ok: true, ownership: 'player_authorized' }
      }
      const who = claim.owner ? `${claim.owner}'s` : 'another player\'s'
      return { ok: false, ownership: 'private', reason: `${entry.id} sits inside ${who} property "${claim.name}" — ask before taking items` }
    }
    return { ok: true, ownership: claim?.kind || 'unknown' }
  }

  /**
   * Evolve Zinc's emergent personal interests (never pre-populated; driven only
   * by Zinc's own experiences and choices). Prefix `-` removes an interest.
   */
  updateInterest (raw) {
    const s = clean(raw, 60)
    if (!s) return this.identity.interests
    if (s.startsWith('-')) {
      const target = s.slice(1).trim().toLowerCase()
      this.identity.interests = this.identity.interests.filter((x) => !x.toLowerCase().includes(target))
    } else {
      const filtered = this.identity.interests.filter((x) => x.toLowerCase() !== s.toLowerCase())
      this.identity.interests = [s, ...filtered].slice(0, MAX_INTERESTS)
    }
    this._bump()
    this.save()
    return this.identity.interests
  }

  _relKey (player) {
    const raw = clean(player, 32)
    if (!raw || raw.toLowerCase() === this.botName.toLowerCase()) return null
    const low = raw.toLowerCase()
    const existing = Object.keys(this.identity.relationships || {}).find((k) => k.toLowerCase() === low)
    return existing || raw
  }

  _ensureRelationship (player) {
    const key = this._relKey(player)
    if (!key) return null
    const now = this.now()
    let entry = this.identity.relationships[key]
    if (!entry) {
      entry = {
        name: clean(player, 32),
        metAt: now,
        lastSeenAt: now,
        updatedAt: now,
        sharedGoals: 0,
        interactions: 0,
        // Strictly model-driven — never auto-populated from permissions, creator config, attacks, or gifts.
        stance: null,
        trust: null,
        confidence: 0,
        willingness: null,
        summary: '',
        experiences: [],
        lastProposal: null
      }
      this.identity.relationships[key] = entry
      const keys = Object.keys(this.identity.relationships)
      if (keys.length > MAX_RELATIONSHIPS) {
        keys.sort((a, b) => (this.identity.relationships[b].lastSeenAt || 0) - (this.identity.relationships[a].lastSeenAt || 0))
        for (const drop of keys.slice(MAX_RELATIONSHIPS)) delete this.identity.relationships[drop]
      }
    } else {
      if (entry.stance === undefined) entry.stance = null
      if (entry.trust === undefined) entry.trust = null
      if (entry.confidence === undefined) entry.confidence = 0
      if (entry.willingness === undefined) entry.willingness = null
      if (entry.summary === undefined) entry.summary = ''
      if (!Array.isArray(entry.experiences)) entry.experiences = []
      if (entry.lastProposal === undefined) entry.lastProposal = null
    }
    return entry
  }

  _appendExperience (entry, kind, text) {
    const t = clean(text, 160)
    if (!entry || !t) return
    const now = this.now()
    const dup = entry.experiences.find((e) => e.kind === kind && e.text === t && (now - (e.at || 0)) < 30_000)
    if (dup) {
      dup.at = now
      return
    }
    entry.experiences.push({ at: now, kind, text: t })
    // Preserve foundational early experiences alongside recent ones so a single
    // interaction does not erase prior history.
    if (entry.experiences.length > 10) {
      entry.experiences = [
        ...entry.experiences.slice(0, 2),
        ...entry.experiences.slice(-8)
      ]
    }
  }

  touchPlayer (player, { sharedGoal = false, interacted = false } = {}) {
    const key = this._relKey(player)
    if (!key) return null
    const now = this.now()
    const hadPrev = Boolean(this.identity.relationships[key])
    const prevSeen = this.identity.relationships[key]?.lastSeenAt || 0
    const wasReturning = Boolean(hadPrev && (now - prevSeen) > 300_000)
    const entry = this._ensureRelationship(player)
    entry.lastSeenAt = now
    if (sharedGoal) entry.sharedGoals = (entry.sharedGoals || 0) + 1
    if (interacted) entry.interactions = (entry.interactions || 0) + 1
    return { isNew: !hadPrev, wasReturning, entry }
  }

  getRelationship (player) {
    const key = this._relKey(player)
    return key ? (this.identity.relationships[key] || null) : null
  }

  listRelationships () {
    return Object.values(this.identity.relationships || {})
      .sort((a, b) => (b.updatedAt || b.lastSeenAt || 0) - (a.updatedAt || a.lastSeenAt || 0))
  }

  /**
   * Record a raw, neutral in-world observation involving `player` (e.g. a hit or
   * nearby item drop) as factual context for the model WITHOUT automatically
   * assigning any relationship label, trust score, or enemy/friend status.
   */
  recordPlayerObservation (player, text, { kind = 'observed' } = {}) {
    const entry = this._ensureRelationship(player)
    if (!entry) return null
    entry.lastSeenAt = this.now()
    this._appendExperience(entry, kind, text)
    this._bump()
    this.save()
    return entry
  }

  /**
   * Model-authored update to how Zinc views and chooses to engage with `player`.
   */
  updateRelationship (player, { stance, trust, confidence, willingness, opinion, evidence, decision, proposalText } = {}) {
    const entry = this._ensureRelationship(player)
    if (!entry) return null
    const now = this.now()
    entry.updatedAt = now
    entry.lastSeenAt = now
    const hadAssessment = entry.stance !== null || entry.trust !== null
    if (stance !== undefined) {
      const s = clean(stance, 48)
      entry.stance = s || null
    }
    if (trust !== undefined && Number.isFinite(Number(trust))) {
      entry.trust = Math.max(-100, Math.min(100, Math.trunc(Number(trust))))
    }
    if (confidence !== undefined && Number.isFinite(Number(confidence))) {
      entry.confidence = Math.max(0, Math.min(100, Math.trunc(Number(confidence))))
    } else if (!hadAssessment && (entry.stance !== null || entry.trust !== null) && !entry.confidence) {
      // Keep early impressions tentative unless the model explicitly states higher confidence.
      entry.confidence = 30
    }
    if (willingness !== undefined) {
      entry.willingness = clean(willingness, 80) || null
    }
    if (opinion !== undefined) {
      entry.summary = clean(opinion, 180)
    }
    if (evidence) {
      this._appendExperience(entry, 'judgment', evidence)
    }
    if (decision) {
      const pText = clean(proposalText || entry.lastProposal?.text || 'request', 120)
      entry.lastProposal = {
        text: pText,
        at: now,
        decision: clean(decision, 24),
        explicit: true,
        note: clean(opinion || evidence || willingness || '', 120)
      }
      this._appendExperience(entry, 'proposal', `${decision}: "${pText}"`)
    }
    this._bump()
    this.save()
    return entry
  }

  /**
   * Record how Zinc disposed of a player's proposal without altering Zinc's
   * social stance/trust unless the model chose to update them via `social`.
   */
  recordProposalOutcome (player, proposalText, decision, note = '', { explicit = false } = {}) {
    const entry = this._ensureRelationship(player)
    if (!entry) return null
    const now = this.now()
    entry.lastSeenAt = now
    entry.lastProposal = {
      text: clean(proposalText || 'proposal', 120),
      at: now,
      decision: clean(decision || 'evaluated', 32),
      explicit: Boolean(explicit),
      note: clean(note, 120)
    }
    this._bump()
    this.save()
    return entry
  }

  formatRelationship (player) {
    const entry = this.getRelationship(player)
    const who = clean(player, 32)
    if (!entry) return `${who}: no prior relationship record (stance=unassessed; form your own view from evidence)`
    const bits = [
      `stance=${entry.stance || 'unassessed'}`,
      entry.trust !== null ? `trust=${entry.trust}/100` : 'trust=unset',
      entry.confidence ? `conf=${entry.confidence}%` : null,
      entry.willingness ? `engage="${entry.willingness}"` : null,
      `interactions=${entry.interactions || 0}`,
      entry.sharedGoals ? `sharedGoals=${entry.sharedGoals}` : null
    ].filter(Boolean)
    const head = `${entry.name || who}: ${bits.join(', ')}${entry.summary ? ` — ${entry.summary}` : ''}`
    const exp = (entry.experiences || []).slice(-5).map((e) => `[${e.kind}] ${e.text}`).join('; ')
    const prop = entry.lastProposal ? ` | last request "${entry.lastProposal.text}" -> ${entry.lastProposal.decision}` : ''
    return `${head}${prop}${exp ? ` | history: ${exp}` : ''}`
  }

  describeRelationshipsForPrompt (relevantPlayers = []) {
    const wanted = new Set(
      (relevantPlayers || [])
        .map((n) => clean(n, 32))
        .filter((n) => n && n.toLowerCase() !== this.botName.toLowerCase())
    )
    const chosen = []
    const seenKeys = new Set()
    for (const name of wanted) {
      const key = this._relKey(name)
      if (!key || seenKeys.has(key)) continue
      seenKeys.add(key)
      const entry = this.identity.relationships[key]
      if (entry) chosen.push(entry)
      else chosen.push({ name, stance: null, trust: null, confidence: 0, interactions: 0, experiences: [] })
    }
    if (chosen.length < 4) {
      for (const entry of this.listRelationships()) {
        const key = this._relKey(entry.name)
        if (!key || seenKeys.has(key)) continue
        if (entry.stance === null && entry.trust === null && !(entry.experiences || []).length) continue
        seenKeys.add(key)
        chosen.push(entry)
        if (chosen.length >= 4) break
      }
    }
    if (!chosen.length) return ''
    const rows = chosen.slice(0, 4).map((e) => {
      const stance = e.stance || 'unassessed'
      const trust = e.trust !== null && e.trust !== undefined ? `, trust=${e.trust} (conf ${e.confidence || 0}%)` : ''
      const will = e.willingness ? `, coop="${e.willingness}"` : ''
      const sum = e.summary ? ` — ${e.summary}` : ''
      const lastExp = (e.experiences || []).slice(-1)[0]
      const ev = lastExp ? ` [${lastExp.kind}: ${lastExp.text}]` : ''
      return `  - ${e.name}: stance=${stance}${trust}${will}${sum}${ev}`
    })
    return `relationships (your own revisable views; no player has automatic authority):\n${rows.join('\n')}`
  }

  // ------------------------------- compact world & frontier perception ------

  /**
   * Scan the immediate loaded surroundings for meaningful world features,
   * ownership signs, structural modifications, damaged self-builds, and
   * unexplored frontier directions without dumping raw block lists.
   */
  observeEnvironment (bot, places = null) {
    if (!bot?.entity?.position) return { summary: '', changes: [], unexplored: [] }
    const pos = bot.entity.position
    const dim = String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '')
    const p = roundPos(pos)
    const nearPlace = places ? this._nearestNamedPlace(places, p, dim) : null
    this.currentState.location = { ...p, dim, nearPlace }

    const newlyNoticed = []
    // 1. Inspect nearby scanned signs/containers for explicit ownership labels.
    const blockIter = places?.blocks instanceof Map
      ? places.blocks.values()
      : Object.values(places?.entries || {})
    for (const e of blockIter) {
      if (e.dim && e.dim !== dim) continue
      const text = e.label || e.text || ''
      const ePos = e.pos || e
      if (!text || dist2D(ePos, p) > 28) continue
      const parsed = classifySignOwnership(text, this.botName)
      if (parsed.kind === 'player') {
        this.recordClaim({ name: text, pos: ePos, radius: 9, dim, kind: 'player', owner: parsed.owner, note: text, source: 'sign' })
      } else if (parsed.kind === 'shared') {
        this.recordClaim({ name: text, pos: ePos, radius: 8, dim, kind: 'shared', note: text, source: 'sign' })
      } else if (parsed.kind === 'own') {
        this.recordClaim({ name: text, pos: ePos, radius: 9, dim, kind: 'own', owner: this.botName, note: text, source: 'sign' })
        if (!this.identity.home && /casa|home|house|lar|base/i.test(text)) {
          this.setHome({ place: text, pos: ePos, dim, basis: parsed.basis || 'assigned' })
        }
      }
    }

    // 2. Sample nearby visible blocks & classify structures / opportunities.
    const seen = visibleBlocks(bot, { range: 12, fovDegrees: 360, heightUp: 6, heightDown: 4 })
    const structures = detectStructures(seen)
    const clustered = clusterBlocks(seen)
    let redstoneCount = 0; let redstonePos = null
    let oreCount = 0; let oreName = null; let orePos = null
    let waterCount = 0; let waterPos = null
    let cropCount = 0
    let wallCount = 0; let wallPos = null
    let treeCount = 0
    let chestCount = 0
    for (const b of seen) {
      const n = b.name || ''
      const bp = { x: p.x + (b.dx || 0), y: p.y + (b.dy || 0), z: p.z + (b.dz || 0) }
      if (REDSTONE_RE.test(n)) { redstoneCount++; if (!redstonePos) redstonePos = bp }
      if (ORE_RE.test(n)) { oreCount++; if (!oreName) { oreName = n; orePos = bp } }
      if (WATER_RE.test(n)) { waterCount++; if (!waterPos) waterPos = bp }
      if (CROP_RE.test(n)) cropCount++
      if (/_log$|_stem$/.test(n)) treeCount++
      if (/planks|bricks|cobblestone|oak_log|spruce_log|stone_bricks|glass|door|stairs/.test(n)) {
        wallCount++
        if (!wallPos && /planks|bricks|glass|door|stairs/.test(n)) wallPos = bp
      }
      if (/chest|barrel|shulker_box/.test(n)) chestCount++
    }
    const structPos = wallPos || p

    // 3. Check nearby self-built constructions for damage / missing blocks.
    for (const c of this.identity.constructions) {
      if (c.dim !== dim || c.origin !== 'self_built' || dist2D(c, p) > 20) continue
      if (!Array.isArray(c.sampleBlocks) || !c.sampleBlocks.length) continue
      let missing = 0
      let checked = 0
      for (const sb of c.sampleBlocks) {
        const blk = bot.blockAt?.(new Vec3(sb.x, sb.y, sb.z))
        if (!blk) continue
        checked++
        if (blk.name === 'air' || blk.name === 'cave_air') missing++
      }
      if (checked >= 2 && missing > 0) {
        const msg = `${c.label} at (${c.x},${c.y},${c.z}) is missing ${missing}/${checked} sampled block(s)`
        if (this.recordChange('damaged_project', msg)) newlyNoticed.push(msg)
      }
    }

    // 4. Update 16x16 chunk frontier cell & detect environmental changes.
    const cx = Math.floor(p.x / 16)
    const cz = Math.floor(p.z / 16)
    const cellKey = `${dim}:${cx},${cz}`
    const now = this.now()
    const prevCell = this.frontier[cellKey]
    const tags = []
    for (const s of structures.slice(0, 2)) tags.push(s.kind)
    if (redstoneCount >= 2) tags.push('redstone')
    if (waterCount >= 6) tags.push('water')
    if (oreCount >= 1) tags.push(`ore:${oreName}`)
    if (cropCount >= 4) tags.push('crops')

    if (prevCell && (now - (prevCell.lastAt || 0)) > 20_000) {
      if (wallCount - (prevCell.walls || 0) >= 8) {
        const msg = `new construction activity near (${p.x},${p.y},${p.z})`
        if (this.recordChange('new_construction', msg)) newlyNoticed.push(msg)
      } else if ((prevCell.walls || 0) - wallCount >= 8) {
        const msg = `blocks removed/modified near (${p.x},${p.y},${p.z})`
        if (this.recordChange('modified_structure', msg)) newlyNoticed.push(msg)
      }
      if (chestCount > (prevCell.chests || 0)) {
        const msg = `new container spotted near (${p.x},${p.y},${p.z})`
        if (this.recordChange('new_container', msg)) newlyNoticed.push(msg)
      }
    } else if (!prevCell) {
      if (structures.length > 0) {
        const s = structures[0]
        const msg = `spotted ${s.kind} near (${structPos.x},${structPos.y},${structPos.z})`
        if (this.recordChange('discovered_structure', msg)) newlyNoticed.push(msg)
      }
      if (redstoneCount >= 2 && redstonePos) {
        const msg = `spotted redstone mechanism near (${redstonePos.x},${redstonePos.y},${redstonePos.z})`
        if (this.recordChange('discovered_redstone', msg)) newlyNoticed.push(msg)
      }
    }

    this.frontier[cellKey] = {
      visits: (prevCell?.visits || 0) + ((!prevCell || (now - (prevCell.lastAt || 0)) > 15_000) ? 1 : 0),
      firstAt: prevCell?.firstAt || now,
      lastAt: now,
      walls: wallCount,
      chests: chestCount,
      redstone: redstoneCount,
      crops: cropCount,
      tags: tags.slice(0, 4)
    }

    // 5. Build compact 1-line scene summary + unexplored adjacent directions.
    const features = []
    for (const s of structures.slice(0, 2)) {
      const claim = this.claimAt(structPos, dim)
      const ownerTag = claim ? (claim.kind === 'own' ? ' [yours]' : claim.kind === 'player' ? ` [${claim.owner || 'player'}'s]` : claim.kind === 'shared' ? ' [shared]' : ' [unknown owner]') : ''
      features.push(`${s.kind}@(${structPos.x},${structPos.y},${structPos.z})${ownerTag}`)
    }
    if (redstoneCount > 0 && redstonePos) features.push(`redstone(${redstoneCount})@(${redstonePos.x},${redstonePos.y},${redstonePos.z})`)
    if (waterCount >= 4 && waterPos) features.push(`water(${waterCount})@(${waterPos.x},${waterPos.y},${waterPos.z})`)
    if (oreCount > 0 && orePos) features.push(`${oreName}@(${orePos.x},${orePos.y},${orePos.z})`)
    if (cropCount >= 3) features.push(`crops(${cropCount})`)
    if (treeCount >= 2 && features.length < 5) features.push(`trees(${treeCount})`)
    if (p.y < 52) features.push(`underground(y=${p.y})`)

    const unexplored = this._computeUnexplored(bot, p, dim, cx, cz)
    this._lastSceneSummary = features.slice(0, 5).join(', ')
    this._lastUnexplored = unexplored
    return { summary: this._lastSceneSummary, changes: newlyNoticed, unexplored }
  }

  _computeUnexplored (bot, p, dim, cx, cz) {
    const dirs = [
      { label: 'N', dx: 0, dz: -1 },
      { label: 'E', dx: 1, dz: 0 },
      { label: 'S', dx: 0, dz: 1 },
      { label: 'W', dx: -1, dz: 0 }
    ]
    const out = []
    for (const d of dirs) {
      const key = `${dim}:${cx + d.dx},${cz + d.dz}`
      if (this.frontier[key]) continue
      const tx = p.x + d.dx * 18
      const tz = p.z + d.dz * 18
      const ty = this._probeSafeGroundY(bot, tx, p.y, tz)
      if (ty !== null) out.push(`${d.label} (${tx},${ty},${tz})`)
      else out.push(`${d.label} (~${tx},${p.y},${tz})`)
    }
    return out
  }

  _probeSafeGroundY (bot, x, refY, z) {
    if (!bot?.blockAt) return refY
    for (let dy = 4; dy >= -6; dy--) {
      const y = refY + dy
      const ground = bot.blockAt(new Vec3(x, y - 1, z))
      const feet = bot.blockAt(new Vec3(x, y, z))
      const head = bot.blockAt(new Vec3(x, y + 1, z))
      if (!ground || !feet || !head) return null
      if (!PASSABLE_RE.test(ground.name) && !HAZARD_GROUND_RE.test(ground.name) && PASSABLE_RE.test(feet.name) && PASSABLE_RE.test(head.name)) {
        return y
      }
    }
    return null
  }

  _nearestNamedPlace (places, p, dim) {
    let best = null
    let bestD = 20
    const iter = places?.named instanceof Map ? places.named.values() : Object.values(places?.named || {})
    for (const pl of iter) {
      if (pl.dim && pl.dim !== dim) continue
      const d = dist2D(pl, p)
      if (d <= bestD) { best = pl.name; bestD = d }
    }
    return best
  }

  // ----------------------------------------- arbitrary reset reconciliation ---

  /**
   * Reconcile persistent continuity state against LIVE world ground truth after
   * an arbitrary context reset or process restart.
   */
  reconcileWithWorld (bot, { goals = null, places = null, skills = null, building = false, combat = null, system1 = null, reason = 'context_reset' } = {}) {
    this.resetCount += 1
    const notes = []
    const livePos = bot?.entity?.position ? roundPos(bot.entity.position) : null
    const liveDim = String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '')
    const prevLoc = this.currentState.location

    if (livePos && prevLoc && (prevLoc.dim !== liveDim || dist3D(livePos, prevLoc) >= 6)) {
      notes.push(`world pos (${livePos.x},${livePos.y},${livePos.z} ${liveDim}) moved since checkpoint (${prevLoc.x},${prevLoc.y},${prevLoc.z})`)
    }
    if (livePos) {
      this.currentState.location = { ...livePos, dim: liveDim, nearPlace: places ? this._nearestNamedPlace(places, livePos, liveDim) : null }
    }

    // Reflect live controller reality rather than stale checkpoint assumptions.
    if (system1?.fleeing) {
      this.currentState.activity = 'fleeing'
      notes.push(`actively fleeing (${system1.reason || 'danger'})`)
    } else if (combat?.isEngaged) {
      this.currentState.activity = 'fighting'
      notes.push(`in active combat with ${combat.target?.name || 'hostile'}`)
    } else if (building) {
      this.currentState.activity = 'building'
      notes.push('build task currently active on body')
    } else if (skills?.current?.()) {
      this.currentState.activity = 'navigating'
      notes.push(`body currently running: ${skills.current()}`)
    } else if (['fleeing', 'fighting', 'building', 'navigating', 'gathering'].includes(this.currentState.activity)) {
      this.currentState.activity = 'idle'
    }

    // Check any action interrupted mid-flight by a crash/restart.
    const intr = this.currentState.interruptedAction
    if (intr) {
      notes.push(`action [${intr.id}] ${intr.summary} was in-flight before reset — verify world state before retrying`)
    }

    // Surface completed actions whose results had not yet been delivered to the model!
    for (const act of this.undeliveredActions()) {
      notes.push(`already completed before reset: [${act.id}] ${act.summary} -> ${act.ok ? 'OK' : 'FAILED'} (${act.msg}) — do NOT repeat`)
    }

    // Re-scan local environment so post-reset world modifications are caught immediately.
    if (bot?.entity?.position) {
      const env = this.observeEnvironment(bot, places)
      for (const ch of env.changes) notes.push(`world change: ${ch}`)
    }

    const openCount = goals ? goals.openGoals().length : 0
    if (!openCount) this.currentState.activeGoalId = null

    this.lastReset = {
      at: this.now(),
      reason: clean(reason, 60),
      reconciledSummary: notes.slice(0, 4).join('; ') || 'world state verified; ready'
    }
    this._bump()
    this.save()
    return { resetCount: this.resetCount, notes, summary: this.lastReset.reconciledSummary }
  }

  /**
   * Render a compact (~2–5 line) situational continuity + world-awareness block
   * for `buildActionPrompt`. Never includes conversation transcripts.
   */
  describeForPrompt (bot, { places = null, liveResultIds = null, relevantPlayers = [] } = {}) {
    const lines = []
    const dim = String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '')
    const pos = bot?.entity?.position ? roundPos(bot.entity.position) : null

    // 1. Identity: verified home, own builds, nearby property boundary, interests.
    const idParts = []
    if (this.identity.home) {
      const h = this.identity.home
      const d = (pos && h.dim === dim) ? ` ${Math.round(dist2D(pos, h))}m` : ''
      idParts.push(`home: ${h.place} (${h.x},${h.y},${h.z})${d} [${h.basis}]`)
    } else {
      idParts.push('home: none established yet')
    }
    if (this.identity.constructions.length) {
      const own = this.identity.constructions.filter((c) => c.origin === 'self_built').slice(-2)
      if (own.length) idParts.push(`your builds: ${own.map((c) => `${c.label}@(${c.x},${c.y},${c.z})`).join(', ')}`)
    }
    if (pos) {
      const nearClaim = this.claimAt(pos, dim)
      if (nearClaim && nearClaim.kind !== 'own') {
        const tag = nearClaim.kind === 'player' ? `${nearClaim.owner || 'player'}'s private property` : nearClaim.kind
        idParts.push(`here: "${nearClaim.name}" (${tag})`)
      }
    }
    if (this.identity.interests.length) {
      idParts.push(`interests: ${this.identity.interests.join(', ')}`)
    }
    lines.push(`identity: ${idParts.join(' | ')}`)

    // 1b. Persistent player relationships (model-driven, zero automatic authority).
    const relBlock = this.describeRelationshipsForPrompt(relevantPlayers)
    if (relBlock) lines.push(relBlock)

    // 2. Compact semantic environment + unexplored frontier.
    if (this._lastSceneSummary || this._lastUnexplored.length) {
      const parts = []
      if (this._lastSceneSummary) parts.push(`features: ${this._lastSceneSummary}`)
      if (this._lastUnexplored.length) parts.push(`unexplored: ${this._lastUnexplored.slice(0, 3).join(', ')}`)
      lines.push(`world: ${parts.join(' | ')}`)
    }

    // 3. Recent world deltas (only fresh ones within last 10m).
    const now = this.now()
    const freshChanges = this.recentChanges.filter((c) => (now - c.at) < 600_000).slice(-3)
    if (freshChanges.length) {
      lines.push(`world changes: ${freshChanges.map((c) => c.text).join('; ')}`)
    }

    // 4. Continuity across resets: undelivered tool results (not already in live `results`), interrupted actions, pending events.
    const shownSet = liveResultIds instanceof Set ? liveResultIds : new Set(liveResultIds || [])
    const undelivered = this.undeliveredActions().filter((a) => !shownSet.has(a.id))
    if (undelivered.length) {
      lines.push(`completed before reset (do NOT repeat): ${undelivered.map((a) => `[${a.id}] ${a.summary}: ${a.ok ? 'OK' : 'FAILED'} — ${a.msg}`).join(' | ')}`)
    }
    if (this.currentState.interruptedAction) {
      const ia = this.currentState.interruptedAction
      lines.push(`interrupted by restart: [${ia.id}] ${ia.summary} — check live world state before retrying`)
    }
    if (this.pendingEvents.length) {
      lines.push(`pending events: ${this.pendingEvents.slice(-3).map((e) => e.from ? `${e.from}: "${e.text}"` : e.text).join(' | ')}`)
    }
    if (this.lastReset && (now - this.lastReset.at) < 45_000) {
      lines.push(`continuity (reset #${this.resetCount} reconciled): ${this.lastReset.reconciledSummary}`)
    }

    return lines.join('\n')
  }
}

module.exports = {
  ContinuityStore,
  classifySignOwnership
}
