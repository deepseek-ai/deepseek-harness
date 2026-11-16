/** Runs the GitLab CLI on the host with a scrubbed, non-interactive environment that cannot redirect it to another host. */

import { tmpdir } from 'node:os'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { execa } from 'execa'

/** Complete output of one `glab` invocation that ran to an exit code. */
export interface GlabOutput {
  /** Process exit code. */
  readonly exitCode: number
  /** Standard output without its final newline. */
  readonly stdout: string
  /** Standard error without its final newline. */
  readonly stderr: string
}

/** Runs `glab` with literal arguments; rejects when the process cannot run to an exit code. */
export type GlabRunner = (args: readonly string[], signal: AbortSignal, input?: string) => Promise<GlabOutput>

/** Resolved executable and limits for `glab`. */
export interface GlabConfig {
  /** Executable name or absolute host path. */
  readonly glabCommand: string
  /** Deadline in milliseconds for one invocation. */
  readonly timeoutMs: number
  /** Maximum captured bytes per output stream. */
  readonly maxOutputBytes: number
}

/** Thrown when the `glab` executable cannot start, for example because it is not installed. */
export class GlabUnavailableError extends Error {
  override name = 'GlabUnavailableError'
}

/** Thrown when one invocation outlives `timeoutMs`; the process is killed. */
export class GlabTimeoutError extends Error {
  override name = 'GlabTimeoutError'
}

/** Thrown when an output stream exceeds `maxOutputBytes`; the process is killed. */
export class GlabOutputLimitError extends Error {
  override name = 'GlabOutputLimitError'
}

/**
 * Variables that make `glab` choose another host, repository, remote, or credentials than the `--hostname` and project
 * path each request names. Names that contain KEY, PASSWORD, SECRET, or TOKEN are already absent from the scrubbed
 * environment.
 */
const REDIRECTING = [
  'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GITLAB_API_HOST', 'GITLAB_REPO', 'GITLAB_GROUP', 'GITLAB_HEAD_REPO',
  'GLAB_REMOTE_ALIAS', 'GIT_REMOTE_URL_VAR', 'GIT_REMOTE_ALIAS', 'REMOTE_ALIAS', 'REMOTE_NICKNAME', 'GIT_REMOTE_NICKNAME',
  'GLAB_ENABLE_CI_AUTOLOGIN', 'GITLAB_CI',
]

/**
 * Build a runner for `glab` on the host. The child inherits the scrubbed parent environment without the variables that
 * redirect `glab` to another host or repository, so `glab` authenticates from its own credential store; it runs in the
 * temporary directory, so no checkout's remotes choose a host. Prompts, update checks, telemetry, pagers, and colors
 * are disabled.
 * @param config - executable and limits.
 * @returns the runner.
 */
export function glabRunner(config: GlabConfig): GlabRunner {
  return async (args, signal, input) => {
    const env = scrubbedParentEnv()
    for (const name of REDIRECTING) Reflect.deleteProperty(env, name)
    const result = await execa(config.glabCommand, args, {
      env: {
        ...env, GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false', GLAB_PAGER: 'cat',
        NO_COLOR: '1', GLAB_COLOR: 'never',
      },
      extendEnv: false,
      cwd: tmpdir(),
      ...input === undefined ? { stdin: 'ignore' as const } : { input },
      reject: false,
      timeout: config.timeoutMs,
      cancelSignal: signal,
      maxBuffer: config.maxOutputBytes,
      // A raw file read prints the file's bytes, whose final newline is content.
      stripFinalNewline: false,
    })
    const command = ['glab', ...args.slice(0, 1)].join(' ')
    if (result.isCanceled) throw signal.reason
    if (result.timedOut) throw new GlabTimeoutError(`${command} timed out after ${config.timeoutMs}ms`)
    if (result.isMaxBuffer) throw new GlabOutputLimitError(`${command} output exceeds maxOutputBytes`)
    // A result without an exit code failed before the process ran; execa then always sets shortMessage.
    if (result.exitCode === undefined) throw new GlabUnavailableError(`glab could not start: ${String(result.shortMessage)}`)
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}
