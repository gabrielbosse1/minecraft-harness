/**
 * custom_mineflayer/escape.js — where to run, with the walls and the clock
 * taken into account.
 *
 * The old flee picked a point 14 blocks "away" and asked A* for a route. A
 * point is not a plan: in a dead-end corridor "away" is behind the wall, and
 * the cheapest route to it went straight through the zombies. On a cliff
 * edge it ended on the edge.
 *
 * This planner floods the ground the bot can actually walk (the pathfinder's
 * own neighbour generator: steps, drops, doors, no digging) and, for every
 * cell, compares two clocks:
 *
 *     when the bot gets there    route cost / running speed
 *     when a mob could be there  straight line / that mob's speed
 *
 * A cell is SAFE when the bot arrives first with a margin. The flood only
 * continues through safe cells, so a safe cell always has a safe way to it.
 * The destination is the safe cell with the most time in hand that still
 * LEADS OUT (its branch reaches the edge of the search) — a pocket with no
 * exit is used only when there is nothing better, and reported as cornered.
 *
 * A pocket is made of walls. Safe ground also "ends" on an open field when
 * the pursuer is as fast as the bot (a player): far cells are lost to the
 * clock, not to terrain. If the edge of the search can be reached without
 * ever coming closer to a pursuer than the bot is now, that is being chased,
 * not cornered (a real server showed the difference: one player on a flat
 * world was reported as "the only safe ground is a dead end").
 *
 * The mob clock deliberately ignores walls (a straight line is the fastest a
 * mob could ever be), so every error is on the safe side.
 *
 * Pure: reads blocks through `movements`, touches no controls, no timers.
 *
 * The search is bounded by `maxNodes`, not by elapsed wall time by default.
 * A wall-clock cutoff made the explored edge depend on server load; the
 * unfinished cells were then mistaken for exits, so the same flee could pick
 * a different destination on each refresh. Callers can still opt into a
 * positive `budgetMs` for a best-effort partial search.
 */
'use strict'

/** A tiny binary heap ordered by `key`. */
class Heap {
  constructor () { this.a = [] }
  get size () { return this.a.length }
  push (item) {
    const a = this.a
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].key <= a[i].key) break
      const t = a[p]; a[p] = a[i]; a[i] = t
      i = p
    }
  }

  pop () {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1; const r = l + 1
        let m = i
        if (l < a.length && a[l].key < a[m].key) m = l
        if (r < a.length && a[r].key < a[m].key) m = r
        if (m === i) break
        const t = a[m]; a[m] = a[i]; a[i] = t
        i = m
      }
    }
    return top
  }
}

/**
 * @typedef {{ x:number, y:number, z:number, speed:number, reach:number, name?:string }} Pursuer
 *   speed in blocks/second; reach = how close it must get to hurt (melee ~1.6,
 *   a creeper ~4.5, an archer ~10).
 */

/** Seconds until the first pursuer could be at (x, y, z). */
function mobClock (pursuers, x, y, z) {
  let best = Infinity
  for (const m of pursuers) {
    const d = Math.hypot(m.x - x, (m.y - y) * 0.5, m.z - z)
    const t = Math.max(0, d - m.reach) / m.speed
    if (t < best) best = t
  }
  return best
}

/** Blocks to the nearest pursuer from (x, y, z). */
function nearestPursuer (pursuers, x, y, z) {
  let best = Infinity
  for (const m of pursuers) {
    const d = Math.hypot(m.x - x, (m.y - y) * 0.5, m.z - z)
    if (d < best) best = d
  }
  return best
}

/**
 * WHERE the safe ground is matters as much as whether it is safe. A live run
 * showed a bot that outran every zombie and still died four times: it ran to
 * the cell with the most seconds in hand, which was a ledge on a mountainside
 * or a notch between two walls, with other mobs standing next to it — and the
 * next escape started from there with nowhere left to go.
 *
 * So, among cells the clock calls safe, the planner now also asks:
 *
 *   open     how much level, walkable ground is around the cell (5x5)
 *   crowd    hostile mobs that are NOT chasing yet but would notice it there
 *   sector   what the land looks like further out that way (surveyGround):
 *            level and empty, or broken, steep and full of mobs
 *   heading  keep the way it was already running (no doubling back into
 *            the ones that follow)
 *
 * and the way there pays for every cell that passes inside the notice range
 * of a mob that is not chasing. The clock still decides what is safe; these
 * decide which safe place.
 */

