/**
 * threat_response.js — autonomous 3-mode threat-response decision engine.
 *
 * Replaces simplistic "flee from every visible hostile" behavior with fast,
 * deterministic, hysteresis-stabilized tactical mode selection:
 *
 *   NONE    — no actionable threats in range.
 *   AVOID   — maintain active objective while routing safely around threats
 *             using the dynamic elliptical threat-cost map (does NOT preempt
 *             active work into panic fleeing).
 *   ENGAGE  — fight manageable, auto-fight-eligible hostile mobs that are
 *             close or interfering with the active objective (never players,
 *             never creepers, never pets/villagers/named mobs).
 *   FLEE    — escape genuinely dangerous situations: critical health, imminent
 *             or close creepers, overwhelming numbers, boss/lethal mobs,
 *             unarmed & hurt against closing danger, or hostile player attack.
 *
 * Pure decision evaluation with stateful hysteresis, cooldowns, and post-flee
 * recovery assessment. No LLM calls, zero I/O.
 */
'use strict'

const tactics = require('./tactics')
const { isAutoFightCandidate, creeperFuseLit, creeperCharged, ZOMBIE_BUFFER } = require('./threats')

const MODES = Object.freeze({
  NONE: 'NONE',
  AVOID: 'AVOID',
  ENGAGE: 'ENGAGE',
  FLEE: 'FLEE'
})

const LETHAL_BOSSES = new Set([
  'warden', 'wither', 'ender_dragon', 'elder_guardian',
  'ravager', 'piglin_brute', 'evoker'
])

/**
 * Check if a threat entry represents a creeper and its critical danger state.
 */
function inspectCreeper (t) {
  if (!t || String(t.name || '').toLowerCase() !== 'creeper') return null
  const e = t.entity
  const lit = Boolean(t.lit || (e && creeperFuseLit(e)))
  const charged = Boolean(t.charged || (e && creeperCharged(e)))
  const dist = Number(t.distance ?? Infinity)
  const closing = Number(t.closing ?? 0)
  return { lit, charged, dist, closing }
}

/**
 * Evaluate post-flee recovery readiness (health, hunger, carried safe food).
 * @param {object} bot
 * @param {{ chooseFood?: Function }} [opts]
 */
function evaluateRecovery (bot, { chooseFood = null } = {}) {
  const hp = Number(bot?.health ?? 20)
  const food = Number.isFinite(Number(bot?.food)) ? Number(bot.food) : 20
  let items = []
  try { items = bot?.inventory?.items?.() || [] } catch { items = [] }
  const foodChoice = typeof chooseFood === 'function'
    ? chooseFood(items, { food, health: hp, healing: hp < 16 })
    : null
  const lowHp = hp < 14
  const lowFood = food < 16
  const criticalHp = hp <= 6
  const shouldEat = Boolean(foodChoice && (food < 18 || (hp < 16 && food < 20)))
  const needsFoodSupply = (lowFood || lowHp) && !foodChoice
  const canResumeObjective = !criticalHp && (!shouldEat || hp >= 10)
  return {
    hp: Math.round(hp * 10) / 10,
    food: Math.round(food * 10) / 10,
    lowHp,
    lowFood,
    criticalHp,
    shouldEat,
    foodItem: foodChoice?.name || null,
    needsFoodSupply,
    canResumeObjective
  }
}

