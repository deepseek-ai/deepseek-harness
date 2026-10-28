/** Fork orchestration: identity, replay, enforcement, and branch annotations. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { ForkRecord } from '../src/host/fork-registry.ts'
import { createViewerFork } from '../src/host/viewer-fork.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import type { ViewerAnswer } from '../src/viewer-channel.ts'

const viewer: ShareRpcActor = { providerId: 'p', tenantId: 't', subjectId: 'alice' }
const other: ShareRpcActor = { providerId: 'p', tenantId: 't', subjectId: 'bob' }

const SHARE: ForkShareState = {
  shareId: 'share-1', sessionId: 'session-1', allowsFork: true, viewerAdmitted: true, stopped: false,
}

const forkAnswer = (sessionId = 'child-1', rpcId = 'rpc-1'): ViewerAnswer => ({
  status: 200,
  body: { type: 'server-response', rpcId, result: { ok: true, value: { sessionId } } },
})

const body = (request: Record<string, unknown> = {}): Record<string, unknown> => ({
  payload: { args: { request: { sessionId: 'session-1', ...request } } },
})

function forkRecord(overrides: Partial<ForkRecord> = {}): ForkRecord {
  return {
    childSessionId: 'child-1', shareId: 'share-1', sourceSessionId: 'session-1', boundary: 3,
    creator: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

function harness(options: {
  readonly share?: ForkShareState | undefined
  readonly answer?: ViewerAnswer | (() => Promise<ViewerAnswer>)
  readonly enforce?: () => Promise<(() => void) | undefined>
  readonly child?: ForkRecord | undefined
} = {}) {
  const records = new Map<string, ForkRecord>()
  if (options.child !== undefined) records.set(options.child.childSessionId, options.child)
  const operations = new Map<string, { childSessionId: string; boundary: number; ready: boolean; status: number; body: unknown }>()
  const forks = {
    find: vi.fn((id: string) => records.get(id)),
    operationOf: vi.fn((key: string) => operations.get(key)),
    reserveOperation: vi.fn(async (key: string, boundary: number) => {
      operations.set(key, { childSessionId: '', boundary, ready: false, status: 0, body: undefined })
    }),
    recordOperation: vi.fn(async (operation: {
      key: string
      childSessionId: string
      boundary: number
      ready: boolean
      status: number
      body: unknown
    }) => {
      operations.set(operation.key, operation)
    }),
    record: vi.fn(async (record: ForkRecord) => { records.set(record.childSessionId, record) }),
    allowsPrompt: vi.fn(() => ({ ok: true as const })),
  }
  const lifecycle = {
    shareRefusal: vi.fn((): ViewerAnswer | undefined => undefined),
    holdEnforcement: vi.fn(),
  }
  const dispatch = vi.fn(async (_path: string, _body?: unknown) => {
    if (typeof options.answer === 'function') return options.answer()
    return options.answer ?? forkAnswer()
  })
  const prepareChild = vi.fn(async () => {})
  const enforceChild = vi.fn(options.enforce ?? (async () => () => {}))
  const accessChanged = vi.fn()
  const fork = createViewerFork({
    deps: {
      forkStateOf: vi.fn(() => options.share === undefined && 'share' in options ? undefined : (options.share ?? SHARE)),
      forks,
      prepareChild,
      enforceChild,
      accessChanged,
    },
    lifecycle,
    dispatch: () => ({ answer: vi.fn(), dispatchCall: dispatch }),
  } as never)
  return { fork, forks, lifecycle, dispatch, prepareChild, enforceChild, accessChanged }
}

describe('fork preparation and admission', () => {
  it('reports a failed cold-child preparation and falls back without a registry', async () => {
    const h = harness()
    h.prepareChild.mockRejectedValue(new Error('activation failed'))
    await expect(h.fork.prepareColdChild('child-1', viewer, { ok: false, code: 'fork-ceiling-uninstalled', message: 'cold' }))
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      .resolves.toMatchObject({ ok: false, code: 'fork-prepare-failed', message: expect.stringContaining('activation failed') })
    h.prepareChild.mockRejectedValue('plain failure')
    await expect(h.fork.prepareColdChild('child-1', viewer, { ok: false, code: 'fork-ceiling-uninstalled', message: 'cold' }))
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      .resolves.toMatchObject({ message: expect.stringContaining('plain failure') })

    const withoutRegistry = createViewerFork({
      deps: { forkStateOf: () => SHARE, prepareChild: vi.fn(async () => {}) },
      lifecycle: { shareRefusal: vi.fn(), holdEnforcement: vi.fn() },
      dispatch: () => ({ dispatchCall: vi.fn() }),
    } as never)
    const previous = { ok: false as const, code: 'fork-ceiling-uninstalled' as const, message: 'cold' }
    await expect(withoutRegistry.prepareColdChild('child-1', viewer, previous)).resolves.toEqual(previous)
  })

  it('refuses a fork for a missing, refusing, or undecidable share', async () => {
    const missing = harness({ share: undefined })
    await expect(missing.fork.answerFork('share-1', '/api/session/fork', body(), viewer))
      .resolves.toEqual({ status: 404, body: { error: 'share-not-found' } })

    const refusing = harness()
    refusing.lifecycle.shareRefusal.mockReturnValue({ status: 403, body: { error: 'share-stopped' } })
    await expect(refusing.fork.answerFork('share-1', '/api/session/fork', body(), viewer))
      .resolves.toEqual({ status: 403, body: { error: 'share-stopped' } })

    const forbidden = harness({ share: { ...SHARE, allowsFork: false } })
    await expect(forbidden.fork.answerFork('share-1', '/api/session/fork', body(), viewer))
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      .resolves.toMatchObject({ status: 403, body: { error: expect.any(String), message: expect.any(String) } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('fork refused'))
  })

  it('creates once for an unidentified request and forwards its envelope unchanged', async () => {
    const h = harness()
    await expect(h.fork.answerFork('share-1', '/api/session/fork', body(), viewer)).resolves.toMatchObject({ status: 200 })
    expect(h.forks.reserveOperation).not.toHaveBeenCalled()
    expect(h.forks.recordOperation).not.toHaveBeenCalled()
    expect(h.dispatch).toHaveBeenCalledWith('/api/session/fork', body(), 'share-1', viewer, undefined)

    // A flat envelope is forwarded exactly as the caller sent it: the owner's SessionForkRequest mints the
    // child id itself, so this host injects no field that request type does not have.
    const flat = { rpcId: 'rpc-flat', sessionId: 'session-1' }
    await h.fork.answerFork('share-1', '/api/session/fork', flat, viewer)
    expect(h.forks.reserveOperation).toHaveBeenCalled()
    expect(h.dispatch.mock.calls.at(-1)?.[1]).toEqual(flat)
  })

  it('refuses a body that names no Session instead of dispatching an unrecorded fork', async () => {
    const h = harness()
    await expect(h.fork.answerFork('share-1', '/api/session/fork', { payload: { args: { request: {} } } }, viewer))
      .resolves.toEqual({
        status: 400,
        body: { error: 'fork-session-required', message: 'a fork request must name the session it branches from' },
      })
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('refuses a body naming a child without a bound operation identity', async () => {
    const h = harness()
    await expect(h.fork.answerFork('share-1', '/api/session/fork', body({ childSessionId: 'child-9' }), viewer))
      .resolves.toMatchObject({ status: 403, body: { error: 'fork-identity-required' } })
    expect(h.dispatch).not.toHaveBeenCalled()
  })
})

describe('fork identity and replay', () => {
  const operationBody = (operationId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    payload: { args: { request: { sessionId: 'session-1', operationId, atSeq: 3, ...extra } } },
  })

  it('creates once, records the child, and replays its answer for a retry', async () => {
    const h = harness()
    await expect(h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer))
      .resolves.toMatchObject({ status: 200, body: { result: { value: { sessionId: 'child-1' } } } })
    expect(h.forks.reserveOperation).toHaveBeenCalledWith(expect.any(String), 3)
    expect(h.forks.record).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: 'child-1', boundary: 3 }))
    expect(h.enforceChild).toHaveBeenCalledWith('child-1', { write: false })
    expect(h.lifecycle.holdEnforcement).toHaveBeenCalledWith('child-1', expect.any(Function))

    // The recorded answer carries this request's correlation id.
    const replay = await h.fork.answerFork('share-1', '/api/session/fork', {
      rpcId: 'rpc-retry', payload: { args: { request: { sessionId: 'session-1', operationId: 'op-1', atSeq: 3 } } },
    }, viewer)
    expect(replay).toMatchObject({ status: 200, body: { rpcId: 'rpc-retry' } })
  })

  it('answers a recorded child whose limits were never confirmed as an enforcement failure', async () => {
    const h = harness()
    h.forks.operationOf.mockReturnValue({ childSessionId: 'child-1', boundary: 3, ready: false, status: 503, body: {} })
    await expect(h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer))
      .resolves.toMatchObject({ status: 503, body: { error: 'fork-enforcement-failed' } })
  })

  it('refuses a retry that names another boundary', async () => {
    const h = harness()
    h.forks.operationOf.mockReturnValue({ childSessionId: 'child-1', boundary: 2, ready: true, status: 200, body: {} })
    await expect(h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer))
      .resolves.toMatchObject({ status: 409, body: { error: 'fork-operation-conflict' } })
  })

  it('joins an in-flight request with the same boundary and conflicts on another', async () => {
    let release: ((answer: ViewerAnswer) => void) | undefined
    const h = harness({ answer: () => new Promise<ViewerAnswer>((resolve) => { release = resolve }) })
    const first = h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer)
    // Yield so the first request binds its in-flight entry.
    await Promise.resolve()
    const conflict = await h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1', { atSeq: 4 }), viewer)
    expect(conflict).toMatchObject({ status: 409 })
    const second = h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer)
    release?.(forkAnswer('child-1', 'rpc-owner'))
    await expect(first).resolves.toEqual(forkAnswer('child-1', 'rpc-owner'))
    await expect(second).resolves.toMatchObject({ status: 200, body: { result: { value: { sessionId: 'child-1' } } } })
  })

  it('creates when a reservation exists but its child never did', async () => {
    const h = harness()
    h.forks.operationOf.mockReturnValue({ childSessionId: '', boundary: 3, ready: false, status: 0, body: undefined })
    await expect(h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer))
      .resolves.toMatchObject({ status: 200 })
    expect(h.dispatch).toHaveBeenCalled()
  })

  it('records a child whose enforcement failed and answers that failure', async () => {
    const h = harness({ enforce: async () => { throw new Error('no tools') } })
    await expect(h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer))
      .resolves.toMatchObject({ status: 503, body: { error: 'fork-enforcement-failed' } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('fork limits failed'))
    expect(h.forks.recordOperation).toHaveBeenCalledWith(expect.objectContaining({ ready: false, status: 503 }))

    const plain = harness({ enforce: async () => { throw 'plain failure' } })
    await expect(plain.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer))
      .resolves.toMatchObject({ status: 503 })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('plain failure'))
  })

  it('returns an owner answer that named no child unchanged', async () => {
    for (const answer of [
      { status: 200, body: { result: { ok: true, value: {} } } },
      { status: 500, body: { result: { ok: true, value: { sessionId: 'child-1' } } } },
      { status: 200, body: { result: { ok: false } } },
      { status: 200, body: 'not a record' },
    ] as ViewerAnswer[]) {
      const h = harness({ answer })
      await expect(h.fork.answerFork('share-1', '/api/session/fork', operationBody('op-1'), viewer)).resolves.toEqual(answer)
      expect(h.forks.record).not.toHaveBeenCalled()
    }
  })
})

describe('branch annotations', () => {
  const child = forkRecord()
  const listAnswer = (item: Record<string, unknown>): ViewerAnswer => ({
    status: 200, body: { result: { ok: true, value: { items: [item] } } },
  })

  it('annotates only this reader own branch rows', () => {
    const h = harness({ child })
    const annotated = h.fork.annotateSessionList(
      listAnswer({ sessionId: 'child-1', projections: { kind: 'sequenced', asOfSeq: 2 } }), 'share-1', viewer,
    )
    const item = (annotated.body as { result: { value: { items: Record<string, unknown>[] } } }).result.value.items[0]!
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    expect(item.projections).toMatchObject({ kind: 'sequenced', values: { forkLineage: expect.anything() } })
    const withValues = h.fork.annotateSessionList(
      listAnswer({ sessionId: 'child-1', projections: { kind: 'sequenced', values: { existing: true } } }), 'share-1', viewer,
    )
    const merged = (withValues.body as { result: { value: { items: { projections: { values: Record<string, unknown> } }[] } } })
      .result.value.items[0]!.projections.values
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    expect(merged).toMatchObject({ existing: true, forkLineage: expect.anything() })

    expect(h.fork.annotateSessionList(listAnswer({ sessionId: 'child-1' }), 'share-1', other))
      .toEqual(listAnswer({ sessionId: 'child-1' }))
  })

  it('adds cached hints to a row the owner served without a block', () => {
    const h = harness({ child })
    const annotated = h.fork.annotateSessionList(listAnswer({ sessionId: 'child-1' }), 'share-1', viewer)
    const item = (annotated.body as { result: { value: { items: Record<string, unknown>[] } } }).result.value.items[0]!
    expect(item.projections).toMatchObject({ kind: 'cached', asOfSeq: 0 })
  })

  it('leaves answers it cannot annotate unchanged', () => {
    const h = harness({ child })
    for (const answer of [
      { status: 500, body: {} },
      { status: 200, body: 'not a record' },
      { status: 200, body: { result: { ok: false } } },
      { status: 200, body: { result: { ok: true, value: { items: 'no' } } } },
    ] as ViewerAnswer[]) {
      expect(h.fork.annotateSessionList(answer, 'share-1', viewer)).toBe(answer)
    }
    expect(h.fork.annotateSessionList(listAnswer({ not: 'a row' }), 'share-1', viewer))
      .toEqual(listAnswer({ not: 'a row' }))
  })

  it('adds branch facts to a page block and leaves other answers alone', () => {
    const h = harness({ child })
    const lineage = h.fork.lineageFor('share-1', 'child-1', viewer)
    const page: ViewerAnswer = {
      status: 200, body: { result: { ok: true, value: { projections: { kind: 'cached' } } } },
    }
    expect(h.fork.withLineageAnswer(page, lineage!)).toMatchObject({
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
      body: { result: { value: { projections: { kind: 'cached', values: { forkLineage: expect.anything() } } } } },
    })
    expect(h.fork.withLineageAnswer({ status: 500, body: {} }, lineage!)).toEqual({ status: 500, body: {} })
    expect(h.fork.withLineageAnswer({ status: 200, body: { result: { ok: false } } }, lineage!))
      .toEqual({ status: 200, body: { result: { ok: false } } })
    expect(h.fork.withLineageAnswer({
      status: 200, body: { result: { ok: true, value: { projections: 'primitive' } } },
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    }, lineage!)).toMatchObject({ body: { result: { value: { projections: { values: { forkLineage: expect.anything() } } } } } })
  })

  it('resolves lineage only for the share and viewer that created the child', () => {
    const h = harness({ child })
    expect(h.fork.lineageFor('share-1', 'child-1', viewer)).toBeDefined()
    expect(h.fork.lineageFor('share-2', 'child-1', viewer)).toBeUndefined()
    expect(h.fork.lineageFor('share-1', 'child-1', other)).toBeUndefined()
    expect(h.fork.lineageFor('share-1', 'absent', viewer)).toBeUndefined()

    const withoutRegistry = createViewerFork({
      deps: { forkStateOf: () => SHARE },
      lifecycle: { shareRefusal: vi.fn() },
      dispatch: () => ({ dispatchCall: vi.fn() }),
    } as never)
    expect(withoutRegistry.lineageFor('share-1', 'child-1', viewer)).toBeUndefined()
  })

  it('annotates follow snapshots and control baselines frame by frame', async () => {
    const h = harness({ child })
    const frames = async function* (): AsyncGenerator {
      yield 'primitive'
      yield { type: 'delta' }
      yield { type: 'snapshot', projections: { kind: 'sequenced' } }
    }
    const followed = await collect(h.fork.withLineageFrames(frames(), 'session/follow', 'child-1',
      id => h.fork.lineageFor('share-1', id, viewer)))
    expect(followed[0]).toBe('primitive')
    expect(followed[1]).toEqual({ type: 'delta' })
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    expect(followed[2]).toMatchObject({ projections: { values: { forkLineage: expect.anything() } } })
    // A follow for another Session, or without one, keeps the owner's frames.
    const plain = await collect(h.fork.withLineageFrames((async function* () {
      yield { type: 'snapshot', projections: {} }
    })(), 'session/follow', undefined, () => undefined))
    expect(plain[0]).toEqual({ type: 'snapshot', projections: {} })

    const control = await collect(h.fork.withLineageFrames((async function* () {
      yield { type: 'baseline', value: { projections: { 'child-1': { kind: 'sequenced' }, other: {} } } }
      yield { type: 'baseline' }
      yield { type: 'delta', value: { projections: {} } }
    })(), 'session/control', 'child-1', id => h.fork.lineageFor('share-1', id, viewer)))
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- typed test doubles and mock calls.
    expect(control[0]).toMatchObject({ value: { projections: { 'child-1': { values: { forkLineage: expect.anything() } } } } })
    expect(control[1]).toEqual({ type: 'baseline' })
    expect(control[2]).toEqual({ type: 'delta', value: { projections: {} } })
  })
})

async function collect(values: AsyncGenerator): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of values) frames.push(frame)
  return frames
}
