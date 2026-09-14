/** Plugin configuration and complete request-local resolution for DeepSeek. */
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions, DeepSeekProtocol } from './common/types.ts'
import { DEFAULT_MODELS } from './common/models.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES, DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM, DEFAULT_FILE_EXPIRY_SECONDS, DEFAULT_FILE_REFRESH_MARGIN_SECONDS, DEFAULT_FILE_QUOTA_CLEANUP_BATCH, DEFAULT_FILES_API_TIMEOUT_MS } from './common/defaults.ts'
import { DEFAULT_MAX_IMAGES_PER_REQUEST, DEFAULT_MAX_REQUEST_FILES_BYTES, DEFAULT_REQUEST_IMAGE_MAX_BYTES } from './common/request-pricing.ts'

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-deepseek` settings-section shape. Every field is optional in
 * yml: a missing API key resolves through {@link Config.apiKeyEnv} at each
 * request (a request without any key fails with `MISSING_CREDENTIAL`, not at
 * plugin load), omitted thinking mode uses the provider default, and omitted
 * reasoning effort resolves to `high`.
 */
export interface Config {
  /** Wire protocol; defaults to messages. Configure through Cordis YAML. */
  protocol?: DeepSeekProtocol
  /** Credential reference (environment-variable name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap (default 256,000); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to V41 Flash, V4 Flash, V4 Pro, and V4 Flash Vision Exp. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated file-referenced image bytes per chat request (default 128 MiB). */
  maxRequestFilesBytes?: number
  /** Maximum accumulated base64 image payload after Files API fallback (default 20 MiB). */
  maxInlineRequestImageBytes?: number
  /** Maximum number of represented images per chat request (default 600). */
  maxImagesPerRequest?: number
  /** Raw-byte removal step after the request exceeds its file bound (default 64 MiB). */
  imageOffloadByteQuantum?: number
  /** Base64-byte removal step after inline fallback exceeds its bound (default 10 MiB). */
  inlineImageOffloadByteQuantum?: number
  /** Image-count removal step after the request exceeds its count bound (default 20). */
  imageOffloadCountQuantum?: number
  /** Maximum duration of one request-image Files API resolution (default one minute). */
  filesApiTimeoutMs?: number
  /** Explicit lifetime assigned to each uploaded image (default seven days). */
  fileExpiresAfterSeconds?: number
  /** Remaining lifetime below which an indexed file is replaced (default one hour). */
  fileRefreshMarginSeconds?: number
  /** Oldest harness-owned files deleted before one quota-recovery upload retry (default 100). */
  fileQuotaCleanupBatch?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  imagePixelBudget: z.union([z.number().step(1).min(1), 'low']),
  imageMaxBytes: z.number().step(1).min(1),
  systemPromptUpdate: z.const('in-history'),
})

export const Config: z<Config> = z.object({
  protocol: z.union(['chat-completions', 'messages']).default('messages'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestFilesBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_FILES_BYTES),
  maxInlineRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES),
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST),
  imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM),
  inlineImageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM),
  imageOffloadCountQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM),
  filesApiTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FILES_API_TIMEOUT_MS),
  fileExpiresAfterSeconds: z.number().step(1).min(3_600).max(2_592_000).default(DEFAULT_FILE_EXPIRY_SECONDS),
  fileRefreshMarginSeconds: z.number().step(1).min(0).default(DEFAULT_FILE_REFRESH_MARGIN_SECONDS),
  fileQuotaCleanupBatch: z.number().step(1).min(1).max(1_000).default(DEFAULT_FILE_QUOTA_CLEANUP_BATCH),
  retryPolicy: RetryPolicySchema,
})

/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** Official Messages protocol root. */
export const MESSAGES_BASE_URL = 'https://api.deepseek.com/anthropic'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/**
 * One resolution's complete request facts. Connection and credential facts
 * are one value on purpose: a snapshot the resolver rejects keeps the whole
 * previous generation, so a request can never pair a stale endpoint with a
 * newer key.
 */
export type ResolvedDeepSeekOptions = DeepSeekConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly DeepSeekCatalogModel[] | undefined): DeepSeekCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (Object.hasOwn(model, 'imageDetail')) {
      throw new Error('llm-deepseek: catalog model imageDetail is no longer supported; use imagePixelBudget')
    }
    if (model.id.length === 0) throw new Error('llm-deepseek: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    const hasImage = inputModalities.includes('image')
    if (!hasImage && (model.imagePixelBudget !== undefined || model.imageMaxBytes !== undefined)) {
      throw new Error(`llm-deepseek: text-only catalog model "${model.id}" cannot declare image request limits`)
    }
    if (model.imagePixelBudget !== undefined
      && model.imagePixelBudget !== 'low'
      && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget <= 0)) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" imagePixelBudget must be "low" or a positive safe integer`)
    }
    if (model.imageMaxBytes !== undefined
      && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes <= 0)) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" imageMaxBytes must be a positive safe integer`)
    }
    // Widened: a dynamic config update reaches this check without schema validation.
    const systemPromptUpdate: string | undefined = model.systemPromptUpdate
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
      throw new Error(`llm-deepseek: catalog model "${model.id}" systemPromptUpdate must be "in-history" when present`)
    }
    if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: model.systemPromptUpdate },
      inputModalities: [...inputModalities],
      ...hasImage
        ? {
          ...model.imagePixelBudget === undefined ? {} : { imagePixelBudget: model.imagePixelBudget },
          imageMaxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
        }
        : {},
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint: the product trusts the
 * project it is launched in, so a checkout can point its own agent at the
 * gateway that checkout is meant to use.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  // Settings updates can reach this resolver without schema validation.
  const protocol: string = config.protocol ?? 'messages'
  if (protocol !== 'chat-completions' && protocol !== 'messages') {
    throw new Error('llm-deepseek: protocol must be chat-completions or messages')
  }
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-deepseek: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-deepseek: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-deepseek: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-deepseek: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestFilesBytes = config.maxRequestFilesBytes ?? DEFAULT_MAX_REQUEST_FILES_BYTES
  if (!Number.isSafeInteger(maxRequestFilesBytes) || maxRequestFilesBytes <= 0) {
    throw new Error('llm-deepseek: maxRequestFilesBytes must be a positive safe integer')
  }
  const maxInlineRequestImageBytes = config.maxInlineRequestImageBytes ?? DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxInlineRequestImageBytes) || maxInlineRequestImageBytes <= 0) {
    throw new Error('llm-deepseek: maxInlineRequestImageBytes must be a positive safe integer')
  }
  const maxImagesPerRequest = config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
  if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
    throw new Error('llm-deepseek: maxImagesPerRequest must be a positive safe integer')
  }
  const imageOffloadByteQuantum = config.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
    throw new Error('llm-deepseek: imageOffloadByteQuantum must be a positive safe integer')
  }
  if (imageOffloadByteQuantum > maxRequestFilesBytes) {
    throw new Error('llm-deepseek: imageOffloadByteQuantum must not exceed maxRequestFilesBytes')
  }
  const inlineImageOffloadByteQuantum = config.inlineImageOffloadByteQuantum
    ?? DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(inlineImageOffloadByteQuantum) || inlineImageOffloadByteQuantum <= 0) {
    throw new Error('llm-deepseek: inlineImageOffloadByteQuantum must be a positive safe integer')
  }
  if (inlineImageOffloadByteQuantum > maxInlineRequestImageBytes) {
    throw new Error('llm-deepseek: inlineImageOffloadByteQuantum must not exceed maxInlineRequestImageBytes')
  }
  const imageOffloadCountQuantum = config.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
  if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
    throw new Error('llm-deepseek: imageOffloadCountQuantum must be a positive safe integer')
  }
  if (imageOffloadCountQuantum > maxImagesPerRequest) {
    throw new Error('llm-deepseek: imageOffloadCountQuantum must not exceed maxImagesPerRequest')
  }
  const filesApiTimeoutMs = config.filesApiTimeoutMs ?? DEFAULT_FILES_API_TIMEOUT_MS
  if (!Number.isFinite(filesApiTimeoutMs)
    || filesApiTimeoutMs <= 0
    || filesApiTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-deepseek: filesApiTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const fileExpiresAfterSeconds = config.fileExpiresAfterSeconds ?? DEFAULT_FILE_EXPIRY_SECONDS
  if (!Number.isSafeInteger(fileExpiresAfterSeconds)
    || fileExpiresAfterSeconds < 3_600
    || fileExpiresAfterSeconds > 2_592_000) {
    throw new Error('llm-deepseek: fileExpiresAfterSeconds must be an integer from 3600 through 2592000')
  }
  const fileRefreshMarginSeconds = config.fileRefreshMarginSeconds ?? DEFAULT_FILE_REFRESH_MARGIN_SECONDS
  if (!Number.isSafeInteger(fileRefreshMarginSeconds)
    || fileRefreshMarginSeconds < 0
    || fileRefreshMarginSeconds >= fileExpiresAfterSeconds) {
    throw new Error('llm-deepseek: fileRefreshMarginSeconds must be a non-negative integer below fileExpiresAfterSeconds')
  }
  const fileQuotaCleanupBatch = config.fileQuotaCleanupBatch ?? DEFAULT_FILE_QUOTA_CLEANUP_BATCH
  if (!Number.isSafeInteger(fileQuotaCleanupBatch)
    || fileQuotaCleanupBatch < 1
    || fileQuotaCleanupBatch > 1_000) {
    throw new Error('llm-deepseek: fileQuotaCleanupBatch must be an integer from 1 through 1000')
  }
  const baseURL = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value
    ?? (protocol === 'messages' ? MESSAGES_BASE_URL : PUBLIC_BASE_URL)
  if (protocol === 'messages') {
    const parsed = new URL(baseURL)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('llm-deepseek: Messages baseURL must be an HTTP(S) root without credentials, query, or fragment')
    }
  }
  return {
    protocol,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    maxRequestFilesBytes,
    maxInlineRequestImageBytes,
    maxImagesPerRequest,
    imageOffloadByteQuantum,
    inlineImageOffloadByteQuantum,
    imageOffloadCountQuantum,
    filesApiTimeoutMs,
    filePolicy: {
      expiresAfterSeconds: fileExpiresAfterSeconds,
      refreshMarginSeconds: fileRefreshMarginSeconds,
      quotaCleanupBatch: fileQuotaCleanupBatch,
    },
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-deepseek: retryPolicy'),
  }
}
