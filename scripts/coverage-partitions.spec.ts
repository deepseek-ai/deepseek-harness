import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COVERAGE_PARTITION_MODE_ENV,
  COVERAGE_PARTITIONS_ENV,
  COVERAGE_TEST_TIMEOUT_ENV,
  CoveragePartitionCoordinator,
  assignWeightedPartitions,
  collectPartitionDurations,
  coverageTestTimeoutArgs,
  forwardedCoverageArgs,
  parseCoveragePartitionCount,
  parseListOutput,
  readFileDurations,
  writeFileDurations,
  type CoverageCommand,
  type CoverageCommandResult,
  type CoveragePartitionCoordinatorOptions,
} from './coverage-partitions.ts'

const passed: CoverageCommandResult = { exitCode: 0, signalCode: null }

/** Every temporary root created by this file, removed after each test. */
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function writeBlob(command: CoverageCommand): Promise<void> {
  if (command.blobPath === undefined) return
  await mkdir(dirname(command.blobPath), { recursive: true })
  await writeFile(command.blobPath, '{}')
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-partitions-'))
  roots.push(root)
  return root
}

/** Write a Vitest results cache under a temporary root. */
async function writeVitestCache(root: string, entries: Array<[string, { duration: number }]>): Promise<void> {
  const cacheDir = join(root, 'node_modules/.vite/vitest/cache-hash')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, 'results.json'), JSON.stringify({ version: '4.1.8', results: entries }))
}

/** Run the coordinator and capture every partition config's source. */
async function runCoordinatorReadingConfigs(
  root: string,
  options: Omit<CoveragePartitionCoordinatorOptions, 'root' | 'pnpmEntrypoint' | 'runCommand'>,
): Promise<Map<string, string>> {
  const configContents = new Map<string, string>()
  const runCommand = vi.fn(async (command: CoverageCommand) => {
    const configArgument = command.args.find(argument => argument.startsWith('--config='))
    if (configArgument !== undefined) {
      configContents.set(command.label, await readFile(join(root, configArgument.slice('--config='.length)), 'utf8'))
    }
    await writeBlob(command)
    return passed
  })
  const coordinator = new CoveragePartitionCoordinator({
    root,
    pnpmEntrypoint: '/pnpm.cjs',
    runCommand,
    ...options,
  })
  await expect(coordinator.run()).resolves.toBe(0)
  return configContents
}

function successfulCommandRecorder(commands: CoverageCommand[]) {
  return vi.fn(async (command: CoverageCommand) => {
    commands.push(command)
    await writeBlob(command)
    return passed
  })
}

describe('coverage partition count', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['2', 2],
    ['3', 3],
  ])('parses %j as %j', (raw, expected) => {
    expect(parseCoveragePartitionCount(raw)).toBe(expected)
  })

  it.each(['0', '1', '2.5', '02', 'many'])('rejects %j', (raw) => {
    expect(() => parseCoveragePartitionCount(raw))
      .toThrow(`${COVERAGE_PARTITIONS_ENV} must be an integer greater than 1`)
  })
})

