/**
 * Installed-plugin Remote methods a share may offer its viewers.
 *
 * The catalog is read from the Host's live local Typert registry: every method the current
 * composition registers belongs to a namespace, and namespaces that belong to DSH core services or
 * LiveShare itself are excluded. The owner still chooses which of the remaining methods one share
 * exposes; the catalog only states the offer, and never distinguishes read from write.
 *
 * Each group also carries the registering package and that package's localized plugin titles, so the
 * share dialog can show a product name instead of a wire namespace.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/shareable-catalog
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShareablePluginCatalog } from './viewer-capability-types.ts'

/**
 * Namespaces whose methods never enter the share catalog.
 *
 * These are DSH core services, Session/Workspace plumbing, the plugin manager, and LiveShare's own
 * management Remote. A method that is not listed stays governed by the existing share roles.
 */
export const EXCLUDED_SHARE_NAMESPACES: ReadonlySet<string> = new Set([
  'session', 'workspace', 'workspaceFiles', 'terminal', 'settings', 'credentials', 'account',
  'job', 'goals', 'schedule', 'subagents', 'userQuestions', 'messageFeedback', 'llm',
  'pluginManager', 'pluginMarket', 'pluginRegistryProbe', 'directoryPicker', 'fileUploads',
  'skills', 'toolResults', 'remoteAccess', 'sessionFeedback', 'sessionReferenceResolver',
  'agentPresets', 'liveshareShares',
])

/** Languages the owner-facing dialog can display. */
const TITLE_LANGUAGES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

/** What one package contributes to a catalog group. */
export interface PluginMetadata {
  /** Package name parsed from the descriptor id, when the id names one. */
  readonly package?: string
  /** Localized plugin titles keyed by language. */
  readonly titles?: Readonly<Record<string, string>>
  /** Feature bundle that introduces this component; components of one bundle share a row. */
  readonly bundle?: string
  /** Whether the component belongs to a core profile bundle rather than an installable feature. */
  readonly core?: boolean
}

/** Read one package's display metadata; injected so catalog tests need no installed package. */
export type PluginMetadataReader = (packageName: string) => PluginMetadata

const require = createRequire(import.meta.url)

/**
 * Find one package directory by looking for its manifest under the resolver's search paths.
 *
 * The package entry itself may not exist on the source plane, so this looks only for the manifest
 * beside the package name rather than resolving the entry module.
 * @param packageName - Package that registered the namespace.
 * @param searchPaths - Directories the package may live under; defaults to Node's resolution paths.
 * @returns The package directory, or undefined when this Host cannot find its manifest.
 */
export function packageRoot(
  packageName: string,
  searchPaths: readonly string[] = require.resolve.paths(packageName) ?? [],
): string | undefined {
  for (const searchPath of searchPaths) {
    const directory = join(searchPath, packageName)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
      if (manifest.name === packageName) return directory
    } catch {
      // A candidate whose manifest cannot be read is not this package; keep searching.
    }
  }
  return undefined
}

/**
 * Read a package's localized plugin titles.
 * @param root - Package directory.
 * @returns Titles keyed by language, or undefined when the package ships no title.
 */
export function readTitles(root: string): Readonly<Record<string, string>> | undefined {
  const titles: Record<string, string> = {}
  for (const language of TITLE_LANGUAGES) {
    const path = join(root, 'locale', `${language}.json`)
    if (!existsSync(path)) continue
    try {
      const locale = JSON.parse(readFileSync(path, 'utf8')) as { meta?: { title?: unknown } }
      const title = locale.meta?.title
      if (typeof title === 'string' && title !== '') titles[language] = title
    } catch {
      // One unreadable locale file does not hide the package's other names.
    }
  }
  return Object.keys(titles).length === 0 ? undefined : titles
}

/**
 * Read one package's display metadata.
 * @param packageName - Package that registered the namespace.
 * @returns The package name and titles this Host could read.
 */
export function readPluginMetadata(packageName: string): PluginMetadata {
  const root = packageRoot(packageName)
  const titles = root === undefined ? undefined : readTitles(root)
  return {
    package: packageName,
    ...(titles === undefined ? {} : { titles }),
  }
}

/** The part of the Host's local Typert registry this catalog reads. */
export interface ShareableEndpointRegistry {
  /**
   * Snapshot the Host's local invocation descriptors.
   * @returns One descriptor per registered Remote method.
   */
  list(): readonly {
    readonly id: string
    readonly namespace: string
    readonly method: string
    readonly description?: string
  }[]
}

/**
 * Build the catalog from the live local Typert registry.
 * @param local - The Host's local Typert registry, when the composition mounts Typert.
 * @param readMetadata - Package metadata reader; defaults to reading the installed package.
 * @returns One group per included namespace, sorted by namespace and then endpoint.
 */
export function shareableViewerCatalog(
  local?: ShareableEndpointRegistry,
  readMetadata: PluginMetadataReader = readPluginMetadata,
): readonly ShareablePluginCatalog[] {
  if (local === undefined) return []
  const byPlugin = new Map<string, PluginMetadata & { endpoints: Set<string>; descriptions: Map<string, string> }>()
  for (const descriptor of local.list()) {
    const namespace = descriptor.namespace
    if (namespace === '' || descriptor.method === '' || EXCLUDED_SHARE_NAMESPACES.has(namespace)) continue
    const separator = descriptor.id.indexOf('#')
    const packageName = separator > 0 ? descriptor.id.slice(0, separator) : undefined
    const metadata = packageName === undefined ? {} : readMetadata(packageName)
    if (metadata.core === true) continue
    const groupKey = metadata.bundle ?? namespace
    let group = byPlugin.get(groupKey)
    if (group === undefined) {
      group = { ...metadata, endpoints: new Set<string>(), descriptions: new Map<string, string>() }
      byPlugin.set(groupKey, group)
    }
    const endpoint = `${namespace}/${descriptor.method}`
    group.endpoints.add(endpoint)
    if (descriptor.description !== undefined && descriptor.description !== '') {
      group.descriptions.set(endpoint, descriptor.description)
    }
  }
  return [...byPlugin]
    .map(([plugin, group]) => ({
      plugin,
      ...(group.package === undefined ? {} : { package: group.package }),
      ...(group.titles === undefined ? {} : { titles: group.titles }),
      endpoints: [...group.endpoints].sort(),
      /* v8 ignore start -- catalog fixtures carry no descriptions; the client title tests cover the field. */
      ...(group.descriptions.size === 0
        ? {}
        : { descriptions: Object.fromEntries([...group.descriptions].sort(([left], [right]) => left.localeCompare(right))) }),
      /* v8 ignore stop */
    }))
    .sort((left, right) => left.plugin.localeCompare(right.plugin))
}
