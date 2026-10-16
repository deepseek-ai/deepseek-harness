import { Context, Service } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import PluginMarket, { type Config, type MarketQuery } from '../src/index.ts'
import { parseIndexBody } from '../src/parse.ts'

// Parse in-process; parse-worker.spec.ts runs the real Worker.
vi.mock('../src/parse-thread.ts', () => ({
  parseIndexInWorker: async (body: Uint8Array, url: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    return await Promise.resolve(parseIndexBody(body, url))
  },
}))

const URL_A = 'https://market.example/index.json'
const URL_B = 'https://other.example/index.json'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function bundle(name: string, fields: Partial<BundleInfo>): BundleInfo {
  return { name, official: false, availability: 'profile', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [], ...fields }
}

function index(plugins: unknown[] = []): unknown {
  return { format: 1, title: { en: 'Market', zh: '市场' }, description: 'Bundles', plugins }
}

function release(version: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { version, publishTimestamp: 1, source: { type: 'npm' }, ...fields }
}

function entry(name: string, fields: Record<string, unknown> = {}, versions: Record<string, unknown>[] = [release('1.0.0')]): Record<string, unknown> {
  return { name, versions, ...fields }
}

async function mount(config: Partial<{ indexes: string[]; fetchTimeoutMs: number; maxBytes: number; cacheTtlMs: number }> = {}, options: {
  bundles?: BundleInfo[]
  exemptions?: Record<string, string[]>
  settings?: (ns: string, patch: object) => Promise<void>
  entryId?: boolean
} = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve(options.bundles ?? []) }
    listVersionExemptions() { return { exemptions: options.exemptions ?? {}, warnings: [] } }
  }
  await ctx.plugin(Manager)
  if (options.settings !== undefined) {
    const update = options.settings
    class Settings extends Service {
      constructor(inner: Context) { super(inner, 'settings') }
      update(ns: string, patch: object) { return update(ns, patch) }
    }
    await ctx.plugin(Settings)
  }
  let captured: Config | undefined
  class CapturingMarket extends PluginMarket {
    constructor(inner: Context, resolved: Config) {
      if (options.entryId !== false) Object.defineProperty(inner.fiber, 'entry', { value: { options: { id: 'plugin-market' } } })
      super(inner, resolved)
      captured = resolved
    }
  }
  await ctx.plugin(CapturingMarket, { indexes: [URL_A], ...config })
  if (captured === undefined) throw new Error('market did not mount')
  return { ctx, market: ctx.pluginMarket, config: captured }
}

function serve(...responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch')
    if (next instanceof Error) return Promise.reject(next)
    if (typeof next === 'function') return next(init)
    return Promise.resolve(next)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), init)
}

/** The first page of up to 100 plugins in index order. */
function read(market: PluginMarket, url: string, refresh = false) {
  return market.search(url, { sort: { kind: 'index' }, offset: 0, limit: 100, refresh })
}

async function failure(promise: Promise<unknown>) {
  return remoteErrorOf(await promise.then(() => { throw new Error('resolved') }, (error: unknown) => error))
}

