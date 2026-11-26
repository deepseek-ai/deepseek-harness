/**
 * The network stage of the QQ official bot: `sendPayload` and `deletePart`.
 *
 * Modes serialize a `QqMessageRequest` (`api.ts`) **without** the passive fields; this stage owns the two of them that
 * the platform needs to accept a reply without a quota:
 *
 * - `msg_id` (or `event_id` for a button click) — the event being answered, from `Target.referrer`
 *   ({@link import('./decode.ts').QQReferrer}).
 * - `msg_seq` — the reply's number inside that event's window, from the {@link PassiveManager}.
 *
 * The ticket is claimed **once per part**: the core retries `sendPayload` on `retryable`/`rate-limit` failures and
 * every other adapter would then publish twice, but QQ's `(msg_id, msg_seq)` dedupe makes the sequence the natural
 * idempotency key, so a retried part re-claims the sequence it was given (`reused`). Two outcomes follow:
 *
 * - The platform answers `40054005` for a sequence this part has not carried yet: another client (koishi) used it, so
 * the adapter bumps to the next sequence and retries **once**.
 * - The platform answers `40054005` for a sequence this part already carried: the earlier attempt *did* publish, and
 * only the id is unknown — the failure is reported as `published: 'unknown'` (dsh-im records `uncertain`) instead of
 * sending a duplicate.
 *
 * A click's `event_id` goes out as `INTERACTION_CREATE:<id>` ({@link eventIdOf}): the gateway reports the interaction
 * as a bare uuid, and a message body carrying that bare id is refused with `40034025`. A refusal of the field itself
 * falls back to one active send, which cannot duplicate anything because the refusal published nothing.
 *
 * Outside the passive window (`target.referrer` absent, window closed, or budget spent) the body simply carries no
 * passive field: that is a 主动 message, which the platform accepts under its own frequency quota and refuses with
 * `22009` / `40034100` / `40054002`, classified by `errors.ts`.
 *
 * The reuse above needs `SendOptions.idempotencyKey`: without one, nothing correlates two attempts of the same part,
 * so every attempt books a fresh sequence and a transport failure whose request did reach the platform could publish
 * the content twice. dsh-im's send funnel passes an operation id and the stream drivers a `${key}:resend` id, so
 * the paths that retry are the paths that carry a key.
 *
 * `message_reference` (the `message.quote` capability) is filled from `SendContext.quote` when the serialized body
 * does not already carry one. QQ accepts a `REFIDX_…` / `msg_idx` there, never a `msg_id`; the id an inbound
 * `<quote>` holds *is* that `msg_idx` (the decoder reads it from `message_scene.ext`), so the two match.
 *
 * Recall is the only mutating operation the platform has — there is no message update anywhere, which is why
 * this adapter never installs `editPayload`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/send
 */

