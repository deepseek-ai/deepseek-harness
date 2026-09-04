import {
  SessionFormatError,
  isSessionFormatJsonObject,
  sessionFormatCount,
  sessionFormatSafeInteger,
  snapshotSessionFormatArtifact,
  snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  EncodedSessionFormatArtifact,
  SessionFormatArtifact,
  SessionFormatCodec,
  SessionFormatEncodeOptions,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedSessionFormatHeader,
  assertReleasedV0SourceArtifact,
  assertReleasedV1PhysicalArtifact,
} from './validation.ts'
import { assertReleasedV0Keys, releasedV0Record } from './validation-helpers.ts'

const PHYSICAL_HEADER_REQUIRED = ['type', 'version', 'id', 'createdAt', 'delegationDepth'] as const
const PHYSICAL_HEADER_OPTIONAL = ['cwd', 'parentSession', 'seedLength', 'origin', 'agentPreset'] as const
const PACKED_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** Frozen physical JSON codec for the released v0 layout. */
export const releasedV0SessionFormatCodec = createReleasedCodec(0)

/** Frozen physical JSON codec for the shared-layout released v1 format. */
export const releasedV1SessionFormatCodec = createReleasedCodec(1)

function createReleasedCodec(version: 0 | 1) {
  return Object.freeze({
    version,
    decodeHeader: (value: unknown) => decodeHeader(value, version),
    decodeArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
      const physical = decodePhysicalHeader(headerValue, version)
      const artifact = snapshotSessionFormatArtifact({
        header: physical.header,
        inheritedEventCount: physical.inheritedEventCount,
        events: scanRows(rowValues, false).events,
      }, `released v${version} artifact`)
      if (version === 0) assertReleasedV0SourceArtifact(artifact)
      else assertReleasedV1PhysicalArtifact(artifact)
      return artifact
    },
    decodeRecoverableArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
      const physical = decodePhysicalHeader(headerValue, version)
      const recovered = scanRows(rowValues, true)
      const artifact = snapshotSessionFormatArtifact({
        header: physical.header,
        inheritedEventCount: physical.inheritedEventCount,
        events: recovered.events,
      }, `released v${version} recoverable artifact`)
      if (version === 0) assertReleasedV0SourceArtifact(artifact)
      else assertReleasedV1PhysicalArtifact(artifact)
      return artifact
    },
    encodeArtifact(artifact: SessionFormatArtifact, options: SessionFormatEncodeOptions) {
      if (version === 0) assertReleasedV0SourceArtifact(artifact)
      else assertReleasedV1PhysicalArtifact(artifact)
      return encodeArtifact(artifact, options, version)
    },
  } satisfies SessionFormatCodec & {
    encodeArtifact(
      artifact: SessionFormatArtifact,
      options: SessionFormatEncodeOptions,
    ): EncodedSessionFormatArtifact
  })
}

function decodeHeader(value: unknown, version: 0 | 1): SessionFormatHeader {
  return decodePhysicalHeader(value, version).header
}

function decodePhysicalHeader(
  value: unknown,
  version: 0 | 1,
): { header: SessionFormatHeader; inheritedEventCount: number } {
  const source = snapshotSessionFormatJson(value, `released v${version} physical header`)
  const record = releasedV0Record(source, `released v${version} physical header`)
  assertReleasedV0Keys(
    record,
    PHYSICAL_HEADER_REQUIRED,
    PHYSICAL_HEADER_OPTIONAL,
    `released v${version} physical header`,
  )
  if (record['type'] !== 'session' || record['version'] !== version) {
    throw new SessionFormatError(`expected released v${version} physical Session header`)
  }
  if (typeof record['id'] !== 'string') throw new SessionFormatError(`released v${version} header id must be a string`)
  const createdAt = sessionFormatCount(record['createdAt'], `released v${version} header createdAt`)
  const delegationDepth = sessionFormatCount(
    record['delegationDepth'],
    `released v${version} header delegationDepth`,
  )
  const seedLength = record['seedLength'] === undefined
    ? 0
    : sessionFormatCount(record['seedLength'], `released v${version} header seedLength`)
  for (const key of ['cwd', 'parentSession', 'agentPreset'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new SessionFormatError(`released v${version} header ${key} must be a string`)
    }
  }
  if (record['origin'] !== undefined && record['origin'] !== 'subagent') {
    throw new SessionFormatError(`released v${version} header origin must be "subagent"`)
  }
  const header = snapshotSessionFormatJson({
    version,
    id: record['id'],
    createdAt,
    ...(record['cwd'] === undefined ? {} : { cwd: record['cwd'] }),
    ...(record['parentSession'] === undefined ? {} : { parentSession: record['parentSession'] }),
    isSeeded: record['seedLength'] !== undefined,
    ...(record['origin'] === undefined ? {} : { origin: record['origin'] }),
    delegationDepth,
    ...(record['agentPreset'] === undefined ? {} : { agentPreset: record['agentPreset'] }),
  }, `released v${version} logical header`) as SessionFormatHeader
  assertReleasedSessionFormatHeader(header, version)
  return { header, inheritedEventCount: seedLength }
}

