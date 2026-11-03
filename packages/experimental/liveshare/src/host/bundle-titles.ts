/**
 * User-facing bundle titles for the packages that register Remote methods.
 *
 * A shipped optional feature is a bundle package whose patch rows mount one or more component
 * packages. The experimental-plugin page names the bundle; a Remote method names its component
 * package. Preferring the containing bundle's localized title keeps the share dialog and the plugin
 * page in agreement. A component no bundle mounts falls back to its own package title.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/bundle-titles
 */

import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

/** Localized titles keyed by lowercase language id. */
export type BundleTitles = Readonly<Record<string, string>>

/** One bundle that introduces component packages. */
export interface BundleTitleEntry {
  readonly name: string
  /** Localized title; absent on a core bundle that ships no display metadata. */
  readonly titles?: BundleTitles
  /** Whether this is a profile/core bundle rather than an installable feature. */
  readonly core: boolean
}

/**
 * Bundles whose rows are application plumbing, never separately installable features.
 *
 * A shipped profile template names the composition roots it selects, so the package that owns the
 * templates also owns this set; listing the names here would let a template change go unnoticed.
 */
const CORE_BUNDLES: ReadonlySet<string> = new Set(
  Object.values(PROFILE_TEMPLATES).flatMap(template => template.bundles),
)

/** One localized title source the share host reads from the plugin manager. */
export interface BundleTitleMeta {
  readonly title?: unknown
}

/** One bundle row that mounts a component package. */
export interface BundleTitleRow {
  readonly moduleName?: string
}

/** The subset of a plugin-manager bundle this module reads. */
export interface BundleTitleBundle {
  readonly name?: string
  readonly meta?: BundleTitleMeta
  readonly rows?: readonly BundleTitleRow[]
}

/** The subset of the plugin manager service this module reads. */
export interface BundleTitleSource {
  listBundles(): Promise<readonly BundleTitleBundle[]>
}

/**
 * Normalize one bundle title, which may be a literal string or a language map.
 * @param title - Bundle metadata title.
 * @returns Titles keyed by language, or undefined when absent.
 */
function normalizeTitle(title: unknown): BundleTitles | undefined {
  if (typeof title === 'string') return title === '' ? undefined : { en: title }
  if (typeof title !== 'object' || title === null) return undefined
  const record: Record<string, string> = {}
  for (const [language, value] of Object.entries(title)) {
    if (typeof value === 'string' && value !== '') record[language.toLowerCase()] = value
  }
  return Object.keys(record).length === 0 ? undefined : record
}

/**
 * Index every bundle's row module names to the bundle title that introduces them.
 * @param bundles - Bundle catalog reported by the plugin manager.
 * @returns Component package name to the feature bundle that introduces it.
 */
export function bundleTitleMap(bundles: readonly BundleTitleBundle[]): ReadonlyMap<string, BundleTitleEntry> {
  const mapped = new Map<string, BundleTitleEntry>()
  for (const bundle of bundles) {
    const name = bundle.name
    if (name === undefined || name === '') continue
    const core = CORE_BUNDLES.has(name)
    const titles = normalizeTitle(bundle.meta?.title)
    if (titles === undefined && !core) continue
    const entry: BundleTitleEntry = {
      name,
      core,
      ...(titles === undefined ? {} : { titles }),
    }
    for (const row of bundle.rows ?? []) {
      if (row.moduleName !== undefined && row.moduleName !== '') mapped.set(row.moduleName, entry)
    }
  }
  return mapped
}

/**
 * Read the bundle titles of the current profile.
 * @param manager - The plugin manager mounted by this Host.
 * @returns Component package name to bundle entry map, empty when the catalog cannot be read.
 */
export async function bundleTitlesOf(manager: BundleTitleSource): Promise<ReadonlyMap<string, BundleTitleEntry>> {
  try {
    return bundleTitleMap(await manager.listBundles())
  } catch {
    // The share dialog still works with component-package titles; a missing bundle catalog is not
    // a reason to fail the share itself.
    return new Map()
  }
}
