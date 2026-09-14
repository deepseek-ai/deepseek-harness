/** Coordinate single-worker Vitest coverage partitions and one merged report. */
import { spawn } from 'node:child_process'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { coverageExemptHeavySuites } from './coverage-exempt.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Environment variable selecting the number of instrumented coverage processes. */
export const COVERAGE_PARTITIONS_ENV = 'DSH_COVERAGE_PARTITIONS'

/** Internal marker that suppresses reports and thresholds inside a partition process. */
export const COVERAGE_PARTITION_MODE_ENV = 'DSH_COVERAGE_PARTITION_MODE'

/** Environment variable overriding instrumented test, polling, and hook timeouts. */
export const COVERAGE_TEST_TIMEOUT_ENV = 'DSH_COVERAGE_TEST_TIMEOUT_MS'

/**
 * Reporter that canonicalizes a partition's coverage locations before its blob
 * is serialized (see scripts/coverage-canonical-locations.ts). Root-relative in
 * POSIX spelling because every child runs with the repository root as its
 * working directory on every platform.
 */
const CANONICAL_LOCATIONS_REPORTER = './scripts/coverage-canonical-locations.ts'

/** One child command owned by the coverage coordinator. */
export interface CoverageCommand {
  /** Diagnostic identity. */
  label: string
  /** Executable launched without a platform shell. */
  command: string
  /** Arguments passed to the executable. */
  args: string[]
  /** Environment additions for the child. */
  env: Record<string, string | undefined>
  /** Working directory for the child. */
  cwd: string
  /** Blob the partition must produce; absent for the merge command. */
  blobPath?: string
}

/** Observable child-process completion. */
export interface CoverageCommandResult {
  /** Numeric process status, or `null` when a signal ended the child. */
  exitCode: number | null
  /** Terminating signal, or `null` after an ordinary exit. */
  signalCode: NodeJS.Signals | null
  /** Spawn failure recorded independently from process completion. */
  error?: string
  /** Bounded combined stdout/stderr tail repeated when the command fails. */
  outputTail?: string
}

/** Execute one coordinator command with inherited output. */
export type CoverageCommandRunner = (command: CoverageCommand) => Promise<CoverageCommandResult>

/** Construction inputs for {@link CoveragePartitionCoordinator}. */
export interface CoveragePartitionCoordinatorOptions {
  /** Repository root that owns coverage output. */
  root: string
  /** Number of concurrent single-worker Vitest processes. */
  partitions: number
  /** pnpm JavaScript or executable entrypoint from `npm_execpath`. */
  pnpmEntrypoint: string
  /** Additional arguments shared by every partition. */
  vitestArgs?: string[]
  /** Child executor, injectable for scheduler tests. */
  runCommand?: CoverageCommandRunner
  /** Instrumented inventory; collected from the workspace when absent or empty. */
  files?: readonly string[]
  /** Recorded durations paired with `files`; read from persistence when absent. */
  weights?: ReadonlyMap<string, number>
  /** Project ownership paired with `files`; collected from `vitest list` when absent. */
  projectOf?: ReadonlyMap<string, string>
}

