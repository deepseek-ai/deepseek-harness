/** Required time and allocation budgets for sent-user-text evaluation with the credential matcher. */

import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings, type BenchmarkCase } from '../support/scaling-report.ts'
import type {
  UserTextAllocationReport, UserTextTimeReport, UserTextWorkloadAllocation, UserTextWorkloadTiming,
} from './user-text.worker.client.ts'

/** Fresh registries and documents after warm-up; independent minima of adjacent pairs limit scheduler delay. */
const ATTEMPTS = 5
/**
 * Both independently selected minima vary with V8 tiering and workload shape.
 * Observed unchanged-worker CI ratios reached 1.65× the reference expectation;
 * use one 1.75× margin for all unmatched workloads, keeping absolute, scaling,
 * and allocation budgets unchanged.
 */
const UNMATCHED_RATIO_HEADROOM = 1.75
/** A stuck worker is reaped before the outer benchmark deadline. */
const WORKER_TIMEOUT_MS = 180_000
/** Larger than every workload's allocation, so the allocation interval runs without a scavenge. */
const ALLOCATION_SEMI_SPACE_MB = 256
const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'user-text', 'user-text.worker.js')

/**
 * Documents without credentials: reference-machine milliseconds with the matcher, and the
 * ratio to the shipped rules without it. Ratios need separate variance headroom. The matcher
 * adds one native literal scan, about 2 ns per character, plus format checks where a literal
 * occurs (`://`, `sk-` in identifiers); 5,000 messages also pay the scheduler's cost for one
 * more matcher. Running sixteen format patterns from every query offset measures 1.6–4.9×.
 */
const UNMATCHED_EXPECTED = {
  'typical-messages': { ms: 28, ratio: 1.25 },
  'prose-256k': { ms: 1.25, ratio: 1.8 },
  'code-256k': { ms: 1.7, ratio: 2.3 },
  'base64-256k': { ms: 1.4, ratio: 2.05 },
  'markdown-256k': { ms: 1.6, ratio: 2.15 },
  'log-256k': { ms: 1.75, ratio: 2.05 },
  'json-256k': { ms: 2.05, ratio: 2.75 },
  'shell-256k': { ms: 3.8, ratio: 1.3 },
} as const
/** Reference-machine milliseconds with the matcher for documents whose credentials it masks. */
const MATCHED_EXPECTED_MS = {
  'messages-with-model-key': 28,
  'messages-with-github-token': 28,
  'messages-with-cloud-key-id': 28,
  'messages-with-json-web-token': 29,
  'messages-with-address-password': 31,
  'messages-with-private-key-block': 45,
  'env-keys-2000': 2.1,
} as const
/**
 * 128 KiB shaped against one format's prefix, length, or separator rules. Format patterns
 * that backtrack, or a per-query memo whose digit search reaches the end of the text from
 * every query, measure 60–720 ms and up to 4× per doubling.
 */
const ADVERSARIAL_EXPECTED_MS = 3.25
/** Doubling the input doubles a linear scan. */
const MAX_DOUBLING_SCALING = 2 * PERFORMANCE_BUDGET_HEADROOM

/** Measurement floor: heap statistics objects created while reading the young generation. */
const ALLOCATION_FLOOR_BYTES = 16 * 1024
/**
 * One credential node: the node and data objects, the visible-prefix slice, and the
 * concatenation with a slice of a shared mark string; measured at about 180 bytes.
 */
const ALLOCATION_PER_CREDENTIAL_BYTES = 256
/** A multi-line mask adds one slice of a shared mark string and one concatenation per line; measured at about 60 bytes. */
const ALLOCATION_PER_MASKED_LINE_BREAK_BYTES = 64
/** A slice shorter than a sliced string copies its characters: at most two bytes per masked character. */
const ALLOCATION_PER_MASKED_CHARACTER_BYTES = 2

const ADVERSARIAL = [
  'digitless-sk', 'jwt-header-runs', 'jwt-two-segments', 'unterminated-key-blocks', 'address-without-at',
  'colon-run', 'long-scheme-user', 'short-token-runs', 'tokens-between-digitless-keys', 'closed-one-line-key-blocks',
] as const

function benchmarkCase(id: string, measures: string): BenchmarkCase {
  return { id: `user-text/${id}`, measures, affects: 'Rendering sent user messages, queued messages, and goal input in the Web GUI.' }
}

async function worker<Report>(args: readonly string[], semiSpaceMb?: number): Promise<Report> {
  const run = await runBuiltBenchmarkWorker<Report>({
    worker: WORKER, args, timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true, ...semiSpaceMb === undefined ? {} : { semiSpaceMb },
  })
  if (run.report === undefined) {
    throw new Error(`user-text worker failed: exit=${String(run.exitCode)}, signal=${String(run.signal)}, `
      + `timedOut=${String(run.timedOut)}\n${run.stderr.trim().split('\n').slice(-10).join('\n')}`)
  }
  return run.report
}

