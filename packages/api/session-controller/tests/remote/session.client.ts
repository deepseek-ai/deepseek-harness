/**
 * The Remote side of one Session under test: default answers for every
 * `session/*` and `subagents/*` endpoint a `Session` or its manager calls, builders for
 * the two history-shaped answers, the `session/follow` opening snapshot and
 * the `session/page` page, both derived from event lists the way the Host
 * derives them from its log, and builders for the `session/control` queue
 * frame and the attachment references the Host's log carries.
 */
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { ok, type RemoteMock, type RemoteTable, type StreamScript, type UnaryRuleFn } from '@deepseek-ai/dsh-remote-mock'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionAssistantStreamBaseline, SessionControlFrame, SessionFollowFrame, SessionFollowRequest,
  SessionPage, SessionPageRequest, SessionQueuedItem, SessionRequestId,
} from '../../src/types.ts'
import { entries, historyValue } from '../event-script.client.ts'
import { followSnapshot, pageThrough } from './history.client.ts'

export { followSnapshot } from './history.client.ts'

/** Endpoints a Session opens and calls for its history. */
export const FOLLOW = 'session/follow'
export const PAGE = 'session/page'

/** A history answer as the Host returns it, possibly still pending. */
export type HistoryAnswer = RemoteResult<SessionPage> | Promise<RemoteResult<SessionPage>>
/** A history answer, or a function of the request that produces one. */
export type HistorySource<Request> = HistoryAnswer | ((request: Request) => HistoryAnswer)

/**
 * The failure branch of a Remote result.
 * @param error - the owner-declared failure.
 * @returns the result.
 */
export function err<T>(error: RemoteFailure): RemoteResult<T> {
  return { ok: false, error }
}

/**
 * The Host's history answer for `events`.
 * @param events - events in seq order.
 * @param hasMore - whether older history exists.
 * @returns the success result.
 */
export function history(events: readonly SessionEvent[], hasMore = false): RemoteResult<SessionPage> {
  return ok(historyValue(events, hasMore))
}

/**
 * One live event frame of a follow stream.
 * @param event - the event.
 * @returns the frame.
 */
export function frame(event: SessionEvent): SessionFollowFrame {
  return entries([event])[0]!
}

/**
 * Deliver one live event to every open follow stream and wait until the client has consumed it.
 * @param mock - the mock holding the streams.
 * @param event - the event.
 */
export async function pushEvent(mock: RemoteMock, event: SessionEvent): Promise<void> {
  mock.streams.push(FOLLOW, frame(event))
  await mock.streams.drained(FOLLOW)
}

/**
 * `session/follow` script: the opening snapshot built from the history answer,
 * then open for pushes. A failed answer fails the stream with its error; a
 * rejected one fails it with the rejection.
 * @param history - history answer or a function of the follow request.
 * @param options - snapshot cursor and initial Assistant stream state; the latter may be read per opening.
 * @returns the script.
 */
export function followScript(
  history: HistorySource<SessionFollowRequest>,
  options: {
    cursor?: number
    assistantStream?: SessionAssistantStreamBaseline | (() => SessionAssistantStreamBaseline)
  } = {},
): StreamScript {
  return async ([request], stream) => {
    const follow = request as SessionFollowRequest
    const result = await answer(history, follow)
    if (!result.ok) {
      stream.fail(result.error)
      return
    }
    const assistantStream = typeof options.assistantStream === 'function'
      ? options.assistantStream()
      : options.assistantStream
    stream.push(followSnapshot(result.value, follow, options.cursor, assistantStream))
  }
}

/**
 * `session/page` rule: the history answer cut at the request's `throughSeq`.
 * @param history - history answer or a function of the page request.
 * @returns the rule.
 */
export function pageRule(
  history: HistorySource<SessionPageRequest>,
): UnaryRuleFn<readonly [SessionPageRequest], Promise<RemoteResult<SessionPage>>> {
  return async (page) => {
    const result = await answer(history, page)
    if (!result.ok) return result
    return ok(pageThrough(result.value, page.throughSeq))
  }
}

function answer<Request>(history: HistorySource<Request>, request: Request): HistoryAnswer {
  return typeof history === 'function' ? history(request) : history
}

/**
 * An image attachment reference as the Host's durable log carries it.
 * @param id - opaque attachment id.
 * @returns the reference.
 */
export function imageRef(id: string): ImageAttachmentRef {
  return { attachmentId: AttachmentId(id), mediaType: 'image/png', bytes: 1, width: 2, height: 2 }
}

/**
 * A file attachment reference as the Host's durable log carries it.
 * @param id - opaque attachment id.
 * @param name - display filename.
 * @returns the reference.
 */
export function fileRef(id: string, name = 'notes.txt'): FileAttachmentRef {
  return { attachmentId: AttachmentId(id), name, bytes: 3 }
}

/** One pending inbox occurrence of a queue frame; the message id defaults to the item id. */
export interface QueueItemFixture {
  readonly id: string
  readonly placement?: SessionQueuedItem['placement']
  /** Prompt identity the Host copied from the queued message's user source. */
  readonly rpcId?: SessionRequestId
  /** Queued message content; ignored when `message` is given. */
  readonly content?: readonly ContentBlock[]
  /** The queued message itself, for a test that also lands it durably (the queue mirror correlates by `id`). */
  readonly message?: { readonly id: MessageId; readonly content: readonly ContentBlock[] }
}

/**
 * One pending inbox occurrence as the Host lists it.
 * @param fixture - item fields.
 * @returns the item.
 */
export function queueItem(fixture: QueueItemFixture): SessionQueuedItem {
  const message = fixture.message ?? { id: fixture.id as MessageId, content: fixture.content ?? [] }
  return {
    id: fixture.id as MessageId,
    placement: fixture.placement ?? 'queued',
    ...(fixture.rpcId === undefined ? {} : { rpcId: fixture.rpcId }),
    // The Host serializes queued content to JSON; the blocks cross unchanged.
    message: { id: message.id, content: message.content as unknown as SessionQueuedItem['message']['content'] },
  }
}

/**
 * One authoritative queue frame of the `session/control` stream.
 * @param sessionId - the addressed Session.
 * @param items - the complete pending queue.
 * @returns the frame.
 */
export function queueFrame(
  sessionId: SessionId,
  items: readonly QueueItemFixture[],
): Extract<SessionControlFrame, { type: 'queue' }> {
  return { type: 'queue', sessionId, items: items.map(queueItem) }
}

/** Default answers: every command accepted, empty history and subagent catalog, one attachment of one zero byte. */
export const sessionWorld: RemoteTable = {
  unary: {
    'session/prompt': ok({ accepted: true }),
    'session/cancel': ok({ accepted: true }),
    'session/updateQueue': ok({ accepted: true }),
    'session/rename': ok({ title: 'fk-renamed', seq: 0 }),
    'session/attachment': ok({
      attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      data: 'AA==',
    }),
    'session/page': pageRule(ok({ records: [], hasMore: false })),
    'subagents/list': ok({ entries: [], parentAvailable: true }),
    'subagents/prompt': ok({ messageId: 'fake-message' }),
    'subagents/interruptByParent': ok({ accepted: true }),
  },
  stream: {
    'session/follow': followScript(ok({ records: [], hasMore: false })),
  },
}
