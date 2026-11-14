/**
 * armor.js — equips the best carried armor from inventory while preserving
 * slots explicitly dressed or emptied by the model.
 *
 * On pickup, inventory updates, container close, or spawn, compares worn slots
 * with carried inventory items and wears higher-protection armor. Non-armor
 * items worn intentionally (elytra, carved pumpkin, mob heads) are left untouched,
 * and items enchanted with Curse of Binding are never auto-equipped.
 */
'use strict'

const SLOT_OF_KIND = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet']
const SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }
/** Armor points per piece (the game's own numbers), then toughness per piece. */
const POINTS = {
  leather: { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },
  golden: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },
  copper: { helmet: 2, chestplate: 4, leggings: 3, boots: 1 },
  chainmail: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },
  iron: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },
  turtle: { helmet: 2 },
  diamond: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
  netherite: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 }
}
const TOUGHNESS = { diamond: 2, netherite: 3 }
/** Equal points: the sturdier material wins (durability order). */
const STURDY = ['golden', 'leather', 'copper', 'chainmail', 'iron', 'turtle', 'diamond', 'netherite']
const OFFHAND = ['shield', 'totem_of_undying'] // worst → best

/** { slot, material, kind } for a piece of armor, else null. */
function armorInfo (name) {
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(String(name || ''))
  if (!m || !POINTS[m[1]] || POINTS[m[1]][m[2]] === undefined) return null
  return { slot: SLOT_OF_KIND[m[2]], material: m[1], kind: m[2] }
}

/** Enchantment levels by name, whatever shape this version stores them in. Never throws. */
function enchantsOf (item) {
  const out = {}
  try {
    for (const e of item?.enchants || []) {
      const name = String(e?.name || '').replace(/^minecraft:/, '')
      if (name) out[name] = Number(e.lvl ?? e.level ?? 1) || 1
    }
  } catch { /* an item this prismarine-item cannot read: no enchantments known */ }
  return out
}

/** How much a piece protects: points first, then toughness, enchantment, sturdiness. 0 = not armor. */
function armorScore (item) {
  const info = armorInfo(item?.name)
  if (!info) return 0
  const ench = enchantsOf(item)
  // One level of Protection is worth about one armor point.
  const prot = (ench.protection || 0) + 0.5 * ((ench.fire_protection || 0) + (ench.blast_protection || 0) + (ench.projectile_protection || 0))
  return POINTS[info.material][info.kind] * 100 + (TOUGHNESS[info.material] || 0) * 30 + prot * 100 + STURDY.indexOf(info.material)
}

const isCursed = (item) => Boolean(enchantsOf(item).binding_curse)

