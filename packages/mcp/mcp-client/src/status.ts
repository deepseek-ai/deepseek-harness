/**
 * Connection-status surface for one mcp-client instance: a typed status cell
 * the supervisor writes and a per-registration-scope lookup that managers
 * (such as `dsh-mcp-manager`) read without owning the plugin instance.
 *
 * Lookup is keyed by the same registration-scope owner as the `serverName`
 * reservation, so a caller sharing the instance's scope resolves exactly its
 * own instances and an Agent-scoped instance never leaks into the global
 * plane. Cells register and release inside the reservation effect; after
 * plugin disposal the lookup returns `undefined`.
 *
 * @module
 */

/** Runtime status of one supervised MCP server connection. */
export type McpConnectionStatus =
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
     * Terminal until disposal: the supervisor stopped on its own. `gave-up`
     * exhausted the per-outage attempt budget and unregistered the tools;
     * `reconnect-disabled` lost (or never made) the connection with reconnect
     * off; `unclosed-generation` stopped because a failed generation did not
     * close and reconnecting could overlap server processes.
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
   * Observe status transitions. Callbacks run synchronously in publish order;
   * a throwing callback is contained and logged without affecting the
   * supervisor or other callbacks.
   * @param callback - invoked with each published status.
   * @returns the disposer removing this observer.
   */
  onChange(callback: (status: McpConnectionStatus) => void | Promise<void>): () => void
}

/** Writable status cell owned by one plugin instance's supervisor. */
export class McpStatusCell implements McpConnectionStatusHandle {
  private value: McpConnectionStatus = { state: 'connecting', attempt: 0 }
  // Stored with an unknown return: dispatch inspects the returned value for
  // a promise to contain, which a void-typed call expression cannot express.
  private readonly listeners = new Set<(status: McpConnectionStatus) => unknown>()

  /**
   * @param warn - contained-listener diagnostic sink (the owning plugin's logger).
   */
  constructor(private readonly warn: (message: string, error: unknown) => void) {}

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

/** Live status cells per registration-scope owner, keyed by `serverName`. */
const cellsByOwner = new WeakMap<object, Map<string, McpStatusCell>>()

/**
 * File one instance's status cell under its registration-scope owner.
 * @param owner - the scope owner also holding the `serverName` reservation.
 * @param serverName - the instance's namespace, unique within `owner` by reservation.
 * @param cell - the supervisor-owned cell to expose.
 * @returns the disposer removing the cell from the lookup.
 */
export function registerStatusCell(owner: object, serverName: string, cell: McpStatusCell): () => void {
  let cells = cellsByOwner.get(owner)
  if (cells === undefined) {
    cells = new Map()
    cellsByOwner.set(owner, cells)
  }
  cells.set(serverName, cell)
  return () => void cellsByOwner.get(owner)?.delete(serverName)
}

/**
 * The status handle of the live mcp-client instance named `serverName` inside
 * one registration scope, or `undefined` while no such instance is live.
 * @param owner - the registration-scope owner (`scopeOf(ctx) ?? ctx.root` of the reading context).
 * @param serverName - the instance's configured namespace.
 * @returns the read-and-observe handle, or `undefined` when the name has no live instance.
 */
export function connectionStatusIn(owner: object, serverName: string): McpConnectionStatusHandle | undefined {
  return cellsByOwner.get(owner)?.get(serverName)
}
