/**
 * skills.js — what the model can ask the bot's body to do, by NAME.
 *
 * The old tool set took coordinates and inventory slot numbers the model was
 * never shown, and reported nothing back. Every skill here:
 *
 *   - takes names ("Gabriel", "home", "chest2", "bread"), never raw indices;
 *   - moves through the ControlArbiter's task lane, so a flee reflex can
 *     interrupt it and it resumes afterwards;
 *   - is cancellable (a new instruction or `stop` ends it);
 *   - resolves to { ok, msg } — one short sentence the model reads next turn.
 *
 * There is no "attack" here: fighting is combat.js, started only by the
 * model's explicit attack tool. There is no digging either.
 */
'use strict'

const { PRIORITY } = require('./control')
const { PlaceIndex, CONTAINER_KINDS } = require('./places')
const { whereIs } = require('./threats')
const { chooseFood, FOODS, HEALING } = require('./system1')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/**
 * Which of these item stacks does the model mean by `name`?
 *
 * The exact id, its plural, or its head noun ("sword" → iron_sword,
 * "planks" → oak_planks). Never the material: "diamond" used to match
 * diamond_pickaxe by substring, so "give Gabriel a diamond" handed over the
 * pickaxe when no loose diamonds were carried.
 */
function matchItem (items, name) {
  const q = fold(name).replace(/\s+/g, '_')
  if (!q) return null
  const singular = q.length > 3 && q.endsWith('s') ? q.slice(0, -1) : q
  return items.find((i) => i.name === q) ||
    items.find((i) => i.name === singular) ||
    items.find((i) => i.name.endsWith('_' + q) || i.name.endsWith('_' + singular)) ||
    null
}

/** Item names that merely contain the word — offered in the failure message, never used. */
function nearMisses (items, name) {
  const q = fold(name).replace(/\s+/g, '_')
  if (!q) return []
  return [...new Set(items.filter((i) => i.name.includes(q)).map((i) => i.name))].slice(0, 4)
}
const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra })
const fail = (msg, extra = {}) => ({ ok: false, msg, ...extra })

const FUELS = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20, lava_bucket: 100 }
const WOOD_FUEL = /(_planks|_log|_wood|_stem|_hyphae)$/ // 1.5 items each
const EQUIP_SLOTS = { hand: 'hand', mainhand: 'hand', main: 'hand', offhand: 'off-hand', 'off-hand': 'off-hand', off: 'off-hand', head: 'head', helmet: 'head', chest: 'torso', torso: 'torso', legs: 'legs', feet: 'feet', boots: 'feet' }

// --- gather allowlist (audit2 B4/C): what the body is ever allowed to dig --
const TOOL_TIERS = { golden: 0, wooden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 }
const TOOL_NAMES = ['wooden', 'stone', 'iron', 'diamond', 'netherite']
/** Minimum pickaxe tier per ore-family block (soils/logs need none: -1). */
const HARVEST_NEED = {
  coal_ore: 0, deepslate_coal_ore: 0,
  iron_ore: 1, deepslate_iron_ore: 1, copper_ore: 1, deepslate_copper_ore: 1, lapis_ore: 1, deepslate_lapis_ore: 1, nether_gold_ore: 0, nether_quartz_ore: 0,
  gold_ore: 2, deepslate_gold_ore: 2, diamond_ore: 2, deepslate_diamond_ore: 2, emerald_ore: 2, deepslate_emerald_ore: 2, redstone_ore: 2, deepslate_redstone_ore: 2,
  obsidian: 3, ancient_debris: 3
}
/** Loose blocks that need no pickaxe (shovel families + stone-family with any pick handled by tier 0). */
const GATHER_SOILS = new Set(['dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'snow_block', 'snow', 'mud', 'soul_sand', 'soul_soil', 'netherrack'])
const GATHER_STONE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'sandstone', 'blackstone'])
/** Friendly aliases the model (or a player) actually says → block ids. */
const GATHER_ALIASES = {
  wood: null, // resolved per-registry: any *_log present
  log: null,
  logs: null,
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  raw_gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  quartz: ['nether_quartz_ore'],
  snowball: ['snow']
}

/**
 * Which blocks may be dug for a requested resource name.
 * @returns {null | { names: string[], ids: number[] }} null = NOT allowed to dig for this.
 */
function resolveGatherTargets (registry, want) {
  if (!want || !registry?.blocksByName) return null
  const byName = registry.blocksByName
  let names = null
  if (GATHER_ALIASES[want] === null) { // log families
    names = Object.keys(byName).filter((n) => /_log$|_stem$/.test(n))
  } else if (Array.isArray(GATHER_ALIASES[want])) names = GATHER_ALIASES[want]
  else if (/^copper(_ore)?$/.test(want)) names = ['copper_ore', 'deepslate_copper_ore']
  else if (/_log$|_stem$|_hyphae$/.test(want) && byName[want]) names = [want]
  else if (/^([a-z]+)_wood$/.test(want)) names = [want.replace(/_wood$/, '_log')].filter((n) => byName[n])
  else if (GATHER_SOILS.has(want) || GATHER_STONE.has(want)) names = [want]
  else if (Object.prototype.hasOwnProperty.call(HARVEST_NEED, want)) names = [want]
  if (!names || !names.length) return null
  const ids = names.map((n) => byName[n]?.id).filter((id) => id !== undefined)
  if (!ids.length) return null
  return { names: names.filter((n) => byName[n]), ids }
}

