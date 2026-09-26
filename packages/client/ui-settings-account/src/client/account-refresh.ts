/** Refresh ordering for returning from an external account operation. */

/**
 * Wait for the pre-return read, then request a fresh account snapshot.
 * @param pending - query already running before the user returned.
 * @param refresh - account owner's normal refresh operation.
 * @returns settlement of the new query, independent of the older query's outcome.
 */
export async function refreshAfterReturn(pending: Promise<void> | undefined, refresh: () => Promise<void>): Promise<void> {
  try { await pending }
  catch (_error) {
    // A failed pre-return query must not prevent the user's post-operation refresh.
  }
  await refresh()
}
