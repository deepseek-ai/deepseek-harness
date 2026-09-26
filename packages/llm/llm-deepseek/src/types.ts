/** Model catalog and request-local dependencies for DeepSeek Messages. */
import type { LlmModelInfo, ModelModality, SystemPromptUpdate, ToolUpdate, ResolvedRetryPolicy, ImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { DeepSeekLlmApiExtensionRequest, PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekFileStore, DeepSeekFilePolicy } from './file-store.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
  /**
   * Total-pixel budget replacing the published token-grid projection for one
   * deterministic request preview, or the 512-by-512 `low` preset; omission
   * projects onto the token grid.
   */
  imagePixelBudget?: number | 'low'
  /** Encoded-byte target for one deterministic request preview; the smallest quality-ladder output is used when no quality fits. */
  imageMaxBytes?: number
  /**
   * `'in-history'` declares that the endpoint reads the latest `system`
   * message at any position of the conversation as the complete effective
   * system prompt; omission means only a leading system message is read.
   */
  systemPromptUpdate?: SystemPromptUpdate
  /**
   * `'addition-only'` declares that the endpoint activates a `defer_loading`
   * tool from a later `tool_addition` block; `'in-history'` additionally
   * reads removal notices in conversation order. Omission declares the
   * complete tool list on every request.
   */
  toolUpdate?: ToolUpdate
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** Messages API root; custom paths remain unchanged. */
  baseURL: string
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum accumulated file-referenced image bytes in one request. */
  maxRequestFilesBytes: number
  /** Maximum accumulated base64 image payload after Files API fallback. */
  maxInlineRequestImageBytes: number
  /** Maximum number of represented images in one request. */
  maxImagesPerRequest: number
  /** Raw-byte removal step after the file-reference bound is exceeded. */
  imageOffloadByteQuantum: number
  /** Base64-byte removal step after the inline fallback bound is exceeded. */
  inlineImageOffloadByteQuantum: number
  /** Image-count removal step after the count bound is exceeded. */
  imageOffloadCountQuantum: number
  /** Maximum duration of one request-image Files API resolution. */
  filesApiTimeoutMs: number
  /** Upload expiry, refresh, and quota-recovery policy. */
  filePolicy: DeepSeekFilePolicy
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Authentication captured by the provider for one request and its file operations. */
export interface DeepSeekRequestAuth {
  /** Credential headers sent unchanged to the resolved endpoint. */
  headers: Readonly<Record<string, string>>
  /** Classify a failure using the captured credential; callback failure preserves the original error. */
  onRequestError?: (error: unknown) => Promise<unknown>
}

/** Constructor options for {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions<Connection extends DeepSeekConnectionOptions = DeepSeekConnectionOptions> {
  /** Report unusable native Messages replay metadata without exposing content or signatures. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** Report extension fields omitted from one request because the merged request failed to serialize. */
  onExtensionsOmitted?: (detail: { provider: string; model: string; fields: readonly string[]; error: unknown }) => void
  /** Provider label for selectors; omission uses the protocol family name. */
  providerName?: string
  /** Provider-owned catalog availability; omission exposes no discovery entries. */
  discoverModels?: (provider: string) => Promise<LlmModelInfo[]>
  /** Current validated connection facts; called once per operation. */
  options: () => Connection
  /** Resolve authentication from this request's connection snapshot; never re-read the endpoint. */
  resolveAuth: (connection: Connection) => Promise<DeepSeekRequestAuth>
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /** Resolve the process-wide upload reuse store. */
  resolveFiles?: () => DeepSeekFileStore
  /** Prepare the official API's plugin-contributed top-level fields for one exact wire request. */
  prepareExtensions: (request: DeepSeekLlmApiExtensionRequest) => Promise<PreparedDeepSeekLlmApiExtensions>
}


/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}
