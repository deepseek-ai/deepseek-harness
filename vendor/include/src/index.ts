import { EntryGroup, EntryTree, isJsExpr, type EntryChange, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { Context, Service } from '@deepseek-ai/cordis'
import { extname } from 'node:path'
import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { applyPatches, type PatchOptions } from './patch.ts'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

/**
 * The entry-list YAML dialect: `!!js` scalars round-trip as expression nodes
 * the Loader evaluates at entry activation. Exported so config tooling
 * (`dsh --dump-config`) parses and prints exactly the dialect this include
 * mounts.
 */
export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

const schema = entryListSchema

const writable: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

const supported = new Set(Object.keys(writable))

const WRITE_RETRY_LIMIT = 10
const WRITE_RETRY_DELAY_MS = 50

function retryableWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

/** Apply the upstream patch algorithm to detached entry data for mounting or config dumps. */
export { applyPatches as applyEntryPatches } from './patch.ts'
/** Serialized entry patch options. */
export type { PatchOptions } from './patch.ts'

/** Config namespace for the file-backed include loader. */
export namespace Include {
  /** Config for a file-backed loader subtree. */
  export interface Config {
    /** YAML or JSON path resolved from `ctx.baseUrl`. */
    path: string
    /** Entry list written when the file does not already exist. */
    initial?: any[]
    /** Runtime patches applied after reading the file. */
    patches?: PatchOptions[]
    /** Enables loader apply/reload/unload logs for this subtree. */
    enableLogs?: boolean
  }
}

/** Loader entry tree backed by a YAML or JSON file. */
export class Include extends EntryTree {
  static inject = ['loader']

  // Tree-carrier marker (the Group plugin declares the same): this config is
  // entry and patch lists, so the Loader's `internal/config` interpolation
  // keeps it literal — a `!!js` expression inside a nested row's config
  // belongs to that row's fiber, resolving lazily in the row's own context.
  // Include's own fields (`path`, `enableLogs`) therefore stay literal too.
  static readonly [EntryGroup.key] = true

  public filename: string
  private type?: string
  private readonly: boolean
  private content?: string
  private data?: EntryOptions[]
  private writeTask?: NodeJS.Timeout | undefined
  private pendingWrite?: EntryOptions[]
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
    const ext = extname(this.filename)
    if (!supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = writable[ext]
    this.readonly = !this.type
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href

    ctx.on('internal/update', (config, next) => {
      if (config.path !== this.config.path) return next()
      this.config = config
      return this.root.update(this.applyPatches(this.data!, config.patches)).catch((error) => {
        this.ctx.logger.warn('config update at %C failed', this.filename)
        this.ctx.logger.warn(error)
      })
    })
  }

  private async checkAccess() {
    if (!this.type) return
    try {
      await access(this.filename, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  private async read(forced = false) {
    const content = await readFile(this.filename, 'utf8')
    if (!forced && this.content === content) return false
    let data: any
    if (this.type === 'application/yaml') {
      data = yaml.load(content, { schema: entryListSchema })
    } else if (this.type === 'application/json') {
      data = JSON.parse(content)
    } else {
      const module = await import(/* @vite-ignore */ this.filename)
      data = module.default || module
    }
    // An empty or truncated file (common mid-edit: editors and `sed -i` write
    // through temp states) parses to `undefined`, not an error; reject every
    // non-array shape here so callers see one "invalid file" signal. Content
    // and data commit only on success, so an edit that is later reverted to
    // the exact last good content correctly reads as "unchanged".
    if (!Array.isArray(data)) {
      throw new TypeError(`config file must be a top-level array of entries: ${this.filename}`)
    }
    this.content = content
    this.data = data
    await this.checkAccess()
    return true
  }

  private applyPatches(data: EntryOptions[], patches = this.config.patches): EntryOptions[] {
    return applyPatches(data, patches, (message, ...args) => {
      this.ctx.root.logger?.('loader').warn(message, ...args)
    })
  }

  async* [Service.init]() {
    try {
      await this.read()
    } catch (error) {
      // Only a missing file falls back to `initial` (or the not-found error):
      // an existing-but-invalid file must fail loud with its real parse error,
      // never be mislabelled as absent or silently overwritten.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      if (this.config.initial) {
        await this._writeFile(this.config.initial as any)
        await this.read(true)
      } else {
        throw new Error(`config file not found: ${this.filename}`)
      }
    }

    yield () => this.stop()
    await this.root.update(this.applyPatches(this.data!))
  }

  async stop() {
    try {
      await this.flushWrite()
    } finally {
      this.root.stop()
      await this.flushWrite()
    }
  }

  /**
   * Re-read the file and refresh child entries when content changed. An
   * unreadable or unparsable file logs a warning and keeps the last good
   * tree: a hot-reload of a live app must never take the process down.
   */
  async refresh() {
    try {
      if (!await this.read()) return
      await this.root.update(this.applyPatches(this.data!))
    } catch (error) {
      this.ctx.logger.warn('config reload at %C failed; keeping the running tree', this.filename)
      this.ctx.logger.warn(error)
    }
  }

  private async _writeFile(config: EntryOptions[]) {
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      this.content = yaml.dump(config, { schema })
    } else if (this.type === 'application/json') {
      this.content = JSON.stringify(config, null, 2)
    }
    await writeFile(this.filename + '.tmp', this.content!)
    for (let retry = 0; ; retry++) {
      try {
        await rename(this.filename + '.tmp', this.filename)
        return
      } catch (error) {
        if (!retryableWriteError(error) || retry >= WRITE_RETRY_LIMIT) throw error
        await delay((retry + 1) * WRITE_RETRY_DELAY_MS)
      }
    }
  }

  private writeFile(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.pendingWrite = config
    this.writeTask = setTimeout(() => {
      void this.flushWrite()
    }, 0)
  }

  private flushWrite(): Promise<void> {
    clearTimeout(this.writeTask)
    this.writeTask = undefined
    const config = this.pendingWrite
    this.pendingWrite = undefined
    if (config === undefined) return this.writeQueue
    const run = this.writeQueue.then(
      () => this._writeFile(config),
      () => this._writeFile(config),
    )
    this.writeQueue = run
    void run.catch((error) => {
      this.ctx.root.logger?.('loader').warn('failed to write config file %C', this.filename)
      this.ctx.root.logger?.('loader').warn(error)
    })
    return run
  }

  /** Forward tree mutations to the debounced writer until journal adoption. */
  commit(_change: EntryChange) {
    this.write()
  }

  /** Schedule a write of the current root entry data. */
  write() {
    this.context.emit('loader/config-update')
    return this.writeFile(this.root.data)
  }
}

export default Include
