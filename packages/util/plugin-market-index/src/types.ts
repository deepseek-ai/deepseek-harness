/**
 * Validated plugin market index records.
 * @module @deepseek-ai/dsh-plugin-market-index/types
 */

import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** A market-declared category or label: an opaque id's display title. */
export interface MarketDeclaration {
  readonly title: LocalizedText
}

/** A market-declared sort key: its display title and initial direction. */
export interface MarketSortKeyDeclaration {
  readonly title: LocalizedText
  readonly order: 'asc' | 'desc'
}

/** Market-defined declarations; absent groups are empty records. */
export interface MarketIndexMetadata {
  readonly categories: Readonly<Record<string, MarketDeclaration>>
  readonly labels: Readonly<Record<string, MarketDeclaration>>
  readonly sortKeys: Readonly<Record<string, MarketSortKeyDeclaration>>
}

/** Market-defined values of one plugin; category, label, and sort-key ids require index declarations. */
export interface MarketPluginMetadata {
  readonly category?: string
  /** Free-form strings, conventionally from package keywords; absent input becomes an empty array. */
  readonly keywords: readonly string[]
  readonly labels: readonly string[]
  readonly sortKeys: Readonly<Record<string, number>>
}

/** Where a plugin's source code is published; display only, never an install source. */
export interface MarketRepository {
  /** Absolute http(s) URL of the repository's web page, without credentials, query, or fragment. */
  readonly url: string
  /** Relative POSIX directory of the package inside the repository; absent means the repository root. */
  readonly directory?: string
}

/** Where one exact version is installed from. */
export type MarketSource =
  | {
    readonly type: 'npm'
    /** http(s) registry URL; absent means the installing client's configured registry. */
    readonly registry?: string
  }
  | {
    readonly type: 'git'
    /** Canonical https repository URL without credentials, query, or fragment. */
    readonly url: string
    /** Lowercase 40-hex-digit commit SHA. */
    readonly commit: string
    /** Relative POSIX package directory; absent means the repository root. */
    readonly path?: string
  }

/** Runtime requirements of one version. */
export interface MarketEngines {
  /** SemVer range of DSH versions the version runs on; absent means any DSH version. */
  readonly dsh?: string
}

/** One installable version of a plugin. */
export interface MarketVersion {
  /** Exact SemVer version, unique within its plugin. */
  readonly version: string
  /** Publish time of `version` in Unix seconds. */
  readonly publishTimestamp: number
  readonly source: MarketSource
  readonly engines: MarketEngines
}

/** One installable bundle and its listed versions. */
export interface MarketPlugin {
  /** npm package name, unique within its index. */
  readonly name: string
  readonly title?: LocalizedText
  readonly description?: LocalizedText
  /** Base64 `data:` URL or absolute URL; a relative index reference is already resolved against the index URL. */
  readonly icon?: string
  readonly author?: string
  /** Absolute http(s) URL of a page about the plugin. */
  readonly homepage?: string
  /** Web page of the plugin's source repository and its package directory; display only. */
  readonly repository?: MarketRepository
  readonly metadata: MarketPluginMetadata
  /** Non-empty, in descending SemVer precedence. */
  readonly versions: readonly MarketVersion[]
}

/** One validated format-1 index; members the format does not define are dropped. */
export interface MarketIndex {
  readonly format: 1
  readonly title: LocalizedText
  readonly description?: LocalizedText
  readonly metadata: MarketIndexMetadata
  /** Plugins in the index's default order. */
  readonly plugins: readonly MarketPlugin[]
}

/** The arguments that install one exact version. */
export interface MarketInstallTarget {
  /** Install spec accepted by `pnpm add`. */
  readonly spec: string
  /** Registry to ask first; absent means the installing client's configured registry. */
  readonly registry?: string
}
