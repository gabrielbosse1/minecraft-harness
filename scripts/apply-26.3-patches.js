#!/usr/bin/env node
/**
 * postinstall (part 2) — 26.3 wire-compatibility patches for the installed
 * Prismarine stack. Companion to scripts/apply-26.3-data.js (which injects
 * the 26.3 data files). This script patches the *code* that consumes that
 * data so a real 26.3 server can be joined and held.
 *
 * WHY: minecraft-data's 26.3 protocol.json (protocol 777, from unmerged
 * upstream PRs) changed several wire encodings vs 26.1. The published
 * minecraft-protocol@1.68.0 / mineflayer@4.39.0 / prismarine-chunk@1.41.0
 * do not implement them, so the bot crashed (`ctx.entityDelta is not a
 * function`) and was kicked (`invalid_player_movement`) ~400 ms after spawn
 * on a real 26.3 server (see scripts/apply-26.3-data.js).
 * Upstream fixes exist as open PRs (node-minecraft-protocol#1538/#1553,
 * mineflayer#4144/#4125/#4146/#4194/#4206, prismarine-chunk#334); this
 * script ports the join-critical & gameplay-critical subset into the
 * installed packages.
 *
 * IDEMPOTENT: safe to run on every npm install. FAILS LOUDLY if an anchor
 * disappears (dependency upgrade) — a silently half-patched bot is worse
 * than a red install. When upstream publishes 26.3 support, delete this
 * script, the vendor data and the postinstall hook together.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const REPO = path.join(__dirname, '..')
const NM = path.join(REPO, 'node_modules')

function die (msg) {
  console.error(`\n[apply-26.3-patches] FATAL: ${msg}`)
  console.error('[apply-26.3-patches] The bot cannot safely join a 26.3 server without this patch.')
  process.exit(1)
}
function info (msg) { console.log(`[apply-26.3-patches] ${msg}`) }

function read (rel) {
  const p = path.join(NM, rel)
  if (!fs.existsSync(p)) die(`expected file not found: node_modules/${rel} (run npm install first)`)
  return { p, src: fs.readFileSync(p, 'utf8') }
}
function write (p, src) { fs.writeFileSync(p, src) }

/** Anchored replace: no-op if already patched, die if anchor missing or marker invalid. */
function patch (rel, { marker, anchor, replacement, label }) {
  if (!replacement.includes(marker)) {
    die(`${label}: internal bug — marker "${marker}" does not appear in replacement`)
  }
  const { p, src } = read(rel)
  if (src.includes(marker)) { info(`${label}: already patched`); return }
  if (!src.includes(anchor)) die(`${label}: anchor not found in node_modules/${rel} — upstream layout changed`)
  write(p, src.replace(anchor, replacement))
  info(`${label}: patched`)
}

// ---------------------------------------------------------------------------
// 1. minecraft-protocol: entityDelta native type + #1553 fixes
// ---------------------------------------------------------------------------
{
  const rel = 'minecraft-protocol/src/datatypes/minecraft.js'
  const { p, src } = read(rel)
  if (!src.includes('readEntityDelta')) {
    const exportAnchor = '  lpVec3: [readLpVec3, writeLpVec3, sizeOfLpVec3]\n}'
    if (!src.includes(exportAnchor)) die('entityDelta: export anchor not found in minecraft.js')
    const withExport = src.replace(exportAnchor, '  lpVec3: [readLpVec3, writeLpVec3, sizeOfLpVec3],\n  entityDelta: [readEntityDelta, writeEntityDelta, sizeOfEntityDelta]\n}')
    const implAnchor = 'const PartialReadError = require(\'protodef\').utils.PartialReadError\n'
    if (!withExport.includes(implAnchor)) die('entityDelta: impl anchor not found in minecraft.js')
    const impl = implAnchor + `
// 26.3+ ClientboundMoveEntityPacket ("rel_entity_move" / "entity_move_look") delta encoding.
// Mojang replaced the flat 3x-i16 delta with VecDelta, a packed \`properties\` varint
// (bit 0 = onGround, remaining bits = stepCount) followed by either:
//  - stepCount <= 0: the old flat format, 3x i16 (dX, dY, dZ)
//  - stepCount > 0: \`stepCount\` DeltaStep entries, each {ticks: varint, dX, dY, dZ: i16}
// Parsed shape (uniform regardless of wire variant):
//   { onGround: boolean, steps: [{ dX, dY, dZ, ticks }, ...] }
// Ported from PrismarineJS/node-minecraft-protocol#1538 (decompiled VecDelta).
function readEntityDelta (buffer, offset) {
  let cursor = offset
  const props = readVarInt(buffer, cursor)
  cursor += props.size
  const onGround = (props.value & 1) !== 0
  const stepCount = props.value >>> 1
  const steps = []
  if (stepCount <= 0) {
    if (cursor + 6 > buffer.length) throw new PartialReadError('Unexpected buffer end while reading entityDelta (linear)')
    steps.push({
      dX: buffer.readInt16BE(cursor),
      dY: buffer.readInt16BE(cursor + 2),
      dZ: buffer.readInt16BE(cursor + 4),
      ticks: 0
    })
    cursor += 6
  } else {
    for (let i = 0; i < stepCount; i++) {
      const ticksResult = readVarInt(buffer, cursor)
      cursor += ticksResult.size
      if (cursor + 6 > buffer.length) throw new PartialReadError('Unexpected buffer end while reading entityDelta (stepped)')
      steps.push({
        dX: buffer.readInt16BE(cursor),
        dY: buffer.readInt16BE(cursor + 2),
        dZ: buffer.readInt16BE(cursor + 4),
        ticks: ticksResult.value
      })
      cursor += 6
    }
  }
  return { value: { onGround, steps }, size: cursor - offset }
}

function writeEntityDelta (value, buffer, offset) {
  const { onGround, steps } = value
  const useLinear = steps.length === 1 && steps[0].ticks === 0
  const stepCount = useLinear ? 0 : steps.length
  const properties = (onGround ? 1 : 0) | (stepCount << 1)
  offset = writeVarInt(properties, buffer, offset)
  if (useLinear) {
    buffer.writeInt16BE(steps[0].dX, offset)
    buffer.writeInt16BE(steps[0].dY, offset + 2)
    buffer.writeInt16BE(steps[0].dZ, offset + 4)
    offset += 6
  } else {
    for (const step of steps) {
      offset = writeVarInt(step.ticks, buffer, offset)
      buffer.writeInt16BE(step.dX, offset)
      buffer.writeInt16BE(step.dY, offset + 2)
      buffer.writeInt16BE(step.dZ, offset + 4)
      offset += 6
    }
  }
  return offset
}

function sizeOfEntityDelta (value) {
  const { onGround, steps } = value
  const useLinear = steps.length === 1 && steps[0].ticks === 0
  const stepCount = useLinear ? 0 : steps.length
  const properties = (onGround ? 1 : 0) | (stepCount << 1)
  let size = sizeOfVarInt(properties)
  if (useLinear) {
    size += 6
  } else {
    for (const step of steps) {
      size += sizeOfVarInt(step.ticks) + 6
    }
  }
  return size
}
`
    write(p, withExport.replace(implAnchor, impl))
    info('minecraft-protocol entityDelta: patched minecraft.js')
  } else {
    info('minecraft-protocol entityDelta: already patched')
  }
}
patch('minecraft-protocol/src/datatypes/compiler-minecraft.js', {
  marker: 'minecraft.entityDelta[0]',
  anchor: "    lpVec3: ['native', minecraft.lpVec3[0]]\n  },",
  replacement: "    lpVec3: ['native', minecraft.lpVec3[0]],\n    entityDelta: ['native', minecraft.entityDelta[0]]\n  },",
  label: 'minecraft-protocol entityDelta (compiler Read)'
})
patch('minecraft-protocol/src/datatypes/compiler-minecraft.js', {
  marker: 'minecraft.entityDelta[1]',
  anchor: "    lpVec3: ['native', minecraft.lpVec3[1]]\n  },",
  replacement: "    lpVec3: ['native', minecraft.lpVec3[1]],\n    entityDelta: ['native', minecraft.entityDelta[1]]\n  },",
  label: 'minecraft-protocol entityDelta (compiler Write)'
})
patch('minecraft-protocol/src/datatypes/compiler-minecraft.js', {
  marker: 'minecraft.entityDelta[2]',
  anchor: "    lpVec3: ['native', minecraft.lpVec3[2]]\n  }",
  replacement: "    lpVec3: ['native', minecraft.lpVec3[2]],\n    entityDelta: ['native', minecraft.entityDelta[2]]\n  }",
  label: 'minecraft-protocol entityDelta (compiler SizeOf)'
})

