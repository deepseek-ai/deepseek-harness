/** Preserve operation failures while completing their remaining owned cleanup. */
import { SourceError } from './source-error.ts'

/**
 * Run remaining cleanup without replacing the original failure.
 * @param error - Failure whose object and cause must remain available.
 * @param cleanup - Remaining cleanup, called only after its consumers are quiescent.
 * @returns Always rejects with the original error, or both failures when cleanup also rejects.
 */
export async function rethrowAfterCleanup(error: unknown, cleanup: () => void | PromiseLike<void>): Promise<never> {
  try {
    await cleanup()
  } catch (cleanupError: unknown) {
    throw new SourceError('Schedule cleanup failed after another failure; cleanup may be incomplete.',
      'SOURCE_DISPOSAL_FAILED', { cause: new AggregateError([error, cleanupError]) })
  }
  throw error
}
