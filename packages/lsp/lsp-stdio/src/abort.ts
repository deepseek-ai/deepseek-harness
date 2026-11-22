/**
 * Shared cancellation helpers for the local LSP provider's host-I/O, queue, and protocol phases.
 * @module @deepseek-ai/dsh-lsp-stdio/abort
 */

import { timeoutOf } from '@deepseek-ai/dsh-timeout'

/**
 * Build an abort Error carrying the signal's reason and preserving timeout classification.
 * @param signal - the aborted signal whose reason to surface.
 * @returns the timeout reason if present, else the Error reason, else an `AbortError`-named Error
 *   whose `cause` is the non-Error reason, so tool cancellation classification still applies.
 */
export function abortError(signal: AbortSignal): Error {
  const timeout = timeoutOf(signal)
  if (timeout !== undefined) return timeout
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const aborted = new Error('LSP query aborted', { cause: reason })
  aborted.name = 'AbortError'
  return aborted
}

/**
 * Throw the signal's classified abort error when it has already fired.
 * @param signal - the optional query cancellation signal.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * Await work while allowing a query signal to abandon its wait; the underlying work keeps its own
 * handlers and continues to its owner-defined quiescence boundary.
 * @param work - the owned asynchronous work.
 * @param signal - optional query cancellation.
 * @returns the work result, or a rejection carrying the classified abort reason.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(abortError(signal))
  const canceled = Promise.withResolvers<never>()
  const onAbort = (): void => { canceled.reject(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  const normalized = work.catch((error: unknown) => {
    /* v8 ignore next -- owned LSP promises reject with Error; coercion defends the generic helper. */
    throw error instanceof Error ? error : new Error(String(error))
  })
  return Promise.race([normalized, canceled.promise])
    .finally(() => { signal.removeEventListener('abort', onAbort) })
}
