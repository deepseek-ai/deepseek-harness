/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteStreamCarrierFailure,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
} from '../types.ts'
import { tailPageStart } from './sessions/buffered-pages.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
  historyRecords,
} from './sessions/history-records.ts'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from './contract/events.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import { assertSessionWireEvent } from './session-wire-event.ts'

export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq'>

/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session']

/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */
interface SessionJournalPage extends SessionPage {
  readonly projections?: SessionProjectionBaseline
  readonly assistantStream?: SessionAssistantStreamBaseline
}

/** One complete publication from the Session journal stream. */
export type SessionJournalChange =
  | {
    readonly type: 'replace' | 'prepend'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionEventLikeEntry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: SessionLiveEventEntry }
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

function toSessionJournalChange(
  change: RemoteJournalChange<
    SessionJournalPage, SessionHistoryRecord, SessionAssistantStreamFrame
  >,
): SessionJournalChange {
  switch (change.type) {
    case 'replace':
    case 'prepend':
      return { ...change, entries: historyEntries(change.entries) }
    case 'append': {
      return {
        type: 'append',
        entry: change.entry as unknown as SessionLiveEventEntry,
      }
    }
    case 'notification':
      return { type: 'assistant-stream', frame: change.notification }
  }
}

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierFailure) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierFailure) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: 'session control stream',
    open: signal => remote.session.control(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

/** Older records the published window released into memory, served to page reads before the Host. */
interface BufferedRecords {
  /** Contiguous records before the published window, oldest first. */
  records: readonly SessionHistoryRecord[]
  /** Whether the Host has history before `records`. */
  hostHasMore: boolean
}

/**
 * Gateway-owned event journal bound to one ordinary or direct-subagent Session address. Pages before the published
 * window come from buffered records first and from the Host after they run out; a replaced window drops the buffer.
 */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionAssistantStreamFrame
> {
  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    options: SessionEventStreamOptions,
  ) {
    const buffered: BufferedRecords = { records: [], hostHasMore: false }
    super(remote, {
      name: 'session event stream',
      emptyCursor: -1,
      entries: page => page.records,
      hasMore: page => page.hasMore,
      first: historyRecordFirstSeq,
      last: historyRecordLastSeq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => {
        if (change.type === 'replace') buffered.records = []
        options.publish(toSessionJournalChange(change))
      },
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
      failed: options.failed,
    })
    this.buffered = buffered
  }

  private readonly buffered: BufferedRecords

  /**
   * Release the start of the published window into memory; later pages before the window return it without a
   * request.
   * @param entries - durable entries at the window's start, oldest first, that the window no longer shows.
   * @param firstSeq - seq of the first entry the window still shows.
   * @param hostHasMore - whether the Host has history before `entries`; ignored while older entries are buffered.
   */
  bufferOlder(entries: readonly SessionLiveEventEntry[], firstSeq: number, hostHasMore: boolean): void {
    if (this.buffered.records.length === 0) this.buffered.hostHasMore = hostHasMore
    this.buffered.records = [...this.buffered.records, ...historyRecords(entries)]
    this.releaseBefore(firstSeq)
  }

  /** @inheritdoc */
  protected override async * follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<
    SessionHistoryRecord, number, SessionJournalPage, SessionAssistantStreamFrame
  >> {
    let assistantRevision: number | undefined
    for await (const frame of this.remote.session.follow({
      address: this.address,
      activate: true,
      assistantStream: true,
      ...this.repairRequest(request),
    }, signal)) {
      if (frame.type === 'snapshot') {
        for (const record of frame.records) assertSessionWireEvent(record.event)
        if (frame.assistantStream === undefined) {
          throw new RemoteError(
            'gateway/internal',
            'session assistant stream omitted its opted-in opening baseline',
            {},
          )
        }
        assistantRevision = frame.assistantStream.revision
        yield {
          type: 'opened',
          cursor: frame.cursor,
          page: {
            records: frame.records,
            hasMore: frame.hasMore,
            projections: frame.projections,
            assistantStream: frame.assistantStream,
          },
        }
        continue
      }
      if (frame.type === 'assistant-stream') {
        const expected = (assistantRevision ?? 0) + 1
        if (frame.frame.revision !== expected) {
          throw new RemoteStreamCarrierError(
            `session assistant stream skipped revision ${String(expected)}`,
          )
        }
        assistantRevision = frame.frame.revision
        yield { type: 'notification', notification: frame.frame }
        continue
      }
      assertSessionWireEvent(frame.event)
      yield { type: 'entry', entry: frame }
    }
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    const buffered = this.buffered.records
    // Only a page before the window reads the buffer; a gap repair without beforeSeq reads the Host.
    if (request.beforeSeq !== undefined && buffered.length > 0) {
      const start = tailPageStart(buffered, request.turnWindow)
      this.buffered.records = buffered.slice(0, start)
      return { records: buffered.slice(start), hasMore: start > 0 || this.buffered.hostHasMore }
    }
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request },
      signal,
    )
    if (!result.ok) throw result.error
    for (const record of result.value.records) assertSessionWireEvent(record.event)
    return result.value
  }

  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    }
  }
}
