/** Baseline budgets for long-history requests, tool continuation, and fork-child discovery. */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import type { ContinuationReport } from './agent-continuation.worker.ts'
import type { CatalogReport } from './child-catalog.worker.ts'
import type { ProfileReport } from './profile-continuation.worker.ts'
import { WORKLOAD } from './workload.ts'

const ATTEMPTS = 5
const WORKER_TIMEOUT_MS = 60_000
/** M4 Pro / Node 24.19 baseline expectations, before shared CI scaling and variance headroom. */
const EXPECTED_MS = { 'profile-continuation': 1_700 } as const
/** Standard two-CPU hosted CI baseline request-history median is 582.304 ms. */
const EXPECTED_BASELINE_REQUEST_CI_MS = 600
const BASELINE_REQUEST_BUDGET_MS = Math.ceil(EXPECTED_BASELINE_REQUEST_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
/** Standard two-CPU hosted CI tool-continuation median is 898.252 ms. */
const EXPECTED_TOOL_CONTINUATION_CI_MS = 900
const TOOL_CONTINUATION_BUDGET_MS = Math.ceil(EXPECTED_TOOL_CONTINUATION_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
/** Standard two-CPU hosted CI catalog median is 858.364 ms; 900 ms is the rounded expectation. */
const EXPECTED_CATALOG_CI_MS = 900
const CATALOG_BUDGET_MS = Math.ceil(EXPECTED_CATALOG_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
/** Two-CPU ubuntu-24.04 / Node 24.20 samples span 182.161–185.042 ms; rounded CI expectation. */
const EXPECTED_REQUEST_HISTORY_CI_MS = 190
const REQUEST_HISTORY_BUDGET_MS = Math.ceil(EXPECTED_REQUEST_HISTORY_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const EXPECTED_RETAINED_HEAP_MB = 23
const WORKERS = join(import.meta.dirname, '..', '.dsh-build', 'agent-continuation')

type Scenario = 'request-history' | 'catalog' | 'tool-continuation' | keyof typeof EXPECTED_MS
type Report = ContinuationReport | CatalogReport | ProfileReport

function workerName(scenario: Scenario): string {
  if (scenario === 'profile-continuation') return 'profile-continuation.worker.js'
  return scenario === 'catalog' ? 'child-catalog.worker.js' : 'agent-continuation.worker.js'
}

async function run<Output>(root: string, scenario: Scenario, mode: string): Promise<Output> {
  const outcome = await runBuiltBenchmarkWorker<Output>({
    worker: join(WORKERS, workerName(scenario)), args: [root, mode],
    timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
  })
  if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
    throw new Error('backend worker failed: ' + JSON.stringify(outcome))
  }
  return outcome.report
}

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
}

function expectTotalWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

describe('standard hosted catalog calibration', () => {
  it('accepts the recorded two-CPU samples that exceed the historical budget', () => {
    const recordedMedian = median([797.373945, 883.157358, 858.363927, 790.568538, 904.5785669999999])

    expect(recordedMedian).toBe(858.363927)
    expect(() => expectTotalWithinBudget(recordedMedian, 800)).toThrow()
    expectTotalWithinBudget(recordedMedian, CATALOG_BUDGET_MS)
    expect(CATALOG_BUDGET_MS).toBe(1_125)
  })

  it('rejects a synthetic material catalog regression', () => {
    const regressionMedian = median([1_380, 1_400, 1_420, 1_410, 1_390])

    expect(regressionMedian).toBe(1_400)
    expect(() => expectTotalWithinBudget(regressionMedian, CATALOG_BUDGET_MS)).toThrow()
  })
})

describe('standard hosted tool-continuation calibration', () => {
  it('accepts recorded two-CPU samples but rejects a material regression', () => {
    const recordedMedian = median([917.006744, 892.091482, 887.838867, 905.6594390000001, 898.2517579999999])

    expect(recordedMedian).toBe(898.2517579999999)
    expect(() => expectTotalWithinBudget(recordedMedian, 850)).toThrow()
    expectTotalWithinBudget(recordedMedian, TOOL_CONTINUATION_BUDGET_MS)
    expect(TOOL_CONTINUATION_BUDGET_MS).toBe(1_125)
    expect(() => expectTotalWithinBudget(1_400, TOOL_CONTINUATION_BUDGET_MS)).toThrow()
  })
})

describe('standard hosted baseline request-history calibration', () => {
  it('accepts recorded two-CPU samples but rejects a material regression', () => {
    const recordedMedian = median([618.598065, 618.606407, 582.0351149999999, 582.303506, 581.8318300000001])

    expect(recordedMedian).toBe(582.303506)
    expect(() => expectTotalWithinBudget(recordedMedian, 550)).toThrow()
    expectTotalWithinBudget(recordedMedian, BASELINE_REQUEST_BUDGET_MS)
    expect(BASELINE_REQUEST_BUDGET_MS).toBe(750)
    expect(() => expectTotalWithinBudget(900, BASELINE_REQUEST_BUDGET_MS)).toThrow()
  })
})

function assertRequestHistoryBudget(value: number): void {
  expect(value).toBeLessThanOrEqual(REQUEST_HISTORY_BUDGET_MS)
}

describe('standard hosted request-history calibration', () => {
  it('accepts the recorded two-CPU samples above the historical budget', () => {
    const recorded = [183.355397, 184.468253, 185.042397, 182.160790, 182.924728]
    const recordedMedian = median(recorded)

    expect(recordedMedian).toBe(183.355397)
    expect(recordedMedian).toBeGreaterThan(ciTimeBudget(70))
    assertRequestHistoryBudget(recordedMedian)
    assertRequestHistoryBudget(Math.max(...recorded))
    expect(REQUEST_HISTORY_BUDGET_MS).toBe(238)
  })

  it('rejects a synthetic material request-history regression', () => {
    const regressionMedian = median([248, 250, 252, 251, 249])
    expect(() => assertRequestHistoryBudget(regressionMedian)).toThrow()
  })

  it('rejects the recorded original implementation on the M4 reference', () => {
    const originalMedian = median([249.050708, 238.275291, 242.172084, 250.093166, 246.130875])
    expect(originalMedian).toBe(246.130875)
    expect(() => assertRequestHistoryBudget(originalMedian)).toThrow()
  })
})

describe('continuing tool-heavy Sessions with large histories', () => {
  let scratch: string | undefined
  const sources = new Map<Scenario, string>()

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-continuation-bench-'))
    for (const scenario of ['request-history', 'catalog'] as const) {
      const root = join(scratch, 'source-' + scenario)
      await run(root, scenario, 'seed')
      sources.set(scenario, root)
    }
    sources.set('tool-continuation', sources.get('request-history') as string)
  })
  afterAll(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  })

  for (const scenario of ['request-history', 'tool-continuation', 'catalog', 'profile-continuation'] as const) {
    it(scenario, async () => {
      const samples: Report[] = []
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const root = join(scratch as string, scenario + '-' + String(attempt))
        if (scenario === 'profile-continuation') await mkdir(root)
        else await cp(sources.get(scenario) as string, root, { recursive: true })
        try { samples.push(await run<Report>(root, scenario, scenario)) }
        finally { await rm(root, { recursive: true, force: true }) }
      }
      const totalMs = samples.map(sample => sample.totalMs)
      const budgetMs = scenario === 'request-history' ? REQUEST_HISTORY_BUDGET_MS
        : scenario === 'catalog' ? CATALOG_BUDGET_MS
          : scenario === 'tool-continuation' ? TOOL_CONTINUATION_BUDGET_MS : ciTimeBudget(EXPECTED_MS[scenario])
      const retainedHeapBudgetMb = EXPECTED_RETAINED_HEAP_MB * PERFORMANCE_BUDGET_HEADROOM
      console.log(JSON.stringify({
        benchmark: 'agent-continuation/' + scenario, workload: WORKLOAD,
        samples, totalMs: { min: Math.min(...totalMs), median: median(totalMs), max: Math.max(...totalMs) },
        budgetMs, ...(scenario === 'tool-continuation' ? { retainedHeapBudgetMb } : {}),
      }))
      if (scenario === 'request-history') assertRequestHistoryBudget(median(totalMs))
      else expectTotalWithinBudget(median(totalMs), budgetMs)
      if (scenario === 'tool-continuation') {
        expect(median((samples as ContinuationReport[]).map(sample => sample.retainedHeapMb)))
          .toBeLessThanOrEqual(retainedHeapBudgetMb)
      }
    })
  }
})
