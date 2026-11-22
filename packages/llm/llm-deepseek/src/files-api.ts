/** DeepSeek Files API transport. @module dsh-llm-deepseek/files-api */

import { randomUUID } from 'node:crypto'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { retryAfterMs } from './transport.ts'
import type { DeepSeekFileId as DeepSeekFileIdType } from './file-id.ts'
import { messagesApiRoot, MESSAGES_FILES_BETA } from './messages-api.ts'

/** Minimum provider-supported file lifetime. */
export const MIN_FILE_EXPIRY_SECONDS = 3_600
/** Maximum provider-supported file lifetime. */
export const MAX_FILE_EXPIRY_SECONDS = 2_592_000
/** Maximum Files API upload size. */
export const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024
/** Current per-key file-count quota. */
export const MAX_STORED_FILE_COUNT = 10_000
/** Current per-key storage quota. */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024 * 1024

/** Validated provider file metadata. */
export interface DeepSeekFileObject {
  id: DeepSeekFileIdType
  bytes: number
  createdAt: number
  filename: string
  /** Upload-time reuse deadline; list and retrieve responses omit this field. */
  expiresAt?: number
}

/** One page returned by `GET /files`. */
export interface DeepSeekFilePage {
  data: DeepSeekFileObject[]
  firstId?: DeepSeekFileIdType
  lastId?: DeepSeekFileIdType
  hasMore: boolean
}

/** Files API operation failure with its HTTP status retained for recovery policy. */
export class DeepSeekFilesError extends LlmError {
  /** Parsed provider detail used only for error classification. */
  readonly detail: string

  /**
   * @param message - user-readable provider failure.
   * @param status - HTTP status returned by the Files API.
   * @param detail - provider error fields joined for classification.
   * @param headers - Files response headers carrying Retry-After.
   */
  constructor(message: string, status: number, detail: string, headers?: Headers) {
    const wait = retryAfterMs(headers)
    super(message, status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'FILES_API', { status, ...wait === undefined ? {} : { providerRetryAfterMs: wait } })
    this.name = 'DeepSeekFilesError'
    this.detail = detail
  }
}

/**
 * Whether an upload failure reports a provider storage or file-count quota.
 * @param error - Files API operation failure.
 * @returns whether one bounded remote cleanup and upload retry may recover.
 */
export function isFilesQuotaError(error: unknown): error is DeepSeekFilesError {
  return error instanceof DeepSeekFilesError
    && /(?:quota|storage|stored files|file count|too many files)/iu.test(error.detail)
}

interface FilesApiOptions {
  baseURL: string
  /** Provider-resolved authentication headers for this endpoint. */
  headers: Readonly<Record<string, string>>
  fetch?: typeof fetch
}

function invalidResponse(operation: string): LlmError {
  return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, 'INVALID_RESPONSE')
}

/** Decode successful Files JSON with operation context; body transport and abort failures retain their identity. */
async function responseJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    throw new LlmError(`DeepSeek Files API returned invalid JSON for ${operation} (HTTP ${response.status}).`, 'INVALID_RESPONSE', {
      status: response.status,
      cause: error,
    })
  }
}

function parseFileObject(value: unknown, operation: string): DeepSeekFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(operation)
  const wire = value as Record<string, unknown>
  const createdAt = typeof wire.created_at === 'string' ? Math.floor(Date.parse(wire.created_at) / 1_000) : NaN
  if (typeof wire.id !== 'string' || wire.id.length === 0
    || wire.type !== 'file'
    || typeof wire.mime_type !== 'string'
    || typeof wire.size_bytes !== 'number' || !Number.isSafeInteger(wire.size_bytes) || wire.size_bytes < 0
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || typeof wire.filename !== 'string' || wire.filename.length === 0
  ) {
    throw invalidResponse(operation)
  }
  return {
    id: brandString<DeepSeekFileIdType>(wire.id),
    bytes: wire.size_bytes,
    createdAt,
    filename: wire.filename,
  }
}

function providerErrorDetail(value: unknown): { message?: string; detail: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { detail: '' }
  const error = (value as { error?: unknown }).error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return { detail: '' }
  const fields = error as { message?: unknown; type?: unknown; code?: unknown }
  const message = typeof fields.message === 'string' ? fields.message : undefined
  return {
    ...message === undefined ? {} : { message },
    detail: [fields.code, fields.type, fields.message]
      .filter((field): field is string => typeof field === 'string')
      .join(' '),
  }
}

/**
 * Encode the upload as one `multipart/form-data` byte array (RFC 7578).
 *
 * `fetch` receives bytes instead of a `FormData`: Node's `fetch` copies a `FormData` body into the request stream from a
 * detached task, and a request cancelled while that task runs fails it as an unhandled rejection.
 */
