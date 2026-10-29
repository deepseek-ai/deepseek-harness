/**
 * Change request patches kept in memory, so the changes view reads no diff
 * from the code host again while a change request keeps its head commit and base branch.
 */

import { Buffer } from 'node:buffer'
import type { ChangeRequestKey } from '@deepseek-ai/dsh-experimental-forge'

interface Entry {
  /** Head commit and base branch the patch was read at. */
  readonly version: string
  readonly patch: string
  /** UTF-8 size of `patch`. */
  readonly bytes: number
}

/**
 * One patch per change request, bounded by the total UTF-8 size of the kept
 * patches; the least recently read patch leaves first.
 */
export class PatchCache {
  private readonly entries = new Map<ChangeRequestKey, Entry>()
  private bytes = 0

  /** @param maxBytes - most UTF-8 bytes kept together; a larger patch is not kept. */
  constructor(private readonly maxBytes: number) {}

  /**
   * Read the patch kept for a change request at a version, marking it the most recently read.
   * @param key - the change request.
   * @param version - head commit and base branch the reader needs.
   * @returns the patch, or undefined when none is kept at that version.
   */
  get(key: ChangeRequestKey, version: string): string | undefined {
    const entry = this.entries.get(key)
    if (entry?.version !== version) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.patch
  }

  /**
   * Keep a patch in place of the change request's earlier one, then drop the
   * least recently read patches until the rest fit within `maxBytes`.
   * @param key - the change request.
   * @param version - head commit and base branch the patch was read at.
   * @param patch - the patch.
   */
  set(key: ChangeRequestKey, version: string, patch: string): void {
    this.remove(key)
    const bytes = Buffer.byteLength(patch)
    if (bytes > this.maxBytes) return
    this.entries.set(key, { version, patch, bytes })
    this.bytes += bytes
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break
      this.remove(oldest)
    }
  }

  private remove(key: ChangeRequestKey): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.bytes -= entry.bytes
  }
}
