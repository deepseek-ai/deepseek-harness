import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { dispatchDeepSeekWeb, type DeepSeekWebAuth } from '../src/transport.ts'
const options = { apiKey: 'ds-key', baseURL: 'https://api.deepseek.test/anthropic/v1' }
function searchProvider(auth: DeepSeekWebAuth & { baseURL: string; recordRequest?: (endpoint: string) => void }) {
  return { search: (body: { query: string }, signal?: AbortSignal) => dispatchDeepSeekWeb(auth, {
    endpoint: `${auth.baseURL}/messages`, body, decode: value => value,
    ...auth.recordRequest === undefined ? {} : { recordRequest: auth.recordRequest },
    apiKeyHeaders: key => ({ 'x-api-key': key }),
    guidance: { subject: 'Search', plugin: 'web-search-deepseek', field: 'baseURL', label: 'Messages API base URL', page: 'Web search' },
  }, signal) }
}
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}
async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try { await operation } catch (error) { if (error instanceof WebError) return error; throw error }
  throw new Error('expected request to reject')
}
afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek web account authentication', () => {
  /** Stub fetch and read back the endpoint and headers of its first call. */
  function captureFetch() {
    // The provider always passes the endpoint as a string.
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    return {
      fetchMock,
      first: () => {
        const [url, init] = fetchMock.mock.calls[0] ?? []
        return { url: url ?? '', headers: (init?.headers ?? {}) as Record<string, string> }
      },
    }
  }

  it('sends only the account token for the dispatched endpoint, ahead of a configured key', async () => {
    const { first } = captureFetch()
    const resolveAccountToken = vi.fn(async (_endpoint: string) => 'account-token')
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    await searchProvider({ ...options, resolveAccountToken, resolveApiKey }).search({ query: 'q' })
    const { url, headers } = first()
    expect(resolveAccountToken).toHaveBeenCalledWith(url)
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(headers['x-dsh-auth-token']).toBe('account-token')
    expect(headers).not.toHaveProperty('x-api-key')
    expect(headers).not.toHaveProperty('authorization')
  })

  it.each([undefined, ''])('falls back to the API key when the account resolves %j', async (token) => {
    const { first } = captureFetch()
    await searchProvider({ ...options, resolveAccountToken: async () => token }).search({ query: 'q' })
    const { headers } = first()
    expect(headers['x-api-key']).toBe('ds-key')
    expect(headers).not.toHaveProperty('x-dsh-auth-token')
  })

  it('maps an account resolver rejection to WEB_PROVIDER_ERROR without dispatching', async () => {
    const { fetchMock } = captureFetch()
    await expect(searchProvider({
      ...options,
      resolveAccountToken: () => Promise.reject(new Error('account storage failed')),
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek web credential resolution failed: Error: account storage failed',
      }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('replaces endpoint guidance with sign-in guidance when DeepSeek rejects the account token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'invalid token' } }, { status: 401 })))
    const error = await rejectedWebError(searchProvider({
      ...options,
      resolveAccountToken: async () => 'account-token',
    }).search({ query: 'q' }))
    expect(error).toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'DeepSeek API error (HTTP 401): invalid token\n\n'
        + 'DeepSeek rejected the account sign-in used for this web request. '
        + 'Guide the user to sign in to DeepSeek again; the endpoint does not need changing.',
    })
  })

  it('keeps endpoint guidance for other account-authenticated HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 503 })))
    const error = await rejectedWebError(searchProvider({
      ...options,
      resolveAccountToken: async () => 'account-token',
    }).search({ query: 'q' }))
    expect(error.message).toContain('Search endpoint configuration is separate from chat.')
  })

  it('maps a synchronous resolver throw to WEB_PROVIDER_ERROR', async () => {
    const { fetchMock } = captureFetch()
    await expect(searchProvider({
      ...options,
      resolveAccountToken: () => { throw new Error('account service threw') },
    }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek web credential resolution failed: Error: account service threw',
      }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts neither resolver for a pre-aborted call', async () => {
    const resolveAccountToken = vi.fn(async () => 'account-token')
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ ...options, apiKey: '', resolveAccountToken, resolveApiKey })
      .search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveAccountToken).not.toHaveBeenCalled()
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('does not start API-key resolution after cancellation during account resolution', async () => {
    const controller = new AbortController()
    const resolveApiKey = vi.fn(() => Promise.reject(new Error('must not run')))
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveAccountToken: async () => {
        controller.abort(new Error('caller stopped'))
        return undefined
      },
      resolveApiKey,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('aborts while the account resolver remains pending', async () => {
    const { fetchMock } = captureFetch()
    const controller = new AbortController()
    const search = searchProvider({
      ...options,
      resolveAccountToken: () => new Promise<string>(() => {}),
    }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


describe('DeepSeek web cancellation and failures', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey,
      recordRequest,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey,
      recordRequest,
    }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves credentials under an active cancellation signal', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ truncated: false }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: async () => 'resolved-key',
    }).search({ query: 'q' }, controller.signal)).resolves.toMatchObject({ truncated: false })
    const [, init] = fetchMock.mock.calls[0]!
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('resolved-key')
  })

  it('maps a credential resolver rejection under an active signal to WEB_PROVIDER_ERROR', async () => {
    const controller = new AbortController()
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek web credential resolution failed: Error: credential backend failed',
      }))
  })

  it('uses the default credential reference when no resolver is configured', async () => {
    await expect(searchProvider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('DeepSeek web access has no API key for "DEEPSEEK_API_KEY"')
  })

  it('observes cancellation triggered synchronously by credential resolution', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: () => {
        controller.abort(new Error('resolver cancelled caller'))
        return Promise.resolve('unused-key')
      },
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'DeepSeek API error (HTTP 429): rate limited\n\n'
          + 'The web request used endpoint "https://api.deepseek.test/anthropic/v1/messages". '
          + 'Search endpoint configuration is separate from chat. If that endpoint is not intended, '
          + 'guide the user to Plugins > Built-in plugin settings > Web search, where they can '
          + 'change and save Messages API base URL. If that settings page is unavailable, the user can set '
          + 'web-search-deepseek.baseURL to a trusted DeepSeek endpoint. Only the user should choose or change the endpoint.',
      }))
  })

  it('handles a string-form error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 })))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.message).toContain('DeepSeek API error (HTTP 400): bad request')
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.message).toContain('DeepSeek API error (HTTP 503)')
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.message).toContain('DeepSeek API error (HTTP 500)')
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a custom abort reason to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      })))
    const search = searchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = new Response('', { status: 200 })
    vi.spyOn(body, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = new Response('', { status: 500 })
    vi.spyOn(body, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => body))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('The web request used endpoint "https://api.deepseek.test/anthropic/v1/messages".')
  })

})
