/**
 * Run local and CI quality gates with bounded in-process scheduling.
 *
 * Package scripts own public aggregate names; this runner owns their validated
 * dependency graphs, scheduler environment, and process diagnostics.
 * @see ../.agents/notes/implemented/process/2026-07-06-parallel-pre-push-gates.md
 */
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CLIENT_BUILD_PROFILE_SELECTOR } from './client-build-environment.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './coverage-exempt.ts'
import {
  COVERAGE_PARTITIONS_ENV,
  COVERAGE_TEST_TIMEOUT_ENV,
  coverageTestTimeoutArgs,
  parseCoveragePartitionCount,
} from './coverage-partitions.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** A named aggregate exposed by the gate runner. */
export type Mode =
  | 'ci-primary'
  | 'ci-linux-primary'
  | 'ci-static'
  | 'ci-lint-contracts-ready'
  | 'ci-coverage'
  | 'ci-bench'
  | 'ci-snapshot'
  | 'ci-artifacts'
  | 'ci-consumers'
  | 'ci-windows-blocking'
  | 'ci-windows-complete'
  | 'ci-windows-observational'
  | 'node-compat'
  | 'check-all'
  | 'hygiene'
  | 'doc-sync'
  | 'doc-quick'

type GateResultStatus = 'passed' | 'failed' | 'skipped'
type GateState = 'pending' | 'running' | GateResultStatus

/** A command and its dependency metadata inside one aggregate. */
export interface Gate {
  id: string
  label: string
  displayCommand: string
  command: string
  args: string[]
  needs?: string[]
  /** Gate ids that must settle, regardless of outcome, before this gate starts. */
  after?: string[]
  env?: Record<string, string | undefined>
  /** Include this leaf in the build-free documentation aggregate. */
  quick?: boolean
  /** Keep a failure visible without failing the aggregate. */
  allowFailure?: boolean
  /** Write child output as it arrives instead of buffering it until completion. */
  streamOutput?: boolean
}

/** The observed outcome of one gate process. */
export interface GateResult {
  gate: Gate
  status: GateResultStatus
  durationMs: number
  output: GateOutputChunk[]
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  error?: string
  /** True when the shared abort signal terminated this gate before its outcome
   * was observed; such a result must not be reported as passed, even if the
   * child trapped the signal and exited zero. */
  aborted?: boolean
}

interface GateOutputChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

interface RunningGate {
  gate: Gate
  promise: Promise<GateResult>
}

interface ConcurrencyDefault {
  workers: number
  source: string
}

type GateExecutor = (gate: Gate, signal?: AbortSignal) => Promise<GateResult>
type ResultObserver = (result: GateResult) => void

const root = resolve(import.meta.dirname, '..')
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}

async function main(args: string[]): Promise<number> {
  const mode = parseMode(args[0])
  const gates = gatesForMode(mode)
  const concurrencyDefault = defaultConcurrency(mode, gates.length)
  const concurrencyOverride = process.env.DSH_GATE_CONCURRENCY
  const maxConcurrency = concurrencyFromEnv('DSH_GATE_CONCURRENCY', concurrencyDefault.workers)
  const concurrencySource = concurrencyOverride === undefined || concurrencyOverride === ''
    ? concurrencyDefault.source
    : '$DSH_GATE_CONCURRENCY'
  const failFast = flagEnabled('DSH_GATE_FAIL_FAST')
  const startedAt = performance.now()
  console.log(`run-gates: ${mode} running ${gates.length} gate(s) with ${maxConcurrency} worker(s) from ${concurrencySource}${failFast ? ', fail-fast after first blocking failure' : ''}.`)

  const results = await runGates(gates, maxConcurrency, runGate, printResult, cliGateOptions(failFast))
  printSummary(results, performance.now() - startedAt)
  return results.some(result => result.gate.allowFailure !== true && (result.status === 'failed' || result.status === 'skipped'))
    ? 1
    : 0
}

/**
 * The options the CLI entrypoint hands to the scheduler. Host signal
 * forwarding always follows fail-fast: children are detached only then, so
 * without it the forwarding would have no tree to drain.
 * @param failFast - whether `DSH_GATE_FAIL_FAST` is enabled.
 * @returns the scheduler options for the entrypoint.
 */
export function cliGateOptions(failFast: boolean): RunGatesOptions {
  return { failFast, forwardProcessSignals: failFast }
}

function parseMode(raw: string | undefined): Mode {
  switch (raw) {
    case 'ci-primary':
    case 'ci-linux-primary':
    case 'ci-static':
    case 'ci-lint-contracts-ready':
    case 'ci-coverage':
    case 'ci-bench':
    case 'ci-snapshot':
    case 'ci-artifacts':
    case 'ci-consumers':
    case 'ci-windows-blocking':
    case 'ci-windows-complete':
    case 'ci-windows-observational':
    case 'node-compat':
    case 'check-all':
    case 'hygiene':
    case 'doc-sync':
    case 'doc-quick':
      return raw
    default:
      throw new Error(
        `run-gates: expected mode ci-primary | ci-linux-primary | ci-static | ci-lint-contracts-ready | ci-coverage | ci-bench | ci-snapshot | ci-artifacts | ci-consumers | ci-windows-blocking | ci-windows-complete | ci-windows-observational | node-compat | check-all | hygiene | doc-sync | doc-quick, got ${JSON.stringify(raw)}.`,
      )
  }
}

/**
 * Resolve the default worker count for one aggregate.
 * @param selectedMode - aggregate whose resource posture applies.
 * @param total - number of gates in the aggregate.
 * @param available - host CPU availability for ordinary modes.
 * @returns the default worker count and its diagnostic source.
 */
export function defaultConcurrency(
  selectedMode: Mode,
  total: number,
  available = availableParallelism(),
): ConcurrencyDefault {
  if (selectedMode === 'ci-consumers') return { workers: total, source: 'ci-consumers gate count' }
  // Local modes cap workers: several doc gates each build a full ts.Program,
  // so an uncapped default on a large host trades wall clock for memory blowups.
  const localCap = selectedMode === 'check-all'
    || selectedMode === 'hygiene'
    || selectedMode === 'doc-sync'
    || selectedMode === 'doc-quick'
  const modeLimit = localCap ? Math.min(4, available) : available
  return {
    workers: Math.min(total, modeLimit),
    source: localCap
      ? `${available} available CPU(s), ${selectedMode} cap 4`
      : `${available} available CPU(s)`,
  }
}

function concurrencyFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`run-gates: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

function pnpmScript(id: string, script: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? script,
    displayCommand: `pnpm run ${script}`,
    ...pnpmInvocation(['run', script]),
    ...options,
  }
}

/** Build official client artifacts inside a CI aggregate without changing sibling gate environments. */
function ciBuildGate(id = 'build', options: Partial<Gate> = {}): Gate {
  return pnpmScript(id, 'build', {
    ...options,
    env: { ...options.env, [CLIENT_BUILD_PROFILE_SELECTOR]: 'official' },
  })
}

function pnpmExec(id: string, args: string[], options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? `pnpm exec ${args.join(' ')}`,
    displayCommand: `pnpm exec ${args.join(' ')}`,
    ...pnpmInvocation(['exec', ...args]),
    ...options,
  }
}

/**
 * Construct the complete gate list for a named aggregate.
 * @param selected - aggregate mode to construct.
 * @returns the aggregate's gate graph.
 */
export function gatesForMode(selected: Mode): Gate[] {
  switch (selected) {
    case 'ci-primary':
      return ciPrimaryGates()
    case 'ci-linux-primary':
      return [...ciPrimaryGates(), webSnapshotGate(['built-package-invariants'])]
    case 'ci-static':
      return ciStaticGates({ ownsBuild: false })
    case 'ci-lint-contracts-ready':
      return [
        lintGate(),
        pnpmScript('duplication', 'duplication'),
      ]
    case 'ci-coverage':
      return coverageGates()
    case 'ci-bench':
      return [pnpmScript('bench', 'test:bench', { label: 'performance benchmarks' })]
    case 'ci-snapshot':
      return [ciBuildGate(), snapshotGate()]
    case 'ci-artifacts':
      return ciArtifactGates()
    case 'ci-consumers':
      return ciConsumerGates()
    case 'ci-windows-blocking':
      return ciWindowsBlockingGates()
    case 'ci-windows-complete':
      return ciWindowsCompleteGates()
    case 'ci-windows-observational':
      return ciWindowsObservationalGates()
    case 'node-compat':
      return nodeCompatGates()
    case 'check-all':
      return [
        pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
        pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
        pnpmScript('client-domain-graph', 'verify-client-domain-graph', { label: 'client domain graph' }),
        pnpmScript('test', 'test'),
        pnpmScript('issue-management', 'test:issue-management', { label: 'Issue management policy' }),
        pnpmScript('duplication', 'duplication'),
        snapshotGate(),
        expectedOutputGate(),
        pnpmScript('build', 'build'),
        pnpmScript('build:web', 'build:web'),
        ...hygieneLeafGates({ artifactNeeds: ['build'] }),
        ...docSyncLeafGates({
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
          docTypecheckScript: 'doc-typecheck:contracts-ready',
        }),
        pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
      ]
    case 'hygiene':
      return [
        ...hygieneLeafGates(),
        pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
        pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
        pnpmScript('vendored-links', 'verify-vendored-links', { label: 'vendored links' }),
      ]
    case 'doc-sync':
      return docSyncLeafGates()
    case 'doc-quick':
      return docQuickLeafGates()
  }
}

function ciSharedStaticGates(): Gate[] {
  return [
    pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
    pnpmScript('application-entrypoints', 'verify-application-entrypoints', { label: 'application entrypoints' }),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('package-dependencies', 'verify-package-dependencies', { label: 'package dependencies' }),
    pnpmScript('dsh-package-licenses', 'verify-dsh-package-licenses', { label: 'DSH package licenses' }),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
    pnpmScript('optional-dependency-imports', 'verify-optional-dependency-imports', {
      label: 'optional dependency imports',
    }),
    pnpmScript('client-packages', 'verify-client-packages', { label: 'client packages' }),
    pnpmScript('client-ui-i18n', 'verify-client-ui-i18n', { label: 'client UI i18n' }),
    pnpmScript('no-bare-dispatcher', 'verify-no-bare-dispatcher', { label: 'proxy-aware dispatchers' }),
    pnpmScript('issue-management', 'test:issue-management', { label: 'Issue management policy' }),
  ]
}

function ciPrimaryGates(): Gate[] {
  return [
    ...ciSharedStaticGates(),
    typertContractsGate(),
    pnpmScript('typecheck', 'typecheck:contracts-ready', { needs: ['typert-contracts'] }),
    lintGate({ needs: ['typert-contracts'] }),
    pnpmScript('duplication', 'duplication'),
    ...coverageGates(),
    ...nodeCompatSmokeGates(),
    snapshotGate(),
    ...docSyncLeafGates({
      docTypecheckNeeds: ['typert-contracts'],
      docTypecheckScript: 'doc-typecheck:contracts-ready',
    }),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    // The prepared typecheck and build both drive Client tsc, while build also
    // repeats the Host contract pass. Wait for all three consumers so build
    // neither races tsbuildinfo nor replaces declarations while they are read.
    ciBuildGate('build', { needs: ['typecheck', 'lint', 'doc-typecheck'] }),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function nodeCompatGates(): Gate[] {
  const typecheck = flagEnabled('DSH_NODE_COMPAT_SKIP_TYPECHECK')
    ? []
    : [pnpmScript('typecheck', 'typecheck')]
  if (runningNodeMajor() !== 22) {
    return [...typecheck, ...nodeCompatSmokeGates()]
  }
  return [
    ...typecheck,
    pnpmScript('build', 'build', {
      ...typecheck.length === 0 ? {} : { needs: ['typecheck'] },
    }),
    pnpmScript('build:web', 'build:web', {
      label: 'Web frontend build',
      needs: ['build'],
    }),
    ...nodeCompatSmokeGates({ cliSmoke: true }),
  ]
}

function nodeCompatSmokeGates(options: { cliSmoke?: boolean } = {}): Gate[] {
  const gates: Gate[] = [
    pnpmExec('source-worker-smoke', [
      'vitest',
      'run',
      'packages/workflow/workflow-worker-thread/tests/source-worker.compat.spec.ts',
    ], { label: 'source worker smoke' }),
    pnpmExec('jsonl-zstd-smoke', [
      'vitest',
      'run',
      'packages/session/session-persistence-jsonl/tests/zstd.compat.spec.ts',
    ], { label: 'JSONL Zstandard smoke' }),
    pnpmExec('dsh-source-launch-smoke', [
      'vitest',
      'run',
      'apps/cli/tests/source-launch.compat.spec.ts',
    ], { label: 'dsh source-launch smoke' }),
    pnpmExec('vitest-jsdom-smoke', [
      'vitest',
      'run',
      'scripts/vitest-environment.compat.spec.ts',
    ], { label: 'Vitest jsdom smoke' }),
  ]
  if (options.cliSmoke) {
    gates.push(
      pnpmExec('cli-lazy-search-startup-smoke', [
        'vitest',
        'run',
        'apps/cli/tests/lazy-search-startup.compat.spec.ts',
      ], {
        label: 'CLI lazy-search startup smoke',
        env: { DSH_REQUIRE_BUILT_CLI_SMOKE: '1' },
        needs: ['build:web'],
      }),
    )
  }
  return gates
}

/** Active Node major used to select version-specific compatibility checks. */
function runningNodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!Number.isSafeInteger(major)) {
    throw new Error(`run-gates: cannot parse Node version ${JSON.stringify(process.versions.node)}.`)
  }
  return major
}

function ciStaticGates(options: { ownsBuild: boolean }): Gate[] {
  return [
    ...ciSharedStaticGates(),
    ...options.ownsBuild ? [ciBuildGate()] : [],
    ...docSyncLeafGates({
      includeDocTypecheck: options.ownsBuild,
      ...options.ownsBuild
        ? {
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
          docTypecheckScript: 'doc-typecheck:contracts-ready',
        }
        : {},
      docsBuildScript: 'docs:build:mpa',
    }),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
  ]
}

function ciArtifactGates(): Gate[] {
  return [
    ciBuildGate(),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function ciConsumerGates(): Gate[] {
  const builtTree = ['build']
  const validatedBuild = ['built-package-invariants']
  // The HMR web test starts `dev:web`, which rewrites the shared `lib/` and
  // `apps/web/dist/` trees. Let every build-artifact reader settle before that
  // writer starts; `after` preserves the web diagnostic even if a reader fails.
  const buildArtifactReaders = [
    'publint',
    'lint-and-duplication',
    'snapshot',
    'expected-output',
    'doc-typecheck',
    'node-next-types',
    'built-bin-smoke',
  ]
  return [
    ciBuildGate(),
    pnpmScript('node-compat', 'check:node-compat', {
      label: 'Node compatibility',
      env: { [CLIENT_BUILD_PROFILE_SELECTOR]: 'official' },
    }),
    pnpmScript('publint', 'publint', { needs: builtTree }),
    builtPackageInvariantsGate(builtTree),
    pnpmScript('lint-and-duplication', 'check:ci:lint:contracts-ready', {
      label: 'lint and duplication',
      needs: validatedBuild,
    }),
    snapshotGate(validatedBuild),
    expectedOutputGate(validatedBuild),
    webSnapshotGate(validatedBuild, buildArtifactReaders),
    pnpmScript('doc-typecheck', 'doc-typecheck:contracts-ready', {
      needs: validatedBuild,
      env: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
    }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: validatedBuild,
    }),
    builtBinSmokeGate(validatedBuild),
  ]
}

function webSnapshotGate(needs: string[], after?: string[]): Gate {
  const order = after === undefined ? { needs } : { needs, after }
  const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
  if (workerRaw !== undefined && workerRaw !== '') {
    const workers = Number.parseInt(workerRaw, 10)
    if (!Number.isSafeInteger(workers) || workers < 2 || String(workers) !== workerRaw) {
      throw new Error(`run-gates: DSH_WEB_SNAPSHOT_WORKERS must be an integer greater than 1, got ${JSON.stringify(workerRaw)}.`)
    }
    return pnpmScript('web-snapshot', 'test:web:ci', {
      label: 'web browser snapshot',
      displayCommand: `DSH_SNAPSHOT=replay DSH_WEB_SNAPSHOT_WORKERS=${workers} pnpm run test:web:ci`,
      env: { DSH_SNAPSHOT: 'replay' },
      ...order,
      streamOutput: true,
    })
  }
  return pnpmScript('web-snapshot', 'test:web:built', {
    label: 'web browser snapshot',
    displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
    env: { DSH_SNAPSHOT: 'replay' },
    ...order,
  })
}

function ciWindowsBlockingGates(): Gate[] {
  return [
    ciBuildGate('windows-build', { label: 'build' }),
    pnpmScript('windows-site', 'docs:build', { label: 'production site' }),
  ]
}

function ciWindowsCompleteGates(): Gate[] {
  const coverage = coverageGates().map(gate => ({
    ...gate,
    needs: [...new Set(['build', ...(gate.needs ?? [])])],
  }))
  const coverageAfter = coverage.map(gate => gate.id)
  const observational = ciWindowsObservationalGates()
    // The required production site replaces the observational MPA build; both
    // VitePress modes write the same output directory and cannot overlap.
    .filter(gate => gate.id !== 'build' && gate.id !== 'docs-site-build')
    .map(gate => ({
      ...gate,
      allowFailure: true,
      after: [...new Set([
        ...coverageAfter,
        ...(gate.after ?? []).map(id => id === 'docs-site-build' ? 'windows-site' : id),
      ])],
    }))
  return [
    ciBuildGate(),
    pnpmScript('windows-site', 'docs:build', { label: 'production site' }),
    ...coverage,
    ...observational,
  ]
}

function ciWindowsObservationalGates(): Gate[] {
  const predecessors = [
    ...ciStaticGates({ ownsBuild: true }),
    // Linux owns required lint and snapshots; Windows omits those duplicates.
    pnpmScript('duplication', 'duplication'),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
  ]
  return [
    ...predecessors,
    {
      ...builtBinSmokeGate(),
      // This smoke starts real application children with bounded startup
      // deadlines. Let other Windows processes settle before measuring startup.
      after: predecessors.map(gate => gate.id),
    },
  ]
}

function typertContractsGate(): Gate {
  return pnpmScript('typert-contracts', 'build:lib:host', { label: 'Typert contracts' })
}

function lintGate(options: { needs?: string[] } = {}): Gate {
  const raw = process.env.DSH_OXLINT_THREADS
  const script = 'lint:contracts-ready'
  return pnpmScript('lint', script, {
    ...raw === undefined || raw === ''
      ? {}
      : { displayCommand: `DSH_OXLINT_THREADS=${raw} pnpm run ${script}` },
    ...options.needs === undefined ? {} : { needs: options.needs },
  })
}

// The heavy suites run uninstrumented beside the thresholded gate: their
// compiler- and subprocess-bound fixtures pay a multiple of their runtime
// under v8 instrumentation while contributing nothing the thresholds need
// (membership rules in scripts/coverage-exempt.ts).
//
// DSH_COVERAGE_MAX_WORKERS is the ordinary lane's worker budget, so the two
// parallel gates split it instead of each claiming it whole. When
// DSH_COVERAGE_PARTITIONS is set, its single-worker processes replace the
// instrumented share while this budget still sizes the exempt gate. The exempt
// gate's wall clock is dominated by its longest single file, so it takes the
// small share. A budget of 1 gives each gate 1 worker; lanes that need a strict
// total of one (the serial reference jobs) also set DSH_GATE_CONCURRENCY=1,
// which keeps the gates from overlapping at all.
// DSH_COVERAGE_TEST_TIMEOUT_MS raises Vitest's per-test, expect.poll, and hook
// defaults together for instrumented lanes whose scheduling overhead exceeds
// those defaults. Explicit fixture timeouts remain authoritative.
function coverageWorkerArgs(): { instrumented: string[]; exempt: string[] } {
  const [flag] = positiveIntArg('DSH_COVERAGE_MAX_WORKERS', '--maxWorkers')
  if (flag === undefined) return { instrumented: [], exempt: [] }
  const total = Number.parseInt(flag.split('=')[1] ?? '', 10)
  const exempt = Math.max(1, Math.floor(total / 3))
  const instrumented = Math.max(1, total - exempt)
  return {
    instrumented: [`--maxWorkers=${String(instrumented)}`],
    exempt: [`--maxWorkers=${String(exempt)}`],
  }
}

function coverageGates(): Gate[] {
  const workers = coverageWorkerArgs()
  const timeouts = coverageTestTimeoutArgs(process.env[COVERAGE_TEST_TIMEOUT_ENV])
  const partitions = parseCoveragePartitionCount(process.env[COVERAGE_PARTITIONS_ENV])
  const instrumented = partitions === undefined
    ? pnpmExec('coverage', [
      'vitest',
      'run',
      '--coverage',
      ...workers.instrumented,
      ...timeouts,
    ], {
      label: 'test:coverage',
      env: { [COVERAGE_EXEMPT_ENV]: '1' },
    })
    : pnpmScript('coverage', 'test:coverage:partitioned', {
      label: 'test:coverage',
      displayCommand: `${COVERAGE_PARTITIONS_ENV}=${partitions} pnpm run test:coverage:partitioned`,
      env: { [COVERAGE_EXEMPT_ENV]: '1' },
      streamOutput: true,
    })
  return [
    instrumented,
    pnpmExec('coverage-exempt-heavy', [
      'vitest',
      'run',
      ...coverageExemptHeavySuites.map(suite => suite.filter),
      ...workers.exempt,
      ...timeouts,
    ], {
      label: 'test:coverage-exempt-heavy',
    }),
  ]
}

// Recorded-session adapters boot process scenarios in `lib` mode. Callers wait
// either on `build` or on a validation gate that transitively owns that build.
function snapshotGate(needs: string[] = ['build']): Gate {
  return pnpmScript('snapshot', 'test:snapshot', {
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs,
  })
}

// Owner-local process expectations consume built package exports without entering
// the recorded-session corpus or the credentialed provider lane.
function expectedOutputGate(needs: string[] = ['build']): Gate {
  return pnpmScript('expected-output', 'test:expected', {
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs,
  })
}

function builtPackageInvariantsGate(needs?: string[]): Gate {
  return pnpmScript('built-package-invariants', 'verify-built-package-invariants', {
    label: 'built package invariants',
    ...needs === undefined ? {} : { needs },
  })
}

function positiveIntArg(envName: string, flag: string): string[] {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return []
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`run-gates: ${envName} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return [`${flag}=${raw}`]
}

