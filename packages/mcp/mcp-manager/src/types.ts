/**
 * Type surface of the MCP server manager: the per-server status union a
 * management surface renders, the list view, and the manager's Cordis event.
 * Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-mcp-manager/types
 */

import type { McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client'

/**
 * Status of one managed server. Extends the mcp-client connection status with
 * the two conditions only the manager can know: `disabled` (the entry is
 * configured off, so no instance exists) and the manager-side `failed` reasons
 * — `resolve` (a `${env:…}` / `${credential:…}` template did not resolve, so
 * no instance was created) and `load` (the mcp-client instance rejected
 * activation, for example a `serverName` collision with a statically
 * composed instance).
 */
export type McpManagedServerStatus =
  | McpConnectionStatus
  | { state: 'disabled' }
  | { state: 'failed'; reason: 'resolve' | 'load'; lastError: string }

/** One managed server as a management surface lists it. */
export interface McpManagedServerView {
  /** The `mcp.servers` key; also the instance's `serverName` tool namespace. */
  name: string
  /** Configured transport. */
  transport: 'stdio' | 'streamable-http'
  /** Durable intent: whether the entry asks for a running instance. */
  enabled: boolean
  /**
   * Whether removing the entry removes the server: true only when the user
   * layer alone carries it. A composition-base entry can be overridden or
   * disabled but not deleted, and remains listed as the deployment composed it.
   */
  deletable: boolean
  /** Current runtime status. */
  status: McpManagedServerStatus
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One managed server's status transitioned. Emitted for every published
     * change while the entry exists — connection-state transitions mirrored
     * from the instance, `disabled` when the entry is configured off, and the
     * manager-side `failed` reasons. Not emitted for an entry removed from
     * configuration; observers learn removals from the settings document.
     * @param name - the `mcp.servers` entry key.
     * @param status - the status now current for that server.
     * @mode emit
     */
    'mcp-manager/status'(name: string, status: McpManagedServerStatus): void
  }
}
