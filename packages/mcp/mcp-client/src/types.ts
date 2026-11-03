/**
 * Client-safe MCP connection status and probe outcomes. Types only — no runtime code.
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

/** Probe phase a failure is attributed to. */
export type McpProbeStage = 'connect' | 'list'

/** Successful probe: negotiation and any advertised tool listing completed. */
export interface McpProbeSuccess {
  ok: true
  /** Server-reported identity from `initialize`, when the SDK captured one. */
  serverInfo?: { name: string; version: string }
  /** Advertised raw tool names, capped at the resolved `maxToolNames`. */
  toolNames: string[]
  /** Whether the advertised list was longer than the returned `toolNames`. */
  truncated: boolean
  /** Wall-clock duration of negotiation and listing, excluding cleanup, in milliseconds. */
  durationMs: number
}

/** Failed probe, attributed to the stage that raised it. */
export interface McpProbeFailure {
  ok: false
  stage: McpProbeStage
  /** Diagnostic text of the failure. */
  message: string
  /** Wall-clock duration until the failure in milliseconds. */
  durationMs: number
}

/** Outcome of one MCP server probe. */
export type McpProbeResult = (McpProbeSuccess | McpProbeFailure) & McpCloseResult
