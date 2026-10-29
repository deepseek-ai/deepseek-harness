/**
 * Stream delivery granularity on the owner side: one answer carries the values a burst already
 * queued, in order and with nothing lost, instead of spending one round trip per value.
 */

import { describe, expect, it } from 'vitest'
import { STREAM_BATCH_MAX } from '../src/read-budgets.ts'
import { createViewerReadService, type ViewerReadDeps } from '../src/host/viewer-read.ts'
import { READER, readerConnection } from './viewer-read-peers.ts'

/** Values one burst delivers, matching the delta count a two-second answer was measured to emit. */
const BURST = 253

/** A gateway whose one stream has `count` values queued the moment it is opened. */
function burstGateway(count: number): NonNullable<ViewerReadDeps['gateway']> {
  return {
    wireStream: {
      async open(): Promise<AsyncIterable<unknown>> {
        return (async function* () {
          for (let seq = 0; seq < count; seq++) yield { seq }
        })()
      },
      failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
        return { code: String(error), message: String(error), details: {} }
      },
    },
  }
}

describe('Liveshare viewer stream batching', () => {
  it('[P0] answers a queued burst in bounded batches, in order and without losing a value', async () => {
    const read = createViewerReadService({
      connection: readerConnection().connection, gateway: burstGateway(BURST), sharedSessionId: () => 'session-1',
    })
    expect((await read.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)).status).toBe(200)

    const seen: number[] = []
    const batchSizes: number[] = []
    let answers = 0
    for (;;) {
      const answer = await read.answer('share-1', { op: 'stream-next', id: 1 }, READER)
      const body = answer.body as { values?: readonly { seq: number }[]; end?: true; pending?: true }
      if (body.end === true) break
      if (body.pending === true) continue
      const values = body.values ?? []
      answers += 1
      batchSizes.push(values.length)
      for (const value of values) seen.push(value.seq)
    }
    read.close()

    // Every value arrived exactly once, in the order the stream produced it.
    expect(seen).toEqual(Array.from({ length: BURST }, (_unused, seq) => seq))
    // One answer carries several values — that is the whole point — and never more than the bound.
    expect(Math.max(...batchSizes)).toBeGreaterThan(1)
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(STREAM_BATCH_MAX)
    // The burst costs a handful of round trips instead of one per value.
    expect(answers).toBeLessThanOrEqual(Math.ceil(BURST / STREAM_BATCH_MAX) + 1)
  })

  it('[P0] answers a stream that produces one value at a time with that single value', async () => {
    const gateway = {
      wireStream: {
        async open(): Promise<AsyncIterable<unknown>> {
          return (async function* () {
            yield { seq: 0 }
            await new Promise((resolve) => { setTimeout(resolve, 50) })
            yield { seq: 1 }
          })()
        },
        failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
          return { code: String(error), message: String(error), details: {} }
        },
      },
    }
    const read = createViewerReadService({ connection: readerConnection().connection, gateway, sharedSessionId: () => 'session-1' })
    expect((await read.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)).status).toBe(200)

    // The first value answers alone: nothing is queued behind it, so no value waits on the batch
    // window, and the second value is read by the poll after it.
    const first = await read.answer('share-1', { op: 'stream-next', id: 1 }, READER) as { body: { values?: readonly unknown[] } }
    expect(first.body.values).toEqual([{ seq: 0 }])
    const second = await read.answer('share-1', { op: 'stream-next', id: 1 }, READER) as { body: { values?: readonly unknown[] } }
    expect(second.body.values).toEqual([{ seq: 1 }])
    read.close()
  })
})
