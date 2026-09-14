/** Shared catalog and request-local dependencies for DeepSeek protocols. */
import type { ModelModality, SystemPromptUpdate, ResolvedRetryPolicy, ImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { DeepSeekLlmApiExtensionRequest, PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekFileStore, DeepSeekFilePolicy } from './file-store.ts'

/** Supported wire implementations; Responses is not yet implemented. */
export type DeepSeekProtocol = 'chat-completions' | 'messages'

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
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** Wire protocol selected by plugin configuration. */
  protocol: DeepSeekProtocol
  /** Root compatible with the selected protocol; custom paths remain unchanged. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
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

/** Constructor options for {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions {
  /** Report unusable native Messages replay metadata without exposing content or signatures. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** Current validated connection facts; called once per operation. */
  options: () => DeepSeekConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>
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
