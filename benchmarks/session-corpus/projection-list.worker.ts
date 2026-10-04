/** Plain-Node Session-list measurements with large persisted projections and small wire summaries. */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { scheduler, setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import { generationLogPath, sessionDir, toHeaderLine } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

const KEY = 'syntheticProjectionList'
const CWD = '/synthetic-projection-benchmark'
const BASE_TIME = 1_700_000_000_000
const ROW_PERCENTAGES = [50, 75, 100, 175] as const
const WORKLOADS = {
  modest: { sessions: 50, baseRows: 100, live: false },
  tail: { sessions: 300, baseRows: 1_000, live: false },
  cheap: { sessions: 3_000, baseRows: 0, live: true },
} as const

const stateSchema = z.object({
  sessionOrdinal: z.number().int(),
  events: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    category: z.enum(['input', 'output', 'tool']),
    metrics: z.object({ tokens: z.number().int(), bytes: z.number().int(), elapsedMs: z.number().int() }),
    content: z.array(z.object({ kind: z.enum(['text', 'metadata']), text: z.string() })),
    tags: z.array(z.string()),
  })),
  requests: z.array(z.object({
    ordinal: z.number().int(), firstRow: z.number().int(), lastRow: z.number().int(),
    route: z.object({ provider: z.string(), model: z.string(), options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), cache: z.object({ hit: z.number().int(), miss: z.number().int() }) }),
    references: z.array(z.object({ ordinal: z.number().int(), weight: z.number() })),
  })),
  totals: z.object({ rows: z.number().int(), requests: z.number().int(), tokens: z.number().int() }),
})
const viewSchema = z.object({ sessionOrdinal: z.number().int(), rows: z.number().int(), requests: z.number().int(), tokens: z.number().int() })
type ProjectionState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { syntheticProjectionList: ProjectionState }
  interface SessionProjectionMap { syntheticProjectionList: z.infer<typeof viewSchema> }
}

interface Memory {
  readonly heapUsedBytes: number
  readonly rssBytes: number
  /** Process lifetime peak, including fixture creation and Host mounting. */
  readonly peakRssBytes: number
}

interface ListSample {
  readonly listMs: number
  readonly listAndJsonMs: number
  readonly listCpuMs: number
  readonly listAndJsonCpuMs: number
  readonly callbackDelayMs: number
  readonly maxCallbackDelayMs: number
  readonly maxViewsPerBatch: number
  readonly yieldCalls: number
  readonly eventLoopMaxMs: number
  readonly items: number
  readonly wireViews: number
  readonly responseJsonBytes: number
  readonly retainedHeapDeltaBytes: number
  readonly memory: Memory
}

/** One fresh Host's fixture dimensions, retained memory, and first plus three repeated list samples. */
export interface ProjectionListReport {
  readonly workload: keyof typeof WORKLOADS
  readonly fixture: { sessions: number; baseRows: number; totalRows: number; totalRequests: number; stateJsonBytes: number }
  readonly baselineMemory: Memory
  readonly samples: readonly ListSample[]
  readonly responsiveness: ListSample
}

interface ViewObservation {
  calls: number
  onView: (() => void) | undefined
}

function headerOf(ordinal: number): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(`projection-bench-${ordinal}`),
    createdAt: BASE_TIME + ordinal, cwd: CWD, isSeeded: false, delegationDepth: 0 }
}

function makeState(sessionOrdinal: number, baseRows: number): ProjectionState {
  const count = Math.floor(baseRows * ROW_PERCENTAGES[sessionOrdinal % ROW_PERCENTAGES.length]! / 100)
  const events: ProjectionState['events'] = Array.from({ length: count }, (_, ordinal) => ({
    ordinal, category: (['input', 'output', 'tool'] as const)[ordinal % 3]!,
    metrics: { tokens: 32 + ordinal % 97, bytes: 128 + ordinal % 257, elapsedMs: ordinal % 41 },
    content: [
      { kind: 'text', text: `Generated observation ${sessionOrdinal}:${ordinal}. ` + 'Synthetic text. '.repeat(4 + ordinal % 4) },
      { kind: 'metadata', text: `bucket-${ordinal % 11}` },
    ],
    tags: [`group-${sessionOrdinal % 7}`, `kind-${ordinal % 3}`],
  }))
  const requests = Array.from({ length: Math.ceil(count / 8) }, (_, ordinal) => ({
    ordinal, firstRow: ordinal * 8, lastRow: Math.min(count - 1, ordinal * 8 + 7),
    route: { provider: 'synthetic', model: 'generated-model', options: { temperature: 0, streaming: true, tier: 'fixed' } },
    usage: { inputTokens: 100 + ordinal % 500, outputTokens: 30 + ordinal % 200, cache: { hit: ordinal % 100, miss: 20 } },
    references: Array.from({ length: Math.min(8, count - ordinal * 8) }, (_, index) => ({ ordinal: ordinal * 8 + index, weight: (index + 1) / 8 })),
  }))
  return { sessionOrdinal, events, requests,
    totals: { rows: count, requests: requests.length, tokens: events.reduce((sum, event) => sum + event.metrics.tokens, 0) } }
}

