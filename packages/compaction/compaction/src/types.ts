/**
 * Compaction vocabulary: the result type and the `compaction/*` session events.
 * Those declaration-merged events record the lock and summary inputs without entering the surface, so they are not
 * surface events; a separate replacement `user/message` carries the summary.
 * Backend packages own configuration and retention policy; see
 * `.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md`.
 * @module @deepseek-ai/dsh-compaction/types
 */

import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CompactionId } from './brand.ts'

export type { CompactionId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Marks the start of a compaction — log-only, holds the lock until
     * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
     * `null` identifies a standalone manual transaction between turns.
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
    /**
     * Completed summary, its inputs, and its model call facts — log-only, no surfaceOp.
     * The summary content is in `data.summary`; the actual surface replacement
     * is performed by the immediately following `user/message` event that
     * shadows the compacted range. That adjacency is contractual — the
     * shadowed pricing fields are the replacement's shadow price, so a
     * consumer may pair a replacement with the metering event directly
     * before it (`compaction/prune` documents the shared protocol).
     */
    'compaction/summary': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      summary: ContentBlock[]
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      shadowedSeqs: SessionSeq[]
      shadowedTokenCount: number
      /** The provider route that wrote the summary. */
      provider: string
      /**
       * The model that wrote the summary — the summarize call's envelope,
       * reported by the backend that made the call, logged so the one-shot
       * request is reconstructable from log + code and "which model wrote
       * this summary" has a durable answer (the reconstructability Agent Note).
       */
      model: string
      /** The generation cap the summarize call sent, when one applied. */
      maxTokens?: number
      /** Provider-reported token usage for the summarization request, when emitted. */
      usage?: TokenUsage
    } & (
      | {
        /** Complete provider output before the backend's safe summary projection. */
        rawOutput: ContentBlock[]
        /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
        llmStreamCall: true
      }
      | {
        /** Optional complete output from an unmarked template, remote, or other summarizer. */
        rawOutput?: ContentBlock[]
        /** An unmarked summary does not identify a call through this context's LLM seam. */
        llmStreamCall?: never
      }
    )
    /**
     * Marks the end of a compaction — log-only, releases the lock. Its owner
     * matches `compaction/start`; `error` records an unsuccessful attempt.
     */
    'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string }
    /**
     * Shadow price of one model-free prune replacement — log-only, no
     * surfaceOp. The shared shadow-price protocol: a surface `replace` event
     * is priced by the metering event immediately before it (`compaction/summary`
     * for a summarizing compaction, this event for a prune), which states the
     * heuristic token price of the exact replaced range so a pure consumer
     * can subtract it without retaining per-node prices. The replacement MUST
     * be appended synchronously right after this event.
     */
    'compaction/prune': {
      /** The replaced range's first and last surface-node seqs (a surface-position span, like {@link CompactionResult.shadowedRange}). */
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      /** The seqs of all shadowed surface nodes, in surface order. */
      shadowedSeqs: SessionSeq[]
      /** Heuristic price of the shadowed content under the token-meter's fixed estimator. */
      shadowedTokenCount: number
    }
  }
}

/** Result of a successful compaction operation. */
export interface CompactionResult {
  /** Stable identity shared by this compaction's complete durable lifecycle. */
  compactionId: CompactionId
  /** Human command that initiated this compaction, when it was manual. */
  sourceCommandId?: CommandId
  /** The seq of the appended `compaction/start` event. */
  startSeq: SessionSeq
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: SessionSeq
  /** The seq of the appended `compaction/end` event. */
  endSeq: SessionSeq
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: SessionSeq[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
