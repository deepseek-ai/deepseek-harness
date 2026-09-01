/**
 * Lossless row packing for `assistant/chunk` delta runs. Providers stream
 * token-sized deltas, so a log stores hundreds of near-identical event lines
 * whose JSON envelopes dwarf their payloads (~56× measured on a real DeepSeek
 * session). This module packs each run of consecutive same-block delta chunks
 * into ONE storage row — `text-chunks`, `reasoning-chunks`, or
 * `tool-call-chunks` — and expands rows back to the exact original events.
 *
 * Packed rows are an encoding vocabulary, NOT session events: they never enter
 * `Session.snapshotEvents()`, have no `SessionEventMap` entry, and use bare (slash-less)
 * type tags so a reader cannot confuse them with the event taxonomy
 * (precedent: the JSONL header line's `session` tag). Persistence and bounded
 * history transport both use the codec. The encoder whitelists exact shapes —
 * anything it does not fully recognize stays verbatim, so unknown fields or
 * future chunk variants lose compression, never data. The decoder validates
 * before expanding and fails loud on a malformed row-tagged value instead of
 * silently dropping a whole run.
 *
 * @module @deepseek-ai/dsh-session/chunk-rows
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from './types.ts'

/** The chunk kinds that may pack; block boundaries, usage, and finish chunks always stay one event per line. */
type DeltaKind = 'text-delta' | 'reasoning-delta' | 'tool-call-delta'

/** A run member: an `assistant/chunk` event whose exact shape the encoder whitelisted. */
type DeltaEvent = SessionEvent<'assistant/chunk'>

/**
 * Fields shared by every packed run: placement, block correlation, and member
 * timestamps as gaps. Member `k` reconstructs as seq `seq0 + k` and time
 * `time0` plus the first `k` gaps; a gap may be negative when the wall clock
 * stepped backwards between events.
 */
interface RunDataBase {
  turn: number
  step: number
  /** The stream block index every member shares. */
  index: number
  /** Epoch-ms gaps between consecutive members; length is one less than the member count. */
  dt: number[]
}

/** Payload of a `text-chunks`/`reasoning-chunks` row: one entry per member, never joined — token boundaries are data. */
interface TextRunData extends RunDataBase {
  texts: string[]
}

/** Payload of a `tool-call-chunks` row: the run-constant call identity plus each member's raw arguments fragment. */
interface ToolCallRunData extends RunDataBase {
  id: ToolCallId
  /** Present iff every member carried it, with one uniform value (a mixed run never packs). */
  name?: string
  args: string[]
}

/**
 * A packed run of consecutive delta chunk events, discriminated on `type`.
 * `seq0`/`time0` anchor the first member; text and reasoning rows share the
 * {@link TextRunData} payload, tool-call rows carry {@link ToolCallRunData}.
 */
export type ChunkRow =
  | { type: 'text-chunks'; seq0: number; time0: number; data: TextRunData }
  | { type: 'reasoning-chunks'; seq0: number; time0: number; data: TextRunData }
  | { type: 'tool-call-chunks'; seq0: number; time0: number; data: ToolCallRunData }

/** One durable log line's JSON value: a session event verbatim, or a packed chunk row. */
export type StorageRecord = SessionEvent | ChunkRow

/**
 * Test whether an encoded record is a packed chunk row rather than a Session event.
 * @param record - one persistence or bounded-history encoding record.
 * @returns Whether the record is a packed chunk row.
 */
export function isChunkRow(record: StorageRecord): record is ChunkRow {
  return record.type === 'text-chunks'
    || record.type === 'reasoning-chunks'
    || record.type === 'tool-call-chunks'
}

/**
 * Number of logical Session events represented by one packed row.
 * @param row - validated or encoder-produced packed row.
 * @returns Count of consecutive chunk events in the row.
 */
export function chunkRowLength(row: ChunkRow): number {
  return row.type === 'tool-call-chunks' ? row.data.args.length : row.data.texts.length
}

/**
 * Minimum members before a run packs. Below it a row's envelope rivals the
 * event lines it replaces. A format constant, not a tunable: both layouts
 * decode identically, so changing it never invalidates stored logs.
 */
const MIN_RUN = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Exact-key check: `value` has every key in `keys` and nothing else. */
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}

