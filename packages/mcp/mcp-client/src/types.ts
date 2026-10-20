/**
 * Client-safe MCP connection status. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-mcp-client/types
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
