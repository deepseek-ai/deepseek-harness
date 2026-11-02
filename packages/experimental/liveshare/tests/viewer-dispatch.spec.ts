/**
 * Viewer request dispatch: how one forwarded request is classified and answered.
 *
 * The reader suites drive dispatch through the assembled reader. This suite pins the classification
 * helpers and the refusals that depend on state changing around an await.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import {
  createViewerDispatch,
  requestedAddressSession,
  requestedBoundary,
  requestedOperationId,
  requestedRpcId,
  requestedSessionId,
} from '../src/host/viewer-dispatch.ts'
import type { ViewerRequest } from '../src/viewer-channel.ts'

const viewer: ShareRpcActor = { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' }
const other: ShareRpcActor = { providerId: 'mock', tenantId: 'tenant', subjectId: 'bob' }
const refused = { status: 403, body: { error: 'share-stopped' } }
const unavailable = { status: 403, body: { error: 'source-write-unavailable' }, reason: 'source-write-unavailable' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('request classification helpers', () => {
  it('reads an explicit operation id before the rpc id', () => {
    expect(requestedOperationId({ payload: { args: { request: { operationId: 'op-1' } } } })).toBe('op-1')
    expect(requestedOperationId({ rpcId: 'rpc-1' })).toBe('rpc:rpc-1')
    expect(requestedOperationId({ rpcId: '' })).toBeUndefined()
    expect(requestedOperationId('not an envelope')).toBeUndefined()
  })

  it('reads a correlation id only from a non-empty string', () => {
    expect(requestedRpcId({ rpcId: 'rpc-1' })).toBe('rpc-1')
    expect(requestedRpcId({ rpcId: '' })).toBeUndefined()
    expect(requestedRpcId('not an envelope')).toBeUndefined()
  })

  it('reads a committed boundary only from a safe integer', () => {
    expect(requestedBoundary({ payload: { args: { request: { atSeq: 12 } } } })).toBe(12)
    expect(requestedBoundary({ payload: { args: { request: { atSeq: 1.5 } } } })).toBeUndefined()
    expect(requestedBoundary('not an envelope')).toBeUndefined()
  })

  it('reads the Session one request names', () => {
    expect(requestedSessionId({ payload: { args: { request: { sessionId: 'session-1' } } } })).toBe('session-1')
    expect(requestedSessionId({ payload: { args: { request: { sessionId: '' } } } })).toBeUndefined()
    expect(requestedSessionId({})).toBeUndefined()
  })

  it('reads an ordinary-session address only when the page addresses a Session', () => {
    expect(requestedAddressSession({ address: { kind: 'session', sessionId: 'session-1' } })).toBe('session-1')
    expect(requestedAddressSession({ address: { kind: 'other', sessionId: 'session-1' } })).toBeUndefined()
    expect(requestedAddressSession({ address: { kind: 'session', sessionId: '' } })).toBeUndefined()
    expect(requestedAddressSession('not an envelope')).toBeUndefined()
  })
})

type Mock = ReturnType<typeof vi.fn>

interface DepsStub {
  connection?: { createSharedFetchHandler: Mock }
  gateway?: { wireStream: { open: Mock; failure: Mock } }
  sharedSessionId: Mock
  forks?: { allowsPrompt: Mock }
  prepareSource?: Mock
  prepareSourceForReader?: Mock
  prepareChild?: Mock
  sourceRefusal?: Mock
  sourceConfined?: Mock
  debug?: boolean
  readAsset?: Mock
}

interface Harness {
  readonly dispatch: ReturnType<typeof createViewerDispatch>
  readonly deps: DepsStub
  readonly lifecycle: Record<string, Mock>
  readonly fork: Record<string, Mock>
  readonly gateway: {
    open: Mock
    failure: Mock
  }
  readonly handler: { fetch: Mock }
  readonly streams: Map<string, Record<string, unknown>>
  readonly openings: Map<string, Record<string, unknown>>
}

function harness(): Harness {
  const streams = new Map<string, Record<string, unknown>>()
  const openings = new Map<string, Record<string, unknown>>()
  const handler = {
    fetch: vi.fn(async () => new Response(JSON.stringify({ result: { ok: true, value: { ok: true } } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })),
  }
  const gateway = {
    open: vi.fn(async (): Promise<unknown> => (async function* () {})()),
    failure: vi.fn((error: unknown) => ({ code: String(error), message: String(error), details: {} })),
  }
  const deps = {
    connection: { createSharedFetchHandler: vi.fn(() => handler) },
    gateway: { wireStream: { open: gateway.open, failure: gateway.failure } },
    sharedSessionId: vi.fn(() => 'session-1'),
    forks: { allowsPrompt: vi.fn(() => ({ ok: true as const })) },
    prepareSource: vi.fn(async () => {}),
    prepareSourceForReader: vi.fn(),
    prepareChild: vi.fn(async () => {}),
    sourceRefusal: vi.fn(() => undefined),
    sourceConfined: vi.fn(() => true),
    debug: false,
    readAsset: vi.fn(async () => ({
      status: 200, body: { contentType: 'text/html', base64: Buffer.from('<html>\n<link rel="manifest" href="/m">\n</html>').toString('base64') },
    })),
  }
  const lifecycle = {
    peerFor: vi.fn(() => ({ scope: 'peer' })),
    shareRefusal: vi.fn(() => undefined),
    accessRefusal: vi.fn(() => undefined),
    trustedState: vi.fn(() => undefined),
    refreshAdmission: vi.fn(async () => {}),
    beginCall: vi.fn(() => ({ call: true })),
    endCall: vi.fn(),
    streamOf: vi.fn((shareId: string, id: number) => streams.get(`${shareId}:${id}`)),
    openingOf: vi.fn((shareId: string, id: number) => openings.get(`${shareId}:${id}`)),
    reserveOpening: vi.fn((shareId: string, id: number, reservation: Record<string, unknown>) => { openings.set(`${shareId}:${id}`, reservation) }),
    releaseOpening: vi.fn((shareId: string, id: number, reservation: Record<string, unknown>) => {
      if (openings.get(`${shareId}:${id}`) !== reservation) return false
      openings.delete(`${shareId}:${id}`)
      return true
    }),
    registerStream: vi.fn((stream: Record<string, unknown>) => { streams.set(`${String(stream.shareId)}:${String(stream.id)}`, stream) }),
    release: vi.fn((shareId: string, id: number) => { streams.delete(`${shareId}:${id}`) }),
    streamIsCurrent: vi.fn(() => true),
  }
  const fork = {
    answerFork: vi.fn(async () => ({ status: 200, body: { fork: true } })),
    prepareColdChild: vi.fn(async () => ({ ok: true as const })),
    annotateSessionList: vi.fn((answer: unknown) => answer),
    lineageFor: vi.fn(() => undefined),
    withLineageAnswer: vi.fn((answer: unknown) => answer),
    withLineageFrames: vi.fn(() => (async function* () {})()),
  }
  const dispatch = createViewerDispatch({
    deps, lifecycle, fork: () => fork,
  } as never)
  return { dispatch, deps, lifecycle, fork, gateway, handler, streams, openings }
}

const call = (path: string, body: unknown = {}): ViewerRequest => ({ op: 'call', path, body })
const envelope = (sessionId: string): unknown => ({ payload: { args: { request: { sessionId } } } })

function stream(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shareId: 'share-1', id, endpoint: 'session/follow', actor: viewer,
    controller: new AbortController(), iterator: (async function* () {})(), pending: undefined, lastPolledAt: 0,
    ...overrides,
  }
}

describe('owner dispatch', () => {
  it('answers an owner call through the shared fetch handler', async () => {
    const h = harness()
    await expect(h.dispatch.dispatchCall('/api/session/list', { a: 1 }, 'share-1', viewer)).resolves.toEqual({
      status: 200, body: { result: { ok: true, value: { ok: true } } },
    })
    const request = h.handler.fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('http://liveshare.internal/api/session/list')
    expect(await request.text()).toBe('{"a":1}')
    expect(h.handler.fetch.mock.calls[0]?.[1]).toEqual({ scope: 'peer' })
  })

  it('answers unavailable when the host has no Connection or Peer', async () => {
    const h = harness()
    h.deps.connection!.createSharedFetchHandler.mockReturnValue(undefined)
    await expect(h.dispatch.dispatchCall('/api/session/list', {}, 'share-1', viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-read-unavailable' } })

    h.deps.connection!.createSharedFetchHandler.mockReturnValue(h.handler)
    h.lifecycle.peerFor!.mockReturnValue(undefined)
    await expect(h.dispatch.dispatchCall('/api/session/list', {}, 'share-1', viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-read-unavailable' } })
  })

  it('reports an answer that is not JSON instead of failing the relay request', async () => {
    const h = harness()
    h.handler.fetch.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(h.dispatch.dispatchCall('/api/session/list', {}, 'share-1', viewer))
      .resolves.toEqual({ status: 200, body: { error: 'invalid-owner-response' } })
  })

  it('forwards the caller signal and refuses a call already aborted', async () => {
    const h = harness()
    const controller = new AbortController()
    await h.dispatch.dispatchCall('/api/session/list', {}, 'share-1', viewer, controller.signal)
    expect((h.handler.fetch.mock.calls[0]?.[0] as Request).signal).toBeDefined()

    controller.abort(new Error('cancelled'))
    await expect(h.dispatch.dispatchCall('/api/session/list', {}, 'share-1', viewer, controller.signal))
      .rejects.toThrow('cancelled')
  })
})

describe('ordinary viewer calls', () => {
  it('dispatches a list call and annotates the reader branches', async () => {
    const h = harness()
    await expect(h.dispatch.answer('share-1', call('/api/session/list'), viewer)).resolves.toMatchObject({ status: 200 })
    expect(h.fork.annotateSessionList).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }), 'share-1', viewer)
  })

  it('answers a share that no longer exists before dispatch', async () => {
    const h = harness()
    h.deps.sharedSessionId.mockReturnValue(undefined)
    await expect(h.dispatch.answer('share-1', call('/api/session/list'), viewer))
      .resolves.toEqual({ status: 404, body: { error: 'share-not-found' } })
    expect(h.handler.fetch).not.toHaveBeenCalled()
  })

  it('refuses before and after the owner dispatch', async () => {
    const h = harness()
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/list'), viewer)).resolves.toEqual(refused)
    expect(h.handler.fetch).not.toHaveBeenCalled()

    h.lifecycle.shareRefusal!.mockReturnValueOnce(undefined).mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/list'), viewer)).resolves.toEqual(refused)
    expect(h.handler.fetch).toHaveBeenCalledTimes(1)
  })

  it('classifies a normalized fork path and forwards it to fork orchestration', async () => {
    const h = harness()
    await expect(h.dispatch.answer('share-1', call('/api/session/./fork?x=1'), viewer))
      .resolves.toEqual({ status: 200, body: { fork: true } })
    expect(h.fork.answerFork).toHaveBeenCalledWith('share-1', '/api/session/fork?x=1', {}, viewer, expect.any(AbortSignal))
  })

  it('dispatches a path the page base cannot resolve and a path outside the api', async () => {
    const h = harness()
    await h.dispatch.answer('share-1', call('http://[::1'), viewer)
    await h.dispatch.answer('share-1', call('/api/session/./list?x=1'), viewer)
    await h.dispatch.answer('share-1', call('session/list'), viewer)
    // One normalized target is both classified and forwarded: a dot segment and its query survive nothing,
    // while a target the base cannot parse is forwarded exactly as received.
    expect((h.handler.fetch.mock.calls[0]?.[0] as Request).url).toBe('http://liveshare.internalhttp//[::1')
    expect((h.handler.fetch.mock.calls[1]?.[0] as Request).url).toBe('http://liveshare.internal/api/session/list?x=1')
    expect((h.handler.fetch.mock.calls[2]?.[0] as Request).url).toBe('http://liveshare.internal/session/list')
    expect(h.handler.fetch).toHaveBeenCalledTimes(3)
  })

  it('adds branch facts to a page that names a Session', async () => {
    const h = harness()
    const lineage = { branch: true }
    h.fork.lineageFor!.mockReturnValue(lineage)
    h.fork.withLineageAnswer!.mockReturnValue({ status: 200, body: { annotated: true } })
    await expect(h.dispatch.answer('share-1', call('/api/session/page', { address: { kind: 'session', sessionId: 'child-1' } }), viewer))
      .resolves.toEqual({ status: 200, body: { annotated: true } })
    expect(h.fork.lineageFor).toHaveBeenCalledWith('share-1', 'child-1', viewer)
    expect(h.fork.withLineageAnswer)
      .toHaveBeenCalledWith(expect.objectContaining({ status: 200 }), lineage)

    h.fork.lineageFor!.mockReturnValue(undefined)
    await h.dispatch.answer('share-1', call('/api/session/page', {}), viewer)
    expect(h.fork.lineageFor).toHaveBeenCalledTimes(1)
  })
})

describe('source Session writes', () => {
  it('refuses a source write when the share is gone or its state refuses', async () => {
    const h = harness()
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toMatchObject({ status: 200 })
    expect(h.deps.prepareSource).not.toHaveBeenCalled()

    // The share is read once to classify the request and again when the source path resolves it.
    h.deps.sharedSessionId.mockReturnValueOnce('session-1').mockReturnValueOnce(undefined)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual({ status: 403, body: { error: 'share-not-found' } })

    h.deps.sharedSessionId.mockReturnValue('session-1')
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual(refused)
  })

  it('returns a policy refusal that is not about the missing layer', async () => {
    const h = harness()
    h.lifecycle.accessRefusal!.mockReturnValue({ status: 403, body: { error: 'not-writable' }, reason: 'not-writable' })
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toMatchObject({ body: { error: 'not-writable' } })
    expect(h.deps.prepareSource).not.toHaveBeenCalled()
  })

  it('prepares a cold source Session and dispatches once the layer is installed', async () => {
    const h = harness()
    h.lifecycle.accessRefusal!
      .mockReturnValueOnce(unavailable)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toMatchObject({ status: 200 })
    expect(h.deps.prepareSource).toHaveBeenCalledWith('session-1')
    expect(h.handler.fetch).toHaveBeenCalledTimes(1)
  })

  it('reports a preparation that failed and still left no usable layer', async () => {
    const h = harness()
    h.deps.prepareSource!.mockRejectedValue(new Error('boom'))
    h.deps.sourceRefusal!.mockReturnValue('operator-confined')
    h.lifecycle.accessRefusal!
      .mockReturnValueOnce(unavailable)
      .mockReturnValueOnce(unavailable)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual({
        status: 403,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
        body: expect.objectContaining({ error: 'source-write-unavailable', prepared: false, session: 'known', reason: 'operator-confined' }),
      })
    expect(h.handler.fetch).not.toHaveBeenCalled()
  })

  it('omits the reason when the host recorded none for a failed preparation', async () => {
    const h = harness()
    h.deps.prepareSource!.mockRejectedValue(new Error('boom'))
    h.deps.sourceRefusal!.mockReturnValue(undefined)
    h.lifecycle.accessRefusal!.mockReturnValueOnce(unavailable).mockReturnValueOnce(unavailable)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      .resolves.toEqual(expect.objectContaining({ body: expect.not.objectContaining({ reason: expect.anything() }) }))
  })

  it('returns the layer refusal found after preparation', async () => {
    const h = harness()
    const after = { status: 403, body: { error: 'other' }, reason: 'other' }
    h.lifecycle.accessRefusal!
      .mockReturnValueOnce(unavailable)
      .mockReturnValueOnce(after)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual(after)
  })

  it('refuses a write whose share state ended during preparation or dispatch', async () => {
    const h = harness()
    h.lifecycle.accessRefusal!.mockReturnValueOnce(unavailable).mockReturnValueOnce(undefined).mockReturnValueOnce(undefined)
    h.lifecycle.shareRefusal!
      .mockReturnValueOnce(undefined) // before
      .mockReturnValueOnce(refused) // after preparation
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual(refused)

    h.lifecycle.shareRefusal!.mockReset()
    h.lifecycle.accessRefusal!.mockReset()
    h.lifecycle.accessRefusal!.mockReturnValue(undefined)
    h.lifecycle.trustedState!.mockReturnValue(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual(refused)
  })

  it('rejects a write whose layer disappears while the owner answers', async () => {
    const h = harness()
    h.lifecycle.accessRefusal!
      .mockReturnValueOnce(unavailable) // before
      .mockReturnValueOnce(undefined) // after preparation
      .mockReturnValueOnce(unavailable) // after dispatch
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toMatchObject({
        status: 403,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
        body: { error: 'source-write-unavailable', message: expect.stringContaining('stopped being confined') },
      })
  })

  it('uses the post-dispatch refusal when the share stopped while the owner answered', async () => {
    const h = harness()
    h.lifecycle.shareRefusal!
      .mockReturnValueOnce(undefined) // after preparation
      .mockReturnValueOnce(refused) // after dispatch
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('session-1')), viewer))
      .resolves.toEqual(refused)
  })
})

describe('source Session cancels', () => {
  it('dispatches the cancel to the owner’s Gateway under the source-write rule', async () => {
    const h = harness()

    await expect(h.dispatch.answer('share-1', call('/api/session/cancel', envelope('session-1')), viewer))
      .resolves.toEqual({ status: 200, body: { result: { ok: true, value: { ok: true } } } })

    const request = h.handler.fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('http://liveshare.internal/api/session/cancel')
    // The policy decides the concrete call here exactly as it does for a prompt, and the Gateway decides it
    // again when it is dispatched; nothing in this host compares a turn's requester.
    expect(h.lifecycle.accessRefusal).toHaveBeenCalledWith('share-1', viewer, 'session/cancel', 'session-1', true)
    expect(h.lifecycle.trustedState).toHaveBeenCalledWith('share-1', viewer, 'session/cancel', 'session-1')
  })

  it('refuses a cancel whose share state ended before or during admission refresh', async () => {
    const h = harness()
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/cancel', envelope('session-1')), viewer))
      .resolves.toEqual(refused)
    expect(h.handler.fetch).not.toHaveBeenCalled()

    h.lifecycle.trustedState!.mockReturnValue(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/cancel', envelope('session-1')), viewer))
      .resolves.toEqual(refused)
    expect(h.handler.fetch).not.toHaveBeenCalled()
  })

  it('answers unavailable when the host cannot dispatch the cancel', async () => {
    const h = harness()
    h.deps.connection!.createSharedFetchHandler.mockReturnValue(undefined)
    await expect(h.dispatch.answer('share-1', call('/api/session/cancel', envelope('session-1')), viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-read-unavailable' } })
  })
})

describe('viewer child writes', () => {
  it('dispatches a prompt that names no Session', async () => {
    const h = harness()
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toMatchObject({ status: 200 })
    expect(h.deps.forks?.allowsPrompt).toHaveBeenCalledWith('child-1', viewer)
  })

  it('dispatches a child write body that names no Session and a child cancel', async () => {
    const h = harness()
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', {}), viewer))
      .resolves.toMatchObject({ status: 200 })
    await expect(h.dispatch.answer('share-1', call('/api/session/cancel', envelope('child-1')), viewer))
      .resolves.toMatchObject({ status: 200 })
    expect(h.handler.fetch).toHaveBeenCalledTimes(2)
    expect(h.deps.forks?.allowsPrompt).not.toHaveBeenCalled()
  })

  it('refuses a child write on a stopped share or a policy refusal', async () => {
    const h = harness()
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer)).resolves.toEqual(refused)

    h.lifecycle.accessRefusal!.mockReturnValueOnce({ status: 403, body: { error: 'not-a-fork' }, reason: 'not-a-fork' })
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toMatchObject({ body: { error: 'not-a-fork' } })
  })

  it('prepares a cold child whose limit is missing, then dispatches it', async () => {
    const h = harness()
    h.deps.forks!.allowsPrompt.mockReturnValue({ ok: false, code: 'fork-ceiling-uninstalled', message: 'cold' })
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toMatchObject({ status: 200 })
    expect(h.deps.prepareChild).toBeDefined()
    expect(h.fork.prepareColdChild).toHaveBeenCalledWith('child-1', viewer, { ok: false, code: 'fork-ceiling-uninstalled', message: 'cold' })
  })

  it('refuses a child whose preparation was refused or whose share state changed', async () => {
    const h = harness()
    h.deps.forks!.allowsPrompt.mockReturnValue({ ok: false, code: 'fork-ceiling-uninstalled', message: 'cold' })
    h.fork.prepareColdChild!.mockResolvedValue({ ok: false, code: 'fork-limit-unavailable', message: 'no limit' })
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toEqual({ status: 403, body: { error: 'fork-limit-unavailable', message: 'no limit' } })

    h.lifecycle.shareRefusal!.mockReturnValueOnce(undefined).mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toEqual(refused)
  })

  it('refuses a child whose access changed while preparation ran', async () => {
    const h = harness()
    h.lifecycle.accessRefusal!
      .mockReturnValueOnce(undefined) // snapshot
      .mockReturnValueOnce({ status: 403, body: { error: 'viewer-not-authorized' }, reason: 'viewer-not-authorized' })
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toMatchObject({ body: { error: 'viewer-not-authorized' } })
  })

  it('falls back to the policy refusal for a host without a fork registry', async () => {
    const h = harness()
    delete h.deps.forks
    delete h.deps.prepareChild
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toEqual({ status: 403, body: { error: 'fork-ceiling-uninstalled', message: 'this host has no fork registry' } })
  })

  it('refuses at the last admission check before dispatch', async () => {
    const h = harness()
    h.lifecycle.accessRefusal!
      .mockReturnValueOnce(undefined) // snapshot
      .mockReturnValueOnce(undefined) // racing check uses accessRefusal once more
      .mockReturnValueOnce({ status: 403, body: { error: 'share-stopped' }, reason: 'share-stopped' })
    await expect(h.dispatch.answer('share-1', call('/api/session/prompt', envelope('child-1')), viewer))
      .resolves.toMatchObject({ body: { error: 'share-stopped' } })
  })
})

describe('viewer streams', () => {
  it('refuses an open for a missing share, a refusing share, or no gateway', async () => {
    const h = harness()
    h.deps.sharedSessionId.mockReturnValue(undefined)
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toEqual({ status: 404, body: { error: 'share-not-found' } })

    h.deps.sharedSessionId.mockReturnValue('session-1')
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toEqual(refused)

    delete h.deps.gateway
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-read-unavailable' } })
  })

  it('refuses a stream id held by another viewer', async () => {
    const h = harness()
    h.streams.set('share-1:1', stream(1, { actor: other }))
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toMatchObject({ status: 403, body: { ok: false, error: { code: 'liveshare/read-only' } } })

    h.streams.clear()
    h.openings.set('share-1:1', { shareId: 'share-1', actor: other, controller: new AbortController() })
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toMatchObject({ status: 403, body: { ok: false, error: { code: 'liveshare/read-only' } } })

    // The same viewer re-opening its own id replaces the stream, and says so.
    h.openings.clear()
    h.streams.set('share-1:1', stream(1))
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/control', payload: {} }, viewer))
      .resolves.toEqual({ status: 200, body: { opened: true } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('viewer stream replaced'))
  })

  it('refuses an open for a viewer without a Peer', async () => {
    const h = harness()
    h.lifecycle.peerFor!.mockReturnValue(undefined)
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-read-unavailable' } })
  })

  it('registers a follow stream with branch frames', async () => {
    const h = harness()
    h.fork.withLineageFrames!.mockImplementation((
      _values: unknown, _endpoint: string, _requested: string | undefined, lineageOf: (id: string) => unknown,
    ) => {
      lineageOf('child-1')
      return (async function* () { yield { frame: 1 } })()
    })
    await expect(h.dispatch.answer('share-1', {
      op: 'stream-open', id: 1, endpoint: 'session/follow', payload: { address: { kind: 'session', sessionId: 'child-1' } },
    }, viewer)).resolves.toEqual({ status: 200, body: { opened: true } })
    expect(h.fork.withLineageFrames).toHaveBeenCalledWith(
      expect.anything(), 'session/follow', 'child-1', expect.any(Function),
    )
    expect(h.streams.get('share-1:1')).toMatchObject({ endpoint: 'session/follow', actor: viewer })
  })

  it('relays a non-follow stream with its own iterator', async () => {
    const h = harness()
    h.gateway.open.mockResolvedValue((async function* () { yield 1 })())
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 6, endpoint: 'session/events', payload: {} }, viewer))
      .resolves.toEqual({ status: 200, body: { opened: true } })
    expect(h.fork.withLineageFrames).not.toHaveBeenCalled()
  })

  it('describes each stream cause shape without payload data', async () => {
    const h = harness()
    const aborted = Object.assign(new Error('stopped'), { name: 'AbortError' })
    for (const cause of [aborted, { code: 'E_LIMIT', message: 'too large' }, { code: 'E_ONLY' }, { message: 'message only' }, 7]) {
      h.gateway.open.mockRejectedValue(cause)
      await h.dispatch.answer('share-1', { op: 'stream-open', id: 10, endpoint: 'session/control', payload: {} }, viewer)
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('AbortError: stopped (aborted)'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('E_LIMIT: too large'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('E_ONLY'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('object: message only'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('number'))
  })

  it('reports a stream that failed to open and logs a debug open', async () => {
    const h = harness()
    h.gateway.open.mockRejectedValue(new Error('open failed'))
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 1, endpoint: 'session/control', payload: {} }, viewer))
      .resolves.toEqual({ status: 200, body: { failure: { code: 'Error: open failed', message: 'Error: open failed', details: {} } } })

    vi.stubEnv('LIVESHARE_DEBUG_READS', '1')
    h.gateway.open.mockResolvedValue((async function* () {})())
    await h.dispatch.answer('share-1', { op: 'stream-open', id: 2, endpoint: 'session/control', payload: {} }, viewer)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('viewer stream open share=share-1'))
  })

  it('cancels an opening whose caller aborted and releases the opened iterator', async () => {
    const h = harness()
    const controller = new AbortController()
    const returned = vi.fn(async () => ({ done: true, value: undefined }))
    // oxlint-disable-next-line typescript/no-misused-promises -- typed test doubles and mock calls.
    h.gateway.open.mockImplementation(async () => {
      controller.abort(new Error('viewer left'))
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: 1 }), return: returned }) }
    })
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 3, endpoint: 'session/follow', payload: {} }, viewer, controller.signal))
      .rejects.toThrow('viewer left')
    expect(returned).toHaveBeenCalled()
  })

  it('refuses a share that stopped while a failed open was in flight', async () => {
    const h = harness()
    h.gateway.open.mockRejectedValue(new Error('open failed'))
    h.lifecycle.shareRefusal!.mockReturnValueOnce(undefined).mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 7, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toEqual(refused)
  })

  it('releases an opened iterator without a return method, or whose return rejects', async () => {
    const h = harness()
    const controller = new AbortController()
    // oxlint-disable-next-line typescript/no-misused-promises -- typed test doubles and mock calls.
    h.gateway.open.mockImplementation(async () => {
      controller.abort(new Error('left'))
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: 1 }) }) }
    })
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 8, endpoint: 'session/follow', payload: {} }, viewer, controller.signal))
      .rejects.toThrow('left')

    const rejectController = new AbortController()
    // oxlint-disable-next-line typescript/no-misused-promises -- typed test doubles and mock calls.
    h.gateway.open.mockImplementation(async () => {
      rejectController.abort(new Error('left again'))
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: 1 }),
          return: async () => { throw new Error('return failed') },
        }),
      }
    })
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 9, endpoint: 'session/follow', payload: {} }, viewer, rejectController.signal))
      .rejects.toThrow('left again')
  })

  it('aborts before the open when the caller already left, even without a stream to release', async () => {
    const h = harness()
    h.gateway.open.mockRejectedValue(new Error('open failed'))
    const controller = new AbortController()
    controller.abort(new Error('already left'))
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 5, endpoint: 'session/follow', payload: {} }, viewer, controller.signal))
      .rejects.toThrow('already left')
  })

  it('answers a share that stopped while its stream opened', async () => {
    const h = harness()
    h.lifecycle.shareRefusal!.mockReturnValueOnce(undefined).mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', { op: 'stream-open', id: 4, endpoint: 'session/follow', payload: {} }, viewer))
      .resolves.toEqual(refused)
  })

  it('answers a missing stream, a stream of another viewer, and a refused share', async () => {
    vi.stubEnv('LIVESHARE_DEBUG_READS', '1')
    const h = harness()
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 9 }, viewer))
      .resolves.toEqual({ status: 404, body: { error: 'stream-not-found' } })

    h.streams.set('share-1:1', stream(1, { actor: other }))
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer))
      .resolves.toMatchObject({ status: 403, body: { error: { code: 'liveshare/read-only' } } })

    h.streams.set('share-1:2', stream(2))
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 2 }, viewer))
      .resolves.toEqual(refused)
    expect(h.streams.has('share-1:2')).toBe(false)
  })

  it('releases a stream whose share stopped before the poll and accepts a caller signal', async () => {
    const h = harness()
    h.streams.set('share-1:1', stream(1))
    h.lifecycle.shareRefusal!.mockReturnValueOnce(undefined).mockReturnValueOnce(refused)
    const controller = new AbortController()
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer, controller.signal))
      .resolves.toEqual(refused)
    expect(h.streams.has('share-1:1')).toBe(false)
  })

  it('polls with the caller signal combined with the stream signal', async () => {
    const h = harness()
    const values = ['v']
    const yielding = stream(1)
    yielding.iterator = {
      next: async () => values.length === 0 ? { done: true, value: undefined } : { done: false, value: values.shift() },
    }
    h.streams.set('share-1:1', yielding)
    const controller = new AbortController()
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer, controller.signal))
      .resolves.toEqual({ status: 200, body: { values: ['v'] } })
  })

  it('answers a failure, an end, and a value batch', async () => {
    const h = harness()
    const failing = stream(2)
    failing.iterator = { next: async () => { throw new Error('stream failed') } }
    h.streams.set('share-1:2', failing)
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 2 }, viewer))
      .resolves.toMatchObject({ status: 200, body: { failure: { code: 'Error: stream failed' } } })
    expect(h.streams.has('share-1:2')).toBe(false)

    const ending = stream(3)
    ending.iterator = { next: async () => ({ done: true, value: undefined }) }
    h.streams.set('share-1:3', ending)
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 3 }, viewer))
      .resolves.toEqual({ status: 200, body: { end: true } })
    expect(h.streams.has('share-1:3')).toBe(false)

    const values = ['a', 'b']
    const yielding = stream(4)
    yielding.iterator = {
      next: async () => values.length === 0 ? { done: true, value: undefined } : { done: false, value: values.shift() },
    }
    h.streams.set('share-1:4', yielding)
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 4 }, viewer))
      .resolves.toEqual({ status: 200, body: { values: ['a', 'b'] } })
  })

  it('returns a refusal without releasing an id another stream now owns', async () => {
    const h = harness()
    const original = stream(1)
    const replacement = stream(1)
    h.streams.set('share-1:1', original)
    h.lifecycle.streamOf!
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(replacement)
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer)).resolves.toEqual(refused)
    expect(h.lifecycle.release).not.toHaveBeenCalled()
  })

  it('stops a batch whose stream was replaced after the drain', async () => {
    const h = harness()
    const values = ['a']
    const yielding = stream(1)
    yielding.iterator = {
      next: async () => values.length === 0 ? { done: true, value: undefined } : { done: false, value: values.shift() },
    }
    h.streams.set('share-1:1', yielding)
    h.lifecycle.streamIsCurrent!.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer))
      .resolves.toEqual({ status: 404, body: { error: 'stream-not-found' } })
  })

  it('rejects a poll whose caller aborted while the iterator was pending', async () => {
    const h = harness()
    h.streams.set('share-1:1', stream(1, { pending: new Promise<IteratorResult<unknown>>(() => {}) }))
    const controller = new AbortController()
    const answer = h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(new Error('gone'))
    await expect(answer).rejects.toThrow('Viewer request cancelled')
  })

  it('bounds a batch at the stream batch maximum', async () => {
    const h = harness()
    const endless = stream(1)
    endless.iterator = { next: async () => ({ done: false, value: 'v' }) }
    h.streams.set('share-1:1', endless)
    const answer = await h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer)
    expect((answer.body as { values: unknown[] }).values).toHaveLength(64)
  })

  it('reports a poll that answered late and one whose stream was replaced', async () => {
    const h = harness()
    let clock = 0
    // Every reading advances past the late threshold; the pair around the poll is adjacent.
    vi.spyOn(Date, 'now').mockImplementation(() => { clock += 13_000; return clock })
    h.streams.set('share-1:1', stream(1, { pending: Promise.resolve({ done: false, value: 'a' }) }))
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer))
      .resolves.toEqual({ status: 200, body: { values: ['a'] } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('viewer stream poll late'))

    h.lifecycle.streamIsCurrent!.mockReturnValueOnce(false)
    h.streams.set('share-1:2', stream(2))
    await expect(h.dispatch.answer('share-1', { op: 'stream-next', id: 2 }, viewer))
      .resolves.toEqual({ status: 404, body: { error: 'stream-not-found' } })
  })

  it('releases an opening reservation by cancel and logs a debug cancel', async () => {
    vi.stubEnv('LIVESHARE_DEBUG_READS', '1')
    const h = harness()
    h.openings.set('share-1:1', { shareId: 'share-1', actor: viewer, controller: new AbortController() })
    await expect(h.dispatch.answer('share-1', { op: 'stream-cancel', id: 1 }, viewer))
      .resolves.toEqual({ status: 200, body: { cancelled: true } })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('viewer stream cancel share=share-1'))
  })

  it('releases a stream on cancel, refusing another viewer', async () => {
    const h = harness()
    h.streams.set('share-1:1', stream(1, { actor: other }))
    await expect(h.dispatch.answer('share-1', { op: 'stream-cancel', id: 1 }, viewer))
      .resolves.toMatchObject({ status: 403 })

    h.streams.set('share-1:2', stream(2))
    await expect(h.dispatch.answer('share-1', { op: 'stream-cancel', id: 2 }, viewer))
      .resolves.toEqual({ status: 200, body: { cancelled: true } })
    expect(h.streams.has('share-1:2')).toBe(false)
  })

  it('aborts an in-flight call when the caller leaves', async () => {
    const h = harness()
    // oxlint-disable-next-line typescript/no-misused-promises -- typed test doubles and mock calls.
    h.handler.fetch.mockImplementation(async (request: Request) => {
      await new Promise<void>((resolve) => { request.signal.addEventListener('abort', () => { resolve() }) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const controller = new AbortController()
    const pending = h.dispatch.answer('share-1', call('/api/session/list'), viewer, controller.signal)
    controller.abort(new Error('left'))
    await expect(pending).rejects.toThrow('left')
    expect(h.lifecycle.beginCall).toHaveBeenCalled()
    expect(h.lifecycle.endCall).toHaveBeenCalled()
  })
})

describe('page assets', () => {
  it('serves the document without the manifest link and logs debug reads', async () => {
    const h = harness()
    h.deps.debug = true
    const answer = await h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer)
    expect(answer.status).toBe(200)
    const body = (answer.body as { base64: string }).base64
    expect(Buffer.from(body, 'base64').toString('utf8')).not.toContain('rel="manifest"')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('viewer asset share=share-1'))
  })

  it('leaves a non-200 document answer unchanged', async () => {
    const h = harness()
    const answer = { status: 500, body: { error: 'read-failed' } }
    h.deps.readAsset!.mockResolvedValue(answer)
    await expect(h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer)).resolves.toBe(answer)
  })

  it('leaves a document without a manifest link unchanged', async () => {
    const h = harness()
    const bytes = Buffer.from('<html>\n</html>').toString('base64')
    h.deps.readAsset!.mockResolvedValue({ status: 200, body: { contentType: 'text/html', base64: bytes } })
    await expect(h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer))
      .resolves.toEqual({ status: 200, body: { contentType: 'text/html', base64: bytes } })
  })

  it('refuses an asset path the page does not serve', async () => {
    const h = harness()
    for (const path of ['assets/app.js.map', 'other.txt', 'assets/app.js%2Emap']) {
      await expect(h.dispatch.answer('share-1', { op: 'asset', path }, viewer))
        .resolves.toEqual({ status: 404, body: { error: 'asset-not-found' } })
    }
    await expect(h.dispatch.answer('share-1', { op: 'asset', path: 'assets/app.js%ZZ' }, viewer))
      .resolves.toMatchObject({ status: 200 })
  })

  it('serves a top-level file and a source-map query without admitting the map', async () => {
    const h = harness()
    h.deps.readAsset!.mockResolvedValue({ status: 200, body: { contentType: 'image/svg+xml', base64: '' } })
    await h.dispatch.answer('share-1', { op: 'asset', path: 'favicon.svg?v=1' }, viewer)
    await h.dispatch.answer('share-1', { op: 'asset', path: 'assets/app.js.map&rev=1' }, viewer)
    expect(h.deps.readAsset).toHaveBeenCalledTimes(1)
  })

  it('measures each served body shape for the debug byte count', async () => {
    const h = harness()
    h.deps.debug = true
    for (const body of [
      'not an asset at all',
      { error: 'not an asset' },
      { contentType: 'text/plain' },
      { contentType: 'text/plain', base64: 'AAAA==' },
      { contentType: 'text/plain', base64: 'AAA=' },
      { contentType: 'text/plain', base64: 'AAAA' },
    ]) {
      h.deps.readAsset!.mockResolvedValue({ status: 200, body })
      await h.dispatch.answer('share-1', { op: 'asset', path: 'index.html' }, viewer)
    }
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bytes=3'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bytes=2'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bytes=undefined'))
  })

  it('answers unavailable without an asset reader or Peer, and refuses a stopped share', async () => {
    const h = harness()
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await expect(h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer)).resolves.toEqual(refused)

    delete h.deps.readAsset
    await expect(h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-page-unavailable' } })

    h.deps.readAsset = vi.fn(async () => ({ status: 200, body: { contentType: 'text/html', base64: '' } })) as never
    h.lifecycle.peerFor!.mockReturnValue(undefined)
    await expect(h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer))
      .resolves.toEqual({ status: 503, body: { error: 'viewer-page-unavailable' } })
  })

  it('logs a debug call and a debug stream open', async () => {
    const h = harness()
    h.deps.debug = true
    await h.dispatch.answer('share-1', call('/api/session/list'), viewer)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('viewer read share=share-1'))
    await h.dispatch.answer('share-1', { op: 'stream-open', id: 9, endpoint: 'session/control', payload: {} }, viewer)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('viewer stream open share=share-1'))
  })

  it('logs a refused debug read and rejects an unknown operation loudly', async () => {
    const h = harness()
    h.deps.debug = true
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await h.dispatch.answer('share-1', { op: 'asset', path: '' }, viewer)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('viewer read refused share=share-1'))

    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await h.dispatch.answer('share-1', { op: 'stream-open', id: 3, endpoint: 'session/follow', payload: {} }, viewer)
    h.lifecycle.shareRefusal!.mockReturnValueOnce(refused)
    await h.dispatch.answer('share-1', { op: 'stream-next', id: 4 }, viewer)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('target=session/follow'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('target=4'))

    await expect(h.dispatch.answer('share-1', { op: 'bogus' } as never, viewer))
      .rejects.toThrow('unhandled viewer request')
  })
})

describe('stream polling bounds', () => {
  it('holds a pending pull for its window', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.streams.set('share-1:1', stream(1, { pending: new Promise<IteratorResult<unknown>>(() => {}) }))
      const answer = h.dispatch.answer('share-1', { op: 'stream-next', id: 1 }, viewer)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(answer).resolves.toEqual({ status: 200, body: { pending: true } })
    } finally {
      vi.useRealTimers()
    }
  })
})
