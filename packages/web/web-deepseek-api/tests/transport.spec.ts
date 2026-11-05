import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import { customGuidance } from './guidance.ts'
import {
  dispatchDeepSeekWeb, hasDeepSeekWebCredential, isDeepSeekWebAuthReady,
  type DeepSeekWebApiKey, type DeepSeekWebAuthSource,
} from '../src/transport.ts'
const API_BASE = 'https://api.deepseek.test/v1/tools'
const ACCOUNT_BASE = 'https://account.deepseek.test/v1/tools'
/** An API-key source on {@link API_BASE}. */
function keySource(key: DeepSeekWebApiKey = 'ds-key'): DeepSeekWebAuthSource {
  return { kind: 'api-key', baseURL: API_BASE, key }
}
/** A referenced key whose presence check and read are the given functions. */
function keyRef(resolve: () => Promise<string | undefined>, configured: () => Promise<boolean> = async () => true): DeepSeekWebApiKey {
  return { ref: credentialRef('TEST_KEY'), configured, resolve }
}
/** An account source on {@link ACCOUNT_BASE}. */
function accountSource(
  resolveToken: (endpoint: string) => Promise<string | undefined>, rejectToken: (token: string) => Promise<void> = async () => {},
): DeepSeekWebAuthSource {
  return { kind: 'account', baseURL: ACCOUNT_BASE, resolveToken, rejectToken }
}
const misconfigured: DeepSeekWebAuthSource = { kind: 'misconfigured', message: 'route settings do not resolve' }
/** Search once with the given sources, in order. */
function search(
  sources: readonly DeepSeekWebAuthSource[], signal?: AbortSignal,
  extra: { recordRequest?: (endpoint: string) => void; missingCredentialMessage?: string } = {},
) {
  const { recordRequest, missingCredentialMessage } = extra
  return dispatchDeepSeekWeb({ sources, ...missingCredentialMessage === undefined ? {} : { missingCredentialMessage } }, {
    path: '/search', body: { query: 'q' }, decode: value => value,
    ...recordRequest === undefined ? {} : { recordRequest },
    apiKeyHeaders: key => ({ 'x-api-key': key }),
    guidance: customGuidance('search'),
  }, signal)
}
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}
async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try { await operation } catch (error) { if (error instanceof WebError) return error; throw error }
  throw new Error('expected request to reject')
}
/** Stub fetch and read back the endpoint and headers of each call. */
function captureFetch(response: () => Response = () => jsonResponse({})) {
  // The provider always passes the endpoint as a string.
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => response())
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    sent: () => fetchMock.mock.calls.map(([url, init]) => ({ url, headers: (init?.headers ?? {}) as Record<string, string> })),
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek web credential order', () => {
  it('sends only the account token to its own base when the account comes first, without reading the key', async () => {
    const { sent } = captureFetch()
    const resolveToken = vi.fn(async (_endpoint: string) => 'account-token')
    const resolve = vi.fn(async () => 'resolved-key')
    await search([accountSource(resolveToken), keySource(keyRef(resolve))])
    const [request] = sent()
    expect(sent()).toHaveLength(1)
    expect(request?.url).toBe(`${ACCOUNT_BASE}/search`)
    expect(resolveToken).toHaveBeenCalledExactlyOnceWith(request?.url)
    expect(resolve).not.toHaveBeenCalled()
    expect(request?.headers['x-dsh-auth-token']).toBe('account-token')
    expect(request?.headers).not.toHaveProperty('x-api-key')
    expect(request?.headers).not.toHaveProperty('authorization')
  })

  it('sends only the key to its own base when the key comes first, without reading the account', async () => {
    const { sent } = captureFetch()
    const resolveToken = vi.fn(async () => 'account-token')
    const resolve = vi.fn(async () => 'resolved-key')
    const configured = vi.fn(async () => true)
    await search([keySource(keyRef(resolve, configured)), accountSource(resolveToken)])
    const [request] = sent()
    expect(sent()).toHaveLength(1)
    expect(request?.url).toBe(`${API_BASE}/search`)
    expect(request?.headers).toMatchObject({ 'authorization': 'Bearer resolved-key', 'x-api-key': 'resolved-key' })
    expect(request?.headers).not.toHaveProperty('x-dsh-auth-token')
    expect(resolve).toHaveBeenCalledOnce()
    expect(configured).not.toHaveBeenCalled()
    expect(resolveToken).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])('sends the account token when the referenced key first in order resolves %j', async (key) => {
    const { sent } = captureFetch()
    await search([keySource(keyRef(async () => key)), accountSource(async () => 'account-token')])
    expect(sent().map(row => [row.url, row.headers['x-dsh-auth-token'], row.headers.authorization]))
      .toEqual([[`${ACCOUNT_BASE}/search`, 'account-token', undefined]])
  })

  it.each([undefined, ''])('sends the key to its own base when the account first in order resolves %j', async (token) => {
    const { sent } = captureFetch()
    await search([accountSource(async () => token), keySource()])
    expect(sent().map(row => [row.url, row.headers['x-api-key'], row.headers['x-dsh-auth-token']]))
      .toEqual([[`${API_BASE}/search`, 'ds-key', undefined]])
  })

  it.each<[string, readonly DeepSeekWebAuthSource[]]>([
    ['no sources', []],
    ['an empty literal key', [keySource('')]],
    ['a missing referenced key and no account token', [keySource(keyRef(async () => undefined)), accountSource(async () => undefined)]],
  ])('fails with the caller diagnostic and sends nothing for %s', async (_label, sources) => {
    const { fetchMock } = captureFetch()
    await expect(search(sources, undefined, { missingCredentialMessage: 'no credential for this search' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING', message: 'no credential for this search' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names no credential without a caller diagnostic', async () => {
    captureFetch()
    await expect(search([])).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING', message: 'DeepSeek web access has no credential to send',
    })
  })

  it('sends an earlier present source without reaching a misconfigured one', async () => {
    const { sent } = captureFetch()
    await search([accountSource(async () => 'account-token'), misconfigured])
    expect(sent().map(row => row.url)).toEqual([`${ACCOUNT_BASE}/search`])
  })

  it.each<[string, readonly DeepSeekWebAuthSource[]]>([
    ['first', [misconfigured, keySource()]],
    ['after an absent account token', [accountSource(async () => undefined), misconfigured, keySource()]],
  ])('fails with WEB_PROVIDER_MISCONFIGURED when a misconfigured source is reached %s', async (_label, sources) => {
    const { fetchMock } = captureFetch()
    await expect(search(sources)).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED', message: 'route settings do not resolve' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an account read failure to WEB_PROVIDER_ERROR without reading the next source', async () => {
    const { fetchMock } = captureFetch()
    const resolve = vi.fn(async () => 'resolved-key')
    await expect(search([accountSource(() => Promise.reject(new Error('account storage failed'))), keySource(keyRef(resolve))]))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek web credential resolution failed: Error: account storage failed',
      }))
    expect(resolve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([undefined, new AbortController().signal])('keeps a key read failure as the cause without reading the account (signal %#)', async (signal) => {
    const { fetchMock } = captureFetch()
    const failure = new WebError('malformed key', 'WEB_PROVIDER_MISCONFIGURED')
    const resolveToken = vi.fn(async () => 'account-token')
    const error = await rejectedWebError(search([keySource(keyRef(() => Promise.reject(failure))), accountSource(resolveToken)], signal))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: `DeepSeek web credential resolution failed: ${String(failure)}` })
    expect(error.cause).toBe(failure)
    expect(resolveToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('DeepSeek web credential availability and readiness', () => {
  it.each<[boolean, readonly DeepSeekWebAuthSource[]]>([
    [false, []],
    [false, [keySource('')]],
    [true, [keySource()]],
    [true, [keySource(keyRef(async () => undefined))]],
    [true, [accountSource(async () => undefined)]],
    [true, [misconfigured]],
  ])('reports a source to try as %s without reading credentials', (expected, sources) => {
    expect(hasDeepSeekWebCredential({ sources })).toBe(expected)
  })

  it('checks a referenced key for presence without reading it, and asks the account for the operation endpoint', async () => {
    const { fetchMock } = captureFetch()
    const resolve = vi.fn(async () => 'resolved-key')
    const configured = vi.fn(async () => false)
    const resolveToken = vi.fn(async (_endpoint: string) => 'account-token')
    expect(await isDeepSeekWebAuthReady({ sources: [keySource(keyRef(resolve, configured)), accountSource(resolveToken)] }, '/fetch')).toBe(true)
    expect(configured).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
    expect(resolveToken).toHaveBeenCalledExactlyOnceWith(`${ACCOUNT_BASE}/fetch`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each<[string, readonly DeepSeekWebAuthSource[], boolean]>([
    ['no sources', [], false],
    ['an empty literal key', [keySource('')], false],
    ['a literal key', [keySource()], true],
    ['a configured key before the account', [keySource(keyRef(async () => undefined)), accountSource(async () => undefined)], true],
    ['neither credential', [accountSource(async () => ''), keySource(keyRef(async () => undefined, async () => false))], false],
  ])('answers for %s', async (_label, sources, expected) => {
    expect(await isDeepSeekWebAuthReady({ sources }, '/search')).toBe(expected)
  })

  it.each<[string, DeepSeekWebAuthSource]>([
    ['a misconfigured source', misconfigured],
    ['an unreadable account grant', accountSource(() => Promise.reject(new Error('grant unreadable')))],
    ['an unreadable credential store', keySource(keyRef(async () => 'key', () => Promise.reject(new Error('store locked'))))],
  ])('answers false at %s without reading later sources', async (_label, source) => {
    const resolveToken = vi.fn(async () => 'account-token')
    expect(await isDeepSeekWebAuthReady({ sources: [source, accountSource(resolveToken)] }, '/search')).toBe(false)
    expect(resolveToken).not.toHaveBeenCalled()
  })
})

describe('DeepSeek web account authentication', () => {
  it('replaces endpoint guidance with sign-in guidance when DeepSeek rejects the account token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'invalid token' } }, { status: 401 })))
    const error = await rejectedWebError(search([accountSource(async () => 'account-token')]))
    expect(error).toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'DeepSeek API error (HTTP 401): invalid token\n\n'
        + 'DeepSeek rejected the account sign-in used for this web request. '
        + 'Guide the user to sign in to DeepSeek again; the endpoint does not need changing.',
    })
  })

  it.each([false, true])('invalidates the sent account token on 401 and preserves the HTTP error when removal fails: %s', async (fails) => {
    const rejectToken = vi.fn(async (_token: string) => { if (fails) throw new Error('storage failed') })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid token' }, { status: 401 })))
    const error = await rejectedWebError(search([accountSource(async () => 'sent-token', rejectToken)]))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('HTTP 401')
    expect(rejectToken).toHaveBeenCalledExactlyOnceWith('sent-token')
  })

  it('sends one request and tries no later source when the account token is rejected', async () => {
    const { fetchMock } = captureFetch(() => jsonResponse({}, { status: 401 }))
    const resolve = vi.fn(async () => 'resolved-key')
    await expect(search([accountSource(async () => 'sent-token'), keySource(keyRef(resolve))])).rejects.toThrow('HTTP 401')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([401, 429])('sends one request and tries no later source when the key gets HTTP %i', async (status) => {
    const { fetchMock } = captureFetch(() => jsonResponse({}, { status }))
    const resolveToken = vi.fn(async () => 'account-token')
    const rejectToken = vi.fn(async () => {})
    await expect(search([keySource(), accountSource(resolveToken, rejectToken)])).rejects.toThrow(`HTTP ${status}`)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(resolveToken).not.toHaveBeenCalled()
    expect(rejectToken).not.toHaveBeenCalled()
  })

  it('does not invalidate a token for status 403', async () => {
    const rejectToken = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 403 })))
    await expect(search([accountSource(async () => 'account-token', rejectToken)])).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(rejectToken).not.toHaveBeenCalled()
  })

  it('retains the HTTP failure when account invalidation cancels the requesting Session', async () => {
    const controller = new AbortController()
    const response = jsonResponse({ error: 'invalid token' }, { status: 401 })
    const json = response.json.bind(response)
    vi.spyOn(response, 'json').mockImplementation(async (): Promise<unknown> => {
      controller.signal.throwIfAborted()
      const body: unknown = await json()
      return body
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const error = await rejectedWebError(search(
      [accountSource(async () => 'sent-token', async () => { controller.abort(new Error('signed out')) })], controller.signal,
    ))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('HTTP 401')
    expect(controller.signal.aborted).toBe(true)
  })

  it('invalidates the sent account token once when cancellation interrupts reading the 401 body', async () => {
    const controller = new AbortController()
    const response = jsonResponse({ error: 'invalid token' }, { status: 401 })
    vi.spyOn(response, 'json').mockImplementation(async (): Promise<unknown> => {
      controller.abort(new Error('caller stopped'))
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const rejectToken = vi.fn(async (_token: string) => {})
    const error = await rejectedWebError(search([accountSource(async () => 'sent-token', rejectToken)], controller.signal))
    expect(error.code).toBe('WEB_ABORTED')
    expect(rejectToken).toHaveBeenCalledExactlyOnceWith('sent-token')
  })

  it('reports cancellation during an API-key 401 body read without invalidating a token', async () => {
    const controller = new AbortController()
    const response = jsonResponse({}, { status: 401 })
    vi.spyOn(response, 'json').mockImplementation(async (): Promise<unknown> => {
      controller.abort(new Error('caller stopped'))
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const rejectToken = vi.fn(async (_token: string) => {})
    const error = await rejectedWebError(search([accountSource(async () => undefined, rejectToken), keySource()], controller.signal))
    expect(error.code).toBe('WEB_ABORTED')
    expect(rejectToken).not.toHaveBeenCalled()
  })

  it('keeps endpoint guidance for other account-authenticated HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 503 })))
    const error = await rejectedWebError(search([accountSource(async () => 'account-token')]))
    expect(error.message).toContain('If that endpoint is not intended')
  })

  it('maps a synchronous resolver throw to WEB_PROVIDER_ERROR', async () => {
    const { fetchMock } = captureFetch()
    await expect(search([accountSource(() => { throw new Error('account service threw') })]))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek web credential resolution failed: Error: account service threw',
      }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports cancellation before a missing credential when no source exists', async () => {
    const { fetchMock } = captureFetch()
    await expect(search([], AbortSignal.abort(new Error('caller stopped'))))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts neither resolver for a pre-aborted call', async () => {
    const resolveToken = vi.fn(async () => 'account-token')
    const resolve = vi.fn(async () => 'resolved-key')
    await expect(search([accountSource(resolveToken), keySource(keyRef(resolve))], AbortSignal.abort(new Error('caller stopped'))))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveToken).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not start API-key resolution after cancellation during account resolution', async () => {
    const controller = new AbortController()
    const resolve = vi.fn(() => Promise.reject(new Error('must not run')))
    await expect(search([
      accountSource(async () => { controller.abort(new Error('caller stopped')); return undefined }), keySource(keyRef(resolve)),
    ], controller.signal)).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('aborts while the account resolver remains pending', async () => {
    const { fetchMock } = captureFetch()
    const controller = new AbortController()
    const pending = search([accountSource(() => new Promise<string>(() => {}))], controller.signal)
    controller.abort(new Error('deadline'))
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('DeepSeek web cancellation and failures', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolve = vi.fn(async () => 'late-key')
    const recordRequest = vi.fn()
    const { fetchMock } = captureFetch()
    await expect(search([keySource(keyRef(resolve))], AbortSignal.abort(new Error('caller stopped')), { recordRequest }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolve).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const resolve = vi.fn(() => new Promise<string>(() => {}))
    const recordRequest = vi.fn()
    const { fetchMock } = captureFetch()
    const controller = new AbortController()
    const pending = search([keySource(keyRef(resolve))], controller.signal, { recordRequest })
    controller.abort(new Error('deadline'))
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolve).toHaveBeenCalledOnce()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves credentials under an active cancellation signal', async () => {
    const { sent } = captureFetch(() => jsonResponse({ truncated: false }))
    await expect(search([keySource(keyRef(async () => 'resolved-key'))], new AbortController().signal))
      .resolves.toMatchObject({ truncated: false })
    expect(sent()[0]?.headers['x-api-key']).toBe('resolved-key')
  })

  it('maps a credential resolver rejection under an active signal to WEB_PROVIDER_ERROR', async () => {
    await expect(search([keySource(keyRef(() => Promise.reject(new Error('credential backend failed'))))], new AbortController().signal))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek web credential resolution failed: Error: credential backend failed',
      }))
  })

  it('maps a non-Error credential rejection under an active signal to WEB_PROVIDER_ERROR with the value as its cause', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    const rejectString = () => Promise.reject('backend down')
    const error = await rejectedWebError(search([keySource(keyRef(rejectString))], new AbortController().signal))
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'DeepSeek web credential resolution failed: Error: backend down' })
    expect(error.cause).toMatchObject({ cause: 'backend down' })
  })

  it('observes cancellation triggered synchronously by credential resolution', async () => {
    const controller = new AbortController()
    const { fetchMock } = captureFetch()
    await expect(search([keySource(keyRef(() => {
      controller.abort(new Error('resolver cancelled caller'))
      return Promise.resolve('unused-key')
    }))], controller.signal)).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    await expect(search([keySource()]))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek API error (HTTP 429): rate limited\n\n'
          + 'The web request used endpoint "https://api.deepseek.test/v1/tools/search". '
          + 'Search sends the API key under web-deepseek-api.searchApiKeyEnv to web-deepseek-api.searchBaseURL. If that '
          + 'endpoint is not intended, guide the user to correct web-deepseek-api.searchBaseURL and '
          + 'web-deepseek-api.searchApiKeyEnv, or to remove both so Search uses the DeepSeek credential of the conversation. '
          + 'Only the user should choose or change the endpoint.',
      }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    const error = await rejectedWebError(search([keySource()]))
    expect(error.message).toContain('DeepSeek API error (HTTP 400): bad request')
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    const error = await rejectedWebError(search([keySource()]))
    expect(error.message).toContain('DeepSeek API error (HTTP 503)')
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    const error = await rejectedWebError(search([keySource()]))
    expect(error.message).toContain('DeepSeek API error (HTTP 500)')
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(search([keySource()]))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a custom abort reason to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      })))
    const pending = search([keySource()], controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(search([keySource()]))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = new Response('', { status: 200 })
    vi.spyOn(body, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(search([keySource()]))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = new Response('', { status: 500 })
    vi.spyOn(body, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(search([keySource()]))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    const error = await rejectedWebError(search([keySource()]))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('The web request used endpoint "https://api.deepseek.test/v1/tools/search".')
  })
})