it('reads an index with installation status, compatibility, and install arguments', async () => {
  const runtime = getDshRuntimeVersion()
  const fetch = serve(json(index([
    entry('absent', { icon: 'a.svg', author: 'Jane' }),
    entry('same', {}, [release('1.0.0', { engines: { dsh: runtime } })]),
    entry('older', {}, [release('2.0.0')]),
    entry('newer'),
    entry('unknown'),
    entry('unparsed'),
    entry('shipped'),
    entry('catalog'),
    entry('incompatible', {}, [release('1.0.0', { engines: { dsh: '0.0.1' } })]),
    entry('exempted', {}, [release('1.0.0', { engines: { dsh: '0.0.1' }, source: { type: 'npm', registry: 'https://r.example/' } })]),
  ])))
  const { market } = await mount({}, {
    bundles: [
      bundle('same', { version: '1.0.0' }), bundle('older', { version: '1.5.0' }), bundle('newer', { version: '3.0.0' }),
      bundle('unknown', {}), bundle('unparsed', { version: 'local' }), bundle('shipped', { installed: false, optional: true, availability: 'installation', version: '1.0.0' }),
      bundle('catalog', { installed: false, official: true, availability: 'missing', installTarget: { spec: 'catalog@1.0.0', version: '1.0.0' } }),
      bundle('incompatible', { version: '0.9.0' }),
    ],
    exemptions: { 'exempted@1.0.0': [runtime] },
  })
  const listing = await read(market, URL_A)
  expect(fetch).toHaveBeenCalledWith(URL_A, expect.objectContaining({ redirect: 'error' }))
  expect(listing).toMatchObject({ url: URL_A, title: { en: 'Market', zh: '市场' }, description: 'Bundles', metadata: { categories: {}, labels: {}, sortKeys: {} } })
  const by = Object.fromEntries(listing.entries.map(item => [item.name, item]))
  expect(by.absent).toMatchObject({
    icon: 'https://market.example/a.svg', author: 'Jane', defaultVersion: '1.0.0', installation: { status: 'not-installed' },
    versions: [{ version: '1.0.0', engines: {}, install: { spec: 'absent@1.0.0' }, compatibility: { compatible: true } }],
  })
  expect(by.same?.installation).toEqual({ status: 'installed', installedVersion: '1.0.0' })
  expect(by.older?.installation).toEqual({ status: 'update-available', installedVersion: '1.5.0' })
  expect(by.newer?.installation).toEqual({ status: 'different-version', installedVersion: '3.0.0' })
  expect(by.unknown?.installation).toEqual({ status: 'different-version' })
  expect(by.unparsed?.installation).toEqual({ status: 'different-version', installedVersion: 'local' })
  expect(by.shipped?.installation).toEqual({ status: 'provided', installedVersion: '1.0.0' })
  expect(by.catalog?.installation).toEqual({ status: 'not-installed' })
  expect(by.incompatible?.defaultVersion).toBeUndefined()
  expect(by.incompatible?.installation).toEqual({ status: 'update-available', installedVersion: '0.9.0' })
  expect(by.incompatible?.versions[0]?.compatibility).toEqual({ compatible: false, runtimeVersion: runtime, requirements: { 'engines.dsh': '0.0.1' }, exempted: false })
  expect(by.exempted?.versions[0]).toMatchObject({ install: { spec: 'exempted@1.0.0', registry: 'https://r.example/' }, compatibility: { compatible: false, exempted: true } })
  expect(market.listIndexes()).toEqual([{ url: URL_A, title: { en: 'Market', zh: '市场' }, description: 'Bundles' }])
})

it('defaults to the highest compatible stable version, or the highest compatible prerelease without a stable one', async () => {
  serve(json(index([
    entry('mixed', {}, [release('2.0.0-rc.1'), release('1.0.0'), release('1.1.0', { engines: { dsh: '0.0.1' } })]),
    entry('previews', {}, [release('1.0.0-beta.1'), release('1.0.0-rc.1', { engines: { dsh: '0.0.1' } })]),
    entry('only-preview-stable', {}, [release('2.0.0-rc.1'), release('1.0.0', { engines: { dsh: '0.0.1' } })]),
  ])))
  const { market } = await mount({}, { bundles: [bundle('mixed', { version: '1.0.0' })] })
  const by = Object.fromEntries((await read(market, URL_A)).entries.map(item => [item.name, item]))
  expect(by.mixed?.versions.map(version => version.version)).toEqual(['2.0.0-rc.1', '1.1.0', '1.0.0'])
  expect(by.mixed?.defaultVersion).toBe('1.0.0')
  expect(by.mixed?.installation).toEqual({ status: 'installed', installedVersion: '1.0.0' })
  expect(by.previews?.defaultVersion).toBe('1.0.0-beta.1')
  expect(by['only-preview-stable']?.defaultVersion).toBeUndefined()
})

it('reports a provided bundle without a version', async () => {
  serve(json(index([entry('shipped')])))
  const { market } = await mount({}, { bundles: [bundle('shipped', { installed: false, optional: true, availability: 'installation' })] })
  expect((await read(market, URL_A)).entries[0]?.installation).toEqual({ status: 'provided' })
})

