/**
 * Stream ownership on the owner side: one page's stream ids are its own numbering, so two pages
 * that number their streams the same way used to cancel each other. Distinct ids must stay
 * independent, and a replacement on one id must be visible rather than silent.
 */

import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { createViewerReadService, type ViewerReadGateway } from '../src/host/viewer-read.ts'
import { READER, readerConnection, type ReaderConnection } from './viewer-read-peers.ts'

/** One gateway that opens streams with the real five-argument signature and records each call. */
function recordingGateway() {
  const aborted: string[] = []
  const opened: Array<{
    readonly endpoint: string
    readonly payload: unknown
    readonly uplink: AsyncIterable<unknown>
    readonly peer: PeerScope
    readonly signal: AbortSignal
  }> = []
  const gateway: ViewerReadGateway = {
    wireStream: {
      async open(endpoint, payload, uplink, peer, signal): Promise<AsyncIterable<unknown>> {
        opened.push({ endpoint, payload, uplink, peer, signal })
        signal.addEventListener('abort', () => { aborted.push(endpoint) }, { once: true })
        return (async function* () {
          let seq = 0
          while (!signal.aborted) {
            await new Promise((resolve) => { setTimeout(resolve, 0) })
            seq += 1
            yield { endpoint, seq }
          }
        })()
      },
      failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
        return { code: String(error), message: String(error), details: {} }
      },
    },
  }
  return { aborted, opened, gateway }
}

function service(gateway: ViewerReadGateway, readers: ReaderConnection = readerConnection()) {
  return createViewerReadService({ connection: readers.connection, gateway, sharedSessionId: () => 'session-1' })
}

/** One gateway whose stream rejects on its first poll, as a broken owner-side read does. */
function failingGatewayFixture() {
  const gateway: ViewerReadGateway = {
    wireStream: {
      open(): Promise<AsyncIterable<unknown>> {
        return Promise.resolve((async function* () {
          yield await Promise.reject(new Error('signal timed out'))
        })())
      },
      failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
        const code = error instanceof Error ? error.message : 'unknown'
        return { code, message: code, details: {} }
      },
    },
  }
  return { gateway }
}

describe('Liveshare viewer stream ownership', () => {
  it('[P0] keeps two pages\u2019 streams independent when their ids differ', async () => {
    const { aborted, gateway } = recordingGateway()
    const read = service(gateway)

    // Page one opens stream 1 and reads from it.
    expect((await read.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)).status).toBe(200)
    expect(await read.answer('share-1', { op: 'stream-next', id: 1 }, READER)).toMatchObject({ status: 200 })

    // Page two opens stream 2: page one's stream must survive and keep answering.
    expect((await read.answer('share-1', { op: 'stream-open', id: 2, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)).status).toBe(200)
    expect(await read.answer('share-1', { op: 'stream-next', id: 1 }, READER)).toMatchObject({ status: 200 })
    expect(await read.answer('share-1', { op: 'stream-next', id: 2 }, READER)).toMatchObject({ status: 200 })
    expect(aborted).toEqual([])
    read.close()
  })

  it('[P1] reports a live stream replaced by the same id instead of dropping it silently', async () => {
    const { gateway } = recordingGateway()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const read = service(gateway)

    await read.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)
    await read.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)

    // The line names the share, stream id, endpoint, and whether the replaced stream had a poll in
    // flight, so a replacement is diagnosable without reading any payload.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'viewer stream replaced share=share-1 streamId=1 endpoint=session/follow hadPending=false',
    ))
    warn.mockRestore()
    read.close()
  })

  it('[P1] names a broken stream and reports its id as gone so the page can re-open', async () => {
    const { gateway } = failingGatewayFixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const read = service(gateway)

    await read.answer('share-1', { op: 'stream-open', id: 7, endpoint: 'session/control', payload: {} }, READER)
    const failed = await read.answer('share-1', { op: 'stream-next', id: 7 }, READER)
    // The viewer's Remote failure keeps its own body; the log carries the cause and the id.
    expect(failed).toMatchObject({ status: 200, body: { failure: { code: 'signal timed out' } } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'viewer stream failed share=share-1 streamId=7',
    ))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signal timed out'))

    // A released stream answers the carrier code, which is what tells the page to re-open rather
    // than poll an id that will never produce another value.
    expect(await read.answer('share-1', { op: 'stream-next', id: 7 }, READER))
      .toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
    warn.mockRestore()
    read.close()
  })
})

describe('Liveshare owner viewer stream opener', () => {
  it('[P0] lands the uplink, the reader\u2019s Peer, and the signal in their own arguments', async () => {
    const { opened, gateway } = recordingGateway()
    const readers = readerConnection()
    const read = service(gateway, readers)

    expect((await read.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } }, READER)).status).toBe(200)
    const stream = opened[0]
    // Position three is an iterable the opener may consume, not the cancellation signal a
    // three-argument call would land there; the read-only viewer sends no item.
    expect(typeof stream?.uplink[Symbol.asyncIterator]).toBe('function')
    expect(await stream?.uplink[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
    // Position four is the Peer the reader speaks for, so the Gateway decides the stream as that reader.
    expect(stream?.peer).toBe(readers.peers[0])
    expect(readers.principalOf(0)).toEqual({ kind: 'share-viewer', shareId: 'share-1', actor: READER })
    // Position five is the owner's own controller signal, so cancellation still reaches the opener.
    expect(stream?.signal).toBeInstanceOf(AbortSignal)
    expect(stream?.signal.aborted).toBe(false)

    const answer = await read.answer('share-1', { op: 'stream-next', id: 1 }, READER)
    const values = (answer.body as { values?: readonly { endpoint: string; seq: number }[] }).values ?? []
    expect(values[0]).toEqual({ endpoint: 'session/follow', seq: 1 })

    read.close()
    expect(stream?.signal.aborted).toBe(true)
    // Closing the reader also ends the Peer, so nothing the Gateway still holds for it keeps running.
    await vi.waitFor(() => { expect(stream?.peer.signal.aborted).toBe(true) })
  })

  it('[P1] opens one reader\u2019s streams on one Peer and another reader\u2019s on its own', async () => {
    const { opened, gateway } = recordingGateway()
    const readers = readerConnection()
    const read = service(gateway, readers)
    const other = { ...READER, tenantId: 'tenant-b' }
    const follow = (id: number) => ({ op: 'stream-open' as const, id, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } })

    expect((await read.answer('share-1', follow(1), READER)).status).toBe(200)
    expect((await read.answer('share-1', follow(2), READER)).status).toBe(200)
    // The same subject in another tenant is another reader.
    expect((await read.answer('share-1', follow(3), other)).status).toBe(200)

    expect(opened.map(stream => stream.peer)).toEqual([readers.peers[0], readers.peers[0], readers.peers[1]])
    expect(readers.principalOf(1)).toEqual({ kind: 'share-viewer', shareId: 'share-1', actor: other })
    read.close()
  })
})
