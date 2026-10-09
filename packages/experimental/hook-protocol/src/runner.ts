/**
 * Execute command hooks through `ctx.shell`, using its credential scrub,
 * process-group cancellation, and timeout machinery. The bridge supplies the
 * trusted stdin payload and dialect environment, then this module decodes the
 * captured outcome.
 * @module @deepseek-ai/dsh-hook-protocol/runner
 */

import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { parseHookOutput } from './codec.ts'
import type { CommandHook, HookOutput } from './types.ts'

/**
 * The reference default per-hook timeout, in ms (10 minutes) — the value both
 * Claude Code and Codex apply to a hook whose config sets no `timeout`. It
 * lives here, once, as the protocol's default; the bridges' `defaultTimeoutMs`
 * config defaults to it, and a per-hook {@link CommandHook.timeoutSec} is the
 * override API.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

/** Everything a single hook invocation needs beyond its command line. */
export interface RunHookOptions {
  /** The JSON payload object written to the hook's stdin (the bridge builds it). */
  payload: unknown
  /** Extra env vars for the hook process (`CLAUDE_PROJECT_DIR`, …); the bridge builds these. */
  env?: Record<string, string>
  /** Working directory for the hook (defaults to the executor's own default when omitted). */
  cwd?: string
  /** Explicit owning-operation signal; firing it cancels the hook run. */
  readonly signal: AbortSignal
  /** Whether to append a trailing newline to the stdin payload (CC yes, Codex no). */
  trailingNewline: boolean
  /**
   * Timeout applied when the hook's config sets no `timeout` of its own. The
   * bridge owns the default (its `defaultTimeoutMs` config, reference default
   * {@link DEFAULT_HOOK_TIMEOUT_MS}) and passes it in explicitly.
   */
  defaultTimeoutMs: number
  /**
   * The event this hook is firing for (e.g. `'PreToolUse'`). When set, a
   * structured `hookSpecificOutput` block whose `hookEventName` names a DIFFERENT
   * event is treated as malformed and its event-scoped fields are discarded (see
   * {@link parseHookOutput}). Omit it to apply any block as-is.
   */
  expectedEventName?: string
}

/** The {@link HookOutput} plus the wall-clock duration of the run (for `hook/result`). */
export interface RunHookResult {
  output: HookOutput
  /** Wall-clock duration of the run, from `now` — durable on the `hook/result` event. */
  durationMs: number
}

/**
 * Run `hook` with serialized stdin and decode its outcome. A hook-specific
 * timeout in seconds overrides the default; trusted environment entries merge
 * after the executor scrub. Infrastructure rejection becomes an outcome with
 * no exit code, so this function never throws or crashes the calling turn.
 * @param bash - The executor service the command runs through.
 * @param hook - the configured command; its `timeoutSec` (wire unit: seconds) overrides the default timeout.
 * @param options - the invocation's payload, env, cwd, signal, stdin framing, and default timeout.
 * @param now - millisecond clock used for the reported duration.
 * @returns the decoded output plus the run's wall-clock duration.
 */
export async function runHook(
  bash: Pick<ShellExecutor, 'resolve' | 'execute'>,
  hook: CommandHook,
  options: RunHookOptions,
  now: () => number,
): Promise<RunHookResult> {
  const started = now()
  const timeoutMs = hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : options.defaultTimeoutMs
  const stdin = JSON.stringify(options.payload) + (options.trailingNewline ? '\n' : '')

  const request = {
    command: hook.command,
    timeoutMs,
    stdin,
    signal: options.signal,
    ...options.cwd !== undefined ? { workdir: options.cwd } : {},
    ...options.env !== undefined ? { env: options.env } : {},
  }

  try {
    const result = await (await bash.execute(bash.resolve(request))).result()
    // ShellRunResult.exitCode is `number | null` (null = died by signal); the
    // protocol's exit-code contract is numeric, so a signal death maps to
    // `undefined` (a non-blocking error — no clean exit code to act on).
    const exitCode = result.exitCode ?? undefined
    return {
      output: parseHookOutput(exitCode, result.stdout.text, result.stderr.text, options.expectedEventName),
      durationMs: now() - started,
    }
  } catch (error: unknown) {
    // The executor rejects only on infrastructure faults (unusable workdir,
    // missing shell). A hook that cannot run is a non-blocking error: no exit
    // code, the failure on stderr for the record. The turn proceeds.
    const message = error instanceof Error ? error.message : String(error)
    return {
      output: parseHookOutput(undefined, '', message),
      durationMs: now() - started,
    }
  }
}
