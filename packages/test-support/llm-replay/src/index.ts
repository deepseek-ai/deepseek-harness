/**
 * Keyless snapshot-test LLM replay. It derives one model-call script per
 * recorded session from v2 embedded Assistant streams and explicitly marked local
 * compaction calls, then binds fresh live sessions to parent/child scripts by
 * first-call order. Throw and hang cases require an explicit override because
 * a session log cannot reconstruct them alone.
 * @module @deepseek-ai/dsh-llm-replay
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter as pathDelimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SESSION_FORMAT_VERSION, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedMigrationError,
  sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
import type {
  ContentBlock,
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError, ReasoningEffortId, expandAssistantStream, requestImageHandleText, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
  throw new Error(
    `llm-replay: format catalog v${sessionFormatCatalog.currentVersion} `
    + `does not match Session v${SESSION_FORMAT_VERSION}`,
  )
}

interface ParsedSessionFixture {
  readonly id: string
  readonly createdAt: number
  readonly inheritedEventCount: SessionLogOffsetType
  readonly events: SessionEvent[]
  readonly artifact: ReturnType<typeof sessionFormatCatalog.migrate>
  readonly sourceHeader: Readonly<Record<string, unknown>>
}

interface FixtureJsonLine {
  readonly lineNumber: number
  readonly value: Record<string, unknown>
}

/**
 * One recorded model call. `throw` may replay prefix chunks before failing;
 * `hang` models cancellation. Derived chunk entries come from ordinary model
 * streams and complete outputs of explicitly marked local compaction calls;
 * an override sidecar can supply any variant.
 */
export type ReplayEntry =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'throw'; chunks: StreamChunk[]; message: string; code: string; accepted?: boolean }
  | {
    kind: 'hang'
    /** Optional marker written after the prefix chunks are consumed and before the stream waits for cancellation. */
    readyFile?: string
  }

/** One model exposed by a replay-only provider catalog. */
export interface ReplayModelConfig {
  /** Model id used for replay requests. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector description. */
  description?: string
  /** Optional positive integer context capacity published by the replay adapter. */
  contextWindow?: number
  /** Optional declared input modalities, so a scenario can exercise capability gates (e.g. image-capable `read_image`). */
  inputModalities?: readonly ModelModality[]
  /**
   * Optional per-request output cap the replay route materializes when callers
   * omit one, so replay reconstructs the request header a live catalog produced.
   */
  defaultMaxTokens?: number
  /**
   * Optional flat visual-token price the replay route declares for every
   * retained request image, so keyless scenarios exercise route-priced
   * request pressure; each occurrence is priced at this value plus its
   * request-preview handle text. Requires {@link inputModalities} to include
   * `image` — a text-only route never sends visual tokens. Absent declares
   * no image pricing.
   */
  imageRequestTokens?: number
  /** Optional reasoning-effort ids the replay route accepts, in display order. */
  reasoningEfforts?: string[]
  /**
   * Optional effort materialized when callers omit one; must appear in
   * {@link reasoningEfforts} or call resolution rejects the route.
   */
  defaultReasoningEffort?: string
}

/** One provider route exposed by the replay adapter. */
export interface ReplayProviderConfig {
  /** Provider route used for replay requests. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Advisory models exposed to replay scenarios that exercise discovery. */
  models?: ReplayModelConfig[]
  /** Optional provider-owned retry policy used by assembled recovery snapshots. */
  retryPolicy?: RetryPolicyConfig
}

/** Resolved plugin configuration. */
export interface ReplayConfig {
  /**
   * Path to the selected PRIMARY fixture (`session.jsonl` for v0 or
   * `session.vN.jsonl` for vN). For a single-session scenario this is the only
   * log; for a nested-agent scenario it is the parent, and child logs ride in
   * {@link childFiles}.
   */
  file: string
  /**
   * Optional sidecar for the PRIMARY session: a bare `ReplayEntry[]` replaces
   * the derived script; `{ patches }` keeps it and swaps the named call
   * indexes ({@link ReplayOverrideDoc}). Used by single-session scenarios not
   * expressible as a durable embedded stream (throw-before-chunk, cancel/hang,
   * injected transient failures). Absent for normal and nested scenarios.
   */
  overrideFile?: string
  /**
   * Additional recorded child-session logs (a nested-agent scenario's subagent
   * sessions). Each is derived independently; the full set is ordered by
   * `createdAt` so the parent (earliest) binds to the first live session. Empty
   * for a single-session scenario.
   */
  childFiles?: string[]
  /**
   * Optional provider catalog. When non-empty, replay registers an adapter for
   * these routes; when absent or empty, it retains the catch-all waterfall used
   * by tests that do not need discovery.
   */
  providers?: ReplayProviderConfig[]
  /**
   * Optional per-chunk pacing delay in milliseconds: each replayed chunk waits
   * this long before yielding, so a downstream transport (e.g. the web SSE
   * mux observed by a browser) sees genuinely incremental delivery. A realism
   * knob only — correctness must never depend on it. Absent or `0` keeps
   * a synchronous burst yield. Must be a non-negative finite integer;
   * aborting mid-wait cancels the stream like any other abort.
   */
  paceMs?: number
}

/**
 * Handle returned by {@link installLlmReplay}: removal plus the end-of-run
 * consumption check that turns silent fixture underruns (a scenario that
 * issued fewer calls than recorded, or never bound a recorded child script)
 * into a crisp diagnostic at teardown.
 */
export interface ReplayHandle {
  /** Remove the registered adapter or waterfall listener (HMR safety). Freestanding closure — safe to destructure. */
  dispose(this: void): void
  /**
   * Throw unless every recorded script was bound to a live session and every
   * bound cursor consumed its full entry list. Call at scenario teardown.
   * Freestanding closure — safe to destructure.
   */
  assertConsumed(this: void): void
}

/**
 * Recorded calls plus header facts used to order parent and child scripts.
 * Recorded ids are diagnostic; fresh live ids bind by ordered first use.
 */
export interface SessionScript {
  /** The recorded session id (diagnostics only — the live id differs). */
  recordedId: string
  /** Session creation time; the deterministic ordering key (parent < child). */
  createdAt: number
  /** The per-`stream()`-call replay entries, in recorded call order. */
  entries: ReplayEntry[]
  /**
   * Whether this is the PRIMARY (parent) session. Breaks a `createdAt` tie in
   * favor of the parent, which always issues the first model call.
   */
  primary: boolean
}

