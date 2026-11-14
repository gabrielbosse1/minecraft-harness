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
const logger = require('../src/logger')

const TAG = 'amd'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const backoffMs = (attempt) => Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)

// ---------------------------------------------------------------------------
// Tool schemas — the single source of truth for the System-2 action contract.
// Keep descriptions terse: every token here is re-sent on every call.
// ---------------------------------------------------------------------------
const STR = (description) => ({ type: 'string', description })
const INT = (description) => ({ type: 'integer', description })
const STAGE = STR('Phase: foundation | walls_with_windows | roof | interior_details.')
const AT = { type: 'array', description: 'Origin [x,y,z]; default: feet.', items: { type: 'integer' }, minItems: 3, maxItems: 3 }
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } })

const ACTION_TOOLS = [
  tool('say', 'Send one short chat line out loud — any language, whatever fits who you are talking to (`to` = private).', {
    text: STR('The line, max 200 chars. In the language of the conversation.'),
    to: STR('Recipient player (optional).')
  }, ['text']),
  tool('go_to', 'Walk to a player, saved place, nearby id (chest2, bed1), or [x,y,z]. Routes around mobs and hazards; may break blocks your dig_policy allows.', {
    player: STR('Player name.'),
    place: STR('Saved place or nearby id.'),
    x: INT('X.'),
    y: INT('Y (optional).'),
    z: INT('Z.')
  }),
  tool('dig', 'ONE deliberate corridor: walks to [x,y,z] (or a player/place) breaking what stands in the path, including blocks your dig_policy does not allow (stone, wood…). Use it when go_to reports no path.', {
    player: STR('Target player name.'),
    place: STR('Saved place or nearby id.'),
    x: INT('X of the destination.'),
    y: INT('Y of the destination (optional).'),
    z: INT('Z of the destination.'),
    materials: { type: 'array', description: 'Only these block ids may be broken (e.g. [oak_log, dirt]); default: whatever is in the way, within reach.', items: STR('Block id.'), minItems: 1, maxItems: 16 },
    avoid: { type: 'array', description: 'Never break these block ids.', items: STR('Block id.'), minItems: 1, maxItems: 16 }
  }),
  tool('follow', 'Follow a player until you call stop. Keeps going by itself: it dodges mobs and comes back, waits for a path, and walks to where the player was last seen. Call it ONCE — it does not need repeating.', { player: STR('Player name.') }, ['player']),
  tool('dig_policy', 'Your standing rule for what WALKING (go_to, follow, every errand) may break. No arguments = show it. It is yours to edit and it persists.', {
    can_dig: { type: 'boolean', description: 'Master switch. false = walking never breaks a block.' },
    mode: { type: 'string', enum: ['list', 'all'], description: 'list = only blocks on your list (default: soft terrain). all = anything in the way (doors, containers, bedrock never).' },
    add: { type: 'array', description: 'Block ids to allow, e.g. [stone, cobblestone, oak_log]. `*` is a wildcard (*_planks).', items: STR('Block id.'), minItems: 1, maxItems: 24 },
    remove: { type: 'array', description: 'Block ids to take off the list.', items: STR('Block id.'), minItems: 1, maxItems: 24 },
    reset: { type: 'boolean', description: 'true = back to the shipped soft-block list.' }
  }),
  tool('stop', 'Cancel current task, follow, fight and paused tasks.'),
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
    percent: INT('For update: 0–100.')
  }, ['operation']),
  tool('attack', 'Fight. The ONLY way a fight ever starts. `target` = mob id or "any"; `player` = exact PvP target.', {
    target: STR('Mob type or "any".'),
    player: STR('Exact player name (PvP).'),
    count: INT('Kill limit (default 1 animal; chain hostiles).')
  }),
  tool('hold', 'Accept currently listed threats and continue task unless hit/new threat/lit fuse.'),
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
  tool('equip', 'Equip carried item by name.', {
    item: STR('Item id.'),
    where: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }
  }, ['item']),
  tool('use_block', 'Walk to nearest matching block and right-click it.', { what: STR('Block id.') }, ['what']),
  tool('inspect_block', 'Read one loaded block and state; no power inferred.', { x: INT('X.'), y: INT('Y.'), z: INT('Z.') }, ['x', 'y', 'z']),
  tool('inspect_region', 'Read-only paginated 3D block snapshot around [x,y,z]; no circuit trace.', { x: INT('X.'), y: INT('Y.'), z: INT('Z.'), radius: INT('0–2, default 1.'), page: INT('Page, default 1.') }, ['x', 'y', 'z']),
  tool('redstone_scan', 'Read-only local redstone snapshot (start with x,y,z; page with snapshot id).', { x: INT('X.'), y: INT('Y.'), z: INT('Z.'), radius: INT('0–2, default 1.'), snapshot: STR('Existing snapshot id.'), page: INT('Page, default 1.') }),
  tool('redstone_component', 'Inspect captured redstone component state and neighbors.', { snapshot: STR('Snapshot id.'), x: INT('X.'), y: INT('Y.'), z: INT('Z.'), page: INT('Page, default 1.') }, ['snapshot', 'x', 'y', 'z']),
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
  tool('craft', 'Craft item (walks to a nearby table if needed, or puts down one you carry). A failure names the ingredients and how many you have.', { item: STR('Item id.') }, ['item']),
  tool('gather', 'Dig named raw logs/ores/soils nearby (avoid unauthorized builds; ores need pickaxe). If none is in range the result says where the nearest is, or which other kind is close.', {
    item: STR('Resource id/alias (oak_log, iron, stone…; "log" = any wood).'),
    count: INT('Count 1–64 (default 1).'),
    radius: INT('Radius 1–64 (default 32).')
  }, ['item']),
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
  tool('recall', 'Search long-term memory with relevance ranking (semantic, entity, location, goal) and see provenance.', {
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
  tool('build', 'Build blueprint or inline grid+palette.', {
    blueprint: STR('Blueprint name in zincai/blueprints/.'),
    grid: { type: 'array', description: '3D bottom-up layers of palette strings ("."/" " = air).', items: { type: 'array', items: { type: 'string' } } },
    palette: { type: 'object', description: 'Char -> block id map.', additionalProperties: { type: 'string' } },
    at: AT,
    stage: STAGE
  }),
  tool('build_shape', 'Generate and build a geometric shape.', {
    shape: { type: 'string', enum: ['cylinder', 'dome', 'arch', 'wall', 'box', 'floor', 'ring'] },
    params: { type: 'object', description: 'cylinder {r,h}; dome {r}; arch {w,h}; wall {l,h,axis}; box {w,d,h}; floor {w,d}; ring {r}. Optional th, filled; ints 1–128 (dome/ring r>=2, arch w/h>=3).' },
    block: STR('Block id.'),
    at: AT,
    stage: STAGE
  }, ['shape', 'block']),
  tool('run_script', 'Run saved script in zincai/scripts/.', { name: STR('Script name.') }, ['name']),
  tool('idle', 'End your turn with nothing more to do: the body carries on with what it is doing (while fleeing: keep fleeing). Call it alone.')
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
    do: { type: 'string', enum: ['follow', 'come', 'stop'], description: 'Start it NOW with your body, no second thought needed: follow = follow that player; come = walk to that player; stop = stop what the body is doing. Omit when none fits.' },
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
 * Map tool args -> the harness's internal action shape. Arguments keep their
 * own names; the single-letter fields are legacy aliases for older call sites.
 */
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
  try {
    const rawArgs = call?.function?.arguments
    let args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {})
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'args', name }
    const schema = known.find((t) => t.name === name).parameters
    // Reject undeclared fields: in particular, an injected `a` must never
    // override the chosen tool name in the executor.
    if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) return { error: 'args', name }
    if ((schema.required || []).some((key) => !Object.hasOwn(args, key))) return { error: 'args', name }
    for (const [key, value] of Object.entries(args)) {
      const spec = schema.properties[key]
      if (spec.type === 'string' && typeof value !== 'string') return { error: 'args', name }
      if (spec.type === 'integer' && !Number.isInteger(value)) return { error: 'args', name }
      if (spec.type === 'boolean' && typeof value !== 'boolean') return { error: 'args', name }
      if (spec.type === 'array' && (!Array.isArray(value) || (spec.minItems != null && value.length < spec.minItems) || (spec.maxItems != null && value.length > spec.maxItems))) return { error: 'args', name }
      if (spec.type === 'array' && spec.items?.type === 'string' && value.some((v) => typeof v !== 'string')) return { error: 'args', name }
      if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return { error: 'args', name }
      if (spec.enum && !spec.enum.includes(value)) return { error: 'args', name }
    }
    return { name, args }
  } catch (err) {
    logger.warn(TAG, `malformed tool arguments for ${name}: ${err.message}`)
    return { error: 'args', name }
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
    if (parsed.error === 'args') return strict ? { a: 'idle', _badArgs: parsed.name } : null
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
        if (parsed.error === 'args') return strict ? { a: 'idle', _badArgs: parsed.name } : null
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
      if (parsed.error) return { a: 'idle', _badArgs: name }
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
function toolTurnMessages (calls, { format = 'tool', content = '' } = {}) {
  const list = (calls || []).map((c, i) => ({ id: c.id || `call_${i + 1}`, name: String(c.name), args: c.args || {}, result: String(c.result ?? 'done') }))
  if (!list.length) return []
  if (format === 'text') {
    return [
      { role: 'assistant', content: `[called: ${list.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join('; ')}]` },
      { role: 'user', content: `tool results:\n${list.map((c) => `- ${c.name}: ${c.result}`).join('\n')}\nContinue: call the next tool(s), or idle when there is nothing more to do right now.` }
    ]
  }
  return [
    { role: 'assistant', content: typeof content === 'string' ? content : '', tool_calls: list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
    ...list.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.result }))
  ]
}

