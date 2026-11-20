/**
 * Build benchmark artifacts with TypeScript diagnostics owned by required full builds, then run the suite.
 * `--phase first|last` instead runs one phase on restored shared-build output after building only the
 * benchmark workers.
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildLibraryArtifacts, runPnpmCommand } from './compile-referenced-projects.ts'
import { parseBenchPhase } from './bench-phase.ts'
import type { BenchPhase } from './bench-phase.ts'
import { runBenchPhase } from './run-bench-suite.ts'

/**
 * Build native support, libraries, benchmark workers, and Web assets that benchmark files consume.
 * @param root - Repository root containing all build configurations.
 * @throws If any build fails.
 */
export function buildCiBenchArtifacts(root: string): void {
  runPnpmCommand(root, ['run', 'build:native-system'])
  buildLibraryArtifacts(root, false, 'benchmark-emit')
  buildBenchWorkers(root)
  runPnpmCommand(root, ['run', 'build:web'])
}

/**
 * Build the `benchmarks/.dsh-build/` workers, the only output the shared CI build does not emit.
 * @param root - Repository root containing the benchmark bundle configuration.
 * @throws If the bundle fails.
 */
export function buildBenchWorkers(root: string): void {
  runPnpmCommand(root, ['exec', 'tsdown', '--config-loader', 'native', '--config', 'benchmarks/tsdown.config.ts'])
}

/**
 * Run one suite phase on a checkout whose libraries, native addon, and Web
 * assets were restored from the shared CI build. The phase runs alone on its
 * runner, so it clears and renders its own report results.
 * @param root - Repository root containing the restored build output.
 * @param phase - the phase to run.
 * @throws If the worker build or the phase fails.
 */
export function runCiBenchPhase(root: string, phase: BenchPhase): void {
  buildBenchWorkers(root)
  runBenchPhase(root, phase, 'all')
}

/**
 * Build benchmark artifacts, then run the existing benchmark suite.
 * @param root - Repository root containing all build configurations.
 * @throws If any build or the benchmark suite fails.
 */
export function runCiBench(root: string): void {
  buildCiBenchArtifacts(root)
  runPnpmCommand(root, ['run', 'test:bench:built'])
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { phase: { type: 'string' } }, allowPositionals: false })
  const root = resolve(import.meta.dirname, '..')
  if (values.phase === undefined) runCiBench(root)
  else runCiBenchPhase(root, parseBenchPhase(values.phase))
}
