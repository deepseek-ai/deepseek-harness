/**
 * The C2C `append` stream driver of the QQ official bot.
 *
 * QQ has **no message update at all**. The only incremental primitive is `POST
 * /v2/users/{openid}/stream_messages` (`api.ts`): a server-side "typewriter" that appends text to a message it has
 * already delivered. Its bookkeeping is:
 *
 * - `content_type` — `text` or `markdown`, the shape of the body that was streamed;
 * - `index` — the number of the chunk, strictly increasing;
 * - `stream_msg_id` — the identity of the streamed message: the **`id` of the first answer**, since the endpoint
 * has no field of its own for it;
 * - `input_state` — {@link INPUT_STATE_OPEN} keeps the stream open, {@link INPUT_STATE_CLOSE} ends it;
 * - `remain_msg_len` — reported as `0` on every answer of a live 单聊 stream, including one that had just taken five
 * characters, so it is not a measurement of the room left and never refuses a request on its own. A non-zero value is
 * honoured as the room the message still has; the platform's own refusal is what actually ends a stream it cannot
 * extend, and the driver reports that as {@link StreamLimitError} `shape` — a *fresh* message has the whole length
 * budget, so the scheduler recalls the streamed one and resends the state as an ordinary message. It is deliberately
 * not `size`: the scheduler treats a `size` violation of the final state as fatal, which would fail a stream that a
 * fresh message could still publish.
 *
 * The endpoint exists for 单聊 only ("群消息不支持流式参数"), so {@link QQBot.streamDriver} installs this driver for a
 * `direct` chat with `config.stream` and answers `undefined` everywhere else: a group keeps the core `final`
 * strategy (buffer the states, publish once at close), which is the only correct strategy there. Both modes stream —
 * which of them a turn opens in is the core's `prefer-streamable-mode` + `prefer-expressive-mode` resolution, not an
 * adapter choice.
 *
 * ## What the driver publishes
 *
 * Every request carries the **whole state** with `input_mode: 'replace'` — the mode the platform documents, and the
 * only one its own examples use: `content_raw` is the full text and the platform appends the part it has not shown
 * yet. A hand-computed suffix with `input_mode: 'append'` was tried first and is what the endpoint answers
 * `remain_msg_len: 0` to on a message that had just taken five characters, so the suffix is now only what decides
 * whether a request is needed at all, and what recognizes the platform's **immutable prefix**: the new state must
 * still start with what the chat shows. The scheduler computes that suffix as a `mode.diff()` patch whenever it can;
 * when it cannot (a retried tick left the platform state unknown, or the state replaced content) the platform may be
 * showing something the new state no longer starts with. That is exactly the
 * `shape` violation: this driver throws {@link StreamLimitError} with `kind: 'shape'`, the scheduler
 * stops publishing intermediate states, and at close it recalls the streamed message and sends the final state as an
 * ordinary message. The same holds for a state that cannot be streamed at all: a media element (its own
 * `msg_type: 7` message) and a markdown body with a keyboard (streaming carries no `keyboard` field).
 *
 * ## Passive replies
 *
 * `stream_messages` answers an inbound event like any other send, so every request claims a passive ticket through
 * {@link PassiveManager} — `msg_id` of the event and the next `msg_seq` — and a request without a ticket is a
 * violation of the `budget` kind, not an active send. That is also the driver's budget: the platform
 * accepts a fixed number of numbered requests per event (`passive.c2cReplies`, 4 by default), so
 * {@link StreamDriver.budget} reports the replies left as `updatesLeft` and the scheduler keeps one for `close`.
 * `until` is deliberately **not** reported: the passive window of a C2C message is an hour, and the scheduler
 * stretches its interval across a reported horizon, which would turn a typewriter into a once-per-20-minutes update.
 * A window that closes mid-stream surfaces on the next request as a spent ticket, which resolves the stream through
 * the same path.
 *
 * The `(msg_id, msg_seq)` pair is the only idempotency primitive the platform has, so a retried chunk reuses the
 * sequence it was given (the ticket is keyed by `SendOptions.idempotencyKey` + the chunk index) and a `40054005`
 * answer for it means the earlier attempt did publish: it is reported as `published: 'unknown'` instead of appending
 * the same text twice. A `40054005` for a sequence this chunk never carried means another client took it, so the
 * chunk moves to the next sequence and tries once more — the same rule as `send.ts`.
 *
 * What a live run established, none of it in the platform's prose: a chunk is an ordinary passive request
 * (`msg_id` + `msg_seq`, so it spends one of `passive.c2cReplies`); the body field is `content_raw`; and the first
 * answer returns the streamed message's identity in `id`, not in a `stream_msg_id` field. Both mistakes are invisible
 * in the answer's status: a chunk sent as `content` is accepted with no text and answers `remain_msg_len: 0`, and a
 * stream whose later chunks omit the id appends to nothing.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/stream
 */

