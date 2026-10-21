/** Filtering, fuzzy text matching, and ordering of one validated index's plugins. */
import MiniSearch from 'minisearch'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { MarketDeclaration, MarketIndex, MarketPlugin } from '@deepseek-ai/dsh-plugin-market-index'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { MarketQuery } from './types.ts'

/**
 * Letters, marks, and digits used by CJK scripts, which write words without spaces between them; script extensions
 * include shared characters such as the prolonged sound mark ー and the iteration mark 々.
 */
const CJK = String.raw`[[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}]&&[\p{L}\p{M}\p{N}]]`
/** A run of CJK characters, or a run of other letters, marks, and digits. */
const RUN = new RegExp(String.raw`${CJK}+|[[\p{L}\p{M}\p{N}]--${CJK}]+`, 'gv')
const CJK_START = new RegExp(String.raw`^${CJK}`, 'v')

/**
 * Split NFKC-normalized text into search terms, so composed and decomposed forms, half-width kana, and compatibility
 * characters yield the same terms. A CJK run yields its overlapping character pairs and its last character, so a query
 * matches without word segmentation and every character of the run starts some term.
 * @param text - indexed or queried text.
 * @returns the terms in text order, not yet lowercased.
 */
function searchTerms(text: string): string[] {
  return [...text.normalize('NFKC').matchAll(RUN)].flatMap(([run]) => {
    if (!CJK_START.test(run)) return [run]
    // A CJK run holds letters only, so its code points are its characters.
    const chars = Array.from(run)
    return [...chars.slice(1).map((char, position) => `${chars[position] as string}${char}`), chars.at(-1) as string]
  })
}

/** Every language variant of a localized text. */
function variants(text: LocalizedText | undefined): string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : Object.values(text)
}

/** One plugin's searchable text by field; `id` is its index position. */
interface SearchDocument {
  readonly id: number
  readonly name: string
  readonly title: string
  readonly keywords: string
  readonly description: string
  readonly author: string
  /** Every language of the plugin's category title and label titles. */
  readonly taxonomy: string
}

/** The search order and filters of a query, without paging. */
type MarketSelection = Pick<MarketQuery, 'text' | 'category' | 'labels' | 'sort'>

/** Plugins indexed per event-loop turn while the text index is built. */
const BUILD_CHUNK = 500

/** Matches queries against one index; the text index is built on the first query with text, yielding between chunks. */
export class MarketSearch {
  private engine: Promise<MiniSearch<SearchDocument>> | undefined

  /** @param index - the validated index to search. */
  constructor(private readonly index: MarketIndex) {}

  /**
   * Select and order the plugins matching a query.
   * @param selection - text, filters, and order.
   * @returns every matching plugin in result order.
   */
  async select(selection: MarketSelection): Promise<MarketPlugin[]> {
    const plugins = this.index.plugins
    const text = selection.text ?? ''
    const scores = new Map<number, number>()
    let positions: number[]
    if (searchTerms(text).length === 0) {
      positions = plugins.map((_plugin, position) => position)
    } else {
      for (const result of await this.search(text)) scores.set(result.id as number, result.score)
      positions = [...scores.keys()].sort((a, b) => a - b)
    }
    const labels = selection.labels ?? []
    const matching = positions.filter((position) => {
      const { metadata } = plugins[position] as MarketPlugin
      return (selection.category === undefined || metadata.category === selection.category)
        && labels.every(label => metadata.labels.includes(label))
    })
    return this.order(matching, selection.sort, scores).map(position => plugins[position] as MarketPlugin)
  }

  private async search(text: string): Promise<ReturnType<MiniSearch<SearchDocument>['search']>> {
    this.engine ??= this.build()
    return (await this.engine).search(text)
  }

  private async build(): Promise<MiniSearch<SearchDocument>> {
    const { categories, labels } = this.index.metadata
    const engine = new MiniSearch<SearchDocument>({
      fields: ['name', 'title', 'keywords', 'description', 'author', 'taxonomy'],
      storeFields: [],
      tokenize: searchTerms,
      processTerm: term => term.toLowerCase(),
      searchOptions: {
        boost: { name: 3, title: 3, keywords: 2 },
        prefix: true,
        // Edit distance of one fifth of the term length, rounded, at most 2; shorter terms match only as written or as a prefix.
        fuzzy: term => term.length >= 4 ? 0.2 : false,
        maxFuzzy: 2,
        combineWith: 'AND',
      },
    })
    await engine.addAllAsync(this.index.plugins.map((plugin, id): SearchDocument => {
      const { category, keywords } = plugin.metadata
      // parseMarketIndex accepts only declared category and label ids.
      const title = (declarations: Readonly<Record<string, MarketDeclaration>>, id: string): string[] =>
        variants((declarations[id] as MarketDeclaration).title)
      const taxonomy = [
        ...category === undefined ? [] : title(categories, category),
        ...plugin.metadata.labels.flatMap(label => title(labels, label)),
      ]
      return {
        id,
        name: plugin.name,
        title: variants(plugin.title).join('\n'),
        keywords: keywords.join('\n'),
        description: variants(plugin.description).join('\n'),
        author: plugin.author ?? '',
        taxonomy: taxonomy.join('\n'),
      }
    }), { chunkSize: BUILD_CHUNK })
    return engine
  }

  private order(positions: number[], sort: MarketQuery['sort'], scores: ReadonlyMap<number, number>): number[] {
    switch (sort.kind) {
      case 'index': return positions
      case 'relevance': return positions.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a - b)
      case 'published':
      case 'key': {
        const value = (position: number): number | undefined => {
          const plugin = this.index.plugins[position] as MarketPlugin
          if (sort.kind === 'published') return Math.max(...plugin.versions.map(version => version.publishTimestamp))
          return Object.hasOwn(plugin.metadata.sortKeys, sort.id) ? plugin.metadata.sortKeys[sort.id] : undefined
        }
        const sign = sort.direction === 'asc' ? 1 : -1
        return positions.map(position => ({ position, value: value(position) })).sort((a, b) => {
          if (a.value === undefined || b.value === undefined) {
            return a.value === b.value ? a.position - b.position : a.value === undefined ? 1 : -1
          }
          return (a.value - b.value) * sign || a.position - b.position
        }).map(item => item.position)
      }
      /* v8 ignore next -- the Gateway validates `sort` against the closed union */
      default: return assertNever(sort)
    }
  }
}
