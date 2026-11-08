/** Durable, best-effort diagnostics for obsolete update files that could not be removed. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Filesystem operation on a retired target; not evidence that a future download will fail. */
export interface UpdateCleanupFailure {
  readonly operation: 'list' | 'remove'
  readonly path: string
  readonly error: unknown
}

/**
 * Flush one cleanup warning to disk; diagnostic failure falls back to stderr without reviving a target.
 * @param directory - Shell-owned log directory, outside the update cache.
 * @param failure - Failed cleanup operation; no update URL or settings contents.
 */
export function recordUpdateCleanupFailure(directory: string, failure: UpdateCleanupFailure): void {
  const error = failure.error
  const entry = { time: new Date().toISOString(), event: 'update-cache-cleanup-failed',
    operation: failure.operation, path: failure.path,
    code: error instanceof Error && 'code' in error ? String(error.code) : null,
    reason: error instanceof Error ? error.message : String(error) }
  try {
    mkdirSync(directory, { recursive: true })
    appendFileSync(join(directory, 'update-cleanup.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600, flush: true })
  } catch (logError) {
    console.error('desktop update: could not persist cleanup warning', entry, logError)
  }
}
