/** Bounded scheduling for the opt-in signing experiment; production signing does not use this helper. */

/** Operations owned by one experiment, with independently bounded completion and hardware work. */
export interface SigningExperimentOptions<T> {
  readonly jobs: 1 | 2 | 4
  readonly hardwareConcurrency: 1 | 2 | 4
  readonly signal?: AbortSignal
  /** Complete one item, awaiting the supplied signing operation and all subsequent work before returning. */
  readonly complete: (item: T, sign: (path: string) => Promise<void>) => Promise<void>
  /** Perform one hardware request without retrying it. */
  readonly sign: (item: T, path: string) => Promise<void>
}

/**
 * Schedule independent experiment items and stop dispatch on the first failure or cancellation.
 * @param items Ordered inputs owned by this batch.
 * @param options Completion workers, hardware limit, cancellation and experiment operations.
 * @returns Resolves after every item completes; otherwise drains issued work before rejecting with the first reason.
 * Cancellation prevents new items and hardware requests but does not terminate an issued native operation.
 */
export async function runSigningExperimentBatch<T>(items: readonly T[], options: SigningExperimentOptions<T>): Promise<void> {
  let failure: { reason: unknown } | undefined
  let next = 0
  let signing = 0
  const requests = new Set<Promise<void>>()
  const waiting = new Set<() => void>()
  const wake = (): void => {
    for (const resume of waiting) resume()
    waiting.clear()
  }
  const stop = (reason: unknown): void => {
    failure ??= { reason }
    wake()
  }
  const aborted = (): void => { stop(options.signal?.reason) }
  const signItem = async (item: T, path: string): Promise<void> => {
    while (failure === undefined && signing >= options.hardwareConcurrency) {
      await new Promise<void>((resume) => { waiting.add(resume) })
    }
    if (failure !== undefined) throw failure.reason
    signing++
    try { await options.sign(item, path) }
    catch (error) { stop(error); throw error }
    finally { signing--; wake() }
  }
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next++]!
      try {
        await options.complete(item, (path) => {
          const request = signItem(item, path)
          requests.add(request)
          void request.then(() => requests.delete(request), () => requests.delete(request))
          return request
        })
      }
      catch (error) { stop(error) }
    }
  }
  options.signal?.addEventListener('abort', aborted, { once: true })
  try {
    if (options.signal?.aborted) aborted()
    await Promise.all(Array.from({ length: Math.min(options.jobs, items.length) }, worker))
    // A completion failure can leave a previously issued request awaiting its native result.
    await Promise.allSettled(requests)
    if (failure !== undefined) throw failure.reason
  } finally {
    options.signal?.removeEventListener('abort', aborted)
  }
}
