/**
 * What the owner's read path refuses before it reads anything.
 *
 * A deadline that passed, a share the owner stopped, and a grant that ended all outlive the request
 * that was admitted under them, so every read through a share — its calls, its stream opens, and each
 * poll of a stream already open — re-reads the same verdicts the write path applies. Each refusal is a
 * stable code the served page classifies as terminal instead of reconnecting around it.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createViewerReadService, type ViewerReadDeps } from '../src/host/viewer-read.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import { READER as viewer, readerConnection, type ReaderConnection } from './viewer-read-peers.ts'

const otherViewer = { ...viewer, subjectId: 'ou_other' }

/** One share this host publishes, still serving unless a case says otherwise. */
function share(extra: Partial<ForkShareState> = {}): ForkShareState {
  return {
    shareId: 'share-1',
    sessionId: 'session-1',
    allowsFork: false,
    viewerAdmitted: true,
    stopped: false,
    ...extra,
  }
}

/** One owner dispatch that records what reached it, so a refusal is visible as a read never taken. */
function connection(reads: string[]): ReaderConnection {
  return readerConnection(async (request) => {
    reads.push(new URL(request.url).pathname)
    return new Response(JSON.stringify({ result: { ok: true, value: { items: [] } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

/** One gateway yielding forever, with the cancellation signal of each opened stream recorded. */
function gateway(signals: AbortSignal[]): NonNullable<ViewerReadDeps['gateway']> {
  return {
    wireStream: {
      async open(_endpoint, _payload, _uplink, _peer, signal): Promise<AsyncIterable<unknown>> {
        signals.push(signal)
        return (async function* () {
          let seq = 0
          for (;;) {
            await new Promise((resolve) => { setTimeout(resolve, 0) })
            yield { seq: seq++ }
          }
        })()
      },
      failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
        return { code: String(error), message: String(error), details: {} }
      },
    },
  }
}

function service(options: {
  readonly state?: () => ForkShareState | undefined
  readonly admitted?: (shareId: string, actor: typeof viewer) => boolean
} = {}) {
  const reads: string[] = []
  const signals: AbortSignal[] = []
  const readers = connection(reads)
  const read = createViewerReadService({
    connection: readers.connection,
    gateway: gateway(signals),
    sharedSessionId: () => 'session-1',
    forkStateOf: options.state ?? (() => share()),
    ...(options.admitted === undefined ? {} : { viewerStillAdmitted: options.admitted }),
  })
  onTestFinished(() => readers.dispose())
  return { read, reads, signals, readers }
}

const listCall = { op: 'call', path: '/api/session/list', body: {} } as const
const followOpen = { op: 'stream-open', id: 1, endpoint: 'session/follow',
  payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } } } as const

/** One viewer call as the Connection sends it: a Typert envelope naming the Session it addresses. */
const promptEnvelope = (method: string, rpcId: string, sessionId: string) => ({
  op: 'call' as const,
  path: `/api/${method}`,
  body: {
    type: 'client-request',
    rpcId,
    method,
    payload: { args: { request: { requestId: `${rpcId}-request`, sessionId, mode: 'queue', content: [] } } },
  },
})

describe('the share state one viewer read is decided against', () => {
  it('[P0] refuses a read of a share whose deadline passed, before the owner reads anything', async () => {
    const { read, reads } = service({ state: () => share({ expiresAt: '2026-09-01T00:00:00.000Z' }) })

    expect(await read.answer('share-1', listCall, viewer))
      .toMatchObject({ status: 403, body: { error: 'share-expired' } })
    // The refusal happened here, so the owner's own endpoint registry was never reached.
    expect(reads).toEqual([])
    // A stream is refused before its opener runs, so no upstream subscription is created either.
    expect(await read.answer('share-1', followOpen, viewer))
      .toMatchObject({ status: 403, body: { error: 'share-expired' } })
    read.close()
  })

  it('refuses every read of a share the owner stopped', async () => {
    const { read } = service({ state: () => share({ stopped: true }) })

    expect(await read.answer('share-1', listCall, viewer))
      .toMatchObject({ status: 403, body: { error: 'share-stopped' } })
    expect(await read.answer('share-1', followOpen, viewer))
      .toMatchObject({ status: 403, body: { error: 'share-stopped' } })
    read.close()
  })

  it('[P0] refuses a read whose viewer no longer holds access, and leaves an admitted one reading', async () => {
    // The grant is per viewer, exactly as the owner's ACL holds it, so one revocation is not another's.
    const revoked = new Set<string>()
    const { read, reads } = service({ admitted: (_shareId, actor) => !revoked.has(actor.subjectId) })

    expect((await read.answer('share-1', listCall, viewer)).status).toBe(200)
    expect(reads).toEqual(['/api/session/list'])

    revoked.add(viewer.subjectId)
    expect(await read.answer('share-1', listCall, viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    expect(await read.answer('share-1', followOpen, viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    // The verdict is about the viewer, not the share: nobody else's read is affected.
    expect((await read.answer('share-1', listCall, otherViewer)).status).toBe(200)
    read.close()
  })

  it('[P0] refuses a revoked viewer’s fork and child prompt, not just its reads', async () => {
    // The write paths execute on the owner's machine, so one share state must decide them too: a viewer
    // whose grant ended cannot still create a child or drive the one it made earlier.
    const revoked = new Set<string>()
    const { read } = service({
      state: () => share({ allowsFork: true }),
      admitted: (_shareId, actor) => !revoked.has(actor.subjectId),
    })
    const forkCall = promptEnvelope('session/fork', 'rpc-fork', 'session-1')
    const promptCall = promptEnvelope('session/prompt', 'rpc-prompt', 'child-1')

    revoked.add(viewer.subjectId)
    expect(await read.answer('share-1', forkCall, viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    expect(await read.answer('share-1', promptCall, viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    // The verdict is about the viewer: this share's own state still serves the other one.
    const other = await read.answer('share-1', forkCall, otherViewer)
    expect(other.body).not.toMatchObject({ error: 'viewer-not-authorized' })
    read.close()
  })

  it('refuses a fork and a child prompt on a share whose deadline passed', async () => {
    const { read, reads } = service({ state: () => share({ allowsFork: true, expiresAt: '2026-09-01T00:00:00.000Z' }) })

    expect(await read.answer('share-1', promptEnvelope('session/fork', 'rpc-fork', 'session-1'), viewer))
      .toMatchObject({ status: 403, body: { error: 'share-expired' } })
    expect(await read.answer('share-1', promptEnvelope('session/prompt', 'rpc-prompt', 'child-1'), viewer))
      .toMatchObject({ status: 403, body: { error: 'share-expired' } })
    // Neither write reached the owner's endpoint registry.
    expect(reads).toEqual([])
    read.close()
  })

  it('[P0] refuses the next poll of a stream whose viewer no longer holds access, and releases it', async () => {
    let admitted = true
    const { read, signals } = service({ admitted: () => admitted })
    expect((await read.answer('share-1', followOpen, viewer)).status).toBe(200)

    admitted = false
    expect(await read.answer('share-1', { op: 'stream-next', id: 1 }, viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    // The stream went with the refusal, upstream subscription included, so a page that re-opens instead
    // of giving up reads the same verdict from the open rather than a fresh grant.
    expect(signals[0]?.aborted).toBe(true)
    expect(await read.answer('share-1', { op: 'stream-next', id: 1 }, viewer))
      .toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
    expect(await read.answer('share-1', followOpen, viewer))
      .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    read.close()
  })

  it('[P0] releases only the revoked viewer’s own streams', async () => {
    const { read, signals, readers } = service()
    expect((await read.answer('share-1', { ...followOpen, id: 1 }, viewer)).status).toBe(200)
    expect((await read.answer('share-1', { ...followOpen, id: 2 }, otherViewer)).status).toBe(200)

    expect(read.closeViewerStreams('share-1', viewer)).toBe(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    // The revoked viewer's Peer ends with its streams; the other viewer's Peer keeps serving it.
    expect(readers.principalOf(0).actor).toEqual(viewer)
    await vi.waitFor(() => { expect(readers.peers[0]?.signal.aborted).toBe(true) })
    expect(readers.peers[1]?.signal.aborted).toBe(false)
    // The viewer that kept its grant keeps reading, and the released id reports the loss it is.
    expect((await read.answer('share-1', { op: 'stream-next', id: 2 }, otherViewer)).status).toBe(200)
    expect(await read.answer('share-1', { op: 'stream-next', id: 1 }, viewer))
      .toMatchObject({ status: 404, body: { error: 'stream-not-found' } })
    read.close()
  })

  it('serves a live share to an admitted viewer exactly as before', async () => {
    const { read, reads } = service({ admitted: () => true })

    expect((await read.answer('share-1', listCall, viewer)).status).toBe(200)
    expect((await read.answer('share-1', followOpen, viewer)).status).toBe(200)
    expect(reads).toEqual(['/api/session/list'])
    read.close()
  })
})

/** One viewer fork call as the Connection sends it: a Typert envelope naming the Session it forks. */
const forkEnvelope = (path: string, options: {
  readonly rpcId?: string
  readonly childSessionId?: string
} = {}) => ({
  op: 'call' as const,
  path,
  body: {
    type: 'client-request',
    ...(options.rpcId === undefined ? {} : { rpcId: options.rpcId }),
    method: 'session/fork',
    payload: {
      args: {
        request: {
          requestId: 'fork-request',
          sessionId: 'session-1',
          ...(options.childSessionId === undefined ? {} : { childSessionId: options.childSessionId }),
        },
      },
    },
  },
})

describe('the fork request one viewer call is classified as', () => {
  it('[P0] refuses a fork body naming a child when the request carries no bound identity', async () => {
    const { read, reads } = service({ state: () => share({ allowsFork: true }) })

    const answer = await read.answer(
      'share-1',
      forkEnvelope('/api/session/fork', { childSessionId: 'another-requests-child' }),
      viewer,
    )

    // Without an rpcId or operationId the host cannot prove the retry created that child, so the body must
    // not reach the owner's adoption path.
    expect(answer).toMatchObject({
      status: 403,
      body: { error: 'fork-identity-required', message: 'naming a fork child requires an rpcId or operationId' },
    })
    expect(reads).toEqual([])
    read.close()
  })

  it('[P0] classifies a dot-segment fork path and a query suffix as the fork request they are', async () => {
    const { read, reads } = service({ state: () => share({ allowsFork: true }) })

    for (const path of ['/api/session/./fork', '/api/session/fork?x=1']) {
      // Only the fork decision answers with this code; reaching dispatch() would return the owner's answer
      // and create the child without recording or confining it.
      expect(await read.answer('share-1', forkEnvelope(path, { childSessionId: 'another-requests-child' }), viewer))
        .toMatchObject({ status: 403, body: { error: 'fork-identity-required' } })
    }
    expect(reads).toEqual([])
    read.close()
  })

  it('[P0] forwards a normalized fork path to the owner for a request that carries its own identity', async () => {
    const { read, reads } = service({ state: () => share({ allowsFork: true }) })

    const answer = await read.answer('share-1', forkEnvelope('/api/session/./fork?x=1', { rpcId: 'rpc-fork' }), viewer)

    expect(answer.status).toBe(200)
    // The owner's endpoint saw the normalized path, and the fork decision is what forwarded it.
    expect(reads).toEqual(['/api/session/fork'])
    read.close()
  })
})
