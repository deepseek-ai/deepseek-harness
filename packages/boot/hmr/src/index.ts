/** Serialized module and profile-configuration reloads. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { watchConfig as watchExactConfig } from './watch-config.ts'
import { Context, FiberState, Inject, Service, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type { Entry, ModuleLoader, ModuleJob, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { FSWatcher, watch, type ChokidarOptions } from 'chokidar'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import {
  readProfileManifest, readProfilePatches, recomposeProfile, PROFILE_PATCH_FILENAME, type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import { handleError } from './error.ts'
import { PackageManifests } from './package-manifest.ts'
import { ModuleFiles } from './module-files.ts'
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
 * Skips node: builtins, and node_modules unless `includeNodeModules` is set, to focus on user code.
 */
async function loadDependencies(job: ModuleJob, ignored = new Set<string>(), includeNodeModules = false) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (ignored.has(job.url) || dependencies.has(job.url)) return
    if (job.url.startsWith('node:') || (!includeNodeModules && job.url.includes('/node_modules/'))) return
    dependencies.add(job.url)
    const children = await linkedJobs(job)
    await Promise.all(children.map(traverse))
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
  private readonly files = new ModuleFiles()
  /** Every module statically reachable from the process entry point, including those under node_modules; collected on first use. */
  private hostModules!: () => Promise<Set<string>>

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
   * The cached ES module job for a URL. The packed worker loader exposes no Node module cache; native Node
   * retains this cache even when asynchronous module hooks run in a separate thread.
   */
  private esmJob(url: string): ModuleJob | undefined {
    return this.hasEsmCache() ? this.internal.loadCache.get(url) : undefined
  }

  /** Whether this thread keeps a Node ES module cache; the packed worker loader keeps none. */
  private hasEsmCache(): boolean {
    const cache: unknown = Reflect.get(this.internal, 'loadCache')
    return cache !== undefined
  }

  /** Whether the ES module cache holds a job for a URL; `false` when this thread keeps no ES module cache. */
  private esmHas(url: string, type?: string): boolean {
    return this.hasEsmCache() && (type === undefined ? this.internal.loadCache.has(url) : this.internal.loadCache.has(url, type))
  }

  /** ES module cache keys, empty when this thread keeps no ES module cache. */
  private esmUrls(): string[] {
    return this.hasEsmCache() ? [...Map.prototype.keys.call(this.internal.loadCache) as Iterable<string>] : []
  }

  /** ES module cache keys and CommonJS cache filenames as URLs. */
  private* loadedUrls(): Generator<string> {
    yield* this.esmUrls()
    for (const filename of Object.keys(commonJsCache())) yield pathToFileURL(filename).href
  }

  /** The module job of the process entry point, when the loader cached it under the entry's real path. */
  private mainJob(): ModuleJob | undefined {
    const entry = process.argv[1]
    if (entry === undefined) return undefined
    // A package bin starts through a link, and Node caches the module under its target.
    return this.esmJob(pathToFileURL(canonicalPath(resolve(entry))).href)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, unknown> {
    const mainJob = this.mainJob()
    let host: Promise<Set<string>> | undefined
    this.hostModules = () => host ??= mainJob === undefined ? Promise.resolve(new Set()) : loadDependencies(mainJob, new Set(), true)
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
      const unsubscribe = ready.onReady(() => {
        // Plugins started with the application are recorded; modules loaded later are compared by modification time.
        try {
          this.files.observe(this.profileModules(profileRoots(profile.dir)))
        } catch (error) {
          // Without a first record, modules are compared by modification time against this HMR instance’s creation time.
          this.ctx.logger.warn(error)
        }
        started.resolve(true)
      })
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
        const { warnings, pending, restartReason } = await this.reconcileProfile()
        if (restartReason !== undefined) this.ctx.logger.warn('restart required: %s', restartReason)
        if (pending.length > 0) this.ctx.logger.warn('changed modules keep running their previous code until a restart: %o', pending)
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
          if (this.esmHas(url) || this.esmHas(url, 'json')) {
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
    const job = this.esmJob(url)
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
          const job = this.esmJob(url)
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

    const rollback = this.evict(this.accepted)

    // Attempt to re-import all plugin entry files
    const generations = [...reloads].map(([previous, info]) => ({
      ...info, previous,
      fibers: [...info.runtime?.fibers ?? []].map((fiber) => {
        const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined
        const config: unknown = entry === undefined ? fiber.rawConfig : entry.options.config
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
        const wrapper = previousFiber.fiber.parent.registry.plugin(implementation, previousFiber.config, this.getOuterStack)
        const fiber = wrapper.ctx.fiber
        if (previousFiber.entry !== undefined) {
          fiber.entry = previousFiber.entry
          // Like Loader activation, store the registry wrapper; identity checks compare `.ctx.fiber`.
          previousFiber.entry.fiber = wrapper
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
    this.files.refresh(this.accepted)
    this.stashed = new Set()
  }

  /**
   * Remove modules from the ES module and CommonJS caches so the next import evaluates their files again.
   *
   * CommonJS modules loaded through `import()` appear in both caches. Node's `LoadCache` maps each URL to per-type
   * jobs, and its own `delete()` only clears one type slot, so whole entries are removed through `Map.prototype`.
   * @returns Restores the removed cache entries.
   */
  private evict(urls: Iterable<string>): () => void {
    const esmBackup = new Map<string, unknown>()
    const cjsBackup = new Map<string, NodeJS.Module>()
    const cache = commonJsCache()
    const list = [...urls]
    // CommonJS-only files have no loadCache entry to restore.
    const cached = new Set(this.esmUrls())
    for (const url of list) {
      if (cached.has(url)) {
        esmBackup.set(url, Map.prototype.get.call(this.internal.loadCache, url))
        Map.prototype.delete.call(this.internal.loadCache, url)
      }
    }
    for (const filepath of list.filter(url => url.startsWith('file:')).map(url => fileURLToPath(url))) {
      const module = cache[filepath]
      if (module !== undefined) {
        cjsBackup.set(filepath, module)
        Reflect.deleteProperty(cache, filepath)
      }
    }
    return () => {
      for (const [url, job] of esmBackup) Map.prototype.set.call(this.internal.loadCache, url, job)
      for (const [filepath, module] of cjsBackup) cache[filepath] = module
    }
  }

  /** Loaded `file:` modules below the given profile roots. */
  private profileModules(roots: readonly string[]): string[] {
    return [...this.loadedUrls()].filter((url) => {
      if (!url.startsWith('file:')) return false
      const filename = fileURLToPath(url)
      return roots.some(root => filename.startsWith(root))
    })
  }

  /** Static import edges between loaded modules, across ES module links and CommonJS `require` children. */
  private async moduleGraph(): Promise<Map<string, Set<string>>> {
    const importers = new Map<string, Set<string>>()
    const add = (parent: string, child: string) => {
      importers.set(child, (importers.get(child) ?? new Set()).add(parent))
    }
    await Promise.all([...moduleJobs(this.internal)].map(async (job) => {
      for (const child of await linkedJobs(job)) add(job.url, child.url)
    }))
    for (const [filename, module] of Object.entries(commonJsCache())) {
      // Code that writes `require.cache` directly can store objects that are not Node modules.
      /* v8 ignore next -- Node stores no undefined values in require.cache; the index type admits them */
      const children: unknown = module === undefined ? undefined : Reflect.get(module, 'children')
      if (!Array.isArray(children)) continue
      for (const child of children as NodeJS.Module[]) add(pathToFileURL(filename).href, pathToFileURL(child.filename).href)
    }
    return importers
  }

  /**
   * Plan the replacement of changed modules without changing anything. A changed module whose importers reach the
   * process entry point's static graph, or a plugin that no affected Loader entry starts, stays loaded with its
   * importers and is pending. The other changed modules and every module importing them are evicted by
   * {@link stopPlanned}, which also expires the manifests from each changed file up to its root and stops the Loader
   * entries running affected plugins.
   * @param stale Changed module URLs.
   * @param roots Directories, with a trailing separator, that bound the expired manifests.
   * @returns The pending modules and the replacement of the others.
   */
  private async planReplacement(stale: ReadonlySet<string>, roots: readonly string[]): Promise<ReplacementPlan> {
    const importers = await this.moduleGraph()
    const host = await this.hostModules()
    const managed = new Set(this.ctx.loader.entries())
    const plan: ReplacementPlan = {
      pending: [], evicted: new Set(), manifests: new Set(), plugins: new Set(), fibers: new Set(),
    }
    for (const url of stale) {
      const affected = new Set([url])
      for (const module of affected) for (const importer of importers.get(module) ?? []) affected.add(importer)
      const running = [...new Set([...affected].flatMap(module => this.pluginsOf(module)))]
        .flatMap(plugin => [...this.ctx.registry.get(plugin)?.fibers ?? []].map(fiber => ({ plugin, fiber })))
      const affectedFibers = new Set(running.map(({ fiber }) => fiber))
      /** The Loader entry whose own fiber runs an affected plugin and starts this fiber directly or through its ancestors. */
      const owner = (fiber: Fiber): Entry | undefined => {
        for (let current = fiber; current.uid !== 0; current = current.parent.fiber) {
          const entry = current.entry
          if (entry?.fiber?.ctx.fiber === current && managed.has(entry) && affectedFibers.has(current)) return entry
        }
        return undefined
      }
      const entries = running.flatMap(({ fiber }) => owner(fiber) ?? [])
      // A plugin registered outside a Loader entry has no owner that can start its replacement.
      const reason = [...affected].some(module => host.has(module)) ? 'host-module'
        : entries.length < running.length ? 'unmanaged-plugin' : undefined
      if (reason !== undefined) {
        plan.pending.push({ url, reason })
        continue
      }
      for (const manifest of packageManifests(url, roots)) plan.manifests.add(manifest)
      for (const module of affected) plan.evicted.add(module)
      for (const { plugin, fiber } of running) {
        plan.plugins.add(plugin)
        plan.fibers.add(fiber)
      }
    }
    return plan
  }

  /**
   * The plugins a loaded module exports, read from the ES module namespace and the CommonJS exports Node cached for it
   * without evaluating anything.
   * @param url Loaded module URL.
   * @returns The exported plugins.
   */
  private pluginsOf(url: string): Plugin[] {
    const namespace = namespaceOf(this.esmJob(url))
    const required = url.startsWith('file:') ? commonJsCache()[fileURLToPath(url)] : undefined
    const exports: unknown = required?.loaded === true ? required.exports : undefined
    return [namespace, exports].filter(value => value !== undefined).map(value => this.ctx.loader.unwrapExports(value) as Plugin)
  }

  /**
   * Carry out a planned replacement: expire its manifests, evict its modules without a backup, and stop its Loader
   * entries, so applying the generation imports the current files when it starts them.
   * @param plan The planned replacement.
   */
  private async stopPlanned(plan: ReplacementPlan): Promise<void> {
    for (const manifest of plan.manifests) this.manifests.invalidate(manifest)
    this.evict(plan.evicted)
    // Deleting the runtime stops its fibers without the Loader recording the entries as disabled.
    for (const plugin of plan.plugins) this.ctx.registry.delete(plugin)
    // Cordis contains disposal failures in the fiber, which logs them.
    await Promise.allSettled([...plan.fibers].map(fiber => fiber.await()))
  }

  /**
   * Evict the loaded modules below the directories of mappings a recomposition dropped and expire their package
   * configuration, so a disabled or removed package that is installed or enabled again is imported afresh. Modules of
   * DSH's own static graph, and those below a directory that is still mapped, stay loaded.
   * @param dropped Real directories, with a trailing separator, of the dropped mappings.
   * @param kept Real directories, with a trailing separator, of the mappings that stay.
   */
  private async evictDropped(dropped: readonly string[], kept: ReadonlySet<string>): Promise<void> {
    if (dropped.length === 0) return
    const host = new Set(await this.hostModules())
    const urls = this.profileModules(dropped).filter((url) => {
      const filename = fileURLToPath(url)
      return !host.has(url) && ![...kept].some(dir => filename.startsWith(dir))
    })
    for (const url of urls) for (const manifest of packageManifests(url, dropped)) this.manifests.invalidate(manifest)
    this.evict(urls)
  }

  /** Report a failed replacement step and retain the caller’s fallback outcome. */
  private async contained<T>(step: string, operation: () => T | Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      this.ctx.logger.warn('%s failed; module replacement was not completed', step)
      this.ctx.logger.warn(error)
      return fallback
    }
  }

  /**
   * Recompose the profile from its manifest and patch files, replacing running plugins whose loaded files below the
   * profile directory or its linked package targets changed on disk, and publishing its runtime resolution. Changed
   * modules are evicted and the Loader entries running them stop; app-boot's {@link recomposeProfile} then publishes the
   * resolution, applies the generation, starts the stopped entries with the current files and configuration,
   * imports entries whose import failed again, and judges activation. Afterwards the modules below the mappings the
   * recomposition dropped are evicted, so a removed or deselected package is imported afresh when it returns. Callers run
   * inside {@link runExclusive}.
   * @param requiredIds Entry ids whose inactive state is reported as a failure even when it predates this call.
   * @returns Inactive-entry diagnostics, the changed modules that load after a restart, and a profile-wide restart reason.
   * @throws The patch read, publication, preparation, apply, or activation failure of the recomposition, including a
   * replacement plugin that fails to load or start, whose previous code no longer runs.
   */
  async reconcileProfile(requiredIds: readonly string[] = []): Promise<ProfileReconciliation> {
    if (this.executing.getStore() !== true) throw new Error('HMR profile reconciliation must run inside runExclusive')
    const profile = this.ownerContext.get('profileContext')
    if (profile === undefined) throw new Error('HMR profile reconciliation requires profileContext')
    // Entries this recomposition stops start again, and fail it when they cannot.
    const running = [...this.ctx.loader.entries()].filter(entry => entry.fiber?.state === FiberState.ACTIVE)
    // Read while the packages are still on disk, so a removed link's target is known in its real spellings.
    const mapped = mappedDirectories(this.ownerContext.get('pluginPackages')?.resolution)
    let comparison: ProfileComparison | undefined
    let comparedAt = 0
    let pending: PendingModule[] = []
    try {
      const patches = readProfilePatches('dsh', profile)
      comparedAt = this.files.now()
      // A failed comparison keeps every record, so the next recomposition compares the same modules again.
      comparison = await this.contained('comparing loaded modules with disk', () => {
        const roots = profileRoots(profile.dir)
        return Promise.resolve({ roots, ...this.files.compare(this.profileModules(roots)) })
      }, undefined)
      // Changed modules stay stale until replaced, including when the generation cannot be applied.
      pending = [...comparison?.stale ?? []].map(url => ({ url, reason: 'module-comparison' }))
      const compared = comparison
      const unavailable = !this.hasEsmCache()
      if (!unavailable && compared !== undefined && pending.length > 0) {
        pending = await this.contained('planning module replacement', async () => {
          const plan = await this.planReplacement(compared.stale, compared.roots)
          await this.stopPlanned(plan)
          return plan.pending
        }, pending)
      }
      // Modules whose links or evaluation failed are evicted, so the recomposition retries failed imports against a
      // corrected file or a dependency installed since.
      await this.contained('expiring failed imports', () => {
        // Without an ES module cache no failed module is known.
        if (unavailable) return
        const roots = compared?.roots ?? [realpathSync(profile.dir) + sep]
        // A dependency installed since the failed import can sit in a directory Node recorded as having no manifest.
        for (const root of roots) this.manifests.invalidate(join(root, 'package.json'))
        // Node keeps a module whose links or evaluation failed.
        this.evict(this.profileModules(roots).filter((url) => {
          const job = this.esmJob(url)
          return job !== undefined && namespaceOf(job) === undefined
        }))
      }, undefined)
      const result = await recomposeProfile(this.ownerContext.root, patches, 'dsh', { requiredIds, running })
      const restartReason = compared === undefined || unavailable ? 'module-comparison' : result.restartReason
      return { warnings: result.warnings, pending, ...restartReason === undefined ? {} : { restartReason } }
    } finally {
      const recorded = comparison
      await this.contained('evicting dropped packages', () => {
        const kept = mappedDirectories(this.ownerContext.get('pluginPackages')?.resolution)
        return this.evictDropped([...mapped].filter(dir => !kept.has(dir)), kept)
      }, undefined)
      await this.contained('recording loaded module files', () => {
        if (recorded === undefined) return
        // Identities read before replacement keep writes made since then detectable.
        const urls = this.profileModules(recorded.roots)
        this.files.observe(urls, { seen: recorded.seen, retained: new Set(pending.map(({ url }) => url)), at: comparedAt })
      }, undefined)
    }
  }
}

/** Loaded profile modules compared with disk, with the roots that bound them. */
interface ProfileComparison {
  roots: string[]
  stale: Set<string>
  seen: Map<string, string | undefined>
}

/** The modules a replacement evicts, the manifests it expires, and the plugins it stops; pending modules stay loaded. */
interface ReplacementPlan {
  pending: PendingModule[]
  evicted: Set<string>
  manifests: Set<string>
  plugins: Set<Plugin>
  fibers: Set<Fiber>
}

/** Outcome of {@link Hmr.reconcileProfile}. */
export interface ProfileReconciliation {
  /** Diagnostics for Loader entries left inactive. */
  warnings: string[]
  /** Loaded modules whose files changed on disk and whose previous code keeps running until a restart. */
  pending: PendingModule[]
  /**
   * Why every change waits for a restart: `module-comparison` when module caches cannot be inspected or their files
   * compared, even when no URLs are known; `package-moved` when the runtime resolution cannot publish a moved package.
   */
  restartReason?: 'module-comparison' | 'package-moved'
}

/** A changed module that loads only after a restart. */
export interface PendingModule {
  url: string
  /**
   * `host-module`: the process entry point's static graph imports it. `unmanaged-plugin`: it is imported by a plugin
   * that runs outside a traversable Loader entry. `module-comparison`: loaded modules could not be compared with disk.
   */
  reason: 'host-module' | 'unmanaged-plugin' | 'module-comparison'
}

/** Node's `kErrored` module status, the same in every supported Node version. */
const MODULE_ERRORED = 5

/** The namespace of a cached module job, or `undefined` when it has none or its evaluation threw. */
function namespaceOf(job: ModuleJob | undefined): unknown {
  if (job?.module === undefined) return undefined
  // A module whose evaluation threw keeps a namespace whose bindings were never initialized. `getStatus()` exists on
  // ModuleWrap in every supported Node version, like the other loader internals HMR reads.
  const status: unknown = Reflect.apply(Reflect.get(job.module, 'getStatus') as () => number, job.module, [])
  if (status === MODULE_ERRORED) return undefined
  try {
    return job.module.getNamespace()
  /* v8 ignore start -- a cached module still linking in a concurrent import has no namespace yet; tests cannot hold an import there */
  } catch (_error) {
    // A module that has not been instantiated exports no running plugin.
    return undefined
  }
  /* v8 ignore stop */
}

/**
 * The jobs a module job links to. The v2 loader may expose them as an array; v1 keeps the job of a failed import
 * whose links reject, and such a job contributes no links.
 */
async function linkedJobs(job: ModuleJob): Promise<ModuleJob[]> {
  /* v8 ignore next -- CI coverage uses the v2 loader, which drops failed jobs from the cache */
  const linked = await Promise.resolve(job.linked).catch((_error: unknown) => [])
  // The v1 loader may return a null-prototype array without methods or an iterator.
  return Array.from(linked)
}

/** The Node-compatible CommonJS cache; the packed worker implements require without exposing this cache. */
function commonJsCache(): NodeJS.Dict<NodeJS.Module> {
  // Node's type declares the cache present for every `require`.
  const cache: unknown = Reflect.get(createRequire(import.meta.url), 'cache')
  return (cache ?? {}) as NodeJS.Dict<NodeJS.Module>
}

/** Every module job in the loader cache; Node's `LoadCache` maps each URL to per-type jobs. */
function* moduleJobs(internal: ModuleLoader): Generator<ModuleJob> {
  for (const value of Map.prototype.values.call(internal.loadCache) as Iterable<Partial<Record<string, ModuleJob>>>) {
    yield* Object.values(value).filter(job => job !== undefined)
  }
}

/**
 * The directories of a runtime resolution's profile mappings and linked roots, in every real spelling of those that
 * exist, each with a trailing separator.
 * @param resolution The published resolution, if any.
 * @returns The directories; none without a resolution.
 */
function mappedDirectories(resolution: RuntimeResolution | undefined): Set<string> {
  const directories = new Set<string>()
  if (resolution === undefined) return directories
  const dirs = [...resolution.entries.filter(entry => entry.scope === 'profile').map(entry => entry.packageDir),
    ...resolution.linkedRoots.map(root => root.realPath)]
  for (const dir of dirs) for (const spelling of existsSync(dir) ? realSpellings(dir) : [dir]) directories.add(spelling + sep)
  return directories
}

/**
 * The JavaScript and native real paths of an existing path. A packed worker's file system has no native realpath.
 * @param path Existing path.
 * @returns The distinct spellings.
 */
function realSpellings(path: string): string[] {
  const native: unknown = Reflect.get(realpathSync, 'native')
  return [realpathSync(path), ...typeof native === 'function' ? [String(Reflect.apply(native, realpathSync, [path]))] : []]
}

/**
 * Real directories, with a trailing separator, of the profile and of the targets its linked packages point to. Each
 * appears in both real-path spellings: Node's module caches use the JavaScript one, the runtime resolution the native
 * one, and on Windows they differ for 8.3 short names.
 */
function profileRoots(dir: string): string[] {
  const real = realpathSync(dir)
  const modules = join(real, 'node_modules')
  const names = existsSync(modules) ? readdirSync(modules) : []
  const packages = names.flatMap(name => name.startsWith('@')
    ? readdirSync(join(modules, name)).map(child => join(modules, name, child))
    : [join(modules, name)])
  const linked = packages.filter(path => lstatSync(path).isSymbolicLink() && existsSync(path))
  return [...new Set([dir, ...linked].flatMap(path => realSpellings(path)).map(root => root + sep))]
}

/** Every `package.json` from a module file's directory up to the profile root or linked package target containing it. */
function packageManifests(url: string, roots: readonly string[]): string[] {
  const manifests: string[] = []
  const contains = (directory: string) => roots.some(root => (directory + sep).startsWith(root))
  for (let directory = dirname(fileURLToPath(url)); contains(directory); directory = dirname(directory)) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) manifests.push(candidate)
  }
  return manifests
}

namespace Hmr {
  /** Cordis-compatible configuration type. */
  export type Config = HmrConfig


}

export default Hmr