/**
 * Parse a projected session `.jsonl` buffer into current events. The first
 * non-empty line is the physical header. Body rows either all carry complete
 * persistence envelopes or all omit them; projected rows receive deterministic
 * dense sequences and zero timestamps. The build-static format catalog then
 * decodes and migrates the complete artifact before this function returns.
 * @param text - the raw `.jsonl` file contents.
 * @returns every migrated current event, in log order.
 */
export function parseSessionLog(text: string): SessionEvent[] {
  return parseSessionFixture(text).events
}

/** Parse, complete, decode, and migrate one projected snapshot artifact without writing its source. */
function parseSessionFixture(text: string): ParsedSessionFixture {
  const parsed: FixtureJsonLine[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`session snapshot line ${index + 1} contains invalid JSON`, { cause: error })
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`session snapshot line ${index + 1} must be a JSON object`)
    }
    parsed.push({ lineNumber: index + 1, value: value as Record<string, unknown> })
  }
  const headerLine = parsed[0]
  if (headerLine === undefined) throw new Error('session snapshot must start with a session header')

  const header = normalizeProjectedHeader(headerLine.value)
  const rows: Record<string, unknown>[] = []
  const rowLines: number[] = []
  const eventLines: number[] = []
  let bodyKind: 'complete' | 'projected' | undefined
  let nextSeq = 0
  for (const source of parsed.slice(1)) {
    const record = normalizeProjectedRow(source.value)
    const packed = PACKED_CHUNK_ROW_TYPES.has(record.type as string)
    const seqKey = packed ? 'seq0' : 'seq'
    const timeKey = packed ? 'time0' : 'time'
    const hasSeq = Object.hasOwn(record, seqKey)
    const hasTime = Object.hasOwn(record, timeKey)
    if (hasSeq !== hasTime) {
      throw new Error(
        `session snapshot line ${source.lineNumber} must contain both ${seqKey} and ${timeKey}, or neither`,
      )
    }
    const currentKind = hasSeq ? 'complete' : 'projected'
    if (bodyKind !== undefined && currentKind !== bodyKind) {
      throw new Error(`session snapshot line ${source.lineNumber} cannot mix projected and complete body rows`)
    }
    bodyKind = currentKind
    if (currentKind === 'projected') {
      record[seqKey] = nextSeq
      record[timeKey] = 0
    }
    const cardinality = physicalRowCardinality(record)
    rows.push(record)
    rowLines.push(source.lineNumber)
    eventLines.push(...Array.from({ length: cardinality }, () => source.lineNumber))
    nextSeq += cardinality
  }

  let decoded: ReturnType<typeof sessionFormatCatalog.decodeArtifact>
  try {
    decoded = sessionFormatCatalog.decodeArtifact(header, rows)
  } catch (error: unknown) {
    const physicalRow = locateUnlabelledPhysicalFailure(error, header, rows)
    throw fixtureFormatError(
      error,
      headerLine.lineNumber,
      rowLines,
      eventLines,
      physicalRow,
    )
  }
  try {
    const current = sessionFormatCatalog.migrate(decoded)
    return parsedSessionFixture(current, headerLine.value)
  } catch (error: unknown) {
    throw fixtureFormatError(error, headerLine.lineNumber, rowLines, eventLines)
  }
}

/** Materialize the common replay view from a migrated artifact. */
function parsedSessionFixture(
  artifact: ReturnType<typeof sessionFormatCatalog.decodeArtifact>,
  sourceHeader: Readonly<Record<string, unknown>>,
): ParsedSessionFixture {
  return {
    id: artifact.header.id,
    createdAt: artifact.header.createdAt,
    inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount),
    events: [...artifact.events] as unknown as SessionEvent[],
    artifact,
    sourceHeader,
  }
}

/**
 * Convert one persisted or projected snapshot fixture to the current physical format in memory for expected-output comparison.
 * Projected cwd tokens remain tokens so the ordinary snapshot normalizer can compare them with a fresh run.
 * @param text - one complete Session fixture.
 * @returns current-format JSONL with complete event envelopes; the input string and source file remain unchanged.
 */
export function prepareSessionSnapshotFixtureForComparison(text: string): string {
  const parsed = parseSessionFixture(text)
  return encodeCurrentSessionSnapshotFixture(text, parsed)
}

interface WrappedSessionEvent {
  readonly sessionId: string
  readonly event: Record<string, unknown>
  readonly replace: (event: Readonly<Record<string, unknown>>) => Record<string, unknown>
}

/** Read one headless or SDK event-notification wrapper. */
function wrappedSessionEvent(row: Record<string, unknown>): WrappedSessionEvent | undefined {
  if (row['type'] === 'session_event' && typeof row['sessionId'] === 'string'
    && row['event'] !== null && typeof row['event'] === 'object' && !Array.isArray(row['event'])) {
    return {
      sessionId: row['sessionId'],
      event: row['event'] as Record<string, unknown>,
      replace: event => ({ ...row, event }),
    }
  }
  const params = row['params']
  if (row['method'] !== 'session.event' || params === null || typeof params !== 'object' || Array.isArray(params)) {
    return undefined
  }
  const record = params as Record<string, unknown>
  if (typeof record['sessionId'] !== 'string'
    || record['event'] === null || typeof record['event'] !== 'object' || Array.isArray(record['event'])) {
    return undefined
  }
  return {
    sessionId: record['sessionId'],
    event: record['event'] as Record<string, unknown>,
    replace: event => ({ ...row, params: { ...record, event } }),
  }
}

interface WrappedEventEntry extends WrappedSessionEvent {
  readonly rowIndex: number
}

/** Append one migrated event to the output assigned to its v1 source row. */
function assignMigratedEvent(
  assigned: Map<number, Readonly<Record<string, unknown>>[]>,
  rowIndex: number,
  event: Readonly<Record<string, unknown>>,
): void {
  assigned.set(rowIndex, [...assigned.get(rowIndex) ?? [], event])
}

/** Restore fixture tokens materialized only to satisfy released-format validation. */
function restoreProjectedRequestHeader(
  target: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (target['type'] !== 'request/header' || source['type'] !== 'request/header') return target
  const targetData = target['data'] as Record<string, unknown>
  const sourceData = source['data'] as Record<string, unknown>
  const targetHeader = targetData['header'] as Record<string, unknown>
  const sourceHeader = sourceData['header'] as Record<string, unknown>
  const sourceTools = sourceHeader['tools']
  if (sourceTools !== '{{tools}}') return target
  return {
    ...target,
    data: {
      ...targetData,
      header: { ...targetHeader, tools: sourceTools },
    },
  }
}

