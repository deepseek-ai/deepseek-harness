/**
 * Active Loader-backed plugin package inventory for official DeepSeek requests.
 * Host entries and the requesting agent's standing preset are resolved at request time;
 * installed dependencies and plugin fibers without Loader-backed package identity are excluded.
 * @module @deepseek-ai/dsh-plugin-package-inventory-deepseek
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Entry, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { DeepSeekPluginPackageIdentity, DeepSeekPluginPackageInventoryExtension } from './types.ts'
import type {} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'plugin-package-inventory-deepseek'
/** Services required to locate host/requesting-agent entries and contribute the field. */
export const inject = ['agents', 'deepseekLlmApiExtensions', 'loader']

/** Plugin-package request contribution configuration. */
export interface Config {
  /** Contribute `dsh_plugin_packages` to official DeepSeek requests. Defaults to `true`. */
  enabled?: boolean
}

/** Validated plugin-package request contribution configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
}

interface ActiveEntry {
  readonly entry: Entry
  /** Bare-package base used by the Loader path that activated this entry. */
  readonly bareBaseUrl?: string
}

/** Parse a bare package or package-subpath specifier into its package name. */
function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.includes(':') || isAbsolute(specifier)) return undefined
  const [first = '', second = ''] = specifier.split('/')
  // An active Loader entry already passed module resolution, so a scoped bare name has its package segment.
  return first.startsWith('@') ? `${first}/${second}` : first
}

/** Read one manifest identity, optionally treating an absent name as a loose-module marker. */
function identityFromManifest(path: string, allowAnonymous: boolean): DeepSeekPluginPackageIdentity | undefined {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (allowAnonymous && manifest.name === undefined) return undefined
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`plugin-package-inventory-deepseek: ${path} must declare non-empty name and version`)
  }
  return { name: manifest.name, version: manifest.version }
}

/** Resolve a bare package without requiring it to export `./package.json`. */
function barePackageManifest(packageName: string, anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    const searchPaths = createRequire(anchor).resolve.paths(packageName)
    /* v8 ignore next -- active non-builtin package entries always have Node package search paths */
    if (searchPaths === null) continue
    for (const searchPath of searchPaths) {
      const manifest = join(searchPath, packageName, 'package.json')
      if (existsSync(manifest)) return manifest
    }
  }
  return undefined
}

/** Find the nearest owning manifest for a relative or absolute plugin module. */
function nearestManifest(modulePath: string): string | undefined {
  let current = dirname(modulePath)
  const root = parse(current).root
  while (true) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) return manifest
    if (current === root) return undefined
    current = dirname(current)
  }
}

/** Exact package identity resolver with immutable per-process manifest caching. */
class PackageIdentityResolver {
  // TODO: Invalidate manifest identities if in-process package-version replacement becomes a supported upgrade path.
  private readonly cache = new Map<string, DeepSeekPluginPackageIdentity | undefined>()

  constructor(private readonly hostBaseUrl: string) {}

  /** Resolve one Loader entry's owning package, or absence for a non-package loose module. */
  resolve({ entry, bareBaseUrl }: ActiveEntry): DeepSeekPluginPackageIdentity | undefined {
    /* v8 ignore next -- Loader entry trees inherit a base URL; the fallback supports direct embedders. */
    const treeBase = entry.parent.tree.ctx.baseUrl ?? this.hostBaseUrl
    const anchors = [...new Set([bareBaseUrl ?? treeBase, treeBase, this.hostBaseUrl, import.meta.url])]
    const key = `${anchors.join('\u0000')}\u0000${entry.options.name}`
    if (this.cache.has(key)) return this.cache.get(key)

    const packageName = barePackageName(entry.options.name)
    let manifest: string | undefined
    if (packageName !== undefined) {
      manifest = barePackageManifest(packageName, anchors)
      if (manifest === undefined) {
        throw new Error(`plugin-package-inventory-deepseek: cannot resolve active package ${JSON.stringify(packageName)}`)
      }
    } else if (!entry.options.name.startsWith('cordis:')) {
      const moduleUrl = isAbsolute(entry.options.name)
        ? pathToFileURL(entry.options.name)
        : new URL(entry.options.name, treeBase)
      if (moduleUrl.protocol === 'file:') manifest = nearestManifest(fileURLToPath(moduleUrl))
    }
    const identity = manifest === undefined ? undefined : identityFromManifest(manifest, packageName === undefined)
    this.cache.set(key, identity)
    return identity
  }
}

/** Yield active, non-structural entries from one Loader tree. */
function activeEntries(tree: EntryTree, rootBareBaseUrl?: string): ActiveEntry[] {
  return [...tree.entries()]
    .filter(entry => !entry.options.group
      && !entry.disabled
      && entry.fiber?.state === FiberState.ACTIVE)
    .map(entry => ({
      entry,
      ...entry.parent.tree === tree && rootBareBaseUrl !== undefined
        ? { bareBaseUrl: rootBareBaseUrl }
        : {},
    }))
}

/** Deterministic text order independent of the host's ICU data and locale. */
function compareWireText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Collect the full active package set for one request. */
async function collectActivePluginPackages(
  ctx: Context,
  resolver: PackageIdentityResolver,
  hostBaseUrl: string,
  sessionId?: string,
): Promise<DeepSeekPluginPackageIdentity[]> {
  const entries = activeEntries(ctx.loader)
  if (sessionId !== undefined && ctx.get('agentPresets') !== undefined) {
    const agent = ctx.agents.get(brandString<SessionId>(sessionId))
    if (agent !== undefined) {
      // The optional peer is loaded only when its service is present. Its existing
      // mount query keeps Loader internals off the public AgentPresets service.
      const { standingMountFor } = await import('@deepseek-ai/dsh-agent-presets')
      const presetTree = standingMountFor(agent.ctx)?.tree
      // PresetTree deliberately resolves its root bare rows from the harness;
      // nested ordinary includes retain their own tree base.
      if (presetTree !== undefined) entries.push(...activeEntries(presetTree, hostBaseUrl))
    }
  }
  const unique = new Map<string, DeepSeekPluginPackageIdentity>()
  for (const activeEntry of entries) {
    const identity = resolver.resolve(activeEntry)
    if (identity === undefined) continue
    unique.set(`${identity.name}\u0000${identity.version}`, identity)
  }
  return [...unique.values()].sort((left, right) => (
    compareWireText(left.name, right.name) || compareWireText(left.version, right.version)
  ))
}

/**
 * Register the complete `dsh_plugin_packages` request contribution when enabled.
 * @param ctx - plugin context carrying Loader entry metadata and the DeepSeek request-extension registry.
 * @param config - validated default-on configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const hostBaseUrl = ctx.baseUrl ?? import.meta.url
  const resolver = new PackageIdentityResolver(hostBaseUrl)
  ctx.deepseekLlmApiExtensions.register('dsh_plugin_packages', {
    prepare: async (request) => {
      const value: DeepSeekPluginPackageInventoryExtension = {
        version: 1,
        packages: await collectActivePluginPackages(ctx, resolver, hostBaseUrl, request.sessionId),
      }
      return { value }
    },
  })
}
