/** A requests refresh reports its own authorization refusal while cancelling older revoked work. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createViewerReadService, type ViewerReadDeps } from '../src/host/viewer-read.ts'
import { readerConnection } from './viewer-read-peers.ts'

const alice = { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' }
const bob = { ...alice, providerId: 'other' }
const listCall = { op: 'call', path: '/api/session/list', body: {} } as const

function harness(mode: 'view' | 'write' = 'view') {
  const allowed = new Set([identityKeyOf(alice), identityKeyOf(bob)])
  const requests: Request[] = []
  const streams: AbortSignal[] = []
  const pending: Promise<unknown>[] = []
  const fetchEntered = Promise.withResolvers<undefined>()
  const fetchReleased = Promise.withResolvers<undefined>()
  let refresh: NonNullable<ViewerReadDeps['refreshAdmission']> = async () => {}
  let holdFetch = false
  const peers: PeerScope[] = []
  const readers = readerConnection(async (request, peer) => {
    requests.push(request)
    peers.push(peer)
    if (holdFetch) {
      if (requests.length === 2) fetchEntered.resolve(undefined)
      await fetchReleased.promise
    }
    request.signal.throwIfAborted()
    return Response.json({ result: { ok: true, value: { items: [] } } })
  })
  const read = createViewerReadService({
    sharedSessionId: () => 'source',
    sourceConfined: () => true,
    forkStateOf: () => ({ shareId: 'share', sessionId: 'source', sessionMode: mode,
      allowsFork: mode === 'write', viewerAdmitted: true, stopped: false }),
    viewerStillAdmitted: (_shareId, actor) => allowed.has(identityKeyOf(actor)),
    refreshAdmission: (shareId, signal) => refresh(shareId, signal),
    connection: readers.connection,
    gateway: { wireStream: {
      open: async (_endpoint, _payload, _uplink, _peer, signal) => {
        streams.push(signal)
        return (async function* () { yield { ready: true } })()
      },
      failure: () => ({ code: 'gateway/internal', message: 'failed', details: {} }),
    } },
  })
  onTestFinished(async () => {
    fetchReleased.resolve(undefined)
    read.close()
    await Promise.allSettled(pending)
    await readers.dispose()
  })
  const track = <T>(promise: Promise<T>): Promise<T> => { pending.push(promise); return promise }
  return {
    read, requests, peers, streams, fetchEntered, fetchReleased, track,
    holdFetch: () => { holdFetch = true },
    refresh: (callback: NonNullable<ViewerReadDeps['refreshAdmission']>) => { refresh = callback },
    revoke: (shareId = 'share') => {
      allowed.delete(identityKeyOf(alice))
      read.recheckAdmission(shareId)
    },
    readmit: () => { allowed.add(identityKeyOf(alice)) },
    revokeOnRefresh: () => {
      refresh = async (shareId, signal) => {
        allowed.delete(identityKeyOf(alice))
        read.recheckAdmission(shareId)
        signal?.throwIfAborted()
      }
    },
  }
}

const unauthorized = { status: 403, body: { error: 'viewer-not-authorized' } }
const open = (id: number) => ({ op: 'stream-open' as const, id, endpoint: 'session/follow',
  payload: { args: { request: { address: { kind: 'session', sessionId: 'source' } } } } })

describe('viewer requests authority refresh', () => {
  it('returns 403 when its first GET discovers unary revocation without aborting the caller', async () => {
    const fixture = harness()
    const caller = new AbortController()
    fixture.revokeOnRefresh()
    await expect(fixture.read.answer('share', listCall, alice, caller.signal)).resolves.toMatchObject(unauthorized)
    expect(caller.signal.aborted).toBe(false)
    expect(fixture.requests).toEqual([])
    await expect(fixture.read.answer('share', listCall, bob)).resolves.toMatchObject({ status: 200 })
  })

  it('returns terminal 403 for a live poll whose first GET releases its revoked stream', async () => {
    const fixture = harness()
    const caller = new AbortController()
    expect((await fixture.read.answer('share', open(1), alice)).status).toBe(200)
    expect((await fixture.read.answer('share', open(2), bob)).status).toBe(200)
    fixture.revokeOnRefresh()
    await expect(fixture.read.answer('share', { op: 'stream-next', id: 1 }, alice, caller.signal))
      .resolves.toMatchObject(unauthorized)
    expect(caller.signal.aborted).toBe(false)
    expect(fixture.streams[0]?.aborted).toBe(true)
    expect(fixture.streams[1]?.aborted).toBe(false)
    await expect(fixture.read.answer('share', { op: 'stream-next', id: 2 }, bob))
      .resolves.toMatchObject({ status: 200, body: { values: [{ ready: true }] } })
  })

  it('still cancels other revoked unary work and streams while retaining the full Bob identity', async () => {
    const fixture = harness()
    expect((await fixture.read.answer('share', open(1), alice)).status).toBe(200)
    expect((await fixture.read.answer('share', open(2), bob)).status).toBe(200)
    fixture.holdFetch()
    const oldAlice = fixture.track(fixture.read.answer('share', listCall, alice))
    const cancelled = oldAlice.then(() => undefined, (error: unknown) => error)
    const oldBob = fixture.track(fixture.read.answer('share', listCall, bob))
    await fixture.fetchEntered.promise
    fixture.revokeOnRefresh()
    await expect(fixture.read.answer('share', listCall, alice)).resolves.toMatchObject(unauthorized)
    expect(fixture.requests[0]?.signal.aborted).toBe(true)
    expect(fixture.requests[1]?.signal.aborted).toBe(false)
    expect(fixture.streams.map(signal => signal.aborted)).toEqual([true, false])
    // The revoked reader's Peer ends with its work; Bob's calls keep speaking for Bob's own Peer.
    await vi.waitFor(() => { expect(fixture.peers[0]?.signal.aborted).toBe(true) })
    expect(fixture.peers[1]?.signal.aborted).toBe(false)
    fixture.fetchReleased.resolve(undefined)
    await expect(cancelled).resolves.toMatchObject({ message: 'Viewer access ended' })
    await expect(oldBob).resolves.toMatchObject({ status: 200 })
  })

  it('speaks for a new Peer once a revoked reader is admitted again', async () => {
    const fixture = harness()
    expect((await fixture.read.answer('share', listCall, alice)).status).toBe(200)
    const revoked = fixture.peers[0]
    fixture.revoke()
    await vi.waitFor(() => { expect(revoked?.signal.aborted).toBe(true) })
    await expect(fixture.read.answer('share', listCall, alice)).resolves.toMatchObject(unauthorized)

    fixture.readmit()
    expect((await fixture.read.answer('share', listCall, alice)).status).toBe(200)
    const admitted = fixture.peers[1]
    expect(admitted).not.toBe(revoked)
    expect(admitted?.principal).toEqual({ kind: 'share-viewer', shareId: 'share', actor: alice })
    expect(admitted?.signal.aborted).toBe(false)
  })

  it('reports revocation discovered by the final write refresh before owner dispatch', async () => {
    const fixture = harness('write')
    let refreshes = 0
    fixture.refresh(async (shareId, signal) => {
      if (++refreshes === 2) fixture.revoke(shareId)
      signal?.throwIfAborted()
    })
    const request = { op: 'call' as const, path: '/api/session/prompt',
      body: { type: 'client-request', rpcId: 'prompt', method: 'session/prompt',
        payload: { args: { request: { requestId: 'prompt', sessionId: 'source', mode: 'queue',
          content: [{ type: 'text', text: 'input' }] } } } } }
    await expect(fixture.read.answer('share', request, alice)).resolves.toMatchObject(unauthorized)
    expect(fixture.requests).toEqual([])
  })

  it('retains missing-stream and unrelated cancellation outcomes instead of inventing revocation', async () => {
    const fixture = harness()
    expect((await fixture.read.answer('share', open(1), alice)).status).toBe(200)
    fixture.refresh(async () => { fixture.read.closeViewerStreams('share', alice) })
    await expect(fixture.read.answer('share', { op: 'stream-next', id: 1 }, alice))
      .resolves.toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
    fixture.revokeOnRefresh()
    await expect(fixture.read.answer('share', { op: 'stream-next', id: 99 }, alice))
      .resolves.toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
  })

  it('keeps a different actor from polling the captured live stream', async () => {
    const fixture = harness()
    expect((await fixture.read.answer('share', open(1), alice)).status).toBe(200)
    fixture.revokeOnRefresh()
    await expect(fixture.read.answer('share', { op: 'stream-next', id: 1 }, bob))
      .resolves.toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
    expect(fixture.streams[0]?.aborted).toBe(true)
  })

  it.each(['close', 'cancel'] as const)('retains %s cancellation while unary admission is refreshing', async (operation) => {
    const fixture = harness()
    fixture.refresh(async () => {
      if (operation === 'close') fixture.read.close()
      else fixture.read.cancelPendingCalls('share')
    })
    await expect(fixture.read.answer('share', listCall, alice)).rejects.toThrow()
    expect(fixture.requests).toEqual([])
  })

  it('propagates authority refresh failure instead of recasting it as a denial', async () => {
    const fixture = harness()
    const failure = new Error('requests snapshot unavailable')
    fixture.refresh(async () => { throw failure })
    await expect(fixture.read.answer('share', listCall, alice)).rejects.toBe(failure)
    expect(fixture.requests).toEqual([])
  })

  it.each(['call', 'stream-next'] as const)('keeps caller cancellation during %s refresh distinct from revocation', async (op) => {
    const fixture = harness()
    if (op === 'stream-next') expect((await fixture.read.answer('share', open(1), alice)).status).toBe(200)
    const caller = new AbortController()
    const reason = new Error('caller went away')
    fixture.refresh(async () => { caller.abort(reason) })
    const request = op === 'call' ? listCall : { op, id: 1 }
    await expect(fixture.read.answer('share', request, alice, caller.signal)).rejects.toBe(reason)
    expect(fixture.requests).toEqual([])
    if (op === 'stream-next') expect(fixture.streams[0]?.aborted).toBe(true)
  })
})
