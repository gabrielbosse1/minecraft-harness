/**
 * dig_policy.js — what the body may break while it WALKS, and who decides.
 *
 * Before this there were two settings and nothing between them: a walk that
 * never broke anything (so one block of dirt or a snow layer was "no path"),
 * and the one-shot `dig` corridor the model had to ask for, walk by walk.
 *
 * The policy is the standing answer, and it belongs to the model:
 *
 *   can_dig   the master switch. Off = walking never breaks a block.
 *   mode      'list'  only the blocks on the list may be broken (the default)
 *             'all'   anything in the way may be broken, except what is never
 *                     broken (bedrock, doors, containers, portal frames…)
 *   list      the model's own, editable. It ships with the soft, common,
 *             cheap-to-replace terrain blocks — dirt, grass, sand, gravel,
 *             snow, leaves. Stone, ores, wood and anything crafted are NOT on
 *             it: breaking those is a decision, so it has to be made on purpose
 *             (add the block, or switch to mode 'all').
 *
 * Entries are block ids; a `*` is a wildcard (`*_leaves`). The policy is saved
 * next to the bot's other state, so the model's edits survive a restart.
 *
 * Pure apart from the optional JSON file. No mineflayer here: the pathfinder
 * wrapper turns the names into block ids against the live registry.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Soft, common, renewable terrain. Deliberately no stone, no ore, no wood. */
const DEFAULT_SOFT_BLOCKS = Object.freeze([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud', 'dirt_path',
  'sand', 'red_sand', 'gravel', 'clay',
  'snow', 'snow_block', 'powder_snow',
  '*_leaves', 'vine', 'moss_block', 'moss_carpet', 'cobweb',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'soul_sand', 'soul_soil'
])

/** Never breakable by walking, whatever the mode or the list says. */
const NEVER_DIG = Object.freeze(['bedrock', 'barrier', 'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw', 'end_portal_frame', 'end_portal', 'nether_portal', 'spawner', 'trial_spawner', 'vault', 'reinforced_deepslate'])

const MODES = Object.freeze(['list', 'all'])
const MAX_LIST = 96

const normName = (v) => String(v ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
const validPattern = (v) => /^[a-z0-9_*]{1,48}$/.test(v) && /[a-z0-9]/.test(v)

/** `*_leaves` → /^.*_leaves$/ */
function patternToRegExp (pattern) {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[^a-z0-9_]/g, '')).join('.*') + '$')
}

/** Expand names/wildcards against a registry. Unknown entries are returned separately. */
function resolveNames (patterns, registry) {
  const names = new Set()
  const unknown = []
  const all = registry?.blocksByName ? Object.keys(registry.blocksByName) : null
  for (const raw of patterns || []) {
    const p = normName(raw)
    if (!p) continue
    if (!all) { names.add(p); continue }
    if (p.includes('*')) {
      const re = patternToRegExp(p)
      const hits = all.filter((n) => re.test(n))
      if (hits.length) for (const n of hits) names.add(n)
      else unknown.push(p)
    } else if (registry.blocksByName[p]) names.add(p)
    else unknown.push(p)
  }
  return { names: [...names], unknown }
}

class DigPolicy {
  /**
   * @param {{ file?: string|null, enabled?: boolean, mode?: 'list'|'all', allow?: string[],
   *           logger?: (level:string, msg:string)=>void }} [opts]
   *   `enabled`/`mode`/`allow` are the SHIPPED defaults (config/defaults.json →
   *   behavior.digging); a saved file, when present, wins over them.
   */
  constructor ({ file = null, enabled = true, mode = 'list', allow = null, logger = () => {} } = {}) {
    this.file = file
    this.log = logger
    this.defaults = {
      enabled: enabled !== false,
      mode: MODES.includes(mode) ? mode : 'list',
      allow: (Array.isArray(allow) && allow.length ? allow : DEFAULT_SOFT_BLOCKS).map(normName).filter(validPattern)
    }
    this.enabled = this.defaults.enabled
    this.mode = this.defaults.mode
    this.allow = new Set(this.defaults.allow)
    /** Bumped on every change so the pathfinder can cache the resolved ids. */
    this.version = 1
    this.updatedAt = 0
    this._load()
  }

