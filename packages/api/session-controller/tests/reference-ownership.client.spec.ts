/** Source-labelled Client references over real history transport and scoped Contexts. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished, vi } from 'vitest'
import type {
  SessionReference, SessionReferenceSource, SessionRetainInfo,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp, type TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { FOLLOW, followScript, type HistoryAnswer } from './remote/session.client.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    referenceTestView: unknown
    referenceTestWork: unknown
  }
}

const viewSource: SessionReferenceSource = 'referenceTestView'
const workSource: SessionReferenceSource = 'referenceTestWork'
const ID = SessionId('reference-session')
const EMPTY_HISTORY = ok({ records: [], hasMore: false })
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })

async function bench(mock: RemoteMock, start: () => Promise<TestClient>, listed = true) {
  const client = await start()
  const ctx = new Context()
  const svc = new ClientSessions(ctx, client.ctx.remote)
  const unblock: Array<() => void> = []
  onTestFinished(async () => {
    for (const finish of unblock) finish()
    await ctx.fiber.dispose()
  })
  mock.stream(FOLLOW, followScript(EMPTY_HISTORY))
  const feed = async (include: boolean): Promise<void> => {
    mock.remote.session.list.mockResolvedValue(ok({ items: include
      ? [{ sessionId: ID, updatedAt: 1, running: false, blank: true, agentAvailable: true }]
      : [] }))
    await svc.refresh()
  }
  if (listed) await feed(true)
  return { svc, ctx, mock, feed, unblock }
}

describe('Client reference sources', () => {
  it('observes unknown identities without creating a scope, reference, or history request', async ({ mock, start }) => {
    const b = await bench(mock, start, false)
    const source = b.svc.retainInfo(ID)
    const before = source.getSnapshot()
    const stop = source.subscribe(vi.fn())
    expect(b.svc.retainInfo(ID)).toBe(source)
    expect(source.getSnapshot()).toBe(before)
    expect(before).toEqual({ referenceCount: 0, retainedBy: {} })
    expect('set' in source).toBe(false)
    expect(b.svc.scope(ID)).toBeUndefined()
    expect(b.svc.binding(ID)).toBeUndefined()
    expect(mock.log.requests(FOLLOW)).toHaveLength(0)
    expect(() => b.svc.retain(ID, { source: viewSource })).toThrow('unknown session')
    expect(source.getSnapshot()).toBe(before)
    stop()
  })

  it('shares initial opening while exposing independent source contributions before the await', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const opening = Promise.withResolvers<Awaited<HistoryAnswer>>()
    const entered = Promise.withResolvers<undefined>()
    b.unblock.push(() => { opening.resolve(EMPTY_HISTORY) })
    mock.stream(FOLLOW, followScript(() => { entered.resolve(undefined); return opening.promise }))
    const source = b.svc.retainInfo(ID)
    const first = b.svc.retain(ID, { source: viewSource })
    const binding = b.svc.binding(ID)
    const second = b.svc.retain(ID, { source: workSource })
    const acquisitions = Promise.allSettled([first.ready, second.ready])
    expect(binding).toBeDefined()
    expect(source.getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { referenceTestView: 1, referenceTestWork: 1 } })
    expect(b.svc.list.getSnapshot().byId[ID]?.retainedBy).toBe(source.getSnapshot().retainedBy)
    await entered.promise
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
    opening.resolve(EMPTY_HISTORY)
    await acquisitions
    using a = first
    using c = second
    expect(a.binding).toBe(binding)
    expect(c.binding).toBe(binding)
    expect(a.binding.session.getSnapshot().openState).toBe('open')
    a.release()
    a[Symbol.dispose]()
    expect(source.getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { referenceTestWork: 1 } })
    expect(() => a.binding).toThrow('is released')
    c.release()
    expect(source.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(b.svc.binding(ID)).toBeUndefined()
  })

  it('counts repeated uses of one source and omits it after the final release', async ({ mock, start }) => {
    const b = await bench(mock, start)
    using first = b.svc.retain(ID, { source: workSource, signal: undefined })
    using second = b.svc.retain(ID, { source: workSource })
    await Promise.all([first.ready, second.ready])
    const source = b.svc.retainInfo(ID)
    expect(source.getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { referenceTestWork: 2 } })
    first.release()
    expect(source.getSnapshot().retainedBy.referenceTestWork).toBe(1)
    second.release()
    expect(source.getSnapshot().retainedBy.referenceTestWork).toBeUndefined()
    expect(Object.keys(source.getSnapshot().retainedBy)).toEqual([])
  })

  it('keeps counts through catalog refresh/removal and projects them when the row returns', async ({ mock, start }) => {
    const b = await bench(mock, start)
    using reference = b.svc.retain(ID, { source: viewSource })
    await reference.ready
    const binding = reference.binding
    const source = b.svc.retainInfo(ID)
    const snapshot = source.getSnapshot()
    await b.feed(true)
    expect(b.svc.list.getSnapshot().byId[ID]?.retainedBy).toBe(snapshot.retainedBy)
    b.svc.handleSessionRemoved(ID)
    await vi.waitFor(() => {
      expect(b.svc.list.getSnapshot().byId[ID]).toBeUndefined()
    })
    expect(b.svc.list.getSnapshot().ids).not.toContain(ID)
    expect(source.getSnapshot()).toBe(snapshot)
    expect(b.svc.binding(ID)).toBe(binding)
    await b.feed(true)
    expect(b.svc.list.getSnapshot().byId[ID]?.retainedBy).toBe(snapshot.retainedBy)
    reference.release()
    expect(b.svc.list.getSnapshot().byId[ID]?.retainedBy).toEqual({})
  })

  it('retains a synchronous Gateway Context before catalog discovery without history I/O', async ({ mock, start }) => {
    const b = await bench(mock, start, false)
    const source = b.svc.retainInfo(ID)
    using reference = b.svc.retainAgentScope(ID)
    expect(reference.binding.ctx).toBe(b.svc.scope(ID))
    expect(reference.binding.session.getSnapshot().openState).toBe('cold')
    expect(source.getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { gateway: 1 } })
    expect(b.svc.list.getSnapshot().ids).not.toContain(ID)
    expect(b.svc.list.getSnapshot().byId[ID]).toBeUndefined()
    expect(mock.log.requests(FOLLOW)).toHaveLength(0)
    expect(mock.remote.session.projections).not.toHaveBeenCalled()
    await b.feed(true)
    expect(b.svc.list.getSnapshot().byId[ID]?.retainedBy).toEqual({ gateway: 1 })
  })

  for (const kind of ['remote', 'unexpected'] as const) it(`settles ${kind} initial opening failure through Session state and allows another acquisition after release`, async ({ mock, start }) => {
    const b = await bench(mock, start)
    using local = b.svc.retainAgentScope(ID)
    const binding = local.binding
    const failure = kind === 'remote'
      ? new RemoteError('session/not-found', 'opening failed', { sessionId: ID })
      : new Error('opening failed')
    mock.stream(FOLLOW, followScript(() => Promise.reject(failure)))
    const failed = b.svc.retain(ID, { source: viewSource })
    await expect(failed.ready).resolves.toBe(binding)
    expect(b.svc.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { gateway: 1, referenceTestView: 1 } })
    expect(binding.session.getSnapshot().openState).toBe('error')
    failed.release()
    mock.stream(FOLLOW, followScript(EMPTY_HISTORY))
    using retried = b.svc.retain(ID, { source: workSource })
    await retried.ready
    expect(retried.binding).toBe(binding)
    expect(retried.binding.session.getSnapshot().openState).toBe('open')
  })

  it('cancels only one waiter while another owns the shared initial opening', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const opening = Promise.withResolvers<Awaited<HistoryAnswer>>()
    b.unblock.push(() => { opening.resolve(EMPTY_HISTORY) })
    mock.stream(FOLLOW, followScript(opening.promise))
    const controller = new AbortController()
    const cancelled = b.svc.retain(ID, { source: viewSource, signal: controller.signal })
    const survivor = b.svc.retain(ID, { source: workSource })
    const reason = new Error('waiter cancelled')
    const rejected = expect(cancelled.ready).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    expect(b.svc.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { referenceTestView: 1, referenceTestWork: 1 } })
    cancelled.release()
    expect(b.svc.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { referenceTestWork: 1 } })
    opening.resolve(EMPTY_HISTORY)
    using reference = survivor
    await reference.ready
    expect(reference.binding.session.getSnapshot().openState).toBe('open')
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
  })

  it('rejects a previously cancelled acquisition without creating a generation or publishing counts', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const controller = new AbortController()
    const reason = new Error('acquisition cancelled')
    controller.abort(reason)
    const changed = vi.fn()
    const source = b.svc.retainInfo(ID)
    b.ctx.effect(() => source.subscribe(changed), 'test: reference observation')
    const before = source.getSnapshot()
    expect(() => b.svc.retain(ID, { source: viewSource, signal: controller.signal })).toThrow(reason)
    expect(source.getSnapshot()).toBe(before)
    expect(changed).not.toHaveBeenCalled()
    expect(b.svc.binding(ID)).toBeUndefined()
    expect(mock.log.requests(FOLLOW)).toHaveLength(0)
  })

  it('releases a synchronously cancelled readiness wait through using()', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const controller = new AbortController()
    const failure = new Error('owner ended during acquisition')
    const source = b.svc.retainInfo(ID)
    b.ctx.effect(() => source.subscribe(() => {
      if (source.getSnapshot().referenceCount > 0) controller.abort(failure)
    }), 'test: acquisition cancellation')

    await expect(b.svc.using(ID, { source: viewSource, signal: controller.signal }, () => undefined)).rejects.toBe(failure)

    expect(source.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(b.svc.binding(ID)).toBeUndefined()
  })

  it('withdraws the old generation before an observer retains a same-id replacement', async ({ mock, start }) => {
    const b = await bench(mock, start)
    using old = b.svc.retain(ID, { source: viewSource })
    await old.ready
    const binding = old.binding
    const source = b.svc.retainInfo(ID)
    const replacement = Promise.withResolvers<SessionReference>()
    const stop = source.subscribe(() => {
      if (source.getSnapshot().referenceCount !== 0) return
      stop()
      replacement.resolve(b.svc.retainAgentScope(ID))
    })
    b.ctx.effect(() => stop, 'test: generation replacement')
    old.release()
    using reference = await replacement.promise
    await binding.ctx.fiber.dispose()
    old.release()
    expect(reference.binding).not.toBe(binding)
    expect(reference.binding.session.getSnapshot().openState).toBe('cold')
    expect(b.svc.sessionOf(binding.ctx)).toBeUndefined()
    expect(source.getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { gateway: 1 } })
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
  })

  it('keeps one observable across replacement while late old cleanup cannot change its counts', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const source = b.svc.retainInfo(ID)
    const old = b.svc.retain(ID, { source: viewSource })
    await old.ready
    const binding = old.binding
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    b.unblock.push(() => { resume.resolve(undefined) })
    binding.ctx.effect(() => async () => { entered.resolve(undefined); await resume.promise }, 'test: delayed generation cleanup')
    old.release()
    expect(b.svc.binding(ID)).toBeUndefined()
    expect(source.getSnapshot().referenceCount).toBe(0)
    await entered.promise
    using replacement = b.svc.retain(ID, { source: workSource })
    await replacement.ready
    expect(replacement.binding).not.toBe(binding)
    const snapshot = source.getSnapshot()
    resume.resolve(undefined)
    await binding.ctx.fiber.dispose()
    old.release()
    expect(b.svc.retainInfo(ID)).toBe(source)
    expect(source.getSnapshot()).toBe(snapshot)
    expect(b.svc.sessionOf(binding.ctx)).toBeUndefined()
    expect(b.svc.binding(ID)).toBe(replacement.binding)
  })

  it('invalidates references and zeroes their observable on root disposal', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const reference = b.svc.retain(ID, { source: viewSource })
    await reference.ready
    const source = b.svc.retainInfo(ID)
    await b.ctx.fiber.dispose()
    expect(source.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(() => reference.binding).toThrow('is released')
    reference.release()
    expect(() => b.svc.retain(ID, { source: workSource })).toThrow('Controller is disposed')
    expect(() => b.svc.retainAgentScope(ID)).toThrow('Controller is disposed')
  })
})

describe('ClientSessions.using', () => {
  it('awaits callback settlement before releasing and returns its result', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const entered = Promise.withResolvers<SessionReference>()
    const response = Promise.withResolvers<number>()
    b.unblock.push(() => { response.resolve(7) })
    const using = b.svc.using(ID, { source: workSource, signal: undefined }, (reference) => {
      entered.resolve(reference)
      return response.promise
    })
    const reference = await entered.promise
    expect(b.svc.retainInfo(ID).getSnapshot().referenceCount).toBe(1)
    response.resolve(7)
    await expect(using).resolves.toBe(7)
    expect(b.svc.retainInfo(ID).getSnapshot().referenceCount).toBe(0)
    expect(() => reference.binding).toThrow('is released')
  })

  for (const kind of ['sync', 'async'] as const) it(`releases and propagates a ${kind} callback failure`, async ({ mock, start }) => {
    const b = await bench(mock, start)
    const failure = new Error('callback failed')
    await expect(b.svc.using(ID, { source: workSource }, () => {
      if (kind === 'sync') throw failure
      return Promise.reject(failure)
    })).rejects.toBe(failure)
    expect(b.svc.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
  })

  it('calls the operation after a stateful opening failure', async ({ mock, start }) => {
    const b = await bench(mock, start)
    const operation = vi.fn(() => 7)
    mock.stream(FOLLOW, followScript(() => Promise.reject(new Error('cannot open'))))
    await expect(b.svc.using(ID, { source: workSource }, operation)).resolves.toBe(7)
    expect(operation).toHaveBeenCalledOnce()
    const info: SessionRetainInfo = b.svc.retainInfo(ID).getSnapshot()
    expect(info).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(b.svc.binding(ID)).toBeUndefined()
  })
})
