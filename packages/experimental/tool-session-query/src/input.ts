/**
 * Model argument schemas, normalization, and filter construction.
 *
 * @module @deepseek-ai/dsh-tool-session-query/input
 */

import {
  type SessionEventType,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  SessionQueryError,
  type SessionAvailability,
  type SessionEventMetadataFilter,
  type SessionEventSurface,
  type SessionResultFilter,
} from '@deepseek-ai/dsh-session-query'

interface SessionSearchArgs {
  query: string
  session_ids?: string[]
  created_at_from?: string
  created_at_to?: string
  parent_session_ids?: string[]
  include_root_sessions?: boolean
  availability?: SessionAvailability[]
  event_seq_from?: number
  event_seq_to?: number
  event_time_from?: string
  event_time_to?: string
  event_types?: string[]
  event_surfaces?: SessionEventSurface[]
}

interface EventFilterInput {
  readonly seqFrom?: number | undefined
  readonly seqTo?: number | undefined
  readonly timeFrom?: string | undefined
  readonly timeTo?: string | undefined
  readonly eventTypes?: string[] | undefined
  readonly surfaces?: SessionEventSurface[] | undefined
}

const sessionSearchParameters = {
  query: { type: 'string', required: true, description: 'Literal full-text query over prior session history.' },
  session_ids: { type: 'array', items: { type: 'string' }, description: 'Optional session ids to include.' },
  created_at_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 creation-time lower bound.' },
  created_at_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 creation-time upper bound.' },
  parent_session_ids: { type: 'array', items: { type: 'string' }, description: 'Optional direct parent session ids.' },
  include_root_sessions: { type: 'boolean', description: 'Include sessions with no parent in the parent filter.' },
  availability: {
    type: 'array',
    items: { type: 'string', enum: ['live', 'persisted'] },
    description: 'Require at least one selected source availability.',
  },
  event_seq_from: { type: 'integer', description: 'Inclusive event sequence lower bound.' },
  event_seq_to: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
  event_time_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.' },
  event_time_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.' },
  event_types: { type: 'array', items: { type: 'string' }, description: 'Event types to include.' },
  event_surfaces: {
    type: 'array',
    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
    description: 'Event surfaces to include.',
  },
} as const

const eventSearchParameters = {
  session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
  query: { type: 'string', required: true, description: 'Literal full-text query over the target session.' },
  seq_from: { type: 'integer', description: 'Inclusive event sequence lower bound.' },
  seq_to: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
  time_from: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time lower bound.' },
  time_to: { type: 'string', description: 'Inclusive timezone-qualified ISO 8601 event-time upper bound.' },
  event_types: { type: 'array', items: { type: 'string' }, description: 'Event types to include.' },
  surfaces: {
    type: 'array',
    items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] },
    description: 'Event surfaces to include.',
  },
} as const

const targetSessionParameter = {
  session_id: { type: 'string', description: 'Target session id. Omit for the current session.' },
} as const

function buildSessionFilters(args: SessionSearchArgs): SessionResultFilter[] {
  const filters: SessionResultFilter[] = []
  if (args.session_ids !== undefined) {
    assertNonEmptyArray('session_ids', args.session_ids)
    filters.push({ kind: 'id', values: args.session_ids.map(value => brandString<SessionIdValue>(value)) })
  }
  const created = timestampRange('created_at', args.created_at_from, args.created_at_to)
  if (created !== undefined) filters.push({ kind: 'created-at', ...created })
  if (args.availability !== undefined) {
    assertNonEmptyArray('availability', args.availability)
    filters.push({ kind: 'availability', values: args.availability })
  }
  return filters
}

function materializeParentSessionIds(values: readonly string[] | undefined): SessionIdValue[] | undefined {
  if (values === undefined) return undefined
  assertNonEmptyArray('parent_session_ids', values)
  return [...new Set(values.map(value => brandString<SessionIdValue>(value)))]
}

function buildEventFilters(input: EventFilterInput): SessionEventMetadataFilter[] {
  const filters: SessionEventMetadataFilter[] = []
  const seq = sequenceRange(input.seqFrom, input.seqTo)
  if (seq.from !== undefined || seq.to !== undefined) filters.push({ kind: 'seq', ...seq })
  const time = timestampRange('time', input.timeFrom, input.timeTo)
  if (time !== undefined) filters.push({ kind: 'time', ...time })
  if (input.eventTypes !== undefined) {
    assertNonEmptyArray('event_types', input.eventTypes)
    filters.push({ kind: 'type', values: input.eventTypes as SessionEventType[] })
  }
  if (input.surfaces !== undefined) {
    assertNonEmptyArray('surfaces', input.surfaces)
    filters.push({ kind: 'surface', values: input.surfaces })
  }
  return filters
}