import {
  PlatformError,
  StreamLimitError,
  type MessageHandle,
  type Prepared,
  type SentPart,
  type StreamDriver,
  type StreamTickContext,
  type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { parseChatId, type QqAddress, type QqMessageRequest, type QqStreamRequest, type QqStreamResponse } from './api.ts'
import type { QQBot } from './bot.ts'
import { QqApiError } from './errors.ts'
import type { QqDraft, QqPatch, QqTypes } from './modes/shared.ts'
import { referrerOf, type PassiveTicket } from './passive.ts'
import { DEDUPE_CODE } from './send.ts'

/** `input_state` of a chunk that keeps the stream open . */
export const INPUT_STATE_OPEN = 1
/** `input_state` of the chunk that finishes the platform's streaming state . */
export const INPUT_STATE_CLOSE = 10

/** `content_type` of the stream endpoint, derived from the `msg_type` of the serialized part. */
export type QqStreamContentType = 'text' | 'markdown'

/**
 * The adapter-private `handle.state` of a streamed message: everything the driver needs from one request to the
 * next, so the driver itself is stateless and one instance serves every stream of the bot.
 */
export interface QqStreamState {
  /** `content_type` the message was created with; a state that switches it cannot be appended. */
  contentType: QqStreamContentType
  /** Content the platform already shows — the immutable prefix of the streamed message. */
  published: string
  /** `index` of the next chunk: one per request that reached the platform. */
  index: number
  /** `stream_msg_id` of the first answer, echoed by every later chunk. */
  streamId?: string
  /** `remain_msg_len` of the last answer (characters the message still accepts), when the platform reports it. */
  remain?: number
}

/** Options of {@link createStreamDriver}. */
export interface QqStreamDriverOptions {
  /** Clock of `SentPart.time` (the recall window is measured from it); injected by tests. */
  now?: () => number
}

/** A streamable state of one serialized part: the body of a `stream_messages` chunk. */
interface Chunk {
  contentType: QqStreamContentType
  content: string
}

/**
 * The route of a streamed message: `user:<openid>` only.
 *
 * @param bot - the adapter (for the message).
 * @param target - target chat.
 * @returns the parsed C2C address.
 * @throws PlatformError `invalid` when the chat id is not a QQ id at all (a broken target is not worth retrying).
 * @throws StreamLimitError `shape` for a group: the platform refuses streaming outside 单聊.
 */
function addressOf(bot: QQBot, target: Target): QqAddress {
  let address: QqAddress
  try {
    address = parseChatId(target.chat.id)
  } catch (error) {
    throw new PlatformError('invalid', `${bot.id}: ${(error as Error).message}`, { published: 'no', cause: error })
  }
  if (address.kind !== 'user') {
    throw new StreamLimitError({
      kind: 'shape',
      message: `qq: stream_messages serves C2C chats only, ${target.chat.id} is a group`,
    })
  }
  return address
}

/**
 * The streamable content of one serialized payload.
 *
 * @param payload - `QqMessageRequest` of the mode (`serialize`).
 * @returns `content_type` plus the text to append.
 * @throws PlatformError `invalid` for something that is not one request body.
 * @throws StreamLimitError `shape` for a body the endpoint cannot carry: media (its own `msg_type: 7` message) and a
 * keyboard (the stream endpoint has no `keyboard` field), both of which need an ordinary message.
 */
function asChunk(payload: unknown): Chunk {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PlatformError('invalid', 'qq: a stream chunk expects one QqMessageRequest body', { published: 'no' })
  }
  const body = payload as { msg_type?: number; content?: unknown; markdown?: unknown; keyboard?: unknown }
  if (body.keyboard !== undefined) {
    throw new StreamLimitError({
      kind: 'shape',
      message: 'qq: stream_messages carries no keyboard, so a message with buttons cannot be streamed',
    })
  }
  if (body.msg_type === 0 && typeof body.content === 'string') {
    return { contentType: 'text', content: body.content }
  }
  const content = (body.markdown as { content?: unknown } | undefined)?.content
  if (body.msg_type === 2 && typeof content === 'string') {
    return { contentType: 'markdown', content }
  }
  throw new StreamLimitError({
    kind: 'shape',
    message: 'qq: only a text or markdown body can be streamed; media is a message of its own',
  })
}

