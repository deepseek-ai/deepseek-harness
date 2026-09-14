/** Required performance budgets for cold Session preparation, first history, and Agent resume. */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import {
  ciTimeBudget,
  PERFORMANCE_BUDGET_HEADROOM,
} from '../support/calibration.ts'
import type {
  SessionOpenBenchmarkScenario,
  SessionOpenWorkerReport,
} from './session-open.worker.ts'
import {
  SYNTHETIC_CURRENT_GENERATION,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_CURRENT_FILENAME,
  SYNTHETIC_V0_FILENAME,
  writeSyntheticReleasedV0Session,
  type SyntheticV0SessionWrite,
} from './synthetic-released-v0-session.ts'

/** 200 turns × (500 text + 125 reasoning deltas): 127,400 released-v0 events. */
const SHAPE = { turns: 200, textDeltas: 500 } as const
/** Fresh processes per normal-heap scenario; the median enforces each timing budget. */
const ATTEMPTS = 5
/** A stuck child is reaped well before the outer test and hook deadlines. */
const WORKER_TIMEOUT_MS = 60_000
/** Old-space pressure check, kept independent from normal-heap timing samples. */
const CONSTRAINED_HEAP_MB = 128

type SessionAccessKind = 'first-open' | 'post-upgrade-reopen'
type SessionBenchmarkEndpoint = 'phases' | 'first-history' | 'agent-resume'

const SOURCE_GENERATION_BY_ACCESS = {
  'first-open': 'released-v0',
  'post-upgrade-reopen': SYNTHETIC_CURRENT_GENERATION,
} as const satisfies Record<SessionAccessKind, string>

/** Expected durations on the reference machine before CI scaling and variance headroom. */
const EXPECTED_MS = {
  migrationOpen: 220,
  read: 8,
  sessionRestore: 24,
  projection: 14,
  firstOpenFirstHistory: 220,
  reopenFirstHistory: 48,
  reopenAgentResume: 40,
} as const

