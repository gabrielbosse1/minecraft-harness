/**
 * api_wrapper.js — AMD Radeon Cloud client, NATIVE TOOL CALLING edition.
 *
 * Why this exists: Qwen (like every modern instruct model) was trained with
 * OpenAI-style function-calling data. Forcing it to emit raw JSON action lines
 * in a text contract fights its training and produces syntax errors, markdown
 * fences and hallucinated fields. Radeon Cloud exposes an OpenAI-compatible
 * /chat/completions endpoint, so we pass `tools` and read `message.tool_calls`
 * instead. The system prompt shrinks to persona + strategy; the *schema* is
 * the contract, and it is enforced structurally by the API, not by prompting.
 *
 * Design notes:
 *   - Same discipline as ../src/amdClient.js: Bearer auth, exponential backoff
 *     with jitter (429/5xx), timeout via AbortController, secrets redacted
 *     from every error/log path. Each lane (action, chat) sends one call at
 *     a time; the two lanes do not queue behind each other, and a waiting
 *     chat reply goes first — a slow action call (20 s × 3 tries) used to
 *     hold a friend's answer for a minute.
 *   - KV-cache economy is preserved: byte-identical system prompt, small
 *     delta user message, cached-token accounting exposed via getStats().
 *   - Tolerant fallback: if the endpoint ignores `tools` and answers with raw
 *     JSON content (legacy shape {"a":"say","t":"..."} OR a fenced blob), we
 *     parse it and count it as a `jsonFallback`. This keeps the bot alive on
 *     misconfigured proxies without weakening the primary path.
 *   - Tool names/arguments are mapped back to the harness's internal action
 *     shape (single-letter legacy fields) by coerceAction() so the action
 *     switch in index.js stays stable and unit-testable.
 *
 * SECURITY: the key is stored privately, never logged, and scrubbed from any
 * string that might carry it.
 */
'use strict'

const { parseUsage, redactSecrets } = require('../src/amdClient')
const { ContextBudget, measureMessages, measureTools, compactMessagesFallback, trimIncompleteSentence, positiveInt } = require('./context_budget')
const logger = require('../src/logger')

const TAG = 'amd'
/** Sleep, but let a cancelled call stop waiting the moment the caller gives up. */
const sleep = (ms, signal = null) => new Promise((resolve, reject) => {
  if (signal?.aborted) { const err = new Error('request cancelled by the caller'); err.name = 'AbortError'; err.code = 'ZINCAI_ABORTED'; return reject(err) }
  const timer = setTimeout(() => {
    if (signal) signal.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    const err = new Error('request cancelled by the caller')
    err.name = 'AbortError'
    err.code = 'ZINCAI_ABORTED'
    reject(err)
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})
const backoffMs = (attempt) => Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)

// ---------------------------------------------------------------------------
// Tool schemas — the single source of truth for the System-2 action contract.
// Keep descriptions terse: every token here is re-sent on every call.
// ---------------------------------------------------------------------------
const STR = (description) => ({ type: 'string', description })
const INT = (description) => ({ type: 'integer', description })
const STAGE = STR('Phase: foundation | walls_with_windows | roof | interior_details.')
const AT = { type: 'array', description: 'Corner [x,y,z] — the minimum x/y/z the thing occupies. Every shape starts here and grows toward +x/+y/+z. Default: feet.', items: { type: 'integer' }, minItems: 3, maxItems: 3 }
const GAIT = { type: 'string', enum: ['auto', 'crouch', 'walk', 'sprint', 'sprint_jump'], description: 'Movement gait/speed: sprint_jump (fastest for goals), sprint, walk, crouch, or auto.' }
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } })

