/**
 * Client-safe MCP connection status, probe outcomes, and OAuth attempt views. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-mcp-client/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Actionable reasons a passive OAuth connection must await explicit authorization:
 * `missing` — no grant is saved at the credential key; `expired` — the access token
 * expired and the grant has no refresh token; `binding` — the saved grant or client
 * registration no longer matches the endpoint URL, `clientId`, `scope`, or issuer,
 * or a newer grant replaced it; `rejected` — the server or authorization server
 * rejected the token or refresh; `scope` — the server requires a scope the grant lacks.
 */
export type McpAuthorizationReason = 'missing' | 'expired' | 'binding' | 'rejected' | 'scope'

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
    /** A credential template names a missing value; the connection retries when a credential record changes. */
    state: 'waiting-credentials'
    /** The resolution failure, as diagnostic text. */
    lastError: string
  }
  | {
    /** An OAuth connection has no usable grant and waits for explicit authorization. */
    state: 'waiting-authorization'
    /** Why the saved grant cannot be used. */
    reason: McpAuthorizationReason
    /** The authorization failure, as diagnostic text. */
    lastError: string
  }
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

/** Identity used to cancel only the selected authorization attempt. */
export type McpOAuthAttemptId = Branded<'McpOAuthAttemptId'>

/** Observable authorization state without tokens, client secrets, or the PKCE verifier. */
export interface McpOAuthAttemptView {
  /** Identity that cancels this attempt. */
  id: McpOAuthAttemptId
  /**
   * `starting` discovers the authorization server and reuses or registers its client; `waiting-browser`
   * waits for the browser callback; `exchanging` trades the code for tokens; `committing`
   * saves the grant. `authorized`, `cancelled`, and `failed` are final.
   */
  phase: 'starting' | 'waiting-browser' | 'exchanging' | 'committing' | 'authorized' | 'cancelled' | 'failed'
  /** The authorization page to open in a browser on the Host; present only while `waiting-browser`. */
  authorizationUrl?: string
  /** Redacted failure description; present only when `failed`. */
  lastError?: string
}
