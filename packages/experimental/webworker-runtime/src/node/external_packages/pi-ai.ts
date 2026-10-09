/**
 * `@earendil-works/pi-ai` stub, including its `/providers/all` and `/api/*.lazy`
 * subpaths. The package is Node-only (no `require`/`browser` conditions, Node
 * builtins plus five cloud SDKs in its transport layer) and `llm-pi-ai` imports it
 * statically at module scope, so the row cannot mount without it.
 *
 * Every symbol `llm-pi-ai` imports by name is present: a missing CommonJS symbol
 * would surface as `undefined` at call time instead of a link error. The row
 * reads the catalog while it activates, so the provider reader returns
 * providers without models and the two model readers return empty collections
 * instead of throwing: this deployment serves no pi-ai model. Everything on a
 * request path is loud.
 */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = '@earendil-works/pi-ai'

/** Provider factory (unavailable). */
export const createProvider = notImplementedFail(MODULE, 'createProvider')

/** Model-list factory (unavailable). */
export const createModels = notImplementedFail(MODULE, 'createModels')

/** Thinking-level catalog (unavailable). */
export const getSupportedThinkingLevels = notImplementedFail(MODULE, 'getSupportedThinkingLevels')

/** Context-overflow predicate (unavailable). */
export const isContextOverflow = notImplementedFail(MODULE, 'isContextOverflow')

/** Collection of every builtin provider (unavailable). */
export const builtinModels = notImplementedFail(MODULE, 'builtinModels')

/**
 * Builtin provider ids as pi-ai 0.84.2 listed them, in catalog order. The list
 * is a fixed copy that pi-ai upgrades do not regenerate, so it omits providers
 * added since.
 */
const BUILTIN_PROVIDER_IDS: readonly string[] = [
  'amazon-bedrock', 'ant-ling', 'anthropic', 'azure-openai-responses', 'baseten', 'cerebras',
  'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'deepseek', 'fireworks', 'github-copilot',
  'google', 'google-vertex', 'groq', 'huggingface', 'kimi-coding', 'minimax', 'minimax-cn',
  'mistral', 'moonshotai', 'moonshotai-cn', 'nvidia', 'openai', 'openai-codex', 'opencode',
  'opencode-go', 'openrouter', 'qwen-token-plan', 'qwen-token-plan-cn',
  'qwen-token-plan-individual', 'together',
  'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
]

/**
 * Installed catalog providers, read while `llm-pi-ai` activates. `llm-pi-ai`
 * registers the whole catalog as configurable the moment it mounts and rejects
 * an empty registration, so these carry pi-ai's ids instead of being an empty
 * list. Each has the api-key auth marker the adapter filters on, and no
 * models, so every request path lands on a loud symbol above.
 * @returns one entry per builtin provider.
 */
export function builtinProviders(): unknown[] {
  return BUILTIN_PROVIDER_IDS.map(id => ({
    id,
    name: id,
    auth: { apiKey: { type: 'api-key' } },
    models: [],
  }))
}

/**
 * Models of one installed catalog provider.
 * @returns no models.
 */
export function getBuiltinModels(): unknown[] {
  return []
}

/**
 * Models of every type of one installed catalog provider.
 * @returns no models.
 */
export function getAllBuiltinModels(): unknown[] {
  return []
}

/** Anthropic messages API binding (unavailable). */
export const anthropicMessagesApi = notImplementedFail(MODULE, 'anthropicMessagesApi')

/** OpenAI completions API binding (unavailable). */
export const openAICompletionsApi = notImplementedFail(MODULE, 'openAICompletionsApi')

/** OpenAI responses API binding (unavailable). */
export const openAIResponsesApi = notImplementedFail(MODULE, 'openAIResponsesApi')

/** CommonJS interop marker: the worker loader hands `default` to default imports. */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  createProvider, createModels, getSupportedThinkingLevels, isContextOverflow, builtinModels, builtinProviders,
  getBuiltinModels, getAllBuiltinModels, anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi,
}