function encodeArtifact(
  artifact: SessionFormatArtifact,
  options: SessionFormatEncodeOptions,
  version: 0 | 1,
): EncodedSessionFormatArtifact {
  const header = artifact.header
  const physicalHeader = snapshotSessionFormatJson({
    type: 'session',
    version,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.isSeeded ? { seedLength: artifact.inheritedEventCount } : {}),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }, `released v${version} encoded header`) as SessionFormatJsonObject
  const records = options.packChunks ? packChunkRuns(artifact.events) : [...artifact.events]
  const rows = Object.freeze(records.map(record => encodeProvenance(record)))
  return Object.freeze({ header: physicalHeader, rows })
}

function scanRows(
  rowValues: readonly unknown[],
  recoverable: boolean,
): { readonly events: readonly SessionFormatEvent[] } {
  const events: SessionFormatEvent[] = []
  let issue: SessionFormatError | undefined
  for (const [rowIndex, value] of rowValues.entries()) {
    let decoded: readonly SessionFormatEvent[]
    try {
      const row = snapshotSessionFormatJson(value, `released Session row ${rowIndex}`)
      decoded = decodeRow(row, rowIndex)
    } catch (error: unknown) {
      const current = error instanceof SessionFormatError
        ? error
        : new SessionFormatError(`released Session row ${rowIndex} is malformed`, { cause: error })
      if (!recoverable) throw current
      issue ??= current
      continue
    }
    if (issue !== undefined) {
      if (decoded.some(event => event.type === 'turn/end')) throw issue
      continue
    }
    const rowStart = events.length
    for (const event of decoded) {
      if (event.seq !== events.length) {
        const gap = new SessionFormatError(
          `released Session row ${rowIndex} has seq gap (expected ${events.length}, got ${event.seq})`,
        )
        events.length = rowStart
        if (!recoverable) throw gap
        issue = gap
        break
      }
      events.push(event)
    }
    if (issue !== undefined) {
      if (decoded.some(event => event.type === 'turn/end')) throw issue
      continue
    }
  }
  return Object.freeze({ events: Object.freeze(events) })
}

function decodeRow(value: SessionFormatJsonValue, rowIndex: number): readonly SessionFormatEvent[] {
  const record = releasedV0Record(value, `released Session row ${rowIndex}`)
  const type = record['type']
  if (typeof type === 'string' && PACKED_TAGS.has(type)) return expandPackedRow(record, type, rowIndex)
  if (record['sourceEventSeqs'] !== undefined) {
    const seq = sessionFormatCount(record['seq'], `released Session row ${rowIndex} seq`)
    return Object.freeze([{
      ...record,
      sourceEventSeqs: decodeSeqRanges(record['sourceEventSeqs'], seq),
    } as unknown as SessionFormatEvent])
  }
  return Object.freeze([record as unknown as SessionFormatEvent])
}

