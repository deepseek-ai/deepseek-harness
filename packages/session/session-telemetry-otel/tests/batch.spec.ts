import { Buffer } from 'node:buffer'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionLogBatch } from '@deepseek-ai/dsh-otel'
import {
  DEFAULT_BATCH_DELAY_MILLIS,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_BATCH_EVENTS,
  SessionLogBatcher,
  type SessionLogBatchItem,
  type SessionLogBatchOptions,
} from '../src/batch.ts'

afterEach(() => {
  vi.useRealTimers()
})

const SESSION_A = brandString<SessionId>('session-a')
const SESSION_B = brandString<SessionId>('session-b')

interface Harness {
  readonly batcher: SessionLogBatcher
  readonly batches: SessionLogBatch[]
  readonly warnings: string[]
}

function harness(overrides: Partial<SessionLogBatchOptions> = {}): Harness {
  const batches: SessionLogBatch[] = []
  const warnings: string[] = []
  const batcher = new SessionLogBatcher(
    {
      maxBatchEvents: 100_000,
      maxBatchBytes: 10_000_000,
      batchDelayMillis: 60_000,
      ...overrides,
    },
    batch => batches.push(batch),
    message => warnings.push(message),
  )
  return { batcher, batches, warnings }
}

function event(seq: number, data: unknown = { turn: seq }): SessionLogBatchItem['event'] {
  return { type: 'turn/start', seq: SessionSeq(seq), time: 1_800_000_000_000 + seq, data }
}

function item(sessionId: SessionId, seq: number, overrides: Partial<SessionLogBatchItem> = {}): SessionLogBatchItem {
  return { sessionId, formatVersion: 4, event: event(seq), severityNumber: SeverityNumber.INFO, ...overrides }
}

function bodyBytes(batch: SessionLogBatch): number {
  return Buffer.byteLength(JSON.stringify({ events: batch.events }), 'utf8')
}

function seqs(batch: SessionLogBatch): number[] {
  return batch.events.map(carried => Number(carried.seq))
}

it('exposes the documented batch defaults', () => {
  expect([DEFAULT_MAX_BATCH_EVENTS, DEFAULT_MAX_BATCH_BYTES, DEFAULT_BATCH_DELAY_MILLIS]).toEqual([128, 1_048_576, 1_000])
})

it('flushes one contiguous batch when the event-count ceiling is reached', () => {
  const { batcher, batches } = harness({ maxBatchEvents: 3 })
  for (let seq = 0; seq < 3; seq++) batcher.push(item(SESSION_A, seq))
  expect(batches).toHaveLength(1)
  const [batch] = batches
  expect(batch).toMatchObject({
    sessionId: SESSION_A,
    formatVersion: 4,
    afterSeq: -1,
    throughSeq: 2,
    purpose: 'conversation',
  })
  expect(seqs(batch!)).toEqual([0, 1, 2])
  expect(batch!.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

it('splits at the byte ceiling instead of dropping events', () => {
  const limit = 700
  const { batcher, batches } = harness({ maxBatchBytes: limit })
  for (let seq = 0; seq < 20; seq++) batcher.push(item(SESSION_A, seq, { event: event(seq, { text: 'x'.repeat(40) }) }))
  batcher.flushSession(SESSION_A)
  expect(batches.length).toBeGreaterThan(1)
  expect(batches.flatMap(seqs)).toEqual(Array.from({ length: 20 }, (_, seq) => seq))
  for (const batch of batches) {
    expect(bodyBytes(batch)).toBeLessThanOrEqual(limit)
  }
})

it('sends one oversized event as its own batch', () => {
  const { batcher, batches } = harness({ maxBatchBytes: 100 })
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_A, 1, { event: event(1, { text: 'y'.repeat(200) }) }))
  batcher.push(item(SESSION_A, 2))
  batcher.flushSession(SESSION_A)
  expect(batches.map(seqs)).toEqual([[0], [1], [2]])
  expect(bodyBytes(batches[1]!)).toBeGreaterThan(100)
})

it('flushes the oldest buffered batch after the configured delay', async () => {
  vi.useFakeTimers()
  const { batcher, batches } = harness({ batchDelayMillis: 1_000 })
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_A, 1))
  expect(batches).toEqual([])
  await vi.advanceTimersByTimeAsync(999)
  expect(batches).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(batches.map(seqs)).toEqual([[0, 1]])
})