function flagEnabled(envName: string): boolean {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return false
  if (raw !== '1') throw new Error(`run-gates: ${envName} must be 1 when set, got ${JSON.stringify(raw)}.`)
  return true
}

function hygieneLeafGates(options: { artifactNeeds?: string[] } = {}): Gate[] {
  const artifactOptions = options.artifactNeeds === undefined ? {} : { needs: options.artifactNeeds }
  return [
    pnpmScript('rescope-vendor', 'rescope-vendor:check', { label: 'vendor rescope' }),
    pnpmScript('publint', 'publint', artifactOptions),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('package-dependencies', 'verify-package-dependencies', { label: 'package dependencies' }),
    pnpmScript('application-entrypoints', 'verify-application-entrypoints', { label: 'application entrypoints' }),
    pnpmScript('dsh-package-licenses', 'verify-dsh-package-licenses', { label: 'DSH package licenses' }),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    builtPackageInvariantsGate(options.artifactNeeds),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
    pnpmScript('optional-dependency-imports', 'verify-optional-dependency-imports', {
      label: 'optional dependency imports',
    }),
    pnpmScript('client-packages', 'verify-client-packages', { label: 'client packages' }),
    pnpmScript('client-ui-i18n', 'verify-client-ui-i18n', { label: 'client UI i18n' }),
    pnpmScript('no-bare-dispatcher', 'verify-no-bare-dispatcher', { label: 'proxy-aware dispatchers' }),
  ]
}

