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
const STAGE = STR('Build phase: foundation | walls_with_windows | roof | interior_details. One phase per call; re-runs are idempotent.')
const AT = { type: 'array', description: 'Absolute [x,y,z] origin; default: bot feet.', items: { type: 'integer' }, minItems: 3, maxItems: 3 }
const tool = (name, description, properties = {}, required = []) => ({ name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } })

const ACTION_TOOLS = [
  tool('say', 'Say one short chat line. Set `to` for a private message to one player.', {
    text: STR('Plain text, max 200 chars, always in Brazilian Portuguese.'),
    to: STR('Player name for a private message (optional).')
  }, ['text']),
  tool('go_to', 'Walk somewhere: a player, a remembered place or a listed id (chest2, bed1), or coordinates. You are told when you arrive or fail.', {
    player: STR('Player name.'),
    place: STR('Remembered place name or an id from "nearby".'),
    x: INT('X coordinate.'),
    y: INT('Y coordinate (optional).'),
    z: INT('Z coordinate.')
  }),
  tool('follow', 'Follow a player until you call stop or another movement.', { player: STR('Player name.') }, ['player']),
  tool('stop', 'Request cancellation of the current task, follow or fight and paused tasks. Survival may keep moving; an in-progress operation may still place or clean up blocks after stop.'),
  tool('attack', 'Fight. The ONLY way a fight ever starts. `target` = exact mob type ("zombie") or "any" hostile mob. `player` = exact player name — PvP on your explicit decision.', {
    target: STR('Mob type, or "any".'),
    player: STR('Exact player name (PvP).'),
    count: INT('How many to kill. Default: ONE animal; hostile mobs: keep going while more of them come.')
  }),
  tool('hold', 'Stop fleeing from the threats listed now: they are harmless or you accept the risk. Your task carries on. A hit from one of them, a lit fuse or a new threat makes you flee again.'),
  tool('look_in', 'Open a container and read its contents. Empty `where` = nearest.', { where: STR('Id from "nearby" (chest2), a label, or empty.') }),
  tool('take', 'Take items from a container, or the output of a furnace (name the furnace in `where`).', {
    item: STR('Item id, e.g. "diamond".'),
    count: INT('How many (default: all).'),
    where: STR('Container id or label. Default: a container already known to hold it.')
  }, ['item']),
  tool('put', 'Put carried items into a container.', {
    item: STR('Item id.'),
    count: INT('How many (default: all).'),
    where: STR('Container id or label (default: nearest).')
  }, ['item']),
  tool('smelt', 'Load the nearest furnace with an item (fuel is added from your inventory) and walk away. Collect later with take.', {
    item: STR('Item id to smelt.'),
    count: INT('How many (default: all).'),
    where: STR('Furnace id (default: nearest).')
  }, ['item']),
  tool('sleep', 'Sleep in the nearest bed (night or thunderstorm only).'),
  tool('give', 'Walk to a player and toss them an item.', {
    player: STR('Player name.'),
    item: STR('Item id.'),
    count: INT('How many (default 1).')
  }, ['player', 'item']),
  tool('eat', 'Eat now. Empty `item` = best safe food carried. (Hunger is normally handled by reflex.)', { item: STR('Item id (optional).') }),
  tool('equip', 'Equip a carried item by name.', {
    item: STR('Item id.'),
    where: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }
  }, ['item']),
  tool('use_block', 'Walk to the nearest block of this name and right-click it (door, gate, lever, button, bell).', { what: STR('Block id.') }, ['what']),
  tool('inspect_block', 'Read one nearby loaded block and its reported state; no redstone behavior is inferred.', { x: INT('Block X.'), y: INT('Block Y.'), z: INT('Block Z.') }, ['x', 'y', 'z']),
  tool('inspect_region', 'Page through a small nearby 3D region as read-only block snapshots; unknown cells and omitted details are labeled. No circuit trace.', { x: INT('Center X.'), y: INT('Center Y.'), z: INT('Center Z.'), radius: INT('Radius 0–2; default 1.'), page: INT('Page, default 1; four cells per page.') }, ['x', 'y', 'z']),
  tool('redstone_scan', 'Read-only local circuit snapshot and relationship summary; no power inferred. Scan with coordinates, then page using snapshot id.', { x: INT('Center X for new scan.'), y: INT('Center Y for new scan.'), z: INT('Center Z for new scan.'), radius: INT('Radius 0–2, default 1.'), snapshot: STR('Existing snapshot id (omit coordinates and radius).'), page: INT('Component page, default 1.') }),
  tool('redstone_component', 'Inspect a captured component state and paginated evidence-labeled neighbors. Neither connectivity nor power is guaranteed.', { snapshot: STR('Snapshot id from redstone_scan.'), x: INT('Component X.'), y: INT('Component Y.'), z: INT('Component Z.'), page: INT('Neighbor page, default 1.') }, ['snapshot', 'x', 'y', 'z']),
  tool('find', 'Where is it? A block type, an item (searches the containers you opened), a chest label, or "storage" to list every container around.', {
    what: STR('Block or item id, a label, or "storage".'),
    page: INT('Page of the storage list (default 1).')
  }, ['what']),
  tool('remember_here', 'Save the current position under a name (home, mina, casa do Gabriel).', {
    name: STR('Place name.'),
    note: STR('Optional note.')
  }, ['name']),
  tool('craft', 'Craft an item from the 2x2/3x3 grid if materials are available. Walks to the table itself if needed.', { item: STR('Item id, e.g. "crafting_table".') }, ['item']),
  tool('gather', 'Dig a raw resource nearby: logs, ores, soils. Only named resource types are dug. They may be part of player builds; do not gather near structures without authorization. Ores need a good enough pickaxe carried.', {
    item: STR('Resource id or alias, e.g. "oak_log", "coal", "iron", "diamond", "stone", "sand".'),
    count: INT('How many to dig (default 1, max 64).'),
    radius: INT('Search radius in blocks (default 32).')
  }, ['item']),
  tool('light_up', 'Place torches from the inventory onto dark walkable floor around you. Needs torches carried.', {
    radius: INT('How far around to look for dark spots (default 8, max 16).')
  }),
  tool('shelter', 'Attempt to pillar up using scaffold from your inventory; this is not guaranteed cover from melee or arrows. Stop attempts scaffold cleanup.'),
  tool('corpse_run', 'Walk near the remembered "last death" place and report nearby observed item stacks. Pickup is not verified; fails if no death was recorded or it is in another dimension.'),
  tool('logic_test', 'Test an ABSTRACT combinational Boolean graph, NOT Minecraft redstone. Gates are topologically ordered; no cycles or timing. Results cannot locate physical faults.', {
    inputs: { type: 'array', description: '1–9 unique signal ids. Bit strings use this order.', items: STR('Signal id'), minItems: 1, maxItems: 9 },
    gates: { type: 'array', description: 'Up to 128 gates in topological order.', maxItems: 128, items: { type: 'object', properties: { id: STR('New signal id'), op: { type: 'string', enum: ['AND', 'OR', 'XOR', 'NOT', 'BUF', 'NAND', 'NOR', 'FULL_SUM', 'FULL_CARRY'] }, inputs: { type: 'array', description: 'NOT/BUF: one input; FULL_SUM/FULL_CARRY: A,B,carry; others: two. Reference earlier signals.', items: STR('Signal id'), minItems: 1, maxItems: 3 } }, required: ['id', 'op', 'inputs'], additionalProperties: false } },
    outputs: { type: 'array', description: '1–9 output signal ids; output bits use this order.', items: STR('Signal id'), minItems: 1, maxItems: 9 },
    tests: { type: 'array', description: '1–512 explicit test vectors, or omit for adder_width.', minItems: 1, maxItems: 512, items: { type: 'object', properties: { in_bits: STR('0/1 input bits in declared order'), out_bits: STR('Expected 0/1 output bits in declared order') }, required: ['in_bits', 'out_bits'], additionalProperties: false } },
    adder_width: INT('Instead of tests, exhaustively check unsigned adder width 1–4. Input order: A LSB first, B LSB first, carry-in; output: sum LSB first, carry-out.'),
    project: STR('Optional project name to save this validated graph and test result.')
  }, ['inputs', 'gates', 'outputs']),
  tool('circuit_project', 'Save an observed snapshot summary, inspect a named investigation, or rerun its saved ABSTRACT logic test. Nothing is built or physically simulated.', {
    operation: { type: 'string', enum: ['bind', 'show', 'graph', 'test', 'list'] },
    name: STR('Project name: letters, digits, underscores or hyphens, max 32.'),
    snapshot: STR('For bind: snapshot id from redstone_scan.'),
    page: INT('For graph: gate page, default 1.'),
    note: STR('For bind: optional hypothesis, max 240 characters; not an observed fact.')
  }, ['operation']),
  tool('build', 'Build a stored blueprint or an inline grid. Prefer build_shape for large/simple geometry.', {
    blueprint: STR('Name of a file in zincai/blueprints/ (without .json).'),
    grid: { type: 'array', description: 'Inline 3D layers (bottom-to-top); each layer is rows of palette chars; "." or " " is air. MUST come with "palette".', items: { type: 'array', items: { type: 'string' } } },
    palette: { type: 'object', description: 'Required with grid: maps each char to a block id, e.g. {"#":"stone_bricks","G":"glass"}.', additionalProperties: { type: 'string' } },
    at: AT,
    stage: STAGE
  }),
  tool('build_shape', 'Mathematically generate and build a geometric primitive — never place big builds by hand.', {
    shape: { type: 'string', enum: ['cylinder', 'dome', 'arch', 'wall', 'box', 'floor', 'ring'] },
    params: { type: 'object', description: 'Shape params: cylinder {r,h}; dome {r}; arch {w,h}; wall {l,h,axis}; box {w,d,h}; floor {w,d}; ring {r}. Optional th on cylinder/dome/arch/wall/box/ring; filled boolean on cylinder/box. Dimensions are integers 1–128 (dome/ring r >= 2, arch w/h >= 3); oversized plans are refused.' },
    block: STR('Block id, e.g. "stone_bricks".'),
    at: AT,
    stage: STAGE
  }, ['shape', 'block']),
  tool('run_script', 'Run a saved automation script from zincai/scripts/ (e.g. build_tower).', { name: STR('Script name.') }, ['name']),
  tool('set_mode', 'Switch movement mode: builder (no sprint, no drops), hunter (sprint + jump-run), explorer (default).', {
    mode: { type: 'string', enum: ['builder', 'hunter', 'explorer'] }
  }, ['mode']),
  tool('idle', 'Do nothing this turn. While you are FLEEING this means: keep fleeing.')
]

