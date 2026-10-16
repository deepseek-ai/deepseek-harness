/** Discover state: configured index sources, the selected index's query and loaded results, and source editing. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketIndexSummary, MarketSearchResult, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { declaredQuery, INITIAL_QUERY, type DiscoverQuery } from './presentation.ts'

/** Why the last listing read failed: the index could not be fetched, is not a valid index, or changed while its pages loaded. */
export type ListingFailure = 'fetch' | 'invalid' | 'changed'

/** Why the last source change was refused. */
export type SourceFailure =
  | { readonly kind: 'invalid' | 'duplicate' | 'unavailable' }
  | { readonly kind: 'other'; readonly reason: string }

/** Plugins loaded before "Show more", and loaded again by each press. */
export const PAGE_SIZE = 50

/** The selected index's query and results. */
export interface ListingState {
  readonly url: string
  readonly query: DiscoverQuery
  /** `loading` while the first pages of a query or a reload run; `more` while the next page runs. */
  readonly status: 'loading' | 'more' | 'ready' | 'error'
  /**
   * Results of this URL: the last page's index facts with the entries of every loaded page. The previous results are
   * kept while a new query, reload, or refresh runs or fails.
   */
  readonly value: MarketSearchResult | null
  /** The query `value` answers; it differs from `query` while a new query runs or after it failed. */
  readonly answered: DiscoverQuery | null
  readonly failure: ListingFailure | null
}

/** Shared Discover state. */
export interface DiscoverState {
  /** `idle` until the tab first renders. */
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly indexes: readonly MarketIndexSummary[]
  readonly selected: string | null
  readonly listing: ListingState | null
  /** Whether the source editor is open; it is always shown when no source exists. */
  readonly editing: boolean
  readonly draft: string
  readonly saving: boolean
  readonly sourceFailure: SourceFailure | null
}

/** What the Discover tab receives through injection. */
export interface DiscoverFace {
  readonly hooks: {
    /** Discover state, bound as `useDiscover`. */
    readonly discover: SnapshotStore<DiscoverState>
    /** The active locale, bound as `useLocale`, for collation. */
    readonly locale: HostObservable<LocaleSnapshot>
  }
  /** Resolve market text in the current language. */
  readonly resolveText: (text: LocalizedText) => string
  /** Read the sources once the tab first renders. */
  readonly ensure: () => void
  /** Read the source list again after it failed. */
  readonly reload: () => void
  readonly select: (url: string) => void
  /** Replace the selected index's query and load its first page. */
  readonly search: (query: DiscoverQuery) => void
  /** Load the next page of the current results. */
  readonly more: () => void
  /** Fetch the selected index again. */
  readonly refresh: () => void
  /** Run the last failed listing read again. */
  readonly retry: () => void
  readonly toggleSources: () => void
  readonly editDraft: (text: string) => void
  readonly addSource: () => void
  readonly removeSource: (url: string) => void
}

/** Largest page the Host returns, the `limit` bound of `pluginMarket.search`. */
const MAX_PAGE = 100

const INITIAL: DiscoverState = {
  status: 'idle', indexes: [], selected: null, listing: null, editing: false, draft: '', saving: false, sourceFailure: null,
}

function sourceFailure(failure: RemoteFailure): SourceFailure {
  if (failure.code === 'plugin-market/invalid-index-url') return { kind: failure.details.reason === 'duplicate' ? 'duplicate' : 'invalid' }
  if (failure.code === 'plugin-market/settings-unavailable') return { kind: 'unavailable' }
  return { kind: 'other', reason: failure.message }
}

function listingFailure(failure: RemoteFailure): ListingFailure {
  return failure.code === 'plugin-market/invalid-index' ? 'invalid' : 'fetch'
}

/** Owns Discover reads and source edits for one Client. */
export class DiscoverController {
  /** Shared Discover state published to the tab. */
  readonly store: SnapshotStore<DiscoverState> = createSnapshotStore<DiscoverState>(INITIAL)
  private disposed = false
  private indexRead = 0
  private listingRead = 0
  /** Select the last source once the list it was added to arrives. */
  private selectAdded = false
  /** Runs the listing read that failed last. */
  private failed: () => void = () => {}

