/** JSON-safe records and events of the plugin market Remote namespace. */
import type { MarketIndexMetadata, MarketInstallTarget, MarketPlugin, MarketVersion } from '@deepseek-ai/dsh-plugin-market-index'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { DetailFailureReason } from '@deepseek-ai/dsh-plugin-detail/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An index URL is not http(s), or carries credentials or a fragment. */
    'plugin-market/invalid-index-url': { readonly url: string; readonly reason: string }
    /** The URL is not one of the configured index sources. */
    'plugin-market/unknown-index': { readonly url: string }
    /** The index could not be fetched: network failure, timeout, redirect, non-2xx status, or a body over the size limit. */
    'plugin-market/fetch-failed': { readonly url: string; readonly reason: string }
    /** The fetched document is not valid format-1 JSON; `path` names the offending JSON value. */
    'plugin-market/invalid-index': { readonly url: string; readonly path: string; readonly reason: string }
    /** A search page request is out of range; `field` names the offending query field. */
    'plugin-market/invalid-query': { readonly field: string; readonly reason: string }
    /** Index sources cannot be saved without the settings service and this service's profile entry. */
    'plugin-market/settings-unavailable': Record<string, never>
    /** The index lists no such plugin or version. */
    'plugin-market/unknown-plugin': { readonly name: string; readonly version: string }
    /**
     * A detail document exists but cannot be read: `too-large` beyond a size limit, `network` when a source cannot be
     * reached, `denied` when Git refuses the repository with the user's credentials, `git-unavailable` when the
     * repository must be cloned and Git cannot run, `invalid` for a malformed locale file or `meta.detail`, or a named
     * file that does not exist.
     */
    'plugin-market/detail-unavailable': { readonly reason: DetailFailureReason }
  }
}

/** One configured index source and what the last read learned about it. */
export interface MarketIndexSummary {
  readonly url: string
  /** Market title from the last successful read. */
  readonly title?: LocalizedText
  readonly description?: LocalizedText
  /** Failure message of the last read when it failed. */
  readonly error?: string
}

/**
 * How a plugin relates to the profile's bundles, matched by package name and measured against its default version, or
 * its highest version when it has no default: `provided` when the DSH installation ships the package,
 * `update-available` when that version is greater than the installed one, `different-version` when the installed
 * version is unknown, not valid SemVer, or greater.
 */
export type MarketInstallationStatus = 'not-installed' | 'installed' | 'update-available' | 'different-version' | 'provided'

/** A plugin's installation status and the installed version when the profile reports one. */
export interface MarketInstallation {
  readonly status: MarketInstallationStatus
  readonly installedVersion?: string
}

/** Whether the running DSH version satisfies a version's `engines.dsh`, as DSH's installation check evaluates it. */
export type MarketCompatibility =
  | { readonly compatible: true }
  | {
    readonly compatible: false
    readonly runtimeVersion: string
    /** The unmet requirement, keyed `engines.dsh`. */
    readonly requirements: Readonly<Record<string, string>>
    /** Whether the profile holds a version exemption for this exact package and runtime version. */
    readonly exempted: boolean
  }

/** One listed version with its compatibility and the arguments that install it. */
export interface MarketListingVersion extends MarketVersion {
  readonly install: MarketInstallTarget
  readonly compatibility: MarketCompatibility
}

/** One index plugin with the profile-specific facts a market list displays. */
export interface MarketListingEntry extends Omit<MarketPlugin, 'versions'> {
  /** Non-empty, in descending SemVer precedence. */
  readonly versions: readonly MarketListingVersion[]
  /**
   * The version installed by default: the highest compatible version without a prerelease tag, or the highest
   * compatible prerelease when the plugin lists no version without one. Absent when no such version is compatible.
   */
  readonly defaultVersion?: string
  readonly installation: MarketInstallation
}

/**
 * Order of search results; ties keep index order. `relevance` ranks by text match, best first, and is index order
 * without `text`. `published` uses each plugin's latest publish time. `key` uses a declared sort key; plugins without a
 * value follow all others in either direction.
 */
export type MarketSort =
  | { readonly kind: 'index' }
  | { readonly kind: 'relevance' }
  | { readonly kind: 'published'; readonly direction: 'asc' | 'desc' }
  | { readonly kind: 'key'; readonly id: string; readonly direction: 'asc' | 'desc' }

/** One page request over one index; an id the index does not declare matches no plugin. */
export interface MarketQuery {
  /**
   * Fuzzy text matched against the package name, author, keywords, and every language of the title, description, and
   * category and label titles. Every word must match a word in some field, as a prefix or within an edit distance of at
   * most 2. Text without letters or digits matches every plugin.
   */
  readonly text?: string
  /** Category id the plugin must have. */
  readonly category?: string
  /** Label ids the plugin must all have. */
  readonly labels?: readonly string[]
  readonly sort: MarketSort
  /** Number of matching plugins to skip; a non-negative integer. */
  readonly offset: number
  /** Largest number of plugins returned; an integer from 1 to 100. */
  readonly limit: number
  /** Fetch again instead of using a cached document. */
  readonly refresh?: boolean
  /**
   * `fetchedAt` of an earlier page: answer from that document while it is still cached, even after `cacheTtlMs`, so
   * later pages continue the same results. Without `refresh`, a replaced document is answered as without this field.
   */
  readonly fetchedAt?: number
}

/** One page of matching plugins with the index facts a market view displays. */
export interface MarketSearchResult {
  readonly url: string
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly metadata: MarketIndexMetadata
  /** Fetch time of the document answering this page, in Unix milliseconds; a different value means a different document. */
  readonly fetchedAt: number
  /** Matching plugins of this page, in result order. */
  readonly entries: readonly MarketListingEntry[]
  /** Number of matching plugins across all pages. */
  readonly total: number
  /** `offset` of the next page, or null after the last. */
  readonly nextOffset: number | null
}

/** Opaque id of a read detail document; image requests name it to read files beside the document. */
export type PluginDetailDocumentId = Branded<'PluginDetailDocumentId'>

/**
 * Where a detail document comes from: `locale` for the file `meta.detail` names, `readme` for the package's README, and
 * `repository` for the README of the directory the package's `repository` names.
 */
export type PluginDetailOrigin = 'locale' | 'readme' | 'repository'

/** A plugin's long description, or `none` when no source provides one. */
export type PluginDetail =
  | {
    readonly status: 'found'
    readonly origin: PluginDetailOrigin
    /** Markdown text, decoded as UTF-8. */
    readonly markdown: string
    /** Relative image paths of the document resolve beside it through `GET /api/plugin-market/detail-file`. */
    readonly document: PluginDetailDocumentId
  }
  | { readonly status: 'none' }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The configured index sources changed.
     * @mode emit
     */
    'plugin-market/changed'(): void
  }
}
