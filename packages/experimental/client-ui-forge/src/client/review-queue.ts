/** Browser-persisted review drafts and the write whose outcome still needs confirmation. */

import { z } from 'zod'
import type { ForgeReviewRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ReviewSelection, ReviewSource } from './review.ts'

const line = z.object({ path: z.string(), side: z.enum(['L', 'R']), startLine: z.number().int().positive(), endLine: z.number().int().positive(), body: z.string() })
const selection = z.object({ source: z.object({ kind: z.literal('change'), url: z.string(), headSha: z.string() }), comment: line.extend({ hunk: z.string() }) })
const recordedSelection = selection.extend({ source: z.discriminatedUnion('kind', [
  selection.shape.source, z.object({ kind: z.literal('local'), scope: z.string() }),
]) })
const record = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), selection: recordedSelection }),
  z.object({ kind: z.literal('published'), selection: recordedSelection, url: z.url({ protocol: /^https$/ }) }),
])
const event = z.enum(['comment', 'approve', 'request-changes'])
const request = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), headSha: z.string(), comment: line }),
  z.object({ kind: z.literal('review'), headSha: z.string(), event, body: z.string(), comments: z.array(line) }),
])
const saved = z.object({
  comments: z.array(selection), records: z.array(record).default([]), body: z.string(), event, uncertain: request.nullable(),
})

/** A comment retained after adding its reference or receiving a publication receipt. */
export type ReviewRecord =
  | { readonly kind: 'agent'; readonly selection: ReviewSelection }
  | { readonly kind: 'published'; readonly selection: ReviewSelection; readonly url: string }

/** One inline record; its numeric key belongs only to the retained browser store. */
export type ReviewThread = { readonly key: number } & (ReviewRecord | { readonly kind: 'pending'; readonly selection: ReviewSelection })

/** File-scoped snapshot that does not change while unrelated comments or the summary are edited. */
export interface FileReviewState {
  readonly threads: readonly ReviewThread[]
  readonly locked: boolean
  readonly error: ReviewQueueState['error']
}

/** Stable snapshot for a file without a comment store. */
export const EMPTY_FILE_REVIEW: FileReviewState = { threads: [], locked: false, error: null }

/** Immutable queue snapshot; errors leave the original stored bytes untouched. */
export interface ReviewQueueState {
  readonly comments: readonly ReviewSelection[]
  readonly records: readonly ReviewRecord[]
  readonly body: string
  readonly event: 'comment' | 'approve' | 'request-changes'
  readonly uncertain: ForgeReviewRequest | null
  readonly error: 'load' | 'save' | null
}

/** Initial state of a newly opened review tab. */
export const EMPTY_REVIEW: ReviewQueueState = { comments: [], records: [], body: '', event: 'comment', uncertain: null, error: null }

/** One review tab's drafts and records, retained until its occurrence closes. */
export class ReviewQueue {
  private closed = false
  private state: ReviewQueueState = EMPTY_REVIEW
  private readonly listeners = new Set<() => void>()
  private readonly keys = new WeakMap<ReviewSelection, number>()
  private nextKey = 0
  private readonly files = new Map<string, FileReviewState>()

