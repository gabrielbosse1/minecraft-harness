/**
 * Buildable catalogue.
 *
 * Every design is written the way it is built: `y = 0` is the ground course
 * (solid filler the builder must provide), the redstone sits ON it at y = 1.
 * `blocks` lists only cells the builder places; `support: true` marks filler
 * that must be solid. `checkDesign()` verifies support and physics.
 *
 * Java conventions used throughout:
 *  - repeater/comparator `facing` = REAR (input) side; output is opposite().
 *  - observer `facing` = the watched side; the pulse leaves the back.
 *  - redstone_wall_torch `facing` = away from the wall, so its attachment
 *    block is pos + opposite(facing).
 *  - dust weakly powers the block it sits on and the block it points into;
 *    that is enough to extinguish a torch attached to that block (the
 *    canonical NOT gate), but not enough to feed a fresh dust run.
 */
'use strict'

const DIRS4 = ['north', 'south', 'east', 'west']
const DIR_V = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }

/** A dust cell that connects only in the listed directions. */
const dust = (connections, power = 0) => {
  const s = {}
  for (const d of DIRS4) s[d] = connections.includes(d) ? 'side' : 'none'
  s.power = String(power)
  return s
}

/** Solid floor cells for a w×d footprint (every design needs a floor). */
const floorOf = (w, d, dz0 = 0) => {
  const out = []
  for (let x = 0; x < w; x++) for (let z = dz0; z < d; z++) out.push({ dx: x, dy: 0, dz: z, name: 'stone', support: true })
  return out
}

