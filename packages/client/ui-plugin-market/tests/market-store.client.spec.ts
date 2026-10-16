import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { MarketIndexSummary, MarketListingEntry, MarketQuery, MarketSearchResult } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DiscoverController, PAGE_SIZE } from '../src/client/market-store.ts'
import { INITIAL_QUERY } from '../src/client/presentation.ts'

const A = 'https://a.example/index.json'
const B = 'https://b.example/index.json'

function listing(url: string, title = 'Market', description?: string, fields: Partial<MarketSearchResult> = {}): MarketSearchResult {
  const metadata = { categories: {}, labels: {}, sortKeys: {} }
  const page = { fetchedAt: 1, entries: [], total: 0, nextOffset: null }
  return { url, title, ...description === undefined ? {} : { description }, metadata, ...page, ...fields }
}

function plugin(name: string): MarketListingEntry {
  return { name, metadata: { keywords: [], labels: [], sortKeys: {} }, versions: [], installation: { status: 'not-installed' } }
}

/** A Host over `count` plugins named p0, p1, ... answering pages of any query; `fetchedAt` names its document. */
function catalog(count: number, fetchedAt = 1) {
  return (url: string, query: MarketQuery) => {
    const names = Array.from({ length: count }, (_unused, position) => `p${String(position)}`)
    const page = names.slice(query.offset, query.offset + query.limit)
    const next = query.offset + page.length
    return ok(listing(url, 'A', undefined, { fetchedAt, entries: page.map(plugin), total: count, nextOffset: next < count ? next : null }))
  }
}

const FIRST_PAGE = { sort: { kind: 'index' }, offset: 0, limit: PAGE_SIZE }

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RemoteError<never> }
const ok = <T>(value: T): Promise<Answer<T>> => Promise.resolve({ ok: true, value })
const fail = (code: string, message: string, details: object): Promise<Answer<never>> =>
  Promise.resolve({ ok: false, error: new RemoteError(code as never, message, details as never) })

function setup(indexes: MarketIndexSummary[] = [{ url: A }, { url: B }]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  const state = { indexes }
  const market = {
    listIndexes: vi.fn(() => ok(state.indexes)),
    search: vi.fn((url: string, _query: MarketQuery) => ok(listing(url, url === A ? 'A' : 'B', url === A ? 'Desc' : undefined))),
    setIndexes: vi.fn((urls: string[]) => { state.indexes = urls.map(url => ({ url: url.trim() })); return ok(undefined) }),
  }
  new TestRemote(ctx, { pluginMarket: market })
  const controller = new DiscoverController(ctx)
  const face = controller.face(text => typeof text === 'string' ? text : text.en)
  return { controller, face, market, state, snapshot: () => controller.store.getSnapshot() }
}

