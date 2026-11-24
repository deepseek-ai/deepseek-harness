/**
 * Inbound event envelopes of the Lark long connection and the referrer contract that travels with them.
 *
 * The long connection delivers one JSON envelope per callback: `{ schema: '2.0', header, event }`, where `header`
 * carries the application identity and the event id and `event` is the family-specific body. This module owns the
 * envelope (validation of the fields every family needs) and the *wire* shapes of the admitted families; the element
 * decoding of a message body belongs to `decode.ts`.
 *
 * ## Referrer contract
 *
 * `InboundMessage.referrer`, `ButtonEvent.referrer` and `SelectEvent.referrer` are a {@link LarkReferrer}: everything
 * a reply needs without re-reading the event — the chat and its kind, the message the reply answers or the card that
 * was interacted with, the thread the message belongs to, and when this process saw the event.
 * {@link readLarkReferrer} is the narrowing guard for a `Target.referrer: unknown`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/api/events
 */

/** A decoded JSON object of a wire body. */
export type LarkWireObject = Record<string, unknown>

/**
 * Event families of the platform that this adapter knows about. The four message families are admitted when they
 * arrive; `card.action.trigger` needs `config.callbacks`.
 */
export type LarkEventType =
  | 'im.message.receive_v1'
  | 'im.message.recalled_v1'
  | 'im.message.reaction.created_v1'
  | 'im.message.reaction.deleted_v1'
  | 'card.action.trigger'

/** Identity fields every event header carries. */
export interface LarkEventHeader<K extends LarkEventType = LarkEventType> {
  /** Event family; the `event_type` of the wire header. */
  event_type: K
  /** Platform event id: the intake dedupe key (a redelivery reuses it, `message_id` does not). */
  event_id: string
  /** Application the event belongs to; must match `config.appId`. */
  app_id: string
  /** RFC3339 creation time of the event (not of the message). */
  create_time?: string
  /** Verification token of the subscription; unused over the long connection. */
  token?: string
  /** Tenant of the application. */
  tenant_key?: string
}

/** A user identity as the platform names it anywhere in an event. */
export interface LarkUserIds {
  union_id?: string
  /** Only present when the app holds the contact scope. */
  user_id?: string
  open_id?: string
}

/** `im.message.receive_v1`. */
export interface LarkMessageReceivedEvent {
  sender?: {
    sender_id?: LarkUserIds
    /** `user` or `app`. */
    sender_type?: string
    tenant_key?: string
  }
  message?: {
    message_id?: string
    root_id?: string
    parent_id?: string
    thread_id?: string
    create_time?: string
    chat_id?: string
    /** `p2p`, `group` or `topic`. */
    chat_type?: string
    /** `text`, `post`, `image`, `file`, `audio`, `media`, `interactive`, `merge_forward`, `sticker` … */
    message_type?: string
    /** JSON (or, for `merge_forward`, a plain title) of the message body. */
    content?: string
    mentions?: {
      key?: string
      id?: LarkUserIds
      name?: string
      tenant_key?: string
    }[]
  }
}

/** `im.message.recalled_v1`. */
export interface LarkMessageRecalledEvent {
  chat_id?: string
  message_id?: string
  recall_time?: string
  recall_type?: string
}

/** `im.message.reaction.created_v1` / `deleted_v1`. */
export interface LarkReactionChangedEvent {
  message_id?: string
  chat_id?: string
  chat_type?: string
  reaction_type?: { emoji_type?: string }
  operator_type?: 'user' | 'app' | number
  operator?: { operator_id?: LarkUserIds }
  user_id?: LarkUserIds
  app_id?: string
  action_time?: string
}