function docSyncLeafGates(options: {
  includeDocTypecheck?: boolean
  docTypecheckNeeds?: string[]
  docTypecheckEnv?: Record<string, string | undefined>
  docTypecheckScript?: 'doc-typecheck' | 'doc-typecheck:contracts-ready'
  docsBuildScript?: 'docs:build' | 'docs:build:mpa'
} = {}): Gate[] {
  const docTypecheckOptions: Partial<Gate> = {}
  if (options.docTypecheckNeeds !== undefined) docTypecheckOptions.needs = options.docTypecheckNeeds
  if (options.docTypecheckEnv !== undefined) docTypecheckOptions.env = options.docTypecheckEnv
  return [
    // Stable FIFO starts the longest leaves first; only docs-site-build writes website/.generated.
    ...options.includeDocTypecheck === false
      ? []
      : [pnpmScript('doc-typecheck', options.docTypecheckScript ?? 'doc-typecheck', docTypecheckOptions)],
    pnpmScript('docs-site-build', options.docsBuildScript ?? 'docs:build', { label: 'documentation build' }),
    pnpmScript('doc-graphs', 'verify-doc-graphs', { label: 'doc graphs' }),
    pnpmScript('markdown-links', 'verify-md-links', { label: 'markdown links', quick: true }),
    pnpmScript('type-equivalence', 'verify-type-equiv', { label: 'type equivalence', quick: true }),
    pnpmScript('cordis-catalog', 'verify-cordis-catalog', { label: 'cordis catalog' }),
    pnpmScript('cordis-inspect-catalog', 'verify-cordis-inspect-catalog', { label: 'Cordis inspect catalog' }),
    pnpmScript('mermaid', 'verify-mermaid'),
    pnpmScript('scoped-events', 'verify-scoped-events', { label: 'scoped events' }),
    pnpmScript('translation-pairing', 'verify-translation-pairing', { label: 'translation pairing', quick: true }),
    pnpmScript('markdown-wrap', 'verify-md-wrap', { label: 'markdown wrap', quick: true }),
    pnpmScript('client-catalog', 'verify-client-catalog', { label: 'client catalog' }),
    pnpmScript('export-jsdoc', 'verify-export-jsdoc', { label: 'export jsdoc' }),
    pnpmScript('tool-catalog', 'verify-tool-catalog', { label: 'tool catalog' }),
    pnpmScript('config-catalog', 'verify-config-catalog', { label: 'config catalog' }),
    pnpmScript('persistence-catalog', 'verify-persistence-catalog', { label: 'persistence catalog' }),
    pnpmScript('session-format-catalog', 'verify-session-format-catalog', { label: 'Session format catalog' }),
    pnpmScript('public-repository-links', 'verify-public-repository-links', { label: 'public repository links', quick: true }),
    pnpmScript('doc-refs', 'verify-doc-refs', { label: 'doc refs', quick: true }),
    pnpmScript('subsystem-pages', 'verify-subsystem-pages', { label: 'subsystem pages' }),
    pnpmScript('package-paths', 'verify-package-paths', { label: 'package paths' }),
    pnpmScript('tsconfig-paths', 'verify-tsconfig-paths', { label: 'tsconfig paths' }),
    pnpmScript('config-source-ownership', 'verify-config-source-ownership', { label: 'config source ownership' }),
    pnpmScript('package-readme-model-experience', 'verify-package-readme-model-experience', { label: 'package README model experience', quick: true }),
    pnpmScript('agent-note-classification', 'verify-agent-note-classification', { label: 'agent note classification', quick: true }),
    pnpmScript('agent-note-format', 'verify-agent-note-format', { label: 'agent note format', quick: true }),
    pnpmScript('archived-agent-notes', 'verify-archived-agent-notes', { label: 'archived agent notes', quick: true }),
    pnpmScript('skill-invocation-metadata', 'verify-skill-invocation-metadata', { label: 'skill invocation metadata', quick: true }),
    pnpmScript('translation-prompt', 'verify-translation-prompt', { label: 'translation prompt', quick: true }),
    pnpmScript('doc-budgets', 'verify-doc-budgets', { label: 'doc budgets', quick: true }),
    pnpmExec('doc-standard-tests', ['vitest', 'run', 'scripts/doc-standard.spec.ts'], {
      label: 'documentation standard tests',
      quick: true,
    }),
    pnpmExec('docs-site-projection', ['vitest', 'run', 'scripts/project-doc-site.spec.ts', 'scripts/verify-doc-site-fragments.spec.ts'], {
      label: 'documentation site checks',
    }),
    pnpmScript('package-readme-limitations', 'verify-package-readme-limitations', { label: 'package README limitations', quick: true }),
  ]
}

/**
 * The quick comprehensive documentation-standard aggregate for `test:docs`.
 * It covers the prose, pairing, README, budget, and Agent Note gates
 * without builds, generator regeneration, or the VitePress site build.
 */
function docQuickLeafGates(): Gate[] {
  return docSyncLeafGates({ includeDocTypecheck: false }).filter(gate => gate.quick === true)
}

