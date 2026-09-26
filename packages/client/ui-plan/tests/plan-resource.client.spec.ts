import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { planResourceProvider } from '../src/client/plan-resource.ts'

const address = 'dsh-resource://plan/session/call'
const event = { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'exit_plan_mode', arguments: '{"plan":"# Saved plan"}' } }
const entry = { type: 'event', event }

function setup(records: unknown[], hasMore = false) {
  const closed = vi.fn()
  const follow = vi.fn(async function* () {
    try { yield { type: 'snapshot', cursor: 100, records, hasMore } }
    finally { closed() }
  })
  const page = vi.fn(async () => ({ ok: true, value: { records: [entry], hasMore: false } }))
  const provider = planResourceProvider({ follow, page } as unknown as Parameters<typeof planResourceProvider>[0])
  return { provider, follow, page, closed }
}

async function read(provider: ReturnType<typeof planResourceProvider>, url = address, signal = new AbortController().signal) {
  const values = []
  for await (const value of provider.open(url, { signal })) values.push(value)
  return values
}

describe('plan history resource', () => {
  it('restores the exact invocation and releases its snapshot stream', async () => {
    const b = setup([entry])
    expect(await read(b.provider)).toEqual([{ ok: true, value: { callId: 'call', markdown: '# Saved plan', title: 'Saved plan' } }])
    expect(b.closed).toHaveBeenCalledOnce()
    expect(b.page).not.toHaveBeenCalled()
  })
  it('pages older history with the fixed opening cursor without changing the chat window', async () => {
    const b = setup([{ type: 'event', event: { type: 'user/message', seq: 80, data: {} } }], true)
    expect((await read(b.provider))[0]).toMatchObject({ ok: true })
    expect(b.page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'session' }, throughSeq: 100, beforeSeq: 80 }, expect.any(AbortSignal))
    expect(b.closed).toHaveBeenCalledOnce()
  })
  it.each(['one-shot', 'continuable', 'unknown'] as const)('restores a %s subagent plan with its complete parent address on every page', async (mode) => {
    const b = setup([{ type: 'event', event: { type: 'user/message', seq: 80, data: {} } }], true)
    const address = `dsh-resource://plan/subagent/parent/child/${mode}/call`
    const session = { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode }
    expect(await read(b.provider, address)).toMatchObject([{ ok: true, value: { title: 'Saved plan' } }])
    expect(b.follow).toHaveBeenCalledWith({ address: session }, expect.any(AbortSignal))
    expect(b.page).toHaveBeenCalledWith({ address: session, throughSeq: 100, beforeSeq: 80 }, expect.any(AbortSignal))
    expect(b.closed).toHaveBeenCalledOnce()
  })
  it('reports missing plans and invalid saved addresses', async () => {
    const b = setup([])
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/not-found' } }])
    expect(await read(b.provider, 'dsh-resource://plan/s/%')).toMatchObject([{ ok: false, error: { code: 'plan/invalid-address' } }])
    expect(b.follow).toHaveBeenCalledOnce()
  })
  it('does not publish a response after cancellation', async () => {
    const b = setup([entry])
    const controller = new AbortController()
    controller.abort()
    expect(await read(b.provider, address, controller.signal)).toEqual([])
    expect(b.follow).not.toHaveBeenCalled()
  })
  it('reports stream failures and closes an empty stream', async () => {
    const b = setup([])
    b.follow.mockImplementationOnce(async function* () { throw new Error('connection lost') })
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/read-failed', message: 'connection lost' } }])
    b.follow.mockImplementationOnce(async function* () {})
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/unavailable' } }])
  })
  it('preserves Remote failures from paging and stream reads', async () => {
    const b = setup([{ type: 'event', event: { type: 'user/message', seq: 80, data: {} } }], true)
    const error = new RemoteError('plan/unavailable', 'history unavailable', {})
    b.page.mockResolvedValueOnce({ ok: false, error } as never)
    expect(await read(b.provider)).toEqual([{ ok: false, error }])
    b.follow.mockImplementationOnce(async function* () { throw error })
    expect(await read(b.provider)).toEqual([{ ok: false, error }])
    b.follow.mockImplementationOnce(async function* () { throw 'disconnected' })
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/read-failed', message: 'disconnected' } }])
  })
  it('waits for a snapshot and discards it when cancellation occurs during stream closure', async () => {
    const b = setup([entry])
    const controller = new AbortController()
    b.follow.mockImplementationOnce(async function* () {
      try {
        yield entry as never
        yield { type: 'snapshot', cursor: 100, records: [entry], hasMore: false }
      } finally { b.closed(); controller.abort() }
    })
    expect(await read(b.provider, address, controller.signal)).toEqual([])
    expect(b.closed).toHaveBeenCalledOnce()
    expect(b.page).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'] as const)('discards a page that settles after cancellation: %s', async (settlement) => {
    const b = setup([{ type: 'event', event: { type: 'user/message', seq: 80, data: {} } }], true)
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.page>>>()
    b.page.mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    const result = read(b.provider, address, controller.signal)
    await started.promise
    controller.abort()
    if (settlement === 'resolve') pending.resolve({ ok: true, value: { records: [entry], hasMore: false } })
    else pending.reject(new Error('cancelled'))
    expect(await result).toEqual([])
    expect(b.closed).toHaveBeenCalledOnce()
  })
})
