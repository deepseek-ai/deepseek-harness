/**
 * Quiescence tracking for emit-shaped hook runs that no extension point awaits. Bridges
 * track the run plus its continuation, pass the tracker signal into execution,
 * and drain on disposal so no process or late callback outlives the fiber.
 * @module @deepseek-ai/dsh-hook-protocol/detached
 */

/** In-flight registry for one bridge's detached hook runs; see the module doc for the wiring contract. */
export interface DetachedRuns {
  /**
   * The abort signal every tracked run must hand to {@link runHook} (via its
   * `signal` option). {@link drain} fires it so a still-running hook process is
   * killed rather than awaited out to its timeout (default 10 minutes).
   */
  readonly signal: AbortSignal
  /**
   * Register one detached run until it settles. Pass the FULL chain — the hook
   * run and its continuation/error handler — so {@link drain} waits for the
   * side effects (an inject, a warn), not just the process exit. A rejected
   * chain is absorbed here (settlement bookkeeping only), but rejection
   * handling is still the caller's job: an untracked `.catch` is what turns a
   * failure into a logged warning instead of silence.
   * @param run - the detached run chain to hold until settled.
   */
  track(run: Promise<unknown>): void
  /**
   * Abort {@link signal}, then resolve once every tracked chain has settled —
   * including chains tracked while the drain is in progress. The bridge
   * registers this as its effect disposer; cordis awaits it, so
   * `fiber.dispose()` resolving means the bridge's detached work is quiescent.
   * A run tracked AFTER drain resolves is not awaited by anyone — by then the
   * bridge's listeners are disposed, so nothing can start one.
   * @returns resolves when all tracked runs have settled.
   */
  drain(): Promise<void>
}

/**
 * Create a {@link DetachedRuns} tracker (one per bridge `apply()`); settled
 * runs are pruned so a long-lived session does not accumulate them.
 * @returns the tracker.
 */
export function createDetachedRuns(): DetachedRuns {
  const inflight = new Set<Promise<unknown>>()
  const controller = new AbortController()
  return {
    signal: controller.signal,
    track(run: Promise<unknown>): void {
      inflight.add(run)
      const settled = (): void => { inflight.delete(run) }
      void run.then(settled, settled)
    },
    async drain(): Promise<void> {
      controller.abort(new Error('hook bridge disposed'))
      // Re-check after each wave: a chain can be tracked while a prior wave is
      // settling; loop until the registry is observed empty.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight])
      }
    },
  }
}