class ArmorKeeper {
  /**
   * @param {object} bot
   * @param {{ prefs?: {auto:boolean, held:Set<string>}, equip?: Function, log?: Function,
   *           onWorn?: Function, delayMs?: number, retryMs?: number, setTimer?: Function, clearTimer?: Function }} [opts]
   *   prefs — the model's standing choice; pass the same object to the next
   *           session so a reconnect does not forget it.
   *   equip — `(item, dest) => Promise<{ok, why?}>`; lets the caller serialise
   *           the click with everything else that uses the hands.
   */
  constructor (bot, { prefs = null, equip = null, log = () => {}, onWorn = null, delayMs = 300, retryMs = 700, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.bot = bot
    this.prefs = prefs || { held: new Set() }
    if (!(this.prefs.held instanceof Set)) this.prefs.held = new Set(this.prefs.held || [])
    this._equip = equip || (async (item, dest) => { await bot.equip(item, dest); return { ok: true } })
    this.log = log
    this.onWorn = onWorn
    this.delayMs = delayMs
    this.retryMs = retryMs
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._timer = null
    this._running = false
    this._again = false
    this._retries = 0
    this._listeners = []
    this.stats = { worn: 0, checks: 0 }
  }

  // ---- wiring ----

  /** Start listening. Every handler only schedules a look; none reads the event. */
  attach () {
    if (this._listeners.length) return this
    const bot = this.bot
    const on = (emitter, event, fn) => {
      if (!emitter || typeof emitter.on !== 'function') return
      emitter.on(event, fn)
      this._listeners.push([emitter, event, fn])
    }
    // Picked something up. Whose pickup it was is all that is read — and a
    // wrong guess only costs one harmless look at the inventory.
    on(bot, 'playerCollect', (collector) => {
      let mine = true
      try { mine = !collector || collector === bot.entity || collector.username === bot.username || collector.id === bot.entity?.id } catch { mine = true }
      if (mine) this.poke()
    })
    // Armor that arrives any other way: a chest, a craft, a gift, a respawn kit.
    on(bot.inventory, 'updateSlot', () => this.poke())
    on(bot, 'windowClose', () => this.poke())
    on(bot, 'spawn', () => this.poke())
    return this
  }

  detach () {
    for (const [emitter, event, fn] of this._listeners) {
      try { (emitter.removeListener || emitter.off)?.call(emitter, event, fn) } catch { /* already gone */ }
    }
    this._listeners = []
    if (this._timer) this._clearTimer(this._timer)
    this._timer = null
  }

  poke (delay = this.delayMs) {
    if (this._timer) return
    this._timer = this._setTimer(() => {
      this._timer = null
      this.wearBest().catch(() => { /* wearBest reports its own failures */ })
    }, delay)
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()
  }

  // ---- what is worn / carried ----

  _slotIndex (dest) {
    try {
      const n = this.bot.getEquipmentDestSlot?.(dest)
      if (Number.isInteger(n)) return n
    } catch { /* fall through */ }
    return SLOT_INDEX[dest]
  }

  wornIn (dest) {
    return this.bot.inventory?.slots?.[this._slotIndex(dest)] || null
  }

  _carried () {
    try { return this.bot.inventory.items() } catch { return [] }
  }

  plan () {
    const out = []
    const carried = this._carried()
    for (const slot of ARMOR_SLOTS) {
      if (this.prefs.held.has(slot)) continue
      const worn = this.wornIn(slot)
      if (worn && !armorInfo(worn.name)) continue
      let best = null
      for (const item of carried) {
        const info = armorInfo(item.name)
        if (!info || info.slot !== slot || isCursed(item)) continue
        if (!best || armorScore(item) > armorScore(best)) best = item
      }
      if (best && armorScore(best) > armorScore(worn)) out.push({ slot, item: best, replaces: worn })
    }
    if (!this.prefs.held.has('off-hand')) {
      const worn = this.wornIn('off-hand')
      const rank = (item) => OFFHAND.indexOf(item?.name)
      if (!worn || rank(worn) >= 0) {
        let best = null
        for (const item of carried) if (rank(item) >= 0 && (!best || rank(item) > rank(best))) best = item
        if (best && rank(best) > rank(worn)) out.push({ slot: 'off-hand', item: best, replaces: worn })
      }
    }
    return out
  }

  async wearBest () {
    if (this._running) { this._again = true; return [] }
    const bot = this.bot
    this._running = true
    const done = []
    try {
      this.stats.checks++
      if (!bot.entity || Number(bot.health) <= 0) return done
      if (bot.currentWindow) return done
      let blocked = false
      for (const step of this.plan()) {
        let r
        try { r = await this._equip(step.item, step.slot) } catch (err) { r = { ok: false, why: String(err?.message || err) } }
        const now = this.wornIn(step.slot)
        if (r?.ok !== false && now && now.name === step.item.name) {
          this.stats.worn++
          const entry = { slot: step.slot, on: step.item.name, off: step.replaces?.name || null }
          done.push(entry)
          this.log('info', `armor: put on ${entry.on} (${entry.slot})${entry.off ? `, replacing ${entry.off}` : ''}`)
        } else {
          blocked = true
          this.log('debug', `armor: ${step.item.name} not put on (${r?.why || 'the slot did not change'})`)
        }
      }
      if (done.length) { try { this.onWorn?.(done) } catch { /* an observer must not break this */ } }
      if (blocked && this._retries < 4) { this._retries++; this.poke(this.retryMs) } else if (!blocked) this._retries = 0
      return done
    } catch (err) {
      this.log('debug', `armor check failed: ${err?.message || err}`)
      return done
    } finally {
      this._running = false
      if (this._again) { this._again = false; this.poke() }
    }
  }

  /** Preserve a slot explicitly equipped or unequipped by the model. */
  hold (slot) {
    if (ARMOR_SLOTS.includes(slot) || slot === 'off-hand') this.prefs.held.add(slot)
  }

  /** Release a held slot back to default armor management. */
  release (slot = null) {
    if (slot) this.prefs.held.delete(slot)
    else this.prefs.held.clear()
    this._retries = 0
    this.poke(0)
    return this.describe()
  }

  describe () {
    const held = [...this.prefs.held]
    return held.length
      ? `wearing best armor, preserving manual slot(s): ${held.join(', ')}`
      : 'wearing best carried armor'
  }

  brief () {
    const held = [...this.prefs.held]
    return held.length ? `armor: manual ${held.join('/')}` : ''
  }
}

module.exports = { ArmorKeeper, armorInfo, armorScore, enchantsOf, ARMOR_SLOTS, SLOT_INDEX }