// NMP #1553/4: server login `sessionId` (needed by 26.2/26.3 mock servers in tests)
patch('minecraft-protocol/src/server/login.js', {
  marker: 'sessionId: crypto.randomUUID()',
  anchor: `    client.write('success', {
      uuid: client.uuid,
      username: client.username,
      properties: []
    })`,
  replacement: `    client.write('success', {
      uuid: client.uuid,
      username: client.username,
      properties: [],
      sessionId: crypto.randomUUID()
    })`,
  label: 'minecraft-protocol server/login (sessionId)'
})

// NMP #1553/2: compression max uncompressed length cap
patch('minecraft-protocol/src/transforms/compression.js', {
  marker: 'MAX_UNCOMPRESSED_LENGTH',
  anchor: "const Transform = require('readable-stream').Transform\n",
  replacement: "const Transform = require('readable-stream').Transform\nconst MAX_UNCOMPRESSED_LENGTH = 8388608 // 2 ** 23\n",
  label: 'minecraft-protocol compression (const)'
})
patch('minecraft-protocol/src/transforms/compression.js', {
  marker: 'maxOutputLength: MAX_UNCOMPRESSED_LENGTH',
  anchor: `    if (value === 0) {
      this.push(chunk.slice(size))
      return cb()
    } else {
      try {
        const newBuf = zlib.unzipSync(chunk.slice(size), { finishFlush: 2 })`,
  replacement: `    if (value === 0) {
      this.push(chunk.slice(size))
      return cb()
    } else if (value > MAX_UNCOMPRESSED_LENGTH) {
      if (!this.hideErrors) {
        console.error('uncompressed length ' + value + ' exceeds maximum of ' + MAX_UNCOMPRESSED_LENGTH)
      }
      return cb()
    } else {
      try {
        const newBuf = zlib.unzipSync(chunk.slice(size), { maxOutputLength: MAX_UNCOMPRESSED_LENGTH, finishFlush: 2 })`,
  label: 'minecraft-protocol compression (decompressor cap)'
})

// NMP #1553/3: checksum last seen messages in acknowledgement order
patch('minecraft-protocol/src/client/chat.js', {
  marker: 'checksum: computeChatChecksum(lastSeenMessages)',
  anchor: `  function getAcknowledgements () {
    let acc = 0
    const acknowledgements = []

    for (let i = 0; i < client._lastSeenMessages.capacity; i++) {
      const idx = (client._lastSeenMessages.offset + i) % 20
      const message = client._lastSeenMessages[idx]
      if (message) {
        acc |= 1 << i
        acknowledgements.push(message.signature)
        message.pending = false
      }
    }

    const bitset = Buffer.allocUnsafe(3)
    bitset[0] = acc & 0xFF
    bitset[1] = (acc >> 8) & 0xFF
    bitset[2] = (acc >> 16) & 0xFF

    return {
      acknowledgements,
      acknowledged: bitset
    }
  }`,
  replacement: `  function getAcknowledgements () {
    let acc = 0
    const acknowledgements = []
    const lastSeenMessages = []

    for (let i = 0; i < client._lastSeenMessages.capacity; i++) {
      const idx = (client._lastSeenMessages.offset + i) % 20
      const message = client._lastSeenMessages[idx]
      if (message) {
        acc |= 1 << i
        acknowledgements.push(message.signature)
        lastSeenMessages.push(message)
        message.pending = false
      }
    }

    const bitset = Buffer.allocUnsafe(3)
    bitset[0] = acc & 0xFF
    bitset[1] = (acc >> 8) & 0xFF
    bitset[2] = (acc >> 16) & 0xFF

    return {
      acknowledgements,
      acknowledged: bitset,
      checksum: computeChatChecksum(lastSeenMessages)
    }
  }`,
  label: 'minecraft-protocol client/chat (getAcknowledgements)'
})
patch('minecraft-protocol/src/client/chat.js', {
  marker: 'const { acknowledged, acknowledgements, checksum } = getAcknowledgements()',
  anchor: `        const { acknowledged, acknowledgements } = getAcknowledgements()
        const canSign = client.profileKeys && client._session
        const chatPacket = {
          command,
          timestamp: options.timestamp,
          salt: options.salt,
          argumentSignatures: canSign ? signaturesForCommand(command, options.timestamp, options.salt, options.preview, acknowledgements) : [],
          messageCount: client._lastSeenMessages.pending,
          checksum: computeChatChecksum(client._lastSeenMessages), // 1.21.5+
          acknowledged
        }`,
  replacement: `        const { acknowledged, acknowledgements, checksum } = getAcknowledgements()
        const canSign = client.profileKeys && client._session
        const chatPacket = {
          command,
          timestamp: options.timestamp,
          salt: options.salt,
          argumentSignatures: canSign ? signaturesForCommand(command, options.timestamp, options.salt, options.preview, acknowledgements) : [],
          messageCount: client._lastSeenMessages.pending,
          checksum, // 1.21.5+
          acknowledged
        }`,
  label: 'minecraft-protocol client/chat (chat_command checksum)'
})
patch('minecraft-protocol/src/client/chat.js', {
  marker: 'const { acknowledgements, acknowledged, checksum } = getAcknowledgements()',
  anchor: `    if (mcData.supportFeature('useChatSessions')) {
      const { acknowledgements, acknowledged } = getAcknowledgements()
      client.write('chat_message', {
        message,
        timestamp: options.timestamp,
        salt: options.salt,
        signature: (client.profileKeys && client._session) ? client.signMessage(message, options.timestamp, options.salt, undefined, acknowledgements) : undefined,
        offset: client._lastSeenMessages.pending,
        checksum: computeChatChecksum(client._lastSeenMessages), // 1.21.5+
        acknowledged
      })`,
  replacement: `    if (mcData.supportFeature('useChatSessions')) {
      const { acknowledgements, acknowledged, checksum } = getAcknowledgements()
      client.write('chat_message', {
        message,
        timestamp: options.timestamp,
        salt: options.salt,
        signature: (client.profileKeys && client._session) ? client.signMessage(message, options.timestamp, options.salt, undefined, acknowledgements) : undefined,
        offset: client._lastSeenMessages.pending,
        checksum, // 1.21.5+
        acknowledged
      })`,
  label: 'minecraft-protocol client/chat (chat_message checksum)'
})

