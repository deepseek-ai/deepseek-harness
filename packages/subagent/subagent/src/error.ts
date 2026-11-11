/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Every machine-routable subagent failure. Each code names one condition;
 * reuse one only when the consumer action is the same.
 */
export type SubagentErrorCode =
  /** A provider registration or a request needs a capability the selected backend lacks. */
  | 'UNSUPPORTED_CAPABILITY'
  /** A provider with the same name is already registered. */
  | 'DUPLICATE_PROVIDER'
  /** No subagent provider is registered under the requested name. */
  | 'NO_PROVIDER'
  /** The provider was removed or replaced while a delegation was starting; retry against the current registration. */
  | 'PROVIDER_CHANGED'
  /** A child preset was selected but the agent-presets service is absent. */
  | 'PRESET_UNAVAILABLE'
  /** The tool instance exposes no agent preset choice. */
  | 'PRESET_SELECTION_DISABLED'
  /** The selected agent preset is outside the tool's allowlist. */
  | 'PRESET_NOT_ALLOWED'
  /** The tool instance does not accept child model selection. */
  | 'MODEL_SELECTION_DISABLED'
  /** The Session's model-selection policy does not authorize the requested child provider or route. */
  | 'MODEL_ROUTE_NOT_ALLOWED'
  /** The requested LLM provider is not registered with the LLM runtime. */
  | 'LLM_PROVIDER_NOT_FOUND'
  /** The child's target model cannot accept image input. */
  | 'MODEL_DOES_NOT_SUPPORT_IMAGES'
  /** Starting the child would exceed the requested delegation depth; thrown as `SubagentDepthError`. */
  | 'DEPTH_EXCEEDED'
  /** A runtime delegation depth is not a non-negative safe integer. */
  | 'INVALID_DEPTH'
  /** An out-of-process child's working directory is relative or not enterable. */
  | 'INVALID_CWD'
  /** A local child cannot start because the working-directory service is absent. */
  | 'WORKING_DIRECTORY_UNAVAILABLE'
  /** The caller is not the exact live agent, or does not own the target in its subagent tree. */
  | 'UNAUTHORIZED'
  /** The tree's activation capacity is exhausted. */
  | 'ACTIVATION_LIMIT_REACHED'
  /** The target activation is closing. */
  | 'ACTIVATION_CLOSING'
  /** Releasing an activation's resources failed. */
  | 'ACTIVATION_TEARDOWN_FAILED'
  /** A child with the same Session id already exists. */
  | 'DUPLICATE_CHILD'
  /** The subagent tree is draining and admits no new work. */
  | 'DRAINING'
  /** The child accepts no more input after its structured result. */
  | 'INPUT_CLOSED'
  /** `structured_output` was called while accepted input is still pending. */
  | 'STRUCTURED_OUTPUT_PENDING_INPUT'
  /** The operation was cancelled by its caller. */
  | 'CANCELLED'
  /** A cold child cannot be restored from its persisted state. */
  | 'NOT_RESUMABLE'
  /** The child was not started as continuable and accepts no follow-up. */
  | 'NOT_CONTINUABLE'
  /** Continuation needs the agent runtime or a live tree root that is absent. */
  | 'CONTINUATION_UNAVAILABLE'
  /** Continuation needs Session persistence that is absent or failed. */
  | 'PERSISTENCE_UNAVAILABLE'
  /** A requested agent name does not satisfy the naming rule. */
  | 'INVALID_AGENT_NAME'
  /** A requested agent name is already used by a sibling. */
  | 'DUPLICATE_AGENT_NAME'
  /** An agent path names no member of the tree. */
  | 'AGENT_NAME_NOT_FOUND'
  /** Listing children needs the session-query service. */
  | 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE'
  /** Listing children needs the session-projection service. */
  | 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE'
  /** Listing children needs the Session store. */
  | 'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE'

/** Typed failure for the subagent seam; `code` is one {@link SubagentErrorCode}. */
export class SubagentError extends HarnessError {
  override readonly code: SubagentErrorCode

  /**
   * @param message - reason and next step for the caller.
   * @param code - failure class.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: SubagentErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
    this.code = code
  }
}