/**
 * Classify an event for packing: its delta kind when the ENTIRE shape
 * (envelope, data, chunk — exact keys, primitive types, integer seq/time) is
 * whitelisted, else `undefined` (store verbatim). Inputs come from live typed
 * appends AND parsed fixture files, so the checks are structural, not
 * type-trusted. Integer times keep gap encoding exact: a fractional time would
 * reconstruct through float subtraction/addition, which need not round-trip.
 */
function classify(event: SessionEvent): DeltaKind | undefined {
  if (event.type !== 'assistant/chunk') return undefined
  if (!hasExactKeys(event, ['type', 'seq', 'time', 'data'])) return undefined
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time)) return undefined
  const data: unknown = event.data
  if (!isRecord(data) || !hasExactKeys(data, ['turn', 'step', 'chunk'])) return undefined
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const chunk = data.chunk
  if (!isRecord(chunk) || typeof chunk.index !== 'number') return undefined
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return hasExactKeys(chunk, ['type', 'index', 'text']) && typeof chunk.text === 'string'
        ? chunk.type
        : undefined
    case 'tool-call-delta': {
      const shapeOk = hasExactKeys(chunk, ['type', 'index', 'id', 'argumentsDelta'])
        || (hasExactKeys(chunk, ['type', 'index', 'id', 'name', 'argumentsDelta']) && typeof chunk.name === 'string')
      return shapeOk && typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string'
        ? chunk.type
        : undefined
    }
    // Whitelist fall-through over parsed data: block-start/end, usage, finish,
    // and any future chunk variant stay one event per line.
    default:
      return undefined
  }
}

/** The tool-call fields of a whitelisted delta chunk (only after {@link classify} returned `'tool-call-delta'`). */
function toolCallOf(event: DeltaEvent): { id: string; name?: string } {
  return event.data.chunk as { id: string; name?: string }
}

/** The block index of a whitelisted delta chunk (not every {@link StreamChunk} variant carries one). */
function indexOf(event: DeltaEvent): number {
  return (event.data.chunk as { index: number }).index
}

/** Whether `next` extends a run ending in `prev` (same kind already checked by the caller). */
function continues(prev: DeltaEvent, next: DeltaEvent, kind: DeltaKind): boolean {
  if (next.seq !== prev.seq + 1) return false
  // Two safe-integer times can sit further apart than a double subtracts
  // exactly (2^53-1 and its negation differ by ~2^54); a rounded gap would
  // decode to a different timestamp. The check is exact in both directions: a
  // true gap within safe range subtracts without rounding and passes, while a
  // true gap beyond it rounds to a value that is itself beyond and fails.
  if (!Number.isSafeInteger(next.time - prev.time)) return false
  if (next.data.turn !== prev.data.turn || next.data.step !== prev.data.step) return false
  if (indexOf(next) !== indexOf(prev)) return false
  if (kind !== 'tool-call-delta') return true
  const a = toolCallOf(prev)
  const b = toolCallOf(next)
  // `name` must match in presence AND value — a mixed run is not representable.
  return a.id === b.id && Object.hasOwn(a, 'name') === Object.hasOwn(b, 'name') && a.name === b.name
}

/** Build the row for a completed run (`run.length >= MIN_RUN`, uniform per {@link continues}). */
function buildRow(kind: DeltaKind, run: readonly DeltaEvent[]): ChunkRow {
  const first = run[0] as DeltaEvent
  const base = {
    turn: first.data.turn,
    step: first.data.step,
    index: indexOf(first),
    dt: run.slice(1).map((event, i) => event.time - (run[i] as DeltaEvent).time),
  }
  const envelope = { seq0: first.seq, time0: first.time }
  if (kind === 'tool-call-delta') {
    const call = toolCallOf(first)
    return {
      type: 'tool-call-chunks',
      ...envelope,
      data: {
        ...base,
        id: brandString<ToolCallId>(call.id),
        ...Object.hasOwn(call, 'name') ? { name: call.name as string } : {},
        args: run.map(event => (event.data.chunk as { argumentsDelta: string }).argumentsDelta),
      },
    }
  }
  const data = { ...base, texts: run.map(event => (event.data.chunk as { text: string }).text) }
  return kind === 'text-delta'
    ? { type: 'text-chunks', ...envelope, data }
    : { type: 'reasoning-chunks', ...envelope, data }
}