// ---------------------------------------------------------------------------
// 2. prismarine-chunk: light masks are ByteArray on 26.3+ (upstream #334)
// ---------------------------------------------------------------------------
{
  const rel = 'prismarine-chunk/src/pc/common/BitArrayNoSpan.js'
  const { p, src } = read(rel)
  if (!src.includes('fromByteArray')) {
    const anchor = '  static fromLongArray (array, bitsPerValue) {'
    if (!src.includes(anchor)) die('chunk light masks: fromLongArray anchor not found in BitArrayNoSpan.js')
    const addition = `  // 26.3+ (protocol 777) light-mask wire format: varint count of raw bytes
  // (java.util.BitSet.valueOf(byte[]), little-endian within each byte).
  toByteArray () {
    const bytes = []
    for (let i = 0; i < this.capacity; i++) {
      const byteIndex = i >> 3
      const bitIndex = i & 7
      if (!bytes[byteIndex]) bytes[byteIndex] = 0
      if (this.get(i)) bytes[byteIndex] |= (1 << bitIndex)
    }
    let end = bytes.length
    while (end > 0 && !bytes[end - 1]) end--
    return bytes.slice(0, end)
  }

  static fromByteArray (bytes, bitsPerValue) {
    const bitArray = new BitArray({
      capacity: Math.floor(8 / bitsPerValue) * bytes.length,
      bitsPerValue
    })
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]
      for (let b = 0; b < 8; b++) {
        if ((byte >> b) & 1) {
          bitArray.set(i * 8 + b, 1)
        }
      }
    }
    return bitArray
  }

` + anchor
    write(p, src.replace(anchor, addition))
    info('prismarine-chunk light masks: patched BitArrayNoSpan.js')
  } else {
    info('prismarine-chunk light masks: already patched')
  }
}
patch('prismarine-chunk/src/pc/1.18/ChunkColumn.js', {
  marker: 'lightMasksAreByteArrays',
  anchor: "  const hasFluidCount = mcData.version['>=']('26.1')\n",
  replacement: "  const hasFluidCount = mcData.version['>=']('26.1')\n  // 26.3+ (protocol 777): light-mask BIT_SET codec switched from varint-count-of-longs\n  // to varint-count-of-raw-bytes (see BitArrayNoSpan.fromByteArray).\n  const lightMasksAreByteArrays = mcData.version['>=']('26.3')\n",
  label: 'prismarine-chunk light masks (ChunkColumn gate)'
})
patch('prismarine-chunk/src/pc/1.18/ChunkColumn.js', {
  marker: 'BitArray.fromByteArray(pLightMask',
  anchor: '        const incomingLightMask = BitArray.fromLongArray(pLightMask, 1)\n        const incomingEmptyMask = BitArray.fromLongArray(pEmptyMask, 1)',
  replacement: '        const incomingLightMask = lightMasksAreByteArrays ? BitArray.fromByteArray(pLightMask, 1) : BitArray.fromLongArray(pLightMask, 1)\n        const incomingEmptyMask = lightMasksAreByteArrays ? BitArray.fromByteArray(pEmptyMask, 1) : BitArray.fromLongArray(pEmptyMask, 1)',
  label: 'prismarine-chunk light masks (loadParsedLight)'
})
patch('prismarine-chunk/src/pc/1.18/ChunkColumn.js', {
  marker: 'this.skyLightMask.toByteArray()',
  anchor: `      return {
        skyLight,
        blockLight,
        skyLightMask: this.skyLightMask.toLongArray(),
        blockLightMask: this.blockLightMask.toLongArray(),
        emptySkyLightMask: this.emptySkyLightMask.toLongArray(),
        emptyBlockLightMask: this.emptyBlockLightMask.toLongArray()
      }`,
  replacement: `      return {
        skyLight,
        blockLight,
        skyLightMask: lightMasksAreByteArrays ? this.skyLightMask.toByteArray() : this.skyLightMask.toLongArray(),
        blockLightMask: lightMasksAreByteArrays ? this.blockLightMask.toByteArray() : this.blockLightMask.toLongArray(),
        emptySkyLightMask: lightMasksAreByteArrays ? this.emptySkyLightMask.toByteArray() : this.emptySkyLightMask.toLongArray(),
        emptyBlockLightMask: lightMasksAreByteArrays ? this.emptyBlockLightMask.toByteArray() : this.emptyBlockLightMask.toLongArray()
      }`,
  label: 'prismarine-chunk light masks (dumpLight)'
})

// ---------------------------------------------------------------------------
// 3. minecraft-data features: 26.3-only features used by the mineflayer patches
// ---------------------------------------------------------------------------
{
  const rel = 'minecraft-data/minecraft-data/data/pc/common/features.json'
  const { p, src } = read(rel)
  let features
  try { features = JSON.parse(src) } catch { die('features.json: not valid JSON') }
  const names = new Set(features.map((f) => f.name))
  const wanted = [
    { name: 'playerActionHasChangeDestroyDirection', description: '26.3 inserted CHANGE_DESTROY_DIRECTION into ServerboundPlayerActionPacket, shifting later action ids up by one', versions: ['26.3', 'latest'] },
    { name: 'swingUsesPunchPacket', description: '26.3 replaced serverbound arm_animation with the empty punch packet', versions: ['26.3', 'latest'] },
    { name: 'teleportConfirmHasPosition', description: 'serverbound accept_teleportation (teleport_confirm) echoes the resolved position and rotation after the id; only the newest pending teleport is answered', versions: ['26.3', 'latest'] }
  ]
  let changed = false
  for (const w of wanted) {
    if (!names.has(w.name)) { features.push(w); changed = true }
  }
  if (changed) {
    write(p, JSON.stringify(features, null, 2) + '\n')
    info('minecraft-data features: added 26.3-only features')
  } else {
    info('minecraft-data features: already patched')
  }
}

