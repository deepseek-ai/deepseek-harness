/** Pending Session calls lose their lifetime when the share or opening viewer is revoked. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import { readerConnection } from './viewer-read-peers.ts'

const alice = { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' }
const bob = { ...alice, providerId: 'other' }

/**
 * One write share whose source calls hold at their last pending step until released.
 *
 * A prompt holds inside the owner's dispatch. A source cancel is dispatched the same way, so it holds at
 * the admission refresh that precedes the dispatch.
 */
function harness() {
  const opened = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const committed: string[] = []
  const peers: PeerScope[] = []
  let holdRefresh = false
  const readers = readerConnection(async (request, peer) => {
    peers.push(peer)
    opened.resolve(undefined)
    await release.promise
    request.signal.throwIfAborted()
    committed.push(new URL(request.url).pathname)
    return Response.json({ result: { ok: true, value: { accepted: true } } })
  })
  const read = createViewerReadService({
    sharedSessionId: () => 'source',
    viewerStillAdmitted: () => true,
    forkStateOf: () => ({ shareId: 'share', sessionId: 'source', sessionMode: 'write',
      allowsFork: true, viewerAdmitted: true, stopped: false }),
    connection: readers.connection,
    refreshAdmission: async () => {
      if (!holdRefresh) return
      opened.resolve(undefined)
      await release.promise
    },
  })
  onTestFinished(async () => {
    release.resolve(undefined)
    read.close()
    await readers.dispose()
  })
  const call = (endpoint: 'prompt' | 'cancel', actor = alice) => {
    holdRefresh = endpoint === 'cancel'
    return read.answer('share', {
      op: 'call', path: `/api/session/${endpoint}`,
      body: { type: 'client-request', rpcId: 'rpc', method: `session/${endpoint}`,
        payload: { args: { request: { requestId: 'request', sessionId: 'source', mode: 'queue',
          content: [{ type: 'text', text: 'input' }] } } } },
    }, actor)
  }
  return { read, call, opened, release, committed, peers }
}

describe('viewer call lifetime', () => {
  it.each(['prompt', 'cancel'] as const)('cancels a pending %s when its viewer is revoked', async (endpoint) => {
    const fixture = harness()
    const answer = fixture.call(endpoint)
    const rejected = expect(answer).rejects.toThrow()
    await fixture.opened.promise
    fixture.read.closeViewerStreams('share', alice)
    fixture.release.resolve(undefined)
    await rejected
    expect(fixture.committed).toEqual([])
  })

  it.each(['share', 'host', 'mode'] as const)('cancels a pending prompt when the %s closes', async (scope) => {
    const fixture = harness()
    const rejected = expect(fixture.call('prompt')).rejects.toThrow()
    await fixture.opened.promise
    if (scope === 'share') fixture.read.closeShare('share')
    else if (scope === 'mode') fixture.read.cancelPendingCalls('share')
    else fixture.read.close()
    fixture.release.resolve(undefined)
    await rejected
    expect(fixture.committed).toEqual([])
  })

  it.each(['viewer', 'share'] as const)('ends the revoked reader\u2019s Peer when the %s closes', async (scope) => {
    const fixture = harness()
    const rejected = expect(fixture.call('prompt')).rejects.toThrow()
    await fixture.opened.promise
    const peer = fixture.peers[0]
    expect(peer?.principal).toEqual({ kind: 'share-viewer', shareId: 'share', actor: alice })
    if (scope === 'viewer') fixture.read.closeViewerStreams('share', alice)
    else fixture.read.closeShare('share')
    // The Peer the pending call spoke for ends with the grant, so the Gateway refuses whatever it still carries.
    await vi.waitFor(() => { expect(peer?.signal.aborted).toBe(true) })
    fixture.release.resolve(undefined)
    await rejected
    expect(fixture.committed).toEqual([])
  })

  it('leaves a call from another complete actor identity running', async () => {
    const fixture = harness()
    const answer = fixture.call('prompt', bob)
    await fixture.opened.promise
    fixture.read.closeViewerStreams('share', alice)
    fixture.release.resolve(undefined)
    expect((await answer).status).toBe(200)
    expect(fixture.committed).toEqual(['/api/session/prompt'])
    // Bob's Peer is not Alice's, so ending Alice's left the one Bob's call spoke for live.
    expect(fixture.peers[0]?.principal).toEqual({ kind: 'share-viewer', shareId: 'share', actor: bob })
    expect(fixture.peers[0]?.signal.aborted).toBe(false)
  })
})