/** Parse an optional coverage partition count. */
export function parseCoveragePartitionCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 2 || String(parsed) !== raw) {
    throw new Error(`${COVERAGE_PARTITIONS_ENV} must be an integer greater than 1, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

/**
 * Resolve the paired Vitest timeout arguments used by coverage partitions.
 * `--hookTimeout` travels with the test budget because setup and teardown pay
 * the same host contention the raised test budget accounts for: fixtures that
 * await child exit or retry Windows handle release spend that cost in
 * `afterEach`, where Vitest's separate 10 s default would otherwise fail a
 * suite whose cases all passed.
 * @param raw - the configured millisecond budget, or undefined to keep Vitest's defaults.
 * @returns the Vitest arguments applying that budget, empty when unset.
 */
export function coverageTestTimeoutArgs(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return [`--testTimeout=${raw}`, `--expect.poll.timeout=${raw}`, `--hookTimeout=${raw}`]
}

/** Remove pnpm's package-script separator before forwarding Vitest arguments. */
export function forwardedCoverageArgs(args: readonly string[]): string[] {
  return [...args.slice(args[0] === '--' ? 1 : 0)]
}

/**
 * Weight assigned to a file with no recorded duration. One millisecond keeps
 * the LPT assignment purely duration-driven once history exists, while a
 * first run (no cache at all) degrades to an even file-count split.
 */
const UNKNOWN_FILE_WEIGHT = 1

/**
 * Coordinator-maintained duration history. CI removes `node_modules/.vite`
 * on every checkout, so Vitest's own cache never survives there; this
 * gitignored file at the repository root carries recorded durations across
 * runs on a persistent checkout (self-hosted runners).
 */
const FILE_TIMES_NAME = '.coverage-times.json'

/**
 * The instrumented inventory: every file plus the Vitest project it belongs
 * to (`thread-safe` or `process-bound`). Preserving the per-project split
 * matters because the projects are mutually exclusive: a file's own project
 * must run it exactly once, so a partition config cannot hand the whole
 * partition list to every project.
 */
export interface InstrumentedInventory {
  files: string[]
  /** Project name per file; the pool prefix of the `vitest list` line. */
  projectOf: Map<string, string>
}

/**
 * Parse `vitest list --filesOnly` output into the instrumented inventory:
 * one `[pool] path` line per file, deduplicated, minus the exempt heavy
 * suites that `vitest list` itself does not exclude.
 */
export function parseListOutput(output: string, root: string): InstrumentedInventory {
  const files = new Set<string>()
  const projectOf = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]\s+(\S+\.spec\.(?:ts|tsx))$/.exec(line)
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      files.add(match[2])
      projectOf.set(match[2], match[1])
    }
  }
  for (const suite of coverageExemptHeavySuites) {
    for (const file of globSync(suite.exclude, { cwd: root })) {
      // globSync returns platform separators on Windows; the parsed inventory
      // and Vitest include patterns both use forward slashes.
      const normalized = file.split('\\').join('/')
      files.delete(normalized)
      projectOf.delete(normalized)
    }
  }
  return { files: [...files].sort(), projectOf }
}

/**
 * Collect the instrumented coverage inventory from a `vitest list --filesOnly`
 * run: no test collection and no worker pool, just the file list. Caller
 * filters (positional args after `--`) narrow the list before the exempt
 * heavy suites are removed here because `vitest list` does not apply the
 * `COVERAGE_EXEMPT_ENV` exclusion.
 */
async function collectInstrumentedFiles(
  root: string,
  pnpmEntrypoint: string,
  filters: readonly string[] = [],
): Promise<InstrumentedInventory> {
  const invocation = pnpmInvocation(['exec', 'vitest', 'list', '--filesOnly', ...filters], { npm_execpath: pnpmEntrypoint })
  const output = await runListCommand(invocation.command, invocation.args, root)
  return parseListOutput(output, root)
}

/** Run `vitest list` and return its stdout, or throw with exit code and stderr. */
function runListCommand(command: string, args: string[], root: string): Promise<string> {
  return new Promise((resolveList, rejectList) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { errorOutput += chunk })
    child.once('error', (error: Error) => { rejectList(error) })
    child.once('close', (code) => {
      if (code === 0) resolveList(output)
      else rejectList(new Error(`vitest list exited with ${String(code ?? 'signal')}${errorOutput === '' ? '' : `: ${errorOutput.trim().slice(0, 300)}`}`))
    })
  })
}

/**
 * Read recorded per-file durations: the coordinator's persisted file first
 * (survives CI checkouts), falling back to the Vitest results cache for local
 * development. Cache entries are `[projectName:relativePath, {duration}]`;
 * a file appearing several times keeps the average duration.
 */
export function readFileDurations(root: string): Map<string, number> {
  const persisted = readPersistedDurations(root)
  if (persisted.size > 0) return persisted
  const totals = new Map<string, { sum: number; count: number }>()
  for (const file of globSync('node_modules/.vite/vitest/*/results.json', { cwd: root })) {
    let cache: { results?: Array<[string, { duration?: number }]> }
    try {
      cache = JSON.parse(readFileSync(join(root, file), 'utf8')) as { results?: Array<[string, { duration?: number }]> }
    } catch {
      continue
    }
    for (const [key, entry] of cache.results ?? []) {
      const separator = key.indexOf(':')
      if (separator < 0) continue
      const path = key.slice(separator + 1)
      const duration = entry.duration
      if (typeof duration !== 'number') continue
      const total = totals.get(path)
      if (total === undefined) totals.set(path, { sum: duration, count: 1 })
      else {
        total.sum += duration
        total.count++
      }
    }
  }
  return new Map([...totals].map(([path, { sum, count }]) => [path, sum / count]))
}

/** Read the coordinator's persisted duration map; empty when absent or corrupt. */
function readPersistedDurations(root: string): Map<string, number> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(join(root, FILE_TIMES_NAME), 'utf8')) as Record<string, unknown>
  } catch {
    return new Map()
  }
  const durations = new Map<string, number>()
  for (const [file, duration] of Object.entries(raw)) {
    if (typeof duration === 'number' && Number.isFinite(duration)) durations.set(file, duration)
  }
  return durations
}

/**
 * Merge new durations into the persisted file and rewrite it. A fresh run's
 * measurements overwrite earlier ones, so the history tracks the latest
 * checkout's behavior; entries whose file no longer exists in the current
 * inventory are dropped, so deleted or renamed specs never linger with stale
 * weights.
 */
export function writeFileDurations(
  root: string,
  durations: ReadonlyMap<string, number>,
  currentFiles?: readonly string[],
): void {
  if (durations.size === 0) return
  const merged = new Map(readPersistedDurations(root))
  for (const [file, duration] of durations) merged.set(file, duration)
  if (currentFiles !== undefined) {
    const present = new Set(currentFiles)
    for (const file of [...merged.keys()]) {
      if (!present.has(file)) merged.delete(file)
    }
  }
  writeFileSync(join(root, FILE_TIMES_NAME), `${JSON.stringify(Object.fromEntries(merged), null, 1)}\n`, 'utf8')
}

/**
 * Extract per-file durations from Vitest JSON reporter outputs (one per
 * partition). Each `testResults` entry names an absolute spec path and carries
 * `startTime`/`endTime`; the difference is the file's recorded duration.
 */
export function collectPartitionDurations(reportFiles: readonly string[], root: string): Map<string, number> {
  const durations = new Map<string, number>()
  for (const file of reportFiles) {
    let report: { testResults?: Array<{ name?: unknown; startTime?: number; endTime?: number }> }
    try {
      report = JSON.parse(readFileSync(file, 'utf8')) as { testResults?: Array<{ name?: unknown; startTime?: number; endTime?: number }> }
    } catch {
      continue
    }
    for (const result of report.testResults ?? []) {
      if (typeof result.name !== 'string' || typeof result.startTime !== 'number' || typeof result.endTime !== 'number') continue
      const relativePath = relative(root, result.name).split(sep).join('/')
      durations.set(relativePath, Math.max(0, result.endTime - result.startTime))
    }
  }
  return durations
}

/**
 * Assign files to partitions by longest-processing-time: heavier files are
 * seeded first into the currently lightest partition, so recorded durations
 * (and the import/environment cost that scales with a partition's file set)
 * spread instead of piling into whichever shard the hash lands them in. A
 * min-heap over the buckets keeps each placement at O(log partitions).
 * @returns one file list per partition, every partition non-empty.
 */
export function assignWeightedPartitions(
  files: readonly string[],
  weights: ReadonlyMap<string, number>,
  partitions: number,
): string[][] {
  if (files.length === 0) return Array.from({ length: partitions }, () => [])
  const weighted = files
    .map(file => ({ file, weight: weights.get(file) ?? UNKNOWN_FILE_WEIGHT }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file))
  const buckets = Array.from({ length: partitions }, () => ({ sum: 0, files: [] as string[] }))
  // Min-heap of bucket indices ordered by (sum, file count); equal sums pick
  // the leaner bucket so a duration-sparse inventory still balances file count.
  const heap = buckets.map((_, index) => index)
  for (const { file, weight } of weighted) {
    const top = heap[0]
    if (top === undefined) throw new Error('coverage partitions: partition heap index is out of bounds.')
    const bucket = buckets[top]
    if (bucket === undefined) throw new Error('coverage partitions: partition bucket is missing.')
    bucket.sum += weight
    bucket.files.push(file)
    siftDown(buckets, heap, 0)
  }
  return buckets.map(bucket => bucket.files)
}

/** Restore the min-heap property after the root bucket grew heavier. */
function siftDown(
  buckets: Array<{ sum: number; files: string[] }>,
  heap: number[],
  index: number,
): void {
  const size = heap.length
  for (;;) {
    const left = 2 * index + 1
    const right = 2 * index + 2
    let smallest = index
    let smallestBucket = bucketAt(buckets, heap, index)
    const leftBucket = left < size ? bucketAt(buckets, heap, left) : undefined
    const rightBucket = right < size ? bucketAt(buckets, heap, right) : undefined
    if (leftBucket !== undefined && smallestBucket !== undefined && bucketLess(leftBucket, smallestBucket)) {
      smallest = left
      smallestBucket = leftBucket
    }
    if (rightBucket !== undefined && smallestBucket !== undefined && bucketLess(rightBucket, smallestBucket)) {
      smallest = right
    }
    if (smallest === index) return
    const moved = heap[index]
    const replacement = heap[smallest]
    if (moved === undefined || replacement === undefined) return
    heap[index] = replacement
    heap[smallest] = moved
    index = smallest
  }
}

/** Read the bucket at a heap position, or undefined when the index is absent. */
function bucketAt(
  buckets: Array<{ sum: number; files: string[] }>,
  heap: number[],
  index: number,
): { sum: number; files: string[] } | undefined {
  const bucketIndex = heap[index]
  return bucketIndex === undefined ? undefined : buckets[bucketIndex]
}

/** Order buckets by total weight, then by file count, then by nothing (stable). */
function bucketLess(
  left: { sum: number; files: string[] } | undefined,
  right: { sum: number; files: string[] } | undefined,
): boolean {
  if (left === undefined || right === undefined) return left !== undefined
  if (left.sum !== right.sum) return left.sum < right.sum
  return left.files.length < right.files.length
}

/** Sum of a partition's file weights; unknown weights count as one. */
function partitionWeight(files: readonly string[], weights: ReadonlyMap<string, number>): number {
  return files.reduce((sum, file) => sum + (weights.get(file) ?? UNKNOWN_FILE_WEIGHT), 0)
}

/**
 * Source of one partition's temporary Vitest config: the workspace config
 * with `test.include` narrowed to the partition's file list, per project.
 * The config sits under `coverage/.partitioned/`, so the workspace config is
 * two directories up, and the partition processes run with cwd at the
 * repository root (Vite resolves the relative include patterns against it).
 * Each project keeps only the files that belong to it: the projects are
 * mutually exclusive, so handing the whole partition list to every project
 * would run plain files twice (once per project).
 */
function partitionConfigSource(
  files: readonly string[],
  projectOf: ReadonlyMap<string, string>,
): string {
  const threadSafe = JSON.stringify(files.filter(file => projectOf.get(file) !== 'process-bound').map(file => file.split('\\').join('/')))
  const processBound = JSON.stringify(files.filter(file => projectOf.get(file) === 'process-bound').map(file => file.split('\\').join('/')))
  return [
    "import base from '../../vitest.config.ts'",
    'export default {',
    '  ...base,',
    '  test: {',
    '    ...base.test,',
    '    projects: (base.test.projects ?? []).map(project => ({',
    '      ...project,',
    '      test: {',
    '        ...project.test,',
    '        include: project.test.name === \'process-bound\' ? ' + processBound + ' : ' + threadSafe + ',',
    '      },',
    '    })),',
    '  },',
    '}',
    '',
  ].join('\n')
}

/** Run instrumented partitions, validate their blobs, and merge once. */
export class CoveragePartitionCoordinator {
  private readonly root: string
  private readonly partitions: number
  private readonly pnpmEntrypoint: string
  private readonly vitestArgs: string[]
  private readonly runCommand: CoverageCommandRunner
  private readonly files: readonly string[]
  private readonly weights: ReadonlyMap<string, number> | undefined
  private projectOf = new Map<string, string>()
  private readonly temporaryRoot: string
  private readonly blobsRoot: string

  /** Create a coordinator from validated process-independent inputs. */
  public constructor(options: CoveragePartitionCoordinatorOptions) {
    if (!Number.isSafeInteger(options.partitions) || options.partitions < 2) {
      throw new Error(`coverage partitions must be an integer greater than 1, got ${String(options.partitions)}.`)
    }
    this.root = options.root
    this.partitions = options.partitions
    this.pnpmEntrypoint = options.pnpmEntrypoint
    this.vitestArgs = options.vitestArgs ?? []
    this.runCommand = options.runCommand ?? runCoverageCommand
    this.files = options.files ?? []
    this.weights = options.weights
    this.projectOf = new Map(options.projectOf ?? [])
    this.temporaryRoot = join(this.root, 'coverage', '.partitioned')
    this.blobsRoot = join(this.temporaryRoot, 'blobs')
  }

  /**
   * Run every partition before one merged threshold check.
   * @returns zero only when every partition and the merge command succeed.
   */
  public async run(): Promise<number> {
    await removeOwnedTree(join(this.root, 'coverage'))
    await mkdir(this.blobsRoot, { recursive: true })

    try {
      const assignments = await this.assignFiles()
      this.assertNonEmptyAssignments(assignments)
      const configPaths = await this.writePartitionConfigs(assignments)
      const commands = assignments.map((_, index) => this.partitionCommand(index + 1, configPaths[index] ?? ''))
      const results = await Promise.all(commands.map(async (command) => {
        console.log(`coverage-partitions: start ${command.label}`)
        const result = await this.runCommand(command)
        if (commandFailed(result)) {
          console.error(`coverage-partitions: FAIL ${command.label} (${commandFailureReason(result)})`)
          if (result.outputTail !== undefined && result.outputTail !== '') {
            console.error(`coverage-partitions: output tail for ${command.label}:\n${result.outputTail}`)
          }
        }
        return result
      }))
      // Persist durations before blob validation: a missing blob aborts the
      // run, but the completed partitions' timings are still worth keeping.
      this.persistDurations(this.partitions)
      await this.assertCompleteBlobSet(commands)

      const mergeCommand = this.mergeCommand()
      console.log(`coverage-partitions: start ${mergeCommand.label}`)
      const mergeResult = await this.runCommand(mergeCommand)
      return results.some(commandFailed) || commandFailed(mergeResult) ? 1 : 0
    } finally {
      await removeOwnedTree(this.temporaryRoot)
    }
  }

  /**
   * Refuse an empty partition: Vitest treats a config with no matching files
   * as "run everything", so an empty bucket would silently execute the whole
   * suite once per empty partition.
   */
  private assertNonEmptyAssignments(assignments: readonly (readonly string[])[]): void {
    const empty = assignments.findIndex(files => files.length === 0)
    if (empty >= 0) {
      throw new Error(
        `coverage partitions: partition ${empty + 1}/${this.partitions} has no files; `
        + 'the instrumented inventory is empty or smaller than the partition count.',
      )
    }
  }

  /** Persist measured per-file durations so the next run can weight by them. */
  private persistDurations(partitionCount: number): void {
    const reportFiles = Array.from(
      { length: partitionCount },
      (_, index) => join(this.temporaryRoot, `partition-${index + 1}.report.json`),
    )
    const currentFiles = this.projectOf.size > 0 ? [...this.projectOf.keys()] : undefined
    writeFileDurations(this.root, collectPartitionDurations(reportFiles, this.root), currentFiles)
  }

  /**
   * Distribute the instrumented inventory across partitions by recorded
   * duration, heaviest partition first so the longest child starts earliest
   * (fail-fast: its verdict, success or failure, lands before the light
   * children settle). An injected file list skips workspace collection and
   * cache reads (scheduler tests); production collection always runs.
   */
  private async assignFiles(): Promise<string[][]> {
    let files: readonly string[]
    let weights: ReadonlyMap<string, number>
    if (this.files.length > 0) {
      files = this.files
      weights = this.weights ?? new Map()
    } else {
      // Positional filters live after the `--` separator; options and their
      // values (`--testTimeout 5000`) must never be mistaken for filters.
      const separator = this.vitestArgs.indexOf('--')
      const filters = separator >= 0 ? this.vitestArgs.slice(separator + 1) : []
      const inventory = await collectInstrumentedFiles(this.root, this.pnpmEntrypoint, filters)
      files = inventory.files
      this.projectOf = inventory.projectOf
      weights = readFileDurations(this.root)
    }
    const buckets = assignWeightedPartitions(files, weights, this.partitions)
    buckets.sort((left, right) => partitionWeight(right, weights) - partitionWeight(left, weights))
    return buckets
  }

  /**
   * Write one temporary Vitest config per partition whose `include` (top level
   * and per project) is the partition's file list. Passing files on the
   * command line exceeded the Windows CreateProcess limit once a partition
   * held a few hundred paths, so each partition instead points Vitest at a
   * short `--config` path.
   */
  private async writePartitionConfigs(assignments: readonly (readonly string[])[]): Promise<string[]> {
    return await Promise.all(assignments.map(async (files, index) => {
      const configPath = join(this.temporaryRoot, `vitest-partition-${index + 1}.config.ts`)
      await writeFile(configPath, partitionConfigSource(files, this.projectOf), 'utf8')
      return configPath
    }))
  }

  private partitionCommand(index: number, configPath: string): CoverageCommand {
    const blobPath = join(this.blobsRoot, `partition-${index}.json`)
    const reportsDirectory = join(this.temporaryRoot, `coverage-${index}`)
    const jsonReportPath = join(this.temporaryRoot, `partition-${index}.report.json`)
    const invocation = pnpmInvocation([
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--coverage.reportOnFailure',
      '--maxWorkers=1',
      `--config=${this.relativePath(configPath)}`,
      '--reporter=default',
      '--reporter=blob',
      '--reporter=json',
      `--reporter=${CANONICAL_LOCATIONS_REPORTER}`,
      `--outputFile.blob=${this.relativePath(blobPath)}`,
      `--outputFile.json=${this.relativePath(jsonReportPath)}`,
      `--coverage.reportsDirectory=${this.relativePath(reportsDirectory)}`,
      ...this.vitestArgs,
    ], { npm_execpath: this.pnpmEntrypoint })
    return {
      label: `partition ${index}/${this.partitions}`,
      ...invocation,
      env: {
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: '1',
      },
      cwd: this.root,
      blobPath,
    }
  }

  private mergeCommand(): CoverageCommand {
    const invocation = pnpmInvocation([
      'exec',
      'vitest',
      `--merge-reports=${this.relativePath(this.blobsRoot)}`,
      '--coverage',
    ], { npm_execpath: this.pnpmEntrypoint })
    return {
      label: 'merged coverage report',
      ...invocation,
      env: {
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: undefined,
      },
      cwd: this.root,
    }
  }

  private relativePath(path: string): string {
    return relative(this.root, path).split(sep).join('/')
  }

  private async assertCompleteBlobSet(commands: CoverageCommand[]): Promise<void> {
    const expected = commands.map((command) => {
      if (command.blobPath === undefined) throw new Error(`${command.label} has no blob path.`)
      return this.relativePath(command.blobPath)
    }).sort()
    const actual = (await readdir(this.blobsRoot))
      .map(name => this.relativePath(join(this.blobsRoot, name)))
      .sort()
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error(`coverage partitions produced ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`)
    }
  }
}

/** Spawn one pnpm-backed command without a platform shell. */
function runCoverageCommand(command: CoverageCommand): Promise<CoverageCommandResult> {
  return new Promise((resolveCommand) => {
    let outputTail = ''
    const env = { ...process.env }
    for (const [name, value] of Object.entries(command.env)) {
      if (value === undefined) Reflect.deleteProperty(env, name)
      else env[name] = value
    }
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk)
      outputTail = appendOutputTail(outputTail, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      outputTail = appendOutputTail(outputTail, chunk)
    })
    child.once('error', (error: Error) => {
      resolveCommand({ exitCode: null, signalCode: null, error: error.message, outputTail })
    })
    child.once('close', (exitCode, signalCode) => {
      resolveCommand({ exitCode, signalCode, outputTail })
    })
  })
}

function appendOutputTail(previous: string, chunk: string): string {
  const combined = previous + chunk
  return combined.length <= 65_536 ? combined : combined.slice(-65_536)
}

function commandFailed(result: CoverageCommandResult): boolean {
  return result.exitCode !== 0 || result.signalCode !== null || result.error !== undefined
}

function commandFailureReason(result: CoverageCommandResult): string {
  const facts = [
    result.error,
    result.exitCode === null ? undefined : `exit ${result.exitCode}`,
    result.signalCode === null ? undefined : `signal ${result.signalCode}`,
  ].filter((fact): fact is string => fact !== undefined)
  return facts.join(', ') || 'no exit code or signal'
}

async function removeOwnedTree(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await unlink(path)
    return
  }
  await rm(path, { recursive: true, force: true })
}
