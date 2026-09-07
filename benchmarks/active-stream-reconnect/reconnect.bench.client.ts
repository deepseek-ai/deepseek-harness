/** Required baseline budgets for reconnecting during a large active Assistant stream. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import type { ReconnectReport } from './reconnect.worker.client.ts'

const EXPECTED_REPLACE_CI_MS = 50
const REPLACE_BUDGET_MS = Math.ceil(EXPECTED_REPLACE_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const REFERENCE_RETAINED_MB = 24
const SAMPLES = 3

function expectReplacementWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

it('accepts recorded hosted reconnect samples and rejects replacement regressions', () => {
  const recordedMedian = [46.574411, 46.067910, 44.193704].toSorted((a, b) => a - b)[1]!
  expect(() => expectReplacementWithinBudget(recordedMedian, ciTimeBudget(16))).toThrow()
  expectReplacementWithinBudget(recordedMedian, REPLACE_BUDGET_MS)
  expect(REPLACE_BUDGET_MS).toBe(63)
  expect(() => expectReplacementWithinBudget(75, REPLACE_BUDGET_MS)).toThrow()
  expect(() => expectReplacementWithinBudget(REPLACE_BUDGET_MS + 1, REPLACE_BUDGET_MS)).toThrow()
})

it('reconstructs a 100000-delta live prefix within baseline time and retained-memory budgets', async () => {
  const samples: ReconnectReport[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const run = await runBuiltBenchmarkWorker<ReconnectReport>({
      worker: join(import.meta.dirname, '../.dsh-build/active-stream-reconnect/reconnect.worker.js'),
      exposeGc: true, timeoutMs: 30000,
    })
    expect(run.timedOut, run.stderr).toBe(false)
    expect(run.signal, run.stderr).toBeNull()
    expect(run.exitCode, run.stderr).toBe(0)
    if (run.report === undefined) throw new Error('reconnect worker omitted report')
    expect(run.report.nextFrame).toBe('transient')
    expect(run.report.entries).toBeGreaterThan(0)
    samples.push(run.report)
  }
  const replaceMs = samples.map(sample => sample.replaceMs).toSorted((a, b) => a - b)[1]!
  const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[1]!
  const budgetMs = REPLACE_BUDGET_MS
  const budgetMb = REFERENCE_RETAINED_MB * PERFORMANCE_BUDGET_HEADROOM
  console.log(JSON.stringify({ benchmark: 'active-stream-reconnect', samples, median: { replaceMs, retainedMb }, expectedCiMs: EXPECTED_REPLACE_CI_MS, referenceMb: REFERENCE_RETAINED_MB, budgetMs, budgetMb }))
  expectReplacementWithinBudget(replaceMs, budgetMs)
  expect.soft(retainedMb).toBeLessThanOrEqual(budgetMb)
})
