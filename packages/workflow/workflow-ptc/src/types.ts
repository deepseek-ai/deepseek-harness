/**
 * Workflow guest inputs and the child callbacks consumed by its VM helpers.
 * PTC transfers initialization data, requests and results as lossless JSON.
 * @module @deepseek-ai/dsh-workflow-ptc/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'

/**
 * Ordinary script limits enforced by the guest helpers.
 */
export interface WorkerLimits {
  /** Concurrent `agent()` ceiling (already auto-resolved; ≥ 1). */
  maxConcurrentAgents: number
  /** Total `agent()` calls per run (the runaway-loop backstop). */
  maxTotalAgents: number
  /** Items accepted by one `parallel()`/`pipeline()` call. */
  maxItemsPerCall: number
  /** VM timeout for the script's initial synchronous slice. */
  syncTimeoutMs: number
}

/** The initialization data returned by the host before the script runs. */
export interface WorkerInit {
  /** The validated meta block (plain data off the start request, validated host-side). */
  meta: WorkflowMeta
  /** The plain-JS script body, exactly as the start request carried it. */
  body: string
  /** The run's `args` value, copied through the PTC JSON channel. */
  args?: unknown
  /** The guest helper limits. */
  limits: WorkerLimits
}

/** One `agent()` child request after the guest validates script options. */
export interface ChildStartRequest {
  /** The child's prompt text. */
  prompt: string
  /** The structured-output schema, if the call passed one (already subset-checked). */
  schema?: ObjectJsonSchema
  /** The per-child provider override, if the call passed one. */
  provider?: string
  /** The per-child model override, if the call passed one. */
  model?: string
}

/**
 * The JSON projection of a child's `SubagentResult`. The
 * seam's `stopReason` union is merge-extensible, so it degrades to `string`
 * on the wire — the runtime only ever branches on `'completed'`.
 */
export interface ChildResult {
  /** The child's final assistant output blocks. */
  output: ContentBlock[]
  /** The structured value, present iff the request carried a schema AND the provider honored it. */
  structured?: unknown
  /** Why the child run ended (`'completed'` is the only value the runtime branches on). */
  stopReason: string
}

/**
 * The guest handle for one published child, reduced to what the VM helpers consume.
 */
export interface ChildHandle {
  /** The child agent's id (minted host-side by the subagent seam). */
  readonly id: string
  /**
   * Resolves with the child's terminal {@link ChildResult}; REJECTS only when
   * the host reports an infrastructure fault; a child that
   * failed for its own reasons resolves with a non-`completed` stop reason.
   */
  readonly result: Promise<ChildResult>
  /** Ask the host to dispose the child; resolves on the host's ack. */
  dispose(): Promise<void>
}

/**
 * Child callbacks independent of the PTC transport.
 */
export interface ChildPort {
  /**
   * Start one child agent on the host (the `agent()` hook's start half).
   * @param request - the prompt and validated options.
   * @returns the published child handle; rejects when synchronous start or the
   *   provider's asynchronous start fails.
   */
  startAgent(request: ChildStartRequest): Promise<ChildHandle>
}
