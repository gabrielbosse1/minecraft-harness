/**
 * vanilla_guard.js — hard proof that ZincAI is a *player*, not an operator.
 *
 * The harness is 100% vanilla: no RCON, no server console, no `/tp`, no
 * `/setworldspawn`, no cheats, no gamemode changes, no world edits that a
 * legitimate client cannot perform. There is no code path in this repo that
 * opens an RCON socket or sends a slash-command — this module makes that a
 * *runtime invariant* instead of a convention:
 *
 *   1. installVanillaGuard(bot) wraps bot.chat so any line that starts with
 *      "/" is dropped before it hits the wire (and reported, so a regression
 *      is loud in the logs rather than silently teleporting the bot).
 *   2. assertVanillaAction(action) rejects action objects that smell like
 *      commands (a "command"/"cmd" field, a slash payload, RCON-ish fields)
 *      while letting every real tool call through untouched.
 *   3. ONE exception, because every player can do it: a private message. The
 *      guard exposes whisper(player, text), which builds "/msg <player> <text>"
 *      itself from a validated online username. The model supplies the name
 *      and the words, never the command, so it cannot be bent into anything
 *      else.
 *
 * Movement, survival, building and combat are all performed through ordinary
 * client packets: setControlState, attack, placeBlock/dig, activateItem,
 * equip, and the A* pathfinder. That is the entire action surface.
 */
'use strict'

/** True when a chat payload would be interpreted as a server command. */
function isCommandLine (text) {
  return /^\s*\//.test(String(text || ''))
}

const FORBIDDEN_ACTION_FIELDS = ['command', 'cmd', 'rcon', 'slash', 'execute', 'op']

/**
 * Validate an internal action object before execution.
 * @param {object} action
 * @returns {{ok:boolean, why?:string}}
 */
function assertVanillaAction (action) {
  if (!action || typeof action !== 'object') return { ok: true }
  for (const field of FORBIDDEN_ACTION_FIELDS) {
    if (action[field] !== undefined) return { ok: false, why: `forbidden field "${field}"` }
  }
  for (const value of Object.values(action)) {
    if (typeof value === 'string' && isCommandLine(value)) {
      return { ok: false, why: 'slash-command payload' }
    }
  }
  return { ok: true }
}

/**
 * Install the chat-level barrier. Idempotent (safe to call twice).
 * @param {import('mineflayer').Bot} bot
 * @param {{logger?: {warn?:Function, info?:Function}, onBlocked?: Function}} [opts]
 * @returns {{blocked:number, uninstall:Function}}
 */
function installVanillaGuard (bot, { logger = null, onBlocked = null } = {}) {
  if (!bot) return { blocked: 0, whispers: 0, whisper: () => false, uninstall: () => {} }
  if (bot.__zincaiVanillaGuard) return bot.__zincaiVanillaGuard

  let originalChat = null
  let installed = false

  const state = {
    blocked: 0,
    whispers: 0,
    whisper: (player, text) => {
      const name = String(player || '').trim()
      const body = String(text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || !body) return false
      const players = bot.players ? Object.keys(bot.players) : null
      if (players && !players.some((p) => p.toLowerCase() === name.toLowerCase())) return false
      if (!originalChat && typeof bot.chat !== 'function') return false
      state.whispers++
      ;(originalChat || bot.chat.bind(bot))(`/msg ${name} ${body}`)
      return true
    },
    uninstall: () => {
      if (originalChat) bot.chat = originalChat
      delete bot.__zincaiVanillaGuard
    }
  }

  const wrap = () => {
    if (installed || typeof bot.chat !== 'function') return
    installed = true
    originalChat = bot.chat.bind(bot)
    bot.chat = (message, ...rest) => {
      if (isCommandLine(message)) {
        state.blocked++
        logger?.warn?.('vanilla', `blocked command-shaped chat: ${String(message).slice(0, 80)}`)
        try { onBlocked?.(String(message)) } catch { /* observer must not break chat */ }
        try { bot.emit?.('vanilla_command_blocked', String(message)) } catch { /* no emitter */ }
        return false
      }
      return originalChat(message, ...rest)
    }
    logger?.info?.('vanilla', 'guard installed — no RCON, no slash commands, client packets only')
  }

  bot.__zincaiVanillaGuard = state
  if (typeof bot.chat === 'function') {
    wrap()
  } else if (typeof bot.once === 'function') {
    bot.once('inject_allowed', wrap)
    bot.once('login', wrap)
  }
  return state
}

module.exports = { isCommandLine, assertVanillaAction, installVanillaGuard, FORBIDDEN_ACTION_FIELDS }