/** Hostiles that are not chasing: cost of passing/standing at (x, y, z). 0 = nobody would notice. */
function crowdAt (crowd, x, y, z) {
  let c = 0
  for (const m of crowd) {
    const notice = m.notice || 12
    const d = Math.hypot(m.x - x, (m.y - y) * 0.5, m.z - z)
    if (d < notice) c += (notice - d) / notice
  }
  return c
}

/** A per-plan cache of "can a body stand at x, y, z" straight from the blocks. */
function standableCache (bot) {
  if (!bot || typeof bot.blockAt !== 'function') return null
  const cache = new Map()
  const HAZARD = /lava|fire|magma|cactus|sweet_berry|powder_snow|wither_rose|campfire/
  const at = (x, y, z) => { try { return bot.blockAt({ x, y, z }, false) } catch { return null } }
  const solid = (b) => Boolean(b) && b.boundingBox === 'block'
  return (x, y, z) => {
    const key = x + ',' + y + ',' + z
    let v = cache.get(key)
    if (v !== undefined) return v
    const below = at(x, y - 1, z); const feet = at(x, y, z); const head = at(x, y + 1, z)
    if (!below || !feet || !head) v = null // unloaded: unknown
    else v = solid(below) && !HAZARD.test(below.name) && !solid(feet) && !solid(head) && !/water|lava/.test(feet.name) && !HAZARD.test(feet.name)
    cache.set(key, v)
    return v
  }
}

/**
 * How open and level the ground around a cell is, 0..1: the share of the 24
 * columns around it (5x5) where a body can stand at the same height (the
 * outer ring may be one step up or down). A plain is 1, a corridor ~0.35,
 * a corner or a ledge less.
 */
function openness (standable, x, y, z) {
  if (!standable) return null
  let ok = 0; let known = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      const here = standable(x + dx, y, z + dz)
      if (here === null) continue
      known++
      if (here) { ok++; continue }
      if (Math.max(Math.abs(dx), Math.abs(dz)) === 2 && (standable(x + dx, y + 1, z + dz) || standable(x + dx, y - 1, z + dz))) ok += 0.6
    }
  }
  return known >= 8 ? ok / 24 : null
}

/**
 * Look further than the flood can: sample the surface along `dirs` headings
 * out to `range` blocks and say which way the land is level and empty.
 *
 * @param {object} bot
 * @param {{ range?:number, dirs?:number, step?:number, mobs?:Array<{x:number,y:number,z:number}> }} [opts]
 *        mobs: every hostile around, chasing or not
 * @returns {null | Array<{ x:number, z:number, score:number, rough:number, mobs:number, blocked:boolean, known:number }>}
 *        score 1 = level, empty ground as far as it was looked at; -1 = cliffs, lava or a crowd
 */