/** Omit delivery cursors whose numeric value depends on the source Session generation. */
function normalizeWrappedEventProvenance(
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (event['type'] !== 'session-log-deepseek/delivery-accepted') return event
  const data = event['data']
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return event
  const normalized = { ...data as Record<string, unknown> }
  delete normalized['sessionFormatVersion']
  delete normalized['throughSeq']
  return { ...event, data: normalized }
}

type WrappedEventGroup = [WrappedEventEntry, ...WrappedEventEntry[]]

/** Migrate one session's contiguous v1 notification tail and align its surviving rows. */
function migrateWrappedEventGroup(
  entries: Readonly<WrappedEventGroup>,
): Map<number, Readonly<Record<string, unknown>>[]> {
  const first = entries[0]
  if (!entries.some(entry => entry.event['type'] === 'assistant/chunk')) return new Map()
  const firstSeq = first.event['seq']
  if (!Number.isSafeInteger(firstSeq) || (firstSeq as number) < 0) {
    throw new Error('session event comparison requires a non-negative first seq')
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.event['seq'] !== (firstSeq as number) + index || typeof entry.event['type'] !== 'string') {
      throw new Error(`session event comparison requires a contiguous event tail for ${first.sessionId}`)
    }
  }
  const prefix = Array.from({ length: firstSeq as number }, (_, seq) => ({
    type: 'feedback/record',
    seq,
    time: 0,
    data: { text: `comparison prefix ${String(seq)}` },
  }))
  const migrated = sessionFormatCatalog.migrate({
    header: {
      version: 1,
      id: first.sessionId,
      createdAt: 0,
      isSeeded: false,
      delegationDepth: 0,
    },
    inheritedEventCount: 0,
    events: [...prefix, ...entries.map(entry => normalizeProjectedRow(entry.event))] as never,
  }).events.slice(prefix.length) as readonly Readonly<Record<string, unknown>>[]

  const assigned = new Map<number, Readonly<Record<string, unknown>>[]>()
  let migratedIndex = 0
  let lastChunkRow: number | undefined
  // Catalog validation preserves every non-chunk event's type and order; only a preceding chunk row yields assistant/attempt.
  for (const entry of entries) {
    if (entry.event['type'] === 'assistant/chunk') {
      lastChunkRow = entry.rowIndex
      continue
    }
    while (migrated[migratedIndex]?.['type'] === 'assistant/attempt') {
      assignMigratedEvent(assigned, lastChunkRow as number, migrated[migratedIndex] as Record<string, unknown>)
      migratedIndex += 1
    }
    const next = migrated[migratedIndex] as Readonly<Record<string, unknown>>
    assignMigratedEvent(assigned, entry.rowIndex, restoreProjectedRequestHeader(next, entry.event))
    migratedIndex += 1
  }
  while (migrated[migratedIndex]?.['type'] === 'assistant/attempt') {
    assignMigratedEvent(assigned, lastChunkRow as number, migrated[migratedIndex] as Record<string, unknown>)
    migratedIndex += 1
  }
  return assigned
}

/**
 * Project v1 session-event notifications to current settlement cardinality in memory.
 * Non-event protocol rows retain their exact positions, and current v2 input passes through.
 * @param text - headless `session_event` or SDK `session.event` JSONL.
 * @returns comparison JSONL using current Session events without modifying its source file.
 */
export function prepareSessionEventNotificationsForComparison(text: string): string {
  const trailingNewline = text.endsWith('\n')
  const rows = text.split('\n').filter(line => line.trim().length > 0).map((line, index) => {
    const value: unknown = JSON.parse(line)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`session event comparison line ${String(index + 1)} must be an object`)
    }
    return value as Record<string, unknown>
  })
  const entries = rows.flatMap((row, rowIndex): WrappedEventEntry[] => {
    const wrapped = wrappedSessionEvent(row)
    return wrapped === undefined ? [] : [{ ...wrapped, rowIndex }]
  })
  const groups: WrappedEventGroup[] = []
  for (const entry of entries) {
    const nextSeq = entry.event['seq']
    const group = groups.findLast((candidate) => {
      const previous = candidate.at(-1)
      const previousSeq = previous?.event['seq']
      return previous?.sessionId === entry.sessionId
        && Number.isSafeInteger(previousSeq) && Number.isSafeInteger(nextSeq)
        && nextSeq === (previousSeq as number) + 1
    })
    if (group === undefined) groups.push([entry])
    else group.push(entry)
  }
  const assigned = new Map<number, Readonly<Record<string, unknown>>[]>()
  for (const group of groups) {
    for (const [rowIndex, events] of migrateWrappedEventGroup(group)) assigned.set(rowIndex, events)
  }
  const output = rows.flatMap((row, rowIndex) => {
    const wrapped = wrappedSessionEvent(row)
    if (wrapped === undefined) return [row]
    const migrated = assigned.get(rowIndex)
    if (migrated === undefined) {
      return wrapped.event['type'] === 'assistant/chunk'
        ? []
        : [wrapped.replace(normalizeWrappedEventProvenance(wrapped.event))]
    }
    return migrated.map(event => wrapped.replace(normalizeWrappedEventProvenance(event)))
  }).map(row => JSON.stringify(row)).join('\n')
  return trailingNewline ? `${output}\n` : output
}

/** Encode one migrated fixture while retaining a projected cwd token. */
function encodeCurrentSessionSnapshotFixture(text: string, parsed: ParsedSessionFixture): string {
  const encoded = sessionFormatCatalog.encodeCurrent(parsed.artifact)
  const header = { ...encoded.header }
  const sourceCwd = parsed.sourceHeader['cwd']
  if (typeof sourceCwd === 'string' && /^\{\{cwd\}\}(?:\/|$)/.test(sourceCwd)) header['cwd'] = sourceCwd
  const output = [header, ...encoded.rows].map(record => JSON.stringify(record)).join('\n')
  return text.endsWith('\n') ? `${output}\n` : output
}

/** Restore typed request-header values replaced by snapshot sidecar tokens. */
function normalizeProjectedRow(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const record = { ...source }
  if (record['type'] !== 'request/header') return record
  const data = record['data']
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return record
  const header = (data as Record<string, unknown>)['header']
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return record
  const tools = (header as Record<string, unknown>)['tools']
  let materializedTools: unknown
  if (tools === '{{tools}}') {
    materializedTools = []
  } else if (Array.isArray(tools)
    && tools.every((tool): tool is string => typeof tool === 'string' && tool.length > 0)) {
    materializedTools = tools.map(name => ({ name, description: '', parameters: {} }))
  } else {
    return record
  }
  record['data'] = {
    ...data,
    header: { ...header, tools: materializedTools },
  }
  return record
}

