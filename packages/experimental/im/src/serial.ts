/** Async serialization queues for per-key operations and single-lane storage writes. */

/**
 * Run one async operation after any in-flight operations under the same key, deleting the key's chain entry once no
 * newer operation is queued behind it.
 * @param chains - map of active per-key tail promises.
 * @param key - serialization key.
 * @param operation - async task to run once earlier tasks for `key` settle.
 * @returns the promise of `operation`'s result.
 */
export function runKeyed<K, T>(
  chains: Map<K, Promise<unknown>>,
  key: K,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (chains.get(key) ?? Promise.resolve()).then(operation)
  const chain = result.then(() => {}, () => {})
  chains.set(key, chain)
  void chain.then(() => { if (chains.get(key) === chain) chains.delete(key) })
  return result
}

/** Single-lane async write queue whose tail settles without rejecting. */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Append `operation` after all queued writes.
   * @param operation - write task to run in order.
   * @returns the promise of `operation`'s result.
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  /**
   * Wait until every write queued so far has settled.
   * @returns a promise that resolves once the tail settles.
   */
  async drain(): Promise<void> {
    await this.tail
  }
}
