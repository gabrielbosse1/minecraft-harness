  /**
   * Solid-block connectivity: true when power delivered into `pos` by a
   * component other than dust can be pulled out of it (dust running over it,
   * a repeater reading it, a torch hanging on it). Transparent blocks are not
   * conductive in Java, with a short list of documented exceptions.
   */
  isConductive (x, y, z) {
    if (!this.isSolid(x, y, z)) return false
    const n = this.nodeAt(x, y, z)
    switch (n?.kind) {
      case 'redstone_lamp': case 'note_block': case 'piston': case 'sticky_piston':
      case 'observer': case 'hopper': case 'dropper': case 'dispenser':
      case 'container': case 'chest': case 'trapped_chest': case 'crafting_table':
      case 'furnace': case 'blast_furnace': case 'smoker': case 'barrel':
      case 'powered_rail': case 'activator_rail': case 'detector_rail':
        return true
      case 'door': case 'trapdoor': case 'fence_gate': case 'piston_head': case 'moving_piston':
        return false
      default:
        return true // ordinary opaque terrain (the snapshot only records non-signal solids here)
    }
  }

  /** Can a signal step from dust cell `from` into dust cell `to`? */
  dustStep (from, to) {
    const dx = to.x - from.x; const dy = to.y - from.y; const dz = to.z - from.z
    const dirOf = (vx, vy, vz) => vy > 0 ? 'up' : vy < 0 ? 'down'
      : vz < 0 ? 'north' : vz > 0 ? 'south' : vx > 0 ? 'east' : 'west'
    if (dx === 0 && dz === 0) return false // a straight vertical stack never conducts
    if (dy === 0 && (dx === 0 || dz === 0)) {
      const d = dirOf(dx, dy, dz)
      const side = to.state?.[OPP[d]]
      return side === 'side' || side === 'up' || side === undefined
    }
    if (Math.abs(dy) === 1 && (dx === 0) !== (dz === 0)) {
      // One block up or down, one block sideways: both cells must agree.
      if (dy > 0) {
        // `to` is the higher cell: it must point down at `from`.
        const d = dirOf(dx, 0, dz)
        return to.state?.[OPP[d]] === 'side' || to.state?.[OPP[d]] === 'up'
      }
      const d = dirOf(dx, 0, dz)
      return to.state?.[d] === 'up' || from.state?.[d] === 'up'
    }
    return false
  }

  /** Where a component's OUTPUT leaves (list of neighbour descriptors). */
  outputsOf (node) {
    const s = node.state || {}
    switch (node.kind) {
      case 'dust': return this.neighbours(node)
      case 'repeater':
      case 'comparator': {
        if (!s.facing || !DIRS[s.facing]) return []
        const d = OPP[s.facing]
        const v = DIRS[d]
        const out = []
        const front = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        if (front) out.push({ dir: d, node: front })
        // A repeater's front face also powers the block above its output when
        // that block is the one the dust sits on — modelled through block power.
        return out
      }
      case 'observer': {
        if (!s.facing) return []
        const d = OPP[s.facing]
        const v = AXIS_VEC[d] || DIRS[d]
        if (!v) return []
        const front = this.nodeAt(node.x + v.x, node.y + v.y, node.z + v.z)
        return front ? [{ dir: d, node: front }] : []
      }
      case 'torch': return this.neighbours(node)
      case 'lever': case 'button': case 'pressure_plate': case 'tripwire':
      case 'tripwire_hook': case 'target': case 'daylight_detector':
      case 'redstone_block': case 'sculk_sensor': case 'calibrated_sculk_sensor':
      case 'detector_rail': case 'lightning_rod': case 'trapped_chest':
        return this.neighbours(node)
      default: return []
    }
  }

  /** True when `node` accepts a signal from the neighbour at `dir` as its REAR. */
  _readsRear (node, dir) {
    const s = node.state || {}
    return Boolean(s.facing) && s.facing === dir
  }

  /** Where a component's INPUT arrives from. */
  inputsOf (node) {
    const s = node.state || {}
    switch (node.kind) {
      case 'repeater':
      case 'comparator': {
        if (!s.facing || !DIRS[s.facing]) return []
        const v = DIRS[s.facing]
        const rear = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        const out = []
        if (rear) out.push({ dir: s.facing, node: rear, role: 'rear' })
        else if (this.isSolid(node.x + v.x, node.y, node.z + v.z)) out.push({ dir: s.facing, solid: true, role: 'rear' })
        if (node.kind === 'comparator') {
          for (const d of HORIZ) {
            if (d === s.facing || d === OPP[s.facing]) continue
            const sd = DIRS[d]
            const side = this.nodeAt(node.x + sd.x, node.y, node.z + sd.z)
            if (side) out.push({ dir: d, node: side, role: 'side' })
            else if (this.isSolid(node.x + sd.x, node.y, node.z + sd.z)) out.push({ dir: d, solid: true, role: 'side' })
          }
        }
        return out
      }
      case 'observer': {
        if (!s.facing) return []
        const v = AXIS_VEC[s.facing] || DIRS[s.facing]
        if (!v) return []
        const watched = this.nodeAt(node.x + v.x, node.y + v.y, node.z + v.z)
        if (watched) return [{ dir: s.facing, node: watched, role: 'watched' }]
        if (this.isSolid(node.x + v.x, node.y + v.y, node.z + v.z)) return [{ dir: s.facing, solid: true, role: 'watched' }]
        return []
      }
      case 'torch': {
        // A torch's attachment is what switches it off. A floor torch hangs on
        // the block below; a wall torch hangs on the block opposite `facing`.
        if (node.name === 'redstone_wall_torch' && s.facing && DIRS[s.facing]) {
          const d = OPP[s.facing]
          const v = DIRS[d]
          return [{ dir: d, node: this.nodeAt(node.x + v.x, node.y, node.z + v.z), solid: this.isSolid(node.x + v.x, node.y, node.z + v.z), role: 'support' }]
        }
        return [{ dir: 'down', node: this.nodeAt(node.x, node.y - 1, node.z), solid: this.isSolid(node.x, node.y - 1, node.z), role: 'support' }]
      }
      case 'dust': return this.neighbours(node)
      default: return this.neighbours(node)
    }
  }

  _buildEdges () {
    const edges = []
    const seen = new Set()
    const push = (from, to, kind, evidence, confidence) => {
      const k = `${from}|${to}|${kind}`
      if (seen.has(k)) return
      seen.add(k)
      edges.push({ from, to, kind, evidence, confidence })
    }
    for (const node of this.nodes) {
      for (const o of this.outputsOf(node)) {
        if (!o.node) continue
        if (!isSignalCarrier(o.node.kind) && !isMechanism(o.node) && !SOURCE_KINDS.has(o.node.kind)) continue
        let kind = 'signal_path'
        let confidence = 'modelled'
        let evidence = `${node.kind} → ${o.node.kind} via ${o.dir}`
        if (node.kind === 'dust' && o.node.kind === 'dust') {
          const conducts = this.dustStep(node, o.node)
          const side = node.state?.[o.dir]
          kind = conducts ? 'dust_link' : 'dust_link_geometry'
          if (!conducts) confidence = 'blocked'
          evidence = `dust ${o.dir}=${side ?? 'unknown'}${conducts ? '' : ' (does not conduct)'}`
        }
        if (node.kind === 'repeater' || node.kind === 'comparator') { kind = 'logic_output'; evidence = `${node.kind} front ${o.dir}` }
        if (node.kind === 'observer') { kind = 'observer_pulse'; evidence = `observer output ${o.dir}` }
        if (isMechanism(o.node)) { kind = 'mechanism_input'; evidence = `${o.node.kind} powered from ${o.dir}` }
        push(node.id, o.node.id, kind, evidence, confidence)
      }
    }
    return edges
  }

  /** Adjacent nodes that deliver power into `node` (any face, any direction). */
  _powerSourcesAround (node, power) {
    const out = []
    for (const nb of this.neighbours(node)) {
      const other = nb.node
      if (other.kind === 'dust') {
        const dc = power.get(other.id)
        if (dc && dc.known && this.dustStep(other, node)) out.push({ at: other.id, dir: nb.dir, power: dc.model })
      } else if (other.kind === 'repeater' || other.kind === 'comparator') {
        const lc = power.get(other.id)
        const s = other.state || {}
        if (lc && lc.known && s.facing && OPP[s.facing] === nb.dir) out.push({ at: other.id, dir: nb.dir, power: lc.model })
      } else if (SOURCE_KINDS.has(other.kind)) {
        const s = sourceStrength(other)
        if (s !== null && s !== 0) out.push({ at: other.id, dir: nb.dir, power: s })
      }
    }
    return out
  }

  /**
   * Power delivered into the CONDUCTIVE block at (x,y,z).
   *
   * `strong` = full strength through the block (a repeater/comparator front, a
   * torch underneath, a lever/button on the block, a redstone block). `weak`
   * = only from dust on top of or pointing into the block. Only the strong
   * variant feeds fresh dust; both activate mechanisms and repeaters.
   */
  blockPower (x, y, z, power) {
    if (!this.isConductive(x, y, z)) return null
    const at = { x, y, z, id: key(x, y, z) }
    let strong = 0
    let weak = 0
    let known = false
    for (const nb of this.neighbours(at)) {
      const other = nb.node
      if (other.kind === 'dust' || other.kind === 'repeater' || other.kind === 'comparator') continue
      if (!SOURCE_KINDS.has(other.kind) && other.kind !== 'torch') continue
      const s = sourceStrength(other)
      if (s === null) continue
      // A torch never powers the block it hangs on; it powers the block above it.
      if (other.kind === 'torch') {
        if (nb.dir !== 'down') continue
        if (!other.state?.lit) continue
        strong = Math.max(strong, 15); known = true
        continue
      }
      if (s <= 0) continue
      known = true
      strong = Math.max(strong, s)
    }
    // A powered repeater/comparator powers the block in front of it.
    for (const nb of this.neighbours(at)) {
      const other = nb.node
      if (other.kind !== 'repeater' && other.kind !== 'comparator') continue
      const s = other.state || {}
      if (!s.facing || OPP[s.facing] !== nb.dir) continue
      const lc = power.get(other.id)
      if (!lc || !lc.known) continue
      known = true
      if ((lc.model || 0) > 0) strong = Math.max(strong, lc.model)
    }
    // Dust on top, or dust pointing into this block, powers it weakly.
    for (const nb of this.neighbours(at)) {
      const other = nb.node
      if (other.kind !== 'dust') continue
      const dc = power.get(other.id)
      if (!dc || !dc.known) continue
      const pointsIn = nb.dir === 'up' || other.state?.[OPP[nb.dir]] === 'side' || other.state?.[OPP[nb.dir]] === 'up'
      if (!pointsIn) continue
      known = true
      weak = Math.max(weak, dc.model)
    }
    if (!known) return null
    const total = Math.max(strong, weak)
    return { strong, weak, total, known, rank: strong >= weak ? 'strong' : 'weak' }
  }

  /**
   * Fixed-point power solve from the *observed* source states.
   * Returns Map(nodeId → {power, model, known, observed, contributors[]}).
   * `power` is the signal strength (0–15); a repeater/comparator outputs at
   * least 15 when its modelled output is on (a real repeater re-strengthens).
   */
  solvePower ({ inputs = null, maxIterations = 48 } = {}) {
    const power = new Map()
    const contributors = new Map()
    const dust = this.nodes.filter((n) => n.kind === 'dust')
    for (const d of dust) {
      const observed = num(d.state?.power, null)
      power.set(d.id, { model: 0, observed, known: observed !== null, power: 0, contributors: [] })
      contributors.set(d.id, [])
    }
    // Devices are solved from their observed state first, so a snapshot with no
    // reachable source (the source sits outside the inspected box) still models.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const observed = node.state?.powered
      power.set(node.id, {
        model: 0,
        observed: observed === true ? 15 : observed === false ? 0 : null,
        known: observed === true || observed === false,
        power: 0,
        contributors: []
      })
    }
    const setDust = (id, value, via) => {
      const cur = power.get(id)
      if (!cur) return false
      if (value > cur.model) { cur.model = value; cur.power = value; cur.contributors = via; return true }
      return false
    }
    // Seed from observed dust (covers a wire whose source is outside the box).
    for (const d of dust) {
      const observed = num(d.state?.power, null)
      if (observed !== null && observed > 0) setDust(d.id, observed, [{ from: 'observed', via: 'client state', power: observed }])
    }
    // Seed from active devices: dust next to a lit torch/lever/redstone block.
    for (const src of this.nodes) {
      if (src.kind === 'torch') {
        if (src.state?.lit !== true) continue
        for (const nb of this.neighbours(src)) {
          if (nb.node.kind === 'dust') setDust(nb.node.id, 15, [{ from: src.id, via: 'lit torch', power: 15 }])
          if (this.isSolid(nb.node.x, nb.node.y, nb.node.z)) {
            // A torch strongly powers the block above it (handled by blockPower).
          }
        }
        continue
      }
      if (!SOURCE_KINDS.has(src.kind)) continue
      const strength = sourceStrength(src, { inputs })
      if (strength === null || strength <= 0) continue
      for (const nb of this.neighbours(src)) {
        if (nb.node.kind === 'dust') setDust(nb.node.id, strength, [{ from: src.id, via: `${src.kind} adjacent`, power: strength }])
      }
    }
    // Seed dust from repeater/comparator fronts and from strongly powered blocks.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const cur = power.get(node.id)
      if (!cur?.known || !cur.model) continue
      for (const o of this.outputsOf(node)) {
        if (o.node?.kind === 'dust') setDust(o.node.id, cur.model >= 15 ? 15 : cur.model, [{ from: node.id, via: `${node.kind} front`, power: cur.model }])
      }
    }
    let changed = true
    let iter = 0
    while (changed && iter++ < maxIterations) {
      changed = false
      // Dust-to-dust relaxation.
      for (const d of dust) {
        const cur = power.get(d.id)
        for (const nb of this.neighbours(d)) {
          const other = nb.node
          if (other.kind !== 'dust') continue
          const oc = power.get(other.id)
          if (!oc || !oc.known) continue
          if (!this.dustStep(other, d)) continue
          const candidate = Math.max(0, oc.model - 1)
          if (setDust(d.id, candidate, [...oc.contributors, { from: other.id, via: 'dust decay', power: candidate }])) changed = true
        }
      }
      // Strongly powered blocks feed dust on top of them and dust beside them.
      for (const d of dust) {
        const cur = power.get(d.id)
        const below = this.blockPower(d.x, d.y - 1, d.z, power)
        if (below && below.strong > 0) {
          if (setDust(d.id, below.strong, [{ from: key(d.x, d.y - 1, d.z), via: 'strongly powered block below', power: below.strong }])) changed = true
        }
        for (const nb of this.neighbours(d)) {
          const other = nb.node
          if (other.kind === 'dust') continue
          const bp = this.blockPower(other.x, other.y, other.z, power)
          if (!bp || bp.strong <= 0) continue
          if (!this.dustStep({ x: other.x, y: other.y, z: other.z, state: {} }, d) && !(nb.dir === 'up')) {
            // Dust only takes block power from a block it sits on or points out of.
            const pointsAway = d.state?.[OPP[nb.dir]] === 'side' || d.state?.[OPP[nb.dir]] === 'up' || nb.dir === 'up'
            if (!pointsAway) continue
          }
          if (setDust(d.id, bp.strong, [{ from: other.id, via: 'strongly powered block', power: bp.strong }])) changed = true
        }
      }
      // Devices follow their solved inputs.
      for (const node of this.nodes) {
        if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
        const cur = power.get(node.id)
        if (node.kind === 'repeater') {
          const inP = this.inputPower(node, power, { inputs })
          if (inP === null) continue
          const want = inP > 0 ? 15 : 0
          if (want !== cur.model) { cur.model = want; cur.power = want; cur.known = true; cur.contributors = [{ from: 'rear', via: `repeater input ${inP}`, power: inP }]; changed = true }
        } else {
          const r = this.comparatorPower(node, power, { inputs })
          if (r === null) continue
          if (r.output !== cur.model) { cur.model = r.output; cur.power = r.output; cur.known = true; cur.contributors = [{ from: 'rear', via: `comparator ${r.mode} rear=${r.rear} side=${r.side}`, power: r.output }]; changed = true }
        }
      }
    }
    return { power, contributors }
  }

  /** Power arriving at a repeater/comparator REAR from its neighbours or its rear block. */
  inputPower (node, power, { inputs = null } = {}) {
    const s = node.state || {}
    if (!s.facing || !DIRS[s.facing]) return null
    const v = DIRS[s.facing]
    const rx = node.x + v.x; const ry = node.y; const rz = node.z + v.z
    let best = 0
    let known = false
    const rear = this.nodeAt(rx, ry, rz)
    if (rear) {
      if (rear.kind === 'dust') {
        const dc = power.get(rear.id)
        if (dc && dc.known) { known = true; best = Math.max(best, dc.model) }
      } else if (rear.kind === 'torch') {
        known = true; best = Math.max(best, rear.state?.lit ? 15 : 0)
      } else if (rear.kind === 'repeater' || rear.kind === 'comparator') {
        const lc = power.get(rear.id)
        if (lc && lc.known) { known = true; best = Math.max(best, lc.model) }
      } else if (SOURCE_KINDS.has(rear.kind)) {
        const sSrc = sourceStrength(rear, { inputs })
        if (sSrc !== null) { known = true; best = Math.max(best, sSrc) }
      }
      // A mechanism or plain solid between the rear and the wire: pull its block power.
      const bp = this.blockPower(rx, ry, rz, power)
      if (bp) { known = true; best = Math.max(best, bp.total) }
    } else {
      const bp = this.blockPower(rx, ry, rz, power)
      if (bp) { known = true; best = Math.max(best, bp.total) }
    }
    return known ? best : null
  }

  /** Analog comparator solve: comparison or subtraction of rear against sides. */
  comparatorPower (node, power, { inputs = null } = {}) {
    const s = node.state || {}
    const rear = this.inputPower(node, power, { inputs })
    if (rear === null) return null
    let side = 0
    let sideKnown = true
    for (const d of HORIZ) {
      if (d === s.facing || d === OPP[s.facing]) continue
      const v = DIRS[d]
      const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
      if (!n) {
        const bp = this.blockPower(node.x + v.x, node.y, node.z + v.z, power)
        side = Math.max(side, bp ? bp.total : 0)
        continue
      }
      if (n.kind === 'dust') { const dc = power.get(n.id); if (dc && dc.known) side = Math.max(side, dc.model) }
      else if (n.kind === 'torch') side = Math.max(side, n.state?.lit ? 15 : 0)
      else if (n.kind === 'repeater' || n.kind === 'comparator') { const lc = power.get(n.id); if (lc?.known) side = Math.max(side, lc.model) }
      else if (SOURCE_KINDS.has(n.kind)) { const x = sourceStrength(n, { inputs }); if (x !== null) side = Math.max(side, x) }
      else { const bp = this.blockPower(n.x, n.y, n.z, power); if (bp) side = Math.max(side, bp.total) }
    }
    const mode = s.mode === 'subtract' ? 'subtract' : 'compare'
    const output = mode === 'subtract' ? Math.max(0, rear - side) : (side > rear ? 0 : rear)
    return { rear, side, sideKnown, mode, output }
  }

  /** Kept for callers that only need the numeric block power. */
  blockPowerAt (node, inp) {
    const v = inp.dir && (DIRS[inp.dir] || AXIS_VEC[inp.dir])
    if (!v) return null
    const bp = this.blockPower(node.x + v.x, node.y + v.y, node.z + v.z, this._lastPower || new Map())
    return bp ? bp.total : null
  }

  /**
   * Predicted activation of one mechanism.
   *
   * Java: a mechanism is activated by an adjacent source, an adjacent powered
   * block (strong OR weak), a repeater/comparator facing it, or dust pointing
   * at it. A piston is additionally activated by a strongly powered block one
   * block above it (quasi-connectivity); that is modelled, and flagged.
   */
  predictMechanism (node, power, { inputs = null } = {}) {
    let inPower = 0
    let known = false
    const reasons = []
    for (const nb of this.neighbours(node)) {
      const other = nb.node
      if (other.kind === 'dust') {
        const dc = power.get(other.id)
        if (dc && dc.known) {
          known = true
          const pointsIn = nb.dir === 'down' || other.state?.[OPP[nb.dir]] === 'side' || other.state?.[OPP[nb.dir]] === 'up'
          if (pointsIn && dc.model > inPower) { inPower = dc.model; reasons.push(`dust ${nb.dir}`) }
        }
        continue
      }
      if (other.kind === 'repeater' || other.kind === 'comparator') {
        const lc = power.get(other.id)
        const s = other.state || {}
        if (lc && lc.known) {
          known = true
          if (s.facing && OPP[s.facing] === nb.dir && lc.model > inPower) { inPower = lc.model; reasons.push(`${other.kind} facing it`) }
        }
        continue
      }
      if (other.kind === 'torch') {
        known = true
        if (other.state?.lit && nb.dir !== 'up') { inPower = Math.max(inPower, 15); reasons.push('lit torch beside it') }
        continue
      }
      if (SOURCE_KINDS.has(other.kind)) {
        const s = sourceStrength(other, { inputs })
        if (s !== null) { known = true; if (s > inPower) { inPower = s; reasons.push(`${other.kind} adjacent`) } }
        continue
      }
      // A solid block beside the mechanism may carry power into it.
      const bp = this.blockPower(other.x, other.y, other.z, power)
      if (bp) { known = true; if (bp.total > inPower) { inPower = bp.total; reasons.push(`block ${nb.dir} ${bp.rank}`) } }
    }
    let quasi = false
    if (node.kind === 'piston' || node.kind === 'sticky_piston') {
      const above = { x: node.x, y: node.y + 1, z: node.z }
      const bp = this.blockPower(above.x, above.y, above.z, power)
      if (bp && bp.strong > 0) { known = true; quasi = true; if (bp.strong > inPower) { inPower = bp.strong; reasons.push('quasi-connectivity (block above)') } }
    }
    const lit = inPower > 0
    const extra = quasi ? { quasiConnectivity: true } : {}
    switch (node.kind) {
      case 'redstone_lamp': return { activate: lit, expected: { lit }, known, inPower, reasons, ...extra }
      case 'piston':
      case 'sticky_piston': return { activate: lit, expected: { extended: lit }, known, inPower, reasons, ...extra }
      case 'door':
      case 'trapdoor':
      case 'fence_gate': return { activate: lit, expected: { open: lit }, known, inPower, reasons, ...extra }
      case 'note_block': return { activate: lit, expected: { powered: lit }, known, inPower, reasons, ...extra }
      case 'hopper': return { activate: !lit, expected: { enabled: !lit }, known, inPower, reasons, ...extra }
      case 'dropper':
      case 'dispenser': return { activate: lit, expected: { triggered: lit }, known, inPower, reasons, ...extra }
      case 'powered_rail':
      case 'activator_rail': return { activate: lit, expected: {}, known, inPower, reasons, ...extra }
      default: return { activate: lit, expected: {}, known, inPower, reasons, ...extra }
    }
  }

  /**
   * Compare model predictions with the observed world. Every discrepancy is a
   * diagnostic lead, not proof that the world is wrong.
   */
  compareObserved ({ inputs = null } = {}) {
    const { power } = this.solvePower({ inputs })
    const rows = []
    for (const node of this.nodes) {
      if (node.kind === 'dust' || node.kind === 'repeater' || node.kind === 'comparator') {
        const p = power.get(node.id)
        if (!p || p.observed === null) continue
        rows.push({ node, predicted: p.model, observed: p.observed, agree: p.model === p.observed, why: `model ${p.model} vs observed ${p.observed}` })
      } else if (isMechanism(node)) {
        const pred = this.predictMechanism(node, power, { inputs })
        const expected = pred.expected
        const observedState = node.state || {}
        const entries = Object.entries(expected).filter(([k]) => observedState[k] !== undefined)
        if (!entries.length) continue
        const agree = entries.every(([k, v]) => observedState[k] === v)
        rows.push({ node, predicted: expected, observed: Object.fromEntries(entries.map(([k]) => [k, observedState[k]])), agree, known: pred.known, why: pred.reasons.join(', ') || 'no modelled input' })
      }
    }
    return rows
  }

  // ------------------------------------------------------------- diagnosis

  /**
   * Fault diagnosis. Returns findings ordered by severity, each naming the
   * evidence it used and what it cannot know.
   */
  diagnose ({ inputs = null } = {}) {
    const findings = []
    const { power } = this.solvePower({ inputs })
    const add = (severity, code, node, msg, evidence) => findings.push({ severity, code, at: node ? `${node.x},${node.y},${node.z}` : null, kind: node?.kind || null, msg, evidence: evidence || null })
    const mechanisms = this.mechanisms()
    this._lastPower = power
    const sourcesOn = this.sources().filter((s) => (sourceStrength(s, { inputs }) || 0) > 0)

    // A circuit can legitimately have no interactive source: an observer clock,
    // a pressure plate outside the box, a redstone block. Only complain when
    // nothing at all can drive the model AND no component is already on.
    const anyDriven = [...power.values()].some((p) => p.known && p.model > 0)
    if (!sourcesOn.length && !anyDriven) {
      add('high', 'no_active_source', null, 'no redstone source is active in this region, so nothing can be powered', `${this.sources().length} passive source(s) observed`)
    }

    // Dust cells that read 0 while a visibly-linked neighbour carries power.
    for (const node of this.nodes) {
      if (node.kind !== 'dust') continue
      const observed = num(node.state?.power, null)
      if (observed === null || observed > 0) continue
      for (const nb of this.neighbours(node)) {
        if (nb.node.kind !== 'dust') continue
        const nObs = num(nb.node.state?.power, null)
        if (nObs === null || nObs <= 1) continue
        if (!this.dustStep(nb.node, node)) {
          add('medium', 'dust_visually_unlinked', node,
            `dust here reads power=${observed} while its ${nb.dir} neighbour reads ${nObs}, and the ${nb.dir} side does not connect — the run is deliberately broken or the dust was right-clicked into a dot`,
            `neighbour ${nb.node.id} power=${nObs}`)
          continue
        }
        add('high', 'dust_gap', node,
          `dust here reads power=0 while the ${nb.dir} neighbour reads ${nObs} and both sides visually connect — the link is probably cut (a block between them, a different Y level, or a stale client read). Re-inspect the ${nb.dir} side and the block on top`,
          `neighbour ${nb.node.id} power=${nObs}`)
        break
      }
    }

    // Mechanisms that should be active but are not (or vice versa).
    for (const node of mechanisms) {
      const pred = this.predictMechanism(node, power, { inputs })
      if (!pred.known) continue
      const observed = node.state || {}
      const mismatch = Object.entries(pred.expected).filter(([k, v]) => observed[k] !== undefined && observed[k] !== v)
      if (!mismatch.length) continue
      const [prop, expected] = mismatch[0]
      add('high', 'mechanism_mismatch', node,
        `${node.kind} ${prop}=${observed[prop]} but the modelled input power is ${pred.inPower} (${pred.reasons.join(', ') || 'no input'}), so it is expected to be ${prop}=${expected} — check the power actually reaching this block (a gap, a wrong-facing repeater, or a component the client cannot see)`,
        `expected ${JSON.stringify(pred.expected)} observed ${JSON.stringify(observed)}`)
    }

    // Repeater/comparator orientation: they read their REAR only.
    for (const node of this.nodes) {
      if (node.kind !== 'repeater' && node.kind !== 'comparator') continue
      const s = node.state || {}
      if (!s.facing) {
        add('medium', 'orientation_unknown', node, `${node.kind} orientation was not reported by the client, so its input/output direction is unknown`, 'missing facing property')
        continue
      }
      const backV = DIRS[s.facing]
      const frontV = DIRS[OPP[s.facing]]
      const rearNode = backV ? this.nodeAt(node.x + backV.x, node.y, node.z + backV.z) : null
      const frontNode = frontV ? this.nodeAt(node.x + frontV.x, node.y, node.z + frontV.z) : null
      const rearPower = this.inputPower(node, power, { inputs })
      const frontPower = frontNode ? this._powerOfNode(frontNode, power) : 0
      const sidePower = []
      for (const d of HORIZ) {
        if (d === s.facing || d === OPP[s.facing]) continue
        const v = DIRS[d]
        const n = this.nodeAt(node.x + v.x, node.y, node.z + v.z)
        const p = n ? this._powerOfNode(n, power) : 0
        if (p !== null && p > 0) sidePower.push(`${d}(${n.kind} ${p})`)
      }
      if ((rearPower || 0) === 0 && sidePower.length) {
        add('high', 'repeater_wrong_facing', node,
          `${node.kind} reads its rear at ${s.facing} (${node.x + backV.x},${node.y},${node.z + backV.z}) which is cold, but signal is arriving from the side (${sidePower.join(', ')}) — a ${node.kind} only accepts input from its rear, so it is very likely rotated 90°: set facing to the powered side`,
          `rear=${rearPower} sides=${sidePower.join(',')}`)
        continue
      }
      if (rearPower !== null && frontPower !== null && rearPower === 0 && frontPower > 0) {
        add('high', 'repeater_reversed', node,
          `${node.kind} faces ${s.facing} (input at ${node.x + backV.x},${node.y},${node.z + backV.z}), but power is arriving on its OUTPUT side — it is very likely placed backwards`,
          `rear=${rearPower} front=${frontPower}`)
      }
      if (node.kind === 'repeater' && s.locked === true) {
        add('medium', 'repeater_locked', node, 'repeater is locked by a powered side comparator/repeater and will not change state until the side lock is released', 'locked=true')
      }
      if (node.kind === 'repeater' && Number.isFinite(s.delay)) {
        add('info', 'repeater_delay', node, `repeater delay is ${s.delay} redstone tick(s) = ${s.delay * 2} game ticks (${(s.delay * 0.1).toFixed(1)} s) — timing-sensitive circuits depend on this`, `delay=${s.delay}`)
      }
      if (node.kind === 'comparator') {
        const mode = s.mode || 'compare'
        add('info', 'comparator_mode', node, `comparator is in ${mode} mode${mode === 'subtract' ? ' (outputs rear − max(side), floored at 0)' : ' (outputs rear only when rear ≥ sides)'}`, `mode=${mode}`)
      }
    }

    // Mechanisms with no reachable source at all.
    for (const node of mechanisms) {
      const pred = this.predictMechanism(node, power, { inputs })
      if (pred.known && !pred.activate) {
        add('info', 'mechanism_unpowered', node, `${node.kind} has no modelled input power`, 'all neighbour inputs read 0')
      }
    }

    // Loop / clock detection: a cycle through signal carriers.
    const cycles = this._findCycles()
    for (const c of cycles.slice(0, 4)) {
      const hasTorch = c.some((id) => this.byPos.get(id)?.kind === 'torch')
      const hasRepeater = c.some((id) => ['repeater', 'comparator'].includes(this.byPos.get(id)?.kind))
      add('info', 'feedback_loop', this.byPos.get(c[0]) || null,
        `feedback loop of ${c.length} components${hasRepeater ? ' with a delay element' : ''}${hasTorch ? ' and a torch inverter' : ''} — ${hasRepeater ? 'this is how a clock/oscillator is built; its period depends on the repeater delays' : (hasTorch ? 'a torch-only loop burns the torch out (it cannot flip faster than once per 2 game ticks)' : 'with no inverter and no delay element the loop settles instead of oscillating')}`,
        c.join(' → '))
    }
    if (cycles.some((c) => c.every((id) => this.byPos.get(id)?.kind !== 'torch' && !['repeater', 'comparator'].includes(this.byPos.get(id)?.kind)))) {
      add('low', 'torchless_loop', this.byPos.get(cycles[0][0]) || null,
        'a feedback loop with neither an inverter nor a delay cannot oscillate in Java: dust alone always resolves to a single stable value', 'dust-only cycle')
    }

    // Vertical dust stack: a column never conducts.
    for (const node of this.nodes) {
      if (node.kind !== 'dust') continue
      const below = this.nodeAt(node.x, node.y - 1, node.z)
      if (below && below.kind === 'dust') {
        add('info', 'vertical_dust_stack', node, 'dust stacked vertically: a straight column does NOT conduct; use a stair step (side=up) on a solid block', 'dust directly beneath')
      }
    }
    return findings
  }
