/**
 * Dialect-neutral vocabulary and log-only events shared by the Claude Code and
 * Codex hook bridges. Payload construction, matching differences, environment,
 * and extension-point-specific decision mapping remain owned by each bridge.
 * @module @deepseek-ai/dsh-hook-protocol/types
 */

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A hook command was invoked at a hook point — a log-only record (like
     * `compaction/*`; NOT a {@link SurfaceEventType}, carries no `surfaceOp`).
     * `dialect` is the bridge that ran it (`claude`/`codex`), `point`
     * the hook point (`PreToolUse`, `Stop`, …), `matcher` the matcher-group
     * pattern that selected it (absent for match-all), `handlerId` a stable id
     * for the command (so an invoked/result pair correlates). `turn` is the open
     * turn the invocation lives inside.
     */
    'hook/invoked': {
      turn: number
      point: string
      dialect: HookDialect
      matcher?: string
      handlerId: string
    }
    /**
     * Log-only outcome paired to `hook/invoked` by `handlerId`. Decision is the
     * parsed permission result, `stop` for `continue:false`, or `pass`; exit code
     * may be absent, stderr is bounded, and duration is wall-clock runtime.
     */
    'hook/result': {
      turn: number
      point: string
      handlerId: string
      decision: string
      exitCode?: number
      stderrSummary?: string
      durationMs: number
    }
  }
}

/**
 * The bridge that ran a hook — the CC bridge stamps `'claude-code'`, the Codex
 * bridge `'codex'`. A native plugin at the interception points is not a bridge
 * and writes no `hook/*` invocation/result records (see the interception extension-points Agent Note).
 */
export type HookDialect = 'claude-code' | 'codex'

/**
 * One configured command hook (the `{ type: 'command', command, timeout? }`
 * shape shared by both dialects). Non-command hook types (CC's `prompt`/`agent`/
 * `http`) are parsed-and-skipped by a bridge, so only this shape reaches the
 * runner.
 */
export interface CommandHook {
  /** The shell command line to run. */
  command: string
  /** Per-hook timeout in SECONDS (the wire unit); the runner converts to ms. */
  timeoutSec?: number
}

/**
 * One matcher group: a `matcher` pattern (absent / `''` / `'*'` = match-all)
 * plus the command hooks that run when it matches. Both dialects share this
 * shape (CC's `hooks.json` and Codex's `hooks.json`).
 */
export interface MatcherGroup {
  matcher?: string
  hooks: CommandHook[]
}

/**
 * How a matcher pattern is interpreted. Claude Code uses {@link literal} when the
 * pattern is purely `[A-Za-z0-9_|]+` (pipe = exact-match alternation) and
 * {@link regex} otherwise; Codex is always {@link regex}. The bridge picks the
 * mode for its dialect.
 */
export type MatcherMode = 'claude-code' | 'codex'

/**
 * The dialect-neutral OUTCOME a hook produced, parsed from its exit code +
 * stdout JSON + stderr by {@link parseHookOutput}. A bridge maps this onto a
 * extension-point-specific typed Decision (PreToolDecision, PreStepDecision, …). Every field
 * is OPTIONAL because a hook may exercise any subset; the bridge decides which
 * fields are meaningful for its hook point and which it ignores (faithful-but-
 * degraded — e.g. Codex ignores `allow`/`ask`).
 */
export interface HookOutput {
  /** The raw process exit code (`undefined` if the hook could not be run). */
  exitCode: number | undefined
  /** Trimmed stderr — the block-reason source on a blocking (exit 2) hook. */
  stderr: string
  /**
   * Trimmed stdout, verbatim. On a clean exit a hook may emit PLAIN (non-JSON)
   * stdout that the protocol renders as output (CC) or treats as
   * `additionalContext` (Codex SessionStart/UserPromptSubmit) — so the bridge
   * needs the raw text, not just the parsed structured fields. Empty string when
   * the hook produced no stdout.
   */
  stdout: string
  /**
   * `false` ⇒ the hook asked to halt (CC/Codex `continue:false`); pairs with
   * {@link stopReason}. `true`/absent ⇒ proceed.
   */
  continue?: boolean
  /** Human-readable reason shown when {@link continue} is `false`. */
  stopReason?: string
  /**
   * The neutral blocking decision a hook expressed, folded from the two channels
   * the reference protocols keep DISTINCT: the legacy top-level `decision`
   * (`approve`/`block` only) and `hookSpecificOutput.permissionDecision`
   * (`allow`/`deny`/`ask`). We normalize them to one enum — `'block'`/`'deny'`
   * forbid, `'approve'`/`'allow'` permit, `'ask'` requests confirmation — but
   * `'allow'`/`'deny'`/`'ask'` arise ONLY from a `permissionDecision`, never from
   * a top-level `decision` (an out-of-band `{"decision":"deny"}` is invalid and
   * ignored, matching the schemas). Absent ⇒ no explicit decision (exit code governs).
   */
  decision?: 'approve' | 'allow' | 'block' | 'deny' | 'ask'
  /** The reason/explanation accompanying {@link decision}. */
  reason?: string
  /**
   * Event discriminator claimed by `hookSpecificOutput`. On mismatch,
   * {@link parseHookOutput} preserves this value but discards event-scoped fields.
   */
  hookEventName?: string
  /** Extra context to inject for the next model request (CC `additionalContext`). */
  additionalContext?: string
  /** A warning surfaced to the user (CC `systemMessage`). */
  systemMessage?: string
  /**
   * A tool-input rewrite a hook requested (CC `updatedInput`). PARSED but NOT
   * honored — input rewrite is deferred (see the interception extension-points Agent Note); a
   * bridge logs + warns when this is present.
   */
  updatedInput?: Record<string, unknown>
}
