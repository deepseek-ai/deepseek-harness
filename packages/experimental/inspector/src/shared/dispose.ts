/** Ordered release of Inspector registrations before their source transport closes. */

/**
 * Join every registration disposer in reverse order, then close the source even after failures.
 * @param disposers - Registrations in acquisition order.
 * @param close - Final transport teardown.
 * @param message - Aggregate failure diagnostic owned by the Host or Client caller.
 * @returns Completion after all cleanup actions have settled.
 * @throws AggregateError containing every failed cleanup action in release order.
 */
export async function disposeInspectorResources(
  disposers: readonly (() => unknown)[], close: () => unknown, message: string,
): Promise<void> {
  const failures: unknown[] = []
  for (const dispose of [...disposers].reverse().concat(close)) {
    try {
      await dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, message)
}
