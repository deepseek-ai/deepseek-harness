/** Model catalog and request-local dependencies for DeepSeek Messages. */
import type {
  ImageAttachmentAccess, LlmError, LlmModelInfo, ModelModality, ResolvedRetryPolicy,
  SystemPromptUpdate, ToolUpdate,
} from '@deepseek-ai/dsh-llm'
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
  imageTargetBytes?: number
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

/**
 * Authentication the provider plugin releases for one request and its file operations, with the request-failure
 * classification bound to that credential.
 */
export interface DeepSeekRequestAuth {
  /** Request headers carrying the credential. */
  readonly headers: Readonly<Record<string, string>>
  /**
   * Aborts when the owner withdraws the credential while the request may carry it, as an account sign-out does. It
   * ends the request and its file operations as the caller's cancellation does. Absent for credentials that are
   * never withdrawn.
   */
  readonly revoked?: AbortSignal
  /**
   * Classify a failure using the captured credential; callback failure preserves the original error. The end a
   * withdrawn credential causes arrives here too, for the provider plugin to name.
   */
  onRequestError?: (error: unknown) => Promise<unknown>
}

/** Constructor options for {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions<Connection extends DeepSeekConnectionOptions = DeepSeekConnectionOptions> {
  /** Report unusable native Messages replay metadata without exposing content or signatures. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** Report extension fields omitted from one request because the merged request failed to serialize. */
  onExtensionsOmitted?: (detail: { provider: string; model: string; fields: readonly string[]; error: unknown }) => void
  /** Report an extension acceptance failure after HTTP 2xx; the request continues. */
  onExtensionsUnaccepted?: (detail: { provider: string; model: string; error: unknown }) => void
  /** Provider label for selectors; omission uses the protocol family name. */
  providerName?: string
  /** Provider-owned catalog availability; omission exposes no discovery entries. */
  discoverModels?: (provider: string) => Promise<LlmModelInfo[]>
  /** Current validated connection facts; called once per operation. */
  options: () => Connection
  /**
   * Resolve the connection for one exact-model lookup or prepared call, for
   * example after a provider-owned catalog load; must settle promptly after
   * `signal` aborts. Omission uses {@link options}.
   */
  connect?: (signal?: AbortSignal) => Promise<Connection>
  /** Refuse a model before any network I/O by throwing an `LlmError`; omission admits every model. */
  admit?: (connection: Connection, model: string) => void
  /**
   * Release authentication for `endpoint` from this request's connection
   * snapshot, or `undefined` when the route has no credential for it; never
   * re-read the endpoint. Model requests pass the connection's own base URL.
   */
  resolveAuth: (connection: Connection, endpoint: string) => Promise<DeepSeekRequestAuth | undefined>
  /**
   * The failure a model request reports when {@link resolveAuth} releases no
   * credential for the route's own endpoint; omission reports `MISSING_CREDENTIAL`.
   */
  missingCredential?: (connection: Connection, provider: string) => LlmError
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
