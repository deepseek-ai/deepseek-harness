/** Required budgets for listing, searching, and forking Sessions in corpora with the measured local length distribution. */

import { mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordPeakMemory, recordTimings, type BenchmarkCase, type Timing } from '../support/scaling-report.ts'
import { anchorShape, ANCHOR_COUNT, sessionShape } from './corpus-shape.ts'
import { subagentRank } from './synthetic-corpus.ts'
import type {
  AnchorsReport,
  ForkReport,
  ListReport,
  PhaseCpu,
  SearchReport,
  SeedReport,
  SessionCorpusReport,
} from './session-corpus.worker.ts'

/**
 * Sessions per corpus. Search and fork use separate roots, so fork children never reach the search index;
 * the list corpus is the largest that keeps this file within its time limit.
 */
const CORPUS = { search: 1_000, fork: 1_000, list: 3_000 } as const
/** Upper bound on this file's hosted CI wall time, from seeding through the last case. */
const FILE_LIMIT_MS = 300_000
/** Per-child deadline: an endpoint slower than its budget still reports a measurement instead of a kill. */
const WORKER_TIMEOUT_MS = FILE_LIMIT_MS
/** Fresh processes per list and fork-strata scenario; the median enforces each budget. */
const ATTEMPTS = { list: 3, fork: 3 } as const
/** Concurrent anchor-preparation processes; standard hosted runners have two CPUs. */
const PREPARATION_PROCESSES = 2
/** Midpoints of ten equal length strata of the fork corpus. */
const FORK_STRATA = Array.from({ length: 10 }, (_, stratum) => Math.floor(((stratum + 0.5) * CORPUS.fork) / 10))
/** The highest top-level rank at the measured p99; forking a subagent child adds a lineage lookup. */
const FORK_P99_RANK = topLevelRank(Math.ceil(0.99 * CORPUS.fork) - 1)
/** The longest Session; one sample, because one fork takes about 20 s on standard hosted CI. */
const FORK_LONGEST_RANK = CORPUS.fork - 1
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'session-corpus.worker.js')

/** Higher recorded median of the standard EPYC 7763 and EPYC 9V74 hosted runners, per budgeted endpoint. */
const RECORDED_CI_MS = {
  listBoot: 2_317.8,
  listFirst: 3_228.7,
  listRepeat: 2_636.4,
  searchFirst: 144_359,
  searchRepeat: 3_426.3,
  forkStratumMedian: 95.5,
  forkP99: 1_066.2,
  forkLongest: 20_326.7,
} as const
/** Hosted CI expectations, rounded above {@link RECORDED_CI_MS} before variance headroom. */
const EXPECTED_CI_MS = {
  listBoot: 2_400,
  listFirst: 3_300,
  listRepeat: 2_700,
  searchFirst: 145_000,
  searchRepeat: 3_500,
  forkStratumMedian: 100,
  forkP99: 1_100,
  forkLongest: 20_400,
} as const satisfies Record<keyof typeof RECORDED_CI_MS, number>
/** Higher recorded peak RSS of the two runner models; memory takes headroom but no time scale. */
const RECORDED_CI_PEAK_RSS_MB = { list: 742.7, search: 1_197.8, fork: 745.1 } as const
const EXPECTED_CI_PEAK_RSS_MB = {
  list: 750,
  search: 1_200,
  fork: 750,
} as const satisfies Record<keyof typeof RECORDED_CI_PEAK_RSS_MB, number>

const CASES: Readonly<Record<CorpusName, BenchmarkCase>> = {
  list: {
    id: `session-corpus/list-${String(CORPUS.list)}`,
    measures: `Cold Web Host boot, then first and repeated session.list over ${CORPUS.list.toLocaleString('en-US')} Sessions of realistic length.`,
    affects: 'Starting DSH and showing the Session list for a heavy user.',
  },
  search: {
    id: 'session-corpus/search',
    measures: `First session.search, which builds the content index over ${CORPUS.search.toLocaleString('en-US')} Sessions, then a second query.`,
    affects: 'Searching Session content in deployments that enable search; shipped profiles disable it.',
  },
  fork: {
    id: 'session-corpus/fork',
    measures: `session.fork for ten length strata, the p99 Session, and the longest of ${CORPUS.fork.toLocaleString('en-US')} Sessions.`,
    affects: 'Forking a conversation to try another direction.',
  },
}

type CorpusName = keyof typeof CORPUS

/**
 * Pair the median wall time of each list phase with the median process CPU time of the same phase.
 * @param samples - Wall-clock samples per phase.
 * @param cpu - CPU time per sample.
 * @returns Endpoints for the scaled report.
 */
