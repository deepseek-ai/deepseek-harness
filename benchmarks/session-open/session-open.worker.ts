/** Isolated worker for cold Session phase, first-history, and Agent-resume benchmarks. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop, { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import SessionStore, {
  interruptedTurnClosers,
  SessionId,
  SessionLogOffset,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
// These Host-only adapters have no public Node export and are compiled into the benchmark worker.
import { SessionHistoryController } from '../../packages/api/session-controller/src/history.ts'
import { installModelSelectionProjection } from '../../packages/api/session-controller/src/model-selection-projection.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { SYNTHETIC_SESSION_ID } from './session-open.constants.ts'

/** Worker scenario selected by the parent benchmark. */
export type SessionOpenBenchmarkScenario =
  | 'phase-migrate'
  | 'phase-steady'
  | 'first-history'
  | 'agent-resume'

/** One post-GC process memory observation. */
export interface BenchmarkMemorySnapshot {
  readonly heapUsedMb: number
  readonly externalMb: number
  readonly arrayBuffersMb: number
  readonly rssMb: number
  readonly peakRssMb: number
}

/** Memory retained by one benchmark endpoint relative to its initialized Host. */
export interface BenchmarkMemoryDelta {
  readonly heapUsedMb: number
  readonly externalMb: number
  readonly arrayBuffersMb: number
  readonly rssMb: number
}

/** Timings and memory emitted by one isolated scenario. */
export interface SessionOpenWorkerReport {
  readonly scenario: SessionOpenBenchmarkScenario
  readonly totalMs: number
  readonly phases?: {
    readonly openMs: number
    readonly readMs: number
    readonly sessionRestoreMs: number
    readonly projectionMs: number
  }
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
  readonly events: number
  readonly beforeGc: BenchmarkMemorySnapshot
  readonly afterGc: BenchmarkMemorySnapshot
  readonly retained: BenchmarkMemoryDelta
}

class BenchmarkSessionQuery extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.reject(new Error('search is outside the Session opening benchmark'))
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.reject(new Error('search is outside the Session opening benchmark'))
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 104_857.6) / 10
}

function memorySnapshot(): BenchmarkMemorySnapshot {
  const memory = process.memoryUsage()
  return {
    heapUsedMb: megabytes(memory.heapUsed),
    externalMb: megabytes(memory.external),
    arrayBuffersMb: megabytes(memory.arrayBuffers),
    rssMb: megabytes(memory.rss),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 102.4) / 10,
  }
}

async function collectGarbage(): Promise<BenchmarkMemorySnapshot> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (gc === undefined) throw new Error('Session opening benchmark requires --expose-gc')
  gc()
  await scheduler.yield()
  gc()
  return memorySnapshot()
}

function memoryDelta(
  before: BenchmarkMemorySnapshot,
  after: BenchmarkMemorySnapshot,
): BenchmarkMemoryDelta {
  return {
    heapUsedMb: Math.round((after.heapUsedMb - before.heapUsedMb) * 10) / 10,
    externalMb: Math.round((after.externalMb - before.externalMb) * 10) / 10,
    arrayBuffersMb: Math.round((after.arrayBuffersMb - before.arrayBuffersMb) * 10) / 10,
    rssMb: Math.round((after.rssMb - before.rssMb) * 10) / 10,
  }
}

async function installProjectionSet(ctx: Context, agentLoopOwnsBoundary: boolean): Promise<void> {
  // Mirrors projection owners mounted by the base and web-app bundles without timing profile boot.
  if (!agentLoopOwnsBoundary) ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  await ctx.plugin(SessionStatsPlugin)
  await ctx.plugin(SessionTurnOutlinePlugin)
  await ctx.plugin(TokenMeter)
}

/** Owns one initialized Host and the live endpoint retained through its final GC sample. */
class SessionBenchmarkHost {
  private preparation: SessionPreparation | undefined
  private agentHandle: AgentHandle | undefined
  private historyAbort: AbortController | undefined
  private historyIterator: AsyncIterator<unknown> | undefined
  private retained: unknown

  private constructor(
    private readonly ctx: Context,
    private readonly scenario: SessionOpenBenchmarkScenario,
    private readonly history: SessionHistoryController | undefined,
  ) {}