it('shares concurrent reads, caches documents, and refetches on refresh or expiry', async () => {
  vi.useFakeTimers()
  const release = Promise.withResolvers<Response>()
  const fetch = serve(() => release.promise, json(index()), json({ format: 1, title: 'Renamed', plugins: [] }))
  const { market } = await mount({ cacheTtlMs: 100 })
  const first = read(market, URL_A)
  const second = read(market, URL_A)
  release.resolve(json(index()))
  await Promise.all([first, second])
  expect(fetch).toHaveBeenCalledTimes(1)
  await read(market, URL_A)
  expect(fetch).toHaveBeenCalledTimes(1)
  await read(market, URL_A, true)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(100)
  expect((await read(market, URL_A)).title).toBe('Renamed')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('refuses an unconfigured URL without fetching', async () => {
  const fetch = serve()
  const { market } = await mount()
  expect(await failure(read(market, URL_B))).toMatchObject({ code: 'plugin-market/unknown-index', details: { url: URL_B } })
  expect(fetch).not.toHaveBeenCalled()
})

it('reports fetch failures and records the last error', async () => {
  const { market } = await mount({ maxBytes: 10 })
  serve(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }))
  expect(await failure(read(market, URL_A))).toMatchObject({ code: 'plugin-market/fetch-failed', details: { reason: 'fetch failed: connect ECONNREFUSED' } })
  const cyclic = new Error('loop')
  cyclic.cause = cyclic
  serve(cyclic)
  expect(await failure(read(market, URL_A))).toMatchObject({ details: { reason: 'loop: loop: loop: loop: loop' } })
  serve(new Error('offline'))
  expect(await failure(read(market, URL_A))).toMatchObject({ code: 'plugin-market/fetch-failed', details: { reason: 'offline' } })
  expect(market.listIndexes()).toEqual([{ url: URL_A, error: `Could not fetch ${URL_A}: offline` }])
})

it.each([
  ['an HTTP failure', () => Promise.resolve(new Response('missing', { status: 404 })), 'HTTP 404'],
  ['a declared oversized body', () => Promise.resolve(new Response('x', { headers: { 'content-length': '11' } })), 'body exceeds 10 bytes'],
  ['a streamed oversized body', () => Promise.resolve(new Response('{"format":1,"x":"long"}')), 'body exceeds 10 bytes'],
  ['a body stream error', () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')) } }))), 'reset'],
  ['a non-Error body stream error', () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error('torn') } }))), 'torn'],
])('refuses %s', async (_label, respond, reason) => {
  vi.stubGlobal('fetch', vi.fn(respond))
  const { market } = await mount({ maxBytes: 10 })
  expect(await failure(read(market, URL_A))).toMatchObject({ code: 'plugin-market/fetch-failed', details: { url: URL_A, reason } })
})

it('reads an empty body as invalid JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null))))
  const { market } = await mount()
  expect(await failure(read(market, URL_A))).toMatchObject({ code: 'plugin-market/invalid-index', details: { path: '$', reason: expect.stringMatching(/^must be JSON: /) as string } })
})

it('reports invalid encodings, JSON, and format violations with their JSON path', async () => {
  const { market } = await mount()
  serve(new Response(new Uint8Array([0xff, 0xfe])))
  expect(await failure(read(market, URL_A))).toMatchObject({ code: 'plugin-market/invalid-index', details: { path: '$', reason: 'must be UTF-8' } })
  serve(new Response('{'))
  expect(await failure(read(market, URL_A))).toMatchObject({ code: 'plugin-market/invalid-index', details: { path: '$', reason: expect.stringMatching(/^must be JSON: /) as string } })
  serve(json(index([entry('x', {}, [release('latest')])])))
  expect(await failure(read(market, URL_A))).toMatchObject({
    code: 'plugin-market/invalid-index', details: { url: URL_A, path: '$.plugins[0].versions[0].version', reason: 'must be an exact SemVer version' },
  })
})

it('keeps state of remaining sources, drops removed ones, and announces changes', async () => {
  serve(json({ format: 1, title: 'A', plugins: [] }), new Error('offline'))
  const { ctx, market, config } = await mount({ indexes: [URL_A, URL_B] })
  await read(market, URL_A)
  await expect(read(market, URL_B)).rejects.toThrow('offline')
  const changed = vi.fn()
  ctx.on('plugin-market/changed', changed)
  updateVolatile(config.indexes, (PluginMarket.Config({ indexes: [URL_A, 'https://user:pw@plain.example/i.json'] }) as Config).indexes)
  ctx.emit('loader/volatile-update', [['indexes']])
  expect(changed).toHaveBeenCalledOnce()
  expect(market.listIndexes()[0]).toEqual({ url: URL_A, title: 'A' })
  updateVolatile(config.indexes, (PluginMarket.Config({ indexes: [URL_A, URL_B] }) as Config).indexes)
  expect(market.listIndexes()).toEqual([{ url: URL_A, title: 'A' }, { url: URL_B }])
})