const ACTION_TOOLS = [
  tool('say', 'Send one short chat line out loud — any language, whatever fits who you are talking to (`to` = private).', {
    text: STR('The line, max 200 chars. In the language of the conversation.'),
    to: STR('Recipient player (optional).')
  }, ['text']),
  tool('go_to', 'Default navigation: walk to a player, saved place, nearby block id (such as chest2), or absolute world coordinates in blocks. Supply x and z alone for horizontal travel on the easiest reachable walking level; supply y only when exact elevation matters. Uses the pathfinder, routes around obstacles/hazards where possible, and may break only its configured soft-terrain blocks when no short detour exists; this is not a tunneling tool. Results report arrival/failure and actual position where available.', {
    player: STR('Player name.'),
    place: STR('Saved place or nearby id.'),
    x: INT('X.'),
    y: INT('Y (optional).'),
    z: INT('Z.'),
    gait: GAIT
  }),
  tool('dig', 'Intentional obstruction clearing/tunneling: pathfind to a player, saved place/block id, or absolute world x/y/z, temporarily allowing pathfinder block breaking only along that route. Optional materials restrict which block ids may be broken; avoid forbids ids. It does not dig straight up to find the surface. Use only for a verified obstruction or deliberate passage, not ordinary travel; results report observed blocks broken and final position.', {
    player: STR('Target player name.'),
    place: STR('Saved place or nearby id.'),
    x: INT('X of the destination.'),
    y: INT('Y of the destination (optional).'),
    z: INT('Z of the destination.'),
    materials: { type: 'array', description: 'Only these block ids may be broken (e.g. [oak_log, dirt]); default: any breakable block in the way.', items: STR('Block id.'), minItems: 1, maxItems: 16 },
    avoid: { type: 'array', description: 'Never break these block ids.', items: STR('Block id.'), minItems: 1, maxItems: 16 },
    gait: GAIT
  }),
  tool('follow', 'Follow a player until you call stop. Keeps going by itself: it dodges mobs and comes back, waits for a path, and walks to where the player was last seen. Call it ONCE — it does not need repeating.', { player: STR('Player name.'), gait: GAIT }, ['player']),
  tool('pace', 'Adjust speed/gait (even mid-walk without cancelling go_to/follow) or do a normal jump. Prefer setting `gait` directly on go_to/follow for goals.', {
    gait: GAIT,
    jump: { type: 'boolean', description: 'True = perform one normal jump.' }
  }),
  tool('stop', 'Stop the currently running body task/follow/fight. The durable goal is retained (suspended) rather than cancelled; use goal cancel with its id only when you intentionally abandon that objective. A stopped task may finish its current cancellation cleanup before the body is idle.'),
  tool('goal', 'Manage persistent objectives (survive death/restart/context reset): list|show|add|resume|suspend|cancel|complete|update|combine|verify.', {
    operation: { type: 'string', enum: ['list', 'show', 'add', 'resume', 'suspend', 'cancel', 'complete', 'update', 'combine', 'verify'] },
    id: STR('Goal id (g3), or comma-separated ids for combine ("g1,g2").'),
    description: STR('Goal description (for add/update/combine).'),
    reason: STR('Why this goal matters (motivation).'),
    priority: INT('0–100, higher = more important.'),
    parent: STR('Parent goal id for subgoals (e.g. g1).'),
    origin: { type: 'string', enum: ['self_generated', 'player_requested', 'shared_project'] },
    player: STR('Player name(s) when player_requested or shared_project.'),
    note: STR('Progress or status note.'),
    percent: INT('For update: 0–100.'),
    steps: { type: 'array', description: 'add/update: an ordered plan of up to 10 short steps. Shown with done marks across turns, so continue rather than re-planning.', items: { type: 'string' }, maxItems: 10 },
    done: INT('update: number of the plan step you just finished (1 = first).'),
    next: STR('update: the very next concrete thing to do (survives death/restart).')
  }, ['operation']),
  tool('attack', 'Start an explicit melee/ranged attack. Survival reflexes may independently evade or auto-kite a threat while you decide; this tool starts the deliberate attack task. Use `target` for mobs (e.g. "zombie", "any") when fighting is safer/useful than retreating, or `player` for an exact PvP opponent only when explicitly authorized by the configured policy (never auto-initiate PvP).', {
    target: STR('Mob type or "any" (for mobs, not players).'),
    player: STR('Exact player name; only use when allowed by the configured PvP policy. The harness never auto-initiates attacks on players.'),
    count: INT('Optional kill limit (1–24); players always stop at one. If omitted, animals default to 1 and hostiles use the configured chain limit.')
  }),
  tool('hold', 'Accept current threats and continue the task unless hit/new threat/lit fuse. Pass the [id=…] values from the threats lines to hold specific ones (never guessed numbers); with none, all listed threats are held.', {
    ids: { type: 'array', description: 'Threat ids to hold (the numbers in [id=7]). Omit = every listed threat.', items: INT('Threat id.'), minItems: 1, maxItems: 12 }
  }),
  tool('look_in', 'Open container and list contents (empty = nearest).', { where: STR('Id, label, or empty.') }),
  tool('take', 'Take items from a container or furnace output.', {
    item: STR('Item id.'),
    count: INT('Amount (default all).'),
    where: STR('Id, label, or known source.')
  }, ['item']),
  tool('put', 'Put carried items into a container.', {
    item: STR('Item id.'),
    count: INT('Amount (default all).'),
    where: STR('Id or label (default nearest).')
  }, ['item']),
  tool('smelt', 'Load furnace with item + carried fuel; collect output with take.', {
    item: STR('Item id to smelt.'),
    count: INT('Amount (default all).'),
    where: STR('Furnace id (default nearest).')
  }, ['item']),
  tool('sleep', 'Sleep in nearest bed (night/thunderstorm).'),
  tool('give', 'Walk to player and toss item.', {
    player: STR('Player name.'),
    item: STR('Item id.'),
    count: INT('Amount (default 1).')
  }, ['player', 'item']),
  tool('eat', 'Eat safe food now (empty = best carried).', { item: STR('Food id (optional).') }),
  tool('equip', 'Equip a carried item by name (armor goes to its own slot), or unequip one. Better carried armor is equipped automatically, while slots you dress or empty manually stay as you set them.', {
    item: STR('Item id, or "none" with where to unequip what is worn there.'),
    where: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }
  }, ['item']),
  tool('use_block', 'Walk to nearest matching block and right-click it.', { what: STR('Block id.') }, ['what']),
  tool('inspect_block', 'Read one loaded block and state; no power inferred.', { x: INT('X.'), y: INT('Y.'), z: INT('Z.') }, ['x', 'y', 'z']),
  tool('inspect_region', 'Read-only paginated 3D block snapshot around [x,y,z]; no circuit trace.', { x: INT('X.'), y: INT('Y.'), z: INT('Z.'), radius: INT('0–2, default 1.'), page: INT('Page, default 1.') }, ['x', 'y', 'z']),
  tool('redstone_scan', 'Read-only local redstone snapshot (start with x,y,z; page with snapshot id).', { x: INT('X.'), y: INT('Y.'), z: INT('Z.'), radius: INT('0–2, default 1.'), snapshot: STR('Existing snapshot id.'), page: INT('Page, default 1.') }),
  tool('redstone_component', 'Inspect captured redstone component state and neighbors.', { snapshot: STR('Snapshot id.'), x: INT('X.'), y: INT('Y.'), z: INT('Z.'), page: INT('Page, default 1.') }, ['snapshot', 'x', 'y', 'z']),
  tool('screenshot', 'SEE: rendered image of the world around you. Use BEFORE digging/breaking/clearing (to make sure you are not digging in front of a house or inside a cave), BEFORE picking a build site (panorama/map for open surface terrain), and DURING/AFTER building stages to inspect proportions, depth, and flaws. Use inspect_block / inspect_region / find / redstone tools for exact coordinates and block IDs.', {
    view: { type: 'string', enum: ['look', 'panorama', 'map'], description: 'look = first person (default); panorama = full 360° strip, north in the middle; map = top-down with a labelled x/z grid.' },
    direction: { type: 'string', enum: ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'up', 'down'], description: 'look only: where to face (default: where you face now).' },
    at: { type: 'array', description: 'look only: face this block [x,y,z] instead.', items: { type: 'integer' }, minItems: 3, maxItems: 3 },
    perspective: { type: 'string', enum: ['first', 'third'], description: 'look only: first = from your eyes (default, no own body); third = camera behind you so you see your own body, skin, armour, elytra and both hands.' }
  }),
  tool('find', 'Find block type, item in opened containers, chest label, or "storage".', {
    what: STR('Id, label, or "storage".'),
    page: INT('Storage page (default 1).')
  }, ['what']),
  tool('remember_here', 'Save current position under a place name, with optional ownership or verified home tag.', {
    name: STR('Place name.'),
    note: STR('Optional note.'),
    ownership: { type: 'string', enum: ['own', 'shared', 'player', 'unknown'] },
    owner: STR('Owner player name if ownership="player".'),
    home: { type: 'boolean', description: 'True ONLY if this is your verified home (built by you or explicitly assigned to you).' }
  }, ['name']),
  tool('memory', 'Memory: `recall`/`search` (curated memories), `read` one record with its evidence, `remember`/`update` (short facts; pass entity+section or entity+doc to grow that subject\'s long dossier), `archive`/`delete`/`restore` (raw history is never affected), `merge` duplicates, `duplicates`, `link` a history reference, `profile`/`profiles` (long-form dossiers), `history` (search the raw log), `organize` (idle-time maintenance).', {
    operation: { type: 'string', enum: ['recall', 'search', 'read', 'remember', 'update', 'archive', 'delete', 'restore', 'merge', 'duplicates', 'link', 'profile', 'profiles', 'history', 'organize'] },
    query: STR('Search text (recall/search/history/profile).'),
    text: STR('Memory text, or the note to append to a dossier section.'),
    category: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'continuity', 'identity', 'relationship', 'preference', 'world', 'chat', 'actions', 'decisions', 'relationships', 'errors', 'maintenance'], description: 'Curated: episodic|semantic|procedural|continuity. Raw history: world|chat|actions|decisions|relationships|errors|maintenance.' },
    basis: { type: 'string', enum: ['observed', 'reported', 'inferred'], description: 'Evidence: witnessed by Zinc, told by a player (unverified), or inferred.' },
    entity: STR('Player UUID/name, place or subject this concerns.'),
    id: STR('Memory id (read/update/archive/delete/restore/link).'),
    ids: { type: 'array', description: 'Memory ids to merge.', items: STR('Memory id.'), minItems: 2, maxItems: 12 },
    into: STR('Merge: id of the record to keep (default: first id).'),
    evidence: STR('A history reference like world/2026-11-15.jsonl#12, or a short evidence note.'),
    ref: STR('History reference to read (operation history).'),
    section: { type: 'string', enum: ['identity', 'description', 'interactions', 'preferences', 'behavior', 'facts', 'uncertainties', 'timeline', 'notes'], description: 'Dossier section to append to (with entity).' },
    doc: STR('Full Markdown body for an entity dossier (with entity); replaces the written notes.'),
    profile: STR('Profile key (alias of entity).'),
    status: { type: 'string', enum: ['active', 'archived', 'all'], description: 'Which records to consider (recall/profiles).' },
    importance: INT('0–5; higher survives compaction and eviction.'),
    confidence: INT('0–100 (update).'),
    threshold: { type: 'number', description: 'Duplicate similarity 0.5–0.99 (default 0.9).' },
    hard: { type: 'boolean', description: 'delete: also drop the curated row itself. Raw history is never touched either way.' },
    reason: STR('Why (used for edits, archives and merges).'),
    limit: INT('Max results (1–20).'),
    goal: STR('Goal id filter (recall).'),
    x: INT('Nearby X (recall).'),
    y: INT('Y.'),
    z: INT('Z.'),
    sinceDays: INT('History: only records newer than N days.')
  }, ['operation']),
  tool('note', 'Record a durable discovery, lesson, or ownership observation in long-term memory, or add/drop a personal interest.', {
    text: STR('Short factual note or lesson learned.'),
    interest: STR('Emerging personal interest to add, or "-topic" to drop.')
  }),
  tool('social', 'Inspect or update your independent view/relationship with a player, or record your decision on their request.', {
    operation: { type: 'string', enum: ['list', 'show', 'update', 'decide'] },
    player: STR('Player name (for show/update/decide).'),
    stance: STR('Your own category/label (e.g. friend, acquaintance, cautious, distrusted, rival, avoid, collaborator, or custom nuance).'),
    trust: INT('Your trust assessment -100..100.'),
    confidence: INT('Confidence 0–100 (keep modest on thin evidence; raise with consistency).'),
    willingness: STR('How you want to engage (e.g. cooperate, help when free, verify claims, negotiate, avoid, decline).'),
    opinion: STR('Nuanced free-form summary of your opinion and why.'),
    evidence: STR('Supporting observation or experience behind this update.'),
    decision: { type: 'string', enum: ['accept', 'decline', 'ignore', 'negotiate', 'delay'] }
  }, ['operation']),
  tool('craft', 'Craft item (walks to a nearby table if needed, or puts down one you carry). A failure names the ingredients and how many you have.', { item: STR('Item id.'), count: INT('How many of the item you want in total (the recipe repeats; default one batch). Ask once, not once per batch.') }, ['item']),
  tool('gather', 'Dig named blocks nearby (any diggable vanilla block id or alias such as log/wood/coal/iron/diamond/stone/clay; ores require an appropriate pickaxe). If none is in range the result reports the nearest loaded coordinates.', {
    item: STR('Block id or alias (oak_log, iron, stone, clay, sand…; "log" = any wood).'),
    count: INT('Count 1–64 (default 1).'),
    radius: INT('Radius 1–64 (default 32).')
  }, ['item']),
  tool('mine_resource', 'High-level mining procedure: ensures a suitable pickaxe if craftable from carried materials, mines the requested resource, actively walks over and collects dropped items, and verifies inventory gain.', {
    item: STR('Resource block id or alias (wood, oak_log, stone, coal, iron, diamond, sand…).'),
    count: INT('Target blocks to mine 1–64 (default 4).'),
    radius: INT('Search radius 4–48 (default 32).'),
    ensure_tool: { type: 'boolean', description: 'Auto-craft wooden/stone pickaxe from carried materials if missing (default true).' }
  }, ['item']),
  tool('hunt_and_loot', 'High-level safe hunting procedure: finds eligible non-protected food animals (cow, pig, sheep, chicken, rabbit) or a named safe mob, kills it, and actively collects and verifies dropped loot. Never targets players, villagers, golems, named or tamed mobs.', {
    target: STR('Animal or mob name, or "food" for any nearby food animal (default "food").'),
    count: INT('How many targets to hunt 1–8 (default 1).'),
    radius: INT('Search radius 8–48 (default 32).')
  }),
  tool('prepare_food', 'High-level food preparation procedure: crafts bread from carried wheat, cooks raw meat/potatoes in a nearby or crafted furnace with carried fuel, collects cooked food, and optionally eats if hungry.', {
    item: STR('Optional food name to prioritize (e.g. beef, porkchop, bread, potato).'),
    count: INT('How many food items to prepare 1–32 (default 4).'),
    eat_after: { type: 'boolean', description: 'Eat immediately after preparing if hungry or hurt (default false).' }
  }),
  tool('light_up', 'Place carried torches on dark walkable floors nearby.', {
    radius: INT('Radius 2–16 (default 8).')
  }),
  tool('shelter', 'Pillar up with carried scaffold blocks (stop cleans up).'),
  tool('corpse_run', 'Walk near "last death" and report observed item stacks.'),
  tool('logic_test', 'Test ABSTRACT combinational Boolean graph (not MC redstone; acyclic gates).', {
    inputs: { type: 'array', description: '1–9 input signal ids.', items: STR('Signal id'), minItems: 1, maxItems: 9 },
    gates: { type: 'array', description: 'Up to 128 topological gates.', maxItems: 128, items: { type: 'object', properties: { id: STR('Signal id'), op: { type: 'string', enum: ['AND', 'OR', 'XOR', 'NOT', 'BUF', 'NAND', 'NOR', 'FULL_SUM', 'FULL_CARRY'] }, inputs: { type: 'array', description: '1–3 earlier signal ids.', items: STR('Signal id'), minItems: 1, maxItems: 3 } }, required: ['id', 'op', 'inputs'], additionalProperties: false } },
    outputs: { type: 'array', description: '1–9 output signal ids.', items: STR('Signal id'), minItems: 1, maxItems: 9 },
    tests: { type: 'array', description: '1–512 test vectors (or use adder_width).', minItems: 1, maxItems: 512, items: { type: 'object', properties: { in_bits: STR('Input bits'), out_bits: STR('Expected bits') }, required: ['in_bits', 'out_bits'], additionalProperties: false } },
    adder_width: INT('Exhaustive unsigned adder width 1–4 (A, B, Cin -> S, Cout).'),
    project: STR('Optional project name to save.')
  }, ['inputs', 'gates', 'outputs']),
  tool('redstone_engineer', 'Understand, design, build, test or repair redstone (Java 1.21.4/26.3). operation=analyze|diagnose|simulate|design|place|verify|trace|library|lesson.', {
    operation: { type: 'string', enum: ['analyze', 'diagnose', 'simulate', 'design', 'place', 'verify', 'trace', 'library', 'lesson'] },
    x: INT('Center X (analyze/diagnose/simulate/place).'),
    y: INT('Center Y.'),
    z: INT('Center Z.'),
    radius: INT('Scan radius 0–6 (default 3) for analyze/diagnose.'),
    design: STR('Design name or behaviour phrase (design/place): and, or, not, xor, latch, clock, pulse, sorter, farm, detector.'),
    rotate: { type: 'string', enum: ['north', 'south', 'east', 'west'], description: 'Rotate the design layout (place).' },
    inputs: { type: 'array', description: 'verify: lever/button positions [{x,y,z},…] to toggle.', items: { type: 'object', properties: { x: INT('X'), y: INT('Y'), z: INT('Z') }, required: ['x', 'y', 'z'], additionalProperties: false }, minItems: 1, maxItems: 4 },
    outputs: { type: 'array', description: 'verify: output positions [{x,y,z},…] to watch.', items: { type: 'object', properties: { x: INT('X'), y: INT('Y'), z: INT('Z') }, required: ['x', 'y', 'z'], additionalProperties: false }, minItems: 1, maxItems: 4 },
    ticks: INT('simulate: ticks to simulate (1–200).'),
    node: STR('trace: node id "x,y,z" to trace signal from.'),
    name: STR('library/lesson: design or lesson name.'),
    compare: { type: 'array', description: 'design: extra design names to compare.', items: STR('Design name.'), minItems: 1, maxItems: 4 },
    note: STR('lesson: what you learned (max 240 chars).')
  }, ['operation']),
  tool('recall', 'Search long-term memory with relevance ranking: word overlap plus a built-in synonym table (so "treasure" finds a memory that says "diamonds"), entity, location, goal and category filters, with provenance.', {
    query: STR('What to recall (free text).'),
    category: STR('Filter: episodic | semantic | procedural | continuity.'),
    entity: STR('Player/mob/entity name.'),
    goal: STR('Goal id.'),
    x: INT('Nearby X (location search).'),
    y: INT('Y.'),
    z: INT('Z.')
  }),
  tool('circuit_project', 'Bind snapshot, show project/graph, or rerun saved ABSTRACT logic test.', {
    operation: { type: 'string', enum: ['bind', 'show', 'graph', 'test', 'list'] },
    name: STR('Project name (max 32).'),
    snapshot: STR('For bind: snapshot id.'),
    page: INT('For graph: page, default 1.'),
    note: STR('For bind: note (max 240 chars).')
  }, ['operation']),
  tool('build', 'Place a saved blueprint or an inline 3D grid from carried materials; this mutates the world, checks ownership/materials, and reports placed counts/failures. A one-block inline build is grid [["C"]] + palette {C:"cobblestone"}. `at` is the minimum [x,y,z] world-block corner (default: your feet); rows grow +x, layers +y, columns +z. Large named houses/shelters/towers are refused on unloaded, liquid, unsupported, or natural-cave-roof sites.', {
    blueprint: STR('Blueprint name in zincai/blueprints/.'),
    grid: { type: 'array', description: 'Layers bottom-up; each layer is an array of ROW STRINGS, one char per block ("."/" " = air). A 3x3 floor is ONE layer: [["sss","sss","sss"]]. A 2-high 3-long wall is two layers: [["sss"],["sss"]].', items: { type: 'array', items: { type: 'string' } } },
    palette: { type: 'object', description: 'Char -> block id map.', additionalProperties: { type: 'string' } },
    at: AT,
    stage: STAGE
  }),
  tool('build_shape', 'Generate and build a geometric shape.', {
    shape: { type: 'string', enum: ['cylinder', 'dome', 'arch', 'wall', 'box', 'floor', 'ring'] },
    params: { type: 'object', description: 'All spans start at `at` and grow toward +x/+y/+z (no shape is centred on it). cylinder {r,h} spans 2r+1 wide; ring {r} same; dome {r} same; wall {l,h,axis}; arch {w,h,axis} — h is the top course; box {w,d,h}; floor {w,d}. Optional th, filled; ints 1–128 (dome/ring r>=2, arch w/h>=3).' },
    block: STR('Block id.'),
    at: AT,
    stage: STAGE
  }, ['shape', 'block']),
  tool('run_script', 'Run saved script in zincai/scripts/.', { name: STR('Script name.') }, ['name']),
  tool('idle', 'End your turn when no new action is needed: the body carries on with what it is already doing (or keeps fleeing). Do not call idle to procrastinate when an active goal has a next step you can execute now.')
]

