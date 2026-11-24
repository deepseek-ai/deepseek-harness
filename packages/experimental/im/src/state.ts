/**
 * Durable state of the message store. Sessions (`sessions.ts`) and send receipts (`send.ts`) own their own storage
 * domains.
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ImChatKey, ImMessage, ImMessageKey, ImOutcome } from './api.ts'

/** Platform event dedupe record, keyed `${botId}|${eventId}`. */
export interface StoredEvent {
  /** sha256 of the canonical inbound payload; a redelivery whose payload differs from it is logged, and this one stands. */
  digest: string
  /** Message stored for the event; absent when the event was not admitted. */
  message?: ImMessageKey
  receivedAt: number
}

/** Stored message with its dispatch state, keyed by {@link ImMessageKey}. */
export interface StoredMessage {
  /** JSON form of the message (content is the element tree as plain objects). */
  message: ImMessage
  /** Inbound messages awaiting the `im/message` waterfall; own outbound messages are never dispatched. */
  dispatch: 'pending' | 'done' | 'none'
  outcome?: ImOutcome
  storedAt: number
}

/** Per-chat counter and identity, keyed by {@link ImChatKey}. */
export interface StoredChat {
  key: ImChatKey
  bot: string
  ref: { id: string; type: 'direct' | 'group' | 'topic'; name?: string }
  source: string
  /** Last assigned seq. */
  seq: number
  updatedAt: number
}

/**
 * Stored text of a chat key: the medium keeps the `${botId}|${chatId}` identity rather than its compile-time brand, so
 * a read re-applies the brand to the text it just validated.
 */
export const storedChatKey = z.string().transform((value): ImChatKey => value as ImChatKey)
/** Stored text of a message key (`${botId}|${messageId}`): the brand is re-applied at the read boundary. */
export const storedMessageKey = z.string().transform((value): ImMessageKey => value as ImMessageKey)
/** Stored text of a session id: re-branded at the read boundary like the two keys above. */
export const storedSessionId = z.string().transform((value): SessionId => value as SessionId)

/**
 * Whether a stored value is a plain object (what every record of these tables is read as).
 * @param value - a value read back from the medium.
 * @returns true for a non-null, non-array object.
 */
export function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a stored value has the plain-object shape of one stored message: the identities and the element tree of an
 * {@link ImMessage}, kept as the JSON the store wrote.
 * @param value - a value read back from the medium.
 * @returns true when the identities and element tree of a stored message are present.
 */
export function isStoredMessage(value: unknown): value is ImMessage {
  if (!isStoredRecord(value)) return false
  return typeof value.key === 'string' && typeof value.seq === 'number' && typeof value.text === 'string'
    && isStoredRecord(value.chat) && typeof value.chat.key === 'string' && isStoredRecord(value.sender)
    && value.content !== undefined
}

/** Whether a stored value is one recorded dispatch outcome. */
function isStoredOutcome(value: unknown): value is ImOutcome {
  if (!isStoredRecord(value)) return false
  if (value.kind === 'handled') {
    return typeof value.by === 'string' && (value.sessions === undefined || Array.isArray(value.sessions))
  }
  return value.kind === 'ignored' && (value.reason === undefined || typeof value.reason === 'string')
}

const eventSchema = z.object({
  digest: z.string(), message: z.exactOptional(storedMessageKey), receivedAt: z.number(),
})
const messageSchema = z.object({
  message: z.custom<ImMessage>(isStoredMessage, { message: 'stored message is not an IM message' }),
  dispatch: z.enum(['pending', 'done', 'none']),
  outcome: z.exactOptional(z.custom<ImOutcome>(isStoredOutcome, {
    message: 'stored dispatch outcome is malformed',
  })),
  storedAt: z.number(),
})
const chatSchema = z.object({
  key: storedChatKey, bot: z.string(),
  ref: z.object({ id: z.string(), type: z.enum(['direct', 'group', 'topic']), name: z.exactOptional(z.string()) }),
  source: z.string(), seq: z.number().int().nonnegative(), updatedAt: z.number(),
})

/**
 * The `im_messages` storage domain: events, messages, chats.
 */
export const imDomain = defineDomain({
  name: 'im_messages', version: 1,
  tables: {
    events: domainTable<string, StoredEvent>(eventSchema),
    messages: domainTable<ImMessageKey, StoredMessage>(messageSchema),
    chats: domainTable<ImChatKey, StoredChat>(chatSchema),
  },
})

/** Open message-store domain. */
export type ImDomain = Domain<typeof imDomain>
