/** Host reader of configured plugin market indexes for the Discover page and the `plugin_market` tool. */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { marketInstallTarget, type MarketIndex, type MarketPlugin, type MarketVersion } from '@deepseek-ai/dsh-plugin-market-index'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { normalizeIndexUrl } from './index-url.ts'
import { parseIndexInWorker } from './parse-thread.ts'
import { MarketSearch } from './search.ts'
// Type-only: the `pluginManager` service, `settings.update`, and the Loader's `loader/volatile-update` event.
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketListingEntry, MarketListingVersion, MarketQuery, MarketSearchResult,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Configured plugin market index sources and their validated listings. */
    pluginMarket: PluginMarket
  }
}

/** Index sources and fetch limits. */
export interface Config {
  /** Index URLs in display order; Settings and `setIndexes` write this field without remounting the service. */
  indexes: Volatile<string[]>
  /** Deadline for one index fetch, including the body. */
  fetchTimeoutMs: number
  /** Largest accepted index body in bytes. */
  maxBytes: number
  /** Lifetime of a successfully read index document. */
  cacheTtlMs: number
}

/** The exact diagnostic of a failure, including a non-Error rejection. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Causes followed below a rejection; a deeper or cyclic chain is cut there. */
const MAX_CAUSES = 4

/** A rejection with its cause chain: a Node `fetch` failure is a bare `fetch failed` whose reason is its cause. */
function causeChainOf(error: unknown, depth = 0): string {
  return error instanceof Error && error.cause !== undefined && depth < MAX_CAUSES
    ? `${error.message}: ${causeChainOf(error.cause, depth + 1)}`
    : messageOf(error)
}

/** Largest page `search` returns. */
const MAX_LIMIT = 100

/** One fetched index document with its search state. */
interface IndexDocument {
  readonly index: MarketIndex
  /** Unix milliseconds. */
  readonly fetchedAt: number
  readonly search: MarketSearch
}

interface CachedIndex {
  readonly document: IndexDocument
  readonly expiresAt: number
}

/** Fetches, validates, and caches configured market indexes; annotates entries with the profile's installation facts. */
export default class PluginMarket extends TypertRemoteService {
  static inject = ['pluginManager']