function surveyGround (bot, opts = {}) {
  const pos = bot?.entity?.position
  if (!pos || typeof bot.blockAt !== 'function') return null
  const range = opts.range ?? 48
  const dirs = opts.dirs ?? 16
  const step = opts.step ?? 4
  const mobs = Array.isArray(opts.mobs) ? opts.mobs : []
  const at = (x, y, z) => { try { return bot.blockAt({ x: Math.floor(x), y, z: Math.floor(z) }, false) } catch { return null } }
  const solid = (b) => Boolean(b) && b.boundingBox === 'block'
  const y0 = Math.floor(pos.y + 0.01)
  const out = []
  for (let i = 0; i < dirs; i++) {
    const a = (i / dirs) * 2 * Math.PI
    const ux = Math.cos(a); const uz = Math.sin(a)
    let y = y0
    let climb = 0; let samples = 0; let blocked = false; let wet = 0; let lava = false
    for (let r = step; r <= range; r += step) {
      const x = pos.x + ux * r; const z = pos.z + uz * r
      let feet = at(x, y, z)
      if (!feet) break // not loaded: nothing known past here
      let ny = y
      let found = false
      if (solid(feet)) {
        for (let k = 1; k <= 5; k++) { const b = at(x, y + k, z); if (!b) break; if (!solid(b)) { ny = y + k; feet = b; found = true; break } }
      } else {
        for (let k = 0; k <= 6; k++) { const b = at(x, y - 1 - k, z); if (!b) break; if (solid(b) || /water|lava/.test(b.name)) { ny = y - k; found = true; if (/lava/.test(b.name)) lava = true; if (/water/.test(b.name)) wet++; break } }
      }
      if (!found) { blocked = true; break } // a wall or a drop no one walks
      if (/lava/.test(feet.name)) lava = true
      if (/water/.test(feet.name)) wet++
      const dy = Math.abs(ny - y)
      climb += dy <= 1 ? dy : dy * 2 // a step is walked; more than that is climbed or fallen
      y = ny
      samples++
    }
    const rough = samples ? climb / samples : 0 // blocks of up/down per `step` blocks walked
    let crowd = 0
    for (const m of mobs) {
      const dx = m.x - pos.x; const dz = m.z - pos.z
      const d = Math.hypot(dx, dz)
      if (d < 1 || d > range) continue
      const cos = (dx * ux + dz * uz) / d
      if (cos > 0.8) crowd += (1 - d / range) * (cos > 0.95 ? 1 : 0.6)
    }
    const reach = samples * step / range // how far that way is known, walkable ground
    let score = 1 - rough * 0.7 - crowd * 0.5 - (wet / Math.max(1, samples)) * 0.6
    if (blocked) score -= 0.9 * (1 - reach)
    if (lava) score -= 1
    if (!samples && !blocked) score = 0 // nothing known: neither good nor bad
    out.push({ x: ux, z: uz, score: Math.max(-1, Math.min(1, score)), rough, mobs: crowd, blocked, known: samples })
  }
  // A good heading between two bad ones is a ridge or a gap, not a plain.
  const smooth = out.map((s, i) => 0.5 * s.score + 0.25 * out[(i + 1) % dirs].score + 0.25 * out[(i + dirs - 1) % dirs].score)
  for (let i = 0; i < dirs; i++) out[i].score = smooth[i]
  return out
}

/** The survey's opinion (-1..1) of the heading (dx, dz). */
function sectorScore (sectors, dx, dz) {
  if (!sectors?.length) return 0
  const len = Math.hypot(dx, dz)
  if (len < 0.5) return 0
  let best = 0; let bestCos = -Infinity
  for (const s of sectors) {
    const cos = (dx * s.x + dz * s.z) / len
    if (cos > bestCos) { bestCos = cos; best = s.score }
  }
  return best
}

/**
 * @param {object} bot
 * @param {object} movements a Movements instance WITHOUT threat costs (pure geometry)
 * @param {Pursuer[]} pursuers
 * @param {{ radius?:number, maxNodes?:number, budgetMs?:number, botSpeed?:number,
 *           minMargin?:number, graceSec?:number, minRun?:number,
 *           avoid?:(x:number,y:number,z:number)=>number, now?:()=>number }} [opts]
 *           `budgetMs` defaults to 0 (deterministic node cap only); a positive
 *           value enables a best-effort wall-clock cutoff.
 * @returns {null | { target:{x:number,y:number,z:number}, path:Array<{x:number,y:number,z:number}>,
 *   direction:{x:number,z:number}, margin:number, safe:boolean, leadsOut:boolean,
 *   cornered:boolean, why:string, explored:number, safeCells:number, ms:number }}
 *   why: open (safe ground that leads out) | pocket (safe, but walled in: a dead end) |
 *        chased (the ground goes on, but the pursuer is too close or as fast as the bot) |
 *        surrounded (no safe cell, pursuers on most sides) |
 *        trapped (no safe cell and the ground ends: shut in with them) |
 *        stuck (cannot move at all)
 */
