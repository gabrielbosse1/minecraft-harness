const { makeWorld } = require('/home/user/minecraft-harness/test/helpers/world')
const { Skills } = require('/home/user/minecraft-harness/zincai/skills')
const bot = makeWorld()

// What does use_block match for the names the model is most likely to pass?
const names = ['lever', 'stone_button', 'bed', 'oak_door', 'furnace', 'chest', 'note_block', 'repeater', 'comparator', 'tnt', 'respawn_anchor']
const candidates = ['lever', 'button', 'bed', 'door', 'furnace', 'chest', 'note_block', 'repeater', 'comparator', 'tnt', 'anchor']
for (const q of candidates) {
  const ids = bot.registry.blocksArray.filter(b => b.name === q || b.name.includes(q)).map(b => b.name)
  console.log(`"${q}".padEnd -> match ${ids.length} blocks: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}`)
}
