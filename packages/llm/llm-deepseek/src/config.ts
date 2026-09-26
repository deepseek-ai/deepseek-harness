/** Plugin configuration and complete request-local resolution for DeepSeek. */
import type { Volatile } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ModelModality, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'
import { DEFAULT_MODELS } from './models.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES, DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM, DEFAULT_FILE_EXPIRY_SECONDS, DEFAULT_FILE_REFRESH_MARGIN_SECONDS, DEFAULT_FILE_QUOTA_CLEANUP_BATCH, DEFAULT_FILES_API_TIMEOUT_MS } from './defaults.ts'
import { DEFAULT_MAX_IMAGES_PER_REQUEST, DEFAULT_MAX_REQUEST_FILES_BYTES, DEFAULT_REQUEST_IMAGE_MAX_BYTES } from './request-pricing.ts'

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** Shared Messages request configuration, without provider credential selection. */
export interface Config {
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL from a trusted environment layer, then the public API. */
  baseURL: Volatile<string | undefined>
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking: Volatile<'enabled' | 'disabled' | undefined>
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort: Volatile<'off' | 'low' | 'high' | 'max' | undefined>
  /** Default per-request output cap (default 256,000); a model's own cap and explicit request values win. */
  maxTokens: Volatile<number>
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow: Volatile<number>
  /** Advisory models shown by discovery consumers; defaults to V41 Flash and V4 Pro. */
  models: Volatile<DeepSeekCatalogModel[]>
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs: Volatile<number>
  /** Maximum accumulated file-referenced image bytes per chat request (default 128 MiB). */
  maxRequestFilesBytes: Volatile<number>
  /** Maximum accumulated base64 image payload after Files API fallback (default 20 MiB). */
  maxInlineRequestImageBytes: Volatile<number>
  /** Maximum number of represented images per chat request (default 600). */
  maxImagesPerRequest: Volatile<number>
  /** Raw-byte removal step after the request exceeds its file bound (default 64 MiB). */
  imageOffloadByteQuantum: Volatile<number>
  /** Base64-byte removal step after inline fallback exceeds its bound (default 10 MiB). */
  inlineImageOffloadByteQuantum: Volatile<number>
  /** Image-count removal step after the request exceeds its count bound (default 20). */
  imageOffloadCountQuantum: Volatile<number>
  /** Maximum duration of one request-image Files API resolution (default one minute). */
  filesApiTimeoutMs: Volatile<number>
  /** Explicit lifetime assigned to each uploaded image (default seven days). */
  fileExpiresAfterSeconds: Volatile<number>
  /** Remaining lifetime below which an indexed file is replaced (default one hour). */
  fileRefreshMarginSeconds: Volatile<number>
  /** Oldest harness-owned files deleted before one quota-recovery upload retry (default 100). */
  fileQuotaCleanupBatch: Volatile<number>
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy: Volatile<RetryPolicyConfig | undefined>
}

/** Plain options accepted by the provider resolver. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never }

/** Read the current value behind every reference of a validated Config.
 * @param config Parsed plugin Config.
 * @returns Plain options for the resolver.
 */
export function plainOptions(config: Config): Options {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
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
  toolUpdate: z.union(['in-history', 'addition-only'] as const),
})

/** Shared schema fields for Messages protocol options. */
export const deepSeekConfigFields = {
  baseURL: z.string().volatile(),
  thinking: z.union(['enabled', 'disabled']).volatile(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']).volatile(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS).volatile(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  maxRequestFilesBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_FILES_BYTES).volatile(),
  maxInlineRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES).volatile(),
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST).volatile(),
  imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM).volatile(),
  inlineImageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM).volatile(),
  imageOffloadCountQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM).volatile(),
  filesApiTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FILES_API_TIMEOUT_MS).volatile(),
  fileExpiresAfterSeconds: z.number().step(1).min(3_600).max(2_592_000).default(DEFAULT_FILE_EXPIRY_SECONDS).volatile(),
  fileRefreshMarginSeconds: z.number().step(1).min(0).default(DEFAULT_FILE_REFRESH_MARGIN_SECONDS).volatile(),
  fileQuotaCleanupBatch: z.number().step(1).min(1).max(1_000).default(DEFAULT_FILE_QUOTA_CLEANUP_BATCH).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
}

export const Config = z.object(deepSeekConfigFields)

/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com/anthropic'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** Complete protocol settings captured for one request operation. */
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
    const toolUpdate: string | undefined = model.toolUpdate
    if (toolUpdate !== undefined && toolUpdate !== 'in-history' && toolUpdate !== 'addition-only') {
      throw new Error(`llm-deepseek: catalog model "${model.id}" toolUpdate must be "in-history" or "addition-only" when present`)
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
      ...model.toolUpdate === undefined ? {} : { toolUpdate: model.toolUpdate },
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
 * The one explicit resolve step from raw config to validated protocol
 * settings. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint: the product trusts the
 * project it is launched in, so a checkout can point its own agent at the
 * gateway that checkout is meant to use.
 * @returns validated protocol settings.
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  // Settings updates can reach this resolver without schema validation.
  if (Object.hasOwn(config, 'protocol')) {
    throw new Error('llm-deepseek: protocol is not configurable; remove it and use a Messages-compatible baseURL')
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
  const baseURL = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL
  const parsed = new URL(baseURL)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('llm-deepseek: Messages baseURL must be an HTTP(S) root without credentials, query, or fragment')
  }
  return {
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
