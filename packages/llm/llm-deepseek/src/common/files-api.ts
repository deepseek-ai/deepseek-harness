/** DeepSeek Files API transport for Chat Completions and Messages endpoints. @module dsh-llm-deepseek/files-api */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType } from './file-id.ts'
import type { DeepSeekProtocol } from './types.ts'

/** Required opt-in for Messages file operations and file-referenced image requests. */
export const MESSAGES_FILES_BETA = 'files-api-2025-04-14'

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

/** Validated file metadata normalized from either DeepSeek Files protocol. */
export interface DeepSeekFileObject {
  id: DeepSeekFileIdType
  bytes: number
  createdAt: number
  filename: string
  /** Chat Completions purpose; synthesized as `user_data` for Messages. */
  purpose: 'user_data'
  /** Remote Chat Completions expiry or the upload-time Messages reuse deadline; Messages list/retrieve omit this field. */
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
   */
  constructor(message: string, status: number, detail: string) {
    super(message, status === 401 || status === 403
      ? 'AUTH'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500
          ? 'SERVER'
          : 'FILES_API', { status })
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
  apiKey: string
  protocol: DeepSeekProtocol
  fetch?: typeof fetch
}

interface WireFileObject {
  id?: unknown
  object?: unknown
  bytes?: unknown
  created_at?: unknown
  filename?: unknown
  purpose?: unknown
  expires_at?: unknown
}

function invalidResponse(operation: string): LlmError {
  return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, 'INVALID_RESPONSE')
}

function parseFileObject(value: unknown, operation: string): DeepSeekFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(operation)
  const wire = value as WireFileObject
  if (typeof wire.id !== 'string' || wire.id.length === 0
    || wire.object !== 'file'
    || !Number.isSafeInteger(wire.bytes) || (wire.bytes as number) < 0
    || !Number.isSafeInteger(wire.created_at) || (wire.created_at as number) < 0
    || typeof wire.filename !== 'string' || wire.filename.length === 0
    || wire.purpose !== 'user_data'
    || (wire.expires_at !== undefined
      && (!Number.isSafeInteger(wire.expires_at) || (wire.expires_at as number) < 0))) {
    throw invalidResponse(operation)
  }
  return {
    id: DeepSeekFileId(wire.id),
    bytes: wire.bytes as number,
    createdAt: wire.created_at as number,
    filename: wire.filename,
    purpose: 'user_data',
    ...wire.expires_at === undefined ? {} : { expiresAt: wire.expires_at as number },
  }
}

/** Normalize the Messages wire object without interpreting omitted expiration as permanence. */
function parseMessagesFile(value: unknown, operation: string): DeepSeekFileObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse(operation)
  const wire = value as Record<string, unknown>
  const createdAt = typeof wire.created_at === 'string' ? Math.floor(Date.parse(wire.created_at) / 1_000) : NaN
  if (wire.type !== 'file' || typeof wire.mime_type !== 'string' || !Number.isSafeInteger(createdAt)) throw invalidResponse(operation)
  return parseFileObject({
    id: wire.id, object: 'file', bytes: wire.size_bytes, created_at: createdAt,
    filename: wire.filename, purpose: 'user_data',
  }, operation)
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

/** Direct Files client retaining the configured URL root and refusing redirects before credentials can leave its origin. */
export class DeepSeekFilesClient {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly protocol: DeepSeekProtocol
  private readonly path: string

  /**
   * @param options - endpoint, API-key snapshot, and optional test transport.
   */
  constructor(options: FilesApiOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.protocol = options.protocol
    this.path = this.protocol === 'messages' ? '/v1/files' : '/files'
  }

  private parseFile(value: unknown, operation: string): DeepSeekFileObject {
    return this.protocol === 'messages' ? parseMessagesFile(value, operation) : parseFileObject(value, operation)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      const headers = new Headers(attributionHeaders())
      if (this.protocol === 'messages') {
        headers.set('x-api-key', this.apiKey)
        headers.set('anthropic-version', '2023-06-01')
        headers.set('anthropic-beta', MESSAGES_FILES_BETA)
      } else headers.set('authorization', `Bearer ${this.apiKey}`)
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
    } catch {
      // A status remains sufficient to report the provider failure.
    }
    const { message, detail } = providerErrorDetail(parsed)
    throw new DeepSeekFilesError(
      message ?? `DeepSeek Files API error (HTTP ${response.status})`,
      response.status,
      detail,
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
    const form = new FormData()
    if (this.protocol === 'chat-completions') form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(input.expiresAfterSeconds))
    form.set('file', new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType }), input.filename)
    const response = await this.request(this.path, { method: 'POST', body: form }, input.signal)
    const file = this.parseFile(await response.json(), 'upload')
    if (this.protocol === 'messages') return { ...file, expiresAt: file.createdAt + input.expiresAfterSeconds }
    if (file.expiresAt === undefined) throw invalidResponse('upload')
    return { ...file, expiresAt: file.expiresAt }
  }

  /**
   * List one page of files. Ordering applies only to Chat Completions; Messages owns its page order.
   * @param options - pagination, ordering, and cancellation.
   * @returns the validated page with null Messages cursors omitted.
   */
  async list(options: {
    after?: DeepSeekFileIdType
    limit?: number
    order?: 'asc' | 'desc'
    signal?: AbortSignal
  } = {}): Promise<DeepSeekFilePage> {
    const query = new URLSearchParams(this.protocol === 'messages' ? {} : { purpose: 'user_data' })
    if (options.after !== undefined) query.set(this.protocol === 'messages' ? 'after_id' : 'after', options.after)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.order !== undefined && this.protocol === 'chat-completions') query.set('order', options.order)
    const response = await this.request(`${this.path}?${query.toString()}`, { method: 'GET' }, options.signal)
    const value = await response.json() as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('list')
    const wire = value as { object?: unknown; data?: unknown; first_id?: unknown; last_id?: unknown; has_more?: unknown }
    const firstId = this.protocol === 'messages' ? wire.first_id ?? undefined : wire.first_id
    const lastId = this.protocol === 'messages' ? wire.last_id ?? undefined : wire.last_id
    if ((this.protocol === 'chat-completions' && wire.object !== 'list') || !Array.isArray(wire.data) || typeof wire.has_more !== 'boolean'
      || (firstId !== undefined && typeof firstId !== 'string')
      || (lastId !== undefined && typeof lastId !== 'string')) {
      throw invalidResponse('list')
    }
    return {
      data: wire.data.map(item => this.parseFile(item, 'list')),
      ...typeof firstId === 'string' ? { firstId: DeepSeekFileId(firstId) } : {},
      ...typeof lastId === 'string' ? { lastId: DeepSeekFileId(lastId) } : {},
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
    const response = await this.request(`${this.path}/${encodeURIComponent(fileId)}`, { method: 'GET' }, signal)
    return this.parseFile(await response.json(), 'retrieve')
  }

  /**
   * Delete one provider file.
   * @param fileId - provider file identifier.
   * @param signal - request cancellation.
   */
  async delete(fileId: DeepSeekFileIdType, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`${this.path}/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, signal)
    const value = await response.json() as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse('delete')
    const wire = value as { id?: unknown; object?: unknown; deleted?: unknown; type?: unknown }
    if (wire.id !== fileId || (this.protocol === 'messages'
      ? wire.type !== 'file_deleted'
      : wire.object !== 'file' || wire.deleted !== true)) throw invalidResponse('delete')
  }
}
