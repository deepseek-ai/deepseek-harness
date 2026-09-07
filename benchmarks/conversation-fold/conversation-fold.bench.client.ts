/** Required performance budget for the compiled cold Client conversation fold. */

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
import type { ConversationFoldWorkerReport } from './conversation-fold.worker.client.ts'

/** Replies in the folded window; each carries one reasoning block and one text block. */
const TURNS = 200
/** Text deltas per reply in the large workload; each reply adds one quarter as many reasoning deltas. */
const LARGE_DELTAS = 2_000
/** Text deltas per reply in the small workload used as the scaling reference. */
const SMALL_DELTAS = 100
/** Fresh object graphs measured in one compiled worker; the fastest sample removes scheduler delay. */
const ATTEMPTS = 3
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

const WORKER = join(
  import.meta.dirname,
  '..',
  '.dsh-build',
  'conversation-fold',
  'conversation-fold.worker.js',
)

function requireReport(
  run: BuiltBenchmarkWorkerRun<ConversationFoldWorkerReport>,
): ConversationFoldWorkerReport {
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
    expect(report.chatNodes).toBeGreaterThan(0)
    expect(report.largeFoldMs).toBeLessThanOrEqual(LARGE_FOLD_BUDGET_MS)
    expect(report.scaling).toBeLessThanOrEqual(MAX_DELTA_SCALING)
  })
})