  _load () {
    if (!this.file) return
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (typeof raw.enabled === 'boolean') this.enabled = raw.enabled
      if (MODES.includes(raw.mode)) this.mode = raw.mode
      if (Array.isArray(raw.allow)) this.allow = new Set(raw.allow.map(normName).filter(validPattern).slice(0, MAX_LIST))
      this.updatedAt = Number(raw.updatedAt) || 0
    } catch (err) {
      this.log('warn', `dig policy file unreadable (${err.message || err}); using the shipped defaults`)
    }
  }

  save () {
    if (!this.file) return false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ enabled: this.enabled, mode: this.mode, allow: this.list(), updatedAt: this.updatedAt }, null, 2))
      fs.renameSync(tmp, this.file)
      return true
    } catch (err) {
      this.log('warn', `dig policy not saved: ${err.message || err}`)
      return false
    }
  }

  /** The list as the model wrote it (wildcards intact), sorted. */
  list () { return [...this.allow].sort() }

  /** Is `name` breakable by a walk right now? (For tests and reports; the pathfinder works on ids.) */
  allows (name) {
    const n = normName(name)
    if (!this.enabled || NEVER_DIG.includes(n)) return false
    if (this.mode === 'all') return true
    for (const p of this.allow) if (p === n || (p.includes('*') && patternToRegExp(p).test(n))) return true
    return false
  }

  /**
   * What the pathfinder needs: null when walking must not break anything,
   * otherwise `{ all: true }` or `{ all: false, names: [...] }` (wildcards
   * expanded against `registry`).
   */
  resolve (registry) {
    if (!this.enabled) return null
    if (this.mode === 'all') return { all: true, names: null, never: NEVER_DIG }
    return { all: false, names: resolveNames(this.list(), registry).names, never: NEVER_DIG }
  }

  /**
   * One edit by the model (the `dig_policy` tool). Every field is optional;
   * with none it just reports the current policy.
   * @param {{ can_dig?: boolean, mode?: string, add?: string[], remove?: string[], reset?: boolean }} change
   * @param {{ registry?: object }} [ctx] validates block names when given
   * @returns {{ ok: boolean, msg: string, changed: boolean }}
   */
  apply (change = {}, { registry = null } = {}) {
    const notes = []
    const problems = []
    let changed = false
    if (change.reset === true) {
      this.enabled = this.defaults.enabled
      this.mode = this.defaults.mode
      this.allow = new Set(this.defaults.allow)
      changed = true
      notes.push('reset to the shipped defaults')
    }
    if (typeof change.can_dig === 'boolean' && change.can_dig !== this.enabled) {
      this.enabled = change.can_dig
      changed = true
      notes.push(`can_dig ${this.enabled ? 'ON' : 'OFF'}`)
    }
    if (change.mode !== undefined && change.mode !== null && change.mode !== '') {
      const mode = normName(change.mode)
      if (!MODES.includes(mode)) problems.push(`mode must be "list" or "all" (got "${change.mode}")`)
      else if (mode !== this.mode) { this.mode = mode; changed = true; notes.push(`mode ${mode}`) }
    }
    const vet = (items) => {
      const good = []
      for (const raw of [].concat(items || [])) {
        const p = normName(raw)
        if (!validPattern(p)) { problems.push(`"${String(raw).slice(0, 30)}" is not a block id`); continue }
        if (NEVER_DIG.includes(p)) { problems.push(`${p} is never breakable`); continue }
        if (registry?.blocksByName) {
          const { names } = resolveNames([p], registry)
          if (!names.length) { problems.push(`unknown block "${p}"`); continue }
        }
        good.push(p)
      }
      return good
    }
    const added = []
    for (const p of vet(change.add)) {
      if (this.allow.has(p)) continue
      if (this.allow.size >= MAX_LIST) { problems.push(`the list is full (${MAX_LIST}); remove something or use mode "all"`); break }
      this.allow.add(p); added.push(p)
    }
    const removed = []
    for (const p of vet(change.remove)) if (this.allow.delete(p)) removed.push(p)
    if (added.length) { changed = true; notes.push(`added ${added.join(', ')}`) }
    if (removed.length) { changed = true; notes.push(`removed ${removed.join(', ')}`) }
    if (changed) {
      this.version++
      this.updatedAt = Date.now()
      this.save()
    }
    const head = notes.length ? `${notes.join('; ')}. ` : (problems.length ? '' : 'unchanged. ')
    const tail = problems.length ? ` — NOT applied: ${problems.join('; ')}` : ''
    return { ok: problems.length === 0 || changed, changed, msg: `${head}${this.describe({ full: true })}${tail}` }
  }

  /** One line for the prompt / the tool result. */
  describe ({ full = false, max = 14 } = {}) {
    if (!this.enabled) return 'walking never breaks blocks (can_dig OFF) — dig_policy {can_dig:true} turns it on; the dig tool still opens one corridor'
    if (this.mode === 'all') return 'walking may break ANY block in the way (mode all; doors, containers and bedrock are never broken) — dig_policy {mode:"list"} goes back to the list'
    const list = this.list()
    const shown = full ? list : list.slice(0, max)
    const more = list.length - shown.length
    return `walking may break only: ${shown.join(', ') || '(nothing)'}${more > 0 ? `, +${more} more` : ''} — not stone, ores, wood or anything crafted unless you add it (dig_policy {add:[…]}) or allow everything (dig_policy {mode:"all"})`
  }
}

module.exports = { DigPolicy, DEFAULT_SOFT_BLOCKS, NEVER_DIG, MODES, resolveNames, patternToRegExp }
