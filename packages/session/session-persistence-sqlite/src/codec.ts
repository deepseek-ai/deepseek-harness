/** SQLite stores logical Session headers and events without JSONL row encoding. @module */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { SESSION_FORMAT_VERSION, SessionId, KNOWN_SESSION_EVENT_TYPES, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/** SQLite's logical format version; a new Session version requires an explicit storage migration. */
export const SQLITE_SESSION_FORMAT_VERSION = 4 satisfies typeof SESSION_FORMAT_VERSION

const header = z.object({
  version: z.literal(SQLITE_SESSION_FORMAT_VERSION),
  id: z.string().transform(SessionId),
  createdAt: z.number().int().nonnegative(),
  isSeeded: z.boolean(),
  cwd: z.string().refine(isAbsolute).optional(),
  parentSession: z.string().transform(SessionId).optional(),
  origin: z.literal('subagent').optional(),
  delegationDepth: z.number().int().nonnegative().default(0),
  agentPreset: z.string().optional(),
}).strict()
const event = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number().int(),
  data: z.unknown().refine(value => value !== undefined),
  ignorable: z.literal(true).optional(),
  sourceEventSeqs: z.array(z.number().int().nonnegative()).optional(),
  surfaceOp: z.union([z.literal('append'), z.object({
    op: z.literal('replace'), startSeq: z.number().int().nonnegative(), endSeq: z.number().int().nonnegative(),
  }).strict()]).optional(),
}).strict()

/**
 * Read current logical Session metadata from a stored JSON object.
 * @param value - untrusted SQLite header parsed from JSON.
 * @returns validated metadata with an explicit delegation depth.
 */
export function decodeHeader(value: unknown): SessionHeader {
  const { cwd, parentSession, origin, agentPreset, ...metadata } = header.parse(value)
  return { ...metadata,
    ...cwd === undefined ? {} : { cwd },
    ...parentSession === undefined ? {} : { parentSession },
    ...origin === undefined ? {} : { origin },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

/**
 * Preserve the existing seeded/cut checks before reserving or importing a Session.
 * @param metadata - detached creation or import header.
 * @param inheritedEventCount - exact inherited prefix, required for seeded Sessions.
 * @returns normalized logical metadata for SQLite JSON storage.
 */
export function materializeHeader(metadata: SessionHeader, inheritedEventCount?: SessionLogOffset): SessionHeader {
  if (metadata.isSeeded && inheritedEventCount === undefined) throw new Error('seeded session header requires an inherited event count')
  const cut = SessionLogOffset(inheritedEventCount ?? 0)
  if (!metadata.isSeeded && cut !== 0) throw new Error('unseeded session header inherited event count must be 0')
  return decodeHeader(metadata)
}

/**
 * Read a logical event envelope; native payload validation remains in Session adoption.
 * Source coordinates stay as arrays and are never decoded from JSONL ranges.
 * @param value - untrusted SQLite event parsed from JSON.
 * @returns logical event for vocabulary validation and Session adoption.
 */
export function decodeEvent(value: unknown): SessionFormatEvent & SessionEvent {
  assertV4RowAdmission(value, KNOWN_SESSION_EVENT_TYPES)
  return event.parse(value) as SessionFormatEvent & SessionEvent
}
