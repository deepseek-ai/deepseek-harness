/** Session-list Host queue responsiveness; no browser input, transport, or paint is measured. */

import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { recordTimings } from '../support/scaling-report.ts'
import type { ProjectionListReport } from './projection-list.worker.ts'

const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'projection-list.worker.js')
const ATTEMPTS = 3
const WORKER_TIMEOUT_MS = 120_000
/** Coarse reference-machine throughput allowances, before CI scaling and variance headroom. */
const LIST_REFERENCE_MS = { modest: 50, tail: 500, cheap: 150 } as const
/** Queue-delay reference allowance above the measured 16 ms work slices and one-row overshoot. */
const CALLBACK_REFERENCE_MS = 30
/** Reference retained-heap allowance; memory receives variance headroom but no CPU scaling. */
const RETAINED_HEAP_REFERENCE_BYTES = 240 * 1024 * 1024
/** Queue delay is time other callbacks wait behind list work on the Host thread, which is CPU work. */
const CALLBACK_IO_SHARE = 0
/** Sessions per workload. */
const SESSIONS = { modest: 50, tail: 300, cheap: 3_000 } as const

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number
}

async function run(workload: ProjectionListReport['workload']): Promise<ProjectionListReport> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projection-list-bench-'))
  try {
    const outcome = await runBuiltBenchmarkWorker<ProjectionListReport>({
      worker: WORKER, args: [root, workload], timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
    })
    if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
      throw new Error(`projection-list ${workload} failed: exit=${String(outcome.exitCode)}, signal=${String(outcome.signal)}, `
        + `timedOut=${String(outcome.timedOut)}\n${outcome.stderr.trim().split('\n').slice(-20).join('\n')}`)
    }
    return outcome.report
  } finally {
    // The shared launcher resolves only after child close, including timeout kills.
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['modest', 'tail', 'cheap'] as const)('serves the %s projection list without monopolizing the Host queue', async (workload) => {
  const reports: ProjectionListReport[] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) reports.push(await run(workload))
  const firstMs = reports.map(report => report.samples[0]!.listAndJsonMs)
  const repeatMs = reports.map(report => median(report.samples.slice(1).map(sample => sample.listAndJsonMs)))
  const heapBytes = reports.map(report => Math.max(...[...report.samples, report.responsiveness].map(sample => sample.memory.heapUsedBytes)))
  const medians = {
    firstListAndJsonMs: median(firstMs),
    repeatListAndJsonMs: median(repeatMs),
    firstListMs: median(reports.map(report => report.samples[0]!.listMs)),
    repeatListMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.listMs)))),
    firstListAndJsonCpuMs: median(reports.map(report => report.samples[0]!.listAndJsonCpuMs)),
    repeatListAndJsonCpuMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.listAndJsonCpuMs)))),
    retainedHeapBytes: median(heapBytes),
    worstCallbackDelayMs: median(reports.map(report => report.responsiveness.maxCallbackDelayMs)),
    repeatYieldCalls: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.yieldCalls)))),
    firstCallbackDelayMs: median(reports.map(report => report.samples[0]!.callbackDelayMs)),
    repeatCallbackDelayMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.callbackDelayMs)))),
    firstEventLoopMaxMs: median(reports.map(report => report.samples[0]!.eventLoopMaxMs)),
    repeatEventLoopMaxMs: median(reports.map(report => Math.max(...report.samples.slice(1).map(sample => sample.eventLoopMaxMs)))),
  }
  const budgets = {
    listAndJsonMs: ciTimeBudget(LIST_REFERENCE_MS[workload]),
    callbackDelayMs: ciTimeBudget(CALLBACK_REFERENCE_MS),
    retainedHeapBytes: Math.ceil(RETAINED_HEAP_REFERENCE_BYTES * PERFORMANCE_BUDGET_HEADROOM),
  }
  console.log(JSON.stringify({ benchmark: `session-corpus/projection-list-${workload}`,
    reports, medians, budgets, environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model } }))

  recordTimings({
    id: `session-corpus/projection-list-${workload}`,
    measures: `Host Session-list projection and JSON for ${SESSIONS[workload].toLocaleString('en-US')} Sessions, and the longest Host queue delay meanwhile.`,
    affects: 'Showing the Session sidebar; a long queue delay stalls other Web GUI requests.',
  }, {
    firstListAndJsonMs: { ms: medians.firstListAndJsonMs, cpuMs: medians.firstListAndJsonCpuMs },
    repeatListAndJsonMs: { ms: medians.repeatListAndJsonMs, cpuMs: medians.repeatListAndJsonCpuMs },
    worstCallbackDelayMs: { ms: medians.worstCallbackDelayMs, ioShare: CALLBACK_IO_SHARE },
  }, { firstListAndJsonMs: budgets.listAndJsonMs, repeatListAndJsonMs: budgets.listAndJsonMs, worstCallbackDelayMs: budgets.callbackDelayMs })
  for (const report of reports) {
    expect(report.workload).toBe(workload)
    expect(report.fixture.sessions).toBe(SESSIONS[workload])
    expect(report.fixture.baseRows).toBe({ modest: 100, tail: 1_000, cheap: 0 }[workload])
    expect(report.samples).toHaveLength(4)
    for (const sample of [...report.samples, report.responsiveness]) {
      expect(sample.items).toBe(report.fixture.sessions)
      expect(sample.wireViews).toBe(report.fixture.sessions)
    }
  }
  expect(medians.worstCallbackDelayMs).toBeLessThanOrEqual(budgets.callbackDelayMs)
  expect(medians.firstListAndJsonMs).toBeLessThanOrEqual(budgets.listAndJsonMs)
  expect(medians.repeatListAndJsonMs).toBeLessThanOrEqual(budgets.listAndJsonMs)
  expect(medians.retainedHeapBytes).toBeLessThanOrEqual(budgets.retainedHeapBytes)
}, ATTEMPTS * WORKER_TIMEOUT_MS + 30_000)
