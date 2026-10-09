/** Bounded, cancellable commands under the calling Session's existing file policy. */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'

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
  timeout.signal.throwIfAborted()
  const program = await ctx.subprocess.resolveExecutable(argv[0], undefined, timeout.signal)
  const command = [program, ...argv.slice(1)]
  const wrapped = policy.mode === 'danger-full-access'
    ? command
    : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, timeout.signal)).argv
  timeout.signal.throwIfAborted()
  const child = ctx.subprocess.spawn({
    argv: wrapped,
    cwd,
    env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...env },
    signal: timeout.signal,
    graceMs: config.graceMs,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
  })
  try {
    const outcome = await child.done
    timeout.signal.throwIfAborted()
    // The spawn spec above collects both streams.
    const captured = child.collected as Required<SubprocessCollectedOutputs>
    const stdout = captured.stdout.readFrom(0)
    const stderr = captured.stderr.readFrom(0)
    if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
      throw new Error(`worktree command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim()}`)
    }
    if (stdout.lossy) throw new Error('worktree command output exceeds maxOutputBytes')
    return { stdout: stdout.text, exitCode: outcome.exitCode }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}