  /** @param key - browser storage key including Session and tab identity. */
  constructor(private readonly key: string) {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) this.state = { ...saved.parse(JSON.parse(raw)), error: null }
    } catch (_error) {
      this.state = { ...EMPTY_REVIEW, error: 'load' }
    }
  }

  /** Current queue snapshot, stable between edits and storage failures. */
  readonly getSnapshot = (): ReviewQueueState => this.state

  /**
   * Clear this tab's records and refuse later completions from its outgoing requests.
   * @returns whether its browser storage was cleared; the in-memory state always closes.
   */
  close(): boolean {
    this.closed = true
    this.state = EMPTY_REVIEW
    this.files.clear()
    this.emit()
    this.listeners.clear()
    try {
      localStorage.removeItem(this.key)
    } catch (_error) {
      return false
    }
    return true
  }

  /** Summary subscribed by the surrounding diff; editing draft text does not invalidate its file rows. */
  readonly getStatus = (): string => `${this.state.comments.length}:${this.state.records.length}:${this.state.error ?? ''}:${this.state.uncertain === null ? 'idle' : 'pending'}`

  /**
   * Read stable inline records for one path and review source.
   * @param path - repository-relative file path.
   * @param source - PR or local scope; older head commits remain available as outdated comments.
   * @returns records and edit availability, reusing the snapshot when these values are unchanged.
   */
  fileComments(path: string, source: ReviewSource): FileReviewState {
    const matches = (item: ReviewSelection): boolean => item.comment.path === path && sameReviewSource(item.source, source)
    const threads: ReviewThread[] = [
      ...this.state.records.filter(item => matches(item.selection)).map(item => ({ ...item, key: this.keyOf(item.selection) })),
      ...this.state.comments.filter(matches).map(item => ({ kind: 'pending' as const, selection: item, key: this.keyOf(item) })),
    ]
    const key = JSON.stringify([path, source.kind, source.kind === 'local' ? source.scope : source.url])
    const previous = this.files.get(key)
    const locked = this.state.uncertain !== null
    if (previous !== undefined && previous.locked === locked && previous.error === this.state.error
      && previous.threads.length === threads.length && previous.threads.every((item, index) => {
      const next = threads[index]
      return next?.selection === item.selection && next.kind === item.kind
    })) return previous
    const value = { threads, locked, error: this.state.error }
    this.files.set(key, value)
    return value
  }

  /**
   * Retain an Agent reference at its original code location.
   * @param selection - reference already accepted by the main composer.
   * @returns whether the record was saved.
   */
  recordAgent(selection: ReviewSelection): boolean {
    return this.save({ ...this.state, records: [...this.state.records, { kind: 'agent', selection }] })
  }

  /**
   * Retain a published comment and settle its outgoing write atomically in browser storage.
   * @param selection - published comment's frozen code location.
   * @param url - confirmed publication URL.
   * @returns whether the receipt and comment were saved.
   */
  published(selection: ReviewSelection, url: string): boolean {
    return this.save({ ...this.state, uncertain: null, records: [...this.state.records, { kind: 'published', selection, url }] })
  }

  /**
   * Observe queue edits and storage failures.
   * @param listener - snapshot invalidation.
   * @returns unsubscribe.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Save a frozen PR comment unless a write needs reconciliation.
   * @param selection - frozen PR comment.
   * @returns whether it was saved.
   */
  add(selection: ReviewSelection): boolean {
    if (selection.source.kind !== 'change' || this.state.uncertain !== null) return false
    return this.save({ ...this.state, comments: [...this.state.comments, selection] })
  }

  /**
   * Edit or remove a pending comment without changing its captured lines.
   * @param index - comment position.
   * @param body - replacement text, or null to remove.
   * @returns whether saved.
   */
  edit(index: number, body: string | null): boolean {
    if (this.state.uncertain !== null) return false
    return this.save({ ...this.state, comments: this.state.comments.flatMap((item, at) => {
      if (at !== index) return [item]
      if (body === null) return []
      const next = { ...item, comment: { ...item.comment, body } }
      this.keys.set(next, this.keyOf(item))
      return [next]
    }) })
  }

  /**
   * Edit the currently pending occurrence addressed by an inline record.
   * @param key - browser-store identity from fileComments.
   * @param body - replacement text, or null to remove.
   * @returns whether the occurrence still exists and the edit was saved.
   */
  editThread(key: number, body: string | null): boolean {
    const index = this.state.comments.findIndex(item => this.keyOf(item) === key)
    return index !== -1 && this.edit(index, body)
  }

  /**
   * Save the summary and decision for the pending review.
   * @param body - review summary.
   * @param event - review decision.
   * @returns whether saved.
   */
  summarize(body: string, event: ReviewQueueState['event']): boolean {
    if (this.state.uncertain !== null) return false
    return this.save({ ...this.state, body, event })
  }

  /**
   * Persist the outgoing request before network dispatch.
   * @param request - exact write.
   * @returns whether dispatch may start.
   */
  begin(request: ForgeReviewRequest): boolean {
    if (this.state.uncertain !== null) return false
    return this.save({ ...this.state, uncertain: request })
  }

  /**
   * Clear the write after a known result or explicit reconciliation.
   * @param submitted - whether a batch review was published.
   * @param url - confirmed publication URL when retaining submitted comments.
   * @returns whether saved.
   */
  finish(submitted: boolean, url?: string): boolean {
    if (!submitted) return this.save({ ...this.state, uncertain: null })
    const records = url === undefined ? this.state.records : [...this.state.records,
      ...this.state.comments.map(item => ({ kind: 'published' as const, selection: item, url }))]
    return this.save({ ...EMPTY_REVIEW, records })
  }

  private keyOf(selection: ReviewSelection): number {
    let key = this.keys.get(selection)
    if (key === undefined) { key = ++this.nextKey; this.keys.set(selection, key) }
    return key
  }

  private save(state: ReviewQueueState): boolean {
    if (this.closed || this.state.error === 'load') return false
    try {
      const { error: _error, ...value } = state
      localStorage.setItem(this.key, JSON.stringify(value))
    } catch (_error) {
      this.state = { ...this.state, error: 'save' }
      this.emit()
      return false
    }
    this.state = { ...state, error: null }
    this.emit()
    return true
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

/**
 * Compare review identity while allowing records from an older PR head to remain visible.
 * @param left - recorded source.
 * @param right - displayed source.
 * @returns whether the sources name the same PR or local scope.
 */
export function sameReviewSource(left: ReviewSource, right: ReviewSource): boolean {
  return left.kind === 'local' ? right.kind === 'local' && left.scope === right.scope
    : right.kind === 'change' && left.url === right.url
}