// ---------------------------------------------------------------------------
// 4. mineflayer entities.js: stepped movement, punch, wake pose, oxygen, onGround
// ---------------------------------------------------------------------------
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'const sleepingEntities = new WeakSet()',
  anchor: 'function inject (bot) {\n  const { mobs } = bot.registry',
  replacement: 'function inject (bot) {\n  const { mobs } = bot.registry\n  const sleepingEntities = new WeakSet()',
  label: 'mineflayer entities (sleepingEntities)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'bot.entity.onGround = false',
  anchor: `    bot.entity.height = PLAYER_HEIGHT
    bot.entity.width = PLAYER_WIDTH
    bot.entity.eyeHeight = PLAYER_EYEHEIGHT
  })`,
  replacement: `    bot.entity.height = PLAYER_HEIGHT
    bot.entity.width = PLAYER_WIDTH
    bot.entity.eyeHeight = PLAYER_EYEHEIGHT
    bot.entity.onGround = false
  })`,
  label: 'mineflayer entities (login onGround)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'sleepingEntities.delete(entity)\n\n    if (eventName)',
  anchor: '    if (eventName) bot.emit(eventName, entity)',
  replacement: "    if (eventName === 'entityWake') sleepingEntities.delete(entity)\n\n    if (eventName) bot.emit(eventName, entity)",
  label: 'mineflayer entities (entity_status wake cleanup)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'metas.pose !== undefined && sleepingEntities.has(entity)',
  anchor: `      if (metas.sleeping_pos || metas.pose === 2) {
        bot.emit('entitySleep', entity)
      }`,
  replacement: `      if (metas.sleeping_pos || metas.pose === 2) {
        sleepingEntities.add(entity)
        bot.emit('entitySleep', entity)
      } else if (metas.pose !== undefined && sleepingEntities.has(entity)) {
        sleepingEntities.delete(entity)
        bot.emit('entityWake', entity)
      }`,
  label: 'mineflayer entities (pose wake)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'entity.id === bot.entity?.id',
  anchor: '      if (metas.air_supply != null) {',
  replacement: '      if (metas.air_supply != null && entity.id === bot.entity?.id) {',
  label: 'mineflayer entities (oxygen self-only)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'function entityDeltaSteps (packet)',
  anchor: "  bot._client.on('rel_entity_move', (packet) => {",
  replacement: `  // 26.3+ replaced the flat dX/dY/dZ fields on rel_entity_move / entity_move_look with a
  // \`move: { onGround, steps }\` field (see the \`entityDelta\` protodef type in
  // node-minecraft-protocol): normally a single { dX, dY, dZ, ticks: 0 } step (the old flat
  // format), but when the server batched several ticks' worth of movement into one packet it's
  // several chained steps, each relative to the position produced by the previous one. Applying
  // them in order is required to end up at the right final position. Pre-26.3 versions never
  // have \`packet.move\`; they still carry the flat dX/dY/dZ fields directly.
  function entityDeltaSteps (packet) {
    if (packet.move) return packet.move.steps
    return [{ dX: packet.dX, dY: packet.dY, dZ: packet.dZ }]
  }

  function applyEntityDeltaSteps (entity, steps) {
    let scale = null
    if (bot.supportFeature('fixedPointDelta')) scale = 32
    else if (bot.supportFeature('fixedPointDelta128')) scale = 128 * 32
    if (scale === null) return
    for (const step of steps) {
      entity.position.translate(step.dX / scale, step.dY / scale, step.dZ / scale)
    }
  }

  bot._client.on('rel_entity_move', (packet) => {`,
  label: 'mineflayer entities (stepped helpers)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'applyEntityDeltaSteps(entity, entityDeltaSteps(packet))\n    bot.emit(\'entityMoved\', entity)\n  })',
  anchor: `  bot._client.on('rel_entity_move', (packet) => {
    // entity relative move
    const entity = fetchEntity(packet.entityId)
    if (bot.supportFeature('fixedPointDelta')) {
      entity.position.translate(packet.dX / 32, packet.dY / 32, packet.dZ / 32)
    } else if (bot.supportFeature('fixedPointDelta128')) {
      entity.position.translate(packet.dX / (128 * 32), packet.dY / (128 * 32), packet.dZ / (128 * 32))
    }
    bot.emit('entityMoved', entity)
  })`,
  replacement: `  bot._client.on('rel_entity_move', (packet) => {
    // entity relative move
    const entity = fetchEntity(packet.entityId)
    applyEntityDeltaSteps(entity, entityDeltaSteps(packet))
    bot.emit('entityMoved', entity)
  })`,
  label: 'mineflayer entities (rel_entity_move)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'applyEntityDeltaSteps(entity, entityDeltaSteps(packet))\n    entity.yaw',
  anchor: `  bot._client.on('entity_move_look', (packet) => {
    // entity look and relative move
    const entity = fetchEntity(packet.entityId)
    if (bot.supportFeature('fixedPointDelta')) {
      entity.position.translate(packet.dX / 32, packet.dY / 32, packet.dZ / 32)
    } else if (bot.supportFeature('fixedPointDelta128')) {
      entity.position.translate(packet.dX / (128 * 32), packet.dY / (128 * 32), packet.dZ / (128 * 32))
    }
    entity.yaw = conv.fromNotchianYawByte(packet.yaw)`,
  replacement: `  bot._client.on('entity_move_look', (packet) => {
    // entity look and relative move (26.3: stepped entityDelta, see entityDeltaSteps)
    const entity = fetchEntity(packet.entityId)
    applyEntityDeltaSteps(entity, entityDeltaSteps(packet))
    entity.yaw = conv.fromNotchianYawByte(packet.yaw)`,
  label: 'mineflayer entities (entity_move_look)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: "packet.positionType === 'stepped'",
  anchor: `  bot._client.on('sync_entity_position', (packet) => {
    const entity = fetchEntity(packet.entityId)
    entity.position.set(packet.x, packet.y, packet.z)
    entity.velocity.set(packet.dx, packet.dy, packet.dz)`,
  replacement: `  bot._client.on('sync_entity_position', (packet) => {
    const entity = fetchEntity(packet.entityId)
    if (packet.positionType === 'stepped') {
      // 26.3+: PositionPath carries absolute per-step positions; apply every step in order.
      for (const step of packet.steps) {
        entity.position.set(step.x, step.y, step.z)
      }
    } else if (packet.positionType === 'linear') {
      // 26.3+: Linear PositionPath -- a single absolute position, no velocity field anymore.
      entity.position.set(packet.x, packet.y, packet.z)
    } else {
      // Pre-26.3: flat x/y/z plus a dx/dy/dz velocity.
      entity.position.set(packet.x, packet.y, packet.z)
      entity.velocity.set(packet.dx, packet.dy, packet.dz)
    }`,
  label: 'mineflayer entities (sync_entity_position)'
})
patch('mineflayer/lib/plugins/entities.js', {
  marker: "write('punch'",
  anchor: `  function swingArm (arm = 'right', showHand = true) {
    const hand = arm === 'right' ? 0 : 1`,
  replacement: `  function swingArm (arm = 'right', showHand = true) {
    if (bot.supportFeature('swingUsesPunchPacket')) {
      // 26.3+: serverbound swing was replaced by the empty punch packet; the server picks the hand.
      bot._client.write('punch', {})
      return
    }
    const hand = arm === 'right' ? 0 : 1`,
  label: 'mineflayer entities (swingArm punch)'
})

