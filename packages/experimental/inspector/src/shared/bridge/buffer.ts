/** Realm-neutral bounded buffering for Host and Client observation sources. */

import type { InspectorSourceGeneration, InspectorSourceId } from './ids.ts'
import { isJsonValue, jsonByteLength, type InspectorJsonValue } from '../json.ts'
import type { InspectorRecordInput, SourceAppendFrame, SourceReplaceFrame } from './messages/observation.ts'
import { INSPECTOR_PROTOCOL_VERSION } from './version.ts'

const SOURCE_FRAME_OVERHEAD_BYTES = 4_096
const MAX_TOPIC_CODE_UNITS = 128
/**
 * Upper bound on the JSON around one replacement state payload: 38 bytes of punctuation and keys,
 * at most 24 for `monotonicMs`, and at most 6 per escaped topic code unit plus quotes (770).
 */
const STATE_RECORD_OVERHEAD_BYTES = 1_024

/**
 * Compute the payload budget of a source's single retained state topic.
 * @param maxFrameBytes - Source-frame byte limit.
 * @returns Encoded payload bytes that {@link InspectorSourceBuffer.setState} accepts when no other state topic is retained.
 */
export function maxStatePayloadBytes(maxFrameBytes: number): number {
  return maxFrameBytes - SOURCE_FRAME_OVERHEAD_BYTES - STATE_RECORD_OVERHEAD_BYTES
}

/** Limits and declared topics shared by both source transports. */
export interface InspectorSourceBufferOptions {
  readonly topics: readonly string[]
  readonly maxQueuedRecords: number
  readonly maxQueuedBytes: number
  readonly maxRecordsPerFrame: number
  readonly maxFrameBytes: number
}

interface QueuedRecord {
  sequence: number
  readonly bytes: number
  readonly record: InspectorRecordInput
}

/**
 * Owns retained state, queued events, and source-local sequencing independently
 * of whether frames travel over MessagePort or WebSocket.
 */
export class InspectorSourceBuffer {
  private readonly queue: QueuedRecord[] = []
  private readonly state = new Map<string, InspectorRecordInput>()
  private queuedBytes = 0
  private nextSequence = 1
  private expectedSequence = 1

  constructor(private readonly options: InspectorSourceBufferOptions) {}

  /** Whether at least one observation is waiting for transport. */
  get hasPending(): boolean {
    return this.queue.length > 0
  }

  /**
   * Validate and enqueue one observation, dropping the oldest prefix as needed.
   * A record larger than one transport frame is dropped after consuming its sequence number.
   * @param topic - Declared domain topic.
   * @param payload - Lossless JSON payload.
   * @param monotonicMs - Finite source-clock timestamp.
   */
  publish(topic: string, payload: InspectorJsonValue, monotonicMs: number): void {
    this.enqueue(this.record(topic, payload, monotonicMs))
  }

  /**
   * Replace one retained topic and enqueue the same observation for live delivery.
   * @param topic - Declared state topic.
   * @param payload - Lossless JSON payload retained for replacement frames.
   * @param monotonicMs - Finite source-clock timestamp.
   */
  setState(topic: string, payload: InspectorJsonValue, monotonicMs: number): void {
    const record = this.record(topic, payload, monotonicMs)
    const previous = this.state.get(topic)
    this.state.set(topic, record)
    if (!this.stateFits()) {
      if (previous === undefined) this.state.delete(topic)
      else this.state.set(topic, previous)
      throw new Error('inspector: source state exceeds the source-frame byte limit')
    }
    this.enqueue(record)
  }

  /**
   * Build a complete state replacement and absorb every preceding queue drop.
   * @param sourceId - Logical source identity.
   * @param generation - Current transport generation.
   * @returns A replacement frame whose sequence is the next append position.
   */
  replacement(sourceId: InspectorSourceId, generation: InspectorSourceGeneration): SourceReplaceFrame {
    const nextSequence = this.queue[0]?.sequence ?? this.nextSequence
    this.expectedSequence = nextSequence
    return {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/replace',
      sourceId,
      generation,
      nextSequence,
      records: [...this.state.values()],
    }
  }

  /**
   * Remove and sequence the next transport-sized observation batch.
   * @param sourceId - Logical source identity.
   * @param generation - Current transport generation.
   * @returns The next append frame, or `undefined` when the queue is empty.
   */
  takeBatch(sourceId: InspectorSourceId, generation: InspectorSourceGeneration): SourceAppendFrame | undefined {
    if (this.queue.length === 0) return undefined
    const batch: QueuedRecord[] = []
    let batchBytes = SOURCE_FRAME_OVERHEAD_BYTES
    const first = this.queue[0] as QueuedRecord
    while (batch.length < this.options.maxRecordsPerFrame && this.queue.length > 0) {
      const candidate = this.queue[0] as QueuedRecord
      if (candidate.sequence !== first.sequence + batch.length) break
      if (batch.length > 0 && batchBytes + candidate.bytes > this.options.maxFrameBytes) break
      this.queue.shift()
      batch.push(candidate)
      batchBytes += candidate.bytes
    }
    this.queuedBytes -= batch.reduce((sum, item) => sum + item.bytes, 0)
    const firstSequence = first.sequence
    const frame: SourceAppendFrame = {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/append',
      sourceId,
      generation,
      firstSequence,
      droppedBefore: firstSequence - this.expectedSequence,
      records: batch.map(item => item.record),
    }
    this.expectedSequence = firstSequence + frame.records.length
    return frame
  }

  /** Discard observations that have not entered a transport frame. */
  discardPending(): void {
    this.queue.length = 0
    this.queuedBytes = 0
  }

  private record(topic: string, payload: InspectorJsonValue, monotonicMs: number): InspectorRecordInput {
    if (topic.length === 0 || topic.length > MAX_TOPIC_CODE_UNITS) {
      throw new Error(`inspector: topic must contain 1 to ${String(MAX_TOPIC_CODE_UNITS)} characters`)
    }
    if (!this.options.topics.includes('*') && !this.options.topics.includes(topic)) {
      throw new Error(`inspector: source does not declare topic ${JSON.stringify(topic)}`)
    }
    if (!isJsonValue(payload)) throw new Error('inspector: source payload must be lossless JSON data')
    if (!Number.isFinite(monotonicMs)) throw new Error('inspector: monotonicMs must be finite')
    return { monotonicMs, topic, payload }
  }

  private enqueue(record: InspectorRecordInput): void {
    const bytes = jsonByteLength(record as unknown as InspectorJsonValue)
    const sequence = this.nextSequence++
    if (bytes + SOURCE_FRAME_OVERHEAD_BYTES > this.options.maxFrameBytes) {
      return
    }
    this.queue.push({ sequence, bytes, record })
    this.queuedBytes += bytes
    while (this.queue.length > this.options.maxQueuedRecords || this.queuedBytes > this.options.maxQueuedBytes) {
      const dropped = this.queue.shift() as QueuedRecord
      this.queuedBytes -= dropped.bytes
    }
  }

  private stateFits(): boolean {
    return jsonByteLength([...this.state.values()] as unknown as InspectorJsonValue) + SOURCE_FRAME_OVERHEAD_BYTES
      <= this.options.maxFrameBytes
  }
}
