import { afterEach, expect, it, vi } from 'vitest'
import type { GeneratedEntry } from '../src/generate.ts'
import { metricReader } from '../src/metrics.ts'

const limits = { timeoutMs: 10, maxTarballBytes: 1024 }
const TOKEN = 'test-only-github-token'
const plugin = (name = '@team/dsh-test', source: Record<string, string> = { type: 'npm' }): GeneratedEntry => ({
  name, repository: { url: 'https://github.com/team/plugins' },
  versions: [{ version: '1.0.0', publishTimestamp: 0, source }],
})

afterEach(() => { vi.unstubAllGlobals() })

it('shares repository requests across packages and retains true zero counts', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ stargazers_count: 0 }))
  vi.stubGlobal('fetch', fetch)
  const read = metricReader(limits, 'https://registry.npmjs.org/', vi.fn(), TOKEN)
  const entries = await Promise.all(['a', 'b'].map(name => read(plugin(name, { type: 'git', url: 'https://github.com/team/plugins' }))))
  expect(entries.map(entry => entry.metadata?.sortKeys)).toEqual([{ github_stars: 0 }, { github_stars: 0 }])
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([null, {}, { downloads: null }, { downloads: -1 }, { downloads: 1.2 }, { downloads: '3' }, { downloads: 1e20 }])(
  'omits invalid count response %j while keeping an independently available metric', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('github.com') ? { stargazers_count: 7 } : body)))
    const warn = vi.fn()
    expect((await metricReader(limits, 'https://registry.npmjs.org/', warn, TOKEN)(plugin())).metadata?.sortKeys).toEqual({ github_stars: 7 })
    expect(warn).toHaveBeenCalledOnce()
  },
)

it('omits rate-limited GitHub counts while retaining npm downloads and sharing the failed request', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('github.com')
    ? Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    : Response.json({ downloads: 42 }))
  vi.stubGlobal('fetch', fetch)
  const warn = vi.fn()
  const read = metricReader(limits, 'https://registry.npmjs.org/', warn, TOKEN)
  for (const result of await Promise.all([read(plugin()), read(plugin())])) {
    expect(result.metadata?.sortKeys).toEqual({ npm_weekly_downloads: 42 })
  }
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledExactlyOnceWith('https://api.github.com/repos/team/plugins: HTTP 403; metric omitted')
})

it.each(['http', 'json', 'timeout', 'network'])('omits %s failures without dropping the entry', async (failure) => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'http') return new Response('', { status: 429 })
    if (failure === 'json') return new Response('not json')
    throw failure === 'timeout' ? new DOMException('deadline', 'TimeoutError') : new TypeError('offline')
  }))
  const warn = vi.fn()
  const entry = plugin()
  expect(await metricReader(limits, 'https://registry.npmjs.org/', warn, TOKEN)(entry)).toEqual(entry)
  expect(warn).toHaveBeenCalledTimes(2)
})

it.each([false, true])('settles streaming HTTP error responses before returning (cancel rejects: %s)', async (rejectCancel) => {
  const started = Promise.withResolvers<undefined>()
  const cancellation = Promise.withResolvers<undefined>()
  const cancel = vi.fn(() => {
    started.resolve(undefined)
    return cancellation.promise
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('unavailable')) },
    cancel,
  }), { status: 503 })))
  const entry = plugin('git-only', { type: 'git', url: 'https://github.com/team/plugins' })
  const warn = vi.fn()
  let finished = false
  const reading = metricReader(limits, 'https://registry.npmjs.org/', warn, TOKEN)(entry).then((result) => {
    finished = true
    return result
  })
  await started.promise
  expect(finished).toBe(false)
  if (rejectCancel) cancellation.reject(new Error('cancel failed'))
  else cancellation.resolve(undefined)
  expect(await reading).toEqual(entry)
  expect(cancel).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    `https://api.github.com/repos/team/plugins: HTTP 503; ${rejectCancel ? 'GitHub metric request failed; ' : ''}metric omitted`,
  )
})

it('does not look up public counts for private-registry names or non-GitHub repositories', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const entry = { ...plugin('private-name', { type: 'npm', registry: 'https://registry.example/' }), repository: { url: 'https://gitlab.example/team/plugins' } }
  expect(await metricReader(limits, 'https://registry.example/', vi.fn(), TOKEN)(entry)).toEqual(entry)
  expect(fetch).not.toHaveBeenCalled()
})

it('attributes Git stars to the installed repository instead of a conflicting manifest repository', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ stargazers_count: 3 }))
  vi.stubGlobal('fetch', fetch)
  await metricReader(limits, 'https://registry.npmjs.org/', vi.fn(), TOKEN)(plugin('git-only', { type: 'git', url: 'https://github.com/actual/source.git' }))
  expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.github.com/repos/actual/source', expect.any(Object))
})

it('skips GitHub without a token while keeping npm downloads', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ downloads: 42 }))
  vi.stubGlobal('fetch', fetch)
  const warn = vi.fn()
  const read = metricReader(limits, 'https://registry.npmjs.org/', warn)
  expect((await read(plugin())).metadata?.sortKeys).toEqual({ npm_weekly_downloads: 42 })
  const git = plugin('git-only', { type: 'git', url: 'https://github.com/team/plugins' })
  expect(await read(git)).toEqual(git)
  expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.npmjs.org/downloads/point/last-week/%40team%2Fdsh-test', expect.any(Object))
  expect(warn).not.toHaveBeenCalled()
})

it('authenticates only the GitHub API request and leaves npm unauthenticated', async () => {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.includes('github.com')
    ? { stargazers_count: 7 } : { downloads: 42 }))
  vi.stubGlobal('fetch', fetch)
  const entry = await metricReader(limits, 'https://registry.npmjs.org/', vi.fn(), TOKEN)(plugin())
  expect(entry.metadata?.sortKeys).toEqual({ github_stars: 7, npm_weekly_downloads: 42 })
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [url, init] of fetch.mock.calls) {
    expect(new Headers(init?.headers).get('authorization')).toBe(url.startsWith('https://api.github.com/') ? `Bearer ${TOKEN}` : null)
  }
  expect(JSON.stringify(entry)).not.toContain(TOKEN)
})

it.each(['fetch', 'json', 'cancel'])('does not expose a token in %s errors from GitHub', async (failure) => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'fetch') throw new Error(`rejected header Bearer ${TOKEN}`)
    if (failure === 'json') return new Response(`invalid ${TOKEN}`)
    return new Response(new ReadableStream({ cancel: () => Promise.reject(new Error(TOKEN)) }), { status: 503 })
  }))
  const warn = vi.fn()
  const entry = plugin('git-only', { type: 'git', url: 'https://github.com/team/plugins' })
  expect(await metricReader(limits, 'https://registry.npmjs.org/', warn, TOKEN)(entry)).toEqual(entry)
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    `https://api.github.com/repos/team/plugins: ${failure === 'fetch' ? '' : `HTTP ${failure === 'json' ? 200 : 503}; `}GitHub metric request failed; metric omitted`,
  )
  expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
})