/**
 * Pure: build the request body. Exported for tests.
 *
 * tool_choice is "required" by default: with "auto" a model that answered in
 * prose produced an idle turn and nobody was told. Endpoints that reject
 * "required" are handled in the client (it falls back to "auto" once).
 */
function buildToolsPayload ({ model, messages, temperature, maxTokens, tools, toolChoice = 'required', parallelToolCalls = true }) {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    tools,
    tool_choice: toolChoice,
    // Several calls in one answer are allowed (and executed in order): the
    // one-call-per-turn limit made "answer AND act" take two model calls.
    parallel_tool_calls: parallelToolCalls !== false
  }
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
   * constructor contract and the same getStats() shape (plus tool metrics).
   */
  constructor ({ apiKey, baseUrl, model, timeoutMs = 20_000, maxRetries = 2, temperature = 0.25, maxTokens = 512, toolChoice = 'required', maxConcurrent = 2, chatTimeoutMs = null, chatMaxRetries = 1 }) {
    if (!apiKey) {
      // Never include the (missing) key in the error — only the variable name.
      throw new Error('AMD API key missing: set AMD_API_KEY (or API_KEY / RADEON_API_KEY)')
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.temperature = temperature
    this.maxTokens = maxTokens
    this._apiKey = String(apiKey)

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
      chatReplies: 0
    }
    this.toolChoice = toolChoice
    // Several tool calls per answer: true = ask for them, null = the endpoint
    // rejected the field (it is then left out). At most this many are executed.
    this.parallelToolCalls = true
    this.maxToolCalls = 6
    // 2 = one call per lane at a time. 1 = strictly one call at a time (for an
    // endpoint that refuses parallel requests); chat still jumps the queue.
    this.maxConcurrent = Math.max(1, Math.trunc(Number(maxConcurrent)) || 1)
    // Chat gets a slightly tighter budget than action, without starving slow endpoints.
    this.chatTimeoutMs = Number.isFinite(chatTimeoutMs) && chatTimeoutMs > 0 ? chatTimeoutMs : Math.min(timeoutMs, 90_000)
    this.chatMaxRetries = Math.max(0, Math.min(maxRetries, Math.trunc(Number(chatMaxRetries)) || 0))
    this._queue = [] // { lane, run, resolve, reject }
    this._running = new Set() // lanes with a call in flight
    this._latencies = [] // recent successful call durations (ms) for adaptive timeout scaling
  }

  _recordLatency (ms) {
    if (!Number.isFinite(ms) || ms <= 0) return
    this._latencies.push(ms)
    if (this._latencies.length > 16) this._latencies.shift()
  }

  _effectiveTimeoutMs (baseMs, maxCapMs = 180_000) {
    // Preserve explicit short timeouts used in unit tests and low-timeout configs.
    if (!Number.isFinite(baseMs) || baseMs < 10_000 || this._latencies.length < 2) return baseMs
    const sorted = [...this._latencies].sort((a, b) => a - b)
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
    return Math.min(maxCapMs, Math.max(baseMs, Math.round(p90 * 1.5)))
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
    } finally {
      clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }

  /**
   * One request, retried on 429/5xx/timeouts. Calls of the same lane run one
   * after another; different lanes may run side by side (up to
   * `maxConcurrent`), and a waiting chat call is always started first.
   * @returns {Promise<{message:object, usage:object, raw:object}>}
   */
  _complete ({ messages, tools, maxTokens = this.maxTokens, temperature = this.temperature, lane = 'action', timeoutMs = this.timeoutMs, maxRetries = this.maxRetries, signal = null, parallel = lane !== 'chat' }) {
    return new Promise((resolve, reject) => {
      this._queue.push({ lane, resolve, reject, run: () => this._completeNow({ messages, tools, maxTokens, temperature, timeoutMs, maxRetries, signal, parallel }) })
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

  async _completeNow ({ messages, tools, maxTokens, temperature, timeoutMs = this.timeoutMs, maxRetries = this.maxRetries, signal = null, parallel = true }) {
    const url = `${this.baseUrl}/chat/completions`
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mineflayer-zincai/3.0'
    }

    let attempt = 0
    let lastError = null
    while (attempt <= maxRetries) {
      if (attempt > 0) {
        this.stats.retries += 1
        await sleep(backoffMs(attempt - 1))
      }
      attempt += 1
      this.stats.requests += 1
      const payload = buildToolsPayload({ model: this.model, messages, temperature, maxTokens, tools, toolChoice: this.toolChoice, parallelToolCalls: parallel && this.parallelToolCalls !== false })
      if (this.parallelToolCalls === null) delete payload.parallel_tool_calls // endpoint does not know the field
      const startedAt = Date.now()
      try {
        // An aborted call is a decision, not a failure: it must not be retried.
        if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err }
        const res = await this._fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, timeoutMs, signal)

        if (res.status === 429 || res.status >= 500) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 200), this._apiKey)
          lastError = new Error(`HTTP ${res.status}: ${snippet}`)
          logger.warn(TAG, `retryable HTTP ${res.status} (attempt ${attempt}/${maxRetries + 1})`)
          continue
        }

        if (!res.ok) {
          const snippet = redactSecrets((await res.text().catch(() => '')).slice(0, 300), this._apiKey)
          // Some OpenAI-compatible servers only know tool_choice "auto"/"none".
          // (Judged by what THIS request sent: the other lane may have switched already.)
          if (res.status === 400 && payload.tool_choice === 'required' && /tool_choice|required/i.test(snippet)) {
            if (this.toolChoice === 'required') logger.warn(TAG, 'endpoint rejected tool_choice "required" — falling back to "auto" for this session')
            this.toolChoice = 'auto'
            attempt -= 1 // not the model's fault: do not burn a retry
            continue
          }
          // Same for parallel_tool_calls: an endpoint that rejects the field
          // gets requests without it from then on.
          if (res.status === 400 && 'parallel_tool_calls' in payload && /parallel_tool_calls|parallel/i.test(snippet)) {
            if (this.parallelToolCalls !== null) logger.warn(TAG, 'endpoint rejected parallel_tool_calls — omitting the field for this session')
            this.parallelToolCalls = null
            attempt -= 1
            continue
          }
          this.stats.failures += 1
          const failure = new Error(`HTTP ${res.status}: ${snippet}`)
          failure.status = res.status
          throw failure
        }

        const data = await res.json()
        const message = data?.choices?.[0]?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          this.stats.failures += 1
          throw new Error('Malformed response: choices[0].message has neither content nor tool_calls')
        }
        this._recordLatency(Date.now() - startedAt)
        const usage = parseUsage(data?.usage)
        if (usage.promptTokens !== null) {
          this.stats.promptTokens += usage.promptTokens
          this.stats.completionTokens += usage.completionTokens || 0
          if (usage.cachedTokens !== null) {
            this.stats.cachedTokens += usage.cachedTokens
            this.stats.callsWithCacheInfo += 1
          }
        }
        const finishReason = data?.choices?.[0]?.finish_reason ?? null
        return { message, usage, raw: data, finishReason }
      } catch (err) {
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
 * One tool-enabled completion for the ACTION lane.
   * @param {{role:string, content:string}[]} messages
   * @param {object[]} tools OpenAI-format tools (see createZincTools)
   * @returns {Promise<{action:object, content:string, usage:object, raw:object}>}
   */
  async chatWithTools (messages, tools = createZincTools(), { signal = null } = {}) {
    let first
    try {
      first = await this._complete({ messages, tools, lane: 'action', timeoutMs: this._effectiveTimeoutMs(this.timeoutMs, 180_000), signal })
    } catch (err) {
      if (err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))) {
        this.stats.aborted = (this.stats.aborted || 0) + 1
        const interrupted = { a: 'idle', _interrupted: true }
        return { action: interrupted, actions: [interrupted], message: null, content: '', usage: null, raw: null }
      }
      throw err
    }
    // Every call of the answer, in order. `action` (the first) is what the
    // rescue logic below judges: an answer whose FIRST call is broken is retried
    // with feedback; later broken calls are simply reported to the model.
    const offeredNames = new Set(tools.map((t) => t.function?.name))
    const all = coerceActions(first.message, { max: this.maxToolCalls }).map((a) => (a._via && !offeredNames.has(a.a) ? { a: 'idle', _unknownTool: a.a, _callId: a._callId } : a))
    let action = all[0]
    const offered = new Set(tools.map((t) => t.function?.name))
    if (action._via && !offered.has(action.a)) action = { a: 'idle', _unknownTool: action.a }
    // An answer that executed NOTHING in a broken way — an invented tool
    // name, broken JSON arguments, an empty message, or finish_reason 'length'
    // truncating the call — gets up to 2 rescue retries with explicit feedback.
    // Plain prose with a non-length finish_reason is NOT retried here so the
    // executor's prose feedback test contract stays intact.
    const describeFailure = (a, finish) => finish === 'length'
      ? 'truncated (length)'
      : a._unknownTool ? `unknown "${a._unknownTool}"` : a._badArgs ? `bad args (${a._badArgs})` : a._prose ? 'prose' : 'empty'
    const isBroke = (a, finish) => Boolean(a._unknownTool || a._badArgs || (!a._via && a._fallback && !a._prose) || finish === 'length')

    let current = first
    let totalUsage = first.usage
    if (isBroke(action, current.finishReason)) {
      let rescueMessages = [...messages]
      for (let attempt = 1; attempt <= 2 && isBroke(action, current.finishReason); attempt++) {
        const truncated = current.finishReason === 'length'
        const nudge = truncated
          ? 'Your previous answer was cut off before finishing a valid tool call. Reply ONLY with one compact tool call — no reasoning or extra text.'
          : 'That answer did nothing: no valid tool was called. Call exactly ONE of the listed tools now (use say to just talk, idle to wait) — plain text, markdown fences and other names are not accepted.'
        const badText = typeof current.message?.content === 'string' && current.message.content.trim()
          ? current.message.content.trim().slice(0, 300)
          : null
        rescueMessages = [
          ...rescueMessages,
          ...(badText ? [{ role: 'assistant', content: badText }] : []),
          { role: 'user', content: nudge }
        ]
        try {
          const next = await this._complete({
            messages: rescueMessages,
            tools, lane: 'action',
            timeoutMs: this._effectiveTimeoutMs(this.timeoutMs, 180_000),
            maxTokens: truncated ? Math.min(1024, (this.maxTokens || 512) * 2) : undefined
          })
          totalUsage = mergeUsage(totalUsage, next.usage)
          current = next
          let retry = coerceAction(next.message)
          if (retry._via && !offered.has(retry.a)) retry = { a: 'idle', _unknownTool: retry.a }
          action = retry
          if (retry._via && offered.has(retry.a)) {
            this.stats.rescuedToolCalls = (this.stats.rescuedToolCalls || 0) + 1
            if (retry._via === 'tool') this.stats.toolCalls += 1
            else this.stats.jsonFallbacks += 1
            const rescued = coerceActions(next.message, { max: this.maxToolCalls }).map((a) => (a._via && !offered.has(a.a) ? { a: 'idle', _unknownTool: a.a, _callId: a._callId } : a))
            return { action, actions: rescued.length ? rescued : [action], message: next.message, content: typeof next.message.content === 'string' ? next.message.content.trim() : '', usage: totalUsage, raw: next.raw }
          }
        } catch (err) {
          logger.debug(TAG, `action retry ${attempt} failed: ${err.message || err}`)
          break
        }
      }
      logger.warn(TAG, `model retry still produced no valid tool call (${describeFailure(action, current.finishReason)})`)
    }
    if (action._via === 'tool') this.stats.toolCalls += 1
    else if (action._fallback || action._badArgs) this.stats.jsonFallbacks += 1
    if (action._unknownTool) this.stats.unknownToolCalls += 1
    const actions = current === first ? all : [action]
    if (actions.length > 1) this.stats.multiToolAnswers = (this.stats.multiToolAnswers || 0) + 1
    return { action, actions, message: current.message, content: typeof current.message.content === 'string' ? current.message.content.trim() : '', usage: totalUsage, raw: current.raw }
  }

  /**
   * One completion for the CHAT lane: a short reply, optionally a task for
   * the action lane.
   * @returns {Promise<{reply:{text:string, task:string}, usage:object}>}
   */
  async chatReply (messages, { maxTokens = 120 } = {}) {
    const ask = (budget) => this._complete({
      messages, tools: createChatTools(), maxTokens: budget, temperature: Math.max(this.temperature, 0.5),
      lane: 'chat', timeoutMs: this._effectiveTimeoutMs(this.chatTimeoutMs, 120_000), maxRetries: this.chatMaxRetries
    })
    let { message, usage, finishReason } = await ask(maxTokens)
    this.stats.chatReplies += 1
    let reply = coerceReply(message)
    // An answer with no reply call AND no text is not "the model chose to stay
    // silent" (that is a reply call with empty text): the output was cut off —
    // a model that reasons first can spend the whole budget before the call —
    // or the endpoint returned nothing usable. Ask once more with room to
    // finish, and if that fails too, say which it was instead of "(silent)".
    if (reply._via !== 'tool' && !reply.text) {
      const cutOff = finishReason === 'length'
      try {
        const again = await ask(Math.max(maxTokens * 3, 480))
        this.stats.chatRetries = (this.stats.chatRetries || 0) + 1
        usage = mergeUsage(usage, again.usage)
        const second = coerceReply(again.message)
        if (second._via === 'tool' || second.text) reply = second
        else reply._empty = again.finishReason === 'length' || cutOff ? 'cut_off' : 'no_call'
      } catch (err) {
        logger.debug(TAG, `chat retry failed: ${err.message || err}`)
        reply._empty = cutOff ? 'cut_off' : 'no_call'
      }
    }
    return { reply, usage }
  }

  /** Telemetry compatible with the v1 session report + tool metrics. */
  getStats () {
    const s = this.stats
    const hitRate = s.cachedTokens > 0 && s.promptTokens > 0 ? s.cachedTokens / s.promptTokens : null
    return {
      ...s,
      avgPromptTokensPerCall: s.requests ? Math.round(s.promptTokens / s.requests) : 0,
      avgCompletionTokensPerCall: s.requests ? Math.round(s.completionTokens / s.requests) : 0,
      kvCacheHitRate: hitRate,
      uptimeMinutes: Math.round((Date.now() - this._startedAt) / 60_000) || 0
    }
  }

  _startedAt = Date.now()
}

module.exports = { AmdToolsClient, createZincTools, createChatTools, coerceAction, coerceActions, coerceReply, buildToolsPayload, toolTurnMessages, ACTION_TOOLS, CHAT_TOOLS }
