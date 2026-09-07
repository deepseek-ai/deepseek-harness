import {
  SessionFormatError,
  sessionFormatCount,
  sessionFormatSafeInteger,
  snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifactDecoder,
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
  SessionFormatRecovery,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header } from './validation.ts'

const HEADER_REQUIRED = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const
const HEADER_OPTIONAL = ['cwd', 'parentSession', 'origin', 'agentPreset'] as const
const EVENT_REQUIRED = ['type', 'seq', 'time', 'data'] as const
const EVENT_OPTIONAL = ['ignorable', 'sourceEventSeqs', 'surfaceOp'] as const
const EVENT_KEYS: ReadonlySet<string> = new Set([...EVENT_REQUIRED, ...EVENT_OPTIONAL])
/** Frozen physical JSON codec for released v2. */
export const releasedV2SessionFormatCodec = Object.freeze({
  version: 2,
  decodeHeader(value: unknown) {
    return decodePhysicalHeader(value)
  },
  createDecoder(headerValue: unknown, recovery: SessionFormatRecovery) {
    return createDecoder(headerValue, recovery)
  },
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number) {
    return encodeHeader(header, inheritedEventCount)
  },
  encodeEvent(event: SessionFormatEvent) {
    return encodeProvenance(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

function decodePhysicalHeader(value: unknown): SessionFormatHeader {
  const snapshot = snapshotSessionFormatJson(value, 'released v2 physical header')
  const record = jsonRecord(snapshot, 'released v2 physical header')
  exactKeys(record, HEADER_REQUIRED, HEADER_OPTIONAL, 'released v2 physical header')
  if (record['type'] !== 'session' || record['version'] !== 2) {
    throw new SessionFormatError('expected released v2 physical Session header')
  }
  if (typeof record['id'] !== 'string') throw new SessionFormatError('released v2 header id must be a string')
  const createdAt = sessionFormatCount(record['createdAt'], 'released v2 header createdAt')
  const delegationDepth = sessionFormatCount(record['delegationDepth'], 'released v2 header delegationDepth')
  if (typeof record['isSeeded'] !== 'boolean') throw new SessionFormatError('released v2 header isSeeded must be boolean')
  for (const key of ['cwd', 'parentSession', 'agentPreset'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new SessionFormatError(`released v2 header ${key} must be a string`)
    }
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    throw new SessionFormatError('released v2 header origin must be "subagent"')
  }
  const header = snapshotSessionFormatJson({
    version: 2,
    id: record['id'],
    createdAt,
    ...(record['cwd'] === undefined ? {} : { cwd: record['cwd'] }),
    ...(record['parentSession'] === undefined ? {} : { parentSession: record['parentSession'] }),
    isSeeded: record['isSeeded'],
    ...(record['origin'] === undefined ? {} : { origin: record['origin'] }),
    delegationDepth,
    ...(record['agentPreset'] === undefined ? {} : { agentPreset: record['agentPreset'] }),
  }, 'released v2 logical header') as SessionFormatHeader
  assertReleasedV2Header(header)
  return header
}

function createDecoder(
  headerValue: unknown,
  recovery: SessionFormatRecovery,
): SessionFormatArtifactDecoder {
  const header = decodePhysicalHeader(headerValue)
  let rowIndex = 0
  let eventCount = 0
  let inheritedEventCount: number | undefined
  let issue: SessionFormatError | undefined
  return {
    header,
    decodeRow(value, context) {
      const currentRow = rowIndex
      rowIndex += 1
      let event: SessionFormatEvent
      try {
        event = decodeEvent(value, currentRow)
      } catch (error: unknown) {
        const current = error instanceof SessionFormatError
          ? error
          : new SessionFormatError(`released v2 row ${currentRow} is malformed`, { cause: error })
        if (recovery === 'strict') throw current
        issue ??= current
        return
      }
      if (issue !== undefined) {
        if (event.type === 'turn/end') throw issue
        return
      }
      if (event.seq !== eventCount) {
        const gap = new SessionFormatError(
          `released v2 row ${currentRow} has seq gap (expected ${eventCount}, got ${event.seq})`,
        )
        if (recovery === 'strict') throw gap
        issue = gap
        if (event.type === 'turn/end') throw issue
        return
      }
      eventCount += 1
      if (event.type === 'session/end-seed') {
        const data = jsonRecord(event.data, `session/end-seed ${event.seq} data`)
        if (data['inherited'] === true) inheritedEventCount = event.seq
      }
      context.emitEvent(event)
    },
    finish(_context) {
      if (header.isSeeded && inheritedEventCount === undefined) {
        throw new SessionFormatError('released v2 seeded Session lacks an inherited end-seed marker')
      }
      if (!header.isSeeded && inheritedEventCount !== undefined) {
        throw new SessionFormatError('released v2 unseeded Session contains an inherited end-seed marker')
      }
      return inheritedEventCount ?? 0
    },
  }
}

function decodeEvent(value: unknown, rowIndex: number): SessionFormatEvent {
  const record = jsonRecord(value as SessionFormatJsonValue, `released v2 row ${rowIndex}`)
  const missing = EVENT_REQUIRED.find(key => !Object.hasOwn(record, key))
  if (missing !== undefined) throw new SessionFormatError(`released v2 row ${rowIndex} lacks required field ${missing}`)
  const unexpected = Object.keys(record).find(key => !EVENT_KEYS.has(key))
  if (unexpected !== undefined) {
    throw new SessionFormatError(`released v2 row ${rowIndex} has unexpected field ${unexpected}`)
  }
  if (typeof record['type'] !== 'string') {
    throw new SessionFormatError(`released v2 row ${rowIndex} type must be a string`)
  }
  sessionFormatSafeInteger(record['time'], `released v2 row ${rowIndex} time`)
  if (record['ignorable'] !== undefined && record['ignorable'] !== true) {
    throw new SessionFormatError(`released v2 row ${rowIndex} ignorable must be true when present`)
  }
  if (record['sourceEventSeqs'] === undefined) return record as unknown as SessionFormatEvent
  const seq = sessionFormatCount(record['seq'], `released v2 row ${rowIndex} seq`)
  return {
    ...record,
    sourceEventSeqs: decodeSeqRanges(record['sourceEventSeqs'], seq),
  } as unknown as SessionFormatEvent
}

function encodeHeader(
  header: SessionFormatHeader,
  inheritedEventCount: number,
): SessionFormatJsonObject {
  assertReleasedV2Header(header)
  const cut = sessionFormatCount(inheritedEventCount, 'format v2 inherited event count')
  if (!header.isSeeded && cut !== 0) {
    throw new SessionFormatError('unseeded format v2 Session has inherited events')
  }
  return {
    type: 'session',
    version: 2,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    isSeeded: header.isSeeded,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

function encodeProvenance(event: SessionFormatEvent): SessionFormatJsonObject {
  if (event.sourceEventSeqs === undefined) return event
  return {
    ...event,
    sourceEventSeqs: encodeSeqRanges(event.sourceEventSeqs as readonly number[]),
  }
}

function decodeSeqRanges(value: SessionFormatJsonValue, maxEntries: number): readonly number[] {
  if (!Array.isArray(value)) throw new SessionFormatError('sourceEventSeqs must be an array')
  const output: number[] = []
  let hasRange = false
  for (const entry of value) {
    if (!Array.isArray(entry)) {
      output.push(sessionFormatCount(entry, 'sourceEventSeqs member'))
      continue
    }
    if (entry.length !== 2) throw new SessionFormatError('sourceEventSeqs range must be a [start, end] pair')
    const start = sessionFormatCount(entry[0], 'sourceEventSeqs range start')
    const end = sessionFormatCount(entry[1], 'sourceEventSeqs range end')
    if (start > end || end >= maxEntries || end - start + 1 > maxEntries - output.length) {
      throw new SessionFormatError('sourceEventSeqs range exceeds its event seq')
    }
    for (let current = start; current <= end; current += 1) output.push(current)
    hasRange = true
  }
  const seen = new Set<number>()
  for (const source of output) {
    if (source >= maxEntries || seen.has(source)) {
      throw new SessionFormatError('sourceEventSeqs ranges must contain unique earlier seqs')
    }
    seen.add(source)
  }
  if (hasRange && output.some((source, index) => index > 0 && source <= (output[index - 1] as number))) {
    throw new SessionFormatError('sourceEventSeqs ranges must be strictly increasing')
  }
  return output
}

function encodeSeqRanges(values: readonly number[]): readonly SessionFormatJsonValue[] {
  if (values.some((value, index) => index > 0 && value <= (values[index - 1] as number))) return [...values]
  const output: SessionFormatJsonValue[] = []
  for (let index = 0; index < values.length;) {
    const start = values[index] as number
    let end = start
    while (index + 1 < values.length && values[index + 1] === end + 1) {
      index += 1
      end += 1
    }
    output.push(end - start >= 2 ? [start, end] : start)
    if (end - start === 1) output.push(end)
    index += 1
  }
  return output
}

function jsonRecord(value: SessionFormatJsonValue | undefined, label: string): SessionFormatJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionFormatError(`${label} must be an object`)
  }
  return value as SessionFormatJsonObject
}

function exactKeys(
  record: SessionFormatJsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const missing = required.find(key => !Object.hasOwn(record, key))
  if (missing !== undefined) throw new SessionFormatError(`${label} lacks ${missing}`)
  const unexpected = Object.keys(record).find(key => !allowed.has(key))
  if (unexpected !== undefined) throw new SessionFormatError(`${label} has unexpected field ${unexpected}`)
}
