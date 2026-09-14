import { Context, Inject, Service, type Plugin } from '@deepseek-ai/cordis'
import type { Dict } from '@deepseek-ai/cosmokit'
import { ModuleLoader, type ModuleJob, type ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { FSWatcher, watch, type ChokidarOptions } from 'chokidar'
import { relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { handleError } from './error.ts'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import picomatch from 'picomatch'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hmr: Hmr
  }

  interface Events {
    'hmr/change'(url: string): void
    'hmr/reload'(reloads: Map<Plugin, Reload>): void
  }
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

interface Reload {
  filename: string
  runtime?: Plugin.Runtime
}

@Inject('loader')
@Inject('timer')
class Hmr extends Service {
  public baseDir: string

  private internal: ModuleLoader
  private watcher!: FSWatcher

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

  constructor(ctx: Context, public config: Hmr.Config) {
    super(ctx, 'hmr')
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

  async* [Service.init]() {
    yield () => this.watcher?.close()

    const { loader } = this.ctx
    const { root, ignored } = this.config
    if (!this.config.base) {
      this.ctx.logger.info('watching %o', root)
    } else {
      this.ctx.logger.info('watching %o in %s', root, this.baseDir)
    }

    const match = picomatch(ignored)
    const watchBaseDir = await realpath(this.baseDir)

    // Collect externals before opening the watcher so every post-ready change
    // is observed by listeners that already have their classification state.
    const mainUrl = pathToFileURL(resolve(process.argv[1])).href
    const mainJob = this.internal.loadCache.get(mainUrl)
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

    const partialReload = this.ctx.debounce(() => this.partialReload(), this.config.debounce)

    this.watcher.on('change', async (path) => {
      this.ctx.logger.debug('change detected at %C', path)
      const filename = resolve(watchBaseDir, path)
      const configuredFilename = resolve(this.baseDir, path)
      const url = pathToFileURL(filename).href

      // Full reload: the changed file is part of the framework
      if (this.externals.has(url)) return loader.exit()

      // Partial reload: the file is in the ESM loadCache
      // In Node 24, both CJS and ESM modules imported via import() end up
      // in loadCache, so this check covers all module formats.
      if (loader.internal!.loadCache.has(url)) {
        this.stashed.add(url)
        return partialReload()
      }

      for (const entry of loader.entries()) {
        const include = entry.subtree as Include | undefined
        if (include?.filename !== filename && include?.filename !== configuredFilename) continue
        await include.refresh()
        return
      }

      this.ctx.emit('hmr/change', url)
    })

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

  // hide stack trace from HMR
  getOuterStack = (): string[] => [
    // '    at HMR.partialReload (<anonymous>)',
  ]

  async getLinked(url: string) {
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
        const url = pending[index]
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
    const nameMap: Dict<Set<string>> = Object.create(null)
    for (const entry of this.ctx.loader.entries()) {
      (nameMap[entry.parent.tree.ctx.baseUrl!] ??= new Set()).add(entry.options.name)
    }

    // Resolve each plugin name to its file URL and check if it needs reload
    for (const baseUrl in nameMap) {
      for (const name of nameMap[baseUrl]) {
        try {
          const { url } = await this._resolve(name, baseUrl, {})
          if (this.declined.has(url)) continue
          const job = this.internal.loadCache.get(url)
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace())
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
    const esmBackup: Dict = Object.create(null)
    const cjsBackup: Dict = Object.create(null)
    const require = createRequire(import.meta.url)
    for (const filename of this.accepted) {
      // Backup and clear ESM loadCache
      const job = Map.prototype.get.call(this.internal.loadCache, filename)
      esmBackup[filename] = job
      Map.prototype.delete.call(this.internal.loadCache, filename)

      // Backup and clear CJS Module._cache
      try {
        const filepath = fileURLToPath(filename)
        if (require.cache[filepath]) {
          cjsBackup[filepath] = require.cache[filepath]
          delete require.cache[filepath]
        }
      } catch {
        // filename might not be a file: URL (e.g. node: protocol), ignore
      }
    }

    const rollback = () => {
      for (const filename in esmBackup) {
        Map.prototype.set.call(this.internal.loadCache, filename, esmBackup[filename])
      }
      for (const filepath in cjsBackup) {
        require.cache[filepath] = cjsBackup[filepath]
      }
    }

    // Attempt to re-import all plugin entry files
    const attempts: Dict = {}
    try {
      for (const [, { filename }] of reloads) {
        attempts[filename] = this.ctx.loader.unwrapExports(await this.ctx.loader.import(filename, this.getOuterStack))
      }
    } catch (e) {
      handleError(this.ctx, e)
      return rollback()
    }

    const reload = (plugin: any, runtime: Plugin.Runtime) => {
      if (!runtime) return
      for (const oldFiber of runtime.fibers) {
        const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, this.getOuterStack)
        fiber.entry = oldFiber.entry
        if (fiber.entry) fiber.entry.fiber = fiber
      }
    }

    try {
      for (const [plugin, { filename, runtime }] of reloads) {
        if (!runtime) continue
        const path = relative(this.baseDir, fileURLToPath(filename))

        try {
          this.ctx.registry.delete(plugin)
        } catch (err) {
          this.ctx.logger.warn('failed to dispose plugin at %C', path)
          this.ctx.logger.warn(err)
        }

        try {
          reload(attempts[filename], runtime)
          this.ctx.logger.info('reload plugin at %C', path)
        } catch (err) {
          this.ctx.logger.warn('failed to reload plugin at %C', path)
          this.ctx.logger.warn(err)
          throw err
        }
      }
    } catch {
      // Rollback: restore caches and re-register old plugins
      rollback()
      for (const [plugin, { filename, runtime }] of reloads) {
        if (!runtime) continue
        try {
          this.ctx.registry.delete(attempts[filename])
          reload(plugin, runtime)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
      return
    }

    this.ctx.emit('hmr/reload', reloads)
    this.stashed = new Set()
  }
}

namespace Hmr {
  export interface Config extends ChokidarOptions {
    base?: string
    root: string[]
    debounce: number
    ignored: string[]
  }

  export const Config: z<Config> = z.object({
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
  // [deepseek-harness] vendored modification: removed `.i18n({ 'en-US': enUS, 'zh-CN': zhCN })`
  // and the corresponding `./locales/*.yml` imports, to avoid a runtime YAML import hook
  // (@cordisjs/unyaml) that we don't vendor. See vendor/README.md.
}

export default Hmr
