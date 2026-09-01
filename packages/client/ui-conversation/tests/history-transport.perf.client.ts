/** Opt-in synthetic benchmark for packed session-history transport and exact replay. */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { performance } from 'node:perf_hooks'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isChunkRow, packChunkRuns } from '@deepseek-ai/dsh-session/chunk-rows'
import type { ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {
  ChunkRowEvent,
  SessionEventEntry,
  SessionHistoryRecord,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { historyEntries } from '@deepseek-ai/dsh-api-session-controller/src/client/sessions/history-records.ts'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationNodeDefinition,
  ConversationViewDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const LOGICAL_EVENTS = 416_756
const DELTA_EVENTS = 416_176
const ORDINARY_EVENTS = LOGICAL_EVENTS - DELTA_EVENTS
const DELTA_RUNS = 116
const TIME_ZERO = 1_700_000_000_000

interface Timed<T> {
  readonly value: T
  readonly ms: number
}

interface HeapPeaks<T> {
  readonly value: T
  readonly medianPeakBytes: number
  readonly peakBytes: readonly number[]
}

interface TransferSample {
  readonly headersMs: number
  readonly bodyMs: number
  readonly totalMs: number
}

interface TransferTimings {
  readonly headersMs: number
  readonly bodyMs: number
  readonly totalMs: number
  readonly samples: readonly TransferSample[]
}

interface FoldState {
  readonly blocks: readonly string[]
  readonly deltaCount: number
  readonly lastDeltaSeq?: number
  readonly firstTokenTime?: number
  readonly firstVisibleSeq?: number
  readonly firstVisibleTime?: number
}

interface FoldSnapshots {
  readonly chat: unknown
  readonly trajectory: unknown
}

interface RawHistoryValue {
  readonly events: SessionEventEntry[]
  readonly hasMore: boolean
}

interface PackedHistoryValue {
  readonly records: SessionHistoryRecord[]
  readonly hasMore: boolean
}

const safeIntegerSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
const sessionWireEventSchema = z.object({
  type: z.string(),
  seq: safeIntegerSchema,
  time: safeIntegerSchema,
  data: z.json(),
  ignorable: z.literal(true).optional(),
  sourceEventSeqs: z.array(safeIntegerSchema).optional(),
  surfaceOp: z.json().optional(),
}).strict()
const historyEntrySchema = z.object({
  type: z.literal('event'),
  event: sessionWireEventSchema,
}).strict()
const chunkRunBaseSchema = {
  turn: z.number(),
  step: z.number(),
  index: z.number(),
  dt: z.array(safeIntegerSchema),
}
const textChunkEventSchema = z.object({
  type: z.enum(['chunkrow/text-chunks', 'chunkrow/reasoning-chunks']),
  seq: safeIntegerSchema.nonnegative(),
  time: safeIntegerSchema,
  data: z.object({
    ...chunkRunBaseSchema,
    texts: z.array(z.string()).min(1),
  }).strict(),
}).strict()
const toolCallChunkEventSchema = z.object({
  type: z.literal('chunkrow/tool-call-chunks'),
  seq: safeIntegerSchema.nonnegative(),
  time: safeIntegerSchema,
  data: z.object({
    ...chunkRunBaseSchema,
    id: z.string(),
    name: z.string().optional(),
    args: z.array(z.string()).min(1),
  }).strict(),
}).strict()
const chunkEventSchema: z.ZodType<ChunkRowEvent> = z.discriminatedUnion('type', [
  textChunkEventSchema,
  toolCallChunkEventSchema,
]).superRefine((event, context) => {
  const members = event.type === 'chunkrow/tool-call-chunks' ? event.data.args : event.data.texts
  if (event.data.dt.length !== members.length - 1) {
    context.addIssue({
      code: 'custom',
      message: 'packed chunk dt length must be one less than member count',
      path: ['data', 'dt'],
    })
  }
  if (members.length - 1 > Number.MAX_SAFE_INTEGER - event.seq) {
    context.addIssue({ code: 'custom', message: 'packed chunk seqs must stay safe integers', path: ['seq'] })
  }
  let time = event.time
  for (let index = 0; index < event.data.dt.length; index++) {
    time += event.data.dt[index] as number
    if (Number.isSafeInteger(time)) continue
    context.addIssue({
      code: 'custom',
      message: 'packed chunk times must stay safe integers',
      path: ['data', 'dt', index],
    })
    break
  }
}) as z.ZodType<ChunkRowEvent>
const packedHistoryValueSchema: z.ZodType<PackedHistoryValue> = z.object({
  records: z.array(z.union([
    historyEntrySchema,
    z.object({ type: z.literal('chunks'), event: chunkEventSchema }).strict(),
  ])),
  hasMore: z.boolean(),
}) as z.ZodType<PackedHistoryValue>
const rawSessionHistoryValueSchema: z.ZodType<RawHistoryValue> = z.object({
  events: z.array(historyEntrySchema),
  hasMore: z.boolean(),
}) as z.ZodType<RawHistoryValue>

function timed<T>(run: () => T): Timed<T> {
  const start = performance.now()
  const value = run()
  return { value, ms: performance.now() - start }
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

function reduction(before: number, after: number): number {
  return rounded((1 - after / before) * 100)
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor(ordered.length / 2)]!
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error) }
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', failed)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('history transport benchmark server has no TCP port')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

async function loopbackTransfer(json: string): Promise<TransferTimings> {
  const server = createServer((_request, response) => {
    // Production Response.json reaches the bridge without content-length, so
    // leave Node's response chunked for the same body-transfer behavior.
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write(json)
    response.end()
  })
  const port = await listen(server)
  const once = async (): Promise<TransferSample> => {
    const started = performance.now()
    const response = await fetch(`http://127.0.0.1:${String(port)}/`)
    const headers = performance.now()
    const body = await response.text()
    const completed = performance.now()
    if (body !== json) throw new Error('history transport benchmark received a changed body')
    return {
      headersMs: headers - started,
      bodyMs: completed - headers,
      totalMs: completed - started,
    }
  }
  try {
    await once()
    const samples: TransferSample[] = []
    for (let index = 0; index < 5; index++) samples.push(await once())
    return {
      headersMs: median(samples.map(sample => sample.headersMs)),
      bodyMs: median(samples.map(sample => sample.bodyMs)),
      totalMs: median(samples.map(sample => sample.totalMs)),
      samples,
    }
  } finally {
    await close(server)
  }
}

/** Measure caller-sampled additional V8 heap from forced-GC baselines. */
function sampledPeakHeap<T>(run: (sample: () => void) => T): HeapPeaks<T> {
  const forceGc = globalThis.gc
  if (forceGc === undefined) {
    throw new Error('history transport memory benchmark requires Vitest worker --expose-gc')
  }
  const samples = Array.from({ length: 3 }, () => {
    forceGc()
    forceGc()
    const baseline = process.memoryUsage().heapUsed
    let peak = baseline
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }
    const value = run(sample)
    sample()
    return { value, peakBytes: peak - baseline }
  })
  return {
    value: samples[0]!.value,
    medianPeakBytes: median(samples.map(sample => sample.peakBytes)),
    peakBytes: samples.map(sample => sample.peakBytes),
  }
}

