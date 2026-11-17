import { composeError, Context } from '@deepseek-ai/cordis'
import { isNonNullable, type Dict } from '@deepseek-ai/cosmokit'
import url from 'node:url'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryGroup } from './group.ts'
import { EntryValidationError, validateOptions, type SourceLocation } from './utils.ts'
import { createResolve } from '../resolve.ts'

// A Windows drive-letter path, e.g. `C:\app\plugin.js` or `C:/app/plugin.js`.
const driveLetter = /^[A-Za-z]:[\\/]/

// Node names the modules only in the message:
// `Cannot find (module|package) '<target>' imported from <parent>`
function parseNotFound(error: any) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || typeof error.message !== 'string') return
  // later lines are hints, e.g. `Did you mean to import ...?`
  const [first, ...hints] = error.message.split('\n') as string[]
  const match = first.match(/^(Cannot find (?:module|package) '.*') imported from (.*)$/)
  if (match) return { description: match[1], parent: match[2], hints }
}

function toPath(href: string) {
  try {
    return href.startsWith('file:') ? url.fileURLToPath(href) : href
  } catch {
    return href
  }
}

/** A configured plugin module that cannot be found, as opposed to a missing module imported by that plugin. */
export class ModuleNotFoundError extends Error {
  name = 'ModuleNotFoundError'
  code = 'ERR_MODULE_NOT_FOUND'

  /**
   * @param specifier - Entry `name` that failed to resolve.
   * @param message - Node's description and hints, without its importer.
   */
  constructor(public specifier: string, message: string) {
    super(message)
  }
}

/**
 * One tree-side mutation, reported to `EntryTree.commit()` synchronously after
 * it has been applied to `entry.options` / `group.data`.
 *
 * - `options` absent: the entry was removed from `group`.
 * - `legacy` absent: the entry was created in `group`.
 * - both present: the entry was updated and now lives in `group`; `from` is
 *   the group it left if the update moved it within the same tree. A move to
 *   another tree reports a removal to the source tree and a creation to the
 *   destination tree.
 *
 * `id` is local to the receiving tree; `Entry.id` prefixes it with the parent
 * tree's path. Only `EntryTree` mutation methods and explicit Fiber saves
 * report changes; file-driven `EntryGroup` reconciliation does not.
 */
export interface EntryChange {
  id: string
  group: EntryGroup
  from?: EntryGroup
  options?: EntryOptions
  legacy?: EntryOptions
}

/** The entry and the same-tree members of its group, recursively. */
function members(entry: Entry): Entry[] {
  const { tree } = entry.parent
  const result = [entry]
  const group = entry.subgroup
  if (group?.tree !== tree) return result
  for (const options of group.data) {
    const member = tree.store[options.id]
    if (member?.parent === group) result.push(...members(member))
  }
  return result
}

/** Mutable tree of loader entries. Persistence is supplied by subclasses. */
export abstract class EntryTree {
  static readonly sep = ':'

  public ctx: Context
  public enableLogs?: boolean
  public root: EntryGroup
  public store: Dict<Entry> = Object.create(null)

  constructor(ctx: Context) {
    this.ctx = ctx.extend({ baseUrl: ctx.baseUrl })
    this.root = new EntryGroup(this.ctx, this)
    const entry = this.ctx.fiber.entry
    if (entry) entry.subtree = this
  }

  get context(): Context {
    return this.ctx
  }

  /** Iterate entries in this tree and any nested subtrees. */
  * entries(): Generator<Entry, void, void> {
    for (const entry of Object.values(this.store)) {
      yield entry
      if (!entry.subtree) continue
      yield* entry.subtree.entries()
    }
  }

  /** Return pending import and lifecycle tasks owned by this tree. */
  getTasks() {
    return [...this.entries()]
      .map(entry => entry._initTask || entry.fiber?.inertia)
      .filter(isNonNullable)
  }

  /** Wait until this tree has no pending import or lifecycle tasks. */
  async await() {
    while (true) {
      const tasks = this.getTasks()
      if (!tasks.length) return
      await Promise.allSettled(tasks)
    }
  }

