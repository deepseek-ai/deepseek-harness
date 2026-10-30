/** Required performance budgets for compiled Client history folding and live Assistant updates. */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import {
  ciTimeBudget,
  PERFORMANCE_BUDGET_HEADROOM,
} from '../support/calibration.ts'
import { recordPeakMemory, recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type { ConversationFoldWorkerReport, PreparingToolWorkerReport, StreamingAssistantWorkerReport } from './conversation-fold.worker.client.ts'

/** Replies in the folded window; each carries one reasoning block and one text block. */
const TURNS = 200
/** Text deltas per reply in the large workload; each reply adds one quarter as many reasoning deltas. */
const LARGE_DELTAS = 2_000
/** Text deltas per reply in the small workload used as the scaling reference. */
const SMALL_DELTAS = 100
/** Fresh object graphs measured in one compiled worker; the fastest sample removes scheduler delay. */
const ATTEMPTS = 3
/** Folding and argument preparation run on in-memory Client state without storage access. */
const IO_SHARE = 0
const LARGE_WINDOW_CASE: BenchmarkCase = {
  id: 'conversation-fold/large-window',
  measures: 'Client fold of 200 replies whose 500,000 streamed deltas are compacted into 1,600 records.',
  affects: 'Opening or scrolling a long conversation in the Web GUI.',
}
const PREPARING_AFFECTS = { write: 'Watching the model stream a large file write.', bash: 'Watching the model stream a long shell command.' } as const
/** A stuck fold worker is reaped before the outer benchmark deadline. */
const WORKER_TIMEOUT_MS = 60_000

/**
 * The large window contains 500,000 streamed deltas compacted into 1,600
 * stream records. The budget separates the record-proportional fold from the
 * per-delta replay that needs hundreds of milliseconds for the same window.
 */
const EXPECTED_LARGE_FOLD_MS = 16
const LARGE_FOLD_BUDGET_MS = ciTimeBudget(EXPECTED_LARGE_FOLD_MS)

/**
 * Both windows contain equal event and compact-record counts. A fold over
 * records plus joined text measures about 2.5×; replaying every delta measures
 * about 11× as the delta count grows 20×.
 */
const EXPECTED_DELTA_SCALING = 2.5
const MAX_DELTA_SCALING = EXPECTED_DELTA_SCALING * PERFORMANCE_BUDGET_HEADROOM

const PREPARING_SAMPLES = 3
const PREPARING_CASES = [
  { tool: 'write', characters: 512 * 1024, expectedMs: 300, expectedMb: 30 },
  { tool: 'bash', characters: 128 * 1024, expectedMs: 150, expectedMb: 8 },
] as const

const STREAMING_CHARACTERS = 256 * 1024
const STREAMING_SAMPLES = 5
/** Reference-machine expectations; shared CI scaling applies only to elapsed time. */
const STREAMING_WORKLOADS = [
  { fragments: 4_096, expectedMs: 12 },
  { fragments: 16_384, expectedMs: 32 },
] as const
const STREAMING_CASES = STREAMING_WORKLOADS.flatMap(workload => [
  { ...workload, blockType: 'text', pattern: 'ordinary' },
  { ...workload, blockType: 'reasoning', pattern: 'leading-whitespace' },
] as const)
/** Incremental heap while the Assembler, live entries, and published Chat state remain reachable. */
const EXPECTED_STREAMING_RETAINED_MB = 16

const WORKER = join(
  import.meta.dirname,
  '..',
  '.dsh-build',
  'conversation-fold',
  'conversation-fold.worker.js',
)

function requireReport<Report>(
  run: BuiltBenchmarkWorkerRun<Report>,
): Report {
  if (run.report !== undefined) return run.report
  const stderrLines = run.stderr.trim().split('\n')
  throw new Error(
    `conversation-fold worker failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
    + `timedOut=${String(run.timedOut)}\n${stderrLines.slice(-10).join('\n')}`,
  )
}

describe('cold Chat fold of a large v2 history window', () => {
  it(`folds ${String(TURNS)} replies with ${String(LARGE_DELTAS)} deltas each within ${String(LARGE_FOLD_BUDGET_MS)} ms and scales with compact records`, async () => {
    const report = requireReport(await runBuiltBenchmarkWorker<ConversationFoldWorkerReport>({
      worker: WORKER,
      args: [String(TURNS), String(SMALL_DELTAS), String(LARGE_DELTAS), String(ATTEMPTS)],
      timeoutMs: WORKER_TIMEOUT_MS,
    }))
    console.log(JSON.stringify({
      benchmark: 'conversation-fold/large-window',
      ...report,
      budgetMs: LARGE_FOLD_BUDGET_MS,
      maxScaling: MAX_DELTA_SCALING,
    }))
    recordTimings(LARGE_WINDOW_CASE, { largeFoldMs: { ms: report.largeFoldMs, ioShare: IO_SHARE } }, { largeFoldMs: LARGE_FOLD_BUDGET_MS })
    expect(report.chatNodes).toBeGreaterThan(0)
    expect(report.largeFoldMs).toBeLessThanOrEqual(LARGE_FOLD_BUDGET_MS)
    expect(report.scaling).toBeLessThanOrEqual(MAX_DELTA_SCALING)
  })
})

describe('preparing tool arguments', () => {
  it.each(PREPARING_CASES)('publishes streamed $tool arguments within bounded CPU and heap costs', async (workload) => {
    const samples: PreparingToolWorkerReport[] = []
    for (let index = 0; index < PREPARING_SAMPLES; index++) {
      const run = await runBuiltBenchmarkWorker<PreparingToolWorkerReport>({
        worker: WORKER, args: ['preparing', workload.tool, String(workload.characters)],
        exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
      })
      expect(run.timedOut, run.stderr).toBe(false)
      expect(run.signal, run.stderr).toBeNull()
      expect(run.exitCode, run.stderr).toBe(0)
      const report = requireReport(run)
      expect(report.characters).toBe(workload.characters)
      if (workload.tool === 'write') {
        expect(report.progressKb).toBe(workload.characters / 1024)
        expect(report.filePath).toBe('preview.md')
      }
      expect(report.detail).toBe(workload.tool === 'write' ? 'preview.md' : `${'abcdefghijklmno '.repeat(10).slice(0, 159)}…`)
      samples.push(report)
    }
    const medianMs = samples.map(sample => sample.elapsedMs).toSorted((a, b) => a - b)[1]!
    const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[1]!
    const budgetMs = ciTimeBudget(workload.expectedMs)
    const budgetMb = workload.expectedMb * PERFORMANCE_BUDGET_HEADROOM
    console.log(JSON.stringify({ benchmark: `conversation-fold/preparing-${workload.tool}`, samples, medianMs, retainedMb, budgetMs, budgetMb }))
    recordTimings({
      id: `conversation-fold/preparing-${workload.tool}`,
      measures: `Client publishing of ${String(workload.characters / 1024)} KiB of streamed ${workload.tool} tool arguments.`,
      affects: PREPARING_AFFECTS[workload.tool],
    }, { medianMs: { ms: medianMs, ioShare: IO_SHARE } }, { medianMs: budgetMs })
    expect(medianMs).toBeLessThanOrEqual(budgetMs)
    expect(retainedMb).toBeLessThanOrEqual(budgetMb)
  })
})

describe('live Assistant text publication', () => {
  it.each(STREAMING_CASES)('publishes $fragments $blockType deltas with $pattern content within bounded CPU and heap costs', async (workload) => {
    const samples: StreamingAssistantWorkerReport[] = []
    for (let index = 0; index < STREAMING_SAMPLES; index++) {
      const run = await runBuiltBenchmarkWorker<StreamingAssistantWorkerReport>({
        worker: WORKER,
        args: ['streaming', workload.blockType, workload.pattern, String(STREAMING_CHARACTERS), String(workload.fragments)],
        exposeGc: true, timeoutMs: WORKER_TIMEOUT_MS,
      })
      expect(run.timedOut, run.stderr).toBe(false)
      expect(run.signal, run.stderr).toBeNull()
      expect(run.exitCode, run.stderr).toBe(0)
      const report = requireReport(run)
      expect(report.characters).toBe(STREAMING_CHARACTERS)
      expect(report.fragments).toBe(workload.fragments)
      samples.push(report)
    }
    const median = samples.toSorted((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(STREAMING_SAMPLES / 2)]!
    const retainedMb = samples.map(sample => sample.retainedMb).toSorted((a, b) => a - b)[Math.floor(STREAMING_SAMPLES / 2)]!
    const budgetMs = ciTimeBudget(workload.expectedMs)
    const budgetMb = EXPECTED_STREAMING_RETAINED_MB * PERFORMANCE_BUDGET_HEADROOM
    const benchmarkCase: BenchmarkCase = {
      id: `conversation-fold/streaming-${workload.blockType}-${workload.pattern}-${String(workload.fragments)}`,
      measures: `Client append, final Chat publication, and complete text read for ${String(STREAMING_CHARACTERS / 1024)} KiB in ${String(workload.fragments)} ${workload.blockType} deltas with ${workload.pattern} content.`,
      affects: 'Local processing of a long active model response; excludes model pacing, network transport, and browser rendering.',
    }
    console.log(JSON.stringify({ benchmark: benchmarkCase.id, samples, medianMs: median.elapsedMs, retainedMb, budgetMs, budgetMb }))
    recordTimings(benchmarkCase, {
      medianMs: { ms: median.elapsedMs, cpuMs: median.cpuUserMs + median.cpuSystemMs },
    }, { medianMs: budgetMs })
    recordPeakMemory(benchmarkCase, { peakRssMb: Math.max(...samples.map(sample => sample.maxRssMb)) })
    expect(median.elapsedMs).toBeLessThanOrEqual(budgetMs)
    expect(retainedMb).toBeLessThanOrEqual(budgetMb)
  })
})
