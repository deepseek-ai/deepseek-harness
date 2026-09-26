/**
 * Durable recovery for a restored task tab.
 *
 * The Sidebar persists a tab's layout record — its own id, kind, contentId, and
 * title — but not the opener's navigation parameters, so a task tab restored by
 * a reload carries no task identity and its body can only report feedback. This
 * page type therefore keeps what it last showed, keyed by the Session and the
 * layout record's id: the persisted layout restores both, and its minted counter
 * never reuses an id for as long as that layout lives, so the association
 * outlives the reload that dropped the parameters. The contentId cannot serve as
 * this key because every tab of one page kind records the same one.
 *
 * One storage key per Session holds one entry per tab id. A write keeps only
 * entries whose tab a non-empty list of committed ids contains; a read reports a
 * target only when the entry's kind and contentId match the record reading it,
 * and leaves the document untouched, so the drop of a mismatched entry is a
 * separate call a render effect makes. A body removes an entry a read that
 * succeeded after the tab appeared cannot resolve. Only the task's Session and id are stored; its name, instruction, and
 * deliveries are not.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'

/** The Sidebar fields that identify one task tab page across a reload. */
export interface TaskTabPage {
  /** The persisted layout record's own id. */
  readonly id: string
  /** That record's registered page kind. */
  readonly kind: string
  /** That record's content identity, shared by every tab of this page kind. */
  readonly contentId: string
}

/** The task one tab page last showed. */
export interface TaskTabTarget {
  /** The Session that owns the task. */
  readonly sessionId: SessionId
  /** The task's own identity. */
  readonly id: ScheduleId
}

/** One stored entry: the page it belongs to and the task it showed. */
interface StoredEntry extends TaskTabTarget {
  readonly kind: string
  readonly contentId: string
}

/** Storage prefix; one key per Session holds that Session's entries. */
const PREFIX = 'dsh.schedule.task-tab.v1.'

/**
 * The committed tab ids of one Session, read when an entry is stored so a closed
 * tab leaves none behind. `undefined` and an empty list both skip that removal:
 * `ctx.sidebarRight.tabsIn` returns the empty list for a Session whose layout is
 * not adopted as well as for one whose adopted layout holds no tabs, and pruning
 * against that answer would drop entries a restored tab still resolves through.
 */
export type TaskTabLiveIds = (sessionId: SessionId) => readonly string[] | undefined

/**
 * Whether a parsed storage value is a record rather than an array or a scalar.
 * @param value - parsed storage value.
 * @returns `true` for a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow one stored value to a task tab entry.
 * @param value - one member of a stored Session document.
 * @returns the entry, or undefined for a value this store did not write.
 */
function entryOf(value: unknown): StoredEntry | undefined {
  if (!isRecord(value)) return undefined
  const { kind, contentId, sessionId, id } = value
  if (typeof kind !== 'string' || typeof contentId !== 'string') return undefined
  if (typeof sessionId !== 'string' || typeof id !== 'string') return undefined
  return { kind, contentId, sessionId: sessionId as SessionId, id: id as ScheduleId }
}

/**
 * Narrow one stored Session document to its well-formed entries.
 * @param raw - stored text.
 * @returns the entries it holds; unparseable text and malformed values are dropped.
 */
function entriesOf(raw: string): Map<string, StoredEntry> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_invalidJson) {
    return new Map()
  }
  if (!isRecord(parsed)) return new Map()
  const entries = new Map<string, StoredEntry>()
  for (const [tabId, value] of Object.entries(parsed)) {
    const entry = entryOf(value)
    if (entry !== undefined) entries.set(tabId, entry)
  }
  return entries
}

/**
 * Last shown task per task tab page, kept in this window and in browser storage.
 *
 * The window copy is authoritative for this window's reads: it keeps the value
 * usable when storage is absent or rejects writes, and it avoids reparsing the
 * stored document on every render.
 */
export class TaskTabBindings {
  private readonly memory = new Map<SessionId, Map<string, StoredEntry>>()

