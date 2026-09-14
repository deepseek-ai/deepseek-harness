/** JSON callbacks between one workflow guest and its owning host run. */

import type { WorkflowAgentEndInfo, WorkflowAgentInfo } from '@deepseek-ai/dsh-workflow'
import type { ChildResult, ChildStartRequest, WorkerInit } from './types.ts'

/** The host-allocated reference to one published child. */
export interface StartedWorkflowChild {
  /** Per-run callback identifier, allocated by the host. */
  callId: number
  /** The subagent provider's published child identity. */
  childId: string
}

/** A callback addressing one child owned by this workflow run. */
export interface WorkflowChildRequest {
  /** Host-allocated callback identifier. */
  callId: number
}

/** Progress sent before the guest's terminal result. */
export type WorkflowProgress =
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent-start'; info: WorkflowAgentInfo }
  | { type: 'agent-end'; info: WorkflowAgentEndInfo }

/** Host functions exposed through the PTC runtime's JSON binding namespace. */
export interface WorkflowGuestHost {
  /**
   * Read the validated script and its inputs before execution.
   * @param input - Empty request object.
   * @returns Inputs for this workflow run.
   */
  begin(input: Record<string, never>): Promise<WorkerInit>
  /**
   * Publish a child through the configured subagent provider.
   * @param request - Prompt and validated script options.
   * @returns The host-allocated child reference.
   */
  startChild(request: ChildStartRequest): Promise<StartedWorkflowChild>
  /**
   * Observe a published child's terminal result.
   * @param request - The host-allocated child reference.
   * @returns The child's JSON result; infrastructure failures reject.
   */
  childResult(request: WorkflowChildRequest): Promise<ChildResult>
  /**
   * Join disposal of one published child.
   * @param request - The host-allocated child reference.
   * @returns Null after the host finishes disposal.
   */
  disposeChild(request: WorkflowChildRequest): Promise<null>
  /**
   * Publish an ordered batch of progress for this workflow run.
   * @param events - Script narration and child lifecycle data in emission order.
   * @returns Null after the host accepts every event.
   */
  progress(events: WorkflowProgress[]): Promise<null>
}
