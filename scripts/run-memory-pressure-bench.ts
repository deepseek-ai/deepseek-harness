/** Run the memory-sensitive benchmark files inside a Linux cgroup that models a 4 GB or 8 GB machine. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { pnpmCommand } from './release/process.ts'
import { buildCiBenchArtifacts } from './run-ci-bench.ts'

/** Modeled machines: memory available to the whole benchmark process tree, without swap. */
export const MEMORY_PRESSURE_MACHINES = { '4g': 4, '8g': 8 } as const

/** Modeled machine name. */
export type MemoryPressureMachine = keyof typeof MEMORY_PRESSURE_MACHINES

/**
 * Benchmark files that run under the limit. They cover the Host operations with the largest measured
 * resident memory, the longest Session open, and the Chromium long-history workflow with its Host.
 */
export const MEMORY_PRESSURE_FILES = [
  'benchmarks/session-corpus/session-corpus.bench.ts',
  'benchmarks/session-corpus/projection-list.bench.ts',
  'benchmarks/session-open/session-open.bench.ts',
  'benchmarks/long-session-browser/long-session.bench.ts',
] as const

const USAGE = `usage: run-memory-pressure-bench.ts <${Object.keys(MEMORY_PRESSURE_MACHINES).join('|')}>`

/**
 * Parse a modeled machine name.
 * @param value - Command-line machine name.
 * @returns The machine name.
 * @throws If the name is not a modeled machine.
 */
export function memoryPressureMachine(value: string | undefined): MemoryPressureMachine {
  if (value !== undefined && Object.hasOwn(MEMORY_PRESSURE_MACHINES, value)) return value as MemoryPressureMachine
  throw new Error(USAGE)
}

/**
 * Build the systemd transient-scope command that confines `command` to the machine's memory.
 * @param machine - Modeled machine.
 * @param command - Command and arguments to run inside the scope.
 * @returns The `systemd-run` argument vector.
 */
export function memoryScopeCommand(machine: MemoryPressureMachine, command: readonly string[]): string[] {
  return [
    'systemd-run', '--user', '--scope', '--quiet',
    '-p', `MemoryMax=${String(MEMORY_PRESSURE_MACHINES[machine])}G`,
    '-p', 'MemorySwapMax=0',
    '--', ...command,
  ]
}

function run(root: string, command: readonly string[]): number {
  const [file, ...args] = command
  if (file === undefined) throw new Error('run-memory-pressure-bench: empty command')
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

function cgroupFile(name: string): string {
  const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(entry => entry.startsWith('0::'))
  if (line === undefined) throw new Error('run-memory-pressure-bench: the process is not in a cgroup v2 hierarchy')
  return readFileSync(join('/sys/fs/cgroup', line.slice(3), name), 'utf8').trim()
}

/** Memory controls of the cgroup that contains the benchmark process tree. */
export interface CgroupMemoryLimits {
  /** `memory.max` contents. */
  readonly max: string
  /** `memory.swap.max` contents. */
  readonly swapMax: string
  /** `process.constrainedMemory()` in bytes, which also reflects ancestor cgroups. */
  readonly constrained: number
}

/**
 * Describe why a cgroup does not model the machine.
 * @param machine - Modeled machine.
 * @param limits - Memory controls of the current cgroup.
 * @returns The violation, or `undefined` when memory is capped at the machine's size without swap.
 */
export function memoryLimitViolation(machine: MemoryPressureMachine, limits: CgroupMemoryLimits): string | undefined {
  const limitBytes = String(MEMORY_PRESSURE_MACHINES[machine] * 1024 ** 3)
  if (limits.max === limitBytes && limits.swapMax === '0' && String(limits.constrained) === limitBytes) return undefined
  return `the cgroup does not cap ${machine} without swap: memory.max=${limits.max}, `
    + `memory.swap.max=${limits.swapMax}, constrainedMemory=${String(limits.constrained)}`
}

/**
 * Run the selected benchmark files inside the current cgroup and report its memory facts.
 * `memory.peak` and `oom_kill` cover the cgroup's lifetime: a fresh systemd scope contains only this run, while a
 * container cgroup also contains earlier commands in that container. `memory.peak` needs Linux 5.19 or later.
 * @param root - Repository root with built benchmark artifacts.
 * @param machine - Modeled machine that the current cgroup must enforce.
 * @returns The benchmark exit status.
 * @throws If the current cgroup does not cap memory at the machine's size without swap.
 */
export function runScopedMemoryPressureBench(root: string, machine: MemoryPressureMachine): number {
  const violation = memoryLimitViolation(machine, {
    max: cgroupFile('memory.max'),
    swapMax: cgroupFile('memory.swap.max'),
    constrained: process.constrainedMemory(),
  })
  if (violation !== undefined) throw new Error(`run-memory-pressure-bench: ${violation}`)
  const status = run(root, [...pnpmCommand(), 'exec', 'vitest', 'run', '--config', 'vitest.bench.config.ts', ...MEMORY_PRESSURE_FILES])
  const oomKills = /^oom_kill (\d+)$/m.exec(cgroupFile('memory.events'))?.[1]
  if (oomKills === undefined) throw new Error('run-memory-pressure-bench: memory.events has no oom_kill counter')
  console.log(JSON.stringify({
    benchmark: `memory-pressure/${machine}`,
    limitMb: MEMORY_PRESSURE_MACHINES[machine] * 1024,
    // Heap limit Node derives from the cgroup for a process without an explicit `--max-old-space-size`.
    defaultNodeHeapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1024 ** 2),
    cgroupPeakMb: Math.round(Number(cgroupFile('memory.peak')) / 1024 ** 2),
    oomKills: Number(oomKills),
    files: MEMORY_PRESSURE_FILES,
    status,
  }))
  return status
}

/**
 * Build benchmark artifacts unconfined, then rerun this script inside a transient memory-limited scope.
 * @param root - Repository root.
 * @param machine - Modeled machine.
 * @returns The scoped benchmark exit status.
 * @throws If the host is not Linux or a build fails.
 */
export function runMemoryPressureBench(root: string, machine: MemoryPressureMachine): number {
  if (process.platform !== 'linux') {
    throw new Error('run-memory-pressure-bench: memory limits need Linux cgroup v2 and a systemd user manager')
  }
  buildCiBenchArtifacts(root)
  return run(root, memoryScopeCommand(machine, [
    ...pnpmCommand(), 'exec', 'tsx', 'scripts/run-memory-pressure-bench.ts', '--scoped', machine,
  ]))
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..')
  const args = process.argv.slice(2)
  process.exitCode = args[0] === '--scoped'
    ? runScopedMemoryPressureBench(root, memoryPressureMachine(args[1]))
    : runMemoryPressureBench(root, memoryPressureMachine(args[0]))
}
