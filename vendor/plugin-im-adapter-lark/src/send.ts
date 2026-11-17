/**
 * The network stage of the Lark / Feishu adapter: `sendPayload`, `editPayload` and `deletePart`.
 *
 * The modes serialize an exact request body of one platform message — `{ msg_type, content }` with `content` as an
 * **object** (`postRequestBody()` / `cardRequestBody()` JSON-encode it) — and this stage owns everything the API needs
 * on top of it:
 *
 * ## `sendPayload`: create vs reply vs reply in a thread
 *
 * - Reply (`POST /im/v1/messages/{message_id}/reply`) when the message answers another one: `SendContext.quote` (the
 *   `<quote id>` of the tree, part 0 only), an explicit thread id (`Target.thread: string`, answered against a matching
 *   referrer, the previous part's thread root, or the platform's first message in that thread), or — when the caller
 *   asked for the referrer's thread (`Target.thread === true`) or the referrer itself is threaded — the referrer's
 *   message. A topic-mode group puts every message in a thread, so a message that was created instead of replied would
 *   land outside the topic.
 * - `reply_in_thread` is set in that case: an explicit `Target.thread` requests it and a threaded referrer requires
 *   it, or the reply would leave the thread it answers.
 * - Otherwise create (`POST /im/v1/messages?receive_id_type=…`). `receive_id_type` is read from the chat id
 *   ({@link receiveIdTypeOf}): a Lark `ChatRef.id` is a `chat_id` (`oc_…`) for both group and p2p chats, but a caller
 *   may also address a user directly, so an `ou_…` / `on_…` id is sent as an `open_id` / `union_id`.
 * - `uuid` (deduplicated by the platform for one hour) is `sha256(<idempotencyKey>#<part index>)[0..32]`, via
 *   `idempotencyUuid`. It is per part, because one logical message may be several platform messages and the core
 *   retries `sendPayload` on `retryable`/`rate-limit` failures; without an idempotency key the caller accepted that a
 *   retried part may publish twice.
 *
 * ## `editPayload`: the kind is decided by the new payload
 *
 * The platform picks the edit route from the message type being written, not from the message being replaced: text
 * and post go through `PUT /im/v1/messages/{message_id}` (≤ 20 edits, admin window) and a card through
 * `PATCH /im/v1/messages/{message_id}` (14 days, `update_multi: true`). An image, file, audio or video message has no
 * edit route at all and is reported `invalid`.
 *
 * `SentPart.kind` records the kind of the part as it was published (`post`, `text`, `card-inline`, `image`, `file`,
 * `audio`, `media`; {@link partKindOf}).
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/send
 */