  static async create(root: string, scenario: SessionOpenBenchmarkScenario): Promise<SessionBenchmarkHost> {
    const ctx = new Context()
    const agentScenario = scenario === 'agent-resume'
    if (agentScenario) await mountAgentLoopTestDependencies(ctx)
    else {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SessionStore)
    }
    await installProjectionSet(ctx, agentScenario)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    let history: SessionHistoryController | undefined
    if (scenario === 'first-history') {
      new BenchmarkSessionQuery(ctx)
      history = new SessionHistoryController(ctx, (observation) => {
        // First-history ends at snapshot delivery; Agent-resume owns live activation and retention.
        observation[Symbol.dispose]()
      })
    }
    if (agentScenario) await ctx.plugin(AgentLoop, { agents: [] })
    return new SessionBenchmarkHost(ctx, scenario, history)
  }

  async measure(): Promise<SessionOpenWorkerReport> {
    const beforeGc = await collectGarbage()
    const started = performance.now()
    const cpuStarted = process.cpuUsage()
    const measured = await this.runScenario()
    const totalMs = performance.now() - started
    const cpu = process.cpuUsage(cpuStarted)
    if (this.retained === undefined) throw new Error(`${this.scenario} did not retain its measured endpoint`)
    const afterGc = await collectGarbage()
    return {
      scenario: this.scenario,
      totalMs,
      ...measured.phases === undefined ? {} : { phases: measured.phases },
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      events: measured.events,
      beforeGc,
      afterGc,
      retained: memoryDelta(beforeGc, afterGc),
    }
  }

  async dispose(): Promise<void> {
    this.historyAbort?.abort(new Error('Session opening benchmark complete'))
    await this.historyIterator?.return?.()
    await this.agentHandle?.dispose()
    this.preparation?.[Symbol.dispose]()
    this.retained = undefined
    await this.ctx.fiber.dispose()
  }

  private runScenario(): Promise<{
    readonly events: number
    readonly phases?: SessionOpenWorkerReport['phases']
  }> {
    switch (this.scenario) {
      case 'phase-migrate':
      case 'phase-steady':
        return this.measurePhases()
      case 'first-history':
        return this.measureFirstHistory()
      case 'agent-resume':
        return this.measureAgentResume()
    }
  }

  private async measurePhases(): Promise<{
    readonly events: number
    readonly phases: NonNullable<SessionOpenWorkerReport['phases']>
  }> {
    let phaseStarted = performance.now()
    const handle = await this.ctx.sessionPersistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
    const openMs = performance.now() - phaseStarted
    phaseStarted = performance.now()
    const read = await handle.read()
    await handle.close()
    const readMs = performance.now() - phaseStarted
    phaseStarted = performance.now()
    const repaired = [...read.events, ...interruptedTurnClosers(read.events)]
    const seed = repaired
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(SessionId(SYNTHETIC_SESSION_ID), {
      seed,
      meta: structuredClone(handle.header),
      inheritedEventCount: handle.inheritedEventCount,
      eventState: read.eventState,
    }))
    this.preparation = preparation
    const sessionRestoreMs = performance.now() - phaseStarted
    phaseStarted = performance.now()
    const projection = this.ctx.sessionProjections.hydrate(
      preparation.session,
      {},
      seed,
      SessionLogOffset(0),
    )
    const projectionMs = performance.now() - phaseStarted
    this.retained = { preparation, projection, seed }
    return {
      events: preparation.session.seq,
      phases: { openMs, readMs, sessionRestoreMs, projectionMs },
    }
  }

  private async measureFirstHistory(): Promise<{ readonly events: number }> {
    const abort = new AbortController()
    this.historyAbort = abort
    const history = this.history
    if (history === undefined) throw new Error('first-history benchmark did not initialize its controller')
    const iterator = history.follow({
      address: { kind: 'session', sessionId: SessionId(SYNTHETIC_SESSION_ID) },
    }, abort.signal)[Symbol.asyncIterator]()
    this.historyIterator = iterator as AsyncIterator<unknown>
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') {
      throw new Error('Session history did not produce an opening snapshot')
    }
    this.retained = { history, iterator, first }
    return { events: first.value.records.length }
  }

  private async measureAgentResume(): Promise<{ readonly events: number }> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(SYNTHETIC_SESSION_ID),
      agentOptions: { provider: 'bench', model: 'bench' },
    })
    this.agentHandle = handle
    this.retained = handle
    return { events: handle.agent.session.seq }
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-session-persistence-jsonl': import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'),
})

const [root, scenarioValue] = process.argv.slice(2)
const scenarios: readonly SessionOpenBenchmarkScenario[] = [
  'phase-migrate',
  'phase-steady',
  'first-history',
  'agent-resume',
]
if (root === undefined || !scenarios.includes(scenarioValue as SessionOpenBenchmarkScenario)) {
  throw new Error('usage: session-open.worker.js <root> <phase-migrate|phase-steady|first-history|agent-resume>')
}
const scenario = scenarioValue as SessionOpenBenchmarkScenario
const host = await SessionBenchmarkHost.create(root, scenario)
let report: SessionOpenWorkerReport
try {
  report = await host.measure()
} finally {
  await host.dispose()
}
process.stdout.write(`${JSON.stringify(report)}\n`)
