// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketListingEntry, MarketListingVersion, MarketSearchResult } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { DiscoverSection, type DiscoverSectionProps } from '../src/client/DiscoverSection.tsx'
import type { DetailsState, DiscoverState, ListingState } from '../src/client/market-store.ts'
import { INITIAL_QUERY, type DiscoverQuery } from '../src/client/presentation.ts'
import { en, zh, type PluginMarketLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

function translator(dictionary: Record<PluginMarketLocaleKey, string>): DiscoverSectionProps['t'] {
  return ((key: PluginMarketLocaleKey, params?: Record<string, string>): string =>
    Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replaceAll(`{${name}}`, value), dictionary[key])) as DiscoverSectionProps['t']
}

const A = 'https://a.example/index.json'
const B = 'https://b.example/index.json'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function release(name: string, version: string, fields: Partial<MarketListingVersion> = {}): MarketListingVersion {
  return {
    version, publishTimestamp: 1790476800, source: { type: 'npm' }, engines: {},
    install: { spec: `${name}@${version}` }, compatibility: { compatible: true }, ...fields,
  }
}

const INCOMPATIBLE = { compatible: false, runtimeVersion: '0.2.0', requirements: { 'engines.dsh': '0.1.0' } } as const

function entry(
  name: string, fields: Partial<MarketListingEntry> = {}, metadata: Partial<MarketListingEntry['metadata']> = {},
  version: Partial<MarketListingVersion> = {},
): MarketListingEntry {
  const only = release(name, '1.0.0', version)
  return {
    name, versions: [only], ...installableDefault(only), installation: { status: 'not-installed' },
    ...fields, metadata: { keywords: [], labels: [], sortKeys: {}, ...metadata },
  }
}

function installableDefault(version: MarketListingVersion): { defaultVersion?: string } {
  return version.compatibility.compatible ? { defaultVersion: version.version } : {}
}

const LISTING: MarketSearchResult = {
  url: A,
  fetchedAt: 1,
  total: 6,
  nextOffset: null,
  title: { en: 'Alpha index', zh: '甲索引' },
  metadata: {
    categories: { tools: { title: 'Tools' }, themes: { title: 'Themes' } },
    labels: { official: { title: 'Official' }, beta: { title: 'Beta' } },
    sortKeys: { downloads: { title: 'Downloads', order: 'desc' } },
  },
  entries: [
    entry('dsh-a', {
      title: { en: 'Alpha', zh: '甲' }, description: 'Does A', author: 'Jane', icon: 'https://cdn.example/a.png',
      homepage: 'https://example.com/alpha#readme', repository: { url: 'https://github.com/o/plugins', directory: 'packages/a' },
    }, { category: 'tools', labels: ['official', 'beta'], sortKeys: { downloads: 1 } }, {
      source: { type: 'npm', registry: 'https://r.example/' }, install: { spec: 'dsh-a@1.0.0', registry: 'https://r.example/' },
    }),
    entry('dsh-b', { installation: { status: 'installed', installedVersion: '1.0.0' } }, { category: 'themes', labels: ['official'], sortKeys: { downloads: 9 } }, {
      publishTimestamp: 1790000000, source: { type: 'git', url: 'https://github.com/o/r', commit: COMMIT, path: 'packages/b' },
    }),
    entry('dsh-c', { installation: { status: 'update-available', installedVersion: '0.9.0' }, repository: { url: 'https://git.example/o/c' } }),
    entry('dsh-f', { installation: { status: 'provided' } }, {}, { source: { type: 'git', url: 'https://github.com/o/f', commit: COMMIT } }),
    entry('dsh-g', {}, {}, { compatibility: { ...INCOMPATIBLE, exempted: false } }),
    entry('dsh-h', {}, {}, { compatibility: { ...INCOMPATIBLE, exempted: true } }),
  ],
}

const READY: DiscoverState = {
  status: 'ready', indexes: [{ url: A, title: LISTING.title }, { url: B }], selected: A,
  listing: { url: A, query: INITIAL_QUERY, status: 'ready', value: LISTING, answered: INITIAL_QUERY, failure: null }, editing: false, draft: '', saving: false, sourceFailure: null,
}

