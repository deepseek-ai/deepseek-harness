/** Private, bounded, Session-owned files for converted and recalculated Office outputs. */
import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { OfficeKitError } from './errors.ts'

/** Limits and location of the output store. */
export interface OutputStoreOptions {
  /** Absolute directory owned by the store; created on first save with owner-only permissions. */
  readonly root: string
  /** Milliseconds a saved file is kept before deletion. */
  readonly retentionMs: number
  /** Inclusive bytes across retained files; older files are deleted first to make room. */
  readonly maxBytes: number
}

interface Entry {
  readonly path: string
  readonly directory: string
  readonly owner: string
  readonly bytes: number
  readonly timer: ReturnType<typeof setTimeout>
  /** Deletion in progress; absent while the file is retained, including after a failed deletion awaiting retry. */
  removal?: Promise<boolean>
}

/** Names {@link ownerDirectory} generates. */
const OWNER_DIRECTORY = /^session-[0-9a-f]{24}$/u
/** Names of per-output directories, which `randomUUID()` generates. */
const OUTPUT_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Directory name for one owner, independent of characters the owner id may contain. */
function ownerDirectory(owner: string): string {
  return `session-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}`
}

/** Create an output's private directory and write its file, removing the directory when either step fails. */
async function writeOutput(directory: string, path: string, data: Uint8Array): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Keeps each saved output in its own private directory under a per-owner directory. Files leave when their retention
 * expires, when newer files need the byte budget, when their owner is released, and when the store is disposed. A file
 * counts toward the byte budget until its deletion succeeds; a failed deletion is reported and retried by later
 * eviction, release, and disposal. Only files this store saved are deleted, apart from a startup sweep of expired
 * leftovers of earlier processes. The sweep considers only real directories, never links or junctions, whose names this
 * store generates: `session-` and 24 lowercase hexadecimal digits under the root, and a lowercase UUID v4 below that.
 */
export class OutputStore {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0
  private disposed = false
  private readonly sweep: Promise<void>
  private saving: Promise<unknown> = Promise.resolve()
  /** Deletions and releases in progress, awaited by disposal. */
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * @param options - root directory, retention, and byte budget.
   * @param warn - receives contained cleanup failures.
   */
  constructor(private readonly options: OutputStoreOptions, private readonly warn: (message: string) => void) {
    this.sweep = this.sweepExpired()
  }

  /**
   * Save one output for an owner.
   * @param owner - opaque owner identity, such as a Session id.
   * @param name - file name shown to the consumer; only its final path component is used.
   * @param data - complete output bytes.
   * @returns the absolute path of the saved file.
   * @throws {OfficeKitError} `output-too-large` when the file alone exceeds the byte budget, and `unavailable` after
   * disposal or when retained files whose deletion failed leave too little of the budget.
   */
  save(owner: string, name: string, data: Uint8Array): Promise<string> {
    const saved = this.saving.then(() => this.saveNow(owner, name, data))
    this.saving = saved.catch((_failedSave: unknown) => undefined)
    return saved
  }

  /** Saves run one at a time so the byte budget covers every retained file. */
  private async saveNow(owner: string, name: string, data: Uint8Array): Promise<string> {
    await this.sweep
    if (this.disposed) throw new OfficeKitError('unavailable', 'The document converter is unavailable.')
    if (data.byteLength > this.options.maxBytes) {
      throw new OfficeKitError('output-too-large', `The output exceeds the ${this.options.maxBytes}-byte output store limit.`)
    }
    for (const entry of [...this.entries.values()]) {
      if (this.bytes + data.byteLength <= this.options.maxBytes) break
      await this.remove(entry)
    }
    if (this.bytes + data.byteLength > this.options.maxBytes) {
      throw new OfficeKitError('unavailable', 'Earlier outputs could not be deleted to make room for this output.')
    }
    const directory = join(this.options.root, ownerDirectory(owner), randomUUID())
    const path = join(directory, basename(name))
    await writeOutput(directory, path, data).catch((error: unknown) => {
      if (!isMissingPath(error)) throw error
      // A concurrent release, or another process's sweep, removed the empty owner directory before the write.
      return writeOutput(directory, path, data)
    })
    const timer = setTimeout(() => { void this.remove(entry) }, this.options.retentionMs)
    timer.unref()
    const entry: Entry = { path, directory, owner, bytes: data.byteLength, timer }
    this.entries.set(path, entry)
    this.bytes += data.byteLength
    return path
  }

