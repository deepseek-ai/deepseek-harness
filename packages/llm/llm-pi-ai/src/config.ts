/**
 * Configuration schema and provider-profile validation for the pi-ai adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider and the route set is structural.
 * A provider row configures one more route with the same profile fields,
 * written flat beside its route key.
 *
 * A route key is not required to name an installed pi-ai provider. When it does,
 * that provider's endpoint, protocol, display name, and model catalog are the
 * profile's defaults and the profile overrides them field by field; when it does
 * not, the profile is the whole provider declaration. Stored reads retain
 * catalog diagnostics beside serviceable models; writes validate every changed
 * provider before persistence. Self-contained profile constraints apply to both.
 *
 * @module dsh-llm-pi-ai/config
 */
import type { Volatile } from '@deepseek-ai/cordis'

import type { CacheRetention, ChatTemplateKwargValue, ModelThinkingLevel, Provider, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  CACHE_CONTROL_FORMATS,
  CHAT_TEMPLATE_VARS,
  MAX_TOKENS_FIELDS,
  MODALITIES,
  PiAiCatalogError,
  resolveRouteModels,
  SUPPORTED_THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_TOKEN_BUDGET_FIELDS,
} from './catalog.ts'
import type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiReasoningEfforts,
  RouteCatalog,
} from './catalog.ts'
import { buildProvider, supportedProtocols } from './provider.ts'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Default cap on aggregate base64 image payload, excluding text, tools, and
 * JSON overhead. Retained image count depends on actual encoded sizes;
 * per-image catalog targets do not raise this cap. Deployments keep it below
 * the gateway's complete request-size limit to leave room for other content.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/**
 * Default request-level bound on retained image occurrences: Azure OpenAI's
 * documented limit of 50 images per GPT-4o and GPT-4.1 request
 * (https://learn.microsoft.com/azure/foundry/openai/quotas-limits). Routes
 * whose provider accepts more images raise it.
 */
export const DEFAULT_MAX_REQUEST_IMAGES = 50
/**
 * Default number of oldest occurrences one count overflow offloads, so a
 * saturated route rewrites its request prefix once per ten new images rather
 * than once per image.
 */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 10
/** Number of equal image allocations used to derive the default hard per-image byte limit. */
export const DEFAULT_REQUEST_IMAGE_BUDGET_COUNT = 20
/** Default total-pixel budget preserves the complete 2048px normalized attachment. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Fallback hard per-image byte cap when the catalog declares none, before sharing the aggregate budget. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** Context capacity assumed for a model neither configuration nor the catalog sizes. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

/** Output capability assumed for a model neither configuration nor the catalog sizes. */
export const DEFAULT_MAX_TOKENS = 128_000

/**
 * Modalities assumed for a model neither configuration nor the catalog
 * declares. Text is the floor every supported protocol certainly carries, so
 * this is the absence of a declaration rather than a guess at the endpoint:
 * nothing can interrogate a gateway for its modalities, and the two wrong
 * answers do not cost the same. Under-claiming refuses the image before it is
 * attached, naming the model. Over-claiming admits one the provider then
 * rejects mid-turn, after the message is durable, leaving the session
 * repeating a request that cannot succeed.
 */
export const DEFAULT_INPUT: readonly PiAiModality[] = ['text']

export type {
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
} from './catalog.ts'

/** Configuration for one pi-ai provider route; the `providers` dict key IS the route. */
export interface PiAiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /**
   * Wire protocol every model on this route speaks. Omission keeps each
   * installed catalog model's own protocol, which is why a catalog route needs
   * no protocol at all; a route the catalog does not ship must name one.
   */
  api?: string
  /** Endpoint for this route's models; defaults to the installed catalog's endpoint. */
  baseURL?: string
  /**
   * This route's model catalog. Omission serves the installed catalog for the
   * route unchanged; an explicit list replaces it, each entry defaulting its
   * unset fields from the installed model of the same id.
   */
  models?: PiAiModelProfile[]
  /**
   * Installed-catalog customizations by model id: each entry reshapes that
   * one model with the same fields a {@link models} entry takes, while the
   * rest of the catalog keeps serving untouched. Only meaningful on a catalog
   * route with no `models` list — `models` already replaces the catalog, so
   * an override beside it, on a route the catalog does not ship, or naming a
   * model the catalog does not describe is refused rather than skipped.
   */
  modelOverrides?: Record<string, PiAiModelOverride>
  /**
   * pi-ai wire-compatibility switches defaulting every model on this route
   * whose protocol declares them; each model's own `compat` overrides per
   * field. What neither sets keeps the installed catalog entry's value, then
   * pi-ai's own detection. A switch no model on the route could read is
   * refused rather than left looking applied.
   */
  compat?: PiAiCompatProfile
  /**
   * Context capacity for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 1,000,000). A guess by construction, so
   * a deployment whose gateway serves smaller models corrects it here.
   */
  defaultContextWindow?: number
  /**
   * Output capability for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 128,000). This sizes the model; it
   * never becomes a per-request cap on its own.
   */
  defaultMaxTokens?: number
  /**
   * Request modalities for a model this route lists that neither its entry's
   * {@link PiAiModelProfile.input} nor the installed catalog declares (default
   * `[text]`). A fallback like the capacities above, not an override: a
   * catalog model keeps the modalities the catalog records for it, and this
   * value never narrows one. A gateway serving vision models the catalog does
   * not describe declares `[text, image]` once here instead of on every entry.
   * Unlike an entry's list, this one may not be empty — nothing sits below it
   * to answer instead.
   */
  defaultInput?: PiAiModality[]
  /** Provider request headers, validated against Fetch when the profile resolves; Harness attribution wins reserved names. */
  headers?: Record<string, string>
  /** Provider-neutral pi-ai reasoning level. */
  reasoning?: ModelThinkingLevel
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference. */
  cacheRetention?: CacheRetention
  /** Streaming transport preference. */
  transport?: Transport
  /** HTTP/provider SDK timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /**
   * Maximum base64-encoded image payload per request. When a request's
   * accumulated images exceed it, the oldest images are replaced by text
   * placeholders until the request fits, so a long session keeps completing
   * requests instead of being rejected by a request-size cap.
   */
  maxRequestImageBytes?: number
  /**
   * Maximum retained image occurrences per request. A request carrying more
   * fails with `IMAGE_OFFLOAD_REQUIRED` naming how many of the oldest
   * occurrences to offload.
   */
  maxRequestImages?: number
  /**
   * Oldest occurrences offloaded per count overflow (default 10, capped at
   * {@link maxRequestImages}); an explicit value must not exceed it. Larger
   * steps rewrite the request prefix less often.
   */
  imageOffloadCountQuantum?: number
  /** Fixed divisor of maxRequestImageBytes when allocating hard per-image budgets; independent of current image count. Default: 20. */
  requestImageBudgetCount?: number
  /** Total-pixel budget for each deterministic inline request version. */
  requestImagePixelBudget?: number
  /** Maximum width and height for each request image; omission uses the selected pi-ai model's resize limits. */
  requestImageMaxDimension?: number
  /**
   * Hard per-image encoded-byte cap overriding the selected model's base64 budget.
   * The effective cap is the smaller of this value and the route's equal share of maxRequestImageBytes.
   * Omission uses the catalog budget converted to raw bytes, or 1 MiB without catalog metadata.
   */
  requestImageMaxBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/** Validated profile with its route stamped and every adapter-owned default resolved. */
export interface ResolvedPiAiProviderProfile
  extends Omit<PiAiProviderProfile, 'apiKeyEnv' | 'retryPolicy' | 'models' | 'displayName' | 'requestImageMaxBytes'> {
  /** Harness route key and the `Models` collection key (the configuration dict key). */
  provider: string
  /** Resolved display name for selectors and configuration surfaces. */
  displayName: string
  /** Validated credential reference, when one is configured. */
  apiKeyEnv?: CredentialRef
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
  /** Positive request-level base64 image payload bound after defaulting. */
  maxRequestImageBytes: number
  /** Positive request-level retained image count bound after defaulting. */
  maxRequestImages: number
  /** Positive count-overflow offload step, at most {@link maxRequestImages}, after defaulting. */
  imageOffloadCountQuantum: number
  /** Positive fixed divisor of the aggregate image-byte budget after defaulting. */
  requestImageBudgetCount: number
  /** Positive total-pixel request-version budget after defaulting. */
  requestImagePixelBudget: number
  /** Configured hard per-image cap in raw encoded bytes, before the request budget is shared. */
  maxImageBytes?: number
  /** Immutable retry policy captured with this provider route. */
  retryPolicy: ResolvedRetryPolicy
  /**
   * The pi-ai provider containing this route's serviceable models. Absent when
   * a stored route cannot be constructed; its configuration remains editable.
   */
  piProvider?: Provider
  /** First model diagnostic, or the route failure when no model diagnostic is available. */
  catalogError?: string
  /** Per-model failures reported before attempting a request. */
  modelErrors: ReadonlyMap<string, string>
  /**
   * Per-request output caps this profile explicitly configured, by model id.
   * The seam materializes one only into a request that names no cap of its
   * own, so a catalog capability must not appear here.
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /**
   * pi-ai provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers: Volatile<Record<string, PiAiProviderProfile>>
}

/** Plain options accepted by the provider resolver. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never }

/**
 * Configuration of one provider row, written flat: the route key, then the fields of {@link PiAiProviderProfile}.
 * The plugin receives each profile field as a live reference that a configuration change updates in place; a
 * field the schema does not declare keeps its plain value.
 */
export type ProviderRowConfig = {
  /** Route key that a request selects with `GenerateOptions.provider`. Changing it restarts the row. */
  provider: string
} & { [Field in keyof PiAiProviderProfile]-?: Volatile<PiAiProviderProfile[Field]> }

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

/**
 * One `chat_template_kwargs` or `chat_template_args` value. The `$var` member
 * is pi-ai's placeholder for a value dispatch fills from the request's
 * thinking state, which makes a template-driven gateway configurable without
 * restating its template.
 */
const chatTemplateKwarg: z<ChatTemplateKwargValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.const(null),
  z.object({
    $var: z.union(CHAT_TEMPLATE_VARS).required(),
    omitWhenOff: z.boolean(),
  }),
])

