/**
 * Application access token: caching, the `expires_in − 60 s` refresh window, single-flight refresh and the
 * resilience rules. No network: the poster is a stub and the clock is injected.
 */
import { describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import { AccessToken, DEFAULT_TOKEN_URL, type GetAppAccessTokenRequest, type GetAppAccessTokenResult } from '@deepseek-ai/cordis-plugin-im-adapter-qq'

interface PostCall {
  url: string
  data: GetAppAccessTokenRequest
}

/** Token client with a fake clock and a scripted poster. */
function createToken(answer: () => Promise<GetAppAccessTokenResult> = async () => ({ access_token: 'token-1', expires_in: 100 })) {
  let now = 0
  const calls: PostCall[] = []
  const post = vi.fn(async (url: string, data: GetAppAccessTokenRequest) => {
    calls.push({ url, data })
    return await answer()
  })
  const token = new AccessToken({
    appId: '102106848',
    secret: 'app-secret',
    now: () => now,
    post,
  })
  return {
    token,
    calls,
    post,
    advance(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
  }
}

describe('AccessToken', () => {
  it('posts appId + clientSecret to the default endpoint and caches the answer', async () => {
    const { token, calls, post } = createToken()
    expect(token.token).toBeUndefined()
    expect(token.expiresAt).toBeUndefined()

    await expect(token.get()).resolves.toBe('token-1')
    await expect(token.get()).resolves.toBe('token-1')

    expect(post).toHaveBeenCalledOnce()
    expect(calls[0]).toEqual({ url: DEFAULT_TOKEN_URL, data: { appId: '102106848', clientSecret: 'app-secret' } })
    expect(token.expiresAt).toBe(100 * 1000)
  })

  it('honours a custom token endpoint', async () => {
    const post = vi.fn(async () => ({ access_token: 'token-1', expires_in: 100 }))
    const token = new AccessToken({ appId: 'a', secret: 's', tokenUrl: 'https://api.bot.qq.com/token', post })
    await token.get()
    expect(post).toHaveBeenCalledWith('https://api.bot.qq.com/token', { appId: 'a', clientSecret: 's' })
  })

  it('shares one refresh between concurrent callers', async () => {
    const { token, post } = createToken()
    const results = await Promise.all([token.get(), token.get(), token.get()])
    expect(results).toEqual(['token-1', 'token-1', 'token-1'])
    expect(post).toHaveBeenCalledOnce()
  })

  it('refreshes 60 s before expires_in, not after', async () => {
    const { token, post, advance } = createToken()
    await token.get()

    advance(39_999)
    await token.get()
    expect(post).toHaveBeenCalledOnce()

    // ttl 100 s ⇒ the refresh window opens at 40 s.
    advance(1)
    await token.get()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('parses a string expires_in like the platform sometimes sends', async () => {
    const { token, post, advance } = createToken(async () => ({ access_token: 'token-1', expires_in: '100' }))
    await token.get()
    advance(39_999)
    await token.get()
    expect(post).toHaveBeenCalledOnce()
    advance(1)
    await token.get()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('falls back to the platform default lifetime of 2 h when expires_in is absent', async () => {
    const { token, post, advance } = createToken(async () => ({ access_token: 'token-1' }))
    await token.get()
    advance(2 * 60 * 60 * 1000 - 60_001)
    await token.get()
    expect(post).toHaveBeenCalledOnce()
    advance(1)
    await token.get()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('rejects with a retryable PlatformError when no token can be obtained, then retries', async () => {
    const failure = new Error('network down')
    const { token, post } = createToken(async () => {
      throw failure
    })
    const error = await token.get().catch(error => error)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('retryable')
    expect(error.cause).toBe(failure)
    expect(token.token).toBeUndefined()

    // The failed attempt must not stay in flight.
    await expect(token.get()).rejects.toBeInstanceOf(PlatformError)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('keeps using a still-valid token when a refresh fails', async () => {
    let fail = false
    const { token, advance } = createToken(async () => {
      if (fail) throw new Error('too many requests')
      return { access_token: 'token-1', expires_in: 100 }
    })
    await token.get()

    fail = true
    advance(41_000) // inside the refresh window, but the cached token is still accepted
    await expect(token.get()).resolves.toBe('token-1')

    advance(60_000) // now the cached token is dead too
    await expect(token.get()).rejects.toBeInstanceOf(PlatformError)
  })

  it('rejects a token answer without access_token instead of caching undefined', async () => {
    const { token } = createToken(async () => ({ expires_in: 100 }))
    const error = await token.get().catch(error => error)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('retryable')
    expect(error.published).toBe('no')
    expect(token.token).toBeUndefined()
  })

  it('marks transport errors and empty token responses as published: no', async () => {
    const net = createToken(() => Promise.reject(new Error('ECONNRESET')))
    await expect(net.token.get()).rejects.toMatchObject({ kind: 'retryable', published: 'no' })

    const passthrough = createToken(() => Promise.reject(new PlatformError('rate-limit', '429')))
    await expect(passthrough.token.get()).rejects.toMatchObject({ kind: 'rate-limit', published: 'no' })

    const empty = createToken(() => Promise.resolve({ access_token: '', expires_in: 0 }))
    await expect(empty.token.get()).rejects.toMatchObject({ kind: 'retryable', published: 'no' })

    const rateLimited = createToken(() => Promise.reject(Object.assign(new Error('Too Many Requests'), {
      response: new Response(null, { status: 429, headers: { 'retry-after': '4' } }),
    })))
    await expect(rateLimited.token.get()).rejects.toMatchObject({
      kind: 'rate-limit',
      published: 'no',
      retryAfterMs: 4000,
    })

    const unauthorized = createToken(() => Promise.reject(Object.assign(new Error('Unauthorized'), {
      response: new Response(null, { status: 401 }),
    })))
    await expect(unauthorized.token.get()).rejects.toMatchObject({
      kind: 'permission',
      published: 'no',
    })

    const undiciLike429 = createToken(() => Promise.reject(Object.assign(new Error('Too Many Requests'), {
      response: { status: 429, headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '2' : null } },
    })))
    await expect(undiciLike429.token.get()).rejects.toMatchObject({
      kind: 'rate-limit',
      published: 'no',
      retryAfterMs: 2000,
    })
  })

  it('refetches after invalidate()', async () => {
    const { token, post } = createToken()
    await token.get()
    token.invalidate()
    expect(token.token).toBeUndefined()
    expect(token.expiresAt).toBeUndefined()
    await token.get()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('honours an already aborted signal', async () => {
    const { token, post } = createToken()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const error = await token.get(controller.signal).catch(err => err)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error).toMatchObject({ kind: 'fatal', published: 'no', message: 'cancelled' })
    expect(post).not.toHaveBeenCalled()
  })

  it('rejects a caller aborted mid-refresh without cancelling a concurrent caller sharing the refresh', async () => {
    let releaseRefresh!: (result: GetAppAccessTokenResult) => void
    const refreshGate = new Promise<GetAppAccessTokenResult>((resolve) => { releaseRefresh = resolve })
    const { token, post } = createToken(() => refreshGate)

    const callerA = new AbortController()
    const callerB = new AbortController()
    const pendingA = token.get(callerA.signal)
    const pendingB = token.get(callerB.signal)
    expect(post).toHaveBeenCalledOnce()

    callerA.abort()
    const errorA = await pendingA.catch(err => err)
    expect(errorA).toBeInstanceOf(PlatformError)
    expect(errorA).toMatchObject({ kind: 'fatal', published: 'no' })

    releaseRefresh({ access_token: 'token-shared', expires_in: 100 })
    await expect(pendingB).resolves.toBe('token-shared')
    expect(post).toHaveBeenCalledOnce()
  })
})
