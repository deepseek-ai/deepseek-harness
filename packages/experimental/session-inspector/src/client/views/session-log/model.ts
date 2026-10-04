/** Incremental raw Session rows with lossless Assistant stream children. */

import type { SessionEventSource, SessionEventWindow, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { expandAssistantStream, type AssistantStreamRecord, type TimedStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { InspectorRecord, InspectorRow } from '../table-model.ts'
import { AssistantLogStream } from './stream.ts'
import { SessionLogGroups } from './groups.ts'
import type { InspectorPickTarget } from '../chat-node/pick-match.ts'
import type { SessionLogAnchor } from './chat-target.ts'

interface LogRoot {
  readonly row: InspectorRow
  readonly entry: SessionEventLikeEntry
  readonly stream: AssistantLogStream | undefined
  readonly ordinal: number
  offset: number
}

/** Session-owned log projection; subscriptions exist only while the table is observed. */
export class SessionLogModel implements ObservableSnapshot<readonly InspectorRow[]> {
  private readonly rows = createSnapshotStore<readonly InspectorRow[]>([])
  private readonly records = new Map<string, SnapshotStore<InspectorRecord | undefined>>()
  private readonly roots: LogRoot[] = []
  private readonly attempts = new Map<string, LogRoot>()
  private groups = new SessionLogGroups()
  /** Preserve live-to-durable row identities only while their rows remain in the loaded window. */
  private readonly settledRoots = new Map<SessionSeq, string>()
  private readonly streams = new WeakMap<readonly AssistantStreamRecord[], readonly TimedStreamChunk[]>()
  private revision = -1
  private subscribers = 0
  private disconnect: (() => void) | undefined

  /**
   * @param source - The existing Session window, shared with Chat and Trajectory.
   */
  constructor(private readonly source: SessionEventSource) {
    this.accept(source.getSnapshot())
  }

  /** @returns Stable table order; row contents have independent sources. */
  getSnapshot = (): readonly InspectorRow[] => this.rows.getSnapshot()

  /**
   * Recover an event's placement without interpreting formatted table cells.
   * @param key - Selected root or delta row.
   * @returns The owning event and chunk, or undefined if the row is unavailable.
   */
  chatAnchor(key: string): SessionLogAnchor | undefined {
    this.accept(this.source.getSnapshot())
    const root = this.roots.find(root => root.row.key === key || (root.stream !== undefined && key.startsWith(`${root.row.key}/chunk:`)))
    if (root === undefined) return undefined
    const record = this.records.get(key)?.getSnapshot()
    if (record === undefined) return undefined
    return { event: root.entry.event,
      ...root.row.key === key ? {} : { chunk: record.value as StreamChunk } }
  }

  /**
   * Resolve a picked Chat object in the loaded log, without creating synthetic records.
   * @param target - DOM identity enriched with the owning Chat Node's sequence and Turn/Step.
   * @returns Tool call, exact anchor, Assistant, Step, or Turn row; reasoning parts prefer a block-start child.
   */
  pick(target: InspectorPickTarget): string | undefined {
    const window = this.source.getSnapshot()
    this.accept(window)
    const entries = window.entries
    const sameStep = (entry: SessionEventLikeEntry): boolean => {
      const data = entry.event.data
      return target.turn !== undefined && 'turn' in data && data.turn === target.turn
        && (target.step === undefined || ('step' in data && data.step === target.step))
    }
    const call = target.callId === undefined ? undefined : entries.find(entry => entry.event.type === 'tool/call'
      && entry.event.data.callId === target.callId)
    const anchor = target.anchorSeq === undefined ? undefined : entries.find(entry => entry.event.seq === target.anchorSeq)
    const assistant = target.nodeKind !== 'assistant-step' ? undefined : entries.findLast(entry => sameStep(entry)
      && (entry.event.type === 'assistant/message' || entry.event.type === 'assistant/attempt' || entry.type === 'transient'))
    const step = target.step === undefined ? undefined : entries.find(entry => entry.event.type === 'step/start' && sameStep(entry))
    const turn = target.turn === undefined ? undefined : entries.find(entry => entry.event.type === 'turn/start' && entry.event.data.turn === target.turn)
    const entry = call ?? anchor ?? assistant ?? step ?? turn ?? entries.find(sameStep)
    if (entry === undefined) return undefined
    const key = entry.type === 'transient' ? `attempt:${entry.event.data.attemptId}`
      : this.settledRoots.get(entry.event.seq) ?? `event:${entry.event.seq}`
    if (target.groupPart === 'reasoning') {
      const block = this.rows.getSnapshot().find((row) => {
        if (row.parent !== key) return false
        const value = this.records.get(row.key)?.getSnapshot()?.value
        return value !== null && typeof value === 'object' && 'type' in value && value.type === 'block-start'
          && 'blockType' in value && value.blockType === 'reasoning'
      })
      if (block !== undefined) return block.key
    }
    return key
  }

  /** @param listener - Structural invalidation callback. @returns Subscription disposer. */
  subscribe = (listener: () => void): (() => void) => {
    const stop = this.rows.subscribe(listener)
    if (this.subscribers++ === 0) {
      this.disconnect = this.source.subscribe(() => { this.accept(this.source.getSnapshot()) })
      this.accept(this.source.getSnapshot())
    }
    return () => {
      stop()
      if (--this.subscribers === 0) { this.disconnect?.(); this.disconnect = undefined }
    }
  }

  /**
   * Obtain a cached row source, initially empty when its record is unavailable.
   * @param key - Stable table row identity.
   * @returns Its independently observable raw data.
   */
  row = (key: string): ObservableSnapshot<InspectorRecord | undefined> => {
    let record = this.records.get(key)
    if (record === undefined) {
      record = createSnapshotStore<InspectorRecord | undefined>(undefined)
      this.records.set(key, record)
    }
    return record
  }

  private put(key: string, record: InspectorRecord): void {
    this.row(key)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- row(key) creates this source before lookup.
    const source = this.records.get(key)!
    if (source.getSnapshot()?.value !== record.value) source.set(record)
  }

  private accept(window: SessionEventWindow): void {
    if (window.revision === this.revision) return
    if (window.change.kind === 'settle-assistant' && window.change.entry !== undefined) {
      const parent = `attempt:${window.change.attemptId}`
      if (this.attempts.has(parent)) this.settledRoots.set(window.change.entry.event.seq, parent)
    }
    const append = window.revision === this.revision + 1 && window.change.kind === 'append'
    if (!append) { this.roots.length = 0; this.attempts.clear(); this.groups = new SessionLogGroups() }
    const next = append ? this.rows.getSnapshot().slice() : []
    const entries = append ? window.change.entries : window.entries
    for (const entry of entries) this.add(entry, next)
    this.revision = window.revision
    if (!append) this.prune(next)
    this.rows.set(next)
  }

  private prune(rows: readonly InspectorRow[]): void {
    const retained = new Set(rows.map(row => row.key))
    for (const [seq, key] of this.settledRoots) {
      if (!retained.has(key)) this.settledRoots.delete(seq)
    }
    for (const [key, source] of this.records) {
      if (!retained.has(key)) { source.set(undefined); this.records.delete(key) }
    }
  }

  private root(key: string, entry: SessionEventLikeEntry, rows: InspectorRow[], stream?: AssistantLogStream): LogRoot {
    const row = this.groups.append({ key, depth: 0 }, entry.event)
    const root: LogRoot = { row, entry, stream, ordinal: this.roots.length, offset: rows.length }
    this.roots.push(root)
    rows.push(row)
    return root
  }

  private add(entry: SessionEventLikeEntry, rows: InspectorRow[]): void {
    if (entry.type === 'transient') {
      const event = entry.event
      const { attemptId, turn, step, chunk } = entry.event.data
      const parent = `attempt:${attemptId}`
      let attempt = this.attempts.get(parent)
      if (attempt === undefined) {
        attempt = this.root(parent, entry, rows, new AssistantLogStream(parent))
        this.attempts.set(parent, attempt)
      }
      const chunks = this.addChunk(attempt, rows, event.time, chunk, `${turn}/${step}`)
      this.put(parent, { type: 'assistant/live', identity: attemptId, location: `${turn}/${step}`, time: event.time,
        value: { attemptId, turn, step, chunks } })
      return
    }
    const event = entry.event
    const key = this.settledRoots.get(event.seq) ?? `event:${event.seq}`
    const data = event.data
    const location = 'turn' in data ? `${data.turn}${'step' in data ? `/${data.step}` : ''}` : ''
    this.put(key, { type: event.type, identity: String(event.seq), time: event.time, location, value: event })
    if (entry.event.type === 'assistant/message' || entry.event.type === 'assistant/attempt') {
      const hierarchy = new AssistantLogStream(key)
      const root = this.root(key, entry, rows, hierarchy)
      const stream = entry.event.data.stream
      let chunks = this.streams.get(stream)
      if (chunks === undefined) { chunks = expandAssistantStream(stream); this.streams.set(stream, chunks) }
      for (const item of chunks) {
        this.addChunk(root, rows, item.time, item.chunk, location)
      }
    } else this.root(key, entry, rows)
  }

  private addChunk(root: LogRoot, rows: InspectorRow[], time: number, chunk: StreamChunk, location: string): number {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Only Assistant roots admit stream chunks.
    const stream = root.stream!
    const { key, index, position, row, header, collapsed } = stream.append(chunk)
    rows.splice(root.offset + 1 + position, 0, { ...row, depth: row.depth + root.row.depth })
    if (header !== undefined) rows[root.offset + 1 + header.position] = { ...header.row, depth: header.row.depth + root.row.depth }
    for (let ordinal = root.ordinal + 1; ordinal < this.roots.length; ordinal++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- ordinal is bounded by the root ledger.
      this.roots[ordinal]!.offset++
    }
    this.put(key, { type: chunk.type, identity: String(index), time, location, value: chunk })
    if (collapsed !== undefined) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- A collapsed block was published by its block-start chunk.
      const source = this.records.get(collapsed.key)!
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The owning block-start record remains in the same stream.
      const previous = source.getSnapshot()!
      if (previous.collapsedSummary !== collapsed.summary) source.set({ ...previous, collapsedSummary: collapsed.summary })
    }
    return stream.length
  }
}