import {
  PlatformError, type MessageHandle, type SendContext, type SentPart, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { isDict, type LarkChatKind, type LarkReferrer } from './api/events.ts'
import type { LarkReceiveIdType } from './api/client.ts'
import type { LarkBot } from './bot.ts'
import { idempotencyUuid } from './modes/shared.ts'

/** One serialized platform message as this stage receives it. */
export interface LarkPayload {
  /** `msg_type` of the request: `post`, `interactive`, `text`, `image`, `file`, `audio` or `media`. */
  msg_type: string
  /** The platform `content` **object**; the wire body carries `JSON.stringify(content)`. */
  content: Record<string, unknown>
}

/** Kinds a part may be published as. */
export type LarkPartKind =
  | 'post' | 'text' | 'card-inline' | 'image' | 'file' | 'audio' | 'media' | 'message'

/** Whether a message is answered with the reply route, and whether that reply must join a thread. */
export interface LarkReplyPlan {
  /** Message the reply answers; absent when no anchor is known yet (create, or resolve `threadId` first). */
  messageId?: string
  /** Explicit thread id that still needs platform anchor lookup or quote-thread verification before sending. */
  threadId?: string
  /** Set `reply_in_thread`: an explicit thread was requested or the answered message lives in one. */
  inThread: boolean
}

/**
 * The `receive_id_type` of a target: a Lark chat id of either chat type is a `chat_id`; a bare user id is sent
 * as the identity it names. A decoded inbound chat carries the `chat_id` of the conversation even when it is a p2p
 * chat, so `chat_id` is the default.
 *
 * @param target - target chat.
 * @returns `chat_id` (default), `open_id` for an `ou_…` id or `union_id` for an `on_…` id.
 */
export function receiveIdTypeOf(target: Target): LarkReceiveIdType {
  const id = target.chat.id
  if (id.startsWith('ou_')) return 'open_id'
  if (id.startsWith('on_')) return 'union_id'
  return 'chat_id'
}

/** Whether a decoded referrer already proves membership in the requested thread. */
function referrerMatchesThread(referrer: LarkReferrer | undefined, threadId: string): referrer is LarkReferrer {
  return referrer !== undefined
    && (referrer.threadId === threadId || referrer.rootId === threadId || referrer.messageId === threadId)
}

/**
 * Decide between creating a message and replying to one, and whether the reply joins a thread.
 *
 * @param bot - the adapter (its `referrerOf` narrowing).
 * @param target - target chat, its `thread` request and its referrer.
 * @param ctx - send context of this part (`quote` is the `<quote id>`, present on part 0 only).
 * @returns the reply target and the thread verdict.
 * @throws PlatformError `invalid` (`published: 'no'`) when an explicit thread id cannot address a thread of `target.chat`.
 */
export function replyPlan(bot: LarkBot, target: Target, ctx: SendContext): LarkReplyPlan {
  const rawReferrer = bot.referrerOf(target)
  const referrer = rawReferrer?.chatId === target.chat.id ? rawReferrer : undefined
  if (typeof target.thread === 'string') {
    const threadId = target.thread.trim()
    if (!threadId) {
      throw new PlatformError('invalid', `${bot.id}: thread id must not be empty`, { published: 'no' })
    }
    if (receiveIdTypeOf(target) !== 'chat_id') {
      throw new PlatformError('invalid', `${bot.id}: cannot publish to thread ${threadId} outside a chat`, { published: 'no' })
    }
    if (ctx.quote !== undefined) {
      if (referrer?.messageId === ctx.quote && referrerMatchesThread(referrer, threadId)) {
        return { messageId: ctx.quote, inThread: true }
      }
      return { messageId: ctx.quote, threadId, inThread: true }
    }
    if (referrerMatchesThread(referrer, threadId)) {
      const anchor = referrer.rootId ?? referrer.messageId
      if (anchor !== undefined) return { messageId: anchor, inThread: true }
    }
    const first = ctx.previous[0]
    if (first !== undefined) {
      const raw = isDict(first.raw) ? first.raw : undefined
      const rootId = typeof raw?.root_id === 'string' && raw.root_id.length > 0 ? raw.root_id : undefined
      return { messageId: rootId ?? first.id, inThread: true }
    }
    return { threadId, inThread: true }
  }
  const wantsThread = target.thread === true
  const threaded = referrer?.threadId !== undefined
  // Without a quote the message still answers its referrer when it has to stay in that message's thread.
  const messageId = ctx.quote ?? (wantsThread || threaded ? referrer?.messageId : undefined)
  if (messageId === undefined) return { inThread: false }
  return { messageId, inThread: wantsThread || threaded }
}

/**
 * The `SentPart.kind` of one payload: the handle kind for the text-ish messages, the `msg_type` for media.
 *
 * @param payload - the serialized payload.
 * @returns the kind recorded in `SentPart.kind`.
 */
export function partKindOf(payload: LarkPayload): LarkPartKind {
  switch (payload.msg_type) {
    case 'post': return 'post'
    case 'text': return 'text'
    case 'interactive': return 'card-inline'
    case 'image': return 'image'
    case 'file': return 'file'
    case 'audio': return 'audio'
    case 'media': return 'media'
    default: return 'message'
  }
}

/**
 * Narrow a mode payload to one request body.
 *
 * @param payload - whatever the mode serialized.
 * @returns `{ msg_type, content }` with `content` as the platform object.
 * @throws PlatformError `invalid` for a payload this adapter cannot send.
 */
function asPayload(payload: unknown): LarkPayload {
  if (!isDict(payload)) {
    throw new PlatformError('invalid', 'lark: sendPayload expects one { msg_type, content } request body', { published: 'no' })
  }
  const msgType = payload.msg_type
  if (typeof msgType !== 'string' || !msgType) {
    throw new PlatformError('invalid', 'lark: the payload carries no msg_type', { published: 'no' })
  }
  const content = payload.content
  if (!isDict(content)) {
    throw new PlatformError('invalid', `lark: the ${msgType} payload carries no content object`, { published: 'no' })
  }
  return { msg_type: msgType, content }
}

/** The wire body of one payload: `content` as the JSON string the API expects. */
function requestBody(payload: LarkPayload): { msg_type: string, content: string } {
  return { msg_type: payload.msg_type, content: JSON.stringify(payload.content) }
}

/**
 * The per-part `uuid`: `sha256(<idempotencyKey>#<part index>)[0..32]`.
 *
 * @param ctx - send context of this part.
 * @returns the uuid, or `undefined` when the caller supplied no idempotency key.
 */
function partUuid(ctx: SendContext): string | undefined {
  const key = ctx.options.idempotencyKey
  return key === undefined ? undefined : idempotencyUuid(key, ctx.index)
}

/** Classify a pre-send read failure as unpublished so anchor resolution never reports an uncertain publication. */
async function unpublishedRead<T>(bot: LarkBot, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const classified = PlatformError.is(error) ? error : bot.classify(error)
    if (classified.published === 'no') throw classified
    throw new PlatformError(classified.kind, classified.message, {
      ...classified.code === undefined ? {} : { code: classified.code },
      ...classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs },
      published: 'no',
      cause: classified.cause ?? error,
    })
  }
}