function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length === 0) {
    throw new SessionQueryError(
      'session-search query must contain non-whitespace text',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  if (query.includes('\0')) {
    throw new SessionQueryError(
      'session-search query must not contain NUL',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  return query
}

function sequenceRange(
  from: number | undefined,
  to: number | undefined,
): { from?: number; to?: number } {
  if (from !== undefined) assertNonNegativeSafeInteger('sequence lower bound', from)
  if (to !== undefined) assertNonNegativeSafeInteger('sequence upper bound', to)
  if (from !== undefined && to !== undefined && from > to) {
    throw invalidRange('sequence', 'from must be less than or equal to to')
  }
  return {
    ...from === undefined ? {} : { from },
    ...to === undefined ? {} : { to },
  }
}

function timestampRange(
  name: string,
  from: string | undefined,
  to: string | undefined,
): { from?: number; to?: number } | undefined {
  if (from === undefined && to === undefined) return undefined
  const fromTimestamp = from === undefined ? undefined : parseIsoTimestamp(`${name}_from`, from)
  const toTimestamp = to === undefined ? undefined : parseIsoTimestamp(`${name}_to`, to)
  if (
    fromTimestamp !== undefined
    && toTimestamp !== undefined
    && compareTimestamps(fromTimestamp, toTimestamp) > 0
  ) {
    throw invalidRange(name, 'from must be less than or equal to to')
  }
  return {
    ...fromTimestamp === undefined ? {} : { from: timestampLowerBound(fromTimestamp) },
    ...toTimestamp === undefined ? {} : { to: timestampUpperBound(toTimestamp) },
  }
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/

interface ExactTimestamp {
  readonly millisecond: number
  /** Canonical decimal digits strictly below one millisecond; no trailing zeroes. */
  readonly remainder: string
}

function parseIsoTimestamp(name: string, value: string): ExactTimestamp {
  const match = ISO_TIMESTAMP.exec(value)
  if (match === null) {
    throw invalidRange(name, 'must be an ISO 8601 timestamp with Z or a numeric offset')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? 0)
  const offsetHour = Number(match[10] ?? 0)
  const offsetMinute = Number(match[11] ?? 0)
  if (
    month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) {
    throw invalidRange(name, 'must be a valid ISO 8601 timestamp')
  }
  const fraction = match[7] ?? ''
  const millisecondDigits = fraction.slice(0, 3).padEnd(3, '0')
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`
    + `:${match[6] ?? '00'}.${millisecondDigits}${match[8]}`
  const timestamp = Date.parse(normalized)
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidRange(name, 'must be a valid ISO 8601 timestamp')
  }
  return {
    millisecond: timestamp,
    remainder: fraction.slice(3).replace(/0+$/u, ''),
  }
}

function compareTimestamps(left: ExactTimestamp, right: ExactTimestamp): number {
  if (left.millisecond !== right.millisecond) {
    return left.millisecond < right.millisecond ? -1 : 1
  }
  const length = Math.max(left.remainder.length, right.remainder.length)
  for (let index = 0; index < length; index += 1) {
    const leftDigit = left.remainder[index] ?? '0'
    const rightDigit = right.remainder[index] ?? '0'
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1
  }
  return 0
}

function timestampLowerBound(timestamp: ExactTimestamp): number {
  return timestamp.remainder.length === 0
    ? timestamp.millisecond
    : nextUpFinite(timestamp.millisecond)
}

function timestampUpperBound(timestamp: ExactTimestamp): number {
  return timestamp.remainder.length === 0
    ? timestamp.millisecond
    : nextDownFinite(timestamp.millisecond + 1)
}

function nextUpFinite(value: number): number {
  if (value === 0) return Number.MIN_VALUE
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n)
  return view.getFloat64(0)
}

function nextDownFinite(value: number): number {
  if (value === 0) return -Number.MIN_VALUE
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  view.setBigUint64(0, value > 0 ? bits - 1n : bits + 1n)
  return view.getFloat64(0)
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function invalidRange(name: string, detail: string): SessionQueryError {
  return new SessionQueryError(
    `session ${name} range ${detail}`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionQueryError(
      `${name} must be a non-negative safe integer`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

function assertNonEmptyArray(name: string, values: readonly unknown[]): void {
  if (values.length === 0) {
    throw new SessionQueryError(
      `${name} must contain at least one value when supplied`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

/** Model schemas and model-owned value normalization shared by tool operations. */
export const toolInput = {
  sessionSearchParameters,
  eventSearchParameters,
  targetSessionParameter,
  buildSessionFilters,
  materializeParentSessionIds,
  buildEventFilters,
  normalizeQuery,
  sequenceRange,
  assertNonNegativeSafeInteger,
}
