import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  DeepSeekSearchApiProvider,
  DEEPSEEK_WEB_API_BASE_URL,
  mapSearchResponse,
  type DeepSeekSearchApiOptions,
} from '@deepseek-ai/dsh-web-deepseek-api'
import * as webApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'

/** Construct the provider over a fixed options value; production passes a live thunk. */
const searchProvider = (options: DeepSeekSearchApiOptions): DeepSeekSearchApiProvider =>
  new DeepSeekSearchApiProvider(() => options)

const options = {
  apiKey: 'ds-key',
  baseURL: 'https://api.deepseek.test/api/v1/tools',
  count: 10,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** Search API response with present and absent source metadata. */
function searchResponse() {
  return { results: [
    {
      rerank_score: 2.5, title: 'A', url: 'https://a.test', snippet: 'excerpt for A', summary: 'longer summary for A',
      content: '', site_name: 'A News', site_icon: 'https://a.test/favicon.ico', date: '2026-02-02T16:00:00+00:00', authority: 4,
    },
    {
      rerank_score: 1.2, title: 'B', url: 'https://b.test', snippet: '', summary: '',
      content: '', site_name: null, site_icon: null, date: null, authority: -1,
    },
  ] }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('mapSearchResponse', () => {
  it('maps source titles, snippets, summaries and nullable dates in provider order', () => {
    expect(mapSearchResponse(searchResponse())).toEqual({ sources: [
      { url: 'https://a.test', title: 'A', snippet: 'excerpt for A', summary: 'longer summary for A', publishedAt: '2026-02-02T16:00:00+00:00' },
      { url: 'https://b.test', title: 'B' },
    ], truncated: false })
  })
  it('accepts an empty search', () => {
    expect(mapSearchResponse({ results: [] })).toEqual({ sources: [], truncated: false })
  })
  it('omits empty optional source text', () => {
    expect(mapSearchResponse({ results: [{ url: 'https://a.test', title: '', snippet: '', date: '' }] }).sources)
      .toEqual([{ url: 'https://a.test' }])
  })
  it.each([null, {}, { results: {} }, { results: [null] }, { results: [{ url: '' }] },
    { results: [{ url: 'https://a.test', title: 1, snippet: '', date: null }] },
    { results: [{ url: 'https://a.test', title: '', snippet: 1, date: null }] },
    { results: [{ url: 'https://a.test', title: '', snippet: '', date: 1 }] },
    { results: [{ url: 'https://a.test', title: '', snippet: '', summary: 1, date: null }] },
  ])('rejects malformed remote JSON %j', (body) => {
    expect(() => mapSearchResponse(body)).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('DeepSeekSearchApiProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is available with only an account token resolver', () => {
    expect(searchProvider({ ...options, apiKey: '', resolveAccountToken: async () => 'account-token' }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it.each([0, 1.5])('is unavailable with invalid count %j', (count) => {
    expect(searchProvider({ ...options, count }).available()).toBe(false)
  })
})

describe('DeepSeekSearchApiProvider request mapping', () => {
  it.each([
    [undefined, { query: 'hello', count: 10, need_content: false }],
    [5, { query: 'hello', count: 5, need_content: false }],
    [80, { query: 'hello', count: 10, need_content: false }],
  ])('posts a direct search with result bound %j', async (maxResults, expected) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'hello', ...maxResults === undefined ? {} : { maxResults } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.test/api/v1/tools/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ds-key', 'content-type': 'application/json' })
    expect(Object.keys(init?.headers ?? {}).sort()).toEqual(['accept', 'authorization', 'content-type', 'user-agent'])
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(init.body)).toEqual(expected)
  })

  it.each([
    ['the collapsed question', '  How do\n\tI  install it?  ', 'How do I install it?'],
    ['the first 128 characters', `${'问'.repeat(127)}题题`, `${'问'.repeat(127)}题`],
    ['whole surrogate pairs', `${'a'.repeat(127)}😀😀`, `${'a'.repeat(127)}😀`],
  ])('sends %s as ori_question', async (_case, question, expected) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, originalQuestion: () => question }).search({ query: 'q', maxResults: 8 })
    const body = fetchMock.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(body)).toEqual({ query: 'q', count: 8, need_content: false, ori_question: expected })
  })

  it.each([undefined, '', ' \n '])('omits ori_question for question %j', async (question) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, originalQuestion: () => question }).search({ query: 'q' })
    const body = fetchMock.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('expected JSON request body')
    expect(JSON.parse(body)).not.toHaveProperty('ori_question')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0]!
    expect(init?.signal).toBe(controller.signal)
  })
})