function builtBinSmokeGate(needs: string[] = ['build']): Gate {
  return pnpmExec('built-bin-smoke', [
    'vitest',
    'run',
    '--config',
    'vitest.e2e.config.ts',
    'apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts',
    'apps/cli/tests/built-bin.e2e.ts',
    'packages/host/directory-picker-native/tests/built-worker.e2e.ts',
    'packages/sdk/server/tests/built-scope-carrier.e2e.ts',
    'packages/subprocess/subprocess-local/tests/spawn-runner-built.e2e.ts',
    'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
    'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
    'packages/api/remotes/tests/built-lib.e2e.ts',
    'packages/experimental/agent-team/tests/built-lib.e2e.ts',
    // Built execution consumers: the only automated proof that package-name
    // imports reach their lib/ entrypoints under plain Node. The e2e lane runs
    // unbuilt, so these files self-skip there.
    'packages/workflow/workflow-worker-thread/tests/built-worker.e2e.ts',
    'packages/code-runtime/code-runtime-worker-thread/tests/built-lib.e2e.ts',
    'packages/session/session-persistence-jsonl/tests/built-migration-worker.e2e.ts',
    'packages/lsp/lsp-stdio/tests/built-lib.e2e.ts',
  ], {
    label: 'built-bin smoke',
    needs,
    env: { DSH_EXAMPLE_MODE: 'lib' },
  })
}

/**
 * Reject a gate list whose graph cannot be executed unambiguously.
 * @param gates - complete aggregate to validate.
 */
function validateGateGraph(gates: readonly Gate[]): void {
  if (gates.length === 0) throw new Error('run-gates: gate graph has no gates.')

  const ids = new Set<string>()
  for (const gate of gates) {
    if (ids.has(gate.id)) throw new Error(`run-gates: duplicate gate id ${JSON.stringify(gate.id)}.`)
    ids.add(gate.id)
  }
  for (const gate of gates) {
    for (const dependency of gate.needs ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`run-gates: gate ${JSON.stringify(gate.id)} depends on unknown gate ${JSON.stringify(dependency)}.`)
      }
    }
    for (const predecessor of gate.after ?? []) {
      if (!ids.has(predecessor)) {
        throw new Error(`run-gates: gate ${JSON.stringify(gate.id)} waits for unknown gate ${JSON.stringify(predecessor)}.`)
      }
    }
  }

  const cycle = findDependencyCycle(gates)
  if (cycle !== undefined) throw new Error(`run-gates: dependency cycle: ${cycle.join(' -> ')}.`)
}

