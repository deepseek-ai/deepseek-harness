/** Shared live batching retains ordered work across backend and queue failures. @module */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LiveWriteBuffer } from '../src/buffer.ts'

const event = (seq: number): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(seq), time: 0, data: { turn: seq + 1 } })
afterEach(() => { vi.useRealTimers() })

it('keeps the first event deadline when later events arrive before the batch limit', async () => {
  vi.useFakeTimers()
  const persist = vi.fn(async (_events: readonly SessionEvent[]) => {})
  const buffer = new LiveWriteBuffer({ delayMs: 10, maxEvents: 8,
    enqueue: async operation => operation(), persist, retry: () => true, canSchedule: () => true,
  })
  buffer.append([event(0)], vi.fn())
  await vi.advanceTimersByTimeAsync(5)
  buffer.append([event(1)], vi.fn())
  await vi.advanceTimersByTimeAsync(5)
  expect(persist).toHaveBeenCalledExactlyOnceWith([event(0), event(1)])
  expect(buffer.length).toBe(0)
})

it('retains an uncommitted batch after a write fails and retries it at the explicit checkpoint', async () => {
  vi.useFakeTimers()
  const failure = new Error('disk full')
  const persist = vi.fn(async (_events: readonly SessionEvent[]) => {}).mockRejectedValueOnce(failure)
  const report = vi.fn()
  const buffer = new LiveWriteBuffer({ delayMs: 10, maxEvents: 2,
    enqueue: async operation => operation(), persist, retry: () => true, canSchedule: () => true,
  })
  buffer.append([event(0)], report)
  await vi.advanceTimersByTimeAsync(10)
  expect(report).toHaveBeenCalledWith(failure)
  expect(buffer.length).toBe(1)
  await buffer.drain()
  expect(persist).toHaveBeenCalledTimes(2)
  expect(buffer.length).toBe(0)
})

it('does not replay a batch whose database commit succeeded before routing publication failed', async () => {
  vi.useFakeTimers()
  const failure = new Error('routing publication failed')
  const persist = vi.fn(async (_events: readonly SessionEvent[]) => { throw failure })
  const report = vi.fn()
  const buffer = new LiveWriteBuffer({ delayMs: 10, maxEvents: 2,
    enqueue: async operation => operation(), persist, retry: () => false, canSchedule: () => true,
  })
  buffer.append([event(0)], report)
  await vi.advanceTimersByTimeAsync(10)
  expect(report).toHaveBeenCalledWith(failure)
  expect(buffer.length).toBe(0)
  await buffer.drain()
  expect(persist).toHaveBeenCalledOnce()
})

it('holds events when automatic scheduling stops and drains them explicitly', async () => {
  vi.useFakeTimers()
  const persist = vi.fn(async (_events: readonly SessionEvent[]) => {})
  const buffer = new LiveWriteBuffer({ delayMs: 10, maxEvents: 2,
    enqueue: async operation => operation(), persist, retry: () => true, canSchedule: () => false,
  })
  buffer.append([event(0)], vi.fn())
  await vi.advanceTimersByTimeAsync(100)
  expect(persist).not.toHaveBeenCalled()
  await buffer.drain()
  expect(persist).toHaveBeenCalledExactlyOnceWith([event(0)])
})

it('pauses automatic writes when serialization rejects before taking a batch, then retries without losing events', async () => {
  vi.useFakeTimers()
  const failure = new Error('queue unavailable')
  const enqueue = vi.fn(async (operation: () => Promise<void>) => operation()).mockRejectedValueOnce(failure)
  const persist = vi.fn(async (_events: readonly SessionEvent[]) => {})
  const report = vi.fn()
  const buffer = new LiveWriteBuffer({ delayMs: 10, maxEvents: 2, enqueue, persist, retry: () => true, canSchedule: () => true })
  buffer.append([event(0)], report)
  await vi.advanceTimersByTimeAsync(10)
  expect(report).toHaveBeenCalledWith(failure)
  buffer.append([event(1), event(2)], report)
  await vi.advanceTimersByTimeAsync(100)
  expect(enqueue).toHaveBeenCalledOnce()
  expect(buffer.length).toBe(3)
  await buffer.drain()
  expect(persist.mock.calls.map(([batch]) => batch.map(item => item.seq))).toEqual([[0, 1], [2]])
  expect(buffer.length).toBe(0)
})

it('joins concurrent drains and keeps events admitted during a commit in the next bounded batch', async () => {
  vi.useFakeTimers()
  const release = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const batches: number[][] = []
  const buffer = new LiveWriteBuffer({ delayMs: 10, maxEvents: 2,
    enqueue: async operation => operation(),
    persist: async (batch) => { batches.push(batch.map(item => item.seq)); entered.resolve(undefined); await release.promise },
    retry: () => true, canSchedule: () => true,
  })
  buffer.append([event(0)], vi.fn())
  const drain = buffer.drain()
  await entered.promise
  expect(buffer.active).toBe(true)
  expect(buffer.drain()).toBe(drain)
  buffer.append([event(1), event(2), event(3)], vi.fn())
  release.resolve(undefined)
  await drain
  expect(batches).toEqual([[0], [1, 2], [3]])
  expect(buffer.active).toBe(false)
  await vi.runAllTimersAsync()
})
