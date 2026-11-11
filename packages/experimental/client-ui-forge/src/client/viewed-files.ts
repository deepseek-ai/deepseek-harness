/**
 * Browser-persisted viewed marks of changed files. Each Session keeps one storage entry that maps a diff source,
 * such as a change request or a local scope with its base ref and chosen commits, to the digest of each file's
 * change when the reader marked it viewed. A mark whose digest differs from the file's current change reports the
 * file as changed since it was viewed. Several browser tabs of one Session share the entry: each mark rewrites the
 * entry as storage holds it, and marks saved by another tab reach this one through the `storage` event.
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

type Sources = Readonly<Record<string, z.infer<typeof source>>>

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

/**
 * One Session's viewed marks. Unreadable storage shows no marks and refuses writes while it stays unreadable. While
 * anything subscribes, marks another tab saves replace the ones shown.
 */
export class ViewedFiles {
  private sources: Sources
  private readonly listeners = new Set<() => void>()
  private readonly snapshots = new Map<string, ViewedMarks>()
  private readonly key: string

  /**
   * @param session - storage identity of the Session, such as its id.
   * @param now - clock of the least-recently-marked bounds.
   */
  constructor(private readonly session: string, private readonly now: () => number = Date.now) {
    this.key = `${PREFIX}.${JSON.stringify(session)}`
    this.sources = this.load() ?? {}
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
    // Storage events that arrived while nothing listened are lost, so the first subscriber reads storage again.
    if (this.listeners.size === 0) {
      window.addEventListener('storage', this.stored)
      this.reload()
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) window.removeEventListener('storage', this.stored)
    }
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
    // Another tab of the Session may have saved marks since this one last read them; the write keeps theirs.
    const current = this.load()
    if (current === undefined || file === undefined) return false
    const present = new Set(files.map(item => item.path))
    const kept = Object.entries(current[key]?.files ?? {}).filter(([marked]) => marked !== path && present.has(marked))
    const sources = {
      ...current,
      [key]: { at: this.now(), files: Object.fromEntries(viewed ? [...kept, [path, file.digest]] : kept) },
    }
    const recent = Object.entries(sources).sort(([, left], [, right]) => right.at - left.at).slice(0, MAX_SOURCES)
    const next = Object.fromEntries(recent)
    try {
      localStorage.setItem(this.key, JSON.stringify(next))
    } catch (_error) {
      return false
    }
    this.replace(next)
    this.remember()
    return true
  }

  /** The saved marks of this Session, or undefined when storage cannot be read or holds an entry it cannot parse. */
  private load(): Sources | undefined {
    try {
      const raw = localStorage.getItem(this.key)
      return raw === null ? {} : saved.parse(JSON.parse(raw))
    } catch (_error) {
      return undefined
    }
  }

  /** Show the saved marks when they differ from the shown ones. */
  private reload(): void {
    const sources = this.load() ?? {}
    if (JSON.stringify(sources) !== JSON.stringify(this.sources)) this.replace(sources)
  }

  private replace(sources: Sources): void {
    this.sources = sources
    this.snapshots.clear()
    for (const listener of this.listeners) listener()
  }

  /** Another document changed this Session's entry, or with a null key cleared the whole storage. */
  private readonly stored = (event: StorageEvent): void => {
    if (event.key === this.key || event.key === null) this.reload()
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
