/** Lossless compact representation of one model-stream attempt. */

import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolCallId } from './brand.ts'
import type { StreamChunk } from './types.ts'

/** One model chunk paired with its original Session timestamp. */
export interface TimedStreamChunk {
  readonly time: number
  readonly chunk: StreamChunk
}

/** Lossless compact records embedded in durable Assistant attempt events. */
export type AssistantStreamRecord =
  | {
    readonly type: 'text-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly texts: readonly string[]
  }
  | {
    readonly type: 'reasoning-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly texts: readonly string[]
  }
  | {
    readonly type: 'tool-call-chunks'
    readonly time0: number
    readonly index: number
    readonly dt: readonly number[]
    readonly id: ToolCallId
    readonly name?: string
    readonly args: readonly string[]
  }
  | { readonly type: 'chunk'; readonly time: number; readonly chunk: StreamChunk }

type MutableRecord =
  | {
    type: 'text-chunks' | 'reasoning-chunks'
    time0: number
    index: number
    dt: number[]
    texts: string[]
    lastTime: number
  }
  | {
    type: 'tool-call-chunks'
    time0: number
    index: number
    dt: number[]
    id: ToolCallId
    name?: string
    args: string[]
    lastTime: number
  }
  | { type: 'chunk'; time: number; chunk: StreamChunk }

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Assistant stream time must be a safe integer, got ${String(value)}`)
  return value
}

function safeIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} index must be a non-negative safe integer`)
  }
  return value
}

function snapshotChunk(chunk: StreamChunk): StreamChunk {
  const snapshot = snapshotJsonValue(chunk)
  if (snapshot === undefined) throw new TypeError('Assistant stream chunk must be losslessly JSON-serializable')
  return snapshot
}

function safeGap(previous: number, next: number): number | undefined {
  const gap = next - previous
  return Number.isSafeInteger(gap) && previous + gap === next ? gap : undefined
}

/** Incrementally compacts one attempt without retaining a second raw-chunk list. */
export class AssistantStreamAccumulator {
  private readonly records: MutableRecord[] = []

  /**
   * Add one timed chunk to the compact attempt stream.
   * @param value - model chunk and its original Session timestamp.
   * @returns a detached immutable copy for assembly and live publication.
   */
  push(value: TimedStreamChunk): TimedStreamChunk {
    const time = safeTime(value.time)
    const chunk = snapshotChunk(value.chunk)
    const timed = deepFreeze({ time, chunk })
    const previous = this.records.at(-1)
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        safeIndex(chunk.index, chunk.type)
        if (typeof chunk.text !== 'string') throw new TypeError(`${chunk.type} text must be a string`)
        const type = chunk.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks'
        const gap = previous !== undefined && previous.type === type ? safeGap(previous.lastTime, time) : undefined
        if (previous !== undefined && previous.type === type && previous.index === chunk.index && gap !== undefined) {
          previous.dt.push(gap)
          previous.texts.push(chunk.text)
          previous.lastTime = time
        } else {
          this.records.push({ type, time0: time, index: chunk.index, dt: [], texts: [chunk.text], lastTime: time })
        }
        return timed
      }
      case 'tool-call-delta': {
        safeIndex(chunk.index, chunk.type)
        if (typeof chunk.id !== 'string') throw new TypeError('tool-call-delta id must be a string')
        if (Object.hasOwn(chunk, 'name') && typeof chunk.name !== 'string') {
          throw new TypeError('tool-call-delta name must be a string')
        }
        if (typeof chunk.argumentsDelta !== 'string') {
          throw new TypeError('tool-call-delta argumentsDelta must be a string')
        }
        if (chunk.id.length === 0 || chunk.name === '') {
          this.records.push({ type: 'chunk', time, chunk })
          return timed
        }
        const gap = previous?.type === 'tool-call-chunks' ? safeGap(previous.lastTime, time) : undefined
        const sameName = previous?.type === 'tool-call-chunks'
          && Object.hasOwn(previous, 'name') === Object.hasOwn(chunk, 'name')
          && previous.name === chunk.name
        if (previous?.type === 'tool-call-chunks'
          && previous.index === chunk.index
          && previous.id === chunk.id
          && sameName
          && gap !== undefined) {
          previous.dt.push(gap)
          previous.args.push(chunk.argumentsDelta)
          previous.lastTime = time
        } else {
          this.records.push({
            type: 'tool-call-chunks',
            time0: time,
            index: chunk.index,
            dt: [],
            id: chunk.id,
            ...Object.hasOwn(chunk, 'name') ? { name: chunk.name } : {},
            args: [chunk.argumentsDelta],
            lastTime: time,
          })
        }
        return timed
      }
      case 'block-start':
      case 'block-end':
      case 'usage':
      case 'finish':
        this.records.push({ type: 'chunk', time, chunk })
        return timed
      default:
        return assertNever(chunk, 'AssistantStreamAccumulator.push')
    }
  }

  /**
   * Return the current compact attempt stream.
   * @returns a detached immutable record list suitable for a durable event.
   */
  snapshot(): readonly AssistantStreamRecord[] {
    const records = this.records.map((record): AssistantStreamRecord => {
      if (record.type === 'chunk') return { ...record }
      const { lastTime: _lastTime, ...durable } = record
      if (durable.type === 'tool-call-chunks') {
        return { ...durable, dt: [...durable.dt], args: [...durable.args] }
      }
      return { ...durable, dt: [...durable.dt], texts: [...durable.texts] }
    })
    return deepFreeze(records)
  }
}

