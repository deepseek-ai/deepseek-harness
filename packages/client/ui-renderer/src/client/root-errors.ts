/**
 * Uncaught React root errors as failures of the root operation that caused them.
 * React 18 throws such an error out of `flushSync` and `root.unmount()`; React 19
 * instead passes it to the root's `onUncaughtError` option. Both majors therefore
 * see the same synchronous failure from a captured operation, and an error that
 * arrives outside one goes to `reportError`, React 19's default destination.
 */
import type { HydrationOptions, RootOptions } from 'react-dom/client'

/** Root options shared by `createRoot` and `hydrateRoot`; React 18 ignores `onUncaughtError`. */
export type CapturingRootOptions = RootOptions & HydrationOptions & {
  /** React 19 receives each error that no boundary caught. */
  readonly onUncaughtError: (error: unknown) => void
}

/** Collects the uncaught errors React 19 reports during one synchronous root operation. */
export class RootErrorCapture {
  private captured: unknown[] | undefined

  /** Options to pass when the root is created. */
  readonly options: CapturingRootOptions = {
    onUncaughtError: (error: unknown) => {
      if (this.captured === undefined) globalThis.reportError(error)
      else this.captured.push(error)
    },
  }

  /**
   * Run one synchronous root operation, such as a `flushSync` render or `root.unmount()`.
   * @param operation - Operation whose uncaught render and commit errors belong to the caller.
   * @returns The operation's result when neither it nor React reported an error.
   * @throws The single error thrown or reported, or an `AggregateError` naming every one.
   */
  run<T>(operation: () => T): T {
    const outer = this.captured
    const captured: unknown[] = []
    this.captured = captured
    try {
      const result = operation()
      if (captured.length === 0) return result
    } catch (error) {
      captured.unshift(error)
    } finally {
      this.captured = outer
    }
    throw captured.length === 1 ? captured[0] : new AggregateError(captured, 'renderer: React root operation failed')
  }
}