  /**
   * Delete every file saved for an owner. Disposal waits for a release in progress.
   * @param owner - owner whose files are released.
   * @returns completion after deletion settles; failed deletions are reported and retained for retry.
   */
  release(owner: string): Promise<void> {
    return this.track(this.releaseNow(owner))
  }

  private async releaseNow(owner: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter(entry => entry.owner === owner).map(entry => this.remove(entry)))
    await this.removeEmpty(join(this.options.root, ownerDirectory(owner)))
  }

  /**
   * Refuse further saves, wait for deletions and releases in progress, and delete every file this store saved,
   * retrying earlier failed deletions once more.
   * @returns completion after deletion settles; files that still cannot be deleted are reported.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.sweep
    await this.saving
    await this.settle()
    const owners = new Set([...this.entries.values()].map(entry => entry.owner))
    await Promise.all([...owners].map(owner => this.release(owner)))
    await this.settle()
  }

  /** Wait until no deletion or release is in progress, including ones started while waiting. */
  private async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending)
  }

  /** Record a non-rejecting deletion or release as in progress until it settles. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    const settled = (): void => { this.pending.delete(operation) }
    operation.then(settled, settled)
    return operation
  }

  /**
   * Delete one saved file, sharing a deletion already in progress. The entry and its bytes leave the store only after
   * the deletion succeeds; a failure is reported and leaves the entry for a later retry.
   * @returns whether the file is gone.
   */
  private remove(entry: Entry): Promise<boolean> {
    if (entry.removal !== undefined) return entry.removal
    if (this.entries.get(entry.path) !== entry) return Promise.resolve(true)
    clearTimeout(entry.timer)
    const removal = this.track(rm(entry.directory, { recursive: true, force: true }).then(() => {
      this.entries.delete(entry.path)
      this.bytes -= entry.bytes
      return true
    }, (error: unknown) => {
      this.warn(`office-kit: could not delete output ${entry.path}: ${String(error)}`)
      return false
    }).finally(() => { delete entry.removal }))
    entry.removal = removal
    return removal
  }

  private async removeEmpty(directory: string): Promise<void> {
    try { await rmdir(directory) }
    catch (_notEmptyOrMissing) {
      // A directory that still holds another process's output, or no longer exists, is left as is.
    }
  }

  /**
   * Delete output directories, including those of earlier processes, whose files are older than the retention. Only
   * real directories with store-generated names are considered; links, junctions, and other entries stay untouched.
   */
  private async sweepExpired(): Promise<void> {
    const cutoff = Date.now() - this.options.retentionMs
    for (const owner of await generatedDirectories(this.options.root, OWNER_DIRECTORY)) {
      for (const directory of await generatedDirectories(owner, OUTPUT_DIRECTORY)) {
        try {
          if ((await lstat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true })
        } catch (error) { this.warn(`office-kit: could not sweep output ${directory}: ${String(error)}`) }
      }
      await this.removeEmpty(owner)
    }
  }
}

/**
 * List the real subdirectories of `directory` whose names match `name`.
 * @param directory - directory to list; a missing or unreadable directory has none.
 * @param name - names the store generates at this level.
 * @returns absolute paths, excluding links, junctions, and non-directories.
 */
async function generatedDirectories(directory: string, name: RegExp): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((_missingDirectory: unknown) => [] as Dirent[])
  return entries.filter(entry => entry.isDirectory() && name.test(entry.name)).map(entry => join(directory, entry.name))
}
