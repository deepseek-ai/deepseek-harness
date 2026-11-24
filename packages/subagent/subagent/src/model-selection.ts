/** Model selection resolved before a local child is created or restored. */

import type { AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContinuableSubagentDescriptorData } from './descriptor.ts'
import { SubagentError } from './error.ts'

/**
 * Require the complete initial selection before publishing a child.
 * @param options - resolved child options captured from its creator and explicit overrides.
 * @returns the detached model selection, excluding activation controls.
 * @throws {SubagentError} with MODEL_UNAVAILABLE when the provider or model is absent.
 */
export function requireInitialModel(options: AgentOptions): ModelSelection {
  const { provider, model, reasoningEffort } = options
  if (!provider || !model) {
    throw new SubagentError(
      'subagent startup requires a provider and model; select both before creating a child',
      'MODEL_UNAVAILABLE',
    )
  }
  return { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
}

/**
 * Build the Agent options for restoring a saved child. The restored Agent reads
 * its recorded choice from the child's own log first; a historical descriptor
 * route applies only when that log records neither a choice nor a request.
 * @param descriptor - continuable descriptor from the child's own log.
 * @param recorded - the observed log's next choice, or none.
 * @param selecting - choice a maintenance restore is about to record; it supplies the route only when neither source has one.
 * @returns Agent options carrying the descriptor's historical route or the selecting choice, if any.
 * @throws {SubagentError} with NOT_RESUMABLE when no source supplies a complete model.
 */
export function restorationOptions(
  descriptor: ContinuableSubagentDescriptorData,
  recorded: ModelSelection | null | undefined,
  selecting?: ModelSelection,
): AgentOptions {
  const { agentProvider: provider, agentModel: model, agentReasoningEffort: reasoningEffort } = descriptor
  if (recorded == null && (!provider || !model)) {
    if (selecting !== undefined) return { ...selecting }
    throw new SubagentError(
      'subagent has no complete saved model selection and cannot be resumed; select its model or create a new child',
      'NOT_RESUMABLE',
    )
  }
  return {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}