  /**
   * @param liveTabIds - the committed layout's tab ids for one Session, read when an entry is stored.
   */
  constructor(private readonly liveTabIds?: TaskTabLiveIds) {}

  /**
   * Read the task one page last showed.
   *
   * An entry whose kind or contentId differs from the page reading it belongs to
   * a layout id that has since been reused; the read reports no task and leaves
   * the document untouched, and `dropMismatched` removes it after the render.
   * @param sessionId - the Session holding the tab.
   * @param page - the restored layout record.
   * @returns the task to show, or undefined when the page has no applicable entry.
   */
  read(sessionId: SessionId, page: TaskTabPage): TaskTabTarget | undefined {
    const entry = this.document(sessionId).get(page.id)
    if (entry === undefined) return undefined
    if (entry.kind !== page.kind || entry.contentId !== page.contentId) return undefined
    return { sessionId: entry.sessionId, id: entry.id }
  }

  /**
   * Drop one page's entry when it recorded another kind or contentId.
   *
   * A read reports the mismatch without writing, so the page resolves its target
   * in a render and drops the entry from an effect; a render React discards must
   * not rewrite what it read.
   * @param sessionId - the Session holding the tab.
   * @param page - the layout record the stored entry has to match.
   */
  dropMismatched(sessionId: SessionId, page: TaskTabPage): void {
    const entry = this.document(sessionId).get(page.id)
    if (entry === undefined || (entry.kind === page.kind && entry.contentId === page.contentId)) return
    this.forget(sessionId, page)
  }

  /**
   * Record the task one page now shows.
   * @param sessionId - the Session holding the tab.
   * @param page - the navigated layout record.
   * @param target - the task the navigation named.
   */
  write(sessionId: SessionId, page: TaskTabPage, target: TaskTabTarget): void {
    const entries = new Map(this.document(sessionId))
    entries.set(page.id, { kind: page.kind, contentId: page.contentId, ...target })
    this.store(sessionId, entries)
  }

  /**
   * Drop one page's entry once a read that succeeded after the tab appeared shows
   * its task is gone.
   * @param sessionId - the Session holding the tab.
   * @param page - the layout record whose entry is removed.
   */
  forget(sessionId: SessionId, page: TaskTabPage): void {
    const entries = new Map(this.document(sessionId))
    entries.delete(page.id)
    this.store(sessionId, entries)
  }

  /** Release this window's cached documents. */
  clear(): void {
    this.memory.clear()
  }

  /**
   * One Session's entries, from this window or from storage.
   * @param sessionId - the Session holding the tabs.
   * @returns its entries, empty when nothing is saved or storage is unreachable.
   */
  private document(sessionId: SessionId): Map<string, StoredEntry> {
    const cached = this.memory.get(sessionId)
    if (cached !== undefined) return cached
    if (typeof localStorage === 'undefined') return new Map()
    let raw: string | null
    try {
      raw = localStorage.getItem(PREFIX + sessionId)
    } catch (_storageUnavailable) {
      return new Map()
    }
    if (raw === null) return new Map()
    const entries = entriesOf(raw)
    this.memory.set(sessionId, entries)
    return entries
  }

  /**
   * Replace one Session's entries, dropping those of tabs a non-empty list of
   * committed ids does not hold, and publish them to this window and to storage.
   * An empty result removes the Session's key rather than storing an empty
   * document.
   * @param sessionId - the Session holding the tabs.
   * @param entries - the complete replacement set.
   */
  private store(sessionId: SessionId, entries: Map<string, StoredEntry>): void {
    const live = this.liveTabIds?.(sessionId)
    const kept = live === undefined || live.length === 0
      ? entries
      : new Map([...entries].filter(([tabId]) => live.includes(tabId)))
    this.memory.set(sessionId, kept)
    if (typeof localStorage === 'undefined') return
    try {
      const key = PREFIX + sessionId
      if (kept.size === 0) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept)))
    } catch (error) {
      console.error('Task tab binding persistence failed:', error)
    }
  }
}
