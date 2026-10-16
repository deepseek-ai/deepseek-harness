/** The read-only market listing tool over the same service the Discover page uses. */
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import PluginMarket from '../src/index.ts'
import * as tool from '../src/tools.ts'

const URL_A = 'https://market.example/index.json'

afterEach(() => { vi.unstubAllGlobals() })

function serve(document: unknown) {
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(document))))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve([]) }
    listVersionExemptions() { return { exemptions: {}, warnings: [] } }
  }
  await ctx.plugin(Manager)
  await ctx.plugin(PluginMarket, { indexes: [URL_A] })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(tool)
  const call = async (args: unknown, signal = new AbortController().signal) => {
    const result = await ctx.tools.execute({ name: 'plugin_market', arguments: args, callId: ToolCallId('market-call'), signal })
    return { ...result, json: typeof result.value === 'string' ? JSON.parse(result.value) as Record<string, unknown> : undefined }
  }
  return { ctx, call, fiber }
}

const document = {
  format: 1,
  title: { en: 'Market', zh: '市场' },
  metadata: { categories: { tools: { title: 'Tools' } }, labels: { official: { title: 'Official' } }, sortKeys: { downloads: { title: 'Downloads', order: 'desc' } } },
  plugins: [
    {
      name: 'dsh-a', author: 'Jane', homepage: 'https://example.com/a', repository: { url: 'https://github.com/o/a' },
      title: { en: 'A', zh: '甲' }, description: { en: 'Does A', zh: '做甲' },
      metadata: { category: 'tools', labels: ['official'], sortKeys: { downloads: 5 } },
      versions: [
        { version: '1.0.0', publishTimestamp: 1790476800, source: { type: 'npm', registry: 'https://r.example/' } },
        { version: '2.0.0', publishTimestamp: 1790476900, source: { type: 'npm' }, engines: { dsh: '0.0.1' } },
      ],
    },
    { name: 'dsh-b', versions: [{ version: '2.0.0', publishTimestamp: 0, source: { type: 'git', url: 'https://github.com/o/r', commit: 'a'.repeat(40) }, engines: { dsh: '0.0.1' } }] },
    { name: 'dsh-c', description: 'x'.repeat(400), versions: [{ version: '3.0.0', publishTimestamp: 0, source: { type: 'npm' } }] },
  ],
}

it('lists configured indexes with English titles', async () => {
  serve({ format: 1, title: 'Plain', plugins: [] })
  const { call, ctx } = await fixture()
  expect((await call({ action: 'list_indexes' })).json).toEqual({ indexes: [{ url: URL_A, title: null }] })
  await ctx.pluginMarket.search(URL_A, { sort: { kind: 'index' }, offset: 0, limit: 1 })
  expect((await call({ action: 'list_indexes' })).json).toEqual({ indexes: [{ url: URL_A, title: 'Plain' }] })
  serve({ format: 1, title: { en: 'Localized', zh: '本地化' }, plugins: [] })
  await ctx.pluginMarket.search(URL_A, { sort: { kind: 'index' }, offset: 0, limit: 1, refresh: true })
  expect((await call({ action: 'list_indexes' })).json).toEqual({ indexes: [{ url: URL_A, title: 'Localized' }] })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  await expect(ctx.pluginMarket.search(URL_A, { sort: { kind: 'index' }, offset: 0, limit: 1, refresh: true })).rejects.toThrow()
  expect((await call({ action: 'list_indexes' })).json).toEqual({ indexes: [{ url: URL_A, title: 'Localized', error: `Could not fetch ${URL_A}: offline` }] })
})

it('pages plugins with the default version\'s install target and registry plugin_manager accepts', async () => {
  serve(document)
  const { call } = await fixture()
  const first = await call({ action: 'list_plugins', target: URL_A, limit: 2 })
  expect(first.json).toMatchObject({
    index: 'Market',
    entries: [
      {
        name: 'dsh-a', title: 'A', description: 'Does A', author: 'Jane', homepage: 'https://example.com/a',
        repository: { url: 'https://github.com/o/a' }, category: 'tools',
        labels: ['official'], sortKeys: { downloads: 5 }, installation: { status: 'not-installed' },
        defaultVersion: {
          version: '1.0.0', published: '2026-09-27T02:40:00.000Z', compatibility: { compatible: true },
          install: { target: 'dsh-a@1.0.0', registry: 'https://r.example/' },
        },
        versionCount: 2,
      },
      { name: 'dsh-b', title: 'dsh-b', labels: [], sortKeys: {}, defaultVersion: null, versionCount: 1 },
    ],
    total: 3,
    nextOffset: 2,
  })
  const rest = await call({ action: 'list_plugins', target: URL_A, offset: 2 })
  expect(rest.json).toMatchObject({ entries: [{ name: 'dsh-c', title: 'dsh-c', description: `${'x'.repeat(300)}…` }], total: 3, nextOffset: null })
})

