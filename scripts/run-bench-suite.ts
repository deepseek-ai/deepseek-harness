/** Run the benchmark suite in the two phases its measurements tolerate. */
import { resolve } from 'node:path'
import { runPnpmCommand } from './compile-referenced-projects.ts'

/**
 * Cases whose wall-clock endpoints cannot absorb a sibling: they drive a
 * browser page, compare animation frames or paced streams, or spawn fresh
 * children and budget their startup. Corpus cases tolerate a sibling.
 */
export const SERIAL_BENCH_FILES = [
  'benchmarks/long-session-browser/long-session.bench.ts',
  'benchmarks/user-text/user-text.bench.client.ts',
  'benchmarks/conversation-fold/conversation-fold.bench.client.ts',
  'benchmarks/active-stream-reconnect/reconnect.bench.client.ts',
  // Fresh-child reopen case: its endpoints budget 63 ms and 120 ms, and a
  // sibling process pushed them to 76 ms and 131 ms.
  'benchmarks/session-open/session-open.bench.ts',
  // Request-history budgets 297 ms against a 212 ms healthy median; a sibling
  // pushed it to 342 ms.
  'benchmarks/agent-continuation/agent-continuation.bench.ts',
] as const

const CONFIG = ['--config', 'vitest.bench.config.ts'] as const

/**
 * Run one phase of the suite.
 * @param root - Repository root containing the Vitest configuration.
 * @param phase - `first` clears the report and runs the CPU cases two at a time;
 *   `last` runs the browser cases one at a time and renders the report.
 * @throws If the phase fails.
 */
export function runBenchPhase(root: string, phase: 'first' | 'last'): void {
  process.env.DSH_BENCH_REPORT_PHASE = phase
  try {
    if (phase === 'first') {
      runPnpmCommand(root, [
        'exec', 'vitest', 'run', ...CONFIG,
        ...SERIAL_BENCH_FILES.map(file => `--exclude=${file}`),
      ])
      return
    }
    runPnpmCommand(root, [
      'exec', 'vitest', 'run', ...CONFIG,
      '--no-file-parallelism', '--maxWorkers=1',
      ...SERIAL_BENCH_FILES,
    ])
  } finally {
    delete process.env.DSH_BENCH_REPORT_PHASE
  }
}

/**
 * Run both phases, so a first-phase failure still reports every later case.
 * @param root - Repository root containing the Vitest configuration.
 * @returns the process exit code: 1 when either phase failed.
 */
export function runBenchSuite(root: string): number {
  let failed = false
  for (const phase of ['first', 'last'] as const) {
    try {
      runBenchPhase(root, phase)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      failed = true
    }
  }
  return failed ? 1 : 0
}

if (import.meta.main) process.exitCode = runBenchSuite(resolve(import.meta.dirname, '..'))
