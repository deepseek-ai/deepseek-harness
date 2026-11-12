/** SQLite storage metadata and event-envelope validation. @module */
import { SESSION_FORMAT_VERSION, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { decodeReleasedV4Event } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** SQLite's supported logical format; a writer version bump fails compilation until storage migration is implemented. */
export const SQLITE_SESSION_FORMAT_VERSION = 4 satisfies typeof SESSION_FORMAT_VERSION

/**
 * Decode a SQLite header through the current physical catalog, accepting existing logical header rows.
 * @param value - untrusted stored header.
 * @returns current logical Session metadata with an explicit delegation depth.
 */
export function decodeHeader(value: unknown): SessionHeader {
  const physical = typeof value === 'object' && value !== null && !Array.isArray(value)
    && !('type' in value) ? { type: 'session', delegationDepth: 0, ...value } : value
  const result = sessionFormatCatalog.readHeader(physical)
  if (result.status === 'migration-required') throw new Error('SQLite Session requires a format migration')
  if (result.status === 'malformed' || result.status === 'unsupported') throw new Error(result.reason)
  const { parentSession, ...header } = result.header
  return { ...header, version: SQLITE_SESSION_FORMAT_VERSION, id: SessionId(header.id),
    ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession) } }
}
/**
 * Decode a physical event and validate its sequence; the released codec owns the other envelope fields.
 * Session restoration still validates payloads and relationships before returning stored events.
 * @param value - untrusted SQLite event payload parsed from JSON.
 * @returns decoded event for Session validation and adoption.
 */
export function decodeEvent(value: unknown): SessionFormatEvent & SessionEvent {
  const event = decodeReleasedV4Event(value, KNOWN_SESSION_EVENT_TYPES)
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new TypeError('SQLite event seq must be a non-negative safe integer')
  const data: unknown = event.data
  if (data === undefined) throw new TypeError('SQLite event data must be defined')
  return event as SessionFormatEvent & SessionEvent
}
