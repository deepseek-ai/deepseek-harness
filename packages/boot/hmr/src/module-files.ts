/** Disk identities of loaded module files, used to find modules whose files changed after loading. */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Coarsest file timestamp resolution among supported filesystems (FAT stores modification times in 2-second units).
 * An unrecorded file modified within this interval before the last observation is treated as possibly changed.
 */
const TIMESTAMP_RESOLUTION_MS = 2000

interface FileIdentity {
  /** Inode, size and modification time. */
  key: string
  /** Modification time in epoch milliseconds. */
  modifiedAt: number
}

function identityOf(url: string): FileIdentity | undefined {
  let stats
  try {
    stats = statSync(fileURLToPath(url))
  } catch (_error) {
    // A removed or unreadable file no longer provides the loaded module.
    return undefined
  }
  return { key: `${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`, modifiedAt: stats.mtimeMs }
}

/**
 * Records the inode, size and modification time of loaded `file:` modules. A module is stale when its file
 * disappeared or its identity differs from the recorded one. Change time is not recorded: creating a hard link to a
 * file, as pnpm does when it imports from its store, changes it without changing content. A module first loaded after
 * the last observation has no record; it is stale when its file was modified at or after that observation, less the
 * timestamp resolution, so a reinstall between loading and the next comparison is detected at the cost of reloading a
 * module that was first loaded after such a write.
 */
export class ModuleFiles {
  /** Identity per recorded module; `undefined` marks a stale module, such as a pending one first loaded after the last observation. */
  private records = new Map<string, string | undefined>()
  private observedAt = Date.now()

  /**
   * The current time of the clock the operating system stamps local file writes with, read from a new marker file that is
   * removed again. The system clock and file timestamps can differ by a clock tick in either direction, so module files
   * are compared with this time; when no marker can be created, the system clock is used.
   * @returns Epoch milliseconds.
   */
  now(): number {
    let directory: string
    try {
      directory = mkdtempSync(join(tmpdir(), 'dsh-hmr-clock-'))
    } catch (_error) {
      // An unwritable temporary directory leaves the less precise system clock.
      return Date.now()
    }
    try {
      const marker = join(directory, 'now')
      writeFileSync(marker, '')
      return statSync(marker).mtimeMs
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  /**
   * Compare loaded file modules with disk.
   * @param urls `file:` URLs of the loaded modules to compare.
   * @returns URLs of stale modules, and the identity read for each compared URL (`undefined` for a missing file).
   */
  compare(urls: Iterable<string>): { stale: Set<string>; seen: Map<string, string | undefined> } {
    const stale = new Set<string>()
    const seen = new Map<string, string | undefined>()
    for (const url of urls) {
      const identity = identityOf(url)
      seen.set(url, identity?.key)
      if (identity === undefined) {
        stale.add(url)
        continue
      }
      if (this.records.has(url) ? this.records.get(url) !== identity.key
        : identity.modifiedAt >= this.observedAt - TIMESTAMP_RESOLUTION_MS) stale.add(url)
    }
    return { stale, seen }
  }

  /**
   * Replace every record with the identities of the given loaded modules.
   * @param urls `file:` URLs of the loaded modules to record.
   * @param options `seen` supplies identities read earlier for modules whose cache entry has not changed since, so a
   * later write stays detectable; other modules are read now, and stay stale when their file was modified after `at`.
   * `retained` modules keep their record, or are marked stale when they have none. `at` is the observation time from
   * {@link now} used for unrecorded modules.
   */
  observe(urls: Iterable<string>, options: {
    seen?: ReadonlyMap<string, string | undefined>
    retained?: ReadonlySet<string>
    at?: number
  } = {}): void {
    const { seen = new Map<string, string | undefined>(), retained = new Set<string>(), at = this.now() } = options
    const records = new Map<string, string | undefined>()
    for (const url of urls) {
      if (retained.has(url)) records.set(url, this.records.get(url))
      else if (seen.has(url)) records.set(url, seen.get(url))
      else {
        // A module first loaded since `at` may have been evaluated before a write that followed it. A write in the same
        // file clock tick as `at` counts as earlier, so files installed just before the comparison are not reloaded.
        const identity = identityOf(url)
        records.set(url, identity === undefined || identity.modifiedAt > at ? undefined : identity.key)
      }
    }
    this.records = records
    this.observedAt = at
  }

  /**
   * Record the current identity of modules just evaluated again, leaving every other record unchanged.
   * @param urls `file:` URLs of the re-evaluated modules.
   */
  refresh(urls: Iterable<string>): void {
    for (const url of urls) this.records.set(url, identityOf(url)?.key)
  }
}
