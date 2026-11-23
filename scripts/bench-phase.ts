/**
 * Benchmark suite phases, kept free of build-tool imports so gate selection can
 * validate a phase without loading the TypeScript compiler.
 */

/** One phase of the suite: `first` runs the corpus cases, `last` runs the serial files of `run-bench-suite.ts`. */
export type BenchPhase = 'first' | 'last'

/** Which part of the report a phase invocation owns; `all` clears and renders on its own. */
export type BenchReportPhase = BenchPhase | 'all'

/**
 * Parse a benchmark phase name.
 * @param raw - the requested phase.
 * @returns the phase.
 * @throws If the value is not `first` or `last`.
 */
export function parseBenchPhase(raw: string | undefined): BenchPhase {
  if (raw === 'first' || raw === 'last') return raw
  throw new Error(`benchmark phase must be "first" or "last", got ${JSON.stringify(raw)}.`)
}