describe('coverage partition timeout', () => {
  it('applies one configured timeout to tests, polling, and hooks', () => {
    expect(coverageTestTimeoutArgs('30000')).toEqual([
      '--testTimeout=30000',
      '--expect.poll.timeout=30000',
      '--hookTimeout=30000',
    ])
  })

  it('keeps Vitest defaults when the timeout is absent', () => {
    expect(coverageTestTimeoutArgs(undefined)).toEqual([])
  })

  it('rejects invalid timeout input', () => {
    expect(() => coverageTestTimeoutArgs('0'))
      .toThrow(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer`)
  })
})

describe('coverage forwarded arguments', () => {
  it('removes one package-script separator', () => {
    expect(forwardedCoverageArgs(['--', 'scripts/example.spec.ts'])).toEqual(['scripts/example.spec.ts'])
  })

  it('preserves direct arguments and a subsequent Vitest separator', () => {
    expect(forwardedCoverageArgs(['--testNamePattern=example'])).toEqual(['--testNamePattern=example'])
    expect(forwardedCoverageArgs(['--', '--', 'example'])).toEqual(['--', 'example'])
  })
})

describe('weighted partition assignment', () => {
  it('seeds the heaviest files into different partitions', () => {
    const weights = new Map<string, number>([
      ['packages/a/tests/heavy-1.spec.ts', 100],
      ['packages/a/tests/heavy-2.spec.ts', 90],
      ['packages/a/tests/heavy-3.spec.ts', 80],
      ['packages/a/tests/light.spec.ts', 1],
    ])
    const buckets = assignWeightedPartitions([...weights.keys()], weights, 3)
    expect(buckets).toHaveLength(3)
    for (const bucket of buckets) {
      expect(bucket).not.toHaveLength(0)
      expect(bucket.filter(file => file.includes('heavy'))).toHaveLength(1)
    }
  })

  it('balances total weight across partitions', () => {
    const files = Array.from({ length: 20 }, (_, index) => `packages/a/tests/file-${index}.spec.ts`)
    const weights = new Map(files.map((file, index) => [file, (index % 7) + 1]))
    const buckets = assignWeightedPartitions(files, weights, 4)
    const sums = buckets.map(bucket => bucket.reduce((sum, file) => sum + (weights.get(file) ?? 0), 0))
    const spread = Math.max(...sums) - Math.min(...sums)
    expect(spread).toBeLessThanOrEqual(7)
  })

  it('steers assignment by weight, not by file count', () => {
    // Weight-aware LPT balances three buckets to 1500 each. A file-count-only
    // rule pairs the heaviest file with the fourth (1700), so the assertion
    // only passes when recorded weights steer the assignment.
    const weights = new Map<string, number>([
      ['a.spec.ts', 1000],
      ['b.spec.ts', 900],
      ['c.spec.ts', 800],
      ['d.spec.ts', 700],
      ['e.spec.ts', 600],
      ['f.spec.ts', 500],
    ])
    const buckets = assignWeightedPartitions([...weights.keys()], weights, 3)
    const sums = buckets.map(bucket => bucket.reduce((sum, file) => sum + (weights.get(file) ?? 0), 0))
    expect(Math.max(...sums)).toBeLessThanOrEqual(1550)
  })

  it('leaves trailing empty buckets when files are scarce', () => {
    const files = ['a.spec.ts', 'b.spec.ts']
    const buckets = assignWeightedPartitions(files, new Map(), 4)
    expect(buckets.map(bucket => bucket.length).sort()).toEqual([0, 0, 1, 1])
  })

  it('returns one empty bucket per partition for an empty inventory', () => {
    expect(assignWeightedPartitions([], new Map(), 3)).toEqual([[], [], []])
  })

  it('assigns unknown-weight files evenly', () => {
    const files = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts']
    const buckets = assignWeightedPartitions(files, new Map(), 2)
    expect(buckets.map(bucket => bucket.length).sort()).toEqual([2, 2])
  })
})

describe('coverage file inventory', () => {
  it('parses vitest list --filesOnly output, keeps project ownership, and drops exempt suites', async () => {
    const root = await temporaryRoot()
    const exemptDir = join(root, 'packages/experimental/webworker-runtime/tests')
    await mkdir(exemptDir, { recursive: true })
    await writeFile(join(exemptDir, 'transform-corpus.spec.ts'), '')
    const output = [
      '[thread-safe] packages/a/tests/a.spec.ts',
      '[process-bound] packages/b/tests/b.spec.ts',
      '[thread-safe] packages/experimental/webworker-runtime/tests/transform-corpus.spec.ts',
      'not a test line',
    ].join('\n')
    const inventory = parseListOutput(output, root)
    expect(inventory.files).toEqual([
      'packages/a/tests/a.spec.ts',
      'packages/b/tests/b.spec.ts',
    ])
    expect(inventory.projectOf.get('packages/a/tests/a.spec.ts')).toBe('thread-safe')
    expect(inventory.projectOf.get('packages/b/tests/b.spec.ts')).toBe('process-bound')
  })

  it('averages recorded durations per file from the results cache', async () => {
    const root = await temporaryRoot()
    await writeVitestCache(root, [
      ['thread-safe:packages/a/tests/x.spec.ts', { duration: 10 }],
      ['process-bound:packages/a/tests/x.spec.ts', { duration: 30 }],
      ['thread-safe:packages/a/tests/y.spec.ts', { duration: 5 }],
    ])
    const durations = readFileDurations(root)
    expect(durations.get('packages/a/tests/x.spec.ts')).toBe(20)
    expect(durations.get('packages/a/tests/y.spec.ts')).toBe(5)
  })

  it('prefers the persisted duration file over the vitest cache', async () => {
    const root = await temporaryRoot()
    await writeVitestCache(root, [['thread-safe:packages/a/tests/x.spec.ts', { duration: 100 }]])
    writeFileDurations(root, new Map([['packages/a/tests/x.spec.ts', 42]]))
    expect(readFileDurations(root).get('packages/a/tests/x.spec.ts')).toBe(42)
  })

  it('merges new durations into the persisted file', async () => {
    const root = await temporaryRoot()
    writeFileDurations(root, new Map([['packages/a/tests/x.spec.ts', 42]]))
    writeFileDurations(root, new Map([
      ['packages/a/tests/x.spec.ts', 55],
      ['packages/a/tests/y.spec.ts', 7],
    ]))
    const durations = readFileDurations(root)
    expect(durations.get('packages/a/tests/x.spec.ts')).toBe(55)
    expect(durations.get('packages/a/tests/y.spec.ts')).toBe(7)
  })

  it('extracts per-file durations from partition json reports', async () => {
    const root = await temporaryRoot()
    const report = join(root, 'partition-1.report.json')
    await writeFile(report, JSON.stringify({
      testResults: [
        { name: join(root, 'packages/a/tests/x.spec.ts'), startTime: 1000, endTime: 1500 },
        { name: 'not-a-spec', startTime: 1, endTime: 2 },
      ],
    }))
    const durations = collectPartitionDurations([report], root)
    expect(durations.get('packages/a/tests/x.spec.ts')).toBe(500)
  })
})

describe('coverage partition coordinator', () => {
  const weightedFiles = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts']
  const weightedDurations = new Map([
    ['a.spec.ts', 100],
    ['b.spec.ts', 50],
    ['c.spec.ts', 10],
  ])
  const weightedProjects = new Map([
    ['a.spec.ts', 'thread-safe'],
    ['b.spec.ts', 'process-bound'],
    ['c.spec.ts', 'process-bound'],
  ])
  it('runs every single-worker partition before one merged threshold check', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const partitionConfigs: string[] = []
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      commands.push(command)
      const configArgument = command.args.find(argument => argument.startsWith('--config='))
      if (configArgument !== undefined) {
        partitionConfigs.push(await readFile(join(root, configArgument.slice('--config='.length)), 'utf8'))
      }
      await writeBlob(command)
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 3,
      pnpmEntrypoint: '/pnpm.cjs',
      vitestArgs: ['--testTimeout=30000'],
      files: ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)

    expect(commands.map(command => command.label)).toEqual([
      'partition 1/3',
      'partition 2/3',
      'partition 3/3',
      'merged coverage report',
    ])
    for (const command of commands.slice(0, 3)) {
      expect(command.command).toBe(process.execPath)
      expect(command.args[0]).toBe('/pnpm.cjs')
      expect(command.args).toEqual(expect.arrayContaining([
        '--coverage',
        '--coverage.reportOnFailure',
        '--maxWorkers=1',
        '--reporter=default',
        '--reporter=blob',
        '--reporter=json',
        '--testTimeout=30000',
      ]))
      expect(command.args).not.toContain('--shard=1/3')
      expect(command.args.some(argument => argument.startsWith('--config='))).toBe(true)
      expect(command.env).toEqual({
        [COVERAGE_PARTITIONS_ENV]: undefined,
        [COVERAGE_PARTITION_MODE_ENV]: '1',
      })
    }
    // The partition file list travels in a temporary config, not on the
    // command line (which exceeds the Windows CreateProcess limit).
    expect(partitionConfigs).toHaveLength(3)
    const allConfigs = partitionConfigs.join('\n')
    expect(allConfigs).toContain('a.spec.ts')
    expect(allConfigs).toContain('b.spec.ts')
    expect(allConfigs).toContain('c.spec.ts')
    for (const source of partitionConfigs) {
      expect(source).toContain("from '../../vitest.config.ts'")
    }
    const mergeCommand = commands[3]
    if (mergeCommand === undefined) throw new Error('coverage merge command was not observed')
    expect(mergeCommand.args).toContain('--coverage')
    expect(mergeCommand.args.some(argument => argument.startsWith('--merge-reports='))).toBe(true)
    expect(mergeCommand.env).toEqual({
      [COVERAGE_PARTITIONS_ENV]: undefined,
      [COVERAGE_PARTITION_MODE_ENV]: undefined,
    })
  })

  it('rejects an empty partition assignment before spawning any command', async () => {
    const root = await temporaryRoot()
    const runCommand = vi.fn()
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 3,
      pnpmEntrypoint: '/pnpm.cjs',
      // One file for three partitions leaves two buckets empty; an empty
      // bucket would make Vitest run the whole suite.
      files: ['a.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).rejects.toThrow('partition 2/3 has no files')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('starts the heaviest partition first for fail-fast', async () => {
    const root = await temporaryRoot()
    const configContents = await runCoordinatorReadingConfigs(root, {
      partitions: 2,
      files: weightedFiles,
      weights: weightedDurations,
    })
    // LPT: p1=[a] sum 100, p2=[b,c] sum 60; sorted heaviest-first makes
    // partition 1/2 the heavy one, so its config names a.spec.ts.
    expect(configContents.get('partition 1/2')).toContain('a.spec.ts')
    expect(configContents.get('partition 1/2')).not.toContain('b.spec.ts')
  })

  it('gives each project only its own files in the partition config', async () => {
    const root = await temporaryRoot()
    const configContents = await runCoordinatorReadingConfigs(root, {
      partitions: 2,
      files: weightedFiles,
      weights: weightedDurations,
      projectOf: weightedProjects,
    })
    const allConfigs = [...configContents.values()].join('\n')
    // The process-bound project must not receive the thread-safe file and
    // vice versa, or plain files would run twice.
    expect(allConfigs).toContain("include: project.test.name === 'process-bound' ?")
    expect(allConfigs).not.toContain('"a.spec.ts","b.spec.ts","c.spec.ts"')
  })

  it('runs a native pnpm entrypoint directly', async () => {
    const root = await temporaryRoot()
    const commands: CoverageCommand[] = []
    const runCommand = successfulCommandRecorder(commands)
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/tools/pnpm',
      files: ['a.spec.ts', 'b.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)
    expect(commands).toHaveLength(3)
    for (const command of commands) {
      expect(command.command).toBe('/tools/pnpm')
      expect(command.args[0]).toBe('exec')
    }
  })

  it('merges normal test failures and returns their failed status', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      return command.label === 'partition 2/2'
        ? { exitCode: 1, signalCode: null, outputTail: 'specific Vitest failure' }
        : passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      files: ['a.spec.ts', 'b.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(1)
    expect(reported).toHaveBeenCalledWith('coverage-partitions: FAIL partition 2/2 (exit 1)')
    expect(reported).toHaveBeenCalledWith(
      'coverage-partitions: output tail for partition 2/2:\nspecific Vitest failure',
    )
    expect(runCommand).toHaveBeenCalledTimes(3)
  })

  it('rejects a missing partition blob before merge', async () => {
    const root = await temporaryRoot()
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      if (command.label !== 'partition 2/2') await writeBlob(command)
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      files: ['a.spec.ts', 'b.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).rejects.toThrow('coverage partitions produced')
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it('reports signal termination before missing-blob validation', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      if (command.label === 'partition 1/2') await writeBlob(command)
      return command.label === 'partition 2/2'
        ? { exitCode: null, signalCode: 'SIGTERM' as const }
        : passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      files: ['a.spec.ts', 'b.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).rejects.toThrow('coverage partitions produced')
    expect(reported).toHaveBeenCalledWith('coverage-partitions: FAIL partition 2/2 (signal SIGTERM)')
  })

  it('waits for every partition after one spawn failure', async () => {
    const root = await temporaryRoot()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let secondFinished = false
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      if (command.label === 'partition 1/2') {
        return { exitCode: null, signalCode: null, error: 'spawn unavailable' }
      }
      if (command.label === 'partition 2/2') secondFinished = true
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      files: ['a.spec.ts', 'b.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(1)
    expect(reported).toHaveBeenCalledWith('coverage-partitions: FAIL partition 1/2 (spawn unavailable)')
    expect(secondFinished).toBe(true)
    expect(runCommand).toHaveBeenCalledTimes(3)
  })

  it('unlinks a link-shaped coverage path without touching its target', async () => {
    const root = await temporaryRoot()
    const target = await temporaryRoot()
    const marker = join(target, 'marker.txt')
    await writeFile(marker, 'owned elsewhere')
    await symlink(target, join(root, 'coverage'), process.platform === 'win32' ? 'junction' : 'dir')
    const runCommand = vi.fn(async (command: CoverageCommand) => {
      await writeBlob(command)
      return passed
    })
    const coordinator = new CoveragePartitionCoordinator({
      root,
      partitions: 2,
      pnpmEntrypoint: '/pnpm.cjs',
      files: ['a.spec.ts', 'b.spec.ts'],
      runCommand,
    })

    await expect(coordinator.run()).resolves.toBe(0)
    await expect(access(marker)).resolves.toBeUndefined()
  })
})