// ---------------------------------------------------------------------------
// 5. mineflayer game.js & physics.js: queued replies, teleport echo, tick_end,
//    duplicate position suppression, stale teleport drop, play guards
//    (upstream #4099, #4107, #4108, #4125, #4137, #4194, #4206)
// ---------------------------------------------------------------------------
patch('mineflayer/lib/plugins/game.js', {
  marker: 'bot._replyOnNextTick(pong)',
  anchor: `  bot._client.on('ping', (data) => {
    bot._client.write('pong', {
      id: data.id
    })
  })`,
  replacement: `  bot._client.on('ping', (data) => {
    const pong = () => bot._client.write('pong', { id: data.id })
    if (bot._client.state === 'play' && bot._replyOnNextTick) bot._replyOnNextTick(pong)
    else pong()
  })`,
  label: 'mineflayer game (queued ping reply)'
})
patch('mineflayer/lib/plugins/physics.js', {
  marker: 'const sendsTickEnd = bot.supportFeature',
  anchor: "  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')",
  replacement: "  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')\n  // 1.21.2+ clients end every tick with a tick_end packet, sent after that tick's movement packet\n  const sendsTickEnd = bot.supportFeature('sendsClientTickEndPacket')",
  label: 'mineflayer physics (sendsTickEnd flag)'
})
patch('mineflayer/lib/plugins/physics.js', {
  marker: "if (sendsTickEnd) bot._client.write('tick_end', {})",
  anchor: `  function tickPhysics (now) {
    if (bot._client.state !== 'play') return // do nothing outside of the play state (e.g. server transfer configuration phase)
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return // entity not ready
    if (bot.blockAt(bot.entity.position) == null) return // check if chunk is unloaded
    if (bot.physicsEnabled && shouldUsePhysics) {
      physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (shouldUsePhysics) {
      updatePosition(now)
    }
  }`,
  replacement: `  function tickPhysics (now) {
    if (bot._client.state !== 'play') return // do nothing outside of the play state (e.g. server transfer configuration phase)
    const answeredTeleport = flushReplies()
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return // entity not ready
    if (bot.blockAt(bot.entity.position) != null) { // otherwise the chunk is unloaded: no simulation
      if (bot.physicsEnabled && shouldUsePhysics) {
        physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
        bot.emit('physicsTick')
        bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
      }
      // 26.3 accepts at most one position-bearing packet per client tick; a queued teleport reply already sent position_look.
      if (shouldUsePhysics && !(bot.version === '26.3' && answeredTeleport)) {
        updatePosition(now)
      }
    }
    if (sendsTickEnd) bot._client.write('tick_end', {})
  }`,
  label: 'mineflayer physics (tickPhysics flush + duplicate guard + tick_end)'
})
patch('mineflayer/lib/plugins/physics.js', {
  marker: 'pendingReplies.length = 0\n  }',
  anchor: `  function cleanup () {
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = null
  }`,
  replacement: `  function cleanup () {
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = null
    cancelRespawnReply()
    clearTimeout(replyTimer)
    replyTimer = null
    pendingReplies.length = 0
  }`,
  label: 'mineflayer physics (cleanup)'
})
for (const fn of ['sendPacketPosition (position, onGround)', 'sendPacketLook (yaw, pitch, onGround)', 'sendPacketPositionAndLook (position, yaw, pitch, onGround)']) {
  const name = fn.split(' ')[0]
  patch('mineflayer/lib/plugins/physics.js', {
    marker: `if (bot._client.state !== 'play') return // guard ${name}`,
    anchor: `  function ${fn} {\n    // sends data, no logic`,
    replacement: `  function ${fn} {\n    // sends data, no logic\n    if (bot._client.state !== 'play') return // guard ${name}`,
    label: `mineflayer physics (play guard ${name})`
  })
}
patch('mineflayer/lib/plugins/physics.js', {
  marker: 'const pendingReplies = []',
  anchor: `  // player position and look (clientbound)
  bot._client.on('position', (packet) => {
    // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
    // e.g. when crouching/crawling/swimming. Can someone confirm?
    bot.entity.height = 1.8`,
  replacement: `  // Queue replies to pings and teleports so they drain in arrival order at the start of the next tick.
  const pendingReplies = []
  let replyTimer = null

  function flushReplies () {
    clearTimeout(replyTimer)
    replyTimer = null
    if (bot._client.state !== 'play') return false
    let answeredTeleport = false
    while (pendingReplies.length) {
      const reply = pendingReplies.shift()
      reply()
      answeredTeleport ||= reply.teleport === true
    }
    return answeredTeleport
  }

  bot._replyOnNextTick = (reply) => {
    pendingReplies.push(reply)
    if (doPhysicsTimer === null && replyTimer === null) replyTimer = setTimeout(flushReplies, PHYSICS_INTERVAL_MS)
  }

  // player position and look (clientbound)
  bot._client.on('position', (packet) => {
    cancelRespawnReply()
    // Is this necessary? Feels like it might wrongly overwrite hitbox size sometimes
    // e.g. when crouching/crawling/swimming. Can someone confirm?
    bot.entity.height = 1.8`,
  label: 'mineflayer physics (reply queue)'
})
patch('mineflayer/lib/plugins/physics.js', {
  marker: 'function answerTeleport (teleportId, pos, yaw, pitch)',
  anchor: `    bot.entity.yaw = conv.fromNotchianYaw(newYaw)
    bot.entity.pitch = conv.fromNotchianPitch(newPitch)
    bot.entity.onGround = false

    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })
    }

    // After death/respawn, delay the forced position_look response.
    // Sending it immediately causes "Invalid move player packet" kicks
    // on older servers, but the server needs it to complete the respawn.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      const delayedPos = pos.clone()
      const delayedYaw = newYaw
      const delayedPitch = newPitch
      const delayedOnGround = bot.entity.onGround
      setTimeout(() => {
        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
        shouldUsePhysics = true
        bot.jumpTicks = 0
        lastSentYaw = bot.entity.yaw
        lastSentPitch = bot.entity.pitch
        bot.emit('forcedMove')
      }, 1500)
      return
    }

    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)

    shouldUsePhysics = true
    bot.jumpTicks = 0
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch

    bot.emit('forcedMove')
  })`,
  replacement: `    bot.entity.yaw = conv.fromNotchianYaw(newYaw)
    bot.entity.pitch = conv.fromNotchianPitch(newPitch)
    bot.jumpTicks = 0

    const teleportPos = pos.clone()
    const reply = () => answerTeleport(packet.teleportId, teleportPos, newYaw, newPitch)
    reply.teleport = true
    // Two teleports in one tick: 26.3 kicks when a stale teleport is confirmed with its old position.
    if (bot.supportFeature('teleportConfirmHasPosition')) {
      for (let i = pendingReplies.length - 1; i >= 0; i--) {
        if (pendingReplies[i].teleport) pendingReplies.splice(i, 1)
      }
    }
    bot._replyOnNextTick(reply)
  })

  function answerTeleport (teleportId, pos, yaw, pitch) {
    if (bot.supportFeature('teleportUsesOwnPacket')) {
      // 26.3+ (protocol 777): accept_teleportation echoes resolved position/rotation.
      bot._client.write('teleport_confirm', {
        teleportId,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yRot: yaw,
        xRot: pitch
      })
    }

    const confirmMove = () => {
      shouldUsePhysics = true
      lastSentYaw = conv.fromNotchianYaw(yaw)
      lastSentPitch = conv.fromNotchianPitch(pitch)
      bot.emit('forcedMove')
    }

    // After death/respawn, delay the forced position_look response.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      respawnReply = setTimeout(() => {
        respawnReply = null
        const completeRespawn = () => {
          sendPacketPositionAndLook(pos, yaw, pitch, false)
          confirmMove()
        }
        if (bot.version === '26.3') {
          completeRespawn.teleport = true
          bot._replyOnNextTick(completeRespawn)
        } else {
          completeRespawn()
        }
      }, 1500)
      return
    }

    sendPacketPositionAndLook(pos, yaw, pitch, false)
    confirmMove()
  }`,
  label: 'mineflayer physics (position handler + answerTeleport)'
})
patch('mineflayer/lib/plugins/physics.js', {
  marker: 'function cancelRespawnReply ()',
  anchor: `  let respawnTimer = 0
  bot.on('mount', () => { shouldUsePhysics = false })
  bot.on('death', () => {
    shouldUsePhysics = false
    respawnTimer = Date.now()
  })
  bot.on('respawn', () => { shouldUsePhysics = false })
  bot.on('login', () => {
    shouldUsePhysics = false
    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      doPhysicsTimer = setInterval(doPhysics, PHYSICS_INTERVAL_MS)
    }
  })
  // A proxy (e.g. Velocity) transferring us to another server makes the client
  // re-enter the configuration phase, during which play-state movement packets
  // are not allowed. Physics is re-enabled by the position packet handler once
  // the server finishes configuration and play resumes.
  if (hasConfigurationState) {
    bot._client.on('start_configuration', () => { shouldUsePhysics = false })
  }`,
  replacement: `  let respawnTimer = 0
  let respawnReply = null
  function cancelRespawnReply () {
    clearTimeout(respawnReply)
    respawnReply = null
  }
  function dropQueuedTeleports () {
    for (let i = pendingReplies.length - 1; i >= 0; i--) {
      if (pendingReplies[i].teleport) pendingReplies.splice(i, 1)
    }
  }
  bot.on('mount', () => { shouldUsePhysics = false })
  bot.on('death', () => {
    shouldUsePhysics = false
    respawnTimer = Date.now()
  })
  bot.on('respawn', () => {
    shouldUsePhysics = false
    dropQueuedTeleports()
  })
  bot.on('login', () => {
    shouldUsePhysics = false
    cancelRespawnReply()
    dropQueuedTeleports()
    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      doPhysicsTimer = setInterval(doPhysics, PHYSICS_INTERVAL_MS)
    }
  })
  if (hasConfigurationState) {
    bot._client.on('start_configuration', () => {
      shouldUsePhysics = false
      cancelRespawnReply()
    })
  }
  bot._client.on('state', (newState) => {
    if (newState !== 'play') {
      clearTimeout(replyTimer)
      replyTimer = null
      pendingReplies.length = 0
    }
  })`,
  label: 'mineflayer physics (lifecycle & stale reply guards)'
})