  static Config = z.object({
    indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([]).volatile(),
    fetchTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15000),
    maxBytes: z.natural().min(1).default(128 * 1024 * 1024),
    cacheTtlMs: z.natural().default(600000),
  })

  private readonly lifetime = new AbortController()
  private readonly cache = new Map<string, CachedIndex>()
  private readonly pending = new Map<string, Promise<IndexDocument>>()
  private readonly errors = new Map<string, string>()
  private readonly entryId: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pluginMarket')
    this.entryId = ctx.fiber.entry?.options.id
    ctx.on('loader/volatile-update', () => {
      const configured = new Set(this.sources().flatMap(source => source.error === undefined ? [source.url] : []))
      for (const url of [...this.cache.keys(), ...this.errors.keys()]) {
        if (!configured.has(url)) {
          this.cache.delete(url)
          this.errors.delete(url)
        }
      }
      ctx.emit('plugin-market/changed')
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Plugin market disposed'))
      await Promise.allSettled(this.pending.values())
    })
  }

  /**
   * List the configured index sources without fetching them.
   * @returns every source in order, with the title of its last successful read and, when the last read failed, its error.
   */
  @Remote
  listIndexes(): MarketIndexSummary[] {
    return this.sources().map(({ url, error: invalid }) => {
      const index = this.cache.get(url)?.document.index
      const error = invalid ?? this.errors.get(url)
      return {
        url,
        ...index === undefined ? {} : { title: index.title, ...index.description === undefined ? {} : { description: index.description } },
        ...error === undefined ? {} : { error },
      }
    })
  }

  /**
   * Replace the configured index sources through Settings, without remounting this service.
   * `plugin-market/changed` announces the committed list. A URL already configured is kept as written, so a client can
   * add or remove sources beside one that `listIndexes` reports as unusable.
   * @param urls - index URLs in display order.
   * @throws {RemoteError} `plugin-market/invalid-index-url` for an invalid new URL or a repeated URL;
   * `plugin-market/settings-unavailable` without Settings or a profile entry.
   */
  @Remote
  async setIndexes(urls: string[]): Promise<void> {
    const configured = new Set(this.config.indexes.get())
    const normalized = urls.map(url => configured.has(url) ? url : normalizeIndexUrl(url))
    // A kept URL compares by its canonical form when it has one, so a new spelling of it counts as a repeat.
    const keys = normalized.map(url => URL.canParse(url) ? new URL(url).href : url)
    const repeated = normalized.find((_url, position) => keys.indexOf(keys[position] as string) !== position)
    if (repeated !== undefined) {
      throw new RemoteError('plugin-market/invalid-index-url', `Index source listed twice: ${repeated}`, { url: repeated, reason: 'duplicate' })
    }
    const settings = this.ctx.get('settings')
    if (settings === undefined || this.entryId === undefined) {
      throw new RemoteError('plugin-market/settings-unavailable', 'Index sources require the settings service and a profile entry', {})
    }
    await settings.update(this.entryId, { indexes: normalized })
  }

  /**
   * Return one page of the plugins of a configured index that match a query. Concurrent reads of a URL share one
   * fetch; a successful document is reused for `cacheTtlMs` unless `refresh` is set. Matching and ordering read only
   * the document; installation status and compatibility are computed for the returned page on every call.
   * @param url - a configured index URL.
   * @param query - text, filters, order, page, and whether to bypass the cached document.
   * @returns the index header, the page's plugins with each plugin's default version and installation status and each
   *   version's compatibility and install arguments, the number of matches, and the next page's offset.
   * @throws {RemoteError} `plugin-market/invalid-query`, `plugin-market/unknown-index`, `plugin-market/invalid-index-url`,
   *   `plugin-market/fetch-failed`, or `plugin-market/invalid-index`.
   */
  @Remote
  async search(url: string, query: MarketQuery): Promise<MarketSearchResult> {
    if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
      throw new RemoteError('plugin-market/invalid-query', 'offset must be a non-negative integer', { field: 'offset', reason: 'range' })
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
      throw new RemoteError('plugin-market/invalid-query', `limit must be an integer from 1 to ${String(MAX_LIMIT)}`, { field: 'limit', reason: 'range' })
    }
    const document = await this.document(url, query.refresh === true, query.fetchedAt)
    const matching = await document.search.select(query)
    const page = matching.slice(query.offset, query.offset + query.limit)
    const listing = await this.annotator()
    const next = query.offset + page.length
    const { index } = document
    return {
      url,
      title: index.title,
      ...index.description === undefined ? {} : { description: index.description },
      metadata: index.metadata,
      fetchedAt: document.fetchedAt,
      entries: page.map(listing),
      total: matching.length,
      nextOffset: next < matching.length ? next : null,
    }
  }

  /**
   * Read one plugin of a configured index, using the cached document as `search` does.
   * @param url - a configured index URL.
   * @param name - the plugin's package name.
   * @returns the plugin with its default version, installation status, and annotated versions; undefined when the
   *   index does not list it.
   * @throws {RemoteError} `plugin-market/unknown-index`, `plugin-market/invalid-index-url`, `plugin-market/fetch-failed`,
   *   or `plugin-market/invalid-index`.
   */
  async entry(url: string, name: string): Promise<MarketListingEntry | undefined> {
    const plugin = (await this.document(url, false)).index.plugins.find(candidate => candidate.name === name)
    return plugin === undefined ? undefined : (await this.annotator())(plugin)
  }

  private async document(url: string, refresh: boolean, fetchedAt?: number): Promise<IndexDocument> {
    const source = this.sources().find(candidate => candidate.url === url)
    if (source === undefined) throw new RemoteError('plugin-market/unknown-index', `Not a configured index source: ${url}`, { url })
    if (source.error !== undefined) {
      throw new RemoteError('plugin-market/invalid-index-url', source.error, { url, reason: 'configured' })
    }
    const cached = this.cache.get(url)
    const usable = cached !== undefined && (cached.expiresAt > Date.now() || cached.document.fetchedAt === fetchedAt)
    return !refresh && usable ? cached.document : await this.fetchShared(url)
  }

  /** Annotate plugins with the profile's bundles and exemptions as they are now. */
  private async annotator(): Promise<(plugin: MarketPlugin) => MarketListingEntry> {
    const [bundles, { exemptions }] = [await this.ctx.pluginManager.listBundles(), this.ctx.pluginManager.listVersionExemptions()]
    const runtimeVersion = getDshRuntimeVersion()
    return plugin => listingOf(plugin, bundles, exemptions, runtimeVersion)
  }

  /**
   * The configured sources as written, each with the refusal that makes it unusable. Settings and profile files can
   * write any http(s) string, so every use validates instead of the schema; an unusable source is listed with its error
   * and never fetched, and a repeated URL counts once.
   */
  private sources(): { readonly url: string; readonly error?: string }[] {
    const seen = new Set<string>()
    return this.config.indexes.get().flatMap((url) => {
      if (seen.has(url)) return []
      seen.add(url)
      try {
        return normalizeIndexUrl(url) === url ? [{ url }] : [{ url, error: `Index URL is not in canonical form; use ${normalizeIndexUrl(url)}` }]
      } catch (error) {
        return [{ url, error: messageOf(error) }]
      }
    })
  }

  private configured(url: string): boolean {
    return this.sources().some(source => source.url === url && source.error === undefined)
  }

  private fetchShared(url: string): Promise<IndexDocument> {
    let pending = this.pending.get(url)
    if (pending === undefined) {
      pending = this.fetchIndex(url).then((index) => {
        // Distinct per URL even when two fetches finish within one millisecond.
        const fetchedAt = Math.max(Date.now(), (this.cache.get(url)?.document.fetchedAt ?? 0) + 1)
        const document = { index, fetchedAt, search: new MarketSearch(index) }
        if (this.configured(url)) {
          this.cache.set(url, { document, expiresAt: Date.now() + this.config.cacheTtlMs })
          this.errors.delete(url)
        }
        return document
      }, (error: unknown) => {
        if (this.configured(url)) this.errors.set(url, messageOf(error))
        throw error
      }).finally(() => { this.pending.delete(url) })
      this.pending.set(url, pending)
    }
    return pending
  }

  private async fetchIndex(url: string): Promise<MarketIndex> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.fetchTimeoutMs)])
    const failed = (reason: string, cause?: unknown): RemoteError =>
      new RemoteError('plugin-market/fetch-failed', `Could not fetch ${url}: ${reason}`, { url, reason }, { cause })
    let response: Response
    try {
      response = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
    } catch (error) {
      throw failed(causeChainOf(error), error)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw failed(`HTTP ${String(response.status)}`)
    }
    const bytes = await this.readBody(response, failed)
    const result = await parseIndexInWorker(bytes, url, this.lifetime.signal).catch((error: unknown) => {
      throw failed(messageOf(error), error)
    })
    if (result.ok) return result.index
    throw new RemoteError('plugin-market/invalid-index', `${url}: ${result.message}`, { url, path: result.path, reason: result.reason })
  }

  /** Read the whole body, refusing it as soon as it exceeds `maxBytes`. */
  private async readBody(response: Response, failed: (reason: string, cause?: unknown) => RemoteError): Promise<Uint8Array> {
    const limit = this.config.maxBytes
    const tooLarge = `body exceeds ${String(limit)} bytes`
    if (Number(response.headers.get('content-length') ?? 0) > limit) {
      await response.body?.cancel()
      throw failed(tooLarge)
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength
        if (size > limit) throw failed(tooLarge)
        chunks.push(chunk)
      }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw failed(messageOf(error), error)
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  }
}