function findDependencyCycle(gates: readonly Gate[]): string[] | undefined {
  const byId = new Map(gates.map(gate => [gate.id, gate]))
  const complete = new Set<string>()
  const active = new Map<string, number>()
  const path: string[] = []

  const visit = (id: string): string[] | undefined => {
    if (complete.has(id)) return undefined
    const cycleStart = active.get(id)
    if (cycleStart !== undefined) return [...path.slice(cycleStart), id]
    const gate = byId.get(id)
    if (gate === undefined) return undefined

    active.set(id, path.length)
    path.push(id)
    for (const predecessor of [...(gate.needs ?? []), ...(gate.after ?? [])]) {
      const cycle = visit(predecessor)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    active.delete(id)
    complete.add(id)
    return undefined
  }

  for (const gate of gates) {
    const cycle = visit(gate.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Scheduling options for one aggregate.
 */
export interface RunGatesOptions {
  /** Stop the aggregate at the first blocking gate failure. */
  failFast?: boolean
  /** Forward host SIGINT/SIGTERM to the abort path so detached gate trees are
   * terminated when the run itself is interrupted or the runner cancels it.
   * Tree termination additionally requires failFast, because only then is the
   * abort signal passed to the executor and children detached. */
  forwardProcessSignals?: boolean
}

/**
 * Validate and run one aggregate before the injected executor can start a child.
 * @param gates - complete aggregate to execute.
 * @param maxActive - maximum concurrent child count.
 * @param execute - child-process executor; receives the abort signal only when
 * fail-fast is enabled, so ordinary runs keep their children in the host
 * process group.
 * @param observe - result observer invoked when each gate settles.
 * @param options - scheduling options; fail-fast aborts the aggregate at the
 * first blocking gate failure by killing running children and skipping every
 * not-yet-run gate.
 * @returns results in aggregate order.
 */
export async function runGates(
  gates: Gate[],
  maxActive: number,
  execute: GateExecutor,
  observe: ResultObserver = () => {},
  options: RunGatesOptions = {},
): Promise<GateResult[]> {
  validateGateGraph(gates)
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error(`run-gates: max concurrency must be a positive integer, got ${JSON.stringify(maxActive)}.`)
  }
  if (options.forwardProcessSignals === true && options.failFast !== true) {
    throw new Error('run-gates: forwardProcessSignals requires failFast, otherwise no child is detached or killed.')
  }
  const states = new Map<string, GateState>(gates.map(gate => [gate.id, 'pending']))
  const results = new Map<string, GateResult>()
  const running: RunningGate[] = []
  const abort = new AbortController()
  let abortCause: string | undefined
  // Host interruption (terminal Ctrl+C, runner cancellation) drains through
  // the same abort path as a gate failure, so detached trees are killed and
  // never orphaned. Handlers are removed before returning.
  const hostSignals = options.forwardProcessSignals === true ? ['SIGINT', 'SIGTERM'] as const : []
  const hostHandlers = hostSignals.map((name) => {
    const handler = () => {
      abortCause = abortCause ?? 'host interruption'
      abort.abort()
    }
    process.on(name, handler)
    return { name, handler }
  })
  const failFastSignal = options.failFast === true ? abort.signal : undefined

  try {
    for (;;) {
      let madeProgress = false
      if (abortCause === undefined) {
        while (running.length < maxActive) {
          const ready = gates.find(gate => states.get(gate.id) === 'pending' && predecessorsReady(gate, states))
          if (ready === undefined) break
          states.set(ready.id, 'running')
          running.push({ gate: ready, promise: execute(ready, failFastSignal) })
          console.log(`run-gates: start ${ready.label}`)
          madeProgress = true
        }
      }

      if (running.length === 0) {
        if (abortCause !== undefined) {
          for (const gate of gates) {
            if (states.get(gate.id) !== 'pending') continue
            const skipped = skippedByFailFast(gate, abortCause)
            states.set(gate.id, 'skipped')
            results.set(gate.id, skipped)
            observe(skipped)
          }
          break
        }
        const pending = gates.filter(gate => states.get(gate.id) === 'pending')
        if (pending.length === 0) break
        const gate = pending.find(item => (item.needs ?? []).some(id => gateFailed(states.get(id))))
        if (gate === undefined) throw new Error('run-gates: validated graph stalled without a failed dependency.')
        const failedDeps = (gate.needs ?? []).filter(id => gateFailed(states.get(id)))
        const result: GateResult = {
          gate,
          status: 'skipped',
          durationMs: 0,
          output: [],
          exitCode: null,
          signalCode: null,
          error: `dependency failed or skipped: ${failedDeps.join(', ')}`,
        }
        states.set(gate.id, 'skipped')
        results.set(gate.id, result)
        observe(result)
        continue
      }

      if (!madeProgress) {
        const settled = await Promise.race(running.map(async item => ({ item, result: await item.promise })))
        running.splice(running.indexOf(settled.item), 1)
        const observed = abortCause === undefined || settled.result.aborted !== true
          ? settled.result
          : skippedByFailFast(settled.item.gate, abortCause)
        states.set(settled.item.gate.id, observed.status)
        results.set(settled.item.gate.id, observed)
        observe(observed)
        if (abortCause === undefined && options.failFast === true
          && observed.status === 'failed' && settled.item.gate.allowFailure !== true) {
          abortCause = `${observed.gate.label} failed`
          abort.abort()
          console.error(`run-gates: fail-fast aborting: ${abortCause}.`)
          for (const gate of gates) {
            if (states.get(gate.id) !== 'pending') continue
            const skipped = skippedByFailFast(gate, abortCause)
            states.set(gate.id, 'skipped')
            results.set(gate.id, skipped)
            observe(skipped)
          }
        }
      }
    }
  } finally {
    for (const { name, handler } of hostHandlers) process.removeListener(name, handler)
  }

  return gates.map((gate) => {
    const result = results.get(gate.id)
    if (result === undefined) throw new Error(`run-gates: missing result for ${gate.id}.`)
    return result
  })
}

/**
 * The result of a gate that produced no evidence because fail-fast aborted.
 * A gate whose process settled before the abort took effect keeps its real
 * result instead: it did produce evidence, and the summary must say so. Any
 * result settling after the abort — including a genuine independent failure
 * in the race window, and a child that trapped the signal and exited zero —
 * is recorded skipped with its partial output discarded, because on Windows a
 * killed process is indistinguishable from a failed one by exit code alone.
 * @param gate - the gate that produced no evidence.
 * @param cause - the full clause naming what aborted the aggregate, e.g.
 * `typecheck failed` or `host interruption`.
 * @returns the skipped record with the fail-fast error.
 */
function skippedByFailFast(gate: Gate, cause: string): GateResult {
  return {
    gate,
    status: 'skipped',
    durationMs: 0,
    output: [],
    exitCode: null,
    signalCode: null,
    error: `aborted by fail-fast: ${cause}`,
  }
}

function predecessorsReady(gate: Gate, states: Map<string, GateState>): boolean {
  return (gate.needs ?? []).every(id => states.get(id) === 'passed')
    && (gate.after ?? []).every(id => gateSettled(states.get(id)))
}

function gateSettled(state: GateState | undefined): boolean {
  return state === 'passed' || state === 'failed' || state === 'skipped'
}

function gateFailed(state: GateState | undefined): boolean {
  return state === 'failed' || state === 'skipped'
}

/**
 * Execute one gate through the real shell-free child-process boundary.
 * @param gate - command and scheduler environment to execute.
 * @param signal - abort signal that terminates the whole gate process tree when
 * the aggregate fails fast; an already-aborted signal terminates it
 * immediately. A provided signal spawns the child detached so POSIX can signal
 * its process group and Windows can reach its tree through taskkill.
 * @returns the complete process outcome.
 */
export async function runGate(gate: Gate, signal?: AbortSignal): Promise<GateResult> {
  const started = performance.now()
  const output: GateOutputChunk[] = []
  let spawnError: string | undefined
  let aborted = false

  const outcome = await new Promise<{
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }>((resolveExit) => {
    const child = spawn(gate.command, gate.args, {
      cwd: root,
      env: { ...process.env, ...gate.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: signal !== undefined && process.platform !== 'win32',
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (gate.streamOutput === true) process.stdout.write(chunk)
      else output.push({ stream: 'stdout', text: chunk })
    })
    child.stderr.on('data', (chunk: string) => {
      if (gate.streamOutput === true) process.stderr.write(chunk)
      else output.push({ stream: 'stderr', text: chunk })
    })
    // Deliver one signal to the entire gate tree: the negative pid targets the
    // POSIX process group the detached child leads; Windows has no groups, so
    // taskkill walks the tree rooted at the child and force-terminates (a
    // taskkill without `/F` does not terminate console processes, which is
    // what gate commands are). Outcomes are deliberately unchecked because
    // delivery races tree exit, and a missing taskkill binary is as tolerable
    // as ESRCH. Mirrors the subprocess package's teardown contract
    // (packages/subprocess/subprocess-local/src/spawn.ts).
    const treeKill = (signalToSend: 'SIGTERM' | 'SIGKILL') => {
      const pid = child.pid
      if (pid === undefined) return
      if (process.platform === 'win32') {
        for (const args of taskkillArgs(pid, descendants)) {
          spawnSync('taskkill', args, { stdio: 'ignore' })
        }
        return
      }
      try {
        process.kill(-pid, signalToSend)
      } catch {
        // The group is gone; the direct child may still be alive alone.
        child.kill(signalToSend)
      }
      // The captured list stays valid after the group kill reparents the
      // detached descendants of a nested run-gates (the `check:node-compat`
      // and `check:ci:lint:contracts-ready` gates in ci-consumers): pids do
      // not change on reparenting, so the escalation reaches leaves that
      // ignored SIGTERM without re-enumerating.
      for (const descendantPid of descendants) {
        try {
          process.kill(descendantPid, signalToSend)
        } catch {
          // The descendant exited between the enumeration and the signal.
        }
      }
    }
    let escalation: ReturnType<typeof setTimeout> | undefined
    let terminatedAt = 0
    // Captured once at terminate and re-signalled on escalation: the group
    // kill reaps the direct child, after which its detached descendants are
    // reparented and unreachable by parent id, so the escalation cannot
    // re-enumerate them.
    let descendants: number[] = []
    let pipeDrain: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      aborted = true
      const pid = child.pid
      // Merge while the child is still alive: re-enumerating alone would drop
      // a descendant that an exited intermediate reparented out of the parent
      // chain, and replacing the list entirely would lose the sampler's
      // last-known entries when the child already exited. Union preserves both.
      // The sampler runs on every platform (including Windows, where an
      // exited intermediate's table record vanishes and a fresh enumeration
      // cannot cross the gap), so the cache is the source of truth once the
      // child is gone.
      if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
        descendants = [...new Set([...descendants, ...descendantPids(pid)])]
      }
      treeKill('SIGTERM')
      if (escalation === undefined) {
        terminatedAt = Date.now()
        // Force-kill at the deadline regardless of the direct child's exit
        // state: when the wrapper dies but a grandchild ignores SIGTERM and
        // still holds the stdio pipes, `close` has not fired and the tree must
        // still be killed. treeKill swallows an already-absent group.
        escalation = setTimeout(() => { treeKill('SIGKILL') }, 5000)
      }
      if (pipeDrain === undefined) {
        // `close` can stay pending past the direct child's exit when a
        // descendant holds the stdio write ends (escaped process group, or
        // uninterruptible I/O that keeps the SIGKILL pending). Bound the wait
        // past the 5-second SIGKILL grace and force the streams closed so
        // fail-fast settles instead of hanging to the job timeout. Only the
        // abort path arms it: on an ordinary run a gate that outlives its
        // descendants must keep waiting rather than report passed over a live
        // leak. Armed in terminate (not only at `exit`) so the window where
        // the child already exited before the abort is covered too.
        pipeDrain = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          child.stdin.destroy()
        }, 10000)
      }
    }
    if (signal !== undefined) {
      if (signal.aborted) terminate()
      else signal.addEventListener('abort', terminate, { once: true })
    }
    // Refresh the descendant cache while the child runs, so an abort that
    // arrives after the child already exited can still reach a detached
    // descendant the child left behind: once the child is gone, its
    // descendants are reparented (POSIX) or their intermediate's table record
    // is gone (Windows), so a fresh enumeration cannot cross the gap. The
    // cache is primed at spawn and refreshed every 5 seconds, so a descendant
    // is captured once it appears in any enumeration whose parent chain is
    // still fully present in the table; the residual window is a descendant
    // that never appears in such a snapshot — created after one enumeration
    // and orphaned before the next. Enumeration is asynchronous (a slow
    // WMI/CIM call is bounded by its own 10-second timeout), so a gate's
    // output draining and exit handling are never blocked while the sampler
    // reads the process table. Fail-fast runs only; ordinary runs never
    // abort.
    let descendantSampler: ReturnType<typeof setInterval> | undefined
    if (signal !== undefined) {
      let enumerationInFlight: { cancel: () => void } | undefined
      const refreshDescendants = () => {
        const pid = child.pid
        if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
        if (enumerationInFlight !== undefined) return
        const handle = descendantPidsAsync(pid, process.platform)
        enumerationInFlight = handle
        void handle.promise.then((fresh) => {
          if (enumerationInFlight === handle) enumerationInFlight = undefined
          // Merge regardless of the child's exit state: the enumeration
          // started while the child was alive, so its snapshot is the last
          // reliable view of the tree. The child may exit (its intermediate
          // gone, its table record vanished) before the promise settles while
          // a grandchild still holds the stdio write ends and keeps `close`
          // pending — exactly when terminate needs this list.
          // Merge instead of replacing, like terminate: an intermediate that
          // exited since the last tick reparented its detached descendants
          // out of the parent chain, so a fresh enumeration alone would drop
          // them. Filter the cache to the still-executing so a long gate
          // does not accumulate stale pids; while sampler ticks still run the
          // live filter also keeps the escalation from signalling a reused
          // pid, but once ticks stop (child exited) the cache can go stale,
          // and a pid reused after that is the accepted sampling window.
          descendants = [...new Set([...descendants.filter(processAlive), ...fresh])]
        })
      }
      const cancelInFlightEnumeration = () => {
        if (enumerationInFlight !== undefined) enumerationInFlight.cancel()
        enumerationInFlight = undefined
      }
      refreshDescendants()
      descendantSampler = setInterval(refreshDescendants, 5000)
      // A gate that settles while an enumeration is still running must not
      // leave the PowerShell subprocess holding stdio handles until its own
      // timeout: stop it as soon as the child's outcome is known.
      child.once('close', cancelInFlightEnumeration)
      child.once('error', cancelInFlightEnumeration)
    }
    child.on('error', (error) => {
      if (escalation !== undefined) clearTimeout(escalation)
      if (pipeDrain !== undefined) clearTimeout(pipeDrain)
      if (descendantSampler !== undefined) clearInterval(descendantSampler)
      if (signal !== undefined) signal.removeEventListener('abort', terminate)
      spawnError = `failed to start command: ${error.message}`
      resolveExit({ exitCode: null, signalCode: null })
    })
    child.on('close', (exitCode, signalCode) => {
      if (pipeDrain !== undefined) clearTimeout(pipeDrain)
      if (descendantSampler !== undefined) clearInterval(descendantSampler)
      if (signal !== undefined) signal.removeEventListener('abort', terminate)
      if (escalation !== undefined && process.platform !== 'win32') {
        // `close` only means the direct child's stdio closed; a grandchild
        // that ignored SIGTERM and redirected its stdio can outlive it. Do
        // not settle until the process group and the captured descendants are
        // confirmed gone — the deadline SIGKILL covers members still alive at
        // the grace end — so runGate returns only once the tree is quiescent.
        const confirmGroupGone = () => {
          if (!groupAlive(child.pid) && descendants.every(descendantPid => !processAlive(descendantPid))) {
            clearTimeout(escalation)
            resolveExit({ exitCode, signalCode })
            return
          }
          if (Date.now() - terminatedAt < 8000) {
            setTimeout(confirmGroupGone, 50)
            return
          }
          // The grace ended with members still alive (e.g. uninterruptible
          // I/O that even SIGKILL cannot cut). Fail loud instead of reporting
          // a quiescent tree: the gate is recorded failed either way.
          console.error(`run-gates: gate tree not quiescent after 8s (${gate.label}).`)
          clearTimeout(escalation)
          resolveExit({ exitCode, signalCode })
        }
        confirmGroupGone()
        return
      }
      if (escalation !== undefined) clearTimeout(escalation)
      resolveExit({ exitCode, signalCode })
    })
    child.stdin.end()
  })
  const { exitCode, signalCode } = outcome

  const status: GateResultStatus = exitCode === 0 && signalCode === null && spawnError === undefined ? 'passed' : 'failed'
  const result: GateResult = {
    gate,
    status,
    durationMs: performance.now() - started,
    output,
    exitCode,
    signalCode,
  }
  result.aborted = aborted
  if (spawnError !== undefined) result.error = spawnError
  return result
}

