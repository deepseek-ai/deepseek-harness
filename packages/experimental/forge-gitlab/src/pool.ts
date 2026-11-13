/** Bounded concurrency for independent GitLab reads. */

import pLimit from 'p-limit'

/**
 * Run `task` on every item, at most `limit` at a time.
 * @param items - work items.
 * @param limit - most concurrent tasks.
 * @param task - work for one item.
 * @returns settles once every task settled, so no task outlives a rejection; rejects with the first rejection.
 */
export async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const run = pLimit(limit)
  const settled = await Promise.allSettled(items.map(item => run(async () => { await task(item) })))
  const rejected = settled.find(result => result.status === 'rejected')
  if (rejected !== undefined) throw rejected.reason
}