/** The driver bookkeeping of a handle the driver created. */
function stateOf(handle: MessageHandle): QqStreamState {
  const state = handle.state as QqStreamState | undefined
  if (!state || typeof state !== 'object' || typeof state.published !== 'string') {
    throw new PlatformError('fatal', 'qq: the stream handle does not carry the QQ stream state')
  }
  return state
}

/**
 * The suffix the new state adds to what the platform already shows.
 *
 * @param state - published prefix and content type of the streamed message.
 * @param content - content of the new state (the whole text, never a delta).
 * @param patches - the scheduler's `mode.diff()` result, when it had one.
 * @returns the text to append; `''` when the platform already shows this state.
 * @throws StreamLimitError `shape` when the platform's immutable prefix is not a prefix of `content` any more.
 */
function suffixOf(state: QqStreamState, content: string, patches?: readonly QqPatch[]): string {
 // The scheduler numbers a diff against the last published draft; a patch that does not line up with what the
 // platform shows carries no usable delta, so fall through to the prefix test.
  const appended = patches?.map(patch => patch.append).join('')
  if (appended !== undefined && state.published + appended === content) return appended
  if (!content.startsWith(state.published)) {
    throw new StreamLimitError({
      kind: 'shape',
      message: `qq: the streamed message already shows ${state.published.length} characters that the new state`
        + ' does not keep — the platform never replaces them',
    })
  }
  return content.slice(state.published.length)
}

/**
 * Refuse a chunk the streamed message cannot take any more.
 *
 * The comparison is against the suffix, not the state: `remain_msg_len` counts what the **message** still accepts,
 * and only the suffix is appended to it. A state that does not fit the leftover room of this streamed message is a
 * {@link StreamLimitError} of kind `shape` (not `size`): the platform's message cannot grow any further, while a fresh
 * message can carry the whole state, so the scheduler's recall + resend is the correct degradation. A `size`
 * violation would be the scheduler's "the final state is too large for the platform at all" case and fail the stream,
 * which is exactly the failure a live run produced.
 *
 * @param state - bookkeeping of the streamed message.
 * @param suffix - text this request would append.
 * @param content - text of the whole new state (for the violation report).
 * @throws StreamLimitError `shape` when the platform's remaining length of the message is smaller than `suffix`.
 */
function assertRoom(state: QqStreamState, suffix: string, content: string): void {
  // A live 单聊 stream answered `remain_msg_len: 0` for a message that had just taken five characters, so a zero is
  // not a measurement of the room left. The request goes out and the platform's own refusal decides.
  if (state.remain === undefined || state.remain === 0 || suffix.length <= state.remain) return
  throw new StreamLimitError({
    kind: 'shape',
    key: 'limit.text.chars',
    limit: state.published.length + state.remain,
    actual: content.length,
    message: `qq: the streamed message has room for ${state.remain} more characters, the state appends ${suffix.length}`
      + ` (${content.length} characters in all) — it is resent as an ordinary message`,
  })
}

/**
 * Claim the passive ticket of one chunk.
 *
 * @param bot - the adapter holding the bookkeeping.
 * @param target - target chat and its referrer.
 * @param key - idempotency key of this chunk; a repeated claim returns the sequence it was already given.
 * @param fresh - book the *next* sequence even when the key already has one (the `40054005` retry).
 * @returns the ticket, or `undefined` when the window is closed, its budget is spent or there is no referrer.
 */