function multipartUpload(boundary: string, input: {
  data: Uint8Array
  mediaType: ImageMediaType
  filename: string
  expiresAfterSeconds: number
}): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  // The escapes of the WHATWG multipart/form-data encoding keep the filename inside its quoted header value.
  const filename = input.filename.replaceAll('"', '%22').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  const head = encoder.encode([
    `--${boundary}`,
    'Content-Disposition: form-data; name="expires_after[anchor]"',
    '',
    'created_at',
    `--${boundary}`,
    'Content-Disposition: form-data; name="expires_after[seconds]"',
    '',
    String(input.expiresAfterSeconds),
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${input.mediaType}`,
    '',
    '',
  ].join('\r\n'))
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.byteLength + input.data.byteLength + tail.byteLength)
  body.set(head)
  body.set(input.data, head.byteLength)
  body.set(tail, head.byteLength + input.data.byteLength)
  return body
}

/** Direct Files client retaining the configured URL root and refusing redirects before credentials can leave its origin. */
export class DeepSeekFilesClient {
  private readonly baseURL: string
  private readonly authHeaders: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch

  /**
   * @param options - endpoint, authentication headers, and optional test transport.
   */
  constructor(options: FilesApiOptions) {
    this.authHeaders = options.headers
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.baseURL = messagesApiRoot(options.baseURL)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      const headers = new Headers(init.headers)
      for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
      for (const [name, value] of Object.entries(this.authHeaders)) headers.set(name, value)
      headers.set('anthropic-version', '2023-06-01')
      headers.set('anthropic-beta', MESSAGES_FILES_BETA)
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        ...init,
        redirect: 'error',
        headers,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (response.ok) return response
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (_nonJsonErrorBody) {
      // A status remains sufficient to report the provider failure.
    }
    const { message, detail } = providerErrorDetail(parsed)
    throw new DeepSeekFilesError(
      message ?? `DeepSeek Files API error (HTTP ${response.status})`,
      response.status,
      detail,
      response.headers,
    )
  }

  /**
   * Upload one image with an explicit expiry.
   * @param input - deterministic request-version bytes, media type, filename, lifetime, and cancellation.
   * @returns the validated file and reuse deadline. Messages omits expiry metadata;
   *   its deadline uses upload creation plus the requested lifetime.
   */
  async upload(input: {
    data: Uint8Array
    mediaType: ImageMediaType
    filename: string
    expiresAfterSeconds: number
    signal?: AbortSignal
  }): Promise<DeepSeekFileObject & { expiresAt: number }> {
    if (input.data.byteLength > MAX_FILE_UPLOAD_BYTES) {
      throw new LlmError('DeepSeek Files API upload exceeds 128 MiB.', 'INVALID_REQUEST')
    }
    if (!Number.isSafeInteger(input.expiresAfterSeconds)
      || input.expiresAfterSeconds < MIN_FILE_EXPIRY_SECONDS
      || input.expiresAfterSeconds > MAX_FILE_EXPIRY_SECONDS) {
      throw new LlmError('DeepSeek file expiry must be between 3600 and 2592000 seconds.', 'INVALID_REQUEST')
    }
    const boundary = `----dsh-${randomUUID()}`
    const response = await this.request('/files', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: multipartUpload(boundary, input),
    }, input.signal)
    const file = parseFileObject(await responseJson(response, 'upload'), 'upload')
    return { ...file, expiresAt: file.createdAt + input.expiresAfterSeconds }
  }

  /**
   * List one provider-ordered page of files.
   * @param options - pagination and cancellation.
   * @returns the validated page with null cursors omitted.
   */
  async list(options: {
    after?: DeepSeekFileIdType
    limit?: number
    signal?: AbortSignal
  } = {}): Promise<DeepSeekFilePage> {
    const query = new URLSearchParams()
    if (options.after !== undefined) query.set('after_id', options.after)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    const response = await this.request(`/files?${query.toString()}`, { method: 'GET' }, options.signal)
    const value: unknown = await responseJson(response, 'list')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('list')
    const wire = value as { data?: unknown; first_id?: unknown; last_id?: unknown; has_more?: unknown }
    const firstId = wire.first_id ?? undefined
    const lastId = wire.last_id ?? undefined
    if (!Array.isArray(wire.data) || typeof wire.has_more !== 'boolean'
      || (firstId !== undefined && typeof firstId !== 'string')
      || (lastId !== undefined && typeof lastId !== 'string')) {
      throw invalidResponse('list')
    }
    return {
      data: wire.data.map(item => parseFileObject(item, 'list')),
      ...typeof firstId === 'string' ? { firstId: brandString<DeepSeekFileIdType>(firstId) } : {},
      ...typeof lastId === 'string' ? { lastId: brandString<DeepSeekFileIdType>(lastId) } : {},
      hasMore: wire.has_more,
    }
  }

  /**
   * Retrieve one file object.
   * @param fileId - provider file identifier.
   * @param signal - request cancellation.
   * @returns the validated file object.
   */
  async retrieve(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<DeepSeekFileObject> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'GET' }, signal)
    return parseFileObject(await responseJson(response, 'retrieve'), 'retrieve')
  }

  /**
   * Delete one provider file.
   * @param fileId - provider file identifier.
   * @param signal - request cancellation.
   */
  async delete(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, signal)
    const value: unknown = await responseJson(response, 'delete')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('delete')
    const wire = value as { id?: unknown; type?: unknown }
    if (wire.id !== fileId || wire.type !== 'file_deleted') throw invalidResponse('delete')
  }
}