/** One action of `card.action.trigger`. */
export interface LarkCardAction {
  /** `button`, `select_static`, … */
  tag?: string
  /** The callback value the card carried: `{ v4: { id, data } }` for an action button. */
  value?: unknown
  /** Component name of a form control. */
  name?: string
  /** Submitted form values, keyed by component name. */
  form_value?: unknown
  /** Free text of an input component. */
  input_value?: string
  /** Chosen option of a select component. */
  option?: string
  /** Chosen options of a multi-select component. */
  options?: string[]
  checked?: boolean
  timezone?: string
}

/** `card.action.trigger`. */
export interface LarkCardActionEvent {
  operator?: {
    tenant_key?: string
    user_id?: string
    union_id?: string
    open_id?: string
  }
  token?: string
  action?: LarkCardAction
  host?: string
  /** `url_preview` for a link-preview card. */
  delivery_type?: 'url_preview'
  context?: {
    url?: string
    preview_token?: string
    /** The card message that was interacted with. */
    open_message_id?: string
    /** The chat the card is in. */
    open_chat_id?: string
  }
}

/** Body of each admitted family, keyed by event type. */
export interface LarkEventMap {
  'im.message.receive_v1': LarkMessageReceivedEvent
  'im.message.recalled_v1': LarkMessageRecalledEvent
  'im.message.reaction.created_v1': LarkReactionChangedEvent
  'im.message.reaction.deleted_v1': LarkReactionChangedEvent
  'card.action.trigger': LarkCardActionEvent
}

/**
 * What a submit callback reports for one `<form>`: each control's value keyed by its component `name`. A checkbox
 * reports a boolean, a multiple select an array, every other control a string.
 *
 * @param value - the wire `action.form_value`.
 * @returns the values, or `undefined` when the event carries none.
 */
export function cardFormValues(value: unknown): Record<string, string | string[] | boolean> | undefined {
  if (!isDict(value)) return
  const out: Record<string, string | string[] | boolean> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'boolean') out[name] = entry
    else if (typeof entry === 'number') out[name] = String(entry)
    else if (Array.isArray(entry)) out[name] = entry.filter((item): item is string => typeof item === 'string')
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Option values one select callback reports: `options` for a multiple control, `option` for a single one.
 *
 * @param action - the wire `action` of a `card.action.trigger`.
 * @returns the chosen option values, in the platform's order; empty when the callback carried none.
 */
export function cardOptionValues(action: LarkCardAction): string[] {
  const many = arrayOf(action.options).filter((item): item is string => typeof item === 'string')
  if (many.length) return many
  const single = nonEmpty(action.option)
  return single ? [single] : []
}

/**
 * One event envelope whose *envelope* fields are validated and whose body is still the raw wire object. The family
 * reader of the body (`decode.ts` for messages, {@link ../ws.ts} for card callbacks) validates it further.
 */
export interface LarkRawEvent {
  schema: '2.0'
  header: LarkEventHeader
  event: LarkWireObject
}

/** One event envelope of a given family, body validated. */
export interface LarkEventEnvelope<K extends LarkEventType = LarkEventType> {
  schema: '2.0'
  header: LarkEventHeader<K>
  event: LarkEventMap[K]
}

/** One validated event envelope, of any admitted family. */
export type LarkEventPayload = { [K in LarkEventType]: LarkEventEnvelope<K> }[LarkEventType]

// ---------------------------------------------------------------------------------------------------------------
// Referrer (the adapter-private half of `Target.referrer`)

/** Chat kind of an inbound event, mirroring `ChatRef.type`. */
export type LarkChatKind = 'group' | 'topic' | 'direct'

/** What a reply needs from the event it answers. */
export interface LarkReferrer {
  /** Outer event id (`header.event_id`): the dedupe key and the card-callback identity. */
  event_id?: string
  /** When this process decoded the event (ms); the platform time is `InboundMessage.time`. */
  receivedAt: number
  /** Chat kind, mirroring `ChatRef.type`. */
  chatType: LarkChatKind
  /** `ChatRef.id` of the chat (a Lark `chat_id`). */
  chatId: string
  /**
   * The message a reply answers: the clicked card's message for a button, the quoted parent for a reply.
   * `sendPayload` replies to it instead of creating a message.
   */
  messageId?: string
  /** Thread the message belongs to; a reply must then set `reply_in_thread`. */
  threadId?: string
  /** Root of the thread, when the event carried one. */
  rootId?: string
}