it('ignores documents finishing after removal', async () => {
  const release = Promise.withResolvers<Response>()
  serve(() => release.promise)
  const { market, config } = await mount()
  const late = read(market, URL_A)
  updateVolatile(config.indexes, (PluginMarket.Config({ indexes: [] }) as Config).indexes)
  release.resolve(json(index()))
  await late
  updateVolatile(config.indexes, (PluginMarket.Config({ indexes: [URL_A] }) as Config).indexes)
  expect(market.listIndexes()).toEqual([{ url: URL_A }])
})

it('ignores failures finishing after removal', async () => {
  const release = Promise.withResolvers<Response>()
  serve(() => release.promise)
  const { market, config } = await mount()
  const late = read(market, URL_A)
  updateVolatile(config.indexes, (PluginMarket.Config({ indexes: [] }) as Config).indexes)
  release.reject(new Error('offline'))
  await expect(late).rejects.toThrow('offline')
  updateVolatile(config.indexes, (PluginMarket.Config({ indexes: [URL_A] }) as Config).indexes)
  expect(market.listIndexes()).toEqual([{ url: URL_A }])
})

it('saves normalized http and https index sources through Settings', async () => {
  const update = vi.fn(() => Promise.resolve())
  const { market } = await mount({}, { settings: update })
  await market.setIndexes([' https://Market.example/index.json', 'http://market.example:8080/i.json'])
  expect(update).toHaveBeenCalledWith('plugin-market', {
    indexes: ['https://market.example/index.json', 'http://market.example:8080/i.json'],
  })
})

it('keeps an already configured unusable source as written while sources around it change', async () => {
  const update = vi.fn(() => Promise.resolve())
  const unusable = 'https://user:pw@plain.example/index.json'
  const { market } = await mount({ indexes: [unusable] }, { settings: update })
  await market.setIndexes([unusable, URL_A])
  expect(update).toHaveBeenCalledWith('plugin-market', { indexes: [unusable, URL_A] })
})

it('counts a new spelling of a kept source as a repeat, and keeps an unparseable configured source', async () => {
  const update = vi.fn(() => Promise.resolve())
  const kept = 'https://Market.example/index.json'
  const { market } = await mount({ indexes: [kept, 'https://['] }, { settings: update })
  expect(await failure(market.setIndexes([kept, 'https://market.example/index.json']))).toMatchObject({ details: { reason: 'duplicate' } })
  await market.setIndexes(['https://[', kept])
  expect(update).toHaveBeenCalledWith('plugin-market', { indexes: ['https://[', kept] })
})

it.each([
  ['not a url', 'not-absolute'],
  ['file:///srv/index.json', 'scheme'],
  ['https://user:pw@market.example/index.json', 'credentials-or-fragment'],
  ['https://market.example/index.json#top', 'credentials-or-fragment'],
  ['https://market.example/index.json#', 'credentials-or-fragment'],
])('refuses the index URL %s', async (url, reason) => {
  const { market } = await mount({}, { settings: () => Promise.resolve() })
  expect(await failure(market.setIndexes([url]))).toMatchObject({ code: 'plugin-market/invalid-index-url', details: { url, reason } })
})

it('refuses a repeated index URL', async () => {
  const { market } = await mount({}, { settings: () => Promise.resolve() })
  expect(await failure(market.setIndexes([URL_A, `${URL_A} `]))).toMatchObject({ code: 'plugin-market/invalid-index-url', details: { url: URL_A, reason: 'duplicate' } })
})

it('refuses to save without Settings or a profile entry', async () => {
  const { market } = await mount()
  expect(await failure(market.setIndexes([URL_A]))).toMatchObject({ code: 'plugin-market/settings-unavailable' })
  const detached = await mount({}, { settings: () => Promise.resolve(), entryId: false })
  expect(await failure(detached.market.setIndexes([URL_A]))).toMatchObject({ code: 'plugin-market/settings-unavailable' })
})

it('lists configured URLs it cannot use with their refusal, never fetches them, and counts a repeat once', async () => {
  const fetch = serve()
  const plain = 'https://user:pw@market.example/index.json'
  const padded = 'https://Market.example/index.json'
  const { market } = await mount({ indexes: [plain, padded, plain] })
  expect(market.listIndexes()).toEqual([
    { url: plain, error: `Index URLs carry no credentials or fragment: ${plain}` },
    { url: padded, error: 'Index URL is not in canonical form; use https://market.example/index.json' },
  ])
  expect(await failure(read(market, plain))).toMatchObject({ code: 'plugin-market/invalid-index-url', details: { url: plain, reason: 'configured' } })
  expect(await failure(read(market, padded))).toMatchObject({ code: 'plugin-market/invalid-index-url' })
  expect(fetch).not.toHaveBeenCalled()
})

