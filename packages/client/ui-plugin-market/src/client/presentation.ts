/** Pure Discover query and display helpers over market search results. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { MarketIndexSummary, MarketListingEntry, MarketListingVersion, MarketSort } from '@deepseek-ai/dsh-api-remotes/client'
import type { MarketIndexMetadata } from '@deepseek-ai/dsh-plugin-market-index'

/** The Discover query: text, filters, and order, without paging. */
export interface DiscoverQuery {
  readonly text: string
  readonly category: string | null
  readonly labels: readonly string[]
  readonly sort: MarketSort
}

/** The query a newly selected index starts with. */
export const INITIAL_QUERY: DiscoverQuery = { text: '', category: null, labels: [], sort: { kind: 'index' } }

/**
 * Replace the query text. Index order becomes relevance order when blank text gains words, and returns when the text
 * becomes blank; an order chosen while text is present stays.
 * @param query - the current query.
 * @param text - the new text.
 * @returns the query with the text and its order.
 */
export function withText(query: DiscoverQuery, text: string): DiscoverQuery {
  const [was, blank] = [query.text.trim() === '', text.trim() === '']
  const sort: MarketSort = was && !blank && query.sort.kind === 'index'
    ? { kind: 'relevance' }
    : blank && query.sort.kind === 'relevance' ? { kind: 'index' } : query.sort
  return { ...query, text, sort }
}

/**
 * Drop filters and the sort key the index no longer declares, so every active choice stays visible in the toolbar.
 * @param query - the current query.
 * @param metadata - the declarations of the index that answered it.
 * @returns the query itself when every id is declared, otherwise a reduced copy.
 */
export function declaredQuery(query: DiscoverQuery, metadata: MarketIndexMetadata): DiscoverQuery {
  const category = query.category !== null && !Object.hasOwn(metadata.categories, query.category) ? null : query.category
  const labels = query.labels.filter(label => Object.hasOwn(metadata.labels, label))
  const sort: MarketSort = query.sort.kind === 'key' && !Object.hasOwn(metadata.sortKeys, query.sort.id) ? { kind: 'index' } : query.sort
  const unchanged = category === query.category && labels.length === query.labels.length && sort === query.sort
  return unchanged ? query : { ...query, category, labels, sort }
}

/** A declaration with its id and its title in the current language. */
export interface DisplayDeclaration<T> {
  readonly id: string
  readonly title: string
  readonly declaration: T
}

/**
 * Order declarations by their localized title, then by id code points.
 * @param declarations - id → declaration with a `title`.
 * @param resolveText - current-language text resolution.
 * @param language - current UI language for collation.
 * @returns declarations in display order.
 */
export function displayDeclarations<T extends { readonly title: LocalizedText }>(
  declarations: Readonly<Record<string, T>>, resolveText: (text: LocalizedText) => string, language: string,
): DisplayDeclaration<T>[] {
  const collator = new Intl.Collator(language)
  return Object.entries(declarations)
    .map(([id, declaration]) => ({ id, title: resolveText(declaration.title), declaration }))
    .sort((a, b) => collator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1))
}

/**
 * The version an entry presents and installs by default: its default version, or its highest version when none is compatible.
 * @param entry - the market entry.
 * @returns the presented version.
 */
export function presentedVersion(entry: MarketListingEntry): MarketListingVersion {
  // The Host lists at least one version and names a listed default.
  return (entry.versions.find(version => version.version === entry.defaultVersion) ?? entry.versions[0]) as MarketListingVersion
}

/** One fact about where an entry installs from, keyed for its localized label. */
export interface SourceFact {
  readonly kind: 'package' | 'registry' | 'repository' | 'commit' | 'directory'
  readonly value: string
}

/**
 * List where a version installs from, so users can check its origin before installing.
 * @param name - the entry's package name.
 * @param version - the version to install.
 * @returns the npm package and registry, or the repository, full commit, and package directory.
 */
export function sourceFacts(name: string, version: MarketListingVersion): SourceFact[] {
  const { source } = version
  if (source.type === 'npm') {
    return [
      { kind: 'package', value: `${name}@${version.version}` },
      ...source.registry === undefined ? [] : [{ kind: 'registry' as const, value: source.registry }],
    ]
  }
  return [
    { kind: 'repository', value: source.url },
    { kind: 'commit', value: source.commit },
    ...source.path === undefined ? [] : [{ kind: 'directory' as const, value: source.path }],
  ]
}

/**
 * Name an index source: its market title once read, otherwise its host.
 * @param index - the configured source.
 * @param resolveText - current-language text resolution.
 * @returns the display name; a URL the browser cannot parse is shown as written.
 */
export function indexLabel(index: MarketIndexSummary, resolveText: (text: LocalizedText) => string): string {
  if (index.title !== undefined) return resolveText(index.title)
  return URL.canParse(index.url) ? new URL(index.url).host : index.url
}
