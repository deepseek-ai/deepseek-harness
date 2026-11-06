/**
 * Browser-persisted viewed marks of changed files. Each Session keeps one storage entry that maps a diff source,
 * such as a change request or a local scope with its base ref and chosen commits, to the digest of each file's
 * change when the reader marked it viewed. A mark whose digest differs from the file's current change reports the
 * file as changed since it was viewed.
 */

import { z } from 'zod'

/** Prefix of every storage key; the index of Sessions with marks uses it with the `sessions` suffix. */
const PREFIX = 'dsh.forge-viewed.v1'

/** Sessions whose marks the browser keeps; marking a file in another Session drops the least recently marked one's. */
const MAX_SESSIONS = 50

/** Diff sources whose marks one Session keeps; marking a file in another source drops the least recently marked one's. */
const MAX_SOURCES = 20

const source = z.object({ at: z.number(), files: z.record(z.string(), z.string()) })
const saved = z.record(z.string(), source)
const index = z.array(z.string())

/** Viewed state of one file in the diff a reader sees. */
export type ViewedState = 'viewed' | 'changed' | 'unviewed'

/** Digests of the files marked viewed in one source, by path; stable until a mark in that source changes. */
export type ViewedMarks = ReadonlyMap<string, string>

const NO_MARKS: ViewedMarks = new Map()

/**
 * Classify a file by its mark.
 * @param marks - the marks of the source the diff shows.
 * @param path - the file's path.
 * @param digest - the digest of the file's current change.
 * @returns `viewed` for a mark of this change, `changed` for a mark of an earlier change, else `unviewed`.
 */
export function viewedStateOf(marks: ViewedMarks, path: string, digest: string): ViewedState {
  const marked = marks.get(path)
  return marked === undefined ? 'unviewed' : marked === digest ? 'viewed' : 'changed'
}

/** One Session's viewed marks; unreadable storage leaves the marks empty and refuses later writes. */
export class ViewedFiles {
  private sources: Record<string, z.infer<typeof source>> = {}
  private readonly listeners = new Set<() => void>()
  private readonly snapshots = new Map<string, ViewedMarks>()
  private readonly key: string
  private readonly readable: boolean

  /**
   * @param session - storage identity of the Session, such as its id.
   * @param now - clock of the least-recently-marked bounds.
   */
  constructor(private readonly session: string, private readonly now: () => number = Date.now) {
    this.key = `${PREFIX}.${JSON.stringify(session)}`
    let readable = true
    try {
      const raw = localStorage.getItem(this.key)
      if (raw !== null) this.sources = saved.parse(JSON.parse(raw))
    } catch (_error) {
      readable = false
    }
    this.readable = readable
  }

  /**
   * Read the marks of one source.
   * @param key - identity of the diff source.
   * @returns digests by path, the same object until a mark in the source changes.
   */
  readonly marksOf = (key: string): ViewedMarks => {
    let marks = this.snapshots.get(key)
    if (marks === undefined) {
      const files = this.sources[key]?.files
      marks = files === undefined ? NO_MARKS : new Map(Object.entries(files))
      this.snapshots.set(key, marks)
    }
    return marks
  }

  /**
   * Observe changed marks.
   * @param listener - called after each saved mark.
   * @returns unsubscribe.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Mark one file viewed at its current change or clear its mark, dropping the marks of paths the diff no longer has.
   * @param key - identity of the diff source.
   * @param files - every file of the diff with the digest of its change.
   * @param path - the file to mark.
   * @param viewed - whether the file is viewed.
   * @returns whether the mark was saved; the marks are unchanged when storage is unreadable or refuses the write.
   */
  mark(key: string, files: readonly { readonly path: string; readonly digest: string }[], path: string, viewed: boolean): boolean {
    const file = files.find(item => item.path === path)
    if (!this.readable || file === undefined) return false
    const present = new Set(files.map(item => item.path))
    const kept = Object.entries(this.sources[key]?.files ?? {}).filter(([marked]) => marked !== path && present.has(marked))
    const sources = {
      ...this.sources,
      [key]: { at: this.now(), files: Object.fromEntries(viewed ? [...kept, [path, file.digest]] : kept) },
    }
    const recent = Object.entries(sources).sort(([, left], [, right]) => right.at - left.at).slice(0, MAX_SOURCES)
    const next = Object.fromEntries(recent)
    try {
      localStorage.setItem(this.key, JSON.stringify(next))
    } catch (_error) {
      return false
    }
    this.sources = next
    this.snapshots.clear()
    this.remember()
    for (const listener of this.listeners) listener()
    return true
  }

  /** Move this Session to the front of the index and drop the marks of Sessions beyond {@link MAX_SESSIONS}. */
  private remember(): void {
    const key = `${PREFIX}.sessions`
    let listed: readonly string[] = []
    try {
      listed = index.parse(JSON.parse(localStorage.getItem(key) ?? '[]'))
    } catch (_error) {
      // An unreadable index is replaced by one that lists only this Session.
    }
    const sessions = [this.session, ...listed.filter(item => item !== this.session)]
    try {
      writeIndex(key, sessions)
    } catch (_error) {
      // The index only bounds storage; a Session left out keeps its marks until a later write lists it.
    }
  }
}

/** Keep the first {@link MAX_SESSIONS} Sessions in the index and remove the marks of the rest. */
function writeIndex(key: string, sessions: readonly string[]): void {
  for (const dropped of sessions.slice(MAX_SESSIONS)) localStorage.removeItem(`${PREFIX}.${JSON.stringify(dropped)}`)
  localStorage.setItem(key, JSON.stringify(sessions.slice(0, MAX_SESSIONS)))
}
