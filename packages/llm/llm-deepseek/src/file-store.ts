/** DeepSeek Files API upload reuse, invalidation, and quota recovery. @module dsh-llm-deepseek/file-store */

import { setTimeout as delay } from 'node:timers/promises'
import { timeoutOf, type TimeoutReason } from '@deepseek-ai/dsh-timeout'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DeepSeekFilesClient, DeepSeekFilesError, isFilesQuotaError } from './files-api.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { messagesApiRoot } from './messages-api.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from './upload-index.ts'
import { serializeAuthHeaders } from './auth-headers.ts'
import type { DeepSeekUploadRecord } from './upload-index.ts'

import { MAX_IMAGE_BYTES } from './defaults.ts'
export { MAX_IMAGE_BYTES } from './defaults.ts'
const OWNED_FILE_PREFIX = 'dsh-'
/** Per-image deadline whose expiry during upload starts Files backoff. */
export const FILES_API_TIMEOUT = 'DEEPSEEK_FILES_API_TIMEOUT'

interface UploadBackoff {
  interval: bigint
  reason: TimeoutReason
  remaining: bigint
}

/** Resolved file-store policy from the plugin configuration. */
export interface DeepSeekFilePolicy {
  expiresAfterSeconds: number
  refreshMarginSeconds: number
  quotaCleanupBatch: number
  /** Maximum simultaneous file resolutions in one model request. */
  uploadConcurrency: number
  /** Per-image resolution deadline, including retry delays. */
  uploadTimeoutMs: number
  /** Additional attempts shared by rate-limit and quota recovery. */
  uploadMaxRetries: number
  /** Local delay after HTTP 429, in milliseconds. */
  uploadRetryDelayMs: number
}

/** Connection facts needed by file operations. */
export interface DeepSeekFileConnection {
  baseURL: string
  /** Provider-resolved authentication headers for this endpoint. */
  headers: Readonly<Record<string, string>>
}

/** Result of one file-id resolution. */
export interface DeepSeekFileReference {
  record: DeepSeekUploadRecord
  uploaded: boolean
}

interface FileStoreOptions {
  index?: DeepSeekUploadIndex
  now?: () => number
  fetch?: typeof fetch
}

/** Timeout decision shared by all cache misses in one model request on the same endpoint and credential. */
export interface FileRequestBackoff {
  /** Undefined before the first cache miss, null when uploads are admitted, or the timeout behind the skip. */
  skippedAfter?: TimeoutReason | null
}

interface SharedUpload {
  controller: AbortController
  promise: Promise<DeepSeekFileReference>
  settled: boolean
  waiters: number
  onUploadTimeout?: (reason: TimeoutReason) => void
}

/** The Files resource's parent URL identifies the upload namespace. */
function fileScope(connection: DeepSeekFileConnection) {
  return deepSeekFileScope(messagesApiRoot(connection.baseURL), serializeAuthHeaders(connection.headers))
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('DeepSeek file upload cancelled with a non-Error reason.', { cause: reason })
}

function uploadFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('DeepSeek file upload failed with a non-Error reason.', { cause: error })
}