const compatProfile: z<PiAiCompatProfile> = z.object({
  supportsStore: z.boolean(),
  supportsDeveloperRole: z.boolean(),
  supportsReasoningEffort: z.boolean(),
  supportsUsageInStreaming: z.boolean(),
  supportsFinishReason: z.boolean(),
  maxTokensField: z.union(MAX_TOKENS_FIELDS),
  requiresToolResultName: z.boolean(),
  requiresAssistantAfterToolResult: z.boolean(),
  requiresThinkingAsText: z.boolean(),
  requiresReasoningContentOnAssistantMessages: z.boolean(),
  thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
  chatTemplateKwargs: z.dict(chatTemplateKwarg),
  chatTemplateArgs: z.dict(chatTemplateKwarg),
  supportsThinkingTokenBudget: z.boolean(),
  thinkingTokenBudgetField: z.union(THINKING_TOKEN_BUDGET_FIELDS),
  vllmPriority: z.number().step(1),
  supportsMaxOutputTokens: z.boolean(),
  supportsStrictMode: z.boolean(),
  cacheControlFormat: z.union(CACHE_CONTROL_FORMATS),
  supportsLongCacheRetention: z.boolean(),
  supportsEagerToolInputStreaming: z.boolean(),
  supportsCacheControlOnTools: z.boolean(),
  supportsTemperature: z.boolean(),
  forceAdaptiveThinking: z.boolean(),
  allowEmptySignature: z.boolean(),
  supportsStrictTools: z.boolean(),
})

