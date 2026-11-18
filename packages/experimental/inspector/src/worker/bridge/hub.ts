/** Worker-owned source generations, observation dispatch, and extension transport. */

import { jsonByteLength, type InspectorJsonValue } from '../../shared/json.ts'
import {
  INSPECTOR_PROTOCOL_VERSION,
  parseSourceFrame,
  type InspectorRecordInput,
  type InspectorSourceDescriptor,
  type InspectorSourceKind,
  type SourceToWorkerFrame,
  type WorkerToSourceFrame,
} from '../../shared/bridge/messages/observation.ts'
import type { ClientConsoleEventFrame, ClientRuntimeResponseFrame } from '../../shared/bridge/messages/runtime/index.ts'
import type { ClientSourceResponseFrame } from '../../shared/bridge/messages/sources/index.ts'

/** One validated record with its source-local sequence. */
export interface IngestedInspectorRecord extends InspectorRecordInput {
  readonly sequence: number
}

/** One connected source's reply and close operations. */
export interface SourceConnection {
  readonly kind: InspectorSourceKind
  send(frame: WorkerToSourceFrame): void
  close(code: number, reason: string): void
}

/** Consumer of source lifecycle and records. */
export interface InspectorRecordConsumer {
  readonly topics: ReadonlySet<string>
  replace(source: InspectorSourceDescriptor, records: readonly IngestedInspectorRecord[]): void
  append(source: InspectorSourceDescriptor, records: readonly IngestedInspectorRecord[]): void
  close(source: InspectorSourceDescriptor, reason: string): void
}

interface SourceState {
  readonly source: InspectorSourceDescriptor
  readonly topics: ReadonlySet<string>
  readonly connection: SourceConnection
  expectedSequence: number
  dropped: number
  readonly topicCounts: Map<string, number>
}

/** Source lifecycle and typed extension frames observed inside the Worker. */
export type InspectorSourceEvent =
  | { readonly type: 'opened'; readonly source: InspectorSourceDescriptor }
  | { readonly type: 'closed'; readonly source: InspectorSourceDescriptor; readonly reason: string }
  | {
    readonly type: 'client-runtime-response'
    readonly source: InspectorSourceDescriptor
    readonly frame: ClientRuntimeResponseFrame
  }
  | {
    readonly type: 'client-console-event'
    readonly source: InspectorSourceDescriptor
    readonly frame: ClientConsoleEventFrame
  }
  | {
    readonly type: 'client-source-response'
    readonly source: InspectorSourceDescriptor
    readonly frame: ClientSourceResponseFrame
  }

/** Read-only diagnostic for `DSHInspector.getSources`. */
export interface InspectorSourceView {
  readonly sourceId: string
  readonly generation: string
  readonly kind: InspectorSourceKind
  readonly label: string
  readonly capabilities: readonly string[]
  readonly expectedSequence: number
  readonly dropped: number
  readonly topics: Readonly<Record<string, number>>
}