function expandPackedRow(
  row: Record<string, SessionFormatJsonValue>,
  type: string,
  rowIndex: number,
): readonly SessionFormatEvent[] {
  const label = `released ${type} row ${rowIndex}`
  assertReleasedV0Keys(row, ['type', 'seq0', 'time0', 'data'], [], label)
  const seq0 = sessionFormatCount(row['seq0'], `${label} seq0`)
  let time = sessionFormatSafeInteger(row['time0'], `${label} time0`)
  const data = releasedV0Record(row['data'], `${label} data`)
  const isTool = type === 'tool-call-chunks'
  assertReleasedV0Keys(
    data,
    isTool ? ['turn', 'step', 'index', 'id', 'dt', 'args'] : ['turn', 'step', 'index', 'dt', 'texts'],
    isTool ? ['name'] : [],
    `${label} data`,
  )
  const payload = data[isTool ? 'args' : 'texts']
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(member => typeof member !== 'string')) {
    throw new SessionFormatError(`${label} payload must be a non-empty string array`)
  }
  const gaps = data['dt']
  if (!Array.isArray(gaps) || gaps.length !== payload.length - 1) {
    throw new SessionFormatError(`${label} dt length must match its payload`)
  }
  for (const gap of gaps) sessionFormatSafeInteger(gap, `${label} dt member`)
  if (typeof data['turn'] !== 'number' || typeof data['step'] !== 'number' || typeof data['index'] !== 'number') {
    throw new SessionFormatError(`${label} turn, step, and index must be numbers`)
  }
  if (isTool && (typeof data['id'] !== 'string'
    || (data['name'] !== undefined && typeof data['name'] !== 'string'))) {
    throw new SessionFormatError(`${label} id and optional name must be strings`)
  }
  const output: SessionFormatEvent[] = []
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time = sessionFormatSafeInteger(time + (gaps[index - 1] as number), `${label} member time`)
    const member = payload[index] as string
    const chunk = type === 'text-chunks'
      ? { type: 'text-delta', index: data['index'], text: member }
      : type === 'reasoning-chunks'
        ? { type: 'reasoning-delta', index: data['index'], text: member }
        : {
          type: 'tool-call-delta',
          index: data['index'],
          id: data['id'],
          ...(data['name'] === undefined ? {} : { name: data['name'] }),
          argumentsDelta: member,
        }
    output.push(snapshotSessionFormatJson({
      type: 'assistant/chunk',
      seq: sessionFormatCount(seq0 + index, `${label} member seq`),
      time,
      data: { turn: data['turn'], step: data['step'], chunk },
    }, `${label} member`) as SessionFormatEvent)
  }
  return Object.freeze(output)
}

function decodeSeqRanges(value: SessionFormatJsonValue, maxEntries: number): readonly SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError('sourceEventSeqs must be an array')
  const output: number[] = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') {
      if (output.length >= maxEntries) throw new SessionFormatError('sourceEventSeqs exceeds its event seq')
      output.push(sessionFormatCount(entry, 'sourceEventSeqs member'))
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new SessionFormatError('sourceEventSeqs range must be a [start, end] pair')
    }
    const start = sessionFormatCount(entry[0], 'sourceEventSeqs range start')
    const end = sessionFormatCount(entry[1], 'sourceEventSeqs range end')
    if (end < start || end - start + 1 > maxEntries - output.length) {
      throw new SessionFormatError('sourceEventSeqs range exceeds its event seq')
    }
    for (let seq = start; seq <= end; seq += 1) output.push(seq)
    hasRange = true
  }
  if (hasRange && output.some((member, index) => index > 0 && member <= (output[index - 1] as number))) {
    throw new SessionFormatError('sourceEventSeqs ranges must be strictly increasing')
  }
  return Object.freeze(output)
}

function encodeProvenance(record: SessionFormatEvent | SessionFormatJsonObject): SessionFormatJsonObject {
  if (!Object.hasOwn(record, 'sourceEventSeqs')) return record
  const sourceEventSeqs = record['sourceEventSeqs'] as readonly SessionFormatJsonValue[]
  const values = sourceEventSeqs.map(value => sessionFormatCount(value, 'sourceEventSeqs member'))
  return snapshotSessionFormatJson({ ...record, sourceEventSeqs: encodeSeqRanges(values) }) as SessionFormatJsonObject
}

function encodeSeqRanges(values: readonly number[]): readonly SessionFormatJsonValue[] {
  if (values.some((value, index) => index > 0 && value <= (values[index - 1] as number))) return Object.freeze([...values])
  const output: SessionFormatJsonValue[] = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === (values[end] as number) + 1) end += 1
    if (end - start >= 2) output.push(Object.freeze([values[start] as number, values[end] as number]))
    else for (let index = start; index <= end; index += 1) output.push(values[index] as number)
    start = end + 1
  }
  return Object.freeze(output)
}

type ChunkKind = 'text-delta' | 'reasoning-delta' | 'tool-call-delta'

