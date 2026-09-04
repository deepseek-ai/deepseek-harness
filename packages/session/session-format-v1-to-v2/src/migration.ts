import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import {
  SessionFormatUnsupportedMigrationError,
  defineSessionFormatMigration,
  snapshotSessionFormatArtifact,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import {
  RELEASED_V0_EVENT_DISPOSITIONS,
  assertReleasedV1Artifact,
  assertReleasedV1Header,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { assertReleasedV2Artifact, assertReleasedV2Header } from './validation.ts'

interface AttemptGroup {
  readonly turn: number
  readonly step: number
  readonly chunks: SessionFormatEvent[]
  terminal: boolean
  messageSeq?: number
}

interface StagedEvent {
  readonly origin: number
  readonly event: SessionFormatEvent
}

/** Adjacent migration that embeds released-v1 top-level Assistant chunks into v2 attempt events. */
export const sessionFormatV1ToV2 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v1-to-v2',
  fromVersion: 1,
  toVersion: 2,
  migrateHeader(header) {
    assertReleasedV1Header(header)
    return { ...header, version: 2 }
  },
  migrate(source) {
    assertReleasedV1Artifact(source)
    const unknown = source.events.find(event => RELEASED_V0_EVENT_DISPOSITIONS[event.type] === undefined)
    if (unknown !== undefined) {
      throw refusal(`format v1 contains unknown event type ${JSON.stringify(unknown.type)} at seq ${unknown.seq}`)
    }
    const groups = collectAttemptGroups(source.events)
    const groupByChunk = new Map<number, AttemptGroup>()
    const groupByMessage = new Map<number, AttemptGroup>()
    for (const group of groups) {
      for (const chunk of group.chunks) groupByChunk.set(chunk.seq, group)
      if (group.messageSeq !== undefined) groupByMessage.set(group.messageSeq, group)
    }

    const staged: StagedEvent[] = []
    const oldToNew = new Map<number, number>()
    for (const sourceEvent of source.events) {
      const group = groupByChunk.get(sourceEvent.seq)
      if (group !== undefined) {
        if (group.messageSeq === undefined && sourceEvent.seq === group.chunks.at(-1)?.seq) {
          stage(staged, oldToNew, sourceEvent.seq, attemptEvent(group))
        }
        continue
      }
      const messageGroup = groupByMessage.get(sourceEvent.seq)
      if (messageGroup !== undefined) {
        stage(staged, oldToNew, sourceEvent.seq, messageEvent(sourceEvent, messageGroup))
        continue
      }
      const event = source.header.isSeeded
        && sourceEvent.seq === source.inheritedEventCount
        && sourceEvent.type === 'session/end-seed'
        ? { ...sourceEvent, data: { inherited: true } }
        : sourceEvent
      stage(staged, oldToNew, sourceEvent.seq, event)
    }

    const inheritedEventCount = remapInheritedCut(source, groups, staged)
    if (source.header.isSeeded && source.events[source.inheritedEventCount]?.type !== 'session/end-seed') {
      const next = source.events[source.inheritedEventCount]
      const previous = source.events[source.inheritedEventCount - 1]
      staged.splice(inheritedEventCount, 0, {
        origin: -1,
        event: {
          type: 'session/end-seed',
          seq: inheritedEventCount,
          time: next?.time ?? previous?.time ?? source.header.createdAt,
          data: { inherited: true },
        },
      })
      oldToNew.clear()
      for (const [seq, candidate] of staged.entries()) {
        if (candidate.origin >= 0) oldToNew.set(candidate.origin, seq)
      }
    }
    for (const group of groups) {
      for (const chunk of group.chunks) oldToNew.delete(chunk.seq)
    }

    const target = snapshotSessionFormatArtifact({
      header: { ...source.header, version: 2 },
      inheritedEventCount,
      events: staged.map(({ event }, seq) => remapReferences(event, seq, oldToNew)),
    }, 'released v1-to-v2 target')
    assertReleasedV2Artifact(target)
    return target
  },
  validateTarget: assertReleasedV2Artifact,
  validateTargetHeader: assertReleasedV2Header,
})

