/** Isolated worker that seeds the synthetic corpus or measures one Session-controller operation over it. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionCache, { checkpointRecord, projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { serializeRecord } from '../../packages/storage/storage-json/src/format.ts'
import { ANCHOR_COUNT } from './corpus-shape.ts'
import {
  anchorHeader,
  corpusSessionId,
  forEachConcurrently,
  SEARCH_QUERIES,
  SyntheticCorpusWriter,
  type AnchorBodyFacts,
  type SyntheticCorpusFacts,
  type WrittenSession,
} from './synthetic-corpus.ts'

/** Process memory after the measured endpoint, with its result still reachable. */
export interface CorpusMemory {
  readonly heapUsedMb: number
  readonly rssMb: number
  readonly peakRssMb: number
}

/** Anchor preparation report: authoring, replay validation, and projection folding of one anchor group. */
export interface AnchorsReport {
  readonly mode: 'anchors'
  readonly anchors: readonly number[]
  readonly prepareMs: number
}

/** Seeding report: facts of one named corpus written from prepared anchors, and the time spent writing it. */
export interface SeedReport {
  readonly mode: 'seed'
  readonly name: string
  readonly corpus: SyntheticCorpusFacts
  readonly seedMs: number
}

/** List report: Host boot, then a cold and a repeated Session list. */
export interface ListReport {
  readonly mode: 'list'
  readonly bootMs: number
  readonly firstMs: number
  readonly repeatMs: number
  readonly items: number
  readonly itemsWithProjections: number
  readonly memory: CorpusMemory
}

/** Search report: the first search builds the in-memory index; the second reuses it. */
export interface SearchReport {
  readonly mode: 'search'
  readonly bootMs: number
  readonly firstMs: number
  readonly repeatMs: number
  readonly firstItems: number
  readonly repeatItems: number
  readonly memory: CorpusMemory
}

/** Fork report: one fork of each requested source, in request order. */
export interface ForkReport {
  readonly mode: 'fork'
  readonly bootMs: number
  readonly forks: readonly {
    readonly rank: number
    readonly sourceEvents: number
    readonly forkMs: number
  }[]
  readonly memory: CorpusMemory
}

/** Any worker report. */
export type SessionCorpusReport = AnchorsReport | SeedReport | ListReport | SearchReport | ForkReport

const BENCH_MODEL = { provider: 'bench', model: 'bench' } as const
/** Bound on waiting for fire-and-forget projection-cache write-backs after seeding. */
const SEED_DRAIN_TIMEOUT_MS = 120_000

function megabytes(bytes: number): number {
  return Math.round(bytes / 104_857.6) / 10
}

async function memory(): Promise<CorpusMemory> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (gc === undefined) throw new Error('Session corpus benchmark requires --expose-gc')
  gc()
  await scheduler.yield()
  gc()
  const usage = process.memoryUsage()
  return {
    heapUsedMb: megabytes(usage.heapUsed),
    rssMb: megabytes(usage.rss),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 102.4) / 10,
  }
}

/** Mount the shipped Web Host's Session list, search, and fork dependencies. */
async function mountHost(root: string): Promise<{ readonly ctx: Context; readonly controller: SessionController }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'zstd' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
  // Content search is opt-in; enabled deployments defer the in-memory index to the first search.
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SessionStatsPlugin)
  await ctx.plugin(SessionTurnOutlinePlugin)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Transport, upload, model-default, and Workspace services are outside every measured path.
  const dispose = (): void => {}
  ctx.provide('typert', { lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => BENCH_MODEL } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const controller = new SessionController(ctx, { nativeOpen: false }, { canOpenPath: () => false })
  return { ctx, controller }
}