// ---------------------------------------------------------------------------
// 6. mineflayer digging/inventory/place/sequence: 26.3 player-action ids + shared sequence (#4146, #4085)
// ---------------------------------------------------------------------------
{
  const rel = 'mineflayer/lib/playerActionIds.js'
  const p = path.join(NM, rel)
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `// ids of ServerboundPlayerActionPacket's action enum (\`block_dig\` status). 26.3 inserted
// CHANGE_DESTROY_DIRECTION at id 1, shifting every later action up by one.
module.exports = { getPlayerActionIds }

function getPlayerActionIds (bot) {
  const shifted = bot.supportFeature('playerActionHasChangeDestroyDirection')
  return {
    start: 0,
    abort: shifted ? 2 : 1,
    finish: shifted ? 3 : 2,
    releaseUseItem: shifted ? 6 : 5
  }
}
`)
    info('mineflayer playerActionIds: created lib/playerActionIds.js')
  } else {
    info('mineflayer playerActionIds: already patched')
  }
}
{
  const rel = 'mineflayer/lib/plugins/sequence.js'
  const p = path.join(NM, rel)
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `module.exports = inject
// One block prediction sequence shared by dig start/stop, use_item_on and use_item.
function inject (bot) {
  let sequence = 0
  bot._nextSequence = () => ++sequence
}
`)
    info('mineflayer sequence: created lib/plugins/sequence.js')
  } else {
    info('mineflayer sequence: already patched')
  }
}
patch('mineflayer/lib/loader.js', {
  marker: "sequence: require('./plugins/sequence')",
  anchor: "  particle: require('./plugins/particle')\n}",
  replacement: "  particle: require('./plugins/particle'),\n  sequence: require('./plugins/sequence')\n}",
  label: 'mineflayer loader (sequence plugin)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'getPlayerActionIds',
  anchor: "const { Vec3 } = require('vec3')\n",
  replacement: "const { Vec3 } = require('vec3')\nconst { getPlayerActionIds } = require('../playerActionIds')\n",
  label: 'mineflayer digging (playerActionIds import)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'getPlayerActionIds(bot).start',
  anchor: '      status: 0, // start digging',
  replacement: '      status: getPlayerActionIds(bot).start, // start digging',
  label: 'mineflayer digging (start status)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'getPlayerActionIds(bot).finish',
  anchor: '          status: 2, // finish digging',
  replacement: '          status: getPlayerActionIds(bot).finish, // finish digging',
  label: 'mineflayer digging (finish status)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'getPlayerActionIds(bot).abort',
  anchor: '        status: 1, // cancel digging',
  replacement: '        status: getPlayerActionIds(bot).abort, // cancel digging',
  label: 'mineflayer digging (abort status)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'sequence: bot._nextSequence()',
  anchor: '      face: bot.targetDigFace // default face is 1 (top)\n    })',
  replacement: '      face: bot.targetDigFace, // default face is 1 (top)\n      sequence: bot._nextSequence()\n    })',
  label: 'mineflayer digging (start sequence)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'face: bot.targetDigFace, // always the same as the start face',
  anchor: '          face: bot.targetDigFace // always the same as the start face\n        })',
  replacement: '          face: bot.targetDigFace, // always the same as the start face\n          sequence: bot._nextSequence()\n        })',
  label: 'mineflayer digging (finish sequence)'
})
patch('mineflayer/lib/plugins/digging.js', {
  marker: 'face: cancellationDiggingFace,\n        sequence: 0',
  anchor: '        face: cancellationDiggingFace\n      })',
  replacement: '        face: cancellationDiggingFace,\n        sequence: 0\n      })',
  label: 'mineflayer digging (abort sequence)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'getPlayerActionIds',
  anchor: "const { toNotchianYaw, toNotchianPitch } = require('../conversions')\n",
  replacement: "const { toNotchianYaw, toNotchianPitch } = require('../conversions')\nconst { getPlayerActionIds } = require('../playerActionIds')\n",
  label: 'mineflayer inventory (playerActionIds import)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'getPlayerActionIds(bot).releaseUseItem',
  anchor: '      status: 5,',
  replacement: '      status: getPlayerActionIds(bot).releaseUseItem,',
  label: 'mineflayer inventory (release status)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'let eatingTask = createDoneTask()\n\n  let nextActionNumber',
  anchor: `  let eatingTask = createDoneTask()
  let sequence = 0

  let nextActionNumber = 0 // < 1.17`,
  replacement: `  let eatingTask = createDoneTask()

  let nextActionNumber = 0 // < 1.17`,
  label: 'mineflayer inventory (remove local sequence)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'if (!(offHand ? bot.inventory.slots[45] : bot.heldItem)) return',
  anchor: `  function activateItem (offHand = false) {
    bot.usingHeldItem = true
    sequence++`,
  replacement: `  function activateItem (offHand = false) {
    // use_item must not be sent for an empty hand
    if (!(offHand ? bot.inventory.slots[45] : bot.heldItem)) return
    bot.usingHeldItem = true`,
  label: 'mineflayer inventory (empty-hand guard)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'sequence: bot._nextSequence(),\n        rotation:',
  anchor: `      bot._client.write('use_item', {
        hand: offHand ? 1 : 0,
        sequence,
        rotation:`,
  replacement: `      bot._client.write('use_item', {
        hand: offHand ? 1 : 0,
        sequence: bot._nextSequence(),
        rotation:`,
  label: 'mineflayer inventory (use_item sequence)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'cursorPos = cursorPos ?? new Vec3(0.5 + direction.x * 0.5',
  anchor: `    cursorPos = cursorPos ?? new Vec3(0.5, 0.5, 0.5)
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false)`,
  replacement: `    // The cursor must lie on the clicked face
    cursorPos = cursorPos ?? new Vec3(0.5 + direction.x * 0.5, 0.5 + direction.y * 0.5, 0.5 + direction.z * 0.5)
    // TODO: tell the server that we are not sneaking while doing this
    await bot.lookAt(block.position.plus(cursorPos), false)`,
  label: 'mineflayer inventory (activateBlock cursor)'
})
patch('mineflayer/lib/plugins/inventory.js', {
  marker: 'sequence: bot._nextSequence(), // 1.19.0+',
  anchor: '        sequence: 0, // 1.19.0+',
  replacement: '        sequence: bot._nextSequence(), // 1.19.0+',
  label: 'mineflayer inventory (activateBlock sequence)'
})
patch('mineflayer/lib/plugins/generic_place.js', {
  marker: "const pos = referenceBlock.position\n\n    if (bot.supportFeature('blockPlaceHasHeldItem'))",
  anchor: `    const pos = referenceBlock.position

    if (options.swingArm) {
      bot.swingArm(options.swingArm, options.showHand)
    }

    if (bot.supportFeature('blockPlaceHasHeldItem')) {`,
  replacement: `    const pos = referenceBlock.position

    if (bot.supportFeature('blockPlaceHasHeldItem')) {`,
  label: 'mineflayer generic_place (remove pre-packet swing)'
})
patch('mineflayer/lib/plugins/generic_place.js', {
  marker: '// The swing must follow use_item_on',
  anchor: `        insideBlock: false,
        sequence: 0, // 1.19.0
        worldBorderHit: false // 1.21.3
      })
    }

    return pos`,
  replacement: `        insideBlock: false,
        sequence: bot._nextSequence(), // 1.19.0
        worldBorderHit: false // 1.21.3
      })
    }

    // The swing must follow use_item_on
    if (options.swingArm) {
      bot.swingArm(options.swingArm, options.showHand)
    }

    return pos`,
  label: 'mineflayer generic_place (sequence + post-packet swing)'
})
patch('mineflayer/lib/plugins/place_entity.js', {
  marker: 'toNotchianYaw',
  anchor: "const assert = require('assert')\n",
  replacement: "const assert = require('assert')\nconst { toNotchianYaw, toNotchianPitch } = require('../conversions')\n",
  label: 'mineflayer place_entity (conversions import)'
})
patch('mineflayer/lib/plugins/place_entity.js', {
  marker: 'sequence: bot._nextSequence(), // 1.19.0+',
  anchor: `        bot._client.write('use_item', {
          hand: options.offhand ? 1 : 0
        })`,
  replacement: `        bot._client.write('use_item', {
          hand: options.offhand ? 1 : 0,
          sequence: bot._nextSequence(), // 1.19.0+
          rotation: { // 1.21.2+
            x: toNotchianYaw(bot.entity.yaw),
            y: toNotchianPitch(bot.entity.pitch)
          }
        })`,
  label: 'mineflayer place_entity (use_item sequence + rotation)'
})

// ---------------------------------------------------------------------------
// 7. mineflayer particle.js: 26.3 particle speed (upstream #4206/20)
// ---------------------------------------------------------------------------
patch('mineflayer/lib/particle.js', {
  marker: 'packet.xMaxSpeed',
  anchor: '          packet.velocityOffset,',
  replacement: '          packet.velocityOffset ?? packet.xMaxSpeed,',
  label: 'mineflayer particle (xMaxSpeed)'
})

// ---------------------------------------------------------------------------
// 8. NMP server/chat.js: checksum & ack validation order (PR #1553)
// ---------------------------------------------------------------------------
patch('minecraft-protocol/src/server/chat.js', {
  marker: "throw new VerificationError('Invalid chat acknowledgement checksum')",
  anchor: `      const unwrapped = pending.unwrap(packet.offset, packet.acknowledged)

      const length = Buffer.byteLength(packet.message, 'utf8')
      const acknowledgements = unwrapped.length > 0 ? ['i32', unwrapped.length, 'buffer', Buffer.concat(...unwrapped)] : ['i32', 0]`,
  replacement: `      const unwrapped = pending.unwrap(packet.offset, packet.acknowledged)

      if (client.supportFeature('chatGlobalIndexAndChecksum') && options.enforceChatChecksum && packet.checksum !== undefined) {
        const expectedChecksum = computeChatChecksum(unwrapped.map(signature => ({ signature })))
        if (packet.checksum !== 0 && packet.checksum !== expectedChecksum) {
          throw new VerificationError('Invalid chat acknowledgement checksum')
        }
      }

      const length = Buffer.byteLength(packet.message, 'utf8')
      const acknowledgements = unwrapped.length > 0 ? ['i32', unwrapped.length, 'buffer', Buffer.concat(unwrapped)] : ['i32', 0]`,
  label: 'NMP server/chat (session checksum & Buffer.concat)'
})
patch('minecraft-protocol/src/server/chat.js', {
  marker: '// Checksum validated inside validateSession',
  anchor: `    // Validate checksum for 1.21.5+
    if (client.supportFeature('chatGlobalIndexAndChecksum') && options.enforceChatChecksum && packet.checksum !== undefined) {
      const expectedChecksum = computeChatChecksum(client._lastSeenMessages || [])
      if (packet.checksum !== 0 && packet.checksum !== expectedChecksum) {
        return raise('multiplayer.disconnect.chat_validation_failed')
      }
    }`,
  replacement: '    // Checksum validated inside validateSession against unwrapped signatures',
  label: 'NMP server/chat (remove stale pre-unwrap checksum check)'
})
patch('minecraft-protocol/src/server/chat.js', {
  marker: 'const valid = pending.applyOffset(packet.count)',
  anchor: '      const valid = client._lastSeenMessages.applyOffset(packet.count)',
  replacement: '      const valid = pending.applyOffset(packet.count)',
  label: 'NMP server/chat (message_acknowledgement pending.applyOffset)'
})
patch('minecraft-protocol/src/server/chat.js', {
  marker: "!client.supportFeature('signedChat')",
  anchor: '    if (!options.enforceSecureProfile || !server.features.signedChat) return // nothing signable',
  replacement: "    if (!options.enforceSecureProfile || !client.supportFeature('signedChat')) return // nothing signable",
  label: 'NMP server/chat (client.supportFeature signedChat)'
})

// ---------------------------------------------------------------------------
// 9. mineflayer 1.21.2+ entity_teleport relative flags + scoreboard + string mappers
// ---------------------------------------------------------------------------
patch('mineflayer/lib/plugins/entities.js', {
  marker: 'handleEntityTeleportRelative',
  anchor: `  bot._client.on('entity_teleport', (packet) => {
    // entity teleport
    const entity = fetchEntity(packet.entityId)
    if (bot.supportFeature('fixedPointPosition')) {
      entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    }
    if (bot.supportFeature('doublePosition')) {
      entity.position.set(packet.x, packet.y, packet.z)
    }
    entity.yaw = conv.fromNotchianYawByte(packet.yaw)
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    bot.emit('entityMoved', entity)
  })`,
  replacement: `  function handleEntityTeleportLegacy (packet) {
    // entity teleport
    const entity = fetchEntity(packet.entityId)
    if (bot.supportFeature('fixedPointPosition')) {
      entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    }
    if (bot.supportFeature('doublePosition')) {
      entity.position.set(packet.x, packet.y, packet.z)
    }
    entity.yaw = conv.fromNotchianYawByte(packet.yaw)
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    bot.emit('entityMoved', entity)
  }

  // 1.21.2+: same layout as the player position packet, each part absolute or relative per flag
  function handleEntityTeleportRelative (packet) {
    const entity = fetchEntity(packet.entityId)
    const { position: pos, velocity: vel } = entity
    const oldYaw = conv.toNotchianYaw(entity.yaw)
    const oldPitch = conv.toNotchianPitch(entity.pitch)
    const newYaw = (packet.flags.yaw ? oldYaw : 0) + packet.yaw
    const newPitch = (packet.flags.pitch ? oldPitch : 0) + packet.pitch
    pos.set(
      packet.flags.x ? pos.x + packet.x : packet.x,
      packet.flags.y ? pos.y + packet.y : packet.y,
      packet.flags.z ? pos.z + packet.z : packet.z
    )
    const v = packet.flags.yawDelta
      ? rotateVelocity(vel, (oldPitch - newPitch) * Math.PI / 180, (oldYaw - newYaw) * Math.PI / 180)
      : vel.clone()
    vel.set(
      (packet.flags.dx ? v.x : 0) + packet.dx,
      (packet.flags.dy ? v.y : 0) + packet.dy,
      (packet.flags.dz ? v.z : 0) + packet.dz
    )
    entity.yaw = conv.fromNotchianYaw(newYaw)
    entity.pitch = conv.fromNotchianPitch(newPitch)
    bot.emit('entityMoved', entity)
  }

  function rotateVelocity (v, pitchDelta, yawDelta) {
    const cp = Math.cos(pitchDelta)
    const sp = Math.sin(pitchDelta)
    const y = v.y * cp + v.z * sp
    const z = v.z * cp - v.y * sp
    const cy = Math.cos(yawDelta)
    const sy = Math.sin(yawDelta)
    return new Vec3(v.x * cy + z * sy, y, z * cy - v.x * sy)
  }

  bot._client.on('entity_teleport', bot.supportFeature('entityTeleportHasRelativeFlags') ? handleEntityTeleportRelative : handleEntityTeleportLegacy)`,
  label: 'mineflayer entities (1.21.2+ entity_teleport relative flags)'
})

patch('mineflayer/lib/plugins/scoreboard.js', {
  marker: "bot._client.on('reset_score'",
  anchor: `  bot._client.on('scoreboard_score', (packet) => {
    const scoreboard = scoreboards[packet.scoreName]
    if (scoreboard !== undefined && packet.action === 0) {
      const updated = scoreboard.add(packet.itemName, packet.value)
      bot.emit('scoreUpdated', scoreboard, updated)
    }

    if (packet.action === 1) {
      if (scoreboard !== undefined) {
        const removed = scoreboard.remove(packet.itemName)
        return bot.emit('scoreRemoved', scoreboard, removed)
      }

      for (const sb of Object.values(scoreboards)) {
        if (packet.itemName in sb.itemsMap) {
          const removed = sb.remove(packet.itemName)
          return bot.emit('scoreRemoved', sb, removed)
        }
      }
    }
  })`,
  replacement: `  function removeScore (objectiveName, itemName) {
    if (objectiveName) {
      const scoreboard = scoreboards[objectiveName]
      if (scoreboard === undefined || !(itemName in scoreboard.itemsMap)) return
      const removed = scoreboard.remove(itemName)
      return bot.emit('scoreRemoved', scoreboard, removed)
    }

    for (const sb of Object.values(scoreboards)) {
      if (itemName in sb.itemsMap) {
        const removed = sb.remove(itemName)
        bot.emit('scoreRemoved', sb, removed)
      }
    }
  }

  bot._client.on('scoreboard_score', (packet) => {
    const scoreboard = scoreboards[packet.scoreName]
    if (packet.action === 1) return removeScore(packet.scoreName, packet.itemName)
    if (scoreboard === undefined) return
    const updated = scoreboard.add(packet.itemName, packet.value, packet.display_name)
    bot.emit('scoreUpdated', scoreboard, updated)
  })

  // 1.20.3+
  bot._client.on('reset_score', (packet) => {
    removeScore(packet.objective_name, packet.entity_name)
  })`,
  label: 'mineflayer scoreboard plugin (1.20.3+ scoreboard_score & reset_score)'
})

patch('mineflayer/lib/scoreboard.js', {
  marker: 'this.title = ChatMessage.fromNotch(title)',
  anchor: `    setTitle (title) {
      try {
        this.title = JSON.parse(title).text // version>1.13
      } catch {
        this.title = title
      }
    }

    add (name, value) {
      this.itemsMap[name] = { name, value }
      this.itemsMap[name] = {
        name,
        value,
        get displayName () {
          if (name in bot.teamMap) {
            return bot.teamMap[name].displayName(name)
          }
          return new ChatMessage(name)
        }
      }
      return this.itemsMap[name]
    }`,
  replacement: `    setTitle (title) {
      this.title = ChatMessage.fromNotch(title)
    }

    add (name, value, display) {
      const displayed = display == null ? null : ChatMessage.fromNotch(display)
      this.itemsMap[name] = {
        name,
        value,
        get displayName () {
          if (displayed !== null) {
            return displayed
          }
          if (name in bot.teamMap) {
            return bot.teamMap[name].displayName(name)
          }
          return new ChatMessage(name)
        }
      }
      return this.itemsMap[name]
    }`,
  label: 'mineflayer scoreboard model (ChatMessage.fromNotch + display)'
})

patch('mineflayer/lib/plugins/bed.js', {
  marker: "actionId: 'stop_sleeping'",
  anchor: `      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: 2,
        jumpBoost: 0
      })`,
  replacement: `      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: 'stop_sleeping',
        jumpBoost: 0
      })`,
  label: 'mineflayer bed (entity_action string mapper)'
})

patch('mineflayer/lib/plugins/game.js', {
  marker: "actionId: 'perform_respawn'",
  anchor: "      bot._client.write('client_command', { action: 0 })",
  replacement: "      bot._client.write('client_command', { actionId: 'perform_respawn' })",
  label: 'mineflayer game (client_command string mapper)'
})

patch('mineflayer/lib/plugins/health.js', {
  marker: "'perform_respawn'",
  anchor: "    bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 })",
  replacement: "    bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 'perform_respawn' })",
  label: 'mineflayer health (client_command string mapper)'
})

patch('mineflayer/lib/plugins/physics.js', {
  marker: "actionId: 'start_fall_flying'",
  anchor: `    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
      jumpBoost: 0
    })`,
  replacement: `    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: 'start_fall_flying',
      jumpBoost: 0
    })`,
  label: 'mineflayer physics (elytra start_fall_flying string mapper)'
})

patch('mineflayer/lib/plugins/physics.js', {
  marker: "actionId: state ? 'start_sprinting' : 'stop_sprinting'",
  anchor: `      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (state ? 'start_sprinting' : 'stop_sprinting')
          : (state ? 3 : 4),
        jumpBoost: 0
      })`,
  replacement: `      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: state ? 'start_sprinting' : 'stop_sprinting',
        jumpBoost: 0
      })`,
  label: 'mineflayer physics (sprint string mapper)'
})

patch('mineflayer/lib/plugins/physics.js', {
  marker: "actionId: state ? 'start_sneaking' : 'stop_sneaking'",
  anchor: `        bot._client.write('entity_action', {
          entityId: bot.entity.id,
          actionId: state ? 0 : 1,
          jumpBoost: 0
        })`,
  replacement: `        bot._client.write('entity_action', {
          entityId: bot.entity.id,
          actionId: state ? 'start_sneaking' : 'stop_sneaking',
          jumpBoost: 0
        })`,
  label: 'mineflayer physics (sneak string mapper)'
})

info('OK — 26.3 wire patches applied (entityDelta, stepped movement, queued ping/teleport echo, tick_end, punch, player actions, sequence, chunk light masks, particles, entity_teleport, scoreboard, entity_action/client_command mappers)')
