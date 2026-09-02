/**
 * Compaction Service Definition (`ctx.compaction`): providers decide when to
 * compact and replace a history range with one summary node by subclassing
 * {@link CompactionEngine}. This interface necessarily depends on session and LLM
 * vocabulary; the rationale is in the
 * [compaction Agent Note](../../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).
 * @module @deepseek-ai/dsh-compaction
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { CompactionResult } from './types.ts'

export type { CompactionResult } from './types.ts'
export { CompactionId } from './brand.ts'
export { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'
// The checkpoint source constructor and predicate are declared on the cordis-free
// `./checkpoint` leaf so client and wire programs can name them without this
// root's Context merge; the root stays the host-side entry point for both.
export { compactCheckpointSource, isCompactCheckpointSource } from './checkpoint.ts'
export type { CompactionCheckpointSource } from './checkpoint.ts'

/** Why automatic policy is asking a backend to consider compaction. */
export type CompactionTrigger = 'pressure' | 'context-overflow'

/** Expected failure classes for an explicit idle-session compaction request. */
export type ManualCompactionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'changed'
  | 'summary'
  | 'commit'
  | 'persistence'

/**
 * Expected manual-compaction failure suitable for a direct human-command result.
 * Shared durable-lock entry assertions may also throw the `busy` subtype from
 * automatic compaction paths.
 */
export class ManualCompactionError extends Error {
  override readonly name = 'ManualCompactionError'

  /**
   * Create one classified compaction failure.
   * @param code - stable failure class; `busy` may originate from any compaction entry path.
   * @param message - backend diagnostic retained as the Error message.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: ManualCompactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Minimal agent context compaction needs without depending on the agent package. */
export interface CompactionAgentContext {
  session: Session
  options: { provider?: string; model?: string }
}

/**
 * Agent capability required to serialize an explicit idle-session compaction
 * against driver turns. The durable `compaction/start` marker separately excludes
 * other compaction transactions.
 */
export interface ManualCompactAgentContext extends CompactionAgentContext {
  /**
   * Run a non-turn maintenance operation only while the agent is idle, withholding later
   * waking input until it settles.
   * @param task - operation whose fulfillment or rejection is preserved, with an agent-owned cancellation signal.
   * @throws synchronously when the agent is already active.
   * @returns the task promise.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    compaction: CompactionEngine
  }
}

/**
 * Abstract compaction service. Implementations own trigger policy, retention,
 * and summarization, and may consume a separate measurement service. A
 * successful run replaces the selected surface span with one summary node and
 * prevents concurrent compaction of the same session. The replacement user
 * message uses {@link compactCheckpointSource} with the transaction identity
 * so consumers recognize and correlate it independently of the backend. Load
 * one implementation per context as `ctx.compaction`.
 */
export abstract class CompactionEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compaction')
  }

  /**
   * Consider automatic compaction for one explicit trigger. Pressure policy
   * uses the latest durable routed request, while context-overflow policy may
   * force a useful balanced reduction even below the normal threshold. Return
   * `null` when no safe range can be compacted. A single oversized retained
   * unit or request envelope cannot be repaired through surface compaction.
   *
   * @param agent - agent context owning the session surface and routing options.
   * @param trigger - normal pressure or provider-confirmed context overflow.
   * @param signal - cancellation signal; model-backed implementations must forward it.
   * @returns the compaction result, or `null` if no compaction was needed.
   */
  abstract compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * Explicitly compact useful history even below automatic pressure thresholds.
   * Implementations synchronously start an idle task before any asynchronous
   * work, select a useful range without writing on a no-op, then
   * append a standalone `compaction/start` before summarization. That durable
   * marker is the compaction lock until one `compaction/end` attempt. Later waking
   * prompts remain accepted in FIFO order and start only after the optional
   * durability checkpoint and idle-task settlement. Context injected while the
   * summary runs may sit between the marker pair; only the selected span must
   * remain stable.
   *
   * @param agent - idle agent whose durable history should be compacted.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for a manual compaction.
   * @returns the compaction result, or `null` when no safe useful range exists.
   * @throws {@link ManualCompactionError} for expected busy, agent-cancellation,
   * changed-span, summarization/shrink, commit-stage, or persistence failures;
   * an aborted request preserves its exact abort reason. Failed attempts remain
   * visible in the log.
   */
  abstract compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null>

  /**
   * Forcibly compact a range of surface nodes into a single summary node.
   * `start` and `end` name an inclusive span by surface position, not numeric seq
   * order; replacements can make visible seqs non-monotonic. Both edges must be
   * balanced so assistant tool calls remain paired with their results. A model-
   * backed implementation forwards cancellation and rejects active, missing,
   * reversed, or unbalanced ranges. The target session is `agent.session`.
   * Its replacement user message must use {@link compactCheckpointSource} with
   * the transaction's `CompactionId`.
   * Use {@link toolPairingBalancedBefore} and {@link toolPairingBalancedAfter}
   * for the edge checks.
   *
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param agent - context whose session is mutated and whose routing options guide summarization.
   * @param signal - optional cancellation; model-backed implementations must forward it.
   * @throws when compaction is active or the range is missing, reversed, or unbalanced.
   * @returns the appended event seqs, summary, replaced range, and token accounting.
   */
  abstract compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

export default CompactionEngine
