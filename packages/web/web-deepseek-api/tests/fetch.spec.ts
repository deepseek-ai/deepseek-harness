import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { DeepSeekFetchApiProvider, type DeepSeekFetchApiOptions } from '@deepseek-ai/dsh-web-deepseek-api'
import * as webApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'
const fetchProvider = (options: DeepSeekFetchApiOptions) => new DeepSeekFetchApiProvider(() => options)
const options = { apiKey: 'ds-key', baseURL: 'https://api.deepseek.test/api/v1/tools' }
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}
afterEach(() => { vi.unstubAllGlobals() })

describe('DeepSeek Fetch API', () => {
  it('posts the URL and returns the Markdown as a retrieved page', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ title: 'Example', content: '# Article\n\nBody' }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = fetchProvider({ ...options, baseURL: `${options.baseURL}/` })
    expect(await provider.fetch({ url: 'https://example.com/article' })).toEqual({
      url: 'https://example.com/article', statusCode: 200, body: { kind: 'text', content: '# Article\n\nBody' }, truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.test/api/v1/tools/fetch')
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com/article' })
    expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer ds-key' } })
    expect(init?.headers).not.toHaveProperty('anthropic-version')
  })
  it.each([null, {}, { title: '', content: null }])('rejects malformed Fetch response %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)))
    await expect(fetchProvider(options).fetch({ url: 'https://example.com' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
  it.each([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504])('reports HTTP %i as a retrieval failure', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'request failed', type: 'api_error', param: null, code: 'api_error' } }, { status })))
    await expect(fetchProvider(options).fetch({ url: 'https://example.com' })).rejects.toThrow(`HTTP ${status}`)
  })
  it('honors pre-dispatch cancellation for fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchProvider(options).fetch({ url: 'https://example.com' }, AbortSignal.abort())).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('names the shared API base in endpoint guidance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'not found' } }, { status: 404 })))
    await expect(fetchProvider(options).fetch({ url: 'https://example.com' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'DeepSeek API error (HTTP 404): not found\n\n'
        + 'The web request used endpoint "https://api.deepseek.test/api/v1/tools/fetch". '
        + 'Fetch endpoint configuration is separate from chat. If that endpoint is not intended, '
        + 'guide the user to Plugins > Built-in plugin settings > Web search, where they can '
        + 'change and save Search / Fetch API base URL. If that settings page is unavailable, the user can set '
        + 'web-deepseek-api.baseURL to a trusted DeepSeek endpoint. Only the user should choose or change the endpoint.',
    })
  })
  it('is available only with a credential source and a parseable base', () => {
    expect(fetchProvider(options).available()).toBe(true)
    expect(fetchProvider({ ...options, apiKey: '' }).available()).toBe(false)
    expect(fetchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })
  it('unregisters both providers with its plugin fiber', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ title: '', content: 'body' })))
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
      const fiber = await ctx.plugin(webApiPlugin, { apiKey: 'ds-key', baseURL: options.baseURL })
      await expect(ctx.web.fetch({ url: 'https://example.com' })).resolves.toMatchObject({ body: { content: 'body' } })
      await fiber.dispose()
      await expect(ctx.web.fetch({ url: 'https://example.com' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
    } finally { await ctx.fiber.dispose() }
  })
})