/**
 * Pack an event batch for storage: each run of at least {@link MIN_RUN}
 * consecutive whitelisted same-kind, same-block delta chunk events becomes one
 * {@link ChunkRow}; every other event passes through verbatim, in order.
 * Pure and stateless — safe over any array, including a batch whose runs were
 * split by flush boundaries (the split runs simply pack per batch).
 *
 * @param events - the batch to encode, in log order.
 * @returns the storage records to write, one JSONL line each.
 */
export function packChunkRuns(events: readonly SessionEvent[]): StorageRecord[] {
  const out: StorageRecord[] = []
  let kind: DeltaKind | undefined
  let run: DeltaEvent[] = []
  const flush = (): void => {
    if (kind !== undefined && run.length >= MIN_RUN) out.push(buildRow(kind, run))
    else out.push(...run)
    kind = undefined
    run = []
  }
  for (const event of events) {
    const k = classify(event)
    if (k === undefined) {
      flush()
      out.push(event)
      continue
    }
    const delta = event as DeltaEvent
    const last = run[run.length - 1]
    if (k === kind && last !== undefined && continues(last, delta, k)) {
      run.push(delta)
      continue
    }
    flush()
    kind = k
    run = [delta]
  }
  flush()
  return out
}

/** Throw the uniform malformed-row diagnostic. */
function malformed(tag: string, why: string): never {
  throw new Error(`malformed ${tag} storage row: ${why}`)
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload. */
function validateRunData(tag: string, data: Record<string, unknown>, payloadKey: 'texts' | 'args'): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformed(tag, 'turn/step/index must be numbers')
  }
  const payload = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(entry => typeof entry !== 'string')) {
    malformed(tag, `${payloadKey} must be a non-empty string array`)
  }
  const dt = data.dt
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    malformed(tag, 'dt must be an array of safe integers')
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`)
  }
  return payload as string[]
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation. */
function validateRow(value: Record<string, unknown>, tag: ChunkRow['type']): ChunkRow {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformed(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  if (!Number.isSafeInteger(value.seq0) || (value.seq0 as number) < 0) {
    malformed(tag, 'seq0 must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(value.time0)) {
    malformed(tag, 'time0 must be a safe integer')
  }
  const data = value.data
  if (!isRecord(data)) malformed(tag, 'data must be an object')
  let payload: string[]
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
    }
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
      malformed(tag, 'id (and name when present) must be strings')
    }
    payload = validateRunData(tag, data, 'args')
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformed(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    payload = validateRunData(tag, data, 'texts')
  }
  // Reconstruction bounds. The encoder only packs runs whose member seqs and
  // times are all safe integers, so a running value that leaves safe range is
  // outside any encoder's image: float arithmetic would round it to a
  // different number than exact arithmetic, a silent corruption. Within safe
  // range every step is exact, so the first departure is always caught.
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - (value.seq0 as number)) {
    malformed(tag, 'member seqs must stay safe integers')
  }
  let time = value.time0 as number
  for (const gap of data.dt as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers')
  }
  return value as unknown as ChunkRow
}

/** Expand a validated row back into its exact original events, in order. */
function expandRow(row: ChunkRow): SessionEvent[] {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts
  const events: SessionEvent[] = []
  let time = row.time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1] as number
    let chunk: StreamChunk
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] as string }
        break
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] as string }
        break
      case 'tool-call-chunks':
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...Object.hasOwn(row.data, 'name') ? { name: row.data.name as string } : {},
          argumentsDelta: members[k] as string,
        }
        break
      /* v8 ignore next 4 -- validateRow only returns the three row tags */
      default: {
        const unreachable: never = row
        throw new Error(`chunk-rows received unsupported row ${String(unreachable)}`)
      }
    }
    events.push({
      type: 'assistant/chunk',
      seq: row.seq0 + k,
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    })
  }
  return events
}

/**
 * Decode one parsed JSONL line value into the session event(s) it stores.
 * Chunk-row-tagged values validate and expand (a malformed row throws — it is
 * corrupt storage, and treating it as an event would silently drop a whole
 * run); every other value passes through as a single event, unvalidated.
 *
 * @param value - one line's `JSON.parse` result.
 * @returns the stored events, in log order.
 */
export function decodeStorageRecord(value: unknown): SessionEvent[] {
  if (!isRecord(value)) return [value as SessionEvent]
  const tag = value.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') {
    return [value as SessionEvent]
  }
  return expandRow(validateRow(value, tag))
}
