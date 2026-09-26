/**
 * Generic-job adaptation for bash process handles: the terminal outcome the
 * registry records, the pull sources it pumps, and the ring read a foreground
 * call renders when it stops waiting.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ShellProcess, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import type { JobChunk, JobHooks, JobOutcome, JobOutputSource } from '@deepseek-ai/dsh-jobs'

/**
 * Sandbox facts worth the terminal detail: a runner that never ran the
 * command, or a denial (with the escalation hint this composition offers).
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the markers to append, oldest first.
 */
function sandboxNotes(sandbox: ShellSandboxInfo | undefined, escalationModes: readonly SandboxMode[]): string[] {
  if (sandbox?.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  return []
}

/**
 * Map a settled background process onto the generic job-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering. Sandbox facts
 * join the detail, since a job's terminal reason is the one line every
 * reader — the model's status line, the roster row — shows.
 * @param proc - the settled process handle.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc: ShellProcess, escalationModes: readonly SandboxMode[] = []): JobOutcome {
  // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
  // infrastructure-failure outcome, then map it to job `failed`. Restricted
  // runner failures expose sandbox.runnerFailed, but unconfined spawn failures
  // still alias a signal-less kill; real nonzero command exits must remain
  // `completed`.
  const base: JobOutcome = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/**
 * The process's non-consuming stream readers as registry pull sources. They
 * bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job; a read before the spawn yields nothing, and the
 * pump keeps the model's consuming cursor untouched. A rejected spawn's
 * stderr reader carries the provider's `subprocess failed before reporting an
 * outcome: …` note.
 * @param proc - the started process's observed streams, once the starter has spawned it.
 * @returns one source per stream, stdout first.
 */
export function processSources(proc: () => Pick<ShellProcess, 'observed'> | undefined): JobOutputSource[] {
  const source = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte) => {
      const live = proc()
      return live === undefined ? { text: '', nextOffset: fromByte, lossy: false } : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * The ring chunks of one consuming registry read as the shell tools render a
 * process read: stdout chunks in order, then every stderr chunk in one
 * `[stderr]` section, so the output a foreground call hands over when it
 * stops waiting reads exactly like the `job_output` reads that follow it.
 * @param chunks - the chunks since the model cursor, in offset order.
 * @returns the delta text, possibly empty.
 */
export function ringDelta(chunks: readonly JobChunk[]): string {
  const out = chunks.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
  const err = chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a partial process.
 * @param start - starts the process with job-owned cancellation.
 * @param outcome - projects the settled process into the job outcome.
 * @returns synchronous job hooks whose completion includes preparation and process settlement.
 */
export function processJob(
  start: (signal: AbortSignal) => Promise<ShellProcess>,
  outcome: (process: ShellProcess) => JobOutcome,
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
      return outcome(process)
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
  }
}
