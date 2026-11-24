/**
 * Coordinate single-worker Vitest coverage partitions and one merged report.
 * Separate processes preserve worker isolation; only the complete merged
 * inventory can enforce per-file coverage thresholds. CI splits the inventory
 * into file shards on separate runners and merges their blobs on one report job.
 */
import { spawn } from 'node:child_process'
import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { TestUserConfig } from 'vitest/config'
import { coverageExemptHeavySuites } from './coverage-exempt.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Environment variable selecting the number of instrumented coverage processes. */
export const COVERAGE_PARTITIONS_ENV = 'DSH_COVERAGE_PARTITIONS'

/** Internal marker that suppresses reports and thresholds inside a partition process. */
export const COVERAGE_PARTITION_MODE_ENV = 'DSH_COVERAGE_PARTITION_MODE'

/** Environment variable carrying a lane's per-test, hook, and `expect.poll` budget in milliseconds. */
export const COVERAGE_TEST_TIMEOUT_ENV = 'DSH_COVERAGE_TEST_TIMEOUT_MS'

/**
 * Environment variable selecting one file shard of the instrumented inventory,
 * as `<index>/<count>`. A shard run writes {@link COVERAGE_SHARD_DIRECTORY}
 * and leaves merging and thresholds to {@link mergeCoverageShards}.
 */
export const COVERAGE_SHARD_ENV = 'DSH_COVERAGE_SHARD'

/** Root-relative directory where a shard run writes its manifest, blobs, and durations. */
export const COVERAGE_SHARD_DIRECTORY = 'coverage/shard'

/** One selected file shard: 1-based `index` of `count`. */
export interface CoverageShard {
  index: number
  count: number
}

/**
 * Parse an optional coverage file shard.
 * @param raw - the `DSH_COVERAGE_SHARD` value.
 * @returns the shard, or undefined when unset or empty.
 * @throws when the value is not `<index>/<count>` with 1 <= index <= count.
 */
export function parseCoverageShard(raw: string | undefined): CoverageShard | undefined {
  if (raw === undefined || raw === '') return undefined
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(raw)
  if (match === null || Number(match[1]) > Number(match[2])) {
    throw new Error(`${COVERAGE_SHARD_ENV} must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(raw)}.`)
  }
  return { index: Number(match[1]), count: Number(match[2]) }
}

/**
 * Select one shard's files by byte size: files are taken largest first (ties by
 * repository-relative path) and each goes to the shard with the smallest total
 * size so far (ties to the lower index). Byte size stands in for test cost; the
 * split reads only the checkout, so every shard computes the same assignment.
 * @param files - the instrumented inventory.
 * @param shard - the shard to keep.
 * @param sizeOf - byte size of one repository-relative file.
 * @returns the shard's files in path order.
 */
