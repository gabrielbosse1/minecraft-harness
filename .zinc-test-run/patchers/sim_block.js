  /**
   * Discrete game-tick simulation over the modelled components.
   *
   * Timing follows Java Edition: a repeater's `delay` property is in REDSTONE
   * ticks (2 game ticks each), a torch/observer/comparator flips in 1 redstone
   * tick, and every change is applied *after* the current tick is observed, so
   * frame 0 is the world as inspected.
   *
   * @param {{ticks?:number, inputs?:object, changes?:string[], pulseTicks?:object}} opts
   *        inputs: nodeId → boolean (interactive sources only)
   *        changes: ids/positions of blocks whose state changed this tick (observers pulse)
   *        pulseTicks: nodeId → number (drive an input for N ticks, then release)
   * @returns {{frames:Array, outputs:Array, oscillating:boolean, period:number|null, notes:string[]}}
   */
  run ({ ticks = 40, inputs = null, changes = [], pulseTicks = null } = {}) {
    const frames = []
    const notes = []
    const dust = this.nodes.filter((n) => n.kind === 'dust')
    const repeaters = this.nodes.filter((n) => n.kind === 'repeater')
    const comparators = this.nodes.filter((n) => n.kind === 'comparator')
    const observers = this.nodes.filter((n) => n.kind === 'observer')
    const torches = this.nodes.filter((n) => n.kind === 'torch')

    const driveState = new Map()
    for (const s of this.sources()) {
      const v = sourceStrength(s, { inputs })
      driveState.set(s.id, v !== null && v > 0)
    }
    const pulseLeft = new Map()
    if (pulseTicks) for (const [id, n] of Object.entries(pulseTicks)) { driveState.set(id, true); pulseLeft.set(id, Math.max(1, Number(n) || 1)) }
    const changedSet = new Set((changes || []).map((c) => String(c)))

    const torchLit = new Map(torches.map((n) => [n.id, n.state?.lit === true]))
    const repeaterOut = new Map(repeaters.map((r) => [r.id, r.state?.powered === true]))
    const repeaterLevel = new Map(repeaters.map((r) => [r.id, r.state?.powered === true ? 15 : 0]))
    const comparatorOut = new Map(comparators.map((c) => [c.id, c.state?.powered === true]))
    const comparatorLevel = new Map(comparators.map((c) => [c.id, 0]))
    const dustLevel = new Map(dust.map((d) => [d.id, num(d.state?.power, 0) || 0]))
    const observerPulse = new Map(observers.map((o) => [o.id, o.state?.powered === true ? 2 : 0]))
    const observerArmed = new Map(observers.map((o) => [o.id, true]))

    const state = () => ({ dustLevel, repeaterLevel, comparatorLevel, torchLit, driveState })
    const powerOut = (node) => {
      if (!node) return 0
      switch (node.kind) {
        case 'dust': return dustLevel.get(node.id) || 0
        case 'repeater': return repeaterLevel.get(node.id) || 0
        case 'comparator': return comparatorLevel.get(node.id) || 0
        case 'torch': return torchLit.get(node.id) ? 15 : 0
        case 'observer': return (observerPulse.get(node.id) || 0) > 0 ? 15 : 0
        default: return driveState.get(node.id) ? 15 : 0
      }
    }

    // Dust solve for this tick, from the current device outputs and block power.
    const solveDustLevels = () => {
      const next = new Map(dust.map((d) => [d.id, 0]))
      const remembered = new Map(power.map ? [] : [])
      const shadow = new Map()
      for (const d of dust) {
        shadow.set(d.id, { model: 0, known: true, power: 0, observed: num(d.state?.power, null) })
      }
      const seed = (id, v) => { if (!next.has(id)) return; if (v > (next.get(id) || 0)) next.set(id, v) }
      const injectFrom = (node) => {
        const v = powerOut(node)
        if (!v) return
        if (node.kind === 'observer') {
          for (const o of this.outputsOf(node)) if (o.node?.kind === 'dust') seed(o.node.id, 15)
          return
        }
        for (const nb of this.neighbours(node)) {
          if (nb.node.kind !== 'dust') continue
          if (node.kind === 'torch' && nb.dir === 'up') continue
          seed(nb.node.id, v)
        }
      }
      for (const n of this.nodes) {
        if (n.kind === 'dust') continue
        if (n.kind === 'repeater' || n.kind === 'comparator') {
          if (!powerOut(n)) continue
          for (const o of this.outputsOf(n)) if (o.node?.kind === 'dust') seed(o.node.id, powerOut(n))
          continue
        }
        if (n.kind === 'torch' || n.kind === 'observer' || SOURCE_KINDS.has(n.kind)) injectFrom(n)
      }
      // Strongly powered blocks feed dust on top of them and dust pointing out of them.
      for (const d of dust) {
        const bpBelow = this.blockPowerSim(d.x, d.y - 1, d.z, state())
        if (bpBelow && bpBelow.strong > 0) seed(d.id, bpBelow.strong)
        for (const nb of this.neighbours(d)) {
          if (nb.node.kind === 'dust') continue
          const bp = this.blockPowerSim(nb.node.x, nb.node.y, nb.node.z, state())
          if (!bp || bp.strong <= 0) continue
          const pointsAway = nb.dir === 'up' || d.state?.[OPP[nb.dir]] === 'side' || d.state?.[OPP[nb.dir]] === 'up'
          if (pointsAway) seed(d.id, bp.strong)
        }
      }
      for (let iter = 0; iter < 24; iter++) {
        let changed = false
        for (const d of dust) {
          for (const nb of this.neighbours(d)) {
            if (nb.node.kind !== 'dust') continue
            if (!this.dustStep(nb.node, d)) continue
            const v = Math.max(0, (next.get(nb.node.id) || 0) - 1)
            if (v > (next.get(d.id) || 0)) { next.set(d.id, v); changed = true }
          }
        }
        if (!changed) break
      }
      for (const [k, v] of next) {
        dustLevel.set(k, v)
        if (shadow.has(k)) shadow.get(k).model = v
      }
      return shadow
    }

    // Block power using simulated device state instead of a solved map.
    this.blockPowerSim = (x, y, z, st) => {
      if (!this.isConductive(x, y, z)) return null
      const at = { x, y, z }
      let strong = 0; let weak = 0; let known = false
      for (const nb of this.neighbours(at)) {
        const other = nb.node
        if (other.kind === 'dust') {
          const v = st.dustLevel.get(other.id) || 0
          const pointsIn = nb.dir === 'up' || other.state?.[OPP[nb.dir]] === 'side' || other.state?.[OPP[nb.dir]] === 'up'
          if (pointsIn) { known = true; weak = Math.max(weak, v) }
          continue
        }
        if (other.kind === 'repeater' || other.kind === 'comparator') {
          const s = other.state || {}
          if (s.facing && OPP[s.facing] === nb.dir) {
            known = true
            strong = Math.max(strong, st.repeaterLevel.get(other.id) || st.comparatorLevel.get(other.id) || 0)
          }
          continue
        }
        if (other.kind === 'torch') {
          if (nb.dir === 'down' && st.torchLit.get(other.id)) { known = true; strong = Math.max(strong, 15) }
          continue
        }
        if (SOURCE_KINDS.has(other.kind)) {
          const on = other.kind === 'redstone_block' ? true : (st.driveState.get(other.id) === true)
          if (on) { known = true; strong = Math.max(strong, 15) }
        }
      }
      if (!known) return null
      return { strong, weak, total: Math.max(strong, weak) }
    }

    const rearLevel = (node) => {
      const s = node.state || {}
      if (!s.facing || !DIRS[s.facing]) return 0
      const v = DIRS[s.facing]
      const rear = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (rear) return powerOut(rear)
      const bp = this.blockPowerSim(node.x + v.x, node.y, node.z + v.z, state())
      return bp ? bp.total : 0
    }
    const sideLevel = (node, d) => {
      const v = DIRS[d]
      const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (n) return powerOut(n)
      const bp = this.blockPowerSim(node.x + v.x, node.y, node.z + v.z, state())
      return bp ? bp.total : 0
    }
    const mechanismPower = (m) => {
      let best = 0
      for (const nb of this.neighbours(m)) {
        const o = nb.node
        if (o.kind === 'dust') {
          const pointsIn = nb.dir === 'down' || o.state?.[OPP[nb.dir]] === 'side' || o.state?.[OPP[nb.dir]] === 'up'
          if (pointsIn) best = Math.max(best, dustLevel.get(o.id) || 0)
          continue
        }
        if (o.kind === 'repeater' || o.kind === 'comparator') {
          const s = o.state || {}
          if (s.facing && OPP[s.facing] === nb.dir) best = Math.max(best, powerOut(o))
          continue
        }
        if (o.kind === 'torch') { if (nb.dir !== 'up' && torchLit.get(o.id)) best = Math.max(best, 15); continue }
        const bp = this.blockPowerSim(o.x, o.y, o.z, state())
        if (bp) best = Math.max(best, bp.total)
      }
      if (m.kind === 'piston' || m.kind === 'sticky_piston') {
        const bp = this.blockPowerSim(m.x, m.y + 1, m.z, state())
        if (bp && bp.strong > 0) best = Math.max(best, bp.strong)
      }
      return best
    }

    const pending = [] // { at, apply }
    const schedule = (at, apply) => pending.push({ at, apply })

    for (let t = 0; t < ticks; t++) {
      // 1. Drive changes requested for this tick (observers watch their target).
      for (const o of observers) {
        const s = o.state || {}
        const v = AXIS_VEC[s.facing] || DIRS[s.facing]
        const watched = v ? key(o.x + v.x, o.y + v.y, o.z + v.z) : null
        const triggered = changedSet.has(o.id) || (watched && changedSet.has(watched)) || (o.state?.powered === true && observerArmed.get(o.id))
        if (triggered) { observerPulse.set(o.id, 2); observerArmed.set(o.id, false); schedule(t + 2, () => observerPulse.set(o.id, Math.max(0, (observerPulse.get(o.id) || 0) - 1))) }
        else if ((observerPulse.get(o.id) || 0) === 0) observerArmed.set(o.id, true)
      }
      // 2. Solve dust for this tick.
      solveDustLevels()
      // 3. Torches: lit when their attachment is not strongly powered.
      for (const n of torches) {
        let supportStrong = 0
        let supportKnown = false
        const ins = this.inputsOf(n)
        for (const inp of ins) {
          if (inp.node) {
            const p = powerOut(inp.node)
            if (inp.node.kind === 'dust') {
              // Weak power (dust) never extinguishes a torch.
              if (inp.role === 'support') { /* dust beside a floor torch is not its support */ }
              continue
            }
            supportKnown = true
            supportStrong = Math.max(supportStrong, p)
          }
          if (inp.solid) {
            const bp = this.blockPowerSim(n.x + (DIRS[inp.dir]?.x || 0), n.y + (AXIS_VEC[inp.dir]?.y || 0), n.z + (DIRS[inp.dir]?.z || 0), state())
            if (bp) { supportKnown = true; supportStrong = Math.max(supportStrong, bp.strong) }
          }
        }
        const want = supportStrong === 0
        const cur = torchLit.get(n.id)
        if (cur !== want) schedule(t + 2, () => torchLit.set(n.id, want))
      }
      // 4. Repeaters: state.delay is in redstone ticks.
      for (const r of repeaters) {
        const s = r.state || {}
        if (s.locked === true) continue
        const want = rearLevel(r) > 0
        if (want !== repeaterOut.get(r.id)) {
          const gameTicks = Math.max(2, Math.min(8, (num(s.delay, 1) || 1) * 2))
          schedule(t + gameTicks, () => { repeaterOut.set(r.id, want); repeaterLevel.set(r.id, want ? 15 : 0) })
        }
      }
      // 5. Comparators: analog compare/subtract, 2 game ticks.
      for (const c of comparators) {
        const s = c.state || {}
        const rear = rearLevel(c)
        let side = 0
        for (const d of HORIZ) {
          if (d === s.facing || d === OPP[s.facing]) continue
          side = Math.max(side, sideLevel(c, d))
        }
        const mode = s.mode === 'subtract' ? 'subtract' : 'compare'
        const out = mode === 'subtract' ? Math.max(0, rear - side) : (side > rear ? 0 : rear)
        if (out !== (comparatorLevel.get(c.id) || 0)) {
          schedule(t + 2, () => { comparatorLevel.set(c.id, out); comparatorOut.set(c.id, out > 0) })
        }
      }
      // 6. Apply everything due at or before this tick (after it was observed).
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].at <= t) { const q = pending[i]; pending.splice(i, 1); q.apply() }
      }
      // 7. Drive pulses.
      for (const [id, left] of [...pulseLeft]) {
        if (left <= 1) { pulseLeft.delete(id); driveState.set(id, false) } else pulseLeft.set(id, left - 1)
      }
      const outputs = this.mechanisms().map((m) => ({ at: m.id, kind: m.kind, active: mechanismPower(m) > 0 }))
      frames.push({
        tick: t,
        dust: Object.fromEntries(dustLevel),
        torches: Object.fromEntries(torchLit),
        repeaters: Object.fromEntries(repeaterOut),
        comparators: Object.fromEntries(comparatorLevel),
        observers: Object.fromEntries(observerPulse),
        outputs
      })
    }
    // Oscillation detection on mechanism outputs.
    let oscillating = false
    let period = null
    const outs = this.mechanisms()
    const seriesOf = (id) => frames.map((f) => { const o = f.outputs.find((x) => x.at === id); return o && o.active ? 1 : 0 })
    const watchList = outs.length ? outs.map((m) => m.id) : torches.map((n) => n.id)
    for (const id of watchList) {
      const series = outs.length ? seriesOf(id) : frames.map((f) => (f.torches[id] ? 1 : 0))
      for (let p = 2; p <= Math.min(24, Math.floor(series.length / 2)); p++) {
        let same = true
        for (let i = p; i < series.length; i++) if (series[i] !== series[i - p]) { same = false; break }
        if (same && series.some((v, i) => i > 0 && v !== series[i - 1])) { oscillating = true; period = p; break }
      }
      if (oscillating) break
    }
    if (oscillating) notes.push(`output changes periodically with a modelled period of ${period} game tick(s) — this is a clock/oscillator in the model, not a server measurement`)
    if (!this.sources().length && !observers.length) notes.push('no sources in this region: the circuit cannot be driven without adding one')
    if (observers.length) notes.push('observer pulses need `changes` (or an observed powered state) — a static snapshot cannot show what an observer will watch next')
    return { frames, outputs: frames[frames.length - 1]?.outputs || [], oscillating, period, notes }
  }

  _simPowerOf (node, st, fallback = undefined) {
    if (!node) return 0
    if (node.kind === 'dust') return st.dustLevel?.get(node.id) || 0
    if (node.kind === 'repeater') return st.repeaterLevel?.get(node.id) || 0
    if (node.kind === 'comparator') return st.comparatorLevel?.get(node.id) || 0
    if (node.kind === 'torch') return st.torchLit?.get(node.id) ? 15 : 0
    if (node.kind === 'observer') return (st.observerPulse?.get(node.id) || 0) > 0 ? 15 : 0
    if (SOURCE_KINDS.has(node.kind)) return st.driveState?.get(node.id) ? 15 : 0
    return 0
  }
