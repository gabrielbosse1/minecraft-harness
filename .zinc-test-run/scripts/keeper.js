/**
 * Keeper: a do-nothing mineflayer client that stays connected so the vanilla
 * server does not auto-pause (paused servers stop generating forceload chunks).
 * Run: node keeper.js   (stays connected until killed; SIGINT quits cleanly)
 */
'use strict'
const mineflayer = require('/home/anonymous/minecraft-harness/node_modules/mineflayer')
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25570, username: 'Keeper', auth: 'offline', version: false })
bot.once('error', (e) => { log('KEEPER_ERROR', e.message); setTimeout(() => process.exit(1), 1000) })
bot.once('kicked', (r) => { log('KEEPER_KICKED', JSON.stringify(r)); process.exit(2) })
bot.once('spawn', () => { log('KEEPER_SPAWNED v=' + bot.version) })
bot.on('end', (r) => { log('KEEPER_END', r || 'ended') })
process.on('SIGINT', () => { try { bot.quit() } catch { /* */ } setTimeout(() => process.exit(0), 500) })
process.on('SIGTERM', () => { try { bot.quit() } catch { /* */ } setTimeout(() => process.exit(0), 500) })
setInterval(() => { /* keep event loop alive */ }, 30000)