import {
  PlatformError, type MessageHandle, type SendContext, type SentPart, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { type QqAddress, type QqMessageRequest, parseChatId } from './api.ts'
import type { QQBot } from './bot.ts'
import { type QQReferrer } from './decode.ts'
import { QqApiError } from './errors.ts'
import { referrerOf, type PassiveTicket } from './passive.ts'

/** Window in which the platform recalls a message : two minutes after the send, for every chat type. */
export const DELETE_WINDOW_MS = 2 * 60 * 1000

/** Platform code of the `(msg_id, msg_seq)` dedupe rejection . */
export const DEDUPE_CODE = 40054005

/**
 * Prefix the message body's `event_id` carries. The gateway reports the interaction as `d.id` (a bare uuid) and
 * `PUT /interactions/{id}` takes it verbatim, but a message that answers the click carries
 * `event_id: INTERACTION_CREATE:<d.id>`: the bare id is refused with `400 40034025 请求参数event_id无效`.
 */
export const EVENT_ID_PREFIX = 'INTERACTION_CREATE:'

/** Platform code of an `event_id` the platform will not take as a message body field. */
export const INVALID_EVENT_ID_CODE = 40034025

/**
 * `event_id` of a click in the form the message body expects.
 *
 * @param id - interaction id of `Target.referrer` (`QQReferrer.event_id`).
 * @returns the id with {@link EVENT_ID_PREFIX}; an id that already carries the prefix passes through, so a referrer
 * built from a stored body stays usable.
 */
export function eventIdOf(id: string): string {
  return id.startsWith(EVENT_ID_PREFIX) ? id : `${EVENT_ID_PREFIX}${id}`
}

/**
 * `SentPart.kind` of one body: the `msg_type` it was sent with.
 *
 * @param msgType - `msg_type` of the request body.
 * @returns `text` (0), `markdown` (2), `media` (7), or `message` for a kind v1 never sends.
 */
export function messageKindOf(msgType: number | undefined) {
  if (msgType === 0) return 'text'
  if (msgType === 2) return 'markdown'
  if (msgType === 7) return 'media'
  return 'message'
}

/**
 * The chat a target addresses.
 *
 * @param bot - the adapter (its `address()` parser).
 * @param target - target chat.
 * @returns the parsed address.
 * @throws PlatformError `invalid` when the target is not a `group:<id>` / `user:<id>` chat, so the pipeline
 * reports a broken target instead of retrying a request that cannot succeed.
 */
function addressOf(bot: QQBot, target: Target): QqAddress {
  try {
    return parseChatId(target.chat.id)
  } catch (error) {
    throw new PlatformError('invalid', `${bot.id}: ${(error as Error).message}`, { published: 'no', cause: error })
  }
}

/**
 * The serialized body of one part, as this stage received it.
 *
 * @param payload - mode payload (`QqMessageRequest`).
 * @returns a shallow copy, so filling in the passive fields never mutates a payload the pipeline may reuse.
 * @throws PlatformError `invalid` for a payload that is not one request body.
 */
function asMessageRequest(payload: unknown): QqMessageRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PlatformError('invalid', 'qq: sendPayload expects one QqMessageRequest body', { published: 'no' })
  }
  return { ...(payload as QqMessageRequest) }
}

/**
 * The idempotency key of one part: `SendOptions.idempotencyKey` plus the part index, so a multi-part message and a
 * retried part are told apart.
 *
 * @param ctx - send context of this part.
 * @returns the key, or `undefined` when the caller supplied none.
 */
function partKey(ctx: SendContext): string | undefined {
  const key = ctx.options.idempotencyKey
  return key === undefined ? undefined : `${key}:${ctx.index}`
}

/**
 * Claim the passive ticket of one part.
 *
 * @param bot - the adapter holding the bookkeeping.
 * @param referrer - the referrer of the target, if any.
 * @param idempotencyKey - per-part key that makes a retry reuse its sequence.
 * @param fresh - book the next sequence even when the key already has one (the `40054005` retry).
 * @returns the ticket, or `undefined` when the part must be sent actively.
 */
function claim(
  bot: QQBot,
  referrer: QQReferrer | undefined,
  idempotencyKey: string | undefined,
  fresh = false,
): PassiveTicket | undefined {
  if (!referrer) return undefined
  if (idempotencyKey === undefined) return bot.passive.claim(referrer)
  return fresh
    ? bot.passive.claim(referrer, { idempotencyKey, fresh: true })
    : bot.passive.claim(referrer, { idempotencyKey })
}

/**
 * Fill the passive fields and the reply reference into one request body.
 *
 * @param body - serialized payload of the part.
 * @param ticket - passive ticket, or `undefined` for an active send.
 * @param quote - `<quote id>` of the message (part 0 only, per the core), i.e. a `msg_idx`/`REFIDX_…`.
 * @returns the request body to post.
 */
function fillRequest(
  body: QqMessageRequest,
  ticket: PassiveTicket | undefined,
  quote: string | undefined,
): QqMessageRequest {
  const request: QqMessageRequest = { ...body }
 // The passive fields belong to this stage: a payload never carries them.
  delete request.msg_id
  delete request.msg_seq
  delete request.event_id
  if (ticket) {
    if (ticket.field === 'event_id') {
 // A click is answered with `event_id`; `msg_seq` is only read together with `msg_id`.
      request.event_id = eventIdOf(ticket.key)
    } else {
      request.msg_id = ticket.key
      request.msg_seq = ticket.seq
    }
  }
  if (quote !== undefined && request.message_reference === undefined) {
    request.message_reference = { message_id: quote, ignore_get_message_error: true }
  }
  return request
}

