/**
 * Review threads of change requests kept in memory, so the changes view reads them from the code host again only
 * after the change request's head or update time changes, the kept threads reach their age limit, or a review write drops them.
 */

import { Buffer } from 'node:buffer'
import type { ChangeRequestKey, ForgeReviewData } from '@deepseek-ai/dsh-experimental-forge'

interface Entry {
  /** Head commit and update time the threads were read at. */
  readonly version: string
  readonly review: ForgeReviewData
  /** Epoch milliseconds of the read. */
  readonly readAt: number
  /** UTF-8 size of the threads as JSON. */
  readonly bytes: number
}

/**
 * One read of review threads per change request, bounded by age and by the total UTF-8 size of the kept reads as
 * JSON; the least recently read change request leaves first. A read that started before a drop of any change request
 * is not kept, so threads read before a write never replace the drop.
 */
export class ReviewCache {
  private readonly entries = new Map<ChangeRequestKey, Entry>()
  private bytes = 0
  /** Number of drops so far. */
  private drops = 0

  /**
   * @param maxBytes - most UTF-8 bytes kept together; a larger read is not kept.
   * @param maxAgeMs - age in milliseconds at which a kept read is no longer returned.
   */
  constructor(private readonly maxBytes: number, private readonly maxAgeMs: number) {}

  /**
   * Read the threads kept for a change request at a version while they are younger than the age limit, marking them
   * the most recently read.
   * @param key - the change request.
   * @param version - head commit and update time the reader needs.
   * @param now - current epoch milliseconds.
   * @returns the threads, or undefined when none are kept at that version or they reached the age limit.
   */
  get(key: ChangeRequestKey, version: string, now: number): ForgeReviewData | undefined {
    const entry = this.entries.get(key)
    if (entry?.version !== version || now - entry.readAt >= this.maxAgeMs) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.review
  }

  /**
   * Name the cache's state when a read starts, for {@link ReviewCache.set}.
   * @returns the token of the read.
   */
  token(): number {
    return this.drops
  }

  /**
   * Keep a read in place of the change request's earlier one, then drop the least recently read change requests
   * until the rest fit within `maxBytes`. A read whose token a drop outdated is not kept.
   * @param key - the change request.
   * @param version - head commit and update time the threads were read at.
   * @param review - the threads.
   * @param readAt - epoch milliseconds when the read started.
   * @param token - what {@link ReviewCache.token} returned when the read started.
   */
  set(key: ChangeRequestKey, version: string, review: ForgeReviewData, readAt: number, token: number): void {
    if (token !== this.drops) return
    this.forget(key)
    const bytes = Buffer.byteLength(JSON.stringify(review))
    if (bytes > this.maxBytes) return
    this.entries.set(key, { version, review, readAt, bytes })
    this.bytes += bytes
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      this.entries.delete(oldest)
      this.bytes -= entry.bytes
    }
  }

  /**
   * Forget the threads kept for a change request, and every read in flight, after a write changed them.
   * @param key - the change request.
   */
  drop(key: ChangeRequestKey): void {
    this.drops += 1
    this.forget(key)
  }

  private forget(key: ChangeRequestKey): void {
    const previous = this.entries.get(key)
    if (previous === undefined) return
    this.entries.delete(key)
    this.bytes -= previous.bytes
  }
}