const MIGRATION_OPEN_BUDGET_MS = ciTimeBudget(EXPECTED_MS.migrationOpen)
/** Standard two-CPU CI reopen samples span 47.4–49.2 ms; 50 ms is the rounded expectation. */
const EXPECTED_REOPEN_CI_MS = 50
const REOPEN_OPEN_BUDGET_MS = Math.ceil(EXPECTED_REOPEN_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const READ_BUDGET_MS = ciTimeBudget(EXPECTED_MS.read)
const SESSION_RESTORE_BUDGET_MS = ciTimeBudget(EXPECTED_MS.sessionRestore)
const PROJECTION_BUDGET_MS = ciTimeBudget(EXPECTED_MS.projection)
const FIRST_OPEN_FIRST_HISTORY_BUDGET_MS = ciTimeBudget(EXPECTED_MS.firstOpenFirstHistory)
const REOPEN_FIRST_HISTORY_BUDGET_MS = ciTimeBudget(EXPECTED_MS.reopenFirstHistory)
/** Reviewed hosted limit: floor(450 × 1.25); calibration records the original reference. */
const FIRST_OPEN_AGENT_RESUME_BUDGET_MS = 562
const REOPEN_AGENT_RESUME_BUDGET_MS = ciTimeBudget(EXPECTED_MS.reopenAgentResume)
/** Historical-reference retained heap before variance headroom. */
const EXPECTED_AGENT_RETAINED_HEAP_MB = 26.1
const AGENT_RETAINED_HEAP_BUDGET_MB = Math.ceil(
  EXPECTED_AGENT_RETAINED_HEAP_MB * PERFORMANCE_BUDGET_HEADROOM,
)

const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-open', 'session-open.worker.js')

type WorkerRun = BuiltBenchmarkWorkerRun<SessionOpenWorkerReport>

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function metric(
  reports: readonly SessionOpenWorkerReport[],
  read: (report: SessionOpenWorkerReport) => number,
): { readonly min: number; readonly median: number; readonly max: number; readonly samples: readonly number[] } {
  const samples = reports.map(read)
  return {
    min: rounded(Math.min(...samples)),
    median: rounded(median(samples)),
    max: rounded(Math.max(...samples)),
    samples: samples.map(rounded),
  }
}

function phaseMetric(
  reports: readonly SessionOpenWorkerReport[],
  key: keyof NonNullable<SessionOpenWorkerReport['phases']>,
): ReturnType<typeof metric> {
  return metric(reports, (report) => {
    if (report.phases === undefined) throw new Error(`${report.scenario} did not report phase timings`)
    return report.phases[key]
  })
}

function summarize(reports: readonly SessionOpenWorkerReport[]) {
  return {
    totalMs: metric(reports, report => report.totalMs),
    cpuUserMs: metric(reports, report => report.cpuUserMs),
    cpuSystemMs: metric(reports, report => report.cpuSystemMs),
    retainedHeapMb: metric(reports, report => report.retained.heapUsedMb),
    retainedExternalMb: metric(reports, report => report.retained.externalMb),
    retainedArrayBuffersMb: metric(reports, report => report.retained.arrayBuffersMb),
    retainedRssMb: metric(reports, report => report.retained.rssMb),
    peakRssMb: metric(reports, report => report.afterGc.peakRssMb),
  }
}

function summarizePhases(reports: readonly SessionOpenWorkerReport[]) {
  return {
    ...summarize(reports),
    openMs: phaseMetric(reports, 'openMs'),
    readMs: phaseMetric(reports, 'readMs'),
    sessionRestoreMs: phaseMetric(reports, 'sessionRestoreMs'),
    projectionMs: phaseMetric(reports, 'projectionMs'),
  }
}

function runWorker(
  root: string,
  scenario: SessionOpenBenchmarkScenario,
  heapLimitMb?: number,
): Promise<WorkerRun> {
  return runBuiltBenchmarkWorker({
    worker: WORKER,
    args: [root, scenario],
    timeoutMs: WORKER_TIMEOUT_MS,
    exposeGc: true,
    ...(heapLimitMb === undefined ? {} : { heapLimitMb }),
  })
}

function requireReport(
  run: WorkerRun,
  scenario: SessionOpenBenchmarkScenario,
  heapLimitMb?: number,
): SessionOpenWorkerReport {
  if (run.report !== undefined) return run.report
  const stderrLines = run.stderr.trim().split('\n')
  const fatal = stderrLines.filter(line => /FATAL ERROR|heap limit|out of memory/i.test(line))
  const context = stderrLines.length <= 20
    ? stderrLines
    : [...stderrLines.slice(0, 10), '... stderr middle omitted ...', ...stderrLines.slice(-10)]
  const detail = (fatal.length > 0 ? fatal : context).join('\n')
  const limit = heapLimitMb === undefined ? 'normal heap' : `${String(heapLimitMb)} MB old space`
  throw new Error(
    `${scenario} failed under ${limit}: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${detail}`,
  )
}

/** Owns deterministic first-open/reopen sources and private roots created for one benchmark file. */
class SessionOpenBenchmarkSuite {
  private legacySourcePath = ''
  private currentSourcePath = ''
  private scratch = ''
  private facts: SyntheticV0SessionWrite | undefined
  private rootIndex = 0

  async prepare(): Promise<void> {
    this.scratch = await mkdtemp(join(tmpdir(), 'dsh-session-open-bench-'))
    this.facts = await writeSyntheticReleasedV0Session(join(this.scratch, 'source'), SHAPE)
    this.legacySourcePath = this.facts.path
    // Produce one real post-upgrade directory outside every measured interval.
    const templateRoot = await this.createRoot('first-open', 'post-upgrade-template')
    requireReport(await runWorker(templateRoot, 'agent-resume'), 'agent-resume')
    this.currentSourcePath = join(
      templateRoot,
      SYNTHETIC_SESSION_DIRECTORY,
      SYNTHETIC_CURRENT_FILENAME,
    )
  }

  async dispose(): Promise<void> {
    await rm(this.scratch, { recursive: true, force: true })
  }

  workload(accessKind: SessionAccessKind) {
    if (this.facts === undefined) throw new Error('Session opening benchmark source is not prepared')
    return {
      accessKind,
      sourceGeneration: SOURCE_GENERATION_BY_ACCESS[accessKind],
      logicalInputEvents: this.facts.events,
      legacyInputRows: this.facts.rows,
      legacyInputFrames: this.facts.frames,
      legacyInputLogicalBytes: this.facts.logicalBytes,
      legacyInputCompressedBytes: this.facts.compressedBytes,
    }
  }

  async sample(
    accessKind: SessionAccessKind,
    endpoint: SessionBenchmarkEndpoint,
  ): Promise<SessionOpenWorkerReport[]> {
    const reports: SessionOpenWorkerReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      reports.push(await this.run(accessKind, endpoint))
    }
    return reports
  }

  async run(
    accessKind: SessionAccessKind,
    endpoint: SessionBenchmarkEndpoint,
    heapLimitMb?: number,
  ): Promise<SessionOpenWorkerReport> {
    const scenario = this.workerScenario(accessKind, endpoint)
    const root = await this.createRoot(
      accessKind,
      `${accessKind}-${endpoint}-${String(this.rootIndex++)}`,
    )
    const report = requireReport(await runWorker(root, scenario, heapLimitMb), scenario, heapLimitMb)
    return report
  }

  private workerScenario(
    accessKind: SessionAccessKind,
    endpoint: SessionBenchmarkEndpoint,
  ): SessionOpenBenchmarkScenario {
    if (endpoint !== 'phases') return endpoint
    return accessKind === 'first-open' ? 'phase-migrate' : 'phase-steady'
  }

  private async createRoot(accessKind: SessionAccessKind, label: string): Promise<string> {
    const root = join(this.scratch, label)
    const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
    await mkdir(directory, { recursive: true })
    await copyFile(this.legacySourcePath, join(directory, SYNTHETIC_V0_FILENAME))
    if (accessKind === 'post-upgrade-reopen') {
      if (this.currentSourcePath === '') throw new Error('current V2 benchmark source is not prepared')
      // Released generations remain adjacent after migration, so V2 samples retain their V0 predecessor.
      await copyFile(this.currentSourcePath, join(directory, SYNTHETIC_CURRENT_FILENAME))
    }
    return root
  }
}

