/** Resource address validation and the independent child-reference lifetime. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as applyResources } from '@deepseek-ai/dsh-client-resources/client'
import { parseSidechatAddress, sidechatAddress, sidechatResourceProvider } from '../src/client/resource.ts'

describe('sidechat resources', () => {
  it.each([
    new Error('sessions.retain: unknown session child'),
    new RemoteError('session/not-found', 'Session no longer exists', { sessionId: 'child' as SessionId }),
    'Session Controller is disposed',
  ])('reports acquisition failure through the resource consumer: %s', async (error) => {
    const ctx = new Context()
    ctx.provide('slots', { provideRoot: () => {} } as never)
    applyResources(ctx)
    const unregister = ctx.resources.register(sidechatResourceProvider({ retain: () => { throw error } }))
    const source = ctx.resources.source(sidechatAddress('child' as SessionId))
    const unsubscribe = source.subscribe(() => {})
    try {
      await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
      expect(source.getSnapshot()).toMatchObject({
        value: undefined,
        failure: {
          code: remoteErrorOf(error)?.code ?? 'gateway/internal',
          message: error instanceof Error ? error.message : error,
        },
      })
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('round trips escaped Session identities and rejects malformed input', () => {
    const id = 'session/a b' as SessionId
    expect(parseSidechatAddress(sidechatAddress(id))).toBe(id)
    for (const value of ['sidebar://sidechat', 'dsh-resource://sidechat/session/',
      'dsh-resource://sidechat/session/a/b', 'dsh-resource://sidechat/session/%ZZ',
      'dsh-resource://sidechat/session/a?b']) expect(parseSidechatAddress(value)).toBeUndefined()
  })

  it('releases its independent reference when the tab resource closes', async () => {
    const abort = new AbortController()
    const release = vi.fn()
    const reference = { release: () => { release() } } as SessionReference
    const retain = vi.fn<ISessions['retain']>().mockReturnValue(reference)
    const provider = sidechatResourceProvider({ retain })
    const stream = provider.open(sidechatAddress('child' as SessionId), { signal: abort.signal })[Symbol.asyncIterator]()
    try {
      expect(await stream.next()).toMatchObject({ value: { ok: true, value: reference } })
      expect(retain).toHaveBeenCalledWith('child', { source: 'sidechat', facets: { conversation: true }, signal: abort.signal })
      const waiting = stream.next()
      abort.abort()
      expect(await waiting).toMatchObject({ done: true })
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      abort.abort()
      await stream.return?.()
    }
  })

  it('does not retain an already cancelled resource and reports invalid addresses as failed frames', async () => {
    const retain = vi.fn<ISessions['retain']>()
    const provider = sidechatResourceProvider({ retain })
    const signal = AbortSignal.abort()
    const cancelled = provider.open(sidechatAddress('child' as SessionId), { signal })[Symbol.asyncIterator]()
    expect(await cancelled.next()).toMatchObject({ done: true })
    expect(retain).not.toHaveBeenCalled()
    const invalid = provider.open('invalid', { signal: new AbortController().signal })[Symbol.asyncIterator]()
    expect(await invalid.next()).toMatchObject({ done: false, value: {
      ok: false, error: { code: 'gateway/bad-request', message: 'sidechat: invalid resource address "invalid"' },
    } })
    expect(await invalid.next()).toMatchObject({ done: true })
    expect(retain).not.toHaveBeenCalled()
  })

  it('releases when cancellation arrives while the initial frame is consumed', async () => {
    const abort = new AbortController()
    const release = vi.fn()
    const provider = sidechatResourceProvider({ retain: () => ({ release: () => { release() } } as SessionReference) })
    const stream = provider.open(sidechatAddress('child' as SessionId), { signal: abort.signal })[Symbol.asyncIterator]()
    await stream.next()
    abort.abort()
    expect(await stream.next()).toMatchObject({ done: true })
    expect(release).toHaveBeenCalledTimes(1)
  })
})