function phaseTimings(
  samples: Readonly<Record<keyof PhaseCpu, readonly number[]>>,
  cpu: readonly PhaseCpu[],
): Record<keyof PhaseCpu, Timing> {
  const phase = (key: keyof PhaseCpu): Timing => ({ ms: median(samples[key]), cpuMs: median(cpu.map(entry => entry[key])) })
  return { bootMs: phase('bootMs'), firstMs: phase('firstMs'), repeatMs: phase('repeatMs') }
}

function topLevelRank(rank: number): number {
  return subagentRank(rank) ? rank - 1 : rank
}

function budget(expected: number): number {
  return Math.ceil(expected * PERFORMANCE_BUDGET_HEADROOM)
}

/** Test deadline for sequential workers; it outlasts their deadlines, so every child is reaped before cleanup. */
function serialDeadline(workers: number): number {
  return workers * WORKER_TIMEOUT_MS + 30_000
}

async function run<Report extends SessionCorpusReport>(args: readonly string[]): Promise<Report> {
  const outcome = await runBuiltBenchmarkWorker<Report>({ worker: WORKER, args, timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true })
  if (outcome.report === undefined) {
    const stderr = outcome.stderr.trim().split('\n').slice(-20).join('\n')
    throw new Error(`session-corpus worker ${args[1] ?? ''} failed: exit=${String(outcome.exitCode)}, `
      + `signal=${String(outcome.signal)}, timedOut=${String(outcome.timedOut)}\n${stderr}`)
  }
  return outcome.report
}

/**
 * Split anchors into byte-balanced groups, each in ascending order so its byte model starts on small bodies.
 * @returns one anchor group per preparation process.
 */
function anchorGroups(): number[][] {
  const groups = Array.from({ length: PREPARATION_PROCESSES }, () => ({ bytes: 0, anchors: [] as number[] }))
  const bySize = Array.from({ length: ANCHOR_COUNT }, (_, anchor) => anchor)
    .sort((left, right) => anchorShape(right).logicalBytes - anchorShape(left).logicalBytes)
  for (const anchor of bySize) {
    const group = groups.reduce((smallest, candidate) => candidate.bytes < smallest.bytes ? candidate : smallest)
    group.bytes += anchorShape(anchor).logicalBytes
    group.anchors.push(anchor)
  }
  return groups.map(group => group.anchors.sort((left, right) => left - right))
}

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number
}

function rounded(values: readonly number[]): number[] {
  return values.map(value => Math.round(value * 10) / 10)
}

function expectWithinBudget(value: number, limit: number): void {
  expect(value).toBeLessThanOrEqual(limit)
}

function environment() {
  return {
    cpu: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  }
}

describe('Session corpus workload', () => {
  it('is at least the measured distribution at every rank of every corpus', () => {
    for (const count of Object.values(CORPUS)) {
      const shapes = Array.from({ length: count }, (_, rank) => sessionShape(rank, count))
      expect(new Set(shapes.map(shape => shape.anchor)).size).toBe(ANCHOR_COUNT)
      expect(shapes[Math.floor(count / 2) - 1]).toEqual(anchorShape(4))
      expect(shapes.at(-1)).toEqual({ anchor: ANCHOR_COUNT - 1, events: 84_467, logicalBytes: 48_139_877, turns: 2_181 })
      for (let rank = 1; rank < count; rank++) {
        const [previous, current] = [shapes[rank - 1], shapes[rank]] as const
        expect(current?.events).toBeGreaterThanOrEqual(previous?.events ?? 0)
        expect(current?.logicalBytes).toBeGreaterThanOrEqual(previous?.logicalBytes ?? 0)
      }
    }
    expect(() => sessionShape(CORPUS.fork, CORPUS.fork)).toThrow('outside')
  })

  it('forks top-level Sessions at the strata midpoints, the measured p99, and the maximum', () => {
    const ranks = [...FORK_STRATA, FORK_P99_RANK, FORK_LONGEST_RANK]
    expect(ranks.filter(subagentRank)).toEqual([])
    expect(FORK_STRATA).toEqual([50, 150, 250, 350, 450, 550, 650, 750, 850, 950])
    expect(sessionShape(FORK_P99_RANK, CORPUS.fork).events).toBe(7_229)
    expect(sessionShape(FORK_LONGEST_RANK, CORPUS.fork).events).toBe(84_467)
  })

  it('accepts every recorded hosted median and rejects one a quarter above its expectation', () => {
    const endpoints = [
      ...(Object.keys(EXPECTED_CI_MS) as (keyof typeof EXPECTED_CI_MS)[])
        .map(key => [RECORDED_CI_MS[key], EXPECTED_CI_MS[key]] as const),
      ...(Object.keys(EXPECTED_CI_PEAK_RSS_MB) as (keyof typeof EXPECTED_CI_PEAK_RSS_MB)[])
        .map(key => [RECORDED_CI_PEAK_RSS_MB[key], EXPECTED_CI_PEAK_RSS_MB[key]] as const),
    ]
    expect(endpoints).toHaveLength(11)
    for (const [recorded, expected] of endpoints) {
      expect(recorded).toBeLessThanOrEqual(expected)
      expectWithinBudget(recorded, budget(expected))
      expect(() => expectWithinBudget(Math.ceil(expected * 1.26), budget(expected))).toThrow()
    }
  })
})