/**
 * Narrow an adapter-private `Target.referrer` back to a {@link LarkReferrer}.
 *
 * @param value - anything a caller received as `referrer` (normally `unknown`).
 * @returns the referrer, or `undefined` when it is not one of ours.
 */
export function readLarkReferrer(value: unknown): LarkReferrer | undefined {
  if (!isDict(value)) return
  const receivedAt = typeof value.receivedAt === 'number' ? value.receivedAt : undefined
  const chatType = value.chatType
  const chatId = nonEmpty(value.chatId)
  if (receivedAt === undefined || chatId === undefined) return
  if (chatType !== 'group' && chatType !== 'topic' && chatType !== 'direct') return
  const referrer: LarkReferrer = { receivedAt, chatType, chatId }
  const eventId = nonEmpty(value.event_id)
  if (eventId) referrer.event_id = eventId
  const messageId = nonEmpty(value.messageId)
  if (messageId) referrer.messageId = messageId
  const threadId = nonEmpty(value.threadId)
  if (threadId) referrer.threadId = threadId
  const rootId = nonEmpty(value.rootId)
  if (rootId) referrer.rootId = rootId
  return referrer
}

// ---------------------------------------------------------------------------------------------------------------
// Envelope parsing

/**
 * Validate the envelope every family shares.
 *
 * @param value - the JSON body of one long-connection frame.
 * @returns the envelope, with the body kept as its raw wire object.
 * @throws TypeError when the body is not a schema-2.0 event envelope.
 */
export function parseEventEnvelope(value: unknown): LarkRawEvent {
  const body = isDict(value) ? value : undefined
  if (body?.schema !== '2.0') throw new TypeError('Invalid Lark event envelope')
  const header = isDict(body.header) ? body.header : undefined
  if (!header) throw new TypeError('Invalid Lark event header')
  const parsedHeader: LarkEventHeader = {
    event_type: requiredString(header.event_type, 'event type') as LarkEventType,
    event_id: requiredString(header.event_id, 'event ID'),
    app_id: requiredString(header.app_id, 'application ID'),
  }
  const createTime = nonEmpty(header.create_time)
  if (createTime) parsedHeader.create_time = createTime
  const token = nonEmpty(header.token)
  if (token) parsedHeader.token = token
  const tenantKey = nonEmpty(header.tenant_key)
  if (tenantKey) parsedHeader.tenant_key = tenantKey
  // The family-specific body stays raw: an event family this adapter does not decode must still reach the ACK path,
  // so the envelope never rejects on its body shape.
  return { schema: '2.0', header: parsedHeader, event: isDict(body.event) ? body.event : {} }
}

// ---------------------------------------------------------------------------------------------------------------
// Wire helpers

const SECOND = 1000

/**
 * Parse an event timestamp into epoch milliseconds.
 *
 * Lark sends RFC3339 strings for event/message times and epoch **seconds** for a few lifecycle fields, so numeric
 * input is read as seconds below 1e11 (no millisecond epoch of this product is that small).
 *
 * @param value - the wire value.
 * @param fallback - used when the value is missing or unparseable.
 * @returns epoch milliseconds.
 */
export function decodeTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e11 ? value * SECOND : value
  }
  if (typeof value !== 'string' || !value.trim()) return fallback
  const time = Date.parse(value.trim())
  return Number.isFinite(time) ? time : fallback
}

/** Whether a value is a plain JSON object. */
export function isDict(value: unknown): value is LarkWireObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty string, or `undefined`. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A required non-empty string. */
export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new TypeError(`Invalid Lark ${field}`)
  return value
}

/** An array, or an empty one. */
export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
