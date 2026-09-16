/** Package metadata resolved through one profile resolution registration. */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  barePackageName,
  installProfileResolution,
  registerWorkerResolution,
  type ProfileResolutionBehavior,
  type ProfileResolutionRegistration,
} from './resolver.ts'
import type { ProfileResolutionGeneration } from '../profile.ts'

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

/** Optional runtime resolver installed and owned by {@link PluginPackages}. */
export interface PluginPackagesConfig {
  /** Complete package table; omit it to expose native package lookup only. */
  generation?: ProfileResolutionGeneration
  /** Enforce the table or compare it with a materialized fallback. */
  behavior?: ProfileResolutionBehavior
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
  private readonly resolver: ProfileResolutionRegistration | undefined
  private readonly behavior: ProfileResolutionBehavior
  private disposeWorkerResolution: (() => void) | undefined

  constructor(ctx: Context, config: PluginPackagesConfig = {}) {
    super(ctx, 'pluginPackages')
    this.behavior = config.behavior ?? 'enforce'
    if (config.generation === undefined) return
    const resolver = installProfileResolution(config.generation, this.behavior)
    this.disposeWorkerResolution = registerWorkerResolution(config.generation, this.behavior)
    this.resolver = resolver
    ctx.effect(() => () => {
      this.disposeWorkerResolution?.()
      resolver.dispose()
    }, 'profile package resolution')
  }

  /**
   * Publish an additive generation for this process and subsequently created Workers.
   * @param generation - fully constructed successor generation.
   */
  replace(generation: ProfileResolutionGeneration): void {
    if (this.resolver === undefined) throw new Error('plugin-packages: runtime resolution is not installed')
    this.resolver.replace(generation)
    this.packages = new Map()
    this.disposeWorkerResolution?.()
    this.disposeWorkerResolution = registerWorkerResolution(generation, this.behavior)
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
    const dir = this.resolver === undefined
      ? packageDirFromParent(name, parentURL)
      : this.resolver.packageDir(name, parentURL)
    if (dir === undefined) return undefined
    const key = JSON.stringify({ dir, name })
    if (!this.packages.has(key)) this.packages.set(key, readPackage(dir, name))
    return this.packages.get(key)
  }
}

function packageDirFromParent(name: string, parentURL: string): string | undefined {
  for (const searchPath of createRequire(parentURL).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}