/**
 * Keys are the offered levels, values their wire spellings. A valueless key
 * (`off:`) survives validation because schemastery passes nullable data
 * through before any member schema runs — `z.const(null)` only controls the
 * error for non-null wrong values and what a configuration UI renders.
 * Only resolution decides which levels may leave the value empty, so the
 * diagnostic can name the route and model. The assertion narrows
 * schemastery's `Dict`, which types every literal key as required; dict
 * validation checks only present keys, so the runtime value is a partial record.
 */
const reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(THINKING_LEVELS),
) as unknown as z<PiAiReasoningEfforts>

/** The fields a `models` entry and a `modelOverrides` value share; only the id's home differs. */
const modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // No explicit default, unlike the route's `defaultInput`: schemastery
  // materializes `[]` for an absent array, and resolution reads that as "no
  // answer here" so the catalog entry below still applies.
  input: z.array(z.union(MODALITIES)),
  // The union, not a bare dict: schemastery materializes an absent dict as
  // `{}`, and absent must stay distinguishable — it means "inherit the
  // installed catalog's capability", while `false` disables reasoning.
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: compatProfile,
}

const modelProfile: z<PiAiModelProfile> = z.object({
  id: z.string().required(),
  ...modelFields,
})

/** A {@link modelProfile} whose id lives in the `modelOverrides` dict key. */
const modelOverride: z<PiAiModelOverride> = z.object(modelFields)