  /** @param ctx - the plugin context whose `remote.pluginMarket` namespace answers. */
  constructor(private readonly ctx: ClientContext) {}

  /** Stop publishing late settlements. */
  dispose(): void {
    this.disposed = true
  }

  /**
   * Build the tab's injected face.
   * @param resolveText - current-language text resolution from the locale service.
   * @returns the tab's injected state sources and actions.
   */
  face(resolveText: DiscoverFace['resolveText']): DiscoverFace {
    return {
      hooks: { discover: this.store, locale: this.ctx.locale },
      resolveText,
      ensure: () => { if (this.state().status === 'idle') void this.loadIndexes() },
      reload: () => { void this.loadIndexes() },
      select: (url) => {
        if (this.state().selected === url) return
        this.patch({ selected: url })
        void this.load(url, INITIAL_QUERY, PAGE_SIZE, false)
      },
      search: (query) => {
        const listing = this.state().listing
        if (listing !== null) void this.load(listing.url, query, PAGE_SIZE, false)
      },
      more: () => { void this.loadMore() },
      retry: () => { this.failed() },
      refresh: () => {
        const listing = this.state().listing
        if (listing !== null) void this.load(listing.url, listing.query, PAGE_SIZE, true)
      },
      toggleSources: () => { this.patch({ editing: !this.state().editing, sourceFailure: null }) },
      editDraft: (text) => { this.patch({ draft: text, sourceFailure: null }) },
      addSource: () => {
        const draft = this.state().draft.trim()
        if (draft === '') return
        this.selectAdded = true
        void this.saveSources([...this.state().indexes.map(index => index.url), draft], true)
      },
      removeSource: (url) => { void this.saveSources(this.state().indexes.map(index => index.url).filter(item => item !== url), false) },
    }
  }

  /** Re-read the sources after the Host announced a change or the connection reset; an unrendered tab stays idle. */
  sourcesChanged(): void {
    if (this.state().status !== 'idle') void this.loadIndexes()
  }

  /** Recompute installation status of every loaded plugin after the profile's bundles changed; the Host reuses its cached document. */
  bundlesChanged(): void {
    const { listing } = this.state()
    // A ready listing holds the results it settled with.
    if (listing?.status === 'ready') void this.load(listing.url, listing.query, Math.max((listing.value as MarketSearchResult).entries.length, PAGE_SIZE), false)
  }

  private state(): DiscoverState {
    return this.store.getSnapshot()
  }

  private patch(next: Partial<DiscoverState>): void {
    this.store.set({ ...this.state(), ...next })
  }

  private async loadIndexes(): Promise<void> {
    const read = ++this.indexRead
    if (this.state().status === 'idle') this.patch({ status: 'loading' })
    const answer = await this.ctx.remote.pluginMarket.listIndexes()
    if (this.disposed || read !== this.indexRead) return
    if (!answer.ok) {
      this.patch({ status: 'error' })
      return
    }
    const indexes = answer.value
    const previous = this.state().selected
    const last = indexes.at(-1)
    const selected = this.selectAdded && last !== undefined
      ? last.url
      : indexes.some(index => index.url === previous) ? previous : indexes[0]?.url ?? null
    this.selectAdded = false
    this.patch({ status: 'ready', indexes, selected, ...indexes.length === 0 ? { editing: false } : {} })
    if (selected === null) this.patch({ listing: null })
    else if (selected !== this.state().listing?.url) void this.load(selected, INITIAL_QUERY, PAGE_SIZE, false)
  }