interface AccessBenchmarkSpec {
  readonly accessKind: SessionAccessKind
  readonly label: string
  readonly openBudgetMs: number
  readonly firstHistoryBudgetMs: number
  readonly agentResumeBudgetMs: number
}

const ACCESS_BENCHMARKS: readonly AccessBenchmarkSpec[] = [
  {
    accessKind: 'first-open',
    label: 'first open from released V0',
    openBudgetMs: MIGRATION_OPEN_BUDGET_MS,
    firstHistoryBudgetMs: FIRST_OPEN_FIRST_HISTORY_BUDGET_MS,
    agentResumeBudgetMs: FIRST_OPEN_AGENT_RESUME_BUDGET_MS,
  },
  {
    accessKind: 'post-upgrade-reopen',
    label: 'fresh-process reopen after upgrade',
    openBudgetMs: REOPEN_OPEN_BUDGET_MS,
    firstHistoryBudgetMs: REOPEN_FIRST_HISTORY_BUDGET_MS,
    agentResumeBudgetMs: REOPEN_AGENT_RESUME_BUDGET_MS,
  },
]

function expectOpenWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

describe('standard hosted reopen calibration', () => {
  it('accepts the recorded two-CPU samples that exceed the historical budget', () => {
    const recordedMedian = median([49.2, 47.4, 49.1, 48.6, 48.1])

    expect(recordedMedian).toBe(48.6)
    expect(() => expectOpenWithinBudget(recordedMedian, ciTimeBudget(12))).toThrow()
    expectOpenWithinBudget(recordedMedian, REOPEN_OPEN_BUDGET_MS)
    expect(REOPEN_OPEN_BUDGET_MS).toBe(63)
  })

  it('rejects synthetic reopen and multi-second first-open regressions', () => {
    const regressionMedian = median([74, 75, 76, 75, 74])
    expect(() => expectOpenWithinBudget(regressionMedian, REOPEN_OPEN_BUDGET_MS)).toThrow()
    expect(MIGRATION_OPEN_BUDGET_MS).toBe(550)
    expect(() => expectOpenWithinBudget(4_000, MIGRATION_OPEN_BUDGET_MS)).toThrow()
  })
})