  /**
   * Assign a random tree-local id when `options.id` is absent. Explicit ids
   * may contain `EntryTree.sep`; `resolve()` and `resolveGroup()` cannot
   * address such entries by nested path.
   * @param options - Entry options; a generated id is written to `options.id`.
   * @returns The existing or generated id.
   */
  ensureId(options: Partial<EntryOptions>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(16).slice(2, 10)
      } while (this.store[options.id])
    }
    return options.id!
  }

  /** Resolve an entry by id, including nested ids separated by `EntryTree.sep`. */
  resolve(id: string) {
    const parts = id.split(EntryTree.sep)
    let tree: EntryTree | undefined = this
    const final = parts.pop()!
    for (const part of parts) {
      tree = tree.store[part]?.subtree
      if (!tree) throw new Error(`cannot resolve entry ${id}`)
    }
    const entry = tree.store[final]
    if (!entry) throw new Error(`cannot resolve entry ${id}`)
    return entry
  }

  resolveGroup(id: string | null) {
    if (!id) return this.root
    const entry = this.resolve(id)
    if (!entry.subgroup) throw new Error(`entry ${id} is not a group`)
    return entry.subgroup
  }

  /** Create an entry in the root group or a nested group. */
  async create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    const issues = validateOptions(options, EntryTree.sep, true)
    if (issues.length) throw new EntryValidationError(issues)
    const id = group.tree.ensureId(options)
    group.data.splice(position, 0, options as EntryOptions)
    group.tree.commit({ id, group, options: options as EntryOptions })
    return group.create(options)
  }

  /** Stop and remove an entry from its parent group. */
  remove(id: string) {
    const entry = this.resolve(id)
    const group = entry.parent
    const legacy = entry.options
    group.remove(legacy.id)
    group.tree.commit({ id: legacy.id, group, legacy })
  }

  /** Update an entry and optionally move it to another group. */
  async update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.resolve(id)
    const source = entry.parent
    const legacy = { ...entry.options }
    const issues = validateOptions(Entry.merge({ ...legacy }, options), EntryTree.sep, true)
    if (issues.length) throw new EntryValidationError(issues)
    if (parent !== undefined) {
      const target = this.resolveGroup(parent)
      const moved = target.tree === source.tree ? [] : members(entry)
      for (const member of moved) {
        const { id } = member.options
        if (target.tree.store[id]) throw new Error(`entry ${id} already exists in the target tree`)
      }
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      entry.parent = target
      // The target tree owns the moved entries from now on, so that it adopts
      // them instead of creating new ones when it reconciles its source.
      for (const member of moved) {
        delete source.tree.store[member.options.id]
        target.tree.store[member.options.id] = member
        if (member.subgroup?.tree === source.tree) member.subgroup.tree = target.tree
      }
    }
    // `Entry.update` assigns the new options before its first `await`, so the
    // change is fully visible to `commit()` once the call returns.
    const task = entry.update(options, false, true)
    if (entry.parent.tree !== source.tree) {
      // a move across trees removes the entry from the source tree and
      // creates it in the target tree
      source.tree.commit({ id: legacy.id, group: source, legacy })
      entry.parent.tree.commit({ id: legacy.id, group: entry.parent, options: entry.options })
    } else {
      const from = entry.parent === source ? undefined : source
      entry.parent.tree.commit({ id: legacy.id, group: entry.parent, from, options: entry.options, legacy })
    }
    return task
  }

  /**
   * Import a plugin module from a specifier or `cordis:` builtin. On Windows a drive-letter path is imported as a file URL.
   * Rejects with `ModuleNotFoundError` when the specifier itself cannot be found; other import errors propagate unchanged.
   */
  import(name: string, getOuterStack?: () => string[]) {
    if (name.startsWith('cordis:')) {
      return this.ctx.loader.builtins[name.slice(7)]
    }
    // On Windows, a drive-letter path is converted with `pathToFileURL`.
    if (process.platform === 'win32' && driveLetter.test(name)) {
      name = url.pathToFileURL(name).href
    }
    // to tell `name` apart from a module it imports
    let parent: string | undefined
    // the helper resolves `name` only
    let unresolved: unknown
    return composeError(async (info) => {
      // ModuleJob.run
      // onImport.tracePromise.__proto__
      // internal.import
      info.offset += 3
      if (this.ctx.loader.internal) {
        parent = this.ctx.baseUrl!
        return await this.ctx.loader.internal.import(name, parent, {})
      } else if (name.startsWith('.')) {
        parent = import.meta.url
        return await import(/* @vite-ignore */new URL(name, this.ctx.baseUrl).href)
      } else {
        const resolve = await createResolve(this.ctx.baseUrl)
        let url = name
        if (resolve) {
          try {
            url = resolve(name)
          } catch (error) {
            unresolved = error
            throw error
          }
        }
        parent = import.meta.url
        return await import(/* @vite-ignore */ url)
      }
    }, getOuterStack).catch((error: unknown) => {
      const notFound = parseNotFound(error)
      if (!notFound) throw error
      if (error !== unresolved && (!parent || notFound.parent !== toPath(parent))) throw error
      const result = new ModuleNotFoundError(name, [notFound.description, ...notFound.hints].join('\n'))
      const frames = getOuterStack?.() ?? []
      // Node's frames are those of its resolver
      if (frames.length) result.stack = [`${result.name}: ${result.message}`, ...frames].join('\n')
      throw result
    })
  }

  /** Report an applied mutation synchronously. In-memory trees may use a no-op. */
  abstract commit(change: EntryChange): void

  /**
   * Where a value of the entry options is written. A path that leaves the
   * source falls back to its deepest written ancestor.
   * @param _id - Tree-local entry id.
   * @param _path - Path inside the entry options.
   * @returns The source position, or undefined for trees without a source file.
   */
  getLocation(_id: string, _path: PropertyKey[]): SourceLocation | undefined {
    return undefined
  }
}
