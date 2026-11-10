/**
 * reflex_registry.js — customizable System-1 reflex engine.
 *
 * No behavior is hardcoded: every reflex is a registered entry with a
 * trigger, an action, an optional cooldown, and (for run_script) a script.
 * Users and the LLM may extend it at runtime:
 *
 *   const { ReflexRegistry } = require('./reflex_registry')
 *   registry.register({ name: 'say_gm', trigger: 'player_gave_item', action: 'call_system2' })
 *   registry.register({ name: 'flee',   trigger: 'hostile_near', action: 'run_script', script: 'flee.js' })
 *
 * Triggers (event.type matched against):
 *   food_low · health_low · hostile_near · player_near · falling · in_water
 *   entity_hurt · item_gained · player_gave_item · chat · any (catch-all)
 * Optional event filters: { radius } on *_near triggers, { regex } on chat,
 * { item } on item_gained / player_gave_item.
 *
 * Actions:
 *   eat            — equip+consume best food
 *   drink_water    — use held water bucket (fall mitigation)
 *   back_jump      — 500ms back+jump pulse
 *   flee           — invert pathfinder goal away from the source entity
 *   jump           — single jump pulse
 *   say            — bot.chat(event.text or reflex.text)
 *   run_script     — execute zincai/scripts/<script> with { bot, ctx }
 *   call_system2   — escalate: ask the LLM what to do about this event
 *   engage_pvp     — hand the fight to System 1's PvP loop (mineflayer-pvp); LLM notified after
 */
'use strict'

const path = require('path')
const fs = require('fs')

const SCRIPTS_DIR = path.join(__dirname, 'scripts')

const VALID_TRIGGERS = new Set([
  'food_low', 'health_low', 'hostile_near', 'player_near', 'falling', 'in_water',
  'entity_hurt', 'item_gained', 'player_gave_item', 'chat', 'any'
])
const VALID_ACTIONS = new Set([
  'eat', 'drink_water', 'back_jump', 'flee', 'jump', 'say', 'run_script', 'call_system2', 'engage_pvp'
])

/** Load and execute a user script with the reflex context. Trusted local code. */
async function runScript (scriptName, event, ctx) {
  const safe = String(scriptName || '').replace(/[^a-z0-9_-]/gi, '').replace(/\.js$/, '')
  if (!safe) throw new Error('run_script: empty script name')
  const file = path.join(SCRIPTS_DIR, `${safe}.js`)
  if (!fs.existsSync(file)) throw new Error(`run_script: "${safe}" not found in zincai/scripts/`)
  // Fresh require each run so edits to the script are picked up live.
  delete require.cache[require.resolve(file)]
  const fn = require(file)
  if (typeof fn !== 'function') throw new Error(`scripts/${safe}.js must export a function`)
  return fn({ ...ctx, event, script: safe, log: ctx.logger })
}

class ReflexRegistry {
  constructor () {
    this.reflexes = []
    this._lastRun = new Map()
    this._nextId = 1
  }

  /**
   * Register a reflex. Returns its id. Throws on invalid specs — a typo in a
   * reflex file must not silently disable your bot's survival instincts.
   */
  register (spec) {
    const { name, trigger, action } = spec || {}
    if (!name || !VALID_TRIGGERS.has(trigger)) {
      throw new Error(`reflex "${name}": trigger must be one of ${[...VALID_TRIGGERS].join(', ')}`)
    }
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`reflex "${name}": action must be one of ${[...VALID_ACTIONS].join(', ')}`)
    }
    if (action === 'run_script' && !spec.script) throw new Error(`reflex "${name}": run_script requires script`)
    const reflex = {
      id: this._nextId++,
      name: String(name),
      trigger,
      action,
      script: spec.script,
      text: spec.text,
      radius: Number.isFinite(spec.radius) ? spec.radius : undefined,
      regex: spec.regex ? new RegExp(spec.regex, 'i') : undefined,
      item: spec.item,
      cooldownMs: Number.isFinite(spec.cooldownMs) ? spec.cooldownMs : 1000,
      enabled: spec.enabled !== false
    }
    this.reflexes.push(reflex)
    return reflex.id
  }

  unregister (nameOrId) {
    const before = this.reflexes.length
    this.reflexes = this.reflexes.filter((r) => r.name !== nameOrId && r.id !== nameOrId)
    return this.reflexes.length !== before
  }

  setEnabled (name, enabled) {
    const r = this.reflexes.find((x) => x.name === name)
    if (r) r.enabled = Boolean(enabled)
    return Boolean(r)
  }

  list () {
    return this.reflexes.map(({ name, trigger, action, script, cooldownMs, enabled }) => ({ name, trigger, action, script, cooldownMs, enabled }))
  }

  _matches (r, event) {
    if (!r.enabled) return false
    if (r.trigger !== 'any' && r.trigger !== event.type) return false
    if (r.radius !== undefined && event.distance !== undefined && event.distance > r.radius) return false
    if (r.regex && event.text && !r.regex.test(event.text)) return false
    if (r.item && event.item && r.item !== event.item) return false
    return true
  }

  /**
   * Evaluate an event against all reflexes, in registration order.
   * @param {{type:string, distance?:number, text?:string, item?:string, entity?:object}} event
   * @param {object} ctx  { bot, memory, goals, logger, combat, executor, pathfinder, escalate, system1 }
   */
  async evaluate (event, ctx) {
    const now = Date.now()
    const results = []
    for (const r of this.reflexes) {
      if (!this._matches(r, event)) continue
      const key = `${r.id}`
      const last = this._lastRun.get(key) || 0
      if (now - last < r.cooldownMs) continue
      this._lastRun.set(key, now)
      try {
        const outcome = await this._runAction(r, event, ctx)
        results.push({ name: r.name, outcome })
      } catch (err) {
        ctx.logger?.warn?.('reflex', `${r.name} failed: ${err.message || err}`)
        results.push({ name: r.name, outcome: 'error' })
      }
    }
    return results
  }

  async _runAction (r, event, ctx) {
    const { bot } = ctx
    switch (r.action) {
      case 'eat': return (ctx.system1?.eat?.(), 'eat')
      case 'drink_water': return (ctx.system1?.useWaterBucket?.(), 'drink_water')
      case 'back_jump': return (ctx.system1?.backJump?.(), 'back_jump')
      case 'flee': return ctx.pathfinder ? ctx.pathfinder._fleeTick?.() : 'no_pathfinder'
      case 'jump':
        bot?.setControlState?.('jump', true)
        setTimeout(() => { try { bot.setControlState('jump', false) } catch { /* gone */ } }, 250)
        return 'jump'
      case 'say': {
        const t = r.text || event.text || ''
        if (t && bot) {
          try { bot.chat(String(t).slice(0, 200)); return 'say' } catch { return 'say_failed' }
        }
        return 'say_empty'
      }
      case 'run_script': return runScript(r.script, event, ctx)
      case 'call_system2': return ctx.escalate ? ctx.escalate(event) : 'no_escalation_channel'
      case 'engage_pvp': return ctx.system1?.engageNearestPlayer?.(event) ?? 'pvp_unavailable'
      default: return 'unknown_action'
    }
  }
}

module.exports = { ReflexRegistry, runScript, SCRIPTS_DIR }