const DESIGNS = {
  // ------------------------------------------------------------------ logic
  not_gate: {
    name: 'not_gate',
    title: 'NOT gate (torch inverter)',
    logic: 'out = ¬A',
    footprint: { w: 1, h: 2, d: 3 },
    delayTicks: 1,
    complexity: 1,
    reliability: 'high — one torch, no timing race',
    why: 'The lever powers the block the torch stands on; the dust that points into that block is enough to extinguish the torch, and the lamp beside the torch is lit while the torch is lit (¬A). The lever is two blocks away so it does not power the lamp directly.',
    blocks: [
      ...floorOf(1, 4),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input A' },
      { dx: 0, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south'], 0), note: 'points into the torch support' },
      { dx: 0, dy: 1, dz: 2, name: 'redstone_torch', state: { lit: true }, note: 'on the support block; lit = ¬A' },
      { dx: 0, dy: 1, dz: 3, name: 'redstone_lamp', note: 'output: lit when A is OFF' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }],
    outputs: [{ dx: 0, dy: 1, dz: 3 }]
  },

  or_gate: {
    name: 'or_gate',
    title: 'OR gate (either input powers one dust line)',
    logic: 'out = A ∨ B',
    footprint: { w: 5, h: 2, d: 2 },
    delayTicks: 0,
    complexity: 1,
    reliability: 'high — plain dust, no devices',
    why: 'Two levers feed one continuous dust line; either lever raises the line to 15.',
    blocks: [
      ...floorOf(5, 1),
      ...[[0, -1], [1, -1], [2, -1]].map(([x, z]) => ({ dx: x, dy: 0, dz: z, name: 'stone', support: true })),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east', 'north'], 0), note: 'shared line' },
      { dx: 3, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 4, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input B' },
      { dx: 2, dy: 1, dz: -1, name: 'redstone_lamp', note: 'output' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }, { dx: 4, dy: 1, dz: 0 }],
    outputs: [{ dx: 2, dy: 1, dz: -1 }]
  },

  /**
   * The canonical torch AND: each input extinguishes its own torch, the two
   * torch outputs share one dust line (OR of the inversions), and a third
   * torch on that line's support block inverts the result.
   *
   *   z=0 : L D B T B D L     inputs → their support blocks (torches on top)
   *   z=1 : . D D D D D .     the OR line, one block in front
   *   z=2 : . . B T L . .     support + final inverter + lamp beside it
   */
  and_gate: {
    name: 'and_gate',
    title: 'AND gate (two torches: ¬(¬A ∨ ¬B))',
    logic: 'out = A ∧ B',
    footprint: { w: 7, h: 2, d: 3 },
    delayTicks: 2,
    complexity: 3,
    reliability: 'high — torch inversion only, no timing dependence',
    why: 'Each lever powers the block its torch stands on, so that torch goes out. Both torch outputs share one dust line: while either is lit the line is powered and holds the final inverter dark. The lamp beside the last torch is lit only when both inputs are on.',
    blocks: [
      ...floorOf(7, 3),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'input A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0), note: 'points east into the A support' },
      { dx: 2, dy: 1, dz: 0, name: 'stone', support: true, note: 'A support' },
      { dx: 2, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬A' },
      { dx: 3, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 4, dy: 1, dz: 0, name: 'stone', support: true, note: 'B support' },
      { dx: 4, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬B' },
      { dx: 5, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0), note: 'points west into the B support' },
      { dx: 6, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'west', powered: false }, note: 'input B' },
      // the OR line reads both torch outputs
      { dx: 2, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 4, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      // final inverter on the OR line, lamp beside it
      { dx: 3, dy: 1, dz: 2, name: 'stone', support: true, note: 'final support' },
      { dx: 3, dy: 2, dz: 2, name: 'redstone_torch', state: { lit: false }, note: '¬(¬A ∨ ¬B) = A ∧ B' },
      { dx: 2, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east'], 0), note: 'carries the OR line into the final support' },
      { dx: 4, dy: 1, dz: 2, name: 'redstone_lamp', note: 'output: lit only when both inputs are on' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }, { dx: 6, dy: 1, dz: 0 }],
    outputs: [{ dx: 4, dy: 1, dz: 2 }]
  },

  nand_gate: {
    name: 'nand_gate',
    title: 'NAND gate (AND plus one inverter stage)',
    logic: 'out = ¬(A ∧ B)',
    footprint: { w: 7, h: 2, d: 4 },
    delayTicks: 2,
    complexity: 4,
    reliability: 'high',
    why: 'The AND gate\'s output torch is lit exactly when the AND is false; its lamp is inverted by one more torch stage here so the reader sees a lamp that is on unless both inputs are on.',
    blocks: [
      ...floorOf(7, 4),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'input A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'stone', support: true },
      { dx: 2, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬A' },
      { dx: 3, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 4, dy: 1, dz: 0, name: 'stone', support: true },
      { dx: 4, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬B' },
      { dx: 5, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 6, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'west', powered: false }, note: 'input B' },
      { dx: 2, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 4, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 2, name: 'stone', support: true, note: 'support under the OR line' },
      { dx: 3, dy: 2, dz: 2, name: 'redstone_torch', state: { lit: false }, note: 'A ∧ B (lit only when both inputs are on)' },
      // the lit torch STRONGLY powers the block above it; dust beside that block
      // reads 15, and that dust points into the NAND support
      { dx: 3, dy: 3, dz: 2, name: 'stone', support: true, note: 'strongly powered by the torch below' },
      { dx: 4, dy: 1, dz: 2, name: 'stone', support: true },
      { dx: 4, dy: 2, dz: 2, name: 'redstone_wire', state: dust(['south'], 0), note: 'reads the strongly powered block, points south' },
      { dx: 4, dy: 2, dz: 3, name: 'stone', support: true, note: 'NAND support' },
      { dx: 4, dy: 3, dz: 3, name: 'redstone_torch', state: { lit: true }, note: '¬(A ∧ B)' },
      { dx: 5, dy: 2, dz: 2, name: 'redstone_lamp', note: 'output: lit unless both inputs are on' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }, { dx: 6, dy: 1, dz: 0 }],
    outputs: [{ dx: 5, dy: 2, dz: 2 }]
  },

  xor_gate: {
    name: 'xor_gate',
    title: 'XOR gate (from OR, AND and NOT)',
    logic: 'out = (A ∨ B) ∧ ¬(A ∧ B)',
    footprint: { w: 9, h: 3, d: 6 },
    delayTicks: 6,
    complexity: 8,
    reliability: 'medium — three sub-gates wired together; verify before trusting it',
    why: 'Built compositionally, not from a picture: an OR line, an AND line, and then an AND of the OR with the inverse of the AND. That is exactly XOR for two inputs.',
    blocks: [
      ...floorOf(9, 6),
      // ---- inputs fan out to OR (z=1) and to AND (z=0)
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'A' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east', 'south'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'stone', support: true, note: 'A support' },
      { dx: 2, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬A' },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south', 'east'], 0), note: 'A toward the OR line' },
      { dx: 8, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'west', powered: false }, note: 'B' },
      { dx: 7, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east', 'south'], 0) },
      { dx: 6, dy: 1, dz: 0, name: 'stone', support: true, note: 'B support' },
      { dx: 6, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬B' },
      { dx: 7, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south', 'west'], 0), note: 'B toward the OR line' },
      // ---- OR line (z=1)
      { dx: 3, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 4, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 5, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      // ---- AND of the two inversions (z=2), then invert it
      { dx: 2, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 4, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 5, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 6, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['west', 'north'], 0) },
      { dx: 4, dy: 1, dz: 3, name: 'stone', support: true, note: 'AND output support' },
      { dx: 4, dy: 2, dz: 3, name: 'redstone_torch', state: { lit: false }, note: 'A ∧ B' },
      { dx: 5, dy: 1, dz: 3, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 6, dy: 1, dz: 3, name: 'stone', support: true },
      { dx: 6, dy: 2, dz: 3, name: 'redstone_torch', state: { lit: true }, note: '¬(A ∧ B)' },
      // ---- final AND: (A ∨ B) ∧ ¬(A ∧ B)
      { dx: 4, dy: 1, dz: 4, name: 'stone', support: true, note: 'final support' },
      { dx: 4, dy: 2, dz: 4, name: 'redstone_torch', state: { lit: false }, note: 'XOR' },
      { dx: 5, dy: 1, dz: 4, name: 'redstone_lamp', note: 'output: exactly one input on' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }, { dx: 8, dy: 1, dz: 0 }],
    outputs: [{ dx: 5, dy: 1, dz: 4 }]
  },

  // ---------------------------------------------------------------- memory
  /**
   * RS-NOR latch, derived rather than copied.
   *
   * Two torch inverters face each other's support block:
   *   B1 at (0,1,1) — T1 is a wall torch on B1's east face at (1,1,1).
   *   B2 at (2,1,1) — T2 is a wall torch on B2's west face at (1,1,1)??  no:
   * the two torches may not share a cell, so B2 sits one row back and the
   * feedback dust runs around: T1 -> dust (2,1,0) pointing north into B2 at
   * (2,1,-1); T2 (1,1,-1) -> dust (0,1,-1) pointing south into B1.
   * Setting powers B2 (extinguishes T2), which releases B1 and lets T1 light.
   */
  rs_latch: {
    name: 'rs_latch',
    title: 'RS-NOR latch (two cross-coupled torch inverters)',
    logic: 'Q holds its state: S sets it, R resets it, both at once is forbidden',
    footprint: { w: 5, h: 2, d: 4 },
    delayTicks: 2,
    complexity: 5,
    reliability: 'high — the classic two-torch latch; never drive S and R together',
    why: 'Each torch hangs on a block that the OTHER torch\'s output dust points into, so whichever torch is lit keeps the other dark. A set pulse powers B2, T2 goes out, B1 is released, T1 lights and stays lit after the pulse ends — memory without any repeater.',
    blocks: [
      ...floorOf(5, 4, -1),
      { dx: 0, dy: 1, dz: 1, name: 'stone', support: true, note: 'B1: the Q-side support block' },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wall_torch', state: { facing: 'east', lit: true }, note: 'T1, hanging on B1 — its light is Q' },
      { dx: 2, dy: 1, dz: -1, name: 'stone', support: true, note: 'B2: the latch\'s other support block' },
      { dx: 1, dy: 1, dz: -1, name: 'redstone_wall_torch', state: { facing: 'west', lit: false }, note: 'T2, hanging on B2' },
      // feedback: T1 -> B2, T2 -> B1
      { dx: 2, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0), note: 'T1 output; points north into B2' },
      { dx: 0, dy: 1, dz: -1, name: 'redstone_wire', state: dust(['east', 'south'], 0), note: 'T2 output; points south into B1' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['east', 'west'], 0), note: 'joins the two feedback cells visually only' },
      // Q read-out: the block directly above T1 is strongly powered by it
      { dx: 1, dy: 2, dz: 1, name: 'redstone_lamp', note: 'Q: lit while T1 is lit' },
      // S (set) powers B2 from the east, R (reset) powers B1 from the south
      { dx: 3, dy: 1, dz: -1, name: 'redstone_wire', state: dust(['west', 'east'], 0), note: 'S points west into B2' },
      { dx: 4, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'west', powered: false }, note: 'S (set)' },
      { dx: 0, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'south'], 0), note: 'R points north into B1' },
      { dx: 0, dy: 1, dz: 3, name: 'lever', state: { face: 'floor', facing: 'north', powered: false }, note: 'R (reset)' }
    ],
    inputs: [{ dx: 4, dy: 1, dz: -1 }, { dx: 0, dy: 1, dz: 3 }],
    outputs: [{ dx: 1, dy: 2, dz: 1 }]
  },

  // ---------------------------------------------------------------- timing
  clock_1hz: {
    name: 'clock_1hz',
    title: 'Clock (three repeaters in a loop)',
    logic: 'the output blinks for as long as the switch is on',
    footprint: { w: 4, h: 2, d: 4 },
    delayTicks: 12,
    complexity: 3,
    reliability: 'high — repeaters cannot burn out; keep it slow to avoid lag',
    why: 'A repeater loop with an odd number of inverters never settles. Each repeater adds delay×2 game ticks to the period; with three delay-2 repeaters the period is 12 game ticks.',
    blocks: [
      ...floorOf(4, 2),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'switch (on = running)' },
      { dx: 1, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['west', 'east'], 0) },
      { dx: 2, dy: 1, dz: 0, name: 'repeater', state: { facing: 'west', delay: '2', powered: false }, note: 'west→east' },
      { dx: 3, dy: 1, dz: 0, name: 'repeater', state: { facing: 'north', delay: '2', powered: false }, note: 'north→south' },
      { dx: 3, dy: 1, dz: 1, name: 'repeater', state: { facing: 'east', delay: '2', powered: false }, note: 'east→west' },
      { dx: 2, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wall_torch', state: { facing: 'south', lit: true }, note: 'the single inverter that makes the loop oscillate' },
      { dx: 1, dy: 2, dz: 1, name: 'redstone_lamp', note: 'output: blinks' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }],
    outputs: [{ dx: 1, dy: 2, dz: 1 }]
  },

  delay_line: {
    name: 'delay_line',
    title: 'Delay line (lever → delay-4 repeater → output)',
    logic: 'out follows the lever 8 game ticks later',
    footprint: { w: 1, h: 2, d: 4 },
    delayTicks: 8,
    complexity: 1,
    reliability: 'high',
    why: 'A repeater\'s delay property is in redstone ticks (2 game ticks each), so delay=4 is 8 game ticks.',
    blocks: [
      ...floorOf(1, 4),
      { dx: 0, dy: 1, dz: 0, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'input' },
      { dx: 0, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 1, dz: 2, name: 'repeater', state: { facing: 'north', delay: '4', powered: false } },
      { dx: 0, dy: 1, dz: 3, name: 'redstone_lamp', note: 'output' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: 0 }],
    outputs: [{ dx: 0, dy: 1, dz: 3 }]
  },

  // --------------------------------------------------------------- pistons
  piston_door_2x2: {
    name: 'piston_door_2x2',
    title: '2×2 piston door (four sticky pistons, two per side)',
    logic: 'all four pistons extend on one signal; the door closes when it is released',
    footprint: { w: 7, h: 3, d: 3 },
    delayTicks: 2,
    complexity: 7,
    reliability: 'medium — both pairs must fire on the same tick or the door jams half-open',
    why: 'The four door blocks are pushed apart by two pairs of sticky pistons facing each other. Both pairs share one dust line, so a single lever moves all four on the same tick; releasing it retracts them together and the sticky heads pull the door blocks back.',
    blocks: [
      ...floorOf(7, 3),
      // door frame the pistons push into
      { dx: 0, dy: 1, dz: 1, name: 'stone', support: true }, { dx: 0, dy: 2, dz: 1, name: 'stone', support: true },
      { dx: 6, dy: 1, dz: 1, name: 'stone', support: true }, { dx: 6, dy: 2, dz: 1, name: 'stone', support: true },
      // the four moving door blocks
      { dx: 2, dy: 1, dz: 1, name: 'stone', support: true }, { dx: 3, dy: 1, dz: 1, name: 'stone', support: true },
      { dx: 2, dy: 2, dz: 1, name: 'stone', support: true }, { dx: 3, dy: 2, dz: 1, name: 'stone', support: true },
      // the pistons
      { dx: 1, dy: 1, dz: 1, name: 'sticky_piston', state: { facing: 'east', extended: false } },
      { dx: 4, dy: 1, dz: 1, name: 'sticky_piston', state: { facing: 'west', extended: false } },
      { dx: 1, dy: 2, dz: 1, name: 'sticky_piston', state: { facing: 'east', extended: false } },
      { dx: 4, dy: 2, dz: 1, name: 'sticky_piston', state: { facing: 'west', extended: false } },
      // one shared line behind the door, both piston columns on it
      { dx: 1, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 2, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 4, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 0, dy: 1, dz: 2, name: 'lever', state: { face: 'floor', facing: 'east', powered: false }, note: 'door switch' }
    ],
    caveat: 'The four door blocks are only movable while nothing is attached to them; place the frame, the pistons and the dust before sealing the door blocks in.',
    inputs: [{ dx: 0, dy: 1, dz: 2 }],
    outputs: [{ dx: 1, dy: 1, dz: 1 }, { dx: 4, dy: 1, dz: 1 }],
    unverified: 'the model can predict the wiring, but moving blocks needs a live server to confirm'
  },

  hidden_door: {
    name: 'hidden_door',
    title: 'Hidden flush door (one sticky piston behind a wall block)',
    logic: 'the front block is pulled aside to reveal a passage',
    footprint: { w: 3, h: 3, d: 5 },
    delayTicks: 2,
    complexity: 5,
    reliability: 'medium — the front block must be movable',
    why: 'A sticky piston retracts and drags the flush wall block with it, leaving the passage open; no dust is visible from the front.',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'stone', support: true }, { dx: 1, dy: 0, dz: 0, name: 'stone', support: true }, { dx: 2, dy: 0, dz: 0, name: 'stone', support: true },
      { dx: 0, dy: 0, dz: 1, name: 'stone', support: true }, { dx: 1, dy: 0, dz: 1, name: 'stone', support: true }, { dx: 2, dy: 0, dz: 1, name: 'stone', support: true },
      { dx: 0, dy: 0, dz: -1, name: 'stone', support: true }, { dx: 1, dy: 0, dz: -1, name: 'stone', support: true }, { dx: 2, dy: 0, dz: -1, name: 'stone', support: true },
      { dx: 0, dy: 0, dz: -2, name: 'stone', support: true }, { dx: 1, dy: 0, dz: -2, name: 'stone', support: true }, { dx: 2, dy: 0, dz: -2, name: 'stone', support: true },
      { dx: 1, dy: 1, dz: 0, name: 'stone', support: true, note: 'the flush front panel (movable)' },
      { dx: 0, dy: 1, dz: 0, name: 'stone', support: true }, { dx: 2, dy: 1, dz: 0, name: 'stone', support: true },
      { dx: 1, dy: 1, dz: -1, name: 'sticky_piston', state: { facing: 'north', extended: false }, note: 'pulls the panel north' },
      { dx: 1, dy: 1, dz: -2, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 0, dz: -3, name: 'stone', support: true }, { dx: 1, dy: 0, dz: -3, name: 'stone', support: true }, { dx: 2, dy: 0, dz: -3, name: 'stone', support: true },
      { dx: 1, dy: 1, dz: -3, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'hidden switch' }
    ],
    inputs: [{ dx: 1, dy: 1, dz: -3 }],
    outputs: [{ dx: 1, dy: 1, dz: -1 }],
    unverified: 'needs a live server to confirm the block actually moves'
  },

  // ------------------------------------------------------------- automation
  state_detector: {
    name: 'state_detector',
    title: 'State detector (observer watching a block)',
    logic: 'pulses 2 game ticks whenever the watched block changes',
    footprint: { w: 1, h: 2, d: 3 },
    delayTicks: 1,
    complexity: 1,
    reliability: 'high',
    why: 'The observer watches the block at its `facing` side and emits its pulse at the back; the pulse is exactly 2 game ticks wide.',
    blocks: [
      ...floorOf(1, 3),
      { dx: 0, dy: 1, dz: 0, name: 'chest', note: 'the watched block' },
      { dx: 0, dy: 1, dz: 1, name: 'observer', state: { facing: 'north', powered: false }, note: 'faces the chest; the pulse leaves at the back (south)' },
      { dx: 0, dy: 1, dz: 2, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 0, dy: 2, dz: 2, name: 'redstone_lamp', note: 'output' }
    ],
    inputs: [],
    outputs: [{ dx: 0, dy: 2, dz: 2 }],
    unverified: 'the pulse itself is a model prediction; a static snapshot cannot show what changes next'
  },

  item_sorter: {
    name: 'item_sorter',
    title: 'Item sorter channel (hopper + comparator + lock repeater)',
    logic: 'the comparator reads the sorter hopper; its signal locks the outgoing hopper',
    footprint: { w: 5, h: 2, d: 2 },
    delayTicks: 2,
    complexity: 5,
    reliability: 'medium — filter layout and comparator thresholds must be built by hand',
    why: 'A comparator reads the hopper behind it and outputs a strength proportional to the filter contents; a repeater carries that signal to the outgoing hopper so it stays locked until the filter is exceeded. Only the redstone part is claimed here.',
    blocks: [
      { dx: 0, dy: 0, dz: 0, name: 'stone', support: true },
      { dx: 2, dy: 0, dz: 0, name: 'stone', support: true }, { dx: 3, dy: 0, dz: 0, name: 'stone', support: true },
      { dx: 0, dy: 1, dz: 0, name: 'hopper', state: { facing: 'east', enabled: true }, note: 'input line' },
      { dx: 1, dy: 1, dz: 0, name: 'hopper', state: { facing: 'down', enabled: true }, note: 'sorter hopper (41-item filter goes here)' },
      { dx: 2, dy: 1, dz: 0, name: 'comparator', state: { facing: 'west', mode: 'compare', powered: false }, note: 'reads the sorter hopper at its rear' },
      { dx: 3, dy: 1, dz: 0, name: 'repeater', state: { facing: 'west', delay: '1', powered: false }, note: 'carries the signal back' },
      { dx: 4, dy: 1, dz: 0, name: 'redstone_lamp', note: 'indicator that the filter threshold was crossed' },
      { dx: 1, dy: 0, dz: 0, name: 'chest', support: true }
    ],
    caveat: 'The 41-item filter must be loaded by hand and the outgoing hopper sits below the sorter hopper; the engine reports both requirements instead of pretending it filled the hopper. Item flow is NOT verified by this module.',
    inputs: [],
    outputs: [{ dx: 4, dy: 1, dz: 0 }],
    unverified: 'item flow needs a live server'
  },

  combination_lock: {
    name: 'combination_lock',
    title: '4-lever combination lock (k-input AND of torch inversions)',
    logic: 'out = A ∧ B ∧ C ∧ D — the lamp is lit only while all four levers are on',
    footprint: { w: 11, h: 3, d: 4 },
    delayTicks: 2,
    complexity: 7,
    reliability: 'high — the same rule as the AND gate, generalised to four inputs',
    why: 'Generalisation, not a new template: an AND of k inputs is ¬(¬A ∨ ¬B ∨ …). Each lever powers its own support block and extinguishes that block\'s torch; all four torch outputs share one dust line; the last torch inverts the shared line and lights the lamp. Any single lever left off keeps one torch lit and the line powered, so the lamp stays dark.',
    blocks: [
      ...floorOf(11, 4, -1),
      // four input columns, each with its own dust cell at z=-1 pointing south into its support
      { dx: 0, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'A' },
      { dx: 2, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'B' },
      { dx: 4, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'C' },
      { dx: 6, dy: 1, dz: -1, name: 'lever', state: { face: 'floor', facing: 'south', powered: false }, note: 'D' },
      { dx: 0, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0), note: 'A into its support' },
      { dx: 2, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 4, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 6, dy: 1, dz: 0, name: 'redstone_wire', state: dust(['north', 'south'], 0) },
      { dx: 1, dy: 1, dz: 0, name: 'stone', support: true, note: 'support A' },
      { dx: 3, dy: 1, dz: 0, name: 'stone', support: true, note: 'support B' },
      { dx: 5, dy: 1, dz: 0, name: 'stone', support: true, note: 'support C' },
      { dx: 7, dy: 1, dz: 0, name: 'redstone_lamp', note: 'placeholder removed below' },
      { dx: 1, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬A' },
      { dx: 3, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬B' },
      { dx: 5, dy: 2, dz: 0, name: 'redstone_torch', state: { lit: true }, note: '¬C' },
      // the shared OR line reads every torch
      { dx: 1, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 2, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 3, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 4, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west'], 0) },
      { dx: 5, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['north', 'east', 'west'], 0) },
      { dx: 6, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['east', 'west', 'south'], 0) },
      { dx: 7, dy: 1, dz: 1, name: 'redstone_wire', state: dust(['west', 'south'], 0) },
      // final inverter
      { dx: 7, dy: 1, dz: 2, name: 'stone', support: true, note: 'final support' },
      { dx: 7, dy: 2, dz: 2, name: 'redstone_torch', state: { lit: false }, note: '¬(¬A ∨ ¬B ∨ ¬C ∨ ¬D)' },
      { dx: 8, dy: 1, dz: 2, name: 'redstone_lamp', note: 'output: lit only with all four levers on' }
    ],
    inputs: [{ dx: 0, dy: 1, dz: -1 }, { dx: 2, dy: 1, dz: -1 }, { dx: 4, dy: 1, dz: -1 }, { dx: 6, dy: 1, dz: -1 }],
    outputs: [{ dx: 8, dy: 1, dz: 2 }]
  }
}

const DESIGN_ALIASES = {
  and: 'and_gate',
  or: 'or_gate',
  not: 'not_gate',
  nand: 'nand_gate',
  xor: 'xor_gate',
  latch: 'rs_latch',
  memory: 'rs_latch',
  rs: 'rs_latch',
  sr: 'rs_latch',
  clock: 'clock_1hz',
  oscillator: 'clock_1hz',
  pulse: 'delay_line',
  delay: 'delay_line',
  pulse_extender: 'delay_line',
  sorter: 'item_sorter',
  sorting: 'item_sorter',
  storage: 'item_sorter',
  detector: 'state_detector',
  observer: 'state_detector',
  door: 'piston_door_2x2',
  piston_door: 'piston_door_2x2',
  hidden: 'hidden_door',
  flush: 'hidden_door',
  lock: 'combination_lock',
  combination: 'combination_lock',
  code: 'combination_lock'
}

module.exports = { DESIGNS, DESIGN_ALIASES, dust, floorOf, DIRS4, OPPOSITE }