describe('Session corpus operations', () => {
  let scratch = ''
  let started = 0
  let seeded: readonly SeedReport[] = []
  const root = (name: CorpusName): string => join(scratch, `corpus-${name}`)

  beforeAll(async () => {
    started = performance.now()
    scratch = await mkdtemp(join(tmpdir(), 'dsh-session-corpus-bench-'))
    const prepared = await Promise.all(anchorGroups().map(group => run<AnchorsReport>([scratch, 'anchors', ...group.map(String)])))
    seeded = await Promise.all((Object.keys(CORPUS) as CorpusName[])
      .map(name => run<SeedReport>([scratch, 'seed', name, String(CORPUS[name])])))
    console.log(JSON.stringify({ benchmark: 'session-corpus/seed', prepared, seeded, environment: environment() }))
  }, serialDeadline(2))

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  it('writes corpora at least as long as the measured distribution', () => {
    expect(seeded.map(report => report.name).sort()).toEqual(Object.keys(CORPUS).sort())
    for (const { name, corpus } of seeded) {
      const count = CORPUS[name as CorpusName]
      const shapes = Array.from({ length: count }, (_, rank) => sessionShape(rank, count))
      expect(corpus.sessions).toBe(count)
      expect(corpus.distinctBodies).toBe(ANCHOR_COUNT)
      expect(corpus.events).toBeGreaterThanOrEqual(shapes.reduce((sum, shape) => sum + shape.events, 0))
      expect(corpus.logicalBytes).toBeGreaterThanOrEqual(shapes.reduce((sum, shape) => sum + shape.logicalBytes, 0))
    }
  })

  it(`lists ${String(CORPUS.list)} Sessions after a cold Host boot`, async () => {
    const budgets = {
      bootMs: budget(EXPECTED_CI_MS.listBoot),
      firstMs: budget(EXPECTED_CI_MS.listFirst),
      repeatMs: budget(EXPECTED_CI_MS.listRepeat),
      peakRssMb: budget(EXPECTED_CI_PEAK_RSS_MB.list),
    }
    const reports: ListReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.list; attempt++) {
      reports.push(await run<ListReport>([root('list'), 'list', String(CORPUS.list)]))
    }
    const samples = {
      bootMs: rounded(reports.map(report => report.bootMs)),
      firstMs: rounded(reports.map(report => report.firstMs)),
      repeatMs: rounded(reports.map(report => report.repeatMs)),
      peakRssMb: reports.map(report => report.memory.peakRssMb),
      heapUsedMb: reports.map(report => report.memory.heapUsedMb),
    }
    console.log(JSON.stringify({ benchmark: `session-corpus/list-${String(CORPUS.list)}`, samples, budgets, environment: environment() }))
    recordTimings(CASES.list, phaseTimings(samples, reports.map(report => report.cpu)),
      { bootMs: budgets.bootMs, firstMs: budgets.firstMs, repeatMs: budgets.repeatMs })
    recordPeakMemory(CASES.list, { peakRssMb: Math.max(...samples.peakRssMb) })
    for (const report of reports) expect(report.itemsWithProjections).toBe(CORPUS.list)
    expectWithinBudget(median(samples.bootMs), budgets.bootMs)
    expectWithinBudget(median(samples.firstMs), budgets.firstMs)
    expectWithinBudget(median(samples.repeatMs), budgets.repeatMs)
    expectWithinBudget(median(samples.peakRssMb), budgets.peakRssMb)
  }, serialDeadline(ATTEMPTS.list))

  it(`searches ${String(CORPUS.search)} Sessions with a cold and then a built content index`, async () => {
    const budgets = {
      firstMs: budget(EXPECTED_CI_MS.searchFirst),
      repeatMs: budget(EXPECTED_CI_MS.searchRepeat),
      peakRssMb: budget(EXPECTED_CI_PEAK_RSS_MB.search),
    }
    // One sample: the cold index build dominates this file's time.
    const report = await run<SearchReport>([root('search'), 'search'])
    console.log(JSON.stringify({ benchmark: 'session-corpus/search', report, budgets, environment: environment() }))
    recordTimings(CASES.search, {
      firstMs: { ms: report.firstMs, cpuMs: report.cpu.firstMs },
      repeatMs: { ms: report.repeatMs, cpuMs: report.cpu.repeatMs },
    }, { firstMs: budgets.firstMs, repeatMs: budgets.repeatMs })
    recordPeakMemory(CASES.search, { peakRssMb: report.memory.peakRssMb })
    expectWithinBudget(report.firstMs, budgets.firstMs)
    expectWithinBudget(report.repeatMs, budgets.repeatMs)
    expectWithinBudget(report.memory.peakRssMb, budgets.peakRssMb)
  }, serialDeadline(1))

  it(`forks Sessions across the length distribution of ${String(CORPUS.fork)} Sessions`, async () => {
    const budgets = {
      stratumMedianMs: budget(EXPECTED_CI_MS.forkStratumMedian),
      p99Ms: budget(EXPECTED_CI_MS.forkP99),
      longestMs: budget(EXPECTED_CI_MS.forkLongest),
      peakRssMb: budget(EXPECTED_CI_PEAK_RSS_MB.fork),
    }
    const reports: ForkReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS.fork; attempt++) {
      reports.push(await run<ForkReport>([root('fork'), 'fork', ...[...FORK_STRATA, FORK_P99_RANK].map(String)]))
    }
    const longest = await run<ForkReport>([root('fork'), 'fork', String(FORK_LONGEST_RANK)])
    const forkEntry = (report: ForkReport, rank: number): ForkReport['forks'][number] => {
      const fork = report.forks.find(entry => entry.rank === rank)
      if (fork === undefined) throw new Error(`fork report omits rank ${String(rank)}`)
      return fork
    }
    const forkMs = (report: ForkReport, rank: number): number => forkEntry(report, rank).forkMs
    const forkCpuMs = (report: ForkReport, rank: number): number => forkEntry(report, rank).forkCpuMs
    const samples = {
      stratumMedianMs: rounded(reports.map(report => median(FORK_STRATA.map(rank => forkMs(report, rank))))),
      p99Ms: rounded(reports.map(report => forkMs(report, FORK_P99_RANK))),
      longestMs: Math.round(forkMs(longest, FORK_LONGEST_RANK) * 10) / 10,
      perRank: reports.map(report => report.forks.map(({ rank, sourceEvents, forkMs }) => ({ rank, sourceEvents, forkMs: Math.round(forkMs) }))),
      peakRssMb: [...reports, longest].map(report => report.memory.peakRssMb),
    }
    console.log(JSON.stringify({ benchmark: 'session-corpus/fork', samples, budgets, environment: environment() }))
    recordTimings(CASES.fork, {
      stratumMedianMs: {
        ms: median(samples.stratumMedianMs),
        cpuMs: median(reports.map(report => median(FORK_STRATA.map(rank => forkCpuMs(report, rank))))),
      },
      p99Ms: { ms: median(samples.p99Ms), cpuMs: median(reports.map(report => forkCpuMs(report, FORK_P99_RANK))) },
      longestMs: { ms: samples.longestMs, cpuMs: forkCpuMs(longest, FORK_LONGEST_RANK) },
    },
      { stratumMedianMs: budgets.stratumMedianMs, p99Ms: budgets.p99Ms, longestMs: budgets.longestMs })
    recordPeakMemory(CASES.fork, { peakRssMb: Math.max(...samples.peakRssMb) })
    expectWithinBudget(median(samples.stratumMedianMs), budgets.stratumMedianMs)
    expectWithinBudget(median(samples.p99Ms), budgets.p99Ms)
    expectWithinBudget(samples.longestMs, budgets.longestMs)
    expectWithinBudget(Math.max(...samples.peakRssMb), budgets.peakRssMb)
  }, serialDeadline(ATTEMPTS.fork + 1))

  it(`completes within ${String(FILE_LIMIT_MS / 60_000)} minutes`, () => {
    const elapsedMs = performance.now() - started
    console.log(JSON.stringify({ benchmark: 'session-corpus/total', elapsedMs: Math.round(elapsedMs), limitMs: FILE_LIMIT_MS }))
    expectWithinBudget(elapsedMs, FILE_LIMIT_MS)
  })
})
