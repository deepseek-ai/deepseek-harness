/** Worker-side source buffer behavior. */

import { MessageChannel } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveInspectorOptions } from '../src/host/bridge/controller.ts'
import { HostBridgePublisher } from '../src/host/bridge/publisher.ts'
import { inspectorId } from '../src/shared/bridge/ids.ts'
import { InspectorSourceBuffer, maxStatePayloadBytes, type InspectorSourceBufferOptions } from '../src/shared/bridge/buffer.ts'
import { CORDIS_TREE_TOPIC } from '../src/shared/bridge/messages/cordis.ts'
import { CordisTreeCollector } from '../src/shared/cordis/collector.ts'
import { jsonByteLength, type InspectorJsonValue } from '../src/shared/json.ts'
import type { InspectorSourceDescriptor } from '../src/shared/bridge/messages/observation.ts'

const sourceId = inspectorId<'InspectorSourceId'>('source-buffer-test', 'sourceId')
const generation = inspectorId<'InspectorSourceGeneration'>('generation-buffer-test', 'generation')
const source: InspectorSourceDescriptor = {
  sourceId,
  generation,
  kind: 'host',
  label: 'Host',
  timeOriginMs: performance.timeOrigin,
  capabilities: [],
}

function buffer(
  maxQueuedRecords = 2,
  overrides: Partial<InspectorSourceBufferOptions> = {},
): InspectorSourceBuffer {
  return new InspectorSourceBuffer({
    topics: ['*'],
    maxQueuedRecords,
    maxQueuedBytes: 32_768,
    maxRecordsPerFrame: 8,
    maxFrameBytes: 32_768,
    ...overrides,
  })
}