describe('Search API triggering question', () => {
  type DerivedMessage = ReturnType<Session['deriveMessages']>[number]

  /** One derived user-role message with the given source and blocks. */
  function userMessage(id: string, source: DerivedMessage['source'], content: DerivedMessage['content']): DerivedMessage {
    return { id: id as DerivedMessage['id'], role: 'user', source, content }
  }

  /**
   * Run one search inside an initiator whose derived history holds a human
   * prompt followed by injected user-role context.
   * @param config - extra plugin configuration.
   * @returns the parsed Search API request body.
   */
  async function searchFromPrompt(config: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api' })
      await ctx.plugin(webApiPlugin, { apiKey: 'ds-key', ...config })
      const messages = [
        userMessage('m1', { kind: 'user' }, [{ type: 'text', text: 'Earlier question' }]),
        userMessage('m2', { kind: 'user' }, [
          { type: 'text', text: 'What changed' }, { type: 'reasoning', text: 'not prompt text' }, { type: 'text', text: 'in DeepSeek V4?' },
        ]),
        userMessage('m3', { kind: 'system-prompt' }, [{ type: 'text', text: 'Injected instructions' }]),
      ]
      const session: Pick<Session, 'deriveMessages' | 'requestContext'> = { deriveMessages: () => messages, requestContext: () => undefined }
      const agent = { session } as Agent
      await ctx.agents.withInitiator(agent, () => ctx.web.search({ query: 'DeepSeek V4' }))
      const body = fetchMock.mock.calls[0]?.[1]?.body
      if (typeof body !== 'string') throw new Error('expected JSON request body')
      return JSON.parse(body) as Record<string, unknown>
    } finally { await ctx.fiber.dispose() }
  }

  it('sends the latest human prompt as ori_question', async () => {
    expect(await searchFromPrompt()).toMatchObject({ ori_question: 'What changed in DeepSeek V4?' })
  })

  it('omits ori_question when sending it is disabled', async () => {
    expect(await searchFromPrompt({ sendOriginalQuestion: false })).not.toHaveProperty('ori_question')
  })
})

describe('Search API configuration and failures', () => {
  it('uses the official Search API base by default', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api' })
      await ctx.plugin(webApiPlugin, { apiKey: 'ds-key' })
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${DEEPSEEK_WEB_API_BASE_URL}/search`)
      expect(DEEPSEEK_WEB_API_BASE_URL).toBe('https://api.deepseek.com/v1/tools')
    } finally { await ctx.fiber.dispose() }
  })

  it('reports an unparseable API base as an unavailable provider', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api' })
      await ctx.plugin(webApiPlugin, { apiKey: 'ds-key', baseURL: '' })
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('retains the HTTP status when the error body is not an object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, { status: 502 })))
    await expect(searchProvider(options).search({ query: 'DeepSeek' })).rejects.toThrow('HTTP 502')
  })

  it('names the Search API base in endpoint guidance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'not found' } }, { status: 404 })))
    await expect(searchProvider(options).search({ query: 'DeepSeek' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'DeepSeek API error (HTTP 404): not found\n\n'
        + 'The web request used endpoint "https://api.deepseek.test/api/v1/tools/search". '
        + 'Search endpoint configuration is separate from chat. If that endpoint is not intended, '
        + 'guide the user to Plugins > Built-in plugin settings > Web search, where they can '
        + 'change and save Search / Fetch API base URL. If that settings page is unavailable, the user can set '
        + 'web-deepseek-api.baseURL to a trusted DeepSeek endpoint. Only the user should choose or change the endpoint.',
    })
  })
})

describe('Search API account route', () => {
  it('authenticates with the account token when the initiating Session uses the account route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const asked: string[] = []
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api' })
      ctx.provide('deepseekAccount', {
        resolveToken: async (url: string) => { asked.push(url); return 'account-token' },
      } as DeepSeekAccount)
      await ctx.plugin(webApiPlugin, { apiKey: 'ds-key' })
      const session = ctx.sessions.create(SessionId('web-search-api-account'))
      session.append('turn/start', { turn: 1 })
      session.append('request/context', { provider: 'deepseek-account', model: 'deepseek-v4-flash' })
      await ctx.agents.withInitiator({ session } as Agent, () => ctx.web.search({ query: 'q' }))
      expect(asked).toEqual(['https://api.deepseek.com/v1/tools/search'])
      const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
      expect(headers['x-dsh-auth-token']).toBe('account-token')
      expect(headers).not.toHaveProperty('authorization')
      expect(headers).not.toHaveProperty('x-api-key')
    } finally { await ctx.fiber.dispose() }
  })
})