  /**
   * Load the first `count` results of a query in pages the Host accepts, replacing the shown results at once. Later
   * pages pin the first page's document; when the Host answers from a replaced document the read restarts once, and
   * fails if the document is replaced again. The index's undeclared ids leave the query.
   */
  private async load(url: string, query: DiscoverQuery, count: number, refresh: boolean): Promise<void> {
    const read = ++this.listingRead
    const current = this.state().listing
    const [kept, answered] = current?.url === url ? [current.value, current.answered] : [null, null]
    this.patch({ listing: { url, query, status: 'loading', value: kept, answered, failure: null } })
    const fail = (failure: ListingFailure): ListingState => {
      this.failed = () => { void this.load(url, query, count, refresh) }
      return { url, query, status: 'error', value: kept, answered, failure }
    }
    let value: MarketSearchResult | null = null
    let restarted = false
    while (value === null || (value.entries.length < count && value.nextOffset !== null)) {
      const offset = value?.entries.length ?? 0
      const limit = Math.min(count - offset, MAX_PAGE)
      const answer = await this.page(url, query, offset, limit, value?.fetchedAt, refresh && value === null && !restarted)
      if (this.disposed || read !== this.listingRead) return
      if (!answer.ok) {
        this.settle(url, fail(listingFailure(answer.error)), answer)
        return
      }
      if (value === null || answer.value.fetchedAt === value.fetchedAt) {
        value = value === null ? answer.value : { ...answer.value, entries: [...value.entries, ...answer.value.entries] }
      } else if (restarted) {
        this.patch({ listing: fail('changed') })
        return
      } else {
        restarted = true
        value = null
      }
    }
    const declared = declaredQuery(query, value.metadata)
    if (declared !== query) {
      void this.load(url, declared, count, false)
      return
    }
    this.settle(url, { url, query, status: 'ready', value, answered: query, failure: null }, { ok: true, value })
  }

  /** Load the page after the shown results; a replaced document reloads them from the first page. */
  private async loadMore(): Promise<void> {
    const listing = this.state().listing
    // A failed next page leaves status `error` with results that still answer the query.
    if (listing === null || (listing.status !== 'ready' && listing.status !== 'error') || listing.answered !== listing.query) return
    if (listing.value?.nextOffset == null) return
    const { url, query, value } = listing
    const read = ++this.listingRead
    this.patch({ listing: { ...listing, status: 'more', failure: null } })
    const answer = await this.page(url, query, value.entries.length, PAGE_SIZE, value.fetchedAt, false)
    if (this.disposed || read !== this.listingRead) return
    if (!answer.ok) {
      this.failed = () => { void this.loadMore() }
      this.settle(url, { ...listing, status: 'error', failure: listingFailure(answer.error) }, answer)
      return
    }
    if (answer.value.fetchedAt !== value.fetchedAt) {
      void this.load(url, query, value.entries.length + PAGE_SIZE, false)
      return
    }
    const next = { ...answer.value, entries: [...value.entries, ...answer.value.entries] }
    this.settle(url, { ...listing, status: 'ready', value: next, failure: null }, { ok: true, value: next })
  }

  private page(url: string, query: DiscoverQuery, offset: number, limit: number, fetchedAt: number | undefined, refresh: boolean) {
    return this.ctx.remote.pluginMarket.search(url, {
      ...query.text.trim() === '' ? {} : { text: query.text },
      ...query.category === null ? {} : { category: query.category },
      ...query.labels.length === 0 ? {} : { labels: query.labels },
      sort: query.sort, offset, limit, ...fetchedAt === undefined ? {} : { fetchedAt }, ...refresh ? { refresh: true } : {},
    })
  }

  /** Publish a settled read and the index title or error it taught about its source. */
  private settle(
    url: string, listing: ListingState,
    answer: { readonly ok: true; readonly value: MarketSearchResult } | { readonly ok: false; readonly error: RemoteFailure },
  ): void {
    const indexes = this.state().indexes.map((index): MarketIndexSummary => {
      if (index.url !== url) return index
      if (!answer.ok) return { ...index, error: answer.error.message }
      const { title, description } = answer.value
      return { url, title, ...description === undefined ? {} : { description } }
    })
    this.patch({ listing, indexes })
  }

  private async saveSources(urls: string[], adding: boolean): Promise<void> {
    this.patch({ saving: true, sourceFailure: null })
    const answer = await this.ctx.remote.pluginMarket.setIndexes(urls)
    if (this.disposed) return
    if (!answer.ok) {
      this.selectAdded = false
      this.patch({ saving: false, sourceFailure: sourceFailure(answer.error) })
      return
    }
    this.patch({ saving: false, ...adding ? { draft: '' } : {} })
    await this.loadIndexes()
  }
}