function claim(bot: QQBot, target: Target, key: string | undefined, fresh = false): PassiveTicket | undefined {
  const referrer = referrerOf(target)
  if (!referrer) return undefined
  if (key === undefined) return bot.passive.claim(referrer)
  return fresh ? bot.passive.claim(referrer, { idempotencyKey: key, fresh }) : bot.passive.claim(referrer, { idempotencyKey: key })
}

/** The `budget` violation of : this stream cannot reach the platform (no window, budget spent, a click). */
function budgetViolation(message: string) {
  return new StreamLimitError({ kind: 'budget', message })
}

/** Whether a failure is the platform's `(msg_id, msg_seq)` dedupe answer . */
function isDedupe(error: unknown) {
  return QqApiError.is(error) && error.code === DEDUPE_CODE
}

/**
 * Append one chunk to the streamed message, with the passive bookkeeping and the dedupe retry of.
 *
 * @param bot - the adapter (REST client, passive manager, clock).
 * @param state - bookkeeping of the streamed message; advanced on success.
 * @param address - C2C route of the chat.
 * @param content - text to append (may be empty for the closing request).
 * @param inputState - {@link INPUT_STATE_OPEN} or {@link INPUT_STATE_CLOSE}.
 * @param ctx - the scheduler's tick context (target, signal, options).
 * @returns the platform's answer (`stream_msg_id`, `remain_msg_len`).
 * @throws StreamLimitError `budget` when no passive ticket is available.
 * @throws PlatformError `invalid` `published: 'unknown'` when a retried chunk hits the `(msg_id, msg_seq)` dedupe.
 */
async function sendChunk(
  bot: QQBot,
  state: QqStreamState,
  address: QqAddress,
  content: string,
  inputState: number,
  ctx: StreamTickContext,
): Promise<QqStreamResponse> {
  const base = ctx.options.idempotencyKey
  const key = base === undefined ? undefined : `${base}:stream:${state.index}`
  let ticket = claim(bot, ctx.target, key)
  if (!ticket) throw budgetViolation('qq: a streamed message answers the event it was started for; no passive reply left')
  if (ticket.field !== 'msg_id') throw budgetViolation('qq: a click (event_id) cannot be answered with a streamed message')
  for (let attempt = 1; ; attempt++) {
    const request: QqStreamRequest = {
      content_type: state.contentType,
      content_raw: content,
      index: state.index,
      input_mode: 'replace',
      input_state: inputState as 1 | 10,
      msg_id: ticket.key,
      msg_seq: ticket.seq,
      ...state.streamId === undefined ? {} : { stream_msg_id: state.streamId },
    }
    try {
      const answer = await bot.api.streamMessage(address, request, ctx.signal)
      state.index += 1
      // `replace` sends the whole state, so after this request the platform shows exactly these characters.
      state.published = content
      // The first answer names the streamed message by `id`; the endpoint has no separate `stream_msg_id` field.
      const streamId = answer?.stream_msg_id ?? (state.streamId === undefined ? answer?.id : undefined)
      if (streamId) state.streamId = streamId
      if (typeof answer?.remain_msg_len === 'number') state.remain = answer.remain_msg_len
      return answer
    } catch (error) {
      if (!isDedupe(error) || attempt > 1) throw error
      if (ticket.reused) {
 // The sequence this chunk was given already carried it: the earlier attempt did append, only its answer was
 // lost. Appending again would duplicate the text, so the failure says "published, id unknown" (send.ts).
        throw new PlatformError(
          'invalid',
          `${bot.id}: stream chunk ${state.index} was already accepted by an earlier attempt — the text is published`
          + ' but the platform state is unknown',
          { code: DEDUPE_CODE, published: 'unknown', cause: error },
        )
      }
      const next = claim(bot, ctx.target, key, true)
      if (!next) throw error
      ticket = next
    }
  }
}

/**
 * The C2C `append` driver of /.
 *
 * One driver instance serves every stream: the per-message bookkeeping lives in {@link QqStreamState} on
 * `handle.state`, which keeps {@link QQBot.streamDriver} cheap and pure (the core calls it on every capability
 * evaluation).
 *
 * @param bot - the adapter (REST client, passive manager).
 * @param options - clock override for tests.
 * @returns the driver: `strategy: 'append'`, `open` creates the streamed message, `tick` appends the new suffix,
 * `close` appends the last suffix with `input_state: 10`, `budget` reports the passive replies left.
 */