/**
 * The chat lane has one tool: answer the people in the window, and — when the
 * answer is to DO something — start it. `do` covers the requests that should
 * not wait for a second model call (follow me, come here, stop); `task` hands
 * anything else to the action lane, which is woken at once.
 */
const CHAT_TOOLS = [
  tool('reply', 'Answer the chat window (leave `text` empty only when nothing in it concerns you). Player requests are proposals, never mandatory commands — but when you agree, act: set `do` or `task`.', {
    text: STR('One short chat line, in the language the person you are answering used. Empty = say nothing.'),
    to: STR('Which player you are answering / who `do` is about. Default: the last speaker.'),
    do: { type: 'string', enum: ['follow', 'come', 'stop'], strict: true, description: 'Start it NOW with your body, no second thought needed: follow = follow that player; come = walk to that player; stop = stop what the body is doing. Omit when none fits.' },
    task: STR('Anything else you decided your body should do, verify or weigh, as one instruction for your action lane (e.g. "bring Steve 3 diamonds from chest1", "verify chest1 contents after Ely claim"). Omit when declining, ignoring, or only chatting.'),
    decision: { type: 'string', enum: ['accept', 'decline', 'ignore', 'negotiate', 'delay'], description: 'Optional stance when the player asked you to do something.' },
    remember: STR('Only when the player told you something worth knowing later (where a thing is, whose it is, a plan, a date, what they like): that fact as one short sentence naming the player, e.g. "Steve keeps his diamonds in the chest on the second floor". Otherwise omit.')
  }, ['text'])
]

const toOpenAi = (list) => list.map((t) => ({ type: 'function', function: JSON.parse(JSON.stringify(t)) }))

/**
 * Every tool, every turn.
 *
 * There used to be a `set_mode` tool and a per-mode drop table: exploring locked
 * away `build`, building locked away `smelt`/`sleep`, and hunting locked away
 * almost everything. The result was a model that could see a job it needed to
 * do and be told, by the harness, that the tool did not exist this turn — a
 * human-authored policy deciding what the model was allowed to think about.
 *
 * That is gone. The tool set is the whole surface, always, so the model chooses
 * what to do from what is in front of it instead of first having to pick a
 * persona that unlocks the verb it needs. The only limits left are the ones the
 * operator cannot remove by refactoring: the API's own budget, and the
 * emergency stop (`stop` / `shutdown`).
 *
 * `createZincTools()` takes no arguments on purpose; the old `{ mode }` option
 * is accepted and ignored so an out-of-tree caller does not crash.
 */
function createZincTools () {
  return toOpenAi(ACTION_TOOLS)
}
function createChatTools () { return toOpenAi(CHAT_TOOLS) }

/**
 * Compact core tool subset used ONLY during Stage 3 graceful degradation after
 * full-tool Stage 1 & 2 recovery still hit token/context limits. Cuts schema
 * overhead by ~80% (~5.6k tok -> ~1k tok) while keeping essential verbs.
 */
const RECOVERY_TOOL_NAMES = new Set(['idle', 'say', 'go_to', 'stop', 'hold', 'goal', 'note', 'eat', 'attack', 'gather'])
function createRecoveryTools () {
  return toOpenAi(ACTION_TOOLS.filter((t) => RECOVERY_TOOL_NAMES.has(t.name)))
}

/**
 * Map tool args -> the harness's internal action shape. Arguments keep their
 * own names; the single-letter fields are legacy aliases for older call sites.
 */
/**
 * Map a value onto a declared enum member: exact, then case-insensitive, then a
 * unique prefix / underscore-insensitive match. `"self"` -> `self_generated`,
 * `"Add"` -> `add`. Returns undefined when nothing plausible matches, so the
 * handler still gets to explain what it wanted.
 */
function coerceEnum (value, options, { prefix = true } = {}) {
  if (typeof value !== 'string') return undefined
  if (options.includes(value)) return value
  const norm = (v) => v.toLowerCase().replace(/[\s-]+/g, '_')
  const n = norm(value)
  const ci = options.find((o) => norm(o) === n)
  if (ci) return ci
  // Prefix matching is for free-text-ish value sets (an operation, an origin).
  // It must NOT apply to a closed verb list: `do: "attack"` on the chat lane
  // prefix-matches nothing, but a typo like `do: "fol"` must still not become
  // an action the chat lane was never allowed to start.
  if (!prefix) return undefined
  const pref = options.filter((o) => norm(o).startsWith(n))
  if (pref.length === 1) return pref[0]
  const suf = options.filter((o) => norm(o).endsWith('_' + n))
  if (suf.length === 1) return suf[0]
  return undefined
}

const ARG_LEGACY = {
  say: (a) => ({ ...a, t: a.text }),
  craft: (a) => ({ ...a, i: a.item }),
  attack: (a) => ({ ...a, n: a.player ? undefined : (a.target ?? a.name) })
}

function parseToolCall (call, known) {
  const name = String(call?.function?.name || '')
  if (!known.some((t) => t.name === name)) {
    logger.warn(TAG, `unknown tool call "${name}" — ignoring`)
    return { error: 'unknown', name }
  }
  const bad = (detail) => ({ error: 'args', name, detail: String(detail || 'invalid arguments').slice(0, 180) })
  try {
    const rawArgs = call?.function?.arguments
    let args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {})
    if (!args || typeof args !== 'object' || Array.isArray(args)) return bad('arguments must be a JSON object')
    const schema = known.find((t) => t.name === name).parameters
    // Reject undeclared fields: in particular, an injected `a` must never
    // override the chosen tool name in the executor.
    const extra = Object.keys(args).find((key) => !Object.hasOwn(schema.properties, key))
    if (extra) return bad(`unknown parameter '${extra}' for ${name}`)
    const missing = (schema.required || []).find((key) => !Object.hasOwn(args, key))
    if (missing) return bad(`missing required parameter '${missing}'`)
    for (const [key, value] of Object.entries(args)) {
      const spec = schema.properties[key]
      if (spec.type === 'string' && typeof value !== 'string') return bad(`'${key}' must be a string`)
      if (spec.type === 'integer' && !Number.isInteger(value)) return bad(`'${key}' must be an integer`)
      if (spec.type === 'boolean' && typeof value !== 'boolean') return bad(`'${key}' must be true or false`)
      if (spec.type === 'array' && !Array.isArray(value)) return bad(`'${key}' must be an array`)
      if (spec.type === 'array' && spec.minItems != null && value.length < spec.minItems) return bad(`'${key}' needs at least ${spec.minItems} items`)
      if (spec.type === 'array' && spec.maxItems != null && value.length > spec.maxItems) return bad(`'${key}' allows at most ${spec.maxItems} items`)
      if (spec.type === 'array' && spec.items?.type === 'string' && value.some((v) => typeof v !== 'string')) return bad(`every item in '${key}' must be a string`)
      if (spec.type === 'array' && spec.items?.type === 'integer' && value.some((v) => !Number.isInteger(v))) return bad(`every item in '${key}' must be an integer`)
      if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return bad(`'${key}' must be a finite number`)
      if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return bad(`'${key}' must be an object`)
      if (spec.enum) {
        // `strict: true` marks a closed verb list (the chat lane's `do`): an
        // out-of-enum value there must fail the call, never be approximated.
        if (spec.strict) {
          if (!spec.enum.includes(value)) return bad(`'${key}' must be one of: ${spec.enum.join(', ')}`)
          continue
        }
        const fixed = coerceEnum(value, spec.enum)
        if (fixed !== undefined) { args[key] = fixed; continue }
      }
      // An out-of-enum value is deliberately NOT rejected here. Every handler
      // that takes an enum already validates it and says what it wanted
      // ("operation must be one of analyze|diagnose|…"); throwing away the
      // whole call first meant the model got "arguments failed schema
      // validation" with no hint, and lost the description/id/priority it had
      // also sent. The value is passed through and the handler explains.
    }
    return { name, args }
  } catch (err) {
    logger.warn(TAG, `malformed tool arguments for ${name}: ${err.message}`)
    return bad(`could not parse arguments: ${err.message}`)
  }
}

/**
 * Normalize one model message into an internal action object `{a, ...args}`.
 * Never throws — any failure yields {a:'idle'} plus a marker saying why, so
 * the executor can tell the model its answer did nothing.
 * @param {object} message choices[0].message from the completion
 * @param {boolean} strict when true (default) unknown/broken calls become idle
 */
function coerceAction (message, strict = true) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (toolCalls.length > 0) {
    const parsed = parseToolCall(toolCalls[0], ACTION_TOOLS)
    if (parsed.error === 'unknown') return strict ? { a: 'idle', _unknownTool: parsed.name } : null
    if (parsed.error === 'args') return strict ? { a: 'idle', _badArgs: parsed.name, _badArgsDetail: parsed.detail } : null
    const { name, args } = parsed
    const mapped = ARG_LEGACY[name] ? ARG_LEGACY[name](args) : { ...args }
    return { ...mapped, a: name, _via: 'tool' }
  }

  // Fallback: endpoint ignored `tools` and answered with plain content —
  // strip <think> blocks, recover leaked <tool_call> XML tags, or recover
  // the legacy single-line JSON contract rather than failing.
  const rawContent = typeof message?.content === 'string' ? message.content : ''
  const stripped = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const toolTag = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(stripped)
  if (toolTag) {
    try {
      const tc = JSON.parse(toolTag[1].trim())
      if (tc && typeof tc === 'object' && typeof tc.name === 'string') {
        const parsed = parseToolCall({ function: { name: tc.name, arguments: tc.arguments ?? {} } }, ACTION_TOOLS)
        if (parsed.error === 'unknown') return strict ? { a: 'idle', _unknownTool: parsed.name } : null
        if (parsed.error === 'args') return strict ? { a: 'idle', _badArgs: parsed.name, _badArgsDetail: parsed.detail } : null
        const mapped = ARG_LEGACY[parsed.name] ? ARG_LEGACY[parsed.name](parsed.args) : { ...parsed.args }
        return { ...mapped, a: parsed.name, _via: 'tool' }
      }
    } catch { /* fall through to JSON/prose */ }
  }
  const content = stripped
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content)
  const s = (fence ? fence[1] : content).trim()
  const line = s.split('\n').find((l) => l.trim().startsWith('{')) || s
  try {
    const obj = JSON.parse(line.trim())
    if (obj && typeof obj === 'object' && typeof obj.a === 'string') {
      // Legacy {"a":"move"} is today's go_to.
      if (obj.a === 'move') obj.a = 'go_to'
      if (!ACTION_TOOLS.some((t) => t.name === obj.a)) return { a: 'idle', _unknownTool: obj.a }
      const name = obj.a
      const args = { ...obj }
      delete args.a
      if (name === 'say' && args.text === undefined && args.t !== undefined) { args.text = args.t; delete args.t }
      if (name === 'craft' && args.item === undefined && args.i !== undefined) { args.item = args.i; delete args.i }
      if (name === 'attack' && args.target === undefined && args.n !== undefined) { args.target = args.n; delete args.n }
      const parsed = parseToolCall({ function: { name, arguments: args } }, ACTION_TOOLS)
      if (parsed.error) return { a: 'idle', _badArgs: name, _badArgsDetail: parsed.detail }
      const mapped = ARG_LEGACY[name] ? ARG_LEGACY[name](parsed.args) : parsed.args
      return { ...mapped, a: name, _via: 'json-fallback' }
    }
  } catch { /* fall through */ }
  const prose = content || rawContent.trim()
  if (prose) logger.warn(TAG, `model answered in prose without a tool call: ${prose.slice(0, 120)}`)
  // Prose used to vanish silently. Keep it so the caller can report it back.
  return strict ? { a: 'idle', _fallback: true, ...(prose ? { _prose: prose.slice(0, 300) } : {}) } : null
}