function append<Type extends keyof SessionEventMap>(
  events: SessionEvent[],
  type: Type,
  data: SessionEventMap[Type],
  options: { readonly surfaceOp?: 'append'; readonly ignorable?: true } = {},
): void {
  const seq = events.length
  events.push({ type, seq, time: TIME_ZERO + seq, data, ...options } as SessionEvent<Type>)
}

function appendSeparator(events: SessionEvent[], run: number, separator: number): void {
  const seq = events.length
  events.push({
    type: 'benchmark/separator',
    seq,
    time: TIME_ZERO + seq,
    data: { run, separator },
    ignorable: true,
  } as SessionEvent)
}

function fragment(run: number, index: number): string {
  const value = (Math.imul(run + 1, 0x9E3779B1) ^ Math.imul(index + 1, 0x85EBCA6B)) >>> 0
  return value.toString(36).padStart(7, '0').slice(-2)
}

/** Build the private sample's event/run cardinality from deterministic synthetic content. */
function buildEvents(): SessionEvent[] {
  const events: SessionEvent[] = []
  append(events, 'turn/start', { turn: 1 })
  append(events, 'user/message', createUserMessage({
    content: [{ type: 'text', text: 'synthetic history transport benchmark' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  append(events, 'step/start', { turn: 1, step: 1 })

  const baseRunLength = Math.floor(DELTA_EVENTS / DELTA_RUNS)
  const longerRuns = DELTA_EVENTS % DELTA_RUNS
  for (let run = 0; run < DELTA_RUNS; run++) {
    const runLength = baseRunLength + (run < longerRuns ? 1 : 0)
    for (let index = 0; index < runLength; index++) {
      append(events, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: {
          type: 'reasoning-delta',
          index: run,
          text: fragment(run, index),
        },
      })
    }
    const separators = run < 3 ? 4 : 5
    for (let separator = 0; separator < separators; separator++) {
      appendSeparator(events, run, separator)
    }
  }
  return events
}

function memberTime(event: ChunkRowEvent, index: number): number {
  let time = event.time
  for (let cursor = 0; cursor < index; cursor++) time += event.data.dt[cursor] as number
  return time
}

function foldDefinition(kind: string, target: string): ConversationNodeDefinition<FoldState> {
  return {
    kind,
    target,
    match: (event) => {
      if (event.type === 'step/start') return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'start' }
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'reasoning-delta') {
        return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'update' }
      }
      if (event.type === 'chunkrow/reasoning-chunks') {
        return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'update' }
      }
      return null
    },
    start: () => ({ blocks: [], deltaCount: 0 }),
    update: (context, match) => {
      if (match.event.type === 'chunkrow/reasoning-chunks') {
        const event = match.event
        const blocks = [...context.state.blocks]
        blocks[event.data.index] = (blocks[event.data.index] ?? '') + event.data.texts.join('')
        const firstToken = event.data.texts.findIndex(text => text !== '')
        const firstVisible = event.data.texts.findIndex(text => text.trim() !== '')
        return {
          ...context.state,
          blocks,
          deltaCount: context.state.deltaCount + event.data.texts.length,
          lastDeltaSeq: event.seq + event.data.texts.length - 1,
          ...context.state.firstTokenTime === undefined && firstToken >= 0
            ? { firstTokenTime: memberTime(event, firstToken) }
            : {},
          ...context.state.firstVisibleSeq === undefined && firstVisible >= 0
            ? {
              firstVisibleSeq: event.seq + firstVisible,
              firstVisibleTime: memberTime(event, firstVisible),
            }
            : {},
        }
      }
      if (match.event.type !== 'assistant/chunk' || match.event.data.chunk.type !== 'reasoning-delta') {
        return context.state
      }
      const chunk = match.event.data.chunk
      const blocks = [...context.state.blocks]
      blocks[chunk.index] = (blocks[chunk.index] ?? '') + chunk.text
      const visible = blocks.some(block => block.trim() !== '')
      return {
        ...context.state,
        blocks,
        deltaCount: context.state.deltaCount + 1,
        lastDeltaSeq: match.event.seq,
        ...context.state.firstTokenTime === undefined ? { firstTokenTime: match.event.time } : {},
        ...visible && context.state.firstVisibleSeq === undefined
          ? { firstVisibleSeq: match.event.seq, firstVisibleTime: match.event.time }
          : {},
      }
    },
    buildViewNode: context => context.state === undefined
      ? null
      : {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target,
        data: context.state,
      },
  }
}

