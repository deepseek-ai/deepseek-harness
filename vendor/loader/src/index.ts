import { Context, FiberState, Inject, Service, type Fiber } from '@deepseek-ai/cordis'
import { defineProperty, isNullable, type Dict } from '@deepseek-ai/cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry, type EntryOptions } from './config/entry.ts'
import { EntryGroup } from './config/group.ts'
import isolate from './config/isolate.ts'
import { EntryTree } from './config/tree.ts'
import { interpolate } from './config/utils.ts'

/** Re-export entry node APIs. */
export * from './config/entry.ts'
/** Re-export nested entry group APIs. */
export * from './config/group.ts'
/** Re-export service isolation helpers. */
export * from './config/isolate.ts'
/** Re-export entry tree persistence APIs. */
export * from './config/tree.ts'
/** Re-export loader config expression helpers. */
export * from './config/utils.ts'
/** Re-export Node internal module loader compatibility types. */
export * from './internal.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
    'loader/entry-init'(entry: Entry): void
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    /**
     * Volatile config values were committed into the running fiber without a remount; dispatched to the owning fiber only.
     * @param paths - changed config paths as key arrays; every value is committed before dispatch.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
    /**
     * Refresh entry context before applying config.
     * @param entry - entry containing the new raw config and optional current fiber.
     * @param next - continue context refresh and Loader's config update.
     * @mode waterfall
     */
    'loader/patch-context'(entry: Entry, next: () => void): void
  }

  interface Context {
    loader: Loader
  }

  interface EnvData {
    startTime?: number
  }

  interface Fiber {
    entry?: Entry
  }
}

/** Loader config and dependency intercept namespace. */
export namespace Loader {
  /** Root loader configuration. */
  export interface Config {
    /** Base URL used to resolve relative plugin specifiers and config paths. */
    baseUrl?: string
  }

  /** Intercept config used when other plugins depend on `loader`. */
  export interface Intercept {
    /** Keep dependent plugins pending while loader entries are still loading. */
    await?: boolean
  }
}

/**
 * Service that owns a loader entry tree and imports configured plugins.
 *
 * Subclasses provide persistence by implementing `write()` on `EntryTree`.
 */
export class Loader extends EntryTree {
  declare [Service.config]: Loader.Intercept

  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public name = 'loader'
  public internal = ModuleLoader.fromInternal()

  public builtins: Dict<any> = Object.create(null)

  constructor(ctx: Context, public config: Loader.Config = {}) {
    super(ctx)
    if (config.baseUrl) {
      this.ctx.baseUrl = config.baseUrl
    }
    const self = this

    defineProperty(this, Service.tracker, {
      associate: 'loader',
      property: 'ctx',
      noShadow: true,
    })

    ctx.reflect.provide('loader', this, this[Service.check])

    ctx.on('internal/config', function (this: Fiber, _config, next) {
      const config = next()
      if (!this.entry || this.parent.fiber?.entry === this.entry) return config
      // Tree carriers (Group, Include) keep their configs literal: their
      // entry and patch lists hold other rows' configs, whose `!!js`
      // expressions belong to those rows' own fibers.
      const plugin = this.runtime?.callback as Record<PropertyKey, unknown> | undefined
      if (plugin?.[EntryGroup.key]) return config
      return interpolate(this.ctx, config)
    }, { global: true })

    ctx.on('internal/update', function (config, noSave, next) {
      if (!this.entry || noSave || this.parent.fiber?.entry === this.entry) return next()
      const unparse = this.runtime?.Config?.['simplify']
      this.entry.options.config = unparse ? unparse.call(this.runtime!.Config, config) : config
      this.entry.parent.tree.write()
      return next()
    }, { global: true, prepend: true })

    ctx.on('internal/update', function (config, _, next) {
      if (!this.entry || this.parent.fiber?.entry === this.entry) return next()
      self.showLog(this.entry, 'reload')
      return next()
    }, { global: true })

    ctx.on('internal/plugin', (fiber) => {
      // 1. set `fiber.entry`
      if (fiber.parent[Entry.key] && !fiber.entry) {
        fiber.entry = fiber.parent[Entry.key]
        // FIXME merge config
        Inject.resolve(fiber.entry!.options.inject, fiber.inject)
      }

      // 2. handle self-dispose
      // We only care about `ctx.fiber.dispose()`, so we need to filter out other cases.

      // case 1: fiber is created
      if (fiber.uid) return

      // case 2: fiber is not tracked by loader
      if (!fiber.entry) return

      // case 3: fiber is a child plugin under the entry (not the entry's root fiber)
      if (fiber.parent.fiber?.entry === fiber.entry) return

      // case 4: fiber is disposed on behalf of plugin deletion (such as plugin hmr)
      // self-dispose: ctx.fiber.dispose() -> fiber / runtime dispose -> delete(plugin)
      // plugin hmr: delete(plugin) -> runtime dispose -> fiber dispose
      if (!ctx.registry.has(fiber.runtime!.callback)) return

      // case 5: the entry's tree is being disposed
      const treeOwner = fiber.entry.parent.tree.ctx.fiber
      if (!treeOwner.uid || treeOwner.state === FiberState.UNLOADING) return

      this.showLog(fiber.entry, 'unload')

      // case 6: fiber is disposed by loader behavior
      // such as inject checker, config file update, ancestor group disable
      if (fiber.entry.disabled) return

      fiber.entry.options.disabled = true
      fiber.entry.parent.tree.write()
    })

    ctx.plugin(isolate)
  }

  write() {
    // Loader's root tree is in-memory; writes are no-ops.
  }

  [Service.check]() {
    const config: Loader.Intercept = Service.prototype[Service.resolveConfig].call(this)
    if (config.await && this.getTasks().length) return false
    return true
  }

  showLog(entry: Entry, type: string) {
    if (entry.options.group || !entry.parent.tree.enableLogs) return
    this.ctx.root.logger?.('loader').info('%s plugin %C', type, entry.options.name)
  }

  /** Return the loader entry id that owns `fiber`, if any. */
  locate(fiber = this.ctx.fiber) {
    while (1) {
      if (fiber.entry) return fiber.entry.id
      const next = fiber.parent.fiber
      if (fiber === next) return
      fiber = next
    }
  }

  /** Hook for hosts that can restart the process on full-reload requests. */
  exit() {
  }

  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
}

export default Loader