/**
 * Normalize a chat-lane message into { text, task }. Prose without a tool
 * call is taken as the reply itself — in a chat lane that is what it is.
 */
function coerceReply (message) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (toolCalls.length > 0) {
    const parsed = parseToolCall(toolCalls[0], CHAT_TOOLS)
    if (!parsed.error) {
      return {
        text: String(parsed.args.text ?? '').trim(),
        to: String(parsed.args.to ?? '').trim(),
        do: parsed.args.do ? String(parsed.args.do).trim() : '',
        task: String(parsed.args.task ?? '').trim(),
        decision: parsed.args.decision ? String(parsed.args.decision).trim() : '',
        remember: String(parsed.args.remember ?? '').trim(),
        _via: 'tool'
      }
    }
  }
  // Reasoning is never the reply: a closed <think> block is dropped, and an
  // unclosed one (cut off mid-thought) means there is no reply at all.
  const content = typeof message?.content === 'string'
    ? message.content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim()
    : ''
  // Some models wrap the answer in quotes or prefix their own name.
  const text = content.replace(/^["'“”]+|["'“”]+$/g, '').replace(/^(zinc(ai)?|me)\s*:\s*/i, '').split('\n')[0].trim()
  return { text, to: '', do: '', task: '', decision: '', remember: '', _via: 'prose' }
}

/**
 * Every tool call of one model message, in order, as internal actions.
 *
 * A turn is no longer one call: the model may ask for several things at once
 * ("say I'm coming" + "follow Steve") and they all run. A call that is broken
 * (unknown name, bad arguments) keeps its place as an `idle` with the marker
 * that says why, so the model is told about that one without losing the rest.
 * A message with no tool call at all falls back to coerceAction's recovery
 * (leaked <tool_call> tags, the legacy one-line JSON, prose).
 * @returns {object[]} at least one action; each carries `_callId` when the
 *   endpoint gave the call an id
 */
function coerceActions (message, { max = 6 } = {}) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (!toolCalls.length) return [coerceAction(message)]
  const out = []
  for (const call of toolCalls.slice(0, Math.max(1, max))) {
    const one = coerceAction({ tool_calls: [call] })
    if (call?.id) one._callId = String(call.id)
    out.push(one)
  }
  if (toolCalls.length > out.length) out.dropped = toolCalls.length - out.length
  return out
}

/**
 * The messages that continue a turn after its tool calls ran: what the model
 * asked for, and what each call returned.
 *
 * `format: 'tool'` is the OpenAI tool protocol (an assistant message carrying
 * `tool_calls`, then one `tool` message per call). `format: 'text'` says the
 * same thing in plain assistant/user messages, for endpoints whose chat
 * template rejects tool messages.
 * @param {Array<{ id?:string, name:string, args?:object, result:string }>} calls
 */
function toolTurnMessages (calls, { format = 'tool', content = '', images = [] } = {}) {
  const list = (calls || []).map((c, i) => ({ id: c.id || `call_${i + 1}`, name: String(c.name), args: c.args || {}, result: String(c.result ?? 'done') }))
  if (!list.length) return []
  // Pictures (screenshots) cannot ride inside a `tool` message on OpenAI-style
  // endpoints: they follow as a user message of image parts.
  const pics = (images || []).filter((im) => im && im.url)
  const picParts = pics.flatMap((im) => [{ type: 'text', text: im.caption || 'screenshot:' }, { type: 'image_url', image_url: { url: im.url } }])
  if (format === 'text') {
    const text = `tool results:\n${list.map((c) => `- ${c.name}: ${c.result}`).join('\n')}\nContinue: call the next tool(s), or idle when there is nothing more to do right now.`
    return [
      { role: 'assistant', content: `[called: ${list.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join('; ')}]` },
      { role: 'user', content: pics.length ? [{ type: 'text', text }, ...picParts] : text }
    ]
  }
  return [
    { role: 'assistant', content: typeof content === 'string' ? content : '', tool_calls: list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
    ...list.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.result })),
    ...(pics.length ? [{ role: 'user', content: picParts }] : [])
  ]
}

/**
 * Pure: build the OpenAI-compatible chat completion request body.
 * `max_tokens` is omitted when null/undefined so endpoints apply the model's
 * standard output limit rather than an arbitrary harness cap.
 * `tools` / `tool_choice` are omitted when no tools are provided (used by
 * plain-text graceful degradation).
 */
function buildToolsPayload ({ model, messages, temperature, maxTokens = null, tools = null, toolChoice = 'required', parallelToolCalls = true, stream = false, streamOptions = null, extraParams = null }) {
  const payload = {
    model,
    messages,
    temperature,
    stream: Boolean(stream)
  }
  if (payload.stream && streamOptions && typeof streamOptions === 'object') {
    payload.stream_options = streamOptions
  }
  const explicitMax = positiveInt(maxTokens, 16, 500_000)
  if (explicitMax !== null) payload.max_tokens = explicitMax
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools
    payload.tool_choice = toolChoice
    if (parallelToolCalls !== null) payload.parallel_tool_calls = parallelToolCalls !== false
  }
  if (extraParams && typeof extraParams === 'object') {
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && !(k in payload)) payload[k] = v
    }
  }
  return payload
}

function parseRetryAfterMs (headerValue) {
  if (!headerValue) return null
  const raw = String(headerValue).trim()
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(60_000, Math.max(1000, Math.round(secs * 1000)))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.min(60_000, Math.max(1000, at - Date.now()))
  return null
}

function normalizeReasoningEffort (val) {
  if (val === null || val === undefined) return null
  const s = String(val).trim().toLowerCase()
  if (!s || s === 'none' || s === 'off' || s === 'default' || s === 'null') return null
  return s
}

/** Extract model reasoning trace from OpenAI-compatible fields or <think> tags. */
function extractReasoning (message) {
  if (!message || typeof message !== 'object') return ''
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return message.reasoning_content.trim()
  }
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning.trim()
  }
  const text = contentText(message.content)
  const m = /<think>([\s\S]*?)<\/think>/i.exec(text)
  return m ? m[1].trim() : ''
}

/** Does any message carry an image part? */
function hasImages (messages) {
  return (messages || []).some((m) => Array.isArray(m?.content) && m.content.some((part) => part && part.type === 'image_url'))
}

/** The same messages with every image replaced by a one-line text stand-in (an endpoint that takes no images). Pure. */
function stripImages (messages, why = 'image omitted: this endpoint does not accept images') {
  return (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m
    const text = m.content.map((part) => (part?.type === 'text' ? String(part.text) : part?.type === 'image_url' ? `[${why}]` : '')).filter(Boolean).join('\n')
    return { ...m, content: text }
  })
}

/** Text of a message whose content may be a string or a list of parts. */
function contentText (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part?.type === 'text' ? String(part.text) : '')).join('')
  return ''
}

/** Sum two usage reports (a call and its rescue retry), preserving nulls. */
function mergeUsage (a, b) {
  if (!a) return b
  if (!b) return a
  const sum = (x, y) => (x === null || x === undefined ? (y ?? null) : (y == null ? x : x + y))
  return {
    ...a,
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
    cachedTokens: sum(a.cachedTokens, b.cachedTokens),
    // index.js logs the wire names too; keep both spellings when present
    prompt_tokens: sum(a.prompt_tokens, b.prompt_tokens),
    completion_tokens: sum(a.completion_tokens, b.completion_tokens)
  }
}

class AmdToolsClient {
  /**
   * Drop-in replacement for AmdClient at the call site, with the same
   * constructor contract and the same getStats() shape (plus tool metrics,
   * standard model limit awareness, proactive compaction, and multi-stage
   * graceful degradation).
   */
  constructor ({
    apiKey,
    baseUrl,
    model,
    timeoutMs = 20_000,
    maxRetries = 2,
    temperature = 0.25,
    maxTokens = null,
    contextWindow = null,
    maxOutputTokens = null,
    proactiveRatio = 0.75,
    reserveOutputRatio = 0.25,
    discoverModels = true,
    toolChoice = 'required',
    maxConcurrent = 2,
    chatTimeoutMs = null,
    chatMaxRetries = 1,
    // The ceiling an adaptive deadline may grow to. Both are far above the
    // configured base because a reasoning model on a busy endpoint really can
    // take minutes; the point is that a deadline is never *shorter* than the
    // endpoint has shown it needs.
    maxTimeoutMs = 180_000,
    chatMaxTimeoutMs = 120_000,
    stream = true,
    streamIdleTimeoutMs = 45_000,
    rpm = 18,
    chatReserve = 4,
    actionReasoningEffort = 'low',
    chatReasoningEffort = 'low',
    onRequest = null
  }) {
    if (!apiKey) {
      throw new Error('AMD API key missing: set AMD_API_KEY (or API_KEY / RADEON_API_KEY)')
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.temperature = temperature
    this.maxTokens = positiveInt(maxTokens, 16, 500_000)
    this._apiKey = String(apiKey)

    this.budget = new ContextBudget({
      model,
      contextWindow,
      maxOutputTokens,
      proactiveRatio,
      reserveOutputRatio
    })

    this.stats = {
      requests: 0,
      failures: 0,
      retries: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      callsWithCacheInfo: 0,
      toolCalls: 0,
      jsonFallbacks: 0,
      unknownToolCalls: 0,
      chatReplies: 0,
      compactions: 0,
      proactiveCompactions: 0,
      reactiveCompactions: 0,
      degradedRecoveries: 0,
      contextOverflows: 0,
      aborted: 0,
      timeouts: 0,
      rateWaits: 0,
      streamedResponses: 0
    }
    this.toolChoice = toolChoice
    this.parallelToolCalls = true
    this.maxToolCalls = 6
    this.maxConcurrent = Math.max(1, Math.trunc(Number(maxConcurrent)) || 1)
    this.maxTimeoutMs = Math.max(this.timeoutMs, Number(maxTimeoutMs) || 180_000)
    this.chatTimeoutMs = Number.isFinite(chatTimeoutMs) && chatTimeoutMs > 0 ? chatTimeoutMs : Math.min(timeoutMs, 90_000)
    this.chatMaxTimeoutMs = Math.max(this.chatTimeoutMs, Number(chatMaxTimeoutMs) || 120_000)
    this.chatMaxRetries = Math.max(0, Math.min(maxRetries, Math.trunc(Number(chatMaxRetries)) || 0))
    this.streamEnabled = stream !== false
    this.streamSupported = this.streamEnabled ? null : false
    this.streamOptionsSupported = this.streamEnabled ? null : false
    this.streamIdleTimeoutMs = Number.isFinite(Number(streamIdleTimeoutMs)) && Number(streamIdleTimeoutMs) > 0
      ? Number(streamIdleTimeoutMs)
      : 45_000
    this.rpm = Number.isFinite(Number(rpm)) && Number(rpm) > 0 ? Math.max(1, Math.trunc(Number(rpm))) : 18
    this.chatReserve = Number.isFinite(Number(chatReserve)) && Number(chatReserve) >= 0 ? Math.trunc(Number(chatReserve)) : 4
    this.actionReasoningEffort = normalizeReasoningEffort(actionReasoningEffort)
    this.chatReasoningEffort = normalizeReasoningEffort(chatReasoningEffort)
    this.onRequest = typeof onRequest === 'function' ? onRequest : null
    this._rateCalls = []
    this._cooldownUntil = 0
    this._rateLock = Promise.resolve()
    this._queue = []
    this._running = new Set()
    // Latency samples per lane: a chat reply and a 41-tool action call have
    // nothing in common in size, and mixing them made the chat lane inherit the
    // action lane's slow p90 (and vice versa).
    this._latencies = []
    this._latenciesByLane = { action: [], chat: [] }
    this._timeoutGrowth = { action: 1, chat: 1 }
    this.visionSupported = null
    this.reasoningEffortSupported = null
    this._discoverModels = discoverModels !== false
    this._modelsDiscoveryPromise = null
  }

  /**
   * Lazily query `GET {baseUrl}/models` once per client to discover endpoint-
   * advertised `context_length` / `max_model_len` / `max_output_tokens`.
   * Fails silently on 404/network error so tests and non-standard proxies work.
   */
  discoverModelLimits () {
    if (!this._discoverModels) return Promise.resolve(false)
    if (this._modelsDiscoveryPromise) return this._modelsDiscoveryPromise
    const url = `${this.baseUrl}/models`
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      'User-Agent': 'mineflayer-zincai/3.0'
    }
    const timeout = Math.min(2_500, Math.max(500, this.timeoutMs || 2_500))
    this._modelsDiscoveryPromise = (async () => {
      try {
        const res = await this._fetchWithTimeout(url, { method: 'GET', headers }, timeout)
        if (!res.ok) return false
        const data = await res.json().catch(() => null)
        const updated = this.budget.applyModelMetadata(data)
        if (updated) {
          logger.info(TAG, `discovered model limits for ${this.model}: context=${this.budget.contextWindow}, maxOutput=${this.budget.maxOutputTokens} (via /models)`)
        }
        return updated
      } catch {
        return false
      }
    })()
    return this._modelsDiscoveryPromise
  }