class Skills {
  /**
   * @param {object} bot
   * @param {{ arbiter: object, places: PlaceIndex, logger?: (level:string,msg:string)=>void,
   *           whisper?: (player:string,text:string)=>boolean, moveTimeoutMs?: number,
   *           executor?: object|(()=>object), choreTimeoutMs?: number }} deps
   *   executor — BuilderExecutor (for shelter scaffolding); a thunk is fine to
   *   break the construction-order cycle.
   */
  constructor (bot, { arbiter, places, logger = () => {}, whisper = null, moveTimeoutMs = 60_000, executor = null, choreTimeoutMs = 240_000 } = {}) {
    this.bot = bot
    this.arbiter = arbiter
    this.lane = arbiter.lane('task', PRIORITY.task)
    this.places = places || new PlaceIndex()
    this.log = logger
    this.whisper = whisper
    this.moveTimeoutMs = moveTimeoutMs
    this._executor = typeof executor === 'function' ? executor : () => executor
    this.choreTimeoutMs = choreTimeoutMs
    this._token = null
    this._noPathAt = 0
    this._onPathUpdate = (result) => {
      if (this.lane.isTop && (result?.status === 'noPath')) this._noPathAt = Date.now()
    }
    try { bot.on?.('path_update', this._onPathUpdate) } catch { /* partial mock */ }
  }

  dispose () {
    this.cancel('shutdown')
    try { this.bot.removeListener?.('path_update', this._onPathUpdate) } catch { /* gone */ }
  }

  // ---------------------------------------------------------- lifecycle --

  /** What is running right now, for the prompt ("following Gabriel, 12 s"). */
  current () {
    const t = this._token
    if (!t) return null
    return { label: t.label, seconds: Math.round((Date.now() - t.startedAt) / 1000), paused: this.lane.active && !this.lane.isTop }
  }

  /** Stop whatever skill is running. Its promise resolves as cancelled. */
  cancel (reason = 'cancelled') {
    const t = this._token
    if (!t) return false
    t.cancelled = reason
    return true
  }

  /** Run one skill at a time; a new one cancels the previous. */
  async _run (label, fn) {
    if (this._token) this._token.cancelled = 'replaced'
    const token = { label, startedAt: Date.now(), cancelled: null }
    this._token = token
    try {
      return await fn(token)
    } catch (err) {
      return fail(`${label} failed: ${String(err?.message || err).slice(0, 100)}`)
    } finally {
      if (this._token === token) {
        this._token = null
        this.lane.release('task done')
      }
    }
  }

  // ------------------------------------------------------------ helpers --

  _goals () { return require('mineflayer-pathfinder').goals }
  _dim () { return PlaceIndex.dimensionOf(this.bot) }

  _playerEntity (name) {
    const q = fold(name)
    if (!q) return { name: null, entity: null }
    const players = this.bot.players || {}
    const key = Object.keys(players).find((p) => fold(p) === q) || Object.keys(players).find((p) => fold(p).startsWith(q))
    if (!key) return { name: null, entity: null }
    return { name: key, entity: players[key]?.entity || null }
  }

  _item (name) {
    return matchItem(this.bot.inventory.items(), name)
  }

  /** "I am not carrying any diamond (closest: diamond_pickaxe)". */
  _notCarrying (name) {
    const near = nearMisses(this.bot.inventory.items(), name)
    return `I am not carrying any ${name}${near.length ? ` (closest: ${near.join(', ')} — name it exactly if that is what you mean)` : ''}`
  }

  _countOf (name) {
    return this.bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  }

  /**
   * Walk to a goal through the task lane. Time spent preempted by a reflex
   * (fleeing) does not count against the timeout.
   * @returns {Promise<{ok:boolean, why:string, interrupted:boolean}>}
   */
  async _walk (token, goal, { dynamic = false, timeoutMs = this.moveTimeoutMs, done = null } = {}) {
    const bot = this.bot
    const lane = this.lane
    lane.acquire({ reason: token.label })
    lane.setGoal(goal, dynamic)
    this._noPathAt = 0
    let budget = timeoutMs
    let retried = false
    let interrupted = false
    let last = Date.now()
    try {
      for (;;) {
        await sleep(150)
        const now = Date.now()
        if (token.cancelled) return { ok: false, why: token.cancelled, interrupted }
        if (!bot.entity?.position) return { ok: false, why: 'no position', interrupted }
        if (!lane.isTop) { interrupted = true; last = now; continue } // a reflex is driving
        budget -= now - last
        last = now
        const here = bot.entity.position.floored()
        if (done ? done() : goal.isEnd(here)) return { ok: true, why: 'arrived', interrupted }
        if (this._noPathAt) {
          if (retried) return { ok: false, why: 'no path', interrupted }
          retried = true
          this._noPathAt = 0
          await sleep(1200) // threats move; one more try
          lane.setGoal(null)
          lane.setGoal(goal, dynamic)
        }
        if (budget <= 0) return { ok: false, why: 'timeout', interrupted }
      }
    } finally {
      // A replaced walk must not wipe the goal its replacement just set.
      if (this._token === token) {
        lane.setGoal(null)
        lane.clearControlStates()
      }
    }
  }

