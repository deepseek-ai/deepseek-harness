/** Package metadata resolved through one runtime interception. */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import {
  barePackageName,
  installRuntimeInterception,
  registerWorkerResolution,
  type RuntimeInterception,
} from './resolver.ts'
import type { RuntimeResolution } from '../profile.ts'
import { readPluginMeta } from '../package-meta.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deterministic package lookup for configured plugin specifiers. */
    pluginPackages: PluginPackages
  }
}

/** The package that owns a resolved module. */
export interface PluginPackage {
  /** Manifest package name. */
  name: string
  /** Manifest version when declared. */
  version: string | undefined
  /** Absolute package directory. */
  dir: string
  /** Absolute package.json path. */
  manifestPath: string
  /** Parsed manifest shared by metadata readers. */
  manifest: Record<string, unknown>
}

/** Optional runtime interception installed and owned by {@link PluginPackages}. */
export interface PluginPackagesConfig {
  /** Complete package table; omit it to expose native package lookup only. */
  resolution?: RuntimeResolution
}

function readPackage(dir: string, fallbackName: string): PluginPackage | undefined {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const name = manifest.name
  const version = manifest.version
  return {
    name: typeof name === 'string' ? name : fallbackName,
    version: typeof version === 'string' ? version : undefined,
    dir,
    manifestPath,
    manifest,
  }
}

/** Package lookup shared by metadata consumers in one profile process. */
export class PluginPackages extends Service {
  private packages = new Map<string, PluginPackage | undefined>()
  private readonly interception: RuntimeInterception | undefined
  private disposeWorkerResolution: (() => void) | undefined

  constructor(ctx: Context, config: PluginPackagesConfig = {}) {
    super(ctx, 'pluginPackages')
    if (config.resolution === undefined) return
    const interception = installRuntimeInterception(config.resolution)
    this.disposeWorkerResolution = registerWorkerResolution(config.resolution)
    this.interception = interception
    ctx.effect(() => () => {
      this.disposeWorkerResolution?.()
      interception.dispose()
    }, 'profile package resolution')
  }

  /**
   * Publish a complete successor generation for this process and subsequently created Workers.
   * Linked roots may be removed without unloading modules or clearing Node caches.
   * @param successor - fully constructed generation accepted by {@link RuntimeInterception.replace}.
   */
  replace(successor: RuntimeResolution): void {
    if (this.interception === undefined) throw new Error('plugin-packages: runtime resolution is not installed')
    this.interception.replace(successor)
    this.packages = new Map()
    this.disposeWorkerResolution?.()
    this.disposeWorkerResolution = registerWorkerResolution(successor)
  }

  /**
   * Locate the package named by a specifier without requiring a package export.
   * @param specifier - module specifier whose package owns the requested module.
   * @param parentURL - URL whose Node lookup order applies.
   * @returns the parsed package, or undefined when no package owns the request.
   */
  packageOf(specifier: string, parentURL: string): PluginPackage | undefined {
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const dir = this.interception === undefined
      ? packageDirFromParent(name, parentURL)
      : this.interception.packageDir(name, parentURL)
    if (dir === undefined) return undefined
    const key = JSON.stringify({ dir, name })
    if (!this.packages.has(key)) this.packages.set(key, readPackage(dir, name))
    return this.packages.get(key)
  }

  /**
   * Read display metadata without loading or activating the target plugin.
   * @param specifier - configured package module, including package subpaths.
   * @param parentURL - owning Loader tree's resolution base.
   * @returns local display metadata or its diagnostic; undefined for non-package requests or absent metadata.
   */
  metaOf(specifier: string, parentURL: string): PluginLocalizedMeta | undefined {
    return readPluginMeta(specifier, parentURL)
  }
}

function packageDirFromParent(name: string, parentURL: string): string | undefined {
  for (const searchPath of createRequire(parentURL).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}
