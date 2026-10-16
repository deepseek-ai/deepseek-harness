/** Subscriber notification for the page controller's observable sources. */

/**
 * Call every subscriber; one throwing subscriber must not skip the rest.
 * @param listeners - current subscribers; copied before dispatch.
 * @param label - diagnostic owner named in the error log.
 */
export function notifySubscribers(listeners: ReadonlySet<() => void>, label: string): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // The page controller has no owning plugin Context for a scoped logger.
      console.error(`client-modules: ${label} subscriber failed`, error)
    }
  }
}