class ThreatResponseEngine {
  /**
   * @param {object} [opts]
   */
  constructor ({
    now = () => Date.now(),
    criticalHealth = 6,
    lowHealth = 10,
    engageMinHp = 11,
    engageMinFood = 7,
    engageWinChance = 65,
    engageWinChanceTethered = 70,
    engageRadiusIdle = 7.5,
    engageRadiusObjective = 4.8,
    creeperLitRadius = 9.5,
    creeperChargedRadius = 10.5,
    creeperCriticalRadius = 6.5,
    creeperClosingRadius = 7.8,
    releaseRadius = 16,
    tetherReleaseRadius = 10.5,
    calmMs = 2600,
    tetherCalmMs = 1200,
    minFleeMs = 900,
    fleeCooldownMs = 4000,
    avoidDwellMs = 1200
  } = {}) {
    this.now = now
    this.criticalHealth = criticalHealth
    this.lowHealth = lowHealth
    this.engageMinHp = engageMinHp
    this.engageMinFood = engageMinFood
    this.engageWinChance = engageWinChance
    this.engageWinChanceTethered = engageWinChanceTethered
    this.engageRadiusIdle = engageRadiusIdle
    this.engageRadiusObjective = engageRadiusObjective
    this.creeperLitRadius = creeperLitRadius
    this.creeperChargedRadius = creeperChargedRadius
    this.creeperCriticalRadius = creeperCriticalRadius
    this.creeperClosingRadius = creeperClosingRadius
    this.releaseRadius = releaseRadius
    this.tetherReleaseRadius = tetherReleaseRadius
    this.calmMs = calmMs
    this.tetherCalmMs = tetherCalmMs
    this.minFleeMs = minFleeMs
    this.fleeCooldownMs = fleeCooldownMs
    this.avoidDwellMs = avoidDwellMs

    this.mode = MODES.NONE
    this.modeSince = 0
    this.fleeEnteredAt = 0
    this.fleeCalmSince = 0
    this.fleeCooldownUntil = 0
    this.avoidUntil = 0
    this.lastReason = ''
    this.lastDecision = null
  }

  reset () {
    this.mode = MODES.NONE
    this.modeSince = this.now()
    this.fleeEnteredAt = 0
    this.fleeCalmSince = 0
    this.fleeCooldownUntil = 0
    this.avoidUntil = 0
    this.lastReason = ''
    this.lastDecision = null
  }

  /**
   * Manually interrupt flee (e.g. model issued `attack`, `hold`, or `stop`).
   */
  interruptFlee (reason = 'interrupted') {
    if (this.mode !== MODES.FLEE) return false
    const t = this.now()
    const durationMs = this.fleeEnteredAt ? Math.max(0, t - this.fleeEnteredAt) : 0
    this.mode = MODES.NONE
    this.modeSince = t
    this.fleeEnteredAt = 0
    this.fleeCalmSince = 0
    this.fleeCooldownUntil = t + this.fleeCooldownMs
    this.lastReason = reason
    return { interrupted: true, durationMs, reason }
  }