const profile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  api: z.union(supportedProtocols()),
  baseURL: z.string(),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
  compat: compatProfile,
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
  headers: z.dict(z.string()),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxRequestImages: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGES),
  imageOffloadCountQuantum: z.number().step(1).min(1),
  requestImageBudgetCount: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_IMAGE_BUDGET_COUNT),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxDimension: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  requestImageMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  retryPolicy: RetryPolicySchema,
})

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  providers: z.dict(profile).default({}).volatile(),
})

/** Field schemas of one route's profile, which an entry of the `providers` dict and a provider row share. */
const profileFields = profile.dict as Record<string, z>

/**
 * Runtime schema of one provider row, written flat: the route key in `provider`, then the profile fields of a
 * `providers` entry. A changed profile field updates the running route in place; a changed `provider` restarts
 * the row.
 */
export const ProviderConfig = z.object({
  provider: z.string().required(),
  ...Object.fromEntries(Object.entries(profileFields).map(([field, schema]) => [field, schema.volatile()])),
})

/**
 * Read the profile a provider row configures.
 * @param config - the row's parsed config.
 * @returns the profile fields that have a value, without the route key.
 */
export function rowProfile(config: ProviderRowConfig): PiAiProviderProfile {
  return Object.fromEntries(Object.entries(config).flatMap(([field, value]): [string, unknown][] => {
    if (field === 'provider') return []
    const current: unknown = Object.hasOwn(profileFields, field) ? (value as Volatile<unknown>).get() : value
    return current === undefined ? [] : [[field, current]]
  }))
}

/**
 * Reject new or changed provider profiles that cannot be served. Unchanged
 * stored profiles may need repair after a catalog upgrade and do not block
 * edits to another provider. Removed profiles require no catalog validation.
 * @param config - the resolved section to check.
 * @param previous - current resolved section; omission checks every provider.
 * @throws Error naming the route and configuration entry that cannot be served.
 */
export function assertServiceable(config: Options, previous?: Options): void {
  const changed = Object.fromEntries(Object.entries(config.providers ?? {}).filter(([provider, profile]) =>
    !deepEqualJson(profile, previous?.providers?.[provider])))
  resolveProfiles(changed)
}