describe('DiscoverController', () => {
  it('reads sources on first render, selects the first, and reads its listing', async () => {
    const { face, market, snapshot } = setup()
    expect(snapshot().status).toBe('idle')
    face.ensure()
    expect(snapshot().status).toBe('loading')
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    face.ensure()
    expect(market.listIndexes).toHaveBeenCalledOnce()
    expect(snapshot()).toMatchObject({ status: 'ready', selected: A, listing: { url: A, value: { title: 'A' } } })
    expect(snapshot().indexes).toEqual([{ url: A, title: 'A', description: 'Desc' }, { url: B }])
    expect(market.search).toHaveBeenCalledWith(A, FIRST_PAGE)
    expect(face.hooks.locale.getSnapshot().active).toBeTypeOf('string')
  })

  it('switches indexes, refreshes, and keeps the last listing while a refresh fails', async () => {
    const { face, market, snapshot } = setup()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    face.select(A)
    face.select(B)
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ url: B, status: 'ready' }) })
    market.search.mockImplementationOnce(() => fail('plugin-market/fetch-failed', 'x', { url: B, reason: 'offline' }))
    face.refresh()
    expect(snapshot().listing).toMatchObject({ status: 'loading', value: { title: 'B' } })
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('error') })
    expect(market.search).toHaveBeenLastCalledWith(B, { ...FIRST_PAGE, refresh: true })
    expect(snapshot().listing).toMatchObject({ value: { title: 'B' }, failure: 'fetch' })
    expect(snapshot().indexes[1]).toMatchObject({ url: B, error: 'x' })
    market.search.mockImplementationOnce(() => fail('plugin-market/invalid-index', 'y', { url: B, path: '$.format', reason: 'must be 1' }))
    face.refresh()
    await vi.waitFor(() => { expect(snapshot().listing?.failure).toBe('invalid') })
    market.search.mockImplementationOnce(() => fail('plugin-market/unknown-index', 'gone', { url: B }))
    face.refresh()
    await vi.waitFor(() => { expect(snapshot().listing?.failure).toBe('fetch') })
  })

  it('ignores a listing that a newer read superseded', async () => {
    const { face, market, snapshot } = setup()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    const slow = Promise.withResolvers<{ ok: true; value: MarketSearchResult }>()
    market.search.mockImplementationOnce(() => slow.promise)
    face.select(B)
    face.select(A)
    slow.resolve({ ok: true, value: listing(B, 'late') })
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ url: A, status: 'ready' }) })
    expect(snapshot().indexes[1]).toEqual({ url: B })
  })

  it('refresh, search, and more do nothing without a selection, and an empty source list clears the listing', async () => {
    const { face, market, snapshot } = setup([])
    face.refresh()
    face.search(INITIAL_QUERY)
    face.more()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().status).toBe('ready') })
    expect(snapshot()).toMatchObject({ selected: null, listing: null })
    expect(market.search).not.toHaveBeenCalled()
  })

  it('reports a failed source read and reads again on reload', async () => {
    const { face, market, snapshot } = setup()
    market.listIndexes.mockImplementationOnce(() => fail('gateway/internal', 'down', {}))
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().status).toBe('error') })
    face.reload()
    await vi.waitFor(() => { expect(snapshot().status).toBe('ready') })
  })

  it('adds a source and selects it, and removes one', async () => {
    const { face, market, snapshot } = setup([{ url: A }])
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    face.toggleSources()
    expect(snapshot().editing).toBe(true)
    face.addSource()
    expect(market.setIndexes).not.toHaveBeenCalled()
    face.editDraft(` ${B} `)
    face.addSource()
    await vi.waitFor(() => { expect(snapshot().selected).toBe(B) })
    expect(market.setIndexes).toHaveBeenCalledWith([A, B])
    expect(snapshot()).toMatchObject({ draft: '', saving: false })
    face.removeSource(B)
    await vi.waitFor(() => { expect(snapshot().selected).toBe(A) })
    expect(market.setIndexes).toHaveBeenLastCalledWith([A])
    face.removeSource(A)
    await vi.waitFor(() => { expect(snapshot().indexes).toEqual([]) })
    expect(snapshot()).toMatchObject({ editing: false, selected: null, listing: null })
  })

  it.each([
    ['plugin-market/invalid-index-url', { url: 'x', reason: 'scheme' }, { kind: 'invalid' }],
    ['plugin-market/invalid-index-url', { url: 'x', reason: 'duplicate' }, { kind: 'duplicate' }],
    ['plugin-market/settings-unavailable', {}, { kind: 'unavailable' }],
    ['gateway/internal', {}, { kind: 'other', reason: 'broken' }],
  ])('words a refused source change %s', async (code, details, expected) => {
    const { face, market, snapshot } = setup([])
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().status).toBe('ready') })
    market.setIndexes.mockImplementationOnce(() => fail(code, 'broken', details))
    face.editDraft('x')
    face.addSource()
    await vi.waitFor(() => { expect(snapshot().sourceFailure).toEqual(expected) })
    expect(snapshot()).toMatchObject({ saving: false, draft: 'x' })
    face.editDraft('y')
    expect(snapshot().sourceFailure).toBeNull()
  })

  it('reacts to Host changes only after the first render', async () => {
    const { controller, face, market, snapshot } = setup()
    controller.sourcesChanged()
    controller.bundlesChanged()
    expect(market.listIndexes).not.toHaveBeenCalled()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    controller.sourcesChanged()
    await vi.waitFor(() => { expect(market.listIndexes).toHaveBeenCalledTimes(2) })
    controller.bundlesChanged()
    await vi.waitFor(() => { expect(market.search).toHaveBeenCalledTimes(2) })
  })

  it('drops source and listing reads that finish after disposal', async () => {
    const { controller, face, market, snapshot } = setup()
    const pending = Promise.withResolvers<{ ok: true; value: MarketIndexSummary[] }>()
    market.listIndexes.mockImplementationOnce(() => pending.promise)
    face.ensure()
    controller.dispose()
    pending.resolve({ ok: true, value: [{ url: A }] })
    await Promise.resolve()
    expect(snapshot().status).toBe('loading')
  })

  it('drops a listing and a save that finish after disposal', async () => {
    const { controller, face, market, snapshot } = setup()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    const read = Promise.withResolvers<{ ok: true; value: MarketSearchResult }>()
    market.search.mockImplementationOnce(() => read.promise)
    const save = Promise.withResolvers<{ ok: true; value: undefined }>()
    market.setIndexes.mockImplementationOnce(() => save.promise)
    face.refresh()
    face.removeSource(B)
    controller.dispose()
    read.resolve({ ok: true, value: listing(A, 'late') })
    save.resolve({ ok: true, value: undefined })
    await Promise.resolve()
    expect(snapshot().listing?.status).toBe('loading')
  })

  it('sends the query text, filters, and order, and starts each index with the initial query', async () => {
    const { face, market, snapshot } = setup()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    const metadata = { categories: { tools: { title: 'Tools' } }, labels: { ui: { title: 'UI' } }, sortKeys: {} }
    market.search.mockImplementation(url => ok(listing(url, 'A', undefined, { metadata })))
    const query = { text: 'lint', category: 'tools', labels: ['ui'], sort: { kind: 'relevance' } } as const
    face.search(query)
    expect(snapshot().listing).toMatchObject({ query, status: 'loading', value: { title: 'A' } })
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    expect(market.search).toHaveBeenLastCalledWith(A, { text: 'lint', category: 'tools', labels: ['ui'], sort: { kind: 'relevance' }, offset: 0, limit: PAGE_SIZE })
    face.search({ ...INITIAL_QUERY, text: '  ' })
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    expect(market.search).toHaveBeenLastCalledWith(A, FIRST_PAGE)
    face.select(B)
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ url: B, status: 'ready', query: INITIAL_QUERY }) })
  })

  it('drops filters and a sort key the answering index does not declare, and reads again', async () => {
    const { controller, face, market, snapshot } = setup()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    const published: unknown[] = []
    controller.store.subscribe(() => { published.push(snapshot().listing?.status) })
    face.search({ ...INITIAL_QUERY, labels: ['gone'] })
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ status: 'ready', query: INITIAL_QUERY, answered: INITIAL_QUERY }) })
    expect(market.search).toHaveBeenLastCalledWith(A, FIRST_PAGE)
    expect(published.filter(status => status === 'ready')).toHaveLength(1)
  })

  it('appends the next page, and restarts when the Host answers from a new document', async () => {
    const { face, market, snapshot } = setup([{ url: A }])
    market.search.mockImplementation(catalog(120))
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.value?.entries).toHaveLength(PAGE_SIZE) })
    face.more()
    expect(snapshot().listing?.status).toBe('more')
    face.more()
    await vi.waitFor(() => { expect(snapshot().listing?.value?.entries).toHaveLength(2 * PAGE_SIZE) })
    expect(market.search).toHaveBeenCalledTimes(2)
    expect(market.search).toHaveBeenLastCalledWith(A, { ...FIRST_PAGE, offset: PAGE_SIZE, fetchedAt: 1 })
    expect(snapshot().listing?.value).toMatchObject({ total: 120, nextOffset: 2 * PAGE_SIZE })
    market.search.mockImplementation(catalog(120, 2))
    face.more()
    await vi.waitFor(() => { expect(snapshot().listing?.value).toMatchObject({ fetchedAt: 2, nextOffset: null }) })
    expect(snapshot().listing?.value?.entries.map(item => item.name)).toEqual(Array.from({ length: 120 }, (_unused, position) => `p${String(position)}`))
    expect(market.search).toHaveBeenCalledWith(A, { ...FIRST_PAGE, limit: 100 })
    expect(market.search).toHaveBeenLastCalledWith(A, { ...FIRST_PAGE, offset: 100, limit: 50, fetchedAt: 2 })
    face.more()
    expect(snapshot().listing?.status).toBe('ready')
  })

  it('reloads every loaded plugin after bundles change, restarting once on a replaced document', async () => {
    const { controller, face, market, snapshot } = setup([{ url: A }])
    market.search.mockImplementation(catalog(300))
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    for (const loaded of [100, 150]) {
      face.more()
      await vi.waitFor(() => { expect(snapshot().listing?.value?.entries).toHaveLength(loaded) })
    }
    market.search.mockClear()
    market.search.mockImplementationOnce(catalog(300, 2)).mockImplementationOnce(catalog(300, 3)).mockImplementation(catalog(300, 3))
    controller.bundlesChanged()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    expect(snapshot().listing?.value).toMatchObject({ fetchedAt: 3, nextOffset: 150 })
    expect(snapshot().listing?.value?.entries).toHaveLength(150)
    expect(market.search.mock.calls.map(([, query]) => [query.offset, query.limit, query.fetchedAt]))
      .toEqual([[0, 100, undefined], [100, 50, 2], [0, 100, undefined], [100, 50, 3]])
    market.search.mockImplementationOnce(catalog(300, 4)).mockImplementationOnce(catalog(300, 5))
      .mockImplementationOnce(catalog(300, 6)).mockImplementationOnce(catalog(300, 7))
    controller.bundlesChanged()
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ status: 'error', failure: 'changed', value: { fetchedAt: 3 } }) })
  })

  it('keeps the shown plugins when a page fails, and retries the failed read', async () => {
    const { controller, face, market, snapshot } = setup([{ url: A }])
    market.search.mockImplementation(catalog(300))
    face.retry()
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    market.search.mockImplementationOnce(() => fail('plugin-market/fetch-failed', 'x', { url: A, reason: 'offline' }))
    face.more()
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ status: 'error', failure: 'fetch' }) })
    expect(snapshot().listing?.value?.entries).toHaveLength(PAGE_SIZE)
    controller.bundlesChanged()
    expect(market.search).toHaveBeenCalledTimes(2)
    face.retry()
    expect(snapshot().listing).toMatchObject({ status: 'more', failure: null })
    await vi.waitFor(() => { expect(snapshot().listing?.value?.entries).toHaveLength(2 * PAGE_SIZE) })
    expect(market.search).toHaveBeenLastCalledWith(A, { ...FIRST_PAGE, offset: PAGE_SIZE, fetchedAt: 1 })
    face.more()
    await vi.waitFor(() => { expect(snapshot().listing?.value?.entries).toHaveLength(150) })
    market.search.mockImplementationOnce(catalog(300)).mockImplementationOnce(() => fail('plugin-market/fetch-failed', 'y', { url: A, reason: 'reset' }))
    controller.bundlesChanged()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('error') })
    expect(snapshot().listing?.value?.entries).toHaveLength(150)
    market.search.mockClear()
    face.retry()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    expect(market.search.mock.calls.map(([, query]) => [query.offset, query.limit])).toEqual([[0, 100], [100, 50]])
  })

  it('keeps the previous answer beside a failed new query, and pages only results that answer the shown query', async () => {
    const { face, market, snapshot } = setup([{ url: A }])
    market.search.mockImplementation(catalog(120))
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    market.search.mockImplementationOnce(() => fail('plugin-market/invalid-index', 'x', { url: A, path: '$', reason: 'bad' }))
    const typed = { ...INITIAL_QUERY, text: 'x', sort: { kind: 'relevance' } } as const
    face.search(typed)
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ status: 'error', failure: 'invalid', query: typed, answered: INITIAL_QUERY }) })
    face.more()
    expect(market.search).toHaveBeenCalledTimes(2)
    face.retry()
    await vi.waitFor(() => { expect(snapshot().listing).toMatchObject({ status: 'ready', answered: typed }) })
    expect(market.search).toHaveBeenLastCalledWith(A, { ...FIRST_PAGE, text: 'x', sort: { kind: 'relevance' } })
  })

  it('drops a next page that a newer read superseded or that finishes after disposal', async () => {
    const { controller, face, market, snapshot } = setup([{ url: A }])
    market.search.mockImplementation(catalog(120))
    face.ensure()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    const slow = Promise.withResolvers<{ ok: true; value: MarketSearchResult }>()
    market.search.mockImplementationOnce(() => slow.promise)
    face.more()
    face.refresh()
    await vi.waitFor(() => { expect(snapshot().listing?.status).toBe('ready') })
    slow.resolve({ ok: true, value: listing(A, 'late') })
    await Promise.resolve()
    expect(snapshot().listing?.value?.title).toBe('A')
    const late = Promise.withResolvers<{ ok: true; value: MarketSearchResult }>()
    market.search.mockImplementationOnce(() => late.promise)
    face.more()
    controller.dispose()
    late.resolve({ ok: true, value: listing(A, 'late') })
    await Promise.resolve()
    expect(snapshot().listing?.status).toBe('more')
  })
})