/** Run one operation against the projection-cache table stored under `root`. */
async function withCacheTable<Value>(
  root: string,
  operation: (table: KvTable<SessionId, CheckpointRecord>) => Promise<Value>,
): Promise<Value> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    try {
      return await operation(domain.table('sessions'))
    } finally {
      await domain.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

function anchorFactsPath(root: string, anchor: number): string {
  return join(root, 'bodies', `anchor-${String(anchor).padStart(2, '0')}.json`)
}

/** Author, validate, and fold one group of anchors, saving bodies and projection records for `seed`. */
async function prepareAnchors(root: string, anchors: readonly number[]): Promise<AnchorsReport> {
  const started = performance.now()
  const writer = new SyntheticCorpusWriter()
  const foldRoot = join(root, `fold-${anchors.join('-')}`)
  const facts = new Map<number, AnchorBodyFacts>()
  const host = await mountHost(foldRoot)
  try {
    for (const anchor of anchors) {
      const header = anchorHeader(anchor)
      const log = await writer.author(anchor)
      // Replay validation, as in `sessionQuery.readSession`, rejects an invalid authored body before any write.
      Session.create(header.id, log, header, SessionLogOffset(0), currentSessionMessageProjections)
      // The production cold-read write-back folds each shared body once.
      host.ctx.sessionProjectionCache.coldSnapshot(header, SessionLogOffset(0), log)
      facts.set(anchor, await writer.saveBody(join(root, 'bodies'), anchor))
    }
    // Write-backs are fire-and-forget; the cache serves a record only after it is durable.
    const deadline = performance.now() + SEED_DRAIN_TIMEOUT_MS
    while (anchors.some(anchor => host.ctx.sessionProjectionCache.cachedSnapshot(anchorHeader(anchor)) === undefined)) {
      if (performance.now() > deadline) throw new Error('projection-cache write-back did not become durable')
      await scheduler.wait(20)
    }
  } finally {
    await host.ctx.fiber.dispose()
  }
  await withCacheTable(foldRoot, async (table) => {
    for (const anchor of anchors) {
      const record = table.get(anchorHeader(anchor).id)
      await writeFile(anchorFactsPath(root, anchor), JSON.stringify({ ...facts.get(anchor), record }))
    }
  })
  return { mode: 'anchors', anchors, prepareMs: performance.now() - started }
}

/** Parse one prepared anchor file written by a sibling `anchors` process. */
async function readPreparedAnchor(root: string, anchor: number): Promise<AnchorBodyFacts & { readonly record: CheckpointRecord }> {
  const value: unknown = JSON.parse(await readFile(anchorFactsPath(root, anchor), 'utf8'))
  if (typeof value !== 'object' || value === null) throw new Error(`prepared anchor ${String(anchor)} is not an object`)
  const { frameCount, events, logicalBytes, record } = value as Record<string, unknown>
  for (const count of [frameCount, events, logicalBytes]) {
    if (!Number.isSafeInteger(count)) throw new Error(`prepared anchor ${String(anchor)} has invalid body facts`)
  }
  return {
    frameCount: frameCount as number,
    events: events as number,
    logicalBytes: logicalBytes as number,
    record: checkpointRecord.parse(record),
  }
}

/** Write one named corpus from prepared anchors, rebinding each projection record to its Session header. */
async function seed(root: string, name: string, count: number): Promise<SeedReport> {
  const started = performance.now()
  const writer = new SyntheticCorpusWriter()
  const records = new Map<number, CheckpointRecord>()
  for (let anchor = 0; anchor < ANCHOR_COUNT; anchor++) {
    const { record, ...facts } = await readPreparedAnchor(root, anchor)
    await writer.loadBody(join(root, 'bodies'), anchor, facts)
    records.set(anchor, record)
  }
  const corpusRoot = join(root, `corpus-${name}`)
  const written = await writer.writeCorpus(join(corpusRoot, 'sessions'), count)
  // Sessions of one anchor share events, so their records differ only in the header-bound identity.
  // Per-record documents are written directly: the domain's one-fsync-per-put chain would dominate seeding,
  // and the list endpoint rejects a corpus whose rows the cache does not serve.
  const table = join(corpusRoot, 'storages', projectionCacheDomainSpec.name, 'sessions')
  await mkdir(table, { recursive: true })
  await forEachConcurrently(written.sessions.length, async (rank) => {
    const { header, anchor } = written.sessions[rank] as WrittenSession
    const source = records.get(anchor)
    if (source === undefined) throw new Error(`corpus anchor ${String(anchor)} has no folded projection record`)
    await writeFile(join(table, `${header.id}.json`), serializeRecord(projectionCacheDomainSpec.version, {
      identity: { ...source.identity, createdAt: header.createdAt, cwd: header.cwd },
      rows: source.rows,
    }))
  })
  return { mode: 'seed', name, corpus: written.facts, seedMs: performance.now() - started }
}

async function measureList(root: string, expected: number): Promise<ListReport> {
  const started = performance.now()
  const { ctx, controller } = await mountHost(root)
  try {
    const booted = performance.now()
    const signal = new AbortController().signal
    const first = await controller.list({}, signal)
    const firstDone = performance.now()
    const repeated = await controller.list({}, signal)
    const done = performance.now()
    if (first.items.length !== expected || repeated.items.length !== expected) {
      throw new Error(`Session list returned ${String(first.items.length)} of ${String(expected)} Sessions`)
    }
    return {
      mode: 'list',
      bootMs: booted - started,
      firstMs: firstDone - booted,
      repeatMs: done - firstDone,
      items: first.items.length,
      itemsWithProjections: first.items.filter(item => item.projections !== undefined).length,
      memory: await memory(),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function measureSearch(root: string): Promise<SearchReport> {
  const started = performance.now()
  const { ctx, controller } = await mountHost(root)
  try {
    const booted = performance.now()
    const signal = new AbortController().signal
    const first = await controller.search({ query: SEARCH_QUERIES[0] }, signal)
    const firstDone = performance.now()
    const repeated = await controller.search({ query: SEARCH_QUERIES[1] }, signal)
    const done = performance.now()
    if (first.items.length === 0 || repeated.items.length === 0) {
      throw new Error('Session search matched no synthetic Session')
    }
    return {
      mode: 'search',
      bootMs: booted - started,
      firstMs: firstDone - booted,
      repeatMs: done - firstDone,
      firstItems: first.items.length,
      repeatItems: repeated.items.length,
      memory: await memory(),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

async function measureFork(root: string, ranks: readonly number[]): Promise<ForkReport> {
  const started = performance.now()
  const { ctx, controller } = await mountHost(root)
  try {
    const booted = performance.now()
    const forks: ForkReport['forks'][number][] = []
    for (const rank of ranks) {
      const forkStarted = performance.now()
      const { sessionId } = await controller.fork({ sessionId: corpusSessionId(rank) })
      const forkMs = performance.now() - forkStarted
      const child = ctx.sessions.get(sessionId)
      if (child === undefined) throw new Error(`fork of rank ${String(rank)} did not publish its child`)
      forks.push({ rank, sourceEvents: child.inheritedEventCount, forkMs })
    }
    return { mode: 'fork', bootMs: booted - started, forks, memory: await memory() }
  } finally {
    await ctx.fiber.dispose()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-projection-cache',
].map(name => [name, import.meta.resolve(name)])))

const USAGE = 'usage: session-corpus.worker.js <root> <anchors anchors...|seed name count|list count|search|fork ranks...>'
const [root, mode, ...rest] = process.argv.slice(2)
if (root === undefined) throw new Error(USAGE)

function counts(values: readonly string[]): number[] {
  const parsed = values.map(Number)
  if (parsed.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error(USAGE)
  return parsed
}

let report: SessionCorpusReport
switch (mode) {
  case 'anchors':
    report = await prepareAnchors(root, counts(rest))
    break
  case 'seed': {
    const [name, count] = rest
    if (name === undefined || !/^[a-z]+$/.test(name) || count === undefined) throw new Error(USAGE)
    report = await seed(root, name, counts([count])[0] as number)
    break
  }
  case 'list':
    report = await measureList(root, counts(rest)[0] ?? 0)
    break
  case 'search':
    report = await measureSearch(root)
    break
  case 'fork':
    report = await measureFork(root, counts(rest))
    break
  default:
    throw new Error(`unknown Session corpus mode ${String(mode)}`)
}
process.stdout.write(JSON.stringify(report) + '\n')