function viewDefinition(target: string): ConversationViewDefinition<ConversationViewNode, readonly ConversationViewNode[]> {
  return {
    target,
    create: () => ({
      empty: [],
      replace: ({ nodes }) => nodes,
      apply: ({ upserts }) => upserts,
    }),
  }
}

function wireEntry(event: SessionEvent): SessionEventEntry {
  return { type: 'event', event: event as unknown as SessionWireEvent }
}

function wireEntries(events: readonly SessionEvent[]): SessionEventEntry[] {
  return events.map(wireEntry)
}

function chunkEntry(row: ChunkRow): SessionHistoryRecord {
  return {
    type: 'chunks',
    event: {
      type: `chunkrow/${row.type}`,
      seq: row.seq0,
      time: row.time0,
      data: row.data,
    } as ChunkRowEvent,
  }
}

function historyRecord(record: SessionEvent | ChunkRow): SessionHistoryRecord {
  return isChunkRow(record) ? chunkEntry(record) : wireEntry(record)
}

function assemble(entries: readonly SessionEventLikeEntry[]): FoldSnapshots {
  const definitions = [
    foldDefinition('benchmark-chat-assistant', 'chat'),
    foldDefinition('benchmark-trajectory-assistant', 'trajectory'),
  ]
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [viewDefinition('chat'), viewDefinition('trajectory')] },
  )
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  assembler.activateTarget('trajectory')
  return {
    chat: assembler.snapshot('chat'),
    trajectory: assembler.snapshot('trajectory'),
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

it('reports packed history transport and exact replay costs', async () => {
  const fixture = timed(buildEvents)

  assemble(historyEntries(wireEntries(fixture.value.slice(0, 1_000))))
  const rawHostHeap = sampledPeakHeap((sample) => {
    const entries = wireEntries(fixture.value)
    sample()
    const json = JSON.stringify({ events: entries, hasMore: false } satisfies RawHistoryValue)
    sample()
    return Buffer.byteLength(json)
  })
  const packedHostHeap = sampledPeakHeap((sample) => {
    const packedEvents = packChunkRuns(fixture.value)
    sample()
    const records = packedEvents.map(historyRecord)
    sample()
    const json = JSON.stringify({
      records,
      hasMore: false,
    } satisfies PackedHistoryValue)
    sample()
    return Buffer.byteLength(json)
  })

  const rawEntries = timed(() => wireEntries(fixture.value))
  const packed = timed(() => packChunkRuns(fixture.value))
  const packedRecords = timed(() => packed.value.map(historyRecord))
  const rawValue: RawHistoryValue = { events: rawEntries.value, hasMore: false }
  const packedValue: PackedHistoryValue = {
    records: packedRecords.value,
    hasMore: false,
  }

  const rawJson = timed(() => JSON.stringify(rawValue))
  const packedJson = timed(() => JSON.stringify(packedValue))
  const rawGzip = timed(() => gzipSync(rawJson.value).byteLength)
  const packedGzip = timed(() => gzipSync(packedJson.value).byteLength)
  const rawBrotli = timed(() => brotliCompressSync(rawJson.value).byteLength)
  const packedBrotli = timed(() => brotliCompressSync(packedJson.value).byteLength)
  const rawTransfer = await loopbackTransfer(rawJson.value)
  const packedTransfer = await loopbackTransfer(packedJson.value)

  const rawClientHeap = sampledPeakHeap((sample) => {
    const wire: unknown = JSON.parse(rawJson.value)
    sample()
    const parsed = rawSessionHistoryValueSchema.parse(wire)
    sample()
    const prepared = historyEntries(parsed.events)
    sample()
    const folded = assemble(prepared)
    sample()
    return digest(folded)
  })
  const packedClientHeap = sampledPeakHeap((sample) => {
    const wire: unknown = JSON.parse(packedJson.value)
    sample()
    const parsed = packedHistoryValueSchema.parse(wire)
    sample()
    const prepared = historyEntries(parsed.records)
    sample()
    const folded = assemble(prepared)
    sample()
    return digest(folded)
  })

  const parsedRaw = timed((): unknown => JSON.parse(rawJson.value))
  const parsedPacked = timed((): unknown => JSON.parse(packedJson.value))
  const rawValidation = timed(() => rawSessionHistoryValueSchema.parse(parsedRaw.value))
  const packedValidation = timed(() => packedHistoryValueSchema.parse(parsedPacked.value))
  const rawPreparation = timed(() => historyEntries(rawValidation.value.events))
  const packedPreparation = timed(() => historyEntries(packedValidation.value.records))

  assemble(rawPreparation.value.slice(0, 1_000))
  assemble(packedPreparation.value)
  const rawFold = timed(() => assemble(rawPreparation.value))
  const packedFold = timed(() => assemble(packedPreparation.value))

  const rawBytes = Buffer.byteLength(rawJson.value)
  const packedBytes = Buffer.byteLength(packedJson.value)
  const packedRows = packed.value.filter(isChunkRow)
  expect(fixture.value).toHaveLength(LOGICAL_EVENTS)
  expect(fixture.value.filter(event => event.type !== 'assistant/chunk')).toHaveLength(ORDINARY_EVENTS)
  expect(packedRows).toHaveLength(DELTA_RUNS)
  expect(packed.value).toHaveLength(696)
  expect(packedPreparation.value).toHaveLength(696)
  expect(digest(packedFold.value)).toBe(digest(rawFold.value))
  expect(packedClientHeap.value).toBe(rawClientHeap.value)
  expect(rawHostHeap.value).toBe(rawBytes)
  expect(packedHostHeap.value).toBe(packedBytes)
  expect(packedBytes).toBeLessThan(rawBytes)

  const rawResponseMs = rawEntries.ms + rawJson.ms
  const packedResponseMs = packed.ms + packedRecords.ms + packedJson.ms
  const rawClientMs = parsedRaw.ms + rawValidation.ms + rawPreparation.ms + rawFold.ms
  const packedClientMs = parsedPacked.ms + packedValidation.ms + packedPreparation.ms + packedFold.ms
  const rawSyntheticApiWaitMs = rawResponseMs + rawTransfer.totalMs + parsedRaw.ms + rawValidation.ms
  const packedSyntheticApiWaitMs = packedResponseMs + packedTransfer.totalMs + parsedPacked.ms + packedValidation.ms
  const rawSyntheticReadyMs = rawResponseMs + rawTransfer.totalMs + rawClientMs
  const packedSyntheticReadyMs = packedResponseMs + packedTransfer.totalMs + packedClientMs
  process.stdout.write(`HISTORY_TRANSPORT_PERF_RESULT ${JSON.stringify({
    fixture: {
      buildMs: rounded(fixture.ms),
      logicalEvents: fixture.value.length,
      ordinaryEvents: ORDINARY_EVENTS,
      deltaEvents: DELTA_EVENTS,
      deltaRuns: packedRows.length,
      packedRecords: packed.value.length,
      conversationInputs: packedPreparation.value.length,
    },
    bytes: {
      rawJson: rawBytes,
      packedJson: packedBytes,
      jsonReductionPct: reduction(rawBytes, packedBytes),
      rawGzip: rawGzip.value,
      packedGzip: packedGzip.value,
      gzipReductionPct: reduction(rawGzip.value, packedGzip.value),
      rawBrotli: rawBrotli.value,
      packedBrotli: packedBrotli.value,
      brotliReductionPct: reduction(rawBrotli.value, packedBrotli.value),
    },
    memory: {
      samples: 3,
      rawHostAdditionalHeapPeakBytes: rawHostHeap.medianPeakBytes,
      packedHostAdditionalHeapPeakBytes: packedHostHeap.medianPeakBytes,
      hostReductionPct: reduction(rawHostHeap.medianPeakBytes, packedHostHeap.medianPeakBytes),
      rawClientAdditionalHeapPeakBytes: rawClientHeap.medianPeakBytes,
      packedClientAdditionalHeapPeakBytes: packedClientHeap.medianPeakBytes,
      clientReductionPct: reduction(rawClientHeap.medianPeakBytes, packedClientHeap.medianPeakBytes),
      rawHostPeakSamples: rawHostHeap.peakBytes,
      packedHostPeakSamples: packedHostHeap.peakBytes,
      rawClientPeakSamples: rawClientHeap.peakBytes,
      packedClientPeakSamples: packedClientHeap.peakBytes,
    },
    host: {
      rawEntryWrapMs: rounded(rawEntries.ms),
      packMs: rounded(packed.ms),
      packedRecordWrapMs: rounded(packedRecords.ms),
      rawStringifyMs: rounded(rawJson.ms),
      packedStringifyMs: rounded(packedJson.ms),
      rawGzipMs: rounded(rawGzip.ms),
      packedGzipMs: rounded(packedGzip.ms),
      rawBrotliMs: rounded(rawBrotli.ms),
      packedBrotliMs: rounded(packedBrotli.ms),
      rawResponseMs: rounded(rawResponseMs),
      packedResponseMs: rounded(packedResponseMs),
      responseReductionPct: reduction(rawResponseMs, packedResponseMs),
    },
    transport: {
      samples: 5,
      rawHeadersMs: rounded(rawTransfer.headersMs),
      packedHeadersMs: rounded(packedTransfer.headersMs),
      rawBodyMs: rounded(rawTransfer.bodyMs),
      packedBodyMs: rounded(packedTransfer.bodyMs),
      rawTotalMs: rounded(rawTransfer.totalMs),
      packedTotalMs: rounded(packedTransfer.totalMs),
      totalReductionPct: reduction(rawTransfer.totalMs, packedTransfer.totalMs),
      rawSamples: rawTransfer.samples.map(sample => ({
        headersMs: rounded(sample.headersMs),
        bodyMs: rounded(sample.bodyMs),
        totalMs: rounded(sample.totalMs),
      })),
      packedSamples: packedTransfer.samples.map(sample => ({
        headersMs: rounded(sample.headersMs),
        bodyMs: rounded(sample.bodyMs),
        totalMs: rounded(sample.totalMs),
      })),
    },
    client: {
      rawParseMs: rounded(parsedRaw.ms),
      packedParseMs: rounded(parsedPacked.ms),
      rawValidationMs: rounded(rawValidation.ms),
      packedValidationMs: rounded(packedValidation.ms),
      rawPrepareMs: rounded(rawPreparation.ms),
      packedPrepareMs: rounded(packedPreparation.ms),
      rawFoldMs: rounded(rawFold.ms),
      packedFoldMs: rounded(packedFold.ms),
      rawHistoryMs: rounded(rawClientMs),
      packedHistoryMs: rounded(packedClientMs),
      historyReductionPct: reduction(rawClientMs, packedClientMs),
    },
    combined: {
      rawSyntheticApiWaitMs: rounded(rawSyntheticApiWaitMs),
      packedSyntheticApiWaitMs: rounded(packedSyntheticApiWaitMs),
      syntheticApiWaitReductionPct: reduction(rawSyntheticApiWaitMs, packedSyntheticApiWaitMs),
      rawSyntheticReadyMs: rounded(rawSyntheticReadyMs),
      packedSyntheticReadyMs: rounded(packedSyntheticReadyMs),
      syntheticReadyReductionPct: reduction(rawSyntheticReadyMs, packedSyntheticReadyMs),
    },
  })}\n`)
}, 600_000)

it('reports compact folding cost for long whitespace-prefix runs', () => {
  historyEntries([{
    type: 'chunks',
    event: {
      type: 'chunkrow/reasoning-chunks',
      seq: 0,
      time: TIME_ZERO,
      data: { turn: 1, step: 1, index: 0, dt: [], texts: ['x'] },
    },
  }])
  const results = [10_000, 20_000, 40_000].map((members) => {
    const record: SessionHistoryRecord = {
      type: 'chunks',
      event: {
        type: 'chunkrow/reasoning-chunks',
        seq: 1,
        time: TIME_ZERO + 1,
        data: {
          turn: 1,
          step: 1,
          index: 0,
          dt: Array.from({ length: members - 1 }, () => 1),
          texts: Array.from({ length: members }, (_, index) => index === members - 1 ? 'x' : ' '),
        },
      },
    }
    const start = wireEntry({
      type: 'step/start',
      seq: 0,
      time: TIME_ZERO,
      data: { turn: 1, step: 1 },
    })
    const inputs = historyEntries([start, record])
    const folded = assemble(inputs)
    const samplesMs = Array.from({ length: 5 }, () => timed(() => assemble(inputs)).ms)
    expect((folded.chat as readonly { readonly data: FoldState }[])[0]?.data).toMatchObject({
      deltaCount: members,
      lastDeltaSeq: members,
      firstVisibleSeq: members,
      firstVisibleTime: TIME_ZERO + members,
    })
    return {
      members,
      medianMs: rounded(median(samplesMs)),
      samplesMs: samplesMs.map(rounded),
    }
  })
  process.stdout.write(`HISTORY_WHITESPACE_PREFIX_PERF_RESULT ${JSON.stringify(results)}\n`)
})