function renderTab(state: Partial<DiscoverState> = {}, dictionary: Record<PluginMarketLocaleKey, string> = en) {
  const store = createSnapshotStore<DiscoverState>({ ...READY, ...state })
  const language = dictionary === en ? 'en' : 'zh'
  const locale = createSnapshotStore<LocaleSnapshot>({ active: language, locales: [], revision: 0 })
  const actions = {
    ensure: vi.fn(), reload: vi.fn(), select: vi.fn(), search: vi.fn(), more: vi.fn(), refresh: vi.fn(), retry: vi.fn(),
    toggleSources: vi.fn(),
    editDraft: vi.fn(), addSource: vi.fn(), removeSource: vi.fn(),
    loadDetail: vi.fn(), retryDetail: vi.fn(), detailImage: vi.fn(() => undefined),
  }
  const install = vi.fn()
  const openPackage = vi.fn()
  const props = {
    t: translator(dictionary), install, openPackage, ...actions,
    resolveText: (text: string | Record<string, string>) => typeof text === 'string' ? text : text[language] ?? text.en,
    useDiscover: bindSnapshotSelector(store),
    useLocale: bindSnapshotSelector(locale),
    useDetails: bindSnapshotSelector(createSnapshotStore<DetailsState>({})),
  } as DiscoverSectionProps
  render(<DiscoverSection {...props} />)
  const set = (next: Partial<DiscoverState>): void => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) }
  /** Show the selected listing answering `query`, as the Controller publishes it. */
  const answer = (query: DiscoverQuery, value: Partial<MarketSearchResult> = {}): void => {
    set({ listing: { ...store.getSnapshot().listing as ListingState, query, value: { ...LISTING, ...value }, answered: query } })
  }
  return { actions, install, openPackage, set, answer }
}

const names = (): string[] => Array.from(document.querySelectorAll('[data-market-entry]')).map(node => node.getAttribute('data-market-entry') ?? '')
const card = (name: string) => within(document.querySelector(`[data-market-entry="${name}"]`) as HTMLElement)
const openMenu = (name: RegExp | string): void => { fireEvent.click(screen.getByRole('button', { name })) }
const pick = (name: string): void => { fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(name) })) }