it('flushes an idle session and keeps its watermark', () => {
  const { batcher, batches, warnings } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_A, 1))
  batcher.flushSession(SESSION_A)
  expect(batches.map(seqs)).toEqual([[0, 1]])
  batcher.push(item(SESSION_A, 2))
  batcher.flushSession(SESSION_A)
  expect(batches.map(batch => [batch.afterSeq, batch.throughSeq])).toEqual([[-1, 1], [1, 2]])
  // A duplicate seq never enters a second batch while the watermark is retained.
  batcher.push(item(SESSION_A, 2))
  batcher.push(item(SESSION_A, 2))
  expect(batches).toHaveLength(2)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('already covered')
})

it('flushes a closed session and forgets its watermark', () => {
  const { batcher, batches } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.closeSession(SESSION_A)
  expect(batches.map(seqs)).toEqual([[0]])
  // A later lifecycle of the same Session id restarts its own cursor.
  batcher.push(item(SESSION_A, 0))
  batcher.closeSession(SESSION_A)
  expect(batches.map(seqs)).toEqual([[0], [0]])
  expect(batches[0]!.batchId).not.toBe(batches[1]!.batchId)
})

it('treats an idle flush or close of an unknown session as a no-op', () => {
  const { batcher, batches, warnings } = harness()
  batcher.flushSession(brandString<SessionId>('missing'))
  batcher.closeSession(brandString<SessionId>('missing'))
  expect(batches).toEqual([])
  expect(warnings).toEqual([])
})

it('never mixes two interleaved sessions in one batch', () => {
  const { batcher, batches } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_B, 0))
  batcher.push(item(SESSION_A, 1))
  batcher.push(item(SESSION_B, 1))
  batcher.closeSession(SESSION_A)
  batcher.closeSession(SESSION_B)
  expect(batches.map(batch => [String(batch.sessionId), seqs(batch)])).toEqual([
    [String(SESSION_A), [0, 1]],
    [String(SESSION_B), [0, 1]],
  ])
})

it('closes a contiguous prefix at a sequence gap', () => {
  const { batcher, batches } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_A, 1))
  batcher.push(item(SESSION_A, 3))
  batcher.flushSession(SESSION_A)
  expect(batches.map(batch => [batch.afterSeq, batch.throughSeq, seqs(batch)])).toEqual([
    [-1, 1, [0, 1]],
    [2, 3, [3]],
  ])
})

it('starts a new cursor when the session format generation changes', () => {
  const { batcher, batches } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_A, 0, { formatVersion: 5 }))
  batcher.flushSession(SESSION_A)
  expect(batches.map(batch => [batch.formatVersion, seqs(batch)])).toEqual([
    [4, [0]],
    [5, [0]],
  ])
})

it('reports the highest severity in the batch', () => {
  const { batcher, batches } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_A, 1, { severityNumber: SeverityNumber.ERROR }))
  batcher.push(item(SESSION_A, 2, { severityNumber: SeverityNumber.WARN }))
  batcher.flushSession(SESSION_A)
  expect(batches[0]!.severityNumber).toBe(SeverityNumber.ERROR)
})

it('flushes every buffered session on shutdown and rejects later events', () => {
  const { batcher, batches } = harness()
  batcher.push(item(SESSION_A, 0))
  batcher.push(item(SESSION_B, 0))
  batcher.shutdown()
  expect(batches.map(batch => String(batch.sessionId)).sort()).toEqual([String(SESSION_A), String(SESSION_B)])
  batcher.push(item(SESSION_A, 1))
  expect(batches).toHaveLength(2)
})

it('contains a reporting failure instead of escaping the collector path', () => {
  const warnings: string[] = []
  const batcher = new SessionLogBatcher(
    {
      maxBatchEvents: 1,
      maxBatchBytes: 10_000,
      batchDelayMillis: 60_000,
    },
    () => { throw new Error('transport exploded') },
    message => warnings.push(message),
  )
  expect(() => { batcher.push(item(SESSION_A, 0)) }).not.toThrow()
  expect(warnings).toEqual(['session telemetry batch report failed: Error: transport exploded'])
})
