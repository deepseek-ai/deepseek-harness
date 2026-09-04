/** Opt-in synthetic benchmark for v2 embedded Assistant stream history. */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { performance } from 'node:perf_hooks'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  createAssistantMessage,
  createUserMessage,
  expandAssistantStream,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {
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

const LOGICAL_ITEMS = 416_756
const STREAM_MEMBERS = 416_176
const DURABLE_EVENTS = LOGICAL_ITEMS - STREAM_MEMBERS
const COMPACT_RECORDS = 116
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
  readonly memberCount: number
  readonly lastMemberIndex?: number
  readonly firstTokenTime?: number
  readonly firstVisibleIndex?: number
  readonly firstVisibleTime?: number
}

interface FoldSnapshots {
  readonly chat: unknown
  readonly trajectory: unknown
}

interface HistoryValue {
  readonly records: SessionHistoryRecord[]
  readonly hasMore: boolean
}

interface HistoryFixture {
  readonly rawEvents: readonly SessionEvent[]
  readonly compactEvents: readonly SessionEvent[]
  readonly rawRecordCount: number
  readonly compactRecordCount: number
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
const historyValueSchema: z.ZodType<HistoryValue> = z.object({
  records: z.array(historyEntrySchema),
  hasMore: z.boolean(),
}) as z.ZodType<HistoryValue>

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
  if (address === null || typeof address === 'string') {
    throw new Error('history transport benchmark server has no TCP port')
  }
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

function appendSeparator(events: SessionEvent[], separator: number): void {
  const seq = events.length
  events.push({
    type: 'benchmark/separator',
    seq,
    time: TIME_ZERO + seq,
    data: { separator },
    ignorable: true,
  } as SessionEvent)
}

function fragment(run: number, index: number): string {
  const value = (Math.imul(run + 1, 0x9E3779B1) ^ Math.imul(index + 1, 0x85EBCA6B)) >>> 0
  return value.toString(36).padStart(7, '0').slice(-2)
}

/** Build equal v2 histories whose single Assistant row uses raw or compact stream records. */
function buildFixture(): HistoryFixture {
  const rawStream: AssistantStreamRecord[] = []
  const compactStream: AssistantStreamRecord[] = []
  const blocks: { readonly type: 'reasoning'; readonly text: string }[] = []
  const baseRunLength = Math.floor(STREAM_MEMBERS / COMPACT_RECORDS)
  const longerRuns = STREAM_MEMBERS % COMPACT_RECORDS
  let member = 0
  for (let run = 0; run < COMPACT_RECORDS; run++) {
    const runLength = baseRunLength + (run < longerRuns ? 1 : 0)
    const texts = Array.from({ length: runLength }, (_, index) => fragment(run, index))
    compactStream.push({
      type: 'reasoning-chunks',
      time0: TIME_ZERO + member,
      index: run,
      dt: Array.from({ length: runLength - 1 }, () => 1),
      texts,
    })
    for (const text of texts) {
      rawStream.push({
        type: 'chunk',
        time: TIME_ZERO + member,
        chunk: { type: 'reasoning-delta', index: run, text },
      })
      member += 1
    }
    blocks.push({ type: 'reasoning', text: texts.join('') })
  }

  const message = createAssistantMessage({
    content: blocks,
    source: { provider: 'benchmark', model: 'synthetic-v2' },
  })
  const prefix: SessionEvent[] = []
  append(prefix, 'turn/start', { turn: 1 })
  append(prefix, 'user/message', createUserMessage({
    content: [{ type: 'text', text: 'synthetic history transport benchmark' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  append(prefix, 'step/start', { turn: 1, step: 1 })
  for (let separator = 0; separator < DURABLE_EVENTS - 4; separator++) {
    appendSeparator(prefix, separator)
  }

  const rawEvents = [...prefix]
  const compactEvents = [...prefix]
  append(rawEvents, 'assistant/message', { turn: 1, step: 1, message, stream: rawStream }, { surfaceOp: 'append' })
  append(compactEvents, 'assistant/message', {
    turn: 1, step: 1, message, stream: compactStream,
  }, { surfaceOp: 'append' })
  return {
    rawEvents,
    compactEvents,
    rawRecordCount: rawStream.length,
    compactRecordCount: compactStream.length,
  }
}

function foldDefinition(kind: string, target: string): ConversationNodeDefinition<FoldState> {
  return {
    kind,
    target,
    match: (event) => {
      if (event.type === 'step/start') {
        return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'start' }
      }
      if (event.type === 'assistant/message') {
        return { id: `${String(event.data.turn)}:${String(event.data.step)}`, role: 'update' }
      }
      return null
    },
    start: () => ({ blocks: [], memberCount: 0 }),
    update: (context, match) => {
      if (match.event.type !== 'assistant/message') return context.state
      const blocks = [...context.state.blocks]
      let memberCount = context.state.memberCount
      let firstTokenTime = context.state.firstTokenTime
      let firstVisibleIndex = context.state.firstVisibleIndex
      let firstVisibleTime = context.state.firstVisibleTime
      for (const timedChunk of expandAssistantStream(match.event.data.stream)) {
        if (timedChunk.chunk.type !== 'reasoning-delta') continue
        const chunk = timedChunk.chunk
        blocks[chunk.index] = (blocks[chunk.index] ?? '') + chunk.text
        memberCount += 1
        firstTokenTime ??= timedChunk.time
        if (firstVisibleIndex === undefined && blocks.some(block => block.trim() !== '')) {
          firstVisibleIndex = memberCount
          firstVisibleTime = timedChunk.time
        }
      }
      return {
        blocks,
        memberCount,
        lastMemberIndex: memberCount,
        ...(firstTokenTime === undefined ? {} : { firstTokenTime }),
        ...(firstVisibleIndex === undefined ? {} : { firstVisibleIndex }),
        ...(firstVisibleTime === undefined ? {} : { firstVisibleTime }),
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

it('reports v2 embedded stream compaction and exact replay costs', async () => {
  const fixture = timed(buildFixture)
  assemble(historyEntries(wireEntries(fixture.value.compactEvents.slice(0, 100))))

  const rawHostHeap = sampledPeakHeap((sample) => {
    const records = wireEntries(fixture.value.rawEvents)
    sample()
    const json = JSON.stringify({ records, hasMore: false } satisfies HistoryValue)
    sample()
    return Buffer.byteLength(json)
  })
  const compactHostHeap = sampledPeakHeap((sample) => {
    const records = wireEntries(fixture.value.compactEvents)
    sample()
    const json = JSON.stringify({ records, hasMore: false } satisfies HistoryValue)
    sample()
    return Buffer.byteLength(json)
  })

  const rawEntries = timed(() => wireEntries(fixture.value.rawEvents))
  const compactEntries = timed(() => wireEntries(fixture.value.compactEvents))
  const rawValue: HistoryValue = { records: rawEntries.value, hasMore: false }
  const compactValue: HistoryValue = { records: compactEntries.value, hasMore: false }
  const rawJson = timed(() => JSON.stringify(rawValue))
  const compactJson = timed(() => JSON.stringify(compactValue))
  const rawGzip = timed(() => gzipSync(rawJson.value).byteLength)
  const compactGzip = timed(() => gzipSync(compactJson.value).byteLength)
  const rawBrotli = timed(() => brotliCompressSync(rawJson.value).byteLength)
  const compactBrotli = timed(() => brotliCompressSync(compactJson.value).byteLength)
  const rawTransfer = await loopbackTransfer(rawJson.value)
  const compactTransfer = await loopbackTransfer(compactJson.value)

  const rawClientHeap = sampledPeakHeap((sample) => {
    const wire: unknown = JSON.parse(rawJson.value)
    sample()
    const parsed = historyValueSchema.parse(wire)
    sample()
    const prepared = historyEntries(parsed.records)
    sample()
    const folded = assemble(prepared)
    sample()
    return digest(folded)
  })
  const compactClientHeap = sampledPeakHeap((sample) => {
    const wire: unknown = JSON.parse(compactJson.value)
    sample()
    const parsed = historyValueSchema.parse(wire)
    sample()
    const prepared = historyEntries(parsed.records)
    sample()
    const folded = assemble(prepared)
    sample()
    return digest(folded)
  })

  const parsedRaw = timed((): unknown => JSON.parse(rawJson.value))
  const parsedCompact = timed((): unknown => JSON.parse(compactJson.value))
  const rawValidation = timed(() => historyValueSchema.parse(parsedRaw.value))
  const compactValidation = timed(() => historyValueSchema.parse(parsedCompact.value))
  const rawPreparation = timed(() => historyEntries(rawValidation.value.records))
  const compactPreparation = timed(() => historyEntries(compactValidation.value.records))

  assemble(rawPreparation.value.slice(0, 100))
  assemble(compactPreparation.value)
  const rawFold = timed(() => assemble(rawPreparation.value))
  const compactFold = timed(() => assemble(compactPreparation.value))

  const rawBytes = Buffer.byteLength(rawJson.value)
  const compactBytes = Buffer.byteLength(compactJson.value)
  expect(fixture.value.rawEvents).toHaveLength(DURABLE_EVENTS)
  expect(fixture.value.compactEvents).toHaveLength(DURABLE_EVENTS)
  expect(fixture.value.rawRecordCount).toBe(STREAM_MEMBERS)
  expect(fixture.value.compactRecordCount).toBe(COMPACT_RECORDS)
  expect(rawPreparation.value).toHaveLength(DURABLE_EVENTS)
  expect(compactPreparation.value).toHaveLength(DURABLE_EVENTS)
  expect(digest(compactFold.value)).toBe(digest(rawFold.value))
  expect(compactClientHeap.value).toBe(rawClientHeap.value)
  expect(rawHostHeap.value).toBe(rawBytes)
  expect(compactHostHeap.value).toBe(compactBytes)
  expect(compactBytes).toBeLessThan(rawBytes)

  const rawResponseMs = rawEntries.ms + rawJson.ms
  const compactResponseMs = compactEntries.ms + compactJson.ms
  const rawClientMs = parsedRaw.ms + rawValidation.ms + rawPreparation.ms + rawFold.ms
  const compactClientMs = parsedCompact.ms + compactValidation.ms + compactPreparation.ms + compactFold.ms
  const rawSyntheticApiWaitMs = rawResponseMs + rawTransfer.totalMs + parsedRaw.ms + rawValidation.ms
  const compactSyntheticApiWaitMs = compactResponseMs + compactTransfer.totalMs
    + parsedCompact.ms + compactValidation.ms
  const rawSyntheticReadyMs = rawResponseMs + rawTransfer.totalMs + rawClientMs
  const compactSyntheticReadyMs = compactResponseMs + compactTransfer.totalMs + compactClientMs
  process.stdout.write(`HISTORY_TRANSPORT_PERF_RESULT ${JSON.stringify({
    fixture: {
      buildMs: rounded(fixture.ms),
      logicalItems: LOGICAL_ITEMS,
      durableEvents: DURABLE_EVENTS,
      streamMembers: STREAM_MEMBERS,
      rawStreamRecords: fixture.value.rawRecordCount,
      compactStreamRecords: fixture.value.compactRecordCount,
      historyRecords: compactPreparation.value.length,
    },
    bytes: {
      rawJson: rawBytes,
      compactJson: compactBytes,
      jsonReductionPct: reduction(rawBytes, compactBytes),
      rawGzip: rawGzip.value,
      compactGzip: compactGzip.value,
      gzipReductionPct: reduction(rawGzip.value, compactGzip.value),
      rawBrotli: rawBrotli.value,
      compactBrotli: compactBrotli.value,
      brotliReductionPct: reduction(rawBrotli.value, compactBrotli.value),
    },
    memory: {
      samples: 3,
      rawHostAdditionalHeapPeakBytes: rawHostHeap.medianPeakBytes,
      compactHostAdditionalHeapPeakBytes: compactHostHeap.medianPeakBytes,
      hostReductionPct: reduction(rawHostHeap.medianPeakBytes, compactHostHeap.medianPeakBytes),
      rawClientAdditionalHeapPeakBytes: rawClientHeap.medianPeakBytes,
      compactClientAdditionalHeapPeakBytes: compactClientHeap.medianPeakBytes,
      clientReductionPct: reduction(rawClientHeap.medianPeakBytes, compactClientHeap.medianPeakBytes),
      rawHostPeakSamples: rawHostHeap.peakBytes,
      compactHostPeakSamples: compactHostHeap.peakBytes,
      rawClientPeakSamples: rawClientHeap.peakBytes,
      compactClientPeakSamples: compactClientHeap.peakBytes,
    },
    host: {
      rawEntryWrapMs: rounded(rawEntries.ms),
      compactEntryWrapMs: rounded(compactEntries.ms),
      rawStringifyMs: rounded(rawJson.ms),
      compactStringifyMs: rounded(compactJson.ms),
      rawGzipMs: rounded(rawGzip.ms),
      compactGzipMs: rounded(compactGzip.ms),
      rawBrotliMs: rounded(rawBrotli.ms),
      compactBrotliMs: rounded(compactBrotli.ms),
      rawResponseMs: rounded(rawResponseMs),
      compactResponseMs: rounded(compactResponseMs),
      responseReductionPct: reduction(rawResponseMs, compactResponseMs),
    },
    transport: {
      samples: 5,
      rawHeadersMs: rounded(rawTransfer.headersMs),
      compactHeadersMs: rounded(compactTransfer.headersMs),
      rawBodyMs: rounded(rawTransfer.bodyMs),
      compactBodyMs: rounded(compactTransfer.bodyMs),
      rawTotalMs: rounded(rawTransfer.totalMs),
      compactTotalMs: rounded(compactTransfer.totalMs),
      totalReductionPct: reduction(rawTransfer.totalMs, compactTransfer.totalMs),
      rawSamples: rawTransfer.samples.map(sample => ({
        headersMs: rounded(sample.headersMs),
        bodyMs: rounded(sample.bodyMs),
        totalMs: rounded(sample.totalMs),
      })),
      compactSamples: compactTransfer.samples.map(sample => ({
        headersMs: rounded(sample.headersMs),
        bodyMs: rounded(sample.bodyMs),
        totalMs: rounded(sample.totalMs),
      })),
    },
    client: {
      rawParseMs: rounded(parsedRaw.ms),
      compactParseMs: rounded(parsedCompact.ms),
      rawValidationMs: rounded(rawValidation.ms),
      compactValidationMs: rounded(compactValidation.ms),
      rawPrepareMs: rounded(rawPreparation.ms),
      compactPrepareMs: rounded(compactPreparation.ms),
      rawFoldMs: rounded(rawFold.ms),
      compactFoldMs: rounded(compactFold.ms),
      rawHistoryMs: rounded(rawClientMs),
      compactHistoryMs: rounded(compactClientMs),
      historyReductionPct: reduction(rawClientMs, compactClientMs),
    },
    combined: {
      rawSyntheticApiWaitMs: rounded(rawSyntheticApiWaitMs),
      compactSyntheticApiWaitMs: rounded(compactSyntheticApiWaitMs),
      syntheticApiWaitReductionPct: reduction(rawSyntheticApiWaitMs, compactSyntheticApiWaitMs),
      rawSyntheticReadyMs: rounded(rawSyntheticReadyMs),
      compactSyntheticReadyMs: rounded(compactSyntheticReadyMs),
      syntheticReadyReductionPct: reduction(rawSyntheticReadyMs, compactSyntheticReadyMs),
    },
  })}\n`)
}, 600_000)

it('reports compact folding cost for long whitespace-prefix streams', () => {
  const results = [10_000, 20_000, 40_000].map((members) => {
    const stream: readonly AssistantStreamRecord[] = [{
      type: 'reasoning-chunks',
      time0: TIME_ZERO + 1,
      index: 0,
      dt: Array.from({ length: members - 1 }, () => 1),
      texts: Array.from({ length: members }, (_, index) => index === members - 1 ? 'x' : ' '),
    }]
    const start = wireEntry({
      type: 'step/start',
      seq: SessionSeq(0),
      time: TIME_ZERO,
      data: { turn: 1, step: 1 },
    })
    const message = wireEntry({
      type: 'assistant/message',
      seq: SessionSeq(1),
      time: TIME_ZERO + members,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'reasoning', text: `${' '.repeat(members - 1)}x` }],
          source: { provider: 'benchmark', model: 'synthetic-v2' },
        }),
        stream,
      },
    } as SessionEvent<'assistant/message'>)
    const inputs = historyEntries([start, message])
    const folded = assemble(inputs)
    const samplesMs = Array.from({ length: 5 }, () => timed(() => assemble(inputs)).ms)
    expect((folded.chat as readonly { readonly data: FoldState }[])[0]?.data).toMatchObject({
      memberCount: members,
      lastMemberIndex: members,
      firstVisibleIndex: members,
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
