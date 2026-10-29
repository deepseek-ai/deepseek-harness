/**
 * Reclaiming streams no page polls any more.
 *
 * A page that closed, was discarded, or went offline leaves its streams behind: the client's cancel
 * travels the same request/poll channel as its reads and is lost with it, so nothing else tells the
 * owner the reader is gone. Idleness is that signal, and the reader releases the stream together with
 * the upstream subscription the owner's gateway opened for it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VIEWER_STREAM_IDLE_TTL_MS,
  createViewerReadService,
  type ViewerReadDeps,
} from '../src/host/viewer-read.ts'
import { READER as viewer, readerConnection } from './viewer-read-peers.ts'

/**
 * One gateway yielding forever without timers, so a poll resolves on its own value.
 *
 * The sweep is driven by fake timers, and a generator that waited on a timer of its own would make the
 * poll's answer depend on advancing them.
 */
function gateway(signals: AbortSignal[]): NonNullable<ViewerReadDeps['gateway']> {
  return {
    wireStream: {
      async open(_endpoint, _payload, _uplink, _peer, signal): Promise<AsyncIterable<unknown>> {
        signals.push(signal)
        return (async function* () {
          let seq = 0
          for (;;) yield { seq: seq++ }
        })()
      },
      failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
        return { code: String(error), message: String(error), details: {} }
      },
    },
  }
}

/** One open stream and the signal its opener was given, under one reader. */
async function openedStream(id: number) {
  const signals: AbortSignal[] = []
  const read = createViewerReadService({
    connection: readerConnection().connection, gateway: gateway(signals), sharedSessionId: () => 'session-1',
  })
  const opened = await read.answer('share-1', { op: 'stream-open', id, endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, viewer)
  expect(opened.status).toBe(200)
  return { read, signals }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Liveshare viewer stream reclamation', () => {
  it('[P0] releases a stream nothing polls once its idle TTL passes', async () => {
    vi.useFakeTimers()
    const { read, signals } = await openedStream(4)

    // Nothing has polled this stream, but its idle TTL has not passed: the page may still be reading.
    await vi.advanceTimersByTimeAsync(VIEWER_STREAM_IDLE_TTL_MS - 1_000)
    expect(signals[0]?.aborted).toBe(false)

    // Past the TTL the next sweep releases it, and the poll that follows reports the stream it lost.
    await vi.advanceTimersByTimeAsync(VIEWER_STREAM_IDLE_TTL_MS + 60_000)
    expect(signals[0]?.aborted).toBe(true)
    expect(await read.answer('share-1', { op: 'stream-next', id: 4 }, viewer))
      .toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
    read.close()
  })

  it('keeps a stream a page is still polling, however long it stays open', async () => {
    vi.useFakeTimers()
    const { read, signals } = await openedStream(5)

    await vi.advanceTimersByTimeAsync(VIEWER_STREAM_IDLE_TTL_MS - 1_000)
    // The poll is what keeps the stream: its own idle clock starts again from this answer.
    expect((await read.answer('share-1', { op: 'stream-next', id: 5 }, viewer)).status).toBe(200)
    await vi.advanceTimersByTimeAsync(VIEWER_STREAM_IDLE_TTL_MS - 1_000)
    expect(signals[0]?.aborted).toBe(false)
    expect((await read.answer('share-1', { op: 'stream-next', id: 5 }, viewer)).status).toBe(200)
    read.close()
  })

  it('reclaims the streams of one share without touching another share’s', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const read = createViewerReadService({
      connection: readerConnection().connection, gateway: gateway(signals), sharedSessionId: () => 'session-1',
    })
    // Two shares one page reads side by side: the closed page abandons both, and both are reclaimed.
    for (const shareId of ['share-1', 'share-2']) {
      expect((await read.answer(shareId, { op: 'stream-open', id: 6, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, viewer)).status)
        .toBe(200)
    }

    await vi.advanceTimersByTimeAsync(VIEWER_STREAM_IDLE_TTL_MS + 60_000)
    expect(signals.map(signal => signal.aborted)).toEqual([true, true])
    read.close()
  })
})