/** Whether a failure is the platform's `(msg_id, msg_seq)` dedupe answer . */
function isDedupe(error: unknown) {
  return QqApiError.is(error) && error.code === DEDUPE_CODE
}

/** Whether a failure is the platform refusing the `event_id` carried by the body (see {@link EVENT_ID_PREFIX}). */
function isInvalidEventId(error: unknown) {
  return QqApiError.is(error) && error.code === INVALID_EVENT_ID_CODE
}

/**
 * The failure of a retried part whose sequence the platform already accepted: the message exists, its id does not.
 *
 * @param bot - the adapter (for the message).
 * @param ticket - the reused ticket.
 * @param cause - the `40054005` answer.
 * @returns the classified error, `published: 'unknown'` so no caller resends it.
 */
function alreadyPublished(bot: QQBot, ticket: PassiveTicket, cause: unknown) {
  return new PlatformError(
    'invalid',
    `${bot.id}: ${ticket.field} + msg_seq ${ticket.seq} was already accepted by an earlier attempt`
    + ' — the message is published but its id is unknown',
    { code: DEDUPE_CODE, published: 'unknown', cause },
  )
}

/**
 * Publish one serialized payload of a mode, with the passive bookkeeping of.
 *
 * @param bot - the adapter (REST client, passive manager, mode payload contract).
 * @param payload - the mode's `QqMessageRequest` (without the passive fields).
 * @param target - target chat; `target.referrer` enables the passive reply.
 * @param ctx - part index, quote target and send options.
 * @returns the published part: platform message id, `msg_type` kind, send time and the raw answer.
 */
export async function sendMessagePayload(
  bot: QQBot,
  payload: unknown,
  target: Target,
  ctx: SendContext,
): Promise<SentPart> {
  const address = addressOf(bot, target)
  const body = asMessageRequest(payload)
  const idempotencyKey = partKey(ctx)
  const referrer = referrerOf(target)
  let ticket = claim(bot, referrer, idempotencyKey)
  let dedupeRetried = false
  let eventIdFellBack = false
  for (;;) {
    const request = fillRequest(body, ticket, ctx.quote)
    try {
      const answer = await bot.api.sendMessage(address, request, ctx.options.signal)
      const refIdx = answer.ext_info?.ref_idx
      return {
        id: answer.id,
        kind: messageKindOf(request.msg_type),
        time: Date.now(),
        ...refIdx ? { aliases: [refIdx] } : {},
        raw: answer,
      }
    } catch (error) {
 // A click whose event id the platform refuses falls back to one active send: the refusal published nothing, so the
 // reply without the passive field cannot duplicate it.
      if (isInvalidEventId(error) && ticket?.field === 'event_id' && !eventIdFellBack) {
        eventIdFellBack = true
        ticket = undefined
        continue
      }
      if (!isDedupe(error) || dedupeRetried) throw error
      if (ticket?.reused) throw alreadyPublished(bot, ticket, error)
      const next = claim(bot, referrer, idempotencyKey, true)
      if (!next) throw error
      dedupeRetried = true
      ticket = next
    }
  }
}

/**
 * Recall one part of a message. The platform accepts this for two minutes after the send only.
 *
 * @param bot - the adapter (REST client).
 * @param part - the published part to delete.
 * @param handle - the message the part belongs to (its chat is the route).
 * @param now - clock of the window check; tests inject it so the boundary is exact.
 * @throws PlatformError `invalid` when the two-minute window is over, so a caller sees why nothing was recalled;
 * `Bot.delete` treats an unsupported or expired recall as a logged no-op and never throws.
 */
export async function deleteSentPart(
  bot: QQBot,
  part: SentPart,
  handle: MessageHandle,
  now: number = Date.now(),
): Promise<void> {
  const age = now - part.time
  if (age > DELETE_WINDOW_MS) {
    throw new PlatformError(
      'invalid',
      `${bot.id}: message ${part.id} was sent ${Math.round(age / 1000)} s ago; the platform recalls a message only`
      + ' within 2 minutes',
      { published: 'no' },
    )
  }
  await bot.api.deleteMessage(addressOf(bot, handle.target), part.id)
}