async function mountStorage(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
}

async function seed(root: string, workload: typeof WORKLOADS[keyof typeof WORKLOADS]): Promise<ProjectionListReport['fixture']> {
  const ctx = new Context()
  const fixture = { ...workload, totalRows: 0, totalRequests: 0, stateJsonBytes: 0 }
  try {
    if (workload.live) {
      for (let ordinal = 0; ordinal < workload.sessions; ordinal++) {
        fixture.stateJsonBytes += Buffer.byteLength(JSON.stringify(makeState(ordinal, workload.baseRows)))
      }
      return fixture
    }
    await mountStorage(ctx, root)
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    try {
      const table = domain.table('sessions')
      for (let ordinal = 0; ordinal < workload.sessions; ordinal++) {
        const header = headerOf(ordinal)
        const directory = sessionDir(join(root, 'sessions'), header.cwd, header.id)
        await mkdir(directory, { recursive: true })
        await writeFile(generationLogPath(join(root, 'sessions'), header.cwd, header.id, SESSION_FORMAT_VERSION, 'zstd'),
          await compressZstdFrame(JSON.stringify(toHeaderLine(header)) + '\n'), { flag: 'wx' })
        const state = makeState(ordinal, workload.baseRows)
        await table.put(header.id, {
          identity: { formatVersion: header.version, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false, inheritedEventCount: SessionLogOffset(0) },
          rows: {
            [KEY]: { ver: 1, seq: -1, val: state },
            sessionListMetadata: { ver: 1, seq: -1, val: { blank: true, lastPromptAt: null } },
          },
        })
        fixture.totalRows += state.events.length
        fixture.totalRequests += state.requests.length
        fixture.stateJsonBytes += Buffer.byteLength(JSON.stringify(state))
      }
    } finally {
      await domain.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
  return fixture
}

async function mountHost(ctx: Context, root: string, workload: typeof WORKLOADS[keyof typeof WORKLOADS], observation: ViewObservation, listWorkSliceMs?: number): Promise<SessionController> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register({
    key: KEY, stateVersion: 1, stateSchema,
    init: header => makeState(Number(header.id.slice('projection-bench-'.length)), workload.baseRows),
    apply: state => state,
    wire: {
      viewSchema,
      view(state) {
        observation.calls++
        observation.onView?.()
        return { sessionOrdinal: state.sessionOrdinal, ...state.totals }
      },
    },
  })
  if (workload.live) {
    for (let ordinal = 0; ordinal < workload.sessions; ordinal++) {
      const header = headerOf(ordinal)
      ctx.sessions.create(header.id, { meta: header })
    }
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'zstd' })
  await mountStorage(ctx, root)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  // No Agents, uploads, model calls, or workspace actions occur on this list path.
  const dispose = (): void => {}
  ctx.provide('typert', { lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'generated-model' }) } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  return new SessionController(ctx, { nativeOpen: false, ...(listWorkSliceMs === undefined ? {} : { listWorkSliceMs }) }, { canOpenPath: () => false })
}

async function memory(): Promise<Memory> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  assert.ok(gc, 'projection-list worker requires --expose-gc')
  gc()
  await scheduler.yield()
  gc()
  const usage = process.memoryUsage()
  return { heapUsedBytes: usage.heapUsed, rssBytes: usage.rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
}

