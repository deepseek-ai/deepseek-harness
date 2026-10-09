/** pi-ai model helpers assembled from public narrow entry points. */

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type {
  Api,
  CreateModelsOptions,
  Model,
  ModelThinkingLevel,
  MutableModels,
  Provider,
  ProviderAuth,
  ProviderStreams,
} from '@earendil-works/pi-ai'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { THINKING_LEVELS } from './catalog.ts'

/** Input accepted by the static, single-protocol providers this package builds. */
interface StaticProviderOptions {
  id: string
  name: string
  baseUrl?: string
  auth: ProviderAuth
  models: readonly Model<Api>[]
  api: ProviderStreams
}

/**
 * Create an empty pi-ai collection without importing its aggregate entry point.
 * @param options - credential storage and ambient authentication integrations.
 * @returns a mutable collection with no registered providers.
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
  const models = builtinModels(options)
  models.clearProviders()
  return models
}

/**
 * Create the static, single-protocol provider used by configured custom routes.
 * @param input - provider identity, models, authentication, and protocol implementation.
 * @returns a provider that delegates each operation to the supplied protocol.
 */
export function createProvider(input: StaticProviderOptions): Provider {
  return {
    id: input.id,
    name: input.name,
    ...input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl },
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, context, options) => input.api.stream(model, context, options),
    streamSimple: (model, context, options) => input.api.streamSimple(model, context, options),
  }
}

/**
 * Resolve selectable reasoning levels from pi-ai's public model metadata.
 * @param model - model descriptor carrying reasoning support and wire mappings.
 * @returns supported levels in pi-ai's escalation order.
 */
export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * Resolve transcript update modes from the exact model's protocol capabilities.
 * @param model - Materialized pi-ai model, including catalog compatibility flags.
 * @returns Update modes consumed by prompt admission and tool-history projection.
 */
export function conversationUpdates(model: Model<Api>): Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'toolUpdate'> {
  const compat = model.compat
  if (compat === undefined || !('supportsMidConvoSystemMessages' in compat)
    || !compat.supportsMidConvoSystemMessages) return {}
  const updates: Pick<LlmResolvedModelInfo, 'systemPromptUpdate' | 'toolUpdate'> = { systemPromptUpdate: 'in-history' }
  if (model.api === 'anthropic-messages'
    && 'supportsMidConvoToolChanges' in compat && compat.supportsMidConvoToolChanges) {
    updates.toolUpdate = 'in-history'
  } else if (model.api === 'openai-completions'
    && 'supportsMidConvoToolAdditions' in compat && compat.supportsMidConvoToolAdditions) {
    updates.toolUpdate = 'addition-only'
  } else if ((model.api === 'openai-responses' || model.api === 'azure-openai-responses' || model.api === 'openai-codex-responses')
    && (('supportsAdditionalTools' in compat && compat.supportsAdditionalTools)
      || ('supportsToolSearch' in compat && compat.supportsToolSearch))) {
    updates.toolUpdate = 'addition-only'
  }
  return updates
}