export function selectCoverageShardFiles(
  files: readonly string[],
  shard: CoverageShard,
  sizeOf: (file: string) => number,
): string[] {
  const loads = Array.from({ length: shard.count }, () => 0)
  const selected: string[] = []
  const ordered = [...files].map(file => ({ file, size: sizeOf(file) }))
    .sort((left, right) => right.size - left.size || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  for (const { file, size } of ordered) {
    let owner = 0
    for (let index = 1; index < loads.length; index++) {
      if ((loads[index] ?? 0) < (loads[owner] ?? 0)) owner = index
    }
    loads[owner] = (loads[owner] ?? 0) + size
    if (owner === shard.index - 1) selected.push(file)
  }
  return selected.sort()
}

/** Manifest a shard run writes beside its blobs, read back by {@link mergeCoverageShards}. */
export interface CoverageShardManifest {
  /** The shard as `<index>/<count>`. */
  shard: string
  /** Absolute checkout root of the shard run, the prefix of every path its blobs record. */
  root: string
  /** Test files the shard ran, in path order. */
  files: string[]
  /** Blob file names under the shard's `blobs/` directory. */
  blobs: string[]
}

/**
 * Reporter that canonicalizes a partition's coverage locations before its blob
 * is serialized (see scripts/coverage-canonical-locations.ts). Root-relative in
 * POSIX spelling because every child runs with the repository root as its
 * working directory on every platform.
 */
const CANONICAL_LOCATIONS_REPORTER = './scripts/coverage-canonical-locations.ts'
const FILE_TIMES_REPORTER = './scripts/coverage-file-times.ts'

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
  /** Vitest `FAIL` and `×` lines from the whole output, bounded, repeated in the run summary. */
  failedTests?: string[]
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
  /** File shard to run; its manifest, blobs, and durations replace the merge and thresholds. */
  shard?: CoverageShard
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
 * Parse the lane test budget carried by `DSH_COVERAGE_TEST_TIMEOUT_MS`.
 * @param raw - the configured millisecond budget, or undefined to keep Vitest's defaults.
 * @returns the budget in milliseconds, or undefined when unset.
 * @throws when the value is set and is not a positive integer.
 */
export function parseCoverageTestTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

/** The Vitest `test` options one lane budget sets in each inline project. */
export type CoverageTestTimeoutOptions = Pick<TestUserConfig, 'testTimeout' | 'hookTimeout' | 'expect'>

/**
 * Resolve the Vitest test options that apply one lane budget to the per-test,
 * hook, and `expect.poll` defaults together. The hook budget travels with the
 * test budget because setup and teardown pay the same host contention the
 * raised test budget accounts for: fixtures that await child exit or retry
 * Windows handle release spend that cost in `afterEach`, where Vitest's
 * separate 10 s default would otherwise fail a suite whose cases all passed.
 * The root `vitest.config.ts` spreads these into each inline project, so the
 * budget governs every Vitest run of that config in an environment carrying
 * the variable, whichever gate or script starts it. The config, not a CLI
 * flag, is the only route into inline projects: Vitest forwards a fixed list
 * of CLI overrides into projects, and `--hookTimeout` and
 * `--expect.poll.timeout` are not on it (only `--testTimeout` is). Explicit
 * `describe`, case, and fixture timeouts remain authoritative.
 * @param raw - the configured millisecond budget, or undefined to keep Vitest's defaults.
 * @returns the options to spread into a project's `test` block, empty when unset.
 */
export function coverageTestTimeoutOptions(raw: string | undefined): CoverageTestTimeoutOptions {
  const timeout = parseCoverageTestTimeout(raw)
  if (timeout === undefined) return {}
  return { testTimeout: timeout, hookTimeout: timeout, expect: { poll: { timeout } } }
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

/** File names inside a shard directory. */
const SHARD_MANIFEST_NAME = 'shard.json'
const SHARD_TIMES_NAME = 'times.json'
const SHARD_BLOBS_NAME = 'blobs'

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
 * Parse Vitest's JSON file inventory, excluding uninstrumented heavy suites.
 * @param output - JSON written by `vitest list --filesOnly --json=<file>`.
 * @param root - repository root used to make file paths relative.
 * @returns sorted test files and their owning Vitest projects.
 * @throws when a record is malformed or a file has multiple project assignments.
 */
export function parseFileInventory(output: string, root: string): InstrumentedInventory {
  const entries: unknown = JSON.parse(output)
  if (!Array.isArray(entries)) throw new Error('coverage inventory must be a JSON array')
  const files = new Set<string>()
  const projectOf = new Map<string, string>()
  for (const value of entries) {
    const entry: unknown = value
    if (entry === null || typeof entry !== 'object' || !('file' in entry) || typeof entry.file !== 'string'
      || !('projectName' in entry) || (entry.projectName !== 'thread-safe' && entry.projectName !== 'process-bound')) {
      throw new Error('coverage inventory requires a file and its thread-safe or process-bound project')
    }
    const file = relative(root, entry.file).split(sep).join('/')
    if (files.has(file)) throw new Error(`coverage inventory lists ${file} more than once`)
    files.add(file)
    projectOf.set(file, entry.projectName)
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
  inventoryPath: string,
  filters: readonly string[] = [],
): Promise<InstrumentedInventory> {
  const invocation = pnpmInvocation(['exec', 'vitest', 'list', '--filesOnly', `--json=${inventoryPath}`, ...filters], { npm_execpath: pnpmEntrypoint })
  await runListCommand(invocation.command, invocation.args, root)
  return parseFileInventory(await readFile(inventoryPath, 'utf8'), root)
}

/** Wait for `vitest list` to write its JSON file, or throw with exit code and stderr. */
function runListCommand(command: string, args: string[], root: string): Promise<void> {
  return new Promise((resolveList, rejectList) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let errorOutput = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { errorOutput += chunk })
    child.once('error', (error: Error) => { rejectList(error) })
    child.once('close', (code) => {
      if (code === 0) resolveList()
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
 * Extract per-file durations from compact timing reports, one per partition.
 * @param reportFiles - reports listing repository-relative file paths and milliseconds.
 * @returns finite, non-negative file costs from readable reports.
 */
export function collectPartitionDurations(reportFiles: readonly string[]): Map<string, number> {
  const durations = new Map<string, number>()
  for (const file of reportFiles) {
    let report: unknown
    try {
      report = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(report)) continue
    for (const entry of report) {
      const record: unknown = entry
      if (record !== null && typeof record === 'object' && 'file' in record && typeof record.file === 'string'
        && 'duration' in record && typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration >= 0) {
        durations.set(record.file, record.duration)
      }
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
    "import { coverageForkPool } from '../../scripts/coverage-fork-diagnostics.ts'",
    'export default {',
    '  ...base,',
    '  test: {',
    '    ...base.test,',
    '    projects: (base.test.projects ?? []).map(project => ({',
    '      ...project,',
    '      test: {',
    '        ...project.test,',
    '        pool: coverageForkPool,',
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
  private readonly shard: CoverageShard | undefined
  private readonly temporaryRoot: string
  private readonly blobsRoot: string
  private readonly blobPrefix: string

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
    this.shard = options.shard
    this.temporaryRoot = join(this.root, 'coverage', '.partitioned')
    // Shard blobs carry the shard index so the report job can merge every
    // shard's blobs from one directory.
    this.blobsRoot = this.shard === undefined ? join(this.temporaryRoot, 'blobs') : join(this.root, COVERAGE_SHARD_DIRECTORY, SHARD_BLOBS_NAME)
    this.blobPrefix = this.shard === undefined ? '' : `shard-${this.shard.index}-`
  }

  /**
   * Run every partition and verify its test-file inventory before one merged threshold check.
   * A shard run instead writes its manifest, blobs, and durations under `coverage/shard/`.
   * Failed runs retain inventories, partition configs, and test reports in coverage/.partitioned.
   * @returns zero only when every partition and the merge command succeed.
   */
  public async run(): Promise<number> {
    await removeOwnedTree(join(this.root, 'coverage'))
    await mkdir(this.temporaryRoot, { recursive: true })
    await mkdir(this.blobsRoot, { recursive: true })

    let succeeded = false
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
      reportFailedPartitions(commands, results)
      if (this.shard !== undefined) {
        await this.assertCompleteBlobSet(commands)
        await this.assertCompleteTestFiles(assignments)
        await this.writeShardOutput(this.shard, assignments, commands)
        succeeded = !results.some(commandFailed)
        return succeeded ? 0 : 1
      }
      // Persist durations before blob validation: a missing blob aborts the
      // run, but the completed partitions' timings are still worth keeping.
      this.persistDurations(this.partitions)
      await this.assertCompleteBlobSet(commands)
      await this.assertCompleteTestFiles(assignments)

      const mergeCommand = this.mergeCommand()
      console.log(`coverage-partitions: start ${mergeCommand.label}`)
      const mergeResult = await this.runCommand(mergeCommand)
      succeeded = !results.some(commandFailed) && !commandFailed(mergeResult)
      return succeeded ? 0 : 1
    } finally {
      if (succeeded) await removeOwnedTree(this.temporaryRoot)
      else console.error(`coverage-partitions: diagnostics retained at ${this.relativePath(this.temporaryRoot)}`)
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
      (_, index) => join(this.temporaryRoot, `partition-${index + 1}.times.json`),
    )
    const currentFiles = this.projectOf.size > 0 ? [...this.projectOf.keys()] : undefined
    writeFileDurations(this.root, collectPartitionDurations(reportFiles), currentFiles)
  }

  /** Write the shard manifest and measured durations beside the shard's blobs. */
  private async writeShardOutput(
    shard: CoverageShard,
    assignments: readonly (readonly string[])[],
    commands: readonly CoverageCommand[],
  ): Promise<void> {
    const directory = join(this.root, COVERAGE_SHARD_DIRECTORY)
    const manifest: CoverageShardManifest = {
      shard: `${shard.index}/${shard.count}`,
      root: this.root,
      files: assignments.flat().sort(),
      blobs: commands.map(command => basename(command.blobPath ?? '')).sort(),
    }
    const reportFiles = assignments.map((_, index) => join(this.temporaryRoot, `partition-${index + 1}.times.json`))
    await writeFile(join(directory, SHARD_MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`, 'utf8')
    const durations = [...collectPartitionDurations(reportFiles)].map(([file, duration]) => ({ file, duration }))
    await writeFile(join(directory, SHARD_TIMES_NAME), `${JSON.stringify(durations, null, 1)}\n`, 'utf8')
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
      const inventory = await collectInstrumentedFiles(this.root, this.pnpmEntrypoint, join(this.temporaryRoot, 'inventory.json'), filters)
      files = inventory.files
      this.projectOf = inventory.projectOf
      weights = readFileDurations(this.root)
    }
    if (this.shard !== undefined) {
      files = selectCoverageShardFiles(files, this.shard, file => statSync(join(this.root, file)).size)
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
    const blobPath = join(this.blobsRoot, `${this.blobPrefix}partition-${index}.json`)
    const reportsDirectory = join(this.temporaryRoot, `coverage-${index}`)
    const timingReportPath = join(this.temporaryRoot, `partition-${index}.times.json`)
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
      `--reporter=${FILE_TIMES_REPORTER}`,
      `--reporter=${CANONICAL_LOCATIONS_REPORTER}`,
      `--outputFile.blob=${this.relativePath(blobPath)}`,
      `--outputFile.fileTimes=${this.relativePath(timingReportPath)}`,
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
    return mergeReportsCommand(this.root, this.pnpmEntrypoint, this.blobsRoot)
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

  /** Require each compact timing report to account for every assigned file exactly once. */
  private async assertCompleteTestFiles(assignments: readonly (readonly string[])[]): Promise<void> {
    await Promise.all(assignments.map(async (expected, index) => {
      const path = join(this.temporaryRoot, `partition-${index + 1}.times.json`)
      const report: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!Array.isArray(report)) {
        throw new Error(`coverage partition report ${path} must contain file timing records`)
      }
      const actual = report.map((result: unknown) => {
        if (result === null || typeof result !== 'object' || !('file' in result) || typeof result.file !== 'string') {
          throw new Error(`coverage partition report ${path} contains a test result without a filename`)
        }
        return result.file
      })
      const observed = new Set(actual)
      const assigned = new Set(expected)
      const missing = expected.filter(file => !observed.has(file))
      const unexpected = actual.filter(file => !assigned.has(file))
      if (missing.length > 0 || unexpected.length > 0 || observed.size !== actual.length) {
        throw new Error(`coverage partition ${index + 1}: missing files ${JSON.stringify(missing)}; unexpected files ${JSON.stringify(unexpected)}; duplicate results ${actual.length - observed.size}`)
      }
    }))
  }
}

/** Construction inputs for {@link mergeCoverageShards}. */
export interface CoverageShardMergeOptions {
  /** Repository root that owns coverage output. */
  root: string
  /** pnpm JavaScript or executable entrypoint from `npm_execpath`. */
  pnpmEntrypoint: string
  /** Directory outside `coverage/` whose immediate subdirectories each hold one shard's `coverage/shard/` output. */
  inputDirectory: string
  /** Child executor, injectable for tests. */
  runCommand?: CoverageCommandRunner
  /** Instrumented inventory; collected from the workspace when absent. */
  inventory?: readonly string[]
}

/** One shard's validated output directory. */
interface ShardOutput {
  directory: string
  shard: CoverageShard
  root: string
  files: string[]
  blobs: string[]
}

/**
 * Merge the blobs of every file shard into one report with thresholds. Before
 * merging, the shard file lists must be disjoint, their union must equal the
 * re-listed instrumented inventory, and every listed blob must be present;
 * the shards' measured durations replace `.coverage-times.json`.
 * @param options - the repository, shard outputs, and optional injected executor and inventory.
 * @returns zero only when the merged report and its thresholds pass.
 * @throws when a shard output is malformed or the shards do not cover the inventory exactly once.
 */
export async function mergeCoverageShards(options: CoverageShardMergeOptions): Promise<number> {
  const coverageRoot = join(options.root, 'coverage')
  const input = relative(coverageRoot, options.inputDirectory)
  if (input === '' || (!input.startsWith('..') && !isAbsolute(input))) {
    throw new Error(`coverage shard merge: input ${options.inputDirectory} must lie outside ${coverageRoot}, which the merge replaces.`)
  }
  await removeOwnedTree(coverageRoot)
  const mergeRoot = join(coverageRoot, '.merge')
  const blobsRoot = join(mergeRoot, SHARD_BLOBS_NAME)
  await mkdir(blobsRoot, { recursive: true })
  const shards = await readShardOutputs(options.inputDirectory)
  const inventory = options.inventory
    ?? (await collectInstrumentedFiles(options.root, options.pnpmEntrypoint, join(mergeRoot, 'inventory.json'))).files
  assertShardsCoverInventory(shards, inventory)
  const blobNames = new Set<string>()
  for (const output of shards) {
    for (const blob of output.blobs) {
      if (blobNames.has(blob)) throw new Error(`coverage shard merge: blob ${blob} appears in more than one shard.`)
      blobNames.add(blob)
      await copyShardBlob(join(output.directory, SHARD_BLOBS_NAME, blob), join(blobsRoot, blob), output.root, options.root)
    }
  }
  writeFileDurations(options.root, collectPartitionDurations(shards.map(output => join(output.directory, SHARD_TIMES_NAME))), inventory)
  const command = mergeReportsCommand(options.root, options.pnpmEntrypoint, blobsRoot)
  console.log(`coverage-partitions: start ${command.label} of ${shards.length} shards`)
  const result = await (options.runCommand ?? runCoverageCommand)(command)
  if (commandFailed(result)) {
    console.error(`coverage-partitions: FAIL ${command.label} (${commandFailureReason(result)})`)
    return 1
  }
  await removeOwnedTree(mergeRoot)
  return 0
}

/**
 * Copy one shard blob into the merge directory. A blob records absolute source
 * paths under its shard's checkout, and the merge keys coverage by those
 * paths, so a shard whose checkout differs from this one has its root prefix
 * rewritten in the serialized JSON strings to the merging checkout.
 */
async function copyShardBlob(source: string, target: string, shardRoot: string, mergeRoot: string): Promise<void> {
  if (shardRoot === mergeRoot) {
    await copyFile(source, target)
    return
  }
  const quoted = (path: string): string => JSON.stringify(`${path}${sep}`).slice(1, -1)
  const content = await readFile(source, 'utf8')
  await writeFile(target, content.split(quoted(shardRoot)).join(quoted(mergeRoot)), 'utf8')
}

/** Read and validate every shard directory, requiring shards 1..count exactly once. */
async function readShardOutputs(inputDirectory: string): Promise<ShardOutput[]> {
  const entries = (await readdir(inputDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const outputs = await Promise.all(entries.map(async (entry) => {
    const directory = join(inputDirectory, entry.name)
    const manifest: unknown = JSON.parse(await readFile(join(directory, SHARD_MANIFEST_NAME), 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || !('shard' in manifest) || typeof manifest.shard !== 'string'
      || !('root' in manifest) || typeof manifest.root !== 'string' || !isAbsolute(manifest.root)
      || !('files' in manifest) || !isStringArray(manifest.files)
      || !('blobs' in manifest) || !isStringArray(manifest.blobs) || manifest.blobs.length === 0) {
      throw new Error(`coverage shard merge: ${directory} needs a ${SHARD_MANIFEST_NAME} with shard, absolute root, files, and at least one blob.`)
    }
    const shard = parseCoverageShard(manifest.shard)
    if (shard === undefined) throw new Error(`coverage shard merge: ${directory} names no shard.`)
    for (const blob of manifest.blobs) {
      const path = join(directory, SHARD_BLOBS_NAME, blob)
      const metadata = basename(blob) === blob ? await lstatIfPresent(path) : undefined
      if (metadata === undefined || !metadata.isFile() || metadata.size === 0) {
        throw new Error(`coverage shard merge: shard ${manifest.shard} blob ${blob} is missing or empty at ${path}.`)
      }
    }
    return { directory, shard, root: manifest.root, files: manifest.files, blobs: manifest.blobs }
  }))
  const count = outputs[0]?.shard.count
  const indices = outputs.map(output => output.shard.index).sort((left, right) => left - right)
  if (count === undefined || outputs.some(output => output.shard.count !== count)
    || indices.length !== count || indices.some((index, position) => index !== position + 1)) {
    throw new Error(`coverage shard merge: expected shards 1..n of one count under ${inputDirectory}, got ${JSON.stringify(outputs.map(output => `${output.shard.index}/${output.shard.count}`))}.`)
  }
  return outputs
}

/** Require disjoint shard file lists whose union is exactly the instrumented inventory. */
function assertShardsCoverInventory(shards: readonly ShardOutput[], inventory: readonly string[]): void {
  const owner = new Map<string, number>()
  const overlapping: string[] = []
  for (const output of shards) {
    for (const file of output.files) {
      if (owner.has(file)) overlapping.push(file)
      else owner.set(file, output.shard.index)
    }
  }
  const expected = new Set(inventory)
  const missing = inventory.filter(file => !owner.has(file))
  const unexpected = [...owner.keys()].filter(file => !expected.has(file))
  if (overlapping.length > 0 || missing.length > 0 || unexpected.length > 0) {
    const sample = (files: readonly string[]): string => `${files.length} ${JSON.stringify(files.slice(0, 20))}`
    throw new Error(`coverage shard merge: shard file lists must partition the instrumented inventory; overlapping ${sample(overlapping)}; missing ${sample(missing)}; unexpected ${sample(unexpected)}.`)
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** The single `vitest --merge-reports` command that applies thresholds to a blob directory. */
function mergeReportsCommand(root: string, pnpmEntrypoint: string, blobsRoot: string): CoverageCommand {
  const invocation = pnpmInvocation([
    'exec',
    'vitest',
    `--merge-reports=${relative(root, blobsRoot).split(sep).join('/')}`,
    '--coverage',
  ], { npm_execpath: pnpmEntrypoint })
  return {
    label: 'merged coverage report',
    ...invocation,
    env: {
      [COVERAGE_PARTITIONS_ENV]: undefined,
      [COVERAGE_PARTITION_MODE_ENV]: undefined,
    },
    cwd: root,
  }
}

/** Spawn one pnpm-backed command without a platform shell. */
function runCoverageCommand(command: CoverageCommand): Promise<CoverageCommandResult> {
  return new Promise((resolveCommand) => {
    let outputTail = ''
    const failures = new FailedTestCollector()
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
      failures.add('stdout', chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      outputTail = appendOutputTail(outputTail, chunk)
      failures.add('stderr', chunk)
    })
    child.once('error', (error: Error) => {
      resolveCommand({ exitCode: null, signalCode: null, error: error.message, outputTail, failedTests: failures.lines() })
    })
    child.once('close', (exitCode, signalCode) => {
      resolveCommand({ exitCode, signalCode, outputTail, failedTests: failures.lines() })
    })
  })
}

/** ANSI color sequences Vitest writes around status markers. */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Maximum failed-test lines one command keeps for the run summary. */
const FAILED_TEST_LINE_LIMIT = 50

/**
 * Collect Vitest failure lines (`FAIL <file> > <test>` and `× <test>`) across
 * output chunks, which can split a line, so a failure stays visible after a
 * long interleaved log.
 */
export class FailedTestCollector {
  private readonly partial = new Map<string, string>()
  private readonly found: string[] = []

  /**
   * Add one output chunk.
   * @param stream - the chunk's stream; partial lines are joined per stream.
   * @param chunk - decoded output.
   */
  public add(stream: string, chunk: string): void {
    const text = (this.partial.get(stream) ?? '') + chunk
    const lines = text.split('\n')
    this.partial.set(stream, lines.pop() ?? '')
    for (const line of lines) this.consider(line)
  }

  /** @returns the collected lines, including a trailing unterminated line. */
  public lines(): string[] {
    for (const [stream, rest] of this.partial) {
      this.consider(rest)
      this.partial.set(stream, '')
    }
    return [...this.found]
  }

  private consider(line: string): void {
    const plain = line.replace(ANSI_COLOR, '').trim()
    if (!/^(FAIL|×)\s/.test(plain) || this.found.length >= FAILED_TEST_LINE_LIMIT) return
    if (!this.found.includes(plain)) this.found.push(plain)
  }
}

/**
 * Repeat each failed partition and its failed tests after every partition has
 * finished, so the cause is at the end of an interleaved multi-partition log.
 */
function reportFailedPartitions(commands: readonly CoverageCommand[], results: readonly CoverageCommandResult[]): void {
  const failed = commands.flatMap((command, index) => {
    const result = results[index]
    return result !== undefined && commandFailed(result) ? [{ command, result }] : []
  })
  if (failed.length === 0) return
  console.error(`coverage-partitions: ${String(failed.length)} of ${String(commands.length)} partition(s) failed:`)
  for (const { command, result } of failed) {
    console.error(`  ${command.label} (${commandFailureReason(result)})`)
    const tests = result.failedTests ?? []
    if (tests.length === 0) console.error('    no Vitest FAIL line; see the output tail above')
    for (const test of tests) console.error(`    ${test}`)
  }
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

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  return await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
}

async function removeOwnedTree(path: string): Promise<void> {
  const metadata = await lstatIfPresent(path)
  if (metadata === undefined) return
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await unlink(path)
    return
  }
  await rm(path, { recursive: true, force: true })
}