  /**
   * Decide the threat-response mode for the current tick.
   *
   * @param {object} bot
   * @param {Array<object>} threats live threat entries (already filtered by ThreatSense; peaceful players excluded)
   * @param {{
   *   hasObjective?: boolean,
   *   tether?: object|null,
   *   suppressedIds?: Set<number>|null,
   *   autoFightSuppressed?: (entity:object)=>boolean,
   *   combatAvailable?: boolean,
   *   combatCooldown?: boolean,
   *   chooseFood?: Function|null,
   *   canRun?: Function|null
   * }} [ctx]
   */
  evaluate (bot, threats, ctx = {}) {
    const t = this.now()
    const prevMode = this.mode
    const hasObjective = Boolean(ctx.hasObjective || ctx.tether)
    // Filter out anything peaceful or invalid (defensive check: non-attacking players are never threats)
    const active = (threats || []).filter((x) => {
      if (!x || !x.entity?.position) return false
      if (x.kind === 'player' && !x.attacker) return false
      return true
    })

    if (!active.length) {
      // No threats present right now.
      if (prevMode === MODES.FLEE) {
        if (!this.fleeCalmSince) this.fleeCalmSince = t
        const calmNeed = hasObjective ? Math.min(this.tetherCalmMs, 800) : Math.min(this.calmMs, 1200)
        const minOk = t - this.fleeEnteredAt >= this.minFleeMs
        if (minOk && t - this.fleeCalmSince >= calmNeed) {
          return this._finishFlee(bot, ctx, 'all threats cleared', MODES.NONE)
        }
        return this._keep(MODES.FLEE, 'confirming threat clearance', { active, situation: null })
      }
      if (prevMode === MODES.AVOID && t < this.avoidUntil) {
        return this._keep(MODES.AVOID, 'completing avoidance clearance', { active, situation: null })
      }
      return this._transition(MODES.NONE, 'no threats', { active, situation: null })
    }

    const sit = tactics.situation(bot, active, { canRun: ctx.canRun || null })
    if (!sit) return this._transition(MODES.NONE, 'no threats', { active: [], situation: null })

    const hp = sit.me.hp
    const food = sit.me.food
    const armor = sit.me.armor
    const weapon = sit.me.weapon
    const nearest = sit.nearest
    const nearestDist = Number(nearest?.distance ?? Infinity)

    // --- 1. Inspect critical flee triggers (always highest priority) -------
    let fleeCritical = false
    let fleeReason = ''
    let creeperAlert = null

    for (const entry of active) {
      const cr = inspectCreeper(entry)
      if (!cr) continue
      if (cr.lit && cr.dist <= this.creeperLitRadius) {
        fleeCritical = true
        fleeReason = `creeper fuse lit at ${cr.dist.toFixed(1)}m`
        creeperAlert = cr
        break
      }
      if (cr.charged && cr.dist <= this.creeperChargedRadius) {
        fleeCritical = true
        fleeReason = `charged creeper at ${cr.dist.toFixed(1)}m`
        creeperAlert = cr
        break
      }
      const critDist = cr.closing > 0.3 ? this.creeperClosingRadius : this.creeperCriticalRadius
      if (cr.dist <= critDist) {
        fleeCritical = true
        fleeReason = `creeper at critical distance (${cr.dist.toFixed(1)}m)`
        creeperAlert = cr
        break
      }
    }

    // Critical health while any threat is within danger range
    if (!fleeReason && hp <= this.criticalHealth && nearestDist <= 14) {
      fleeCritical = true
      fleeReason = `critical health (${Math.round(hp)} HP) with ${nearest.name} at ${nearestDist.toFixed(1)}m`
    } else if (!fleeReason && hp <= this.lowHealth - 2 && armor < 6 && nearestDist <= 8.5) {
      fleeCritical = true
      fleeReason = `low health (${Math.round(hp)} HP, low armor) with ${nearest.name} at ${nearestDist.toFixed(1)}m`
    } else if (!fleeReason && hp <= this.lowHealth && food <= 6 && nearestDist <= 9) {
      fleeCritical = true
      fleeReason = `low health (${Math.round(hp)} HP) and exhausted (${Math.round(food)} food)`
    }

    // Lethal boss mob in proximity
    if (!fleeReason) {
      const boss = active.find((x) => LETHAL_BOSSES.has(String(x.name || '').toLowerCase()) && x.distance <= 13)
      if (boss) {
        fleeCritical = true
        fleeReason = `lethal threat ${boss.name} at ${boss.distance.toFixed(1)}m`
      }
    }

    // Hostile attacking player (never auto-engage players -> flee when close or pressing)
    if (!fleeReason) {
      const attackerPlayer = active.find((x) => x.kind === 'player' && x.attacker && x.distance <= 10.5)
      if (attackerPlayer) {
        fleeCritical = true
        fleeReason = `attacked by player ${attackerPlayer.name} at ${attackerPlayer.distance.toFixed(1)}m`
      }
    }

    // Overwhelming enemies (multiple close hostiles or very poor combat odds)
    const closeHostiles = active.filter((x) => x.distance <= 10)
    if (!fleeReason && closeHostiles.length > 0) {
      const closeSit = closeHostiles.length === active.length ? sit : (tactics.situation(bot, closeHostiles) || sit)
      if (closeHostiles.length >= 3 && (closeSit.fight.winChance < 62 || armor < 10)) {
        fleeCritical = true
        fleeReason = `overwhelming enemies (${closeHostiles.length} within 10m, win ~${closeSit.fight.winChance}%)`
      } else if (closeSit.fight.winChance < 48 && nearestDist <= 8.5) {
        fleeCritical = closeSit.fight.winChance < 38 || nearestDist <= 5.5
        fleeReason = `unfavorable odds (win ~${closeSit.fight.winChance}%, ${nearest.name} at ${nearestDist.toFixed(1)}m)`
      }
    }

    // Unarmed against close aggressive threat
    if (!fleeReason && weapon.dmg < 4) {
      if (hp <= 14 && nearestDist <= 7 && (nearest.closing > 0.2 || nearest.attacker || nearestDist <= 5)) {
        fleeCritical = hp <= 10 || nearest.attacker || nearestDist <= 4.5
        fleeReason = `unarmed and hurt (${Math.round(hp)} HP) with ${nearest.name} at ${nearestDist.toFixed(1)}m`
      } else if (nearestDist <= 4.2 && (nearest.closing > 0.1 || nearest.attacker)) {
        fleeCritical = nearest.attacker || nearestDist <= 3.2
        fleeReason = `unarmed with ${nearest.name} in strike range (${nearestDist.toFixed(1)}m)`
      }
    }

    // An idle, unarmed bot need not wait for a visible zombie to start
    // hitting it. On an errand, keep room for detouring and only break away
    // early if the zombie is already closing at short range.
    if (!fleeReason && weapon.dmg < 4) {
      const zombie = active.find(x => x.name === 'zombie' && x.los && !x.caged &&
        (hasObjective ? x.distance <= 14 && x.closing > 0.35 : x.distance <= ZOMBIE_BUFFER))
      if (zombie) fleeReason = `opening space from zombie at ${zombie.distance.toFixed(1)}m`
    }

    // --- 2. Flee state retention & clean exit hysteresis -------------------
    if (prevMode === MODES.FLEE) {
      const zombieBuffer = !hasObjective && weapon.dmg < 4 && active.some(x => x.name === 'zombie' && x.los)
      const effRelease = zombieBuffer ? Math.max(ZOMBIE_BUFFER + 2, this.releaseRadius) : hasObjective ? this.tetherReleaseRadius : this.releaseRadius
      const effCalm = hasObjective ? this.tetherCalmMs : this.calmMs
      const safeClearance = !fleeCritical && nearestDist >= effRelease
      const nonCriticalRecovery = !zombieBuffer && !fleeCritical && !fleeReason && nearestDist >= Math.max(8, effRelease * 0.72) && (sit.closing === null || sit.closing <= 0.1)
      if (safeClearance || nonCriticalRecovery) {
        if (!this.fleeCalmSince) this.fleeCalmSince = t
        if (t - this.fleeEnteredAt >= this.minFleeMs && t - this.fleeCalmSince >= effCalm) {
          const nextMode = active.length ? MODES.AVOID : MODES.NONE
          return this._finishFlee(bot, ctx, `safe clearance (${nearestDist.toFixed(1)}m from ${nearest.name})`, nextMode, { active, situation: sit })
        }
        return this._keep(MODES.FLEE, `holding flee until calm (${Math.round((t - this.fleeCalmSince) / 100) / 10}s)`, { active, situation: sit })
      }
      this.fleeCalmSince = 0
      return this._keep(MODES.FLEE, fleeReason || this.lastReason || 'maintaining escape distance', { active, situation: sit, creeperAlert })
    }

    // Enter FLEE if warranted (respecting non-critical cooldown hysteresis)
    if (fleeReason) {
      if (fleeCritical || t >= this.fleeCooldownUntil) {
        this.fleeEnteredAt = t
        this.fleeCalmSince = 0
        return this._transition(MODES.FLEE, fleeReason, {
          active,
          situation: sit,
          creeperAlert,
          critical: fleeCritical,
          enteredFlee: true
        })
      }
      // Inside post-flee cooldown for a non-critical trigger -> hold in AVOID instead of oscillating
      this.avoidUntil = Math.max(this.avoidUntil, t + this.avoidDwellMs)
      return this._transition(MODES.AVOID, `avoiding during flee cooldown (${fleeReason})`, {
        active,
        situation: sit,
        creeperAlert
      })
    }

    // --- 3. Evaluate ENGAGE (manageable, close/interfering non-explosive) --
    const engageRadius = hasObjective ? this.engageRadiusObjective : this.engageRadiusIdle
    const engageCandidates = active.filter((x) => {
      if (x.kind === 'player') return false
      if (String(x.name || '').toLowerCase() === 'creeper') return false
      if (!isAutoFightCandidate(x.entity, bot)) return false
      if (ctx.suppressedIds && ctx.suppressedIds.has(x.id)) return false
      if (typeof ctx.autoFightSuppressed === 'function' && ctx.autoFightSuppressed(x.entity)) return false
      const maxD = x.attacker ? Math.max(engageRadius + 1.8, 6.5) : engageRadius
      return x.distance <= maxD
    })

    const hasNearbyCreeper = active.some((x) => String(x.name || '').toLowerCase() === 'creeper' && x.distance <= 10)
    const minWin = hasObjective ? this.engageWinChanceTethered : this.engageWinChance
    const maxEngageCount = hasObjective ? (armor >= 12 ? 2 : 1) : 2

    if (
      ctx.combatAvailable !== false &&
      !ctx.combatCooldown &&
      !hasNearbyCreeper &&
      engageCandidates.length > 0 &&
      engageCandidates.length <= maxEngageCount &&
      hp >= this.engageMinHp &&
      food >= this.engageMinFood &&
      weapon.dmg >= 4
    ) {
      const fightSit = engageCandidates.length === active.length ? sit : (tactics.situation(bot, engageCandidates) || sit)
      if (fightSit.fight.autoEngage && fightSit.fight.winChance >= minWin) {
        const primaryTarget = engageCandidates.slice().sort((a, b) => a.distance - b.distance)[0]
        return this._transition(MODES.ENGAGE, `manageable ${primaryTarget.name} at ${primaryTarget.distance.toFixed(1)}m (win ~${fightSit.fight.winChance}%)`, {
          active,
          situation: sit,
          target: primaryTarget,
          winChance: fightSit.fight.winChance
        })
      }
    }

    // --- 4. Default active-threat response: AVOID --------------------------
    // Threats are present in awareness radius, neither critical nor worth
    // breaking off the current objective to fight: keep objective running and
    // steer around their weighted elliptical safety regions.
    this.avoidUntil = Math.max(this.avoidUntil, t + this.avoidDwellMs)
    const avoidReason = `${active.length} threat${active.length === 1 ? '' : 's'} nearby (nearest ${nearest.name} ${nearestDist.toFixed(1)}m) — maintaining objective via threat-aware routing`
    return this._transition(MODES.AVOID, avoidReason, {
      active,
      situation: sit,
      creeperAlert
    })
  }