it('aborts an in-flight fetch on disposal', async () => {
  let signal: AbortSignal | undefined
  serve(init => new Promise<Response>((_resolve, reject) => {
    signal = init.signal ?? undefined
    signal?.addEventListener('abort', () => { reject(signal?.reason as Error) })
  }))
  const { ctx, market } = await mount()
  const pending = read(market, URL_A).catch((error: unknown) => error)
  await vi.waitFor(() => { expect(signal).toBeDefined() })
  await ctx.fiber.dispose()
  expect(signal?.aborted).toBe(true)
  expect(remoteErrorOf(await pending)).toMatchObject({ code: 'plugin-market/fetch-failed', details: { reason: 'Plugin market disposed' } })
})

const SEARCHABLE = {
  format: 1,
  title: 'Market',
  metadata: {
    categories: { work: { title: { en: 'Productivity', zh: '效率' } }, fun: { title: 'Games' } },
    labels: { official: { title: { en: 'Official', zh: '官方' } }, ui: { title: 'UI' } },
    sortKeys: { downloads: { title: 'Downloads', order: 'desc' } },
  },
  plugins: [
    entry('dsh-weather', {
      description: { en: 'Shows the forecast without review', ja: '天気予報を表示' }, author: 'Kim',
      metadata: { category: 'fun', labels: ['ui'], sortKeys: { downloads: 10 } },
    }, [release('1.0.0', { publishTimestamp: 30 })]),
    entry('dsh-auto-review', {
      title: { en: 'Automatic review', zh: '自动代码审查' },
      metadata: { category: 'work', labels: ['official', 'ui'], keywords: ['lint'], sortKeys: { downloads: 50 } },
    }, [release('2.0.0', { publishTimestamp: 10 }), release('1.0.0', { publishTimestamp: 40 })]),
    entry('dsh-notes', { description: 'Keep a review checklist', metadata: { category: 'work', labels: ['official'] } }, [release('1.0.0', { publishTimestamp: 20 })]),
  ],
}

async function searching() {
  serve(json(SEARCHABLE))
  const { market } = await mount()
  return async (query: Partial<MarketQuery>) => {
    const result = await market.search(URL_A, { sort: { kind: 'index' }, offset: 0, limit: 100, ...query })
    return result.entries.map(item => item.name)
  }
}

it('filters by category and every label, and an undeclared id matches nothing', async () => {
  const names = await searching()
  expect(await names({ category: 'work' })).toEqual(['dsh-auto-review', 'dsh-notes'])
  expect(await names({ labels: ['official', 'ui'] })).toEqual(['dsh-auto-review'])
  expect(await names({ category: 'fun', labels: ['official'] })).toEqual([])
  expect(await names({ category: 'missing' })).toEqual([])
  expect(await names({ labels: ['missing'] })).toEqual([])
})

it.each([
  ['a typo of a word', 'revew', ['dsh-weather', 'dsh-auto-review', 'dsh-notes']],
  ['a word prefix', 'auto', ['dsh-auto-review']],
  ['words that must all match, across fields', 'forecast kim', ['dsh-weather']],
  ['a keyword', 'lint', ['dsh-auto-review']],
  ['Chinese title text', '代码审查', ['dsh-auto-review']],
  ['one CJK character', '审', ['dsh-auto-review']],
  ['the last CJK character of a run', '查', ['dsh-auto-review']],
  ['Japanese description text', '天気', ['dsh-weather']],
  ['a localized category title', '效率', ['dsh-auto-review', 'dsh-notes']],
  ['a label title', 'official', ['dsh-auto-review', 'dsh-notes']],
  ['upper case', 'KIM', ['dsh-weather']],
  ['words from different plugins', 'forecast lint', []],
  ['a short word with a typo', 'dsx', []],
  ['text without words', ' -- ', ['dsh-weather', 'dsh-auto-review', 'dsh-notes']],
])('matches %s', async (_label, text, expected) => {
  const names = await searching()
  expect(await names({ text })).toEqual(expected)
})

