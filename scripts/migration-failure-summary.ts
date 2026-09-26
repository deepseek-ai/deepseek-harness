/** Structured facts extracted from existing migration diagnostics for the batch report. */

import { inspect } from 'node:util'

/** One failure's diagnostic fields; classification never changes migration admission. */
export interface MigrationFailureDiagnostic {
  readonly reason: 'unexpected_member' | 'unknown_event' | 'sequence_gap' | 'source_changed'
    | 'write_locked' | 'unsupported_input' | 'corrupt_log' | 'other'
  readonly errorName: string
  readonly message: string
  readonly eventType?: string
  readonly member?: string
  readonly child?: true
  readonly expectedSeq?: number
  readonly actualSeq?: number
}

/**
 * Classify recognized diagnostic text without inferring its historical cause.
 * @param error - Failure returned by discovery or persistence.
 * @returns Original diagnostic plus any recognized event, field, and sequence facts.
 */
export function classifyMigrationFailure(error: unknown): MigrationFailureDiagnostic {
  const errorName = error instanceof Error ? error.name : 'NonError'
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : inspect(error)
  const base = { errorName, message, ...(/^child Session /u.test(message) ? { child: true as const } : {}) }
  const member = /has unexpected member "([^"]+)"/u.exec(message)?.[1]
  if (member !== undefined) {
    const eventType = /([^\s]+) \d+ data has unexpected member /u.exec(message)?.[1]
    return { ...base, reason: 'unexpected_member', member,
      ...(eventType === undefined ? {} : { eventType }) }
  }
  const eventType = /unknown (?:historical )?event type "([^"]+)"/u.exec(message)?.[1]
  if (eventType !== undefined) return { ...base, reason: 'unknown_event', eventType }
  const gap = /has seq gap \(expected (\d+), got (\d+)\)/u.exec(message)
  if (gap !== null) return { ...base, reason: 'sequence_gap', expectedSeq: Number(gap[1]), actualSeq: Number(gap[2]) }
  const reason = errorName === 'JsonlGenerationSourceChangedError' ? 'source_changed'
    : errorName === 'SessionAlreadyOwnedError' ? 'write_locked'
      : errorName === 'SessionFormatUnsupportedError' ? 'unsupported_input'
        : errorName === 'SessionPersistenceCorruptionError' ? 'corrupt_log'
          : 'other'
  return { ...base, reason }
}