describe('Inspector source buffer', () => {
  it('absorbs pre-replacement queue loss exactly once', () => {
    const records = buffer(1)
    expect(records.replacement(sourceId, generation)).toMatchObject({ nextSequence: 1, records: [] })
    records.publish('test/event', { ordinal: 1 }, 1)
    records.publish('test/event', { ordinal: 2 }, 2)

    expect(records.replacement(sourceId, generation)).toMatchObject({
      nextSequence: 2,
      records: [],
    })
    expect(records.takeBatch(sourceId, generation)).toMatchObject({
      firstSequence: 2,
      droppedBefore: 0,
      records: [{ topic: 'test/event', payload: { ordinal: 2 } }],
    })
  })

  it('validates records before either carrier can enqueue them', () => {
    const records = buffer()

    expect(() => { records.publish('', {}, 1) }).toThrow('topic must contain 1 to 128 characters')
    expect(() => { records.publish('x'.repeat(129), {}, 1) }).toThrow('topic must contain 1 to 128 characters')
    expect(() => { buffer(2, { topics: ['declared'] }).publish('undeclared', {}, 1) })
      .toThrow('source does not declare topic')
    expect(() => { records.publish('test/event', {}, Number.NaN) }).toThrow('monotonicMs must be finite')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => { records.publish('test/event', cyclic as never, 1) }).toThrow('lossless JSON data')
  })

  it('rejects oversized retained state without replacing the previous value', () => {
    const records = buffer(4, { maxFrameBytes: 4_300 })
    records.setState('state', { value: 'kept' }, 1)
    expect(() => { records.setState('state', { value: 'x'.repeat(1_000) }, 2) })
      .toThrow('source state exceeds the source-frame byte limit')
    expect(() => { records.setState('other', { value: 'x'.repeat(1_000) }, 3) })
      .toThrow('source state exceeds the source-frame byte limit')
    expect(records.replacement(sourceId, generation).records).toEqual([
      { topic: 'state', payload: { value: 'kept' }, monotonicMs: 1 },
    ])
  })

  it('accepts a single state payload at its budget with the largest record envelope', () => {
    const maxFrameBytes = 8_192
    const budget = maxStatePayloadBytes(maxFrameBytes)
    const topic = '\u0001'.repeat(128)
    const payload = 'x'.repeat(budget - 2)
    expect(jsonByteLength(payload)).toBe(budget)
    const records = buffer(4, { maxFrameBytes })
    records.setState(topic, payload, -Number.MAX_VALUE)
    const frame = JSON.stringify(records.replacement(sourceId, generation))
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(maxFrameBytes)
  })

  it('rejects a source-frame limit that leaves no state payload budget at option resolution', () => {
    const smallest = 5_121
    expect(maxStatePayloadBytes(smallest)).toBe(1)
    expect(resolveInspectorOptions({ maxSourceFrameBytes: smallest, maxBodyChunkBytes: 1 }).maxSourceFrameBytes).toBe(smallest)
    expect(() => resolveInspectorOptions({ maxSourceFrameBytes: smallest - 1, maxBodyChunkBytes: 1 }))
      .toThrow('maxSourceFrameBytes cannot carry a Cordis tree snapshot')
  })

  it('retains every pruned Cordis snapshot whose collector uses the state budget', async (test) => {
    const root = new Context()
    test.onTestFinished(async () => { await root.fiber.dispose() })
    for (let index = 0; index < 200; index++) await root.plugin({ name: `plugin-${String(index)}`, apply() {} })
    for (let maxFrameBytes = 8_192; maxFrameBytes < 8_448; maxFrameBytes++) {
      const collector = new CordisTreeCollector(root, { maxNodes: 1_000, maxBytes: maxStatePayloadBytes(maxFrameBytes) })
      const snapshot = collector.snapshot()
      collector.close()
      expect(snapshot.truncated).toBe(true)
      const payload = JSON.parse(JSON.stringify(snapshot)) as InspectorJsonValue
      buffer(4, { maxFrameBytes }).setState(CORDIS_TREE_TOPIC, payload, performance.now())
    }
  })

  it('splits frames at record, byte, and sequence gaps and discards pending records', () => {
    const records = buffer(10, { maxRecordsPerFrame: 2, maxFrameBytes: 4_300 })
    expect(records.hasPending).toBe(false)
    records.publish('test/event', { value: 'a'.repeat(40) }, 1)
    records.publish('test/event', { value: 'x'.repeat(1_000) }, 2)
    records.publish('test/event', { value: 'b'.repeat(40) }, 3)
    expect(records.hasPending).toBe(true)

    expect(records.takeBatch(sourceId, generation)).toMatchObject({ firstSequence: 1, records: [{ monotonicMs: 1 }] })
    expect(records.takeBatch(sourceId, generation)).toMatchObject({
      firstSequence: 3,
      droppedBefore: 1,
      records: [{ monotonicMs: 3 }],
    })
    expect(records.takeBatch(sourceId, generation)).toBeUndefined()

    records.publish('test/event', { ordinal: 4 }, 4)
    records.discardPending()
    expect(records.hasPending).toBe(false)

    const byteSplit = buffer(10, { maxFrameBytes: 4_300 })
    byteSplit.publish('test/event', { value: 'a'.repeat(100) }, 1)
    byteSplit.publish('test/event', { value: 'b'.repeat(100) }, 2)
    expect(byteSplit.takeBatch(sourceId, generation)?.records).toHaveLength(1)
    expect(byteSplit.takeBatch(sourceId, generation)?.records).toHaveLength(1)
  })

  it('drops queued records against the byte limit independently of the item limit', () => {
    const records = buffer(10, { maxQueuedBytes: 120 })
    records.publish('test/event', { value: 'a'.repeat(40) }, 1)
    records.publish('test/event', { value: 'b'.repeat(40) }, 2)

    expect(records.takeBatch(sourceId, generation)).toMatchObject({
      firstSequence: 2,
      droppedBefore: 1,
      records: [{ monotonicMs: 2 }],
    })
  })

  it('keeps at most one Host MessagePort observation batch in flight', async () => {
    const channel = new MessageChannel()
    const messages: unknown[] = []
    channel.port2.on('message', (message) => { messages.push(message) })
    channel.port2.start()
    const publisher = new HostBridgePublisher(channel.port1, source, {
      topics: ['*'],
      maxQueuedRecords: 2,
      maxQueuedBytes: 32_768,
      maxRecordsPerFrame: 1,
      maxFrameBytes: 32_768,
    })
    try {
      publisher.publish('test/event', { ordinal: 1 })
      publisher.flush()
      publisher.publish('test/event', { ordinal: 2 })
      publisher.publish('test/event', { ordinal: 3 })
      await vi.waitFor(() => { expect(messages).toHaveLength(1) })
      const first = messages[0] as { firstSequence: number; records: Array<{ payload: unknown }> }
      expect(first.records).toHaveLength(1)
      expect(first.records[0]?.payload).toEqual({ ordinal: 1 })

      publisher.acknowledge(first.firstSequence + first.records.length)
      await vi.waitFor(() => { expect(messages).toHaveLength(2) })
      const second = messages[1] as { firstSequence: number; droppedBefore: number; records: Array<{ payload: unknown }> }
      expect(second).toMatchObject({
        firstSequence: 2,
        droppedBefore: 0,
        records: [{ payload: { ordinal: 2 } }],
      })
      publisher.acknowledge(second.firstSequence + second.records.length)
      await vi.waitFor(() => { expect(messages).toHaveLength(3) })
      expect(messages[2]).toMatchObject({
        firstSequence: 3,
        records: [{ payload: { ordinal: 3 } }],
      })
    } finally {
      publisher.close()
      channel.port1.close()
      channel.port2.close()
    }
  })
})