  _finishFlee (bot, ctx, reason, nextMode, extra = {}) {
    const t = this.now()
    const durationMs = this.fleeEnteredAt ? Math.max(0, t - this.fleeEnteredAt) : 0
    this.fleeEnteredAt = 0
    this.fleeCalmSince = 0
    this.fleeCooldownUntil = t + this.fleeCooldownMs
    if (nextMode === MODES.AVOID) this.avoidUntil = Math.max(this.avoidUntil, t + this.avoidDwellMs)
    const recovery = evaluateRecovery(bot, { chooseFood: ctx.chooseFood || null })
    const prevMode = this.mode
    this.mode = nextMode
    this.modeSince = t
    this.lastReason = reason
    const decision = {
      mode: nextMode,
      prevMode,
      changed: prevMode !== nextMode,
      reason,
      exitedFlee: true,
      fleeDurationMs: durationMs,
      recovery,
      ...extra
    }
    this.lastDecision = decision
    return decision
  }

  _keep (mode, reason, extra = {}) {
    this.lastReason = reason
    const decision = { mode, prevMode: this.mode, changed: false, reason, ...extra }
    this.lastDecision = decision
    return decision
  }

  _transition (mode, reason, extra = {}) {
    const prevMode = this.mode
    const changed = prevMode !== mode
    if (changed) {
      this.mode = mode
      this.modeSince = this.now()
    }
    this.lastReason = reason
    const decision = { mode, prevMode, changed, reason, ...extra }
    this.lastDecision = decision
    return decision
  }
}

module.exports = {
  MODES,
  LETHAL_BOSSES,
  ThreatResponseEngine,
  inspectCreeper,
  evaluateRecovery
}
