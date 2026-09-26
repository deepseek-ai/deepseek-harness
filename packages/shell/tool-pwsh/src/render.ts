/**
 * Model-facing result rendering for the pwsh tool — the PowerShell twin of
 * `dsh-tool-bash`'s renderer: stdout, a marked stderr section, sandbox
 * denial/runner-failure markers (with the same-turn escalation hint), and
 * truncation notices with spill paths, then exit-status markers. Non-zero
 * exits are reported, not errored — the model decides how to react; only
 * infrastructure failures (spawn errors, aborts) surface as isError
 * results.
 *
 * @module @deepseek-ai/dsh-tool-pwsh/render
 */

import type { ShellSandboxInfo, CollectedOutput } from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'

/* jscpd:ignore-start -- deliberate twin of dsh-tool-bash/render.ts (Agent Note). */

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** The renderable foreground result shape (the schema-derived value, no `kind`). */
export interface RenderablePwshResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** The reason the command was stopped from outside the call, when a job kill ended it. */
  stopped?: string
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo
}

/**
 * Shape one finished run into the text the model sees: stdout, then a marked
 * stderr section, then exit-status markers, matching the bash tool's story —
 * a clean exit (0, no signal) produces no marker.
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - the escalation targets this composition advertises;
 *   non-empty adds the same-turn escalation hint after a denial marker
 *   (default `[]`: no hint).
 * @returns the model-facing text: output body (or `(no output)`), then any timeout/signal/exit markers, each on its own line.
 */
export function renderPwshResult(
  result: RenderablePwshResult,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers: string[] = []
  // Keep the exit marker last because parseExitStatus anchors there.
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    // Hint only when the composition exposes escalation, before the final exit marker.
    if (escalationModes.length > 0) {
      markers.push(escalationHintMarker('command'))
    }
  }
  // A command may trap the termination and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  // A kill from outside the call (the human stopping its job) is not a
  // command failure: the reason tells the model not to retry.
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Shape a foreground call that stopped waiting into the text the model sees:
 * the output captured so far (one consuming registry read taken at that
 * point, so `job_output` continues exactly after it), then the still-running
 * marker and the job hand-off guidance.
 * @param promoted - the promoted result value: the job id, the wait that
 *   expired, and the output so far.
 * @returns the model-facing text for a promoted call.
 */
export function renderPwshPromoted(promoted: { jobId: string; timeoutMs: number; output: string }): string {
  const body = promoted.output.length > 0
    ? promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`
    : ''
  return `${body}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\n`
    + 'The command keeps running in the background. You will be notified when it finishes; '
    + 'read newer output with job_output, stop it with job_kill.'
}

/**
 * Shape the one consuming registry read a foreground call embeds in its
 * result when it stops waiting: the output produced so far, plus the
 * dropped-output notice (naming the job's spill files) when the model cursor
 * fell behind the ring, and the sandbox notices. Later `job_output` reads
 * render the same ring through the job tools.
 * @param delta - the read's chunks as rendered text.
 * @param lossy - whether bytes before the delta were evicted unread.
 * @param spillPaths - the complete-stream files the job currently advertises.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderPwshJobRead(
  delta: string,
  lossy: boolean,
  spillPaths: readonly string[],
  sandbox?: ShellSandboxInfo,
  escalationModes: readonly SandboxMode[] = [],
): string {
  const notices: string[] = []
  if (lossy) {
    notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) {
      notices.push(escalationHintMarker('command'))
    }
  }
  if (notices.length === 0) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}
/* jscpd:ignore-end */
