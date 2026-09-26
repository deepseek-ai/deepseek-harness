/**
 * Process helpers shared by the release scripts: the release steps drive `git`,
 * `pnpm`, `npm`, and `tar`, and each needs one of three failure behaviours.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where and with what environment a release step runs a command. */
export interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

/** What a command produced, for a caller that decides what a failure means. */
export interface CommandResult {
  /** Exit status, or null when a signal ended the process. */
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run a command and capture its output without judging the exit status.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 * @returns The exit status and captured streams.
 */
export function attempt(command: string, args: readonly string[], options: RunOptions = {}): CommandResult {
  const result = spawnSync(command, [...args], { cwd: options.cwd, env: options.env, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run a command, then echo and return its captured output. Output is buffered
 * until exit and stdout precedes stderr.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 * @returns The exit status and captured streams.
 */
export function attemptEchoed(command: string, args: readonly string[], options: RunOptions = {}): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.stdout !== '') process.stdout.write(result.stdout)
  if (result.stderr !== '') process.stderr.write(result.stderr)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run a command, capture its standard output, and fail on a non-zero exit.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 * @returns The trimmed standard output.
 */
export function capture(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = attempt(command, args, options)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Run a command with inherited streams without blocking the event loop, so a
 * caller can hold several commands in flight, and fail on a non-zero exit.
 * Concurrent children interleave their output at line granularity.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 * @returns Resolves when the command exits with status zero.
 */
export function runConcurrent(command: string, args: readonly string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('close', (status, signal) => {
      if (status === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${String(status ?? signal)}`))
    })
  })
}

/**
 * Return whether Node started the given module as the process entry point.
 * @param moduleUrl - the caller's `import.meta.url`.
 * @returns True when Node started this module.
 */
export function isEntry(moduleUrl: string): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl))
}

/**
 * Resolve pnpm as a command prefix that spawns without a shell. On Windows the
 * `pnpm` shim is a `.cmd` batch file, which `spawnSync` refuses to run unless a
 * shell interprets it, so the prefix runs pnpm's JavaScript entry with the
 * current Node instead: the entry that launched this script when a run-script
 * did, or the workspace's own pnpm dependency otherwise. pnpm's manifest does
 * not export its bin entry, so the dependency is located on disk rather than
 * through module resolution.
 * @returns Command and leading arguments to prepend before pnpm's arguments.
 */
export function pnpmCommand(): readonly [command: string, ...args: string[]] {
  const execpath = process.env.npm_execpath
  // `npm run` and `yarn run` set this too, and handing pnpm's arguments to either would write a different lockfile.
  if (execpath !== undefined && /[\\/]pnpm[\\/]/u.test(execpath) && /\.[cm]?js$/u.test(execpath)) return [process.execPath, execpath]
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    const entry = join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(entry)) return [process.execPath, entry]
    if (dirname(directory) === directory) break
  }
  // Windows resolves a bare `pnpm` to a batch shim that spawnSync cannot start, so say that rather than fail later.
  if (process.platform === 'win32') {
    throw new Error('release: cannot locate pnpm\'s JavaScript entry; run this through a pnpm script or install workspace dependencies')
  }
  return ['pnpm']
}