/** The chat lane has exactly one tool: answer, and optionally hand over a task. */
const CHAT_TOOLS = [
  tool('reply', 'Answer the player. Leave `text` empty to stay silent.', {
    text: STR('One short chat line in Brazilian Portuguese. Empty = say nothing.'),
    task: STR('Only when the player asked you to DO something in the game: a short imperative for your body, e.g. "go to Gabriel", "bring Gabriel 3 diamonds from the chest". Otherwise omit.'),
    remember: STR('Only when the player told you something worth knowing later (where a thing is, whose it is, a plan, a date, what they like): that fact as one short sentence naming the player, e.g. "Gabriel keeps his diamonds in the chest on the second floor". Otherwise omit.')
  }, ['text'])
]

const toOpenAi = (list) => list.map((t) => ({ type: 'function', function: JSON.parse(JSON.stringify(t)) }))

/**
 * audit2 G: tools a mode cannot meaningfully use are not shipped to the
 * model in that mode — the schema block is ~63% of every action call, and a
 * builder never needs `smelt`/`sleep` mid-build. Movement, survival and
 * social tools (say/idle/stop/hold/find/remember_here/set_mode…) are always
 * present, so a mode switch never strands the model without a way out.
 */
const MODE_DROP_TOOLS = {
  explorer: ['build', 'build_shape', 'logic_test', 'circuit_project'],
  hunter: ['build', 'build_shape', 'logic_test', 'circuit_project', 'smelt', 'sleep', 'use_block'],
  builder: ['smelt', 'sleep']
}