async function measure(controller: SessionController, observation: ViewObservation, sessions: number, baseline: Memory, fullProbe = false): Promise<ListSample> {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  let immediate: NodeJS.Immediate | undefined
  const initialViews = observation.calls
  const yieldDescriptor = Object.getOwnPropertyDescriptor(scheduler, 'yield')
  const yieldWork = scheduler.yield.bind(scheduler)
  let yieldCalls = 0
  Object.defineProperty(scheduler, 'yield', {
    configurable: true,
    value: () => { yieldCalls++; return yieldWork() },
  })
  let queued: Promise<void> | undefined
  let callbackDelayMs = 0
  let maxCallbackDelayMs = 0
  let maxViewsPerBatch = 0
  observation.onView = () => {
    if (immediate !== undefined) return
    if (!fullProbe) observation.onView = undefined
    const beforeView = observation.calls - 1
    const start = performance.now()
    queued = new Promise<void>((resolve) => {
      immediate = setImmediate(() => {
        const elapsed = performance.now() - start
        if (maxViewsPerBatch === 0) callbackDelayMs = elapsed
        maxCallbackDelayMs = Math.max(maxCallbackDelayMs, elapsed)
        maxViewsPerBatch = Math.max(maxViewsPerBatch, observation.calls - beforeView)
        immediate = undefined
        resolve()
      })
    })
  }
  histogram.enable()
  try {
    // Arm the histogram before work, and keep it enabled through the final blocking segment.
    await delay(2)
    histogram.reset()
    const cpu = process.cpuUsage()
    const start = performance.now()
    const result = await controller.list({}, new AbortController().signal)
    const listDone = performance.now()
    const listYieldCalls = yieldCalls
    const listCpu = process.cpuUsage(cpu)
    const json = JSON.stringify(result)
    const jsonDone = performance.now()
    const jsonCpu = process.cpuUsage(cpu)
    assert.equal(result.items.length, sessions)
    assert.equal(observation.calls - initialViews, sessions)
    assert.ok(result.items.every(item => item.projections?.values[KEY] !== undefined))
    // No more views can arrive after list completion; drain the final armed batch.
    await queued
    await delay(2)
    const eventLoopMaxMs = histogram.max / 1_000_000
    histogram.disable()
    const endpoint = await memory()
    // Both endpoint values remain reachable while GC measures the retained heap.
    assert.ok(json.length > result.items.length)
    return { listMs: listDone - start, listAndJsonMs: jsonDone - start,
      listCpuMs: (listCpu.user + listCpu.system) / 1000, listAndJsonCpuMs: (jsonCpu.user + jsonCpu.system) / 1000,
      callbackDelayMs, maxCallbackDelayMs, maxViewsPerBatch, yieldCalls: listYieldCalls, eventLoopMaxMs, items: result.items.length, wireViews: observation.calls - initialViews,
      responseJsonBytes: Buffer.byteLength(json), retainedHeapDeltaBytes: endpoint.heapUsedBytes - baseline.heapUsedBytes, memory: endpoint }
  } finally {
    observation.onView = undefined
    if (immediate !== undefined) clearImmediate(immediate)
    histogram.disable()
    if (yieldDescriptor === undefined) Reflect.deleteProperty(scheduler, 'yield')
    else Object.defineProperty(scheduler, 'yield', yieldDescriptor)
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  controller: import.meta.resolve('@deepseek-ai/dsh-api-session-controller'),
  registry: import.meta.resolve('@deepseek-ai/dsh-session-projection'),
  cache: import.meta.resolve('@deepseek-ai/dsh-session-projection-cache'),
  persistence: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'),
})
const [root, workload, sliceArgument] = process.argv.slice(2)
if (root === undefined || (workload !== 'modest' && workload !== 'tail' && workload !== 'cheap')) throw new Error('usage: projection-list.worker.js <private-root> <modest|tail|cheap> [work-slice-ms]')
const listWorkSliceMs = sliceArgument === undefined ? undefined : Number(sliceArgument)
if (listWorkSliceMs !== undefined && (!Number.isSafeInteger(listWorkSliceMs) || listWorkSliceMs < 1)) throw new Error('work-slice-ms must be a positive integer')
const ctx = new Context()
try {
  const fixture = await seed(root, WORKLOADS[workload])
  const observation: ViewObservation = { calls: 0, onView: undefined }
  const controller = await mountHost(ctx, root, WORKLOADS[workload], observation, listWorkSliceMs)
  assert.equal(observation.calls, 0, 'setup must not warm wire views')
  const baselineMemory = await memory()
  const samples: ListSample[] = []
  for (let call = 0; call < 4; call++) samples.push(await measure(controller, observation, fixture.sessions, baselineMemory))
  const responsiveness = await measure(controller, observation, fixture.sessions, baselineMemory, true)
  const report: ProjectionListReport = { workload, fixture, baselineMemory, samples, responsiveness }
  console.log(JSON.stringify(report))
} finally {
  await ctx.fiber.dispose()
}
