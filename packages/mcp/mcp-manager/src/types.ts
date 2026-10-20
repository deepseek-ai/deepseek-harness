/**
 * Per-server runtime status and list views. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-mcp-manager/types
 */

import type { McpCloseResult, McpConnectionStatus } from '@deepseek-ai/dsh-mcp-client/types'

/**
 * Status of one managed server. Extends the mcp-client connection status with
 * manager-owned conditions: `load` when plugin activation failed, and
 * `cleanup` when an instance could not confirm closure or finish local cleanup.
 * Cleanup results retain any unconfirmed closure and the first diagnostic.
 */
export type McpManagedServerStatus =
  | McpConnectionStatus
  | { state: 'failed'; reason: 'load'; lastError: string }
  | { state: 'failed'; reason: 'cleanup'; result: McpCloseResult }

/** One managed server as a management surface lists it. */
export interface McpManagedServerView {
  /** The registered name; also the instance's `serverName` tool namespace. */
  name: string
  /** Current runtime status; a removed registration stays listed while its cleanup failure is retained. */
  status: McpManagedServerStatus
}
