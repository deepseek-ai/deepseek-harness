/**
 * Error vocabulary for the storage hub and its backends.
 * @module @deepseek-ai/dsh-storage/src/error
 */

/** Discriminant codes carried by every {@link StorageError}. */
export type StorageErrorCode =
  | 'backend-not-found'
  | 'form-not-mounted'
  | 'duplicate-backend'
  | 'duplicate-mount'
  | 'version-mismatch'
  | 'malformed-medium'
  | 'unknown-state'
  | 'closed'

/**
 * Error thrown by the hub and by backend implementations. The `code` is the
 * stable contract consumers may switch on; `message` is diagnostic prose.
 */
export class StorageError extends Error {
  override readonly name = 'StorageError'

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options (`cause`).
   */
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
