/**
 * One Peer per share and reader: the reader's calls and streams speak for it, and revocation, a re-check
 * that refuses the reader, and the share's end dispose it. Disposal settles asynchronously, so the Peer's
 * signal is awaited; the reader table forgets the Peer at once, so the next admitted request gets a new one.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createViewerReadService, type ViewerReadGateway } from '../src/host/viewer-read.ts'
import { READER, readerConnection, type ReaderFetch } from './viewer-read-peers.ts'

const OTHER = { ...READER, subjectId: 'ou_other' }

const listCall = (rpcId: string) => ({ op: 'call' as const, path: '/api/session/list', body: {
  type: 'client-request', rpcId, method: 'session/list', payload: { args: { request: {} } },
} })
const followOpen = (id: number) => ({ op: 'stream-open' as const, id, endpoint: 'session/follow', payload: {
  args: { request: { address: { kind: 'session', sessionId: 'source' } } },
} })

/** A gateway whose streams yield until their signal or their Peer ends. */
function streamingGateway(): { readonly gateway: ViewerReadGateway; readonly opened: PeerScope[] } {
  const opened: PeerScope[] = []
  const gateway: ViewerReadGateway = {
    wireStream: {
      open: (_endpoint, _payload, _uplink, peer, signal) => {
        opened.push(peer)
        return Promise.resolve((async function* () {
          while (!signal.aborted && !peer.signal.aborted) {
            await new Promise((resolve) => { setTimeout(resolve, 5) })
            yield { type: 'event' }
          }
        })())
      },
      failure: error => ({ code: String(error), message: String(error), details: {} }),
    },
  }
  return { gateway, opened }
}

function reader(fetch?: ReaderFetch, admitted: (subjectId: string) => boolean = () => true) {
  const peers = readerConnection(fetch ?? ((_request, peer) => Promise.resolve(Response.json({
    type: 'server-response', rpcId: 'r', result: { ok: true, value: { items: [], principal: peer.principal } },
  }))))
  onTestFinished(() => peers.dispose())
  const { gateway, opened } = streamingGateway()
  const read = createViewerReadService({
    connection: peers.connection,
    gateway,
    sharedSessionId: () => 'source',
    viewerStillAdmitted: (_shareId, actor) => admitted(actor.subjectId),
  })
  onTestFinished(() => { read.close() })
  return { read, peers, opened }
}

describe('reader Peers', () => {
  it('dispatches every call and stream of one reader through one share-viewer Peer', async () => {
    const { read, peers, opened } = reader()
    expect(await read.answer('share', listCall('a'), READER)).toMatchObject({ status: 200 })
    expect(await read.answer('share', followOpen(1), READER)).toEqual({ status: 200, body: { opened: true } })
    expect(await read.answer('share', listCall('b'), OTHER)).toMatchObject({ status: 200 })
    expect(peers.peers).toHaveLength(2)
    expect(peers.principalOf(0)).toEqual({ kind: 'share-viewer', shareId: 'share', actor: READER })
    expect(peers.principalOf(1)).toEqual({ kind: 'share-viewer', shareId: 'share', actor: OTHER })
    expect(opened).toEqual([peers.peers[0]])
  })

  it('keeps one share’s reader apart from the same reader of another share', async () => {
    const { read, peers } = reader()
    await read.answer('share', listCall('a'), READER)
    await read.answer('other-share', listCall('b'), READER)
    expect(peers.peers.map(peer => peer.principal)).toEqual([
      { kind: 'share-viewer', shareId: 'share', actor: READER },
      { kind: 'share-viewer', shareId: 'other-share', actor: READER },
    ])
  })

  it('disposes only the revoked reader’s Peer and ends that reader’s streams', async () => {
    const { read, peers } = reader()
    await read.answer('share', followOpen(1), READER)
    await read.answer('share', followOpen(2), OTHER)
    expect(read.closeViewerStreams('share', READER)).toBe(1)
    await vi.waitFor(() => { expect(peers.peers[0]?.signal.aborted).toBe(true) })
    expect(peers.peers[1]?.signal.aborted).toBe(false)
    expect(await read.answer('share', { op: 'stream-next', id: 1 }, READER))
      .toEqual({ status: 404, body: { error: 'stream-not-found' } })
    expect(await read.answer('share', { op: 'stream-next', id: 2 }, OTHER)).toMatchObject({ status: 200 })
  })

  it('disposes every Peer of an ended share and gives a re-admitted reader a new one', async () => {
    const { read, peers } = reader()
    await read.answer('share', listCall('a'), READER)
    await read.answer('share', listCall('b'), OTHER)
    read.closeShare('share')
    await vi.waitFor(() => { expect(peers.peers.map(peer => peer.signal.aborted)).toEqual([true, true]) })
    await read.answer('share', listCall('c'), READER)
    expect(peers.peers).toHaveLength(3)
    expect(peers.peers[2]?.signal.aborted).toBe(false)
    expect(peers.principalOf(2)).toEqual({ kind: 'share-viewer', shareId: 'share', actor: READER })
  })

  it('disposes the Peers of readers that lost admission when the share is re-checked', async () => {
    let revoked = ''
    const { read, peers } = reader(undefined, subjectId => subjectId !== revoked)
    await read.answer('share', listCall('a'), READER)
    await read.answer('share', listCall('b'), OTHER)
    revoked = OTHER.subjectId
    read.recheckAdmission('share')
    await vi.waitFor(() => { expect(peers.peers.map(peer => peer.signal.aborted)).toEqual([false, true]) })
  })

  it('aborts a revoked reader’s call in flight and disposes the Peer it spoke for', async () => {
    let admitted = true
    const entered = Promise.withResolvers<PeerScope>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const { read, peers } = reader(async (request, peer) => {
      entered.resolve(peer)
      await release.promise
      request.signal.throwIfAborted()
      return Response.json({})
    }, () => admitted)
    const answer = read.answer('share', listCall('late'), READER)
    const rejected = expect(answer).rejects.toThrow('Viewer access ended')
    const peer = await entered.promise
    admitted = false
    read.closeViewerStreams('share', READER)
    await vi.waitFor(() => { expect(peer.signal.aborted).toBe(true) })
    release.resolve(undefined)
    await rejected
    // The reader is admitted again later: its next call speaks for a new Peer.
    admitted = true
    await read.answer('share', listCall('again'), READER)
    expect(peers.peers).toHaveLength(2)
    expect(peers.peers[1]?.signal.aborted).toBe(false)
  })
})
