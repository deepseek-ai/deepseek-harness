/**
 * Per-server runtime status, list views, and the MCP manager's Cordis event.
 * Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-mcp-manager/types
 */

import type { McpCloseResult, McpConnectionStatus, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'

/**
 * Status of one managed server. Extends the mcp-client connection status with
 * manager-owned conditions: `disabled` when the configured entry requests no
 * live instance, `load` when plugin activation failed, and `cleanup` when an
 * instance or probe could not confirm closure or finish local cleanup.
 * Cleanup results retain any unconfirmed closure and the first diagnostic.
 */
export type McpManagedServerStatus =
  | McpConnectionStatus
  | { state: 'disabled' }
  | { state: 'failed'; reason: 'load'; lastError: string }
  | { state: 'failed'; reason: 'cleanup'; result: McpCloseResult }

/** One managed server as a management surface lists it. */
export interface McpManagedServerView {
  /** The latest explicit authorization attempt for an OAuth entry, until its owner is retired. */
  authorization?: McpOAuthAttemptView
  /** The configured `servers` key or registered name; also the instance's `serverName` tool namespace. */
  name: string
  /** Whether a configured or registered entry still exists; false for retained cleanup failures after removal. */
  configured: boolean
  /** Current runtime status. */
  status: McpManagedServerStatus
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A managed server's connection status or authorization view changed;
     * read `list()` for the current authorization view. Emitted while the
     * manager is live and either the entry is configured or registered, or a
     * runtime record remains. Removed entries may emit cleanup
     * failures; `watch` and `list()` report removals.
     * Lifecycle operations do not wait for listeners. Synchronous throws and
     * returned promise rejections are logged without skipping other listeners.
     * @param name - the configured `servers` key or registered name.
     * @param status - the status now current for that server.
     * @mode parallel
     */
    'mcp-manager/status'(name: string, status: McpManagedServerStatus): void | Promise<void>
  }
}
