/** Single-shell, bounded persistence for already-projected operation diagnostics. */
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Budgets include serialized JSON and its line delimiter. */
export interface OperationJournalLimits {
  readonly segmentBytes: number
  readonly recordBytes: number
  readonly queuedBytes: number
}

/** In-memory omissions for the current shell lifetime; missing records never imply no operations occurred. */
export interface OperationJournalStatus {
  readonly dropped: number
  readonly failed: number
  readonly queuedBytes: number
  readonly disabled: boolean
  /** Damaged or oversized segments repaired; their lost record count is unknown. */
  readonly repairedSegments: number
}

/** Owns two known files and one serial writer; the owning shell must exclude other writers. */
export class OperationJournal {
  private readonly queue: string[] = []
  private queuedBytes = 0
  private dropped = 0
  private failed = 0
  private repairedSegments = 0
  private disabled = false
  private closed = false
  private writing: Promise<void> | undefined
  private initialized = false
  private readonly abort = new AbortController()

  /**
   * @param directory - Directory reserved for the shell's operation journal.
   * @param limits - Positive byte budgets, with recordBytes no greater than either other budget.
   */
  constructor(
    private readonly directory: string,
    private readonly limits: OperationJournalLimits,
  ) {
    if (![limits.segmentBytes, limits.recordBytes, limits.queuedBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || limits.recordBytes > limits.segmentBytes || limits.recordBytes > limits.queuedBytes) {
      throw new RangeError('Invalid operation journal budgets')
    }
  }

  /**
   * Queue one prevalidated, whitelisted JSON record without awaiting disk I/O.
   * @param record - An already serialized JSON object without literal line delimiters.
   * @returns Whether the record was accepted; disk failures are reported separately by status().
   */
  enqueue(record: string): boolean {
    const line = record + '\n'
    const bytes = Buffer.byteLength(line)
    if (this.closed || this.disabled || bytes > this.limits.recordBytes
      || bytes + this.queuedBytes > this.limits.queuedBytes || /[\r\n]/u.test(record)) {
      this.dropped++
      return false
    }
    this.queue.push(line)
    this.queuedBytes += bytes
    this.startWriter()
    return true
  }

  /** @returns Current queue occupancy and omission counters. */
  status(): OperationJournalStatus {
    return {
      dropped: this.dropped,
      failed: this.failed,
      queuedBytes: this.queuedBytes,
      disabled: this.disabled,
      repairedSegments: this.repairedSegments,
    }
  }

  /** Stop accepting records and await completion of the owned writer. */
  async close(): Promise<void> {
    this.closed = true
    while (this.writing !== undefined) await this.writing
  }

  /**
   * Wait for queued records during shutdown or installer handoff without holding the application indefinitely.
   * @param timeoutMs - Waiting budget before disabling the writer and cancelling subsequent I/O.
   * @returns True after the queue settles successfully; false immediately when disabled, or on failure or deadline.
   * False does not confirm that an issued OS request has settled.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid journal drain deadline')
    if (this.disabled) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          while (this.writing !== undefined) await this.writing
          return !this.disabled
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            this.disabled = true
            this.abort.abort()
            resolve(false)
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private startWriter(): void {
    this.writing ??= this.writeQueue().finally(() => {
      this.writing = undefined
      if (this.queue.length > 0) this.startWriter()
    })
  }

  private async writeQueue(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.abort.signal.throwIfAborted()
      const current = join(this.directory, 'operations.jsonl')
      const previous = join(this.directory, 'operations.previous.jsonl')
      if (!this.initialized) {
        await this.prepareSegments(current, previous)
        this.initialized = true
      }
      for (let line = this.queue[0]; line !== undefined; line = this.queue[0]) {
        this.abort.signal.throwIfAborted()
        const bytes = Buffer.byteLength(line)
        let size = 0
        try {
          size = (await stat(current)).size
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        this.abort.signal.throwIfAborted()
        if (size > this.limits.segmentBytes) {
          // An oversized pre-existing segment is not copied into the bounded retained history.
          await writeFile(current, '', { mode: 0o600 })
          this.repairedSegments++
        } else if (size + bytes > this.limits.segmentBytes) {
          await rename(current, previous)
        }
        this.abort.signal.throwIfAborted()
        await writeFile(current, line, { flag: 'a', mode: 0o600, signal: this.abort.signal })
        this.queue.shift()
        this.queuedBytes -= bytes
      }
    } catch (_error) {
      // A failed append may have written a partial line; disable this writer rather than concatenate another record.
      this.disabled = true
      this.failed += this.queue.length
      this.queue.length = 0
      this.queuedBytes = 0
    }
  }

  private async prepareSegments(current: string, previous: string): Promise<void> {
    try {
      const size = (await stat(previous)).size
      this.abort.signal.throwIfAborted()
      if (size > this.limits.segmentBytes) {
        await writeFile(previous, '', { mode: 0o600 })
        this.repairedSegments++
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.abort.signal.throwIfAborted()
    {
      await using handle = await open(current, 'r+').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.abort.signal.throwIfAborted()
        return open(current, 'wx+', 0o600)
      })
      this.abort.signal.throwIfAborted()
      const size = (await handle.stat()).size
      this.abort.signal.throwIfAborted()
      if (size > this.limits.segmentBytes) {
        await handle.truncate(0)
        this.repairedSegments++
      } else if (size > 0) {
        const byte = Buffer.alloc(1)
        const read = await handle.read(byte, 0, 1, size - 1)
        if (read.bytesRead !== 1 || byte[0] !== 10) {
          const buffer = Buffer.alloc(size)
          let offset = 0
          while (offset < size) {
            this.abort.signal.throwIfAborted()
            const chunk = await handle.read(buffer, offset, size - offset, offset)
            if (chunk.bytesRead === 0) break
            offset += chunk.bytesRead
          }
          this.abort.signal.throwIfAborted()
          // Keep committed lines in both segments; only the unfinished append is discarded.
          await handle.truncate(buffer.subarray(0, offset).lastIndexOf(10) + 1)
          this.repairedSegments++
        }
      }
    }
    this.abort.signal.throwIfAborted()
  }
}
