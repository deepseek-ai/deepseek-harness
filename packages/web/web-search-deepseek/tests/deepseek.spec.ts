import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-deepseek'
import * as deepseekPlugin from '@deepseek-ai/dsh-web-search-deepseek'
import { citationSnippets, mapAnthropicResponse } from '../src/provider.ts'
import type { AnthropicResponse } from '@deepseek-ai/dsh-web-search-deepseek/src/types.ts'

/** Construct the provider over a fixed options value; production passes a live thunk. */
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'

const searchProvider = (options: DeepSeekSearchProviderOptions): DeepSeekSearchProvider =>
  new DeepSeekSearchProvider(() => options)

/** Return the provider's rejected WebError, or propagate an unexpected outcome. */
async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof WebError) return error
    throw error
  }
  throw new Error('expected search operation to reject')
}

const options = {
  apiKey: 'ds-key',
  baseURL: 'https://api.deepseek.test/anthropic/v1',
  model: 'deepseek-chat',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** A response with one result block plus a text block carrying the snippet. */
function searchResponse(): AnthropicResponse {
  return {
    content: [
      { type: 'text', text: 'Here is what I found.', citations: [{ type: 'web_search_result_location', url: 'https://a.test', cited_text: 'excerpt for A' }] },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test', title: 'A', page_age: '2026-02-02' },
          { type: 'web_search_result', url: 'https://b.test', title: 'B' },
        ],
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('citationSnippets', () => {
  it('maps url → cited_text from text blocks, first occurrence wins', () => {
    const map = citationSnippets([
      { type: 'text', citations: [{ url: 'https://a.test', cited_text: 'first' }, { url: 'https://a.test', cited_text: 'second' }] },
      { type: 'text', citations: [{ url: 'https://b.test', cited_text: 'b text' }] },
    ])
    expect(map.get('https://a.test')).toBe('first')
    expect(map.get('https://b.test')).toBe('b text')
  })

  it('ignores citations missing url or cited_text', () => {
    const map = citationSnippets([
      { type: 'text', citations: [{ url: 'https://a.test' }, { cited_text: 'orphan' }, { url: '', cited_text: 'empty url' }] },
    ])
    expect(map.size).toBe(0)
  })
})

describe('mapAnthropicResponse', () => {
  it('joins result items to citation snippets and maps page_age to publishedAt', () => {
    const result = mapAnthropicResponse(searchResponse())
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'excerpt for A', publishedAt: '2026-02-02' },
        { url: 'https://b.test', title: 'B' },
      ],
      truncated: false,
    })
  })

  it('dedupes repeated urls across result blocks (first wins)', () => {
    const result = mapAnthropicResponse({
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'first' }] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'second' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'first' }])
  })

  it('skips non-result items and items with an empty url', () => {
    const result = mapAnthropicResponse({
      content: [{
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result_error', url: 'https://err.test' },
          { type: 'web_search_result', url: '' },
          { type: 'web_search_result', url: 'https://ok.test' },
        ],
      }],
    })
    expect(result.sources).toEqual([{ url: 'https://ok.test' }])
  })

  it('omits optional fields when absent or empty', () => {
    const result = mapAnthropicResponse({
      content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: '', page_age: '' }] }],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('tolerates a text block with no citations', () => {
    const result = mapAnthropicResponse({
      content: [
        { type: 'text', text: 'no citations here' },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'A' }])
  })

  it('tolerates a result block with no content array', () => {
    const result = mapAnthropicResponse({
      content: [
        { type: 'web_search_tool_result' },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test' }])
  })

  it('throws WEB_PROVIDER_ERROR (strict mode) when no result block is present', () => {
    expect(() => mapAnthropicResponse({ content: [{ type: 'text', text: 'just prose, no search' }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('throws WEB_PROVIDER_ERROR when content is absent entirely', () => {
    expect(() => mapAnthropicResponse({}))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('DeepSeekSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when request limits are not positive integers', () => {
    expect(searchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxUses: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxUses: 1.5 }).available()).toBe(false)
  })
})

describe('DeepSeekSearchProvider request mapping', () => {
  it('records and posts the same Anthropic Messages request with the web_search server tool', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, recordRequest }).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.test/anthropic/v1/messages')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('ds-key')
    expect(headers['authorization']).toBe('Bearer ds-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = {
      model: 'deepseek-chat',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: hello' }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(recordRequest).toHaveBeenCalledOnce()
    expect(recordRequest).toHaveBeenCalledWith({
      endpoint: url,
      apiVersion: '2023-06-01',
      body,
    })
    expect(recordRequest.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('DeepSeekSearchProvider settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    // The section the search starts on, and the one a user commits while the
    // credential is still resolving.
    const before = { ...options, apiKey: '', baseURL: 'https://before.test/v1', model: 'model-before', maxUses: 2 }
    const after = { ...options, apiKey: '', baseURL: 'https://after.test/v1', model: 'model-after', maxUses: 9 }
    let current = before
    let commitSettings = () => {}
    const resolveApiKey = () => new Promise<string>((resolve) => {
      commitSettings = () => { current = after; resolve('key-from-before') }
    })
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new DeepSeekSearchProvider(() => ({ ...current, resolveApiKey }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    // The key resolved from `before` must never reach `after`'s origin.
    expect(endpoint).toBe('https://before.test/v1/messages')
    expect(init.headers['x-api-key']).toBe('key-from-before')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'model-before' })
  })
})

describe('DeepSeekSearchProvider error handling', () => {
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
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: async () => 'resolved-key',
    }).search({ query: 'q' }, controller.signal)).resolves.toMatchObject({ truncated: false })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('resolved-key')
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
        message: 'DeepSeek search credential resolution failed: Error: credential backend failed',
      }))
  })

  it('uses the default credential reference when no resolver is configured', async () => {
    await expect(searchProvider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('DeepSeek search has no API key for "DEEPSEEK_API_KEY"')
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
          + 'The web search request used endpoint "https://api.deepseek.test/anthropic/v1/messages". '
          + 'Search endpoint configuration is separate from chat. If that endpoint is not intended, '
          + 'guide the user to Settings > Plugins > Plugin configuration > Web search, where they can '
          + 'change and save Endpoint. If that settings page is unavailable, the user can set '
          + 'DEEPSEEK_SEARCH_BASE_URL or configure web-search-deepseek.baseURL to a trusted '
          + 'Anthropic-compatible Messages API base. Only the user should choose or change the endpoint.',
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

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: {} }, { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('The web search request used endpoint "https://api.deepseek.test/anthropic/v1/messages".')
  })

  it('strict mode flows through search(): a prose-only response throws WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'no search happened' }] })))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Search endpoint configuration is separate from chat.')
  })
})

