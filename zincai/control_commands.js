/**
 * control_commands.js — the operator surface as documentation + a pure
 * reference list.
 *
 * The commands themselves live in host.js (they need the live process). What
 * is here is the part that must never drift from the docs: the command table,
 * the parameter groups and the exact wording of `help`, so the console's
 * `help`, the README and a test all read the same source.
 *
 * Console only, no prefix: `pause`, `shutdown`, `status`. There is no chat
 * command surface — see host.parseCommandLine for why.
 *
 * Generation is pure: no I/O, no mineflayer.
 */
'use strict'

const { RuntimeConfig } = require('./runtime_config')

/** The command surface, in the order an operator needs it. */
const COMMANDS = Object.freeze([
  {
    name: 'status',
    args: '',
    summary: 'connection, life, activity, goals, jobs, limits, paused',
    detail: 'One screen: link state, alive/dead, what the body is doing, goal counts, active jobs, every effective limit, and whether the body is paused.'
  },
  {
    name: 'pause',
    args: '',
    summary: 'pause the body now (alias: stop); suspend open goals, delete nothing',
    detail: 'Interrupts cancellable work, releases keys and pathfinder goals, cancels in-flight jobs, and suspends every open goal with its checkpoint. Memory, identity, jobs, goal progress and the Node.js process are untouched. Nothing the model MAY do changes — this is the emergency handbrake, not a change of policy.'
  },
  {
    name: 'stop',
    args: '',
    summary: 'same as pause (the older name)',
    detail: 'Kept because it is the word in the supervisor scripts and the docs. `pause` is the clear one.'
  },
  {
    name: 'resume',
    args: '',
    summary: 'unpause; reconcile the world, then resume what is still valid',
    detail: 'Reads position, health, inventory and dimension, verifies each suspended goal against the world, completes the ones already done and hands back only the ones that remain valid.'
  },
  {
    name: 'leave',
    args: '',
    summary: 'disconnect from the server; keep the process and the interface',
    detail: 'The Mineflayer client is disposed, so no physical action can be issued. Reasoning state, memory, goals and this interface keep running.'
  },
  {
    name: 'join',
    args: '',
    summary: 'reconnect the existing process to the configured server',
    detail: 'Builds a fresh session: listeners are installed once, the world is inspected, and goals stay suspended until they are verified.'
  },
  {
    name: 'restart-connection',
    args: '',
    summary: 'drop and re-establish the link without restarting Node.js',
    detail: 'Same as leave followed by join, in one step, with the process and its state preserved.'
  },
  {
    name: 'goals',
    args: '',
    summary: 'active, suspended, waiting and completed objectives',
    detail: 'The durable objective registry, grouped by lifecycle state, each with its progress and why it is where it is.'
  },
  {
    name: 'jobs',
    args: '',
    summary: 'background jobs with their resources, progress and cancellation state',
    detail: 'Every job with the lane it holds, the goal it belongs to, its last reported progress and whether it is being cancelled.'
  },
  {
    name: 'cancel',
    args: '<goal-id>',
    summary: 'cancel one goal and the jobs that belong to it',
    detail: 'Nothing else is touched: unrelated goals, their jobs and their progress stay exactly as they were.'
  },
  {
    name: 'config',
    args: '[show [group|name] | set <name> <value> | reset <name>]',
    summary: 'inspect or change one parameter',
    detail: 'One generic, validated, persistent store. `config` lists everything with defaults; `config show <group>` narrows it; `config set` prints the old and the new value.'
  },
  {
    name: 'update',
    args: '[check | force]',
    summary: 'pull the newest source from GitHub and restart on it',
    detail: 'Fetches the branch this checkout is on, fast-forwards to it, reinstalls dependencies only if they changed, proves the new source loads (--check), then saves state, leaves the server and restarts the process on the new code. If anything fails the checkout is rolled back and the running bot is untouched. `update check` only reports whether there is something to pull. `update force` discards local edits to tracked files and local commits, taking GitHub\'s version.'
  },
  {
    name: 'restart',
    args: '',
    summary: 'restart the whole process on the source that is on disk (no pull)',
    detail: 'Saves state, leaves the server and starts a fresh process — for after editing files by hand. Memory, identity, goals and checkpoints are on disk and are picked up again.'
  },
  {
    name: 'shutdown',
    args: '[exit-code]',
    summary: 'stop the whole process now: body, model, everything',
    detail: 'The other half of the emergency stop. Pauses the body, leaves the server, then exits Node.js with the given code (default 0). State on disk — memory, identity, goals, checkpoints — is saved first, so a later start resumes from it. `stop`/`pause` is the reversible one; this is the end of the process.'
  },
  {
    name: 'help',
    args: '',
    summary: 'this list',
    detail: 'Every command and what it does. There is no prefix: this is the console surface, and nothing in game chat can reach it.'
  }
])

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name))

/** The full help block, built from the live configuration. */
function helpText ({ allowConsole = true } = {}) {
  const lines = ['commands (console only, no prefix — type the word and press enter):']
  for (const c of COMMANDS) {
    lines.push(`  ${c.name}${c.args ? ` ${c.args}` : ''}`)
    lines.push(`      ${c.summary}`)
  }
  lines.push(`console: ${allowConsole ? 'enabled (stdin)' : 'disabled by control.allowConsole'}`)
  lines.push('authorisation: whoever holds this process\'s console. In-game chat is not a command channel.')
  return lines.join('\n')
}

/** The parameter listing, grouped, with ranges and defaults. */
function schemaText ({ group = null, config = null } = {}) {
  const defs = RuntimeConfig.schema(group)
  const lines = []
  let current = null
  for (const d of defs) {
    if (d.group !== current) { lines.push(`[${d.group}]`); current = d.group }
    const value = config ? config.get(d.name) : d.default
    lines.push(`  ${d.name} = ${formatValue(value)}`)
    lines.push(`      ${d.describe}`)
    lines.push(`      type: ${d.type}${d.type === 'boolean' ? '' : ` (${RuntimeConfig.describeValue(d)})`}; default: ${formatValue(d.default)}; applies: ${d.apply}`)
  }
  return lines.join('\n')
}

function formatValue (value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : '(empty)'
  if (value === '') return '""'
  return String(value)
}

module.exports = { COMMANDS, COMMAND_NAMES, helpText, schemaText, formatValue }