export function createStreamDriver(bot: QQBot, options: QqStreamDriverOptions = {}): StreamDriver<QqTypes> {
  const now = options.now ?? Date.now
  return {
    strategy: 'append',

    /**
 * Create the streamed message: the first state is appended to an empty message with `input_state: 1`.
 *
 * @param _first - prepared draft of the first state (the payload is what the endpoint takes).
 * @param payload - serialized `msg_type` body of the first state.
 * @param ctx - tick context of the first publication.
 * @returns the handle of the streamed message; its single part is the platform message the stream appends to.
 */
    async open(_first: Prepared<QqDraft>, payload: QqMessageRequest, ctx: StreamTickContext): Promise<MessageHandle> {
      const chunk = asChunk(payload)
      const address = addressOf(bot, ctx.target)
      const state: QqStreamState = { contentType: chunk.contentType, published: '', index: 0 }
      const answer = await sendChunk(bot, state, address, chunk.content, INPUT_STATE_OPEN, ctx)
      const time = now()
      const part: SentPart = {
        id: answer?.id ?? answer?.stream_msg_id ?? '',
        kind: chunk.contentType,
        time,
        raw: answer,
      }
      return {
        bot: bot.id,
        target: ctx.target,
        mode: ctx.mode,
        parts: [part],
        createdAt: time,
        edits: 0,
        content: ctx.content,
        state,
      }
    },

    /**
 * Append the suffix the new state adds. The platform keeps the prefix it already shows, so a state that does not
 * extend it is a `shape` violation, resolved by at close — and so is a suffix the message's `remain_msg_len`
 * has no room for (a fresh message can carry it).
 *
 * @param handle - the streamed message.
 * @param change - new prepared draft, serialized payload, and the scheduler's diff when it had one.
 * @param ctx - tick context.
 */
    async tick(
      handle: MessageHandle,
      change: { draft: Prepared<QqDraft>; payload: QqMessageRequest; patches?: QqPatch[] },
      ctx: StreamTickContext,
    ): Promise<void> {
      const state = stateOf(handle)
      const chunk = asChunk(change.payload)
      if (chunk.contentType !== state.contentType) {
        throw new StreamLimitError({
          kind: 'shape',
          message: `qq: the streamed message is ${state.contentType} and cannot switch to ${chunk.contentType}`,
        })
      }
      const suffix = suffixOf(state, chunk.content, change.patches)
      if (!suffix) return
      assertRoom(state, suffix, chunk.content)
      await sendChunk(bot, state, addressOf(bot, ctx.target), chunk.content, INPUT_STATE_OPEN, ctx)
      handle.edits += 1
    },

    /**
 * Publish the last suffix and finish the platform's streaming state (`input_state: 10`,), even when the
 * content did not change — a stream left open shows a "generating" state forever.
 *
 * @param handle - the streamed message.
 * @param last - prepared draft and payload of the final state.
 * @param ctx - tick context.
 */
    async close(
      handle: MessageHandle,
      last: { draft: Prepared<QqDraft>; payload: QqMessageRequest },
      ctx: StreamTickContext,
    ): Promise<void> {
      const state = stateOf(handle)
      const chunk = asChunk(last.payload)
      if (chunk.contentType !== state.contentType) {
        throw new StreamLimitError({
          kind: 'shape',
          message: `qq: the streamed message is ${state.contentType} and cannot switch to ${chunk.contentType}`,
        })
      }
      const suffix = suffixOf(state, chunk.content, undefined)
      assertRoom(state, suffix, chunk.content)
      await sendChunk(bot, state, addressOf(bot, ctx.target), chunk.content, INPUT_STATE_CLOSE, ctx)
    },

    /**
 * The passive replies this stream may still spend : one request per chunk, one kept for `close`.
 *
 * @param handle - the streamed message.
 * @returns `updatesLeft` = replies left in the window; `until` is not reported (see the module documentation).
 */
    budget(handle: MessageHandle): { updatesLeft?: number; until?: number } {
      return { updatesLeft: bot.passive.remaining(referrerOf(handle.target)) }
    },
  }
}