function planEscape (bot, movements, pursuers, opts = {}) {
  const pos = bot?.entity?.position
  if (!pos || !movements || typeof movements.getNeighbors !== 'function' || !pursuers?.length) return null
  const radius = opts.radius ?? 18
  const maxNodes = opts.maxNodes ?? 700
  const budgetMs = opts.budgetMs ?? 0
  const timeLimited = Number.isFinite(budgetMs) && budgetMs > 0
  const botSpeed = opts.botSpeed ?? 5.4
  const minMargin = opts.minMargin ?? 0.4
  const graceSec = opts.graceSec ?? 0.55
  const minRun = opts.minRun ?? 5
  const baseAvoid = typeof opts.avoid === 'function' ? opts.avoid : null
  // Ground quality (see the note above crowdAt). All of it is optional: with
  // no `crowd`, no `sectors` and `terrain: false` this is the clock alone.
  const crowd = Array.isArray(opts.crowd) ? opts.crowd : []
  const sectors = Array.isArray(opts.sectors) && opts.sectors.length ? opts.sectors : null
  const heading = opts.heading && Number.isFinite(opts.heading.x) && Number.isFinite(opts.heading.z) ? opts.heading : null
  const standable = opts.terrain === false ? null : standableCache(bot)
  const maxDrop = opts.maxDrop ?? 3 // a longer fall costs health the escape needs
  const avoid = (baseAvoid || crowd.length)
    ? (x, y, z) => (baseAvoid ? baseAvoid(x, y, z) : 0) + (crowd.length ? crowdAt(crowd, x + 0.5, y, z + 0.5) * 5 : 0)
    : null
  // `toward`: somewhere the body has business (the player it follows, the
  // place it was walking to). Among cells that are equally safe, prefer the
  // ones that do not carry it further from there — a dodge, not a retreat.
  const toward = opts.toward && Number.isFinite(opts.toward.x) && Number.isFinite(opts.toward.z) ? opts.toward : null
  const towardFrom = toward ? Math.hypot(toward.x - pos.x, toward.z - pos.z) : 0
  const towardBonus = (node) => {
    if (!toward) return 0
    const gain = towardFrom - Math.hypot(toward.x - (node.x + 0.5), toward.z - (node.z + 0.5))
    return Math.max(-5, Math.min(5, gain * 0.4))
  }
  const clock = typeof opts.now === 'function' ? opts.now : () => performance.now()
  const started = clock()
  /** What the ground at a cell is worth, on top of the seconds in hand there (about -9..+9). */
  const groundBonus = (node) => {
    let b = 0
    const open = openness(standable, node.x, node.y, node.z)
    node.open = open
    if (open !== null) b += (open - 0.5) * 8
    if (crowd.length) { node.crowd = crowdAt(crowd, node.x + 0.5, node.y, node.z + 0.5); b -= Math.min(6, node.crowd * 3) }
    const dx = node.x + 0.5 - pos.x; const dz = node.z + 0.5 - pos.z
    const len = Math.hypot(dx, dz)
    if (sectors) b += sectorScore(sectors, dx, dz) * 3
    if (heading && len > 2) b += ((dx * heading.x + dz * heading.z) / len) * 1.2
    return b
  }

  const sx = Math.floor(pos.x); const sy = Math.floor(pos.y); const sz = Math.floor(pos.z)
  const keyOf = (x, y, z) => x + ',' + y + ',' + z
  /** key -> { x, y, z, g, parent, safe, via, margin, tm, near, frontier, leadsOut, closed } */
  const nodes = new Map()
  const open = new Heap()
  const start = { x: sx, y: sy, z: sz, g: 0, parent: null, via: false, closed: false, frontier: false, leadsOut: false }
  start.tm = mobClock(pursuers, sx + 0.5, sy, sz + 0.5)
  // The closest the way to a cell ever comes to a pursuer (see runsOn below).
  start.near = nearestPursuer(pursuers, sx + 0.5, sy, sz + 0.5)
  start.margin = start.tm
  start.safe = start.margin >= minMargin
  nodes.set(keyOf(sx, sy, sz), start)
  open.push({ key: 0, node: start })
  let explored = 0
  let cutShort = false

  while (open.size) {
    if (explored >= maxNodes || (timeLimited && explored % 16 === 0 && clock() - started > budgetMs)) { cutShort = true; break }
    const { node } = open.pop()
    if (node.closed) continue
    node.closed = true
    explored++
    const flat = Math.hypot(node.x - sx, node.z - sz)
    if (flat >= radius - 1) { node.frontier = true; continue }
    // A cell the bot cannot reach in time is a place to be caught, not a way through —
    // except right at the start, where it has to move whatever the clock says, and
    // while every step makes things better (running straight away from something
    // that is already too close: the first cells are "unsafe", the way is right).
    const improving = !node.via && node.parent !== null && node.margin > node.parent.margin + 1e-6
    const through = node.safe || improving || node.g / botSpeed <= graceSec
    let neighbors = []
    try { neighbors = movements.getNeighbors({ x: node.x, y: node.y, z: node.z, remainingBlocks: 0 }) } catch { neighbors = [] }
    for (const n of neighbors) {
      if (n.toBreak?.length || n.toPlace?.length) continue // running, not building
      if (node.y - n.y > maxDrop) continue // not off a cliff
      const step = Math.max(0.5, Number(n.cost) || 1) + (avoid ? avoid(n.x, n.y, n.z) : 0)
      const g = node.g + step
      const via = node.via || !through
      const key = keyOf(n.x, n.y, n.z)
      const seen = nodes.get(key)
      if (seen && (seen.closed || (seen.via === via ? seen.g <= g : !seen.via))) continue
      const tm = mobClock(pursuers, n.x + 0.5, n.y, n.z + 0.5)
      const margin = tm - g / botSpeed
      const near = Math.min(node.near, nearestPursuer(pursuers, n.x + 0.5, n.y, n.z + 0.5))
      const next = { x: n.x, y: n.y, z: n.z, g, parent: node, via, closed: false, frontier: false, leadsOut: false, tm, margin, near, safe: !via && margin >= minMargin }
      nodes.set(key, next)
      open.push({ key: g + (via ? 1e6 : 0), node: next })
    }
  }
  // Cells still waiting at the configured search limit: reachable, with unexplored ground beyond.
  if (cutShort) for (const { node } of open.a) if (!node.closed && node.safe) node.frontier = true

  // A cell leads out when its branch reaches the edge of the search safely.
  for (const node of nodes.values()) {
    if (!node.frontier || !node.safe) continue
    for (let n = node; n && !n.leadsOut; n = n.parent) n.leadsOut = true
  }

  let best = null
  let bestScore = -Infinity
  let safeCells = 0
  const consider = (node, score) => { if (score > bestScore) { bestScore = score; best = node } }
  // A. Safe ground far enough to be worth running to, preferably ground that leads out.
  for (const node of nodes.values()) {
    if (!node.safe) continue
    safeCells++
    if (node.g < minRun) continue
    // Time in hand on arrival, capped so "far enough" does not always mean "as far as possible".
    consider(node, Math.min(node.margin, 12) + (node.leadsOut ? 6 : 0) + Math.min(node.g, 16) * 0.05 + towardBonus(node) + groundBonus(node))
  }
  let why = best ? (best.leadsOut ? 'open' : 'pocket') : ''
  let chased = false
  if (!best && safeCells) {
    // B. Only a few safe cells, right here: a pocket. Take the one that buys the
    //    most time (that may be where the bot already stands) and say so — the
    //    model gets those seconds to decide.
    for (const node of nodes.values()) if (node.safe) consider(node, node.margin + (node.leadsOut ? 6 : 0) + groundBonus(node) * 0.5)
    why = best.leadsOut ? 'open' : 'pocket'
  }
  if (best && why === 'pocket') {
    // Walls make a dead end; a pursuer that keeps up does not. Does the ground
    // go on — to the edge of the search, or past where the budget stopped it —
    // by a way that never comes closer to any of them than the bot is now?
    // Then nothing shuts the bot in: it is being chased, and C picks the run.
    let runsOn = false
    for (const node of nodes.values()) {
      if ((node.frontier || (cutShort && !node.closed)) && node.near >= start.near - 1.5) { runsOn = true; break }
    }
    if (runsOn) best = null
  }
  if (!best) {
    // C. Nothing is safe, not even here. Go where the mobs get last, by the way
    //    that touches the fewest of them — and say what kind of fix this is:
    //      surrounded  pursuers on most sides
    //      chased      the ground goes on: one that is too close or as fast as the bot
    //      trapped     the ground ends: shut in with them
    //    Judged from the pursuers and the map, never from how far a budget got.
    let reachedEdge = cutShort && open.size > 0
    if (!reachedEdge) for (const node of nodes.values()) if (node.frontier) { reachedEdge = true; break }
    best = breakOut(movements, pursuers, { sx, sy, sz, radius, maxNodes, budgetMs, avoid, clock, maxDrop, groundBonus })
    if (best) {
      if (encircled(pursuers, pos)) why = 'surrounded'
      else if (reachedEdge) { why = 'chased'; chased = true } else why = 'trapped'
      best.safe = false
      best.leadsOut = false
      best.margin = mobClock(pursuers, best.x + 0.5, best.y, best.z + 0.5) - best.g / botSpeed
    } else why = 'stuck'
  }
  if (!best) {
    return { target: { x: sx, y: sy, z: sz }, path: [], direction: null, margin: start.margin, safe: false, leadsOut: false, cornered: true, why: 'stuck', explored, safeCells, ms: clock() - started }
  }
  const path = []
  for (let n = best; n; n = n.parent) path.push({ x: n.x, y: n.y, z: n.z })
  path.reverse()
  const ahead = path[Math.min(path.length - 1, 3)]
  const dx = ahead.x + 0.5 - pos.x; const dz = ahead.z + 0.5 - pos.z
  const len = Math.hypot(dx, dz)
  return {
    target: { x: best.x, y: best.y, z: best.z },
    path,
    direction: len > 0.05 ? { x: dx / len, z: dz / len } : null,
    margin: best.margin,
    open: best.open ?? openness(standable, best.x, best.y, best.z),
    crowd: crowd.length ? crowdAt(crowd, best.x + 0.5, best.y, best.z + 0.5) : 0,
    safe: best.safe,
    leadsOut: best.leadsOut || chased,
    cornered: !best.leadsOut && !chased,
    why,
    explored,
    safeCells,
    ms: clock() - started
  }
}