/**
 * Resolve the platform message id a reply answers, looking up or verifying an explicit `Target.thread` when the target
 * carried no matching referrer.
 */
async function resolveReplyMessageId(
  bot: LarkBot,
  target: Target,
  plan: LarkReplyPlan,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const { threadId } = plan
  if (threadId === undefined) return plan.messageId
  if (plan.messageId !== undefined) {
    const quotedId = plan.messageId
    const items = await unpublishedRead(bot, () => bot.api.getMessage(quotedId, {}, signal))
    const item = items.find(entry => entry.message_id === quotedId)
    if (!item || item.chat_id !== target.chat.id) {
      throw new PlatformError(
        'invalid',
        `${bot.id}: quoted message ${quotedId} is absent from chat ${target.chat.id}`,
        { published: 'no' },
      )
    }
    if (item.thread_id !== threadId && item.root_id !== threadId && item.message_id !== threadId) {
      throw new PlatformError(
        'invalid',
        `${bot.id}: quoted message ${quotedId} does not belong to thread ${threadId}`,
        { published: 'no' },
      )
    }
    return quotedId
  }
  if (threadId.startsWith('om_')) {
    const items = await unpublishedRead(bot, () => bot.api.getMessage(threadId, {}, signal))
    const root = items.find(entry => entry.message_id === threadId)
    if (!root || root.chat_id !== target.chat.id) {
      throw new PlatformError(
        'invalid',
        `${bot.id}: thread root ${threadId} is absent from chat ${target.chat.id}`,
        { published: 'no' },
      )
    }
    return threadId
  }
  const page = await unpublishedRead(
    bot,
    () => bot.api.listMessages({
      container_id_type: 'thread',
      container_id: threadId,
      sort_type: 'ByCreateTimeAsc',
      page_size: 1,
    }, signal),
  )
  const anchor = page.items?.find(entry => typeof entry.message_id === 'string' && entry.message_id.length > 0)
  if (!anchor?.message_id || anchor.chat_id !== target.chat.id) {
    throw new PlatformError(
      'invalid',
      `${bot.id}: thread ${threadId} has no anchor message in chat ${target.chat.id}`,
      { published: 'no' },
    )
  }
  return anchor.message_id
}