function collectAttemptGroups(events: readonly SessionFormatEvent[]): readonly AttemptGroup[] {
  const groups: AttemptGroup[] = []
  const current = new Map<string, AttemptGroup>()
  for (const event of events) {
    if (event.type === 'assistant/chunk') {
      const data = record(event.data)
      const turn = coordinate(data['turn'])
      const step = coordinate(data['step'])
      const key = `${turn}:${step}`
      let group = current.get(key)
      if (group === undefined || group.terminal) {
        group = { turn, step, chunks: [], terminal: false }
        groups.push(group)
        current.set(key, group)
      }
      group.chunks.push(event)
      const chunk = record(data['chunk'])
      if (chunk['type'] === 'finish') group.terminal = true
      continue
    }
    if (event.type !== 'assistant/message') {
      closeAttemptAtBoundary(event, current)
      continue
    }
    const data = record(event.data)
    const turn = coordinate(data['turn'])
    const step = coordinate(data['step'])
    const sources = event.sourceEventSeqs
    if (!Array.isArray(sources)) {
      const unclaimed = groups.some(candidate => candidate.messageSeq === undefined
        && candidate.turn === turn
        && candidate.step === step)
      if (unclaimed) throw refusal(`assistant/message ${event.seq} does not cite its complete v1 chunk attempt`)
      groups.push({ turn, step, chunks: [], terminal: true, messageSeq: event.seq })
      continue
    }
    if (sources.length === 0) {
      // Released v1 uses an explicit empty list to state that this message
      // owns no preceding chunks; an absent list cannot make that claim.
      groups.push({ turn, step, chunks: [], terminal: true, messageSeq: event.seq })
      continue
    }
    const group = groups.find(candidate => candidate.messageSeq === undefined
      && candidate.turn === turn
      && candidate.step === step
      && sameNumbers(candidate.chunks.map(chunk => chunk.seq), sources))
    if (group === undefined) {
      throw refusal(`assistant/message ${event.seq} chunk provenance is not one complete ordered attempt`)
    }
    group.messageSeq = event.seq
    group.terminal = true
  }
  return groups
}

function closeAttemptAtBoundary(
  event: SessionFormatEvent,
  current: ReadonlyMap<string, AttemptGroup>,
): void {
  if (event.type === 'turn/end') {
    const data = record(event.data)
    const turn = coordinate(data['turn'])
    for (const group of current.values()) {
      if (group.turn === turn) group.terminal = true
    }
    return
  }
  if (event.type !== 'step/end'
    && event.type !== 'llm/retry'
    && event.type !== 'llm/retry-started') return
  const data = record(event.data)
  const turn = coordinate(data['turn'])
  const step = coordinate(data['step'])
  const group = current.get(`${turn}:${step}`)
  if (group !== undefined) group.terminal = true
}

function streamOf(group: AttemptGroup) {
  const accumulator = new AssistantStreamAccumulator()
  for (const event of group.chunks) {
    const data = record(event.data)
    accumulator.push({
      time: event.time,
      chunk: data['chunk'] as Parameters<AssistantStreamAccumulator['push']>[0]['chunk'],
    })
  }
  return accumulator.snapshot() as unknown as SessionFormatJsonValue
}

function messageEvent(source: SessionFormatEvent, group: AttemptGroup): SessionFormatEvent {
  const data = record(source.data)
  const { sourceEventSeqs: _sourceEventSeqs, ...event } = source
  return {
    ...event,
    data: { ...data, stream: streamOf(group) },
  }
}

function attemptEvent(group: AttemptGroup): SessionFormatEvent {
  const last = group.chunks.at(-1) as SessionFormatEvent
  return {
    type: 'assistant/attempt',
    seq: last.seq,
    time: last.time,
    data: { turn: group.turn, step: group.step, stream: streamOf(group) },
  }
}

function stage(
  staged: StagedEvent[],
  oldToNew: Map<number, number>,
  origin: number,
  event: SessionFormatEvent,
): void {
  oldToNew.set(origin, staged.length)
  staged.push({ origin, event })
}