describe('standard hosted first-open Agent-resume calibration', () => {
  it('accepts recorded hosted samples while rejecting a material regression', () => {
    const recordedMedian = median([454.2, 454.8, 455.4, 457.8, 459.8])

    expect(recordedMedian).toBe(455.4)
    expect(() => expectOpenWithinBudget(recordedMedian, 450)).toThrow()
    expectOpenWithinBudget(recordedMedian, FIRST_OPEN_AGENT_RESUME_BUDGET_MS)
    expect(() => expectOpenWithinBudget(600, FIRST_OPEN_AGENT_RESUME_BUDGET_MS)).toThrow()
  })
})

describe('Session opening benchmark prerequisites', () => {
  it('retains the exception headline and bounded stderr tail when a worker fails', () => {
    const headline = 'SessionFormatUnsupportedError: source chronology cannot be migrated'
    const stderr = [headline, ...Array.from({ length: 30 }, (_, index) => 'stack frame ' + String(index)), 'Node.js test'].join('\n')
    const run: WorkerRun = { report: undefined, exitCode: 1, signal: null, timedOut: false, stderr }
    expect(() => requireReport(run, 'agent-resume')).toThrow(headline)
    expect(() => requireReport(run, 'agent-resume')).toThrow('Node.js test')
    expect(() => requireReport(run, 'agent-resume')).not.toThrow('stack frame 15')
    expect(() => requireReport({ ...run, stderr: 'FATAL ERROR: heap limit' }, 'agent-resume', 128))
      .toThrow('128 MB old space')
  })

  it('migrates the generated workload and reopens its successor without changing V0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-bench-fixture-'))
    const contexts: Context[] = []
    const mount = async () => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
      return ctx.sessionPersistence
    }
    try {
      const facts = await writeSyntheticReleasedV0Session(root, { turns: 2, textDeltas: 12 })
      expect({ events: facts.events, rows: facts.rows, frames: facts.frames }).toEqual({ events: 54, rows: 28, frames: 29 })
      const original = await readFile(facts.path)
      const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
      const persistence = await mount()
      const read = await persistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
      const initial = await read.read()
      const session = Session.fromRestore(read.header.id, initial.events, read.header, read.inheritedEventCount, initial.eventState)
      expect(read.header.version).toBe(SESSION_FORMAT_VERSION)
      expect(initial.events.filter(event => event.type === 'system/message')).toHaveLength(1)
      expect(session.deriveMessages().map(({ id, role, content }) => ({ id, role, content }))).toEqual(
        [1, 2].flatMap(turn => [
          { id: 'user-' + String(turn), role: 'user', content: [{ type: 'text', text: 'prompt ' + String(turn) }] },
          { id: 'assistant-' + String(turn), role: 'assistant', content: [
            { type: 'reasoning', text: 'r0 r1 r2 ' },
            { type: 'text', text: Array.from({ length: 12 }, (_, index) => 'w' + String(index) + ' ').join('') },
          ] },
        ]),
      )
      await read.close()
      expect(await readdir(directory)).toEqual([SYNTHETIC_V0_FILENAME])
      const writer = await persistence.open(SessionId(SYNTHETIC_SESSION_ID), 'write')
      expect((await writer.read()).events).toEqual(initial.events)
      await writer.close()
      expect(await readdir(directory)).toContain(SYNTHETIC_CURRENT_FILENAME)
      const reopened = await (await mount()).open(SessionId(SYNTHETIC_SESSION_ID), 'read')
      expect((await reopened.read()).events).toEqual(initial.events)
      await reopened.close()
      expect(await readFile(facts.path)).toEqual(original)
    } finally {
      try {
        for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })
})