/** How much of a mob's reach a point is inside (0 = clear; summed over the mobs around it). */
function contact (pursuers, x, y, z) {
  let c = 0
  for (const m of pursuers) {
    const edge = m.reach + 2
    const d = Math.hypot(m.x - x, (m.y - y) * 0.5, m.z - z)
    if (d < edge) c += (edge - d) / edge
  }
  return c
}

/**
 * The desperate plan: nothing is safe, so find where the mobs get last and
 * the way there that brushes the fewest of them (through the widest gap of a
 * ring, not through a zombie). A second, smaller flood whose step cost is
 * distance plus contact.
 * @returns {object|null} the destination node ({ x, y, z, g, parent })
 */
function breakOut (movements, pursuers, { sx, sy, sz, radius, maxNodes, budgetMs, avoid, clock, maxDrop = 3, groundBonus = null }) {
  const timeLimited = Number.isFinite(budgetMs) && budgetMs > 0
  const keyOf = (x, y, z) => x + ',' + y + ',' + z
  const seen = new Map()
  const heap = new Heap()
  const root = { x: sx, y: sy, z: sz, cost: 0, g: 0, parent: null, closed: false }
  seen.set(keyOf(sx, sy, sz), root)
  heap.push({ key: 0, node: root })
  const started = clock()
  let count = 0
  let top = null
  let topScore = -Infinity
  while (heap.size) {
    if (count >= maxNodes || (timeLimited && count % 16 === 0 && clock() - started > budgetMs)) break
    const { node } = heap.pop()
    if (node.closed) continue
    node.closed = true
    count++
    const edge = Math.hypot(node.x - sx, node.z - sz) >= radius - 2
    // Seconds until a mob could be there, a bonus for ground that goes on, minus
    // the distance. Contact on the way only breaks ties: it is already what
    // chose the route, and standing still among them is contact without end.
    const score = Math.min(mobClock(pursuers, node.x + 0.5, node.y, node.z + 0.5), 10) * 2 + (edge ? 6 : 0) - node.g * 0.1 - Math.min(node.cost - node.g, 60) * 0.05 + (groundBonus && node.g >= 3 ? groundBonus(node) * 0.6 : 0)
    if (score > topScore) { topScore = score; top = node }
    if (Math.hypot(node.x - sx, node.z - sz) >= radius - 1) continue
    let neighbors = []
    try { neighbors = movements.getNeighbors({ x: node.x, y: node.y, z: node.z, remainingBlocks: 0 }) } catch { neighbors = [] }
    for (const n of neighbors) {
      if (n.toBreak?.length || n.toPlace?.length) continue
      if (node.y - n.y > maxDrop) continue
      const step = Math.max(0.5, Number(n.cost) || 1) + (avoid ? avoid(n.x, n.y, n.z) : 0)
      const cost = node.cost + step + contact(pursuers, n.x + 0.5, n.y, n.z + 0.5) * 14
      const key = keyOf(n.x, n.y, n.z)
      const old = seen.get(key)
      if (old && (old.closed || old.cost <= cost)) continue
      const next = { x: n.x, y: n.y, z: n.z, cost, g: node.g + step, parent: node, closed: false }
      seen.set(key, next)
      heap.push({ key: cost, node: next })
    }
  }
  return top
}