/** Serial Worker-side owner of every Host and Client source generation. */
export class InspectorSourceRegistry {
  private readonly sources = new Map<string, SourceState>()
  private readonly statusListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: InspectorSourceEvent) => void>()

  constructor(
    private readonly consumers: readonly InspectorRecordConsumer[],
    private readonly maxFrameBytes: number,
    private readonly maxRecordsPerFrame: number,
  ) {}

  /**
   * Parse and apply one frame; malformed input closes only its source transport.
   * @param connection - Carrier that delivered the frame.
   * @param value - Untrusted decoded frame.
   */
  receive(connection: SourceConnection, value: unknown): void {
    try {
      const frame = parseSourceFrame(value, this.maxRecordsPerFrame)
      if (jsonByteLength(frame as unknown as InspectorJsonValue) > this.maxFrameBytes) {
        throw new Error(`inspector protocol: source frame exceeds ${String(this.maxFrameBytes)} bytes`)
      }
      this.apply(connection, frame)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      connection.send({ v: INSPECTOR_PROTOCOL_VERSION, t: 'source/rejected', code: 'invalid-frame', message })
      connection.close(1008, message)
    }
  }

  /**
   * Remove every generation carried by a closed connection.
   * @param connection - Closed source carrier.
   * @param reason - Diagnostic propagated to domain consumers.
   */
  disconnect(connection: SourceConnection, reason: string): void {
    for (const [sourceId, state] of this.sources) {
      if (state.connection !== connection) continue
      this.sources.delete(sourceId)
      for (const consumer of this.consumers) consumer.close(state.source, reason)
      this.emit({ type: 'closed', source: state.source, reason })
    }
    this.notifyStatus()
  }

  /**
   * Read current source status for the diagnostic CDP domain.
   * @returns A detached status row for every active source.
   */
  describe(): InspectorSourceView[] {
    return [...this.sources.values()].map(state => ({
      sourceId: state.source.sourceId,
      generation: state.source.generation,
      kind: state.source.kind,
      label: state.source.label,
      capabilities: state.source.capabilities.map(capability => capability.type),
      expectedSequence: state.expectedSequence,
      dropped: state.dropped,
      topics: Object.fromEntries(state.topicCounts),
    }))
  }

  /**
   * Subscribe to source status changes.
   * @param listener - Status observer.
   * @returns A disposer that removes the observer.
   */
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /**
   * Subscribe to source admission, removal, and typed extension frames.
   * @param listener - Source protocol observer.
   * @returns A disposer that removes the observer.
   */
  subscribeEvents(listener: (event: InspectorSourceEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /**
   * Send a typed control frame only to its still-active source generation.
   * @param source - Expected active source generation.
   * @param frame - Validated Worker-to-source frame.
   * @returns Whether the generation was still active and accepted the send.
   */
  send(source: InspectorSourceDescriptor, frame: WorkerToSourceFrame): boolean {
    const state = this.sources.get(source.sourceId)
    if (state === undefined || state.source.generation !== source.generation) return false
    if (jsonByteLength(frame as unknown as InspectorJsonValue) > this.maxFrameBytes) {
      throw new Error(`inspector protocol: Worker source frame exceeds ${String(this.maxFrameBytes)} bytes`)
    }
    state.connection.send(frame)
    return true
  }

  /** Close every source and forget all state. */
  close(): void {
    for (const state of this.sources.values()) {
      for (const consumer of this.consumers) consumer.close(state.source, 'inspector worker stopped')
      this.emit({ type: 'closed', source: state.source, reason: 'inspector worker stopped' })
    }
    this.sources.clear()
    this.notifyStatus()
  }

  private apply(connection: SourceConnection, frame: SourceToWorkerFrame): void {
    if (frame.t === 'source/open') {
      this.open(connection, frame.source, frame.topics)
      return
    }
    const state = this.sources.get(frame.sourceId)
    if (state === undefined || state.connection !== connection || state.source.generation !== frame.generation) {
      throw new Error('inspector protocol: frame does not belong to the active source generation')
    }
    if (frame.t === 'source/close') {
      this.sources.delete(frame.sourceId)
      for (const consumer of this.consumers) consumer.close(state.source, 'source closed')
      this.emit({ type: 'closed', source: state.source, reason: 'source closed' })
      this.notifyStatus()
      return
    }
    if (frame.t === 'client-runtime/response') {
      if (state.source.kind !== 'client'
        || !state.source.capabilities.some(capability => capability.type === 'client-runtime')) {
        throw new Error('inspector protocol: source did not declare Client Runtime')
      }
      this.emit({ type: 'client-runtime-response', source: state.source, frame })
      return
    }
    if (frame.t === 'client-console/event') {
      if (state.source.kind !== 'client'
        || !state.source.capabilities.some(capability => capability.type === 'client-console')) {
        throw new Error('inspector protocol: source did not declare Client Console')
      }
      this.emit({ type: 'client-console-event', source: state.source, frame })
      return
    }
    if (frame.t === 'client-sources/response') {
      if (state.source.kind !== 'client'
        || !state.source.capabilities.some(capability => capability.type === 'client-sources')) {
        throw new Error('inspector protocol: source did not declare Client Sources')
      }
      this.emit({ type: 'client-source-response', source: state.source, frame })
      return
    }
    this.assertTopics(state, frame.records)
    if (frame.t === 'source/replace') {
      state.expectedSequence = frame.nextSequence
      for (const consumer of this.consumers) consumer.replace(
        state.source,
        frame.records.map((record, index) => ({ ...record, sequence: frame.nextSequence + index })),
      )
      this.count(state, frame.records)
      this.notifyStatus()
      return
    }
    const gap = frame.firstSequence - state.expectedSequence
    if (gap < 0 || gap !== frame.droppedBefore) {
      connection.send({
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'source/resnapshot',
        sourceId: state.source.sourceId,
        generation: state.source.generation,
        expectedSequence: state.expectedSequence,
        reason: `expected sequence ${String(state.expectedSequence)}, received ${String(frame.firstSequence)}`,
      })
      return
    }
    state.dropped += frame.droppedBefore
    const records = frame.records.map((record, index) => ({ ...record, sequence: frame.firstSequence + index }))
    state.expectedSequence = frame.firstSequence + frame.records.length
    for (const consumer of this.consumers) consumer.append(state.source, records)
    this.count(state, frame.records)
    connection.send({
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/append-acknowledged',
      sourceId: state.source.sourceId,
      generation: state.source.generation,
      nextSequence: state.expectedSequence,
    })
    this.notifyStatus()
  }

  private open(connection: SourceConnection, source: InspectorSourceDescriptor, topics: readonly string[]): void {
    if (source.kind !== connection.kind) throw new Error('inspector protocol: source kind does not match its carrier')
    const accepted = new Set(topics)
    const prior = this.sources.get(source.sourceId)
    if (prior !== undefined) {
      for (const consumer of this.consumers) consumer.close(prior.source, 'source generation replaced')
      this.emit({ type: 'closed', source: prior.source, reason: 'source generation replaced' })
    }
    this.sources.set(source.sourceId, {
      source,
      topics: accepted,
      connection,
      expectedSequence: 1,
      dropped: 0,
      topicCounts: new Map(),
    })
    connection.send({
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/accepted',
      sourceId: source.sourceId,
      generation: source.generation,
    })
    this.emit({ type: 'opened', source })
    this.notifyStatus()
  }

  private assertTopics(state: SourceState, records: readonly InspectorRecordInput[]): void {
    for (const record of records) {
      if (!state.topics.has('*') && !state.topics.has(record.topic)) {
        throw new Error(`inspector protocol: source did not declare topic ${JSON.stringify(record.topic)}`)
      }
    }
  }

  private count(state: SourceState, records: readonly InspectorRecordInput[]): void {
    for (const record of records) {
      state.topicCounts.set(record.topic, (state.topicCounts.get(record.topic) ?? 0) + 1)
    }
  }

  private notifyStatus(): void {
    for (const listener of [...this.statusListeners]) {
      try {
        listener()
      } catch (_observerFailed) {
        // A diagnostic observer is isolated from source admission and later observers.
      }
    }
  }

  private emit(event: InspectorSourceEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event)
      } catch (_consumerFailed) {
        // A protocol consumer is isolated from source admission and sibling consumers.
      }
    }
  }
}