it('ranks text matches by relevance, and relevance without text is index order', async () => {
  const names = await searching()
  expect(await names({ text: 'review' })).toEqual(['dsh-weather', 'dsh-auto-review', 'dsh-notes'])
  expect((await names({ text: 'review', sort: { kind: 'relevance' } }))[0]).toBe('dsh-auto-review')
  expect(await names({ text: 'checklist review', sort: { kind: 'relevance' } })).toEqual(['dsh-notes'])
  expect(await names({ sort: { kind: 'relevance' } })).toEqual(['dsh-weather', 'dsh-auto-review', 'dsh-notes'])
})

it('orders by latest publish time or a sort key, placing plugins without the key last in either direction', async () => {
  const names = await searching()
  expect(await names({ sort: { kind: 'published', direction: 'desc' } })).toEqual(['dsh-auto-review', 'dsh-weather', 'dsh-notes'])
  expect(await names({ sort: { kind: 'published', direction: 'asc' } })).toEqual(['dsh-notes', 'dsh-weather', 'dsh-auto-review'])
  expect(await names({ sort: { kind: 'key', id: 'downloads', direction: 'desc' } })).toEqual(['dsh-auto-review', 'dsh-weather', 'dsh-notes'])
  expect(await names({ sort: { kind: 'key', id: 'downloads', direction: 'asc' } })).toEqual(['dsh-weather', 'dsh-auto-review', 'dsh-notes'])
  expect(await names({ sort: { kind: 'key', id: 'missing', direction: 'asc' } })).toEqual(['dsh-weather', 'dsh-auto-review', 'dsh-notes'])
})

it('pages matches with their total, and annotates only the returned page', async () => {
  serve(json(SEARCHABLE))
  const { ctx, market } = await mount()
  const listBundles = vi.spyOn(ctx.pluginManager, 'listBundles')
  const first = await market.search(URL_A, { sort: { kind: 'index' }, offset: 0, limit: 2 })
  expect(first).toMatchObject({ url: URL_A, title: 'Market', total: 3, nextOffset: 2, metadata: SEARCHABLE.metadata })
  expect(first.entries.map(item => [item.name, item.defaultVersion])).toEqual([['dsh-weather', '1.0.0'], ['dsh-auto-review', '2.0.0']])
  const last = await market.search(URL_A, { sort: { kind: 'index' }, offset: 2, limit: 2 })
  expect(last).toMatchObject({ total: 3, nextOffset: null, fetchedAt: first.fetchedAt })
  expect(last.entries.map(item => item.name)).toEqual(['dsh-notes'])
  expect(await market.search(URL_A, { sort: { kind: 'index' }, offset: 5, limit: 2 })).toMatchObject({ entries: [], total: 3, nextOffset: null })
  expect(listBundles).toHaveBeenCalledTimes(3)
})

it('names a new document with a new fetch time', async () => {
  vi.useFakeTimers({ now: 1000 })
  serve(json(SEARCHABLE), json(SEARCHABLE))
  const { market } = await mount()
  expect((await read(market, URL_A)).fetchedAt).toBe(1000)
  await vi.advanceTimersByTimeAsync(5)
  expect((await read(market, URL_A)).fetchedAt).toBe(1000)
  expect((await read(market, URL_A, true)).fetchedAt).toBe(1005)
})

it.each([
  [{ offset: -1 }, 'offset'],
  [{ offset: 0.5 }, 'offset'],
  [{ limit: 0 }, 'limit'],
  [{ limit: 101 }, 'limit'],
  [{ limit: 1.5 }, 'limit'],
])('refuses the page %j without fetching', async (page, field) => {
  const fetch = serve()
  const { market } = await mount()
  expect(await failure(market.search(URL_A, { sort: { kind: 'index' }, offset: 0, limit: 10, ...page })))
    .toMatchObject({ code: 'plugin-market/invalid-query', details: { field, reason: 'range' } })
  expect(fetch).not.toHaveBeenCalled()
})

it('reads one plugin by name from the cached document', async () => {
  const fetch = serve(json(SEARCHABLE))
  const { market } = await mount({}, { bundles: [bundle('dsh-notes', { version: '1.0.0' })] })
  expect(await market.entry(URL_A, 'dsh-notes')).toMatchObject({ name: 'dsh-notes', defaultVersion: '1.0.0', installation: { status: 'installed' } })
  expect(await market.entry(URL_A, 'dsh-missing')).toBeUndefined()
  expect(fetch).toHaveBeenCalledOnce()
  expect(await failure(market.entry(URL_B, 'dsh-notes'))).toMatchObject({ code: 'plugin-market/unknown-index' })
})

