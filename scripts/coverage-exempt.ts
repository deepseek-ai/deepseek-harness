/**
 * Heavy suites the coverage aggregate runs uninstrumented in a parallel gate.
 * Membership rule: a suite qualifies only when every coverage-measured
 * file it executes in-process (`coverage.include` spans package src trees;
 * Typert src is threshold-excluded in vitest.config.ts) is already
 * fully covered by other suites, so removing it from the instrumented run
 * changes no threshold outcome. The aggregate still runs every listed suite
 * plain beside the instrumented gate, so correctness signal is unchanged —
 * only the v8 instrumentation tax on compiler- and subprocess-heavy fixtures
 * is dropped.
 */

/** One coverage-exempt suite: a Vitest CLI filter and its exclude glob. */
export interface CoverageExemptSuite {
  /** Positional file filter selecting the suite in the uninstrumented gate. */
  readonly filter: string
  /** Exclude glob removing the suite from the instrumented gate. */
  readonly exclude: string
}

/**
 * Set to `1` by the instrumented coverage gate; vitest.config.ts then drops
 * the exempt suites from every project. CLI `--exclude` cannot express this:
 * it does not reach per-project include resolution.
 */
export const COVERAGE_EXEMPT_ENV = 'DSH_COVERAGE_EXEMPT_HEAVY'

/** Coverage-exempt heavy suites; keep filter and exclude selecting the same files. */
export const coverageExemptHeavySuites: readonly CoverageExemptSuite[] = [
  // Typert src is threshold-excluded; compiler analysis runs uninstrumented.
  // The generator's tools-catalog registry and
  // tool-cordis imports are fully covered by those packages' own tests.
  {
    filter: 'packages/typert/',
    exclude: 'packages/typert/*/tests/**',
  },
  // The webworker-runtime package is outside the coverage requirement by
  // decision: vitest.config.ts threshold-excludes its src, so every suite
  // runs uninstrumented. This tree includes the full-corpus import gate, a
  // single 900s-budget case that spawns a child sweep over every built
  // bundle; inside an instrumented partition it exceeds the Windows
  // partition budget under load.
  {
    filter: 'packages/experimental/webworker-runtime/tests/',
    exclude: 'packages/experimental/webworker-runtime/tests/**',
  },
  // Real child-process fixtures over scripts/ sources, which coverage never measures.
  { filter: 'scripts/install-lefthook.spec.ts', exclude: 'scripts/install-lefthook.spec.ts' },
  { filter: 'scripts/oxlint-contract.spec.ts', exclude: 'scripts/oxlint-contract.spec.ts' },
  { filter: 'scripts/change-scope.spec.ts', exclude: 'scripts/change-scope.spec.ts' },
  { filter: 'scripts/translation-pairing-merge.spec.ts', exclude: 'scripts/translation-pairing-merge.spec.ts' },
  // Built-artifact proof. Packer/runtime src is threshold-excluded, and the
  // suite self-skips on unbuilt checkouts; the serial-windows complete
  // reference still starts this uninstrumented gate after its build gate, so
  // the assertions execute against complete real artifacts there.
  {
    filter: 'packages/experimental/webworker-packer/tests/image-loadable.spec.ts',
    exclude: 'packages/experimental/webworker-packer/tests/image-loadable.spec.ts',
  },
]