/**
 * Publish one serialized payload: create, reply, or reply inside a thread.
 *
 * @param bot - the adapter (its REST client and referrer contract).
 * @param payload - the mode's `{ msg_type, content }` body.
 * @param target - target chat, its thread request and its referrer.
 * @param ctx - part index, quote target and send options.
 * @returns the published part: platform message id, the kind it was published as, send time and the raw answer.
 * @throws PlatformError `invalid` when the platform answered without a message id (the message may exist, so
 * `published: 'unknown'`) so no caller treats a half answer as a published message.
 */
export async function sendMessagePayload(
  bot: LarkBot,
  payload: unknown,
  target: Target,
  ctx: SendContext,
): Promise<SentPart> {
  const request = asPayload(payload)
  const body = requestBody(request)
  const uuid = partUuid(ctx)
  const plan = replyPlan(bot, target, ctx)
  const signal = ctx.options.signal
  const replyMessageId = await resolveReplyMessageId(bot, target, plan, signal)
  const answer = replyMessageId === undefined
    ? await bot.api.createMessage(receiveIdTypeOf(target), {
      ...body,
      receive_id: target.chat.id,
      ...uuid === undefined ? {} : { uuid },
    }, signal)
    : await bot.api.replyMessage(replyMessageId, {
      ...body,
      ...uuid === undefined ? {} : { uuid },
      ...plan.inThread ? { reply_in_thread: true } : {},
    }, signal)
  const id = answer.message_id
  if (!id) {
    throw new PlatformError('invalid', `${bot.id}: the platform answered the send without a message id`, {
      published: 'unknown',
    })
  }
  const time = Date.now()
  const chatType: LarkChatKind = target.chat.type
  const referrer: LarkReferrer = {
    receivedAt: time,
    chatType,
    chatId: target.chat.id,
    messageId: id,
    ...answer.thread_id ? { threadId: answer.thread_id } : {},
    ...answer.root_id ? { rootId: answer.root_id } : {},
  }
  return {
    id,
    kind: partKindOf(request),
    time,
    ...answer.thread_id ? { thread: { id: answer.thread_id, ...answer.root_id ? { root: answer.root_id } : {} } } : {},
    referrer,
    raw: answer,
  }
}

/**
 * Edit one part in place: `PUT` for a post or text message, `PATCH` for a card.
 *
 * @param bot - the adapter (its REST client).
 * @param part - the published part to edit (its id is the message id).
 * @param payload - the new payload of the part; its `msg_type` selects the route.
 * @param _handle - the message the part belongs to; no route needs it.
 * @throws PlatformError `invalid` for a message kind the platform cannot edit (image, file, audio, video).
 */
export async function editMessagePayload(
  bot: LarkBot,
  part: SentPart,
  payload: unknown,
  _handle: MessageHandle,
  signal?: AbortSignal,
): Promise<void> {
  const request = asPayload(payload)
  switch (request.msg_type) {
    case 'post':
    case 'text':
      await bot.api.updateMessage(part.id, requestBody(request), signal)
      return
    case 'interactive':
      // The whole card JSON travels as the `content` string; the message keeps its identity and its place in the chat.
      await bot.api.patchMessage(part.id, { content: JSON.stringify(request.content) }, signal)
      return
    default:
      throw new PlatformError(
        'invalid',
        `${bot.id}: the platform edits text, post and card messages only, not ${request.msg_type} (message ${part.id})`,
        { published: 'no' },
      )
  }
}

/**
 * Recall one part (`DELETE /im/v1/messages/{message_id}`).
 *
 * The platform deletes by message id alone — the chat plays no part in the route — so the handle is only there for
 * the signature every adapter's `deletePart` shares.
 *
 * @param bot - the adapter (its REST client).
 * @param part - the published part to delete.
 * @param _handle - the message the part belongs to.
 */
export async function deleteSentPart(bot: LarkBot, part: SentPart, _handle: MessageHandle): Promise<void> {
  await bot.api.deleteMessage(part.id)
}