describe('web-search-deepseek plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
    const fiber = await ctx.plugin(deepseekPlugin, { apiKey: 'ds-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('rejects maxTokens: 0 at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
    await expect(ctx.plugin(deepseekPlugin, { apiKey: 'ds-key', maxTokens: 0 }))
      .rejects.toThrow(/maxTokens expected number >= 1/)
  })

  it('rejects maxUses: 0 at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
    await expect(ctx.plugin(deepseekPlugin, { apiKey: 'ds-key', maxUses: 0 }))
      .rejects.toThrow(/maxUses expected number >= 1/)
  })

  it('rejects a fractional maxUses at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
    await expect(ctx.plugin(deepseekPlugin, { apiKey: 'ds-key', maxUses: 1.5 }))
      .rejects.toThrow(/maxUses expected number multiple of 1/)
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in deepseekPlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    // A default export would make `unwrapExports` collapse the namespace and drop `inject: ['web']`.
    // Drive the real Loader path because hand-built namespace mounting cannot expose that failure.
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(deepseekPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(deepseekPlugin)
    expect(unwrapped.name).toBe('web-search-deepseek')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.web through the unwrapped module without an inject error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(deepseekPlugin) as Parameters<Context['plugin']>[0]
    // A collapsed export shape (dropped inject) would throw "without inject" here.
    const fiber = await ctx.plugin(unwrapped, { apiKey: 'ds-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
    await fiber.dispose()
  })

  it('falls back to the env key and defaults when config omits them', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
      deepseekPlugin.apply(ctx, deepseekPlugin.Config({}))
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages')
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('env-key')
      expect(JSON.parse(init.body as string)).toMatchObject({ model: 'deepseek-v4-flash' })
      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-credentials-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(deepseekPlugin, { baseURL: 'https://api.deepseek.test/anthropic/v1' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('DEEPSEEK_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value['x-api-key'])).toEqual(['stored-key', 'rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })

  it('reports an actionable credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: DEEPSEEK_PROVIDER_ID })
      await ctx.plugin(deepseekPlugin, {})
      let caught: unknown
      try {
        await ctx.web.search({ query: 'q' })
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
      expect(caught.message).toMatch(/store it through the credentials service.*Models page/s)
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev
    }
  })
})
