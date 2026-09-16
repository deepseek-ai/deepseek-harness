/** Serialized module and profile-configuration reloads. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { watchConfig as watchExactConfig } from './watch-config.ts'
import { Context, Inject, Service, type Plugin } from '@deepseek-ai/cordis'
import { ModuleLoader, type ModuleJob, type ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { FSWatcher, watch, type ChokidarOptions } from 'chokidar'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { readProfileManifest, readProfilePatches, reconcileProfilePatches, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import { handleError } from './error.ts'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import picomatch from 'picomatch'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Serialized plugin-code and configuration reloads. */
    hmr: Hmr
  }

  interface Events {
    /** A watched file has no module or configuration handler.
     * @mode emit
     * @param url Canonical file URL.
     */
    'hmr/change'(url: string): void
    /** Module replacements have finished loading.
     * @mode emit
     * @param reloads Replaced plugins and their module locations.
     */
    'hmr/reload'(reloads: Map<Plugin, Reload>): void
  }
}

function canonicalPath(filename: string): string {
  // Node's ESM resolver uses the JS realpath implementation; native realpath
  // expands Windows short names differently and would miss its cache keys.
  try { return realpathSync(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(filename)
    if (parent === filename) throw error
    return resolve(canonicalPath(parent), basename(filename))
  }
}

/** Module roots and watcher timing, with Chokidar deployment options. */
export interface HmrConfig extends ChokidarOptions {
  /** Directory resolved against the owning context's base URL. */
  base?: string
  /** Module watch roots; an empty list leaves only explicit configuration watches. */
  root: string[]
  /** Milliseconds for combining module changes. */
  debounce: number
  /** Glob patterns excluded from module watching. */
  ignored: string[]
}

/**
 * Recursively collect all module dependencies from a ModuleJob.
 * Skips node: builtins and node_modules to focus on user code.
 */
async function loadDependencies(job: ModuleJob, ignored = new Set<string>()) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (ignored.has(job.url) || dependencies.has(job.url)) return
    if (job.url.startsWith('node:') || job.url.includes('/node_modules/')) return
    dependencies.add(job.url)
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(job)
  return dependencies
}

/** Module location and runtime retained during a replacement. */
export interface Reload {
  filename: string
  runtime?: Plugin.Runtime | undefined
}

/** Hot reload service with Cordis-compatible module configuration and events. */
@Inject('loader')
@Inject('timer')
class Hmr extends Service {
  /** Cordis-compatible watcher defaults. */
  static Config: z<HmrConfig> = z.object({
    base: z.string(),
    root: z.array(String).role('table').default(['.']),
    ignored: z.array(String).role('table').default([
      '**/node_modules',
      '**/.*',
      'cache',
      'data',
    ]),
    debounce: z.natural().role('ms').default(100),
  })

  /** Absolute base directory used to resolve module watch roots. */
  public baseDir: string

  private readonly ownerContext: Context
  private internal: ModuleLoader
  private watcher: FSWatcher | undefined

  /**
   * Changes from externals will always trigger a full reload.
   * Externals are the dependency tree of the CLI worker entry point.
   */
  private externals!: Set<string>

  /**
   * Files that should be reloaded (accepted changes).
   * Includes all stashed files and their dependents.
   */
  private accepted!: Set<string>

  /**
   * Files that should NOT be reloaded.
   * Includes externals and files whose dependents are all declined.
   */
  private declined!: Set<string>

  /** Stashed file changes waiting to be processed */
  private stashed = new Set<string>()
  private operations: Promise<unknown> = Promise.resolve()
  private readonly executing = new AsyncLocalStorage<boolean>()
  private applicationReady: Promise<boolean> = Promise.resolve(true)
  private closing = false
  private readonly configPaths = new Set<string>()

