/** Bounded terminal output must not rescan a full retained window on every chunk. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import type { TerminalIoReport } from './terminal-io.worker.ts'

const MIB = 1024 * 1024
const ATTEMPTS = 5
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'terminal-io', 'terminal-io.worker.js')
/** M5 Pro / Node 26.5 reference expectations, before shared CI scaling and headroom. */
const EXPECTED_MS = { steadyIngest: 20, steadyComplete: 50, fullComplete: 120 }
const MAX_CAPACITY_RATIO = 4
const MAX_RETAINED_HEAP_BYTES = 16 * MIB

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
}

async function sample(capacity: number, mode: 'steady' | 'full' | 'tiny' | 'filtered'): Promise<TerminalIoReport> {
  const outcome = await runBuiltBenchmarkWorker<TerminalIoReport>({
    worker: WORKER, args: [String(capacity), mode], timeoutMs: 120_000, exposeGc: true,
  })
  if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
    throw new Error('terminal I/O worker failed: ' + JSON.stringify(outcome))
  }
  return outcome.report
}

it('bounds steady overflow cost as retained terminal capacity grows 32 times', async () => {
  const small: TerminalIoReport[] = []
  const large: TerminalIoReport[] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    small.push(await sample(128 * 1024, 'steady'))
    large.push(await sample(4 * MIB, 'steady'))
  }
  const capacityRatio = median(large.map(row => row.ingestMs)) / median(small.map(row => row.ingestMs))
  const ingestBudgetMs = ciTimeBudget(EXPECTED_MS.steadyIngest)
  const completeBudgetMs = ciTimeBudget(EXPECTED_MS.steadyComplete)
  console.log(JSON.stringify({ scenario: 'terminal-steady', small, large, capacityRatio, ingestBudgetMs, completeBudgetMs }))
  expect(capacityRatio).toBeLessThanOrEqual(MAX_CAPACITY_RATIO)
  for (const rows of [small, large]) {
    expect(median(rows.map(row => row.ingestMs))).toBeLessThanOrEqual(ingestBudgetMs)
    expect(median(rows.map(row => row.completeMs))).toBeLessThanOrEqual(completeBudgetMs)
    expect(Math.max(...rows.map(row => row.retainedHeapBytes))).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
  }
})

it('bounds retained memory when five MiB arrives in sixteen-byte chunks', async () => {
  const report = await sample(4 * MIB, 'tiny')
  console.log(JSON.stringify({ scenario: 'terminal-tiny-chunks', report, heapBudgetBytes: MAX_RETAINED_HEAP_BYTES }))
  expect(report.retainedHeapBytes).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
})

it('releases filtered OSC storage behind retained visible string slices', async () => {
  const report = await sample(4 * MIB, 'filtered')
  console.log(JSON.stringify({ scenario: 'terminal-filtered-chunks', report, heapBudgetBytes: MAX_RETAINED_HEAP_BYTES }))
  expect(report.retainedHeapBytes).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
})

it('completes a five MiB terminal send with bounded retained output', async () => {
  const samples: TerminalIoReport[] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) samples.push(await sample(4 * MIB, 'full'))
  const completeMedianMs = median(samples.map(row => row.completeMs))
  const completeBudgetMs = ciTimeBudget(EXPECTED_MS.fullComplete)
  console.log(JSON.stringify({ scenario: 'terminal-five-mib', samples, completeMedianMs, completeBudgetMs }))
  expect(completeMedianMs).toBeLessThanOrEqual(completeBudgetMs)
  expect(Math.max(...samples.map(row => row.retainedHeapBytes))).toBeLessThanOrEqual(MAX_RETAINED_HEAP_BYTES)
})