describe('DiscoverSection', () => {
  it('shows the list skeleton until the sources are read, and a retry when they cannot be', () => {
    const { actions, set } = renderTab({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledOnce()
    expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    set({ status: 'error' })
    expect(screen.getByRole('alert').textContent).toBe(en.sourcesFailed)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.reload).toHaveBeenCalledOnce()
  })

  it('offers adding a first source when none is configured', () => {
    const { actions } = renderTab({ indexes: [], selected: null, listing: null })
    expect(screen.getByText(en.emptyTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.addFirstSource }))
    expect(actions.toggleSources).toHaveBeenCalledOnce()
  })

  it('lists entries with one action each: install after confirmation, or open the installed bundle', () => {
    const { install, openPackage } = renderTab()
    expect(names()).toEqual(['dsh-a', 'dsh-b', 'dsh-c', 'dsh-f', 'dsh-g', 'dsh-h'])
    expect(card('dsh-a').getByText('Official')).toBeTruthy()
    expect(card('dsh-a').getByText('Does A')).toBeTruthy()
    expect(card('dsh-a').getByText(/^1\.0\.0 · Jane · /)).toBeTruthy()
    expect(card('dsh-c').getByText(/^1\.0\.0 · Sep/)).toBeTruthy()
    fireEvent.click(card('dsh-a').getByRole('button', { name: 'Install Alpha' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Install "Alpha"?' }))
    expect(dialog.getByText('dsh-a@1.0.0')).toBeTruthy()
    expect(dialog.getByText('https://r.example/')).toBeTruthy()
    expect(dialog.getByText('Jane')).toBeTruthy()
    expect(dialog.getByText(en.installTrust)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(card('dsh-a').getByRole('button', { name: 'Install Alpha' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.install }))
    expect(install).toHaveBeenCalledWith({ spec: 'dsh-a@1.0.0', registry: 'https://r.example/', title: 'Alpha', version: '1.0.0' })
    expect(screen.queryByRole('dialog')).toBeNull()
    for (const [name, label] of [['dsh-b', en.statusInstalled], ['dsh-c', en.statusUpdate], ['dsh-f', en.statusProvided]] as const) {
      fireEvent.click(card(name).getByRole('button', { name: `View ${name} in Installed` }))
      expect(card(name).getByText(label)).toBeTruthy()
      expect(openPackage).toHaveBeenLastCalledWith(name)
    }
    // An incompatible entry cannot be installed; an exempted one can, and its dialog says why.
    fireEvent.click(card('dsh-g').getByRole('button', { name: 'Install dsh-g' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(card('dsh-g').getByRole('button', { name: 'Install dsh-g' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(card('dsh-h').getByRole('button', { name: 'Install dsh-h' }))
    expect(within(screen.getByRole('dialog')).getByText(en.exempted)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('falls back to the default artwork when an icon fails to load', () => {
    renderTab()
    const image = document.querySelector('[data-market-entry="dsh-a"] img') as HTMLImageElement
    expect(image.getAttribute('loading')).toBe('lazy')
    fireEvent.error(image)
    expect(document.querySelector('[data-market-entry="dsh-a"] img')).toBeNull()
  })

  it('sends typed text after a pause, ordered by relevance, and offers that order only with text', () => {
    vi.useFakeTimers()
    try {
      const { actions, answer } = renderTab()
      const box = screen.getByRole('searchbox', { name: en.search })
      fireEvent.change(box, { target: { value: 'do' } })
      fireEvent.change(box, { target: { value: 'does a' } })
      act(() => { vi.advanceTimersByTime(249) })
      expect(actions.search).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      const typed = { ...INITIAL_QUERY, text: 'does a', sort: { kind: 'relevance' } } as const
      expect(actions.search).toHaveBeenCalledExactlyOnceWith(typed)
      answer(typed, { entries: LISTING.entries.slice(0, 1), total: 1 })
      expect(names()).toEqual(['dsh-a'])
      openMenu(/^Sort: Best match/)
      pick(en.sortDefault)
      expect(actions.search).toHaveBeenLastCalledWith({ ...typed, sort: { kind: 'index' } })
      answer({ ...typed, sort: { kind: 'index' } })
      openMenu(/^Sort: Default order/)
      pick(en.sortRelevance)
      expect(actions.search).toHaveBeenLastCalledWith(typed)
      fireEvent.change(box, { target: { value: '' } })
      act(() => { vi.advanceTimersByTime(250) })
      expect(actions.search).toHaveBeenLastCalledWith({ ...INITIAL_QUERY, sort: { kind: 'index' } })
      answer(INITIAL_QUERY)
      openMenu(/^Sort: Default order/)
      expect(screen.queryByRole('menuitem', { name: en.sortRelevance })).toBeNull()
      expect(actions.search).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('filters by category and labels, and tells an empty index from no matches', () => {
    const { actions, answer, set } = renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Themes' }))
    expect(actions.search).toHaveBeenLastCalledWith({ ...INITIAL_QUERY, category: 'themes' })
    answer({ ...INITIAL_QUERY, category: 'themes' })
    expect(screen.getByRole('button', { name: 'Themes' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: en.allCategories }))
    expect(actions.search).toHaveBeenLastCalledWith(INITIAL_QUERY)
    openMenu(en.filter)
    pick('Beta')
    expect(actions.search).toHaveBeenLastCalledWith({ ...INITIAL_QUERY, labels: ['beta'], category: 'themes' })
    answer({ ...INITIAL_QUERY, labels: ['beta'] })
    expect(screen.getByRole('button', { name: 'Labels · 1' })).toBeTruthy()
    pick('Beta')
    expect(actions.search).toHaveBeenLastCalledWith(INITIAL_QUERY)
    pick('Official')
    expect(actions.search).toHaveBeenLastCalledWith({ ...INITIAL_QUERY, labels: ['beta', 'official'] })
    answer({ ...INITIAL_QUERY, labels: ['beta'] }, { entries: [], total: 0 })
    expect(screen.getByText(en.noMatches)).toBeTruthy()
    // Clearing the filters keeps the filtered results' wording until the unfiltered answer arrives.
    set({ listing: { ...READY.listing as ListingState, status: 'loading', value: { ...LISTING, entries: [], total: 0 }, answered: { ...INITIAL_QUERY, labels: ['beta'] } } })
    expect(screen.getByText(en.noMatches)).toBeTruthy()
    answer(INITIAL_QUERY, { entries: [], total: 0 })
    expect(screen.getByText(en.emptyIndex)).toBeTruthy()
  })

  it('sorts by publish date, an index sort key, either direction, and back to the index order', () => {
    const { actions, answer } = renderTab()
    openMenu(/^Sort: Default order/)
    pick(en.sortPublished)
    const published = { ...INITIAL_QUERY, sort: { kind: 'published', direction: 'desc' } } as const
    expect(actions.search).toHaveBeenLastCalledWith(published)
    answer(published)
    openMenu(/^Sort: Publish date/)
    pick(en.switchToAscending)
    expect(actions.search).toHaveBeenLastCalledWith({ ...INITIAL_QUERY, sort: { kind: 'published', direction: 'asc' } })
    answer({ ...INITIAL_QUERY, sort: { kind: 'published', direction: 'asc' } })
    openMenu(/^Sort: Publish date/)
    pick(en.switchToDescending)
    expect(actions.search).toHaveBeenLastCalledWith(published)
    openMenu(/^Sort:/)
    pick('Downloads')
    const downloads = { ...INITIAL_QUERY, sort: { kind: 'key', id: 'downloads', direction: 'desc' } } as const
    expect(actions.search).toHaveBeenLastCalledWith(downloads)
    answer(downloads)
    openMenu(/^Sort: Downloads/)
    pick(en.sortDefault)
    expect(actions.search).toHaveBeenLastCalledWith(INITIAL_QUERY)
    answer(INITIAL_QUERY)
    openMenu(/^Sort: Default order/)
    expect(screen.queryByRole('menuitem', { name: en.switchToAscending })).toBeNull()
    for (const name of [/^Sort:/, en.filter, /^Switch plugin index/]) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      openMenu(name)
      expect(screen.getByRole('menu')).toBeTruthy()
    }
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    openMenu(/^Switch plugin index/)
    openMenu(/^Switch plugin index/)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('switches indexes and opens source management from the index menu', () => {
    const { actions } = renderTab()
    openMenu('Switch plugin index, currently Alpha index')
    pick('b.example')
    expect(actions.select).toHaveBeenCalledWith(B)
    openMenu(/^Switch plugin index/)
    pick(en.manageSources)
    expect(actions.toggleSources).toHaveBeenCalledOnce()
  })

  it('opens an entry page with its source facts and actions, and returns to the list', () => {
    const { install, openPackage, actions } = renderTab()
    fireEvent.click(card('dsh-a').getByRole('button', { name: 'View Alpha' }))
    const detail = within(document.querySelector('[data-market-detail="dsh-a"]') as HTMLElement)
    expect(actions.loadDetail).toHaveBeenCalledWith({ url: A, name: 'dsh-a', version: '1.0.0', npm: true }, 'en')
    expect(detail.getByRole('status', { name: en.detailLoading })).toBeTruthy()
    expect(detail.getByRole('heading', { name: 'Alpha' })).toBeTruthy()
    expect(detail.getByText('dsh-a')).toBeTruthy()
    for (const value of ['Jane', 'dsh-a@1.0.0', 'https://r.example/', 'Tools', 'Official', 'Beta', 'Alpha index']) expect(detail.getByText(value)).toBeTruthy()
    const homepage = detail.getByRole('link', { name: 'https://example.com/alpha#readme' })
    expect([homepage.getAttribute('href'), homepage.getAttribute('target'), homepage.getAttribute('rel')])
      .toEqual(['https://example.com/alpha#readme', '_blank', 'noopener noreferrer'])
    const repository = detail.getByRole('link', { name: 'https://github.com/o/plugins' })
    expect([repository.getAttribute('href'), repository.getAttribute('target')]).toEqual(['https://github.com/o/plugins', '_blank'])
    expect(detail.getByText(en.factSourceCode)).toBeTruthy()
    expect(detail.getByText('packages/a')).toBeTruthy()
    fireEvent.click(detail.getByRole('button', { name: 'Install Alpha' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.install }))
    expect(install).toHaveBeenCalledOnce()
    fireEvent.click(detail.getByRole('button', { name: en.backToList }))
    fireEvent.click(card('dsh-b').getByRole('button', { name: 'View dsh-b' }))
    const git = within(document.querySelector('[data-market-detail="dsh-b"]') as HTMLElement)
    expect(actions.loadDetail).toHaveBeenLastCalledWith({ url: A, name: 'dsh-b', version: '1.0.0', npm: false }, 'en')
    expect(git.queryByRole('link')).toBeNull()
    for (const value of ['https://github.com/o/r', COMMIT, 'packages/b', 'Themes']) expect(git.getByText(value)).toBeTruthy()
    fireEvent.click(git.getByRole('button', { name: 'View dsh-b in Installed' }))
    expect(openPackage).toHaveBeenCalledWith('dsh-b')
    fireEvent.click(git.getByRole('button', { name: en.backToList }))
    fireEvent.click(card('dsh-g').getByRole('button', { name: 'View dsh-g' }))
    expect(screen.getAllByText('This version is not compatible with the running DSH 0.2.0; it requires DSH 0.1.0.')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(card('dsh-h').getByRole('button', { name: 'View dsh-h' }))
    expect(screen.getAllByText(en.exempted)).toHaveLength(2)
  })

  it('links a repository without a directory', () => {
    renderTab()
    fireEvent.click(card('dsh-c').getByRole('button', { name: 'View dsh-c' }))
    const detail = within(document.querySelector('[data-market-detail="dsh-c"]') as HTMLElement)
    expect(detail.getByRole('link', { name: 'https://git.example/o/c' }).closest('dd')?.querySelector('code')).toBeNull()
  })

  it('lists every version on the entry page and installs the one chosen', () => {
    const name = 'dsh-v'
    const versions = [
      release(name, '3.0.0-rc.1'),
      release(name, '2.0.0', { compatibility: { ...INCOMPATIBLE, exempted: false } }),
      release(name, '1.1.0'),
      release(name, '1.0.0+build.1', { publishTimestamp: 1780000000 }),
    ]
    const multi: MarketListingEntry = {
      name, versions, defaultVersion: '1.1.0', installation: { status: 'different-version', installedVersion: '1.0.0+build.1' },
      metadata: { keywords: [], labels: [], sortKeys: {} },
    }
    const { install } = renderTab({ listing: { url: A, query: INITIAL_QUERY, status: 'ready', value: { ...LISTING, entries: [multi] }, answered: INITIAL_QUERY, failure: null } })
    expect(card(name).getByText(/^1\.1\.0 · /)).toBeTruthy()
    fireEvent.click(card(name).getByRole('button', { name: `View ${name}` }))
    const list = within(screen.getByRole('list', { name: `Versions of ${name}` }))
    const row = (version: string) => within(document.querySelector(`[data-market-version="${version}"]`) as HTMLElement)
    expect(Array.from(document.querySelectorAll('[data-market-version]')).map(node => node.getAttribute('data-market-version')))
      .toEqual(['3.0.0-rc.1', '2.0.0', '1.1.0', '1.0.0+build.1'])
    expect(row('3.0.0-rc.1').getByText(en.versionPrerelease)).toBeTruthy()
    expect(row('2.0.0').getByText(en.versionIncompatible)).toBeTruthy()
    expect(row('2.0.0').queryByRole('button')).toBeNull()
    expect(row('1.1.0').getByText(en.versionDefault)).toBeTruthy()
    expect(row('1.0.0+build.1').getByText(en.versionInstalled)).toBeTruthy()
    expect(row('1.0.0+build.1').queryByText(en.versionPrerelease)).toBeNull()
    expect(row('1.0.0+build.1').queryByRole('button')).toBeNull()
    fireEvent.click(list.getByRole('button', { name: `Install ${name} 3.0.0-rc.1` }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('dsh-v@3.0.0-rc.1')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: en.install }))
    expect(install).toHaveBeenCalledWith({ spec: 'dsh-v@3.0.0-rc.1', title: 'dsh-v', version: '3.0.0-rc.1' })
  })

  it('marks exempted versions and offers no version of a bundle DSH provides', () => {
    const name = 'dsh-x'
    const exempted = release(name, '2.0.0', { compatibility: { ...INCOMPATIBLE, exempted: true } })
    const entries: MarketListingEntry[] = [
      { name, versions: [exempted], installation: { status: 'not-installed' }, metadata: { keywords: [], labels: [], sortKeys: {} } },
      entry('dsh-p', { installation: { status: 'provided', installedVersion: '0.9.0' } }),
    ]
    renderTab({ listing: { url: A, query: INITIAL_QUERY, status: 'ready', value: { ...LISTING, entries }, answered: INITIAL_QUERY, failure: null } })
    fireEvent.click(card(name).getByRole('button', { name: `View ${name}` }))
    const row = within(document.querySelector('[data-market-version="2.0.0"]') as HTMLElement)
    expect(row.getByText(en.versionExempted)).toBeTruthy()
    expect(row.getAllByText(en.exempted).length).toBeGreaterThan(0)
    expect(row.getByRole('button', { name: `Install ${name} 2.0.0` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(card('dsh-p').getByRole('button', { name: 'View dsh-p' }))
    expect(within(document.querySelector('[data-market-version="1.0.0"]') as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('asks for the next page while the Host has more', () => {
    const many = Array.from({ length: 50 }, (_, index) => entry(`dsh-${String(index).padStart(3, '0')}`))
    const { actions, set } = renderTab({
      listing: { url: A, query: INITIAL_QUERY, status: 'ready', value: { ...LISTING, metadata: { categories: {}, labels: {}, sortKeys: {} }, entries: many, total: 120, nextOffset: 50 }, answered: INITIAL_QUERY, failure: null },
    })
    expect(names()).toHaveLength(50)
    expect(screen.queryByRole('group', { name: en.categoriesLabel })).toBeNull()
    expect(screen.queryByRole('button', { name: en.filter })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.showMore }))
    expect(actions.more).toHaveBeenCalledOnce()
    const value = { ...LISTING, entries: many, total: 50, nextOffset: null }
    const listing = { url: A, query: INITIAL_QUERY, value, answered: INITIAL_QUERY, failure: null }
    set({ listing: { ...listing, status: 'more', value: { ...listing.value, nextOffset: 50 } } })
    expect(screen.getByRole('button', { name: en.showMore }).hasAttribute('disabled')).toBe(true)
    set({ listing: { ...listing, status: 'ready' } })
    expect(screen.queryByRole('button', { name: en.showMore })).toBeNull()
  })

  it('keeps an opened entry page when a reload no longer includes it, and shows its latest state when it does', () => {
    const { answer } = renderTab()
    fireEvent.click(card('dsh-a').getByRole('button', { name: 'View Alpha' }))
    answer(INITIAL_QUERY, { entries: LISTING.entries.slice(1) })
    expect(document.querySelector('[data-market-detail="dsh-a"]')).toBeTruthy()
    const installed = { ...LISTING.entries[0] as MarketListingEntry, installation: { status: 'installed', installedVersion: '1.0.0' } } as const
    answer(INITIAL_QUERY, { entries: [installed] })
    expect(screen.getByRole('button', { name: 'View Alpha in Installed' })).toBeTruthy()
  })

  it('keeps the listing beside a failed read, and shows an empty index, a first read, and a refresh in flight', () => {
    const { actions, set } = renderTab()
    set({ listing: { url: A, query: INITIAL_QUERY, status: 'error', value: LISTING, answered: INITIAL_QUERY, failure: 'fetch' } })
    expect(screen.getByRole('alert').textContent).toBe(en.readFailed)
    expect(names()).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.retry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(actions.refresh).toHaveBeenCalledOnce()
    set({ listing: { url: A, query: INITIAL_QUERY, status: 'error', value: LISTING, answered: INITIAL_QUERY, failure: 'changed' } })
    expect(screen.getByRole('alert').textContent).toBe(en.readChanged)
    set({ listing: { url: A, query: INITIAL_QUERY, status: 'loading', value: LISTING, answered: INITIAL_QUERY, failure: null } })
    expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
    expect(names()).toHaveLength(6)
    set({ listing: { url: A, query: INITIAL_QUERY, status: 'error', value: null, answered: null, failure: 'invalid' } })
    expect(screen.getByRole('alert').textContent).toBe(en.readInvalid)
    set({ listing: { url: A, query: INITIAL_QUERY, status: 'loading', value: null, answered: null, failure: null } })
    expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
    set({ listing: { url: B, query: INITIAL_QUERY, status: 'ready', value: { ...LISTING, url: B, entries: [], total: 0 }, answered: INITIAL_QUERY, failure: null } })
    expect(screen.getByRole('button', { name: 'Switch plugin index, currently b.example' })).toBeTruthy()
  })

  it('manages sources in a dialog with the trust notice and each refusal', () => {
    const { actions, set } = renderTab({ editing: true, draft: 'https://c.example/index.json', indexes: [{ url: A, title: LISTING.title }, { url: B, error: 'HTTP 404' }] })
    const dialog = within(screen.getByRole('dialog', { name: en.sourcesTitle }))
    expect(dialog.getByText(en.sourcesTrust)).toBeTruthy()
    expect(dialog.getByText('Alpha index')).toBeTruthy()
    expect(dialog.getByText(B)).toBeTruthy()
    expect(dialog.getByText('HTTP 404')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: `Remove ${B}` }))
    expect(actions.removeSource).toHaveBeenCalledWith(B)
    fireEvent.change(dialog.getByRole('textbox', { name: en.sourceUrl }), { target: { value: 'x' } })
    expect(actions.editDraft).toHaveBeenCalledWith('x')
    fireEvent.click(dialog.getByRole('button', { name: en.addSource }))
    expect(actions.addSource).toHaveBeenCalledOnce()
    for (const [failure, text] of [
      [{ kind: 'invalid' }, en.sourceInvalid], [{ kind: 'duplicate' }, en.sourceDuplicate],
      [{ kind: 'unavailable' }, en.sourceUnavailable], [{ kind: 'other', reason: 'boom' }, en.sourceFailed],
    ] as const) {
      set({ sourceFailure: failure })
      expect(screen.getByRole('alert').textContent).toBe(text)
    }
    set({ draft: ' ', saving: true })
    expect(screen.getByRole('button', { name: en.addSource }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(actions.toggleSources).toHaveBeenCalledOnce()
    set({ indexes: [] })
    expect(screen.queryByRole('list', { name: en.sourcesLabel })).toBeNull()
  })

  it('renders the Chinese copy and dates', () => {
    renderTab({}, zh)
    expect(screen.getByRole('button', { name: '切换插件索引，当前为 甲索引' })).toBeTruthy()
    expect(card('dsh-a').getByText('甲')).toBeTruthy()
    expect(card('dsh-a').getByText(/^1\.0\.0 · Jane · 2026年9月/)).toBeTruthy()
    expect(card('dsh-b').getByText(zh.statusInstalled)).toBeTruthy()
  })
})