  /** Serialize a caller-owned mutation with all automatic reload paths.
   * @param operation Work that must not overlap module or configuration replacement.
   * @returns The operation result after its asynchronous work completes.
   */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
    const task = this.operations.then(async () => {
      if (this.closing) throw new Error('HMR is disposed')
      return this.executing.run(true, operation)
    })
    this.operations = task.catch(() => {})
    return task
  }

  private runReload(operation: () => Promise<void>): Promise<void> {
    return this.runExclusive(async () => {
      if (await this.applicationReady) await operation()
    })
  }

  /** Watch a configuration path through the same queue as module replacement.
   * @param filename Absolute path, which may not exist yet.
   * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
   * @returns Disposer closing this registration and waiting for its pending refresh.
   */
  async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>> {
    const paths = [resolve(filename), canonicalPath(filename)]
    if (paths.some(path => this.configPaths.has(path))) throw new Error(`config path already registered: ${filename}`)
    for (const path of paths) this.configPaths.add(path)
    try {
      const dispose = await this.executing.exit(() => watchExactConfig(
        this.ownerContext, filename, this.config, () => this.runReload(refresh), () => this.executing.getStore() === true,
      ))
      return async () => {
        await dispose()
        for (const path of paths) this.configPaths.delete(path)
      }
    } catch (error) {
      for (const path of paths) this.configPaths.delete(path)
      throw error
    }
  }

  constructor(ctx: Context, public config: HmrConfig) {
    super(ctx, 'hmr')
    this.ownerContext = ctx
    if (!this.ctx.loader.internal) {
      throw new Error('--expose-internals is required for HMR service')
    }
    this.internal = this.ctx.loader.internal
    this.baseDir = fileURLToPath(new URL(config.base || '.', ctx.baseUrl))
  }

  /**
   * Resolve a module specifier to a URL, compatible with Node 22-24.
   */
  private async _resolve(specifier: string, parentURL: string, attrs: ImportAttributes): Promise<ResolveResult> {
    switch (this.internal.version) {
      case 'v1': return await this.internal.resolve(specifier, parentURL, attrs)
      case 'v2': return this.internal.resolveSync(parentURL, { specifier, attributes: attrs })
    }
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, unknown> {
    yield async () => {
      this.closing = true
      await this.watcher?.close()
      // A configuration reload may remove its own HMR entry.
      if (!this.executing.getStore()) await this.operations
    }

    const profile = this.ownerContext.get('profileContext')
    if (profile !== undefined) {
      const ready = this.ownerContext.get('appReady')
      if (ready === undefined) throw new Error('Profile HMR requires application readiness')
      const started = Promise.withResolvers<boolean>()
      this.applicationReady = started.promise
      const unsubscribe = ready.onReady(() => { started.resolve(true) })
      yield () => { unsubscribe(); started.resolve(false); return Promise.resolve() }
      const manifestPath = join(profile.dir, 'package.json')
      const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]
      let lastInputs: string | undefined
      let lastBundles = JSON.stringify(profile.startedBundles)
      const refresh = async (manifestOnly: boolean): Promise<void> => {
        const bundles = JSON.stringify(readProfileManifest('dsh', profile.dir).dsh?.profile?.bundles ?? [])
        if (manifestOnly && bundles === lastBundles) return
        const inputs = JSON.stringify([bundles, ...patchFiles.map((filename) => {
          try { return readFileSync(filename, 'utf8') }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          }
        })])
        if (inputs === lastInputs) return
        const patches = readProfilePatches('dsh', profile)
        const warnings = await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh')
        lastInputs = inputs
        lastBundles = bundles
        for (const diagnostic of warnings) this.ctx.logger.warn(diagnostic)
      }
      for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false))
      await this.watchConfig(manifestPath, () => refresh(true))
    }

    const { loader } = this.ctx
    const { root, ignored } = this.config
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

    const match = picomatch(ignored)
    const watchBaseDir = realpathSync(this.baseDir)

    // Collect externals before opening the watcher so every post-ready change
    // is observed by listeners that already have their classification state.
    const mainJob = process.argv[1] === undefined ? undefined
      : this.internal.loadCache.get(pathToFileURL(resolve(process.argv[1])).href)
    if (mainJob) {
      this.externals = await loadDependencies(mainJob)
    } else {
      this.externals = new Set()
    }

    this.watcher = watch(root, {
      ...this.config,
      cwd: watchBaseDir,
      ignored: path => match(relative(watchBaseDir, path)),
      ignoreInitial: true,
    })

    const changed = new Set<string>()
    const dispatch = this.ctx.debounce(() => {
      void this.runExclusive(async () => {
        if (!await this.applicationReady) return
        const batch = [...changed]
        changed.clear()
        const includes = new Set<Include>()
        let fullReload = false
        for (const path of batch) {
          const filename = canonicalPath(resolve(watchBaseDir, path))
          const configuredFilename = resolve(this.baseDir, path)
          if (this.configPaths.has(filename) || this.configPaths.has(configuredFilename)) continue
          const url = pathToFileURL(filename).href
          if (this.externals.has(url)) {
            fullReload = true
            continue
          }
          if (this.internal.loadCache.has(url)) {
            this.stashed.add(url)
            continue
          }
          const include = [...loader.entries()].map(entry => entry.subtree as Include | undefined)
            .find(tree => tree?.filename === filename || tree?.filename === configuredFilename)
          if (include !== undefined) includes.add(include)
          else this.ctx.emit('hmr/change', url)
        }
        if (!fullReload && includes.size === 0 && this.stashed.size === 0) return
        if (fullReload) {
          loader.exit()
          return
        }
        for (const include of includes) await include.refresh()
        if (this.stashed.size > 0) {
          try { await this.partialReload() } finally { this.stashed.clear() }
        }
        await loader.await()
      }).catch((error: unknown) => { this.ctx.logger.warn(error) })
    }, this.config.debounce)
    this.watcher.on('change', (path) => { changed.add(path); dispatch() })

    const ready = Promise.withResolvers<void>()
    let readyState: 'pending' | 'resolved' | 'rejected' = root.length === 0 ? 'resolved' : 'pending'
    if (root.length === 0) {
      ready.resolve()
    } else {
      this.watcher.once('ready', () => {
        readyState = 'resolved'
        ready.resolve()
      })
    }
    this.watcher.on('error', (error) => {
      if (readyState === 'pending') {
        readyState = 'rejected'
        ready.reject(error)
      } else {
        this.ctx.logger.warn(error)
      }
    })
    await ready.promise
  }

  /** Omit internal HMR frames from module import diagnostics.
   * @returns The preserved outer stack frames.
   */
  getOuterStack: () => string[] = () => []

  /** Read direct module dependency URLs from the active Node loader.
   * @param url Module URL.
   * @returns Linked module URLs, or an empty list for an uncached module.
   */
  async getLinked(url: string): Promise<string[]> {
    const job = this.internal.loadCache.get(url)
    if (!job) return []
    const linked = await job.linked
    return Array.prototype.map.call(linked, (job: ModuleJob) => job.url) as string[]
  }

  /**
   * Classify changed files into accepted (should reload) and declined (should not).
   *
   * A file is accepted if it's directly changed (stashed) or if any of its
   * dependents are accepted. A file is declined if all its dependents are
   * declined or if it's an external.
   */
  private async analyzeChanges() {
    const pending: string[] = []

    this.accepted = new Set(this.stashed)
    this.declined = new Set(this.externals)

    const isExcluded = (url: string) => url.startsWith('node:') || url.includes('/node_modules/')

    await Promise.all([...this.stashed].map(async (url) => {
      const children = await this.getLinked(url)
      for (const child of children) {
        if (this.accepted.has(child) || this.declined.has(child) || isExcluded(child)) continue
        pending.push(child)
      }
    }))

    while (pending.length) {
      let index = 0, hasUpdate = false
      while (index < pending.length) {
        const url = pending[index] as string
        const children = await this.getLinked(url)
        let isDeclined = true, isAccepted = false
        for (const child of children) {
          if (this.declined.has(child) || isExcluded(child)) continue
          if (this.accepted.has(child)) {
            isAccepted = true
            break
          } else {
            isDeclined = false
            if (!pending.includes(child)) {
              hasUpdate = true
              pending.push(child)
            }
          }
        }
        if (isAccepted || isDeclined) {
          hasUpdate = true
          pending.splice(index, 1)
          if (isAccepted) {
            this.accepted.add(url)
          } else {
            this.declined.add(url)
          }
        } else {
          index++
        }
      }
      if (!hasUpdate) break
    }

    for (const url of pending) {
      this.declined.add(url)
    }
  }

  private async partialReload() {
    await this.analyzeChanges()

    const pending = new Map<ModuleJob, Plugin>()
    const reloads = new Map<Plugin, Reload>()

    // Build a map of plugin names per config tree URL.
    // Plugin entry files are treated as atomic reload units.
    const nameMap = new Map<string, Set<string>>()
    for (const entry of this.ctx.loader.entries()) {
      const baseUrl = entry.parent.tree.ctx.baseUrl
      if (baseUrl === undefined) throw new Error('HMR entry tree has no base URL')
      const names = nameMap.get(baseUrl) ?? new Set<string>()
      names.add(entry.options.name)
      nameMap.set(baseUrl, names)
    }

    // Resolve each plugin name to its file URL and check if it needs reload
    for (const [baseUrl, names] of nameMap) {
      for (const name of names) {
        try {
          const { url } = await this._resolve(name, baseUrl, {})
          if (this.declined.has(url)) continue
          const job = this.internal.loadCache.get(url)
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace()) as Plugin | undefined
          if (!job || !plugin) continue
          pending.set(job, plugin)
          this.declined.add(url)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
    }

    // Check each pending plugin's dependency tree for accepted files
    for (const [job, plugin] of pending) {
      this.declined.delete(job.url)
      const dependencies = [...await loadDependencies(job, this.declined)]
      this.declined.add(job.url)

      if (!dependencies.some(dep => this.accepted.has(dep))) continue
      dependencies.forEach(dep => this.accepted.add(dep))

      reloads.set(plugin, {
        filename: job.url,
        runtime: this.ctx.registry.get(plugin),
      })
    }

    /**
     * Clear module caches for all accepted files before re-importing.
     *
     * We need to clear both:
     * 1. ESM loadCache — managed by Node's internal ModuleLoader
     * 2. CJS Module._cache — for CJS modules that were imported via import()
     *
     * In Node 24, CJS modules loaded via import() appear in both caches.
     * If we only clear loadCache, the CJS cache may serve stale modules.
     *
     * We use Map.prototype methods directly on loadCache because:
     * - In Node 22/23, loadCache is a plain Map<url, ModuleJob>
     * - In Node 24, loadCache is a LoadCache extends Map<url, { [type]: ModuleJob }>
     *   where .delete() only sets the type slot to undefined (doesn't remove the entry)
     * Using Map.prototype.delete ensures complete removal in both versions.
     */
    const esmBackup = new Map<string, unknown>()
    const cjsBackup = new Map<string, NodeJS.Module>()
    const require = createRequire(import.meta.url)
    for (const filename of this.accepted) {
      // Backup and clear ESM loadCache
      const job: unknown = Map.prototype.get.call(this.internal.loadCache, filename)
      esmBackup.set(filename, job)
      Map.prototype.delete.call(this.internal.loadCache, filename)

      // Backup and clear CJS Module._cache
      try {
        const filepath = fileURLToPath(filename)
        if (require.cache[filepath]) {
          cjsBackup.set(filepath, require.cache[filepath])
          Reflect.deleteProperty(require.cache, filepath)
        }
      } catch {
        // filename might not be a file: URL (e.g. node: protocol), ignore
      }
    }

    const rollback = () => {
      for (const [filename, job] of esmBackup) {
        Map.prototype.set.call(this.internal.loadCache, filename, job)
      }
      for (const [filepath, module] of cjsBackup) require.cache[filepath] = module
    }

    // Attempt to re-import all plugin entry files
    const generations = [...reloads].map(([previous, info]) => ({
      ...info, previous,
      fibers: [...info.runtime?.fibers ?? []].map((fiber) => {
        const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined
        const config: unknown = entry === undefined ? fiber._config : entry.options.config
        return { fiber, entry, config }
      }),
    }))
    const attempts: Array<(typeof generations)[number] & { replacement: Plugin }> = []
    try {
      for (const generation of generations) {
        const replacement = this.ctx.loader.unwrapExports(await this.ctx.loader.import(generation.filename, this.getOuterStack)) as Plugin
        attempts.push({ ...generation, replacement })
      }
    } catch (e) {
      handleError(this.ctx, e)
      rollback()
      throw e
    }

    const reload = async (plugin: Plugin, fibers: (typeof generations)[number]['fibers']) => {
      const activated = []
      for (const previousFiber of fibers) {
        if (previousFiber.fiber.parent.fiber.uid === null) continue
        const fiber = previousFiber.fiber.parent.registry.plugin(plugin, previousFiber.config, this.getOuterStack).ctx.fiber
        if (previousFiber.entry !== undefined) {
          fiber.entry = previousFiber.entry
          previousFiber.entry.fiber = fiber
        }
        activated.push(fiber)
      }
      await Promise.all(activated.map(fiber => fiber.await()))
    }

    const removed = new Set<Plugin>()
    try {
      for (const { previous: plugin, replacement, filename, runtime, fibers } of attempts) {
        if (!runtime) continue
        const path = relative(this.baseDir, fileURLToPath(filename))

        removed.add(plugin)
        try {
          this.ctx.registry.delete(plugin)
          await Promise.all(fibers.map(({ fiber }) => fiber.await()))
        } catch (err) {
          this.ctx.logger.warn('failed to dispose plugin at %C', path)
          this.ctx.logger.warn(err)
        }

        try {
          await reload(replacement, fibers)
          this.ctx.logger.info('reload plugin at %C', path)
        } catch (err) {
          this.ctx.logger.warn('failed to reload plugin at %C', path)
          this.ctx.logger.warn(err)
          throw err
        }
      }
    } catch (error) {
      // Restore caches and re-register old plugins after a replacement failure.
      rollback()
      for (const { previous: plugin, replacement, fibers } of attempts) {
        if (!removed.has(plugin)) continue
        try {
          const replacementRuntime = this.ctx.registry.get(replacement)
          const replacementFibers = [...replacementRuntime?.fibers ?? []]
          this.ctx.registry.delete(replacement)
          // Failed startup errors remain on fibers after their teardown finishes.
          await Promise.allSettled(replacementFibers.map(fiber => fiber.await()))
          await reload(plugin, fibers)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
      throw error
    }

    await this.ctx.loader.await()
    this.ctx.emit('hmr/reload', reloads)
    this.stashed = new Set()
  }
}

namespace Hmr {
  /** Cordis-compatible configuration type. */
  export type Config = HmrConfig


}

export default Hmr
