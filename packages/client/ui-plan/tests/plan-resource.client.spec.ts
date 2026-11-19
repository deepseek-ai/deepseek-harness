import { describe, expect, it, vi } from 'vitest'
import type { SessionEventEntry, SessionEventsPage } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { planResourceProvider } from '../src/client/plan-resource.ts'

const address = 'dsh-resource://plan/session/call'
const event: SessionEventEntry['event'] = {
  type: 'tool/call', seq: 1, time: 1,
  data: { callId: 'call', name: 'exit_plan_mode', arguments: '{"plan":"# Saved plan"}' },
}
const entry: SessionEventEntry = { type: 'event', event }
const olderUserEntry: SessionEventEntry = {
  type: 'event', event: { type: 'user/message', seq: 80, time: 1, data: {} },
}

type SessionRemote = Parameters<typeof planResourceProvider>[0]

function setup(records: SessionEventsPage['records'], hasMore = false) {
  const opening: SessionEventsPage = { cursor: 100, records, hasMore }
  const events = vi.fn<SessionRemote['events']>(async () => ({ ok: true, value: opening }))
  const page = vi.fn<SessionRemote['page']>(async () => ({
    ok: true, value: { cursor: 100, records: [entry], hasMore: false },
  }))
  const provider = planResourceProvider({ events, page })
  return { provider, events, page }
}

async function read(provider: ReturnType<typeof planResourceProvider>, url = address, signal = new AbortController().signal) {
  const values = []
  for await (const value of provider.open(url, { signal })) values.push(value)
  return values
}

describe('plan history resource', () => {
  it('restores the exact invocation from one page', async () => {
    const b = setup([entry])
    expect(await read(b.provider)).toEqual([{ ok: true, value: { callId: 'call', markdown: '# Saved plan', title: 'Saved plan' } }])
    expect(b.events).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'session' } }, expect.any(AbortSignal))
    expect(b.page).not.toHaveBeenCalled()
  })
  it('pages older history with the fixed opening cursor without changing the chat window', async () => {
    const b = setup([olderUserEntry], true)
    expect((await read(b.provider))[0]).toMatchObject({ ok: true })
    expect(b.events).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'session' } }, expect.any(AbortSignal))
    expect(b.page).toHaveBeenLastCalledWith({ address: { kind: 'session', sessionId: 'session' }, throughSeq: 100, beforeSeq: 80 }, expect.any(AbortSignal))
  })
  it.each(['one-shot', 'continuable', 'unknown'] as const)('restores a %s subagent plan with its complete parent address on every page', async (mode) => {
    const b = setup([olderUserEntry], true)
    const url = `dsh-resource://plan/subagent/parent/child/${mode}/call`
    const session = { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode }
    expect(await read(b.provider, url)).toMatchObject([{ ok: true, value: { title: 'Saved plan' } }])
    expect(b.events).toHaveBeenCalledWith({ address: session }, expect.any(AbortSignal))
    expect(b.page).toHaveBeenLastCalledWith({ address: session, throughSeq: 100, beforeSeq: 80 }, expect.any(AbortSignal))
  })
  it('reports missing plans and invalid saved addresses', async () => {
    const b = setup([])
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/not-found' } }])
    expect(await read(b.provider, 'dsh-resource://plan/s/%')).toMatchObject([{ ok: false, error: { code: 'plan/invalid-address' } }])
    expect(b.events).toHaveBeenCalledOnce()
  })
  it('does not publish a response after cancellation', async () => {
    const b = setup([entry])
    const controller = new AbortController()
    controller.abort()
    expect(await read(b.provider, address, controller.signal)).toEqual([])
    expect(b.events).not.toHaveBeenCalled()
  })
  it('reports an opening events failure with its Remote code', async () => {
    const b = setup([])
    const error = new RemoteError('plan/read-failed', 'connection lost', {})
    b.events.mockResolvedValueOnce({ ok: false, error })
    expect(await read(b.provider)).toEqual([{ ok: false, error }])
  })
  it('preserves Remote failures from paging', async () => {
    const b = setup([olderUserEntry], true)
    const error = new RemoteError('plan/read-failed', 'history unavailable', {})
    b.page.mockResolvedValueOnce({ ok: true, value: { cursor: 100, records: [olderUserEntry], hasMore: true } })
    b.page.mockResolvedValueOnce({ ok: false, error })
    expect(await read(b.provider)).toEqual([{ ok: false, error }])
  })
  it('reports a thrown page failure as plan/read-failed', async () => {
    const b = setup([olderUserEntry], true)
    b.page.mockResolvedValueOnce({ ok: true, value: { cursor: 100, records: [olderUserEntry], hasMore: true } })
    b.page.mockRejectedValueOnce(new Error('connection lost'))
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/read-failed', message: 'connection lost' } }])
  })
  it('stringifies a non-Error page failure', async () => {
    const b = setup([olderUserEntry], true)
    b.page.mockResolvedValueOnce({ ok: true, value: { cursor: 100, records: [olderUserEntry], hasMore: true } })
    b.page.mockRejectedValueOnce('disconnected')
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/read-failed', message: 'disconnected' } }])
  })
  it('preserves a Remote failure thrown by page', async () => {
    const b = setup([olderUserEntry], true)
    const error = new RemoteError('plan/read-failed', 'history unavailable', {})
    b.page.mockResolvedValueOnce({ ok: true, value: { cursor: 100, records: [olderUserEntry], hasMore: true } })
    b.page.mockRejectedValueOnce(error)
    expect(await read(b.provider)).toEqual([{ ok: false, error }])
  })
  it('discards an opening page that settles after cancellation', async () => {
    const b = setup([entry])
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.events>>>()
    b.events.mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    const result = read(b.provider, address, controller.signal)
    await started.promise
    controller.abort()
    pending.resolve({ ok: true, value: { cursor: 100, records: [entry], hasMore: false } })
    expect(await result).toEqual([])
  })
  it.each(['resolve', 'reject'] as const)('discards an older page that settles after cancellation: %s', async (settlement) => {
    const b = setup([olderUserEntry], true)
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.page>>>()
    b.page.mockResolvedValueOnce({ ok: true, value: { cursor: 100, records: [olderUserEntry], hasMore: true } })
    b.page.mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    const result = read(b.provider, address, controller.signal)
    await started.promise
    controller.abort()
    if (settlement === 'resolve') pending.resolve({ ok: true, value: { cursor: 100, records: [entry], hasMore: false } })
    else pending.reject(new Error('cancelled'))
    expect(await result).toEqual([])
  })
})
