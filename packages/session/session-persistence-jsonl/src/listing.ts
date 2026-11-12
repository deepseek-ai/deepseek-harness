/** Shared bounded filesystem scheduling for Session listings. @module */
import type { LimitFunction } from 'p-limit'

/**
 * Run `task` over `items` through the backend's shared listing limiter and
 * settle every call. Callers consume the outcomes in input order, so the first
 * failure they report matches a sequential loop whatever the completion order.
 * A limited task must never wait on the same limiter.
 * @param limit - the backend's shared listing limiter.
 * @param items - inputs in their sequential order.
 * @param task - per-item operation.
 * @returns one outcome per item, in input order.
 */
export function settleLimited<T, R>(
  limit: LimitFunction,
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return Promise.allSettled(items.map(item => limit(() => task(item))))
}

/**
 * Unwrap outcomes from {@link settleLimited}, rethrowing the first rejection in input order.
 * @param outcomes - outcomes in input order.
 * @returns the fulfilled values in input order.
 */
export function settledValues<R>(outcomes: readonly PromiseSettledResult<R>[]): R[] {
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome.value
  })
}
