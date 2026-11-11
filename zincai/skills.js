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

class Skills {
  /**
   * @param {object} bot
   * @param {{ arbiter: object, places: PlaceIndex, logger?: (level:string,msg:string)=>void,
   *           whisper?: (player:string,text:string)=>boolean, moveTimeoutMs?: number }} deps
   */
  constructor (bot, { arbiter, places, logger = () => {}, whisper = null, moveTimeoutMs = 60_000 } = {}) {
    this.bot = bot
    this.arbiter = arbiter
    this.lane = arbiter.lane('task', PRIORITY.task)
    this.places = places || new PlaceIndex()
    this.log = logger
    this.whisper = whisper
    this.moveTimeoutMs = moveTimeoutMs
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

module.exports = { Skills, FUELS, matchItem, nearMisses }