it('lists plugins matching a query by relevance', async () => {
  serve(document)
  const { call } = await fixture()
  expect((await call({ action: 'list_plugins', target: URL_A, query: '做甲' })).json).toMatchObject({ entries: [{ name: 'dsh-a' }], total: 1, nextOffset: null })
  expect((await call({ action: 'list_plugins', target: URL_A, query: '  ' })).json).toMatchObject({ total: 3 })
})

it('pages one plugin\'s versions with their compatibility and install targets', async () => {
  serve(document)
  const { call } = await fixture()
  const first = await call({ action: 'list_versions', target: URL_A, name: 'dsh-a', limit: 1 })
  expect(first.json).toMatchObject({
    name: 'dsh-a', defaultVersion: '1.0.0', total: 2, nextOffset: 1,
    versions: [{ version: '2.0.0', compatibility: { compatible: false, requirements: { 'engines.dsh': '0.0.1' } }, install: { target: 'dsh-a@2.0.0' } }],
  })
  const git = await call({ action: 'list_versions', target: URL_A, name: 'dsh-b' })
  expect(git.json).toMatchObject({ defaultVersion: null, nextOffset: null, versions: [{ install: { target: `git+https://github.com/o/r.git#${'a'.repeat(40)}` } }] })
})

it.each([
  { action: 'list_plugins' },
  { action: 'list_plugins', target: URL_A, offset: -1 },
  { action: 'list_plugins', target: URL_A, limit: 0 },
  { action: 'list_plugins', target: URL_A, limit: 101 },
  { action: 'list_plugins', target: URL_A, offset: 1.5 },
  { action: 'list_plugins', target: 'https://unknown.example/index.json' },
  { action: 'list_versions', name: 'dsh-a' },
  { action: 'list_versions', target: URL_A },
  { action: 'list_versions', target: URL_A, name: 'dsh-a', limit: 101 },
  { action: 'list_versions', target: URL_A, name: 'dsh-missing' },
])('rejects an incomplete, unbounded, or unconfigured request: %j', async (args) => {
  serve(document)
  const { call } = await fixture()
  expect((await call(args)).isError).toBe(true)
})

it('presents a read and disposes its registration', async () => {
  const { ctx, fiber } = await fixture()
  const definition = ctx.tools.get('plugin_market')!
  expect(definition.presentCall?.({ action: 'list_indexes' })).toMatchObject({ card: 'generic', kind: 'read' })
  await fiber.dispose()
  expect(ctx.tools.get('plugin_market')).toBeUndefined()
})

it('stops waiting for a slow index when the call is cancelled, and still caches the shared read', async () => {
  let respond: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve })))
  const { call, ctx } = await fixture()
  const [first, second] = [new AbortController(), new AbortController()]
  const pending = [call({ action: 'list_plugins', target: URL_A }, first.signal), call({ action: 'list_plugins', target: URL_A }, second.signal)]
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
  first.abort(new Error('cancelled by user'))
  second.abort('plain reason')
  for (const result of await Promise.all(pending)) expect(result.isError).toBe(true)
  respond(new Response(JSON.stringify(document)))
  await vi.waitFor(() => { expect(ctx.pluginMarket.listIndexes()[0]?.title).toEqual(document.title) })
})

it('registers the tool only while the pluginMarket service is mounted', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve([]) }
    listVersionExemptions() { return { exemptions: {}, warnings: [] } }
  }
  await ctx.plugin(Manager)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool)
  expect(ctx.tools.get('plugin_market')).toBeUndefined()
  const market = await ctx.plugin(PluginMarket, { indexes: [] })
  await vi.waitFor(() => { expect(ctx.tools.get('plugin_market')).toBeDefined() })
  await market.dispose()
  await vi.waitFor(() => { expect(ctx.tools.get('plugin_market')).toBeUndefined() })
})