  _recordLatency (ms, lane = 'action') {
    if (!Number.isFinite(ms) || ms <= 0) return
    this._latencies.push(ms)
    if (this._latencies.length > 16) this._latencies.shift()
    const list = this._latenciesByLane[lane] || (this._latenciesByLane[lane] = [])
    list.push(ms)
    // Eight samples is enough to see a climbing p90 without remembering a whole session.
    if (list.length > 8) list.shift()
  }

  /**
   * A deadline that turned out to be too short: remember the next one.
   *
   * Kept apart from the latency samples on purpose — an expired deadline only
   * tells us the answer takes LONGER than `expiredMs`, so `expiredMs / 2` is
   * the honest floor: it is the fastest answer consistent with that deadline
   * having expired, and a real (slower) timing sample supersedes it next call.
   */
  _noteTimeout (expiredMs, lane = 'action') {
    const floor = Math.max(1, Math.round(expiredMs / 2))
    const list = this._latenciesByLane[lane] || (this._latenciesByLane[lane] = [])
    list.push(floor)
    if (list.length > 8) list.shift()
    const base = Math.max(1, this._baseTimeoutFor(lane))
    const capFactor = this._capFor(lane) / base
    const needed = (expiredMs * 1.5) / base
    this._timeoutGrowth[lane] = Math.min(capFactor, Math.max(this._timeoutGrowth[lane] || 1, needed))
  }

  _baseTimeoutFor (lane) { return lane === 'chat' ? this.chatTimeoutMs : this.timeoutMs }
  _capFor (lane) { return lane === 'chat' ? this.chatMaxTimeoutMs : this.maxTimeoutMs }

  /**
   * The per-attempt timeout for one call.
   *
   * Three things used to go wrong here, and all of them produce the "retryable
   * timeout" lines operators see in bursts:
   *
   *   1. The p90 was taken over EVERY call of the process, so a slow action
   *      turn stretched the chat lane's budget and a burst of chat stretched
   *      the action lane's. Samples are now per lane.
   *
   *   2. A deadline that expired taught the client NOTHING: the next call used
   *      the same too-short number, timed out again, and the burst repeated
   *      forever. A timeout is now remembered (see _noteTimeout), which raised
   *      the cap from 180 s to the configurable `maxTimeoutMs`.
   *
   *   3. The factor only ever grew. When the endpoint recovered, every call
   *      sat on a deadline far longer than the answer needed, so one dead
   *      request held a lane for minutes before the retry it was always going
   *      to need. The factor now also DECAYS, one 10 % step per successful
   *      call, back to the configured base.
   */
  _effectiveTimeoutMs (baseMs, maxCapMs = 180_000, lane = 'action') {
    // Preserve explicit short timeouts used in unit tests and low-timeout configs.
    if (!Number.isFinite(baseMs) || baseMs < 10_000) return baseMs
    const samples = this._latenciesByLane[lane] || []
    const growth = this._timeoutGrowth[lane] || 1
    if (samples.length < 2) return Math.min(maxCapMs, Math.round(baseMs * growth))
    const sorted = [...samples].sort((a, b) => a - b)
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
    const target = Math.max(1, Math.min(maxCapMs / baseMs, (p90 * 1.5) / baseMs))
    // Rise at once (a slow endpoint must not be cut off), fall slowly (one fast
    // answer is not proof that the endpoint recovered).
    const next = target > growth ? target : growth - 0.1
    this._timeoutGrowth[lane] = Math.max(1, Math.min(next, maxCapMs / baseMs))
    return Math.min(maxCapMs, Math.round(baseMs * this._timeoutGrowth[lane]))
  }

  _defaultReasoningParams (lane = 'action') {
    if (this.reasoningEffortSupported === false) return null
    const effort = lane === 'chat' ? this.chatReasoningEffort : this.actionReasoningEffort
    return effort ? { reasoning_effort: effort } : null
  }

  async _waitForRateSlot (lane = 'action', signal = null, isRetry = false) {
    for (;;) {
      if (signal?.aborted) {
        const cancelled = new Error('request cancelled by the caller')
        cancelled.name = 'AbortError'
        cancelled.code = 'ZINCAI_ABORTED'
        throw cancelled
      }
      let waitMs = 0
      const step = this._rateLock.then(() => {
        const now = Date.now()
        while (this._rateCalls.length && now - this._rateCalls[0].at >= 60_000) {
          this._rateCalls.shift()
        }
        if (this._cooldownUntil > now) {
          waitMs = this._cooldownUntil - now
          return
        }
        if (this.rpm > 0) {
          if (this._rateCalls.length >= this.rpm) {
            waitMs = Math.max(25, this._rateCalls[0].at + 60_000 - now + 25)
            return
          }
          if (lane !== 'chat' && this.chatReserve > 0) {
            const actionCap = Math.max(1, this.rpm - this.chatReserve)
            const actionCalls = this._rateCalls.filter((c) => c.lane !== 'chat')
            if (actionCalls.length >= actionCap) {
              waitMs = Math.max(25, actionCalls[0].at + 60_000 - now + 25)
              return
            }
          }
        }
        this._rateCalls.push({ at: now, lane })
        if (this.onRequest) {
          try { this.onRequest(lane, { isRetry }) } catch { /* noop */ }
        }
      })
      this._rateLock = step.catch(() => {})
      await step
      if (waitMs <= 0) return
      this.stats.rateWaits = (this.stats.rateWaits || 0) + 1
      await sleep(Math.min(waitMs, 5_000), signal)
    }
  }

  /**
   * Fetch with a timeout, and optionally with an OUTSIDE signal.
   *
   * The outside signal is how a player's chat line breaks an in-flight thought:
   * the caller aborts, the request dies where the tokens were about to come
   * from, and the harness decides what the discarded turn meant. Without it the
   * only interruption possible was to throw the answer away after paying for it.
   */
  async _fetchWithTimeout (url, options, timeoutMs, externalSignal = null) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = () => controller.abort()
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (err) {
      // Which clock rang? The caller's cancellation is NOT a timeout: retrying
      // it re-sends a request nobody is waiting for any more, three times, and
      // that is exactly how a preempted turn turns into a burst of
      // "retryable timeout" lines.
      if (err && typeof err === 'object') {
        if (externalSignal?.aborted) {
          err.zincaiCallerAbort = true
        } else if (controller.signal.aborted) {
          err.zincaiTimedOut = true
        }
      }
      throw err
    } finally {
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }

  async _readSseCompletion (res, { stallTimeoutMs, maxTotalMs, signal = null }) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.json()
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    const controller = new AbortController()
    let timedOut = false
    let callerAborted = false
    const onExternalAbort = () => {
      callerAborted = true
      controller.abort()
      try { reader.cancel() } catch { /* noop */ }
    }
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    let stallTimer = null
    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
        try { reader.cancel() } catch { /* noop */ }
      }, stallTimeoutMs)
    }
    const totalTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
      try { reader.cancel() } catch { /* noop */ }
    }, maxTotalMs)
    resetStall()

    let buffer = ''
    let content = ''
    let hasContent = false
    let reasoning = ''
    let finishReason = null
    let usage = null
    const toolCallsByIdx = new Map()
    let sawEvent = false

    const applyChunk = (evt) => {
      if (!evt || typeof evt !== 'object') return
      sawEvent = true
      if (evt.usage) usage = evt.usage
      const choice = evt.choices?.[0]
      if (!choice) return
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason
      }
      const delta = choice.delta || choice.message
      if (!delta || typeof delta !== 'object') return
      if (typeof delta.content === 'string') {
        content += delta.content
        hasContent = true
      }
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number.isFinite(tc?.index) ? tc.index : 0
          let acc = toolCallsByIdx.get(idx)
          if (!acc) {
            acc = { id: tc?.id || `call_${idx + 1}`, type: tc?.type || 'function', function: { name: '', arguments: '' } }
            toolCallsByIdx.set(idx, acc)
          }
          if (tc?.id) acc.id = tc.id
          if (tc?.type) acc.type = tc.type
          if (tc?.function?.name) acc.function.name += tc.function.name
          if (typeof tc?.function?.arguments === 'string') acc.function.arguments += tc.function.arguments
        }
      }
    }

    try {
      for (;;) {
        if (controller.signal.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        resetStall()
        buffer += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line || line.startsWith(':')) continue
          if (!line.startsWith('data:')) continue
          const dataStr = line.slice(5).trim()
          if (!dataStr || dataStr === '[DONE]') continue
          try {
            applyChunk(JSON.parse(dataStr))
          } catch {
            /* ignore malformed keepalive/partial event line */
          }
        }
      }
      buffer += decoder.decode()
      for (const rawLine of buffer.split('\n')) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const dataStr = line.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') continue
        try { applyChunk(JSON.parse(dataStr)) } catch { /* noop */ }
      }
      if (callerAborted || signal?.aborted) {
        const err = new Error('request cancelled by the caller')
        err.name = 'AbortError'
        err.zincaiCallerAbort = true
        throw err
      }
      if (timedOut) {
        const err = new Error('stream stalled or exceeded deadline')
        err.name = 'AbortError'
        err.zincaiTimedOut = true
        throw err
      }
      if (!sawEvent) {
        const err = new TypeError('SSE stream ended before any completion chunks arrived')
        throw err
      }
      const toolCalls = [...toolCallsByIdx.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tc]) => tc)
      const message = {
        role: 'assistant',
        content: hasContent ? content : null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
      this.stats.streamedResponses = (this.stats.streamedResponses || 0) + 1
      return {
        choices: [{ message, finish_reason: finishReason }],
        ...(usage ? { usage } : {})
      }
    } catch (err) {
      if (err && typeof err === 'object') {
        if (callerAborted || signal?.aborted) err.zincaiCallerAbort = true
        else if (timedOut) err.zincaiTimedOut = true
      }
      throw err
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      clearTimeout(totalTimer)
      if (signal) signal.removeEventListener('abort', onExternalAbort)
      try { reader.releaseLock() } catch { /* noop */ }
    }
  }

  /**
   * One request, retried on 429/5xx/timeouts. Calls of the same lane run one
   * after another; different lanes may run side by side (up to
   * `maxConcurrent`), and a waiting chat call is always started first.
   * @returns {Promise<{message:object, usage:object, raw:object}>}
   */
  _complete ({
    messages,
    tools,
    maxTokens = this.maxTokens,
    temperature = this.temperature,
    lane = 'action',
    timeoutMs = this.timeoutMs,
    maxRetries = this.maxRetries,
    signal = null,
    parallel = lane !== 'chat',
    toolChoice = null,
    extraParams = null
  }) {
    return new Promise((resolve, reject) => {
      this._queue.push({
        lane,
        resolve,
        reject,
        run: () => this._completeNow({ messages, tools, maxTokens, temperature, lane, timeoutMs, maxRetries, signal, parallel, toolChoice, extraParams })
      })
      this._pump()
    })
  }

  _pump () {
    while (this._running.size < this.maxConcurrent && this._queue.length) {
      const free = (job) => !this._running.has(job.lane)
      let i = this._queue.findIndex((job) => job.lane === 'chat' && free(job))
      if (i < 0) i = this._queue.findIndex(free)
      if (i < 0) return
      const [job] = this._queue.splice(i, 1)
      this._running.add(job.lane)
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => { this._running.delete(job.lane); this._pump() })
    }
  }

  async _completeNow ({
    messages,
    tools,
    maxTokens,
    temperature,
    lane = 'action',
    timeoutMs = this.timeoutMs,
    maxRetries = this.maxRetries,
    signal = null,
    parallel = true,
    toolChoice = null,
    extraParams = null
  }) {
    const url = `${this.baseUrl}/chat/completions`
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mineflayer-zincai/3.0'
    }

    let attempt = 0
    let lastError = null
    let effectiveMaxTokens = positiveInt(maxTokens, 16, 500_000)
    const defaultExtra = this._defaultReasoningParams(lane)
    let effectiveExtra = (defaultExtra || (extraParams && typeof extraParams === 'object'))
      ? { ...(defaultExtra || {}), ...(extraParams && typeof extraParams === 'object' ? extraParams : {}) }
      : null
    let clampedOutputOnce = false
    const externalAbort = () => Boolean(signal?.aborted)
    // How far a retry of THIS call may grow its deadline: three times the
    // budget it started with, never past the lane's configured ceiling. A test
    // or a test harness that pins a short timeout stays short.
    const maxTimeoutMs = Math.min(this._capFor(lane), Math.max(timeoutMs, Math.round(timeoutMs * 3)))

    while (attempt <= maxRetries) {
      if (attempt > 0) {
        this.stats.retries += 1
        // The backoff is cancellable too: a preempted turn must die AT ONCE,
        // not after this request's remaining retries have been slept through.
        await sleep(backoffMs(attempt - 1), signal)
      }
      // Checked per attempt: a retry is a fresh request even if the first was
      // allowed to start.
      if (externalAbort()) {
        const cancelled = new Error('request cancelled by the caller')
        cancelled.name = 'AbortError'
        cancelled.code = 'ZINCAI_ABORTED'
        throw cancelled
      }
      await this._waitForRateSlot(lane, signal, attempt > 0)
      attempt += 1
      this.stats.requests += 1
      const withImages = hasImages(messages)
      const activeToolChoice = toolChoice || this.toolChoice
      const useStream = this.streamEnabled && this.streamSupported !== false
      const payload = buildToolsPayload({
        model: this.model,
        messages,
        temperature,
        maxTokens: effectiveMaxTokens,
        tools,
        toolChoice: activeToolChoice,
        parallelToolCalls: this.parallelToolCalls === null ? null : (parallel && this.parallelToolCalls !== false),
        stream: useStream,
        streamOptions: useStream && this.streamOptionsSupported !== false ? { include_usage: true } : null,
        extraParams: effectiveExtra
      })
      const promptChars = measureMessages(messages).chars + measureTools(tools)
      const startedAt = Date.now()
      try {
        if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err }
        const res = await this._fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, timeoutMs, signal)

        if (res.status === 429 || res.status >= 500) {
          const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers?.get?.('retry-after')) : null
          if (retryAfterMs) {
            this._cooldownUntil = Math.max(this._cooldownUntil, Date.now() + retryAfterMs)
          }
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 200), this._apiKey)
          lastError = new Error(`HTTP ${res.status}: ${snippet}`)
          logger.warn(TAG, `retryable HTTP ${res.status}${retryAfterMs ? ` (Retry-After ${Math.round(retryAfterMs / 1000)}s)` : ''} (attempt ${attempt}/${maxRetries + 1})`)
          continue
        }

        if (!res.ok) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 350), this._apiKey)
          if (res.status === 400 && payload.stream_options && /stream_options|include_usage/i.test(snippet)) {
            if (this.streamOptionsSupported !== false) logger.warn(TAG, 'endpoint rejected stream_options — omitting stream_options for this session')
            this.streamOptionsSupported = false
            attempt -= 1
            continue
          }
          if (res.status === 400 && payload.stream && /stream/i.test(snippet)) {
            if (this.streamSupported !== false) logger.warn(TAG, 'endpoint rejected stream=true — falling back to non-streaming for this session')
            this.streamSupported = false
            attempt -= 1
            continue
          }
          if (res.status === 400 && payload.tool_choice === 'required' && /tool_choice|required/i.test(snippet)) {
            if (this.toolChoice === 'required') logger.warn(TAG, 'endpoint rejected tool_choice "required" — falling back to "auto" for this session')
            this.toolChoice = 'auto'
            attempt -= 1
            continue
          }
          if (res.status === 400 && 'parallel_tool_calls' in payload && /parallel_tool_calls|parallel/i.test(snippet)) {
            if (this.parallelToolCalls !== null) logger.warn(TAG, 'endpoint rejected parallel_tool_calls — omitting the field for this session')
            this.parallelToolCalls = null
            attempt -= 1
            continue
          }
          const limitInfo = res.status === 400 ? this.budget.learnFromError(snippet) : null
          if (res.status === 400 && effectiveExtra && (limitInfo?.isUnsupportedParam || /reasoning_effort|enable_thinking|chat_template_kwargs/i.test(snippet))) {
            this.reasoningEffortSupported = false
            effectiveExtra = null
            attempt -= 1
            continue
          }
          if (res.status === 400 && limitInfo?.isOutputLimitError && !limitInfo?.isContextOverflow && effectiveMaxTokens !== null && !clampedOutputOnce) {
            clampedOutputOnce = true
            effectiveMaxTokens = limitInfo.learnedOutput
              ? Math.min(effectiveMaxTokens, limitInfo.learnedOutput)
              : null
            attempt -= 1
            continue
          }
          this.stats.failures += 1
          const failure = new Error(`HTTP ${res.status}: ${snippet}`)
          failure.status = res.status
          if (withImages && [400, 404, 415, 422].includes(res.status)) failure.imagesRejected = true
          if (limitInfo?.isContextOverflow) failure.contextOverflow = true
          if (limitInfo?.isOutputLimitError) failure.outputLimitExceeded = true
          if (limitInfo) failure.limitInfo = limitInfo
          throw failure
        }

        const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase()
        const isSse = ctype.includes('text/event-stream')
        const stallMs = timeoutMs >= 10_000 ? Math.min(timeoutMs, this.streamIdleTimeoutMs) : timeoutMs
        const maxTotalMs = Math.max(timeoutMs * 2, this._capFor(lane) * 2)
        const data = isSse
          ? await this._readSseCompletion(res, { stallTimeoutMs: stallMs, maxTotalMs, signal })
          : await res.json()
        const message = data?.choices?.[0]?.message
        // A reasoning model cut off mid-thought answers with `content: null`
        // and only `reasoning_content`: that is a truncated answer, not a
        // malformed one — it must reach the rescue path, not throw.
        if (message && typeof message.content !== 'string' && !Array.isArray(message.tool_calls) &&
            (data?.choices?.[0]?.finish_reason === 'length' || typeof message.reasoning_content === 'string' || typeof message.reasoning === 'string')) {
          message.content = ''
        }
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          this.stats.failures += 1
          throw new Error('Malformed response: choices[0].message has neither content nor tool_calls')
        }
        const usage = parseUsage(data?.usage)
        if (usage.promptTokens !== null) {
          this.stats.promptTokens += usage.promptTokens
          this.stats.completionTokens += usage.completionTokens || 0
          this.budget.observeUsage({ promptChars, promptTokens: usage.promptTokens })
          if (usage.cachedTokens !== null) {
            this.stats.cachedTokens += usage.cachedTokens
            this.stats.callsWithCacheInfo += 1
          }
        }
        const finishReason = data?.choices?.[0]?.finish_reason ?? null
        if (withImages) this.visionSupported = true
        this._recordLatency(Date.now() - startedAt, lane)
        return { message, usage, raw: data, finishReason }
      } catch (err) {
        // The caller cancelled (a chat line preempting this thought, a session
        // ending): nothing is waiting for the answer any more, so a retry is a
        // wasted request that also logs a fake "timeout".
        if (externalAbort() || err?.zincaiCallerAbort) {
          this.stats.aborted = (this.stats.aborted || 0) + 1
          const cancelled = new Error('request cancelled by the caller')
          cancelled.name = 'AbortError'
          cancelled.code = 'ZINCAI_ABORTED'
          throw cancelled
        }
        // A deadline WE set: one attempt, but say which one and why, with the
        // timeout that produced it, so a burst is readable at a glance.
        if (err?.zincaiTimedOut) {
          this.stats.timeouts = (this.stats.timeouts || 0) + 1
          const waited = timeoutMs
          // The deadline that expired is evidence about this endpoint: the NEXT
          // call of this lane starts with a budget that already fits, instead of
          // timing out once more on the same too-short number.
          this._noteTimeout(waited, lane)
          // A deadline that expired says the endpoint is slower than we
          // allowed. Give the retry a longer one (up to the lane cap) instead
          // of spending all three attempts on the same too-short number.
          timeoutMs = Math.min(maxTimeoutMs, Math.round(waited * 1.5))
          lastError = new Error(`no response within ${Math.round(waited / 1000)}s (attempt ${attempt}/${maxRetries + 1})`)
          logger.warn(TAG, `retryable timeout: no response from the endpoint within ${Math.round(waited / 1000)}s (attempt ${attempt}/${maxRetries + 1})${attempt <= maxRetries ? ` — retrying with ${Math.round(timeoutMs / 1000)}s` : ''}`)
          continue
        }
        const isAbort = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))
        const isNetwork = err instanceof TypeError
        if (isAbort || isNetwork) {
          lastError = new Error(redactSecrets(err.message || String(err), this._apiKey))
          logger.warn(TAG, `retryable ${isAbort ? 'timeout' : 'network'} error (attempt ${attempt}/${maxRetries + 1})`)
          continue
        }
        throw err
      }
    }

    this.stats.failures += 1
    throw lastError || new Error('AMD request failed after retries')
  }

  /**
   * Apply a compaction level via caller-provided domain compactor (preserving
   * memories/goals) or fall back to generic message-level compaction.
   */
  _applyCompaction (messages, tools, level, { compact = null, reason = 'compaction', lane = 'action', beforeTokens = 0, budget = null } = {}) {
    if (level <= 0) return { messages, tools }
    if (typeof compact === 'function') {
      const built = compact(level, { reason, lane, beforeTokens, budget })
      if (Array.isArray(built)) {
        return { messages: built, tools }
      }
      if (built && typeof built === 'object') {
        return {
          messages: Array.isArray(built.messages) ? built.messages : messages,
          tools: built.tools !== undefined ? built.tools : tools
        }
      }
    }
    return {
      messages: compactMessagesFallback(messages, { level }),
      tools
    }
  }

  /**
   * Pre-flight proactive compaction: checks estimated prompt size against the
   * model's standard context window minus output/reasoning headroom and compacts
   * BEFORE hitting the limit, stepping up only as far as needed so memories stay
   * intact.
   */
  async _prepareMessages (messages, tools, { lane = 'action', explicitMaxTokens = null, initialLevel = 0, compact = null, onCompaction = null } = {}) {
    await this.discoverModelLimits()
    let activeMessages = messages
    let activeTools = tools
    let est = this.budget.estimateTokens(activeMessages, activeTools)
    const plan = this.budget.planCompaction({
      estimatedTokens: est.totalTokens,
      floor: initialLevel,
      lane,
      explicitMaxTokens
    })

    let level = 0
    if (plan.level > 0) {
      const beforeTokens = est.totalTokens
      for (let lvl = plan.level; lvl <= 4; lvl++) {
        const next = this._applyCompaction(activeMessages, activeTools, lvl, {
          compact,
          reason: plan.reason,
          lane,
          beforeTokens,
          budget: plan
        })
        activeMessages = this.visionSupported === false && hasImages(next.messages)
          ? stripImages(next.messages)
          : next.messages
        activeTools = next.tools
        level = lvl
        est = this.budget.estimateTokens(activeMessages, activeTools)
        if (est.totalTokens <= plan.hardPromptBudget) break
      }
      // If even survival-level user compaction cannot leave minimum output headroom
      // because the endpoint's context window is too small for all 41 tool schemas,
      // proactively degrade to the compact core toolset before hitting HTTP 400.
      const minFitLimit = plan.contextWindow - Math.max(1_024, Math.min(plan.outputReserve, 2_048))
      if (lane === 'action' && est.totalTokens > minFitLimit && Array.isArray(activeTools) && activeTools.length > 15) {
        activeTools = createRecoveryTools()
        est = this.budget.estimateTokens(activeMessages, activeTools)
      }
      this.stats.compactions += 1
      if (plan.proactive) this.stats.proactiveCompactions += 1
      const info = {
        phase: 'proactive',
        lane,
        level,
        reason: plan.reason,
        beforeTokens,
        afterTokens: est.totalTokens,
        contextWindow: plan.contextWindow,
        softCompactAt: plan.softCompactAt,
        hardPromptBudget: plan.hardPromptBudget,
        outputReserve: plan.outputReserve
      }
      logger.info(TAG, `proactive compaction (${lane}, L${level}, ${plan.reason}): ~${beforeTokens} -> ~${est.totalTokens} tok (budget ${plan.hardPromptBudget} / ctx ${plan.contextWindow}, output headroom ${plan.outputReserve})`)
      if (typeof onCompaction === 'function') {
        try { onCompaction(info) } catch { /* telemetry best effort */ }
      }
    }

    return {
      messages: activeMessages,
      tools: activeTools,
      level,
      estimatedTokens: est.totalTokens,
      plan
    }
  }

  /**
   * One tool-enabled completion for the ACTION lane, with proactive pre-limit
   * compaction, HTTP 400 context-overflow recovery, and 3-stage graceful
   * degradation on truncation (`finish_reason === 'length'`) or invalid calls.
   *
   * @param {{role:string, content:string}[]} messages
   * @param {object[]} tools OpenAI-format tools (see createZincTools)
   * @returns {Promise<{action:object, actions:object[], reasoning:string, content:string, finishReason:string|null, usage:object, raw:object, compactionLevel:number, degraded:boolean}>}
   */
  async chatWithTools (messages, tools = createZincTools(), { signal = null, compact = null, onCompaction = null, initialLevel = 0 } = {}) {
    if (this.visionSupported === false && hasImages(messages)) messages = stripImages(messages)

    const prepared = await this._prepareMessages(messages, tools, {
      lane: 'action',
      explicitMaxTokens: this.maxTokens,
      initialLevel,
      compact,
      onCompaction
    })
    let activeMessages = prepared.messages
    let activeTools = prepared.tools
    let compactionLevel = prepared.level
    let degraded = false
    let recoveryStage = 0

    const ask = (msgs, activeSet, extra = {}) => this._complete({
      messages: msgs,
      tools: activeSet,
      lane: 'action',
      timeoutMs: this._effectiveTimeoutMs(this.timeoutMs, this.maxTimeoutMs, 'action'),
      ...extra
    })

    const notifyReactive = (info) => {
      this.stats.compactions += 1
      this.stats.reactiveCompactions += 1
      if (typeof onCompaction === 'function') {
        try { onCompaction({ phase: 'reactive', lane: 'action', ...info }) } catch { /* noop */ }
      }
    }

    let first
    let primaryMaxTokens = this.maxTokens
    try {
      try {
        first = await ask(activeMessages, activeTools, { signal, maxTokens: primaryMaxTokens })
      } catch (err) {
        if (err?.imagesRejected) {
          if (this.visionSupported !== false) logger.warn(TAG, `endpoint rejected the image input (HTTP ${err.status}) — screenshots are text-only for this session`)
          this.visionSupported = false
          activeMessages = stripImages(activeMessages)
          first = await ask(activeMessages, activeTools, { signal, maxTokens: primaryMaxTokens })
        } else if (err?.contextOverflow) {
          // Reactive HTTP 400 context-overflow recovery: compact progressively and
          // degrade tool schema size if survival compaction is still over the window.
          this.stats.contextOverflows += 1
          let overflowErr = err
          let recovered = null
          for (let stage = 1; stage <= 3 && !recovered; stage++) {
            const beforeTok = this.budget.estimateTokens(activeMessages, activeTools).totalTokens
            const targetLevel = Math.min(4, Math.max(compactionLevel + 1, stage === 1 ? 2 : stage + 1))
            const shrunk = this._applyCompaction(activeMessages, activeTools, targetLevel, {
              compact,
              reason: 'context_overflow',
              lane: 'action',
              beforeTokens: beforeTok
            })
            activeMessages = this.visionSupported === false && hasImages(shrunk.messages) ? stripImages(shrunk.messages) : shrunk.messages
            compactionLevel = targetLevel
            if (stage >= 2) {
              activeTools = createRecoveryTools()
              degraded = true
            }
            const afterTok = this.budget.estimateTokens(activeMessages, activeTools).totalTokens
            const safeOut = primaryMaxTokens !== null
              ? Math.min(primaryMaxTokens, this.budget.room({ lane: 'action' }).availableOutputFor(afterTok))
              : null
            recoveryStage = stage
            logger.warn(TAG, `context overflow (HTTP 400) — reactive compaction stage ${stage} (L${compactionLevel}${degraded ? ', compact-tools' : ''}): ~${beforeTok} -> ~${afterTok} tok (ctx ${this.budget.contextWindow})`)
            notifyReactive({ stage, level: compactionLevel, reason: 'context_overflow', beforeTokens: beforeTok, afterTokens: afterTok, degraded })
            try {
              recovered = await ask(activeMessages, activeTools, {
                signal,
                maxTokens: safeOut,
                ...(degraded ? { toolChoice: 'auto', parallel: false } : {})
              })
              if (degraded) this.stats.degradedRecoveries += 1
            } catch (retryErr) {
              overflowErr = retryErr
              if (!retryErr?.contextOverflow) throw retryErr
            }
          }
          if (!recovered) throw overflowErr
          first = recovered
        } else {
          throw err
        }
      }
    } catch (err) {
      if (err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))) {
        this.stats.aborted = (this.stats.aborted || 0) + 1
        const interrupted = { a: 'idle', _interrupted: true }
        return {
          action: interrupted,
          actions: [interrupted],
          message: null,
          reasoning: '',
          content: '',
          finishReason: 'aborted',
          usage: null,
          raw: null,
          compactionLevel,
          degraded
        }
      }
      throw err
    }

    const extractFrom = (msg, toolSet) => {
      const offered = new Set(toolSet.map((t) => t.function?.name))
      const all = coerceActions(msg, { max: this.maxToolCalls }).map((a) => (a._via && !offered.has(a.a) ? { a: 'idle', _unknownTool: a.a, _callId: a._callId } : a))
      let primary = all[0]
      if (primary._via && !offered.has(primary.a)) primary = { a: 'idle', _unknownTool: primary.a }
      return { offered, all, primary }
    }

    let { offered, all, primary: action } = extractFrom(first.message, activeTools)

    const describeFailure = (a, finish) => finish === 'length'
      ? 'truncated (length)'
      : a._unknownTool ? `unknown "${a._unknownTool}"` : a._badArgs ? `bad args (${a._badArgs})` : a._prose ? 'prose' : 'empty'
    const usable = (a, set = offered) => Boolean(a._via && set.has(a.a) && !a._unknownTool && !a._badArgs)
    const isBroke = (a, finish, set = offered) => Boolean(a._unknownTool || a._badArgs || (!a._via && a._fallback && !a._prose) || (finish === 'length' && !usable(a, set)))

    let current = first
    let totalUsage = first.usage
    const thoughts = []
    const r0 = extractReasoning(first.message)
    if (r0) thoughts.push(r0)
    const firstTruncated = first.finishReason === 'length' && !usable(action)
    if (firstTruncated) this.stats.truncatedAnswers = (this.stats.truncatedAnswers || 0) + 1

    if (isBroke(action, current.finishReason)) {
      let lastMaxTokens = primaryMaxTokens
      let rescueMessages = [...activeMessages]
      let rescueTools = activeTools
      let rescueOffered = offered
      const maxAttempts = firstTruncated ? 3 : 2

      for (let attempt = 1; attempt <= maxAttempts && isBroke(action, current.finishReason, rescueOffered); attempt++) {
        const truncated = current.finishReason === 'length'
        let nextMessages
        let nextTools = rescueTools
        let nextToolChoice = null
        let nextParallel = true
        let nextExtra = null
        let nextMaxTokens = lastMaxTokens

        if (truncated) {
          // Reactive compaction even when hitting `length`: shrink prompt to free
          // context & reasoning headroom while preserving memories and goals.
          const beforeTok = this.budget.estimateTokens(rescueMessages, rescueTools).totalTokens
          const targetLevel = Math.min(4, Math.max(compactionLevel + 1, attempt))
          const shrunk = this._applyCompaction(activeMessages, activeTools, targetLevel, {
            compact,
            reason: 'length_truncated',
            lane: 'action',
            beforeTokens: beforeTok
          })
          compactionLevel = targetLevel
          let baseMsgs = this.visionSupported === false && hasImages(shrunk.messages) ? stripImages(shrunk.messages) : shrunk.messages

          // Stage 3 graceful degradation: drop non-essential tool schemas (~80%
          // smaller tool block) with tool_choice='auto' so the model breaks free.
          if (attempt >= 3) {
            nextTools = createRecoveryTools()
            nextToolChoice = 'auto'
            nextParallel = false
            degraded = true
          }

          const nudge = attempt >= 3
            ? 'Context was compacted for recovery. Call ONE essential tool now without lengthy reasoning.'
            : attempt === 2
              ? 'Your answer hit the token limit while reasoning. Decide in one short line and emit the tool call FIRST.'
              : 'Your previous answer ran out of output tokens before calling a tool. Return your tool call(s) immediately.'

          nextMessages = [...baseMsgs, { role: 'user', content: nudge }]
          const afterTok = this.budget.estimateTokens(nextMessages, nextTools).totalTokens
          nextMaxTokens = this.budget.escalatedMaxTokens({
            previousMaxTokens: lastMaxTokens,
            completionTokens: current.usage?.completionTokens || 0,
            estimatedPromptTokens: afterTok,
            attempt,
            lane: 'action'
          })
          if (attempt >= 2 && this.reasoningEffortSupported !== false) {
            nextExtra = { reasoning_effort: 'low' }
          }
          recoveryStage = attempt
          logger.warn(TAG, `action truncation recovery stage ${attempt} (L${compactionLevel}${degraded ? ', compact-tools' : ''}): ~${beforeTok} -> ~${afterTok} tok, max_tokens=${nextMaxTokens}`)
          notifyReactive({ stage: attempt, level: compactionLevel, reason: 'length_truncated', beforeTokens: beforeTok, afterTokens: afterTok, maxTokens: nextMaxTokens, degraded })
        } else {
          // Non-truncation broken call (unknown tool, bad args, empty response).
          const nudge = 'No valid tool was called. Call one of the declared tools now (use say to talk or idle to wait).'
          const badText = typeof current.message?.content === 'string' && current.message.content.trim()
            ? current.message.content.trim().slice(0, 300)
            : null
          if (attempt >= 2 && compactionLevel < 2) {
            const beforeTok = this.budget.estimateTokens(rescueMessages, rescueTools).totalTokens
            const targetLevel = Math.min(4, compactionLevel + 1)
            const shrunk = this._applyCompaction(activeMessages, activeTools, targetLevel, {
              compact,
              reason: 'invalid_tool_retry',
              lane: 'action',
              beforeTokens: beforeTok
            })
            compactionLevel = targetLevel
            rescueMessages = this.visionSupported === false && hasImages(shrunk.messages) ? stripImages(shrunk.messages) : shrunk.messages
            const afterTok = this.budget.estimateTokens(rescueMessages, rescueTools).totalTokens
            notifyReactive({ stage: attempt, level: compactionLevel, reason: 'invalid_tool_retry', beforeTokens: beforeTok, afterTokens: afterTok, degraded: false })
          }
          nextMessages = [
            ...rescueMessages,
            ...(badText ? [{ role: 'assistant', content: badText }] : []),
            { role: 'user', content: nudge }
          ]
          recoveryStage = attempt
        }

        try {
          const next = await ask(nextMessages, nextTools, {
            signal,
            maxTokens: nextMaxTokens,
            ...(nextToolChoice ? { toolChoice: nextToolChoice } : {}),
            parallel: nextParallel,
            ...(nextExtra ? { extraParams: nextExtra } : {})
          })
          lastMaxTokens = nextMaxTokens
          rescueMessages = nextMessages
          rescueTools = nextTools
          totalUsage = mergeUsage(totalUsage, next.usage)
          current = next
          const rNext = extractReasoning(next.message)
          if (rNext) thoughts.push(rNext)

          const parsed = extractFrom(next.message, nextTools)
          rescueOffered = parsed.offered
          action = parsed.primary

          if (usable(action, rescueOffered)) {
            this.stats.rescuedToolCalls = (this.stats.rescuedToolCalls || 0) + 1
            if (degraded) this.stats.degradedRecoveries += 1
            if (action._via === 'tool') this.stats.toolCalls += 1
            else this.stats.jsonFallbacks += 1
            return {
              action,
              actions: parsed.all.length ? parsed.all : [action],
              message: next.message,
              reasoning: thoughts.join('\n---\n'),
              content: typeof next.message.content === 'string' ? next.message.content.trim() : '',
              finishReason: next.finishReason,
              usage: totalUsage,
              raw: next.raw,
              rescued: true,
              degraded,
              recoveryStage,
              compactionLevel
            }
          }
        } catch (err) {
          if (err?.contextOverflow && attempt < maxAttempts) {
            this.stats.contextOverflows += 1
            compactionLevel = Math.min(4, compactionLevel + 1)
            continue
          }
          logger.debug(TAG, `action retry ${attempt} failed: ${err.message || err}`)
          break
        }
      }
      logger.warn(TAG, `model retry still produced no valid tool call (${describeFailure(action, current.finishReason)})`)
      if (current.finishReason === 'length' && !usable(action, rescueOffered)) action = { ...action, _truncated: true }
    }

    if (action._via === 'tool') this.stats.toolCalls += 1
    else if (action._fallback || action._badArgs) this.stats.jsonFallbacks += 1
    if (action._unknownTool) this.stats.unknownToolCalls += 1
    const actions = current === first ? all : [action]
    if (actions.length > 1) this.stats.multiToolAnswers = (this.stats.multiToolAnswers || 0) + 1
    return {
      action,
      actions,
      message: current.message,
      reasoning: thoughts.join('\n---\n'),
      content: typeof current.message.content === 'string' ? current.message.content.trim() : '',
      finishReason: current.finishReason,
      usage: totalUsage,
      raw: current.raw,
      compactionLevel,
      degraded,
      recoveryStage
    }
  }

  /**
   * One completion for the CHAT lane: a short reply, optionally handing a task
   * to the action lane.
   *
   * Uses the model's standard output limit when `maxTokens` is null/unset,
   * compacts proactively before hitting context limits, detects partial
   * mid-sentence length cutoffs, and degrades gracefully to plain-text + clean
   * sentence boundary salvage instead of dropping replies or sending half-words.
   *
   * @returns {Promise<{reply:{text:string, task:string}, reasoning:string, finishReason:string|null, usage:object, compactionLevel:number, degraded:boolean}>}
   */
  async chatReply (messages, { maxTokens = null, compact = null, onCompaction = null, initialLevel = 0 } = {}) {
    const explicitBudget = positiveInt(maxTokens, 16, 500_000)
    const chatTools = createChatTools()
    const prepared = await this._prepareMessages(messages, chatTools, {
      lane: 'chat',
      explicitMaxTokens: explicitBudget,
      initialLevel,
      compact,
      onCompaction
    })
    let activeMessages = prepared.messages
    let compactionLevel = prepared.level
    let degraded = false

    const ask = (msgs, { budget = explicitBudget, tools = chatTools, extraParams = null } = {}) => this._complete({
      messages: msgs,
      tools,
      maxTokens: budget,
      temperature: Math.max(this.temperature, 0.5),
      lane: 'chat',
      timeoutMs: this._effectiveTimeoutMs(this.chatTimeoutMs, this.chatMaxTimeoutMs, 'chat'),
      maxRetries: this.chatMaxRetries,
      ...(extraParams ? { extraParams } : {})
    })

    const notifyReactive = (info) => {
      this.stats.compactions += 1
      this.stats.reactiveCompactions += 1
      if (typeof onCompaction === 'function') {
        try { onCompaction({ phase: 'reactive', lane: 'chat', ...info }) } catch { /* noop */ }
      }
    }

    const isIncomplete = (rep, finish) => {
      if (rep._via !== 'tool' && !rep.text) return true
      if (finish === 'length') {
        const t = String(rep.text || '').trim()
        if (!t) return true
        // Detect mid-sentence cutoff (e.g. "pensando em montar uma ") when the
        // server stopped strictly because of token length.
        if (rep._via !== 'tool' || !/[.!?…]["')\]»”’]?$/.test(t)) return true
      }
      return false
    }

    let first
    try {
      first = await ask(activeMessages, { budget: explicitBudget, tools: chatTools })
    } catch (err) {
      if (!err?.contextOverflow) throw err
      this.stats.contextOverflows += 1
      const beforeTok = this.budget.estimateTokens(activeMessages, chatTools).totalTokens
      const targetLevel = Math.min(4, Math.max(compactionLevel + 1, 2))
      const shrunk = this._applyCompaction(activeMessages, chatTools, targetLevel, {
        compact,
        reason: 'context_overflow',
        lane: 'chat',
        beforeTokens: beforeTok
      })
      activeMessages = shrunk.messages
      compactionLevel = targetLevel
      const afterTok = this.budget.estimateTokens(activeMessages, chatTools).totalTokens
      notifyReactive({ stage: 1, level: compactionLevel, reason: 'context_overflow', beforeTokens: beforeTok, afterTokens: afterTok, degraded: false })
      first = await ask(activeMessages, { budget: explicitBudget, tools: chatTools })
    }

    let { message, usage, finishReason } = first
    this.stats.chatReplies += 1
    let reply = coerceReply(message)
    let bestPartial = reply.text ? { ...reply } : null
    const thoughts = []
    const r0 = extractReasoning(message)
    if (r0) thoughts.push(r0)

    if (isIncomplete(reply, finishReason)) {
      const cutOff = finishReason === 'length'
      let recovered = false

      // Stage 1: Compact chat context (keeping player memories) + escalate output
      // budget + retry the `reply` tool cleanly.
      try {
        const beforeTok = this.budget.estimateTokens(activeMessages, chatTools).totalTokens
        const targetLevel = Math.min(4, compactionLevel + 1)
        const shrunk = this._applyCompaction(activeMessages, chatTools, targetLevel, {
          compact,
          reason: cutOff ? 'length_truncated' : 'empty_chat_retry',
          lane: 'chat',
          beforeTokens: beforeTok
        })
        activeMessages = shrunk.messages
        compactionLevel = targetLevel
        const afterTok = this.budget.estimateTokens(activeMessages, chatTools).totalTokens
        const nextBudget = this.budget.escalatedMaxTokens({
          previousMaxTokens: explicitBudget,
          completionTokens: usage?.completionTokens || 0,
          estimatedPromptTokens: afterTok,
          attempt: 1,
          lane: 'chat'
        })
        notifyReactive({ stage: 1, level: compactionLevel, reason: cutOff ? 'length_truncated' : 'empty_chat_retry', beforeTokens: beforeTok, afterTokens: afterTok, maxTokens: nextBudget, degraded: false })
        const again = await ask(activeMessages, {
          budget: nextBudget,
          tools: chatTools,
          ...(cutOff && this.reasoningEffortSupported !== false ? { extraParams: { reasoning_effort: 'low' } } : {})
        })
        this.stats.chatRetries = (this.stats.chatRetries || 0) + 1
        usage = mergeUsage(usage, again.usage)
        finishReason = again.finishReason
        const r1 = extractReasoning(again.message)
        if (r1) thoughts.push(r1)
        const second = coerceReply(again.message)
        if (second.text && (!bestPartial || second.text.length > bestPartial.text.length)) bestPartial = { ...second }
        if (!isIncomplete(second, again.finishReason)) {
          reply = second
          recovered = true
        }
      } catch (err) {
        logger.debug(TAG, `chat recovery stage 1 failed: ${err.message || err}`)
      }

      // Stage 2: Plain-text graceful degradation (drop tool schema overhead so
      // the model writes the direct chat reply immediately without JSON/tool
      // framing eating output budget).
      if (!recovered) {
        try {
          const beforeTok = this.budget.estimateTokens(activeMessages, null).totalTokens
          const targetLevel = Math.min(4, compactionLevel + 1)
          const shrunk = this._applyCompaction(activeMessages, null, targetLevel, {
            compact,
            reason: 'chat_plain_degradation',
            lane: 'chat',
            beforeTokens: beforeTok
          })
          compactionLevel = targetLevel
          const plainMessages = [
            ...shrunk.messages,
            { role: 'user', content: 'Answer the player directly in 1–2 short natural sentences (plain text only, no JSON or tool syntax).' }
          ]
          const afterTok = this.budget.estimateTokens(plainMessages, null).totalTokens
          const plainBudget = this.budget.escalatedMaxTokens({
            previousMaxTokens: explicitBudget,
            completionTokens: usage?.completionTokens || 0,
            estimatedPromptTokens: afterTok,
            attempt: 2,
            lane: 'chat'
          })
          degraded = true
          notifyReactive({ stage: 2, level: compactionLevel, reason: 'chat_plain_degradation', beforeTokens: beforeTok, afterTokens: afterTok, maxTokens: plainBudget, degraded: true })
          const plain = await ask(plainMessages, {
            budget: plainBudget,
            tools: null,
            ...(this.reasoningEffortSupported !== false ? { extraParams: { reasoning_effort: 'low' } } : {})
          })
          this.stats.chatRetries = (this.stats.chatRetries || 0) + 1
          usage = mergeUsage(usage, plain.usage)
          finishReason = plain.finishReason
          const r2 = extractReasoning(plain.message)
          if (r2) thoughts.push(r2)
          const third = coerceReply(plain.message)
          if (third.text) {
            if (plain.finishReason === 'length') third.text = trimIncompleteSentence(third.text)
            if (third.text) {
              reply = { ...third, _degraded: true }
              this.stats.degradedRecoveries += 1
              recovered = true
            }
          }
        } catch (err) {
          logger.debug(TAG, `chat recovery stage 2 (plain-text) failed: ${err.message || err}`)
        }
      }

      // Stage 3: Clean sentence-boundary salvage if we had partial text rather
      // than dropping the answer or sending a broken half-word.
      if (!recovered) {
        if (bestPartial?.text) {
          const salvaged = trimIncompleteSentence(bestPartial.text)
          if (salvaged) {
            reply = { ...bestPartial, text: salvaged, _degraded: true }
            degraded = true
            this.stats.degradedRecoveries += 1
            recovered = true
          }
        }
        if (!recovered) {
          reply._empty = finishReason === 'length' || cutOff ? 'cut_off' : 'no_call'
        }
      }
    }

    return {
      reply,
      reasoning: thoughts.join('\n---\n'),
      finishReason,
      usage,
      compactionLevel,
      degraded
    }
  }

  /** Telemetry compatible with the session report + tool metrics. */
  getStats () {
    const s = this.stats
    const hitRate = s.cachedTokens > 0 && s.promptTokens > 0 ? s.cachedTokens / s.promptTokens : null
    return {
      ...s,
      avgPromptTokensPerCall: s.requests ? Math.round(s.promptTokens / s.requests) : 0,
      avgCompletionTokensPerCall: s.requests ? Math.round(s.completionTokens / s.requests) : 0,
      kvCacheHitRate: hitRate,
      // The two numbers that explain a "timeout" burst: how many deadlines we
      // actually hit, and how many calls the caller cancelled (those are not
      // failures — a cancelled turn was deliberately replaced).
      timeouts: s.timeouts || 0,
      aborted: s.aborted || 0,
      effectiveTimeouts: {
        action: this._effectiveTimeoutMs(this.timeoutMs, this.maxTimeoutMs, 'action'),
        chat: this._effectiveTimeoutMs(this.chatTimeoutMs, this.chatMaxTimeoutMs, 'chat')
      },
      budget: this.budget.snapshot(),
      uptimeMinutes: Math.round((Date.now() - this._startedAt) / 60_000) || 0
    }
  }

  _startedAt = Date.now()
}

module.exports = { AmdToolsClient, createZincTools, createChatTools, createRecoveryTools, coerceAction, coerceActions, coerceReply, buildToolsPayload, toolTurnMessages, extractReasoning, hasImages, stripImages, contentText, ACTION_TOOLS, CHAT_TOOLS }