/**
 * Parse the state, parent, and process-group fields from a `/proc/<pid>/stat`
 * line. The comm field may contain spaces and parentheses, so the state starts
 * after the last closing parenthesis.
 * @param stat - one `/proc/<pid>/stat` line.
 * @returns state, parent pid, and process-group pid; undefined when truncated.
 */
function procStatFields(stat: string): { state: string; ppid: number; pgrp: number } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const state = fields[0]
  const ppid = fields[1]
  const pgrp = fields[2]
  if (state === undefined || ppid === undefined || pgrp === undefined) return undefined
  return { state, ppid: Number(ppid), pgrp: Number(pgrp) }
}

/**
 * Whether one process is still executing. Zombies (state `Z`) do not count:
 * they are dead records awaiting reaping, and kill(pid, 0) would report them
 * as alive. Linux reads /proc/<pid>/stat to distinguish; other platforms fall
 * back to the signal probe.
 * @param pid - the process to probe.
 */
function processAlive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const parsed = procStatFields(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      return parsed !== undefined && parsed.state !== 'Z'
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether any member of the child's POSIX process group is still executing.
 * Zombie entries (state `Z`) do not count: they are dead records awaiting
 * reaping, and the kill(-pid, 0) group probe would report them as alive.
 * Linux enumerates /proc to distinguish after a fast-path group probe; other
 * POSIX platforms fall back to the probe alone.
 * @param pid - the group leader's pid; undefined or non-positive means the
 * spawn failed and nothing is alive.
 */
function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false
  if (process.platform === 'linux') {
    try {
      process.kill(-pid, 0)
    } catch {
      // ESRCH: the group has no entries at all.
      return false
    }
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const parsed = procStatFields(readFileSync(`/proc/${entry}/stat`, 'utf8'))
          if (parsed !== undefined && parsed.pgrp === pid && parsed.state !== 'Z') return true
        } catch {
          // The process exited mid-scan; it is not a live member.
        }
      }
      return false
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The pids of every transitive descendant of `root`, read from the live
 * process table. Linux walks /proc/<pid>/stat parent fields; other platforms
 * parse `ps` (POSIX) or the CIM process table (Windows) output. This is one
 * snapshot, not the full tree-ownership mechanism: terminate and the sampler
 * rely on the 5-second cache to cross an intermediate that exited between
 * ticks (reparented on POSIX, table record gone on Windows), so a single
 * enumeration reaches only the descendants whose parent chain is still fully
 * present in the table.
 * @param root - the pid whose descendants are wanted.
 * @returns descendant pids in breadth-first order; empty on enumeration failure.
 */
