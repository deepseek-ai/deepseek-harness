/** Serialized module and profile-configuration reloads. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { watchConfig as watchExactConfig } from './watch-config.ts'
import { Context, Inject, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type { ModuleLoader, ModuleJob, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { FSWatcher, watch, type ChokidarOptions } from 'chokidar'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { readProfileManifest, readProfilePatches, reconcileProfilePatches, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import { handleError } from './error.ts'
import { PackageManifests } from './package-manifest.ts'
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
  /** Original namespaces and URLs of all entry modules participating in this runtime replacement. */
  modules: ReloadModules
  runtime?: Plugin.Runtime | undefined
}

/** Entry names with distinct namespaces; iteration falls back to undefined only for names without a loaded namespace. */
class EntryNamespaces {
  private readonly names = new Map<string, Set<unknown>>()

  constructor(private internal: ModuleLoader, private moduleUrls: ReadonlyMap<unknown, string>) {}

  static getModuleUrls(internal: ModuleLoader): Map<unknown, string> {
    const moduleUrls = new Map<unknown, string>()
    for (const url of internal.loadCache.keys()) {
      const job = internal.loadCache.get(url)
      if (!job?.module) continue
      try {
        moduleUrls.set(job.module.getNamespace(), url)
      } catch (_error) {
        // Node also caches unfinished jobs whose namespace is not available yet.
      }
    }
    return moduleUrls
  }

  add(name: string, moduleNamespace: unknown): this {
    const namespaces = this.names.get(name) ?? new Set<unknown>()
    namespaces.add(moduleNamespace)
    this.names.set(name, namespaces)
    return this
  }

  *[Symbol.iterator](): Generator<[name: string, moduleNamespace: unknown]> {
    for (const [name, namespaces] of this.names) {
      for (const moduleNamespace of namespaces) {
        if (moduleNamespace === undefined && namespaces.size > 1) continue
        yield [name, moduleNamespace]
      }
    }
  }

  async resolve(name: string, baseUrl: string, moduleNamespace: unknown): Promise<Pick<ResolveResult, 'url'>> {
    if (moduleNamespace === undefined || name.startsWith('cordis:')) {
      switch (this.internal.version) {
        case 'v1': return await this.internal.resolve(name, baseUrl, {})
        case 'v2': return this.internal.resolveSync(baseUrl, { specifier: name, attributes: {} })
      }
    }
    const url = this.moduleUrls.get(moduleNamespace)
    if (url === undefined) throw new Error(`HMR cannot locate the loaded module for ${name} from ${baseUrl}`)
    return { url }
  }
}

type ReloadFiber = {
  fiber: Fiber
  entry: Fiber['entry']
  config: unknown
  moduleNamespace: unknown
}

type ReloadModule = { filename: string; moduleNamespace: unknown; plugin: Plugin }

/** Entry modules belonging to one runtime, keyed by their original namespaces across replacement. */
class ReloadModules {
  private readonly modules = new Map<unknown, ReloadModule>()

  static include(reloads: ReadonlyMap<Plugin, Reload>, plugin: Plugin, job: ModuleJob, runtime: Plugin.Runtime | undefined): boolean {
    let info = reloads.get(plugin)
    if (info === undefined && runtime) info = [...reloads.values()].find(info => info.runtime === runtime)
    if (info === undefined) return false
    info.modules.add(job, plugin)
    return true
  }

  add(job: ModuleJob, plugin: Plugin): this {
    assert(job.module, `HMR pending module is missing: ${job.url}`)
    const moduleNamespace: unknown = job.module.getNamespace()
    this.modules.set(moduleNamespace, { filename: job.url, moduleNamespace, plugin })
    return this
  }

  async importRemaining(loader: Context['loader'], getOuterStack: () => string[], primary: ReloadModule): Promise<ReloadModules> {
    const replacements = new ReloadModules()
    for (const [originalNamespace, { filename }] of this.modules) {
      if (filename === primary.filename) {
        replacements.modules.set(originalNamespace, primary)
        continue
      }
      const moduleNamespace: unknown = await loader.import(filename, getOuterStack)
      const plugin = loader.unwrapExports(moduleNamespace) as Plugin
      replacements.modules.set(originalNamespace, { filename, moduleNamespace, plugin })
    }
    return replacements
  }

  *getActiveImplementations(ctx: Context, plugin: Plugin, fibers: readonly ReloadFiber[]): Generator<[ReloadFiber, Plugin]> {
    const callbacks = new Set([...this.modules.values()].map(value => ctx.registry.resolve(value.plugin)))
    const implementations = fibers.map((previousFiber) => {
      if (previousFiber.entry === undefined) return [previousFiber, plugin] as const
      const replacement = this.modules.get(previousFiber.moduleNamespace)
      const implementation = replacement ? replacement.plugin : ctx.loader.unwrapExports(previousFiber.moduleNamespace) as Plugin
      callbacks.add(ctx.registry.resolve(implementation))
      return [previousFiber, implementation] as const
    })
    for (const [previousFiber, implementation] of implementations) {
      if (previousFiber.fiber.parent.fiber.uid === null) continue
      if (previousFiber.entry === undefined && callbacks.size > 1) {
        throw new Error('HMR replacement is ambiguous for a plugin instance without a Loader entry')
      }
      yield [previousFiber, implementation]
    }
  }