/** OpenAI-format tools array. Cloned so callers may not mutate the source. */
function createZincTools ({ mode = null } = {}) {
  const drop = MODE_DROP_TOOLS[mode] || []
  const list = drop.length ? ACTION_TOOLS.filter((t) => !drop.includes(t.name)) : ACTION_TOOLS
  return toOpenAi(list)
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
      if (spec.type === 'array' && (!Array.isArray(value) || (spec.minItems != null && value.length < spec.minItems) || (spec.maxItems != null && value.length > spec.maxItems))) return { error: 'args', name }
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
  // recover the legacy single-line JSON contract rather than crash.
  const content = typeof message?.content === 'string' ? message.content : ''
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
  if (content) logger.warn(TAG, `model answered in prose without a tool call: ${content.slice(0, 120)}`)
  // Prose used to vanish silently. Keep it so the caller can report it back.
  return strict ? { a: 'idle', _fallback: true, ...(content.trim() ? { _prose: content.trim().slice(0, 300) } : {}) } : null
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
      return { text: String(parsed.args.text ?? '').trim(), task: String(parsed.args.task ?? '').trim(), remember: String(parsed.args.remember ?? '').trim(), _via: 'tool' }
    }
  }
  const content = typeof message?.content === 'string' ? message.content.trim() : ''
  // Some models wrap the answer in quotes or prefix their own name.
  const text = content.replace(/^["'“”]+|["'“”]+$/g, '').replace(/^(zinc(ai)?|me)\s*:\s*/i, '').split('\n')[0].trim()
  return { text, task: '', remember: '', _via: 'prose' }
}

/**
 * Pure: build the request body. Exported for tests.
 *
 * tool_choice is "required" by default: with "auto" a model that answered in
 * prose produced an idle turn and nobody was told. Endpoints that reject
 * "required" are handled in the client (it falls back to "auto" once).
 */
function buildToolsPayload ({ model, messages, temperature, maxTokens, tools, toolChoice = 'required' }) {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: false
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
  constructor ({ apiKey, baseUrl, model, timeoutMs = 20_000, maxRetries = 2, temperature = 0.25, maxTokens = 256, toolChoice = 'required', maxConcurrent = 2, chatTimeoutMs = null, chatMaxRetries = 1 }) {
    if (!apiKey) {
      // Never include the (missing) key in the error — only the variable name.
      throw new Error('AMD API key missing: set AMD_API_KEY (or API_KEY) in .env')
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
    // 2 = one call per lane at a time. 1 = strictly one call at a time (for an
    // endpoint that refuses parallel requests); chat still jumps the queue.
    this.maxConcurrent = Math.max(1, Math.trunc(Number(maxConcurrent)) || 1)
    // A chat reply that arrives a minute late is worth nothing: shorter leash.
    this.chatTimeoutMs = Number.isFinite(chatTimeoutMs) && chatTimeoutMs > 0 ? chatTimeoutMs : Math.min(timeoutMs, 12_000)
    this.chatMaxRetries = Math.max(0, Math.min(maxRetries, Math.trunc(Number(chatMaxRetries)) || 0))
    this._queue = [] // { lane, run, resolve, reject }
    this._running = new Set() // lanes with a call in flight
  }

  async _fetchWithTimeout (url, options, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * One request, retried on 429/5xx/timeouts. Calls of the same lane run one
   * after another; different lanes may run side by side (up to
   * `maxConcurrent`), and a waiting chat call is always started first.
   * @returns {Promise<{message:object, usage:object, raw:object}>}
   */
  _complete ({ messages, tools, maxTokens = this.maxTokens, temperature = this.temperature, lane = 'action', timeoutMs = this.timeoutMs, maxRetries = this.maxRetries }) {
    return new Promise((resolve, reject) => {
      this._queue.push({ lane, resolve, reject, run: () => this._completeNow({ messages, tools, maxTokens, temperature, timeoutMs, maxRetries }) })
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

  async _completeNow ({ messages, tools, maxTokens, temperature, timeoutMs = this.timeoutMs, maxRetries = this.maxRetries }) {
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
      const payload = buildToolsPayload({ model: this.model, messages, temperature, maxTokens, tools, toolChoice: this.toolChoice })
      try {
        const res = await this._fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, timeoutMs)

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
          this.stats.failures += 1
          throw new Error(`HTTP ${res.status}: ${snippet}`)
        }

        const data = await res.json()
        const message = data?.choices?.[0]?.message
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
          this.stats.failures += 1
          throw new Error('Malformed response: choices[0].message has neither content nor tool_calls')
        }
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
  async chatWithTools (messages, tools = createZincTools()) {
    const first = await this._complete({ messages, tools, lane: 'action' })
    let action = coerceAction(first.message)
    const offered = new Set(tools.map((t) => t.function?.name))
    if (action._via && !offered.has(action.a)) action = { a: 'idle', _unknownTool: action.a }
    // audit2 I: an answer that executed NOTHING in a broken way — an invented
    // tool name, broken JSON arguments, an empty message, or finish_reason
    // 'length' truncating the call — gets exactly one do-over with an explicit
    // instruction. PROSE is not retried here: the executor already reports
    // "you answered in prose without calling a tool" and re-wakes the model
    // (a tested contract); retrying it would double every prose turn's cost.
    const empty = !action._via && action._fallback && !action._prose
    const broke = action._unknownTool || action._badArgs || empty || first.finishReason === 'length'
    if (broke) {
      const truncated = first.finishReason === 'length'
      const nudge = truncated
        ? 'Your answer was cut off. Call exactly ONE tool now, with short arguments — nothing else.'
        : 'That answer did nothing: no valid tool was called. Call exactly ONE of the listed tools now (use say to just talk, idle to wait) — plain text, markdown fences and other names are not accepted.'
      try {
        const second = await this._complete({
          messages: [...messages, { role: 'user', content: nudge }],
          tools, lane: 'action',
          maxTokens: truncated ? Math.min(512, (this.maxTokens || 256) * 2) : undefined
        })
        const retry = coerceAction(second.message)
        if (retry._via === 'tool' && offered.has(retry.a)) {
          this.stats.rescuedToolCalls = (this.stats.rescuedToolCalls || 0) + 1
          action = retry
          return { action, content: typeof second.message.content === 'string' ? second.message.content.trim() : '', usage: mergeUsage(first.usage, second.usage), raw: second.raw }
        }
        logger.warn(TAG, `model retry still produced no valid tool call (${action._unknownTool ? `unknown "${action._unknownTool}"` : action._badArgs ? 'bad args' : 'prose'})`)
      } catch (err) {
        logger.debug(TAG, `action retry failed: ${err.message || err}`)
      }
    }
    if (action._via === 'tool') this.stats.toolCalls += 1
    else if (action._fallback || action._badArgs) this.stats.jsonFallbacks += 1
    if (action._unknownTool) this.stats.unknownToolCalls += 1
    return { action, content: typeof first.message.content === 'string' ? first.message.content.trim() : '', usage: first.usage, raw: first.raw }
  }

  /**
   * One completion for the CHAT lane: a short reply, optionally a task for
   * the action lane.
   * @returns {Promise<{reply:{text:string, task:string}, usage:object}>}
   */
  async chatReply (messages, { maxTokens = 120 } = {}) {
    const { message, usage } = await this._complete({
      messages, tools: createChatTools(), maxTokens, temperature: Math.max(this.temperature, 0.5),
      lane: 'chat', timeoutMs: this.chatTimeoutMs, maxRetries: this.chatMaxRetries
    })
    this.stats.chatReplies += 1
    return { reply: coerceReply(message), usage }
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

module.exports = { AmdToolsClient, createZincTools, createChatTools, coerceAction, coerceReply, buildToolsPayload, ACTION_TOOLS, CHAT_TOOLS }