/** Materialize fixture-only header omissions and tokens before physical validation. */
function normalizeProjectedHeader(header: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const normalized = { ...header }
  if (normalized['version'] === 0 && !Object.hasOwn(header, 'delegationDepth')) {
    normalized['delegationDepth'] = 0
  }
  if (typeof header['cwd'] === 'string' && /^\{\{cwd\}\}(?:\/|$)/.test(header['cwd'])) {
    normalized['cwd'] = header['cwd'].replace('{{cwd}}', '/dsh-snapshot-cwd')
  }
  return normalized
}

/** Return how many logical events one physical row contributes for deterministic seq completion. */
function physicalRowCardinality(row: Readonly<Record<string, unknown>>): number {
  if (!PACKED_CHUNK_ROW_TYPES.has(row['type'] as string)) return 1
  const data = row['data']
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 1
  const payload = (data as Record<string, unknown>)[row['type'] === 'tool-call-chunks' ? 'args' : 'texts']
  return Array.isArray(payload) && payload.length > 0 ? payload.length : 1
}

/** Attach the nearest physical source line while preserving unsupported-migration classification. */
function fixtureFormatError(
  error: unknown,
  headerLine: number,
  rowLines: readonly number[],
  eventLines: readonly number[],
  physicalRow?: number,
): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const locationDetail = error instanceof Error && error.cause instanceof Error
    ? error.cause.message
    : detail
  const row = /released (?:Session|(?:text|reasoning|tool-call)-chunks) row (\d+)/.exec(locationDetail)
  const event = /Session event (\d+)/.exec(locationDetail)
    ?? / at seq (\d+)/.exec(locationDetail)
    ?? /^[^ ]+ (\d+) /.exec(locationDetail)
  const line = physicalRow === undefined && row === null
    ? event === null ? headerLine : eventLines[Number(event[1])] ?? headerLine
    : rowLines[physicalRow ?? Number(row?.[1])] ?? headerLine
  const message = `session snapshot line ${line}: ${detail}`
  if (error instanceof SessionFormatUnsupportedMigrationError) {
    return new SessionFormatUnsupportedMigrationError(message, { cause: error })
  }
  return new Error(message, { cause: error })
}

/** Locate range-decoder failures whose frozen diagnostic predates physical-row labels. */
function locateUnlabelledPhysicalFailure(
  error: unknown,
  header: Readonly<Record<string, unknown>>,
  rows: readonly Readonly<Record<string, unknown>>[],
): number | undefined {
  const detail = error instanceof Error ? error.message : String(error)
  if (!detail.startsWith('sourceEventSeqs ')) return undefined
  const diagnosticHeader = Object.hasOwn(header, 'seedLength') ? { ...header, seedLength: 0 } : header
  for (let index = 0; index < rows.length; index += 1) {
    try {
      sessionFormatCatalog.decodeArtifact(diagnosticHeader, rows.slice(0, index + 1))
    } catch (candidate: unknown) {
      const candidateDetail = candidate instanceof Error ? candidate.message : String(candidate)
      if (candidateDetail === detail) return index
    }
  }
  return undefined
}

/**
 * Read replay identity, ordering, and fork-seed facts from the JSONL header.
 *
 * @param text - the raw `.jsonl` file contents; the complete artifact is validated and migrated.
 * @returns the migrated header's `id`, `createdAt`, and exact inherited-event count.
 */
export function parseSessionHeader(text: string): {
  id: string
  createdAt: number
  inheritedEventCount: SessionLogOffsetType
} {
  const parsed = parseSessionFixture(text)
  return {
    id: parsed.id,
    createdAt: parsed.createdAt,
    inheritedEventCount: parsed.inheritedEventCount,
  }
}

/**
 * Reconstruct the per-`stream()` replay script from a recorded session log.
 *
 * Reads one embedded stream from each Assistant settlement. A `compaction/summary` explicitly marked
 * as one local LLM-stream call becomes a canonical successful stream from its
 * complete `rawOutput` at the summary's log position. A
 * missing assistant terminator means the live stream threw, so derivation
 * rejects and the scenario must provide an explicit override. Multiple calls
 * may share one turn and step when the loop retries.
 * @param events - the recorded session's events.
 * @returns one `chunks` entry per recorded model call, in call order.
 */
export function deriveReplayScript(events: SessionEvent[]): ReplayEntry[] {
  const script: ReplayEntry[] = []
  const close = (key: string | undefined, chunks: StreamChunk[]): void => {
    if (chunks.length === 0) return
    if (chunks[chunks.length - 1]?.type !== 'finish') {
      throw new Error(
        `llm-replay: model call ${key} ended without a finish chunk (a thrown stream); `
        + 'this scenario needs a replay.override.json sidecar',
      )
    }
    script.push({ kind: 'chunks', chunks })
  }
  for (const event of events) {
    if (event.type === 'compaction/summary') {
      // JSONL decoding crosses an untyped durable boundary, so retain its wider
      // shape even though current in-process producers enforce this correlation.
      const persisted: {
        readonly llmStreamCall?: true
        readonly rawOutput?: ContentBlock[]
        readonly usage?: TokenUsage
      } = event.data
      if (persisted.llmStreamCall === true) {
        if (persisted.rawOutput === undefined) {
          throw new Error('llm-replay: compaction/summary marks an LLM stream call without rawOutput')
        }
        const chunks: StreamChunk[] = []
        for (const [index, block] of persisted.rawOutput.entries()) {
          chunks.push({ type: 'block-start', index, blockType: block.type })
          chunks.push({ type: 'block-end', index, block })
        }
        if (persisted.usage !== undefined) chunks.push({ type: 'usage', usage: persisted.usage })
        chunks.push({ type: 'finish', reason: { kind: 'stop' } })
        script.push({ kind: 'chunks', chunks })
      }
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const chunks = expandAssistantStream(event.data.stream).map(member => member.chunk)
    close(`${String(event.data.turn)}/${String(event.data.step)}`, chunks)
  }
  return script
}

/**
 * One positional patch in an augmentation sidecar: replaces the derived
 * entry at call index `at` (0-based) with `entry`, or appends when `at`
 * equals the derived length (an extra recorded-after-the-fact call, e.g. the
 * retry attempt following an injected transient throw).
 */
export interface ReplayOverridePatch {
  /** 0-based call index into the derived script; == length appends. */
  at: number
  /** The replacement (or appended) entry at that call position. */
  entry: ReplayEntry
}

/**
 * Override sidecar document: either a whole-script replacement (a
 * bare `ReplayEntry[]`) or the augmentation form `{ patches }`, which keeps
 * the JSONL-derived script and swaps only the named call indexes — the shape
 * for "turn N errors, everything else replays as recorded".
 */
export type ReplayOverrideDoc = ReplayEntry[] | { patches: ReplayOverridePatch[] }

const REPLAY_CHUNK_TYPES = new Set<StreamChunk['type']>([
  'block-start',
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
  'block-end',
  'usage',
  'finish',
])

const FROM_REQUEST_OPEN = '{{fromRequest:'
const FROM_REQUEST_CLOSE = '}}'

/** Collect every string leaf of one JSON-compatible value, in traversal order. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
}

/** Resolve one placeholder pattern against the request corpus; the LAST match wins. */
function resolveFromRequest(pattern: string, corpus: string): string {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'g')
  } catch (error) {
    // RegExp construction only throws SyntaxError; String() carries its message.
    throw new Error(`llm-replay: fromRequest has an invalid pattern ${JSON.stringify(pattern)}: ${String(error)}`)
  }
  let last: RegExpExecArray | undefined
  for (const match of corpus.matchAll(regex)) last = match
  if (last === undefined) {
    throw new Error(`llm-replay: fromRequest pattern ${JSON.stringify(pattern)} matched nothing in the request`)
  }
  return last[1] ?? last[0]
}