describe('sent user text with the credential matcher', () => {
  let timings: ReadonlyMap<string, UserTextWorkloadTiming>
  let allocations: ReadonlyMap<string, UserTextWorkloadAllocation>

  beforeAll(async () => {
    const time = await worker<UserTextTimeReport>(['time', String(ATTEMPTS)])
    const allocation = await worker<UserTextAllocationReport>(['allocation'], ALLOCATION_SEMI_SPACE_MB)
    console.log(JSON.stringify({ benchmark: 'user-text', ...time, allocation: allocation.workloads }))
    timings = new Map(time.workloads.map(workload => [workload.id, workload]))
    allocations = new Map(allocation.workloads.map(workload => [workload.id, workload]))
  }, 2 * WORKER_TIMEOUT_MS)

  const timing = (id: string): UserTextWorkloadTiming => {
    const found = timings.get(id)
    if (found === undefined) throw new Error(`user-text worker reported no ${id} workload`)
    return found
  }
  const record = (benchmark: BenchmarkCase, measured: UserTextWorkloadTiming, budgetMs: number): void => {
    recordTimings({
      ...benchmark,
      measures: `${benchmark.measures} Minimum of ${ATTEMPTS} per-sample means of ${measured.evaluationsPerSample} fresh evaluations after warm-up.`,
    }, { withSecretMs: { ms: measured.withSecretMs, cpuMs: measured.withSecretCpuMs } }, { withSecretMs: budgetMs })
  }

  it.each(Object.entries(UNMATCHED_EXPECTED))('evaluates %s without credentials within its budget and ratio', (id, expected) => {
    const measured = timing(id)
    const budgetMs = ciTimeBudget(expected.ms)
    record(benchmarkCase(id, `Fresh ${id} documents without credentials through every shipped matcher.`), measured, budgetMs)
    expect(measured.group).toBe('unmatched')
    expect(measured.secrets).toBe(0)
    expect(measured.withSecretMs).toBeLessThanOrEqual(budgetMs)
    expect(measured.ratio).toBeLessThanOrEqual(expected.ratio * UNMATCHED_RATIO_HEADROOM)
  })

  it.each(Object.entries(MATCHED_EXPECTED_MS))('masks every credential of %s within its budget', (id, expectedMs) => {
    const measured = timing(id)
    const budgetMs = ciTimeBudget(expectedMs)
    record(benchmarkCase(id, `Fresh ${id} documents, each credential masked, through every shipped matcher.`), measured, budgetMs)
    expect(measured.group).toBe('matched')
    expect(measured.secrets).toBe(id === 'env-keys-2000' ? 2_000 : 5_000)
    expect(measured.withSecretMs).toBeLessThanOrEqual(budgetMs)
  })

  it('masks 2,000 pasted keys in time linear in their number', () => {
    const half = timing('env-keys-1000')
    const full = timing('env-keys-2000')
    expect([half.secrets, full.secrets]).toEqual([1_000, 2_000])
    expect(full.withSecretMs / half.withSecretMs).toBeLessThanOrEqual(MAX_DOUBLING_SCALING)
  })

  it.each(ADVERSARIAL)('scans adversarial %s input linearly without backtracking', (name) => {
    const half = timing(`adversarial-${name}-64k`)
    const full = timing(`adversarial-${name}-128k`)
    const budgetMs = ciTimeBudget(ADVERSARIAL_EXPECTED_MS)
    record(benchmarkCase(`adversarial-${name}`, `One 128 KiB document repeating a ${name} unit.`), full, budgetMs)
    expect(full.withSecretMs).toBeLessThanOrEqual(budgetMs)
    expect(full.withSecretMs / half.withSecretMs).toBeLessThanOrEqual(MAX_DOUBLING_SCALING)
  })

  it.each(workloadIds())('allocates only result nodes and masks for %s', (id) => {
    const allocation = allocations.get(id)
    if (allocation === undefined) throw new Error(`user-text worker reported no ${id} allocation`)
    expect(allocation.secrets).toBe(timing(id).secrets)
    const budgetBytes = ALLOCATION_FLOOR_BYTES + ALLOCATION_PER_CREDENTIAL_BYTES * allocation.secrets
      + ALLOCATION_PER_MASKED_LINE_BREAK_BYTES * allocation.maskedLineBreaks
      + ALLOCATION_PER_MASKED_CHARACTER_BYTES * allocation.maskedCharacters
    expect(allocation.ruleAllocatedBytes).toBeLessThanOrEqual(budgetBytes)
  })
})

/** Every workload id, in the worker's order, so each has an allocation case. */
function workloadIds(): readonly string[] {
  return [
    ...Object.keys(UNMATCHED_EXPECTED), ...Object.keys(MATCHED_EXPECTED_MS), 'env-keys-1000',
    ...ADVERSARIAL.flatMap(name => [`adversarial-${name}-64k`, `adversarial-${name}-128k`]),
  ]
}