function packChunkRuns(events: readonly SessionFormatEvent[]): readonly (SessionFormatEvent | SessionFormatJsonObject)[] {
  const output: Array<SessionFormatEvent | SessionFormatJsonObject> = []
  let kind: ChunkKind | undefined
  let run: SessionFormatEvent[] = []
  const flush = (): void => {
    if (kind !== undefined && run.length >= 3) output.push(buildPackedRow(kind, run))
    else output.push(...run)
    kind = undefined
    run = []
  }
  for (const event of events) {
    const candidate = classifyChunk(event)
    const previous = run.at(-1)
    if (candidate !== undefined && candidate === kind && previous !== undefined && continuesChunk(previous, event, candidate)) {
      run.push(event)
      continue
    }
    flush()
    if (candidate === undefined) output.push(event)
    else {
      kind = candidate
      run = [event]
    }
  }
  flush()
  return Object.freeze(output)
}

function classifyChunk(event: SessionFormatEvent): ChunkKind | undefined {
  if (event.type !== 'assistant/chunk' || !hasExactKeys(event, ['type', 'seq', 'time', 'data'])) return undefined
  const data = event.data
  if (!isSessionFormatJsonObject(data) || !hasExactKeys(data, ['turn', 'step', 'chunk'])) return undefined
  const chunk = data['chunk']
  if (!isSessionFormatJsonObject(chunk)
    || typeof chunk['index'] !== 'number'
    || typeof chunk['type'] !== 'string') return undefined
  if (chunk['type'] === 'text-delta' || chunk['type'] === 'reasoning-delta') {
    return hasExactKeys(chunk, ['type', 'index', 'text']) && typeof chunk['text'] === 'string'
      ? chunk['type']
      : undefined
  }
  if (chunk['type'] !== 'tool-call-delta') return undefined
  const exact = hasExactKeys(chunk, ['type', 'index', 'id', 'argumentsDelta'])
    || hasExactKeys(chunk, ['type', 'index', 'id', 'name', 'argumentsDelta'])
  return exact && typeof chunk['id'] === 'string'
    && typeof chunk['argumentsDelta'] === 'string'
    && (chunk['name'] === undefined || typeof chunk['name'] === 'string')
    ? 'tool-call-delta'
    : undefined
}

function continuesChunk(previous: SessionFormatEvent, next: SessionFormatEvent, kind: ChunkKind): boolean {
  const previousData = previous.data as SessionFormatJsonObject
  const nextData = next.data as SessionFormatJsonObject
  const previousChunk = previousData['chunk'] as SessionFormatJsonObject
  const nextChunk = nextData['chunk'] as SessionFormatJsonObject
  if (!Number.isSafeInteger(next.time - previous.time)) return false
  if (nextData['turn'] !== previousData['turn'] || nextData['step'] !== previousData['step']) return false
  if (nextChunk['index'] !== previousChunk['index']) return false
  if (kind !== 'tool-call-delta') return true
  return nextChunk['id'] === previousChunk['id']
    && Object.hasOwn(nextChunk, 'name') === Object.hasOwn(previousChunk, 'name')
    && nextChunk['name'] === previousChunk['name']
}

function buildPackedRow(kind: ChunkKind, run: readonly SessionFormatEvent[]): SessionFormatJsonObject {
  const first = run[0] as SessionFormatEvent
  const firstData = first.data as SessionFormatJsonObject
  const firstChunk = firstData['chunk'] as SessionFormatJsonObject
  const base = {
    turn: firstData['turn'],
    step: firstData['step'],
    index: firstChunk['index'],
    dt: run.slice(1).map((event, index) => event.time - (run[index] as SessionFormatEvent).time),
  }
  if (kind === 'tool-call-delta') {
    return snapshotSessionFormatJson({
      type: 'tool-call-chunks',
      seq0: first.seq,
      time0: first.time,
      data: {
        ...base,
        id: firstChunk['id'],
        ...(firstChunk['name'] === undefined ? {} : { name: firstChunk['name'] }),
        args: run.map(event => ((event.data as SessionFormatJsonObject)['chunk'] as SessionFormatJsonObject)['argumentsDelta']),
      },
    }) as SessionFormatJsonObject
  }
  return snapshotSessionFormatJson({
    type: kind === 'text-delta' ? 'text-chunks' : 'reasoning-chunks',
    seq0: first.seq,
    time0: first.time,
    data: {
      ...base,
      texts: run.map(event => ((event.data as SessionFormatJsonObject)['chunk'] as SessionFormatJsonObject)['text']),
    },
  }) as SessionFormatJsonObject
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))
}
