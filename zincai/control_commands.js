/**
 * control_commands.js — the operator surface as documentation + a pure
 * reference list.
 *
 * The commands themselves live in host.js (they need the live process). What
 * is here is the part that must never drift from the docs: the command table,
 * the parameter groups and the exact wording of `help`, so `!zinc help`, the
 * README and a test all read the same source.
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
    name: 'stop',
    args: '',
    summary: 'pause the body now; suspend (never delete) open goals',
    detail: 'Interrupts cancellable work, releases keys and pathfinder goals, cancels in-flight jobs, and suspends every open goal with its checkpoint. Memory, identity, jobs, goal progress and the Node.js process are untouched.'
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
    name: 'help',
    args: '',
    summary: 'this list',
    detail: 'The commands, the prefix in force, and whether chat or console commands are accepted at all.'
  }
])

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name))

/** The full help block, built from the live configuration. */
function helpText ({ prefix = '!zinc', operators = [], allowConsole = true } = {}) {
  const lines = [`commands (chat: "${prefix} <command>", console: the command alone):`]
  for (const c of COMMANDS) {
    lines.push(`  ${c.name}${c.args ? ` ${c.args}` : ''}`)
    lines.push(`      ${c.summary}`)
  }
  lines.push(`authorisation: ${operators.length ? `${operators.length} operator UUID(s) configured` : 'NO operator UUID configured — chat commands are refused; set control.operators'}`)
  lines.push(`console: ${allowConsole ? 'enabled (stdin)' : 'disabled'}`)
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