  updateEntries(loader: Context['loader']): void {
    for (const [originalNamespace, { moduleNamespace }] of this.modules) {
      for (const entry of loader.entries()) {
        if (entry.moduleNamespace === originalNamespace) entry.moduleNamespace = moduleNamespace
      }
    }
  }
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
  private readonly manifests = new PackageManifests()

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

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, unknown> {
    yield async () => {
      this.closing = true
      await this.watcher?.close()
      // A configuration reload may remove its own HMR entry.
      if (!this.executing.getStore()) await this.operations
      this.manifests.dispose()
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
          const isManifest = basename(filename) === 'package.json' && !filename.includes(`${sep}node_modules${sep}`)
          if (isManifest) {
            this.manifests.invalidate(filename)
          }
          const url = pathToFileURL(filename).href
          if (this.externals.has(url)) {
            fullReload = true
            continue
          }
          if (this.internal.loadCache.has(url) || this.internal.loadCache.has(url, 'json')) {
            this.stashed.add(url)
            continue
          }
          if (isManifest) continue
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
    const moduleUrls = EntryNamespaces.getModuleUrls(this.internal)

    // Build a map of plugin names per config tree URL.
    // Plugin entry files are treated as atomic reload units.
    const nameMap = new Map<string, EntryNamespaces>()
    for (const entry of this.ctx.loader.entries()) {
      const baseUrl = entry.parent.tree.ctx.baseUrl
      if (baseUrl === undefined) throw new Error('HMR entry tree has no base URL')
      const names = nameMap.get(baseUrl) ?? new EntryNamespaces(this.internal, moduleUrls)
      names.add(entry.options.name, entry.moduleNamespace)
      nameMap.set(baseUrl, names)
    }

    // Find each plugin's loaded URL and check if it needs reload.
    for (const [baseUrl, names] of nameMap) {
      for (const [name, moduleNamespace] of names) {
        try {
          const { url } = await names.resolve(name, baseUrl, moduleNamespace)
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

      if (dependencies.length === 0) {
        pending.delete(job)
        continue
      }
      if (!dependencies.some(dep => this.accepted.has(dep))) continue
      dependencies.forEach(dep => this.accepted.add(dep))

      const runtime = this.ctx.registry.get(plugin)
      if (ReloadModules.include(reloads, plugin, job, runtime)) continue
      reloads.set(plugin, {
        filename: job.url,
        runtime,
        modules: new ReloadModules().add(job, plugin),
      })
    }

    // Re-export roots of a replaced runtime must not retain bindings to its old modules.
    for (const [job, plugin] of pending) {
      if (ReloadModules.include(reloads, plugin, job, this.ctx.registry.get(plugin))) this.accepted.add(job.url)
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
        return { fiber, entry, config, moduleNamespace: entry?.moduleNamespace }
      }),
    }))
    type ReloadAttempt = (typeof generations)[number] & {
      replacement: Plugin
      replacements: ReloadModules
      activated: Fiber[]
    }
    const attempts: ReloadAttempt[] = []
    try {
      for (const generation of generations) {
        const moduleNamespace: unknown = await this.ctx.loader.import(generation.filename, this.getOuterStack)
        const replacement = this.ctx.loader.unwrapExports(moduleNamespace) as Plugin
        const replacements = await generation.modules.importRemaining(this.ctx.loader, this.getOuterStack, {
          filename: generation.filename, moduleNamespace, plugin: replacement,
        })
        attempts.push({ ...generation, replacement, replacements, activated: [] })
      }
    } catch (e) {
      handleError(this.ctx, e)
      rollback()
      throw e
    }

    const reload = async (
      plugin: Plugin,
      fibers: (typeof generations)[number]['fibers'],
      replacements = new ReloadModules(),
      activated: Fiber[] = [],
    ) => {
      for (const [previousFiber, implementation] of replacements.getActiveImplementations(this.ctx, plugin, fibers)) {
        const fiber = previousFiber.fiber.parent.registry.plugin(implementation, previousFiber.config, this.getOuterStack).ctx.fiber
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
      for (const { previous: plugin, replacement, filename, runtime, fibers, replacements, activated } of attempts) {
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
          await reload(replacement, fibers, replacements, activated)
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
      for (const { previous: plugin, fibers, activated } of attempts) {
        if (!removed.has(plugin)) continue
        try {
          for (const { runtime } of activated) {
            if (runtime && this.ctx.registry.get(runtime.callback) === runtime) {
              const replacementFibers = [...runtime.fibers]
              this.ctx.registry.delete(runtime.callback)
              // Failed startup errors remain on fibers after their teardown finishes.
              await Promise.allSettled(replacementFibers.map(fiber => fiber.await()))
            }
          }
          await reload(plugin, fibers)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
      throw error
    }

    await this.ctx.loader.await()
    for (const { replacements } of attempts) {
      replacements.updateEntries(this.ctx.loader)
    }
    this.ctx.emit('hmr/reload', reloads)
    this.stashed = new Set()
  }
}

namespace Hmr {
  /** Cordis-compatible configuration type. */
  export type Config = HmrConfig


}

export default Hmr
