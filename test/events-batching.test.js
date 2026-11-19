'use strict'

/**
 * Event batching and aggregation — `zincai/events.js` EventPipeline.
 * Pure unit tests (deterministic clock, no Minecraft server needed):
 *   1. several near-simultaneous events -> one chronological batch
 *   2. events accumulated across model decisions -> separate batches, no duplicates
 *   3. critical events bypass the batch window (drainCritical)
 *   4. large batches split across maxBatchEvents, nothing lost
 *   5. chronological ordering preserved
 *   6. timestamps + elapsed time on every entry
 *   7. repeated identical low-priority events coalesced (count + first/last)
 *   8. no duplicate event delivery after markProcessed
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { EventPipeline, EVENT_DEFAULTS } = require('../zincai/events')

const NOW = 1_700_000_000_000 // 2026-11-18T12:00:00.000Z
const mockBot = { game: { dimension: 'minecraft:overworld' }, time: { timeOfDay: 0, age: 0, day: 1 } }

function record (pipe, { type, summary, importance, reactionClass, at, receivedAt, entities, where, dedupeKey, groupKey }) {
  return pipe.record({
    eventType: type,
    summary: summary || type,
    importance,
    reactionClass,
    occurredAt: at,
    occurrenceTimeKnown: true,
    receivedAt,
    entities: entities || [],
    where: where || { x: 10, y: 64, z: 5 },
    dedupeKey,
    groupKey
  }, mockBot)
}

function entrySummary (e) {
  return { seq: e.sequence, type: e.type, severity: e.severity, elapsedMs: e.elapsedMs, desc: e.description, count: e.count }
}

describe('events-batching — pipeline batching', () => {
  test('1: several near-simultaneous events are delivered as one chronological batch', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 16 })
    record(pipe, { type: 'hostile_approaching', summary: 'Zombie detected nearby', importance: 2, at: NOW + 1_000, entities: ['zombie'] })
    record(pipe, { type: 'player_approaching', summary: 'Player approaching from the north', importance: 2, at: NOW + 2_000, entities: ['Steve'] })
    record(pipe, { type: 'hunger_changed', summary: 'Hunger decreased', importance: 2, at: NOW + 3_000 })
    record(pipe, { type: 'objective_interrupted', summary: 'Mining interrupted by nearby threats', importance: 2, at: NOW + 5_000 })

    const batch = pipe.formatBatch({ nowMs: NOW + 9_000 })
    assert.equal(batch.type, 'event_batch')
    assert.equal(batch.event_count, 4)
    assert.equal(batch.first_event_at, new Date(NOW + 1_000).toISOString())
    assert.equal(batch.last_event_at, new Date(NOW + 5_000).toISOString())
    assert.equal(batch.moreRemaining, 0)
    // chronological by sequence (record/discovery order)
    assert.deepEqual(batch.events.map((e) => e.type), [
      'hostile_approaching', 'player_approaching', 'hunger_changed', 'objective_interrupted'
    ])
    // every entry carries its timestamp and elapsed age
    for (const e of batch.events) {
      assert.ok(e.timestamp.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/))
      assert.ok(Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0)
      assert.ok(Number.isFinite(e.ageSec))
      assert.ok(['critical', 'high', 'medium', 'low'].includes(e.severity))
    }
    // the rendered prompt block is a single batch header + chronological lines
    const rendered = pipe.formatBatchForPrompt({ batch, nowMs: NOW + 9_000 })
    assert.match(rendered.text, /recent events \(chronological batch: 4/)
    assert.match(rendered.text, /8s ago\] hostile_approaching/m)
    assert.match(rendered.text, /4s ago\] objective_interrupted/m)
    assert.equal(rendered.shownSequences.length, 4)
  })

  test('2: events accumulated while the model is processing are delivered together at the next decision, without duplicates', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 16 })
    record(pipe, { type: 'hostile_approaching', summary: 'zombie at the door', importance: 2, at: NOW + 1_000 })
    record(pipe, { type: 'hunger_changed', summary: 'peckish', importance: 2, at: NOW + 2_000 })

    // First model decision: delivers the batch accumulated so far.
    const batch1 = pipe.formatBatch({ nowMs: NOW + 5_000 })
    assert.equal(batch1.event_count, 2)
    const seqs1 = batch1.events.map((e) => e.sequence)
    pipe.markProcessed(seqs1, { via: 'model' })

    // More events arrive while the model was busy (and after the first batch).
    record(pipe, { type: 'objective_interrupted', summary: 'mining interrupted', importance: 2, at: NOW + 6_000 })
    record(pipe, { type: 'item_pickup', summary: 'picked up dirt', importance: 0, at: NOW + 7_000 })

    // Second model decision: only the new events are in the next batch.
    const batch2 = pipe.formatBatch({ nowMs: NOW + 11_000 })
    assert.equal(batch2.event_count, 2)
    assert.deepEqual(batch2.events.map((e) => e.type), ['objective_interrupted', 'item_pickup'])
    assert.deepEqual(batch2.events.map((e) => e.sequence), seqs1.map((s) => s + 2))
    pipe.markProcessed(batch2.events.map((e) => e.sequence), { via: 'model' })

    // No event appears in both batches.
    const all = new Set([...seqs1, ...batch2.events.map((e) => e.sequence)])
    assert.equal(all.size, seqs1.length + batch2.event_count)
    // A third decision delivers nothing (no duplicates).
    const batch3 = pipe.formatBatch({ nowMs: NOW + 12_000 })
    assert.equal(batch3.event_count, 0)
  })

  test('3: critical events bypass the batch window and are delivered immediately', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 16 })
    record(pipe, { type: 'hostile_approaching', summary: 'zombie nearby', importance: 2, at: NOW + 1_000 })
    record(pipe, { type: 'death', summary: 'died at 10,64,5', importance: 3, at: NOW + 2_000, entities: [] })
    record(pipe, { type: 'attacked', summary: 'hit by Steve', importance: 3, at: NOW + 3_000 })
    record(pipe, { type: 'health_threshold', summary: 'critical health', importance: 3, at: NOW + 4_000 })

    const critical = pipe.drainCritical({ nowMs: NOW + 9_000 })
    assert.equal(critical.count, 3)
    assert.deepEqual(critical.events.map((e) => e.eventType), ['death', 'attacked', 'health_threshold'])

    // The batch excludes critical events (they are handled out of band).
    const batch = pipe.formatBatch({ nowMs: NOW + 9_000 })
    assert.equal(batch.event_count, 1)
    assert.equal(batch.events[0].type, 'hostile_approaching')
    assert.equal(batch.events[0].severity, 'high')
  })

  test('4: large batches split into consecutive batches without losing events', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 2 })
    for (let i = 1; i <= 6; i++) {
      record(pipe, { type: 'item_pickup', summary: `picked up item ${i}`, importance: 0, at: NOW + i * 100, dedupeKey: `pickup-${i}` })
    }

    const delivered = []
    let batch
    do {
      batch = pipe.formatBatch({ nowMs: NOW + 10_000 })
      delivered.push(...batch.events.map((e) => e.sequence))
      pipe.markProcessed(batch.events.map((e) => e.sequence), { via: 'model' })
    } while (batch.moreRemaining > 0)

    assert.equal(delivered.length, 6, 'no events lost across split batches')
    assert.equal(delivered.sort((a, b) => a - b).join(','), [1, 2, 3, 4, 5, 6].join(','))
  })

  test('5: events are always delivered in chronological order', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 16 })
    // Recorded out of timestamp order: batch order follows sequence (discovery) order.
    record(pipe, { type: 'c', summary: 'third', importance: 1, at: NOW + 9_000 })
    record(pipe, { type: 'a', summary: 'first', importance: 1, at: NOW + 1_000 })
    record(pipe, { type: 'b', summary: 'second', importance: 1, at: NOW + 5_000 })

    const batch = pipe.formatBatch({ nowMs: NOW + 10_000 })
    assert.deepEqual(batch.events.map((e) => e.type), ['c', 'a', 'b'])
    assert.deepEqual(batch.events.map((e) => e.sequence), [1, 2, 3])
  })

  test('6: timestamps and elapsed times are correct on every entry', async () => {
    const pipe = new EventPipeline({ now: () => NOW, maxBatchEvents: 16 })
    record(pipe, { type: 'hostile_approaching', summary: 'zombie', importance: 2, at: NOW + 1_000 })

    const batch = pipe.formatBatch({ nowMs: NOW + 5_000 })
    const e = batch.events[0]
    assert.equal(e.timestamp, new Date(NOW + 1_000).toISOString())
    assert.equal(e.elapsedMs, 4_000)
    assert.equal(e.ageSec, 4)
    assert.equal(e.timestampMs, NOW + 1_000)

    // As time passes, elapsed age grows while the stored timestamp stays fixed.
    const later = pipe.formatBatch({ nowMs: NOW + 20_000 })
    assert.equal(later.events[0].timestamp, e.timestamp)
    assert.equal(later.events[0].elapsedMs, 19_000)
    assert.equal(later.events[0].ageSec, 19)
  })

  test('7: repeated identical low-priority events are coalesced (count + first/last timestamps)', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 16 })
    // Spaced beyond the dedupe window so they are recorded as distinct events.
    let t = NOW
    for (let i = 0; i < 5; i++) {
      t += 2_000
      record(pipe, { type: 'item_pickup', summary: 'picked up dirt', importance: 0, at: t, where: { x: 10, y: 64, z: 5 }, dedupeKey: `dirt-${i}` })
    }

    const batch = pipe.formatBatch({ nowMs: t + 1_000 })
    assert.equal(batch.event_count, 1, 'five repeats coalesced into one entry')
    const e = batch.events[0]
    assert.equal(e.count, 5)
    assert.equal(e.severity, 'low')
    assert.equal(e.first_event_at, new Date(NOW + 2_000).toISOString())
    assert.equal(e.last_event_at, new Date(t).toISOString())
    // elapsed age tracks the most recent occurrence.
    assert.equal(e.elapsedMs, 1_000)
  })

  test('8: no duplicate event delivery across consecutive model calls', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 3_000, maxBatchEvents: 16 })
    record(pipe, { type: 'objective_paused', summary: 'mining interrupted by threats', importance: 2, at: NOW + 1_000 })
    record(pipe, { type: 'inventory_capacity', summary: 'inventory full', importance: 2, at: NOW + 2_000 })

    const b1 = pipe.formatBatch({ nowMs: NOW + 5_000 })
    assert.equal(b1.event_count, 2)
    pipe.markProcessed(b1.events.map((e) => e.sequence), { via: 'model' })

    const b2 = pipe.formatBatch({ nowMs: NOW + 6_000 })
    assert.equal(b2.event_count, 0, 'second call delivers nothing already delivered')

    // New event after delivery appears once.
    record(pipe, { type: 'hostile_approaching', summary: 'zombie returns', importance: 2, at: NOW + 7_000 })
    const b3 = pipe.formatBatch({ nowMs: NOW + 8_000 })
    assert.equal(b3.event_count, 1)
    assert.equal(b3.events[0].description, 'zombie returns')
    pipe.markProcessed(b3.events.map((e) => e.sequence), { via: 'model' })
    assert.equal(pipe.formatBatch({ nowMs: NOW + 9_000 }).event_count, 0)
  })

  test('batch window exposes how long events waited (overdue flag)', async () => {
    const pipe = new EventPipeline({ now: () => NOW, batchWindowMs: 1_000, maxBatchEvents: 16 })
    record(pipe, { type: 'hostile_approaching', summary: 'zombie', importance: 2, at: NOW + 1_000, receivedAt: NOW + 1_000 })
    const batch = pipe.formatBatch({ nowMs: NOW + 5_000 })
    assert.equal(batch.windowMs, 4_000)
    assert.ok(batch.overdue, 'waited longer than the collection window')
  })
})

describe('events-batching — priority lanes', () => {
  test('deliveryLane classifies critical / batch / summary from existing priority', async () => {
    const pipe = new EventPipeline()
    assert.equal(pipe.deliveryLane({ reactionClass: 'immediate', importance: 3 }), 'critical')
    assert.equal(pipe.deliveryLane({ reactionClass: 'fast', importance: 2 }), 'batch')
    assert.equal(pipe.deliveryLane({ reactionClass: 'ambient', importance: 0 }), 'summary')
    assert.equal(pipe.deliveryLane({ importance: 3 }), 'critical')
    assert.equal(pipe.deliveryLane({ importance: 2 }), 'batch')
    assert.equal(pipe.deliveryLane({ importance: 1 }), 'summary')
  })

  test('EVENT_DEFAULTS map survival events to the expected lanes', async () => {
    const lane = (type) => pipeDeliveryLane(pipeDelivery(), type)
    // death, attack, critical health are immediate -> critical
    assert.equal(EVENT_DEFAULTS.death.reactionClass, 'immediate')
    assert.equal(EVENT_DEFAULTS.attacked.reactionClass, 'immediate')
    assert.equal(EVENT_DEFAULTS.health_threshold.reactionClass, 'immediate')
    // objective interruption, approaching hostile, hunger are important -> batch
    assert.equal(EVENT_DEFAULTS.objective_paused.reactionClass, 'fast')
    assert.equal(EVENT_DEFAULTS.hostile_approaching.reactionClass, 'fast')
    assert.equal(EVENT_DEFAULTS.hunger_threshold.reactionClass, 'fast')
    // ambient item updates are low priority
    assert.equal(EVENT_DEFAULTS.item_pickup.reactionClass, 'ambient')
    assert.equal(EVENT_DEFAULTS.item_pickup.importance, 1)
    assert.equal(EVENT_DEFAULTS.item_dropped.importance, 1)
  })
})

function pipeDelivery () { return new EventPipeline() }
function pipeDeliveryLane (pipe, type) {
  const def = EVENT_DEFAULTS[type]
  return pipe.deliveryLane({ reactionClass: def.reactionClass, importance: def.importance })
}