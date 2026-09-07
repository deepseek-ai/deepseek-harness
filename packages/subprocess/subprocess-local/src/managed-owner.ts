/** Minimal managed-range ownership bound to one ordinary subprocess handle. */

import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Platform owner used by termination and whole-range settlement. */
export interface BoundProcessOwner {
  /** Signal the managed range; `cancellationReason` is used only before Windows target commit. */
  signal(signal: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void
  /** Wait for the same managed range to become empty; reject when it cannot be observed. */
  waitForExit(): Promise<void>
  /** Synchronously force final termination during JavaScript-observable host exit. */
  terminateForHostExit(): void
  /** Release provider-private protocol artifacts after outcome and range settlement. */
  cleanup?(): void
}

/** Platform launch facts consumed by the common stdio and result lifecycle. */
export interface ManagedProcessLaunch {
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  direct: Promise<SubprocessOutcome>
  owner: BoundProcessOwner
}

/**
 * Apply an optional abort bound to one shared wait promise.
 * @param pending - managed-range wait shared by all callers.
 * @param signal - optional caller cancellation signal.
 * @returns whether the managed-range wait completed before cancellation.
 */
export async function waitWithAbort(pending: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    void pending.catch(() => {})
    return false
  }
  if (signal === undefined) {
    await pending
    return true
  }
  const aborted = Promise.withResolvers<boolean>()
  const onAbort = (): void => { aborted.resolve(false) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending.then(() => true), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
