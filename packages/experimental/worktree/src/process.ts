/** Cancellable commands under the calling Session's existing file policy, whose stdout is collected within a bound or streamed. */

import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {
  SubprocessCollect, SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputReader,
} from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { WorktreeError } from './error.ts'

/** Resolved process resource limits owned by the worktree service. */
export interface ProcessConfig {
  /** Deadline for one command, including executable lookup and confinement. */
  timeoutMs: number
  /** Termination grace period for each managed subprocess. */
  graceMs: number
  /** Maximum captured bytes per output stream. */
  maxOutputBytes: number
}

/** Clear inherited repository, attribute-tree, command-line configuration, and replacement-ref selectors. */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/**
 * Run an argv without a shell and await termination of its managed process range.
 * @param ctx - subprocess and sandbox providers in the same execution world.
 * @param config - complete process resource limits.
 * @param policy - unchanged calling Session policy.
 * @param cwd - canonical process working directory.
 * @param argv - executable followed by literal arguments.
 * @param signal - operation cancellation.
 * @param allowedExitCodes - command-specific successful statuses.
 * @param env - command-local environment overrides, applied after Git selector removal.
 * @returns complete bounded stdout and the exit code.
 * @throws {WorktreeError} `WORKTREE_COMMAND_FAILED`, `WORKTREE_OUTPUT_TOO_LARGE`, or `WORKTREE_TIMEOUT`;
 *   caller cancellation propagates its reason.
 */
export async function runCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
  allowedExitCodes: readonly number[] = [0],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; exitCode: number }> {
  using timeout = deadline(signal, config.timeoutMs, 'WORKTREE_TIMEOUT')
  return await classifyTimeout(config, timeout.signal, async () => {
    const child = await spawnCommand(ctx, config, policy, cwd, argv, timeout.signal, env, { maxBytes: config.maxOutputBytes })
    try {
      const outcome = await child.done
      timeout.signal.throwIfAborted()
      // The spawn spec above collects both streams.
      const captured = child.collected as Required<SubprocessCollectedOutputs>
      const exitCode = allowedExitCode(outcome, captured.stderr, allowedExitCodes)
      const stdout = captured.stdout.readFrom(0)
      if (stdout.lossy) throw new WorktreeError('worktree command output exceeds maxOutputBytes', 'WORKTREE_OUTPUT_TOO_LARGE')
      return { stdout: stdout.text, exitCode }
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  })
}

/**
 * Run an argv as {@link runCommand} does, but pass each NUL-terminated stdout
 * field to `onField` as it arrives instead of retaining the output, so the size
 * of stdout is unbounded and `maxOutputBytes` limits only stderr. An
 * unterminated remainder is ignored. A false return from `onField` terminates
 * the command, whose outcome is then not checked, even when the provider
 * rejects it for a launch cancelled before acknowledgement; otherwise only
 * status 0 succeeds.
 * @param ctx - subprocess and sandbox providers in the same execution world.
 * @param config - complete process resource limits.
 * @param policy - unchanged calling Session policy.
 * @param cwd - canonical process working directory.
 * @param argv - executable followed by literal arguments.
 * @param signal - operation cancellation.
 * @param onField - synchronous consumer of each field in order; false ends the command.
 * @returns true when `onField` ended the command, false when it exited successfully first.
 * @throws {WorktreeError} `WORKTREE_COMMAND_FAILED` or `WORKTREE_TIMEOUT`; caller cancellation propagates its reason.
 */
export async function scanCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
  onField: (field: string) => boolean,
): Promise<boolean> {
  using timeout = deadline(signal, config.timeoutMs, 'WORKTREE_TIMEOUT')
  return await classifyTimeout(config, timeout.signal, async () => {
    const child = await spawnCommand(ctx, config, policy, cwd, argv, timeout.signal, {}, 'pipe')
    try {
      // The spawn spec above pipes stdout and collects stderr.
      const stdout = child.stdout as Readable
      stdout.setEncoding('utf8')
      let pending = ''
      let stopped = false
      for await (const chunk of stdout as AsyncIterable<string>) {
        const fields = (pending + chunk).split('\0')
        pending = fields.splice(-1).join('')
        if (!fields.every(field => onField(field))) {
          stopped = true
          break
        }
      }
      if (stopped) {
        child.terminate()
        await Promise.allSettled([child.done])
        timeout.signal.throwIfAborted()
        return true
      }
      const outcome = await child.done
      timeout.signal.throwIfAborted()
      allowedExitCode(outcome, child.collected.stderr as SubprocessOutputReader, [0])
      return false
    } finally {
      child.terminate()
      await Promise.allSettled([child.done])
      await child.waitForExit()
    }
  })
}

/** Resolve, confine, and start one command whose stderr is collected within `maxOutputBytes`. */
async function spawnCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  stdout: 'pipe' | SubprocessCollect,
): Promise<SubprocessHandle> {
  signal.throwIfAborted()
  const program = await ctx.subprocess.resolveExecutable(argv[0], undefined, signal)
  const command = [program, ...argv.slice(1)]
  const wrapped = policy.mode === 'danger-full-access'
    ? command
    : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv
  signal.throwIfAborted()
  return ctx.subprocess.spawn({
    argv: wrapped,
    cwd,
    env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', ...env },
    signal,
    graceMs: config.graceMs,
    stdio: { stdin: 'ignore', stdout, stderr: { maxBytes: config.maxOutputBytes } },
  })
}

/**
 * The exit code of a command that exited with an allowed status.
 * @throws {WorktreeError} `WORKTREE_COMMAND_FAILED` when the command was signalled or exited with another status, quoting its stderr.
 */
function allowedExitCode(outcome: SubprocessOutcome, stderr: SubprocessOutputReader, allowedExitCodes: readonly number[]): number {
  if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
    throw new WorktreeError(`worktree command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.readFrom(0).text.trim()}`, 'WORKTREE_COMMAND_FAILED')
  }
  return outcome.exitCode
}

/** Run one command under a deadline, converting its elapsed deadline into `WORKTREE_TIMEOUT`. */
async function classifyTimeout<T>(config: ProcessConfig, signal: AbortSignal, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (timeoutOf(signal, 'WORKTREE_TIMEOUT') === undefined) throw error
    throw new WorktreeError(`worktree command exceeded ${config.timeoutMs}ms; inspect the repository before retrying`, 'WORKTREE_TIMEOUT', { cause: error })
  }
}