function remapInheritedCut(
  source: SessionFormatArtifact,
  groups: readonly AttemptGroup[],
  staged: readonly StagedEvent[],
): number {
  const cut = source.inheritedEventCount
  for (const group of groups) {
    const members = group.messageSeq === undefined
      ? group.chunks.map(chunk => chunk.seq)
      : [...group.chunks.map(chunk => chunk.seq), group.messageSeq]
    const before = members.some(seq => seq < cut)
    const after = members.some(seq => seq >= cut)
    if (before && after) throw refusal(`inherited Session cut ${cut} splits one Assistant attempt`)
  }
  return staged.filter(candidate => candidate.origin < cut).length
}

function remapReferences(
  source: SessionFormatEvent,
  targetSeq: number,
  mapping: ReadonlyMap<number, number>,
): SessionFormatEvent {
  const { sourceEventSeqs, surfaceOp, ...event } = source
  const sources = sourceEventSeqs === undefined
    ? {}
    : {
      sourceEventSeqs: mapList(
        numberArray(sourceEventSeqs),
        mapping,
        `${source.type} ${source.seq} sources`,
      ),
    }
  let operation: SessionFormatJsonValue | undefined = surfaceOp
  if (surfaceOp !== undefined && surfaceOp !== 'append') {
    const replacement = record(surfaceOp)
    operation = {
      op: 'replace',
      start: mapOne(
        coordinate(replacement['start']),
        mapping,
        `${source.type} ${source.seq} surface start`,
      ),
      end: mapOne(
        coordinate(replacement['end']),
        mapping,
        `${source.type} ${source.seq} surface end`,
      ),
    }
  }
  return {
    ...event,
    seq: targetSeq,
    data: remapPayloadReferences(source, mapping),
    ...sources,
    ...(operation === undefined ? {} : { surfaceOp: operation }),
  }
}

function remapPayloadReferences(
  event: SessionFormatEvent,
  mapping: ReadonlyMap<number, number>,
): SessionFormatJsonValue {
  const data = record(event.data)
  switch (event.type) {
    case 'command/done':
      return data['sourceEventSeq'] === undefined
        ? data
        : {
          ...data,
          sourceEventSeq: mapOne(
            coordinate(data['sourceEventSeq']),
            mapping,
            `command/done ${event.seq} sourceEventSeq`,
          ),
        }
    case 'compaction/prune':
    case 'compaction/summary': {
      const range = record(data['shadowedRange'])
      return {
        ...data,
        shadowedRange: {
          start: mapOne(
            coordinate(range['start']),
            mapping,
            `${event.type} ${event.seq} shadowedRange start`,
          ),
          end: mapOne(
            coordinate(range['end']),
            mapping,
            `${event.type} ${event.seq} shadowedRange end`,
          ),
        },
        shadowedSeqs: mapList(
          numberArray(data['shadowedSeqs'] as SessionFormatJsonValue),
          mapping,
          `${event.type} ${event.seq} shadowedSeqs`,
        ),
      }
    }
    case 'session/title':
    case 'session/title-llm-request':
      return {
        ...data,
        messageSeqs: mapList(
          numberArray(data['messageSeqs'] as SessionFormatJsonValue),
          mapping,
          `${event.type} ${event.seq} messageSeqs`,
        ),
      }
    default:
      return data
  }
}

function mapList(
  values: readonly number[],
  mapping: ReadonlyMap<number, number>,
  label: string,
): number[] {
  return values.map(value => mapOne(value, mapping, label))
}

function mapOne(
  value: number,
  mapping: ReadonlyMap<number, number>,
  label: string,
): number {
  const mapped = mapping.get(value)
  if (mapped === undefined) throw refusal(`${label} targets consumed assistant/chunk ${value}`)
  return mapped
}

/* assertReleasedV1Artifact validates these payload coordinates before migration. */
function record(value: SessionFormatJsonValue | undefined): SessionFormatJsonObject {
  return value as SessionFormatJsonObject
}

function numberArray(value: SessionFormatJsonValue): number[] {
  return value as number[]
}

function coordinate(value: SessionFormatJsonValue | undefined): number {
  return value as number
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function refusal(message: string): SessionFormatUnsupportedMigrationError {
  return new SessionFormatUnsupportedMigrationError(message)
}