/** Reject removed pre-release profile fields and name their replacements. */
function rejectRemovedFields(provider: string, source: PiAiProviderProfile): void {
  const legacy = source as PiAiProviderProfile & {
    provider?: unknown
    maxRetries?: unknown
    maxRetryDelayMs?: unknown
  }
  if ('provider' in legacy) {
    throw new Error(`llm-pi-ai: provider "${provider}" sets "provider", which moved to the providers dict key`)
  }
  if ('maxRetries' in legacy || 'maxRetryDelayMs' in legacy) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets maxRetries or maxRetryDelayMs, which were removed;`
      + ' compose agent recovery with dsh-llm-retry',
    )
  }
}

/** Reject a profile header that Fetch cannot put on a provider request. */
function assertValidHeaders(provider: string, headers: Readonly<Record<string, string>> | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]])
    } catch {
      throw new Error(
        `llm-pi-ai: provider "${provider}" header "${name}" is not valid for Fetch;`
        + ' use a valid HTTP field name and a single-line value representable as bytes',
      )
    }
  }
}

/**
 * Resolve scalar defaults and materialize each route's serviceable models.
 * Deferred catalog validation retains diagnostics without deleting configured
 * routes. An omitted dict resolves to the empty, dormant route set.
 * @param providers - configured provider profiles keyed by route.
 * @param validation - writes require a complete catalog; stored reads retain catalog diagnostics.
 * @returns validated profiles in configuration order.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>> | undefined,
  validation: 'strict' | 'deferred' = 'strict',
): Map<string, ResolvedPiAiProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const resolved = new Map<string, ResolvedPiAiProviderProfile>()
  for (const [provider, source] of entries) {
    rejectRemovedFields(provider, source)
    if ('imageTargetBytes' in source) {
      throw new Error('llm-pi-ai: imageTargetBytes is not configurable; pi uses the effective per-image cap as the target')
    }
    if ('maxImageBytes' in source) {
      throw new Error(`llm-pi-ai: provider "${provider}" must use requestImageMaxBytes to set the per-image cap; maxImageBytes is internal`)
    }
    if (provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty displayName`)
    }
    assertValidHeaders(provider, source.headers)
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const maxRequestImageBytes = source.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
    if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImageBytes must be a positive integer`)
    }
    const requestImageBudgetCount = source.requestImageBudgetCount ?? DEFAULT_REQUEST_IMAGE_BUDGET_COUNT
    if (!Number.isSafeInteger(requestImageBudgetCount) || requestImageBudgetCount <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImageBudgetCount must be a positive safe integer`)
    }
    if (requestImageBudgetCount > Math.floor(maxRequestImageBytes / 4)) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImageBytes must allow four base64 bytes per requestImageBudgetCount`)
    }
    const maxRequestImages = source.maxRequestImages ?? DEFAULT_MAX_REQUEST_IMAGES
    if (!Number.isSafeInteger(maxRequestImages) || maxRequestImages <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" maxRequestImages must be a positive safe integer`)
    }
    const imageOffloadCountQuantum = source.imageOffloadCountQuantum ?? Math.min(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM, maxRequestImages)
    if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0 || imageOffloadCountQuantum > maxRequestImages) {
      throw new Error(`llm-pi-ai: provider "${provider}" imageOffloadCountQuantum must be a positive safe integer no greater than maxRequestImages`)
    }
    const requestImagePixelBudget = source.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
    if (!Number.isSafeInteger(requestImagePixelBudget) || requestImagePixelBudget <= 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" requestImagePixelBudget must be a positive safe integer`)
    }
    for (const field of ['requestImageMaxDimension', 'requestImageMaxBytes'] as const) {
      const value = source[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`llm-pi-ai: provider "${provider}" ${field} must be a positive safe integer`)
      }
    }
    // Detached from the configuration object because pi-ai types `Model.input`
    // mutable. The schema's explicit default covers an absent key, so an empty
    // list here is always one someone typed — and unlike an entry's, nothing
    // below it can answer instead — so it is refused rather than read as "no
    // answer".
    const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT]
    if (defaultInput.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" defaultInput must name at least one modality`)
    }
    // The route key, not the installed provider's own name: the directory has
    // always shown route keys, and a catalog route must not silently rename
    // itself on every configuration surface just because it gained a profile.
    const displayName = source.displayName ?? provider
    let catalog: RouteCatalog | undefined
    let piProvider: Provider | undefined
    let catalogError: string | undefined
    try {
      catalog = resolveRouteModels({
        provider,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        ...source.models === undefined ? {} : { models: source.models },
        ...source.modelOverrides === undefined ? {} : { modelOverrides: source.modelOverrides },
        ...source.compat === undefined ? {} : { compat: source.compat },
        defaultInput,
        defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      }, validation)
      catalogError = catalog.modelErrors.values().next().value
      piProvider = buildProvider({
        provider,
        displayName,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        models: catalog.models,
        namesCredential: source.apiKeyEnv !== undefined,
      })
    } catch (error) {
      if (validation === 'strict' || !(error instanceof PiAiCatalogError)) throw error
      catalogError ??= error.message
    }
    const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, requestImageMaxBytes, ...rest } = source
    resolved.set(provider, {
      ...rest,
      ...requestImageMaxBytes === undefined ? {} : { maxImageBytes: requestImageMaxBytes },
      provider,
      displayName,
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      maxRequestImageBytes,
      maxRequestImages,
      imageOffloadCountQuantum,
      requestImagePixelBudget,
      requestImageBudgetCount,
      retryPolicy: resolveRetryPolicy(retryPolicy, `llm-pi-ai: provider "${provider}" retryPolicy`),
      ...rest.headers === undefined ? {} : { headers: { ...rest.headers } },
      ...rest.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
      configuredMaxTokens: catalog?.configuredMaxTokens ?? new Map(),
      modelErrors: catalog?.modelErrors ?? new Map(),
      ...piProvider === undefined ? {} : { piProvider },
      ...catalogError === undefined ? {} : { catalogError },
    })
  }
  return resolved
}
