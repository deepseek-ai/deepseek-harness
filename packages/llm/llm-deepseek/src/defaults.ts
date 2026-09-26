/** Shared provider limits and Chat Files API defaults. */

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 256_000
/** Default bound on accumulated base64 image payload after Files API fallback. */
export const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Deterministic raw-byte removal step. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024
/** Deterministic base64-byte removal step after Files API fallback. */
export const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** Deterministic image-count removal step. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
/** Default explicit lifetime for uploaded images. */
export const DEFAULT_FILE_EXPIRY_SECONDS = 7 * 24 * 60 * 60
/** Default proactive refresh window for indexed file ids. */
export const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 60 * 60
/** Default number of oldest harness-owned files removed on quota recovery. */
export const DEFAULT_FILE_QUOTA_CLEANUP_BATCH = 100
/** Default deadline for resolving one request image through the Files API. */
export const DEFAULT_FILES_API_TIMEOUT_MS = 60_000
