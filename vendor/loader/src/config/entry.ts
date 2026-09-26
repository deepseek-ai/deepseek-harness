import { Context, Fiber, FiberState, Inject, resolveConfig } from '@deepseek-ai/cordis'
import { deepEqual, isNullable, updateVolatile, volatileEntries, type Volatile } from '@deepseek-ai/cosmokit'
import { Loader } from '../index.ts'
import { EntryGroup } from './group.ts'
import { EntryTree } from './tree.ts'
import { evaluate, isJsExpr } from './utils.ts'
import { equalExceptVolatile } from './diff.ts'

/** Serialized plugin entry options stored in loader config files. */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}

function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

/** One configured plugin node inside an `EntryTree`. */
export class Entry {
  static readonly key = Symbol.for('cordis.entry')

  public ctx: Context
  public fiber?: Fiber
  public parent!: EntryGroup
  // safety: call `entry.update()` immediately after creating an entry
  public options = {} as EntryOptions
  public subgroup?: EntryGroup
  public subtree?: EntryTree

  _initTask?: Promise<void>

  constructor(public loader: Loader) {
    this.ctx = loader.ctx.extend({ [Entry.key]: this })
    this.context.emit('loader/entry-init', this)
  }

  get context(): Context {
    return this.ctx
  }

  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.fiber.entry) {
      id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id
    }
    return id
  }

  /** True when this entry or any owning parent entry is disabled. */
  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (this.disabledOf(entry.options)) return true
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return false
  }

  /**
   * Effective disabled state: a `!!js` expression evaluates against the loader
   * context. The raw node stays in the options, so write-back keeps the form.
   */
  private disabledOf(options: EntryOptions): boolean {
    return isJsExpr(options.disabled)
      ? Boolean(this.evaluate(options.disabled.__jsExpr))
      : Boolean(options.disabled)
  }

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  private _patchContext(diff: string[]) {
    this.context.waterfall('loader/patch-context', this, () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
        this.fiber.update(this.options.config, true)
      }
    })
  }

  async refresh() {
    if (this.fiber) return
    if (this.disabled) return
    await this.init()
  }

  /** Merge new options, restart as needed, and persist through the parent tree. */
  async update(options: Partial<EntryOptions>, create = false, force = false) {
    const legacy = { ...this.options }

    // step 1: update options
    if (create) {
      this.options = options as EntryOptions
    } else {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete this.options[key]
        } else {
          this.options[key] = value
        }
      }
    }
    sortKeys(this.options)

    // step 2: execute
    if (this.disabled) {
      this.fiber?.dispose()
      return
    }

    // step 3: check if options are changed
    if (this.fiber?.uid) {
      const changes = Object.keys({ ...this.options, ...legacy })
        .filter(key => !deepEqual(this.options[key], legacy[key], key === 'config'))
      // Only an active fiber in an unchanged context takes volatile-only config changes without a remount.
      const volatileOnly = changes.length === 1 && changes[0] === 'config'
        && this.fiber.state === FiberState.ACTIVE && Object.getPrototypeOf(this.ctx) === this.parent.ctx
        && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config)
      if (volatileOnly) this.fiber._config = this.options.config
      const pending = volatileOnly && this._commitVolatile() ? [] : changes
      if (!pending.length && !force) return
      this.context.emit('loader/partial-dispose', this, legacy, true)
      this._patchContext(pending)
    } else {
      await this.init()
    }
  }

  /**
   * Parse a volatile-only raw config change and commit its values into the running fiber's references.
   * An invalid candidate is logged and leaves the running references unchanged; the raw config stays retained for the next activation.
   * @returns `false` when an ordinary effective value changed, so the caller applies the ordinary update lifecycle.
   */
  private _commitVolatile(): boolean {
    const fiber = this.fiber!
    const refs = volatileEntries(fiber.config)
    if (!refs.length) return true
    const raw = this.options.config
    let candidate: unknown
    try {
      candidate = resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', raw, () => raw))
    } catch (error) {
      this.ctx.logger.warn('volatile config update failed for %C', this.options.id)
      this.ctx.logger.warn(error)
      return true
    }
    if (!deepEqual(fiber.config, candidate, true)) {
      this.ctx.logger.debug('ordinary config values of %C changed with its volatile values; applying the ordinary update', this.options.id)
      return false
    }
    const paths = refs.flatMap(({ path, ref }) => {
      const source = path.reduce<unknown>((value, key) => Reflect.get(value as object, key), candidate) as Volatile<unknown>
      if (deepEqual(ref.get(), source.get(), true)) return []
      updateVolatile(ref, source)
      return [path]
    })
    if (!paths.length) return true
    const self: Context = Object.create(fiber.ctx)
    self[Context.filter] = (owner: Context) => owner.fiber === fiber
    try {
      fiber.ctx.emit(self, 'loader/volatile-update', paths)
    } catch (error) {
      // A listener failure must not fail the entry update; every value is already committed.
      this.ctx.logger.warn(error)
    }
    return true
  }

  getOuterStack = () => {
    let entry: Entry | undefined = this
    const result: string[] = []
    do {
      result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`)
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return result
  }

  /** Import and start the configured plugin if it is not already running. */
  async init() {
    try {
      await (this._initTask ??= this._init())
    } finally {
      this._initTask = undefined
    }
    const notify = () => {
      if (this.loader.getTasks().length) return
      this.ctx.reflect.notify(['loader'])
    }
    this.fiber?.await().then(notify, notify)
  }

  private async _init() {
    let exports: any
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
    } catch (error) {
      this.ctx.logger.error(error)
      return
    } finally {
      this._initTask = undefined
    }
    const plugin = this.loader.unwrapExports(exports)
    this._patchContext([])
    this.loader.showLog(this, 'apply')
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber
  }
}