/** Replace every `{{fromRequest:<pattern>}}` occurrence in one scripted string. */
function substituteString(text: string, corpus: string): string {
  let result = ''
  let cursor = 0
  while (true) {
    const open = text.indexOf(FROM_REQUEST_OPEN, cursor)
    if (open === -1) return result + text.slice(cursor)
    let close = text.indexOf(FROM_REQUEST_CLOSE, open + FROM_REQUEST_OPEN.length)
    if (close === -1) {
      throw new Error(`llm-replay: fromRequest placeholder is unterminated in ${JSON.stringify(text)}`)
    }
    // The last two braces of a consecutive `}` run terminate the placeholder,
    // so a pattern may end with a brace quantifier like `[0-9a-f]{4}`.
    while (text[close + FROM_REQUEST_CLOSE.length] === '}') close += 1
    const pattern = text.slice(open + FROM_REQUEST_OPEN.length, close)
    result += text.slice(cursor, open) + resolveFromRequest(pattern, corpus)
    cursor = close + FROM_REQUEST_CLOSE.length
  }
}

/** Deep-copy one JSON-compatible value with scripted placeholders resolved. */
function substituteValue(value: unknown, corpus: string): unknown {
  if (typeof value === 'string') {
    return value.includes(FROM_REQUEST_OPEN) ? substituteString(value, corpus) : value
  }
  if (Array.isArray(value)) return value.map(item => substituteValue(item, corpus))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteValue(item, corpus)]))
  }
  return value
}

/**
 * Resolve every `{{fromRequest:<regex>}}` placeholder in one scripted entry
 * against the live request. The corpus is every string leaf of the request
 * messages joined by newlines; the pattern's LAST corpus match wins and its
 * first capture group (or, without one, the whole match) substitutes in place.
 * Scenario sidecars use this to script arguments no static file can know,
 * such as a randomly minted goal id the model must echo back. A pattern that
 * matches nothing, an invalid pattern, and an unterminated placeholder each
 * fail loud. The last two braces of a consecutive `}` run terminate the
 * placeholder, so a pattern may end with a brace quantifier but cannot
 * contain `}}` followed by further pattern content. Derived entries pass
 * through the same resolution as sidecar entries.
 * @param entry - the scripted entry about to replay.
 * @param messages - the live request messages searched by the placeholders.
 * @returns the entry itself when no placeholder appears, else a resolved deep copy.
 */
export function resolveScriptedEntry(entry: ReplayEntry, messages: GenerateOptions['messages']): ReplayEntry {
  if (!JSON.stringify(entry).includes(FROM_REQUEST_OPEN)) return entry
  const leaves: string[] = []
  collectStrings(messages, leaves)
  return substituteValue(entry, leaves.join('\n')) as ReplayEntry
}

/** Replace typed recorded-session tokens with the live sessions bound at the same corpus indexes. */
function materializeSessionTokens(entry: ReplayEntry, liveSessionIds: readonly (string | undefined)[]): ReplayEntry {
  if (!JSON.stringify(entry).includes('{{session:')) return entry
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{\{session:([1-9]\d*)\}\}/g, (_token, ordinal: string) => {
        const live = liveSessionIds[Number(ordinal) - 1]
        if (live === undefined) {
          throw new Error(`llm-replay: session token {{session:${ordinal}}} was used before that recorded session bound`)
        }
        return live
      })
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }
  return replace(entry) as ReplayEntry
}

