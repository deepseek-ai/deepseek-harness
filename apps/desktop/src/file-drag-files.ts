/** Application-owned temporary exports and authorized borrowed files for native dragging. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDragFileName, type DragFileName, type FileDragHandle } from '@deepseek-ai/dsh-util-file-drag'

// Aggregate temporary bytes, including incomplete writes and failed removals.
const MAX_TOTAL_DRAG_FILE_BYTES = 64 * 1024 * 1024
// Native receivers may open the path after startDrag returns.
const DELIVERED_FILE_RETENTION_MS = 60_000

interface DragFile {
  readonly directory?: string
  readonly path: string
  readonly bytes: number
  ready: boolean
  used: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** Borrowed files are never deleted; temporary exports retain cleanup ownership until removal succeeds. */
export class DragFiles {
  private readonly files = new Map<FileDragHandle, DragFile>()
  private readonly pending = new Set<Promise<FileDragHandle>>()
  private readonly releasing = new Map<FileDragHandle, Promise<void>>()
  private stagedBytes = 0
  private disposed = false

  /** @param temporaryDirectory - OS directory for private temporary exports. */
  constructor(private readonly temporaryDirectory: string) {}

  /** @param bytes - complete file bytes. @param naming - desired export name. @returns an opaque preparation handle. */
  prepare(bytes: Uint8Array, naming: DragFileName): Promise<FileDragHandle> {
    if (this.disposed || bytes.byteLength > MAX_TOTAL_DRAG_FILE_BYTES - this.stagedBytes) {
      return Promise.reject(new Error('File drag temporary storage unavailable'))
    }
    this.stagedBytes += bytes.byteLength
    const operation = this.write(bytes, resolveDragFileName(naming))
    this.pending.add(operation)
    void operation.then(() => { this.pending.delete(operation) }, () => { this.pending.delete(operation) })
    return operation
  }

  private async write(bytes: Uint8Array, name: string): Promise<FileDragHandle> {
    let directory: string
    try { directory = await mkdtemp(join(this.temporaryDirectory, 'dsh-file-drag-')) }
    catch (error) { this.stagedBytes -= bytes.byteLength; throw error }
    const handle = randomUUID() as FileDragHandle
    const file: DragFile = { directory, path: join(directory, name), bytes: bytes.byteLength, used: false, ready: false }
    this.files.set(handle, file)
    try {
      await writeFile(file.path, bytes, { flag: 'wx', mode: 0o600 })
      if (this.disposed) throw new Error('File transfer closed')
      file.ready = true
      return handle
    } catch (error) {
      await this.remove(handle, file)
      throw error
    }
  }

  /**
   * Register an authorized source without owning its content.
   * @param path - verified local source.
   * @returns borrowed handle.
   */
  borrow(path: string): FileDragHandle {
    if (this.disposed) throw new Error('File transfer closed')
    const handle = randomUUID() as FileDragHandle
    this.files.set(handle, { path, bytes: 0, used: false, ready: true })
    return handle
  }

  /** @param handle - preparation identity. @param retain - whether the OS accepted this file. @returns path only while ready and owned. */
  take(handle: unknown, retain = true): string | undefined {
    if (typeof handle !== 'string') return undefined
    const key = handle as FileDragHandle
    const file = this.files.get(key)
    if (file === undefined || !file.ready || this.disposed || this.releasing.has(key)) return undefined
    if (retain && !file.used) {
      file.used = true
      file.timer = setTimeout(() => {
        void this.remove(key, file).catch((error: unknown) => { console.error(error) })
      }, DELIVERED_FILE_RETENTION_MS)
      file.timer.unref()
    }
    return file.path
  }

  /** Release unused preparations immediately; used exports have a bounded read grace period. @param handle - preparation identity. */
  async release(handle: unknown): Promise<void> {
    if (typeof handle !== 'string') return
    const key = handle as FileDragHandle
    const file = this.files.get(key)
    if (file === undefined || file.used) return
    await this.remove(key, file)
  }

  private remove(handle: FileDragHandle, file: DragFile): Promise<void> {
    const existing = this.releasing.get(handle)
    if (existing !== undefined) return existing
    clearTimeout(file.timer)
    file.ready = false
    const operation = (file.directory === undefined ? Promise.resolve() : rm(file.directory, { recursive: true, force: true })).then(() => {
      this.files.delete(handle)
      this.stagedBytes -= file.bytes
    }).finally(() => { this.releasing.delete(handle) })
    this.releasing.set(handle, operation)
    return operation
  }

  /** Stop preparation, await every write/release, and retry all tracked removals before reporting failure. */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled(this.pending)
    await Promise.allSettled(this.releasing.values())
    const results = await Promise.allSettled([...this.files].map(([handle, file]) => this.remove(handle, file)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