function listingOf(
  plugin: MarketPlugin, bundles: readonly BundleInfo[], exemptions: Readonly<Record<string, readonly string[]>>, runtimeVersion: string,
): MarketListingEntry {
  const versions = plugin.versions.map((version): MarketListingVersion => ({
    ...version,
    install: marketInstallTarget(plugin.name, version),
    compatibility: compatibilityOf(plugin.name, version, exemptions, runtimeVersion),
  }))
  const compatible = versions.filter(version => version.compatibility.compatible)
  const stable = plugin.versions.some(version => semver.prerelease(version.version) === null)
  const defaultVersion = compatible.find(version => !stable || semver.prerelease(version.version) === null)?.version
  /* v8 ignore next -- parseMarketIndex guarantees a non-empty version list */
  const measured = defaultVersion ?? versions[0]?.version ?? ''
  return {
    ...plugin,
    versions,
    ...defaultVersion === undefined ? {} : { defaultVersion },
    installation: installationOf(plugin.name, measured, bundles),
  }
}

function installationOf(name: string, version: string, bundles: readonly BundleInfo[]): MarketInstallation {
  const bundle = bundles.find(candidate => candidate.name === name)
  // An on-demand catalog entry is listed before the profile installs it.
  if (bundle === undefined || (!bundle.installed && bundle.availability !== 'installation')) return { status: 'not-installed' }
  if (!bundle.installed) return { status: 'provided', ...bundle.version === undefined ? {} : { installedVersion: bundle.version } }
  if (bundle.version === undefined) return { status: 'different-version' }
  const installedVersion = bundle.version
  if (installedVersion === version) return { status: 'installed', installedVersion }
  const newer = semver.valid(installedVersion) !== null && semver.gt(version, installedVersion)
  return { status: newer ? 'update-available' : 'different-version', installedVersion }
}

function compatibilityOf(
  name: string, version: MarketVersion, exemptions: Readonly<Record<string, readonly string[]>>, runtimeVersion: string,
): MarketCompatibility {
  const manifest = { name, version: version.version, ...version.engines.dsh === undefined ? {} : { engines: { dsh: version.engines.dsh } } }
  const issue = evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)
  if (issue === undefined) return { compatible: true }
  return { compatible: false, runtimeVersion: issue.runtimeVersion, requirements: issue.requirements, exempted: issue.exempted }
}