/** Learn a background child id from the stable tool-result text before that child reaches its first model call. */
function inferStartedSubagents(
  messages: GenerateOptions['messages'],
  liveSessionIds: (string | undefined)[],
): void {
  const leaves: string[] = []
  collectStrings(messages, leaves)
  for (const leaf of leaves) {
    for (const match of leaf.matchAll(/started subagent ([^\s"'<>]+)/g)) {
      const id = match[1]
      /* v8 ignore next -- the fixed regular expression always has capture group 1. */
      if (id === undefined || liveSessionIds.includes(id)) continue
      const index = liveSessionIds.findIndex((value, candidate) => candidate > 0 && value === undefined)
      if (index < 0) return
      liveSessionIds[index] = id
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function invalidOverride(file: string, location: string, detail: string): never {
  throw new Error(`llm-replay: invalid override ${file}: ${location} ${detail}`)
}

function readChunks(value: unknown, file: string, location: string): StreamChunk[] {
  if (!Array.isArray(value)) invalidOverride(file, location, 'chunks must be an array')
  for (const [index, chunk] of value.entries()) {
    if (!isRecord(chunk)
      || typeof chunk['type'] !== 'string'
      || !REPLAY_CHUNK_TYPES.has(chunk['type'] as StreamChunk['type'])) {
      invalidOverride(file, `${location}.chunks[${index}]`, 'must have a known StreamChunk type')
    }
  }
  return value as StreamChunk[]
}

function readReplayEntry(value: unknown, file: string, location: string): ReplayEntry {
  if (!isRecord(value)) invalidOverride(file, location, 'must be an object')
  switch (value['kind']) {
    case 'chunks': {
      if (!hasExactKeys(value, ['kind', 'chunks'])) invalidOverride(file, location, 'has invalid chunks-entry fields')
      return { kind: 'chunks', chunks: readChunks(value['chunks'], file, location) }
    }
    case 'throw': {
      const accepted = value['accepted']
      const keys = accepted === undefined
        ? ['kind', 'chunks', 'message', 'code']
        : ['kind', 'chunks', 'message', 'code', 'accepted']
      if (!hasExactKeys(value, keys)) {
        invalidOverride(file, location, 'has invalid throw-entry fields')
      }
      if (typeof value['message'] !== 'string' || value['message'].length === 0) {
        invalidOverride(file, location, 'message must be a non-empty string')
      }
      if (typeof value['code'] !== 'string' || value['code'].length === 0) {
        invalidOverride(file, location, 'code must be a non-empty string')
      }
      if (accepted !== undefined && typeof accepted !== 'boolean') {
        invalidOverride(file, location, 'accepted must be a boolean')
      }
      return {
        kind: 'throw',
        chunks: readChunks(value['chunks'], file, location),
        message: value['message'],
        code: value['code'],
        ...(accepted === undefined ? {} : { accepted }),
      }
    }
    case 'hang': {
      const readyFile = value['readyFile']
      const keys = readyFile === undefined ? ['kind'] : ['kind', 'readyFile']
      if (!hasExactKeys(value, keys)) invalidOverride(file, location, 'has invalid hang-entry fields')
      if (readyFile !== undefined && (typeof readyFile !== 'string' || readyFile.length === 0)) {
        invalidOverride(file, location, 'readyFile must be a non-empty string')
      }
      return { kind: 'hang', ...(readyFile === undefined ? {} : { readyFile }) }
    }
    default:
      return invalidOverride(file, location, `has unknown kind ${JSON.stringify(value['kind'])}`)
  }
}

function readOverrideDoc(value: unknown, file: string): ReplayOverrideDoc {
  if (Array.isArray(value)) return value.map((entry, index) => readReplayEntry(entry, file, `entry ${index}`))
  if (!isRecord(value) || !hasExactKeys(value, ['patches']) || !Array.isArray(value['patches'])) {
    return invalidOverride(file, 'document', 'must be a ReplayEntry[] or { patches: [...] }')
  }
  return {
    patches: value['patches'].map((value, index): ReplayOverridePatch => {
      const location = `patch ${index}`
      if (!isRecord(value) || !hasExactKeys(value, ['at', 'entry'])) {
        return invalidOverride(file, location, 'must contain exactly at and entry')
      }
      const at = value['at']
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
        return invalidOverride(file, location, 'at must be a non-negative safe integer')
      }
      return { at, entry: readReplayEntry(value['entry'], file, `${location}.entry`) }
    }),
  }
}

/**
 * Load the PRIMARY session's replay script: the sidecar override when present
 * (whole-script replacement or `{ patches }` augmentation over the derived
 * script), else the script derived from the session JSONL (fail-loud when the
 * fixture is missing).
 * @param config - the fixture paths; only `file` and `overrideFile` are consulted.
 * @returns the resolved primary-session script.
 */
export function loadReplayScript(config: ReplayConfig): ReplayEntry[] {
  const fixture = readPrimaryFixture(config)
  return resolveReplayScript(config, fixture)
}

/** Read a primary JSONL unless a whole-script sidecar intentionally occupies the same path. */
function readPrimaryFixture(config: ReplayConfig): ParsedSessionFixture | undefined {
  if (!existsSync(config.file) || config.file === config.overrideFile) return undefined
  return parseSessionFixture(readFileSync(config.file, 'utf8'))
}

/** Resolve an override or derive from one already validated and migrated fixture. */
function resolveReplayScript(
  config: ReplayConfig,
  fixture: ParsedSessionFixture | undefined,
): ReplayEntry[] {
  if (config.overrideFile !== undefined && existsSync(config.overrideFile)) {
    const doc = readOverrideDoc(JSON.parse(readFileSync(config.overrideFile, 'utf8')) as unknown, config.overrideFile)
    if (Array.isArray(doc)) return doc
    const script = deriveScriptFromFixture(config.file, fixture)
    const derivedLength = script.length
    const seenIndexes = new Set<number>()
    for (const patch of doc.patches) {
      if (patch.at > derivedLength) {
        throw new Error(
          `llm-replay: override patch index ${String(patch.at)} out of range `
          + `(derived script has ${derivedLength} call(s); == length appends): ${config.overrideFile}`,
        )
      }
      if (seenIndexes.has(patch.at)) {
        throw new Error(`llm-replay: duplicate override patch index ${patch.at}: ${config.overrideFile}`)
      }
      seenIndexes.add(patch.at)
      script[patch.at] = patch.entry
    }
    return script
  }
  return deriveScriptFromFixture(config.file, fixture)
}

/** Derive a script from an already migrated fixture, failing loud when it is absent. */
function deriveScriptFromFixture(file: string, fixture: ParsedSessionFixture | undefined): ReplayEntry[] {
  if (fixture === undefined) {
    throw new Error(`llm-replay: fixture not found: ${file} — run \`pnpm run test:snapshot:record\` first`)
  }
  return deriveReplayScript(fixture.events)
}

/**
 * Load the primary and child scripts in bind order. Child derivation begins at
 * the v0 header's inherited-event cut so parent chunks are never replayed as child calls.
 *
 * @param config - the fixture paths: the primary log plus any recorded child logs.
 * @returns the primary script first, then the child scripts in bind order.
 */
export function loadSessionScripts(config: ReplayConfig): SessionScript[] {
  const primaryFixture = readPrimaryFixture(config)
  const primaryEntries = resolveReplayScript(config, primaryFixture)
  // The override path replaces the derived script but carries no header; read
  // the header off the JSONL when it exists, else use a stable default so an
  // override-only fixture (header-less) still orders first as the primary.
  const primaryHeader = primaryFixture ?? { id: '', createdAt: 0 }
  const primary: SessionScript = {
    recordedId: primaryHeader.id, createdAt: primaryHeader.createdAt, entries: primaryEntries, primary: true,
  }
  const children: SessionScript[] = []
  for (const childFile of config.childFiles ?? []) {
    if (!existsSync(childFile)) {
      throw new Error(`llm-replay: child fixture not found: ${childFile} — re-record the scenario`)
    }
    const text = readFileSync(childFile, 'utf8')
    const fixture = parseSessionFixture(text)
    // Derive the child's script from its own events only — events AT OR after the seed
    // boundary.
    const ownEvents = fixture.events.slice(fixture.inheritedEventCount)
    children.push({
      recordedId: fixture.id,
      createdAt: fixture.createdAt,
      entries: deriveReplayScript(ownEvents),
      primary: false,
    })
  }
  // Synchronous children start in creation order; the id only stabilizes timestamp ties.
  // XXX(concurrent-subagents): concurrent children need an explicit first-call ordinal.
  children.sort((a, b) => a.createdAt - b.createdAt || a.recordedId.localeCompare(b.recordedId))
  return [primary, ...children]
}

/** Replay adapter that makes a configured provider catalog discoverable without provider I/O. */
class ReplayAdapter extends LlmAdapter {
  private readonly providers: ReadonlyMap<string, ReplayProviderConfig>

  constructor(
    providers: readonly ReplayProviderConfig[],
    private readonly replay: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ) {
    super()
    this.providers = new Map(providers.map(provider => [provider.id, provider]))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const configured = this.providers.get(provider)
    /* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
    if (configured === undefined) return super.providerInfo(provider)
    return { id: provider, name: configured.name ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    const configured = this.providers.get(provider)
    /* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
    if (configured === undefined) return super.providerRetryPolicy(provider)
    return configured.retryPolicy === undefined
      ? undefined
      : resolveRetryPolicy(configured.retryPolicy, `llm-replay: provider "${provider}" retryPolicy`)
  }

  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    const configured = this.providers.get(provider)
    const visualTokens = configured?.models?.find(candidate => candidate.id === model)?.imageRequestTokens
    if (visualTokens === undefined) return undefined
    return {
      priceImages: images => images.map(ref => ({
        visualTokens,
        text: requestImageHandleText(ref, { width: ref.width, height: ref.height }),
      })),
    }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const configured = this.providers.get(provider)
    /* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
    if (configured === undefined) return Promise.resolve([])
    return Promise.resolve((configured.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.providers.get(provider)
    /* v8 ignore next -- LlmRuntime only asks about routes registered from this same map. */
    if (configured === undefined) return Promise.resolve({ provider, id: model, name: model })
    const configuredModel = configured.models?.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configuredModel?.name ?? model,
      ...configuredModel?.description === undefined ? {} : { description: configuredModel.description },
      ...configuredModel?.inputModalities === undefined
        ? {}
        : { inputModalities: [...configuredModel.inputModalities] },
      ...configuredModel?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: configuredModel.contextWindow } },
      ...configuredModel?.defaultMaxTokens === undefined
        ? {}
        : { defaultMaxTokens: configuredModel.defaultMaxTokens },
      ...configuredModel?.reasoningEfforts === undefined
        ? {}
        : {
          reasoning: {
            efforts: configuredModel.reasoningEfforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
            ...configuredModel.defaultReasoningEffort === undefined
              ? {}
              : { defaultEffort: ReasoningEffortId(configuredModel.defaultReasoningEffort) },
          },
        },
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.replay(options)
  }
}

/**
 * Wait `paceMs` between chunk yields, aborting the wait (and the stream) the
 * moment the signal fires — a paced replay must cancel as promptly as a burst
 * one.
 */
function paceDelay(paceMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, paceMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Yield a recorded stream back, honoring abort like a real adapter. */
async function* replayEntry(entry: ReplayEntry, signal: AbortSignal | undefined, paceMs: number): AsyncIterable<StreamChunk> {
  switch (entry.kind) {
    case 'chunks':
      for (const chunk of entry.chunks) {
        if (signal?.aborted) throw new Error('aborted')
        if (paceMs > 0) await paceDelay(paceMs, signal)
        yield chunk
      }
      return
    case 'throw':
      // Replay the THROW branch of the LLM contract: emit whatever the adapter
      // streamed before it threw (so the loop sees the same partial output it
      // saw live), then throw the recorded error (e.g. a provider 401, or a
      // mid-stream STREAM_CLOSED after partial chunks).
      for (const chunk of entry.chunks) {
        if (signal?.aborted) throw new Error('aborted')
        if (paceMs > 0) await paceDelay(paceMs, signal)
        yield chunk
      }
      throw new LlmError(entry.message, entry.code)
    case 'hang':
      // Replay a stream that stalls until cancelled (mirrors MockAdapter): one
      // chunk, then wait for abort and surface it as the consumer expects.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      if (entry.readyFile !== undefined) writeFileSync(entry.readyFile, '')
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return }
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      /* v8 ignore next -- unreachable: the hang promise only ever rejects (on abort), never resolves; control never reaches here */
      return
    /* v8 ignore next -- sidecar entries are validated before they reach the closed local union. */
    default:
      return assertNever(entry, 'llm-replay replay entry')
  }
}

/** Whether the scripted provider call reached the live adapter's post-2xx commit point. */
function providerAccepted(entry: ReplayEntry): boolean {
  switch (entry.kind) {
    case 'chunks':
    case 'hang':
      return true
    case 'throw':
      return entry.accepted ?? entry.chunks.length > 0
    /* v8 ignore next -- override parsing and derived entries close the local union before replay. */
    default:
      return assertNever(entry, 'llm-replay acceptance entry')
  }
}

/**
 * Install per-session positional replay. A newly seen live session takes the
 * next ordered recorded script, then advances its own cursor synchronously at
 * invocation time; calls without `sessionId` share one anonymous session. A
 * non-empty provider catalog registers a routed replay adapter; otherwise a
 * catch-all waterfall intercepts requests.
 *
 * @param ctx - the context whose LLM service receives the replay route or waterfall.
 * @param config - the resolved fixture paths (env-var defaulting is `apply`'s job).
 * @returns the {@link ReplayHandle} carrying the disposer and the teardown consumption check.
 */
export function installLlmReplay(ctx: Context, config: ReplayConfig): ReplayHandle {
  const paceMs = config.paceMs ?? 0
  if (!Number.isInteger(paceMs) || paceMs < 0) {
    throw new Error(`llm-replay: paceMs must be a non-negative integer, got ${String(config.paceMs)}`)
  }
  const scripts = loadSessionScripts(config)
  // Live-session → its bound script + cursor. A new live session id claims the
  // next not-yet-bound script (scripts are in bind order); `nextScript` is the
  // index of the next unclaimed one.
  const bound = new Map<string, { entries: ReplayEntry[]; cursor: number }>()
  const liveSessionIds: (string | undefined)[] = Array.from({ length: scripts.length })
  let nextScript = 0
  const ANON = '\0anon\0' // the key for a call that carries no sessionId
  const replay = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
    const key = options.sessionId ?? ANON
    let state = bound.get(key)
    let unrecorded = false
    if (state === undefined) {
      const script = scripts[nextScript]
      if (script === undefined) {
        // More distinct live sessions made calls than the scenario recorded —
        // an unrecorded subagent appeared. Defer the throw into the returned
        // generator (the listener must return an AsyncIterable, not throw).
        unrecorded = true
        state = { entries: [], cursor: 0 }
      } else {
        const scriptIndex = nextScript
        nextScript++
        state = { entries: script.entries, cursor: 0 }
        bound.set(key, state)
        if (key !== ANON) liveSessionIds[scriptIndex] = key
      }
    }
    const boundState = state
    const seenSessions = nextScript
    const totalScripts = scripts.length
    const index = boundState.cursor++
    const entry: ReplayEntry | undefined = boundState.entries[index]
    return (async function* () {
      if (unrecorded) {
        throw new Error(
          `llm-replay: a model call arrived from an unrecorded session (#${seenSessions + 1}); `
          + `the scenario recorded only ${totalScripts} session(s) — re-record it`,
        )
      }
      if (entry === undefined) {
        throw new Error(
          `llm-replay: script exhausted — session requested model call #${index + 1} `
          + `but its script has only ${boundState.entries.length}; re-record the scenario`,
        )
      }
      inferStartedSubagents(options.messages, liveSessionIds)
      const resolved = resolveScriptedEntry(materializeSessionTokens(entry, liveSessionIds), options.messages)
      if (options.provider === 'deepseek-official' && providerAccepted(resolved)) {
        const extensions = ctx.get('deepseekLlmApiExtensions')
        if (extensions !== undefined) {
          const signal = options.signal ?? new AbortController().signal
          const prepared = await extensions.prepare({
            // Replay reproduces post-2xx side effects, not the provider wire body.
            body: { messages: [] },
            signal,
            ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
            ...options.purpose === undefined ? {} : { purpose: options.purpose },
          })
          await prepared.accept()
        }
      }
      yield* replayEntry(resolved, options.signal, paceMs)
    })()
  }
  const providers = config.providers ?? []
  const dispose = providers.length > 0
    ? ctx.llm.registerAdapter(providers.map(provider => provider.id), new ReplayAdapter(providers, replay))
    : ctx.on('llm/stream', (options: GenerateOptions, _next) => replay(options))
  return {
    dispose,
    assertConsumed(): void {
      const problems: string[] = []
      if (nextScript < scripts.length) {
        problems.push(`${scripts.length - nextScript} recorded script(s) never bound to a live session`)
      }
      for (const [key, state] of bound) {
        if (state.cursor < state.entries.length) {
          const who = key === ANON ? 'the anonymous session' : `session ${key}`
          problems.push(`${who} consumed ${state.cursor}/${state.entries.length} recorded call(s)`)
        }
      }
      if (problems.length > 0) {
        throw new Error(`llm-replay: fixture not fully consumed — ${problems.join('; ')}; the scenario drove fewer model calls than recorded`)
      }
    },
  }
}

export const name = 'llm-replay'
export const inject = ['llm']

/** Plugin config: the {@link ReplayConfig} inputs, each defaulting to its `DSH_SNAPSHOT_*` env var in `apply`. */
export interface Config {
  /** Override the fixture path; defaults to `$DSH_SNAPSHOT_FILE`. */
  file?: string
  /** Override the sidecar path; defaults to `$DSH_SNAPSHOT_OVERRIDE`. */
  overrideFile?: string
  /**
   * Override the child-log paths; defaults to `$DSH_SNAPSHOT_CHILD_FILES` (a
   * path-separator-delimited list). Each is a recorded subagent session log for
   * a nested-agent scenario; absent/empty for a single-session scenario.
   */
  childFiles?: string[]
  /** Optional replay-only provider catalog; absent or empty selects catch-all waterfall replay. */
  providers?: ReplayProviderConfig[]
  /** Optional per-chunk pacing delay in ms (see {@link ReplayConfig.paceMs}); absent keeps burst yield. */
  paceMs?: number
}

function validateConfiguredModels(providers: ReplayProviderConfig[] | undefined): void {
  for (const provider of providers ?? []) {
    for (const model of provider.models ?? []) {
      const modalities: unknown = model.inputModalities
      if (modalities !== undefined && (!Array.isArray(modalities)
        || !modalities.every((modality: unknown) => modality === 'text' || modality === 'image'))) {
        throw new Error(
          `llm-replay: provider "${provider.id}" model "${model.id}" inputModalities `
          + 'must be an array containing only "text" and "image"',
        )
      }
      const imageRequestTokens: unknown = model.imageRequestTokens
      if (imageRequestTokens !== undefined
        && (!Number.isSafeInteger(imageRequestTokens) || (imageRequestTokens as number) <= 0)) {
        throw new Error(
          `llm-replay: provider "${provider.id}" model "${model.id}" imageRequestTokens `
          + 'must be a positive safe integer',
        )
      }
      // A text-only route never sends visual tokens: LlmRuntime substitutes
      // its images with deterministic text before dispatch, so declared
      // visual pricing would contradict the actual request projection.
      if (imageRequestTokens !== undefined && model.inputModalities?.includes('image') !== true) {
        throw new Error(
          `llm-replay: provider "${provider.id}" model "${model.id}" imageRequestTokens `
          + 'requires inputModalities to include "image"',
        )
      }
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const file = config.file ?? process.env.DSH_SNAPSHOT_FILE
  if (file === undefined || file.length === 0) {
    throw new Error('llm-replay: a fixture path is required (Config.file or $DSH_SNAPSHOT_FILE)')
  }
  validateConfiguredModels(config.providers)
  const overrideFile = config.overrideFile ?? process.env.DSH_SNAPSHOT_OVERRIDE
  const childEnv = process.env.DSH_SNAPSHOT_CHILD_FILES
  const childFiles = config.childFiles
    ?? (childEnv !== undefined && childEnv.length > 0 ? childEnv.split(pathDelimiter) : [])
  installLlmReplay(ctx, {
    file,
    ...overrideFile !== undefined && overrideFile.length > 0 ? { overrideFile } : {},
    ...childFiles.length > 0 ? { childFiles } : {},
    ...config.providers !== undefined ? { providers: config.providers } : {},
    ...config.paceMs !== undefined ? { paceMs: config.paceMs } : {},
  })
}