function descendantPids(root: number): number[] {
  if (root <= 0) return []
  if (process.platform === 'linux') {
    const rows: Array<[number, number]> = []
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const parsed = procStatFields(readFileSync(`/proc/${entry}/stat`, 'utf8'))
          if (parsed !== undefined) rows.push([Number(entry), parsed.ppid])
        } catch {
          // The process exited mid-scan; skip it.
        }
      }
    } catch {
      return []
    }
    return collectDescendants(root, rows)
  }
  let ps: { error?: Error; stdout: string }
  if (process.platform === 'win32') {
    // taskkill /T covers the tree only while the root is alive; once the
    // direct child exits (a descendant still holding the stdio write ends
    // keeps `close` pending), abort must reach the survivors from a fresh
    // enumeration. Windows keeps the exited parent's pid in its descendants'
    // parent column, so this walk still finds the whole tree. A hung
    // PowerShell (WMI/CIM service trouble) must not stall the abort path
    // indefinitely, so the enumeration is bounded.
    ps = spawnSync('powershell', processTableArgs('win32'), { encoding: 'utf8', timeout: 10000 })
  } else {
    ps = spawnSync('ps', processTableArgs('posix'), { encoding: 'utf8' })
  }
  if (ps.error !== undefined) return []
  return collectDescendants(root, parsePidPpidLines(ps.stdout))
}

/**
 * The process-table enumeration command for one platform. Windows queries the
 * CIM provider through PowerShell (each line `pid ppid`); other platforms use
 * `ps -axo pid=,ppid=`.
 * @param platform - the target platform.
 * @returns the command arguments to enumerate every live process's pid/ppid.
 */
function processTableArgs(platform: 'win32' | 'posix'): string[] {
  if (platform === 'win32') {
    return ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']
  }
  return ['-axo', 'pid=,ppid=']
}

/**
 * Asynchronous descendant enumeration, so a slow WMI/CIM call (bounded by a
 * 10-second timeout) cannot block the event loop: the sampler runs it while
 * the gate's output streams and exit handling must keep flowing. Returns the
 * same descendant list as {@link descendantPids}; used by the fail-fast
 * sampler only, never on the abort path (which needs the synchronous walk to
 * capture the tree before any member exits).
 * @param root - the pid whose descendants are wanted.
 * @param platform - the platform whose table the enumeration reads.
 * @returns a promise of descendant pids in breadth-first order; empty on
 * enumeration failure.
 */
function descendantPidsAsync(root: number, platform: NodeJS.Platform): { promise: Promise<number[]>; cancel: () => void } {
  if (root <= 0 || platform === 'linux') {
    // The /proc walk is synchronous inside the async wrapper so the sampler
    // keeps the same contract on every platform; /proc reads are fast and
    // need no subprocess, and a completed enumeration needs no cancellation.
    return { promise: Promise.resolve(descendantPids(root)), cancel: () => {} }
  }
  const [command, args] = platform === 'win32'
    ? ['powershell', processTableArgs('win32')]
    : ['ps', processTableArgs('posix')]
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: platform === 'win32' ? 10000 : undefined,
  })
  child.stdout.setEncoding('utf8')
  let stdout = ''
  let settled = false
  let settle!: (value: number[]) => void
  const promise = new Promise<number[]>((resolve) => { settle = resolve })
  const finish = (value: number[]) => {
    if (settled) return
    settled = true
    // The enumeration completed (or was cancelled): stop the subprocess so
    // the gate does not wait on its stdio handles.
    child.kill('SIGTERM')
    settle(value)
  }
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.on('error', () => { finish([]) })
  child.on('close', () => { finish(collectDescendants(root, parsePidPpidLines(stdout))) })
  return {
    promise,
    cancel: () => { finish([]) },
  }
}

/** Parse `pid ppid` rows from a process-table dump. Both the POSIX `ps -axo
 * pid=,ppid=` output and the Windows PowerShell `Get-CimInstance Win32_Process`
 * projection emit one `pid ppid` pair per line.
 * @param output - the raw dump text.
 * @returns the parsed pid/ppid rows in line order; blank and malformed lines
 * are dropped.
 */
export function parsePidPpidLines(output: string): Array<[number, number]> {
  const rows: Array<[number, number]> = []
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (match !== null) rows.push([Number(match[1]), Number(match[2])])
  }
  return rows
}

/**
 * The taskkill invocations that terminate one Windows gate tree. The direct
 * child leads, because a live `taskkill /T` walks its whole subtree in one
 * call; each captured descendant follows individually, because when the root
 * already exited (a descendant holding the stdio write ends keeps `close`
 * pending) `taskkill /T` rooted at the dead pid finds nothing — Windows never
 * reparents, so the ppid chain captured at terminate still reaches the whole
 * tree, and `/T` lets a surviving intermediate carry its own subtree. A pid
 * that exited between capture and termination is as tolerable as ESRCH on
 * POSIX: taskkill reports a nonzero status that is deliberately unchecked.
 * @param rootPid - the direct child's pid.
 * @param descendants - the captured descendant pids.
 * @returns one `taskkill` argument list per pid, in termination order.
 */
export function taskkillArgs(rootPid: number, descendants: number[]): string[][] {
  return [rootPid, ...descendants].map(pid => ['/PID', String(pid), '/T', '/F'])
}

/** Breadth-first walk of the pid/ppid rows starting at `root`. */
function collectDescendants(root: number, rows: Array<[number, number]>): number[] {
  const byParent = new Map<number, number[]>()
  for (const [pid, ppid] of rows) {
    const children = byParent.get(ppid) ?? []
    children.push(pid)
    byParent.set(ppid, children)
  }
  const result: number[] = []
  const queue = byParent.get(root) ?? []
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]
    if (pid === undefined) continue
    result.push(pid)
    queue.push(...(byParent.get(pid) ?? []))
  }
  return result
}

/**
 * Format every independently observed failure fact for the aggregate summary.
 * @param result - unsuccessful gate result.
 * @returns error, exit, and signal facts without allowing one to hide another.
 */
export function formatGateResultReason(result: GateResult): string {
  const facts: string[] = []
  if (result.error !== undefined) facts.push(result.error)
  if (result.exitCode !== null) facts.push(`exit ${result.exitCode}`)
  if (result.signalCode !== null) facts.push(`signal ${result.signalCode}`)
  return facts.length === 0 ? 'no exit code or signal' : facts.join(', ')
}

function printResult(result: GateResult): void {
  const verbose = process.env.DSH_GATE_VERBOSE === '1'
  const seconds = (result.durationMs / 1000).toFixed(2)
  if (result.status === 'passed' && !verbose) {
    console.log(`run-gates: PASS ${result.gate.label} (${seconds}s)`)
    return
  }

  const heading = `${result.status.toUpperCase()} ${result.gate.label} (${seconds}s)`
  const writeHeading = result.status === 'passed' ? console.log : console.error
  writeHeading(`\n== ${heading} ==`)
  if (result.status !== 'passed') {
    console.error(`command: ${result.gate.displayCommand}`)
    console.error(`outcome: ${formatGateResultReason(result)}`)
  }
  if (result.gate.streamOutput !== true) printOutput(result.output)
}

function printSummary(results: GateResult[], durationMs: number): void {
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = (durationMs / 1000).toFixed(2)
  console.log(`\nrun-gates: ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s.`)

  const unsuccessful = results.filter(result => result.status === 'failed' || result.status === 'skipped')
  if (unsuccessful.length === 0) return

  console.error('run-gates: unsuccessful gates:')
  for (const result of unsuccessful) {
    const duration = (result.durationMs / 1000).toFixed(2)
    const reason = formatGateResultReason(result)
    const disposition = result.gate.allowFailure === true ? 'NON-BLOCKING ' : ''
    console.error(`  - ${disposition}${result.status.toUpperCase()} ${result.gate.label} (${duration}s, ${reason})`)
    console.error(`    ${result.gate.displayCommand}`)
  }
}

function printOutput(output: GateOutputChunk[]): void {
  for (const chunk of output) {
    if (chunk.stream === 'stdout') process.stdout.write(chunk.text)
    else process.stderr.write(chunk.text)
  }
}