it('keeps index order among equal sort-key values and among plugins without one', async () => {
  const valued = (name: string, downloads?: number) => entry(name, { metadata: { sortKeys: downloads === undefined ? {} : { downloads } } })
  serve(json({ ...SEARCHABLE, plugins: [valued('a'), valued('b', 1), valued('c'), valued('d', 2), valued('e', 1)] }))
  const { market } = await mount()
  for (const [direction, expected] of [['asc', ['b', 'e', 'd', 'a', 'c']], ['desc', ['d', 'b', 'e', 'a', 'c']]] as const) {
    const result = await market.search(URL_A, { sort: { kind: 'key', id: 'downloads', direction }, offset: 0, limit: 10 })
    expect(result.entries.map(item => item.name)).toEqual(expected)
  }
})

it.each([
  ['CJK text after Latin text', '预览', ['p-md']],
  ['Latin text between CJK text', 'markdown', ['p-md']],
  ['CJK text after a Latin word', '插件', ['p-vue']],
  ['katakana with the prolonged sound mark', 'ヒー', ['p-coffee']],
  ['a later katakana word', 'サーバー', ['p-coffee']],
  ['the iteration mark', '々木', ['p-sasaki']],
  ['full-width letters as ASCII', 'abc', ['p-full']],
  ['a decomposed accent as its composed form', 'café', ['p-cafe']],
  ['decomposed Hangul as composed syllables', '국어', ['p-hangul']],
  ['half-width katakana as full-width', 'パソコン', ['p-kana']],
  ['a compatibility character as its decomposition', '㈱', ['p-kabu']],
  ['a long word two edits away', 'internaxionalizatiox', ['p-full']],
  ['a long word three edits away', 'internaxionalixatiox', []],
])('splits and normalizes text: %s', async (_label, text, expected) => {
  serve(json({
    format: 1,
    title: 'Scripts',
    plugins: [
      entry('p-md', { description: '支持Markdown预览' }),
      entry('p-vue', { title: 'Vue插件' }),
      entry('p-coffee', { title: 'コーヒーサーバー' }),
      entry('p-sasaki', { author: '佐々木' }),
      entry('p-full', { title: 'ＡＢＣ Tools', metadata: { keywords: ['internationalization'] } }),
      entry('p-cafe', { description: 'cafe\u0301 menu' }),
      entry('p-hangul', { title: '한국어'.normalize('NFD') }),
      entry('p-kana', { title: 'ﾊﾟｿｺﾝ' }),
      entry('p-kabu', { author: '株' }),
    ],
  }))
  const { market } = await mount()
  const result = await market.search(URL_A, { text, sort: { kind: 'index' }, offset: 0, limit: 10 })
  expect(result.entries.map(item => item.name)).toEqual(expected)
})

it('answers later pages from a pinned document after it expires, until another fetch replaces it', async () => {
  vi.useFakeTimers({ now: 1000 })
  const fetch = serve(json(SEARCHABLE), json({ ...SEARCHABLE, title: 'Replaced' }))
  const { market } = await mount({ cacheTtlMs: 100 })
  const page = (fields: Partial<MarketQuery>) => market.search(URL_A, { sort: { kind: 'index' }, offset: 2, limit: 2, ...fields })
  const first = await page({ offset: 0 })
  await vi.advanceTimersByTimeAsync(100)
  expect(await page({ fetchedAt: first.fetchedAt })).toMatchObject({ title: 'Market', fetchedAt: first.fetchedAt })
  expect(fetch).toHaveBeenCalledOnce()
  const replaced = await page({})
  expect(replaced).toMatchObject({ title: 'Replaced', fetchedAt: 1100 })
  expect(await page({ fetchedAt: first.fetchedAt })).toMatchObject({ title: 'Replaced', fetchedAt: 1100 })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('gives a new document a new fetch time within the same millisecond', async () => {
  vi.useFakeTimers({ now: 1000 })
  serve(json(SEARCHABLE), json(SEARCHABLE))
  const { market } = await mount()
  expect((await read(market, URL_A)).fetchedAt).toBe(1000)
  expect((await read(market, URL_A, true)).fetchedAt).toBe(1001)
})
