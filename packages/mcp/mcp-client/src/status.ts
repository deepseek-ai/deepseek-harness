import type { Fiber } from '@deepseek-ai/cordis'

/**
 * Connection status and cleanup results keyed by the owning Cordis Fiber.
 * The cell survives reloads of that Fiber and remains readable after final
 * disposal, which detaches existing observers.
 *
 * @module
 */

/** Transport closure and local cleanup are reported independently. */
export interface McpCloseResult {
  /** Transport closure is confirmed, or no transport was created; unfinished negotiation remains unconfirmed. */
  closeConfirmed: boolean
  /** Cleanup failed or exceeded its budget, including after confirmed transport closure. */
  cleanupError?: string
}

/** Runtime state of one MCP instance and its current connection generation. */
export type McpConnectionStatus =
  | { state: 'closed'; result: McpCloseResult }
  | { state: 'waiting-credentials'; lastError: string }
  | {
    /** A connection attempt is in flight. */
    state: 'connecting'
    /** Consecutive failed attempts in the current outage before this one; `0` on the first-ever attempt. */
    attempt: number
  }
  | {
    /** Connected with the current tool generation registered. */
    state: 'connected'
    /** Registered tools in the live generation. */
    toolCount: number
    /** Epoch milliseconds when connect plus initial tool sync completed. */
    connectedAt: number
  }
  | {
    /** Waiting out the backoff delay before the next reconnect attempt. */
    state: 'reconnecting'
    /** Consecutive failed attempts in the current outage. */
    attempt: number
    /** Attempt budget per outage from the resolved reconnect policy. */
    maxAttempts: number
    /** Epoch milliseconds when the next attempt fires. */
    nextRetryAtMs: number
    /** Most recent connection failure, as diagnostic text. */
    lastError: string
  }
  | {
    /**
     * The supervisor stopped automatic attempts. `gave-up`
     * exhausted the per-outage attempt budget and unregistered the tools;
     * `reconnect-disabled` lost (or never made) the connection with reconnect
     * off; `unclosed-generation` blocks replacement because transport closure
     * or local cleanup is incomplete.
     */
    state: 'failed'
    /** Which supervisor stop produced this terminal state. */
    reason: 'gave-up' | 'reconnect-disabled' | 'unclosed-generation'
    /** Most recent connection failure, when one was observed. */
    lastError?: string
  }

/** Read-and-observe handle over one instance's {@link McpConnectionStatus}. */
export interface McpConnectionStatusHandle {
  /**
   * The current status.
   * @returns the latest status the supervisor published.
   */
  current(): McpConnectionStatus
  /**
   * The latest generation's cleanup result, independent of connection status.
   * @returns unconfirmed while a generation is open, or its recorded cleanup result.
   */
  closure(): McpCloseResult
  /**
   * Observe status transitions. Callbacks run synchronously in publish order;
   * a throwing callback is contained and logged without affecting the
   * supervisor or other callbacks.
   * @param callback - invoked with each published status.
   * @returns the disposer removing this observer.
   */
  onChange(callback: (status: McpConnectionStatus) => void | Promise<void>): () => void
}

/** Writable status cell retained across supervisors on the same Fiber. */
export class McpStatusCell implements McpConnectionStatusHandle {
  private value: McpConnectionStatus = { state: 'connecting', attempt: 0 }
  private closeResult: McpCloseResult = { closeConfirmed: true }

  closure(): McpCloseResult { return this.closeResult }

  /** Mark the next generation's closure as unconfirmed. */
  opened(): void { this.closeResult = { closeConfirmed: false } }

  /**
   * Record cleanup without publishing a connection-status transition.
   * @param result - independently observed transport and local cleanup outcome.
   */
  recordClosure(result: McpCloseResult): void { this.closeResult = result }

  /** Remove existing observers without discarding the readable status or cleanup result. */
  detach(): void { this.listeners.clear() }
  // Stored with an unknown return: dispatch inspects the returned value for
  // a promise to contain, which a void-typed call expression cannot express.
  private readonly listeners = new Set<(status: McpConnectionStatus) => unknown>()

  /**
   * @param warn - contained-listener diagnostic sink (the owning plugin's logger).
   */
  constructor(private warn: (message: string, error: unknown) => void) {}

  /**
   * Associate observer diagnostics with the Fiber's current supervisor.
   * @param warn - contained-listener diagnostic sink.
   */
  setWarningSink(warn: (message: string, error: unknown) => void): void { this.warn = warn }

  /**
   * The current status.
   * @returns the latest published status.
   */
  current(): McpConnectionStatus {
    return this.value
  }

  /**
   * Observe status transitions; see {@link McpConnectionStatusHandle.onChange}.
   * @param callback - invoked with each published status.
   * @returns the disposer removing this observer.
   */
  onChange(callback: (status: McpConnectionStatus) => void | Promise<void>): () => void {
    this.listeners.add(callback)
    return () => void this.listeners.delete(callback)
  }

  /**
   * Publish the next status and notify observers. A throwing observer is
   * contained so a broken consumer cannot wedge the supervisor's transition.
   * @param next - the status to publish.
   */
  update(next: McpConnectionStatus): void {
    this.value = next
    for (const listener of [...this.listeners]) {
      try {
        // An async observer's rejection must land in the same containment as
        // a sync throw; the callback type admits it explicitly.
        const returned = listener(next)
        if (typeof (returned as PromiseLike<unknown> | undefined)?.then === 'function') {
          void Promise.resolve(returned).catch((error: unknown) => {
            this.warn('an onChange status observer failed', error)
          })
        }
      } catch (error) {
        this.warn('an onChange status observer failed', error)
      }
    }
  }
}

const cellsByFiber = new WeakMap<Fiber, McpStatusCell>()

/**
 * Create or reuse a Fiber's status cell without discarding prior cleanup results.
 * @param fiber - the actual plugin Fiber owning the supervisor.
 * @param warn - diagnostic sink for observer failures.
 * @returns the stable writable cell for this Fiber.
 */
export function registerStatusCell(fiber: Fiber, warn: (message: string, error: unknown) => void): McpStatusCell {
  let cell = cellsByFiber.get(fiber)
  if (cell === undefined) {
    cell = new McpStatusCell(warn)
    cellsByFiber.set(fiber, cell)
  } else cell.setWarningSink(warn)
  return cell
}

/**
 * Look up status through an actual Fiber or the handle returned by `ctx.plugin()`.
 * @param fiber - plugin Fiber or its thenable handle.
 * @returns the retained cell, or `undefined` before the MCP instance registers one.
 */
export function connectionStatusIn(fiber: Fiber): McpConnectionStatusHandle | undefined {
  return cellsByFiber.get(fiber.ctx.fiber)
}
