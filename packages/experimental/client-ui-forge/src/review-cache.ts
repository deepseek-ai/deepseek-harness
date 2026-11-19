/**
 * Review reads of change requests kept in memory: the review threads and the viewed marks. The changes view reads
 * them from the code host again only after the version they were read at changes, the kept read reaches its age
 * limit, or a write drops it.
 */

import { Buffer } from 'node:buffer'
import type { ChangeRequestKey } from '@deepseek-ai/dsh-experimental-forge'

interface Entry<T> {
  /** What the read was made at: the head commit and update time of review threads, the head commit of viewed marks. */
  readonly version: string
  readonly read: T
  /** Epoch milliseconds of the read. */
  readonly readAt: number
  /** UTF-8 size of the read as JSON. */
  readonly bytes: number
}

/**
 * One read of one kind per change request, bounded by age and by the total UTF-8 size of the kept reads as JSON; the
 * least recently read change request leaves first. A read that started before a drop or an amendment of any change
 * request is not kept, so a read made before a write never replaces what the write left.
 */
export class ReviewCache<T> {
  private readonly entries = new Map<ChangeRequestKey, Entry<T>>()
  private bytes = 0
  /** Number of drops and amendments so far. */
  private writes = 0

  /**
   * @param maxBytes - most UTF-8 bytes kept together; a larger read is not kept.
   * @param maxAgeMs - age in milliseconds at which a kept read is no longer returned.
   */
  constructor(private readonly maxBytes: number, private readonly maxAgeMs: number) {}

  /**
   * Read what is kept for a change request at a version while it is younger than the age limit, marking it the most
   * recently read.
   * @param key - the change request.
   * @param version - the version the reader needs.
   * @param now - current epoch milliseconds.
   * @returns the kept read, or undefined when none is kept at that version or it reached the age limit.
   */
  get(key: ChangeRequestKey, version: string, now: number): T | undefined {
    const entry = this.entries.get(key)
    if (entry?.version !== version || now - entry.readAt >= this.maxAgeMs) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.read
  }

  /**
   * Name the cache's state when a read starts, for {@link ReviewCache.set}.
   * @returns the token of the read.
   */
  token(): number {
    return this.writes
  }

  /**
   * Keep a read in place of the change request's earlier one, then drop the least recently read change requests
   * until the rest fit within `maxBytes`. A read whose token a drop or an amendment outdated is not kept.
   * @param key - the change request.
   * @param version - the version the read was made at.
   * @param read - what was read.
   * @param readAt - epoch milliseconds when the read started.
   * @param token - what {@link ReviewCache.token} returned when the read started.
   */
  set(key: ChangeRequestKey, version: string, read: T, readAt: number, token: number): void {
    if (token !== this.writes) return
    this.keep(key, version, read, readAt)
  }

  /**
   * Forget the read kept for a change request, and every read in flight, after a write changed it.
   * @param key - the change request.
   */
  drop(key: ChangeRequestKey): void {
    this.writes += 1
    this.forget(key)
  }

  /**
   * Apply a write whose effect on the read is known: a read kept at `version` becomes `change(read)` and keeps its
   * age, and one kept at another version is forgotten. Reads in flight are not kept, as after a drop.
   * @param key - the change request.
   * @param version - the version the write was made at.
   * @param change - what the kept read is after the write.
   */
  amend(key: ChangeRequestKey, version: string, change: (read: T) => T): void {
    this.writes += 1
    const entry = this.entries.get(key)
    if (entry === undefined) return
    if (entry.version === version) this.keep(key, version, change(entry.read), entry.readAt)
    else this.forget(key)
  }

  private keep(key: ChangeRequestKey, version: string, read: T, readAt: number): void {
    this.forget(key)
    const bytes = Buffer.byteLength(JSON.stringify(read))
    if (bytes > this.maxBytes) return
    this.entries.set(key, { version, read, readAt, bytes })
    this.bytes += bytes
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      this.entries.delete(oldest)
      this.bytes -= entry.bytes
    }
  }

  private forget(key: ChangeRequestKey): void {
    const previous = this.entries.get(key)
    if (previous === undefined) return
    this.entries.delete(key)
    this.bytes -= previous.bytes
  }
}