/** Are there pursuers within 12 blocks on most sides (no gap of 120° between them)? */
function encircled (pursuers, pos, { within = 12, minGap = 2.1 } = {}) {
  const angles = []
  for (const m of pursuers) {
    const dx = m.x - pos.x
    const dz = m.z - pos.z
    if (Math.hypot(dx, dz) <= within) angles.push(Math.atan2(dz, dx))
  }
  if (angles.length < 3) return false
  angles.sort((a, b) => a - b)
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1]
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1])
  return gap < minGap
}

/**
 * Is there ground to run on along `dir` for the next `blocks` blocks? Used by
 * the straight-sprint fallback, which has no route: no wall in the face, no
 * drop of more than three blocks, no lava or fire underfoot.
 */
function clearToRun (bot, dir, { blocks = 3, maxDrop = 3 } = {}) {
  const pos = bot?.entity?.position
  if (!pos || !dir || !bot.blockAt) return true
  const HAZARD = /lava|fire|magma|cactus|sweet_berry|powder_snow|wither_rose|campfire/
  let y = Math.floor(pos.y + 0.01)
  const at = (x, yy, z) => { try { return bot.blockAt({ x: Math.floor(x), y: yy, z: Math.floor(z) }, false) } catch { return null } }
  const solid = (b) => Boolean(b) && b.boundingBox === 'block'
  for (let i = 1; i <= blocks; i++) {
    const x = pos.x + dir.x * i; const z = pos.z + dir.z * i
    const feet = at(x, y, z); const head = at(x, y + 1, z)
    if (!feet || !head) return true // unloaded: no evidence against it
    if (HAZARD.test(feet.name) || HAZARD.test(head.name)) return false
    if (solid(feet)) {
      // One block up is a jump; two is a wall.
      const above = at(x, y + 2, z)
      if (solid(head) || solid(above)) return false
      y += 1
      continue
    }
    if (solid(head)) return false
    let drop = 0
    let floor = at(x, y - 1, z)
    while (floor && !solid(floor) && drop <= maxDrop) {
      if (HAZARD.test(floor.name)) return false
      if (floor.name === 'water') break
      drop++
      floor = at(x, y - 1 - drop, z)
    }
    if (!floor) return true
    if (drop > maxDrop) return false
    if (HAZARD.test(floor.name)) return false
    y -= drop
  }
  return true
}

/**
 * The heading closest to `dir` that has ground to run on, or null when every
 * way is blocked. `opts.maxTurn` (radians) limits how far it may turn from
 * `dir` — a retreat from a creeper must not curve back past the creeper.
 */
function runnableHeading (bot, dir, opts = {}) {
  if (!dir) return null
  const base = Math.atan2(dir.z, dir.x)
  const maxTurn = Number.isFinite(opts.maxTurn) ? opts.maxTurn : Math.PI
  for (const turn of [0, 0.5, -0.5, 1.0, -1.0, 1.57, -1.57, 2.2, -2.2]) {
    if (Math.abs(turn) > maxTurn) continue
    const a = base + turn
    const cand = { x: Math.cos(a), z: Math.sin(a) }
    if (clearToRun(bot, cand, opts)) return cand
  }
  return null
}

module.exports = { planEscape, mobClock, encircled, clearToRun, runnableHeading, surveyGround, sectorScore, openness, standableCache, crowdAt }
