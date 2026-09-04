/** Cursor, page, and live-tail coordination over a reconnecting Remote stream. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from './stream-client.ts'
import type {
  RemoteStream,
  RemoteStreamItem,
  RemoteStreamOptions,
} from './remote-stream.ts'

/** Host-side stream protocol violation, marked so consumers surface it as an error state. */
function protocolViolation(message: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', message, {})
}

/** Transport-neutral opening snapshot, durable entry, or cursorless notification. */
export type RemoteJournalFrame<Entry, Cursor, Page, Notification = never> =
  | { readonly type: 'opened'; readonly cursor: Cursor; readonly page: Page }
  | { readonly type: 'entry'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

/** One journal-window update or cursorless domain notification. */
export type RemoteJournalChange<Page, Entry, Notification = never> =
  | {
    readonly type: 'replace'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | {
    readonly type: 'prepend'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

type JournalStreamItem<Page, Entry, Cursor, Notification> = RemoteStreamItem<
  RemoteJournalFrame<Entry, Cursor, Page, Notification>
>

/** Gateway capability used to create one reconnecting Remote stream. */
export interface RemoteStreamFactory {
  /**
   * Create one independently cancellable logical stream.
   * @param options - domain-owned opener and generation-end classification.
   * @returns a reconnecting single-consumer stream.
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
}

/** Domain publication and cursor operations for one addressed journal stream. */
export interface RemoteJournalStreamOptions<Page, Entry, Cursor, Notification = never> {
  /** Diagnostic stream name used in protocol failures. */
  readonly name: string
  /** Cursor representing a journal with no entries. */
  readonly emptyCursor: Cursor
  /** Read the ordered entries carried by a page. */
  readonly entries: (page: Page) => readonly Entry[]
  /** Read whether an older page exists. */
  readonly hasMore: (page: Page) => boolean
  /** Read the inclusive first durable cursor covered by one entry. */
  readonly first: (entry: Entry) => Cursor
  /** Read the inclusive final cursor, which must not precede the first. */
  readonly last: (entry: Entry) => Cursor
  /** Compare two cursors. */
  readonly compare: (left: Cursor, right: Cursor) => number
  /** Test whether the right cursor immediately follows the left cursor. */
  readonly follows: (left: Cursor, right: Cursor) => boolean
  /** Apply one complete journal-window change or cursorless notification. */
  readonly publish: (change: RemoteJournalChange<Page, Entry, Notification>) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Owns snapshot-first opening, ordered live delivery, pagination, and repair.
 *
 * The domain retains its published window during reconnection. A replacement is
 * published only after the opening page reaches the generation's cursor.
 * Notifications never change a cursor and wait behind an in-flight gap repair.
 */
export abstract class RemoteJournalStream<
  Page, Entry, Cursor, PageRequest = void, Notification = never,
> {
  private readonly stream: RemoteStream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>
  private initialRequest!: PageRequest
  private resumeCursor: Cursor | undefined
  private hasResumeCursor = false
  private generation = 0
  private firstCursor: Cursor | undefined
  private lastCursor: Cursor | undefined
  private started = false
  private opened = false
  private disposed = false
  private done: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private pendingNext: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> | undefined

  /**
   * @param remote - Gateway factory for the reconnecting physical-generation stream.
   * @param options - cursor algebra and domain publication sinks.
   */
  protected constructor(
    remote: RemoteStreamFactory,
    private readonly options: RemoteJournalStreamOptions<Page, Entry, Cursor, Notification>,
  ) {
    this.stream = remote.$stream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>({
      name: options.name,
      open: signal => this.follow(this.initialRequest, signal),
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${options.name} ended without a terminal result`)
        : protocolViolation(
          `${this.hasResumeCursor ? 'resumed ' : ''}${options.name} ended before its opening cursor`,
        ),
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
    })
  }

  /**
   * Open one physical journal generation with a complete current snapshot.
   * @param request - opening-window request retained for later repair.
   * @param signal - cancellation lifetime of the physical generation.
   * @returns opening cursor followed by live entries.
   */
  protected abstract follow(
    request: PageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<Entry, Cursor, Page, Notification>>

  /**
   * Read one journal page through the addressed domain source.
   * @param request - domain page request.
   * @param through - inclusive journal cursor that fixes the source read.
   * @param signal - cancellation lifetime shared with the logical stream.
   * @returns the requested page, whose tail equals `through` unless the domain request selects older entries.
   */
  protected abstract readPage(request: PageRequest, through: Cursor, signal: AbortSignal): Promise<Page>

  /**
   * Derive an unbounded-tail request from the initial page request.
   * @param initial - request used to open the journal window.
   * @returns request suitable for reconnect and gap repair.
   */
  protected abstract repairRequest(initial: PageRequest): PageRequest

  /** Cancellation lifetime shared by follow and page calls. */
  get signal(): AbortSignal {
    return this.stream.signal
  }

  /**
   * Establish follow and publish the opening snapshot carried by its first frame.
   * @param request - initial tail-page request.
   * @returns after the first complete window is published.
   */
  async open(request: PageRequest): Promise<void> {
    if (this.started) throw new Error(`${this.options.name} already opened`)
    this.started = true
    this.initialRequest = request
    const iterator = this.stream[Symbol.asyncIterator]()
    try {
      const first = await this.takeNext(iterator)
      if (first.done) throw protocolViolation(`${this.options.name} ended before its opening cursor`)
      this.replaceGeneration(first.value, false)
      this.opened = true
      this.done = this.consume(iterator)
    } catch (error) {
      await this.stream.dispose()
      throw error
    }
  }

  /**
   * Read and prepend one older page after a successful open.
   * @param request - domain page request bound to this stream's address.
   * @returns after the page is applied or rejected as discontinuous.
   */
  async prepend(request: PageRequest): Promise<void> {
    if (!this.opened || this.disposed) throw new Error(`${this.options.name} is not open`)
    const page = await this.readPage(request, this.currentCursor(), this.stream.signal)
    this.stream.signal.throwIfAborted()
    const entries = this.options.entries(page)
    this.assertPage(entries)
    const before = this.firstCursor
    const accepted = before === undefined
      ? [...entries]
      : entries.filter(entry => this.options.compare(this.options.first(entry), before) < 0)
    const tail = accepted.at(-1)
    if (tail !== undefined && before !== undefined
      && !this.options.follows(this.options.last(tail), before)) {
      this.options.publish({ type: 'prepend', page, entries: [], hasMore: false })
      throw protocolViolation(`${this.options.name} history page is discontinuous`)
    }
    const first = accepted[0]
    if (first !== undefined) this.firstCursor = this.options.first(first)
    this.options.publish({
      type: 'prepend',
      page,
      entries: accepted,
      hasMore: this.options.hasMore(page),
    })
  }

  /** Replace the active physical generation while retaining the published window. */
  restart(): void {
    this.stream.restart()
  }

  /**
   * Permanently stop follow, page requests, and the background consumer.
   * @returns when no stream work or publication callback can still run.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    const done = this.done
    const closing = (async () => {
      await this.stream.dispose()
      await done
    })()
    this.closing = closing
    return closing
  }

  private async consume(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    try {
      while (true) {
        const next = await this.takeNext(iterator)
        if (next.done) return
        const item = next.value
        if (item.generation !== this.generation) {
          this.replaceGeneration(item, true)
          continue
        }
        if (item.value.type === 'opened') {
          throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
        }
        if (item.value.type === 'notification') {
          this.publishNotification(item.value.notification)
          continue
        }
        await this.acceptEntry(item.value.entry, item, iterator)
      }
    } catch (error) {
      if (!this.disposed) this.options.failed(error)
    }
  }

  private replaceGeneration(
    initial: JournalStreamItem<Page, Entry, Cursor, Notification>,
    resumed: boolean,
  ): void {
    const opening = this.opening(initial, resumed)
    this.replaceFromOpening(opening.page, opening.cursor)
  }

  private opening(
    item: RemoteStreamItem<RemoteJournalFrame<Entry, Cursor, Page, Notification>>,
    resumed: boolean,
  ): { readonly cursor: Cursor; readonly page: Page } {
    if (item.value.type !== 'opened') {
      throw protocolViolation(`${resumed ? 'resumed ' : ''}${this.options.name} emitted an entry before its opening cursor`)
    }
    const cursor = item.value.cursor
    if (resumed && this.lastCursor !== undefined
      && this.options.compare(cursor, this.lastCursor) < 0) {
      throw protocolViolation(
        `${this.options.name} resumed at a cursor behind the last applied entry`,
      )
    }
    this.generation = item.generation
    item.accept()
    return { cursor, page: item.value.page }
  }

  /** Publish a generation's opening page without issuing a second Remote call. */
  private replaceFromOpening(page: Page, cursor: Cursor): void {
    this.assertPageThrough(page, cursor)
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    const first = entries[0]
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    this.lastCursor = cursor
    this.setResumeCursor(cursor)
    this.options.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
  }

  private async acceptEntry(
    entry: Entry,
    item: JournalStreamItem<Page, Entry, Cursor, Notification>,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    const { first, last: cursor } = this.entryRange(entry)
    const last = this.lastCursor as Cursor
    if (this.options.compare(cursor, last) <= 0) return
    if (this.options.compare(first, last) <= 0) {
      throw protocolViolation(`${this.options.name} emitted a partially overlapping entry`)
    }
    if (!this.options.follows(last, first)) {
      const request = this.repairPageRequest()
      const superseded = await this.replaceThrough(
        request,
        cursor,
        item.generation,
        item.signal,
        iterator,
        [entry],
        [],
      )
      if (superseded !== undefined) {
        this.replaceGeneration(superseded, true)
      }
      return
    }
    if (this.firstCursor === undefined) this.firstCursor = first
    this.lastCursor = cursor
    this.setResumeCursor(cursor)
    this.options.publish({ type: 'append', entry })
  }

  private async replaceThrough(
    request: PageRequest,
    requiredCursor: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<JournalStreamItem<Page, Entry, Cursor, Notification> | undefined> {
    let read = await this.readPageWhileFollowing(
      request,
      requiredCursor,
      generation,
      signal,
      iterator,
      queued,
      notifications,
    )
    if (read.type === 'superseded') return read.item
    let page = read.page
    this.assertPageThrough(page, requiredCursor)
    let entries = this.mergeReplacement(page, queued)
    let target = this.maxCursor(requiredCursor, queued)
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      read = await this.readPageWhileFollowing(
        this.repairPageRequest(),
        target,
        generation,
        signal,
        iterator,
        queued,
        notifications,
      )
      if (read.type === 'superseded') return read.item
      page = read.page
      this.assertPageThrough(page, target)
      entries = this.mergeReplacement(page, queued)
      target = this.maxCursor(requiredCursor, queued)
    }
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      throw protocolViolation(`${this.options.name} page did not reach its opening cursor`)
    }
    const first = entries[0]
    /* v8 ignore next -- a successful positive-cursor replacement page cannot be empty. */
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    this.lastCursor = this.tailCursor(entries)
    this.setResumeCursor(this.lastCursor)
    this.options.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
    for (const notification of notifications) {
      this.publishNotification(notification)
    }
    return undefined
  }

  private async readPageWhileFollowing(
    request: PageRequest,
    through: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<
    | { readonly type: 'page'; readonly page: Page }
    | { readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }
  > {
    const page = this.readPage(request, through, signal).then(
      value => ({ type: 'page' as const, value }),
      (error: unknown) => ({ type: 'page-error' as const, error }),
    )
    while (true) {
      const pending = this.nextResult(iterator)
      const next = pending.then(
        value => ({ type: 'next' as const, value }),
        (error: unknown) => ({ type: 'next-error' as const, error }),
      )
      const result = await Promise.race([page, next])
      if (result.type === 'page') {
        signal.throwIfAborted()
        return { type: 'page', page: result.value }
      }
      if (result.type === 'page-error') {
        if (!signal.aborted || this.stream.signal.aborted) throw result.error
        return this.awaitReplacementGeneration(generation, iterator, pending)
      }
      this.releaseNext()
      if (result.type === 'next-error') throw result.error
      if (result.value.done) {
        signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while reading its replacement page`)
      }
      const item = result.value.value
      if (item.generation !== generation) return { type: 'superseded', item }
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      if (item.value.type === 'notification') {
        notifications.push(item.value.notification)
        continue
      }
      queued.push(item.value.entry)
    }
  }

  private async awaitReplacementGeneration(
    generation: number,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    initial: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>>,
  ): Promise<{ readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }> {
    let pending = initial
    while (true) {
      let next: IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>
      try {
        next = await pending
      } finally {
        this.releaseNext()
      }
      if (next.done) {
        this.stream.signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while replacing an aborted page generation`)
      }
      const item = next.value
      if (item.generation !== generation) return { type: 'superseded', item }
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      pending = this.nextResult(iterator)
    }
  }

  private mergeReplacement(page: Page, queued: readonly Entry[]): Entry[] | undefined {
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    for (const entry of queued) this.entryRange(entry)
    const sorted = [...queued].sort((left, right) => (
      this.options.compare(this.options.first(left), this.options.first(right))
    ))
    let tail = this.tailCursor(entries)
    for (const entry of sorted) {
      const first = this.options.first(entry)
      const last = this.options.last(entry)
      if (this.options.compare(last, tail) <= 0) continue
      if (this.options.compare(first, tail) <= 0) {
        throw protocolViolation(`${this.options.name} replacement contains a partially overlapping entry`)
      }
      if (!this.options.follows(tail, first)) return undefined
      entries.push(entry)
      tail = last
    }
    return entries
  }

  private maxCursor(cursor: Cursor, entries: readonly Entry[]): Cursor {
    let result = cursor
    for (const entry of entries) {
      const candidate = this.options.last(entry)
      if (this.options.compare(candidate, result) > 0) result = candidate
    }
    return result
  }

  private nextResult(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    this.pendingNext ??= iterator.next()
    return this.pendingNext
  }

  private async takeNext(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    const pending = this.nextResult(iterator)
    try {
      return await pending
    } finally {
      this.releaseNext()
    }
  }

  private releaseNext(): void {
    this.pendingNext = undefined
  }

  private publishNotification(notification: Notification): void {
    this.options.publish({
      type: 'notification',
      notification,
    } as RemoteJournalChange<Page, Entry, Notification>)
  }

  private repairPageRequest(): PageRequest {
    return this.repairRequest(this.initialRequest)
  }

  private setResumeCursor(cursor: Cursor): void {
    this.resumeCursor = cursor
    this.hasResumeCursor = true
  }

  private currentCursor(): Cursor {
    return this.resumeCursor as Cursor
  }

  private tailCursor(entries: readonly Entry[]): Cursor {
    const tail = entries.at(-1)
    return tail === undefined ? this.options.emptyCursor : this.options.last(tail)
  }

  private assertPage(entries: readonly Entry[]): void {
    const iterator = entries[Symbol.iterator]()
    const first = iterator.next()
    if (first.done) return
    let previousRange = this.entryRange(first.value)
    for (const entry of iterator) {
      const range = this.entryRange(entry)
      if (!this.options.follows(previousRange.last, range.first)) {
        throw protocolViolation(`${this.options.name} page contains discontinuous entries`)
      }
      previousRange = range
    }
  }

  private entryRange(entry: Entry): { readonly first: Cursor; readonly last: Cursor } {
    const first = this.options.first(entry)
    const last = this.options.last(entry)
    if (this.options.compare(first, last) > 0) {
      throw protocolViolation(`${this.options.name} entry has an inverted cursor range`)
    }
    return { first, last }
  }

  private assertPageThrough(page: Page, through: Cursor): void {
    const tail = this.tailCursor(this.options.entries(page))
    if (this.options.compare(tail, through) !== 0) {
      throw protocolViolation(`${this.options.name} page did not end at its requested cursor`)
    }
  }
}