describe('opening a large Session for first open and post-upgrade reopen', () => {
  const suite = new SessionOpenBenchmarkSuite()

  beforeAll(async () => { await suite.prepare() })
  afterAll(async () => { await suite.dispose() })

  for (const access of ACCESS_BENCHMARKS) {
    describe(access.label, () => {
      it('profiles all four phases under normal heap', async () => {
        const result = summarizePhases(await suite.sample(access.accessKind, 'phases'))
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/phases`,
          ...suite.workload(access.accessKind),
          result,
          budgetsMs: {
            open: access.openBudgetMs,
            read: READ_BUDGET_MS,
            sessionRestore: SESSION_RESTORE_BUDGET_MS,
            projection: PROJECTION_BUDGET_MS,
          },
        }))
        expectOpenWithinBudget(result.openMs.median, access.openBudgetMs)
        expect(result.readMs.median).toBeLessThanOrEqual(READ_BUDGET_MS)
        expect(result.sessionRestoreMs.median).toBeLessThanOrEqual(SESSION_RESTORE_BUDGET_MS)
        expect(result.projectionMs.median).toBeLessThanOrEqual(PROJECTION_BUDGET_MS)
      })

      it(`completes all four phases under a ${String(CONSTRAINED_HEAP_MB)} MB old-space limit`, async () => {
        const report = await suite.run(access.accessKind, 'phases', CONSTRAINED_HEAP_MB)
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/phases-constrained`,
          ...suite.workload(access.accessKind),
          heapLimitMb: CONSTRAINED_HEAP_MB,
          report,
        }))
      })

      it(`produces first Host history within ${String(access.firstHistoryBudgetMs)} ms`, async () => {
        const result = summarize(await suite.sample(access.accessKind, 'first-history'))
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/first-history`,
          ...suite.workload(access.accessKind),
          result,
          budgetMs: access.firstHistoryBudgetMs,
        }))
        expect(result.totalMs.median).toBeLessThanOrEqual(access.firstHistoryBudgetMs)
      })

      it(`produces first Host history under a ${String(CONSTRAINED_HEAP_MB)} MB old-space limit`, async () => {
        const report = await suite.run(access.accessKind, 'first-history', CONSTRAINED_HEAP_MB)
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/first-history-constrained`,
          ...suite.workload(access.accessKind),
          heapLimitMb: CONSTRAINED_HEAP_MB,
          report,
        }))
      })

      it(`resumes a cold Agent within ${String(access.agentResumeBudgetMs)} ms`, async () => {
        const result = summarize(await suite.sample(access.accessKind, 'agent-resume'))
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/agent-resume`,
          ...suite.workload(access.accessKind),
          result,
          budgetMs: access.agentResumeBudgetMs,
          retainedHeapBudgetMb: AGENT_RETAINED_HEAP_BUDGET_MB,
        }))
        expect(result.totalMs.median).toBeLessThanOrEqual(access.agentResumeBudgetMs)
        expect(result.retainedHeapMb.median).toBeLessThanOrEqual(AGENT_RETAINED_HEAP_BUDGET_MB)
      })

      it(`resumes a cold Agent under a ${String(CONSTRAINED_HEAP_MB)} MB old-space limit`, async () => {
        const report = await suite.run(access.accessKind, 'agent-resume', CONSTRAINED_HEAP_MB)
        console.log(JSON.stringify({
          benchmark: `session-open/${access.accessKind}/agent-resume-constrained`,
          ...suite.workload(access.accessKind),
          heapLimitMb: CONSTRAINED_HEAP_MB,
          report,
        }))
      })
    })
  }
})