function waitForUpload(operation: SharedUpload, signal: AbortSignal | undefined): Promise<DeepSeekFileReference> {
  signal?.throwIfAborted()
  operation.waiters += 1
  let released = false
  const release = (cancelledReason?: Error): void => {
    if (released) return
    released = true
    operation.waiters -= 1
    if (cancelledReason !== undefined && operation.waiters === 0 && !operation.settled) {
      operation.controller.abort(cancelledReason)
    }
  }
  if (signal === undefined) {
    return operation.promise.finally(() => {
      release()
    })
  }
  return new Promise<DeepSeekFileReference>((resolve, reject) => {
    const abort = (): void => {
      const reason = abortReason(signal)
      const timeout = timeoutOf(signal, FILES_API_TIMEOUT)
      if (timeout) operation.onUploadTimeout?.(timeout)
      release(reason)
      reject(reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.promise.then((value) => {
      signal.removeEventListener('abort', abort)
      release()
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      release()
      reject(uploadFailure(error))
    })
  })
}

function extension(mediaType: RequestImageAttachment['mediaType']): 'png' | 'jpeg' | 'webp' | 'gif' {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpeg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function filename(version: RequestImageAttachment): string {
  const attachment = String(version.attachment.attachmentId).slice('sha256:'.length, 'sha256:'.length + 16)
  const variant = String(version.variantId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `${OWNED_FILE_PREFIX}${attachment}-${variant}.${extension(version.mediaType)}`
}

/** User-scoped durable file-id reuse for the DeepSeek route. */
export class DeepSeekFileStore {
  private readonly index: DeepSeekUploadIndex
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch | undefined
  private readonly backoffs = new Map<DeepSeekUploadRecord['scope'], UploadBackoff>()
  private readonly inflight = new Map<string, SharedUpload>()
  /** Unclaimed slots from the preceding cleanup in each active Files namespace. */
  private readonly quotaRecoveries = new Map<DeepSeekUploadRecord['scope'], Promise<number>>()

  /**
   * @param options - testable index, clock, and transport boundaries.
   */
  constructor(options: FileStoreOptions = {}) {
    this.index = options.index ?? new DeepSeekUploadIndex()
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetch
  }

  private client(connection: DeepSeekFileConnection): DeepSeekFilesClient {
    return new DeepSeekFilesClient({
      baseURL: connection.baseURL,
      headers: connection.headers,
      ...this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl },
    })
  }

  /**
   * Resolve or upload one deterministic request image. Concurrent calls share one upload while retaining independent waits.
   * @param version - deterministic model-request bytes and complete transformation identity.
   * @param connection - endpoint and API-key snapshot.
   * @param policy - expiry and quota-recovery policy.
   * @param signal - cancellation of this wait; shared transport stops when no waiter remains.
   * @param request - timeout backoff decision shared by images in the same request; standalone calls count independently.
   * @returns a reusable file id and whether this call published a new upload.
   * @throws During backoff the first cache miss consumes one skip for the request. Skipped uploads reject with FILES_API_SKIPPED.
   */
  async ensureUploaded(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
    request: FileRequestBackoff = {},
  ): Promise<DeepSeekFileReference> {
    signal?.throwIfAborted()
    if (version.bytes > MAX_IMAGE_BYTES) {
      throw new LlmError('DeepSeek image exceeds the 32 MiB per-image limit.', 'INVALID_REQUEST')
    }
    const scope = fileScope(connection)
    const marginMs = policy.refreshMarginSeconds * 1_000
    const startedAt = this.now()
    const cached = await this.index.get(scope, version.variantId, startedAt, marginMs, signal)
      .catch((error: unknown) => { throw uploadFailure(error) })
    signal?.throwIfAborted()
    if (cached) return { record: cached, uploaded: false }
    if (request.skippedAfter === undefined) {
      const backoff = this.backoffs.get(scope)
      if (backoff && backoff.remaining > 0n) {
        backoff.remaining--
        request.skippedAfter = backoff.reason
      } else {
        request.skippedAfter = null
      }
    }
    if (request.skippedAfter) {
      throw LlmError.fromFailure({
        message: 'DeepSeek Files API upload skipped after a timeout.', code: 'FILES_API_SKIPPED',
      }, { cause: request.skippedAfter })
    }
    const key = `${scope}\0${version.variantId}`
    let active = this.inflight.get(key)
    if (active?.controller.signal.aborted) {
      this.inflight.delete(key)
      active = undefined
    }
    if (active !== undefined) return waitForUpload(active, signal)
    const controller = new AbortController()
    const shared: SharedUpload = {
      controller,
      settled: false,
      waiters: 0,
      promise: undefined as never,
    }
    shared.promise = this.uploadOnce(version, connection, policy, scope, shared, startedAt + policy.uploadTimeoutMs).then((value) => {
      shared.settled = true
      return value
    }, (error: unknown) => {
      shared.settled = true
      throw uploadFailure(error)
    })
    this.inflight.set(key, shared)
    void shared.promise.finally(() => {
      if (this.inflight.get(key) === shared) this.inflight.delete(key)
    }).catch(() => {})
    return waitForUpload(shared, signal)
  }

  private async uploadOnce(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    scope: DeepSeekUploadRecord['scope'],
    shared: SharedUpload,
    retryUntil: number,
  ): Promise<DeepSeekFileReference> {
    const signal = shared.controller.signal
    const marginMs = policy.refreshMarginSeconds * 1_000

    const client = this.client(connection)
    const upload = async (): Promise<DeepSeekUploadRecord> => {
      signal.throwIfAborted()
      const previous = this.backoffs.get(scope)
      // Count overlapping uploads from one failure interval once, even if an aborted transport never settles.
      shared.onUploadTimeout = (reason) => {
        const current = this.backoffs.get(scope)
        if (current && current !== previous) return
        const interval = current ? current.interval * 2n : 1n
        this.backoffs.set(scope, { interval, remaining: interval, reason })
      }
      const remote = await client.upload({
        data: version.data,
        mediaType: version.mediaType,
        filename: filename(version),
        expiresAfterSeconds: policy.expiresAfterSeconds,
        signal,
      }).finally(() => { delete shared.onUploadTimeout })
      if (remote.bytes !== version.data.byteLength) {
        throw new LlmError('DeepSeek Files API upload response does not match the submitted image.', 'INVALID_RESPONSE')
      }
      if (!signal.aborted) this.backoffs.delete(scope)
      return {
        scope,
        attachmentId: version.attachment.attachmentId,
        variantId: version.variantId,
        fileId: remote.id,
        bytes: remote.bytes,
        createdAt: remote.createdAt * 1_000,
        expiresAt: remote.expiresAt * 1_000,
      }
    }

    let candidate: DeepSeekUploadRecord
    let reclaimed = false
    for (let attempt = 0; ; attempt++) {
      try {
        candidate = await upload()
        break
      } catch (error) {
        if (attempt >= policy.uploadMaxRetries) throw error
        if (isFilesQuotaError(error)) {
          if (reclaimed || !await this.reserveQuotaSlot(scope, connection, policy.quotaCleanupBatch, signal)) throw error
          reclaimed = true
        } else {
          if (!(error instanceof DeepSeekFilesError) || error.code !== 'RATE_LIMIT') throw error
          const wait = Math.max(error.failure.providerRetryAfterMs ?? 0, policy.uploadRetryDelayMs)
          if (wait >= retryUntil - this.now()) throw error
          await delay(wait, undefined, { signal })
        }
      }
    }
    const committed = await this.index.commit(candidate, this.now(), marginMs)
    if (!committed.accepted) {
      try {
        await client.delete(candidate.fileId, signal)
      } catch (_duplicateDeleteFailed) {
        // The winning mapping is durable. A failed duplicate cleanup affects quota only and is retried by recovery.
      }
    }
    return { record: committed.record, uploaded: committed.accepted }
  }

  /** Overlapping quota failures claim distinct deleted slots, listing again only when the batch runs out. */
  private async reserveQuotaSlot(scope: DeepSeekUploadRecord['scope'], connection: DeepSeekFileConnection, count: number, signal: AbortSignal) {
    const previous = this.quotaRecoveries.get(scope)
    const next = Promise.withResolvers<number>()
    this.quotaRecoveries.set(scope, next.promise)
    let available = 0
    try {
      available = previous === undefined ? 0 : await previous
      signal.throwIfAborted()
      if (available > 0) {
        available--
        return true
      }
      const deleted = await this.reclaimOldestOwned(connection, count, signal)
      available = Math.max(0, deleted - 1)
      return deleted > 0
    } finally {
      next.resolve(available)
      if (this.quotaRecoveries.get(scope) === next.promise) this.quotaRecoveries.delete(scope)
    }
  }

  /**
   * Invalidate exact local mappings in one index update after a model request rejects their remote ids.
   * @param generations - request-image variants with the exact file id the request used for each.
   * @param connection - endpoint and API-key snapshot.
   */
  async invalidate(
    generations: readonly Pick<DeepSeekUploadRecord, 'variantId' | 'fileId'>[],
    connection: DeepSeekFileConnection,
  ): Promise<void> {
    await this.index.remove(fileScope(connection), generations)
  }

  /**
   * Delete the indexed remote file for one attachment and remove its local mapping.
   * @param version - exact request-image version to release.
   * @param connection - endpoint and API-key snapshot.
   * @param policy - expiry policy used to locate a reusable mapping.
   * @param signal - request cancellation.
   * @returns whether an indexed file existed and was deleted.
   */
  async release(
    version: RequestImageAttachment,
    connection: DeepSeekFileConnection,
    policy: DeepSeekFilePolicy,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const scope = fileScope(connection)
    const record = await this.index.get(
      scope,
      version.variantId,
      this.now(),
      policy.refreshMarginSeconds * 1_000,
    )
    if (record === undefined) return false
    await this.client(connection).delete(record.fileId, signal)
    await this.index.remove(scope, [{ variantId: version.variantId, fileId: record.fileId }])
    return true
  }

  /**
   * Delete the oldest provider files whose names identify harness ownership.
   * @param connection - endpoint and API-key snapshot.
   * @param count - positive maximum number of files to delete.
   * @param signal - request cancellation.
   * @returns number of successfully deleted files.
   */
  async reclaimOldestOwned(
    connection: DeepSeekFileConnection,
    count: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const client = this.client(connection)
    let after: DeepSeekFileId | undefined
    const owned: { id: DeepSeekFileId; createdAt: number }[] = []
    while (true) {
      const page = await client.list({
        ...after === undefined ? {} : { after },
        limit: 1_000,
        ...signal === undefined ? {} : { signal },
      })
      for (const file of page.data) {
        if (!file.filename.startsWith(OWNED_FILE_PREFIX)) continue
        owned.push({ id: file.id, createdAt: file.createdAt })
      }
      // The API offers no ascending-order query; retain the oldest candidates across every page.
      owned.sort((left, right) => left.createdAt - right.createdAt)
      owned.splice(count)
      if (!page.hasMore || page.lastId === undefined || page.lastId === after) break
      after = page.lastId
    }
    for (const file of owned) await client.delete(file.id, signal)
    return owned.length
  }

  /**
   * Delete every remote harness-owned file in the active API-key namespace and clear its index.
   * @param connection - endpoint and API-key snapshot.
   * @param signal - request cancellation.
   * @returns number of deleted files.
   */
  async releaseAll(connection: DeepSeekFileConnection, signal?: AbortSignal): Promise<number> {
    let total = 0
    for (;;) {
      const deleted = await this.reclaimOldestOwned(connection, 1_000, signal)
      total += deleted
      if (deleted < 1_000) break
    }
    await this.index.clear(fileScope(connection))
    return total
  }
}
