/** Private, bounded, Session-owned files for converted and recalculated Office outputs. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
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
}

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
 * expires, when newer files need the byte budget, when their owner is released, and when the store is disposed. Only
 * files this store saved are deleted, apart from a startup sweep of expired entries left by earlier processes.
 */
export class OutputStore {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0
  private disposed = false
  private readonly sweep: Promise<void>
  private saving: Promise<unknown> = Promise.resolve()

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
   * @throws {OfficeKitError} `output-too-large` when the file alone exceeds the byte budget, and `unavailable` after disposal.
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
    for (const entry of this.entries.values()) {
      if (this.bytes + data.byteLength <= this.options.maxBytes) break
      await this.remove(entry)
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
   * Delete every file saved for an owner.
   * @param owner - owner whose files are released.
   * @returns completion after deletion settles.
   */
  async release(owner: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter(entry => entry.owner === owner).map(entry => this.remove(entry)))
    await this.removeEmpty(join(this.options.root, ownerDirectory(owner)))
  }

  /**
   * Refuse further saves and delete every file this store saved.
   * @returns completion after deletion settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.sweep
    await this.saving
    const owners = new Set([...this.entries.values()].map(entry => entry.owner))
    await Promise.all([...owners].map(owner => this.release(owner)))
  }

  private async remove(entry: Entry): Promise<void> {
    this.entries.delete(entry.path)
    this.bytes -= entry.bytes
    clearTimeout(entry.timer)
    try { await rm(entry.directory, { recursive: true, force: true }) }
    catch (error) { this.warn(`office-kit: could not delete output ${entry.path}: ${String(error)}`) }
  }

  private async removeEmpty(directory: string): Promise<void> {
    try { await rmdir(directory) }
    catch (_notEmptyOrMissing) {
      // A directory that still holds another process's output, or no longer exists, is left as is.
    }
  }

  /** Delete output directories, including those of earlier processes, whose files are older than the retention. */
  private async sweepExpired(): Promise<void> {
    const cutoff = Date.now() - this.options.retentionMs
    const owners = await readdir(this.options.root).catch((_missingRoot: unknown) => [] as string[])
    for (const owner of owners) {
      const ownerPath = join(this.options.root, owner)
      const outputs = await readdir(ownerPath).catch((_notDirectory: unknown) => [] as string[])
      for (const output of outputs) {
        const directory = join(ownerPath, output)
        try {
          if ((await stat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true })
        } catch (error) { this.warn(`office-kit: could not sweep output ${directory}: ${String(error)}`) }
      }
      await this.removeEmpty(ownerPath)
    }
  }
}
