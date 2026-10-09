/**
 * Append helpers for durable, log-only hook events. They carry no surface
 * intent and must remain turn-enclosed and invoked/result paired. Mid-turn hook
 * points satisfy that boundary; SessionStart records injected context instead
 * and does not append `hook/*` outside a turn.
 * @module @deepseek-ai/dsh-hook-protocol/events
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { HookDialect, HookOutput } from './types.ts'

/** What identifies a hook invocation across its invoked/result pair. */
export interface HookInvocation {
  /** The open turn the invocation lives inside. */
  turn: number
  /** The hook point (`PreToolUse`, `Stop`, …). */
  point: string
  /** The bridge dialect that ran it. */
  dialect: HookDialect
  /** A stable id correlating the invoked event with its result. */
  handlerId: string
  /** The matcher-group pattern; absent or `undefined` is omitted from the event. */
  matcher?: string | undefined
}

/** The decided outcome half of the pair. */
export interface HookResultRecord {
  turn: number
  point: string
  handlerId: string
  /**
   * The decoded outcome the run produced. {@link appendHookResult} derives the
   * durable `decision`/`exitCode`/`stderrSummary` fields from it, so the shared
   * event's semantics live here, in the lib that declares it, not per-bridge.
   */
  output: HookOutput
  /**
   * Character cap for the derived `stderrSummary`. The bound is the bridge's
   * to own (its `stderrSummaryMaxChars` config) and is passed in explicitly —
   * {@link DEFAULT_STDERR_SUMMARY_MAX_CHARS} is the reference default.
   */
  stderrSummaryMaxChars: number
  /** Wall-clock duration of the run (from `runHook`) — durable audit timing. */
  durationMs: number
}

/**
 * The reference default for {@link HookResultRecord.stderrSummaryMaxChars}
 * (both bridges' config default). It lives here, once, next to the truncation
 * rule it bounds, so the bridges cannot drift apart on the shared event's
 * default cap.
 */
export const DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500

/**
 * Truncate a hook's stderr for {@link HookResultRecord.stderrSummary}: trimmed,
 * `undefined` when empty, cut at `maxChars` with an ellipsis when over. The
 * bound is a parameter — like `runHook`'s `defaultTimeoutMs`, each bridge owns
 * the config default and passes it in.
 * @param stderr - the hook's raw captured stderr.
 * @param maxChars - the character cap for the summary (the bridge's config value).
 * @returns the trimmed, capped summary, or `undefined` when stderr is blank.
 */
export function summarizeStderr(stderr: string, maxChars: number): string | undefined {
  const t = stderr.trim()
  if (t.length === 0) return undefined
  return t.length > maxChars ? t.slice(0, maxChars) + '…' : t
}

/**
 * Append a `hook/invoked` event naming the handler and hook point to `session`.
 * @param session - the session whose open turn records the event.
 * @param invocation - the invocation identity; absent or `undefined` matchers are omitted from the payload.
 */
export function appendHookInvoked(session: Session, invocation: HookInvocation): void {
  session.append('hook/invoked', {
    turn: invocation.turn,
    point: invocation.point,
    dialect: invocation.dialect,
    handlerId: invocation.handlerId,
    ...invocation.matcher !== undefined ? { matcher: invocation.matcher } : {},
  })
}

/**
 * Append the durable result paired with `hook/invoked`. The recorded decision
 * is the parsed decision, then `stop` for `continue:false`, else `pass`; stderr
 * is trimmed and capped, and an absent process exit stays omitted.
 * @param session - the session whose open turn records the event.
 * @param record - the outcome to record: the decoded output plus the summary cap and duration.
 */
export function appendHookResult(session: Session, record: HookResultRecord): void {
  const { output } = record
  const stderrSummary = summarizeStderr(output.stderr, record.stderrSummaryMaxChars)
  session.append('hook/result', {
    turn: record.turn,
    point: record.point,
    handlerId: record.handlerId,
    decision: output.decision ?? (output.continue === false ? 'stop' : 'pass'),
    ...output.exitCode !== undefined ? { exitCode: output.exitCode } : {},
    ...stderrSummary !== undefined ? { stderrSummary } : {},
    durationMs: record.durationMs,
  })
}