  /** Stand next to a block and face it. */
  async _approachBlock (token, pos) {
    const { GoalGetToBlock } = this._goals()
    const me = this.bot.entity.position
    if (Math.hypot(pos.x + 0.5 - me.x, pos.y + 0.5 - me.y - 1.6, pos.z + 0.5 - me.z) > 3.5) {
      const r = await this._walk(token, new GoalGetToBlock(pos.x, pos.y, pos.z))
      if (!r.ok) return r
    }
    try {
      const { Vec3 } = require('vec3')
      await this.bot.lookAt(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5), true)
    } catch { /* cosmetic */ }
    return { ok: true, why: 'arrived' }
  }

  _blockAt (entry) {
    const { Vec3 } = require('vec3')
    return this.bot.blockAt(new Vec3(entry.x, entry.y, entry.z))
  }

  /** Find the block a tool call means, refreshing the index first. */
  _resolveBlock (where, kinds) {
    const pos = this.bot.entity?.position
    if (!pos) return null
    try { this.places.scan(this.bot, { force: true }) } catch { /* mock */ }
    return this.places.resolve(where, pos, { dim: this._dim(), fallbackKinds: kinds })
  }

  // -------------------------------------------------------------- moving --

  /**
   * Walk to a player, a remembered place, an indexed block or coordinates.
   * @param {{ player?:string, place?:string, x?:number, y?:number, z?:number }} target
   */
  goTo (target = {}) {
    const bot = this.bot
    const { GoalNear, GoalNearXZ, GoalFollow } = this._goals()
    return this._run('go_to', async (token) => {
      if (target.player) {
        const { name, entity } = this._playerEntity(target.player)
        if (!name) return fail(`no player named "${target.player}" is online`)
        if (!entity) return fail(`${name} is online but too far away to see; ask for coordinates`)
        token.label = `going to ${name}`
        const r = await this._walk(token, new GoalFollow(entity, 2), { dynamic: true, done: () => entity.position && bot.entity.position.distanceTo(entity.position) <= 3.2 })
        return r.ok ? ok(`reached ${name}`) : fail(`could not reach ${name}: ${r.why}${r.interrupted ? ' (interrupted by fleeing)' : ''}`)
      }
      if (target.place) {
        const named = this.places.getPlace(target.place)
        const block = named ? null : this._resolveBlock(target.place, new Set(['chest', 'barrel', 'shulker', 'ender_chest', 'furnace', 'bed', 'crafting_table', 'enchanting_table', 'brewing_stand', 'anvil', 'station']))
        const dest = named || block
        if (!dest) return fail(`I know no place called "${target.place}"`)
        const label = named ? named.name : block.id
        token.label = `going to ${label}`
        const r = await this._walk(token, new GoalNear(dest.x, dest.y, dest.z, named ? 1 : 2))
        return r.ok ? ok(`arrived at ${label} (${dest.x},${dest.y},${dest.z})`) : fail(`could not reach ${label}: ${r.why}${r.interrupted ? ' (interrupted by fleeing)' : ''}`)
      }
      const x = Number(target.x); const y = Number(target.y); const z = Number(target.z)
      if (!Number.isFinite(x) || !Number.isFinite(z)) return fail('go_to needs a player, a place, or x and z')
      token.label = `going to ${Math.round(x)},${Number.isFinite(y) ? Math.round(y) : '~'},${Math.round(z)}`
      const goal = Number.isFinite(y) ? new GoalNear(x, y, z, 1) : new GoalNearXZ(x, z, 1)
      const r = await this._walk(token, goal)
      const p = bot.entity.position
      return r.ok
        ? ok(`arrived at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
        : fail(`did not arrive: ${r.why}${r.interrupted ? ' (interrupted by fleeing)' : ''}; now at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    })
  }

  /** Keep following a player until told otherwise (or `maxMs`). */
  follow ({ player, maxMs = 10 * 60_000 } = {}) {
    const bot = this.bot
    const { GoalFollow } = this._goals()
    return this._run('follow', async (token) => {
      const { name, entity } = this._playerEntity(player)
      if (!name) return fail(`no player named "${player}" is online`)
      if (!entity) return fail(`${name} is too far away to see`)
      token.label = `following ${name}`
      let lostAt = 0
      const r = await this._walk(token, new GoalFollow(entity, 2), {
        dynamic: true,
        timeoutMs: maxMs,
        done: () => {
          // Never "arrives"; ends when the player has been out of sight for 10 s.
          const visible = Boolean(bot.players?.[name]?.entity)
          if (visible) { lostAt = 0; return false }
          if (!lostAt) lostAt = Date.now()
          return Date.now() - lostAt > 10_000
        }
      })
      if (r.ok) return fail(`lost sight of ${name}; stopped following`)
      return ok(`stopped following ${name} (${r.why})`)
    })
  }

  // ---------------------------------------------------------- containers --

  async _open (token, entry) {
    const near = await this._approachBlock(token, entry)
    if (!near.ok) return { err: `could not reach ${entry.id}: ${near.why}` }
    const block = this._blockAt(entry)
    if (!block) return { err: `${entry.id} is not loaded` }
    try {
      const win = entry.kind === 'furnace' ? await this.bot.openFurnace(block) : await this.bot.openContainer(block)
      return { win }
    } catch (err) {
      return { err: `could not open ${entry.id}: ${String(err?.message || err).slice(0, 60)}` }
    }
  }

  _summarise (win) {
    const counts = {}
    for (const item of win.containerItems()) counts[item.name] = (counts[item.name] || 0) + item.count
    const size = Number.isFinite(win.inventoryStart) ? win.inventoryStart : null
    const free = size === null ? null : size - win.containerItems().length
    return { counts, free }
  }

  _remember (entry, win) {
    const { counts, free } = this._summarise(win)
    this.places.noteContents(entry, counts, { dim: this._dim(), freeSlots: free })
    return { counts, free }
  }

  /** Open a container and report what is inside. */
  lookIn ({ where = '' } = {}) {
    return this._run('look_in', async (token) => {
      const entry = this._resolveBlock(where, CONTAINER_KINDS)
      if (!entry) return fail(where ? `no container matching "${where}" nearby` : 'no container nearby')
      if (entry.kind === 'furnace') return this._furnaceReport(token, entry)
      token.label = `opening ${entry.id}`
      const { win, err } = await this._open(token, entry)
      if (err) return fail(err)
      try {
        const { counts, free } = this._remember(entry, win)
        const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} x${c}`)
        return ok(`${entry.id}${entry.label ? ` "${entry.label}"` : ''} at ${entry.x},${entry.y},${entry.z}: ${list.length ? list.slice(0, 18).join(', ') : 'empty'}${list.length > 18 ? `, +${list.length - 18} more kinds` : ''}${free !== null ? ` (${free} free slots)` : ''}`)
      } finally { try { win.close() } catch { /* already closed */ } }
    })
  }

  async _furnaceReport (token, entry) {
    token.label = `checking ${entry.id}`
    const { win, err } = await this._open(token, entry)
    if (err) return fail(err)
    try {
      const part = (label, item) => (item ? `${label} ${item.name} x${item.count}` : `${label} empty`)
      return ok(`${entry.id} at ${entry.x},${entry.y},${entry.z}: ${part('input', win.inputItem())}, ${part('fuel', win.fuelItem())}, ${part('output', win.outputItem())}`)
    } finally { try { win.close() } catch { /* already closed */ } }
  }

  /**
   * Take items out of a container (or the output of a furnace).
   *
   * Without `where` it goes to a container KNOWN to hold the item (opened
   * before), or one labelled like it. It never guesses: the old fallback
   * opened the nearest furnace and reported success with whatever was in its
   * output — "take diamond" returned "took iron_ingot x9 from furnace1".
   */
  take ({ item, count = null, where = '' } = {}) {
    return this._run('take', async (token) => {
      const want = fold(item).replace(/\s+/g, '_')
      if (!want) return fail('take needs an item name')
      const pos = this.bot.entity?.position
      const dim = this._dim()
      let entry = null
      if (String(where || '').trim()) {
        entry = this._resolveBlock(where, new Set([...CONTAINER_KINDS, 'furnace']))
        if (!entry) return fail(`no container matching "${where}" nearby`)
        if (!CONTAINER_KINDS.has(entry.kind) && entry.kind !== 'furnace') return fail(`${entry.id} is not a container`)
      } else if (pos) {
        try { this.places.scan(this.bot, { force: true }) } catch { /* mock */ }
        entry = this.places.findItem(want, pos, { dim })[0] || this.places.findLabel(want, pos, { dim }).find((e) => CONTAINER_KINDS.has(e.kind)) || null
        if (!entry) {
          const around = this.places.near(pos, { dim, radius: 32 })
          const unopened = around.filter((e) => CONTAINER_KINDS.has(e.kind) && !e.contents)
          const furnaces = around.filter((e) => e.kind === 'furnace').slice(0, 3).map((e) => e.id)
          const hint = []
          if (unopened.length) hint.push(`${unopened.length} container${unopened.length === 1 ? '' : 's'} here not opened yet (nearest: ${unopened.slice(0, 3).map((e) => `${e.id}${e.label ? ` "${e.label}"` : ''}`).join(', ')})`)
          if (furnaces.length) hint.push(`furnaces: ${furnaces.join(', ')}`)
          return fail(`I do not know where ${want} is: no opened container holds it and no label matches${hint.length ? ` — ${hint.join('; ')}` : ''}. Name a container in \`where\`, or look_in first. Nothing was taken.`)
        }
      }
      if (!entry) return fail('no container nearby')
      token.label = `taking ${want} from ${entry.id}`
      const { win, err } = await this._open(token, entry)
      if (err) return fail(err)
      try {
        if (entry.kind === 'furnace') {
          const out = win.outputItem()
          if (!out) return fail(`${entry.id} has nothing in its output yet`)
          if (!matchItem([out], want)) return fail(`${entry.id}'s output is ${out.name} x${out.count}, not ${want} — nothing was taken`)
          const got = await win.takeOutput()
          return ok(`took ${got?.name || out.name} x${got?.count || out.count} from ${entry.id}`)
        }
        const inside = win.containerItems()
        const first = matchItem(inside, want)
        if (!first) {
          const { counts } = this._remember(entry, win)
          const near = nearMisses(inside, want)
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n} x${c}`)
          return fail(`${entry.id}${entry.label ? ` "${entry.label}"` : ''} has no ${want}${near.length ? ` (closest: ${near.join(', ')})` : ''}; it holds ${top.length ? top.join(', ') : 'nothing'}`)
        }
        const name = first.name
        const have = inside.filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
        const n = Math.max(1, Math.min(have, Number.isFinite(Number(count)) && Number(count) > 0 ? Math.trunc(Number(count)) : have))
        await win.withdraw(first.type, null, n)
        this._remember(entry, win)
        return ok(`took ${name} x${n} from ${entry.id} (${have - n} left there)`)
      } finally { try { win.close() } catch { /* already closed */ } }
    })
  }

  /** Put items from the inventory into a container. */
  put ({ item, count = null, where = '' } = {}) {
    return this._run('put', async (token) => {
      const mine = this._item(item)
      if (!mine) return fail(this._notCarrying(item))
      const entry = this._resolveBlock(where, CONTAINER_KINDS)
      if (!entry) return fail(`no container${where ? ` matching "${where}"` : ''} nearby`)
      token.label = `putting ${mine.name} into ${entry.id}`
      const have = this._countOf(mine.name)
      const n = Math.max(1, Math.min(have, Number.isFinite(Number(count)) && Number(count) > 0 ? Math.trunc(Number(count)) : have))
      const { win, err } = await this._open(token, entry)
      if (err) return fail(err)
      try {
        await win.deposit(mine.type, null, n)
        this._remember(entry, win)
        return ok(`put ${mine.name} x${n} into ${entry.id}`)
      } finally { try { win.close() } catch { /* already closed */ } }
    })
  }

  /** Load a furnace and walk away; collect later with take. */
  smelt ({ item, count = null, where = '' } = {}) {
    return this._run('smelt', async (token) => {
      const mine = this._item(item)
      if (!mine) return fail(this._notCarrying(item))
      const entry = this._resolveBlock(where || 'furnace', new Set(['furnace']))
      if (!entry || entry.kind !== 'furnace') return fail('no furnace nearby')
      const have = this._countOf(mine.name)
      const n = Math.max(1, Math.min(have, Number.isFinite(Number(count)) && Number(count) > 0 ? Math.trunc(Number(count)) : have))
      token.label = `smelting ${mine.name} in ${entry.id}`
      const { win, err } = await this._open(token, entry)
      if (err) return fail(err)
      try {
        let fuelNote = ''
        if (!win.fuelItem()) {
          const fuel = this.bot.inventory.items().find((i) => i.name !== mine.name && (FUELS[i.name] || WOOD_FUEL.test(i.name)))
          if (!fuel) return fail(`no fuel: need coal, charcoal or wood to smelt in ${entry.id}`)
          const per = FUELS[fuel.name] || 1.5
          const need = Math.min(this._countOf(fuel.name), Math.ceil(n / per))
          await win.putFuel(fuel.type, null, need)
          fuelNote = ` with ${fuel.name} x${need}`
        }
        await win.putInput(mine.type, null, n)
        return ok(`smelting ${mine.name} x${n} in ${entry.id}${fuelNote}; ready in about ${n * 10}s — collect with take from ${entry.id}`)
      } finally { try { win.close() } catch { /* already closed */ } }
    })
  }

  // ------------------------------------------------------------- living --

  /** Sleep in the nearest bed. */
  sleep () {
    const bot = this.bot
    return this._run('sleep', async (token) => {
      if (bot.isSleeping) return ok('already in bed')
      const entry = this._resolveBlock('bed', new Set(['bed']))
      if (!entry || entry.kind !== 'bed') return fail('no bed nearby (none seen within 16 blocks)')
      token.label = `going to bed ${entry.id}`
      const near = await this._approachBlock(token, entry)
      if (!near.ok) return fail(`could not reach ${entry.id}: ${near.why}`)
      try {
        await bot.sleep(this._blockAt(entry))
        return ok(`sleeping in ${entry.id}`)
      } catch (err) {
        return fail(`cannot sleep: ${String(err?.message || err).slice(0, 80)}`)
      }
    })
  }

  /** Walk up to a player and toss them an item. */
  give ({ player, item, count = 1 } = {}) {
    const bot = this.bot
    const { GoalFollow } = this._goals()
    return this._run('give', async (token) => {
      const mine = this._item(item)
      if (!mine) return fail(this._notCarrying(item))
      const { name, entity } = this._playerEntity(player)
      if (!name) return fail(`no player named "${player}" is online`)
      if (!entity) return fail(`${name} is too far away to see`)
      token.label = `giving ${mine.name} to ${name}`
      const r = await this._walk(token, new GoalFollow(entity, 2), { dynamic: true, done: () => bot.entity.position.distanceTo(entity.position) <= 3 })
      if (!r.ok) return fail(`could not reach ${name}: ${r.why}`)
      const have = this._countOf(mine.name)
      const n = Math.max(1, Math.min(have, Math.trunc(Number(count)) || 1))
      try { await bot.lookAt(entity.position.offset(0, 1.2, 0), true) } catch { /* cosmetic */ }
      await bot.toss(mine.type, null, n)
      return ok(`tossed ${mine.name} x${n} to ${name}`)
    })
  }

  /** Eat now. Without a name the survival whitelist picks. Does not interrupt a task. */
  async eat ({ item = '' } = {}) {
    const bot = this.bot
    let food = null
    try {
      if (item) {
        food = this._item(item)
        if (!food) return fail(this._notCarrying(item))
        if (!FOODS[food.name] && HEALING[food.name] === undefined) return fail(`${food.name} is not food`)
      } else {
        food = chooseFood(bot.inventory.items(), { food: Number(bot.food ?? 20), health: Number(bot.health ?? 20), healing: true })
        if (!food) return fail(Number(bot.food) >= 20 ? 'not hungry' : 'nothing safe to eat in the inventory')
      }
      const r = await this.arbiter.useHand('eat', food, () => bot.consume(), { priority: PRIORITY.task, restore: true })
      return r.ok ? ok(`ate ${food.name}`) : fail(`could not eat ${food.name}: ${r.why}`)
    } catch (err) {
      return fail(`eat failed: ${String(err?.message || err).slice(0, 80)}`)
    }
  }

  /** Equip an item by name. */
  async equip ({ item, where = 'hand' } = {}) {
    const mine = this._item(item)
    if (!mine) return fail(this._notCarrying(item))
    const dest = EQUIP_SLOTS[fold(where)] || 'hand'
    try {
      await this.bot.equip(mine, dest)
      return ok(`equipped ${mine.name} (${dest})`)
    } catch (err) {
      return fail(`could not equip ${mine.name}: ${String(err?.message || err).slice(0, 60)}`)
    }
  }

  /** Right-click a nearby block by name: door, gate, lever, button, bell… */
  useBlock ({ what } = {}) {
    const bot = this.bot
    return this._run('use_block', async (token) => {
      const q = fold(what).replace(/\s+/g, '_')
      if (!q) return fail('use_block needs a block name')
      let positions = []
      try {
        const ids = bot.registry.blocksArray.filter((b) => b.name === q || b.name.includes(q)).map((b) => b.id)
        if (!ids.length) return fail(`unknown block "${what}"`)
        positions = bot.findBlocks({ matching: ids, maxDistance: 16, count: 8 })
      } catch (err) { return fail(`search failed: ${err.message || err}`) }
      if (!positions.length) return fail(`no ${q} within 16 blocks`)
      const p = positions[0]
      token.label = `using ${q}`
      const near = await this._approachBlock(token, p)
      if (!near.ok) return fail(`could not reach the ${q}: ${near.why}`)
      const block = bot.blockAt(p)
      await bot.activateBlock(block)
      return ok(`used ${block.name} at ${p.x},${p.y},${p.z}`)
    })
  }

  // ---------------------------------------------------------------- craft --

  /**
   * Craft with a reachable table (audit2 B3/E): craftItem finds a table up
   * to 8 m away but can only use it from ~4.5 m — walk there through the
   * task lane first, then craft. Runs as one skill so `stop` and the flee
   * reflex treat the whole thing as one job.
   */
  craft ({ item } = {}) {
    const { craftItem } = require('../src/recipes')
    return this._run('craft', async (token) => {
      const want = fold(item).replace(/\s+/g, '_')
      if (!want) return fail('craft needs an item id (e.g. "crafting_table")')
      token.label = `crafting ${want}`
      const r = await craftItem(this.bot, want, {
        approach: async (table) => {
          const pos = table.position
          const ap = await this._approachBlock(token, pos)
          return ap.ok ? { ok: true } : { ok: false, why: ap.why }
        }
      })
      if (r.ok) return ok(`crafted ${r.item} x${r.count}`)
      const why = String(r.why)
      const msg = why === 'missing_materials' ? `missing materials for ${want}`
        : why === 'need_crafting_table' ? `${want} needs a crafting table and none is within 8 blocks`
          : why === 'no_recipe' ? `no recipe for ${want}`
            : why === 'unknown_item' ? `unknown item "${want}"`
              : why.startsWith('table_unreachable') ? `the crafting table is out of reach (${why.split(':')[1]}) — put one down close or walk me there with go_to`
                : `craft ${want} failed: ${why}`
      return fail(msg)
    })
  }

  // ------------------------------------------------- resource chores -----
  // audit2 B4/C: deterministic acquisition. The model names WHAT; the body
  // digs only blocks that ARE the requested resource (never arbitrary cells),
  // from an explicit allowlist, and never touches anything player-built.

  /** Equip the best hand tool for a block family, if carried. Never throws. */
  async _equipToolFor (name) {
    try {
      const want = /(_log|_stem|_hyphae|planks)/.test(name) ? /_axe$/ : /(ore|stone|cobblestone|deepslate|obsidian|ancient_debris|andesite|diorite|granite|tuff|netherrack|sandstone)/.test(name) ? /_pickaxe$/ : /(dirt|sand|gravel|clay|snow|mud)/.test(name) ? /_shovel$/ : null
      if (!want) return false
      const items = this.bot.inventory.items().filter((i) => want.test(i.name))
      if (!items.length) return false
      const tier = (i) => TOOL_TIERS[i.name.split('_')[0]] ?? 0
      items.sort((a, b) => tier(b) - tier(a))
      if (this.bot.heldItem?.name === items[0].name) return true
      await this.bot.equip(items[0], 'hand')
      return true
    } catch { return false }
  }

  /**
   * Gather a raw resource by digging it: logs, ores, soils. The ONLY blocks
   * ever dug are blocks whose identity IS the requested resource (or the
   * whitelisted alias for it); if none is in `radius`, the answer is "walk
   * closer / go_to a place first", never free-form digging.
   */
  gather ({ item, count = 1, radius = 32 } = {}) {
    const bot = this.bot
    return this._run('gather', async (token) => {
      const want = fold(item).replace(/\s+/g, '_')
      const targets = resolveGatherTargets(bot.registry, want)
      if (!targets) return fail(`"${item || ''}" is not gatherable — name a raw resource block like oak_log, coal_ore, iron_ore, stone, sand, dirt. (Never dug: anything else, by rule.)`)
      token.label = `gathering ${want}`
      // Harvest-level honesty: an ore whose tier exceeds every pickaxe in the
      // inventory cannot be mined — say so BEFORE walking anywhere.
      const need = Math.max(...targets.names.map((n) => HARVEST_NEED[n] ?? -1))
      if (need >= 0) {
        const picks = bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name))
        const best = picks.reduce((m, p) => Math.max(m, TOOL_TIERS[p.name.split('_')[0]] ?? 0), -1)
        if (best < need) return fail(`need at least a ${TOOL_NAMES[need]} pickaxe in the inventory to mine ${targets.names[0]} (carrying: ${picks.map((p) => p.name).join(', ') || 'no pickaxe'})`)
      }
      const wanted = Math.max(1, Math.min(64, Math.trunc(Number(count)) || 1))
      let dug = 0
      let misses = 0
      const deadline = Date.now() + (this.choreTimeoutMs || 240_000)
      while (dug < wanted && misses < 4 && Date.now() < deadline) {
        if (token.cancelled) break
        let positions = []
        try { positions = bot.findBlocks({ matching: targets.ids, maxDistance: radius, count: 8 }) } catch (err) { return fail(`search failed: ${err.message || err}`) }
        if (!positions.length) return dug > 0 ? ok(`gathered ${want} x${dug} (no more within ${radius} blocks)`) : fail(`no ${targets.names.join(' or ')} within ${radius} blocks — go_to a place first, then gather again`)
        for (const p of positions) {
          if (dug >= wanted || token.cancelled || Date.now() >= deadline) break
          const near = await this._walk(token, new (this._goals().GoalGetToBlock)(p.x, p.y, p.z))
          if (!near.ok) { misses++; continue }
          const block = bot.blockAt(p)
          if (!block || !targets.names.includes(block.name)) continue // changed since the scan — never dig the wrong block
          if (!this.lane.isTop) { /* a reflex owns the body right now */ await sleep(400); continue }
          await this._equipToolFor(block.name)
          try {
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
          } catch { /* cosmetic */ }
          try {
            await bot.dig(block)
            dug++
            await sleep(450) // let the drop pop so the pickup delta lands
          } catch (err) {
            if (token.cancelled || !this.lane.isTop) break // interrupted by a reflex — handled by pause/resume
            misses++
            this.log('debug', `dig failed at ${p.x},${p.y},${p.z}: ${err.message || err}`)
          }
        }
      }
      if (dug > 0) return ok(`gathered ${want} x${dug}${dug < wanted ? ` (asked ${wanted}; the rest was not reachable here)` : ''}`)
      return fail(`could not gather ${want}: targets nearby were unreachable or kept breaking (try a smaller count or get closer first)`)
    })
  }

  /**
   * Place torches from the inventory on dark floors nearby. Dark = the
   * block's light is under 8 (or unknown: the synthetic rig reports none).
   * Never places on another torch, keeps 5 blocks between torches.
   */
  lightUp ({ radius = 8, max = 12 } = {}) {
    const bot = this.bot
    return this._run('light_up', async (token) => {
      const torch = this._item('torch')
      if (!torch) return fail('no torches in the inventory — craft or take torches first')
      let placed = 0
      const usedSpots = []
      const r = Math.max(2, Math.min(16, Math.trunc(Number(radius)) || 8))
      const cap = Math.max(1, Math.min(24, Math.trunc(Number(max)) || 12))
      const existing = new Set()
      try {
        const tid = bot.registry.blocksByName?.torch?.id
        if (tid !== undefined) for (const p of bot.findBlocks({ matching: tid, maxDistance: r * 2, count: 64 })) existing.add(`${p.x},${p.z}`)
      } catch { /* partial world */ }
      const me = bot.entity.position.floored()
      const spots = []
      for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          const x = me.x + dx; const z = me.z + dz
          if (Math.hypot(x + 0.5 - bot.entity.position.x, z + 0.5 - bot.entity.position.z) > r) continue
          for (let y = me.y + 2; y >= me.y - 5; y--) {
            const { Vec3 } = require('vec3')
            const floor = bot.blockAt(new Vec3(x, y, z))
            const above = bot.blockAt(new Vec3(x, y + 1, z))
            const above2 = bot.blockAt(new Vec3(x, y + 2, z))
            if (!floor || floor.boundingBox !== 'block' || !above || above.boundingBox !== 'empty' || !above2 || above2.boundingBox !== 'empty') continue
            if (/torch|lava|water|cactus|magma/.test(floor.name)) continue
            const light = typeof above.light === 'number' ? above.light : 0
            if (light >= 8) break // bright enough here; scan lower floors only below
            const key = `${x},${z}`
            if (existing.has(key)) break
            if (usedSpots.some((s) => Math.abs(s.x - x) + Math.abs(s.z - z) < 5)) break
            spots.push({ x, y, z })
            break
          }
        }
      }
      if (!spots.length) return ok('nothing dark to light here — no dark walkable floor in range')
      for (const s of spots) {
        if (placed >= cap || token.cancelled) break
        if (this._countOf('torch') <= 0) break
        const near = await this._walk(token, new (this._goals().GoalNear)(s.x, s.y, s.z, 3))
        if (!near.ok) continue
        if (!this.lane.isTop) { await sleep(400); continue }
        try {
          const { Vec3 } = require('vec3')
          const floor = bot.blockAt(new Vec3(s.x, s.y, s.z))
          if (!floor || floor.boundingBox !== 'block') continue
          const t = this._item('torch')
          if (!t) break
          await this.bot.equip(t, 'hand')
          await this.bot.placeBlock(floor, new Vec3(0, 1, 0))
          placed++
          usedSpots.push(s)
          await sleep(200)
        } catch { continue }
      }
      return placed > 0 ? ok(`placed ${placed} torch${placed === 1 ? '' : 'es'} (dark floors lit)`) : fail('found dark spots but could not place (reach or pathing) — get closer or clear the area first')
    })
  }

  /**
   * Emergency night cover WITH only owned blocks: pillar up 3 on scaffolding
   * the builder tracks, so `stop` (or a cancelled task) digs the same blocks
   * back down — nothing pre-existing is ever touched. Honest about limits:
   * melee cannot reach, arrows still can.
   */
  shelter () {
    const bot = this.bot
    return this._run('shelter', async (token) => {
      const exec = this._executor?.()
      if (!exec) return fail('no builder available for scaffolding')
      const carried = (exec.scaffoldBlocks || []).find((n) => this._countOf(n) >= 4)
      if (!carried) return fail(`no blocks to shelter with — need ~4 of ${(exec.scaffoldBlocks || ['dirt', 'cobblestone']).join('/')}`)
      token.label = 'sheltering on a pillar'
      const feet = bot.entity.position.floored()
      const done = await exec.pillarUpTo(feet.y + 3)
      if (!done) return fail('could not pillar up (blocked above?)')
      try {
        // Stay until cancelled/stopped, re-prioritizing survival implicitly
        // (this skill runs in the task lane; a flee reflex still preempts).
        while (!token.cancelled) await sleep(500)
        return ok('stayed on the shelter pillar until stopped')
      } finally {
        if (token.cancelled) {
          try { await exec.removeScaffolds() } catch { /* best effort descent */ }
        }
      }
    })
  }

  /** Walk back to where the bot died ("last death" place) and report what's left. */
  corpseRun () {
    const bot = this.bot
    return this._run('corpse_run', async (token) => {
      const pos = bot.entity?.position
      const entry = pos ? this.places.resolve('last death', pos, { dim: this._dim() }) : null
      if (!entry) return fail('no "last death" place is remembered (only deaths since this feature existed are recorded)')
      token.label = 'walking back to last death'
      const r = await this._walk(token, new (this._goals().GoalNear)(entry.x, entry.y, entry.z, 2), { timeoutMs: Math.max(this.moveTimeoutMs, 180_000) })
      if (!r.ok) return fail(`could not get back to ${entry.x},${entry.y},${entry.z}: ${r.why}`)
      // Item entities still lying around (they despawn after 5 minutes).
      let stacks = 0
      try {
        for (const e of Object.values(bot.entities || {})) {
          if (e === bot.entity || !e.position) continue
          if ((e.name === 'item' || e.objectType === 'Item') && e.position.distanceTo(bot.entity.position) <= 10) stacks++
        }
      } catch { /* cosmetic */ }
      return ok(`at the death spot${stacks ? `; ${stacks} item stack${stacks === 1 ? '' : 's'} still on the ground — standing on them picks them up` : '; nothing on the ground any more (items despawn after ~5 min)'}`)
    })
  }

  // -------------------------------------------------------------- memory --

  rememberHere ({ name, note = '', by = '' } = {}) {
    const pos = this.bot.entity?.position
    if (!pos) return fail('no position yet')
    const entry = this.places.remember(name, pos, { dim: this._dim(), note, by })
    return entry ? ok(`remembered "${entry.name}" at ${entry.x},${entry.y},${entry.z}`) : fail('remember_here needs a name')
  }

  /**
   * Where is something? A block type, an item (in the containers opened so
   * far), a chest label ("Diamantes"), a named place — or "storage" for the
   * list of every container around, in pages.
   */
  find ({ what, page = 1 } = {}) {
    const bot = this.bot
    const pos = bot.entity?.position
    const q = fold(what).replace(/\s+/g, '_')
    if (!pos || !q) return fail('find needs a name')
    const dim = this._dim()
    try { this.places.scan(bot, { force: true }) } catch { /* partial mock */ }
    if (/^(storage|chests?|containers?|labels?|baus?|estoque|armazem|all)$/.test(q)) {
      const list = this.places.listStorage(pos, { dim, page })
      if (!list.total) return fail('no containers indexed within 32 blocks')
      return ok(`storage: ${list.total} containers, page ${list.page}/${list.pages} (nearest first): ${list.lines.join('; ')}${list.page < list.pages ? ` — find {what:"storage", page:${list.page + 1}} continues` : ''}`)
    }
    const parts = []
    const stored = this.places.findItem(q, pos, { dim }).slice(0, 3)
    for (const e of stored) parts.push(`${e.id}${e.label ? ` "${e.label}"` : ''} (${whereIs(pos, e)}) holds ${e.hits.map(([n, c]) => `${n} x${c}`).join(', ')}`)
    const known = new Set(stored.map((e) => e.id))
    for (const e of this.places.findLabel(what, pos, { dim }).filter((e) => !known.has(e.id)).slice(0, 3)) {
      parts.push(`${e.id} is labelled "${e.label}" (${whereIs(pos, e)} at ${e.x},${e.y},${e.z}; ${e.contents ? 'opened before' : 'not opened yet — look_in to see what it holds'})`)
    }
    const carried = bot.inventory.items().filter((i) => i.name.includes(q))
    if (carried.length) parts.push(`carrying ${carried.map((i) => `${i.name} x${i.count}`).join(', ')}`)
    const indexed = this.places.near(pos, { dim, radius: 64 }).filter((e) => e.kind !== 'sign' && (e.kind === q || e.block === q)).slice(0, 2)
    for (const e of indexed) parts.push(`${e.id} at ${e.x},${e.y},${e.z} (${whereIs(pos, e)})`)
    if (!indexed.length) {
      try {
        const ids = bot.registry.blocksArray.filter((b) => b.name === q || b.name.includes(q)).map((b) => b.id)
        if (ids.length) {
          const found = bot.findBlocks({ matching: ids, maxDistance: 48, count: 3 })
          for (const p of found) parts.push(`${bot.blockAt(p)?.name || q} block at ${p.x},${p.y},${p.z} (${whereIs(pos, p)})`)
        }
      } catch { /* partial mock */ }
    }
    const place = this.places.getPlace(what)
    if (place) parts.push(`place "${place.name}" at ${place.x},${place.y},${place.z} (${whereIs(pos, place)})`)
    return parts.length ? ok(parts.join('; ')) : fail(`nothing known about "${what}" (no block within 48, no opened container holds it, no label matches)`)
  }
}

module.exports = { Skills, FUELS, matchItem, nearMisses, resolveGatherTargets, HARVEST_NEED, TOOL_TIERS }
