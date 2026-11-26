/** Watch a changing set of directories for entries being added, removed, renamed or modified. */
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** One directory's watcher. */
interface Watched {
  readonly watcher: FSWatcher
  /** The watcher may have stopped reporting; the next update replaces it. */
  stale: boolean
}

/**
 * Non-recursive watchers over a set of directories. Each watcher is keyed by its directory's path and file identity,
 * including the birth time where the file system records one, so a retargeted symbolic link or a directory recreated
 * with a new identity is watched again. A watcher becomes stale when it reports an event naming its own directory or
 * no entry, as Linux does when the watched directory is removed and the watch ends, or when it fails. The next update
 * replaces a stale watcher even when the identity is unchanged, as with an inode number reused by a recreated
 * directory. Watchers do not keep the process alive.
 */
export class DirectoryWatch {
  private readonly watchers = new Map<string, Watched>()

  /**
   * @param changed - called for every change reported in a watched directory, and after a watcher fails.
   * @param failed - receives a directory that cannot be watched, or whose watcher failed, with the error.
   */
  constructor(
    private readonly changed: () => void,
    private readonly failed: (directory: string, error: unknown) => void,
  ) {}

  /**
   * Watch exactly `directories`, keeping the watchers of unchanged directories that are not stale. A directory that
   * cannot be inspected or watched is reported through `failed` and stays unwatched until the next update.
   * @param directories - directories to watch.
   * @returns whether a watcher was added, replaced or removed.
   */
  async update(directories: ReadonlySet<string>): Promise<boolean> {
    const wanted = new Map<string, string>()
    for (const directory of directories) {
      try {
        const { dev, ino, birthtimeMs } = await stat(directory)
        wanted.set(`${dev}:${ino}:${birthtimeMs}:${directory}`, directory)
      } catch (error) {
        this.failed(directory, error)
      }
    }
    let updated = false
    for (const [key, { watcher, stale }] of this.watchers) {
      if (wanted.has(key) && !stale) continue
      this.watchers.delete(key)
      watcher.close()
      updated = true
    }
    for (const [key, directory] of wanted) {
      if (this.watchers.has(key)) continue
      try {
        const name = basename(directory)
        const watched: Watched = {
          stale: false,
          watcher: watch(directory, { persistent: false }, (_event, filename) => {
            if (filename === null || filename === name) watched.stale = true
            this.changed()
          }),
        }
        // Node closes a watcher that reports an error.
        watched.watcher.on('error', (error) => {
          watched.stale = true
          this.failed(directory, error)
          this.changed()
        })
        this.watchers.set(key, watched)
        updated = true
      } catch (error) {
        this.failed(directory, error)
      }
    }
    return updated
  }

  /** Stop every watcher. */
  close(): void {
    for (const { watcher } of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
