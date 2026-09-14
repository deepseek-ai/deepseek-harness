/** Registered unary defaults and the carrier's request and outcome log. */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { RemoteMock, ok, openStream, type RemoteTable, type UnaryRuleFn } from '../src/index.ts'

describe('RemoteMock unary answers', () => {
  it('answers a fixed value verbatim and logs args and result with a global seq', async () => {
    const mock = RemoteMock.create().unary('session/list', ok({ items: [] }))
    await expect(mock.dispatch('session/list', [{}])).resolves.toEqual({ ok: true, value: { items: [] } })
    expect(mock.log.calls()).toEqual([{ endpoint: 'session/list', args: [{}], state: 'answered', result: { ok: true, value: { items: [] } }, seq: 1 }])
    expect(mock.log.calls('other/x')).toEqual([])
    expect(mock.modeOf('session/list')).toBe('unary')
    expect(mock.modeOf('other/x')).toBeUndefined()
    expect(mock.endpoints()).toEqual(['$events', 'session/list'])
  })

  it('replaces defaults on registration and table reload, including an explicit undefined answer', async () => {
    const table: RemoteTable = { unary: { 'a/b': 'table' } }
    const mock = RemoteMock.create().load(table)
    await expect(mock.dispatch('a/b', [])).resolves.toBe('table')
    mock.unary('a/b', 'replacement')
    await expect(mock.dispatch('a/b', [])).resolves.toBe('replacement')
    mock.load(table)
    await expect(mock.dispatch('a/b', [])).resolves.toBe('table')
    mock.load({ unary: { 'a/b': undefined } })
    await expect(mock.dispatch('a/b', [])).resolves.toBeUndefined()
    expect(mock.modeOf('a/b')).toBe('unary')
    expect(mock.endpoints()).toEqual(['$events', 'a/b'])
    mock.assertNoUnmatched()
  })

  it('passes positional arguments to native spies and leaves scenario state with the handler', async () => {
    let n = 0
    const handler = vi.fn((request: { id: number }, extra?: string) => {
      expectTypeOf(request).toEqualTypeOf<{ id: number }>()
      expectTypeOf(extra).toEqualTypeOf<string | undefined>()
      return ok(++n)
    })
    const mock = RemoteMock.create()
      .unary('a/b', handler)
      .unary('a/c', () => Promise.resolve(n))
    await expect(mock.dispatch('a/b', [{ id: 1 }])).resolves.toEqual(ok(1))
    await expect(mock.dispatch('a/b', [{ id: 2 }, 'more'])).resolves.toEqual(ok(2))
    await expect(mock.dispatch('a/c', [])).resolves.toBe(2)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(1, { id: 1 })
    expect(handler).toHaveBeenNthCalledWith(2, { id: 2 }, 'more')
  })

  it('keeps raw answers and typed handlers in tables without wrapping their arguments', async () => {
    const handler: UnaryRuleFn<[namespace: string, value: number]> = (namespace, value) => ok({ namespace, value })
    const mock = RemoteMock.create().load({ unary: { 'a/read': handler, 'a/void': undefined, 'a/null': null } })
    await expect(mock.dispatch('a/read', ['settings', 2])).resolves.toEqual(ok({ namespace: 'settings', value: 2 }))
    await expect(mock.dispatch('a/void', [])).resolves.toBeUndefined()
    await expect(mock.dispatch('a/null', [])).resolves.toBeNull()
    mock.unary('a/inferred', (value) => {
      expectTypeOf(value).toEqualTypeOf<unknown>()
      return value
    })
    await expect(mock.dispatch('a/inferred', [3])).resolves.toBe(3)
  })

  it('logs a call when its rule is selected and settles it with the rule: pending, answered, or failed', async () => {
    const gate = Promise.withResolvers<unknown>()
    const mock = RemoteMock.create()
      .unary('a/slow', () => gate.promise)
      .unary('a/throws', () => { throw new Error('sync boom') })
      .unary('a/rejects', () => Promise.reject(new Error('async boom')))
    const slow = mock.dispatch('a/slow', [1])
    expect(mock.log.calls('a/slow')).toEqual([{ endpoint: 'a/slow', args: [1], state: 'pending', result: undefined, seq: 1 }])
    gate.resolve('late')
    await expect(slow).resolves.toBe('late')
    expect(mock.log.calls('a/slow')[0]).toMatchObject({ state: 'answered', result: 'late' })
    await expect(mock.dispatch('a/throws', [])).rejects.toThrow('sync boom')
    await expect(mock.dispatch('a/rejects', [])).rejects.toThrow('async boom')
    expect(mock.log.calls().map(call => [call.endpoint, call.state, call.result instanceof Error ? call.result.message : call.result]))
      .toEqual([['a/slow', 'answered', 'late'], ['a/throws', 'failed', 'sync boom'], ['a/rejects', 'failed', 'async boom']])
    expect(mock.log.unmatched()).toEqual([])
  })

  it('requests() lists the first arg of calls and opens in order, per endpoint or across all but the Gateway\'s own', async () => {
    const mock = RemoteMock.create()
      .unary('session/page', ok(null))
      .stream('session/follow', openStream([]))
    const signal = new AbortController().signal
    await mock.dispatch('session/page', [{ throughSeq: 5 }])
    mock.open('session/follow', [{ address: 'a' }], signal)
    mock.open('$events', [{}], signal)
    await mock.dispatch('session/page', [{ throughSeq: 9 }, 'extra'])
    expect((mock.log.requests('session/page') as { throughSeq: number }[]).map(request => request.throughSeq)).toEqual([5, 9])
    expect(mock.log.requests('session/follow')).toEqual([{ address: 'a' }])
    expect(mock.log.requests('$events')).toEqual([{}])
    expect(mock.log.requests()).toEqual([{ throughSeq: 5 }, { address: 'a' }, { throughSeq: 9 }])
    expect(RemoteMock.create().log.requests()).toEqual([])
  })

  it('loads a whole table', () => {
    const mock = RemoteMock.create().load({
      unary: { 'session/list': ok({ items: [] }), 'a/b': 1 },
      stream: { 'session/control': openStream([{ type: 'baseline' }]) },
    })
    expect(mock.modeOf('session/list')).toBe('unary')
    expect(mock.modeOf('a/b')).toBe('unary')
    expect(mock.modeOf('session/control')).toBe('stream')
    expect(() => RemoteMock.create().load({})).not.toThrow()
    RemoteMock.create().assertNoUnmatched()
  })
})
