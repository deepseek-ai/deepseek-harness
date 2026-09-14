/**
 * Workflow seam vocabulary: the request/run/result types a workflow engine
 * consumes and produces, plus the fields in the `workflow/*` event payloads.
 * Types only (plus the id-brand factory), per the package convention.
 *
 * @module @deepseek-ai/dsh-workflow/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one workflow run. */
export type WorkflowRunId = Branded<'WorkflowRunId'>

/**
 * Brand a string as a {@link WorkflowRunId}.
 * @param id - the raw id string (the engine mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId
}

/**
 * One phase declared in a script's `meta.phases` (progress vocabulary only —
 * phases group agents in observers/UIs; they impose no execution structure).
 */
export interface WorkflowPhase {
  /** The phase title; `phase()` calls match against it by exact string. */
  title: string
  /** Optional one-line description of what the phase does. */
  detail?: string
  /** Optional provider override this phase is expected to use (informational). */
  provider?: string
  /** Optional model override this phase is expected to use (informational). */
  model?: string
}

/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
export interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}

/**
 * Why a run settled. CLOSED union (engine-owned, consumers may exhaust):
 * `completed` = the script ran to its final `return`; `cancelled` = the run
 * was cancelled (caller `cancel()`/signal); `error` = the script threw, a
 * fatal `WorkflowError` propagated, or the result failed materialization.
 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
export interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (cancellation or
   * process failure) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}

/** Identifying detail for a run, carried by every `workflow/*` event as borrowed immutable data, never the live run. */
export interface WorkflowRunInfo {
  /** The run's id. */
  id: WorkflowRunId
  /** The run's validated meta block. */
  meta: WorkflowMeta
}

/** One `agent()` call's identity within a run (the `workflow/agent-start` payload). */
export interface WorkflowAgentInfo {
  /** 1-based sequence number of this `agent()` call within the run. */
  seq: number
  /** The display label (the `label` option, or a prompt snippet). */
  label: string
  /** The phase this agent belongs to (the `phase` option, else the current `phase()` title). */
  phase?: string
  /** The child agent's id on the subagent seam. */
  childId: SessionId
}

/** How one `agent()` call settled: clean result, child failure (script sees `null`), or run cancellation. */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** One `agent()` call's settlement (the `workflow/agent-end` payload). */
export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  /** How the call settled. */
  outcome: WorkflowAgentOutcome
}

/**
 * A settled run's outcome as event data (the `workflow/end` payload): the
 * {@link WorkflowResult} minus `value` (a listener observing outcomes must not
 * receive a mutable alias of the caller's result value; a consumer that needs
 * the value holds the run and awaits `result`).
 */
export interface WorkflowResultInfo {
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /** How many `agent()` calls the run accepted (see {@link WorkflowResult.agentsStarted}). */
  agentsStarted: number
}