/**
 * Expand compact records into the exact timed chunk sequence.
 * @param stream - compact records from one durable Assistant settlement.
 * @returns detached timed chunks with every original delta boundary preserved.
 * @throws {TypeError} when a record or reconstructed timestamp is invalid.
 */
export function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[] {
  const chunks: TimedStreamChunk[] = []
  for (const candidate of stream) {
    const record = validateRecord(candidate)
    if (record.type === 'chunk') {
      chunks.push({ time: record.time, chunk: record.chunk })
      continue
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    let time = record.time0
    for (let index = 0; index < members.length; index += 1) {
      if (index > 0) time += record.dt[index - 1] as number
      let chunk: StreamChunk
      if (record.type === 'text-chunks') {
        chunk = { type: 'text-delta', index: record.index, text: members[index] as string }
      } else if (record.type === 'reasoning-chunks') {
        chunk = { type: 'reasoning-delta', index: record.index, text: members[index] as string }
      } else {
        chunk = {
          type: 'tool-call-delta',
          index: record.index,
          id: record.id,
          ...Object.hasOwn(record, 'name') ? { name: record.name } : {},
          argumentsDelta: members[index] as string,
        }
      }
      chunks.push({ time, chunk })
    }
  }
  return chunks
}

function validateRecord(value: unknown): AssistantStreamRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Assistant stream record must be an object')
  }
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'text-chunks':
    case 'reasoning-chunks': {
      exactKeys(record, ['type', 'time0', 'index', 'dt', 'texts'], record.type)
      const texts = stringArray(record.texts, `${record.type} texts`)
      if (texts.length === 0) throw new TypeError(`${record.type} texts must be non-empty`)
      validateRun(record, texts.length, record.type)
      return record as unknown as AssistantStreamRecord
    }
    case 'tool-call-chunks': {
      const keys = Object.hasOwn(record, 'name')
        ? ['type', 'time0', 'index', 'dt', 'id', 'name', 'args']
        : ['type', 'time0', 'index', 'dt', 'id', 'args']
      exactKeys(record, keys, record.type)
      const args = stringArray(record.args, 'tool-call-chunks args')
      if (args.length === 0) throw new TypeError('tool-call-chunks args must be non-empty')
      if (typeof record.id !== 'string' || record.id.length === 0) {
        throw new TypeError('tool-call-chunks id must be a non-empty string')
      }
      if (record.name !== undefined && (typeof record.name !== 'string' || record.name.length === 0)) {
        throw new TypeError('tool-call-chunks name must be a non-empty string')
      }
      validateRun(record, args.length, record.type)
      return record as unknown as AssistantStreamRecord
    }
    case 'chunk': {
      exactKeys(record, ['type', 'time', 'chunk'], 'chunk')
      const time = safeTime(record.time as number)
      if (typeof record.chunk !== 'object'
        || record.chunk === null
        || Array.isArray(record.chunk)) {
        throw new TypeError('Assistant stream raw chunk must be a lossless JSON object')
      }
      let chunk: StreamChunk
      try {
        chunk = snapshotChunk(record.chunk as StreamChunk)
      } catch (error: unknown) {
        throw new TypeError('Assistant stream raw chunk must be a lossless JSON object', { cause: error })
      }
      return deepFreeze({ type: 'chunk', time, chunk })
    }
    default:
      throw new TypeError(`Unsupported Assistant stream record ${JSON.stringify(record.type)}`)
  }
}

function validateRun(record: Record<string, unknown>, members: number, label: string): void {
  safeTime(record.time0 as number)
  safeIndex(record.index as number, label)
  if (!Array.isArray(record.dt) || record.dt.some(value => !Number.isSafeInteger(value))) {
    throw new TypeError(`${label} dt must contain safe integers`)
  }
  if (record.dt.length !== members - 1) {
    throw new TypeError(`${label} dt length must be one less than its members`)
  }
  let time = record.time0 as number
  for (const gap of record.dt as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) throw new TypeError(`${label} member times must stay safe integers`)
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(member => typeof member !== 'string')) {
    throw new TypeError(`${label} must be a string array`)
  }
  return value as string[]
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) {
    throw new TypeError(`${label} Assistant stream record must contain exactly ${keys.join(', ')}`)
  }
}
