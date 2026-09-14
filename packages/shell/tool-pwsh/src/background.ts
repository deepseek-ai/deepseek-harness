/**
 * Generic-task adaptation for background pwsh process handles — the shell-agnostic
 * twin of `dsh-tool-bash`'s background adaptation.
 *
 * @module @deepseek-ai/dsh-tool-pwsh/background
 */

import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'

/* jscpd:ignore-start -- deliberate twin of dsh-tool-bash/background.ts (Agent Note). */

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc: ShellProcess): { status: 'completed' | 'killed'; detail: string } {
  // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
  // infrastructure-failure outcome, then map spawn failures and
  // sandbox.runnerFailed to task `failed`. The current contract aliases a spawn
  // failure with a signal-less kill and a runner failure with an ordinary
  // wrapper exit; real nonzero command exits must remain `completed`.
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a partial process.
 * @param start - starts the process with job-owned cancellation.
 * @param renderOutput - consumes output from a published process.
 * @returns synchronous job hooks whose completion includes preparation and process settlement.
 */
export function processJob(
  start: (signal: AbortSignal) => Promise<ShellProcess>,
  renderOutput: (process: ShellProcess) => string,
): JobHooks {
  const controller = new AbortController()
  let process: ShellProcess | undefined
  const done: Promise<JobOutcome> = (async () => {
    try {
      process = await start(controller.signal)
      try {
        if (controller.signal.aborted) process.kill()
      } finally {
        await process.done
      }
      return processOutcome(process)
    } catch (error: unknown) {
      return {
        status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      process?.kill()
    },
    done,
    readOutput: () => process === undefined ? '' : renderOutput(process),
  }
}
/* jscpd:ignore-end */
