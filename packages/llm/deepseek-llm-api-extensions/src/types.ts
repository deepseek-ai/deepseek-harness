/** Provider-specific JSON, header, and contribution types for DeepSeek request extensions. */

/** Lossless JSON value accepted by the DeepSeek request body. */
export type DeepSeekLlmApiJson =
  | null
  | boolean
  | number
  | string
  | DeepSeekLlmApiJson[]
  | { [key: string]: DeepSeekLlmApiJson }

/**
 * Merge-extensible table of top-level DeepSeek request extension fields.
 * Contributor packages declaration-merge the field they own.
 */
export interface DeepSeekLlmApiExtensionMap {}

/**
 * Merge-extensible table of DeepSeek Harness request headers and their values.
 * Contributor packages declaration-merge each `x-deepseek-harness-` header they own.
 */
export interface DeepSeekLlmApiHeaderMap {}

/** Request identity visible to header and field providers. */
export interface DeepSeekLlmApiHeaderRequest {
  /** Session identity carried by the model request, when present. */
  readonly sessionId?: string
  /** Auxiliary request classification, when present. */
  readonly purpose?: string
}

/** Exact serialized request facts visible to extension providers. */
export interface DeepSeekLlmApiExtensionRequest extends DeepSeekLlmApiHeaderRequest {
  /** Base DeepSeek request body before extension fields are merged. */
  readonly body: Readonly<Record<string, DeepSeekLlmApiJson>>
  /** Cancellation for request preparation; providers must stop promptly after abort. */
  readonly signal: AbortSignal
}

/** One prepared field value and its optional post-2xx commit. */
export interface PreparedDeepSeekLlmApiExtension<T extends DeepSeekLlmApiJson> {
  /** Detached value merged under the provider's registered field. */
  readonly value: T
  /** Commit state that depends on confirmed provider acceptance. */
  accept?(): void | Promise<void>
}

/** Provider registered under one key of {@link DeepSeekLlmApiExtensionMap}. */
export interface DeepSeekLlmApiExtensionProvider<T extends DeepSeekLlmApiJson> {
  /**
   * Prepare one field for an exact serialized request.
   * @param request - immutable base request facts.
   * @returns the prepared field, or `undefined` when this request has no value for it.
   */
  prepare(
    request: DeepSeekLlmApiExtensionRequest,
  ): PreparedDeepSeekLlmApiExtension<T> | undefined | Promise<PreparedDeepSeekLlmApiExtension<T> | undefined>
}

/** Provider registered under one key of {@link DeepSeekLlmApiHeaderMap}. */
export interface DeepSeekLlmApiHeaderProvider<T extends string> {
  /**
   * Compute this header synchronously for one model request.
   * @param request - request identity and auxiliary purpose.
   * @returns the header value, or `undefined` when this request has no value for it.
   */
  value(request: DeepSeekLlmApiHeaderRequest): T | undefined
}

/** All fields prepared for one request plus their joint acceptance transaction. */
export interface PreparedDeepSeekLlmApiExtensions {
  /** Detached top-level fields to merge into the base request. */
  readonly fields: Readonly<Partial<DeepSeekLlmApiExtensionMap>>
  /**
   * Commit every captured provider after HTTP 2xx. Repeated calls join the same settlement.
   * @returns fulfillment after every commit succeeds.
   */
  accept(): Promise<void>
}
